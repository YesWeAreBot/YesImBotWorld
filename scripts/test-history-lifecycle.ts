/** Real in-memory chat store; delayed platform/media fixtures never access the network. */
import assert from "node:assert/strict";
import { App, Bot, Universal } from "koishi";
import memory from "@koishijs/plugin-database-memory";
import { Config } from "../src/config.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { MessageStore } from "../src/koishi/messages.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";

class LocalBot extends Bot {
  dispose() { if (this.ctx.bots) return super.dispose(); }
  constructor(ctx: App) { super(ctx, {}); this.platform = "onebot"; this.selfId = "account"; this.status = Universal.Status.ONLINE; }
}
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("history fixture timed out")), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture() {
  const app = new App(); app.plugin((memory as any).default ?? memory); app.plugin(LocalBot); await app.start();
  const bot = app.bots[0]!, store = new MessageStore(app), config = Config({ autoStart: false }); config.messaging.offlineHistory = true;
  for (const channelId of ["group", "other"]) await store.store({ platform: "onebot", channelId, selfId: "account", guildId: "", userId: "peer", username: "朋友",
    content: "已知消息", timestamp: new Date(1000), self: false, messageId: `anchor-${channelId}`, isDirect: false });
  const media = { ingest: async () => 1 };
  const messenger = new KoishiMessenger(app, store, {} as any, media as any, {} as any, {} as any, null,
    { activeKeys: () => ["onebot@account:group", "onebot@account:other"] } as any, { keys: () => [] } as any,
    config.platformOps, config.messaging, {} as any, new OwnSendTracker(), {} as any, () => null);
  let calls = 0, response: () => Promise<unknown> = async () => ({ messages: [] });
  (bot as any).internal = { _request: async () => { calls++; return response(); } };
  return { app, store, media, messenger, calls: () => calls, setResponse(next: typeof response) { response = next; } };
}
const raw = (message: unknown = "旧世界的离线消息") => ({ messages: [{ message_id: "late-history", message_seq: 2, time: 2, sender: { user_id: "peer" }, message }] });

async function pendingPlatformReadIsAbandoned() {
  const f = await fixture(), controller = new AbortController(), entered = deferred(), reply = deferred<unknown>();
  try {
    f.setResponse(async () => { entered.resolve(); return reply.promise; });
    const job = f.messenger.syncOfflineHistory(controller.signal); await bounded(entered.promise);
    controller.abort(); await bounded(assert.rejects(job, { name: "AbortError" }));
    await f.store.clear(); reply.resolve(raw()); await turn(); await turn();
    assert.equal((await f.store.channelMessages("onebot", "group", 10, "account")).length, 0);
    assert.equal(f.calls(), 1, "no remaining page or channel starts after cancellation");
  } finally { reply.resolve(raw()); await f.app.stop(); }
}

async function pendingMediaReadIsAbandoned() {
  const f = await fixture(), controller = new AbortController(), entered = deferred(), media = deferred<number>();
  let mediaCalls = 0;
  try {
    f.setResponse(async () => raw([{ type: "image", data: { url: "fixture://first" } }, { type: "image", data: { url: "fixture://second" } }]));
    f.media.ingest = async () => { mediaCalls++; entered.resolve(); return media.promise; };
    const job = f.messenger.syncOfflineHistory(controller.signal); await bounded(entered.promise);
    controller.abort(); await bounded(assert.rejects(job, { name: "AbortError" }));
    await f.store.clear(); media.resolve(1); await turn(); await turn();
    assert.equal((await f.store.channelMessages("onebot", "group", 10, "account")).length, 0);
    assert.equal(mediaCalls, 1, "a late media result cannot start the next media read or import");
    assert.equal(f.calls(), 1);
  } finally { media.resolve(1); await f.app.stop(); }
}

async function startedImportIsJoined() {
  const f = await fixture(), controller = new AbortController(), entered = deferred(), release = deferred();
  let imported = 0;
  try {
    f.setResponse(async () => raw());
    const original = f.store.importHistory.bind(f.store);
    f.store.importHistory = async (...args) => { entered.resolve(); await release.promise; const count = await original(...args); imported += count; return count; };
    const job = f.messenger.syncOfflineHistory(controller.signal); await bounded(entered.promise);
    let settled = false;
    const completion = job.then(() => { settled = true; }, error => { settled = true; assert.equal(error.name, "AbortError"); });
    controller.abort(); await turn();
    assert.equal(settled, false, "cancelling an admitted database write cannot claim the worker has stopped");
    release.resolve(); await bounded(completion); assert.equal(imported, 1);
    await f.store.clear(); await turn();
    assert.equal((await f.store.channelMessages("onebot", "group", 10, "account")).length, 0);
    assert.equal(f.calls(), 1);
  } finally { release.resolve(); await f.app.stop(); }
}

async function alreadyAbortedDoesNothing() {
  const f = await fixture(), controller = new AbortController();
  try {
    controller.abort(); await assert.rejects(f.messenger.syncOfflineHistory(controller.signal), { name: "AbortError" });
    assert.equal(f.calls(), 0);
  } finally { await f.app.stop(); }
}

async function main() {
  await pendingPlatformReadIsAbandoned(); await pendingMediaReadIsAbandoned(); await startedImportIsJoined(); await alreadyAbortedDoesNothing();
  console.log("PASS history lifecycle: abort external reads, prevent post-reset imports, join admitted DB writes and skip later channels");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
