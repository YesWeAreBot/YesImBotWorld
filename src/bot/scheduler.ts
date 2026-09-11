import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { RichText, ToolCallRecord } from "../types.js";

export type DeliverFn = (content: string | RichText, refToolCallId?: string, outcome?: { ok: boolean }) => void;

interface ScheduledTask {
  call: ToolCallRecord;
  abort: AbortController;
  committed: boolean;
  delivered: boolean;
  retired?: boolean;
  pendingDelivery?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface TaskControl {
  cancelled(): boolean;
  signal: AbortSignal;
  /** Synchronous fence immediately before an irreversible operation. False means do not commit. */
  beginCommit(): boolean;
}

export interface ScheduleOptions {
  executeAt: "now" | "expected";
  /** Serialize actual side effects, without owning the device during receipt delays. */
  serialKey?: string;
  beforeStart?: () => void;
  /** Default: execution itself is the commit boundary (platform/API tools).
   * Cooperative operations must check signal and call beginCommit before changing state. */
  cancellation?: "before_start" | "cooperative";
  run: (task: TaskControl) => Promise<string | RichText | null>;
}

/** Execution and delivery are separate; cancellation must never hide a committed action. */
export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private serialQueues = new Map<string, Promise<void>>();

  constructor(private clock: WorldClock, private deliver: DeliverFn, private logger: Logger) {}

  schedule(call: ToolCallRecord, opts: ScheduleOptions): void {
    if (this.tasks.has(call.id)) throw new Error(`工具调用编号重复：${call.id}`);
    const task: ScheduledTask = {
      call, abort: new AbortController(), committed: false, delivered: false,
    };
    this.tasks.set(call.id, task);
    const control: TaskControl = {
      cancelled: () => task.abort.signal.aborted,
      signal: task.abort.signal,
      beginCommit: () => {
        if (task.abort.signal.aborted) return false;
        task.committed = true;
        return true;
      },
    };
    const deliver = (result: string | RichText | null, ok: boolean) => {
      if (task.abort.signal.aborted || task.delivered) return;
      task.delivered = true;
      this.tasks.delete(call.id);
      if (result !== null) this.deliver(result, call.id, { ok });
    };
    const atExpected = (fn: () => void) => {
      if (task.retired && task.committed) { fn(); return; }
      const remaining = Math.max(0, this.clock.realMsUntil(call.expectedAt));
      if (remaining <= 0) { fn(); return; }
      task.timer = setTimeout(() => {
        task.timer = undefined;
        if (!task.abort.signal.aborted) atExpected(fn);
      }, Math.min(remaining, 2_147_483_647));
    };
    const execute = async () => {
      if (task.abort.signal.aborted) return;
      let result: string | RichText | null;
      let ok = true;
      try {
        opts.beforeStart?.();
        if (opts.cancellation !== "cooperative") control.beginCommit();
        result = await opts.run(control);
      } catch (err) {
        if (task.abort.signal.aborted) return;
        this.logger.warn("工具 %s (%s) 执行失败: %s", call.name, call.id, err);
        ok = false;
        result = `（动作 ${call.name} 执行失败：${(err as Error).message ?? err}）`;
      }
      if (task.abort.signal.aborted) return;
      task.committed = true;
      if (opts.executeAt === "now") { task.pendingDelivery = () => deliver(result, ok); atExpected(task.pendingDelivery); }
      else deliver(result, ok);
    };
    const run = () => {
      if (!opts.serialKey) return execute();
      const key = opts.serialKey;
      const pending = (this.serialQueues.get(key) ?? Promise.resolve()).then(execute, execute);
      this.serialQueues.set(key, pending);
      const cleanup = () => { if (this.serialQueues.get(key) === pending) this.serialQueues.delete(key); };
      void pending.then(cleanup, cleanup);
      return pending;
    };
    if (opts.executeAt === "expected") atExpected(() => void run());
    else void run();
  }

  cancel(id: string): "cancelled" | "not_found" | "too_late" {
    const task = this.tasks.get(id);
    if (!task) return "not_found";
    if (task.committed || task.delivered) return "too_late";
    task.abort.abort();
    if (task.timer) clearTimeout(task.timer);
    this.tasks.delete(id);
    return "cancelled";
  }

  isPending(id: string): boolean { return this.tasks.has(id); }
  pendingByName(name: string): ToolCallRecord[] {
    return [...this.tasks.values()].filter((t) => t.call.name === name).map((t) => t.call);
  }
  get pendingCount(): number { return this.tasks.size; }

  /** 管理员接管时只能取消尚未提交的任务；已提交任务继续交付真实回执。 */
  cancelUncommitted(): string[] {
    const cancelled: string[] = [];
    for (const id of this.tasks.keys()) if (this.cancel(id) === "cancelled") cancelled.push(id);
    return cancelled;
  }

  stopAll(): void {
    for (const [id, task] of this.tasks) {
      if (task.committed) {
        // Once the world stops, its clock can freeze. Preserve an available receipt now,
        // rather than leaving it only in an in-memory timer until a fictional deadline.
        task.retired = true;
        if (task.timer) clearTimeout(task.timer);
        task.pendingDelivery?.();
        continue;
      }
      task.abort.abort();
      if (task.timer) clearTimeout(task.timer);
      this.tasks.delete(id);
    }
  }
}
