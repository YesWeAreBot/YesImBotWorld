/**
 * 共享类型定义。
 *
 * 核心概念：
 * - ToolCallRecord：Bot-LLM 生成的工具调用（"决定做什么"），带世界时间上的期望完成时刻。
 * - BotEvent：注入 Bot-LLM 工作窗口的事件（工具结果 / 世界事件 / Koishi 消息 / 系统通知）。
 * - StreamEntry：工作窗口（Tool Call 流）中的一条记录。
 */

export type ToolCallRole = "agent" | "world" | "koishi" | "system";

/** Bot-LLM 直接生成出的原始工具调用（未分配 id / 时刻） */
export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** 期望耗时，单位 Time Unit。缺省表示立刻完成 */
  duration?: number;
}

/** 进入 Tool Call 流的完整工具调用记录 */
export interface ToolCallRecord extends ParsedToolCall {
  id: string;
  /** 此调用由谁触发（agent = Bot-LLM 自己生成，system = 运行时强制，如强制 rest） */
  role: ToolCallRole;
  /** 生成时刻（Time Unit） */
  issuedAt: number;
  /** 期望完成时刻 = issuedAt + (duration ?? 0) */
  expectedAt: number;
}

export type EventSource = "world" | "koishi" | "system" | "tool";

export type MediaType = "image" | "audio" | "video";

/** 指向资产库中一个媒体文件的引用 */
export interface MediaRef {
  id: number;
  type: MediaType;
  mime: string;
  /** 资产库内的绝对路径 */
  file: string;
}

/** RichText 的一个有序分段：文本段 或 原生媒体段（图文混排按此顺序铺开） */
export type RichTextPart =
  | { kind: "text"; text: string }
  | { kind: "media"; ref: MediaRef; note: string; marker: string };

/** 带附件的富文本（附件 = Bot-LLM 原生支持的模态，以 content part 注入） */
export interface RichText {
  text: string;
  attachments?: MediaRef[];
  /**
   * 图文有序分段（含原生附件时提供）：按此顺序把文字与媒体交错呈现，
   * 使聊天记录等场景能"图文按位置混排"而非"文字在前、图片堆在后"。
   * 缺省时回退到旧的 text + attachments 拼接行为。
   */
  parts?: RichTextPart[];
  /**
   * act 结果后的当前状态回显（Bot_Status.md 全文），随该事件一起注入。
   * 语义与 BotEvent.statusEcho 一致（见其注释）；经 pushEvent 透传。
   */
  statusEcho?: string;
}

/**
 * 手机的物理状态（agent 与 gateway 共享）。
 * down = Bot 把手机放下了：所有通知降级为"手机震了一下"，不呈现内容，
 * 直到 pick_up_phone 拿起手机。
 */
export interface PhoneStatus {
  down: boolean;
}

export interface BotEvent {
  id: string;
  source: EventSource;
  content: string;
  /** 事件进入上下文时的世界时刻（Time Unit） */
  worldTime: number;
  /** 若此事件是某个工具调用的结果，指向该调用 */
  refToolCallId?: string;
  /** 原生多模态附件（仅 chat 模式 + 声明了对应模态时存在） */
  attachments?: MediaRef[];
  /**
   * 图文有序分段（含原生附件时提供）：按此顺序把文字与媒体交错呈现，
   * 使聊天记录等场景在生成 content parts 时能"图文按位置混排"。
   */
  parts?: RichTextPart[];
  /**
   * act 结果后的当前状态回显（Bot_Status.md 全文）。
   * 仅最新一处 act 结果事件携带完整回显；新 act 结果追加前，上一处的完整回显会
   * 退化为一句轻提示（见 BotContext.downgradeLastStatusEcho）。这样历史里永远只有
   * 最新一处是完整状态，既给模型"现状感"（消除结果丢失焦虑、抑制复读），又避免
   * 过时状态误导 + 每次 act 的 token 无限累积。
   */
  statusEcho?: string;
}

export type StreamEntry =
  | { kind: "tool_call"; call: ToolCallRecord }
  | { kind: "event"; event: BotEvent };

/**
 * 置顶上下文（仅允许在上下文压缩时修改）。
 * 对应 Prompt 结构中的：角色设定 / 历史压缩 / 工具列表 / 记忆摘要。
 */
export interface PinnedContext {
  /**
   * 最初设定（Bot 的最初样子）：Bot_Definition.md 的原文。
   * 永远不变——只在创世时与上下文压缩时从定义文件刷新，
   * 其余时候用户的改动以 Event（world.reload）形式传入，保持前缀稳定。
   */
  botDefinition: string;
  /** 角色设定（自我认知），来自 Bot_Status.md */
  persona: string;
  /** 历史消息（Tool Call 流）的压缩 */
  historySummary: string;
  /** 当前可用工具列表文本 */
  toolsText: string;
  /** 记忆摘要 */
  memoryDigest: string;
  /** 上次刷新（压缩）时的世界时刻 */
  updatedAt: number;
}

/** News.jsonl（JSONL）中的一条世界事件 */
export interface NewsEntry {
  /** 世界时刻（Time Unit） */
  t: number;
  /** 世界时钟的可读时间 */
  clock: string;
  content: string;
  /** 详情正文（World-LLM 摘编时的展开内容；Bot 点进新闻条目后看到的全文） */
  detail?: string;
  /** 是否被用户固定（仅 facts.jsonl）：固定条目在重置世界/重新创世时保留 */
  pinned?: boolean;
}

/** 上下文压缩的产物 */
export interface CompressionResult {
  historySummary: string;
  memoryDigest: string;
  /** 若压缩过程认为角色设定应当演化，则给出新的 Bot_Status.md 全文 */
  botStatus?: string;
}
