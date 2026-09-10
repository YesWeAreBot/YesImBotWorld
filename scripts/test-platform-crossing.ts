/** Offline protocol regressions; no HTTP listeners, LLMs, or running worlds.
 * node_modules/.bin/esbuild scripts/test-platform-crossing.ts --bundle --platform=node --format=cjs --alias:koishi="$PWD/node_modules/koishi/lib/index.cjs" --outfile=/tmp/yibw-platform-crossing.cjs
 * node /tmp/yibw-platform-crossing.cjs
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Config } from "../src/config.js";
import { CrossingServer } from "../src/crossing/server.js";
import { CrossingClient } from "../src/crossing/client.js";
import type { CrossingSseMsg } from "../src/crossing/protocol.js";
import type { ToolCallRecord } from "../src/types.js";

const logger = { info() {}, warn() {}, debug() {} };
const config = Config({ autoStart: false });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function until(test: () => boolean) { for (let i = 0; i < 30; i++) { if (test()) return; await tick(); } assert.ok(test(), "asynchronous fixture completed"); }
function observation(actorId: string) { return { observationId: "obs-fixture", actorId, entities: [], utterances: [], sourceEventIds: [], worldSequence: 1, observedAt: 0 }; }

async function hostProtocol() {
  const arrival = gate();
  const messages: CrossingSseMsg[] = [];
  const actors = new Set<string>();
  const actions: { duration: number; taskId: string; options: unknown }[] = [];
  const waitDurations: number[] = [];
  const observed: string[] = [];
  let blocking = false;
  let activeSignal: AbortSignal | undefined;
  const world = {
    residentBotName: "resident",
    wakeDormant: async () => {},
    visitorArrive: async (session: any, deliver: (s: string) => void, signal: AbortSignal) => {
      await arrival.promise;
      signal.throwIfAborted();
      actors.add(session.id);
      deliver("arrived");
      return true;
    },
    visitorAct: async (session: any, _desc: string, duration: number, deliver: (s: string) => void, signal: AbortSignal, taskId: string, options: unknown) => {
      assert.ok(actors.has(session.id), "arrival committed before action");
      activeSignal = signal;
      if (blocking) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      signal.throwIfAborted();
      actions.push({ duration, taskId, options });
      deliver(JSON.stringify(observation("visitor:" + session.id)));
      return true;
    },
    visitorWait: async (_s: any, n: number) => { waitDurations.push(n); return true; },
    visitorLeave: async (session: any) => { actors.delete(session.id); return true; },
    visitorCheckTime: async () => true,
    visitorQuery: async () => "query result",
    structured: { observe: async (id: string) => { observed.push(id); return observation(id); } },
    cancelPending() {}, notePresenceChange() {}, setVisitorsProvider() {},
  };
  const server = new CrossingServer({ cfg: { ...config.crossing, maxVisitors: 4 }, logger, world, ready: () => true, clock: () => ({ unitWorldSeconds: 10, unitRealSeconds: 2, timeLine: () => "T=0" }), notifyHostBot() {} } as never);
  (server as any).push = (_session: any, message: CrossingSseMsg) => messages.push(message);
  async function post(endpoint: string, body: unknown) {
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.url = `/crossing/${endpoint}`; req.method = "POST";
    let status = 0, text = "";
    await (server as any).handle(req, { writeHead(code: number) { status = code; }, end(data: unknown) { text = String(data); } });
    return { status, data: JSON.parse(text) };
  }
  try {
    const arrived = server.arrivePlayer("player", "persona");
    assert.ok(arrived.ok);
    if (!arrived.ok) throw new Error(arrived.error);
    const token = arrived.token;
    const id = server.visitors()[0]!.id;
    const body = { token, taskId: "action-1", kind: "act", payload: { desc: "wave", durationWorldSeconds: 40, speech: "hello", target: "seen-1", observationId: "obs-1" } };
    const accepted = await post("task", body);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.unitWorldSeconds, 10);
    assert.equal(accepted.data.unitRealSeconds, 2);
    await tick(); assert.equal(actions.length, 0);
    arrival.resolve();
    await until(() => actions.length === 1);
    assert.equal(actions[0]!.duration, 4);
    assert.deepEqual(actions[0]!.options, { speech: "hello", target: "seen-1", observationId: "obs-1" });
    assert.equal(server.visitors()[0]!.id, id);
    const duplicate = await post("task", body);
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(actions.length, 1);
    assert.equal((await post("task", { ...body, payload: { desc: "different" } })).status, 409);
    assert.equal((await post("cancel", { token, taskId: "action-1" })).data.status, "too_late");
    await post("task", { token, taskId: "observe-1", kind: "observe", payload: {} });
    await until(() => observed.length === 1);
    assert.equal(observed[0], "visitor:" + id);
    await post("task", { token, taskId: "legacy-wait", kind: "wait", payload: { n: 3 } });
    await until(() => waitDurations.length === 1);
    assert.equal(waitDurations[0], 3);
    assert.equal((await post("task", { token, taskId: "bad-duration", kind: "act", payload: { durationWorldSeconds: -1 } })).status, 400);
    await post("cancel", { token, taskId: "cancel-before-arrival" });
    assert.equal((await post("task", { token, taskId: "cancel-before-arrival", kind: "act", payload: { desc: "late" } })).status, 409);
    blocking = true;
    activeSignal = undefined;
    await post("task", { token, taskId: "inflight", kind: "act", payload: { desc: "pending" } });
    await until(() => !!activeSignal);
    assert.equal((await post("cancel", { token, taskId: "inflight" })).data.status, "cancellation_requested");
    await until(() => messages.some((m) => m.type === "task_result" && m.taskId === "inflight" && !m.ok));
    assert.equal(actions.length, 1);
    activeSignal = undefined;
    await post("task", { token, taskId: "depart-pending", kind: "act", payload: { desc: "pending" } });
    await until(() => !!activeSignal);
    await post("leave", { token });
    assert.ok(activeSignal!.aborted);
    await until(() => actors.size === 0);
    assert.equal(actions.length, 1);
    assert.equal(server.arrivePlayer("npc", "persona", "avatar").ok, false);
    const control = server.arrivePlayer("resident", "persona", "avatar");
    assert.ok(control.ok);
    await tick();
    assert.equal(actors.size, 0);
    assert.equal(server.visitors().length, 0);
    if (control.ok) await post("leave", { token: control.token });
    console.log("PASS: arrival 屏障、稳定访客 ID、世界秒/旧 TU、observe 身份、幂等任务、取消与离开终止事务");
    console.log("PASS: 未实现的 NPC 接管明确拒绝；管理员常驻 Bot 控制不创建重复角色");
  } finally { await server.stop(); }

  const late = gate(); let created = 0;
  const server2 = new CrossingServer({ cfg: config.crossing, logger, ready: () => true, clock: () => null, notifyHostBot() {}, world: {
    ...world,
    visitorArrive: async (_session: any, _deliver: any, signal: AbortSignal) => { await late.promise; signal.throwIfAborted(); created++; return true; },
  } } as never);
  try {
    const r = server2.arrivePlayer("late", "persona"); assert.ok(r.ok);
    await tick();
    const session = (server2 as any).sessions.get(r.ok ? r.token : "");
    (server2 as any).depart(session, "returned");
    late.resolve(); await session.ready; await tick();
    assert.equal(created, 0);
    console.log("PASS: 接待过程中离开会中止 arrival，避免离场后新角色迟到落盘");
  } finally { await server2.stop(); }
}

async function clientProtocol() {
  const events: string[] = [];
  let statusWrites = 0;
  const client = new CrossingClient({ name: "host", url: "http://unused.invalid", inviteCode: "fixture" } as never, { name: "visitor", persona: "persona" }, {
    logger: logger as never, unitWorldSeconds: () => 5, onEvent: (s) => events.push(s), onLost() {}, onStatusUpdate() { statusWrites++; },
  });
  const internal = client as any;
  internal.active = true; internal.token = "fixture"; internal.hostUnitWorldSeconds = 10;
  const posts: { endpoint: string; body: any }[] = [];
  internal.post = async (endpoint: string, body: any) => {
    posts.push({ endpoint, body });
    if (endpoint === "/crossing/task") {
      internal.receiveMessage({ type: "task_result", taskId: body.taskId, ok: true, content: JSON.stringify(observation("visitor:stable")) });
    }
    return { ok: true };
  };
  const call: ToolCallRecord = { id: "remote-1", name: "act", role: "agent", arguments: { description: "wave", speech: "hello", target: "seen", observationId: "obs" }, issuedAt: 0, expectedAt: 4, duration: 4 };
  let fenced = false;
  assert.ok(await client.adjudicateAct(call, () => {}, undefined, () => { assert.equal(posts.length, 0); fenced = true; return true; }));
  assert.ok(fenced);
  assert.equal(posts[0]!.body.payload.durationWorldSeconds, 20);
  assert.equal(posts[0]!.body.payload.duration, 2);
  assert.equal(posts[0]!.body.payload.speech, "hello");
  assert.equal(posts[0]!.body.payload.target, "seen");
  assert.equal(posts[0]!.body.payload.observationId, "obs");
  assert.equal((await client.observe()).actorId, "visitor:stable");
  internal.receiveMessage({ type: "status_update", content: "REMOTE-DESCRIPTION" });
  assert.equal(statusWrites, 0);
  assert.ok(events[0]!.includes("REMOTE-DESCRIPTION"));
  const before = posts.length;
  assert.equal(await client.adjudicateAct({ ...call, id: "blocked" }, () => {}, undefined, () => false), false);
  assert.equal(posts.length, before);
  let cancelRequest = false;
  internal.post = async (endpoint: string, body: any) => {
    posts.push({ endpoint, body });
    if (endpoint === "/crossing/cancel") {
      cancelRequest = true;
      internal.receiveMessage({ type: "task_result", taskId: body.taskId, ok: false, content: "cancelled by host" });
    }
    return { ok: true };
  };
  const abort = new AbortController();
  const pending = client.adjudicateAct({ ...call, id: "cancel-remote" }, () => {}, abort.signal);
  await tick(); abort.abort();
  assert.equal(await pending, false); assert.ok(cancelRequest);
  let failedPosts = 0;
  internal.post = async (endpoint: string) => { if (endpoint === "/crossing/task") { failedPosts++; throw new Error("connection lost"); } return { ok: true }; };
  let unknown = "";
  assert.equal(await client.adjudicateAct({ ...call, id: "unknown" }, (text) => { unknown = text; }), false);
  assert.equal(failedPosts, 1);
  assert.ok(unknown.includes("不会自动重放"));
  await client.leave();
  console.log("PASS: 客户端提交栅栏、参数透传、世界秒换算、状态仅体验事件、远端取消与断线不重放");
}

async function lifecycleProtocol() {
  const action = gate(), leave = gate();
  const actors = new Set<string>(), leaves: string[] = [];
  let runningSignal: AbortSignal | undefined;
  let socketClosed = false;
  const server = new CrossingServer({ cfg: { ...config.crossing, maxVisitors: 4 }, logger, ready: () => true, clock: () => null, notifyHostBot() {}, world: {
    residentBotName: "resident", wakeDormant: async () => {},
    visitorArrive: async (session: any, _deliver: any, signal: AbortSignal) => { signal.throwIfAborted(); actors.add(session.id); return true; },
    visitorAct: async (_session: any, _desc: any, _duration: any, _deliver: any, signal: AbortSignal) => {
      runningSignal = signal;
      // 模拟已进入提交的任务：即使取消，也必须等它真实完成才能离开/换世界。
      await action.promise;
      return true;
    },
    visitorLeave: async (session: any) => { leaves.push(session.name); await leave.promise; actors.delete(session.id); return true; },
    cancelPending() {}, notePresenceChange() {}, setVisitorsProvider() {},
  } } as never);
  const listeningServer = { closeAllConnections() {}, close(done: () => void) { socketClosed = true; done(); } };
  (server as any).server = listeningServer;
  try {
    const first = server.arrivePlayer("already-left", "persona");
    const second = server.arrivePlayer("still-here", "persona");
    assert.ok(first.ok && second.ok);
    const session = (server as any).sessions.get(first.ok ? first.token : "");
    await session.ready;
    const req: any = Readable.from([Buffer.from(JSON.stringify({ token: session.token, taskId: "committing", kind: "act", payload: { desc: "slow commit" } }))]);
    req.url = "/crossing/task"; req.method = "POST";
    await (server as any).handle(req, { writeHead() {}, end() {} });
    await until(() => !!runningSignal);
    (server as any).depart(session, "returned");
    assert.ok(runningSignal!.aborted);
    let drained = false;
    const drain = server.disconnectVisitors("switch world").then(() => { drained = true; });
    assert.equal(server.arrivePlayer("late newcomer", "persona").ok, false);
    await tick();
    assert.equal((server as any).sessions.size, 0);
    assert.equal(drained, false);
    assert.ok(!leaves.includes("already-left"), "leave waits for a task already committing");
    action.resolve();
    await until(() => leaves.includes("already-left"));
    assert.equal(drained, false, "drain also waits for sessions already removed by depart");
    leave.resolve(); await drain;
    assert.equal(actors.size, 0);
    assert.equal((server as any).server, listeningServer, "disconnect keeps the HTTP listener");
    assert.equal(socketClosed, false);
    const third = server.arrivePlayer("stop-cleanup", "persona"); assert.ok(third.ok);
    await tick(); assert.equal(actors.size, 1);
    await server.stop();
    assert.equal(actors.size, 0, "stop drains actor removal before closing listener");
    assert.ok(socketClosed);
    assert.equal(server.arrivePlayer("after-stop", "persona").ok, false);
    console.log("PASS: 世界切换等待已离场会话、提交中任务和 actor 清理；保留监听器，stop 完整关闭");
  } finally { action.resolve(); leave.resolve(); await server.stop(); }
}

async function main() { await hostProtocol(); await clientProtocol(); await lifecycleProtocol(); }
main().catch((error) => { console.error(error); process.exitCode = 1; });
