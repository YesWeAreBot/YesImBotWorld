/** Role control regressions. In-memory models/platforms and temporary files only. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { AppManager } from "../src/apps/manager.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { CrossingServer } from "../src/crossing/server.js";
import { WorldFiles } from "../src/files.js";
import { WorldService } from "../src/service.js";
import { WebUIServer } from "../src/webui/server.js";

const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(test: () => boolean) { for (let i = 0; i < 1000 && !test(); i++) await tick(); assert.ok(test(), "fixture reached expected lifecycle boundary"); }

async function fixture(dir: string) {
  const files = new WorldFiles(dir); await files.ensure();
  const cfg = Config({ autoStart: false }); cfg.bot.ignoreSendDuration = true;
  const clock: any = { now: () => 1, timeLine: () => "T=1", realMsUntil: (n: number) => n > 1 ? 60000 : 0, unitWorldSeconds: 10, unitRealSeconds: 1 };
  const actions: any[] = [], schemas = { type: "object", properties: { data: { type: "array", items: { type: "number" } } }, required: ["data"] };
  let opened = 0, sent = 0, deviceCalls = 0;
  const app = { id: "fixture", name: "fixture", description: "local test app", open: async () => { opened++; return { tools: [{ name: "fixture_input", description: "local fixture input", inputSchema: schemas }] }; }, close: async () => {}, call: async () => { deviceCalls++; return "actual fixture device receipt"; } };
  const defs = BOT_TOOLS.filter(tool => ["act", "observe", "observe_device", "check_status", "check_time", "reflect", "recall_growth", "recall", "wait", "rest", "cancel", "open_app", "close_app", "select_channel", "send", "pick_up_phone", "put_down_phone"].includes(tool.name));
  const apps = new AppManager("chat", [app], new Set(defs.map(tool => tool.name)), logger);
  const observation = { observationId: "obs-fixture", actorId: "bot", entities: [], sourceEventIds: [] };
  const world: any = { residentBotName: "resident", observe: async () => observation, adjudicateAct: async (call: any, deliver: any, signal: AbortSignal, commit: () => boolean) => { signal.throwIfAborted(); if (!commit()) return false; actions.push(call); deliver(JSON.stringify({ action: { status: "completed" }, observation })); return true; } };
  const messenger: any = { recentChannels: async () => ({ text: "cached channels" }), channelMessages: async () => ({ text: "cached messages" }), resolveKey: async () => ({ key: "onebot@fixture:target", isPrivate: true }), send: async () => { sent++; return "sent fixture exactly once"; } };
  const context = new BotContext(files, "");
  const bot: any = new BotAgent(cfg, clock, files, context, world, messenger, apps, null, null, { down: false }, logger, defs);
  bot.running = true; let allowed: string[] = [];
  bot.backend = { setToolNames(names: string[]) { allowed = names; }, setToolDefs() {} }; bot.refreshToolGate();
  const sessions = new Map<string, any>();
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { bot, config: cfg, clock, world, worldActive: true, deviceTail: Promise.resolve(), devicePending: 0, appManager: apps, computerDevice: null, remoteDesktopApp: null, crossingServer: { residentSession: (token: string) => sessions.get(token) ?? null } });
  const enter = async (mode: "avatar" | "puppet", token: string) => { sessions.set(token, { id: token + "-public-id", name: "resident", mode }); return service.acquirePlayerControl(token); };
  return { files, cfg, clock, bot, context, service, sessions, enter, actions, world, schemas, allowed: () => allowed, counts: () => ({ opened, sent, deviceCalls }) };
}

async function semantics(dir: string) {
  const f = await fixture(dir);
  try {
    assert.equal((await f.enter("puppet", "puppet-token")).ok, true);
    assert.equal(f.bot.manualMode, false, "body control preserves autonomous consciousness");
    assert.ok(f.allowed().includes("reflect")); assert.ok(!f.allowed().includes("act"));
    let cockpit = await f.service.playerCockpit("puppet-token");
    assert.equal(cockpit.tools.some((tool: any) => tool.name === "reflect"), false, "human cannot rewrite puppet consciousness");
    assert.deepEqual(cockpit.tools.find((tool: any) => tool.name === "observe").inputSchema.properties.modality.enum, ["all", "sight", "self"]);
    const body = await f.service.botToolCall("act", { description: "raise hand", speech: "hello" }, 0, "puppet-token");
    assert.equal(body.ok, true); assert.ok(body.callId); assert.equal(f.actions.length, 1);
    assert.equal(f.context.stream.filter((entry: any) => entry.kind === "tool_call").length, 0, "puppet input cannot become a voluntary intent");
    assert.ok(f.bot.mailbox.some((event: any) => /非你自主选择/.test(event.content)));
    await f.bot.dispatch({ id: "autonomous-body", role: "agent", name: "act", arguments: { description: "walk" }, issuedAt: 1, expectedAt: 1 });
    assert.equal(f.actions.length, 1, "body controller is an enforced boundary");
    assert.equal((await f.service.botToolCall("reflect", {}, 0, "puppet-token")).ok, false);
    assert.equal((await f.service.deviceControl(true)).ok, false, "device takeover cannot replace role control");
    assert.equal((await f.service.deviceToolCall("open_app", { name: "fixture" }, 0, false, "stealth")).ok, true);
    assert.equal(f.bot.manualMode, false);
    assert.equal(f.context.stream.filter((entry: any) => entry.kind === "tool_call").length, 0, "device UI inherits puppet agency even when it requested stealth");
    cockpit = await f.service.playerCockpit("puppet-token");
    assert.deepEqual(cockpit.tools.find((tool: any) => tool.name === "fixture_input").inputSchema, f.schemas);
    assert.equal((await f.service.releasePlayerControl("puppet-token")).ok, true);
    assert.ok(f.allowed().includes("act"));
    assert.equal((await f.service.botToolCall("act", { description: "stale" }, 0, "puppet-token")).ok, false);

    assert.equal((await f.enter("avatar", "avatar-token")).ok, true); assert.equal(f.bot.manualMode, true);
    assert.equal((await f.service.deviceToolCall("open_app", { name: "chat" }, 0, false, "stealth")).ok, true);
    await f.service.botToolCall("select_channel", { id: "onebot@fixture:target" }, 0, "avatar-token");
    cockpit = await f.service.playerCockpit("avatar-token");
    assert.equal(cockpit.tools.find((tool: any) => tool.name === "send").requiresSendConfirmation, true);
    assert.equal((await f.service.botToolCall("send", { msg: "fixture" }, 0, "avatar-token")).ok, false);
    assert.equal(f.counts().sent, 0);
    assert.equal((await f.service.botToolCall("send", { msg: "fixture" }, 0, "avatar-token", true)).ok, true);
    assert.equal(f.counts().sent, 1);
    assert.ok(f.context.stream.some((entry: any) => entry.kind === "tool_call" && entry.call.name === "send" && entry.call.control?.mode === "avatar"));
    const entries = f.context.stream.filter((entry: any) => entry.kind === "tool_call");
    assert.ok(entries.every((entry: any) => entry.call.control?.sessionId === "avatar-token-public-id"));
    assert.equal((await f.service.releasePlayerControl("avatar-token")).ok, true); assert.equal(f.bot.manualMode, false);
    const audit = (await fs.readFile(path.join(dir, "control-audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(audit.some(record => record.phase === "receipt" && record.control.mode === "puppet" && record.ok));
    assert.ok(audit.some(record => record.phase === "call" && record.call.control.mode === "avatar"));
    assert.ok(!JSON.stringify(audit).includes('"puppet-token"'), "bearer tokens are not stored in audit records");
  } finally { await f.bot.stop(); }
}

async function lifecycles(dir: string) {
  const f = await fixture(dir);
  try {
    await f.enter("avatar", "control");
    // Pending before commit can be cancelled through the exact controller token.
    const entered = gate(), release = gate();
    let committed = 0;
    f.world.adjudicateAct = async (_call: any, deliver: any, signal: AbortSignal, commit: () => boolean) => { entered.resolve(); await release.promise; signal.throwIfAborted(); if (commit()) committed++; deliver("actual commit"); return true; };
    const pending = f.service.botToolCall("act", { description: "pending" }, 0, "control"); await entered.promise;
    const task = (await f.service.playerCockpit("control")).pending[0];
    assert.equal(task.committed, false);
    assert.equal((await f.service.releasePlayerControl("control")).busy, true);
    assert.equal(f.service.cancelPlayerTool("wrong", task.id).ok, false);
    assert.equal(f.service.cancelPlayerTool("control", task.id).status, "cancelled");
    assert.equal((await pending).ok, false); release.resolve(); await tick(); assert.equal(committed, 0);

    const committedStart = gate(), committedFinish = gate();
    f.world.adjudicateAct = async (_call: any, deliver: any, _signal: AbortSignal, commit: () => boolean) => { assert.ok(commit()); committedStart.resolve(); await committedFinish.promise; deliver("committed fixture result"); return true; };
    const active = f.service.botToolCall("act", { description: "irreversible" }, 0, "control"); await committedStart.promise;
    const liveTask = (await f.service.playerCockpit("control")).pending[0];
    assert.equal(f.service.cancelPlayerTool("control", liveTask.id).status, "too_late");
    let lostDone = false; const lost = f.bot.releaseResidentControl("control-public-id", true).then(() => { lostDone = true; });
    await tick(); assert.equal(lostDone, false); assert.equal(f.bot.manualMode, true);
    assert.equal((await f.service.botToolCall("observe", {}, 0, "control")).ok, false);
    committedFinish.resolve(); assert.equal((await active).text, "committed fixture result"); await lost;
    assert.equal(f.bot.manualMode, false);

    // A call waiting for durable context write still owns admission. Losing control cannot execute it later.
    f.service.residentSession = null;
    await f.enter("avatar", "next");
    const writeStarted = gate(), writeDone = gate();
    const original = f.context.appendToolCall.bind(f.context);
    f.context.appendToolCall = async (call: any) => { writeStarted.resolve(); await writeDone.promise; await original(call); };
    let observed = 0; f.world.observe = async () => { observed++; return {}; };
    const beforeDispatch = f.service.botToolCall("observe", {}, 0, "next"); await writeStarted.promise;
    assert.equal((await f.service.botToolCall("observe", {}, 0, "next")).ok, false, "one synchronous admission gate includes persistence");
    const ended = f.bot.releaseResidentControl("next-public-id", true); await tick();
    writeDone.resolve(); assert.equal((await beforeDispatch).ok, false); await ended; assert.equal(observed, 0);

    // A queued acquisition must revalidate its session after an unrelated device operation completes.
    f.service.residentSession = null; const oldDevice = gate(); f.service.deviceTail = oldDevice.promise;
    const queued = f.enter("avatar", "expired"); f.sessions.delete("expired"); oldDevice.resolve();
    assert.equal((await queued).ok, false); assert.equal(f.bot.manualMode, false);
  } finally { await f.bot.stop(); }
}

async function httpAndCrossing(dir: string) {
  const cfg = Config({ autoStart: false }); cfg.webui.token = "fixture-admin";
  let called = 0, consumed = 0; const released: string[] = [];
  const cross: any = new CrossingServer({ cfg: cfg.crossing, logger, ready: () => true, clock: () => ({ timeLine: () => "T=1" }), notifyHostBot() {}, releaseResidentControl: async (id: string) => { released.push(id); }, world: { residentBotName: "resident", structured: { observe: async () => { consumed++; return {}; } }, notePresenceChange() {}, setVisitorsProvider() {} } } as never);
  const arrival = cross.arrivePlayer("resident", "ignored persona", "puppet"); assert.ok(arrival.ok); await tick(); assert.equal(consumed, 0, "connecting must not steal Bot observations");
  const resident = cross.residentSession(arrival.token); assert.equal(resident.mode, "puppet");
  const server: any = new WebUIServer({ config: cfg, webuiDir: dir, files: { base: dir }, playerControlsBot: (token: string) => token === "control", botToolCall: async (...args: any[]) => { called++; assert.equal(args[3], "control"); return { ok: true, text: "fixture" }; }, playerCockpit: async () => ({ mode: "puppet", tools: [] }), cancelPlayerTool: () => ({ ok: false, status: "too_late", text: "committed" }) } as never);
  async function post(route: string, body: unknown) {
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = "POST"; req.url = route; req.headers = { authorization: "Bearer fixture-admin" };
    let status = 0, result = "";
    await server.handle(req, { writeHead(code: number) { status = code; }, end(data: any) { result = String(data); }, setHeader() {} });
    return { status, body: JSON.parse(result) };
  }
  assert.equal((await post("/api/player/tool", { name: "act", actorName: "resident", arguments: {} })).status, 403);
  assert.equal((await post("/api/player/tool", { token: "control", name: "act", duration: "NaN" })).status, 400);
  assert.equal((await post("/api/player/tool", { token: "control", name: "act", duration: -1 })).status, 400);
  assert.equal((await post("/api/player/tool", { token: "control", name: "observe", arguments: {} })).status, 200); assert.equal(called, 1);
  assert.equal((await post("/api/player/task", { token: "control", kind: "observe", payload: {} })).status, 400);
  assert.equal((await post("/api/player/tool/cancel", { token: "control", callId: "tc_1" })).body.status, "too_late");
  await cross.disconnectVisitors("fixture disconnect"); assert.deepEqual(released, [resident.id]); assert.equal(cross.residentSession(arrival.token), null);
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-resident-"));
  try { await semantics(path.join(dir, "semantics")); await lifecycles(path.join(dir, "lifecycle")); await httpAndCrossing(path.join(dir, "webui")); console.log("PASS resident control: puppet agency, avatar inheritance, device ownership, complete tool schemas, session authorization, cancellation/commit and lifecycle fences"); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
