/** Full Bot delivery -> evidence discovery -> reflection -> compression/restart, with no model or world service. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { WorldFiles } from "../src/files.js";
import type { ToolCallRecord } from "../src/types.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-growth-runtime-"));
  try {
    const files = new WorldFiles(base); await files.ensure();
    const context = new BotContext(files); await context.load();
    const config = { bot: { baseURL: "http://invalid", model: "fake", nativeToolCalls: false, repeatThresholds: [50], repeatExclude: [], minIntervalMs: 1, spillMinChars: 0, breakLoop: false }, world: {}, platformOps: {} } as any;
    const clock = { now: () => 42, timeLine: () => "T42", realMsUntil: () => 0 } as any;
    const logger = { info() {}, warn() {}, error() {} } as any;
    const tools = BOT_TOOLS.filter(tool => ["reflect", "recall_growth"].includes(tool.name));
    const make = (ctx: BotContext) => new BotAgent(config, clock, files, ctx, {} as any, {} as any, null, null, null, { down: false }, logger, tools) as any;
    const agent = make(context);
    const prefix = context.renderSystemText("T42");
    for (let i = 1; i <= 24; i++) agent.pushEvent("world", `朋友来访，第 ${i} 次一起练琴`, { originEventIds: [`chat_${i}`] });
    await agent.drainMailbox();
    const cue = context.stream.find(entry => entry.kind === "event" && entry.event.content.includes("亲历整理提示"));
    assert.ok(cue?.kind === "event");
    assert.match(cue.event.content, /ev_24/);
    assert.match(cue.event.content, /没有值得记录的变化/);
    assert.equal(context.renderSystemText("T42"), prefix, "reflection cue must append to history without changing the pinned prefix");
    assert.deepEqual(await agent.growth.recall(), [], "experience alone does not generate beliefs");
    assert.equal((await agent.growth.recallEvidence({ n: 50 })).length, 24, "system cue cannot count as experience");
    const cueCount = context.stream.length;
    await agent.drainMailbox();
    assert.equal(context.stream.length, cueCount, "no repeated cue without new experience");

    async function invoke(target: any, ctx: BotContext, name: string, args: Record<string, unknown>) {
      const call: ToolCallRecord = { id: ctx.nextToolId(), role: "agent", name, arguments: args, issuedAt: 42, expectedAt: 42 };
      await ctx.appendToolCall(call);
      await target.dispatch(call);
      for (let i = 0; i < 100 && target.scheduler.pendingCount; i++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(target.scheduler.pendingCount, 0);
      await target.drainMailbox();
      const receipt = [...ctx.stream].reverse().find(entry => entry.kind === "event" && entry.event.refToolCallId === call.id);
      assert.ok(receipt?.kind === "event");
      return JSON.parse(receipt.event.content);
    }
    const evidenceResponse = await invoke(agent, context, "recall_growth", { scope: "evidence", event_ids: ["ev_24"] });
    assert.equal(evidenceResponse.evidence.length, 1);
    assert.equal(evidenceResponse.evidence[0].eventId, "ev_24");
    assert.match(evidenceResponse.evidence[0].text, /第 24 次/);
    const reflected = await invoke(agent, context, "reflect", { kind: "relationship", subject: "朋友", statement: "我们一起练过琴", event_ids: ["ev_24"], insight: { dimension: "共同练琴的陪伴", significance: "练琴时可以邀请这位朋友一起参与，相处中有共同的活动基础。", anchors: [{ eventId: "ev_24", quote: "朋友来访，第 24 次一起练琴" }] } });
    assert.equal(reflected.view.status, "tentative");
    assert.equal((await agent.growth.recallEvidence({ n: 50 })).length, 24, "recall and reflection output are derived, never fresh evidence");

    await context.applyCompression({ historySummary: "我们一起练过琴", memoryDigest: `已有认识 ${reflected.view.claimId}` }, 43, await context.compressionSnapshot());
    const resumedContext = new BotContext(files); await resumedContext.load();
    const resumedAgent = make(resumedContext);
    await resumedAgent.drainMailbox();
    assert.equal(resumedContext.stream.length, 0, "restart after compression must not repeat the same cue");
    const response = await invoke(resumedAgent, resumedContext, "recall_growth", { scope: "all", event_ids: ["ev_24"] });
    assert.equal(response.claims[0].claimId, reflected.view.claimId);
    assert.equal(response.evidence[0].eventId, "ev_24", "compressed event IDs remain discoverable");
    const older = await invoke(resumedAgent, resumedContext, "reflect", { kind: "relationship", subject: "朋友", statement: "我们一起练过琴", claim_id: reflected.view.claimId, event_ids: ["ev_23"], insight: { dimension: "共同练琴的陪伴", significance: "这次更早的亲历也支持我们有共同练琴的相处基础。", anchors: [{ eventId: "ev_23", quote: "朋友来访，第 23 次一起练琴" }] } });
    assert.equal(older.view.records.length, 2, "original compressed experience may still support an existing claim");
    assert.equal((await resumedAgent.growth.recallEvidence({ n: 50 })).length, 24);

    // A transient ledger write failure is repaired from delivered context before the next boundary.
    const perceive = resumedAgent.growth.perceive.bind(resumedAgent.growth);
    resumedAgent.growth.perceive = async () => { throw new Error("simulated evidence write failure"); };
    resumedAgent.pushEvent("koishi", "下次一起练琴", { originEventIds: ["chat_after_restart"] });
    await assert.rejects(resumedAgent.drainMailbox(), /simulated evidence write failure/);
    assert.equal((await resumedAgent.growth.recallEvidence({ n: 50 })).length, 24);
    resumedAgent.growth.perceive = perceive;
    await resumedAgent.drainMailbox();
    assert.equal((await resumedAgent.growth.recallEvidence({ n: 50 })).length, 25);
    console.log("PASS growth runtime: discoverable evidence, deliberate reflection, append-only cue, no synthetic evidence, compression/restart continuity");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
