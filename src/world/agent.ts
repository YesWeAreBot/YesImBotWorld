import { randomUUID } from "node:crypto";
import type { HeartbeatResult } from "./tingle.js";
import { NarrativeWorld } from "./runtime.js";
import type { NarrativeObservation } from "./narrative-types.js";
import type { WorldObservation } from "./state.js";
import type { Logger } from "koishi";
import { type CalendarSpec, describeCalendar, gregorian, parseCalendarSpec, parseGregorianEpoch } from "../calendar.js";
import type { WorldClock } from "../clock.js";
import type { WorldModelConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import { ChatClient, type ChatMessage, type ChatResult } from "../llm/chat.js";
import { parseCompression } from "./compression.js";
import { withEndpointLock } from "../llm/lock.js";
import { extractHtml } from "../apps/html.js";
import {
  clampPhoneResolution,
  resolvePhoneResolution,
  type PhoneResolution,
} from "../phone.js";
import { COMPRESSION_CHAT_ATTRIBUTION_GUIDANCE, COMPRESSION_SOURCE_GUIDANCE, fill, type Prompts } from "../prompts.js";
import type { CompressionResult, PhonePhysicalState, RichText, ToolCallRecord } from "../types.js";
import type { PlayerMode } from "../crossing/protocol.js";
import { debug } from "../webui/debug.js";
import { WorldDeadline } from "./deadline.js";
import { worldGenerationSchema } from "./generation-schema.js";
import type { NarrativeConsciousness } from "./consciousness.js";

/** 在场访客的完整通道（穿越服务提供） */
export interface PresentVisitor {
  id?: string;
  name: string;
  /** 提供给世界裁定的角色档案。 */
  persona: string;
  /** 真人玩家的进入语义（cross=穿越/avatar=扮演/puppet=操纵）；Bot 访客恒为 cross */
  mode?: PlayerMode;
  /** 事件送达访客 */
  deliver: (content: string) => void;
  /** 向访客传递状态变化说明，不覆盖作者设定。 */
  updateStatus: (content: string) => void;
  /** 强行驱逐该访客（角色死亡/消散/升天等，切断其后续主动互动能力） */
  expel: (reason: string) => void;
}

/** 穿越服务传入的接待身份与档案。 */
export interface VisitorRef {
  id?: string;
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
  /** Authenticated remote actor state; old hosts omit this and remain unknown. */
  readonly consciousness?: NarrativeConsciousness;
  subscribeConsciousness?(listener: () => void): () => void;
  adjudicateAct(call: ToolCallRecord, deliver: (content: string) => void | Promise<void>, signal?: AbortSignal, beforeCommit?: () => boolean): Promise<boolean>;
  observe?(args?: { intent?: string; target?: string; modality?: string }): Promise<WorldObservation>;
  observeVirtualApp?(task: string): Promise<RichText>;
  executeVirtualApp?(task: string, signal?: AbortSignal): Promise<RichText>;
  resolveWait(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean>;
  resolveCheckTime(deliver: (content: string) => void): Promise<boolean>;
  query(task: string): Promise<string>;
}

/** Execution-route provenance, supplied by the program rather than parsed from model prose. */
export interface WorldActDeliveryRoute {
  epoch: string;
  worldName: string | null;
  /** A late receipt stays a real historical result, but cannot describe the current world. */
  current: boolean;
}

/**
 * World-LLM：无持续上下文的世界模拟 Agent。
 *
 * 每次被调用（响应 Bot 的工具调用 / Tingle / 初始化 / 定义变更）时，
 * 使用当前自然语言世界状态与本次任务裁定，不保存自己的调用对话历史。
 * NarrativeWorld 原子保存最新状态及角色实际感知；本层负责分发、元数据和 Bot 记忆整理。
 */
export class WorldAgent {
  private client: ChatClient;
  private maintenanceAbort = new AbortController();
  /** Only the service's serialized lifecycle transition may start a new generation. */
  resume(): void {
    if (this.maintenanceAbort.signal.aborted) this.maintenanceAbort = new AbortController();
    this.runtime.resume();
  }
  stop(): void {
    this.maintenanceAbort.abort(); this.runtime.stop();
    for (const task of this.queue.splice(0)) { this.pending--; task.reject(this.maintenanceAbort.signal.reason); }
  }
  private maintenanceRuns = new Set<Promise<unknown>>();
  async shutdown(): Promise<void> {
    this.stop();
    await this.runtime.shutdown();
    await this.drainTask;
    // Endpoint-lock cancellation can settle its caller before the worker has finished an
    // already-started file write. Join the workers as well before reset changes their files.
    while (this.maintenanceRuns.size) await Promise.allSettled([...this.maintenanceRuns]);
    await Promise.allSettled([...this.deliveryTails.values()]);
  }
  private trackMaintenance<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const job = fn();
    this.maintenanceRuns.add(job);
    void job.finally(() => this.maintenanceRuns.delete(job)).catch(() => {});
    return job;
  }
  private async maintenanceComplete(messages: ChatMessage[], signal: AbortSignal): Promise<ChatResult> {
    signal.throwIfAborted();
    const deadline = new WorldDeadline(this.cfg.actionTimeoutMs, signal, "WORLD_MAINTENANCE_TIMEOUT");
    try {
      const result = await abortable(withEndpointLock(this.cfg.baseURL,
        () => this.client.complete(messages, { signal: deadline.signal }), deadline.signal, { priority: "background" }), deadline.signal);
      deadline.signal.throwIfAborted();
      return result;
    } finally { deadline.dispose(); }
  }
  readonly runtime: NarrativeWorld;
  private perceptionCursors = new Map<string, number>();
  private directlyObserved = new Map<string, Set<string>>();
  private pendingReceiptActions = new Map<string, string>();
  private deliveryTails = new Map<string, Promise<void>>();
  async ensureWorld(): Promise<void> {
    const signal = this.maintenanceAbort.signal;
    signal.throwIfAborted();
    await this.runtime.ensure(undefined, undefined, signal);
  }
  /** The resident's portable device remains owned by this instance while travelling.
   * This records no local/remote plot or visitor event and does not grant local LLM authority. */
  async restorePhoneAccess(idempotencyKey: string, options: { signal?: AbortSignal; beforeCommit?: () => boolean } = {}): Promise<PhonePhysicalState> {
    const epoch = this.routeEpoch;
    const signal = options.signal ? AbortSignal.any([this.maintenanceAbort.signal, options.signal]) : this.maintenanceAbort.signal;
    signal.throwIfAborted();
    return this.runtime.restorePhoneAccess(idempotencyKey, { signal, beforeCommit: () => this.routeEpoch === epoch && (options.beforeCommit?.() ?? true) });
  }
  /** Camera grounding is limited to an already delivered physical perception. */
  async cameraScene(): Promise<{ visible: string; appearance: string; actorName: string; observedAt: string }> {
    if (this.remote) throw new Error("正在异世界，当前相机尚不能读取远方世界的可见场景。");
    const cursor = this.perceptionCursors.get("bot") ?? -1;
    const ahead = this.directlyObserved.get("bot");
    const observations = await this.runtime.perceptionsSince("bot", 0);
    const observed = observations.filter(value => value.worldSequence <= cursor || ahead?.has(value.observationId)).at(-1);
    if (!observed?.narrative?.trim()) throw new Error("还没有已交付的可见场景，请先实际看看周围再拍照。");
    return { visible: observed.narrative, appearance: "", actorName: this.botName, observedAt: this.clock.timeLine(observed.observedAt) };
  }
  /** Used after an explicit world reset/reload; old sequence cursors cannot address a new journal. */
  resetPerceptionDelivery(): void { this.perceptionCursors.clear(); this.directlyObserved.clear(); }
  /** Call only after shutdown, when replacing the saved world rather than merely pausing it. */
  resetSessionState(): void {
    this.remoteConsciousnessUnsubscribe?.(); this.remoteConsciousnessUnsubscribe = undefined;
    this.botName = ""; this.dormantSinceTU = null; this.remote = null;
    this.routeEpoch = randomUUID();
    this.resetPerceptionDelivery(); this.pendingReceiptActions.clear(); this.deliveryTails.clear();
  }
  /** Resume after the last known delivered cause, without replaying an entire compressed lifetime. */
  async restorePerceptions(actorId: string, deliver: (content: string) => void, knownSourceIds: string[] = []): Promise<void> {
    const signal = this.maintenanceAbort.signal; signal.throwIfAborted();
    const observations = await this.runtime.perceptionsSince(actorId, 0); signal.throwIfAborted();
    const known = new Set(knownSourceIds);
    let anchor = -1;
    for (let i = 0; i < observations.length; i++) {
      const roots = observations[i]!.sourceEventIds;
      if (roots.length && roots.every(id => known.has(id))) anchor = i;
    }
    if (anchor >= 0) {
      this.perceptionCursors.set(actorId, observations[anchor]!.worldSequence);
      await this.publishActor(actorId, deliver);
      return;
    }
    // A migrated world may have no matching source IDs in the old Bot archive. Its saved current
    // view is a safe baseline; replaying every old scene would turn a summary into repeated life.
    const latest = observations.at(-1) ?? await this.runtime.latestObservation(actorId);
    signal.throwIfAborted();
    if (latest) {
      deliver(JSON.stringify({ recovered: true, observation: latest }));
      this.perceptionCursors.set(actorId, latest.worldSequence);
    }
  }
  async observe(actorId = "bot", args: {intent?: string; target?: string; modality?: string} = {}): Promise<WorldObservation> {
    const lifetime = this.maintenanceAbort.signal; lifetime.throwIfAborted();
    if (this.remote && actorId === "bot") {
      if (!this.remote.observe) throw new Error("远方世界不支持主动观察");
      return this.remote.observe(args);
    }
    const observation = await this.runtime.observe(actorId, args); lifetime.throwIfAborted();
    // A concurrently committed passive event may precede this observation. Acknowledge only
    // this exact result; advancing the entire cursor here would silently drop that earlier event.
    const observed = this.directlyObserved.get(actorId) ?? new Set<string>();
    observed.add(observation.observationId); this.directlyObserved.set(actorId, observed);
    await this.publishAll(actorId);
    return observation;
  }
  private visitorId(v: VisitorRef): string { return "visitor:" + (v.id ?? v.name); }
  /** Read already committed perceptions; passive delivery must never invoke observe or the model. */
  private async publishActor(actorId: string, deliver: (content: string) => void | Promise<void>, receipt?: string, currentRoute: () => boolean = () => true): Promise<void> {
    const signal = this.maintenanceAbort.signal; signal.throwIfAborted();
    const prior = this.deliveryTails.get(actorId) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      let receiptObservation: NarrativeObservation | undefined;
      if (receipt) {
        try { const parsed = JSON.parse(receipt); receiptObservation = parsed.observation ?? parsed; } catch { /* preserve a readable remote/error receipt below */ }
      }
      const cursor = this.perceptionCursors.get(actorId) ?? 0;
      const deliveredAhead = this.directlyObserved.get(actorId) ?? new Set<string>();
      this.directlyObserved.set(actorId, deliveredAhead);
      const deliverReceipt = async () => {
        if (!receipt) return;
        await deliver(receipt);
        if (receiptObservation?.actorId === actorId && receiptObservation.worldSequence > (this.perceptionCursors.get(actorId) ?? 0)) deliveredAhead.add(receiptObservation.observationId);
      };
      // Do not fill a departed actor's stream with unread ambient scenes from the old
      // world. Its own committed action still needs an honest, route-tagged receipt.
      if (!currentRoute()) { await deliverReceipt(); return; }
      const pending = await this.runtime.perceptionsSince(actorId, cursor); signal.throwIfAborted();
      if (!currentRoute()) { await deliverReceipt(); return; }
      let receiptDelivered = false;
      let waitingForReceipt = false;
      for (const observation of pending) {
        if (!currentRoute()) break;
        const isReceipt = receiptObservation?.observationId === observation.observationId;
        const wasObserved = deliveredAhead.delete(observation.observationId);
        // An action is delivered through its tool call so puppet/avatar agency and the full
        // acknowledgement remain intact. A simultaneous heartbeat must not publish it early.
        const ownedByAction = observation.scene?.actionId && this.pendingReceiptActions.get(observation.scene.actionId) === actorId;
        if (ownedByAction && !wasObserved && !isReceipt) { waitingForReceipt = true; continue; }
        if (isReceipt || (!wasObserved && !ownedByAction)) await deliver(isReceipt ? receipt! : JSON.stringify(observation));
        if (isReceipt) receiptDelivered = true;
        if (waitingForReceipt) deliveredAhead.add(observation.observationId);
        else this.perceptionCursors.set(actorId, observation.worldSequence);
      }
      // A retried action still needs its execution acknowledgement even when the underlying
      // perception was already delivered. Stable source IDs prevent it becoming new evidence.
      if (receipt && !receiptDelivered) {
        await deliverReceipt();
      }
    });
    this.deliveryTails.set(actorId, run);
    try { await run; } finally { if (this.deliveryTails.get(actorId) === run) this.deliveryTails.delete(actorId); }
  }
  private async publishAll(skipActor?: string, botDeliver = this.hostBotDeliver): Promise<void> {
    if (!this.remote && botDeliver && skipActor !== "bot") await this.publishActor("bot", botDeliver);
    for (const visitor of this.visitorsProvider?.() ?? []) {
      const actorId = this.visitorId(visitor);
      if (actorId === skipActor) continue;
      try { await this.publishActor(actorId, visitor.deliver); }
      catch (error) { this.logger.warn("访客感知交付失败: %s", error); }
    }
  }
  /** 元数据生成与记忆维护的队列；世界裁定由 runtime 独立串行。 */
  private queue: { fn: () => Promise<unknown>; priority: number; cancelKey?: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  private draining = false;
  private drainTask?: Promise<void>;
  private pending = 0;
  /**
   * 穿越：Bot 当前所在的远方世界。设置后，act 裁定 / wait 补叙 / 查看时间 /
   * 世界查询全部转发给所在世界处理（本地 World-LLM 不再参与世界模拟，
   * 只保留上下文压缩等 Bot 私有的记忆工作）；本地 Tingle 静默。
   */
  private remote: RemoteWorldLink | null = null;
  private remoteConsciousnessUnsubscribe?: () => void;
  /** The service selects local/remote authority synchronously when this route changes. */
  onConsciousnessRouteChange?: () => void;
  get isTravelling(): boolean { return this.remote != null; }
  get remoteConsciousness(): NarrativeConsciousness | undefined { return this.remote?.consciousness; }
  /** Changes even for home -> elsewhere -> home; object equality alone misses that round trip. */
  private routeEpoch = randomUUID();
  /** 穿越服务注册的在场访客和定向感知通道。 */
  private visitorsProvider: (() => PresentVisitor[]) | null = null;
  /** service 注册的常驻 Bot 实时感知通道。 */
  private hostBotDeliver: ((content: string) => void) | null = null;
  /** 常驻 Bot 的身份名字缓存，供接管入口区分常驻角色与独立访客。 */
  private botName = "";
  /** 供 service/BotContext 读取的常驻 Bot 名字（可能为空=尚未判定） */
  get residentBotName(): string {
    return this.botName;
  }
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
    if (this.remote === link) return;
    this.remoteConsciousnessUnsubscribe?.(); this.remoteConsciousnessUnsubscribe = undefined;
    this.routeEpoch = randomUUID();
    this.remote = link;
    const epoch = this.routeEpoch;
    this.remoteConsciousnessUnsubscribe = link?.subscribeConsciousness?.(() => {
      if (this.remote === link && this.routeEpoch === epoch) this.onConsciousnessRouteChange?.();
    });
    this.onConsciousnessRouteChange?.();
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
  async wakeDormant(deliver?: (content: string) => void): Promise<boolean> { const since = this.dormantSinceTU; this.dormantSinceTU = null; if (since === null) return false; return this.resolveOfflineGap(since, deliver ?? (() => {})); }

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

  /** 世界启动时：把 meta 里的 botName 刷进内存字段；若还没有（旧世界），从定义补判一次 */
  async ensureBotName(): Promise<void> {
    return this.enqueue(async signal => {
      const meta = await this.files.readMeta(); signal.throwIfAborted();
      if (meta.botName) { this.botName = meta.botName; return; }
      const { botDef } = await this.files.readDefinitions(); signal.throwIfAborted();
      await this.setupBotName(botDef, signal);
    });
  }

  /** 用户手动设置常驻 Bot 名字（WebUI 编辑）：写 meta.json 并刷新内存字段，立即生效 */
  async setBotName(name: string, signal: AbortSignal = this.maintenanceAbort.signal): Promise<void> {
    return this.trackMaintenance(async () => {
      const trimmed = name.trim().slice(0, 64);
      const meta = await this.files.readMeta(); signal.throwIfAborted();
      await this.files.writeMeta({ ...meta, botName: trimmed || undefined });
      signal.throwIfAborted();
      const actor = (await this.runtime.store()).snapshot().actors.bot; signal.throwIfAborted();
      if (trimmed && actor && actor.name !== trimmed) await this.runtime.rename(trimmed, signal);
      signal.throwIfAborted();
      this.botName = trimmed || actor?.name || "";
      this.logger.info("常驻 Bot 名字（用户设置）：%s", trimmed || "（清空）");
    }, signal);
  }

  /**
   * 用户手动改名后，通知 World：这是同一个角色改名（不是新角色），
   * 名字及说明已随 runtime.rename 保存，此处分发身份更正的感知。
   * deliver = 常驻 Bot 的实时事件通道（service 传入）；世界未运行时跳过。
   */
  async notifyBotRename(oldName: string, newName: string, deliver: (content: string) => void): Promise<void> { await this.publishAll(undefined, deliver); }

  constructor(
    private cfg: WorldModelConfig,
    private files: WorldFiles,
    private clock: WorldClock,
    private logger: Logger,
    private prompts: Prompts,
    /** 手机外观与首次补全选项（来自 apps 配置） */
    private phoneCfg: { resolution: string; generateShell: boolean } = { resolution: "auto", generateShell: false },
  ) {
    this.client = new ChatClient({
      apiType: cfg.apiType,
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey || undefined,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      disableThinking: cfg.disableThinking,
      stream: cfg.stream,
      label: "World",
    });
    // The lock owns the provider promise, not an abortable wrapper. Reset may settle
    // its caller promptly; only a provider ignoring cancellation can keep later
    // same-origin inference queued until its request ends or times out.
    this.runtime = new NarrativeWorld(files, clock, async (messages, tools, signal, options) => {
      const deadline = new WorldDeadline(cfg.actionTimeoutMs, signal ?? this.maintenanceAbort.signal, "WORLD_REQUEST_TIMEOUT");
      const responseFormat = cfg.responseFormat ?? "json_schema";
      const proposalMaxTokens = Number.isFinite(cfg.proposalMaxTokens) && cfg.proposalMaxTokens! > 0 ? cfg.proposalMaxTokens! : 2048;
      const maxTokens = Number.isFinite(cfg.maxTokens) && cfg.maxTokens > 0 ? Math.min(cfg.maxTokens, proposalMaxTokens) : proposalMaxTokens;
      try {
        const result = await abortable(withEndpointLock(cfg.baseURL,
          () => this.client.complete(messages, { signal: deadline.signal, maxTokens,
            ...(responseFormat === "tool" ? { tools, toolChoice: { type: "function" as const, function: { name: "resolve_world" } } }
              : { responseFormat, responseSchema: { name: "world_resolution", schema: responseFormat === "json_schema"
                ? worldGenerationSchema(tools[0]!.function.parameters) : tools[0]!.function.parameters } }),
          }), deadline.signal, { priority: options?.background ? "background" : "interactive", onTiming: options?.onEndpointTiming }), deadline.signal);
        deadline.signal.throwIfAborted();
        return result;
      } finally { deadline.dispose(); }
    }, prompts, { heartbeatTimeoutMs: cfg.heartbeatTimeoutMs, actionTimeoutMs: cfg.actionTimeoutMs, responseFormat: cfg.responseFormat });
    this.runtime.phoneAuthorityProvider = () => this.remote === null;
  }

  /**
   * 维护任务入队。priority 越大越靠前，同优先级保持先后顺序。
   * 保留维护任务的文件写入及分段依赖顺序，只在单次模型请求期间占用端点。
   * 所有阶段使用入队时的取消信号；停止后不能借用下一轮的信号继续。
   */
  private enqueue<T>(fn: (signal: AbortSignal) => Promise<T>, priority = 0, cancelKey?: string, signal = this.maintenanceAbort.signal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    this.pending++;
    return abortable(new Promise<T>((resolve, reject) => {
      const wrapped = async () => {
        try { return await this.trackMaintenance(() => fn(signal), signal); }
        finally { this.pending--; }
      };
      const entry = {
        fn: wrapped as () => Promise<unknown>,
        priority,
        cancelKey,
        resolve: (v: unknown) => resolve(v as T),
        reject,
      };
      if (priority > 0) {
        // 插到第一个优先级严格低于自己的任务之前（同优先级保持 FIFO）
        const idx = this.queue.findIndex((t) => t.priority < priority);
        if (idx === -1) this.queue.push(entry);
        else this.queue.splice(idx, 0, entry);
      } else {
        this.queue.push(entry);
      }
      if (!this.draining) this.drainTask = this.drain();
    }), signal);
  }

  /**
   * 访客离开时中止其尚未提交结果的行动；已经提交的世界事实不能回滚。
   */
  cancelPending(cancelKey: string): void { this.runtime.cancel(cancelKey.startsWith('visitor:') ? cancelKey : 'visitor:' + cancelKey); }

  /** 串行排空写队列（队头优先，高优先任务已在队头） */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
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

  // ---------- 对外任务 ----------

  /** Deliver each committed action stage promptly; future completion stays on the world clock. */
  async adjudicateAct(call: ToolCallRecord, deliver: (content: string, route?: WorldActDeliveryRoute) => void | Promise<void>, signal?: AbortSignal, beforeCommit?: (phase: "start" | "finish") => boolean): Promise<boolean> {
    const lifetime = this.maintenanceAbort.signal; lifetime.throwIfAborted();
    const remote = this.remote, epoch = this.routeEpoch, worldName = remote?.worldName ?? null;
    const currentRoute = () => this.routeEpoch === epoch;
    const routedDeliver = (content: string) => deliver(content, { epoch, worldName, current: currentRoute() });
    // A route change revokes new physical commits, but not delivery of a result already
    // saved. NarrativeWorld checks this at each start/finish durable commit boundary.
    const routedBeforeCommit = (phase: "start" | "finish") => currentRoute() && (beforeCommit?.(phase) ?? true);
    if (remote) return remote.adjudicateAct(call, routedDeliver, signal, () => routedBeforeCommit("finish"));
    const actionId = `bot:${call.id}`;
    this.pendingReceiptActions.set(actionId, "bot");
    try {
      const ok = await this.runtime.act("bot", call, async content => {
        lifetime.throwIfAborted();
        await this.publishActor("bot", routedDeliver, content, currentRoute);
        await this.publishAll("bot");
      }, signal, routedBeforeCommit);
      lifetime.throwIfAborted();
      await this.publishAll("bot");
      return ok;
    } catch (error) {
      // Detailed world diagnostics can contain entities or attributes the actor cannot see.
      this.logger.warn("动作裁定失败 (%s): %s", call.id, error);
      throw new Error(`行动“${String(call.arguments.description ?? "")}”未完成或被取消；当前结果未确认。诊断已记录。`);
    } finally { this.pendingReceiptActions.delete(actionId); }
  }

  /** 等待结束时补交已保存而未送达的感知，不调用模型制造等待经历。 */
  async resolveWait(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean> {
    if (this.remote) return this.remote.resolveWait(call, deliver);
    await this.publishActor("bot", deliver); return true;
  }

  /** 主动查看时间：由世界裁定它此刻能否得知时间（允许失败）。只读任务，走并行队列 */
  async resolveCheckTime(deliver: (content: string) => void): Promise<boolean> {
    if (this.remote) return this.remote.resolveCheckTime(deliver);
    deliver(JSON.stringify(await this.observe("bot", { target: "看看当前可见的物理钟表能否读出时间；没有可见钟表就说明无法得知。", modality: "sight" }))); return true;
  }

  /** Tingle：仅把已校验并保存的演化报告为提交；安静和主动让位分别返回。 */
  async tingle(deliver: (content: string) => void): Promise<HeartbeatResult> {
    const lifetime = this.maintenanceAbort.signal; lifetime.throwIfAborted();
    if (this.remote && !(this.visitorsProvider?.().length)) { this.notePresenceChange(); return { status: "yielded", reason: "常驻角色在异世界，当前无访客" }; }
    const result = await this.runtime.evolve("世界心跳：按实际经过的世界时间演化外部环境、天气与NPC生活，保留仍有关联的进展和远处事件。受控角色不是本轮行动者，不续写其自主决定或推进待完成行动；本轮真实外因可造成身体变化。已明确asleep且不属于待结算行动的既定睡眠，也可按真实经过自然结束，记录原因并更新awake；不能从rest、躺下或夜色猜测睡眠，昏迷恢复须有既定条件或真实外因。只向真正感知到新变化的角色投递相应片段，远处或未注意到的经过只记入externalChanges，影响后续的事实还须更新worldState。没有合理变化时保持安静，不制造冲突、奇遇或重复旧场景，不必每轮提供建议。", { heartbeat: true });
    lifetime.throwIfAborted();
    await this.publishAll(undefined, deliver); return result;
  }

  /** 补叙离线期间的自然演化，向恢复连接的角色交付当前可感知变化。 */
  async resolveOfflineGap(fromTU: number, deliver: (content: string) => void): Promise<boolean> {
    const lifetime = this.maintenanceAbort.signal; lifetime.throwIfAborted();
    await this.runtime.evolve('结算离线期间的外部世界：fromTU=' + fromTU + '，现在=' + this.clock.now() + '。天气、环境、NPC与远处事件可以发展并保存。不能替受控角色编造决定、行动、发言或主观经历，不结算其待完成行动。真实外因可改变身体；已明确asleep且不属于待结算行动的既定睡眠，可按真实经过自然结束并更新awake，仍需登记原因。离线、rest或夜色不证明睡眠，昏迷恢复须有既定条件或真实外因。只把恢复感知时实际可知的新变化送给角色，远处和未知经过只保存于externalChanges，影响后续的事实还须更新worldState。');
    lifetime.throwIfAborted();
    await this.publishAll(undefined, deliver); return true;
  }

  /**
   * 世界查询：仅基于角色观测进行无工具的只读呈现，返回文本回答。
   * 仅解释角色最近已经知道的内容；虚构应用既有记录另走 observeVirtualApp。
   * Bot 在异世界作客时转发给所在世界（它的手机连的是那个世界的"互联网"）。
   */
  async query(task: string): Promise<string> {
    if (this.remote) return this.remote.query(task);
    return this.queryLocal(task);
  }

  /** Only explicitly virtual app branches use this entry; real device tools keep their own IO. */
  async observeVirtualApp(task: string, actorId = "bot"): Promise<RichText> {
    if (this.remote && actorId === "bot") {
      if (!this.remote.observeVirtualApp) throw new Error("当前所在地的应用暂不支持读取这项内容。");
      return this.remote.observeVirtualApp(task);
    }
    const observation = await this.runtime.observeVirtualApp(actorId, task);
    // The caller's device-control gate decides who may perceive this read (including stealth).
    // Do not update world perceptions or publish it. Re-peeking could also substitute an NPC event.
    return { text: observation.narrative, originEventIds: observation.sourceEventIds.slice() };
  }

  /** 本地世界查询（穿越服务处理访客 query 时用，绕过远程路由防止转发链） */
  private async queryLocal(task: string): Promise<string> {
    return this.presentQuery("bot", task);
  }

  private async presentQuery(actorId: string, task: string): Promise<string> {
    const signal = AbortSignal.any([AbortSignal.timeout(60_000), this.maintenanceAbort.signal]);
    signal.throwIfAborted();
    const observation = await this.runtime.query(actorId, task);
    signal.throwIfAborted();
    const result = await withEndpointLock(this.cfg.baseURL, () => this.client.complete([
      { role: "system", content: this.prompts.world.presentationSystem },
      { role: "user", content: observation },
    ], { signal }), signal);
    signal.throwIfAborted();
    if (!result.content.trim() || result.toolCalls.length) throw new Error("只读呈现失败");
    return result.content;
  }

  async executeAppAction(intent: string, actorId = "bot", signal?: AbortSignal): Promise<RichText> {
    if (this.remote && actorId === "bot") {
      if (!this.remote.executeVirtualApp) throw new Error("当前所在地的应用暂不支持这项操作。");
      return this.remote.executeVirtualApp(intent, signal);
    }
    // App output is private until the existing BotAgent device gate chooses to perceive it.
    return this.runtime.executeVirtualApp(actorId, intent, signal);
  }

  /** 访客到达：生成到达场景（deliver 送达访客）并记录进 World_Status */
  async visitorArrive(v: VisitorRef, deliver: (content: string) => void, signal?: AbortSignal): Promise<boolean> {
    const lifetime = this.maintenanceAbort.signal; lifetime.throwIfAborted();
    const actorId = this.visitorId(v);
    await this.runtime.arrive(actorId, v.name, v.persona, signal); lifetime.throwIfAborted();
    await this.publishActor(actorId, deliver);
    await this.publishAll(actorId); return true;
  }

  /** 独立访客离场；常驻角色的扮演/操纵由控制会话管理，不进入此路径。 */
  async visitorLeave(v: VisitorRef): Promise<boolean> {
    const signal = this.maintenanceAbort.signal; signal.throwIfAborted();
    await this.runtime.leave(this.visitorId(v)); signal.throwIfAborted();
    await this.publishAll(this.visitorId(v)); return true;
  }

  /** Lifecycle teardown only: the caller closes the session and joins its tasks first. */
  async disconnectVisitor(v: VisitorRef): Promise<void> {
    await this.runtime.disconnectVisitor(this.visitorId(v));
  }

  /** 裁定访客的 act 动作（时刻按本世界时钟换算） */
  async visitorAct(v: VisitorRef, desc: string, duration: number, deliver: (content: string) => void, signal?: AbortSignal, taskId?: string, options: { speech?: string; target?: string } = {}, beforeCommit?: (phase: "start" | "finish") => boolean): Promise<boolean> {
    const lifetime = this.maintenanceAbort.signal; lifetime.throwIfAborted();
    const actorId = this.visitorId(v);
    const at = this.clock.now();
    const callId = taskId ?? randomUUID(), actionId = `${actorId}:${callId}`;
    this.pendingReceiptActions.set(actionId, actorId);
    try {
      const ok = await this.runtime.act(actorId, { id: callId, name: 'act', role: 'world', arguments: { description: desc, ...options }, duration, issuedAt: at, expectedAt: at + duration }, async content => {
        lifetime.throwIfAborted();
        await this.publishActor(actorId, deliver, content);
        await this.publishAll(actorId);
      }, signal, beforeCommit);
      lifetime.throwIfAborted();
      await this.publishAll(actorId);
      return ok;
    } catch (error) {
      this.logger.warn("访客动作裁定失败 (%s): %s", v.id, error);
      throw new Error(`行动“${desc}”未完成或被取消；当前结果未确认。`);
    } finally { this.pendingReceiptActions.delete(actionId); }
  }

  /** 访客 wait 补叙 */
  async visitorWait(v: VisitorRef, n: number, deliver: (content: string) => void, signal?: AbortSignal, taskId?: string, options: { speech?: string; target?: string } = {}): Promise<boolean> { return this.visitorAct(v, "保持当前位置等待，不代替角色决定其他行为。", n, deliver, signal, taskId, options); }

  /** 访客查看时间（按本世界的时钟与历法） */
  async visitorCheckTime(v: VisitorRef, deliver: (content: string) => void): Promise<boolean> { deliver(JSON.stringify(await this.observe(this.visitorId(v), { target: "看看当前可见的时钟能否读出时间；没有可见钟表就说明无法得知。", modality: "sight" }))); return true; }

  /** 访客的世界查询（天气 / 虚构网页等——访客的手机连的是这个世界的"互联网"） */
  async visitorQuery(v: VisitorRef, task: string): Promise<string> { return this.presentQuery(this.visitorId(v), task); }

  // ---------- 创世 ----------

  /** 创世判定：这个世界是否是现实地球世界（决定天气应用查真实天气还是生成） */
  private async assessRealWorld(worldDef: string, signal: AbortSignal): Promise<boolean | null> {
    const system = this.prompts.world.assessRealWorldSystem;
    const user = fill(this.prompts.world.assessRealWorldUser, { worldDef });
    const result = await this.maintenanceComplete([
      { role: "system", content: system },
      { role: "user", content: user },
    ], signal);
    const parsed = extractJson(result.content) as Record<string, unknown> | null;
    return parsed && typeof parsed.real_world === "boolean" ? parsed.real_world : null;
  }

  /** 创世第一步：判定世界性质并持久化（天气应用等依赖它区分现实/虚构） */
  private async assessBotName(botDef: string, signal: AbortSignal): Promise<string | null> {
    const system = this.prompts.world.assessBotNameSystem;
    const user = fill(this.prompts.world.assessBotNameUser, { botDef });
    const result = await this.maintenanceComplete([
      { role: "system", content: system },
      { role: "user", content: user },
    ], signal);
    const parsed = extractJson(result.content) as Record<string, unknown> | null;
    const name = parsed && typeof parsed.name === "string" ? parsed.name.trim() : "";
    return name || null;
  }

  private async setupWorldMeta(worldDef: string, signal: AbortSignal): Promise<void> {
    let real: boolean | null = null;
    try {
      real = await this.assessRealWorld(worldDef, signal);
    } catch (err) {
      signal.throwIfAborted();
      this.logger.warn("世界性质判定调用失败: %s", err);
    }
    // 判定失败时回退：与现实时间同步的世界更可能是现实设定
    const realWorld = real ?? this.clock.syncRealTime;
    if (real === null) this.logger.warn("World-LLM 未能判定世界性质，按 %s 处理", realWorld ? "现实世界" : "虚构世界");
    const meta = await this.files.readMeta(); signal.throwIfAborted();
    await this.files.writeMeta({ ...meta, realWorld });
    this.logger.info("世界性质：%s", realWorld ? "现实地球世界" : "虚构世界");
  }

  /** 创世/改定义：从 Bot_Definition 判定常驻 Bot 名字并持久化到 meta.json（供访客 prompt 硬区分） */
  private async setupBotName(botDef: string, signal: AbortSignal): Promise<void> {
    let name: string | null = null;
    try {
      name = await this.assessBotName(botDef, signal);
    } catch (err) {
      signal.throwIfAborted();
      this.logger.warn("Bot 名字判定调用失败: %s", err);
    }
    const meta = await this.files.readMeta(); signal.throwIfAborted();
    if (name) {
      await this.files.writeMeta({ ...meta, botName: name });
      this.botName = name;
      this.logger.info("常驻 Bot 名字（判定）：%s", name);
    } else {
      this.logger.warn("Bot_Definition 中未识别出明确名字，botName 保持 %s", meta.botName ?? "空");
    }
  }

  /** 创世：依据世界定义与用户设定的初始时刻，生成世界的历法 */
  private async setupCalendar(worldDef: string, signal: AbortSignal): Promise<void> {
    let spec: CalendarSpec | null = null;
    try {
      spec = await this.generateCalendar(worldDef, signal);
    } catch (err) {
      signal.throwIfAborted();
      this.logger.warn("历法生成调用失败: %s", err);
    }
    if (!spec) {
      if (parseGregorianEpoch(this.clock.configuredEpoch) === null) throw new Error("未能建立符合配置初始时刻的历法；创世尚未生成状态，请检查世界定义和初始时刻后重试。不会用默认公历日期替代作者的自定义纪年。");
      this.logger.warn("World-LLM 未能生成有效的历法规格，使用配置明确给出的公历初始时刻");
      spec = gregorian(this.clock.configuredEpoch);
    }
    // An explicit Gregorian epoch is a configuration value, not a model decision.
    // Keep authored custom calendars intact: an ISO-looking input alone cannot disprove
    // a custom calendar explicitly required by the world definition.
    if (spec.kind === "gregorian" && parseGregorianEpoch(this.clock.configuredEpoch) !== null) spec = gregorian(this.clock.configuredEpoch);
    signal.throwIfAborted();
    await this.clock.setCalendar(spec);
    signal.throwIfAborted();
    this.logger.info("世界历法：%s；创世时刻 %s", describeCalendar(spec), this.clock.clockString(0));
  }

  /**
   * 创世只补全缺失的手机外观，已有 HTML 与规格跨重置复用。
   * 用户预先写入的非空 HTML 也保留，不根据新世界定义擅自重绘。
   * 首次生成失败不阻塞创世，浏览器仍可使用内置外壳。
   */
  private async setupPhone(botDef: string, worldDef: string, signal: AbortSignal): Promise<void> {
    const wantAuto = (this.phoneCfg.resolution || "auto").trim().toLowerCase() === "auto";
    const wantShell = this.phoneCfg.generateShell;
    if (!wantAuto && !wantShell) return;

    const meta = await this.files.readMeta();
    const savedShell = await this.files.readPhoneShell(); signal.throwIfAborted();
    let res = resolvePhoneResolution(this.phoneCfg.resolution, meta);
    const hasSpec = Number.isFinite(Number(meta.phone?.width)) && Number(meta.phone?.width) > 0
      && Number.isFinite(Number(meta.phone?.height)) && Number(meta.phone?.height) > 0;

    if (wantAuto && !hasSpec && !savedShell.trim()) {
      try {
        const spec = await this.generatePhoneSpec(botDef, worldDef, signal);
        if (spec) {
          res = spec;
          this.logger.info("手机屏幕分辨率（创世判定）：%dx%d", spec.width, spec.height);
        } else {
          this.logger.warn("World-LLM 未能给出有效的手机分辨率，使用默认 %dx%d", res.width, res.height);
        }
      } catch (err) {
        signal.throwIfAborted();
        this.logger.warn("手机分辨率判定调用失败: %s", err);
      }
      signal.throwIfAborted();
      // Read again when committing only the phone field; do not restore a stale metadata snapshot.
      const currentMeta = await this.files.readMeta(); signal.throwIfAborted();
      await this.files.writeMeta({ ...currentMeta, phone: res });
    }

    if (wantShell && !savedShell.trim()) {
      try {
        await this.generateAndSavePhoneShell(botDef, worldDef, res, signal);
      } catch (err) {
        signal.throwIfAborted();
        this.logger.warn("手机外壳生成调用失败: %s", err);
      }
    }

    signal.throwIfAborted();
  }

  /** Independent appearance maintenance: the service supplies its lifecycle signal,
   * so a paused/uncreated world stays paused and no narrative/context is touched.
   * The maintenance queue keeps read/generate/compare/write serialized; the endpoint
   * is owned only by the model request. Shutdown still joins already-started writes. */
  async regeneratePhoneShell(signal: AbortSignal): Promise<{ content: string; phone: PhoneResolution }> {
    return this.enqueue(async () => {
      const { botDef, worldDef } = await this.files.readDefinitions();
      signal.throwIfAborted();
      if (!botDef.trim() || !worldDef.trim() || botDef.includes("（尚未编写）") || worldDef.includes("（尚未编写）")) {
        throw new Error("请先填写角色定义与世界规则，再生成手机与浏览器外壳；无需先创建世界。");
      }
      const phone = resolvePhoneResolution(this.phoneCfg.resolution, await this.files.readMeta());
      signal.throwIfAborted();
      const content = await this.generateAndSavePhoneShell(botDef, worldDef, phone, signal);
      return { content, phone };
    }, 0, undefined, signal);
  }

  private async generateAndSavePhoneShell(botDef: string, worldDef: string, res: PhoneResolution, signal: AbortSignal): Promise<string> {
    const previous = await this.files.readPhoneShell(); signal.throwIfAborted();
    const html = await this.generatePhoneShell(botDef, worldDef, res, signal);
    signal.throwIfAborted();
    if (!html) throw new Error("World LLM 未返回有效的外壳 HTML（需包含 {{screen}}）；原外壳已保留。");
    if (await this.files.readPhoneShell() !== previous) throw new Error("生成期间外壳文件已被修改，本次结果未覆盖当前文件，请重试。");
    signal.throwIfAborted();
    await this.files.writePhoneShell(html);
    this.logger.info("手机与浏览器外壳已生成（%d 字符，存于 phoneShell.html）", html.length);
    return html;
  }

  private async generatePhoneSpec(botDef: string, worldDef: string, signal: AbortSignal): Promise<PhoneResolution | null> {
    const result = await this.maintenanceComplete([
      { role: "system", content: this.prompts.world.phoneSpecSystem },
      { role: "user", content: fill(this.prompts.world.phoneSpecUser, { botDef, worldDef }) },
    ], signal);
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
    signal: AbortSignal,
  ): Promise<string | null> {
    const result = await this.maintenanceComplete([
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
    ], signal);
    const html = extractHtml(result.content);
    // 必须保留 {{screen}} 占位符才能合成；不合格则弃用（退回内置外壳）
    return !result.toolCalls.length && html && html.includes("{{screen}}") ? html : null;
  }

  private async generateCalendar(worldDef: string, signal: AbortSignal): Promise<CalendarSpec | null> {
    const system = this.prompts.world.generateCalendarSystem + "\n配置的初始时刻是T=0锚点，作者定义决定历法规则。不得把作者指定的过去或未来改成现实今天，不得自行改写明确的公历日期；自定义纪年必须按作者与配置解析。世界是否连接现实应用不决定历法或时间同步模式。";
    const user = fill(this.prompts.world.generateCalendarUser, {
      worldDef,
      epoch: this.clock.configuredEpoch,
      unitWorldSeconds: this.clock.unitWorldSeconds,
    });
    const result = await this.maintenanceComplete([
      { role: "system", content: system },
      { role: "user", content: user },
    ], signal);
    return parseCalendarSpec(extractJson(result.content));
  }

  /** 初始化世界性质、历法与初始状态；最后仅按需补全缺失的手机外观。 */
  async initialize(botDef: string, worldDef: string): Promise<void> {
    const signal = this.maintenanceAbort.signal;
    return this.trackMaintenance(async () => {
      // A previous attempt may have committed the world before phone/context setup failed.
      // Completing that attempt must not roll its calendar or world classification again.
      const initialized = (await this.runtime.store()).snapshot().initialized;
      signal.throwIfAborted();
      if (!initialized) {
        await this.enqueue(s => this.setupWorldMeta(worldDef, s), 0, undefined, signal);
        signal.throwIfAborted();
        if (!this.clock.syncRealTime) await this.enqueue(s => this.setupCalendar(worldDef, s), 0, undefined, signal);
      }
      signal.throwIfAborted();
      await this.runtime.ensure(botDef, worldDef, signal);
      signal.throwIfAborted();
      const store = await this.runtime.store(); signal.throwIfAborted();
      await this.setBotName(store.snapshot().actors.bot!.name, signal);
      await this.enqueue(s => this.setupPhone(botDef, worldDef, s), 0, undefined, signal);
      signal.throwIfAborted();
    }, signal);
  }

  /** 用户修改了定义文件：世界据此调整状态，并告知 Bot 能感知到的变化 */
  async reconcileDefinitions(botDef: string, worldDef: string, deliver: (content: string) => void): Promise<void> {
    const lifetime = this.maintenanceAbort.signal; lifetime.throwIfAborted();
    await this.runtime.evolve('管理员更新世界定义。只应用与现有状态兼容的环境变化，不重写角色记忆、已发生事件或身份。定义=' + JSON.stringify({botDef, worldDef}));
    lifetime.throwIfAborted();
    await this.publishAll(undefined, deliver);
  }

  // ---------- 上下文压缩（rest 时由 World-LLM 执行） ----------

  async compress(input: {
    persona: string;
    historySummary: string;
    memoryDigest: string;
    streamText: string;
    timeLine: string;
    chatAccounts?: string;
  }): Promise<CompressionResult> {
    return this.enqueue(async signal => {
      // 输入长度防护：意识流超过单次上限时不再丢弃最早内容，而是按时间序
      // 切成多段、分次总结——每一轮都把上一轮产出的摘要作为"旧摘要"续喂，
      // 一口一口把整段意识流吃完（map-reduce 式滚动压缩）。
      const cap = this.cfg.compressMaxInputChars;
      let chunks =
        cap > 0 && input.streamText.length > cap
          ? splitByLines(input.streamText, cap)
          : [input.streamText];

      if (chunks.length > MAX_COMPRESS_PASSES) {
        throw new Error(`压缩需要 ${chunks.length} 段，超过单次上限 ${MAX_COMPRESS_PASSES}；保留全部原始经历，请提高 compressMaxInputChars。`);
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

      const configuredSystem = this.prompts.world.compressSystem;
      let system = configuredSystem.includes(COMPRESSION_SOURCE_GUIDANCE)
        ? configuredSystem : configuredSystem + "\n\n" + COMPRESSION_SOURCE_GUIDANCE;
      if (!system.includes(COMPRESSION_CHAT_ATTRIBUTION_GUIDANCE)) system += "\n\n" + COMPRESSION_CHAT_ATTRIBUTION_GUIDANCE;
      // 滚动状态：每一轮的产出作为下一轮的输入
      const persona = input.persona;
      let historySummary = input.historySummary;
      let memoryDigest = input.memoryDigest;

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const partHeader =
          chunks.length > 1
            ? `（意识流较长，正分 ${chunks.length} 段按时间顺序逐段沉淀。` +
              `这是第 ${i + 1}/${chunks.length} 段${isLast ? "，也是最近的一段" : "，之后还有更近的经历会继续沉淀"}）\n` +
              ""
            : "";
        const chatAccounts = input.chatAccounts || "未提供账号映射；不能按昵称猜测归属";
        const user = fill(this.prompts.world.compressUser, {
          timeLine: input.timeLine,
          chatAccounts,
          persona,
          historySummary,
          memoryDigest,
          streamText: partHeader + chunks[i],
        }) + (this.prompts.world.compressUser.includes("{{chatAccounts}}") ? "" : `\n\n<chat_accounts>\n${chatAccounts}\n</chat_accounts>`);
        const messages: ChatMessage[] = [
          { role: "system", content: system },
          { role: "user", content: user },
        ];
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await this.maintenanceComplete(messages, signal);
          try {
            const parsed = parseCompression(result.content);
            historySummary = parsed.historySummary;
            memoryDigest = parsed.memoryDigest;
            break;
          } catch (err) {
            // Exactly one format repair; transport errors and aborts propagate directly.
            // No partial result reaches the caller, so its durable snapshot remains intact.
            if (attempt > 0 || signal.aborted) throw err;
            this.logger.warn("压缩第 %d 段格式校验失败，尝试修正一次：%s", i + 1, String(err));
            messages.push({ role: "assistant", content: result.content }, {
              role: "user", content: `${String(err)}\n请依据上面的全部输入重新给出完整的两个标签；只修正输出格式，不添加经历、不丢弃已交付内容。`,
            });
          }
        }
      }
      return { historySummary, memoryDigest };
    });
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

/** Cancel noncooperative model test doubles/transports without letting their late output advance a task. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
