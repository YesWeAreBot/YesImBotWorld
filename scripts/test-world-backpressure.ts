import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

type Request = { kind: string; actionPhase?: "start" | "finish"; actorId?: string; task: string; worldState: string; pendingActions: { id: string; status: string }[] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const response = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("world backpressure operation did not settle")), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-backpressure-")), files = new WorldFiles(dir); await files.ensure();
  let now = 0;
  let handler: (request: Request, signal?: AbortSignal) => Promise<ChatResult> = async request => response({ perceptions: [{ actorId: request.actorId, text: "桌边仍很安静。" }] });
  const calls: Request[] = [];
  const runtime = new NarrativeWorld(files, { now: () => now, realMsUntil: () => 1 } as any, (messages: ChatMessage[], _tools, signal) => {
    const request = JSON.parse([...messages].reverse().find(message => message.role === "user")!.content as string) as Request;
    calls.push(request); return handler(request, signal);
  });
  const store = await runtime.store();
  await store.commit({ idempotencyKey: "fixture", source: "fixture", initialized: true, worldState: "桌边有一盆绿植和一只水壶。", actors: Object.fromEntries(["bot", "visitor:a", "visitor:b"].map(id => [id, { id, name: id === "bot" ? "小澈" : id, controller: id === "bot" ? "bot" as const : "player" as const, present: true, state: "站在桌边。", perception: "看见桌上的绿植。" }])) });
  const call = (id: string): ToolCallRecord => ({ id, role: "agent", name: "act", issuedAt: 0, expectedAt: 10, arguments: { description: "给绿植浇水" } });
  return { runtime, store, calls, call, setNow: (value: number) => { now = value; }, setHandler: (fn: typeof handler) => { handler = fn; }, close: async () => { await runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); } };
}

async function coalescesAndBoundsObservations() {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  f.setHandler(async request => { entered.resolve(); await release.promise; return response({ perceptions: [{ actorId: request.actorId, text: "叶片上有一层薄薄的灰。" }] }); });
  try {
    const first = f.runtime.observe("bot", { intent: " 看看叶片 ", target: "绿植" });
    await bounded(entered.promise);
    const duplicate = f.runtime.observe("bot", { intent: "看看叶片", target: "绿植", modality: "all" });
    const duplicates = Array.from({ length: 20 }, () => f.runtime.observe("bot", { intent: "看看叶片", target: "绿植" }));
    await assert.rejects(f.runtime.observe("bot", { intent: "看看窗外" }), /上一次观察尚未返回/);
    const otherActor = f.runtime.observe("visitor:a", { intent: "看看水壶" });
    assert.equal(f.calls.length, 1, "repeated and conflicting requests cannot flood the World queue");
    release.resolve();
    const [observation, ...copies] = await bounded(Promise.all([first, duplicate, ...duplicates]));
    for (const copy of copies) assert.equal(copy.observationId, observation.observationId, "a duplicate gets the same committed perception, not new evidence");
    await bounded(otherActor); assert.equal(f.calls.length, 2, "one actor's observation does not exclude another actor");
    await f.runtime.observe("bot", { intent: "看看窗外" }); assert.equal(f.calls.length, 3, "a settled observation releases admission");
    console.log("PASS observations coalesce per actor, reject conflicting pending requests, and release admission after completion");
  } finally { release.resolve(); await f.close(); }
}

async function actionResultsPassQueuedReadsButRespectWrites(withBarrier: boolean) {
  const f = await fixture(), due = deferred<void>(), waiting = deferred<void>(), entered = deferred<void>(), release = deferred<void>();
  // Deterministically separate the action's recorded start from its due result without a real timer.
  (f.runtime as any).until = async () => { waiting.resolve(); await due.promise; };
  const order: string[] = [];
  f.setHandler(async request => {
    order.push(`${request.kind}:${request.actorId ?? "world"}`);
    if (request.kind === "action" && request.actionPhase === "start") return response({ perceptions: [{ actorId: "bot", text: "你提起水壶，开始给花盆缓缓浇水。" }], outcome: { status: "ongoing" } });
    if (request.kind === "observe" && request.actorId === "bot") {
      assert.match(request.task, /不能替它们.*宣布完成/);
      assert.ok(request.pendingActions.some(action => action.id === "bot:watering"));
      entered.resolve(); await release.promise;
    }
    if (request.kind === "action") return response({ worldState: "绿植已经浇过水，水壶放回桌边。", perceptions: [{ actorId: "bot", text: "你把水倒进花盆，再放下水壶。" }], outcome: { status: "completed" } });
    if (request.kind === "evolve") return response({ worldState: "桌边有一盆绿植和一只水壶，窗外开始下雨。", externalChanges: [{ id: "rain", description: "窗外开始下雨。" }], perceptions: [] });
    if (request.actorId === "visitor:b" || (!withBarrier && request.actorId === "visitor:a")) assert.match(request.worldState, /已经浇过水/, "queued reads must see the completed action rather than its stale pending scene");
    return response({ perceptions: [{ actorId: request.actorId, text: "你看见桌上的绿植。" }] });
  });
  try {
    let delivered = false;
    const action = f.runtime.act("bot", f.call("watering"), () => { delivered = true; });
    await bounded(waiting.promise); assert.equal(f.store.snapshot().actions["bot:watering"]!.status, "pending");
    order.length = 0;
    const ongoing = f.runtime.observe("bot", { intent: "看看周围" }); await bounded(entered.promise);
    const firstRead = f.runtime.observe("visitor:a", { intent: "看看绿植" }); await tick();
    const barrier = withBarrier ? f.runtime.evolve("窗外下起雨来。") : Promise.resolve(); await tick();
    const lastRead = f.runtime.observe("visitor:b", { intent: "看看桌边" }); await tick();
    f.setNow(10); due.resolve(); await tick();
    assert.deepEqual(order, ["observe:bot"], "priority never interrupts an executing inference");
    release.resolve(); await bounded(Promise.all([action, ongoing, firstRead, barrier, lastRead]));
    assert.equal(delivered, true); assert.equal(f.store.snapshot().actions["bot:watering"]!.status, "completed");
    assert.deepEqual(order, withBarrier ? ["observe:bot", "observe:visitor:a", "evolve:world", "action:bot", "observe:visitor:b"] : ["observe:bot", "action:bot", "observe:visitor:a", "observe:visitor:b"]);
    console.log(withBarrier ? "PASS action priority retains ordered writes and their preceding reads as causal barriers" : "PASS a due action completes ahead of queued observations without preempting the running inference");
  } finally { due.resolve(); release.resolve(); await f.close(); }
}

async function cancellationClearsObservationAndQueue() {
  const f = await fixture(), entered = deferred<AbortSignal>(), late = deferred<ChatResult>();
  f.setHandler(async (_request, signal) => { entered.resolve(signal!); return late.promise; });
  try {
    const old = f.runtime.observe("bot", { intent: "看看叶子" }), rejected = assert.rejects(old);
    const signal = await bounded(entered.promise);
    const duplicate = f.runtime.observe("bot", { intent: "看看叶子" }), duplicateRejected = assert.rejects(duplicate);
    const queued = f.runtime.observe("visitor:a", { intent: "看看桌子" }), queuedRejected = assert.rejects(queued);
    await tick(); await bounded(f.runtime.shutdown()); await Promise.all([rejected, duplicateRejected, queuedRejected]);
    assert.equal(signal.aborted, true); assert.equal(f.calls.length, 1, "cancelled queued reads cannot start another inference");
    const stopped = f.store.snapshot();
    late.resolve(response({ worldState: "不应生效的迟到世界", perceptions: [{ actorId: "bot", text: "不应生效的迟到观察" }] })); await tick(); await tick();
    assert.deepEqual(f.store.snapshot(), stopped, "late inference cannot write after shutdown");
    f.runtime.resume();
    f.setHandler(async request => response({ perceptions: [{ actorId: request.actorId, text: "你重新看向桌边。" }] }));
    const fresh = await bounded(f.runtime.observe("bot", { intent: "看看叶子" })); assert.match(fresh.narrative, /重新/);

    const cancelEntered = deferred<AbortSignal>(), cancelLate = deferred<ChatResult>();
    f.setHandler(async (_request, signal) => { cancelEntered.resolve(signal!); return cancelLate.promise; });
    const cancelled = f.runtime.observe("bot", { intent: "看看花盆" }), cancelRejected = assert.rejects(cancelled);
    const actorSignal = await bounded(cancelEntered.promise); f.runtime.cancel("bot"); await bounded(cancelRejected); assert.equal(actorSignal.aborted, true);
    const beforeLate = f.store.snapshot(); cancelLate.resolve(response({ perceptions: [{ actorId: "bot", text: "被取消的观察" }] })); await tick();
    assert.deepEqual(f.store.snapshot(), beforeLate);
    f.setHandler(async request => response({ perceptions: [{ actorId: request.actorId, text: "窗边有微风。" }] }));
    assert.match((await f.runtime.observe("bot", { intent: "看看花盆" })).narrative, /微风/);
    console.log("PASS shutdown/actor cancellation drain deduplicated and queued reads, suppress stale output, and allow later observations");
  } finally { late.resolve(response({ perceptions: [] })); await f.close(); }
}

async function failedObservationReleasesAdmission() {
  const f = await fixture();
  try {
    f.setHandler(async () => response({ perceptions: [] }));
    const before = f.store.snapshot();
    await assert.rejects(f.runtime.observe("bot", { intent: "看看房间" }), /可读实际感知/);
    assert.equal(f.calls.length, 3, "an invalid result only uses the bounded repair budget");
    assert.deepEqual(f.store.snapshot(), before);
    f.setHandler(async request => response({ perceptions: [{ actorId: request.actorId, text: "你看见窗边的一张桌子。" }] }));
    assert.match((await f.runtime.observe("bot", { intent: "看看房间" })).narrative, /窗边/);
    console.log("PASS failed observation validation releases admission without saving fabricated success");
  } finally { await f.close(); }
}

async function cancellingQueuedReadDoesNotWaitForAnotherActor() {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  f.setHandler(async request => { entered.resolve(); await release.promise; return response({ perceptions: [{ actorId: request.actorId, text: "桌边很安静。" }] }); });
  try {
    const other = f.runtime.observe("visitor:a", { intent: "看看窗外" }); await bounded(entered.promise);
    const old = f.runtime.observe("bot", { intent: "看看花盆" }), rejected = assert.rejects(old);
    await tick(); f.runtime.cancel("bot"); await bounded(rejected);
    assert.equal(f.calls.length, 1, "cancelling a queued actor does not start or interrupt the other actor's inference");
    const fresh = f.runtime.observe("bot", { intent: "看看花盆" }); await tick(); release.resolve();
    await bounded(Promise.all([other, fresh])); assert.equal(f.calls.length, 2, "the cancelled queue entry must not reach the model");
    console.log("PASS queued observation cancellation settles promptly behind another actor's slow inference");
  } finally { release.resolve(); await f.close(); }
}

async function main() {
  await coalescesAndBoundsObservations();
  await actionResultsPassQueuedReadsButRespectWrites(false);
  await actionResultsPassQueuedReadsButRespectWrites(true);
  await cancellationClearsObservationAndQueue();
  await failedObservationReleasesAdmission();
  await cancellingQueuedReadDoesNotWaitForAnotherActor();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
