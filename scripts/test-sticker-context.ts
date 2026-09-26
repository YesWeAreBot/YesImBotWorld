/** Expression semantics upgrade by append, preserving both text and native-image prefixes. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ChatMessage } from "../src/llm/chat.js";
import { mediaPart } from "../src/media/presentation.js";
import { CHAT_EXPRESSION_GUIDANCE, COMPRESSION_SOURCE_GUIDANCE, Prompts } from "../src/prompts.js";
import type { BotEvent, MediaRef, RichTextPart } from "../src/types.js";
import { WorldAgent } from "../src/world/agent.js";

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sticker-context-"));
  const logger: any = { info() {}, warn() {}, error() {} };
  let agent: BotAgent | undefined, world: WorldAgent | undefined;
  try {
    const files = new WorldFiles(base); await files.ensure();
    const fresh = new BotContext(files); await fresh.load();
    assert.equal(await fresh.ensureExpressionGuidance(1), undefined, "new contexts already contain the interpretation rule");
    const nativeTools = [{ type: "function" as const, function: { name: "think", description: "旧声明", parameters: { type: "object", properties: {} } } }];
    await fresh.nativeToolSnapshot("T1", nativeTools);
    const pinned = JSON.parse(await files.readText(files.pinned));
    pinned.rendered.systemText = "历史固定前缀：角色姓名与旧工具说明";
    await files.atomicWrite(files.pinned, JSON.stringify(pinned));
    const cat: MediaRef = { id: 1, type: "image", mime: "image/png", file: "/unused/cat.png" };
    // No new presentation version: these are already-sent media bytes from the former build.
    const oldPart: RichTextPart = { kind: "media", ref: cat, sticker: true, summary: "一只猫", marker: "旧文字" };
    const old: BotEvent = { id: "ev_1", source: "koishi", worldTime: 1, content: "旧群消息", originEventIds: ["chat-old"],
      parts: [{ kind: "text", text: "朋友群 小明 (msg:old)：" }, oldPart], attachments: [cat] };
    await fs.writeFile(files.stream, JSON.stringify({ kind: "event", event: old }) + "\n");
    const load = async () => { const context = new BotContext(files); await context.load();
      context.attachmentLoader = async () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } }); return context; };
    const context = await load(), prefix = await context.toChatMessages("T2", true), oldJournal = await files.readText(files.stream);
    assert.equal(prefix[0]!.content, pinned.rendered.systemText);
    assert.deepEqual(prefix[1]!.content, [
      { type: "text", text: '<event id="ev_1" t="1.0" src="koishi">朋友群 小明 (msg:old)：<media ref="media:1" type="image" usage="sticker">\n表情包（按表情使用）；文字摘要（可能有误）：一只猫\n' },
      { type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } },
      { type: "text", text: "\n</media></event>" },
    ], "existing native media prompts must render byte-for-byte as before the upgrade");
    const config = Config({ autoStart: false }); config.bot.growth.enabled = false;
    const clock: any = { now: () => 2, timeLine: () => "T2", unitWorldSeconds: 1, unitRealSeconds: 1 };
    agent = new BotAgent(config, clock, files, context, {} as any, {} as any, null, null, null, { down: false }, logger,
      BOT_TOOLS.filter(tool => tool.name === "think"));
    // Exercise the real generation boundary without starting any model or executing an action.
    Object.assign(agent, { running: true, manualPaused: true });
    await (agent as any).drainMailbox();
    Object.assign(agent, { running: false });
    const notices = context.stream.filter(entry => entry.kind === "event" && entry.event.content === CHAT_EXPRESSION_GUIDANCE);
    assert.equal(notices.length, 1); assert.equal(notices[0]!.kind, "event");
    if (notices[0]!.kind === "event") { assert.equal(notices[0]!.event.source, "system"); assert.deepEqual(notices[0]!.event.originEventIds, []); }
    assert.deepEqual((await context.toChatMessages("T3", true)).slice(0, prefix.length), prefix);
    assert.ok((await files.readText(files.stream)).startsWith(oldJournal));
    assert.deepEqual(await context.nativeToolSnapshot("T3", []), nativeTools);
    assert.equal(await context.ensureExpressionGuidance(3), undefined);

    const currentPart = mediaPart(cat, { sticker: true, expressionSummary: "可能用于轻松确认；语境不明时不能确定", galleryNote: "我有时用来轻轻应一声" });
    await context.appendEvent({ id: "new-chat", source: "koishi", worldTime: 4, content: "新的消息使用同一素材", originEventIds: ["chat-new"], mediaReuse: true,
      parts: [{ kind: "text", text: "朋友群 小明 (msg:new)：" }, currentPart], attachments: [cat] });
    const updated = await context.toChatMessages("T4", true);
    assert.deepEqual(updated.slice(0, prefix.length), prefix);
    assert.ok(JSON.stringify(updated.at(-1)).includes("msg:new"));
    assert.ok(JSON.stringify(updated.at(-1)).includes("可能用于轻松确认"));
    assert.ok(!JSON.stringify(updated.at(-1)).includes("data:image"), "reuse retains message identity and expression use without re-expanding the asset");
    const restarted = await load();
    assert.deepEqual(await restarted.toChatMessages("T5", true), updated, "presentation versions and guidance survive process restart");
    assert.equal(await restarted.ensureExpressionGuidance(5), undefined);
    const ledger = new GrowthLedger(base); await ledger.restorePerceptions(restarted.stream);
    const evidence = await ledger.recallEvidence({ n: 30 });
    assert.ok(!evidence.some(item => item.text.includes(CHAT_EXPRESSION_GUIDANCE)), "interpretation maintenance is not a relationship or emotion event");
    assert.ok(evidence.some(item => item.rootEventIds.includes("chat-new")), "a real new message remains evidence despite reusing a picture");

    const prompts = new Prompts(); prompts.setOverrides({ bot: {}, world: { compressSystem: "自定义整理要求", compressUser: "材料：{{streamText}}" } });
    const requests: ChatMessage[][] = [];
    config.world.compressMaxInputChars = 30;
    world = new WorldAgent(config.world, files, clock, logger, prompts);
    (world as any).client = { complete: async (messages: ChatMessage[]) => { requests.push(messages);
      return { content: "<HISTORY_SUMMARY>语气尚不确定</HISTORY_SUMMARY><MEMORY_DIGEST>保留真实对话</MEMORY_DIGEST>", toolCalls: [] }; } };
    await world.compress({ persona: "人物", historySummary: "旧摘要", memoryDigest: "旧记忆", streamText: "不同消息中重复发了同一枚表情，但不能断定是催促。\n".repeat(3), timeLine: "T5" });
    assert.ok(requests.length > 1);
    for (const messages of requests) { assert.ok(String(messages[0]!.content).startsWith("自定义整理要求")); assert.ok(String(messages[0]!.content).includes(COMPRESSION_SOURCE_GUIDANCE)); }
    await restarted.applyCompression({ historySummary: "实际聊天已保留", memoryDigest: "表情含义不明" }, 6, await restarted.compressionSnapshot());
    const compressed = await restarted.toChatMessages("T6", true);
    assert.ok(String(compressed[0]!.content).includes(CHAT_EXPRESSION_GUIDANCE));
    assert.equal(await restarted.ensureExpressionGuidance(7), undefined);
    console.log("PASS expression context: real Agent boundary, immutable historical text/native media and tools, single appended guidance, new repeated-message identity, restart, growth provenance and all compression passes");
  } finally { await agent?.stop(); await world?.runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
