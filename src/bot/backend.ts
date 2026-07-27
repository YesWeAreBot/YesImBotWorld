import type { BotModelConfig } from "../config.js";
import { ChatClient } from "../llm/chat.js";
import { buildToolCallGrammar } from "../llm/grammar.js";
import { extractToolCall } from "../llm/parse.js";
import { TextClient } from "../llm/text.js";
import type { ParsedToolCall } from "../types.js";
import type { BotContext } from "./context.js";
import { BOT_TOOL_NAMES } from "./tools.js";

/** Bot-LLM 后端：给定当前上下文，生成下一个工具调用 */
export interface BotBackend {
  generate(context: BotContext, timeLine: string, signal?: AbortSignal): Promise<ParsedToolCall>;
  /** 可选：压缩后预热 KV cache（rest 期间"计算 KVcache"） */
  warmup?(context: BotContext, timeLine: string): Promise<void>;
  /** 更新允许的工具名集（App 打开/关闭时动态调整；text 模式会重建 GBNF 语法） */
  setToolNames(names: string[]): void;
}

/**
 * chat_completion 模式：把上下文映射为 messages，请求一次拿到一个工具调用，
 * 追加进上下文后立即可以发起下一次请求（由 agent 主循环驱动）。
 */
export class ChatBackend implements BotBackend {
  private client: ChatClient;
  private toolNames: string[];

  constructor(cfg: BotModelConfig, toolNames: string[] = BOT_TOOL_NAMES) {
    this.toolNames = toolNames;
    this.client = new ChatClient({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      disableThinking: cfg.disableThinking,
    });
  }

  setToolNames(names: string[]): void {
    this.toolNames = names;
  }

  async generate(context: BotContext, timeLine: string, signal?: AbortSignal): Promise<ParsedToolCall> {
    const messages = await context.toChatMessages(timeLine);
    const result = await this.client.complete(messages, { signal });
    // 兼容意外走了原生 tool_calls 的模型
    const native = result.toolCalls[0];
    if (native) {
      return extractToolCall(
        JSON.stringify({
          name: native.function.name,
          arguments: safeParse(native.function.arguments),
        }),
        this.toolNames,
      );
    }
    return extractToolCall(result.content, this.toolNames);
  }
}

/**
 * text_completion 模式（llama.cpp）：单一连续 prompt + GBNF 语法约束。
 * 语法保证输出恰好是一个合法工具调用；EOS 在语法完成前被屏蔽。
 */
export class TextBackend implements BotBackend {
  private client: TextClient;
  private grammar: string;
  private toolNames: string[];

  constructor(
    private cfg: BotModelConfig,
    toolNames: string[] = BOT_TOOL_NAMES,
  ) {
    this.toolNames = toolNames;
    this.client = new TextClient({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model || undefined,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
    });
    this.grammar = buildToolCallGrammar(toolNames);
  }

  setToolNames(names: string[]): void {
    this.toolNames = names;
    // 语法是逐请求发送的采样约束，重建不影响 KV cache
    this.grammar = buildToolCallGrammar(names);
  }

  async generate(context: BotContext, timeLine: string, signal?: AbortSignal): Promise<ParsedToolCall> {
    const prompt = context.toTextPrompt(this.cfg.template, timeLine);
    const content = await this.client.complete(prompt, { grammar: this.grammar, signal });
    return extractToolCall(content, this.toolNames);
  }

  /** n_predict=0 的请求只做 prompt 评估，用于压缩后重建 llama.cpp 的 KV cache */
  async warmup(context: BotContext, timeLine: string): Promise<void> {
    const prompt = context.toTextPrompt(this.cfg.template, timeLine);
    await this.client.complete(prompt, { nPredict: 0 });
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function createBackend(cfg: BotModelConfig, toolNames?: string[]): BotBackend {
  return cfg.mode === "text" ? new TextBackend(cfg, toolNames) : new ChatBackend(cfg, toolNames);
}
