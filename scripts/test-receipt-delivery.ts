/** Actual agent delivery and model projection, using isolated clocks/platform/world stubs. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { BotAgent, type MessageSendReceipt } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean) { for (let i = 0; i < 1000 && !test(); i++) await sleep(2); assert.ok(test(), "receipt fixture did not settle"); }
const dirs: string[] = [], agents: any[] = [];

async function fixture(options: { down?: boolean; world?: any; receipt?: MessageSendReceipt; echo?: boolean; typing?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-receipt-delivery-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files); await context.load();
  const cfg = Config({ autoStart: false });
  Object.assign(cfg.bot, { minIntervalMs: 0, maxWindowChars: 1_000_000, spillMinChars: 0,
    ignoreSendDuration: !options.typing, sendBlocking: false });
  cfg.bot.growth.enabled = false; cfg.messaging.sendEcho = options.echo ?? false;
  const epoch = Date.now();
  const clock: any = { now: () => 10 + (Date.now() - epoch) / 1000, timeLine: () => "fixture time",
    unitRealSeconds: 1, unitWorldSeconds: 1, realMsUntil: (at: number) => Math.max(0, (at - clock.now()) * 1000) };
  const phone = { down: options.down ?? false }, apps = new AppManager("chat", [], new Set(BOT_TOOLS.map(tool => tool.name)), logger);
  let sends = 0;
  const receipt = options.receipt ?? { status: "sent", text: "消息已发送到 fixture@self:peer。", messageIds: ["confirmed"] };
  const messenger: any = {
    resolveKey: async (key: string) => ({ key, isPrivate: true }),
    recentChannels: async () => ({ text: "fixture channel list" }),
    channelMessages: async () => ({ text: "回看记录：对方说的原文。", originEventIds: ["chat:other", ...(receipt.originEventIds ?? [])],
      experience: { agency: "observed", chat: { kind: "attention", channelKey: "fixture@self:peer" } } }),
    putDownPhone: async () => "通知设置不变。",
    sendReceipt: async () => { sends++; return receipt; },
    resolveMediaRefs: async () => [{ ok: true, ref: { id: 7, type: "image" }, sticker: true }],
  };
  const bot: any = new BotAgent(cfg, clock, files, context, options.world ?? {}, messenger, apps, null, null, phone, logger);
  agents.push(bot);
  bot.phoneUi = { chatOpen: true, channelKey: "fixture@self:peer", channelIsGroup: false, forwardStack: [] };
  if (!phone.down) bot.attention = "phone";
  const call = (id: string, name: string, args: Record<string, unknown> = {}, duration = 0): ToolCallRecord => {
    const now = clock.now();
    return { id, role: "agent", name, arguments: args, issuedAt: now, expectedAt: now + duration, duration };
  };
  const events = (): BotEvent[] => context.stream.flatMap(entry => entry.kind === "event" ? [entry.event] : []);
  const messages = () => context.toChatMessages("fixture time", false);
  return { bot, context, files, cfg, clock, call, events, messages, sends: () => sends };
}

async function immediateDeviceResultBeforeNextRequest() {
  const f = await fixture({ down: true });
  const requests: unknown[] = [];
  f.bot.backend = { setToolNames() {}, setToolDefs() {}, generate: async () => {
    requests.push(structuredClone(await f.messages()));
    if (requests.length === 1) return { name: "pick_up_phone", arguments: {}, duration: 30 };
    f.bot.setManualPaused(true);
    return { name: "think", arguments: { thought: "看清当前界面后再决定。" } };
  } };
  f.bot.start(); await until(() => requests.length === 2); await f.bot.stop();
  const pickup = f.context.stream.find(entry => entry.kind === "tool_call" && entry.call.name === "pick_up_phone");
  assert.ok(pickup?.kind === "tool_call");
  const results = f.events().filter(event => event.refToolCallId === pickup.call.id);
  assert.equal(results.length, 1, "an immediate device action delivers only its actual result");
  assert.equal(results[0]!.source, "tool");
  assert.doesNotMatch(results[0]!.content, /已受理|调用成功|执行成功/);
  assert.ok(JSON.stringify(requests[1]).includes(results[0]!.contextText ?? results[0]!.content));
  assert.equal(f.events().filter(event => event.toolProgress === "pending").length, 0);
  console.log("PASS immediate pickup: actual result precedes the next model request, with no acceptance or success boilerplate");
}

async function pendingOnlyAtDecisionBoundary() {
  const work = gate();
  const f = await fixture({ world: { adjudicateAct: async (_call: unknown, emit: (text: string) => void) => {
    await work.promise; emit("门被推开了，院子里的光照进来。"); return true;
  } } });
  f.bot.running = true;
  const action = f.call("slow-world", "act", { description: "走到门口推开门" });
  await f.context.appendToolCall(action); f.bot.dispatchAct(action);
  await f.bot.drainMailbox(false);
  assert.equal(f.events().filter(event => event.toolProgress === "pending").length, 0, "maintenance before throttling does not announce unfinished work");
  f.bot.manualPaused = true; await f.bot.drainMailbox(true);
  assert.equal(f.events().filter(event => event.toolProgress === "pending").length, 0, "manual control does not insert autonomous progress notices");
  f.bot.manualPaused = false; await f.bot.drainMailbox(true);
  const notices = () => f.events().filter(event => event.refToolCallId === action.id && event.toolProgress === "pending");
  assert.equal(notices().length, 1);
  assert.match(notices()[0]!.content, /正在处理.*结果尚未返回/);
  assert.deepEqual(notices()[0]!.originEventIds, []);
  const prefix = await f.messages();
  await f.bot.drainMailbox(true); await f.bot.drainMailbox(true);
  assert.equal(notices().length, 1, "a pending task is announced once across multiple model boundaries");
  work.resolve(); await f.bot.scheduler.whenIdle(); await f.bot.drainMailbox(true);
  assert.equal(notices().length, 1, "completion never creates another pending notice");
  const after = await f.messages();
  assert.deepEqual(after.slice(0, prefix.length), prefix, "actual completion appends without rewriting the pending request prefix");
  assert.ok(JSON.stringify(after).includes("门被推开了"));

  const fastWork = gate();
  const fast = await fixture({ world: { adjudicateAct: async (_call: unknown, emit: (text: string) => void) => {
    await fastWork.promise; emit("水杯已经放在桌上。"); return true;
  } } });
  fast.bot.running = true;
  const cup = fast.call("between-decisions", "act", { description: "把水杯放到桌上" });
  await fast.context.appendToolCall(cup); fast.bot.dispatchAct(cup);
  await fast.bot.drainMailbox(false);
  fastWork.resolve(); await fast.bot.scheduler.whenIdle(); await fast.bot.drainMailbox(true);
  assert.equal(fast.events().filter(event => event.toolProgress === "pending").length, 0,
    "work completed during throttle only delivers the real result, never an obsolete acceptance");
  assert.ok(JSON.stringify(await fast.messages()).includes("水杯已经放在桌上"));

  const typing = await fixture({ typing: true }); typing.bot.running = true;
  const send = typing.call("future-typing", "send", { id: "fixture@self:peer", msg: "这是一条还在输入的完整消息，稍后会真正提交到平台。" }, 0.3);
  await typing.context.appendToolCall(send); typing.bot.dispatchSend(send);
  await typing.bot.drainMailbox(true); await typing.bot.drainMailbox(true);
  const typingNotices = () => typing.events().filter(event => event.toolProgress === "pending" && event.refToolCallId === send.id);
  assert.equal(typing.sends(), 0); assert.equal(typingNotices().length, 1);
  assert.match(typingNotices()[0]!.content, /尚未提交.*cancel/);
  await typing.bot.scheduler.whenIdle(); await typing.bot.drainMailbox(true);
  assert.equal(typing.sends(), 1); assert.equal(typingNotices().length, 1);
  assert.ok(JSON.stringify(await typing.messages()).includes("消息已发送到"));
  console.log("PASS pending delivery: only at a real decision boundary, once per task, with truthful cancellable typing and no completed/manual-control noise");
}

async function platformOutcomesRemainVisible() {
  const outcomes: MessageSendReceipt[] = [
    { status: "sent", text: "消息已发送到 fixture@self:peer（msg:sent-one）。", messageIds: ["sent-one"], originEventIds: ["chat:sent-one"] },
    { status: "blocked", text: "消息没有发出：当前频道不允许发送。", messageIds: [] },
    { status: "partial", text: "前一批已确认；后一批送达未知，后续批次没有提交。", messageIds: ["part-one"], originEventIds: ["chat:part-one"] },
    { status: "unknown", text: "平台没有返回确认，送达未知；请先查看记录，不要直接重复发送。", messageIds: [] },
    { status: "sent", text: "消息已发送到 fixture@self:peer。注意：本地聊天记录保存失败；不要重复发送。", messageIds: ["warning-one"], originEventIds: ["chat:warning-one"] },
  ];
  for (let i = 0; i < outcomes.length; i++) {
    const receipt = outcomes[i]!;
    const f = await fixture({ receipt, echo: true }); f.bot.running = true;
    const send = f.call(`platform-${i}`, "send", { id: "fixture@self:peer", msg: "这句话只提交一次。" });
    await f.context.appendToolCall(send); f.bot.dispatchSend(send);
    await f.bot.scheduler.whenIdle(); await f.bot.drainMailbox(true);
    assert.equal(f.sends(), 1);
    assert.ok(JSON.stringify(await f.messages()).includes(receipt.text), `${receipt.status} and its warnings remain visible in the actual model request`);
    const actual = f.events().find(event => event.source === "tool" && event.refToolCallId === send.id);
    assert.ok(actual); assert.ok(actual.content.includes(receipt.text));
    assert.ok(!(actual.originEventIds ?? []).includes("chat:other"), "the action receipt cannot acquire old observed message evidence");
    const readback = f.events().find(event => event.source === "koishi");
    if (receipt.status === "blocked") assert.equal(readback, undefined);
    else {
      assert.ok(readback); assert.equal(readback.refToolCallId, undefined);
      assert.equal(readback.experience?.agency, "observed");
      assert.ok(readback.originEventIds?.includes("chat:other"));
      assert.ok(f.events().indexOf(actual) < f.events().indexOf(readback));
      if (receipt.originEventIds) assert.deepEqual(actual.originEventIds, receipt.originEventIds);
    }
  }
  console.log("PASS sent/blocked/partial/unknown/local warning: truthful model-visible outcomes, separate ordered readback and action evidence");
}

async function thoughtAndMediaProjection() {
  const f = await fixture(); f.bot.running = true;
  const text = "明天可以把画好的地图带给朋友看看。";
  const think = f.call("one-thought", "think", { thought: text });
  await f.context.appendToolCall(think); await f.bot.dispatch(think);
  assert.equal(f.bot.pendingToolHelp.has("think"), false, "a successful silent thought is not a usage failure and must not trigger a tutorial");
  await f.bot.drainMailbox(true);
  const confirmation = f.events().find(event => event.refToolCallId === think.id);
  assert.ok(confirmation); assert.match(confirmation.content, /内心独白已记下/);
  assert.equal(confirmation.contextText, "");
  const request = JSON.stringify(await f.messages());
  assert.equal(request.split(text).length - 1, 1, "the thought itself appears once in its assistant call");
  assert.ok(!request.includes(confirmation.content), "the redundant confirmation is omitted only from the model projection");
  const restored = new BotContext(f.files); await restored.load();
  const restoredEvent = restored.stream.find(entry => entry.kind === "event" && entry.event.refToolCallId === think.id);
  assert.ok(restoredEvent?.kind === "event"); assert.equal(restoredEvent.event.contextText, "");
  assert.equal(restoredEvent.event.content, confirmation.content, "raw completion remains durable across reload");

  const pick = f.call("one-selection", "pick_media", { media: ["media:7"] });
  await f.context.appendToolCall(pick); f.bot.dispatchPickMedia(pick);
  await f.bot.scheduler.whenIdle(); await f.bot.drainMailbox(true);
  const selected = f.events().find(event => event.refToolCallId === pick.id);
  assert.ok(selected); assert.match(selected.content, /不创建草稿/);
  assert.match(selected.contextText ?? "", /可用媒体引用（尚未发送）/);
  assert.match(selected.contextText ?? "", /media:7/);
  const projected = JSON.stringify(await f.messages());
  assert.ok(!projected.includes("不创建草稿")); assert.ok(projected.includes("尚未发送"));
  console.log("PASS think/selection projection: complete durable receipts, thought once, media identity and unsent status retained without repeated instructions");
}

async function main() {
  try {
    await immediateDeviceResultBeforeNextRequest(); await pendingOnlyAtDecisionBoundary();
    await platformOutcomesRemainVisible(); await thoughtAndMediaProjection();
  } finally {
    for (const bot of agents) await bot.stop();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
