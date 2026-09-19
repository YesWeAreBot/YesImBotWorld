/** Account IDs, platform group cards and immutable historical names. All transport is stubbed. */
import assert from "node:assert/strict";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { Gateway } from "../src/koishi/gateway.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { ChannelNameResolver } from "../src/koishi/names.js";
import { formatMessageSender, messageAccountRelation } from "../src/koishi/identity.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import type { RichText } from "../src/types.js";

async function main() {
  const cfg = Config({ autoStart: false });
  const rows: WorldMessageRow[] = [], notifications: RichText[] = [], selfRows: WorldMessageRow[] = [];
  let card = "群里的新名片", lookups = 0, sends = 0;
  let history: any[] = [], forward: any[] = [];
  const bot = (selfId: string) => ({ platform: "onebot", selfId, isActive: true,
    getGuildMember: async (guild: string, user: string) => { lookups++; assert.equal(user, selfId); return { nick: guild === "unknown" ? "" : card, user: { name: "账号昵称" } }; },
    getUser: async () => ({ name: "账号昵称" }), getChannel: async () => ({ name: "测试群" }),
    sendMessage: async () => [`sent-${++sends}`],
    internal: { _request: async (action: string, params: any) => {
      if (action === "set_group_card") { card = params.card; return {}; }
      if (action === "get_group_msg_history") return { messages: history };
      if (action === "get_forward_msg") return { messages: forward };
      return {};
    } },
  });
  const a = bot("100"), b = bot("200");
  const ctx: any = { bots: [a, b], model: { extend() {} }, on() {}, logger: () => ({ warn() {} }), database: {
    async create(_table: string, row: any) { const value = { id: rows.length + 1, selfId: "", ...row }; rows.push(value); return value; },
    async get(_table: string, query: any, options: any) {
      return rows.filter((row: any) => Object.entries(query).every(([key, value]: [string, any]) => value && typeof value === "object" ? value.$in.includes(row[key]) : row[key] === value))
        .sort((a, b) => (options?.sort?.timelineKey ? String(b.timelineKey ?? "").localeCompare(String(a.timelineKey ?? "")) : 0) || b.timestamp.getTime() - a.timestamp.getTime() || b.id - a.id).slice(0, options?.limit);
    },
    async set(_table: string, query: any, update: any) { Object.assign(rows.find(row => row.id === query.id)!, update); },
  } };
  const store = new MessageStore(ctx), names = new ChannelNameResolver(ctx, store), tracker = new OwnSendTracker();
  const identity = await names.identity("onebot@100:300", { isDirect: false });
  assert.equal(identity.displayName, "群里的新名片"); assert.equal(identity.source, "group_card");
  await names.identity("onebot@100:300", { isDirect: false }); assert.equal(lookups, 1, "repeated reads use cached member identity");
  const base = { platform: "onebot", selfId: "100", channelId: "300", guildId: "", timestamp: new Date(1000), messageId: "old", content: "这是我之前说过的话", userId: "100", username: "旧群名片", self: false, isDirect: false };
  const old = await store.store(base);
  assert.equal(messageAccountRelation(old, identity), "current", "IDs repair display even when a legacy self flag is false");
  assert.match(formatMessageSender(old, identity), /旧群名片.*当前会话使用的你的账号/);
  assert.equal(messageAccountRelation({ ...old, userId: "200", senderOwned: true }, identity), "connected");
  assert.equal(messageAccountRelation({ ...old, selfId: "200", userId: "200" }, identity), "connected", "the row's capture account cannot replace the current conversation's identity");
  assert.equal(messageAccountRelation({ ...old, platform: "other", selfId: "100", userId: "100" }, identity), "historical");
  assert.equal(messageAccountRelation({ ...old, userId: "300", self: true } as any, identity), "unknown", "self flags and identical names do not establish identity");
  assert.equal(messageAccountRelation({ ...old, platform: "other", selfId: "else", userId: "100" }, identity), "unknown", "same numeric ID on another platform is not the same identity");
  assert.match(formatMessageSender({ ...old, username: "（我）" }, identity), /昵称未记录/);
  const renderer: any = { render: async (text: string) => ({ text, parts: [{ kind: "text", text }] }) };
  const focus: any = { focus: async () => {}, isFocused: () => true };
  const messaging = { ...cfg.messaging, coldChannelMsgs: 0, selfCommands: false, externalSelfMessages: "event" as const };
  const messenger = new KoishiMessenger(ctx, store, renderer, {} as any, {} as any, {} as any, null, focus,
    { channelStatusText: () => "频道通知：开启" } as any, cfg.platformOps, messaging, {} as any, tracker, names, () => null);
  const read = await messenger.channelMessages("onebot@100:300", 10);
  assert.match(read.text, /当前群名片为 "群里的新名片"/);
  assert.match(read.text, /发送者：旧群名片.*当前会话使用的你的账号/);
  assert.doesNotMatch(read.text, /消息正文”内是对方的话/);
  assert.equal(old.username, "旧群名片", "new names never rewrite stored history");
  assert.match(JSON.stringify(read.parts), /旧群名片/);

  const phone = { down: false };
  const gateway: any = new Gateway(ctx, messaging, cfg.platformOps, store, {} as any, renderer, focus,
    { isNotifyChannel: () => true, channelStatusText: () => "频道通知：开启" } as any, phone, {} as any, tracker, names, () => null,
    { notify(value) { notifications.push(value); }, channelActivity() {}, selfMessage(_key, _rich, _id, _args, sender) { if (sender) selfRows.push(sender); } });
  const incoming = (extra: any = {}) => ({ platform: "onebot", selfId: "100", bot: a, channelId: "300", guildId: "300", isDirect: false,
    userId: "peer", username: "账号昵称", timestamp: Date.now(), messageId: "incoming", elements: h.parse("正文"),
    event: { member: { nick: "该群名片" }, user: { name: "账号昵称" } }, ...extra });
  await gateway.handle(incoming());
  assert.equal(rows.at(-1)!.username, "该群名片"); assert.match(notifications.at(-1)!.text, /发送者：该群名片/);
  await gateway.handle(incoming({ userId: "200", messageId: "other-owned", event: { member: { nick: "另一账号群名片" } } }));
  assert.equal(rows.at(-1)!.self, false); assert.match(notifications.at(-1)!.text, /另一账号群名片.*你的另一连接账号/);
  assert.equal(selfRows.length, 0, "another connection remains an observed message, never recursively simulated as this account's send");
  const ownedB = rows.at(-1)!;
  assert.equal(ownedB.senderOwned, true);
  ctx.bots = [a];
  const withoutB = await names.identity("onebot@100:300", { isDirect: false });
  assert.equal(messageAccountRelation(ownedB, withoutB), "historical");
  assert.match(formatMessageSender(ownedB, withoutB), /你当时连接的账号/);
  assert.match((await messenger.channelMessages("onebot@100:300", 10)).text, /另一账号群名片.*你当时连接的账号/);
  await gateway.handle(incoming({ userId: "200", messageId: "b-not-registered" }));
  const unregisteredB = rows.at(-1)!;
  assert.equal(unregisteredB.senderOwned, false);
  ctx.bots = [a, b];
  const withB = await names.identity("onebot@100:300", { isDirect: false });
  assert.equal(messageAccountRelation(unregisteredB, withB), "other");
  assert.match(formatMessageSender(unregisteredB, withB), /记录时未登记/);
  assert.doesNotMatch(formatMessageSender(unregisteredB, withB), /你的另一连接账号/);
  assert.equal(messageAccountRelation({ ...unregisteredB, senderOwned: null }, withB), "unknown");
  assert.match(formatMessageSender({ ...unregisteredB, senderOwned: null }, withB), /历史账号归属未记录/);
  assert.equal(ownedB.senderOwned, true, "connection changes never rewrite existing ownership facts");

  // Put-down during an awaited identity lookup may not leak name/body/attachments.
  let lookupStarted!: () => void, releaseLookup!: () => void;
  const started = new Promise<void>(resolve => { lookupStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseLookup = resolve; });
  const originalLookup = a.getGuildMember;
  a.getGuildMember = async (guild, user) => { lookupStarted(); await release; return originalLookup(guild, user); };
  const pendingNotice = gateway.handle(incoming({ channelId: "slow", guildId: "slow", messageId: "phone-down-race", elements: h.parse("这段正文不可泄露") }));
  await started; phone.down = true; releaseLookup(); await pendingNotice;
  assert.equal(notifications.at(-1)!.text, "放在一边的手机震了一下。");
  assert.equal(notifications.at(-1)!.parts, undefined); assert.equal(notifications.at(-1)!.attachments, undefined);
  assert.doesNotMatch(JSON.stringify(notifications.at(-1)), /这段正文|该群名片|slow|peer/);
  assert.ok(notifications.at(-1)!.originEventIds!.every(id => id.startsWith("chat-notice:")));
  a.getGuildMember = originalLookup; phone.down = false;
  await gateway.handle(incoming({ userId: "100", messageId: "external-self", event: { member: { nick: "外部端显示名片" } } }));
  assert.equal(selfRows.at(-1)!.username, "外部端显示名片"); assert.equal(selfRows.at(-1)!.senderOrigin, "external");
  await gateway.handle(incoming({ messageId: "reply", quote: { id: "old", user: { id: "100", name: "不应覆写旧署名" }, content: "这是我之前说过的话" } }));
  assert.match(rows.at(-1)!.content, /旧群名片.*当前会话使用的你的账号/);
  assert.doesNotMatch(rows.at(-1)!.content, /不应覆写旧署名/);
  const count = rows.length;
  await gateway.handle(incoming({ userId: "100", selfId: "200", messageId: "mismatched-account" }));
  await gateway.handle(incoming({ userId: "100", platform: "other", messageId: "mismatched-platform" }));
  assert.equal(rows.length, count, "conflicting adapter identity must not be stored under a different account");

  // Actual confirmed tool path stores the observed name without claiming voluntary intent.
  await messenger.sendReceipt("onebot@100:300", "工具发送正文");
  assert.equal(sends, 1); assert.equal(rows.at(-1)!.senderOrigin, "tool"); assert.equal(rows.at(-1)!.username, "群里的新名片");
  const beforeChange = lookups;
  await messenger.setGroupCard("onebot@100:300", "修改后的名片");
  const changed = await names.identity("onebot@100:300", { isDirect: false });
  assert.equal(changed.displayName, "修改后的名片"); assert.ok(lookups > beforeChange); assert.equal(old.username, "旧群名片");
  await messenger.setGroupCard("onebot@100:300", "（我）");
  await messenger.sendReceipt("onebot@100:300", "真实名片恰好是旧占位字面");
  const literalName = rows.at(-1)!;
  assert.equal(literalName.username, "（我）");
  const literalIdentity = await names.identity("onebot@100:300", { isDirect: false });
  assert.match(formatMessageSender(literalName, literalIdentity), /^（我）（平台/);
  await gateway.handle(incoming({ messageId: "literal-card-quote", quote: { id: literalName.messageId, user: { id: "100", name: "不能代替真实记录" }, content: literalName.content } }));
  assert.match(rows.at(-1)!.content, /name="（我）（平台/);
  assert.doesNotMatch(rows.at(-1)!.content, /不能代替真实记录/);
  const fallback = await names.identity("onebot@100:unknown", { isDirect: false });
  assert.equal(fallback.source, "account_name"); assert.match(fallback.text, /群名片未取得/);

  const t = Math.floor(Date.now() / 1000) * 1000;
  await store.store({ ...base, channelId: "history", timestamp: new Date(t - 1000), messageId: "anchor" });
  history = [{ time: t / 1000, message_id: "history-own", message_seq: 10, sender: { user_id: "100", card: "当时群名片", nickname: "账号昵称" }, message: "历史正文" },
    { time: t / 1000, message_id: "history-fallback", message_seq: 11, user_id: "peer", sender: { card: "", nickname: "真实回退昵称" }, message: "另一个正文" }];
  assert.equal(await (messenger as any).syncGroupHistory("onebot", "history", "100"), 2);
  assert.equal(rows.find(row => row.messageId === "history-own")!.username, "当时群名片");
  assert.equal(rows.find(row => row.messageId === "history-own")!.senderOrigin, "unknown");
  assert.equal(rows.find(row => row.messageId === "history-fallback")!.username, "真实回退昵称");
  assert.equal(rows.find(row => row.messageId === "history-fallback")!.userId, "peer");

  ctx.bots = [a];
  forward = [{ sender: { user_id: "100", card: "转发内旧名片", nickname: "账号昵称" }, content: "旧转发正文" },
    { sender: { user_id: "peer", card: "", nickname: "转发内旧名片" }, content: "同名另一个人" },
    { sender: { user_id: "100", card: "本账号" }, content: "转发里的真实字面名片" }];
  const forwarded = await messenger.viewForward("forward-id");
  assert.match(forwarded.text, /转发内旧名片（平台 "onebot"；账号 "100"；当前会话使用的你的账号/);
  assert.match(forwarded.text, /转发内旧名片（平台 "onebot"；账号 "peer"；历史账号归属未记录/);
  assert.match(forwarded.text, /不证明.*亲自发出/);
  assert.match(forwarded.text, /转发内署名：本账号（平台/);
  assert.deepEqual((await store.channelMessages("onebot", "300", 100, "100")).find(row => row.id === old.id), old);
  console.log("PASS account-scoped sender identity, current group card, honest unknowns, immutable names, notifications, echo, quotes, forwarding and tool provenance");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
