/** Program recovery persists first, bypasses inference latency and fences stale World drafts. */
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { WorldAgent } from "../src/world/agent.js";
import { applyPhonePhysicalState, setPhoneDown, withPhoneExecutionLock } from "../src/phone-state.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { PhonePhysicalState, PhoneStatus, ToolCallRecord } from "../src/types.js";

const unavailable: PhonePhysicalState = { reachable: false, location: "身侧衣服的褶皱里", usable: false, perceptible: false };
const available: PhonePhysicalState = { reachable: true, location: "持有者手中", usable: true, perceptible: true };
const result = (proposal: unknown): ChatResult => ({ content: JSON.stringify(proposal), toolCalls: [] });
const action = (id: string): ToolCallRecord => ({ id, role: "agent", name: "act", arguments: { description: "挪开挡在身前的椅子" }, issuedAt: 10, expectedAt: 10, status: "running" });
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-phone-restore-"));
  const files = new WorldFiles(base); await files.ensure(); await files.writeMeta({ realWorld: false });
  let now = 10;
  let handler: (messages: ChatMessage[]) => Promise<ChatResult> = async () => { throw new Error("unexpected inference"); };
  const inputs: any[] = [];
  const runtime = new NarrativeWorld(files, { now: () => now, realMsUntil: () => 0, syncRealTime: false } as any, async messages => {
    inputs.push(JSON.parse(String(messages[1]!.content))); return handler(messages);
  });
  const store = await runtime.store();
  await store.commit({ idempotencyKey: "seed", source: "initialize", initialized: true,
    worldState: "酷霸坐在沙发里，手机被卡在身侧衣服的褶皱里。椅子挡在身前。",
    actors: { bot: { id: "bot", name: "酷霸", present: true, controller: "bot", state: "坐在沙发里。", perception: "身侧的衣服绷得很紧。" } }, phoneState: unavailable });
  const phone: PhoneStatus = { down: true, physical: { ...unavailable } };
  runtime.phoneStatusProvider = () => phone;
  const unsubscribe = store.subscribe(event => {
    if (event.topic === "world.committed" && (event.payload as any).phoneStateChanged) {
      const committed = JSON.parse(readFileSync(files.narrativeJournal, "utf8").trim().split("\n").at(-1)!);
      assert.deepEqual(committed.commit.phoneState, store.snapshot().phoneState, "runtime publication follows durable append");
      applyPhonePhysicalState(phone, store.snapshot().phoneState);
    }
  });
  const restore = async (key: string) => withPhoneExecutionLock(phone, async () => {
    const state = await runtime.restorePhoneAccess(key); applyPhonePhysicalState(phone, state); setPhoneDown(phone, false); return state;
  });
  return { runtime, store, files, phone, inputs, restore,
    tick: () => ++now, handle: (fn: typeof handler) => { handler = fn; },
    close: async () => { unsubscribe(); await runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function main() {
  const f = await fixture();
  try {
    const old = f.store.snapshot(), journal = await f.store.exportJournal();
    assert.deepEqual(await f.restore("pickup:one"), available);
    const after = f.store.snapshot();
    assert.equal(f.inputs.length, 0, "recovery performs no model call");
    assert.deepEqual(after.phoneAccessRestoration, { sequence: after.sequence, worldTime: 10 });
    assert.equal(after.worldState, old.worldState); assert.deepEqual(after.actors, old.actors);
    assert.equal(f.store.readPerceptions("bot").length, 0, "do not invent a search/repair scene or steal the latest actor perception");
    assert.ok((await f.store.exportJournal()).startsWith(journal), "old journal bytes remain unchanged");
    assert.equal(f.phone.down, false); assert.deepEqual(f.phone.physical, available);
    await f.restore("pickup:one"); assert.equal(f.store.snapshot().sequence, after.sequence, "retry is idempotent");
    const reopened = await NarrativeStore.open(f.files.base, { now: () => 10 });
    assert.deepEqual(reopened.snapshot().phoneAccessRestoration, after.phoneAccessRestoration);
    assert.deepEqual(reopened.snapshot().phoneState, available);
    await f.store.commit({ idempotencyKey: "later-accident", source: "administrator", phoneState: unavailable });
    await assert.rejects(f.restore("pickup:one"), /后续变化/);
    assert.deepEqual(f.phone.physical, unavailable, "duplicate old success cannot silently re-heal after a newer accident");
    await f.restore("pickup:two");
    const beforeDenied = await f.store.exportJournal();
    await assert.rejects(f.runtime.restorePhoneAccess("denied", { beforeCommit: () => false }), /取消/);
    assert.equal(await f.store.exportJournal(), beforeDenied);
    const aborted = new AbortController(); aborted.abort();
    assert.throws(() => f.runtime.restorePhoneAccess("aborted", { signal: aborted.signal }));
    assert.throws(() => f.store.commit({ idempotencyKey: "wrong-owner", source: "phone_restore", actorId: "visitor:x", phoneState: available }), /手机/);
    assert.throws(() => f.store.commit({ idempotencyKey: "fake-plot", source: "phone_restore", actorId: "bot", phoneState: available, worldState: "凭空修好手机。" }), /不能附带/);

    // Device ownership stays local while travelling; no remote world event or NPC is invented.
    const owner: any = Object.create(WorldAgent.prototype);
    Object.assign(owner, { runtime: f.runtime, routeEpoch: "travelling", remote: { worldName: "远方" }, maintenanceAbort: new AbortController() });
    f.runtime.phoneAuthorityProvider = () => false;
    await owner.restorePhoneAccess("away");
    assert.equal(f.store.snapshot().worldState, old.worldState);
    await assert.rejects(owner.restorePhoneAccess("control-lost", { beforeCommit: () => false }), /取消/);
    f.runtime.stop();
    assert.throws(() => f.runtime.restorePhoneAccess("stopped"));
  } finally { await f.close(); }

  const concurrent = await fixture();
  try {
    const started = deferred(), release = deferred();
    let calls = 0;
    concurrent.runtime.unrestrictedPhoneProvider = () => true;
    concurrent.handle(async messages => {
      if (++calls === 1) {
        started.resolve(); await release.promise;
        return result({ worldState: "过期草稿：手机更加卡死。", phoneState: unavailable, outcome: { status: "failed" }, perceptions: [{ actorId: "bot", text: "旧草稿的障碍。" }] });
      }
      const request = JSON.parse(String(messages[1]!.content));
      assert.ok(request.phoneAccessPolicy && request.phoneAccessRestoration && request.actionPredatesPhoneRestoration);
      assert.equal(request.phoneHeld, true); assert.deepEqual(request.phoneState, available);
      return result({ worldState: "椅子已经挪到墙边，身前空出一片地方。", outcome: { status: "completed" }, perceptions: [{ actorId: "bot", text: "椅子挪到了墙边，身前空了出来。" }] });
    });
    const pending = concurrent.runtime.act("bot", action("concurrent"), () => {});
    await started.promise; concurrent.tick();
    await concurrent.restore("pickup:while-generating");
    assert.equal(calls, 1, "pickup completes while the first World inference is still suspended");
    release.resolve(); assert.equal(await pending, true);
    assert.equal(calls, 2, "stale generation is rebased exactly once");
    assert.deepEqual(concurrent.store.snapshot().phoneState, available);
    assert.doesNotMatch(await concurrent.store.exportJournal(), /过期草稿|旧草稿的障碍/);
    assert.equal(concurrent.store.snapshot().actions["bot:concurrent"]!.status, "completed");
  } finally { await concurrent.close(); }

  const late = await fixture();
  try {
    let injected = false, calls = 0;
    const original = late.store.commit.bind(late.store);
    late.store.commit = async (input, options) => {
      if (!injected && input.source === "action" && input.actionPhase === "finish") {
        injected = true; late.tick();
        // Inject precisely after validation, before the stale expectedSequence enters storage.
        const state = await late.runtime.restorePhoneAccess("pickup:save-race");
        applyPhonePhysicalState(late.phone, state); setPhoneDown(late.phone, false);
      }
      return original(input, options);
    };
    late.handle(async () => {
      calls++;
      return result({ worldState: "椅子靠墙，身前不再被挡住。", outcome: { status: "completed" }, perceptions: [{ actorId: "bot", text: "椅子已经挪开。" }] });
    });
    assert.equal(await late.runtime.act("bot", action("late-cas"), () => {}), true);
    assert.equal(calls, 2, "CAS rejection triggers fresh inference instead of permanent action failure");
    assert.deepEqual(late.store.snapshot().phoneState, available);
    assert.equal(late.store.readPerceptions("bot").length, 1, "only the fresh action result is delivered");
  } finally { await late.close(); }

  const lockRace = await fixture();
  try {
    const generating = deferred(), releaseModel = deferred(), ownLock = deferred(), restoreNow = deferred(), validated = deferred();
    let calls = 0, phoneReads = 0;
    lockRace.runtime.phoneStatusProvider = () => { if (++phoneReads === 2) validated.resolve(); return lockRace.phone; };
    lockRace.handle(async () => {
      if (++calls === 1) { generating.resolve(); await releaseModel.promise; }
      return result({ worldState: "椅子已经挪开，地面露了出来。", outcome: { status: "completed" }, perceptions: [{ actorId: "bot", text: "椅子滑到墙边，空出了脚边。" }] });
    });
    const pending = lockRace.runtime.act("bot", action("waiting-on-lock"), () => {});
    await generating.promise;
    const pickup = withPhoneExecutionLock(lockRace.phone, async () => {
      ownLock.resolve(); await restoreNow.promise;
      const state = await lockRace.runtime.restorePhoneAccess("pickup:held-lock");
      applyPhonePhysicalState(lockRace.phone, state); setPhoneDown(lockRace.phone, false);
    });
    await ownLock.promise; releaseModel.resolve(); await validated.promise;
    await new Promise<void>(done => setImmediate(done));
    lockRace.tick(); restoreNow.resolve(); await pickup;
    assert.equal(await pending, true);
    assert.equal(calls, 2, "restoration while awaiting the execution lock must rebase the full snapshot directly, without a third stale-snapshot inference");
    assert.deepEqual(lockRace.store.snapshot().phoneState, available);
  } finally { await lockRace.close(); }
  console.log("PASS durable phone restoration: no inference, immutable history, retry/reload, cancellation, travelling ownership, stale generation and final-save CAS rebase");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
