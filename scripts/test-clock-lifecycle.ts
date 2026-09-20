import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldClock } from "../src/clock.js";
import type { ClockConfigData } from "../src/config.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("clock write did not settle")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
const dirs: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-clock-lifecycle-"));
  dirs.push(dir);
  const file = path.join(dir, "clock.json");
  const clock = new WorldClock({ syncRealTime: false, epoch: "2012-03-04 05:06", realSecondsPerUnit: 2, worldSecondsPerUnit: 60 } as ClockConfigData, file);
  await clock.load();
  return { clock, file, read: async () => JSON.parse(await fs.readFile(file, "utf8")) };
}

/** Stop one actual filesystem operation; no timing-dependent simulated sleeps. */
function holdWrite(file: string, stage: "writeFile" | "rename") {
  const entered = deferred(), release = deferred();
  const original = fs[stage];
  let held = false;
  (fs as any)[stage] = async (...args: any[]) => {
    if (!held && String(args[0]).startsWith(`${file}.`) && String(args[0]).endsWith(".tmp")) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return (original as any)(...args);
  };
  return { entered, release, restore() { (fs as any)[stage] = original; } };
}

async function oldCheckpointCannotOverwriteReset() {
  for (const stage of ["writeFile", "rename"] as const) {
    const f = await fixture();
    await f.clock.advance(120);
    await f.clock.resume();
    const held = holdWrite(f.file, stage);
    let checkpoint!: Promise<void>, resetting!: Promise<void>;
    try {
      checkpoint = (f.clock as any).checkpoint();
      await bounded(held.entered.promise);
      let resetDone = false;
      resetting = f.clock.reset().then(() => { resetDone = true; });
      await tick();
      assert.equal(resetDone, false, `reset must drain the older checkpoint blocked in ${stage}`);
      held.release.resolve();
      await bounded(Promise.all([checkpoint, resetting]));
      const persisted = await f.read();
      assert.equal(persisted.accumulatedTU, 0, `late ${stage} must not restore the previous world's time`);
      assert.equal(persisted.runningSince, null);
      assert.equal(f.clock.now(), 0);
      assert.equal((f.clock as any).checkpointTimer, null);
      assert.deepEqual((await fs.readdir(path.dirname(f.file))).filter(name => name.endsWith(".tmp")), []);
    } finally {
      held.release.resolve();
      held.restore();
      await Promise.allSettled([checkpoint, resetting]);
      await f.clock.pause();
    }
  }
  console.log("PASS clock reset drains old checkpoint writes and renames; persisted time cannot return to the previous world");
}

async function pausedClockStillDrainsDiskWrites() {
  for (const method of ["pause", "suspend"] as const) {
    for (const stage of ["writeFile", "rename"] as const) {
      const f = await fixture();
      const held = holdWrite(f.file, stage);
      let writing!: Promise<void>, stopping!: Promise<void>;
      try {
        // advance persists while the clock is already paused. The no-op stop
        // path must still join this write before reset deletes/replaces files.
        writing = f.clock.advance(40);
        await bounded(held.entered.promise);
        assert.equal((f.clock as any).state.runningSince, null);
        let stopped = false;
        stopping = f.clock[method]().then(() => { stopped = true; });
        await tick();
        assert.equal(stopped, false, `${method} must join a pending ${stage} even when runningSince is null`);
        held.release.resolve();
        await bounded(Promise.all([writing, stopping]));
        assert.equal((await f.read()).accumulatedTU, 40);
        // A subsequent reset is final, including after the stopped write's
        // continuation has had another event-loop turn to run.
        await f.clock.reset(); await tick();
        assert.equal((await f.read()).accumulatedTU, 0);
      } finally {
        held.release.resolve(); held.restore();
        await Promise.allSettled([writing, stopping]);
      }
    }
  }
  console.log("PASS pause and suspend drain pending disk writes even when the clock was already paused");
}

async function failedCheckpointDoesNotPoisonReset() {
  const f = await fixture(), original = fs.rename;
  try {
    fs.rename = async (oldPath, newPath) => {
      if (String(newPath) === f.file) throw new Error("fixture rename failure");
      return original(oldPath, newPath);
    };
    await assert.rejects(f.clock.advance(30), /fixture rename failure/);
  } finally { fs.rename = original; }
  await f.clock.reset();
  assert.equal((await f.read()).accumulatedTU, 0);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).filter(name => name.endsWith(".tmp")), []);
  console.log("PASS a failed save rejects its caller and cleans up without blocking the next reset");
}

async function main() {
  try {
    await oldCheckpointCannotOverwriteReset();
    await pausedClockStillDrainsDiskWrites();
    await failedCheckpointDoesNotPoisonReset();
  } finally { await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
