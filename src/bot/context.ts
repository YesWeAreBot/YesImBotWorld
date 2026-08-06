import { promises as fs } from "node:fs";
import type { TextTemplateConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { ChatMessage, ContentPart } from "../llm/chat.js";
import type { AttachmentLoadFn } from "../media/parts.js";
import { BOT_PROMPT_DEFAULTS, type Prompts } from "../prompts.js";
import type {
  BotEvent,
  CompressionResult,
  PinnedContext,
  StreamEntry,
  ToolCallRecord,
} from "../types.js";
import { renderToolsText } from "./tools.js";

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
    try {
      const raw = JSON.parse(await fs.readFile(this.files.pinned, "utf8")) as PinnedPersist;
      this.pinned = raw.pinned;
      this.counters = raw.counters;
      // 注意：置顶区保留持久化时的工具列表（保护前缀缓存）。
      // 与当前实际可用工具的差异由 service 层通过 toolsChangeNotice() 以 Event 形式告知 Bot，
      // 置顶列表在下次 rest 压缩（applyCompression）时才同步为当前列表。
    } catch {
      this.pinned.persona = await this.files.readBotStatus();
    }
    this.stream = [];
    this.attachAnchor = { pos: 0, skip: 0 };
    const raw = await this.files.readText(this.files.stream);
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.stream.push(JSON.parse(line) as StreamEntry);
      } catch {
        /* 跳过损坏行 */
      }
    }
  }

  async persistPinned(): Promise<void> {
    const data: PinnedPersist = { pinned: this.pinned, counters: this.counters };
    await this.files.atomicWrite(this.files.pinned, JSON.stringify(data, null, 2));
  }

  private async appendEntry(entry: StreamEntry): Promise<void> {
    this.stream.push(entry);
    await fs.appendFile(this.files.stream, JSON.stringify(entry) + "\n");
  }

  // ---------- 追加 ----------

  nextToolId(): string {
    return `tc_${++this.counters.tool}`;
  }

  nextEventId(): string {
    return `ev_${++this.counters.event}`;
  }

  async appendToolCall(call: ToolCallRecord): Promise<void> {
    await this.appendEntry({ kind: "tool_call", call });
    await this.persistPinned(); // 保存计数器
  }

  async appendEvent(event: BotEvent): Promise<void> {
    await this.appendEntry({ kind: "event", event });
    await this.persistPinned();
  }

  // ---------- 渲染 ----------

  /** TU 换算说明（由 service 按时钟配置注入，如 "1 TU = 1 秒"）。Bot 估算 duration/wait 的锚点 */
  timeInfo = "";
  /** 聊天账号列表提供者（service 注入）：只含 platform:id，保持前缀稳定 */
  accountsProvider: (() => string) | null = null;
  /** 工具走原生 function calling 声明（service 按 bot.nativeToolCalls 与 mode 注入）：切换行为准则的输出格式段 */
  nativeToolCalls = false;
  /** wait 工具被移除（service 按 bot.disableWait 注入）：行为准则不再提及等待 */
  waitRemoved = false;

  renderSystemText(timeLine: string): string {
    const accounts = this.accountsProvider?.() ?? "";
    const c = this.constitution;
    return [
      "# 你是谁\n" + (this.pinned.persona.trim() || "（角色设定缺失）"),
      c.constitutionHead +
        "\n\n" +
        (this.nativeToolCalls ? c.outputFormatNative : c.outputFormatJson) +
        "\n" +
        c.constitution +
        "\n" +
        (this.waitRemoved ? c.lifestyleNoWait : c.lifestyleWithWait),
      ...(accounts
        ? [
            "# 你的聊天账号\n" +
              accounts +
              "\n消息里的 <at id=\"…\"/> 指向这些 id、或说话人标为「你自己」时，那都是你——被 @ 是别人在叫你，「你自己」的消息是你说过的话。",
          ]
        : []),
      "# 可用工具\n" + this.pinned.toolsText,
      "# 过往经历（压缩）\n" + this.pinned.historySummary,
      "# 记忆摘要\n" + this.pinned.memoryDigest,
      "# 时间\n世界以 Time Unit (TU) 计时" +
        (this.timeInfo ? `，${this.timeInfo}` : "") +
        (this.waitRemoved
          ? "。工具调用的 duration 以 TU 为单位，按此换算估计现实的耗时。"
          : "。工具调用的 duration 与 wait 的 n 都以 TU 为单位，按此换算估计现实的耗时。") +
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
    return `<event t="${event.worldTime.toFixed(1)}" src="${event.source}"${ref}>${event.content}</event>`;
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
  async toChatMessages(timeLine: string): Promise<ChatMessage[]> {
    const loader = this.attachmentLoader && !this.attachmentsDisabled ? this.attachmentLoader : null;
    const allowed = new Set<unknown>();
    this.lastAttachmentPartTypes = new Set();
    if (loader) {
      // 1. 收集锚点之后的候选附件（单个超预算的永久跳过——决策稳定，不影响前缀）
      const cands: { pos: number; skip: number; ref: unknown; size: number }[] = [];
      for (let i = this.attachAnchor.pos; i < this.stream.length; i++) {
        const entry = this.stream[i]!;
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
          : { pos: this.stream.length, skip: 0 };
        for (const c of kept) allowed.add(c.ref);
      } else {
        for (const c of cands) allowed.add(c.ref);
      }
    }

    const built: { role: ChatMessage["role"]; parts: ContentPart[] }[] = [
      { role: "system", parts: [{ type: "text", text: this.renderSystemText(timeLine) }] },
    ];
    for (const entry of this.stream) {
      const role = entry.kind === "tool_call" ? "assistant" : "user";
      const line =
        entry.kind === "tool_call"
          ? BotContext.renderToolCallLine(entry.call)
          : BotContext.renderEventLine(entry.event);
      const parts: ContentPart[] = [{ type: "text", text: line }];
      if (entry.kind === "event" && entry.event.attachments?.length && loader) {
        for (const ref of entry.event.attachments) {
          if (!allowed.has(ref)) continue;
          const part = await loader(ref);
          if (part) {
            parts.push(part);
            this.lastAttachmentPartTypes.add(part.type);
          }
        }
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

  /** text 模式：单一连续文档，整个 Tool Call 流是一个永不结束的 assistant 段 */
  toTextPrompt(template: TextTemplateConfig, timeLine: string): string {
    const streamText = this.renderStreamText();
    return (
      template.bos +
      template.systemPrefix +
      this.renderSystemText(timeLine) +
      template.systemSuffix +
      template.streamPrefix +
      (streamText ? streamText + "\n" : "")
    );
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

  /** 供压缩用：序列化当前工作窗口 */
  serializeForCompression(): string {
    return this.renderStreamText();
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
    parts.push("置顶的可用工具列表会在你下次 rest 之后同步刷新。）");
    return parts.join("\n");
  }

  // ---------- 压缩 ----------

  /**
   * 应用压缩结果：归档旧流、刷新置顶区（角色设定重新从 Bot_Status.md 读取，
   * 工具列表重新渲染 —— 这是唯一允许修改置顶区的时机）。
   */
  async applyCompression(result: CompressionResult, worldTime: number): Promise<void> {
    await this.files.archiveStream();
    this.stream = [];
    this.attachAnchor = { pos: 0, skip: 0 };
    this.pinned = {
      persona: await this.files.readBotStatus(),
      historySummary: result.historySummary,
      toolsText: this.toolsText,
      memoryDigest: result.memoryDigest,
      updatedAt: worldTime,
    };
    await this.persistPinned();
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
