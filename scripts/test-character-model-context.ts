/** Actual app -> WorldAgent -> model input, with local deterministic inference and no network. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WorldAgent } from "../src/world/agent.js";
import { BotContext } from "../src/bot/context.js";
import { CHAT_RUNTIME_GUIDANCE } from "../src/prompts.js";
import { FileManagerApp } from "../src/apps/files.js";
import { WeatherApp } from "../src/apps/weather.js";
import { BrowserApp } from "../src/apps/browser.js";
import { TerminalApp } from "../src/apps/terminal.js";
import { renderToolsText } from "../src/bot/tools.js";

const logger = { info() {}, warn() {}, error() {} } as any;
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-character-context-"));
  let world: WorldAgent | undefined;
  try {
    const cfg = Config({ autoStart: false }), files = new WorldFiles(dir);
    await files.ensure();
    assert.doesNotMatch(await files.readText(files.botDef), /\bBot\b|\bAgent\b/);
    assert.doesNotMatch(await files.readText(files.worldDef), /\bBot\b|\bAgent\b/);
    const authored = "小澈是图书管理员。Bot 是她给玩具起的名字；保留这句作者原文。";
    await files.atomicWrite(files.botDef, authored);
    await files.atomicWrite(files.worldDef, "小澈住在临海市。她的电脑有 note.txt，天气应用收录了今日小雨。网页已有图书馆公告。");
    await files.writeMeta({ realWorld: false });
    const clock = { now: () => 10, timeLine: () => "T10", syncRealTime: false, realMsUntil: () => 0 } as any;
    world = new WorldAgent(cfg.world, files, clock, logger);
    const requests: any[] = [];
    (world as any).client = { complete: async (messages: any[]) => {
      assert.equal(messages.length, 2, "World calls have fresh contexts");
      assert.match(messages[0].content, /<character_definition>/);
      assert.doesNotMatch(messages[0].content, /<\/?bot_definition>/);
      assert.ok(messages[0].content.includes(authored), "author content is never rewritten to hide a matching word");
      const input = JSON.parse(messages[1].content); requests.push(input);
      for (const actor of input.actors) {
        assert.equal(Object.hasOwn(actor, "controller"), false, "control provenance is not a fictional identity");
        assert.ok(Object.keys(actor).every(key => ["id", "name", "present", "state", "perception", "persona"].includes(key)));
      }
      assert.doesNotMatch(input.task, /Bot 打开|Bot 在|世界模型|虚构应用|虚构电脑|虚构浏览器/);
      const primary = input.actorId;
      const response = input.kind === "initialize"
        ? { botName: "小澈", worldState: "小澈坐在书桌前，电脑有 note.txt，天气应用记录小雨。", actorStates: [{ actorId: "bot", state: "坐在书桌前。" }], perceptions: [{ actorId: "bot", text: "桌上的电脑亮着。" }] }
        : input.kind === "app_action"
          ? { worldState: input.worldState + "\nnote.txt已更新。", outcome: { status: "completed" }, perceptions: [{ actorId: primary, text: "文件已更新。" }] }
          : { perceptions: [{ actorId: primary, text: input.task.includes("浏览器") ? "<html><title>公告</title><body>图书馆公告。</body></html>" : "note.txt；今日小雨。" }] };
      return { content: "", toolCalls: [{ id: "resolution", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(response) } }] };
    } };
    await world.runtime.ensure();
    assert.equal(requests[0].actors[0].id, "bot", "protocol identity remains unchanged");
    const store = await world.runtime.store();
    await store.commit({ idempotencyKey: "guest", source: "fixture", actors: {
      guest: { id: "guest", name: "阿青", controller: "player", present: true, state: "在门口。", perception: "看见小澈。", persona: "喜欢读书。" },
    } });
    const explorer = new FileManagerApp({} as any, world, files, clock, cfg.apps, logger);
    const weather = new WeatherApp(world, files, clock, cfg.apps, logger);
    const browser = new BrowserApp({} as any, world, files, clock, {} as any, {} as any, {} as any, () => false, cfg.apps, logger);
    const terminal = new TerminalApp({} as any, world, files, clock, cfg.apps, logger);
    const opened = await Promise.all([explorer.open(), weather.open(), browser.open(), terminal.open()]);
    const context = new BotContext(files, renderToolsText()); await context.load();
    for (const value of opened) await context.appendEvent({ id: context.nextEventId(), source: "tool", content: JSON.stringify(value), worldTime: 10 });
    const modelMessages = await context.toChatMessages("T10");
    const appMessages = JSON.stringify(modelMessages.slice(1));
    assert.doesNotMatch(appMessages, /虚构模式|虚构文件|虚构电脑|\bBot\b|\bAgent\b|主人|世界模型/);
    assert.doesNotMatch(renderToolsText(), /主人/);
    const previousBytes = await files.readText(files.stream);
    await explorer.call("list", {});
    await explorer.call("show", { path: "note.txt" });
    await weather.call("query_weather", { city: "临海市" });
    await browser.call("open_url", { url: "https://library.invalid" });
    await explorer.call("write", { path: "note.txt", content: "保留原文 Bot" });
    await terminal.call("run_command", { command: "cat note.txt" });
    assert.equal(requests.length, 7);
    assert.equal(requests.at(-1).kind, "app_action");
    assert.match(requests.at(-1).task, /不调用外部操作系统/);
    for (const input of requests.slice(1)) {
      assert.match(input.task, /不证明角色的身体已经行动或看过结果/);
      assert.equal(input.actors.find((actor: any) => actor.id === "guest").persona, "喜欢读书。");
    }
    assert.equal(store.snapshot().actors.bot!.controller, "bot");
    assert.equal(store.snapshot().actors.guest!.controller, "player", "authorization metadata still persists internally");
    assert.equal(await files.readText(files.stream), previousBytes, "the audit does not rewrite prior character history");
    await context.appendEvent({ id: context.nextEventId(), source: "system", content: CHAT_RUNTIME_GUIDANCE, worldTime: 11 });
    const guided = await context.toChatMessages("T11");
    assert.deepEqual(guided.slice(0, modelMessages.length), modelMessages, "updated chat semantics append after the previously sent request without rewriting its cached prefix");
    assert.ok(JSON.stringify(guided.at(-1)).includes("相同频道、账号和消息编号"));
    const restored = new BotContext(files, renderToolsText()); await restored.load();
    assert.deepEqual(await restored.toChatMessages("T12"), guided, "the appended guidance and original request prefix survive restart");
    await files.ensure(); assert.equal(await files.readText(files.botDef), authored, "new default templates never migrate over authored definitions");
    await files.writeMeta({ realWorld: true });
    await assert.rejects(world.observeVirtualApp("read"), error => error instanceof Error && !/模型|模拟|虚构|Bot|Agent/.test(error.message));
    await assert.rejects(world.executeAppAction("write"), error => error instanceof Error && !/模型|模拟|虚构|Bot|Agent/.test(error.message));
    console.log("PASS character model boundary: actual World/App requests omit controller provenance, preserve author text and technical IDs, use neutral tool descriptions, maintain device agency and leave old history intact");
  } finally { await world?.runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
