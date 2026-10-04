/** Appearance maintenance uses real world/service lifecycle boundaries, with offline model IO. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WorldClock } from "../src/clock.js";
import { WorldAgent } from "../src/world/agent.js";
import { WorldService } from "../src/service.js";
import { Prompts } from "../src/prompts.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";

const logger: any = { info() {}, debug() {}, warn() {}, error() {} };
const roots: string[] = [], worlds: WorldAgent[] = [];
const shell = (label: string) => `<html><body>${label}<img src="{{screen}}"></body></html>`;
const plain = (content: string): ChatResult => ({ content, toolCalls: [] });
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const cancelled = (error: Error) => error.name === "AbortError" || error.message.includes("取消");
async function bounded<T>(task: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("phone-shell lifecycle did not settle")), 2000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "phone-shell-lifecycle-")); roots.push(base);
  const files = new WorldFiles(base); await files.ensure();
  await files.writeBotDef("小澈，普通学生。"); await files.writeWorldDef("自习室里有桌椅。");
  const cfg = Config({ autoStart: false }); cfg.clock.syncRealTime = true;
  cfg.world.baseURL = `http://shell-fixture-${randomUUID()}.invalid`;
  const clock = new WorldClock(cfg.clock, files.clock); await clock.load();
  const prompts = new Prompts();
  const world = new WorldAgent(cfg.world, files, clock, logger, prompts, { resolution: "auto", generateShell: true }); worlds.push(world);
  const calls: string[] = [];
  let handler = async (messages: ChatMessage[], options: { signal?: AbortSignal; tools?: unknown[] }): Promise<ChatResult> => {
    const prompt = String(messages[0]?.content);
    if (options.responseSchema || options.tools?.length) return { content: "", toolCalls: [{ id: "genesis", type: "function", function: { name: "resolve_world", arguments: JSON.stringify({
      botName: "小澈", worldState: "自习室里有桌椅。", actorStates: [{ actorId: "bot", state: "坐在桌前。" }], perceptions: [{ actorId: "bot", text: "你看见桌上的书。" }],
    }) } }] };
    if (prompt === prompts.world.assessRealWorldSystem) return plain('{"real_world":true}');
    if (prompt === prompts.world.phoneSpecSystem) return plain('{"width":480,"height":960}');
    if (prompt === prompts.world.phoneShellSystem) return plain(shell("首次生成"));
    throw new Error("unexpected inference: " + prompt.slice(0, 50));
  };
  (world as any).client = { complete(messages: ChatMessage[], options: any) {
    calls.push(String(messages[0]?.content)); return handler(messages, options);
  } };
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { files, world, clock, logger, config: cfg, promptStore: prompts, phoneStatus: { down: false },
    worldActive: false, bot: null, deviceTail: Promise.resolve(),
    focus: { async clear() {} }, notifyMgr: { async reset() {}, async clearMessages() {} }, store: { async clear() {} },
  });
  return { files, clock, world, prompts, calls, service, setHandler(next: typeof handler) { handler = next; } };
}

async function resetAndArchive() {
  const f = await fixture();
  const original = { phone: { width: 400, height: 800 }, realWorld: false, botName: "原角色" };
  await f.files.writeMeta(original); await f.files.writePhoneShell(shell("存档外壳"));
  const saved = await f.files.snapshot("外壳存档");
  await f.files.writeMeta({ phone: { width: 480, height: 960 }, realWorld: true, botName: "本轮角色" });
  await f.files.writePhoneShell(shell("当前外壳")); await f.files.atomicWrite(f.files.stream, "旧意识流");
  await f.files.reset();
  assert.equal(await f.files.readPhoneShell(), shell("当前外壳"));
  assert.deepEqual(await f.files.readMeta(), { phone: { width: 480, height: 960 } });
  assert.equal(await f.files.exists(f.files.stream), false);
  assert.equal(await f.files.readText(f.files.botDef), "小澈，普通学生。");
  const resetArchive = (await fs.readdir(f.files.archiveDir)).find(name => name.endsWith("-重置"))!;
  const archivedMeta = JSON.parse(await fs.readFile(path.join(f.files.archiveDir, resetArchive, "meta.json"), "utf8"));
  assert.equal(archivedMeta.botName, "本轮角色"); assert.equal(archivedMeta.realWorld, true);
  await f.files.restoreFrom(path.join(f.files.archiveDir, saved));
  assert.equal(await f.files.readPhoneShell(), shell("存档外壳")); assert.deepEqual(await f.files.readMeta(), original);
  const legacy = path.join(f.files.archiveDir, "无外壳的旧存档"); await fs.mkdir(legacy);
  await f.files.restoreFrom(legacy);
  assert.equal(await f.files.exists(f.files.phoneShell), false, "restoring a snapshot without a shell must not keep a different world's shell");
  assert.deepEqual(await f.files.readMeta(), {});
}

async function creationReusesAppearance() {
  for (const existing of [true, false]) {
    const f = await fixture();
    if (existing) { await f.files.writePhoneShell(shell("手工编辑")); await f.files.writeMeta({ phone: { width: 400, height: 800 } }); }
    await f.world.initialize("小澈，普通学生。", "自习室里有桌椅。");
    assert.equal(await f.files.isInitialized(), true);
    assert.equal(f.calls.filter(call => call === f.prompts.world.phoneSpecSystem).length, existing ? 0 : 1);
    assert.equal(f.calls.filter(call => call === f.prompts.world.phoneShellSystem).length, existing ? 0 : 1);
    assert.equal(await f.files.readPhoneShell(), shell(existing ? "手工编辑" : "首次生成"));
    assert.deepEqual((await f.files.readMeta()).phone, existing ? { width: 400, height: 800 } : { width: 480, height: 960 });
    await f.world.shutdown();
  }
  const noSpec = await fixture();
  await noSpec.files.writePhoneShell(shell("已有外壳但没有规格"));
  await noSpec.world.initialize("小澈", "自习室");
  assert.ok(!noSpec.calls.includes(noSpec.prompts.world.phoneSpecSystem));
  assert.ok(!noSpec.calls.includes(noSpec.prompts.world.phoneShellSystem));
  assert.equal(await noSpec.files.readPhoneShell(), shell("已有外壳但没有规格"));
}

async function independentPausedGeneration() {
  const f = await fixture(); await f.world.shutdown();
  const meta = { phone: { width: 400, height: 800 }, realWorld: true, botName: "不改名" };
  await f.files.writeMeta(meta); await f.files.writePhoneShell(shell("旧外壳"));
  await f.files.atomicWrite(f.files.pinned, "固定上下文"); await f.files.atomicWrite(f.files.stream, "已有意识流");
  const clockBefore = await f.files.readText(f.files.clock);
  f.setHandler(async (messages, options) => {
    assert.equal(messages[0]?.content, f.prompts.world.phoneShellSystem); assert.equal(options.tools, undefined);
    return plain(shell("独立新外壳"));
  });
  const result = await f.world.regeneratePhoneShell(new AbortController().signal);
  assert.equal(result.content, shell("独立新外壳")); assert.deepEqual(result.phone, meta.phone); assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.files.readMeta(), meta);
  assert.equal(await f.files.readText(f.files.pinned), "固定上下文"); assert.equal(await f.files.readText(f.files.stream), "已有意识流");
  assert.equal(await f.files.readText(f.files.clock), clockBefore);
  assert.equal(await f.files.exists(f.files.narrativeJournal), false); assert.equal(await f.files.exists(f.files.genesisPending), false);
  await assert.rejects(f.world.ensureWorld()); await assert.rejects(f.world.runtime.ensure());
  assert.equal(f.calls.length, 1, "appearance maintenance does not resume paused world inference");

  for (const mode of ["invalid", "failure"]) {
    f.setHandler(async () => { if (mode === "failure") throw new Error("fixture model failure"); return plain("<html>没有屏幕插槽</html>"); });
    await assert.rejects(f.world.regeneratePhoneShell(new AbortController().signal), mode === "invalid" ? /原外壳已保留/ : /fixture model failure/);
    assert.equal(await f.files.readPhoneShell(), shell("独立新外壳"));
  }
  const entered = gate(), late = gate<ChatResult>(), controller = new AbortController();
  f.setHandler(async () => { entered.resolve(); return late.promise; });
  const pending = f.world.regeneratePhoneShell(controller.signal), rejected = assert.rejects(pending);
  await bounded(entered.promise); controller.abort(new Error("取消外壳生成")); await bounded(rejected);
  late.resolve(plain(shell("迟到结果"))); await tick(); await tick();
  assert.equal(await f.files.readPhoneShell(), shell("独立新外壳"));

  const editing = gate(), edited = gate<ChatResult>();
  f.setHandler(async () => { editing.resolve(); return edited.promise; });
  const generation = f.world.regeneratePhoneShell(new AbortController().signal), changed = assert.rejects(generation, /已被修改/);
  await editing.promise; await f.files.writePhoneShell(shell("外部编辑器保存")); edited.resolve(plain(shell("不应覆盖"))); await changed;
  assert.equal(await f.files.readPhoneShell(), shell("外部编辑器保存"));
}

async function serviceCancellationAndWriteBarrier() {
  const f = await fixture(); await f.world.shutdown(); await f.files.writePhoneShell(shell("重置前外壳"));
  await f.files.writeMeta({ phone: { width: 400, height: 800 }, botName: "旧名字", realWorld: true });
  const entered = gate<AbortSignal>(), late = gate<ChatResult>();
  f.setHandler(async (_messages, options) => { entered.resolve(options.signal!); return late.promise; });
  const first = f.service.regeneratePhoneShell(), firstRejected = assert.rejects(first, cancelled);
  const signal = await bounded(entered.promise);
  await assert.rejects(f.service.regeneratePhoneShell(), /正在重新生成手机外壳/);
  await assert.rejects(f.service.savePhoneShell(shell("抢先保存")), /正在重新生成手机外壳/);
  await bounded(f.service.resetWorld()); await firstRejected;
  assert.equal(signal.aborted, true); assert.equal(f.service.worldActive, false);
  assert.equal(await f.files.readPhoneShell(), shell("重置前外壳"));
  assert.deepEqual(await f.files.readMeta(), { phone: { width: 400, height: 800 } });
  late.resolve(plain(shell("重置后迟到结果"))); await tick(); await tick();
  assert.equal(await f.files.readPhoneShell(), shell("重置前外壳"));

  // The endpoint waiter may reject before an atomic write finishes. Reset must still join its worker.
  const writing = gate(), finishWrite = gate(), order: string[] = [];
  const write = f.files.writePhoneShell.bind(f.files), resetFiles = f.files.reset.bind(f.files);
  f.files.writePhoneShell = async html => { order.push("write-start"); writing.resolve(); await finishWrite.promise; await write(html); order.push("write-complete"); };
  f.files.reset = async () => { order.push("reset-files"); await resetFiles(); };
  f.setHandler(async () => plain(shell("已进入原子提交")));
  const committing = f.service.regeneratePhoneShell(), committingRejected = assert.rejects(committing, cancelled);
  await bounded(writing.promise);
  let resetDone = false;
  const reset = f.service.resetWorld().then(() => { resetDone = true; });
  await tick(); await tick();
  assert.equal(resetDone, false); assert.deepEqual(order, ["write-start"]);
  finishWrite.resolve(); await bounded(reset); await committingRejected;
  assert.deepEqual(order, ["write-start", "write-complete", "reset-files"]);
  const afterReset = await f.files.readPhoneShell(); await tick(); assert.equal(await f.files.readPhoneShell(), afterReset);
  f.files.writePhoneShell = write;
  await f.service.savePhoneShell(shell("暂停时手工保存")); assert.equal(await f.files.readPhoneShell(), shell("暂停时手工保存"));
  await assert.rejects(f.world.ensureWorld());
}

async function main() {
  try {
    await resetAndArchive(); await creationReusesAppearance(); await independentPausedGeneration(); await serviceCancellationAndWriteBarrier();
    console.log("PASS phone-shell lifecycle: reset reuse, exact archive restore, genesis cache, independent paused generation, invalid/failing/late-result preservation, editor conflict, service exclusivity and cancellation/write join before reset");
  } finally {
    await Promise.all(worlds.map(world => world.shutdown()));
    await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
