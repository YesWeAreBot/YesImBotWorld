/** On-demand OneBot history uses real in-memory persistence and isolated platform/media fixtures. */
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
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("history fixture timed out")), 2500); })]); }
  finally { clearTimeout(timer); }
}
async function fixture() {
  const app = new App(); app.plugin((memory as any).default ?? memory); app.plugin(LocalBot); await app.start();
  const bot = app.bots[0]!, store = new MessageStore(app), config = Config({ autoStart: false });
  config.messaging.offlineHistory = true;
  const controller = new AbortController(), tracked = new Set<Promise<unknown>>();
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  let response: (action: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({ messages: [] });
  (bot as any).internal = { _request: async (action: string, params: Record<string, unknown>) => {
    calls.push({ action, params });
    if (action === "get_group_list") return [{ group_id: "900", group_name: "天文讨论", member_count: 30 }];
    if (action === "get_group_info" && ["900", "901"].includes(String(params.group_id))) return { group_id: params.group_id };
    if (action === "get_stranger_info" && String(params.user_id) === "234") return { user_id: 234 };
    if (action.endsWith("msg_history")) return response(action, params);
    return {};
  } };
  bot.getFriendList = async () => ({ data: [{ id: "234", name: "朋友" }] });
  bot.sendMessage = async () => { throw new Error("history fixture must never send a platform message"); };
  const assets = new Map<number, any>();
  const media = {
    async ingest(url: string, type: string, _mime?: unknown, _extra?: unknown, sticker?: boolean) {
      const id = Number(url.split(":").at(-1));
      assets.set(id, { ref: { id, type, mime: "image/png", file: `/fixture/${id}.png` }, sticker }); return id;
    },
    async get(id: number) { return assets.get(id); },
  };
  const renderer = new MediaRenderer(media as never, { describe: async (ref: any) => `摘要 ${ref.id}` } as never, () => true, 9);
  const names = {
    display: async (key: string) => key,
    identity: async () => ({ platform: "onebot", selfId: "100", accountIds: ["100"], displayName: "我的账号名", text: "此会话使用你的账号 100，显示名为我的账号名。" }),
  };
  const messenger = new KoishiMessenger(app, store, renderer, media as never, {} as never, {} as never, null,
    { focus: async () => {}, activeKeys: () => ["onebot@100:900"] } as never,
    { channelStatusText: () => "通知开启", keys: () => [] } as never,
    config.platformOps, config.messaging, {} as never, new OwnSendTracker(), names as never, () => null,
    { signal: controller.signal, track(task) { tracked.add(task); void task.finally(() => tracked.delete(task)).catch(() => {}); } });
  const historyCalls = () => calls.filter(call => call.action.endsWith("msg_history"));
  const live = (channelId = "900", messageId = "live", content = "刚刚到达的新消息") => store.store({
    platform: "onebot", selfId: "100", channelId, guildId: "", userId: "234", username: "朋友", content,
    messageId, timestamp: new Date(1), self: false, senderOwned: false, isDirect: channelId.startsWith("private:"),
  });
  return { app, bot, store, config, messenger, calls, media, historyCalls, live, controller, tracked,
    setResponse(next: typeof response) { response = next; }, async close() { controller.abort(); await Promise.allSettled([...tracked]); await app.stop(); } };
}
const message = (id: string, sequence: number, time: number, body: unknown, sender = "234") => ({
  message_id: id, message_seq: sequence, time, sender: { user_id: sender, nickname: sender === "100" ? "我的旧群名片" : "朋友" }, message: body,
});

async function discoveryAndCausalOrder() {
  const f = await fixture(), entered = deferred(), release = deferred<unknown>();
  try {
    // This suite exercises explicit channel bootstrap; discovery previews have
    // their own tests and can be disabled independently with preview:false.
    f.config.messaging.offlineHistory = false;
    assert.match((await f.messenger.recentChannels(5)).text, /不表示平台上没有聊天/);
    f.config.platformOps.listGroups = false; f.config.platformOps.listFriends = false;
    assert.doesNotMatch((await f.messenger.recentChannels(5)).text, /list_groups|list_friends/);
    assert.match((await f.messenger.recentChannels(5)).text, /select_channel/);
    f.config.platformOps.listGroups = true;
    assert.match((await f.messenger.recentChannels(5)).text, /list_groups/);
    assert.doesNotMatch((await f.messenger.recentChannels(5)).text, /list_friends/);
    f.config.platformOps.listFriends = true;
    assert.match((await f.messenger.listGroups({ preview: false })).text, /onebot@100:900/);
    assert.match((await f.messenger.listFriends({ preview: false })).text, /onebot@100:private:234/);
    assert.equal(f.historyCalls().length, 0, "metadata-only lists and disabled offline history never import conversations");
    f.config.messaging.offlineHistory = true;
    assert.equal((await f.store.recentChannels(10)).length, 0);
    assert.deepEqual(await f.messenger.syncOfflineHistory(f.controller.signal), { total: 0, channels: [] });
    assert.equal(f.historyCalls().length, 0, "startup cannot resurrect an empty/reset conversation");
    f.setResponse(async () => { entered.resolve(); return release.promise; });
    const reading = f.messenger.channelMessages("onebot@100:900", 10);
    await bounded(entered.promise);
    assert.equal(f.tracked.size, 1, "service stop barrier owns the pending history import");
    await f.live();
    release.resolve({ messages: [message("old-2", 102, 1, "后来的旧消息"), message("old-1", 101, 9999999999, "先前旧消息")] });
    const result = await bounded(reading);
    assert.match(result.text, /按需补入 2 条.*这是回读/);
    assert.ok(result.text.indexOf("先前旧消息") < result.text.indexOf("后来的旧消息"));
    assert.ok(result.text.indexOf("后来的旧消息") < result.text.indexOf("刚刚到达的新消息"));
    const rows = await f.store.channelMessages("onebot", "900", 10, "100");
    assert.deepEqual(rows.map(row => row.messageId), ["old-1", "old-2", "live"]);
    assert.deepEqual(rows.slice(0, 2).map(row => row.orderSource), ["history-unanchored", "history-unanchored"]);
    assert.equal(rows.at(-1)!.orderSource, "live");
    const ids = rows.map(row => row.id), roots = result.originEventIds;
    const reread = await f.messenger.channelMessages("onebot@100:900", 10, { intro: "read" });
    assert.equal(f.historyCalls().length, 1); assert.deepEqual(reread.originEventIds, roots);
    assert.deepEqual((await f.store.channelMessages("onebot", "900", 10, "100")).map(row => row.id), ids);
    assert.equal(result.experience?.agency, "observed"); assert.equal(result.experience?.chat?.kind, "attention");
  } finally { release.resolve({ messages: [] }); await f.close(); }
}

async function privateHistoryAndMultimodalIdentity() {
  const f = await fixture();
  try {
    f.setResponse(async () => ({ messages: [
      message("self", 1, 2, "自己先前说的话", "100"),
      message("reply", 2, 1, [
        { type: "reply", data: { id: "self" } }, { type: "text", data: { text: "先发这个" } },
        { type: "image", data: { url: "fixture:1", sub_type: 1 } },
        { type: "text", data: { text: "再发照片" } }, { type: "image", data: { url: "fixture:2", sub_type: 0 } },
      ]),
    ] }));
    const rich = await f.messenger.channelMessages("onebot@100:private:234", 10);
    assert.deepEqual(f.historyCalls(), [{ action: "get_friend_msg_history", params: { user_id: 234, message_seq: 0, count: 10 } }]);
    const rows = await f.store.channelMessages("onebot", "private:234", 10, "100");
    assert.equal(rows[0]!.senderOrigin, "unknown"); assert.equal(rows[0]!.senderOwned, true);
    assert.match(rich.text, /我的旧群名片.*当前会话使用的你的账号.*具体操作者未知/);
    assert.equal(rows[1]!.isDirect, true); assert.equal(rows[1]!.conversation?.kind, "direct");
    assert.equal(rows[1]!.conversation?.reply?.userId, "100", "a reply to an earlier message in the same imported page resolves its actual sender");
    const media = rich.parts!.filter(part => part.kind === "media");
    assert.deepEqual(media.map(part => [part.ref.id, !!part.sticker]), [[1, true], [2, false]]);
    assert.deepEqual(rich.attachments?.map(ref => ref.id), [1, 2]);
    assert.match(media[0]!.observedMessage!.originEventIds[0]!, /chat-message:/);
    assert.ok(rich.text.indexOf("先发这个") < rich.text.indexOf("media:1"));
    assert.ok(rich.text.indexOf("media:1") < rich.text.indexOf("再发照片"));
    assert.ok(rich.text.indexOf("再发照片") < rich.text.indexOf("media:2"));
  } finally { await f.close(); }
}

async function unavailableIsNotAnEmptyConversation() {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.config.messaging.offlineHistory = false;
    assert.match((await f.messenger.channelMessages("onebot@100:900", 10)).text, /历史补拉已关闭/);
    assert.equal(f.historyCalls().length, 0);
    f.config.messaging.offlineHistory = true;
    await f.messenger.channelMessages("onebot@100:900", 10, { intro: "echo" });
    assert.equal(f.historyCalls().length, 0, "sending readback cannot bootstrap history");
    f.setResponse(async () => { entered.resolve(); await release.promise; throw new Error("fixture unsupported history API"); });
    const reading = f.messenger.channelMessages("onebot@100:900", 10);
    await bounded(entered.promise); await f.live(); release.resolve();
    const rich = await bounded(reading);
    assert.match(rich.text, /平台历史暂时不可读取.*unsupported/);
    assert.match(rich.text, /刚刚到达的新消息/);
    assert.equal(f.historyCalls().length, 1);
    await f.messenger.channelMessages("onebot@100:900", 10);
    assert.equal(f.historyCalls().length, 1, "reading existing local content remains usable without remote history");
    f.setResponse(async () => ({ unsupported: true }));
    const empty = await f.messenger.channelMessages("onebot@100:901", 10);
    assert.match(empty.text, /不代表.*发生过聊天/); assert.match(empty.text, /可能不支持该接口/);
    await f.messenger.channelMessages("onebot@100:901", 10);
    assert.equal(f.historyCalls().length, 2, "an empty unsupported endpoint is briefly debounced rather than hit every loop");
  } finally { release.resolve(); await f.close(); }
}

async function resetBarrierCancelsReadsAndJoinsWrites() {
  for (const stage of ["platform", "import"] as const) {
    const f = await fixture(), entered = deferred(), release = deferred();
    try {
      f.setResponse(async () => {
        if (stage === "platform") { entered.resolve(); await release.promise; }
        return { messages: [message("late", 1, 1, "不能污染下一世界")] };
      });
      if (stage === "import") {
        const original = f.store.importHistory.bind(f.store);
        f.store.importHistory = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
      }
      const reading = f.messenger.channelMessages("onebot@100:900", 10);
      const rejected = assert.rejects(reading, { name: "AbortError" });
      await bounded(entered.promise); f.controller.abort();
      let joined = false;
      const joining = Promise.allSettled([...f.tracked]).then(() => { joined = true; });
      await turn();
      assert.equal(joined, stage === "platform", "external reads can abort immediately; admitted DB imports must join");
      release.resolve(); await bounded(Promise.all([rejected, joining]));
      await f.store.clear(); await turn(); await turn();
      assert.equal((await f.store.channelMessages("onebot", "900", 10, "100")).length, 0);
      assert.equal(f.historyCalls().length, 1);
    } finally { release.resolve(); await f.close(); }
  }
}

async function main() {
  await discoveryAndCausalOrder(); await privateHistoryAndMultimodalIdentity(); await unavailableIsNotAnEmptyConversation(); await resetBarrierCancelsReadsAndJoinsWrites();
  console.log("PASS channel discovery/history: no bulk imports, explicit empty group/private reads, sender/media order, causal dedup, unsupported/local fallback, switch/echo semantics and reset read/write barrier");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
