import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { BotContext } from "../src/bot/context.js";
import { BotAgent } from "../src/bot/agent.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Gateway } from "../src/koishi/gateway.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { normalizeMsgId } from "../src/koishi/markers.js";
import { MediaStore } from "../src/media/store.js";
import { GalleryStore } from "../src/media/gallery.js";
import { MediaRenderer, mediaPlaceholder } from "../src/media/render.js";
import { mediaPart, mediaSendTag, parseMediaId, richPartsText } from "../src/media/presentation.js";
import { createAttachmentLoader } from "../src/media/parts.js";
import type { ContentPart } from "../src/llm/chat.js";
import type { MediaRef, RichText } from "../src/types.js";

const logger = { info() {}, debug() {}, warn() {}, error() {} };
const png = (label: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]);
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
const rootDirs: string[] = [];
async function temp(prefix: string) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); rootDirs.push(dir); return dir; }
function database() {
  const tables = new Map<string, any[]>();
  const rows = (table: string) => { if (!tables.has(table)) tables.set(table, []); return tables.get(table)!; };
  const matches = (row: any, query: any) => Object.entries(query).every(([key, value]) => row[key] === value);
  return {
    async get(table: string, query: any, opts?: any) {
      let selected = rows(table).filter(row => matches(row, query));
      if (opts?.sort) selected = selected.slice().sort((a, b) => b.id - a.id);
      return selected.slice(0, opts?.limit).map(row => ({ ...row }));
    },
    async create(table: string, value: any) { const row = { id: rows(table).length + 1, ...value }; rows(table).push(row); return row; },
    async set(table: string, query: any, value: any) { for (const row of rows(table)) if (matches(row, query)) Object.assign(row, value); },
    async remove(table: string, query: any) { tables.set(table, rows(table).filter(row => !matches(row, query))); },
  };
}
async function fixture() {
  const root = await temp("yesimbot-multimodal-");
  const ctx = { model: { extend() {} }, database: database(), bots: [] } as any;
  const media = new MediaStore(ctx, path.join(root, "assets"), 100_000, logger as any);
  const gallery = new GalleryStore(ctx, path.join(root, "gallery")); await gallery.ensureDirs();
  const ids = await Promise.all(["CAT", "DOG", "BIRD"].map(label => media.ingest(dataUrl(png(label)), "image")));
  const refs = await Promise.all(ids.map(async id => (await media.get(id!))!.ref));
  for (const [i, summary] of ["猫的摘要", "狗的摘要", "鸟的摘要"].entries()) await media.setSummary(ids[i]!, summary);
  const captionCalls: { id: number; sticker: boolean; detailed?: boolean }[] = [];
  const captioner = {
    describe: async (ref: MediaRef, options: { sticker?: boolean } = {}) => {
      captionCalls.push({ id: ref.id, sticker: !!options.sticker });
      return options.sticker ? "可能用途：轻松表示收到；正式拒绝的场合容易误读" : (await media.get(ref.id))?.summary || null;
    },
    describeDetailed: async (ref: MediaRef, options: { sticker?: boolean } = {}) => {
      captionCalls.push({ id: ref.id, sticker: !!options.sticker, detailed: true });
      return options.sticker ? "可能用途：轻松表示收到；不代表原发送者的真实意图" : `详细：${(await media.get(ref.id))?.summary}`;
    },
  } as any;
  const renderer = new MediaRenderer(media, captioner, () => true, 8);
  const messenger = Object.create(KoishiMessenger.prototype) as any;
  const sent: any[][] = [], stored: string[] = [];
  const cfg = Config({});
  const bot = { platform: "fixture", selfId: "self", sendMessage: async (_channel: string, elements: any[]) => { sent.push(elements); return [`sent-${sent.length}`]; } };
  Object.assign(messenger, { media, galleryStore: gallery, renderer, captioner, ctx: { bots: [bot] }, ops: cfg.platformOps,
    messaging: { ...cfg.messaging, coldChannelMsgs: 0, selfCommands: false }, focus: { focus: async () => {} },
    names: { display: async () => "测试群" }, store: { knownChannels: async () => [] },
    ownSends: { expect() {}, unexpect() {} }, clockInfo: () => null,
    resolveBot: async () => ({ bot, platform: "fixture", channelId: "private:peer", isDirect: true }),
    storeSelf: async (_target: any, content: string) => { stored.push(content); },
  });
  return { root, media, gallery, refs, renderer, messenger, sent, stored, captionCalls };
}
async function context(root: string) {
  const files = new WorldFiles(root); await files.ensure();
  const context = new BotContext(files, ""); await context.load();
  return context;
}
async function append(context: BotContext, rich: RichText) {
  const event = { id: context.nextEventId(), source: "koishi" as const, content: rich.text, attachments: rich.attachments, parts: rich.parts, worldTime: 1 };
  await context.appendEvent(event); return event;
}
const contentParts = (messages: Awaited<ReturnType<BotContext["toChatMessages"]>>) => messages.flatMap(message => message.role === "system" ? [] : typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content);
const images = (parts: ContentPart[]) => parts.filter((part): part is Extract<ContentPart, { type: "image_url" }> => part.type === "image_url");
function binding(parts: ContentPart[], ref: MediaRef, summary: string) {
  const index = parts.findIndex(part => part.type === "image_url" && part.image_url.url === dataUrl(png(summary === "猫的摘要" ? "CAT" : "DOG")));
  assert.ok(index > 0);
  const preceding = parts[index - 1];
  assert.equal(preceding?.type, "text");
  if (preceding?.type === "text") { assert.ok(preceding.text.includes(`ref="media:${ref.id}"`)); assert.ok(preceding.text.includes(summary)); }
  const following = parts[index + 1]; assert.equal(following?.type, "text");
  if (following?.type === "text") assert.ok(following.text.startsWith("\n</media>"));
}
async function inboundAndCache() {
  const f = await fixture(), [cat, dog, bird] = f.refs as [MediaRef, MediaRef, MediaRef];
  const gateway = Object.create(Gateway.prototype) as any; Object.assign(gateway, { media: f.media });
  const stored = await gateway.serializeElements([h.text("左边"), h.image(dataUrl(png("CAT"))), h.text("中间"), h.image(dataUrl(png("DOG"))), h.text("右边")]);
  const rich = await f.renderer.render(stored);
  assert.ok(rich.text.includes(`media:${cat.id}`)); assert.ok(rich.text.includes("猫的摘要"));
  assert.equal(rich.text, richPartsText(rich.parts!));
  const c = await context(path.join(f.root, "context"));
  c.maxAttachmentsPerRequest = 2;
  const modalities = { image: true, audio: true, video: true };
  c.attachmentLoader = createAttachmentLoader(f.media, modalities, logger as any);
  await append(c, rich);
  let name = "原名字"; c.botNameProvider = () => name; c.accountsProvider = () => name;
  c.approxChars(); // Size estimation must not freeze the wake-time/system projection.
  const first = await c.toChatMessages("起点"); const firstParts = contentParts(first);
  binding(firstParts, cat, "猫的摘要"); binding(firstParts, dog, "狗的摘要");
  const joined = firstParts.filter(p => p.type === "text").map(p => p.text).join("|");
  assert.ok(joined.indexOf("左边") < joined.indexOf("猫的摘要") && joined.indexOf("猫的摘要") < joined.indexOf("中间") && joined.indexOf("中间") < joined.indexOf("狗的摘要") && joined.indexOf("狗的摘要") < joined.indexOf("右边"));
  name = "新名字"; modalities.image = false; c.attachmentLoader.clearCache?.();
  const unchanged = await c.toChatMessages("不应改写起点"); assert.deepEqual(unchanged, first);
  modalities.image = true;
  const sizeBeforeReread = c.approxChars(), textBeforeReread = c.renderStreamText().length;
  await append(c, rich);
  const reread = await c.toChatMessages("起点");
  assert.deepEqual(reread.slice(0, first.length), first);
  assert.equal(images(contentParts(reread)).length, 2, "rereading history reuses the prior exact image instead of spending another attachment slot");
  assert.equal(c.attachmentBudgetExceeded, false, "the same two images cannot force premature memory compression");
  assert.match(JSON.stringify(reread.at(-1)), /已在事件 ev_1 中展开/);
  assert.equal(c.approxChars() - sizeBeforeReread, c.renderStreamText().length - textBeforeReread, "approximate size also counts unique media, so historical rereads do not fake attachment overflow");
  await c.appendToolCall({ id: c.nextToolId(), name: "view_media", arguments: { media: [`media:${bird.id}`] }, issuedAt: 1, expectedAt: 1 });
  await append(c, await f.renderer.render(mediaPlaceholder(bird.id, "image")));
  const after = await c.toChatMessages("起点");
  assert.deepEqual(after.slice(0, first.length), first, "a new over-budget image must not evict/rewrite old image messages");
  assert.equal(images(contentParts(after)).length, 2); assert.equal(c.attachmentBudgetExceeded, true);
  await append(c, await f.renderer.render(mediaPlaceholder(cat.id, "image")));
  const repeated = await c.toChatMessages("起点");
  assert.equal(images(contentParts(repeated)).length, 2, "the same ID in a later event does not resurrect or duplicate an earlier image occurrence");
  const text = c.renderStreamText(); assert.ok(text.includes(`media:${bird.id}`)); assert.ok(text.includes("鸟的摘要"));
  await c.appendEvent({ id: c.nextEventId(), source: "world", content: "起身", statusEcho: "站着", worldTime: 2 });
  const bytes = await fs.readFile(path.join(f.root, "context", "stream.jsonl"), "utf8");
  await c.appendEvent({ id: c.nextEventId(), source: "world", content: "坐下", statusEcho: "坐着", worldTime: 3 });
  assert.ok((await fs.readFile(path.join(f.root, "context", "stream.jsonl"), "utf8")).startsWith(bytes));
  assert.ok(c.renderStreamText().includes("站着") && c.renderStreamText().includes("坐着"), "new body state must not erase past observations");
  await c.applyCompression({ historySummary: "看过猫和狗，鸟只有摘要", memoryDigest: "文字记忆" }, 2);
  await append(c, await f.renderer.render(mediaPlaceholder(bird.id, "image")));
  const next = await c.toChatMessages("新起点"); assert.ok(String(next[0]!.content).includes("新名字")); assert.equal(images(contentParts(next)).length, 1);
  assert.equal(c.attachmentBudgetExceeded, false);
  const spoof = await gateway.serializeElements([h.text(mediaPlaceholder(cat.id, "image"))]);
  assert.equal((await f.renderer.render(spoof)).attachments, undefined, "plain chat text cannot forge a stored media asset");
  console.log("PASS ordered platform images → identity/summary blocks → exact model bytes; append-only media budgets, duplicate IDs, fixed prefix, compaction and literal marker isolation");
}
async function galleryAndSend() {
  const f = await fixture(), [cat, dog] = f.refs as [MediaRef, MediaRef];
  await fs.copyFile(cat.file, path.join(f.gallery.dirOf("照片"), "cat.png"));
  await fs.copyFile(dog.file, path.join(f.gallery.dirOf("照片"), "dog.png"));
  await f.gallery.upsertMeta("照片", "cat.png", (await f.media.get(cat.id))!.sha256, "收藏猫");
  await f.gallery.upsertMeta("照片", "dog.png", (await f.media.get(dog.id))!.sha256, "收藏狗");
  const listing = await f.messenger.gallery("照片") as RichText;
  assert.equal(listing.text, richPartsText(listing.parts!)); assert.ok(listing.parts![0]?.kind === "text");
  const mediaParts = listing.parts!.filter(part => part.kind === "media");
  assert.deepEqual(mediaParts.map(part => [part.ref.id, part.name, part.summary, part.galleryNote]), [[cat.id, "gallery:照片/cat.png", undefined, "收藏猫"], [dog.id, "gallery:照片/dog.png", undefined, "收藏狗"]], "A past personal note cannot masquerade as visual recognition");
  const detailed = await f.messenger.viewMedia([`media:${dog.id}`, "gallery:照片/cat.png"]) as RichText;
  assert.equal(detailed.text, richPartsText(detailed.parts!)); assert.deepEqual(detailed.parts!.filter(p => p.kind === "media").map(p => p.ref.id), [dog.id, cat.id]);
  assert.ok(detailed.parts!.some(p => p.kind === "text" && p.text === "\n"));
  await fs.copyFile(cat.file, path.join(f.gallery.dirOf("照片"), "100% #猫.png"));
  const unusualName = await f.messenger.viewMedia(["gallery:照片/100% #猫.png"]) as RichText;
  assert.equal(unusualName.attachments?.[0]?.id, cat.id, "file URLs must preserve literal %, #, spaces and non-ASCII names");
  const file = path.join(f.gallery.dirOf("照片"), "cat.png"); await fs.writeFile(file, png("DOG"));
  const replaced = await f.gallery.findMeta("照片", "cat.png"); assert.equal(replaced?.description, "收藏狗"); assert.equal(replaced?.name, "cat.png");
  assert.equal(await f.gallery.findBySha((await f.media.get(cat.id))!.sha256), null, "same file name cannot impersonate the replaced image hash");
  await fs.copyFile(dog.file, path.join(f.gallery.dirOf("meme"), "dog.png")); assert.equal(await f.gallery.resolve("dog.png"), null, "ambiguous file names must not pick a category by iteration order");
  for (const ref of ["msg:1", "附件1", "图片#1", "https://image.invalid/1", "garbage1"]) assert.equal(parseMediaId(ref), null);
  const before = f.sent.length; const bad = await f.messenger.send("fixture:private:peer", "hello", ["msg:1"]); assert.ok(bad.includes("没有发出")); assert.equal(f.sent.length, before);
  assert.ok((await f.messenger.send("fixture:private:peer", "hello [图片#1]")).includes("没有发出"));
  // Ingress marks cat as a platform sticker. Sending A/sticker/B/image/C must retain that order across batches.
  await f.media.ingest(dataUrl(png("CAT")), "image", undefined, undefined, true);
  const output = await f.messenger.send("fixture:private:peer", `甲 ${mediaSendTag(cat)} 乙 ${mediaSendTag(dog)} 丙`);
  assert.ok(output.startsWith("消息已发送")); assert.equal(f.sent.length, 3);
  assert.deepEqual(f.stored, ["甲 ", mediaPlaceholder(cat.id, "image", true), ` 乙 ${mediaPlaceholder(dog.id, "image", false)} 丙`]);
  const all = f.sent.flat(); const emitted = all.filter(el => el.type === "img");
  assert.equal(emitted[0].attrs.src, dataUrl(png("CAT"))); assert.equal(emitted[1].attrs.src, dataUrl(png("DOG")));
  // A missing/corrupt cached file is never silently paired with an old summary.
  await fs.writeFile(cat.file, png("DOG")); await assert.rejects(f.media.readFile(cat), /已被替换/);
  assert.equal(await f.media.ingest(dataUrl(png("CAT")), "image"), cat.id); assert.deepEqual(await f.media.readFile(cat), png("CAT"));
  // Selection is independent from sending: no hidden auto-send buffer or occurrence slots.
  const chooser = Object.create(BotAgent.prototype) as any; let selected: string = "";
  chooser.messenger = f.messenger; chooser.dispatchLocal = (_call: unknown, fn: () => Promise<string | RichText>) => fn().then(result => { selected = typeof result === "string" ? result : result.contextHint?.text ?? result.text; });
  const sendCount = f.sent.length;
  await chooser.dispatchPickMedia({ arguments: { media: [`media:${dog.id}`, `media:${cat.id}`] } });
  assert.ok(selected.includes("尚未发送")); assert.ok(selected.indexOf(mediaSendTag(dog)) < selected.indexOf(mediaSendTag(cat))); assert.equal(f.sent.length, sendCount);
  f.messenger.storeSelf = async () => { throw new Error("database unavailable after platform success"); };
  f.messenger.focus.focus = async () => { throw new Error("focus file unavailable"); };
  const confirmed = await f.messenger.send("fixture:private:peer", "已提交");
  assert.ok(confirmed.startsWith("消息已发送")); assert.ok(confirmed.includes("不要重复发送")); assert.equal(f.sent.length, sendCount + 1);
  chooser.logger = logger; chooser.config = { messaging: { sendEcho: true } };
  chooser.messenger.channelMessages = async () => { throw new Error("echo unavailable"); };
  const echoFailure = await chooser.echoChannelRecent("fixture:private:peer", confirmed);
  assert.ok(echoFailure.text.startsWith("消息已发送"));
  assert.match(echoFailure.text, /不要因回显缺失重复发送/);
  console.log("PASS gallery names/summaries verified against asset hashes, strict ref parsing, read-only selection, exact outgoing image bytes and sticker/text ordering");
}
async function optionalGalleryWorkflow() {
  const f = await fixture(), [cat, dog] = f.refs as [MediaRef, MediaRef];
  const toolText = ["check_gallery", "check_media", "view_media", "gallery_save", "gallery_move", "pick_media"]
    .map(name => BOT_TOOLS.find(tool => tool.name === name)!.description).join("\n");
  assert.doesNotMatch(toolText, /看到喜欢|发图先来这里|有空时看看|别偷懒|必须先 view_media/);
  assert.match(toolText, /先确定自己想表达的态度或接话方式/);
  assert.match(toolText, /选中不等于已发/);
  const empty = await f.messenger.gallery();
  assert.match(empty.text, /无需先收藏/);
  await fs.copyFile(cat.file, path.join(f.gallery.dirOf("未整理"), "cat.png"));
  const overview = await f.messenger.gallery();
  assert.match(overview.text, /未整理不是待办/);
  const beforeMove = f.captionCalls.length;
  const moved = await f.messenger.galleryMove("未整理/cat.png", "表情包");
  assert.match(moved, /移进了「表情包」/);
  assert.match(moved, /没有发送消息/);
  assert.equal(f.captionCalls.length, beforeMove, "Classification does not compel a caption request or explanatory task");
  assert.deepEqual(await fs.readFile(path.join(f.gallery.dirOf("表情包"), "cat.png")), png("CAT"));
  const note = "我可以用来轻松表示收到；不适合正式拒绝，可能被读成敷衍";
  const updated = await f.messenger.galleryMove("表情包/cat.png", "表情包", note);
  assert.match(updated, /选用备注已更新/);
  assert.equal((await f.gallery.findMeta("表情包", "cat.png"))?.description, note, "Same-category note edits must not be silently ignored");
  const listing = await f.messenger.gallery("表情包") as RichText;
  const stickerPart = listing.parts!.find(part => part.kind === "media");
  assert.ok(stickerPart?.kind === "media");
  assert.equal(stickerPart.ref.id, cat.id); assert.equal(stickerPart.galleryNote, note);
  assert.equal(stickerPart.summary, undefined, "Sticker purpose and personal note cannot become a visual-summary fact");
  assert.match(stickerPart.expressionSummary!, /轻松表示收到/);
  assert.doesNotMatch(stickerPart.expressionSummary!, /猫的摘要/);
  const cache = await f.messenger.checkMedia(10, "image");
  assert.match(cache, new RegExp(`表情包 media:${cat.id}`));
  assert.match(cache, /可能表意（非原发送者意图）/);
  assert.match(cache, /你的收藏备注（非原图识别）/);
  assert.doesNotMatch(cache, /猫的摘要/, "Legacy visual cache is not served as conversational-use interpretation");
  const inspected = await f.messenger.viewMedia([`media:${cat.id}`]) as RichText;
  const inspectedPart = inspected.parts!.find(part => part.kind === "media");
  assert.ok(inspectedPart?.kind === "media"); assert.equal(inspectedPart.ref.id, cat.id);
  assert.equal(inspectedPart.galleryNote, note); assert.match(inspectedPart.expressionSummary!, /轻松表示收到/);
  assert.deepEqual(inspected.attachments?.map(ref => ref.id), [cat.id]);
  f.messenger.renderer = new MediaRenderer(f.media, f.messenger.captioner, () => false, 0);
  const textOnly = await f.messenger.viewMedia([`media:${cat.id}`]) as RichText;
  assert.equal(textOnly.attachments, undefined); assert.match(textOnly.text, /轻松表示收到/);
  assert.match(textOnly.text, /不代表原发送者/); assert.doesNotMatch(textOnly.text, /猫的摘要/);
  assert.ok(f.captionCalls.some(call => call.id === cat.id && call.sticker && call.detailed), "Text-only inspection uses the same sticker interpretation contract");
  const saved = await f.messenger.gallerySave(`media:${dog.id}`, "照片", "我记录的散步照片", "walk.png");
  assert.match(saved, /你的选用备注/); assert.match(saved, /没有发送消息/);
  assert.equal(f.sent.length, 0, "Browsing, classification and collection never announce or send anything");
  assert.deepEqual(await fs.readFile(path.join(f.gallery.dirOf("照片"), "walk.png")), png("DOG"));
  const picked = await f.messenger.resolveMediaRefs([`media:${cat.id}`, "gallery:照片/walk.png"]);
  assert.deepEqual(picked.map((item: any) => [item.ok, item.ref.id, item.sticker]), [[true, cat.id, true], [true, dog.id, false]]);
  assert.equal(f.sent.length, 0);
  console.log("PASS optional gallery workflow: expression-first tool guidance, no collection task, optional notes, real note edits, unchanged assets and selection without sending");
}
async function selectedGalleryUsageSurvivesSending() {
  const f = await fixture(), cat = f.refs[0]!;
  await f.media.ingest(dataUrl(png("CAT")), "image", undefined, undefined, true);
  for (const category of ["照片", "表情包"]) await fs.copyFile(cat.file, path.join(f.gallery.dirOf(category), "cat.png"));
  const chooser = Object.create(BotAgent.prototype) as any; let selected = "";
  chooser.messenger = f.messenger;
  chooser.dispatchLocal = (_call: unknown, run: () => Promise<string | RichText>) => run().then(result => { selected = typeof result === "string" ? result : result.contextHint?.text ?? result.text; });
  const refs = ["gallery:照片/cat.png", "gallery:表情包/cat.png", "gallery:照片/cat.png"];
  await chooser.dispatchPickMedia({ arguments: { media: refs } });
  const tags = [...selected.matchAll(/<media ref="([^"]+)"\/>/g)];
  assert.deepEqual(tags.map(match => match[1]), refs, "Selection must retain gallery usage rather than substitute its identical asset ID");
  assert.match(selected, /尚未发送/); assert.equal(f.sent.length, 0);

  // Use the real successful-send recorder and ordinary readback, with an in-memory store.
  const rows: any[] = [];
  f.messenger.storeSelf = (KoishiMessenger.prototype as any).storeSelf;
  f.messenger.store = {
    captureReceipt: () => undefined,
    store: async (row: any) => { rows.push({ ...row, id: rows.length + 1 }); },
    channelMessages: async () => rows,
  };
  f.messenger.names.identity = async () => ({ platform: "fixture", channelId: "private:peer", selfId: "self", accountIds: ["self"], displayName: "真实账号名", source: "account_name", text: "此处使用你的真实账号名。" });
  f.messenger.resolveChannel = async () => ({ platform: "fixture", channelId: "private:peer", selfId: "self", isDirect: true });
  f.messenger.notify = { channelStatusText: () => "通知已开启" };
  f.messenger.muteHint = async () => "";
  const sent = await f.messenger.send("fixture:private:peer", `甲${tags[0]![0]}乙${tags[1]![0]}丙${tags[2]![0]}丁`);
  assert.match(sent, /^消息已发送/);
  const emitted = f.sent.flat().filter(element => element.type === "img");
  assert.deepEqual(emitted.map(element => element.attrs.sub_type ?? element.attrs.subType), [undefined, 1, undefined]);
  assert.deepEqual(emitted.map(element => element.attrs.src), [dataUrl(png("CAT")), dataUrl(png("CAT")), dataUrl(png("CAT"))]);
  assert.deepEqual(rows.map(row => row.content), [`甲${mediaPlaceholder(cat.id, "image", false)}乙`, mediaPlaceholder(cat.id, "image", true), `丙${mediaPlaceholder(cat.id, "image", false)}丁`]);
  assert.deepEqual(rows.map(row => row.conversation.mediaCounts), [{ image: 1 }, { sticker: 1 }, { image: 1 }]);
  assert.deepEqual(rows.map(row => row.conversation.hasText), [true, false, true]);
  assert.ok(rows.every(row => row.senderOrigin === "tool" && row.senderOwned === true));
  const reread = await f.messenger.channelMessages("fixture:private:peer", 10) as RichText;
  assert.match(reread.text, /真实账号名.*已确认经聊天工具发送/s);
  assert.match(reread.text, /附有图片×1.*仅含表情包×1.*未附文字.*附有图片×1/s);
  assert.deepEqual(reread.parts!.filter(part => part.kind === "media").map(part => [part.ref.id, !!part.sticker]), [[cat.id, false], [cat.id, true], [cat.id, false]], "Readback keeps the actual use of each occurrence, not the asset's historical sticker flag");

  const unusual = 'a\'"<cat>.png';
  await fs.copyFile(cat.file, path.join(f.gallery.dirOf("照片"), unusual));
  const unusualRef = `gallery:照片/${unusual}`;
  await chooser.dispatchPickMedia({ arguments: { media: [unusualRef] } });
  const safeReference = selected.match(/send\.media 引用 ("(?:\\.|[^"\\])*")/);
  assert.ok(safeReference, "A filename unsupported by the inline grammar must be returned as a JSON string reference");
  assert.equal(JSON.parse(safeReference[1]!), unusualRef);
  assert.ok(!selected.includes('<media ref="gallery:'), "Selection must not emit malformed inline tags");
  const before = f.sent.length;
  await f.messenger.send("fixture:private:peer", "", [JSON.parse(safeReference[1]!), refs[1]]);
  assert.deepEqual(f.sent.slice(before).flat().filter(element => element.type === "img").map(element => element.attrs.sub_type ?? element.attrs.subType), [undefined, 1], "Array references also preserve explicit classification and selection order");
  await chooser.dispatchPickMedia({ arguments: { media: [String(cat.id)] } });
  assert.ok(selected.includes(`<media ref="media:${cat.id}"/>`), "Bare numeric asset selections still canonicalize");
  console.log("PASS selected gallery usage: shared bytes retain photo/sticker/photo semantics and text order, safe quoted filenames, confirmed-store/readback counts and unchanged asset references");
}
async function repeatedMediaBoundaries() {
  const f = await fixture(), [cat, dog] = f.refs as [MediaRef, MediaRef];
  const rich = await f.renderer.render(`第一次猫${mediaPlaceholder(cat.id, "image")}中间狗${mediaPlaceholder(dog.id, "image")}再看猫${mediaPlaceholder(cat.id, "image")}`);
  const root = path.join(f.root, "repeat-boundaries"), c = await context(root);
  const loader = createAttachmentLoader(f.media, { image: true, audio: true, video: true }, logger as any);
  c.attachmentLoader = loader; c.maxAttachmentsPerRequest = 3;
  await append(c, rich);
  const first = await c.toChatMessages("T1");
  assert.deepEqual(images(contentParts(first)).map(part => part.image_url.url), [dataUrl(png("CAT")), dataUrl(png("DOG")), dataUrl(png("CAT"))], "A/B/A is rendered at all three original positions, without a forward reference inside the current event");
  assert.doesNotMatch(JSON.stringify(first.at(-1)), /已在事件/);
  const rawBefore = await fs.readFile(path.join(root, "stream.jsonl"), "utf8");
  await append(c, rich);
  const repeated = await c.toChatMessages("T1");
  assert.deepEqual(repeated.slice(0, first.length), first);
  assert.equal(images(contentParts(repeated)).length, 3);
  assert.equal(c.attachmentBudgetExceeded, false);
  assert.equal((JSON.stringify(repeated.at(-1)).match(/已在事件 ev_1 中展开/g) ?? []).length, 3);
  assert.ok((await fs.readFile(path.join(root, "stream.jsonl"), "utf8")).startsWith(rawBefore));
  const reloaded = await context(root); reloaded.attachmentLoader = loader; reloaded.maxAttachmentsPerRequest = 3;
  assert.deepEqual(await reloaded.toChatMessages("T1"), repeated, "reloading does not revise settled media occurrences or budget decisions");

  // Pre-upgrade events keep their original repetition/attachment admission rules.
  const legacyRoot = path.join(f.root, "legacy-media"), legacy = await context(legacyRoot);
  const oldEvents = [1, 2].map(n => ({ kind: "event", event: { id: `ev_${n}`, source: "koishi", content: rich.text, parts: rich.parts, attachments: rich.attachments, worldTime: n } }));
  const legacyBytes = oldEvents.map(event => JSON.stringify(event)).join("\n") + "\n";
  await fs.writeFile(path.join(legacyRoot, "stream.jsonl"), legacyBytes);
  await legacy.load(); legacy.attachmentLoader = loader; legacy.maxAttachmentsPerRequest = 6;
  const oldRequest = await legacy.toChatMessages("T1");
  assert.equal(images(contentParts(oldRequest)).length, 6, "absence of the persisted new-event marker preserves legacy rendering");
  await append(legacy, rich);
  const afterNew = await legacy.toChatMessages("T1");
  assert.deepEqual(afterNew.slice(0, oldRequest.length), oldRequest);
  assert.equal(images(contentParts(afterNew)).length, 6);
  assert.ok((await fs.readFile(path.join(legacyRoot, "stream.jsonl"), "utf8")).startsWith(legacyBytes));
  const reloadOld = await context(legacyRoot); reloadOld.attachmentLoader = loader; reloadOld.maxAttachmentsPerRequest = 6;
  assert.deepEqual(await reloadOld.toChatMessages("T1"), afterNew);

  const retry = await context(path.join(f.root, "media-load-failure")); retry.maxAttachmentsPerRequest = 3;
  let fail = true;
  retry.attachmentLoader = async ref => { if (fail && ref.id === dog.id) { fail = false; throw Error("temporary read failure"); } return loader(ref); };
  await append(retry, rich);
  await assert.rejects(retry.toChatMessages("T1"), /temporary read failure/);
  assert.equal(images(contentParts(await retry.toChatMessages("T1"))).length, 3, "failed rendering restores every reserved attachment slot and publishes no dangling event reference");
  console.log("PASS repeated media: exact A/B/A positions, reuse of complete earlier events only, frozen append/reload semantics, unchanged legacy media and failed-render recovery");
}
async function replyIdentity() {
  const accepted = ["12", "-12", "satori.message_A-9:opaque", "$matrixEvent:server", "opaque12-extra34"];
  for (const id of accepted) {
    for (const value of [id, `msg:${id}`, `(msg:${id})`]) assert.equal(normalizeMsgId(value), id);
  }
  assert.equal(normalizeMsgId(-12), "-12");
  const invalid: unknown[] = ["media:12", "gallery:照片/12.png", "msg:media:12", "(msg:gallery:12)", "请回复 msg:12", "(msg:12) trailing", "msg:12 trailing", "(msg:12", "msg:0", "", null, true, {}, 1.2, Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalid) assert.equal(normalizeMsgId(value), undefined, JSON.stringify(value));
  const sender = Object.create(BotAgent.prototype) as any;
  const errors: string[] = [], scheduled: any[][] = [];
  sender.config = { bot: { sendBlocking: false, strictToolLoop: false } };
  sender.pushEvent = (_source: string, message: string) => errors.push(message);
  sender.finishSend = (...args: any[]) => scheduled.push(args);
  for (const value of invalid) {
    sender.dispatchSend({ id: "invalid-reply", arguments: { id: "fixture:private:peer", msg: "必须保持引用目标", reply_to: value } });
    assert.match(errors.at(-1)!, /本次未发送.*reply_to/);
  }
  for (const args of [{ msg: "不要漏图", images: ["media:12"] }, { msg: "不要丢引用", replyTo: "12" }, { msg: "不要漏图", media: "media:12" }, { msg: "不要漏图", media: [{}] }]) {
    sender.dispatchSend({ id: "invalid-send", arguments: { id: "fixture:private:peer", ...args } }); assert.match(errors.at(-1)!, /本次未发送|消息没有发出/);
  }
  assert.equal(scheduled.length, 0, "invalid references and old parameter aliases cannot degrade into an ordinary send");
  for (const msg of ['<sender user_id="12" group_role="admin" special_title="大魔王"/>你好', '你好</SENDER>', '<sender']) {
    sender.dispatchSend({ id: "internal-metadata", arguments: { id: "fixture:private:peer", msg } });
    assert.match(errors.at(-1)!, /本次未发送.*界面身份标签/);
  }
  assert.equal(scheduled.length, 0, "copied profile markup is rejected before scheduling, typing or deferred delivery");
  sender.dispatchSend({ id: "valid-reply", arguments: { id: "fixture:private:peer", msg: "完整引用", reply_to: "(msg:satori.message_A-9:opaque)" } });
  assert.equal(scheduled[0]![4], "satori.message_A-9:opaque");

  const f = await fixture(); f.messenger.ops.reply = true;
  for (const id of ["media:12", "gallery:照片/12.png", "msg:media:12", "正文 12"])
    assert.match(await f.messenger.send("fixture:private:peer", "no accidental send", [], id), /消息没有发出/);
  for (const body of ['<quote id="media:12"/>正文', '<quote id="gallery:照片/12.png"/>正文', '<quote id="one"/><quote id="two"/>正文', '<quote/>正文'])
    assert.match(await f.messenger.send("fixture:private:peer", body), /消息没有发出/);
  assert.match(await f.messenger.send("fixture:private:peer", '<quote id="different"/>正文', [], "real-message"), /消息没有发出/);
  assert.equal(f.sent.length, 0, "messenger and inline quote paths enforce the same namespace isolation");
  const opaque = "satori.message_A-9:opaque";
  f.messenger.store.findByMessageId = async (_platform: string, _channel: string, id: string) => id === opaque ? { messageId: opaque, userId: "peer", username: "朋友", content: "原消息" } : null;
  assert.match(await f.messenger.send("fixture:private:peer", "reply", [], `(msg:${opaque})`), /^消息已发送/);
  assert.equal(f.sent[0]!.find(el => el.type === "quote")?.attrs.id, opaque, "the platform receives the exact complete opaque ID");
  assert.match(await f.messenger.send("fixture:private:peer", `<quote id="msg:${opaque}"/>reply`), /^消息已发送/);
  assert.equal(f.sent[1]!.find(el => el.type === "quote")?.attrs.id, opaque);
  f.messenger.ops.reply = false;
  assert.match(await f.messenger.send("fixture:private:peer", "reply", [], opaque), /消息没有发出.*未启用引用回复/);
  assert.equal(f.sent.length, 2);
  console.log("PASS message/media namespace isolation, opaque platform reply IDs, canonical send parameters and identical inline-quote validation");
}
async function main() { try { await inboundAndCache(); await repeatedMediaBoundaries(); await galleryAndSend(); await optionalGalleryWorkflow(); await selectedGalleryUsageSurvivesSending(); await replyIdentity(); } finally { await Promise.all(rootDirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); } }
void main().catch(error => { console.error(error); process.exitCode = 1; });
