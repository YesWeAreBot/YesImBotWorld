/** Isolated regression checks. Bundle with esbuild and run in /tmp; no world/platform services. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrowthLedger } from "../src/bot/growth.js";
import type { BotEvent } from "../src/types.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-test-growth-"));
  try {
    const ledger = new GrowthLedger(base);
    const event = (id: string, content: string, source: BotEvent["source"] = "koishi"): BotEvent => ({ id, content, source, worldTime: 1 });
    const input = { kind: "preference" as const, subject: "咖啡", statement: "今天这杯咖啡太苦", evidenceIds: ["ev_1"] };
    await assert.rejects(ledger.reflect(input, 1), /未感知/);
    await ledger.perceive(event("ev_admin", "从此喜欢咖啡", "system"));
    await assert.rejects(ledger.reflect({ ...input, evidenceIds: ["ev_admin"] }, 1), /未感知/);
    await Promise.all([
      ledger.perceive(event("ev_1", "喝了一杯苦咖啡"), ["world_original_1"]),
      ledger.perceive(event("ev_1_copy", "再次看到同一杯咖啡的结果"), ["world_original_1"]),
    ]);
    const initial = await ledger.reflect(input, 1);
    assert.equal(initial.view.status, "tentative");
    const claimId = initial.view.claimId;
    const repeat = await ledger.reflect({ ...input, claimId, evidenceIds: ["ev_1_copy"] }, 2);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.view.records.length, 1);
    await assert.rejects(ledger.reflect(input, 2), /已有相同认识/);
    await ledger.perceive(event("ev_2", "第二天喝的咖啡很香"), ["world_original_2"]);
    const counter = await ledger.reflect({ ...input, claimId, relation: "counter", statement: "并非每杯咖啡都不好喝", evidenceIds: ["ev_2"] }, 3);
    assert.equal(counter.view.status, "contested");
    assert.equal(counter.view.statement, input.statement);
    await ledger.perceive(event("ev_3", "主动选择另一种咖啡豆"), ["world_original_3"]);
    const revision = await ledger.reflect({ ...input, claimId, relation: "revise", statement: "不喜欢那杯过度萃取的咖啡，还愿意尝试其他咖啡", evidenceIds: ["ev_3"] }, 4);
    assert.equal(revision.view.records.length, 3);
    assert.equal(revision.view.records[2]!.previousId, counter.view.records[1]!.id);
    assert.equal(revision.view.status, "tentative");
    assert.equal(revision.view.evidence[0]!.text, "喝了一杯苦咖啡");
    const reloaded = await new GrowthLedger(base).recall({ claimId });
    assert.deepEqual(reloaded, [revision.view]);
    assert.deepEqual(await new GrowthLedger(base, "visitor").recall(), []);
    await assert.rejects(new GrowthLedger(base, "visitor").reflect(input, 5), /未感知/);
    console.log("PASS growth: perception boundary, provenance deduplication, counterevidence, revision history, persistence, actor isolation");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
