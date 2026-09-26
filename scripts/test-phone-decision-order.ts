/** Autonomous decisions consume actual device receipts; human operations remain independent. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Scheduler } from "../src/bot/scheduler.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ParsedToolCall } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until(test: () => boolean) { for (let i = 0; i < 1000 && !test(); i++) await sleep(2); assert.ok(test(), "device fixture did not settle"); }
const dirs: string[] = [], agents: any[] = [];
const clock: any = { now: () => 10, timeLine: () => "T=10", unitRealSeconds: 1, unitWorldSeconds: 1,
  realMsUntil: (at: number) => at > 10 ? 60_000 : 0 };

async function fixture(first: ParsedToolCall, options: { down?: boolean; channel?: boolean; sendGate?: Promise<void>;
  ignoreSendDuration?: boolean; second?: (context: BotContext) => ParsedToolCall } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "phone-decision-order-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files); await context.load();
  const cfg = Config({ autoStart: false });
  Object.assign(cfg.bot, { minIntervalMs: 0, maxWindowChars: 1_000_000, spillMinChars: 0, ignoreSendDuration: options.ignoreSendDuration ?? true });
  cfg.bot.growth.enabled = false; cfg.messaging.sendEcho = false;
  const defs = BOT_TOOLS.filter(tool => ["pick_up_phone", "put_down_phone", "open_app", "close_app", "send", "select_channel", "think", "cancel"].includes(tool.name));
  const phone = { down: options.down ?? false }, apps = new AppManager("chat", [], new Set(defs.map(tool => tool.name)), logger);
  let sends = 0, completedSends = 0;
  const navigation: string[] = [];
  const messenger: any = {
    resolveKey: async (key: string) => { navigation.push(`resolve:${key}`); return { key, isPrivate: true }; },
    recentChannels: async () => { navigation.push("chat-home"); return { text: "fixture channel list" }; },
    channelMessages: async () => { navigation.push("channel"); return { text: "fixture messages" }; }, putDownPhone: async () => "已停止留意频道，通知设置不变。",
    sendReceipt: async () => { sends++; await options.sendGate; completedSends++; return { text: "fixture platform confirmed message", status: "sent", messageIds: ["fixture-message"] }; },
  };
  const bot: any = new BotAgent(cfg, clock, files, context, {} as any, messenger, apps, null, null, phone, logger, defs);
  agents.push(bot);
  if (options.channel) bot.phoneUi = { chatOpen: true, channelKey: "onebot@fixture:private:peer", channelIsGroup: false, forwardStack: [] };
  if (!phone.down) bot.attention = "phone";
  const requests: any[][] = [];
  bot.backend = {
    setToolNames() {}, setToolDefs() {},
    generate: async () => {
      requests.push(structuredClone(await context.toChatMessages("T=10", false)));
      if (requests.length === 1) return first;
      if (requests.length === 2 && options.second) return options.second(context);
      bot.setManualPaused(true);
      return { name: "think", arguments: { thought: "下一步已经看到了真实结果。" } };
    },
  };
  return { bot, context, phone, requests, navigation, sends: () => sends, completedSends: () => completedSends };
}

async function pickupReceiptPrecedesNextDecision() {
  const f = await fixture({ name: "pick_up_phone", arguments: {}, duration: 30 }, { down: true });
  f.bot.start(); await until(() => f.requests.length === 2); await f.bot.stop();
  assert.equal(f.phone.down, false);
  const receipt = f.context.stream.find(entry => entry.kind === "event" && entry.event.source === "tool" && entry.event.refToolCallId);
  assert.ok(receipt?.kind === "event");
  assert.ok(JSON.stringify(f.requests[1]).includes(receipt.event.content), "next generated decision sees the actual pickup receipt, not only an acceptance notice");
  assert.equal(f.bot.scheduler.pendingCount, 0, "the completed phone gesture does not keep a duration timer");
  assert.ok(!f.context.stream.some(entry => entry.kind === "event" && entry.event.refToolCallId === receipt.event.refToolCallId && /期望完成时刻/.test(entry.event.content)),
    "an immediate UI result is not announced with a fictional future completion time");
}

async function futureTypingRemainsCancellable() {
  const f = await fixture({ name: "send", arguments: { msg: "A complete fixture message which is still being typed." }, duration: 3 }, {
    channel: true, ignoreSendDuration: false,
    second: context => {
      const send = context.stream.find(entry => entry.kind === "tool_call" && entry.call.name === "send");
      assert.ok(send?.kind === "tool_call");
      return { name: "cancel", arguments: { id: send.call.id } };
    },
  });
  f.bot.config.bot.strictToolLoop = false; // Opt-in concurrent decisions may still cancel their own future send.
  f.bot.start(); await until(() => f.requests.length === 3); await f.bot.stop();
  assert.equal(f.sends(), 0, "typing may be cancelled before any platform submission");
  assert.equal(f.bot.scheduler.pendingCount, 0);
  assert.ok(JSON.stringify(f.requests[2]).includes("你及时停下了"));
}

async function takeoverCancellationIsVisibleAfterHandback() {
  const f = await fixture({ name: "send", arguments: { msg: "Another complete fixture message still being typed." }, duration: 3 },
    { channel: true, ignoreSendDuration: false });
  f.bot.config.bot.strictToolLoop = false; // Exercise legacy typing-time generation; strict mode is covered separately.
  f.bot.start(); await until(() => f.requests.length === 2);
  const send = f.context.stream.find(entry => entry.kind === "tool_call" && entry.call.name === "send");
  assert.ok(send?.kind === "tool_call");
  const pending = (id: string, role: "agent" | "system", name: string) => ({ id, role, name, arguments: {}, issuedAt: 10, expectedAt: 20 });
  for (const call of [pending("world-tail", "agent", "act"), pending("hidden-human", "system", "read_note")]) {
    f.bot.operationCalls.set(call.id, call);
    f.bot.scheduler.schedule(call, { executeAt: "expected", run: async () => "must not execute" });
  }
  f.bot.stealthCalls.add("hidden-human");
  await f.bot.acquireManualControl();
  assert.equal(f.bot.operationCalls.size, 0);
  f.bot.setManualPaused(false); await until(() => f.requests.length === 3); await f.bot.stop();
  const cancellation = f.context.stream.find(entry => entry.kind === "event" && entry.event.refToolCallId === send.call.id && /已取消/.test(entry.event.content));
  assert.ok(cancellation?.kind === "event");
  assert.deepEqual(cancellation.event.originEventIds, []);
  assert.match(cancellation.event.content, /尚未提交.*没有发出/);
  assert.ok(JSON.stringify(f.requests[2]).includes(cancellation.event.content), "handback sees a final cancellation outcome, not only the old acceptance");
  const worldCancellation = f.context.stream.find(entry => entry.kind === "event" && entry.event.refToolCallId === "world-tail");
  assert.ok(worldCancellation?.kind === "event");
  assert.match(worldCancellation.event.content, /已发生的结果不撤销/);
  assert.deepEqual(worldCancellation.event.originEventIds, []);
  assert.ok(!f.context.stream.some(entry => entry.kind === "event" && entry.event.refToolCallId === "hidden-human"));
  assert.equal(f.sends(), 0);
}

async function sendMustFinishBeforeNextDecision() {
  const sending = gate();
  const f = await fixture({ name: "send", arguments: { msg: "fixture hello" } }, { channel: true, sendGate: sending.promise });
  f.bot.start(); await until(() => f.sends() === 1);
  await sleep(20);
  assert.equal(f.requests.length, 1, "no put-down or other next decision is generated before platform confirmation");
  assert.equal(f.bot.autonomousDispatch, null, "waiting for the result must not own the manual admission fence");
  sending.resolve(); await until(() => f.requests.length === 2); await f.bot.stop();
  assert.ok(JSON.stringify(f.requests[1]).includes("fixture platform confirmed message"));
  assert.equal(f.completedSends(), 1);
}

async function missingSendTargetStillRejected() {
  const f = await fixture({ name: "send", arguments: { msg: "must not pick a recent channel" } });
  // Chat home permits an explicit quick reply, never guessing its recipient.
  f.bot.phoneUi.chatOpen = true; f.bot.lastNotifyKey = "onebot@fixture:private:peer";
  const originalUi = structuredClone(f.bot.phoneUi);
  f.bot.start(); await until(() => f.requests.length === 2); await f.bot.stop();
  assert.equal(f.sends(), 0);
  assert.ok(JSON.stringify(f.requests[1]).includes("缺少目标频道"));
  assert.deepEqual(f.navigation, [], "missing recipients must be rejected before navigating or resolving the recent notification");
  assert.deepEqual(f.bot.phoneUi, originalUi, "rejection does not silently change the current app/channel");
}

async function takeoverDoesNotWaitForOrUndoCommittedSend() {
  const sending = gate();
  const f = await fixture({ name: "send", arguments: { msg: "already submitted" } }, { channel: true, sendGate: sending.promise });
  f.bot.start(); await until(() => f.sends() === 1);
  const control = await Promise.race([f.bot.acquireManualControl(), sleep(500).then(() => { throw new Error("takeover blocked behind a committed device result"); })]);
  assert.equal(control.busy, true);
  assert.equal(f.requests.length, 1);
  sending.resolve(); await until(() => f.completedSends() === 1);
  await f.bot.stop();
  assert.equal(f.completedSends(), 1, "acquiring control preserves an already submitted send");
  assert.equal(f.requests.length, 1);
  assert.ok(f.context.stream.some(entry => entry.kind === "event" && entry.event.content.includes("fixture platform confirmed message")));
}

async function stoppingPreservesInFlightSend() {
  const sending = gate();
  const f = await fixture({ name: "send", arguments: { msg: "submitted before stop" } }, { channel: true, sendGate: sending.promise });
  f.bot.start(); await until(() => f.sends() === 1);
  await Promise.race([f.bot.stop(), sleep(500).then(() => { throw new Error("stop blocked on the device decision barrier"); })]);
  assert.equal(f.completedSends(), 0); assert.equal(f.bot.scheduler.pendingCount, 1);
  sending.resolve(); await until(() => f.bot.scheduler.pendingCount === 0);
  await f.bot.receipts.settled();
  assert.equal(f.completedSends(), 1, "stop releases the generation wait without cancelling a submitted platform operation");
  assert.equal(f.requests.length, 1);
}

async function schedulerWaitsForOneCallOnly() {
  const slow = gate(), receipts: string[] = [];
  const scheduler = new Scheduler(clock, (text, id) => { receipts.push(id!); }, logger);
  const call = (id: string) => ({ id, role: "system" as const, name: "read_note", arguments: {}, issuedAt: 10, expectedAt: 10 });
  scheduler.schedule(call("first"), { executeAt: "now", serialKey: "devices", run: async () => "first receipt" });
  scheduler.schedule(call("human"), { executeAt: "now", serialKey: "devices", run: async () => { await slow.promise; return "human receipt"; } });
  await scheduler.whenSettled("first");
  assert.deepEqual(receipts, ["first"]);
  assert.equal(scheduler.isPending("human"), true, "waiting for one Bot result does not take over another actor's queue slot");
  await scheduler.whenSettled("already-removed");
  slow.resolve(); await scheduler.whenSettled("human");
  scheduler.schedule({ ...call("cancelled"), expectedAt: 20 }, { executeAt: "expected", run: async () => "must not run" });
  const cancelled = scheduler.whenSettled("cancelled");
  assert.equal(scheduler.cancel("cancelled"), "cancelled"); await cancelled;
  scheduler.schedule({ ...call("stopped"), expectedAt: 20 }, { executeAt: "expected", run: async () => "must not run" });
  const stopped = scheduler.whenSettled("stopped"); scheduler.stopAll(); await stopped;
}

async function main() {
  try {
    await pickupReceiptPrecedesNextDecision(); await sendMustFinishBeforeNextDecision(); await missingSendTargetStillRejected();
    await futureTypingRemainsCancellable(); await takeoverCancellationIsVisibleAfterHandback();
    await takeoverDoesNotWaitForOrUndoCommittedSend(); await stoppingPreservesInFlightSend(); await schedulerWaitsForOneCallOnly();
    console.log("PASS phone decision order: actual pickup/send receipts before next inference, unchanged target guards, nonblocking takeover and per-call settlement");
  } finally {
    for (const bot of agents) await bot.stop();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
