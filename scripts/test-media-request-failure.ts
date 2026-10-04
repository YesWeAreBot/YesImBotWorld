/** Provider rejection attribution and real Bot recovery; no model, codec or network service. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { classifyMediaRequestFailure } from "../src/media/request-failure.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ChatMessage } from "../src/llm/chat.js";
import type { MediaRef } from "../src/types.js";

const exactServerError = 'Invalid or unsupported audio format. Reliably supported by this build: WAV, FLAC, OGG/Vorbis (MP3 is libsndfile-build dependent — present in soundfile >= 0.13 / libsndfile >= 1.1.0 but not all packaged wheels). AAC/MP4/M4A and WebM/Opus container formats were previously accepted via PyAV/FFmpeg but are no longer supported following the royalty-bearing codec removal — re-encode to WAV, FLAC, or OGG/Vorbis before submitting.';
const failure = (message: string, status = 400) => new Error(`chat completion 请求失败 (${status}): ${JSON.stringify({ error: { message, type: "BadRequestError", code: status } })}`);
const allParts = new Set(["image_url", "input_audio", "video_url"]);
const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 1500 && !check(); n++) await delay(2);
  assert.ok(check(), label);
}

function classification() {
  for (const message of [exactServerError, "Unsupported audio codec: amr", "audio format must be wav or mp3", "input_audio.format: Input should be 'wav' or 'mp3'"]) {
    assert.deepEqual(classifyMediaRequestFailure(failure(message), allParts), { kind: "audio-format" });
    assert.equal(classifyMediaRequestFailure(failure(message), new Set(["image_url", "video_url"])), undefined);
  }
  for (const [message, modality] of [
    ["This model does not support audio input.", "audio"], ["input_audio is not supported", "audio"],
    ["Unsupported input type: input_audio", "audio"], ["Unsupported content part type: video_url", "video"],
    ["This model does not support video.", "video"], ["Invalid value: 'video_url'. Supported values are 'text' and 'image_url'.", "video"],
    ["This model does not support images.", "image"], ["image_url is not supported", "image"],
    ["不支持音频输入", "audio"], ["不支持视频输入", "video"],
  ]) assert.deepEqual(classifyMediaRequestFailure(failure(message!), allParts), { kind: "unsupported-modality", modalities: [modality] }, message);
  for (const message of [
    "Invalid json_schema: unsupported keyword uniqueItems", "Tool choice is not supported", "Maximum context length exceeded",
    "TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]",
    "Invalid audio output format", "This model does not support audio output", "Unsupported image format: SVG",
    "Unsupported video codec: hevc", "Unsupported image resolution", "Failed to decode media payload", "Invalid API key",
    "Unsupported json_schema keyword; the supported audio format is WAV",
  ]) assert.equal(classifyMediaRequestFailure(failure(message), allParts), undefined, message);
  assert.equal(classifyMediaRequestFailure(failure("input_audio is not supported", 500), allParts), undefined);
  assert.equal(classifyMediaRequestFailure(new Error("input_audio is not supported"), allParts), undefined, "local failures cannot claim provider capability");
  assert.deepEqual(classifyMediaRequestFailure(Object.assign(new Error("Unsupported audio input"), { code: "LLM_REMOTE_ERROR" }), allParts),
    { kind: "unsupported-modality", modalities: ["audio"] });
  assert.deepEqual(classifyMediaRequestFailure(failure("Request body too large", 413), allParts), { kind: "payload-too-large" });
  assert.equal(classifyMediaRequestFailure(failure("Request body too large", 413), new Set()), undefined);
}

async function runtime() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yib-media-rejection-"));
  const agents: any[] = [];
  try {
    async function fixture(name: string) {
      const files = new WorldFiles(path.join(base, name)); await files.ensure();
      const context = new BotContext(files); await context.load();
      const config = Config({ autoStart: false }); config.bot.growth.enabled = false;
      Object.assign(config.bot, { minIntervalMs: 0, retryDelayMs: 1, maxWindowChars: 1_000_000, restCompressMinChars: 0, nativeToolCalls: false });
      const modalities = { image: true, audio: true, video: true }, degraded: string[][] = [];
      let codec = "amr";
      const refs: MediaRef[] = [
        { id: 1, type: "audio", mime: "audio/amr", file: "/fixture/audio.amr" },
        { id: 2, type: "video", mime: "video/mp4", file: "/fixture/video.mp4" },
        { id: 3, type: "image", mime: "image/png", file: "/fixture/image.png" },
      ];
      context.attachmentLoader = async ref => !modalities[ref.type] ? null : ref.type === "audio"
        ? { type: "input_audio", input_audio: { data: "b2xkLWF1ZGlv", format: codec } }
        : ref.type === "video" ? { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } }
        : { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } };
      context.degradeModalities = kinds => { degraded.push([...kinds]); for (const kind of kinds) modalities[kind] = false; };
      const clock: any = { now: () => 1, timeLine: () => "T1", realMsUntil: () => 0, unitWorldSeconds: 1, unitRealSeconds: 1 };
      const world: any = { compress: async () => ({ historySummary: "媒体消息已经收到，模型未能展开原始音频。", memoryDigest: "保留媒体身份。" }) };
      const agent: any = new BotAgent(config, clock, files, context, world, {} as any, null, null, null, { down: false }, logger,
        BOT_TOOLS.filter(tool => tool.name === "wait"));
      agents.push(agent);
      await context.appendEvent({ id: "mixed-media", source: "koishi", content: "实际收到的语音、视频和图片。", worldTime: 1, attachments: refs });
      return { agent, context, config, world, modalities, degraded, refs, normalize: () => { codec = "wav"; } };
    }

    const formats = await fixture("format");
    const original = await formats.context.toChatMessages("T1", false);
    assert.deepEqual(formats.context.lastAttachmentPartTypes, allParts);
    assert.equal(formats.agent.recoverMediaRequestFailure(failure(exactServerError)), true);
    assert.deepEqual(formats.degraded, []); assert.deepEqual(formats.modalities, { image: true, audio: true, video: true });
    assert.equal(formats.context.attachmentsDisabled, false); assert.equal(formats.context.attachmentBudgetExceeded, true);
    formats.normalize(); await formats.agent.drainMailbox(false);
    assert.deepEqual((await formats.context.toChatMessages("T2", false)).slice(0, original.length), original,
      "format recovery cannot rewrite earlier audio bytes, even if the new loader now emits WAV");
    assert.equal(formats.agent.recoverMediaRequestFailure(failure(exactServerError)), false, "same-window retry cannot request another rebuild");
    await formats.context.applyCompression({ historySummary: "旧音频没有成功展开。", memoryDigest: "记录仍保留。" }, 2);
    await formats.context.appendEvent({ id: "new-wav", source: "koishi", content: "新语音。", worldTime: 3, attachments: [formats.refs[0]!] });
    const wav = JSON.stringify(await formats.context.toChatMessages("T3", false));
    assert.match(wav, /"format":"wav"/);
    assert.equal(formats.agent.recoverMediaRequestFailure(failure(exactServerError)), false, "even rejected WAV cannot trigger endless compression cycles");
    assert.deepEqual(formats.degraded, []); assert.equal(formats.context.attachmentBudgetExceeded, false);

    for (const modality of ["audio", "video", "image"] as const) {
      const f = await fixture(modality), before = await f.context.toChatMessages("T1", false);
      assert.equal(f.agent.recoverMediaRequestFailure(failure(`This model does not support ${modality}.`)), true);
      assert.deepEqual(f.degraded, [[modality]]); assert.equal(f.context.attachmentsDisabled, false);
      assert.deepEqual(f.modalities, { image: modality !== "image", audio: modality !== "audio", video: modality !== "video" });
      assert.deepEqual(await f.context.toChatMessages("T2", false), before, "explicit modality changes also preserve failed historical prefix");
      assert.equal(f.agent.recoverMediaRequestFailure(failure(`This model does not support ${modality}.`)), false);
    }
    const unrelated = await fixture("unrelated"); await unrelated.context.toChatMessages("T1", false);
    assert.equal(unrelated.agent.recoverMediaRequestFailure(failure("Invalid JSON schema")), false);
    assert.deepEqual(unrelated.degraded, []); assert.equal(unrelated.context.attachmentBudgetExceeded, false);
    assert.equal(unrelated.context.attachmentsDisabled, false);
    assert.equal(unrelated.agent.recoverMediaRequestFailure(failure("Request too large", 413)), true);
    assert.equal(unrelated.context.attachmentsDisabled, true); assert.equal(unrelated.context.attachmentBudgetExceeded, true);

    // Exercise the actual catch → normal compression → next request path. The second
    // request has new WAV audio; repeating the provider error must take normal retry.
    const loop = await fixture("loop"); let requests = 0, compressions = 0, first: ChatMessage[] = [];
    loop.world.compress = async () => {
      compressions++;
      const stillFrozen = await loop.context.toChatMessages("T2", false);
      assert.deepEqual(stillFrozen.slice(0, first.length), first);
      loop.normalize();
      loop.agent.pushEvent("koishi", { text: "整理期间收到另一段真实语音。", attachments: [loop.refs[0]!] });
      return { historySummary: "旧媒体没有展开。", memoryDigest: "只保留已知文字。" };
    };
    loop.agent.backend.client = { complete: async (messages: ChatMessage[]) => {
      requests++;
      if (requests === 1) first = structuredClone(messages);
      else assert.match(JSON.stringify(messages), /"format":"wav"/);
      if (requests === 3) loop.agent.setManualPaused(true);
      throw failure(exactServerError);
    } };
    loop.agent.start(); await until(() => requests === 3, "real generation loop resumes after one safe format rebuild"); await loop.agent.stop();
    assert.equal(compressions, 1); assert.deepEqual(loop.degraded, []);
    assert.equal(loop.context.attachmentsDisabled, false);
    assert.ok(!loop.context.stream.some(item => item.kind === "tool_call"), "rejected generation never executes an action");
  } finally { for (const agent of agents) await agent.stop(); await fs.rm(base, { recursive: true, force: true }); }
}

classification(); runtime().then(() => console.log("PASS media request failures: codec vs modality, unrelated 400 isolation, precise mixed-request fallback, immutable prefixes, bounded format recovery and normal agent retry")).catch(error => { console.error(error); process.exitCode = 1; });
