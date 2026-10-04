/** Per-use expression semantics, one recognition pass and immutable historical media rendering. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import { CaptionService } from "../src/media/captioner.js";
import { createAttachmentLoader } from "../src/media/parts.js";
import { mediaOpen, mediaPart, mediaText, richPartsText } from "../src/media/presentation.js";
import { MediaRenderer, mediaPlaceholder } from "../src/media/render.js";
import { MediaStore } from "../src/media/store.js";
import type { MediaRef, RichTextPart } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const ordinary = "普通图片：一只猫坐在桌边，文字‘收到’。";
const expression = "字面文字：收到。可能用途：可能用于简短应和，也可能带调侃；单凭素材不能确定。辨认线索：猫抬起爪子。";
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("same-cat")]);
const dataUrl = (bytes: Buffer, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;
const directories: string[] = [], servers: http.Server[] = [];

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sticker-media-")); directories.push(dir);
  const rows: any[] = [], requests: any[] = [], models: any[] = [];
  const matches = (row: any, query: any) => Object.entries(query).every(([key, value]) => row[key] === value);
  const ctx: any = { model: { extend(_name: string, model: any) { models.push(model); } }, database: {
    async get(_table: string, query: any) { return rows.filter(row => matches(row, query)).map(row => ({ ...row })); },
    async set(_table: string, query: any, update: any) { for (const row of rows) if (matches(row, query)) Object.assign(row, update); },
    async create(_table: string, value: any) { const row = { id: rows.length + 1, ...value }; rows.push(row); return { ...row }; },
  } };
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    const prompt = request.messages[0].content[0].text;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: prompt.includes("会话表意符号") ? expression : ordinary }, finish_reason: "stop" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const cfg = Config({});
  for (const type of ["image", "video"] as const) Object.assign(cfg.captioners[type], {
    enabled: true, baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: `local-${type}`, apiKey: "",
  });
  const store = new MediaStore(ctx, path.join(dir, "assets"), 100_000, logger);
  const id = (await store.ingest(dataUrl(png), "image"))!;
  const ref = (await store.get(id))!.ref;
  const captioner = new CaptionService(cfg.captioners, cfg.media, store, logger);
  return { dir, rows, requests, models, cfg, store, id, ref, captioner };
}

async function captionUsageCaches() {
  const f = await fixture();
  assert.equal(f.models[0].expressionSummary, "text");
  assert.equal(await f.store.ingest(dataUrl(png), "image", undefined, undefined, true), f.id, "one asset retains one ID across usages");
  const concurrent = await Promise.all([
    f.captioner.describe(f.ref), f.captioner.describe(f.ref, { sticker: true }), f.captioner.describe(f.ref, { sticker: true }),
  ]);
  assert.deepEqual(concurrent, [ordinary, expression, expression]);
  assert.equal(f.requests.length, 2, "one pass per usage, no classification pass, concurrent expression calls coalesce");
  const expressionRequest = f.requests.find(request => request.messages[0].content[0].text.includes("会话表意符号"));
  const prompt = expressionRequest.messages[0].content[0].text;
  assert.match(prompt, /字面文字.*可能用途.*辨认线索/);
  assert.match(prompt, /不能推断其真实情绪、人际态度/);
  assert.match(prompt, /不能从猫、鱼、角色、颜色等画面直接推断人际含义/);
  assert.equal(expressionRequest.messages[0].content.length, 2);
  assert.equal(expressionRequest.messages[0].content[1].image_url.url, dataUrl(png), "the one recognition request still sees the exact original asset");
  const row = (await f.store.get(f.id))!;
  assert.equal(row.summary, ordinary); assert.equal(row.expressionSummary, expression);
  const restarted = new CaptionService(f.cfg.captioners, f.cfg.media, f.store, logger);
  assert.equal(await restarted.describe(f.ref), ordinary);
  assert.equal(await restarted.describe(f.ref, { sticker: true }), expression);
  assert.equal(f.requests.length, 2, "per-use caches survive service restart");
  assert.equal(await restarted.describeDetailed(f.ref), ordinary);
  assert.equal(await restarted.describeDetailed(f.ref, { sticker: true }), expression);
  assert.equal(f.requests.length, 3, "expression view reuses its complete usage cache; ordinary detail remains separate");
  assert.equal(await restarted.describeDetailed(f.ref), ordinary);
  assert.equal(await restarted.describeDetailed(f.ref, { sticker: true }), expression);
  assert.equal(f.requests.length, 3);
  assert.equal((await f.store.get(f.id))!.summary, ordinary, "detailed expression recognition does not overwrite ordinary summary");

  // A pre-upgrade visual caption must never silently become a sticker's conversational meaning.
  f.rows[0].summary = "旧图像摘要说发送者很生气";
  delete f.rows[0].expressionSummary;
  f.cfg.captioners.image.enabled = false;
  const unavailable = new CaptionService(f.cfg.captioners, f.cfg.media, f.store, logger);
  assert.equal(await unavailable.describe(f.ref, { sticker: true }), null);
  assert.equal(await unavailable.describe(f.ref), "旧图像摘要说发送者很生气");
  assert.equal(f.requests.length, 3);

  // Animated platform expressions still use their existing video recognition path, once.
  const gifBytes = Buffer.concat([Buffer.from("GIF89a"), Buffer.from("one-animation")]);
  const gifId = (await f.store.ingest(dataUrl(gifBytes, "image/gif"), "image", undefined, undefined, true))!;
  const gifRef = (await f.store.get(gifId))!.ref;
  assert.equal(await unavailable.describe(gifRef, { sticker: true }), expression);
  const gifRequest = f.requests.at(-1);
  assert.equal(gifRequest.model, "local-video");
  assert.equal(gifRequest.messages[0].content[1].video_url.url, dataUrl(gifBytes, "image/gif"));
  assert.equal(f.requests.length, 4);
}

async function renderPerOccurrence() {
  const f = await fixture();
  const renderer = new MediaRenderer(f.store, f.captioner, () => true, 8);
  const unknownUsage = await renderer.render(mediaPlaceholder(f.id, "image"));
  await f.store.ingest(dataUrl(png), "image", undefined, undefined, true);
  assert.deepEqual(await renderer.render(mediaPlaceholder(f.id, "image")), unknownUsage,
    "an old occurrence with unknown usage cannot become a sticker because the asset was later sent as one");
  const rich = await renderer.render(`前${mediaPlaceholder(f.id, "image", true)}中${mediaPlaceholder(f.id, "image", false)}后`);
  const parts = rich.parts!.filter((part): part is Extract<RichTextPart, { kind: "media" }> => part.kind === "media");
  assert.equal(parts.length, 2); assert.equal(parts[0]!.ref.id, parts[1]!.ref.id);
  assert.equal(parts[0]!.presentation, "expression-v2"); assert.equal(parts[0]!.expressionSummary, expression);
  assert.equal(parts[0]!.summary, undefined);
  assert.equal(parts[1]!.presentation, "media-v2"); assert.equal(parts[1]!.summary, ordinary);
  assert.equal(parts[1]!.sticker, undefined, "a past sticker ingestion cannot reclassify today's ordinary image");
  assert.equal(rich.text, richPartsText(rich.parts!));
  assert.ok(rich.text.indexOf(expression) < rich.text.indexOf("中") && rich.text.indexOf("中") < rich.text.indexOf(ordinary));
  assert.match(rich.text, /不代表发送者真实情绪或意图/);

  const files = new WorldFiles(path.join(f.dir, "world")); await files.ensure();
  const c = new BotContext(files); await c.load();
  c.attachmentLoader = createAttachmentLoader(f.store, { image: true, audio: false, video: false }, logger);
  await c.appendEvent({ id: c.nextEventId(), source: "koishi", content: rich.text, parts: rich.parts, attachments: rich.attachments, worldTime: 1 });
  const first = await c.toChatMessages("T1");
  const wire = first.flatMap(message => Array.isArray(message.content) ? message.content : []);
  const native = wire.filter(part => part.type === "image_url");
  assert.equal(native.length, 2, "same-event image/expression occurrences both retain their original position");
  for (const part of native) assert.equal(part.image_url.url, dataUrl(png));
  const reloaded = new BotContext(files); await reloaded.load(); reloaded.attachmentLoader = c.attachmentLoader;
  assert.deepEqual(await reloaded.toChatMessages("T1"), first, "rendering discriminator persists across restart");

  const textOnly = new MediaRenderer(f.store, f.captioner, () => false, 0);
  const plain = await textOnly.render(mediaPlaceholder(f.id, "image", true));
  assert.match(plain.text, /会话表情包/); assert.ok(plain.text.includes(expression)); assert.equal(plain.attachments, undefined);
  assert.equal(f.requests.length, 2, "changing native capability does not add recognition requests");

  const unknown = mediaPart(f.ref, { sticker: true, summary: "旧图像摘要", galleryNote: "我用于自嘲，不确定别人怎么理解" });
  const text = mediaText(unknown);
  assert.ok(!text.includes("旧图像摘要")); assert.match(text, /未缓存用途提示/);
  assert.match(text, /收藏备注（你自己的选用线索，不是原图识别或发送者意图）/);
  const ordinaryNote = mediaText(mediaPart(f.ref, { summary: ordinary, galleryNote: "我的选用备注" }));
  assert.ok(ordinaryNote.indexOf(ordinary) < ordinaryNote.indexOf("收藏备注"));
}

async function unchangedHistoricalPrefix() {
  const f = await fixture();
  const legacy: Extract<RichTextPart, { kind: "media" }> = {
    kind: "media", ref: f.ref, sticker: true, name: "过去的名字", marker: "[图片#1：猫 & 字幕]",
  };
  const expected = `<media ref="media:${f.id}" type="image" usage="sticker" name="过去的名字">\n表情包（按表情使用）；文字摘要（可能有误）：猫 &amp; 字幕\n`;
  assert.equal(mediaOpen(legacy), expected);
  assert.equal(richPartsText([{ kind: "text", text: "旧消息" }, legacy]), "旧消息" + expected + "此处仅保留媒体身份与文字摘要，未展开原始媒体\n</media>");
  const v1 = { ...mediaPart(f.ref), presentation: "media-v1" as const };
  const oldOpen = `<media ref="media:${f.id}" type="image">\n图片；暂无文字摘要\n`;
  assert.equal(mediaOpen(v1, true), oldOpen, "v1 native request headers retain their exact historical bytes");
  assert.equal(mediaText(v1), oldOpen + "此处仅保留媒体身份与文字摘要，未展开原始媒体\n</media>");
  const expressionV1 = { ...mediaPart(f.ref, { sticker: true, expressionSummary: expression }), presentation: "expression-v1" as const };
  assert.equal(mediaOpen(expressionV1, true), mediaOpen(expressionV1), "v1 expression headers must not gain the new native status line");
  const files = new WorldFiles(path.join(f.dir, "legacy")); await files.ensure();
  const c = new BotContext(files); await c.load();
  c.attachmentLoader = createAttachmentLoader(f.store, { image: true, audio: false, video: false }, logger);
  await c.appendEvent({ id: c.nextEventId(), source: "koishi", content: mediaText(legacy), parts: [legacy], attachments: [f.ref], worldTime: 1 });
  await c.appendEvent({ id: c.nextEventId(), source: "koishi", content: mediaText(v1), parts: [v1], attachments: [f.ref], worldTime: 1 });
  await c.appendEvent({ id: c.nextEventId(), source: "koishi", content: mediaText(expressionV1), parts: [expressionV1], attachments: [f.ref], worldTime: 1 });
  const prefix = await c.toChatMessages("T1");
  const before = await fs.readFile(path.join(files.base, "stream.jsonl"), "utf8");
  const current = mediaPart(f.ref, { sticker: true, expressionSummary: expression });
  await c.appendEvent({ id: c.nextEventId(), source: "koishi", content: mediaText(current), parts: [current], attachments: [f.ref], worldTime: 2 });
  const restarted = new BotContext(files); await restarted.load(); restarted.attachmentLoader = c.attachmentLoader;
  const after = await restarted.toChatMessages("T1");
  assert.deepEqual(after.slice(0, prefix.length), prefix, "new expression rendering cannot change a pre-upgrade media prefix after restart");
  assert.ok((await fs.readFile(path.join(files.base, "stream.jsonl"), "utf8")).startsWith(before));
  assert.equal((restarted.stream[0] as any).event.parts[0].presentation, undefined);
  const oldFiles = new WorldFiles(path.join(f.dir, "without-parts")); await oldFiles.ensure();
  const noParts = new BotContext(oldFiles); await noParts.load(); noParts.attachmentLoader = c.attachmentLoader;
  await noParts.appendEvent({ id: noParts.nextEventId(), source: "koishi", content: "旧消息", attachments: [f.ref], worldTime: 1 });
  const historical = JSON.stringify((await noParts.toChatMessages("T1")).slice(1));
  assert.match(historical, /原始插入位置未记录/);
  assert.ok(historical.includes(JSON.stringify(oldOpen).slice(1, -1)));
  assert.doesNotMatch(historical, /以下为消息原位置的原始/, "unknown legacy positions must not gain a new claim of inline ordering");
}

async function main() {
  try {
    await captionUsageCaches(); await renderPerOccurrence(); await unchangedHistoricalPrefix();
    console.log("PASS stickers: per-occurrence semantics, independent caption/detail caches, one recognition pass, uncertainty boundaries, ordered exact native bytes, personal notes and frozen legacy restart rendering");
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const dir of directories) await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
