import { promises as fs } from "node:fs";
import type { WorldFiles } from "../files.js";
import type { ChatMessage, ContentPart } from "../llm/chat.js";
import type { AttachmentLoadFn } from "../media/parts.js";
import { BOT_PROMPT_DEFAULTS, type Prompts } from "../prompts.js";
import type {
  BotEvent,
  CompressionResult,
  MediaRef,
  PinnedContext,
  StreamEntry,
  ToolCallRecord,
} from "../types.js";
import { renderToolsText } from "./tools.js";
import { canonicalizeArgs } from "./repeatGuard.js";

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
  /**
   * 附件注入锚点：锚点之前的附件永久退化为文字（仅内存态，压缩/重启后自然重置）。
   *
   * 预算控制采用"锚点 + 批量淘汰"而非滑动窗口：滑动窗口每来一张新图就会改动一条旧消息
   * （最老的入选附件被挤出），前缀缓存从那里断裂、几乎每次生成都要重算；
   * 锚点方案只在越限时整批前移一次（水位降到一半），其余时间允许集只增不改，
   * 新附件全部出现在流的末尾——前缀稳定，缓存重算被摊薄到每 N/2 张新图一次。
   */
  private attachAnchor = { pos: 0, skip: 0 };
  private counters = { tool: 0, event: 0 };
  private toolsText: string;
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

  async settled(): Promise<void> { await this.mutationTail; }

  constructor(
    private files: WorldFiles,
    toolsText?: string,
    private prompts?: Prompts,
  ) {
    this.toolsText = toolsText ?? renderToolsText();
    this.pinned.toolsText = this.toolsText;
  }

  /** 当前生效的行为准则段（WebUI 覆盖后即时生效，无需重载） */
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
      this.pinned = raw.pinned;
      this.counters = raw.counters;
      // 注意：置顶区保留持久化时的工具列表（保护前缀缓存）。
      // 与当前实际可用工具的差异由 service 层通过 toolsChangeNotice() 以 Event 形式告知 Bot，
      // 置顶列表在下次 rest 压缩（applyCompression）时才同步为当前列表。
    } catch {
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
    this.attachAnchor = { pos: 0, skip: 0 };
    const raw = await this.files.readText(this.files.stream);
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as StreamEntry;
        this.stream.push(entry);
        // A crash between the append and counter save must not reuse an event ID.
        const id = entry.kind === "tool_call" ? entry.call.id : entry.event.id;
        const n = Number(id.split("_").at(-1));
        if (Number.isSafeInteger(n)) {
          const counter = entry.kind === "tool_call" ? "tool" : "event";
          this.counters[counter] = Math.max(this.counters[counter], n);
        }
      } catch {
        /* 跳过损坏行 */
      }
    }
  }

  async persistPinned(): Promise<void> {
    return this.mutate(() => this.persistPinnedUnlocked());
  }

  private async persistPinnedUnlocked(): Promise<void> {
    const data: PinnedPersist = { pinned: this.pinned, counters: this.counters };
    await this.files.atomicWrite(this.files.pinned, JSON.stringify(data, null, 2));
  }

  private async appendEntry(entry: StreamEntry): Promise<void> {
    await fs.appendFile(this.files.stream, JSON.stringify(entry) + "\n");
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
      await this.appendEntry({ kind: "event", event });
      await this.persistPinnedUnlocked();
    });
  }

  /**
   * 把「最近一处带完整状态回显的 act 结果事件」退化为轻提示：删除该事件的
   * statusEcho（完整 Bot_Status.md 原文），改在正文末尾追加一句「你的状态已随之更新」。
   *
   * 用途：act 结果后回显的完整 bot_status 只在「最新一处」保留（给模型现状感、抑制复读），
   * 更早的会退化为轻提示——既避免过时的状态误导模型，也避免每次 act 的 token 无限累积。
   * 新 act 结果追加完整回显之前调用本方法（见 dispatchAct）。
   *
   * 注意：stream.jsonl 是 append-only，这里需要整体重写该文件以落地退化结果；
   * 内存中的 stream 同步修改，保证本次与后续渲染一致。
   */
  async downgradeLastStatusEcho(): Promise<void> {
    return this.mutate(() => this.downgradeLastStatusEchoUnlocked());
  }

  private async downgradeLastStatusEchoUnlocked(): Promise<void> {
    let idx = -1;
    for (let i = this.stream.length - 1; i >= 0; i--) {
      const entry = this.stream[i]!;
      if (entry.kind === "event" && entry.event.statusEcho) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const entry = this.stream[idx]!;
    if (entry.kind !== "event") return;
    entry.event.statusEcho = undefined;
    entry.event.content += "\n\n（你的状态已随之更新。）";
    await this.rewriteStream();
  }

  /** 把内存中的 stream 整体重写回 stream.jsonl（原子写），用于"改写历史条目"类操作 */
  private async rewriteStream(): Promise<void> {
    const lines = this.stream.map((e) => JSON.stringify(e)).join("\n");
    await this.files.atomicWrite(this.files.stream, lines ? lines + "\n" : "");
  }

  // ---------- 渲染 ----------

  /** TU 换算说明（由 service 按时钟配置注入，如 "1 TU = 1 秒"）。Bot 估算 duration/wait 的锚点 */
  timeInfo = "";
  /** 聊天账号列表提供者（service 注入）：只含 platform:id，保持前缀稳定 */
  accountsProvider: (() => string) | null = null;
  /** 常驻 Bot 名字提供者（service 注入）：运行时可变（世界演化可改名），渲染时实时取值 */
  botNameProvider: (() => string) | null = null;
  /** wait 工具被移除（service 按 bot.disableWait 注入）：行为准则不再提及等待 */
  waitRemoved = false;

  renderSystemText(timeLine: string, nativeToolCalls = true): string {
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
    const echo = event.statusEcho ? `\n\n（你此刻的状态：\n${event.statusEcho}\n）` : "";
    return `<event id="${event.id}" t="${event.worldTime.toFixed(1)}" src="${event.source}"${ref}>${event.content}${echo}</event>`;
  }

  /**
   * 把一个事件渲染成 chat 模式的 content parts。
   * - 有原生附件且支持注入时，按 event.parts 的图文顺序交错（文字段 + image_url 段），
   *   使聊天记录里的图片出现在对应位置，而不是全部堆在文字之后；
   * - 无 parts / 无 loader / 附件越预算时，回退到"整段文字 + 平铺附件"的旧行为。
   */
  private async renderEventChatParts(
    event: BotEvent,
    loader: AttachmentLoadFn | null,
    allowed: Set<number>,
  ): Promise<ContentPart[]> {
    const refAttr = event.refToolCallId ? ` ref="${event.refToolCallId}"` : "";
    const open = `<event id="${event.id}" t="${event.worldTime.toFixed(1)}" src="${event.source}"${refAttr}>`;
    const echo = event.statusEcho ? `\n\n（你此刻的状态：\n${event.statusEcho}\n）` : "";
    const close = `</event>`;

    if (!event.parts || !loader) {
      const parts: ContentPart[] = [{ type: "text", text: open + event.content + echo + close }];
      if (loader && event.attachments) {
        for (const ref of event.attachments) {
          if (!allowed.has(ref.id)) continue;
          const part = await loader(ref);
          if (part) {
            parts.push(part);
            this.lastAttachmentPartTypes.add(part.type);
          }
        }
      }
      return parts;
    }

    // 有 parts：按顺序把文字与图片交错成 content parts
    const out: ContentPart[] = [];
    let buf = open;
    const flush = () => {
      if (buf) {
        out.push({ type: "text", text: buf });
        buf = "";
      }
    };
    for (const seg of event.parts) {
      if (seg.kind === "text") {
        buf += seg.text;
        continue;
      }
      // media 段：预算内且可附 → image_url；否则退化为 marker 文本（[图片#x（见附件）]）
      const part = allowed.has(seg.ref.id) ? await loader(seg.ref) : null;
      if (part) {
        flush();
        out.push(part);
        this.lastAttachmentPartTypes.add(part.type);
      } else {
        buf += seg.marker;
      }
    }
    buf += echo + close;
    flush();
    return out;
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
   * chat 模式：置顶区为 system，工具调用为 assistant，事件为 user（连续同角色合并）。
   * 事件的原生多模态附件通过 attachmentLoader 转为 content part 注入。
   *
   * 附件按**每次请求的总预算**（数量 + 体积）注入：历史事件的附件每次请求都会重发，
   * 不设总预算的话 base64 会无限累积，最终撑爆服务端的请求体上限（413）。
   * 预算从最新的事件往前分配，更早的附件退化为纯文字标记。
   */
  async toChatMessages(timeLine: string, nativeToolCalls = true): Promise<ChatMessage[]> {
    await this.settled();
    const entries = structuredClone(this.stream);
    const loader = this.attachmentLoader && !this.attachmentsDisabled ? this.attachmentLoader : null;
    const allowed = new Set<number>();
    this.lastAttachmentPartTypes = new Set();
    if (loader) {
      // 1. 收集锚点之后的候选附件（单个超预算的永久跳过——决策稳定，不影响前缀）
      const cands: { pos: number; skip: number; ref: MediaRef; size: number }[] = [];
      for (let i = this.attachAnchor.pos; i < entries.length; i++) {
        const entry = entries[i]!;
        if (entry.kind !== "event" || !entry.event.attachments?.length) continue;
        const from = i === this.attachAnchor.pos ? this.attachAnchor.skip : 0;
        for (let k = from; k < entry.event.attachments.length; k++) {
          const ref = entry.event.attachments[k]!;
          const part = await loader(ref);
          if (!part) continue;
          const size = partPayloadSize(part);
          if (size > this.maxAttachmentBytesPerRequest) continue;
          cands.push({ pos: i, skip: k, ref, size });
        }
      }
      // 2. 越限时整批前移锚点：把水位降到一半，换取之后一段时间允许集只增不改
      const total = cands.reduce((s, c) => s + c.size, 0);
      if (cands.length > this.maxAttachmentsPerRequest || total > this.maxAttachmentBytesPerRequest) {
        const halfCount = Math.max(1, Math.floor(this.maxAttachmentsPerRequest / 2));
        const halfBytes = Math.max(1, Math.floor(this.maxAttachmentBytesPerRequest / 2));
        let keep = 0;
        let bytes = 0;
        for (let j = cands.length - 1; j >= 0; j--) {
          if (keep + 1 > halfCount || bytes + cands[j]!.size > halfBytes) break;
          keep++;
          bytes += cands[j]!.size;
        }
        if (keep === 0 && cands.length) keep = 1; // 至少保留最新一个（其体积已 ≤ 总预算）
        const kept = cands.slice(cands.length - keep);
        const first = kept[0];
        this.attachAnchor = first
          ? { pos: first.pos, skip: first.skip }
          : { pos: entries.length, skip: 0 };
        for (const c of kept) allowed.add(c.ref.id);
      } else {
        for (const c of cands) allowed.add(c.ref.id);
      }
    }

    const built: { role: ChatMessage["role"]; parts: ContentPart[] }[] = [
      { role: "system", parts: [{ type: "text", text: this.renderSystemText(timeLine, nativeToolCalls) }] },
    ];
    for (const entry of entries) {
      const role = entry.kind === "tool_call" ? "assistant" : "user";
      let parts: ContentPart[];
      if (entry.kind === "tool_call") {
        parts = [{ type: "text", text: BotContext.renderToolCallLine(entry.call) }];
      } else {
        parts = await this.renderEventChatParts(entry.event, loader, allowed);
      }
      const last = built[built.length - 1]!;
      if (last.role === role) {
        const lastPart = last.parts[last.parts.length - 1];
        const first = parts[0]!;
        if (lastPart?.type === "text" && first.type === "text") {
          lastPart.text += "\n" + first.text;
          last.parts.push(...parts.slice(1));
        } else {
          last.parts.push(...parts);
        }
      } else {
        built.push({ role, parts });
      }
    }
    return built.map((m) => ({
      role: m.role,
      content: m.parts.length === 1 && m.parts[0]!.type === "text" ? m.parts[0]!.text : m.parts,
    }));
  }

  /** 近似上下文大小（字符数），用于判断是否需要强制 rest。每个原生附件按 2000 字符计 */
  approxChars(): number {
    let attachmentCost = 0;
    for (const entry of this.stream) {
      if (entry.kind === "event" && entry.event.attachments?.length) {
        attachmentCost += entry.event.attachments.length * 2000;
      }
    }
    return this.renderSystemText("").length + this.renderStreamText().length + attachmentCost;
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

  /** 工作窗口中是否存在原生附件（400 熔断的判定条件之一） */
  hasAttachments(): boolean {
    return this.stream.some((e) => e.kind === "event" && !!e.event.attachments?.length);
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
  async applyCompression(result: CompressionResult, worldTime: number, snapshot?: CompressionSnapshot): Promise<void> {
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
    this.stream = commit.stream;
    this.pinned = commit.pinned;
    this.attachAnchor = { pos: 0, skip: 0 };
    this.counters.tool = Math.max(this.counters.tool, commit.counters.tool);
    this.counters.event = Math.max(this.counters.event, commit.counters.event);
    await this.persistPinnedUnlocked();
    await fs.rm(this.compressionCommitPath, { force: true });
    this.needsRecovery = false;
  }

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
