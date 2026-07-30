import type { Logger } from "koishi";
import type { ModalitySupport } from "../config.js";
import type { ContentPart } from "../llm/chat.js";
import type { MediaRef } from "../types.js";
import { gifToFilmstripPng } from "./gif.js";
import type { MediaStore } from "./store.js";

const AUDIO_FORMAT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/amr": "amr",
};

/** 把本地媒体文件转成 OpenAI 兼容的 content part */
export function mediaToContentPart(ref: MediaRef, data: Buffer): ContentPart {
  const base64 = data.toString("base64");
  const dataUrl = `data:${ref.mime};base64,${base64}`;
  switch (ref.type) {
    case "image":
      return { type: "image_url", image_url: { url: dataUrl } };
    case "audio":
      return {
        type: "input_audio",
        input_audio: {
          data: base64,
          format: AUDIO_FORMAT_BY_MIME[ref.mime] ?? ref.mime.split("/")[1] ?? "wav",
        },
      };
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
  const cache = new Map<number, ContentPart>();
  const MAX_CACHE = 64;
  const build = (ref: MediaRef, data: Buffer): ContentPart => {
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
    const cached = cache.get(ref.id);
    if (cached) return cached;
    try {
      const data = await store.readFile(ref);
      const part = build(ref, data);
      if (cache.size >= MAX_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(ref.id, part);
      return part;
    } catch (err) {
      logger.warn("附件加载失败 (#%d): %s", ref.id, err);
      return null;
    }
  }) as AttachmentLoader;
  loader.clearCache = () => cache.clear();
  return loader;
}
