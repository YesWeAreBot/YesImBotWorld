/** Virtual app reads use established world records, never just the last perception. Offline only. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WorldAgent } from "../src/world/agent.js";
import { Prompts } from "../src/prompts.js";
import { FileManagerApp } from "../src/apps/files.js";
import { BrowserApp } from "../src/apps/browser.js";
import { WeatherApp } from "../src/apps/weather.js";
import { TerminalApp } from "../src/apps/terminal.js";
import type { RichText } from "../src/types.js";

const logger = { info() {}, warn() {}, error() {} } as any;
const rich = (result: string | RichText): RichText => {
  assert.equal(typeof result, "object", "virtual reads retain committed evidence roots");
  assert.ok((result as RichText).originEventIds?.length);
  return result as RichText;
};
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-virtual-read-"));
  let world: WorldAgent | undefined;
  try {
    const cfg = Config({ autoStart: false });
    // These fixtures exercise the explicitly supported native-tool compatibility path.
    cfg.world.responseFormat = "tool";
    const files = new WorldFiles(dir); await files.ensure(); await files.writeMeta({ realWorld: false } as any);
    const clock = { now: () => 10, timeLine: () => "T=10", syncRealTime: false, realMsUntil: () => 0 } as any;
    world = new WorldAgent(cfg.world, files, clock, logger, new Prompts());
    const store = await world.runtime.store();
    const original = "雨声，红色的伞。😀\n第二行保留  两个空格。";
    const baseState = "角色拥有可用的虚构电脑、浏览器和天气应用。天气应用已有临海市今天小雨的记录。网页 https://fixture.invalid 初版正文为晴雨公告。WORLD_PRIVATE_SECRET：邻居抽屉里藏着钥匙。";
    await store.commit({ idempotencyKey: "seed", source: "fixture", initialized: true, worldState: baseState, actors: {
      bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "在自己的电脑前。", perception: "你看着电脑屏幕。" },
    }, perceptions: [{ actorId: "bot", text: "你看着电脑屏幕。" }] });
    const host: string[] = []; world.setHostBotDeliver(text => host.push(text));
    let appReads = 0, actionWrites = 0;
    let observeResult: (input: any) => string = () => "";
    (world as any).client = { complete: async (messages: any[], options: any) => {
      assert.deepEqual(options.toolChoice, { type: "function", function: { name: "resolve_world" } });
      const input = JSON.parse(messages.filter(m => m.role === "user").at(-1).content);
      let resolution: any;
      if (input.kind === "app_action") {
        actionWrites++;
        assert.ok(input.task.includes(JSON.stringify(original)), "exact write content reaches app adjudication");
        resolution = { worldState: baseState + "\n电脑文件 note.txt 原文如下：\n" + original, perceptions: [{ actorId: "bot", text: "note.txt 已写入成功。" }], outcome: { status: "completed" } };
      } else {
        assert.equal(input.kind, "app_observe", "reads cannot use physical actions or a last-frame presenter");
        appReads++;
        assert.ok(input.worldState.includes(original), "reader receives persisted original even after unrelated perception");
        resolution = { perceptions: [{ actorId: input.actorId, text: observeResult(input) }] };
      }
      return { content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(resolution) } }] };
    } };
    world.query = async () => { throw new Error("apps must not query only the latest perception"); };
    const computer = { ensureReady() { throw new Error("virtual app cannot access actual computer"); } } as any;
    const explorer = new FileManagerApp(computer, world, files, clock, cfg.apps, logger);
    const browser = new BrowserApp({} as any, world, files, clock, {} as any, {} as any, {} as any, () => false, cfg.apps, logger);
    const weather = new WeatherApp(world, files, clock, cfg.apps, logger);
    const terminal = new TerminalApp(computer, world, files, clock, cfg.apps, logger);
    const beforeWrite = await world.runtime.peek("bot"), oldPerceptions = store.readPerceptions("bot");
    const written = rich(await explorer.call("write", { path: "note.txt", content: original })); assert.equal(actionWrites, 1);
    assert.equal(written.text, "note.txt 已写入成功。");
    assert.deepEqual(await world.runtime.peek("bot"), beforeWrite, "stealth writes cannot become automatic Bot perceptions");
    assert.deepEqual(store.readPerceptions("bot"), oldPerceptions);
    assert.equal(host.length, 0, "app output stays private until BotAgent's attention/control gate");
    const writeRecord = JSON.parse((await store.exportJournal()).trim().split("\n").at(-1)!);
    assert.deepEqual(writeRecord.commit.toolReceipt, { actorId: "bot", text: written.text, status: "completed" });
    assert.equal(writeRecord.events.length, 1); assert.equal(writeRecord.events[0].topic, "world.committed");
    assert.deepEqual(store.findCommit(writeRecord.commit.idempotencyKey)?.toolReceipt, writeRecord.commit.toolReceipt);
    await store.reload(); assert.deepEqual(store.findCommit(writeRecord.commit.idempotencyKey)?.toolReceipt, writeRecord.commit.toolReceipt, "private receipts survive reload independently of perceptions");
    assert.ok(store.snapshot().worldState.includes(original));
    await store.commit({ idempotencyKey: "knock", source: "fixture", perceptions: [{ actorId: "bot", text: "邻居在门外敲门。" }] });
    const beforeRead = store.snapshot(), established = beforeRead.worldState;
    const beforePerception = await world.runtime.peek("bot");
    observeResult = input => { assert.match(input.task, /note\.txt/); assert.match(input.task, /"start":1,"max_lines":2/); return "1  雨声，红色的伞。😀\n2  第二行保留  两个空格。"; };
    const first = rich(await explorer.call("show", { path: "note.txt", start: 1, max_lines: 2 }));
    assert.ok(first.text.includes("1  雨声，红色的伞。😀\n2  第二行保留  两个空格。"));
    assert.doesNotMatch(first.text, /WORLD_PRIVATE_SECRET|钥匙/);
    assert.deepEqual(store.snapshot(), beforeRead, "device reads do not change world state or journal");
    assert.deepEqual(await world.runtime.peek("bot"), beforePerception, "stealth reads cannot leak into passive world context");
    // A later event may commit between reading and delivering: return the captured screen, never re-peek.
    const observe = world.runtime.observeVirtualApp.bind(world.runtime);
    world.runtime.observeVirtualApp = async (actor, task) => {
      const result = await observe(actor, task);
      await store.commit({ idempotencyKey: "interleaved", source: "fixture", perceptions: [{ actorId: "bot", text: "敲门声又响了一次。" }] });
      return result;
    };
    assert.deepEqual(rich(await explorer.call("show", { path: "note.txt", start: 1, max_lines: 2 })), first);
    world.runtime.observeVirtualApp = observe;
    observeResult = input => { assert.match(input.task, /主目录/); return "note.txt"; };
    assert.equal(rich(await explorer.call("list", {})).text, "note.txt");
    await world.resolveWait({} as any, text => host.push(text));
    assert.ok(!host.some(text => text.includes("1  雨声")), "direct app screens are not also passively delivered");

    // An old unavailable-page cache must not mask a newly established page or its later update.
    const legacyCache = JSON.stringify({ "url:https://fixture.invalid": "<html><body>永久未知缓存</body></html>" });
    await files.atomicWrite(files.browserCache, legacyCache);
    observeResult = input => { assert.match(input.task, /fixture\.invalid/); return "<html><title>天气公告</title><body>晴雨公告" + "<p>正文。</p>".repeat(1200) + "</body></html>"; };
    const page = rich(await browser.call("open_url", { url: "https://fixture.invalid" }));
    assert.match(page.text, /晴雨公告/); assert.doesNotMatch(page.text, /永久未知缓存/);
    assert.deepEqual(rich(await browser.call("scroll_down", {})).originEventIds, page.originEventIds);
    await store.commit({ idempotencyKey: "new-page", source: "fixture", worldState: established + "\n该网页现在的更新正文为雨后放晴。", perceptions: [{ actorId: "bot", text: "门外安静了。" }] });
    observeResult = input => { assert.match(input.worldState, /雨后放晴/); return "<html><title>天气公告</title><body>雨后放晴。</body></html>"; };
    const updated = rich(await browser.call("open_url", { url: "https://fixture.invalid" }));
    assert.match(updated.text, /雨后放晴/); assert.notDeepEqual(updated.originEventIds, page.originEventIds);
    assert.deepEqual(rich(await browser.call("go_back", {})).originEventIds, page.originEventIds);
    assert.equal(await files.readText(files.browserCache), legacyCache, "legacy cache retained as archive, never loaded or overwritten");
    observeResult = input => { assert.match(input.task, /临海市/); return "临海市：今天小雨。未来预报未记录。"; };
    assert.equal(rich(await weather.call("query_weather", { city: "临海市" })).text, "临海市：今天小雨。未来预报未记录。");

    const beforeTerminal = store.snapshot(), lastBeforeTerminal = await world.runtime.peek("bot");
    (world as any).client = { complete: async (messages: any[]) => {
      const input = JSON.parse(messages.filter(m => m.role === "user").at(-1).content);
      assert.equal(input.kind, "app_action"); assert.match(input.task, /cat note\.txt/);
      return { content: "", toolCalls: [{ id: "terminal", type: "function", function: { name: "resolve_world", arguments: JSON.stringify({ worldState: input.worldState, perceptions: [{ actorId: "bot", text: original }], outcome: { status: "completed" } }) } }] };
    } };
    assert.ok(rich(await terminal.call("run_command", { command: "cat note.txt" })).text.startsWith(original));
    assert.equal(store.snapshot().worldState, beforeTerminal.worldState);
    assert.deepEqual(await world.runtime.peek("bot"), lastBeforeTerminal);
    (world as any).client = { complete: async () => ({ content: "", toolCalls: [{ id: "failed", type: "function", function: { name: "resolve_world", arguments: JSON.stringify({ worldState: beforeTerminal.worldState, perceptions: [{ actorId: "bot", text: "没有写入权限，文件未更改。" }], outcome: { status: "failed" } }) } }] }) };
    assert.match(rich(await explorer.call("write", { path: "blocked", content: "new" })).text, /^操作未完成。\n没有写入权限/);
    assert.equal(store.snapshot().worldState, beforeTerminal.worldState); assert.deepEqual(await world.runtime.peek("bot"), lastBeforeTerminal);
    const beforeInvalid = store.snapshot();
    (world as any).client = { complete: async () => ({ content: "", toolCalls: [{ id: "invalid", type: "function", function: { name: "resolve_world", arguments: JSON.stringify({ actorStates: [{ actorId: "bot", state: "你已经看见了私密文件" }], perceptions: [{ actorId: "bot", text: "已看见" }], outcome: { status: "completed" } }) } }] }) };
    await assert.rejects(world.executeAppAction("write note"), /不能修改角色状态/);
    assert.deepEqual(store.snapshot(), beforeInvalid, "invalid app outcomes cannot alter actor awareness or commit any state");
    (world as any).client = { complete: async () => ({ content: "", toolCalls: [{ id: "missing-state", type: "function", function: { name: "resolve_world", arguments: JSON.stringify({ perceptions: [{ actorId: "bot", text: "文件已经写入成功。" }], outcome: { status: "completed" } }) } }] }) };
    await assert.rejects(world.executeAppAction("write missing.txt"), /worldState/);
    assert.deepEqual(store.snapshot(), beforeInvalid, "a successful-looking receipt without its device state cannot be committed or delivered");
    let pendingSignal: AbortSignal | undefined, finishPending!: (result: any) => void;
    (world as any).client = { complete: async (_messages: any[], options: any) => {
      pendingSignal = options.signal;
      return new Promise(resolve => { finishPending = resolve; });
    } };
    const cancel = new AbortController();
    const pendingWrite = world.executeAppAction("迟迟没有完成的写入", "bot", cancel.signal);
    const cancelledWrite = assert.rejects(pendingWrite);
    for (let i = 0; !pendingSignal && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(pendingSignal);
    cancel.abort(); await cancelledWrite; assert.ok(pendingSignal.aborted);
    finishPending({ content: "", toolCalls: [{ id: "late", type: "function", function: { name: "resolve_world", arguments: JSON.stringify({ worldState: "不能晚到的写入", perceptions: [{ actorId: "bot", text: "已写入" }], outcome: { status: "completed" } }) } }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(store.snapshot(), beforeInvalid, "cancelled app operations cannot save late output or change awareness");

    // Test actual public routing while replacing only external IO; no network or Docker involved.
    const beforeReal = appReads;
    await files.writeMeta({ realWorld: true } as any);
    (explorer as any).list = async () => "REAL_DIRECTORY";
    (explorer as any).show = async () => "REAL_FILE";
    (browser as any).realOpen = async () => "REAL_PAGE";
    (browser as any).realSearch = async () => "REAL_SEARCH";
    (weather as any).realWeather = async () => "REAL_WEATHER";
    computer.exec = async () => ({ output: "REAL_TERMINAL" });
    assert.equal(await explorer.call("list", {}), "REAL_DIRECTORY");
    assert.equal(await explorer.call("show", { path: "note.txt" }), "REAL_FILE");
    assert.equal(await browser.call("open_url", { url: "https://fixture.invalid" }), "REAL_PAGE");
    assert.equal(await browser.call("search", { query: "weather" }), "REAL_SEARCH");
    assert.equal(await weather.call("query_weather", {}), "REAL_WEATHER");
    assert.match(String(await terminal.call("run_command", { command: "ls" })), /REAL_TERMINAL/);
    await assert.rejects(world.observeVirtualApp("读取文件"), /必须通过设备提供的读取能力/);
    await assert.rejects(world.executeAppAction("写入文件"), /必须通过设备提供的操作能力/);
    assert.equal(appReads, beforeReal);
    console.log("PASS virtual narrative apps: write/read continuity, private durable receipts, unchanged awareness, invalid/cancelled write isolation, captured read roots, refreshed pages, real IO isolation");
  } finally { await world?.runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
