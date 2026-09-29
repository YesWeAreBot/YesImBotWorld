/** Isolated regression checks. Bundle with esbuild and run in /tmp; no world/platform services. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrowthLedger } from "../src/bot/growth.js";
import type { BotEvent, StreamEntry } from "../src/types.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-test-growth-"));
  try {
    const ledger = new GrowthLedger(base);
    const event = (id: string, content: string, source: BotEvent["source"] = "koishi"): BotEvent => ({ id, content, source, worldTime: 1 });
    const insight = (eventId: string, quote: string) => ({ dimension: "咖啡口味", significance: "以后选咖啡先分辨萃取和豆种，不把一杯的体验泛化。", anchors: [{ eventId, quote }] });
    const choice = (action: string) => ({ agency: "self" as const, outcome: "completed" as const, opportunity: true, action, episodeId: action });
    const input = { kind: "preference" as const, subject: "咖啡", statement: "不喜欢这杯过度萃取咖啡的苦味", evidenceIds: ["ev_1"], insight: insight("ev_1", "喝了一杯苦咖啡") };
    await assert.rejects(ledger.reflect(input, 1), /未感知/);
    await ledger.perceive(event("ev_admin", "从此喜欢咖啡", "system"));
    await assert.rejects(ledger.reflect({ ...input, evidenceIds: ["ev_admin"] }, 1), /未感知/);
    await Promise.all([
      ledger.perceive(event("ev_1", "喝了一杯苦咖啡", "world"), ["world_original_1"], choice("品尝咖啡")),
      ledger.perceive(event("ev_1_copy", "再次看到同一杯咖啡的结果", "world"), ["world_original_1"], choice("品尝咖啡")),
    ]);
    const initial = await ledger.reflect(input, 1);
    assert.equal(initial.view.status, "tentative");
    const claimId = initial.view.claimId;
    const repeat = await ledger.reflect({ ...input, claimId, evidenceIds: ["ev_1_copy"], insight: insight("ev_1_copy", "同一杯咖啡") }, 2);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.view.records.length, 1);
    await assert.rejects(ledger.reflect(input, 2), /已有相同认识/);
    await ledger.perceive(event("ev_2", "第二天喝的咖啡很香"), ["world_original_2"]);
    const counter = await ledger.reflect({ ...input, claimId, relation: "counter", statement: "并非每杯咖啡都不好喝", evidenceIds: ["ev_2"] }, 3);
    assert.equal(counter.view.status, "contested");
    assert.equal(counter.view.statement, input.statement);
    await ledger.perceive(event("ev_3", "主动选择另一种咖啡豆", "world"), ["world_original_3"], choice("尝试另一种咖啡豆"));
    const revision = await ledger.reflect({ ...input, claimId, relation: "revise", statement: "不喜欢那杯过度萃取的咖啡，还愿意尝试其他咖啡", evidenceIds: ["ev_3"], insight: insight("ev_3", "主动选择另一种咖啡豆") }, 4);
    assert.equal(revision.view.records.length, 3);
    assert.equal(revision.view.records[2]!.previousId, counter.view.records[1]!.id);
    assert.equal(revision.view.status, "tentative");
    assert.equal(revision.view.evidence[0]!.text, "喝了一杯苦咖啡");
    const reloaded = await new GrowthLedger(base).recall({ claimId });
    assert.deepEqual(reloaded, [revision.view]);
    assert.deepEqual(await ledger.stats(), { perceivedEvents: 4, uniqueRoots: 3, claims: 1, records: 3 });
    assert.deepEqual(await new GrowthLedger(base, "visitor").recall(), []);
    await assert.rejects(new GrowthLedger(base, "visitor").reflect(input, 5), /未感知/);

    // Compression can remove every stream entry; original evidence remains queryable and referenceable.
    const stored = await new GrowthLedger(base).recallEvidence({ keyword: "咖啡", n: 50 });
    assert.equal(stored.length, 4);
    assert.deepEqual(stored[0]!.rootEventIds, ["world_original_3"]);
    stored[0]!.text = "tampered client view";
    assert.equal((await ledger.recallEvidence({ eventIds: ["ev_3"] }))[0]!.text, "主动选择另一种咖啡豆");
    assert.deepEqual(await new GrowthLedger(base, "visitor").recallEvidence(), []);

    const recoveredBase = path.join(base, "interrupted");
    const recovered = new GrowthLedger(recoveredBase);
    const delivered: StreamEntry[] = [
      { kind: "event", event: { ...event("ev_delivered", "琴师答应每周带我练琴，愿意讲解卡住的地方。", "world"), originEventIds: ["chat_original"] } },
      { kind: "tool_call", call: { id: "tc_recall", role: "agent", name: "recall_growth", arguments: {}, issuedAt: 1, expectedAt: 1 } },
      { kind: "event", event: { ...event("ev_recall", "重复读到旧认识", "tool"), refToolCallId: "tc_recall" } },
      { kind: "event", event: { ...event("ev_empty_roots", "压缩摘要", "tool"), originEventIds: [] } },
      { kind: "event", event: event("ev_system", "系统要求产生偏好", "system") },
    ];
    await recovered.restorePerceptions(delivered);
    await recovered.restorePerceptions(delivered);
    assert.deepEqual((await recovered.recallEvidence()).map(e => e.eventId), ["ev_delivered"]);
    const repairedReflection = await recovered.reflect({ kind: "relationship", subject: "对话者", statement: "我可以在练琴遇到困难时向琴师求助", evidenceIds: ["ev_delivered"], insight: { dimension: "练琴指导", significance: "有明确的求助邀请，今后遇到难题可以向对方请教。", anchors: [{ eventId: "ev_delivered", quote: "愿意讲解卡住的地方" }] } }, 2);
    assert.deepEqual(repairedReflection.view.records[0]!.rootEventIds, ["chat_original"]);

    const invitations = new GrowthLedger(path.join(base, "invitations"));
    for (let i = 1; i <= 23; i++) await invitations.perceive(event(`ev_${i}`, `亲历 ${i}`), [`origin_${i}`]);
    await invitations.perceive(event("ev_reread", "重复的亲历"), ["origin_23"]);
    assert.equal(await invitations.reflectionOpportunity(), null, "re-reading is not a new experience");
    await invitations.perceive(event("ev_24", "第 24 个不同来源的亲历"), ["origin_24"]);
    const opportunity = await invitations.reflectionOpportunity();
    assert.equal(opportunity?.rootCount, 24);
    assert.equal(opportunity?.eventIds.length, 6);
    assert.equal(opportunity?.eventIds[0], "ev_24");
    assert.ok(!opportunity?.eventIds.includes("ev_23"), "one representative for each original cause");
    assert.deepEqual(await invitations.recall(), [], "an invitation must not manufacture a subjective claim");
    await invitations.markReflectionOffered(opportunity!);
    const resumedInvitations = new GrowthLedger(path.join(base, "invitations"));
    assert.equal(await resumedInvitations.reflectionOpportunity(), null, "restart must not repeat an already delivered invitation");
    for (let i = 25; i <= 48; i++) await resumedInvitations.perceive(event(`ev_${i}`, `亲历 ${i}`), [`origin_${i}`]);
    assert.equal((await resumedInvitations.reflectionOpportunity())?.rootCount, 48);

    // A crash halfway through the last JSONL write must not eat the next complete event.
    const interruptedFile = path.join(base, "broken", "growth.jsonl");
    await fs.mkdir(path.dirname(interruptedFile), { recursive: true });
    await fs.writeFile(interruptedFile, '{"type":"perceived","evidence":');
    await new GrowthLedger(path.dirname(interruptedFile)).perceive(event("ev_after_crash", "重新开始保存的亲历"));
    assert.deepEqual((await new GrowthLedger(path.dirname(interruptedFile)).recallEvidence()).map(e => e.eventId), ["ev_after_crash"]);
    console.log("PASS growth: perception boundary, source deduplication, revision history, persistence, compressed evidence recall, crash recovery, bounded reflection invitations and actor isolation");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
