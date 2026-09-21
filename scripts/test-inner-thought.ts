/** Local character prose must never become a world observation, rewarded action or growth evidence. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger, independentGrowthChoices, type PerceivedEvidence } from "../src/bot/growth.js";
import { stateBasis } from "../src/bot/growth-grounding.js";
import { RegulationRuntime } from "../src/bot/regulation-runtime.js";
import { validateRegulationCandidateCall } from "../src/bot/regulation-model.js";
import { toNativeToolDefs } from "../src/bot/nativeTools.js";
import { BOT_TOOLS, toolLayer } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { BOT_PROMPT_DEFAULTS, WORLD_PROMPT_DEFAULTS, THOUGHT_RUNTIME_GUIDANCE } from "../src/prompts.js";
import type { BotEvent, ParsedToolCall, ToolCallRecord } from "../src/types.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-inner-thought-"));
  try {
    const files = new WorldFiles(base); await files.ensure();
    const context = new BotContext(files); await context.load();
    const cfg = Config({ autoStart: false }); cfg.bot.regulation.enabled = true;
    let time = 10, clockReads = 0;
    const clock = { now: () => { clockReads++; return time; }, unitWorldSeconds: 1 };
    const requests: any[] = [];
    const runtime = new RegulationRuntime(base, cfg.bot, clock, context, { warn() {} }, {
      infer: async messages => {
        const payload = JSON.parse(String(messages[1]!.content)); requests.push(payload);
        return { content: JSON.stringify({ appraisals: [], candidates: [{ id: "proposed", contextKey: "查看实际物品",
          conditionalEffects: {}, probability: 1, cost: 0, risk: 0, explanation: "只预测已经提出的实际行动。" }] }), toolCalls: [] };
      },
    });
    const thought: ParsedToolCall = { name: "think", arguments: { thought: "我有点想去河边，但还没决定；也许天气会变。" } };
    const thoughtRecord: ToolCallRecord = { ...thought, id: "tc-thought", role: "agent", issuedAt: time, expectedAt: time };
    const ack: BotEvent = { id: "thought-ack", source: "system", worldTime: time, content: "这段想法已保留。",
      refToolCallId: thoughtRecord.id, originEventIds: [], experience: { internalThought: true } };
    const coldChoice = await runtime.choose(thought, BOT_TOOLS, () => []);
    assert.deepEqual(coldChoice, { call: thought });
    assert.equal(clockReads, 0, "thinking bypasses restoration and all numerical-state time advancement");
    assert.equal(requests.length, 0);
    await runtime.bind({ ...coldChoice, prediction: {} as any }, thoughtRecord);
    await runtime.perceive(ack);
    await assert.rejects(fs.stat(path.join(base, "regulation.jsonl")), { code: "ENOENT" }, "thinking never initializes or appends a regulation journal");

    await context.appendToolCall(thoughtRecord); await context.appendEvent(ack);
    await runtime.restore();
    // The provenance marker is independently enforced even if a caller mislabels the receipt as a world/tool result.
    const mislabeled: BotEvent = { ...ack, id: "thought-as-world", source: "world", originEventIds: ["imagined-root"],
      experience: { internalThought: true, worldPerception: true, agency: "self", outcome: "completed", opportunity: true, episodeId: "imagined", action: "到河边散步" } };
    await context.appendEvent(mislabeled); await runtime.perceive(mislabeled);
    const genuine: BotEvent = { id: "actual-perception", source: "world", worldTime: time, content: "窗外开始下雨。", originEventIds: ["rain-root"] };
    await context.appendEvent(genuine); await runtime.perceive(genuine);
    const before = await fs.readFile(path.join(base, "regulation.jsonl"), "utf8");
    time += 500;
    await runtime.choose(thought, BOT_TOOLS, () => []);
    assert.equal(await fs.readFile(path.join(base, "regulation.jsonl"), "utf8"), before, "thinking does not consume pending evidence or write a decision/forecast");
    assert.equal(requests.length, 0);
    await runtime.choose({ name: "act", arguments: { description: "看看雨势" } }, BOT_TOOLS, () => []);
    assert.deepEqual(requests[0].freshEvidence.map((event: any) => event.id), [genuine.id]);
    assert.ok(!requests[0].recentContext.some((event: any) => event.contextEvidenceId === mislabeled.id));
    assert.ok(!requests[0].availableTools.some((tool: any) => tool.name === "think"), "the appraisal model cannot invent a thought as a competing rewarded action");
    assert.throws(() => validateRegulationCandidateCall(thought, BOT_TOOLS), /内心独白不参与/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(runtime.choose(thought, BOT_TOOLS, () => [], aborted.signal), /abort/i);

    const growth = new GrowthLedger(base);
    await growth.perceive(ack); await growth.perceive(mislabeled);
    await growth.restorePerceptions([{ kind: "tool_call", call: thoughtRecord },
      { kind: "event", event: { ...mislabeled, id: "legacy-thought-receipt", experience: undefined } }]);
    assert.equal((await growth.stats()).perceivedEvents, 0, "local thought confirmations do not accumulate experienced episodes");
    await assert.rejects(growth.reflect({ kind: "preference", subject: "散步", statement: "我已通过散步确认自己喜欢河边。", evidenceIds: [mislabeled.id] }, time), /未感知过事件/);
    const imaginary: PerceivedEvidence = { eventId: mislabeled.id, actorId: "bot", source: "world", observedAt: time,
      text: mislabeled.content, rootEventIds: ["imaginary-root"], experience: mislabeled.experience };
    assert.deepEqual(independentGrowthChoices([imaginary]), [], "an internal thought never counts as an autonomous completed behavior");
    assert.equal(stateBasis(imaginary), false, "thinking does not establish a bodily state despite conflicting provenance flags");
    const replay = path.join(base, "replay"); await fs.mkdir(replay);
    await fs.writeFile(path.join(replay, "growth.jsonl"), JSON.stringify({ type: "perceived", evidence: imaginary }) + "\n");
    assert.equal((await new GrowthLedger(replay).stats()).perceivedEvents, 0, "reloading a marked receipt cannot resurrect it as experience");
    await growth.perceive(genuine);
    assert.equal((await growth.stats()).perceivedEvents, 1, "actual observations still enter the growth ledger");

    const declaration = toNativeToolDefs(BOT_TOOLS).find(tool => tool.function.name === "think")!.function.parameters as any;
    assert.equal(toolLayer("think"), "core");
    assert.deepEqual(declaration.required, ["thought"]);
    assert.equal(declaration.properties.thought.maxLength, 1200);
    assert.equal(declaration.properties.thought.minLength, 1);
    assert.match(BOT_PROMPT_DEFAULTS.constitution, /内心独白/);
    assert.match(THOUGHT_RUNTIME_GUIDANCE, /不强制每次行动前/);
    assert.match(WORLD_PROMPT_DEFAULTS.compressSystem, /当时的想法、回忆或猜测/);
    assert.match(WORLD_PROMPT_DEFAULTS.narrativeSystem, /pendingActions.*phase=accepted只表示已受理.*phase=ongoing表示已有开始裁定.*不证明行动已经完成/);
    assert.match(WORLD_PROMPT_DEFAULTS.narrativeSystem, /observe、evolve.*提前宣布成败/);
    runtime.stop(); await runtime.settled();
    console.log("PASS inner thought: local-only protocol, no appraisal/state/learning side effects, explicit provenance and replay isolation, subjective memory and pending-world-action boundaries.");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
