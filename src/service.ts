import { promises as fs } from "node:fs";
import path from "node:path";
import { Context, Service } from "koishi";
import { AppManager } from "./apps/manager.js";
import { McpApp } from "./apps/mcp.js";
import { WeatherApp } from "./apps/weather.js";
import { BotAgent } from "./bot/agent.js";
import { BotContext } from "./bot/context.js";
import { availableTools, renderToolsText, toolLayer, type AppInfo } from "./bot/tools.js";
import { describeCalendar } from "./calendar.js";
import { WorldClock } from "./clock.js";
import type { Config } from "./config.js";
import { WorldFiles } from "./files.js";
import { FocusManager } from "./koishi/focus.js";
import { Gateway } from "./koishi/gateway.js";
import { MessageStore } from "./koishi/messages.js";
import { KoishiMessenger } from "./koishi/messenger.js";
import { NotifyManager } from "./koishi/notify.js";
import { OwnSendTracker } from "./koishi/ownsends.js";
import { RequestStore } from "./koishi/requests.js";
import { CaptionService } from "./media/captioner.js";
import { createAttachmentLoader } from "./media/parts.js";
import { MediaRenderer, nativeSafeMime } from "./media/render.js";
import { MediaStore } from "./media/store.js";
import { TtsClient } from "./media/tts.js";
import type { MediaRef, PhoneStatus } from "./types.js";
import { WorldAgent } from "./world/agent.js";
import { TingleTimer } from "./world/tingle.js";

declare module "koishi" {
  interface Context {
    yesimbotWorld: WorldService;
  }
}

const DEF_PLACEHOLDER = "（尚未编写）";

export class WorldService extends Service<Config> {
  static readonly inject = ["database"];

  private files!: WorldFiles;
  private clock!: WorldClock;
  private store!: MessageStore;
  private media!: MediaStore;
  private captioner!: CaptionService;
  private renderer!: MediaRenderer;
  private world!: WorldAgent;
  private focus!: FocusManager;
  private notifyMgr!: NotifyManager;
  /** 手机物理状态（agent 与 gateway 共享）：down = Bot 把手机放到了一边 */
  private phoneStatus: PhoneStatus = { down: false };
  private requests!: RequestStore;
  private ownSends!: OwnSendTracker;
  private botContext: BotContext | null = null;
  private bot: BotAgent | null = null;
  private tingle: TingleTimer | null = null;
  private appManager: AppManager | null = null;
  private worldRunning = false;

  constructor(ctx: Context, config: Config) {
    super(ctx, "yesimbotWorld", true);
    this.config = config;

    this.store = new MessageStore(ctx);

    // 媒体管道：资产库 → 外挂解释器 → 渲染（原生附件 / 文本转述）
    const assetsDir = path.resolve(ctx.baseDir, config.basePath, "assets");
    this.media = new MediaStore(ctx, assetsDir, config.media.maxBytes, ctx.logger("yesimbot-world"));
    this.captioner = new CaptionService(config.captioners, config.media, this.media, ctx.logger("yesimbot-world"));
    // 原生附件门槛：chat 模式 + 声明了该模态 + 格式安全（GIF 等一律走解释器，避免 400）
    const nativeSupport = (ref: MediaRef) =>
      config.bot.mode === "chat" && config.bot.modalities[ref.type] && nativeSafeMime(ref);
    this.renderer = new MediaRenderer(
      this.media,
      this.captioner,
      nativeSupport,
      config.media.maxAttachmentsPerEvent,
    );

    // 关注频道管理：Bot 打开/发消息的频道在一段时间内无视通知策略，消息必定呈现内容
    this.focus = new FocusManager(
      path.resolve(ctx.baseDir, config.basePath, "focus.json"),
      () => (this.clock ? this.clock.now() : 0),
      config.messaging.focusDurationUnits,
    );

    // Allow Notification 频道列表（botManagedNotifyChannels 开启时由 Bot 自管、持久化）
    this.notifyMgr = new NotifyManager(
      path.resolve(ctx.baseDir, config.basePath, "notify.json"),
      config.messaging.notifyChannels,
      config.messaging.botManagedNotifyChannels,
    );

    // 平台请求登记处（好友申请 / 入群邀请等，Bot 用 handle_request 处理）
    this.requests = new RequestStore();
    // 本插件自身发送标记（区分外部以 Bot 账号发出的消息）
    this.ownSends = new OwnSendTracker();

    // 消息网关始终活跃：所有消息入库；通知事件仅在世界运行时投递
    new Gateway(ctx, config.messaging, config.platformOps, this.store, this.media, this.renderer, this.focus, this.notifyMgr, this.phoneStatus, this.requests, this.ownSends, {
      notify: (content, wake) => {
        if (this.worldRunning && this.bot) this.bot.pushEvent("koishi", content, { wake });
      },
      selfMessage: (key, content) => {
        if (!this.worldRunning || !this.bot) return;
        const mode = config.messaging.externalSelfMessages;
        if (mode === "simulate") {
          this.bot.simulateExternalSend(key, content);
        } else if (mode === "event") {
          this.bot.pushEvent(
            "koishi",
            `你注意到自己的账号在 ${key} 发出了一条消息——但那不是你发的（大概是手机里某个应用的自动回复）：${content}`,
          );
        }
      },
    });

    this.registerCommands(ctx);
  }

  override async start(): Promise<void> {
    const base = path.resolve(this.ctx.baseDir, this.config.basePath);
    this.files = new WorldFiles(base);
    await this.files.ensure();

    this.clock = new WorldClock(this.config.clock, this.files.clock);
    await this.clock.load();
    await this.focus.load();
    await this.notifyMgr.load();

    this.world = new WorldAgent(this.config.world, this.files, this.clock, this.logger);

    if (this.config.autoStart && (await this.files.isInitialized())) {
      try {
        await this.startWorld();
      } catch (err) {
        this.logger.warn("自动启动失败: %s", err);
      }
    }
  }

  override async stop(): Promise<void> {
    // 插件停止（进程退出/重载）≠ 用户暂停世界：世界时间在离线期间继续流逝
    await this.stopWorld({ suspend: true });
  }

  // ---------- 世界生命周期 ----------

  /** 初始化：读取用户定义，由 World-LLM 生成初始状态文件 */
  async initWorld(force = false): Promise<string> {
    if ((await this.files.isInitialized()) && !force) {
      return "世界已经初始化过了。如需重新创世，使用 world.init -f（会归档并清空当前世界状态）。";
    }
    if (this.worldRunning) await this.stopWorld();
    if (force) {
      await this.files.reset();
      await this.focus.clear();
      await this.notifyMgr.reset();
      this.phoneStatus.down = false;
    }

    const { botDef, worldDef } = await this.files.readDefinitions();
    if (!botDef.trim() || botDef.includes(DEF_PLACEHOLDER)) {
      return `请先编写 Bot 角色定义：${this.files.botDef}`;
    }
    if (!worldDef.trim() || worldDef.includes(DEF_PLACEHOLDER)) {
      return `请先编写世界定义：${this.files.worldDef}`;
    }

    // 创世 = 全新的开始：清空聊天消息记录（否则 Bot 仍能翻到"上辈子"的聊天历史）
    await this.store.clear();

    // 创世：世界时间归零；历法与初始时刻由 World-LLM 在初始化时依据定义生成并持久化
    await this.clock.reset();

    this.logger.info("开始创世：调用 World-LLM 生成初始状态…");
    // 生成空的 News.db
    if (!(await this.files.exists(this.files.news))) await fs.writeFile(this.files.news, "");
    await this.world.initialize(botDef, worldDef);

    // 建立全新的 Bot 上下文（角色设定来自刚生成的 Bot_Status.md）
    await fs.writeFile(this.files.stream, "");
    const context = new BotContext(this.files, this.pinnedToolsText());
    context.pinned.persona = await this.files.readBotStatus();
    await context.persistPinned();

    this.logger.info("创世完成");
    return `创世完成。\n- ${this.files.botStatus}\n- ${this.files.worldStatus}\n- ${this.files.news}\n使用 world.start 让世界开始运转。`;
  }

  async startWorld(): Promise<string> {
    if (this.worldRunning) return "世界已在运行中。";
    if (!(await this.files.isInitialized())) {
      return "世界尚未初始化。请先编写定义文件并执行 world.init。";
    }

    // 实际可用的工具集（如未配置 TTS 则没有 send_voice；平台扩展操作按配置开关）。
    // 置顶列表只放 core 层常驻工具；chat/channel/group 层在打开应用/进入频道时以事件展开
    const tools = this.currentTools();

    this.botContext = new BotContext(this.files, this.pinnedToolsText());
    // TU 换算锚点：Bot 估算 duration / wait 时长的依据（如「1 TU = 1 秒」）
    this.botContext.timeInfo =
      `1 TU = ${this.clock.unitWorldSeconds} 秒` +
      (this.clock.syncRealTime ? "（世界时间与现实同步）" : `（现实中 ${this.clock.unitRealSeconds} 秒）`);
    await this.botContext.load();
    if (!this.botContext.pinned.persona.trim()) {
      this.botContext.pinned.persona = await this.files.readBotStatus();
      await this.botContext.persistPinned();
    }
    // 原生多模态：附件 → content part。
    // 加载时按【当前】模态配置与格式白名单过滤：用户纠正配置后，历史事件里
    // 已不支持的附件（关掉的模态 / GIF 表情等）不再注入请求，避免持续 400。
    if (this.config.bot.mode === "chat") {
      const loader = createAttachmentLoader(this.media, this.ctx.logger("yesimbot-world"));
      const modalities = this.config.bot.modalities;
      this.botContext.attachmentLoader = async (ref) =>
        modalities[ref.type] && nativeSafeMime(ref) ? loader(ref) : null;
    }

    const messenger = new KoishiMessenger(
      this.ctx,
      this.store,
      this.renderer,
      this.media,
      this.captioner,
      this.files.galleryDir,
      this.config.tts.enabled ? new TtsClient(this.config.tts) : null,
      this.focus,
      this.config.platformOps,
      this.config.messaging,
      this.requests,
      this.ownSends,
    );
    // 手机应用（Apps / MCP）：内置天气 + 外接 MCP Server，open_app 打开后工具才展开
    const worldApps = [
      ...(this.config.apps.weatherEnabled
        ? [new WeatherApp(this.world, this.files, this.clock, this.config.apps, this.logger)]
        : []),
      ...this.config.apps.mcpServers
        .filter((s) => s.enabled && s.name.trim())
        .map((s) => new McpApp(s, this.logger)),
    ];
    this.appManager = new AppManager(
      this.config.apps.chatAppName,
      worldApps,
      new Set(tools.map((t) => t.name)),
      this.logger,
    );

    this.bot = new BotAgent(
      this.config,
      this.clock,
      this.files,
      this.botContext,
      this.world,
      messenger,
      this.appManager,
      this.notifyMgr,
      this.phoneStatus,
      this.logger,
      tools,
    );

    await this.clock.resume();

    // 唤醒 Bot：区分创世第一刻 / 离线恢复（时间照常流逝了）/ 暂停恢复（时间静止）
    const offline = this.clock.consumeOfflineGap();
    if (this.botContext.stream.length === 0) {
      this.bot.pushEvent(
        "system",
        `你睁开眼睛，意识逐渐清晰。这是你有意识的第一刻。当前 ${this.clock.timeLine()}。不妨先 check_status 看看自己和这个世界。`,
      );
    } else if (offline && offline.gapTU * this.clock.unitWorldSeconds >= 60) {
      // 离线超过 1 世界分钟才算"意识中断"（更短的间隙用下面的"一瞬间失神"）
      this.bot.pushEvent(
        "system",
        `你的意识中断了一段时间——从 ${this.clock.timeLine(offline.fromTU)} 到现在，` +
          `过去了约 ${offline.gapTU.toFixed(1)} 个 TU（当前 ${this.clock.timeLine()}）。` +
          `世界在此期间照常运转。进行中的动作可能已被打断，必要时重新确认状态。`,
      );
      // 离线足够久：由 World-LLM 补叙这段时间世界发生了什么（异步，走串行队列）
      const min = this.config.clock.offlineNarrateMinUnits;
      if (min > 0 && offline.gapTU >= min) {
        void this.world
          .resolveOfflineGap(offline.fromTU, (content) => this.bot?.pushEvent("world", content))
          .catch((err) => this.logger.warn("离线补叙失败: %s", err));
      }
    } else {
      this.bot.pushEvent(
        "system",
        `你回过神来——刚才似乎有一瞬间的失神。当前 ${this.clock.timeLine()}。进行中的动作可能已被打断，必要时重新确认状态。`,
      );
    }

    // 工具集与置顶列表不一致（配置变更/版本升级）：以事件告知，置顶列表在下次 rest 时才同步（保护前缀缓存）
    const toolsNotice = this.botContext.toolsChangeNotice();
    if (toolsNotice) this.bot.pushEvent("system", toolsNotice);

    this.bot.start();
    this.tingle = new TingleTimer(
      this.config.clock,
      this.clock,
      this.world,
      (content) => this.bot?.pushEvent("world", content),
      this.logger,
    );
    this.tingle.start();
    this.worldRunning = true;
    this.logger.info("世界开始运转：%s", this.clock.timeLine());
    return `世界开始运转。当前 ${this.clock.timeLine()}`;
  }

  async stopWorld(opts: { suspend?: boolean } = {}): Promise<string> {
    if (!this.worldRunning) return "世界并未在运行。";
    this.worldRunning = false;
    this.tingle?.stop();
    this.tingle = null;
    await this.bot?.stop();
    this.bot = null;
    await this.appManager?.closeAll().catch(() => {});
    this.appManager = null;
    if (opts.suspend) {
      // 插件停止：世界时间不冻结，离线期间继续按现实流速流逝
      await this.clock.suspend();
      this.logger.info("插件停止，世界时间将在离线期间继续流逝：%s", this.clock.timeLine());
      return `插件已停止（当前 ${this.clock.timeLine()}，世界时间将继续流逝）。`;
    }
    await this.clock.pause();
    if (this.clock.syncRealTime) {
      // 同步模式下时间无法冻结：只停下 Bot 与世界心跳
      this.logger.info("世界已暂停（时间与现实同步，继续流逝）：%s", this.clock.timeLine());
      return `世界已暂停（时间与现实保持同步、继续流逝；当前 ${this.clock.timeLine()}）。`;
    }
    this.logger.info("世界已暂停：%s", this.clock.timeLine());
    return `世界已暂停（时间静止于 ${this.clock.timeLine()}）。`;
  }

  async statusText(): Promise<string> {
    const initialized = await this.files.isInitialized();
    const stateText = !initialized
      ? "未初始化"
      : this.worldRunning
        ? "运行中"
        : this.clock.running
          ? "未运行（世界时间仍在流逝）"
          : "已暂停（时间静止）";
    const lines = [
      `世界状态：${stateText}`,
      `世界时钟：${this.clock.timeLine()}（1 TU = ${this.clock.unitRealSeconds} 现实秒 / ${this.clock.unitWorldSeconds} 世界秒）`,
      `世界历法：${this.clock.syncRealTime ? "与现实时间同步" : describeCalendar(this.clock.calendar)}`,
      `数据目录：${this.files.base}`,
    ];
    if (this.bot) {
      const s = this.bot.status();
      lines.push(
        `Bot-LLM：${s.running ? "持续推理中" : "已停止"}（${this.config.bot.mode} 模式）`,
        `工作窗口：${s.streamLength} 条记录，约 ${s.approxChars} 字符（预算 ${this.config.bot.maxWindowChars}）`,
        `等待中：${s.waiting ?? "否"}；进行中的动作：${s.pendingTasks} 个；World-LLM 队列：${this.world.queueLength} 个`,
      );
      const openApp = this.appManager?.currentName;
      if (openApp) lines.push(`手机里打开的应用：「${openApp}」`);
      if (this.phoneStatus.down) lines.push("手机被 Bot 放在一边（通知已降级为震动）");
      if (this.config.messaging.botManagedNotifyChannels) {
        lines.push(`通知频道（Bot 自管）：${this.notifyMgr.statusText()}`);
      }
    }
    const focused = this.focus.activeKeys();
    if (focused.length) {
      lines.push(`Bot 正在关注的频道：${focused.join("、")}`);
    }
    const news = await this.files.readNews(3);
    if (news.length) {
      lines.push("最近的世界事件：", ...news.map((e) => `- [${e.clock}] ${e.content}`));
    }
    return lines.join("\n");
  }

  /** 当前配置下实际可用的 Bot 工具集（全部层级） */
  private currentTools() {
    return availableTools({
      tts: this.config.tts.enabled,
      ops: this.config.platformOps,
      apps: this.appInfos(),
      notifyManaged: this.config.messaging.botManagedNotifyChannels,
    });
  }

  /** 置顶工具列表文本：仅 core 层常驻工具（其余层按需以事件展开，节省上下文） */
  private pinnedToolsText(): string {
    return renderToolsText(this.currentTools().filter((t) => toolLayer(t.name) === "core"));
  }

  /** 手机里已安装的应用列表（聊天平台在前） */
  private appInfos(): AppInfo[] {
    const list: AppInfo[] = [
      { name: this.config.apps.chatAppName, description: "聊天，打开即看到最近的消息" },
    ];
    if (this.config.apps.weatherEnabled) {
      list.push({ name: "天气", description: "查询当前天气与未来几天的预报" });
    }
    for (const s of this.config.apps.mcpServers) {
      if (s.enabled && s.name.trim()) list.push({ name: s.name.trim(), description: s.description || "外部应用" });
    }
    return list;
  }

  // ---------- 命令 ----------

  /** start() 完成前命令不可用 */
  private notReady(): string | null {
    return this.files && this.clock && this.world ? null : "插件尚未就绪，请稍候。";
  }

  private registerCommands(ctx: Context): void {
    // 注意：koishi 校验整条父链的权限，父指令必须保持低权限，
    // 管控在各子指令上单独声明（.status 对普通用户开放）
    const cmd = ctx.command("world", "YesImBot World 虚拟世界");

    cmd
      .subcommand(".init", "初始化（创世）：由 World-LLM 根据定义生成初始状态", { authority: 3 })
      .option("force", "-f 强制重新创世（归档并清空当前世界）")
      .action(async ({ session, options }) => {
        if (this.notReady()) return this.notReady()!;
        try {
          // 创世要跑多次 World-LLM 调用，耗时可能数分钟：先给出即时反馈
          if ((await this.files.isInitialized()) ? !!options?.force : true) {
            await session?.send("开始创世：World-LLM 正在依据定义生成世界（判定世界性质、历法与初始状态），可能需要几分钟，请稍候……");
          }
          return await this.initWorld(!!options?.force);
        } catch (err) {
          return `创世失败：${(err as Error).message ?? err}`;
        }
      });

    cmd.subcommand(".start", "让世界开始/恢复运转", { authority: 3 }).action(async () => {
      if (this.notReady()) return this.notReady()!;
      try {
        return await this.startWorld();
      } catch (err) {
        return `启动失败：${(err as Error).message ?? err}`;
      }
    });

    cmd.subcommand(".stop", "暂停世界（时间静止）", { authority: 3 }).action(async () => {
      if (this.notReady()) return this.notReady()!;
      return this.stopWorld();
    });

    cmd.subcommand(".status", "查看世界与 Bot 的运行状态", { authority: 1 }).action(async () => {
      if (this.notReady()) return this.notReady()!;
      return this.statusText();
    });

    cmd
      .subcommand(".reload", "用户修改定义文件后：让世界调整状态并（以世界观内方式）告知 Bot", { authority: 3 })
      .action(async ({ session }) => {
        if (this.notReady()) return this.notReady()!;
        if (!(await this.files.isInitialized())) return "世界尚未初始化。";
        await session?.send("正在重载定义：World-LLM 正在调整世界状态，请稍候……");
        const { botDef, worldDef } = await this.files.readDefinitions();
        await this.world.reconcileDefinitions(botDef, worldDef, (content) => {
          this.bot?.pushEvent("world", content);
        });
        return "定义已重新载入，世界状态已调整。";
      });

    cmd
      .subcommand(".clearmsg", "清空 Bot 的聊天消息记录（不影响世界状态与定义）", { authority: 4 })
      .action(async () => {
        if (this.notReady()) return this.notReady()!;
        await this.store.clear();
        return "聊天消息记录已清空（媒体缓存与世界状态不受影响）。";
      });

    cmd
      .subcommand(".inject <text:text>", "以系统事件形式向 Bot 的意识流注入一条内容（调试用）", { authority: 3 })
      .action(async (_, text) => {
        if (!this.worldRunning || !this.bot) return "世界未在运行。";
        if (!text?.trim()) return "内容不能为空。";
        this.bot.pushEvent("system", text.trim(), { wake: true });
        return "已注入。";
      });

    cmd
      .subcommand(".reset", "重置世界：归档并清空全部运行时状态（保留定义文件）", { authority: 4 })
      .action(async () => {
        if (this.notReady()) return this.notReady()!;
        await this.stopWorld();
        await this.files.reset();
        await this.clock.reset();
        await this.focus.clear();
        await this.notifyMgr.reset();
        this.phoneStatus.down = false;
        return "世界已重置。定义文件保留，可重新 world.init。";
      });
  }
}
