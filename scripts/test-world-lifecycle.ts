import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorldAgent } from "../src/world/agent.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { TingleTimer } from "../src/world/tingle.js";
import { WorldFiles } from "../src/files.js";
import { WorldClock } from "../src/clock.js";
import { Prompts } from "../src/prompts.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { ClockConfigData } from "../src/config.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
const dirs: string[] = [];
const plain = (content: string): ChatResult => ({ content, toolCalls: [] });
const resolved = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const initial = () => resolved({ botName: "新角色", worldState: "新房间里有一张桌子。", actorStates: [{ actorId: "bot", state: "你站在桌边。" }], perceptions: [{ actorId: "bot", text: "你看见桌子。" }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lifecycle did not settle promptly")), 1500); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(phone = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-world-lifecycle-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  await files.atomicWrite(files.botDef, "新角色，喜欢散步。"); await files.atomicWrite(files.worldDef, "一间安静的房间。");
  const cfg = { syncRealTime: false, epoch: "2012-03-04 05:06", realSecondsPerUnit: 2, worldSecondsPerUnit: 60, tingleEveryUnits: 30, tingleMode: "fixed", tingleMinUnits: 1, tingleMaxUnits: 100 } as ClockConfigData;
  const clock = new WorldClock(cfg, files.clock); await clock.load();
  const prompts = new Prompts();
  const world = new WorldAgent({ baseURL: `http://world-lifecycle-${randomUUID()}.invalid`, model: "offline", compressMaxInputChars: 60 } as any, files, clock, logger, prompts, { resolution: phone ? "auto" : "320x640", generateShell: phone });
  type Handler = (messages: ChatMessage[], options: { signal?: AbortSignal; tools?: unknown[] }) => Promise<ChatResult>;
  let handler: Handler = async () => { throw new Error("unexpected fake inference"); };
  (world as any).client = { complete: (messages: ChatMessage[], options: any) => handler(messages, options) };
  return { files, clock, world, cfg, prompts, setHandler(next: Handler) { handler = next; } };
}

async function initializationStagesCannotSurviveReset() {
  for (const blocked of ["meta", "calendar", "world", "spec", "shell"]) {
    const f = await fixture(true), entered = deferred<AbortSignal>(), late = deferred<ChatResult>();
    let held = false, calls = 0;
    const response = (stage: string) => stage === "meta" ? plain('{"real_world":false}') : stage === "calendar" ? plain('{"kind":"gregorian","epoch":"2012-03-04 05:06"}') : stage === "spec" ? plain('{"width":320,"height":640}') : stage === "shell" ? plain('<html><body>{{screen}}</body></html>') : initial();
    f.setHandler(async (messages, options) => {
      calls++; const system = String(messages[0]?.content);
      const stage = options.tools?.length ? "world" : system === f.prompts.world.assessRealWorldSystem ? "meta" : system.startsWith(f.prompts.world.generateCalendarSystem) ? "calendar" : system === f.prompts.world.phoneSpecSystem ? "spec" : "shell";
      assert.ok(options.signal, `${stage} must use the lifetime signal`);
      if (!held && stage === blocked) { held = true; entered.resolve(options.signal!); return late.promise; }
      return response(stage);
    });
    try {
      const old = f.world.initialize("旧角色", "旧房间"), rejected = assert.rejects(old);
      const signal = await bounded(entered.promise);
      await bounded(f.world.shutdown()); await rejected;
      assert.equal(signal.aborted, true); assert.equal(f.world.queueLength, 0);
      const callsAfterStop = calls;
      await assert.rejects(f.world.ensureWorld()); await assert.rejects(f.world.initialize("不得复活", "不得复活"));
      assert.equal(calls, callsAfterStop, "stopped entry points cannot resume implicitly");
      await f.files.reset(); f.world.resetSessionState(); f.world.resume();
      await bounded(f.world.initialize("新角色", "新房间"));
      const before = { meta: await f.files.readText(f.files.meta), clock: await f.files.readText(f.files.clock), shell: await f.files.readPhoneShell(), state: (await f.world.runtime.store()).snapshot(), calls };
      late.resolve(response(blocked)); await tick(); await tick();
      assert.deepEqual({ meta: await f.files.readText(f.files.meta), clock: await f.files.readText(f.files.clock), shell: await f.files.readPhoneShell(), state: (await f.world.runtime.store()).snapshot(), calls }, before, `late ${blocked} response cannot write or start another phase in the new world`);
      assert.equal(f.world.residentBotName, "新角色");
    } finally { await f.world.shutdown(); }
  }
  console.log("PASS stop during all five creation phases: cancellation stays in the original generation and late output cannot change the reset world");
}

async function backgroundMaintenanceAndWritesDrain() {
  const f = await fixture(), entered = deferred<AbortSignal>(), late = deferred<ChatResult>(); let calls = 0;
  try {
    f.setHandler(async (_messages, options) => { calls++; entered.resolve(options.signal!); return late.promise; });
    const oldName = f.world.ensureBotName(), nameRejected = assert.rejects(oldName);
    const signal = await bounded(entered.promise); await bounded(f.world.shutdown()); await nameRejected;
    assert.equal(signal.aborted, true);
    await f.files.reset(); f.world.resetSessionState(); await f.files.writeMeta({ botName: "新角色" }); f.world.resume();
    late.resolve(plain('{"name":"旧角色"}')); await tick(); await tick();
    assert.equal((await f.files.readMeta()).botName, "新角色"); assert.equal(calls, 1);

    const compressionEntered = deferred<void>(), compressionLate = deferred<ChatResult>();
    f.setHandler(async (_messages, options) => { calls++; assert.ok(options.signal); compressionEntered.resolve(); return compressionLate.promise; });
    const input = { persona: "新角色", historySummary: "", memoryDigest: "", streamText: "一段经历。\n".repeat(25), timeLine: "T=0" };
    const compression = f.world.compress(input), compressedRejected = assert.rejects(compression);
    await bounded(compressionEntered.promise);
    const queued = f.world.compress(input), queuedRejected = assert.rejects(queued);
    await bounded(f.world.shutdown()); await Promise.all([compressedRejected, queuedRejected]); assert.equal(f.world.queueLength, 0);
    f.world.resume(); const beforeCalls = calls;
    compressionLate.resolve(plain("<HISTORY_SUMMARY>旧摘要</HISTORY_SUMMARY><MEMORY_DIGEST>旧记忆</MEMORY_DIGEST>")); await tick(); await tick();
    assert.equal(calls, beforeCalls, "a late chunk cannot continue compression with the resumed lifetime");

    // A disk write which already began must finish before shutdown reports quiescence.
    await f.files.writeMeta({}); const writing = deferred<void>(), releaseWrite = deferred<void>();
    const writeMeta = f.files.writeMeta.bind(f.files); let held = false;
    f.files.writeMeta = async meta => { if (!held) { held = true; writing.resolve(); await releaseWrite.promise; } await writeMeta(meta); };
    f.setHandler(async () => plain('{"name":"写入中的旧名字"}'));
    const naming = f.world.ensureBotName(); const named = naming.catch(() => {});
    await bounded(writing.promise); let finished = false;
    const shutdown = f.world.shutdown().then(() => { finished = true; });
    await tick(); assert.equal(finished, false, "shutdown must join the worker, not just the cancelled endpoint-lock waiter");
    releaseWrite.resolve(); await bounded(shutdown); await named;
    await f.files.reset(); await f.files.writeMeta({ botName: "重置后的名字" }); await tick();
    assert.equal((await f.files.readMeta()).botName, "重置后的名字");
  } finally { await f.world.shutdown(); }
  console.log("PASS background name, queued/multichunk compression, and already-started metadata writes settle before reset");
}

async function runtimeKeepsOriginalSignalAcrossReads() {
  const f = await fixture(); let models = 0;
  const runtime = new NarrativeWorld(f.files, f.clock, async () => { models++; return initial(); });
  try {
    await runtime.ensure(); const store = await runtime.store(), snapshot = store.snapshot();
    const ops: [string, () => Promise<unknown>][] = [
      ["ensure", () => runtime.ensure()], ["evolve", () => runtime.evolve("旧世界演化")],
      ["observe", () => runtime.observe()], ["arrive", () => runtime.arrive("guest", "旧访客", "旧背景")],
      ["app read", () => runtime.observeVirtualApp("bot", "读取文件 note.txt")],
      ["app write", () => runtime.executeVirtualApp("bot", "保存文件 note.txt")],
      ["rename", () => runtime.rename("旧名字")],
    ];
    for (const [label, operation] of ops) {
      const entered = deferred<void>(), release = deferred<void>();
      const original = runtime.store.bind(runtime); let first = true;
      runtime.store = async () => { if (first) { first = false; entered.resolve(); await release.promise; } return original(); };
      const pending = operation(), rejected = assert.rejects(pending);
      await bounded(entered.promise); runtime.stop(); runtime.resume(); release.resolve(); await bounded(rejected);
      runtime.store = original;
      assert.equal(models, 1, `${label} cannot borrow the resumed lifetime after an earlier await`);
      assert.deepEqual(store.snapshot(), snapshot);
    }
    await runtime.reload(); await assert.rejects(runtime.evolve("reload不能自行恢复推理"));
    runtime.resume(); await runtime.ensure();
  } finally { await runtime.shutdown(); await f.world.shutdown(); }
  console.log("PASS runtime entries retain their original cancellation generation across awaited reads; reload remains stopped");
}

async function openingIsPartOfShutdown() {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  const original = NarrativeStore.prototype.migrateLegacy;
  NarrativeStore.prototype.migrateLegacy = async function(files) { entered.resolve(); await release.promise; return original.call(this, files); };
  try {
    const opening = f.world.runtime.store(), rejected = assert.rejects(opening);
    await bounded(entered.promise); let finished = false;
    const shutdown = f.world.shutdown().then(() => { finished = true; });
    await tick(); assert.equal(finished, false, "migration/opening must settle before reset can delete files");
    release.resolve(); await bounded(shutdown); await rejected;
    assert.equal((f.files as any).narrative, undefined, "an old opening cannot bind its store after stop");
  } finally { release.resolve(); NarrativeStore.prototype.migrateLegacy = original; await f.world.shutdown(); }
  console.log("PASS shutdown drains opening/migration and rejects stale store binding");
}

async function tingleDoesNotCreateDuplicateLoops() {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>(); let serial = 0;
  globalThis.setTimeout = ((fn: () => void) => { const id = ++serial; timers.set(id, fn); return id; }) as any;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
  const old = deferred<number | null>(), current = deferred<number | null>(); let calls = 0;
  const deliveries: string[] = []; let oldDeliver!: (text: string) => void;
  const world = { tingle(deliver: (text: string) => void) { calls++; if (calls === 1) { oldDeliver = deliver; return old.promise; } return current.promise; } } as WorldAgent;
  const timer = new TingleTimer({ tingleEveryUnits: 5, tingleMode: "fixed" } as ClockConfigData, { unitRealSeconds: 1, now: () => 0 } as WorldClock, world, text => deliveries.push(text), logger);
  const fire = () => { const [id, fn] = [...timers][0]!; timers.delete(id); fn(); };
  try {
    timer.start(); fire(); assert.equal(calls, 1);
    timer.stop(); timer.start(); assert.equal(timers.size, 1);
    oldDeliver("旧世界迟到感知"); old.resolve(0); await tick(); await tick();
    assert.deepEqual(deliveries, []); assert.equal(timers.size, 1, "old finally cannot create another timer after stop/start");
    fire(); assert.equal(calls, 2); current.resolve(null); await tick(); await tick(); assert.equal(timers.size, 1);
    timer.stop(); assert.equal(timers.size, 0);
  } finally { timer.stop(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
  console.log("PASS restart rejects old heartbeat delivery and keeps exactly one scheduling chain");
}

async function pausedVisitorDisconnectIsAdministrative() {
  const f = await fixture(); let calls = 0;
  f.setHandler(async () => { calls++; return initial(); });
  try {
    await f.world.ensureWorld(); const store = await f.world.runtime.store();
    await store.commit({ idempotencyKey: "fixture-visitor", source: "fixture", actors: {
      "visitor:guest": { id: "visitor:guest", name: "访客", controller: "player", present: true, state: "站在桌边", perception: "桌边有一张椅子。" },
    } });
    const botBefore = store.snapshot().actors.bot, perceptionsBefore = store.readPerceptions("bot");
    await f.world.shutdown();
    await f.world.disconnectVisitor({ id: "guest", name: "访客" } as any);
    assert.equal(calls, 1, "paused teardown cannot request a departure narrative");
    assert.equal(store.snapshot().actors["visitor:guest"]?.present, false);
    assert.deepEqual(store.snapshot().actors.bot, botBefore);
    assert.deepEqual(store.readPerceptions("bot"), perceptionsBefore, "connection state is not an invented physical perception");
    const sequence = store.snapshot().sequence;
    await f.world.disconnectVisitor({ id: "guest", name: "访客" } as any);
    assert.equal(store.snapshot().sequence, sequence, "duplicate disconnect cannot append another departure");
    await assert.rejects(f.world.runtime.disconnectVisitor("bot"), /只能登记访客/);
    await assert.rejects(f.world.ensureWorld(), "administrative teardown cannot resume inference");
    await f.files.reset(); f.world.resetSessionState();
    await f.world.disconnectVisitor({ id: "never-arrived", name: "访客" } as any);
    assert.equal(await f.files.isInitialized(), false); assert.equal(calls, 1);
  } finally { await f.world.shutdown(); }
  console.log("PASS paused visitor teardown persists absence without model calls, fabricated perceptions or ghost actors");
}

async function main() {
  try {
    await initializationStagesCannotSurviveReset();
    await backgroundMaintenanceAndWritesDrain();
    await runtimeKeepsOriginalSignalAcrossReads();
    await openingIsPartOfShutdown();
    await tingleDoesNotCreateDuplicateLoops();
    await pausedVisitorDisconnectIsAdministrative();
    console.log("PASS isolated World lifecycle regression; no live instance, external model or user state accessed");
  } finally { await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
