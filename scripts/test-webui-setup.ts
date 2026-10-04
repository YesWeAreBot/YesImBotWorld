/** Setup transactions use temporary files and a loopback server, never a real world or model. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WorldService } from "../src/service.js";
import { WebUIServer, SECRET_MASK } from "../src/webui/server.js";
import { WebUISetup, type SetupHost } from "../src/webui/setup.js";

const BOT_DEF = "# 角色定义\n林雨是一名住在海边的修表师，性格温和，喜欢在雨天读书。";
const WORLD_DEF = "# 世界定义\n架空海港小镇，角色住在钟楼旁的公寓，街对面有一家咖啡馆。";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-setup-"));
  const files = new WorldFiles(directory); await files.ensure();
  const config = Config({ autoStart: false });
  config.bot.baseURL = "http://fixture.invalid/v1"; config.bot.model = "bot-model"; config.bot.apiKey = "fixture-bot-private-key";
  config.world.baseURL = "https://world.invalid/v1"; config.world.model = "world-model"; config.world.apiKey = "fixture-world-private-key";
  config.webui.token = "fixture-admin-token";
  let initialized = false, calls = 0;
  const host: SetupHost = {
    config, configSchema: Config, files, webuiDir: path.join(directory, "webui"),
    isInitialized: async () => initialized, worldRunning: () => false,
    applyConfig: async next => { calls++; host.config = next; return { message: "fixture queued reload", port: next.webui.port }; },
  };
  return { host, directory, files, setInitialized: (value: boolean) => { initialized = value; }, calls: () => calls,
    stateFile: path.join(host.webuiDir, "setup.json"), cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

async function progressAndValidation() {
  const f = await fixture();
  try {
    const setup = new WebUISetup(f.host);
    let state = await setup.get();
    assert.equal(state.shouldPrompt, true); assert.equal(state.definitions.botReady, false); assert.equal(state.applied, true);
    assert.ok(!JSON.stringify(state).includes("fixture-"), "Setup status must not include credentials or endpoint values");
    f.setInitialized(true); assert.equal((await setup.get()).shouldPrompt, false, "An existing world is never forced into onboarding");
    f.setInitialized(false);
    const configBefore = structuredClone(f.host.config), definitionsBefore = await f.files.readDefinitions();
    await setup.save({ dismissed: true });
    assert.equal(f.calls(), 0); assert.deepEqual(f.host.config, configBefore); assert.deepEqual(await f.files.readDefinitions(), definitionsBefore);
    assert.equal((await new WebUISetup(f.host).get()).shouldPrompt, false, "Skipping survives a server restart");
    for (const body of [
      {}, [], { unknown: true }, { dismissed: true, config: { autoStart: false } }, { completed: "yes" },
      { config: { basePath: "/tmp/unwanted" } }, { config: { webui: { host: "0.0.0.0" } } },
      { config: { bot: { growth: { llm: { apiKey: "blocked" } } } } },
      JSON.parse('{"config":{"__proto__":{"polluted":true}}}'),
      { config: { bot: { model: "" } } }, { config: { bot: { baseURL: "file:///tmp/model" } } },
      { config: { bot: { baseURL: "https://user:password@model.invalid" } } },
      { config: { world: { baseURL: "https://model.invalid/#secret" } } },
      { config: { bot: { maxTokens: -1 } } }, { config: { bot: { apiType: "unknown" } } },
      { botDef: "# 角色\n<!-- TODO -->" }, { worldDef: "（尚未编写）" }, { completed: true },
    ]) await assert.rejects(setup.save(body), error => (error as { status: number }).status === 400);
    assert.equal(f.calls(), 0); assert.equal(({} as any).polluted, undefined);
    f.host.config.webui.host = "0.0.0.0"; f.host.config.webui.token = "";
    await assert.rejects(setup.save({ botDef: BOT_DEF, worldDef: WORLD_DEF, completed: true }), /访问令牌/);
    assert.deepEqual(await f.files.readDefinitions(), definitionsBefore, "Validation never partially writes definitions");
    f.host.config.webui.host = "127.0.0.1";
    const local = await setup.save({ botDef: BOT_DEF, worldDef: WORLD_DEF, completed: true });
    assert.equal(local.reload, false); assert.equal(local.setup.completed, true); assert.equal(local.setup.dismissed, false);
    assert.equal(local.setup.applied, true); assert.equal(f.calls(), 0, "Loopback setup may explicitly remain tokenless without reloading");
    assert.equal((await new WebUISetup(f.host).get()).completed, true);
  } finally { await f.cleanup(); }
}

async function mergingAndReload() {
  const f = await fixture();
  try {
    f.host.config.world.maxToolRounds = 37; f.host.config.world.temperature = .83;
    f.host.config.apps.computer.docker.image = "keep-my-image";
    f.host.config.bot.growth.llm!.apiKey = "keep-independent-key";
    const original = structuredClone(f.host.config);
    let scheduled: Config | undefined;
    f.host.applyConfig = async next => {
      scheduled = next;
      assert.deepEqual(await f.files.readDefinitions(), { botDef: BOT_DEF, worldDef: WORLD_DEF }, "Definitions must exist before restart can be scheduled");
      assert.equal(JSON.parse(await fs.readFile(f.stateFile, "utf8")).completed, true, "Progress must survive an immediate restart");
      return { message: "fixture queued reload", port: next.webui.port };
    };
    const setup = new WebUISetup(f.host);
    const result = await setup.save({
      config: { bot: { apiKey: SECRET_MASK, model: "new-bot-model" }, webui: { token: SECRET_MASK },
        platformOps: { reply: true }, media: { maxAttachmentsPerRequest: 2 } },
      botDef: BOT_DEF, worldDef: WORLD_DEF, reuseBotModel: true, completed: true,
    });
    assert.equal(result.reload, true); assert.equal(result.setup.applied, false);
    assert.ok(scheduled); assert.deepEqual(f.host.config, original, "A queued reload does not pretend to replace the current host");
    assert.equal(scheduled.bot.apiKey, original.bot.apiKey); assert.equal(scheduled.world.apiKey, original.bot.apiKey, "Shared models copy the restored Bot key, never World's old key");
    assert.equal(scheduled.world.model, "new-bot-model"); assert.equal(scheduled.world.baseURL, original.bot.baseURL);
    assert.equal(scheduled.world.maxToolRounds, 37); assert.equal(scheduled.world.temperature, .83);
    assert.equal(scheduled.apps.computer.docker.image, "keep-my-image"); assert.equal(scheduled.bot.growth.llm!.apiKey, "keep-independent-key");
    assert.equal(scheduled.webui.token, original.webui.token); assert.equal(scheduled.platformOps.reply, true);
    assert.equal((await setup.get()).applied, false, "A delayed loader failure must remain unconfirmed even though completed is persisted");
    await assert.rejects(setup.save({ dismissed: true }), error => (error as { status: number }).status === 409);
    const disk = await fs.readFile(f.stateFile, "utf8");
    for (const secret of [original.bot.apiKey, original.world.apiKey, original.webui.token, "keep-independent-key"]) {
      assert.ok(!disk.includes(secret)); assert.ok(!JSON.stringify(result).includes(secret));
    }
    f.host.config = scheduled;
    const restarted = new WebUISetup(f.host), confirmed = await restarted.get();
    assert.equal(confirmed.applied, true); assert.ok(confirmed.appliedAt); assert.equal(confirmed.shouldPrompt, false);
    f.host.config.bot.model = "later-advanced-edit";
    assert.equal((await new WebUISetup(f.host).get()).applied, true, "Later advanced edits do not reopen a confirmed setup");
    const independent = await restarted.save({ config: { world: { apiKey: SECRET_MASK, model: "independent-model" } }, reuseBotModel: false });
    assert.equal(independent.reload, true); assert.equal(scheduled!.world.apiKey, original.bot.apiKey);
    assert.equal(scheduled!.bot.model, "later-advanced-edit");
  } finally { await f.cleanup(); }
}

async function failuresAndExplicitKeys() {
  const f = await fixture();
  try {
    const setup = new WebUISetup(f.host);
    await setup.save({ dismissed: true });
    const previousState = await fs.readFile(f.stateFile, "utf8"), previousDefs = await f.files.readDefinitions();
    f.host.applyConfig = async () => { throw new Error("loader rejected secret: fixture-bot-private-key"); };
    await assert.rejects(setup.save({ config: { bot: { model: "new-model" } }, botDef: BOT_DEF, worldDef: WORLD_DEF, completed: true }), error => {
      assert.match((error as Error).message, /已还原/); assert.ok(!(error as Error).message.includes("fixture-bot-private-key")); return true;
    });
    assert.equal(await fs.readFile(f.stateFile, "utf8"), previousState); assert.deepEqual(await f.files.readDefinitions(), previousDefs);
    const realWrite = f.files.writeWorldDef.bind(f.files);
    f.files.writeWorldDef = async () => { throw new Error("fixture disk failure"); };
    await assert.rejects(setup.save({ botDef: BOT_DEF, worldDef: WORLD_DEF }), /已还原/);
    assert.deepEqual(await f.files.readDefinitions(), previousDefs); assert.equal(await fs.readFile(f.stateFile, "utf8"), previousState);
    f.files.writeWorldDef = realWrite;
    f.host.applyConfig = async next => { f.host.config = next; return { message: "fixture", port: next.webui.port }; };
    await setup.save({ config: { bot: { apiKey: "" }, world: { apiKey: SECRET_MASK } }, reuseBotModel: true });
    assert.equal(f.host.config.bot.apiKey, ""); assert.equal(f.host.config.world.apiKey, "", "Explicitly clearing the Bot key is copied, not replaced with an inherited credential");
    const restarted = new WebUISetup(f.host); await restarted.get();
    await restarted.save({ config: { bot: { apiKey: "fresh-draft-bot-key" }, world: { apiKey: "fresh-world-key" } }, reuseBotModel: false });
    assert.equal(f.host.config.bot.apiKey, "fresh-draft-bot-key"); assert.equal(f.host.config.world.apiKey, "fresh-world-key");
    const current = new WebUISetup(f.host); await current.get();
    await current.save({ config: { bot: { apiKey: SECRET_MASK }, world: { apiKey: SECRET_MASK, model: "new-independent" } }, reuseBotModel: false });
    assert.equal(f.host.config.world.apiKey, "fresh-world-key", "Independent groups restore only their own key");
  } finally { await f.cleanup(); }
}

async function manuallyRecoveredReload() {
  const f = await fixture();
  try {
    let scheduled = 0;
    f.host.applyConfig = async next => {
      scheduled++;
      // Simulate a reload which is accepted but subsequently fails, leaving the
      // previous configuration active after a manual plugin restart.
      return { message: "fixture queued reload", port: next.webui.port };
    };
    const setup = new WebUISetup(f.host);
    await setup.save({ config: { bot: { model: "unapplied-model" } }, botDef: BOT_DEF, worldDef: WORLD_DEF, completed: true });
    assert.equal((await setup.get()).applied, false);
    await assert.rejects(setup.save({ completed: true }), error => (error as { status: number }).status === 409,
      "An old instance cannot accept another completion while its reload may still be running");
    const restarted = new WebUISetup(f.host);
    assert.equal((await restarted.get()).applied, false, "Restarting alone does not claim the requested settings were applied");
    const accepted = await restarted.save({ completed: true });
    assert.equal(accepted.reload, false); assert.equal(accepted.setup.applied, true); assert.ok(accepted.setup.appliedAt);
    assert.equal(f.host.config.bot.model, "bot-model"); assert.equal(scheduled, 1, "Explicitly accepting the current settings does not schedule another reload");
    const persisted = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
    assert.equal(persisted.expectedConfig, undefined); assert.equal(persisted.completed, true);
    assert.equal((await new WebUISetup(f.host).get()).applied, true, "Recovery remains confirmed on subsequent restarts");
  } finally { await f.cleanup(); }
}

async function httpAuthorization() {
  const f = await fixture();
  f.host.config.webui.host = "127.0.0.1"; f.host.config.webui.port = 0;
  const server: any = new WebUIServer(f.host as any);
  try {
    await server.start(); f.host.config.webui.port = server.server.address().port;
    const root = "http://127.0.0.1:" + f.host.config.webui.port;
    const request = (method: string, headers = {}, body?: unknown) => fetch(root + "/api/setup", { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await request("GET")).status, 401);
    await server.visitors.create("operator", "fixture-password", "operator");
    const visitor = await server.visitors.login("operator", "fixture-password");
    assert.equal((await request("GET", { "x-visitor-token": visitor.token })).status, 403, "Even operators with configuration grants cannot read setup");
    assert.equal((await request("POST", { "x-visitor-token": visitor.token }, { dismissed: true })).status, 403);
    const admin = { authorization: "Bearer fixture-admin-token" };
    assert.equal((await request("GET", admin)).status, 200); assert.equal((await request("DELETE", admin)).status, 405);
    assert.equal((await request("POST", admin, { config: { webui: { enabled: false } } })).status, 400);
    const saved = await request("POST", admin, { dismissed: true }); assert.equal(saved.status, 200);
    assert.equal((await saved.json() as any).reload, false); assert.equal(f.calls(), 0);
  } finally { await server.stop(); await f.cleanup(); }
}

async function loaderPreflight() {
  const config = Config({});
  let timers = 0, scheduled: (() => void) | undefined;
  const realTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      timers++; assert.equal(delay, 300); scheduled = callback; return { unref() {} };
    }) as typeof setTimeout;
    await assert.rejects(WorldService.prototype.applyConfig.call({ config, ctx: { scope: {} } } as any, config), /找不到插件作用域/);
    assert.equal(timers, 0, "Missing loader fails before a success response or delayed shutdown");
    let received: Config | undefined;
    const host = { config, ctx: { scope: { parent: { scope: { update() {} } } } }, restartScope: async (next: Config) => { received = next; } };
    const next = { ...config, autoStart: true };
    const result = await WorldService.prototype.applyConfig.call(host as any, next);
    assert.equal(timers, 1); assert.equal(result.port, config.webui.port); assert.equal(received, undefined);
    scheduled!(); await Promise.resolve(); assert.equal(received!.autoStart, true, "Valid loaders retain the existing delayed restart behavior");
  } finally { globalThis.setTimeout = realTimeout; }
}

async function main() {
  await progressAndValidation(); await mergingAndReload(); await failuresAndExplicitKeys(); await manuallyRecoveredReload(); await httpAuthorization(); await loaderPreflight();
  console.log("PASS WebUI setup: admin authorization, first-run persistence, safe patches, source credentials, restart confirmation, atomic rollback and loader preflight");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
