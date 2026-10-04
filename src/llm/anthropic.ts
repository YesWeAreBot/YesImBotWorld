/** Anthropic Messages protocol. Transport/authentication and call logging live in ChatClient. */
import type { ChatMessage, ChatUsage, ContentPart, RawToolCall } from "./chat.js";
import type { ChatProtocolAdapter, ProtocolProgress } from "./protocol.js";
import { ChatCompletionError, UnsupportedProtocolModalityError, withUsage } from "./errors.js";
import { readProtocolStream } from "./http.js";

type ObjectValue = Record<string, unknown>;
type InputBlock = Record<string, unknown>;
interface OutputBlock {
  type: "text" | "tool_use" | "thinking" | "redacted_thinking";
  closed: boolean;
  text: string;
  id?: string;
  name?: string;
  initialInput?: ObjectValue;
  json?: string;
}
const isObject = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(message: string): never { throw new ChatCompletionError("LLM_RESPONSE_INVALID", `Anthropic: ${message}`); }
function remoteError(value: unknown): never {
  const detail = isObject(value) ? value : {};
  const message = typeof value === "string" ? value : typeof detail.message === "string" ? detail.message : "服务端未提供错误详情";
  const type = typeof detail.type === "string" ? ` (${detail.type.slice(0, 160)})` : "";
  throw new ChatCompletionError("LLM_REMOTE_ERROR", message.slice(0, 1000) + type);
}

function imagePart(part: Extract<ContentPart, { type: "image_url" }>): InputBlock {
  const url = part.image_url?.url;
  if (typeof url !== "string" || !url) throw new Error("Anthropic 图片缺少 URL。");
  if (/^data:/i.test(url)) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/]+={0,2})$/i.exec(url);
    if (!match || match[2]!.length % 4 === 1) throw new UnsupportedProtocolModalityError("anthropic（图片须为 PNG/JPEG/GIF/WebP 的 base64 数据）", "image_url");
    return { type: "image", source: { type: "base64", media_type: match[1]!.toLowerCase(), data: match[2]! } };
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Anthropic 图片需要有效的 HTTP(S) URL 或 base64 data URL。"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new UnsupportedProtocolModalityError("anthropic（图片来源须为 HTTP(S) 或 base64）", "image_url");
  return { type: "image", source: { type: "url", url } };
}
function inputContent(content: ChatMessage["content"], system = false): InputBlock[] {
  const parts: ContentPart[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(parts)) throw new Error("Anthropic 消息正文必须是文本或媒体块数组。");
  return parts.flatMap((part): InputBlock[] => {
    if (part.type === "text") {
      if (typeof part.text !== "string") throw new Error("Anthropic 文本块缺少 text。");
      return part.text ? [{ type: "text", text: part.text }] : [];
    }
    if (part.type === "input_audio" || part.type === "video_url") throw new UnsupportedProtocolModalityError("anthropic", part.type);
    if (part.type === "image_url") {
      if (system) throw new UnsupportedProtocolModalityError("anthropic system（系统提示只接受文本）", part.type);
      return [imagePart(part)];
    }
    throw new Error("Anthropic 不支持此消息内容块，不能静默丢弃。");
  });
}
function objectArguments(value: string, description: string): ObjectValue {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${description}必须是完整 JSON 对象。`); }
  if (!isObject(parsed)) throw new Error(`${description}必须是 JSON 对象，不能是数组或标量。`);
  return parsed;
}

/** No coalescing adjacent turns or moving later instructions into the cached prefix. */
function requestMessages(messages: ChatMessage[]): { system?: InputBlock[]; messages: { role: "user" | "assistant"; content: InputBlock[] }[] } {
  const system: InputBlock[] = [], mapped: { role: "user" | "assistant"; content: InputBlock[] }[] = [];
  const pending = new Set<string>(), used = new Set<string>();
  let inPrefix = true;
  for (const message of messages) {
    if (inPrefix && message.role === "system") { system.push(...inputContent(message.content, true)); continue; }
    inPrefix = false;
    if (message.role === "tool") {
      const id = message.tool_call_id;
      if (!id || !pending.delete(id)) throw new Error("Anthropic 工具结果必须紧跟对应 tool_use，且 tool_call_id 只能回答一次。");
      if (message.tool_calls?.length) throw new Error("工具结果不能同时发起工具调用。");
      mapped.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: inputContent(message.content) }] });
      continue;
    }
    if (pending.size) throw new Error("Anthropic tool_use 后必须先返回全部工具结果，不能插入其他消息或省略结果。");
    const content = inputContent(message.content);
    if (message.role === "system") content.unshift({ type: "text", text: "以下是此处追加的运行时指令与上下文（原 system 消息），不是聊天平台参与者的发言：" });
    if (message.tool_calls?.length) {
      if (message.role !== "assistant") throw new Error("只有 assistant 消息能发起 Anthropic 工具调用。");
      for (const call of message.tool_calls) {
        if (call.type !== "function" || !call.id?.trim() || !call.function?.name?.trim() || used.has(call.id)) throw new Error("Anthropic 历史工具调用需要唯一 id 和函数名称。");
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input: objectArguments(call.function.arguments, "历史工具参数") });
        pending.add(call.id); used.add(call.id);
      }
    }
    if (!content.length) throw new Error("Anthropic 不接受空消息；不能凭空填充内容或隐去历史回合。");
    mapped.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }
  if (pending.size) throw new Error("Anthropic 请求仍有未返回结果的 tool_use。");
  if (!mapped.length) throw new Error("Anthropic 至少需要一条用户或助手消息。");
  // One stable breakpoint, independent of the growing conversation or current tools.
  if (system.length) system[system.length - 1] = { ...system.at(-1), cache_control: { type: "ephemeral" } };
  return { ...(system.length ? { system } : {}), messages: mapped };
}

function usageOf(raw: ObjectValue | undefined): ChatUsage | null {
  if (!raw) return null;
  const get = (key: string): number | undefined => {
    const value = raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`usage.${key}不是非负整数。`);
    return value;
  };
  const input = get("input_tokens"), created = get("cache_creation_input_tokens"), cached = get("cache_read_input_tokens"), output = get("output_tokens");
  if ([input, created, cached, output].every(value => value === undefined)) return null;
  const prompt = input === undefined ? undefined : input + (created ?? 0) + (cached ?? 0);
  if (prompt !== undefined && (!Number.isSafeInteger(prompt) || output !== undefined && !Number.isSafeInteger(prompt + output))) invalid("usage计数总和超出安全整数范围。");
  return { ...(prompt !== undefined ? { prompt_tokens: prompt } : {}), ...(output !== undefined ? { completion_tokens: output } : {}),
    ...(prompt !== undefined && output !== undefined ? { total_tokens: prompt + output } : {}),
    ...(cached !== undefined ? { cache_read_input_tokens: cached, prompt_tokens_details: { cached_tokens: cached }, cached_tokens: cached, cache_reported: true } : {}) };
}
function updateUsage(previous: ObjectValue | undefined, next: unknown): ObjectValue | undefined {
  if (next === undefined || next === null) return previous;
  if (!isObject(next)) invalid("usage必须是对象。");
  const merged = { ...previous, ...next }; usageOf(merged); return merged;
}
function knownUsage(raw: unknown): ChatUsage | undefined {
  try { return isObject(raw) ? usageOf(raw) ?? undefined : undefined; }
  catch { return undefined; } // Malformed accounting must not hide the original refusal/stream error.
}
function assertFinished(reason: unknown, complete: boolean, details?: unknown): asserts reason is string {
  if (reason === "refusal" || isObject(details) && details.type === "refusal") throw new ChatCompletionError("LLM_CONTENT_FILTERED", "Anthropic 拒绝完成此响应，本次结果未采用。", typeof reason === "string" ? reason : null);
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") throw new ChatCompletionError("LLM_OUTPUT_TRUNCATED", "Anthropic 输出达到 token 或上下文上限，本次结果未采用。", reason);
  if (!complete || typeof reason !== "string" || !["end_turn", "tool_use", "stop_sequence"].includes(reason)) {
    throw new ChatCompletionError("LLM_STREAM_INCOMPLETE", "Anthropic 响应没有完整结束，不能执行其中的工具调用。", typeof reason === "string" ? reason : null);
  }
}
function newBlock(value: unknown, closed: boolean): OutputBlock {
  if (!isObject(value) || typeof value.type !== "string") invalid("响应内容块无效。");
  if (value.type === "text") {
    if (typeof value.text !== "string") invalid("text内容块缺少文本。");
    return { type: "text", text: value.text, closed };
  }
  if (value.type === "tool_use") {
    if (typeof value.id !== "string" || !value.id.trim() || typeof value.name !== "string" || !value.name.trim() || !isObject(value.input)) invalid("tool_use缺少id、name或对象input。");
    return { type: "tool_use", text: "", id: value.id, name: value.name, initialInput: value.input, closed };
  }
  if (value.type === "thinking") {
    if (typeof value.thinking !== "string") invalid("thinking内容块缺少文本。");
    return { type: "thinking", text: value.thinking, closed };
  }
  if (value.type === "redacted_thinking") {
    if (typeof value.data !== "string") invalid("redacted_thinking内容块无效。");
    return { type: "redacted_thinking", text: "", closed };
  }
  if (value.type === "refusal") throw new ChatCompletionError("LLM_CONTENT_FILTERED", "Anthropic 返回拒绝内容，本次结果未采用。", "refusal");
  invalid(`暂不支持响应内容块 ${value.type}，不能静默丢弃或把服务端工具当成本地工具执行。`);
}
function snapshot(blocks: OutputBlock[], usage: ObjectValue | undefined, reason: string | null | undefined, complete: boolean): ProtocolProgress {
  const toolCalls: RawToolCall[] = blocks.filter(block => block.type === "tool_use").map(block => ({ id: block.id!, type: "function",
    function: { name: block.name!, arguments: block.json === undefined ? JSON.stringify(block.initialInput) : block.json } }));
  const reasoning = blocks.filter(block => block.type === "thinking").map(block => block.text).join("");
  return { content: blocks.filter(block => block.type === "text").map(block => block.text).join(""), toolCalls, usage: usageOf(usage),
    finishReason: reason, complete, ...(reasoning ? { reasoning } : {}) };
}
function finish(blocks: OutputBlock[], usage: ObjectValue | undefined, reason: unknown, complete: boolean, details?: unknown): ProtocolProgress {
  assertFinished(reason, complete, details);
  if (blocks.some(block => !block.closed)) throw new ChatCompletionError("LLM_STREAM_INCOMPLETE", "Anthropic 内容块未完整结束。", reason);
  const result = snapshot(blocks, usage, reason, true), ids = new Set<string>();
  for (const tool of result.toolCalls) {
    if (ids.has(tool.id)) invalid("重复tool_use id，不能重复执行。"); ids.add(tool.id);
    try { objectArguments(tool.function.arguments, "响应工具参数"); } catch { invalid("工具参数不是完整JSON对象，不能执行。"); }
  }
  if ((reason === "tool_use") !== (result.toolCalls.length > 0)) invalid("stop_reason与工具调用内容不一致。");
  return result;
}

export const anthropicAdapter: ChatProtocolAdapter = {
  buildRequest(config, messages, options, stream) {
    const format = options.responseFormat ?? (options.responseSchema ? "json_schema" : "text");
    if (format === "json_object") throw new Error("Anthropic Messages 没有原生 json_object 模式；请选择 json_schema 或 text，不会静默削弱输出约束。");
    if (format === "json_schema" && !options.responseSchema) throw new Error("Anthropic json_schema 需要提供 responseSchema。");
    if (options.toolChoice && !options.tools?.some(tool => tool.function.name === options.toolChoice!.function.name)) throw new Error("指定的 Anthropic 工具不在本次工具定义中。");
    return { model: config.model, max_tokens: options.maxTokens ?? config.maxTokens ?? 2048, ...requestMessages(messages), stream,
      ...(options.tools?.length ? { tools: options.tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: structuredClone(tool.function.parameters) })) } : {}),
      ...(options.toolChoice ? { tool_choice: { type: "tool", name: options.toolChoice.function.name } } : {}),
      ...(format === "json_schema" ? { output_config: { format: { type: "json_schema", schema: structuredClone(options.responseSchema!.schema) } } } : {}),
      ...(config.disableThinking ? { thinking: { type: "disabled" } } : {}),
      // Claude generations differ in temperature support. Use native model defaults;
      // do not guess by model name or forward the chat-completions default of 0.7.
    };
  },
  decodeResponse(value) {
    try {
    if (!isObject(value)) invalid("响应必须是消息对象。");
    if (value.type === "error" || value.error !== undefined) remoteError(value.error);
    if (value.type !== "message" || value.role !== "assistant" || !Array.isArray(value.content)) invalid("响应缺少assistant消息及content数组。");
    assertFinished(value.stop_reason, true, value.stop_details);
    const blocks = value.content.map(block => newBlock(block, true));
    return finish(blocks, updateUsage(undefined, value.usage), value.stop_reason, true, value.stop_details);
    } catch (error) { throw withUsage(error, knownUsage(isObject(value) ? value.usage : undefined)); }
  },
  async readStream(response, onProgress, onText) {
    let started = false, stopped = false, sawDelta = false;
    let usage: ObjectValue | undefined, reason: string | null | undefined, details: unknown;
    const blocks: OutputBlock[] = [];
    let lastEmit = 0, dirty = false;
    const emit = (force = false) => {
      if (!dirty || !force && Date.now() - lastEmit < 80) return;
      lastEmit = Date.now(); dirty = false; onProgress(snapshot(blocks, usage, reason, false));
    };
    try {
    const data = await readProtocolStream(response, event => {
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { invalid("流中包含无效JSON事件。"); }
      if (!isObject(value) || typeof value.type !== "string") invalid("流事件缺少type。");
      if (event.event && event.event !== "message" && event.event !== value.type) invalid("SSE事件名与数据type不一致。");
      if (value.type === "error" || value.error !== undefined) remoteError(value.error);
      if (value.type === "ping") return;
      // Future metadata events can be ignored. Unknown content blocks/deltas cannot:
      // dropping their semantics could turn an incomplete proposal into an action.
      if (!["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"].includes(value.type)) return;
      if (stopped) invalid("message_stop之后仍收到消息内容。");
      if (value.type === "message_start") {
        if (started) invalid("重复message_start。");
        const message = value.message;
        if (!isObject(message) || message.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length
          || message.stop_reason != null) invalid("message_start不是空的未完成assistant消息。");
        started = true; usage = updateUsage(usage, message.usage); dirty = true; emit(true); return;
      }
      if (!started) invalid("message_start之前收到内容。");
      if (value.type === "message_delta") {
        if (blocks.some(block => !block.closed) || !isObject(value.delta)) invalid("message_delta先于内容块完成，或缺少delta对象。");
        sawDelta = true;
        if (value.delta.stop_reason != null) {
          if (typeof value.delta.stop_reason !== "string" || reason && reason !== value.delta.stop_reason) invalid("stop_reason无效或发生冲突。");
          reason = value.delta.stop_reason;
        }
        if (value.delta.stop_details !== undefined) details = value.delta.stop_details;
        usage = updateUsage(usage, value.usage); dirty = true; emit(true); return;
      }
      if (value.type === "message_stop") {
        stopped = true; dirty = true; emit(true);
        // Validate before exposing a complete result; previews never authorize execution.
        finish(blocks, usage, reason, sawDelta, details); return;
      }
      if (sawDelta) invalid("message_delta之后又收到内容块。");
      const index = value.index;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) invalid("内容块index无效。");
      if (value.type === "content_block_start") {
        if (index !== blocks.length) invalid("内容块index重复或有缺口。");
        blocks.push(newBlock(value.content_block, false)); dirty = true; emit(true); return;
      }
      const block = blocks[index];
      if (!block || block.closed) invalid("内容增量缺少对应的未结束内容块。");
      if (value.type === "content_block_stop") { block.closed = true; dirty = true; emit(true); return; }
      const delta = value.delta;
      if (!isObject(delta)) invalid("内容增量缺少delta对象。");
      if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") block.text += delta.text;
      else if (delta.type === "input_json_delta" && block.type === "tool_use" && typeof delta.partial_json === "string") {
        if (Object.keys(block.initialInput!).length) invalid("tool_use既含完整初始input又含JSON增量，不能猜测合并。");
        if (delta.partial_json) block.json = (block.json ?? "") + delta.partial_json;
      } else if (delta.type === "thinking_delta" && block.type === "thinking" && typeof delta.thinking === "string") block.text += delta.thinking;
      else if (delta.type === "signature_delta" && block.type === "thinking" && typeof delta.signature === "string") return;
      else if (delta.type === "citations_delta" && block.type === "text") return;
      else invalid("增量类型与内容块不匹配或尚不支持。");
      dirty = true; emit();
    }, onText);
    if (data !== undefined) {
      if (started) invalid("SSE与完整JSON响应混杂。");
      const result = anthropicAdapter.decodeResponse(data); onProgress(result); return result;
    }
    emit(true);
    const result = finish(blocks, usage, reason, started && stopped && sawDelta, details);
    onProgress(result); return result;
    } catch (error) { throw withUsage(error, knownUsage(usage)); }
  },
};
