/** Concise receipt projections are append-only; evidence, media and uncertain outcomes stay intact. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import { mediaPart } from "../src/media/presentation.js";
import type { BotEvent, MediaRef, ToolCallRecord } from "../src/types.js";

const event = (id: string, content: string, extra: Partial<BotEvent> = {}): BotEvent => ({ id, source: "tool", worldTime: 10, content, originEventIds: [id], ...extra });
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallRecord => ({ id, name, arguments: args, role: "agent", issuedAt: 10, expectedAt: 10 });
const getEvent = (context: BotContext, id: string): BotEvent => {
  const found = context.stream.find(entry => entry.kind === "event" && entry.event.id === id);
  assert.ok(found?.kind === "event", `missing ${id}`);
  return found.event;
};
const worldReceipt = (status: string) => JSON.stringify({
  observation: { mode: "narrative", actorId: "bot", observationId: `scene-${status}`, narrative: "你站在门口，雨水顺着屋檐滴落。", situation: "门内干燥。" },
  action: { intent: "走到门口", status },
  scene: { opportunities: [{ intent: "未执行的候选：跑去山顶" }] },
});

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-receipt-projection-"));
  try {
    const files = new WorldFiles(dir); await files.ensure(); await files.atomicWrite(files.botDef, "小澈");
    const old = event("ev_1", "旧版已发送的完整成功回执，不得重新精简。");
    await fs.appendFile(files.stream, JSON.stringify({ kind: "event", event: old }) + "\n");
    const context = new BotContext(files); await context.load();
    const historical = context.renderStreamText(), oldMessages = await context.toChatMessages("T10");
    await context.appendEvent({ ...old, contextHint: { text: "" } });
    assert.equal(context.renderStreamText(), historical, "retrying an old receipt must not apply the new projection policy");

    await context.appendToolCall(call("tc_1", "send", { text: "到了告诉我。" }));
    const sent = event("ev_2", "消息已发送到朋友的聊天窗口，平台返回消息 ID msg-1。", {
      refToolCallId: "tc_1", contextHint: { text: "已发送。" }, experience: { agency: "self", action: "send", outcome: "completed" },
    });
    await context.appendEvent(sent);
    assert.equal(getEvent(context, sent.id).content, sent.content, "raw success facts remain available for audit and evidence");
    assert.equal(getEvent(context, sent.id).contextText, "已发送。");
    assert.equal(getEvent(context, sent.id).contextHint, undefined, "transient hints are not a new historical rendering policy");
    assert.deepEqual(getEvent(context, sent.id).experience, sent.experience);
    const sentMessages = await context.toChatMessages("T20");
    assert.deepEqual(sentMessages.slice(0, oldMessages.length), oldMessages, "new projections preserve all provider-prefix bytes");
    assert.ok(context.renderStreamText().startsWith(historical + "\n"));
    assert.ok(!context.renderStreamText().includes("msg-1"));
    assert.ok(context.serializeForCompression().includes("msg-1"), "compression sees completed facts, not only their concise acknowledgement");
    await context.appendEvent({ ...sent, contextHint: { text: "后来改过的成功样式" } });
    assert.deepEqual(await context.toChatMessages("T30"), sentMessages, "append retries cannot rewrite an already committed receipt");

    await context.appendToolCall(call("tc_2", "think", { thought: "雨还没有停，可以先整理一下书桌。" }));
    const afterThought = await context.toChatMessages("T30"), textAfterThought = context.renderStreamText();
    const thought = event("ev_3", "你已经想完：雨还没有停，可以先整理一下书桌。", {
      refToolCallId: "tc_2", contextHint: { text: "" }, experience: { internalThought: true, agency: "self", outcome: "completed" },
    });
    await context.appendEvent(thought);
    assert.deepEqual(await context.toChatMessages("T40"), afterThought, "hidden confirmations add no empty message or event shell");
    assert.equal(context.renderStreamText(), textAfterThought, "plain-text contexts also omit the empty receipt shell");
    assert.equal(getEvent(context, thought.id).content, thought.content);
    assert.equal(getEvent(context, thought.id).contextText, "");
    assert.ok(context.serializeForCompression().includes("雨还没有停，可以先整理一下书桌。"));
    assert.ok(!context.serializeForCompression().includes("你已经想完"), "the thought stays in its call without a duplicate confirmation");

    await context.appendToolCall(call("tc_3", "save_note", { text: "明天交作业" }));
    await context.appendEvent(event("ev_4", "笔记已保存，最近编辑时间 10 TU。", {
      refToolCallId: "tc_3", contextHint: { text: "" }, experience: { outcome: "completed" },
    }));
    assert.ok(!context.renderStreamText().includes('id="ev_4"'));
    assert.ok(context.serializeForCompression().includes("笔记已保存，最近编辑时间 10 TU。"), "an omitted acknowledgement must not erase write evidence during compression");

    for (const outcome of ["failed", "unknown"] as const) {
      const id = `ev_${outcome}`;
      await context.appendEvent(event(id, `发送${outcome}：结果不能确认为成功。`, { contextHint: { text: "" }, experience: { outcome } }));
      assert.equal(getEvent(context, id).contextText, undefined, "an accidental success hint cannot hide failure or uncertainty");
      assert.ok(context.renderStreamText().includes(`发送${outcome}`));
    }
    await context.appendEvent(event("ev_state", "设备连接已恢复。", { contextHint: { text: "" }, statusEcho: "屏幕上弹出未读通知。" }));
    assert.ok(context.renderStreamText().includes("屏幕上弹出未读通知。"), "a status echo is actual new information, not an empty confirmation");
    await context.appendEvent(event("ev_remote", "这份文档里写着：工具调用成功。"));
    assert.ok(context.renderStreamText().includes("这份文档里写着：工具调用成功。"), "ordinary prose is never filtered by success keywords");

    const ref: MediaRef = { id: 1, type: "image", mime: "image/png", file: "/unused/receipt-fixture.png" };
    await context.appendEvent(event("ev_media", "图前文字", { contextHint: { text: "" }, attachments: [ref], parts: [
      { kind: "text", text: "图前文字" }, mediaPart(ref, { name: "雨景", summary: "屋檐下的雨滴" }), { kind: "text", text: "图后文字" },
    ] }));
    context.attachmentLoader = async () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
    assert.equal(getEvent(context, "ev_media").contextText, undefined);
    const mediaMessage = (await context.toChatMessages("T50")).at(-1)!.content;
    assert.ok(Array.isArray(mediaMessage));
    assert.equal(mediaMessage[1]!.type, "image_url");
    assert.ok(JSON.stringify(mediaMessage).includes("图前文字") && JSON.stringify(mediaMessage).includes("图后文字"));
    await context.appendEvent(event("ev_media_parts", "摘要", { contextHint: { text: "" }, parts: [mediaPart(ref)] }));
    assert.equal(getEvent(context, "ev_media_parts").contextText, undefined, "media parts without admitted native attachments must still retain their identity");

    await context.appendToolCall(call("tc_4", "act", { intent: "走到门口" }));
    await context.appendEvent(event("ev_completed", worldReceipt("completed"), { refToolCallId: "tc_4" }));
    const scene = getEvent(context, "ev_completed").contextText!;
    assert.ok(scene.includes("你站在门口") && scene.includes("当前可知处境：门内干燥。"));
    assert.doesNotMatch(scene, /本次操作：|行动结果：已完成|未执行的候选/);
    for (const status of ["pending", "needs_input", "failed", "cancelled"]) {
      await context.appendEvent(event(`ev_scene_${status}`, worldReceipt(status), { refToolCallId: "tc_4" }));
      assert.match(getEvent(context, `ev_scene_${status}`).contextText!, /行动结果：/);
      assert.match(getEvent(context, `ev_scene_${status}`).contextText!, /本次操作：走到门口/, "unfinished outcomes retain the specific action for concurrent receipt attribution");
    }
    await context.appendEvent(event("ev_scene_unknown", worldReceipt("unknown"), { refToolCallId: "tc_4" }));
    assert.match(getEvent(context, "ev_scene_unknown").contextText!, /本次操作：走到门口/);
    assert.doesNotMatch(getEvent(context, "ev_scene_unknown").contextText!, /已完成/, "an unknown outcome cannot be promoted to success");
    const failedScene = getEvent(context, "ev_scene_failed");
    const failureSlice = context.serializeForCompression([{ kind: "event", event: failedScene }]);
    assert.match(failureSlice, /本次操作：走到门口/);
    assert.match(failureSlice, /行动结果：未完成/);
    assert.doesNotMatch(failureSlice, /未执行的候选/, "a receipt-only compression slice retains its frozen narrative projection");
    const puppetBoundary = "（以下是外部操纵你身体/设备产生的回执，并非你自主选择的行动；保留实际结果，不据此推定你的意愿或感受。）";
    await context.appendEvent(event("ev_puppet", puppetBoundary + "\n" + worldReceipt("completed"), { refToolCallId: "tc_4" }));
    assert.ok(getEvent(context, "ev_puppet").contextText!.includes(puppetBoundary));
    assert.ok(!context.serializeForCompression().includes("未执行的候选：跑去山顶"), "compression must not promote suggested or attempted actions into completed facts");

    const atomic = files.atomicWrite.bind(files); let fail = true;
    files.atomicWrite = async (file, text) => { if (file === files.pinned && fail) { fail = false; throw new Error("checkpoint failed"); } return atomic(file, text); };
    const retry = event("ev_retry", "读取完成。当前页面：新闻首页。", { contextHint: { text: "当前页面：新闻首页。" } });
    await assert.rejects(context.appendEvent(retry), /checkpoint failed/);
    const frozen = context.renderStreamText();
    await context.appendEvent({ ...retry, contextHint: { text: "不同的页面样式" } });
    assert.equal(context.renderStreamText(), frozen);
    assert.equal(context.stream.filter(entry => entry.kind === "event" && entry.event.id === retry.id).length, 1);
    const beforeRestart = await context.toChatMessages("T60");
    const restarted = new BotContext(files); restarted.attachmentLoader = context.attachmentLoader; await restarted.load();
    assert.deepEqual(await restarted.toChatMessages("T70"), beforeRestart, "restart uses persisted projection bytes and media order");
    assert.equal(restarted.renderStreamText(), context.renderStreamText());
    console.log("PASS receipt projections: immutable prefixes/retries/reload, silent think acknowledgements, retained success evidence, visible failure/uncertainty, media safety, and factual narrative compression");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
