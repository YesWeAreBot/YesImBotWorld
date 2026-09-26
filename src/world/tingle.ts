import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { ClockConfigData } from "../config.js";
import { debug } from "../webui/debug.js";

export interface HeartbeatResult {
  status: "committed" | "quiet" | "yielded";
  nextIntervalTU?: number;
  reason?: string;
  sequence?: number;
  perceptions?: number;
  attempts?: number;
  elapsedMs?: number;
}

export interface HeartbeatStatus {
  phase: "idle" | "running" | "scheduled" | "failed" | "stopped";
  mode: "auto" | "fixed";
  intervalTU: number;
  nextAtTU: number | null;
  consecutiveFailures: number;
  quietStreak: number;
  lastOutcome: (Omit<HeartbeatResult, "status" | "nextIntervalTU"> & {
    status: HeartbeatResult["status"] | "failed";
    finishedAtTU: number;
  }) | null;
  error: string | null;
}

interface HeartbeatWorld {
  tingle(deliver: (content: string) => void): Promise<HeartbeatResult | number | null>;
}

/** A single heartbeat chain; only validated world outcomes influence the cadence. */
export class TingleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private firing = false;
  private generation = 0;
  private snapshot: HeartbeatStatus;

  constructor(
    private cfg: ClockConfigData,
    private clock: WorldClock,
    private world: HeartbeatWorld,
    private deliver: (content: string) => void,
    private logger: Logger,
  ) {
    this.snapshot = { phase: "idle", mode: cfg.tingleMode === "auto" ? "auto" : "fixed", intervalTU: 0, nextAtTU: null, consecutiveFailures: 0, quietStreak: 0, lastOutcome: null, error: null };
  }

  status(): HeartbeatStatus {
    return { ...this.snapshot, lastOutcome: this.snapshot.lastOutcome ? { ...this.snapshot.lastOutcome } : null };
  }

  start(): void {
    if (this.running || !Number.isFinite(this.cfg.tingleEveryUnits) || this.cfg.tingleEveryUnits <= 0) return;
    this.running = true;
    this.snapshot.consecutiveFailures = this.snapshot.quietStreak = 0;
    this.snapshot.error = null;
    const generation = ++this.generation;
    this.scheduleNext(this.baseline(), generation);
    this.emit("scheduled", "世界心跳 · 已安排");
    this.logger.info("Tingle 已启动：%s（默认 %d TU）", this.snapshot.mode, this.cfg.tingleEveryUnits);
  }

  stop(): void {
    const active = this.running;
    this.running = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.snapshot.phase = "stopped";
    this.snapshot.nextAtTU = null;
    if (active) this.emit("stopped", "世界心跳 · 已停止");
  }

  private baseline(): number {
    return this.snapshot.mode === "auto" ? this.clampAuto(this.cfg.tingleEveryUnits) : this.cfg.tingleEveryUnits;
  }

  private clampAuto(value: number): number {
    const min = Number.isFinite(this.cfg.tingleMinUnits) && this.cfg.tingleMinUnits > 0 ? this.cfg.tingleMinUnits : Math.min(1, this.cfg.tingleEveryUnits);
    const max = Number.isFinite(this.cfg.tingleMaxUnits) && this.cfg.tingleMaxUnits > 0 ? Math.max(min, this.cfg.tingleMaxUnits) : Math.max(min, this.cfg.tingleEveryUnits * 16);
    return Math.min(max, Math.max(min, value));
  }

  private failureInterval(): number {
    const base = this.baseline();
    const ceiling = Number.isFinite(this.cfg.tingleMaxUnits) && this.cfg.tingleMaxUnits > 0 ? Math.max(base, this.cfg.tingleMaxUnits) : base * 16;
    return Math.min(ceiling, base * 2 ** Math.min(this.snapshot.consecutiveFailures, 16));
  }

  private scheduleNext(intervalTU: number, generation: number): void {
    if (!this.running || generation !== this.generation) return;
    if (this.timer) clearTimeout(this.timer);
    this.snapshot.intervalTU = intervalTU;
    this.snapshot.nextAtTU = this.clock.now() + intervalTU;
    this.snapshot.phase = this.snapshot.consecutiveFailures ? "failed" : "scheduled";
    const delayMs = intervalTU * this.clock.unitRealSeconds * 1000;
    // Node treats overflowing timer delays as 1 ms. Long intervals use safe chunks.
    const schedule = (remaining: number) => {
      const chunk = Math.min(2_147_483_647, remaining);
      this.timer = setTimeout(() => {
        if (generation !== this.generation || !this.running) return;
        this.timer = null;
        if (remaining > chunk) schedule(remaining - chunk);
        else void this.fire(generation);
      }, chunk);
    };
    schedule(Math.max(1, delayMs));
  }

  private emit(stage: string, label: string): void {
    debug.emit("world.task", label, { task: "tingle", stage, heartbeat: this.status() }, stage === "failed" ? "warn" : "info");
  }

  private async fire(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    // A stopped generation may still be unwinding. Never run a replacement concurrently.
    if (this.firing) { this.scheduleNext(this.baseline(), generation); return; }
    this.firing = true;
    this.snapshot.phase = "running";
    this.snapshot.nextAtTU = null;
    const started = Date.now();
    this.emit("start", "世界心跳 · 开始检查");
    try {
      const raw = await this.world.tingle(content => {
        if (this.running && generation === this.generation) this.deliver(content);
      });
      if (!this.running || generation !== this.generation) return;
      // A legacy scheduling hint does not prove that a world change was committed.
      const legacyHint = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
      const result: HeartbeatResult = typeof raw === "number" ? { status: "quiet", reason: "旧版仅返回调度建议，未确认新提交" } : raw ?? { status: "quiet" };
      this.snapshot.lastOutcome = { status: result.status, finishedAtTU: this.clock.now(), reason: result.reason, sequence: result.sequence, perceptions: result.perceptions, attempts: result.attempts, elapsedMs: result.elapsedMs ?? Date.now() - started };
      const recovering = this.snapshot.consecutiveFailures > 0;
      this.snapshot.consecutiveFailures = 0;
      this.snapshot.error = null;
      let interval = this.baseline();
      const suggested = Number.isFinite(result.nextIntervalTU) && result.nextIntervalTU! > 0 ? result.nextIntervalTU! : 0;
      if (result.status === "quiet") {
        this.snapshot.quietStreak++;
        if (this.snapshot.mode === "auto") interval = this.clampAuto(legacyHint ?? Math.max(suggested, Math.max(interval, recovering ? interval : this.snapshot.intervalTU) * 1.5));
      } else {
        this.snapshot.quietStreak = 0;
        if (result.status === "committed" && this.snapshot.mode === "auto" && suggested > 0) interval = this.clampAuto(suggested);
      }
      this.scheduleNext(interval, generation);
      this.emit(result.status, { committed: "世界心跳 · 已校验并提交", quiet: "世界心跳 · 保持安静，无需变更", yielded: "世界心跳 · 让位于角色行动" }[result.status]);
    } catch (err) {
      if (!this.running || generation !== this.generation) return;
      const error = err instanceof Error ? err.message : String(err);
      this.snapshot.consecutiveFailures++;
      this.snapshot.quietStreak = 0;
      this.snapshot.error = error;
      this.snapshot.lastOutcome = { status: "failed", finishedAtTU: this.clock.now(), reason: error, elapsedMs: Date.now() - started };
      this.scheduleNext(this.failureInterval(), generation);
      this.emit("failed", "世界心跳 · 失败，等待重试");
      this.logger.warn("Tingle 处理失败: %s", err);
    } finally {
      this.firing = false;
    }
  }
}
