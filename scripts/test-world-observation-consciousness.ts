/** Actor-scoped consciousness travels with observations without rewriting historical facts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { WorldAgent } from "../src/world/agent.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { NarrativeWorld, observationOf } from "../src/world/runtime.js";
import type { ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const response = (value: unknown): ChatResult => ({ content: JSON.stringify(value), toolCalls: [] });

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-observation-consciousness-"));
  const files = new WorldFiles(path.join(base, "world")); await files.ensure(); await files.writeMeta({ realWorld: false });
  let calls = 0, now = 10;
  let handler: () => ChatResult = () => { throw new Error("Unexpected inference"); };
  const world = new NarrativeWorld(files, { now: () => now, realMsUntil: () => 0 } as any, async () => { calls++; return handler(); });
  try {
    const store = await world.store();
    const seed = await store.commit({ idempotencyKey: "seed", source: "initialize", initialized: true, worldState: "一间安静的卧室。", actors: {
      bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "旧文字声称睡着了，但没有明确意识记录。", perception: "" },
      visitor: { id: "visitor", name: "来客", controller: "player", present: true, state: "独自在隔壁。", perception: "", consciousness: "awake" },
    }, perceptions: [{ actorId: "bot", text: "旧叙述里说你已经睡着了。" }, { actorId: "visitor", text: "隔壁的窗户开着。" }] });
    assert.equal(seed.perceptions[0]!.consciousness, undefined, "sleep words cannot create a consciousness fact");
    assert.equal(seed.perceptions[1]!.consciousness, "awake", "a new perception captures only its own actor's fact");
    assert.equal(observationOf(seed.perceptions[0]!).consciousness, undefined);
    assert.equal(observationOf(seed.perceptions[1]!).consciousness, "awake");
    assert.equal((await world.latestObservation())!.consciousness, undefined);

    handler = () => response({ actorStates: [{ actorId: "bot", state: "躺在床上进入睡眠。", consciousness: "asleep" }],
      perceptions: [{ actorId: "bot", text: "你合上眼，逐渐进入睡眠。" }], outcome: { status: "completed" } });
    const call: ToolCallRecord = { id: "sleep", role: "agent", name: "act", arguments: { description: "合眼入睡" }, issuedAt: now, expectedAt: now };
    let receipt: any;
    await world.act("bot", call, text => { receipt = JSON.parse(text); });
    assert.equal(receipt.observation.consciousness, "asleep", "the action receipt carries the state committed with that exact outcome");
    const sleeping = (await world.latestObservation())!;
    assert.equal(sleeping.consciousness, "asleep");
    assert.equal((await world.latestObservation("visitor"))!.consciousness, "awake");
    const savedSleep = store.readPerceptions("bot").at(-1)!;
    assert.equal((store.readEvents().find(event => event.id === savedSleep.eventId)!.payload as any).consciousness, "asleep");

    now++;
    handler = () => response({ perceptions: [{ actorId: "bot", text: "被子贴在肩边，窗外没有明显动静。" }] });
    const observed = await world.observe("bot", { modality: "self" });
    assert.equal(observed.consciousness, "asleep", "observations inherit an established state without inventing an awakening");
    const beforeWake = store.readPerceptions("bot");
    now++;
    await store.commit({ idempotencyKey: "wake-without-scene", source: "fixture", actors: { bot: {
      ...store.snapshot().actors.bot!, state: "已明确清醒。", consciousness: "awake",
    } } });
    assert.equal(store.snapshot().actors.bot!.consciousness, "awake");
    assert.deepEqual(await world.latestObservation(), observed, "a later state-only update does not relabel an old perception as if it happened awake");
    assert.deepEqual((await world.perceptionsSince("bot")).map(item => item.consciousness), [undefined, "asleep", "asleep"]);
    const callsBeforeReplay = calls;
    await world.act("bot", call, text => { receipt = JSON.parse(text); });
    assert.equal(calls, callsBeforeReplay);
    assert.equal(receipt.observation.consciousness, "asleep");
    assert.equal(receipt.observation.worldSequence, sleeping.worldSequence, "replaying an old action must not stamp its state with the current sequence");
    assert.deepEqual(store.readPerceptions("bot"), beforeWake);

    await store.commit({ idempotencyKey: "no-scene", source: "fixture", actors: { "visitor:no-scene": {
      id: "visitor:no-scene", name: "另一位来客", controller: "player", present: true, state: "昏迷，没有已交付感知。", perception: "", consciousness: "unconscious",
    } } });
    const fallback = await world.peek("visitor:no-scene");
    assert.equal(fallback.consciousness, "unconscious", "a new current-state fallback can carry an explicit current fact");
    assert.equal(fallback.worldSequence, store.snapshot().sequence);
    const oldReceipt = JSON.parse(await (world as any).actionReceipt("bot", "old-without-scene", call));
    assert.equal(oldReceipt.observation.consciousness, undefined, "a historical action without a saved perception cannot borrow today's awake state");

    const journal = await store.exportJournal();
    const replay = await NarrativeStore.open(files.base, { now: () => now });
    assert.deepEqual(replay.readPerceptions("bot"), beforeWake);
    assert.equal(await replay.exportJournal(), journal);
    const records = journal.trim().split("\n").map(line => JSON.parse(line));
    async function writeVariant(name: string, mutate: (rows: any[]) => void) {
      const rows = structuredClone(records); mutate(rows);
      for (const row of rows) { const { checksum: _checksum, ...body } = row; row.checksum = hash(body); }
      const directory = path.join(base, name); await fs.mkdir(directory);
      const raw = rows.map(row => JSON.stringify(row) + "\n").join("");
      await fs.writeFile(path.join(directory, "world-narrative.jsonl"), raw);
      return { directory, raw };
    }
    const legacy = await writeVariant("legacy", rows => {
      for (const row of rows) {
        for (const perception of row.perceptions) delete perception.consciousness;
        for (const event of row.events) if (event.topic === "world.perception") delete event.payload.consciousness;
      }
    });
    const old = await NarrativeStore.open(legacy.directory, { now: () => now });
    assert.ok(old.readPerceptions("bot").every(perception => !Object.hasOwn(perception, "consciousness")), "recovery does not backfill missing historical facts even from a known actor state");
    assert.equal(await old.exportJournal(), legacy.raw);
    const corrupt = await writeVariant("wrong-actor-fact", rows => {
      const row = rows.find(row => row.perceptions.some((p: any) => p.consciousness === "asleep"));
      const perception = row.perceptions.find((p: any) => p.consciousness === "asleep"); perception.consciousness = "awake";
      row.events.find((event: any) => event.id === perception.eventId).payload.consciousness = "awake";
    });
    await assert.rejects(NarrativeStore.open(corrupt.directory), /感知意识状态与同笔角色事实不一致/);
    const wrongEnvelope = await writeVariant("wrong-envelope", rows => {
      const row = rows.find(row => row.perceptions.some((p: any) => p.consciousness === "asleep"));
      row.events.find((event: any) => event.payload?.consciousness === "asleep").payload.consciousness = "awake";
    });
    await assert.rejects(NarrativeStore.open(wrongEnvelope.directory), /感知事件意识状态与记录不一致/);

    const tasks: string[] = [];
    const agent = Object.create(WorldAgent.prototype) as any;
    Object.assign(agent, { maintenanceAbort: new AbortController(), clock: { now: () => 1000 },
      runtime: { evolve: async (task: string) => { tasks.push(task); return { status: "quiet" }; } }, publishAll: async () => {} });
    await agent.tingle(() => {}); await agent.resolveOfflineGap(10, () => {});
    for (const task of tasks) {
      assert.match(task, /已明确asleep.*不属于待结算行动.*真实经过自然结束/);
      assert.match(task, /更新awake/);
      assert.match(task, /昏迷恢复须有既定条件或真实外因/);
      assert.doesNotMatch(task, /不能[^；。]*入睡、醒来/, "per-call instructions must not negate the system's narrow natural-waking authority");
    }
    console.log("PASS World observation consciousness: same-commit actor facts, own-actor isolation, action/observe/replay transport, legacy absence, durable validation and heartbeat/offline wake contracts");
  } finally { await world.shutdown(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
