/** Offline provider-contract checks. Runtime authority and document application are tested separately. */
import assert from "node:assert/strict";
import { worldPatchSchema } from "../src/world/document.js";
import { WORLD_INCREMENTAL_AUTHORITY, worldResolutionSchema, worldResolutionTool, type WorldResolutionOptions } from "../src/world/proposal.js";

type Schema = Record<string, any>;
// Evaluate the JSON Schema vocabulary used by this tool against realistic proposals.
// This verifies admission by the advertised contract, independently of runtime validation.
function accepts(schema: Schema, value: any): boolean {
  if (schema.not && accepts(schema.not, value)) return false;
  if (schema.oneOf && schema.oneOf.filter((item: Schema) => accepts(item, value)).length !== 1) return false;
  if (schema.enum && !schema.enum.some((item: unknown) => Object.is(item, value))) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = (type: string) => type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : type === "array" ? Array.isArray(value) : type === "null" ? value === null : type === "integer" ? Number.isInteger(value) : typeof value === type;
    if (!types.some(matches)) return false;
  }
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value <= (schema.exclusiveMinimum ?? -Infinity))) return false;
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
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
const schema = (opts: WorldResolutionOptions): Schema => worldResolutionSchema(false, false, opts);
const perception = { actorId: "bot", text: "店员把热面端到桌边。" };
const complete = { perceptions: [perception], outcome: { status: "completed" } };
const patch = { revision: "9:fixture", edits: [{ op: "replace", id: "p2", text: "面已经端上桌，店员继续照看灶台。" }] };
const full = "面已经端上桌，店员继续照看灶台。柜子里仍藏有角色不知道的备用钥匙。";
const valid = (contract: Schema, proposal: unknown, label: string) => assert.equal(accepts(contract, proposal), true, label);
const invalid = (contract: Schema, proposal: unknown, label: string) => assert.equal(accepts(contract, proposal), false, label);

function taskContracts() {
  const legacy = worldResolutionTool().function.parameters as Schema;
  assert.deepEqual(legacy.required, ["perceptions"]);
  assert.ok(legacy.properties.outcome.properties.status.enum.includes("ongoing"));
  assert.ok(legacy.properties.outcome.properties.speechSpoken, "omitted options preserve legacy declaration inspection");
  assert.equal(legacy.properties.worldPatch, undefined); assert.equal(legacy.properties.repair, undefined);

  const initialized = schema({ kind: "initialize", allowWorldPatch: true, allowOngoing: true, allowPhoneState: false });
  valid(initialized, { perceptions: [perception], worldState: full, actorStates: [{ actorId: "bot", state: "坐在餐桌边。" }], botName: "小澈" }, "genesis keeps complete memory and actor state");
  assert.equal(initialized.properties.worldPatch, undefined); assert.equal(initialized.properties.outcome, undefined); assert.equal(initialized.properties.phoneState, undefined);
  invalid(initialized, { perceptions: [perception], worldState: full, botName: "小澈" }, "genesis still requires actorStates");

  const ordinary = schema({ kind: "action", allowWorldPatch: true, allowPhoneState: false });
  assert.match(ordinary.properties.worldState.description, /^仅当需要整体重写.*通常优先worldPatch，无变化两者都省略/);
  valid(ordinary, complete, "unchanged memory is omitted");
  valid(ordinary, { ...complete, worldState: full }, "complete prose remains a fallback");
  valid(ordinary, { ...complete, worldPatch: patch }, "an actual paragraph update accompanies the same action receipt");
  valid(ordinary, { ...complete, worldPatch: { revision: "9:fixture", edits: [] } }, "an empty patch explicitly keeps memory");
  invalid(ordinary, { perceptions: [perception] }, "action outcome is required in the provider contract");
  invalid(ordinary, { ...complete, outcome: { status: "ongoing" } }, "ongoing is absent unless expressly allowed");
  invalid(ordinary, { ...complete, outcome: { status: "completed", speechSpoken: false } }, "silent action cannot fabricate a speech field");
  invalid(ordinary, { ...complete, worldPatch: patch, worldState: full }, "full state and patch are mutually exclusive");
  invalid(ordinary, { ...complete, phoneState: { reachable: true, location: null, usable: true, perceptible: true } }, "no phone authority means no phone field");
  invalid(ordinary, { ...complete, worldPatch: { revision: "9:fixture", edits: [{ op: "replace", id: "p2" }] } }, "replacement must contain its complete paragraph");
  invalid(ordinary, { ...complete, worldPatch: { revision: "9:fixture", edits: [{ op: "append", id: "p2", text: full }] } }, "append cannot overwrite an addressed paragraph");
  invalid(schema({ kind: "action", allowWorldPatch: false }), { ...complete, worldPatch: patch }, "unsafe or legacy projections cannot accept a patch");

  const start = schema({ kind: "action", allowOngoing: true, speech: "start" });
  valid(start, { ...complete, outcome: { status: "ongoing", speechSpoken: true } }, "start can commit spoken words and an ongoing process");
  valid(start, { ...complete, outcome: { status: "failed", speechSpoken: false } }, "a speech attempt can fail before speaking");
  invalid(start, complete, "a speech request needs an explicit speechSpoken boolean");
  const finish = schema({ kind: "action", allowOngoing: true, speech: "finish" });
  valid(finish, complete, "finish omits the program-owned speechSpoken=false field");
  assert.equal(finish.properties.outcome.properties.speechSpoken, undefined);
  invalid(finish, { ...complete, outcome: { status: "completed", speechSpoken: true } }, "finish cannot speak the same words again");
  invalid(finish, { ...complete, outcome: { status: "ongoing", speechSpoken: false } }, "a speech finish cannot restart an ongoing process");

  for (const kind of ["observe", "arrive", "leave"]) {
    const contract = schema({ kind, allowWorldPatch: true });
    valid(contract, { perceptions: [perception], worldPatch: patch }, `${kind} may update natural-language memory`);
    invalid(contract, complete, `${kind} has no action outcome`);
  }
  const evolution = schema({ kind: "evolve", allowWorldPatch: true, allowPhoneState: false });
  valid(evolution, { perceptions: [] }, "a quiet heartbeat needs no invented change");
  valid(evolution, { perceptions: [{ ...perception, changeIds: ["serve"] }], worldPatch: patch,
    externalChanges: [{ id: "serve", description: "店员把煮好的面送到桌边。" }] }, "evolution keeps source links with a memory patch");
  invalid(evolution, { perceptions: [perception] }, "visible evolution requires source ids");
  for (const field of ["outcome", "actorStates", "phoneState", "phoneChangeIds"]) assert.equal(evolution.properties[field], undefined, `${field} is outside this evolution contract`);
}

function appContracts() {
  for (const kind of ["app_observe", "app_action"] as const) {
    const contract = schema({ kind, allowWorldPatch: true, allowOngoing: true, speech: "start" });
    const proposal = kind === "app_observe" ? { perceptions: [perception] } : { ...complete, worldState: "文件 note.txt 原文：完成作业。" };
    valid(contract, proposal, `${kind} retains its existing private receipt protocol`);
    for (const field of ["actorStates", "phoneState", "worldPatch"]) assert.equal(contract.properties[field], undefined, `${kind} cannot write ${field}`);
    for (const extra of [{ situation: "坐在桌边。" }, { opportunities: [] }]) invalid(contract, { ...proposal, perceptions: [{ ...perception, ...extra }] }, `${kind} cannot deliver a physical state bar or action menu`);
    if (kind === "app_observe") {
      invalid(contract, { ...proposal, worldState: full }, "application reads cannot modify state");
      invalid(contract, { ...proposal, outcome: { status: "completed" } }, "application reads cannot claim an action outcome");
    } else {
      invalid(contract, complete, "application mutation must still persist the complete world/file text");
      invalid(contract, { perceptions: [perception], worldState: full }, "application mutation requires outcome");
      invalid(contract, { ...proposal, outcome: { status: "ongoing" } }, "application mutation cannot use staged physical progress");
      invalid(contract, { ...proposal, outcome: { status: "completed", speechSpoken: true } }, "application mutation cannot speak for the body");
    }
  }
}

function repairsAndIsolation() {
  const contract = schema({ kind: "action", allowWorldPatch: true, allowPhoneState: false, repair: true });
  valid(contract, complete, "repair request still accepts a complete replacement proposal");
  valid(contract, { repair: { set: { outcome: { status: "completed" } } } }, "only the faulty top-level field needs replacement");
  valid(contract, { repair: { set: { perceptions: [perception] }, remove: ["unknownDraftField"] } }, "repair can replace an array and delete an undeclared draft field");
  valid(contract, { repair: { remove: ["outcome"] } }, "removal is a draft operation; resulting completeness is checked by the runtime");
  valid(contract, { repair: { set: { worldPatch: patch }, remove: ["worldState"] } }, "a repair may switch from complete state to a patch");
  for (const proposal of [
    { repair: {} }, { repair: { set: {} } }, { repair: { remove: [] } }, { repair: { set: {}, remove: ["wrong"] } },
    { ...complete, repair: { set: { worldState: full } } },
    { repair: { set: { outcome: { speechSpoken: false } } } },
    { repair: { set: { perceptions: [{ actorId: "bot" }] } } },
    { repair: { set: { worldPatch: patch, worldState: full } } },
    { repair: { set: { phoneState: {} } } }, { repair: { set: { unknownDraftField: "new" } } },
    { repair: { set: { repair: {} } } },
    ...["__proto__", "constructor", "prototype", "repair"].map(key => ({ repair: { remove: [key] } })),
    { repair: { remove: ["wrong", "wrong"] } }, { repair: { remove: ["x".repeat(81)] } },
    { repair: { remove: Array.from({ length: 33 }, (_, index) => `wrong_${index}`) } },
  ]) invalid(contract, proposal, `malformed or unauthorized repair rejected: ${JSON.stringify(proposal)}`);
  invalid(schema({ kind: "action" }), { repair: { set: { outcome: { status: "completed" } } } }, "initial proposals cannot refer to an absent draft");
  const set = contract.properties.repair.properties.set;
  assert.equal(set.minProperties, 1); assert.equal(set.maxProperties, 32);
  assert.deepEqual(set.properties, schema({ kind: "action", allowWorldPatch: true, allowPhoneState: false }).properties, "repair advertises exactly this task's complete writable fields");
  contract.properties.worldPatch.properties.edits.maxItems = 0;
  contract.properties.repair.properties.set.properties.outcome.properties.status.enum.push("forged");
  assert.ok(worldPatchSchema.properties.edits.maxItems > 0, "a request cannot mutate the shared patch schema");
  assert.ok(!schema({ kind: "action" }).properties.outcome.properties.status.enum.includes("forged"));
  assert.ok(!contract.properties.outcome.properties.status.enum.includes("forged"), "repair field definitions are independent snapshots");
  assert.match(WORLD_INCREMENTAL_AUTHORITY, /worldDocument/); assert.match(WORLD_INCREMENTAL_AUTHORITY, /worldPatch/);
  assert.match(WORLD_INCREMENTAL_AUTHORITY, /回退完整worldState/); assert.match(WORLD_INCREMENTAL_AUTHORITY, /同笔/); assert.match(WORLD_INCREMENTAL_AUTHORITY, /NPC/);
}

taskContracts(); appContracts(); repairsAndIsolation();
console.log("PASS World proposal schemas: task permissions, speech phases, optional ongoing, prose patch/full exclusivity, private app contracts, whole-field draft repair and request isolation");
