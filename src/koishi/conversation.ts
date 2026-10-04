import type { h } from "koishi";
import { createHash } from "node:crypto";
import type { RichText } from "../types.js";
import type { WorldMessageRow } from "./messages.js";
import { channelKey } from "./channels.js";

/** A record identity is independent of notification/read/tool-call IDs. Opaque roots
 * cannot accidentally reveal a hidden message's sender or content to a later reader. */
export function chatMessageEvidence(row: Pick<WorldMessageRow, "id" | "platform" | "selfId" | "channelId" | "userId" | "messageId" | "timestamp" | "conversation" | "senderOwned" | "senderOrigin" | "isDirect"> & Partial<Pick<WorldMessageRow, "guildId">>, accountId = row.selfId ?? ""): Pick<RichText, "originEventIds" | "experience"> {
  const account = row.selfId || accountId;
  const channel = [row.platform, account, row.channelId];
  const timestamp = new Date(row.timestamp).getTime();
  // Timestamp also protects the fallback if an administrator clears a database
  // whose auto-increment sequence is then reused; ordinary rereads keep both values.
  const message = row.messageId ? ["platform", String(row.messageId)] : ["stored", row.id, timestamp];
  const replyId = row.conversation?.reply?.messageId;
  return {
    originEventIds: ["chat-message:" + evidenceHash([...channel, ...message])],
    experience: {
      episodeId: "chat-episode:" + evidenceHash([...channel, Number.isFinite(timestamp) ? Math.floor(timestamp / 1_800_000) : "unknown-time"]),
      agency: "observed",
      situation: `聊天频道 ${channelKey(row.platform, row.channelId, account || undefined)}`,
      // A quotation/forwarded author's name does not make them a live participant.
      // Account ownership also does not prove voluntary authorship of a self message.
      subjectIds: row.userId ? [chatSubjectId(row.platform, row.userId)] : [],
      chat: { channelKey: channelKey(row.platform, row.channelId, account || undefined), kind: "message",
        ...(row.userId ? { senderId: chatSubjectId(row.platform, row.userId) } : {}),
        ...(row.senderOwned != null ? { senderOwn: row.senderOwned } : row.senderOrigin === "tool" || (!!account && row.userId === account) ? { senderOwn: true } : {}),
        direction: {
          kind: row.conversation?.kind ?? conversationKind(row.isDirect, row.channelId, row.guildId),
          ...(account ? { accountId: chatSubjectId(row.platform, account) } : {}),
          mentionedIds: (row.conversation?.mentions ?? []).map(id => chatSubjectId(row.platform, id)),
          mentionsEveryone: row.conversation?.mentionsEveryone ?? false,
          ...(row.conversation?.reply?.userId ? { quotedSenderId: chatSubjectId(row.platform, row.conversation.reply.userId) } : {}),
        },
      },
      // A platform quote gives an exact causal link, scoped like the actual send
      // receipt. The root itself grants no access to an unseen original message.
      ...(typeof replyId === "string" && replyId.length ? { responseToRoots: ["chat-message:" + evidenceHash([...channel, "platform", replyId])] } : {}),
    },
  };
}

export function chatSubjectId(platform: string, userId: string): string {
  return "chat-user:" + JSON.stringify([platform, userId]);
}

/** A heard vibration is evidence of the notification, never of its unseen message.
 * All anonymous notifications share a phone/time episode without leaking which
 * account, channel or person caused them. Body delivery keeps a distinct root. */
export function anonymousChatNoticeEvidence(content: Pick<RichText, "originEventIds" | "experience">, timestamp = Date.now()): Pick<RichText, "originEventIds" | "experience"> {
  return {
    ...(content.originEventIds ? { originEventIds: [...new Set(content.originEventIds.map(root =>
      root.startsWith("chat-notice:") ? root : "chat-notice:" + evidenceHash([root])))] } : {}),
    experience: {
      episodeId: content.experience?.episodeId?.startsWith("phone-notice-episode:") ? content.experience.episodeId
        : "phone-notice-episode:" + evidenceHash([Number.isFinite(timestamp) ? Math.floor(timestamp / 1_800_000) : "unknown-time"]),
      agency: "observed", situation: "手机通知",
    },
  };
}

export function evidenceHash(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Platform-declared use, not a visual/filename/summary guess. NapCat also reports market faces
 * as image.file=marketface (https://napneko.github.io/develop/msg). */
export function isStickerElement(el: h): boolean {
  if (el.type === "mface" || el.type === "sticker") return true;
  if (el.type !== "img" && el.type !== "image") return false;
  const subtype = el.attrs?.sub_type ?? el.attrs?.subType;
  return subtype === 1 || subtype === "1" || subtype === 2 || subtype === "2" || el.attrs?.file === "marketface";
}

/** Platform evidence about a message, not a guess about its author's intent. */
export type ConversationMedia = "image" | "sticker" | "face" | "audio" | "video" | "forward";
export interface ConversationContext {
  kind: "direct" | "group" | "unknown";
  mentions: string[];
  mentionsEveryone: boolean;
  reply?: { messageId?: string; userId?: string };
  hasText: boolean;
  media: ConversationMedia[];
  /** Counts occurrences in this message only; absent in older rows, never inferred from asset metadata. */
  mediaCounts?: Partial<Record<ConversationMedia, number>>;
}

export function conversationKind(isDirect?: boolean | null, channelId = "", guildId = ""): ConversationContext["kind"] {
  if (typeof isDirect === "boolean") return isDirect ? "direct" : "group";
  if (channelId.startsWith("private:")) return "direct";
  return guildId ? "group" : "unknown";
}

export function describeConversation(
  elements: h[],
  kind: ConversationContext["kind"],
  isSticker: (element: h) => boolean,
  reply?: ConversationContext["reply"],
): ConversationContext {
  const result: ConversationContext = { kind, mentions: [], mentionsEveryone: false, hasText: false, media: [], ...(reply ? { reply } : {}) };
  const media = (type: ConversationMedia) => {
    result.media.push(type);
    result.mediaCounts ??= {};
    result.mediaCounts[type] = (result.mediaCounts[type] ?? 0) + 1;
  };
  const visit = (nodes: h[]) => {
    for (const node of nodes) {
      if (node.type === "text") result.hasText ||= !!String(node.attrs.content ?? "").trim();
      else if (node.type === "at") {
        if (node.attrs.type === "all" || node.attrs.type === "here") result.mentionsEveryone = true;
        else if (node.attrs.id != null && String(node.attrs.id)) result.mentions.push(String(node.attrs.id));
      } else if (node.type === "quote") {
        // Quoted and forwarded messages do not address the recipient of the containing message.
        if (!result.reply && node.attrs.id != null) result.reply = { messageId: String(node.attrs.id) };
      } else if (node.type === "forward") media("forward");
      else if (["img", "image", "mface", "sticker"].includes(node.type)) media(isSticker(node) ? "sticker" : "image");
      else if (node.type === "face" || node.type === "audio" || node.type === "video") media(node.type);
      else if (node.children?.length) visit(node.children);
    }
  };
  visit(elements);
  result.mentions = [...new Set(result.mentions)];
  result.media = [...new Set(result.media)];
  return result;
}

/** Concise, factual labels shared by live notifications and stored history. */
export function conversationLabel(context: ConversationContext | null | undefined, selfId?: string): string {
  if (!context) return "对话指向未记录";
  const facts: string[] = [];
  if (context.kind === "direct") facts.push("私聊");
  else {
    facts.push(context.kind === "group" ? "群聊" : "会话类型未知");
    if (selfId && context.mentions.includes(selfId)) facts.push("明确 @ 本账号");
    const others = context.mentions.filter(id => id !== selfId);
    if (others.length) facts.push("@ 其他账号 " + others.map(id => JSON.stringify(id)).join("、"));
    if (context.mentionsEveryone) facts.push("@ 全体，不是单独找你");
    if (context.reply) {
      facts.push(context.reply.userId
        ? (selfId && context.reply.userId === selfId ? "引用本账号的消息" : "引用其他账号 " + JSON.stringify(context.reply.userId) + " 的消息")
        : "有引用，原作者未知");
    }
    if (!context.mentions.length && !context.mentionsEveryone && !context.reply) facts.push("无明确 @ 或引用指向，需结合上下文判断");
  }
  if (context.media.length) {
    const labels = { image: "图片", sticker: "表情包", face: "平台表情", audio: "语音", video: "视频", forward: "转发记录" };
    facts.push((context.hasText ? "附有" : "仅含") + context.media.map(type => {
      const count = context.mediaCounts?.[type];
      return labels[type] + (Number.isSafeInteger(count) && count! > 0 ? `×${count}` : "");
    }).join("、") + (context.hasText ? "" : "，未附文字"));
    if (context.media.some(type => type === "sticker" || type === "face")) {
      facts.push(context.hasText ? "表情与文字共同表意，具体含义结合上下文" : "表情参与会话表意，具体含义结合上下文");
    }
  }
  return facts.join("；");
}
