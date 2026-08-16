import { promises as fs } from "node:fs";
import path from "node:path";
import { Context, Service } from "koishi";
import { AppManager } from "./apps/manager.js";
import { BrowserApp } from "./apps/browser.js";
import { ComputerDevice } from "./apps/computerDevice.js";
import { FileManagerApp } from "./apps/files.js";
import { McpApp } from "./apps/mcp.js";
import { NotesApp } from "./apps/notes.js";
import { RemoteDesktopApp } from "./apps/remoteDesktop.js";
import { TerminalApp } from "./apps/terminal.js";
import { WeatherApp } from "./apps/weather.js";
import { BotAgent } from "./bot/agent.js";
import { BotContext } from "./bot/context.js";
import { availableTools, renderToolsText, toolLayer, type AppInfo } from "./bot/tools.js";
import { describeCalendar } from "./calendar.js";
import { WorldClock } from "./clock.js";
import { BotComputer } from "./computer.js";
import { Config, needsMsgIds, type ModalitySupport } from "./config.js";
import { CrossingClient } from "./crossing/client.js";
import { CrossingServer } from "./crossing/server.js";
import { WorldFiles } from "./files.js";
import { resolvePhoneResolution } from "./phone.js";
import { Prompts, type PromptOverrides } from "./prompts.js";
import { WebUIServer, type BotStatusSummary, type DevicesInfo, type NoteEntry, type WebUIHost } from "./webui/server.js";
import { FocusManager } from "./koishi/focus.js";
import { Gateway } from "./koishi/gateway.js";
import { MessageStore } from "./koishi/messages.js";
import { KoishiMessenger } from "./koishi/messenger.js";
import { ChannelNameResolver } from "./koishi/names.js";
import { NotifyManager } from "./koishi/notify.js";
import { OwnSendTracker } from "./koishi/ownsends.js";
import { RequestStore } from "./koishi/requests.js";
import { setEndpointLockEnabled } from "./llm/lock.js";
import { CaptionService } from "./media/captioner.js";
import { GalleryStore } from "./media/gallery.js";
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
/** WebUI 展示用版本号（与 package.json 保持一致） */
const WEBUI_VERSION = "0.1.0";

export class WorldService extends Service<Config> {
  // puppeteer 可选：未安装时浏览器 App 不提供截图（其余功能照常），安装后无需改动即可用
  static readonly inject = {
    database: { required: true },
    puppeteer: { required: false },
  };

  files!: WorldFiles;
  private clock!: WorldClock;
  private store!: MessageStore;
  private names!: ChannelNameResolver;
  media!: MediaStore;
  private captioner!: CaptionService;
  gallery!: GalleryStore;
  private renderer!: MediaRenderer;
  private world!: WorldAgent;
  private focus!: FocusManager;
  private notifyMgr!: NotifyManager;
  /** 手机物理状态（agent 与 gateway 共享）：down = Bot 把手机放到了一边 */
  private phoneStatus: PhoneStatus = { down: false };
  /**
   * 会话级"有效模态"：以配置为初始值，运行时可降级（服务端 400 拒收 video_url/input_audio 时
   * 只关对应模态，GIF 改走拼帧图）。渲染器与附件加载器共用此对象（原地修改，勿整体替换）。
   */
  private effectiveModalities: ModalitySupport = { image: false, audio: false, video: false };
  private requests!: RequestStore;
  private ownSends!: OwnSendTracker;
  private botContext: BotContext | null = null;
  private bot: BotAgent | null = null;
  private tingle: TingleTimer | null = null;
  private appManager: AppManager | null = null;
  /** Bot 的个人电脑（Docker 容器）：终端与资源管理器共用 */
  private computer: BotComputer | null = null;
  /** Bot 的个人电脑设备（与手机平级的设备）：open_computer 打开 */
  private computerDevice: ComputerDevice | null = null;
  /** 远程桌面实现（remote_desktop 模式）：WebUI 窥屏直接用它 peek */
  private remoteDesktopApp: RemoteDesktopApp | null = null;
  private worldActive = false;
  /** 提示词容器：默认值 + WebUI 覆盖（覆盖持久化于 <basePath>/webui/prompts.json） */
  private promptStore!: Prompts;
  webuiDir!: string;
  private webui: WebUIServer | null = null;
  /** 穿越：接待异世界访客的服务（crossing.serverEnabled） */
  private crossingServer: CrossingServer | null = null;
  /** 穿越：Bot 当前所在的异世界连接（null = 在自己的世界） */
  private crossingClient: CrossingClient | null = null;
  private crossingLocation: string | null = null;

  constructor(ctx: Context, config: Config) {
    super(ctx, "yesimbotWorld", true);
    this.config = config;

    this.webuiDir = path.resolve(ctx.baseDir, config.basePath, "webui");
    this.promptStore = new Prompts();

    // 同源推理端点互斥开关：并发下会饿死请求/崩溃的后端保持开启；能真正并发的后端可关闭
    setEndpointLockEnabled(config.serializeSameEndpoint);

    this.store = new MessageStore(ctx);
    // 频道显示名解析（私聊对方昵称 / 群名），供通知事件与消息列表使用
    this.names = new ChannelNameResolver(ctx, this.store);

    // 媒体管道：资产库 → 外挂解释器 → 渲染（原生附件 / 文本转述）
    const assetsDir = path.resolve(ctx.baseDir, config.basePath, "assets");
    this.media = new MediaStore(ctx, assetsDir, config.media.maxBytes, ctx.logger("yesimbot-world"));
    this.captioner = new CaptionService(config.captioners, config.media, this.media, ctx.logger("yesimbot-world"));
    // 收藏夹：分类子目录（表情包/meme/截图/照片/未整理）+ 描述元数据表
    this.gallery = new GalleryStore(ctx, path.resolve(ctx.baseDir, config.basePath, "gallery"));
    // 原生附件门槛：chat 模式 + 声明了该模态 + 格式安全。
    // 模态读会话级 effectiveModalities（可运行时降级）；GIF 特殊：
    // 支持视频 → 走视频通道；仅支持图像 → 抽帧拼图（loader 内完成）
    Object.assign(this.effectiveModalities, config.bot.modalities);
    const isGif = (ref: MediaRef) => ref.type === "image" && ref.mime === "image/gif";
    const nativeSupport = (ref: MediaRef) => {
      if (config.bot.mode !== "chat" || !nativeSafeMime(ref)) return false;
      if (isGif(ref)) return this.effectiveModalities.video || this.effectiveModalities.image;
      return this.effectiveModalities[ref.type];
    };
    this.renderer = new MediaRenderer(
      this.media,
      this.captioner,
      nativeSupport,
      config.media.maxAttachmentsPerEvent,
      (ref) => {
        if (!isGif(ref)) return "（见附件）";
        return this.effectiveModalities.video
          ? "（GIF 动图，见附件）"
          : "（GIF 动图，附件为其逐帧拼图，按行从左到右为播放顺序）";
      },
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
    new Gateway(ctx, config.messaging, config.platformOps, this.store, this.media, this.renderer, this.focus, this.notifyMgr, this.phoneStatus, this.requests, this.ownSends, this.names, () => this.clock ?? null, {
      notify: (content, wake) => {
        if (this.worldActive && this.bot) this.bot.pushEvent("koishi", content, { wake });
      },
      selfMessage: (key, content, msgId) => {
        if (!this.worldActive || !this.bot) return;
        // 自己的账号发出了消息：无论何种呈现模式，先打断对该频道的延期发送意图
        this.bot.noteDeferredSelfSent(key);
        const mode = config.messaging.externalSelfMessages;
        if (mode === "simulate") {
          this.bot.simulateExternalSend(key, content, msgId);
        } else if (mode === "event") {
          void this.names.display(key).then((display) => {
            const msgTag = msgId && needsMsgIds(config.platformOps) ? `(msg:${msgId}) ` : "";
            this.bot?.pushEvent(
              "koishi",
              `你注意到自己的账号在 ${display} 发出了一条消息——但那不是你发的（大概是手机里某个应用的自动回复）：${msgTag}${content}`,
            );
          });
        }
      },
      channelActivity: (key) => {
        if (this.worldActive && this.bot) this.bot.noteDeferredChannelActivity(key);
      },
    });

    this.registerCommands(ctx);
  }

  override async start(): Promise<void> {
    const base = path.resolve(this.ctx.baseDir, this.config.basePath);
    this.files = new WorldFiles(base);
    await this.files.ensure();
    // 建好收藏夹分类目录（用户可直接把图丢进「未整理」，散落在根目录的文件也会被自动清扫进去）
    await this.gallery.ensureDirs();

    this.clock = new WorldClock(this.config.clock, this.files.clock);
    await this.clock.load();
    await this.focus.load();
    await this.notifyMgr.load();

    // WebUI 覆盖的提示词：Bot 与 World 的默认模板即时套用（无需重启）
    this.promptStore = await Prompts.load(this.webuiDir);
    this.world = new WorldAgent(this.config.world, this.files, this.clock, this.logger, this.promptStore, {
      resolution: this.config.apps.phoneResolution,
      generateShell: this.config.apps.browserEnabled,
    });
    this.world.visitorPersonaMode = this.config.crossing.visitorPersonaMode;

    // 先启动 WebUI（初始化 usageStore 并确保 webui 目录存在），再自动恢复世界运行。
    // 否则 autoStart 时 Bot 会先发出 LLM 请求，而 usageStore 尚未 init / 目录未建，
    // 这些用量既写不进文件、也加载不到历史，导致重启后数据不连贯。
    if (this.config.webui.enabled) {
      try {
        await this.startWebUI();
      } catch (err) {
        this.logger.warn("WebUI 启动失败: %s", err);
      }
    }

    if (this.config.autoStart && (await this.files.isInitialized())) {
      try {
        await this.startWorld();
      } catch (err) {
        this.logger.warn("自动启动失败: %s", err);
      }
    }

    if (this.config.crossing.serverEnabled) {
      try {
        this.crossingServer = new CrossingServer({
          cfg: this.config.crossing,
          logger: this.logger,
          world: this.world,
          clock: () => this.clock ?? null,
          ready: () => this.worldActive && !!this.bot,
          notifyHostBot: (content) => this.bot?.pushEvent("world", content),
        });
        await this.crossingServer.start();
        this.logger.info(
          "穿越服务已启动：%s:%d（邀请码 %d 个）",
          this.config.crossing.host,
          this.config.crossing.port,
          this.config.crossing.invites.filter((i) => i.enabled && i.code).length,
        );
      } catch (err) {
        this.crossingServer = null;
        this.logger.warn("穿越服务启动失败: %s", err);
      }
    }
  }

  override async stop(): Promise<void> {
    await this.webui?.stop().catch(() => {});
    this.webui = null;
    await this.crossingServer?.stop().catch(() => {});
    this.crossingServer = null;
    // 插件停止时若 Bot 在异世界：礼貌地离开（穿越状态不跨重启，重启后回到自己的世界）
    if (this.crossingClient) {
      const client = this.crossingClient;
      this.crossingClient = null;
      this.crossingLocation = null;
      this.world?.setRemote(null);
      await client.leave().catch(() => {});
    }
    // 插件停止（进程退出/重载）≠ 用户暂停世界：世界时间在离线期间继续流逝
    await this.stopWorld({ suspend: true });
  }

  // ---------- 世界生命周期 ----------

  /** 初始化：读取用户定义，由 World-LLM 生成初始状态文件 */
  async initWorld(force = false): Promise<string> {
    if ((await this.files.isInitialized()) && !force) {
      return "世界已经初始化过了。如需重新创世，使用 world.init -f（会归档并清空当前世界状态）。";
    }
    if (this.worldActive) await this.stopWorld();
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
    // 生成空的 News.db 与 facts.jsonl
    if (!(await this.files.exists(this.files.news))) await fs.writeFile(this.files.news, "");
    if (!(await this.files.exists(this.files.facts))) await fs.writeFile(this.files.facts, "");
    await this.world.initialize(botDef, worldDef);

    // 建立全新的 Bot 上下文（角色设定来自刚生成的 Bot_Status.md；
    // 「最初设定」= Bot_Definition.md 原文，此后只在压缩时随定义文件刷新）
    await fs.writeFile(this.files.stream, "");
    const context = new BotContext(this.files, this.pinnedToolsText(), this.promptStore);
    context.pinned.botDefinition = botDef;
    context.pinned.persona = await this.files.readBotStatus();
    await context.persistPinned();

    this.logger.info("创世完成");
    return `创世完成。\n- ${this.files.botStatus}\n- ${this.files.worldStatus}\n- ${this.files.news}\n- ${this.files.facts}\n使用 world.start 让世界开始运转。`;
  }

  async startWorld(): Promise<string> {
    if (this.worldActive) return "世界已在运行中。";
    if (!(await this.files.isInitialized())) {
      return "世界尚未初始化。请先编写定义文件并执行 world.init。";
    }

    // 实际可用的工具集（如未配置 TTS 则没有 send_voice；平台扩展操作按配置开关）。
    // 置顶列表只放 core 层常驻工具；chat/channel/group 层在打开应用/进入频道时以事件展开
    const tools = this.currentTools();

    this.botContext = new BotContext(this.files, this.pinnedToolsText(), this.promptStore);
    // 工具原生声明（仅 chat 模式）：行为准则里的输出格式段随之切换
    this.botContext.nativeToolCalls = this.config.bot.mode === "chat" && this.config.bot.nativeToolCalls;
    // wait 被移除时，行为准则与时间说明不再提及等待
    this.botContext.waitRemoved = this.config.bot.disableWait;
    // 聊天账号列表：Bot 识别 <at id/>、引用等结构里的"自己"的依据。
    // 惰性取值：autoStart 时适配器可能尚未连接，连上后自然出现（仅 id，保持前缀稳定）
    this.botContext.accountsProvider = () => {
      const ids = [...new Set(this.ctx.bots.filter((b) => b.selfId).map((b) => `${b.platform}:${b.selfId}`))];
      return ids.sort().join("、");
    };
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
      // 新会话：有效模态从配置重置（上次会话的运行时降级不跨会话生效）
      Object.assign(this.effectiveModalities, this.config.bot.modalities);
      const modalities = this.effectiveModalities;
      const loader = createAttachmentLoader(this.media, modalities, this.ctx.logger("yesimbot-world"));
      const allowed = (ref: MediaRef) =>
        ref.type === "image" && ref.mime === "image/gif"
          ? modalities.video || modalities.image
          : modalities[ref.type];
      this.botContext.attachmentLoader = async (ref) =>
        allowed(ref) && nativeSafeMime(ref) ? loader(ref) : null;
      // 运行时降级：服务端 400 拒收 video_url / input_audio 时只关对应模态，
      // 附件缓存重建（GIF 从 video_url 改为拼帧图的 image_url）
      this.botContext.degradeModalities = (kinds) => {
        for (const k of kinds) modalities[k] = false;
        loader.clearCache();
      };
      // 每次请求的附件总预算（数量 + 体积）：历史附件每次请求都会重发，不设预算会撑爆请求体（413）
      this.botContext.maxAttachmentsPerRequest = this.config.media.maxAttachmentsPerRequest;
      this.botContext.maxAttachmentBytesPerRequest = Math.max(
        1,
        Math.round(this.config.media.maxAttachmentMbPerRequest * 1024 * 1024),
      );
    }

    const messenger = new KoishiMessenger(
      this.ctx,
      this.store,
      this.renderer,
      this.media,
      this.captioner,
      this.gallery,
      this.config.tts.enabled ? new TtsClient(this.config.tts) : null,
      this.focus,
      this.notifyMgr,
      this.config.platformOps,
      this.config.messaging,
      this.requests,
      this.ownSends,
      this.names,
      () => this.clock ?? null,
    );
    // Bot 的个人电脑：与手机平级的设备。实现方式由 apps.computer.mode 选择——
    // docker（容器，终端/资源管理器）或 remote_desktop（VNC，屏幕/鼠标/键盘，需图片多模态）；
    // 仅现实世界以真实实现生效，虚构世界由 World-LLM 扮演这台电脑
    this.computer = new BotComputer(this.config.apps.computer, this.logger);
    const terminalApp = new TerminalApp(this.computer, this.world, this.files, this.clock, this.config.apps, this.logger);
    const filesApp = this.config.apps.filesEnabled
      ? new FileManagerApp(this.computer, this.world, this.files, this.clock, this.config.apps, this.logger)
      : null;
    const remoteDesktopApp =
      this.config.apps.computer.mode === "remote_desktop" && this.config.bot.modalities.image
        ? new RemoteDesktopApp(this.config.apps.computer.remoteDesktop, this.media, this.logger)
        : null;
    this.remoteDesktopApp = remoteDesktopApp;
    this.computerDevice = new ComputerDevice(
      terminalApp,
      filesApp,
      remoteDesktopApp,
      this.computer,
      this.files,
      this.clock,
      this.config.apps.computer,
      new Set(tools.map((t) => t.name)),
      this.logger,
    );
    // 手机应用（Apps / MCP）：内置天气/浏览器 + 外接 MCP Server（电脑不在手机里，是平级的另一台设备）
    const worldApps = [
      ...(this.config.apps.weatherEnabled
        ? [new WeatherApp(this.world, this.files, this.clock, this.config.apps, this.logger)]
        : []),
      ...(this.config.apps.notesEnabled ? [new NotesApp(this.files, this.clock, this.logger)] : []),
      ...(this.config.apps.browserEnabled
        ? [
            new BrowserApp(
              this.ctx,
              this.world,
              this.files,
              this.clock,
              this.media,
              this.gallery,
              this.captioner,
              (ref) => this.renderer.canAttach(ref),
              this.config.apps,
              this.logger,
            ),
          ]
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
      this.computerDevice,
      this.notifyMgr,
      this.phoneStatus,
      this.logger,
      tools,
      this.config.crossing.worlds.some((w) => w.name.trim() && w.url.trim())
        ? {
            location: () => this.crossingLocation,
            voluntaryWorlds: () =>
              this.config.crossing.worlds
                .filter((w) => w.allowVoluntary && w.name.trim() && w.url.trim())
                .map((w) => w.name.trim()),
            travelTo: (name) => this.crossingTravelTo(name),
            goHome: () => this.crossingGoHome(),
          }
        : null,
    );

    await this.clock.resume();

    // 上次运行时 Bot 还在异世界（进程崩溃/重启）：告知它已被拉回自己的世界
    if (await this.consumeCrossingMarker()) {
      this.bot.pushEvent(
        "system",
        "（你恍惚记得自己此前身在另一个世界——离线期间与那个世界的连接已经断开，你回到了自己的世界。）",
      );
    }

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

    // 常驻 Bot 的实时事件通道：接待访客时，World-LLM 用 send_event to="bot" 把
    // 访客与 Bot 的互动送达 Bot 本人（wake：有人当面互动应唤醒等待中的 Bot）
    this.world.setHostBotDeliver((content) => this.bot?.pushEvent("world", content, { wake: true }));

    this.bot.start();
    this.tingle = new TingleTimer(
      this.config.clock,
      this.clock,
      this.world,
      (content) => this.bot?.pushEvent("world", content),
      this.logger,
    );
    this.tingle.start();
    this.worldActive = true;

    // 离线历史补拉：把插件离线期间（Bot 掉线/世界未启动）错过的目标群消息写进消息记录，
    // 不注入逐条事件打扰上下文；完成后若确实补到了，推一条汇总事件让 Bot 知道去翻记录
    if (this.config.messaging.offlineHistory) {
      void messenger
        .syncOfflineHistory()
        .then(async ({ total, channels }) => {
          if (!total || !this.bot) return;
          const shown = channels.slice(0, 5);
          const labels = await Promise.all(shown.map((c) => this.names.display(c.key)));
          const namesText =
            labels.join("、") + (channels.length > shown.length ? ` 等 ${channels.length} 个群` : "");
          this.bot.pushEvent(
            "system",
            `离线期间你在 ${namesText} 错过的 ${total} 条消息已补录到聊天记录里（用 check_msg / select_channel 翻看）。`,
          );
        })
        .catch((err) => this.logger.warn("离线历史补拉失败: %s", err));
    }

    this.logger.info("世界开始运转：%s", this.clock.timeLine());
    return `世界开始运转。当前 ${this.clock.timeLine()}`;
  }

  async stopWorld(opts: { suspend?: boolean } = {}): Promise<string> {
    if (!this.worldActive) return "世界并未在运行。";
    this.worldActive = false;
    // Bot 还在异世界：礼貌地离开。标记文件保留——下次启动时向 Bot 解释"你回到了自己的世界"
    if (this.crossingClient) {
      const client = this.crossingClient;
      this.crossingClient = null;
      this.crossingLocation = null;
      this.world.setRemote(null);
      void client.leave().catch(() => {});
    }
    this.world.setHostBotDeliver(null);
    this.tingle?.stop();
    this.tingle = null;
    await this.bot?.stop();
    this.bot = null;
    await this.appManager?.closeAll().catch(() => {});
    this.appManager = null;
    // 关闭电脑设备（断开远程桌面等连接）并关机：本插件自建的容器一并关闭（下次打开电脑时自动再开机）
    await this.computerDevice?.close().catch(() => {});
    this.computerDevice = null;
    this.remoteDesktopApp = null;
    await this.computer?.shutdown().catch(() => {});
    this.computer = null;
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

  // ---------- 穿越（联机） ----------

  /** Bot 当前所在的异世界名（null = 在自己的世界） */
  get crossingWhere(): string | null {
    return this.crossingLocation;
  }

  /** 在场的异世界访客列表（穿越服务未启用时为空） */
  crossingVisitors(): { name: string; arrivedAt: number }[] {
    return this.crossingServer?.visitorList() ?? [];
  }

  /** 穿越到指定世界；返回给 Bot / 用户的叙述文本，失败抛错 */
  async crossingTravelTo(name: string): Promise<string> {
    if (!this.worldActive || !this.bot) throw new Error("世界未在运行");
    const target = this.config.crossing.worlds.find((w) => w.name.trim() === name.trim());
    if (!target || !target.url.trim()) throw new Error(`没有配置名为「${name}」的世界`);
    if (!target.inviteCode.trim()) throw new Error(`世界「${name}」缺少邀请码`);
    // 已在别的世界：先离开（允许直接跳跃）
    if (this.crossingClient) {
      const prev = this.crossingClient;
      this.crossingClient = null;
      this.crossingLocation = null;
      this.world.setRemote(null);
      void prev.leave().catch(() => {});
    }
    const profile = await this.crossingProfile();
    const client = new CrossingClient(target, profile, {
      // 主世界推来的事件都是冲着这位访客来的（到达场景 / to= 定向）：唤醒等待中的 Bot
      onEvent: (content) => this.bot?.pushEvent("world", content, { wake: true }),
      // 所在世界的 World-LLM 更新了 Bot 的状态：写回本地 Bot_Status.md
      //（与本地 World-LLM update(bot_status) 的行为对齐——静默落盘，置顶区在下次 rest 时同步）
      onStatusUpdate: (content) => {
        void this.files
          .writeBotStatus(content)
          .then(() => this.logger.info("[穿越] 所在世界更新了 Bot_Status.md（%d 字符）", content.length))
          .catch((err) => this.logger.warn("[穿越] 写回 Bot_Status 失败: %s", err));
      },
      onLost: (reason) => this.crossingLost(client, reason),
      logger: this.logger,
    });
    const info = await client.arrive();
    this.crossingClient = client;
    this.crossingLocation = info.worldName || target.name.trim();
    this.world.setRemote(client);
    await this.writeCrossingMarker(this.crossingLocation);
    this.logger.info("[穿越] Bot 前往异世界「%s」（%s）", this.crossingLocation, target.url);
    return (
      `一阵天旋地转——你穿越到了异世界「${this.crossingLocation}」` +
      `${info.timeLine ? `（当地 ${info.timeLine}）` : ""}。` +
      `在这里，你的行动由这个世界裁定；你自己的世界会静静等你回来。用 go_home 可随时返回。`
    );
  }

  /** 返回自己的世界；返回给 Bot / 用户的叙述文本 */
  async crossingGoHome(): Promise<string> {
    const client = this.crossingClient;
    const from = this.crossingLocation;
    if (!client) return "（你就在自己的世界里。）";
    this.crossingClient = null;
    this.crossingLocation = null;
    this.world.setRemote(null);
    await this.clearCrossingMarker();
    void client.leave().catch(() => {});
    this.logger.info("[穿越] Bot 从「%s」返回自己的世界", from);
    // 世界若沉睡（外出期间无访客）：补叙沉睡期间的演化，"归来所见"随后送达 Bot
    const dormant = this.world.isDormant;
    void this.world
      .wakeDormant((content) => this.bot?.pushEvent("world", content))
      .catch((err) => this.logger.warn("[穿越] 归来补叙失败: %s", err));
    return (
      `你离开了「${from}」，回到自己的世界。当前 ${this.clock.timeLine()}。` +
      (dormant ? "离开的这段时间里，这个世界也在按自己的节奏运转着。" : "")
    );
  }

  /** 与异世界的连接不可恢复地断开：把 Bot"弹回"自己的世界 */
  private crossingLost(client: CrossingClient, reason: string): void {
    if (this.crossingClient !== client) return; // 已经离开/换了世界
    const from = this.crossingLocation;
    this.crossingClient = null;
    this.crossingLocation = null;
    this.world.setRemote(null);
    void this.clearCrossingMarker();
    this.logger.warn("[穿越] 与异世界「%s」的连接丢失：%s", from, reason);
    this.bot?.pushEvent(
      "system",
      `与异世界「${from}」的连接突然断开（${reason}）——一阵失重感袭来，你被弹回了自己的世界。当前 ${this.clock.timeLine()}。`,
      { wake: true },
    );
    // 世界若沉睡（外出期间无访客）：补叙沉睡期间的演化
    void this.world
      .wakeDormant((content) => this.bot?.pushEvent("world", content))
      .catch((err) => this.logger.warn("[穿越] 归来补叙失败: %s", err));
  }

  /** 强制穿越（指令 / WebUI）：由用户指定送往某个世界或送回家，Bot 会以"不可抗拒的力量"感知 */
  async crossingForce(target: string): Promise<string> {
    if (!this.worldActive || !this.bot) return "世界未在运行（先 world.start）。";
    if (target === "home" || target === "回家") {
      if (!this.crossingLocation) return "Bot 就在自己的世界里。";
      const msg = await this.crossingGoHome();
      this.bot.pushEvent("system", `（一股不属于所在世界的力量把你拽了回去。）${msg}`, { wake: true });
      return "已把 Bot 送回自己的世界。";
    }
    try {
      const msg = await this.crossingTravelTo(target);
      // 强制穿越：Bot 需要知道这不是它自己的决定
      this.bot.pushEvent("system", `（一股不可抗拒的力量将你卷起——）${msg}`, { wake: true });
      return `已把 Bot 送往「${this.crossingLocation}」。`;
    } catch (err) {
      return `穿越失败：${(err as Error).message ?? err}`;
    }
  }

  /** WebUI：穿越面板信息 */
  crossingInfo(): {
    location: string | null;
    serverEnabled: boolean;
    visitors: { name: string; arrivedAt: number }[];
    worlds: { name: string; allowVoluntary: boolean; note: string }[];
  } {
    return {
      location: this.crossingLocation,
      serverEnabled: !!this.crossingServer,
      visitors: this.crossingVisitors(),
      worlds: this.config.crossing.worlds
        .filter((w) => w.name.trim() && w.url.trim())
        .map((w) => ({ name: w.name.trim(), allowVoluntary: w.allowVoluntary, note: w.note })),
    };
  }

  /** 出行档案：名字 + 自我认知摘录（发给对方世界供裁定；不含任何配置或密钥） */
  private async crossingProfile(): Promise<{ name: string; persona: string }> {
    const name = this.config.crossing.botName.trim() || "异界来客";
    const persona = (await this.files.readBotStatus().catch(() => "")).trim();
    return { name, persona };
  }

  private get crossingMarkerFile(): string {
    return path.join(this.files.base, "crossing.json");
  }

  private async writeCrossingMarker(world: string): Promise<void> {
    await fs.writeFile(this.crossingMarkerFile, JSON.stringify({ world, at: Date.now() })).catch(() => {});
  }

  private async clearCrossingMarker(): Promise<void> {
    await fs.rm(this.crossingMarkerFile, { force: true }).catch(() => {});
  }

  /** 读取并清除穿越标记（进程重启后向 Bot 解释"你已回到自己的世界"用） */
  private async consumeCrossingMarker(): Promise<boolean> {
    try {
      await fs.access(this.crossingMarkerFile);
    } catch {
      return false;
    }
    await this.clearCrossingMarker();
    return true;
  }

  async statusText(): Promise<string> {
    const initialized = await this.files.isInitialized();
    const stateText = !initialized
      ? "未初始化"
      : this.worldActive
        ? "运行中"
        : this.clock.running
          ? "未运行（世界时间仍在流逝）"
          : "已暂停（时间静止）";
    const lines = [
      `世界状态：${stateText}`,
      `世界时钟：${this.clock.timeLine()}（1 TU = ${this.clock.unitRealSeconds} 现实秒 / ${this.clock.unitWorldSeconds} 世界秒）`,
      `世界历法：${this.clock.syncRealTime ? "与现实时间同步" : describeCalendar(this.clock.calendar)}`,
      `Tingle：${this.clock.tingleMode === "auto" ? `auto（World 动态决定间隔，${this.clock.tingleMinUnits}~${this.clock.tingleMaxUnits} TU）` : `固定每 ${this.config.clock.tingleEveryUnits} TU 一次`}`,
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
      const computerOn = this.computerDevice?.currentName;
      if (computerOn) lines.push(`电脑已开机：「${computerOn}」`);
      if (this.crossingLocation) {
        lines.push(
          `穿越：Bot 正在异世界「${this.crossingLocation}」作客` +
            (this.world.isDormant ? "（自己的世界沉睡中，Tingle 已暂停）" : ""),
        );
      }
      if (this.phoneStatus.down) lines.push("手机被 Bot 放在一边（通知已降级为震动）");
      if (this.config.messaging.botManagedNotifyChannels) {
        lines.push(`通知频道（Bot 自管）：${this.notifyMgr.statusText()}`);
      }
    }
    if (this.crossingServer) {
      const visitors = this.crossingServer.visitorList();
      lines.push(
        `穿越服务：接待中（${this.config.crossing.host}:${this.config.crossing.port}）` +
          (visitors.length ? `，在场访客：${visitors.map((v) => `「${v.name}」`).join("、")}` : "，暂无访客"),
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

  /** 当前配置下实际可用的 Bot 工具集（全部层级） */
  private currentTools() {
    return availableTools({
      tts: this.config.tts.enabled,
      ops: this.config.platformOps,
      apps: this.appInfos(),
      notifyManaged: this.config.messaging.botManagedNotifyChannels,
      blockingAct: this.config.bot.blockingAct,
      waitConfirm: this.config.bot.waitRateThreshold > 0,
      disableWait: this.config.bot.disableWait,
      ignoreSendDuration: this.config.bot.ignoreSendDuration,
      crossingWorlds: this.config.crossing.worlds
        .filter((w) => w.allowVoluntary && w.name.trim() && w.url.trim())
        .map((w) => ({ name: w.name.trim(), note: w.note })),
      crossingConfigured: this.config.crossing.worlds.some((w) => w.name.trim() && w.url.trim()),
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
    if (this.config.apps.notesEnabled) {
      list.push({ name: "记事本", description: "你的私人笔记：备忘、值得注意的事、对人的印象、日记" });
    }
    if (this.config.apps.browserEnabled) {
      list.push({ name: "浏览器", description: "上网：搜索、打开网页，可以截图保存" });
    }
    // 电脑不在这里：它是与手机平级的另一台设备（open_computer / close_computer 开关）
    for (const s of this.config.apps.mcpServers) {
      if (s.enabled && s.name.trim()) list.push({ name: s.name.trim(), description: s.description || "外部应用" });
    }
    return list;
  }

  // ---------- WebUI ----------

  private async startWebUI(): Promise<void> {
    if (this.webui) return;
    this.webui = new WebUIServer(this);
    await this.webui.start();
    this.logger.info("WebUI 已启动：http://%s:%d", this.config.webui.host, this.config.webui.port);
  }

  /** WebUIHost：结构性实现（server.ts 经由该接口读写一切） */
  get baseDir(): string {
    return path.resolve(this.ctx.baseDir, this.config.basePath);
  }

  get version(): string {
    return WEBUI_VERSION;
  }

  get configSchema(): unknown {
    return Config;
  }

  getClock() {
    return this.clock ?? null;
  }

  async isInitialized(): Promise<boolean> {
    return this.files.isInitialized();
  }

  worldRunning(): boolean {
    return this.worldActive;
  }

  worldQueue(): number {
    return this.world?.queueLength ?? 0;
  }

  botStatus(): BotStatusSummary | null {
    return this.bot?.status() ?? null;
  }

  appOpen(): string | null {
    return this.appManager?.currentName ?? null;
  }

  computerOn(): string | null {
    return this.computerDevice?.currentName ?? null;
  }

  phoneDown(): boolean {
    return this.phoneStatus.down;
  }

  // ---------- 设备页（电脑 + 手机窥视） ----------

  async devicesInfo(): Promise<DevicesInfo> {
    const cc = this.config.apps.computer;
    const botSt = this.bot?.status() ?? null;
    return {
      computer: {
        mode: cc.mode,
        on: this.computerDevice?.currentName ?? null,
        docker: cc.mode === "docker" && this.computer ? await this.computer.inspect() : null,
        remote: cc.mode === "remote_desktop" ? { host: cc.remoteDesktop.host, port: cc.remoteDesktop.port } : null,
      },
      phone: {
        down: this.phoneStatus.down,
        appOpen: this.appManager?.currentName ?? null,
        chatOpen: botSt?.phoneUi?.chatOpen ?? false,
        channelKey: botSt?.phoneUi?.channelKey ?? null,
        channelIsGroup: botSt?.phoneUi?.channelIsGroup ?? false,
        chatAppName: this.config.apps.chatAppName || "QQ",
        resolution: resolvePhoneResolution(this.config.apps.phoneResolution, await this.files.readMeta()),
      },
    };
  }

  async computerScreen(maxWidth?: number): Promise<{ png: Buffer; width: number; height: number }> {
    const cc = this.config.apps.computer;
    if (cc.mode !== "remote_desktop") {
      throw new Error(cc.mode === "docker" ? "Docker 电脑没有屏幕——它是纯终端，用下面的控制台操作。" : "电脑未启用（apps.computer.mode = off）。");
    }
    if (!this.remoteDesktopApp) {
      throw new Error("远程桌面未接线（需要 bot.modalities.image 开启图片模态）。");
    }
    return this.remoteDesktopApp.peek(maxWidth);
  }

  async computerAction(action: "start" | "stop" | "restart"): Promise<string> {
    if (this.config.apps.computer.mode !== "docker" || !this.computer) {
      return "这台电脑不是 Docker 模式，没有容器可管理。";
    }
    if (action === "start") return this.computer.start();
    if (action === "stop") return this.computer.stop();
    return this.computer.restart();
  }

  async computerExec(command: string) {
    if (this.config.apps.computer.mode !== "docker" || !this.computer) {
      return { code: null, output: "（这台电脑不是 Docker 模式——远程桌面请用窥屏，未启用请先在配置里打开。）" };
    }
    return this.computer.exec(command);
  }

  focusChannels(): string[] {
    return this.focus.activeKeys();
  }

  prompts(): Prompts {
    return this.promptStore;
  }

  async savePromptsOverrides(overrides: PromptOverrides): Promise<void> {
    await Prompts.save(this.webuiDir, overrides);
  }

  /** 重载定义：与 world.reload 指令行为一致（World-LLM 调整世界状态并告知 Bot） */
  async reloadWorld(): Promise<string> {
    if (this.notReady()) return this.notReady()!;
    if (!(await this.files.isInitialized())) return "世界尚未初始化。";
    const { botDef, worldDef } = await this.files.readDefinitions();
    await this.world.reconcileDefinitions(botDef, worldDef, (content) => {
      this.bot?.pushEvent("world", content);
    });
    return "定义已重新载入，世界状态已调整。";
  }

  async resetWorld(): Promise<string> {
    await this.stopWorld();
    await this.files.reset();
    await this.clock.reset();
    await this.focus.clear();
    await this.notifyMgr.reset();
    this.phoneStatus.down = false;
    return "世界已重置。定义文件保留，可重新 world.init。";
  }

  async clearMsg(): Promise<string> {
    await this.store.clear();
    return "聊天消息记录已清空（媒体缓存与世界状态不受影响）。";
  }

  async injectEvent(text: string): Promise<string> {
    if (!this.worldActive || !this.bot) return "世界未在运行。";
    if (!text?.trim()) return "内容不能为空。";
    this.bot.pushEvent("system", text.trim(), { wake: true });
    return "已注入。";
  }

  // ---------- 归档（快照 / 回档 / 删除） ----------

  /** 手动存档：把当前全部世界状态复制成一份新快照（不影响运行中的世界） */
  async saveArchive(label: string): Promise<string> {
    const name = await this.files.snapshot(String(label ?? ""));
    this.logger.info("手动存档：archive/%s", name);
    return `已存档到 archive/${name}`;
  }

  /** 回档到某个快照：当前状态先自动存档，随后被快照覆盖并重启世界 */
  async restoreArchive(name: string): Promise<string> {
    if (!/^[\w\u4e00-\u9fa5.-]+$/.test(name)) throw new Error("非法归档名");
    const snapDir = path.join(this.files.archiveDir, name);
    const stat = await fs.stat(snapDir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error("归档不存在（仅支持文件夹形式的快照回档）");
    const wasRunning = this.worldActive;
    if (wasRunning) await this.stopWorld();
    // 回档前自动存档当前状态，防误操作
    const backup = await this.files.snapshot("回档前");
    await this.files.restoreFrom(snapDir);
    await this.clock.load();
    await this.focus.load();
    await this.notifyMgr.load();
    this.phoneStatus.down = false;
    this.logger.info("已回档到 archive/%s（回档前自动存档：archive/%s）", name, backup);
    let msg = `已回档到「${name}」（回档前的状态已自动存档为 archive/${backup}）。`;
    if (wasRunning) {
      try {
        await this.startWorld();
        msg += " 世界已自动重新开始运转。";
      } catch (err) {
        msg += ` 世界自动重启失败：${(err as Error).message ?? err}（可用 world.start 手动启动）。`;
      }
    } else {
      msg += " 用 world.start 开始运转。";
    }
    return msg;
  }

  /** 删除一份归档快照 */
  async deleteArchive(name: string): Promise<void> {
    if (!/^[\w\u4e00-\u9fa5.-]+$/.test(name)) throw new Error("非法归档名");
    const target = path.join(this.files.archiveDir, name);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new Error("归档不存在");
    await fs.rm(target, { recursive: true, force: true });
  }

  /**
   * 应用新配置：合并后整体替换插件作用域（MainScope.update 强制重启），
   * loader 会把合并结果写回配置文件。先停掉旧 WebUI 再重启，端口即可即时切换；
   * 旧实例在作用域重启时随 dispose 一起清理。
   */
  async applyConfig(next: Config): Promise<{ message: string; port: number }> {
    const merged: Config = { ...this.config, ...next };
    if (next.webui) merged.webui = { ...this.config.webui, ...next.webui };
    const port = merged.webui.port;
    // 等当前 HTTP 响应写盘/落地后再停服重载，避免截断对请求方的应答
    setTimeout(() => {
      void this.restartScope(merged).catch((err) => this.logger.warn("配置热重载失败: %s", err));
    }, 300);
    return { message: "配置已应用，插件作用域将自动重启生效。", port };
  }

  /** 停止当前 WebUI → 触发父级插件作用域整体重启（apply 以新配置重跑） */
  private async restartScope(config: Config): Promise<void> {
    await this.webui?.stop().catch(() => {});
    this.webui = null;
    const parent = (this.ctx.scope as { parent?: { scope?: { update?: (c: Config, forced: boolean) => void } } }).parent
      ?.scope;
    if (!parent?.update) {
      throw new Error("找不到插件作用域，无法热重载（可手动重启插件应用新配置）");
    }
    parent.update(config, true);
  }

  async notes(): Promise<NoteEntry[]> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.files.notesDir)).filter((f) => f.toLowerCase().endsWith(".md"));
    } catch {
      return [];
    }
    const out: NoteEntry[] = [];
    for (const name of names.sort()) {
      const content = await fs.readFile(path.join(this.files.notesDir, name), "utf8").catch(() => "");
      // 与 NotesApp 一致：剥掉 frontmatter 元数据，只留正文
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
      out.push({ title: name.replace(/\.md$/i, ""), content: body });
    }
    return out;
  }

  async writeNote(name: string, content: string): Promise<void> {
    const title = (name ?? "").trim().replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ").slice(0, 60).trim();
    if (!title) throw new Error("标题不能为空");
    const file = path.join(this.files.notesDir, `${title}.md`);
    await fs.mkdir(this.files.notesDir, { recursive: true });
    const stamp = this.clock?.clockString(this.clock.now());
    const fm = `---\ncreated: ${stamp}\nupdated: ${stamp}\n---\n\n`;
    await fs.writeFile(file, fm + String(content ?? "").trim() + "\n");
  }

  async deleteNote(name: string): Promise<void> {
    const title = (name ?? "").trim().replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ").trim();
    if (!title) throw new Error("标题不能为空");
    await fs.rm(path.join(this.files.notesDir, `${title}.md`), { force: true });
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
      .subcommand(".webui", "查看运维 WebUI 的访问地址（若已启用）", { authority: 1 })
      .action(async () => {
        if (this.notReady()) return this.notReady()!;
        const webui = this.config.webui;
        if (!webui.enabled || !this.webui) {
          return "WebUI 未启用。在配置中开启 webui.enabled 并重启插件后可用。";
        }
        const base = webui.token ? `地址：http://${webui.host}:${webui.port}/ 访问令牌：${webui.token}` : `地址：http://${webui.host}:${webui.port}/`;
        return `运维 WebUI 已启动。${base}`;
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
        if (!this.worldActive || !this.bot) return "世界未在运行。";
        if (!text?.trim()) return "内容不能为空。";
        this.bot.pushEvent("system", text.trim(), { wake: true });
        return "已注入。";
      });

    cmd
      .subcommand(".travel <name:text>", "穿越：把 Bot 强制送往指定的异世界（填 home 送回自己的世界）", { authority: 3 })
      .action(async (_, name) => {
        const target = (name ?? "").trim();
        if (!target) {
          const worlds = this.config.crossing.worlds.filter((w) => w.name.trim() && w.url.trim());
          return worlds.length
            ? `用法：world.travel <世界名|home>。已配置的世界：${worlds.map((w) => `「${w.name.trim()}」${w.allowVoluntary ? "" : "（仅强制）"}`).join("、")}` +
                (this.crossingLocation ? `\nBot 当前在「${this.crossingLocation}」。` : "")
            : "还没有配置任何可去的世界（crossing.worlds）。";
        }
        return this.crossingForce(target);
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
