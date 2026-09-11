/** 极简 OpenAI 兼容 chat completion 客户端（fetch 实现，零依赖） */

import { llmFetch, forEachStreamLine, type LlmResponse } from "./http.js";
import { debug } from "../webui/debug.js";
import { callStore } from "../webui/calls.js";
import { usageStore } from "../webui/usage.js";
import { sliceText } from "../text.js";
import { normalizeChatRequest } from "./normalize.js";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "video_url"; video_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: RawToolCall[];
  tool_call_id?: string;
}

export interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatClientConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 关闭模型的思维链（对支持开关思考模式的模型生效，如 Qwen3 系） */
  disableThinking?: boolean;
  /** 是否以流式请求（SSE）。默认 true；后端不支持 stream 时可关闭 */
  stream?: boolean;
  /** WebUI 调试流里的显示名（如 "Bot" / "World" / "解释器"） */
  label?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: RawToolCall[];
}

/** OpenAI 兼容的 usage 结构 */
export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** OpenAI 风格：输入中命中缓存的 token 数 */
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek 风格：命中/未命中缓存的输入 token 数 */
  prompt_cache_hit_tokens?: number;
  /** Anthropic 风格（经 OpenAI 兼容网关透传）：读缓存命中的输入 token 数 */
  cache_read_input_tokens?: number;
  /** 归一化后的缓存命中数（normalizeUsage 填充） */
  cached_tokens?: number;
  /** 归一化标记：上游 usage 是否上报了缓存命中信息（normalizeUsage 填充） */
  cache_reported?: boolean;
}

export interface ChatCompleteOptions {
  tools?: ChatToolDef[];
  /** Require a specific tool for callers whose result must be a validated proposal. */
  toolChoice?: { type: "function"; function: { name: string } };
  signal?: AbortSignal;
  /** 覆盖配置里的 maxTokens；用于解析失败后对“疑似截断”的 JSON 放大一次输出上限 */
  maxTokens?: number;
}

export class ChatClient {
  constructor(private cfg: ChatClientConfig) {}

  async complete(
    messages: ChatMessage[],
    opts: ChatCompleteOptions = {},
  ): Promise<ChatResult> {
    const url = this.cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";
    const stream = this.cfg.stream !== false;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens ?? 2048,
      ...(stream ? { stream: true } : {}),
    };
    if (stream) {
      // 请求在流末附上 usage（OpenAI 兼容后端普遍支持；不支持的通常忽略该字段）
      body.stream_options = { include_usage: true };
    }
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
    if (this.cfg.disableThinking) {
      // 覆盖主流后端/模型的"关闭思考"写法：
      // - enable_thinking: false —— DashScope / SGLang / Ollama(OpenAI 兼容) 等
      // - thinking: {type: "disabled"} —— DeepSeek 官方 API（OpenAI 格式的控制参数）
      // - chat_template_kwargs.enable_thinking —— vLLM / llama.cpp（Qwen3、GLM、unsloth 系模板的变量名）
      // - chat_template_kwargs.thinking —— DeepSeek V3.1+ 官方模板的变量名
      // Jinja 模板会忽略未使用的变量，不支持的后端一般会忽略未知字段；
      // 本开关默认关闭，不影响现有部署
      body.enable_thinking = false;
      body.thinking = { type: "disabled" };
      body.chat_template_kwargs = { enable_thinking: false, thinking: false };
    }

    const normalized = normalizeChatRequest(body);
    const requestMessages = normalized.body.messages as ChatMessage[];
    const startedAt = Date.now();
    const label = this.cfg.label ?? "LLM";
    const requestBody = JSON.stringify(normalized.body);
    const callId = callStore.begin({ source: label, model: this.cfg.model, url, requestBody, unicodeRepairedStrings: normalized.repairedStrings });
    const input = {
      callId,
      url,
      model: this.cfg.model,
      ...(normalized.repairedStrings ? { unicodeRepairedStrings: normalized.repairedStrings } : {}),
      messages: requestMessages.map((m) => ({
        role: m.role,
        content: summarizeContent(m.content, 3000),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      })),
      ...(opts.tools?.length ? { tools: opts.tools.length } : {}),
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens ?? 2048,
      stream,
    };
    debug.emit("llm.req", `${label}·请求发送`, input);

    try {
    const res = await llmFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: requestBody,
      signal: opts.signal ?? null,
    });
    callStore.update(callId, { httpStatus: res.status, responseFormat: res.headers.get("content-type") ?? (stream ? "text/event-stream" : "application/json") });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      callStore.append(callId, text);
      debug.emit("llm.req", `${label}·请求失败(${res.status})`, { ...input, ms: Date.now() - startedAt }, "error");
      throw new Error(`chat completion 请求失败 (${res.status}): ${text.slice(0, 500)}`);
    }

    // 非流式：一次性 JSON 响应
    if (!stream) {
      const responseBody = await res.text();
      callStore.append(callId, responseBody);
      const data = JSON.parse(responseBody) as ChatRawResponse;
      const message = data.choices?.[0]?.message;
      if (!message) {
        debug.emit("llm.req", `${label}·无响应`, { ...input, ms: Date.now() - startedAt }, "error");
        throw new Error("chat completion 响应缺少 choices[0].message");
      }
      const ms = Date.now() - startedAt;
      const usage = normalizeUsage(data.usage);
      debug.emit(
        "llm.res",
        `${label}·${ms}ms${message.tool_calls?.length ? "·工具调用" : "·正文"}${usage ? ` · ${usage.total_tokens} tok` : ""}`,
        {
          callId,
          url,
          model: this.cfg.model,
          ms,
          usage,
          content: (message.content ?? "").slice(0, 4000),
          tool_calls: message.tool_calls?.map((tc) => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
        },
      );
      this.recordUsage(usage);
      callStore.update(callId, { status: "completed", usage, preview: message.content || JSON.stringify(message.tool_calls ?? []) });
      return { content: message.content ?? "", toolCalls: message.tool_calls ?? [] };
    }

    // 流式：边生成边把增量写进同一条 llm.res 记录（前端单条动态刷新），完成时原地收尾
    let streamId: number | null = null;
    let content = "";
    let toolCalls: RawToolCall[] = [];
    let usage: ChatUsage | null = null;
    try {
      const result = await readChatCompletionStream(res, (progress) => {
        const labelNow = `${label}·流式 ${Date.now() - startedAt}ms`;
        const detail = {
          callId,
          url,
          model: this.cfg.model,
          ms: Date.now() - startedAt,
          usage: progress.usage,
          content: progress.content.slice(-6000),
          ...(progress.toolCalls.length
            ? {
                tool_calls: progress.toolCalls.map((tc) => ({
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                })),
              }
            : {}),
        };
        callStore.update(callId, { status: "streaming", usage: progress.usage, preview: progress.content || JSON.stringify(progress.toolCalls) });
        if (streamId == null) streamId = debug.emit("llm.res", labelNow, detail);
        else debug.update(streamId, { label: labelNow, detail });
      }, (text) => callStore.append(callId, text));
      content = result.content;
      toolCalls = result.toolCalls;
      usage = result.usage;
    } catch (err) {
      debug.emit("llm.req", `${label}·流式中断`, { ...input, ms: Date.now() - startedAt }, "error");
      throw err;
    }
    const ms = Date.now() - startedAt;
    this.recordUsage(usage);
    const finalUsage = normalizeUsage(usage);
    const finalLabel = `${label}·${ms}ms${toolCalls.length ? "·工具调用" : "·正文"}${finalUsage ? ` · ${finalUsage.total_tokens} tok` : ""}`;
    const finalDetail = {
      callId,
      url,
      model: this.cfg.model,
      ms,
      usage: finalUsage,
      content: content.slice(0, 4000),
      tool_calls: toolCalls.map((tc) => ({ name: tc.function.name, arguments: tc.function.arguments })),
    };
    if (streamId != null) debug.update(streamId, { label: finalLabel, detail: finalDetail });
    else debug.emit("llm.res", finalLabel, finalDetail);
    callStore.update(callId, { status: "completed", usage: finalUsage, preview: content || JSON.stringify(toolCalls) });
    return { content, toolCalls };
    } catch (error) {
      const cancelled = opts.signal?.aborted || (error instanceof Error && error.name === "AbortError");
      callStore.update(callId, { status: cancelled ? "cancelled" : "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private recordUsage(usage: ChatUsage | null): void {
    const u = normalizeUsage(usage);
    if (!u) return;
    usageStore.record({
      label: this.cfg.label ?? "LLM",
      model: this.cfg.model || "",
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0,
      cachedTokens: u.cached_tokens ?? 0,
      cacheReported: u.cache_reported === true,
    });
  }
}

interface StreamedToolCall {
  id: string;
  name: string;
  args: string;
}

interface ChatProgress {
  content: string;
  toolCalls: RawToolCall[];
  usage: ChatUsage | null;
}

/**
 * 读取 OpenAI SSE 流并增量累加 content / tool_calls；
 * 每 ~500ms 有新增内容时回调一次 onProgress（供 WebUI 实时流式展示）。
 * 兼容后端忽略 stream 直接返回整段 JSON 的情况。
 */
async function readChatCompletionStream(
  res: LlmResponse,
  onProgress: (p: ChatProgress) => void,
  onText?: (text: string) => void,
): Promise<ChatProgress> {
  const slots: Array<StreamedToolCall | undefined> = [];
  let content = "";
  let usage: ChatUsage | null = null;
  let dirty = false;
  let lastEmit = 0;
  let sawData = false;
  let allLines = "";
  const THROTTLE_MS = 500;

  const snapshot = (): ChatProgress => ({
    content,
    toolCalls: slots
      .filter((s): s is StreamedToolCall => !!s)
      .map((s) => ({
        id: s.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function" as const,
        function: { name: s.name, arguments: s.args },
      })),
    usage,
  });

  await forEachStreamLine(res, (line) => {
    allLines += line + "\n";
    if (!line.startsWith("data:")) return;
    sawData = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk: { choices?: { delta?: ChatStreamDelta }[]; usage?: ChatUsage };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      return;
    }
    // 流末 usage（OpenAI 兼容后端在 stream_options.include_usage 时于末块携带）
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      dirty = true;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let slot = slots[idx];
        if (!slot) slots[idx] = slot = { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        dirty = true;
      }
    }
    const now = Date.now();
    if (dirty && now - lastEmit >= THROTTLE_MS) {
      lastEmit = now;
      dirty = false;
      onProgress(snapshot());
    }
  }, onText);
  if (dirty) onProgress(snapshot());

  // 兼容"忽略 stream 直接返回整段 JSON"的后端
  if (!sawData && allLines.trim()) {
    let data: ChatRawResponse | null = null;
    try {
      data = JSON.parse(allLines) as ChatRawResponse;
    } catch {
      /* 非 JSON，忽略 */
    }
    if (data) {
      const message = data.choices?.[0]?.message;
      if (data.usage) usage = data.usage;
      if (message) {
        if (message.content) content += message.content;
        if (Array.isArray(message.tool_calls)) {
          message.tool_calls.forEach((tc, i) => {
            slots[i] = { id: tc.id, name: tc.function.name, args: tc.function.arguments };
          });
        }
        onProgress(snapshot());
      } else {
        throw new Error("chat completion 响应缺少 choices[0].message");
      }
    }
  }
  return snapshot();
}

interface ChatStreamDelta {
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface ChatRawResponse {
  choices?: { message?: { content?: string | null; tool_calls?: RawToolCall[] } }[];
  usage?: ChatUsage;
}

function normalizeUsage(u: ChatUsage | null | undefined): ChatUsage | null {
  if (!u) return null;
  const prompt = Number(u.prompt_tokens) || 0;
  const completion = Number(u.completion_tokens) || 0;
  const total = Number(u.total_tokens) || 0;
  if (!prompt && !completion && !total) return null;
  // 缓存命中：OpenAI 的 prompt_tokens_details.cached_tokens / DeepSeek 的 prompt_cache_hit_tokens /
  // Anthropic 经 OpenAI 网关透传的 cache_read_input_tokens（opencode 等聚合网关常用）
  const cacheField =
    u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens;
  // 是否上报了缓存命中信息：字段存在（即使为 0）才算「上报」；undefined = 未上报（如 vLLM 默认不带）
  const cacheReported =
    u.prompt_tokens_details?.cached_tokens !== undefined ||
    u.prompt_cache_hit_tokens !== undefined ||
    u.cache_read_input_tokens !== undefined;
  const cached = Number(cacheField) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
    cache_reported: cacheReported,
    ...(cached ? { cached_tokens: cached } : {}),
  };
}

/**
 * 调试视图用的消息内容摘要。
 * 注意：这只影响 WebUI 调试页的展示——实际发送给 LLM 的请求体始终是完整内容。
 */
function summarizeContent(content: string | ContentPart[], max: number): unknown {
  if (typeof content === "string") {
    return clipMiddle(content, max, max);
  }
  // 保持内容结构与顺序，只省略超长字符串的中间部分（文字 / base64），不丢弃字段、不调序
  return content.map((part) => {
    switch (part.type) {
      case "text":
        return {
          type: "text",
          text: clipMiddle(part.text, max, max),
        };
      case "image_url":
        return {
          type: "image_url",
          image_url: {
            ...part.image_url,
            url: clipField(part.image_url?.url),
          },
        };
      case "video_url":
        return {
          type: "video_url",
          video_url: {
            ...part.video_url,
            url: clipField(part.video_url?.url),
          },
        };
      case "input_audio":
        return {
          type: "input_audio",
          input_audio: {
            ...part.input_audio,
            data: clipField(part.input_audio?.data),
          },
        };
      default:
        // 未知类型：原样保留，避免丢失字段
        return part;
    }
  });
}

/** data URL / base64：只保留开头的数据类型前缀与结尾几个字符，中间大段 base64 省略（十几个可见字符即可） */
function clipField(value: string | undefined): string {
  if (value == null) return "";
  return clipMiddle(value, 30, 16);
}

/** 省略中间、保留首尾：value 若不超过 head+tail 则原样；否则 head 头 + 省略标记 + tail 尾 */
function clipMiddle(value: string, head: number, tail: number): string {
  if (value.length <= head + tail) return value;
  const omitted = value.length - head - tail;
  return sliceText(value, 0, head) + `…（中间省略 ${omitted} 字符——仅调试视图省略，实际请求已完整发送）` + sliceText(value, -tail);
}
