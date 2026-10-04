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
import { configurationRevision } from "../src/webui/config-revision.js";

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

async function firstPresentation() {
  const f = await fixture();
  try {
    const setup = new WebUISetup(f.host);
    const initial = await setup.get();
    assert.equal(initial.presented, false); assert.equal(initial.presentedAt, null); assert.equal(initial.shouldPrompt, true);
    await assert.rejects(fs.readFile(f.stateFile), { code: "ENOENT" }, "Reading an unused world does not consume its first prompt");
    // A tour must be available while the administrator is still fixing settings.
    f.host.config.bot.maxTokens = -1; f.host.config.bot.model = "";
    const configBefore = structuredClone(f.host.config), definitionsBefore = await f.files.readDefinitions();
    const entered = await setup.save({ presented: true });
    assert.equal(entered.firstPresentation, true);
    assert.equal(entered.reload, false); assert.equal(entered.setup.presented, true); assert.ok(entered.setup.presentedAt);
    assert.equal(entered.setup.completed, false); assert.equal(entered.setup.dismissed, false); assert.equal(entered.setup.shouldPrompt, false);
    assert.equal(f.calls(), 0); assert.deepEqual(f.host.config, configBefore); assert.deepEqual(await f.files.readDefinitions(), definitionsBefore);
    const recorded = await fs.readFile(f.stateFile, "utf8");
    const repeated = await setup.save({ presented: true });
    assert.equal(repeated.firstPresentation, false);
    assert.equal(repeated.setup.presentedAt, entered.setup.presentedAt);
    assert.equal(await fs.readFile(f.stateFile, "utf8"), recorded, "Repeated entry leaves the original progress record unchanged");
    assert.equal((await new WebUISetup(f.host).get()).shouldPrompt, false, "Closing before completion still suppresses prompts in another browser or server instance");
    for (const body of [{ presented: false }, { presented: "true" }, { presented: true, config: {} }, { presented: true, dismissed: true }]) {
      await assert.rejects(setup.save(body), error => (error as { status: number }).status === 400);
    }
    await setup.save({ completed: false, dismissed: false });
    assert.equal((await setup.get()).presented, true, "Clearing legacy progress cannot undo first use");
    await f.files.reset();
    assert.equal((await new WebUISetup(f.host).get()).shouldPrompt, false, "A real world reset keeps onboarding history");
  } finally { await f.cleanup(); }
}

async function existingWorldHistory() {
  const f = await fixture();
  try {
    f.setInitialized(true);
    const setup = new WebUISetup(f.host), existing = await setup.get();
    assert.equal((await setup.save({ presented: true })).firstPresentation, false);
    assert.equal(existing.presented, true); assert.equal(existing.shouldPrompt, false); assert.ok(existing.presentedAt);
    assert.equal(JSON.parse(await fs.readFile(f.stateFile, "utf8")).presented, true, "An initialized installation records prior use on GET");
    await f.files.reset(); f.setInitialized(false);
    assert.equal((await new WebUISetup(f.host).get()).shouldPrompt, false, "Previously initialized installations stay suppressed after a reset and restart");
    assert.equal(f.calls(), 0);
    for (const field of ["completed", "dismissed"]) {
      await fs.writeFile(f.stateFile, JSON.stringify({ version: 1, [field]: true, updatedAt: null, appliedAt: null }));
      assert.equal((await new WebUISetup(f.host).save({ presented: true })).firstPresentation, false, "Direct claims also recognize legacy progress before any GET migration");
      await fs.writeFile(f.stateFile, JSON.stringify({ version: 1, [field]: true, updatedAt: null, appliedAt: null }));
      const legacy = new WebUISetup(f.host), migrated = await legacy.get();
      assert.equal(migrated.presented, true); assert.equal(migrated.shouldPrompt, false);
      assert.equal(JSON.parse(await fs.readFile(f.stateFile, "utf8")).presented, true, "Legacy progress is migrated to durable presentation history");
      await legacy.save({ completed: false, dismissed: false });
      assert.equal((await new WebUISetup(f.host).get()).shouldPrompt, false);
    }
  } finally { await f.cleanup(); }
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
    const presented = await setup.save({ presented: true });
    assert.equal(presented.reload, false); assert.equal(presented.setup.applied, false);
    assert.equal(await fs.readFile(f.stateFile, "utf8"), disk, "Progress-only entry is safe while reload is pending and leaves its confirmation intact");
    await assert.rejects(setup.save({ completed: true }), error => (error as { status: number }).status === 409);
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
    assert.equal((await request("POST", { "x-visitor-token": visitor.token }, { presented: true })).status, 403);
    const admin = { authorization: "Bearer fixture-admin-token" };
    assert.equal((await request("GET", admin)).status, 200); assert.equal((await request("DELETE", admin)).status, 405);
    assert.equal((await request("POST", admin, { config: { webui: { enabled: false } } })).status, 400);
    const entered = await Promise.all([request("POST", admin, { presented: true }), request("POST", admin, { presented: true })]);
    assert.ok(entered.every(response => response.status === 200));
    const claims = await Promise.all(entered.map(response => response.json())) as any[];
    assert.equal(claims.filter(result => result.firstPresentation === true).length, 1, "Concurrent browser claims have exactly one automatic presentation winner");
    assert.equal(claims.filter(result => result.firstPresentation === false).length, 1);
    const progress = claims[0];
    assert.equal(progress.reload, false); assert.equal(progress.setup.presented, true); assert.equal(progress.setup.shouldPrompt, false);
    const saved = await request("POST", admin, { dismissed: true }); assert.equal(saved.status, 200);
    assert.equal((await saved.json() as any).reload, false); assert.equal(f.calls(), 0);
  } finally { await server.stop(); await f.cleanup(); }
}

function configRevisions() {
  function reorder(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
    return value;
  }
  const config = Config({}), revision = configurationRevision(config);
  assert.match(revision, /^[a-f0-9]{64}$/);
  assert.equal(configurationRevision(reorder(config) as Config), revision, "Recursive object insertion order does not affect revisions");
  const withUndefined = { ...config, ignored: undefined, bot: { ...config.bot, ignored: undefined } };
  assert.equal(configurationRevision(withUndefined), revision, "Undefined object properties follow JSON semantics");
  const secretChange = structuredClone(config); secretChange.bot.apiKey = "revision-fixture-private-key";
  assert.notEqual(configurationRevision(secretChange), revision, "A secret-only rotation changes the revision");
  const outsideTour = structuredClone(config); outsideTour.apps.computer.docker.image = "different-image:latest";
  assert.notEqual(configurationRevision(outsideTour), revision, "Configuration outside tour steps is included");
  const ordered = structuredClone(config); ordered.bot.repeatExclude = ["first", "second"];
  const reversed = structuredClone(ordered); reversed.bot.repeatExclude.reverse();
  assert.notEqual(configurationRevision(ordered), configurationRevision(reversed), "Array order is significant");
}

async function httpConfigRevisions() {
  const f = await fixture();
  f.host.config.webui.host = "127.0.0.1"; f.host.config.webui.port = 0;
  let scheduled: Config | undefined;
  f.host.applyConfig = async next => { scheduled = next; return { message: "fixture queued reload", port: next.webui.port }; };
  const server: any = new WebUIServer(f.host as any);
  try {
    await server.start(); f.host.config.webui.port = server.server.address().port;
    const root = "http://127.0.0.1:" + f.host.config.webui.port, admin = { authorization: "Bearer fixture-admin-token" };
    const request = (method: string, headers = {}, body?: unknown) => fetch(root + "/api/config", { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await request("GET")).status, 401);
    const activeResponse = await request("GET", admin); assert.equal(activeResponse.status, 200);
    const active = await activeResponse.json() as any;
    assert.equal(active.revision, configurationRevision(f.host.config)); assert.equal(active.value.bot.apiKey, SECRET_MASK);
    await server.visitors.create("operator", "fixture-password", "operator");
    const visitor = await server.visitors.login("operator", "fixture-password");
    const visitorHeaders = { "x-visitor-token": visitor.token };
    const visitorResponse = await request("GET", visitorHeaders); assert.equal(visitorResponse.status, 200);
    assert.equal(Object.hasOwn(await visitorResponse.json(), "revision"), false, "Visitors with config grants never receive secret-derived revisions");
    assert.equal((await request("POST", visitorHeaders, { config: active.value })).status, 403);
    const roundtripResponse = await request("POST", admin, { config: active.value }); assert.equal(roundtripResponse.status, 200);
    assert.equal((await roundtripResponse.json() as any).revision, active.revision, "Unchanged masks are restored before hashing");
    const rotated = structuredClone(active.value); rotated.bot.apiKey = "revision-fixture-rotated-key";
    const savedResponse = await request("POST", admin, { config: rotated }); assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as any;
    assert.ok(scheduled); assert.equal(saved.revision, configurationRevision(scheduled)); assert.notEqual(saved.revision, active.revision);
    assert.ok(!JSON.stringify(saved).includes(rotated.bot.apiKey), "The response exposes only the revision, never the secret");
    assert.equal((await (await request("GET", admin)).json() as any).revision, active.revision, "An accepted but unapplied reload still reports the active old config");
    f.host.config = scheduled;
    assert.equal((await (await request("GET", admin)).json() as any).revision, saved.revision, "Confirmation succeeds only once the active host matches the saved revision");
    const outsideTour = structuredClone(rotated); outsideTour.apps.computer.docker.image = "outside-tour-change:latest";
    const extraResponse = await request("POST", admin, { config: outsideTour }); assert.equal(extraResponse.status, 200);
    assert.notEqual((await extraResponse.json() as any).revision, saved.revision, "The HTTP contract includes fields outside tour controls");
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
  configRevisions(); await firstPresentation(); await existingWorldHistory(); await progressAndValidation(); await mergingAndReload(); await failuresAndExplicitKeys(); await manuallyRecoveredReload(); await httpAuthorization(); await httpConfigRevisions(); await loaderPreflight();
  console.log("PASS WebUI setup: admin authorization, atomic first-run claims, canonical config revisions, safe patches, source credentials, restart confirmation, atomic rollback and loader preflight");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
