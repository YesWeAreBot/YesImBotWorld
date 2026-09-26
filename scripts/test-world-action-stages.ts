import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import type { ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const response = (input: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "result", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(input) } }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function eventually(condition: () => boolean) {
  for (let index = 0; index < 200 && !condition(); index++) await new Promise(resolve => setTimeout(resolve, 3));
  assert.ok(condition(), "staged action did not progress promptly");
}
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-action-stages-")), files = new WorldFiles(base); await files.ensure();
  let now = 100;
  const requests: any[] = [];
  let handler: (request: any) => Promise<ChatResult> = async () => response({ perceptions: [] });
  const clock: any = { now: () => now, realMsUntil: () => 2 };
  const runtime = new NarrativeWorld(files, clock, async messages => {
    const request = JSON.parse([...messages].reverse().find(message => message.role === "user")!.content as string);
    requests.push(request); return handler(request);
  });
  const store = await runtime.store();
  await store.commit({ idempotencyKey: "fixture", source: "fixture", initialized: true, worldState: "窗边有水壶和一张书桌。", actors: {
    bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在桌边。", perception: "看见水壶。" },
    "visitor:a": { id: "visitor:a", name: "访客", controller: "player", present: true, state: "坐在桌边。", perception: "看见桌面。" },
  } });
  const call = (id: string, intent = "缓缓给花盆浇水", duration = 300): ToolCallRecord => ({ id, name: "act", role: "agent", issuedAt: now, expectedAt: now + duration, duration, arguments: { description: intent } });
  return { base, files, clock, runtime, store, requests, call, setNow: (time: number) => { now = time; }, handler: (next: typeof handler) => { handler = next; },
    close: async () => { await runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function immediateFeedbackAndConcurrentStages() {
  const f = await fixture(), opening = deferred<ChatResult>();
  const receipts: any[] = [], duplicateReceipts: any[] = [], visitorReceipts: any[] = [], gates: string[] = [];
  f.handler(async request => {
    if (request.kind === "evolve") return response({ worldState: request.worldState + "窗外吹来一阵风。", externalChanges: [{ id: "wind", description: "窗外吹来一阵风。" }], perceptions: [] });
    if (request.actorId === "bot" && request.actionPhase === "start") return opening.promise;
    if (request.actionPhase === "start") return response({ worldState: request.worldState + "访客开始擦拭书桌，尚未擦完。", perceptions: [{ actorId: request.actorId, text: "你拿起布，开始擦拭桌角。" }], outcome: { status: "ongoing" } });
    assert.equal(request.actionPhase, "finish"); assert.ok(request.time >= request.action.expectedEnd);
    assert.match(request.worldState, /访客开始擦拭/);
    return response({ worldState: request.worldState + (request.actorId === "bot" ? "花盆已经浇好。" : "桌面已擦干净。"),
      perceptions: [{ actorId: request.actorId, text: request.actorId === "bot" ? "水已经渗进土里，你放下水壶。" : "你擦完桌面，放下抹布。" }], outcome: { status: "completed" } });
  });
  try {
    const call = f.call("water"), work = f.runtime.act("bot", call, async text => { receipts.push(JSON.parse(text)); }, undefined, phase => { gates.push(phase); return true; });
    await eventually(() => f.requests.length === 1);
    assert.equal(f.requests[0].actionPhase, "start"); assert.equal(f.requests[0].time, 100);
    assert.equal(f.store.snapshot().actions["bot:water"]!.phase, "accepted"); assert.equal(f.store.readPerceptions("bot", 0, "bot:water").length, 0);
    await f.runtime.evolve("定期心跳", { heartbeat: true }); assert.equal(f.requests.length, 1);
    opening.resolve(response({ worldState: "小澈开始缓缓浇水，花盆尚未浇好。", perceptions: [{ actorId: "bot", text: "你提起水壶，细细的水流刚落进花盆。" }], outcome: { status: "ongoing" } }));
    await eventually(() => receipts.length === 1);
    assert.equal(receipts[0].action.status, "pending"); assert.equal(receipts[0].action.phase, "ongoing"); assert.equal(receipts[0].action.finishedAt, undefined);
    assert.equal(receipts[0].scene.phase, "start"); assert.equal(receipts[0].scene.worldTime, 100); assert.match(f.store.snapshot().worldState, /尚未浇好/);
    const duplicate = f.runtime.act("bot", call, text => { duplicateReceipts.push(JSON.parse(text)); });
    await eventually(() => duplicateReceipts.length === 1);
    assert.deepEqual(duplicateReceipts[0], receipts[0]); assert.equal(f.requests.length, 1, "a duplicate joins the same committed beginning");
    const visitor = f.runtime.act("visitor:a", f.call("wipe", "慢慢擦拭书桌", 350), text => { visitorReceipts.push(JSON.parse(text)); });
    await eventually(() => visitorReceipts.length === 1);
    assert.equal(visitorReceipts[0].scene.actorId, "visitor:a");
    f.setNow(391); await f.runtime.evolve("到期前九秒的心跳", { heartbeat: true });
    assert.equal(f.requests.length, 2, "a heartbeat nine seconds before completion cannot grab a model turn");
    await f.runtime.evolve("管理员允许的环境变化"); assert.equal(f.requests.length, 3, "explicit world mutations are still ordered, not discarded as periodic work");
    f.setNow(400); assert.equal(await work, true); assert.equal(await duplicate, true);
    assert.equal(receipts.length, 2); assert.equal(receipts[1].scene.phase, "finish"); assert.equal(receipts[1].action.status, "completed");
    assert.notEqual(receipts[0].scene.eventId, receipts[1].scene.eventId); assert.deepEqual(duplicateReceipts, receipts);
    assert.ok(gates.includes("start") && gates.includes("finish"));
    assert.equal(f.store.snapshot().actions["visitor:a:wipe"]!.status, "pending");
    assert.match(f.requests.filter(request => request.actorId === "bot").at(-1).worldState, /窗外吹来/);
    f.setNow(450); assert.equal(await visitor, true);
    const beforeHeartbeat = f.requests.length; await f.runtime.evolve("动作后心跳", { heartbeat: true }); assert.equal(f.requests.length, beforeHeartbeat + 1);
    const saved = f.store.readPerceptions("bot", 0, "bot:water"); await f.store.reload(); assert.deepEqual(f.store.readPerceptions("bot", 0, "bot:water"), saved);
    assert.deepEqual(saved.map(perception => perception.phase), ["start", "finish"]);
    const replay: any[] = [], beforeReplay = f.requests.length;
    assert.equal(await f.runtime.act("bot", call, text => { replay.push(JSON.parse(text)); }), true);
    assert.equal(f.requests.length, beforeReplay); assert.deepEqual(replay, [receipts[1]], "a completed retry replays only its final durable receipt");
    console.log("PASS immediate committed beginning, pending/due boundary, heartbeat deferral, independent actors, ordered state, duplicate stages and durable replay");
  } finally { opening.resolve(response({ perceptions: [] })); await f.close(); }
}

async function shortActionsAndHonestBoundaries() {
  const f = await fixture();
  try {
    for (const status of ["completed", "needs_input", "failed"] as const) {
      f.handler(async request => { assert.equal(request.actionPhase, "start"); return response({ perceptions: [{ actorId: "bot", text: status === "failed" ? "门锁着，推不开。" : status === "needs_input" ? "两条小路就在眼前，还未选择方向。" : "你已把水壶放下。" }], outcome: { status } }); });
      const before = f.requests.length, receipts: any[] = [], phases: string[] = [];
      assert.equal(await f.runtime.act("bot", f.call(status), text => { receipts.push(JSON.parse(text)); }, undefined, phase => { phases.push(phase); return true; }), status !== "failed");
      assert.equal(f.requests.length, before + 1); assert.equal(receipts.length, 1); assert.equal(receipts[0].action.finishedAt, 100); assert.equal(receipts[0].scene.phase, "finish");
      assert.ok(phases.every(phase => phase === "finish"), "a terminal first response seals only the actual final commit");
    }
    let attempts = 0;
    f.handler(async () => { attempts++; return response({ perceptions: [{ actorId: "bot", text: "不能无限继续。" }], outcome: { status: "ongoing" } }); });
    await assert.rejects(f.runtime.act("bot", f.call("not-future", "放下杯子", 0), () => {}), /不能返回ongoing/);
    assert.equal(attempts, 3); assert.equal(f.store.snapshot().actions["bot:not-future"]!.status, "failed");
    console.log("PASS short success, decision boundary and obstruction take one immediate inference; past-due ongoing is rejected");
  } finally { await f.close(); }
}

async function cancellationAndAuthorization() {
  const f = await fixture();
  const receipts: any[] = [];
  f.handler(async () => response({ worldState: "水已开始缓缓流进花盆，尚未浇好。", perceptions: [{ actorId: "bot", text: "你开始往花盆里缓缓倒水。" }], outcome: { status: "ongoing" } }));
  try {
    const call = f.call("cancel-after-start"), work = f.runtime.act("bot", call, text => { receipts.push(JSON.parse(text)); }), rejection = assert.rejects(work);
    await eventually(() => receipts.length === 1); const beginning = f.store.readPerceptions("bot", 0, "bot:cancel-after-start")[0]!;
    f.runtime.cancel("bot"); await rejection;
    assert.equal(f.store.snapshot().actions["bot:cancel-after-start"]!.status, "cancelled"); assert.match(f.store.snapshot().worldState, /已开始/);
    const saved = f.store.readPerceptions("bot", 0, "bot:cancel-after-start"); assert.deepEqual(saved[0], beginning); assert.equal(saved[1]!.phase, "finish"); assert.match(saved[1]!.text, /此前已确认发生/);
    f.setNow(500); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.requests.length, 1); assert.equal(receipts.length, 1);
    const before = f.store.snapshot().worldState;
    await assert.rejects(f.runtime.act("bot", f.call("revoked-start"), () => { throw Error("unauthorized beginning delivered"); }, undefined, phase => phase !== "start"), /取消/);
    assert.equal(f.store.snapshot().worldState, before); assert.ok(!f.store.readPerceptions("bot", 0, "bot:revoked-start").some(perception => perception.phase === "start"));
    let stage = 0;
    f.handler(async () => response({ worldState: stage++ ? "UNAUTHORIZED_FINISH" : "新的浇水过程刚开始。", perceptions: [{ actorId: "bot", text: stage === 1 ? "你又开始缓缓浇水。" : "未获授权的完成。" }], outcome: { status: stage === 1 ? "ongoing" : "completed" } }));
    const nextReceipts: any[] = [], denied = f.runtime.act("bot", f.call("revoked-finish"), text => { nextReceipts.push(JSON.parse(text)); }, undefined, phase => phase === "start"), deniedResult = assert.rejects(denied);
    await eventually(() => nextReceipts.length === 1); f.setNow(800); await deniedResult;
    assert.match(f.store.snapshot().worldState, /刚开始/); assert.doesNotMatch(f.store.snapshot().worldState, /UNAUTHORIZED_FINISH/);
    assert.equal(nextReceipts.length, 1); assert.equal(f.store.snapshot().actions["bot:revoked-finish"]!.status, "failed");
    console.log("PASS cancellation preserves committed beginnings; independent start/finish authorization prevents revoked future facts");
  } finally { await f.close(); }
}

async function interruptedOngoingRecovery() {
  const f = await fixture();
  try {
    await f.store.commit({ idempotencyKey: "crashed-beginning", source: "action", actionId: "bot:crashed", actionPhase: "start", worldState: "炉火已点燃，水还没有烧开。",
      actions: { "bot:crashed": { id: "bot:crashed", actorId: "bot", intent: "把水烧开", status: "pending", phase: "ongoing", startedAt: 100, expectedEnd: 400, requestFingerprint: "crashed" } },
      perceptions: [{ actorId: "bot", text: "炉火已经点燃，壶里的水还很安静。" }] });
    const before = f.store.readPerceptions("bot", 0, "bot:crashed")[0]!;
    await f.runtime.shutdown();
    const restarted = new NarrativeWorld(f.files, f.clock, async () => { throw Error("recovery must not invent a model outcome"); });
    try {
      const recovered = await restarted.store();
      assert.equal(recovered.snapshot().actions["bot:crashed"]!.status, "failed"); assert.equal(recovered.snapshot().actions["bot:crashed"]!.phase, "finished");
      assert.match(recovered.snapshot().worldState, /还没有烧开/); assert.deepEqual(recovered.readPerceptions("bot", 0, "bot:crashed")[0], before);
      assert.match(recovered.readPerceptions("bot", 0, "bot:crashed")[1]!.text, /没有确认完成/);
      await recovered.reload(); assert.equal(recovered.readPerceptions("bot", 0, "bot:crashed").length, 2);
      console.log("PASS interrupted ongoing recovery retains the real beginning and records an honest failure without completing the future");
    } finally { await restarted.shutdown(); }
  } finally { await f.close(); }
}

async function main() { await immediateFeedbackAndConcurrentStages(); await shortActionsAndHonestBoundaries(); await cancellationAndAuthorization(); await interruptedOngoingRecovery(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
