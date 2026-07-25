import type { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    yesimbot_world_message: WorldMessageRow;
  }
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
      },
      { autoInc: true, primary: "id" },
    );
  }

  async store(row: Omit<WorldMessageRow, "id">): Promise<void> {
    await this.ctx.database.create("yesimbot_world_message", row);
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
