/** Quote syntax round-trips through actual sends, persisted rows, reads, history and forwards. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { App, Bot, Universal, h } from "koishi";
import memory from "@koishijs/plugin-database-memory";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { MessageStore } from "../src/koishi/messages.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { MediaStore } from "../src/media/store.js";
import { GalleryStore } from "../src/media/gallery.js";
import { MediaRenderer, mediaPlaceholder } from "../src/media/render.js";
import type { ConversationContext } from "../src/koishi/conversation.js";
import type { ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
const SELF = "100", PEER = "234", GROUP = "900", PRIVATE = "private:234";
const key = (channel: string) => `onebot@${SELF}:${channel}`;
const png = (label: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]);
const dataUrl = (label: string) => `data:image/png;base64,${png(label).toString("base64")}`;
const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const quote = (id: string) => `<quote id="${attr(id)}"/>`;
const texts = (elements: h[]) => elements.filter(element => element.type === "text").map(element => element.attrs.content).join("");
class LocalBot extends Bot {
  dispose() { if (this.ctx.bots) return super.dispose(); }
  constructor(ctx: App) { super(ctx, {}); this.platform = "onebot"; this.selfId = SELF; this.status = Universal.Status.ONLINE; }
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-quote-roundtrip-"));
  const app = new App(); app.plugin((memory as any).default ?? memory); app.plugin(LocalBot); await app.start();
  const bot = app.bots[0]!, store = new MessageStore(app), cfg = Config({ autoStart: false });
  cfg.platformOps.reply = true; cfg.messaging.coldChannelMsgs = 0; cfg.messaging.selfCommands = false; cfg.messaging.offlineHistory = false;
  const sent: { channel: string; elements: h[]; id: string }[] = [], calls: { action: string; params: any }[] = [];
  let history: any[] = [], forwards: any[] = [];
  bot.sendMessage = async (channel, content) => { const id = `confirmed-${sent.length + 1}`; sent.push({ channel, elements: h.normalize(content), id }); return [id]; };
  (bot as any).internal = { _request: async (action: string, params: any) => {
    calls.push({ action, params });
    if (action === "get_forward_msg") return { messages: forwards };
    if (action.endsWith("msg_history")) return { messages: history };
    return {};
  } };
  const media = new MediaStore(app, path.join(dir, "assets"), 100_000, logger);
  const gallery = new GalleryStore(app, path.join(dir, "gallery")); await gallery.ensureDirs();
  const captioner: any = { describe: async (_ref: unknown, opts?: { sticker?: boolean }) => opts?.sticker ? "轻松表示收到" : "测试照片" };
  const renderer = new MediaRenderer(media, captioner, () => true, 9);
  const names: any = {
    display: async (id: string) => id,
    identity: async () => ({ platform: "onebot", selfId: SELF, accountIds: [SELF], displayName: "我的群昵称", text: "你的群昵称是我的群昵称。" }),
  };
  const messenger: any = new KoishiMessenger(app, store, renderer, media, captioner, gallery, null,
    { focus: async () => {}, activeKeys: () => [] } as any,
    { channelStatusText: () => "通知开启", keys: () => [], markSeen: async () => {} } as any,
    cfg.platformOps, cfg.messaging, {} as any, new OwnSendTracker(), names, () => null);
  messenger.muteHint = async () => "";
  async function inbound(channel: string, id: string, content: string, conversation?: ConversationContext) {
    await store.store({ platform: "onebot", selfId: SELF, channelId: channel, guildId: channel === PRIVATE ? "" : channel,
      userId: PEER, username: "朋友", messageId: id, content, timestamp: new Date(), self: false,
      senderOwned: false, isDirect: channel === PRIVATE, ...(conversation ? { conversation } : {}) });
  }
  async function rows(channel = PRIVATE) { return store.channelMessages("onebot", channel, 100, SELF); }
  return { dir, app, store, cfg, messenger, sent, media, calls, inbound, rows,
    setHistory(value: any[]) { history = value; }, setForwards(value: any[]) { forwards = value; },
    async close() { await app.stop(); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

async function agentQuoteGuards() {
  const f = await fixture(), files = new WorldFiles(path.join(f.dir, "agent")); await files.ensure();
  const context = new BotContext(files, ""); await context.load();
  f.cfg.bot.ignoreSendDuration = true; f.cfg.bot.sendBlocking = false; f.cfg.bot.growth.enabled = false;
  f.cfg.messaging.longMessageChars = 5; f.cfg.messaging.recentRepeatThreshold = 1; f.cfg.messaging.sendEcho = false;
  const clock: any = { now: () => 1, timeLine: () => "T=1", unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: () => 0 };
  const bot: any = new BotAgent(f.cfg, clock, files, context, {} as any, f.messenger, null, null, null, { down: false }, logger);
  bot.running = true; bot.phoneUi = { chatOpen: true, channelKey: key(PRIVATE), channelIsGroup: false, forwardStack: [] };
  bot.currentToolNames = () => ["send", "cancel"]; bot.refreshToolGate = () => {};
  let serial = 0;
  async function perform(msg: string, replyTo?: string) {
    const call: ToolCallRecord = { id: `quote-guard-${++serial}`, role: "agent", name: "send", arguments: { id: key(PRIVATE), msg, ...(replyTo ? { reply_to: replyTo } : {}) }, issuedAt: 1, expectedAt: 1 };
    const original = structuredClone(call);
    await context.appendToolCall(call); bot.dispatchSend(call); await bot.scheduler.whenIdle(); await bot.drainMailbox();
    const recorded = context.stream.find(entry => entry.kind === "tool_call" && entry.call.id === call.id);
    assert.ok(recorded?.kind === "tool_call"); assert.deepEqual(recorded.call, original, "normalizing an outbound payload never rewrites the appended original tool call");
    return context.stream.flatMap(entry => entry.kind === "event" && entry.event.refToolCallId === call.id ? [entry.event.content] : []).join("\n");
  }
  try {
    const copied = `<quote id="original" name="朋友" text="${"很长的引用预览".repeat(30)}"/> \n 正文`;
    assert.match(await perform(copied, "original"), /消息已发送/, "quote metadata and discarded whitespace cannot trigger the body-length guard");
    assert.equal(f.sent.length, 1); assert.equal(texts(f.sent[0]!.elements), "正文");
    const prefix = await context.toChatMessages("固定前缀");
    assert.match(await perform("正文", "original"), /相同内容已发送，本次未重发/);
    assert.match(await perform(quote("original") + "\n" + quote("original") + "  正文"), /相同内容已发送，本次未重发/);
    assert.equal(f.sent.length, 1, "equivalent quote spellings share one send-repetition signature");
    const after = await context.toChatMessages("固定前缀"); assert.deepEqual(after.slice(0, prefix.length), prefix);
    assert.match(await perform(quote("different") + "冲突正文", "original"), /引用|reply_to/);
    assert.equal(f.sent.length, 1);
  } finally { await bot.stop(); await f.close(); }
}

async function outgoingAndReadback() {
  const f = await fixture(), original = "opaque:message/ABC+def==&trace=7";
  try {
    await f.inbound(PRIVATE, original, "原文"); await f.inbound(GROUP, original, "原文");
    const variants: [string, string | undefined][] = [
      ["正文", original], [quote(original) + " \n\t 正文", undefined], [quote(original) + "  正文", original],
      [quote(original) + "  " + quote(original) + " \n 正文", original],
      [quote("msg:" + original) + "  正文", `(msg:${original})`],
      [`<quote id="${attr(original)}" name="预览署名" text="x > y &quot;abc&quot; &amp; z"/> \n 正文`, original],
      [`<quote id="${attr(original)}" text="旧消息预览 [图片#1]"/> 正文`, original],
    ];
    for (const [body, replyTo] of variants) {
      const before = f.sent.length;
      const result = await f.messenger.sendReceipt(key(PRIVATE), body, [], replyTo);
      assert.equal(result.status, "sent", result.text); assert.equal(f.sent.length, before + 1);
      const actual = f.sent.at(-1)!;
      assert.equal(actual.elements.filter(element => element.type === "quote").length, 1, "parameter and repeated copied tags produce exactly one quote");
      const element = actual.elements.find(element => element.type === "quote")!;
      assert.equal(element.attrs.id, original, "XML attribute escaping preserves the exact opaque platform ID");
      assert.deepEqual(Object.keys(element.attrs), ["id"], "inbound name/text previews are not outgoing platform quote attributes");
      assert.equal(texts(actual.elements), "正文", "removed quote tags leave no leading whitespace or preview text");
      assert.equal(actual.elements.filter(element => element.type === "at").length, 0, "private replies never automatically mention the original sender");
      const stored = (await f.rows()).find(row => row.messageId === actual.id)!;
      assert.equal(stored.content, quote(original) + "正文", "successful sends persist one canonical Koishi quote, no bracket notation or phantom spaces");
      assert.equal(stored.conversation?.reply?.messageId, original);
    }
    const before = f.sent.length;
    for (const [body, replyTo] of [
      [quote("different") + "正文", original], [quote(original) + quote("different") + "正文", undefined],
      ['<quote id="media:4"/>正文', undefined], ['<quote/>正文', original],
      [quote(original) + " \n\t ", original],
    ] as const) assert.equal((await f.messenger.sendReceipt(key(PRIVATE), body, [], replyTo)).status, "blocked");
    assert.equal(f.sent.length, before, "conflicting or invalid reference identities are rejected before transmission");
    const readback = await f.messenger.channelMessages(key(PRIVATE), 100, { intro: "echo" });
    assert.ok(readback.text.includes(quote(original) + "正文")); assert.doesNotMatch(readback.text, /\[引用 msg:|预览署名|x > y/);
    assert.ok(readback.parts.some((part: any) => part.kind === "text" && part.text.includes(quote(original) + "正文")), "ordered model text parts use the same quote representation");
    const group = await f.messenger.sendReceipt(key(GROUP), quote(original) + ' \n <at id="234"/>  群内正文', [], original);
    assert.equal(group.status, "sent", group.text);
    assert.deepEqual(f.sent.at(-1)!.elements.filter(element => element.type === "at").map(element => element.attrs.id), [PEER], "group auto-mention deduplicates a copied sender mention");
    assert.equal(f.sent.at(-1)!.elements.filter(element => element.type === "quote").length, 1);
    assert.equal(texts(f.sent.at(-1)!.elements), " 群内正文", "only the intentional separator after automatic @ remains");
    const withoutAt = await f.messenger.sendReceipt(key(GROUP), quote(original) + " \n 群内正文", [], original, false);
    assert.equal(withoutAt.status, "sent"); assert.equal(f.sent.at(-1)!.elements.filter(element => element.type === "at").length, 0);
    assert.equal(texts(f.sent.at(-1)!.elements), "群内正文");
  } finally { await f.close(); }
}

async function quoteAndMediaOrder() {
  const f = await fixture();
  try {
    const photo = await f.media.ingest(dataUrl("PHOTO"), "image"), sticker = await f.media.ingest(dataUrl("STICKER"), "image", undefined, undefined, true);
    assert.ok(photo && sticker);
    const result = await f.messenger.sendReceipt(key(PRIVATE), `${quote("original")} \n甲<media ref="media:${sticker}"/>乙<media ref="media:${photo}"/>丙`, [], "original");
    assert.equal(result.status, "sent", result.text); assert.equal(f.sent.length, 3);
    const parts = f.sent.flatMap(item => item.elements).map(element => element.type === "text" ? element.attrs.content : element.type === "quote" ? "QUOTE" : element.type === "img" ? (element.attrs.sub_type ?? element.attrs.subType) ? "STICKER" : "PHOTO" : element.type);
    assert.deepEqual(parts, ["QUOTE", "甲", "STICKER", "乙", "PHOTO", "丙"], "quote processing preserves text/sticker/photo positions and batch ordering");
    assert.deepEqual((await f.rows()).map(row => row.content), [quote("original") + "甲", mediaPlaceholder(sticker, "image", true), "乙" + mediaPlaceholder(photo, "image", false) + "丙"]);
    const read = await f.messenger.channelMessages(key(PRIVATE), 100, { intro: "echo" });
    assert.deepEqual(read.parts.filter((part: any) => part.kind === "media").map((part: any) => [part.ref.id, !!part.sticker]), [[sticker, true], [photo, false]]);
    const before = f.sent.length;
    assert.equal((await f.messenger.sendReceipt(key(PRIVATE), `${quote("original")}   <media ref="media:${sticker}"/>`)).status, "sent");
    assert.equal(f.sent.length, before + 1, "quote-only prefixes attach to the sticker batch instead of creating a standalone message");
    assert.deepEqual(f.sent.at(-1)!.elements.map(element => element.type), ["quote", "img"]);
  } finally { await f.close(); }
}

async function legacyProjectionAndPlatformHistory() {
  const f = await fixture(), oldId = "old:reply&key=9";
  const conversation: ConversationContext = { kind: "direct", mentions: [], mentionsEveryone: false, hasText: true, media: [], reply: { messageId: oldId, userId: PEER } };
  try {
    await f.inbound(PRIVATE, "legacy-owned", `[引用 msg:${oldId}]  旧正文`, conversation);
    await f.inbound(PRIVATE, "literal-marker", `[引用 msg:${oldId}]  这是用户真实输入的文字`);
    await f.inbound(PRIVATE, "mismatched-marker", "[引用 msg:another-id]  不应猜测引用", conversation);
    const before = await f.rows();
    const rich = await f.messenger.channelMessages(key(PRIVATE), 100, { intro: "echo" });
    assert.ok(rich.text.includes(quote(oldId) + "旧正文"), "legacy metadata-matched generated prefixes project to Koishi quote tags");
    assert.ok(rich.text.includes(`[引用 msg:${oldId}]  这是用户真实输入的文字`), "literal user text without reply metadata is left untouched");
    assert.ok(rich.text.includes("[引用 msg:another-id]  不应猜测引用"), "a mismatching metadata ID cannot rewrite quoted literal text");
    assert.deepEqual(await f.rows(), before, "read projection never rewrites original database rows");

    f.setForwards([{ sender: { user_id: PEER, nickname: "原发言人" }, time: 1750000000,
      content: [{ type: "reply", data: { id: oldId } }, { type: "text", data: { text: "转发中的引用回复" } }] }]);
    const forward = await f.messenger.viewForward("forward-fixture");
    assert.ok(forward.text.includes(quote(oldId) + "转发中的引用回复"), "OneBot reply segment preserves its original message ID in forwarded content");
    assert.doesNotMatch(forward.text, /\[引用了一条消息\]/);
    assert.ok((forward.parts?.filter((part: any) => part.kind === "text").map((part: any) => part.text).join("") ?? forward.text).includes(quote(oldId)),
      "forward model content uses its text fallback when there are no media parts");

    f.cfg.messaging.offlineHistory = true;
    f.setHistory([{ message_id: "history-quote", message_seq: 1, time: 1750000001, sender: { user_id: PEER, nickname: "历史发言人" },
      message: [{ type: "reply", data: { id: oldId } }, { type: "text", data: { text: "平台补拉正文" } }] }]);
    const history = await f.messenger.channelMessages(key("history-room"), 5);
    assert.ok(f.calls.some(item => item.action === "get_group_msg_history"), "public channel read exercises real bounded platform history import");
    const stored = await f.store.findByMessageId("onebot", "history-room", "history-quote", SELF);
    assert.ok(stored); assert.equal(stored.content, quote(oldId) + "平台补拉正文");
    assert.equal(stored.conversation?.reply?.messageId, oldId); assert.ok(history.text.includes(stored.content));
    assert.doesNotMatch(history.text, /\[引用了一条消息\]/);
  } finally { await f.close(); }
}
async function main() {
  await outgoingAndReadback(); await quoteAndMediaOrder(); await legacyProjectionAndPlatformHistory(); await agentQuoteGuards();
  console.log("PASS quote roundtrip: copyable Koishi tags, parameter/tag deduplication, quoted attributes, opaque IDs, mention semantics, stored/readback/history/forward consistency, legacy read-only projection and ordered multimodal batches");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
