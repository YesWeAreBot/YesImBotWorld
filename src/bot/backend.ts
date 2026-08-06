import type { BotModelConfig } from "../config.js";
import { ChatClient, type ChatResult, type ChatToolDef } from "../llm/chat.js";
import { buildToolCallGrammar } from "../llm/grammar.js";
import { withEndpointLock } from "../llm/lock.js";
import { extractToolCall, ToolCallParseError, validateToolCall } from "../llm/parse.js";
import { TextClient } from "../llm/text.js";
import type { ParsedToolCall } from "../types.js";
import type { BotContext } from "./context.js";
import { toNativeToolDefs, type NamedToolDef } from "./nativeTools.js";
import { BOT_TOOL_NAMES } from "./tools.js";

/** Bot-LLM 后端：给定当前上下文，生成下一个工具调用 */
export interface BotBackend {
  generate(context: BotContext, timeLine: string, signal?: AbortSignal): Promise<ParsedToolCall>;
  /** 可选：压缩后预热 KV cache（rest 期间"计算 KVcache"） */
  warmup?(context: BotContext, timeLine: string): Promise<void>;
  /** 更新允许的工具名集（App 打开/关闭时动态调整；text 模式会重建 GBNF 语法） */
  setToolNames(names: string[]): void;
  /** 可选：更新当前可用工具的完整定义（原生 tools 声明需要签名与描述） */
  setToolDefs?(defs: NamedToolDef[]): void;
}

/**
 * chat_completion 模式：把上下文映射为 messages，请求一次拿到一个工具调用，
 * 追加进上下文后立即可以发起下一次请求（由 agent 主循环驱动）。
 */
export class ChatBackend implements BotBackend {
  private client: ChatClient;
  private toolNames: string[];
  private toolDefs: NamedToolDef[];
  private nativeDefs: ChatToolDef[] | null = null;
  private maxTokens: number;
  private baseURL: string;
  private useNativeTools: boolean;

  constructor(cfg: BotModelConfig, toolNames: string[] = BOT_TOOL_NAMES, toolDefs: NamedToolDef[] = []) {
    this.toolNames = toolNames;
    this.toolDefs = toolDefs;
    this.maxTokens = cfg.maxTokens;
    this.baseURL = cfg.baseURL;
    this.useNativeTools = cfg.nativeToolCalls;
    this.client = new ChatClient({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      disableThinking: cfg.disableThinking,
      stream: cfg.stream,
      label: "Bot",
    });
  }

  setToolNames(names: string[]): void {
    this.toolNames = names;
  }

  setToolDefs(defs: NamedToolDef[]): void {
    this.toolDefs = defs;
    this.nativeDefs = null;
  }

  /**
   * 原生声明（按 setToolDefs 惰性重建）：声明**全量**工具集，不随允许集（分层解锁）变化——
   * 请求前缀保持稳定，分层照旧由事件通知、由解析侧的允许集把关。
   */
  private currentNativeDefs(): ChatToolDef[] {
    if (!this.nativeDefs) {
      this.nativeDefs = toNativeToolDefs(this.toolDefs);
    }
    return this.nativeDefs;
  }

  async generate(context: BotContext, timeLine: string, signal?: AbortSignal): Promise<ParsedToolCall> {
    const messages = await context.toChatMessages(timeLine);
    const tools = this.useNativeTools ? this.currentNativeDefs() : undefined;
    // 端点锁：与 World-LLM 共用同一换载端点时排队执行（不同源时无影响）
    return withEndpointLock(
      this.baseURL,
      async () => {
        const result = await this.client.complete(messages, { signal, tools });
        try {
          return this.parseResult(result);
        } catch (err) {
          if (err instanceof ToolCallParseError && isLikelyTruncated(err)) {
            const retry = await this.client.complete(messages, {
              signal,
              tools,
              maxTokens: Math.max(this.maxTokens, 4096),
            });
            return this.parseResult(retry);
          }
          throw err;
        }
      },
      signal,
    );
  }

  private parseResult(result: ChatResult): ParsedToolCall {
    // 原生 tool_calls（开启原生声明时的正路；未开启时兼容意外走了原生的模型）
    const native = result.toolCalls[0];
    if (native) {
      const name = native.function.name;
      // 声明是全量的，允许集是分层的：调用了"已声明但尚未解锁"的工具时给出准确指引
      if (!this.toolNames.includes(name) && this.toolDefs.some((d) => d.name === name)) {
        throw new ToolCallParseError(
          `工具 ${name} 此刻不可用——它需要先进入相应的页面或打开相应的应用（先打开聊天应用/进入频道/打开 App，参考此前的解锁提示）`,
        );
      }
      const args = safeParse(native.function.arguments);
      // duration 是本协议的通用顶层字段；原生声明里它以参数形式出现，解析时提升回顶层
      let duration: unknown;
      if (typeof args === "object" && args !== null && "duration" in args) {
        duration = (args as Record<string, unknown>).duration;
        delete (args as Record<string, unknown>).duration;
      }
      return validateToolCall({ name, arguments: args, duration }, this.toolNames);
    }
    // 正文 JSON（文本协议的正路；原生模式下也保留兜底——模型偶尔仍会以正文回答）
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
      stream: cfg.stream,
      label: "Bot",
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
    // 端点锁：与 World-LLM 共用同一换载端点时排队执行（不同源时无影响）
    return withEndpointLock(
      this.cfg.baseURL,
      async () => {
        const content = await this.client.complete(prompt, { grammar: this.grammar, signal });
        try {
          return extractToolCall(content, this.toolNames);
        } catch (err) {
          if (err instanceof ToolCallParseError && isLikelyTruncated(err)) {
            const retry = await this.client.complete(prompt, {
              grammar: this.grammar,
              signal,
              nPredict: Math.max(this.cfg.maxTokens, 4096),
            });
            return extractToolCall(retry, this.toolNames);
          }
          throw err;
        }
      },
      signal,
    );
  }

  /** n_predict=0 的请求只做 prompt 评估，用于压缩后重建 llama.cpp 的 KV cache */
  async warmup(context: BotContext, timeLine: string): Promise<void> {
    const prompt = context.toTextPrompt(this.cfg.template, timeLine);
    await withEndpointLock(this.cfg.baseURL, () => this.client.complete(prompt, { nPredict: 0 }));
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isLikelyTruncated(err: ToolCallParseError): boolean {
  if (err.message.includes("未闭合")) return true;
  const text = (err.raw ?? "").replace(/^\uFEFF/, "").trim();
  return err.message.includes("找不到 JSON") && text.startsWith("{");
}

export function createBackend(
  cfg: BotModelConfig,
  toolNames?: string[],
  toolDefs?: NamedToolDef[],
): BotBackend {
  return cfg.mode === "text" ? new TextBackend(cfg, toolNames) : new ChatBackend(cfg, toolNames, toolDefs);
}
