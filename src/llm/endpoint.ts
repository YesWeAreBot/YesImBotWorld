import type { ChatApiType } from "./protocol.js";

/** Accept an API root, gateway prefix, or full generation endpoint. */
export function llmEndpoint(baseURL: string, apiType: ChatApiType, kind: "generate" | "models" = "generate"): string {
  if (!["chat-completions", "responses", "anthropic"].includes(apiType)) throw new Error(`未知 LLM API 类型：${apiType}`);
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("LLM 地址必须是无内嵌凭据的 HTTP(S) 地址。");
  const path = url.pathname.replace(/\/+$/, "");
  let prefix = path.replace(/\/(?:chat\/completions|responses|messages|models)$/, "");
  // An explicitly supplied /messages or /responses is already a full route.
  if (!path) prefix = "/v1";
  const suffix = kind === "models" ? "models" : apiType === "anthropic" ? "messages" : apiType === "responses" ? "responses" : "chat/completions";
  url.pathname = `${prefix}/${suffix}`;
  url.hash = "";
  return url.toString();
}

export function llmHeaders(apiType: ChatApiType, apiKey?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiType === "anthropic"
      ? { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) }
      : apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}
