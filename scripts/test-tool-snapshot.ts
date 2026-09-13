import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { BotContext } from "../src/bot/context.js";
import { ChatBackend } from "../src/bot/backend.js";
import { WorldFiles } from "../src/files.js";
import type { NamedToolDef } from "../src/bot/nativeTools.js";

const native = (name: string) => ({ content: "", tool_calls: [{ id: "call_fixture", type: "function", function: { name, arguments: '{"duration":3}' } }] });
const text = (name: string) => ({ content: JSON.stringify({ name, arguments: { label: "fixture" }, duration: 2 }) });
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-native-snapshot-"));
  const received: { raw: string; body: Record<string, any>; tools: string }[] = [];
  let reply: Record<string, unknown> = native("observe");
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push({ raw, body, tools: JSON.stringify(body.tools ?? null) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: reply }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const cfg = Config({});
    const files = new WorldFiles(dir); await files.ensure();
    const context = new BotContext(files, "固定工具区"); await context.load();
    await context.appendEvent({ id: context.nextEventId(), source: "system", content: "初始可用：observe、send", worldTime: 1 });
    const definitions: NamedToolDef[] = [
      { name: "observe", signature: "observe()", description: "最初的观察说明" },
      { name: "send", signature: "send(msg: string)", description: "明确发送" },
    ];
    const backend = new ChatBackend({ ...cfg.bot, baseURL: `http://127.0.0.1:${address.port}/v1`, model: "offline-snapshot-fixture", stream: false, nativeToolCalls: true }, ["observe", "send"], definitions);
    const initialSave = files.atomicWrite.bind(files); let prefixBlocked = true;
    files.atomicWrite = async (file, data) => { if (file === files.pinned && prefixBlocked) throw Error("fixed prefix write failed"); return initialSave(file, data); };
    await assert.rejects(backend.generate(context, "初始时刻"), /fixed prefix write failed/);
    assert.equal(received.length, 0, "HTTP cannot send a system/native prefix which failed persistence");
    prefixBlocked = false;
    const first = await backend.generate(context, "初始时刻"); assert.equal(first.name, "observe"); assert.equal(first.duration, 3);
    assert.deepEqual(first.arguments, {});
    const baseline = received[0]!;
    assert.deepEqual(baseline.body.tools.map((tool: any) => tool.function.name), ["observe", "send"]);
    // Catalogue/schema and eligibility both change. Neither may rewrite the provider tool prefix.
    const latest: NamedToolDef[] = [
      { name: "observe", signature: "observe(label?: string)", description: "更新后的观察说明" },
      { name: "dynamic_app_action", signature: "dynamic_app_action(label: string)", description: "运行期间新增工具", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
    ];
    const names = ["observe", "dynamic_app_action"];
    backend.setToolNames(names); backend.setToolDefs(latest);
    // Caller-owned arrays/objects changing later must not mutate the admitted catalogue either.
    names.length = 0; latest[1]!.inputSchema!.properties = { wrong: { type: "number" } };
    await context.appendEvent({ id: context.nextEventId(), source: "system", content: "send 已失效；新增 dynamic_app_action(label:string)，可用正文 JSON 调用", worldTime: 2 });
    reply = text("dynamic_app_action");
    assert.equal((await backend.generate(context, "后来的时刻")).name, "dynamic_app_action", "newly available tools work through body JSON before native declarations refresh");
    assert.equal(received.at(-1)!.tools, baseline.tools);
    assert.equal(received.at(-1)!.body.messages[0].content, baseline.body.messages[0].content);
    assert.ok(received.at(-1)!.body.messages[1].content.startsWith(baseline.body.messages[1].content));
    const beforeRestart = received.at(-1)!;
    const restartedContext = new BotContext(files, "新版工具描述"); await restartedContext.load();
    restartedContext.accountsProvider = () => "新的显示配置不会改写固定前缀";
    const restartedBackend = new ChatBackend({ ...cfg.bot, baseURL: `http://127.0.0.1:${address.port}/v1`, model: "offline-restart-fixture", stream: false, nativeToolCalls: false }, ["observe", "dynamic_app_action"], latest);
    await restartedBackend.generate(restartedContext, "重启之后的时刻");
    assert.equal(received.at(-1)!.tools, baseline.tools, "a new backend restores exact native declarations from the context window instead of applying current definitions early");
    assert.equal(restartedContext.generationUsesNativeTools(false), true, "disabling the protocol takes effect at compression, not partway through a saved window");
    assert.deepEqual(received.at(-1)!.body.messages, beforeRestart.body.messages, "actual HTTP system and message prefix survive process recreation");
    let nativeError = "", textError = "";
    reply = native("send");
    await assert.rejects(backend.generate(context, "T"), (error: Error) => { nativeError = error.message; return /send 此刻不可用/.test(error.message); });
    reply = text("send");
    await assert.rejects(backend.generate(context, "T"), (error: Error) => { textError = error.message; return /send 此刻不可用/.test(error.message); });
    assert.equal(textError, nativeError, "both protocols enforce current eligibility with the same truthful explanation");
    assert.ok(!nativeError.includes("先打开") && !nativeError.includes("尚未解锁"));
    reply = text("invented_tool"); await assert.rejects(backend.generate(context, "T"), /未知工具/);
    assert.ok(received.every(request => request.tools === baseline.tools), "actual HTTP tools bytes stay stable through additions, removals and parse errors");
    // A failed pinned save blocks HTTP generation. Recovery itself refreshes the native window,
    // including when applyCompression rejected before the agent could run its explicit hook.
    const atomic = files.atomicWrite.bind(files); let pinnedBlocked = true;
    files.atomicWrite = async (file, data) => {
      if (file === files.pinned && pinnedBlocked) throw Error("snapshot pinned save failed");
      return atomic(file, data);
    };
    const beforeFailure = received.length, beforeRevision = context.windowRevision;
    await assert.rejects(context.applyCompression({ historySummary: "已整理", memoryDigest: "能力变化已记录" }, 3), /snapshot pinned save failed/);
    reply = text("dynamic_app_action");
    await assert.rejects(backend.generate(context, "不应发送"), /snapshot pinned save failed/);
    assert.equal(received.length, beforeFailure, "no model request can bypass incomplete context recovery");
    assert.equal(context.windowRevision, beforeRevision, "failed commit never publishes a new fixed window");
    pinnedBlocked = false;
    assert.equal((await backend.generate(context, "新起点")).name, "dynamic_app_action");
    const refreshed = received.at(-1)!;
    assert.notEqual(refreshed.tools, baseline.tools);
    assert.deepEqual(refreshed.body.tools.map((tool: any) => tool.function.name), ["observe", "dynamic_app_action"]);
    assert.equal(refreshed.body.tools[0].function.description, "更新后的观察说明");
    assert.ok(refreshed.body.tools[1].function.parameters.properties.label);
    assert.equal(refreshed.body.tools[1].function.parameters.properties.wrong, undefined);
    assert.equal(context.windowRevision, beforeRevision + 1);

    // Even after pinned.json is saved, failure removing the commit marker must not expose a
    // half-switched window. Recover via an ordinary append, without resetToolSnapshot().
    backend.setToolNames(["observe"]); backend.setToolDefs([definitions[0]!]);
    await context.appendEvent({ id: context.nextEventId(), source: "system", content: "dynamic_app_action 已失效", worldTime: 4 });
    const remove = fs.rm; let cleanupBlocked = true;
    fs.rm = (async (file: any, options: any) => {
      if (file === files.contextCommit && cleanupBlocked) throw Error("snapshot commit cleanup failed");
      return remove(file, options);
    }) as typeof fs.rm;
    try {
      const beforeCleanup = received.length, cleanupRevision = context.windowRevision;
      await assert.rejects(context.applyCompression({ historySummary: "第二次整理", memoryDigest: "应用已关闭" }, 5), /snapshot commit cleanup failed/);
      await assert.rejects(backend.generate(context, "仍不应发送"), /snapshot commit cleanup failed/);
      assert.equal(received.length, beforeCleanup);
      assert.equal(context.windowRevision, cleanupRevision);
      cleanupBlocked = false;
      await context.appendEvent({ id: context.nextEventId(), source: "system", content: "整理后恢复", worldTime: 6 });
      reply = text("observe"); await backend.generate(context, "恢复后");
      assert.equal(context.windowRevision, cleanupRevision + 1);
      assert.deepEqual(received.at(-1)!.body.tools.map((tool: any) => tool.function.name), ["observe"]);
      assert.match(received.at(-1)!.body.messages[0].content, /第二次整理/);
    } finally { fs.rm = remove; }
    // An empty native snapshot is also frozen, rather than treated as "not initialized".
    const emptyFiles = new WorldFiles(path.join(dir, "empty")); await emptyFiles.ensure();
    const emptyContext = new BotContext(emptyFiles, ""); await emptyContext.load();
    const empty = new ChatBackend({ ...cfg.bot, baseURL: `http://127.0.0.1:${address.port}/v1`, model: "offline-empty-snapshot", stream: false, nativeToolCalls: true }, [], []);
    reply = text("observe"); await assert.rejects(empty.generate(emptyContext, "T"), /未知工具/); assert.equal(received.at(-1)!.body.tools, undefined);
    empty.setToolDefs(definitions); empty.setToolNames(["observe"]);
    assert.equal((await empty.generate(emptyContext, "T")).name, "observe"); assert.equal(received.at(-1)!.body.tools, undefined);
    empty.resetToolSnapshot(); await empty.generate(emptyContext, "T"); assert.equal(received.at(-1)!.body.tools, undefined, "a backend-only reset cannot override the durable native prefix mid-window");
    await emptyContext.applyCompression({ historySummary: "新窗口", memoryDigest: "" }, 10);
    await empty.generate(emptyContext, "T"); assert.deepEqual(received.at(-1)!.body.tools.map((tool: any) => tool.function.name), ["observe"]);
    // A text-only backend follows the same current-availability checks and never sends native tools.
    const textFiles = new WorldFiles(path.join(dir, "text")); await textFiles.ensure();
    const textContext = new BotContext(textFiles, ""); await textContext.load();
    const bodyOnly = new ChatBackend({ ...cfg.bot, baseURL: `http://127.0.0.1:${address.port}/v1`, model: "offline-text-snapshot", stream: false, nativeToolCalls: false }, ["observe", "send"], definitions);
    bodyOnly.setToolNames(["observe"]); reply = text("send");
    await assert.rejects(bodyOnly.generate(textContext, "T"), (error: Error) => error.message === nativeError);
    assert.equal(received.at(-1)!.body.tools, undefined);
    const textPrefix = received.at(-1)!.body.messages[0].content;
    const restoredText = new BotContext(textFiles, ""); await restoredText.load();
    const turnNativeOn = new ChatBackend({ ...cfg.bot, baseURL: `http://127.0.0.1:${address.port}/v1`, model: "offline-toggle-fixture", stream: false, nativeToolCalls: true }, ["observe"], definitions);
    reply = text("observe"); await turnNativeOn.generate(restoredText, "新时间");
    assert.equal(received.at(-1)!.body.tools, undefined);
    assert.equal(received.at(-1)!.body.messages[0].content, textPrefix);
    await restoredText.applyCompression({ historySummary: "开启原生协议", memoryDigest: "" }, 20);
    await turnNativeOn.generate(restoredText, "新窗口");
    assert.deepEqual(received.at(-1)!.body.tools.map((tool: any) => tool.function.name), ["observe"]);
    assert.match(received.at(-1)!.body.messages[0].content, /已有原生声明的能力使用 function calling/);
    const turnNativeOff = new ChatBackend({ ...cfg.bot, baseURL: `http://127.0.0.1:${address.port}/v1`, model: "offline-toggle-fixture", stream: false, nativeToolCalls: false }, ["observe"], definitions);
    await turnNativeOff.generate(restoredText, "仍在同一窗口");
    assert.ok(received.at(-1)!.body.tools?.length);
    await restoredText.applyCompression({ historySummary: "关闭原生协议", memoryDigest: "" }, 21);
    await turnNativeOff.generate(restoredText, "下一窗口");
    assert.equal(received.at(-1)!.body.tools, undefined);
    assert.match(received.at(-1)!.body.messages[0].content, /本次使用正文 JSON 协议/);
    console.log("PASS native tool snapshots: stable HTTP prefix, blocked requests during pinned/commit cleanup failures, automatic recovery cutover, updated validation, body JSON fallback and empty snapshots");
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
