/** Native wire schemas and reversible adaptation; no provider or saved-world access. */
import assert from "node:assert/strict";
import { prepareNativeSchema } from "../src/llm/native-schema.js";
import { worldGenerationSchema } from "../src/world/generation-schema.js";
import { worldResolutionSchema } from "../src/world/proposal.js";
import { growthProposalSchema, parseGrowthChange, parseGrowthChanges } from "../src/bot/growth-proposal.js";
import { applyWorldPatch, createWorldDocument } from "../src/world/document.js";
import { ChatCompletionError } from "../src/llm/errors.js";

type Schema = Record<string, any>;
const record = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);
const simple: Schema = { type: "object", additionalProperties: false, required: ["name", "location"], properties: {
  name: { type: "string", minLength: 1, maxLength: 10 }, location: { type: ["string", "null"] },
  note: { type: "string" }, maybe: { type: ["string", "null"] }, count: { type: "integer", minimum: 0 },
  nested: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, optional: { type: "boolean" } } },
} };
const options = (schema: Schema) => ({ responseFormat: "json_schema" as const, responseSchema: { name: "fixture", schema } });
const code = (error: unknown) => error instanceof ChatCompletionError && error.code === "LLM_RESPONSE_INVALID";
const containsType = (schema: Schema, type: string) => Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;

// Independent, small grammar checker: validates the request vocabulary and wire
// required/union constraints rather than assuming our own restorer proves them.
function checkWire(schema: Schema, api: "anthropic" | "responses") {
  let optional = 0, unions = 0;
  const visit = (node: Schema) => {
    for (const key of Object.keys(node)) assert.ok(["type", "title", "description", "enum", "properties", "required", "additionalProperties", "items", "anyOf", ...(api === "anthropic" ? ["minItems"] : [])].includes(key), `unsupported wire key ${key}`);
    if (node.anyOf) { unions++; node.anyOf.forEach(visit); }
    if (Array.isArray(node.type)) unions++;
    if (node.minItems !== undefined) assert.ok([0, 1].includes(node.minItems));
    if (containsType(node, "object")) {
      assert.equal(node.additionalProperties, false);
      optional += Object.keys(node.properties).filter(key => !node.required.includes(key)).length;
      if (api === "responses") assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties)));
      Object.values(node.properties).forEach(value => visit(value as Schema));
    }
    if (node.items) visit(node.items);
  };
  visit(schema);
  if (api === "responses") { assert.equal(schema.type, "object"); assert.equal(schema.anyOf, undefined); }
  else { assert.ok(optional <= 24, String(optional)); assert.ok(unions <= 16, String(unions)); }
  return { optional, unions };
}
function accepts(schema: Schema, value: unknown): boolean {
  if (schema.anyOf) return schema.anyOf.some((branch: Schema) => accepts(branch, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type: string) => type === "null" ? value === null : type === "object" ? record(value)
    : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isInteger(value) : typeof value === type)) return false;
  if (record(value)) {
    if (schema.required.some((key: string) => !Object.hasOwn(value, key))) return false;
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(value).every(([key, item]) => accepts(schema.properties[key], item));
  }
  if (Array.isArray(value)) return value.length >= (schema.minItems ?? 0) && value.every(item => accepts(schema.items, item));
  return true;
}
// Fixture authoring helper: materialize only required nullable transport omissions.
function wireFixture(schema: Schema, original: unknown): unknown {
  if (schema.anyOf) {
    for (const branch of schema.anyOf) {
      try { const candidate = wireFixture(branch, original); if (accepts(branch, candidate)) return candidate; } catch { /* next complete branch */ }
    }
    throw new Error("fixture has no matching branch");
  }
  if (record(original) && containsType(schema, "object")) {
    if (Object.keys(original).some(key => !Object.hasOwn(schema.properties, key))) throw new Error("wrong fixture branch");
    return Object.fromEntries(Object.keys(schema.properties).flatMap(key => Object.hasOwn(original, key)
      ? [[key, wireFixture(schema.properties[key], original[key])]] : schema.required.includes(key) ? [[key, null]] : []));
  }
  if (Array.isArray(original) && containsType(schema, "array")) return original.map(item => wireFixture(schema.items, item));
  return original;
}

for (const api of ["responses", "anthropic"] as const) {
  const snapshot = JSON.stringify(simple), prepared = prepareNativeSchema(api, options(simple)), wire = prepared.options.responseSchema!.schema as Schema;
  assert.equal(JSON.stringify(simple), snapshot); checkWire(wire, api);
  assert.match(prepared.protocolInstruction!, /仍须遵守/); assert.match(wire.properties.name.description, /maxLength/);
  assert.equal(wire.properties.name.maxLength, undefined);
  if (api === "responses") {
    assert.deepEqual(wire.properties.note.anyOf, [{ type: "string" }, { type: "null" }]);
    assert.equal(wire.properties.maybe.anyOf, undefined, "original nullable data is not an omission marker");
    const input = { name: "甲", location: null, note: null, maybe: null, count: 0, nested: { id: "x", optional: null } };
    const restored = JSON.parse(prepared.restoreContent(JSON.stringify(input)));
    assert.deepEqual(restored, { name: "甲", location: null, maybe: null, count: 0, nested: { id: "x" } });
    assert.equal(input.note, null, "restoration never changes captured wire values");
    const validFalse = { ...input, note: "", nested: { id: "x", optional: false } };
    assert.equal(JSON.parse(prepared.restoreContent(JSON.stringify(validFalse))).nested.optional, false);
    for (const bad of [{ name: "甲" }, { ...input, unknown: null }, { ...input, name: null }, { ...input, count: "0" }]) assert.throws(() => prepared.restoreContent(JSON.stringify(bad)), code);
    assert.throws(() => prepared.restoreContent('{"name":'), code);
  } else {
    assert.deepEqual(wire.required, ["name", "location"]);
    const exact = '{ "name":"甲", "location":null, "maybe":null }';
    assert.equal(prepared.restoreContent(exact), exact, "unchanged representation retains exact native text");
  }
}

for (const api of ["responses", "anthropic"] as const) {
  for (const kind of ["initialize", "action", "observe", "evolve", "arrive", "leave", "app_observe", "app_action"]) {
    for (const repair of [false, true]) {
      const original = worldGenerationSchema(worldResolutionSchema(false, false, { kind, repair, allowWorldPatch: true, actorIds: ["bot"] }));
      const before = JSON.stringify(original), prepared = prepareNativeSchema(api, options(original));
      const wire = prepared.options.responseSchema!.schema as Schema;
      const counts = checkWire(wire, api); assert.equal(JSON.stringify(original), before);
      if (kind === "evolve" && repair && api === "anthropic") {
        assert.deepEqual(counts, { optional: 24, unions: 6 }, "convert exactly one excess optional; no business-union collapse");
      }
      const full: Schema = { perceptions: [] };
      if (kind === "initialize") Object.assign(full, { worldState: "清晨的小镇。", actorStates: [], botName: "小澈" });
      if (kind === "action" || kind === "app_action") full.outcome = { status: "completed" };
      if (kind === "app_action") full.worldState = "备忘录写有新的作业。";
      const examples = [full];
      if (repair) examples.push({ repair: { set: { perceptions: [] } } }, { repair: { remove: ["unknownDraftField"] } });
      if (kind === "action") examples.push({ perceptions: [{ actorId: "bot", text: "你走到门边。", opportunities: [] }], outcome: { status: "completed" },
        phoneState: { reachable: false, location: null, usable: true, perceptible: false },
        worldPatch: { revision: "1:x", edits: [{ op: "replace", id: "p1", text: "门开着。" }, { op: "delete", id: "p2" }, { op: "append", text: "外面有脚步声。" }] } });
      for (const example of examples) {
        const wrapped = api === "responses" && repair;
        const wireValue = wrapped ? { result: wireFixture(wire.properties.result, example) } : wireFixture(wire, example);
        assert.equal(accepts(wire, wireValue), true, `${api}/${kind}/${repair} wire fixture`);
        assert.deepEqual(JSON.parse(prepared.restoreContent(JSON.stringify(wireValue))), example, `${api}/${kind}/${repair} restored exact meaning`);
      }
    }
  }
}

const vocabulary = { evidenceIds: new Set(["event1"]), editableClaims: new Set(["claim1"]), subjectReferences: new Map([["s1", "member1"]]) };
const proposal = { kind: "relationship", subject: "同学", statement: "遇到技术问题可以询问这位同学。", evidenceIds: ["event1"], subjectId: "s1",
  insight: { dimension: "学习互助", significance: "以后遇到调试困难时可以先询问对方是否方便提供建议。", anchors: [{ eventId: "event1", quote: "我可以一起看日志" }] } };
for (const api of ["responses", "anthropic"] as const) {
  const schema = growthProposalSchema(vocabulary), before = JSON.stringify(schema);
  const prepared = prepareNativeSchema(api, { ...options(schema), responseSchemaInPrompt: false });
  const wire = prepared.options.responseSchema!.schema as Schema; checkWire(wire, api);
  assert.equal(prepared.options.responseSchemaInPrompt, false); assert.ok(prepared.protocolInstruction, "preexisting Growth instructions still receive wire adaptation rules");
  const value = wireFixture(wire, { changes: [proposal] }); assert.equal(accepts(wire, value), true);
  const content = prepared.restoreContent(JSON.stringify(value));
  const changes = parseGrowthChanges({ content, toolCalls: [] });
  assert.deepEqual(changes, [proposal]); assert.equal(parseGrowthChange(changes[0], vocabulary.subjectReferences).subjectId, "member1");
  assert.equal(JSON.stringify(schema), before);
  const invalidBound = wireFixture(wire, { changes: [{ ...proposal, statement: "x".repeat(1201) }] });
  const bad = parseGrowthChanges({ content: prepared.restoreContent(JSON.stringify(invalidBound)), toolCalls: [] });
  assert.throws(() => parseGrowthChange(bad[0], vocabulary.subjectReferences), /1200/, "grammar projection cannot weaken local bounds");
}

// Retained local World constraints still reject invalid edit addresses and values.
const document = createWorldDocument("屋里亮着灯。", 1);
assert.throws(() => applyWorldPatch(document, { revision: document.revision, edits: [{ op: "replace", id: "p999", text: "门开着。" }] }), /不是本轮原文/);
assert.throws(() => applyWorldPatch(document, { revision: document.revision, edits: [{ op: "replace", id: "p1", text: "" }] }), /非空/);

const union: Schema = { anyOf: [
  { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" }, b: { type: "string" } } },
  { type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: { type: "string" }, b: { type: ["string", "null"] } } },
] };
const preparedUnion = prepareNativeSchema("responses", options(union));
assert.throws(() => preparedUnion.restoreContent('{"result":{"a":"x","b":null}}'), /多个分支/, "never guess whether an ambiguous null means missing or actual null");
assert.throws(() => preparedUnion.restoreContent('{"a":"x","b":null}'), code);
assert.throws(() => preparedUnion.restoreContent('{"result":{},"extra":1}'), code);
const reference: Schema = { type: "object", properties: { x: { $ref: "#/$defs/value" } }, required: ["x"], additionalProperties: false, $defs: { value: { type: "string", minLength: 1 } } };
assert.equal((prepareNativeSchema("responses", options(reference)).options.responseSchema!.schema as Schema).properties.x.type, "string");
for (const unsupported of [
  { type: "object", properties: {} },
  { type: "object", properties: {}, additionalProperties: { type: "string" } },
  { $ref: "https://example.invalid/schema" },
  { type: "array", prefixItems: [{ type: "string" }] },
  { type: "string", allOf: [{ type: "string" }] },
  { type: "object", properties: { x: { $ref: "#/" } }, additionalProperties: false },
]) assert.throws(() => prepareNativeSchema("responses", options(unsupported)), /无法安全投影/);
const tooManyUnions = { type: "object", additionalProperties: false, properties: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), { type: ["string", "null"] }])) };
assert.throws(() => prepareNativeSchema("anthropic", options(tooManyUnions)), /复杂度/);
const keywordNames: Schema = { type: "object", required: ["minimum", "not", "__proto__"], additionalProperties: false,
  properties: JSON.parse('{"minimum":{"type":"number"},"not":{"type":"boolean"},"__proto__":{"type":"string"},"optional":{"type":"string"}}') };
const safe = prepareNativeSchema("responses", options(keywordNames));
assert.deepEqual(JSON.parse(safe.restoreContent('{"minimum":0,"not":false,"__proto__":"literal","optional":null}')), JSON.parse('{"minimum":0,"not":false,"__proto__":"literal"}'));
assert.equal(({} as any).literal, undefined);
const untouched = options(simple);
assert.equal(prepareNativeSchema("chat-completions", untouched).options, untouched);
assert.equal(prepareNativeSchema("responses", { ...untouched, responseFormat: "text" }).restoreContent("raw"), "raw");
console.log("PASS native schema projection: real World/Growth contracts, strict optionals, minimal Anthropic budget conversion, exact null/repair restoration and unchanged local validation");
