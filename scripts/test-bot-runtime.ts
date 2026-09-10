import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import { Scheduler } from "../src/bot/scheduler.js";
import { ReceiptInbox } from "../src/bot/receipts.js";
import type { BotEvent, ToolCallRecord } from "../src/types.js";

const logger = { info() {}, warn() {}, error() {} } as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const until = async (fn: () => boolean) => { for (let i = 0; i < 500 && !fn(); i++) await sleep(2); assert.ok(fn(), "condition timed out"); };
const dirs: string[] = [];
function call(id: string, name: string, args: Record<string, unknown> = {}, duration = 0): ToolCallRecord {
  return { id, role: "agent", name, arguments: args, issuedAt: 0, expectedAt: duration, duration };
}
async function fixture(overrides: Record<string, unknown> = {}, world: any = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-test-runtime-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure(); await files.writeBotStatus("客观状态：在厨房");
  const context = new BotContext(files, ""); context.pinned.persona = "旧状态：在卧室";
  const epoch = Date.now();
  const clock = { now: () => (Date.now() - epoch) / 1000, unitRealSeconds: 1, timeLine: () => "T", realMsUntil: (t: number) => Math.max(0, (t - (Date.now() - epoch) / 1000) * 1000) } as any;
  const config = { bot: { baseURL: "http://invalid", model: "fake", nativeToolCalls: false, repeatThresholds: [2], repeatExclude: [], maxTokens: 100, minIntervalMs: 3, maxWindowChars: 100000, restCompressMinChars: 0, retryDelayMs: 1, breakLoop: false, spillMinChars: 0, waitRateThreshold: 0, ...overrides }, world: { waitNarrateMinRealSeconds: 0 }, platformOps: {} } as any;
  const agent = new BotAgent(config, clock, files, context, world, {} as any, null, null, null, { down: false }, logger, []) as any;
  return { agent, context, files, clock };
}
async function lifecycle() {
  const f = await fixture({}, { compress: async () => ({ historySummary: "summary", memoryDigest: "digest", botStatus: "不允许写入" }) });
  f.agent.backend = { generate: async () => ({ name: "rest", arguments: {}, duration: 3600 }), setToolNames() {}, setToolDefs() {} };
  f.agent.start(); await until(() => f.context.pinned.historySummary === "summary");
  const start = Date.now(); await f.agent.stop();
  assert.ok(Date.now() - start < 200, "stop must not wait for an hour of character sleep");
  assert.equal(await f.files.readBotStatus(), "客观状态：在厨房");
  assert.equal(f.agent.status().pendingTasks, 0);
  const f2 = await fixture({}, { compress: () => new Promise(() => {}) });
  f2.agent.backend = { generate: async () => ({ name: "rest", arguments: {}, duration: 3600 }), setToolNames() {}, setToolDefs() {} };
  f2.agent.start(); await until(() => !!f2.agent.compressionPromise);
  await Promise.race([f2.agent.stop(), sleep(200).then(() => { throw new Error("compression must not block stop"); })]);
}
async function breakLoop() {
  const f = await fixture({ breakLoop: true, breakLoopRemoveToolAt: 6, breakLoopForceRestAt: 12 });
  for (let i = 0; i < 12; i++) {
    const c = call(`tc_${i}`, "act", { description: `写数字 ${i}` });
    const observed = f.agent.repeatGuard.observe(c);
    if (observed) f.agent.handleRepeat(c, observed);
  }
  assert.equal(f.agent.compressionRequested, null, "distinct useful actions must not force maintenance");
  assert.equal(f.agent.forceRestCount, 0);
  const entered = deferred(), finish = deferred<any>(); let generations = 0;
  const f2 = await fixture({ breakLoop: true, breakLoopRemoveToolAt: 0, breakLoopForceRestAt: 1, repeatExclude: ["wait"] }, {
    observe: async () => ({ observationId: "obs_1", actorId: "bot", worldSequence: 1, observedAt: 0, entities: [], sourceEventIds: ["origin_1"] }),
    compress: async () => { entered.resolve(); return finish.promise; },
  });
  f2.agent.backend = { generate: async () => { generations++; return generations <= 2 ? { name: "observe", arguments: {} } : { name: "wait", arguments: { n: 3600 } }; }, setToolNames() {}, setToolDefs() {} };
  f2.agent.start(); await entered.promise;
  assert.equal(generations, 2, "generation must pause at compression boundary");
  const late: BotEvent = { id: "ev_manual_late", source: "koishi", content: "压缩开始后收到的重要承诺", worldTime: 3 };
  await f2.context.appendEvent(late);
  finish.resolve({ historySummary: "prefix only", memoryDigest: "digest" });
  await until(() => f2.context.pinned.historySummary === "prefix only");
  assert.ok(f2.context.stream.some((e) => e.kind === "event" && e.event.id === late.id));
  await f2.agent.stop();
}
async function contextWrites() {
  const f = await fixture();
  await Promise.all(Array.from({ length: 40 }, (_, i) => f.context.appendEvent({ id: f.context.nextEventId(), source: "koishi", content: `message ${i}`, worldTime: i })));
  assert.equal(f.context.stream.length, 40);
  const snapshot = await f.context.compressionSnapshot();
  const next = { id: f.context.nextEventId(), source: "koishi" as const, content: "retain after snapshot", worldTime: 41 };
  await Promise.all([f.context.appendEvent(next), f.context.persistPinned(), f.context.downgradeLastStatusEcho()]);
  await f.context.applyCompression({ historySummary: "summary", memoryDigest: "digest" }, 42, snapshot);
  assert.deepEqual(f.context.stream.map((e: any) => e.event.id), [next.id]);
  const restored = new BotContext(f.files, ""); await restored.load();
  assert.equal(restored.stream.length, 1);
  assert.equal(restored.nextEventId(), "ev_42");
  assert.ok((await restored.toChatMessages("T")).some((m) => JSON.stringify(m.content).includes('id=\\"ev_41\\"')));
}
async function recoverInterruptedCompression() {
  const f = await fixture();
  await f.context.appendEvent({ id: f.context.nextEventId(), source: "koishi", content: "不能丢的经历", worldTime: 1 });
  const snapshot = await f.context.compressionSnapshot();
  await f.context.appendEvent({ id: f.context.nextEventId(), source: "koishi", content: "保留后缀", worldTime: 2 });
  const write = f.files.atomicWrite.bind(f.files);
  let fail = true;
  f.files.atomicWrite = async (file, content) => {
    if (file === f.files.pinned && fail) { fail = false; throw new Error("simulated interruption before pinned commit"); }
    await write(file, content);
  };
  await assert.rejects(f.context.applyCompression({ historySummary: "已整理的经历", memoryDigest: "摘要" }, 3, snapshot), /simulated interruption/);
  const recovered = new BotContext(f.files, ""); await recovered.load();
  assert.equal(recovered.pinned.historySummary, "已整理的经历");
  assert.equal(recovered.stream.length, 1);
  assert.equal((recovered.stream[0] as any).event.content, "保留后缀");
  assert.equal(await f.files.exists(`${f.files.base}/context-commit.json`), false);
}
async function observationProvenance() {
  const received: any[] = [];
  const observation = { actorId: "visitor:authenticated-session", observationId: "obs_remote", sourceEventIds: ["original_speech"], entities: [], utterances: [], worldSequence: 1, observedAt: 0 };
  const f = await fixture({}, { observe: async (_actor: string, args: any) => { received.push(args); return observation; } });
  const result = await f.agent.readStatus(call("self", "check_status", { target: "self" }));
  assert.deepEqual(received[0], { target: undefined, modality: "self" });
  assert.deepEqual(result.originEventIds, ["original_speech"]);
  f.agent.pushEvent("world", JSON.stringify(observation));
  await f.agent.drainMailbox();
  const event = f.context.stream.find((e) => e.kind === "event") as any;
  assert.deepEqual(event.event.originEventIds, ["original_speech"]);
  const reflection = await f.agent.growth.reflect({ kind: "relationship", subject: "NPC", statement: "他说了一句话", evidenceIds: [event.event.id] }, 1);
  assert.deepEqual(reflection.view.records[0].rootEventIds, ["original_speech"]);
  // Re-reading the very same remote projection is not another social interaction.
  f.agent.pushEvent("world", JSON.stringify({ ...observation, observationId: "obs_remote_2" }));
  await f.agent.drainMailbox();
  const repeated = f.context.stream.at(-1) as any;
  const update = await f.agent.growth.reflect({ kind: "relationship", subject: "NPC", statement: "他说了一句话", claimId: reflection.view.claimId, evidenceIds: [repeated.event.id] }, 2);
  assert.equal(update.duplicate, true);
  let observed = 0;
  const f2 = await fixture({}, { resolveWait: async () => { observed++; return true; } });
  f2.agent.config.world.waitNarrateMinRealSeconds = 0.001;
  f2.agent.running = true;
  f2.agent.dispatchWait(call("wait_interrupted", "wait", { n: 0.03 }, 0.03));
  f2.agent.pushEvent("koishi", "马上打断等待", { wake: true });
  await sleep(45);
  assert.equal(observed, 0, "interrupted waits must not consume observations in advance");
  await f2.agent.stop();
}
async function schedulerAndFailure() {
  const f = await fixture({}, { adjudicateAct: async () => false });
  const receipts: string[] = []; let effects = 0;
  const scheduler = new Scheduler(f.clock, (r) => receipts.push(typeof r === "string" ? r : r.text), logger);
  const started = deferred(), finish = deferred();
  scheduler.schedule(call("send_1", "send"), { executeAt: "expected", run: async () => { started.resolve(); await finish.promise; effects++; return "sent"; } });
  await started.promise;
  assert.equal(scheduler.cancel("send_1"), "too_late"); finish.resolve();
  await until(() => receipts.length === 1); assert.equal(effects, 1);
  const awaiting = deferred(), release = deferred();
  scheduler.schedule(call("act_1", "act"), { executeAt: "now", cancellation: "cooperative", run: async (task) => { awaiting.resolve(); await release.promise; if (!task.beginCommit()) return null; effects++; return "acted"; } });
  await awaiting.promise; assert.equal(scheduler.cancel("act_1"), "cancelled"); release.resolve(); await sleep(5);
  assert.equal(effects, 1); assert.equal(receipts.length, 1);
  const committed = deferred(), settle = deferred();
  scheduler.schedule(call("act_2", "act"), { executeAt: "now", cancellation: "cooperative", run: async (task) => { assert.equal(task.beginCommit(), true); committed.resolve(); await settle.promise; effects++; return "committed"; } });
  await committed.promise; assert.equal(scheduler.cancel("act_2"), "too_late"); scheduler.stopAll(); settle.resolve();
  await until(() => receipts.length === 2);
  scheduler.schedule(call("already_done", "send", {}, 3600), { executeAt: "now", run: async () => "completed before fictional deadline" });
  await sleep(2); assert.equal(receipts.length, 2); scheduler.stopAll();
  assert.equal(receipts.length, 3, "stop must flush a committed receipt even if its world deadline has not arrived");
  f.agent.dispatchAct(call("failed_act", "act", { description: "开门" }));
  await until(() => f.agent.mailbox.some((m: any) => m.source === "tool"));
  const failure = f.agent.mailbox.find((m: any) => m.source === "tool");
  assert.match(failure.content, /失败/); assert.doesNotMatch(failure.content, /开门完成/); assert.equal(failure.statusEcho, undefined);
  const adjudicated = await fixture({}, { adjudicateAct: async (_call: any, deliver: (content: string) => void) => {
    deliver(JSON.stringify({ observation: { observationId: "obs_locked_door", actorId: "bot", sourceEventIds: ["door-event"] }, action: { status: "failed", reason: "门锁着，无法推开。" } })); return false;
  } });
  adjudicated.agent.dispatchAct(call("locked_act", "act", { description: "推门" }));
  await until(() => adjudicated.agent.mailbox.some((m: any) => m.source === "tool"));
  const locked = adjudicated.agent.mailbox.find((m: any) => m.source === "tool");
  assert.equal(JSON.parse(locked.content).action.reason, "门锁着，无法推开。"); assert.deepEqual(locked.originEventIds, ["door-event"]);
}
async function lateReceipts() {
  const f = await fixture();
  f.agent.backend = { generate: async () => ({ name: "wait", arguments: { n: 3600 } }), setToolNames() {}, setToolDefs() {} };
  f.agent.start(); await until(() => !!f.agent.waiting);
  const release = deferred();
  f.agent.scheduler.schedule(call("late_send", "send"), { executeAt: "expected", run: async () => { await release.promise; return { text: "外部动作已完成。", originEventIds: ["platform-message-123"] }; } });
  await f.agent.stop(); release.resolve(); await until(() => f.agent.scheduler.pendingCount === 0); await f.agent.receipts.settled();
  assert.ok(!f.context.stream.some((entry: any) => entry.kind === "event" && entry.event.content === "外部动作已完成。"), "stopped context must not receive late writes");
  const inboxFiles = await fs.readdir(path.join(f.files.base, "bot-receipts")); assert.equal(inboxFiles.filter(name => name.endsWith(".json")).length, 1);
  const restored = new BotContext(f.files, ""); await restored.load();
  const restarted = new BotAgent(f.agent.config, f.clock, f.files, restored, {}, {} as any, null, null, null, { down: false }, logger, []) as any;
  restarted.backend = f.agent.backend; restarted.start();
  await until(() => restored.stream.some((entry: any) => entry.kind === "event" && entry.event.content === "外部动作已完成。"));
  await restarted.draining;
  const receipt = restored.stream.find((entry: any) => entry.kind === "event" && entry.event.content === "外部动作已完成。") as any;
  assert.deepEqual(receipt.event.originEventIds, ["platform-message-123"]);
  assert.equal((await fs.readdir(path.join(f.files.base, "bot-receipts"))).filter(name => name.endsWith(".json")).length, 0);
  // A still-running previous task may settle even after the replacement Bot is already asleep.
  await f.agent.receipts.save({ text: "更晚才返回的回执。", originEventIds: ["platform-message-124"] }, 11, "late_send_2");
  await until(() => restored.stream.some((entry: any) => entry.kind === "event" && entry.event.content === "更晚才返回的回执。"));
  await restarted.stop();
  const again = new ReceiptInbox(f.files.base); let duplicates = 0; await again.drain(async () => { duplicates++; }); assert.equal(duplicates, 0);
  // Reset rotates a non-restorable epoch. Old requests retain their old epoch even when returning later.
  const savedWorld = await f.files.snapshot("before-receipt-reset");
  await f.files.reset();
  await f.agent.receipts.save({ text: "旧世界回执不得污染新世界。", originEventIds: ["old-world-result"] }, 12);
  const nextTimeline = new ReceiptInbox(f.files.base); let leaked = 0; await nextTimeline.drain(async () => { leaked++; }); assert.equal(leaked, 0);
  await nextTimeline.save({ text: "新世界回执", originEventIds: ["new-world-result"] }, 13); await nextTimeline.drain(async event => { assert.equal(event.content, "新世界回执"); leaked++; }); assert.equal(leaked, 1);
  await f.files.restoreFrom(path.join(f.files.archiveDir, savedWorld));
  await nextTimeline.save("读档前发出的请求现在才返回", 14);
  const restoredTimeline = new ReceiptInbox(f.files.base); await restoredTimeline.drain(async () => { leaked++; }); assert.equal(leaked, 1, "restore must rotate the receipt epoch instead of importing abandoned-future results");
}
async function main() {
  try { await lifecycle(); await breakLoop(); await contextWrites(); await recoverInterruptedCompression(); await observationProvenance(); await schedulerAndFailure(); await lateReceipts(); console.log("PASS bot runtime: interruptible rest/stop, bounded compression, serialized context, truthful failure/cancellation, durable late receipts and timeline fences"); }
  finally { await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
