/** Recent external changes survive unchanged state prose and recovery without inventing legacy causes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NarrativeStore } from "../src/world/narrative-store.js";
import type { NarrativeCommit } from "../src/world/narrative-types.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const worldState = "院子里有一棵树，树旁有张长椅。";
const event = (id: string, description = `风吹动树叶，第${id}次。`): NarrativeCommit => ({
  idempotencyKey: id, source: "evolve", worldState,
  evolution: { changes: [{ id, description }], actorEffects: [], perceptionSources: [] },
});

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "recent-world-evolution-"));
  let now = 10;
  try {
    let store = await NarrativeStore.open(base, { now: () => now });
    assert.deepEqual(store.readRecentEvolution(), []);
    assert.equal(store.lastEvolutionAt(), undefined);
    assert.equal(await store.exportJournal(), "", "reading an empty world cannot create an event");
    assert.throws(() => store.commit({ idempotencyKey: "quiet", source: "evolve", worldState,
      evolution: { changes: [], actorEffects: [], perceptionSources: [] } }), /INVALID_EVOLUTION|外部演化/);
    assert.equal(await store.exportJournal(), "", "empty evolution proposals do not enter the event window or journal");
    assert.equal(store.lastEvolutionAt(), undefined, "quiet proposals cannot reset the evolution clock");
    await store.commit({ idempotencyKey: "seed", source: "initialize", initialized: true, worldState,
      actors: { bot: { id: "bot", name: "来客", controller: "bot", present: true, state: "坐在长椅上。", perception: "院子很安静。" } } });
    assert.equal(store.lastEvolutionAt(), undefined, "initialization is not an evolution event");

    // Produce an authentic journal record, then remove only metadata unavailable in old archives.
    now = 11; await store.commit(event("legacy"));
    const oldRecords = (await store.exportJournal()).trim().split("\n").map(line => JSON.parse(line));
    delete oldRecords[1].commit.evolution;
    oldRecords[1].fingerprint = hash(oldRecords[1].commit);
    const { checksum: _checksum, ...body } = oldRecords[1]; oldRecords[1].checksum = hash(body);
    const oldJournal = oldRecords.map(record => JSON.stringify(record) + "\n").join("");
    await fs.writeFile(store.journalPath, oldJournal);
    store = await NarrativeStore.open(base, { now: () => now });
    assert.deepEqual(store.readRecentEvolution(), [], "old evolve records without causes stay historical prose, not invented event metadata");
    assert.equal(store.lastEvolutionAt(), 11, "the committed time of legacy evolution remains known without guessed causes");
    assert.equal(await store.exportJournal(), oldJournal);

    const expected: { sequence: number; worldTime: number; changes: { id: string; description: string }[] }[] = [];
    for (let index = 1; index <= 4; index++) {
      now = 20 + Math.floor(index / 2); // Two events share a time; their durable sequence still fixes order.
      const input = event(`event-${index}`), result = await store.commit(input);
      expected.push({ sequence: result.sequence, worldTime: now, changes: input.evolution!.changes });
      await store.commit({ idempotencyKey: `ordinary-${index}`, source: "observation", perceptions: [] });
    }
    assert.equal(store.snapshot().worldState, worldState, "transient real events do not require rewriting stable world prose");
    assert.deepEqual(store.readRecentEvolution(), expected.slice(-3));
    assert.deepEqual(store.readRecentEvolution(1), expected.slice(-1));
    assert.deepEqual(store.readRecentEvolution(99), expected);
    assert.deepEqual(store.readRecentEvolution(2.9), expected.slice(-2));
    assert.deepEqual(store.readRecentEvolution(0), []); assert.deepEqual(store.readRecentEvolution(-1), []);
    assert.deepEqual(store.readRecentEvolution(Number.NaN), expected.slice(-3));

    const journal = await store.exportJournal(), returned = store.readRecentEvolution(99);
    returned[0]!.changes[0]!.description = "caller mutation"; returned[0]!.changes.push({ id: "fake", description: "not real" });
    returned[1]!.worldTime = 999; returned.pop();
    assert.deepEqual(store.readRecentEvolution(99), expected, "row, array and nested change mutations cannot alter committed records");
    assert.equal(await store.exportJournal(), journal);
    const reopened = await NarrativeStore.open(base, { now: () => 999 });
    assert.deepEqual(reopened.readRecentEvolution(99), expected, "recovery uses each event's committed time, not the current clock");
    assert.equal(reopened.lastEvolutionAt(), expected.at(-1)!.worldTime);
    assert.equal(await reopened.exportJournal(), journal, "reading and recovery preserve original journal bytes");

    const twoBudget = JSON.stringify(expected.slice(-2)).length;
    assert.deepEqual(reopened.readRecentEvolution(99, twoBudget), expected.slice(-2), "the budget includes array brackets and row separators");
    assert.deepEqual(reopened.readRecentEvolution(99, twoBudget - 1), expected.slice(-1));
    const latestBudget = JSON.stringify(expected.slice(-1)).length;
    assert.deepEqual(reopened.readRecentEvolution(99, latestBudget - 1), [], "an oversized latest event is never truncated or skipped");
    assert.deepEqual(reopened.readRecentEvolution(99, 0), []);

    now = 30; await store.commit(event("large", 'Quoted "event"\n' + "雨".repeat(6500)));
    const full = store.readRecentEvolution(99, 20_000), newest = full.at(-1)!;
    assert.deepEqual(store.readRecentEvolution(), [], "the default 6000-character window cannot silently skip a large newest event");
    assert.equal(store.lastEvolutionAt(), 30, "the evolution timestamp is independent of the event text budget");
    now = 31; await store.commit(event("after-large", "脚步声从院门外经过。"));
    assert.deepEqual(store.readRecentEvolution(99), [{ sequence: store.snapshot().sequence, worldTime: now, changes: event("after-large", "脚步声从院门外经过。").evolution!.changes }],
      "budget selection is contiguous among external events; older small events beyond a large gap stay out");
    assert.equal(newest.changes[0]!.description, 'Quoted "event"\n' + "雨".repeat(6500), "larger explicit budgets return complete descriptions");
    now = 100; await store.commit({ idempotencyKey: "later-read", source: "observation", perceptions: [] });
    assert.equal(store.lastEvolutionAt(), 31, "a newer non-evolution commit cannot become the evolution timestamp");
    const finalRecovery = await NarrativeStore.open(base, { now: () => 200 });
    assert.equal(finalRecovery.lastEvolutionAt(), 31, "recovery preserves the evolution timestamp behind newer ordinary commits");
    console.log("PASS recent external events: empty/quiet, legacy omission, same-state commits, recovery, ordering, limits, immutable projections and complete-record JSON budgets");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
