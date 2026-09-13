import type { MediaRef, MediaType, RichText, RichTextPart } from "../types.js";
import type { CaptionService } from "./captioner.js";
import type { MediaStore } from "./store.js";
import { mediaPart, mediaText } from "./presentation.js";

export const MEDIA_PLACEHOLDER = /<media id="(\d+)" type="(image|audio|video)"\/>/g;

export function mediaPlaceholder(id: number, type: MediaType): string {
  return `<media id="${id}" type="${type}"/>`;
}

/** User-authored text must not masquerade as a persisted asset downloaded from the platform. */
export function escapeMediaStorageText(text: string): string {
  return text.replace(/<media(?=\s|>)/g, "&lt;media");
}

const TYPE_LABEL: Record<MediaType, string> = { image: "图片", audio: "音频", video: "视频" };

/**
 * 可作为原生附件注入的图片格式（真实字节格式，入库时经 magic-byte 校验）。
 * 排除的是校验失败/未知格式（如顶着 image content-type 的非图片响应），
 * 这类文件注入请求会让每一次生成都 400。
 */
const SAFE_NATIVE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** 该媒体是否适合作为原生附件注入模型（格式安全性检查，与模态开关无关） */
export function nativeSafeMime(ref: MediaRef): boolean {
  return ref.type !== "image" || SAFE_NATIVE_IMAGE_MIMES.has(ref.mime);
}

/**
 * 把含媒体占位符的文本渲染为 Bot 可感知的形式：
 *
 * 媒体身份、摘要与原始内容绑定在同一 media 段内。纯文本/压缩也保留该身份和摘要，
 * 不以「附件第几张」建立对应关系；存储占位只在此处解析，绝不直接暴露给模型。
 * 图片/媒体的**相对位置绝不变动**：文字与媒体按原文顺序交错。
 */
export class MediaRenderer {
  constructor(
    private store: MediaStore,
    private captioner: CaptionService,
    private nativeSupport: (ref: MediaRef) => boolean,
    private maxAttachments: number,
  ) {}

  /** 该媒体能否作为原生附件注入（供 messenger 在列表/细看场景直接附原图时判断） */
  canAttach(ref: MediaRef): boolean {
    return this.nativeSupport(ref);
  }

  /** 单事件原生附件数上限 */
  get maxAttach(): number {
    return this.maxAttachments;
  }

  async render(text: string): Promise<RichText> {
    const matches = [...text.matchAll(MEDIA_PLACEHOLDER)];
    if (!matches.length) return { text };

    const attachments: MediaRef[] = [];
    const parts: RichTextPart[] = [];
    let result = "";
    let cursor = 0;
    for (const match of matches) {
      const textBefore = text.slice(cursor, match.index);
      if (textBefore) {
        result += textBefore;
        parts.push({ kind: "text", text: textBefore });
      }
      cursor = match.index! + match[0].length;
      const id = Number(match[1]);
      const type = match[2] as MediaType;
      const seg = await this.renderOneParts(id, type, attachments);
      if (seg.kind === "media") {
        result += mediaText(seg);
        parts.push(seg);
      } else {
        // 走解释器/无法查看：退化成纯文本（就地，不动位置）
        result += seg.text;
        parts.push(seg);
      }
    }
    const tail = text.slice(cursor);
    if (tail) {
      result += tail;
      parts.push({ kind: "text", text: tail });
    }
    return attachments.length
      ? { text: result, attachments, parts }
      : { text: result, parts };
  }

  /**
   * 渲染单个媒体：原生支持 → 作为 media 段（附 ref，marker = 降级描述）；
   * 否则 → 解释器文本 / 无法查看。
   */
  private async renderOneParts(
    id: number,
    type: MediaType,
    attachments: MediaRef[],
  ): Promise<RichTextPart> {
    const row = await this.store.get(id);
    if (!row) return { kind: "text", text: `（${TYPE_LABEL[type]} media:${id} 已丢失，无法查看或发送。）` };

    const caption = await this.captioner.describe(row.ref);
    const part = mediaPart(row.ref, { summary: caption ?? undefined });

    if (this.nativeSupport(row.ref) && attachments.length < this.maxAttachments) {
      attachments.push(row.ref);
      return part;
    }

    return { kind: "text", text: mediaText(part, caption ? "当前通过文字摘要了解内容，未展开原始媒体" : "当前无法查看内容") };
  }
}
