import type { Context } from "koishi";
import type { MessageStore } from "./messages.js";
import { parseChannelKey } from "./channels.js";
import { firstName, type ChannelIdentity } from "./identity.js";

/**
 * 频道显示名解析：把 "platform:channelId" 渲染成对 Bot 友好的形式——
 * - 私聊：与xxx的私聊(platform:private:123)
 * - 群聊：群名(platform:456)
 * 查不到名字时原样返回 key。结果带缓存（成功 10 分钟 / 失败 1 分钟），避免反复打平台 API。
 */
export class ChannelNameResolver {
  private cache = new Map<string, { display: string; at: number; hit: boolean }>();
  private identityCache = new Map<string, { value: ChannelIdentity; at: number }>();

  constructor(
    private ctx: Context,
    private store: MessageStore,
  ) {}

  /** Read-only platform identity; no focus, message reads, or device state changes. */
  async identity(key: string, options: { isDirect?: boolean; guildId?: string } = {}): Promise<ChannelIdentity> {
    const { platform, channelId, selfId: explicit } = parseChannelKey(key);
    const accountIds = [...new Set(this.ctx.bots.filter(bot => bot.platform === platform).map(bot => bot.selfId).filter(Boolean))];
    const selfId = explicit || (accountIds.length === 1 ? accountIds[0] : undefined);
    const cacheKey = JSON.stringify([platform, channelId, selfId, options.guildId, options.isDirect, accountIds]);
    const cached = this.identityCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const bot = selfId ? this.bot(platform, selfId) : undefined;
    const direct = options.isDirect ?? (await this.lookupIsDirect(platform, channelId, selfId)) ?? channelId.startsWith("private:");
    let displayName = "", source: ChannelIdentity["source"] = "unknown";
    if (bot && !direct) {
      try {
        const member = await bot.getGuildMember?.(options.guildId || channelId, selfId!);
        displayName = firstName(member?.nick, member?.name);
        source = displayName ? "group_card" : "unknown";
        if (!displayName) { displayName = firstName(member?.user?.nick, member?.user?.name); if (displayName) source = "account_name"; }
      } catch { /* Unsupported member lookup is not evidence of a group nickname. */ }
    }
    if (!displayName && bot) {
      try { const user = await bot.getUser?.(selfId!); displayName = firstName(user?.nick, user?.name); } catch { /* Unknown is honest. */ }
      if (!displayName) displayName = firstName(bot.user?.nick, bot.user?.name);
      if (displayName) source = "account_name";
    }
    const label = source === "group_card" ? `当前群名片为 ${JSON.stringify(displayName)}`
      : source === "account_name" ? `当前账号昵称为 ${JSON.stringify(displayName)}${direct ? "" : "；群名片未取得"}`
        : direct ? "当前昵称未知" : "当前群名片和昵称未知";
    const text = `本会话使用你的账号：平台 ${JSON.stringify(platform)}，账号 ${JSON.stringify(selfId || "未确定")}；${label}。记录中的署名保留当时取得的名称；昵称变化不会改变账号身份，账号身份也不证明消息由你自主发送。`;
    const value: ChannelIdentity = { platform, channelId, selfId, accountIds, displayName, source, text };
    this.identityCache.set(cacheKey, { value, at: Date.now() });
    while (this.identityCache.size > 256) this.identityCache.delete(this.identityCache.keys().next().value!);
    return value;
  }

  invalidateIdentity(platform: string, selfId: string, channelId?: string): void {
    for (const [key, entry] of this.identityCache) if (entry.value.platform === platform && entry.value.selfId === selfId && (!channelId || entry.value.channelId === channelId)) this.identityCache.delete(key);
  }

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
    const { platform, channelId, selfId, error } = parseChannelKey(key);
    if (error) return key;
    // 权威私聊标记：优先消息记录里的 isDirect，读不到回退 onebot 的 private: 前缀约定
    const isDirect = (await this.lookupIsDirect(platform, channelId, selfId)) ?? channelId.startsWith("private:");
    if (isDirect) {
      const userId = channelId.startsWith("private:") ? channelId.slice("private:".length) : channelId;
      const name = await this.peerName(platform, userId, selfId);
      return name && name !== userId ? `与${name}的私聊(${key})` : key;
    }
    const name = await this.groupName(platform, channelId, selfId);
    return name && name !== channelId ? `${name}(${key})` : key;
  }

  /** 从消息记录查该频道的私聊标记（platform:channelId 精确匹配），查不到返回 null */
  private async lookupIsDirect(platform: string, channelId: string, selfId?: string): Promise<boolean | null> {
    try {
      const channels = await this.store.knownChannels();
      const hit = channels.find((c) => c.platform === platform && c.channelId === channelId && (!selfId || c.selfId === selfId));
      if (hit) return hit.isDirect;
    } catch {
      /* 查询失败回退 */
    }
    return null;
  }

  private bot(platform: string, selfId?: string) {
    const candidates = this.ctx.bots.filter((b) => b.platform === platform && (!selfId || b.selfId === selfId));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** 私聊对方的名字：消息记录里的名字优先（零成本），退回平台的用户资料接口 */
  private async peerName(platform: string, userId: string, selfId?: string): Promise<string> {
    try {
      const channels = await this.store.knownChannels();
      for (const c of channels) {
        if (c.platform !== platform || !c.isDirect || (selfId && c.selfId !== selfId)) continue;
        const hit = c.participants.find((p) => p.userId === userId && p.username);
        if (hit) return hit.username;
      }
    } catch {
      /* 查询失败继续尝试平台 API */
    }
    try {
      const user = await this.bot(platform, selfId)?.getUser?.(userId);
      const name = user?.nick || user?.name;
      if (name) return name;
    } catch {
      /* 平台不支持或调用失败 */
    }
    return "";
  }

  /** 群名：getChannel 优先（satori 标准），退回 getGuild（OneBot 群的 channelId 即 guildId） */
  private async groupName(platform: string, channelId: string, selfId?: string): Promise<string> {
    const bot = this.bot(platform, selfId);
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
