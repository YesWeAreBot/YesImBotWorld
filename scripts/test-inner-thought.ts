/** Local character prose must never become a world observation, completed action or growth evidence. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger, independentGrowthChoices, type PerceivedEvidence } from "../src/bot/growth.js";
import { stateBasis } from "../src/bot/growth-grounding.js";
import { toNativeToolDefs } from "../src/bot/nativeTools.js";
import { BOT_TOOLS, toolLayer } from "../src/bot/tools.js";
import { WorldFiles } from "../src/files.js";
import { BOT_PROMPT_DEFAULTS, WORLD_PROMPT_DEFAULTS, THOUGHT_RUNTIME_GUIDANCE } from "../src/prompts.js";
import { buildWorldTaskPrompt } from "../src/world/prompt.js";
import type { BotEvent, ParsedToolCall, ToolCallRecord } from "../src/types.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-inner-thought-"));
  try {
    const files = new WorldFiles(base); await files.ensure();
    const context = new BotContext(files); await context.load();
    const time = 10;
    const thought: ParsedToolCall = { name: "think", arguments: { thought: "我有点想去河边，但还没决定；也许天气会变。" } };
    const thoughtRecord: ToolCallRecord = { ...thought, id: "tc-thought", role: "agent", issuedAt: time, expectedAt: time };
    const ack: BotEvent = { id: "thought-ack", source: "system", worldTime: time, content: "这段想法已保留。",
      refToolCallId: thoughtRecord.id, originEventIds: [], experience: { internalThought: true } };
    await context.appendToolCall(thoughtRecord); await context.appendEvent(ack);
    // The provenance marker is independently enforced even if a caller mislabels the receipt as a world/tool result.
    const mislabeled: BotEvent = { ...ack, id: "thought-as-world", source: "world", originEventIds: ["imagined-root"],
      experience: { internalThought: true, worldPerception: true, agency: "self", outcome: "completed", opportunity: true, episodeId: "imagined", action: "到河边散步" } };
    await context.appendEvent(mislabeled);
    const genuine: BotEvent = { id: "actual-perception", source: "world", worldTime: time, content: "窗外开始下雨。", originEventIds: ["rain-root"] };
    await context.appendEvent(genuine);
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
    for (const kind of ["observe", "evolve"] as const) {
      const prompt = buildWorldTaskPrompt({ narrativeSystem: WORLD_PROMPT_DEFAULTS.narrativeSystem, worldDef: "", botDef: "", kind });
      assert.match(prompt, /pendingActions.*phase=accepted只表示已受理.*phase=ongoing表示已有开始裁定.*不证明行动已经完成/);
      assert.match(prompt, /本次不得替它们推进过程或提前宣布成败/,
        `${kind} retains the unfinished-action boundary after task prompt separation`);
    }
    console.log("PASS inner thought: local-only protocol, no imagined growth, explicit provenance and replay isolation, subjective memory and pending-world-action boundaries.");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
