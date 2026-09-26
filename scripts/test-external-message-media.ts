/** External plugin/account messages use the ordinary ordered media projection.
 * Fixtures never download assets, call models, or send platform messages. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { Gateway } from "../src/koishi/gateway.js";
import { MessageStore } from "../src/koishi/messages.js";
import { ChannelNameResolver } from "../src/koishi/names.js";
import { MediaRenderer } from "../src/media/render.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { WorldFiles } from "../src/files.js";
import { BotContext } from "../src/bot/context.js";
import { BotAgent } from "../src/bot/agent.js";
import type { RichText } from "../src/types.js";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yibw-external-media-"));
  const rows: any[] = [], deliveries: any[] = [];
  const cfg = Config({ autoStart: false });
  cfg.messaging.externalSelfMessages = "event";
  const bot: any = { platform: "fixture", selfId: "self" };
  const logger = { warn() {}, info() {}, debug() {} };
  const ctx: any = { bots: [bot], on() {}, logger: () => logger, model: { extend() {} }, database: {
    async create(_table: string, row: any) { const saved = { ...row, id: rows.length + 1 }; rows.push(saved); return saved; },
    async get(_table: string, query: any) { return rows.filter(row => Object.entries(query).every(([key, value]: [string, any]) => value?.$in ? value.$in.includes(row[key]) : row[key] === value)); },
  } };
  const refs = new Map<number, any>();
  const media = {
    async ingest(url: string, type: string, _mime?: string, _extra?: unknown, sticker?: boolean) {
      const id = Number(url.split(":").at(-1));
      refs.set(id, { ref: { id, type, mime: type === "audio" ? "audio/wav" : "image/png", file: `/fixture/media-${id}` }, sticker });
      return id;
    },
    async get(id: number) { return refs.get(id); },
  };
  let rendered = 0;
  const renderer = new MediaRenderer(media as never, { describe: async (ref: any) => { rendered++; return `summary-${ref.id}`; } } as never, () => true, 9);
  const phone = { down: false };
  const store = new MessageStore(ctx);
  const gateway: any = new Gateway(ctx, cfg.messaging, cfg.platformOps, store, media as never, renderer,
    { isFocused: () => false } as never, {} as never, phone, {} as never, new OwnSendTracker(), new ChannelNameResolver(ctx, store), () => null,
    { notify() {}, channelActivity() {}, selfMessage(key, content, msgId, sendArgs) { deliveries.push({ key, content, msgId, sendArgs }); } });
  const emit = (id: string, elements: h[]) => gateway.handleConfirmedSelfSent({ bot, channelId: "room", messageId: id, timestamp: Date.now(), own: false, elements });
  try {
    await emit("two-images", [h.text("先看："), h("img", { src: "fixture:1", sub_type: 1 }), h.text("再看："), h("img", { src: "fixture:2", sub_type: 0 })]);
    const original = deliveries.at(-1)!;
    assert.ok(Array.isArray(original.content.parts), "external images must preserve ordered RichText rather than only send-reference strings");
    const parts = original.content.parts;
    assert.deepEqual(parts.filter((part: any) => part.kind === "media").map((part: any) => [part.ref.id, !!part.sticker, part.sticker ? part.expressionSummary : part.summary]), [[1, true, "summary-1"], [2, false, "summary-2"]]);
    assert.deepEqual(original.content.attachments.map((ref: any) => ref.id), [1, 2]);
    assert.equal(original.sendArgs.msg, '先看：<media ref="media:1"/>再看：<media ref="media:2"/>');
    assert.doesNotMatch(original.sendArgs.msg, /media id=|summary-|usage=/);
    assert.match(original.content.text, /聊天记录 #1.*附有表情包×1、图片×1.*表情与文字共同表意/);
    assert.deepEqual(rows.at(-1).conversation.mediaCounts, { sticker: 1, image: 1 });


    // The actual simulation method must preserve legal send arguments separately
    // from the actual rich media perceived in its successful tool result.
    const actor: any = Object.create(BotAgent.prototype);
    Object.assign(actor, { config: cfg, clock: { now: () => 1 }, mailbox: [], logger, noteDeferredSelfSent() {} });
    const identityText = '本会话使用你的账号：平台 "fixture"，账号 "self"；当前群名片为 "今晚值班的大王"。';
    actor.simulateExternalSend(original.key, original.content, original.msgId, original.sendArgs, identityText);
    const queued = actor.mailbox[0];
    assert.deepEqual(queued.asToolCall.arguments, { id: original.key, ...original.sendArgs });
    assert.ok(queued.content.startsWith(identityText), "actual profile context belongs to the receipt, not the outgoing message");
    assert.deepEqual(queued.attachments.map((ref: any) => ref.id), [1, 2]);
    assert.deepEqual(queued.parts.filter((part: any) => part.kind === "media").map((part: any) => part.ref.id), [1, 2]);
    const files = new WorldFiles(root); await files.ensure();
    const context = new BotContext(files, ""); await context.load();
    context.attachmentLoader = async (ref: any) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${ref.id === 1 ? "AQ==" : "Ag=="}` } });
    await context.appendToolCall({ id: "external-send", role: "agent", name: queued.asToolCall.name, arguments: queued.asToolCall.arguments, issuedAt: 1, expectedAt: 1 });
    await context.appendEvent({ id: "external-result", source: "tool", refToolCallId: "external-send", worldTime: 1, content: queued.content, attachments: queued.attachments, parts: queued.parts });
    const messages = await context.toChatMessages("T=1");
    const wire = JSON.stringify(messages);
    assert.ok(wire.includes("今晚值班的大王"), "the observed group nickname reaches the actual multimodal model request");
    assert.match(wire, /media:1.*usage=.*sticker.*summary-1.*AQ==.*再看.*media:2.*summary-2.*Ag==/s);
    assert.doesNotMatch(wire, /media id=/);

    // The same asset can participate in different acts of expression. Its first
    // recorded use must not redefine later ordinary images or erase real repetition.
    await emit("ordinary-reuse", [h("img", { src: "fixture:1", sub_type: 0, file: "same-cat.gif" })]);
    const reusedOrdinary = deliveries.at(-1)!;
    assert.match(reusedOrdinary.content.text, /仅含图片×1/);
    assert.doesNotMatch(reusedOrdinary.content.text, /usage="sticker"/);
    assert.equal(reusedOrdinary.content.parts.find((p: any) => p.kind === "media").ref.id, 1);
    await emit("sticker-again", [h("img", { src: "fixture:1", sub_type: 1 }), h("img", { src: "fixture:1", sub_type: 1 })]);
    const repeat = deliveries.at(-1)!;
    assert.match(repeat.content.text, /仅含表情包×2.*未附文字/);
    assert.notDeepEqual(repeat.content.originEventIds, original.content.originEventIds);
    assert.equal(repeat.sendArgs.msg, '<media ref="media:1"/><media ref="media:1"/>', "account simulation preserves actual outgoing multiplicity, without adding narrative");
    const count = deliveries.length;
    await emit("sticker-again", [h("img", { src: "fixture:1", sub_type: 1 })]);
    assert.equal(deliveries.length, count, "another echo of the same platform id is not another expressive act");
    const frozen = await context.toChatMessages("T=2");
    for (const [index, entry] of [reusedOrdinary, repeat].entries()) await context.appendEvent({ id: "reuse-" + index, source: "koishi", worldTime: 2 + index, content: entry.content.text, parts: entry.content.parts, attachments: entry.content.attachments, originEventIds: entry.content.originEventIds });
    const appended = await context.toChatMessages("T=3");
    assert.deepEqual(appended.slice(0, frozen.length), frozen, "new uses never rewrite a previously delivered media description or frozen provider prefix");
    const ordinaryWire = JSON.stringify(appended.at(-2));
    const repeatWire = JSON.stringify(appended.at(-1));
    assert.match(ordinaryWire, /仅含图片×1/);
    assert.doesNotMatch(ordinaryWire, /usage=\\"sticker\\"/);
    assert.match(repeatWire, /表情包×2/);
    assert.equal((repeatWire.match(/usage=\\"sticker\\"/g) ?? []).length, 2, "both new occurrences remain individually represented even when native image bytes are reused");

    // Silent and phone-down events only store the originals. No caption, native
    // attachment or media contents should cross into the event-delivery payload.
    const captionsBefore = rendered;
    cfg.messaging.externalSelfMessages = "silent";
    await emit("silent-image", [h("img", { src: "fixture:3", sub_type: 1 })]);
    assert.equal(rendered, captionsBefore);
    assert.deepEqual(deliveries.at(-1)!.content, { text: "", originEventIds: [] });
    cfg.messaging.externalSelfMessages = "event"; phone.down = true;
    await emit("phone-down-image", [h("img", { src: "fixture:4" })]);
    assert.equal(rendered, captionsBefore);
    const downNotice = deliveries.at(-1)!.content;
    assert.equal(downNotice.text, "");
    assert.ok(downNotice.originEventIds.every((id: string) => id.startsWith("chat-notice:")));
    assert.equal(downNotice.experience.subjectIds, undefined);
    assert.equal(downNotice.attachments, undefined);
    assert.equal(downNotice.parts, undefined);
    assert.doesNotMatch(JSON.stringify(downNotice), /summary-4|media:4|room/);
    assert.ok(rows.some(row => row.messageId === "phone-down-image" && row.content.includes('media id="4"')));

    phone.down = false; cfg.messaging.externalSelfMessages = "simulate";
    await emit("audio-message", [h("audio", { src: "fixture:5" })]);
    const audio = deliveries.at(-1)!;
    assert.equal(audio.sendArgs, null, "audio is not a supported send.msg inline image/video reference");
    actor.simulateExternalSend(audio.key, audio.content, audio.msgId, audio.sendArgs);
    assert.equal(actor.mailbox.at(-1).asToolCall, undefined);
    assert.equal(actor.mailbox.at(-1).attachments[0].type, "audio");
    console.log("PASS external account media: actual ordered captions/sticker/image payloads, valid simulated send references with rich result, immutable request projection, silent/phone-down privacy and truthful unsupported-media fallback");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
