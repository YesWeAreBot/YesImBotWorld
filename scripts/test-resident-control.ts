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
  const defs = BOT_TOOLS.filter(tool => ["act", "observe_device", "check_status", "check_time", "reflect", "recall_growth", "recall", "wait", "rest", "cancel", "open_app", "close_app", "select_channel", "send", "pick_up_phone", "put_down_phone"].includes(tool.name));
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
    assert.equal(cockpit.tools.some((tool: any) => tool.name === "observe"), false, "active observation belongs to act, not a public observer");
    assert.ok(cockpit.tools.find((tool: any) => tool.name === "act").inputSchema.properties.description);
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
    assert.equal((await f.service.botToolCall("act", { description: "仔细看看桌上的纸信" }, 0, "avatar-token")).ok, true);
    assert.equal(f.actions.at(-1).arguments.description, "仔细看看桌上的纸信", "a resident actively observes through its real act dispatch path");
    assert.equal((await f.service.deviceToolCall("open_app", { name: "chat" }, 0, false, "stealth")).ok, true);
    await f.service.botToolCall("select_channel", { id: "onebot@fixture:target" }, 0, "avatar-token");
    cockpit = await f.service.playerCockpit("avatar-token");
    assert.equal(cockpit.tools.find((tool: any) => tool.name === "send").requiresSendConfirmation, true);
    assert.equal((await f.service.botToolCall("send", { id: "onebot@fixture:target", msg: "fixture" }, 0, "avatar-token")).ok, false);
    assert.equal(f.counts().sent, 0);
    assert.equal((await f.service.botToolCall("send", { id: "onebot@fixture:target", msg: "fixture" }, 0, "avatar-token", true)).ok, true);
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
    assert.equal((await f.service.botToolCall("act", { description: "仔细看看周围" }, 0, "control")).ok, false);
    committedFinish.resolve(); assert.equal((await active).text, "committed fixture result"); await lost;
    assert.equal(f.bot.manualMode, false);

    // A call waiting for durable context write still owns admission. Losing control cannot execute it later.
    f.service.residentSession = null;
    await f.enter("avatar", "next");
    const writeStarted = gate(), writeDone = gate();
    const original = f.context.appendToolCall.bind(f.context);
    f.context.appendToolCall = async (call: any) => { writeStarted.resolve(); await writeDone.promise; await original(call); };
    let observed = 0; f.world.adjudicateAct = async () => { observed++; return true; };
    const beforeDispatch = f.service.botToolCall("act", { description: "仔细看看周围" }, 0, "next"); await writeStarted.promise;
    assert.equal((await f.service.botToolCall("act", { description: "仔细看看周围" }, 0, "next")).ok, false, "one synchronous admission gate includes persistence");
    const ended = f.bot.releaseResidentControl("next-public-id", true); await tick();
    writeDone.resolve(); assert.equal((await beforeDispatch).ok, false); await ended; assert.equal(observed, 0);

    // A queued acquisition must revalidate its session after an unrelated device operation completes.
    f.service.residentSession = null; const oldDevice = gate(); f.service.deviceTail = oldDevice.promise;
    const queued = f.enter("avatar", "expired"); f.sessions.delete("expired"); oldDevice.resolve();
    assert.equal((await queued).ok, false); assert.equal(f.bot.manualMode, false);
  } finally { await f.bot.stop(); }
}

async function choices(dir: string) {
  for (const mode of ["avatar", "puppet"] as const) {
    const f = await fixture(path.join(dir, mode));
    try {
      await f.enter(mode, "human");
      const scene = async (id: string, intent: string) => {
        f.bot.pushEvent("world", JSON.stringify({ scene: { eventId: id, actorId: "bot", worldSequence: id === "first" ? 1 : 2, text: "门边有一条小路。", opportunities: [{ label: "走到河边", intent }] } }));
        await f.bot.drainMailbox();
      };
      await scene("first", "沿着小路走到河边");
      const old = f.bot.actionOpportunities(mode)[0]; assert.ok(old);
      await scene("second", "走上山坡");
      const stale = await f.service.botChooseCall({ opportunityId: old.id, sourceEventId: old.sourceEventId }, undefined, 0, "human");
      assert.equal(stale.ok, false); assert.equal(stale.admissionRejected, true); assert.equal(stale.code, "STALE_SELECTION");
      assert.equal(f.actions.length, 0, "stale identity cannot silently choose a new first option");
      const current = f.bot.actionOpportunities(mode)[0], reference = { opportunityId: current.id, sourceEventId: current.sourceEventId };
      assert.equal((await f.service.botChooseCall({ ...reference, target: "forged" }, undefined, 0, "human")).ok, false);
      const result = await f.service.botChooseCall(reference, "我去看看。", 0, "human");
      assert.equal(result.ok, true); assert.equal(f.actions.length, 1);
      assert.equal(f.actions[0].arguments.description, "走上山坡"); assert.equal(f.actions[0].arguments.speech, "我去看看。");
      assert.equal(f.actions[0].control.mode, mode); assert.equal(f.actions[0].selection.opportunityId, current.id);
      assert.equal((await f.service.botChooseCall(reference, undefined, 0, "human")).ok, false, "body mode also retires a consumed scene before receipt delivery");
      assert.equal(f.actions.length, 1);

      await f.bot.drainMailbox();
      await f.service.botToolCall("open_app", { name: "chat" }, 0, "human");
      await f.service.botToolCall("select_channel", { id: "onebot@fixture:target" }, 0, "human");
      await f.bot.drainMailbox();
      f.bot.pushEvent("koishi", { text: "朋友：今天去哪里了？", experience: { chat: { kind: "message", channelKey: "onebot@fixture:target", senderOwn: false } } });
      await f.bot.drainMailbox();
      const reply = f.bot.actionOpportunities(mode).find((item: any) => item.replyTo); assert.ok(reply);
      const replyRef = { opportunityId: reply.id, sourceEventId: reply.sourceEventId };
      assert.equal((await f.service.botChooseCall(replyRef, undefined, 0, "human", true)).ok, false, "a reply never invents words");
      assert.equal((await f.service.botChooseCall(replyRef, "去河边看了看。", 0, "human")).ok, false, "a suggested reply still requires explicit send confirmation");
      assert.equal(f.counts().sent, 0);
      assert.equal((await f.service.botChooseCall(replyRef, "去河边看了看。", 0, "human", true)).ok, true);
      assert.equal(f.counts().sent, 1);
      if (mode === "avatar") {
        await f.bot.drainMailbox(); await scene("third", "观察树下的脚印");
        const candidate = f.bot.actionOpportunities(mode)[0]; assert.ok(candidate);
        const append = f.context.appendToolCall.bind(f.context);
        f.context.appendToolCall = async (call: any) => { await append(call); await scene("fourth", "向店员问路"); };
        const raced = await f.service.botChooseCall({ opportunityId: candidate.id, sourceEventId: candidate.sourceEventId }, undefined, 0, "human");
        assert.equal(raced.ok, false); assert.equal(f.actions.length, 1, "scene changing during durable append must not execute the stale selection");
        assert.ok(raced.callId); assert.equal(raced.admissionRejected, true); assert.equal(raced.code, "STALE_SELECTION");
        f.context.appendToolCall = append;
        const latest = f.bot.actionOpportunities(mode)[0], execute = f.service.botToolCall;
        f.service.botToolCall = async () => { throw new Error("transport failed after execution began"); };
        await assert.rejects(f.service.botChooseCall({ opportunityId: latest.id, sourceEventId: latest.sourceEventId }, undefined, 0, "human"), /transport failed/, "execution exceptions must not become definite admission rejections");
        f.service.botToolCall = execute;
      }
    } finally { await f.bot.stop(); }
  }
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
  let selected = 0;
  server.host.botChooseCall = async (reference: any, text: unknown, duration: unknown, token: string, confirm: boolean) => {
    selected++; assert.equal(reference.opportunityId, "option"); assert.equal(text, "真人正文"); assert.equal(duration, 2); assert.equal(token, "control"); assert.equal(confirm, true);
    return { ok: false, callId: "attempted-send", text: "发送结果未知，未重发。" };
  };
  const selectedBody = { token: "control", selection: { opportunityId: "option", sourceEventId: "scene" }, text: "真人正文", duration: 2, confirmSend: true };
  assert.equal((await post("/api/player/tool", { ...selectedBody, name: "send", arguments: { id: "forged" } })).status, 400); assert.equal(selected, 0);
  const unknownResult = await post("/api/player/tool", selectedBody);
  assert.equal(unknownResult.status, 200); assert.equal(unknownResult.body.code, "OPERATION_RESULT", "an attempted send is not represented as a safe-to-retry rejection");
  for (const text of ["建议已过期", "选项已变化", "不再可用"]) {
    for (const ok of [true, false]) {
      server.host.botChooseCall = async () => ({ ok, callId: "actual-receipt", text: `实际执行结果：${text}` });
      const actualReceipt = await post("/api/player/tool", selectedBody);
      assert.equal(actualReceipt.status, 200, "real receipt prose never determines whether an operation was admitted");
      assert.equal(actualReceipt.body.admissionRejected, undefined);
      if (!ok) assert.equal(actualReceipt.body.code, "OPERATION_RESULT");
    }
  }
  server.host.botChooseCall = async () => ({ ok: false, text: "重新选择当前建议", admissionRejected: true, code: "STALE_SELECTION", callId: "reserved-not-dispatched" });
  const staleResult = await post("/api/player/tool", selectedBody);
  assert.equal(staleResult.status, 409); assert.equal(staleResult.body.code, "STALE_SELECTION");
  server.host.botChooseCall = async () => ({ ok: false, text: "请先明确确认发送" });
  const unadmitted = await post("/api/player/tool", selectedBody);
  assert.equal(unadmitted.status, 409); assert.equal(unadmitted.body.code, "SELECTION_REJECTED");
  assert.equal((await post("/api/player/task", { token: "control", kind: "observe", payload: {} })).status, 400);
  assert.equal((await post("/api/player/tool/cancel", { token: "control", callId: "tc_1" })).body.status, "too_late");
  await cross.disconnectVisitors("fixture disconnect"); assert.deepEqual(released, [resident.id]); assert.equal(cross.residentSession(arrival.token), null);
}

async function admission(dir: string) {
  const cfg = Config({ autoStart: false }); cfg.webui.token = "fixture-admin";
  let running = false, residentName = "", acquired = 0;
  const arrivals: { name: string; mode: string }[] = [];
  const host: any = {
    config: cfg, webuiDir: dir, files: { base: dir },
    worldRunning: () => running, residentBotName: () => residentName,
    arrivePlayer(name: string, _persona: string, mode: string) {
      arrivals.push({ name, mode });
      return { ok: true, token: "local-control", worldName: "fixture", timeLine: "T=1" };
    },
    acquirePlayerControl: async () => {
      acquired++;
      return { ok: true, paused: arrivals.at(-1)?.mode === "avatar", busy: false, text: "fixture control" };
    },
  };
  const server: any = new WebUIServer(host);
  async function arrive(mode: string, name = "resident") {
    const req: any = Readable.from([Buffer.from(JSON.stringify({ mode, name, persona: "fixture" }))]);
    req.method = "POST"; req.url = "/api/player/arrive"; req.headers = { authorization: "Bearer fixture-admin" };
    let status = 0, result = "";
    await server.handle(req, { writeHead(code: number) { status = code; }, end(data: any) { result = String(data); }, setHeader() {} });
    return { status, body: JSON.parse(result) };
  }
  // Before first startup the displayed name exists on disk but the runtime name is empty.
  // After a pause it may remain cached. Both states must report lifecycle, not identity errors.
  for (const cachedName of ["", "resident"]) {
    residentName = cachedName;
    for (const mode of ["avatar", "puppet", "cross"]) {
      const response = await arrive(mode);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "world_not_running");
      assert.match(response.body.error, /世界尚未运行.*总览页启动世界/);
      assert.doesNotMatch(response.body.error, /NPC|同名|尚未实现/);
    }
  }
  assert.equal(arrivals.length, 0); assert.equal(acquired, 0, "stopped entry creates no control session");
  running = true;
  residentName = "";
  const loading = await arrive("avatar");
  assert.equal(loading.status, 409); assert.equal(loading.body.code, "resident_not_ready");
  assert.doesNotMatch(loading.body.error, /NPC|尚未实现/);
  assert.equal(arrivals.length, 0);
  residentName = "resident";
  for (const mode of ["avatar", "puppet"]) {
    const response = await arrive(mode);
    assert.equal(response.status, 200); assert.equal(response.body.mode, mode);
    assert.equal(response.body.control.paused, mode === "avatar");
    assert.deepEqual(arrivals.at(-1), { name: "resident", mode });
  }
  assert.equal(acquired, 2, "both resident takeover modes remain supported once the world runs");
  assert.equal((await arrive("avatar", "some-npc")).status, 400, "starting the world does not bypass actor authorization");
  assert.equal(arrivals.length, 2);
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { worldActive: false, bot: null, crossingServer: { arrivePlayer() { throw Error("must not create a stopped-world session"); } } });
  assert.match(service.arrivePlayer("resident", "", "avatar").error, /世界尚未运行/);
  console.log("PASS resident admission: cold start and paused world report lifecycle before identity; both takeover modes resume after startup");
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-resident-"));
  try { await semantics(path.join(dir, "semantics")); await lifecycles(path.join(dir, "lifecycle")); await choices(path.join(dir, "choices")); await httpAndCrossing(path.join(dir, "webui")); await admission(path.join(dir, "admission")); console.log("PASS resident control: puppet agency, avatar inheritance, device ownership, complete tool schemas, session authorization, cancellation/commit and lifecycle fences, identity-bound human choices and confirmed own-text replies"); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
