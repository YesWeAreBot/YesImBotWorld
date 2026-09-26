import { promises as fs } from "node:fs";
import { legacyChannelKey } from "./channels.js";
import type { WorldMessageRow } from "./messages.js";

export type PhoneNotificationMode = "vibrate" | "silent" | "off";
interface UnreadMessage {
  id: string;
  recordId: number;
  timestamp: string;
  sender: string;
  preview: string;
  notification: boolean;
}
interface ChannelReading { seen: string[]; unread: UnreadMessage[] }
export interface NotificationPolicy {
  id: string;
  enabled: boolean;
  muted: boolean;
  mutedUntil?: number;
  mutedUntilText?: string;
}
export interface NotificationClock { now: number; unitWorldSeconds: number; format: (tu: number) => string }
export interface NotifyManagerOptions { appsManaged?: boolean; clock?: () => NotificationClock }
export interface PhoneNotificationsSnapshot {
  calendarKind?: "gregorian" | "custom";
  mode: PhoneNotificationMode;
  managed: boolean;
  appsManaged: boolean;
  apps: NotificationPolicy[];
  unread: number;
  count: number;
  channels: { key: string; unread: number; notifications: number; enabled: boolean; muted: boolean; mutedUntil?: number; mutedUntilText?: string; latest?: Omit<UnreadMessage, "notification"> }[];
}

interface NotifyPersist {
  version?: number;
  apps?: Record<string, { enabled: boolean; mutedUntil?: number }>;
  channelMutes?: Record<string, number>;
  allow: string[];
  deny: string[];
  mode?: PhoneNotificationMode;
  readings?: Record<string, ChannelReading>;
}

/** Notification policies are persistent device state; management flags grant write
 * access to the character. App and channel policies independently gate delivery,
 * never unread accounting or a conversation already visible on screen. */
export class NotifyManager {
  private allow = new Set<string>();
  private deny = new Set<string>();
  private loaded = false;
  private loading?: Promise<void>;
  private changes = Promise.resolve();
  private mode: PhoneNotificationMode = "vibrate";
  private apps = new Map<string, { enabled: boolean; mutedUntil?: number }>();
  private channelMutes = new Map<string, number>();
  private readings = new Map<string, { seen: Set<string>; unread: Map<string, UnreadMessage> }>();

  constructor(
    private file: string,
    /** 用户配置的初始列表 */
    private initial: string[],
    /** 是否允许角色修改频道通知策略。 */
    private managed: boolean,
    private options: NotifyManagerOptions = {},
  ) {}

  get botManaged(): boolean {
    return this.managed;
  }

  get appsBotManaged(): boolean { return this.options.appsManaged ?? this.managed; }

  /** 当前允许通知的频道 key 列表（含 "*" 全频道通配） */
  keys(): string[] {
    if (!this.loaded) return [...this.initial];
    if (this.allow.has("*")) return ["*"];
    return [...this.allow];
  }

  load(force = false): Promise<void> {
    if (force) {
      const reload = this.changes.then(async () => { await this.loading; await this.restore(); });
      this.changes = reload.catch(() => {});
      return reload;
    }
    if (this.loaded) return Promise.resolve();
    return this.loading ??= this.restore();
  }
  private async restore(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as NotifyPersist;
      this.allow = new Set(Array.isArray(raw.allow) ? raw.allow.map(String) : []);
      this.deny = new Set(Array.isArray(raw.deny) ? raw.deny.map(String) : []);
      // Before v2, disabling character management made the config list authoritative.
      // Preserve that effective policy once; thereafter permission changes cannot
      // silently discard either character or operator settings.
      if (raw.version !== 2 && !this.managed) { this.allow = new Set(this.initial); this.deny.clear(); }
      this.apps = new Map(Object.entries(raw.apps ?? {}).filter(([id, value]) => id && value && typeof value.enabled === "boolean")
        .map(([id, value]) => [id, { enabled: value.enabled, ...(Number.isFinite(value.mutedUntil) ? { mutedUntil: value.mutedUntil } : {}) }]));
      this.channelMutes = new Map(Object.entries(raw.channelMutes ?? {}).filter(([, until]) => Number.isFinite(until)));
      this.mode = ["vibrate", "silent", "off"].includes(raw.mode ?? "") ? raw.mode! : "vibrate";
      this.readings = new Map(Object.entries(raw.readings ?? {}).map(([key, value]) => [key, {
        seen: new Set(Array.isArray(value?.seen) ? value.seen.filter(id => typeof id === "string") : []),
        unread: new Map((Array.isArray(value?.unread) ? value.unread : []).filter(item => item && typeof item.id === "string").map(item => [item.id, item])),
      }]));
      this.loaded = true;
      if (raw.version !== 2) await this.save().catch(() => {});
    } catch {
      // 首次运行：以用户配置播种
      this.seed();
      await this.save().catch(() => {});
    }
  }

  private async save(allow = this.allow, deny = this.deny): Promise<void> {
    const data: NotifyPersist = { version: 2, allow: [...allow], deny: [...deny], mode: this.mode,
      apps: Object.fromEntries(this.apps), channelMutes: Object.fromEntries(this.channelMutes),
      readings: Object.fromEntries([...this.readings].map(([key, value]) => [key, { seen: [...value.seen], unread: [...value.unread.values()] }])) };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, this.file);
  }

  /** 重置为用户配置的初始值（world.reset 时调用） */
  private seed(): void {
    this.allow = new Set(this.initial);
    this.deny = new Set();
    this.mode = "vibrate";
    this.apps.clear(); this.channelMutes.clear();
    this.readings.clear();
    this.loaded = true;
  }
  reset(): Promise<void> {
    return this.enqueue(() => this.seed());
  }

  private clock(): NotificationClock {
    return this.options.clock?.() ?? { now: Date.now() / 1000, unitWorldSeconds: 1, format: tu => new Date(tu * 1000).toISOString() };
  }
  private muteDeadline(seconds: number | undefined): number | undefined {
    if (seconds === undefined || seconds === 0) return undefined;
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("免打扰时长须为非负秒数。");
    const clock = this.clock();
    if (!Number.isFinite(clock.now) || !Number.isFinite(clock.unitWorldSeconds) || clock.unitWorldSeconds <= 0) throw new Error("世界时钟暂不可用。");
    const deadline = clock.now + seconds / clock.unitWorldSeconds;
    if (!Number.isFinite(deadline) || deadline <= clock.now) throw new Error("免打扰时长超出世界时钟可表示的范围。");
    return deadline;
  }
  private activeMute(until: number | undefined): Pick<NotificationPolicy, "muted" | "mutedUntil" | "mutedUntilText"> {
    const clock = this.clock();
    return until !== undefined && until > clock.now
      ? { muted: true, mutedUntil: until, mutedUntilText: clock.format(until) }
      : { muted: false };
  }
  private channelEnabled(key: string): boolean {
    const legacy = legacyChannelKey(key);
    if (!this.loaded) return this.initial.includes("*") || this.initial.includes(key) || this.initial.includes(legacy);
    if (this.deny.has(key)) return false;
    if (this.allow.has(key)) return true;
    if (this.deny.has(legacy)) return false;
    return this.allow.has("*") || this.allow.has(legacy);
  }
  private channelPolicy(key: string) {
    const legacy = legacyChannelKey(key);
    // An explicit account deadline (including zero) overrides a migrated legacy key.
    const until = this.channelMutes.get(key) ?? this.channelMutes.get(legacy);
    return { enabled: this.channelEnabled(key), ...this.activeMute(until) };
  }
  /** Channel-level policy only. App permission is checked separately at delivery. */
  isNotifyChannel(key: string): boolean {
    const policy = this.channelPolicy(key);
    return policy.enabled && !policy.muted;
  }
  async set(key: string, allow: boolean | undefined, muteSeconds?: number, operator = false): Promise<void> {
    if (!this.managed && !operator) throw new Error("频道通知由管理员配置，当前不能自行修改。");
    if (!key.trim()) throw new Error("频道不能为空。");
    if (allow !== undefined && typeof allow !== "boolean") throw new Error("allow 须为 true 或 false。");
    if (allow === undefined && muteSeconds === undefined) throw new Error("请指定通知开关或免打扰时长。");
    this.muteDeadline(muteSeconds);
    return this.enqueue(() => {
      if (muteSeconds !== undefined) this.channelMutes.set(key, this.muteDeadline(muteSeconds) ?? 0);
      // A duration alone preserves the base policy; an explicit permission also updates it.
      if (allow !== undefined) {
        if (allow) { this.deny.delete(key); this.allow.add(key); }
        else { this.allow.delete(key); this.deny.add(key); }
      }
    });
  }
  appPolicy(appId: string): NotificationPolicy {
    const policy = this.apps.get(appId);
    return { id: appId, enabled: policy?.enabled ?? true, ...this.activeMute(policy?.mutedUntil) };
  }
  async setApp(appId: string, enabled: boolean | undefined, muteSeconds?: number, operator = false): Promise<void> {
    if (!this.appsBotManaged && !operator) throw new Error("应用通知由管理员配置，当前不能自行修改。");
    if (!appId.trim()) throw new Error("应用不能为空。");
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("enabled 须为 true 或 false。");
    if (enabled === undefined && muteSeconds === undefined) throw new Error("请指定通知开关或免打扰时长。");
    this.muteDeadline(muteSeconds);
    return this.enqueue(() => {
      const previous = this.apps.get(appId) ?? { enabled: true };
      const next = { ...previous };
      if (muteSeconds !== undefined) next.mutedUntil = this.muteDeadline(muteSeconds);
      if (enabled !== undefined) next.enabled = enabled;
      this.apps.set(appId, next);
    });
  }
  channelStatusText(key: string): string {
    const policy = this.channelPolicy(key), app = this.appPolicy("chat");
    const restrictions: string[] = [];
    if (this.mode === "off") restrictions.push("手机通知已关闭");
    else if (this.mode === "silent") restrictions.push("手机已静音");
    if (!app.enabled) restrictions.push("本应用通知已关闭");
    else if (app.muted) restrictions.push(`本应用免打扰至 ${app.mutedUntilText}`);
    return `频道通知：${policy.enabled ? "开启" : "免打扰"}${policy.muted ? `，免打扰至 ${policy.mutedUntilText}` : ""}；未读 ${this.unreadCount(key)} 条${restrictions.length ? `（${restrictions.join("；")}）` : ""}。`;
  }
  get notificationMode(): PhoneNotificationMode { return this.mode; }
  allowsAppNotification(appId: string): boolean { const policy = this.appPolicy(appId); return this.mode !== "off" && policy.enabled && !policy.muted; }
  appVibrates(appId: string): boolean { return this.mode === "vibrate" && this.allowsAppNotification(appId); }
  allowsNotification(key: string): boolean { return this.allowsAppNotification("chat") && this.isNotifyChannel(key); }
  vibrates(key?: string): boolean { return this.appVibrates("chat") && (!key || this.isNotifyChannel(key)); }
  unreadCount(key: string): number { return this.readings.get(key)?.unread.size ?? 0; }

  private reading(key: string) {
    let value = this.readings.get(key);
    if (!value) { value = { seen: new Set<string>(), unread: new Map<string, UnreadMessage>() }; this.readings.set(key, value); }
    return value;
  }
  private enqueue(update: () => void): Promise<void> {
    const change = this.changes.then(async () => {
      await this.load();
      const oldMode = this.mode, oldReadings = structuredClone(this.readings), oldAllow = new Set(this.allow), oldDeny = new Set(this.deny),
        oldApps = structuredClone(this.apps), oldMutes = new Map(this.channelMutes);
      try { update(); await this.save(); }
      catch (error) { this.mode = oldMode; this.readings = oldReadings; this.allow = oldAllow; this.deny = oldDeny; this.apps = oldApps; this.channelMutes = oldMutes; throw error; }
    });
    this.changes = change.catch(() => {});
    return change;
  }
  /** Only newly received live messages enter the unread ledger; history imports never do. */
  receive(key: string, row: WorldMessageRow, eligible = this.allowsNotification(key)): Promise<void> {
    if (row.self || row.orderSource === "history" || row.orderSource === "history-unanchored") return Promise.resolve();
    return this.enqueue(() => {
      const value = this.reading(key), id = messageIdentity(row);
      if (value.seen.has(id) || value.unread.has(id)) return;
      const observedAt = new Date(row.observedAt ?? row.timestamp);
      value.unread.set(id, { id, recordId: row.id, timestamp: Number.isFinite(observedAt.getTime()) ? observedAt.toISOString() : new Date().toISOString(),
        sender: row.username || row.userId, preview: row.content.slice(0, 100), notification: eligible && this.allowsNotification(key) });
    });
  }
  /** A displayed slice reads exactly its messages, never unseen later arrivals or another account. */
  markSeen(key: string, rows: Pick<WorldMessageRow, "id" | "messageId">[]): Promise<void> {
    if (!rows.length) return Promise.resolve();
    return this.enqueue(() => {
      const value = this.reading(key);
      for (const row of rows) { const id = messageIdentity(row); value.seen.add(id); value.unread.delete(id); }
    });
  }
  /** A recall changes an existing unread preview without inventing a new unread message. */
  updatePreview(key: string, row: Pick<WorldMessageRow, "id" | "messageId" | "content">): Promise<void> {
    return this.enqueue(() => {
      const pending = this.readings.get(key)?.unread.get(messageIdentity(row));
      if (pending) pending.preview = row.content.slice(0, 100);
    });
  }
  markRead(key?: string): Promise<void> {
    return this.enqueue(() => {
      for (const [channel, value] of this.readings) if (!key || channel === key) {
        for (const id of value.unread.keys()) value.seen.add(id);
        value.unread.clear();
      }
    });
  }
  /** Explicitly deleting chat history also deletes unread references, keeping notification policy. */
  clearMessages(): Promise<void> { return this.enqueue(() => { this.readings.clear(); }); }
  clearNotifications(key?: string): Promise<void> {
    return this.enqueue(() => {
      for (const [channel, value] of this.readings) if (!key || channel === key)
        for (const row of value.unread.values()) row.notification = false;
    });
  }
  setMode(mode: PhoneNotificationMode, operator = false): Promise<void> {
    if (!this.appsBotManaged && !operator) return Promise.reject(new Error("手机通知由管理员配置，当前不能自行修改。"));
    if (!["vibrate", "silent", "off"].includes(mode)) return Promise.reject(new Error("通知模式须为 vibrate、silent 或 off。"));
    return this.enqueue(() => { this.mode = mode; });
  }
  snapshot(knownKeys: string[] = [], knownAppIds: string[] = []): PhoneNotificationsSnapshot {
    const channels = [...new Set([...this.readings.keys(), ...knownKeys, ...this.allow, ...this.deny, ...this.channelMutes.keys()])].filter(key => key !== "*").map(key => {
      const value = this.readings.get(key) ?? { unread: new Map<string, UnreadMessage>() };
      const latest = [...value.unread.values()].at(-1);
      return { key, unread: value.unread.size, notifications: [...value.unread.values()].filter(item => item.notification).length,
        ...this.channelPolicy(key), ...(latest ? { latest: { id: latest.id, recordId: latest.recordId, timestamp: latest.timestamp, sender: latest.sender, preview: latest.preview } } : {}) };
    });
    return { mode: this.mode, managed: this.managed, appsManaged: this.appsBotManaged,
      apps: [...new Set(["chat", ...knownAppIds, ...this.apps.keys()])].map(id => this.appPolicy(id)), unread: channels.reduce((sum, row) => sum + row.unread, 0),
      count: channels.reduce((sum, row) => sum + row.notifications, 0), channels };
  }
  async operate(args: { action?: string; id?: string; mode?: string }): Promise<string> {
    const action = args.action ?? "list";
    if (args.id !== undefined && (typeof args.id !== "string" || !args.id.trim())) throw new Error("id 须为完整的非空频道标识；省略时处理全部会话。");
    if (action === "mode") throw new Error("请在设置应用中调整通知模式。");
    if (action === "clear") { await this.clearNotifications(args.id); return "通知已清除，未读消息仍保留。"; }
    if (action === "read") { await this.markRead(args.id); return "已将所选会话标为已读。"; }
    if (action !== "list") throw new Error("action 须为 list、clear 或 read。");
    const view = this.snapshot();
    return `手机通知：${{ vibrate: "振动", silent: "静音（不振动、不唤醒）", off: "关闭（会话内仍可读消息）" }[view.mode]}；${view.count} 条通知，${view.unread} 条未读。` +
      view.channels.filter(row => row.unread).map(row => `\n- ${row.key}：${row.unread} 条未读${!row.enabled ? "，通知关闭" : row.muted ? `，免打扰至 ${row.mutedUntilText}` : ""}${row.notifications ? `，${row.notifications} 条通知` : ""}`).join("");
  }

  /** 展示用：当前列表摘要 */
  statusText(): string {
    const allow = [...this.allow].join("、") || "（无）";
    const deny = this.deny.size ? `；免打扰：${[...this.deny].join("、")}` : "";
    return allow + deny;
  }
}

function messageIdentity(row: Pick<WorldMessageRow, "id" | "messageId">): string {
  return row.messageId ? `msg:${row.messageId}` : `row:${row.id}`;
}
