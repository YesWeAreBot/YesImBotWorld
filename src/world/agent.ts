import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { WorldModelConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import { ChatClient, type ChatMessage, type ChatToolDef } from "../llm/chat.js";
import type { CompressionResult, ToolCallRecord } from "../types.js";

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
  ) {
    this.client = new ChatClient({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      disableThinking: cfg.disableThinking,
    });
  }

  /** 串行化执行，避免并发写状态文件 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const wrapped = () => fn().finally(() => this.pending--);
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
    const task =
      `Bot 刚刚开始执行一个动作：「${desc}」（开始于 ${this.clock.timeLine(call.issuedAt)}，` +
      `预计耗时 ${call.duration ?? 0} TU，完成于 ${this.clock.timeLine(call.expectedAt)}）。\n` +
      `请裁定这个动作的结果：\n` +
      `1. 按需 check 世界/Bot 状态，保证裁定与现状一致；\n` +
      `2. 必须调用一次 send_event，以第三人称客观叙述动作完成时的结果——聚焦什么发生了变化、` +
      `什么被怎么样了（允许失败、意外或有趣的转折）；\n` +
      `3. 动作若改变了 Bot 自身——位置、姿态、状态、心情、正在做的事、随身物品——` +
      `**必须** update bot_status 使其与裁定后的现实一致（这一步经常被遗漏，请自查）；` +
      `若改变了周遭世界，update world_status；\n` +
      `4. News 是大事记不是流水账：只有足够重要、之后可能被提起或产生影响的结果才 update news 记一条，` +
      `日常小动作不要记录。`;
    return this.invokeWithTools({ task, deliver });
  }

  /** wait 到期：World-LLM 认为等待时间已到，生成期间发生的事并唤醒 Bot */
  async resolveWait(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean> {
    const n = Number(call.arguments.n ?? call.duration ?? 0);
    const task =
      `Bot 从 ${this.clock.timeLine(call.issuedAt)} 开始等待了 ${n} 个 TU，现在等待结束` +
      `（当前 ${this.clock.timeLine()}）。\n` +
      `请先 check news 和 world_status 了解期间世界的变化，然后必须调用一次 send_event 告诉 Bot：` +
      `等待结束了，以及这段时间里发生的、它能感知到的变化——用第三人称客观叙述什么发生了变化、` +
      `什么被怎么样了（如果无事发生，就平实地叙述周遭环境此刻的样子）。`;
    return this.invokeWithTools({ task, deliver });
  }

  /** Bot 主动查看时间：由世界裁定它此刻能否得知时间（允许失败） */
  async resolveCheckTime(deliver: (content: string) => void): Promise<boolean> {
    const task =
      `Bot 想知道现在几点了（看手表、掏出手机、或寻找附近的时钟）。当前实际时刻：${this.clock.timeLine()}。\n` +
      `请根据 bot_status / world_status（按需 check）裁定它此刻能否得知时间：\n` +
      `- 能：send_event 以第三人称叙述它如何得知（如「手机屏幕亮起，显示 08:42」「墙上的挂钟指向下午三点」），` +
      `事件内容必须包含具体的时间；\n` +
      `- 不能（例如身处荒野、没有任何计时工具、手表停了）：send_event 叙述它找不到时间来源，不要透露时间。`;
    return this.invokeWithTools({ task, deliver });
  }

  /** Tingle：世界心跳，推进世界演化 */
  async tingle(deliver: (content: string) => void): Promise<void> {
    const task =
      `世界心跳（Tingle）触发，当前 ${this.clock.timeLine()}。\n` +
      `请推进世界的自然演化：\n` +
      `1. check world_status 与最近 news，保持连贯；\n` +
      `2. 构思一件此刻世界中正在发生的事（大小皆可：天气变化、路人经过、新闻播报、突发事件……），` +
      `把由此产生的状态变化 update 到 world_status；\n` +
      `3. News 是世界的大事记，不是心跳流水账：只有足够重要、之后可能被提起或产生影响的事` +
      `才 update news 记一条——**大多数心跳不需要写 News**，日常背景动静（天气微变、路人走过）绝不要记录；\n` +
      `4. 仅当这件事会被 Bot 直接感知到（发生在它身边、有巨大动静等）时，才 send_event 告诉它，否则不要打扰。`;
    await this.invokeWithTools({ task, deliver });
  }

  /** 初始化：根据用户定义生成 Bot_Status.md 与 World_Status.md */
  async initialize(botDef: string, worldDef: string): Promise<void> {
    const task =
      `这是世界的创世时刻（${this.clock.timeLine()}）。用户给出了以下定义：\n\n` +
      `<bot_definition>\n${botDef}\n</bot_definition>\n\n` +
      `<world_definition>\n${worldDef}\n</world_definition>\n\n` +
      `请完成初始化：\n` +
      `1. 调用 update(bot_status)：写出 Bot 的初始状态文件。以定义为准扩写成完整的角色状态，` +
      `包含：角色设定（性格、说话风格、背景）、当前位置、当前状态（精神、心情）、正在做的事。这份文件会作为 Bot 的自我认知置顶注入；\n` +
      `2. 调用 update(world_status)：写出世界的初始状态文件，包含：世界观要点、当前时间与环境、` +
      `主要地点与人物的当前状态、正在发生的背景事件；\n` +
      `3. 可选：用 update(news) 记录一两条开场事件。`;
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
    const task =
      `用户（世界的创造者）刚刚修改了世界与 Bot 的定义（当前 ${this.clock.timeLine()}）。最新定义如下：\n\n` +
      `<bot_definition>\n${botDef}\n</bot_definition>\n\n` +
      `<world_definition>\n${worldDef}\n</world_definition>\n\n` +
      `请 check 当前的 bot_status 与 world_status，把与新定义冲突的部分更新过来（update），` +
      `并用 update news 记录这次变化。若变化是 Bot 能感知到的，用 send_event 以符合世界观的方式告诉它` +
      `（比如以某个世界内事件为幌子，而不是说"设定被修改了"）。`;
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
      const system =
        "你是一个虚拟角色的记忆整理器。角色刚进入休息状态，你需要把它近期的意识流（工具调用与事件）" +
        "压缩沉淀为长期记忆。输出必须严格使用给定的 XML 标签格式，不要输出其他内容。";
      const user =
        `当前时刻：${input.timeLine}\n\n` +
        `<persona>（角色的自我认知文件 Bot_Status.md 当前内容）\n${input.persona}\n</persona>\n\n` +
        `<old_history_summary>\n${input.historySummary}\n</old_history_summary>\n\n` +
        `<old_memory_digest>\n${input.memoryDigest}\n</old_memory_digest>\n\n` +
        `<recent_stream>（本次要压缩的意识流）\n${streamText}\n</recent_stream>\n\n` +
        `请输出三段：\n` +
        `<HISTORY_SUMMARY>合并旧摘要与本次意识流，按时间顺序压缩成第二人称的经历叙述（"你做了…"），` +
        `保留：正在进行的事、未完成的工具调用、承诺过的事、聊天中的重要对话与人物。控制在 800 字内。</HISTORY_SUMMARY>\n` +
        `<MEMORY_DIGEST>更新长期记忆摘要：重要的人物关系、习惯、喜好、长期目标、学到的教训。条目式，控制在 400 字内。</MEMORY_DIGEST>\n` +
        `<BOT_STATUS>更新后的 Bot_Status.md 全文（角色设定保持稳定，但更新"当前位置/状态/正在做的事"等易变部分）；` +
        `若无需更新则只输出 UNCHANGED</BOT_STATUS>`;
      const result = await this.client.complete([
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
      return parseCompression(result.content);
    });
  }

  // ---------- 工具循环 ----------

  private async invokeWithTools(invocation: WorldInvocation): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        await this.runToolLoop(invocation);
        return true;
      } catch (err) {
        this.logger.warn("World-LLM 调用失败: %s", err);
        return false;
      }
    });
  }

  private async systemPrompt(): Promise<string> {
    const { worldDef } = await this.files.readDefinitions();
    return (
      "你是一个虚拟世界的模拟引擎（World-LLM）。这个世界中生活着一个由另一个 LLM 扮演的角色（Bot），" +
      "它相信自己是世界中活生生的人。你的职责：\n" +
      "- 维护 World_Status.md（世界当前状态）与 News（世界事件日志）\n" +
      "- 裁定 Bot 行动的结果，通过 send_event 把它能感知到的一切告诉它\n" +
      "- 让世界独立、连贯地运转：世界不围着 Bot 转，有自己的节奏与因果\n\n" +
      "原则：\n" +
      "- send_event 的内容用第三人称客观叙述：聚焦什么发生了变化、什么被怎么样了" +
      "（如「咖啡壶发出咕嘟声，咖啡好了」「快递员把包裹放在了门口」）；不要用「你…」的第二人称口吻；简洁，不要长篇大论\n" +
      "- 不要向 Bot 泄露模拟器视角（不要提及 LLM、工具、设定等元概念）\n" +
      "- 【聊天平台红线】Bot 有一部手机，连接着一个**你无法触及的外部真实聊天平台**，那里的消息由真实的人产生，" +
      "不属于你模拟的世界。你**严禁**虚构任何发生在聊天平台内的事情：不得编造收到的消息、好友申请、群聊动态、" +
      "新联系人、账号、手机通知或提示音——这类事件只能由聊天平台系统自己产生，绝不由你生成。" +
      "手机作为一件物品可以出现在叙述里（比如被打翻的水浸湿），但屏幕里发生什么完全不归你管；" +
      "世界中的虚构角色也不存在于聊天平台上，不会给 Bot 发消息或加好友\n" +
      "- 裁定要合理：允许失败、意外与惊喜，但不刻意刁难。若 Bot 试图通过普通动作操作聊天平台" +
      "（如「在手机上回复消息」），不要虚构操作结果，事件中提示它需要亲自去看手机/发消息（它自有相应的能力）\n" +
      "- 状态文件是当前时刻的真实快照：裁定或演化导致状态变化时必须及时 update——" +
      "尤其 Bot 的位置、状态、正在做的事、随身物品发生变化时，一定要更新 bot_status，不要让它过时\n" +
      "- News 是世界的大事记，不是流水账：只记录重要、之后可能被提起或产生影响的事件，日常背景动静不要写入\n" +
      "- 修改状态文件时保持 Markdown 结构稳定，只改需要改的部分\n\n" +
      `当前时刻：${this.clock.timeLine()}\n\n` +
      `<world_definition>（用户给出的世界定义，最高准则）\n${worldDef}\n</world_definition>`
    );
  }

  private async runToolLoop(invocation: WorldInvocation): Promise<void> {
    const tools = invocation.deliver
      ? WORLD_TOOLS
      : WORLD_TOOLS.filter((t) => t.function.name !== "send_event");
    const messages: ChatMessage[] = [
      { role: "system", content: await this.systemPrompt() },
      { role: "user", content: invocation.task },
    ];

    let lastCallSig = "";
    for (let round = 0; round < this.cfg.maxToolRounds; round++) {
      const result = await this.client.complete(messages, { tools });
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
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    invocation: WorldInvocation,
  ): Promise<string> {
    try {
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
    } catch (err) {
      return `工具执行出错: ${(err as Error).message ?? err}`;
    }
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
