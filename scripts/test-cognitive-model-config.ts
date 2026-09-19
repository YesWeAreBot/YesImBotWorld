/** Local HTTP only: independent background models, credentials, endpoint locks and accounting. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config, type BotModelConfig } from "../src/config.js";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { GrowthRuntime } from "../src/bot/growth-runtime.js";
import { RegulationModel } from "../src/bot/regulation-model.js";
import { createState } from "../src/bot/regulation-core.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { WorldFiles } from "../src/files.js";
import { setEndpointLockEnabled, withEndpointLock } from "../src/llm/lock.js";
import { resolveCognitiveModelConfig } from "../src/llm/cognitive-config.js";
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
    const body = JSON.parse(raw), payload = JSON.parse(body.messages[1].content);
    requests.push({ endpoint: name, path: req.url ?? "", authorization: req.headers.authorization, body });
    const result = payload.proposed ? { appraisals: [], candidates: [{ id: "proposed", contextKey: "等待实际信息", conditionalEffects: {},
      probability: .5, cost: .1, risk: .1, explanation: "只预测尚未执行的原动作。" }] } : { changes: [] };
    const content = JSON.stringify(result), usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };
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
    regulation: { enabled: true, decisionEnabled: true, timeoutMs: 2000, maxInputChars: 64000, candidateCount: 3,
      learningRate: .3, driftRate: 0, sexualResponseEnabled: false }, ...extra } as BotModelConfig;
}
async function fixture(cfg: BotModelConfig) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-cognitive-config-")); dirs.push(base);
  const files = new WorldFiles(base); await files.ensure(); await fs.writeFile(files.botDef, "人物保留既有承诺，只依据真实经历整理认识。");
  const context = new BotContext(files); await context.load();
  const ledger = new GrowthLedger(base);
  const event: BotEvent = { id: "fixture-delivered-perception", source: "world", worldTime: 10, content: "你刚完成桌面整理。", originEventIds: ["fixture-real-result"],
    experience: { agency: "self", outcome: "completed", opportunity: true, episodeId: "fixture-episode", action: "整理桌面", situation: "整理物品以后" } };
  await context.appendEvent(event); await ledger.perceive(event);
  const warnings: string[] = [];
  const growth = new GrowthRuntime(ledger, cfg, { now: () => 10, unitWorldSeconds: 1 }, context, { warn: (...values: unknown[]) => warnings.push(values.map(String).join(" ")) }, { realNow: () => 100 });
  runtimes.push(growth);
  const regulation = new RegulationModel(cfg, context);
  return { cfg, warnings, context, ledger,
    async growth() { growth.tick(undefined, true); await growth.settled(); assert.deepEqual(warnings, []); },
    async regulation() { return regulation.evaluate({ events: [event], state: createState(10), proposed: { name: "wait", arguments: { n: 1 } },
      tools: BOT_TOOLS.filter(tool => tool.name === "wait"), at: 10, secondsPerTU: 1 }); },
  };
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
  assert.equal(request.body.tools, undefined, "background evaluators retain their read-only JSON protocol");
}

async function defaultsAndInvalidConfiguration(botURL: string, growthURL: string, regulationURL: string) {
  const defaults = Config({ autoStart: false });
  const secretPaths = collectSecretPaths(introspect(Config));
  for (const kind of ["growth", "regulation"] as const) {
    assert.ok(secretPaths.includes(`bot.${kind}.llm.apiKey`), "independent credentials participate in the existing WebUI mask/restore mechanism");
    assert.equal(defaults.bot[kind].llm?.mode, "inherit", "existing installations keep using the Bot model by default");
    const effective = resolveCognitiveModelConfig(defaults.bot, kind);
    assert.equal(effective.baseURL, defaults.bot.baseURL); assert.equal(effective.model, defaults.bot.model);
    assert.equal(effective.label, kind === "growth" ? "Growth" : "Regulation");
  }
  const configured = Config({ autoStart: false, bot: {
    growth: { llm: { mode: "independent", baseURL: growthURL, model: "default-growth-model" } },
    regulation: { llm: { mode: "independent", baseURL: regulationURL, model: "default-regulation-model" } },
  } });
  for (const kind of ["growth", "regulation"] as const) {
    const effective = resolveCognitiveModelConfig(configured.bot, kind);
    assert.equal(effective.temperature, .3); assert.equal(effective.maxTokens, 4096);
    assert.equal(effective.stream, true); assert.equal(effective.disableThinking, false); assert.equal(effective.apiKey ?? "", "");
  }
  const cfg = independentConfig(botURL, growthURL, regulationURL, "snapshot");
  const frozen = resolveCognitiveModelConfig(cfg, "growth");
  (cfg.growth as any).llm.baseURL = regulationURL; (cfg.growth as any).llm.apiKey = "changed-after-resolution";
  assert.equal(frozen.baseURL, growthURL); assert.equal(frozen.apiKey ?? "", "", "resolved transport values form a snapshot instead of retaining the mutable source object");

  for (const kind of ["growth", "regulation"] as const) {
    const missing = independentConfig(botURL, growthURL, regulationURL, `missing-${kind}`);
    delete (missing[kind] as any).llm.apiKey;
    assert.equal(resolveCognitiveModelConfig(missing, kind).apiKey ?? "", "", "an omitted independent credential is empty, never inherited from Bot");
    (missing[kind] as any).llm.baseURL = "   ";
    assert.throws(() => resolveCognitiveModelConfig(missing, kind), /URL|baseURL|地址/i, "independent mode never silently falls back to the Bot endpoint");
    (missing[kind] as any).llm.baseURL = growthURL; (missing[kind] as any).llm.model = "   ";
    assert.throws(() => resolveCognitiveModelConfig(missing, kind), /model|模型/i, "an empty independent model is a configuration error");
    (missing[kind] as any).llm.baseURL = "file:///not-an-llm"; (missing[kind] as any).llm.model = "fixture";
    assert.throws(() => resolveCognitiveModelConfig(missing, kind), /HTTP/);
    (missing[kind] as any).llm.mode = "mistyped-mode";
    assert.throws(() => resolveCognitiveModelConfig(missing, kind), /模式/, "unknown modes do not silently switch back to Bot credentials");
  }

  const disabled = independentConfig(botURL, growthURL, regulationURL, "disabled");
  disabled.growth.enabled = false; disabled.regulation.enabled = false;
  for (const subsystem of [disabled.growth, disabled.regulation]) (subsystem as any).llm = { mode: "independent", baseURL: "", apiKey: "", model: "" };
  const before = requests.length, f = await fixture(disabled);
  await f.growth(); await assert.rejects(f.regulation(), /尚未启用/);
  assert.equal(requests.length, before, "unused incomplete independent settings do not break constructors or contact an endpoint");
}

async function inheritedCompatibility(botURL: string) {
  for (const [tokens, expected] of [[1024, 2048], [16384, 8192], [0, 4096]]) {
    const cfg = config(botURL, { model: `fixture-inherit-${tokens}`, maxTokens: tokens });
    const f = await fixture(cfg); await f.growth(); await f.regulation();
    const recorded = byModel(cfg.model); assert.equal(recorded.length, 2);
    for (const request of recorded) generation(request, { endpoint: "Bot", model: cfg.model, key: cfg.apiKey, temperature: .4, tokens: expected, thinking: true, stream: true });
  }
  const cfg = config(botURL, { model: "fixture-explicit-inherit", temperature: .2, maxTokens: 5000, disableThinking: false, stream: false });
  for (const subsystem of [cfg.growth, cfg.regulation]) (subsystem as any).llm = { mode: "inherit", baseURL: "http://must-not-contact.invalid", apiKey: "must-not-use", model: "ignored-independent-fields", temperature: 1.8, maxTokens: 16000, disableThinking: true, stream: true };
  const f = await fixture(cfg); await f.growth(); await f.regulation();
  for (const request of byModel(cfg.model)) generation(request, { endpoint: "Bot", model: cfg.model, key: cfg.apiKey, temperature: .2, tokens: 5000, thinking: false, stream: false });
  assert.equal(byModel(cfg.model).length, 2);
}

function independentConfig(botURL: string, growthURL: string, regulationURL: string, suffix: string) {
  const cfg = config(botURL);
  (cfg.growth as any).llm = { mode: "independent", baseURL: growthURL, apiKey: "", model: `fixture-growth-${suffix}`, temperature: .83,
    maxTokens: 12345, disableThinking: false, stream: false };
  (cfg.regulation as any).llm = { mode: "independent", baseURL: regulationURL, apiKey: "fixture-regulation-key", model: `fixture-regulation-${suffix}`, temperature: .62,
    maxTokens: 1000, disableThinking: true, stream: true };
  return cfg;
}

async function independentIsolation(botURL: string, growthURL: string, regulationURL: string) {
  const cfg = independentConfig(botURL, growthURL, regulationURL, "isolated"), before = requests.filter(request => request.endpoint === "Bot").length;
  const f = await fixture(cfg), work: Promise<unknown>[] = [];
  let release!: () => void, held = false;
  const blocker = withEndpointLock(botURL, async () => { held = true; await new Promise<void>(resolve => { release = resolve; }); });
  await until(() => held);
  try {
    work.push(f.growth(), f.regulation());
    await until(() => byModel("fixture-growth-isolated").length === 1 && byModel("fixture-regulation-isolated").length === 1);
    await Promise.all(work);
  } finally { release(); await blocker; await Promise.allSettled(work); }
  assert.equal(requests.filter(request => request.endpoint === "Bot").length, before, "independent models do not use or wait on the Bot transport");
  generation(byModel("fixture-growth-isolated")[0]!, { endpoint: "Growth", model: "fixture-growth-isolated", temperature: .83, tokens: 12345, thinking: false, stream: false });
  generation(byModel("fixture-regulation-isolated")[0]!, { endpoint: "Regulation", model: "fixture-regulation-isolated", key: "fixture-regulation-key", temperature: .62, tokens: 1000, thinking: true, stream: true });
  assert.ok(callStore.recent().some(call => call.source === "Growth" && call.model === "fixture-growth-isolated" && call.status === "completed"));
  assert.ok(callStore.recent().some(call => call.source === "Regulation" && call.model === "fixture-regulation-isolated" && call.status === "completed"));
  const usage = usageStore.summary();
  assert.ok(usage.byLabel.Growth?.requests); assert.ok(usage.byLabel.Regulation?.requests);
  assert.equal(usage.byModel["fixture-growth-isolated"]?.requests, 1);
  assert.equal(usage.byModel["fixture-regulation-isolated"]?.requests, 1);

  const swappedCfg = independentConfig(botURL, growthURL, regulationURL, "empty-regulation-key");
  Object.assign((swappedCfg.growth as any).llm, { apiKey: "fixture-growth-own-key", stream: true, disableThinking: true });
  Object.assign((swappedCfg.regulation as any).llm, { apiKey: "", stream: false, disableThinking: false });
  const swapped = await fixture(swappedCfg); await swapped.growth(); await swapped.regulation();
  generation(byModel("fixture-growth-empty-regulation-key")[0]!, { endpoint: "Growth", model: "fixture-growth-empty-regulation-key", key: "fixture-growth-own-key", temperature: .83, tokens: 12345, thinking: true, stream: true });
  generation(byModel("fixture-regulation-empty-regulation-key")[0]!, { endpoint: "Regulation", model: "fixture-regulation-empty-regulation-key", temperature: .62, tokens: 1000, thinking: false, stream: false });

  const sameOriginCfg = independentConfig(botURL, botURL, botURL, "same-bot-origin");
  (sameOriginCfg.regulation as any).llm.apiKey = "";
  const sameOrigin = await fixture(sameOriginCfg); await sameOrigin.growth(); await sameOrigin.regulation();
  generation(byModel("fixture-growth-same-bot-origin")[0]!, { endpoint: "Bot", model: "fixture-growth-same-bot-origin", temperature: .83, tokens: 12345, thinking: false, stream: false });
  generation(byModel("fixture-regulation-same-bot-origin")[0]!, { endpoint: "Bot", model: "fixture-regulation-same-bot-origin", temperature: .62, tokens: 1000, thinking: true, stream: true });
}

async function independentEndpointLocks(botURL: string, growthURL: string, regulationURL: string) {
  const cfg = independentConfig(botURL, growthURL, regulationURL, "locks"), f = await fixture(cfg), work: Promise<unknown>[] = [];
  let release!: () => void, held = false;
  const blocker = withEndpointLock(growthURL.replace("/v1", "/another/path"), async () => { held = true; await new Promise<void>(resolve => { release = resolve; }); });
  await until(() => held);
  try {
    work.push(f.growth(), f.regulation());
    await until(() => byModel("fixture-regulation-locks").length === 1);
    assert.equal(byModel("fixture-growth-locks").length, 0, "Growth waits on its actual independent origin, including another base path");
  } finally { release(); await blocker; await Promise.all(work); }
  assert.equal(byModel("fixture-growth-locks").length, 1);

  const reverse = await fixture(independentConfig(botURL, growthURL, regulationURL, "reverse-locks"));
  held = false;
  const reverseBlocker = withEndpointLock(regulationURL, async () => { held = true; await new Promise<void>(resolve => { release = resolve; }); });
  await until(() => held);
  const reverseWork: Promise<unknown>[] = [];
  try {
    reverseWork.push(reverse.growth(), reverse.regulation());
    await until(() => byModel("fixture-growth-reverse-locks").length === 1);
    assert.equal(byModel("fixture-regulation-reverse-locks").length, 0, "Regulation waits on its independent origin while Growth proceeds");
  } finally { release(); await reverseBlocker; await Promise.all(reverseWork); }
  assert.equal(byModel("fixture-regulation-reverse-locks").length, 1);
}

async function main() {
  try {
    setEndpointLockEnabled(true);
    const botURL = await endpoint("Bot"), growthURL = await endpoint("Growth"), regulationURL = await endpoint("Regulation");
    await defaultsAndInvalidConfiguration(botURL, growthURL, regulationURL);
    await inheritedCompatibility(botURL); await independentIsolation(botURL, growthURL, regulationURL); await independentEndpointLocks(botURL, growthURL, regulationURL);
    console.log("PASS cognitive model configuration: inherited clamps, independent HTTP credentials/generation/streaming, actual-origin locks and Growth/Regulation accounting.");
  } finally {
    for (const runtime of runtimes) runtime.stop();
    await Promise.allSettled(runtimes.map(runtime => runtime.settled()));
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
