import type { Logger } from "koishi";
import type { ContentPart } from "../llm/chat.js";
import type { MediaRef } from "../types.js";
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

export type AttachmentLoader = (ref: MediaRef) => Promise<ContentPart | null>;

/**
 * 附件加载器：媒体文件 → content part，带内存缓存
 * （上下文每次生成都会重新渲染，避免反复读盘与 base64 编码）。
 */
export function createAttachmentLoader(store: MediaStore, logger: Logger): AttachmentLoader {
  const cache = new Map<number, ContentPart>();
  const MAX_CACHE = 64;
  return async (ref) => {
    const cached = cache.get(ref.id);
    if (cached) return cached;
    try {
      const data = await store.readFile(ref);
      const part = mediaToContentPart(ref, data);
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
  };
}
