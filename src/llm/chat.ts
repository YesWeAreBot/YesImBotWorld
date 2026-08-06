/** 极简 OpenAI 兼容 chat completion 客户端（fetch 实现，零依赖） */

import { llmFetch, forEachStreamLine, type LlmResponse } from "./http.js";
import { debug } from "../webui/debug.js";

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

export interface ChatCompleteOptions {
  tools?: ChatToolDef[];
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
    if (opts.tools?.length) body.tools = opts.tools;
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

    const startedAt = Date.now();
    const input = {
      url,
      model: this.cfg.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: summarizeContent(m.content, 3000),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      })),
      ...(opts.tools?.length ? { tools: opts.tools.length } : {}),
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens ?? 2048,
      stream,
    };
    const label = this.cfg.label ?? "LLM";
    debug.emit("llm.req", `${label}·请求发送`, input);

    const res = await llmFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? null,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      debug.emit("llm.req", `${label}·请求失败(${res.status})`, { ...input, ms: Date.now() - startedAt }, "error");
      throw new Error(`chat completion 请求失败 (${res.status}): ${text.slice(0, 500)}`);
    }

    // 非流式：一次性 JSON 响应
    if (!stream) {
      const data = (await res.json()) as ChatRawResponse;
      const message = data.choices?.[0]?.message;
      if (!message) {
        debug.emit("llm.req", `${label}·无响应`, { ...input, ms: Date.now() - startedAt }, "error");
        throw new Error("chat completion 响应缺少 choices[0].message");
      }
      const ms = Date.now() - startedAt;
      debug.emit(
        "llm.res",
        `${label}·${ms}ms${message.tool_calls?.length ? "·工具调用" : "·正文"}`,
        {
          url,
          model: this.cfg.model,
          ms,
          content: (message.content ?? "").slice(0, 4000),
          tool_calls: message.tool_calls?.map((tc) => ({
            name: tc.function.name,
            arguments: tc.function.arguments,
          })),
        },
      );
      return { content: message.content ?? "", toolCalls: message.tool_calls ?? [] };
    }

    // 流式：边生成边把增量写进同一条 llm.res 记录（前端单条动态刷新），完成时原地收尾
    let streamId: number | null = null;
    let content = "";
    let toolCalls: RawToolCall[] = [];
    try {
      const result = await readChatCompletionStream(res, (progress) => {
        const labelNow = `${label}·流式 ${Date.now() - startedAt}ms`;
        const detail = {
          url,
          model: this.cfg.model,
          ms: Date.now() - startedAt,
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
        if (streamId == null) streamId = debug.emit("llm.res", labelNow, detail);
        else debug.update(streamId, { label: labelNow, detail });
      });
      content = result.content;
      toolCalls = result.toolCalls;
    } catch (err) {
      debug.emit("llm.req", `${label}·流式中断`, { ...input, ms: Date.now() - startedAt }, "error");
      throw err;
    }
    const ms = Date.now() - startedAt;
    const finalLabel = `${label}·${ms}ms${toolCalls.length ? "·工具调用" : "·正文"}`;
    const finalDetail = {
      url,
      model: this.cfg.model,
      ms,
      content: content.slice(0, 4000),
      tool_calls: toolCalls.map((tc) => ({ name: tc.function.name, arguments: tc.function.arguments })),
    };
    if (streamId != null) debug.update(streamId, { label: finalLabel, detail: finalDetail });
    else debug.emit("llm.res", finalLabel, finalDetail);
    return { content, toolCalls };
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
}

/**
 * 读取 OpenAI SSE 流并增量累加 content / tool_calls；
 * 每 ~500ms 有新增内容时回调一次 onProgress（供 WebUI 实时流式展示）。
 * 兼容后端忽略 stream 直接返回整段 JSON 的情况。
 */
async function readChatCompletionStream(
  res: LlmResponse,
  onProgress: (p: ChatProgress) => void,
): Promise<ChatProgress> {
  const slots: Array<StreamedToolCall | undefined> = [];
  let content = "";
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
  });

  await forEachStreamLine(res, (line) => {
    allLines += line + "\n";
    if (!line.startsWith("data:")) return;
    sawData = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk: { choices?: { delta?: ChatStreamDelta }[] };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      return;
    }
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
  });
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
}

function summarizeContent(content: string | ContentPart[], max: number): unknown {
  if (typeof content === "string") {
    return content.length > max ? content.slice(0, max) + "…（已截断）" : content;
  }
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text.length > max ? part.text.slice(0, max) + "…" : part.text }
      : { type: part.type },
  );
}
