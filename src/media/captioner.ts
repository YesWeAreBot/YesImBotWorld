import type { Logger } from "koishi";
import type { AudioCaptionerConfig, CaptionerConfig, CaptionersConfig, MediaConfig } from "../config.js";
import { ChatClient, type ContentPart } from "../llm/chat.js";
import type { MediaRef, MediaType } from "../types.js";
import { mediaToContentPart } from "./parts.js";
import type { MediaStore } from "./store.js";

/**
 * 外挂多模态解释器：把 Bot-LLM 不具备的模态解释为文本。
 *
 * - image / video：多模态 chat completion（image_url / video_url content part）
 * - audio：语音转写 API（/v1/audio/transcriptions）或多模态 chat（input_audio）
 * - 解释结果按媒体缓存（summary 字段），同一文件只解释一次
 */
/** 细看（view_media）用的详述提示词：比常规摘要更完整，覆盖挑图所需的全部信息 */
const DETAIL_PROMPT_IMAGE =
  "请用中文仔细描述这张图片的完整内容：画面主体与细节、图中出现的所有文字（逐字）、人物或角色的表情与情绪；" +
  "如果它像表情包或梗图，说明它表达的情绪、梗的含义，以及适合在什么聊天场景下发送。";
const DETAIL_PROMPT_VIDEO =
  "请用中文仔细描述这段视频/动图的完整内容：发生了什么、出现的文字、传达的情绪或笑点，以及适合在什么聊天场景下发送。";

export class CaptionService {
  private inflight = new Map<number, Promise<string | null>>();
  /** 详述缓存（仅内存）：细看同一媒体不重复调用解释器 */
  private detailCache = new Map<number, string>();

  constructor(
    private cfg: CaptionersConfig,
    private media: MediaConfig,
    private store: MediaStore,
    private logger: Logger,
  ) {}

  enabledFor(type: MediaType): boolean {
    return this.cfg[type].enabled;
  }

  private isGif(ref: MediaRef): boolean {
    return ref.type === "image" && ref.mime === "image/gif";
  }

  /**
   * 取得媒体的文本解释（缓存优先）。
   * 返回 null 表示无可用解释器或解释失败。
   */
  async describe(ref: MediaRef): Promise<string | null> {
    const row = await this.store.get(ref.id);
    if (row?.summary) return row.summary;
    // GIF 动图优先走视频解释器（都未启用则无解释）
    const enabled = this.isGif(ref)
      ? this.cfg.video.enabled || this.cfg.image.enabled
      : this.enabledFor(ref.type);
    if (!enabled) return null;

    const existing = this.inflight.get(ref.id);
    if (existing) return existing;

    const task = this.doDescribe(ref)
      .then(async (summary) => {
        if (summary) await this.store.setSummary(ref.id, summary);
        return summary;
      })
      .catch((err) => {
        this.logger.warn("媒体解释失败 (%s#%d): %s", ref.type, ref.id, err);
        return null;
      })
      .finally(() => this.inflight.delete(ref.id));
    this.inflight.set(ref.id, task);
    return task;
  }

  /**
   * 细看一个媒体：产出比常规摘要更完整的详述（发图前确认内容用）。
   * 用于 Bot-LLM 没有对应原生模态、无法直接看附件的场合。
   * 结果仅缓存在内存（不覆盖 summary 摘要缓存）。
   */
  async describeDetailed(ref: MediaRef): Promise<string | null> {
    // 音频：转写本身已是完整内容，直接复用常规通道（含缓存）
    if (ref.type === "audio") return this.describe(ref);
    const cached = this.detailCache.get(ref.id);
    if (cached) return cached;

    let result: string | null = null;
    try {
      if (this.isGif(ref) && this.cfg.video.enabled) {
        const data = await this.store.readFile(ref);
        result = await this.describeViaChat(
          ref,
          this.cfg.video,
          {
            type: "video_url",
            video_url: { url: `data:image/gif;base64,${data.toString("base64")}` },
          },
          DETAIL_PROMPT_VIDEO,
        );
      } else if (this.enabledFor(ref.type)) {
        result = await this.describeViaChat(
          ref,
          this.cfg[ref.type],
          undefined,
          ref.type === "video" ? DETAIL_PROMPT_VIDEO : DETAIL_PROMPT_IMAGE,
        );
      }
    } catch (err) {
      this.logger.warn("媒体详述失败 (%s#%d): %s", ref.type, ref.id, err);
    }
    if (result) {
      if (this.detailCache.size >= 64) {
        const oldest = this.detailCache.keys().next().value;
        if (oldest !== undefined) this.detailCache.delete(oldest);
      }
      this.detailCache.set(ref.id, result);
      return result;
    }
    // 无详述能力/失败：退回常规摘要（可能来自缓存）
    return this.describe(ref);
  }

  private async doDescribe(ref: MediaRef): Promise<string | null> {
    if (ref.type === "audio" && this.cfg.audio.api === "transcription") {
      return this.transcribe(ref, this.cfg.audio);
    }
    // GIF 动图：优先外挂视频解释器（video_url 通道，能看到动态过程），未启用退回图片解释器
    if (this.isGif(ref) && this.cfg.video.enabled) {
      const data = await this.store.readFile(ref);
      return this.describeViaChat(ref, this.cfg.video, {
        type: "video_url",
        video_url: { url: `data:image/gif;base64,${data.toString("base64")}` },
      });
    }
    return this.describeViaChat(ref, this.cfg[ref.type]);
  }

  private async describeViaChat(
    ref: MediaRef,
    cfg: CaptionerConfig,
    partOverride?: ContentPart,
    promptOverride?: string,
  ): Promise<string | null> {
    const data = await this.store.readFile(ref);
    const part = partOverride ?? mediaToContentPart(ref, data);
    const client = new ChatClient({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model,
      temperature: 0.2,
      maxTokens: cfg.maxTokens,
    });
    const content: ContentPart[] = [{ type: "text", text: promptOverride ?? cfg.prompt }, part];
    const result = await client.complete(
      [{ role: "user", content }],
      { signal: AbortSignal.timeout(this.media.captionTimeoutMs) },
    );
    const text = result.content.trim();
    return text || null;
  }

  /** whisper 风格 /v1/audio/transcriptions */
  private async transcribe(ref: MediaRef, cfg: AudioCaptionerConfig): Promise<string | null> {
    const data = await this.store.readFile(ref);
    const url = cfg.baseURL.replace(/\/+$/, "") + "/audio/transcriptions";
    const form = new FormData();
    const filename = ref.file.split("/").pop() ?? "audio";
    form.append("file", new Blob([new Uint8Array(data)], { type: ref.mime }), filename);
    if (cfg.model) form.append("model", cfg.model);
    const res = await fetch(url, {
      method: "POST",
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(this.media.captionTimeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`转写请求失败 (${res.status}): ${text.slice(0, 300)}`);
    }
    const result = (await res.json()) as { text?: string };
    const text = result.text?.trim();
    return text ? `（语音转写）${text}` : null;
  }
}
