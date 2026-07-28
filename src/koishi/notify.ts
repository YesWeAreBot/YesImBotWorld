import { promises as fs } from "node:fs";

interface NotifyPersist {
  allow: string[];
  deny: string[];
}

/**
 * Allow Notification 频道列表管理。
 *
 * - 默认（botManagedNotifyChannels 关闭）：直接使用用户配置的列表，行为与旧版一致；
 * - 开启 Bot 自管后：用户配置只是**初始值**（首次运行时播种），此后由 Bot 用
 *   channel_notify 工具增删，持久化到 notify.json。
 *   允许集支持 "*"（所有频道），deny 集在其上打洞（对 "*" 的免打扰豁免）。
 */
export class NotifyManager {
  private allow = new Set<string>();
  private deny = new Set<string>();
  private loaded = false;

  constructor(
    private file: string,
    /** 用户配置的初始列表 */
    private initial: string[],
    /** 是否允许 Bot 自己管理列表（关闭时完全按配置走，不读写文件） */
    private managed: boolean,
  ) {}

  get botManaged(): boolean {
    return this.managed;
  }

  async load(): Promise<void> {
    if (!this.managed) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as NotifyPersist;
      this.allow = new Set(Array.isArray(raw.allow) ? raw.allow.map(String) : []);
      this.deny = new Set(Array.isArray(raw.deny) ? raw.deny.map(String) : []);
      this.loaded = true;
    } catch {
      // 首次运行：以用户配置播种
      await this.reset();
    }
  }

  private async save(): Promise<void> {
    const data: NotifyPersist = { allow: [...this.allow], deny: [...this.deny] };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, this.file);
  }

  /** 重置为用户配置的初始值（world.reset 时调用） */
  async reset(): Promise<void> {
    this.allow = new Set(this.initial);
    this.deny = new Set();
    this.loaded = true;
    if (this.managed) await this.save().catch(() => {});
  }

  /** 该频道的消息是否投递通知 */
  isNotifyChannel(key: string): boolean {
    if (!this.managed || !this.loaded) {
      return this.initial.includes("*") || this.initial.includes(key);
    }
    if (this.deny.has(key)) return false;
    return this.allow.has("*") || this.allow.has(key);
  }

  /** Bot 开启/关闭某频道的通知（仅自管模式） */
  async set(key: string, allow: boolean): Promise<void> {
    if (!this.managed) return;
    if (allow) {
      this.deny.delete(key);
      if (!this.allow.has("*")) this.allow.add(key);
    } else {
      this.allow.delete(key);
      this.deny.add(key);
    }
    await this.save().catch(() => {});
  }

  /** 展示用：当前列表摘要 */
  statusText(): string {
    if (!this.managed) return this.initial.join("、") || "（无）";
    const allow = [...this.allow].join("、") || "（无）";
    const deny = this.deny.size ? `；免打扰：${[...this.deny].join("、")}` : "";
    return allow + deny;
  }
}
