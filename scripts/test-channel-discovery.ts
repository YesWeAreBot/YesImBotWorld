/** Bounded discovery uses real message storage; no model or platform sends are involved. */
import assert from "node:assert/strict";
import { App, Bot, Universal } from "koishi";
import memory from "@koishijs/plugin-database-memory";
import { Config } from "../src/config.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { MessageStore } from "../src/koishi/messages.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { MediaRenderer } from "../src/media/render.js";

class LocalBot extends Bot {
  dispose() { if (this.ctx.bots) return super.dispose(); }
  constructor(ctx: App) { super(ctx, {}); this.platform = "onebot"; this.selfId = "100"; this.status = Universal.Status.ONLINE; }
}
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("discovery test timed out")), 2500); })]); }
  finally { clearTimeout(timer); }
}
const message = (id: string, sequence: number, body: unknown, sender = "234") => ({
  message_id: id, message_seq: sequence, time: sequence + 100, sender: { user_id: sender, nickname: sender === "100" ? "账号旧群名" : "天文爱好者" }, message: body,
});
const next = (text: string) => {
  const match = /下一页：list_(?:groups|friends)\(([^\n]+)\)。/.exec(text);
  assert.ok(match, "the actual result must expose a usable next-page cursor");
  return JSON.parse(match[1]!);
};
async function fixture() {
  const app = new App(); app.plugin((memory as any).default ?? memory); app.plugin(LocalBot); await app.start();
  const bot = app.bots[0]!, store = new MessageStore(app), config = Config({ autoStart: false });
  config.messaging.offlineHistory = true;
  config.platformOps.listGroups = true; config.platformOps.listFriends = true;
  const controller = new AbortController(), tracked = new Set<Promise<unknown>>();
  const calls: { action: string; params: Record<string, unknown> }[] = [], friendPages: (string | undefined)[] = [];
  let captionCalls = 0, focused = 0;
  const groups = Array.from({ length: 12 }, (_, index) => ({ group_id: String(900 + index), group_name: `社团${index}`, member_count: index + 10 }));
  let list = async () => groups;
  let history = async (_action: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = String(params.group_id ?? params.user_id);
    return { messages: [message(`${id}-3`, 3, `会话${id}的最近话题`), message(`${id}-2`, 2, `会话${id}的上一条`), message(`${id}-1`, 1, "更早的内容")] };
  };
  (bot as any).internal = { _request: async (action: string, params: Record<string, unknown>) => {
    calls.push({ action, params });
    if (action === "get_group_list") return list();
    if (action.endsWith("msg_history")) return history(action, params);
    return {};
  } };
  bot.getFriendList = async cursor => {
    friendPages.push(cursor);
    return cursor === "after-first" ? { data: [{ id: "236", name: "第三位朋友" }] }
      : { data: [{ id: "234", name: "第一位朋友" }, { id: "235", name: "第二位朋友" }], next: "after-first" };
  };
  bot.sendMessage = async () => { throw Error("discovery must not send messages"); };
  const assets = new Map<number, any>();
  const media = { async ingest(url: string, type: string, _mime?: unknown, _proxy?: unknown, sticker?: boolean) {
    const id = Number(url.split(":").at(-1)); assets.set(id, { ref: { id, type, mime: "image/png", file: `/fixture/${id}.png` }, sticker }); return id;
  }, async get(id: number) { return assets.get(id); } };
  const renderer = new MediaRenderer(media as never, { describe: async () => { captionCalls++; return "已展开的图片"; } } as never, () => true, 9);
  const names = { display: async (key: string) => key, identity: async () => ({ platform: "onebot", selfId: "100", accountIds: ["100"], displayName: "当前账号群名", text: "你在本会话使用账号100，群名为当前账号群名。" }) };
  const messenger = new KoishiMessenger(app, store, renderer, media as never, {} as never, {} as never, null,
    { focus: async () => { focused++; }, activeKeys: () => [] } as never,
    { channelStatusText: () => "通知开启", keys: () => [] } as never,
    config.platformOps, config.messaging, {} as never, new OwnSendTracker(), names as never, () => null,
    { signal: controller.signal, track(task) { tracked.add(task); void task.finally(() => tracked.delete(task)).catch(() => {}); } });
  const historyCalls = () => calls.filter(call => call.action.endsWith("msg_history"));
  const live = (id = "900", content = "本机刚收到的消息") => store.store({ platform: "onebot", selfId: "100", channelId: id,
    guildId: "", userId: "234", username: "天文爱好者", content, messageId: "live", timestamp: new Date(1), self: false, senderOwned: false, isDirect: id.startsWith("private:") });
  return { app, bot, store, config, messenger, groups, calls, friendPages, historyCalls, controller, tracked, live,
    counters: () => ({ captionCalls, focused }), setHistory(value: typeof history) { history = value; }, setList(value: typeof list) { list = value; },
    async close() { controller.abort(); await Promise.allSettled([...tracked]); await app.stop(); } };
}

async function boundedPagesAndStableEvidence() {
  const f = await fixture();
  try {
    const page = await f.messenger.listGroups();
    assert.equal(f.calls.filter(call => call.action === "get_group_list").length, 1);
    assert.equal(f.historyCalls().length, 2, "a twelve-group directory must not cause twelve history requests");
    assert.ok(f.historyCalls().every(call => call.params.count === 3));
    assert.match(page.text, /社团4/); assert.doesNotMatch(page.text, /社团5/);
    assert.match(page.text, /会话900的最近话题/); assert.match(page.text, /会话901的最近话题/);
    assert.match(page.text, /历史预览不是新通知/); assert.match(page.text, /平台时间/);
    assert.match(page.text, /暂无本地可读片段/);
    assert.equal(page.originEventIds!.length, 4);
    assert.ok(page.originEventIds!.every(id => id.startsWith("chat-message:")));
    assert.equal(page.parts!.filter(part => part.observedMessage).length, 4);
    assert.equal((await f.store.recentChannels(20)).length, 2);
    assert.deepEqual(f.counters(), { captionCalls: 0, focused: 0 }, "discovery neither focuses a channel nor calls media summarization");
    const again = await f.messenger.listGroups({ limit: 2 });
    assert.deepEqual(again.originEventIds, page.originEventIds);
    assert.equal(f.historyCalls().length, 2, "cached previews do not replay the same history requests");
    assert.equal(f.calls.filter(call => call.action === "get_group_list").length, 1);
    const second = await f.messenger.listGroups(next(page.text));
    assert.match(second.text, /社团5/); assert.match(second.text, /社团9/); assert.doesNotMatch(second.text, /社团10/);
    assert.equal(f.historyCalls().length, 4);
    const third = await f.messenger.listGroups({ ...next(second.text), preview: false });
    assert.match(third.text, /社团10/); assert.match(third.text, /社团11/); assert.match(third.text, /末页/);
    assert.equal(f.historyCalls().length, 4); assert.deepEqual(third.originEventIds, []);
    const before = f.calls.length;
    assert.match((await f.messenger.listGroups({ cursor: "forged:5" })).text, /已失效/);
    assert.equal(f.calls.length, before);
    await assert.rejects(f.messenger.listGroups({ limit: 11 }), /1—10/);
    await assert.rejects(f.messenger.listGroups({ limit: 1.5 }), /1—10/);
  } finally { await f.close(); }
}

async function automaticColdDiscoveryAndFriends() {
  const f = await fixture();
  try {
    const initial = await f.messenger.recentChannels(5);
    assert.match(initial.text, /本地最近没有.*群发现列表/s);
    assert.match(initial.text, /会话900的最近话题/);
    assert.equal(f.historyCalls().length, 2, "check_msg can offer a real lead without the model already choosing list_groups");
    const known = await f.messenger.recentChannels(5);
    assert.match(known.text, /按页发现其他会话/);
    assert.equal(f.historyCalls().length, 2);
  } finally { await f.close(); }
  const friends = await fixture();
  try {
    friends.config.platformOps.listGroups = false;
    const initial = await friends.messenger.recentChannels(5);
    assert.match(initial.text, /好友发现列表/); assert.match(initial.text, /onebot@100:private:234/);
    assert.deepEqual(friends.friendPages, [undefined], "do not automatically fetch the next upstream friend page");
    assert.deepEqual(friends.historyCalls().map(call => call.action), ["get_friend_msg_history", "get_friend_msg_history"]);
    const nextPage = await friends.messenger.listFriends(next(initial.text));
    assert.deepEqual(friends.friendPages, [undefined, "after-first"]);
    assert.match(nextPage.text, /第三位朋友/); assert.match(nextPage.text, /末页/);
    assert.equal(friends.historyCalls().length, 3);
    const replay = await friends.messenger.listFriends({ limit: 2 });
    assert.match(replay.text, /第一位朋友/); assert.equal(friends.historyCalls().length, 3);
  } finally { await friends.close(); }
}

async function mediaIdentityAndCausalOrder() {
  const f = await fixture();
  try {
    f.setHistory(async () => ({ messages: [
      message("own", 1, "我先前提过的问题", "100"),
      message("pics", 2, [{ type: "reply", data: { id: "own" } }, { type: "at", data: { qq: "100" } },
        { type: "text", data: { text: "先这个" } }, { type: "image", data: { url: "fixture:1", sub_type: 1 } },
        { type: "text", data: { text: "再看照片" } }, { type: "image", data: { url: "fixture:2", sub_type: 0 } }]),
      message("same-account", 3, "这个由同账号发出但操作者未知", "100"),
    ] }));
    const preview = await f.messenger.listGroups({ limit: 1 });
    assert.match(preview.text, /先这个\[表情包\]再看照片\[图片\]/);
    assert.match(preview.text, /引用本账号的消息/); assert.match(preview.text, /明确 @ 本账号/);
    assert.match(preview.text, /账号旧群名.*当前会话使用的你的账号.*具体操作者未知/);
    assert.equal(preview.attachments, undefined); assert.ok(preview.parts!.every(part => part.kind === "text"));
    assert.equal(f.counters().captionCalls, 0);
    const full = await f.messenger.channelMessages("onebot@100:900", 10);
    assert.deepEqual(full.parts!.filter(part => part.kind === "media").map(part => [part.ref.id, !!part.sticker]), [[1, true], [2, false]]);
    assert.ok(preview.originEventIds!.every(id => full.originEventIds!.includes(id)), "opening a discovery card reuses the same message identities");
    assert.deepEqual(f.historyCalls().map(call => call.params.count), [3, 10], "opening a small preview may read a fuller page once; the 3-row preview cannot suppress it");
    await f.messenger.channelMessages("onebot@100:900", 10);
    assert.equal(f.historyCalls().length, 2, "repeated full reads reuse their own larger history limit");
  } finally { await f.close(); }
  const race = await fixture();
  try {
    const ready = deferred(), done = deferred();
    race.setHistory(async () => { ready.resolve(); await done.promise; return { messages: [message("old-1", 1, "先前历史"), message("old-2", 2, "稍后历史")] }; });
    const reading = race.messenger.listGroups({ limit: 1 });
    await bounded(ready.promise); await race.live(); done.resolve();
    const result = await bounded(reading);
    assert.ok(result.text.indexOf("稍后历史") < result.text.indexOf("本机刚收到的消息"));
    assert.deepEqual((await race.store.channelMessages("onebot", "900", 10, "100")).map(row => row.messageId), ["old-1", "old-2", "live"]);
  } finally { await race.close(); }
}

async function failuresAndOfflineSwitch() {
  const f = await fixture();
  try {
    f.config.messaging.offlineHistory = false;
    assert.match((await f.messenger.listGroups()).text, /历史补拉已关闭/);
    assert.match((await f.messenger.listFriends()).text, /历史补拉已关闭/);
    assert.equal(f.historyCalls().length, 0);
    await f.live(); f.config.messaging.offlineHistory = true;
    await f.app.database.set("yesimbot_world_message", { messageId: "live" }, { observedAt: new Date(1) });
    f.setHistory(async () => { throw Error("fixture history unsupported"); });
    const local = await f.messenger.listGroups({ limit: 1 });
    assert.match(local.text, /本机刚收到的消息/); assert.match(local.text, /unsupported/);
    assert.match(local.text, /不表示会话没有消息/);
    assert.equal(f.historyCalls().length, 1);
    await f.messenger.listGroups({ limit: 1 }); assert.equal(f.historyCalls().length, 1);
  } finally { await f.close(); }
  const failed = await fixture();
  try {
    failed.setList(async () => { throw Error("directory unavailable"); });
    const result = await failed.messenger.listGroups();
    assert.match(result.text, /查看群列表失败.*不能据此判断/); assert.equal(failed.historyCalls().length, 0);
  } finally { await failed.close(); }
}

async function largerReadsJoinSmallPreview() {
  const f = await fixture(), smallEntered = deferred(), smallRelease = deferred(), largeEntered = deferred(), largeRelease = deferred();
  let active = 0, peak = 0;
  try {
    f.setHistory(async (_action, params) => {
      active++; peak = Math.max(peak, active);
      try {
        if (params.count === 3) { smallEntered.resolve(); await smallRelease.promise; }
        if (params.count === 10) { largeEntered.resolve(); await largeRelease.promise; }
        return { messages: [message("same-history", 1, "同一段历史，不能重复入库")] };
      } finally { active--; }
    });
    const preview = f.messenger.listGroups({ limit: 1 });
    await bounded(smallEntered.promise);
    const full = f.messenger.channelMessages("onebot@100:900", 10), fuller = f.messenger.channelMessages("onebot@100:900", 20);
    await turn(); assert.deepEqual(f.historyCalls().map(call => call.params.count), [3]);
    smallRelease.resolve(); await bounded(largeEntered.promise); await turn();
    assert.deepEqual(f.historyCalls().map(call => call.params.count), [3, 10], "two larger readers must not race separate imports behind the same preview");
    largeRelease.resolve(); await bounded(Promise.all([preview, full, fuller]));
    assert.deepEqual(f.historyCalls().map(call => call.params.count), [3, 10, 20]);
    assert.equal(peak, 1);
    assert.equal((await f.store.channelMessages("onebot", "900", 30, "100")).length, 1);
  } finally { smallRelease.resolve(); largeRelease.resolve(); await f.close(); }
}

async function resetJoinsDiscovery() {
  for (const stage of ["directory", "history", "import"] as const) {
    const f = await fixture(), entered = deferred(), release = deferred();
    try {
      if (stage === "directory") f.setList(async () => { entered.resolve(); await release.promise; return f.groups; });
      else f.setHistory(async () => {
        if (stage === "history") { entered.resolve(); await release.promise; }
        return { messages: [message("late", 1, "旧生命周期结果")] };
      });
      if (stage === "import") {
        const original = f.store.importHistory.bind(f.store);
        f.store.importHistory = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
      }
      const task = f.messenger.listGroups({ limit: 1 });
      const rejected = assert.rejects(task, { name: "AbortError" });
      await bounded(entered.promise); f.controller.abort();
      let joined = false;
      const joining = Promise.allSettled([...f.tracked]).then(() => { joined = true; });
      await turn(); assert.equal(joined, stage !== "import");
      release.resolve(); await bounded(Promise.all([rejected, joining]));
      await f.store.clear(); await turn(); await turn();
      assert.equal((await f.store.recentChannels(10)).length, 0);
      assert.equal(f.historyCalls().length, stage === "directory" ? 0 : 1);
    } finally { release.resolve(); await f.close(); }
  }
}

async function main() {
  await boundedPagesAndStableEvidence(); await automaticColdDiscoveryAndFriends(); await mediaIdentityAndCausalOrder(); await failuresAndOfflineSwitch(); await largerReadsJoinSmallPreview(); await resetJoinsDiscovery();
  console.log("PASS channel discovery: bounded lazy pagination/history, cold check_msg leads, actual dated identity/quote/media previews, dedup/causal order, offline/error semantics and reset barriers");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
