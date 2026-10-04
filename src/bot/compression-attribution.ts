import type { BotEvent, StreamEntry } from "../types.js";
import { mediaRefText } from "../media/presentation.js";
import { projectObservedMessages } from "./perception-fragments.js";

/** A bounded source reference, not another model summary or a new perceived experience. */
export interface ChatAttribution {
  root: string;
  eventId: string;
  channel: string;
  sender?: string;
  ownership: "own-account" | "other" | "unknown";
  kind: "observed" | "sent" | "partial";
  agency: "self" | "imposed" | "unknown";
  quotedSender?: string;
  responseToRoots: string[];
  /** A batch send receipt cannot supply an individual platform message's body. */
  textKind: "message" | "receipt";
  /** A stable text/media projection, never a statement about native request delivery. */
  mediaIdentity?: true;
  textEventId: string;
  text: string;
}

const MAX_ROWS = 12;
const MAX_PER_CHANNEL = 6;
const MAX_REFERENCE_CHARS = 4000;
const MAX_BODY_CHARS = 420;
const REFERENCE_GUIDANCE = "以下仅核对已看过的消息归属；优先于摘要中的人物归属。发过一句话不证明回答正确、问题解决或对方认可。自用账号发言不等于亲自发送；没有明确引用不猜回应对象。较长正文未复制，不据缺省正文判断意思。";
const MEDIA_GUIDANCE = "媒体身份记录不表示当前展开状态；已有摘要可能有误。";

/** The stored fallback marker describes a particular rendering, not the message itself. */
function messageBody(event: BotEvent): { text: string; mediaIdentity?: true } {
  if (!event.parts?.some(part => part.kind === "media")) return { text: event.content };
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { mediaIdentity: true, text: event.parts.map(part => {
    if (part.kind === "text") return part.text;
    // Only typed, program-bound metadata establishes this identity. In particular, do not
    // parse user prose or a historical marker to infer whether the model saw/heard a file.
    const sticker = part.ref.type === "image" && part.sticker === true;
    const summary = sticker ? part.expressionSummary : part.summary;
    return `<media ref="${mediaRefText(part.ref)}" type="${part.ref.type}"${sticker ? ' usage="sticker"' : ""}${part.name ? ` name="${escape(part.name)}"` : ""}>` +
      (summary ? `文字摘要（可能有误）：${escape(summary)}` : "") + "</media>";
  }).join("") };
}

/** Only trusted system notices are omitted; a real speaker can use identical words. */
export function isCompressionScaffolding(event: BotEvent): boolean {
  if (event.generationCue) return true;
  if (event.source !== "system" || event.refToolCallId || event.experience || event.statusEcho || event.parts?.length || event.attachments?.length) return false;
  if (event.toolAvailability) return true;
  if (event.toolTutorial && event.originEventIds?.length === 0) return true;
  return event.originEventIds?.length === 0 && event.content.startsWith("（当前可考虑的行动机会；");
}

function messageRoots(event: BotEvent): string[] {
  return [...new Set(event.originEventIds ?? [])].filter(root => root.startsWith("chat-message:"));
}

function reference(event: BotEvent): ChatAttribution[] {
  const experience = event.experience;
  const chat = experience?.chat;
  // Neither an anonymous notification nor a last-row snapshot heading establishes a message.
  if (!["koishi", "tool"].includes(event.source) || !chat || !["message", "send"].includes(chat.kind)
    || experience?.worldPerception || experience?.internalThought || experience?.outcome === "failed") return [];
  const roots = messageRoots(event);
  if (!roots.length) return [];
  const sent = chat.kind === "send";
  // One send can produce text/sticker/text batches with distinct platform IDs.
  // The action describes the whole attempt, not any individual message's body.
  // Keep only the actual receipt here; per-root observations can supply the body later.
  const projected = sent ? { text: event.content } : messageBody(event);
  const { text } = projected;
  const body = text.length <= MAX_BODY_CHARS ? text : "（正文较长，未复制；内容须核对原事件。）";
  const eventId = event.perceptionOf?.eventId ?? event.id;
  return roots.map(root => ({
    root, eventId, channel: chat.channelKey,
    ...(chat.senderId ? { sender: chat.senderId } : {}),
    ownership: chat.senderOwn === true ? "own-account" : chat.senderOwn === false ? "other" : "unknown",
    kind: sent ? experience?.outcome === "completed" ? "sent" : "partial" : "observed",
    agency: sent && experience?.agency === "self" ? "self" : sent && experience?.agency === "imposed" ? "imposed" : "unknown",
    ...(chat.direction?.quotedSenderId ? { quotedSender: chat.direction.quotedSenderId } : {}),
    responseToRoots: (experience?.responseToRoots ?? []).filter(root => root.startsWith("chat-message:")).slice(0, 4),
    textKind: sent ? "receipt" : "message", textEventId: eventId,
    ...(projected.mediaIdentity ? { mediaIdentity: true as const } : {}),
    text: body,
  }));
}

/** Authorship is program metadata; never recognize row delimiters or claims in user prose. */
export function chatAttributionForEvent(event: BotEvent): ChatAttribution[] {
  if (event.parts?.some(part => part.observedMessage)) {
    const messages = projectObservedMessages(event.id, [{ kind: "event", event }]);
    if (messages) return messages.flatMap(reference);
    return []; // Broken/legacy ownership is unknown, never assign the entire snapshot to its tail.
  }
  return reference(event);
}

function line(row: ChatAttribution): string {
  const ownership = row.ownership === "own-account" ? "自用账号" : row.ownership === "other" ? "他人账号" : "账号归属未确认";
  const action = row.kind === "observed" ? "看见发言，操作者未确认" : row.kind === "partial" ? "发送回执，完整发送结果未确认"
    : row.agency === "self" ? "本人发送已确认" : row.agency === "imposed" ? "非自主发送已确认" : "发送已确认，操作者未确认";
  const quote = row.quotedSender ? `；引用作者=${JSON.stringify(row.quotedSender)}` : "";
  const reply = row.responseToRoots.length ? `；引用来源=${JSON.stringify(row.responseToRoots)}` : "";
  const textSource = row.textEventId === row.eventId ? "" : `；文字来源事件=${JSON.stringify(row.textEventId)}`;
  const textLabel = row.textKind === "message" ? row.mediaIdentity ? "消息文字与媒体身份记录" : "已看见的消息原文" : "发送回执（非逐条消息正文）";
  // JSON quoting preserves data boundaries even if a platform name/message includes newlines.
  return `频道=${JSON.stringify(row.channel)}；发送者=${JSON.stringify(row.sender ?? "未记录")}（${ownership}）；${action}${quote}${reply}\n来源=${JSON.stringify(row.root)}，原事件=${JSON.stringify(row.eventId)}${textSource}；${textLabel}=${JSON.stringify(row.text)}`;
}

export function renderChatAttribution(rows: readonly ChatAttribution[]): string {
  // Existing persisted references used the old guidance in their size bound. Keep it exact
  // unless a new typed projection is present, or loading a near-limit old record could fail.
  return rows.length ? REFERENCE_GUIDANCE + (rows.some(row => row.mediaIdentity) ? MEDIA_GUIDANCE : "") + "\n" + rows.map(line).join("\n") : "";
}

/** Update only at a normal compression boundary. Rereads never invent new turns. */
export function retainChatAttribution(previous: readonly ChatAttribution[], entries: readonly StreamEntry[]): ChatAttribution[] {
  const rows = new Map(previous.map(row => [row.root, structuredClone(row)]));
  for (const entry of entries) {
    if (entry.kind !== "event") continue;
    for (const row of chatAttributionForEvent(entry.event)) {
      const old = rows.get(row.root);
      if (!old) rows.set(row.root, row);
      // A later real receipt can clarify who sent an observed own-account message.
      // The subsequent platform echo may in turn establish its quoted author. Merge these
      // independent facts without downgrading authorship or promoting a reread to a new turn.
      else if (old.channel === row.channel && (!old.sender || !row.sender || old.sender === row.sender)) {
        const rank = { observed: 0, partial: 1, sent: 2 };
        const [base, supplement] = rank[row.kind] > rank[old.kind] ? [row, old] : [old, row];
        const body = old.textKind === "message"
          ? row.textKind === "message" && row.mediaIdentity && !old.mediaIdentity ? row : old
          : row.textKind === "message" ? row : base;
        rows.set(row.root, { ...base,
          ...(base.sender ?? supplement.sender ? { sender: base.sender ?? supplement.sender } : {}),
          ownership: base.ownership === "unknown" ? supplement.ownership : base.ownership,
          ...(base.quotedSender ?? supplement.quotedSender ? { quotedSender: base.quotedSender ?? supplement.quotedSender } : {}),
          responseToRoots: base.responseToRoots.length ? base.responseToRoots : supplement.responseToRoots,
          // Confirmation rank controls agency, not body provenance. Actual per-message
          // text wins over a shared receipt regardless of delivery/readback order.
          text: body.text, textKind: body.textKind, textEventId: body.textEventId,
          ...(body.mediaIdentity ? { mediaIdentity: true } : {}),
        });
      }
    }
  }
  const perChannel = new Map<string, number>();
  const result: ChatAttribution[] = [];
  for (const row of [...rows.values()].reverse()) {
    const count = perChannel.get(row.channel) ?? 0;
    if (count >= MAX_PER_CHANNEL) continue;
    if (result.length >= MAX_ROWS) break;
    if (renderChatAttribution([row, ...result]).length > MAX_REFERENCE_CHARS) continue;
    perChannel.set(row.channel, count + 1);
    result.unshift(row);
  }
  return result;
}

/** Fail closed before retiring source context if a persisted reference is malformed. */
export function readChatAttribution(value: unknown): ChatAttribution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS || value.some(row => !row || typeof row !== "object"
    || typeof row.root !== "string" || !row.root.startsWith("chat-message:") || typeof row.eventId !== "string"
    || typeof row.channel !== "string" || typeof row.text !== "string" || row.text.length > MAX_BODY_CHARS
    || !["message", "receipt"].includes(row.textKind) || typeof row.textEventId !== "string" || !row.textEventId
    || row.mediaIdentity !== undefined && (row.mediaIdentity !== true || row.textKind !== "message")
    || row.kind === "observed" && row.textKind !== "message"
    || !["observed", "sent", "partial"].includes(row.kind) || !["own-account", "other", "unknown"].includes(row.ownership)
    || !["self", "imposed", "unknown"].includes(row.agency) || !Array.isArray(row.responseToRoots)
    || row.responseToRoots.length > 4 || row.responseToRoots.some((root: unknown) => typeof root !== "string" || !root.startsWith("chat-message:"))
    || row.sender !== undefined && typeof row.sender !== "string" || row.quotedSender !== undefined && typeof row.quotedSender !== "string")
    || renderChatAttribution(value).length > MAX_REFERENCE_CHARS) throw new Error("已保存的聊天归属参考损坏，保留原始上下文等待恢复");
  return structuredClone(value);
}
