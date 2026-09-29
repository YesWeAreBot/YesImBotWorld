/** Synthetic equivalent of a delayed nap review; no live instance, chat material or model is used. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger, type GrowthRecord, type ReflectionInput } from "../src/bot/growth.js";
import { GrowthRuntime } from "../src/bot/growth-runtime.js";
import type { BotModelConfig } from "../src/config.js";
import type { BotEvent } from "../src/types.js";
import { WorldFiles } from "../src/files.js";
import { COMPRESSION_SOURCE_GUIDANCE } from "../src/prompts.js";

const NOW = 1_103_001, OLD = [1_081_491, 1_081_592, 1_081_701, 1_081_805];
const cfg = { baseURL: "http://unused.invalid/v1", apiKey: "", model: "fixture", growth: { enabled: true, minEpisodes: 4,
  reviewIntervalMs: 1, reviewTimeoutMs: 2000, maxInputChars: 24000, recallCount: 3 } } as BotModelConfig;
const logger = { warn() {} } as any;
const state: ReflectionInput = { kind: "state", subject: "准备午睡", statement: "忙完后准备睡一会儿。", situation: "午后忙碌结束，休息恢复以前", evidenceIds: OLD.map((_, i) => `nap${i}`) };
const event = (id: string, at: number): BotEvent => ({ id, source: "world", worldTime: at, content: "午后忙完，朋友准备了茶，稍后想休息。",
  originEventIds: ["root:" + id], experience: { agency: "observed", episodeId: id, situation: "午后忙碌结束" } });

async function workspace(base: string) {
  const files = new WorldFiles(base); await files.ensure();
  const context = new BotContext(files); await context.load();
  const ledger = new GrowthLedger(base);
  for (const [i, at] of OLD.entries()) { const e = event("nap" + i, at); await context.appendEvent(e); await ledger.perceive(e); }
  return { files, context, ledger };
}

async function staleAndFresh(base: string) {
  const { context, ledger } = await workspace(base);
  const prefix = await context.toChatMessages("T" + NOW);
  const runtime = new GrowthRuntime(ledger, cfg, { now: () => NOW, unitWorldSeconds: 1 }, context, logger, {
    infer: async messages => {
      assert.match(messages[0]!.content as string, /不要新增 state/);
      return { content: JSON.stringify({ changes: [state, { ...state, subject: "准备很久的午睡", expiresAt: NOW + 7200 },
        { kind: "relationship", subject: "泡茶的朋友", statement: "当时朋友愿意照顾我的休息。", evidenceIds: ["nap3"], insight: { dimension: "忙碌时的照应", significance: "忙完时朋友愿意准备茶点，可以在疲倦时向其表达休息需要。", anchors: [{ eventId: "nap3", quote: "午后忙完，朋友准备了茶，稍后想休息。" }] } }] }), toolCalls: [] };
    },
  });
  runtime.tick(); await runtime.settled();
  const status = await ledger.reviewStatus(), views = await ledger.recall({ at: NOW });
  assert.equal(status.recent[0]!.rejected?.length, 2);
  assert.ok(status.recent[0]!.rejected!.every(item => /自动成长不记录临时处境/.test(item.reason)));
  assert.deepEqual(views.map(view => view.kind), ["relationship"], "stale state siblings do not discard a legitimate lasting relationship");
  assert.equal(status.pending, 0); assert.equal((await ledger.recallEvidence({ n: 50 })).length, 4);
  assert.deepEqual(await context.toChatMessages("T" + NOW), prefix, "validation does not rewrite or extend the actor prefix");
  await assert.rejects(ledger.reflect({ ...state, expiresAt: NOW + 999999 }, NOW), /最近两世界小时/);
  const freshAt = NOW - 30;
  await ledger.perceive(event("current-rest", freshAt));
  const fresh = await ledger.reflect({ ...state, subject: "眼下想歇一会儿", evidenceIds: ["current-rest"] }, NOW, 120);
  assert.equal(fresh.view.expiresAt, freshAt + 7200 / 120);
  assert.equal(fresh.view.records[0]!.stateTiming!.evidenceAt, freshAt);
  // The same elapsed TU represents two more world hours at this scale and cannot be made fresh by a future deadline.
  await assert.rejects(ledger.reflect({ ...state, subject: "过时的休息", evidenceIds: ["current-rest"], expiresAt: NOW + 999999 }, NOW + 31, 120), /最近两世界小时/);
  runtime.stop();
}

async function auditedLegacyCorrection(base: string) {
  const { files, context, ledger } = await workspace(base);
  const original: GrowthRecord = { id: "legacy-wrong-nap", claimId: "legacy-wrong-nap", actorId: "bot", ...state,
    relation: "support", rootEventIds: OLD.map((_, i) => "root:nap" + i), recordedAt: NOW, origin: "automatic", expiresAt: NOW + 7200 };
  const manual: GrowthRecord = { ...original, id: "legacy-manual", claimId: "legacy-manual", origin: "manual", subject: "手动保留的历史状态" };
  const retired: GrowthRecord = { ...original, id: "legacy-retired", claimId: "legacy-retired", relation: "retire", subject: "已停止适用的状态" };
  const valid: GrowthRecord = { ...original, id: "legacy-valid", claimId: "legacy-valid", subject: "有及时证据的状态", recordedAt: OLD[3]! + 10,
    expiresAt: NOW + 7200 };
  // Seed only an isolated fixture in the old journal format, before timing guards existed.
  await fs.appendFile(ledger.file, JSON.stringify({ type: "review_committed", actorId: "bot", id: "legacy-review", afterCursor: 0, throughCursor: 4,
    at: NOW, records: [original] }) + "\n" + [manual, retired, valid].map(record => JSON.stringify({ type: "reflection", record })).join("\n") + "\n");
  let restored = new GrowthLedger(base);
  const beforeStats = await restored.stats(), beforeFile = await fs.readFile(restored.file, "utf8");
  assert.equal((await restored.recall({ claimId: original.claimId, at: NOW }))[0]!.active, true);
  const append = (restored as any).append.bind(restored);
  (restored as any).append = async () => { throw Error("correction disk failure"); };
  await assert.rejects(restored.correctStaleAutomaticStates({ at: NOW + 1, secondsPerTU: 1 }), /correction disk failure/);
  assert.equal((await restored.recall({ claimId: original.claimId, at: NOW }))[0]!.active, true);
  (restored as any).append = append;
  const correction = await restored.correctStaleAutomaticStates({ at: NOW + 1, secondsPerTU: 1 });
  assert.equal(correction.length, 1); assert.equal(correction[0]!.recordId, original.id);
  assert.equal(correction[0]!.evidenceAt, OLD[3]); assert.equal(correction[0]!.expiresAt, 1_089_005);
  assert.equal(correction[0]!.previousExpiresAt, NOW + 7200);
  assert.deepEqual(await restored.stats(), beforeStats, "administrative timing correction is neither a new experience nor a growth record");
  assert.ok((await fs.readFile(restored.file, "utf8")).startsWith(beforeFile), "the original journal remains byte-for-byte intact");
  restored = new GrowthLedger(base);
  assert.deepEqual(await restored.correctStaleAutomaticStates({ at: NOW + 2, secondsPerTU: 1 }), [], "restart correction is idempotent");
  const corrected = (await restored.recall({ claimId: original.claimId, at: NOW }))[0]!;
  assert.equal(corrected.active, false); assert.equal(corrected.inactiveReason, "expired"); assert.equal(corrected.expiresAt, 1_089_005);
  assert.deepEqual(corrected.records[0], original, "historical record is not rewritten to pretend it was originally correct");
  assert.equal(corrected.stateTimingCorrection!.recordId, original.id);
  assert.doesNotMatch(await restored.summary(NOW), /准备午睡/);
  assert.equal((await restored.recall({ claimId: retired.claimId, at: NOW }))[0]!.inactiveReason, "retired");
  assert.equal((await restored.recall({ claimId: valid.claimId, at: NOW }))[0]!.expiresAt, valid.expiresAt);
  assert.equal((await restored.recall({ claimId: manual.claimId, at: NOW }))[0]!.expiresAt, manual.expiresAt);
  const prefix = await context.toChatMessages("T" + NOW);
  const runtime = new GrowthRuntime(restored, cfg, { now: () => NOW + 2, unitWorldSeconds: 1 }, context, logger);
  const appendContext = context.appendEvent.bind(context);
  context.appendEvent = async () => { throw Error("correction context failure"); };
  await assert.rejects(runtime.drain(), /correction context failure/);
  assert.equal((await restored.pendingStateTimingCorrections()).length, 1);
  context.appendEvent = appendContext;
  restored.ackStateTimingCorrection = async () => { throw Error("correction ack failure"); };
  await assert.rejects(runtime.drain(), /correction ack failure/);
  const after = await context.toChatMessages("T" + NOW);
  assert.deepEqual(after.slice(0, prefix.length), prefix);
  const notifications = context.stream.filter(entry => entry.kind === "event" && entry.event.id.startsWith("ev_growth_state_timing_"));
  assert.equal(notifications.length, 1); assert.equal(context.stream.some(entry => entry.kind === "event" && entry.event.id === "ev_growth_legacy-review"), false);
  const notification = notifications[0]!; assert.ok(notification.kind === "event");
  assert.deepEqual(notification.event.originEventIds, []); assert.equal(notification.event.source, "system");
  assert.match(notification.event.content, /不是新经历或新的成长/);
  runtime.stop();
  const reloadedContext = new BotContext(files); await reloadedContext.load();
  const reloadedLedger = new GrowthLedger(base);
  const afterRestart = new GrowthRuntime(reloadedLedger, cfg, { now: () => NOW + 3, unitWorldSeconds: 1 }, reloadedContext, logger);
  assert.deepEqual(await afterRestart.drain(), [], "an acknowledged retry reuses the already appended correction event");
  assert.equal((await reloadedLedger.pendingStateTimingCorrections()).length, 0);
  assert.equal((await reloadedLedger.reviewStatus()).timingCorrections, 1);
  assert.deepEqual(await reloadedContext.toChatMessages("T" + NOW), after);
  await reloadedLedger.restorePerceptions(reloadedContext.stream);
  assert.deepEqual(await reloadedLedger.stats(), beforeStats);
  afterRestart.stop();
}

async function recentHalfHour(base: string) {
  const files = new WorldFiles(base); await files.ensure(); const context = new BotContext(files); await context.load();
  const ledger = new GrowthLedger(base);
  // All of these old events fit inside six hours; a six-hour recovery window would still bury current experience.
  for (let i = 0; i < 150; i++) await ledger.perceive(event("hour-old" + i, NOW - 4000 + i));
  for (let i = 0; i < 4; i++) await ledger.perceive(event("current" + i, NOW - 20 + i));
  let seen: string[] = [];
  const runtime = new GrowthRuntime(ledger, cfg, { now: () => NOW, unitWorldSeconds: 1 }, context, logger, { infer: async messages => {
    const payload = JSON.parse(messages[1]!.content as string); seen = payload.evidence.filter((item: any) => item.reviewRole === "batch").map((item: any) => item.id);
    return { content: '{"changes":[]}', toolCalls: [] };
  } });
  runtime.tick(); await runtime.settled();
  assert.equal(seen.length, 4); assert.ok(seen.every(id => id.startsWith("current")));
  assert.equal((await ledger.reviewStatus()).deferred, 150); assert.equal((await ledger.reviewStatus()).pending, 0);
  assert.equal((await ledger.recallEvidence({ eventIds: ["hour-old0"] })).length, 1);
  runtime.stop();
}

async function historicalWorldReceipts(base: string) {
  const files = new WorldFiles(base); await files.ensure();
  const context = new BotContext(files); await context.load();
  const ledger = new GrowthLedger(base);
  const legacy = event("legacy-untagged-world", NOW - 30);
  await ledger.perceive(legacy);
  const previousJournal = await fs.readFile(ledger.file, "utf8");
  const late: BotEvent = { id: "late-old-world-result", source: "tool", worldTime: NOW - 1, originEventIds: ["old-world:tea"],
    content: JSON.stringify({ observation: { mode: "narrative", actorId: "bot", observationId: "old-teashop",
      narrative: "你在先前世界的茶铺里，店员给你递了一杯热茶。", situation: "旧世界茶铺内，手里有一杯茶。" }, action: { status: "completed", intent: "去茶铺买茶" } }),
    experience: { agency: "observed", worldPerception: true, worldEpoch: "old-world-stage", historicalWorld: true, episodeId: "old-world:tea" } };
  await context.appendEvent(late); await ledger.perceive(late);
  assert.ok((await fs.readFile(ledger.file, "utf8")).startsWith(previousJournal), "new provenance is appended without rewriting older evidence");
  const reloaded = new GrowthLedger(base);
  const saved = (await reloaded.recallEvidence({ eventIds: [late.id] }))[0]!;
  assert.equal(saved.experience?.worldEpoch, "old-world-stage");
  assert.equal(saved.experience?.historicalWorld, true);
  assert.match(saved.text, /店员给你递了一杯热茶/);
  await reloaded.perceive({ ...legacy, experience: { ...legacy.experience, worldEpoch: "retroactive-guess", historicalWorld: true } });
  const unchanged = (await reloaded.recallEvidence({ eventIds: [legacy.id] }))[0]!;
  assert.equal(unchanged.experience?.worldEpoch, undefined, "replaying old evidence never backfills a guessed historical world");
  assert.equal(unchanged.experience?.historicalWorld, undefined);
  const prefix = await context.toChatMessages("before historical review");
  let calls = 0;
  const runtime = new GrowthRuntime(reloaded, cfg, { now: () => NOW, unitWorldSeconds: 1 }, context, logger, { infer: async messages => {
    calls++;
    assert.match(String(messages[0]!.content), /historicalWorld=true.*先前世界.*不能据此新建或续期当前state/);
    const payload = JSON.parse(String(messages[1]!.content)), evidence = payload.evidence.find((item: any) => item.id === late.id);
    assert.equal(evidence?.experience.historicalWorld, true);
    assert.equal(evidence?.experience.worldEpoch, "old-world-stage", "review packing keeps source boundaries even when the old result arrived recently");
    return { content: JSON.stringify({ changes: [
      { kind: "state", subject: "正在茶铺喝茶", statement: "现在还在茶铺里。", situation: "旧世界茶铺内", evidenceIds: [late.id] },
      { kind: "relationship", subject: "旧世界的店员", statement: "那家旧茶铺的店员愿意为来客提供服务。", evidenceIds: [late.id], insight: { dimension: "茶铺服务的初步印象", significance: "如果再次回到同一世界茶铺，可以据此尝试向店员点茶。", anchors: [{ eventId: late.id, quote: "店员给你递了一杯热茶" }] } },
    ] }), toolCalls: [] };
  } });
  runtime.tick(undefined, true); await runtime.settled();
  assert.equal(calls, 1);
  const status = await reloaded.reviewStatus();
  assert.equal(status.recent[0]?.rejected?.length, 1);
  assert.match(status.recent[0]!.rejected![0]!.reason, /自动成长不记录临时处境/);
  await assert.rejects(reloaded.reflect({ kind: "state", subject: "当前茶铺", statement: "我还在茶铺里。", situation: "茶铺内", evidenceIds: [late.id] }, NOW), /先前世界的历史回执不证明当前处境/);
  assert.deepEqual((await reloaded.recall({ at: NOW })).map(view => view.kind), ["relationship"], "historical experiences remain valid evidence without restoring their old physical situation");
  assert.deepEqual(await context.toChatMessages("after historical review"), prefix, "review provenance does not rewrite the actor's frozen prefix");
  assert.match(COMPRESSION_SOURCE_GUIDANCE, /先前世界的操作结果.*不代表当前世界处境/);
  runtime.stop(); await runtime.settled();
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-state-time-"));
  try {
    await staleAndFresh(path.join(base, "guard"));
    await auditedLegacyCorrection(path.join(base, "legacy"));
    await recentHalfHour(path.join(base, "priority"));
    await historicalWorldReceipts(path.join(base, "historical-world"));
    console.log("PASS growth state timing: stale review rejection, evidence-based TU deadlines, partial adoption, append-only legacy correction/outbox/restart, current half-hour priority");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
