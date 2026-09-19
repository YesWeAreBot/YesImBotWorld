import { randomUUID } from "node:crypto";
import { NarrativeWorld } from "./runtime.js";
import type { NarrativeObservation } from "./narrative-types.js";
import type { WorldObservation } from "./state.js";
import type { Logger } from "koishi";
import { type CalendarSpec, describeCalendar, gregorian, parseCalendarSpec, parseGregorianEpoch } from "../calendar.js";
import type { WorldClock } from "../clock.js";
import type { WorldModelConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import { ChatClient, type ChatMessage } from "../llm/chat.js";
import { parseCompression } from "./compression.js";
import { withEndpointLock } from "../llm/lock.js";
import { extractHtml } from "../apps/html.js";
import {
  clampPhoneResolution,
  DEFAULT_PHONE_RESOLUTION,
  parsePhoneResolution,
  type PhoneResolution,
} from "../phone.js";
import { fill, type Prompts } from "../prompts.js";
import type { CompressionResult, RichText, ToolCallRecord } from "../types.js";
import type { PlayerMode } from "../crossing/protocol.js";
import { debug } from "../webui/debug.js";

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
  adjudicateAct(call: ToolCallRecord, deliver: (content: string) => void, signal?: AbortSignal, beforeCommit?: () => boolean): Promise<boolean>;
  observe?(args?: { intent?: string; target?: string; modality?: string }): Promise<WorldObservation>;
  observeVirtualApp?(task: string): Promise<RichText>;
  executeVirtualApp?(task: string, signal?: AbortSignal): Promise<RichText>;
  resolveWait(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean>;
  resolveCheckTime(deliver: (content: string) => void): Promise<boolean>;
  query(task: string): Promise<string>;
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
  stop(): void { this.maintenanceAbort.abort(); this.runtime.stop(); }
  readonly runtime: NarrativeWorld;
  private perceptionCursors = new Map<string, number>();
  private directlyObserved = new Map<string, Set<string>>();
  private pendingReceiptActions = new Map<string, string>();
  private deliveryTails = new Map<string, Promise<void>>();
  async ensureWorld(): Promise<void> { if (this.maintenanceAbort.signal.aborted) this.maintenanceAbort = new AbortController(); this.runtime.resume(); await this.runtime.ensure(); }
  /** Used after an explicit world reset/reload; old sequence cursors cannot address a new journal. */
  resetPerceptionDelivery(): void { this.perceptionCursors.clear(); this.directlyObserved.clear(); }
  /** Resume after the last known delivered cause, without replaying an entire compressed lifetime. */
  async restorePerceptions(actorId: string, deliver: (content: string) => void, knownSourceIds: string[] = []): Promise<void> {
    const observations = await this.runtime.perceptionsSince(actorId, 0);
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
    if (latest) {
      deliver(JSON.stringify({ recovered: true, observation: latest }));
      this.perceptionCursors.set(actorId, latest.worldSequence);
    }
  }
  async observe(actorId = "bot", args: {intent?: string; target?: string; modality?: string} = {}): Promise<WorldObservation> {
    if (this.remote && actorId === "bot") {
      if (!this.remote.observe) throw new Error("远方世界不支持主动观察");
      return this.remote.observe(args);
    }
    const observation = await this.runtime.observe(actorId, args);
    // A concurrently committed passive event may precede this observation. Acknowledge only
    // this exact result; advancing the entire cursor here would silently drop that earlier event.
    const observed = this.directlyObserved.get(actorId) ?? new Set<string>();
    observed.add(observation.observationId); this.directlyObserved.set(actorId, observed);
    await this.publishAll(actorId);
    return observation;
  }
  private visitorId(v: VisitorRef): string { return "visitor:" + (v.id ?? v.name); }
  /** Read already committed perceptions; passive delivery must never invoke observe or the model. */
  private async publishActor(actorId: string, deliver: (content: string) => void, receipt?: string): Promise<void> {
    const prior = this.deliveryTails.get(actorId) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(async () => {
      let receiptObservation: NarrativeObservation | undefined;
      if (receipt) {
        try { const parsed = JSON.parse(receipt); receiptObservation = parsed.observation ?? parsed; } catch { /* preserve a readable remote/error receipt below */ }
      }
      const cursor = this.perceptionCursors.get(actorId) ?? 0;
      const pending = await this.runtime.perceptionsSince(actorId, cursor);
      const deliveredAhead = this.directlyObserved.get(actorId) ?? new Set<string>();
      this.directlyObserved.set(actorId, deliveredAhead);
      let receiptDelivered = false;
      let waitingForReceipt = false;
      for (const observation of pending) {
        const isReceipt = receiptObservation?.observationId === observation.observationId;
        const wasObserved = deliveredAhead.delete(observation.observationId);
        // An action is delivered through its tool call so puppet/avatar agency and the full
        // acknowledgement remain intact. A simultaneous heartbeat must not publish it early.
        const ownedByAction = observation.scene?.actionId && this.pendingReceiptActions.get(observation.scene.actionId) === actorId;
        if (ownedByAction && !wasObserved && !isReceipt) { waitingForReceipt = true; continue; }
        if (isReceipt || (!wasObserved && !ownedByAction)) deliver(isReceipt ? receipt! : JSON.stringify(observation));
        if (isReceipt) receiptDelivered = true;
        if (waitingForReceipt) deliveredAhead.add(observation.observationId);
        else this.perceptionCursors.set(actorId, observation.worldSequence);
      }
      // A retried action still needs its execution acknowledgement even when the underlying
      // perception was already delivered. Stable source IDs prevent it becoming new evidence.
      if (receipt && !receiptDelivered) {
        deliver(receipt);
        if (receiptObservation?.actorId === actorId && receiptObservation.worldSequence > (this.perceptionCursors.get(actorId) ?? 0)) deliveredAhead.add(receiptObservation.observationId);
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
  private pending = 0;
  /**
   * 穿越：Bot 当前所在的远方世界。设置后，act 裁定 / wait 补叙 / 查看时间 /
   * 世界查询全部转发给所在世界处理（本地 World-LLM 不再参与世界模拟，
   * 只保留上下文压缩等 Bot 私有的记忆工作）；本地 Tingle 静默。
   */
  private remote: RemoteWorldLink | null = null;
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
    const actor = (await this.runtime.store()).snapshot().actors.bot;
    if (trimmed && actor && actor.name !== trimmed) await this.runtime.rename(trimmed);
    this.botName = trimmed || actor?.name || "";
    this.logger.info("常驻 Bot 名字（用户设置）：%s", trimmed || "（清空）");
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
    this.runtime = new NarrativeWorld(files, clock, (messages, tools, signal) => withEndpointLock(cfg.baseURL, () => this.client.complete(messages, {
      tools, signal, toolChoice: { type: "function", function: { name: "resolve_world" } },
    }), signal), prompts);
  }

  /**
   * 串行化执行，避免并发写状态文件。
   * 同时以"整个任务"为粒度持有推理端点锁：当 World-LLM 与 Bot-LLM 共用一个
   * 只能驻留单模型的端点（llama-swap 等换载层）时，任务期间 Bot 的生成请求
   * 排队等待，避免跨模型并发把请求饿死或把推理进程搞崩；不同源时无影响。
   */
  /**
   * 维护任务入队。priority 越大越靠前，同优先级保持先后顺序。
   * 正在执行中的任务不会被抢占（LLM 推理无法安全中断）。
   */
  private enqueue<T>(fn: () => Promise<T>, priority = 0, cancelKey?: string): Promise<T> {
    this.pending++;
    const signal = this.maintenanceAbort.signal;
    return new Promise<T>((resolve, reject) => {
      const wrapped = () =>
        withEndpointLock(this.cfg.baseURL, fn, signal).finally(() => this.pending--);
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
      void this.drain();
    });
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

  /** 裁定 Bot 的 act 动作。产出的事件通过 deliver 交付（由调度器压到期望完成时刻） */
  async adjudicateAct(call: ToolCallRecord, deliver: (content: string) => void, signal?: AbortSignal, beforeCommit?: () => boolean): Promise<boolean> {
    if (this.remote) return this.remote.adjudicateAct(call, deliver, signal, beforeCommit);
    const actionId = `bot:${call.id}`;
    this.pendingReceiptActions.set(actionId, "bot");
    try {
      const receipts: string[] = [];
      const ok = await this.runtime.act("bot", call, content => receipts.push(content), signal, beforeCommit);
      for (const receipt of receipts) await this.publishActor("bot", deliver, receipt);
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

  /** Tingle：世界心跳，推进世界演化。返回 World 为下一次心跳设定的间隔（TU），未设定则返回 null */
  async tingle(deliver: (content: string) => void): Promise<number | null> {
    if (this.remote && !(this.visitorsProvider?.().length)) { this.notePresenceChange(); return null; }
    await this.runtime.evolve("世界心跳：按距离当前状态时刻的实际经过时间，结算自然过程及 NPC 的自主行动。承接正在进行的工作、交谈、等待和角色行动造成的影响，以自然语言写明真正发生的经过，分别向在场角色提供他们实际能感知的新动静。常驻角色及玩家的主动选择由他们自己决定。没有合理变化时保持安静，不强制制造冲突或奇遇，也不要重播旧场景。");
    await this.publishAll(undefined, deliver); return null;
  }

  /** 补叙离线期间的自然演化，向恢复连接的角色交付当前可感知变化。 */
  async resolveOfflineGap(fromTU: number, deliver: (content: string) => void): Promise<boolean> {
    await this.runtime.evolve('结算离线期间自然过程：fromTU=' + fromTU + '，现在=' + this.clock.now() + '。禁止替受控角色编造离线期间的决定、发言或主观经历。只把恢复感知时实际可知的变化送给角色。');
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
    const observation = await this.runtime.query(actorId, task);
    const signal = AbortSignal.any([AbortSignal.timeout(60_000), this.maintenanceAbort.signal]);
    const result = await withEndpointLock(this.cfg.baseURL, () => this.client.complete([
      { role: "system", content: this.prompts.world.presentationSystem },
      { role: "user", content: observation },
    ], { signal }), signal);
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
    const actorId = this.visitorId(v);
    await this.runtime.arrive(actorId, v.name, v.persona, signal);
    await this.publishActor(actorId, deliver);
    await this.publishAll(actorId); return true;
  }

  /** 独立访客离场；常驻角色的扮演/操纵由控制会话管理，不进入此路径。 */
  async visitorLeave(v: VisitorRef): Promise<boolean> { await this.runtime.leave(this.visitorId(v)); await this.publishAll(this.visitorId(v)); return true; }

  /** 裁定访客的 act 动作（时刻按本世界时钟换算） */
  async visitorAct(v: VisitorRef, desc: string, duration: number, deliver: (content: string) => void, signal?: AbortSignal, taskId?: string, options: { speech?: string; target?: string } = {}): Promise<boolean> {
    const actorId = this.visitorId(v);
    const at = this.clock.now();
    const callId = taskId ?? randomUUID(), actionId = `${actorId}:${callId}`;
    this.pendingReceiptActions.set(actionId, actorId);
    try {
      const receipts: string[] = [];
      const ok = await this.runtime.act(actorId, { id: callId, name: 'act', role: 'world', arguments: { description: desc, ...options }, duration, issuedAt: at, expectedAt: at + duration }, content => receipts.push(content), signal);
      for (const receipt of receipts) await this.publishActor(actorId, deliver, receipt);
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
  private async assessRealWorld(worldDef: string): Promise<boolean | null> {
    const system = this.prompts.world.assessRealWorldSystem;
    const user = fill(this.prompts.world.assessRealWorldUser, { worldDef });
    const result = await this.client.complete([
      { role: "system", content: system },
      { role: "user", content: user },
    ], { signal: this.maintenanceAbort.signal });
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
      this.botName = name;
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
      if (parseGregorianEpoch(this.clock.configuredEpoch) === null) throw new Error("未能建立符合配置初始时刻的历法；创世尚未生成状态，请检查世界定义和初始时刻后重试。不会用默认公历日期替代作者的自定义纪年。");
      this.logger.warn("World-LLM 未能生成有效的历法规格，使用配置明确给出的公历初始时刻");
      spec = gregorian(this.clock.configuredEpoch);
    }
    // An explicit Gregorian epoch is a configuration value, not a model decision.
    // Keep authored custom calendars intact: an ISO-looking input alone cannot disprove
    // a custom calendar explicitly required by the world definition.
    if (spec.kind === "gregorian" && parseGregorianEpoch(this.clock.configuredEpoch) !== null) spec = gregorian(this.clock.configuredEpoch);
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
    const system = this.prompts.world.generateCalendarSystem + "\n配置的初始时刻是T=0锚点，作者定义决定历法规则。不得把作者指定的过去或未来改成现实今天，不得自行改写明确的公历日期；自定义纪年必须按作者与配置解析。世界是否连接现实应用不决定历法或时间同步模式。";
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
    if (this.maintenanceAbort.signal.aborted) this.maintenanceAbort = new AbortController();
    this.runtime.resume();
    await this.enqueue(() => this.setupWorldMeta(worldDef));
    if (!this.clock.syncRealTime) await this.enqueue(() => this.setupCalendar(worldDef));
    await this.runtime.ensure(botDef, worldDef);
    await this.setBotName((await this.runtime.store()).snapshot().actors.bot!.name);
    await this.enqueue(() => this.setupPhone(botDef, worldDef));
  }

  /** 用户修改了定义文件：世界据此调整状态，并告知 Bot 能感知到的变化 */
  async reconcileDefinitions(botDef: string, worldDef: string, deliver: (content: string) => void): Promise<void> {
    await this.runtime.evolve('管理员更新世界定义。只应用与现有状态兼容的环境变化，不重写角色记忆、已发生事件或身份。定义=' + JSON.stringify({botDef, worldDef}));
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
    return this.enqueue(async () => {
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

      const system = this.prompts.world.compressSystem;
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
          const result = await this.client.complete(messages, { signal: this.maintenanceAbort.signal });
          try {
            const parsed = parseCompression(result.content);
            historySummary = parsed.historySummary;
            memoryDigest = parsed.memoryDigest;
            break;
          } catch (err) {
            // Exactly one format repair; transport errors and aborts propagate directly.
            // No partial result reaches the caller, so its durable snapshot remains intact.
            if (attempt > 0 || this.maintenanceAbort.signal.aborted) throw err;
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
