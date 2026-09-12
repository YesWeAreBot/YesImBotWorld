/** Local command stubs only: no live world, model endpoint or messaging connection. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Config } from "../src/config.js";
import { executeWorldCommand, registerWorldCommands, WORLD_COMMANDS, type WorldCommandHost } from "../src/commands.js";
import { CommandRequestError, WebCommandRunner } from "../src/webui/commands.js";
import { WebUIServer } from "../src/webui/server.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const calls: unknown[][] = [], config = Config({ autoStart: false });
  const operation = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return "fixture: " + name; };
  const host: WorldCommandHost = { config, getClock: () => ({}), isInitialized: async () => true,
    statusText: operation("status"), startWorld: operation("start"), stopWorld: operation("stop"), initWorld: operation("init"),
    reloadWorld: operation("reload"), resetWorld: operation("reset"), clearMsg: operation("clear"), injectEvent: operation("inject"), crossingForce: operation("travel") };
  return { host, calls };
}

async function sharedCommands() {
  const { host, calls } = fixture(), registered = new Map<string, any>();
  const ctx: any = { command(name: string) { assert.equal(name, "world"); return { subcommand(declaration: string, _description: string, options: unknown) {
    const entry: any = { declaration, options }; registered.set("world" + declaration.split(" ")[0], entry);
    return { option(...args: unknown[]) { entry.option = args; return this; }, action(fn: unknown) { entry.action = fn; return this; } };
  } }; } };
  registerWorldCommands(ctx, host);
  assert.equal(registered.size, 10);
  for (const definition of WORLD_COMMANDS) assert.equal(registered.get(definition.name).options.authority, definition.authority);
  await registered.get("world.inject").action({}, "  一个事件  ");
  await executeWorldCommand(host, "world.inject", { text: "  一个事件  " });
  assert.deepEqual(calls, [["inject", "一个事件"], ["inject", "一个事件"]], "both transports share normalization and handler semantics");
  let sends = 0;
  await registered.get("world.init").action({ options: { force: true }, session: { send: async () => { sends++; } } });
  assert.equal(sends, 1);
  await executeWorldCommand(host, "world.init", { force: true });
  assert.equal(sends, 1, "the web command path has no chat session or message sender");
  host.config.webui.token = "private-admin-secret";
  assert.ok(!(await registered.get("world.webui").action({})).includes("private-admin-secret"), "status output must not leak the admin credential");
  console.log("PASS commands: shared Koishi/WebUI handlers, authority, arguments, progress and no chat transmission from web calls");
}

async function execution() {
  const { host, calls } = fixture(), blocker = gate();
  host.reloadWorld = async () => { calls.push(["reload"]); await blocker.promise; return "reloaded"; };
  const runner = new WebCommandRunner(host);
  const payload = (id: string, command: string, args: unknown = {}) => ({ id, instanceId: runner.instanceId, command, args });
  assert.throws(() => runner.start(payload("outside_1", "shell.exec", { command: "never" })), CommandRequestError);
  assert.throws(() => runner.start(payload("outside_2", "world.inject; reset", {})), CommandRequestError);
  assert.throws(() => runner.start(payload("invalid_1", "world.inject", { text: {} })), CommandRequestError);
  assert.throws(() => runner.start(payload("invalid_2", "world.start", { unknown: true })), CommandRequestError);
  assert.throws(() => runner.start({ ...payload("invalid_3", "world.start"), instanceId: "old-instance" }), /服务已经重启/);
  assert.throws(() => runner.start(payload("sensitive_1", "world.reset")), /确认/);
  assert.throws(() => runner.start(payload("sensitive_2", "world.init", { force: true })), /确认/);
  assert.equal(calls.length, 0);
  const active = runner.start(payload("request_1", "world.reload"));
  await tick(); assert.equal(active.status, "running"); assert.equal(active.messages.length, 1);
  assert.equal(runner.start(payload("request_1", "world.reload")), active);
  assert.throws(() => runner.start(payload("request_1", "world.stop")), /请求 ID/);
  assert.throws(() => runner.start(payload("request_2", "world.stop")), /另一个/);
  const status = runner.start(payload("request_3", "world.status")); await tick(); assert.equal(status.status, "completed", "read-only status remains available during mutation");
  blocker.resolve(); await tick(); assert.equal(active.status, "completed"); assert.equal(active.result, "reloaded");
  runner.start(payload("request_1", "world.reload")); assert.equal(calls.filter(call => call[0] === "reload").length, 1);
  const reset = runner.start({ ...payload("request_4", "world.reset"), confirmed: true }); await tick(); assert.equal(reset.status, "completed");
  host.startWorld = async () => { calls.push(["failure"]); throw Error("local expected failure"); };
  const failed = runner.start(payload("request_5", "world.start")); await tick();
  assert.equal(failed.status, "failed"); assert.match(failed.error!, /local expected failure/);
  assert.equal(runner.start(payload("request_5", "world.start")), failed);
  assert.equal(calls.filter(call => call[0] === "failure").length, 1, "failed operations are never replayed under the same ID");
  assert.equal(runner.catalog().busy, null);
  console.log("PASS commands: fixed allowlist, strict fields, confirmation, restart fence, active/completed/failed deduplication and mutation exclusion");
}

async function httpAccess(dir: string) {
  const { host, calls } = fixture(); host.config.webui.token = "local-admin";
  const server: any = new WebUIServer({ ...host, files: { base: dir }, webuiDir: dir } as never);
  const tokens: Record<string, string> = {};
  for (const preset of ["viewer", "player"] as const) { await server.visitors.create(preset, "fixture-password", preset); tokens[preset] = (await server.visitors.login(preset, "fixture-password")).token; }
  async function request(method: string, url: string, body: unknown = undefined, role = "admin") {
    const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url, headers: role === "admin" ? { authorization: "Bearer local-admin" } : role === "anonymous" ? {} : { "x-visitor-token": tokens[role] } });
    let status = 0, output = "";
    await server.handle(req, { writeHead(code: number) { status = code; }, end(data: unknown) { output = String(data); }, setHeader() {} });
    return { status, data: JSON.parse(output) };
  }
  assert.equal((await request("GET", "/api/commands", undefined, "anonymous")).status, 401);
  for (const role of ["viewer", "player"]) {
    assert.equal((await request("GET", "/api/commands", undefined, role)).status, 403);
    assert.equal((await request("GET", "/api/commands/hidden-run", undefined, role)).status, 403);
    assert.equal((await request("POST", "/api/commands", {}, role)).status, 403);
  }
  assert.equal(calls.length, 0);
  const catalog = await request("GET", "/api/commands"); assert.equal(catalog.data.commands.length, 10);
  const payload = { id: "http_request_1", instanceId: catalog.data.instanceId, command: "world.inject", args: { text: "a local event" } };
  assert.equal((await request("POST", "/api/commands", { ...payload, command: "other-plugin.command" })).status, 400);
  assert.equal((await request("POST", "/api/commands", { ...payload, args: [] })).status, 400);
  assert.equal((await request("POST", "/api/commands", { ...payload, confirmed: "yes" })).status, 400);
  const accepted = await request("POST", "/api/commands", payload); assert.equal(accepted.status, 202);
  await tick(); assert.equal((await request("GET", "/api/commands/http_request_1")).data.run.result, "fixture: inject");
  assert.equal((await request("POST", "/api/commands", payload)).status, 200);
  assert.deepEqual(calls, [["inject", "a local event"]]);
  assert.equal((await request("GET", "/api/commands/missing-record")).status, 404);
  console.log("PASS commands HTTP: admin-only discovery/history/execution, malformed-body rejection and exactly-once shared dispatch");
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-commands-"));
  try { await sharedCommands(); await execution(); await httpAccess(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
