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
    this.scheduleNext();
    this.logger.info("Tingle 已启动：每 %d TU（%d 现实秒）一次", this.cfg.tingleEveryUnits, this.cfg.tingleEveryUnits * this.clock.unitRealSeconds);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delayMs = this.cfg.tingleEveryUnits * this.clock.unitRealSeconds * 1000;
    this.timer = setTimeout(() => {
      void this.fire().finally(() => this.scheduleNext());
    }, delayMs);
  }

  private async fire(): Promise<void> {
    if (!this.running) return;
    this.logger.debug("Tingle 触发");
    try {
      await this.world.tingle(this.deliver);
    } catch (err) {
      this.logger.warn("Tingle 处理失败: %s", err);
    }
  }
}
