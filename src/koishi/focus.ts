import { promises as fs } from "node:fs";

interface FocusPersist {
  /** 频道 key（"platform:channelId"）→ 关注到期的世界时刻（TU） */
  channels: Record<string, number>;
}

/**
 * 关注频道管理：Bot 打开某个频道（select_channel）或向其发送消息/图片/文件/语音后，
 * 视为正在关注该频道。关注期间来自该频道的消息无视通知策略（notifyPolicy 与
 * notifyChannels），必定以完整内容呈现给 Bot；直到超时或 Bot 用 put_down_phone 放下手机。
 *
 * 到期时间以世界时钟（TU）计：世界暂停时关注也随之冻结。状态持久化到 focus.json。
 */
export class FocusManager {
  private channels = new Map<string, number>();

  constructor(
    private file: string,
    /** 当前世界时刻（TU） */
    private now: () => number,
    /** 每次关注持续的 TU 数；<= 0 表示禁用关注机制 */
    private durationTU: number,
  ) {}

  get enabled(): boolean {
    return this.durationTU > 0;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as FocusPersist;
      if (raw && typeof raw.channels === "object" && raw.channels !== null) {
        this.channels = new Map(
          Object.entries(raw.channels).filter(([, until]) => typeof until === "number"),
        );
      }
    } catch {
      /* 首次运行 */
    }
  }

  private async save(): Promise<void> {
    const data: FocusPersist = { channels: Object.fromEntries(this.channels) };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, this.file);
  }

  /** 标记（或续期）对某频道的关注 */
  async focus(key: string): Promise<void> {
    if (!this.enabled || !key) return;
    this.prune();
    this.channels.set(key, this.now() + this.durationTU);
    await this.save().catch(() => {});
  }

  isFocused(key: string): boolean {
    const until = this.channels.get(key);
    return until !== undefined && this.now() < until;
  }

  /** 当前仍在关注的频道列表 */
  activeKeys(): string[] {
    const t = this.now();
    return [...this.channels.entries()].filter(([, until]) => t < until).map(([key]) => key);
  }

  /** 放下手机：清除全部关注，返回清除前仍在关注的频道 */
  async clear(): Promise<string[]> {
    const active = this.activeKeys();
    this.channels.clear();
    await this.save().catch(() => {});
    return active;
  }

  private prune(): void {
    const t = this.now();
    for (const [key, until] of this.channels) {
      if (until <= t) this.channels.delete(key);
    }
  }
}
