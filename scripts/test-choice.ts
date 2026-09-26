import assert from "node:assert/strict";
import { resolveHumanChoice } from "../src/bot/choice.js";
import type { ActionOpportunity } from "../src/bot/opportunities.js";
import { ToolCallParseError } from "../src/llm/parse.js";

const world: ActionOpportunity = { id: "world-one", label: "去河边", intent: "走到河边看看", source: "world", sourceEventId: "scene-1",
  exclusiveGroup: "location", call: { name: "act", arguments: { description: "走到河边看看", detail: { side: "left", things: ["桥", "树"] } }, duration: 30 } };
const device: ActionOpportunity = { id: "device-one", label: "看通知", intent: "读取实际消息列表", source: "device", sourceEventId: "notice-1", call: { name: "check_msg", arguments: { n: 10 } } };
const reply: ActionOpportunity = { id: "reply-one", label: "考虑回应", intent: "考虑回应这条实际收到的消息", source: "device", sourceEventId: "message-1", replyTo: "onebot@100:group-a" };
const ref = (option: ActionOpportunity) => ({ opportunityId: option.id, sourceEventId: option.sourceEventId });
const clone = <T>(value: T): T => structuredClone(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
};
function reject(reference: unknown, offered: readonly ActionOpportunity[], current = offered, match = /没有执行操作/, text?: unknown, duration?: unknown): void {
  assert.throws(() => resolveHumanChoice(reference, offered, text, duration as number, current), error => error instanceof ToolCallParseError && match.test(error.message));
}

const offered = freeze([clone(world), clone(device), clone(reply)]);
const current = freeze([clone(reply), clone(device), clone(world)]);
const reference = freeze(ref(world)), speech = "  等等，我先看看桥。\n不要跟过来。 ";
const before = clone({ offered, current, reference });
const selected = resolveHumanChoice(reference, offered, speech, 0, current);
assert.deepEqual(selected.selection, { index: 1, opportunityId: "world-one", sourceEventId: "scene-1", label: "去河边" });
assert.equal(selected.call.name, "act"); assert.equal(selected.call.duration, 0);
assert.equal(selected.call.arguments.description, world.call!.arguments.description);
assert.equal(selected.call.arguments.speech, speech, "speech is the exact human-supplied text, never inferred or trimmed");
assert.deepEqual({ offered, current, reference }, before);
(selected.call.arguments.detail as any).side = "right";
assert.equal((offered[0]!.call!.arguments.detail as any).side, "left", "the actual call is detached from the frozen menu");
assert.equal(resolveHumanChoice(reference, offered, undefined, undefined, current).call.duration, 30);
assert.equal(resolveHumanChoice(reference, offered).call.arguments.speech, undefined, "world actions need no invented speech");
assert.deepEqual(resolveHumanChoice(ref(device), offered, undefined, undefined, current).call, device.call);
assert.equal(resolveHumanChoice(ref(world), current).call.name, "act", "reordering cannot redirect a stable identity");

const reordered = clone(world);
reordered.call = { duration: 30, arguments: { detail: { things: ["桥", "树"], side: "left" }, description: "走到河边看看" }, name: "act" };
assert.equal(resolveHumanChoice(ref(world), [world], undefined, undefined, [reordered]).call.name, "act", "object key order does not change meaning");
assert.deepEqual(resolveHumanChoice(ref(device), [device], undefined, undefined, [{ ...device, call: { ...device.call!, duration: undefined } }]).call, device.call);

const sending = resolveHumanChoice(ref(reply), offered, "这座桥有一块踏板断了，我已经退回岸边。", undefined, current);
assert.deepEqual(sending.call, { name: "send", arguments: { id: "onebot@100:group-a", msg: "这座桥有一块踏板断了，我已经退回岸边。" } });
assert.equal(resolveHumanChoice(ref(reply), [reply], "  原文\n不改  ", 0).call.arguments.msg, "  原文\n不改  ");
assert.equal(resolveHumanChoice(ref(reply), [reply], "正文", 0).call.duration, 0);
reject(ref(reply), offered, current, /需要 text 正文.*或自由使用 send/);
reject(ref(device), offered, current, /不接受 text/, "不要默默丢弃这段正文");
reject(ref(device), [{ ...device, call: { name: "send", arguments: { id: "fixed", msg: "固定内容" } } }], undefined, /自己提供正文/);

for (const invalid of [undefined, null, "1", 1, true, [], {}, { index: 1 }, { opportunityId: world.id }, { sourceEventId: world.sourceEventId },
  { ...reference, index: 1 }, { ...reference, name: "act" }, { ...reference, arguments: {} }, { ...reference, target: "forged" }, { ...reference, duration: 1 }])
  reject(invalid, offered, current, /opportunityId 与 sourceEventId/);
reject({ ...reference, sourceEventId: "other" }, offered, current, /已过期/);
for (const text of ["", " \n\t", 42, false, null, {}, []]) reject(reference, offered, current, /text/, text);
for (const duration of [-1, NaN, Infinity, "0", null, true]) reject(reference, offered, current, /duration/, undefined, duration);

reject(reference, [], [], /没有已提供/);
reject(reference, [world], [], /不再可用/);
reject(reference, [world], [device], /不再可用/);
reject(reference, [world, clone(world)], [world], /重复/);
reject(reference, [world], [world, clone(world)], /重复/);
for (const patch of [
  { label: "新标题" }, { intent: "新的真实意图" }, { sourceEventId: "scene-2" }, { source: "device" as const }, { exclusiveGroup: "other" },
  { call: { ...world.call!, arguments: { description: "走向另一个地点" } } }, { call: { ...world.call!, duration: 31 } },
  { call: { ...world.call!, arguments: { ...world.call!.arguments, detail: { side: "left", things: ["树", "桥"] } } } },
]) reject(reference, [world], [{ ...world, ...patch }], /已变化/);
reject(ref(reply), [reply], [{ ...reply, replyTo: "onebot@100:group-b" }], /已变化/, "正文");
reject(ref(reply), [reply], [{ ...reply, replyTo: undefined }], /已变化/, "正文");
reject(ref(device), [{ ...device, call: { name: "choose", arguments: { index: 1 } } }], undefined, /没有可执行的实际操作/);
reject(ref(device), [{ ...device, call: undefined }], undefined, /没有可执行/);
reject(reference, [{ ...world, call: device.call }], undefined, /来源不符/);
reject(ref(device), [{ ...device, call: world.call }], undefined, /来源不符/);
reject(ref(reply), [{ ...reply, replyTo: "" }], undefined, /目标不明确/, "正文");
reject(ref(reply), [{ ...reply, source: "world" }], undefined, /目标不明确/, "正文");
reject(ref(reply), [{ ...reply, call: { name: "send", arguments: { id: "other", msg: "not supplied by actor" } } }], undefined, /目标不明确/, "正文");
console.log("PASS human choice: stable references, immutable actual tools, exact speech/recipient, no model choose protocol, semantic freshness, default/zero duration and device boundaries");
