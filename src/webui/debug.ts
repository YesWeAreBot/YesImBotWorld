/**
 * 调试事件总线（DebugBus）：WebUI 的实时流数据源。
 *
 * 这是模块级单例：LLM 客户端、BotAgent、WorldAgent 与 WorldService 都直接
 * emit，无需层层透传。WebUI 服务器订阅它并把事件经 SSE 推给浏览器。
 * 未启用 WebUI 时，缓存仍保留最近条目（内存开销可忽略），但 `enabled`
 * 为 false 时跳过字符串化等重活。
 */

export type DebugLevel = "info" | "warn" | "error";

export type DebugKind =
  /** LLM 原始请求（发送给服务端的完整输入） */
  | "llm.req"
  /** LLM 原始响应 */
  | "llm.res"
  /** Bot 追加进工作窗口的工具调用 */
  | "bot.tool"
  /** Bot 注入意识流的事件 */
  | "bot.event"
  /** World-LLM 的任务描述 */
  | "world.task"
  /** World-LLM 一轮工具调用的最终结果 */
  | "world.result"
  /** World-LLM 执行了某个工具（update/check/send_event） */
  | "world.tool"
  /** 世界生命周期（init/start/stop/reload/reset） */
  | "lifecycle"
  /** 运维操作（WebUI 触发的操作） */
  | "op";

export interface DebugEntry {
  id: number;
  /** 现实时间戳（ms） */
  ts: number;
  kind: DebugKind;
  /** 简短标题（列表行显示） */
  label: string;
  /** JSON 字符串或纯文本（展开显示） */
  detail: string;
  level: DebugLevel;
}

export class DebugBus {
  enabled = false;
  private entries: DebugEntry[] = [];
  private listeners = new Set<(e: DebugEntry, isUpdate: boolean) => void>();
  private nextId = 1;
  private readonly limit: number;
  private readonly maxDetail: number;

  constructor(limit = 500, maxDetail = 40000) {
    this.limit = limit;
    this.maxDetail = maxDetail;
  }

  /** 缓冲容量 / 单条 detail 上限（字符），超限截断防止撑爆内存与 SSE。返回条目 id（供 update 引用） */
  emit(kind: DebugKind, label: string, detail: unknown, level: DebugLevel = "info"): number {
    const entry: DebugEntry = {
      id: this.nextId++,
      ts: Date.now(),
      kind,
      label: String(label),
      detail: typeof detail === "string" ? detail : safeStringify(detail, this.maxDetail),
      level,
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    if (!this.enabled) return entry.id;
    for (const fn of [...this.listeners]) {
      try {
        fn(entry, false);
      } catch {
        /* 监听器异常不影响主流程 */
      }
    }
    return entry.id;
  }

  /** 原地更新一条已存在条目（用于流式输出在单条记录里动态刷新）。条目不存在时静默忽略 */
  update(id: number, patch: { label?: string; detail?: unknown; level?: DebugLevel }): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    if (patch.label !== undefined) entry.label = String(patch.label);
    if (patch.detail !== undefined) {
      entry.detail = typeof patch.detail === "string" ? patch.detail : safeStringify(patch.detail, this.maxDetail);
    }
    if (patch.level !== undefined) entry.level = patch.level;
    entry.ts = Date.now();
    if (!this.enabled) return;
    for (const fn of [...this.listeners]) {
      try {
        fn(entry, true);
      } catch {
        /* 监听器异常不影响主流程 */
      }
    }
  }

  subscribe(fn: (e: DebugEntry, isUpdate: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 最近的 n 条 */
  recent(n: number): DebugEntry[] {
    return this.entries.slice(-n);
  }

  /** id 大于 since 的全部条目（SSE 重连时补发） */
  since(since: number): DebugEntry[] {
    if (!this.entries.length) return [];
    return this.entries.filter((e) => e.id > since);
  }

  /** 当前最大 id（SSE 断线续传锚点） */
  snapshot(): number {
    return this.nextId - 1;
  }

  clear(): void {
    this.entries = [];
  }
}

function safeStringify(value: unknown, max: number): string {
  try {
    const text = JSON.stringify(value);
    return text && text.length > max ? text.slice(0, max) + "\n…（已截断）" : (text ?? String(value));
  } catch {
    return String(value).slice(0, max);
  }
}

/** 模块级单例：全局共享 */
export const debug = new DebugBus();
