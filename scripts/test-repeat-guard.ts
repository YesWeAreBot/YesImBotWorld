/** Concise advisory output must leave repeat detection and its diagnostic facts intact. */
import assert from "node:assert/strict";
import { RepeatGuard, canonicalizeArgs, type RepeatGuardConfig } from "../src/bot/repeatGuard.js";
import type { ToolCallRecord } from "../src/types.js";

const config: RepeatGuardConfig = { thresholds: [2, 4], include: [], exclude: ["bookkeeping*"], argumentsPreviewChars: 48,
  cycleRepeatMin: 3, cycleMaxPeriod: 3 };
const call = (name: string, args: Record<string, unknown> = {}): ToolCallRecord => ({ id: "fixture", name, role: "agent", arguments: args, issuedAt: 0, expectedAt: 0, duration: 0 });
const args = { detail: "DIAGNOSTIC_ONLY_12345" + "长".repeat(2000), options: { z: 1, a: [true, { y: "value", x: 2 }] } };
const before = structuredClone(args);
const guard = new RepeatGuard(config);
const first = guard.observe(call("read_channel", args))!;
assert.equal(first.count, 1); assert.equal(first.notice, null);
assert.equal(guard.observe(call("bookkeeping.test", { saved: true })), null);
const second = guard.observe(call("read_channel", { options: args.options, detail: args.detail }))!;
assert.equal(second.count, 2, "excluded bookkeeping remains transparent and object key order does not reset the chain");
assert.equal(second.notice, "同一 read_channel 调用正在重复，请先检查上次结果。");
assert.ok(second.argumentsPreview.startsWith('{"detail":"DIAGNOSTIC_ONLY_12345'));
assert.ok(second.argumentsPreview.length < 100, "large argument previews remain bounded diagnostics");
const third = guard.observe(call("read_channel", args))!;
const fourth = guard.observe(call("read_channel", args))!;
assert.equal(third.count, 3); assert.equal(third.notice, null);
assert.equal(fourth.count, 4); assert.equal(fourth.notice, second.notice);
for (const event of [second, fourth]) {
  assert.ok(event.notice!.length < 60);
  assert.doesNotMatch(event.notice!, /DIAGNOSTIC_ONLY|12345|参数|连续调用次数|没有.*进展|没有.*新|失去|浪费|零收益|立刻/,
    "reminders state repetition without copying payloads, counts or inventing failed outcomes");
}
assert.deepEqual(args, before, "advice never rewrites the requested operation");
assert.equal(guard.observe(call("read_channel", { changed: true }))!.count, 1);
guard.reset(); assert.equal(guard.observe(call("read_channel", args))!.count, 1);
assert.equal(canonicalizeArgs({ z: 1, a: { y: 2, x: 3 } }), canonicalizeArgs({ a: { x: 3, y: 2 }, z: 1 }));

const cycle = new RepeatGuard(config);
const observed = ["act", "rest", "act", "rest", "act", "rest"].map(name => cycle.observe(call(name, { confidential: "secret" }))!);
assert.ok(observed.slice(0, 5).every(item => !item.cycle));
const detected = observed[5]!;
assert.equal(detected.cycle, true); assert.equal(detected.count, 0);
assert.equal(detected.notice, "操作序列正在重复：act → rest。请先检查上次结果。");
assert.deepEqual(detected.cyclePattern, ["act", "rest"]); assert.equal(detected.cyclePeriods, 3);
assert.ok(detected.argumentsPreview.includes("secret")); assert.ok(!detected.notice!.includes("secret"));
for (const name of ["act", "rest", "act", "rest"]) assert.equal(cycle.observe(call(name, { confidential: "secret" }))!.cycle, false,
  "rotated windows of the same cycle do not emit another cycle reminder");
cycle.reset();
const rediscovered = ["act", "rest", "act", "rest", "act", "rest"].map(name => cycle.observe(call(name))!);
assert.equal(rediscovered.at(-1)!.cycle, true, "actual progress reset still permits detecting a newly repeated sequence");
for (const thresholds of [[1], [2, 2], [2.5]]) assert.throws(() => new RepeatGuard({ ...config, thresholds }), /repeatGuard/);
console.log("PASS repeat guard: short factual notices, no argument/count lectures, unchanged thresholds/canonical chains/cycle suppression/reset, bounded internal diagnostics");
