/** Isolated behavioral-memory checks: no real model, platform, or world service. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrowthLedger, growthViewText, type ReflectionInput } from "../src/bot/growth.js";
import type { BotEvent, ExperienceMetadata, StreamEntry } from "../src/types.js";

const choice = (episodeId: string, situation = "晚饭结束后在家门口", extra: Partial<ExperienceMetadata> = {}): ExperienceMetadata => ({
  episodeId, agency: "self", outcome: "completed", opportunity: true, situation, action: "沿河散步", ...extra,
});
const event = (id: string, at: number, experience?: ExperienceMetadata, content = "晚饭后主动去河边散步，回来觉得轻松。"): BotEvent => ({
  id, worldTime: at, source: "world", content, ...(experience ? { experience } : {}),
});
const habit = (evidenceIds: string[]): ReflectionInput => ({ kind: "habit", subject: "饭后散步", situation: "晚饭结束后",
  cues: ["晚饭", "河边", "饭后"], statement: "最近晚饭后常去河边散步；天气不好或有人相约时，也会选择别的安排。", evidenceIds });

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-evolution-"));
  try {
    const ledger = new GrowthLedger(path.join(base, "behavior"));
    await ledger.perceive(event("forced1", 1, choice("forced1", undefined, { agency: "imposed" })));
    await ledger.perceive(event("forced2", 2, choice("forced2", undefined, { agency: "imposed" })));
    await ledger.perceive(event("forced3", 3, choice("forced3", undefined, { agency: "imposed" })));
    await assert.rejects(ledger.reflect(habit(["forced1", "forced2", "forced3"]), 3), /自主完成/);
    for (let i = 1; i <= 3; i++) await ledger.perceive(event(`same${i}`, 3 + i, choice("one-dinner")), [`step${i}`]);
    await assert.rejects(ledger.reflect(habit(["same1", "same2", "same3"]), 6), /自主完成/);
    for (let i = 1; i <= 3; i++) await ledger.perceive(event(`copy${i}`, 6 + i, choice(`copy-episode${i}`)), ["one-original"]);
    await assert.rejects(ledger.reflect(habit(["copy1", "copy2", "copy3"]), 9), /自主完成/, "re-reading must not create independent choices even with differing episode labels");
    for (let i = 1; i <= 3; i++) await ledger.perceive(event(`unknown${i}`, 9 + i, choice(`unknown${i}`, undefined, { opportunity: undefined })));
    await assert.rejects(ledger.reflect(habit(["unknown1", "unknown2", "unknown3"]), 12), /自主完成/);
    await ledger.perceive(event("failed", 13, choice("failed", undefined, { outcome: "failed" })));
    await ledger.perceive(event("walk1", 14, choice("dinner1")));
    await ledger.perceive(event("walk2", 15, choice("dinner2")));
    await assert.rejects(ledger.reflect(habit(["walk1", "walk2", "failed"]), 15), /自主完成/);
    await ledger.perceive(event("walk3", 16, choice("dinner3")));
    const formed = await ledger.reflect(habit(["walk1", "walk2", "walk3"]), 16);
    assert.equal(formed.view.active, true);
    assert.equal(formed.view.records[0]?.origin, "manual");
    assert.equal(formed.view.status, "tentative", "evidence thresholds are admission guards, never automatic personality promotion");
    assert.equal((await ledger.retrieve({ text: "吃完晚饭，外面的河边很安静。", at: 10_000 }))[0]?.claimId, formed.view.claimId,
      "a habit does not expire merely because no opportunity occurred for a while");
    assert.deepEqual(await ledger.retrieve({ text: "电脑硬盘空间不足，需要清理缓存。", at: 20 }), []);

    await ledger.perceive(event("rain", 17, choice("rainy-dinner"), "饭后下大雨，决定留在家里陪朋友聊天。"));
    const counter = await ledger.reflect({ ...habit(["rain"]), claimId: formed.view.claimId, relation: "counter",
      statement: "下雨且朋友来访时，并不会坚持出门散步。" }, 17);
    assert.equal(counter.view.status, "contested");
    assert.match(growthViewText(counter.view), /存在反例.*朋友来访/);
    assert.match(await ledger.summary(17), /存在反例.*朋友来访/);
    await ledger.perceive(event("forced4", 18, choice("forced4", undefined, { agency: "imposed" })));
    await assert.rejects(ledger.reflect({ ...habit(["forced4"]), claimId: formed.view.claimId, relation: "revise", statement: "从此每天必须散步。" }, 18), /本次新增的自主完成/);

    const state: ReflectionInput = { kind: "state", subject: "自己", situation: "今晚和朋友争吵之后", cues: ["争吵"],
      statement: "暂时不太想说话，需要独处一会儿。", evidenceIds: ["rain"] };
    await assert.rejects(ledger.reflect(state, 18), /expiresAt/);
    await assert.rejects(ledger.reflect({ ...state, expiresAt: 18 }, 18), /expiresAt/);
    await assert.rejects(ledger.reflect({ ...state, situation: undefined, expiresAt: 20 }, 18), /situation/);
    const temporary = await ledger.reflect({ ...state, expiresAt: 20 }, 18);
    assert.equal((await ledger.retrieve({ text: "想起刚才的争吵。", at: 19 }))[0]?.claimId, temporary.view.claimId);
    assert.deepEqual(await ledger.retrieve({ text: "想起刚才的争吵。", at: 20 }), []);
    assert.equal((await ledger.recall({ claimId: temporary.view.claimId, at: 20 }))[0]?.inactiveReason, "expired");
    assert.doesNotMatch(await ledger.summary(20), /暂时不太想说话/);
    await ledger.perceive(event("moved", 21, choice("move"), "搬家之后河边很远，已经改为饭后在附近公园走走。"));
    const retired = await ledger.reflect({ ...habit(["moved"]), claimId: formed.view.claimId, relation: "retire",
      statement: "搬家后不再沿旧河道散步。" }, 21);
    assert.equal(retired.view.active, false); assert.equal(retired.view.inactiveReason, "retired");
    assert.equal(retired.view.records.length, 3);
    assert.deepEqual(await ledger.retrieve({ text: "晚饭结束，去河边走走？", at: 21 }), []);

    const broad = new GrowthLedger(path.join(base, "trait"));
    const traits: ReflectionInput = { kind: "trait", subject: "面对分歧", situation: "和熟人讨论不同意见时", cues: ["不同意见", "分歧"],
      statement: "比以前更愿意先听别人解释，再表达自己的判断。", evidenceIds: [] };
    for (let i = 1; i <= 6; i++) {
      const id = `patient${i}`; traits.evidenceIds.push(id);
      await broad.perceive(event(id, i, choice(`conversation${i}`, "群聊讨论作品", { action: "先听对方解释" }), "讨论作品时，选择先听对方解释。"));
    }
    await assert.rejects(broad.reflect(traits, 6), /3 种不同情境/);
    await broad.perceive(event("home", 7, choice("home", "家庭分工", { action: "先听对方解释" }), "分工不同意时先听朋友说明。"));
    await broad.perceive(event("outing", 8, choice("outing", "出游安排", { action: "先听对方解释" }), "安排旅行时先听同伴说明。"));
    const evolved = await broad.reflect({ ...traits, evidenceIds: [...traits.evidenceIds.slice(0, 4), "home", "outing"] }, 8);
    assert.equal(evolved.view.kind, "trait"); assert.equal(evolved.view.status, "tentative");
    await broad.perceive(event("friend", 9, { agency: "observed", subjectIds: ["onebot:123"] }, "青哥愿意帮我准备出游用品。"));
    await assert.rejects(broad.reflect({ kind: "relationship", subject: "青哥", subjectId: "onebot:456", statement: "愿意在出游前帮忙准备。", evidenceIds: ["friend"] }, 9), /实际感知过的身份/);
    const friendship = await broad.reflect({ kind: "relationship", subject: "青哥", subjectId: "onebot:123", statement: "愿意在出游前帮忙准备。", evidenceIds: ["friend"] }, 9);
    assert.equal((await broad.retrieve({ text: "阿青说早上好", subjectIds: ["onebot:123"], at: 10 }))[0]?.claimId, friendship.view.claimId,
      "a stable identity retrieves a relationship even when the nickname changes");
    assert.ok(!(await broad.retrieve({ text: "另一位朋友愿意帮我准备出游用品。", subjectIds: ["onebot:456"], at: 10 }))
      .some(view => view.claimId === friendship.view.claimId), "a shared topic must not transfer one person's relationship to a different person");
    assert.ok(!(await broad.retrieve({ text: "青哥愿意帮我准备出游用品。", subjectIds: ["onebot:456"], at: 10 }))
      .some(view => view.claimId === friendship.view.claimId), "even an identical nickname cannot override a different stable identity");
    await broad.perceive(event("namesake", 10, { agency: "observed", subjectIds: ['chat-user:["onebot","456"]'] }, "另一位也叫青哥的人愿意帮我准备出游用品。"));
    const namesake = await broad.reflect({ kind: "relationship", subject: "青哥", subjectId: 'chat-user:["onebot","456"]', statement: friendship.view.statement, evidenceIds: ["namesake"] }, 10);
    assert.notEqual(namesake.view.claimId, friendship.view.claimId, "same words about different people are separate claims");
    assert.match(growthViewText(namesake.view), /onebot 账号 456/);
    assert.match(await broad.summary(10), /onebot 账号 456/);
    assert.match(await broad.summary(10), /身份 onebot:123/);

    const longHistory = new GrowthLedger(path.join(base, "old-counter"));
    for (let i = 1; i <= 9; i++) await longHistory.perceive(event(`history${i}`, i, choice(`history${i}`)));
    const originalHabit = habit(["history1", "history2", "history3"]);
    const lasting = await longHistory.reflect(originalHabit, 9);
    await longHistory.reflect({ ...originalHabit, claimId: lasting.view.claimId, relation: "counter", statement: "膝盖受伤时需要休息，不能照常散步。", evidenceIds: ["history4"] }, 9);
    for (let i = 5; i <= 9; i++) await longHistory.reflect({ ...originalHabit, claimId: lasting.view.claimId, evidenceIds: [`history${i}`] }, 9);
    const abbreviated = (await longHistory.snapshotReview({ at: 10, minimumEpisodes: 1 }))!.claims.find(view => view.claimId === lasting.view.claimId)!;
    assert.equal(abbreviated.status, "contested");
    assert.ok(abbreviated.records.length <= 5, "review still bounds recent history plus the unresolved counterexample");
    assert.match(growthViewText(abbreviated), /膝盖受伤/, "later support does not hide an unresolved older counterexample from the next review");

    const reviewed = new GrowthLedger(path.join(base, "reviews"));
    for (let i = 1; i <= 4; i++) await reviewed.perceive(event(`review${i}`, i, choice(`review${i}`)));
    const snap = (await reviewed.snapshotReview({ at: 4 }))!;
    assert.ok(snap); assert.equal(snap.episodeIds.length, 4);
    assert.ok(snap.evidence.every(e => e.experience?.agency === "self"));
    const valid = habit(["review1", "review2", "review3"]);
    await assert.rejects(reviewed.commitReview(snap, [valid, { ...state, evidenceIds: ["unseen"], expiresAt: 30 }], 4), /未感知/);
    assert.equal((await reviewed.stats()).records, 0, "one invalid proposal rolls back every record in a batch");
    assert.equal((await reviewed.snapshotReview({ at: 4 }))?.id, snap.id, "failed review does not advance the cursor");
    await assert.rejects(reviewed.commitReview(snap, [{ ...state, evidenceIds: ["review4"], expiresAt: 5 }], 5), /expiresAt/,
      "a temporary state that expired while the model was working is rejected without consuming evidence");
    assert.equal((await reviewed.snapshotReview({ at: 4 }))?.id, snap.id);

    const originalAppend = fs.appendFile;
    fs.appendFile = async (...args: Parameters<typeof fs.appendFile>) => {
      if (String(args[0]) === reviewed.file && String(args[1]).includes('"review_committed"')) {
        await originalAppend(args[0], '{"type":"review_committed"'); throw new Error("injected disk failure");
      }
      return originalAppend(...args);
    };
    try { await assert.rejects(reviewed.commitReview(snap, [valid], 4), /injected disk failure/); }
    finally { fs.appendFile = originalAppend; }
    assert.equal((await reviewed.stats()).records, 0);
    assert.equal((await new GrowthLedger(path.dirname(reviewed.file)).snapshotReview({ at: 4 }))?.id, snap.id);
    const committed = await reviewed.commitReview(snap, [valid, { kind: "preference", subject: "河边", statement: "最近觉得河边很放松。", evidenceIds: ["review4"] }], 4);
    assert.equal(committed.records.length, 2); assert.ok(committed.records.every(record => record.origin === "automatic"));
    assert.equal((await reviewed.pendingReviews()).length, 1);
    assert.equal((await reviewed.commitReview(snap, [valid], 4)).duplicate, true);
    assert.equal((await reviewed.stats()).records, 2, "retrying a committed review cannot duplicate its records");
    assert.equal(await reviewed.snapshotReview({ at: 4 }), null);
    const resumed = new GrowthLedger(path.dirname(reviewed.file));
    assert.equal(await resumed.snapshotReview({ at: 4 }), null);
    assert.deepEqual((await resumed.pendingReviews())[0]?.records, committed.records, "outbox survives a crash before context delivery");
    await resumed.ackReview(committed.id); await resumed.ackReview(committed.id);
    assert.deepEqual(await new GrowthLedger(path.dirname(reviewed.file)).pendingReviews(), []);
    const lines = (await fs.readFile(reviewed.file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.filter(line => line.type === "review_committed").length, 1);
    assert.equal(lines.find(line => line.type === "review_committed").records.length, 2, "records and cursor use a single durable JSONL transaction");

    for (let i = 5; i <= 8; i++) await resumed.perceive(event(`review${i}`, i, choice(`review${i}`)));
    const none = (await resumed.snapshotReview({ at: 8 }))!;
    assert.ok(none.claims.some(claim => claim.claimId === committed.records[0]?.claimId));
    assert.ok(none.evidence.some(e => e.eventId === "review1"), "a consumed no-change batch does not erase useful original evidence");
    await resumed.commitReview(none, [], 8);
    assert.equal(await new GrowthLedger(path.dirname(resumed.file)).snapshotReview({ at: 8 }), null);
    assert.deepEqual(await resumed.pendingReviews(), [], "no-change creates no synthetic growth event");
    for (let i = 9; i <= 12; i++) await resumed.perceive(event(`review${i}`, i, choice(`review${i}`)));
    const stale = (await resumed.snapshotReview({ at: 12 }))!;
    await resumed.reflect({ kind: "preference", subject: "晚饭", statement: "喜欢饭后稍作休息。", evidenceIds: ["review12"] }, 12);
    await assert.rejects(resumed.commitReview(stale, [], 12), /快照已失效/);
    assert.equal((await resumed.snapshotReview({ at: 12 }))?.afterCursor, stale.afterCursor, "concurrent manual reflection invalidates review without losing pending experiences");
    const current = (await resumed.snapshotReview({ at: 12 }))!;
    await assert.rejects(resumed.commitReview({ ...current, evidence: [] }, [], 12), /快照已失效/);
    const stopped = new AbortController(); stopped.abort(new Error("world stopped"));
    await assert.rejects(resumed.commitReview(current, [], 12, stopped.signal), /world stopped/);
    assert.equal((await resumed.snapshotReview({ at: 12 }))?.afterCursor, current.afterCursor,
      "a stopped runtime cannot consume the evidence prefix through a delayed commit");

    const repaired = new GrowthLedger(path.join(base, "recovery"));
    const delivered: StreamEntry[] = [
      { kind: "event", event: event("delivered", 1, choice("delivered")) },
      { kind: "tool_call", call: { id: "reflect-call", role: "agent", name: "reflect", arguments: {}, issuedAt: 2, expectedAt: 2 } },
      { kind: "event", event: { ...event("reflection-output", 2, choice("made-up")), refToolCallId: "reflect-call", source: "tool" } },
      { kind: "event", event: { ...event("remembered", 3, choice("fake-choice")), originEventIds: [] } },
      { kind: "event", event: { ...event("review-summary", 4), source: "system" } },
    ];
    await repaired.restorePerceptions(delivered); await repaired.restorePerceptions(delivered);
    assert.equal((await repaired.recallEvidence()).length, 1);
    assert.equal((await repaired.recallEvidence())[0]?.experience?.episodeId, "delivered", "metadata survives durable context recovery");
    assert.deepEqual(await new GrowthLedger(path.dirname(repaired.file), "visitor").recallEvidence(), []);

    const busy = new GrowthLedger(path.join(base, "busy-conversation"));
    for (let i = 1; i <= 25; i++) await busy.perceive(event(`busy${i}`, i, choice("same-chat-episode", "群聊讨论", {
      ...(i === 8 ? { outcome: "failed" as const } : {}), ...(i === 12 ? { agency: "imposed" as const } : {}),
    }), `群聊讨论中的第 ${i} 条已读消息。`));
    for (let i = 26; i <= 28; i++) await busy.perceive(event(`busy${i}`, i, choice(`later-episode${i}`)));
    const busySnapshot = await busy.snapshotReview({ at: 28 });
    assert.ok(busySnapshot, "a long first episode must not hide the later episodes behind the evidence sampling limit");
    assert.equal(busySnapshot.episodeIds.length, 4);
    assert.equal(busySnapshot.coveredEventCount, 28);
    assert.equal(busySnapshot.throughCursor, 28);
    assert.equal(busySnapshot.evidence.length, 24);
    assert.equal(busySnapshot.omittedEvidenceCount, 4);
    for (const id of ["busy8", "busy12", "busy25", "busy26", "busy27", "busy28"]) {
      assert.ok(busySnapshot.evidence.some(e => e.eventId === id), `${id}: retain episode coverage, failed/imposed outcomes and completed choices`);
    }
    await busy.commitReview(busySnapshot, [], 28);
    assert.equal(await new GrowthLedger(path.dirname(busy.file)).snapshotReview({ at: 28 }), null,
      "a committed sampled batch consumes its explicit prefix and cannot recur after restart");
    for (let i = 29; i <= 32; i++) await busy.perceive(event(`busy${i}`, i, choice(`later-episode${i}`)));
    assert.equal((await busy.snapshotReview({ at: 32 }))?.afterCursor, 28, "new episodes remain reviewable after a dense batch");

    const interleaved = new GrowthLedger(path.join(base, "interleaved"));
    for (let i = 1; i <= 260; i++) await interleaved.perceive(event(`interleaved${i}`, i, choice(`channel${i % 2}`)));
    const finiteBatch = await interleaved.snapshotReview({ at: 260 });
    assert.ok(finiteBatch, "a bounded scan of a large interleaving must allow progress instead of returning null forever");
    assert.equal(finiteBatch.coveredEventCount, 256);
    assert.equal(finiteBatch.episodeIds.length, 2, "an oversized batch never invents additional independent episodes");
    assert.ok(finiteBatch.evidence.length <= 24);
    await interleaved.commitReview(finiteBatch, [], 260);
    assert.equal((await interleaved.snapshotReview({ at: 260, minimumEpisodes: 1 }))?.afterCursor, 256);

    const sparse = new GrowthLedger(path.join(base, "sparse-habit"));
    for (let batch = 0; batch < 2; batch++) {
      const id = `old-walk${batch}`;
      await sparse.perceive(event(id, batch + 1, choice(id)));
      const priorBatch = (await sparse.snapshotReview({ at: batch + 1, minimumEpisodes: 1 }))!;
      await sparse.commitReview(priorBatch, [], batch + 1);
    }
    for (let i = 0; i < 30; i++) await sparse.perceive(event(`current-walk${i}`, i + 3, choice(`current-dinner${Math.floor(i / 8)}`)));
    const withPast = (await sparse.snapshotReview({ at: 33 }))!;
    assert.ok(withPast.evidence.length <= 24);
    assert.ok(withPast.evidence.some(e => e.eventId === "old-walk0"));
    assert.ok(withPast.evidence.some(e => e.eventId === "old-walk1"));
    assert.equal(new Set(withPast.evidence.filter(e => e.eventId.startsWith("current-walk")).map(e => e.experience?.episodeId)).size, 4,
      "historical evidence has reserved capacity without sacrificing fresh episode coverage");
    const currentChoice = withPast.evidence.find(e => e.eventId.startsWith("current-walk"))!;
    assert.equal((await sparse.commitReview(withPast, [habit(["old-walk0", "old-walk1", currentChoice.eventId])], 33)).records.length, 1,
      "a sparse habit can form across earlier no-change reviews despite a dense current episode");

    const configured = new GrowthLedger(path.join(base, "configured-minimum"));
    for (let i = 1; i <= 24; i++) await configured.perceive(event(`configured${i}`, i, choice(`configured${i}`)));
    assert.equal((await configured.snapshotReview({ at: 24, minimumEpisodes: 24 }))?.episodeIds.length, 24,
      "the implicit maximum episode count must be clamped to a larger configured minimum");

    console.log("PASS growth evolution: independent voluntary choices, temporary-state expiry, scoped traits, counterevidence, Chinese retrieval, atomic reviews, crash-safe cursor/outbox, no-change and append-only recovery");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
