/** Recover a legacy backlog and malformed sibling proposals without fabricating evidence or losing cursors. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrowthLedger, independentGrowthChoices, type ReflectionInput } from "../src/bot/growth.js";
import type { BotEvent } from "../src/types.js";

const prepare = (input: unknown) => input as ReflectionInput;
const event = (id: string, at: number, episode?: string): BotEvent => ({ id, worldTime: at, source: "world", content: "朋友来访，一起喝了杯茶。",
  ...(episode ? { experience: { agency: "self", outcome: "completed", opportunity: true, episodeId: episode, situation: "朋友来访" } } : {}) });

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-growth-recovery-"));
  try {
    const ledger = new GrowthLedger(base);
    for (let i = 0; i < 150; i++) await ledger.perceive(event("legacy" + i, i));
    for (let i = 0; i < 4; i++) await ledger.perceive(event("recent" + i, 10_000 + i, "one-visit"));
    const before = await ledger.stats(), append = (ledger as any).append.bind(ledger);
    (ledger as any).append = async () => { throw Error("defer disk failure"); };
    await assert.rejects(ledger.prioritizeRecent({ at: 10_010, since: 1000 }), /defer disk failure/);
    assert.equal((await ledger.reviewStatus()).pending, 154);
    assert.equal((await ledger.reviewStatus()).deferred, 0);
    (ledger as any).append = append;
    await ledger.prioritizeRecent({ at: 10_010, since: 1000 });
    await ledger.prioritizeRecent({ at: 10_010, since: 1000 });
    const prioritized = await ledger.reviewStatus();
    assert.equal(prioritized.pending, 4); assert.equal(prioritized.deferred, 150); assert.equal(prioritized.reviews, 0);
    assert.equal(prioritized.backlogs.length, 1, "repeated prioritization cannot duplicate the deferred range");
    assert.match(prioritized.backlogs[0]!.reason, /尚未逐条审阅/);
    assert.equal(prioritized.backlogs[0]!.firstEventId, "legacy0"); assert.equal(prioritized.backlogs[0]!.lastEventId, "legacy149");
    assert.deepEqual(await ledger.stats(), before, "scheduling neither changes evidence nor manufactures a belief");

    const current = (await ledger.snapshotReview({ at: 10_010, minimumEpisodes: 1 }))!;
    assert.equal(current.backlogId, undefined); assert.equal(current.afterCursor, 150); assert.equal(current.throughCursor, 154);
    assert.ok(current.reviewEventIds!.every(id => id.startsWith("recent")));
    assert.equal(independentGrowthChoices(current.evidence).length, 1, "unknown legacy agency and repeated steps cannot supply missing habit evidence");
    const proposals: ReflectionInput[] = [
      { kind: "habit", subject: "喝茶", situation: "朋友来访", statement: "朋友来时习惯一起喝茶。", evidenceIds: ["recent0", "recent1", "recent2"] },
      { kind: "relationship", subject: "来访的朋友", statement: "这次朋友愿意一起喝茶。", evidenceIds: ["recent0"] },
    ];
    (ledger as any).append = async () => { throw Error("review disk failure"); };
    await assert.rejects(ledger.commitAutomaticReview(current, proposals, 10_010, prepare), /review disk failure/);
    assert.equal((await ledger.stats()).records, 0); assert.equal((await ledger.reviewStatus()).pending, 4);
    assert.equal((await ledger.reviewStatus()).rejected, 0, "a failed transaction cannot advance even the rejection audit");
    (ledger as any).append = append;
    const committed = await ledger.commitAutomaticReview(current, proposals, 10_010, prepare);
    assert.equal(committed.records.length, 1); assert.equal(committed.rejected?.length, 1);
    assert.equal((await ledger.commitAutomaticReview(current, proposals, 10_010, prepare)).duplicate, true);
    assert.equal((await ledger.reviewStatus()).deferred, 150);

    const resumed = new GrowthLedger(base), restored = await resumed.reviewStatus();
    assert.equal(restored.pending, 0); assert.equal(restored.deferred, 150); assert.equal(restored.rejected, 1);
    const backlog = (await resumed.snapshotReview({ at: 10_020, maxEvidence: 8 }))!;
    assert.equal(backlog.backlogId, restored.backlogs[0]!.id);
    assert.equal(backlog.afterCursor, 0); assert.ok(backlog.throughCursor <= 150);
    for (let i = 0; i < 4; i++) await resumed.perceive(event("next" + i, 10_030 + i, "next-visit" + i));
    await resumed.commitReview(backlog, [], 10_040);
    assert.equal((await resumed.reviewStatus()).pending, 4, "background commits cannot consume newer unseen experiences");
    const next = (await resumed.snapshotReview({ at: 10_040 }))!;
    assert.equal(next.backlogId, undefined); assert.ok(next.reviewEventIds!.every(id => id.startsWith("next")));
    await resumed.commitReview(next, [], 10_040);
    const oldAgain = (await new GrowthLedger(base).snapshotReview({ at: 10_040 }))!;
    assert.equal(oldAgain.backlogId, backlog.backlogId); assert.equal(oldAgain.afterCursor, backlog.throughCursor);
    assert.equal((await resumed.recallEvidence({ eventIds: ["legacy0", "recent0"] })).length, 2, "deferred and rejected supporting materials remain accessible");

    // A single long episode may straddle the scheduling cut. Neither snapshot may cross its interval.
    const split = new GrowthLedger(path.join(base, "split"));
    for (let i = 0; i < 130; i++) await split.perceive(event("old" + i, i, "long-episode"));
    for (let i = 0; i < 4; i++) await split.perceive(event("new" + i, 10_000 + i, "long-episode"));
    await split.prioritizeRecent({ at: 10_010, since: 1000 });
    const latest = (await split.snapshotReview({ at: 10_010, minimumEpisodes: 1 }))!;
    assert.equal(latest.afterCursor, 130); assert.equal(latest.throughCursor, 134);
    await split.commitReview(latest, [], 10_010);
    const earlier = (await split.snapshotReview({ at: 10_010, minimumEpisodes: 1 }))!;
    assert.equal(earlier.afterCursor, 0); assert.equal(earlier.throughCursor, 130);
    assert.ok(earlier.reviewEventIds!.every(id => id.startsWith("old")));
    console.log("PASS growth recovery: partial automatic admission, atomic audit, current-first review, explicit unread backlog, independent durable cursors, legacy agency guards and original evidence retention");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
