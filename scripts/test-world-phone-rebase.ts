import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { applyPhonePhysicalState, setPhoneDown, withPhoneExecutionLock } from "../src/phone-state.js";
import type { ChatMessage, ChatResult, ChatToolDef } from "../src/llm/chat.js";
import type { PhoneStatus, ToolCallRecord } from "../src/types.js";

const native = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const stale = () => native({ worldState: "你来到厨房，手机留在卧室桌上。", phoneState: { reachable: false, location: "卧室桌上", usable: true, perceptible: false },
  perceptions: [{ actorId: "bot", text: "你走进厨房，手机仍在卧室桌上。" }], outcome: { status: "completed" } });
const fresh = () => native({ worldState: "你来到厨房，手机在手里。", phoneState: { reachable: true, location: "手里", usable: true, perceptible: true },
  perceptions: [{ actorId: "bot", text: "你带着手机走进厨房。" }], outcome: { status: "completed" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Handler = (messages: ChatMessage[], tools: ChatToolDef[]) => Promise<ChatResult>;

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-phone-rebase-")), files = new WorldFiles(base);
  await files.ensure(); await files.writeMeta({ realWorld: false });
  let handler: Handler = async () => fresh();
  const phone: PhoneStatus = { down: true }, requests: ChatMessage[][] = [];
  const runtime = new NarrativeWorld(files, { now: () => 100, realMsUntil: () => 1 } as any, (messages, tools) => {
    requests.push(structuredClone(messages)); return handler(messages, tools);
  });
  runtime.phoneStatusProvider = () => phone;
  const store = await runtime.store();
  await store.commit({ idempotencyKey: "seed", source: "administrator", initialized: true, worldState: "你在卧室，手机放在桌上。", actors: {
    bot: { id: "bot", name: "小澈", present: true, controller: "bot", state: "站在卧室。", perception: "卧室很安静。" },
  }, phoneState: { reachable: true, location: "卧室桌上", usable: true, perceptible: true } });
  applyPhonePhysicalState(phone, store.snapshot().phoneState);
  const unsubscribe = store.subscribe(event => {
    if (event.topic === "world.committed" && (event.payload as any).phoneStateChanged) applyPhonePhysicalState(phone, store.snapshot().phoneState);
  });
  const call: ToolCallRecord = { id: "kitchen", name: "act", role: "agent", arguments: { description: "走进厨房" }, issuedAt: 100, expectedAt: 100 };
  return { phone, runtime, store, requests, call, handle: (next: Handler) => { handler = next; }, close: async () => { await runtime.shutdown(); unsubscribe(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function updatesDuringInference(aba: boolean) {
  const f = await fixture();
  try {
    if (aba) setPhoneDown(f.phone, false);
    let attempt = 0;
    f.handle(async (messages, tools) => {
      if (++attempt === 1) {
        await withPhoneExecutionLock(f.phone, () => { if (aba) setPhoneDown(f.phone, true); setPhoneDown(f.phone, false); });
        return stale();
      }
      assert.equal(attempt, 2);
      assert.deepEqual(messages.slice(0, 2), f.requests[0]!.slice(0, 2), "original prefix and task are immutable");
      const update = JSON.parse(String(messages.at(-1)!.content));
      assert.equal(update.executionUpdate.phoneHeld, true);
      assert.equal(update.committed, false); assert.equal(update.draft, undefined);
      assert.equal((tools[0]!.function.parameters as any).properties.repair, undefined, "a stale execution proposal cannot survive as repair draft");
      assert.equal(f.store.snapshot().phoneState!.reachable, true);
      return fresh();
    });
    const receipts: string[] = [];
    await f.runtime.act("bot", f.call, text => receipts.push(text));
    assert.equal(f.requests.length, 2); assert.equal(receipts.length, 1);
    assert.equal(f.phone.down, false); assert.equal(f.store.snapshot().phoneState!.location, "手里");
    assert.doesNotMatch(receipts[0]!, /留在卧室/);
    const records = (await f.store.exportJournal()).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(!records.some(record => record.commit.worldState === "你来到厨房，手机留在卧室桌上。"));
  } finally { await f.close(); }
}

async function changesBetweenValidationAndCommit() {
  const f = await fixture(), release = deferred<void>(), locked = deferred<void>();
  let changer: Promise<void> | undefined;
  try {
    f.handle(async () => {
      if (f.requests.length > 1) return fresh();
      changer = withPhoneExecutionLock(f.phone, async () => { locked.resolve(); await release.promise; setPhoneDown(f.phone, false); });
      await locked.promise;
      setImmediate(() => release.resolve());
      return stale();
    });
    await f.runtime.act("bot", f.call, () => {}); await changer;
    assert.equal(f.requests.length, 2, "snapshot checked again after waiting for the local commit lock");
    assert.equal(f.phone.down, false); assert.equal(f.store.snapshot().phoneState!.reachable, true);
  } finally { release.resolve(); await changer; await f.close(); }
}

async function changesDuringPublication() {
  const f = await fixture();
  let change: Promise<void> | undefined, published = false;
  try {
    setPhoneDown(f.phone, false);
    const commit = f.store.commit.bind(f.store);
    f.store.commit = async (input, options) => {
      if (input.actionPhase === "finish") {
        change = withPhoneExecutionLock(f.phone, () => { assert.equal(published, true); setPhoneDown(f.phone, true); });
        // The attempted real device mutation cannot interleave with journal publication.
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(f.phone.down, false);
        const result = await commit(input, options); published = true; return result;
      }
      return commit(input, options);
    };
    await f.runtime.act("bot", f.call, () => {}); await change;
    assert.equal(f.requests.length, 1); assert.equal(f.phone.down, true, "the later real putdown is preserved");
  } finally { await change; await f.close(); }
}

async function boundedRebases() {
  const f = await fixture();
  try {
    const initial = f.store.snapshot();
    f.handle(async () => { await withPhoneExecutionLock(f.phone, () => setPhoneDown(f.phone, !f.phone.down)); return stale(); });
    await assert.rejects(f.runtime.act("bot", f.call, () => {}), /WORLD_EXECUTION_CHANGED/);
    assert.equal(f.requests.length, 3, "execution refreshes share the existing retry budget");
    assert.equal(f.store.snapshot().worldState, initial.worldState);
    assert.equal(f.store.snapshot().phoneState!.reachable, true);
  } finally { await f.close(); }
}

async function main() {
  await updatesDuringInference(false); await updatesDuringInference(true); await changesBetweenValidationAndCommit(); await changesDuringPublication(); await boundedRebases();
  console.log("PASS concurrent phone posture: immutable-prefix refresh, ABA, bounded retries, last-moment validation, atomic publication and no stale facts delivered");
}
const watchdog = setTimeout(() => { console.error("World regression did not settle"); process.exit(1); }, 30_000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
