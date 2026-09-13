import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NarrativeWorld } from "../src/world/runtime.js";
import { WorldFiles } from "../src/files.js";
import type { WorldClock } from "../src/clock.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const response = (input: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "resolution", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(input) } }] });
const good = (text: string, worldState?: string, outcome: { status: "completed" | "failed" | "needs_input"; reason?: string } = { status: "completed" }): ChatResult => response({ ...(worldState ? { worldState } : {}), perceptions: [{ actorId: "bot", text }], outcome });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(condition(), "condition did not become true");
}
async function bounded<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("operation did not settle promptly")), milliseconds); })]); }
  finally { clearTimeout(timer!); }
}
const inputOf = (messages: ChatMessage[]) => JSON.parse([...messages].reverse().find(message => message.role === "user")!.content as string);
let passed = 0;
function pass(label: string): void { passed++; console.log(`PASS ${label}`); }

async function main(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-runtime-"));
  const files = new WorldFiles(directory); await files.ensure();
  let now = 100, calls = 0;
  let infer: (messages: ChatMessage[], signal?: AbortSignal) => Promise<ChatResult> = async () => response({ botName: "小澈", worldState: "你所在的餐厅刚开始营业。后厨有 ADMIN_PRIVATE_SECRET。", actorStates: [{ actorId: "bot", state: "你有些饿，站在餐厅门口。" }], perceptions: [{ actorId: "bot", text: "店员向门口望来，示意你进去。" }] });
  const clock = { now: () => now, realMsUntil: () => 5 } as unknown as WorldClock;
  const runtime = new NarrativeWorld(files, clock, (messages, tools, signal) => {
    calls++; assert.equal(tools.length, 1); assert.equal(tools[0]!.function.name, "resolve_world");
    return infer(messages, signal);
  });
  const call = (id: string, description = "走到柜台前", expectedAt = now): ToolCallRecord => ({ id, name: "act", role: "agent", issuedAt: now, expectedAt, arguments: { description } });
  try {
    await runtime.ensure(); const store = await runtime.store();
    assert.equal(store.snapshot().initialized, true); assert.equal(calls, 1);
    const initial = await runtime.peek(); assert.match(initial.narrative, /店员/); assert.doesNotMatch(JSON.stringify(initial), /ADMIN_PRIVATE_SECRET/);
    await runtime.ensure(); assert.equal(calls, 1);
    infer = async () => response({ perceptions: [] });
    const beforeIdle = store.snapshot(), beforeEvents = store.readEvents(0, 10000);
    await runtime.evolve("平静地经过片刻。");
    assert.deepEqual(store.snapshot(), beforeIdle); assert.deepEqual(store.readEvents(0, 10000), beforeEvents);
    pass("initialization commits prose once and an idle heartbeat emits no invented event");

    // Two distinct tools may be pending; Bot scheduling chooses blocking, while World serializes adjudication.
    let firstRelease: ((value: ChatResult) => void) | undefined, activeModels = 0, maxModels = 0;
    const seen: any[] = [];
    infer = async messages => {
      const body = inputOf(messages); seen.push(body); activeModels++; maxModels = Math.max(maxModels, activeModels);
      try {
        if (seen.length === 1) return await new Promise<ChatResult>(resolve => { firstRelease = resolve; });
        assert.match(body.worldState, /ORDERED_FIRST/); assert.equal(messages.length, 2, "the next adjudication receives current prose without a persistent World chat history");
        return good("店员根据刚才的点单收下钱。", "ORDERED_SECOND：点单和付款都已完成。ADMIN_PRIVATE_SECRET 仍然存在。");
      } finally { activeModels--; }
    };
    const beforeParallel = calls, receiptOne: string[] = [], receiptTwo: string[] = [];
    const first = runtime.act("bot", call("parallel-one", "先点一碗面", 105), text => receiptOne.push(text));
    const second = runtime.act("bot", call("parallel-two", "再付钱", 105), text => receiptTwo.push(text));
    await eventually(() => Object.values(store.snapshot().actions).filter(action => action.status === "pending").length === 2);
    assert.equal(calls, beforeParallel, "neither future action infers or changes world prose before it is due");
    assert.equal(store.snapshot().worldState, beforeIdle.worldState);
    now = 105; await eventually(() => !!firstRelease);
    assert.equal(seen.length, 1); assert.equal(maxModels, 1);
    firstRelease!(good("店员记下一碗面的订单。", "ORDERED_FIRST：小澈已经点了一碗面，正在等付款。ADMIN_PRIVATE_SECRET 仍然存在。"));
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(calls, beforeParallel + 2); assert.equal(maxModels, 1); assert.match(store.snapshot().worldState, /ORDERED_SECOND/);
    assert.equal(JSON.parse(receiptOne[0]!).scene.actionId, "bot:parallel-one"); assert.equal(JSON.parse(receiptTwo[0]!).scene.actionId, "bot:parallel-two");
    pass("distinct pending calls honor due time and serialize model adjudication against the latest committed prose");

    let duplicateRelease: ((value: ChatResult) => void) | undefined;
    infer = () => new Promise(resolve => { duplicateRelease = resolve; });
    const duplicate = call("duplicate", "看看店员有没有找零"), duplicateReceipts: string[] = [], beforeDuplicate = calls;
    const duplicateA = runtime.act("bot", duplicate, text => duplicateReceipts.push(text));
    const duplicateB = runtime.act("bot", duplicate, text => duplicateReceipts.push(text));
    await eventually(() => !!duplicateRelease);
    const withdrawn = new AbortController(); let withdrawnDelivered = false;
    const duplicateWithdrawn = runtime.act("bot", duplicate, () => { withdrawnDelivered = true; }, withdrawn.signal);
    const withdrawnRejected = assert.rejects(duplicateWithdrawn);
    withdrawn.abort(new Error("withdraw this duplicate caller")); await bounded(withdrawnRejected);
    const alreadyWithdrawn = new AbortController(); alreadyWithdrawn.abort();
    await assert.rejects(runtime.act("bot", duplicate, () => { withdrawnDelivered = true; }, alreadyWithdrawn.signal));
    assert.equal(store.snapshot().actions["bot:duplicate"]!.status, "pending", "withdrawing another caller cannot cancel the original authorized shared execution");
    await assert.rejects(runtime.act("bot", { ...duplicate, arguments: { description: "偷偷换掉同一个调用" } }, () => {}), /不同操作/);
    duplicateRelease!(good("店员把零钱放在柜台上。"));
    assert.deepEqual(await Promise.all([duplicateA, duplicateB]), [true, true]);
    assert.equal(withdrawnDelivered, false);
    assert.equal(calls, beforeDuplicate + 1); assert.deepEqual(JSON.parse(duplicateReceipts[0]!), JSON.parse(duplicateReceipts[1]!));
    const beforeReplay = await fs.readFile(files.narrativeJournal, "utf8");
    assert.equal(await runtime.act("bot", duplicate, text => duplicateReceipts.push(text)), true);
    await assert.rejects(runtime.act("bot", { ...duplicate, expectedAt: duplicate.expectedAt + 1 }, () => {}), /另一项请求/);
    assert.equal(calls, beforeDuplicate + 1); assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), beforeReplay);
    pass("concurrent and completed duplicate calls infer once, preserve receipts and reject changed parameters or timing");

    const recordedCall = call("imported-terminal", "整理书桌"), unrelatedView = await runtime.peek(), callsBeforeRecorded = calls;
    await store.commit({ idempotencyKey: "imported-terminal-fixture", source: "migration", actions: { "bot:imported-terminal": {
      id: "bot:imported-terminal", actorId: "bot", intent: "整理书桌", status: "completed", startedAt: 80, expectedEnd: 90, finishedAt: 90,
      requestFingerprint: createHash("sha256").update(JSON.stringify({ actorId: "bot", arguments: recordedCall.arguments, expectedAt: recordedCall.expectedAt })).digest("hex"),
    } } });
    let recordedReceipt: any;
    assert.equal(await runtime.act("bot", recordedCall, text => { recordedReceipt = JSON.parse(text); }), true);
    assert.equal(recordedReceipt.observation.observationId, "action-record:bot:imported-terminal");
    assert.notEqual(recordedReceipt.observation.observationId, unrelatedView.observationId);
    assert.deepEqual(recordedReceipt.observation.sourceEventIds, []); assert.equal(recordedReceipt.observation.scene, undefined); assert.equal(recordedReceipt.scene, undefined);
    assert.match(recordedReceipt.observation.narrative, /整理书桌.*已经完成/); assert.match(recordedReceipt.observation.narrative, /没有保存当时的感知经过/);
    assert.match(recordedReceipt.observation.narrative, /没有重新执行/); assert.doesNotMatch(recordedReceipt.observation.narrative, /零钱/);
    await store.commit({ idempotencyKey: "another-perception", source: "evolve", perceptions: [{ actorId: "bot", text: "另一个事件：门口传来敲门声。" }] });
    const actualEvent = await runtime.peek();
    assert.equal(await runtime.act("bot", recordedCall, text => { recordedReceipt = JSON.parse(text); }), true);
    assert.equal(recordedReceipt.observation.observationId, "action-record:bot:imported-terminal", "record-only receipt identity stays stable when newer events arrive");
    assert.doesNotMatch(recordedReceipt.observation.narrative, /敲门/); assert.deepEqual(await runtime.peek(), actualEvent, "reading an old action cannot consume or replace the actual current perception");
    assert.equal(calls, callsBeforeRecorded);
    pass("imported terminal receipts honestly report missing history without borrowing another action's scene, event identity or evidence");

    const delayedAbort = new AbortController(), delayRequest = call("delay-cancel", "稍后出门", 150), beforeDelay = calls;
    let delayedDelivery = false;
    const delayed = runtime.act("bot", delayRequest, () => { delayedDelivery = true; }, delayedAbort.signal);
    const delayedRejected = assert.rejects(delayed);
    await eventually(() => store.snapshot().actions["bot:delay-cancel"]?.status === "pending");
    delayedAbort.abort(new Error("user cancelled delayed action")); await bounded(delayedRejected);
    await eventually(() => store.snapshot().actions["bot:delay-cancel"]?.status === "cancelled");
    assert.equal(calls, beforeDelay); assert.equal(delayedDelivery, false); assert.equal(store.snapshot().actions["bot:delay-cancel"]!.status, "cancelled");
    const afterDelay = store.snapshot();
    now = 150; await tick(); await tick(); assert.deepEqual(store.snapshot(), afterDelay);
    pass("cancellation during the duration wait records cancellation without inference or late delivery");

    let lateRelease: ((value: ChatResult) => void) | undefined, inferenceSignal: AbortSignal | undefined;
    infer = (_messages, signal) => { inferenceSignal = signal; return new Promise(resolve => { lateRelease = resolve; }); };
    const duringInference = new AbortController(), beforeInferenceCancel = store.snapshot().worldState;
    let inferenceDelivery = false;
    const generating = runtime.act("bot", call("inference-cancel", "推开大门"), () => { inferenceDelivery = true; }, duringInference.signal);
    const generatingRejected = assert.rejects(generating);
    await eventually(() => !!lateRelease); assert.ok(inferenceSignal && !inferenceSignal.aborted);
    duringInference.abort(new Error("cancel model operation")); await bounded(generatingRejected);
    await eventually(() => store.snapshot().actions["bot:inference-cancel"]?.status === "cancelled");
    assert.equal(inferenceSignal!.aborted, true); assert.equal(store.snapshot().actions["bot:inference-cancel"]!.status, "cancelled");
    lateRelease!(good("不该出现的迟到结果。", "LATE_UNCOMMITTED_WORLD")); await tick(); await tick();
    assert.equal(store.snapshot().worldState, beforeInferenceCancel); assert.equal(inferenceDelivery, false);
    pass("cancellation reaches the active inference signal and discards a late result without waiting for the model");

    const beforeDenied = store.snapshot().worldState, beforeDeniedCalls = calls;
    infer = async () => good("这个动作不应生效。", "DENIED_WORLD");
    const deniedCall = call("denied", "走出餐厅"); let deniedDelivered = false, gateCalls = 0;
    await assert.rejects(runtime.act("bot", deniedCall, () => { deniedDelivered = true; }, undefined, () => { gateCalls++; return false; }), /取消/);
    assert.ok(gateCalls); assert.equal(calls, beforeDeniedCalls + 1); assert.equal(store.snapshot().worldState, beforeDenied);
    assert.notEqual(store.snapshot().actions["bot:denied"]!.status, "completed"); assert.equal(deniedDelivered, false);
    assert.ok(!store.readPerceptions("bot", 0, "bot:denied").some(perception => perception.text.includes("不应生效")));
    pass("revoked beforeCommit authorization prevents world prose and proposed perception from being committed");

    infer = async () => good("门锁着，你没能推开它。", undefined, { status: "failed", reason: "ADMIN_PRIVATE_REASON: secret plot instructions" });
    const failedReceipts: string[] = [];
    assert.equal(await runtime.act("bot", call("blocked", "推开锁着的门"), text => failedReceipts.push(text)), false);
    assert.equal(JSON.parse(failedReceipts[0]!).action.status, "failed"); assert.match(failedReceipts[0]!, /门锁着/);
    assert.match(store.snapshot().actions["bot:blocked"]!.reason!, /ADMIN_PRIVATE_REASON/);
    assert.doesNotMatch(failedReceipts[0]!, /ADMIN_PRIVATE_REASON|ADMIN_PRIVATE_SECRET/);
    pass("failed outcome returns the perceptible obstruction while private adjudicator diagnostics remain administrative");

    const realCommit = store.commit.bind(store), diskRequest = call("disk-failed", "拿起柜台上的零钱");
    const beforeDisk = store.snapshot().worldState, beforeDiskCalls = calls;
    infer = async () => good("这份未持久化的结果不应交付。", "UNCOMMITTED_DISK_STATE");
    store.commit = (input, options) => input.idempotencyKey === "bot:disk-failed:commit" ? Promise.reject(new Error("DISK_PRIVATE_FAILURE")) : realCommit(input, options);
    try { await assert.rejects(runtime.act("bot", diskRequest, () => { throw Error("failed storage cannot deliver a success receipt"); }), /DISK_PRIVATE_FAILURE/); }
    finally { store.commit = realCommit; }
    assert.equal(calls, beforeDiskCalls + 1, "storage errors cannot become model repair turns");
    assert.equal(store.snapshot().worldState, beforeDisk); assert.equal(store.snapshot().actions["bot:disk-failed"]!.status, "failed");
    let diskReplay = ""; assert.equal(await runtime.act("bot", diskRequest, text => { diskReplay = text; }), false);
    assert.doesNotMatch(diskReplay, /DISK_PRIVATE_FAILURE|UNCOMMITTED_DISK_STATE|未持久化/);
    assert.match(diskReplay, /没有确认完成/); assert.equal(calls, beforeDiskCalls + 1);
    pass("persistence failure triggers no model repair, leaves world prose intact and replays only a safe failure perception");

    const emptyRequest = call("empty-perception", "等店员作答"), beforeEmpty = store.snapshot().worldState, beforeEmptyCalls = calls;
    infer = async () => response({ worldState: "EMPTY_RESULT_MUST_NOT_COMMIT", perceptions: [], outcome: { status: "completed" } });
    await assert.rejects(runtime.act("bot", emptyRequest, () => { throw Error("empty action cannot deliver success"); }), /可读实际感知/);
    assert.equal(calls, beforeEmptyCalls + 3, "invalid model output has a bounded repair budget");
    assert.equal(store.snapshot().worldState, beforeEmpty); assert.equal(store.snapshot().actions["bot:empty-perception"]!.status, "failed");
    assert.equal(await runtime.act("bot", emptyRequest, () => {}), false); assert.equal(calls, beforeEmptyCalls + 3);
    pass("an action with empty perception cannot be treated as a successful status-only update");

    const persona = "角色卡唯一原文：访客是谨慎的天文学家，正在寻找失踪的导师。";
    infer = async messages => {
      const body = inputOf(messages); assert.equal(body.kind, "arrive");
      return response({ perceptions: [{ actorId: "visitor", text: "你来到餐厅门口。" }] });
    };
    await runtime.arrive("visitor", "访客", persona);
    assert.equal(store.snapshot().actors.visitor!.persona, persona, "a model can omit personality from current state without losing the authored character card");
    infer = async messages => {
      const visitor = inputOf(messages).actors.find((actor: any) => actor.id === "visitor");
      assert.equal(visitor.persona, persona, "the next stateless inference receives the retained card");
      return response({ perceptions: [] });
    };
    await runtime.evolve("访客在场时安静经过片刻。");
    await store.reload(); assert.equal(store.snapshot().actors.visitor!.persona, persona);
    pass("visitor character background remains durable and reaches later adjudications even when the model omits it from state prose");

    let stoppedRelease: ((value: ChatResult) => void) | undefined;
    infer = () => new Promise(resolve => { stoppedRelease = resolve; });
    let stoppedDelivery = false;
    const stopped = runtime.act("bot", call("shutdown", "准备离开"), () => { stoppedDelivery = true; });
    const stoppedRejected = assert.rejects(stopped);
    await eventually(() => !!stoppedRelease); await bounded(runtime.shutdown()); await stoppedRejected;
    const afterStop = store.snapshot(); stoppedRelease!(good("迟到结果", "STOPPED_LATE_WORLD")); await tick(); await tick();
    assert.deepEqual(store.snapshot(), afterStop); assert.equal(stoppedDelivery, false);
    assert.equal(store.snapshot().actions["bot:shutdown"]!.status, "cancelled");
    pass("shutdown settles despite a stalled model and rejects results from the stopped lifetime");
    console.log(`\n${passed} isolated narrative runtime checks passed; no live model or running world used`);
  } finally { await runtime.shutdown(); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
