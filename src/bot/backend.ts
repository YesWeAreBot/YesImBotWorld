import type { BotModelConfig } from "../config.js";
import { ChatClient, type ChatMessage, type ChatResult, type ChatToolDef } from "../llm/chat.js";
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
  /** Known operations whose interface prerequisites can be executed before dispatch. */
  setNavigableToolNames?(names: string[]): void;
  /** 可选：更新当前可用工具的完整定义（原生 tools 声明需要签名与描述） */
  setToolDefs?(defs: NamedToolDef[]): void;
  /** Refresh the provider's fixed tool declarations only at a successful context compression boundary. */
  resetToolSnapshot?(): void;
}

/**
 * chat_completion 模式：把上下文映射为 messages，请求一次拿到一个工具调用，
 * 追加进上下文后立即可以发起下一次请求（由 agent 主循环驱动）。
 */
export class ChatBackend implements BotBackend {
  private client: ChatClient;
  private toolNames: string[];
  private toolDefs: NamedToolDef[];
  private knownToolNames = new Set<string>();
  private navigableToolNames = new Set<string>();
  private nativeDefs: ChatToolDef[] | null = null;
  private nativeWindow: { context: BotContext; revision: number } | null = null;
  private maxTokens: number;
  private baseURL: string;
  private useNativeTools: boolean;
  private requireInitialCue: boolean;

  constructor(cfg: BotModelConfig, toolNames: string[] = BOT_TOOL_NAMES, toolDefs: NamedToolDef[] = []) {
    this.toolNames = [...toolNames];
    this.toolDefs = structuredClone(toolDefs);
    for (const name of [...toolNames, ...toolDefs.map(def => def.name)]) this.knownToolNames.add(name);
    // Parse a retained historical declaration only to report its replacement; never execute it.
    this.knownToolNames.add("observe");
    this.maxTokens = cfg.maxTokens;
    this.baseURL = cfg.baseURL;
    this.useNativeTools = cfg.nativeToolCalls;
    this.requireInitialCue = cfg.apiType === "anthropic";
    this.client = new ChatClient({
      apiType: cfg.apiType,
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
    this.toolNames = [...names];
    for (const name of names) this.knownToolNames.add(name);
  }

  setNavigableToolNames(names: string[]): void {
    this.navigableToolNames = new Set(names);
    for (const name of names) this.knownToolNames.add(name);
  }

  setToolDefs(defs: NamedToolDef[]): void {
    this.toolDefs = structuredClone(defs);
    for (const def of defs) this.knownToolNames.add(def.name);
  }

  resetToolSnapshot(): void { this.nativeDefs = null; }

  /**
   * Provider templates commonly place native tools before messages. Freeze this declaration for the
   * entire working window; availability changes arrive as appended events and are enforced by the
   * latest toolNames. Newly available tools can use the body JSON protocol until the next snapshot.
   */
  private currentNativeDefs(context: BotContext, revision: number): ChatToolDef[] {
    if (this.nativeWindow?.context !== context || this.nativeWindow.revision !== revision) {
      this.nativeDefs = null;
      this.nativeWindow = { context, revision };
    }
    if (!this.nativeDefs) {
      const allowed = this.toolDefs.filter((d) => this.toolNames.includes(d.name));
      this.nativeDefs = toNativeToolDefs(allowed);
    }
    return this.nativeDefs;
  }

  async generate(context: BotContext, timeLine: string, signal?: AbortSignal): Promise<ParsedToolCall> {
    let messages: ChatMessage[], tools: ChatToolDef[] | undefined;
    for (;;) {
      await context.ensureGenerationCue(this.requireInitialCue);
      const revision = context.windowRevision;
      const nativeToolCalls = context.generationUsesNativeTools(this.useNativeTools);
      tools = nativeToolCalls ? await context.nativeToolSnapshot(timeLine, this.currentNativeDefs(context, revision)) : undefined;
      for (const tool of tools ?? []) this.knownToolNames.add(tool.function.name);
      messages = await context.toChatMessages(timeLine, nativeToolCalls);
      // Media loading can yield while compression finishes. Never pair old messages with the
      // declarations of a new window, or send while a failed cutover still needs recovery.
      await context.settled();
      if (context.windowRevision === revision) break;
    }
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
      let args: unknown;
      try { args = JSON.parse(native.function.arguments); }
      catch { throw new ToolCallParseError("工具参数 JSON 未闭合或格式无效，本次未执行。", native.function.arguments); }
      // The shared validator normalizes native and body-JSON duration identically.
      const parsed = validateToolCall({ name, arguments: args }, [name]);
      this.assertAvailable(name, parsed);
      return parsed;
    }
    // Parse known-but-inactive names too so both protocols report the same truthful availability
    // error. Do not present the historical catalogue as currently usable in an unknown-name error.
    let parsed: ParsedToolCall;
    try { parsed = extractToolCall(result.content, [...this.knownToolNames]); }
    catch (error) {
      if (error instanceof ToolCallParseError && error.message.startsWith("未知工具 ")) {
        throw new ToolCallParseError(error.message.replace(/，可用工具:[\s\S]*$/, "。本次没有执行操作；请以最近的能力变化事件和当前工具说明为准。"), error.raw, error.parsedCall);
      }
      throw error;
    }
    this.assertAvailable(parsed.name, parsed);
    return parsed;
  }

  private assertAvailable(name: string, parsed: ParsedToolCall): void {
    if (name === "observe") throw new ToolCallParseError("工具 observe 此刻不可用，主动观察已合并到 act(description)，日常感知与行动结果自动送达。本次没有执行操作；请依据最新能力说明表达具体意图。", undefined, parsed);
    if (this.toolNames.includes(name) || this.navigableToolNames.has(name)) return;
    const description = this.knownToolNames.has(name) ? `工具 ${name} 此刻不可用` : `未知工具 ${JSON.stringify(name)}`;
    throw new ToolCallParseError(`${description}。本次没有执行操作；请以最近的能力变化事件和当前工具说明为准，不要因旧声明仍存在就重复调用。`, undefined, parsed);
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
