/** Group metadata is observed platform data, independent of nickname or body.
 * All adapters/storage below are local fixtures; no running service is contacted. */
import assert from "node:assert/strict";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { extractGroupMemberMetadata, sessionGroupMemberMetadata } from "../src/koishi/group-metadata.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { Gateway } from "../src/koishi/gateway.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { ChannelNameResolver } from "../src/koishi/names.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";

async function main() {
  assert.deepEqual(extractGroupMemberMetadata({ sender: { role: "owner", title: "开荒团长", level: "71" } }),
    { role: "owner", specialTitle: "开荒团长", level: "71" });
  assert.deepEqual(extractGroupMemberMetadata({ role: "admin", title: "副团长", level: 0, level_title: "潜水" }),
    { role: "admin", specialTitle: "副团长", levelTitle: "潜水", level: "0" });
  assert.deepEqual(extractGroupMemberMetadata({ role: "member", title: "", level: "6" }),
    { role: "member", specialTitle: "", level: "6" }, "empty awarded title is not an unknown value or a level title");
  assert.deepEqual(extractGroupMemberMetadata({ level: "话唠" }), { level: "话唠" }, "even a nonnumeric level is not silently reclassified as a text title");
  assert.deepEqual(extractGroupMemberMetadata(undefined, { roles: [{ id: "admin" }], specialTitle: "兼任司机", levelTitle: "活跃" }),
    { role: "admin", specialTitle: "兼任司机", levelTitle: "活跃" });
  assert.equal(extractGroupMemberMetadata({ nickname: "群主", card: "管理员", qq_level: 99, title: {}, level: true }), undefined);
  assert.equal(extractGroupMemberMetadata(undefined, { roles: [{ id: "123", name: "admin" }] }), undefined,
    "a custom role name is not evidence of group administrator authority");
  assert.deepEqual(extractGroupMemberMetadata({ role: "member", title: "" }, { role: "owner", title: "后来获得的头衔" }),
    { role: "member", specialTitle: "" }, "raw observation takes precedence over normalized/fallback metadata");

  const raw = { message_type: "group", sender: { user_id: "peer", role: "owner", title: "开荒团长", level: "71" } };
  const session: any = { userId: "peer", isDirect: false, channelId: "group", guildId: "group", event: { _data: raw } };
  assert.deepEqual(sessionGroupMemberMetadata(session), { role: "owner", specialTitle: "开荒团长", level: "71" });
  assert.equal(sessionGroupMemberMetadata({ ...session, isDirect: true }), undefined);
  assert.equal(sessionGroupMemberMetadata({ ...session, channelId: "private:peer" }), undefined);
  assert.equal(sessionGroupMemberMetadata({ ...session, event: { _data: { ...raw, message_type: "private" } } }), undefined,
    "temporary group-associated private sessions remain private");
  assert.equal(sessionGroupMemberMetadata({ ...session, userId: "somebody-else" }), undefined);
  assert.equal(sessionGroupMemberMetadata({ ...session, userId: "somebody-else", event: { _data: raw, member: { roles: [{ id: "owner" }], specialTitle: "旧发起人的头衔" } } }), undefined,
    "when raw author conflicts, an unidentifiable normalized member cannot restore the old sender's titles");
  assert.deepEqual(sessionGroupMemberMetadata({ ...session, userId: "somebody-else", event: { _data: raw, member: { user: { id: "somebody-else" }, roles: [{ id: "admin" }] } } }), { role: "admin" },
    "an independently identified normalized member may still be used");
  for (const conflict of [{ group_id: "other-group" }, { guild_id: "other-group" }, { channel_id: "other-channel" }]) {
    assert.equal(sessionGroupMemberMetadata({ ...session, event: { _data: { ...raw, ...conflict }, member: { user: { id: "peer" }, roles: [{ id: "owner" }] } } }), undefined,
      "a reused payload from another group/channel invalidates its derived member too");
  }
  assert.deepEqual(sessionGroupMemberMetadata({ ...session, event: { _data: { ...raw, group_id: "group", sender: { user_id: "qq-id", tiny_id: "peer", role: "admin" } } } }), { role: "admin" },
    "QQ Guild adapters can expose either of the same sender's explicit user/tiny IDs");
  assert.equal(sessionGroupMemberMetadata({ ...session, event: { member: { user: { id: "somebody-else" }, roles: [{ id: "owner" }] } } }), undefined);
  assert.deepEqual(sessionGroupMemberMetadata({ ...session, event: { member: { user: { id: "peer" }, roles: [{ id: "admin" }] } } }), { role: "admin" });
  assert.equal(sessionGroupMemberMetadata({ userId: "peer", channelId: "unknown", event: { member: { roles: [{ id: "owner" }] } } } as any), undefined);

  const cfg = Config({ autoStart: false });
  const rows: WorldMessageRow[] = [];
  let fields: any;
  const bot: any = { platform: "onebot", selfId: "me", isActive: true,
    getGuildMember: async () => { throw new Error("metadata ingress must not request a profile"); } };
  const ctx: any = { bots: [bot], on() {}, logger: () => ({ warn() {} }), model: { extend(_name: string, schema: any) { fields = schema; } },
    database: {
      async create(_name: string, row: any) { const saved = { id: rows.length + 1, ...row }; rows.push(saved); return saved; },
      async get(_name: string, query: any, options: any) {
        return rows.filter((row: any) => Object.entries(query).every(([key, value]: [string, any]) => value && typeof value === "object" ? value.$in.includes(row[key]) : row[key] === value))
          .sort((a, b) => String(b.timelineKey ?? "").localeCompare(String(a.timelineKey ?? ""))).slice(0, options?.limit);
      },
      async set() { throw new Error("stored historical metadata must not be rewritten"); },
    } };
  const store = new MessageStore(ctx);
  assert.deepEqual(fields.memberMetadata, { type: "json", nullable: true });
  const names: any = { identity: async () => ({ platform: "onebot", selfId: "me", accountIds: ["me"], displayName: "我的群昵称", text: "" }) };
  const gateway: any = new Gateway(ctx, { ...cfg.messaging, externalSelfMessages: "event" }, cfg.platformOps,
    store, {} as any, { render: async (text: string) => ({ text }) } as any,
    { isFocused: () => false } as any, { isNotifyChannel: () => false } as any, { down: false }, {} as any,
    new OwnSendTracker(), names, () => null, { notify() {}, selfMessage() {}, channelActivity() {} });
  const incoming = (extra: any = {}) => ({ platform: "onebot", selfId: "me", bot, userId: "peer", username: "原昵称",
    channelId: "group", guildId: "group", isDirect: false, messageId: "in-1", elements: h.parse("普通正文"),
    event: { _data: raw, member: { nick: "真实群昵称" } }, ...extra });
  const pending = gateway.handle(incoming());
  raw.sender.title = "稍后变更的头衔";
  await pending;
  assert.equal(rows[0]!.username, "真实群昵称");
  assert.equal(rows[0]!.content, "普通正文");
  assert.deepEqual(rows[0]!.memberMetadata, { role: "owner", specialTitle: "开荒团长", level: "71" }, "snapshot is taken before storage/media awaits");
  await gateway.handle(incoming({ messageId: "in-2" }));
  assert.equal(rows[1]!.memberMetadata!.specialTitle, "稍后变更的头衔");
  assert.equal(rows[0]!.memberMetadata!.specialTitle, "开荒团长");
  await gateway.handle(incoming({ messageId: "direct", isDirect: true, channelId: "private:peer" }));
  assert.equal(rows.at(-1)!.memberMetadata, undefined);
  await gateway.handle(incoming({ messageId: "external-self", userId: "me", event: { member: { user: { id: "me" }, nick: "我的群昵称", roles: [{ id: "admin" }], specialTitle: "管理员也有专属称号" } } }));
  assert.deepEqual(rows.at(-1)!.memberMetadata, { role: "admin", specialTitle: "管理员也有专属称号" });
  await gateway.handleConfirmedSelfSent({ bot, channelId: "group", messageId: "command-result", elements: h.parse("指令结果"), session: incoming(), own: false, timestamp: Date.now() });
  assert.equal(rows.at(-1)!.userId, "me");
  assert.equal(rows.at(-1)!.memberMetadata, undefined, "an invoked command cannot borrow its invoker's owner title for the account's reply");
  const duplicate = await store.store({ ...rows[0]!, memberMetadata: { role: "member", specialTitle: "今日的新值" } });
  assert.equal(duplicate.memberMetadata!.specialTitle, "开荒团长", "duplicate capture does not rewrite message-time facts");

  // Reuse the profile request already needed for our group nickname. Satori may
  // preserve extension titles; standard NapCat exposes roles only. No extra API.
  let profileCalls = 0;
  let profile: any = { nick: "我的真实名片", user: { id: "me", name: "账号名字" }, roles: [{ id: "owner" }], specialTitle: "兼任厨师", levelTitle: "传说", level: 9 };
  bot.getGuildMember = async () => { profileCalls++; return profile; };
  bot.getUser = async () => ({ id: "me", name: "账号名字" });
  const resolver = new ChannelNameResolver(ctx, store);
  const identity = await resolver.identity("onebot@me:group", { isDirect: false });
  assert.deepEqual(identity.memberMetadata, { role: "owner", specialTitle: "兼任厨师", levelTitle: "传说", level: "9" });
  assert.doesNotMatch(identity.text, /owner|兼任厨师|传说|<sender/, "identity preamble must not bypass per-field presentation settings");
  const messenger: any = Object.create(KoishiMessenger.prototype);
  Object.assign(messenger, { store, names: resolver });
  await messenger.storeSelf({ bot, platform: "onebot", channelId: "group", isDirect: false }, "自己的新消息", "tool-title-1");
  const firstOwn = rows.at(-1)!;
  assert.equal(firstOwn.username, "我的真实名片");
  assert.deepEqual(firstOwn.memberMetadata, identity.memberMetadata);
  assert.notEqual(firstOwn.memberMetadata, identity.memberMetadata, "persisted new send owns its snapshot rather than referencing the profile cache");
  assert.equal(profileCalls, 1, "no additional metadata/member request when the existing identity cache is usable");
  profile = { nick: "名片仍是我", user: { id: "me" }, roles: [{ id: "admin" }] };
  resolver.invalidateIdentity("onebot", "me", "group");
  await messenger.storeSelf({ bot, platform: "onebot", channelId: "group", isDirect: false }, "标准适配器消息", "tool-title-2");
  assert.deepEqual(rows.at(-1)!.memberMetadata, { role: "admin" }, "standard Satori role is usable without inventing dropped titles");
  assert.equal(firstOwn.memberMetadata!.specialTitle, "兼任厨师", "refreshing our profile never backfills or rewrites older sends");
  profile = { nick: "错用户的名片", user: { id: "another-user" }, roles: [{ id: "owner" }], specialTitle: "错用户头衔" };
  resolver.invalidateIdentity("onebot", "me", "group");
  await messenger.storeSelf({ bot, platform: "onebot", channelId: "group", isDirect: false }, "错误缓存必须隔离", "tool-title-3");
  assert.equal(rows.at(-1)!.memberMetadata, undefined);
  assert.equal(rows.at(-1)!.username, "账号名字", "a mismatched member profile cannot contribute a group nickname either");
  const beforePrivate = profileCalls;
  await messenger.storeSelf({ bot, platform: "onebot", channelId: "private:peer", isDirect: true }, "私聊正文", "tool-direct");
  assert.equal(rows.at(-1)!.memberMetadata, undefined);
  assert.equal(profileCalls, beforePrivate, "a private send cannot look up or borrow group metadata");
  console.log("PASS group member metadata: independent roles/titles, honest activity level, immutable ingress and direct/self boundaries.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
