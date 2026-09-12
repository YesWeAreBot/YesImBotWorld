/** Device APIs use local stubs only: no live WebUI, model, Docker or messaging connection. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { AppManager } from "../src/apps/manager.js";
import { ComputerDevice } from "../src/apps/computerDevice.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WorldService } from "../src/service.js";
import { RemoteDesktopApp } from "../src/apps/remoteDesktop.js";
import { RfbSession } from "../src/remote/rfb.js";
import { WebUIServer } from "../src/webui/server.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await tick(); assert.ok(test()); }

async function backend(dir: string) {
  const files = new WorldFiles(dir); await files.ensure();
  const cfg = Config({ autoStart: false }); cfg.bot.ignoreSendDuration = true;
  const clock: any = { now: () => 1, timeLine: () => "T=1", realMsUntil: () => 0, unitRealSeconds: 1 };
  let opened = 0, sends = 0, appCalls = 0;
  const schema = { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", properties: { value: { type: "number", minimum: 1 } } } } } };
  const slow = gate(), enteredSlow = gate(); let useSlow = false;
  const app = { id: "notes", name: "记事本", description: "fixture", async open() { opened++; return { tools: [{ name: "nested", description: "fixture", inputSchema: schema }] }; }, async close() {}, async call() {
    appCalls++; if (useSlow) { enteredSlow.resolve(); await slow.promise; }
    return { text: "real fixture result", attachments: [{ id: 7, file: "/fixture/media.png", type: "image" as const, mime: "image/png" }] };
  } };
  const tools = BOT_TOOLS.filter(t => ["open_app", "close_app", "select_channel", "send", "act", "check_msg"].includes(t.name));
  const apps = new AppManager("chat", [app], new Set(tools.map(t => t.name)), logger);
  const messenger: any = { recentChannels: async () => ({ text: "local chats" }), channelMessages: async () => ({ text: "local messages" }), resolveKey: async () => ({ key: "onebot@b:42", isPrivate: true }), send: async () => { sends++; return "sent exactly once"; } };
  const bot: any = new BotAgent(cfg, clock, files, new BotContext(files, ""), {} as never, messenger, apps, null, null, { down: false }, logger, tools);
  bot.running = true;
  bot.backend = { setToolNames() {}, setToolDefs() {} };
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { bot, appManager: apps, computerDevice: null, remoteDesktopApp: null, worldActive: true, deviceTail: Promise.resolve(), devicePending: 0, config: cfg });
  const row = { id: 1, platform: "onebot", channelId: "42", selfId: "b", content: "cached", username: "person", userId: "person", messageId: "message", timestamp: new Date(0), self: false };
  service.store = { knownChannels: async () => [{ key: "onebot@b:42", platform: "onebot", channelId: "42", selfId: "b", isDirect: true, participants: [] }], recentChannels: async () => [{ key: "onebot@b:42", latest: row }], channelMessages: async (_platform: string, _channel: string, _n: number, selfId: string) => { assert.equal(selfId, "b"); return [row]; } };
  service.devicesInfo = async () => ({ computer: { mode: "off", on: null, docker: null, remote: null }, phone: { down: false, appOpen: apps.currentName, ...bot.status().phoneUi, chatAppName: "chat", resolution: { width: 390, height: 844 } } });
  assert.equal((await service.deviceSession()).apps.length, 2);
  assert.equal(opened, 0, "GET session must not open an app");
  assert.equal((await service.deviceToolCall("open_app", { name: "notes" })).ok, false);
  assert.equal((await service.deviceControl(true)).ok, true);
  assert.equal((await service.deviceToolCall("act", { description: "mutate world" })).ok, false);
  assert.equal((await service.deviceToolCall("open_app", { name: "notes" })).ok, true);
  const session = await service.deviceSession();
  assert.deepEqual(session.tools.find((t: any) => t.name === "nested").inputSchema, schema);
  assert.equal(opened, 1);
  const rich = await service.deviceToolCall("nested", { items: [{ value: 3 }] });
  assert.equal(rich.content.attachments[0].id, 7);
  assert.equal((await service.deviceSession()).appView.result.text, "real fixture result");
  await service.deviceToolCall("close_app", {});
  assert.equal((await service.deviceToolCall("nested", {})).ok, false, "closed app tools disappear");
  await service.deviceToolCall("open_app", { name: "chat" });
  await service.deviceToolCall("select_channel", { id: "onebot@b:42" });
  assert.equal((await service.deviceSession()).chat.messages[0].content, "cached");
  assert.equal((await service.deviceToolCall("send", { msg: "hello" })).ok, false);
  assert.equal(sends, 0, "unconfirmed sends cannot reach the platform");
  assert.equal((await service.deviceToolCall("send", { msg: "hello" }, 0, true)).ok, true);
  assert.equal(sends, 1);
  const reopened = await service.deviceToolCall("open_app", { name: "notes" }); assert.ok(reopened.ok, reopened.text);
  useSlow = true;
  const active = service.deviceToolCall("nested", {});
  await Promise.race([enteredSlow.promise, active.then((result: any) => { throw new Error("slow tool unexpectedly finished: " + JSON.stringify(result)); })]);
  const release = service.deviceControl(false);
  await tick(); assert.equal(bot.manualMode, true, "release waits for the actual in-flight result");
  slow.resolve(); await active; await release;
  assert.equal(bot.manualMode, false);
  assert.equal((await service.deviceToolCall("nested", {})).ok, false);
  let scheduledSend = false;
  const committed = gate();
  bot.scheduler.schedule({ id: "committed", role: "agent", name: "nested", arguments: {}, issuedAt: 1, expectedAt: 1 }, { executeAt: "now", run: async () => { await committed.promise; return "finished"; } });
  const busy = await service.deviceControl(true);
  assert.equal(busy.paused, true); assert.equal(busy.busy, true); assert.equal(busy.ok, false);
  assert.equal((await service.deviceToolCall("nested", {})).ok, false);
  committed.resolve(); await until(() => !bot.manualBusy);
  bot.clock.realMsUntil = () => 60000;
  scheduledSend = false;
  bot.scheduler.schedule({ id: "queued-send", role: "agent", name: "send", arguments: {}, issuedAt: 1, expectedAt: 99 }, { executeAt: "expected", run: async () => { scheduledSend = true; return "sent"; } });
  await service.deviceControl(true);
  assert.equal(scheduledSend, false); assert.equal(bot.scheduler.pendingCount, 0);
  bot.clock.realMsUntil = () => 0;
  await bot.stop();
  console.log("PASS devices: read-only snapshots, real app schemas/gates, explicit send, serialized input/release, takeover cancellation and honest busy state");
}

async function remoteDesktop() {
  const cfg = Config({ autoStart: false }).apps.computer.remoteDesktop;
  const imageRef = { id: 1, type: "image", file: "local-fixture.png" };
  const remote: any = new RemoteDesktopApp(cfg, { ingest: async () => 1, get: async () => ({ ref: imageRef }) } as never, logger);
  await assert.rejects(remote.peek(), /未连接/);
  await assert.rejects(remote.observe(), /未连接/);
  const pointers: number[][] = [], keys: unknown[][] = [];
  remote.session = { connected: true, screenSize: { width: 1600, height: 900 }, lastPointer: { x: 12, y: 34 }, snapshot: async (_w: number, opts: any) => { assert.equal(opts.connect, false); return { png: Buffer.from("fixture"), width: 800, height: 450 }; }, pointer: (...args: number[]) => pointers.push(args), keyHold: async (...args: unknown[]) => keys.push(args), disconnect() {} };
  const shot = await remote.peek(800);
  assert.equal(shot.width, 800); assert.equal(shot.desktopWidth, 1600);
  const observed = await remote.observe();
  assert.deepEqual(observed.attachments, [imageRef]);
  assert.doesNotMatch(observed.text, /你打开|你抬头|人类|管理员/);
  const closing: any = new RemoteDesktopApp(cfg, { ingest: async () => { closing.abortInput(); return 1; }, get: async () => ({ ref: imageRef }) } as never, logger);
  closing.session = { ...remote.session };
  await assert.rejects(closing.observe(), /读取画面期间远程桌面已断开/, "late screen capture cannot pretend a closed desktop remains visible");
  await remote.call("mouse", { action: "press", x: 10, y: 10 });
  await remote.call("mouse", { action: "move", x: 20, y: 20 });
  assert.equal(pointers[1]![2], 1, "moving while pressed preserves drag button");
  await remote.call("keyboard", { action: "press", key: "ctrl" });
  await remote.releaseInputs();
  assert.equal(pointers.at(-1)![2], 0); assert.equal(keys.at(-1)![1], false);
  const dragAt = pointers.length;
  await remote.call("mouse", { action: "drag", button: "right", x: 10, y: 10, x2: 30, y2: 30 });
  assert.ok(pointers.slice(dragAt, -1).every(p => p[2] === 4), "right drag preserves the requested button throughout");
  assert.equal(pointers.at(-1)![2], 0);
  const priorPointer = remote.session.pointer;
  remote.session.pointer = (...args: number[]) => { priorPointer(...args); remote.abortInput(); };
  await assert.rejects(remote.call("mouse", { action: "click", x: 10, y: 10 }), /可能已部分执行/, "interrupted input cannot report complete success");
  const disconnected: any = Object.create(RfbSession.prototype); let connections = 0;
  Object.assign(disconnected, { snapLock: Promise.resolve(), client: null, closed: true, connect: async () => { connections++; } });
  await assert.rejects(disconnected.snapshot(800, { connect: false }), /断开/);
  assert.equal(connections, 0);
  const typing: any = new RfbSession({ host: "unused.invalid", port: 0 }, logger);
  const typed = gate(), continueTyping = gate(); let taps = 0;
  typing.client = {}; typing.socket = { write() {}, destroy() {} }; typing.closed = false;
  typing.tapKey = async () => { taps++; typed.resolve(); await continueTyping.promise; };
  const text = typing.typeText("ab"); await typed.promise;
  typing.disconnect(); continueTyping.resolve();
  await assert.rejects(text, /输入已停止/); assert.equal(taps, 1, "shutdown cannot finish typing into a later session");
  const originalConnect = RfbSession.prototype.connect;
  const connecting = gate();
  try {
    RfbSession.prototype.connect = async () => { await connecting.promise; };
    const late: any = new RemoteDesktopApp(cfg, {} as never, logger);
    const opening = late.open();
    late.abortInput(); connecting.resolve(); await opening;
    assert.equal(late.session, null, "late connection cannot reopen a device after shutdown");
  } finally { RfbSession.prototype.connect = originalConnect; connecting.resolve(); }
  console.log("PASS devices: screenshot GET never connects, original pointer dimensions and held-input release are preserved");
}

async function namespaceAndLifecycle() {
  const schema = { type: "object", properties: { command: { type: "string" } } };
  let actual = "";
  const component: any = { id: "terminal", name: "terminal", description: "fixture", open: async () => ({ tools: [{ name: "run_command", description: "fixture", inputSchema: schema }] }), call: async (tool: string) => { actual = tool; return "result"; }, close: async () => {} };
  const phone = new AppManager("chat", [component], new Set(), logger, () => ["run_command"]);
  await phone.open(component);
  assert.equal(phone.activeToolNames()[0], "terminal.run_command");
  await phone.call("terminal.run_command", {}); assert.equal(actual, "run_command");
  const desktop = new ComputerDevice(component, null, null, { ensureReady: async () => ({ ok: true }) } as never, { readMeta: async () => ({ realWorld: true }) } as never, {} as never, { mode: "docker" } as never, new Set(), logger, () => ["run_command"]);
  await desktop.open();
  assert.equal(desktop.activeToolNames()[0], "terminal.run_command");
  assert.deepEqual(desktop.activeToolDefs()[0]!.inputSchema, schema);
  await desktop.close(); await phone.closeAll();
  const done = gate(), entered = gate(); let calls = 0;
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { worldActive: true, deviceTail: Promise.resolve(), devicePending: 0, appManager: null, computerDevice: null,
    bot: { manualMode: true, manualBusy: false, manualTools: () => [{ name: "open_app", description: "fixture", signature: "open_app(name:string)" }], injectExternalToolCall: async () => { calls++; entered.resolve(); await done.promise; return { ok: true, text: "committed receipt" }; } } });
  const first = service.deviceToolCall("open_app", { name: "fixture" }); await entered.promise;
  const second = service.deviceToolCall("open_app", { name: "other" });
  service.worldActive = false;
  let drained = false; const drain = service.deviceTail.then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  done.resolve(); await first;
  assert.equal((await second).ok, false); await drain;
  assert.equal(calls, 1, "queued input cannot target a world stopped while an earlier call was committing");
  console.log("PASS devices: cross-device tool namespaces and world-stop queue fence");
}

async function httpPolicy(dir: string) {
  const cfg = Config({ autoStart: false }); cfg.webui.token = "fixture-admin";
  let reads = 0, writes = 0;
  const toolRequests: unknown[][] = [];
  const server: any = new WebUIServer({ config: cfg, webuiDir: dir, files: { base: dir }, deviceSession: async () => { reads++; return { running: true }; }, deviceControl: async (paused: boolean) => { writes++; return { ok: true, paused }; }, deviceToolCall: async (...args: unknown[]) => { writes++; toolRequests.push(args); return { ok: true, text: "fixture" }; } } as never);
  const tokens: Record<string, string> = {};
  for (const preset of ["viewer", "player"] as const) { await server.visitors.create(preset, "fixture-password", preset); tokens[preset] = (await server.visitors.login(preset, "fixture-password")).token; }
  server.crossingPost = async (route: string, body: any) => { assert.equal(route, "/crossing/cancel"); assert.deepEqual(body, { token: "crossing-fixture", taskId: "task-fixture" }); return { ok: false, status: "too_late", result: { content: "committed" } }; };
  async function request(method: string, url: string, body: unknown, role = "admin") {
    const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url, headers: role === "admin" ? { authorization: "Bearer fixture-admin" } : { "x-visitor-token": tokens[role] } });
    let status = 0, output = "";
    await server.handle(req, { writeHead(code: number) { status = code; }, end(data: unknown) { output = String(data); }, setHeader() {} });
    return { status, data: JSON.parse(output) };
  }
  assert.equal((await request("GET", "/api/device/session", undefined, "viewer")).status, 403);
  assert.equal((await request("POST", "/api/device/control", { paused: true }, "viewer")).status, 403);
  assert.equal(reads + writes, 0);
  assert.equal((await request("GET", "/api/device/session", undefined)).status, 200);
  assert.equal(reads, 1); assert.equal(writes, 0);
  assert.equal((await request("POST", "/api/device/tool", { name: "send", args: null })).status, 400);
  assert.equal((await request("POST", "/api/device/control", { paused: "true" })).status, 400);
  assert.equal((await request("POST", "/api/device/tool", { name: "open_app", args: {}, mode: "background" })).status, 400);
  assert.equal((await request("POST", "/api/device/tool", { name: "open_app", args: {}, mode: "stealth" }, "viewer")).status, 403);
  assert.equal((await request("POST", "/api/device/tool", { name: "open_app", args: {}, mode: "stealth" }, "player")).status, 403);
  assert.equal(writes, 0);
  assert.equal((await request("POST", "/api/device/tool", { name: "send", args: { msg: "fixture" }, mode: "stealth", confirmSend: true })).status, 200);
  assert.deepEqual(toolRequests[0], ["send", { msg: "fixture" }, undefined, true, "stealth"]);
  assert.equal((await request("POST", "/api/device/tool", { name: "open_app", args: { name: "notes" } })).status, 200);
  assert.equal(toolRequests[1]?.[4], undefined, "old clients retain the service's takeover default");
  assert.equal((await request("POST", "/api/player/cancel", { token: "crossing-fixture", taskId: "task-fixture" }, "viewer")).status, 403);
  const cancelled = await request("POST", "/api/player/cancel", { token: "crossing-fixture", taskId: "task-fixture" }, "player");
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.status, "too_late"); assert.equal(cancelled.data.result.content, "committed");
  assert.equal((await request("POST", "/api/player/cancel", { taskId: "manual-call" })).status, 400);
  let leaves = 0, releases = 0, blocked = true;
  server.host.playerControlsBot = (token: string) => token === "resident-control";
  server.host.releasePlayerControl = async () => { releases++; return { ok: !blocked, paused: blocked, busy: blocked, text: blocked ? "committed operation pending" : "released" }; };
  server.crossingPost = async (route: string) => { assert.equal(route, "/crossing/leave"); leaves++; return { ok: true }; };
  assert.equal((await request("POST", "/api/player/leave", { token: "independent" })).status, 200);
  assert.equal(releases, 0, "independent crossing cannot release device takeover");
  assert.equal((await request("POST", "/api/player/leave", { token: "resident-control" })).status, 409);
  assert.equal(leaves, 1, "busy control must preserve the player's session");
  blocked = false;
  assert.equal((await request("POST", "/api/player/leave", { token: "resident-control" })).status, 200);
  assert.equal(leaves, 2); assert.equal(releases, 2);
  console.log("PASS devices HTTP: admin-only sessions/actions, strict bodies, player cancellation preserves too_late receipts");
}

async function effectiveComputer() {
  const cfg = Config({ autoStart: false }); cfg.apps.computer.mode = "docker";
  const service: any = Object.create(WorldService.prototype);
  let inspected = 0, real = false;
  Object.assign(service, { config: cfg, files: { readMeta: async () => ({ realWorld: real }) }, clock: { syncRealTime: true },
    phoneStatus: { down: false }, worldActive: true, bot: { status: () => null, manualMode: true, manualBusy: false },
    computer: { inspect: async () => { inspected++; return {}; } }, deviceTail: Promise.resolve(), devicePending: 0 });
  let info = await service.devicesInfo();
  assert.equal(info.computer.mode, "docker"); assert.equal(info.computer.effectiveMode, "virtual");
  assert.equal(info.computer.docker, null); assert.equal(inspected, 0);
  await assert.rejects(service.computerAction("restart"), /虚构世界/);
  await assert.rejects(service.computerScreen(), /虚构世界/);
  real = true; info = await service.devicesInfo();
  assert.equal(info.computer.effectiveMode, "docker"); assert.equal(inspected, 1);
  console.log("PASS devices: effective virtual mode cannot inspect, control or screenshot a real computer");
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-device-"));
  try { await backend(path.join(dir, "world")); await remoteDesktop(); await namespaceAndLifecycle(); await httpPolicy(path.join(dir, "webui")); await effectiveComputer(); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
