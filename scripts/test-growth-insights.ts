/** Growth admission, legacy audit and complete-ledger pagination, entirely local. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrowthLedger, type GrowthRecord, type PerceivedEvidence, type ReflectionInput } from "../src/bot/growth.js";
import type { BotEvent } from "../src/types.js";
import type { GrowthInsight } from "../src/bot/growth-semantics.js";

const dirs: string[] = [];
const thought = (eventId: string, quote: string, dimension = "放松时的饮品选择"): GrowthInsight => ({ dimension,
  significance: "以后需要放松而又不想喝咖啡时，可以把清茶作为一个候选，而非固定要求。", anchors: [{ eventId, quote }] });
const event = (id: string, at = 1, content = "晚饭后，你在咖啡和清茶之间选择了一杯清茶，沿河散步放松。", action = "在咖啡和清茶之间选择清茶"): BotEvent => ({
  id, source: "world", worldTime: at, content, originEventIds: ["root:" + id], experience: {
    agency: "self", outcome: "completed", opportunity: true, episodeId: "episode:" + id, action, situation: "晚饭后河边放松", worldPerception: true,
  },
});
const rawEvidence = (item: BotEvent): PerceivedEvidence => ({ eventId: item.id, actorId: "bot", source: item.source,
  observedAt: item.worldTime, text: item.content, rootEventIds: item.originEventIds!, experience: item.experience });
function preference(item: BotEvent, subject = "放松时喝清茶", dimension = "放松时的饮品选择"): ReflectionInput {
  return { kind: "preference", subject, statement: "需要放松时，清茶可以作为比咖啡更合适的选择。", evidenceIds: [item.id], insight: thought(item.id, item.content, dimension) };
}
const prepare = (input: unknown) => input as ReflectionInput;
async function fixture(lines: unknown[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-growth-insights-")); dirs.push(dir);
  const ledger = new GrowthLedger(dir);
  const original = lines.length ? lines.map(line => JSON.stringify(line)).join("\n") + "\n" : "";
  if (original) await fs.writeFile(ledger.file, original);
  return { dir, ledger, original };
}
function legacyRecord(id: string, kind: GrowthRecord["kind"], item: BotEvent, overrides: Partial<GrowthRecord> = {}): GrowthRecord {
  return { id, claimId: id, actorId: "bot", kind, subject: "旧认识 " + id, statement: item.content, evidenceIds: [item.id], rootEventIds: item.originEventIds!,
    recordedAt: item.worldTime + 1, relation: "support", origin: "automatic", scope: { domain: "physical" }, groundingVersion: 1, ...overrides };
}

async function newAdmissionAndAutomaticBoundary() {
  const { ledger } = await fixture();
  const first = event("original", 1); await ledger.perceive(first);
  const missing = preference(first); delete missing.insight;
  await assert.rejects(ledger.reflect(missing, 2), /insight/);
  const accepted = await ledger.reflect(preference(first), 2);
  assert.equal(accepted.view.needsReview, undefined);
  assert.equal(accepted.view.records[0]!.semanticVersion, 1);
  assert.match(await ledger.summary(2), /清茶/);
  assert.deepEqual((await ledger.retrieve({ text: "需要放松时，选择清茶而不是咖啡", at: 2 })).map(view => view.claimId), [accepted.view.claimId]);
  const second = event("again", 3); await ledger.perceive(second);
  await assert.rejects(ledger.reflect(preference(second, "河边的茶饮选择"), 4), /同一认识维度|重复新建/,
    "a new presentation title must not evade the same self-preference dimension");
  const support: ReflectionInput = { ...preference(second), claimId: accepted.view.claimId };
  delete support.insight;
  await assert.rejects(ledger.reflect(support, 4), /insight/);
  const supported = await ledger.reflect({ ...support, insight: thought(second.id, second.content) }, 4);
  assert.equal(supported.view.records.length, 2);

  const manualState = await ledger.reflect({ kind: "state", subject: "散步后短暂疲倦", statement: "眼下有点累，想歇歇。", situation: "散步后，恢复以前", evidenceIds: [second.id] }, 4);
  assert.equal(manualState.view.active, true, "manual temporary state remains available for explicit use");
  assert.doesNotMatch(await ledger.summary(4), /眼下有点累/);
  assert.ok((await ledger.retrieve({ text: "散步后疲倦眼下累歇歇", at: 4 })).every(view => view.kind !== "state"));

  // Process the initial events, then include their literal source as related history.
  const consumed = await ledger.snapshotReview({ at: 5, minimumEpisodes: 1 }); assert.ok(consumed);
  await ledger.commitAutomaticReview(consumed, [], 5, prepare);
  const fresh = event("fresh", 6); await ledger.perceive(fresh);
  const snapshot = await ledger.snapshotReview({ at: 7, minimumEpisodes: 1 }); assert.ok(snapshot);
  assert.ok(snapshot.evidence.some(item => item.eventId === first.id), "the fixture really exposes the old source as related evidence");
  assert.ok(!snapshot.reviewEventIds!.includes(first.id));
  const result = await ledger.commitAutomaticReview(snapshot, [
    { kind: "state", subject: "刚喝过茶", statement: "当前喝过茶了。", situation: "刚喝完茶", evidenceIds: [fresh.id] },
    preference(first, "旧材料的新标题", "另一种偷换的认识"),
    preference(fresh, "喝茶时选择河边", "饮茶的地点选择"),
  ], 7, prepare);
  assert.equal(result.records.length, 1);
  assert.equal(result.rejected?.length, 2);
  assert.match(result.rejected![0]!.reason, /临时处境|流水账/);
  assert.match(result.rejected![1]!.reason, /本批|旧证据/);
  assert.equal((await ledger.reviewStatus()).pending, 0);
}

async function legacyIsolationAndRevalidation() {
  const relationship = event("old-rel", 1, "修理工耐心解释了接线原理，并表示下次遇到问题可以再来找他。", "向修理工求助");
  const emptyPromise = event("old-promise", 2, "你打开了一个测试页面，页面中有许多选项。", "打开网页测试");
  const oldPreference = event("old-preference", 3, "你浏览了偏好问卷的首页。", "浏览问卷首页");
  const oldRecords = [legacyRecord("rel", "relationship", relationship), legacyRecord("promise", "commitment", emptyPromise), legacyRecord("pref", "preference", oldPreference)];
  const { dir, ledger, original } = await fixture([
    ...[relationship, emptyPromise, oldPreference].map(item => ({ type: "perceived", evidence: rawEvidence(item) })),
    ...oldRecords.map(record => ({ type: "reflection", record })),
  ]);
  assert.equal(await ledger.summary(20), "", "old source-checked records still need the new semantic audit");
  assert.deepEqual(await ledger.retrieve({ text: relationship.content + oldPreference.content, at: 20 }), []);
  const active = await ledger.queryPage({ at: 20 }); assert.equal(active.total, 0);
  const isolated = await ledger.queryPage({ at: 20, lifecycle: "inactive" });
  assert.equal(isolated.total, 3); assert.ok(isolated.items.every(view => view.needsReview && view.active));
  assert.ok(isolated.items.every(view => !!view.isolationReason));
  assert.equal(await fs.readFile(ledger.file, "utf8"), original, "read-only projection does not rewrite any legacy record");

  const pending = (await ledger.reviewStatus()).pending;
  const audit = await ledger.snapshotReview({ at: 20, minimumEpisodes: 100 }); assert.ok(audit?.revalidation);
  assert.equal(audit.coveredEventCount, 0); assert.equal(audit.afterCursor, audit.throughCursor);
  assert.deepEqual(audit.reviewEventIds, []);
  assert.deepEqual(audit.evidence.map(item => item.eventId), [relationship.id, emptyPromise.id]);
  const revised: ReflectionInput = { kind: "relationship", subject: oldRecords[0]!.subject, claimId: "rel", relation: "revise",
    statement: "遇到接线问题时可以向这位修理工求助，但这次帮助不代表他随时有空。", evidenceIds: [relationship.id],
    insight: thought(relationship.id, relationship.content, "技术求助的信任") };
  const retired: ReflectionInput = { kind: "commitment", subject: oldRecords[1]!.subject, claimId: "promise", relation: "retire",
    statement: "原文只说明打开了测试页面，没有实际承诺，停止沿用。", evidenceIds: [emptyPromise.id] };
  const result = await ledger.commitAutomaticReview(audit, [revised, retired], 21, prepare);
  assert.equal(result.records.length, 2, JSON.stringify(result.rejected));
  assert.equal(result.views.find(view => view.claimId === "rel")!.needsReview, undefined);
  assert.deepEqual(result.records[0]!.rootEventIds, [], "revalidating the original source does not manufacture a new experience");
  assert.equal(result.views.find(view => view.claimId === "promise")!.inactiveReason, "retired");
  assert.equal((await ledger.reviewStatus()).pending, pending, "legacy audits do not consume the ordinary experience cursor");
  const relationshipView = (await ledger.recall({ claimId: "rel", at: 21 }))[0]!;
  assert.equal(relationshipView.records.length, 2);
  assert.deepEqual(relationshipView.records[0], oldRecords[0]);
  assert.match(await ledger.summary(21), /接线问题/);
  assert.doesNotMatch(await ledger.summary(21), /打开了测试/);

  const remaining = await ledger.snapshotReview({ at: 22, minimumEpisodes: 100 }); assert.ok(remaining?.revalidation);
  assert.deepEqual(remaining.revalidation.map(item => item.claimId), ["pref"]);
  await ledger.commitAutomaticReview(remaining, [], 22, prepare);
  assert.equal(await ledger.snapshotReview({ at: 23, minimumEpisodes: 100 }), null, "an inconclusive audit is not scheduled indefinitely without new material");
  assert.ok((await fs.readFile(ledger.file, "utf8")).startsWith(original));
  const restored = new GrowthLedger(dir);
  assert.equal(await restored.snapshotReview({ at: 24, minimumEpisodes: 100 }), null, "audit attempts and cursor survive restart");
  assert.equal((await restored.reviewStatus()).pending, pending);
  assert.deepEqual((await restored.queryPage({ at: 24 })).items.map(view => view.claimId), ["rel"]);
}

async function reviewFairness() {
  const old = event("old-fair", 1), record = legacyRecord("fair", "preference", old);
  const { ledger } = await fixture([{ type: "perceived", evidence: rawEvidence(old) }, { type: "reflection", record }]);
  for (let count = 0; count < 3; count++) {
    if (count) await ledger.perceive(event("fresh-fair-" + count, count * 10));
    const snapshot = await ledger.snapshotReview({ at: count * 10 + 5, minimumEpisodes: 1 }); assert.ok(snapshot);
    assert.equal(snapshot.revalidation, undefined);
    await ledger.commitAutomaticReview(snapshot, [], count * 10 + 5, prepare);
  }
  await ledger.perceive(event("fresh-fair-next", 40));
  const pending = (await ledger.reviewStatus()).pending;
  const fourth = await ledger.snapshotReview({ at: 41, minimumEpisodes: 1 });
  assert.ok(fourth?.revalidation, "busy new activity cannot starve a legacy audit after three ordinary reviews");
  await ledger.commitAutomaticReview(fourth, [], 41, prepare);
  assert.equal((await ledger.reviewStatus()).pending, pending);
  const next = await ledger.snapshotReview({ at: 42, minimumEpisodes: 1 }); assert.ok(next);
  assert.equal(next.revalidation, undefined);
}

async function filteredPagination() {
  const source = event("page-source", 1);
  const states = Array.from({ length: 75 }, (_, index) => legacyRecord(`state-${index}`, "state", source, {
    subject: "流水处境 " + index, statement: "这次打开界面的处境 " + index, recordedAt: 100 + index, situation: "界面暂时打开时", expiresAt: 10,
  }));
  const old = legacyRecord("isolated-page", "relationship", source);
  const { ledger } = await fixture([{ type: "perceived", evidence: rawEvidence(source) }, ...states.map(record => ({ type: "reflection", record })), { type: "reflection", record: old }]);
  const validIds: string[] = [];
  for (let index = 0; index < 5; index++) {
    const item = event("page-insight-" + index, 20 + index); await ledger.perceive(item);
    const view = await ledger.reflect(preference(item, "可复用认识 " + index, "饮茶的独立维度 " + index), 30 + index);
    validIds.push(view.view.claimId);
  }
  const first = await ledger.queryPage({ at: 500, kind: "preference", lifecycle: "active", limit: 2 });
  assert.equal(first.total, 5); assert.equal(first.items.length, 2);
  assert.deepEqual(first.items.map(view => view.claimId), validIds.slice(-2).reverse());
  assert.equal(first.counts.preference, 5); assert.equal(first.counts.state, 0);
  const second = await ledger.queryPage({ at: 500, kind: "preference", lifecycle: "active", limit: 2, offset: 2 });
  assert.deepEqual(second.items.map(view => view.claimId), validIds.slice(1, 3).reverse());
  const tail = await ledger.queryPage({ at: 500, kind: "preference", limit: 2, offset: 999 });
  assert.equal(tail.offset, 4); assert.deepEqual(tail.items.map(view => view.claimId), [validIds[0]]);
  const olderByKeyword = await ledger.queryPage({ at: 500, kind: "preference", keyword: "独立维度 0", limit: 1 });
  assert.equal(olderByKeyword.total, 1); assert.equal(olderByKeyword.items[0]!.claimId, validIds[0]);
  const inactive = await ledger.queryPage({ at: 500, lifecycle: "inactive", kind: "all", limit: 100 });
  assert.equal(inactive.total, 76); assert.equal(inactive.counts.state, 75); assert.equal(inactive.counts.relationship, 1);
  assert.equal((await ledger.queryPage({ at: 500, lifecycle: "inactive" })).total, 1, "default long-term filter excludes expired states before slicing");
  assert.equal((await ledger.queryPage({ at: 500, lifecycle: "all", kind: "all", limit: 100 })).total, 81);
  assert.deepEqual(await ledger.queryPage({ at: 500, keyword: "完全不存在的维度", offset: 999 }), {
    items: [], total: 0, offset: 0, limit: 30, counts: { relationship: 0, commitment: 0, preference: 0, state: 0, habit: 0, trait: 0 },
  });
}

async function main() {
  const watchdog = setTimeout(() => { console.error("growth insights integration timed out"); process.exit(1); }, 30_000);
  try {
    await newAdmissionAndAutomaticBoundary();
    await legacyIsolationAndRevalidation();
    await reviewFairness();
    await filteredPagination();
    console.log("PASS growth insight admission, original-source legacy revision/retirement without invented roots, fair persistent audits, automatic-state/old-evidence exclusion and filter-before-page lifecycle queries");
  } finally { clearTimeout(watchdog); for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
