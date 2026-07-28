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

/** 带附件的富文本（附件 = Bot-LLM 原生支持的模态，以 content part 注入） */
export interface RichText {
  text: string;
  attachments?: MediaRef[];
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
}

export type StreamEntry =
  | { kind: "tool_call"; call: ToolCallRecord }
  | { kind: "event"; event: BotEvent };

/**
 * 置顶上下文（仅允许在上下文压缩时修改）。
 * 对应 Prompt 结构中的：角色设定 / 历史压缩 / 工具列表 / 记忆摘要。
 */
export interface PinnedContext {
  /** 角色设定，来自 Bot_Status.md */
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

/** News.db（JSONL）中的一条世界事件 */
export interface NewsEntry {
  /** 世界时刻（Time Unit） */
  t: number;
  /** 世界时钟的可读时间 */
  clock: string;
  content: string;
}

/** 上下文压缩的产物 */
export interface CompressionResult {
  historySummary: string;
  memoryDigest: string;
  /** 若压缩过程认为角色设定应当演化，则给出新的 Bot_Status.md 全文 */
  botStatus?: string;
}
