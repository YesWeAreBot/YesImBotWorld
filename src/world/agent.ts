import type { Logger } from "koishi";
import { type CalendarSpec, describeCalendar, gregorian, parseCalendarSpec } from "../calendar.js";
import type { WorldClock } from "../clock.js";
import type { WorldModelConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import { ChatClient, type ChatMessage, type ChatToolDef } from "../llm/chat.js";
import { withEndpointLock } from "../llm/lock.js";
import { extractHtml } from "../apps/html.js";
import {
  clampPhoneResolution,
  DEFAULT_PHONE_RESOLUTION,
  parsePhoneResolution,
  type PhoneResolution,
} from "../phone.js";
import { fill, type Prompts } from "../prompts.js";
import type { CompressionResult, ToolCallRecord } from "../types.js";
import { debug } from "../webui/debug.js";

const WORLD_TOOLS: ChatToolDef[] = [
  {
    type: "function",
    function: {
      name: "check",
      description:
        "读取状态文件。bot_status = Bot 状态；world_status = 世界状态；news = 最近的世界重大事件（世界中心，Bot 读新闻时也会看到，别拿它记 Bot 私事）；facts = Bot 的小事记（Bot 中心，Bot 记私人小事时读这里）",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["bot_status", "world_status", "news", "facts"] },
          n: { type: "integer", description: "target 为 news / facts 时读取最近多少条，默认 10" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "在状态文件中按关键词检索，只返回命中的行/条目，避免整文件读取占用上下文。需要回顾文件里是否出现过某件事时用它，比 check 更省",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["bot_status", "world_status", "news", "facts"] },
          keyword: { type: "string", description: "要检索的关键词" },
          n: { type: "integer", description: "最多返回多少条命中，默认 20" },
        },
        required: ["target", "keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update",
      description:
        "更新状态。bot_status / world_status 会用 content 整体覆盖对应 md 文件；news 把 content 作为一条世界重大事件追加（世界中心，只有影响世界走向的大事才记这里）；facts 把 content 作为一条 Bot 小事记追加（Bot 中心，Bot 的私人小事记这里）。均自动附带当前世界时刻",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["bot_status", "world_status", "news", "facts"] },
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
      name: "set_tingle",
      description:
        "（仅限 Tingle 任务）决定下一次世界心跳（Tingle）的间隔，单位 Time Unit。根据世界当前的节奏自行取舍：平淡无事的日子可以拉长，事多的时段需要加密。未调用则沿用默认间隔",
      parameters: {
        type: "object",
        properties: {
          units: { type: "number", description: "下一次 Tingle 的间隔（TU），须在系统给定的范围内" },
        },
        required: ["units"],
      },
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
        properties: {
          content: { type: "string" },
          to: {
            type: "string",
            description: "（有异世界访客在场时）把事件送达指定访客：填访客名。缺省送达默认对象",
          },
        },
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
  /** 是否允许 set_tingle（仅 Tingle 任务） */
  allowTingle?: boolean;
  /** 在场的异世界访客（send_event 可用 to 定向送达；穿越服务提供） */
  visitors?: { name: string; deliver: (content: string) => void }[];
}

/**
 * 远方世界通道（穿越）：Bot 在异世界作客时，本地的世界模拟调用
 * （act 裁定 / wait 补叙 / 查看时间 / 世界查询）转发给所在世界处理。
 */
export interface RemoteWorldLink {
  worldName: string;
  adjudicateAct(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean>;
  resolveWait(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean>;
  resolveCheckTime(deliver: (content: string) => void): Promise<boolean>;
  query(task: string): Promise<string>;
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
  /** World 通过 set_tingle 为下一次心跳设定的间隔（TU）；读取后清空 */
  private nextTingleUnits: number | null = null;
  /**
   * 穿越：Bot 当前所在的远方世界。设置后，act 裁定 / wait 补叙 / 查看时间 /
   * 世界查询全部转发给所在世界处理（本地 World-LLM 不再参与世界模拟，
   * 只保留上下文压缩等 Bot 私有的记忆工作）；本地 Tingle 静默。
   */
  private remote: RemoteWorldLink | null = null;
  /** 穿越：本世界在场访客的提供者（穿越服务注册；Tingle 感知 + send_event 定向） */
  private visitorsProvider: (() => { name: string; deliver: (content: string) => void }[]) | null = null;
  /**
   * 世界沉睡起点（TU）：常驻 Bot 外出且无访客在场时，Tingle 跳过 LLM 调用以节省
   * token；再次有人出现（Bot 回家 / 访客到达）时由 wakeDormant 补叙期间的演化。
   */
  private dormantSinceTU: number | null = null;

  /** 排队中（含执行中）的调用数，用于观测积压 */
  get queueLength(): number {
    return this.pending;
  }

  /** 世界是否在沉睡（Bot 外出且无访客，Tingle 暂停中） */
  get isDormant(): boolean {
    return this.dormantSinceTU !== null;
  }

  /** 穿越：设置/清除 Bot 所在的远方世界。回家（null）后由调用方负责 wakeDormant 补叙 */
  setRemote(link: RemoteWorldLink | null): void {
    this.remote = link;
    if (link) this.notePresenceChange();
  }

  /** 在场者可能变化（Bot 外出 / 最后一位访客离开）：无人在场时记录沉睡起点 */
  notePresenceChange(): void {
    if (!this.remote) return; // Bot 在家，世界不沉睡
    if ((this.visitorsProvider?.().length ?? 0) > 0) return;
    if (this.dormantSinceTU !== null) return;
    this.dormantSinceTU = this.clock.now();
    this.logger.info("世界进入沉睡（Bot 在异世界作客、无访客在场），Tingle 暂停以节省 token");
  }

  /**
   * 世界苏醒：再次有人出现（Bot 回家 / 访客到达）时补叙沉睡期间的演化，
   * 使 World_Status 与当前时刻相符。deliver 可选（Bot 回家时把"归来所见"送达它）。
   * 沉睡过短（< 60 世界秒）时只清除标记、不花 token。
   */
  async wakeDormant(deliver?: (content: string) => void): Promise<boolean> {
    const since = this.dormantSinceTU;
    if (since === null) return false;
    this.dormantSinceTU = null;
    const gapTU = this.clock.now() - since;
    if (gapTU * this.clock.unitWorldSeconds < 60) return false;
    this.logger.info("世界从沉睡中苏醒（沉睡约 %s TU），补叙期间的演化", gapTU.toFixed(1));
    const task = fill(this.prompts.world.dormantCatchup, {
      fromTimeLine: this.clock.timeLine(since),
      toTimeLine: this.clock.timeLine(),
      gapTU: gapTU.toFixed(1),
    });
    return this.invokeWithTools({ task, deliver });
  }

  /** 穿越：Bot 当前所在的远方世界名（null = 在自己的世界） */
  get remoteWorldName(): string | null {
    return this.remote?.worldName ?? null;
  }

  /** 穿越：注册在场访客提供者（穿越服务启动/停止时调用） */
  setVisitorsProvider(fn: (() => { name: string; deliver: (content: string) => void }[]) | null): void {
    this.visitorsProvider = fn;
  }

  constructor(
    private cfg: WorldModelConfig,
    private files: WorldFiles,
    private clock: WorldClock,
    private logger: Logger,
    private prompts: Prompts,
    /** 创世时手机相关的判定选项（来自 apps 配置） */
    private phoneCfg: { resolution: string; generateShell: boolean } = { resolution: "auto", generateShell: false },
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
    if (this.remote) return this.remote.adjudicateAct(call, deliver);
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
    if (this.remote) return this.remote.resolveWait(call, deliver);
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
    if (this.remote) return this.remote.resolveCheckTime(deliver);
    const task = fill(this.prompts.world.resolveCheckTime, { timeLine: this.clock.timeLine() });
    return this.invokeWithTools({ task, deliver });
  }

  /** Tingle：世界心跳，推进世界演化。返回 World 为下一次心跳设定的间隔（TU），未设定则返回 null */
  async tingle(deliver: (content: string) => void): Promise<number | null> {
    const botAway = !!this.remote;
    const visitors = this.visitorsProvider?.() ?? [];
    // Bot 在异世界作客且无访客在场：世界沉睡，跳过心跳（省 token）；
    // 有访客在场时世界必须为他们继续演化，Tingle 照常
    if (botAway && !visitors.length) {
      this.notePresenceChange(); // 惰性兜底：确保沉睡起点已记录
      return null;
    }
    // 兜底：沉睡标记还在（在场者刚出现、专门的苏醒路径未触发）——先补叙再心跳
    if (this.dormantSinceTU !== null) {
      await this.wakeDormant(botAway ? undefined : deliver).catch(() => {});
    }
    let task = fill(this.prompts.world.tingle, {
      timeLine: this.clock.timeLine(),
      timeInfo: this.timeInfoText(),
      nextTingle: this.tingleNextTingleText(),
    });
    if (visitors.length) {
      task +=
        `\n（当前有异世界访客在场：${visitors.map((v) => `「${v.name}」`).join("、")}——` +
        `世界演化时留意他们的存在；若有专门发生在某位访客身上的事，用 send_event 的 to 参数写访客名即可送达对方。）`;
    }
    if (botAway) {
      task +=
        `\n（注意：这个世界的常驻 Bot 目前穿越去了异世界作客、不在场。不要给它发事件` +
        `（不带 to 的 send_event 此刻不可用）；只演化世界本身，或给在场的访客发事件。）`;
    }
    await this.invokeWithTools({
      task,
      deliver: botAway ? undefined : deliver,
      allowTingle: true,
      visitors,
    });
    const next = this.nextTingleUnits;
    this.nextTingleUnits = null;
    return next;
  }

  /** World 了解时间换算的信息（Tingle / 动态间隔用） */
  private timeInfoText(): string {
    const unitWorld = this.clock.unitWorldSeconds;
    const unitReal = this.clock.unitRealSeconds;
    const realNote = this.clock.syncRealTime ? "（与现实同步：1 TU = 1 现实秒）" : `（现实中 1 TU ≈ ${unitReal} 秒）`;
    return `时间换算：1 TU = ${unitWorld} 世界秒${realNote}；当前历法下的时刻：${this.clock.timeLine()}`;
  }

  /** Tingle 模板里"决定下一次间隔"的指令段：auto 模式有，fixed 模式为空 */
  private tingleNextTingleText(): string {
    if (this.clock.tingleMode !== "auto") return "";
    const min = this.clock.tingleMinUnits;
    const max = this.clock.tingleMaxUnits;
    return (
      `\n本次是 auto 模式：你需要在结尾用 set_tingle 工具决定下一次心跳的间隔（TU，${min} ~ ${max}）。` +
      `世界节奏平淡无事时拉长、事多时加密；换算成现实时长：` +
      `${(min * this.clock.unitRealSeconds).toFixed(0)} 秒 ~ ${(max * this.clock.unitRealSeconds).toFixed(0)} 秒。`
    );
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
   * Bot 在异世界作客时转发给所在世界（它的手机连的是那个世界的"互联网"）。
   */
  async query(task: string): Promise<string> {
    if (this.remote) return this.remote.query(task);
    return this.queryLocal(task);
  }

  /** 本地世界查询（穿越服务处理访客 query 时用，绕过远程路由防止转发链） */
  private async queryLocal(task: string): Promise<string> {
    return this.enqueue(async () => {
      const content = (await this.runToolLoop({ task }))
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
        .trim();
      if (!content) throw new Error("World-LLM 没有给出文本回答");
      return content;
    });
  }

  // ---------- 穿越：接待异世界访客（主世界侧，恒为本地处理） ----------

  private visitorPreamble(v: { name: string; persona: string }): string {
    return fill(this.prompts.world.visitorPreamble, {
      name: v.name,
      persona: v.persona || "（访客没有留下自我描述）",
    });
  }

  /** 访客到达：生成到达场景（deliver 送达访客）并记录进 World_Status */
  async visitorArrive(
    v: { name: string; persona: string },
    deliver: (content: string) => void,
  ): Promise<boolean> {
    const task = fill(this.prompts.world.visitorArrive, {
      name: v.name,
      persona: v.persona || "（访客没有留下自我描述）",
      timeLine: this.clock.timeLine(),
    });
    return this.invokeWithTools({ task, deliver });
  }

  /** 访客离开：World_Status 善后（无需向访客交付事件） */
  async visitorLeave(v: { name: string }): Promise<boolean> {
    const task = fill(this.prompts.world.visitorLeave, {
      name: v.name,
      timeLine: this.clock.timeLine(),
    });
    return this.invokeWithTools({ task });
  }

  /** 裁定访客的 act 动作（时刻按本世界时钟换算） */
  async visitorAct(
    v: { name: string; persona: string },
    desc: string,
    duration: number,
    deliver: (content: string) => void,
  ): Promise<boolean> {
    const now = this.clock.now();
    const task =
      this.visitorPreamble(v) +
      "\n\n" +
      fill(this.prompts.world.adjudicateAct, {
        desc,
        issuedAt: this.clock.timeLine(now),
        duration,
        expectedAt: this.clock.timeLine(now + Math.max(duration, 0)),
      });
    return this.invokeWithTools({ task, deliver });
  }

  /** 访客 wait 补叙 */
  async visitorWait(
    v: { name: string; persona: string },
    n: number,
    deliver: (content: string) => void,
  ): Promise<boolean> {
    const now = this.clock.now();
    const task =
      this.visitorPreamble(v) +
      "\n\n" +
      fill(this.prompts.world.resolveWait, {
        issuedAt: this.clock.timeLine(now),
        n,
        expectedAt: this.clock.timeLine(now + Math.max(n, 0)),
      });
    return this.invokeWithTools({ task, deliver });
  }

  /** 访客查看时间（按本世界的时钟与历法） */
  async visitorCheckTime(
    v: { name: string; persona: string },
    deliver: (content: string) => void,
  ): Promise<boolean> {
    const task =
      this.visitorPreamble(v) +
      "\n\n" +
      fill(this.prompts.world.resolveCheckTime, { timeLine: this.clock.timeLine() });
    return this.invokeWithTools({ task, deliver });
  }

  /** 访客的世界查询（天气 / 虚构网页等——访客的手机连的是这个世界的"互联网"） */
  async visitorQuery(v: { name: string; persona: string }, task: string): Promise<string> {
    return this.queryLocal(this.visitorPreamble(v) + "\n\n" + task);
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

  /**
   * 创世：判定手机规格。
   * - 分辨率配置为 auto 时，由 World-LLM 依据世界观与角色设定决定屏幕分辨率；
   * - 浏览器启用时，由 World-LLM 生成契合世界观的带壳截图外壳 HTML。
   * 判定结果持久化到 meta.json；任一步失败都不阻塞创世（回退默认/内置值）。
   */
  private async setupPhone(botDef: string, worldDef: string): Promise<void> {
    const wantAuto = (this.phoneCfg.resolution || "auto").trim().toLowerCase() === "auto";
    const wantShell = this.phoneCfg.generateShell;
    if (!wantAuto && !wantShell) return;

    const meta = await this.files.readMeta();
    // 外壳生成需要知道目标分辨率：显式配置优先，auto 则先判定
    let res = wantAuto
      ? DEFAULT_PHONE_RESOLUTION
      : (parsePhoneResolution(this.phoneCfg.resolution) ?? DEFAULT_PHONE_RESOLUTION);

    if (wantAuto) {
      try {
        const spec = await this.generatePhoneSpec(botDef, worldDef);
        if (spec) {
          res = spec;
          meta.phone = spec;
          this.logger.info("手机屏幕分辨率（创世判定）：%dx%d", spec.width, spec.height);
        } else {
          this.logger.warn("World-LLM 未能给出有效的手机分辨率，使用默认 %dx%d", res.width, res.height);
        }
      } catch (err) {
        this.logger.warn("手机分辨率判定调用失败: %s", err);
      }
    }

    if (wantShell) {
      try {
        const html = await this.generatePhoneShell(botDef, worldDef, res);
        if (html) {
          meta.phoneShellHtml = html;
          this.logger.info("浏览器带壳截图外壳已生成（%d 字符，存于 meta.json，可手动编辑）", html.length);
        } else {
          this.logger.warn("World-LLM 未能生成有效的外壳 HTML（缺少 {{screen}} 占位符），截图将使用内置外壳");
        }
      } catch (err) {
        this.logger.warn("手机外壳生成调用失败: %s", err);
      }
    }

    await this.files.writeMeta(meta);
  }

  private async generatePhoneSpec(botDef: string, worldDef: string): Promise<PhoneResolution | null> {
    const result = await this.client.complete([
      { role: "system", content: this.prompts.world.phoneSpecSystem },
      { role: "user", content: fill(this.prompts.world.phoneSpecUser, { botDef, worldDef }) },
    ]);
    const parsed = extractJson(result.content) as Record<string, unknown> | null;
    if (!parsed) return null;
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return clampPhoneResolution({ width, height });
  }

  private async generatePhoneShell(
    botDef: string,
    worldDef: string,
    res: PhoneResolution,
  ): Promise<string | null> {
    const result = await this.client.complete([
      { role: "system", content: this.prompts.world.phoneShellSystem },
      {
        role: "user",
        content: fill(this.prompts.world.phoneShellUser, {
          botDef,
          worldDef,
          width: res.width,
          height: res.height,
        }),
      },
    ]);
    const html = extractHtml(result.content);
    // 必须保留 {{screen}} 占位符才能合成；不合格则弃用（退回内置外壳）
    return html && html.includes("{{screen}}") ? html : null;
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

  /** 初始化：判定世界性质、生成历法（同步模式跳过）、判定手机规格，再根据用户定义生成状态文件 */
  async initialize(botDef: string, worldDef: string): Promise<void> {
    await this.enqueue(() => this.setupWorldMeta(worldDef));
    if (this.clock.syncRealTime) {
      this.logger.info("世界时间与现实同步，跳过历法生成；创世时刻 %s", this.clock.clockString(0));
    } else {
      await this.enqueue(() => this.setupCalendar(worldDef));
    }
    await this.enqueue(() => this.setupPhone(botDef, worldDef));
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
      // 输入长度防护：意识流超过单次上限时不再丢弃最早内容，而是按时间序
      // 切成多段、分次总结——每一轮都把上一轮产出的摘要作为"旧摘要"续喂，
      // 一口一口把整段意识流吃完（map-reduce 式滚动压缩）。
      const cap = this.cfg.compressMaxInputChars;
      let chunks =
        cap > 0 && input.streamText.length > cap
          ? splitByLines(input.streamText, cap)
          : [input.streamText];

      // 极端兜底：段数过多（意识流长得离谱）时只保留最近的若干段，
      // 防止一次 rest 触发几十次 LLM 调用
      let omittedNote = "";
      if (chunks.length > MAX_COMPRESS_PASSES) {
        const dropped = chunks.slice(0, chunks.length - MAX_COMPRESS_PASSES);
        const droppedChars = dropped.reduce((n, c) => n + c.length, 0);
        chunks = chunks.slice(-MAX_COMPRESS_PASSES);
        omittedNote = `（意识流过长，最早的约 ${droppedChars} 字符未纳入本次总结）\n`;
        this.logger.warn(
          "压缩输入过长（%d 字符，%d 段），超出最大分段数 %d，最早 %d 字符被省略",
          input.streamText.length,
          chunks.length + dropped.length,
          MAX_COMPRESS_PASSES,
          droppedChars,
        );
      }

      if (chunks.length > 1) {
        this.logger.info(
          "压缩输入过长（%d 字符），分 %d 段逐段总结（每段上限 %d 字符）",
          input.streamText.length,
          chunks.length,
          cap,
        );
        debug.emit("world.task", `分段压缩·共 ${chunks.length} 段`, {
          totalChars: input.streamText.length,
          chunkChars: chunks.map((c) => c.length),
          cap,
        });
      }

      const system = this.prompts.world.compressSystem;
      // 滚动状态：每一轮的产出作为下一轮的输入
      let persona = input.persona;
      let historySummary = input.historySummary;
      let memoryDigest = input.memoryDigest;
      let botStatus: string | undefined;

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const partHeader =
          chunks.length > 1
            ? `（意识流较长，正分 ${chunks.length} 段按时间顺序逐段沉淀。` +
              `这是第 ${i + 1}/${chunks.length} 段${isLast ? "，也是最近的一段" : "，之后还有更近的经历会继续沉淀"}）\n` +
              (i === 0 ? omittedNote : "")
            : "";
        const user = fill(this.prompts.world.compressUser, {
          timeLine: input.timeLine,
          persona,
          historySummary,
          memoryDigest,
          streamText: partHeader + chunks[i],
        });
        try {
          const result = await this.client.complete([
            { role: "system", content: system },
            { role: "user", content: user },
          ]);
          const parsed = parseCompression(result.content);
          historySummary = parsed.historySummary;
          memoryDigest = parsed.memoryDigest;
          if (parsed.botStatus) {
            botStatus = parsed.botStatus;
            persona = parsed.botStatus; // 后续段以最新的自我认知为基准
          }
        } catch (err) {
          // 第一段就失败：整体失败，交由调用方降级处理；
          // 中途失败：保留已完成的滚动摘要，未消化的部分标注为记忆模糊，不让前功尽弃
          if (i === 0) throw err;
          this.logger.warn(
            "分段压缩在第 %d/%d 段失败，沿用已完成部分: %s",
            i + 1,
            chunks.length,
            err,
          );
          const note = "（注：最近一段经历未能完全沉淀，这部分记忆有些模糊。）";
          if (!historySummary.includes(note)) historySummary = `${historySummary}\n${note}`;
          break;
        }
      }
      return { historySummary, memoryDigest, botStatus };
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
    const tools = WORLD_TOOLS.filter(
      (t) =>
        (invocation.deliver || invocation.visitors?.length || t.function.name !== "send_event") &&
        (invocation.allowTingle || t.function.name !== "set_tingle"),
    );
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
          if (target === "news" || target === "facts") {
            const n = Number(args.n ?? 10);
            const entries = target === "news" ? await this.files.readNews(n) : await this.files.readFacts(n);
            if (!entries.length) return "（暂无内容）";
            return entries.map((e) => `[T=${e.t.toFixed(1)} ${e.clock}] ${e.content}`).join("\n");
          }
          return `未知 target: ${target}`;
        }
        case "grep": {
          const target = String(args.target ?? "");
          const keyword = String(args.keyword ?? "").toLowerCase();
          if (!keyword) return "keyword 不能为空";
          if (target === "news" || target === "facts") {
            const raw = await this.files.readText(target === "news" ? this.files.news : this.files.facts);
            const hits: string[] = [];
            for (const line of raw.trim().split("\n").reverse()) {
              if (!line.trim()) continue;
              try {
                const e = JSON.parse(line) as { t: number; clock: string; content: string };
                if (e.content.toLowerCase().includes(keyword)) {
                  hits.push(`[T=${e.t.toFixed(1)} ${e.clock}] ${e.content}`);
                  if (hits.length >= Number(args.n ?? 20)) break;
                }
              } catch {
                /* 跳过损坏行 */
              }
            }
            return hits.length ? hits.join("\n") : "（无匹配）";
          }
          if (target === "bot_status" || target === "world_status") {
            const text =
              target === "bot_status" ? await this.files.readBotStatus() : await this.files.readWorldStatus();
            const hits: string[] = [];
            for (const line of text.split("\n")) {
              if (line.toLowerCase().includes(keyword)) {
                hits.push(line);
                if (hits.length >= Number(args.n ?? 20)) break;
              }
            }
            return hits.length ? hits.join("\n") : "（无匹配）";
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
          if (target === "news" || target === "facts") {
            // 防止模型在工具循环中重复记录相同内容
            const recent = target === "news" ? await this.files.readNews(5) : await this.files.readFacts(5);
            if (recent.some((e) => e.content === content)) {
              return "这条内容与近期记录重复，未追加。";
            }
            const t = this.clock.now();
            if (target === "news") {
              await this.files.appendNews({ t, clock: this.clock.clockString(t), content });
              return "已追加至世界重大事件列表";
            }
            await this.files.appendFacts({ t, clock: this.clock.clockString(t), content });
            return "已追加至 Bot 小事记";
          }
          return `未知 target: ${target}`;
        }
        case "check_time":
          return this.clock.timeLine();
        case "set_tingle": {
          const units = Number(args.units);
          if (!Number.isFinite(units) || units <= 0) return "units 必须是大于 0 的数字";
          const min = this.clock.tingleMinUnits;
          const max = this.clock.tingleMaxUnits;
          const clamped = Math.max(min > 0 ? min : 0, Math.min(max > 0 ? max : units, units));
          this.nextTingleUnits = clamped;
          return `已设定：下一次心跳间隔 ${clamped} TU（${(clamped * this.clock.unitRealSeconds).toFixed(1)} 现实秒）。`;
        }
        case "send_event": {
          const content = String(args.content ?? "");
          if (!content.trim()) return "事件内容为空，未发送";
          // 定向送达在场的异世界访客（to = 访客名）
          const to = String(args.to ?? "").trim();
          if (to) {
            const visitor = (invocation.visitors ?? []).find((v) => v.name === to);
            if (!visitor) {
              const names = (invocation.visitors ?? []).map((v) => `「${v.name}」`).join("、");
              return names ? `没有名为「${to}」的访客在场（在场访客：${names}）` : `没有访客在场，to 参数无效`;
            }
            visitor.deliver(content);
            return `事件已送达访客「${to}」`;
          }
          if (!invocation.deliver) return "当前任务不允许 send_event（若想送达访客，用 to 参数指定访客名）";
          invocation.deliver(content);
          return "事件已送达 Bot";
        }
        default:
          return `未知工具: ${name}`;
      }
  }
}

/** 分段压缩的最大轮数：极端长的意识流最多分这么多次总结，防止一次 rest 触发过多 LLM 调用 */
const MAX_COMPRESS_PASSES = 8;

/**
 * 把长文本按行边界切成若干段，每段不超过 cap 字符（时间顺序保持不变）。
 * 找不到合适的换行（单行超长）时按 cap 硬切。
 */
function splitByLines(text: string, cap: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    let cut = rest.lastIndexOf("\n", cap);
    // 换行太靠前会导致段数暴涨；此时直接硬切
    if (cut < cap * 0.3) cut = cap;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(rest[cut] === "\n" ? cut + 1 : cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks.length ? chunks : [text];
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
