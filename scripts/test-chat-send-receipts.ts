/** Sending safety regressions: isolated memory platform, actual scheduler/context, no network. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { BotContext } from "../src/bot/context.js";
import { BotAgent, sendBusyMessage } from "../src/bot/agent.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import type { ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
const gates = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function platformFixture() {
  const cfg = Config({});
  cfg.messaging.coldChannelMsgs = 0; cfg.messaging.selfCommands = false;
  const rows: any[] = [], submitted: any[][] = [];
  const platform: any = { platform: "test", selfId: "self", sendMessage: async (_id: string, elements: any) => {
    submitted.push(Array.isArray(elements) ? elements : [elements]); return [`confirmed-${submitted.length}`];
  } };
  const messenger: any = Object.create(KoishiMessenger.prototype);
  Object.assign(messenger, {
    ctx: { bots: [platform], logger: () => logger }, messaging: cfg.messaging, ops: cfg.platformOps,
    store: { knownChannels: async () => [], channelMessages: async (_p: string, _c: string, n: number) => rows.slice(-n) },
    ownSends: new OwnSendTracker(), focus: { focus: async () => {} }, clockInfo: () => null,
    resolveBot: async () => ({ bot: platform, platform: "test", channelId: "room", isDirect: false }),
    resolveKey: async () => ({ key: "test@self:room", isPrivate: false }),
    storeSelf: async (_target: unknown, content: string, messageId: string) => { rows.push({ self: true, content, messageId }); },
    channelMessages: async () => ({ text: "历史快照" }),
  });
  return { cfg, messenger, rows, submitted, platform };
}

async function platformResults() {
  const f = platformFixture();
  const reject = await f.messenger.sendReceipt("test:room", "<media invalid/>");
  assert.equal(reject.status, "blocked"); assert.equal(f.submitted.length, 0);
  f.messenger.storeSelf = async () => { throw new Error("database failed after confirmation"); };
  f.messenger.focus.focus = async () => { throw new Error("focus failed after confirmation"); };
  const confirmed = await f.messenger.sendReceipt("test:room", "一次就够");
  assert.equal(confirmed.status, "sent"); assert.deepEqual(confirmed.messageIds, ["confirmed-1"]);
  assert.match(confirmed.text, /^消息已发送/); assert.match(confirmed.text, /不要重复发送/);
  assert.doesNotMatch(confirmed.text, /消息没有发出|消息发送失败/);

  const unknown = platformFixture(); let commands = 0;
  unknown.messenger.messaging.selfCommands = true;
  unknown.messenger.tryExecuteSelfCommand = async () => { commands++; };
  unknown.platform.sendMessage = async () => [];
  const missingIds = await unknown.messenger.sendReceipt("test:room", "fortune");
  assert.equal(missingIds.status, "unknown"); assert.equal(unknown.rows.length, 0); assert.equal(commands, 0);
  unknown.platform.sendMessage = async () => { throw new Error("response timed out after upload"); };
  const timedOut = await unknown.messenger.sendReceipt("test:room", "fortune");
  assert.equal(timedOut.status, "unknown"); assert.match(timedOut.text, /不等于消息一定没有送达/); assert.equal(commands, 0);

  const partial = platformFixture(); let call = 0;
  partial.messenger.resolveMediaRef = async () => ({ ref: { id: 1, type: "image" }, sticker: true });
  partial.messenger.mediaElement = async () => h.image("data:image/png;base64,Zg==");
  partial.platform.sendMessage = async () => { call++; if (call === 2) throw new Error("lost acknowledgement"); return ["first-part"]; };
  const split = await partial.messenger.sendReceipt("test:room", '前文 <media ref="media:1"/> 后文');
  assert.equal(split.status, "partial"); assert.deepEqual(split.messageIds, ["first-part"]); assert.equal(call, 2);
  assert.equal(partial.rows.length, 1); assert.match(split.text, /后续 1 批没有提交/);
  console.log("PASS blocked/sent/partial/unknown delivery facts, missing acknowledgements, exact confirmed IDs, no false resend after local failure");
}

async function concurrentColdChannel() {
  const f = platformFixture(); f.cfg.messaging.coldChannelMsgs = 1;
  const entered = gates(), release = gates();
  f.platform.sendMessage = async (_id: string, elements: any[]) => { f.submitted.push(elements); entered.resolve(); await release.promise; return ["first"]; };
  const first = f.messenger.sendReceipt("test:room", "第一个"); await entered.promise;
  const second = f.messenger.sendReceipt("test@self:room", "第二个");
  await tick(); assert.equal(f.submitted.length, 1);
  release.resolve(); assert.equal((await first).status, "sent");
  assert.equal((await second).status, "blocked"); assert.equal(f.submitted.length, 1);
  console.log("PASS canonical account/channel queue rechecks cold-channel history after the previous send settles");
}

async function agentReceipts(base: string) {
  const f = platformFixture(), files = new WorldFiles(base); await files.ensure();
  const context = new BotContext(files, ""); await context.load();
  f.cfg.bot.ignoreSendDuration = true; f.cfg.bot.sendBlocking = false;
  f.cfg.messaging.longMessageChars = 20; f.cfg.messaging.recentRepeatThreshold = 1; f.cfg.messaging.sendEcho = true;
  const clock: any = { now: () => 1, timeLine: () => "T=1", unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: (time: number) => time > 1 ? 1000 : 0 };
  const bot: any = new BotAgent(f.cfg, clock, files, context, {} as any, f.messenger, null, null, null, { down: false }, logger);
  bot.running = true;
  bot.phoneUi = { chatOpen: true, channelKey: "test@self:room", channelIsGroup: true, forwardStack: [] };
  bot.currentToolNames = () => ["send", "cancel"]; bot.refreshToolGate = () => {};
  let seq = 0;
  const make = (msg: string, extra: any = {}): ToolCallRecord => ({ id: `send-check-${++seq}`, name: "send", role: "agent", arguments: { id: "test:room", msg, ...extra }, issuedAt: 1, expectedAt: 1, duration: 0 });
  const perform = async (call: ToolCallRecord) => { await context.appendToolCall(call); bot.dispatchSend(call); await bot.scheduler.whenIdle(); await bot.drainMailbox(); return context.stream.filter((entry: any) => entry.kind === "event" && entry.event.refToolCallId === call.id).map((entry: any) => entry.event.content).join("\n"); };
  try {
    const over = "长".repeat(21);
    assert.match(await perform(make(over)), /正文过长，本次未发送.*confirm_long: true/); assert.equal(f.submitted.length, 0); assert.deepEqual(bot.recentSendSigs, []);
    assert.match(await perform(make(over, { confirm_long: true })), /消息已发送/); assert.equal(f.submitted.length, 1);
    const prefix = await context.toChatMessages("固定起点");
    assert.match(await perform(make(over)), /正文过长，本次未发送/); assert.equal(f.submitted.length, 1);
    const after = await context.toChatMessages("固定起点"); assert.deepEqual(after.slice(0, prefix.length), prefix, "send guards only append, never alter old success receipts");
    assert.match(await perform(make(over, { confirm_long: true, id: "test@self:room" })), /相同内容已发送，本次未重发/);
    assert.equal(f.submitted.length, 1, "channel aliases cannot bypass repetition checks");
    assert.match(await perform(make(over, { confirm_long: true, reply_to: "another-message", at_sender: false })), /相同内容已发送，本次未重发/);
    assert.equal(f.submitted.length, 1, "changing only the quote target or automatic mention cannot bypass repetition checks");

    f.cfg.messaging.coldChannelMsgs = 1;
    const before = bot.recentSendSigs.slice();
    assert.match(await perform(make("被冷频道拦截")), /消息没有发出/); assert.deepEqual(bot.recentSendSigs, before);
    f.rows.push({ self: false, content: "现在有回应了" });
    assert.match(await perform(make("被冷频道拦截")), /消息已发送/); assert.equal(f.submitted.length, 2);
    f.cfg.messaging.coldChannelMsgs = 0;

    // A read-after-write failure in the shared device wrapper must preserve the actual send.
    bot.concealedDevices.add("phone");
    bot.perceiveDeviceChange = async () => { throw new Error("screen refresh failed after send"); };
    f.messenger.channelMessages = async () => { throw new Error("echo unavailable after send"); };
    const truthfulCall = make("已经到达平台"); let confirmedOutcome: any;
    bot.externalToolResults.set(truthfulCall.id, { resolve: (result: any) => { confirmedOutcome = result; } });
    const truthful = await perform(truthfulCall);
    assert.match(truthful, /消息已发送/); assert.match(truthful, /原始|以上发送回执仍有效/); assert.doesNotMatch(truthful, /工具 send 执行失败/);
    assert.equal(confirmedOutcome.ok, true, "the actual scheduler outcome delivered to a cockpit caller remains successful after a screen refresh fails");
    assert.equal(f.submitted.length, 3);

    // Two calls can be accepted before the first finishes, but a duplicate is checked at commit time.
    const first = make("排队的同一句"), second = make("排队的同一句", { id: "test@self:room" });
    await context.appendToolCall(first); await context.appendToolCall(second);
    bot.dispatchSend(first); bot.dispatchSend(second); await bot.scheduler.whenIdle(); await bot.drainMailbox();
    assert.equal(f.submitted.length, 4);

    // Cancelling a different unfinished send does not erase confirmed history.
    f.cfg.bot.ignoreSendDuration = false;
    const pending = make("未提交的消息"); pending.duration = 1; pending.expectedAt = 2;
    await context.appendToolCall(pending); bot.dispatchSend(pending);
    const signatures = bot.recentSendSigs.slice(); bot.dispatchCancel({ id: "cancel-check", arguments: { id: pending.id } });
    assert.deepEqual(bot.recentSendSigs, signatures); assert.equal(f.submitted.length, 4);
    f.cfg.bot.ignoreSendDuration = true;
    const original = f.platform.sendMessage; f.platform.sendMessage = async () => [];
    const unresolved = await perform(make("没有平台回执")); assert.match(unresolved, /送达状态未知/);
    f.platform.sendMessage = original;
    assert.match(await perform(make("没有平台回执")), /上次发送结果未知，可能已送达；本次未重发/); assert.equal(f.submitted.length, 4);
    f.cfg.platformOps.reply = true;
    f.messenger.store.findByMessageId = async () => null;
    assert.match(await perform(make(over, { confirm_long: true, reply_to: "another-message", at_sender: false, resend: true })), /消息已发送/);
    assert.equal(f.submitted.length, 5, "explicit resend may deliberately repeat a previously confirmed message");
    assert.match(sendBusyMessage([make("仍在处理")])!, /可能已经提交到平台/);
    console.log("PASS actual scheduler/context: pre-send length check, confirmed-only signatures, aliases, concurrent duplicates, cancellation, failed screen/echo after success, append-only receipts");
  } finally { await bot.stop(); }
}

async function auxiliarySends() {
  const f = platformFixture();
  f.messenger.galleryStore = { resolve: async () => null };
  f.messenger.resolveMediaRef = async () => ({ ref: { id: 1, type: "image", file: "/isolated.png", mime: "image/png" }, sticker: false });
  f.messenger.media = { readFile: async () => Buffer.from("image"), ingest: async () => { throw new Error("asset store unavailable"); } };
  f.messenger.tts = { speech: async () => ({ data: Buffer.from("voice"), mime: "audio/wav" }) };
  f.messenger.storeSelf = async () => { throw new Error("history unavailable"); };
  f.messenger.focus.focus = async () => { throw new Error("focus unavailable"); };
  assert.match(await f.messenger.sendFile("test:room", "media:1"), /^文件已发送/);
  assert.match(await f.messenger.sendVoice("test:room", "听到就好"), /^语音已发送/);
  f.platform.platform = "onebot"; f.platform.internal = { _request: async () => ({ retcode: 0, data: { message_id: "forwarded" } }) };
  f.messenger.resolveBot = async () => ({ bot: f.platform, platform: "onebot", channelId: "room", isDirect: false });
  assert.match(await f.messenger.forwardMsgs("onebot:room", ["a", "b"]), /合并转发到了.*平台已经确认发送/);
  console.log("PASS file/voice/forward confirmed sends survive media/history/focus bookkeeping failures");
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-send-receipts-"));
  try { await platformResults(); await concurrentColdChannel(); await agentReceipts(dir); await auxiliarySends(); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
