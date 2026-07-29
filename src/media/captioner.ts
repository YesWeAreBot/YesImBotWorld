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
export class CaptionService {
  private inflight = new Map<number, Promise<string | null>>();

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
    const content: ContentPart[] = [{ type: "text", text: cfg.prompt }, part];
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
