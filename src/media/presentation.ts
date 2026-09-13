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

export function mediaPart(ref: MediaRef, metadata: { name?: string; summary?: string; sticker?: boolean } = {}): MediaPart {
  const part: MediaPart = { kind: "media", ref, ...metadata, marker: "" };
  part.marker = mediaText(part);
  return part;
}

/** Each name/summary and its actual content occupy the same media block. */
export function mediaOpen(part: MediaPart): string {
  // Read descriptions from persisted pre-0.3 events without exposing the old #N/attachment protocol.
  const legacySummary = part.marker.match(/^\[(?:图片|视频|音频|语音)#\d+[:：]([\s\S]*)\]$/)?.[1]?.trim();
  const summary = part.summary ?? legacySummary;
  const sticker = part.ref.type === "image" && part.sticker === true;
  return `<media ref="${mediaRefText(part.ref)}" type="${part.ref.type}"${sticker ? ' usage="sticker"' : ""}${part.name ? ` name="${escape(part.name)}"` : ""}>\n` +
    `${sticker ? "表情包（按表情使用）" : LABEL[part.ref.type]}${summary ? `；文字摘要（可能有误）：${escape(summary)}` : "；暂无文字摘要"}\n`;
}

export function mediaText(part: MediaPart, reason = "此处仅保留媒体身份与文字摘要，未展开原始媒体"): string {
  return mediaOpen(part) + reason + "\n</media>";
}

export function richPartsText(parts: RichTextPart[]): string {
  return parts.map(part => part.kind === "text" ? part.text : mediaText(part)).join("");
}
