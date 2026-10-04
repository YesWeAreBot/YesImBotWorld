/** Actual application constructors against loopback providers; no real model or live-world access. */
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { BotContext } from "../src/bot/context.js";
import { ChatBackend } from "../src/bot/backend.js";
import { WorldAgent } from "../src/world/agent.js";
import { WorldClock } from "../src/clock.js";
import { WorldFiles } from "../src/files.js";
import { Prompts } from "../src/prompts.js";
import { CaptionService } from "../src/media/captioner.js";
import { MediaStore } from "../src/media/store.js";
import { AssistantApp } from "../src/apps/assistant.js";
import { CameraApp } from "../src/apps/camera.js";
import type { ChatApiType } from "../src/llm/protocol.js";
import { introspect } from "../src/webui/schema.js";

const protocols: ChatApiType[] = ["chat-completions", "responses", "anthropic"];
const paths = { "chat-completions": "/v1/chat/completions", responses: "/v1/responses", anthropic: "/v1/messages" };
const warnings: string[] = [];
const logger: any = { info() {}, debug() {}, error() {}, warn(...args: unknown[]) { warnings.push(args.map(String).join(" ")); } };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=", "base64");
const requests: { path: string; headers: IncomingHttpHeaders; body: any }[] = [];
function message(text: string) {
  return { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}
function responses(text: string) {
  return { id: "resp_fixture", object: "response", status: "completed", output: [message(text)], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } };
}
function anthropic(text: string, model: string) {
  return { id: "msg_fixture", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 8 } };
}
function send(res: ServerResponse, api: ChatApiType, body: any, text: string) {
  const data = api === "responses" ? responses(text) : api === "anthropic" ? anthropic(text, body.model)
    : { choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
  if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type: string, fields: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  if (api === "responses") {
    event("response.created", { response: { id: "resp_fixture", status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: { ...message(text), status: "in_progress", content: [] } });
    event("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
    event("response.output_text.delta", { item_id: "msg_fixture", output_index: 0, content_index: 0, delta: text });
    event("response.output_text.done", { item_id: "msg_fixture", output_index: 0, content_index: 0, text });
    event("response.content_part.done", { output_index: 0, content_index: 0, part: message(text).content[0] });
    event("response.output_item.done", { output_index: 0, item: message(text) });
    event("response.completed", { response: data });
  } else if (api === "anthropic") {
    event("message_start", { message: { ...anthropic(text, body.model), content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } });
    event("message_stop", {});
  } else {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error("loopback task did not complete");
}
function schemaDefaults() {
  const cfg = Config({ autoStart: false });
  const groups = [cfg.bot, cfg.world, cfg.bot.growth.llm, cfg.apps.assistant, ...Object.values(cfg.captioners)];
  for (const group of groups) assert.equal(group!.apiType, "chat-completions", "existing configurations keep the old protocol");
  assert.equal(cfg.captioners.audio.api, "transcription", "audio transcription remains a separate API choice");
  assert.equal((cfg.apps.camera as any).apiType, undefined, "image generation is not an Anthropic/Responses conversation API");
  for (const apiType of protocols) {
    const selected = Config({ bot: { apiType, growth: { llm: { apiType } } }, world: { apiType }, apps: { assistant: { apiType } },
      captioners: { image: { apiType }, audio: { apiType, api: "chat" }, video: { apiType } } });
    for (const group of [selected.bot, selected.world, selected.bot.growth.llm, selected.apps.assistant, ...Object.values(selected.captioners)]) assert.equal(group!.apiType, apiType);
    assert.equal(selected.captioners.audio.api, "chat");
  }
  assert.throws(() => Config({ world: { apiType: "messages" } }), /apiType|expected|Expected|value/i);
  const schema = JSON.stringify(introspect(Config));
  for (const name of ["OpenAI Chat Completions", "OpenAI Responses", "Anthropic Messages"]) assert.ok(schema.includes(name));
}
function mediaStore(directory: string) {
  const rows: any[] = [];
  const matches = (row: any, query: any) => Object.entries(query).every(([key, value]) => row[key] === value);
  const ctx: any = { model: { extend() {} }, database: {
    async get(_table: string, query: any) { return rows.filter(row => matches(row, query)).map(row => ({ ...row })); },
    async set(_table: string, query: any, values: any) { for (const row of rows) if (matches(row, query)) Object.assign(row, values); },
    async create(_table: string, values: any) { const row = { id: rows.length + 1, ...values }; rows.push(row); return { ...row }; },
  } };
  return new MediaStore(ctx, directory, 100_000, logger);
}
async function exercise(apiType: ChatApiType, root: string, directory: string) {
  const cfg = Config({ autoStart: false });
  // Vary accepted URL forms across real constructors. Every route must normalize to exactly /v1/<protocol>.
  const llm = { apiType, apiKey: `fixture-${apiType}-key`, temperature: .35, maxTokens: 2048, stream: false, disableThinking: false };
  Object.assign(cfg.bot, llm, { baseURL: root, model: "fixture-bot", nativeToolCalls: false });
  Object.assign(cfg.world, llm, { baseURL: root + paths[apiType], model: "fixture-world" });
  Object.assign(cfg.apps.assistant, llm, { baseURL: root + "/v1", model: "fixture-assistant", mode: "independent" });
  Object.assign(cfg.captioners.image, llm, { baseURL: root + paths[apiType], model: "fixture-caption", enabled: true });
  const files = new WorldFiles(directory); await files.ensure(); await fs.writeFile(files.botDef, "名字是配置测试角色。只用于离线测试。");
  const context = new BotContext(files); await context.load();
  const bot = new ChatBackend(cfg.bot, ["think"]);
  const result = await bot.generate(context, "测试时间");
  assert.equal(result.name, "think");
  if (apiType === "anthropic") {
    const initialRequest = structuredClone(requests.at(-1)!.body);
    const cue = context.stream.flatMap(entry => entry.kind === "event" && entry.event.generationCue ? [entry.event] : []);
    assert.equal(cue.length, 1, "an empty Anthropic window gets one durable next-turn cue");
    assert.equal(cue[0]!.content, "请选择下一步。"); assert.equal(cue[0]!.experience, undefined); assert.deepEqual(cue[0]!.originEventIds, []);
    assert.deepEqual(initialRequest.messages, [{ role: "user", content: [{ type: "text", text: "请选择下一步。" }] }]);
    assert.ok(!context.serializeForCompression().includes("请选择下一步。"));
    await context.appendEvent({ id: "fixture-visible-scene", source: "world", worldTime: 1, content: "你站在测试房间里，眼前是一面白墙。" });
    await bot.generate(context, "稍后的测试时间");
    const extendedRequest = structuredClone(requests.at(-1)!.body);
    assert.deepEqual(extendedRequest.system, initialRequest.system);
    assert.deepEqual(extendedRequest.messages.slice(0, initialRequest.messages.length), initialRequest.messages, "real input extends the persisted cue instead of replacing a synthetic transport suffix");
    const restored = new BotContext(files); await restored.load();
    await new ChatBackend(cfg.bot, ["think"]).generate(restored, "重启后的测试时间");
    assert.deepEqual(requests.at(-1)!.body, extendedRequest, "a restored window retains the exact request and does not duplicate the cue");
    assert.equal(restored.stream.filter(entry => entry.kind === "event" && entry.event.generationCue).length, 1);
    assert.ok(Number(restored.nextEventId().slice(3)) > Number(cue[0]!.id.slice(3)), "the initial cue counter survives restart");
  } else assert.equal(context.stream.length, 0, "other protocols keep their existing empty-window behavior");
  const clock = new WorldClock(cfg.clock, files.clock);
  const world = new WorldAgent(cfg.world, files, clock, logger, new Prompts());
  try { await world.ensureBotName(); assert.equal((await files.readMeta()).botName, "配置测试角色"); } finally { world.stop(); }
  const media = mediaStore(path.join(directory, "assets"));
  const id = await media.ingest(`data:image/png;base64,${png.toString("base64")}`, "image"); assert.ok(id);
  const ref = (await media.get(id))!.ref;
  const caption = new CaptionService(cfg.captioners, cfg.media, media, logger);
  assert.equal(await caption.describe(ref), "这是离线测试图片。");
  const beforeCache = requests.length;
  assert.equal(await caption.describe(ref), "这是离线测试图片。"); assert.equal(requests.length, beforeCache);
  const assistant = new AssistantApp({ historyFile: files.phoneAssistant, llm: cfg.apps.assistant });
  try {
    await assistant.call("ask", { question: "仅验证配置路由。" }); await until(() => !assistant.viewState().busy);
    assert.equal(assistant.viewState().jobs[0]!.status, "completed");
    assert.equal(assistant.viewState().jobs[0]!.reply, "配置已正确传入。");
  } finally { await assistant.dispose(); }
  // A declined composition still proves the World protocol reaches the brief generator; the image API is never called.
  const camera = new CameraApp({ imageConfig: cfg.apps.camera, briefLlm: { ...cfg.world, model: "fixture-camera" }, media, gallery: {} as any,
    getScene: () => ({ visible: "眼前只有白墙。", appearance: "", actorName: "配置测试角色" }),
    imageClient: { async generate() { throw Error("image generation must not be called for a declined brief"); } } });
  try {
    await camera.call("take_photo", { subject: "墙外的树" }); await until(() => !camera.viewState().busy);
    assert.equal(camera.viewState().jobs[0]!.status, "failed"); assert.match(camera.viewState().jobs[0]!.error!, /看不到墙外/);
  } finally { await camera.dispose(); }
  const routed = requests.filter(request => request.headers.authorization === `Bearer ${llm.apiKey}` || request.headers["x-api-key"] === llm.apiKey);
  assert.deepEqual(routed.map(request => request.body.model), ["fixture-bot", ...(apiType === "anthropic" ? ["fixture-bot", "fixture-bot"] : []), "fixture-world", "fixture-caption", "fixture-assistant", "fixture-camera"]);
  for (const request of routed) {
    assert.equal(request.path, paths[apiType]);
    if (apiType === "anthropic") {
      assert.equal(request.headers.authorization, undefined); assert.equal(request.headers["anthropic-version"], "2023-06-01");
    } else { assert.equal(request.headers["x-api-key"], undefined); assert.equal(request.headers["anthropic-version"], undefined); }
    assert.equal(typeof request.body.temperature, apiType === "chat-completions" ? "number" : "undefined");
  }
  const imageRequest = routed.find(request => request.body.model === "fixture-caption")!.body;
  if (apiType === "anthropic") assert.equal(imageRequest.messages[0].content[1].source.data, png.toString("base64"));
  else if (apiType === "responses") assert.equal(imageRequest.input[0].content[1].image_url, `data:image/png;base64,${png.toString("base64")}`);
  else assert.equal(imageRequest.messages[0].content[1].image_url.url, `data:image/png;base64,${png.toString("base64")}`);
}
async function main() {
  schemaDefaults();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-provider-config-"));
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ path: req.url!, headers: req.headers, body });
      const api = protocols.find(protocol => req.url === paths[protocol]); assert.ok(api, "unexpected provider URL");
      const texts: Record<string, string> = { "fixture-bot": '{"name":"think","arguments":{"thought":"先考虑实际情况。"}}',
        "fixture-world": '{"name":"配置测试角色"}', "fixture-caption": "这是离线测试图片。", "fixture-assistant": "配置已正确传入。",
        "fixture-camera": '{"canPhotograph":false,"brief":"","reason":"看不到墙外。"}' };
      assert.ok(texts[body.model]); send(res, api, body, texts[body.model]!);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const root = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    for (const apiType of protocols) await exercise(apiType, root, path.join(directory, apiType));
    assert.deepEqual(warnings, []);
    console.log("PASS provider config: seven schema groups; real Bot/World/captioner/assistant/camera constructors route all three protocols with isolated auth and correct image payloads.");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
