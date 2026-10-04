/** Real growth runtime, local journals and mock inference: no model, browser or live instance. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger, type GrowthRecord, type PerceivedEvidence, type ReflectionInput } from "../src/bot/growth.js";
import { GrowthRuntime, type GrowthMemoryEvent } from "../src/bot/growth-runtime.js";
import type { GrowthInsight } from "../src/bot/growth-semantics.js";
import type { BotModelConfig } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent } from "../src/types.js";

const dirs: string[] = [], runtimes: GrowthRuntime[] = [];
const insight = (eventId: string, quote: string, dimension = "放松时的饮品选择"): GrowthInsight => ({ dimension,
  significance: "这段真实经历为以后类似情境下的选择提供有限依据，仍需根据当时情况判断。", anchors: [{ eventId, quote }] });
const physical = (id: string, text: string, action = "在清茶和咖啡之间选择清茶"): PerceivedEvidence => ({
  eventId: id, actorId: "bot", source: "world", observedAt: 10, text, rootEventIds: ["root:" + id],
  experience: { agency: "self", outcome: "completed", opportunity: true, episodeId: "episode:" + id,
    action, situation: "晚饭后放松", worldPerception: true },
});
const legacy = (id: string, kind: GrowthRecord["kind"], source: PerceivedEvidence, statement: string): GrowthRecord => ({
  id, claimId: id, actorId: "bot", kind, subject: "旧认识" + id, statement, evidenceIds: [source.eventId], rootEventIds: source.rootEventIds,
  recordedAt: 11, relation: "support", origin: "automatic", scope: { domain: "physical" }, groundingVersion: 1,
});
function botEvent(evidence: PerceivedEvidence): BotEvent {
  return { id: evidence.eventId, source: evidence.source, worldTime: evidence.observedAt, content: evidence.text,
    originEventIds: evidence.rootEventIds, experience: evidence.experience };
}

async function fixture(evidence: PerceivedEvidence[], records: GrowthRecord[] = [], extra: Record<string, unknown> = {}, extraLines: unknown[] = []) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-growth-insight-runtime-")); dirs.push(base);
  const files = new WorldFiles(base); await files.ensure();
  await fs.writeFile(files.botDef, "小澈生活在河边的小镇，愿意根据真实经历逐渐了解自己与朋友。", "utf8");
  const context = new BotContext(files); await context.load();
  for (const item of evidence) await context.appendEvent(botEvent(item));
  const ledger = new GrowthLedger(base);
  const original = [...evidence.map(item => ({ type: "perceived", evidence: item })),
    ...records.map(record => ({ type: "reflection", record })), ...extraLines].map(line => JSON.stringify(line)).join("\n") + "\n";
  await fs.writeFile(ledger.file, original);
  const cfg = { baseURL: "http://growth-fixture.invalid", apiKey: "", model: "fixture", stream: false,
    growth: { enabled: true, minEpisodes: 1, reviewIntervalMs: 1, reviewTimeoutMs: 5000,
      maxInputChars: 24000, recallCount: 3, ...extra } } as BotModelConfig;
  const requests: any[] = [], warnings: string[] = [];
  let reply = (_payload: any): unknown[] => [], at = 20, realAt = 100;
  const clock = { now: () => at, unitWorldSeconds: 1 };
  const logger = { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); } };
  const make = (source = ledger, ctx = context) => {
    const runtime = new GrowthRuntime(source, cfg, clock, ctx, logger, { realNow: () => realAt, infer: async messages => {
      const payload = JSON.parse(messages[1]!.content as string); requests.push(payload);
      assert.ok(messages.reduce((sum, message) => sum + String(message.content).length, 0) <= cfg.growth!.maxInputChars!);
      return { content: JSON.stringify({ changes: reply(payload) }), toolCalls: [] };
    } });
    runtimes.push(runtime); return runtime;
  };
  const runtime = make();
  return { base, files, context, ledger, cfg, runtime, requests, warnings, original, make,
    response: (next: typeof reply) => { reply = next; },
    tick: async () => { at++; realAt += 10; runtime.tick(); await runtime.settled(); },
    advance: () => { at++; realAt += 10; },
  };
}

async function truncatedAnchorsCannotReadHiddenOriginals() {
  const visible = "你在咖啡与清茶之间选择了清茶，觉得清茶更适合放松。";
  const hidden = "你明确表示今后独处放松时更偏爱清茶。";
  const body = physical("long-body", visible + "沿河路面平坦，晚风吹过树梢。".repeat(4000) + hidden);
  const f = await fixture([body], [], { maxInputChars: 10000 });
  f.response(payload => {
    const shown = payload.evidence.find((item: any) => item.id === body.eventId);
    assert.ok(shown.text.includes(visible)); assert.ok(!shown.text.includes(hidden)); assert.match(shown.text, /截断/);
    return [
      { kind: "preference", subject: "偷读未展示正文", statement: "清茶是独处时明确表达的偏好。", evidenceIds: [body.eventId], insight: insight(body.eventId, hidden, "未展示原文") },
      { kind: "preference", subject: "放松时喝清茶", statement: "清茶可以作为放松时的候选，仍需随情境调整。", evidenceIds: [body.eventId], insight: insight(body.eventId, visible) },
    ];
  });
  await f.tick();
  const status = await f.ledger.reviewStatus();
  assert.equal(status.recent[0]!.records.length, 1); assert.equal(status.recent[0]!.rejected?.length, 1);
  assert.match(status.recent[0]!.rejected![0]!.reason, /实际展示.*截断/);
  assert.equal((await f.ledger.recallEvidence({ eventIds: [body.eventId] }))[0]!.text, body.text,
    "request compaction must not alter the auditable original");

  // A successful send carries the self-authored body in action, not its receipt.
  const ownQuote = "我更喜欢清茶，不喜欢咖啡。";
  const sent = physical("long-action", "消息已发送。", "向 群聊 发送了消息：" + "今天沿着河边走了很远。".repeat(50) + ownQuote);
  sent.source = "tool"; sent.experience!.worldPerception = false;
  sent.experience!.chat = { kind: "send", channelKey: "group:test", senderId: "self", senderOwn: true };
  const actionFixture = await fixture([sent]);
  actionFixture.response(payload => {
    assert.ok(!payload.evidence[0].experience.action.includes(ownQuote));
    assert.match(payload.evidence[0].experience.action, /截断/);
    return [{ kind: "preference", subject: "未展示的本人偏好", statement: "我更爱清茶。", evidenceIds: [sent.eventId], insight: insight(sent.eventId, ownQuote) }];
  });
  await actionFixture.tick();
  assert.match((await actionFixture.ledger.reviewStatus()).recent[0]!.rejected![0]!.reason, /实际展示.*截断/);

  const peerQuote = "下次调试卡住可以来找我，我们一起看日志。";
  const peer = physical("long-message", "已交付的群聊快照", "阅读已交付消息");
  peer.source = "koishi"; peer.rootEventIds = ["chat-message:long-message"];
  peer.experience = { agency: "observed", outcome: "completed", opportunity: false, episodeId: "chat-episode:long-message",
    subjectIds: ["peer"], chat: { kind: "attention", channelKey: "group:test" } };
  peer.messages = [{ text: "我们刚刚检查了一部分日志。".repeat(4000) + peerQuote,
    rootEventIds: peer.rootEventIds, chat: { kind: "message", channelKey: "group:test", senderId: "peer", senderOwn: false } }];
  const messageFixture = await fixture([peer], [], { maxInputChars: 10000 });
  messageFixture.response(payload => {
    assert.ok(!payload.evidence[0].messages[0].text.includes(peerQuote));
    assert.match(payload.evidence[0].messages[0].text, /截断/);
    return [{ kind: "relationship", subject: "技术朋友", subjectId: payload.evidence[0].messages[0].chat.senderId, statement: "遇到调试问题可以向对方求助。",
      evidenceIds: [peer.eventId], insight: insight(peer.eventId, peerQuote, "技术求助的信任") }];
  });
  await messageFixture.tick();
  assert.match((await messageFixture.ledger.reviewStatus()).recent[0]!.rejected![0]!.reason, /实际展示.*截断/);

  // Visibility must preserve speaker ownership: identical visible words from B
  // cannot reveal the hidden tail of A's actual message in the same snapshot.
  const mixed = structuredClone(peer); mixed.eventId = "mixed-visible-senders";
  mixed.rootEventIds = ["chat-message:mixed-a", "chat-message:mixed-b"];
  mixed.experience!.episodeId = "chat-episode:mixed-visible-senders";
  mixed.experience!.subjectIds = ["peer", "other-peer"];
  mixed.messages![0]!.rootEventIds = [mixed.rootEventIds[0]!];
  mixed.messages!.push({ text: peerQuote, rootEventIds: [mixed.rootEventIds[1]!],
    chat: { kind: "message", channelKey: "group:test", senderId: "other-peer", senderOwn: false } });
  const mixedFixture = await fixture([mixed], [], { maxInputChars: 10000 });
  mixedFixture.response(payload => {
    const messages = payload.evidence[0].messages;
    const [target, other] = messages;
    assert.notEqual(target.chat.senderId, other.chat.senderId);
    assert.ok(!target.text.includes(peerQuote));
    assert.equal(other.text, peerQuote);
    return [{ kind: "relationship", subject: "被截断的朋友", subjectId: target.chat.senderId, statement: "遇到调试问题可以向对方求助。",
      evidenceIds: [mixed.eventId], insight: insight(mixed.eventId, peerQuote, "技术求助的信任") }];
  });
  await mixedFixture.tick();
  const mixedReview = (await mixedFixture.ledger.reviewStatus()).recent[0]!;
  assert.equal(mixedReview.records.length, 0, "another visible sender's identical words must not validate a hidden target-sender quote");
  assert.equal(mixedReview.rejected!.length, 1);
}

async function revalidationDeliveryAndRecovery() {
  const source = physical("old-help", "修理工耐心解释了接线原理，并表示下次遇到问题可以再来找他。", "向修理工询问接线原理");
  const nonPromise = physical("old-quiz", "你浏览了网页上的偏好问卷，尚未选择任何选项。", "打开网页问卷");
  const relationship = legacy("old-relationship", "relationship", source, "修理工会随时主动替我处理一切问题。");
  const commitment = legacy("old-commitment", "commitment", nonPromise, "我已经答应完成问卷里的全部项目。");
  const f = await fixture([source, nonPromise], [relationship, commitment], { minEpisodes: 100 });
  const oldMemory: BotEvent = { id: "previous-memory", source: "system", originEventIds: [], worldTime: 12,
    content: `以前回顾：${relationship.statement}\n${commitment.statement}` };
  await f.context.appendEvent(oldMemory);
  const before = structuredClone(f.context.stream), pinned = structuredClone(f.context.pinned);
  const revised = "遇到接线问题时可以尝试向修理工求助，这次帮助不代表他随时有空。";
  f.response(payload => {
    assert.equal(payload.review.mode, "legacy_revalidation");
    assert.deepEqual(new Set(payload.existing.map((item: any) => item.claimId)), new Set([relationship.claimId, commitment.claimId]));
    assert.ok(payload.existing.every((item: any) => item.needsReview));
    return [
      { kind: "relationship", subject: relationship.subject, claimId: relationship.claimId, relation: "revise", statement: revised,
        evidenceIds: [source.eventId], insight: insight(source.eventId, source.text, "接线问题的求助边界") },
      { kind: "commitment", subject: commitment.subject, claimId: commitment.claimId, relation: "retire",
        statement: "原文只有浏览问卷，没有实际承诺；停止沿用必须完成问卷项目的判断。", evidenceIds: [nonPromise.eventId] },
    ];
  });
  await f.tick();
  assert.equal(f.requests.length, 1);
  const review = (await f.ledger.reviewStatus()).recent[0]!;
  assert.equal(review.records.length, 2, JSON.stringify(review.rejected));
  assert.ok(review.records.every(record => record.rootEventIds.length === 0), "old-source revalidation is not a new lived episode");
  const delivered = await f.runtime.drain();
  const memory = delivered.find(event => event.id === "ev_growth_" + review.id)!;
  assert.ok(memory, "revision and retirement are appended for the acting model");
  assert.match(memory.content, /已停止沿用.*承诺/);
  assert.match(memory.content, /不再指导行为/);
  assert.ok(memory.content.includes(revised));
  const appended = f.context.stream.slice(before.length).filter(entry => entry.kind === "event").map(entry => entry.event);
  const revisionPosition = appended.findIndex(event => event.id === memory.id);
  const isolationPositions = appended.flatMap((event, index) => event.id.startsWith("ev_growth_isolation_") && event.content.includes(relationship.claimId) ? [index] : []);
  assert.ok(isolationPositions.every(index => index < revisionPosition),
    "the last delivered meaning must be the successful revision, never an older queued isolation");
  assert.deepEqual(f.context.stream.slice(0, before.length), before, "corrections append without changing old context/KV-cache prefix");
  assert.deepEqual(f.context.pinned, pinned, "delivery must not rewrite the pinned instructions");
  assert.equal((memory as GrowthMemoryEvent).growthReferences!.length, 2);
  assert.deepEqual(await f.runtime.drain(), []);
  assert.ok((await fs.readFile(f.ledger.file, "utf8")).startsWith(f.original));
  assert.ok(await f.ledger.summary(25)); assert.doesNotMatch(await f.ledger.summary(25), /全部项目/);

  const restoredContext = new BotContext(f.files); await restoredContext.load();
  const restoredLedger = new GrowthLedger(f.base), restoredRuntime = f.make(restoredLedger, restoredContext);
  const length = restoredContext.stream.length;
  assert.deepEqual(await restoredRuntime.drain(), []);
  f.advance(); restoredRuntime.tick(); await restoredRuntime.settled();
  assert.equal(f.requests.length, 1, "finished audits are not re-inferred after restart even with their original evidence still present");
  assert.equal(restoredContext.stream.length, length);
  assert.equal(await restoredLedger.snapshotReview({ at: 30, minimumEpisodes: 100 }), null);
}

async function admittedInsightsRemainRevisableAndDeliveryRetries() {
  const original = physical("new-help", "修理工表示，下次接线遇到问题可以来找他。", "向修理工询问接线原理");
  const f = await fixture([original]);
  f.response(() => [{ kind: "relationship", subject: "修理工", statement: "接线遇到问题时可以尝试向修理工求助。",
    evidenceIds: [original.eventId], insight: insight(original.eventId, original.text, "技术求助的信任") }]);
  await f.tick(); await f.runtime.drain();
  const established = (await f.ledger.recall())[0]!;
  assert.equal(established.records[0]!.semanticVersion, 1); assert.equal(established.status, "tentative");
  const later = physical("help-withdrawn", "修理工明确说自己要离开小镇，以后不能再帮你接线了。", "询问修理工今后的打算");
  later.observedAt = 21;
  await f.context.appendEvent(botEvent(later)); await f.ledger.perceive(botEvent(later));
  f.response(payload => {
    const current = payload.existing.find((item: any) => item.claimId === established.claimId);
    assert.equal(current.status, "tentative"); assert.ok(!current.needsReview);
    return [
      { kind: "relationship", subject: established.subject, claimId: established.claimId, relation: "revise",
        statement: "我现在认为他仍会永远帮助我。", evidenceIds: [later.eventId] },
      { kind: "relationship", subject: established.subject, claimId: established.claimId, relation: "retire",
        statement: "修理工将离开小镇，原先可以向他求助的安排停止沿用。", evidenceIds: [later.eventId] },
    ];
  });
  await f.tick();
  const status = await f.ledger.reviewStatus();
  assert.equal(f.requests.length, 2, f.warnings.join("\n"));
  assert.equal(status.lastOutcome, "completed", f.warnings.join("\n"));
  const review = status.recent[0]!;
  assert.equal(review.records.length, 1); assert.equal(review.records[0]!.relation, "retire");
  assert.match(review.rejected![0]!.reason, /insight/, "admission version cannot exempt a later assertion from grounding");

  const before = structuredClone(f.context.stream), acknowledge = f.ledger.ackReview.bind(f.ledger);
  f.ledger.ackReview = async () => { throw Error("simulated acknowledgement failure after context write"); };
  await assert.rejects(f.runtime.drain(), /simulated acknowledgement failure/);
  const appended = f.context.stream.filter(entry => entry.kind === "event" && entry.event.id === "ev_growth_" + review.id);
  assert.equal(appended.length, 1); assert.match(appended[0]!.kind === "event" ? appended[0].event.content : "", /已停止沿用/);
  f.ledger.ackReview = acknowledge;
  const restoredContext = new BotContext(f.files); await restoredContext.load();
  const restoredLedger = new GrowthLedger(f.base), restoredRuntime = f.make(restoredLedger, restoredContext);
  assert.deepEqual(await restoredRuntime.drain(), [], "a journaled correction is acknowledged on recovery, not appended twice");
  assert.equal(restoredContext.stream.filter(entry => entry.kind === "event" && entry.event.id === "ev_growth_" + review.id).length, 1);
  assert.deepEqual(restoredContext.stream.slice(0, before.length), before);
  assert.equal((await restoredLedger.pendingReviews()).length, 0);
  assert.equal(await restoredLedger.summary(30), "");
}

async function multipleIsolationBatchesNeverOverrideNewReviews() {
  const sources = Array.from({ length: 9 }, (_, index) => physical("batched-source-" + index,
    `邻居${index}耐心解释了接线原理，并表示下次遇到问题可以再来找他。`, "向邻居询问接线原理"));
  const records = sources.map((source, index) => ({ ...legacy("batched-claim-" + index, "relationship", source, `邻居${index}会随时替我处理所有事情。`), subject: `邻居${index}` }));
  const f = await fixture(sources, records, { minEpisodes: 100 });
  f.response(payload => payload.review.revalidation.map((target: any) => {
    const record = records.find(item => item.claimId === target.claimId)!;
    const source = sources.find(item => item.eventId === record.evidenceIds[0])!;
    return { kind: record.kind, subject: record.subject, claimId: record.claimId, relation: "revise",
      statement: `${record.subject}可在接线问题上尝试求助，但不代表随时有空。`, evidenceIds: [source.eventId],
      insight: insight(source.eventId, source.text, "接线求助的具体边界") };
  }));
  // Maintenance may finish several reviews while the acting loop is suspended.
  for (let index = 0; index < 5; index++) await f.tick();
  assert.equal(f.requests.length, 5);
  assert.equal((await f.ledger.pendingIsolations(8)).length, 2);
  await f.runtime.drain();
  assert.equal((await f.ledger.pendingIsolations(8)).length, 1);
  assert.deepEqual(await f.runtime.remember([botEvent(sources.at(-1)!)]), [], "automatic recall waits for older pending isolation batches too");
  for (let index = 0; index < 12; index++) if (!(await f.runtime.drain()).length) break;
  const events = f.context.stream.flatMap(entry => entry.kind === "event" ? [entry.event] : []);
  for (const record of records) {
    const isolation = events.findIndex(event => event.id.startsWith("ev_growth_isolation_") && event.content.includes(record.claimId));
    const revision = events.findIndex(event => (event as GrowthMemoryEvent).growthReferences?.some(item => item.claimId === record.claimId));
    assert.ok(isolation >= 0 && revision >= 0, "both the old restriction and its resolution must be accounted for");
    assert.ok(events[isolation]!.content.includes(record.id));
    assert.match(events[isolation]!.content, /新修订不受影响/);
    assert.ok(isolation < revision, `later isolation batches must not override the corrected understanding of ${record.claimId}`);
  }
}

async function oldAutomaticStatesAreNotRedelivered() {
  const source = physical("old-state-source", "散步回来暂时有些累，坐了一会儿。", "在河边散步后坐下");
  const state: GrowthRecord = { ...legacy("old-state", "state", source, "刚散步回来暂时有些累。"), situation: "散步后休息以前",
    expiresAt: 100, stateTiming: { evidenceAt: source.observedAt, secondsPerTU: 1, requestedExpiresAt: 100 } };
  const review = { type: "review_committed", actorId: "bot", id: "old-state-review", afterCursor: 0, throughCursor: 1,
    at: 11, records: [state], sampledEventIds: [source.eventId], relatedEventIds: [], omittedEvidenceCount: 0 };
  const f = await fixture([source], [], { minEpisodes: 100 }, [review]);
  const before = structuredClone(f.context.stream);
  assert.equal((await f.ledger.pendingReviews()).length, 1);
  assert.deepEqual(await f.runtime.drain(), []);
  assert.deepEqual(f.context.stream, before, "pending old automatic states must not generate new attention/body guidance");
  assert.equal((await f.ledger.pendingReviews()).length, 0, "suppressed pending deliveries are acknowledged rather than retried forever");
  assert.equal(await f.ledger.summary(20), "");
  assert.deepEqual(await f.ledger.retrieve({ text: state.statement, at: 20 }), []);
  assert.equal((await f.ledger.recall({ kind: "state", at: 20 }))[0]!.active, true, "raw historical and manual access remain intact");
}

async function main() {
  const watchdog = setTimeout(() => { console.error("growth insight runtime fixture timed out"); process.exit(1); }, 30000);
  try {
    await truncatedAnchorsCannotReadHiddenOriginals();
    await revalidationDeliveryAndRecovery();
    await admittedInsightsRemainRevisableAndDeliveryRetries();
    await multipleIsolationBatchesNeverOverrideNewReviews();
    await oldAutomaticStatesAreNotRedelivered();
    console.log("PASS growth insight runtime: visible-only literal anchors, legacy revision/retirement delivery order, append-only recoverable corrections, tentative insights and no automatic state replay");
  } finally {
    for (const runtime of runtimes) runtime.stop();
    await Promise.all(runtimes.map(runtime => runtime.settled()));
    await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
    clearTimeout(watchdog);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
