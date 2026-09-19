import type { Context } from "koishi";
import { channelKey } from "./channels.js";
import type { ConversationContext } from "./conversation.js";
import { orderBetween } from "./message-order.js";

export interface MessageOrderTicket { observedAt: Date; key: Promise<string> }

declare module "koishi" {
  interface Tables {
    yesimbot_world_message: WorldMessageRow;
  }
}

export interface KnownChannel {
  key: string;
  platform: string;
  channelId: string;
  selfId?: string;
  /** 是否为私聊（direct）：来自入站 session.isDirect 的权威标记，可靠于 channelId 字符串猜测 */
  isDirect: boolean;
  participants: { userId: string; username: string }[];
}

export interface WorldMessageRow {
  id: number;
  platform: string;
  channelId: string;
  /** 接收/发送该消息的 Bot 账号；旧记录为空，仅在单账号部署中兼容归属。 */
  selfId?: string;
  guildId: string;
  userId: string;
  username: string;
  content: string;
  timestamp: Date;
  timestampSource?: "platform" | "local-confirmed" | "local-observed" | "legacy-unknown" | null;
  observedAt?: Date | null;
  timelineKey?: string | null;
  orderSource?: "live" | "history" | "history-unanchored" | "legacy" | null;
  platformSequence?: string | null;
  self: boolean;
  /** Confirmed transport provenance, independent of nickname and voluntary authorship. */
  senderOrigin?: "tool" | "external" | "unknown" | null;
  /** Whether this sender was a connected role account when observed; null = unknown. */
  senderOwned?: boolean | null;
  /** 平台侧消息 id（用于 unsend / react），可能为空 */
  messageId: string;
  /**
   * 是否为私聊（direct）。入站时来自 session.isDirect（平台权威信号）；
   * 旧数据/历史拉取可能缺失，读取方以 undefined/null 为"未知"，回退 channelId 的 private: 前缀。
   */
  isDirect?: boolean;
  /** 入站消息的会话类型、真实 @ / 引用对象与媒体形态；旧记录为未知。 */
  conversation?: ConversationContext | null;
}

/**
 * 消息存储：无论收到什么消息都存起来（Koishi database）。
 * 为 check_msg / select_channel 提供查询。
 */
export class MessageStore {
  private initialized?: Promise<void>;
  private allocation = Promise.resolve();
  private lastKey = "";
  private receipts = new Map<string, MessageOrderTicket>();
  private writes = Promise.resolve();

  private write<T>(run: () => Promise<T>): Promise<T> {
    const result = this.writes.then(run);
    this.writes = result.then(() => {}, () => {});
    return result;
  }
  constructor(private ctx: Context) {
    ctx.model.extend(
      "yesimbot_world_message",
      {
        id: "unsigned",
        platform: "string(64)",
        channelId: "string(255)",
        selfId: { type: "string", length: 255, initial: "" },
        guildId: "string(255)",
        userId: "string(255)",
        username: "string(255)",
        content: "text",
        timestamp: "timestamp",
        timestampSource: { type: "string", length: 24, nullable: true },
        observedAt: { type: "timestamp", nullable: true },
        timelineKey: { type: "string", length: 1024, nullable: true },
        orderSource: { type: "string", length: 24, nullable: true },
        platformSequence: { type: "string", length: 64, nullable: true },
        self: "boolean",
        senderOrigin: { type: "string", length: 16, nullable: true },
        senderOwned: { type: "boolean", nullable: true },
        messageId: { type: "string", length: 255, initial: "" },
        isDirect: { type: "boolean", nullable: true },
        conversation: { type: "json", nullable: true },
      },
      { autoInc: true, primary: "id" },
    );
  }

  /** Additive, resumable migration. Never replace a historical timestamp or message.
   * Legacy history rows explicitly written by syncGroupHistory are kept separate;
   * older ambiguous rows cannot retrospectively acquire an invented receive time. */
  private ready(): Promise<void> {
    return this.initialized ??= (async () => {
      const rows = await this.ctx.database.get("yesimbot_world_message", {}, { fields: ["id", "timelineKey", "senderOrigin", "timestamp"] });
      for (let offset = 0; offset < rows.length; offset += 100) {
        await Promise.all(rows.slice(offset, offset + 100).map(async row => {
          let key = row.timelineKey;
          if (!key) {
            const history = row.senderOrigin === "unknown";
            key = history ? `1${String(Math.max(0, new Date(row.timestamp).getTime())).padStart(16, "0")}${String(row.id).padStart(16, "0")}5` : `5${String(row.id).padStart(20, "0")}5`;
            await this.ctx.database.set("yesimbot_world_message", { id: row.id }, { timelineKey: key, timestampSource: history ? "platform" : "legacy-unknown", orderSource: history ? "history-unanchored" : "legacy" });
          }
          if (key > this.lastKey) this.lastKey = key;
        }));
      }
    })();
  }

  /** Call synchronously at ingress/transport confirmation, before media/profile awaits. */
  captureLive(observedAt = new Date()): MessageOrderTicket {
    const key = this.allocation.then(async () => {
      await this.ready();
      // Fixed-width integer slots for live events avoid linear key growth on a
      // busy channel. Fractional suffixes are used only for bounded history gaps.
      const previous = BigInt(this.lastKey.slice(0, 24).padEnd(24, "0") || "0");
      const slot = (previous < 500000000000000000000000n ? 500000000000000000000000n : previous) + 1n;
      return this.lastKey = slot.toString().padStart(24, "0") + "5";
    });
    this.allocation = key.then(() => {}, () => {});
    return { observedAt, key };
  }

  captureReceipt(platform: string, channelId: string, selfId: string, messageId: string, observedAt = new Date()): MessageOrderTicket {
    const id = `${channelKey(platform, channelId, selfId)}\0${messageId}`;
    if (messageId && this.receipts.has(id)) return this.receipts.get(id)!;
    const ticket = this.captureLive(observedAt);
    if (messageId) {
      this.receipts.set(id, ticket);
      if (this.receipts.size > 4096) this.receipts.delete(this.receipts.keys().next().value!);
    }
    return ticket;
  }

  async store(row: Omit<WorldMessageRow, "id">, ticket = this.captureLive()): Promise<WorldMessageRow> {
    // Keep the database identity when the platform provides no message ID. A later
    // history read must identify this as the same experience as its live notification.
    const timelineKey = await ticket.key;
    return this.write(async () => {
      const existing = await this.findByMessageId(row.platform, row.channelId, row.messageId, row.selfId);
      return existing ?? this.ctx.database.create("yesimbot_world_message", { ...row,
        timelineKey, observedAt: ticket.observedAt,
        timestampSource: row.timestampSource ?? "local-observed", orderSource: "live" });
    });
  }

  /** Import a complete oldest-first platform page set. IDs are anchors, never clocks.
   * The fence is captured BEFORE fetching: concurrent live messages stay after it. */
  async importHistory(rows: Omit<WorldMessageRow, "id">[], fence: MessageOrderTicket): Promise<number> {
    await this.ready();
    const upperFence = await fence.key;
    return this.write(async () => {
      const existing = await Promise.all(rows.map(row => this.findByMessageId(row.platform, row.channelId, row.messageId, row.selfId)));
      const scope = rows[0];
      const recorded = scope ? await this.ctx.database.get("yesimbot_world_message", {
        platform: scope.platform, channelId: scope.channelId, ...this.accountFilter(scope.platform, scope.selfId),
      }, { fields: ["timelineKey", "platformSequence", "orderSource"] }) : [];
      const occupied = recorded.map(row => row.timelineKey!).filter(Boolean).sort();
      let added = 0;
      let left = "";
      for (let i = 0; i < rows.length; i++) {
        if (existing[i]) { left = existing[i]!.timelineKey!; continue; }
        const row = rows[i]!;
        const nextAnchor = existing.slice(i + 1).find(Boolean)?.timelineKey;
        let right = nextAnchor && nextAnchor < upperFence ? nextAnchor : upperFence;
        let anchored = !!left || existing.slice(i + 1).some(Boolean);
        // A previous import may have filled another part of this same gap. Its
        // recorded platform sequence remains evidence even if absent from this page.
        if (row.platformSequence) {
          const seq = BigInt(row.platformSequence);
          for (const item of recorded) {
            if (!item.platformSequence || !item.timelineKey || item.orderSource === "history-unanchored") continue;
            const other = BigInt(item.platformSequence);
            if (other < seq) { anchored = true; if (item.timelineKey > left) left = item.timelineKey; }
            if (other > seq) { anchored = true; if (item.timelineKey < right) right = item.timelineKey; }
          }
        }
        // Unmatched local rows may lie between platform anchors. Preserve their
        // order and never allocate their key or cross the pre-fetch live fence.
        if (!left && anchored) left = occupied.filter(key => key < right).at(-1) ?? "";
        const nextOccupied = occupied.find(key => key > left);
        if (nextOccupied && nextOccupied < right) right = nextOccupied;
        // Conflicting delivery/platform order is not evidence for a made-up placement.
        const safe = anchored && (!left || left < right);
        const timeKey = String(Math.max(0, new Date(row.timestamp).getTime())).padStart(16, "0");
        let key = safe ? orderBetween(left, right) : `0${row.platformSequence ? `1${row.platformSequence.padStart(64, "0")}` : `0${timeKey}`}${timeKey}5`;
        if (occupied.includes(key)) key = orderBetween(key, occupied.find(item => item > key) ?? "1");
        if (await this.findByMessageId(row.platform, row.channelId, row.messageId, row.selfId)) continue;
        const saved = await this.ctx.database.create("yesimbot_world_message", { ...row, timelineKey: key,
          timestampSource: "platform", observedAt: null, orderSource: safe ? "history" : "history-unanchored" });
        recorded.push({ timelineKey: saved.timelineKey, platformSequence: saved.platformSequence, orderSource: saved.orderSource });
        if (safe) left = key;
        occupied.push(key); occupied.sort();
        added++;
      }
      return added;
    });
  }

  private accountId(row: WorldMessageRow): string | undefined {
    if (row.selfId) return row.selfId;
    const accounts = [...new Set(this.ctx.bots.filter((b) => b.platform === row.platform).map((b) => b.selfId))];
    return accounts.length === 1 ? accounts[0] : undefined;
  }

  private accountFilter(platform: string, selfId?: string) {
    const accounts = [...new Set(this.ctx.bots.filter((b) => b.platform === platform).map((b) => b.selfId))];
    if (selfId) {
      return accounts.length === 1 && accounts[0] === selfId
        ? { selfId: { $in: [selfId, ""] } }
        : { selfId };
    }
    // 不知道接收账号的旧记录不与多账号的新记录合并。
    return accounts.length > 1 ? { selfId: "" } : {};
  }

  /** 清空全部消息记录（world.clearmsg / 创世时调用） */
  async clear(): Promise<void> {
    await this.ctx.database.remove("yesimbot_world_message", {});
    this.receipts.clear();
  }

  /** 最近活跃的 n 个频道及各自最新一条消息 */
  async recentChannels(n: number): Promise<{ key: string; latest: WorldMessageRow }[]> {
    await this.ready();
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      {},
      { sort: { timelineKey: "desc", id: "desc" }, limit: 500 },
    );
    const seen = new Map<string, WorldMessageRow>();
    for (const row of rows) {
      const key = channelKey(row.platform, row.channelId, this.accountId(row));
      if (!seen.has(key)) seen.set(key, row);
      if (seen.size >= n) break;
    }
    return [...seen.entries()].map(([key, latest]) => ({ key, latest }));
  }

  /**
   * 已知频道及各自的参与者（非自己），用于频道 id 的宽松解析纠错。
   * 基于最近的消息记录聚合，越活跃的频道排得越靠前。
   */
  async knownChannels(): Promise<KnownChannel[]> {
    await this.ready();
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      {},
      { sort: { timelineKey: "desc", id: "desc" }, limit: 1000 },
    );
    const map = new Map<string, KnownChannel>();
    for (const row of rows) {
      const selfId = this.accountId(row);
      const key = channelKey(row.platform, row.channelId, selfId);
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key,
          platform: row.platform,
          channelId: row.channelId,
          selfId,
          // 权威私聊标记：取该频道任意一条已明确记录的 isDirect（多数为 true 即私聊）
          // 也回退 channelId 的 private: 前缀（onebot 约定），保证旧数据/纯群历史兼容
          isDirect: row.isDirect ?? row.channelId.startsWith("private:"),
          participants: [],
        };
        map.set(key, entry);
      } else if (entry.isDirect !== true && row.isDirect === true) {
        entry.isDirect = true;
      }
      if (row.userId !== selfId && !entry.participants.some((p) => p.userId === row.userId)) {
        entry.participants.push({ userId: row.userId, username: row.username });
      }
    }
    return [...map.values()];
  }

  /** 按平台消息 id 查找某频道内的一条消息（用于引用回复时定位原发送人） */
  async findByMessageId(
    platform: string,
    channelId: string,
    messageId: string,
    selfId?: string,
  ): Promise<WorldMessageRow | null> {
    await this.ready();
    if (!messageId) return null;
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      { platform, channelId, messageId, ...this.accountFilter(platform, selfId) },
      { limit: 1 },
    );
    return rows[0] ?? null;
  }

  /**
   * 撤回改写：把已存消息的内容替换为撤回标记（如 "[某某 撤回了一条消息]"）。
   * 只改消息记录（影响此后翻记录时的呈现），不触碰 Bot 的上下文——
   * 已进入上下文的消息 Bot 自然记得内容，撤回只是让它知道"这条被对方收回了"。
   */
  async updateContent(id: number, content: string): Promise<void> {
    await this.ctx.database.set("yesimbot_world_message", { id }, { content });
  }

  /** 按平台消息 id 跨频道查找（view_forward 纠错：Bot 把消息编号当转发 id 时定位原消息） */
  async findAnyByMessageId(messageId: string): Promise<WorldMessageRow | null> {
    if (!messageId) return null;
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      { messageId },
      { limit: 1, sort: { id: "desc" } },
    );
    return rows[0] ?? null;
  }

  /** 某频道最近 n 条消息（时间正序返回） */
  async channelMessages(platform: string, channelId: string, n: number, selfId?: string): Promise<WorldMessageRow[]> {
    await this.ready();
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      { platform, channelId, ...this.accountFilter(platform, selfId) },
      { sort: { timelineKey: "desc", id: "desc" }, limit: n },
    );
    return rows.reverse();
  }
}
