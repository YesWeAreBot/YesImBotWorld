/** Prompt contracts exercised through actual runtime inputs and local apps. No real inference. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Config } from "../src/config.js";
import { Prompts, BOT_PROMPT_DEFAULTS, WORLD_PROMPT_DEFAULTS } from "../src/prompts.js";
import { WorldFiles } from "../src/files.js";
import { WorldAgent } from "../src/world/agent.js";
import { ChatBackend } from "../src/bot/backend.js";
import { BotContext } from "../src/bot/context.js";
import { availableTools } from "../src/bot/tools.js";
import { toNativeToolDefs } from "../src/bot/nativeTools.js";
import { WebUIServer } from "../src/webui/server.js";
import { WeatherApp } from "../src/apps/weather.js";
import { FileManagerApp } from "../src/apps/files.js";
import { TerminalApp } from "../src/apps/terminal.js";
import { BrowserApp } from "../src/apps/browser.js";

const logger = { info() {}, warn() {}, error() {} } as any;
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-prompt-contract-"));
  let world: WorldAgent | undefined;
  try {
    const original = { bot: { constitutionHead: "保留用户前言" }, world: { system: "旧 send_event 模板", presentationSystem: "只读用户覆盖" } };
    await fs.writeFile(path.join(dir, "prompts.json"), JSON.stringify(original));
    const prompts = await Prompts.load(dir);
    assert.equal(prompts.bot.constitutionHead, original.bot.constitutionHead);
    assert.ok(!("system" in prompts.world));
    await Prompts.save(dir, prompts.get());
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "prompts.legacy.json"), "utf8")), original);
    await Prompts.save(dir, { bot: {}, world: {} });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "prompts.legacy.json"), "utf8")), original);

    const cfg = Config({ autoStart: false }); cfg.webui.token = "prompt-fixture";
    const files = new WorldFiles(path.join(dir, "world")); await files.ensure(); await files.writeMeta({ realWorld: false } as any);
    const clock = { now: () => 10, timeLine: () => "T=10", syncRealTime: false, realMsUntil: () => 0 } as any;
    world = new WorldAgent(cfg.world, files, clock, logger, prompts);
    const kernel = await world.structured.kernel();
    await kernel.commit({ idempotencyKey: "seed", operations: [
      { op: "create", entity: { id: "room", kind: "place", name: "房间", location: null } },
      { op: "create", entity: { id: "bot", kind: "actor", name: "角色", controller: "bot", location: "room" } },
    ] });
    const seen: any[] = [];
    (world as any).client = { complete: async (messages: any[], options: any = {}) => {
      seen.push({ messages, options });
      return options.tools?.length ? { content: "", toolCalls: [{ id: "p", type: "function", function: { name: "propose_world", arguments: '{"operations":[]}' } }] } : { content: "未知", toolCalls: [] };
    } };
    for (const version of ["A", "B"]) {
      prompts.setOverrides({ bot: { constitutionHead: version }, world: { adjudicationSystem: "裁定-" + version, presentationSystem: "呈现-" + version } });
      await world.structured.evolve("无事发生"); await world.query("天气查询");
      assert.ok(seen.at(-2).messages[0].content.startsWith("裁定-" + version));
      assert.deepEqual(seen.at(-2).options.tools.map((t: any) => t.function.name), ["propose_world"]);
      assert.equal(seen.at(-1).messages[0].content, "呈现-" + version);
      assert.equal(seen.at(-1).options.tools, undefined);
      const context = new BotContext(files, "", prompts); await context.load();
      assert.ok(context.renderSystemText("T=10").includes(version));
    }
    let failSave = false;
    const server: any = new WebUIServer({ config: cfg, webuiDir: dir, files, prompts: () => prompts, savePromptsOverrides: async (value: any) => { if (failSave) throw new Error("fixture disk failure"); await Prompts.save(dir, value); } } as any);
    async function request(method: string, body?: unknown) {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as any;
      Object.assign(req, { method, url: "/api/prompts", headers: { authorization: "Bearer prompt-fixture" } });
      let status = 0, output = "";
      await server.handle(req, { writeHead(code: number) { status = code; }, end(text: unknown) { output = String(text); }, setHeader() {} });
      return { status, data: JSON.parse(output) };
    }
    const response = await request("GET");
    assert.equal(response.data.defaults.bot.constitutionHead, BOT_PROMPT_DEFAULTS.constitutionHead);
    assert.equal(response.data.defaults.world.adjudicationSystem, WORLD_PROMPT_DEFAULTS.adjudicationSystem);
    assert.equal(response.data.overrides.world.adjudicationSystem, "裁定-B");
    failSave = true;
    await assert.rejects(request("POST", { overrides: { bot: { constitutionHead: "不能生效" }, world: {} } }), /fixture disk failure/);
    assert.equal(prompts.bot.constitutionHead, "B");
    failSave = false;
    await request("POST", { overrides: { bot: {}, world: {} } });
    assert.equal(prompts.bot.constitutionHead, BOT_PROMPT_DEFAULTS.constitutionHead);

    for (const nativeToolCalls of [false, true]) {
      const backend: any = new ChatBackend({ ...cfg.bot, nativeToolCalls }, ["observe"], [{ name: "observe", signature: "observe()", description: "观察" }]);
      let count = 0;
      backend.client = { complete: async (messages: any[], options: any) => {
        count++;
        const system = messages[0].content;
        if (nativeToolCalls) { assert.equal(options.tools[0].function.name, "observe"); assert.match(system, /调用接口（function calling）/); }
        else { assert.equal(options.tools, undefined); assert.match(system, /本次使用正文 JSON 协议/); }
        return { content: '{"name":"observe","arguments":{},"duration":0}', toolCalls: [] };
      } };
      const context = new BotContext(files, "", prompts); await context.load();
      assert.equal((await backend.generate(context, "T=10")).name, "observe"); assert.equal(count, 1);
      backend.client = { complete: async () => ({ content: "", toolCalls: [1, 2].map(i => ({ id: String(i), function: { name: "observe", arguments: "{}" } })) }) };
      await assert.rejects(backend.generate(context, "T=10"), /多个调用均未执行/);
    }
    const queries: string[] = [], actions: string[] = [];
    const appWorld = { query: async (task: string) => { queries.push(task); return "<html><title>未知</title><body>不可用</body></html>"; }, executeAppAction: async (task: string) => { actions.push(task); return "未执行"; } } as any;
    const computer = { ensureReady() { throw new Error("Virtual apps must not access real computer"); } } as any;
    const weather = new WeatherApp(appWorld, files, clock, cfg.apps, logger);
    const explorer = new FileManagerApp(computer, appWorld, files, clock, cfg.apps, logger);
    const terminal = new TerminalApp(computer, appWorld, files, clock, cfg.apps, logger);
    const browser = new BrowserApp({} as any, appWorld, files, clock, {} as any, {} as any, {} as any, () => false, cfg.apps, logger);
    await weather.call("query_weather", {}); await explorer.call("list", {}); await explorer.call("show", { path: "note", start: 21, max_lines: 5 }); await browser.call("open_url", { url: "https://fixture.invalid" });
    assert.equal(actions.length, 0, "read-only apps only use query");
    assert.equal(queries.length, 4);
    for (const task of queries) assert.doesNotMatch(task, /check world_status|send_event|update world_status|虚构但合理的网址/);
    assert.match(queries[2]!, /"start":21,"max_lines":5/);
    await terminal.call("run_command", { command: "cat note", cwd: "folder" });
    await explorer.call("write", { path: "note", content: "保留原文😀", append: true });
    assert.equal(actions.length, 2); assert.match(actions[0]!, /"cwd":"folder"/); assert.match(actions[1]!, /保留原文😀/);
    const open = await terminal.open(); assert.doesNotMatch(open.opening!, /走到|坐到/);
    const schema = { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["a", "b"] } } } } } };
    const native = toNativeToolDefs([{ name: "nested", signature: "nested(items: string)", description: "nested", inputSchema: schema }])[0]!;
    assert.deepEqual((native.function.parameters.properties as any).items, schema.properties.items);
    assert.equal(native.function.parameters.additionalProperties, false);
    assert.ok(!("duration" in schema.properties), "native conversion cannot mutate app schema");
    const tools = toNativeToolDefs(availableTools({ tts: false, ops: cfg.platformOps, ignoreSendDuration: true } as any));
    assert.match(tools.find(t => t.function.name === "send")!.function.description!, /忽略发送耗时/);
    assert.ok(!JSON.stringify(tools).includes("省略表示瞬间完成"));
    console.log("PASS prompts: live runtime overrides, real defaults/reset API, save failure isolation, legacy backup, read-only app boundaries and exact action arguments");
  } finally { await world?.structured.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
