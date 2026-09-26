import { h } from "koishi";
import { normalizeMsgId } from "./markers.js";
import type { WorldMessageRow } from "./messages.js";

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Display and copyable Koishi syntax. Preview attributes never become outgoing text. */
export function quoteTag(opts: { id?: string; name?: string; text?: string }): string {
  const attrs = Object.entries(opts).filter(([, value]) => !!value).map(([key, value]) => `${key}="${escapeAttribute(value!)}"`);
  return `<quote${attrs.length ? " " + attrs.join(" ") : ""}/>`;
}

/** Decode exactly once; an escaped ampersand cannot introduce another attribute/entity. */
function decodeAttribute(value: string): string {
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, entity => entity === "&apos;" ? "'" : h.unescape(entity));
}

const QUOTE_TAG = /<\/?quote(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const INVALID_QUOTE = "引用格式无效：请使用带完整消息 ID 的 <quote id=\"…\"/> 或 reply_to。";

/** Extract all actual quote elements without reparsing or trimming ordinary body text.
 * Both entry paths must agree. Removing the element also removes its following
 * whitespace, including when a copied quote occurs in the middle of the body.
 */
export function resolveOutgoingQuote(msg: string, replyTo?: string): { msg: string; replyTo?: string; error?: undefined } | { error: string } {
  let target = replyTo === undefined ? undefined : normalizeMsgId(replyTo);
  if (replyTo !== undefined && !target) return { error: INVALID_QUOTE };
  let cursor = 0, result = "", depth = 0, end = 0;
  for (const match of msg.matchAll(QUOTE_TAG)) {
    const tag = match[0], closing = /^<\//.test(tag), selfClosing = /\/\s*>$/.test(tag);
    if (closing) {
      if (!depth || !/^<\/quote\s*>$/i.test(tag)) return { error: INVALID_QUOTE };
      if (--depth) continue;
      end = match.index! + tag.length;
    } else {
      if (depth) { if (!selfClosing) depth++; continue; }
      const before = msg.slice(cursor, match.index);
      if (/<\/?quote(?=[\s/>]|$)/i.test(before)) return { error: INVALID_QUOTE };
      result += before;
      const raw = tag.slice(6, selfClosing ? tag.lastIndexOf("/") : -1);
      // Other attributes may contain the word id. Parse attributes sequentially so
      // quoted preview text can never select a different target.
      const attrs: RegExpExecArray[] = [];
      const attribute = /\s+([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>=]+))/y;
      let offset = 0;
      while (raw.slice(offset).trim()) {
        attribute.lastIndex = offset;
        const attr = attribute.exec(raw);
        if (!attr) return { error: INVALID_QUOTE };
        attrs.push(attr);
        offset = attribute.lastIndex;
      }
      const actualIds = attrs.filter(attr => attr[1]!.toLowerCase() === "id");
      if (actualIds.length !== 1) return { error: INVALID_QUOTE };
      const value = actualIds[0]!;
      const id = normalizeMsgId(decodeAttribute(value[2] ?? value[3] ?? value[4] ?? ""));
      if (!id) return { error: INVALID_QUOTE };
      if (target && target !== id) return { error: "引用目标冲突：正文标签与 reply_to 必须指向同一条消息。" };
      target = id;
      if (!selfClosing) { depth = 1; continue; }
      end = match.index! + tag.length;
    }
    while (end < msg.length && /\s/u.test(msg[end]!)) end++;
    cursor = end;
  }
  if (depth || /<\/?quote(?=[\s/>]|$)/i.test(msg.slice(cursor))) return { error: INVALID_QUOTE };
  return { msg: result + msg.slice(cursor), ...(target ? { replyTo: target } : {}) };
}

/** Read projection only. A literal marker sent as text is never promoted to a reply;
 * only recorded platform metadata can substantiate an old storage placeholder.
 * Existing append-only Bot context and database bytes are left untouched.
 */
export function storedQuoteContent(row: Pick<WorldMessageRow, "content" | "conversation">): string {
  const reply = row.conversation?.reply;
  if (!reply) return row.content;
  const id = reply.messageId;
  const marker = id ? `[引用 msg:${id}]` : undefined;
  const prefix = marker && row.content.startsWith(marker) ? marker
    : row.content.startsWith("[引用了一条消息]") ? "[引用了一条消息]" : undefined;
  if (prefix) return quoteTag({ id }) + row.content.slice(prefix.length).trimStart();
  if (row.content.startsWith("[引用 msg:")) return row.content; // Conflicting old text is not proof of a serialization marker.
  // Already serialized quote elements retain their safe name/text preview.
  if (/<quote(?=[\s/>])/i.test(row.content)) return row.content;
  return quoteTag({ id }) + (row.content ? " " + row.content : "");
}
