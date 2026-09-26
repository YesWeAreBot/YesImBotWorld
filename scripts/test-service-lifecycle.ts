/** Exercise the actual service entry points using temporary files and deterministic world IO. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldService } from "../src/service.js";
import { WorldFiles } from "../src/files.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { WorldLifecycle } from "../src/world/lifecycle.js";
import { Prompts } from "../src/prompts.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(r => setImmediate(r));
async function main() {
const root = await fs.mkdtemp(path.join(os.tmpdir(), "world-service-lifecycle-"));
let fixtureId = 0;
async function fixture() {
  const files = new WorldFiles(path.join(root, String(++fixtureId))); await files.ensure();
  await fs.writeFile(files.botDef, "小澈，一名普通学生。");
  await fs.writeFile(files.worldDef, "校园里的一间自习室。");
  const ledger = await NarrativeStore.open(files.base, { now: () => 10 }); files.bindNarrativeStore(ledger);
  let lifetime = new AbortController();
  const counts = { resumes: 0, pauses: 0, clockResets: 0, cleanups: 0, inits: 0, clears: 0, resetSession: 0 };
  const world: any = {
    stop() { lifetime.abort(new Error("world cancelled")); },
    resume() { if (lifetime.signal.aborted) lifetime = new AbortController(); counts.resumes++; },
    async shutdown() { world.stop(); await world.pendingIO; },
    resetSessionState() { counts.resetSession++; },
    setHostBotDeliver() {}, setRemote() {},
    runtime: { async inspect() { return ledger.snapshot(); }, async reload() { await ledger.reload(); } },
    async initialize() { counts.inits++; const signal = lifetime.signal; await world.generate(signal); signal.throwIfAborted(); },
    async generate(signal: AbortSignal) { signal.throwIfAborted(); await commit(); },
  };
  async function commit() {
    if (!ledger.snapshot().initialized) await ledger.commit({ idempotencyKey: "genesis", source: "fixture", initialized: true,
      worldState: "自习室里很安静。", actors: { bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "坐在桌前。", perception: "窗外树叶轻轻摇动。" } } });
  }
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { files, world, logger, promptStore: new Prompts(), phoneStatus: { down: false },
    focus: { async clear() {}, async load() {} }, notifyMgr: { async reset() {}, async load() {}, async clearMessages() {} },
    store: { async clear() { counts.clears++; } }, deviceTail: Promise.resolve(),
    clock: { async reset() { counts.clockResets++; }, async pause() { counts.pauses++; }, async resume() {}, timeLine: () => "T10", async load() {} },
    pinnedToolsText: () => "", worldActive: false, bot: null,
  });
  return { service, world, files, ledger, counts, commit };
}

try {
  // Repeated init on an existing running world is a no-op, not an implicit pause.
  const f = await fixture();
  assert.match(await f.service.initWorld(), /创世完成/);
  assert.equal(await f.files.isInitialized(), true);
  assert.equal(await f.files.exists(f.files.genesisPending), false);
  f.service.worldActive = true;
  f.service.bot = { async stop() { f.counts.cleanups++; } };
  const pauses = f.counts.pauses;
  assert.match(await f.service.initWorld(), /已经初始化/);
  assert.equal(f.service.worldActive, true);
  assert.equal(f.counts.pauses, pauses);
  assert.equal(f.counts.cleanups, 0);

  // Reset cancels inference immediately, but cannot delete the journal before a started write drains.
  const g = await fixture(), entered = gate(), io = gate();
  g.world.pendingIO = io.promise;
  // The initial cleanup must be allowed through before introducing the simulated in-flight write.
  g.world.pendingIO = undefined;
  g.world.generate = async (signal: AbortSignal) => {
    g.world.pendingIO = io.promise;
    entered.resolve();
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const genesis = g.service.initWorld(); const failedGenesis = assert.rejects(genesis, /cancelled/);
  await entered.promise;
  await assert.rejects(g.service.initWorld(), /正在创世/);
  await assert.rejects(g.service.startWorld(), /正在创世/);
  let resetDone = false;
  const reset = g.service.resetWorld().then((result: string) => { resetDone = true; return result; });
  await tick(); await tick();
  assert.equal(resetDone, false);
  assert.equal(await g.files.exists(g.files.genesisPending), true, "reset must still be waiting for old IO");
  io.resolve(); await failedGenesis; await reset;
  assert.equal(await g.files.exists(g.files.genesisPending), false);
  assert.equal(await g.files.isInitialized(), false);
  assert.equal(g.counts.resetSession, 1);
  g.world.generate = async () => g.commit();
  assert.match(await g.service.initWorld(), /创世完成/);
  assert.equal(g.counts.inits, 2, "only the cancelled attempt and the explicit new attempt run");

  // A committed world with unfinished phone/context setup cannot start; retry completes that lifetime.
  const h = await fixture();
  h.world.generate = async () => { await h.commit(); throw new Error("phone setup interrupted"); };
  await assert.rejects(h.service.initWorld(), /phone setup/);
  assert.equal(h.ledger.snapshot().initialized, true);
  assert.equal(await h.files.isInitialized(), false);
  assert.match(await h.service.startWorld(), /尚未完成创世/);
  assert.equal(h.counts.clockResets, 1);
  h.world.generate = async () => h.commit();
  await h.service.initWorld();
  assert.equal(h.counts.clockResets, 1, "completion must preserve the established timeline");
  assert.equal(h.counts.clears, 1, "completion must not clear chat history twice");
  assert.equal(h.ledger.snapshot().sequence, 1);
  assert.equal(await h.files.isInitialized(), true);

  // Invalid forced-init/restore input still cleans the lifetime already retired by the interrupt.
  for (const action of ["init", "restore"]) {
    const q = await fixture();
    q.service.worldActive = true;
    q.service.bot = { async stop() { q.counts.cleanups++; } };
    q.service.appManager = { async closeAll() { q.counts.cleanups++; } };
    q.service.computerDevice = { async close() { q.counts.cleanups++; } };
    q.service.computer = { async shutdown() { q.counts.cleanups++; } };
    if (action === "init") {
      await fs.writeFile(q.files.botDef, "");
      assert.match(await q.service.initWorld(true), /请先编写/);
    } else await assert.rejects(q.service.restoreArchive("../invalid"), /非法归档名/);
    assert.equal(q.counts.cleanups, 4);
    assert.equal(q.service.bot, null);
    assert.equal(q.service.computer, null);
    assert.ok(q.counts.pauses > 0);
  }

  // Startup failure before worldActive is set still retires every resource acquired so far.
  const p = await fixture();
  p.service.startWorldResources = async () => {
    p.service.bot = { async stop() { p.counts.cleanups++; } };
    p.service.computer = { async shutdown() { p.counts.cleanups++; } };
    throw new Error("perception recovery failed");
  };
  await assert.rejects(p.service.startWorld(), /perception recovery/);
  assert.equal(p.counts.cleanups, 2); assert.equal(p.service.bot, null); assert.equal(p.counts.pauses, 1);

  // An already-started inspection is IO too. Reset waits, while newer inspections wait for reset.
  const ioStarted = gate(), finishRead = gate();
  const order: string[] = [];
  const lifecycle = new WorldLifecycle(() => { order.push("cancel"); });
  const read = lifecycle.read(async () => { ioStarted.resolve(); await finishRead.promise; order.push("read"); });
  await ioStarted.promise;
  const replace = lifecycle.run("重置", async () => { order.push("reset"); }, true);
  const newer = lifecycle.read(async () => { order.push("new read"); });
  await tick(); assert.deepEqual(order, ["cancel"]);
  finishRead.resolve(); await Promise.all([read, replace, newer]);
  assert.deepEqual(order, ["cancel", "read", "reset", "new read"]);

  // Successive destructive requests cannot revive a cancelled operation waiting in the queue.
  const busy = gate(), finishBusy = gate(), transitions: string[] = [];
  const queue = new WorldLifecycle(() => {});
  const first = queue.run("创世", async signal => { busy.resolve(); await finishBusy.promise; signal.throwIfAborted(); });
  const firstCancelled = assert.rejects(first, /取消/);
  await busy.promise;
  const obsoleteReset = queue.run("重置", async () => { transitions.push("obsolete reset"); }, true);
  const resetCancelled = assert.rejects(obsoleteReset, /取消/);
  const replacement = queue.run("重新创世", async () => { transitions.push("replacement"); }, true);
  finishBusy.resolve(); await Promise.all([firstCancelled, resetCancelled, replacement]);
  assert.deepEqual(transitions, ["replacement"]);

  // A paused, never-opened world remains inspectable without gaining inference permission.
  const z = await fixture(); let calls = 0;
  const runtime = new NarrativeWorld(z.files, { now: () => 0 } as any, async () => { calls++; throw new Error("must not infer"); });
  await runtime.shutdown();
  const inspection: any = await runtime.inspect();
  assert.equal(inspection.snapshot.initialized, false);
  await assert.rejects(runtime.ensure());
  assert.equal(calls, 0);
  await runtime.shutdown();

  console.log("PASS: service lifecycle serializes genesis/reset/start/inspection, joins retired IO and resumes partial genesis honestly");
} finally { await fs.rm(root, { recursive: true, force: true }); }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
