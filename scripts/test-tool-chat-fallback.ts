/** Real chat-layer dispatch after a frozen native snapshot; no live model/platform/world. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ChatToolDef } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(test: () => boolean) { for (let i = 0; i < 300 && !test(); i++) await tick(); assert.ok(test(), "local dispatch did not finish"); }
const native = (name: string, args: Record<string, unknown>) => ({ content: "", toolCalls: [{ id: "fixture-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const body = (name: string, args: Record<string, unknown>) => ({ content: JSON.stringify({ name, arguments: args, duration: 0 }), toolCalls: [] });

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-chat-fallback-"));
  let agent: any;
  try {
    const files = new WorldFiles(dir); await files.ensure();
    const cfg = Config({ autoStart: false }); cfg.bot.nativeToolCalls = true; cfg.bot.ignoreSendDuration = true;
    const clock: any = { now: () => 1, timeLine: () => "T=1", realMsUntil: () => 0, unitRealSeconds: 1, unitWorldSeconds: 1 };
    const context = new BotContext(files, ""); await context.load();
    const definitions = BOT_TOOLS.filter(def => ["act", "observe_device", "open_app", "close_app", "check_msg", "select_channel", "read_channel", "send"].includes(def.name));
    const apps = new AppManager("chat", [], new Set(definitions.map(def => def.name)), logger);
    const sent: { channel: string; msg: string }[] = [];
    let reads = 0, worldCalls = 0;
    const messenger: any = {
      recentChannels: async () => ({ text: "onebot@fixture:channel — 本地频道列表", originEventIds: [] }),
      resolveKey: async (id: string) => { assert.equal(id, "onebot@fixture:channel"); return { key: id, isPrivate: true }; },
      channelMessages: async () => { reads++; return { text: "本地平台记录中的实际消息", originEventIds: [] }; },
      send: async (channel: string, msg: string) => { sent.push({ channel, msg }); return "本地适配器确认已发送"; },
    };
    const world: any = { adjudicateAct: async () => { worldCalls++; throw new Error("chat workflow must never be translated into a world act"); } };
    agent = new BotAgent(cfg, clock, files, context, world, messenger, apps, null, null, { down: false }, logger, definitions);
    agent.running = true; agent.setManualPaused(true); // No autonomous loop or maintenance model.
    const backend = agent.backend;
    const requests: { tools?: ChatToolDef[]; messages: unknown[] }[] = [];
    let response: any = native("open_app", { name: "chat" });
    backend.client = { complete: async (messages: unknown[], opts: { tools?: ChatToolDef[] }) => {
      requests.push(structuredClone({ messages, tools: opts.tools })); return response;
    } };
    async function execute(next: ReturnType<typeof native> | ReturnType<typeof body>) {
      response = next;
      const parsed = await backend.generate(context, "T=1");
      const call: ToolCallRecord = { ...parsed, id: context.nextToolId(), role: "agent", issuedAt: 1, expectedAt: 1 };
      await context.appendToolCall(call); await agent.dispatch(call);
      await until(() => !agent.scheduler.isPending(call.id));
      await agent.drainMailbox();
      return call;
    }
    await execute(response);
    const first = requests[0]!, prefix = JSON.stringify(first.tools), firstNames = first.tools!.map(tool => tool.function.name);
    assert.ok(firstNames.includes("open_app"));
    assert.equal(firstNames.includes("select_channel"), false);
    assert.equal(firstNames.includes("send"), false, "inactive chat tools remain absent from the initial native catalogue");
    assert.ok(context.stream.some(entry => entry.kind === "event" && /现在新增可用/.test(entry.event.content) && /select_channel/.test(entry.event.content)), "the delivered capability event explains the newly unlocked channel selector");
    assert.match(JSON.stringify(first.messages[0]), /正文 JSON/, "fallback protocol is taught once in the fixed block");

    assert.equal((await execute(body("select_channel", { id: "onebot@fixture:channel" }))).name, "select_channel");
    assert.equal(agent.status().phoneUi.channelKey, "onebot@fixture:channel");
    assert.ok(reads > 0);
    assert.ok(context.stream.some(entry => entry.kind === "event" && /现在新增可用/.test(entry.event.content) && /send\(/.test(entry.event.content)));
    assert.ok(context.stream.every(entry => entry.kind !== "event" || !entry.event.toolAvailability || !/原生 function 声明|正文 JSON/.test(entry.event.content)), "capability changes do not repeat the protocol preamble");
    await execute(body("read_channel", { n: 10 }));
    await execute(body("send", { msg: "实际写出的回复" }));
    assert.deepEqual(sent, [{ channel: "onebot@fixture:channel", msg: "实际写出的回复" }]);
    assert.equal(worldCalls, 0, "new native declarations are unnecessary: the real tools execute directly without act or another model");
    assert.ok(requests.some(request => JSON.stringify(request.messages).includes("正文") && JSON.stringify(request.messages).includes("select_channel")), "fallback guidance reaches the real model request, not only a local notice");
    assert.ok(requests.every(request => JSON.stringify(request.tools) === prefix), "unlocking and invoking chat layers keeps the original native tools bytes");
    assert.ok(requests.every(request => JSON.stringify(request.messages[0]) === JSON.stringify(first.messages[0])), "capability events do not rewrite the fixed system block");

    await execute(body("close_app", {}));
    assert.equal(agent.status().phoneUi.chatOpen, false);
    for (const name of ["select_channel", "send"]) {
      const args = name === "send" ? { msg: "must not be sent" } : { id: "onebot@fixture:channel" };
      response = body(name, args);
      const textParsed = await backend.generate(context, "T=1");
      response = native(name, args);
      const nativeParsed = await backend.generate(context, "T=1");
      assert.equal(textParsed.name, name); assert.equal(nativeParsed.name, name);
      assert.deepEqual(textParsed.arguments, args); assert.deepEqual(nativeParsed.arguments, args);
      assert.equal(agent.currentToolNames().includes(name), false, "a navigable candidate is still subject to the actual execution gate");
      if (name === "send") assert.match(await agent.prepareNavigation(textParsed, () => true), /缺少目标频道/,
        "closing the app cannot silently redirect a targetless send to the last chat or notification");
      assert.equal(agent.status().phoneUi.chatOpen, false, "parsing and rejected target resolution have no navigation side effect");
    }
    agent.tempBannedTools.add("send"); agent.refreshToolGate();
    let textError = "";
    response = body("send", { id: "onebot@fixture:channel", msg: "still forbidden" });
    await assert.rejects(backend.generate(context, "T=1"), (error: Error) => { textError = error.message; return error.message.includes("send 此刻不可用"); });
    response = native("send", { id: "onebot@fixture:channel", msg: "still forbidden" });
    await assert.rejects(backend.generate(context, "T=1"), (error: Error) => error.message === textError);
    assert.doesNotMatch(textError, /改用\s*act|通过\s*act/);
    assert.equal(sent.length, 1); assert.equal(worldCalls, 0);
    assert.ok(requests.every(request => JSON.stringify(request.tools) === prefix));
    console.log("PASS frozen native chat workflow: actual unlock guidance, select/read/send body JSON through current gates, local platform receipts, no world fallback and unchanged cached prefixes");
  } finally { await agent?.stop(); await fs.rm(dir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
