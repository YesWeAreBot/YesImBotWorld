/** A committed old-world action remains true, but cannot become the destination's scene. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { Prompts } from "../src/prompts.js";
import { WorldAgent, type RemoteWorldLink, type WorldActDeliveryRoute } from "../src/world/agent.js";
import type { ToolCallRecord } from "../src/types.js";
import type { ChatResult } from "../src/llm/chat.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("world route operation did not settle")), 2000); })]); }
  finally { clearTimeout(timer); }
}
const call: ToolCallRecord = { id: "old-action", role: "agent", name: "act", issuedAt: 10, expectedAt: 10, arguments: { description: "把杯子放到桌上" } };
const response = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "world", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const remote = (worldName: string): RemoteWorldLink => ({ worldName, adjudicateAct: async () => true, resolveWait: async () => true, resolveCheckTime: async () => true, query: async () => "" });
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-action-routing-")), files = new WorldFiles(base); await files.ensure();
  const logger = { info() {}, warn() {}, error() {} } as any;
  let now = 10;
  const world = new WorldAgent({ baseURL: "http://world-routing.invalid", model: "none" } as any, files, { now: () => now, realMsUntil: () => 0 } as any, logger, new Prompts());
  const store = await world.runtime.store();
  await store.commit({ idempotencyKey: "seed", source: "fixture", initialized: true, worldState: "本地院子里有一张桌子。", actors: {
    bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在院子里。", perception: "本地院子很安静。" },
  }, perceptions: [{ actorId: "bot", text: "本地院子很安静。" }] });
  await world.resolveWait(call, () => {});
  return { world, store, setNow: (value: number) => { now = value; }, close: async () => { await world.shutdown(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function localReceiptAfterDeparture(roundTrip: boolean) {
  const f = await fixture(), committed = deferred<void>(), release = deferred<void>();
  let original = "";
  f.world.runtime.act = async (actorId, request, deliver) => {
    await f.store.commit({ idempotencyKey: "ambient", source: "fixture", perceptions: [{ actorId, text: "旧世界门外传来脚步声。" }] });
    await f.store.commit({ idempotencyKey: "action", source: "fixture", actionId: `${actorId}:${request.id}`, perceptions: [{ actorId, text: "杯子已放到旧世界的桌上。", opportunities: [{ label: "拿起杯子", intent: "拿起桌上的杯子" }] }] });
    original = JSON.stringify({ observation: await f.world.runtime.peek(actorId), action: { id: `${actorId}:${request.id}`, intent: "把杯子放到桌上", status: "completed" } });
    committed.resolve(); await release.promise; await deliver(original); return true;
  };
  try {
    const receipts: { content: string; route?: WorldActDeliveryRoute }[] = [];
    const work = f.world.adjudicateAct(call, (content, route) => { receipts.push({ content, route }); });
    await bounded(committed.promise); f.world.setRemote(remote("远方城镇"));
    if (roundTrip) f.world.setRemote(null);
    release.resolve(); assert.equal(await bounded(work), true);
    assert.equal(receipts.length, 1, "a stale action does not flush unread old-world ambient scenes into the new context");
    assert.equal(receipts[0]!.content, original, "the actual committed result and source IDs are retained byte-for-byte");
    assert.equal(receipts[0]!.route?.current, false); assert.equal(receipts[0]!.route?.worldName, null);
    assert.ok(receipts[0]!.route?.epoch);
    f.world.setRemote(null);
    const later: string[] = []; await f.world.resolveWait(call, text => { later.push(text); });
    assert.ok(later.some(text => text.includes("脚步声")), "unrelated unseen local perceptions were not silently acknowledged");
    assert.ok(!later.some(text => text.includes("杯子已放到")), "the historical action receipt cannot replay later as a fresh current scene");
    console.log(roundTrip ? "PASS leaving and returning before delivery still marks the old-route receipt historical" : "PASS local-to-remote late committed action keeps exact receipt without destination scene or ambient replay");
  } finally { release.resolve(); await f.close(); }
}

async function transitionDuringJournalRead() {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  const read = f.world.runtime.perceptionsSince.bind(f.world.runtime);
  let original = "";
  f.world.runtime.act = async (actorId, request, deliver) => {
    await f.store.commit({ idempotencyKey: "ambient", source: "fixture", perceptions: [{ actorId, text: "旧世界的邻居正在敲门。" }] });
    await f.store.commit({ idempotencyKey: "action", source: "fixture", actionId: `${actorId}:${request.id}`, perceptions: [{ actorId, text: "杯子已放好。" }] });
    original = JSON.stringify({ observation: await f.world.runtime.peek(actorId), action: { id: `${actorId}:${request.id}`, status: "completed" } });
    f.world.runtime.perceptionsSince = async (...args) => { entered.resolve(); await release.promise; return read(...args); };
    await deliver(original); return true;
  };
  try {
    const receipts: { content: string; route?: WorldActDeliveryRoute }[] = [];
    const work = f.world.adjudicateAct(call, (content, route) => { receipts.push({ content, route }); });
    await bounded(entered.promise); f.world.setRemote(remote("新世界")); release.resolve(); await bounded(work);
    assert.deepEqual(receipts.map(item => item.content), [original]); assert.equal(receipts[0]!.route?.current, false);
    console.log("PASS a routing transition during awaited journal delivery is rechecked before publishing old scenes");
  } finally { release.resolve(); f.world.runtime.perceptionsSince = read; await f.close(); }
}

async function remoteReceiptAfterChangingRoute() {
  const f = await fixture(), began = deferred<void>(), release = deferred<void>();
  const first = remote("原来的远方城镇"), second = remote("下一站");
  const beginning = JSON.stringify({ observation: { observationId: "remote-start", sourceEventIds: ["remote-start"], narrative: "你开始把杯子放下。" }, action: { status: "pending", phase: "ongoing" } });
  const final = JSON.stringify({ observation: { observationId: "remote-finish", sourceEventIds: ["remote-finish"], narrative: "杯子已落在原来世界的桌上。" }, action: { status: "completed", phase: "finished" } });
  first.adjudicateAct = async (_request, deliver) => { await deliver(beginning); began.resolve(); await release.promise; await deliver(final); return true; };
  try {
    f.world.setRemote(first);
    const receipts: { content: string; route?: WorldActDeliveryRoute }[] = [];
    const work = f.world.adjudicateAct(call, (content, route) => { receipts.push({ content, route }); });
    await bounded(began.promise); f.world.setRemote(second); release.resolve(); await bounded(work);
    assert.deepEqual(receipts.map(item => item.content), [beginning, final]);
    assert.equal(receipts[0]!.route?.current, true); assert.equal(receipts[1]!.route?.current, false);
    assert.equal(receipts[0]!.route?.epoch, receipts[1]!.route?.epoch);
    assert.equal(receipts[1]!.route?.worldName, "原来的远方城镇");
    console.log("PASS remote progress/final receipts keep their original route while a later destination becomes current");
  } finally { release.resolve(); await f.close(); }
}

async function routeChangeRevokesUncommittedPhysicalStage(finishing: boolean) {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), waiting = deferred<void>(), due = deferred<void>();
  (f.world.runtime as any).until = async () => { waiting.resolve(); await due.promise; };
  const receipts: { content: string; route?: WorldActDeliveryRoute }[] = [], authorized: string[] = [];
  (f.world as any).client = { complete: async (messages: any[]) => {
    const request = JSON.parse([...messages].reverse().find(message => message.role === "user").content);
    if (finishing && request.actionPhase === "start") return response({ worldState: "小澈在本地院子开始缓缓挪动杯子。", actorStates: [{ actorId: "bot", state: "在院子里托着杯子，尚未放好。" }], perceptions: [{ actorId: "bot", text: "你开始缓缓挪动杯子。" }], outcome: { status: "ongoing" } });
    entered.resolve(); await release.promise;
    return response({ worldState: "禁止提交的旧世界未来：杯子已经放好。", actorStates: [{ actorId: "bot", state: "禁止提交的旧世界未来：已经走到门口。" }], perceptions: [{ actorId: "bot", text: "禁止交付的旧世界未来：你已放好杯子。" }], outcome: { status: "completed" } });
  } };
  try {
    const work = f.world.adjudicateAct({ ...call, id: finishing ? "blocked-finish" : "blocked-start", expectedAt: finishing ? 110 : 10 }, (content, route) => { receipts.push({ content, route }); }, undefined, phase => { authorized.push(phase); return true; });
    const rejected = assert.rejects(work, /未完成或被取消/);
    if (finishing) { await bounded(waiting.promise); f.setNow(110); due.resolve(); }
    await bounded(entered.promise);
    const before = f.store.snapshot(), priorStages = f.store.readPerceptions("bot");
    f.world.setRemote(remote("新的世界")); release.resolve(); await bounded(rejected);
    const after = f.store.snapshot();
    assert.equal(after.worldState, before.worldState); assert.equal(after.actors.bot!.state, before.actors.bot!.state);
    assert.doesNotMatch(JSON.stringify(after), /禁止提交/); assert.ok(!receipts.some(item => item.content.includes("禁止交付")));
    assert.deepEqual(f.store.readPerceptions("bot").slice(0, priorStages.length), priorStages, "already saved stages are not rolled back");
    assert.equal(after.actions[`bot:${finishing ? "blocked-finish" : "blocked-start"}`]!.status, "failed");
    if (finishing) assert.ok(authorized.length > 0 && authorized.every(phase => phase === "start"), "route rejection does not seal the caller's finish commit");
    else assert.deepEqual(authorized, [], "revoked route never invokes the caller's commit authorization");
    assert.equal(receipts.length, finishing ? 1 : 0);
    console.log(finishing ? "PASS real ongoing action keeps its beginning but cannot commit a physical finish after route change" : "PASS real pending inference cannot start a physical action after route change");
  } finally { release.resolve(); due.resolve(); await f.close(); }
}

async function alreadyCommittedPhysicalResultSurvivesRouteChange() {
  const f = await fixture(), committed = deferred<void>(), release = deferred<void>();
  const commit = f.store.commit.bind(f.store);
  f.store.commit = (async (input, options) => {
    const result = await commit(input, options);
    if (input.actionPhase === "finish" && input.perceptions?.length) { committed.resolve(); await release.promise; }
    return result;
  }) as typeof f.store.commit;
  (f.world as any).client = { complete: async () => response({ worldState: "杯子已经放在本地桌上。", actorStates: [{ actorId: "bot", state: "站在本地桌边，手已离开杯子。" }], perceptions: [{ actorId: "bot", text: "你把杯子放在桌上。" }], outcome: { status: "completed" } }) };
  try {
    const receipts: { content: string; route?: WorldActDeliveryRoute }[] = [];
    const work = f.world.adjudicateAct({ ...call, id: "committed-before-travel" }, (content, route) => { receipts.push({ content, route }); });
    await bounded(committed.promise);
    const saved = f.store.snapshot(); assert.equal(saved.actions["bot:committed-before-travel"]!.status, "completed");
    f.world.setRemote(remote("另一处世界")); release.resolve(); assert.equal(await bounded(work), true);
    assert.deepEqual(f.store.snapshot(), saved, "routing after durable commit cannot invalidate or roll back reality");
    assert.equal(receipts.length, 1); assert.equal(receipts[0]!.route?.current, false);
    const receipt = JSON.parse(receipts[0]!.content); assert.equal(receipt.action.status, "completed"); assert.deepEqual(receipt.observation.sourceEventIds, f.store.readPerceptions("bot").at(-1)!.sourceEventIds);
    console.log("PASS route guard never drops a real action result committed before the transition");
  } finally { release.resolve(); f.store.commit = commit; await f.close(); }
}

async function main() { await localReceiptAfterDeparture(false); await localReceiptAfterDeparture(true); await transitionDuringJournalRead(); await remoteReceiptAfterChangingRoute(); await routeChangeRevokesUncommittedPhysicalStage(false); await routeChangeRevokesUncommittedPhysicalStage(true); await alreadyCommittedPhysicalResultSurvivesRouteChange(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
