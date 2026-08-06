import type { Logger } from "koishi";
import { type CalendarSpec, describeCalendar, gregorian, parseCalendarSpec } from "../calendar.js";
import type { WorldClock } from "../clock.js";
import type { WorldModelConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import { ChatClient, type ChatMessage, type ChatToolDef } from "../llm/chat.js";
import { withEndpointLock } from "../llm/lock.js";
import { fill, type Prompts } from "../prompts.js";
import type { CompressionResult, ToolCallRecord } from "../types.js";
import { debug } from "../webui/debug.js";

const WORLD_TOOLS: ChatToolDef[] = [
  {
    type: "function",
    function: {
      name: "check",
      description: "读取状态文件。bot_status = Bot 状态；world_status = 世界状态；news = 最近的世界事件列表",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["bot_status", "world_status", "news"] },
          n: { type: "integer", description: "target 为 news 时读取最近多少条，默认 10" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update",
      description:
        "更新状态。bot_status / world_status 会用 content 整体覆盖对应 md 文件；news 则把 content 作为一条新事件追加到事件列表（自动附带当前世界时刻）",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["bot_status", "world_status", "news"] },
          content: { type: "string" },
        },
        required: ["target", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_time",
      description: "查询 World Clock 的当前时刻",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_event",
      description:
        "向 Bot 的意识流中追加一个事件。这是 Bot 唯一能感知到你的方式。用第三人称、符合世界观的口吻客观叙述发生了什么、" +
        "什么被怎么样了（例如「咖啡泡好了，香气从厨房飘出」「门口传来敲门声」），不要用「你…」开头的第二人称。" +
        "严禁虚构手机聊天平台内的内容（收到消息、好友申请、通知等），那些只能由平台系统自己产生",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  },
];

export interface WorldInvocation {
  /** 任务描述（user 消息） */
  task: string;
  /** send_event 的交付目标；未提供时 send_event 不可用 */
  deliver?: (content: string) => void;
}

/**
 * World-LLM：无持续上下文的世界模拟 Agent。
 *
 * 每次被调用（响应 Bot 的工具调用 / Tingle / 初始化 / 定义变更）时，
 * 通过工具调用读取相关信息，生成合理的 Event，并维护
 * World_Status.md 与 News.db。所有调用串行化以避免文件写冲突。
 */
export class WorldAgent {
  private client: ChatClient;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** 排队中（含执行中）的调用数，用于观测积压 */
  get queueLength(): number {
    return this.pending;
  }

  constructor(
    private cfg: WorldModelConfig,
    private files: WorldFiles,
    private clock: WorldClock,
    private logger: Logger,
    private prompts: Prompts,
  ) {
    this.client = new ChatClient({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      disableThinking: cfg.disableThinking,
      stream: cfg.stream,
      label: "World",
    });
  }

  /**
   * 串行化执行，避免并发写状态文件。
   * 同时以"整个任务"为粒度持有推理端点锁：当 World-LLM 与 Bot-LLM 共用一个
   * 只能驻留单模型的端点（llama-swap 等换载层）时，任务期间 Bot 的生成请求
   * 排队等待，避免跨模型并发把请求饿死或把推理进程搞崩；不同源时无影响。
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const wrapped = () =>
      withEndpointLock(this.cfg.baseURL, fn).finally(() => this.pending--);
    const next = this.tail.then(wrapped, wrapped);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ---------- 对外任务 ----------

  /** 裁定 Bot 的 act 动作。产出的事件通过 deliver 交付（由调度器压到期望完成时刻） */
  async adjudicateAct(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean> {
    const desc = String(call.arguments.description ?? call.arguments.str ?? JSON.stringify(call.arguments));
    const task = fill(this.prompts.world.adjudicateAct, {
      desc,
      issuedAt: this.clock.timeLine(call.issuedAt),
      duration: call.duration ?? 0,
      expectedAt: this.clock.timeLine(call.expectedAt),
    });
    return this.invokeWithTools({ task, deliver });
  }

  /** wait 补叙：等待即将结束（由计时器准时唤醒），提前生成期间发生的事 */
  async resolveWait(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean> {
    const n = Number(call.arguments.n ?? call.duration ?? 0);
    const task = fill(this.prompts.world.resolveWait, {
      issuedAt: this.clock.timeLine(call.issuedAt),
      n,
      expectedAt: this.clock.timeLine(call.expectedAt),
    });
    return this.invokeWithTools({ task, deliver });
  }

  /** Bot 主动查看时间：由世界裁定它此刻能否得知时间（允许失败） */
  async resolveCheckTime(deliver: (content: string) => void): Promise<boolean> {
    const task = fill(this.prompts.world.resolveCheckTime, { timeLine: this.clock.timeLine() });
    return this.invokeWithTools({ task, deliver });
  }

  /** Tingle：世界心跳，推进世界演化 */
  async tingle(deliver: (content: string) => void): Promise<void> {
    const task = fill(this.prompts.world.tingle, { timeLine: this.clock.timeLine() });
    await this.invokeWithTools({ task, deliver });
  }

  /** 插件离线期间世界时间照常流逝：补叙这段时间世界发生了什么，并告知刚恢复意识的 Bot */
  async resolveOfflineGap(fromTU: number, deliver: (content: string) => void): Promise<boolean> {
    const gapTU = this.clock.now() - fromTU;
    const task = fill(this.prompts.world.resolveOfflineGap, {
      fromTimeLine: this.clock.timeLine(fromTU),
      toTimeLine: this.clock.timeLine(),
      gapTU: gapTU.toFixed(1),
    });
    return this.invokeWithTools({ task, deliver });
  }

  /**
   * 世界查询：运行一次工具循环（可读写状态文件、不可 send_event），返回最终文本回答。
   * 用于天气应用等"以世界视角回答问题"的场景。
   */
  async query(task: string): Promise<string> {
    return this.enqueue(async () => {
      const content = (await this.runToolLoop({ task }))
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
        .trim();
      if (!content) throw new Error("World-LLM 没有给出文本回答");
      return content;
    });
  }

  // ---------- 创世 ----------

  /** 创世判定：这个世界是否是现实地球世界（决定天气应用查真实天气还是生成） */
  private async assessRealWorld(worldDef: string): Promise<boolean | null> {
    const system = this.prompts.world.assessRealWorldSystem;
    const user = fill(this.prompts.world.assessRealWorldUser, { worldDef });
    const result = await this.client.complete([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const parsed = extractJson(result.content) as Record<string, unknown> | null;
    return parsed && typeof parsed.real_world === "boolean" ? parsed.real_world : null;
  }

  /** 创世第一步：判定世界性质并持久化（天气应用等依赖它区分现实/虚构） */
  private async setupWorldMeta(worldDef: string): Promise<void> {
    let real: boolean | null = null;
    try {
      real = await this.assessRealWorld(worldDef);
    } catch (err) {
      this.logger.warn("世界性质判定调用失败: %s", err);
    }
    // 判定失败时回退：与现实时间同步的世界更可能是现实设定
    const realWorld = real ?? this.clock.syncRealTime;
    if (real === null) this.logger.warn("World-LLM 未能判定世界性质，按 %s 处理", realWorld ? "现实世界" : "虚构世界");
    const meta = await this.files.readMeta();
    await this.files.writeMeta({ ...meta, realWorld });
    this.logger.info("世界性质：%s", realWorld ? "现实地球世界" : "虚构世界");
  }

  /** 创世：依据世界定义与用户设定的初始时刻，生成世界的历法 */
  private async setupCalendar(worldDef: string): Promise<void> {
    let spec: CalendarSpec | null = null;
    try {
      spec = await this.generateCalendar(worldDef);
    } catch (err) {
      this.logger.warn("历法生成调用失败: %s", err);
    }
    if (!spec) {
      this.logger.warn("World-LLM 未能生成有效的历法规格，回退为现实公历");
      spec = gregorian(this.clock.configuredEpoch);
    }
    await this.clock.setCalendar(spec);
    this.logger.info("世界历法：%s；创世时刻 %s", describeCalendar(spec), this.clock.clockString(0));
  }

  private async generateCalendar(worldDef: string): Promise<CalendarSpec | null> {
    const system = this.prompts.world.generateCalendarSystem;
    const user = fill(this.prompts.world.generateCalendarUser, {
      worldDef,
      epoch: this.clock.configuredEpoch,
      unitWorldSeconds: this.clock.unitWorldSeconds,
    });
    const result = await this.client.complete([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    return parseCalendarSpec(extractJson(result.content));
  }

  /** 初始化：判定世界性质、生成历法（同步模式跳过），再根据用户定义生成状态文件 */
  async initialize(botDef: string, worldDef: string): Promise<void> {
    await this.enqueue(() => this.setupWorldMeta(worldDef));
    if (this.clock.syncRealTime) {
      this.logger.info("世界时间与现实同步，跳过历法生成；创世时刻 %s", this.clock.clockString(0));
    } else {
      await this.enqueue(() => this.setupCalendar(worldDef));
    }
    const task = fill(this.prompts.world.initialize, {
      timeLine: this.clock.timeLine(),
      botDef,
      worldDef,
    });
    const ok = await this.invokeWithTools({ task });
    if (!ok) throw new Error("World-LLM 初始化调用失败");
    if (!(await this.files.isInitialized())) {
      throw new Error("World-LLM 没有生成 Bot_Status.md / World_Status.md，请检查模型的工具调用能力");
    }
  }

  /** 用户修改了定义文件：世界据此调整状态，并告知 Bot 能感知到的变化 */
  async reconcileDefinitions(
    botDef: string,
    worldDef: string,
    deliver: (content: string) => void,
  ): Promise<void> {
    const task = fill(this.prompts.world.reconcileDefinitions, {
      timeLine: this.clock.timeLine(),
      botDef,
      worldDef,
    });
    await this.invokeWithTools({ task, deliver });
  }

  // ---------- 上下文压缩（rest 时由 World-LLM 执行） ----------

  async compress(input: {
    persona: string;
    historySummary: string;
    memoryDigest: string;
    streamText: string;
    timeLine: string;
  }): Promise<CompressionResult> {
    return this.enqueue(async () => {
      // 输入长度防护：意识流过长时只保留最近部分，防止压缩请求本身超过模型上下文窗口
      let streamText = input.streamText;
      const cap = this.cfg.compressMaxInputChars;
      if (cap > 0 && streamText.length > cap) {
        const tail = streamText.slice(-cap);
        const cut = tail.indexOf("\n");
        streamText =
          `（意识流过长，最早的约 ${streamText.length - cap} 字符已被省略，以下仅为最近部分）\n` +
          (cut >= 0 ? tail.slice(cut + 1) : tail);
        this.logger.warn(
          "压缩输入过长（%d 字符），已截断至最近 %d 字符",
          input.streamText.length,
          cap,
        );
      }
      const system = this.prompts.world.compressSystem;
      const user = fill(this.prompts.world.compressUser, {
        timeLine: input.timeLine,
        persona: input.persona,
        historySummary: input.historySummary,
        memoryDigest: input.memoryDigest,
        streamText,
      });
      const result = await this.client.complete([
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
      return parseCompression(result.content);
    });
  }

  // ---------- 工具循环 ----------

  private async invokeWithTools(invocation: WorldInvocation): Promise<boolean> {
    debug.emit("world.task", `任务·${invocation.task.slice(0, 60)}`, {
      task: invocation.task,
      deliver: !!invocation.deliver,
    });
    return this.enqueue(async () => {
      try {
        const finalContent = await this.runToolLoop(invocation);
        debug.emit("world.result", "任务完成", { finalContent: finalContent.slice(0, 2000) });
        return true;
      } catch (err) {
        debug.emit("world.task", "任务失败", String((err as Error).message ?? err), "error");
        this.logger.warn("World-LLM 调用失败: %s", err);
        return false;
      }
    });
  }

  private async systemPrompt(): Promise<string> {
    const { worldDef } = await this.files.readDefinitions();
    return fill(this.prompts.world.system, {
      worldDef,
      timeLine: this.clock.timeLine(),
    });
  }

  /** 运行工具循环，返回模型最后一轮的文本内容 */
  private async runToolLoop(invocation: WorldInvocation): Promise<string> {
    const tools = invocation.deliver
      ? WORLD_TOOLS
      : WORLD_TOOLS.filter((t) => t.function.name !== "send_event");
    const messages: ChatMessage[] = [
      { role: "system", content: await this.systemPrompt() },
      { role: "user", content: invocation.task },
    ];

    let finalContent = "";
    let lastCallSig = "";
    for (let round = 0; round < this.cfg.maxToolRounds; round++) {
      // 每轮耗时观测：非流式响应在服务端生成完毕前不会返回任何字节，
      // 失败时把"第几轮、悬挂了多久"带进错误信息——这是区分病因的关键数据
      // （悬挂 ~300s = 被 undici 响应头超时掐断；瞬间失败 = 连接层问题）
      const startedAt = Date.now();
      let result: Awaited<ReturnType<ChatClient["complete"]>>;
      try {
        result = await this.client.complete(messages, { tools });
      } catch (err) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        throw new Error(
          `第 ${round + 1} 轮请求失败（悬挂 ${elapsed}s，${messages.length} 条消息）: ${(err as Error).message ?? err}`,
          { cause: err },
        );
      }
      this.logger.debug(
        "World-LLM 第 %d 轮完成，耗时 %ss（%d 条消息）",
        round + 1,
        ((Date.now() - startedAt) / 1000).toFixed(1),
        messages.length,
      );
      finalContent = result.content ?? "";
      if (!result.toolCalls.length) break;
      messages.push({
        role: "assistant",
        content: result.content ?? "",
        tool_calls: result.toolCalls,
      });
      for (const tc of result.toolCalls) {
        // 打断本地模型常见的"同一调用反复循环"
        const sig = `${tc.function.name}:${tc.function.arguments}`;
        if (sig === lastCallSig) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "（与上一次调用完全相同，已忽略。若任务已完成请直接结束，不要再调用工具。）",
          });
          continue;
        }
        lastCallSig = sig;
        const output = await this.executeTool(
          tc.function.name,
          safeParseArgs(tc.function.arguments),
          invocation,
        );
        messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }
    }
    return finalContent;
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    invocation: WorldInvocation,
  ): Promise<string> {
    try {
      const out = await this.executeToolInner(name, args, invocation);
      debug.emit("world.tool", `${name}${summaryArgs(args)}`, { name, args, result: out.slice(0, 1000) });
      return out;
    } catch (err) {
      debug.emit("world.tool", `${name}·出错`, { name, args, error: String((err as Error).message ?? err) }, "error");
      return `工具执行出错: ${(err as Error).message ?? err}`;
    }
  }

  private async executeToolInner(
    name: string,
    args: Record<string, unknown>,
    invocation: WorldInvocation,
  ): Promise<string> {
    switch (name) {
        case "check": {
          const target = String(args.target ?? "");
          if (target === "bot_status") return (await this.files.readBotStatus()) || "（空）";
          if (target === "world_status") return (await this.files.readWorldStatus()) || "（空）";
          if (target === "news") {
            const n = Number(args.n ?? 10);
            const news = await this.files.readNews(n);
            if (!news.length) return "（暂无事件）";
            return news.map((e) => `[T=${e.t.toFixed(1)} ${e.clock}] ${e.content}`).join("\n");
          }
          return `未知 target: ${target}`;
        }
        case "update": {
          const target = String(args.target ?? "");
          const content = String(args.content ?? "");
          if (target === "bot_status") {
            await this.files.writeBotStatus(content);
            return "Bot_Status.md 已更新";
          }
          if (target === "world_status") {
            await this.files.writeWorldStatus(content);
            return "World_Status.md 已更新";
          }
          if (target === "news") {
            // 防止模型在工具循环中重复记录相同内容
            const recent = await this.files.readNews(5);
            if (recent.some((e) => e.content === content)) {
              return "这条事件与近期记录重复，未追加。";
            }
            const t = this.clock.now();
            await this.files.appendNews({ t, clock: this.clock.clockString(t), content });
            return "已追加至事件列表";
          }
          return `未知 target: ${target}`;
        }
        case "check_time":
          return this.clock.timeLine();
        case "send_event": {
          const content = String(args.content ?? "");
          if (!invocation.deliver) return "当前任务不允许 send_event";
          if (!content.trim()) return "事件内容为空，未发送";
          invocation.deliver(content);
          return "事件已送达 Bot";
        }
        default:
          return `未知工具: ${name}`;
      }
  }
}

/** 从（可能带说明文字的）LLM 输出中提取第一个 JSON 对象 */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 参数摘要（调试标签用）：长参数截断 */
function summaryArgs(args: Record<string, unknown>): string {
  const content = args.content != null ? String(args.content) : undefined;
  const target = args.target != null ? `(${args.target})` : "";
  if (content) {
    const single = content.replace(/\s+/g, " ").trim();
    return `${target} ${single.length > 30 ? single.slice(0, 30) + "…" : single}`;
  }
  return target;
}

function parseCompression(content: string): CompressionResult {
  const pick = (tag: string): string | undefined => {
    const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m?.[1]?.trim();
  };
  const historySummary = pick("HISTORY_SUMMARY");
  const memoryDigest = pick("MEMORY_DIGEST");
  const botStatusRaw = pick("BOT_STATUS");
  const botStatus =
    botStatusRaw && botStatusRaw !== "UNCHANGED" && botStatusRaw.length > 20 ? botStatusRaw : undefined;
  if (!historySummary) {
    // 容错：模型没按格式输出时，把全文当作历史摘要
    return { historySummary: content.trim().slice(0, 4000), memoryDigest: "（压缩输出格式异常，摘要缺失）" };
  }
  return { historySummary, memoryDigest: memoryDigest ?? "（无）", botStatus };
}
