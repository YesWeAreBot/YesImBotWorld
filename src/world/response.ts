import type { ChatResult } from "../llm/chat.js";

export interface ParsedWorldResponse {
  value: Record<string, unknown>;
  format: "native" | "json";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(text: unknown, source: string): Record<string, unknown> {
  if (typeof text !== "string" || !text.trim()) throw new Error(`WORLD_RESPONSE_JSON: ${source}缺少完整 JSON 对象。`);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`WORLD_RESPONSE_JSON: ${source}不是完整 JSON；不得截断、使用代码围栏或附加说明文字。`); }
  if (!isObject(value)) throw new Error(`WORLD_RESPONSE_JSON: ${source}必须是 JSON 对象，不能是数组、null 或其他值。`);
  return value;
}

/** Decode transport format only. Every proposal still needs the world's full semantic validation. */
export function parseWorldResponse(result: ChatResult): ParsedWorldResponse {
  if (result.toolCalls.length) {
    if (result.toolCalls.length !== 1) throw new Error("WORLD_RESPONSE_PROTOCOL: 每次只能提交一个 resolve_world 调用。");
    const call = result.toolCalls[0]!;
    if (call.type !== "function" || call.function?.name !== "resolve_world") throw new Error("WORLD_RESPONSE_PROTOCOL: 只能调用 resolve_world。");
    // A broken native proposal is never replaced by a different proposal in content.
    return { value: parseObject(call.function.arguments, "resolve_world.arguments"), format: "native" };
  }

  const value = parseObject(result.content, "响应正文");
  if (Object.hasOwn(value, "name") || Object.hasOwn(value, "arguments")) {
    if (value.name !== "resolve_world" || !Object.hasOwn(value, "arguments") || Object.keys(value).length !== 2) {
      throw new Error("WORLD_RESPONSE_PROTOCOL: JSON 调用封装只能包含 name: resolve_world 和 arguments。");
    }
    const args = typeof value.arguments === "string" ? parseObject(value.arguments, "resolve_world.arguments") : value.arguments;
    if (!isObject(args)) throw new Error("WORLD_RESPONSE_JSON: resolve_world.arguments 必须是 JSON 对象。");
    return { value: args, format: "json" };
  }
  return { value, format: "json" };
}
