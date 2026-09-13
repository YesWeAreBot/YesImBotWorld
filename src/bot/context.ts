import { promises as fs } from "node:fs";
import { appendJsonLine } from "../jsonl.js";
import type { WorldFiles } from "../files.js";
import type { ChatMessage, ChatToolDef, ContentPart } from "../llm/chat.js";
import type { AttachmentLoadFn } from "../media/parts.js";
import { BOT_PROMPT_DEFAULTS, type Prompts } from "../prompts.js";
import type {
  BotEvent,
  CompressionResult,
  RichTextPart,
  PinnedContext,
  StreamEntry,
  ToolCallRecord,
} from "../types.js";
import { renderToolsText } from "./tools.js";
import { canonicalizeArgs } from "./repeatGuard.js";
import { mediaOpen, mediaPart, mediaText, richPartsText } from "../media/presentation.js";

export interface CompressionSnapshot {
  entries: StreamEntry[];
  text: string;
}

interface CompressionCommit {
  pinned: PinnedContext;
  counters: { tool: number; event: number };
  previousStream: StreamEntry[];
  stream: StreamEntry[];
}

interface PinnedPersist {
  pinned: PinnedContext;
  counters: { tool: number; event: number };
  /** Exact provider prefix for this working window. Missing in pre-upgrade archives. */
  rendered?: { systemText: string; nativeToolCalls?: boolean; nativeTools?: ChatToolDef[] };
}

/**
 * Bot-LLM 的上下文。
 *
 * 结构（对应设计中的 Prompt 结构）：
 * - 置顶区（pinned）：角色设定 / 历史压缩 / 工具列表 / 记忆摘要 —— 仅压缩时可变
 * - 工作窗口（stream）：Tool Call 流，由 ToolCall 与 Event 组成 —— 只允许追加
 *
 * 渲染是确定性的追加式结构，保证 text 模式的 KV cache 与 chat 模式的
 * provider 前缀缓存尽可能命中。
 */
export class BotContext {
  pinned: PinnedContext = {
    botDefinition: "",
    persona: "",
    historySummary: "（暂无，你的经历才刚刚开始）",
    toolsText: renderToolsText(),
    memoryDigest: "（暂无长期记忆）",
    updatedAt: 0,
  };
  stream: StreamEntry[] = [];
  /** 附件加载器（chat 模式 + 原生多模态时由 service 注入） */
  attachmentLoader: AttachmentLoadFn | null = null;
  /** 运行时熔断：生成请求 400/413（模型不支持附件/请求体过大）后停用附件注入，避免持续报错 */
  attachmentsDisabled = false;
  /**
   * 最近一次渲染实际注入的附件 content part 类型集合。
   * agent 据此对 400 精准降级：请求里有 video_url / input_audio 时先只关掉对应模态
   * （GIF 会改走拼帧图的 image_url 通道），不殃及正常的图片附件。
   */
  lastAttachmentPartTypes = new Set<string>();
  /** 运行时降级回调（service 注入）：关闭指定模态的附件注入并重建附件缓存 */
  degradeModalities: ((kinds: ("video" | "audio")[]) => void) | null = null;
  /** 单次请求注入的附件总数预算（service 按配置注入；历史附件每次请求都会重发，必须设上限） */
  maxAttachmentsPerRequest = 8;
  /** 单次请求注入的附件总体积预算（base64 后的字符数） */
  maxAttachmentBytesPerRequest = 6 * 1024 * 1024;
  /** Freeze admission and bytes for each event until compression; new images never evict old ones. */
  private mediaWindow = this.newMediaWindow();
  private newMediaWindow() {
    return { events: new Map<string, Promise<ContentPart[]>>(), assets: new Map<string, string>(), count: 0, bytes: 0, exceeded: false };
  }
  /** Ask the runtime to compact before the next generation if new images cannot fit. */
  get attachmentBudgetExceeded(): boolean { return this.mediaWindow.exceeded; }
  /** A rejected immutable media prefix must remain scheduled for compaction even if that attempt fails. */
  requestAttachmentCompaction(): void { this.mediaWindow.exceeded = true; }
  private counters = { tool: 0, event: 0 };
  private toolsText: string;
  private frozenSystemText: string | null = null;
  private frozenNativeTools: ChatToolDef[] | undefined;
  private frozenNativeMode: boolean | undefined;
  private renderedNeedsSave = false;
  private renderingRevision = 0;
  /** Native declarations and rendered messages must start the same committed working window. */
  get windowRevision(): number { return this.renderingRevision; }
  private mutationTail: Promise<void> = Promise.resolve();
  private needsRecovery = true;

  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(async () => {
      if (this.needsRecovery) await this.recoverCompressionUnlocked();
      return run();
    });
    this.mutationTail = next.then(() => {}, () => {});
    return next;
  }

  /** A rejected mutation leaves the queue usable, but an unfinished cutover still blocks generation. */
  async settled(): Promise<void> { await this.mutate(async () => {}); }

  constructor(
    private files: WorldFiles,
    toolsText?: string,
    private prompts?: Prompts,
  ) {
    this.toolsText = toolsText ?? renderToolsText();
    this.pinned.toolsText = this.toolsText;
  }

  /** 最新行为准则；WebUI 覆盖将在下一次建立固定提示块时生效。 */
  private get constitution(): import("../prompts.js").BotPromptSet {
    return this.prompts?.bot ?? BOT_PROMPT_DEFAULTS;
  }

  // ---------- 持久化 ----------

  async load(): Promise<void> {
    return this.mutate(() => this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.files.pinned, "utf8")) as PinnedPersist;
      if (raw.rendered !== undefined && (!raw.rendered || typeof raw.rendered.systemText !== "string" || (raw.rendered.nativeTools !== undefined && !Array.isArray(raw.rendered.nativeTools)) || (raw.rendered.nativeToolCalls !== undefined && typeof raw.rendered.nativeToolCalls !== "boolean"))) {
        throw new Error("已保存的上下文固定前缀损坏，拒绝用新内容覆盖历史窗口");
      }
      this.pinned = raw.pinned;
      this.counters = raw.counters;
      this.frozenSystemText = raw.rendered?.systemText ?? null;
      this.frozenNativeTools = raw.rendered?.nativeTools === undefined ? undefined : structuredClone(raw.rendered.nativeTools);
      this.frozenNativeMode = raw.rendered?.nativeToolCalls ?? (raw.rendered?.nativeTools !== undefined ? true : undefined);
      this.renderedNeedsSave = false;
      // 注意：置顶区保留持久化时的工具列表（保护前缀缓存）。
      // 与当前实际可用工具的差异由 service 层通过 toolsChangeNotice() 以 Event 形式告知 Bot，
      // 置顶列表在下次 rest 压缩（applyCompression）时才同步为当前列表。
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.frozenSystemText = null; this.frozenNativeTools = undefined; this.frozenNativeMode = undefined; this.renderedNeedsSave = false;
      this.pinned.persona = (await this.files.readDefinitions()).botDef;
    }
    // 迁移/兜底：置顶区缺少「最初设定」（旧版 pinned.json 或没有 pinned.json 的旧世界），
    // 首次从定义文件补入并持久化；此后这部分只在创世与压缩（applyCompression）时刷新，
    // 其余时候用户的改动以 Event 告知，保持前缀稳定（保护 KV cache）。
    if (!this.pinned.botDefinition?.trim()) {
      this.pinned.botDefinition = (await this.files.readDefinitions()).botDef;
      await this.persistPinnedUnlocked();
    }
    // Identity is owner-authored; world snapshots are observations, never a system persona.
    this.pinned.persona = this.pinned.botDefinition;
    this.stream = [];
    this.mediaWindow = this.newMediaWindow();
    const raw = await this.files.readText(this.files.stream);
    const seenIds = new Set<string>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as StreamEntry;
        const id = entry.kind === "tool_call" ? entry.call?.id : entry.kind === "event" ? entry.event?.id : undefined;
        if (typeof id !== "string" || !id || seenIds.has(id)) continue;
        seenIds.add(id);
        this.stream.push(entry);
        // A crash between the append and counter save must not reuse an event ID.
        const n = Number(id.match(entry.kind === "tool_call" ? /^tc_(\d+)$/ : /^ev_(\d+)$/)?.[1]);
        if (Number.isSafeInteger(n)) {
          const counter = entry.kind === "tool_call" ? "tool" : "event";
          this.counters[counter] = Math.max(this.counters[counter], n);
        }
      } catch {
        /* 跳过损坏行 */
      }
    }
    this.renderingRevision++;
  }

  async persistPinned(): Promise<void> {
    return this.mutate(() => this.persistPinnedUnlocked());
  }

  private async persistPinnedUnlocked(): Promise<void> {
    const data: PinnedPersist = { pinned: this.pinned, counters: this.counters,
      ...(this.frozenSystemText !== null ? { rendered: { systemText: this.frozenSystemText, ...(this.frozenNativeMode !== undefined ? { nativeToolCalls: this.frozenNativeMode } : {}), ...(this.frozenNativeTools !== undefined ? { nativeTools: this.frozenNativeTools } : {}) } } : {}) };
    await this.files.atomicWrite(this.files.pinned, JSON.stringify(data, null, 2));
    this.renderedNeedsSave = false;
  }

  private async appendEntry(entry: StreamEntry): Promise<void> {
    const id = entry.kind === "tool_call" ? entry.call.id : entry.event.id;
    const existing = this.stream.find(item => item.kind === "tool_call" ? item.call.id === id : item.event.id === id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error(`上下文记录 ${id} 已存在且内容不同，拒绝覆盖历史`);
      return; // The append succeeded earlier but the following pinned/counter save may have failed.
    }
    await appendJsonLine(this.files.stream, entry);
    this.stream.push(entry);
  }

  // ---------- 追加 ----------

  nextToolId(): string {
    return `tc_${++this.counters.tool}`;
  }

  nextEventId(): string {
    return `ev_${++this.counters.event}`;
  }

  async appendToolCall(call: ToolCallRecord): Promise<void> {
    await this.mutate(async () => {
      await this.appendEntry({ kind: "tool_call", call });
      await this.persistPinnedUnlocked();
    });
  }

  async appendEvent(event: BotEvent): Promise<void> {
    await this.mutate(async () => {
      const existing = this.stream.find(entry => entry.kind === "event" && entry.event.id === event.id);
      const stored = { ...event };
      delete stored.contextText;
      delete stored.mediaReuse;
      if (existing?.kind === "event") {
        // A retry after the journal append must reuse the original persisted projection. In
        // particular, an older raw JSON event must never be rewritten just because code upgraded.
        if (existing.event.contextText !== undefined) stored.contextText = existing.event.contextText;
        if (existing.event.mediaReuse !== undefined) stored.mediaReuse = existing.event.mediaReuse;
      } else {
        if (hasEventMedia(event)) stored.mediaReuse = true;
        const call = event.refToolCallId ? this.stream.find(entry => entry.kind === "tool_call" && entry.call.id === event.refToolCallId) : undefined;
        const projected = narrativeContextText(event, call?.kind === "tool_call" ? call.call.name : undefined);
        if (projected !== undefined) stored.contextText = projected;
      }
      await this.appendEntry({ kind: "event", event: stored });
      await this.persistPinnedUnlocked();
    });
  }

  // ---------- 渲染 ----------

  /** TU 换算说明（由 service 按时钟配置注入，如 "1 TU = 1 秒"）。Bot 估算 duration/wait 的锚点 */
  timeInfo = "";
  /** 聊天账号列表提供者（service 注入）：只含 platform:id，保持前缀稳定 */
  accountsProvider: (() => string) | null = null;
  /** 常驻 Bot 名字提供者：只在建立新固定前缀时读取。 */
  botNameProvider: (() => string) | null = null;
  /** wait 工具被移除（service 按 bot.disableWait 注入）：行为准则不再提及等待 */
  waitRemoved = false;

  renderSystemText(timeLine: string, nativeToolCalls = true): string {
    if (this.frozenNativeMode === undefined) { this.frozenNativeMode = nativeToolCalls; this.renderedNeedsSave = true; }
    if (this.frozenSystemText === null) {
      this.frozenSystemText = this.buildSystemText(timeLine, this.frozenNativeMode);
      this.renderedNeedsSave = true;
    }
    return this.frozenSystemText;
  }

  /** Protocol changes, like tool declaration changes, take effect only in a new working window. */
  generationUsesNativeTools(requested: boolean): boolean { return this.frozenNativeMode ?? requested; }

  /** The backend must capture native declarations together with the exact system prefix before
   * sending. Empty arrays are real snapshots; new tool eligibility remains append-only guidance. */
  async nativeToolSnapshot(timeLine: string, candidate: ChatToolDef[]): Promise<ChatToolDef[]> {
    return this.mutate(async () => {
      this.renderSystemText(timeLine, true);
      if (this.frozenNativeTools === undefined) {
        this.frozenNativeTools = structuredClone(candidate);
        this.renderedNeedsSave = true;
      }
      if (this.renderedNeedsSave) await this.persistPinnedUnlocked();
      return structuredClone(this.frozenNativeTools);
    });
  }

  /** Projection changes become a new prefix only after the previous window has been summarized. */
  resetRenderingAfterCompression(): void {
    this.frozenSystemText = null;
    this.frozenNativeTools = undefined;
    this.frozenNativeMode = undefined;
    this.renderedNeedsSave = false;
    this.mediaWindow = this.newMediaWindow();
    this.renderingRevision++;
  }

  /** Update the next compression's tool block. A brand-new, unused world may initialize it now. */
  setCurrentToolsText(text: string): void {
    this.toolsText = text;
    if (!this.frozenSystemText && !this.stream.length && this.counters.tool === 0 && this.counters.event === 0 && this.pinned.updatedAt === 0) {
      this.pinned.toolsText = text;
    }
  }

  private buildSystemText(timeLine: string, nativeToolCalls = true): string {
    const accounts = this.accountsProvider?.() ?? "";
    const botName = this.botNameProvider?.()?.trim() ?? "";
    const c = this.constitution;
    const original = this.pinned.botDefinition?.trim();
    return [
      ...(original ? ["# 最初的你\n" + original] : []),
      "# 你是谁\n" + (this.pinned.persona.trim() || "（角色设定缺失）"),
      ...(botName ? [`# 你的名字\n你叫「${botName}」。群里仅提到同名不证明在和你说话，结合 @ 的账号、引用对象与上下文判断。`] : []),
      c.constitutionHead +
        "\n\n" +
        (nativeToolCalls ? c.outputFormatNative : c.outputFormatText) +
        "\n" +
        c.constitution +
        "\n" +
        c.conversation +
        "\n" +
        (this.waitRemoved ? c.lifestyleNoWait : c.lifestyleWithWait),
      ...(accounts
        ? [
            "# 你的聊天账号\n" +
              accounts +
              (botName
                ? `\n消息里的 <at id=\"…\"/> 指向这些 id 时，那是别人在 @ 你、在叫「${botName}」（你的名字）——这是直接提及本账号的信号，是否需要回应仍看语境；说话人标为「你自己」的消息来自你的账号，不一定由你亲自发送；不要当成他人新消息或自动纳入自己的经历。`
                : `\n消息里的 <at id=\"…\"/> 指向这些 id、或说话人标为「你自己」时，那都是你——被 @ 是别人在叫你，「你自己」只标识账号，不证明你亲自说过这些话。`),
          ]
        : []),
      "# 基础工具说明（以当前展开和有效的工具为准）\n" + this.pinned.toolsText,
      "# 过往经历（压缩）\n" + this.pinned.historySummary,
      "# 记忆摘要\n" + this.pinned.memoryDigest,
      ...(this.pinned.growthSummary ? ["# 经历之后形成的认识与倾向\n这些是可修订、受情境限制的记忆，不是必须执行的命令。临时状态有适用时段，较新的回忆或变化事件优先。\n" + this.pinned.growthSummary] : []),
      "# 时间\n世界以 Time Unit (TU) 计时" +
        (this.timeInfo ? `，${this.timeInfo}` : "") +
        (this.waitRemoved
          ? "。工具调用的 duration 以 TU 为单位，按此换算估计世界中的耗时。"
          : "。工具调用的 duration 与 wait 的 n 都以 TU 为单位，按此换算估计世界中的耗时。") +
        "\n你恢复意识时的时刻：" +
        timeLine +
        "\n此后时间的流逝，以意识流中事件的 t 属性为准。",
    ].join("\n\n");
  }

  static renderToolCallLine(call: ToolCallRecord): string {
    const obj: Record<string, unknown> = { name: call.name, arguments: call.arguments };
    if (call.duration !== undefined) obj.duration = call.duration;
    return JSON.stringify(obj);
  }

  static renderEventLine(event: BotEvent): string {
    const ref = event.refToolCallId ? ` ref="${event.refToolCallId}"` : "";
    const echo = event.statusEcho ? `\n\n（这条事件发生时你的状态：\n${event.statusEcho}\n）` : "";
    return `<event id="${event.id}" t="${event.worldTime.toFixed(1)}" src="${event.source}"${ref}>${frozenEventText(event)}${echo}</event>`;
  }

  /** Render one immutable event, keeping each asset beside its own identity/summary. */
  private async renderEventChatParts(
    event: BotEvent,
    loader: AttachmentLoadFn | null,
    window: ReturnType<BotContext["newMediaWindow"]>,
  ): Promise<ContentPart[]> {
    const existing = window.events.get(event.id);
    if (existing) return structuredClone(await existing);
    const admitted: { key: string; size: number }[] = [];
    const task = (async () => {
      const refAttr = event.refToolCallId ? ` ref="${event.refToolCallId}"` : "";
      let buf = `<event id="${event.id}" t="${event.worldTime.toFixed(1)}" src="${event.source}"${refAttr}>`;
      const out: ContentPart[] = [];
      const flush = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };
      const eligible = new Set(event.attachments?.map(ref => ref.id) ?? []);
      // Legacy events without ordered parts cannot establish image positions. Keep their text and
      // explicitly identify the remaining media instead of pretending array order is message order.
      const segments: RichTextPart[] = canUseContextText(event) ? [{ kind: "text", text: event.contextText! }] : event.parts?.length ? event.parts : [
        { kind: "text", text: event.content },
        ...(event.attachments?.length ? [
          { kind: "text" as const, text: "\n（以下为旧事件独立保存的媒体；原始插入位置未记录，不能据排列推断对应文字。）\n" },
          ...event.attachments.map(ref => mediaPart(ref)),
        ] : []),
      ];
      for (const seg of segments) {
        if (seg.kind === "text") { buf += seg.text; continue; }
        // Reading the same conversation/photo again must not refill the media budget and force
        // premature memory compression. Keep the original image and its bytes in the prefix;
        // only this newly appended occurrence refers back to its already visible source event.
        const assetKey = JSON.stringify([seg.ref.id, seg.ref.type, seg.ref.mime, seg.ref.file]);
        const previousEvent = event.mediaReuse ? window.assets.get(assetKey) : undefined;
        if (previousEvent) {
          buf += mediaText(seg, `同一媒体的原始内容已在事件 ${previousEvent} 中展开；此处是再次看到同一素材，按 media 引用对应，勿当作另一张图`);
          continue;
        }
        let part = loader && eligible.has(seg.ref.id) ? await loader(seg.ref) : null;
        let reason = "当前未展开原始媒体；仅有此条目的身份与文字摘要";
        if (part) {
          const size = partPayloadSize(part);
          if (window.count + 1 > this.maxAttachmentsPerRequest || window.bytes + size > this.maxAttachmentBytesPerRequest) {
            part = null;
            // A single asset larger than the whole budget cannot be fixed by repeated compaction.
            if (window.count && size <= this.maxAttachmentBytesPerRequest && this.maxAttachmentsPerRequest > 0) window.exceeded = true;
            reason = "本次媒体预算已满，尚未展开此媒体；整理记忆后可再次 view_media 查看，不能将摘要当作已看见原图";
          } else { window.count++; window.bytes += size; admitted.push({ key: assetKey, size }); }
        }
        if (part) {
          buf += mediaOpen(seg);
          if (seg.ref.mime === "image/gif" && part.type === "image_url" && part.image_url.url.startsWith("data:image/png;")) {
            buf += "这是同一动图按时间顺序抽帧的拼图，格子不是独立的多张图片。\n";
          }
          flush(); out.push(part); buf += "\n</media>";
        } else buf += mediaText(seg, reason);
      }
      if (event.statusEcho) buf += `\n\n（这条事件发生时你的状态：\n${event.statusEcho}\n）`;
      buf += "</event>"; flush();
      // A/B/A within this event retains each native image in place. Only a fully rendered
      // event can become another event's reference source; never point into an unfinished one.
      for (const asset of admitted) window.assets.set(asset.key, event.id);
      return out;
    })();
    window.events.set(event.id, task);
    try { return structuredClone(await task); }
    catch (error) {
      window.events.delete(event.id);
      for (const asset of admitted) {
        window.count--; window.bytes -= asset.size;
      }
      throw error;
    }
  }

  renderStreamText(): string {
    return this.stream
      .map((e) =>
        e.kind === "tool_call"
          ? BotContext.renderToolCallLine(e.call)
          : BotContext.renderEventLine(e.event),
      )
      .join("\n");
  }

  /**
   * chat 模式：置顶区为 system，工具调用为 assistant，事件为 user。
   * 每条记录独立保留消息边界；后来同角色的事件也不能重开上次请求的末条消息。
   * 事件的原生多模态附件通过 attachmentLoader 转为 content part 注入。
   *
   * 附件按**每次请求的总预算**（数量 + 体积）注入：历史事件的附件每次请求都会重发，
   * 不设总预算的话 base64 会无限累积，最终撑爆服务端的请求体上限（413）。
   * 每个事件首次渲染时冻结其媒体内容与预算决策。新媒体超限只能追加说明，不能淘汰历史媒体。
   */
  async toChatMessages(timeLine: string, nativeToolCalls = true): Promise<ChatMessage[]> {
    // Capturing the stream and prefix inside the same durable mutation prevents an intervening
    // compression from combining the new stream with an old system block (or the inverse).
    const { entries, systemText, window } = await this.mutate(async () => {
      const systemText = this.renderSystemText(timeLine, nativeToolCalls);
      if (this.renderedNeedsSave) await this.persistPinnedUnlocked();
      return { entries: structuredClone(this.stream), systemText, window: this.mediaWindow };
    });
    const loader = this.attachmentLoader && !this.attachmentsDisabled ? this.attachmentLoader : null;
    this.lastAttachmentPartTypes = new Set();

    const built: { role: ChatMessage["role"]; parts: ContentPart[] }[] = [
      { role: "system", parts: [{ type: "text", text: systemText }] },
    ];
    for (const entry of entries) {
      const role = entry.kind === "tool_call" ? "assistant" : "user";
      let parts: ContentPart[];
      if (entry.kind === "tool_call") {
        parts = [{ type: "text", text: BotContext.renderToolCallLine(entry.call) }];
      } else {
        parts = await this.renderEventChatParts(entry.event, loader, window);
        for (const part of parts) if (part.type !== "text") this.lastAttachmentPartTypes.add(part.type);
      }
      built.push({ role, parts });
    }
    return built.map((m) => ({
      role: m.role,
      content: m.parts.length === 1 && m.parts[0]!.type === "text" ? m.parts[0]!.text : m.parts,
    }));
  }

  /** 近似上下文大小（字符数），用于判断是否需要强制 rest。每个原生附件按 2000 字符计 */
  approxChars(): number {
    const assets = new Set<string>();
    let attachmentCost = 0;
    for (const entry of this.stream) {
      if (entry.kind === "event" && entry.event.attachments?.length) {
        const current = entry.event.attachments.map(ref => JSON.stringify([ref.id, ref.type, ref.mime, ref.file]));
        for (const key of current) if (!entry.event.mediaReuse || !assets.has(key)) attachmentCost += 2000;
        for (const key of current) assets.add(key);
      }
    }
    return (this.frozenSystemText ?? this.buildSystemText("")).length + this.renderStreamText().length + attachmentCost;
  }

  /** 供压缩用：序列化当前工作窗口（把连续重复的工具调用折叠成一条汇总，避免千篇一律的历史占满压缩输入） */
  serializeForCompression(entries: StreamEntry[] = this.stream): string {
    const lines: string[] = [];
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i]!;
      if (entry.kind !== "tool_call") {
        lines.push(BotContext.renderEventLine(entry.event));
        i++;
        continue;
      }
      // 连续重复折叠：统计后面有多少个「名字 + 规范化参数完全相同」的连续 tool_call
      const base = entry.call;
      const baseKey = JSON.stringify([base.name, canonicalizeArgs(base.arguments ?? {})]);
      let run = 1;
      let j = i + 1;
      while (j < entries.length) {
        const next = entries[j]!;
        if (next.kind !== "tool_call") break;
        const nextKey = JSON.stringify([next.call.name, canonicalizeArgs(next.call.arguments ?? {})]);
        if (nextKey !== baseKey) break;
        run++;
        j++;
      }
      if (run === 1) {
        // 仅一次：原样渲染，不折叠（保留完整调用行）
        lines.push(BotContext.renderToolCallLine(base));
      } else {
        // 连续重复：只渲染第一条，其后折叠成一条纯文本汇总，压缩输入不被重复调用灌满。
        // 用自然语言而非自造 XML 标签，避免 World-LLM 把折叠标记误当工具输出格式。
        lines.push(BotContext.renderToolCallLine(base));
        lines.push(
          `（注：上面这个调用在意识流里总共出现了 ${run} 次，其中后 ${run - 1} 次是参数完全相同的重复复读、毫无推进，已折叠省略，不必再复述。）`,
        );
      }
      i = j;
    }
    return lines.join("\n");
  }

  /**
   * 当前实际可用的工具列表与置顶区中的差异描述（无差异返回 null）。
   * 用于以 Event 形式告知 Bot 能力变化，而不立即改写置顶区（保护前缀缓存）。
   */
  toolsChangeNotice(): string | null {
    if (this.pinned.toolsText === this.toolsText) return null;
    const oldTools = parseToolBlocks(this.pinned.toolsText);
    const newTools = parseToolBlocks(this.toolsText);
    const added = [...newTools.keys()].filter((n) => !oldTools.has(n));
    const removed = [...oldTools.keys()].filter((n) => !newTools.has(n));
    const changed = [...newTools.keys()].filter(
      (n) => oldTools.has(n) && oldTools.get(n) !== newTools.get(n),
    );
    if (!added.length && !removed.length && !changed.length) return null;
    const parts: string[] = ["（你的能力发生了变化，以下变化即刻生效："];
    if (added.length) parts.push(`【新增】\n${added.map((n) => newTools.get(n)).join("\n")}`);
    if (changed.length) parts.push(`【用法更新】\n${changed.map((n) => newTools.get(n)).join("\n")}`);
    if (removed.length) parts.push(`【失效】${removed.join("、")}（不要再调用它们）`);
    parts.push("置顶的可用工具列表会在下次记忆整理完成后同步刷新，以本次用法更新为准。）");
    return parts.join("\n");
  }

  // ---------- 压缩 ----------

  /** Capture a stable prefix. Later appends belong to the next working window. */
  async compressionSnapshot(): Promise<CompressionSnapshot> {
    return this.mutate(async () => {
      const entries = structuredClone(this.stream);
      return { entries, text: this.serializeForCompression(entries) };
    });
  }

  /** Only retire the prefix which was actually summarized. Never write objective world state. */
  async applyCompression(result: CompressionResult, worldTime: number, snapshot?: CompressionSnapshot, growthSummary?: string): Promise<void> {
    await this.mutate(async () => {
      const prefix = snapshot?.entries ?? this.stream;
      const key = (e: StreamEntry) => e.kind === "tool_call" ? e.call.id : e.event.id;
      if (prefix.some((entry, i) => !this.stream[i] || key(entry) !== key(this.stream[i]!))) {
        throw new Error("压缩快照已过期，保留当前经历并重新整理");
      }
      const remaining = this.stream.slice(prefix.length);
      const { botDef } = await this.files.readDefinitions();
      const commit: CompressionCommit = {
        previousStream: this.stream,
        stream: remaining,
        counters: { ...this.counters },
        pinned: {
          botDefinition: botDef, persona: botDef,
          historySummary: result.historySummary, toolsText: this.toolsText,
          memoryDigest: result.memoryDigest, updatedAt: worldTime,
          ...(growthSummary !== undefined || this.pinned.growthSummary !== undefined ? { growthSummary: growthSummary ?? this.pinned.growthSummary } : {}),
        },
      };
      // Commit intent is durable before truncating either file. A crash can replay this cutover.
      await this.files.atomicWrite(this.compressionCommitPath, JSON.stringify(commit));
      this.needsRecovery = true;
      await this.recoverCompressionUnlocked();
    });
  }

  private get compressionCommitPath(): string { return `${this.files.base}/context-commit.json`; }

  private async recoverCompressionUnlocked(): Promise<void> {
    let raw: string;
    try { raw = await fs.readFile(this.compressionCommitPath, "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.needsRecovery = false;
      return;
    }
    const commit = JSON.parse(raw) as CompressionCommit;
    if (!Array.isArray(commit.previousStream) || !Array.isArray(commit.stream) || !commit.pinned || !commit.counters) {
      throw new Error("记忆提交记录损坏，需要恢复归档；当前上下文未被丢弃");
    }
    const lines = (entries: StreamEntry[]) => entries.length ? entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n" : "";
    // Replaying after a failed archive may make another recovery copy, but cannot lose the source stream.
    await this.files.atomicWrite(this.files.stream, lines(commit.previousStream));
    await this.files.archiveStream();
    await this.files.atomicWrite(this.files.stream, lines(commit.stream));
    const counters = {
      tool: Math.max(this.counters.tool, commit.counters.tool),
      event: Math.max(this.counters.event, commit.counters.event),
    };
    const persisted: PinnedPersist = { pinned: commit.pinned, counters };
    await this.files.atomicWrite(this.files.pinned, JSON.stringify(persisted, null, 2));
    await fs.rm(this.compressionCommitPath, { force: true });
    // Publish one complete window only after both files and the recovery marker are committed.
    // On any failure, reads keep the old coherent view and settled() must recover before rendering.
    this.stream = commit.stream;
    this.pinned = commit.pinned;
    this.counters = counters;
    this.resetRenderingAfterCompression();
    this.needsRecovery = false;
  }

}

function hasEventMedia(event: BotEvent): boolean {
  return !!event.attachments?.length || !!event.parts?.some(part => part.kind !== "text");
}

function canUseContextText(event: BotEvent): boolean {
  return typeof event.contextText === "string" && !hasEventMedia(event);
}

function frozenEventText(event: BotEvent): string {
  return canUseContextText(event) ? event.contextText! : event.parts?.length ? richPartsText(event.parts) : event.content;
}

/** Projection happens once at append, never while loading or rendering historical events. */
function narrativeContextText(event: BotEvent, toolName?: string): string | undefined {
  if (hasEventMedia(event) || (event.source !== "world" && !(event.source === "tool" && ["act", "observe"].includes(toolName ?? "")))) return undefined;
  let text = event.parts?.length ? richPartsText(event.parts) : event.content;
  let controlNote = "";
  if (text.startsWith("（以下是外部操纵你身体/设备产生的回执，")) {
    const boundary = text.indexOf("\n");
    if (boundary < 0) return undefined;
    controlNote = text.slice(0, boundary);
    text = text.slice(boundary + 1);
  }
  try {
    const parsed = JSON.parse(text), observation = parsed?.observation ?? parsed;
    if (observation?.mode !== "narrative" || typeof observation.actorId !== "string" || typeof observation.observationId !== "string") return undefined;
    const body = typeof observation.narrative === "string" ? observation.narrative : observation.scene?.text ?? parsed.scene?.text;
    if (typeof body !== "string" || !body.trim()) return undefined;
    const sections = controlNote ? [controlNote] : [];
    if (parsed.recovered === true) sections.push("（以下是已保存处境的回读，不是新发生的行动。）");
    if (parsed.action && typeof parsed.action === "object") {
      if (typeof parsed.action.intent === "string" && parsed.action.intent.trim()) sections.push(`本次操作：${parsed.action.intent}`);
      const status: Record<string, string> = { pending: "仍在进行", completed: "已完成", needs_input: "已推进到需要你决定下一步的地方，本次裁定结束；后续不会自动执行", failed: "未完成", cancelled: "已取消" };
      if (Object.hasOwn(status, parsed.action.status)) sections.push(`行动结果：${status[parsed.action.status]}`);
    }
    sections.push(body);
    return sections.join("\n\n");
  } catch { return undefined; }
}

/** 附件 content part 的近似载荷大小（base64 字符数） */
function partPayloadSize(part: ContentPart): number {
  switch (part.type) {
    case "image_url":
      return part.image_url.url.length;
    case "video_url":
      return part.video_url.url.length;
    case "input_audio":
      return part.input_audio.data.length;
    case "text":
      return part.text.length;
  }
}

/** 解析渲染后的工具列表文本：工具名 → 完整定义块（"- 签名\n  描述"） */
function parseToolBlocks(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) map.set(current, buf.join("\n"));
  };
  for (const line of text.split("\n")) {
    const m = line.match(/^- ([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (m) {
      flush();
      current = m[1]!;
      buf = [line];
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return map;
}
