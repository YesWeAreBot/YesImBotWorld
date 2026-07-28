import type { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    yesimbot_world_message: WorldMessageRow;
  }
}

export interface KnownChannel {
  key: string;
  platform: string;
  channelId: string;
  participants: { userId: string; username: string }[];
}

export interface WorldMessageRow {
  id: number;
  platform: string;
  channelId: string;
  guildId: string;
  userId: string;
  username: string;
  content: string;
  timestamp: Date;
  self: boolean;
  /** 平台侧消息 id（用于 recall / react），可能为空 */
  messageId: string;
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
        guildId: "string(255)",
        userId: "string(255)",
        username: "string(255)",
        content: "text",
        timestamp: "timestamp",
        self: "boolean",
        messageId: { type: "string", length: 255, initial: "" },
      },
      { autoInc: true, primary: "id" },
    );
  }

  async store(row: Omit<WorldMessageRow, "id">): Promise<void> {
    await this.ctx.database.create("yesimbot_world_message", row);
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
      const key = `${row.platform}:${row.channelId}`;
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
      const key = `${row.platform}:${row.channelId}`;
      let entry = map.get(key);
      if (!entry) {
        entry = { key, platform: row.platform, channelId: row.channelId, participants: [] };
        map.set(key, entry);
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
  ): Promise<WorldMessageRow | null> {
    if (!messageId) return null;
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      { platform, channelId, messageId },
      { limit: 1 },
    );
    return rows[0] ?? null;
  }

  /** 某频道最近 n 条消息（时间正序返回） */
  async channelMessages(platform: string, channelId: string, n: number): Promise<WorldMessageRow[]> {
    const rows = await this.ctx.database.get(
      "yesimbot_world_message",
      { platform, channelId },
      { sort: { timestamp: "desc" }, limit: n },
    );
    return rows.reverse();
  }
}
