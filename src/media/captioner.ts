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
 * - 普通内容 summary 与会话表情 expressionSummary 按用途独立缓存
 */
export interface CaptionUsage { sticker?: boolean }

/** Usage is platform metadata, never a second model classification or a guess from image style. */
const EXPRESSION_PROMPT =
  "本次媒体在聊天中作为表情使用，是像 emoji 一样的会话表意符号。请用中文简短识别，按以下顺序给出：" +
  "字面文字（逐字抄录可辨认的字幕，无文字则说明，模糊处标不清楚）；可能用途（仅在图中文字/惯用符号有依据时，" +
  "说明可能用于应和、疑问、拒绝、调侃等哪种会话功能，必要时列出不同解读，无法判断就明确未知）；" +
  "辨认线索（一句简短画面特征，仅帮助区分这张表情）。" +
  "可能用途不是这位发送者本次真实意图；你没有聊天上下文，不能推断其真实情绪、人际态度、赞同或针对谁，" +
  "不能从猫、鱼、角色、颜色等画面直接推断人际含义。不要展开画面赏析，不建议回复、喜欢或收藏，也不要编造梗。";
/** 细看普通图片只说明可见内容，不因外观像梗图就替它定义会话用途。 */
const DETAIL_PROMPT_IMAGE =
  "请用中文仔细描述这张普通图片的可见内容：画面主体与细节、图中出现的所有可辨认文字（逐字）、可见的动作与神态。" +
  "分清可见内容和主观解读；模糊文字、未知梗或无法感知的声音明确说明，不要猜测补全，不推断发送者的情绪、态度或发送意图。";
const DETAIL_PROMPT_VIDEO =
  "请用中文仔细描述这段视频/动图的可见内容：发生了什么、出现的可辨认文字与可见的动作。分清可见内容和主观解读；" +
  "模糊文字、未知梗或无法感知的声音明确说明，不要猜测补全，不推断发送者的情绪、态度或发送意图。";

export class CaptionService {
  private inflight = new Map<string, Promise<string | null>>();
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
  async describe(ref: MediaRef, usage: CaptionUsage = {}): Promise<string | null> {
    const expression = ref.type === "image" && usage.sticker === true;
    const key = `${ref.id}:${expression ? "expression" : "image"}`;
    const row = await this.store.get(ref.id);
    const cached = expression ? row?.expressionSummary : row?.summary;
    if (cached) return cached;
    // GIF 动图优先走视频解释器（都未启用则无解释）
    const enabled = this.isGif(ref)
      ? this.cfg.video.enabled || this.cfg.image.enabled
      : this.enabledFor(ref.type);
    if (!enabled) return null;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const task = this.doDescribe(ref, expression)
      .then(async (summary) => {
        if (summary) {
          if (expression) await this.store.setExpressionSummary(ref.id, summary);
          else await this.store.setSummary(ref.id, summary);
        }
        return summary;
      })
      .catch((err) => {
        this.logger.warn("媒体解释失败 (%s#%d): %s", ref.type, ref.id, err);
        return null;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /**
   * 主动细看媒体：普通图片/视频提供更完整的可见细节，表情复用用途识别。
   * 用于 Bot-LLM 没有对应原生模态、无法直接看附件的场合。
   * 普通媒体详述仅缓存在内存，不覆盖 summary；表情沿用独立 expressionSummary。
   */
  async describeDetailed(ref: MediaRef, usage: CaptionUsage = {}): Promise<string | null> {
    // 音频：转写本身已是完整内容，直接复用常规通道（含缓存）
    if (ref.type === "audio") return this.describe(ref);
    const expression = ref.type === "image" && usage.sticker === true;
    // Expression recognition already includes its literal text, possible uses and distinguishing
    // cue. A second visual essay would add latency and turn the symbol back into a picture topic.
    if (expression) return this.describe(ref, usage);
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
    return this.describe(ref, usage);
  }

  private async doDescribe(ref: MediaRef, expression = false): Promise<string | null> {
    if (ref.type === "audio" && this.cfg.audio.api === "transcription") {
      return this.transcribe(ref, this.cfg.audio);
    }
    // GIF 动图：优先外挂视频解释器（video_url 通道，能看到动态过程），未启用退回图片解释器
    if (this.isGif(ref) && this.cfg.video.enabled) {
      const data = await this.store.readFile(ref);
      return this.describeViaChat(ref, this.cfg.video, {
        type: "video_url",
        video_url: { url: `data:image/gif;base64,${data.toString("base64")}` },
      }, expression ? EXPRESSION_PROMPT : undefined);
    }
    return this.describeViaChat(ref, this.cfg[ref.type], undefined, expression ? EXPRESSION_PROMPT : undefined);
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
      label: "解释器",
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
