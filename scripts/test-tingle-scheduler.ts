import assert from "node:assert/strict";
import type { Logger } from "koishi";
import type { ClockConfigData } from "../src/config.js";
import type { WorldClock } from "../src/clock.js";
import { TingleTimer, type HeartbeatResult } from "../src/world/tingle.js";
import { debug } from "../src/webui/debug.js";

const logger = { info() {}, debug() {}, warn() {} } as unknown as Logger;
const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalNow = Date.now;
const pending = new Map<number, { run: () => void; delay: number }>();
let serial = 0, now = 100, wall = 0;
globalThis.setTimeout = ((run: () => void, delay: number) => { const id = ++serial; pending.set(id, { run, delay }); return id; }) as any;
globalThis.clearTimeout = ((id: number) => pending.delete(id)) as any;
Date.now = () => wall;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const fire = async () => { assert.equal(pending.size, 1, "there is exactly one scheduling chain"); const [id, task] = [...pending][0]!; pending.delete(id); now += task.delay / 1000; wall += task.delay; task.run(); await settle(); };
const delay = () => [...pending][0]?.[1].delay;
const config = (mode: "auto" | "fixed", extra = {}): ClockConfigData => ({ tingleMode: mode, tingleEveryUnits: 10, tingleMinUnits: 5, tingleMaxUnits: 40, ...extra } as ClockConfigData);
const clock = { unitRealSeconds: 1, now: () => now } as WorldClock;
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function cadence() {
  let outcome: HeartbeatResult | number | null | Error = { status: "quiet" }, calls = 0;
  const timer = new TingleTimer(config("auto"), clock, { async tingle() { calls++; if (outcome instanceof Error) throw outcome; return outcome; } }, () => {}, logger);
  try {
    assert.equal(timer.status().phase, "idle"); timer.start(); timer.start(); assert.equal(delay(), 10_000);
    for (const expected of [15, 22.5, 33.75, 40, 40]) { await fire(); assert.equal(timer.status().intervalTU, expected); assert.equal(timer.status().phase, "scheduled"); }
    assert.equal(timer.status().quietStreak, 5); assert.equal(calls, 5);
    outcome = { status: "committed", nextIntervalTU: 2, sequence: 7, perceptions: 2, attempts: 2, elapsedMs: 11 }; await fire();
    assert.equal(timer.status().intervalTU, 5); assert.equal(timer.status().quietStreak, 0); assert.equal(timer.status().lastOutcome?.sequence, 7); assert.equal(timer.status().lastOutcome?.elapsedMs, 11);
    outcome = { status: "committed", nextIntervalTU: 500 }; await fire(); assert.equal(timer.status().intervalTU, 40);
    outcome = { status: "committed" }; await fire(); assert.equal(timer.status().intervalTU, 10);
    outcome = { status: "quiet", nextIntervalTU: 30 }; await fire(); assert.equal(timer.status().intervalTU, 30, "quiet suggestions may extend the natural backoff");
    outcome = { status: "quiet", nextIntervalTU: 1 }; await fire(); assert.equal(timer.status().intervalTU, 40, "quiet suggestions cannot accelerate polling below the increasing quiet cadence");
    outcome = { status: "quiet", nextIntervalTU: 1000 }; await fire(); assert.equal(timer.status().intervalTU, 40, "quiet suggestions still respect the ceiling");
    outcome = { status: "committed" }; await fire();
    outcome = { status: "quiet", nextIntervalTU: NaN }; await fire(); assert.equal(timer.status().intervalTU, 15, "invalid suggestions never create a zero-delay loop");
    outcome = { status: "yielded", reason: "角色行动优先" }; await fire(); assert.equal(timer.status().intervalTU, 10); assert.equal(timer.status().consecutiveFailures, 0); assert.equal(timer.status().lastOutcome?.status, "yielded");
    outcome = new Error("WORLD_VALIDATION_FAILED");
    for (const expected of [20, 40, 40]) { await fire(); assert.equal(timer.status().intervalTU, expected); assert.equal(timer.status().phase, "failed"); assert.equal(timer.status().nextAtTU, now + expected); }
    assert.equal(timer.status().consecutiveFailures, 3); assert.equal(timer.status().error, "WORLD_VALIDATION_FAILED");
    const external = timer.status(); external.lastOutcome!.reason = "forged"; external.consecutiveFailures = 0;
    assert.equal(timer.status().error, "WORLD_VALIDATION_FAILED"); assert.equal(timer.status().lastOutcome?.reason, "WORLD_VALIDATION_FAILED"); assert.equal(timer.status().consecutiveFailures, 3);
    outcome = { status: "quiet" }; await fire(); assert.equal(timer.status().intervalTU, 15); assert.equal(timer.status().consecutiveFailures, 0); assert.equal(timer.status().error, null);
    outcome = 30; await fire(); assert.equal(timer.status().intervalTU, 30); assert.equal(timer.status().lastOutcome?.status, "quiet", "legacy scheduling hints cannot be called a verified commit");
  } finally { timer.stop(); }
  assert.equal(pending.size, 0); assert.equal(timer.status().phase, "stopped"); assert.equal(timer.status().nextAtTU, null);

  let fixedOutcome: HeartbeatResult | Error = { status: "committed", nextIntervalTU: 30 };
  const fixed = new TingleTimer(config("fixed"), clock, { async tingle() { if (fixedOutcome instanceof Error) throw fixedOutcome; return fixedOutcome; } }, () => {}, logger);
  try {
    fixed.start(); await fire(); assert.equal(fixed.status().intervalTU, 10);
    fixedOutcome = { status: "quiet" }; await fire(); assert.equal(fixed.status().intervalTU, 10);
    fixedOutcome = new Error("network unavailable"); for (const expected of [20, 40, 40]) { await fire(); assert.equal(fixed.status().intervalTU, expected); }
    fixedOutcome = { status: "yielded" }; await fire(); assert.equal(fixed.status().intervalTU, 10); assert.equal(fixed.status().consecutiveFailures, 0);
  } finally { fixed.stop(); }
}

async function generations() {
  const old = deferred<HeartbeatResult>(), current = deferred<HeartbeatResult>();
  let calls = 0, oldDeliver!: (content: string) => void, currentDeliver!: (content: string) => void;
  const deliveries: string[] = [];
  const timer = new TingleTimer(config("auto"), clock, { tingle(deliver) { calls++; if (calls === 1) { oldDeliver = deliver; return old.promise; } currentDeliver = deliver; return current.promise; } }, content => deliveries.push(content), logger);
  try {
    timer.start(); await fire(); assert.equal(calls, 1); assert.equal(timer.status().phase, "running"); assert.equal(timer.status().nextAtTU, null); assert.equal(pending.size, 0);
    timer.stop(); timer.start(); await fire(); assert.equal(calls, 1, "a restart cannot overlap a still-unwinding heartbeat"); assert.equal(pending.size, 1);
    oldDeliver("late old generation"); old.resolve({ status: "committed", sequence: 99 }); await settle();
    assert.deepEqual(deliveries, []); assert.equal(timer.status().lastOutcome, null); assert.equal(pending.size, 1);
    await fire(); assert.equal(calls, 2); currentDeliver("fresh perception"); assert.deepEqual(deliveries, ["fresh perception"]);
    timer.stop(); currentDeliver("after stop"); current.reject(new Error("late failure")); await settle();
    assert.deepEqual(deliveries, ["fresh perception"]); assert.equal(timer.status().phase, "stopped"); assert.equal(timer.status().consecutiveFailures, 0); assert.equal(pending.size, 0);
  } finally { timer.stop(); }
}

async function longIntervals() {
  let calls = 0;
  const timer = new TingleTimer(config("fixed", { tingleEveryUnits: 3_000_000 }), clock, { async tingle() { calls++; return { status: "quiet" }; } }, () => {}, logger);
  try { timer.start(); assert.equal(delay(), 2_147_483_647); await fire(); assert.equal(calls, 0); assert.equal(delay(), 852_516_353); await fire(); assert.equal(calls, 1); } finally { timer.stop(); }
  const disabled = new TingleTimer(config("auto", { tingleEveryUnits: 0 }), clock, { async tingle() { throw Error("disabled timer ran"); } }, () => {}, logger);
  disabled.start(); assert.equal(disabled.status().phase, "idle"); assert.equal(pending.size, 0);
}

async function main() { try {
  const initialEvent = debug.snapshot();
  await cadence(); await generations(); await longIntervals();
  const events = debug.since(initialEvent).filter(event => event.kind === "world.task").map(event => JSON.parse(event.detail));
  for (const stage of ["start", "committed", "quiet", "yielded", "failed"]) assert(events.some(event => event.task === "tingle" && event.stage === stage), stage + " is observable independently");
  assert(events.find(event => event.stage === "failed").heartbeat.nextAtTU !== null, "failure events include the actual scheduled retry");
    console.log("PASS heartbeat: adaptive quiet cadence and bounded suggestions, error backoff, fixed successes, explicit yield, immutable status, debug outcomes, one generation, late-delivery rejection and long timer chunks");
} finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; Date.now = originalNow; } }
main().catch(error => { console.error(error); process.exitCode = 1; });
