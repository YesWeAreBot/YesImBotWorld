import { promises as fs } from "node:fs";
import path from "node:path";
import { Context, Service } from "koishi";
import { BotAgent } from "./bot/agent.js";
import { BotContext } from "./bot/context.js";
import { availableTools, renderToolsText } from "./bot/tools.js";
import { WorldClock } from "./clock.js";
import type { Config } from "./config.js";
import { WorldFiles } from "./files.js";
import { FocusManager } from "./koishi/focus.js";
import { Gateway } from "./koishi/gateway.js";
import { MessageStore } from "./koishi/messages.js";
import { KoishiMessenger } from "./koishi/messenger.js";
import { OwnSendTracker } from "./koishi/ownsends.js";
import { RequestStore } from "./koishi/requests.js";
import { CaptionService } from "./media/captioner.js";
import { createAttachmentLoader } from "./media/parts.js";
import { MediaRenderer } from "./media/render.js";
import { MediaStore } from "./media/store.js";
import { TtsClient } from "./media/tts.js";
import type { MediaType } from "./types.js";
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
  private requests!: RequestStore;
  private ownSends!: OwnSendTracker;
  private botContext: BotContext | null = null;
  private bot: BotAgent | null = null;
  private tingle: TingleTimer | null = null;
  private worldRunning = false;

  constructor(ctx: Context, config: Config) {
    super(ctx, "yesimbotWorld", true);
    this.config = config;

    this.store = new MessageStore(ctx);

    // 媒体管道：资产库 → 外挂解释器 → 渲染（原生附件 / 文本转述）
    const assetsDir = path.resolve(ctx.baseDir, config.basePath, "assets");
    this.media = new MediaStore(ctx, assetsDir, config.media.maxBytes, ctx.logger("yesimbot-world"));
    this.captioner = new CaptionService(config.captioners, config.media, this.media, ctx.logger("yesimbot-world"));
    const nativeSupport = (type: MediaType) =>
      config.bot.mode === "chat" && config.bot.modalities[type];
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

    // 平台请求登记处（好友申请 / 入群邀请等，Bot 用 handle_request 处理）
    this.requests = new RequestStore();
    // 本插件自身发送标记（区分外部以 Bot 账号发出的消息）
    this.ownSends = new OwnSendTracker();

    // 消息网关始终活跃：所有消息入库；通知事件仅在世界运行时投递
    new Gateway(ctx, config.messaging, config.platformOps, this.store, this.media, this.renderer, this.focus, this.requests, this.ownSends, {
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
    await this.stopWorld();
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
    }

    const { botDef, worldDef } = await this.files.readDefinitions();
    if (!botDef.trim() || botDef.includes(DEF_PLACEHOLDER)) {
      return `请先编写 Bot 角色定义：${this.files.botDef}`;
    }
    if (!worldDef.trim() || worldDef.includes(DEF_PLACEHOLDER)) {
      return `请先编写世界定义：${this.files.worldDef}`;
    }

    // 创世：世界时间归零，并把当前配置的世界初始时刻（epoch）持久化进 clock.json
    await this.clock.reset();

    this.logger.info("开始创世：调用 World-LLM 生成初始状态…");
    // 生成空的 News.db
    if (!(await this.files.exists(this.files.news))) await fs.writeFile(this.files.news, "");
    await this.world.initialize(botDef, worldDef);

    // 建立全新的 Bot 上下文（角色设定来自刚生成的 Bot_Status.md）
    await fs.writeFile(this.files.stream, "");
    const context = new BotContext(this.files, renderToolsText(this.currentTools()));
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

    // 实际可用的工具集（如未配置 TTS 则没有 send_voice；平台扩展操作按配置开关）
    const tools = this.currentTools();

    this.botContext = new BotContext(this.files, renderToolsText(tools));
    await this.botContext.load();
    if (!this.botContext.pinned.persona.trim()) {
      this.botContext.pinned.persona = await this.files.readBotStatus();
      await this.botContext.persistPinned();
    }
    // 原生多模态：附件 → content part
    if (this.config.bot.mode === "chat") {
      this.botContext.attachmentLoader = createAttachmentLoader(this.media, this.ctx.logger("yesimbot-world"));
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
      this.requests,
      this.ownSends,
    );
    this.bot = new BotAgent(
      this.config,
      this.clock,
      this.files,
      this.botContext,
      this.world,
      messenger,
      this.logger,
      tools.map((t) => t.name),
    );

    await this.clock.resume();

    // 恢复运行时告知 Bot（世界在暂停期间是静止的；未完成的动作已随暂停丢失）
    if (this.botContext.stream.length > 0) {
      this.bot.pushEvent(
        "system",
        `你回过神来——刚才似乎有一瞬间的失神（世界从暂停中恢复）。当前 ${this.clock.timeLine()}。进行中的动作可能已被打断，必要时重新确认状态。`,
      );
    } else {
      this.bot.pushEvent(
        "system",
        `你睁开眼睛，意识逐渐清晰。这是你有意识的第一刻。当前 ${this.clock.timeLine()}。不妨先 check_status 看看自己和这个世界。`,
      );
    }

    // 工具集与置顶列表不一致（配置变更/版本升级）：以事件告知，置顶列表在下次 rest 时才同步（保护前缀缓存）
    const toolsNotice = this.botContext.toolsChangeNotice();
    if (toolsNotice) this.bot.pushEvent("system", toolsNotice);

    this.bot.start();
    this.tingle = new TingleTimer(
      this.config.clock,
      this.world,
      (content) => this.bot?.pushEvent("world", content),
      this.logger,
    );
    this.tingle.start();
    this.worldRunning = true;
    this.logger.info("世界开始运转：%s", this.clock.timeLine());
    return `世界开始运转。当前 ${this.clock.timeLine()}`;
  }

  async stopWorld(): Promise<string> {
    if (!this.worldRunning) return "世界并未在运行。";
    this.worldRunning = false;
    this.tingle?.stop();
    this.tingle = null;
    await this.bot?.stop();
    this.bot = null;
    await this.clock.pause();
    this.logger.info("世界已暂停：%s", this.clock.timeLine());
    return `世界已暂停（时间静止于 ${this.clock.timeLine()}）。`;
  }

  async statusText(): Promise<string> {
    const initialized = await this.files.isInitialized();
    const lines = [
      `世界状态：${initialized ? (this.worldRunning ? "运行中" : "已暂停") : "未初始化"}`,
      `世界时钟：${this.clock.timeLine()}（1 TU = ${this.config.clock.realSecondsPerUnit} 现实秒 / ${this.config.clock.worldSecondsPerUnit} 世界秒）`,
      `数据目录：${this.files.base}`,
    ];
    if (this.bot) {
      const s = this.bot.status();
      lines.push(
        `Bot-LLM：${s.running ? "持续推理中" : "已停止"}（${this.config.bot.mode} 模式）`,
        `工作窗口：${s.streamLength} 条记录，约 ${s.approxChars} 字符（预算 ${this.config.bot.maxWindowChars}）`,
        `等待中：${s.waiting ?? "否"}；进行中的动作：${s.pendingTasks} 个；World-LLM 队列：${this.world.queueLength} 个`,
      );
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

  /** 当前配置下实际可用的 Bot 工具集 */
  private currentTools() {
    return availableTools({
      tts: this.config.tts.enabled,
      focus: this.config.messaging.focusDurationUnits > 0,
      ops: this.config.platformOps,
    });
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
      .action(async ({ options }) => {
        if (this.notReady()) return this.notReady()!;
        try {
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
      .action(async () => {
        if (this.notReady()) return this.notReady()!;
        if (!(await this.files.isInitialized())) return "世界尚未初始化。";
        const { botDef, worldDef } = await this.files.readDefinitions();
        await this.world.reconcileDefinitions(botDef, worldDef, (content) => {
          this.bot?.pushEvent("world", content);
        });
        return "定义已重新载入，世界状态已调整。";
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
        return "世界已重置。定义文件保留，可重新 world.init。";
      });
  }
}
