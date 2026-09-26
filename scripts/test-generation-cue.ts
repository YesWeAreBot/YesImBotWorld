/** A durable protocol cue starts the next model turn without inventing a tool result or experience. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { ChatBackend } from "../src/bot/backend.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ChatMessage } from "../src/llm/chat.js";
import type { BotEvent, ToolCallRecord } from "../src/types.js";

const CUE = "请选择下一步。";
const toolCall = (id: string, name = "think"): ToolCallRecord => ({ id, name, role: "agent", issuedAt: 10, expectedAt: 10,
  arguments: name === "think" ? { thought: `想法 ${id}：雨还没停，先把手边的事情理一理。` } : { description: "走到屋檐下看看雨势" } });
const cues = (context: BotContext): BotEvent[] => context.stream.flatMap(entry => entry.kind === "event" && entry.event.generationCue ? [entry.event] : []);
async function think(context: BotContext, id: string) {
  await context.appendToolCall(toolCall(id));
  await context.appendEvent({ id: `receipt_${id}`, source: "system", refToolCallId: id, worldTime: 10,
    content: "（这段内心独白已记下。）", contextHint: { text: "" }, originEventIds: [],
    experience: { internalThought: true, agency: "self", opportunity: false } });
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-generation-cue-"));
  try {
    const files = new WorldFiles(dir); await files.ensure(); await files.atomicWrite(files.botDef, "小澈");
    const context = new BotContext(files); await context.load();
    await context.ensureGenerationCue();
    assert.equal(cues(context).length, 0, "an empty stream needs no fabricated input or receipt");
    await context.appendEvent({ id: "ev_initial", source: "world", worldTime: 9, content: "屋外下着雨。", originEventIds: ["rain"] });
    const original = await context.toChatMessages("T9");
    await context.ensureGenerationCue();
    assert.deepEqual(await context.toChatMessages("T10"), original, "actual visible input already terminates the model turn");

    await think(context, "tc_1");
    const withoutCue = await context.toChatMessages("T10");
    assert.equal(withoutCue.at(-1)!.role, "assistant", "ordinary rendering does not implicitly append protocol records");
    assert.equal(cues(context).length, 0);
    await context.ensureGenerationCue();
    const first = cues(context);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.id, "ev_generation_tc_1");
    assert.equal(first[0]!.source, "system");
    assert.equal(first[0]!.generationCue, true);
    assert.deepEqual(first[0]!.originEventIds, []);
    assert.equal(first[0]!.content, CUE);
    assert.equal(first[0]!.experience, undefined, "a protocol turn boundary is not an action outcome or perception");
    const firstRequest = await context.toChatMessages("T11");
    assert.deepEqual(firstRequest.slice(0, withoutCue.length), withoutCue);
    assert.deepEqual(firstRequest.at(-1), { role: "user", content: CUE }, "cue is a bare user protocol message, never an event XML shell");
    assert.ok(!JSON.stringify(firstRequest).includes("这段内心独白已记下"));
    assert.equal(firstRequest.filter(message => JSON.stringify(message.content).includes("想法 tc_1")).length, 1);
    assert.ok(!context.serializeForCompression().includes(CUE));
    assert.ok(!context.serializeForCompression().includes("ev_generation_"));

    await Promise.all([context.ensureGenerationCue(), context.ensureGenerationCue()]);
    assert.equal(cues(context).length, 1, "concurrent/repeated preparations append exactly one stable cue");
    assert.deepEqual(await context.toChatMessages("T12"), firstRequest);
    const restored = new BotContext(files); await restored.load();
    await restored.ensureGenerationCue();
    assert.deepEqual(await restored.toChatMessages("after restart"), firstRequest, "restart retains exact message bytes and does not duplicate the boundary");

    await think(restored, "tc_2");
    await restored.ensureGenerationCue();
    const secondRequest = await restored.toChatMessages("T13");
    assert.deepEqual(secondRequest.slice(0, firstRequest.length), firstRequest, "a later thought extends rather than replaces the previous cue");
    assert.deepEqual(secondRequest.slice(-2).map(message => message.role), ["assistant", "user"]);
    assert.deepEqual(cues(restored).map(cue => cue.id), ["ev_generation_tc_1", "ev_generation_tc_2"]);
    await restored.appendEvent({ id: "ev_rain_stopped", source: "world", worldTime: 14, content: "雨渐渐停了。", originEventIds: ["rain-stop"] });
    await restored.ensureGenerationCue();
    const afterEvent = await restored.toChatMessages("T14");
    assert.deepEqual(afterEvent.slice(0, secondRequest.length), secondRequest);
    assert.equal(cues(restored).length, 2, "a real event supersedes the need for another generation cue");
    assert.ok(JSON.stringify(afterEvent.at(-1)!.content).includes("雨渐渐停了"));

    // Use the actual backend request preparation with a fake in-memory client, never a model endpoint.
    const cfg = Config({ autoStart: false });
    const backend = new ChatBackend({ ...cfg.bot, nativeToolCalls: false, baseURL: "http://generation-cue.invalid/v1", model: "offline-cue-fixture" }, ["think"], [
      { name: "think", signature: "think(thought: string)", description: "记录内心独白。" },
    ]);
    const requests: ChatMessage[][] = [];
    (backend as unknown as { client: { complete: (messages: ChatMessage[]) => Promise<unknown> } }).client = {
      complete: async messages => {
        requests.push(structuredClone(messages));
        return { content: JSON.stringify({ name: "think", arguments: { thought: "等雨停后再出发。" } }), toolCalls: [] };
      },
    };
    await think(restored, "tc_3");
    assert.equal((await restored.toChatMessages("T15")).at(-1)!.role, "assistant");
    assert.equal((await backend.generate(restored, "T15")).name, "think");
    assert.deepEqual(requests.at(-1)!.at(-1), { role: "user", content: CUE }, "ChatBackend prepares the cue before freezing the outgoing request snapshot");
    assert.ok(!JSON.stringify(requests.at(-1)).includes("这段内心独白已记下"));
    assert.deepEqual(requests.at(-1)!.slice(0, afterEvent.length), afterEvent);
    assert.equal(cues(restored).at(-1)!.id, "ev_generation_tc_3");
    const backendRequest = requests.at(-1)!;
    await backend.generate(restored, "T16");
    assert.deepEqual(requests.at(-1), backendRequest, "request retries reuse the durable boundary rather than adding fresh noise");

    await restored.appendToolCall(toolCall("tc_4", "act"));
    await backend.generate(restored, "T17");
    const actionRequest = requests.at(-1)!;
    assert.deepEqual(actionRequest.slice(0, backendRequest.length), backendRequest);
    assert.deepEqual(actionRequest.at(-1), { role: "user", content: CUE });
    assert.doesNotMatch(String(actionRequest.at(-1)!.content), /成功|完成|已受理/, "the boundary must not claim an unresolved external action succeeded");
    const compression = restored.serializeForCompression();
    assert.ok(compression.includes("想法 tc_1") && compression.includes("走到屋檐下看看雨势"));
    assert.ok(!compression.includes(CUE) && !compression.includes("ev_generation_"));
    const ledger = new GrowthLedger(dir);
    for (const cue of cues(restored)) await ledger.perceive(cue);
    assert.deepEqual(await ledger.recallEvidence({ n: 50 }), [], "protocol records supply no growth evidence even when passed through the regular evidence API");
    await ledger.restorePerceptions(restored.stream);
    assert.ok((await ledger.recallEvidence({ n: 50 })).every(evidence => !evidence.eventId.startsWith("ev_generation_") && !evidence.text.includes(CUE)), "growth recovery also ignores protocol cues");
    console.log("PASS generation cues: bare next-turn protocol, silent thought receipts, stable append/retry/restart prefixes, backend preparation, unresolved-action honesty and no memory/growth pollution");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
