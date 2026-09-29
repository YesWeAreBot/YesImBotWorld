import assert from "node:assert/strict";
import { MAX_REPAIR_DRAFT_CHARS, resolveWorldDraft, retainedWorldDraft } from "../src/world/draft.js";

const first = { worldPatch: { revision: "original", edits: [{ op: "append", text: "店员走到柜台前。" }] },
  actorStates: [{ actorId: "bot", state: "站在柜台前。" }],
  perceptions: [{ actorId: "bot", text: "店员向你打招呼。" }], outcome: { status: "ongoing", speechSpoken: false } };
const unchanged = structuredClone(first);
const next = resolveWorldDraft({ repair: { set: { outcome: { status: "completed" } } } }, first);
assert.deepEqual(first, unchanged, "a correction cannot mutate the earlier request/audit draft");
assert.deepEqual(next.worldPatch, first.worldPatch);
assert.deepEqual(next.actorStates, first.actorStates);
assert.deepEqual(next.perceptions, first.perceptions);
assert.deepEqual(next.outcome, { status: "completed" }, "set replaces the entire field, without retaining a forbidden speechSpoken");
const third = resolveWorldDraft({ repair: { remove: ["worldPatch"], set: { worldState: "屋里有一张柜台。" } } }, next);
assert.ok(!Object.hasOwn(third, "worldPatch")); assert.equal(third.worldState, "屋里有一张柜台。");
assert.deepEqual(next.worldPatch, first.worldPatch, "a later correction does not back-edit an earlier valid draft");
const full = resolveWorldDraft({ perceptions: [] }, next);
assert.deepEqual(full, { perceptions: [] }, "full proposals replace, rather than silently merge with, rejected drafts");
for (const repair of [null, [], { set: [] }, { remove: "outcome" }, { remove: [1] }, { bad: true },
  {}, { set: {}, remove: [] }, { set: { outcome: {} }, remove: ["outcome"] }, { remove: ["worldPatch", "worldPatch"] },
  { set: { repair: {} } }, { set: JSON.parse('{"__proto__":{"polluted":true}}') }, { remove: ["constructor"] }]) {
  assert.throws(() => resolveWorldDraft({ repair }, first), /WORLD_REPAIR_/);
  assert.deepEqual(first, unchanged);
}
assert.equal(({} as any).polluted, undefined);
assert.throws(() => resolveWorldDraft({ repair: { remove: ["outcome"] }, perceptions: [] }, first), /WORLD_REPAIR_FORMAT/);
assert.throws(() => resolveWorldDraft({ repair: { remove: ["outcome"] } }), /WORLD_REPAIR_UNAVAILABLE/);
const retained = retainedWorldDraft(first)!;
(retained.outcome as any).status = "failed";
assert.deepEqual(first, unchanged, "retained drafts cannot share references with validation mutations");
assert.equal(retainedWorldDraft({ worldState: "长".repeat(MAX_REPAIR_DRAFT_CHARS) }), undefined, "large proposals cannot multiply the repair context");
console.log("PASS world draft corrections: immutable top-level replacement/removal, full-proposal fallback, explicit admission, bounded context and prototype-safe validation");
