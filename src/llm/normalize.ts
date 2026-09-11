import { toWellFormedText } from "../text.js";

/**
 * JSON permits escaped lone surrogates, but fast tokenizers reject the decoded
 * string with TextEncodeInput/TypeError. Repair those code units at the outbound
 * boundary, without changing the saved context or dropping text/media fields.
 */
export function normalizeChatRequest(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  repairedStrings: number;
} {
  let repairedStrings = 0;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const normalized = toWellFormedText(value);
      if (normalized !== value) repairedStrings++;
      return normalized;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    }
    return value;
  };
  const normalized = visit(body) as Record<string, unknown>;
  // Providers decode native function arguments before rendering their chat
  // template. A JSON escape such as \\ud83d must also be checked after decoding.
  if (Array.isArray(normalized.messages)) for (const message of normalized.messages) {
    if (!Array.isArray(message?.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const fn = call?.function;
      if (typeof fn?.arguments !== "string") continue;
      try { JSON.parse(fn.arguments); } catch { continue; }
      // Rewrite affected JSON string tokens only. Parsing and reserializing the
      // whole object would round large numeric IDs unrelated to this repair.
      fn.arguments = fn.arguments.replace(/"(?:[^"\\]|\\[\s\S])*"/g, (token: string) => {
        const decoded = JSON.parse(token) as string, safe = toWellFormedText(decoded);
        if (safe === decoded) return token;
        repairedStrings++;
        return JSON.stringify(safe);
      });
    }
  }
  return { body: normalized, repairedStrings };
}
