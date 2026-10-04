import type { ParsedToolCall } from "../types.js";

export class ToolCallParseError extends Error {
  constructor(
    message: string,
    readonly raw?: string,
    /** A structurally valid attempt rejected by availability, never an executed call. */
    readonly parsedCall?: ParsedToolCall,
  ) {
    super(message);
    this.name = "ToolCallParseError";
  }
}

/**
 * 从模型输出中宽松地提取一个工具调用 JSON。
 * 兼容 <think> 段、markdown 代码块、前后杂散文本。
 */
export function extractToolCall(raw: string, allowedNames: string[]): ParsedToolCall {
  let text = raw.replace(/^\uFEFF/, "").trim();
  // Reasoning envelopes are outside the call. Never remove similarly spelled text
  // inside a JSON argument or a quoted character monologue.
  while (/^<(?:think|thinking)>/.test(text)) {
    const tag = text.startsWith("<thinking>") ? "thinking" : "think";
    const end = text.indexOf(`</${tag}>`);
    if (end < 0) break;
    text = text.slice(end + tag.length + 3).trim();
  }
  text = unwrapCodeFence(text);
  const shorthand = parseThoughtShorthand(text, allowedNames, raw);
  if (shorthand) return shorthand;

  // 模板强制开启思考（prompt 里预置了 <think>）时，输出的思考段没有配对的开标签，
  // 只以 </think> 结尾——若它出现在第一个 JSON 之前，裁掉前导思考段
  const thinkEnd = text.indexOf("</think>");
  if (thinkEnd >= 0) {
    const firstBrace = text.indexOf("{");
    if (firstBrace === -1 || thinkEnd < firstBrace) {
      text = text.slice(thinkEnd + "</think>".length).trim();
    }
  }
  // 去掉 markdown 代码块围栏
  text = unwrapCodeFence(text);
  const thoughtAfterReasoning = parseThoughtShorthand(text, allowedNames, raw);
  if (thoughtAfterReasoning) return thoughtAfterReasoning;

  const json = findFirstJsonObject(text);
  if (!json) {
    if (text.includes("{")) {
      throw new ToolCallParseError("JSON 对象未闭合（输出可能被截断），请保证工具调用完整闭合", raw);
    }
    throw new ToolCallParseError("输出中找不到 JSON 对象", raw);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonLiterals(json));
  } catch (e) {
    throw new ToolCallParseError(`JSON 解析失败: ${(e as Error).message}`, raw);
  }
  try {
    return validateToolCall(parsed, allowedNames);
  } catch (err) {
    if (err instanceof ToolCallParseError) {
      throw new ToolCallParseError(err.message, raw, err.parsedCall);
    }
    throw err;
  }
}

function unwrapCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json|js|javascript|text)?\s*\n([\s\S]*?)\n```\s*$/);
  return fenced ? fenced[1]!.trim() : text;
}

/** A literal-only convenience syntax, not JavaScript execution or a second tool protocol. */
function parseThoughtShorthand(text: string, allowedNames: string[], raw: string): ParsedToolCall | undefined {
  if (!/^think\s*\(/.test(text)) return;
  const match = text.match(/^think\s*\(\s*("(?:\\[\s\S]|[^"\\])*")\s*\)$/u);
  if (!match) throw new ToolCallParseError('think 简写须为 think("内容")，只包含一个 JSON 字符串；本次没有执行操作。', raw);
  let thought: unknown;
  try { thought = JSON.parse(match[1]!); }
  catch { throw new ToolCallParseError('think 简写中的字符串转义无效；本次没有执行操作。', raw); }
  try { return validateToolCall({ name: "think", arguments: { thought } }, allowedNames); }
  catch (error) {
    if (error instanceof ToolCallParseError) throw new ToolCallParseError(error.message, raw, error.parsedCall);
    throw error;
  }
}

export function validateToolCall(parsed: unknown, allowedNames: string[]): ParsedToolCall {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolCallParseError("工具调用必须是 JSON 对象");
  }
  const obj = parsed as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new ToolCallParseError(
      `未知工具 "${String(name)}"，可用工具: ${allowedNames.join(", ")}`,
    );
  }
  let args: Record<string, unknown> = {};
  if (obj.arguments !== undefined) {
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
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ToolCallParseError("arguments 必须是 JSON 对象，不能是 null、数组或单个值");
  }
  // Both body JSON and native calls use the same envelope. Native schemas expose
  // duration as an argument; body JSON may also use that spelling after a tool update.
  // Never silently discard either value or mutate a caller-owned argument object.
  args = { ...args };
  const topDuration = obj.duration === undefined ? undefined : parseDuration(obj.duration, "duration");
  const argumentDuration = args.duration === undefined ? undefined : parseDuration(args.duration, "arguments.duration");
  if (topDuration !== undefined && argumentDuration !== undefined && topDuration !== argumentDuration) {
    throw new ToolCallParseError("duration 与 arguments.duration 冲突，本次没有执行。请只提供一个耗时，或让两处数值一致。");
  }
  const duration = topDuration ?? argumentDuration;
  delete args.duration;
  const call = { name, arguments: args, duration };
  if (!allowedNames.includes(name)) {
    throw new ToolCallParseError(`未知工具 "${name}"，可用工具: ${allowedNames.join(", ")}`, undefined, call);
  }
  return call;
}

function parseDuration(value: unknown, location: string): number {
  // Keep numeric-string compatibility, but do not turn null, booleans, arrays or
  // empty strings into apparently valid zero/one-TU actions via Number coercion.
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) {
    throw new ToolCallParseError(`${location} 必须是有限非负数字，省略表示未指定耗时。`);
  }
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) throw new ToolCallParseError(`${location} 必须是有限非负数字。`);
  return duration;
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

/** 模型常把 JSON 字符串里的换行写成真实换行；JSON.parse 之前把它们转成 \n / \r / \t。 */
function normalizeJsonLiterals(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}
