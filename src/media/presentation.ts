import type { MediaRef, RichTextPart } from "../types.js";

type MediaPart = Extract<RichTextPart, { kind: "media" }>;
const LABEL = { image: "图片", audio: "音频", video: "视频" };
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Stable asset identity, never the ordinal position of an attachment in a request. */
export function mediaRefText(ref: Pick<MediaRef, "id">): string { return `media:${ref.id}`; }
export function mediaSendTag(ref: Pick<MediaRef, "id">): string { return `<media ref="${mediaRefText(ref)}"/>`; }
export function parseMediaId(value: string): number | null {
  const match = value.trim().match(/^(?:media:)?([1-9]\d*)$/);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}

export function mediaPart(ref: MediaRef, metadata: {
  name?: string; summary?: string; sticker?: boolean; expressionSummary?: string; galleryNote?: string;
} = {}): MediaPart {
  const part: MediaPart = {
    kind: "media", ref, ...metadata, marker: "",
    presentation: ref.type === "image" && metadata.sticker === true ? "expression-v2" : "media-v2",
  };
  part.marker = mediaText(part);
  return part;
}

/** Each name/summary and its actual content occupy the same media block. */
export function mediaOpen(part: MediaPart, native = false): string {
  const current = part.presentation === "media-v2" || part.presentation === "expression-v2";
  // Only the request renderer knows whether the bytes were actually admitted. A stored
  // text projection must not assert that an audio/image was unavailable to the model.
  const delivery = current && native ? `以下为消息原位置的原始${LABEL[part.ref.type]}：\n` : "";
  const sticker = part.ref.type === "image" && part.sticker === true;
  const open = `<media ref="${mediaRefText(part.ref)}" type="${part.ref.type}"${sticker ? ' usage="sticker"' : ""}${part.name ? ` name="${escape(part.name)}"` : ""}>\n`;
  const note = part.presentation && part.galleryNote
    ? `收藏备注（你自己的选用线索，不是原图识别或发送者意图）：${escape(part.galleryNote)}\n` : "";
  if ((part.presentation === "expression-v1" || part.presentation === "expression-v2") && sticker) {
    return open + "会话表情包（像 emoji 一样的表意符号；画面仅帮助辨认，不是独立话题）\n" +
      (part.expressionSummary
        ? `字面文字与可能用途（识别可能有误，不代表发送者真实情绪或意图）：${escape(part.expressionSummary)}\n`
        : "未缓存用途提示；如有原图，可结合字面字幕与前后文理解；实际发送意图仍需语境判断，也可以不接话。\n") + note + delivery;
  }
  // Read descriptions from persisted pre-0.3 events without exposing the old #N/attachment protocol.
  // No discriminator means exactly the historical rendering, including its wording. It may be
  // recomputed after a restart, so upgrades must not rewrite this frozen model prefix.
  const legacySummary = part.marker.match(/^\[(?:图片|视频|音频|语音)#\d+[:：]([\s\S]*)\]$/)?.[1]?.trim();
  const summary = part.summary ?? legacySummary;
  return open + `${sticker ? "表情包（按表情使用）" : LABEL[part.ref.type]}${summary ? `；文字摘要（可能有误）：${escape(summary)}` : current ? "" : "；暂无文字摘要"}\n` + note + delivery;
}

export function mediaText(part: MediaPart, reason?: string): string {
  const current = part.presentation === "media-v2" || part.presentation === "expression-v2";
  return mediaOpen(part) + (reason ?? (current
    ? "媒体位置记录（文字记录不包含原始媒体数据）。"
    : "此处仅保留媒体身份与文字摘要，未展开原始媒体")) + "\n</media>";
}

export function richPartsText(parts: RichTextPart[]): string {
  return parts.map(part => part.kind === "text" ? part.text : mediaText(part)).join("");
}
