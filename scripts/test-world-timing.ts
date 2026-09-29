import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldPhaseTiming } from "../src/world/timing.js";
import { NarrativeWorld, type WorldInferenceOptions } from "../src/world/runtime.js";
import { WorldFiles } from "../src/files.js";
import { withEndpointLock, type EndpointLockTiming } from "../src/llm/lock.js";
import { debug } from "../src/webui/debug.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const native = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const perception = (actorId = "bot") => native({ perceptions: [{ actorId, text: "你看见桌边有一张木椅。" }] });
const stages = () => debug.recent(500).flatMap(entry => {
  try { const detail = JSON.parse(entry.detail); return detail?.timing ? [{ entry, ...detail }] : []; } catch { return []; }
});
const namedStage = (id: string) => { const found = stages().find(value => value.id === id); assert.ok(found); return found; };
const closeEnough = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 0.03, `${actual} differs from ${expected} beyond independent two-decimal rounding`);

async function exactPhaseAccounting() {
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  let now = 0; Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  try {
    const trace = new WorldPhaseTiming({ id: "pure-accounting", source: "action", actionPhase: "start" }, 11);
    now = 3; trace.prepared(123);
    const first = trace.request(0);
    now = 10; first.onEndpointTiming({ phase: "started", queuedAt: 0, startedAt: 7, queueMs: 7 });
    now = 30; first.onEndpointTiming({ phase: "finished", queuedAt: 0, startedAt: 7, finishedAt: 27, queueMs: 7, runMs: 20 });
    first.finish(200); first.finish(999);
    const validateFirst = trace.validate(0); now = 35; validateFirst(); validateFirst();
    const repair = trace.request(1);
    now = 40; repair.onEndpointTiming({ phase: "started", queuedAt: 27, startedAt: 32, queueMs: 5 });
    now = 70; repair.onEndpointTiming({ phase: "finished", queuedAt: 27, startedAt: 32, finishedAt: 62, queueMs: 5, runMs: 30 });
    repair.finish(300);
    const validateRepair = trace.validate(1); now = 73; validateRepair();
    trace.droppedSuggestions(2);
    const value = await trace.save(async () => { now = 81; return "saved"; }); assert.equal(value, "saved");
    trace.finish("completed");
    const final = namedStage("pure-accounting");
    assert.equal(final.stage, "completed");
    assert.deepEqual(final.timing, { queueMs: 23, worldQueueMs: 11, endpointQueueMs: 12, preparationMs: 3,
      modelMs: 20, repairMs: 33, validationMs: 5, saveMs: 8, totalMs: 92, attempts: 2, repairs: 1,
      inputChars: 123, outputChars: 500, discardedSuggestions: 2, executionRefreshes: 0 });
    assert.equal(final.timing.queueMs + final.timing.preparationMs + final.timing.modelMs + final.timing.repairMs + final.timing.validationMs + final.timing.saveMs, final.timing.totalMs, "phase buckets never double-count queue, repair validation, or saves");
    const frozen = final.entry.detail;
    now = 900; repair.onEndpointTiming({ phase: "finished", queuedAt: 0, startedAt: 0, queueMs: 900, runMs: 900 });
    trace.finish("failed"); assert.equal(namedStage("pure-accounting").entry.detail, frozen, "late hooks and repeat finish cannot rewrite a completed trace");
    const fallback = new WorldPhaseTiming({ id: "pure-no-hook", source: "observe" });
    now = 903; fallback.prepared(10); const request = fallback.request(0); now = 916; request.finish(20); fallback.finish("failed");
    assert.equal(namedStage("pure-no-hook").timing.modelMs, 13, "injected inference without endpoint instrumentation still records model elapsed time");
    const accepted = new WorldPhaseTiming({ id: "pure-accepted", source: "action" }, 5, 4);
    now = 920; accepted.prepared(10); accepted.finish("completed");
    const acceptance = namedStage("pure-accepted").timing;
    assert.equal(acceptance.saveMs, 4); assert.equal(acceptance.queueMs, 5); assert.equal(acceptance.preparationMs, 4);
    assert.equal(acceptance.totalMs, 13, "the prior acceptance write belongs to save and total exactly once, separately from its queue wait");
  } finally { if (descriptor) Object.defineProperty(performance, "now", descriptor); else delete (performance as any).now; }
  console.log("PASS precise World timing buckets: initial request, repairs, validation, queue, save, idempotent completion and uninstrumented inference");
}

type Handler = (input: any, messages: ChatMessage[], signal: AbortSignal | undefined, options: WorldInferenceOptions) => Promise<ChatResult>;
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "world-timing-"));
  const files = new WorldFiles(directory); await files.ensure(); await files.writeMeta({ realWorld: false });
  const endpoint = `http://${randomUUID()}.invalid`, samples: EndpointLockTiming[][] = [];
  let handler: Handler = async input => perception(input.actorId), entered = () => {};
  const clock = { now: () => 0, unitWorldSeconds: 1, unitRealSeconds: 1, syncRealTime: false } as any;
  const world = new NarrativeWorld(files, clock, (messages, _tools, signal, options) => {
    assert.ok(options && typeof options.onEndpointTiming === "function", "runtime must pass timing through its fourth inference argument");
    const captured: EndpointLockTiming[] = []; samples.push(captured);
    const result = withEndpointLock(endpoint, () => handler(JSON.parse(String(messages.find(message => message.role === "user")!.content)), messages, signal, options), signal,
      { priority: options.background ? "background" : "interactive", onTiming: sample => { captured.push(sample); options.onEndpointTiming!(sample); } });
    entered(); return result;
  });
  const store = await world.store();
  await store.commit({ idempotencyKey: "fixture", source: "fixture", initialized: true, worldState: "房间里有一张桌子。", actors: {
    bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在桌边。", perception: "你看见一张桌子。" },
    guest: { id: "guest", name: "来客", controller: "player", present: true, state: "站在桌边。", perception: "你看见一张桌子。" },
  } });
  return { world, store, endpoint, samples, setHandler(value: Handler) { handler = value; }, onInfer(value: () => void) { entered = value; },
    close: async () => { await world.shutdown(); await fs.rm(directory, { recursive: true, force: true }); } };
}

async function runtimeRepairQueueAndSave() {
  const f = await fixture(), blockerEntered = deferred(), releaseEndpoint = deferred(), requestEntered = deferred(), saveEntered = deferred(), releaseSave = deferred();
  const before = debug.snapshot(), originalCommit = f.store.commit.bind(f.store);
  let attempts = 0;
  const blocker = withEndpointLock(f.endpoint, async () => { blockerEntered.resolve(); await releaseEndpoint.promise; });
  try {
    await blockerEntered.promise;
    f.onInfer(() => requestEntered.resolve());
    f.setHandler(async (input, _messages, _signal, options) => {
      assert.equal(options.background, false); attempts++;
      return attempts === 1 ? native({ perceptions: [{ actorId: "bot", situation: "缺少正文会请求纠错。" }] }) : perception(input.actorId);
    });
    f.store.commit = async (input, options) => {
      if (input.source === "observe" && input.actorId === "bot") { saveEntered.resolve(); await releaseSave.promise; }
      return originalCommit(input, options);
    };
    const main = f.world.observe(); await requestEntered.promise; await tick(); releaseEndpoint.resolve(); await blocker;
    await saveEntered.promise;
    const waiting = stages().find(value => value.entry.id > before && value.actorId === "bot"); assert.ok(waiting);
    assert.equal(waiting.stage, "save"); assert.equal(waiting.timing.attempts, 2);
    const guest = f.world.observe("guest"); await tick();
    assert.equal(attempts, 2, "world serialization prevents the guest inference from overtaking the first save");
    releaseSave.resolve(); await Promise.all([main, guest]);
    const completed = stages().filter(value => value.entry.id > before);
    const bot = completed.find(value => value.actorId === "bot")!, visitor = completed.find(value => value.actorId === "guest")!;
    assert.equal(bot.stage, "completed"); assert.equal(bot.timing.repairs, 1); assert.equal(bot.timing.attempts, 2);
    const initial = f.samples[0]!.find(sample => sample.phase === "finished")!, repair = f.samples[1]!.find(sample => sample.phase === "finished")!;
    closeEnough(bot.timing.endpointQueueMs, initial.queueMs + repair.queueMs);
    closeEnough(bot.timing.modelMs, initial.runMs!);
    assert.ok(bot.timing.repairMs + 0.03 >= repair.runMs!, "repair bucket includes its generation and validation, not endpoint waiting");
    closeEnough(bot.timing.queueMs, bot.timing.worldQueueMs + bot.timing.endpointQueueMs);
    assert.ok(bot.timing.saveMs >= 0); assert.ok(bot.timing.inputChars > 0); assert.ok(bot.timing.outputChars > 0);
    assert.equal(visitor.timing.attempts, 1); assert.equal(visitor.timing.repairs, 0); assert.ok(visitor.timing.worldQueueMs >= 0);
    assert.equal(visitor.stage, "completed");
    const totalBuckets = bot.timing.queueMs + bot.timing.preparationMs + bot.timing.modelMs + bot.timing.repairMs + bot.timing.validationMs + bot.timing.saveMs;
    assert.ok(totalBuckets <= bot.timing.totalMs + 1, "mutually exclusive timing buckets do not exceed total wall time, allowing rounding/framework overhead");
  } finally { releaseEndpoint.resolve(); releaseSave.resolve(); await blocker; f.store.commit = originalCommit; await f.close(); }
  console.log("PASS runtime fourth-argument timing measures separate endpoint wait, initial inference, repair and serialized saving phases");
}

async function failureAndCancellationAreFinal() {
  const failed = await fixture();
  try {
    const before = debug.snapshot(); failed.setHandler(async () => native({ perceptions: [] }));
    await assert.rejects(failed.world.observe(), /实际感知/);
    const final = stages().find(value => value.entry.id > before)!;
    assert.equal(final.stage, "failed"); assert.equal(final.timing.attempts, 3); assert.equal(final.timing.repairs, 2); assert.equal(final.timing.saveMs, 0);
  } finally { await failed.close(); }
  for (const phase of ["queued", "running"] as const) {
    const f = await fixture(), blockEntered = deferred(), release = deferred(), inferred = deferred(), generating = deferred();
    const before = debug.snapshot();
    const blocker = phase === "queued" ? withEndpointLock(f.endpoint, async () => { blockEntered.resolve(); await release.promise; }) : Promise.resolve();
    try {
      if (phase === "queued") await blockEntered.promise;
      f.onInfer(() => inferred.resolve());
      f.setHandler(async () => { generating.resolve(); await release.promise; return perception(); });
      const task = f.world.observe(), rejected = assert.rejects(task);
      await inferred.promise; if (phase === "running") await generating.promise;
      f.world.stop(); await rejected; await f.world.shutdown();
      const final = stages().find(value => value.entry.id > before)!;
      assert.equal(final.stage, "cancelled"); assert.equal(final.timing.attempts, 1); assert.equal(final.timing.saveMs, 0);
      if (phase === "queued") {
        assert.equal(final.timing.modelMs, 0, "a cancelled endpoint waiter spent no time generating");
        assert.equal(f.samples[0]!.length, 1); assert.equal(f.samples[0]![0]!.runMs, 0);
      }
      const frozen = final.entry.detail;
      release.resolve(); await blocker; await tick(); await tick();
      assert.equal(namedStage(final.id).entry.detail, frozen, "a late provider completion cannot mutate the cancelled trace");
      assert.equal(f.store.snapshot().worldState, "房间里有一张桌子。");
    } finally { release.resolve(); await blocker; await f.close(); }
  }
  console.log("PASS failed/cancelled traces finish once; queued cancellation counts zero generation and late hooks cannot alter completed diagnostics or world state");
}

async function main() { await exactPhaseAccounting(); await runtimeRepairQueueAndSave(); await failureAndCancellationAreFinal(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
