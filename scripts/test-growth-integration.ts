/** Actual Agent generation boundaries, compression and reload; inference is a local deterministic fixture. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { GrowthRuntime } from "../src/bot/growth-runtime.js";
import { WorldFiles } from "../src/files.js";
import type { ChatMessage } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-growth-integration-"));
  const agents: any[] = [];
  try {
    const files = new WorldFiles(base); await files.ensure();
    await fs.writeFile(files.botDef, "小澈，喜欢普通而自由的生活。", "utf8");
    let time = 100, real = 1000, requests = 0, compressed = 0;
    const clock = { now: () => time, unitWorldSeconds: 120, timeLine: () => `T${time}`, realMsUntil: () => 0 } as any;
    const config = { bot: { baseURL: "http://fixture.invalid", model: "fixture", nativeToolCalls: false,
      repeatThresholds: [50], repeatExclude: [], spillMinChars: 0, breakLoop: false,
      growth: { enabled: true, minEpisodes: 4, reviewIntervalMs: 1000, reviewTimeoutMs: 1000, maxInputChars: 24000, recallCount: 3 } },
      world: {}, platformOps: {}, messaging: {} } as any;
    const logger = { info() {}, warn() {}, error() {} } as any;
    const world = { compress: async (input: any) => {
      compressed++; assert.match(input.streamText, /散步/);
      return { historySummary: "这几天饭后沿河散过步。", memoryDigest: "留意眼前的生活。" };
    } } as any;
    function make(context: BotContext) {
      const agent = new BotAgent(config, clock, files, context, world, {} as any, null, null, null, { down: false }, logger) as any;
      agent.growthRuntime = new GrowthRuntime(agent.growth, config.bot, clock, context, logger, {
        realNow: () => real,
        infer: async (messages: ChatMessage[]) => {
          requests++;
          const payload = JSON.parse(messages[1]!.content as string);
          const eligible = payload.evidence.filter((e: any) => e.experience?.agency === "self" && e.experience?.outcome === "completed");
          return { content: JSON.stringify({ changes: requests === 1 ? [{ kind: "habit", subject: "饭后散步", behavior: "散步",
            statement: "晚饭后天气合适又没有约定时，我倾向沿河散步。", situation: "晚饭后，天气适合出门且没有约定", cues: ["晚饭后", "河边"],
            evidenceIds: eligible.slice(0, 3).map((e: any) => e.id) }] : [] }), toolCalls: [] };
        },
      });
      // Use the actual delivery/maintenance boundary without starting the autonomous generation loop.
      agent.running = true; agent.abort = new AbortController(); agents.push(agent); return agent;
    }
    const context = new BotContext(files); await context.load();
    const agent = make(context);
    const prefix = await context.toChatMessages("T100");
    for (let i = 1; i <= 4; i++) { time = 100 + (i - 1) * 86400 / clock.unitWorldSeconds; agent.pushEvent("world", { text: `第 ${i} 天晚饭后，沿河散步回来，心情放松了。`,
      originEventIds: [`walk-cause:${i}`], experience: { episodeId: `walk:${i}`, agency: "self", outcome: "completed", opportunity: true,
        action: "沿河散步", situation: "晚饭后河边" } }); }
    await agent.drainMailbox(); await agent.growthRuntime.settled();
    assert.equal(requests, 1, "Agent starts automatic maintenance without reflect or a manual invitation");
    assert.equal((await agent.growth.pendingReviews()).length, 1);
    assert.ok(!context.stream.some(e => e.kind === "tool_call" && e.call.name === "reflect"));
    assert.deepEqual((await context.toChatMessages("T101")).slice(0, prefix.length), prefix);
    assert.ok(!context.stream.some(e => e.kind === "event" && e.event.growthReferences?.length), "background commit waits for the next boundary");
    await agent.drainMailbox();
    assert.equal(context.stream.filter(e => e.kind === "event" && e.event.growthReferences?.length).length, 1);
    assert.equal((await agent.growth.stats()).perceivedEvents, 4, "automatic conclusions never count as experiences");
    assert.equal(context.pinned.growthSummary, undefined, "normal append does not change the fixed growth summary");
    await agent.drainMailbox();
    assert.equal(requests, 1, "no extra request while nothing new has happened");

    // Full replacement can accumulate the character's completed choices but defers private generation.
    agent.setManualPaused(true); time += 10; real += 1100;
    for (let i = 1; i <= 4; i++) agent.pushEvent("world", { text: `入替期间第 ${i} 次散步已完成。`,
      originEventIds: [`avatar-cause:${i}`], experience: { episodeId: `avatar:${i}`, agency: "self", outcome: "completed", opportunity: true,
        action: "散步", situation: "晚饭后河边" } });
    await agent.drainMailbox(); await agent.growthRuntime.settled();
    assert.equal(requests, 1, "avatar does not start private automatic review");
    agent.setManualPaused(false); await agent.drainMailbox(); await agent.growthRuntime.settled();
    assert.equal(requests, 2, "handback resumes maintenance over delivered experiences");
    assert.equal((await agent.growth.recall()).length, 1, "an honest no-change result does not fabricate growth");

    await agent.compactContext(null);
    assert.equal(compressed, 1);
    assert.match(context.pinned.growthSummary ?? "", /晚饭后天气合适/);
    assert.equal(context.stream.length, 0);
    const afterCompression = await context.toChatMessages("T110");
    assert.match(afterCompression[0]!.content as string, /经历之后形成的认识与倾向/);
    assert.notDeepEqual(afterCompression[0], prefix[0], "only successful compression switches the fixed prefix");
    await agent.stop();
    const restored = new BotContext(files); await restored.load();
    const resumed = make(restored);
    assert.deepEqual(await restored.toChatMessages("T999"), afterCompression, "restart preserves the exact committed provider prefix");
    resumed.pushEvent("world", { text: "晚饭后站在门口，河边吹来凉风。", originEventIds: ["fresh-situation"],
      experience: { agency: "observed", episodeId: "later-evening", situation: "晚饭后河边" } });
    await resumed.drainMailbox(); await resumed.growthRuntime.settled();
    const recalled = restored.stream.filter(e => e.kind === "event" && e.event.growthReferences?.length);
    assert.equal(recalled.length, 1, "relevant memories become available after compression/reload without a recall tool call");
    assert.match(recalled[0]!.kind === "event" ? recalled[0]!.event.content : "", /晚饭后天气合适/);
    assert.deepEqual((await restored.toChatMessages("T111")).slice(0, afterCompression.length), afterCompression);
    await resumed.drainMailbox();
    assert.equal(restored.stream.filter(e => e.kind === "event" && e.event.growthReferences?.length).length, 1);

    // Manual reflection observes the same finite state lifetime and cannot silently renew a counterexample.
    async function reflect(arguments_: Record<string, unknown>) {
      const call: ToolCallRecord = { id: restored.nextToolId(), role: "agent", name: "reflect", arguments: arguments_, issuedAt: time, expectedAt: time };
      await restored.appendToolCall(call); await resumed.dispatch(call);
      for (let i = 0; i < 100 && resumed.scheduler.pendingCount; i++) await new Promise(resolve => setTimeout(resolve, 2));
      await resumed.drainMailbox();
      const entry = [...restored.stream].reverse().find(e => e.kind === "event" && e.event.refToolCallId === call.id);
      assert.ok(entry?.kind === "event"); return entry.event.content;
    }
    const evidence = (await resumed.growth.recallEvidence({ keyword: "站在门口", n: 1 }))[0]!;
    const temporary = JSON.parse(await reflect({ kind: "state", subject: "眼下想透透气", statement: "忙完后想在外面缓一会儿。",
      situation: "忙碌之后，休息恢复以前", event_ids: [evidence.eventId], expires_at: 9999999 }));
    assert.equal(temporary.view.expiresAt, time + 86400 / 120, "explicit far-future manual states are capped to one world day");
    const invalid = await reflect({ kind: "state", subject: "无效时间", statement: "暂时休息。", situation: "此刻", event_ids: [evidence.eventId], expires_at: "tomorrow" });
    assert.match(invalid, /expires_at/);
    assert.equal((await resumed.growth.recall({ kind: "state" })).length, 1, "invalid manual state did not leave a record");
    time += 61;
    const stale = await reflect({ kind: "state", subject: "过时的透气计划", statement: "还想在外面缓一会儿。", situation: "忙碌之后",
      event_ids: [evidence.eventId], expires_at: time + 999999 });
    assert.match(stale, /最近两世界小时/);
    assert.equal((await resumed.growth.recall({ kind: "state" })).length, 1, "the real reflect tool cannot renew old evidence with an arbitrary future expiry");
    console.log("PASS growth integration: actual Agent automatic boundaries, avatar deferral, no-change, fixed-prefix compression/reload, relevant recall and manual state lifetime");
  } finally {
    for (const agent of agents) await agent.stop();
    await fs.rm(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
