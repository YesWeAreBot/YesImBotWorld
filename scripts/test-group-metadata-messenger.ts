/** Configurable group profile metadata with isolated OneBot fixtures, no live requests. */
import assert from "node:assert/strict";
import { Config } from "../src/config.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";

function fixture() {
  const config = Config({});
  config.messaging.coldChannelMsgs = 0; config.messaging.selfCommands = false;
  const calls: string[] = [], sent: unknown[] = [];
  let memberOverride: Record<string, unknown> | undefined;
  let listOverride: Record<string, unknown>[] | undefined;
  const members = [
    { user_id: 234, card: "小明", nickname: "小明昵称", role: "member", title: "摸鱼冠军", level: "3", level_title: "冒泡" },
    { user_id: 567, card: "小红", role: "owner", title: "大魔王<&\"", level: "8", level_title: "传说" },
    { user_id: 789, card: "小蓝", role: "admin", title: "资料管理员", level: "7" },
    { user_id: 801, card: "无特殊头衔群主", role: "owner", title: "", level: "8", level_title: "传说" },
    { user_id: 802, card: "无特殊头衔管理", role: "admin", title: "", level: "7", level_title: "传说" },
    { user_id: 803, card: "普通成员", role: "member", title: "", level: "3", level_title: "冒泡" },
    { user_id: 804, card: "数值成员", role: "member", title: "", level: "3" },
    { user_id: 805, card: "身份缺失", title: "", level: "3", level_title: "潜水" },
    { user_id: 806, card: "缺失特殊头衔状态", role: "owner", level: "8", level_title: "传说" },
  ];
  const bot: any = { platform: "onebot", selfId: "100", isActive: true,
    sendMessage: async (_id: string, elements: unknown) => { sent.push(elements); return [`sent-${sent.length}`]; },
    internal: { _request: async (action: string, params: Record<string, unknown>) => {
      calls.push(action);
      if (action === "get_group_member_list") return listOverride ?? members;
      if (action === "get_group_member_info") return memberOverride ?? members.find(member => String(member.user_id) === String(params.user_id));
      throw Error(`Unexpected external request: ${action}`);
    } },
  };
  const messenger: any = Object.create(KoishiMessenger.prototype);
  Object.assign(messenger, {
    ctx: { bots: [bot], logger: () => ({ warn() {} }) }, messaging: config.messaging, ops: config.platformOps,
    resolveOnebotGroup: async () => ({ bot, groupId: "900" }),
    resolveBot: async () => ({ bot, platform: "onebot", channelId: "900", isDirect: false }),
    resolveKey: async () => ({ key: "onebot@100:900", isPrivate: false }),
    store: { knownChannels: async () => [], channelMessages: async () => [] },
    storeSelf: async () => {}, channelMessages: async () => ({ text: "" }),
    focus: { focus: async () => {} }, ownSends: new OwnSendTracker(), clockInfo: () => null,
  });
  return { config, messenger: messenger as KoishiMessenger, calls, sent,
    overrideMember(data: Record<string, unknown> | undefined) { memberOverride = data; },
    overrideList(data: Record<string, unknown>[] | undefined) { listOverride = data; } };
}

async function main() {
  const f = fixture();
  const list = await f.messenger.listMembers("onebot@100:900");
  assert.match(list, /<sender[^>]*group_role="owner"/);
  assert.match(list, /<sender[^>]*group_role="admin"/);
  assert.doesNotMatch(list, /special_title|level_title|level=/);
  assert.doesNotMatch(list, /摸鱼冠军|大魔王|传说|冒泡/);
  assert.ok(list.indexOf("小红") < list.indexOf("小明"), "inline role permits the normal owner-first roster");
  const owner = await f.messenger.memberInfo("onebot@100:900", "567");
  assert.match(owner, /group_role="owner"/);
  assert.match(owner, /title="大魔王&lt;&amp;&quot;"/);
  assert.doesNotMatch(owner, /special_title=|level_title=|level=|传说/);
  assert.match(owner, /群名片：小红/, "metadata does not replace or prefix the person's real group nickname");
  const admin = await f.messenger.memberInfo("onebot@100:900", "789");
  assert.match(admin, /group_role="admin"/); assert.match(admin, /title="资料管理员"/);
  assert.doesNotMatch(admin, /special_title=|level_title=|level=|平台未提供等级头衔文字/, "overridden activity level does not become a second badge or missing-title warning");
  assert.match(await f.messenger.memberInfo("onebot@100:900", "801"), /group_role="owner" title="群主"/);
  assert.match(await f.messenger.memberInfo("onebot@100:900", "802"), /group_role="admin" title="管理员"/);
  assert.match(await f.messenger.memberInfo("onebot@100:900", "803"), /group_role="member" title="冒泡"/);
  const numeric = await f.messenger.memberInfo("onebot@100:900", "804");
  assert.match(numeric, /活动等级：3（平台未提供等级头衔文字；该数值不是头衔）/);
  assert.doesNotMatch(numeric, /title=|level=/, "a numerical activity level is never the displayed title");
  assert.doesNotMatch(await f.messenger.memberInfo("onebot@100:900", "805"), /<sender|潜水/, "a missing role cannot establish that the member sees a gray activity title");
  const missingSpecial = await f.messenger.memberInfo("onebot@100:900", "806");
  assert.match(missingSpecial, /group_role="owner"/);
  assert.doesNotMatch(missingSpecial, /title=|传说/, "missing special-title data must not be mistaken for no special title");

  f.config.messaging.groupMetadata = { role: "hidden", specialTitle: "inline", levelTitle: "hidden" };
  const titles = await f.messenger.listMembers("onebot@100:900");
  assert.match(titles, /title="摸鱼冠军"/); assert.doesNotMatch(titles, /group_role|special_title|level_title|level=/);
  assert.ok(titles.indexOf("小明") < titles.indexOf("小红"), "a hidden role is not leaked through owner-first sorting");
  const hiddenDetail = await f.messenger.memberInfo("onebot@100:900", "789");
  assert.match(hiddenDetail, /title="资料管理员"/);
  assert.doesNotMatch(hiddenDetail, /group_role|level_title|level=|等级头衔/);

  f.config.messaging.groupMetadata = { role: "on_demand", specialTitle: "on_demand", levelTitle: "inline" };
  const levels = await f.messenger.listMembers("onebot@100:900");
  assert.match(levels, /普通成员[^\n]*title="冒泡"/);
  assert.doesNotMatch(levels, /小明[^\n]*<sender/, "on-demand special title does not reveal its overridden gray title inline");
  assert.doesNotMatch(levels, /group_role|special_title|level_title|level=|title="传说"|title="潜水"/);
  assert.match(await f.messenger.memberInfo("onebot@100:900", "567"), /group_role="owner".*title="大魔王/);
  f.config.messaging.groupMetadata = { role: "inline", specialTitle: "hidden", levelTitle: "inline" };
  const overriddenHidden = await f.messenger.memberInfo("onebot@100:900", "567");
  assert.match(overriddenHidden, /group_role="owner"/);
  assert.doesNotMatch(overriddenHidden, /title=|大魔王|传说/, "hiding the winning special title must not reveal lower priority role/gray title text");
  f.config.messaging.groupMetadata = { role: "on_demand", specialTitle: "on_demand", levelTitle: "inline" };
  assert.ok(f.calls.every(action => action === "get_group_member_list" || action === "get_group_member_info"), "no guessed title-mapping API calls");

  for (const mismatch of [{ user_id: "999", group_id: "900" }, { user_id: "567", group_id: "901" }]) {
    f.overrideMember({ ...mismatch, card: "不应泄露的名字", role: "owner", title: "不应泄露的头衔", level: "99" });
    const rejected = await f.messenger.memberInfo("onebot@100:900", "567");
    assert.match(rejected, /资料.*不匹配/);
    assert.doesNotMatch(rejected, /<sender|不应泄露|group_role|special_title|level=/);
  }
  f.overrideMember({ user_id: 567, group_id: 900, card: "小红", role: "owner", title: "同一群的真实头衔" });
  assert.match(await f.messenger.memberInfo("onebot@100:900", "567"), /同一群的真实头衔/, "number and string protocol IDs compare canonically");
  f.overrideMember(undefined);
  f.overrideList([{ group_id: "901", user_id: "999", card: "外群名字", role: "owner", title: "外群头衔" }]);
  const wrongList = await f.messenger.listMembers("onebot@100:900");
  assert.match(wrongList, /资料.*不匹配/); assert.doesNotMatch(wrongList, /外群名字|外群头衔|<sender/);
  f.overrideList([{ group_id: 900, user_id: "567", card: "正确成员", role: "owner" },
    { group_id: 901, user_id: "999", card: "外群名字", role: "owner" }]);
  const filteredList = await f.messenger.listMembers("onebot@100:900");
  assert.match(filteredList, /正确成员/); assert.match(filteredList, /部分资料不属于当前群/); assert.doesNotMatch(filteredList, /外群名字/);
  f.overrideList(undefined);

  const copy = await f.messenger.sendReceipt("onebot@100:900", '<sender user_id="567" group_role="owner" title="大魔王"/>小红你好');
  assert.equal(copy.status, "blocked"); assert.equal(f.sent.length, 0);
  const normal = await f.messenger.sendReceipt("onebot@100:900", '<at id="567"/>你好<face id="14"/>');
  assert.equal(normal.status, "sent"); assert.equal(f.sent.length, 1, "legal platform elements remain sendable");
  console.log("PASS single resolved title with independent role, visibility after precedence, honest missing title data, numerical activity detail and metadata send protection");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
