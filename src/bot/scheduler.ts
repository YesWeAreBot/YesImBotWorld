import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { RichText, ToolCallRecord } from "../types.js";

export type DeliverFn = (content: string | RichText, refToolCallId?: string) => void;

interface ScheduledTask {
  call: ToolCallRecord;
  cancelled: boolean;
  executed: boolean;
  delivered: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ScheduleOptions {
  /**
   * now：立即开始执行（如 act —— 世界立刻开始裁定），结果压到期望完成时刻交付；
   * expected：到期望完成时刻才执行（如 send —— 打字完成那一刻消息才真正发出）。
   */
  executeAt: "now" | "expected";
  /** 执行体。返回内容则作为结果事件交付；返回 null 则无事件 */
  run: (task: { cancelled: () => boolean }) => Promise<string | RichText | null>;
}

/**
 * 工具调用调度器：实现"生成（决定）与执行（动作）解耦"。
 *
 * - 每个工具调用有期望完成时刻 expectedAt（世界时间）。
 * - 结果就绪且世界到达 expectedAt 时，结果以 Event 交付；
 *   若到点时结果尚未就绪，则结果一就绪立即交付。
 * - 未到 expectedAt 的调用可被 cancel。
 */
export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();

  constructor(
    private clock: WorldClock,
    private deliver: DeliverFn,
    private logger: Logger,
  ) {}

  schedule(call: ToolCallRecord, opts: ScheduleOptions): void {
    const task: ScheduledTask = { call, cancelled: false, executed: false, delivered: false };
    this.tasks.set(call.id, task);
    const delay = this.clock.realMsUntil(call.expectedAt);

    const finish = (result: string | RichText | null) => {
      task.executed = true;
      if (task.cancelled || task.delivered) return;
      task.delivered = true;
      this.tasks.delete(call.id);
      if (result !== null) this.deliver(result, call.id);
    };

    const runNow = () => {
      opts
        .run({ cancelled: () => task.cancelled })
        .then((result) => finish(result))
        .catch((err) => {
          this.logger.warn("工具 %s (%s) 执行失败: %s", call.name, call.id, err);
          finish(`（动作 ${call.name} 执行失败：${(err as Error).message ?? err}）`);
        });
    };

    if (opts.executeAt === "expected") {
      // 到点才执行
      task.timer = setTimeout(() => {
        if (task.cancelled) return;
        runNow();
      }, delay);
    } else {
      // 立即执行，结果压到 expectedAt 交付
      let result: string | RichText | null = null;
      let resultReady = false;
      let timeReached = delay <= 0;

      const tryDeliver = () => {
        if (!resultReady || !timeReached || task.cancelled || task.delivered) return;
        task.delivered = true;
        this.tasks.delete(call.id);
        if (result !== null) this.deliver(result, call.id);
      };

      if (!timeReached) {
        task.timer = setTimeout(() => {
          timeReached = true;
          tryDeliver();
        }, delay);
      }
      opts
        .run({ cancelled: () => task.cancelled })
        .then((r) => {
          result = r;
          resultReady = true;
          task.executed = true;
          tryDeliver();
        })
        .catch((err) => {
          this.logger.warn("工具 %s (%s) 执行失败: %s", call.name, call.id, err);
          result = `（动作 ${call.name} 执行失败：${(err as Error).message ?? err}）`;
          resultReady = true;
          task.executed = true;
          tryDeliver();
        });
    }
  }

  /** 取消一个尚未交付的工具调用 */
  cancel(id: string): "cancelled" | "not_found" | "too_late" {
    const task = this.tasks.get(id);
    if (!task) return "not_found";
    if (task.delivered) return "too_late";
    if (this.clock.now() >= task.call.expectedAt && task.executed) return "too_late";
    task.cancelled = true;
    if (task.timer) clearTimeout(task.timer);
    this.tasks.delete(id);
    return "cancelled";
  }

  /** 某个工具调用是否仍在进行中（未交付、未取消） */
  isPending(id: string): boolean {
    return this.tasks.has(id);
  }

  /** 是否存在未完成的任务 */
  get pendingCount(): number {
    return this.tasks.size;
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      task.cancelled = true;
      if (task.timer) clearTimeout(task.timer);
    }
    this.tasks.clear();
  }
}
