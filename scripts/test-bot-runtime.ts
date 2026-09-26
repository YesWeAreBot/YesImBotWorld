import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { availableTools, BOT_TOOLS } from "../src/bot/tools.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import { Scheduler } from "../src/bot/scheduler.js";
import { ReceiptInbox } from "../src/bot/receipts.js";
import { toNativeToolDefs } from "../src/bot/nativeTools.js";
import { projectObservedMessages } from "../src/bot/perception-fragments.js";
import type { BotEvent, ToolCallRecord } from "../src/types.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
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
  const agent = new BotAgent(config, clock, files, context, world, {} as any, null, null, null, { down: false }, logger, BOT_TOOLS) as any;
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
async function truthfulRestReceipts() {
  const f = await fixture({ restCompressMinChars: 1e9 });
  let now = 100;
  f.clock.now = () => now;
  f.clock.realMsUntil = () => 60_000;
  const rest = { ...call("rest_interrupted", "rest"), issuedAt: now };
  f.agent.dispatchRest(rest);
  assert.equal(rest.expectedAt, 400, "an omitted duration defaults to 300 TU");
  now += 7.5;
  f.agent.pushEvent("koishi", { text: "手机振动了一下。", originEventIds: ["chat-notice:unseen"],
    experience: { agency: "observed", situation: "手机通知", subjectIds: [] } }, { wake: true });
  const interruption = f.agent.mailbox.find((item: any) => item.refToolCallId === rest.id);
  assert.match(interruption.content, /计时中断.*经过 7\.5 TU/);
  assert.match(interruption.content, /来源的频道、发送者和内容尚未确认/);
  assert.doesNotMatch(interruption.content, /睡|醒|迷迷糊糊|睁开/);
  assert.deepEqual(interruption.originEventIds, []);
  assert.equal(f.agent.waiting, null);
  assert.equal(f.agent.scheduler.pendingCount, 0);
  await f.agent.drainMailbox();
  const evidence = await f.agent.growth.recallEvidence({ n: 10 });
  assert.equal(evidence.length, 1, "the actual notification is evidence; interrupted rest is not sleep evidence");
  const completed = await fixture({ restCompressMinChars: 1e9 });
  completed.agent.dispatchRest(call("rest_completed", "rest", { duration: 0.005 }));
  await until(() => completed.agent.mailbox.some((item: any) => item.refToolCallId === "rest_completed"));
  const result = completed.agent.mailbox.find((item: any) => item.refToolCallId === "rest_completed");
  assert.match(result.content, /休息计时结束，经过 \d+\.\d TU/);
  assert.doesNotMatch(result.content, /睡醒|从浅睡|恢复了体力/);
  assert.deepEqual(result.originEventIds, []);
  assert.equal(completed.agent.waiting, null);
  const visible = await fixture({ restCompressMinChars: 1e9 });
  visible.agent.dispatchRest(call("visible_notice_rest", "rest", { duration: 300 }));
  visible.agent.pushEvent("koishi", { text: "已知频道有新通知", originEventIds: ["chat-notice:visible"],
    experience: { agency: "observed", chat: { channelKey: "onebot:group-a:account-a", kind: "notice" } } }, { wake: true });
  const visibleNotice = visible.agent.mailbox.find((item: any) => item.refToolCallId === "visible_notice_rest");
  assert.match(visibleNotice.content, /收到频道 onebot:group-a:account-a 的新通知/);
  assert.match(visibleNotice.content, /发送者和消息正文尚未读取/);
  assert.doesNotMatch(visibleNotice.content, /来源的频道.*未确认/);
  visible.agent.dispatchRest(call("message_rest", "rest", { duration: 300 }));
  visible.agent.pushEvent("koishi", { text: "实际已经交付的消息正文", originEventIds: ["chat-message:visible"],
    experience: { agency: "observed", chat: { channelKey: "onebot:group-a:account-a", kind: "message" } } }, { wake: true });
  const messageNotice = visible.agent.mailbox.find((item: any) => item.refToolCallId === "message_rest");
  assert.match(messageNotice.content, /新消息已交付/);
  assert.doesNotMatch(messageNotice.content, /正文尚未读取|发送者和内容尚未确认/);
}
async function progressDoesNotFollowNoise() {
  const f = await fixture({ restCompressMinChars: 1e9 });
  const repeated = call("same_rest", "rest", { duration: 300 });
  const count = () => f.agent.repeatGuard.observe(repeated).count;
  assert.equal(count(), 1);
  f.agent.pushEvent("koishi", { text: "手机振动了一下。", originEventIds: ["chat-notice:a"] });
  await f.agent.drainMailbox();
  assert.equal(count(), 2, "an anonymous notification cannot erase a rest loop");
  f.agent.pushEvent("world", { text: "时刻变化了。", originEventIds: ["world:unstructured"] });
  await f.agent.drainMailbox();
  assert.equal(count(), 3, "a new world envelope alone cannot prove changed circumstances");
  f.agent.pushEvent("koishi", { text: "实际读到一条新消息", originEventIds: ["chat-message:a"] });
  await f.agent.drainMailbox();
  assert.equal(count(), 1, "a new delivered message allows reassessment");
  f.agent.pushEvent("tool", { text: "回读同一条消息", originEventIds: ["chat-message:a"] });
  await f.agent.drainMailbox();
  assert.equal(count(), 2, "rereading a message cannot manufacture progress");
  const observation = (id: string, revision: number, door: string) => JSON.stringify({
    actorId: "bot", observationId: id, worldSequence: revision, observedAt: revision,
    sourceEventIds: [`world:${id}`], utterances: [],
    entities: [{ observedId: `handle-${id}`, kind: "place", name: "房间", self: false, revision, attributes: { door } }],
  });
  f.agent.pushEvent("world", observation("first", 1, "closed"));
  await f.agent.drainMailbox(); assert.equal(count(), 1);
  f.agent.pushEvent("world", observation("same", 2, "closed"));
  await f.agent.drainMailbox(); assert.equal(count(), 2, "time, revision and observed handles are not progress");
  f.agent.pushEvent("world", observation("changed", 3, "open"));
  await f.agent.drainMailbox(); assert.equal(count(), 1, "a changed perceived physical fact allows reassessment");
}
async function sharedPauseBudget() {
  const f = await fixture({ disableWait: true, waitRateThreshold: 50, waitRateWindow: 100, restCompressMinChars: 1e9 });
  let now = 0;
  f.clock.now = () => now;
  f.clock.realMsUntil = () => 60_000;
  const pause = (id: string, name = "rest", confirm = false) => ({ ...call(id, name, { duration: 80, ...(confirm ? { confirm: true } : {}) }, 80), issuedAt: now, expectedAt: now + 80 });
  f.agent.dispatchRest(pause("first"));
  now = 60;
  f.agent.pushEvent("koishi", { text: "手机有通知。", originEventIds: ["chat-notice:budget"] }, { wake: true });
  assert.equal(f.agent.waitedWithin(0, now), 60, "an interrupted rest charges actual time, not its requested duration");
  const hidden = { ...call("hidden-control", "act", { description: "尚未感知的外部意图" }, 600), role: "system" as const };
  f.agent.operationCalls.set(hidden.id, hidden);
  f.agent.stealthCalls.add(hidden.id);
  f.agent.scheduler.schedule(hidden, { executeAt: "expected", run: async () => null });
  f.agent.dispatchRest(pause("blocked", "rest", true));
  assert.equal(f.agent.waiting, null, "habitually adding confirm cannot bypass a first refusal");
  const refused = f.agent.mailbox.find((item: any) => item.refToolCallId === "blocked");
  assert.equal(refused.content, "等待额度已耗尽", "budget feedback is concise; actual charged duration is asserted separately");
  assert.doesNotMatch(refused.content, /hidden-control|外部意图/, "budget feedback may list only the character's own submitted tasks");
  assert.equal(f.agent.compressionRequested, null, "a refused rest cannot erase repetition by requesting compaction");
  f.agent.dispatchWait(pause("switch_tool", "wait", true));
  assert.equal(f.agent.waiting, null, "rest confirmation cannot be transferred to wait");
  f.agent.dispatchRest(pause("back_to_rest", "rest", true));
  assert.equal(f.agent.waiting, null);
  f.agent.dispatchRest(pause("confirmed", "rest", true));
  assert.equal(f.agent.waiting.callId, "confirmed", "a considered next-call confirmation permits real continued rest");
  now = 75;
  f.agent.dispatchCancel(call("cancel", "cancel", { id: "confirmed" }));
  assert.equal(f.agent.waitedWithin(0, now), 75, "cancellation retains the elapsed part exactly once");
  f.agent.dispatchRest(pause("again", "rest", true));
  assert.equal(f.agent.waiting, null, "confirmation is consumed, not a standing permission");
  const manual = { ...pause("human_rest"), role: "system" as const };
  f.agent.dispatchRest(manual);
  assert.equal(f.agent.waiting.callId, "human_rest", "a controller's explicit rest is not blocked by the autonomous budget");
  now = 85;
  f.agent.dispatchCancel(call("cancel_human", "cancel", { id: "human_rest" }));
  assert.equal(f.agent.waitedWithin(0, now), 75, "controller time is not attributed to autonomous idling");
  now = 200;
  f.agent.dispatchRest(pause("fresh_window"));
  assert.equal(f.agent.waiting.callId, "fresh_window", "elapsed world time restores budget without requiring an incoming notification");
  now = 205;
  await f.agent.stop();
  assert.equal(f.agent.waitedWithin(100, now), 5, "stopping records the real interval and cancels its timer");
  const tools = availableTools({ ops: {}, disableWait: true, waitConfirm: true } as any);
  assert.ok(!tools.some(tool => tool.name === "wait"));
  assert.match(tools.find(tool => tool.name === "rest")!.signature, /confirm\?: boolean/);
}
async function maintenanceIsNotProgress() {
  const f = await fixture({ waitRateWindow: 100 }, { compress: async () => ({ historySummary: "已整理", memoryDigest: "摘要" }) });
  const repeated = call("rest_before_maintenance", "rest", { duration: 300 });
  assert.equal(f.agent.repeatGuard.observe(repeated).count, 1);
  f.agent.waitLog.push({ from: 0, to: 60 });
  await f.context.appendEvent({ id: f.context.nextEventId(), source: "system", content: "维护说明", worldTime: 60 });
  f.agent.running = true;
  await f.agent.compactContext(null);
  assert.equal(f.agent.repeatGuard.observe(repeated).count, 2, "routine rest compression cannot erase a repetition streak");
  assert.equal(f.agent.waitedWithin(0, 100), 60, "compaction cannot restore the spent pause budget");
  await f.agent.stop();
}
async function reflectBehaviorContract() {
  const def = toNativeToolDefs(BOT_TOOLS).find(tool => tool.function.name === "reflect")!;
  assert.deepEqual((def.function.parameters.properties as any).behavior, { type: "string" });
  const f = await fixture();
  let received: any;
  f.agent.growth.reflect = async (input: any) => {
    received = input;
    return { duplicate: false, view: { claimId: "claim", records: [{ id: "record" }] } };
  };
  await f.agent.dispatch(call("reflect_behavior", "reflect", {
    kind: "habit", subject: "书桌整理", statement: "收工后整理书桌", situation: "收工之后", behavior: "整理书桌", event_ids: ["actual-action"],
  }));
  await until(() => !!received);
  assert.equal(received.behavior, "整理书桌", "manual reflection must forward the exact behavior anchor to the evidence validator");
  await until(() => f.agent.scheduler.pendingCount === 0);
}
async function deviceObservationEvidence() {
  const f = await fixture();
  const chat = { channelKey: "onebot:visible:account", kind: "attention" as const };
  const parts = ["first", "second"].map(id => ({ kind: "text" as const, text: `已读消息 ${id}`,
    observedMessage: { originEventIds: [`chat-message:${id}`], experience: { agency: "observed" as const,
      chat: { ...chat, kind: "message" as const }, subjectIds: ["chat-user:[\"onebot\",\"known-user\"]"] } } }));
  f.agent.peekDevice = async () => ({ text: "两条已读消息", parts, originEventIds: ["chat-message:first", "chat-message:second"],
    growthReferences: [{ claimId: "existing", recordId: "record" }], experience: { agency: "observed", chat } });
  const screen = await f.agent.deviceObservation("phone");
  assert.deepEqual(screen.originEventIds, ["chat-message:first", "chat-message:second"]);
  assert.deepEqual(screen.experience.chat, chat);
  assert.deepEqual(screen.growthReferences, [{ claimId: "existing", recordId: "record" }]);
  f.agent.pushEvent("tool", screen, { ref: "screen_read" });
  await f.agent.drainMailbox();
  const parent = f.context.stream.find(entry => entry.kind === "event") as any;
  assert.equal(projectObservedMessages(parent.event.id, f.context.stream)?.length, 2, "screen wrappers must retain complete parent roots for per-message projection");
  f.agent.pushEvent("tool", await f.agent.deviceObservation("phone"), { ref: "screen_reread" });
  await f.agent.drainMailbox();
  assert.equal((await f.agent.growth.stats()).uniqueRoots, 2, "rereading a screen does not duplicate the original message causes");
  f.agent.peekDevice = async () => ({ text: "界面保留的旧执行结果", originEventIds: ["prior-action"], experience: {
    agency: "self", action: "旧动作", outcome: "completed", opportunity: true, worldPerception: true,
  } });
  const cached = await f.agent.deviceObservation("phone");
  assert.equal(cached.experience.agency, "observed");
  assert.equal(cached.experience.outcome, "unknown");
  assert.equal(cached.experience.opportunity, false);
  assert.equal(cached.experience.worldPerception, false);
  assert.equal(cached.experience.action, undefined, "an old application execution cannot become a new voluntary action by viewing its result");
}
async function truthfulChannelNoticeSetting() {
  const f = await fixture();
  f.agent.running = true;
  f.agent.phoneUi.chatOpen = true;
  f.agent.phoneUi.channelKey = "onebot:visible:account";
  f.agent.messenger.resolveKey = async (key: string) => ({ key, isPrivate: true });
  let enabled = true;
  f.agent.notifyList = { set: async (_key: string, allow: boolean) => { enabled = allow; },
    channelStatusText: () => enabled ? "频道通知：开启。" : "频道通知：免打扰（不主动震动／唤醒；打开频道仍能看见消息）。" };
  await f.agent.dispatch({ ...call("notify_setting", "channel_notify", { allow: false }), role: "system" });
  await until(() => f.agent.mailbox.some((item: any) => item.refToolCallId === "notify_setting" && item.source === "tool"));
  const receipt = f.agent.mailbox.find((item: any) => item.refToolCallId === "notify_setting" && item.source === "tool");
  assert.equal(enabled, false);
  assert.match(receipt.content, /打开频道仍能看见消息/);
  assert.doesNotMatch(receipt.content, /之后.*不会再提醒/);
  await f.agent.stop();
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
    compress: async () => { entered.resolve(); return finish.promise; },
  });
  f2.agent.backend = { generate: async () => { generations++; return generations <= 3 ? { name: "observe_device", arguments: { device: "phone" } } : { name: "wait", arguments: { n: 3600 } }; }, setToolNames() {}, setToolDefs() {} };
  f2.agent.peekDevice = async () => ({ text: "手机上仍显示刚刚读到的同一条消息。", originEventIds: ["chat-message:first-read"],
    experience: { agency: "observed", chat: { kind: "attention", channelKey: "onebot:visible:account" } } });
  f2.agent.start(); await entered.promise;
  assert.equal(generations, 3, "the first new observation is progress; repeating it must pause at the compression boundary");
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
  await Promise.all([f.context.appendEvent(next), f.context.persistPinned(), f.context.settled()]);
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
  const observation = { actorId: "visitor:authenticated-session", observationId: "obs_remote", sourceEventIds: ["original_speech"], entities: [], utterances: [], worldSequence: 1, observedAt: 0 };
  const f = await fixture();
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
  const restarted = new BotAgent(f.agent.config, f.clock, f.files, restored, {}, {} as any, null, null, null, { down: false }, logger, BOT_TOOLS) as any;
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
  try { await lifecycle(); await truthfulRestReceipts(); await progressDoesNotFollowNoise(); await sharedPauseBudget(); await maintenanceIsNotProgress(); await reflectBehaviorContract(); await deviceObservationEvidence(); await truthfulChannelNoticeSetting(); await breakLoop(); await contextWrites(); await recoverInterruptedCompression(); await observationProvenance(); await schedulerAndFailure(); await lateReceipts(); console.log("PASS bot runtime: truthful rest/interruptions, shared pause budget and real progress, behavior/device evidence and DND receipts, interruptible stop, bounded compression, serialized context, truthful failure/cancellation, durable late receipts and timeline fences"); }
  finally { await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
