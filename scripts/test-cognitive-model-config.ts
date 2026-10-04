/** Local HTTP only: Growth model credentials, endpoint locks and accounting. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config, type BotModelConfig } from "../src/config.js";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { GrowthRuntime } from "../src/bot/growth-runtime.js";
import { WorldFiles } from "../src/files.js";
import { setEndpointLockEnabled, withEndpointLock } from "../src/llm/lock.js";
import { resolveGrowthModelConfig } from "../src/llm/growth-config.js";
import type { BotEvent } from "../src/types.js";
import { callStore } from "../src/webui/calls.js";
import { usageStore } from "../src/webui/usage.js";
import { collectSecretPaths, introspect } from "../src/webui/schema.js";

interface Request { endpoint: string; path: string; authorization?: string; body: any }
const requests: Request[] = [], dirs: string[] = [], servers: Server[] = [], runtimes: GrowthRuntime[] = [];
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(5); }
  throw Error("isolated endpoint did not reach the expected state");
}
async function endpoint(name: string): Promise<string> {
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ endpoint: name, path: req.url ?? "", authorization: req.headers.authorization, body });
    const content = JSON.stringify({ changes: [] }), usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1`;
}
function config(botURL: string, extra: Partial<BotModelConfig> = {}): BotModelConfig {
  return { baseURL: botURL, model: "fixture-bot-inherited", apiKey: "fixture-bot-private-key", temperature: 1.2, maxTokens: 1024,
    disableThinking: true, stream: true,
    growth: { enabled: true, minEpisodes: 1, reviewIntervalMs: 1, reviewTimeoutMs: 2000, maxInputChars: 64000, recallCount: 0 },
    ...extra } as BotModelConfig;
}
async function fixture(cfg: BotModelConfig) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-growth-config-")); dirs.push(base);
  const files = new WorldFiles(base); await files.ensure(); await fs.writeFile(files.botDef, "人物保留既有承诺，只依据真实经历整理认识。");
  const context = new BotContext(files); await context.load();
  const ledger = new GrowthLedger(base);
  const event: BotEvent = { id: "fixture-delivered-perception", source: "world", worldTime: 10, content: "你刚完成桌面整理。", originEventIds: ["fixture-real-result"],
    experience: { agency: "self", outcome: "completed", opportunity: true, episodeId: "fixture-episode", action: "整理桌面", situation: "整理物品以后" } };
  await context.appendEvent(event); await ledger.perceive(event);
  const warnings: string[] = [];
  const growth = new GrowthRuntime(ledger, cfg, { now: () => 10, unitWorldSeconds: 1 }, context,
    { warn: (...values: unknown[]) => warnings.push(values.map(String).join(" ")) }, { realNow: () => 100 });
  runtimes.push(growth);
  return { async growth() { growth.tick(undefined, true); await growth.settled(); assert.deepEqual(warnings, []); } };
}
function byModel(model: string): Request[] { return requests.filter(request => request.body.model === model); }
function generation(request: Request, expected: { endpoint: string; model: string; key?: string; temperature: number; tokens: number; thinking: boolean; stream: boolean }) {
  assert.equal(request.endpoint, expected.endpoint); assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.body.model, expected.model);
  assert.equal(request.authorization, expected.key ? `Bearer ${expected.key}` : undefined);
  assert.equal(request.body.temperature, expected.temperature); assert.equal(request.body.max_tokens, expected.tokens);
  assert.equal(request.body.stream === true, expected.stream);
  assert.equal(request.body.enable_thinking === false, expected.thinking);
  assert.equal(request.body.chat_template_kwargs?.enable_thinking === false, expected.thinking);
  assert.equal(request.body.tools, undefined, "Growth retains its read-only JSON protocol");
}
function independentConfig(botURL: string, growthURL: string, suffix: string) {
  const cfg = config(botURL);
  cfg.growth.llm = { mode: "independent", baseURL: growthURL, apiKey: "", model: `fixture-growth-${suffix}`, temperature: .83,
    maxTokens: 12345, disableThinking: false, stream: false };
  return cfg;
}

async function defaultsAndInvalidConfiguration(botURL: string, growthURL: string) {
  const defaults = Config({ autoStart: false });
  const schema = introspect(Config), secretPaths = collectSecretPaths(schema);
  assert.ok(secretPaths.includes("bot.growth.llm.apiKey"), "independent credentials retain WebUI mask/restore protection");
  assert.ok(!JSON.stringify(schema).includes('"regulation"'), "retired configuration must not be offered by either UI");
  assert.equal(defaults.bot.growth.llm?.mode, "inherit");
  assert.equal(defaults.bot.apiType, "chat-completions");
  assert.equal(defaults.bot.growth.llm?.apiType, "chat-completions");
  const effective = resolveGrowthModelConfig(defaults.bot);
  assert.equal(effective.apiType, "chat-completions");
  assert.equal(effective.baseURL, defaults.bot.baseURL); assert.equal(effective.model, defaults.bot.model); assert.equal(effective.label, "Growth");
  const configured = Config({ autoStart: false, bot: { growth: { llm: { mode: "independent", baseURL: growthURL, model: "default-growth-model" } } } });
  const independent = resolveGrowthModelConfig(configured.bot);
  assert.equal(independent.temperature, .3); assert.equal(independent.maxTokens, 4096);
  assert.equal(independent.stream, true); assert.equal(independent.disableThinking, false); assert.equal(independent.apiKey ?? "", "");
  const cfg = independentConfig(botURL, growthURL, "snapshot");
  cfg.apiType = "responses";
  cfg.growth.llm!.apiType = "anthropic";
  const frozen = resolveGrowthModelConfig(cfg);
  cfg.growth.llm!.baseURL = botURL; cfg.growth.llm!.apiKey = "changed-after-resolution"; cfg.growth.llm!.apiType = "chat-completions";
  assert.equal(frozen.baseURL, growthURL); assert.equal(frozen.apiKey ?? "", "", "transport resolution copies rather than retaining mutable config");
  assert.equal(frozen.apiType, "anthropic", "independent protocol is captured with its own credentials");
  cfg.growth.llm!.mode = "inherit";
  assert.equal(resolveGrowthModelConfig(cfg).apiType, "responses", "inherit ignores the independent protocol draft");

  const missing = independentConfig(botURL, growthURL, "missing");
  delete (missing.growth.llm as any).apiKey;
  missing.apiType = "anthropic";
  assert.equal(resolveGrowthModelConfig(missing).apiType, "chat-completions", "old independent configuration defaults to Chat, not the parent's provider");
  assert.equal(resolveGrowthModelConfig(missing).apiKey ?? "", "", "an omitted independent key is never inherited from Bot");
  missing.growth.llm!.baseURL = "   ";
  assert.throws(() => resolveGrowthModelConfig(missing), /URL|baseURL|地址/i);
  missing.growth.llm!.baseURL = growthURL; missing.growth.llm!.model = "   ";
  assert.throws(() => resolveGrowthModelConfig(missing), /model|模型/i);
  missing.growth.llm!.baseURL = "file:///not-an-llm"; missing.growth.llm!.model = "fixture";
  assert.throws(() => resolveGrowthModelConfig(missing), /HTTP/);
  (missing.growth.llm as any).mode = "mistyped-mode";
  assert.throws(() => resolveGrowthModelConfig(missing), /模式/);

  const disabled = independentConfig(botURL, growthURL, "disabled");
  disabled.growth.enabled = false;
  Object.assign(disabled.growth.llm!, { baseURL: "", apiKey: "", model: "" });
  const before = requests.length, f = await fixture(disabled); await f.growth();
  assert.equal(requests.length, before, "disabled Growth neither validates incomplete settings nor contacts an endpoint");
}
async function inheritedCompatibility(botURL: string) {
  for (const [tokens, expected] of [[1024, 2048], [16384, 8192], [0, 4096]]) {
    const cfg = config(botURL, { model: `fixture-inherit-${tokens}`, maxTokens: tokens });
    const f = await fixture(cfg); await f.growth();
    const recorded = byModel(cfg.model); assert.equal(recorded.length, 1);
    generation(recorded[0]!, { endpoint: "Bot", model: cfg.model, key: cfg.apiKey, temperature: .4, tokens: expected, thinking: true, stream: true });
  }
  const cfg = config(botURL, { model: "fixture-explicit-inherit", temperature: .2, maxTokens: 5000, disableThinking: false, stream: false });
  cfg.growth.llm = { mode: "inherit", baseURL: "http://must-not-contact.invalid", apiKey: "must-not-use", model: "ignored-independent-fields", temperature: 1.8, maxTokens: 16000, disableThinking: true, stream: true };
  const f = await fixture(cfg); await f.growth();
  assert.equal(byModel(cfg.model).length, 1);
  generation(byModel(cfg.model)[0]!, { endpoint: "Bot", model: cfg.model, key: cfg.apiKey, temperature: .2, tokens: 5000, thinking: false, stream: false });
}
async function independentIsolation(botURL: string, growthURL: string) {
  const cfg = independentConfig(botURL, growthURL, "isolated"), before = requests.filter(request => request.endpoint === "Bot").length;
  const f = await fixture(cfg), work: Promise<unknown>[] = [];
  let release!: () => void, held = false;
  const blocker = withEndpointLock(botURL, async () => { held = true; await new Promise<void>(resolve => { release = resolve; }); });
  await until(() => held);
  try {
    work.push(f.growth());
    await until(() => byModel("fixture-growth-isolated").length === 1); await Promise.all(work);
  } finally { release(); await blocker; await Promise.allSettled(work); }
  assert.equal(requests.filter(request => request.endpoint === "Bot").length, before, "independent Growth does not use or wait on the Bot transport");
  generation(byModel("fixture-growth-isolated")[0]!, { endpoint: "Growth", model: "fixture-growth-isolated", temperature: .83, tokens: 12345, thinking: false, stream: false });
  assert.ok(callStore.recent().some(call => call.source === "Growth" && call.model === "fixture-growth-isolated" && call.status === "completed"));
  assert.ok(usageStore.summary().byLabel.Growth?.requests);
  assert.equal(usageStore.summary().byModel["fixture-growth-isolated"]?.requests, 1);

  const keyedCfg = independentConfig(botURL, growthURL, "own-key");
  Object.assign(keyedCfg.growth.llm!, { apiKey: "fixture-growth-own-key", stream: true, disableThinking: true });
  const keyed = await fixture(keyedCfg); await keyed.growth();
  generation(byModel("fixture-growth-own-key")[0]!, { endpoint: "Growth", model: "fixture-growth-own-key", key: "fixture-growth-own-key", temperature: .83, tokens: 12345, thinking: true, stream: true });

  const sameOrigin = await fixture(independentConfig(botURL, botURL, "same-bot-origin")); await sameOrigin.growth();
  generation(byModel("fixture-growth-same-bot-origin")[0]!, { endpoint: "Bot", model: "fixture-growth-same-bot-origin", temperature: .83, tokens: 12345, thinking: false, stream: false });
}
async function independentEndpointLock(botURL: string, growthURL: string) {
  const f = await fixture(independentConfig(botURL, growthURL, "locked"));
  let release!: () => void, held = false;
  const blocker = withEndpointLock(growthURL.replace("/v1", "/another/path"), async () => { held = true; await new Promise<void>(resolve => { release = resolve; }); });
  await until(() => held);
  let work: Promise<void> | undefined;
  try {
    work = f.growth(); await pause(40);
    assert.equal(byModel("fixture-growth-locked").length, 0, "Growth waits on its actual independent origin, including another base path");
  } finally { release(); await blocker; await work; }
  assert.equal(byModel("fixture-growth-locked").length, 1);
}
async function main() {
  try {
    setEndpointLockEnabled(true);
    const botURL = await endpoint("Bot"), growthURL = await endpoint("Growth");
    await defaultsAndInvalidConfiguration(botURL, growthURL);
    await inheritedCompatibility(botURL); await independentIsolation(botURL, growthURL); await independentEndpointLock(botURL, growthURL);
    console.log("PASS Growth model configuration: inherited clamps, independent credentials/generation/streaming, actual-origin locks and accounting.");
  } finally {
    for (const runtime of runtimes) runtime.stop();
    await Promise.allSettled(runtimes.map(runtime => runtime.settled()));
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
