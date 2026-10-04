import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import { Gateway } from "../src/koishi/gateway.js";
import { ChatClient, type ChatMessage, type ContentPart } from "../src/llm/chat.js";
import { CaptionService } from "../src/media/captioner.js";
import { createAttachmentLoader, mediaToContentPart } from "../src/media/parts.js";
import { mediaPart, richPartsText } from "../src/media/presentation.js";
import { MediaRenderer } from "../src/media/render.js";
import { MediaStore } from "../src/media/store.js";
import type { MediaRef, RichTextPart } from "../src/types.js";

const warnings: unknown[][] = [];
const logger: any = { info() {}, debug() {}, error() {}, warn(...args: unknown[]) { warnings.push(args); } };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function wave(hz: number): Buffer {
  const rate = 8000, samples = 2400, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * hz / rate) * 8192), 44 + i * 2);
  return wav;
}
function assertWav(wav: Buffer): void {
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(4) + 8, wav.length);
  let format = false, samples = false;
  for (let i = 12; i + 8 <= wav.length;) {
    const name = wav.toString("ascii", i, i + 4), size = wav.readUInt32LE(i + 4), body = i + 8;
    assert.ok(body + size <= wav.length);
    if (name === "fmt ") {
      assert.equal(wav.readUInt16LE(body), 1);
      assert.equal(wav.readUInt16LE(body + 2), 1);
      assert.equal(wav.readUInt32LE(body + 4), 16000);
      assert.equal(wav.readUInt16LE(body + 14), 16);
      format = true;
    }
    if (name === "data") { assert.ok(size > 0 && size % 2 === 0); samples = true; }
    i = body + size + (size % 2);
  }
  assert.ok(format && samples);
}
function nativeAudio(part: ContentPart | null) {
  assert.equal(part?.type, "input_audio");
  assert.ok(part && part.type === "input_audio");
  assert.equal(part.input_audio.format, "wav");
  assertWav(Buffer.from(part.input_audio.data, "base64"));
  return part;
}
function contents(messages: ChatMessage[]): ContentPart[] {
  return messages.filter(message => message.role !== "system")
    .flatMap(message => typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content);
}
const audioParts = (messages: ChatMessage[]) => contents(messages).filter((part): part is Extract<ContentPart, { type: "input_audio" }> => part.type === "input_audio");
const textParts = (messages: ChatMessage[]) => contents(messages).filter(part => part.type === "text").map(part => part.text).join("\n");
function database() {
  const rows: any[] = [];
  const matches = (row: any, query: any) => Object.entries(query).every(([key, value]) => row[key] === value);
  return {
    async get(_table: string, query: any) { return rows.filter(row => matches(row, query)).map(row => ({ ...row })); },
    async create(_table: string, value: any) { const row = { id: rows.length + 1, ...value }; rows.push(row); return { ...row }; },
    async set(_table: string, query: any, value: any) { for (const row of rows) if (matches(row, query)) Object.assign(row, value); },
  };
}
async function appendAudio(context: BotContext, refs: MediaRef[], label = "开始"): Promise<void> {
  const parts: RichTextPart[] = [{ kind: "text", text: label }];
  for (const [i, ref] of refs.entries()) {
    parts.push(mediaPart(ref, { name: "声音" + (i + 1) }));
    parts.push({ kind: "text", text: "声音" + (i + 1) + "结束" });
  }
  await context.appendEvent({ id: context.nextEventId(), source: "koishi", content: richPartsText(parts), parts, attachments: refs, worldTime: 1 });
}

async function main() {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 }); }
  catch { console.log("SKIP real audio pipeline: ffmpeg unavailable; audio-normalization process-contract tests still cover failure paths"); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "test-audio-pipeline-"));
  let server: http.Server | undefined;
  try {
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 5000 });
    const amr = encoders.includes("libopencore_amrnb");
    const encoded: Buffer[] = [];
    for (const [i, hz] of [440, 660].entries()) {
      const input = path.join(directory, "tone" + i + ".wav"), output = path.join(directory, "tone" + i + (amr ? ".amr" : ".aac"));
      await fs.writeFile(input, wave(hz));
      execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", input,
        "-c:a", amr ? "libopencore_amrnb" : "aac", ...(amr ? ["-b:a", "12.2k"] : []), "-f", amr ? "amr" : "adts", output], { timeout: 5000 });
      encoded.push(await fs.readFile(output));
    }
    if (amr) assert.equal(encoded[0]!.toString("ascii", 0, 6), "#!AMR\n");
    const store = new MediaStore({ model: { extend() {} }, database: database() } as any, path.join(directory, "assets"), 100_000, logger);
    const refs: MediaRef[] = [];
    for (const bytes of encoded) {
      const id = await store.ingest("data:audio/mp3;base64," + bytes.toString("base64"), "audio");
      assert.ok(id);
      refs.push((await store.get(id))!.ref);
    }
    const originalRefs = structuredClone(refs);
    const originalRows = await Promise.all(refs.map(ref => store.get(ref.id)));
    const direct = nativeAudio(await mediaToContentPart(refs[0]!, encoded[0]!));
    assert.notEqual(direct.input_audio.data, encoded[0]!.toString("base64"), "mismatched MIME requires decoding, not relabeling");
    assert.ok(direct.input_audio.data.length > encoded[0]!.toString("base64").length);
    assert.deepEqual(refs, originalRefs);

    const read = store.readFile.bind(store); let reads = 0;
    store.readFile = async ref => { reads++; return read(ref); };
    const modalities = { image: true, audio: true, video: true };
    const loader = createAttachmentLoader(store, modalities, logger);
    const first = nativeAudio(await loader(refs[0]!)), second = nativeAudio(await loader(refs[1]!));
    assert.notEqual(first.input_audio.data, second.input_audio.data, "different voices must keep distinct native payloads");
    const cachedReads = reads;
    assert.deepEqual(await loader(refs[0]!), first);
    assert.equal(reads, cachedReads, "repeated generation reuses its decoded content instead of reading/decoding again");
    modalities.audio = false; assert.equal(await loader(refs[0]!), null);
    modalities.audio = true; loader.clearCache(); await loader(refs[0]!);
    assert.equal(reads, cachedReads + 1, "explicit cache clear permits regeneration");
    loader.clearCache();
    const parallelReads = reads;
    const parallel = await Promise.all([loader(refs[0]!), loader(refs[0]!)]);
    assert.deepEqual(parallel, [first, first]);
    assert.equal(reads, parallelReads + 1, "concurrent reads share one decode instead of duplicating work/cache accounting");
    assert.equal(await loader({ ...refs[0]!, mime: "audio/wav" }), null, "cached ID cannot bypass stored-reference validation for a different MIME");

    async function context(name: string) {
      const files = new WorldFiles(path.join(directory, name)); await files.ensure();
      const context = new BotContext(files, ""); await context.load(); context.attachmentLoader = loader;
      return context;
    }
    const ordered = await context("ordered");
    ordered.maxAttachmentsPerRequest = 2; ordered.maxAttachmentBytesPerRequest = first.input_audio.data.length + second.input_audio.data.length;
    await appendAudio(ordered, refs);
    const messages = await ordered.toChatMessages("T1"), parts = contents(messages);
    assert.deepEqual(audioParts(messages).map(part => part.input_audio.data), [first.input_audio.data, second.input_audio.data]);
    for (const [i, expected] of [first, second].entries()) {
      const index = parts.findIndex(part => part.type === "input_audio" && part.input_audio.data === expected.input_audio.data);
      assert.ok(index > 0 && parts[index - 1]!.type === "text");
      assert.match((parts[index - 1] as { text: string }).text, new RegExp('ref="media:' + refs[i]!.id + '"'));
      assert.match((parts[index + 1] as { text: string }).text, /声音[12]结束/);
    }
    await appendAudio(ordered, [refs[0]!], "再次听见同一条");
    const reread = await ordered.toChatMessages("T2");
    assert.deepEqual(reread.slice(0, messages.length), messages, "new media occurrences never rewrite the accepted prefix");
    assert.equal(audioParts(reread).length, 2);
    assert.match(textParts(reread), /同一媒体的原始内容已在事件/);
    assert.doesNotMatch(textParts(reread), /另一张图/, "audio rereads must not be described as pictures");
    assert.equal(ordered.attachmentBudgetExceeded, false);

    const limited = await context("budget");
    limited.maxAttachmentsPerRequest = 4;
    limited.maxAttachmentBytesPerRequest = encoded[0]!.toString("base64").length + 100;
    await appendAudio(limited, [refs[0]!]);
    const overBudget = await limited.toChatMessages("T1");
    assert.equal(audioParts(overBudget).length, 0, "budget is checked against decoded WAV base64, not tiny compressed AMR bytes");
    assert.match(textParts(overBudget), /尚未展开此媒体/);
    assert.equal(limited.attachmentBudgetExceeded, false, "one oversized asset must not trigger an endless compaction loop");

    const badId = await store.ingest("data:audio/mp3;base64," + Buffer.from("not an audio container").toString("base64"), "audio");
    const bad = (await store.get(badId!))!.ref;
    assert.equal(await loader(bad), null);
    const failedReads = reads; assert.equal(await loader(bad), null);
    assert.equal(reads, failedReads + 1, "a decoding failure is not cached as a successful or empty audio track");
    const unavailable = await context("unavailable");
    await appendAudio(unavailable, [bad]);
    assert.equal(audioParts(await unavailable.toChatMessages("T1")).length, 0);
    await appendAudio(unavailable, [bad], "重读无效音频");
    const failedAgain = await unavailable.toChatMessages("T2");
    assert.equal(audioParts(failedAgain).length, 0);
    assert.doesNotMatch(textParts(failedAgain), /原始内容已在事件/, "failed normalization must not create a false previously-heard source");
    assert.match(textParts(failedAgain), /未展开原始媒体/);

    const received: { route: string; bytes: Buffer }[] = [], failures: unknown[] = [];
    const mixedRequests: { messages: ChatMessage[] }[] = [];
    server = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        if (req.url === "/v1/chat/completions") {
          const payload = JSON.parse(body.toString("utf8"));
          if (payload.model === "offline-mixed") {
            mixedRequests.push(payload);
          } else {
            assert.equal(payload.model, "offline-audio");
            const audio = payload.messages[0].content.filter((part: any) => part.type === "input_audio");
            assert.equal(audio.length, 1);
            const normalized = nativeAudio(audio[0]);
            received.push({ route: "chat", bytes: Buffer.from(normalized.input_audio.data, "base64") });
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "合成测试音，无口语。" }, finish_reason: "stop" }] }));
        } else if (req.url === "/v1/audio/transcriptions") {
          const form = await new Response(body, { headers: { "Content-Type": req.headers["content-type"]! } }).formData();
          const file = form.get("file"); assert.ok(file && typeof file !== "string");
          assert.equal(file.type, "audio/wav"); assert.match(file.name, /^media-\d+\.wav$/);
          const bytes = Buffer.from(await file.arrayBuffer()); assertWav(bytes);
          assert.equal(form.get("model"), "offline-audio");
          received.push({ route: "transcription", bytes });
          res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: "仅用于离线验证的转写结果" }));
        } else throw Error("Unexpected local fixture route: " + req.url);
      } catch (error) { failures.push(error); res.statusCode = 500; res.end("fixture assertion failed"); }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const cfg = Config({});
    Object.assign(cfg.captioners.audio, { enabled: true, api: "chat", baseURL: "http://127.0.0.1:" + (server.address() as any).port + "/v1", model: "offline-audio", apiKey: "" });
    const chat = new CaptionService(cfg.captioners, cfg.media, store, logger);
    assert.equal(await chat.describe(refs[0]!), "合成测试音，无口语。");
    assert.equal(await chat.describe(refs[0]!), "合成测试音，无口语。");
    assert.equal(received.length, 1, "successful captions are cached without another decode or model request");
    cfg.captioners.audio.api = "transcription";
    const transcription = new CaptionService(cfg.captioners, cfg.media, store, logger);
    assert.equal(await transcription.describe(refs[1]!), "（语音转写）仅用于离线验证的转写结果");
    assert.equal(await transcription.describeDetailed(refs[1]!), "（语音转写）仅用于离线验证的转写结果");
    assert.deepEqual(received.map(request => request.route), ["chat", "transcription"]);
    assert.deepEqual(received[0]!.bytes, Buffer.from(first.input_audio.data, "base64"));
    assert.deepEqual(received[1]!.bytes, Buffer.from(second.input_audio.data, "base64"));
    assert.equal(await transcription.describe(bad), null);
    cfg.captioners.audio.api = "chat";
    assert.equal(await chat.describe(bad), null);
    assert.equal(received.length, 2, "bad audio never reaches either inference endpoint");

    // Exercise the production platform-element path and the actual HTTP serializer together.
    // Synthetic PPM pixels produce valid PNG files without any private/user media fixtures.
    const images = [Buffer.from([255, 0, 0]), Buffer.from([0, 0, 255])].map(pixel =>
      execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-vcodec", "ppm", "-i", "pipe:0",
        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], {
        input: Buffer.concat([Buffer.from("P6\n1 1\n255\n"), pixel]), timeout: 5000,
      }));
    const dataUrl = (bytes: Buffer, mime: string) => "data:" + mime + ";base64," + bytes.toString("base64");
    const gateway = Object.create(Gateway.prototype) as any; gateway.media = store;
    const stored = await gateway.serializeElements([
      h.text("文字0"), h.image(dataUrl(images[0]!, "image/png")),
      h.text("文字1"), h("audio", { src: dataUrl(encoded[0]!, "audio/mp3") }),
      h.text("文字2"), h.image(dataUrl(images[1]!, "image/png")),
      h.text("文字3"), h("audio", { src: dataUrl(encoded[1]!, "audio/mp3") }), h.text("文字4"),
    ]);
    const renderer = new MediaRenderer(store, { describe: async () => null } as any, () => true, 4);
    const rich = await renderer.render(stored);
    assert.equal(rich.text, richPartsText(rich.parts!));
    assert.deepEqual(rich.parts!.map(part => part.kind === "text" ? part.text : part.ref.type),
      ["文字0", "image", "文字1", "audio", "文字2", "image", "文字3", "audio", "文字4"]);
    const mixedRefs = rich.parts!.flatMap(part => part.kind === "media" ? [part.ref] : []);
    assert.deepEqual(mixedRefs.filter(ref => ref.type === "audio"), refs, "Gateway ingestion retains the original audio identities and MIME metadata");
    assert.equal(new Set(mixedRefs.map(ref => ref.id)).size, 4);
    const mixed = await context("mixed");
    mixed.maxAttachmentsPerRequest = 4;
    mixed.maxAttachmentBytesPerRequest = first.input_audio.data.length + second.input_audio.data.length + images.reduce((sum, bytes) => sum + dataUrl(bytes, "image/png").length, 0);
    await mixed.appendEvent({ id: mixed.nextEventId(), source: "koishi", content: rich.text, parts: rich.parts, attachments: rich.attachments, worldTime: 1 });
    const client = new ChatClient({ baseURL: cfg.captioners.audio.baseURL, model: "offline-mixed", maxTokens: 8, stream: false });
    const mixedMessages = await mixed.toChatMessages("混排起点");
    await client.complete(mixedMessages);
    assert.equal(mixedRequests.length, 1);
    const firstWire = mixedRequests[0]!.messages;
    const mixedMessage = firstWire.find(message => Array.isArray(message.content) && message.content.filter(part => part.type === "input_audio").length === 2);
    assert.ok(mixedMessage && Array.isArray(mixedMessage.content));
    const wireParts = mixedMessage.content;
    assert.deepEqual(wireParts.map(part => part.type), ["text", "image_url", "text", "input_audio", "text", "image_url", "text", "input_audio", "text"],
      "the endpoint receives text/image/audio in message order, never a detached attachment appendix");
    for (const [i, ref] of mixedRefs.entries()) {
      const before = wireParts[i * 2]!, native = wireParts[i * 2 + 1]!, after = wireParts[i * 2 + 2]!;
      assert.ok(before.type === "text" && after.type === "text");
      assert.equal(before.text.match(/<media ref="media:/g)?.length, 1, "each native payload is immediately bound to exactly one identity");
      assert.ok(before.text.includes('ref="media:' + ref.id + '"'));
      assert.ok(before.text.includes("文字" + i));
      assert.ok(before.text.endsWith("以下为消息原位置的原始" + (ref.type === "image" ? "图片" : "音频") + "：\n"));
      assert.ok(after.text.startsWith("\n</media>文字" + (i + 1)));
      if (ref.type === "image") {
        assert.ok(native.type === "image_url");
        assert.equal(native.image_url.url, dataUrl(images[i / 2]!, "image/png"));
        const row = (await store.get(ref.id))!;
        assert.equal(row.sha256, hash(images[i / 2]!));
        assert.deepEqual(await store.readFile(ref), images[i / 2]!, "PNG source bytes stay bound to their platform media ID");
      } else {
        assert.equal(nativeAudio(native).input_audio.data, [first, second][(i - 1) / 2]!.input_audio.data,
          "each audio position contains the WAV decoded from its own source, not its neighbour");
      }
    }
    assert.doesNotMatch(textParts(firstWire), /\[附件\]|暂无文字摘要|未展开原始媒体|媒体位置记录/,
      "the native model view must acknowledge delivered media rather than a text-only storage projection");
    assert.equal(mixed.attachmentBudgetExceeded, false);

    await appendAudio(mixed, [refs[0]!], "文字5再次出现声音A");
    const laterMessages = await mixed.toChatMessages("这个新时间不能改写既有前缀");
    await client.complete(laterMessages);
    assert.equal(mixedRequests.length, 2);
    const secondWire = mixedRequests[1]!.messages;
    assert.deepEqual(secondWire.slice(0, firstWire.length), firstWire, "the actual second HTTP request preserves the whole accepted prefix including mixed native bytes");
    assert.deepEqual(mixedMessages, firstWire, "HTTP normalization must not mutate the context's input messages");
    assert.equal(audioParts(secondWire).length, 2, "rereading one audio references its original event instead of duplicating native bytes");
    const appendedText = textParts(secondWire.slice(firstWire.length));
    assert.match(appendedText, /文字5再次出现声音A/);
    assert.match(appendedText, /同一媒体的原始内容已在事件 ev_1 中展开/);
    assert.ok(appendedText.includes('ref="media:' + refs[0]!.id + '"'));
    assert.doesNotMatch(appendedText, /另一张图|暂无文字摘要|未展开原始媒体/);
    assert.deepEqual(failures, []);
    for (const [i, ref] of refs.entries()) {
      const row = (await store.get(ref.id))!;
      assert.deepEqual(row.ref, originalRows[i]!.ref);
      assert.equal(row.sha256, originalRows[i]!.sha256);
      assert.equal(hash(await fs.readFile(ref.file)), hash(encoded[i]!));
      assert.deepEqual(await store.readFile(ref), encoded[i]!, "summary updates never replace original platform bytes with derived WAV");
    }
    assert.ok(warnings.length, "invalid codecs report local failures instead of silently claiming success");
    console.log("PASS audio pipeline: synthetic " + (amr ? "AMR" : "AAC") + " mislabeled MP3, actual WAV conversion, source identity, cache/budgets/failures, Gateway→Renderer→Context→HTTP mixed media with immutable prefix and chat/transcription contracts");
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
