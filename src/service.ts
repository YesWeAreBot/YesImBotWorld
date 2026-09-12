import { registerWorldCommands } from "./commands.js";
import { GrowthLedger } from "./bot/growth.js";
import { BotIdentityResolver } from "./webui/avatar.js";
import { callStore } from "./webui/calls.js";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Context, Service } from "koishi";
import { AppManager } from "./apps/manager.js";
import { BrowserApp } from "./apps/browser.js";
import { ComputerDevice } from "./apps/computerDevice.js";
import { FileManagerApp } from "./apps/files.js";
import { McpApp } from "./apps/mcp.js";
import { NewsApp } from "./apps/news.js";
import { NotesApp } from "./apps/notes.js";
import { RemoteDesktopApp } from "./apps/remoteDesktop.js";
import { TerminalApp } from "./apps/terminal.js";
import { WeatherApp } from "./apps/weather.js";
import { BotAgent } from "./bot/agent.js";
import type { ManualToolResult } from "./bot/agent.js";
import { BotContext } from "./bot/context.js";
import { availableTools, renderToolsText, toolLayer, type AppInfo } from "./bot/tools.js";
import { describeCalendar } from "./calendar.js";
import { WorldClock } from "./clock.js";
import { BotComputer } from "./computer.js";
import { Config, needsMsgIds, type ModalitySupport } from "./config.js";
import { CrossingClient } from "./crossing/client.js";
import type { PlayerMode } from "./crossing/protocol.js";
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
import { parseChannelKey } from "./koishi/channels.js";
import { deviceTools, type DeviceSession, type DeviceControlResult, type DeviceOperationMode } from "./webui/device.js";
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
/** WebUI 展示用版本号：优先从 package.json 读取（版本只维护 package.json 一处），读不到才回退常量 */
const WEBUI_VERSION = readPackageVersion();

/** 从 package.json 读 version（经 ./package.json 导出 path 解析；失败/非发布场景兜底回退） */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return require("koishi-plugin-yesimbot-world/package.json").version as string;
  } catch {
    return "0.2.1";
  }
}

export class WorldService extends Service<Config> {
  private botIdentityResolver = new BotIdentityResolver();
  private residentSession: { token: string; id: string; mode: "avatar" | "puppet" } | null = null;
  private residentTransition = false;
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
  private deviceTail: Promise<void> = Promise.resolve();
  private devicePending = 0;
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
      if (!nativeSafeMime(ref)) return false;
      if (isGif(ref)) return this.effectiveModalities.video || this.effectiveModalities.image;
      return this.effectiveModalities[ref.type];
    };
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
    callStore.init(path.join(this.webuiDir, "calls"));
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
          releaseResidentControl: async (id, cause) => {
            await this.bot?.releaseResidentControl(id, true);
            if (this.residentSession?.id === id) {
              await this.remoteDesktopApp?.releaseInputs();
              this.residentSession = null;
            }
          },
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
    // 先退休 Bot 并刷新已完成但延迟投递的回执，再等待角色会话退出。
    await this.stopWorld({ suspend: true });
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
    callStore.dispose();
    // stopWorld(suspend) 保留离线期间持续流逝的世界时间。
  }

  // ---------- 世界生命周期 ----------

  /** 初始化：读取用户定义，由 World-LLM 生成初始状态文件 */
  async initWorld(force = false): Promise<string> {
    if ((await this.files.isInitialized()) && !force) {
      return "世界已经初始化过了。如需重新创世，使用 world.init -f（会归档并清空当前世界状态）。";
    }
    await this.stopWorld();
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
    // 生成空的 News.jsonl 与 facts.jsonl
    if (!(await this.files.exists(this.files.news))) await fs.writeFile(this.files.news, "");
    if (!(await this.files.exists(this.files.facts))) await fs.writeFile(this.files.facts, "");
    await this.world.initialize(botDef, worldDef);

    // 建立全新的 Bot 上下文（角色设定来自刚生成的 Bot_Status.md；
    // 「最初设定」= Bot_Definition.md 原文，此后只在压缩时随定义文件刷新）
    await fs.writeFile(this.files.stream, "");
    const context = new BotContext(this.files, this.pinnedToolsText(), this.promptStore);
    context.pinned.botDefinition = botDef;
    context.pinned.persona = botDef;
    await context.persistPinned();

    this.logger.info("创世完成");
    return `创世完成，结构化世界已写入 ${this.files.worldJournal}。\n使用 world.start 让世界开始运转。`;
  }

  async startWorld(): Promise<string> {
    if (this.worldActive) return "世界已在运行中。";
    if (!(await this.files.isInitialized())) {
      return "世界尚未初始化。请先编写定义文件并执行 world.init。";
    }

    await this.world.ensureStructuredWorld();

    // 实际可用的工具集（如未配置 TTS 则没有 send_voice；平台扩展操作按配置开关）。
    // 置顶列表只放 core 层常驻工具；chat/channel/group 层在打开应用/进入频道时以事件展开
    const tools = this.currentTools();

    this.botContext = new BotContext(this.files, this.pinnedToolsText(), this.promptStore);
    // wait 被移除时，行为准则与时间说明不再提及等待
    this.botContext.waitRemoved = this.config.bot.disableWait;
    // 聊天账号列表：Bot 识别 <at id/>、引用等结构里的"自己"的依据。
    // 惰性取值：autoStart 时适配器可能尚未连接，连上后自然出现（仅 id，保持前缀稳定）
    this.botContext.accountsProvider = () => {
      const ids = [...new Set(this.ctx.bots.filter((b) => b.selfId).map((b) => `${b.platform}:${b.selfId}`))];
      return ids.sort().join("、");
    };
    // 常驻 Bot 名字：渲染时实时取值（世界演化改名前/后都会反映到 prompt）
    this.botContext.botNameProvider = () => this.world.residentBotName;
    // TU 换算锚点：Bot 估算 duration / wait 时长的依据（如「1 TU = 1 秒」）
    this.botContext.timeInfo =
      `1 TU = ${this.clock.unitWorldSeconds} 秒` +
      (this.clock.syncRealTime ? "（世界时间与现实同步）" : `（现实中 ${this.clock.unitRealSeconds} 秒）`);
    await this.botContext.load();
    // Stable authored identity; physical state comes exclusively from observe.
    this.botContext.pinned.persona = await this.files.readText(this.files.botDef);
    this.botContext.pinned.botDefinition = this.botContext.pinned.persona;
    await this.botContext.persistPinned();
    // 原生多模态：附件 → content part。
    // 加载时按【当前】模态配置与格式白名单过滤：用户纠正配置后，历史事件里
    // 已不支持的附件（关掉的模态 / GIF 表情等）不再注入请求，避免持续 400。
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
      () => this.appManager?.activeToolNames() ?? [],
    );
    // 手机应用（Apps / MCP）：内置天气/浏览器 + 外接 MCP Server（电脑不在手机里，是平级的另一台设备）
    const worldApps = [
      ...(this.config.apps.weatherEnabled
        ? [new WeatherApp(this.world, this.files, this.clock, this.config.apps, this.logger)]
        : []),
      ...(this.config.apps.notesEnabled ? [new NotesApp(this.files, this.clock, this.logger)] : []),
      ...(this.config.apps.newsEnabled ? [new NewsApp(this.files, this.clock, this.config.apps, this.logger)] : []),
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
        .map((s) => new McpApp(s, this.logger, { media: this.media, renderer: this.renderer })),
    ];
    this.appManager = new AppManager(
      this.config.apps.chatAppName,
      worldApps,
      new Set(tools.map((t) => t.name)),
      this.logger,
      () => this.computerDevice?.activeToolNames() ?? [],
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
      async kind => {
        if (kind === "computer" && this.remoteDesktopApp?.connected) {
          return this.remoteDesktopApp.observe();
        }
        if (kind === "phone") {
          const key = this.bot?.status().phoneUi?.channelKey;
          const channel = key ? parseChannelKey(key) : null;
          if (channel && !channel.error) {
            const messages = await this.store.channelMessages(channel.platform, channel.channelId, 12, channel.selfId);
            return { text: messages.map(row => `${row.username || row.userId}: ${row.content}`).join("\n") };
          }
        }
        return null;
      },
    );

    await this.clock.resume();

    // 上次运行时 Bot 还在异世界（进程崩溃/重启）：告知它已被拉回自己的世界
    if (await this.consumeCrossingMarker()) {
      this.bot.pushEvent(
        "system",
        "（你恍惚记得自己此前身在另一个世界——离线期间与那个世界的连接已经断开，你回到了自己的世界。）",
      );
    }

    // Recover the last durable perception before taking a fresh one. Source IDs make
    // this a reread of prior evidence, even if the prior response was lost at shutdown.
    const kernel = await this.world.structured.kernel();
    const previousObservation = kernel.latestObservation("bot");
    if (previousObservation) this.bot.pushEvent("world", JSON.stringify({ recovered: true, observation: previousObservation }));
    this.bot.pushEvent("world", JSON.stringify(await this.world.observe()));
    this.bot.pushEvent("system", "可以继续先前的生活。以上 recovered 观测是先前保存的记录；最新处境以随后观测为准。未完成动作需要根据实际回执确认，系统暂停本身不代表角色睡眠或失神。");
    const offline = this.clock.consumeOfflineGap();
    const min = this.config.clock.offlineNarrateMinUnits;
    if (offline && min > 0 && offline.gapTU >= min) {
      void this.world.resolveOfflineGap(offline.fromTU, content => this.bot?.pushEvent("world", content))
        .catch(err => this.logger.warn("离线自然过程结算失败: %s", err));
    }

    // 工具集与置顶列表不一致（配置变更/版本升级）：以事件告知，置顶列表在下次 rest 时才同步（保护前缀缓存）
    const toolsNotice = this.botContext.toolsChangeNotice();
    if (toolsNotice) this.bot.pushEvent("system", toolsNotice);

    // 世界内核提交后，按常驻角色的可见性投递互动观测。
    this.world.setHostBotDeliver((content) => this.bot?.pushEvent("world", content, { wake: true }));

    // 旧世界 meta.json 缺 botName（新字段）：从定义补判一次（不阻塞启动，失败下次启动再试）
    void this.world.ensureBotName().catch((err) => this.logger.warn("Bot 名字补判失败: %s", err));

    this.bot.start();
    this.tingle = new TingleTimer(
      this.config.clock,
      this.clock,
      this.world,
      // 只有实际可感知变化才会投递，避免无事发生的心跳打断休息。
      (content) => this.bot?.pushEvent("world", content, { wake: true }),
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
            `离线期间你在 ${namesText} 错过的 ${total} 条消息已补录到聊天记录里（用 check_msg / select_channel / read_channel 翻看）。`,
          );
        })
        .catch((err) => this.logger.warn("离线历史补拉失败: %s", err));
    }

    this.logger.info("世界开始运转：%s", this.clock.timeLine());
    return `世界开始运转。当前 ${this.clock.timeLine()}`;
  }

  async stopWorld(opts: { suspend?: boolean } = {}): Promise<string> {
    const wasActive = this.worldActive;
    this.worldActive = false;
    this.world.stop();
    this.tingle?.stop();
    this.tingle = null;
    this.remoteDesktopApp?.abortInput();
    await this.bot?.stop();
    await this.deviceTail;
    await this.crossingServer?.disconnectVisitors("世界暂停或正在切换存档");
    await this.world.structured.shutdown();
    if (!wasActive) return "世界并未在运行。";
    // Bot 还在异世界：礼貌地离开。标记文件保留——下次启动时向 Bot 解释"你回到了自己的世界"
    if (this.crossingClient) {
      const client = this.crossingClient;
      this.crossingClient = null;
      this.crossingLocation = null;
      this.world.setRemote(null);
      void client.leave().catch(() => {});
    }
    this.world.setHostBotDeliver(null);
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
      // Remote observations never overwrite the local authoritative actor or its identity.
      onStatusUpdate: (content) => this.bot?.pushEvent("world", content, { wake: true }),
      unitWorldSeconds: () => this.clock.unitWorldSeconds,
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

  /** WebUI：玩家入世界（同部署真人玩家，复用 crossing server，不走邀请码） */
  arrivePlayer(name: string, persona: string, mode: PlayerMode = "cross"): { ok: true; token: string; worldName: string; timeLine: string } | { ok: false; error: string } {
    if (!this.crossingServer) return { ok: false, error: "穿越服务未开启（crossing.serverEnabled）" };
    return this.crossingServer.arrivePlayer(name, persona, mode);
  }

  playerControlsBot(token: string): boolean {
    return this.crossingServer?.playerControlsBot(token) ?? false;
  }

  /** 会话凭据只用于授权；审计中记录公开 session id，不记录 bearer token。 */
  async acquirePlayerControl(token: string): Promise<DeviceControlResult> {
    const session = this.crossingServer?.residentSession(token), bot = this.bot;
    if (!session || !bot || !this.worldActive) return { ok: false, paused: false, busy: false, text: "常驻角色接管会话不存在或世界已停止。" };
    if (this.residentSession && this.residentSession.id !== session.id) return { ok: false, paused: bot.manualMode, busy: true, text: "常驻角色正由另一个会话接管。" };
    // 先使旧的设备输入排空，再改变角色控制归属。
    return this.withDeviceLock(async () => {
      if (this.residentTransition || this.crossingServer?.residentSession(token)?.id !== session.id || !this.worldActive || this.bot !== bot) return { ok: false, paused: bot.manualMode, busy: false, text: "角色会话在等待控制期间已结束。" };
      this.residentTransition = true;
      try {
        const { busy } = await bot.acquireResidentControl(session.mode, session.id);
        if (this.crossingServer?.residentSession(token)?.id !== session.id || !this.worldActive || this.bot !== bot) {
          await bot.releaseResidentControl(session.id, true);
          return { ok: false, paused: bot.manualMode, busy: false, text: "角色会话在建立期间已结束，控制已归还。" };
        }
        this.residentSession = { token, id: session.id, mode: session.mode };
        if (!busy) await this.remoteDesktopApp?.releaseInputs();
        return { ok: true, paused: bot.manualMode, busy, text: busy ? "角色控制已建立，等待此前已提交操作的真实回执。" : session.mode === "avatar" ? "已完全入替角色，自主生成暂停。" : "已接管身体，角色的自主意识继续运行。" };
      } catch (error) {
        await bot.releaseResidentControl(session.id, true);
        if (this.residentSession?.id === session.id) this.residentSession = null;
        return { ok: false, paused: bot.manualMode, busy: false, text: (error as Error).message };
      } finally { this.residentTransition = false; }
    });
  }

  async releasePlayerControl(token: string): Promise<DeviceControlResult> {
    const session = this.crossingServer?.residentSession(token), bot = this.bot;
    if (!session || this.residentSession?.id !== session.id || !bot) return { ok: false, paused: bot?.manualMode ?? false, busy: false, text: "角色接管会话不存在或已改变。" };
    if (this.devicePending > 0 || bot.residentBusy) return { ok: false, paused: bot.manualMode, busy: true, text: "还有操作未完成；可以取消尚未提交的调用，已提交操作需等待真实回执。" };
    if (this.residentTransition) return { ok: false, paused: bot.manualMode, busy: true, text: "角色控制正在切换。" };
    this.residentTransition = true;
    try {
      await this.remoteDesktopApp?.releaseInputs();
      const { busy } = await bot.releaseResidentControl(session.id);
      if (!busy && this.residentSession?.id === session.id) this.residentSession = null;
      return { ok: !busy, paused: bot.manualMode, busy, text: busy ? "操作尚未完成。" : "已归还角色，自主运行恢复。" };
    } finally { this.residentTransition = false; }
  }

  async playerCockpit(token: string) {
    const session = this.crossingServer?.residentSession(token), bot = this.bot;
    if (!session || !bot || this.residentSession?.id !== session.id) throw new Error("常驻角色接管会话不存在或已结束");
    return {
      mode: session.mode, running: this.worldActive && bot.status().running,
      control: { paused: bot.manualMode, busy: this.devicePending > 0 || bot.residentBusy },
      tools: bot.manualTools(session.mode).map(tool => {
        const device = this.deviceToolDefs().find(candidate => candidate.name === tool.name);
        return { ...tool, ...(device ? { device: device.device, effect: device.effect } : {}), requiresSendConfirmation: device?.effect === "send" };
      }), pending: bot.pendingManualCalls(),
      time: { unitWorldSeconds: this.clock?.unitWorldSeconds ?? 1, unitRealSeconds: this.clock?.unitRealSeconds ?? 1 },
    };
  }

  cancelPlayerTool(token: string, callId: string) {
    const session = this.crossingServer?.residentSession(token);
    if (!session || !this.bot || this.residentSession?.id !== session.id) return { ok: false, status: "not_found", text: "角色接管会话不存在。" };
    return this.bot.cancelExternalTool(callId, session.id);
  }

  /** 人类驾驶舱与 Bot-LLM 共用真实 dispatch；来源语义由有效会话决定。 */
  async botToolCall(name: string, args: Record<string, unknown>, duration?: number, token?: string, confirmSend = false): Promise<ManualToolResult> {
    const session = token ? this.crossingServer?.residentSession(token) : null, bot = this.bot;
    if (!this.worldActive || !bot) return { ok: false, text: "（Bot-LLM 当前未在运行。）" };
    if (!session || this.residentSession?.id !== session.id) return { ok: false, text: "请先建立常驻角色接管会话，再从驾驶舱操作。" };
    if (this.residentTransition) return { ok: false, text: "角色控制正在切换，此调用没有执行。" };
    if (bot.residentBusy && name !== "cancel") return { ok: false, text: "已有动作尚未完成，请等待真实回执或取消尚未提交的调用。" };
    if (name === "cancel") return this.cancelPlayerTool(token!, String(args.id ?? args.toolcall_id ?? ""));
    if (this.deviceToolDefs().some(tool => tool.name === name && tool.effect === "send") && !confirmSend) return { ok: false, text: "发送需由用户明确点击发送（confirmSend=true）。" };
    return bot.injectExternalToolCall(name, args, { duration, control: { mode: session.mode, sessionId: session.id } });
  }

  /** WebUI：管理员接管 Bot 时暂停/恢复其自主生成 */
  async botSetManualPaused(paused: boolean): Promise<DeviceControlResult> {
    return this.deviceControl(paused);
  }

  private withDeviceLock<T>(run: () => Promise<T>): Promise<T> {
    this.devicePending++;
    const result = this.deviceTail.then(run, run);
    this.deviceTail = result.then(() => { this.devicePending--; }, () => { this.devicePending--; });
    return result;
  }

  private deviceToolDefs() {
    return deviceTools(this.bot?.manualTools() ?? [], new Set(this.appManager?.activeToolNames() ?? []), new Set(this.computerDevice?.activeToolNames() ?? []));
  }

  async deviceControl(paused: boolean): Promise<DeviceControlResult> {
    return this.withDeviceLock(async () => {
      const bot = this.bot;
      if (!this.worldActive || !bot) return { ok: false, paused: false, busy: false, text: "世界尚未运行，无法接管设备。" };
      if (this.residentSession) return { ok: false, paused: bot.manualMode, busy: bot.residentBusy, text: "角色接管期间设备随角色模式运行；请从驾驶舱归还角色后再单独控制设备。" };
      if (paused) {
        const { busy } = await bot.acquireManualControl();
        if (!busy) await this.remoteDesktopApp?.releaseInputs();
        return { ok: !busy, paused: true, busy, text: busy ? "自主生成已暂停；已有操作正在提交，等待真实回执后即可操作。" : "已接管设备，自主生成已暂停。" };
      }
      if (bot.manualBusy) return { ok: false, paused: bot.manualMode, busy: true, text: "已有操作尚未完成，请等待回执后交还控制。" };
      await this.remoteDesktopApp?.releaseInputs();
      bot.setManualPaused(false);
      return { ok: true, paused: false, busy: false, text: "已交还设备，Bot 恢复自主运行。" };
    });
  }

  async deviceToolCall(name: string, args: Record<string, unknown>, duration?: number, confirmSend = false, mode: DeviceOperationMode = "takeover"): Promise<ManualToolResult> {
    return this.withDeviceLock(async () => {
      const bot = this.bot;
      if (!this.worldActive || !bot) return { ok: false, text: "世界尚未运行。" };
      if (mode !== "stealth" && mode !== "takeover") return { ok: false, text: "未知设备操作模式。" };
      if (this.residentTransition) return { ok: false, text: "角色控制正在切换，此设备操作没有执行。" };
      const resident = this.residentSession;
      if (resident && (!this.crossingServer?.residentSession(resident.token) || bot.residentBusy)) return { ok: false, text: "角色会话正在结束或仍有动作待回执。" };
      if (!resident && mode === "takeover" && (!bot.manualMode || bot.manualBusy)) return { ok: false, text: "请先强制接管并等待现有操作完成。" };
      if (!resident && mode === "stealth" && (name === "pick_up_phone" || name === "put_down_phone")) return { ok: false, text: "偷偷操作改变设备界面，不代替角色拿起或放下手机。" };
      const tool = this.deviceToolDefs().find(tool => tool.name === name);
      if (!tool) return { ok: false, text: "此设备工具当前不可用，请先打开对应应用或进入频道。" };
      if (tool.effect === "send" && !confirmSend) return { ok: false, text: "发送需由用户明确点击发送（confirmSend=true）。" };
      if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, text: "args 必须为 JSON 对象。" };
      if (duration !== undefined && (!Number.isFinite(duration) || duration < 0)) return { ok: false, text: "duration 必须为有限非负数。" };
      return bot.injectExternalToolCall(name, args, resident
        ? { duration, control: { mode: resident.mode, sessionId: resident.id } }
        : { duration, stealth: mode === "stealth" });
    });
  }

  async deviceSession(): Promise<DeviceSession> {
    const devices = await this.devicesInfo();
    const channel = devices.phone.channelKey;
    const [known, recent] = await Promise.all([this.store.knownChannels(), this.store.recentChannels(100)]);
    const latest = new Map(recent.map(row => [row.key, row.latest]));
    const parsed = channel ? parseChannelKey(channel) : null;
    const messages = parsed && !parsed.error ? await this.store.channelMessages(parsed.platform, parsed.channelId, 100, parsed.selfId) : [];
    return {
      running: this.worldActive && !!this.bot?.status().running,
      control: { paused: this.bot?.manualMode ?? false, residentMode: this.bot?.residentMode ?? null, busy: this.devicePending > 0 || !!(this.residentSession ? this.bot?.residentBusy : this.bot?.manualBusy), deviceBusy: this.devicePending > 0 || !!this.bot?.deviceBusy, attention: this.bot?.deviceAttention ?? null },
      devices,
      apps: (this.appManager?.installedApps() ?? []).map(app => ({ ...app, active: app.kind === "chat" ? devices.phone.chatOpen : app.active })),
      tools: this.deviceToolDefs(),
      appView: this.appManager?.view() ?? null,
      computerView: this.computerDevice?.view() ?? null,
      chat: { channelKey: channel, channels: known.map(row => ({ ...row, ...(latest.has(row.key) ? { latest: latest.get(row.key) } : {}) })), messages },
    };
  }

  /** WebUI：Bot 是否处于手动驾驶（自主生成已暂停） */
  botManualMode(): boolean {
    return this.bot?.manualMode ?? false;
  }

  /** WebUI：常驻 Bot 名字（供管理员同名判定） */
  residentBotName(): string {
    return this.world.residentBotName;
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
    // 名字优先级：显式配置的出行名 > 世界判定的常驻 Bot 名 > "异界来客"
    const name = this.config.crossing.botName.trim() || this.world.residentBotName || "异界来客";
    const persona = (await this.files.readText(this.files.botDef)).trim();
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
        `Bot-LLM：${s.running ? "持续推理中" : "已停止"}`,
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
    if (this.config.apps.newsEnabled) {
      list.push({ name: "新闻", description: "翻阅世界的最近大事：看头条、按关键词搜索、按时间回看" });
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

  async getStructuredWorld(): Promise<unknown> {
    const kernel = await this.world.structured.kernel();
    const snapshot = kernel.snapshot();
    return { snapshot, events: kernel.readEvents(Math.max(0, snapshot.sequence - 100), 1000) };
  }

  async getGrowth(): Promise<unknown> { return new GrowthLedger(this.files.base).recall({ n: 50 }); }

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
    const meta = await this.files.readMeta();
    const effectiveMode = (meta.realWorld ?? this.clock?.syncRealTime ?? false) ? cc.mode : "virtual";
    const botSt = this.bot?.status() ?? null;
    return {
      computer: {
        mode: cc.mode,
        effectiveMode,
        on: this.computerDevice?.currentName ?? null,
        docker: effectiveMode === "docker" && this.computer ? await this.computer.inspect() : null,
        remote: effectiveMode === "remote_desktop" ? { host: cc.remoteDesktop.host, port: cc.remoteDesktop.port, connected: this.remoteDesktopApp?.connected ?? false } : null,
      },
      phone: {
        down: this.phoneStatus.down,
        appOpen: this.appManager?.currentName ?? null,
        chatOpen: botSt?.phoneUi?.chatOpen ?? false,
        channelKey: botSt?.phoneUi?.channelKey ?? null,
        channelIsGroup: botSt?.phoneUi?.channelIsGroup ?? false,
        chatAppName: this.config.apps.chatAppName || "QQ",
        resolution: resolvePhoneResolution(this.config.apps.phoneResolution, meta),
      },
    };
  }

  async computerScreen(maxWidth?: number): Promise<{ png: Buffer; width: number; height: number; desktopWidth?: number; desktopHeight?: number }> {
    const cc = this.config.apps.computer;
    const meta = await this.files.readMeta();
    if (!(meta.realWorld ?? this.clock?.syncRealTime)) throw new Error("虚构世界的电脑由模型模拟，没有真实屏幕。");
    if (cc.mode !== "remote_desktop") {
      throw new Error(cc.mode === "docker" ? "Docker 电脑没有屏幕——它是纯终端，用下面的控制台操作。" : "电脑未启用（apps.computer.mode = off）。");
    }
    if (!this.remoteDesktopApp) {
      throw new Error("远程桌面未接线（需要 bot.modalities.image 开启图片模态）。");
    }
    if (!this.computerDevice?.isOpen) throw new Error("请先接管并打开电脑。");
    return this.remoteDesktopApp.peek(maxWidth);
  }

  async computerAction(action: "start" | "stop" | "restart"): Promise<string> {
    return this.withDeviceLock(async () => {
      if (!this.worldActive || !this.bot?.manualMode || this.bot.manualBusy) throw new Error("请先接管并等待设备空闲。");
      const meta = await this.files.readMeta();
      if (!(meta.realWorld ?? this.clock?.syncRealTime)) throw new Error("虚构世界的电脑由模型模拟，不能管理真实 Docker 容器。");
      if (this.config.apps.computer.mode !== "docker" || !this.computer) throw new Error("这台电脑不是 Docker 模式，没有容器可管理。");
      if (action === "start") return (await this.bot.injectExternalToolCall("open_computer", {})).text;
      if (this.computerDevice?.isOpen) await this.bot.injectExternalToolCall("close_computer", {});
      const text = action === "stop" ? await this.computer.stop() : await this.computer.restart();
      if (action === "restart") return text + "\n" + (await this.bot.injectExternalToolCall("open_computer", {})).text;
      return text;
    });
  }

  async computerExec(command: string) {
    const meta = await this.files.readMeta();
    if ((meta.realWorld ?? this.clock?.syncRealTime) && this.config.apps.computer.mode !== "docker") throw new Error("这台电脑没有终端模式。");
    const tool = this.computerDevice?.activeToolDefs().find(def => def.name === "run_command" || def.name.endsWith(".run_command"));
    if (!tool) throw new Error("请先接管并打开电脑。");
    const result = await this.deviceToolCall(tool.name, { command });
    if (!result.ok) throw new Error(result.text);
    // 统一经 Bot 的真实终端工具执行，不另开旁路；文本回执不虚构退出码。
    return { code: null, output: result.text };
  }

  focusChannels(): string[] {
    return this.focus.activeKeys();
  }

  getBotIdentity() {
    return this.botIdentityResolver.resolve(this.ctx.bots, this.bot?.status().phoneUi?.channelKey);
  }

  prompts(): Prompts {
    return this.promptStore;
  }

  async savePromptsOverrides(overrides: PromptOverrides): Promise<void> {
    await Prompts.save(this.webuiDir, overrides);
  }

  /** 用户手动设置常驻 Bot 名字：写 meta + 刷内存，并通知 World 这是同一角色改名（异步，不阻塞保存） */
  async setBotName(name: string): Promise<void> {
    const trimmed = name.trim().slice(0, 64);
    const oldName = this.world.residentBotName;
    await this.world.setBotName(trimmed);
    if (trimmed === oldName) return; // 没变化，不折腾 World
    // 世界在运行时，异步让 World 知道「同一角色改名」并同步状态/告知 Bot 本人
    if (this.worldActive && this.bot) {
      void this.world
        .notifyBotRename(oldName, trimmed, (content) => this.bot?.pushEvent("world", content, { wake: true }))
        .catch((err) => this.logger.warn("Bot 改名通知 World 失败: %s", err));
    }
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
    await this.stopWorld();
    // 回档前自动存档当前状态，防误操作
    const backup = await this.files.snapshot("回档前");
    await this.files.restoreFrom(snapDir);
    await this.clock.load();
    await this.world.structured.reload();
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
    registerWorldCommands(ctx, this);
  }
}
