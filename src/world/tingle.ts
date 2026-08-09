import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { ClockConfigData } from "../config.js";
import type { WorldAgent } from "./agent.js";

/**
 * Tingle：世界心跳。每过 tingleEveryUnits 个 Time Unit，
 * World-LLM 感受到一次 Tingle，推进世界演化（生成 News、更新 World_Status.md，
 * 必要时向 Bot 发送事件）。
 */
export class TingleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private cfg: ClockConfigData,
    private clock: WorldClock,
    private world: WorldAgent,
    private deliver: (content: string) => void,
    private logger: Logger,
  ) {}

  start(): void {
    if (this.running || this.cfg.tingleEveryUnits <= 0) return;
    this.running = true;
    this.scheduleNext(this.cfg.tingleEveryUnits);
    this.logger.info(
      "Tingle 已启动：%s（默认 %d TU，即 %d 现实秒）",
      this.cfg.tingleMode === "auto" ? "auto 模式（间隔由 World 动态决定）" : "固定间隔",
      this.cfg.tingleEveryUnits,
      this.cfg.tingleEveryUnits * this.clock.unitRealSeconds,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(intervalTU: number): void {
    if (!this.running) return;
    const delayMs = Math.max(0, intervalTU) * this.clock.unitRealSeconds * 1000;
    this.timer = setTimeout(() => {
      void this.fire().finally(() => this.scheduleNext(this.lastInterval));
    }, delayMs);
  }

  /** auto 模式下上一次 Tingle 之后 World 决定的下一次间隔（TU）；fixed 模式恒为配置值 */
  private lastInterval = 0;

  private async fire(): Promise<void> {
    if (!this.running) return;
    this.logger.debug("Tingle 触发");
    try {
      const next = await this.world.tingle(this.deliver);
      // World 动态决定的间隔：限制在配置的上下限内；没决定则沿用默认
      let interval = this.cfg.tingleEveryUnits;
      if (this.cfg.tingleMode === "auto" && next !== null && next > 0) {
        const min = this.cfg.tingleMinUnits;
        const max = this.cfg.tingleMaxUnits;
        interval = Math.min(max > 0 ? max : next, Math.max(min > 0 ? min : next, next));
      }
      this.lastInterval = interval;
    } catch (err) {
      this.logger.warn("Tingle 处理失败: %s", err);
      this.lastInterval = this.cfg.tingleEveryUnits;
    }
  }
}
