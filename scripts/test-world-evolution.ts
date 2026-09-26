/** Heartbeats develop the outside world, not a second autonomous turn for its controlled actors. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { Prompts } from "../src/prompts.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { WORLD_EVOLUTION_AUTHORITY, worldResolutionTool } from "../src/world/proposal.js";
import type { ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const response = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "world", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("world evolution operation did not settle")), 2000); })]); }
  finally { clearTimeout(timer); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-evolution-")), files = new WorldFiles(base); await files.ensure();
  let now = 100, handler: (request: any, signal?: AbortSignal) => Promise<ChatResult> = async () => response({ perceptions: [] });
  const requests: any[] = [], schemas: any[] = [], systems: string[] = [];
  const prompts = new Prompts(); prompts.setOverrides({ world: { narrativeSystem: "自定义世界文风。" } });
  const runtime = new NarrativeWorld(files, { now: () => now, realMsUntil: () => 1, unitRealSeconds: 1 } as any, async (messages, tools, signal) => {
    const request = JSON.parse(messages.find(message => message.role === "user")!.content as string);
    requests.push(request); schemas.push(tools[0]!.function.parameters); systems.push(String(messages[0]!.content));
    return handler(request, signal);
  }, prompts);
  const store = await runtime.store();
  await store.commit({ idempotencyKey: "fixture", source: "fixture", initialized: true, worldState: "院子里有一张长椅。北方的小镇正在修路。", actors: {
    bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "坐在院子的长椅上，衣服干燥。", perception: "院子里很安静。" },
    "visitor:a": { id: "visitor:a", name: "来客", controller: "player", present: true, state: "在隔音的屋内读书。", perception: "屋内安静。" },
  } });
  return { base, files, runtime, store, requests, schemas, systems, setNow: (value: number) => { now = value; }, setHandler: (value: typeof handler) => { handler = value; },
    call: (id: string, intent = "坐在长椅上慢慢描画院子", duration = 900): ToolCallRecord => ({ id, role: "agent", name: "act", issuedAt: now, expectedAt: now + duration, duration, arguments: { description: intent } }),
    close: async () => { await runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function outsideWorldAndLegitimateEffects() {
  const f = await fixture();
  try {
    const before = f.store.snapshot();
    f.setHandler(async request => response({ externalChanges: [{ id: "road", description: "北方小镇的工人修好了一段路。" }], worldState: request.worldState + "北方小镇新修好了一段路。", perceptions: [] }));
    await f.runtime.evolve("世界继续运转。", { heartbeat: true });
    assert.match(f.store.snapshot().worldState, /新修好/); assert.deepEqual(f.store.snapshot().actors, before.actors);
    assert.equal(f.store.readPerceptions("bot").length, 0); assert.equal(f.store.readPerceptions("visitor:a").length, 0);
    assert.ok(f.systems[0]!.includes(WORLD_EVOLUTION_AUTHORITY), "editable prose overrides cannot erase evolution authority");
    assert.equal(f.schemas[0].properties.actorStates, undefined); assert.equal(f.schemas[0].properties.outcome, undefined);
    assert.deepEqual(f.schemas[0].properties.perceptions.items.required, ["actorId", "text", "changeIds"]);
    const quiet = f.store.snapshot(), journal = await f.store.exportJournal();
    f.setHandler(async () => response({ externalChanges: [], perceptions: [] }));
    await f.runtime.evolve("没有新变化。", { heartbeat: true });
    assert.deepEqual(f.store.snapshot(), quiet); assert.equal(await f.store.exportJournal(), journal);

    f.setHandler(async request => response({ externalChanges: [{ id: "rain", description: "院子里下起雨，雨水落在长椅和小澈衣服上。" }], worldState: request.worldState + "院子下起雨，长椅和小澈的衣服被打湿。",
      actorEffects: [{ actorId: "bot", changeIds: ["rain"], state: "坐在院子的长椅上，雨水打湿了衣服，皮肤感到凉意。" }],
      perceptions: [{ actorId: "bot", changeIds: ["rain"], text: "雨点落在你的衣服上，凉意透过湿布料。", opportunities: [{ label: "去屋檐下", intent: "走到屋檐下避雨" }, { label: "喝口水", intent: "喝一口身旁杯子里的水" }] }] }));
    await f.runtime.evolve("院子里的天气变化。");
    assert.match(f.store.snapshot().actors.bot!.state, /衣服.*凉意/);
    assert.deepEqual(f.store.snapshot().actors["visitor:a"], before.actors["visitor:a"], "unperceived rain does not enter another actor's state or memory");
    const perception = f.store.readPerceptions("bot").at(-1)!;
    assert.equal(perception.actionId, undefined); assert.equal(perception.phase, undefined); assert.deepEqual(perception.sourceEventIds, [perception.eventId]);
    assert.doesNotMatch(perception.text, /北方|修路/);
    assert.equal(f.store.snapshot().actions && Object.keys(f.store.snapshot().actions).length, 0, "suggestions do not become actor choices");
    const saved = await f.store.exportJournal(), records = saved.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(records.at(-1).commit.evolution.actorEffects, [{ actorId: "bot", changeIds: ["rain"] }]);
    assert.deepEqual(records.at(-1).commit.evolution.perceptionSources, [{ actorId: "bot", changeIds: ["rain"] }]);
    const reopened = await NarrativeStore.open(f.base, { now: () => 100 });
    assert.deepEqual(reopened.snapshot(), f.store.snapshot()); assert.equal(await reopened.exportJournal(), saved, "new provenance survives replay without rewriting old records");
    // A genuine historical record has no evolution field. Preserve its original bytes,
    // but do not let new producers create that legacy shape through commit().
    const legacyBase = path.join(f.base, "legacy"); await fs.mkdir(legacyBase);
    const legacyRecords = structuredClone(records);
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    for (const record of legacyRecords) if (record.commit.source === "evolve") {
      delete record.commit.evolution; record.fingerprint = hash(record.commit);
      const { checksum: _checksum, ...body } = record; record.checksum = hash(body);
    }
    const legacyText = legacyRecords.map(record => JSON.stringify(record) + "\n").join("");
    await fs.writeFile(path.join(legacyBase, "world-narrative.jsonl"), legacyText);
    const legacy = await NarrativeStore.open(legacyBase, { now: () => 100 });
    assert.deepEqual(legacy.snapshot(), f.store.snapshot()); assert.equal(await legacy.exportJournal(), legacyText);
    const actionSchema = worldResolutionTool().function.parameters as any;
    assert.match(actionSchema.properties.perceptions.items.properties.opportunities.description, /喝水.*休息.*收拾/);
    console.log("PASS external-only heartbeat authority, remote world history, quiet no-op, causal physical impact, private perception and durable provenance");
  } finally { await f.close(); }
}

async function invalidActorWritesAndMissingCauses() {
  const f = await fixture();
  try {
    const cases: [unknown, RegExp][] = [
      [{ actorStates: [{ actorId: "bot", state: "你觉得困倦，于是睡着又醒来。" }], perceptions: [] }, /EVOLUTION_ACTOR_AUTHORITY/],
      [{ outcome: { status: "completed" }, perceptions: [] }, /EVOLUTION_ACTOR_AUTHORITY/],
      [{ perceptions: [{ actorId: "bot", text: "你睡醒了。" }] }, /EVOLUTION_REFERENCE_MISSING: perceptions\[0\]\.changeIds/],
      [{ worldState: "院子里开始下雨。", externalChanges: [{ id: "rain", description: "院子里开始下雨。" }], actorEffects: [{ actorId: "bot", state: "衣服湿了。", changeIds: ["old-event"] }], perceptions: [] }, /EVOLUTION_REFERENCE_UNKNOWN: actorEffects\[0\]\.changeIds/],
      [{ worldState: "院子里开始下雨。", externalChanges: [{ id: "rain", description: "院子里开始下雨。" }], perceptions: [{ actorId: "bot", text: "雨滴落在衣服上。", changeIds: ["other"] }] }, /EVOLUTION_REFERENCE_UNKNOWN: perceptions\[0\]\.changeIds/],
      [{ worldState: "院子里开始下雨。", externalChanges: [{ id: "rain", description: "院子里开始下雨。" }], actorEffects: [{ actorId: "stranger", state: "衣服湿了。", changeIds: ["rain"] }], perceptions: [] }, /在场角色/],
    ];
    for (const [proposal, pattern] of cases) {
      const before = f.store.snapshot(), requests = f.requests.length;
      f.setHandler(async () => response(proposal));
      await assert.rejects(f.runtime.evolve("环境继续运转。"), pattern);
      assert.equal(f.requests.length, requests + 3); assert.deepEqual(f.store.snapshot(), before);
    }
    const unchangedState = f.store.snapshot();
    f.setHandler(async () => response({ externalChanges: [{ id: "wind", description: "又一阵风吹过北方小镇。" }], perceptions: [] }));
    const eventOnly = await f.runtime.evolve("短暂经过，不改变持续处境。");
    assert.equal(eventOnly.status, "committed"); assert.equal(f.store.snapshot().sequence, unchangedState.sequence + 1);
    assert.equal(f.store.snapshot().worldState, unchangedState.worldState); assert.deepEqual(f.store.snapshot().actors, unchangedState.actors);
    assert.deepEqual(JSON.parse((await f.store.exportJournal()).trim().split("\n").at(-1)!).commit.evolution.changes, [{ id: "wind", description: "又一阵风吹过北方小镇。" }]);
    for (const field of ["externalChanges", "actorEffects"] as const) {
      f.setHandler(async () => response({ worldState: "院子下雨。", externalChanges: [{ id: "rain", description: field === "externalChanges" ? "手机收到一条新消息：你好。" : "院子下雨。" }],
        ...(field === "actorEffects" ? { actorEffects: [{ actorId: "bot", state: "手机收到一条新消息：你好。", changeIds: ["rain"] }] } : {}), perceptions: [] }));
      await assert.rejects(f.runtime.evolve("雨水落下。"), /WORLD_DEVICE_BOUNDARY/);
    }
    const snapshot = f.store.snapshot(), evolution = { changes: [{ id: "rain", description: "院子下雨。" }], actorEffects: [{ actorId: "bot", changeIds: ["rain"] }], perceptionSources: [] };
    await assert.rejects(f.store.commit({ idempotencyKey: "identity-bypass", source: "evolve", worldState: snapshot.worldState + "院子下雨。", actors: { bot: { ...snapshot.actors.bot!, name: "别人", state: "衣服湿了。" } }, evolution }), /不能改写身份/);
    assert.throws(() => f.store.commit({ idempotencyKey: "missing-effect", source: "evolve", worldState: snapshot.worldState + "院子下雨。", actors: { bot: snapshot.actors.bot! }, evolution: { ...evolution, actorEffects: [] } }), /分别引用/);
    assert.throws(() => f.store.commit({ idempotencyKey: "action-bypass", source: "evolve", worldState: snapshot.worldState + "院子下雨。", actions: {}, evolution: { ...evolution, actorEffects: [] } }), /不能结算角色行动/);
    assert.throws(() => f.store.commit({ idempotencyKey: "legacy-bypass", source: "evolve", actors: { bot: { ...snapshot.actors.bot!, state: "绕过来源让角色睡醒。" } } }), /必须包含本轮外部变化/);
    assert.deepEqual(f.store.snapshot(), snapshot);

    const commit = f.store.commit.bind(f.store), diskError = Error("真实磁盘写入错误");
    f.store.commit = ((input: any, options: any) => {
      if (input.source !== "evolve") return commit(input, options);
      (f.runtime as any).heartbeatController.abort(Error("恰好有动作开始")); throw diskError;
    }) as typeof f.store.commit;
    f.setHandler(async request => response({ worldState: request.worldState + "下起了雨。", externalChanges: [{ id: "rain", description: "院子下起了雨。" }], perceptions: [] }));
    await assert.rejects(f.runtime.evolve("新的心跳。", { heartbeat: true }), error => error === diskError, "heartbeat preemption must not swallow a real storage error");
    f.store.commit = commit;
    console.log("PASS actor/outcome write rejection, absent or stale causes, source identity checks, repair atomicity and unchanged device boundaries");
  } finally { await f.close(); }
}

async function longActionsLeaveRoomForOutsideLife() {
  const f = await fixture(), waiting = deferred<void>(), finish = deferred<void>(), heartbeatEntered = deferred<AbortSignal>(), lateHeartbeat = deferred<ChatResult>();
  (f.runtime as any).until = async () => { waiting.resolve(); await finish.promise; };
  let slowHeartbeat = false;
  f.setHandler(async (request, signal) => {
    if (request.kind === "evolve") {
      assert.equal(request.pendingActions[0].phase, "ongoing");
      if (slowHeartbeat) { heartbeatEntered.resolve(signal!); return lateHeartbeat.promise; }
      return response({ worldState: request.worldState + "北方小镇的修路工完成了一段路。", externalChanges: [{ id: "road", description: "远处修路工完成了一段路。" }], perceptions: [] });
    }
    if (request.actionPhase === "start") return response({ worldState: request.worldState + "小澈在长椅上开始画院子。", actorStates: [{ actorId: "bot", state: "在长椅上画画，画面尚未完成。" }], perceptions: [{ actorId: "bot", text: "你开始勾画院子的轮廓。" }], outcome: { status: "ongoing" } });
    assert.equal(request.actionPhase, "finish"); assert.match(request.worldState, /修路工完成/);
    return response({ worldState: request.worldState + "小澈画完院子的速写。", actorStates: [{ actorId: "bot", state: "坐在长椅上，手中速写刚完成。" }], perceptions: [{ actorId: "bot", text: "你画完了院子的速写。" }], outcome: { status: "completed" } });
  });
  try {
    const receipts: any[] = [], action = f.runtime.act("bot", f.call("draw"), text => { receipts.push(JSON.parse(text)); });
    await bounded(waiting.promise);
    const ongoing = f.store.snapshot().actions["bot:draw"]!;
    f.setNow(200); await bounded(f.runtime.evolve("自然经过。", { heartbeat: true }));
    assert.equal(f.requests.filter(request => request.kind === "evolve").length, 1);
    assert.deepEqual(f.store.snapshot().actions["bot:draw"], ongoing); assert.match(f.store.snapshot().actors.bot!.state, /尚未完成/);
    assert.equal(receipts.length, 1); assert.equal(f.store.readPerceptions("bot").length, 1, "remote world life is not an extra action result");
    f.setNow(980); const count = f.requests.length; await f.runtime.evolve("临近结算。", { heartbeat: true }); assert.equal(f.requests.length, count);
    f.setNow(900); slowHeartbeat = true;
    const heartbeat = f.runtime.evolve("慢速心跳。", { heartbeat: true }), signal = await bounded(heartbeatEntered.promise);
    f.setNow(1000); finish.resolve();
    assert.equal(await bounded(action), true); await bounded(heartbeat); assert.equal(signal.aborted, true);
    assert.equal(receipts.length, 2); assert.equal(receipts[1].action.status, "completed");
    const done = f.store.snapshot();
    lateHeartbeat.resolve(response({ worldState: "过时的世界不能覆盖完成的行动。", externalChanges: [{ id: "late", description: "过时的变化。" }], perceptions: [] }));
    await tick(); await tick(); assert.deepEqual(f.store.snapshot(), done);
    console.log("PASS long ongoing action permits world life, due-stage priority cancels slow heartbeat, latest-state finish and no stale commit");
  } finally { finish.resolve(); lateHeartbeat.resolve(response({ perceptions: [] })); await f.close(); }
}

async function newActionInterruptsHeartbeat() {
  const f = await fixture(), entered = deferred<AbortSignal>(), late = deferred<ChatResult>();
  f.setHandler(async (request, signal) => {
    if (request.kind === "evolve") { entered.resolve(signal!); return late.promise; }
    return response({ perceptions: [{ actorId: "bot", text: "你喝了一口水。" }], outcome: { status: "completed" } });
  });
  try {
    const heartbeat = f.runtime.evolve("自然经过。", { heartbeat: true }), signal = await bounded(entered.promise);
    assert.equal(await bounded(f.runtime.act("bot", f.call("water", "喝口水", 0), () => {})), true);
    await bounded(heartbeat); assert.equal(signal.aborted, true);
    const after = f.store.snapshot(); late.resolve(response({ worldState: "过时的雨。", externalChanges: [{ id: "rain", description: "过时的雨。" }], perceptions: [] }));
    await tick(); await tick(); assert.deepEqual(f.store.snapshot(), after);
    console.log("PASS new action aborts uncommitted background inference instead of waiting for an unrelated heartbeat");
  } finally { late.resolve(response({ perceptions: [] })); await f.close(); }
}

async function main() { await outsideWorldAndLegitimateEffects(); await invalidActorWritesAndMissingCauses(); await longActionsLeaveRoomForOutsideLife(); await newActionInterruptsHeartbeat(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
