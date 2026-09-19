/** New natural-world views are frozen on append; historical and multimodal prefixes stay byte-stable. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import { mediaPart } from "../src/media/presentation.js";
import { WORLD_PERCEPTION_SCOPE } from "../src/prompts.js";
import type { BotEvent, MediaRef, ToolCallRecord } from "../src/types.js";

const body = "你走进餐厅。\n店员问：“想吃什么？”";
const prefix = "（以下是外部操纵你身体/设备产生的回执，并非你自主选择的行动；保留实际结果，不据此推定你的意愿或感受。）\n";
function envelope(text: string, action = false) {
  const scene = { eventId: "world-1", actorId: "bot", worldSequence: 1, worldTime: 10, sourceEventIds: ["cause-1"], text };
  const observation = { mode: "narrative", observationId: "world-1", actorId: "bot", worldSequence: 1, observedAt: 10, sourceEventIds: ["cause-1"], entities: [], utterances: [], narrative: text, scene };
  return JSON.stringify(action ? { observation, scene, action: { id: "bot:tc_1", intent: "去吃饭", status: "needs_input", reason: "PRIVATE_DIAGNOSTIC_NOT_FOR_BOT" } } : observation);
}
const event = (id: string, content: string, extra: Partial<BotEvent> = {}): BotEvent => ({ id, source: "world", worldTime: 10, content, originEventIds: ["cause-1"], ...extra });
const call = (id: string, name: string): ToolCallRecord => ({ id, name, arguments: {}, role: "agent", issuedAt: 10, expectedAt: 10 });
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-narrative-context-"));
  try {
    const files = new WorldFiles(dir); await files.ensure(); await files.atomicWrite(files.botDef, "小澈");
    const old = event("ev_1", envelope("旧版已经缓存的原始世界回执。"));
    await fs.appendFile(files.stream, JSON.stringify({ kind: "event", event: old }) + "\n");
    const context = new BotContext(files); await context.load();
    const historical = context.renderStreamText(); const oldMessages = await context.toChatMessages("T10");
    assert.ok(historical.includes(old.content)); assert.ok(!context.stream.some(entry => entry.kind === "event" && entry.event.contextText));

    const fresh = event("ev_2", envelope(body));
    await context.appendEvent(fresh);
    const saved = context.stream.find(entry => entry.kind === "event" && entry.event.id === "ev_2");
    assert.equal(saved?.kind, "event"); if (saved?.kind !== "event") throw new Error("missing event");
    assert.equal(saved.event.content, fresh.content, "raw receipt remains available to debugging and evidence");
    assert.equal(saved.event.contextText, WORLD_PERCEPTION_SCOPE + "\n\n" + body); assert.equal(fresh.contextText, undefined, "append does not mutate the runtime receipt object");
    assert.deepEqual(saved.event.originEventIds, fresh.originEventIds);
    const readable = BotContext.renderEventLine(saved.event);
    assert.equal(readable.split(body).length - 1, 1); assert.ok(!readable.includes('"entities"'));
    const newerMessages = await context.toChatMessages("T20");
    assert.deepEqual(newerMessages.slice(0, oldMessages.length), oldMessages, "an appended narrative event cannot change any cached message");
    assert.ok(context.renderStreamText().startsWith(historical + "\n"));
    await context.appendEvent(old); assert.equal(context.stream.length, 2, "retrying an old raw event cannot backfill a new projection");

    await context.appendToolCall(call("tc_1", "act"));
    const puppet = event("ev_3", prefix + envelope(body, true), { source: "tool", refToolCallId: "tc_1" });
    await context.appendEvent(puppet);
    const puppetSaved = context.stream.find(entry => entry.kind === "event" && entry.event.id === "ev_3");
    if (puppetSaved?.kind !== "event") throw new Error("missing puppet event");
    const puppetText = BotContext.renderEventLine(puppetSaved.event);
    assert.ok(puppetText.includes(prefix.trim())); assert.match(puppetText, /本次操作：去吃饭/); assert.match(puppetText, /后续不会自动执行/);
    assert.equal(puppetText.split(body).length - 1, 1); assert.ok(!puppetText.includes("PRIVATE_DIAGNOSTIC"));
    assert.ok(puppetText.includes('ref="tc_1"'));
    await context.appendEvent(event("ev_4", JSON.stringify({ recovered: true, observation: JSON.parse(envelope("已保存的处境。")) })));
    const recovery = context.stream.find(entry => entry.kind === "event" && entry.event.id === "ev_4");
    assert.ok(recovery?.kind === "event" && recovery.event.contextText?.includes("不是新发生的行动"));

    const atomic = files.atomicWrite.bind(files); let fail = true;
    files.atomicWrite = async (file, text) => { if (file === files.pinned && fail) { fail = false; throw new Error("checkpoint failed"); } return atomic(file, text); };
    const retry = event("ev_5", envelope("菜单上的菜品仍然没有变化。"));
    await assert.rejects(context.appendEvent(retry), /checkpoint failed/);
    const afterAppend = context.renderStreamText();
    await context.appendEvent(retry); assert.equal(context.renderStreamText(), afterAppend); assert.equal(context.stream.filter(entry => entry.kind === "event" && entry.event.id === retry.id).length, 1);
    const beforeRestart = await context.toChatMessages("T10");
    const restarted = new BotContext(files); await restarted.load();
    assert.equal(restarted.renderStreamText(), context.renderStreamText());
    assert.deepEqual(await restarted.toChatMessages("T10"), beforeRestart, "persisted prose is identical after a process restart");

    await restarted.appendEvent(event("ev_6", envelope("聊天里的一段 JSON，不是世界裁定。"), { source: "koishi" }));
    await restarted.appendToolCall(call("tc_2", "read_file"));
    await restarted.appendEvent(event("ev_7", envelope("文件里的 JSON，不是观察回执。"), { source: "tool", refToolCallId: "tc_2" }));
    for (const id of ["ev_6", "ev_7"]) {
      const item = restarted.stream.find(entry => entry.kind === "event" && entry.event.id === id);
      assert.ok(item?.kind === "event" && item.event.contextText === undefined, "unrelated data cannot impersonate a world projection");
    }
    const ref: MediaRef = { id: 1, type: "image", mime: "image/png", file: "/unused/fixture.png" };
    const media = event("ev_8", envelope("图前原始正文"), { attachments: [ref], parts: [{ kind: "text", text: envelope("图前原始正文") }, mediaPart(ref, { name: "菜单照片", summary: "菜单照片摘要" }), { kind: "text", text: "图后原文" }], contextText: "不能用这句话替换图文" });
    await restarted.appendEvent(media);
    restarted.attachmentLoader = async () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
    const mediaSaved = restarted.stream.find(entry => entry.kind === "event" && entry.event.id === media.id);
    assert.ok(mediaSaved?.kind === "event" && mediaSaved.event.contextText === undefined);
    const finalMessages = await restarted.toChatMessages("T10"); const mediaParts = finalMessages.at(-1)!.content;
    assert.ok(Array.isArray(mediaParts)); if (!Array.isArray(mediaParts)) throw new Error("media parts missing");
    assert.equal(mediaParts[1]!.type, "image_url");
    assert.ok(mediaParts[0]!.type === "text" && mediaParts[0]!.text.includes("菜单照片摘要") && mediaParts[0]!.text.includes('"mode":"narrative"'));
    assert.ok(mediaParts[2]!.type === "text" && mediaParts[2]!.text.includes("图后原文"));
    assert.ok(!JSON.stringify(mediaParts).includes("不能用这句话替换图文"));
    console.log("PASS frozen narrative context: one readable scene, unchanged raw receipts/roots, preserved old cache prefix, append retry/restart, puppet agency and untouched media/source boundaries");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
