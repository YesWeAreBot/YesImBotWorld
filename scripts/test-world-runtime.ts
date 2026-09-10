import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StructuredWorld } from "../src/world/runtime.js";
import { WorldFiles } from "../src/files.js";
import type { WorldClock } from "../src/clock.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";
import type { WorldOperation } from "../src/world/state.js";

function response(operations: WorldOperation[], outcome?: { status: "completed" | "failed"; reason?: string }): ChatResult {
  return { content: "", toolCalls: [{ id: "proposal", type: "function", function: { name: "propose_world", arguments: JSON.stringify({ operations, ...(outcome ? { outcome } : {}) }) } }] };
}
const creation: WorldOperation[] = [
  { op: "create", entity: { id: "room", kind: "place", name: "Room", location: null } },
  { op: "create", entity: { id: "far", kind: "place", name: "Other room", location: null } },
  { op: "create", entity: { id: "bot", kind: "actor", name: "Bot", controller: "bot", location: "room", attributes: { health: { value: 100, visibility: "owner" } } } },
  { op: "create", entity: { id: "npc", kind: "actor", name: "NPC", controller: "world", location: "room" } },
];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function eventually(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert(condition(), "condition did not become true");
}
let passed = 0;
function pass(name: string): void { passed++; console.log(`PASS ${name}`); }

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-runtime-"));
  let now = 100;
  const clock = { now: () => now, realMsUntil: () => 5 } as unknown as WorldClock;
  const files = new WorldFiles(dir); await files.ensure();
  let infer: (messages: ChatMessage[]) => Promise<ChatResult> = async () => response(creation.slice(0, 1));
  let calls = 0;
  const runtime = new StructuredWorld(files, clock, messages => { calls++; return infer(messages); });
  const call = (id: string, args: Record<string, unknown> = {}, expectedAt = now): ToolCallRecord => ({ id, name: "act", role: "world", issuedAt: now, expectedAt, duration: expectedAt - now, arguments: { description: "Perform one action", ...args } });
  try {
    await assert.rejects(() => runtime.ensure(), /Initialization requires/);
    const kernel = await runtime.kernel();
    assert.equal(Object.keys(kernel.snapshot().entities).length, 0);
    infer = async () => response(creation); await runtime.ensure();
    assert.equal(kernel.snapshot().entities.bot!.controller, "bot");
    pass("invalid initialization never partially commits; valid initialization migrates atomically");

    infer = async () => response([]);
    const beforeNoop = kernel.snapshot(); await runtime.evolve("quiet moment");
    assert.deepEqual(kernel.snapshot(), beforeNoop);
    pass("a quiet heartbeat is a valid no-op and creates no invented event");

    infer = async () => response([], { status: "completed", reason: "The requested words were spoken." });
    let delivered = "";
    assert(await runtime.act("bot", call("speech", { speech: "Only my exact words." }), text => { delivered = text; }));
    assert.equal(JSON.parse(delivered).action.status, "completed");
    const speeches = kernel.readEvents(0, 10000).filter(event => event.topic === "world.speech");
    assert.equal((speeches[0]!.payload as { text: string }).text, "Only my exact words.");
    const beforeQuery = kernel.snapshot();
    await runtime.query("npc", "what happened?");
    assert.deepEqual(kernel.snapshot(), beforeQuery);
    assert((await kernel.observe("npc")).utterances.some(u => u.text === "Only my exact words."));
    pass("speech comes from the controller's exact argument; read-only queries cannot consume it");

    infer = async () => response([{ op: "say", actorId: "npc", text: "NPC's own response." }], { status: "completed" });
    assert(await runtime.act("bot", call("npc-response"), () => {}));
    assert(kernel.readEvents(0, 10000).some(event => event.topic === "world.speech" && (event.payload as { text: string }).text === "NPC's own response."));
    pass("the world may speak for NPCs responding to the controlled actor's action");

    infer = async () => response([{ op: "say", actorId: "bot", text: "World-forged speech" }], { status: "completed" });
    await assert.rejects(() => runtime.act("bot", call("forged"), () => {}), /World cannot provide speech/);
    assert.equal(kernel.snapshot().actions["bot:forged"]!.status, "failed");
    assert(!kernel.readEvents(0, 10000).some(event => event.topic === "world.speech" && (event.payload as { text: string }).text === "World-forged speech"));
    infer = async () => response([], { status: "failed", reason: "The door is locked. ADMIN_ONLY_SECRET=123" });
    let failure = "";
    assert.equal(await runtime.act("bot", call("blocked"), text => { failure = text; }), false);
    assert.equal(JSON.parse(failure).action.status, "failed");
    assert.ok(!failure.includes("ADMIN_ONLY_SECRET"), "private adjudicator diagnostics must not bypass observation filtering");
    pass("model-forged controlled speech is rejected and failed actions release actor occupancy");

    infer = async () => response([{ op: "move", id: "bot", location: "far" }], { status: "completed" });
    const callsBeforeWait = calls;
    const moving = runtime.act("bot", call("move", {}, 105), () => {});
    await eventually(() => kernel.snapshot().actions["bot:move"]?.status === "pending");
    assert.equal(kernel.snapshot().entities.bot!.location, "room");
    assert.equal(calls, callsBeforeWait);
    now = 105; assert(await moving);
    assert.equal(kernel.snapshot().entities.bot!.location, "far");
    pass("adjudication and physical transition wait for the due time");

    let release!: (result: ChatResult) => void;
    infer = () => new Promise(resolve => { release = resolve; });
    const duplicateCall = call("duplicate");
    const beforeDuplicate = calls;
    const first = runtime.act("bot", duplicateCall, () => {});
    const second = runtime.act("bot", duplicateCall, () => {});
    await eventually(() => !!release);
    release(response([], { status: "completed", reason: "No physical change was necessary." }));
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(calls, beforeDuplicate + 1);
    assert(await runtime.act("bot", duplicateCall, () => {}));
    assert.equal(calls, beforeDuplicate + 1);
    pass("concurrent and subsequent duplicate requests perform inference and state transition once");

    release = undefined as unknown as typeof release;
    infer = () => new Promise(resolve => { release = resolve; });
    let lateDelivery = false;
    const cancelled = runtime.act("bot", call("cancelled"), () => { lateDelivery = true; });
    const rejected = assert.rejects(cancelled);
    await eventually(() => !!release);
    await Promise.race([runtime.shutdown(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown waited on a stalled model")), 250))]);
    await rejected;
    assert.equal(kernel.snapshot().actions["bot:cancelled"]!.status, "cancelled");
    release(response([{ op: "move", id: "bot", location: "room" }], { status: "completed" }));
    await tick(); await tick();
    assert.equal(kernel.snapshot().entities.bot!.location, "far"); assert.equal(lateDelivery, false);
    runtime.resume();
    pass("shutdown cancels promptly without waiting on a stuck model; late responses have no effects");

    await Promise.all([runtime.arrive("visitor", "Visitor", ""), runtime.arrive("visitor", "Visitor", "")]);
    await Promise.all([runtime.leave("visitor"), runtime.leave("visitor")]);
    assert.equal(kernel.snapshot().entities.visitor!.location, null);
    await runtime.arrive("visitor", "Visitor", "");
    assert.equal(kernel.snapshot().entities.visitor!.location, "far");
    pass("visitor arrival/departure are safe under duplicate calls and allow reentry");

    let retry = 0;
    infer = async messages => {
      retry++;
      if (retry === 1) await kernel.commit({ idempotencyKey: "external-update", operations: [{ op: "update", id: "bot", changes: { attributes: { health: { value: 99, visibility: "owner" } } } }] });
      else {
        const last = JSON.parse(messages[messages.length - 1]!.content as string);
        assert.equal(last.snapshot.entities.bot.attributes.health.value, 99);
      }
      return response([{ op: "update", id: "npc", changes: { attributes: { posture: { value: "standing", visibility: "public" } } } }]);
    };
    await runtime.evolve("NPC stands"); assert.equal(retry, 2);
    pass("version-conflict retries refresh the authoritative snapshot before reinference");

    await kernel.commit({ idempotencyKey: "orphan", operations: [{ op: "action.start", action: { id: "orphan", actorId: "bot", intent: "Interrupted", expectedEnd: 200 } }] });
    const reopened = new StructuredWorld(new WorldFiles(dir), clock, async () => { throw new Error("Recovery must not infer"); });
    const recovered = await reopened.kernel();
    assert.equal(recovered.snapshot().actions.orphan!.status, "failed");
    assert.equal(recovered.snapshot().entities.bot!.location, "far");
    await reopened.shutdown();
    pass("restart fails orphaned pending actions without reenacting their physical effects");
    console.log(`\n${passed} structured-runtime checks passed`);
  } finally { await runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
