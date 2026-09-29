import assert from "node:assert/strict";
import { AvatarViewer } from "../src/koishi/avatar.js";
import { availableTools, toolLayer } from "../src/bot/tools.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";

function fixture(options: { native?: boolean; ttl?: number; timeout?: number } = {}) {
  const calls = { member: [] as string[][], user: [] as (string | undefined)[][], ingest: [] as string[], captions: [] as number[] };
  let member: any = { nick: "当前群名片", avatar: "https://images.invalid/group.png", user: { id: "person", name: "账号昵称", avatar: "https://images.invalid/user.png" } };
  let profile: any = { id: "person", name: "账号昵称", avatar: "https://images.invalid/user.png" };
  let mediaId = 10;
  const bot = { platform: "test", selfId: "account", isActive: true,
    getGuildMember: async (guild: string, uid: string) => { calls.member.push([guild, uid]); return typeof member === "function" ? member() : member; },
    getUser: async (uid: string, guild?: string) => { calls.user.push([uid, guild]); return typeof profile === "function" ? profile() : profile; } };
  const ctx = { bots: [bot] };
  let isDirect = false;
  const store = { knownChannels: async () => [{ platform: "test", channelId: "channel", selfId: "account", isDirect }],
    channelMessages: async (platform: string, channel: string, limit: number, self: string) => {
      assert.equal(self, "account"); assert.equal(limit, 1);
      return [{ platform, channelId: channel, guildId: "actual-guild", isDirect }];
    } };
  const media = { ingest: async (url: string, type: string) => { assert.equal(type, "image"); calls.ingest.push(url); return mediaId; },
    get: async (id: number) => ({ ref: { id, type: "image", mime: "image/png", file: `/tmp/avatar-${id}.png` }, sticker: true, summary: "历史普通图片摘要" }) };
  const renderer = { canAttach: () => options.native !== false, maxAttach: 1 };
  const captioner = { describeDetailed: async (ref: { id: number }, usage: any) => { calls.captions.push(ref.id); assert.deepEqual(usage, { sticker: false }); return "可见一片云。"; } };
  const ops = { userInfo: true, memberInfo: true };
  const view = new AvatarViewer(ctx as any, store as any, media as any, renderer as any, captioner as any, ops, options.timeout ?? 100, options.ttl ?? 60_000);
  return { view, calls, ctx, ops, bot, setMember: (value: any) => member = value, setProfile: (value: any) => profile = value,
    setDirect: (value: boolean) => isDirect = value, setMediaId: (value: number) => mediaId = value };
}

async function main() {
  {
    const f = fixture();
    assert.deepEqual(f.calls.ingest, [], "Creating viewer must not fetch or describe everyone's avatar");
    const [one, two] = await Promise.all([f.view.view("test@account:channel", "person"), f.view.view("test@account:channel", "person")]);
    assert.deepEqual(one, two); assert.deepEqual(f.calls.member, [["actual-guild", "person"]]);
    assert.deepEqual(f.calls.user, []); assert.deepEqual(f.calls.ingest, ["https://images.invalid/group.png"]);
    assert.deepEqual(f.calls.captions, [], "Native viewing must not automatically add picture interpretation");
    assert.equal(one.attachments?.[0]?.id, 10); assert.match(one.text, /当前群名片/); assert.match(one.text, /群内头像/);
    assert.match(one.text, /test@account:channel/); assert.match(one.text, /不是此人发来的聊天消息/);
    assert.doesNotMatch(one.text, /历史普通图片摘要|usage="sticker"|账号昵称/);
    const image = one.parts?.find(part => part.kind === "media");
    assert.equal(image?.kind, "media"); if (image?.kind === "media") assert.match(image.name!, /person/);
    await f.view.view("test@account:channel", "person"); assert.equal(f.calls.ingest.length, 1);
  }
  {
    const f = fixture(); f.setMember({ nick: "该群名片", user: { id: "person", name: "账号昵称", avatar: "https://images.invalid/account.png" } });
    const result = await f.view.view("test@account:channel", "person");
    assert.match(result.text, /该群名片/); assert.match(result.text, /未取得单独的群内头像/);
    assert.deepEqual(f.calls.ingest, ["https://images.invalid/account.png"]); assert.equal(f.calls.user.length, 0);
  }
  {
    const f = fixture(); f.setMember({ nick: "别人的群名片", avatar: "https://images.invalid/wrong.png", user: { id: "wrong-user" } });
    const result = await f.view.view("test@account:channel", "person");
    assert.deepEqual(f.calls.user, [["person", "actual-guild"]]); assert.deepEqual(f.calls.ingest, ["https://images.invalid/user.png"]);
    assert.doesNotMatch(result.text, /别人的群名片/);
  }
  {
    const f = fixture(); f.setDirect(true);
    await f.view.view("test@account:channel", "person");
    assert.deepEqual(f.calls.member, []); assert.deepEqual(f.calls.user, [["person", undefined]]);
  }
  {
    const f = fixture(); f.ctx.bots.push({ ...f.bot, selfId: "another" });
    assert.match((await f.view.view("test:channel", "person")).text, /无法确定/); assert.equal(f.calls.member.length, 0);
    assert.match((await f.view.view("test@missing:channel", "person")).text, /无法确定/);
    f.bot.isActive = false; assert.match((await f.view.view("test@account:channel", "person")).text, /未连接/);
  }
  {
    const f = fixture(); f.ops.memberInfo = false;
    assert.match((await f.view.view("test@account:channel", "person")).text, /未开放/);
    assert.equal(f.calls.member.length, 0);
    f.setDirect(true); await f.view.view("test@account:channel", "person"); assert.equal(f.calls.user.length, 1);
    f.ops.userInfo = false; assert.match((await f.view.view("test@account:channel", "person")).text, /未开放/);
  }
  for (const url of ["file:///etc/passwd", "data:image/png,pretend", "javascript:alert(1)", "https://secret:token@images.invalid/avatar.png", "not-a-url"]) {
    const f = fixture(); f.setMember({ nick: "只有名字", avatar: url }); f.setProfile({ id: "person", avatar: url });
    assert.match((await f.view.view("test@account:channel", "person")).text, /没有提供可读取的头像/);
    assert.deepEqual(f.calls.ingest, [], "Unsafe URLs must not enter MediaStore's file/data source support");
  }
  {
    const f = fixture({ native: false }); const result = await f.view.view("test@account:channel", "person");
    assert.deepEqual(f.calls.captions, [10]); assert.equal(result.attachments, undefined); assert.match(result.text, /可见一片云/);
    assert.match(result.text, /本次按需查看/); assert.doesNotMatch(result.text, /usage="sticker"/);
  }
  {
    const f = fixture({ ttl: -1 }); await f.view.view("test@account:channel", "person");
    f.setMediaId(11); f.setMember({ nick: "新的群名片", avatar: "https://images.invalid/changed.png", user: { id: "person" } });
    const next = await f.view.view("test@account:channel", "person");
    assert.equal(next.attachments?.[0]?.id, 11); assert.match(next.text, /新的群名片/); assert.equal(f.calls.member.length, 2);
  }
  {
    const f = fixture({ timeout: 3 }); f.setMember(() => new Promise(() => {}));
    const result = await f.view.view("test@account:channel", "person");
    assert.equal(result.attachments?.[0]?.id, 10); assert.match(result.text, /账号头像/);
  }
  {
    let reads = 0;
    const denied = { resolveKey: async () => ({ error: "（该账号无法确认此频道。）" }), avatars: { view: async () => { reads++; return { text: "不应出现" }; } } };
    const result = await KoishiMessenger.prototype.viewAvatar.call(denied as any, "test@account:unavailable", "person");
    assert.match(result.text, /无法确认/); assert.equal(reads, 0, "Unknown/cross-account channels must fail the real messenger admission before a profile lookup");
    const allowed = { resolveKey: async () => ({ key: "test@account:new-group", isPrivate: false }), avatars: {
      view: async (...args: unknown[]) => { assert.deepEqual(args, ["test@account:new-group", "person", false]); return { text: "平台已确认的新群" }; },
    } };
    assert.match((await KoishiMessenger.prototype.viewAvatar.call(allowed as any, "test:new-group", "person")).text, /平台已确认/);
  }
  assert.equal(toolLayer("view_avatar"), "chat");
  assert.equal(availableTools({ tts: false, ops: { userInfo: false, memberInfo: false } as any }).some(tool => tool.name === "view_avatar"), false);
  assert.equal(availableTools({ tts: false, ops: { userInfo: false, memberInfo: true } as any }).some(tool => tool.name === "view_avatar"), true);
  console.log("PASS explicit avatar viewing: correct account/guild/user identity, adapter-only URLs, group/account provenance, bounded cache, native/no unsolicited caption, on-demand text fallback and permission gates");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
