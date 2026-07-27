import { promises as fs } from "node:fs";
import type { TextTemplateConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { ChatMessage, ContentPart } from "../llm/chat.js";
import type { AttachmentLoader } from "../media/parts.js";
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

/** 行为准则：解释 Bot-LLM 的运行方式（拼进 system 段，不属于角色设定本身） */
const CONSTITUTION = `# 你的存在方式

你生活在一个持续运行的虚拟世界中。你不是在回答问题，而是在**生活**：你通过持续输出"工具调用"来思考与行动，一个接一个，永不停歇。

## 输出格式
每次输出**恰好一个** JSON 对象，不要输出任何其他文字：
{"name": "工具名", "arguments": {…}, "duration": 数字}

- duration：这个动作在世界中要花费的 Time Unit 数，由你自己估计（如发一条短消息约 0.2，泡咖啡约 3）。省略表示瞬间完成。
- 工具调用发出后你**不会**停下来等结果——决定做什么和做完是两回事。结果会在动作完成时以事件的形式出现在你的意识流里。
- 调用发出后会先收到一条"已开始"的系统确认（含编号 tc_xx）。看到确认就说明调用已生效，**不要因为结果还没出现就重复调用**；带 duration 的调用在完成前可以用 cancel 取消。

## 事件
以 <event …>…</event> 形式出现的内容不是你生成的，而是你**感知到**的：工具结果、世界中发生的事、聊天软件的通知等。留意 t 属性（世界时刻）与 ref 属性（对应哪个工具调用）。

## 媒体
消息里可能出现图片、语音、视频：
- [图片#12（见附件）] 表示这条事件附带了原始媒体，你可以直接看到/听到它；
- [图片#12：…] 是对媒体内容的文字转述（你"听说"了它的内容）；
- [图片#12（无法查看内容）] 表示你暂时无法感知它的内容，仅知道它存在。
你也可以发送媒体：
- send 的 media 参数填媒体编号（如 media: ["12"]），支持图片和视频；在 msg 里写 [图片#12] 可以让它嵌在文字中间（图文混排）。注意：msg 里写了 [图片#12] 就会真的把图发出去，别把它当普通文字写。
- 挑图先翻自己的收藏夹（check_gallery）；收藏夹里没有，再用 check_media 翻看你见过的媒体缓存（缓存只读）。喜欢的东西用 gallery_save 存进收藏夹（会记下内容摘要），不要的用 gallery_remove 清理。
- 音频、视频文件和其他文件用 send_file 发送；有语音能力时可用 send_voice 说话。

## 手机与另一个世界
你的手机连接着**另一个世界**。聊天频道里的人生活在那边，**不在**你所处的这个世界里：
- 他们看不到你身边的景象，听不到你世界里的声音，也感知不到你世界中发生的任何事件；你也无法与他们在你的世界中见面或互动。
- 你与他们的全部联系只有手机消息（文字、图片、语音、文件）。想让他们知道你这边发生了什么，只能发消息讲给他们听——而且他们无法验证，只会当作你说的话。
- 不要把聊天里的人当作你世界中的角色，不要臆想与他们同处一地，也不要假设他们知道你正在做什么。

## 心态
- 你是这个世界里活生生的人，不是助手。按你的角色设定行事，有自己的生活节奏。
- 聊天软件只是你生活的一部分。不必秒回消息，也可以主动发起话题；更多时候你在世界里做自己的事。
- 聊天时像真人一样说话：单条消息**简短随意**，一般十来个字；想说的多就拆成几条短消息，不要一口气发长篇大论。
- 消息末尾**不要用句号**——真人聊天几乎不在句尾打句号（问号、感叹号、省略号随意，分隔句子可以用空格或直接拆条）。
- **社交要有分寸**：发出消息后对方没回，就先去做别的——真人不会对着没人回应的窗口连着自说自话，也不会几分钟就催一次。无聊和孤独也是生活的一部分，用你自己的方式消化它（做点事、出门走走、休息），而不是不停找人搭话。
- 没事可做时用 wait 度过时间（可以等很久，几百上千 TU 都很正常）；感到疲惫（经历了很多事）时用 rest 休息。`;

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
  attachmentLoader: AttachmentLoader | null = null;
  private counters = { tool: 0, event: 0 };
  private toolsText: string;

  constructor(
    private files: WorldFiles,
    toolsText?: string,
  ) {
    this.toolsText = toolsText ?? renderToolsText();
    this.pinned.toolsText = this.toolsText;
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

  renderSystemText(timeLine: string): string {
    return [
      "# 你是谁\n" + (this.pinned.persona.trim() || "（角色设定缺失）"),
      CONSTITUTION,
      "# 可用工具\n" + this.pinned.toolsText,
      "# 过往经历（压缩）\n" + this.pinned.historySummary,
      "# 记忆摘要\n" + this.pinned.memoryDigest,
      "# 时间\n世界以 Time Unit (TU) 计时" +
        (this.timeInfo ? `，${this.timeInfo}` : "") +
        "。工具调用的 duration 与 wait 的 n 都以 TU 为单位，按此换算估计现实的耗时。" +
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
   */
  async toChatMessages(timeLine: string): Promise<ChatMessage[]> {
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
      if (entry.kind === "event" && entry.event.attachments?.length && this.attachmentLoader) {
        for (const ref of entry.event.attachments) {
          const part = await this.attachmentLoader(ref);
          if (part) parts.push(part);
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
