import type { MediaRef, MediaType, RichText, RichTextPart } from "../types.js";
import type { CaptionService } from "./captioner.js";
import type { MediaStore } from "./store.js";

export const MEDIA_PLACEHOLDER = /<media id="(\d+)" type="(image|audio|video)"\/>/g;

export function mediaPlaceholder(id: number, type: MediaType): string {
  return `<media id="${id}" type="${type}"/>`;
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
 * - Bot-LLM 原生支持该模态 → 文本**不留占位符**（图片位置由 content part 精确表达），
 *   parts 里放 media 段；media 段额外带一个「降级描述」，供附件超预算被裁时退化用；
 * - 否则若配置了外挂解释器 → 就地渲染 `[图片#12：解释文本]`（解释结果缓存）；
 * - 否则 → 就地渲染 `[图片#12（无法查看内容）]`。
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
        // 原生支持：text 字段该位置留空（图片由 content part 表达，不写占位符、不写「见附件」）；
        // media 段的 marker 已存成「降级描述」，供附件超预算被裁时纯文本退化。
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
    if (!row) return { kind: "text", text: `[${TYPE_LABEL[type]}#${id}（已丢失）]` };

    if (this.nativeSupport(row.ref) && attachments.length < this.maxAttachments) {
      attachments.push(row.ref);
      // marker（降级描述）：附件超预算被裁时，退化成「[图片#12：描述]」就地呈现，而不是骗人的「见附件」
      const caption = await this.captioner.describe(row.ref);
      const marker = caption
        ? `[${TYPE_LABEL[type]}#${id}：${caption}]`
        : `[${TYPE_LABEL[type]}#${id}]`;
      return { kind: "media", ref: row.ref, marker };
    }

    const caption = await this.captioner.describe(row.ref);
    if (caption) return { kind: "text", text: `[${TYPE_LABEL[type]}#${id}：${caption}]` };
    return { kind: "text", text: `[${TYPE_LABEL[type]}#${id}（无法查看内容）]` };
  }
}
