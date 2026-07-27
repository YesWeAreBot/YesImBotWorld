import { promises as fs } from "node:fs";
import { type CalendarSpec, formatDateMs, formatWorldTime, gregorian } from "./calendar.js";
import type { ClockConfigData } from "./config.js";

interface ClockPersist {
  accumulatedTU: number;
  /**
   * 时间流逝中：accumulatedTU 所对应的现实时间戳锚点（ms）。
   * 显式暂停（world.stop）时为 null。
   * 插件离线（进程退出/崩溃）不会清空它——离线期间世界时间照常流逝，
   * 下次 load 时用同一锚点即可补回离线时段。
   * 同步模式下它只充当"进程最后存活时刻"的标记（now() 不依赖它）。
   */
  runningSince: number | null;
  /** 同步模式：T=0 对应的现实时间戳（ms），创世时记录 */
  genesisMs?: number;
  /** 世界历法：创世时由 World-LLM 依据世界定义与配置的初始时刻生成，此后持久化保存 */
  calendar?: CalendarSpec;
  /** 旧版字段：世界初始时刻字符串（load 时迁移为 gregorian 历法） */
  epoch?: string;
}

/** 运行中周期性落盘的间隔（ms）：进程存活状态最多滞后这么多现实时间 */
const CHECKPOINT_MS = 30_000;

/** 同步模式下固定的换算关系：1 TU = 60 现实秒 = 60 世界秒 */
const SYNC_SECONDS_PER_UNIT = 60;

/**
 * World Clock：维护世界时间（以 Time Unit 计）。
 *
 * - TU 是现实与虚拟世界时间换算的桥梁：
 *   1 TU = realSecondsPerUnit 现实秒 = worldSecondsPerUnit 世界秒。
 * - **同步模式（syncRealTime，默认开启）**：世界时钟即现实时钟，T=0 锚定在创世的现实时刻，
 *   1 TU 固定为 60 秒；无视 epoch 与流速配置，时间无法冻结（pause 只标记离线起点）。
 * - 独立时间线模式：T=0 对应世界初始时刻（epoch）；TU → 可读的世界时间由历法（CalendarSpec）
 *   确定性换算，历法在创世时由 World-LLM 依据世界定义生成并持久化，之后不受配置变更影响。
 *   时间只有在显式暂停（world.stop）时才冻结；插件停止/Koishi 关闭期间照常流逝，
 *   下次启动时通过持久化的现实时间锚点补回离线时段（可经 consumeOfflineGap 获知离线了多久）。
 * - 运行中每 CHECKPOINT_MS 落盘一次检查点；崩溃时离线起点最多提前一个检查点间隔。
 */
export class WorldClock {
  private state: ClockPersist = { accumulatedTU: 0, runningSince: null };
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  /** 本次进程启动时，上次退出时刻的世界时间（仅当上次退出时世界正在运行） */
  private offlineFromTU: number | null = null;

  constructor(
    private cfg: ClockConfigData,
    private file: string,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as ClockPersist;
      if (typeof raw.accumulatedTU === "number") this.state = raw;
      // 上次进程退出时世界正在运行（正常 suspend 或崩溃皆同）：
      // 离线期间时间照常流逝（now() 沿用持久化的锚点自动补回），
      // 记下离线起点，供唤醒 Bot 时告知/补叙
      if (this.state.runningSince !== null) {
        this.offlineFromTU = this.state.accumulatedTU;
      }
    } catch {
      /* 首次运行，使用默认值 */
    }
    let dirty = false;
    // 同步模式而 genesisMs 缺失（首次运行 / 从独立时间线切换过来）：
    // 以「当前现实时刻 = 已累计的 TU」反推创世锚点，TU 计数保持连续
    if (this.cfg.syncRealTime && this.state.genesisMs === undefined) {
      this.state.genesisMs = Date.now() - this.state.accumulatedTU * SYNC_SECONDS_PER_UNIT * 1000;
      dirty = true;
    }
    // 旧版 clock.json 只有 epoch 字符串：迁移为公历历法（新世界则回退到配置值）
    if (!this.state.calendar) {
      this.state.calendar = gregorian(this.state.epoch ?? this.cfg.epoch);
      dirty = true;
    }
    if (dirty) await this.save();
  }

  /** 世界时间是否与现实同步 */
  get syncRealTime(): boolean {
    return this.cfg.syncRealTime;
  }

  /** 1 TU 等于多少现实秒（同步模式固定 60） */
  get unitRealSeconds(): number {
    return this.cfg.syncRealTime ? SYNC_SECONDS_PER_UNIT : this.cfg.realSecondsPerUnit;
  }

  /** 1 TU 等于多少世界秒（同步模式固定 60） */
  get unitWorldSeconds(): number {
    return this.cfg.syncRealTime ? SYNC_SECONDS_PER_UNIT : this.cfg.worldSecondsPerUnit;
  }

  /** 当前生效的世界历法 */
  get calendar(): CalendarSpec {
    return this.state.calendar ?? gregorian(this.cfg.epoch);
  }

  /** 采用新的历法（创世时由 World-LLM 生成后调用） */
  async setCalendar(spec: CalendarSpec): Promise<void> {
    this.state.calendar = spec;
    await this.save();
  }

  /** 用户在配置里填写的世界初始时刻（自由文本，创世时交给 World-LLM 解读） */
  get configuredEpoch(): string {
    return this.cfg.epoch;
  }

  private async save(): Promise<void> {
    // 原子写入：避免进程在写入途中被杀导致 clock.json 损坏（那会让世界时间归零）
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state));
    await fs.rename(tmp, this.file);
  }

  /** 运行中周期性落盘：崩溃时离线起点最多比实际提前一个检查点间隔 */
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

  /** 时间是否在流逝（同步模式恒为真；独立时间线模式下显式暂停时为假） */
  get running(): boolean {
    return this.cfg.syncRealTime || this.state.runningSince !== null;
  }

  /** 同步模式的创世锚点（T=0 对应的现实时间戳，ms） */
  private get genesisMs(): number {
    return this.state.genesisMs ?? Date.now();
  }

  /** 当前世界时刻（Time Unit，浮点） */
  now(): number {
    if (this.cfg.syncRealTime) {
      return (Date.now() - this.genesisMs) / 1000 / SYNC_SECONDS_PER_UNIT;
    }
    const extra =
      this.state.runningSince === null
        ? 0
        : (Date.now() - this.state.runningSince) / 1000 / this.cfg.realSecondsPerUnit;
    return this.state.accumulatedTU + extra;
  }

  async resume(): Promise<void> {
    if (this.state.runningSince === null) {
      this.state.runningSince = Date.now();
      if (this.cfg.syncRealTime) this.state.accumulatedTU = this.now();
      await this.save();
    } else {
      // 时间本就在流逝（离线补回的状态）：刷新一次检查点
      await this.checkpoint();
    }
    this.startCheckpoints();
  }

  /**
   * 显式暂停（world.stop）：独立时间线模式下冻结世界时间。
   * 同步模式下时间无法冻结，只落盘并标记离线起点——
   * 之后 world.start 时可经 consumeOfflineGap 得知停止期间流逝了多久。
   */
  async pause(): Promise<void> {
    this.stopCheckpoints();
    if (this.state.runningSince === null) return;
    this.state.accumulatedTU = this.now();
    if (this.cfg.syncRealTime) {
      this.state.runningSince = Date.now();
      this.offlineFromTU = this.state.accumulatedTU;
    } else {
      this.state.runningSince = null;
    }
    await this.save();
  }

  /**
   * 插件停止（进程退出/重载）时调用：与 pause 不同，时间在离线期间继续流逝。
   * 只做最终检查点，保留现实时间锚点供下次 load 补回离线时段。
   */
  async suspend(): Promise<void> {
    this.stopCheckpoints();
    if (this.state.runningSince !== null) {
      this.state.accumulatedTU = this.now();
      this.state.runningSince = Date.now();
      await this.save();
    }
  }

  /**
   * 取出「Bot 上次停止运行 → 现在」流逝的世界时间（只能取一次）。
   * 停止期间时间被冻结（独立时间线模式的显式暂停）、或本次是首次运行时返回 null。
   */
  consumeOfflineGap(): { fromTU: number; gapTU: number } | null {
    if (this.offlineFromTU === null) return null;
    const fromTU = this.offlineFromTU;
    this.offlineFromTU = null;
    const gapTU = this.now() - fromTU;
    return gapTU > 0 ? { fromTU, gapTU } : null;
  }

  /** 归零（仅创世/重置时调用）。历法暂回退为配置值，创世时会由 World-LLM 重新生成 */
  async reset(): Promise<void> {
    this.stopCheckpoints();
    this.offlineFromTU = null;
    this.state = {
      accumulatedTU: 0,
      runningSince: null,
      genesisMs: Date.now(),
      calendar: gregorian(this.cfg.epoch),
    };
    await this.save();
  }

  /** 手动推进世界时间（用于 rest 等"时间跳跃"）。同步模式下无效 */
  async advance(units: number): Promise<void> {
    if (this.cfg.syncRealTime) return;
    this.state.accumulatedTU += units;
    await this.save();
  }

  /** 距世界时刻 tu 还有多少现实毫秒 */
  realMsUntil(tu: number): number {
    return Math.max(0, (tu - this.now()) * this.unitRealSeconds * 1000);
  }

  /** 世界时钟的可读时间字符串（同步模式即现实时钟；否则按持久化的历法换算） */
  clockString(tu = this.now()): string {
    if (this.cfg.syncRealTime) {
      return formatDateMs(this.genesisMs + tu * SYNC_SECONDS_PER_UNIT * 1000);
    }
    return formatWorldTime(this.calendar, tu * this.cfg.worldSecondsPerUnit);
  }

  /** 例如 `T=12.5（世界时间 2026-01-01 20:30）` */
  timeLine(tu = this.now()): string {
    return `T=${tu.toFixed(1)}（世界时间 ${this.clockString(tu)}）`;
  }
}
