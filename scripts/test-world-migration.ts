import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { StructuredWorld } from "../src/world/runtime.js";
import type { WorldClock } from "../src/clock.js";
import type { ChatMessage, ChatResult, ChatToolDef } from "../src/llm/chat.js";
import type { WorldOperation } from "../src/world/state.js";

type Infer = (messages: ChatMessage[], tools: ChatToolDef[]) => Promise<ChatResult>;
const clock = { now: () => 123, realMsUntil: () => 0 } as unknown as WorldClock;
let passed = 0;
function pass(name: string): void { passed++; console.log(`PASS ${name}`); }
function rawProposal(argumentsText: string): ChatResult {
  return { content: "", toolCalls: [{ id: "migration-proposal", type: "function", function: { name: "propose_world", arguments: argumentsText } }] };
}
function proposal(operations: unknown): ChatResult { return rawProposal(JSON.stringify({ operations })); }

// Every parent/owner reference is forward, including an item owned by a not-yet-created actor.
const complete: WorldOperation[] = [
  { op: "create", entity: { id: "chat", kind: "object", name: "聊天图标", location: "phone", owner: "bot" } },
  { op: "create", entity: { id: "phone", kind: "object", name: "手机", location: "bot", owner: "bot", attributes: { powered: { value: true, visibility: "owner" } } } },
  { op: "create", entity: { id: "bot", kind: "actor", name: "小澈", controller: "bot", location: "room", attributes: { hunger: { value: 1, visibility: "owner" } } } },
  { op: "create", entity: { id: "room", kind: "place", name: "宿舍", location: "campus" } },
  { op: "create", entity: { id: "campus", kind: "place", name: "校园", location: "city" } },
  { op: "create", entity: { id: "city", kind: "place", name: "城市", location: null } },
];
const invalid: WorldOperation[] = [
  { op: "create", entity: { id: "room", kind: "place", name: "宿舍", location: "campus" } },
  { op: "create", entity: { id: "chat", kind: "object", name: "聊天图标", location: "internet" } },
  { op: "create", entity: { id: "bot", kind: "actor", name: "小澈", controller: "bot", location: "room", owner: "bot" } },
];

async function fixture(infer: Infer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-migration-"));
  const files = new WorldFiles(dir); await files.ensure();
  const originals = new Map([
    [files.botDef, "AUTHOR_BOT_DEFINITION：小澈，正在读大学。"],
    [files.worldDef, "AUTHOR_WORLD_DEFINITION：宿舍属于校园，校园位于城市中。"],
    [files.botStatus, "LEGACY_BOT：小澈在宿舍，桌上有手机。旧摘要不是人格的新定义。"],
    [files.worldStatus, "LEGACY_WORLD：小澈的宿舍位于校园。聊天应用连接互联网。"],
    [files.news, '{"t":99,"text":"保留旧世界新闻"}\n'],
    [files.facts, '{"t":100,"text":"保留旧记忆"}\n'],
    [files.stream, '{"kind":"event","event":{"id":"ev_1","source":"world","content":"保留原始经历","worldTime":100}}\n'],
    [files.pinned, '{"pinned":{"persona":"保留旧置顶原文"},"counters":{"event":1,"tool":0}}'],
  ]);
  await Promise.all([...originals].map(([file, text]) => fs.writeFile(file, text)));
  let calls = 0;
  const runtime = new StructuredWorld(files, clock, (messages, tools) => { calls++; return infer(messages, tools); });
  return { files, runtime, originals, calls: () => calls, async close() { await runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); } };
}
function lastSnapshot(messages: ChatMessage[]): Record<string, unknown> {
  const input = [...messages].reverse().find(message => message.role === "user");
  assert.ok(input && typeof input.content === "string");
  return JSON.parse(input.content).snapshot.entities;
}
function repairFeedback(messages: ChatMessage[]): string {
  return messages.filter(message => message.role === "tool").map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
}
async function assertOriginalsAndBackup(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  for (const [file, original] of f.originals) assert.equal(await fs.readFile(file, "utf8"), original, `${path.basename(file)} must survive migration unchanged`);
  const archives = await fs.readdir(f.files.archiveDir);
  assert.equal(archives.length, 1, "one backup precedes the entire repair loop");
  const archived = path.join(f.files.archiveDir, archives[0]!);
  for (const [file, original] of f.originals) {
    if (file === f.files.botDef || file === f.files.worldDef) continue;
    assert.equal(await fs.readFile(path.join(archived, path.basename(file)), "utf8"), original, `backup lost ${path.basename(file)}`);
  }
}
async function assertAtomicSuccess(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const kernel = await f.runtime.kernel();
  assert.deepEqual(Object.keys(kernel.snapshot().entities).sort(), ["bot", "campus", "chat", "city", "phone", "room"]);
  assert.equal(kernel.snapshot().entities.bot!.owner, undefined);
  assert.equal(kernel.snapshot().entities.phone!.owner, "bot");
  assert.equal(kernel.snapshot().entities.city!.location, null);
  assert.equal(kernel.readEvents(0, 1000).filter(event => event.topic === "world.committed").length, 1);
  const rows = (await fs.readFile(f.files.worldJournal, "utf8")).trim().split("\n");
  assert.equal(rows.length, 1, "all creates must commit in one transaction, with no failed-prefix writes");
  await assertOriginalsAndBackup(f);
}

type Schema = Record<string, any>;
function resolveSchema(schema: Schema, root: Schema): Schema {
  if (!schema.$ref) return schema;
  assert.ok(schema.$ref.startsWith("#/"), "tool schema references must be self-contained");
  const resolved = schema.$ref.slice(2).split("/").reduce((node: Schema, part: string) => node[part.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  assert.ok(resolved && typeof resolved === "object");
  return resolveSchema(resolved, root);
}
function alternatives(schema: Schema, root: Schema): Schema[] {
  const resolved = resolveSchema(schema, root);
  return resolved.oneOf || resolved.anyOf ? (resolved.oneOf ?? resolved.anyOf).flatMap((branch: Schema) => alternatives(branch, root)) : [resolved];
}
function schemaContract(tools: ChatToolDef[]): void {
  assert.equal(tools.length, 1); assert.equal(tools[0]!.function.name, "propose_world");
  const root = tools[0]!.function.parameters as Schema;
  assert.equal(root.type, "object"); assert.ok(root.required.includes("operations"));
  const operations = resolveSchema(root.properties.operations, root);
  assert.equal(operations.type, "array"); assert.ok(operations.items);
  const branches = alternatives(operations.items, root); assert.ok(branches.length > 0);
  for (const branch of branches) {
    assert.equal(branch.type, "object"); assert.ok(branch.properties?.op, "operations need executable op properties, not a format description");
    assert.ok(branch.required?.includes("op"));
    const op = resolveSchema(branch.properties.op, root);
    assert.deepEqual(op.enum ?? [op.const], ["create"], "initialization must expose only create operations");
    const entities = alternatives(branch.properties.entity, root), kinds: string[] = [];
    for (const entity of entities) {
      assert.equal(entity.type, "object");
      for (const key of ["id", "kind", "name", "location", "attributes"]) assert.ok(entity.properties?.[key], `entity.${key} needs an actual schema`);
      for (const key of ["id", "kind", "name", "location"]) assert.ok(entity.required?.includes(key), `entity.${key} must be required`);
      const admittedKinds = resolveSchema(entity.properties.kind, root).enum; kinds.push(...admittedKinds);
      assert.ok(resolveSchema(entity.properties.location, root).type.includes("null"), "a root place must admit a literal null location");
      if (admittedKinds.includes("object")) assert.ok(entity.properties.owner, "object ownership needs an actual schema");
      else { assert.equal(entity.properties.owner, undefined); assert.equal(entity.additionalProperties, false, "actor/place ownership must be excluded by schema"); }
      if (admittedKinds.includes("actor")) assert.ok(entity.properties.controller, "actor controller needs an actual schema");
      const attributes = resolveSchema(entity.properties.attributes, root);
      assert.equal(attributes.type, "object");
      const attribute = resolveSchema(attributes.additionalProperties, root);
      assert.ok(attribute.properties?.value && attribute.properties?.visibility, "attribute value and visibility need executable property schemas");
      assert.deepEqual([...resolveSchema(attribute.properties.visibility, root).enum].sort(), ["hidden", "owner", "public"]);
    }
    assert.deepEqual([...new Set(kinds)].sort(), ["actor", "object", "place"]);
  }
}

async function forwardReferencesAndSchema(): Promise<void> {
  const f = await fixture(async (messages, tools) => {
    schemaContract(tools); assert.deepEqual(lastSnapshot(messages), {});
    const input = JSON.stringify(messages);
    for (const marker of ["AUTHOR_BOT_DEFINITION", "AUTHOR_WORLD_DEFINITION", "LEGACY_BOT", "LEGACY_WORLD"]) assert.ok(input.includes(marker), `migration input lost ${marker}`);
    return proposal(complete);
  });
  try {
    await f.runtime.ensure(); assert.equal(f.calls(), 1); await assertAtomicSuccess(f);
    await f.runtime.ensure(); assert.equal(f.calls(), 1, "an initialized world must not be migrated again");
    pass("complete forward-reference migration succeeds once, with executable create-only tool schema");
  } finally { await f.close(); }
}
async function aggregateRepair(): Promise<void> {
  let turn = 0;
  const f = await fixture(async messages => {
    assert.deepEqual(lastSnapshot(messages), {}, "failed proposals must not change the next repair snapshot");
    if (++turn === 1) return proposal(invalid);
    const feedback = repairFeedback(messages);
    for (const detail of ["room", "campus", "chat", "internet", "bot", "owner"]) assert.ok(feedback.includes(detail), `one feedback turn must include ${detail}: ${feedback}`);
    const latestFeedback = [...messages].reverse().find(message => message.role === "tool")!;
    assert.equal(typeof latestFeedback.content, "string");
    const validation = JSON.parse(latestFeedback.content as string).validation;
    assert.ok(Array.isArray(validation.details), "repair must carry the aggregated diagnostics, not just mention field names in generic advice");
    for (const [entityId, field, targetId] of [["room", "location", "campus"], ["chat", "location", "internet"], ["bot", "owner", "bot"]]) {
      assert.ok(validation.details.some((detail: any) => detail.entityId === entityId && detail.field === field && detail.targetId === targetId), `missing structured diagnostic ${entityId}.${field} -> ${targetId}`);
    }
    assert.doesNotMatch(feedback, /TypeError|Cannot read propert/);
    return proposal(complete);
  });
  try { await f.runtime.ensure(); assert.equal(f.calls(), 2); await assertAtomicSuccess(f); pass("one repair sees every dangling location and invalid actor owner, then commits atomically"); }
  finally { await f.close(); }
}
async function permanentFailure(): Promise<void> {
  const f = await fixture(async messages => { assert.deepEqual(lastSnapshot(messages), {}); return proposal(invalid); });
  try {
    await assert.rejects(f.runtime.ensure(), error => { assert.ok(error instanceof Error); assert.ok(!(error instanceof TypeError)); return true; });
    assert.equal(f.calls(), 3, "permanently invalid migrations must stop after bounded repair attempts");
    const kernel = await f.runtime.kernel(); assert.deepEqual(kernel.snapshot().entities, {}); assert.deepEqual(kernel.snapshot().actions, {}); assert.equal(kernel.snapshot().sequence, 0); assert.deepEqual(kernel.readEvents(), []);
    assert.equal((await f.files.readText(f.files.worldJournal)).trim(), "", "failed migration must not leave committed journal entries");
    await assertOriginalsAndBackup(f);
    pass("exhausted repairs leave no journal or partial world and preserve every legacy file plus backup");
  } finally { await f.close(); }
}
async function malformedOutputRepair(): Promise<void> {
  let turn = 0;
  const f = await fixture(async messages => {
    assert.deepEqual(lastSnapshot(messages), {});
    turn++;
    if (turn === 1) return rawProposal('{"operations": [');
    const feedback = repairFeedback(messages); assert.ok(feedback.length > 0); assert.doesNotMatch(feedback, /TypeError|Cannot read propert/);
    if (turn === 2) { assert.match(feedback, /JSON|json|解析|格式/); return proposal(JSON.stringify(complete)); }
    assert.match(feedback, /operations/); assert.match(feedback, /array|数组/);
    return proposal(complete);
  });
  try { await f.runtime.ensure(); assert.equal(f.calls(), 3); await assertAtomicSuccess(f); pass("malformed JSON and stringified operations receive repair feedback and can recover"); }
  finally { await f.close(); }
}
async function nullOperationRepair(): Promise<void> {
  let turn = 0;
  const f = await fixture(async messages => {
    if (++turn === 1) return proposal([null, ...complete]);
    const feedback = repairFeedback(messages); assert.ok(feedback.length > 0); assert.doesNotMatch(feedback, /TypeError|Cannot read propert/); assert.match(feedback, /operation|操作/i);
    return proposal(complete);
  });
  try { await f.runtime.ensure(); assert.equal(f.calls(), 2); await assertAtomicSuccess(f); pass("null operations are validation failures with actionable feedback, never incidental TypeErrors"); }
  finally { await f.close(); }
}
async function initializationRejectsMutation(): Promise<void> {
  let turn = 0;
  const f = await fixture(async messages => {
    if (++turn === 1) return proposal([...complete, { op: "move", id: "bot", location: "room" }]);
    assert.deepEqual(lastSnapshot(messages), {});
    assert.match(repairFeedback(messages), /create|创建|初始化/i);
    return proposal(complete);
  });
  try { await f.runtime.ensure(); assert.equal(f.calls(), 2); await assertAtomicSuccess(f); pass("initialization rejects non-create operations before any partial create can commit"); }
  finally { await f.close(); }
}
async function missingToolRepair(): Promise<void> {
  let turn = 0;
  const uncommittedNarrative = "世界已创建完成，小澈现在正在宿舍里。";
  const f = await fixture(async messages => {
    assert.deepEqual(lastSnapshot(messages), {}, "a narrative without a tool call cannot initialize the world");
    if (++turn === 1) return { content: uncommittedNarrative, toolCalls: [] };
    const assistantIndex = messages.findIndex(message => message.role === "assistant");
    assert.ok(assistantIndex >= 0);
    assert.equal(messages[assistantIndex]!.content, uncommittedNarrative);
    assert.equal(messages[assistantIndex]!.tool_calls, undefined);
    const feedback = messages[assistantIndex + 1]!;
    assert.equal(feedback.role, "user", "a missing tool call needs ordinary repair feedback, not an unmatched tool response");
    assert.equal(typeof feedback.content, "string");
    const body = JSON.parse(feedback.content as string);
    assert.equal(body.committed, false); assert.match(body.validation.message, /exactly one propose_world/);
    assert.equal(messages.filter(message => message.role === "tool").length, 0);
    return proposal(complete);
  });
  try { await f.runtime.ensure(); assert.equal(f.calls(), 2); await assertAtomicSuccess(f); pass("missing tool calls receive ordinary repair feedback and recover without treating narrative as committed state"); }
  finally { await f.close(); }
}
async function multipleToolsRepair(): Promise<void> {
  let turn = 0;
  const originalCalls = ["migration-first", "migration-second"].map(id => ({ ...proposal(complete).toolCalls[0]!, id }));
  const f = await fixture(async messages => {
    assert.deepEqual(lastSnapshot(messages), {}, "multiple rejected tool calls must not commit either proposal");
    if (++turn === 1) return { content: "", toolCalls: originalCalls };
    const assistantIndex = messages.findIndex(message => message.role === "assistant");
    assert.ok(assistantIndex >= 0);
    assert.deepEqual(messages[assistantIndex]!.tool_calls, originalCalls);
    const replies = messages.slice(assistantIndex + 1, -1);
    assert.equal(replies.length, originalCalls.length, "each rejected call needs exactly one protocol response before retrying");
    assert.ok(replies.every(message => message.role === "tool"));
    assert.deepEqual(replies.map(message => message.tool_call_id).sort(), originalCalls.map(call => call.id).sort());
    for (const reply of replies) {
      assert.equal(typeof reply.content, "string");
      const feedback = JSON.parse(reply.content as string);
      assert.equal(feedback.committed, false); assert.match(feedback.validation.message, /exactly one propose_world/);
    }
    return proposal(complete);
  });
  try { await f.runtime.ensure(); assert.equal(f.calls(), 2); await assertAtomicSuccess(f); pass("multiple tool calls each receive a matching tool response before one complete repair commits"); }
  finally { await f.close(); }
}
async function main(): Promise<void> {
  await forwardReferencesAndSchema(); await aggregateRepair(); await permanentFailure(); await malformedOutputRepair(); await nullOperationRepair(); await initializationRejectsMutation(); await missingToolRepair(); await multipleToolsRepair();
  console.log(`\n${passed} isolated structured-migration checks passed; no real model or live world used`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
