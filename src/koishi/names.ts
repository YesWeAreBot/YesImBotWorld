import type { Context } from "koishi";
import type { MessageStore } from "./messages.js";

/**
 * 频道显示名解析：把 "platform:channelId" 渲染成对 Bot 友好的形式——
 * - 私聊：与xxx的私聊(platform:private:123)
 * - 群聊：群名(platform:456)
 * 查不到名字时原样返回 key。结果带缓存（成功 10 分钟 / 失败 1 分钟），避免反复打平台 API。
 */
export class ChannelNameResolver {
  private cache = new Map<string, { display: string; at: number; hit: boolean }>();

  constructor(
    private ctx: Context,
    private store: MessageStore,
  ) {}

  async display(key: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < (cached.hit ? 10 * 60_000 : 60_000)) {
      return cached.display;
    }
    let display = key;
    try {
      display = await this.resolve(key);
    } catch {
      /* 解析失败退回纯 key */
    }
    this.cache.set(key, { display, at: Date.now(), hit: display !== key });
    return display;
  }

  private async resolve(key: string): Promise<string> {
    const sep = key.indexOf(":");
    if (sep <= 0) return key;
    const platform = key.slice(0, sep);
    const channelId = key.slice(sep + 1);
    if (channelId.startsWith("private:")) {
      const userId = channelId.slice("private:".length);
      const name = await this.peerName(platform, userId);
      return name && name !== userId ? `与${name}的私聊(${key})` : key;
    }
    const name = await this.groupName(platform, channelId);
    return name && name !== channelId ? `${name}(${key})` : key;
  }

  private bot(platform: string) {
    return this.ctx.bots.find((b) => b.platform === platform);
  }

  /** 私聊对方的名字：消息记录里的名字优先（零成本），退回平台的用户资料接口 */
  private async peerName(platform: string, userId: string): Promise<string> {
    try {
      const channels = await this.store.knownChannels();
      for (const c of channels) {
        if (c.platform !== platform) continue;
        const hit = c.participants.find((p) => p.userId === userId && p.username);
        if (hit) return hit.username;
      }
    } catch {
      /* 查询失败继续尝试平台 API */
    }
    try {
      const user = await this.bot(platform)?.getUser?.(userId);
      const name = user?.nick || user?.name;
      if (name) return name;
    } catch {
      /* 平台不支持或调用失败 */
    }
    return "";
  }

  /** 群名：getChannel 优先（satori 标准），退回 getGuild（OneBot 群的 channelId 即 guildId） */
  private async groupName(platform: string, channelId: string): Promise<string> {
    const bot = this.bot(platform);
    if (!bot) return "";
    try {
      const channel = await bot.getChannel?.(channelId);
      if (channel?.name && channel.name !== channelId) return channel.name;
    } catch {
      /* 继续尝试 getGuild */
    }
    try {
      const guild = await bot.getGuild?.(channelId);
      if (guild?.name && guild.name !== channelId) return guild.name;
    } catch {
      /* 平台不支持或调用失败 */
    }
    return "";
  }
}
