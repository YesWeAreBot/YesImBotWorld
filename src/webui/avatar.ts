import { parseChannelKey } from "../koishi/channels.js";

interface PlatformUser { id?: string; name?: string; nick?: string; avatar?: string }
interface PlatformBot {
  platform?: string;
  selfId: string;
  isActive: boolean;
  user?: PlatformUser;
  getLogin?(): Promise<{ user?: PlatformUser }>;
  getUser?(id: string): Promise<PlatformUser>;
}
export interface BotIdentity {
  platform: string;
  selfId: string;
  name: string;
  avatar: string | null;
}

/** Use platform-provided URLs only. Credentials, executable URLs and local files stay out of the page. */
export function platformAvatar(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Koishi login state first, then a bounded, cached read of the adapter's own account. */
export class BotIdentityResolver {
  private cache = new WeakMap<PlatformBot, { until: number; value: PlatformUser | null }>();
  private pending = new WeakMap<PlatformBot, Promise<PlatformUser | null>>();

  constructor(private timeoutMs = 1500, private ttlMs = 5 * 60_000) {}

  async resolve(bots: readonly PlatformBot[], channelKey?: string | null): Promise<BotIdentity | null> {
    const candidates = bots.filter(bot => bot.platform && bot.selfId);
    const channel = channelKey ? parseChannelKey(channelKey) : null;
    const matches = channel && !channel.error
      ? candidates.filter(bot => bot.platform === channel.platform && (!channel.selfId || bot.selfId === channel.selfId)) : [];
    // The current explicit chat account wins. Otherwise prefer a connected configured account.
    const bot = matches.find(bot => bot.isActive) || matches[0] || candidates.find(bot => bot.isActive) || candidates[0];
    if (!bot) return null;
    const user = platformAvatar(bot.user?.avatar) ? bot.user : await this.read(bot) || bot.user;
    return { platform: bot.platform!, selfId: bot.selfId, name: user?.name || user?.nick || bot.selfId, avatar: platformAvatar(user?.avatar) };
  }

  private read(bot: PlatformBot): Promise<PlatformUser | null> {
    const cached = this.cache.get(bot);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    const existing = this.pending.get(bot);
    if (existing) return existing;
    let timer: ReturnType<typeof setTimeout>;
    const query = async () => {
      let user = bot.user;
      try { user = (await bot.getLogin?.())?.user || user; } catch { /* Some adapters only expose getUser. */ }
      if (!platformAvatar(user?.avatar) && bot.isActive && bot.getUser) {
        try { user = await bot.getUser(bot.selfId) || user; } catch { /* Unsupported profile reads use the local fallback. */ }
      }
      return user || null;
    };
    const request = Promise.race([query(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.timeoutMs); })])
      .then(value => { this.cache.set(bot, { until: Date.now() + this.ttlMs, value }); return value; })
      .finally(() => { clearTimeout(timer); this.pending.delete(bot); });
    this.pending.set(bot, request);
    return request;
  }
}
