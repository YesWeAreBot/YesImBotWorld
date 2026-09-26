/** No devices or networks: delayed opens reproduce the post-dispose connection race. */
import assert from "node:assert/strict";
import { AppManager } from "../src/apps/manager.js";
import type { WorldApp } from "../src/apps/app.js";
import type { RichText } from "../src/types.js";

const logger = { info() {}, warn() {} } as any;
const tools = [{ name: "read", description: "Read screen", inputSchema: { type: "object", properties: {} } }];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("app lifecycle did not settle")), 1500); })]); }
  finally { clearTimeout(timer); }
}

async function shutdownPreventsLateConnection() {
  const entered = deferred(), release = deferred();
  let connected = false, disposed = false, opens = 0, closes = 0, calls = 0, disposalCalls = 0;
  const app: WorldApp = {
    id: "delayed", name: "延迟连接", description: "fixture",
    async open() { opens++; entered.resolve(); await release.promise; connected = true; return { tools, opening: "真实连接已打开" }; },
    async call() { calls++; return "received"; },
    async close() { closes++; connected = false; },
    async dispose() {
      disposalCalls++;
      if (disposed) return; // common idempotent transport dispose
      disposed = true; connected = false;
    },
  };
  let otherStopped = false;
  const other: WorldApp = { ...app, id: "other", name: "另一后台应用", async dispose() { otherStopped = true; } };
  const manager = new AppManager("聊天", [app, other], new Set(), logger);
  const opening = manager.open(app), cancelled = assert.rejects(opening, /已取消/);
  await bounded(entered.promise);
  let stopped = false;
  const stopping = manager.closeAll().then(() => { stopped = true; });
  await turn();
  assert.equal(otherStopped, true, "shutdown interrupts other apps before awaiting one slow open");
  assert.equal(disposed, true); assert.equal(stopped, false, "shutdown joins the pending open");
  assert.equal(manager.currentName, null); assert.equal(manager.screen(), null); assert.deepEqual(manager.activeToolNames(), []);
  await assert.rejects(manager.open(app), /已停止/);
  await assert.rejects(manager.call("read", {}), /已停止/);
  release.resolve(); await bounded(Promise.all([cancelled, stopping]));
  assert.equal(connected, false, "late open is explicitly closed even though the first dispose had already completed");
  assert.ok(closes >= 1); assert.ok(disposalCalls >= 2);
  assert.equal(opens, 1); assert.equal(calls, 0); assert.equal(manager.view(), null);
  await manager.closeAll();
}

async function foregroundCloseAndReopen() {
  const entered = deferred(), release = deferred();
  let first = true, connected = false, disposed = 0;
  const media: RichText = { text: "已缓存图文", parts: [{ kind: "text", text: "已缓存图文" }], originEventIds: ["fixture-image"] };
  const app: WorldApp = {
    id: "browser", name: "浏览器", description: "fixture",
    async open() { if (first) { first = false; entered.resolve(); await release.promise; } connected = true; return { tools, opening: media }; },
    async close() { connected = false; },
    async dispose() { disposed++; connected = false; },
    async call() { return media; },
  };
  const manager = new AppManager("聊天", [app], new Set(), logger);
  const opening = manager.open(app), cancelled = assert.rejects(opening, /已取消/);
  await bounded(entered.promise);
  const closing = manager.closeCurrent();
  release.resolve(); await bounded(Promise.all([cancelled, closing]));
  assert.equal(manager.view(), null); assert.equal(connected, false); assert.equal(disposed, 0, "foreground close does not dispose background devices");
  await manager.open(app); assert.equal(connected, true);
  assert.deepEqual(manager.screen(), media, "multimodal opening stays intact");
  const snapshot = manager.view()!;
  (snapshot.opening as RichText).text = "mutated clone";
  assert.equal(manager.screen()?.text, "已缓存图文");
  await manager.closeCurrent(); assert.equal(disposed, 0);
  await manager.open(app); await manager.closeAll(); assert.equal(disposed, 1);
}

async function callsJoinAndCannotBeginAfterShutdown() {
  const entered = deferred(), release = deferred();
  let count = 0;
  const app: WorldApp = {
    id: "io", name: "本地操作", description: "fixture", async open() { return { tools }; },
    async close() {}, async dispose() {},
    async call() { count++; entered.resolve(); await release.promise; return "accepted result"; },
  };
  const manager = new AppManager("聊天", [app], new Set(), logger);
  await manager.open(app);
  const call = manager.call("read", {}); await bounded(entered.promise);
  let stopped = false;
  const stop = manager.closeAll().then(() => { stopped = true; });
  await turn(); assert.equal(stopped, false, "admitted local writes finish before reset");
  release.resolve(); assert.equal(await call, "accepted result"); await stop;
  assert.equal(manager.view(), null, "late receipts cannot republish a removed screen");
  const next = new AppManager("聊天", [app], new Set(), logger); await next.open(app);
  const queued = next.call("read", {}), denied = assert.rejects(queued, /没有执行/);
  await next.closeAll(); await denied;
  assert.equal(count, 1, "an admitted but not started microtask cannot call an already disposed app");
}

async function cleanupFailuresRemainVisible() {
  const entered = deferred(), release = deferred();
  const app: WorldApp = {
    id: "broken", name: "释放失败", description: "fixture",
    async open() { entered.resolve(); await release.promise; return { tools }; },
    async close() { throw Error("fixture late close failed"); }, async dispose() {}, async call() { return ""; },
  };
  const manager = new AppManager("聊天", [app], new Set(), logger);
  const opening = manager.open(app), denied = assert.rejects(opening, /迟到资源失败/);
  await bounded(entered.promise);
  const stopping = manager.closeAll(), rejected = assert.rejects(stopping, /未能完全释放/);
  release.resolve(); await bounded(Promise.all([denied, rejected]));
  assert.equal(manager.currentName, null);
  const failDispose = new AppManager("聊天", [{ ...app, async open() { return { tools }; }, async close() {}, async dispose() { throw Error("fixture disposal failure"); } }], new Set(), logger);
  await assert.rejects(failDispose.closeAll(), /未能完全释放/);
}

async function main() {
  await shutdownPreventsLateConnection(); await foregroundCloseAndReopen(); await callsJoinAndCannotBeginAfterShutdown(); await cleanupFailuresRemainVisible();
  console.log("PASS AppManager lifecycle: interrupted/late opens, fallback connection release, foreground-only close, permanent shutdown gate, admitted call joins and visible cleanup failures");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
