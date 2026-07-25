import { promises as fs } from "node:fs";
import type { ClockConfigData } from "./config.js";

interface ClockPersist {
  accumulatedTU: number;
  /** 正在运行时为恢复运行的现实时间戳（ms），暂停时为 null */
  runningSince: number | null;
  /** 世界初始时刻（T=0 对应的世界时间）。创世时采用配置值，此后持久化保存 */
  epoch?: string;
}

/** 运行中周期性落盘的间隔（ms）：崩溃时最多丢失这么多现实时间对应的世界时间 */
const CHECKPOINT_MS = 30_000;

/**
 * World Clock：维护世界时间（以 Time Unit 计）。
 *
 * - 世界时间只在"世界运行中"流逝；插件停止 / world.stop 时暂停。
 * - T=0 对应 epoch（世界初始时刻）：创世时采用配置值并持久化，之后不受配置变更影响。
 * - 1 TU = realSecondsPerUnit 现实秒 = worldSecondsPerUnit 世界秒。
 * - 运行中每 CHECKPOINT_MS 落盘一次检查点，进程被强杀也不会丢失世界时间。
 */
export class WorldClock {
  private state: ClockPersist = { accumulatedTU: 0, runningSince: null };
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cfg: ClockConfigData,
    private file: string,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as ClockPersist;
      if (typeof raw.accumulatedTU === "number") this.state = raw;
      // 插件曾非正常退出（运行中崩溃）：从最后一次检查点恢复，丢弃检查点之后的时间
      if (this.state.runningSince !== null) {
        this.state.runningSince = null;
        await this.save();
      }
    } catch {
      /* 首次运行，使用默认值 */
    }
    // 旧版本的 clock.json 没有 epoch：补录当前配置值并持久化
    if (!this.state.epoch) {
      this.state.epoch = this.cfg.epoch;
      await this.save();
    }
  }

  /** 持久化的世界初始时刻（回退到配置值） */
  get epoch(): string {
    return this.state.epoch ?? this.cfg.epoch;
  }

  private async save(): Promise<void> {
    // 原子写入：避免进程在写入途中被杀导致 clock.json 损坏（那会让世界时间归零）
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state));
    await fs.rename(tmp, this.file);
  }

  /** 运行中周期性落盘，进程被强杀时最多丢失一个检查点间隔的世界时间 */
  private startCheckpoints(): void {
    this.stopCheckpoints();
    this.checkpointTimer = setInterval(() => {
      void this.checkpoint().catch(() => {});
    }, CHECKPOINT_MS);
    this.checkpointTimer.unref?.();
  }

  private stopCheckpoints(): void {
    if (this.checkpointTimer !== null) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
  }

  private async checkpoint(): Promise<void> {
    if (!this.running) return;
    this.state.accumulatedTU = this.now();
    this.state.runningSince = Date.now();
    await this.save();
  }

  get running(): boolean {
    return this.state.runningSince !== null;
  }

  /** 当前世界时刻（Time Unit，浮点） */
  now(): number {
    const extra =
      this.state.runningSince === null
        ? 0
        : (Date.now() - this.state.runningSince) / 1000 / this.cfg.realSecondsPerUnit;
    return this.state.accumulatedTU + extra;
  }

  async resume(): Promise<void> {
    if (!this.running) {
      this.state.runningSince = Date.now();
      await this.save();
    }
    this.startCheckpoints();
  }

  async pause(): Promise<void> {
    this.stopCheckpoints();
    if (this.running) {
      this.state.accumulatedTU = this.now();
      this.state.runningSince = null;
      await this.save();
    }
  }

  /** 归零并重新采用当前配置的世界初始时刻（仅创世/重置时调用） */
  async reset(): Promise<void> {
    this.stopCheckpoints();
    this.state = { accumulatedTU: 0, runningSince: null, epoch: this.cfg.epoch };
    await this.save();
  }

  /** 手动推进世界时间（用于 rest 等"时间跳跃"） */
  async advance(units: number): Promise<void> {
    this.state.accumulatedTU += units;
    await this.save();
  }

  /** 距世界时刻 tu 还有多少现实毫秒 */
  realMsUntil(tu: number): number {
    return Math.max(0, (tu - this.now()) * this.cfg.realSecondsPerUnit * 1000);
  }

  /** 世界时钟的可读时间字符串 */
  clockString(tu = this.now()): string {
    const epochMs = new Date(this.epoch.replace(" ", "T")).getTime();
    const base = Number.isNaN(epochMs) ? Date.parse("2026-01-01T08:00") : epochMs;
    const d = new Date(base + tu * this.cfg.worldSecondsPerUnit * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 例如 `T=12.5（世界时间 2026-01-01 20:30）` */
  timeLine(tu = this.now()): string {
    return `T=${tu.toFixed(1)}（世界时间 ${this.clockString(tu)}）`;
  }
}
