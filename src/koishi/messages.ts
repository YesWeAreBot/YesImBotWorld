import type { Context } from "koishi";
import { channelKey } from "./channels.js";
import type { ConversationContext } from "./conversation.js";

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
  self: boolean;
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
        self: "boolean",
        messageId: { type: "string", length: 255, initial: "" },
        isDirect: { type: "boolean", nullable: true },
        conversation: { type: "json", nullable: true },
      },
      { autoInc: true, primary: "id" },
    );
  }

  async store(row: Omit<WorldMessageRow, "id">): Promise<void> {
    await this.ctx.database.create("yesimbot_world_message", row);
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
  }

  /** 最近活跃的 n 个频道及各自最新一条消息 */
  async recentChannels(n: number): Promise<{ key: string; latest: WorldMessageRow }[]> {
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      {},
      { sort: { timestamp: "desc" }, limit: 500 },
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
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      {},
      { sort: { timestamp: "desc" }, limit: 1000 },
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
      if (!row.self && !entry.participants.some((p) => p.userId === row.userId)) {
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
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      { platform, channelId, ...this.accountFilter(platform, selfId) },
      { sort: { timestamp: "desc" }, limit: n },
    );
    return rows.reverse();
  }
}
