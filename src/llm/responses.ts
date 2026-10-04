/** Stateless Responses API mapping. Protocol facts: https://developers.openai.com/api/docs/guides/function-calling */
import type { ChatClientConfig, ChatCompleteOptions, ChatMessage, ChatUsage, ContentPart, RawToolCall } from "./chat.js";
import { ChatCompletionError, UnsupportedProtocolModalityError, withUsage } from "./errors.js";
import type { ChatProtocolAdapter, ProtocolProgress } from "./protocol.js";
import { readProtocolStream } from "./http.js";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function invalid(message: string): never { throw new ChatCompletionError("LLM_RESPONSE_INVALID", `Responses: ${message}`); }
function remote(value: unknown): never {
  const detail = object(value);
  const message = typeof value === "string" ? value : typeof detail?.message === "string" ? detail.message : "服务端未提供具体错误原因";
  const code = typeof detail?.code === "string" || typeof detail?.code === "number" ? ` (${detail.code})` : "";
  throw new ChatCompletionError("LLM_REMOTE_ERROR", `Responses: ${message.slice(0, 1000)}${code}`);
}
function inputParts(content: ContentPart[]): JsonObject[] {
  return content.map(part => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "image_url") return { type: "input_image", image_url: part.image_url.url, detail: "auto" };
    throw new UnsupportedProtocolModalityError("Responses API", part.type);
  });
}
function inputMessages(messages: ChatMessage[]): JsonObject[] {
  return messages.flatMap(message => {
    const content = typeof message.content === "string" ? message.content : inputParts(message.content);
    if (message.role === "tool") {
      if (!message.tool_call_id?.trim()) invalid("工具结果缺少 tool_call_id。");
      return [{ type: "function_call_output", call_id: message.tool_call_id, output: content }];
    }
    const items: JsonObject[] = [];
    // A native tool-only assistant turn has no empty synthetic prose item.
    if (message.content.length || !message.tool_calls?.length) items.push({ role: message.role, content });
    if (message.tool_calls?.length && message.role !== "assistant") invalid("只有 assistant 消息可以包含工具调用。");
    for (const call of message.tool_calls ?? []) {
      if (!call.id?.trim() || !call.function.name?.trim() || typeof call.function.arguments !== "string") invalid("历史工具调用缺少身份、名称或参数。");
      items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    return items;
  });
}
function buildRequest(config: ChatClientConfig, messages: ChatMessage[], options: ChatCompleteOptions, stream: boolean): JsonObject {
  const format = options.responseFormat ?? (options.responseSchema ? "json_schema" : "text");
  if ((options.responseSchema || format !== "text") && (options.tools?.length || options.toolChoice)) invalid("JSON 响应协议不能同时使用工具调用协议。");
  if (format === "json_schema" && !options.responseSchema) invalid("json_schema 需要 responseSchema。");
  return {
    model: config.model,
    input: inputMessages(messages),
    store: false,
    truncation: "disabled",
    stream,
    // Responses reasoning models have different sampling constraints; use provider defaults.
    max_output_tokens: options.maxTokens ?? config.maxTokens ?? 2048,
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: "function", name: tool.function.name,
      description: tool.function.description, parameters: structuredClone(tool.function.parameters), strict: false })) } : {}),
    ...(options.toolChoice ? { tool_choice: { type: "function", name: options.toolChoice.function.name } } : {}),
    ...(format === "json_schema" ? { text: { format: { type: "json_schema", ...structuredClone(options.responseSchema!), strict: true } } }
      : format === "json_object" ? { text: { format: { type: "json_object" } } } : {}),
    ...(config.disableThinking ? { reasoning: { effort: "none" } } : {}),
  };
}
function usageOf(value: unknown): ChatUsage | null {
  const usage = object(value); if (!usage) return null;
  const result: ChatUsage = {};
  const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  result.prompt_tokens = number(usage.input_tokens);
  result.completion_tokens = number(usage.output_tokens);
  result.total_tokens = number(usage.total_tokens) ?? (result.prompt_tokens !== undefined && result.completion_tokens !== undefined ? result.prompt_tokens + result.completion_tokens : undefined);
  const cached = number(object(usage.input_tokens_details)?.cached_tokens);
  if (cached !== undefined) result.prompt_tokens_details = { cached_tokens: cached };
  return Object.values(result).some(value => value !== undefined) ? result : null;
}
function assertStatus(response: JsonObject): void {
  if (response.error) remote(response.error);
  if (response.status === "failed") remote(response.error);
  if (response.status !== "completed") {
    const reason = object(response.incomplete_details)?.reason;
    if (reason === "max_output_tokens" || reason === "max_messages") throw new ChatCompletionError("LLM_OUTPUT_TRUNCATED", "Responses 输出达到上限，本次结果未采用。", String(reason));
    if (reason === "content_filter") throw new ChatCompletionError("LLM_CONTENT_FILTERED", "Responses 响应被过滤，本次结果未采用。", reason);
    throw new ChatCompletionError("LLM_STREAM_INCOMPLETE", "Responses 响应未正常完成，本次结果未采用。", typeof reason === "string" ? reason : typeof response.status === "string" ? response.status : undefined);
  }
}
function toolCall(item: JsonObject, final: boolean): RawToolCall {
  const id = typeof item.call_id === "string" ? item.call_id : "";
  const name = typeof item.name === "string" ? item.name : "";
  const args = typeof item.arguments === "string" ? item.arguments : "";
  if (final && (!id.trim() || !name.trim() || typeof item.arguments !== "string")) invalid("完整工具调用缺少 call_id、name 或 arguments。");
  return { id, type: "function", function: { name, arguments: args } };
}
function itemStatus(item: JsonObject): void {
  if (item.status !== undefined && item.status !== "completed") throw new ChatCompletionError("LLM_STREAM_INCOMPLETE", "Responses 输出项没有正常结束。", String(item.status));
}
function decodeResponse(value: unknown): ProtocolProgress {
  try { return decodeCompletedResponse(value); }
  catch (error) { throw withUsage(error, usageOf(object(value)?.usage)); }
}
function decodeCompletedResponse(value: unknown): ProtocolProgress {
  const response = object(value); if (!response) invalid("响应不是对象。");
  assertStatus(response);
  if (!Array.isArray(response.output)) invalid("响应缺少 output 列表。");
  const text: string[] = [], reasoning: string[] = [], toolCalls: RawToolCall[] = [];
  const seenCalls = new Set<string>();
  for (const raw of response.output) {
    const item = object(raw); if (!item) invalid("output 中存在无效项目。");
    itemStatus(item);
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)) invalid("输出消息必须是 assistant content 列表。");
      for (const rawPart of item.content) {
        const part = object(rawPart);
        if (part?.type === "refusal") throw new ChatCompletionError("LLM_CONTENT_FILTERED", "Responses 返回了拒绝内容，本次结果未采用。", "refusal");
        if (part?.type !== "output_text" || typeof part.text !== "string") invalid("输出消息包含未知正文类型。");
        text.push(part.text);
      }
    } else if (item.type === "function_call") {
      const call = toolCall(item, true);
      if (seenCalls.has(call.id)) invalid("输出中存在重复 call_id。");
      seenCalls.add(call.id); toolCalls.push(call);
    } else if (item.type === "reasoning") {
      for (const part of Array.isArray(item.summary) ? item.summary : []) {
        if (object(part)?.type === "summary_text" && typeof object(part)?.text === "string") reasoning.push(object(part)!.text as string);
      }
    } else invalid(`无法处理输出项目类型 ${String(item.type)}。`);
  }
  if (!text.join("").trim() && !toolCalls.length) invalid("响应只有推理内容或没有可用正文/工具调用。");
  return { content: text.join(""), toolCalls, usage: usageOf(response.usage), finishReason: toolCalls.length ? "tool_calls" : "stop", complete: true,
    ...(reasoning.length ? { reasoning: reasoning.join("\n") } : {}) };
}

/** Item snapshots replace deltas, so output_item.done and response.completed never echo text/tools twice. */
class ResponseStream {
  private items = new Map<number, JsonObject>();
  private parts = new Map<number, Map<number, string>>();
  private reasoning = new Map<string, string>();
  private seenSequence = new Set<number>();
  private responseId?: string;
  private result?: ProtocolProgress;
  private usage: ChatUsage | null = null;
  constructor(private progress: (value: ProtocolProgress) => void) {}
  get latestUsage(): ChatUsage | null { return this.usage; }
  private index(event: JsonObject): number {
    if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0) invalid("流式输出缺少有效 output_index。");
    return Number(event.output_index);
  }
  private partIndex(event: JsonObject, name = "content_index"): number {
    if (!Number.isSafeInteger(event[name]) || Number(event[name]) < 0) invalid(`流式输出缺少有效 ${name}。`);
    return Number(event[name]);
  }
  private updateText(index: number, part: number, value: string, append: boolean): void {
    const parts = this.parts.get(index) ?? new Map<number, string>();
    parts.set(part, (append ? parts.get(part) ?? "" : "") + value); this.parts.set(index, parts);
  }
  private snapshot(): ProtocolProgress {
    return { content: [...this.parts].sort(([a], [b]) => a - b).flatMap(([, parts]) => [...parts].sort(([a], [b]) => a - b).map(([, text]) => text)).join(""),
      toolCalls: [...this.items].sort(([a], [b]) => a - b).filter(([, item]) => item.type === "function_call").map(([, item]) => toolCall(item, false)),
      // Output strings are immutable and calls above are freshly projected. Clone
      // only the small usage object, not the growing response on every token.
      usage: this.usage ? { ...this.usage, ...(this.usage.prompt_tokens_details ? { prompt_tokens_details: { ...this.usage.prompt_tokens_details } } : {}) } : null,
      complete: false, ...(this.reasoning.size ? { reasoning: [...this.reasoning.values()].join("\n") } : {}) };
  }
  event(value: unknown, eventName?: string): void {
    const event = object(value); if (!event) invalid("流式事件不是对象。");
    const type = typeof event.type === "string" ? event.type : eventName;
    if (!type) invalid("流式事件缺少 type。");
    if (typeof event.sequence_number === "number") {
      if (this.seenSequence.has(event.sequence_number)) return;
      this.seenSequence.add(event.sequence_number);
    }
    const response = object(event.response);
    const id = typeof response?.id === "string" ? response.id : typeof event.response_id === "string" ? event.response_id : undefined;
    if (id && this.responseId && id !== this.responseId) invalid("同一流中混入不同响应身份。");
    if (id) this.responseId = id;
    // Failed/incomplete terminal responses can still report billable tokens.
    // Preserve that accounting without accepting their partial action or prose.
    if (response?.usage) this.usage = usageOf(response.usage) ?? this.usage;
    else if (event.usage) this.usage = usageOf(event.usage) ?? this.usage;
    if (type === "error" || event.error) remote(event.error ?? event);
    if (type === "response.failed" || type === "response.incomplete") {
      if (!response) invalid("终止事件缺少 response。");
      assertStatus({ ...response, status: type === "response.failed" ? "failed" : "incomplete" });
    }
    if (type === "response.completed") {
      const result = decodeResponse(response);
      for (const [index, item] of this.items) {
        const finalItem = object((response!.output as unknown[])[index]);
        if (!finalItem || finalItem.type !== item.type || item.id && finalItem.id !== item.id || item.call_id && finalItem.call_id !== item.call_id) invalid("完成快照与已交付输出项不一致。");
      }
      this.result = result; this.progress(structuredClone(result)); return;
    }
    if (this.result) {
      if (type === "response.usage") return;
      invalid("完成事件之后仍有新的输出。");
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const index = this.index(event), item = object(event.item); if (!item) invalid("输出项事件缺少 item。");
      const prior = this.items.get(index);
      if (prior && (prior.type !== item.type || prior.id && prior.id !== item.id || prior.call_id && prior.call_id !== item.call_id)) invalid("输出项身份在流中发生变化。");
      this.items.set(index, structuredClone(item));
      if (item.type === "message" && Array.isArray(item.content)) item.content.forEach((raw, partIndex) => {
        const part = object(raw);
        if (part?.type === "output_text" && typeof part.text === "string") this.updateText(index, partIndex, part.text, false);
        if (part?.type === "refusal") throw new ChatCompletionError("LLM_CONTENT_FILTERED", "Responses 返回了拒绝内容。", "refusal");
      });
      if (item.type === "reasoning" && Array.isArray(item.summary)) item.summary.forEach((raw, partIndex) => {
        const part = object(raw); if (typeof part?.text === "string") this.reasoning.set(`${index}:${partIndex}`, part.text);
      });
    } else if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const index = this.index(event), current = this.items.get(index);
      if (!current || current.type !== "function_call" || event.item_id && current.id !== event.item_id) invalid("工具参数片段没有对应的调用项目。");
      const value = type.endsWith(".delta") ? event.delta : event.arguments;
      if (typeof value !== "string") invalid("工具参数片段不是字符串。");
      current.arguments = (type.endsWith(".delta") ? String(current.arguments ?? "") : "") + value;
    } else if (type === "response.output_text.delta" || type === "response.output_text.done") {
      const index = this.index(event), value = type.endsWith(".delta") ? event.delta : event.text;
      if (typeof value !== "string") invalid("正文片段不是字符串。");
      const item = this.items.get(index);
      if (item && (item.type !== "message" || event.item_id && item.id !== event.item_id)) invalid("正文片段与输出项目不一致。");
      this.updateText(index, this.partIndex(event), value, type.endsWith(".delta"));
    } else if (type === "response.content_part.added" || type === "response.content_part.done") {
      const part = object(event.part);
      if (part?.type === "output_text" && typeof part.text === "string") this.updateText(this.index(event), this.partIndex(event), part.text, false);
      if (part?.type === "refusal") throw new ChatCompletionError("LLM_CONTENT_FILTERED", "Responses 返回了拒绝内容。", "refusal");
    } else if (/^response\.reasoning(?:_summary)?_text\.(delta|done)$/.test(type)) {
      const value = type.endsWith(".delta") ? event.delta : event.text;
      if (typeof value !== "string") invalid("推理片段不是字符串。");
      const key = `${this.index(event)}:${this.partIndex(event, type.includes("_summary") ? "summary_index" : "content_index")}`;
      this.reasoning.set(key, (type.endsWith(".delta") ? this.reasoning.get(key) ?? "" : "") + value);
    } else if (type.startsWith("response.refusal.")) throw new ChatCompletionError("LLM_CONTENT_FILTERED", "Responses 返回了拒绝内容。", "refusal");
    this.progress(this.snapshot());
  }
  finish(): ProtocolProgress {
    if (!this.result) throw new ChatCompletionError("LLM_STREAM_INCOMPLETE", "Responses 流在 response.completed 之前结束，本次结果未采用。");
    return this.result;
  }
}

export const responsesAdapter: ChatProtocolAdapter = {
  buildRequest,
  decodeResponse,
  async readStream(response, onProgress, onText) {
    const stream = new ResponseStream(onProgress);
    try {
      const fallback = await readProtocolStream(response, event => {
        if (event.data.trim() === "[DONE]") return; // Only response.completed, never this marker, proves completion.
        let value: unknown;
        try { value = JSON.parse(event.data); } catch { invalid("流式事件包含无效 JSON。"); }
        stream.event(value, event.event);
      }, onText);
      if (fallback !== undefined) {
        const result = decodeResponse(fallback); onProgress(structuredClone(result)); return result;
      }
      return stream.finish();
    } catch (error) {
      throw withUsage(error, error instanceof ChatCompletionError && error.usage || stream.latestUsage);
    }
  },
};
