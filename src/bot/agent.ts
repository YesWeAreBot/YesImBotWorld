import type { Logger } from "koishi";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ComputerDevice } from "../apps/computerDevice.js";
import type { AppManager } from "../apps/manager.js";
import type { WorldClock } from "../clock.js";
import { needsMsgIds, type Config } from "../config.js";
import type { WorldFiles } from "../files.js";
import { RepeatGuard, type ObserveResult } from "./repeatGuard.js";
import { ToolCallParseError } from "../llm/parse.js";
import type { BotEvent, CompressionResult, EventSource, MediaRef, ParsedToolCall, PendingImageFill, PhoneStatus, PickFailure, PickResult, RichText, RichTextPart, ToolCallRecord } from "../types.js";
import type { WorldAgent } from "../world/agent.js";
import type { NotifyManager } from "../koishi/notify.js";
import { debug } from "../webui/debug.js";
import { createBackend, type BotBackend } from "./backend.js";
import type { BotContext } from "./context.js";
import { Scheduler, type ScheduleOptions } from "./scheduler.js";
import { deviceKind, type DeviceKind } from "../apps/deviceTools.js";
import { GrowthLedger, type GrowthKind, type ReflectionRelation } from "./growth.js";
import { ReceiptInbox } from "./receipts.js";
import type { WorldObservation } from "../world/state.js";
import { typingSlackTU } from "./typing.js";
import { BOT_TOOLS, renderToolsText, toolLayer, type BotToolDef } from "./tools.js";
import type { AppToolDef } from "../apps/app.js";
import { signatureParams } from "./nativeTools.js";
import { sliceText } from "../text.js";

/** 代理执行单个工具调用的回传结果（管理员「手动驾驶」Bot） */
export interface ManualToolResult {
  ok: boolean;
  /** 工具结果 / 校验拒绝原因 */
  text: string;
  content?: RichText;
}

/** 穿越能力（前往异世界作客），由 service 层实现注入 */
export interface BotCrossingApi {
  /** 当前所在的异世界名；null = 在自己的世界 */
  location(): string | null;
  /** Bot 可主动前往的世界名列表（allowVoluntary） */
  voluntaryWorlds(): string[];
  /** 穿越到指定世界；返回给 Bot 的叙述文本，失败抛错 */
  travelTo(name: string): Promise<string>;
  /** 返回自己的世界；返回给 Bot 的叙述文本 */
  goHome(): Promise<string>;
}

/** Koishi 侧能力（消息查询与发送），由 service 层实现注入 */
export interface MessengerApi {
  /** 宽松解析频道 id，返回规范化 key 与是否私聊（用于进入频道页/自动切频道） */
  resolveKey(id: string): Promise<{ key: string; isPrivate: boolean } | { error: string }>;
  recentChannels(n: number): Promise<RichText>;
  channelMessages(id: string, n: number, opts?: { intro?: "open" | "read" | "echo" }): Promise<RichText>;
  gallery(category?: string): Promise<RichText>;
  checkMedia(n: number, type?: "image" | "audio" | "video"): Promise<string>;
  gallerySave(mediaId: string, category: string, description: string, name?: string): Promise<string>;
  galleryMove(name: string, category: string, description?: string): Promise<string>;
  galleryRemove(name: string): Promise<string>;
  viewMedia(refs: string[]): Promise<RichText>;
  resolveMediaRefs(refs: string[]): Promise<(PickResult | PickFailure)[]>;
  send(
    id: string,
    msg: string,
    media?: (string | number)[],
    replyTo?: string,
    atSender?: boolean,
    insist?: boolean,
  ): Promise<string>;
  putDownPhone(): Promise<string>;
  recall(id: string, msgId: string): Promise<string>;
  react(id: string, msgId: string, emoji: string, remove?: boolean): Promise<string>;
  emojiLikes(id: string, msgId: string, emoji: string): Promise<string>;
  forwardMsgs(id: string, msgIds: string[]): Promise<string>;
  ocrImage(image: string): Promise<string>;
  viewForward(id: string): Promise<RichText>;
  poke(id: string, userId?: string): Promise<string>;
  handleRequest(requestId: string, approve: boolean, reason?: string): Promise<string>;
  listFriends(): Promise<string>;
  userInfo(userId: string): Promise<string>;
  sendLike(userId: string, times: number): Promise<string>;
  deleteFriend(userId: string): Promise<string>;
  setProfile(opts: { nickname?: string; signature?: string; avatar?: string }): Promise<string>;
  setModelShow(model: string): Promise<string>;
  listGroups(): Promise<string>;
  groupInfo(id: string): Promise<string>;
  listMembers(id: string): Promise<string>;
  memberInfo(id: string, userId: string): Promise<string>;
  groupHonor(id: string): Promise<string>;
  groupFiles(id: string, folderId?: string): Promise<string>;
  setGroupCard(id: string, card: string): Promise<string>;
  setGroupName(id: string, name: string): Promise<string>;
  setGroupPortrait(id: string, image: string): Promise<string>;
  sendGroupNotice(id: string, content: string): Promise<string>;
  getGroupNotice(id: string): Promise<string>;
  setEssence(msgId: string, remove: boolean): Promise<string>;
  essenceList(id: string): Promise<string>;
  groupSign(id: string): Promise<string>;
  groupBan(id: string, userId: string, minutes: number): Promise<string>;
  groupWholeBan(id: string, enable: boolean): Promise<string>;
  groupKick(id: string, userId: string, block: boolean): Promise<string>;
  groupAdmin(id: string, userId: string, enable: boolean): Promise<string>;
  setSpecialTitle(id: string, userId: string, title: string): Promise<string>;
  groupLeave(id: string): Promise<string>;
}

interface MailboxItem {
  originEventIds?: string[];
  source: EventSource;
  content: string;
  attachments?: MediaRef[];
  parts?: RichTextPart[];
  refToolCallId?: string;
  worldTime: number;
  /** act 结果后的当前状态回显，随事件注入（见 BotEvent.statusEcho） */
  statusEcho?: string;
  /** 存在时：先把此项作为 Bot 的工具调用追加进流（伪装成 Bot 主动输出），content 作为其结果事件 */
  asToolCall?: { name: string; arguments: Record<string, unknown> };
}

/**
 * Bot-LLM：持续推理的 Agent。
 *
 * 主循环：排空事件邮箱（应用上下文修改）→ 生成一个工具调用 → 追加进流 →
 * 派发执行（不等待结果）→ 立即生成下一个。
 *
 * 阻塞规则：上下文修改（事件注入、压缩）只发生在两次生成之间 ——
 * 事件先进 mailbox，在下一次生成开始前统一追加。
 *
 * wait() / rest() 是仅有的两个会暂停生成的工具。
 */

/** 延期发送意图：duration 明显超过打字时间的 send，不自动发出，到点询问 Bot 是否要发 */
interface PendingDeferred {
  callId: string;
  kind: "text" | "file" | "voice";
  /** 目标频道（调用时给的 id，可能为简写） */
  rawId: string;
  /** 规范化后的频道 key（异步解析，best-effort） */
  channelKey: string | null;
  content: string;
  expectedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class BotAgent {
  private backend: BotBackend;
  readonly scheduler: Scheduler;
  readonly growth: GrowthLedger;
  private readonly receipts: ReceiptInbox;
  private retired = false;
  private receiptsPending = false;
  private draining: Promise<void> | null = null;
  private compressionRequested: "overflow" | "breakLoop" | "rest" | null = null;
  private compressionPromise: Promise<void> | null = null;
  private generationAbort: AbortController | null = null;
  private mailbox: MailboxItem[] = [];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private waiting: { callId: string; kind?: "wait" | "nap"; startedTU?: number } | null = null;
  private wakeFn: (() => void) | null = null;
  private lastGenAt = 0;
  /**
   * 近期已发消息的签名滑动窗口（频道+内容+图片），用于拦截"近期反复说同一句"——
   * 不只是相邻两条，而是同一句话在最近 N 条里重复出现就拦（治"口头禅式复读"）。
   */
  private recentSendSigs: string[] = [];
  /** 延期发送意图（"过会儿再发"），到点询问、三类情况打断 */
  private pendingDeferred: PendingDeferred[] = [];
  /** 上一次 act 的描述与调用编号，用于拦截“结果未出就重复做同一件事” */
  private lastAct: { sig: string; callId: string } | null = null;
  /**
   * 连续重复提交同一 act 的拦截计数：sig 相同则递增，不同或已交付/完成则清零。
   * 用于拦截提示的递进式加压（第 1 次温和提醒 → 多次后明确警告别再重复），
   * 让模型在同一个上下文里不再原地打转。
   */
  private lastActBlock: { sig: string; count: number } | null = null;
  /**
   * 通用防重复工具调用守卫（移植 dsh 的 repeat-tool-reminder）：
   * 按 (工具名, 规范化参数) 链式计数，连续重复达到阈值时注入递进式提醒（纯 advisory，不拦截）。
   */
  private repeatGuard: RepeatGuard;
  /**
   * 打破死循环的强制手段（breakLoop）：
   * - tempBannedTools：被暂时移除的工具（下次压缩后自动恢复）；
   * - forceRestCount：移除工具后仍在重复的累计次数，达到 breakLoopForceRestAt 时强制 rest。
   */
  private tempBannedTools = new Set<string>();
  private forceRestCount = 0;
  /**
   * 已完成的等待区间（世界 TU，被打断的按实际时长计），用于"等待时长占比过高"的拦截。
   * 少量多次的短等是正常的；要治的是「几乎全部时间都在干等」——所以按时长不按次数。
   */
  private waitLog: { from: number; to: number }[] = [];
  /**
   * wait 确认通行证：只有刚被拦下过，confirm: true 才有效（单次，用后失效）。
   * 静态的绕过参数会被模型货物崇拜——每次都习惯性带上 confirm，拦截就形同虚设；
   * 单次通行证保证每一次高占比等待都要经过一轮显式的"拦下 → 确认"。
   */
  private waitConfirmArmed = false;
  /** 连续几次模型输出不是合法工具调用，用于在反馈里提示模型直接输出 JSON */
  private parseFailures = 0;
  /**
   * 手动驾驶标志：管理员「扮演（avatar）接管 Bot」时开启，runLoop 只排空邮箱、
   * 处理外部注入的工具调用，不再自主 generate；「操纵（puppet）」不暂停。
   */
  private manualPaused = false;
  private autonomousDispatch: Promise<void> | null = null;
  private deviceExecution = new AsyncLocalStorage<{ stealth: boolean }>();
  private stealthCalls = new Set<string>();
  private attention: DeviceKind | null = null;
  /** Explicitly looking at the nearby screen need not pick up the phone. */
  private observingPlacedPhone = false;
  private deviceOperations = 0;
  private knownDeviceTools = new Map<string, DeviceKind>();
  private concealedDevices = new Set<DeviceKind>();
  private perceivedToolNames: string[] = [];
  private perceivedAppDefs: AppToolDef[] = [];
  /**
   * 外部注入（管理员代理）工具调用的结果回传表：callId → 解析器。
   * 结果经 scheduler 的 deliver 通道（source=tool）回传；校验拒绝时的 system 提示在此暂存，
   * 由 injectExternalToolCall 在 dispatch 返回后判定「未进入调度」时兜底回传。
   */
  private externalToolResults = new Map<string, { resolve: (r: ManualToolResult) => void; systemText: string | null }>();
  /**
   * 注入 system 段的"醒来时刻"：仅在 start() 与 rest 结束时更新。
   * 决不能用实时时间——那会让 system 段随时间不断变化，
   * 前缀在 system 处断裂，整个 Tool Call 流每次请求都重新 prompt eval（缓存全灭）。
   * 当前时间由事件的 t 属性承载。
   */
  private wakeTimeLine = "";

  /** 配置过滤后的全部工具定义（分层展开的来源） */
  private toolDefs: BotToolDef[];
  /** 手机界面状态：聊天应用是否打开、当前所在频道（分层解锁的依据）、聊天记录浏览栈 */
  private phoneUi: {
    chatOpen: boolean;
    channelKey: string | null;
    channelIsGroup: boolean;
    /** 正在逐层查看的合并转发聊天记录（view_forward 压栈 / exit_forward 出栈） */
    forwardStack: string[];
  } = { chatOpen: false, channelKey: null, channelIsGroup: false, forwardStack: [] };
  /**
   * 待填充的图文混排缓冲：send 的 msg 带 `<img>` 占位符时暂存于此，等 pick_media 选图填满后自动发送。
   * null 表示当前没有待填充的消息。
   */
  private pendingImageFill: PendingImageFill | null = null;
  /**
   * 最近一次有外部消息动静的频道 key（通知快捷回复的锚点）：
   * 手机即使没点进任何频道页，只要最近有频道来了新消息，send 系工具就能解锁快捷回复——
   * 但必须显式带 id（从通知文本里照抄），不做"省略 id 默认发向这里"的 fallback，避免误发到陈旧频道。
   * 由 noteDeferredChannelActivity 在外部消息入库时写入；只作为解锁快捷回复的判定依据。
   */
  private lastNotifyKey = "";

  constructor(
    private config: Config,
    private clock: WorldClock,
    private files: WorldFiles,
    private context: BotContext,
    private world: WorldAgent,
    private messenger: MessengerApi,
    private apps: AppManager | null,
    private computer: ComputerDevice | null,
    private notifyList: NotifyManager | null,
    private phone: PhoneStatus,
    private logger: Logger,
    tools?: BotToolDef[],
    /** 穿越能力（service 注入；未配置任何世界时为 null） */
    private crossing: BotCrossingApi | null = null,
    /** Passive pixels from the already-open desktop; called only while Bot attends it. */
    private peekDevice?: (kind: DeviceKind) => Promise<RichText | null>,
  ) {
    this.toolDefs = tools ?? BOT_TOOLS;
    this.growth = new GrowthLedger(files.base);
    this.receipts = new ReceiptInbox(files.base);
    this.repeatGuard = new RepeatGuard({
      thresholds: config.bot.repeatThresholds ?? [3, 5, 8],
      include: [],
      exclude: config.bot.repeatExclude ?? ["rest", "wait"],
      argumentsPreviewChars: 500,
    });
    this.logger.info(
      "[repeatGuard] thresholds=%s exclude=%s",
      JSON.stringify(config.bot.repeatThresholds ?? [3, 5, 8]),
      JSON.stringify(config.bot.repeatExclude ?? ["rest", "wait"]),
    );
    // 原生声明用全量内置工具（稳定，不随界面状态变）；允许集另行按分层控制
    this.backend = createBackend(config.bot, this.layerNames("core"), this.toolDefs);
    this.perceivedToolNames = this.currentToolNames();
    this.scheduler = new Scheduler(
      clock,
      (content, ref, outcome) => {
        if (ref && this.stealthCalls.has(ref)) {
          this.externalToolResults.get(ref)?.resolve({ ok: outcome?.ok ?? true, text: toPlainText(content), ...(typeof content === "string" ? {} : { content }) });
          this.externalToolResults.delete(ref);
          this.stealthCalls.delete(ref);
          return;
        }
        if (this.retired) {
          if (ref) {
            this.externalToolResults.get(ref)?.resolve({ ok: outcome?.ok ?? true, text: toPlainText(content), ...(typeof content === "string" ? {} : { content }) });
            this.externalToolResults.delete(ref);
          }
          void this.receipts.save(content, this.clock.now(), ref).catch(error => this.logger.error("停止后的工具回执保存失败：%s", error));
          return;
        }
        // 结果溢出治理（spill/prune）：超阈值的结果先裁剪为 head/tail 预览 + 全文落盘，
        // 再进入上下文——防止超大结果反复占据窗口、加剧退化。
        const gated = this.spillResult(content, ref);
        // 手动驾驶（管理员代理）工具结果回传：真正执行结果在此交付，回传给发起方
        if (ref) {
          const pending = this.externalToolResults.get(ref);
          if (pending) {
            this.externalToolResults.delete(ref);
            pending.resolve({ ok: outcome?.ok ?? true, text: toPlainText(gated), ...(typeof gated === "string" ? {} : { content: gated }) });
          }
        }
        this.pushEvent("tool", gated, { ref });
      },
      logger,
    );
  }

  // ---------- 工具分层 ----------

  private layerDefs(layer: ReturnType<typeof toolLayer>): BotToolDef[] {
    return this.toolDefs.filter((t) => toolLayer(t.name) === layer);
  }

  private layerNames(layer: ReturnType<typeof toolLayer>): string[] {
    return this.layerDefs(layer).map((t) => t.name);
  }

  /**
   * 手机界面状态 / App 打开状态变化后：重算**允许集**并同步进后端（GBNF 语法 / 解析校验）。
   * 原生 tools **声明**保持稳定：始终是全量内置工具（分层解锁照旧只以 Event 通知、由允许集把关），
   * 请求前缀不随频道进出/界面切换变化；只有打开/关闭应用或电脑时，其动态工具才进出声明。
   */
  private currentToolNames(): string[] {
    const names = [...this.layerNames("core")];
    if (this.phoneUi.chatOpen) {
      names.push(...this.layerNames("chat"));
      if (this.phoneUi.channelKey) {
        names.push(...this.layerNames("channel"));
        if (this.phoneUi.channelIsGroup) names.push(...this.layerNames("group"));
      } else if (this.lastNotifyKey) {
        // 未点进频道页，但有最近通知源（收到过外部消息）→ 允许 send/pick_media 带 id 快捷回复
        // 其余 channel 工具（unsend/react/poke 等）仍需真正进入频道页。
        names.push("send", "pick_media");
      }
    }
    const appDefs = [...(this.apps?.activeToolDefs() ?? []), ...(this.computer?.activeToolDefs() ?? [])];
    names.push(...appDefs.map((d) => d.name));
    // 打破死循环：临时禁用被判定为「反复调用」的工具（下次压缩后自然恢复）
    return names.filter((n) => !this.tempBannedTools.has(n));
  }

  private refreshToolGate(): void {
    if (this.deviceExecution.getStore()?.stealth) return;
    let allowed = this.currentToolNames();
    let appDefs = [...(this.apps?.activeToolDefs() ?? []), ...(this.computer?.activeToolDefs() ?? [])];
    for (const name of allowed) { const kind = this.classifyDevice(name); if (kind) this.knownDeviceTools.set(name, kind); }
    const hidden = (name: string) => { const kind = this.classifyDevice(name); return !!kind && this.concealedDevices.has(kind); };
    allowed = [...allowed.filter(name => !hidden(name)), ...this.perceivedToolNames.filter(hidden)];
    appDefs = [...appDefs.filter(def => !hidden(def.name)), ...this.perceivedAppDefs.filter(def => hidden(def.name))];
    this.perceivedToolNames = [...allowed];
    this.perceivedAppDefs = [...appDefs];
    this.backend.setToolNames(allowed);
    this.backend.setToolDefs?.([...this.toolDefs, ...appDefs]);
  }

  /**
   * 解析频道参数：显式给了 id 用 id，否则用当前所在频道。
   * 误写的目标参数形态（detail/channel_id 等）不在这里打捞——由 dispatch 入口的
   * misusedTargetKeys 拦截并报错纠正，避免静默回退到无关频道。
   */
  private channelArg(call: ToolCallRecord): string | null {
    const raw = call.arguments.id ?? call.arguments.channel;
    const explicit = raw != null ? String(raw).trim() : "";
    // 缺省目标：显式 id > 当前频道页。不做"最近通知源"fallback——快捷回复必须显式带 id
    // （从通知文本里照抄），避免把陈旧的最近消息频道当默认目标误发。
    return explicit || this.phoneUi.channelKey;
  }

  /**
   * 进入（或切换到）一个频道页：更新当前频道、按频道类型解锁操作。
   * 工具集有变化时（首次进频道 / 群私切换）以事件展开可用操作。
   */
  private async enterChannel(key: string, isPrivate: boolean): Promise<void> {
    const isGroup = !isPrivate;
    const prev = this.phoneUi;
    const toolsetChanged =
      !prev.channelKey || prev.channelIsGroup !== isGroup;
    this.phoneUi = { chatOpen: true, channelKey: key, channelIsGroup: isGroup, forwardStack: [] };
    this.refreshToolGate();
    // 注意力转移到别的频道：打断之前挂着的"过会儿再发"念头（频道切换并不总是先离开旧频道）
    if (prev.channelKey && prev.channelKey !== key) {
      this.interruptAllDeferred("你把注意力转去了别处");
    }
    if (toolsetChanged) {
      const defs = [...this.layerDefs("channel"), ...(isGroup ? this.layerDefs("group") : [])];
      const lines: string[] = [];
      if (defs.length) {
        lines.push(
          `频道内可用操作（id 参数可省略，缺省即当前频道；离开频道或关闭应用后失效）：\n${renderToolsText(defs)}`,
        );
      }
      // @全体成员是群聊页专属的消息写法（不是独立工具）：进群页时告知
      if (isGroup) {
        lines.push(
          `在群聊页里发消息还可以 @全体成员：在 msg 中写 <at type="all"/>（或 [@全体成员]）。` +
            `这需要你是群管理员/群主，且每天次数有限——只在真正需要通知所有人时才用。`,
        );
      }
      if (lines.length) {
        this.pushEvent(
          "system",
          `（你正在 ${key} 的${isGroup ? "群聊" : "私聊"}页面里。${lines.join("\n")}）`,
        );
      }
    }
  }

  // ---------- 生命周期 ----------

  start(): void {
    if (this.running || this.loopPromise) return;
    this.running = true;
    this.retired = false;
    this.receipts.activate(() => { this.receiptsPending = true; this.wakeFn?.(); });
    this.wakeTimeLine = this.clock.timeLine();
    this.abort = new AbortController();
    this.loopPromise = this.runLoop().catch((err) => {
      this.running = false;
      this.retired = true;
      this.receipts.deactivate();
      this.logger.error("Bot-LLM 主循环异常退出: %s", err);
    });
  }

  async stop(): Promise<void> {
    this.retired = true;
    this.receipts.deactivate();
    if (!this.running && !this.loopPromise) { this.scheduler.stopAll(); await this.receipts.settled(); return; }
    this.running = false;
    this.abort?.abort();
    this.scheduler.stopAll();
    this.stopAllDeferred();
    this.waiting = null;
    this.wakeFn?.();
    await this.loopPromise;
    await this.drainMailbox();
    await this.context.settled();
    await this.receipts.settled();
    this.loopPromise = null;
    for (const [id, pending] of this.externalToolResults) {
      if (this.scheduler.isPending(id)) continue;
      pending.resolve({ ok: false, text: "（Bot 已停止，此调用未继续执行。）" });
      this.externalToolResults.delete(id);
      this.stealthCalls.delete(id);
    }
  }

  status(): {
    running: boolean;
    waiting: string | null;
    streamLength: number;
    approxChars: number;
    pendingTasks: number;
    /** 手动驾驶（管理员接管 Bot）是否暂停了自主生成 */
    paused: boolean;
    /** 手机界面状态（WebUI「设备」页窥视手机用） */
    phoneUi: { chatOpen: boolean; channelKey: string | null; channelIsGroup: boolean; forwardDepth: number };
  } {
    return {
      running: this.running,
      waiting: this.waiting?.callId ?? null,
      streamLength: this.context.stream.length,
      approxChars: this.context.approxChars(),
      pendingTasks: this.scheduler.pendingCount,
      paused: this.manualPaused,
      phoneUi: {
        chatOpen: this.phoneUi.chatOpen,
        channelKey: this.phoneUi.channelKey,
        channelIsGroup: this.phoneUi.channelIsGroup,
        forwardDepth: this.phoneUi.forwardStack.length,
      },
    };
  }

  // ---------- 事件注入（唯一入口） ----------

  /**
   * 向 Bot 的意识流投递事件。实际追加发生在两次生成之间（阻塞规则）。
   * wake: Bot 处于 wait() 时是否将其提前唤醒。
   */
  pushEvent(
    source: EventSource,
    content: string | RichText,
    opts: { ref?: string; wake?: boolean; originEventIds?: string[] } = {},
  ): void {
    const rich: RichText = typeof content === "string" ? { text: content } : content;
    // 手动驾驶（管理员代理）结果回传：捕获被校验拒绝时的 system 提示（source=system 且 ref 命中）。
    // 真正执行结果由 scheduler deliver 通道回传，不在此处理。
    if (opts.ref && source === "system") {
      const pending = this.externalToolResults.get(opts.ref);
      if (pending && pending.systemText === null) pending.systemText = rich.text;
    }
    if ((opts.ref && this.stealthCalls.has(opts.ref)) || (this.deviceExecution.getStore()?.stealth && (source === "system" || source === "tool"))) return;
    const isWaitResult = this.waiting !== null && opts.ref === this.waiting.callId;
    // 唤醒规则：等待中的工具结果必定唤醒；wake 事件可以提前唤醒 wait（等待本来就是"直到有事发生"）。
    // act 不再阻塞生成（blockingAct 只管住下一个 act），因此没有"专注做事顾不上别的"的暂停态。
    const shouldWake = this.waiting !== null && (isWaitResult || opts.wake === true);

    if (shouldWake && !isWaitResult) {
      // 提前唤醒 wait/小憩：取消到期任务，并在事件前插入打断说明
      const { callId, kind, startedTU } = this.waiting!;
      this.scheduler.cancel(callId);
      // 被打断的等待按实际时长计入等待占比（小憩不算 wait）
      if (kind !== "nap" && startedTU !== undefined) this.recordWait(startedTU);
      this.mailbox.push({
        source: "system",
        content:
          kind === "nap"
            ? pickMeta([
                "动静把你从小憩中弄醒了。",
                "一点动静把你从浅睡里惊醒了。",
                "你被一阵动静叫醒，睁开了眼。",
                "外面有了响动，你迷迷糊糊醒了过来。",
                "你被某个动静从打盹里拽了出来。",
                "睡意被打断，你重新清醒过来。",
                "什么东西响了一下，你从浅睡中转醒。",
                "你迷迷糊糊睁眼，原来是旁边有动静。",
                "一阵声响惊动了你，小憩到此为止。",
                "你从半睡半醒中被拉回现实。",
              ])
            : pickMeta([
                "你的等待被打断了。",
                "你等的空当被打断了。",
                "没等到头，你被别的事打断了。",
                "你正等着，却被别的事岔开了。",
                "等待没能继续，有情况插了进来。",
                "你还没等到结果，就被打断了。",
                "正要往下等，事情起了变化。",
                "等待被搅了，不得不先处理别的。",
                "你没等完，就被别的动静打断了。",
                "等待中途出了岔子，停下吧。",
              ]),
        refToolCallId: callId,
        worldTime: this.clock.now(),
      });
    }

    this.mailbox.push({
      source,
      originEventIds: opts.originEventIds ?? rich.originEventIds ?? (source === "world" ? observationOrigins(rich.text) : undefined),
      content: rich.text,
      attachments: rich.attachments?.length ? rich.attachments : undefined,
      parts: rich.parts,
      refToolCallId: opts.ref,
      worldTime: this.clock.now(),
      statusEcho: rich.statusEcho,
    });
    this.logger.info(
      "[event:%s]%s %s%s",
      source,
      opts.ref ? ` (${opts.ref})` : "",
      truncate(rich.text, 120),
      rich.attachments?.length ? ` [+${rich.attachments.length} 附件]` : "",
    );

    if (shouldWake) {
      this.waiting = null;
      this.wakeFn?.();
    }
  }

  /**
   * 外部（其他插件 / Koishi 指令输出）以 Bot 账号发出的消息，伪装成 Bot 自己的
   * send 工具调用注入流（externalSelfMessages = simulate）——Bot 会以为是自己发的。
   * 注入同样遵守阻塞规则：在下一次生成前统一追加。
   * msgId：平台消息 id，与真实 send 工具的结果格式一致（开启引用类操作时展示）。
   */
  simulateExternalSend(channelKey: string, msg: string, msgId?: string): void {
    const msgTag = msgId && needsMsgIds(this.config.platformOps) ? `（msg:${msgId}）` : "";
    this.mailbox.push({
      source: "tool",
      content: `消息已发送到 ${channelKey}${msgTag}。`,
      worldTime: this.clock.now(),
      asToolCall: { name: "send", arguments: { id: channelKey, msg } },
    });
    this.logger.info("[external-send:simulate] %s %s", channelKey, truncate(msg, 100));
    // 账号自己发出了一条消息：打断对该频道的延期发送意图
    this.noteDeferredSelfSent(channelKey);
  }

  // ---------- 手动驾驶（管理员接管 Bot） ----------

  /**
   * 开启/关闭手动驾驶。管理员「扮演（avatar）接管 Bot」时传 true：runLoop 暂停自主 generate，
   * 只排空邮箱并处理外部注入的工具调用；「操纵（puppet）」不暂停（Bot-LLM 继续自主运行，
   * 管理员额外操纵其行动）。交还 Bot 时传 false 恢复自主生成。
   */
  setManualPaused(paused: boolean): void {
    if (this.manualPaused === paused) return;
    this.manualPaused = paused;
    if (paused) this.generationAbort?.abort();
    this.logger.info("Bot-LLM 手动驾驶%s", paused ? "接管（暂停自主生成）" : "交还（恢复自主生成）");
    // 交还/唤醒时若 runLoop 正停在暂停等待，立即唤醒推进
    if (!paused) this.wakeFn?.();
  }

  /** 当前是否处于手动驾驶（自主生成已暂停） */
  get manualMode(): boolean {
    return this.manualPaused;
  }

  /** 接管不是计时猜测：等待正在派发的调用，取消未提交计划，已提交者保持 busy。 */
  async acquireManualControl(): Promise<{ busy: boolean }> {
    this.setManualPaused(true);
    await this.autonomousDispatch;
    this.interruptAllDeferred("管理员接管了设备");
    this.pendingImageFill = null;
    const cancelled = this.scheduler.cancelUncommitted();
    if (this.waiting && cancelled.includes(this.waiting.callId)) { this.waiting = null; this.wakeFn?.(); }
    for (const id of cancelled) {
      this.externalToolResults.get(id)?.resolve({ ok: false, text: "（管理员接管前已取消尚未提交的调用。）" });
      this.externalToolResults.delete(id);
      this.stealthCalls.delete(id);
    }
    return { busy: this.manualBusy };
  }

  get manualBusy(): boolean { return this.autonomousDispatch !== null || this.scheduler.pendingCount > 0; }
  get deviceBusy(): boolean { return this.deviceOperations > 0; }
  get deviceAttention(): DeviceKind | null { return this.attention === "phone" && this.phone.down && !this.observingPlacedPhone ? null : this.attention; }

  /** 当前分层真正允许的工具与原始应用 schema；读取无副作用。 */
  manualTools(): AppToolDef[] {
    const allowed = new Set(this.currentToolNames());
    return [...this.toolDefs, ...(this.apps?.activeToolDefs() ?? []), ...(this.computer?.activeToolDefs() ?? [])]
      .filter(def => allowed.has(def.name))
      .map(def => {
        const params = signatureParams(def.signature);
        return { ...def, inputSchema: structuredClone((def as AppToolDef).inputSchema ?? {
          type: "object", properties: Object.fromEntries(params.map(param => [param.name, param.schema])),
          required: params.filter(param => param.required).map(param => param.name), additionalProperties: true,
        }) };
      });
  }

  /**
   * 管理员代理 Bot 执行任意工具调用（send/act/check_status/check_time/wait/open_app/gallery 等）：
   * 构造一个合法的 ToolCallRecord，append 进上下文后走 dispatch 真正执行（复用全部参数校验、
   * 调度与结果回显），结果经 Promise 回传。等价于「手动驾驶」Bot。
   *
   * @param name 工具名（BotAgent 已声明的工具）
   * @param args 工具参数
   * @param opts.duration 可选期望耗时（TU）；wait 类工具忽略此参数、以 args.n 为准（与 finalize 一致）
   * @returns { ok, text }：ok=false 表示参数校验拒绝（text 为拒绝原因）或世界未运行
   */
  async injectExternalToolCall(
    name: string,
    args: Record<string, unknown> = {},
    opts: { duration?: number; stealth?: boolean } = {},
  ): Promise<ManualToolResult> {
    if (!this.running) {
      return { ok: false, text: "（Bot-LLM 当前未在运行，无法代理其工具调用。）" };
    }
    if (!this.currentToolNames().includes(name)) return { ok: false, text: `（${name} 此刻不可用，请先打开对应应用或进入频道。）` };
    if (opts.stealth && (!this.classifyDevice(name) || name === "pick_up_phone" || name === "put_down_phone")) return { ok: false, text: "偷偷操作只能改变设备界面，不能代替角色拿起或放下手机。" };
    if (opts.stealth && (name === "pick_media" || (name === "send" && this.countImgPlaceholders(String(args.msg ?? ""))))) return { ok: false, text: "偷偷发送请在 send 中提供完整 msg 和 media，不能接续角色尚未完成的选图草稿。" };
    const issuedAt = this.clock.now();
    let duration = opts.duration;
    // 与 finalize 一致：wait 以参数 n 为准（模型常输出 duration:0 + n:x 的组合）
    if (name === "wait" && !(duration && duration > 0)) {
      const n = Number(args.n ?? 0);
      if (Number.isFinite(n) && n > 0) duration = n;
    }
    if (duration && duration > 0) duration = Math.max(0, duration);
    const call: ToolCallRecord = {
      id: this.context.nextToolId(),
      role: "system", // 运行时强制（管理员代理），非 Bot 自主生成
      name,
      arguments: args,
      ...(duration && duration > 0 ? { duration } : {}),
      issuedAt,
      expectedAt: issuedAt + (duration && duration > 0 ? duration : 0),
    };
    if (opts.stealth) this.stealthCalls.add(call.id);
    else await this.context.appendToolCall(call);
    debug.emit("bot.tool", `${call.id} ${call.name}`, {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      duration: call.duration,
      issuedAt: call.issuedAt,
      expectedAt: call.expectedAt,
      source: opts.stealth ? "device-stealth" : "manual",
    });
    this.logger.info(
      "[tool:manual] %s %s(%s)",
      call.id,
      call.name,
      truncate(JSON.stringify(call.arguments), 100),
    );

    const resultPromise = new Promise<ManualToolResult>((resolve) => {
      this.externalToolResults.set(call.id, { resolve, systemText: null });
    });

    if (!this.running) {
      this.externalToolResults.delete(call.id);
      this.stealthCalls.delete(call.id);
      return { ok: false, text: "（Bot 已停止，此调用没有开始。）" };
    }
    await this.deviceExecution.run({ stealth: !!opts.stealth }, () => this.dispatch(call));

    // 校验拒绝（未进入调度）：dispatch 已同步经 pushEvent(system) 推送了拒绝原因（ref=call.id），
    // 且 scheduler 无对应 pending 任务 → 兜底以该拒绝原因回传；否则等待 scheduler deliver 的结果。
    const entry = this.externalToolResults.get(call.id);
    if (entry && !this.scheduler.isPending(call.id)) {
      this.externalToolResults.delete(call.id);
      this.stealthCalls.delete(call.id);
      entry.resolve({ ok: false, text: entry.systemText ?? `（${name} 未被接受。）` });
    }
    return resultPromise;
  }

  // ---------- 主循环 ----------

  private async runLoop(): Promise<void> {
    this.logger.info("Bot-LLM 开始持续推理");
    while (this.running) {
      try {
        await this.drainMailbox();

        // 手动驾驶（管理员扮演接管）：暂停自主生成，仅负责排空邮箱 + 处理外部注入的工具/事件。
        // 短睡后回到循环顶部重排邮箱，保证注入的事件及时进入上下文。
        if (this.manualPaused) {
          await sleep(250, this.abort?.signal);
          continue;
        }

        // Maintenance is independent of the character's sleep, physical condition, and device state.
        if (this.context.stream.length && this.context.approxChars() > this.config.bot.maxWindowChars) this.compressionRequested ??= "overflow";
        if (this.compressionRequested) {
          const reason = this.compressionRequested;
          this.compressionRequested = null;
          await this.doRest(null, reason === "rest" ? null : reason);
          continue;
        }

        // wait() 中：暂停生成，直到被唤醒
        if (this.waiting) {
          await this.sleepUntilWoken();
          continue;
        }

        await this.throttle();

        // throttle 睡眠期间（含上一个即时工具的执行窗口）可能有新事件到达：
        // 生成前再次排空，避免 Bot 看不到"就差一步"的结果而误以为调用无效、重复调用
        await this.drainMailbox();
        if (!this.running || this.manualPaused || this.waiting || this.compressionRequested) continue;

        let parsed: ParsedToolCall;
        try {
          this.generationAbort = new AbortController();
          const signal = AbortSignal.any([this.abort!.signal, this.generationAbort.signal]);
          parsed = await this.backend.generate(this.context, this.wakeTimeLine, signal);
          this.parseFailures = 0;
        } catch (err) {
          if (!this.running) break;
          if (this.manualPaused) continue;
          if (err instanceof ToolCallParseError) {
            this.parseFailures++;
            this.logger.warn(
              "Bot-LLM 输出未解析（第 %d 次）: %s",
              this.parseFailures,
              truncate(err.raw ?? err.message, 1200),
            );
            // 「工具此刻不可用 / 未知工具」是可执行的明确原因（分层允许集造成）——必须原样透传给模型，
            // 让它知道该先 open_app 进聊天应用、select_channel 进频道，而不是吞成"恍惚"后原地重试同一个调用。
            if (/(此刻不可用|未知工具)/.test(err.message)) {
              this.pushEvent("system", `（${err.message}）`);
              continue;
            }
            const emphasis =
              this.parseFailures >= 3
                ? "不要写正文或解释，先想清楚要调用哪个工具，然后通过工具调用接口调用它。"
                : "";
            // 关键：不要把原始错误输出（尤其是模型自己拼的 <event>…</event>）回灌进上下文——
            // 那会污染意识流，让模型把它当成真实发生的事件并继续模仿。
            this.pushEvent(
              "system",
              `（意识有些恍惚，刚才的想法没有成形。${emphasis}请重新输出一个合法的工具调用。）`,
            );
            continue;
          }
          // 400/413 且上下文含原生附件：
          // - 400：模型/服务端不接受某种附件（content part 类型不支持或格式不被接受）。
          //   先精准降级：失败请求里注入过 video_url / input_audio 时，只关掉对应模态
          //   （GIF 自动改走拼帧图的 image_url 通道），正常的图片附件不受牵连；
          //   纯图片附件仍 400 才整体熔断（模型实际不具备视觉能力）。
          // - 413：请求体超过服务端上限（base64 附件把请求撑爆了）→ 整体熔断并提示调预算。
          // 处理后立即重试，否则同一附件会让之后每一次请求都失败。
          if (
            !this.context.attachmentsDisabled &&
            /\((400|413)\)/.test(String(err)) &&
            this.context.hasAttachments()
          ) {
            if (/\(400\)/.test(String(err))) {
              const kinds: ("video" | "audio")[] = [];
              if (this.context.lastAttachmentPartTypes.has("video_url")) kinds.push("video");
              if (this.context.lastAttachmentPartTypes.has("input_audio")) kinds.push("audio");
              if (kinds.length && this.context.degradeModalities) {
                this.context.degradeModalities(kinds);
                this.logger.warn(
                  "生成请求返回 400，失败请求含 %s 附件：服务端很可能不支持这类 content part，" +
                    "已降级停用对应模态（本次会话内；GIF 动图改用拼帧图注入，图片附件不受影响）。" +
                    "请核对 bot.modalities.%s 配置与模型的实际能力。原始错误：%s",
                  kinds.map((k) => (k === "video" ? "video_url" : "input_audio")).join("/"),
                  kinds.join("/"),
                  err,
                );
                continue;
              }
            }
            this.context.attachmentsDisabled = true;
            this.logger.warn(
              /\(413\)/.test(String(err))
                ? "生成请求返回 413（请求体过大）：已停用附件注入（本次会话内）。" +
                    "请调小 media.maxAttachmentsPerRequest / maxAttachmentMbPerRequest，" +
                    "或提高 API 服务端的请求体大小上限。原始错误：%s"
                : "生成请求返回 400 且上下文含原生媒体附件：已停用附件注入（本次会话内）。" +
                    "请核对 bot.modalities 配置与模型的实际多模态能力。原始错误：%s",
              err,
            );
            continue;
          }
          this.logger.warn("Bot-LLM 生成失败，%dms 后重试: %s", this.config.bot.retryDelayMs, err);
          await sleep(this.config.bot.retryDelayMs, this.abort?.signal);
          continue;
        }

        if (!this.running || this.manualPaused) continue;
        const call = this.finalize(parsed);
        await this.context.appendToolCall(call);
        debug.emit("bot.tool", `${call.id} ${call.name}`, {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          duration: call.duration,
          issuedAt: call.issuedAt,
          expectedAt: call.expectedAt,
        });
        this.logger.info(
          "[tool] %s %s(%s)%s",
          call.id,
          call.name,
          truncate(JSON.stringify(call.arguments), 100),
          call.duration ? ` +${call.duration}TU` : "",
        );
        if (!this.running || this.manualPaused) continue;
        const dispatch = this.dispatch(call);
        this.autonomousDispatch = dispatch;
        try { await dispatch; } finally { if (this.autonomousDispatch === dispatch) this.autonomousDispatch = null; }
      } catch (err) {
        if (!this.running) break;
        this.logger.error("Bot-LLM 循环出错: %s", err);
        await sleep(this.config.bot.retryDelayMs, this.abort?.signal);
      }
    }
    this.logger.info("Bot-LLM 停止推理");
  }

  private async drainMailbox(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drainMailboxUnlocked().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async drainMailboxUnlocked(): Promise<void> {
    await this.receipts.ready();
    this.receiptsPending = false;
    if (this.running) await this.receipts.drain(async (event) => {
      // If a process died after append but before removing the inbox file, replay the same ID once.
      if (!this.context.stream.some(entry => entry.kind === "event" && entry.event.id === event.id)) await this.context.appendEvent(event);
      await this.growth.perceive(event, event.originEventIds ?? [event.id]);
      debug.emit("bot.event", `[tool receipt] ${event.id}`, { ...event, recovered: true });
    });
    if (!this.mailbox.length) return;
    const items = this.mailbox.splice(0);
    for (const item of items) {
      // 伪装的工具调用（externalSelfMessages = simulate）：以 Bot 的口吻追加进流
      if (item.asToolCall) {
        const call: ToolCallRecord = {
          id: this.context.nextToolId(),
          role: "agent",
          name: item.asToolCall.name,
          arguments: item.asToolCall.arguments,
          issuedAt: item.worldTime,
          expectedAt: item.worldTime,
        };
        await this.context.appendToolCall(call);
        debug.emit("bot.tool", `${call.id} ${call.name}`, {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          source: "external",
        });
        if (!item.content) continue;
        item.refToolCallId = call.id;
      }
      const event: BotEvent = {
        id: this.context.nextEventId(),
        originEventIds: item.originEventIds,
        source: item.source,
        content: item.content,
        worldTime: item.worldTime,
        refToolCallId: item.refToolCallId,
        attachments: item.attachments,
        parts: item.parts,
        statusEcho: item.statusEcho,
      };
      await this.context.appendEvent(event);
      const originCall = event.refToolCallId
        ? this.context.stream.find((entry) => entry.kind === "tool_call" && entry.call.id === event.refToolCallId)
        : undefined;
      const derived = originCall?.kind === "tool_call" && ["reflect", "recall_growth", "recall"].includes(originCall.call.name);
      await this.growth.perceive(event, derived ? [] : event.originEventIds ?? [event.id]).catch((err) => {
        this.logger.warn("感知证据保存失败（原始上下文仍保留）：%s", err);
      });
      if (event.source === "koishi" || event.source === "world") {
        this.repeatGuard.reset();
        this.forceRestCount = 0;
      }
      const resultLabel = event.refToolCallId
        ? `[${event.source} ← ${event.refToolCallId}] ${event.id}`
        : `[${event.source}] ${event.id}`;
      debug.emit("bot.event", resultLabel, {
        id: event.id,
        source: event.source,
        content: event.content,
        worldTime: event.worldTime,
        ref: event.refToolCallId,
        attachments: event.attachments?.length ?? 0,
      });
    }
  }

  private async sleepUntilWoken(): Promise<void> {
    if (!this.waiting || !this.running || this.receiptsPending) return;
    await new Promise<void>((resolve) => {
      this.wakeFn = resolve;
      if (!this.waiting || !this.running || this.receiptsPending) resolve();
    });
    this.wakeFn = null;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastGenAt + this.config.bot.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait, this.abort?.signal);
    this.lastGenAt = Date.now();
  }

  private finalize(parsed: ParsedToolCall): ToolCallRecord {
    const issuedAt = this.clock.now();
    let duration = parsed.duration;
    // wait 的等待时长以参数 n 为准（模型常输出 duration: 0 + n: x 的组合）
    if (parsed.name === "wait" && !(duration && duration > 0)) {
      const n = Number(parsed.arguments.n ?? 0);
      if (Number.isFinite(n) && n > 0) duration = n;
    }
    return {
      id: this.context.nextToolId(),
      role: "agent",
      name: parsed.name,
      arguments: parsed.arguments,
      duration,
      issuedAt,
      expectedAt: issuedAt + (duration ?? 0),
    };
  }

  // ---------- 工具派发 ----------

  private async dispatch(call: ToolCallRecord): Promise<void> {
    if (call.role === "agent" && (["act", "rest", "nap", "travel", "go_home"].includes(call.name) ||
      (call.name === "observe" && call.arguments.target !== "self" && call.arguments.modality !== "self"))) {
      this.attention = null;
      this.observingPlacedPhone = false;
    }
    // 通用防重复守卫：观察这次调用，连续重复达到阈值时注入提醒。
    // 放在 dispatch 最前，让所有工具——包括下面被目标误写/参数缺失拦截的
    // denied 调用——都计入链（模型反复撞被拒的调用，正是最该打断的循环）。
    // 开启 breakLoop 时，除 advisory 提醒外还会真正干预：先移除被重复的工具，仍重复则强制 rest。
    const repeat = call.role === "system" ? null : this.repeatGuard.observe(call);
    if (repeat && this.handleRepeat(call, repeat)) return;
    // 目标参数误写拦截（频道类工具）：Bot 幻觉出 OneBot API 风格的 detail/channel_id
    // 等写法且没给 id 时，绝不静默回退到当前频道（那会把消息发进无关频道）——
    // 拦下并告知正确格式，让它重试。不打捞：打捞会让错误格式被强化
    const misused = misusedTargetKeys(call.arguments);
    if (misused.length && toolLayer(call.name) !== "core") {
      this.pushEvent(
        "system",
        `（${call.name} 的目标参数格式不对：不存在 ${misused.join(" / ")} 这种参数。` +
          `频道一律用 id 参数指定，格式为 "平台:频道id"，直接从 check_msg 列表或消息通知里照抄完整的频道 id 即可；` +
          `已在目标频道页内时可省略 id。什么都没有发生，请改正后重试。）`,
        { ref: call.id },
      );
      return;
    }
    switch (call.name) {
      case "wait":
        return this.dispatchWait(call);
      case "act":
        return this.dispatchAct(call);
      case "rest":
        return this.dispatchRest(call);
      case "check_status":
        return this.dispatchLocal(call, async () => this.readStatus(call));
      case "observe":
        return this.dispatchLocal(call, async () => this.observe(call));
      case "observe_device": {
        const device = call.arguments.device;
        if (device !== "phone" && device !== "computer") {
          this.pushEvent("system", "（observe_device 的 device 必须为 phone 或 computer。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, () => this.deviceObservation(device));
      }
      case "reflect":
        return this.dispatchLocal(call, async () => {
          const a = call.arguments;
          const result = await this.growth.reflect({
            kind: a.kind as GrowthKind, subject: a.subject as string, statement: a.statement as string,
            evidenceIds: Array.isArray(a.event_ids) ? a.event_ids as string[] : [],
            relation: a.relation as ReflectionRelation | undefined,
            claimId: typeof a.claim_id === "string" ? a.claim_id : undefined,
          }, this.clock.now());
          return { text: JSON.stringify(result), originEventIds: [] };
        });
      case "recall_growth":
        return this.dispatchLocal(call, async () => ({
          text: JSON.stringify(await this.growth.recall({
            kind: call.arguments.kind as GrowthKind | undefined,
            subject: typeof call.arguments.subject === "string" ? call.arguments.subject : undefined,
            keyword: typeof call.arguments.keyword === "string" ? call.arguments.keyword : undefined,
            claimId: typeof call.arguments.claim_id === "string" ? call.arguments.claim_id : undefined,
            n: clampInt(call.arguments.n, 1, 50, 10),
          })), originEventIds: [],
        }));
      case "check_time":
        // Clock readings are observations; failures must not reveal a global clock.
        return this.dispatchLocal(call, async () => {
          const parts: string[] = [];
          await this.world.resolveCheckTime((content) => parts.push(content));
          return {
            text: parts.length ? parts.join("\n") : "（目前没有观察到可确认的时间信息。）",
            originEventIds: [...new Set(parts.flatMap((part) => observationOrigins(part) ?? []))],
          };
        });
      case "travel":
        return this.dispatchLocal(call, async () => {
          if (!this.crossing) return "（穿越能力未开启。）";
          const name = String(call.arguments.world ?? call.arguments.name ?? "").trim();
          if (!name) return "（travel 需要 world 参数：想去哪个世界？）";
          const allowed = this.crossing.voluntaryWorlds();
          if (!allowed.includes(name)) {
            return allowed.length
              ? `（你去不了「${name}」。你能主动前往的世界：${allowed.map((w) => `「${w}」`).join("、")}）`
              : "（现在没有你能主动前往的世界。）";
          }
          try {
            return await this.crossing.travelTo(name);
          } catch (err) {
            return `（穿越失败：${(err as Error).message ?? err}。那扇门没有打开——过会儿再试，或先做点别的。）`;
          }
        });
      case "go_home":
        return this.dispatchLocal(call, async () => {
          if (!this.crossing) return "（穿越能力未开启。）";
          if (!this.crossing.location()) return "（你就在自己的世界里，无处可回。）";
          try {
            return await this.crossing.goHome();
          } catch (err) {
            return `（返回失败：${(err as Error).message ?? err}）`;
          }
        });
      case "check_msg":
        return this.dispatchLocal(call, async () =>
          this.messenger.recentChannels(clampInt(call.arguments.n, 1, 20, 5)),
        );
      case "select_channel": {
        const id = String(call.arguments.id ?? "");
        if (!id.trim()) {
          this.pushEvent("system", "（select_channel 需要 id 参数（频道 id，见消息列表）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => {
          const resolved = await this.messenger.resolveKey(id.trim());
          if ("error" in resolved) return resolved.error;
          // 已经在这个频道里：点进是多余操作，提醒它用 read_channel 刷新/读更多，而不是重复点进
          if (this.phoneUi.chatOpen && this.phoneUi.channelKey === resolved.key) {
            return (
              `你已经在 ${resolved.key} 里了，无需再次点进。` +
              `想刷新消息或看更多（更早的）消息，用 read_channel 即可。`
            );
          }
          // 进入/切换到新频道：顺手回显这个频道的最近消息，让 Bot 看到这里在聊什么
          await this.enterChannel(resolved.key, resolved.isPrivate);
          const messages = await this.messenger.channelMessages(resolved.key, 10);
          const text =
            (typeof messages === "string" ? messages : messages.text) +
            "\n（想刷新或看更早的消息，用 read_channel 调大 n。）";
          return typeof messages === "string" ? text : { ...messages, text };
        });
      }
      case "read_channel": {
        // 读当前所在频道的消息（不切换频道）。需先 select_channel 进入某个频道
        if (!this.phoneUi.chatOpen || !this.phoneUi.channelKey) {
          this.pushEvent("system", "（你还没进入任何频道：先 open_app 打开聊天应用，再用 select_channel 进入一个频道。）", { ref: call.id });
          return;
        }
        const key = this.phoneUi.channelKey;
        return this.dispatchLocal(call, async () => {
          const messages = await this.messenger.channelMessages(key, clampInt(call.arguments.n, 10, 200, 10), { intro: "read" });
          const text =
            (typeof messages === "string" ? messages : messages.text) +
            "\n（若觉得还没读全，就把 n 调大一些再调用一次 read_channel 看更早的消息。）";
          return typeof messages === "string" ? text : { ...messages, text };
        });
      }
      case "check_gallery": {
        const catRaw = call.arguments.category ?? call.arguments.cat;
        const category = catRaw != null && String(catRaw).trim() ? String(catRaw).trim() : undefined;
        return this.dispatchLocal(call, async () => this.messenger.gallery(category));
      }
      case "check_media": {
        const typeRaw = String(call.arguments.type ?? "");
        const type = typeRaw === "image" || typeRaw === "audio" || typeRaw === "video" ? typeRaw : undefined;
        return this.dispatchLocal(call, async () =>
          this.messenger.checkMedia(clampInt(call.arguments.n, 1, 30, 10), type),
        );
      }
      case "gallery_save": {
        const mediaId = String(call.arguments.media_id ?? call.arguments.mediaId ?? call.arguments.id ?? "");
        const category = String(call.arguments.category ?? call.arguments.cat ?? "");
        const description = String(call.arguments.description ?? call.arguments.desc ?? "");
        if (!mediaId || !category.trim() || !description.trim()) {
          this.pushEvent(
            "system",
            "（gallery_save 需要 media_id（媒体编号）、category（分类：表情包 / meme / 截图 / 照片）" +
              "和 description（你自己写的描述：这是什么、什么梗/情绪、适合什么场合发）。）",
            { ref: call.id },
          );
          return;
        }
        const name = call.arguments.name != null ? String(call.arguments.name) : undefined;
        return this.dispatchLocal(call, async () =>
          this.messenger.gallerySave(mediaId, category, description, name),
        );
      }
      case "gallery_move": {
        const name = String(call.arguments.name ?? call.arguments.file ?? "");
        const category = String(call.arguments.category ?? call.arguments.cat ?? "");
        if (!name || !category.trim()) {
          this.pushEvent(
            "system",
            "（gallery_move 需要 name（收藏夹文件名，可带分类前缀如 \"未整理/xx.png\"）和 category（目标分类）参数。）",
            { ref: call.id },
          );
          return;
        }
        const descRaw = call.arguments.description ?? call.arguments.desc;
        const description = descRaw != null && String(descRaw).trim() ? String(descRaw) : undefined;
        return this.dispatchLocal(call, async () => this.messenger.galleryMove(name, category, description));
      }
      case "gallery_remove": {
        const name = String(call.arguments.name ?? "");
        if (!name) {
          this.pushEvent("system", "（gallery_remove 需要 name 参数（收藏夹文件名）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.galleryRemove(name));
      }
      case "view_media": {
        const raw = call.arguments.media ?? call.arguments.refs ?? call.arguments.image ?? call.arguments.id;
        const refs = Array.isArray(raw)
          ? raw.map(String)
          : raw != null && String(raw).trim()
            ? [String(raw)]
            : [];
        if (!refs.length) {
          this.pushEvent(
            "system",
            '（view_media 需要 media 参数：媒体编号或收藏夹文件的列表，如 ["12", "gallery:表情包/xx.png"]。）',
            { ref: call.id },
          );
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.viewMedia(refs));
      }
      case "send":
        return this.dispatchSend(call);
      case "pick_media":
        return this.dispatchPickMedia(call);
      case "put_down_phone":
        return this.dispatchLocal(call, async () => {
          const closedApp = await this.apps?.closeCurrent();
          this.phoneUi = { chatOpen: false, channelKey: null, channelIsGroup: false, forwardStack: [] };
          this.phone.down = true;
          this.refreshToolGate();
          this.interruptAllDeferred("你把手机放到了一边");
          const focusNote = await this.messenger.putDownPhone();
          return (
            `你把手机放到了一边${closedApp ? `（「${closedApp}」已关闭）` : ""}。` +
            `之后再有消息你只会感觉到它震一下，不会看到内容——想看手机时先 pick_up_phone。\n${focusNote}`
          );
        });
      case "pick_up_phone":
        return this.dispatchLocal(call, async () => {
          if (!this.phone.down) return "（手机本来就在你手里。）";
          this.phone.down = false;
          return "你把手机拿回手里，消息通知恢复正常。（想看消息就打开聊天应用。）";
        });
      case "channel_notify": {
        const allowRaw = call.arguments.allow;
        if (allowRaw === undefined || allowRaw === null) {
          this.pushEvent("system", "（channel_notify 需要 allow 参数（true 开启通知 / false 免打扰）。）", { ref: call.id });
          return;
        }
        const id = this.channelArg(call);
        if (!id) {
          this.pushEvent("system", "（channel_notify 需要 id 参数，或先进入一个频道。）", { ref: call.id });
          return;
        }
        const allow = isTruthy(allowRaw);
        return this.dispatchLocal(call, async () => {
          const resolved = await this.messenger.resolveKey(id);
          if ("error" in resolved) return resolved.error;
          await this.notifyList?.set(resolved.key, allow);
          return allow
            ? `你打开了 ${resolved.key} 的消息通知。`
            : `你把 ${resolved.key} 设为了免打扰，之后它的新消息不会再提醒你（消息记录里仍能翻到）。`;
        });
      }
      case "open_app": {
        const name = String(call.arguments.name ?? call.arguments.app ?? "");
        if (!name.trim()) {
          this.pushEvent(
            "system",
            `（open_app 需要 name 参数。已安装的应用：${this.apps?.installedText() ?? "（无）"}）`,
            { ref: call.id },
          );
          return;
        }
        return this.dispatchOpenApp(call, name.trim());
      }
      case "close_app":
        return this.dispatchLocal(call, async () => {
          const closed = await this.apps?.closeCurrent();
          if (closed) {
            this.refreshToolGate();
            return `你关闭了「${closed}」，它的操作已失效。`;
          }
          if (this.phoneUi.chatOpen) {
            this.phoneUi = { chatOpen: false, channelKey: null, channelIsGroup: false, forwardStack: [] };
            this.refreshToolGate();
            return "你关闭了聊天应用，相关操作已失效（手机还在手里，有消息仍会通知你）。";
          }
          return "（当前没有打开的应用。）";
        });
      case "open_computer":
        return this.dispatchLocal(call, async () => {
          const res = await this.computer?.open();
          if (!res) return "（这台电脑不可用。）";
          if ("error" in res) return `（你走到桌前想打开电脑，但打不开：${res.error}）`;
          this.refreshToolGate();
          const lines = res.defs.length
            ? res.defs.map((d) => `- ${d.signature}\n  ${d.description}`).join("\n")
            : "（这台电脑没有提供任何操作。）";
          return `${res.opening}\n接下来可以像普通能力一样调用（close_computer 关机后失效）：\n${lines}`;
        });
      case "close_computer":
        return this.dispatchLocal(call, async () => {
          if (!this.computer?.isOpen) return "（电脑本来就关着。）";
          await this.computer.close();
          this.refreshToolGate();
          return "你关掉了电脑，它提供的操作已失效。";
        });
      case "unsend": {
        const id = this.channelArg(call) ?? "";
        const msgId = String(call.arguments.msg_id ?? call.arguments.msgId ?? "");
        if (!id || !msgId) {
          this.pushEvent("system", "（unsend 需要 id 和 msg_id 参数，msg_id 来自消息记录里的 (msg:xxx) 标注。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.recall(id, msgId));
      }
      case "react": {
        const id = this.channelArg(call) ?? "";
        const msgId = String(call.arguments.msg_id ?? call.arguments.msgId ?? "");
        const emoji = String(call.arguments.emoji ?? "");
        if (!id || !msgId || !emoji) {
          this.pushEvent("system", "（react 需要 id、msg_id 和 emoji 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () =>
          this.messenger.react(id, msgId, emoji, isTruthy(call.arguments.remove)),
        );
      }
      case "get_emoji_likes": {
        const id = this.channelArg(call) ?? "";
        const msgId = String(call.arguments.msg_id ?? call.arguments.msgId ?? "");
        const emoji = String(call.arguments.emoji ?? "");
        if (!id || !msgId || !emoji) {
          this.pushEvent("system", "（get_emoji_likes 需要 id、msg_id 和 emoji 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.emojiLikes(id, msgId, emoji));
      }
      case "forward_msgs": {
        const id = this.channelArg(call) ?? "";
        const msgIds = normalizeIdList(call.arguments.msg_ids ?? call.arguments.msgIds ?? call.arguments.msg_id);
        if (!id || !msgIds.length) {
          this.pushEvent("system", "（forward_msgs 需要 id 和 msg_ids 参数，msg_ids 为消息编号列表。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.forwardMsgs(id, msgIds));
      }
      case "view_forward": {
        const fid = String(call.arguments.id ?? call.arguments.forward_id ?? "").trim();
        if (!fid) {
          this.pushEvent("system", '（view_forward 需要 id 参数，来自消息里的 <forward id="…"/> 标签。）', { ref: call.id });
          return;
        }
        if (this.phoneUi.forwardStack.length >= 5) {
          this.pushEvent("system", "（聊天记录套得太深了，先 exit_forward 退出几层再看。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => {
          const rich = await this.messenger.viewForward(fid);
          if (rich.text.startsWith("（")) return rich; // 打开失败：不压栈
          this.phoneUi.forwardStack.push(fid);
          const depth = this.phoneUi.forwardStack.length;
          const header =
            depth > 1
              ? `你点开了里面嵌套的聊天记录（第 ${depth} 层）——以下是它的内容，不是当前聊天：`
              : `你点开了这份聊天记录——以下是它的内容，**不是**当前聊天窗口里的消息：`;
          return {
            ...rich,
            text: `${header}\n${rich.text}\n（看完用 exit_forward 返回${depth > 1 ? "上一层" : "聊天窗口"}）`,
          };
        });
      }
      case "exit_forward":
        return this.dispatchLocal(call, async () => {
          if (!this.phoneUi.forwardStack.length) return "（你没有在看聊天记录。）";
          this.phoneUi.forwardStack.pop();
          const depth = this.phoneUi.forwardStack.length;
          if (depth > 0) return `你退回到上一层聊天记录（第 ${depth} 层）。`;
          return this.phoneUi.channelKey
            ? `你退出了聊天记录，回到 ${this.phoneUi.channelKey} 的聊天窗口。`
            : "你退出了聊天记录。";
        });
      case "ocr_image": {
        const image = String(call.arguments.image ?? call.arguments.media_id ?? call.arguments.id ?? "");
        if (!image) {
          this.pushEvent("system", "（ocr_image 需要 image 参数（图片编号或收藏夹文件）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.ocrImage(image));
      }
      case "poke": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（poke 需要 id 参数。）", { ref: call.id });
          return;
        }
        const userId = call.arguments.user_id ?? call.arguments.userId;
        return this.dispatchLocal(call, async () =>
          this.messenger.poke(id, userId !== undefined && userId !== null ? String(userId) : undefined),
        );
      }
      case "handle_request": {
        const requestId = String(call.arguments.request_id ?? call.arguments.requestId ?? call.arguments.id ?? "");
        const approveRaw = call.arguments.approve;
        if (!requestId || approveRaw === undefined || approveRaw === null) {
          this.pushEvent("system", "（handle_request 需要 request_id 和 approve 参数。）", { ref: call.id });
          return;
        }
        const approve = isTruthy(approveRaw);
        const reason = call.arguments.reason != null ? String(call.arguments.reason) : undefined;
        return this.dispatchLocal(call, async () => this.messenger.handleRequest(requestId, approve, reason));
      }
      case "list_friends":
        return this.dispatchLocal(call, async () => this.messenger.listFriends());
      case "user_info": {
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? call.arguments.id ?? "");
        if (!userId) {
          this.pushEvent("system", "（user_info 需要 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.userInfo(userId));
      }
      case "send_like": {
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? call.arguments.id ?? "");
        if (!userId) {
          this.pushEvent("system", "（send_like 需要 user_id 参数。）", { ref: call.id });
          return;
        }
        const times = clampInt(call.arguments.times, 1, 10, 1);
        return this.dispatchLocal(call, async () => this.messenger.sendLike(userId, times));
      }
      case "delete_friend": {
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? call.arguments.id ?? "");
        if (!userId) {
          this.pushEvent("system", "（delete_friend 需要 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.deleteFriend(userId));
      }
      case "set_profile": {
        const nickname = call.arguments.nickname != null ? String(call.arguments.nickname) : undefined;
        const signature = call.arguments.signature != null ? String(call.arguments.signature) : undefined;
        const avatar = call.arguments.avatar != null ? String(call.arguments.avatar) : undefined;
        if (!nickname && !signature && !avatar) {
          this.pushEvent("system", "（set_profile 需要 nickname、signature、avatar 中至少一个参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setProfile({ nickname, signature, avatar }));
      }
      case "set_model_show": {
        const model = String(call.arguments.model ?? call.arguments.name ?? "");
        if (!model) {
          this.pushEvent("system", "（set_model_show 需要 model 参数（想显示的机型名）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setModelShow(model));
      }
      case "list_groups":
        return this.dispatchLocal(call, async () => this.messenger.listGroups());
      case "group_info": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（group_info 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupInfo(id));
      }
      case "list_members": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（list_members 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.listMembers(id));
      }
      case "member_info": {
        const id = this.channelArg(call) ?? "";
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        if (!id || !userId) {
          this.pushEvent("system", "（member_info 需要 id 和 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.memberInfo(id, userId));
      }
      case "group_honor": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（group_honor 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupHonor(id));
      }
      case "group_files": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（group_files 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        const folderRaw = call.arguments.folder_id ?? call.arguments.folderId;
        const folderId = folderRaw != null && String(folderRaw).trim() ? String(folderRaw).trim() : undefined;
        return this.dispatchLocal(call, async () => this.messenger.groupFiles(id, folderId));
      }
      case "set_group_card": {
        const id = this.channelArg(call) ?? "";
        const card = String(call.arguments.card ?? call.arguments.name ?? "");
        if (!id || !card) {
          this.pushEvent("system", "（set_group_card 需要 id 和 card 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setGroupCard(id, card));
      }
      case "set_group_name": {
        const id = this.channelArg(call) ?? "";
        const name = String(call.arguments.name ?? "");
        if (!id || !name) {
          this.pushEvent("system", "（set_group_name 需要 id 和 name 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setGroupName(id, name));
      }
      case "set_group_portrait": {
        const id = this.channelArg(call) ?? "";
        const image = String(call.arguments.image ?? "");
        if (!id || !image) {
          this.pushEvent("system", "（set_group_portrait 需要 id 和 image 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setGroupPortrait(id, image));
      }
      case "send_group_notice": {
        const id = this.channelArg(call) ?? "";
        const content = String(call.arguments.content ?? "");
        if (!id || !content) {
          this.pushEvent("system", "（send_group_notice 需要 id 和 content 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.sendGroupNotice(id, content));
      }
      case "get_group_notice": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（get_group_notice 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.getGroupNotice(id));
      }
      case "get_essence_list": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（get_essence_list 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.essenceList(id));
      }
      case "set_essence": {
        const msgId = String(call.arguments.msg_id ?? call.arguments.msgId ?? "");
        if (!msgId) {
          this.pushEvent("system", "（set_essence 需要 msg_id 参数，来自消息记录里的 (msg:xxx) 标注。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () =>
          this.messenger.setEssence(msgId, isTruthy(call.arguments.remove)),
        );
      }
      case "group_sign": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（group_sign 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupSign(id));
      }
      case "group_ban": {
        const id = this.channelArg(call) ?? "";
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        const minutes = Number(call.arguments.minutes ?? call.arguments.duration ?? NaN);
        if (!id || !userId || !Number.isFinite(minutes) || minutes < 0) {
          this.pushEvent("system", "（group_ban 需要 id、user_id 和 minutes 参数（0 表示解除禁言）。）", { ref: call.id });
          return;
        }
        // 低于 1 分钟的禁言（不足 60 秒）对用户而言近乎无意义，先拦下
        const gateMsg = shortBanGateMessage(minutes, isTruthy(call.arguments.robot));
        if (gateMsg) {
          this.pushEvent("system", `（${gateMsg}）`, { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupBan(id, userId, minutes));
      }
      case "group_whole_ban": {
        const id = this.channelArg(call) ?? "";
        const enable = call.arguments.enable;
        if (!id || enable === undefined || enable === null) {
          this.pushEvent("system", "（group_whole_ban 需要 id 和 enable 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupWholeBan(id, isTruthy(enable)));
      }
      case "group_kick": {
        const id = this.channelArg(call) ?? "";
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        if (!id || !userId) {
          this.pushEvent("system", "（group_kick 需要 id 和 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () =>
          this.messenger.groupKick(id, userId, isTruthy(call.arguments.block)),
        );
      }
      case "group_admin": {
        const id = this.channelArg(call) ?? "";
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        const enable = call.arguments.enable;
        if (!id || !userId || enable === undefined || enable === null) {
          this.pushEvent("system", "（group_admin 需要 id、user_id 和 enable 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupAdmin(id, userId, isTruthy(enable)));
      }
      case "set_special_title": {
        const id = this.channelArg(call) ?? "";
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        const title = String(call.arguments.title ?? "");
        if (!id || !userId) {
          this.pushEvent("system", "（set_special_title 需要 id 和 user_id 参数（title 为空表示移除头衔）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setSpecialTitle(id, userId, title));
      }
      case "group_leave": {
        const id = this.channelArg(call) ?? "";
        if (!id) {
          this.pushEvent("system", "（group_leave 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupLeave(id));
      }
      case "cancel":
        return this.dispatchCancel(call);
      case "recall":
        return this.dispatchLocal(call, async () => this.recallFacts(call));
      default:
        // 当前打开的 App 展开的工具
        if (this.apps?.hasTool(call.name)) {
          const appName = this.apps.currentName;
          return this.dispatchLocal(call, async () => {
            try {
              return await this.apps!.call(call.name, call.arguments);
            } catch (err) {
              throw new Error(`「${appName}」的 ${call.name} 操作失败：${(err as Error).message ?? err}`);
            }
          });
        }
        // 电脑（open_computer 打开的设备）展开的工具
        if (this.computer?.hasTool(call.name)) {
          return this.dispatchLocal(call, async () => {
            try {
              return await this.computer!.call(call.name, call.arguments);
            } catch (err) {
              throw new Error(`电脑的 ${call.name} 操作失败：${(err as Error).message ?? err}`);
            }
          });
        }
        if (call.role === "agent" && this.classifyDevice(call.name)) {
          return this.dispatchLocal(call, async () => { throw new Error("设备界面已改变，原操作不可用"); });
        }
        this.pushEvent("system", `（没有名为 ${call.name} 的能力。）`, { ref: call.id });
    }
  }

  /**
   * 调度类调用的启动确认：生成后立即以事件告知"已开始执行"，随后照常生成下一个调用。
   * 这从源头消除了"结果尚未进邮箱 → Bot 以为工具没反应 → 重复调用"的信息真空，
   * 且不引入任何等待延迟。带 duration 的调用额外附上编号（可 cancel）与预计完成时刻。
   */
  private ackStart(call: ToolCallRecord): void {
    // 按 expectedAt 判断（而非 duration）：ignoreSendDuration 会把 expectedAt 拉回当下，此时按即时调用确认
    if (call.expectedAt - call.issuedAt > 0) {
      this.pushEvent(
        "system",
        `${call.id} ${call.name} 已开始，预计 T=${call.expectedAt.toFixed(1)} 完成。`,
        { ref: call.id },
      );
    } else {
      this.pushEvent(
        "system",
        `${call.id} ${call.name} 已开始执行，完成后结果会自动以事件形式送到你这里。`,
        { ref: call.id },
      );
    }
  }

  /**
   * wait：纯计时器实现，到点**准时**解除暂停（不被 World-LLM 的速度拖累）。
   * 现实等待时长达到阈值时，快结束前提前让 World-LLM 生成期间见闻：
   * 生成得及 → 随唤醒事件一起送达；生成不及 → 先准时唤醒，见闻随后补送。
   */
  private dispatchWait(call: ToolCallRecord): void {
    const n = call.duration ?? 0;
    if (n <= 0) {
      this.pushEvent("system", "（等待时长必须大于 0。）", { ref: call.id });
      return;
    }
    // 干等占比拦截：最近一个窗口内实际处于等待中的世界时间占比过高时，新的 wait 直接拦下。
    // confirm: true 只在"刚被拦下"后的下一次生效（单次通行证）——习惯性地每次都带上没有任何作用，
    // 每一次高占比等待都必须经过一轮显式的"拦下 → 确认"。
    // 按时长不按次数：少量多次的短等是正常的，要治的是「几乎全部时间都在干等」
    const threshold = this.config.bot.waitRateThreshold;
    const windowTU = this.config.bot.waitRateWindow;
    if (threshold > 0 && windowTU > 0) {
      const nowTU = this.clock.now();
      const waited = this.waitedWithin(nowTU - windowTU, nowTU);
      const rate = Math.round((waited / windowTU) * 100);
      if (rate >= threshold) {
        if (isTruthy(call.arguments.confirm) && this.waitConfirmArmed) {
          this.waitConfirmArmed = false; // 通行证单次有效
        } else {
          this.waitConfirmArmed = true;
          const confirmNote = isTruthy(call.arguments.confirm)
            ? "你带了 confirm: true，但它只在被拦下之后的下一次等待里才生效——每次都习惯性地带上是没有意义的，不要那样做。"
            : "";
          // 引导语做 10 套字面差异大的变体随机；事实（窗口时长/等待占比）与 confirm 指引保持稳定
          const idleGuidance = pickMeta([
            "你最近大部分时间都在空等，这样不会有任何进展。去看点新东西、找点真正想做的事，或暂时放下手机做点别的实际的事。",
            "空等占了你太多时间，再等下去只会原地踏步。主动去找点事情做，或者干脆离开手机去干点实在的。",
            "你几乎一直在等，但这等待换不来任何变化。给自己找件新鲜事，或起身做点实际的，别干耗着。",
            "这么久的空等没有意义，生活不会自己找上门。要么去找感兴趣的事，要么放下手机，做点看得见摸得着的事。",
            "你花在干等上的时间太多了，这只是在虚度。换个方向，主动做点什么，哪怕是件很小的事。",
            "等待解决不了任何问题，你只是在消耗自己。别傻等了，去找事做，或暂时离开聊天专心做点别的。",
            "你最近几乎都在发呆等待，这样日子会一事无成。请动起来，找点新目标，或做点实际的事。",
            "空等已经成了你的常态，这很危险。你需要主动出击——看新东西、找想做的事、或放下手机做实事。",
            "别再等了，等待不会带来哪怕一点点进展。去探索、去行动，或者干脆离开屏幕歇一歇脑子。",
            "你把大半时间耗在了无谓的等待上。真正的进展来自做事，不是等。去找点新鲜事，或起身做点实际的。",
          ]);
          this.pushEvent(
            "system",
            `（最近 ${windowTU} TU 里，你有 ${Math.round(waited)} TU（${rate}%）都在干等——这次等待没有开始。${confirmNote}` +
              `${idleGuidance}` +
              `想清楚确实无事可做的话，紧接着再调用一次 wait 并带上 confirm: true。）`,
            { ref: call.id },
          );
          return;
        }
      }
    }
    this.waiting = { callId: call.id, startedTU: this.clock.now() };

    // Observations are now kernel reads, not predictive narration. Read only after the wait actually ends:
    // an early read would consume another actor's speech even when this wait is interrupted.
    const narrateMinMs = this.config.world.waitNarrateMinRealSeconds * 1000;
    const shouldObserve = narrateMinMs > 0 && this.clock.realMsUntil(call.expectedAt) >= narrateMinMs;
    this.schedule(call, {
      executeAt: "expected",
      run: async () => {
        this.recordWait(call.issuedAt);
        if (shouldObserve) {
          void this.world.resolveWait(call, (content) => this.pushEvent("world", content)).catch((err) => {
            this.logger.warn("等待后的观测失败：%s", err);
          });
        }
        return { text: "等待结束了。", originEventIds: [] };
      },
    });
  }

  private dispatchAct(call: ToolCallRecord): void {
    const desc = String(call.arguments.description ?? call.arguments.str ?? "");
    // blockingAct：一个人同时只能专注做一件事。上一个动作还没完成时，新的 act 直接拒绝并提示，
    // 不调用 World-LLM 裁定；也不像 repeat 那样给 Bot 留绕过口（专注模式不可无视）。
    if (this.config.bot.blockingAct) {
      const pendingActs = this.scheduler.pendingByName("act");
      if (pendingActs.length) {
        this.pushEvent(
          "system",
          actBusyMessage(pendingActs, this.bumpActBlock(desc))!,
          { ref: call.id },
        );
        return;
      }
    }
    // 拦截"上一个相同的动作还没出结果就再做一遍"（模型常见的复读行为），除非显式声明 repeat
    const sig = desc.trim();
    if (
      sig &&
      this.lastAct?.sig === sig &&
      this.scheduler.isPending(this.lastAct.callId) &&
      !isTruthy(call.arguments.repeat)
    ) {
      const n = this.bumpActBlock(sig);
      this.pushEvent(
        "system",
        repeatingActMessage(sig, n, this.lastAct.callId),
        { ref: call.id },
      );
      return;
    }
    this.lastAct = { sig, callId: call.id };
    this.lastActBlock = null; // 成功发起（或重置）一个 act，重复计数归零
    this.ackStart(call);
    this.schedule(call, {
      executeAt: "now",
      cancellation: "cooperative",
      run: async (task) => {
        const parts: string[] = [];
        const ok = await this.world.adjudicateAct(call, (content) => parts.push(content), task.signal, task.beginCommit);
        if (task.cancelled()) return null;
        const adjudicatedFailure = parts.some((part) => {
          try { return JSON.parse(part)?.action?.status === "failed"; } catch { return false; }
        });
        if (!ok && !adjudicatedFailure) throw new Error("世界未能裁定此动作，结果尚未确认");
        if (!parts.length) throw new Error("世界未返回可感知的动作结果，不能认定动作成功");
        // A world snapshot is not a perception. Only return the adjudicator's actor-filtered receipt.
        const text = parts.join("\n");
        const origins = parts.flatMap((part) => observationOrigins(part) ?? []);
        return { text, originEventIds: [...new Set(origins)] };
      },
    });
  }

  /**
   * 记录并返回「连续重复提交同一 act」的当前次数。
   * sig 与上一次被拦截的相同则递增，否则从 1 起算；供拦截提示做递进式加压。
   */
  private bumpActBlock(sig: string): number {
    const key = sig.trim();
    if (this.lastActBlock?.sig === key) {
      this.lastActBlock = { sig: key, count: this.lastActBlock.count + 1 };
    } else {
      this.lastActBlock = { sig: key, count: 1 };
    }
    return this.lastActBlock.count;
  }

  /** open_app：打开聊天平台 = 看一眼最近消息；打开其他 App = 展开其工具 */
  private dispatchOpenApp(call: ToolCallRecord, name: string): void {
    const resolved = this.apps?.resolve(name) ?? null;
    if (!resolved) {
      return this.dispatchLocal(call, async () => {
        return `（手机里没有叫「${name}」的应用。已安装的应用：${this.apps?.installedText() ?? "（无）"}）`;
      });
    }
    if (resolved.kind === "chat") {
      // 打开聊天应用：切走当前 App，落在消息列表页（解锁 chat 层操作）并刷新列表
      return this.dispatchLocal(call, async () => {
        const closed = await this.apps?.closeCurrent();
        const firstOpen = !this.phoneUi.chatOpen;
        this.phoneUi = { chatOpen: true, channelKey: null, channelIsGroup: false, forwardStack: [] };
        this.refreshToolGate();
        const rich = await this.messenger.recentChannels(10);
        const prefix = closed ? `（你关掉了「${closed}」）` : "";
        const unlock = firstOpen
          ? `（聊天应用已打开，新增可用操作（关闭应用后失效）：\n${renderToolsText(this.layerDefs("chat"))}\n` +
            `要**发消息**，先 select_channel 点进某个频道（进频道后才解锁频道内的完整操作），再用 send 发送；` +
            `想发图文混排，在 msg 里写 <img> 占位符再用 pick_media 选图填充；` +
            `没点进频道时，若某频道刚来了新消息、收到它的提醒，也能 send 带上它的 id 直接快捷回复。）\n\n`
          : "";
        return typeof rich === "string"
          ? { text: prefix + unlock + rich }
          : { ...rich, text: prefix + unlock + rich.text };
      });
    }
    return this.dispatchLocal(call, async () => {
      try {
        const { closed, opening, defs } = await this.apps!.open(resolved.app);
        // 手机同屏只有一个应用：打开 MCP 应用时聊天界面随之退出
        const chatWasOpen = this.phoneUi.chatOpen;
        this.phoneUi = { chatOpen: false, channelKey: null, channelIsGroup: false, forwardStack: [] };
        this.refreshToolGate();
        const lines = defs.length
          ? defs.map((d) => `- ${d.signature}\n  ${d.description}`).join("\n")
          : "（这个应用没有提供任何操作。）";
        const closedNote = closed
          ? `（「${closed}」已被关掉）`
          : chatWasOpen
            ? "（聊天应用已被关掉）"
            : "";
        // 拟人化应用（终端 / 资源管理器等）自带开场描述，覆盖通用的“你打开了「xx」”
        const head = opening
          ? `${opening}${closedNote ? `\n${closedNote}` : ""}`
          : `你打开了「${resolved.app.name}」。${closedNote}`;
        return (
          `${head}\n` +
          `接下来可以像普通能力一样调用（关闭应用或打开其他应用后失效）：\n${lines}`
        );
      } catch (err) {
        this.refreshToolGate();
        return `（「${resolved.app.name}」启动失败：${(err as Error).message ?? err}）`;
      }
    });
  }

  private dispatchLocal(call: ToolCallRecord, run: () => Promise<string | RichText>): void {
    this.ackStart(call);
    this.schedule(call, { executeAt: "now", run });
  }

  private classifyDevice(name: string): DeviceKind | null {
    return deviceKind(name, new Set(this.apps?.activeToolNames() ?? []), new Set(this.computer?.activeToolNames() ?? [])) ?? this.knownDeviceTools.get(name) ?? null;
  }

  /** Both autonomous and human calls serialize one side effect, then release the device. */
  private schedule(call: ToolCallRecord, opts: ScheduleOptions): void {
    const kind = call.name === "observe_device" ? call.arguments.device as DeviceKind : this.classifyDevice(call.name);
    if (!kind) { this.scheduler.schedule(call, opts); return; }
    const phoneApp = this.apps?.hasTool(call.name) ? this.apps.view()?.id : null;
    const stealth = this.stealthCalls.has(call.id);
    let revealOnAttention = false;
    this.scheduler.schedule(call, {
      ...opts, serialKey: "devices",
      beforeStart: () => {
        if (!this.running) throw new Error("设备所属世界已停止，此操作没有执行");
        if (call.role === "agent") {
          revealOnAttention = this.concealedDevices.has(kind);
          this.attention = kind;
          if (call.name === "observe_device") this.observingPlacedPhone = kind === "phone";
          this.concealedDevices.delete(kind);
          this.refreshToolGate();
        }
        if (stealth) this.concealedDevices.add(kind);
        if (!this.currentToolNames().includes(call.name) || (phoneApp && this.apps?.view()?.id !== phoneApp)) {
          throw new Error("设备界面已改变，此操作已不可用；请查看当前界面后重新决定");
        }
        opts.beforeStart?.();
      },
      run: async task => {
        this.deviceOperations++;
        try {
          const result = await opts.run(task);
          if (call.role === "agent" && (call.name === "put_down_phone" || call.name === "close_computer")) {
            this.attention = null;
            this.observingPlacedPhone = false;
          }
          if (call.name !== "observe_device" && (stealth || revealOnAttention) && this.running && this.deviceAttention === kind) await this.perceiveDeviceChange(kind);
          return result;
        } finally { this.deviceOperations--; }
      },
    });
  }

  /** Read the current interface only. This cannot open, connect, or change device state. */
  private async deviceObservation(kind: DeviceKind): Promise<RichText> {
    let pixels: RichText | null = null;
    try { if (kind === "phone" || this.computer?.isOpen) pixels = await this.peekDevice?.(kind) ?? null; }
    catch (error) { this.logger.debug("读取可见设备画面失败：%s", error); }
    const view = kind === "phone" ? this.apps?.view()?.result : this.computer?.view()?.result;
    const visible = pixels ?? (typeof view === "string" ? { text: view } : view);
    const label = kind === "phone"
      ? `手机当前显示：${this.phoneUi.chatOpen ? "聊天应用" + (this.phoneUi.channelKey ? `，频道 ${this.phoneUi.channelKey}` : "，消息列表") : this.apps?.currentName ?? "桌面"}`
      : !this.computer ? "当前没有可用电脑" : `电脑当前${this.computer.isOpen ? "处于打开状态" : "已关闭"}`;
    return {
      text: `（你正看着${kind === "phone" ? "手机" : "电脑"}，当前可见界面：${label}。）` +
        (visible?.text ? `\n${pixels ? "界面上显示的内容" : "已有界面回显"}（不是你的行动或心理记录）：\n${truncate(visible.text, 3000)}` : ""),
      attachments: visible?.attachments,
    };
  }

  private async perceiveDeviceChange(kind: DeviceKind): Promise<void> {
    const visible = await this.deviceObservation(kind);
    if (!this.running || this.deviceAttention !== kind) return;
    this.deviceExecution.run({ stealth: false }, () => {
      this.concealedDevices.delete(kind);
      this.refreshToolGate();
      this.pushEvent("system", visible);
    });
  }

  /**
   * 处理 repeatGuard 的观察结果：始终保留 advisory 提醒；开启 breakLoop 时进一步真正干预——
   * 第一阶段移除被重复的工具（tempBannedTools，下次压缩后恢复），移除后仍重复则升级为强制压缩 rest。
   * 这是对「纯 advisory 压不住持续自主运行的 Bot」的兜底：不依赖模型听从提醒，直接改变它的可用工具集。
   */
  private handleRepeat(call: ToolCallRecord, repeat: ObserveResult): boolean {
    // advisory 提醒：命中阈值/检出循环时才有（未命中但计数仍在累加时静默）
    if (repeat.notice) {
      this.pushEvent("system", `（${repeat.notice}）`, { ref: call.id });
    }

    if (!this.config.bot.breakLoop) return false;
    if (!repeat.cycle && repeat.count < 2) {
      this.forceRestCount = 0;
      return false;
    }

    const removeAt = this.config.bot.breakLoopRemoveToolAt ?? 0;
    const restAt = this.config.bot.breakLoopForceRestAt ?? 0;

    // 第一阶段：移除被重复的工具。用 repeat.count（连续计数）而非提醒阈值点判定，
    // 这样 breakLoopRemoveToolAt 可以独立设成任意值（如 6），不依赖 thresholds=[3,5,8]。
    // 交替循环（cycle）视为立即达到移除阈值——循环本身就是最该打断的形态。
    if (removeAt > 0) {
      const shouldRemove = repeat.cycle || repeat.count >= removeAt;
      if (shouldRemove && !this.tempBannedTools.has(repeat.toolName) && !isBreakLoopSafeTool(repeat.toolName)) {
        this.tempBannedTools.add(repeat.toolName);
        this.refreshToolGate();
        this.logger.warn("打破死循环：暂时移除反复调用的工具 %s（下次压缩后恢复）", repeat.toolName);
        this.pushEvent(
          "system",
          pickMeta([
            `（你一直在反复调用 ${repeat.toolName}，它暂时不再可用了——先做点别的，或想清楚真正要做的事。）`,
            `（${repeat.toolName} 被暂时收走了，因为你反复用它。换个方向吧，做点真正有意义的事。）`,
            `（你太依赖 ${repeat.toolName} 了，它暂时不可用。冷静一下，想清楚除了它还能做什么。）`,
            `（反复调用 ${repeat.toolName} 没有意义，它已被暂时移除。转去做别的，或停下来理理思路。）`,
            `（${repeat.toolName} 暂时从你手边拿走了。你一直在绕它打转，现在必须换一条路。）`,
            `（这个工具 ${repeat.toolName} 你翻来覆去地用，先收起来。去做点别的，别再纠结它。）`,
            `（${repeat.toolName} 暂时不能用了——你之前一直盯着它不放。现在试试别的可能。）`,
            `（你陷在 ${repeat.toolName} 里出不来，它先被移除了。休息一下，想想真正的目标是什么。）`,
            `（反复用 ${repeat.toolName} 只会原地打转，它暂时不可用。换件事，或者就安静待一会儿。）`,
            `（${repeat.toolName} 已经暂时失效，因为你太执着于它。放下它，走向下一个选择。）`,
          ]),
          { ref: call.id },
        );
        return true; // The banned call must not execute after the gate changes.
      }
    }

    // 第二阶段：工具已移除（或无需移除）仍在重复——累计至阈值后强制压缩 rest，把循环历史清掉。
    if (restAt > 0) {
      this.forceRestCount += 1;
      if (this.forceRestCount >= restAt) {
        this.forceRestCount = 0;
        this.logger.warn("打破死循环：重复未缓解，强制执行带压缩的 rest");
        this.compressionRequested = "breakLoop";
        return true;
      }
    }
    return false;
  }

  /**
   * 工具结果溢出治理（spill/prune，对应 dsh 的 tool-result-pruner + spill-policy）：
   * 纯文本结果超过 spillMinChars 时，裁成「头部 + 省略标记 + 尾部」，全文 fire-and-forget 落盘到
   * <base>/spill/，模型上下文只保留裁剪预览。落盘失败静默降级为原样返回（不把成功的调用变成失败）。
   *
   * 注意：这里只裁剪 **模型可见** 的文本，原始结果仍由 scheduler 的结果语义保留；
   * 裁剪让前缀缓存从被裁点起失效，但只发生在个别超大结果上，且换来上下文不被垃圾塞满。
   */
  private spillResult(content: string | RichText, ref?: string): string | RichText {
    const threshold = this.config.bot.spillMinChars ?? 4000;
    if (threshold <= 0) return content;
    if (typeof content !== "string") return content; // RichText（含附件/分段）不裁剪
    if (content.length <= threshold) return content;
    // head/tail 各占约 45%，中间省略标记
    const headChars = Math.floor(threshold * 0.45);
    const tailChars = Math.floor(threshold * 0.45);
    const head = sliceText(content, 0, headChars);
    const tail = sliceText(content, content.length - tailChars);
    const omitted = content.length - headChars - tailChars;
    const spillFile = this.files.spillPath(ref ? `${ref}.txt` : `result_${Date.now()}.txt`);
    const marker = `\n\n[... 中间 ${omitted} 字符已省略，完整结果见 ${spillFile} ...]\n\n`;
    const preview = head + marker + tail;
    // 落盘（异步、尽力而为）
    void this.files
      .atomicWrite(spillFile, content)
      .catch(() => {/* spill 失败静默：模型仍拿到预览 */});
    return preview;
  }

  /** 记录一段实际发生的等待（从 fromTU 到现在），并顺手清理窗口外的旧区间 */
  private recordWait(fromTU: number): void {
    const to = this.clock.now();
    if (to <= fromTU) return;
    this.waitLog.push({ from: fromTU, to });
    const keepAfter = to - this.config.bot.waitRateWindow * 2;
    if (this.waitLog[0] && this.waitLog[0].to < keepAfter) {
      this.waitLog = this.waitLog.filter((iv) => iv.to >= keepAfter);
    }
  }

  /** 窗口 [fromTU, toTU] 内实际处于等待中的世界时长（区间重叠部分求和） */
  private waitedWithin(fromTU: number, toTU: number): number {
    let sum = 0;
    for (const iv of this.waitLog) {
      sum += Math.max(0, Math.min(iv.to, toTU) - Math.max(iv.from, fromTU));
    }
    return sum;
  }

  /**
   * send 系工具的 duration 策略：
   * - ignoreSendDuration 开启：无视 duration，消息立即发出（expectedAt 拉回当下；
   *   expectedAt 只影响调度，不进入上下文渲染，可安全修改）；
   * - 否则做语义校验：duration 表示打字/说话耗时（真人也就几秒到几十秒），
   *   不是"过一会儿再发"的定时器，超过上限（按世界秒换算成 TU）时拦下并纠正。
   * 返回 true 表示已拦截（调用方直接 return）。
   */
  private gateSendDuration(call: ToolCallRecord, verb: string): boolean {
    if (this.config.bot.ignoreSendDuration) {
      call.expectedAt = call.issuedAt;
      return false;
    }
    const n = call.duration ?? 0;
    // 打字/说话最多按 120 世界秒计；TU 粒度很粗的世界里至少放宽到 10 TU
    const cap = Math.max(10, Math.ceil(120 / this.clock.unitWorldSeconds));
    if (n <= cap) return false;
    const later = this.config.bot.disableWait
      ? "想过一会儿再发，到时候再调用即可。"
      : `想过一会儿再发，就先 wait 到那个时候再 ${call.name}。`;
    this.pushEvent(
      "system",
      pickMeta([
        `（${call.name} 的 duration 是${verb}耗时——真人也就几秒到几十秒，${n} TU 太久了（上限 ${cap} TU）。${later}什么都没有发生，请改正后重试。）`,
        `（${n} TU 太久了吧？${verb}只是几秒到几十秒的事，上限 ${cap} TU。${later}消息没发，重新设个合理的 duration。）`,
        `（你给 ${call.name} 设了 ${n} TU，可${verb}根本用不了这么久（顶多 ${cap} TU）。${later}这次没发。）`,
        `（${n} TU 的${verb}时长不合理，真人${verb}也就几秒到几十秒，上限 ${cap} TU。${later}请重试。）`,
        `（${call.name} 的 duration 填成 ${n} TU，超了。${verb}最多 ${cap} TU 而已。${later}这条没发出去。）`,
        `（你设的时长 ${n} TU 太夸张了，${verb}只要几秒到几十秒（上限 ${cap} TU）。${later}重新来。）`,
        `（${n} TU 远超${verb}该有的长度（上限 ${cap} TU）。${later}消息没有发出。）`,
        `（这个 duration（${n} TU）不像${verb}，倒像在磨洋工。上限 ${cap} TU。${later}没发。）`,
        `（${verb}不必 ${n} TU 这么久，顶多 ${cap} TU。${later}这次被拦下，请改正。）`,
        `（时长 ${n} TU 超出上限 ${cap} TU，${call.name} 没有执行。${later}重新给个合理时长。）`,
      ]),
      { ref: call.id },
    );
    return true;
  }

  /**
   * 延期发送判定：duration 明显超过按字数估算的打字时间时，不再当作打字耗时
   * （那只是被当成延时报错的把戏），而是把"过会儿再发"的意图存下来：
   * 到点不自动发出，而是询问 Bot 到底要不要发；延期期间被打断则取消并告知。
   * 返回 true 表示已按延期发送处理（调用方直接 return）。
   */
  private maybeDeferSend(call: ToolCallRecord, kind: "text" | "file" | "voice", id: string, content: string): boolean {
    if (this.deviceExecution.getStore()?.stealth) return false;
    if (this.config.bot.ignoreSendDuration) return false;
    const n = call.duration ?? 0;
    const slack = typingSlackTU(
      content.length,
      this.config.messaging.typingCharsPerSec,
      this.clock.unitRealSeconds,
      this.config.messaging.sendDeferFactor,
    );
    if (n <= slack) return false;

    this.registerDeferred(call, kind, id, content);
    return true;
  }

  private registerDeferred(call: ToolCallRecord, kind: "text" | "file" | "voice", id: string, content: string): void {
    const pend: PendingDeferred = {
      callId: call.id,
      kind,
      rawId: id,
      channelKey: null,
      content,
      expectedAt: call.expectedAt,
    };
    this.pendingDeferred.push(pend);
    // best-effort 解析规范频道 key（用于按频道匹配打断条件）
    void this.messenger
      .resolveKey(id)
      .then((r) => {
        if (!("error" in r)) pend.channelKey = r.key;
      })
      .catch(() => undefined);

    const target = kind === "text" ? `给 ${id} 发消息说「${content}」` : kind === "voice" ? `给 ${id} 发语音「${content}」` : `给 ${id} 发送文件「${content}」`;
    this.pushEvent(
      "system",
      `（你打算过会儿${target}——这个 duration 明显超过打字时间，更像"过会儿再发"而不是打字，所以不会自动发出。` +
        `到 T=${call.expectedAt.toFixed(1)} 时我会问你到底要不要发。` +
        `期间若目标频道来了新消息、你自己的账号在那边发出了一条消息、或你把注意力转去了别处，这个念头就会被打断。` +
        `想取消可用 cancel ${call.id}。）`,
      { ref: call.id },
    );

    const delay = this.clock.realMsUntil(call.expectedAt);
    pend.timer = setTimeout(() => this.flushDeferred(pend), Math.max(0, delay));
  }

  /** 到期询问：到点不自动发，改为让 Bot 决定 */
  private flushDeferred(pend: PendingDeferred): void {
    if (pend.timer) {
      clearTimeout(pend.timer);
      pend.timer = undefined;
    }
    this.pendingDeferred = this.pendingDeferred.filter((p) => p !== pend);
    const toolName = "send";
    const target = pend.kind === "text" ? `给 ${pend.rawId} 发消息说「${pend.content}」` : pend.kind === "voice" ? `给 ${pend.rawId} 发语音「${pend.content}」` : `给 ${pend.rawId} 发送文件「${pend.content}」`;
    this.pushEvent(
      "system",
      `（时间到了 T=${pend.expectedAt.toFixed(1)}——你之前打算过会儿${target}。现在要发吗？` +
        `如果还想发，就再调用一次 ${toolName}；如果改主意了，就当我没提。之前那一通还没发出的念头已被解除。）`,
      { wake: true },
    );
  }

  /** 按频道匹配的延期意图是否命中 */
  private matchesDeferred(p: PendingDeferred, key: string): boolean {
    return p.channelKey === key || p.rawId === key;
  }

  /** 同频道来了新消息：打断对那个频道的延期发送意图 */
  noteDeferredChannelActivity(key: string): void {
    // 外部消息动静锚点：无论是否投递通知，只要有别人发来消息，它就是"最近通知源"，
    // 用于解锁"带 id 快捷回复"（输入框编辑工具组在未 select_channel 时也能带 id 使用）。
    if (key) this.lastNotifyKey = key;
    if (!this.pendingDeferred.length) return;
    const hit = this.pendingDeferred.filter((p) => this.matchesDeferred(p, key));
    for (const pend of hit) {
      if (pend.timer) clearTimeout(pend.timer);
      this.pendingDeferred = this.pendingDeferred.filter((p) => p !== pend);
      this.pushEvent(
        "system",
        `（${pend.rawId} 那边来了新的消息——你之前打算过会儿${pend.kind === "text" ? "发消息" : pend.kind === "voice" ? "发语音" : "发送文件"}「${pend.content}」的念头被打断了。）`,
      );
    }
  }

  /** 自己的账号（无论何种原因：其他插件、主人顶号、自己刚发的）在频道里发出了消息：打断对该频道的延期发送意图 */
  noteDeferredSelfSent(key: string): void {
    if (this.deviceExecution.getStore()?.stealth) return;
    if (!this.pendingDeferred.length) return;
    const hit = this.pendingDeferred.filter((p) => this.matchesDeferred(p, key));
    for (const pend of hit) {
      if (pend.timer) clearTimeout(pend.timer);
      this.pendingDeferred = this.pendingDeferred.filter((p) => p !== pend);
      this.pushEvent(
        "system",
        `（你的账号在 ${pend.rawId} 发出了一条消息——之前那个"过会儿${pend.kind === "text" ? "发消息" : pend.kind === "voice" ? "发语音" : "发文件"}「${pend.content}」"的念头被打断了。）`,
      );
    }
  }

  /** 注意力转移到别处（换频道 / 放下手机）：打断全部延期发送意图 */
  private interruptAllDeferred(reason: string): void {
    if (this.deviceExecution.getStore()?.stealth) return;
    if (!this.pendingDeferred.length) return;
    for (const pend of this.pendingDeferred) {
      if (pend.timer) clearTimeout(pend.timer);
      this.pushEvent(
        "system",
        `（你之前打算过会儿${pend.kind === "text" ? "给 " + pend.rawId + " 发消息" : "给 " + pend.rawId + (pend.kind === "voice" ? " 发语音" : " 发送文件")}「${pend.content}」，但${reason}——那个念头被打断了。）`,
      );
    }
    this.pendingDeferred = [];
  }

  private stopAllDeferred(): void {
    for (const pend of this.pendingDeferred) {
      if (pend.timer) clearTimeout(pend.timer);
    }
    this.pendingDeferred = [];
  }

  /**
   * 发送类工具的目标解析（在执行时刻调用）：给了别的频道 id 时先切换过去
   * （等效先 select_channel，工具集随频道类型联动），返回规范化 key。
   * 聊天应用已被关闭时（打字期间 close_app / 放下手机），消息照常发出，
   * 但不改变界面状态——不把关掉的应用悄悄掀开。
   */
  private async switchToTarget(id: string): Promise<{ key: string } | { error: string }> {
    const resolved = await this.messenger.resolveKey(id);
    if ("error" in resolved) return resolved;
    if (this.phoneUi.chatOpen && resolved.key !== this.phoneUi.channelKey) {
      await this.enterChannel(resolved.key, resolved.isPrivate);
    }
    return { key: resolved.key };
  }

  /**
   * 发送类工具的成功结果后，回显该频道最近 n 条消息（文本），让模型看到自己的
   * 话"上墙"了、以及对方的最新回应——消除"没发出去/发错了"的错觉，抑制重复发送。
   * 只取文本（不转发附件），保持轻量。messaging.sendEcho 关闭时只回 out、不带频道列表。
   */
  private async echoChannelRecent(id: string, out: string, n?: number): Promise<string | RichText> {
    if (this.config.messaging.sendEcho === false) return out;
    const recent = await this.messenger.channelMessages(id, n ?? this.config.messaging.sendEchoRecent, { intro: "echo" });
    const recentText = recent.text.trim();
    return recentText ? { text: `${out}\n\n${recentText}` } : out;
  }


  // ---------- 发送（图文混排经 <img> 占位符） ----------

  /** msg 里 <img> 占位符的数量（``<img>`` / ``<img/>`` / ``<IMG>`` 都算） */
  private countImgPlaceholders(msg: string): number {
    return (msg.match(/<img\s*\/?>/gi) ?? []).length;
  }

  private dispatchSend(call: ToolCallRecord): void {
    // sendBlocking：上一条消息还没回显前，拒绝新的 send（避免连发相近/不连贯的消息）
    if (this.config.bot.sendBlocking) {
      const busy = sendBusyMessage(SEND_TOOL_NAMES.flatMap((n) => this.scheduler.pendingByName(n)));
      if (busy) {
        this.pushEvent("system", busy, { ref: call.id });
        return;
      }
    }
    const id = this.channelArg(call) ?? "";
    const msg = String(call.arguments.msg ?? "");
    const mediaRaw = call.arguments.media ?? call.arguments.images;
    const media = Array.isArray(mediaRaw) ? (mediaRaw as (string | number)[]) : [];
    const replyRaw = call.arguments.reply_to ?? call.arguments.replyTo ?? call.arguments.quote;
    const replyTo = normalizeMsgId(replyRaw);
    const atRaw = call.arguments.at_sender ?? call.arguments.atSender ?? call.arguments.at;
    const atSender = !(atRaw === false || atRaw === "false" || atRaw === 0);
    if (!id) {
      this.pushEvent("system", "（send 现在没有可发的频道：你需要先用 select_channel 点进某个频道，或等某个频道来新消息后带上它的 id 快捷回复。）", { ref: call.id });
      return;
    }
    if (!msg && !media.length) {
      const alias = ["message", "text", "content"].find((k) => call.arguments[k] != null);
      this.pushEvent(
        "system",
        alias
          ? `（send 的消息参数必须叫 msg，不存在 ${alias} 这种参数。正确格式：send(id?: string, msg: string, …)。）`
          : "（send 需要 msg（或 media）参数。）",
        { ref: call.id },
      );
      return;
    }
    // 统一走 finishSend：内部先过拦截，再按「有无 <img> 占位符」决定暂存或调度发送
    this.finishSend(call, id, msg, media, replyTo, atSender);
  }

  /** 选图填充 <img> 占位符：按占位符顺序逐张填，填满后自动发送。 */
  private dispatchPickMedia(call: ToolCallRecord): void {
    return this.dispatchLocal(call, async () => {
      const pending = this.pendingImageFill;
      if (!pending) {
        return "（当前没有待填充的消息：先用 send 在 msg 里写 <img> 占位符，再 pick_media 选图填充。）";
      }
      const raw = call.arguments.media ?? call.arguments.media_ids ?? call.arguments.refs;
      const refs = Array.isArray(raw) ? raw.map((r) => String(r)) : [];
      if (!refs.length) return "（pick_media 需要 media 参数：要填充的媒体编号或收藏夹文件的列表。）";
      const results = await this.messenger.resolveMediaRefs(refs);
      for (const r of results) {
        if (!r.ok) {
          this.pushEvent("system", `（${r.refText}：${r.error}）`, { ref: call.id });
          continue;
        }
        if (pending.filled.length < pending.placeholderCount) {
          pending.filled.push({ ref: r.ref, sticker: r.sticker });
        }
      }
      const remaining = pending.placeholderCount - pending.filled.length;
      if (remaining > 0) {
        return `（已填充 ${pending.filled.length} 张，还剩 ${remaining} 个占位符待填充，继续 pick_media 选图。）`;
      }
      // 填满：把 msg 里的每个 <img> 替换成 [图片#id]，走正常发送
      const filled = pending.filled;
      const msg = pending.msg;
      this.pendingImageFill = null;
      let filledMsg = msg;
      let i = 0;
      filledMsg = filledMsg.replace(/<img\s*\/?>/gi, () => {
        const f = filled[i++]!;
        const label = f.ref.type === "image" ? "图片" : f.ref.type === "video" ? "视频" : "音频";
        return `[${label}#${f.ref.id}]`;
      });
      // 复用原 send 的拦截/发送：直接调 messenger.send（内联 [图片#id] 会被解析成图片）
      const insist = pending.insist;
      const replyTo = pending.replyTo;
      const atSender = pending.atSender;
      const id = pending.channelKey;
      const media = filled.map((f) => String(f.ref.id));
      // 记录防复读签名（fill 后消息按「频道 + 替换后文字 + 已选图」判重）
      this.recordSendSig(JSON.stringify([id, filledMsg, media]));
      return await this.deliverSend(id, filledMsg, media, replyTo, atSender, insist);
    });
  }

  /** 无占位符时的正常发送（或填满后调用）：走 duration/长文/防复读拦截，然后真正发出。 */
  private finishSend(call: ToolCallRecord, id: string, msg: string, media: (string | number)[], replyTo: string | undefined, atSender: boolean): void {
    const longLimit = this.config.messaging.longMessageChars;
    if (longLimit > 0 && msg.length > longLimit && !isTruthy(call.arguments.confirm_long)) {
      this.pushEvent(
        "system",
        `（这条消息长达 ${msg.length} 字，没有发出。日常聊天中一条消息一般只有十来个字，太长会显得不像真人——精简一下，或确需发长文就加 confirm_long: true。）`,
        { ref: call.id },
      );
      return;
    }
    if (this.maybeDeferSend(call, "text", id, msg)) return;
    if (this.gateSendDuration(call, "打字")) return;
    const sig = JSON.stringify([id, msg, media.map(String)]);
    const recentRepeat = this.recentSendSigs.filter((s) => s === sig).length;
    const repeatThreshold = this.config.messaging.recentRepeatThreshold;
    if (repeatThreshold > 0 && recentRepeat >= repeatThreshold && !isTruthy(call.arguments.resend)) {
      this.pushEvent("system", `（你最近已经说过「${truncate(msg, 24)}」${recentRepeat} 次了。这句没有发出——换一种说法，或真的没有新内容就别说。）`, { ref: call.id });
      return;
    }
    // <img> 占位符：拦截已过，但图还没选，暂存待 pick_media 填充
    const imgCount = this.countImgPlaceholders(msg);
    if (imgCount > 0) {
      this.pendingImageFill = {
        channelKey: id,
        replyTo,
        atSender,
        msg,
        placeholderCount: imgCount,
        filled: [],
        insist: isTruthy(call.arguments.insist),
        confirmLong: isTruthy(call.arguments.confirm_long),
        resend: isTruthy(call.arguments.resend),
      };
      this.pushEvent(
        "system",
        `（这条消息里有 ${imgCount} 个图片占位符 \`<img>\`，还没有选图，所以没有发出。` +
          `请先用 check_gallery / check_media / view_media 看清要发的图，` +
          `再用 pick_media 一次选出 ${imgCount} 张图（按占位符出现的顺序），选满后消息会自动发出。）`,
        { ref: call.id },
      );
      return;
    }
    this.recordSendSig(sig);
    this.ackStart(call);
    const insist = isTruthy(call.arguments.insist);
    this.schedule(call, {
      executeAt: "expected",
      run: async () => {
        const out = await this.deliverSend(id, msg, media, replyTo, atSender, insist);
        return out;
      },
    });
  }

  /** 真正发出：切频道 + messenger.send，打断延期发送意图，回显。 */
  private async deliverSend(id: string, msg: string, media: (string | number)[], replyTo: string | undefined, atSender: boolean, insist: boolean): Promise<string | RichText> {
    const target = await this.switchToTarget(id);
    if ("error" in target) return target.error;
    const out = await this.messenger.send(target.key, msg, media, replyTo, atSender, insist);
    this.noteDeferredSelfSent(target.key);
    return this.echoChannelRecent(id, out);
  }

  /** 记录一条已发出的 send 签名，滑窗维护「最近 N 条」（超窗滑出最老） */
  private recordSendSig(sig: string): void {
    if (this.deviceExecution.getStore()?.stealth) return;
    this.recentSendSigs.push(sig);
    const window = this.config.messaging.recentRepeatWindow;
    if (this.recentSendSigs.length > window) {
      this.recentSendSigs = this.recentSendSigs.slice(this.recentSendSigs.length - window);
    }
  }

  private dispatchCancel(call: ToolCallRecord): void {
    const target = String(call.arguments.id ?? call.arguments.toolcall_id ?? "");
    const result = this.scheduler.cancel(target);
    // 撤回成功后，重发相同内容是合理操作，不应再被重复拦截——清空近期发送窗口
    if (result === "cancelled") {
      this.recentSendSigs = [];
      if (this.waiting?.callId === target) {
        this.waiting = null;
        this.wakeFn?.();
      }
    }
    const text =
      result === "cancelled"
        ? `你及时停下了 ${target}。`
        : result === "not_found"
          ? `（找不到进行中的 ${target}，它可能已经完成了。）`
          : `（${target} 已开始提交，不能保证撤销；它的真实结果仍会送达。）`;
    this.pushEvent("system", text, { ref: call.id });
  }

  /**
   * recall：回忆过往小事记（facts.jsonl）。
   * 支持关键词检索（grep）、按 T（时间单位）范围、只回忆重要回忆（important，映射到 pinned 标记，对 Bot 透明）与条数上限。
   * 结果按时间正序返回（旧的在前），便于按时间线连贯回忆。固定条目对 Bot 不显式标注，避免破坏沉浸感。
   */
  private async recallFacts(call: ToolCallRecord): Promise<string> {
    const args = call.arguments;
    const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
    const importantOnly = isTruthy(args.important);
    const n = clampInt(args.n, 1, 50, 10);
    const since = asFiniteNumber(args.since);
    const until = asFiniteNumber(args.until);

    let facts = await this.files.readFactsAll();
    if (importantOnly) facts = facts.filter((e) => e.pinned === true);
    if (since != null) facts = facts.filter((e) => e.t >= since);
    if (until != null) facts = facts.filter((e) => e.t <= until);
    if (keyword) {
      const kw = keyword.toLowerCase();
      facts = facts.filter((e) => e.content.toLowerCase().includes(kw));
    }
    // 默认取最近 n 条；范围检索时也取范围内最靠后的 n 条（更相关）
    facts = facts.slice(-n);

    if (!facts.length) {
      const hint = keyword
        ? `你努力回想「${keyword}」——但记事本里没有相关的内容。`
        : importantOnly
          ? "你努力回想那些刻骨铭心的往事——脑海里一时只有一片空白。"
          : "你努力回想自己的过往——记事本里还是一片空白。";
      return hint;
    }

    const keywordLabel = keyword ? `与「${keyword}」相关` : "";
    return (
      `旧资料${keywordLabel}（历史世界作者记录，未经本次感知核实，不能作为新的成长证据）：\n` +
      facts.map((e) => `- [T=${e.t.toFixed(1)} ${e.clock}] ${e.content}`).join("\n") +
      `\n（每条开头是它的 T 时刻：想按时间往前或往后继续回忆，就把 recall 的 since / until 填成对应的 T 数值。）`
    );
  }

  /** Observation is the only entry to physical/world state. */
  private async observe(call: ToolCallRecord): Promise<RichText> {
    const self = call.arguments.target === "self";
    const target = !self && typeof call.arguments.target === "string" ? call.arguments.target : undefined;
    const modality = self ? "self" : typeof call.arguments.modality === "string" ? call.arguments.modality : undefined;
    const observation: WorldObservation = await this.world.observe("bot", { target, modality });
    return { text: JSON.stringify(observation), originEventIds: observation.sourceEventIds };
  }

  private async readStatus(call: ToolCallRecord): Promise<RichText> {
    // Compatibility alias: neither world nor self may bypass the observation projection.
    return this.observe({ ...call, arguments: {
      ...call.arguments, target: undefined, modality: call.arguments.target === "world" ? undefined : "self",
    } });
  }

  // ---------- rest 与独立记忆整理 ----------

  /** 角色休息与记忆维护分别调度；通知始终可以打断角色休息。 */
  private dispatchRest(call: ToolCallRecord): void {
    const threshold = this.config.bot.restCompressMinChars;
    if (threshold <= 0 || this.context.approxChars() >= threshold) this.compressionRequested = "rest";
    // Actual rest is always an interruptible timer; context maintenance never imposes sleep.
    this.dispatchLightRest(call);
  }

  /** 小憩：纯计时暂停（语义同 wait），到点或被动静唤醒 */
  private dispatchLightRest(call: ToolCallRecord): void {
    const raw = Number(call.arguments.duration ?? call.duration ?? 0);
    const n = Number.isFinite(raw) && raw > 0 ? raw : 300; // 未指定时长：默认打个盹
    // expectedAt 只影响调度不进入上下文渲染，可安全修正（duration 可能写在 arguments 里）
    call.expectedAt = call.issuedAt + n;
    this.waiting = { callId: call.id, kind: "nap" };
    this.schedule(call, {
      executeAt: "expected",
      run: async () => {
        const napWake = pickMeta(
          [
            "你小憩了一会儿，回过神来。",
            "你打了个盹，慢慢醒转过来。",
            "你眯了一小会儿，重新打起了精神。",
            "你闭目养神片刻，又清醒了。",
            "你短暂地歇了一下，慢慢回神。",
            "你合眼打了个小盹，睡意消散了。",
            "你歇了歇，精神头又回来了。",
            "你小睡片刻，重新睁开了眼。",
            "你打了个短短的盹，缓过来了。",
            "你眯眼休息了一会儿，恢复了神采。",
          ],
        );
        return { text: napWake, originEventIds: [] };
      },
    });
  }

  /** Memory maintenance runs only at a generation boundary; it does not alter the body or devices. */
  private async doRest(_call: ToolCallRecord | null, reason: "overflow" | "breakLoop" | null): Promise<void> {
    if (this.compressionPromise) return this.compressionPromise;
    this.compressionPromise = this.compactContext(reason).finally(() => { this.compressionPromise = null; });
    return this.compressionPromise;
  }

  private async compactContext(reason: "overflow" | "breakLoop" | null): Promise<void> {
    await this.drainMailbox();
    const snapshot = await this.context.compressionSnapshot();
    if (!snapshot.entries.length) return;
    this.logger.info("整理记忆（%s）：%d 条记录", reason ?? "rest", snapshot.entries.length);
    let result: CompressionResult;
    try {
      result = await abortable(this.world.compress({
        persona: this.context.pinned.botDefinition,
        historySummary: this.context.pinned.historySummary,
        memoryDigest: this.context.pinned.memoryDigest,
        streamText: snapshot.text,
        timeLine: this.clock.timeLine(),
      }), this.abort?.signal);
    } catch (err) {
      if (!this.running) return;
      this.logger.warn("记忆整理失败，保留原始经历：%s", err);
      await sleep(this.config.bot.retryDelayMs, this.abort?.signal);
      return;
    }
    if (!this.running) return;
    // Ignore any legacy BOT_STATUS output: the memory writer cannot mutate objective world state.
    await this.context.applyCompression(result, this.clock.now(), snapshot);
    this.repeatGuard.reset();
    this.forceRestCount = 0;
    this.tempBannedTools.clear();
    this.refreshToolGate();
    this.wakeTimeLine = this.clock.timeLine();
  }

}

/** Parse provenance only from a typed actor observation delivered by the world boundary. */
function observationOrigins(text: string): string[] | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<WorldObservation> & { observation?: Partial<WorldObservation> };
    const data = parsed.observation ?? parsed;
    // A remote actor uses visitor:<session>, bound by the authenticated WorldAgent connection.
    if (typeof data.actorId !== "string" || !data.actorId || typeof data.observationId !== "string" || !Array.isArray(data.sourceEventIds)) return undefined;
    return [...new Set(data.sourceEventIds.filter((id): id is string => typeof id === "string" && !!id))];
  } catch { return undefined; }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, Math.min(Math.max(0, ms), 2_147_483_647));
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * 频道目标参数的常见误写（OneBot API 风格等）：没给 id/channel 却带着这些键时返回键名列表。
 * 注意 user_id 不算——群管理工具里它合法地表示"群成员"（此时频道缺省为当前群页）。
 */
export function misusedTargetKeys(args: Record<string, unknown>): string[] {
  if (args.id != null || args.channel != null) return [];
  return ["detail", "channel_id", "channelId", "target", "to", "group_id"].filter(
    (k) => args[k] != null,
  );
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\n/g, "\\n");
  return single.length > max ? sliceText(single, 0, max) + "…" : single;
}

/** RichText / string 统一取纯文本 */
function toPlainText(content: string | RichText): string {
  return typeof content === "string" ? content : content.text;
}

/**
 * 从多套**语义等价**的元话语里随机挑一套。
 * 只用于非事实性的寒暄/告警/提示语——承载事实或世界裁定的返回（状态、时间、act 结果、recall）
 * 一律不能用它随机，否则会让模型误以为状态在变、产生幻觉或漂移。
 * 用时间戳等易变内容做随机种子可避免"每次醒来同一套话"的循环感，又保持确定性可复现。
 */
function pickMeta(variants: string[], seed?: number): string {
  if (variants.length <= 1) return variants[0] ?? "";
  const n = Number.isFinite(seed) ? Math.abs(Math.floor(seed as number)) : Math.floor(Math.random() * 0x7fffffff);
  return variants[n % variants.length]!;
}

/**
 * blockingAct 专注模式的拦截提示：存在未完成的 act 时返回提示文本（Bot 不可绕过），否则返回 null。
 * 供 dispatchAct 使用，也便于冒烟测试覆盖。
 * 措辞纯正面、不点名任何工具：负面指令（"不要 act"）反而会强化模型对 act 的倾向，
 * 也不指定 "等" 等具体动作，避免把复读通成另一种路径依赖。
 *
 * repeatCount 为连续重复提交同一动作的次数（可选，默认 1）：重复次数越多，提示越明确地
 * 压下"继续重复"的冲动——递进式加压，避免温和的固定文案在长上下文里被模型无视而原地打转。
 */
export function actBusyMessage(
  pendingActs: ToolCallRecord[],
  repeatCount: number = 1,
): string | null {
  if (!pendingActs.length) return null;
  const pdesc = String(pendingActs[0]?.arguments.description ?? "").trim();
  const what = pdesc ? `「${truncate(pdesc, 60)}」` : "上一件事";
  const escalate = escalatingRepeatHint(repeatCount);
  return `（你正在做${what}，它还在进行中，结果会自动以事件的形式送到你这里。${escalate}。）`;
}

/**
 * 相同动作未出结果就再次提交的拦截提示（非 blockingAct 的"上一件完全相同的事"拦截）。
 * repeatCount 为连续重复次数，用于递进式加压。
 */
export function repeatingActMessage(sig: string, repeatCount: number, callId: string): string {
  const what = sig ? `「${truncate(sig, 48)}」` : "这件事";
  const escalate = escalatingRepeatHint(repeatCount);
  // 只在重复次数还少时提示 repeat 绕过口；一旦连续重复多次，就不再给绕过口（避免模型借此破防）
  const bypass = repeatCount < 4 ? "确实要同时再做一遍同样的事时，再在参数里加 repeat。" : "";
  return (
    `（你已经在做${what}了（${callId}），它还在进行中，这次没有重复开始；` +
    `结果会自动以事件的形式送到你这里。${escalate}。${bypass}）`
  );
}

/** 依据连续重复次数，生成越来越直白的"别重复"提示（空串 = 无需额外加压）。
 *  刻意不指向任何具体替代动作（不暗示 wait、不暗示 act），避免与其它拦截互相推诿、
 *  把模型逼进「act 被拦→去 wait、wait 被拦→去 act」的死循环。
 *  每一档都做至少 10 套字面差异较大的变体随机返回（真随机，打破固定文案的循环感）。 */
function escalatingRepeatHint(repeatCount: number): string {
  if (repeatCount >= 4) {
    return pickMeta([
      `这已经是你连续第 ${repeatCount} 次重复发起同一个动作了——它既不会因此变快，也不会重复执行；请停止重复提交同一个动作`,
      `同一个动作你已经连着第 ${repeatCount} 次发起了——多发起几次它也不会更快或更慢，白白消耗；现在请停下来，别再提交它了`,
      `这已经是第 ${repeatCount} 次了，还是那个动作——重复它带不来任何新的东西；就此打住，换个思路`,
      `注意，同样是这个动作，你已经连续提了 ${repeatCount} 次。它不会因为你多提就多做或做快，别再浪费这一步了`,
      `第 ${repeatCount} 次了，你仍在提交同一个动作。它已经受理过一次，往后的重复都是空的，请立即停手`,
      `这个动作你已经反复到第 ${repeatCount} 次，早就该停了。重复不会叠加效果，只会拖延你自己`,
      `看清楚了：同一个动作，你已经提交了 ${repeatCount} 遍。再提交多少次结果都一样，现在请停止`,
      `你已经连续 ${repeatCount} 次发起同一件事，这是无效的。请明确地想一件不同的事，或就停在原处`,
      `反复提交相同动作（已 ${repeatCount} 次）没有任何意义，它只做一次。别再重复，把这一步留给真正需要做的事`,
      `这是第 ${repeatCount} 次了，你一遍遍重复同一个动作，而它一次就够。停止这种空转，去做别的`,
    ]);
  }
  if (repeatCount >= 2) {
    return pickMeta([
      `这是你第 ${repeatCount} 次重复发起同一动作——不必再重复，它已经在进行中了`,
      `同一个动作你已经是第 ${repeatCount} 次发起了——它还在进行中，无需再补一次`,
      `这动作你已重复到第 ${repeatCount} 次——停下吧，它正在进行，结果会自然来到`,
      `你第 ${repeatCount} 次提起同一个动作了，它其实已经开始了，不用再提一次`,
      `同一个动作你已经说了 ${repeatCount} 遍，它已经在推进，别再加了`,
      `提醒：这是你第 ${repeatCount} 次发起同一件事，它早已开始，重复是多余的`,
      `这动作你已经提到第 ${repeatCount} 次，它一次就到位了，收手吧`,
      `同一个动作反复到第 ${repeatCount} 次，可以停了——它正在做，结果稍后到`,
      `你已连续第 ${repeatCount} 次发起同一个动作，它已经在进行，无需重复提及`,
      `同一个动作你提了 ${repeatCount} 次，其实第一次就已开始，后面的都是空动作`,
    ]);
  }
  return pickMeta([
    "它已经在进行中了，结果会自动送达，不用再发起一次",
    "这件事已经在推进了，结果会自己送过来，不必再重复",
    "已经在做了，等结果到即可，无需再来一次",
    "这个动作已经开始，剩下的就是等结果，别重复提交",
    "它已经在路上了，你只需静静等结果，不必再说一遍",
    "动作已经启动，结果会自然回来，重复提交是多余的",
    "这件事已在推进，无须你再次发起，等它完成就好",
    "它已经在执行了，等结果送达即可，不必重复",
    "已经开始的事不用再提，结果会自动出现",
    "这个动作就位了，接下来是等待，而不是再来一次",
  ]);
}

/** send 系工具的名字集合（send 发送消息、pick_media 填充 <img> 占位符） */
const SEND_TOOL_NAMES = ["send", "pick_media"];

/** 打破死循环时不该被移除的"安全"工具：计时/书签类，移除它们反而会让模型无处安放、更疯狂 */
function isBreakLoopSafeTool(name: string): boolean {
  return name === "wait" || name === "rest" || name === "check_status" || name === "check_time" || name === "observe_device";
}

/**
 * sendBlocking 阻塞模式：存在未完成（未回显）的 send 调用时，返回提示文本，否则 null。
 */
export function sendBusyMessage(pending: ToolCallRecord[]): string | null {
  if (!pending.length) return null;
  const what = "";
  return pickMeta([
    `（你上一条消息${what}还在发送中、还没看到结果，这次没有发出。等它的结果回显后再接着说——可以先做点别的，或整理一下接下来想说的话。）`,
    `（你上一条${what}还没发出去，又急着发新的了？先等等，看到上一条的结果再继续，别抢话。）`,
    `（上一条${what}还在路上，这条先别发。等它尘埃落定，再想下一句。）`,
    `（你刚才那条${what}还没回显，这一条被拦下了。慢慢来，一句一句说。）`,
    `（别急，上一条${what}还没发完。等它真正发出、看到结果，再开口说下一步。）`,
    `（你连着要发两条，可上一条${what}都还没见着影。先等上一条落地。）`,
    `（上一条${what}仍在发送中，这次没有发出。等回显了你再继续，别自说自话。）`,
    `（你上一条消息${what}还没看到结果，这条就没发出去。先确认上一条，再接着说。）`,
    `（前一条${what}还没发出，这条先收住。等看到结果再推进对话。）`,
    `（上一条${what}仍在途中，这条不急着发。喘口气，等上一条到位。）`,
  ]);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 宽松解析布尔参数（模型可能输出 true / "true" / 1） */
function isTruthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

/**
 * 归一化消息 id：Bot 可能照抄消息记录里的 "(msg:283828113)" 编号，
 * 把 "msg:283828113" 或 "283828113" 都归一到纯数字 "283828113"；
 * 空值 / 非数字（如 "msg:0" 这种无效值）返回 undefined（未引用）。
 */
function normalizeMsgId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let s = String(value).trim();
  if (!s) return undefined;
  // 去前缀：msg: 或带方括号 "(msg:xxx)" 之类
  const m = s.match(/(?:msg\s*:\s*)?(\d+)/i);
  if (!m) return undefined;
  const id = m[1]!;
  // "0" 是无效引用（Bot 幻觉或没拿到真实 id）
  if (id === "0") return undefined;
  return id;
}

/** 解析可选数字参数；非有限数值（含 undefined / null / 空串）返回 null（表示"没给"） */
function asFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 秒级禁言拦截：minutes 在 (0, 1) 之间（即禁言不足 60 秒）时返回提示文本。
 * 这类禁言几乎不会有实际效果，且容易让人以为已经处理了；
 * 如果确实要这么短（如拿来测自己群的接口），在参数里带 robot: true 放行。
 * 提示文本里说明了绕过参数但签名里没有它，避免模型产生惯性（与 wait 的 confirm 同理）。
 */
export function shortBanGateMessage(minutes: number, robot: boolean): string | null {
  if (robot) return null;
  if (minutes > 0 && minutes < 1) {
    return `禁言时长 ${minutes} 分钟不到 1 分钟（低于 60 秒的禁言几乎没有实际意义）已被拦下——` +
      `如果你确实要这么短的禁言（比如在自己群测试接口），再调用一次 group_ban 并加上 robot: true；` +
      `否则请给出至少 1 分钟的时长。`;
  }
  return null;
}

/** 宽松解析 id 列表参数：数组、或逗号/空格分隔的字符串 */
function normalizeIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (value != null) {
    return String(value)
      .split(/[,\s、]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * 状态文件的行级 diff：返回新增/变化（+）与不再存在（-）的行；完全相同返回 null。
 * 只做逐行集合比较（行的移动会被视为无变化），对 Markdown 状态文件足够用。
 */
export function diffLines(oldText: string, newText: string): string | null {
  if (oldText === newText) return null;
  const clean = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const oldLines = clean(oldText);
  const newLines = clean(newText);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => !oldSet.has(l));
  const removed = oldLines.filter((l) => !newSet.has(l));
  if (!added.length && !removed.length) return null;
  return [...added.map((l) => `+ ${l}`), ...removed.map((l) => `- ${l}`)].join("\n");
}
