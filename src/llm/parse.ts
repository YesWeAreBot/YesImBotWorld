import type { ParsedToolCall } from "../types.js";

export class ToolCallParseError extends Error {}

/**
 * 从模型输出中宽松地提取一个工具调用 JSON。
 * 兼容 <think> 段、markdown 代码块、前后杂散文本。
 */
export function extractToolCall(raw: string, allowedNames: string[]): ParsedToolCall {
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .trim();
  // 去掉 markdown 代码块围栏
  text = text.replace(/```(?:json)?/g, "");

  const json = findFirstJsonObject(text);
  if (!json) throw new ToolCallParseError("输出中找不到 JSON 对象");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ToolCallParseError(`JSON 解析失败: ${(e as Error).message}`);
  }
  return validateToolCall(parsed, allowedNames);
}

export function validateToolCall(parsed: unknown, allowedNames: string[]): ParsedToolCall {
  if (typeof parsed !== "object" || parsed === null) {
    throw new ToolCallParseError("工具调用必须是 JSON 对象");
  }
  const obj = parsed as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== "string" || !allowedNames.includes(name)) {
    throw new ToolCallParseError(
      `未知工具 "${String(name)}"，可用工具: ${allowedNames.join(", ")}`,
    );
  }
  let args: Record<string, unknown> = {};
  if (obj.arguments !== undefined && obj.arguments !== null) {
    if (typeof obj.arguments === "string") {
      // 有些模型会把 arguments 序列化成字符串
      try {
        args = JSON.parse(obj.arguments) as Record<string, unknown>;
      } catch {
        throw new ToolCallParseError("arguments 字符串不是合法 JSON");
      }
    } else if (typeof obj.arguments === "object") {
      args = obj.arguments as Record<string, unknown>;
    } else {
      throw new ToolCallParseError("arguments 必须是对象");
    }
  }
  let duration: number | undefined;
  if (obj.duration !== undefined && obj.duration !== null) {
    const d = Number(obj.duration);
    if (!Number.isFinite(d) || d < 0) throw new ToolCallParseError("duration 必须是非负数字");
    duration = d;
  }
  return { name, arguments: args, duration };
}

/** 扫描出第一个括号平衡的 JSON 对象（正确处理字符串与转义） */
function findFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
