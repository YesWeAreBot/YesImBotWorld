import type { MediaRef, MediaType, RichText } from "../types.js";
import type { CaptionService } from "./captioner.js";
import type { MediaStore } from "./store.js";

export const MEDIA_PLACEHOLDER = /<media id="(\d+)" type="(image|audio|video)"\/>/g;

export function mediaPlaceholder(id: number, type: MediaType): string {
  return `<media id="${id}" type="${type}"/>`;
}

const TYPE_LABEL: Record<MediaType, string> = { image: "图片", audio: "音频", video: "视频" };

/**
 * 把含媒体占位符的文本渲染为 Bot 可感知的形式：
 *
 * - Bot-LLM 原生支持该模态（chat 模式 + 声明能力）→ 文本保留 `[图片#12]` 标记，
 *   媒体作为附件（content part）注入，受单事件附件数上限约束；
 * - 否则若配置了外挂解释器 → `[图片#12：解释文本]`（解释结果缓存）；
 * - 否则 → `[图片#12（无法查看内容）]`。
 */
export class MediaRenderer {
  constructor(
    private store: MediaStore,
    private captioner: CaptionService,
    private nativeSupport: (type: MediaType) => boolean,
    private maxAttachments: number,
  ) {}

  async render(text: string): Promise<RichText> {
    const matches = [...text.matchAll(MEDIA_PLACEHOLDER)];
    if (!matches.length) return { text };

    const attachments: MediaRef[] = [];
    let result = "";
    let cursor = 0;
    for (const match of matches) {
      result += text.slice(cursor, match.index);
      cursor = match.index! + match[0].length;
      const id = Number(match[1]);
      const type = match[2] as MediaType;
      result += await this.renderOne(id, type, attachments);
    }
    result += text.slice(cursor);
    return attachments.length ? { text: result, attachments } : { text: result };
  }

  private async renderOne(id: number, type: MediaType, attachments: MediaRef[]): Promise<string> {
    const label = `${TYPE_LABEL[type]}#${id}`;
    const row = await this.store.get(id);
    if (!row) return `[${label}（已丢失）]`;

    if (this.nativeSupport(type) && attachments.length < this.maxAttachments) {
      attachments.push(row.ref);
      return `[${label}（见附件）]`;
    }

    const caption = await this.captioner.describe(row.ref);
    if (caption) return `[${label}：${caption}]`;
    return `[${label}（无法查看内容）]`;
  }
}
