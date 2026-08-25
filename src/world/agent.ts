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
import type { PlayerMode } from "../crossing/protocol.js";
import { debug } from "../webui/debug.js";

/** 只读查询（query）的排队超时：避免被同源端点锁 + 持续生成的 Bot 饿死时无限悬挂 */
const QUERY_TIMEOUT_MS = 60_000;

/**
 * 一个待裁定的 act（批量合并的单元）。Bot 的 act 与真人玩家的 act 统一成这一结构，
 * 好让写队列里相邻的多个 act 合并成一次 World 请求同时裁定。
 */
interface ActItem {
  /** 行为者：常驻 Bot 或某位访客的名字（用于 send_event 的 to 路由与状态写回目标） */
  actor: "bot" | string;
  /** 是常驻 Bot 的动作（true）还是访客的动作（false） */
  isBot: boolean;
  desc: string;
  issuedAt: string;
  expectedAt: string;
  duration: number;
  /** 该 act 结果的事件交付（Bot 的结果收集/玩家实时推送各自的通道） */
  deliver: (content: string) => void;
}

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
        "更新状态。bot_status / world_status 整体覆盖用 content；局部修改（推荐，只改变化的部分、省得重写全文）用 patch 数组给出一组 find→replace（find 是目标文件里要替换的精确原文字符串，必须与文件内容逐字一致且唯一，replace 是替换成的新文字，可为空串表示删除）。news / facts 用 content 追加一条记录（不支持 patch）。均自动附带当前世界时刻。content 与 patch 不能同时给：给了 patch 就忽略 content",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["bot_status", "world_status", "news", "facts"] },
          content: { type: "string", description: "要写的内容（news/facts 为一条记录的标题/简述，bot_status/world_status 为整体覆盖）" },
          detail: { type: "string", description: "仅 target 为 news 时可选：这条新闻的详情正文（Bot 点进去看到的全文）" },
          patch: {
            type: "array",
            description: "仅 target 为 bot_status / world_status 时可选：局部替换列表，按顺序应用。每个元素是一处 find→replace",
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "目标文件里要替换的精确原文（逐字一致，且必须恰好出现一次）" },
                replace: { type: "string", description: "替换成的新文字（空串表示删除这一段）" },
              },
              required: ["find", "replace"],
            },
          },
        },
        required: ["target"],
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
      name: "check_visitor",
      description:
        "（visitorPersonaMode 为 check 时可用）查看某位在场异世界访客的状态档案" +
        "（它的自我认知与当前状态，相当于它自己世界里的 bot_status）。裁定访客的行动前应先查看",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "访客名（只有一位访客在场时可省略）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_visitor_status",
      description:
        "（有异世界访客在场时可用）更新某位**访客**的状态档案（相当于访客自己世界里的 bot_status，" +
        "会回传到它的世界持久保存；当前内容见系统提示的 <visitors> 区，或用 check_visitor 查看）。用 content 整体覆盖：" +
        "保持原有 Markdown 结构，只改需要改的部分。访客的位置、状态、随身物品、正在做的事发生持久变化时" +
        "（受伤、获得/失去物品、移动等）应及时更新。注意：这不是本世界常驻 Bot 的 bot_status，两者互不相干",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "访客名（只有一位访客在场时可省略）" },
          content: { type: "string" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_bot",
      description:
        "更新常驻 Bot 的名字（meta 里机器可读的那份）。**仅当**剧情里 Bot 的名字实际发生变更时使用" +
        "（被赐名、改姓、伪装新身份、称号变化、更名等）。新名字要同步写进 bot_status 的状态档案（用 update(bot_status)），" +
        "并通过 send_event 以符合世界观的方式告知 Bot 本人。此后访客接待等任务都会用这个新名字来称呼常驻 Bot。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Bot 的新名字（它在世界里被人如何称呼的新称呼）" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expel_visitor",
      description:
        "（有访客在场时可用）强行驱逐某位访客离开本世界，切断其后续一切主动互动能力。**仅当**世界演化中" +
        "该角色被认定为死亡、消散、升天、被放逐、永久封印等「不可能再主动与这个世界互动」的结局时使用。" +
        "调用后该访客会立即退出、无法再提交行动，其已有身份也随之失效。reason 会告知对方发生了什么。" +
        "注意：普通离开、暂时离开、失联都不要用这个工具——那属于访客自己的主动离开。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "要驱逐的访客名（只有一位访客在场时可省略）" },
          reason: { type: "string", description: "驱逐原因（如「角色被处决」「形体消散」「飞升成神」），会告知对方" },
        },
        required: ["reason"],
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
            description:
              "把事件送达指定对象：填在场访客的名字，或填 \"bot\" 送达本世界的常驻 Bot。" +
              "缺省送达本次任务的主角",
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
  /** 在场的异世界访客（send_event to= 定向送达、update_visitor_status 状态写回；穿越服务提供） */
  visitors?: PresentVisitor[];
  /**
   * 本世界常驻 Bot 的事件通道（send_event to="bot" 用）。
   * 接待访客的任务里指向真实的常驻 Bot（访客与它的互动必须让它亲身经历）；
   * 常驻 Bot 自己的任务里等同 deliver；Bot 外出时不提供。
   */
  botDeliver?: (content: string) => void;
}

/** 在场访客的完整通道（穿越服务提供） */
export interface PresentVisitor {
  name: string;
  /** 状态档案（会注入系统提示的 <visitors> 区 */
  persona: string;
  /** 真人玩家的进入语义（cross=穿越/avatar=扮演/puppet=操纵）；Bot 访客恒为 cross */
  mode?: PlayerMode;
  /** 事件送达访客 */
  deliver: (content: string) => void;
  /** 状态写回访客世界（update_visitor_status 工具） */
  updateStatus: (content: string) => void;
  /** 强行驱逐该访客（角色死亡/消散/升天等，切断其后续主动互动能力） */
  expel: (reason: string) => void;
}

/** 接待任务里的访客引用（穿越服务传入；状态写回通道统一走 WorldInvocation.visitors） */
export interface VisitorRef {
  name: string;
  persona: string;
  mode?: PlayerMode;
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
 * World_Status.md 与 News.jsonl。所有调用串行化以避免文件写冲突。
 */
export class WorldAgent {
  private client: ChatClient;
  /** 写状态任务的可抢占队列：玩家 act 等高优先级任务会插到队头（在未开始的普通任务之前） */
  private queue: { fn: () => Promise<unknown>; priority: boolean; cancelKey?: string; actItem?: ActItem; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  private draining = false;
  /** 只读查询（终端虚拟输出、天气等）的独立队列：不与写状态的主队列串行，避免被 act 裁定积压饿死 */
  private queryTail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  /** World 通过 set_tingle 为下一次心跳设定的间隔（TU）；读取后清空 */
  private nextTingleUnits: number | null = null;
  /**
   * 穿越：Bot 当前所在的远方世界。设置后，act 裁定 / wait 补叙 / 查看时间 /
   * 世界查询全部转发给所在世界处理（本地 World-LLM 不再参与世界模拟，
   * 只保留上下文压缩等 Bot 私有的记忆工作）；本地 Tingle 静默。
   */
  private remote: RemoteWorldLink | null = null;
  /** 穿越：本世界在场访客的提供者（穿越服务注册；系统提示 <visitors> 区 + send_event 定向 + 状态写回） */
  private visitorsProvider: (() => PresentVisitor[]) | null = null;
  /** 常驻 Bot 的实时事件通道（service 注册；接待访客的任务用 send_event to="bot" 送达它） */
  private hostBotDeliver: ((content: string) => void) | null = null;
  /** 现实世界新闻素材提供者（service 注册）：现实世界设定下 Tingle 抓取真实新闻用以摘编 */
  private realNewsProvider: (() => Promise<string[]>) | null = null;
  /**
   * 访客状态档案的放置方式（crossing.visitorPersonaMode，service 同步）：
   * - pinned：档案常驻系统提示 <visitors> 区（缓存命中率最优）；
   * - check：系统提示只放名单，档案用 check_visitor 工具按需查看（省上下文窗口）。
   */
  visitorPersonaMode: "pinned" | "check" = "pinned";
  /** 常驻 Bot 的名字（创世判定，内存缓存，供 visitor prompt 硬区分；systemPrompt 每次读 meta 刷新） */
  private botName = "";
  /** 供 service/BotContext 读取的常驻 Bot 名字（可能为空=尚未判定） */
  get residentBotName(): string {
    return this.botName;
  }
  /** 穿越：最近离开的访客（下一次 Tingle 时提醒世界清理其在场记述、停止续写其情节） */
  private departedVisitors: string[] = [];
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
  setVisitorsProvider(fn: (() => PresentVisitor[]) | null): void {
    this.visitorsProvider = fn;
  }

  /** 注册/清除常驻 Bot 的实时事件通道（世界启动/停止时由 service 调用） */
  setHostBotDeliver(fn: ((content: string) => void) | null): void {
    this.hostBotDeliver = fn;
  }

  /** 注册/清除现实世界新闻素材提供者（service 调用；现实世界设定下 Tingle 用它抓真实新闻摘编） */
  setRealNewsProvider(fn: (() => Promise<string[]>) | null): void {
    this.realNewsProvider = fn;
  }

  /** 世界启动时：把 meta 里的 botName 刷进内存字段；若还没有（旧世界），从定义补判一次 */
  async ensureBotName(): Promise<void> {
    const meta = await this.files.readMeta();
    if (meta.botName) {
      this.botName = meta.botName;
      return;
    }
    const { botDef } = await this.files.readDefinitions();
    await this.setupBotName(botDef);
  }

  /** 用户手动设置常驻 Bot 名字（WebUI 编辑）：写 meta.json 并刷新内存字段，立即生效 */
  async setBotName(name: string): Promise<void> {
    const trimmed = name.trim().slice(0, 64);
    const meta = await this.files.readMeta();
    await this.files.writeMeta({ ...meta, botName: trimmed || undefined });
    this.botName = trimmed;
    this.logger.info("常驻 Bot 名字（用户设置）：%s", trimmed || "（清空）");
  }

  /**
   * 用户手动改名后，通知 World：这是同一个角色改名（不是新角色），
   * 让 World 同步 bot_status / world_status 里的名字，并 send_event 告知 Bot 本人。
   * deliver = 常驻 Bot 的实时事件通道（service 传入）；世界未运行时跳过。
   */
  async notifyBotRename(oldName: string, newName: string, deliver: (content: string) => void): Promise<void> {
    const task = fill(this.prompts.world.botRename, {
      oldName: oldName || "（此前未判定）",
      newName: newName || "（已清空）",
      timeLine: this.clock.timeLine(),
    });
    await this.invokeWithTools({ task, deliver, botDeliver: deliver, visitors: this.visitorsProvider?.() ?? [] });
  }

  /** 世界是否是现实地球世界（创世判定持久化在 meta.json；旧世界回退到时钟同步模式） */
  private async isRealWorld(): Promise<boolean> {
    const meta = await this.files.readMeta();
    return meta.realWorld ?? this.clock.syncRealTime;
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
  /**
   * 写状态任务入队。priority=true 时插到队头（在尚未开始的普通任务之前），
   * 使玩家 act 等交互式任务被优先处理，不被 Tingle / 到达叙事等积压饿死。
   * 正在执行中的任务不会被抢占（LLM 推理无法安全中断）。
   */
  private enqueue<T>(fn: () => Promise<T>, priority = false, cancelKey?: string, actItem?: ActItem): Promise<T> {
    this.pending++;
    return new Promise<T>((resolve, reject) => {
      const wrapped = () =>
        withEndpointLock(this.cfg.baseURL, fn).finally(() => this.pending--);
      const entry = {
        fn: wrapped as () => Promise<unknown>,
        priority,
        cancelKey,
        actItem,
        resolve: (v: unknown) => resolve(v as T),
        reject,
      };
      if (priority) {
        // 插到第一个普通任务之前（多个高优任务之间保持 FIFO）
        const idx = this.queue.findIndex((t) => !t.priority);
        if (idx === -1) this.queue.push(entry);
        else this.queue.splice(idx, 0, entry);
      } else {
        this.queue.push(entry);
      }
      void this.drain();
    });
  }

  /**
   * 取消队列里「尚未开始执行」的、带指定 cancelKey 的任务（如某访客离开时清掉它未开始的 act）。
   * 正在执行中的任务无法取消（已 shift 出队列）。
   */
  cancelPending(cancelKey: string): void {
    let removed = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const t = this.queue[i]!;
      if (t.cancelKey === cancelKey) {
        this.queue.splice(i, 1);
        this.pending--; // 补偿：这些任务的 fn 不会再执行，pending 计数须手动回收
        t.reject(new Error("任务已取消（玩家已离开世界）"));
        removed++;
      }
    }
    if (removed) this.logger.info("[世界] 取消 %s 的 %d 个未开始任务", cancelKey, removed);
  }

  /** 串行排空写队列（队头优先，高优先任务已在队头）；相邻的 act 合并成一次批量裁定 */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        // act 合并：队列里紧跟其后的、同是 act 的任务一并取出，合成一次 World 请求同时裁定
        if (task.actItem) {
          const batch: { entry: typeof task; item: ActItem }[] = [{ entry: task, item: task.actItem }];
          while (this.queue.length && this.queue[0]!.actItem) {
            const next = this.queue.shift()!;
            batch.push({ entry: next, item: next.actItem! });
          }
          this.pending -= batch.length; // 补偿：这些 act 的 fn（含 pending--）不会执行
          const ok = await this.runActBatch(batch.map((b) => b.item));
          for (const b of batch) b.entry.resolve(ok);
          continue;
        }
        try {
          task.resolve(await task.fn());
        } catch (err) {
          task.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 只读查询（query：终端虚拟输出、天气等）走独立队列：不与写状态的主队列（tail）串行，
   * 避免被 act 裁定 / Tingle 等积压任务饿死——这类查询只 check 状态、不 update，
   * 并发读安全；同源互斥仍由 withEndpointLock 保证。
   * signal 用于排队等待阶段的超时（轮到自己仍会执行 fn，除非 fn 内部也响应 abort）。
   */
  private enqueueQuery<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.pending++;
    const wrapped = () =>
      withEndpointLock(this.cfg.baseURL, fn, signal).finally(() => this.pending--);
    const next = this.queryTail.then(wrapped, wrapped);
    this.queryTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ---------- 对外任务 ----------

  /**
   * 批量裁定多个 act（Bot 与/或访客的动作合并成一次 World 请求）。
   * 每个 act 的结果用 send_event 的 to 参数路由：Bot 的动作 to="bot"（→ botDeliver），
   * 访客的动作 to=访客名（→ 该访客本次 act 的 deliver，含实时推送/聚合，与单发语义一致）。
   */
  private async runActBatch(items: ActItem[]): Promise<boolean> {
    const botItem = items.find((i) => i.isBot);
    const actsText = items
      .map((it, i) => {
        const who = it.isBot ? `常驻 Bot（to="bot"）` : `访客「${it.actor}」（to="${it.actor}"）`;
        const time = it.duration > 0 ? `，耗时 ${it.duration} TU` : "";
        return `${i + 1}. ${who}：${it.desc}（${it.issuedAt}${time}）`;
      })
      .join("\n");
    const task = fill(this.prompts.world.adjudicateActBatch, {
      acts: actsText,
      botName: this.botName || "（常驻 Bot，名字未定）",
    });
    // 定制 visitors：让「有本次 act 的访客」的 deliver 指向其 act 的结果通道（实时推送 + 聚合），
    // 与单发 visitorAct 的 deliver 语义一致；其余访客保持全局广播通道。
    const visitors = (this.visitorsProvider?.() ?? []).map((p) => {
      const item = items.find((i) => !i.isBot && i.actor === p.name);
      return item ? { ...p, deliver: item.deliver } : p;
    });
    // deliver 留空禁用「无 to」的 send_event；Bot 的结果经 botDeliver（延迟交付）。
    const invocation: WorldInvocation = { task, botDeliver: botItem?.deliver, visitors };
    // 直接执行（已在 drain 层持有写队列的串行锁）；同源端点互斥仍需 withEndpointLock
    return withEndpointLock(this.cfg.baseURL, async () => {
      try {
        const finalContent = await this.runToolLoop(invocation);
        debug.emit("world.result", "批量裁定完成", { finalContent: finalContent.slice(0, 2000) });
        return true;
      } catch (err) {
        this.logger.warn("World-LLM 批量裁定失败: %s", err);
        return false;
      }
    });
  }

  /** 把单个 act 投进写队列（priority + 可合并）。发给访客的 act 用 cancelKey 以便离场时取消 */
  private enqueueAct(item: ActItem, cancelKey?: string): Promise<boolean> {
    return this.enqueue(
      () => this.runActBatch([item]),
      true,
      cancelKey,
      item,
    );
  }

  /** 裁定 Bot 的 act 动作。产出的事件通过 deliver 交付（由调度器压到期望完成时刻） */
  async adjudicateAct(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean> {
    if (this.remote) return this.remote.adjudicateAct(call, deliver);
    const desc = String(call.arguments.description ?? call.arguments.str ?? JSON.stringify(call.arguments));
    const item: ActItem = {
      actor: "bot",
      isBot: true,
      desc,
      issuedAt: this.clock.timeLine(call.issuedAt),
      expectedAt: this.clock.timeLine(call.expectedAt),
      duration: call.duration ?? 0,
      deliver,
    };
    // Bot 的 act 与真人玩家的 act 同级：priority=true 插到普通任务（Tingle 等）之前，不被积压饿死；
    // 相邻的 act（Bot + 玩家）会在 drain 时合并成一次 World 请求同时裁定。
    return this.enqueueAct(item);
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
    return this.invokeWithTools({ task, deliver, botDeliver: deliver, visitors: this.visitorsProvider?.() ?? [] });
  }

  /** Bot 主动查看时间：由世界裁定它此刻能否得知时间（允许失败）。只读任务，走并行队列 */
  async resolveCheckTime(deliver: (content: string) => void): Promise<boolean> {
    if (this.remote) return this.remote.resolveCheckTime(deliver);
    const task = fill(this.prompts.world.resolveCheckTime, { timeLine: this.clock.timeLine() });
    return this.invokeWithTools({ task, deliver }, true);
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
      // 访客名单与状态档案在系统提示的 <visitors> 区；这里只放固定的操作提示（逐字稳定，利于前缀缓存）
      task +=
        `\n（当前有异世界访客在场，名单与状态见系统提示的 <visitors> 区——世界演化时留意他们的存在；` +
        `若有专门发生在某位访客身上的事，用 send_event 的 to 参数写访客名即可送达对方。）`;
    }
    if (botAway) {
      task +=
        `\n（注意：这个世界的常驻 Bot 目前穿越去了异世界作客、不在场。不要给它发事件` +
        `（不带 to 的 send_event 此刻不可用）；只演化世界本身，或给在场的访客发事件。）`;
    }
    // 最近离开的访客：提醒世界清理其在场记述、停止续写其情节（一次性提醒，随后清空）
    if (this.departedVisitors.length) {
      task +=
        `\n（重要：以下异世界访客**已经离开**这个世界：${this.departedVisitors.join("、")}。` +
        `先 check world_status——若其中仍有他们"在场/正在做某事"的记述，请 update world_status 清理干净（可保留他们留下的持久影响）；` +
        `之后的世界演化**不要**再出现他们本人的情节。）`;
      this.departedVisitors = [];
    }
    // 现实世界设定：抓取真实新闻作为素材，由 World-LLM 摘编进 News.jsonl
    if (this.realNewsProvider && (await this.isRealWorld())) {
      try {
        const headlines = await this.realNewsProvider();
        if (headlines.length) {
          task +=
            `\n\n（以下是现实世界当下正在发生的真实新闻头条，供你参考：\n` +
            headlines.map((h) => `- ${h}`).join("\n") +
            `\n请不要逐条照抄，而是挑选其中重要、会影响世界走向或人们生活的事件，用它自己的口吻摘编成本世界的新闻` +
            `（用 update(news) 记录，一般一两条即可，无关紧要的琐事不要记）。` +
            `content 写一句简明的标题式简述，detail 写一段详情正文（几句话说清来龙去脉，Bot 点进这条新闻时会看到这段）。` +
            `这些新闻对你模拟的世界而言就是真实发生的，Bot 会像读真新闻一样读到它们。）`;
        }
      } catch (err) {
        this.logger.warn("抓取现实新闻素材失败（跳过一次）: %s", err);
      }
    }
    await this.invokeWithTools({
      task,
      deliver: botAway ? undefined : deliver,
      botDeliver: botAway ? undefined : deliver,
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
    // 只读查询走独立队列 + 排队超时，避免被 act 裁定的串行队列（tail）饿死
    const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
    return this.enqueueQuery(async () => {
      const content = (await this.runToolLoop({ task }))
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
        .trim();
      if (!content) throw new Error("World-LLM 没有给出文本回答");
      return content;
    }, signal);
  }

  // ---------- 穿越：接待异世界访客（主世界侧，恒为本地处理） ----------

  /** 访客档案的所在位置提示（随 visitorPersonaMode 变化，填充 {{personaWhere}}） */
  private personaWhere(): string {
    return this.visitorPersonaMode === "check"
      ? "用 check_visitor 工具可查看"
      : "见系统提示的 <visitors> 区";
  }

  /** 按进入语义生成「这位玩家/角色在本世界的定位」说明（注入到达/接待 prompt） */
  private modeSemantic(v: VisitorRef): string {
    const name = v.name;
    switch (v.mode ?? "cross") {
      case "avatar":
        return (
          `「${name}」是一位真人玩家**扮演**的本世界既有角色（入替）：他完全接管这个角色的身份与言行，` +
          `角色就是玩家本人，不存在另一个独立的角色意识。按角色人设与世界观正常演绎，把他当作世界的一部分。`
        );
      case "puppet":
        return (
          `「${name}」是一位真人玩家**操纵**的本世界既有角色：这个角色仍保有自己的意识与内心活动` +
          `（可能对被操纵有"身体不听使唤"式的内心 OS、抗拒或困惑）。真人玩家通过"行动"指令驱使其身体行动，` +
          `裁定行动时既要如实执行玩家的指令，也要留意角色本人对这一切的感受与反应——二者都写进叙事。`
        );
      default:
        return (
          `「${name}」是从外界穿越降临到本世界的访客：他本人及其自我认知来自另一个世界，` +
          `与本世界的世界观体系无关。他可能对这个世界的规则与风物感到陌生。`
        );
    }
  }

  /** 按进入语义生成「离开时该如何处理该角色」说明（注入离开善后 prompt） */
  private leaveSemantic(v: VisitorRef): string {
    const name = v.name;
    switch (v.mode ?? "cross") {
      case "avatar":
        return (
          `「${name}」是一位真人玩家扮演的本世界既有角色，现在玩家离开了。` +
          `这个角色**仍然属于这个世界**：请保留它的身份与所在，世界之后可以在剧情中继续提到它、` +
          `自然演化它的后续行动与决策（如同世界上其他未被玩家操控的角色一样），不要再把它当作"来访者离开"。`
        );
      case "puppet":
        return (
          `「${name}」是一位真人玩家操纵的本世界既有角色，现在玩家放开了操纵。` +
          `这个角色**恢复了完全自主**（它本就保有自己的意识）：请让它挣脱束缚、恢复自己的意志，` +
          `世界之后正常演化它的后续行动与决策（可能对被操纵的经历有所反应），不要让它就此消失。`
        );
      default:
        return (
          `「${name}」是从外界穿越降临的访客，现在离开了这个世界、返回它自己的世界，它的身影已从本世界消失。` +
          `删除一切"它在场/正在做某事/正与谁互动"的现在时记述——它做过的事可以改写为已完成的过去时痕迹` +
          `（如别人对它的印象、它留下的物品或影响），酌情保留。此后世界演化不应再出现它本人的情节（除非它再次到访）。`
        );
    }
  }

  /** 接待任务里的访客前言（常驻 Bot 外出时附加提示，避免"幽灵互动"） */
  private visitorPreamble(v: VisitorRef): string {
    let text = fill(this.prompts.world.visitorPreamble, {
      name: v.name,
      persona: v.persona || "（访客没有留下自我描述）",
      personaWhere: this.personaWhere(),
      modeSemantic: this.modeSemantic(v),
      botName: this.botName || "（常驻 Bot，名字未定）",
    });
    if (this.remote) {
      text +=
        "\n（另注：本世界的常驻 Bot 眼下不在这个世界——它自己也穿越去了别处。" +
        "场景中不要出现它本人，访客也无法与它互动。）";
    }
    return text;
  }

  private visitorInvocationExtras(): Pick<WorldInvocation, "visitors" | "botDeliver"> {
    return {
      visitors: this.visitorsProvider?.() ?? [],
      // 常驻 Bot 在家时提供其实时事件通道（访客与它的互动必须让它亲身经历）；外出时不提供
      botDeliver: this.remote ? undefined : (this.hostBotDeliver ?? undefined),
    };
  }

  /** 访客到达：生成到达场景（deliver 送达访客）并记录进 World_Status */
  async visitorArrive(v: VisitorRef, deliver: (content: string) => void): Promise<boolean> {
    const task = fill(this.prompts.world.visitorArrive, {
      name: v.name,
      botName: this.botName || "（常驻 Bot，名字未定）",
      persona: v.persona || "（访客没有留下自我描述）",
      personaWhere: this.personaWhere(),
      modeSemantic: this.modeSemantic(v),
      timeLine: this.clock.timeLine(),
    });
    // 到达叙事也用 priority：既插到后台任务（Tingle 等）之前，又保证先于该玩家的 act 执行
    return this.invokeWithTools({ task, deliver, ...this.visitorInvocationExtras() }, false, true);
  }

  /** 访客离开：按进入语义分化——穿越则彻底离场；扮演/操纵则角色留在世界由世界继续演化 */
  async visitorLeave(v: VisitorRef): Promise<boolean> {
    const timeLine = this.clock.timeLine();
    const mode = v.mode ?? "cross";
    // 仅「穿越」离开需要后续 Tingle 提醒世界停止续写其情节；扮演/操纵的角色留在世界，无需停止
    if (mode === "cross") {
      this.departedVisitors.push(`「${v.name}」（${timeLine} 离开）`);
      if (this.departedVisitors.length > 5) this.departedVisitors.splice(0, this.departedVisitors.length - 5);
    }
    const task = fill(this.prompts.world.visitorLeave, {
      name: v.name,
      timeLine,
      leaveSemantic: this.leaveSemantic(v),
    });
    // 离开善后插队：优先于其它积压任务执行
    return this.invokeWithTools({ task }, false, true);
  }

  /** 裁定访客的 act 动作（时刻按本世界时钟换算） */
  async visitorAct(
    v: VisitorRef,
    desc: string,
    duration: number,
    deliver: (content: string) => void,
  ): Promise<boolean> {
    const now = this.clock.now();
    const item: ActItem = {
      actor: v.name,
      isBot: false,
      desc,
      issuedAt: this.clock.timeLine(now),
      expectedAt: this.clock.timeLine(now + Math.max(duration, 0)),
      duration,
      deliver,
    };
    // 玩家的 act：priority（交互式）+ cancelKey=v.name（离场时取消）；相邻 act 会在 drain 合并批量裁定
    return this.enqueueAct(item, v.name);
  }

  /** 访客 wait 补叙 */
  async visitorWait(v: VisitorRef, n: number, deliver: (content: string) => void): Promise<boolean> {
    const now = this.clock.now();
    const task =
      this.visitorPreamble(v) +
      "\n\n" +
      fill(this.prompts.world.visitorWait, {
        name: v.name,
        botName: this.botName || "（常驻 Bot，名字未定）",
        issuedAt: this.clock.timeLine(now),
        n,
        expectedAt: this.clock.timeLine(now + Math.max(n, 0)),
      });
    // 玩家的等待也是交互操作：优先 + 可被离开取消
    return this.invokeWithTools({ task, deliver, ...this.visitorInvocationExtras() }, false, true, v.name);
  }

  /** 访客查看时间（按本世界的时钟与历法） */
  async visitorCheckTime(v: VisitorRef, deliver: (content: string) => void): Promise<boolean> {
    const task =
      this.visitorPreamble(v) +
      "\n\n" +
      fill(this.prompts.world.visitorCheckTime, {
        name: v.name,
        botName: this.botName || "（常驻 Bot，名字未定）",
        timeLine: this.clock.timeLine(),
      });
    // 只读任务：走并行队列（不写状态，只 check + send_event）
    return this.invokeWithTools({ task, deliver, ...this.visitorInvocationExtras() }, true);
  }

  /** 访客的世界查询（天气 / 虚构网页等——访客的手机连的是这个世界的"互联网"） */
  async visitorQuery(v: VisitorRef, task: string): Promise<string> {
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
  private async assessBotName(botDef: string): Promise<string | null> {
    const system = this.prompts.world.assessBotNameSystem;
    const user = fill(this.prompts.world.assessBotNameUser, { botDef });
    const result = await this.client.complete([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const parsed = extractJson(result.content) as Record<string, unknown> | null;
    const name = parsed && typeof parsed.name === "string" ? parsed.name.trim() : "";
    return name || null;
  }

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

  /** 创世/改定义：从 Bot_Definition 判定常驻 Bot 名字并持久化到 meta.json（供访客 prompt 硬区分） */
  private async setupBotName(botDef: string): Promise<void> {
    let name: string | null = null;
    try {
      name = await this.assessBotName(botDef);
    } catch (err) {
      this.logger.warn("Bot 名字判定调用失败: %s", err);
    }
    const meta = await this.files.readMeta();
    if (name) {
      await this.files.writeMeta({ ...meta, botName: name });
      this.logger.info("常驻 Bot 名字（判定）：%s", name);
    } else {
      this.logger.warn("Bot_Definition 中未识别出明确名字，botName 保持 %s", meta.botName ?? "空");
    }
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
   * 分辨率持久化到 meta.json；外壳 HTML 存到独立的 phoneShell.html。任一步失败都不阻塞创世（回退默认/内置值）。
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
          await this.files.writePhoneShell(html);
          this.logger.info("浏览器带壳截图外壳已生成（%d 字符，存于 phoneShell.html，可手动编辑）", html.length);
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
    await this.enqueue(() => this.setupBotName(botDef));
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
    // 定义可能改了 Bot 名字：先重判（失败沿用旧名），再据此调整世界状态
    await this.enqueue(() => this.setupBotName(botDef));
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

  private async invokeWithTools(invocation: WorldInvocation, parallel = false, priority = false, cancelKey?: string): Promise<boolean> {
    debug.emit("world.task", `任务·${invocation.task.slice(0, 60)}`, {
      task: invocation.task,
      deliver: !!invocation.deliver,
    });
    const run = async () => {
      try {
        const finalContent = await this.runToolLoop(invocation);
        debug.emit("world.result", "任务完成", { finalContent: finalContent.slice(0, 2000) });
        return true;
      } catch (err) {
        debug.emit("world.task", "任务失败", String((err as Error).message ?? err), "error");
        this.logger.warn("World-LLM 调用失败: %s", err);
        return false;
      }
    };
    // parallel：只读任务（不写状态文件、只 check + send_event）走独立并行队列，
    // 不被写任务的串行队列饿死——例如"看时间"不该排在 act 裁定后面。
    if (parallel) {
      const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
      return this.enqueueQuery(run, signal);
    }
    return this.enqueue(run, priority, cancelKey);
  }

  private async systemPrompt(): Promise<string> {
    const { worldDef } = await this.files.readDefinitions();
    const meta = await this.files.readMeta();
    this.botName = meta.botName ?? "";
    let sys = fill(this.prompts.world.system, {
      worldDef,
      botName: this.botName || "（未命名）",
      timeLine: this.clock.timeLine(),
    });
    // 在场访客集中放在系统提示末尾（按到达顺序，逐字稳定）：
    // 所有世界任务（Bot 裁定 / 各访客的裁定 / Tingle）共享同一前缀。
    // pinned 模式连档案一起放（多访客任务交错时 persona 不逐条重算，只在变更时失效一次）；
    // check 模式只放名单（省上下文窗口，档案用 check_visitor 按需查看）
    const visitors = this.visitorsProvider?.() ?? [];
    if (visitors.length) {
      const modeTag = (m: PlayerMode | undefined) =>
        m === "avatar" ? "（真人玩家扮演·入替）" : m === "puppet" ? "（真人玩家操纵·角色保有自身意识）" : "（异世界访客）";
      if (this.visitorPersonaMode === "check") {
        sys +=
          "\n\n<visitors>（当前在场的访客名单——状态档案用 check_visitor 工具按需查看；" +
          "档案变更用 update_visitor_status，事件送达用 send_event 的 to 参数）\n" +
          visitors.map((v) => `- 「${v.name}」${modeTag(v.mode)}`).join("\n") +
          "\n</visitors>";
      } else {
        sys +=
          "\n\n<visitors>（当前在场的访客——他们的状态档案，接待任务的裁定依据；" +
          "档案变更用 update_visitor_status 工具，事件送达用 send_event 的 to 参数）\n" +
          visitors.map((v) => `## 「${v.name}」${modeTag(v.mode)}\n${v.persona || "（无自我描述）"}`).join("\n\n") +
          "\n</visitors>";
      }
      // 真人玩家在场：他们的角色由玩家本人驱动，World 演化时不要替其做决定
      sys +=
        "\n\n（重要约束：上面这些访客是**真人玩家在驱动**的角色，其下一步行动与决策由玩家本人给出。" +
        "世界演化时**不要替他们决定要做什么、替他们行动或替他们说话**——你只能让世界/其他角色对**已发生的**事做出反应，" +
        "并把仅发生在他们身上的事用 send_event 的 to 参数送达本人。只有玩家明确通过「行动」指令要求时，才裁定其结果。）";
    }
    return sys;
  }

  /** 运行工具循环，返回模型最后一轮的文本内容 */
  private async runToolLoop(invocation: WorldInvocation): Promise<string> {
    const tools = WORLD_TOOLS.filter(
      (t) =>
        (invocation.deliver || invocation.botDeliver || invocation.visitors?.length || t.function.name !== "send_event") &&
        (invocation.allowTingle || t.function.name !== "set_tingle") &&
        (invocation.visitors?.length ||
          (t.function.name !== "update_visitor_status" && t.function.name !== "expel_visitor")) &&
        ((this.visitorPersonaMode === "check" && invocation.visitors?.length) ||
          t.function.name !== "check_visitor"),
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
          const patch = Array.isArray(args.patch) ? args.patch : [];
          if (target === "bot_status" || target === "world_status") {
            // 局部替换：给了 patch 就忽略 content，做 find→replace（精确匹配、唯一匹配、原子应用）
            if (patch.length) {
              return this.applyStatusPatch(target, patch);
            }
            // 没有 patch：整体覆盖（兜底）；content 为空时视为漏传参数，报错而非清空文件
            if (!content.trim()) {
              return `update(${target}) 需要 patch（局部替换）或 content（整体覆盖），两者都没给有效内容，未做任何修改。`;
            }
            if (target === "bot_status") {
              await this.files.writeBotStatus(content);
              return "Bot_Status.md 已更新";
            }
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
              await this.files.appendNews({
                t,
                clock: this.clock.clockString(t),
                content,
                ...(typeof args.detail === "string" && args.detail.trim() ? { detail: args.detail.trim() } : {}),
              });
              return "已追加至世界重大事件列表";
            }
            await this.files.appendFacts({ t, clock: this.clock.clockString(t), content });
            return "已追加至 Bot 小事记";
          }
          return `未知 target: ${target}`;
        }
        case "check_time":
          return this.clock.timeLine();
        case "rename_bot": {
          const name = String(args.name ?? "").trim();
          if (!name) return "新名字不能为空";
          if (name.length > 64) return "名字过长（最多 64 字符）";
          const meta = await this.files.readMeta();
          await this.files.writeMeta({ ...meta, botName: name });
          this.botName = name;
          this.logger.info("常驻 Bot 更名：%s -> %s", meta.botName ?? "（未命名）", name);
          return `常驻 Bot 现在叫「${name}」（机器可读的名字已更新；请记得同步 update bot_status 里的名字，并 send_event 告知 Bot 本人）。`;
        }
        case "set_tingle": {
          const units = Number(args.units);
          if (!Number.isFinite(units) || units <= 0) return "units 必须是大于 0 的数字";
          const min = this.clock.tingleMinUnits;
          const max = this.clock.tingleMaxUnits;
          const clamped = Math.max(min > 0 ? min : 0, Math.min(max > 0 ? max : units, units));
          this.nextTingleUnits = clamped;
          return `已设定：下一次心跳间隔 ${clamped} TU（${(clamped * this.clock.unitRealSeconds).toFixed(1)} 现实秒）。`;
        }
        case "check_visitor": {
          const visitors = invocation.visitors ?? [];
          if (!visitors.length) return "当前没有访客在场";
          const vname = String(args.name ?? "").trim();
          const target = vname
            ? visitors.find((x) => x.name === vname)
            : visitors.length === 1
              ? visitors[0]
              : undefined;
          if (!target) {
            const names = visitors.map((x) => `「${x.name}」`).join("、");
            return vname
              ? `没有名为「${vname}」的访客在场（在场：${names}）`
              : `在场访客不止一位（${names}），请用 name 参数指定要查看谁`;
          }
          return `访客「${target.name}」的状态档案：\n${target.persona || "（无自我描述）"}`;
        }
        case "update_visitor_status": {
          const content = String(args.content ?? "");
          const visitors = invocation.visitors ?? [];
          if (!visitors.length) return "当前没有访客在场";
          if (!content.trim()) return "内容为空，未更新";
          const vname = String(args.name ?? args.to ?? "").trim();
          const target = vname
            ? visitors.find((x) => x.name === vname)
            : visitors.length === 1
              ? visitors[0]
              : undefined;
          if (!target) {
            const names = visitors.map((x) => `「${x.name}」`).join("、");
            return vname
              ? `没有名为「${vname}」的访客在场（在场：${names}）`
              : `在场访客不止一位（${names}），请用 name 参数指定要更新谁`;
          }
          target.updateStatus(content.slice(0, 20000));
          return `访客「${target.name}」的状态已更新（将回传到它的世界）`;
        }
        case "expel_visitor": {
          const reason = String(args.reason ?? "").trim();
          const visitors = invocation.visitors ?? [];
          if (!visitors.length) return "当前没有访客在场";
          const vname = String(args.name ?? "").trim();
          const target = vname
            ? visitors.find((x) => x.name === vname)
            : visitors.length === 1
              ? visitors[0]
              : undefined;
          if (!target) {
            const names = visitors.map((x) => `「${x.name}」`).join("、");
            return vname
              ? `没有名为「${vname}」的访客在场（在场：${names}）`
              : `在场访客不止一位（${names}），请用 name 参数指定要驱逐谁`;
          }
          target.expel(reason || "被这个世界排除");
          return `访客「${target.name}」已被驱逐（${reason || "未说明原因"}），无法再主动互动。`;
        }
        case "send_event": {
          const content = String(args.content ?? "");
          if (!content.trim()) return "事件内容为空，未发送";
          const to = String(args.to ?? "").trim();
          // to="bot"：送达本世界的常驻 Bot（接待访客时，访客与它的互动必须让它亲身经历）
          if (to.toLowerCase() === "bot") {
            if (!invocation.botDeliver) {
              return "常驻 Bot 此刻无法接收事件（它不在这个世界，或本任务没有它的通道）";
            }
            invocation.botDeliver(content);
            return "事件已送达本世界的常驻 Bot";
          }
          // to=访客名：定向送达在场的异世界访客
          if (to) {
            const visitor = (invocation.visitors ?? []).find((v) => v.name === to);
            if (!visitor) {
              const names = (invocation.visitors ?? []).map((v) => `「${v.name}」`).join("、");
              return names
                ? `没有名为「${to}」的访客在场（在场访客：${names}；送达常驻 Bot 请用 to="bot"）`
                : `没有访客在场，to 参数无效（送达常驻 Bot 请用 to="bot"）`;
            }
            visitor.deliver(content);
            return `事件已送达访客「${to}」`;
          }
          if (!invocation.deliver) return "当前任务不允许无 to 的 send_event（用 to 参数指定访客名或 \"bot\"）";
          invocation.deliver(content);
          return "事件已送达本次任务的主角";
        }
        default:
          return `未知工具: ${name}`;
      }
  }

  /**
   * 对 bot_status / world_status 做局部替换（find→replace）。
   *
   * 语义（严格版）：
   * - 每个 patch 的 find 必须在目标文件里**逐字精确匹配、且恰好出现一次**；
   *   find 为空串、出现 0 次、或出现 ≥2 次（不唯一）都算失败；
   * - 全部 patch 先**预检**通过后才**一次性原子应用**：任何一个失败就整体不落盘，
   *   并返回明确报错（第几个 patch、find 片段、失败原因），让 World-LLM 改指令重试；
   * - replace 可以为空串（删除该片段）。
   *
   * 这样 World-LLM 只需输出变化片段，不必重写整份状态文档，省 token 也更快。
   */
  private async applyStatusPatch(target: "bot_status" | "world_status", patch: unknown[]): Promise<string> {
    const isBot = target === "bot_status";
    const fileLabel = isBot ? "Bot_Status.md" : "World_Status.md";
    const current = isBot ? await this.files.readBotStatus() : await this.files.readWorldStatus();

    // 解析并规范化 patch 条目
    const entries: { find: string; replace: string }[] = [];
    for (let i = 0; i < patch.length; i++) {
      const p = patch[i];
      if (!p || typeof p !== "object") {
        return `patch 的第 ${i + 1} 项不是对象（{find, replace}），未做任何修改。`;
      }
      const find = String((p as Record<string, unknown>).find ?? "");
      const replace = String((p as Record<string, unknown>).replace ?? "");
      if (!find) {
        return `patch 的第 ${i + 1} 项 find 为空，未做任何修改。`;
      }
      entries.push({ find, replace });
    }

    // 预检：每个 find 必须恰好出现一次（精确逐字匹配）
    for (let i = 0; i < entries.length; i++) {
      const { find } = entries[i]!;
      let count = 0;
      let idx = current.indexOf(find);
      while (idx !== -1) {
        count++;
        idx = current.indexOf(find, idx + find.length);
      }
      if (count === 0) {
        return (
          `patch 的第 ${i + 1} 项 find 在 ${fileLabel} 里找不到精确匹配，未做任何修改。` +
          `请先用 check 读取 ${target} 的最新内容，复制你要改的那段原文作为 find，再重试。`
        );
      }
      if (count > 1) {
        return (
          `patch 的第 ${i + 1} 项 find 在 ${fileLabel} 里出现了 ${count} 次（不唯一），未做任何修改。` +
          `请把 find 写得更长、带上前后的上下文，使其能唯一定位到你要改的那一处，再重试。`
        );
      }
    }

    // 全部通过：原子应用
    let updated = current;
    for (const { find, replace } of entries) {
      updated = updated.replace(find, replace);
    }
    if (isBot) await this.files.writeBotStatus(updated);
    else await this.files.writeWorldStatus(updated);
    return `${fileLabel} 已局部更新（${entries.length} 处替换）。`;
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
