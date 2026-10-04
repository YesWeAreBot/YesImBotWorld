/** Decoder compatibility must not weaken the saved/native contract or lose shape
 * restrictions when a repair request offers two different response forms. */
import assert from "node:assert/strict";
import { worldGenerationSchema } from "../src/world/generation-schema.js";
import { worldResolutionSchema } from "../src/world/proposal.js";

type Schema = Record<string, any>;
// A small independent JSON Schema evaluator for the vocabulary exercised here.
// The live provider's validator/compiler is additionally checked on CPU at release.
function accepts(schema: Schema, value: any): boolean {
  if (schema.anyOf && !schema.anyOf.some((branch: Schema) => accepts(branch, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((branch: Schema) => accepts(branch, value)).length !== 1) return false;
  if (schema.enum && !schema.enum.some((choice: unknown) => Object.is(choice, value))) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type: string) => type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : type === "array" ? Array.isArray(value) : type === "null" ? value === null : typeof value === type)) return false;
  }
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) return false;
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.items && !value.every(item => accepts(schema.items, item))) return false;
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length < (schema.minProperties ?? 0) || keys.length > (schema.maxProperties ?? Infinity)) return false;
    if (schema.required?.some((key: string) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && keys.some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    if (Object.entries(schema.properties ?? {}).some(([key, definition]) => Object.hasOwn(value, key) && !accepts(definition as Schema, value[key]))) return false;
  }
  return true;
}

for (const kind of ["initialize", "action", "observe", "evolve", "arrive", "leave", "app_observe", "app_action"]) {
  for (const repair of [false, true]) {
    const options = { kind, repair, allowWorldPatch: true, allowPhoneState: false, actorIds: ["bot"] };
    const original: Schema = worldResolutionSchema(false, false, options), snapshot = structuredClone(original);
    const projected: Schema = worldGenerationSchema(original);
    assert.deepEqual(original, snapshot, `${kind} native declaration is immutable`);
    assert.doesNotMatch(JSON.stringify(projected), /"(?:not|uniqueItems)":/, `${kind} has no unsupported decoder keywords`);
    const full: Schema = { perceptions: [] };
    if (kind === "initialize") Object.assign(full, { worldState: "小镇醒来了。", actorStates: [], botName: "小澈" });
    if (kind === "action" || kind === "app_action") full.outcome = { status: "completed" };
    if (kind === "app_action") full.worldState = "纸上写有今天的作业。";
    assert.equal(accepts(projected, full), true, `${kind} complete response remains accepted`);
    for (const invalid of [{}, { garbage: 17 }, { ...full, garbage: 17 }, { ...full, perceptions: 17 },
      { ...full, perceptions: [{ actorId: "unknown", text: "消息" }] }]) {
      assert.equal(accepts(projected, invalid), false, `${kind} rejects malformed response ${JSON.stringify(invalid)}`);
    }
    if (repair) {
      assert.equal(projected.properties, undefined, "union must not rely on sibling properties ignored by the decoder");
      assert.equal(projected.oneOf, undefined);
      assert.equal(projected.anyOf.length, 2);
      for (const branch of projected.anyOf) {
        assert.equal(branch.type, "object"); assert.equal(branch.additionalProperties, false);
        assert.ok(branch.properties); assert.ok(branch.required.length > 0);
      }
      assert.equal(accepts(projected, { repair: { remove: ["unknownDraftField"] } }), true);
      assert.equal(accepts(projected, { repair: { set: { perceptions: [] } } }), true);
      for (const invalid of [{ repair: {} }, { repair: { set: {} } }, { repair: { remove: [] } },
        { repair: { set: { garbage: 17 } } }, { ...full, repair: { remove: ["unknownDraftField"] } }]) {
        assert.equal(accepts(projected, invalid), false, `${kind} rejects invalid/mixed repair ${JSON.stringify(invalid)}`);
      }
      const properties = projected.anyOf[0].properties;
      properties.perceptions.maxItems = 0;
    } else projected.properties.perceptions.maxItems = 0;
    assert.deepEqual(original, snapshot, "mutating the projected copy cannot affect its source");
  }
}

const keywordFields: Schema = {
  type: "object", additionalProperties: false, not: { required: ["not", "uniqueItems"] },
  required: ["not", "uniqueItems"], properties: {
    not: { type: "array", uniqueItems: true, items: { type: "string", not: { enum: ["forbidden"] } } },
    uniqueItems: { type: "object", properties: { not: { type: "boolean" } }, examples: [{ not: true, uniqueItems: true }] },
  },
};
const projected: Schema = worldGenerationSchema(keywordFields);
assert.equal(projected.not, undefined); assert.ok(projected.properties.not); assert.ok(projected.properties.uniqueItems);
assert.equal(projected.properties.not.uniqueItems, undefined); assert.equal(projected.properties.not.items.not, undefined);
assert.deepEqual(projected.properties.uniqueItems.examples, [{ not: true, uniqueItems: true }], "literal example data is preserved");
assert.deepEqual(projected.required, ["not", "uniqueItems"]);
assert.equal(keywordFields.properties.not.uniqueItems, true);
console.log("PASS World generation schemas: all tasks, complete repair branches, retained shape/identity constraints, native contract isolation and keyword-named fields");
