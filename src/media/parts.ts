import type { Logger } from "koishi";
import type { ModalitySupport } from "../config.js";
import type { ContentPart } from "../llm/chat.js";
import type { MediaRef } from "../types.js";
import { gifToFilmstripPng } from "./gif.js";
import { normalizeAudio } from "./audio.js";
import type { MediaStore } from "./store.js";

/** 把本地媒体文件转成 OpenAI 兼容的 content part */
export async function mediaToContentPart(ref: MediaRef, data: Buffer): Promise<ContentPart> {
  // Platform audio MIME/extensions can be wrong (e.g. AMR advertised as MP3).
  // Decode actual bytes once at admission; never relabel or overwrite the source.
  if (ref.type === "audio") {
    const wav = await normalizeAudio(data);
    return { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } };
  }
  const base64 = data.toString("base64");
  const dataUrl = `data:${ref.mime};base64,${base64}`;
  switch (ref.type) {
    case "image":
      return { type: "image_url", image_url: { url: dataUrl } };
    case "video":
      return { type: "video_url", video_url: { url: dataUrl } };
  }
}

/** 附件加载函数：媒体引用 → content part（BotContext 注入用的最小接口） */
export type AttachmentLoadFn = (ref: MediaRef) => Promise<ContentPart | null>;

export interface AttachmentLoader extends AttachmentLoadFn {
  /** 清空缓存：运行时降级模态后 content part 需要重建（如 GIF 从 video_url 改为拼帧图） */
  clearCache(): void;
}

/**
 * 附件加载器：媒体文件 → content part，带内存缓存
 * （上下文每次生成都会重新渲染，避免反复读盘与 base64 编码）。
 *
 * GIF 动图按模型能力路由（modalities 按引用动态读取，支持运行时降级）：
 * - 原生支持视频 → 走视频通道（video_url，原样 GIF）；
 * - 仅原生图像 → 解码抽帧拼成一张网格图（PNG）注入；拼帧失败退回原样 GIF。
 */
export function createAttachmentLoader(
  store: MediaStore,
  modalities: ModalitySupport,
  logger: Logger,
): AttachmentLoader {
  const cache = new Map<string, { part: ContentPart; bytes: number }>();
  const pending = new Map<string, Promise<ContentPart | null>>();
  const MAX_CACHE = 64;
  const MAX_CACHE_BYTES = 32 * 1024 * 1024;
  let cacheBytes = 0;
  let generation = 0;
  const build = async (ref: MediaRef, data: Buffer): Promise<ContentPart> => {
    if (ref.type === "image" && ref.mime === "image/gif") {
      if (modalities.video) {
        return { type: "video_url", video_url: { url: `data:image/gif;base64,${data.toString("base64")}` } };
      }
      try {
        const { png, frameCount } = gifToFilmstripPng(data);
        logger.debug("GIF #%d 拼帧：%d 帧 → %d 字节 PNG", ref.id, frameCount, png.length);
        return { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } };
      } catch (err) {
        logger.warn("GIF #%d 拼帧失败，按原样注入: %s", ref.id, err);
      }
    }
    return mediaToContentPart(ref, data);
  };
  const loader = (async (ref: MediaRef) => {
    const supported = ref.type === "image" && ref.mime === "image/gif"
      ? modalities.image || modalities.video : modalities[ref.type];
    if (!supported) return null;
    const key = JSON.stringify([ref.id, ref.type, ref.mime, ref.file]);
    const cached = cache.get(key);
    if (cached) return cached.part;
    const existing = pending.get(key);
    if (existing) return existing;
    const startedIn = generation;
    const task = (async () => { try {
      const data = await store.readFile(ref);
      const part = await build(ref, data);
      // A capability change/clear cannot be undone by an earlier slow decoder.
      if (startedIn !== generation) return part;
      // WAV can be much larger than the compressed source. Bound cached payloads
      // by bytes as well as count, independently of the request admission budget.
      const bytes = part.type === "input_audio" ? part.input_audio.data.length : part.type === "image_url" ? part.image_url.url.length
        : part.type === "video_url" ? part.video_url.url.length : part.text.length;
      while (cache.size && (cache.size >= MAX_CACHE || cacheBytes + bytes > MAX_CACHE_BYTES)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) { cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest); }
      }
      if (bytes <= MAX_CACHE_BYTES) { cache.set(key, { part, bytes }); cacheBytes += bytes; }
      return part;
    } catch (err) {
      logger.warn("附件加载失败 (#%d): %s", ref.id, err);
      return null;
    } })();
    pending.set(key, task);
    try { return await task; }
    finally { if (pending.get(key) === task) pending.delete(key); }
  }) as AttachmentLoader;
  loader.clearCache = () => { generation++; cache.clear(); pending.clear(); cacheBytes = 0; };
  return loader;
}
