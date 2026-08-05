/** 极简 OpenAI 兼容 chat completion 客户端（fetch 实现，零依赖） */

import { llmFetch } from "./http.js";

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
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens ?? 2048,
    };
    if (opts.tools?.length) body.tools = opts.tools;
    if (this.cfg.disableThinking) {
      // 覆盖主流后端的"关闭思考"写法：
      // - enable_thinking: false —— DashScope / SGLang / Ollama(OpenAI 兼容) 等
      // - chat_template_kwargs.enable_thinking —— vLLM / llama.cpp server
      // 不支持的后端一般会忽略未知字段；本开关默认关闭，不影响现有部署
      body.enable_thinking = false;
      body.chat_template_kwargs = { enable_thinking: false };
    }

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
      throw new Error(`chat completion 请求失败 (${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: RawToolCall[] } }[];
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("chat completion 响应缺少 choices[0].message");
    return {
      content: message.content ?? "",
      toolCalls: message.tool_calls ?? [],
    };
  }
}
