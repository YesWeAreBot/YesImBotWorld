import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setEndpointLockEnabled, withEndpointLock, type EndpointLockTiming } from "../src/llm/lock.js";

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const origin = () => `http://${randomUUID()}.invalid`;
const aborted = (error: Error) => error.name === "AbortError";

async function priorityAndFairness() {
  const endpoint = origin(), entered = deferred(), release = deferred(), events: string[] = [];
  let active = 0, maximum = 0;
  const work = (name: string) => async () => { active++; maximum = Math.max(maximum, active); events.push(name); await tick(); active--; return name; };
  const first = withEndpointLock(endpoint + "/v1", async () => { entered.resolve(); await release.promise; events.push("first"); });
  await entered.promise;
  const background = [1, 2].map(id => withEndpointLock(endpoint + "/other", work("background" + id), undefined, { priority: "background" }));
  const interactive = Array.from({ length: 8 }, (_, index) => withEndpointLock(endpoint, work("interactive" + (index + 1))));
  await tick(); assert.deepEqual(events, [], "no priority preempts an already-running request");
  release.resolve(); await Promise.all([first, ...background, ...interactive]);
  assert.deepEqual(events, ["first", "interactive1", "interactive2", "interactive3", "background1", "interactive4", "interactive5", "interactive6", "background2", "interactive7", "interactive8"]);
  assert.equal(maximum, 1, "same-origin requests never overlap, even across URL paths");
}

async function cancellationKeepsActiveOwnership() {
  const endpoint = origin(), entered = deferred(), release = deferred(), activeAbort = new AbortController(), queuedAbort = new AbortController();
  const samples: EndpointLockTiming[] = [], queuedSamples: EndpointLockTiming[] = [];
  const active = withEndpointLock(endpoint, async () => { entered.resolve(); await release.promise; return "late"; }, activeAbort.signal, { onTiming: sample => samples.push(sample) });
  const activeRejected = assert.rejects(active, aborted); await entered.promise;
  let cancelledRan = false, nextRan = false;
  const cancelled = withEndpointLock(endpoint, async () => { cancelledRan = true; }, queuedAbort.signal,
    { priority: "background", onTiming: sample => queuedSamples.push(sample) });
  const queuedRejected = assert.rejects(cancelled, aborted);
  const next = withEndpointLock(endpoint, async () => { nextRan = true; });
  queuedAbort.abort(); activeAbort.abort(); await Promise.all([activeRejected, queuedRejected]); await tick();
  assert.equal(nextRan, false, "caller cancellation cannot release a still-running worker");
  assert.equal(cancelledRan, false); assert.equal(samples.length, 1); assert.equal(samples[0]!.phase, "started");
  assert.equal(queuedSamples.length, 1); assert.equal(queuedSamples[0]!.phase, "finished"); assert.equal(queuedSamples[0]!.runMs, 0);
  assert.ok(queuedSamples[0]!.queueMs >= 0); assert.equal(queuedSamples[0]!.startedAt, queuedSamples[0]!.finishedAt);
  release.resolve(); await next;
  assert.equal(samples.length, 2); assert.equal(samples[1]!.phase, "finished"); assert.ok(samples[1]!.runMs! >= 0);
  assert.equal(samples[0]!.queueMs, samples[1]!.queueMs);
}

async function independenceFailuresAndDisabledMode() {
  const endpoint = origin(), entered = deferred(), release = deferred();
  const first = withEndpointLock(endpoint, async () => { entered.resolve(); await release.promise; }); await entered.promise;
  assert.equal(await withEndpointLock(origin(), async () => 7), 7, "another origin does not wait");
  setEndpointLockEnabled(false);
  try { assert.equal(await withEndpointLock(endpoint, async () => 8), 8, "serialization disabled preserves concurrent mode"); }
  finally { setEndpointLockEnabled(true); }
  release.resolve(); await first;
  await assert.rejects(withEndpointLock(endpoint, async () => { throw new Error("request failed"); }), /request failed/);
  assert.equal(await withEndpointLock(endpoint, async () => 9, undefined, { onTiming: () => { throw new Error("observer failed"); } }), 9);
  const stop = new AbortController(); stop.abort(); let called = false;
  const stoppedSamples: EndpointLockTiming[] = [];
  await assert.rejects(withEndpointLock(endpoint, async () => { called = true; }, stop.signal, { onTiming: sample => stoppedSamples.push(sample) }), aborted); assert.equal(called, false);
  assert.equal(stoppedSamples.length, 1); assert.equal(stoppedSamples[0]!.runMs, 0); assert.equal(stoppedSamples[0]!.queueMs, 0);
  const hookAbort = new AbortController();
  await assert.rejects(withEndpointLock(endpoint, async () => { called = true; }, hookAbort.signal,
    { onTiming: sample => { if (sample.phase === "started") hookAbort.abort(); } }), aborted);
  assert.equal(called, false, "a start observer cancelling the task cannot still start its worker");
  assert.equal(await withEndpointLock(endpoint, async () => 10), 10, "no cancelled or failed request retains the queue");
}

async function main() {
  await priorityAndFairness(); await cancellationKeepsActiveOwnership(); await independenceFailuresAndDisabledMode();
  console.log("PASS endpoint scheduling: interactive priority, bounded background starvation, origin isolation, FIFO, abort ownership, timing and observer isolation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
