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
    const beforeLateWorld = await restarted.toChatMessages("before late old-world result");
    const latePayload = JSON.parse(envelope("你在先前世界的餐厅里点好了一碗面。", true));
    latePayload.observation.scene.situation = "旧世界餐厅内，服务员已接过菜单。";
    latePayload.observation.scene.opportunities = [{ label: "旧菜单候选", intent: "尚未执行的旧世界后续选择" }];
    const lateWorld = event("ev_historical_world", JSON.stringify(latePayload), { source: "tool", refToolCallId: "compacted-old-world-call", contextHint: { text: "" },
      experience: { worldPerception: true, historicalWorld: true, worldEpoch: "old-world-epoch" } });
    await restarted.appendEvent(lateWorld);
    const lateSaved = restarted.stream.find(entry => entry.kind === "event" && entry.event.id === lateWorld.id);
    if (lateSaved?.kind !== "event") throw new Error("missing historical-world event");
    assert.equal(lateSaved.event.content, lateWorld.content, "late historical results preserve the complete real JSON for audit and evidence");
    assert.match(lateSaved.event.contextText!, /先前世界的操作结果，不代表当前处境/);
    assert.match(lateSaved.event.contextText!, /当时可知处境：旧世界餐厅内/);
    assert.ok(lateSaved.event.contextText!.includes(latePayload.observation.narrative), "a compacted call reference does not prevent trusted late World results from rendering their actual narrative");
    assert.doesNotMatch(lateSaved.event.contextText!, /当前可知处境|需要你决定下一步|旧菜单候选|尚未执行的旧世界后续选择|PRIVATE_DIAGNOSTIC/);
    assert.match(restarted.serializeForCompression([lateSaved]), /先前世界的操作结果，不代表当前处境/);
    assert.doesNotMatch(restarted.serializeForCompression([lateSaved]), /opportunities|旧菜单候选|当前可知处境/);
    const afterLateWorld = await restarted.toChatMessages("after late old-world result");
    assert.deepEqual(afterLateWorld.slice(0, beforeLateWorld.length), beforeLateWorld, "late-result qualification only appends; older provider prefixes remain byte-identical");
    await restarted.appendEvent(lateWorld);
    assert.deepEqual(await restarted.toChatMessages("retried late old-world result"), afterLateWorld, "append retry reuses the frozen historical projection");
    const lateReload = new BotContext(files); await lateReload.load();
    assert.deepEqual(await lateReload.toChatMessages("reloaded late old-world result"), afterLateWorld, "historical source labels and old prefixes remain byte-identical across restart");

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
    const alreadyFrozen = event("ev_legacy_frozen_historical", envelope("旧存档原始世界正文。"), {
      experience: { worldPerception: true, historicalWorld: true }, contextText: "旧版本已经冻结的文本：当前可知处境：旧城桥边。",
    });
    await fs.appendFile(files.stream, JSON.stringify({ kind: "event", event: alreadyFrozen }) + "\n");
    const legacyReload = new BotContext(files); legacyReload.attachmentLoader = restarted.attachmentLoader; await legacyReload.load();
    const legacyMessages = await legacyReload.toChatMessages("old frozen archive");
    assert.ok(String(legacyMessages.at(-1)?.content).includes(alreadyFrozen.contextText!));
    assert.ok(!String(legacyMessages.at(-1)?.content).includes("先前世界的操作结果"), "loading an older frozen historical event must not apply a new rendering policy");
    await legacyReload.appendEvent({ ...alreadyFrozen, contextHint: { text: "新的显示策略不能覆盖旧前缀" } });
    assert.deepEqual(await legacyReload.toChatMessages("retried old frozen archive"), legacyMessages, "retries preserve old contextText even after the projection policy changes");
    console.log("PASS frozen narrative context: one readable scene, unchanged raw receipts/roots, preserved old cache prefix, append retry/restart, puppet agency and untouched media/source boundaries");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
