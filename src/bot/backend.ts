import type { BotModelConfig } from "../config.js";
import { ChatClient, type ChatResult, type ChatToolDef } from "../llm/chat.js";
import { withEndpointLock } from "../llm/lock.js";
import { extractToolCall, ToolCallParseError, validateToolCall } from "../llm/parse.js";
import type { ParsedToolCall } from "../types.js";
import type { BotContext } from "./context.js";
import { toNativeToolDefs, type NamedToolDef } from "./nativeTools.js";
import { BOT_TOOL_NAMES } from "./tools.js";

/** Bot-LLM 后端：给定当前上下文，生成下一个工具调用 */
export interface BotBackend {
  generate(context: BotContext, timeLine: string, signal?: AbortSignal): Promise<ParsedToolCall>;
  /** 更新允许的工具名集（App 打开/关闭时动态调整） */
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
    // 允许集变化：原生声明需重建——native 声明按允许集分层，模型只看到当前真正可用的工具
    // （否则全量声明会让模型在还没进频道时就"看到" send 并提前调用，被分层允许集拒绝）。
    if (this.toolNames.join(",") !== names.join(",")) {
      this.toolNames = names;
      this.nativeDefs = null;
    }
  }

  setToolDefs(defs: NamedToolDef[]): void {
    this.toolDefs = defs;
    this.nativeDefs = null;
  }

  /**
   * 原生声明（按 setToolDefs / setToolNames 惰性重建）：只声明**当前允许集**（toolNames）内的工具，
   * 随频道进出/应用开关变化——模型看不到当前不可用的工具（如未进频道时的 send），
   * 从根上杜绝"提前看到 send 却调用被拒"的矛盾。tools 声明不进 messages 前缀，分层不影响 prompt cache 命中。
   */
  private currentNativeDefs(): ChatToolDef[] {
    if (!this.nativeDefs) {
      const allowed = this.toolDefs.filter((d) => this.toolNames.includes(d.name));
      this.nativeDefs = toNativeToolDefs(allowed);
    }
    return this.nativeDefs;
  }

  async generate(context: BotContext, timeLine: string, signal?: AbortSignal): Promise<ParsedToolCall> {
    const messages = await context.toChatMessages(timeLine, this.useNativeTools);
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
    if (result.toolCalls.length > 1) throw new ToolCallParseError("每次只能调用一个工具；本次多个调用均未执行，请选择一个动作。");
    const native = result.toolCalls[0];
    if (native) {
      const name = native.function.name;
      // 声明是全量的，允许集是分层的：调用了"已声明但尚未解锁"的工具时给出准确指引
      if (!this.toolNames.includes(name) && this.toolDefs.some((d) => d.name === name)) {
        throw new ToolCallParseError(
          `工具 ${name} 此刻不可用——它需要先进入相应的页面或打开相应的应用（先打开聊天应用/进入频道/打开 App，参考此前的解锁提示）`,
        );
      }
      let args: unknown;
      try { args = JSON.parse(native.function.arguments); }
      catch { throw new ToolCallParseError("工具参数 JSON 未闭合或格式无效，本次未执行。", native.function.arguments); }
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
  return new ChatBackend(cfg, toolNames, toolDefs);
}
