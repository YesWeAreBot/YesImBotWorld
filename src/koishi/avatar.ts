import type { Bot, Context } from "koishi";
import type { PlatformOpsConfig } from "../config.js";
import type { CaptionService } from "../media/captioner.js";
import { mediaPart, mediaText, richPartsText } from "../media/presentation.js";
import type { MediaRenderer } from "../media/render.js";
import type { MediaStore } from "../media/store.js";
import type { MediaRef, RichText, RichTextPart } from "../types.js";
import { channelKey, parseChannelKey } from "./channels.js";
import { firstName } from "./identity.js";
import type { MessageStore } from "./messages.js";

type Profile = { id?: string; name?: string; nick?: string; avatar?: string };
type Member = { name?: string; nick?: string; avatar?: string; user?: Profile };
interface AvatarRead { ref?: MediaRef; name: string; scope?: "member" | "account"; error?: string }

/** Only adapter-returned remote image URLs may become an avatar. Never synthesize a CDN URL. */
function remoteAvatar(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Explicit profile inspection; ordinary messages and member lists never invoke this path. */
export class AvatarViewer {
  private cache = new WeakMap<Bot, Map<string, { until: number; value: AvatarRead }>>();
  private pending = new WeakMap<Bot, Map<string, Promise<AvatarRead>>>();

  constructor(
    private ctx: Pick<Context, "bots">,
    private store: Pick<MessageStore, "knownChannels" | "channelMessages">,
    private media: Pick<MediaStore, "ingest" | "get">,
    private renderer: Pick<MediaRenderer, "canAttach" | "maxAttach">,
    private captioner: Pick<CaptionService, "describeDetailed">,
    private ops: Pick<PlatformOpsConfig, "userInfo" | "memberInfo">,
    private timeoutMs = 1500,
    private ttlMs = 60_000,
  ) {}

  async view(id: string, userId: string, knownDirect?: boolean): Promise<RichText> {
    const channel = parseChannelKey(id.trim());
    if (channel.error) return { text: channel.error };
    const uid = userId.trim();
    if (!uid) return { text: "（查看头像需要 user_id。）" };
    const accounts = this.ctx.bots.filter(bot => bot.platform === channel.platform && (!channel.selfId || bot.selfId === channel.selfId));
    if (accounts.length !== 1) return { text: "（无法确定查看资料所用的账号，请提供含账号的完整频道 id。）" };
    const bot = accounts[0]!;
    if (!bot.isActive) return { text: "（该聊天账号未连接，暂时无法查看头像。）" };
    const key = channelKey(channel.platform, channel.channelId, bot.selfId);
    const known = knownDirect === undefined ? await this.store.knownChannels().catch(() => []) : [];
    const channelInfo = known.find(item => item.platform === channel.platform && item.channelId === channel.channelId && (!item.selfId || item.selfId === bot.selfId));
    const recent = knownDirect === true ? [] : await this.store.channelMessages(channel.platform, channel.channelId, 1, bot.selfId).catch(() => []);
    const last = recent.at(-1);
    const isDirect = knownDirect ?? channelInfo?.isDirect ?? last?.isDirect ?? channel.channelId.startsWith("private:");
    if (!(isDirect ? this.ops.userInfo : this.ops.memberInfo)) return { text: "（当前未开放此类资料查看权限。）" };
    // On platforms with separate channel/guild IDs, only persisted platform metadata can identify
    // the guild. OneBot explicitly uses the group ID as its channel ID.
    const guildId = isDirect ? undefined : last?.guildId || (channel.platform === "onebot" ? channel.channelId : undefined);
    const read = await this.read(bot, key, uid, guildId);
    const who = `${JSON.stringify(read.name || uid)}（平台 ${JSON.stringify(channel.platform)}；账号 ${JSON.stringify(uid)}）`;
    const heading = `你从频道 ${JSON.stringify(key)} 的资料入口查看了 ${who} 的${read.scope === "member" ? "群内头像" : "账号头像"}。`;
    if (!read.ref) return { text: `未能查看频道 ${JSON.stringify(key)} 中账号 ${JSON.stringify(uid)} 的头像。\n${read.error || "（平台没有提供可读取的头像。）"}` };
    const native = this.renderer.canAttach(read.ref) && this.renderer.maxAttach > 0;
    // Looking at a known profile is deliberate. Native models receive only the picture, while a
    // configured interpreter may help a text-only model on this explicit request; no ingress caption.
    const summary = native ? null : await this.captioner.describeDetailed(read.ref, { sticker: false });
    const part = mediaPart(read.ref, { name: `头像：${read.name || uid}；${key}；账号 ${uid}`, sticker: false, summary: summary || undefined });
    const parts: RichTextPart[] = [
      { kind: "text", text: heading + (read.scope === "account" && !isDirect ? " 未取得单独的群内头像，展示的是账号头像。" : "") + "\n这是资料图片，不是此人发来的聊天消息，也不代表本人外貌或当前态度。\n" },
      native ? part : { kind: "text", text: mediaText(part, summary ? "本次按需查看的文字识别，未向当前模型展开原图" : "当前无法识别头像内容；不能凭昵称猜测画面") },
    ];
    return { text: richPartsText(parts), parts, ...(native ? { attachments: [read.ref] } : {}) };
  }

  private read(bot: Bot, key: string, uid: string, guildId?: string): Promise<AvatarRead> {
    const scope = JSON.stringify([key, guildId, uid]);
    let cache = this.cache.get(bot);
    if (!cache) this.cache.set(bot, cache = new Map());
    const saved = cache.get(scope);
    if (saved && saved.until > Date.now()) return Promise.resolve(saved.value);
    let pending = this.pending.get(bot);
    if (!pending) this.pending.set(bot, pending = new Map());
    const active = pending.get(scope);
    if (active) return active;
    const read = this.load(bot, uid, guildId).then(value => {
      cache!.delete(scope);
      cache!.set(scope, { until: Date.now() + (value.ref ? this.ttlMs : Math.min(this.ttlMs, 5000)), value });
      while (cache!.size > 128) cache!.delete(cache!.keys().next().value!);
      return value;
    }).finally(() => pending!.delete(scope));
    pending.set(scope, read);
    return read;
  }

  private async bounded<T>(read: () => Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(read).catch(() => undefined),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), this.timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async load(bot: Bot, uid: string, guildId?: string): Promise<AvatarRead> {
    let member: Member | undefined;
    if (guildId) member = await this.bounded(() => bot.getGuildMember(guildId, uid));
    // An adapter returning a different user must never associate that person's avatar with uid.
    if (member?.user?.id && String(member.user.id) !== uid) member = undefined;
    let name = firstName(member?.nick, member?.name, member?.user?.nick, member?.user?.name);
    let url = remoteAvatar(member?.avatar);
    const scope: AvatarRead["scope"] = url ? "member" : "account";
    url ||= remoteAvatar(member?.user?.avatar);
    if (!url) {
      const profile = await this.bounded(() => bot.getUser(uid, guildId));
      if (profile && (!profile.id || String(profile.id) === uid)) {
        name ||= firstName(profile.nick, profile.name);
        url = remoteAvatar(profile.avatar);
      }
    }
    if (!url) return { name, error: "（平台没有提供可读取的头像，或资料读取失败。）" };
    const mediaId = await this.media.ingest(url, "image");
    const row = mediaId === null ? null : await this.media.get(mediaId);
    if (!row) return { name, scope, error: "（头像图片读取失败。）" };
    return { name, scope, ref: row.ref };
  }
}
