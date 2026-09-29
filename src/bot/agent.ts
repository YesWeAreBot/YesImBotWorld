import type { Logger } from "koishi";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ComputerDevice } from "../apps/computerDevice.js";
import type { AppManager } from "../apps/manager.js";
import type { WorldClock } from "../clock.js";
import { needsMsgIds, type Config } from "../config.js";
import type { WorldFiles } from "../files.js";
import { canonicalizeArgs, RepeatGuard, type ObserveResult } from "./repeatGuard.js";
import { ToolCallParseError } from "../llm/parse.js";
import type { BotEvent, CompressionResult, EventSource, ExperienceMetadata, MediaRef, ParsedToolCall, PhoneStatus, PickFailure, PickResult, RichText, RichTextPart, ToolCallRecord } from "../types.js";
import type { WorldAgent } from "../world/agent.js";
import type { NotifyManager } from "../koishi/notify.js";
import { normalizeMsgId } from "../koishi/markers.js";
import { resolveOutgoingQuote } from "../koishi/quotes.js";
import { senderTagError } from "../koishi/sender-tags.js";
import { debug } from "../webui/debug.js";
import { createBackend, type BotBackend } from "./backend.js";
import type { BotContext } from "./context.js";
import { describeToolCall, Scheduler, type ScheduleOptions } from "./scheduler.js";
import { deviceKind, type DeviceKind } from "../apps/deviceTools.js";
import { GrowthLedger, type GrowthKind, type ReflectionOpportunity, type ReflectionRelation } from "./growth.js";
import { GrowthRuntime } from "./growth-runtime.js";
import { ReceiptInbox } from "./receipts.js";
import { DeliberationBudget, thoughtError } from "./deliberation.js";
import { WorldActionInterleave, worldActionReceiptKey } from "./world-action-interleave.js";
import { collectOpportunities, currentWorldEpoch, type ActionOpportunity } from "./opportunities.js";
import { choiceRejection, type ChoiceSelection } from "./choice.js";
import { conversationMaterialReminder } from "./conversation-material.js";
import { ToolCapabilityAnnouncements } from "./tool-capabilities.js";
import { planToolNavigation, sendTargetError } from "./navigation.js";
import { canReachPhone, canUsePhone, canPerceivePhone, phonePhysicalState, phoneUnavailableReason, setPhoneDown, withPhoneExecutionLock } from "../phone-state.js";
import { spillNarrativeText } from "./narrative-spill.js";
import type { WorldObservation } from "../world/state.js";
import { typingSlackTU } from "./typing.js";
import { BOT_TOOLS, renderToolsText, renderToolHelp, renderToolHelpIndex, toolLayer, type BotToolDef } from "./tools.js";
import type { AppToolDef } from "../apps/app.js";
import { signatureParams } from "./nativeTools.js";
import { sliceText } from "../text.js";
import { detectDeviceRequest, DEVICE_TOOL_GUIDANCE } from "../world/device-boundary.js";
import { SCENE_CHOICE_GUIDANCE, THOUGHT_RUNTIME_GUIDANCE, TOOL_HELP_GUIDANCE, TOOL_RESULT_GUIDANCE, SLEEP_AND_DEVICE_GUIDANCE } from "../prompts.js";

/** 代理执行单个工具调用的回传结果（管理员「手动驾驶」Bot） */
export interface ManualToolResult {
  ok: boolean;
  callId?: string;
  /** Explicitly rejected before dispatch; never infer this from a real receipt's prose. */
  admissionRejected?: true;
  code?: "STALE_SELECTION" | "SELECTION_REJECTED";
  /** 工具结果 / 校验拒绝原因 */
  text: string;
  content?: RichText;
}

/** A read-only copy of a perception already persisted in the Bot's context; no local media files. */
export interface BotPerception {
  sequence: number;
  event: Pick<BotEvent, "id" | "source" | "content" | "worldTime" | "refToolCallId" | "originEventIds">;
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
export interface MessageSendReceipt {
  /** `unknown` includes timeouts: lack of an acknowledgement is not proof of non-delivery. */
  status: "sent" | "partial" | "blocked" | "unknown";
  text: string;
  messageIds: string[];
  originEventIds?: string[];
  experience?: ExperienceMetadata;
}

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
  /** Internal delivery facts; the text-only entry point remains available to integrations. */
  sendReceipt?(id: string, msg: string, media?: (string | number)[], replyTo?: string, atSender?: boolean, insist?: boolean): Promise<MessageSendReceipt>;
  putDownPhone(): Promise<string>;
  recall(id: string, msgId: string): Promise<string>;
  react(id: string, msgId: string, emoji: string, remove?: boolean): Promise<string>;
  emojiLikes(id: string, msgId: string, emoji: string): Promise<string>;
  forwardMsgs(id: string, msgIds: string[]): Promise<string>;
  ocrImage(image: string): Promise<string>;
  viewForward(id: string): Promise<RichText>;
  poke(id: string, userId?: string): Promise<string>;
  handleRequest(requestId: string, approve: boolean, reason?: string): Promise<string>;
  listFriends(options?: { cursor?: string; limit?: number; preview?: boolean }): Promise<string | RichText>;
  userInfo(userId: string): Promise<string>;
  viewAvatar(id: string, userId: string): Promise<RichText>;
  sendLike(userId: string, times: number): Promise<string>;
  deleteFriend(userId: string): Promise<string>;
  setProfile(opts: { nickname?: string; signature?: string; avatar?: string }): Promise<string>;
  setModelShow(model: string): Promise<string>;
  listGroups(options?: { cursor?: string; limit?: number; preview?: boolean }): Promise<string | RichText>;
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
  contextHint?: { text: string };
  experience?: ExperienceMetadata;
  growthReferences?: { claimId: string; recordId: string }[];
  /** Retry the same durable IDs when an append/counter checkpoint fails. */
  event?: BotEvent;
  toolCallRecord?: ToolCallRecord;
  originEventIds?: string[];
  source: EventSource;
  content: string;
  attachments?: MediaRef[];
  parts?: RichTextPart[];
  refToolCallId?: string;
  /** Retain interruption intent until delivery, including events received during inference. */
  wake?: boolean;
  /** Scheduler truth used only for live decision admission, never model-authored. */
  toolResultOk?: boolean;
  toolResultKey?: string;
  /** A readback is perceived input, but cannot create a fresh external wake budget. */
  toolObservation?: boolean;
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
 * 派发执行 → 继续生成；工具可用性分别控制，无效调用重试采用可唤醒退避。
 *
 * 阻塞规则：上下文修改（事件注入、压缩）只发生在两次生成之间 ——
 * 事件先进 mailbox，在下一次生成开始前统一追加。
 *
 * 默认等待真实结果；等待世界动作时，新的聊天可开启有界的独立设备操作。
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
  private readonly growthRuntime: GrowthRuntime;
  private growthToolWrites = new Set<Promise<string | RichText>>();
  private operationCalls = new Map<string, ToolCallRecord>();
  private pendingOperationNotices = new Map<string, BotEvent>();
  private failedToolHelp = new Set<string>();
  private pendingToolHelp = new Set<string>();
  private navigationOutcomes = new Map<string, boolean>();
  private readonly receipts: ReceiptInbox;
  private retired = false;
  private receiptsPending = false;
  private draining: Promise<void> | null = null;
  private growthRestored = false;
  private reflectionPending: { opportunity: ReflectionOpportunity; event: BotEvent; appended: boolean } | null = null;
  private compressionRequested: "overflow" | "breakLoop" | "rest" | null = null;
  private compressionPromise: Promise<void> | null = null;
  private generationAbort: AbortController | null = null;
  private mailbox: MailboxItem[] = [];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private waiting: { callId: string; kind?: "wait" | "rest"; startedTU?: number; worldCalls?: string[] } | null = null;
  private wakeFn: (() => void) | null = null;
  /** Wakes mailbox maintenance without releasing the pending tool's generation gate. */
  private toolResultWakeFn: (() => void) | null = null;
  private deliberation: DeliberationBudget;
  private awaitingToolRetry = false;
  private awaitingToolResult: string | null = null;
  private readonly worldActionInterleave = new WorldActionInterleave();
  private phoneExecutionEpoch = 0;
  private thoughtGuidanceDelivered = false;
  private expressionGuidanceDelivered = false;
  private opportunityStamp: string | undefined;
  private announcedOpportunities: ActionOpportunity[] = [];
  private lastGenAt = 0;
  /**
   * 近期已发消息的签名滑动窗口（频道+内容+图片），用于拦截"近期反复说同一句"——
   * 不只是相邻两条，而是同一句话在最近 N 条里重复出现就拦（治"口头禅式复读"）。
   */
  private recentSendSigs: string[] = [];
  private uncertainSendSigs = new Set<string>();
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
  /** Root IDs survive context compaction; rereading a result is not new progress. */
  private progressRoots = new Set<string>();
  private observedWorldShape: string | null = null;
  /**
   * 打破死循环的强制手段（breakLoop）：
   * - tempBannedTools：被暂时移除的工具（下次压缩后自动恢复）；
   * - forceRestCount：移除工具后仍在重复的累计次数，达到 breakLoopForceRestAt 时强制 rest。
   */
  private tempBannedTools = new Set<string>();
  private forceRestCount = 0;
  /**
   * Actual autonomous wait/rest intervals. Notifications and compaction do not renew this budget.
   */
  private waitLog: { from: number; to: number }[] = [];
  private pauseStarts = new Map<string, { from: number; autonomous: boolean }>();
  /**
   * Pause confirmation applies only to the same tool immediately after a refusal.
   * 静态的绕过参数会被模型货物崇拜——每次都习惯性带上 confirm，拦截就形同虚设；
   * 单次通行证保证每一次高占比等待都要经过一轮显式的"拦下 → 确认"。
   */
  private pauseConfirmArmed: "wait" | "rest" | null = null;
  /** 连续几次模型输出不是合法工具调用，用于在反馈里提示模型直接输出 JSON */
  private parseFailures = 0;
  /**
   * 手动驾驶标志：管理员「扮演（avatar）接管 Bot」时开启，runLoop 只排空邮箱、
   * 处理外部注入的工具调用，不再自主 generate；「操纵（puppet）」不暂停。
   */
  private manualPaused = false;
  private residentControl: { mode: "avatar" | "puppet"; sessionId: string } | null = null;
  private perceptionSequence = 0;
  private deliveredPerceptions: BotPerception[] = [];
  private perceptionListeners = new Set<(perception: BotPerception) => void>();
  private residentClosing = false;
  private residentAdmissions = 0;
  private residentAdmissionWaiters = new Set<() => void>();
  private puppetCalls = new Set<string>();
  private controlAuditTail: Promise<void> = Promise.resolve();
  private autonomousDispatch: Promise<void> | null = null;
  private deviceExecution = new AsyncLocalStorage<{ stealth: boolean; external?: boolean }>();
  private stealthCalls = new Set<string>();
  private attention: DeviceKind | null = null;
  /** Explicitly looking at the nearby screen need not pick up the phone. */
  private observingPlacedPhone = false;
  private deviceOperations = 0;
  private knownDeviceTools = new Map<string, DeviceKind>();
  private concealedDevices = new Set<DeviceKind>();
  private perceivedToolNames: string[] = [];
  private perceivedAppDefs: AppToolDef[] = [];
  private perceivedCapabilities: BotToolDef[] | null = null;
  private capabilityAnnouncements: ToolCapabilityAnnouncements | null = null;
  private capabilityWindow = -1;
  private pendingCapabilityNotice: BotEvent | null = null;
  /**
   * 外部注入（管理员代理）工具调用的结果回传表：callId → 解析器。
   * 结果经 scheduler 的 deliver 通道（source=tool）回传；校验拒绝时的 system 提示在此暂存，
   * 由 injectExternalToolCall 在 dispatch 返回后判定「未进入调度」时兜底回传。
   */
  private externalToolResults = new Map<string, { resolve: (r: ManualToolResult) => void; systemText: string | null }>();
  /**
   * 固定上下文窗口的记录时刻：仅在 start() 与记忆整理后更新，不代表角色醒来。
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
    this.toolDefs = (tools ?? BOT_TOOLS).filter(tool => !["observe", "choose"].includes(tool.name));
    this.deliberation = new DeliberationBudget(context.stream);
    this.growth = new GrowthLedger(files.base);
    this.growthRuntime = new GrowthRuntime(this.growth, config.bot, clock, context, logger);
    this.receipts = new ReceiptInbox(files.base);
    this.repeatGuard = new RepeatGuard({
      thresholds: config.bot.repeatThresholds ?? [3, 5, 8],
      include: [],
      exclude: config.bot.repeatExclude ?? [],
      argumentsPreviewChars: 500,
    });
    for (const entry of context.stream) if (entry.kind === "event") this.noteProgress(entry.event, false);
    this.logger.info(
      "[repeatGuard] thresholds=%s exclude=%s",
      JSON.stringify(config.bot.repeatThresholds ?? [3, 5, 8]),
      JSON.stringify(config.bot.repeatExclude ?? []),
    );
    // 原生声明在第一次生成时冻结；实时允许集通过追加的能力事件更新。
    this.backend = createBackend(config.bot, this.layerNames("core"), this.toolDefs);
    this.scheduler = new Scheduler(
      clock,
      (content, ref, outcome) => {
        if (ref && this.navigationOutcomes.has(ref)) this.navigationOutcomes.set(ref, outcome?.ok === true);
        if (outcome?.ok === false && typeof content !== "string") {
          const { contextHint: _hint, ...raw } = content;
          content = raw;
        }
        const performed = ref ? this.operationCalls.get(ref) : undefined;
        if (outcome?.ok === false && performed?.role === "agent" && !performed.control && !["act", "wait", "rest", "cancel", "help"].includes(performed.name)) this.pendingToolHelp.add(performed.name);
        if (ref) this.operationCalls.delete(ref);
        if (ref && this.stealthCalls.has(ref)) {
          this.externalToolResults.get(ref)?.resolve({ ok: outcome?.ok ?? true, text: toPlainText(content), ...(typeof content === "string" ? {} : { content }) });
          this.externalToolResults.delete(ref);
          this.stealthCalls.delete(ref);
          return;
        }
        const precedingObservations = typeof content === "string" ? [] : content.precedingObservations ?? [];
        const followingObservations = typeof content === "string" ? [] : content.followingObservations ?? [];
        if (typeof content !== "string" && (content.precedingObservations || content.followingObservations)) {
          const { precedingObservations: _preceding, followingObservations: _following, ...receipt } = content;
          content = receipt;
        }
        // Preserve non-voluntary provenance before a retired agent persists a late receipt.
        content = this.describeExperience(content, performed, outcome?.ok);
        content = this.puppetReceipt(content, ref);
        if (this.retired) {
          if (ref) {
            this.externalToolResults.get(ref)?.resolve({ ok: outcome?.ok ?? true, text: toPlainText(content), ...(typeof content === "string" ? {} : { content }) });
            this.externalToolResults.delete(ref);
          }
          void this.receipts.save({ ...(typeof content === "string" ? { text: content } : content), precedingObservations, followingObservations }, this.clock.now(), ref,
            this.isWakeableToolResult(performed?.name, typeof content === "string" ? {} : content))
            .catch(error => this.logger.error("停止后的工具回执保存失败：%s", error));
          return;
        }
        // 结果溢出治理（spill/prune）：超阈值的结果先裁剪为 head/tail 预览 + 全文落盘，
        // 再进入上下文——防止超大结果反复占据窗口、加剧退化。
        const toolResultKey = outcome?.ok && performed && this.independentWorldScope() &&
          (this.classifyDevice(performed.name) || performed.name === "observe_device") ? worldActionReceiptKey(performed, content) : undefined;
        const gated = this.spillResult(content, ref);
        // 手动驾驶（管理员代理）工具结果回传：真正执行结果在此交付，回传给发起方
        if (ref) {
          const pending = this.externalToolResults.get(ref);
          if (pending) {
            this.externalToolResults.delete(ref);
            pending.resolve({ ok: outcome?.ok ?? true, text: toPlainText(gated), ...(typeof gated === "string" ? {} : { content: gated }) });
          }
        }
        for (const observation of precedingObservations) this.pushEvent(observation.source ?? "world", this.spillResult(observation), { toolObservation: true });
        this.pushEvent("tool", gated, { ref, toolResultOk: outcome?.ok, toolResultKey, wake: this.isWakeableToolResult(performed?.name, typeof gated === "string" ? {} : gated) });
        for (const observation of followingObservations) {
          this.pushEvent(observation.source ?? "koishi", this.spillResult(observation), { toolObservation: true });
        }
        if (ref) this.puppetCalls.delete(ref);
        this.refreshToolGate();
      },
      logger,
    );
    this.refreshToolGate();
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
   * 原生声明保留到压缩边界；新工具及参数变化通过追加事件呈现。
   */
  private currentToolNames(excludeCallId?: string, includeBanned = false, autonomous = true): string[] {
    const names = [...this.layerNames("core")];
    if (this.phoneUi.chatOpen) {
      names.push(...this.layerNames("chat"));
      if (!autonomous && this.notifyList) names.push("channel_notify");
      if (this.phoneUi.channelKey) {
        names.push(...this.layerNames("channel"));
        if (this.phoneUi.channelIsGroup) names.push(...this.layerNames("group"));
      } else if (this.lastNotifyKey) {
        // 未点进频道页，但有最近通知源（收到过外部消息）→ 允许 send/pick_media 带 id 快捷回复
        // 其余 channel 工具（unsend/react/poke 等）仍需真正进入频道页。
        names.push(...this.layerNames("channel").filter(name => name === "send" || name === "pick_media"));
      }
    }
    const appDefs = [...(this.apps?.activeToolDefs() ?? []), ...(this.computer?.activeToolDefs() ?? [])];
    names.push(...appDefs.map((d) => d.name));
    const pending = this.scheduler?.pending().filter(task => task.id !== excludeCallId && !this.stealthCalls.has(task.id)) ?? [];
    const travelling = pending.some(task => task.name === "travel" || task.name === "go_home");
    const location = this.crossing?.location();
    const meaningful = (name: string): boolean => {
      switch (name) {
        case "choose": return false; // Retired model shortcut; human menus resolve stable references separately.
        case "think": return !autonomous || this.deliberation.canThink;
        case "observe": return false; // Retired public tool; historical receipts remain readable.
        case "act": return !this.strictToolLoop && this.config.bot.blockingAct === false || !pending.some(task => task.name === "act");
        case "pick_up_phone": return this.phone.down && canReachPhone(this.phone);
        case "put_down_phone": return !this.phone.down;
        case "open_app": return !!this.apps;
        case "close_app": return this.phoneUi.chatOpen || !!this.apps?.currentName;
        case "open_computer": return !!this.computer && this.computer.available !== false && (!this.computer.isOpen || !this.computer.activeToolDefs().length);
        case "close_computer": return !!this.computer?.isOpen;
        case "exit_forward": return this.phoneUi.forwardStack.length > 0;
        case "channel_notify": return !!this.notifyList;
        case "phone_notifications": return !!this.notifyList;
        case "cancel": return pending.some(task => !task.committed);
        case "travel": return !travelling && !!this.crossing?.voluntaryWorlds().some(name => name !== location);
        case "go_home": return !travelling && !!location;
        default: return true;
      }
    };
    const independentWorld = autonomous && this.independentWorldScope();
    // 打破死循环：临时禁用被判定为「反复调用」的工具（下次压缩后自然恢复）
    return [...new Set(names)].filter((n) => (includeBanned || !this.tempBannedTools.has(n)) && meaningful(n) &&
      // beforeStart validates the original act after scheduling it. It may execute
      // itself, but meaningful() above still excludes any second pending act.
      (!independentWorld || this.independentWorldTool(n) ||
        n === "act" && !!excludeCallId && this.operationCalls.get(excludeCallId)?.name === "act") &&
      (this.classifyDevice(n) !== "phone" || ["pick_up_phone", "put_down_phone"].includes(n) ||
        phonePhysicalState(this.phone).usable && (!autonomous || canReachPhone(this.phone))));
  }

  /** Previously discovered app operations are candidates, not permission to bypass their owner. */
  private learnedDeviceDefs(): BotToolDef[] {
    const phone = this.apps?.knownToolDefs?.() ?? [], computer = this.computer?.knownToolDefs?.() ?? [];
    const conflicts = new Set(phone.filter(def => computer.some(other => other.name === def.name)).map(def => def.name));
    return [...phone, ...computer].filter(def => !conflicts.has(def.name) && !this.toolDefs.some(core => core.name === def.name));
  }

  private navigableToolNames(): string[] {
    if (this.residentControl?.mode === "puppet") return [];
    return [...this.toolDefs.filter(def => this.classifyDevice(def.name) === "phone" && !["exit_forward", "pick_up_phone", "put_down_phone", "close_app"].includes(def.name)), ...this.learnedDeviceDefs()]
      .map(def => def.name).filter(name => !this.tempBannedTools.has(name));
  }

  /** Keep execution gates live; announce only the net change at a delivery boundary. */
  private refreshToolGate(): void {
    if (this.deviceExecution.getStore()?.stealth) return;
    let allowed = this.currentToolNames(undefined, true);
    let appDefs = [...(this.apps?.activeToolDefs() ?? []), ...(this.computer?.activeToolDefs() ?? [])];
    for (const name of allowed) { const kind = this.classifyDevice(name); if (kind) this.knownDeviceTools.set(name, kind); }
    // An unattended screen is not an omniscient connection monitor. Body/phone posture
    // is immediately felt, while hidden app changes wait until the next actual look/touch.
    const hidden = (name: string) => {
      if (!this.perceivedCapabilities || name === "pick_up_phone" || name === "put_down_phone") return false;
      const kind = this.classifyDevice(name);
      return !!kind && (this.concealedDevices.has(kind) || (this.deviceAttention !== kind && !(this.deviceOperations > 0 && this.attention === kind)));
    };
    allowed = [...allowed.filter(name => !hidden(name)), ...this.perceivedToolNames.filter(hidden)];
    appDefs = [...appDefs.filter(def => !hidden(def.name)), ...this.perceivedAppDefs.filter(def => hidden(def.name))];
    this.perceivedToolNames = [...new Set(allowed)];
    this.perceivedAppDefs = structuredClone(appDefs);
    allowed = this.perceivedToolNames.filter(name => !this.tempBannedTools.has(name) && (this.residentControl?.mode !== "puppet" || this.autonomousDuringPuppet(name)));
    this.backend.setToolNames(allowed);
    this.backend.setNavigableToolNames?.(this.navigableToolNames());
    this.backend.setToolDefs?.([...this.toolDefs, ...this.learnedDeviceDefs(), ...appDefs]);
    const defs = [...this.toolDefs, ...appDefs].filter(def => allowed.includes(def.name));
    this.context.setCurrentToolsText(renderToolsText(defs));
    this.perceivedCapabilities = structuredClone(defs);
    if (this.awaitingToolRetry && !this.pendingWorldOperations()) this.wakeFn?.();
  }

  private async announceToolChanges(): Promise<void> {
    this.refreshToolGate();
    if (!this.capabilityAnnouncements || this.capabilityWindow !== this.context.windowRevision) {
      this.capabilityAnnouncements = new ToolCapabilityAnnouncements(this.context.pinned.toolsText, this.context.stream);
      this.capabilityWindow = this.context.windowRevision;
    }
    if (!this.pendingCapabilityNotice) {
      const notice = this.capabilityAnnouncements.prepare(this.perceivedCapabilities ?? [], this.navigableToolNames());
      if (!notice) return;
      this.pendingCapabilityNotice = { id: this.context.nextEventId(), source: "system", originEventIds: [],
        worldTime: this.clock.now(), content: notice.content, toolAvailability: notice.update };
    }
    const event = this.pendingCapabilityNotice;
    // A failed write must not make an unreceived definition count as already explained.
    await this.context.appendEvent(event);
    this.capabilityAnnouncements.commit(event.toolAvailability!);
    this.pendingCapabilityNotice = null;
    this.publishPerception(event);
    // Live state may have changed while persistence yielded, or after a failed write.
    if (this.capabilityAnnouncements.prepare(this.perceivedCapabilities ?? [], this.navigableToolNames())) await this.announceToolChanges();
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

  /** A default target belongs to the screen seen when deciding, not a screen
   * another operator opened while generation or navigation was in flight. */
  private channelDecisionError(call: ParsedToolCall, channelAtDecision: string | null): string | undefined {
    if (call.name === "send") return sendTargetError(call.arguments);
    const layer = toolLayer(call.name);
    if (call.name === "exit_forward" || layer !== "channel" && layer !== "group" || Object.hasOwn(call.arguments, "id") || Object.hasOwn(call.arguments, "channel")) return;
    if (!channelAtDecision) return "缺少目标频道：尚未确认当前会话，请填写 id。";
    if (this.concealedDevices.has("phone") || !this.phoneUi.chatOpen || this.phoneUi.channelKey !== channelAtDecision) {
      return "本次未执行：决定期间当前会话已改变，请确认目标频道 id。";
    }
  }

  /**
   * 进入（或切换到）一个频道页：更新当前频道、按频道类型解锁操作。
   * 工具集有变化时（首次进频道 / 群私切换）以事件展开可用操作。
   */
  private async enterChannel(key: string, isPrivate: boolean): Promise<void> {
    const isGroup = !isPrivate;
    const prev = this.phoneUi;
    this.phoneUi = { chatOpen: true, channelKey: key, channelIsGroup: isGroup, forwardStack: [] };
    this.refreshToolGate();
    // 注意力转移到别的频道：打断之前挂着的"过会儿再发"念头（频道切换并不总是先离开旧频道）
    if (prev.channelKey && prev.channelKey !== key) {
      this.interruptAllDeferred("你把注意力转去了别处");
    }
    if (prev.channelKey !== key || prev.channelIsGroup !== isGroup) this.pushEvent("system", `当前${isGroup ? "群聊" : "私聊"}：${key}。`);
  }

  // ---------- 生命周期 ----------

  start(): void {
    if (this.running || this.loopPromise) return;
    this.running = true;
    this.retired = false;
    for (const entry of this.context.stream) if (entry.kind === "event") this.worldActionInterleave.external(entry.event, false);
    this.growthRuntime.resume();
    this.receipts.activate(() => { this.receiptsPending = true; this.wakeFn?.(); this.toolResultWakeFn?.(); });
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
    this.phoneExecutionEpoch++;
    this.worldActionInterleave.reset();
    this.growthRuntime.stop();
    this.retired = true;
    this.perceptionListeners.clear();
    this.receipts.deactivate();
    for (const id of this.pauseStarts.keys()) this.finishPause(id);
    if (!this.running && !this.loopPromise) {
      this.scheduler.stopAll();
      for (const id of this.operationCalls.keys()) if (!this.scheduler.isPending(id)) this.operationCalls.delete(id);
      await this.settleGrowthWrites();
      await this.draining;
      await this.context.settled();
      await this.receipts.settled(); return;
    }
    this.running = false;
    this.abort?.abort();
    this.scheduler.stopAll();
    for (const id of this.operationCalls.keys()) if (!this.scheduler.isPending(id)) this.operationCalls.delete(id);
    this.stopAllDeferred();
    this.waiting = null;
    this.wakeFn?.();
    await this.loopPromise;
    // Stop returns before a reset can reuse these paths. A cancelled model request
    // exits promptly, while a journal append already begun must finish first.
    await this.settleGrowthWrites();
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

  /** Capture this before acquiring control: earlier private history is never replayed to a new session. */
  perceptionCursor(): number { return this.perceptionSequence; }

  subscribePerceptions(listener: (perception: BotPerception) => void, afterSequence: number): () => void {
    if (this.retired) return () => {};
    let active = true;
    const deliver = (perception: BotPerception) => {
      if (!active || this.retired || perception.sequence <= afterSequence) return;
      // Observers must neither mutate durable input nor delay/fail its processing.
      try { void Promise.resolve(listener(structuredClone(perception))).catch(() => {}); } catch { /* isolated observer */ }
    };
    this.perceptionListeners.add(deliver);
    for (const perception of this.deliveredPerceptions) deliver(perception);
    return () => { active = false; this.perceptionListeners.delete(deliver); };
  }

  private publishPerception(event: BotEvent): void {
    if (this.retired || this.deliveredPerceptions.some(item => item.event.id === event.id)) return;
    const { id, source, content, worldTime, refToolCallId, originEventIds } = event;
    const perception: BotPerception = { sequence: ++this.perceptionSequence,
      event: { id, source, content, worldTime, refToolCallId, originEventIds: originEventIds?.slice() } };
    this.deliveredPerceptions.push(perception);
    if (this.deliveredPerceptions.length > 256) this.deliveredPerceptions.shift();
    for (const listener of [...this.perceptionListeners]) listener(perception);
  }

  status(): {
    running: boolean;
    waiting: string | null;
    streamLength: number;
    approxChars: number;
    pendingTasks: number;
    /** 手动驾驶（管理员接管 Bot）是否暂停了自主生成 */
    paused: boolean;
    awaitingToolRetry: boolean;
    awaitingToolResult: string | null;
    opportunities: ActionOpportunity[];
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
      awaitingToolRetry: this.awaitingToolRetry,
      awaitingToolResult: this.awaitingToolResult,
      opportunities: this.actionOpportunities(),
      phoneUi: {
        chatOpen: this.phoneUi.chatOpen,
        channelKey: this.phoneUi.channelKey,
        channelIsGroup: this.phoneUi.channelIsGroup,
        forwardDepth: this.phoneUi.forwardStack.length,
      },
    };
  }

  /** Suggestions use only delivered scenes and perceived capabilities, never hidden device state. */
  private consumedHumanChoices = new Set<string>();

  actionOpportunities(mode?: "avatar" | "puppet", ignoredCallId?: string): ActionOpportunity[] {
    const names = mode ? this.manualTools(mode) : (this.perceivedCapabilities ?? []).map(def => def.name);
    const history = this.context.opportunityStream();
    return collectOpportunities(ignoredCallId ? history.filter(entry => entry.kind !== "tool_call" || entry.call.id !== ignoredCallId) : history, names)
      .map(option => option.call?.name === "open_app" && option.call.arguments.name === "chat"
        ? { ...option, call: { ...option.call, arguments: { ...option.call.arguments, name: this.config.apps?.chatAppName || "QQ" } } } : option)
      .filter(option => !mode || !this.consumedHumanChoices.has(option.source === "world" ? `world:${option.sourceEventId}` : `device:${option.id}`));
  }

  private get perceivedWorldEpoch(): string {
    // Route changes enter the mailbox synchronously, including while a human call is admitted.
    const queued = [...this.mailbox].reverse().find(item => item.source === "system" && item.experience?.worldTransition);
    return queued?.experience?.worldTransition?.epoch ?? currentWorldEpoch(this.context.opportunityStream());
  }

  private async announceOpportunities(opportunities: ActionOpportunity[]): Promise<void> {
    const prefix = "（当前可考虑的行动机会；";
    const lines = opportunities.map((option, index) => `${index + 1}. [${option.source === "world" ? "世界" : "设备"}] ${option.label}：${option.intent}` +
      (option.exclusiveGroup ? `〔取舍组 ${option.exclusiveGroup}，可能无法同时选择〕` : "") +
      (option.replyTo ? `\n   使用 send，id=${JSON.stringify(option.replyTo)}，msg 由你自行组织；不是物理 act。` : "") +
      (option.call ? `\n   对应工具：${JSON.stringify(option.call)}` : ""));
    const content = prefix + "有合适的就使用对应工具，也可自由行动。物理行动用 act；聊天和软件必须通过实际设备工具。建议不代表已经行动或保证结果。）\n" +
      (lines.length ? lines.join("\n") : "此前的建议已不再作为当前选择；仍可依照当前能力自由行动。");
    const stamp = JSON.stringify([this.context.windowRevision, opportunities]);
    if (stamp === this.opportunityStamp) return;
    const prior = [...this.context.stream].reverse().find(entry => entry.kind === "event" && entry.event.source === "system" && entry.event.content.startsWith(prefix));
    if ((!opportunities.length && !prior) || (prior?.kind === "event" && prior.event.content === content)) {
      this.announcedOpportunities = structuredClone(opportunities);
      this.opportunityStamp = stamp; return;
    }
    const event: BotEvent = { id: this.context.nextEventId(), source: "system", originEventIds: [], worldTime: this.clock.now(), content };
    await this.context.appendEvent(event);
    this.announcedOpportunities = structuredClone(opportunities);
    this.opportunityStamp = stamp;
    this.publishPerception(event);
  }

  // ---------- 事件注入（唯一入口） ----------

  /** Background device signals remain perceptible even when a hidden controller
   * started their timers/promises. Do not inherit that tool's private receipt scope. */
  notifyDevice(content: RichText, opts: { wake?: boolean } = {}): void {
    this.deviceExecution.run({ stealth: false }, () => this.pushEvent("system", {
      ...content,
      originEventIds: content.originEventIds ?? [],
      experience: { ...content.experience, agency: "observed", opportunity: false, worldPerception: false },
    }, { wake: opts.wake ?? true }));
  }

  /** The service calls this only after committed physical facts change. */
  phonePhysicalStateChanged(): void {
    if (!canUsePhone(this.phone)) {
      if (this.attention === "phone") this.attention = null;
      this.observingPlacedPhone = false;
      this.interruptAllDeferred("手机当前不可操作");
      for (const task of this.scheduler.pending()) {
        const call = this.operationCalls.get(task.id);
        if (call?.role === "system" && !call.control && phonePhysicalState(this.phone).usable) continue;
        if (this.classifyDevice(task.name) !== "phone" || task.committed || this.scheduler.cancel(task.id) !== "cancelled") continue;
        const text = "手机状态变化，此操作已取消。";
        this.externalToolResults.get(task.id)?.resolve({ ok: false, callId: task.id, text });
        this.externalToolResults.delete(task.id);
        if (!this.stealthCalls.has(task.id)) this.pushEvent("system", text, { ref: task.id });
        this.stealthCalls.delete(task.id); this.puppetCalls.delete(task.id); this.operationCalls.delete(task.id);
      }
    }
    this.refreshToolGate();
  }

  /**
   * 向 Bot 的意识流投递事件。实际追加发生在两次生成之间（阻塞规则）。
   * wake: Bot 处于 wait() 时是否将其提前唤醒。
   */
  pushEvent(
    source: EventSource,
    content: string | RichText,
    opts: { ref?: string; wake?: boolean; originEventIds?: string[]; toolResultOk?: boolean; toolResultKey?: string; toolObservation?: boolean } = {},
  ): void {
    let rich = this.puppetReceipt(content, opts.ref);
    if (source === "system" && rich.experience?.worldTransition) this.generationAbort?.abort();
    if ((source === "world" || rich.experience?.worldPerception) && rich.experience?.worldEpoch && rich.experience.worldEpoch !== this.perceivedWorldEpoch) {
      rich = { ...rich, experience: { ...rich.experience, historicalWorld: true } };
    }
    const puppetResult = source === "tool" && !!opts.ref && this.puppetCalls.has(opts.ref);
    // 手动驾驶（管理员代理）结果回传：捕获被校验拒绝时的 system 提示（source=system 且 ref 命中）。
    // 真正执行结果由 scheduler deliver 通道回传，不在此处理。
    if (opts.ref && source === "system") {
      const pending = this.externalToolResults.get(opts.ref);
      if (pending && pending.systemText === null) pending.systemText = rich.text;
    }
    if ((opts.ref && this.stealthCalls.has(opts.ref)) || (this.deviceExecution.getStore()?.stealth && (source === "system" || source === "tool"))) return;
    // Explicit quiet delivery (notification permissions) wins over source defaults.
    const wake = opts.wake ?? (!rich.experience?.internalThought && !rich.experience?.historicalWorld &&
      (source === "world" || source === "koishi" || rich.experience?.worldTransition !== undefined));
    this.interruptPause(source, { ...rich, originEventIds: opts.originEventIds ?? rich.originEventIds }, opts.ref, wake, puppetResult);

    this.mailbox.push({
      source,
      wake: wake || puppetResult,
      toolResultOk: opts.toolResultOk,
      toolResultKey: opts.toolResultKey,
      toolObservation: opts.toolObservation,
      contextHint: rich.contextHint,
      experience: rich.experience,
      growthReferences: rich.growthReferences,
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

    // Result waiting is a scheduler state, independent of the character's wait/rest timer.
    if (this.awaitingToolRetry && source !== "system" && !rich.experience?.internalThought) this.wakeFn?.();
    this.signalMailbox();
  }

  /** Pause interruption is separate from inference/compaction cancellation. */
  private interruptPause(source: EventSource, rich: RichText, ref: string | undefined, wake: boolean, puppetResult = false): void {
    if (!this.waiting) return;
    const isWaitResult = ref === this.waiting.callId;
    if (!isWaitResult && !wake && !puppetResult) return;
    if (!isWaitResult) {
      // Interrupt the timer, without turning a scheduling transition into bodily sleep.
      const { callId, startedTU } = this.waiting!;
      const timer = this.scheduler.pending().find(task => task.id === callId);
      const cancellation = this.scheduler.cancel(callId);
      if (cancellation === "cancelled") this.operationCalls.delete(callId);
      const elapsed = Math.max(0, this.clock.now() - (startedTU ?? timer?.issuedAt ?? this.clock.now()));
      const roots = rich.originEventIds;
      const chat = rich.experience?.chat;
      const anonymousNotice = !chat && !!roots?.some(root => root.startsWith("chat-notice:"));
      const cause = chat?.kind === "notice"
        ? `收到频道 ${chat.channelKey} 的新通知；发送者和消息正文尚未读取`
        : chat?.kind === "message"
        ? `频道 ${chat.channelKey} 的新消息已交付，具体内容以对应事件为准`
        : anonymousNotice
        ? "收到新的手机通知信号；通知来源的频道、发送者和内容尚未确认"
        : puppetResult ? "外部操纵的结果到达"
        : source === "tool" ? "已有操作的结果到达"
        : source === "world" ? "新的世界感知到达"
        : source === "koishi" ? "新的聊天事件到达"
        : "新的事件到达";
      const interruption = `计时中断：${cause}；经过 ${elapsed.toFixed(1)} TU。`;
      if (cancellation === "cancelled") {
        this.externalToolResults.get(callId)?.resolve({ ok: false, callId, text: interruption });
        this.externalToolResults.delete(callId);
        this.puppetCalls.delete(callId);
        this.stealthCalls.delete(callId);
      }
      if (cancellation === "cancelled") this.finishPause(callId);
      if (cancellation === "cancelled") this.mailbox.push({
        source: "system",
        content: interruption,
        originEventIds: [],
        refToolCallId: callId,
        worldTime: this.clock.now(),
      });
    }

    if (isWaitResult) this.finishPause(this.waiting.callId);
    this.waiting = null;
    this.wakeFn?.();
  }

  private isWakeableToolResult(name: string | undefined, rich: Pick<RichText, "experience">): boolean {
    return !rich.experience?.internalThought && !rich.experience?.historicalWorld &&
      !["wait", "rest", "think", "reflect", "recall_growth", "recall", "help"].includes(name ?? "");
  }

  /** A passive signal still becomes a durable perception. Only explicit wake rules
   * cancel wait/rest; seeing mailbox activity never completes a pending operation. */
  private signalMailbox(): void {
    if (!this.running) return;
    this.toolResultWakeFn?.();
    if (this.waiting) this.wakeFn?.();
  }

  /** Text and ordered multimodal parts carry the same agency attribution, including after restart. */
  private puppetReceipt(content: string | RichText, ref?: string): RichText {
    const rich: RichText = typeof content === "string" ? { text: content } : content;
    if (!ref || !this.puppetCalls.has(ref)) return rich;
    const prefix = "（以下是外部操纵你身体/设备产生的回执，并非你自主选择的行动；保留实际结果，不据此推定你的意愿或感受。）\n";
    const first = rich.parts?.[0];
    return {
      ...rich,
      contextHint: undefined, // An abbreviated result must never hide external-control provenance.
      experience: { ...rich.experience, agency: "imposed", opportunity: false },
      text: rich.text.startsWith(prefix) ? rich.text : prefix + rich.text,
      ...(rich.parts ? { parts: first?.kind === "text" && first.text.startsWith(prefix) ? rich.parts : [{ kind: "text", text: prefix }, ...rich.parts] } : {}),
    };
  }

  /** Completion and ownership come from the dispatch path, never from the model's claim of success. */
  private describeExperience(content: string | RichText, call?: ToolCallRecord, ok?: boolean): RichText {
    let rich: RichText = typeof content === "string" ? { text: content } : content;
    if (!call) return rich;
    const imposed = call.control?.mode === "puppet" || this.puppetCalls.has(call.id);
    const own = call.role === "agent" || call.control?.mode === "avatar";
    // Only these dispatchers have an explicit delivery/completion contract. Other application
    // strings, observations and administrative acknowledgements cannot prove a completed choice.
    if (!["act", "send"].includes(call.name)) {
      if (!imposed && !rich.experience) return rich;
      return { ...rich, experience: { ...rich.experience,
        agency: imposed ? "imposed" : rich.experience?.agency === "self" ? "unknown" : rich.experience?.agency,
        opportunity: false,
        ...(rich.experience?.outcome === "completed" ? { outcome: "unknown" } : {}),
      } };
    }
    let completed = ok === true;
    let outcome: ExperienceMetadata["outcome"] = rich.experience?.outcome === "unknown" ? "unknown" : ok === false ? "failed" : "unknown";
    let scene = "";
    if (call.name === "act") {
      try {
        const value = JSON.parse(rich.text);
        completed = ok === true && value?.action?.status === "completed";
        outcome = value?.action?.status === "failed" ? "failed" : completed ? "completed" : "unknown";
        scene = value?.observation?.narrative ?? value?.narrative ?? value?.scene?.text ?? "";
        if (imposed && value?.action && typeof value.action === "object") {
          // The perception is public to this character; a controller's submitted intention is not.
          delete value.action.intent;
          rich = { ...rich, text: JSON.stringify(value) };
        }
      } catch {
        completed = false;
        if (imposed) rich = { ...rich, text: ok === false
          ? "（这次非自主身体动作未能完成，没有可确认的动作经过。）"
          : "（身体发生了非自主变化，但这次没有取得可确认的动作经过。）" };
      }
    } else if (completed) outcome = "completed";
    if (rich.originEventIds?.length === 0) return rich;
    const unit = Number.isFinite(this.clock.unitWorldSeconds) ? this.clock.unitWorldSeconds : 1;
    const experience: ExperienceMetadata = {
      ...rich.experience,
      episodeId: rich.experience?.episodeId ?? `choice-period:${Math.floor(call.issuedAt * unit / 1800)}`,
      agency: imposed ? "imposed" : own ? "self" : "unknown",
      // Send metadata is supplied after canonical channel resolution using the actual submitted body.
      action: imposed ? "身体或设备发生了非自主变化"
        : sliceText(rich.experience?.action ?? describeToolCall(call), 0, 1200),
      outcome,
      situation: rich.experience?.situation ?? (call.name === "send" ? `聊天频道 ${this.phoneUi.channelKey ?? "当前会话"}`
        : `世界中的情境：${sliceText(typeof scene === "string" ? scene : "", 0, 200) || "周围环境"}`),
      opportunity: own && !imposed && completed,
    };
    return { ...rich, experience };
  }

  /**
   * externalSelfMessages = simulate：认领账号已发出的消息；可由 send 表达时记录
   * 合法工具参数，其他消息类型保留为行动感知，真实图文感知始终附在结果中。
   * 注入同样遵守阻塞规则：在下一次生成前统一追加。
   * msgId：平台消息 id，与真实 send 工具的结果格式一致（开启引用类操作时展示）。
   */
  simulateExternalSend(channelKey: string, content: string | RichText, msgId?: string, sendArgs?: { msg: string } | null, identityText = ""): void {
    const rich = typeof content === "string" ? { text: content } : content;
    // Callers with unsupported message kinds retain the actual perceived action,
    // without inventing a send tool invocation that could never send that content.
    const args = sendArgs === undefined ? (typeof content === "string" ? { msg: content } : null) : sendArgs;
    const msgTag = msgId && needsMsgIds(this.config.platformOps) ? `（msg:${msgId}）` : "";
    const prefix = `${identityText ? `${identityText}\n` : ""}${args ? "消息已发送到" : "你刚才在"} ${channelKey}${msgTag}${args ? "。" : "发出了一条消息。"}已发送的消息正文：\n`;
    const suffix = "\n〔已发送消息结束〕";
    this.mailbox.push({
      source: args ? "tool" : "koishi",
      wake: true,
      originEventIds: rich.originEventIds,
      experience: { ...rich.experience, agency: "self", action: args ? sliceText(`send ${args.msg}`, 0, 1200) : "发出消息", outcome: "completed", opportunity: true },
      content: prefix + rich.text + suffix,
      attachments: rich.attachments,
      parts: rich.parts ? [{ kind: "text", text: prefix }, ...rich.parts, { kind: "text", text: suffix }] : undefined,
      worldTime: this.clock.now(),
      ...(args ? { asToolCall: { name: "send", arguments: { id: channelKey, ...args } } } : {}),
    });
    this.logger.info("[external-send:simulate] %s %s", channelKey, truncate(rich.text, 100));
    this.signalMailbox();
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
    if (paused) this.phoneExecutionEpoch++;
    if (paused) this.worldActionInterleave.pause();
    this.wakeFn?.();
    if (paused) this.generationAbort?.abort();
    this.logger.info("Bot-LLM 手动驾驶%s", paused ? "接管（暂停自主生成）" : "交还（恢复自主生成）");
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
    const cancelled = this.scheduler.cancelUncommitted();
    for (const id of cancelled) this.finishPause(id);
    if (this.waiting && cancelled.includes(this.waiting.callId)) { this.waiting = null; this.wakeFn?.(); }
    for (const id of cancelled) {
      const operation = this.operationCalls.get(id);
      if (operation?.role === "agent" && !operation.control && !this.stealthCalls.has(id)) {
        this.pushEvent("system", operation.name === "send"
          ? "（接管时此消息尚未提交，已取消，没有发出。）"
          : "（接管已取消尚未提交的后续操作；已发生的结果不撤销。）", { ref: id, originEventIds: [] });
      }
      this.operationCalls.delete(id);
      this.externalToolResults.get(id)?.resolve({ ok: false, text: "（管理员接管前已取消尚未提交的调用。）" });
      this.externalToolResults.delete(id);
      this.stealthCalls.delete(id);
    }
    return { busy: this.manualBusy };
  }

  get manualBusy(): boolean { return this.autonomousDispatch !== null || this.scheduler.pendingCount > 0; }
  get deviceBusy(): boolean { return this.deviceOperations > 0; }
  get deviceAttention(): DeviceKind | null { return this.attention === "phone" && (!canPerceivePhone(this.phone) || this.phone.down && !this.observingPlacedPhone) ? null : this.attention; }

  get residentMode(): "avatar" | "puppet" | null { return this.residentControl?.mode ?? null; }

  /** 身体受控不等于意识被替代；未知扩展工具按可能有副作用处理。 */
  private autonomousDuringPuppet(name: string): boolean {
    return ["think", "observe_device", "reflect", "recall_growth", "wait", "rest"].includes(name);
  }

  private puppetToolAllowed(name: string): boolean {
    return !["think", "reflect", "recall_growth", "wait", "rest"].includes(name);
  }

  async acquireResidentControl(mode: "avatar" | "puppet", sessionId: string): Promise<{ busy: boolean }> {
    if (this.residentControl) {
      if (this.residentControl.sessionId !== sessionId || this.residentControl.mode !== mode || this.residentClosing) throw new Error("常驻角色正在由其他会话控制或正在交还");
      return { busy: this.residentBusy };
    }
    const control = { mode, sessionId };
    this.residentControl = control;
    this.residentClosing = false;
    const result = await this.acquireManualControl();
    if (this.residentControl !== control || this.residentClosing) throw new Error("角色控制在建立期间已结束");
    if (mode === "puppet") this.setManualPaused(false);
    this.refreshToolGate();
    if (mode === "puppet") this.pushEvent("system", "（你的身体与设备动作现由外部操纵；你的意识持续存在，能观察实际发生的动作，也能独立思考、回忆和等待。非自主动作不等于你的愿望；如何理解和感受由你自己决定。）", { wake: true });
    await this.auditControl({ phase: "enter", ...control });
    return result;
  }

  async releaseResidentControl(sessionId: string, lost = false): Promise<{ busy: boolean }> {
    const control = this.residentControl;
    if (!control || control.sessionId !== sessionId) return { busy: false };
    if (!lost && this.residentBusy) return { busy: true };
    // 同步关闭准入，含正在审计/写入上下文但尚未进入 scheduler 的调用。
    this.residentClosing = true;
    if (lost) {
      for (const task of this.scheduler.pending()) if (task.control?.sessionId === sessionId) this.cancelExternalTool(task.id, sessionId);
      if (this.residentAdmissions) await new Promise<void>(resolve => this.residentAdmissionWaiters.add(resolve));
      if (control.mode === "avatar") await this.scheduler.whenIdle();
    }
    if (this.residentControl !== control) return { busy: false };
    this.residentControl = null;
    this.residentClosing = false;
    this.setManualPaused(false);
    this.refreshToolGate();
    if (control.mode === "puppet") this.pushEvent("system", "（外部对身体与设备的操纵结束，你恢复自主行动能力。操纵期间感知到的实际经历仍然保留；你的意识在这期间一直存在。）", { wake: true });
    // avatar 的代理调用已作为该角色的选择写入意识流；不伪造“醒来”或被附身的经历。
    await this.auditControl({ phase: "leave", ...control, lost });
    return { busy: false };
  }

  get residentBusy(): boolean {
    return this.residentAdmissions > 0 || this.autonomousDispatch !== null || this.scheduler.pending().some(task => !this.residentControl || task.control?.sessionId === this.residentControl.sessionId || !this.autonomousDuringPuppet(task.name));
  }

  pendingManualCalls() { return this.scheduler.pending().filter(task => task.control?.sessionId === this.residentControl?.sessionId && task.control); }

  cancelExternalTool(id: string, sessionId: string): ManualToolResult & { status: string } {
    const task = this.scheduler.pending().find(task => task.id === id);
    if (!task || task.control?.sessionId !== sessionId) return { ok: false, status: "not_found", text: "此会话没有该待处理调用。" };
    const status = this.scheduler.cancel(id);
    const text = status === "cancelled" ? "已取消后续尚未提交的部分；此前已发生的结果保留。" : "调用已开始提交，无法撤销；请等待真实回执。";
    if (status === "cancelled") {
      this.finishPause(id);
      this.operationCalls.delete(id);
      this.externalToolResults.get(id)?.resolve({ ok: false, text, callId: id });
      this.externalToolResults.delete(id);
      this.pushEvent("system", text, { ref: id });
      this.puppetCalls.delete(id);
      if (this.waiting?.callId === id) { this.waiting = null; this.wakeFn?.(); }
      this.refreshToolGate();
    }
    return { ok: status === "cancelled", status, text, callId: id };
  }

  private auditControl(record: Record<string, unknown>): Promise<void> {
    const write = this.controlAuditTail.then(() => appendFile(path.join(this.files.base, "control-audit.jsonl"), JSON.stringify({ at: Date.now(), worldTime: this.clock.now(), ...record }) + "\n", "utf8"));
    this.controlAuditTail = write.catch(error => this.logger.error("角色控制审计写入失败：%s", error));
    return write;
  }

  /** 当前分层真正允许的工具与原始应用 schema；读取无副作用。 */
  manualTools(mode?: "avatar" | "puppet"): AppToolDef[] {
    const allowed = new Set(this.currentToolNames(undefined, false, false));
    const operatorDefs = this.toolDefs.some(def => def.name === "channel_notify") ? [] : BOT_TOOLS.filter(def => def.name === "channel_notify");
    return [...this.toolDefs, ...operatorDefs, ...(this.apps?.activeToolDefs() ?? []), ...(this.computer?.activeToolDefs() ?? [])]
      .filter(def => allowed.has(def.name) && (mode !== "puppet" || this.puppetToolAllowed(def.name)))
      .map(def => {
        const params = signatureParams(def.signature);
        return { ...def, inputSchema: structuredClone((def as AppToolDef).inputSchema ?? {
          type: "object", properties: Object.fromEntries(params.map(param => [param.name, param.schema])),
          required: params.filter(param => param.required).map(param => param.name), additionalProperties: true,
        }) };
      });
  }

  /**
   * 管理员代理 Bot 执行任意工具调用（send/act/observe/wait/open_app/gallery 等）：
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
    opts: { duration?: number; stealth?: boolean; control?: { mode: "avatar" | "puppet"; sessionId: string }; choice?: { selection: ChoiceSelection; validate: (ignoredCallId?: string) => void } } = {},
  ): Promise<ManualToolResult> {
    if (!opts.control) return this.executeExternalToolCall(name, args, opts);
    if (this.residentClosing || this.residentControl?.sessionId !== opts.control.sessionId || this.residentControl.mode !== opts.control.mode) return { ok: false, text: "角色接管会话已结束或正在交还。" };
    if (this.residentAdmissions) return { ok: false, text: "上一条代理调用仍在处理，请等待回执。" };
    this.residentAdmissions++;
    try { return await this.executeExternalToolCall(name, args, opts); }
    finally {
      this.residentAdmissions--;
      if (!this.residentAdmissions) { for (const resolve of this.residentAdmissionWaiters) resolve(); this.residentAdmissionWaiters.clear(); }
    }
  }

  private async executeExternalToolCall(
    name: string,
    args: Record<string, unknown> = {},
    opts: { duration?: number; stealth?: boolean; control?: { mode: "avatar" | "puppet"; sessionId: string }; choice?: { selection: ChoiceSelection; validate: (ignoredCallId?: string) => void } } = {},
  ): Promise<ManualToolResult> {
    if (!this.running) {
      return { ok: false, text: "（Bot-LLM 当前未在运行，无法代理其工具调用。）" };
    }
    try { opts.choice?.validate(); } catch (error) { return choiceRejection(error); }
    if (opts.control && (this.residentClosing || this.residentControl?.sessionId !== opts.control.sessionId || this.residentControl.mode !== opts.control.mode)) return { ok: false, text: "角色接管会话已改变，此调用没有执行。" };
    if (opts.control?.mode === "puppet" && !this.puppetToolAllowed(name)) return { ok: false, text: "身体操纵不能代替角色思考、反思或休息；请使用观察与身体/设备能力。" };
    if (!args || typeof args !== "object" || Array.isArray(args) || (opts.duration !== undefined && (!Number.isFinite(opts.duration) || opts.duration < 0))) return { ok: false, text: "工具参数必须为对象，duration 必须为有限非负数。" };
    if (!this.currentToolNames(undefined, false, false).includes(name)) return { ok: false, text: `（${name} 此刻不可用，本次操作没有执行。请从当前能力列表重新选择。）` };
    if (name === "think" && thoughtError(args.thought)) return { ok: false, text: thoughtError(args.thought)! };
    if (opts.stealth && (!this.classifyDevice(name) || name === "pick_up_phone" || name === "put_down_phone")) return { ok: false, text: "偷偷操作只能改变设备界面，不能代替角色拿起或放下手机。" };
    const issuedAt = this.clock.now();
    let duration = name === "think" ? 0 : opts.duration;
    // 与 finalize 一致：wait 以参数 n 为准（模型常输出 duration:0 + n:x 的组合）
    if (name === "wait" && !(duration && duration > 0)) {
      const n = Number(args.n ?? 0);
      if (Number.isFinite(n) && n > 0) duration = n;
    }
    if (duration && duration > 0) duration = Math.max(0, duration);
    const call: ToolCallRecord = {
      id: this.context.nextToolId(),
      role: "system", // 管理员代理；avatar 的角色意图与模型自主生成可审计区分
      ...(opts.control ? { control: { ...opts.control } } : {}),
      ...(opts.choice ? { selection: { ...opts.choice.selection } } : {}),
      name,
      ...(name === "act" ? { worldEpoch: this.perceivedWorldEpoch } : {}),
      arguments: args,
      ...(duration && duration > 0 ? { duration } : {}),
      issuedAt,
      expectedAt: issuedAt + (duration && duration > 0 ? duration : 0),
    };
    if (opts.control) {
      await this.auditControl({ phase: "call", call });
      if (!this.running || this.residentClosing || this.residentControl?.sessionId !== opts.control.sessionId) return { ok: false, callId: call.id, text: "角色接管会话在开始执行前已结束，此调用没有执行。" };
    }
    if (opts.stealth) this.stealthCalls.add(call.id);
    else if (opts.control?.mode === "puppet") this.puppetCalls.add(call.id);
    else await this.context.appendToolCall(call);
    debug.emit("bot.tool", `${call.id} ${call.name}`, {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      duration: call.duration,
      issuedAt: call.issuedAt,
      expectedAt: call.expectedAt,
      source: opts.control ? "resident-" + opts.control.mode : opts.stealth ? "device-stealth" : "manual",
      ...(opts.control ? { control: opts.control } : {}),
    });
    this.logger.info(
      "[tool:manual] %s %s(%s)",
      call.id,
      call.name,
      truncate(JSON.stringify(call.arguments), 100),
    );

    const resultPromise = new Promise<ManualToolResult>((resolve) => {
      this.externalToolResults.set(call.id, { resolve: result => {
        resolve({ ...result, callId: call.id });
      }, systemText: null });
    });

    if (!this.running || (opts.control && (this.residentClosing || this.residentControl?.sessionId !== opts.control.sessionId))) {
      this.externalToolResults.delete(call.id);
      this.stealthCalls.delete(call.id);
      this.puppetCalls.delete(call.id);
      this.pushEvent("system", "（运行或控制会话已结束，此调用没有开始。）", { ref: call.id });
      return { ok: false, callId: call.id, text: "（运行或控制会话已结束，此调用没有开始。）" };
    }
    try { opts.choice?.validate(call.id); } catch (error) {
      this.externalToolResults.delete(call.id); this.stealthCalls.delete(call.id); this.puppetCalls.delete(call.id);
      const text = (error as Error).message;
      this.pushEvent("system", text, { ref: call.id });
      return { ...choiceRejection(error), callId: call.id };
    }
    await this.deviceExecution.run({ stealth: !!opts.stealth, external: !opts.control }, () => this.dispatch(call));

    // 校验拒绝（未进入调度）：dispatch 已同步经 pushEvent(system) 推送了拒绝原因（ref=call.id），
    // 且 scheduler 无对应 pending 任务 → 兜底以该拒绝原因回传；否则等待 scheduler deliver 的结果。
    const entry = this.externalToolResults.get(call.id);
    if (entry && !this.scheduler.isPending(call.id)) {
      this.externalToolResults.delete(call.id);
      this.stealthCalls.delete(call.id);
      entry.resolve({ ok: false, text: entry.systemText ?? `（${name} 未被接受。）` });
    }
    const result = await resultPromise;
    if (opts.choice && result.ok) {
      const selection = opts.choice.selection;
      this.consumedHumanChoices.add(name === "act" ? `world:${selection.sourceEventId}` : `device:${selection.opportunityId}`);
      if (this.consumedHumanChoices.size > 512) this.consumedHumanChoices.delete(this.consumedHumanChoices.values().next().value!);
    }
    this.puppetCalls.delete(call.id);
    if (opts.control) await this.auditControl({ phase: "receipt", callId: call.id, control: opts.control, ok: result.ok, text: result.text }).catch(() => {});
    return result;
  }

  // ---------- 主循环 ----------

  private get strictToolLoop(): boolean { return this.config.bot.strictToolLoop !== false; }

  /** Scope changes with the pending action, not with every message/decision credit.
   * Capability announcements therefore stay stable throughout independent work. */
  private independentWorldScope(): boolean {
    const ids = this.strictToolLoop && this.config.bot.interruptibleWorldActions !== false
      ? (this.scheduler?.pending() ?? []).filter(task => {
        const call = this.operationCalls.get(task.id);
        return task.name === "act" && call?.role === "agent" && !call.control && !this.stealthCalls.has(task.id);
      }).map(task => task.id) : [];
    this.worldActionInterleave.sync(ids);
    return ids.length > 0;
  }

  private independentWorldTool(name: string): boolean {
    return !!this.classifyDevice(name) || ["observe_device", "help", "think", "reflect", "recall_growth", "recall", "wait", "rest", "cancel"].includes(name);
  }

  private perceiveIndependentWork(event: BotEvent, wake: boolean, call?: ToolCallRecord, succeeded = false, key?: string): void {
    if (!this.running) return;
    const eligible = !this.manualPaused && this.independentWorldScope();
    // Remember quiet/previously received roots too. Replaying an old message after
    // a new action or handback must not be mistaken for a new outside event.
    this.worldActionInterleave.external(event, eligible && wake);
    if (!eligible) return;
    if (call && (this.classifyDevice(call.name) || call.name === "observe_device")) this.worldActionInterleave.receipt(event, call, succeeded, key);
  }

  private pauseIndependentWork(call: ToolCallRecord): void {
    if (["wait", "rest"].includes(call.name) && this.waiting?.callId === call.id) this.worldActionInterleave.pause();
  }

  private blockingAutonomousResults(): string[] {
    const independent = this.independentWorldScope() && !this.waiting && this.worldActionInterleave.canDecide;
    return this.autonomousPendingResults().filter(id => !independent || this.operationCalls.get(id)?.name !== "act");
  }

  /** Human/stealth operations and background app jobs do not own the model's decision turn. */
  private autonomousPendingResults(): string[] {
    return this.scheduler.pending().flatMap(task => {
      const call = this.operationCalls.get(task.id);
      // wait/rest already own the timer gate. Excluding them lets memory maintenance
      // run during that pause, without issuing any new model decision before wake-up.
      return call?.role === "agent" && !call.control && !["wait", "rest"].includes(call.name) && !this.stealthCalls.has(task.id) ? [task.id] : [];
    });
  }

  private async waitForToolResults(): Promise<void> {
    const ids = this.blockingAutonomousResults();
    if (!ids.length || !this.running || this.manualPaused) return;
    // Separate from the finished model request, so handback cannot reuse an aborted signal.
    this.generationAbort = new AbortController();
    const signal = AbortSignal.any([this.abort!.signal, this.generationAbort.signal]);
    await this.settleToolsWithPerceptions(ids, signal, true);
  }

  /** One serialized mailbox consumer, including legacy device waits and navigation.
   * The model has finished its request; only new context entries may be appended. */
  private async settleToolsWithPerceptions(ids: string[], signal?: AbortSignal, allowIndependentWork = false): Promise<void> {
    this.awaitingToolResult = ids[0]!;
    let settled = false;
    let awaken: (() => void) | null = null;
    // Register completion once, not once per incoming notification. A stopped wait
    // cannot wake a later lifetime through this local callback.
    void Promise.all(ids.map(id => this.scheduler.whenSettled(id))).then(() => { settled = true; awaken?.(); });
    try {
      while (!settled && this.running && !this.manualPaused && !signal?.aborted) {
        if (allowIndependentWork && !this.blockingAutonomousResults().length) break;
        await abortable(new Promise<void>(resolve => {
          awaken = this.toolResultWakeFn = resolve;
          // Arrival can precede registration or occur while the last batch is saved.
          if (this.mailbox.length || this.receiptsPending) resolve();
        }), signal);
        awaken = this.toolResultWakeFn = null;
        if (!signal?.aborted && this.running) await this.drainMailbox(false);
      }
    }
    catch (error) { if (!signal?.aborted) throw error; }
    finally { awaken = this.toolResultWakeFn = null; this.awaitingToolResult = null; }
    // A new chat may admit independent device work; it never settles the World action.
    // Navigation and device receipt waits cannot take this exit.
  }

  private async runLoop(): Promise<void> {
    this.logger.info("Bot-LLM 开始持续推理");
    while (this.running) {
      try {
        this.refreshToolGate();
        // Deliver facts now; transient capability/menu changes can settle during throttle,
        // rest or manual control and need announcing only if another inference will see them.
        await this.drainMailbox(false);

        const identityUpdate = await this.context.refreshChatAccounts(this.clock.now());
        if (identityUpdate) this.publishPerception(identityUpdate);

        // 手动驾驶（管理员扮演接管）：暂停自主生成，仅负责排空邮箱 + 处理外部注入的工具/事件。
        // 短睡后回到循环顶部重排邮箱，保证注入的事件及时进入上下文。
        if (this.manualPaused) {
          await sleep(250, this.abort?.signal);
          continue;
        }

        // A pending receipt is a scheduling concern, not another model decision.
        // This also covers returning from manual control while a committed operation is unfinished.
        if (this.strictToolLoop && this.blockingAutonomousResults().length) {
          await this.waitForToolResults();
          continue;
        }

        // Maintenance is independent of the character's sleep, physical condition, and device state.
        if (this.context.stream.length && (this.context.approxChars() > this.config.bot.maxWindowChars || this.context.attachmentBudgetExceeded)) this.compressionRequested ??= "overflow";
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
        this.refreshToolGate();
        await this.drainMailbox();
        if (!this.running || this.manualPaused || this.waiting || this.compressionRequested) continue;
        if (this.strictToolLoop && this.blockingAutonomousResults().length) continue;

        let parsed: ParsedToolCall;
        const channelAtDecision = this.phoneUi.chatOpen && !this.concealedDevices.has("phone") ? this.phoneUi.channelKey : null;
        const independentWorldDecision = this.independentWorldScope();
        if (independentWorldDecision) this.worldActionInterleave.consume();
        const decisionCurrent = () => this.running && !this.manualPaused && !this.generationAbort?.signal.aborted;
        try {
          this.generationAbort = new AbortController();
          const signal = AbortSignal.any([this.abort!.signal, this.generationAbort.signal]);
          parsed = await this.backend.generate(this.context, this.wakeTimeLine, signal);
          if (parsed.name === "think") {
            const error = thoughtError(parsed.arguments.thought);
            if (error) throw new ToolCallParseError(error);
          }
          this.parseFailures = 0;
        } catch (err) {
          if (!this.running) break;
          if (this.manualPaused) continue;
          if (this.generationAbort?.signal.aborted) continue;
          if (err instanceof ToolCallParseError) {
            this.parseFailures++;
            this.logger.warn(
              "Bot-LLM 输出未解析（第 %d 次）: %s",
              this.parseFailures,
              truncate(err.raw ?? err.message, 1200),
            );
            // 「工具此刻不可用 / 未知工具」是可执行的明确原因（分层允许集造成）——必须原样透传给模型，
            // 让它知道该先 open_app 进聊天应用、select_channel 进频道，而不是吞成"恍惚"后原地重试同一个调用。
            if (/(此刻不可用|未知工具)/.test(err.message) || /^(think\.thought|(?:arguments\.)?duration\b)/.test(err.message) || err.message.endsWith("本次没有执行操作。")) {
              this.pushEvent("system", `（${err.message}）`);
              await this.backoffInvalidToolRetry();
              continue;
            }
            const emphasis =
              this.parseFailures >= 3
                ? (this.config.bot.nativeToolCalls
                  ? '调用恰好一个工具：有当前原生声明时用 function calling；动态新增工具或更新参数用单个正文 JSON {"name":"工具名","arguments":{},"duration":0}，不附加解释。'
                  : '只输出一个工具 JSON 对象，格式为 {"name":"工具名","arguments":{},"duration":0}；不要解释或代码围栏。')
                : "";
            // 关键：不要把原始错误输出（尤其是模型自己拼的 <event>…</event>）回灌进上下文——
            // 那会污染意识流，让模型把它当成真实发生的事件并继续模仿。
            this.pushEvent(
              "system",
              `（本次输出未能解析为唯一有效的工具调用，没有执行操作。${emphasis}请重新输出一个合法的工具调用。）`,
            );
            continue;
          }
          // 400/413 且上下文含原生附件：
          // - 400：模型/服务端不接受某种附件（content part 类型不支持或格式不被接受）。
          //   先精准降级：失败请求里注入过 video_url / input_audio 时，只关掉对应模态
          //   （GIF 自动改走拼帧图的 image_url 通道），正常的图片附件不受牵连；
          //   纯图片附件仍 400 才整体熔断（模型实际不具备视觉能力）。
          // - 413：请求体超过服务端上限（base64 附件把请求撑爆了）→ 整体熔断并提示调预算。
          // Append a capability event and compact before retrying; never rewrite the existing media prefix.
          if (
            !this.context.attachmentsDisabled &&
            /\((400|413)\)/.test(String(err)) &&
            this.context.lastAttachmentPartTypes.size > 0
          ) {
            if (/\(400\)/.test(String(err))) {
              const kinds: ("video" | "audio")[] = [];
              if (this.context.lastAttachmentPartTypes.has("video_url")) kinds.push("video");
              if (this.context.lastAttachmentPartTypes.has("input_audio")) kinds.push("audio");
              if (kinds.length && this.context.degradeModalities) {
                this.context.degradeModalities(kinds);
                this.context.requestAttachmentCompaction();
                this.pushEvent("system", `（本次含 ${kinds.join("、")} 原始媒体的生成请求被模型服务拒绝，没有执行动作。正在尝试停用这些原始输入并整理已有经历；整理完成后新媒体按剩余能力呈现，已记录的经历保持不变。）`);
                this.compressionRequested = "overflow";
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
            this.context.requestAttachmentCompaction();
            this.pushEvent("system", "（本次包含原始媒体的生成请求被模型服务拒绝，没有执行动作。正在尝试暂时停用原始媒体输入并整理已有经历，之后以媒体身份和文字摘要继续，不能把未展开的媒体当作已看见。）");
            this.compressionRequested = "overflow";
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

        if (!decisionCurrent()) continue;
        // The original World result may arrive during inference. A decision made
        // without that result still cannot use it to justify another physical act.
        const navigationError = this.channelDecisionError(parsed, channelAtDecision) ?? (independentWorldDecision && !this.independentWorldTool(parsed.name)
          ? "世界动作的实际结果尚未进入本次决定；此时只能处理独立设备操作、思考或等待，没有执行后续身体动作。"
          : await this.prepareNavigation(parsed, decisionCurrent));
        if (!decisionCurrent()) continue;
        const call = this.finalize(parsed);
        await this.context.appendToolCall(call);
        const channelError = this.channelDecisionError(parsed, channelAtDecision);
        if (navigationError || channelError) {
          this.pushEvent("system", navigationError ?? channelError!, { ref: call.id });
          this.pendingToolHelp.add(call.name);
          continue;
        }
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
        if (!decisionCurrent()) {
          this.pushEvent("system", "（这次调用已记录，但执行前控制权或可用能力发生变化，没有执行。）", { ref: call.id });
          continue;
        }
        const dispatch = this.dispatch(call);
        this.autonomousDispatch = dispatch;
        try { await dispatch; } finally { if (this.autonomousDispatch === dispatch) this.autonomousDispatch = null; }
        if (independentWorldDecision) this.pauseIndependentWork(call);
        // A screen interaction is one decision step. Its receipt must enter the next
        // request before deciding what to touch next; other actors still own their
        // individual queue slots, and world actions retain their concurrency setting.
        // A future send is still cancellable typing, not an already submitted
        // platform operation. Keep its decision window open for new input/cancel.
        const futureSend = call.name === "send" && call.expectedAt > this.clock.now();
        if (!this.strictToolLoop && decisionCurrent() && !futureSend && (call.name === "observe_device" || this.classifyDevice(call.name))) {
          const signal = AbortSignal.any([this.abort!.signal, this.generationAbort!.signal]);
          try { await this.settleToolsWithPerceptions([call.id], signal); }
          catch (error) { if (!decisionCurrent()) continue; throw error; }
        }
      } catch (err) {
        if (!this.running) break;
        this.logger.error("Bot-LLM 循环出错: %s", err);
        await sleep(this.config.bot.retryDelayMs, this.abort?.signal);
      }
    }
    this.logger.info("Bot-LLM 停止推理");
  }

  private async drainMailbox(announceCapabilities = true): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drainMailboxUnlocked(announceCapabilities).finally(() => { this.draining = null; });
    return this.draining;
  }

  private async drainMailboxUnlocked(announceCapabilities: boolean): Promise<void> {
    if (this.running) {
      for (const guidance of [TOOL_HELP_GUIDANCE, TOOL_RESULT_GUIDANCE, SLEEP_AND_DEVICE_GUIDANCE]) {
        const added = await this.context.ensureGuidance(guidance, this.clock.now());
        if (added) this.publishPerception(added);
      }
    }
    if (this.running && !this.expressionGuidanceDelivered) {
      const guidance = await this.context.ensureExpressionGuidance(this.clock.now());
      if (guidance) this.publishPerception(guidance);
      this.expressionGuidanceDelivered = true;
    }
    if (this.running) {
      const retirement = await this.context.retireLegacyRegulation(this.clock.now());
      if (retirement) this.publishPerception(retirement);
    }
    if (this.running && !this.thoughtGuidanceDelivered && this.toolDefs.some(def => def.name === "think")) {
      if (!this.context.stream.some(entry => entry.kind === "event" && entry.event.source === "system" && entry.event.content === THOUGHT_RUNTIME_GUIDANCE + "\n\n" + SCENE_CHOICE_GUIDANCE)) {
        const event: BotEvent = { id: this.context.nextEventId(), source: "system", worldTime: this.clock.now(),
          content: THOUGHT_RUNTIME_GUIDANCE + "\n\n" + SCENE_CHOICE_GUIDANCE, originEventIds: [] };
        await this.context.appendEvent(event);
        this.publishPerception(event);
      }
      this.thoughtGuidanceDelivered = true;
    }
    if (!this.growthRestored) {
      await this.growth.restorePerceptions(this.context.stream);
      this.growthRestored = true;
    }
    await this.receipts.ready();
    this.receiptsPending = false;
    if (this.running) await this.receipts.drain(async (event, receiptWake) => {
      const fresh = !this.context.stream.some(entry => entry.kind === "event" && entry.event.id === event.id);
      // If a process died after append but before removing the inbox file, replay the same ID once.
      await this.context.appendEvent(event);
      this.publishPerception(event);
      await this.growth.perceive(event, event.originEventIds ?? [event.id]);
      const origin = this.context.stream.find(entry => entry.kind === "tool_call" && entry.call.id === event.refToolCallId);
      if (fresh && event.source !== "system" && !event.experience?.historicalWorld && !event.experience?.internalThought) {
        const wake = receiptWake ?? (event.source !== "tool" || this.isWakeableToolResult(origin?.kind === "tool_call" ? origin.call.name : undefined, event));
        this.interruptPause(event.source, { ...event, text: event.content }, event.refToolCallId, wake);
      }
      if (this.deliberation.perceive(event, origin?.kind === "tool_call" ? origin.call : undefined)) this.parseFailures = 0;
      // Recovered receipts retain their truth but cannot renew a new lifetime's
      // independent-action allowance.
      debug.emit("bot.event", `[tool receipt] ${event.id}`, { ...event, recovered: true });
    });
    if (!this.mailbox.length) { await this.offerReflection(announceCapabilities); return; }
    const count = this.mailbox.length;
    for (let index = 0; index < count; index++) {
      const item = this.mailbox[0]!;
      // An event may have arrived while the model was still choosing this pause.
      // Recheck its original wake policy at delivery without changing old context.
      this.interruptPause(item.source, { ...item, text: item.content }, item.refToolCallId, item.wake === true);
      // 伪装的工具调用（externalSelfMessages = simulate）：以 Bot 的口吻追加进流
      if (item.asToolCall) {
        const call = item.toolCallRecord ??= {
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
        if (!item.content) { this.mailbox.shift(); continue; }
        item.refToolCallId = call.id;
      }
      const event = item.event ??= {
        id: this.context.nextEventId(),
        experience: item.experience,
        growthReferences: item.growthReferences,
        originEventIds: item.originEventIds,
        source: item.source,
        content: item.content,
        contextHint: item.contextHint,
        worldTime: item.worldTime,
        refToolCallId: item.refToolCallId,
        attachments: item.attachments,
        parts: item.parts,
        statusEcho: item.statusEcho,
      };
      await this.context.appendEvent(event);
      this.publishPerception(event);
      const originCall = event.refToolCallId
        ? this.context.stream.find((entry) => entry.kind === "tool_call" && entry.call.id === event.refToolCallId)
        : undefined;
      const derived = originCall?.kind === "tool_call" && ["think", "reflect", "recall_growth", "recall"].includes(originCall.call.name);
      await this.growth.perceive(event, derived ? [] : event.originEventIds ?? [event.id]).catch((err) => {
        // Retry from the durable context at the next boundary, before it can be compressed away.
        this.growthRestored = false;
        this.logger.warn("感知证据保存失败，保留当前事件与邮箱，写入恢复前暂停新的推理：%s", err);
        throw err;
      });
      if (this.deliberation.perceive(event, originCall?.kind === "tool_call" ? originCall.call : undefined)) this.parseFailures = 0;
      this.perceiveIndependentWork(event, item.wake === true && !item.toolObservation, originCall?.kind === "tool_call" ? originCall.call : undefined, item.toolResultOk === true, item.toolResultKey);
      this.noteProgress(event);
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
      this.mailbox.shift();
    }
    await this.offerReflection(announceCapabilities);
  }

  private async offerReflection(announceCapabilities: boolean): Promise<void> {
    if (this.running && announceCapabilities) await this.announceToolChanges();
    if (this.running && announceCapabilities && !this.manualPaused) await this.announceFailedToolHelp();
    // Maintenance never edits the active request: only this serialized delivery boundary may
    // append its results. Avatar control defers private automatic changes until handback.
    if (this.running && !this.manualPaused) {
      if (announceCapabilities) await this.announcePendingOperations();
      const opportunities = this.actionOpportunities();
      if (announceCapabilities) await this.announceOpportunities(opportunities);
      if (this.currentToolNames().includes("send")) {
        const material = conversationMaterialReminder(this.context.stream, this.clock.now());
        if (material) {
          // An optional, source-linked reminder. It neither wakes the character nor
          // enters growth as a new experience, and never creates a send operation.
          await this.context.appendEvent(material);
          this.publishPerception(material);
        }
      }
      for (const event of [...await this.growthRuntime.drain(), ...await this.growthRuntime.remember(undefined, opportunities)]) {
        this.publishPerception(event);
        debug.emit("bot.event", `[growth] ${event.id}`, event);
      }
      this.growthRuntime.tick(this.abort?.signal);
    }
    if (this.config.bot.growth?.enabled) return;
    if (!this.currentToolNames().includes("reflect")) return;
    if (!this.reflectionPending) {
      const opportunity = await this.growth.reflectionOpportunity();
      if (!opportunity) return;
      // The cue is itself durable. On restart, finish its checkpoint instead of producing it again.
      const prior = [...this.context.stream].reverse().find(entry => entry.kind === "event" &&
        /^ev_growth_review_\d+$/.test(entry.event.id) && Number(entry.event.id.slice("ev_growth_review_".length)) > opportunity.afterRootCount);
      if (prior?.kind === "event") {
        this.reflectionPending = { opportunity: { ...opportunity, rootCount: Number(prior.event.id.slice("ev_growth_review_".length)) }, event: prior.event, appended: false };
      } else {
        const event: BotEvent = {
          id: `ev_growth_review_${opportunity.rootCount}`, source: "system", worldTime: this.clock.now(),
          content: "（亲历整理提示：最近积累了一些不同来源的经历。若某件事让你形成、兑现或修正了关系、承诺或偏好，可用 reflect 记录你的判断及实际证据；" +
            "普通聊天、日记和上下文压缩不会自动写入成长账本。最近可引用的 event id：" + opportunity.eventIds.join("、") +
            "。可用 recall_growth(scope=\"evidence\", event_ids=[...]) 重读原始感知，或 scope=\"claims\" 查看已有认识再决定是否修订。" +
            "无需为填充账本而制造结论；没有值得记录的变化，就继续生活。这条系统提示本身不是亲历证据。）",
        };
        this.reflectionPending = { opportunity, event, appended: false };
      }
    }
    const pending = this.reflectionPending;
    if (!pending.appended) {
      await this.context.appendEvent(pending.event);
      this.publishPerception(pending.event);
      pending.appended = true;
      debug.emit("bot.event", `[growth review] ${pending.event.id}`, pending.event);
    }
    // Fail the boundary truthfully on storage errors. Neither generation nor compression proceeds
    // until the checkpoint is durable, but retrying never adds another copy or alters character sleep.
    await this.growth.markReflectionOffered(pending.opportunity);
    this.reflectionPending = null;
  }

  private async sleepUntilWoken(): Promise<void> {
    if (!this.waiting || !this.running || this.receiptsPending || this.mailbox.length) return;
    await new Promise<void>((resolve) => {
      this.wakeFn = resolve;
      if (!this.waiting || !this.running || this.receiptsPending || this.mailbox.length) resolve();
    });
    this.wakeFn = null;
  }

  private pendingWorldOperations(): boolean {
    return this.pendingWorldCalls().length > 0;
  }

  private pendingWorldCalls(): string[] {
    return this.scheduler?.pending().filter(task => (task.name === "act" || task.name === "observe") &&
      !this.stealthCalls.has(task.id)).map(task => task.id) ?? [];
  }

  private async throttle(): Promise<void> {
    const wait = this.lastGenAt + this.config.bot.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait, this.abort?.signal);
    this.lastGenAt = Date.now();
  }

  /** Invalid calls back off independently of act concurrency; fresh events can wake them. */
  private async backoffInvalidToolRetry(): Promise<void> {
    if (this.parseFailures < 2) return;
    // Persist the correction first, and let any real input already queued reset failures.
    await this.drainMailbox();
    if (!this.running || this.manualPaused || this.parseFailures < 2) return;
    const delay = Math.min(60_000, Math.max(1000, this.config.bot.retryDelayMs) * 2 ** Math.min(6, this.parseFailures - 2));
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.awaitingToolRetry = true;
    try {
      await new Promise<void>(resolve => {
        this.wakeFn = resolve;
        timer = setTimeout(resolve, delay);
        if (!this.running || this.manualPaused || this.receiptsPending ||
          this.mailbox.some(item => item.source !== "system" && !item.experience?.internalThought)) resolve();
      });
    } finally {
      clearTimeout(timer);
      this.wakeFn = null;
      this.awaitingToolRetry = false;
    }
  }

  /** The assistant call already contains the thought; never turn it into another perception. */
  private dispatchThought(call: ToolCallRecord): void {
    const error = thoughtError(call.arguments.thought);
    if (error) { this.pushEvent("system", `（${error}）`, { ref: call.id, originEventIds: [] }); return; }
    const thought = call.arguments.thought as string;
    if (call.role === "agent") {
      const repeated = this.deliberation.hasThought(thought);
      this.deliberation.recordThought(thought);
      if (repeated) {
        this.pushEvent("system", "（这个想法刚刚已经记下，没有新的内容；先等实际进展，或做一件有意义的事。）", { ref: call.id, originEventIds: [] });
        this.refreshToolGate();
        return;
      }
    }
    const content: RichText = { text: "（这段内心独白已记下。）", contextHint: { text: "" }, originEventIds: [],
      experience: { internalThought: true, agency: call.role === "agent" || call.control?.mode === "avatar" ? "self" : "unknown", opportunity: false } };
    const pending = this.externalToolResults.get(call.id);
    if (pending) {
      this.externalToolResults.delete(call.id);
      pending.resolve({ ok: true, callId: call.id, text: content.text, content });
    }
    this.pushEvent("system", content, { ref: call.id });
    this.refreshToolGate();
  }

  private finalize(parsed: ParsedToolCall): ToolCallRecord {
    const issuedAt = this.clock.now();
    let duration = parsed.name === "think" ? 0 : parsed.duration;
    // wait 的等待时长以参数 n 为准（模型常输出 duration: 0 + n: x 的组合）
    if (parsed.name === "wait" && !(duration && duration > 0)) {
      const n = Number(parsed.arguments.n ?? 0);
      if (Number.isFinite(n) && n > 0) duration = n;
    }
    return {
      id: this.context.nextToolId(),
      role: "agent",
      name: parsed.name,
      ...(parsed.name === "act" ? { worldEpoch: this.perceivedWorldEpoch } : {}),
      arguments: parsed.arguments,
      duration,
      issuedAt,
      expectedAt: issuedAt + (duration ?? 0),
    };
  }

  // ---------- 工具派发 ----------

  private async dispatch(call: ToolCallRecord): Promise<void> {
    await this.dispatchTool(call);
    // Synchronous validation refusals have no scheduled tool receipt. Timer expiry and
    // cancel's status are not usage mistakes and must not trigger a tutorial.
    if (call.role === "agent" && !call.control && !["wait", "rest", "cancel"].includes(call.name) &&
      this.mailbox.some(item => item.source === "system" && item.refToolCallId === call.id && !item.experience?.internalThought)) this.pendingToolHelp.add(call.name);
  }

  private async announceFailedToolHelp(): Promise<void> {
    for (const name of this.pendingToolHelp) {
      const def = [...this.toolDefs, ...this.learnedDeviceDefs(), ...this.perceivedAppDefs].find(def => def.name === name);
      if (!def) { this.pendingToolHelp.delete(name); continue; }
      const content = renderToolHelp(def);
      if (!this.failedToolHelp.has(content) && !this.context.stream.some(entry => entry.kind === "event" && entry.event.source === "system" && entry.event.content === content)) {
        const event: BotEvent = { id: this.context.nextEventId(), source: "system", originEventIds: [], worldTime: this.clock.now(), content };
        await this.context.appendEvent(event);
        this.publishPerception(event);
      }
      this.failedToolHelp.add(content);
      this.pendingToolHelp.delete(name);
    }
  }

  private async prepareNavigation(parsed: ParsedToolCall, current: () => boolean): Promise<string | undefined> {
    const builtin = this.toolDefs.some(def => def.name === parsed.name);
    const learned = this.learnedDeviceDefs().some(def => def.name === parsed.name);
    if (this.tempBannedTools.has(parsed.name) || !builtin && !learned) return `${parsed.name} 此刻不可用。`;
    if (this.residentControl?.mode === "puppet") return this.autonomousDuringPuppet(parsed.name) ? undefined : "身体与设备正受外部操纵。";
    if (toolLayer(parsed.name) !== "core" && misusedTargetKeys(parsed.arguments).length) return "目标参数应使用 id。";
    const app = learned ? this.apps?.toolOwner?.(parsed.name) : null;
    const computer = learned && this.computer?.knownToolDefs?.().some(def => def.name === parsed.name);
    const device = app ? "phone" : computer ? "computer" : this.classifyDevice(parsed.name);
    if (!device) return undefined;
    const plan = await planToolNavigation(parsed, {
      phone: this.phone, chatOpen: this.phoneUi.chatOpen, channelKey: this.phoneUi.channelKey,
      channelIsGroup: this.phoneUi.channelIsGroup, chatApp: this.config.apps?.chatAppName || "chat", builtin,
      device, app,
      activeAppId: app && !this.apps?.hasTool(parsed.name) ? null : this.apps?.view()?.id,
      computerOpen: computer ? this.computer?.hasTool(parsed.name) : this.computer?.isOpen, computerAvailable: this.computer?.available,
    }, id => this.messenger.resolveKey(id));
    if (plan.error) return plan.error;
    if (plan.steps.some(step => !this.toolDefs.some(def => def.name === step.name) || this.tempBannedTools.has(step.name))) return "所需的前置操作不可用。";
    for (const step of plan.steps) {
      if (!current()) return "操作已中止。";
      this.refreshToolGate();
      const call = this.finalize(step);
      call.navigationFor = parsed.name;
      await this.context.appendToolCall(call);
      debug.emit("bot.tool", `${call.id} ${call.name}`, call);
      if (!current()) { this.pushEvent("system", "操作已中止。", { ref: call.id }); return "操作已中止。"; }
      this.navigationOutcomes.set(call.id, false);
      let succeeded = false;
      try {
        await this.dispatch(call);
        const signal = this.generationAbort && this.abort ? AbortSignal.any([this.abort.signal, this.generationAbort.signal]) : this.abort?.signal;
        await this.settleToolsWithPerceptions([call.id], signal);
        succeeded = this.navigationOutcomes.get(call.id) === true;
      } catch (error) { if (!current()) return "操作已中止。"; throw error; }
      finally { this.navigationOutcomes.delete(call.id); }
      await this.drainMailbox(false);
      if (!succeeded) return `${call.name} 未完成，${parsed.name} 未执行。`;
      const receipts = this.context.stream.filter(entry => entry.kind === "event" && entry.event.refToolCallId === call.id);
      if (!receipts.length || receipts.some(entry => entry.kind === "event" && (entry.event.source === "system" || entry.event.experience?.outcome === "failed" || entry.event.experience?.outcome === "unknown"))) return `${call.name} 未完成，${parsed.name} 未执行。`;
      // A returned error string cannot claim that the requested screen actually opened.
      if (step.name === "pick_up_phone" && !canUsePhone(this.phone) ||
        step.name === "open_app" && (app ? this.apps?.view()?.id !== app.id : !this.phoneUi.chatOpen) ||
        step.name === "select_channel" && this.phoneUi.channelKey !== step.arguments.id ||
        step.name === "open_computer" && !this.computer?.isOpen) return `${step.name} 未完成，${parsed.name} 未执行。`;
    }
    this.refreshToolGate();
    return undefined;
  }

  private async dispatchTool(call: ToolCallRecord): Promise<void> {
    if (call.role === "agent" && !call.control && call.name !== this.pauseConfirmArmed) this.pauseConfirmArmed = null;
    if (call.control && (this.residentClosing || this.residentControl?.sessionId !== call.control.sessionId || this.residentControl.mode !== call.control.mode)) {
      this.pushEvent("system", "（角色接管会话已结束，此调用没有执行。）", { ref: call.id });
      return;
    }
    if (call.role === "agent" && this.residentControl?.mode === "puppet" && !this.autonomousDuringPuppet(call.name)) {
      this.pushEvent("system", "（身体与设备当前受外部操纵，这次自主动作没有执行。你仍能观察、思考、回忆或等待。）", { ref: call.id });
      return;
    }
    this.refreshToolGate();
    // A device changed off screen is discovered when the scheduled interaction turns
    // attention to it. Other stale capabilities are rejected before any side effect.
    const allowed = call.role === "agent" && this.classifyDevice(call.name)
      ? this.perceivedToolNames.filter(name => !this.tempBannedTools.has(name)) : this.currentToolNames(undefined, false, call.role === "agent");
    if (!allowed.includes(call.name)) {
      this.pushEvent("system", this.classifyDevice(call.name) === "phone" && phoneUnavailableReason(this.phone) || `${call.name} 此刻不可用。`, { ref: call.id });
      return;
    }
    if ((call.role === "agent" || call.control) && ["act", "rest", "nap", "travel", "go_home"].includes(call.name)) {
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
          (call.name === "send" ? "send 每次必须填写 id，本次未发送。）" : "已在目标频道页内时可省略 id。什么都没有发生，请改正后重试。）"),
        { ref: call.id },
      );
      return;
    }
    switch (call.name) {
      case "help": {
        const name = typeof call.arguments.tool === "string" ? call.arguments.tool.trim() : "";
        const defs = [...this.toolDefs, ...this.learnedDeviceDefs(), ...(call.role === "agent" ? this.perceivedAppDefs : [...(this.apps?.activeToolDefs() ?? []), ...(this.computer?.activeToolDefs() ?? [])])];
        const def = defs.find(def => def.name === name);
        const current = [...new Map((call.role === "agent" ? this.perceivedCapabilities ?? [] : defs.filter(def => this.currentToolNames(undefined, false, false).includes(def.name))).map(def => [def.name, def])).values()];
        return this.dispatchLocal(call, async () => ({ text: name ? def ? renderToolHelp(def) : `没有 ${name} 的使用说明。` : renderToolHelpIndex(current), originEventIds: [] }));
      }
      case "phone_notifications":
        return this.dispatchLocal(call, async () => this.notifyList ? this.notifyList.operate(call.arguments) : "通知管理不可用。");
      case "think":
        return this.dispatchThought(call);
      case "wait":
        return this.dispatchWait(call);
      case "act":
        return this.dispatchAct(call);
      case "rest":
        return this.dispatchRest(call);
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
          const now = this.clock.now(), unit = this.clock.unitWorldSeconds > 0 ? this.clock.unitWorldSeconds : 1;
          const result = await this.growth.reflect({
            kind: a.kind as GrowthKind, subject: a.subject as string, statement: a.statement as string,
            evidenceIds: Array.isArray(a.event_ids) ? a.event_ids as string[] : [],
            relation: a.relation as ReflectionRelation | undefined,
            claimId: typeof a.claim_id === "string" ? a.claim_id : undefined,
            situation: a.situation as string | undefined, cues: a.cues as string[] | undefined,
            behavior: a.behavior as string | undefined,
            insight: a.insight as import("./growth-semantics.js").GrowthInsight | undefined,
            subjectId: a.subject_id as string | undefined,
            expiresAt: a.expires_at as number | undefined,
          }, now, unit);
          return { text: JSON.stringify(result), originEventIds: [], growthReferences: [{ claimId: result.view.claimId, recordId: result.view.records.at(-1)!.id }] };
        });
      case "recall_growth":
        return this.dispatchLocal(call, async () => {
          const scope = call.arguments.scope ?? "claims";
          if (!["claims", "evidence", "all"].includes(String(scope))) throw new Error('recall_growth 的 scope 须为 claims、evidence 或 all');
          const n = clampInt(call.arguments.n, 1, 50, 10);
          const keyword = typeof call.arguments.keyword === "string" ? call.arguments.keyword : undefined;
          const claims = scope === "evidence" ? undefined : await this.growth.recall({
            kind: call.arguments.kind as GrowthKind | undefined,
            subject: typeof call.arguments.subject === "string" ? call.arguments.subject : undefined,
            keyword,
            claimId: typeof call.arguments.claim_id === "string" ? call.arguments.claim_id : undefined,
            n,
            at: this.clock.now(),
          });
          if (call.arguments.event_ids != null && (!Array.isArray(call.arguments.event_ids) ||
            call.arguments.event_ids.length > 50 || call.arguments.event_ids.some(id => typeof id !== "string" || !id.trim()))) {
            throw new Error("recall_growth 的 event_ids 须为不超过 50 个事件 id 的数组");
          }
          const evidence = scope === "claims" ? undefined : await this.growth.recallEvidence({
            eventIds: call.arguments.event_ids as string[] | undefined, keyword, n,
          });
          return { text: JSON.stringify({ ...(claims ? { claims } : {}), ...(evidence ? { evidence } : {}) }), originEventIds: [], growthReferences: claims?.map(view => ({ claimId: view.claimId, recordId: view.records.at(-1)!.id })) };
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
            return `当前已在 ${resolved.key}。`;
          }
          // 进入/切换到新频道：顺手回显这个频道的最近消息，让 Bot 看到这里在聊什么
          await this.enterChannel(resolved.key, resolved.isPrivate);
          return this.messenger.channelMessages(resolved.key, 10);
        });
      }
      case "read_channel": {
        // 读当前所在频道的消息（不切换频道）。需先 select_channel 进入某个频道
        if (!this.phoneUi.chatOpen || !this.phoneUi.channelKey) {
          this.pushEvent("system", "（你还没进入任何频道：先 open_app 打开聊天应用，再用 select_channel 进入一个频道。）", { ref: call.id });
          return;
        }
        const key = this.channelArg(call)!;
        return this.dispatchLocal(call, async () => {
          const target = await this.switchToTarget(key);
          if ("error" in target) throw new Error(target.error);
          return this.messenger.channelMessages(target.key, clampInt(call.arguments.n, 10, 200, 10), { intro: "read" });
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
              "和 description（自己的选用备注：表情包记表态用途与适用或易误读的语境；其他媒体记内容与用途，不代写原发送者意图）。）",
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
            '（view_media 需要 media 参数：明确媒体引用的列表，如 ["media:12", "gallery:表情包/xx.png"]；不能使用 msg:消息编号。）',
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
          const epoch = this.phoneExecutionEpoch;
          // Closing an app can perform slow IO. Let World commit during that work,
          // then recheck ownership before changing local posture under the short lock.
          const closedApp = await this.apps?.closeCurrent();
          try {
            await withPhoneExecutionLock(this.phone, () => {
              this.checkPhoneExecution(call, epoch);
              this.phoneUi = { chatOpen: false, channelKey: null, channelIsGroup: false, forwardStack: [] };
              setPhoneDown(this.phone, true);
              this.refreshToolGate();
              this.interruptAllDeferred("你已放下手机");
            });
          } catch (error) {
            if (closedApp) throw new Error(`「${closedApp}」已关闭；${(error as Error).message}`);
            throw error;
          }
          const receipt = `手机已放下${closedApp ? `，「${closedApp}」已关闭` : ""}。`;
          try { await this.messenger.putDownPhone(); }
          catch (error) { return receipt + `\n（频道关注更新失败：${(error as Error).message}；已完成的放下动作保留。）`; }
          return receipt;
        });
      case "pick_up_phone":
        return this.dispatchLocal(call, async () => {
          const epoch = this.phoneExecutionEpoch;
          return withPhoneExecutionLock(this.phone, () => {
            this.checkPhoneExecution(call, epoch);
            if (!canReachPhone(this.phone)) throw new Error(phoneUnavailableReason(this.phone));
            if (!this.phone.down) return "（手机本来就在你手里。）";
            setPhoneDown(this.phone, false);
            const screen = this.phoneUi.chatOpen
              ? this.phoneUi.channelKey ? `${this.config.apps?.chatAppName || "QQ"} 频道 ${this.phoneUi.channelKey}` : `${this.config.apps?.chatAppName || "QQ"} 的消息列表，尚未选择频道`
              : this.apps?.currentName ? `「${this.apps.currentName}」` : "手机桌面";
            return `已拿起手机。当前显示：${phonePhysicalState(this.phone).usable ? screen : "设备无法正常使用"}。` + this.phoneDesktopBadge();
          });
        });
      case "channel_notify": {
        const allowRaw = call.arguments.allow;
        if (allowRaw === undefined && call.arguments.mute_seconds === undefined) {
          this.pushEvent("system", "请填写 allow 或 mute_seconds。", { ref: call.id });
          return;
        }
        if (allowRaw !== undefined && typeof allowRaw !== "boolean") {
          this.pushEvent("system", "allow 须为 true 或 false。", { ref: call.id });
          return;
        }
        const id = this.channelArg(call);
        if (!id) {
          this.pushEvent("system", "（channel_notify 需要 id 参数，或先进入一个频道。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => {
          const resolved = await this.messenger.resolveKey(id);
          if ("error" in resolved) return resolved.error;
          if (!this.notifyList) return "（当前无法修改频道通知设置。）";
          await this.notifyList.set(resolved.key, allowRaw as boolean | undefined, call.arguments.mute_seconds as number | undefined, call.role === "system");
          return `${resolved.key} 的通知设置已更新。${this.notifyList.channelStatusText(resolved.key)}`;
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
            return `「${closed}」已关闭。` + this.phoneDesktopBadge();
          }
          if (this.phoneUi.chatOpen) {
            this.phoneUi = { chatOpen: false, channelKey: null, channelIsGroup: false, forwardStack: [] };
            this.refreshToolGate();
            return "聊天应用已关闭。" + this.phoneDesktopBadge();
          }
          return "（当前没有打开的应用。）" + this.phoneDesktopBadge();
        });
      case "open_computer":
        return this.dispatchLocal(call, async () => {
          const res = await this.computer?.open({ learn: !this.stealthCalls.has(call.id) });
          if (!res) return "（这台电脑不可用。）";
          if ("error" in res) return `（电脑会话未能打开：${res.error}）`;
          this.refreshToolGate();
          return res.opening;
        });
      case "close_computer":
        return this.dispatchLocal(call, async () => {
          if (!this.computer?.isOpen) return "（电脑本来就关着。）";
          await this.computer.close();
          this.refreshToolGate();
          return "电脑会话已关闭。";
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
          const tail = `\n（看完用 exit_forward 返回${depth > 1 ? "上一层" : "聊天窗口"}）`;
          return {
            ...rich,
            text: `${header}\n${rich.text}${tail}`,
            parts: rich.parts ? [{ kind: "text", text: header + "\n" }, ...rich.parts, { kind: "text", text: tail }] : undefined,
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
        return this.dispatchLocal(call, async () => this.messenger.listFriends(call.arguments));
      case "user_info": {
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? call.arguments.id ?? "");
        if (!userId) {
          this.pushEvent("system", "（user_info 需要 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.userInfo(userId));
      }
      case "view_avatar": {
        const id = typeof call.arguments.id === "string" ? call.arguments.id.trim() : "";
        const userId = typeof call.arguments.user_id === "string" ? call.arguments.user_id.trim() : "";
        if (!id || !userId) {
          this.pushEvent("system", "view_avatar 需要完整频道 id 和 user_id。", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.viewAvatar(id, userId));
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
        return this.dispatchLocal(call, async () => this.messenger.listGroups(call.arguments));
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
      default:
        // 当前打开的 App 展开的工具
        if (this.apps?.hasTool(call.name)) {
          const appName = this.apps.currentName;
          return this.dispatchLocal(call, async () => {
            try {
              return await this.apps!.call(call.name, call.arguments, { operator: call.role === "system" });
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

  /** Announce only work which the next decision really needs to know is still pending. */
  private async announcePendingOperations(): Promise<void> {
    const pending = this.scheduler.pending();
    for (const id of this.pendingOperationNotices.keys()) {
      if (!pending.some(task => task.id === id)) this.pendingOperationNotices.delete(id);
    }
    for (const task of pending) {
      const call = this.operationCalls.get(task.id);
      if (!call || call.role !== "agent" || call.control || this.stealthCalls.has(task.id)) continue;
      let event = this.pendingOperationNotices.get(task.id);
      // A delivered stage or previous notice already explains that call's progress.
      if (this.context.stream.some(entry => entry.kind === "event" && entry.event.refToolCallId === task.id &&
        (entry.event.source === "tool" || entry.event.toolProgress === "pending" && !event))) continue;
      if (!event) {
        const futureSend = call.name === "send" && !task.committed && call.expectedAt > this.clock.now();
        event = { id: this.context.nextEventId(), source: "system", refToolCallId: task.id,
          toolProgress: "pending", originEventIds: [], worldTime: this.clock.now(),
          content: futureSend ? `${task.id} 正在准备发送，尚未提交；预计 T=${call.expectedAt.toFixed(1)} 发送，可用 cancel 取消。`
            : `${task.id} ${describeToolCall(call)} 正在处理，结果尚未返回。` };
        this.pendingOperationNotices.set(task.id, event);
      }
      await this.context.appendEvent(event);
      this.pendingOperationNotices.delete(task.id);
      this.publishPerception(event);
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
    if (this.gatePause(call)) return;
    const startedTU = this.startPause(call);
    this.waiting = { callId: call.id, kind: "wait", startedTU, worldCalls: this.pendingWorldCalls() };

    // Drain already committed passive perceptions only after the wait actually ends.
    // Interrupted waits must not trigger active observation or invent an elapsed interval.
    const narrateMinMs = this.config.world.waitNarrateMinRealSeconds * 1000;
    const shouldObserve = narrateMinMs > 0 && this.clock.realMsUntil(call.expectedAt) >= narrateMinMs;
    this.schedule(call, {
      executeAt: "expected",
      run: async () => {
        this.finishPause(call.id);
        if (shouldObserve) {
          void this.world.resolveWait(call, (content) => this.pushEvent("world", content)).catch((err) => {
            this.logger.warn("等待后的感知交付失败：%s", err);
          });
        }
        const elapsed = Math.max(0, this.clock.now() - startedTU);
        return { text: `等待结束，经过 ${elapsed.toFixed(1)} TU。`, originEventIds: [] };
      },
    });
  }

  private dispatchAct(call: ToolCallRecord): void {
    const desc = typeof call.arguments.description === "string" ? call.arguments.description.trim() : "";
    if (!desc) {
      this.pushEvent("system", "（动作未提交：act.description 必须是非空的具体行动；target 和 speech 是可选补充，不能代替行动描述。）", { ref: call.id });
      return;
    }
    const boundary = detectDeviceRequest([desc, typeof call.arguments.target === "string" ? call.arguments.target : ""].join("\n"));
    if (boundary) {
      this.pushEvent("system", `（动作未提交：${describeToolCall(call)}。${DEVICE_TOOL_GUIDANCE}）`, { ref: call.id, originEventIds: [] });
      return;
    }
    // blockingAct：一个人同时只能专注做一件事。上一个动作还没完成时，新的 act 直接拒绝并提示，
    // 不调用 World-LLM 裁定；也不像 repeat 那样给 Bot 留绕过口（专注模式不可无视）。
    if (this.strictToolLoop || this.config.bot.blockingAct) {
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
    let actionCompleted = false;
    this.schedule(call, {
      executeAt: "now",
      delivery: "immediate",
      cancellation: "cooperative",
      resultOk: () => actionCompleted,
      run: async (task) => {
        const parts: RichText[] = [];
        const worldEpoch = call.worldEpoch ?? this.perceivedWorldEpoch;
        const ok = await this.world.adjudicateAct(call, async (content, route) => {
          const result: RichText = { text: content, originEventIds: observationOrigins(content),
            experience: { worldPerception: true, worldEpoch,
              ...(route?.current === false || worldEpoch !== this.perceivedWorldEpoch ? { historicalWorld: true } : {}) } };
          let ongoing = false;
          try { ongoing = JSON.parse(content)?.action?.status === "pending"; } catch { /* preserve ordinary passive and final receipts below */ }
          if (!ongoing) { parts.push(result); return; }
          // A committed beginning is an experience now, not proof of the eventual outcome.
          for (const part of parts.splice(0)) this.pushEvent("world", part);
          const rich = this.puppetReceipt(this.describeExperience(result, call), call.id);
          if (this.retired) await this.receipts.save(rich, this.clock.now(), call.id, this.isWakeableToolResult(call.name, rich));
          else this.pushEvent("tool", this.spillResult(rich, call.id + "-start"), { ref: call.id, wake: true });
        }, task.signal, phase => {
          if (task.cancelled() || (call.control && (this.residentControl?.sessionId !== call.control.sessionId || this.residentControl.mode !== call.control.mode))) return false;
          return phase === "start" ? true : task.beginCommit();
        });
        if (task.cancelled()) return null;
        const adjudicatedFailure = parts.some((part) => {
          try { return JSON.parse(part.text)?.action?.status === "failed"; } catch { return false; }
        });
        actionCompleted = ok && !adjudicatedFailure;
        if (!ok && !adjudicatedFailure) throw new Error("世界未能裁定此动作，结果尚未确认");
        if (!parts.length) throw new Error("世界未返回可感知的动作结果，不能认定动作成功");
        // World delivery can include previously unread perceptions before/after this action.
        // Each is its own experience; concatenating JSON both breaks the receipt contract and
        // wrongly attributes those earlier world events to this newly completed choice.
        let actionIndex = parts.length - 1;
        for (let index = parts.length - 1; index >= 0; index--) {
          try { if (JSON.parse(parts[index]!.text)?.action) { actionIndex = index; break; } } catch { /* retain an opaque remote receipt as unknown below */ }
        }
        const observation = (part: RichText): RichText & { source: "world" } => ({ ...part, source: "world",
          experience: { ...part.experience, agency: "observed", opportunity: false },
        });
        const result = parts[actionIndex]!;
        return { ...result, originEventIds: result.originEventIds ?? [],
          precedingObservations: parts.slice(0, actionIndex).map(observation),
          followingObservations: parts.slice(actionIndex + 1).map(observation),
        };
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
        this.phoneUi = { chatOpen: true, channelKey: null, channelIsGroup: false, forwardStack: [] };
        this.refreshToolGate();
        const rich = await this.messenger.recentChannels(10);
        const prefix = closed ? `（你关掉了「${closed}」）` : "";
        const unlock = `${this.config?.apps?.chatAppName || "QQ"} · 消息列表\n`;
        return typeof rich === "string"
          ? { text: prefix + unlock + rich }
          : { ...rich, text: prefix + unlock + rich.text,
            ...(rich.parts?.length ? { parts: [{ kind: "text" as const, text: prefix + unlock }, ...rich.parts] } : {}) };
      });
    }
    return this.dispatchLocal(call, async () => {
      try {
        const { closed, opening } = await this.apps!.open(resolved.app, { learn: !this.stealthCalls.has(call.id) });
        // 手机同屏只有一个应用：打开 MCP 应用时聊天界面随之退出
        const chatWasOpen = this.phoneUi.chatOpen;
        this.phoneUi = { chatOpen: false, channelKey: null, channelIsGroup: false, forwardStack: [] };
        this.refreshToolGate();
        const closedNote = closed
          ? `（「${closed}」已被关掉）`
          : chatWasOpen
            ? "（聊天应用已被关掉）"
            : "";
        // 拟人化应用（终端 / 资源管理器等）自带开场描述，覆盖通用的“你打开了「xx」”
        const tail = closedNote ? `\n${closedNote}` : "";
        if (opening && typeof opening !== "string") {
          return { ...opening, text: opening.text + tail,
            ...(opening.parts?.length ? { parts: [...opening.parts, { kind: "text" as const, text: tail }] } : {}),
          };
        }
        return (opening || `你打开了「${resolved.app.name}」。`) + tail;
      } catch (err) {
        this.refreshToolGate();
        return `（「${resolved.app.name}」启动失败：${(err as Error).message ?? err}）`;
      }
    });
  }

  private dispatchLocal(call: ToolCallRecord, run: () => Promise<string | RichText>): void {
    this.schedule(call, { executeAt: "now", run: async () => {
      const result = run();
      if (call.name !== "reflect") return result;
      // A completed platform send may outlive stop, but a local reflection writes
      // into the world's reusable directory and must finish before reset removes it.
      this.growthToolWrites.add(result);
      try { return await result; } finally { this.growthToolWrites.delete(result); }
    } });
  }

  /** A queued local posture change has not happened yet, even if its device task
   * already began. Revalidate after waiting for a World commit or app close. */
  private checkPhoneExecution(call: ToolCallRecord, epoch: number): void {
    if (!this.running || this.retired) throw new Error("设备所属世界已停止，手机持有操作没有执行。");
    if (call.control && (this.residentClosing || this.residentControl?.sessionId !== call.control.sessionId || this.residentControl.mode !== call.control.mode)) {
      throw new Error("角色接管会话已结束，手机持有操作没有执行。");
    }
    if (call.role === "agent" && !call.control && (epoch !== this.phoneExecutionEpoch || this.manualPaused || this.residentControl?.mode === "puppet")) {
      throw new Error("自主设备控制权已改变，手机持有操作没有执行。");
    }
  }

  private async settleGrowthWrites(): Promise<void> {
    await Promise.all([this.growthRuntime.settled(), Promise.allSettled([...this.growthToolWrites])]);
  }

  private classifyDevice(name: string): DeviceKind | null {
    return deviceKind(name, new Set(this.apps?.activeToolNames() ?? []), new Set(this.computer?.activeToolNames() ?? [])) ?? this.knownDeviceTools.get(name) ?? null;
  }

  /** Both autonomous and human calls serialize one side effect, then release the device. */
  private schedule(call: ToolCallRecord, opts: ScheduleOptions): void {
    for (const id of this.operationCalls.keys()) if (!this.scheduler.isPending(id)) this.operationCalls.delete(id);
    if (this.scheduler.isPending(call.id)) throw new Error(`工具调用编号重复：${call.id}`);
    this.operationCalls.set(call.id, call);
    const kind = call.name === "observe_device" ? call.arguments.device as DeviceKind : this.classifyDevice(call.name);
    if (!kind) {
      this.scheduler.schedule(call, { ...opts, beforeStart: () => {
        if (!this.currentToolNames(call.id).includes(call.name)) throw new Error(`工具 ${call.name} 此刻不可用，此操作没有执行；请依据最新能力变化事件选择操作`);
        if (call.role === "agent" && this.residentControl?.mode === "puppet" && !this.autonomousDuringPuppet(call.name)) throw new Error("身体与设备正受外部操纵，此自主操作没有执行");
        opts.beforeStart?.();
      } });
      this.refreshToolGate();
      return;
    }
    const phoneApp = this.apps?.hasTool(call.name) ? this.apps.view()?.id : null;
    const stealth = this.stealthCalls.has(call.id);
    let revealOnAttention = false;
    this.scheduler.schedule(call, {
      ...opts, serialKey: "devices",
      // Actual local UI results are already known. Only human receipt timing and
      // operations deliberately scheduled for later (e.g. typing) retain duration.
      ...(call.role === "agent" && !call.control && !stealth && opts.executeAt === "now" ? { delivery: "immediate" as const } : {}),
      beforeStart: () => {
        if (!this.running) throw new Error("设备所属世界已停止，此操作没有执行");
        if (call.control && (this.residentClosing || this.residentControl?.sessionId !== call.control.sessionId)) throw new Error("角色接管会话已结束，此设备操作没有执行");
        if (call.role === "agent" && this.residentControl?.mode === "puppet" && !this.autonomousDuringPuppet(call.name)) throw new Error("身体与设备正受外部操纵，此自主操作没有执行");
        if (kind === "phone" && call.name !== "observe_device") {
          if (call.name === "pick_up_phone" && !canReachPhone(this.phone)) throw new Error(phoneUnavailableReason(this.phone));
          if (!["pick_up_phone", "put_down_phone"].includes(call.name) &&
            (stealth || call.role === "system" && !call.control ? !phonePhysicalState(this.phone).usable : !canUsePhone(this.phone))) throw new Error(phoneUnavailableReason(this.phone));
        }
        if (call.role === "agent" || call.control) {
          revealOnAttention = this.concealedDevices.has(kind);
          this.attention = kind;
          if (call.name === "observe_device") this.observingPlacedPhone = kind === "phone";
          this.concealedDevices.delete(kind);
          this.refreshToolGate();
        }
        if (stealth) this.concealedDevices.add(kind);
        if (!this.currentToolNames(undefined, false, !stealth && call.role === "agent").includes(call.name) || (phoneApp && this.apps?.view()?.id !== phoneApp)) {
          throw new Error("设备界面已改变，此操作已不可用；请查看当前界面后重新决定");
        }
        opts.beforeStart?.();
      },
      run: async task => {
        this.deviceOperations++;
        try {
          const result = await opts.run(task);
          if ((call.role === "agent" || call.control) && (call.name === "put_down_phone" || call.name === "close_computer")) {
            this.attention = null;
            this.observingPlacedPhone = false;
          }
          if (call.name !== "observe_device" && (stealth || revealOnAttention) && this.running && this.deviceAttention === kind) {
            try { await this.perceiveDeviceChange(kind); }
            catch (error) {
              // The operation already completed. A subsequent screen refresh cannot undo it.
              this.logger.warn("设备操作完成后读取界面失败，保留操作真实回执：%s", error);
            }
          }
          return result;
        } finally { this.deviceOperations--; }
      },
    });
    this.refreshToolGate();
  }

  /** Visible desktop facts only: no notification delivery, message preview or read acknowledgement. */
  private phoneDesktopBadge(): string {
    if (!this.notifyList || this.phoneUi.chatOpen || this.apps?.currentName || !canReachPhone(this.phone) || !canPerceivePhone(this.phone)) return "";
    const unread = this.notifyList.snapshot().unread;
    const name = this.config.apps?.chatAppName?.trim() || "聊天应用";
    return unread > 0 ? `${name} 图标上有未读角标：${unread > 99 ? "99+" : unread}。` : `${name} 图标上没有未读角标。`;
  }

  /** Read the current interface only. This cannot open, connect, or change device state. */
  private async deviceObservation(kind: DeviceKind): Promise<RichText> {
    if (kind === "phone" && (!canReachPhone(this.phone) || !canPerceivePhone(this.phone))) return { text: "目前看不到可辨认的手机界面。", originEventIds: [] };
    let pixels: RichText | null = null;
    try { if (kind === "phone" || this.computer?.isOpen) pixels = await this.peekDevice?.(kind) ?? null; }
    catch (error) { this.logger.debug("读取可见设备画面失败：%s", error); }
    if (kind === "phone" && (!canReachPhone(this.phone) || !canPerceivePhone(this.phone))) return { text: "目前看不到可辨认的手机界面。", originEventIds: [] };
    if (kind === "phone") await this.apps?.learnCurrentTools?.();
    else await this.computer?.learnCurrentTools?.();
    const view = kind === "phone" ? this.apps?.screen() : this.computer?.view()?.result;
    const visible = pixels ?? (typeof view === "string" ? { text: view } : view);
    const label = kind === "phone"
      ? `手机当前显示：${this.phoneUi.chatOpen ? (this.config.apps?.chatAppName || "QQ") + (this.phoneUi.channelKey ? `，频道 ${this.phoneUi.channelKey}` : "，消息列表") : this.apps?.currentName ?? "桌面"}`
      : !this.computer ? "当前没有可用电脑" : `电脑当前${this.computer.isOpen ? "处于打开状态" : "已关闭"}`;
    const heading = `（你正看着${kind === "phone" ? "手机" : "电脑"}，当前可见界面：${label}。）` +
      (kind === "phone" ? this.phoneDesktopBadge() : "") +
      (visible?.text ? `\n${pixels ? "界面上显示的内容" : "已有界面回显"}（不是你的行动或心理记录）：\n` : "");
    return {
      text: heading + (visible?.text ? (visible.parts?.length ? visible.text : truncate(visible.text, 3000)) : ""),
      attachments: visible?.attachments,
      parts: visible?.parts?.length ? [{ kind: "text", text: heading }, ...visible.parts] : undefined,
      // Preserve the original visible message roots and scope; a screen reread is
      // observed evidence, even if an application's cached result described a past execution.
      originEventIds: visible?.originEventIds ?? [],
      growthReferences: visible?.growthReferences,
      experience: { ...visible?.experience, agency: "observed", outcome: "unknown", opportunity: false, worldPerception: false,
        action: undefined,
        ...(visible?.experience?.chat?.kind === "send" ? { chat: { ...visible.experience.chat, kind: "attention" } } : {}),
      },
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

  /** Interruptions alone are not progress: require a new delivered fact or completed choice. */
  private noteProgress(event: BotEvent, reset = true): void {
    if (event.source === "system") return;
    const roots = event.originEventIds ?? [];
    const fresh = roots.filter(root => !this.progressRoots.has(root));
    for (const root of roots) this.progressRoots.add(root);
    while (this.progressRoots.size > 4096) this.progressRoots.delete(this.progressRoots.values().next().value!);
    // An unread notification confirms only a notification, irrespective of which channel is open.
    if (!fresh.length || fresh.every(root => root.startsWith("chat-notice:"))) return;
    let progress = fresh.some(root => root.startsWith("chat-message:")) ||
      (event.experience?.agency === "self" && event.experience.outcome === "completed" && event.experience.opportunity === true);
    if (event.source === "world" || event.experience?.worldPerception) {
      try {
        const parsed = JSON.parse(event.content);
        const observation = parsed.observation ?? parsed;
        if (Array.isArray(observation.entities)) {
          const names = new Map(observation.entities.map((entity: any) => [entity.observedId, `${entity.kind}:${entity.name}`]));
          const shape = JSON.stringify(observation.entities.map((entity: any) => canonicalizeArgs({
            kind: entity.kind, name: entity.name, self: entity.self, attributes: entity.attributes,
            location: names.get(entity.locationObservedId), owner: names.get(entity.ownerObservedId),
          })).sort());
          progress ||= shape !== this.observedWorldShape;
          this.observedWorldShape = shape;
        }
        progress ||= Array.isArray(observation.utterances) && observation.utterances.some((utterance: any) => fresh.includes(utterance.eventId));
      } catch { /* Free-form world prose cannot prove a new structured state transition. */ }
    }
    if (reset && progress) {
      this.repeatGuard.reset();
      this.forceRestCount = 0;
    }
  }

  /**
   * 工具结果溢出治理（spill/prune，对应 dsh 的 tool-result-pruner + spill-policy）：
   * 纯文本结果超过 spillMinChars 时，裁成「头部 + 省略标记 + 尾部」，全文 fire-and-forget 落盘到
   * <base>/spill/，模型上下文只保留裁剪预览。世界回执在 JSON 字段内裁剪，保持事实与候选可分离。
   * 落盘尽力而为，失败不把成功的调用变成失败。
   *
   * 注意：这里只裁剪 **模型可见** 的文本，原始结果仍由 scheduler 的结果语义保留；
   * 裁剪只发生在新回执进入上下文之前，不改写任何已发送的历史前缀。
   */
  private spillResult(content: string | RichText, ref?: string): string | RichText {
    const threshold = this.config.bot.spillMinChars ?? 4000;
    if (threshold <= 0) return content;
    if (typeof content !== "string" && (content.parts?.length || content.attachments?.length)) return content;
    const text = typeof content === "string" ? content : content.text;
    if (text.length <= threshold) return content;
    const spillFile = this.files.spillPath(ref ? `${ref}.txt` : `result_${Date.now()}.txt`);
    const worldReceipt = typeof content !== "string" &&
      (content.experience?.worldPerception === true || (content as RichText & { source?: string }).source === "world");
    const narrative = worldReceipt ? spillNarrativeText(text, threshold, spillFile) : undefined;
    // head/tail 各占约 45%，中间省略标记
    const headChars = Math.floor(threshold * 0.45);
    const tailChars = Math.floor(threshold * 0.45);
    const head = sliceText(text, 0, headChars);
    const tail = sliceText(text, text.length - tailChars);
    const omitted = text.length - headChars - tailChars;
    const marker = `\n\n[... 中间 ${omitted} 字符已省略，完整结果见 ${spillFile} ...]\n\n`;
    const preview = narrative ?? head + marker + tail;
    // 落盘（异步、尽力而为）
    void this.files
      .atomicWrite(spillFile, text)
      .catch(() => {/* spill 失败静默：模型仍拿到预览 */});
    return typeof content === "string" ? preview : { ...content, text: preview };
  }

  /** A shared idle budget prevents rest from being a second unrestricted wait. */
  private gatePause(call: ToolCallRecord): boolean {
    const threshold = this.config.bot.waitRateThreshold;
    const windowTU = this.config.bot.waitRateWindow;
    if (call.role !== "agent" || call.control || this.residentControl?.mode === "puppet" || !(threshold > 0 && windowTU > 0)) return false;
    const now = this.clock.now();
    const paused = this.waitedWithin(now - windowTU, now);
    const rate = Math.round(paused / windowTU * 100);
    if (rate < threshold) { this.pauseConfirmArmed = null; return false; }
    if (this.pauseConfirmArmed === call.name && isTruthy(call.arguments.confirm)) {
      this.pauseConfirmArmed = null;
      return false;
    }
    this.pauseConfirmArmed = call.name === "rest" ? "rest" : "wait";
    this.logger.debug("暂停额度已耗尽：%s，最近 %s TU 暂停 %s TU，阈值 %s%%", call.name, windowTU, paused.toFixed(1), threshold);
    this.pushEvent("system", "等待额度已耗尽", { ref: call.id, originEventIds: [] });
    return true;
  }

  private startPause(call: ToolCallRecord): number {
    const from = this.clock.now();
    this.pauseStarts.set(call.id, { from, autonomous: call.role === "agent" && !call.control && this.residentControl?.mode !== "puppet" });
    return from;
  }

  private finishPause(callId: string): void {
    const pause = this.pauseStarts.get(callId);
    if (!pause) return;
    this.pauseStarts.delete(callId);
    if (pause.autonomous) this.recordWait(pause.from);
  }

  /** Record actual autonomous paused time; an interruption cannot erase its elapsed portion. */
  private recordWait(fromTU: number): void {
    const to = this.clock.now();
    if (to <= fromTU) return;
    this.waitLog.push({ from: fromTU, to });
    const keepAfter = to - (this.config.bot.waitRateWindow || 3600) * 2;
    if (this.waitLog[0] && this.waitLog[0].to < keepAfter) {
      this.waitLog = this.waitLog.filter((iv) => iv.to >= keepAfter);
    }
  }

  /** Union intervals so overlapping controller transitions cannot double-count elapsed time. */
  private waitedWithin(fromTU: number, toTU: number): number {
    const intervals = [...this.waitLog, ...[...this.pauseStarts.values()].filter(item => item.autonomous).map(item => ({ from: item.from, to: toTU }))]
      .map(iv => ({ from: Math.max(fromTU, iv.from), to: Math.min(toTU, iv.to) }))
      .filter(iv => iv.to > iv.from).sort((a, b) => a.from - b.from);
    let sum = 0, through = fromTU;
    for (const iv of intervals) {
      sum += Math.max(0, iv.to - Math.max(through, iv.from));
      through = Math.max(through, iv.to);
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
   * 回显作为随后独立交付的观察，保留图文顺序；发送自身的行为证据不包含群友的历史。
   * messaging.sendEcho 关闭时只回 out、不带频道列表。
   */
  private async echoChannelRecent(id: string, out: string | RichText, n?: number): Promise<string | RichText> {
    if (this.config.messaging.sendEcho === false) return out;
    const receipt = typeof out === "string" ? { text: out } : out;
    try {
      const recent = await this.messenger.channelMessages(id, n ?? this.config.messaging.sendEchoRecent, { intro: "echo" });
      const recentText = recent.text.trim();
      // Readback is a different observation. Combining roots here would make many
      // independent sends share all older messages and falsely merge their evidence.
      return recentText ? {
        ...receipt,
        followingObservations: [...(receipt.followingObservations ?? []), {
          ...recent, experience: { ...recent.experience, agency: "observed", opportunity: false },
        }],
      } : out;
    } catch (error) {
      this.logger.warn("发送后的聊天回显读取失败，保留原始发送回执：%s", error);
      const suffix = "\n（暂时读不到最新聊天记录；以上发送回执仍有效，不要因回显缺失重复发送。）";
      return { ...receipt, text: receipt.text + suffix, ...(receipt.parts ? { parts: [...receipt.parts, { kind: "text" as const, text: suffix }] } : {}) };
    }
  }


  // ---------- 发送（原位绑定媒体引用） ----------

  private dispatchSend(call: ToolCallRecord): void {
    const targetError = sendTargetError(call.arguments);
    if (targetError) {
      this.pushEvent("system", targetError, { ref: call.id });
      return;
    }
    const id = (call.arguments.id as string).trim();
    // sendBlocking：上一条消息还没回显前，拒绝新的 send（避免连发相近/不连贯的消息）
    if (this.strictToolLoop || this.config.bot.sendBlocking) {
      const busy = sendBusyMessage(SEND_TOOL_NAMES.flatMap((n) => this.scheduler.pendingByName(n)));
      if (busy) {
        this.pushEvent("system", busy, { ref: call.id });
        return;
      }
    }
    if (call.arguments.msg !== undefined && typeof call.arguments.msg !== "string") {
      this.pushEvent("system", "本次未发送：msg 必须为正文字符串。", { ref: call.id });
      return;
    }
    let msg = call.arguments.msg ?? "";
    const metadataError = senderTagError(msg);
    if (metadataError) {
      this.pushEvent("system", `本次未发送：${metadataError}`, { ref: call.id });
      return;
    }
    const aliases = ["images", "replyTo", "quote", "atSender", "at"].filter(key => Object.hasOwn(call.arguments, key));
    if (aliases.length) {
      this.pushEvent("system", `本次未发送：不支持参数 ${aliases.join("、")}。`, { ref: call.id });
      return;
    }
    const mediaRaw = call.arguments.media;
    if (mediaRaw !== undefined && (!Array.isArray(mediaRaw) || mediaRaw.some(ref => typeof ref !== "string" && !(typeof ref === "number" && Number.isSafeInteger(ref))))) {
      this.pushEvent("system", "（消息没有发出：media 必须是明确媒体引用的数组，例如 [\"media:12\", \"gallery:照片/猫.png\"]。）", { ref: call.id });
      return;
    }
    const media = Array.isArray(mediaRaw) ? (mediaRaw as (string | number)[]) : [];
    const replyRaw = call.arguments.reply_to;
    let replyTo = normalizeMsgId(replyRaw);
    if (replyRaw !== undefined && !replyTo) {
      this.pushEvent("system", "本次未发送：reply_to 需要完整消息 ID，不能用媒体引用。", { ref: call.id });
      return;
    }
    // Both quote entry paths have the same body for length/repetition checks.
    // Keep the original tool call intact in append-only history for auditing.
    const quote = resolveOutgoingQuote(msg, replyTo);
    if (quote.error !== undefined) {
      this.pushEvent("system", `本次未发送：${quote.error}`, { ref: call.id });
      return;
    }
    msg = quote.msg; replyTo = quote.replyTo;
    const atRaw = call.arguments.at_sender;
    const atSender = !(atRaw === false || atRaw === "false" || atRaw === 0);
    if (!msg && !media.length) {
      const alias = ["message", "text", "content"].find((k) => call.arguments[k] != null);
      this.pushEvent(
        "system",
        alias
          ? `（send 的消息参数必须叫 msg，不存在 ${alias} 这种参数。正确格式：send(msg: string, id: string, …)。）`
          : "（send 需要 msg（或 media）参数。）",
        { ref: call.id },
      );
      return;
    }
    if (/<img\b|\[(?:图片|视频|音频|语音)#\d+/i.test(msg)) {
      this.pushEvent("system", '（消息没有发出：旧媒体占位格式已停用。先查看/选择媒体，再用 <media ref="media:12"/> 明确填入原位置；不会创建自动发送的待填充草稿。）', { ref: call.id });
      return;
    }
    // Explicit references are complete messages; every send passes the same validation/scheduler.
    this.finishSend(call, id, msg, media, replyTo, atSender);
  }

  /** Resolve choices without sending. Explicit references remain valid independent of display order. */
  private dispatchPickMedia(call: ToolCallRecord): void {
    return this.dispatchLocal(call, async () => {
      const raw = call.arguments.media;
      const refs = Array.isArray(raw) ? raw.map(String) : [];
      if (!refs.length) return "（pick_media 需要 media 参数：media:N 或 gallery:分类/文件名的列表。）";
      if (refs.length > 9) return "（一次最多选择 9 个媒体，请分批选择。）";
      const results = await this.messenger.resolveMediaRefs(refs);
      const failures = results.filter((r): r is PickFailure => !r.ok);
      if (failures.length) return `（选图未完成，没有发送消息：${failures.map(r => `${r.refText}：${r.error}`).join("；")}）`;
      const selected = results.filter((r): r is PickResult => r.ok);
      const rows = selected.map((r, index) => {
        const original = refs[index]!.trim();
        if (r.ref.type === "audio") return `${original} → media:${r.ref.id}（音频；当前 send 不支持发送音频，没有选为可发送内容）`;
        // Equal bytes do not imply equal usage: an explicit gallery category can
        // choose an ordinary image even if this asset was previously a sticker.
        const gallery = original.startsWith("gallery:");
        const ref = gallery ? original : `media:${r.ref.id}`;
        // The inline grammar does not support quotes or angle brackets in paths.
        // Keep those verified filenames as JSON string values for send.media.
        const insertion = /["'<>]/.test(ref) ? `send.media 引用 ${JSON.stringify(ref)}` : `<media ref="${ref}"/>`;
        return `${original} → ${insertion}${gallery ? `（对应资源 media:${r.ref.id}；保留图库分类用途）` : ""}` +
          (r.sticker ? "（会话表意符号；平台表情包，发送时在原位置独立成一条）" : "");
      });
      return { text: `已确认以下媒体引用；尚未发送任何消息：\n${rows.join("\n")}\n如决定发送，将可发送的媒体标签放入 send.msg 对应位置，或把引用放入 send.media 在末尾追加。选中不要求补充解说或收藏，不创建草稿，也不会自动发送；实际发送以 send 回执为准。`,
        contextHint: { text: `可用媒体引用（尚未发送）：\n${rows.join("\n")}` } };
    });
  }

  /** Every explicit send uses the same duration, confirmation, duplicate and platform checks. */
  private finishSend(call: ToolCallRecord, id: string, msg: string, media: (string | number)[], replyTo: string | undefined, atSender: boolean): void {
    const longLimit = this.config.messaging.longMessageChars;
    if (longLimit > 0 && msg.length > longLimit && !isTruthy(call.arguments.confirm_long)) {
      this.pushEvent(
        "system",
        "正文过长，本次未发送。确需发送可用 confirm_long: true。",
        { ref: call.id },
      );
      return;
    }
    if (this.maybeDeferSend(call, "text", id, msg)) return;
    if (this.gateSendDuration(call, "打字")) return;
    const insist = isTruthy(call.arguments.insist);
    let sent = false;
    this.schedule(call, {
      executeAt: "expected",
      run: async () => {
        const out = await this.deliverSend(id, msg, media, replyTo, atSender, insist, isTruthy(call.arguments.resend), receipt => { sent = receipt.status === "sent"; });
        return out;
      },
      resultOk: () => sent,
    });
  }

  /** 真正发出：切频道 + messenger.send，打断延期发送意图，回显。 */
  private async deliverSend(id: string, msg: string, media: (string | number)[], replyTo: string | undefined, atSender: boolean, insist: boolean, resend = false, onReceipt?: (receipt: MessageSendReceipt) => void): Promise<string | RichText> {
    const target = await this.switchToTarget(id);
    if ("error" in target) return target.error;
    const execution = this.deviceExecution.getStore();
    if (execution?.stealth || execution?.external ? !phonePhysicalState(this.phone).usable : !canUsePhone(this.phone)) return `本次未发送。${phoneUnavailableReason(this.phone) ?? "手机不可用。"}`;
    // Check at actual execution, after resolving aliases and after earlier queued sends settle.
    // A cancelled, invalid or rejected attempt is not something the person has already said.
    const sig = JSON.stringify([target.key, msg, media.map(String)]);
    const recentRepeat = this.recentSendSigs.filter(s => s === sig).length;
    if (!resend && this.uncertainSendSigs.has(sig)) return "上次发送结果未知，可能已送达；本次未重发。核对后可用 resend: true。";
    if (!resend && this.config.messaging.recentRepeatThreshold > 0 && recentRepeat >= this.config.messaging.recentRepeatThreshold) {
      return "相同内容已发送，本次未重发。确需重复可用 resend: true。";
    }
    const receipt: MessageSendReceipt = this.messenger.sendReceipt
      ? await this.messenger.sendReceipt(target.key, msg, media, replyTo, atSender, insist)
      : await this.messenger.send(target.key, msg, media, replyTo, atSender, insist).then(text => ({ text, status: "sent" as const, messageIds: [] }));
    if (receipt.status === "sent") {
      this.recordSendSig(sig);
      this.uncertainSendSigs.delete(sig);
    } else if (receipt.status === "partial" || receipt.status === "unknown") {
      if (!this.deviceExecution.getStore()?.stealth) {
        this.uncertainSendSigs.add(sig);
        if (this.uncertainSendSigs.size > Math.max(1, this.config.messaging.recentRepeatWindow)) this.uncertainSendSigs.delete(this.uncertainSendSigs.values().next().value!);
      }
    }
    onReceipt?.(receipt);
    if (receipt.status === "blocked") return receipt.text;
    try { this.noteDeferredSelfSent(target.key); }
    catch (error) { this.logger.warn("发送后更新延期意图失败，保留真实发送回执：%s", error); }
    return this.echoChannelRecent(id, { text: receipt.text, originEventIds: receipt.originEventIds,
      experience: { ...receipt.experience,
        action: `向 ${target.key} ${receipt.status === "sent" ? "发送了" : "尝试发送"}消息：${sliceText(msg, 0, 1000)}${media.length ? `（附 ${media.length} 个媒体引用）` : ""}`,
        situation: `聊天频道 ${target.key}`,
        outcome: receipt.status === "sent" ? "completed" : "unknown",
      },
    });
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
    const result = call.role === "agent" && this.stealthCalls.has(target) ? "not_found" : this.scheduler.cancel(target);
    if (result === "cancelled") {
      this.finishPause(target);
      this.operationCalls.delete(target);
      this.externalToolResults.get(target)?.resolve({ ok: false, callId: target, text: "（已取消后续尚未提交的部分；此前已发生的结果保留。）" });
      this.externalToolResults.delete(target);
      this.puppetCalls.delete(target);
      this.stealthCalls.delete(target);
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
    this.refreshToolGate();
  }

  /** 角色休息与记忆维护分别调度；通知始终可以打断角色休息。 */
  private dispatchRest(call: ToolCallRecord): void {
    if (this.gatePause(call)) return;
    const threshold = this.config.bot.restCompressMinChars;
    if (threshold <= 0 || this.context.approxChars() >= threshold) this.compressionRequested = "rest";
    // Actual rest is always an interruptible timer; context maintenance never imposes sleep.
    this.dispatchLightRest(call);
  }

  /** Pause generation until the timer ends or an actual delivered event interrupts it. */
  private dispatchLightRest(call: ToolCallRecord): void {
    const raw = Number(call.arguments.duration ?? call.duration ?? 0);
    const n = Number.isFinite(raw) && raw > 0 ? raw : 300;
    // expectedAt 只影响调度不进入上下文渲染，可安全修正（duration 可能写在 arguments 里）
    call.expectedAt = call.issuedAt + n;
    const startedTU = this.startPause(call);
    this.waiting = { callId: call.id, kind: "rest", startedTU, worldCalls: this.pendingWorldCalls() };
    this.schedule(call, {
      executeAt: "expected",
      run: async () => {
        this.finishPause(call.id);
        const elapsed = Math.max(0, this.clock.now() - startedTU);
        return { text: `休息计时结束，经过 ${elapsed.toFixed(1)} TU。`, originEventIds: [] };
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
    if (this.running && !this.manualPaused) this.growthRuntime.tick(this.abort?.signal, true);
    const snapshot = await this.context.compressionSnapshot();
    if (!snapshot.entries.length) return;
    await this.growth.restorePerceptions(snapshot.entries);
    this.logger.info("整理记忆（%s）：%d 条记录", reason ?? "rest", snapshot.entries.length);
    let result: CompressionResult;
    try {
      result = await abortable(this.world.compress({
        persona: this.context.pinned.botDefinition,
        historySummary: this.context.pinned.historySummary,
        memoryDigest: this.context.pinned.memoryDigest,
        streamText: snapshot.text,
        timeLine: this.clock.timeLine(),
        chatAccounts: this.context.accountsProvider?.() ?? "",
      }), this.abort?.signal);
    } catch (err) {
      if (!this.running) return;
      this.logger.warn("记忆整理失败，保留原始经历：%s", err);
      await sleep(this.config.bot.retryDelayMs, this.abort?.signal);
      return;
    }
    if (!this.running) return;
    // Stage the exact post-compression capability list before the durable prefix cutover.
    // Failed writes retain the previous native snapshot and restore any temporary bans.
    const previousBans = new Set(this.tempBannedTools);
    this.tempBannedTools.clear();
    this.refreshToolGate();
    try {
      // The memory writer cannot mutate objective world state.
      await this.context.applyCompression(result, this.clock.now(), snapshot, await this.growth.summary(this.clock.now()));
    } catch (error) {
      for (const name of previousBans) this.tempBannedTools.add(name);
      this.refreshToolGate();
      throw error;
    }
    this.backend.resetToolSnapshot?.();
    // Ordinary maintenance is not new progress. Only the explicit loop intervention
    // starts a new repeat-detection attempt; neither path renews the pause budget.
    if (reason === "breakLoop") {
      this.repeatGuard.reset();
      this.forceRestCount = 0;
    }
    this.refreshToolGate();
    this.wakeTimeLine = this.clock.timeLine();
  }

}

/** World prose and its presentation share committed causes; retain every original root. */
function observationOrigins(text: string): string[] | undefined {
  try {
    if (text.startsWith("（以下是外部操纵你身体/设备产生的回执，")) text = text.slice(text.indexOf("\n") + 1);
    const parsed = JSON.parse(text) as Partial<WorldObservation> & { observation?: Partial<WorldObservation>;
      scene?: { eventId?: string; actorId?: string; sourceEventIds?: string[] } };
    const scene = parsed.scene;
    const data = parsed.observation ?? parsed;
    // A remote actor uses visitor:<session>, bound by the authenticated WorldAgent connection.
    const observationRoots = data && typeof data.actorId === "string" && !!data.actorId && typeof data.observationId === "string" && Array.isArray(data.sourceEventIds)
      ? data.sourceEventIds : undefined;
    const sceneRoots = scene && typeof scene.eventId === "string" && typeof scene.actorId === "string" && !!scene.actorId && Array.isArray(scene.sourceEventIds)
      ? scene.sourceEventIds : undefined;
    if (!observationRoots && !sceneRoots) return undefined;
    // A compact scene can omit facts present in the full observation. Its ID and the wrapping
    // BotEvent ID are never new causes, including when a valid scene has no source roots.
    return [...new Set([...(observationRoots ?? []), ...(sceneRoots ?? [])].filter((id): id is string => typeof id === "string" && !!id))];
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

/** A pending action is not a completed action; retain its concrete identity. */
export function actBusyMessage(pendingActs: ToolCallRecord[], _repeatCount = 1): string | null {
  if (!pendingActs.length) return null;
  const intent = String(pendingActs[0]?.arguments.description ?? "").trim();
  return `${intent ? `「${truncate(intent, 60)}」` : "上一动作"}尚未返回结果，本次未提交。`;
}

export function repeatingActMessage(sig: string, _repeatCount: number, callId: string): string {
  return `${callId}${sig ? `「${truncate(sig, 48)}」` : ""}尚未返回结果，本次未重复提交。`;
}

/** Only send submits a platform message; pick_media merely resolves stable references. */
const SEND_TOOL_NAMES = ["send"];

/** 打破死循环时不该被移除的"安全"工具：计时/书签类，移除它们反而会让模型无处安放、更疯狂 */
function isBreakLoopSafeTool(name: string): boolean {
  return name === "wait" || name === "rest" || name === "observe_device";
}

/**
 * sendBlocking 阻塞模式：存在未完成（未回显）的 send 调用时，返回提示文本，否则 null。
 */
export function sendBusyMessage(pending: ToolCallRecord[]): string | null {
  if (!pending.length) return null;
  return `发送 ${pending.map(call => call.id).join("、")} 仍在处理，可能已经提交到平台；本次未发送。`;
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
 * 秒级禁言拦截：minutes 在 (0, 1) 之间（即禁言不足 60 秒）时返回提示文本。
 * 这类禁言几乎不会有实际效果，且容易让人以为已经处理了；
 * 如果确实要这么短（如拿来测自己群的接口），在参数里带 robot: true 放行。
 * 提示文本里说明了绕过参数但签名里没有它，避免模型产生惯性（与 wait 的 confirm 同理）。
 */
export function shortBanGateMessage(minutes: number, robot: boolean): string | null {
  if (robot) return null;
  if (minutes > 0 && minutes < 1) {
    return "禁言不足 1 分钟，本次未执行。确需短暂禁言可用 robot: true。";
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
