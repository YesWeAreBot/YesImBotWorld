import { promises as fs } from "node:fs";
import path from "node:path";
import { h, type Bot, type Context } from "koishi";
import type { MessengerApi } from "../bot/agent.js";
import type { CaptionService } from "../media/captioner.js";
import { MEDIA_PLACEHOLDER, mediaPlaceholder, type MediaRenderer } from "../media/render.js";
import type { MediaStore } from "../media/store.js";
import type { TtsClient } from "../media/tts.js";
import type { MediaRef, MediaType, RichText } from "../types.js";
import type { FocusManager } from "./focus.js";
import type { PlatformOpsConfig } from "../config.js";
import type { KnownChannel, MessageStore } from "./messages.js";
import type { OwnSendTracker } from "./ownsends.js";
import type { RequestStore } from "./requests.js";

/** msg 中的内联媒体标记：Bot 会照抄事件里见到的 [图片#12]、[视频#3：描述] 等形式 */
const INLINE_MEDIA = /\[(图片|视频|音频|语音)#(\d+)[^\]]*\]/g;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".flac", ".aac", ".amr", ".m4a"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi"]);
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac",
  ".amr": "audio/amr", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".pdf": "application/pdf", ".zip": "application/zip", ".txt": "text/plain", ".md": "text/markdown",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** MessengerApi 的 Koishi 实现：查看/发送消息、图片、文件、语音，浏览收藏夹 */
export class KoishiMessenger implements MessengerApi {
  constructor(
    private ctx: Context,
    private store: MessageStore,
    private renderer: MediaRenderer,
    private media: MediaStore,
    private captioner: CaptionService,
    private galleryDir: string,
    private tts: TtsClient | null,
    private focus: FocusManager,
    private ops: PlatformOpsConfig,
    private requests: RequestStore,
    private ownSends: OwnSendTracker,
  ) {}

  /** 是否需要在消息记录中展示平台消息 id（recall / react / reply 需要引用） */
  private get showMsgId(): boolean {
    return this.ops.recall || this.ops.react || this.ops.reply;
  }

  // ---------- 查看 ----------

  async recentChannels(n: number): Promise<RichText> {
    const channels = await this.store.recentChannels(n);
    if (!channels.length) return { text: "你翻了翻手机，最近没有任何频道有消息。" };
    const lines = channels.map(({ key, latest }) => {
      const time = formatTime(latest.timestamp);
      const who = latest.self ? "你" : latest.username || latest.userId;
      // 预览只做轻量替换，不触发解释器
      return `- ${key} [${time}] ${who}: ${truncate(stripPlaceholders(latest.content), 80)}`;
    });
    return { text: `你翻了翻手机，最近活跃的频道：\n${lines.join("\n")}` };
  }

  async channelMessages(id: string, n: number): Promise<RichText> {
    const resolved = await this.resolveChannel(id);
    if ("error" in resolved) return { text: resolved.error };
    const { platform, channelId } = resolved;
    // 打开频道 = 开始关注：一段时间内该频道的新消息会直接呈现内容
    await this.focus.focus(`${platform}:${channelId}`);
    const rows = await this.store.channelMessages(platform, channelId, n);
    if (!rows.length) return { text: `频道 ${id} 里还没有任何消息记录。` };

    const attachments: MediaRef[] = [];
    const lines: string[] = [];
    for (const row of rows) {
      const who = row.self ? "你" : row.username || row.userId;
      const rendered = await this.renderer.render(row.content);
      if (rendered.attachments) attachments.push(...rendered.attachments);
      const msgTag = this.showMsgId && row.messageId ? ` (msg:${row.messageId})` : "";
      lines.push(`[${formatTime(row.timestamp)}]${msgTag} ${who}: ${rendered.text}`);
    }
    return {
      text: `你打开了 ${id} 的聊天记录（最近 ${rows.length} 条）：\n${lines.join("\n")}`,
      attachments: attachments.length ? attachments : undefined,
    };
  }

  /** 浏览收藏夹：图片入资产库并附内容描述，其他文件列出名称与大小 */
  async gallery(): Promise<string> {
    let names: string[];
    try {
      names = (await fs.readdir(this.galleryDir)).filter((n) => !n.startsWith(".")).sort();
    } catch {
      return "（收藏夹还不存在。）";
    }
    if (!names.length) return "你的收藏夹空空如也。";

    const lines: string[] = [];
    for (const name of names.slice(0, 50)) {
      const file = path.join(this.galleryDir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const type = typeByExt(name);
      if (type === "image") {
        const id = await this.media.ingest(`file://${file}`, "image");
        if (id === null) {
          lines.push(`- [图片] ${name}（读取失败）`);
          continue;
        }
        const row = await this.media.get(id);
        const caption = row ? await this.captioner.describe(row.ref) : null;
        lines.push(`- [图片#${id}] ${name}${caption ? `：${caption}` : ""}`);
      } else if (type === "audio" || type === "video") {
        const id = await this.media.ingest(`file://${file}`, type);
        const label = type === "audio" ? "音频" : "视频";
        lines.push(
          id !== null
            ? `- [${label}#${id}] ${name}（${formatSize(stat.size)}，可用 send_file 发送）`
            : `- [${label}] ${name}（读取失败）`,
        );
      } else {
        lines.push(`- [文件] gallery:${name}（${formatSize(stat.size)}，可用 send_file 发送）`);
      }
    }
    if (names.length > 50) lines.push(`（还有 ${names.length - 50} 项未显示）`);
    return `你翻了翻自己的收藏夹：\n${lines.join("\n")}`;
  }

  /**
   * 翻看媒体缓存（只读）：聊天中见过的媒体都会留在缓存里。
   * 图片按需生成内容摘要（结果缓存，同一媒体只解释一次）。
   */
  async checkMedia(n: number, type?: MediaType): Promise<string> {
    const rows = await this.media.recent(n, type);
    if (!rows.length) return "（媒体缓存是空的，你还没在聊天里见过任何媒体。）";
    const lines: string[] = [];
    for (const row of rows) {
      const label = LABEL[row.type as MediaType] ?? row.type;
      let summary = row.summary;
      if (!summary && row.type === "image") {
        const full = await this.media.get(row.id);
        if (full) summary = (await this.captioner.describe(full.ref)) ?? "";
      }
      lines.push(
        `- [${label}#${row.id}] ${formatSize(row.size)} ${formatTime(row.createdAt)}` +
          (summary ? `：${truncate(summary, 100)}` : "（无内容摘要）"),
      );
    }
    return (
      `你翻看了最近的媒体缓存（最新在前，缓存只读）：\n${lines.join("\n")}\n` +
      `（想留下的可以用 gallery_save 存进收藏夹）`
    );
  }

  /** 把缓存里的媒体存进收藏夹（存入时生成内容摘要） */
  async gallerySave(mediaId: string, name?: string): Promise<string> {
    const match = mediaId.match(/(\d+)\s*$/);
    if (!match) return `（无法理解的媒体编号："${mediaId}"）`;
    const row = await this.media.get(Number(match[1]));
    if (!row) return `（找不到媒体 #${match[1]}，可先用 check_media 查看缓存。）`;

    const ext = path.extname(row.file) || "";
    let filename: string;
    if (name?.trim()) {
      const safe = sanitizeName(name.trim());
      if (!safe) return `（文件名不合法："${name}"）`;
      // 扩展名缺失或与媒体实际类型不符时，补上正确的扩展名（避免收藏夹误判类型）
      filename = path.extname(safe) && typeByExt(safe) === row.type ? safe : safe + ext;
    } else {
      filename = `${row.type}-${row.id}${ext}`;
    }
    await fs.mkdir(this.galleryDir, { recursive: true });
    const dest = path.join(this.galleryDir, filename);
    if (await fs.stat(dest).then((s) => s.isFile()).catch(() => false)) {
      return `（收藏夹里已经有 "${filename}" 了，换个名字试试。）`;
    }
    await fs.copyFile(row.ref.file, dest);
    const caption = row.summary || (await this.captioner.describe(row.ref));
    const label = LABEL[row.type as MediaType] ?? row.type;
    return `你把${label}#${row.id} 存进了收藏夹：${filename}${caption ? `（内容：${truncate(caption, 80)}）` : ""}`;
  }

  /** 把文件移出收藏夹 */
  async galleryRemove(name: string): Promise<string> {
    const safe = sanitizeName(name.trim());
    if (!safe) return `（文件名不合法："${name}"）`;
    const file = path.join(this.galleryDir, safe);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return `（收藏夹里没有 "${safe}"，可先用 check_gallery 看看。）`;
    await fs.unlink(file);
    return `你把 "${safe}" 移出了收藏夹。`;
  }

  // ---------- 发送 ----------

  async send(
    id: string,
    msg: string,
    media: (string | number)[] = [],
    replyTo?: string,
    atSender = true,
  ): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;

    const elements: h[] = [];
    const sentRefs: MediaRef[] = [];
    const problems: string[] = [];
    const inlineIds = new Set<number>();
    let stored = "";
    let atNote = "";

    // 引用回复：模拟 QQ 客户端行为——群聊里引用时自动在开头 @ 原发送人 + 空格，
    // Bot 可用 at_sender: false 去掉（如同真人手动删掉自动加上的 @）。
    // 私聊没有 @ 的概念，强制不附加 at（QQ 私聊无法渲染 at，只会留下一个孤零零的空格）。
    if (replyTo) {
      elements.push(h("quote", { id: replyTo }));
      stored += `[引用 msg:${replyTo}] `;
      if (target.channelId.startsWith("private:")) atSender = false;
      if (atSender) {
        const quoted = await this.store.findByMessageId(target.platform, target.channelId, replyTo);
        if (quoted && !quoted.self && quoted.userId) {
          elements.push(h("at", { id: quoted.userId, name: quoted.username || undefined }), h.text(" "));
          stored += `@${quoted.username || quoted.userId} `;
          atNote = `，并 @ 了 ${quoted.username || quoted.userId}`;
        }
      }
    }

    // msg 中的内联媒体标记（[图片#12] / [视频#3]…）→ 在对应位置嵌入媒体，实现图文混排
    let cursor = 0;
    for (const match of msg.matchAll(INLINE_MEDIA)) {
      const before = msg.slice(cursor, match.index);
      cursor = match.index! + match[0].length;
      if (before) {
        elements.push(h.text(before));
        stored += before;
      }
      const resolved = await this.resolveMediaRef(match[2]!, ["image", "video"]);
      if ("error" in resolved) {
        problems.push(resolved.error);
        continue;
      }
      elements.push(await this.mediaElement(resolved.ref));
      sentRefs.push(resolved.ref);
      inlineIds.add(resolved.ref.id);
      stored += mediaPlaceholder(resolved.ref.id, resolved.ref.type);
    }
    const rest = msg.slice(cursor);
    if (rest) {
      elements.push(h.text(rest));
      stored += rest;
    }

    // media 参数中的媒体（未在 msg 中内联过的）追加在末尾
    for (const item of media.slice(0, 9)) {
      const resolved = await this.resolveMediaRef(String(item), ["image", "video"]);
      if ("error" in resolved) {
        problems.push(resolved.error);
        continue;
      }
      if (inlineIds.has(resolved.ref.id)) continue;
      elements.push(await this.mediaElement(resolved.ref));
      sentRefs.push(resolved.ref);
      stored += mediaPlaceholder(resolved.ref.id, resolved.ref.type);
    }
    if (!elements.some((el) => el.type !== "quote")) {
      return `（消息没发出去：没有可发送的内容。${problems.join("；")}）`;
    }

    let msgIds: string[] = [];
    this.ownSends.expect(`${target.platform}:${target.channelId}`);
    try {
      msgIds = await target.bot.sendMessage(target.channelId, elements);
    } catch (err) {
      this.ownSends.unexpect(`${target.platform}:${target.channelId}`);
      return `（消息发送失败：${(err as Error).message ?? err}）`;
    }
    await this.storeSelf(target, stored, msgIds[0]);
    await this.focus.focus(`${target.platform}:${target.channelId}`);
    let result = `消息已发送到 ${id}。`;
    if (this.showMsgId && msgIds[0]) result = `消息已发送到 ${id}（msg:${msgIds[0]}）。`;
    if (replyTo) result += `（引用回复了 msg:${replyTo}${atNote}）`;
    if (sentRefs.length) result += `（附 ${sentRefs.length} 个媒体）`;
    if (problems.length) result += `注意：${problems.join("；")}`;
    return result;
  }

  /** 媒体引用 → 消息元素（图片 / 视频） */
  private async mediaElement(ref: MediaRef): Promise<h> {
    const data = await this.media.readFile(ref);
    const src = toDataUrl(data, ref.mime);
    return ref.type === "video" ? h("video", { src }) : h("img", { src });
  }

  /** 以文件形式发送音频/视频/任意文件 */
  async sendFile(id: string, refText: string): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;

    let element: h;
    let stored: string;
    const gallery = parseGalleryRef(refText);
    if (gallery !== null) {
      // 收藏夹文件（媒体类型也会顺带入资产库，以便留痕）
      const safe = sanitizeName(gallery);
      if (!safe) return `（文件名不合法："${gallery}"）`;
      const file = path.join(this.galleryDir, safe);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) return `（收藏夹里没有 "${safe}"，可先用 check_gallery 查看。）`;
      const data = await fs.readFile(file);
      const ext = path.extname(safe).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
      const type = typeByExt(safe);
      element = this.fileElement(type, data, mime, safe);
      if (type === "audio" || type === "video" || type === "image") {
        const mediaId = await this.media.ingest(toDataUrl(data, mime), type);
        stored = mediaId !== null ? mediaPlaceholder(mediaId, type) : `[文件 ${safe}]`;
      } else {
        stored = `[文件 ${safe}]`;
      }
    } else {
      const resolved = await this.resolveMediaRef(refText);
      if ("error" in resolved) return resolved.error;
      const data = await this.media.readFile(resolved.ref);
      const name = path.basename(resolved.ref.file);
      element = this.fileElement(resolved.ref.type, data, resolved.ref.mime, name);
      stored = mediaPlaceholder(resolved.ref.id, resolved.ref.type);
    }

    let msgIds: string[] = [];
    this.ownSends.expect(`${target.platform}:${target.channelId}`);
    try {
      msgIds = await target.bot.sendMessage(target.channelId, element);
    } catch (err) {
      this.ownSends.unexpect(`${target.platform}:${target.channelId}`);
      return `（文件发送失败：${(err as Error).message ?? err}）`;
    }
    await this.storeSelf(target, stored, msgIds[0]);
    await this.focus.focus(`${target.platform}:${target.channelId}`);
    return `文件已发送到 ${id}。`;
  }

  /** TTS 合成并以语音消息发送 */
  async sendVoice(id: string, text: string): Promise<string> {
    if (!this.tts) return "（你没有可用的语音合成能力。）";
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;

    let audio: { data: Buffer; mime: string };
    try {
      audio = await this.tts.speech(text);
    } catch (err) {
      return `（语音合成失败：${(err as Error).message ?? err}）`;
    }
    let msgIds: string[] = [];
    this.ownSends.expect(`${target.platform}:${target.channelId}`);
    try {
      msgIds = await target.bot.sendMessage(
        target.channelId,
        h("audio", { src: toDataUrl(audio.data, audio.mime) }),
      );
    } catch (err) {
      this.ownSends.unexpect(`${target.platform}:${target.channelId}`);
      return `（语音发送失败：${(err as Error).message ?? err}）`;
    }
    // 入资产库留痕，历史记录中可回看
    const mediaId = await this.media.ingest(toDataUrl(audio.data, audio.mime), "audio");
    if (mediaId !== null) await this.media.setSummary(mediaId, `（语音转写）${text}`);
    const stored =
      mediaId !== null ? `${mediaPlaceholder(mediaId, "audio")}（语音内容：${text}）` : `[语音] ${text}`;
    await this.storeSelf(target, stored, msgIds[0]);
    await this.focus.focus(`${target.platform}:${target.channelId}`);
    return `语音已发送到 ${id}：「${text}」`;
  }

  // ---------- 平台扩展操作 ----------

  /** 撤回自己已发出的消息 */
  async recall(id: string, msgId: string): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;
    try {
      await target.bot.deleteMessage(target.channelId, msgId);
    } catch (err) {
      return `（撤回失败：${(err as Error).message ?? err}。只能撤回自己发出不久的消息。）`;
    }
    return `你撤回了 ${id} 里的消息（msg:${msgId}）。`;
  }

  /** 给某条消息贴表情回应 */
  async react(id: string, msgId: string, emoji: string): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;
    try {
      if (target.platform === "onebot") {
        // OneBot：set_msg_emoji_like（NapCat / LLOneBot / Lagrange 扩展）
        await callOnebot(target.bot, "set_msg_emoji_like", {
          message_id: toIdValue(msgId),
          emoji_id: emojiToOnebotId(emoji),
          set: true,
        });
      } else {
        await target.bot.createReaction(target.channelId, msgId, emoji);
      }
    } catch (err) {
      return `（贴表情失败：${(err as Error).message ?? err}）`;
    }
    return `你给 ${id} 里的消息（msg:${msgId}）贴上了 ${emoji} 的回应。`;
  }

  /** 戳一戳（仅 OneBot，需实现端支持 friend_poke / group_poke） */
  async poke(id: string, userId?: string): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;
    if (target.platform !== "onebot") return "（戳一戳目前只支持 QQ（OneBot）平台。）";
    const isPrivate = target.channelId.startsWith("private:");
    const uid = userId?.trim() || (isPrivate ? target.channelId.slice("private:".length) : "");
    if (!uid) return "（在群里 poke 需要 user_id 参数指明戳谁。）";
    try {
      if (isPrivate) {
        await callOnebot(target.bot, "friend_poke", { user_id: toIdValue(uid) });
      } else {
        await callOnebot(target.bot, "group_poke", {
          group_id: toIdValue(target.channelId),
          user_id: toIdValue(uid),
        });
      }
    } catch (err) {
      return `（戳一戳失败：${(err as Error).message ?? err}）`;
    }
    return isPrivate ? `你戳了戳 ${id} 的对方。` : `你在 ${id} 里戳了戳 ${uid}。`;
  }

  /** 处理好友申请 / 入群邀请 / 入群申请 */
  async handleRequest(requestId: string, approve: boolean, reason?: string): Promise<string> {
    const req = this.requests.get(requestId);
    if (!req) return `（找不到待处理的请求 ${requestId}，它可能已被处理过或已失效。）`;
    const candidates = this.ctx.bots.filter((b) => b.platform === req.platform);
    const bot = candidates.find((b) => b.selfId === req.selfId) ?? candidates.find((b) => b.isActive) ?? candidates[0];
    if (!bot) return `（没有可用的 ${req.platform} 账号来处理这个请求。）`;
    try {
      if (req.kind === "friend") await bot.handleFriendRequest(req.messageId, approve, reason);
      else if (req.kind === "guild") await bot.handleGuildRequest(req.messageId, approve, reason);
      else await bot.handleGuildMemberRequest(req.messageId, approve, reason);
    } catch (err) {
      return `（处理请求失败：${(err as Error).message ?? err}）`;
    }
    this.requests.remove(requestId);
    const who = req.username || req.userId;
    if (req.kind === "friend") {
      return approve
        ? `你通过了 ${who} 的好友申请。现在可以在 ${req.platform}:private:${req.userId} 和 TA 聊天了。`
        : `你拒绝了 ${who} 的好友申请。`;
    }
    if (req.kind === "guild") {
      return approve ? `你接受了加入群 ${req.guildId} 的邀请。` : `你婉拒了加入群 ${req.guildId} 的邀请。`;
    }
    return approve ? `你同意了 ${who} 加入群 ${req.guildId} 的申请。` : `你拒绝了 ${who} 加入群 ${req.guildId} 的申请。`;
  }

  /** 修改自己的账号资料（昵称 / 签名 / 头像，仅 OneBot） */
  async setProfile(opts: { nickname?: string; signature?: string; avatar?: string }): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（修改资料目前只支持 QQ（OneBot）平台，但没有可用的 OneBot 账号。）";
    if (!opts.nickname && !opts.signature && !opts.avatar) {
      return "（set_profile 需要 nickname、signature、avatar 中至少一个参数。）";
    }
    const done: string[] = [];
    try {
      if (opts.nickname || opts.signature) {
        const params: Record<string, unknown> = {};
        if (opts.nickname) params.nickname = opts.nickname;
        if (opts.signature) params.personal_note = opts.signature;
        await callOnebot(bot, "set_qq_profile", params);
        if (opts.nickname) done.push(`昵称改成了「${opts.nickname}」`);
        if (opts.signature) done.push(`签名改成了「${opts.signature}」`);
      }
      if (opts.avatar) {
        const resolved = await this.resolveMediaRef(opts.avatar, ["image"]);
        if ("error" in resolved) return resolved.error;
        const data = await this.media.readFile(resolved.ref);
        await callOnebot(bot, "set_qq_avatar", { file: `base64://${data.toString("base64")}` });
        done.push("头像换成了新图片");
      }
    } catch (err) {
      return `（修改资料失败：${(err as Error).message ?? err}）`;
    }
    return `你更新了自己的账号资料：${done.join("；")}。`;
  }

  /** 修改自己在某个群里显示的名称（群名片，仅 OneBot） */
  async setGroupCard(id: string, card: string): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;
    if (target.platform !== "onebot") return "（修改群名片目前只支持 QQ（OneBot）平台。）";
    if (target.channelId.startsWith("private:")) return "（这是私聊频道，没有群名片可改。）";
    try {
      await callOnebot(target.bot, "set_group_card", {
        group_id: toIdValue(target.channelId),
        user_id: toIdValue(target.bot.selfId ?? ""),
        card,
      });
    } catch (err) {
      return `（修改群名片失败：${(err as Error).message ?? err}）`;
    }
    return `你在群 ${id} 里显示的名称改成了「${card}」。`;
  }

  // ---------- 用户相关（OneBot） ----------

  /** 查看某个用户的资料 */
  async userInfo(userId: string): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（没有可用的 OneBot 账号。）";
    const uid = parseUserId(userId);
    if (!uid) return `（无法理解的用户 id："${userId}"）`;
    let data: Record<string, unknown>;
    try {
      data = ((await callOnebot(bot, "get_stranger_info", { user_id: toIdValue(uid) })) ?? {}) as Record<string, unknown>;
    } catch (err) {
      return `（查看资料失败：${(err as Error).message ?? err}）`;
    }
    const parts: string[] = [];
    if (data.nickname) parts.push(`昵称：${data.nickname}`);
    parts.push(`QQ：${data.user_id ?? uid}`);
    if (data.sex === "male") parts.push("性别：男");
    else if (data.sex === "female") parts.push("性别：女");
    if (typeof data.age === "number" && data.age > 0) parts.push(`年龄：${data.age}`);
    if (data.level) parts.push(`等级：${data.level}`);
    if (data.long_nick) parts.push(`签名：${truncate(String(data.long_nick), 60)}`);
    return `你看了看 ${data.nickname ?? uid} 的资料——${parts.join("；")}`;
  }

  /** 给某人的资料卡点赞 */
  async sendLike(userId: string, times: number): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（没有可用的 OneBot 账号。）";
    const uid = parseUserId(userId);
    if (!uid) return `（无法理解的用户 id："${userId}"）`;
    try {
      await callOnebot(bot, "send_like", { user_id: toIdValue(uid), times });
    } catch (err) {
      return `（点赞失败：${(err as Error).message ?? err}）`;
    }
    return `你给 ${uid} 的资料卡点了 ${times} 个赞。`;
  }

  /** 删除好友 */
  async deleteFriend(userId: string): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（没有可用的 OneBot 账号。）";
    const uid = parseUserId(userId);
    if (!uid) return `（无法理解的用户 id："${userId}"）`;
    try {
      await callOnebot(bot, "delete_friend", { user_id: toIdValue(uid) });
    } catch (err) {
      return `（删除好友失败：${(err as Error).message ?? err}）`;
    }
    return `你删除了好友 ${uid}。`;
  }

  // ---------- 群相关（OneBot） ----------

  /** 查看自己加入的群列表 */
  async listGroups(): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（没有可用的 OneBot 账号。）";
    let data: Record<string, unknown>[];
    try {
      data = ((await callOnebot(bot, "get_group_list", {})) ?? []) as Record<string, unknown>[];
    } catch (err) {
      return `（查看群列表失败：${(err as Error).message ?? err}）`;
    }
    if (!Array.isArray(data) || !data.length) return "（你没有加入任何群。）";
    const lines = data
      .slice(0, 100)
      .map((g) => `- ${g.group_name ?? "（未命名）"}（onebot:${g.group_id}，${g.member_count ?? "?"}/${g.max_member_count ?? "?"} 人）`);
    const more = data.length > 100 ? `\n（其余 ${data.length - 100} 个群未显示）` : "";
    return `你翻了翻自己加入的群（共 ${data.length} 个）：\n${lines.join("\n")}${more}`;
  }

  /** 查看某个群的信息 */
  async groupInfo(id: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    let data: Record<string, unknown>;
    try {
      data = ((await callOnebot(target.bot, "get_group_info", { group_id: toIdValue(target.groupId) })) ?? {}) as Record<string, unknown>;
    } catch (err) {
      return `（查看群信息失败：${(err as Error).message ?? err}）`;
    }
    return (
      `你看了看群 ${id} 的信息——群名：${data.group_name ?? "（未知）"}；群号：${data.group_id ?? target.groupId}；` +
      `成员：${data.member_count ?? "?"}/${data.max_member_count ?? "?"} 人`
    );
  }

  /** 查看群成员列表 */
  async listMembers(id: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    let data: Record<string, unknown>[];
    try {
      data = ((await callOnebot(target.bot, "get_group_member_list", { group_id: toIdValue(target.groupId) })) ?? []) as Record<string, unknown>[];
    } catch (err) {
      return `（查看群成员失败：${(err as Error).message ?? err}）`;
    }
    if (!Array.isArray(data) || !data.length) return `（群 ${id} 的成员列表是空的。）`;
    const roleTag = (r: unknown) => (r === "owner" ? "［群主］" : r === "admin" ? "［管理员］" : "");
    const sorted = [...data].sort((a, b) => roleRank(a.role) - roleRank(b.role));
    const lines = sorted
      .slice(0, 50)
      .map((m) => `- ${m.card || m.nickname || m.user_id}（${m.user_id}）${roleTag(m.role)}`);
    const more = data.length > 50 ? `\n（其余 ${data.length - 50} 人未显示，可用 member_info 查看具体某人）` : "";
    return `你看了看群 ${id} 的成员（共 ${data.length} 人）：\n${lines.join("\n")}${more}`;
  }

  /** 查看某个群成员的详细信息 */
  async memberInfo(id: string, userId: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    const uid = parseUserId(userId);
    if (!uid) return `（无法理解的用户 id："${userId}"）`;
    let data: Record<string, unknown>;
    try {
      data = ((await callOnebot(target.bot, "get_group_member_info", {
        group_id: toIdValue(target.groupId),
        user_id: toIdValue(uid),
      })) ?? {}) as Record<string, unknown>;
    } catch (err) {
      return `（查看成员信息失败：${(err as Error).message ?? err}）`;
    }
    const parts: string[] = [];
    if (data.card) parts.push(`群名片：${data.card}`);
    if (data.nickname) parts.push(`昵称：${data.nickname}`);
    parts.push(`QQ：${data.user_id ?? uid}`);
    if (data.role === "owner") parts.push("身份：群主");
    else if (data.role === "admin") parts.push("身份：管理员");
    if (data.title) parts.push(`头衔：${data.title}`);
    if (typeof data.join_time === "number" && data.join_time > 0) {
      parts.push(`入群时间：${formatTime(new Date(data.join_time * 1000))}`);
    }
    return `你看了看群 ${id} 里 ${data.card || data.nickname || uid} 的信息——${parts.join("；")}`;
  }

  /** 禁言 / 解除禁言群成员 */
  async groupBan(id: string, userId: string, minutes: number): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    const uid = parseUserId(userId);
    if (!uid) return `（无法理解的用户 id："${userId}"）`;
    try {
      await callOnebot(target.bot, "set_group_ban", {
        group_id: toIdValue(target.groupId),
        user_id: toIdValue(uid),
        duration: Math.max(0, Math.round(minutes * 60)),
      });
    } catch (err) {
      return `（禁言操作失败：${(err as Error).message ?? err}。你可能不是管理员。）`;
    }
    return minutes > 0 ? `你把 ${uid} 禁言了 ${minutes} 分钟。` : `你解除了 ${uid} 的禁言。`;
  }

  /** 开启 / 关闭全员禁言 */
  async groupWholeBan(id: string, enable: boolean): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    try {
      await callOnebot(target.bot, "set_group_whole_ban", {
        group_id: toIdValue(target.groupId),
        enable,
      });
    } catch (err) {
      return `（全员禁言操作失败：${(err as Error).message ?? err}。你可能不是管理员。）`;
    }
    return enable ? `你在群 ${id} 开启了全员禁言。` : `你解除了群 ${id} 的全员禁言。`;
  }

  /** 把成员移出群 */
  async groupKick(id: string, userId: string, block: boolean): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    const uid = parseUserId(userId);
    if (!uid) return `（无法理解的用户 id："${userId}"）`;
    try {
      await callOnebot(target.bot, "set_group_kick", {
        group_id: toIdValue(target.groupId),
        user_id: toIdValue(uid),
        reject_add_request: block,
      });
    } catch (err) {
      return `（移出群操作失败：${(err as Error).message ?? err}。你可能不是管理员。）`;
    }
    return `你把 ${uid} 移出了群 ${id}${block ? "，并拒绝其再次加群" : ""}。`;
  }

  /** 设置 / 取消群管理员 */
  async groupAdmin(id: string, userId: string, enable: boolean): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    const uid = parseUserId(userId);
    if (!uid) return `（无法理解的用户 id："${userId}"）`;
    try {
      await callOnebot(target.bot, "set_group_admin", {
        group_id: toIdValue(target.groupId),
        user_id: toIdValue(uid),
        enable,
      });
    } catch (err) {
      return `（设置管理员失败：${(err as Error).message ?? err}。只有群主能设置管理员。）`;
    }
    return enable ? `你把 ${uid} 设为了群 ${id} 的管理员。` : `你取消了 ${uid} 在群 ${id} 的管理员身份。`;
  }

  /** 修改群名 */
  async setGroupName(id: string, name: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    try {
      await callOnebot(target.bot, "set_group_name", {
        group_id: toIdValue(target.groupId),
        group_name: name,
      });
    } catch (err) {
      return `（修改群名失败：${(err as Error).message ?? err}）`;
    }
    return `你把群 ${id} 的群名改成了「${name}」。`;
  }

  /** 修改群头像 */
  async setGroupPortrait(id: string, image: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    const resolved = await this.resolveMediaRef(image, ["image"]);
    if ("error" in resolved) return resolved.error;
    try {
      const data = await this.media.readFile(resolved.ref);
      await callOnebot(target.bot, "set_group_portrait", {
        group_id: toIdValue(target.groupId),
        file: `base64://${data.toString("base64")}`,
      });
    } catch (err) {
      return `（修改群头像失败：${(err as Error).message ?? err}。你可能不是管理员。）`;
    }
    return `你把群 ${id} 的头像换成了新图片。`;
  }

  /** 授予群成员专属头衔 */
  async setSpecialTitle(id: string, userId: string, title: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    const uid = parseUserId(userId);
    if (!uid) return `（无法理解的用户 id："${userId}"）`;
    try {
      await callOnebot(target.bot, "set_group_special_title", {
        group_id: toIdValue(target.groupId),
        user_id: toIdValue(uid),
        special_title: title,
      });
    } catch (err) {
      return `（设置头衔失败：${(err as Error).message ?? err}。只有群主能授予头衔。）`;
    }
    return title
      ? `你授予了 ${uid} 专属头衔「${title}」。`
      : `你移除了 ${uid} 的专属头衔。`;
  }

  /** 退出群聊 */
  async groupLeave(id: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    try {
      await callOnebot(target.bot, "set_group_leave", {
        group_id: toIdValue(target.groupId),
      });
    } catch (err) {
      return `（退群失败：${(err as Error).message ?? err}）`;
    }
    await this.focus.unfocus(`${target.platform}:${target.channelId}`);
    return `你退出了群 ${id}。`;
  }

  /** 设置 / 移出群精华消息 */
  async setEssence(msgId: string, remove: boolean): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（没有可用的 OneBot 账号。）";
    try {
      await callOnebot(bot, remove ? "delete_essence_msg" : "set_essence_msg", {
        message_id: toIdValue(msgId),
      });
    } catch (err) {
      return `（精华消息操作失败：${(err as Error).message ?? err}。你可能不是管理员。）`;
    }
    return remove ? `你把消息（msg:${msgId}）移出了群精华。` : `你把消息（msg:${msgId}）设为了群精华。`;
  }

  /** 发布群公告 */
  async sendGroupNotice(id: string, content: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    try {
      await callOnebot(target.bot, "_send_group_notice", {
        group_id: toIdValue(target.groupId),
        content,
      });
    } catch (err) {
      return `（发布公告失败：${(err as Error).message ?? err}。你可能不是管理员。）`;
    }
    return `你在群 ${id} 发布了公告：「${truncate(content, 60)}」`;
  }

  /** 群打卡 */
  async groupSign(id: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    const params = { group_id: toIdValue(target.groupId) };
    try {
      await callOnebot(target.bot, "set_group_sign", params);
    } catch {
      try {
        await callOnebot(target.bot, "send_group_sign", params);
      } catch (err) {
        return `（群打卡失败：${(err as Error).message ?? err}）`;
      }
    }
    return `你在群 ${id} 打了卡。`;
  }

  private findOnebot(): Bot | undefined {
    const candidates = this.ctx.bots.filter((b) => b.platform === "onebot");
    return candidates.find((b) => b.isActive) ?? candidates[0];
  }

  /** 解析并校验一个 OneBot 群频道 id */
  private async resolveOnebotGroup(
    id: string,
  ): Promise<{ bot: Bot; platform: string; channelId: string; groupId: string } | { error: string }> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target;
    if (target.platform !== "onebot") return { error: "（这个操作目前只支持 QQ（OneBot）平台。）" };
    if (target.channelId.startsWith("private:")) return { error: `（${id} 是私聊频道，不是群。）` };
    return { ...target, groupId: target.channelId };
  }

  /** 查看好友列表 */
  async listFriends(): Promise<string> {
    const lines: string[] = [];
    for (const bot of this.ctx.bots) {
      try {
        let next: string | undefined;
        do {
          const page = await bot.getFriendList(next);
          for (const friend of page.data) {
            const uid = friend.user?.id;
            if (!uid) continue;
            const name = friend.nick || friend.user?.nick || friend.user?.name || uid;
            lines.push(`- ${name}（${bot.platform}:private:${uid}）`);
          }
          next = page.next;
        } while (next && lines.length < 500);
      } catch {
        /* 平台不支持好友列表 */
      }
    }
    if (!lines.length) return "（拿不到好友列表：当前平台不支持，或者你还没有好友。）";
    const shown = lines.slice(0, 200);
    const more = lines.length > shown.length ? `\n（其余 ${lines.length - shown.length} 人未显示）` : "";
    return `你翻了翻好友列表（共 ${lines.length} 人）：\n${shown.join("\n")}${more}`;
  }

  /** 放下手机：清除全部频道关注，恢复为一般通知策略 */
  async putDownPhone(): Promise<string> {
    const cleared = await this.focus.clear();
    if (!cleared.length) return "你放下手机——本来也没有特别留意哪个频道。";
    return (
      `你放下了手机，不再盯着 ${cleared.join("、")}。` +
      "之后这些频道再有消息，只会像平常一样通知你。"
    );
  }

  // ---------- 内部 ----------

  private async resolveBot(
    id: string,
  ): Promise<{ bot: Bot; platform: string; channelId: string } | { error: string }> {
    const resolved = await this.resolveChannel(id);
    if ("error" in resolved) return resolved;
    const { platform, channelId } = resolved;
    const candidates = this.ctx.bots.filter((b) => b.platform === platform);
    const bot = candidates.find((b) => b.isActive) ?? candidates[0];
    if (!bot) return { error: `（消息没发出去：没有可用的 ${platform} 账号。）` };
    return { bot, platform, channelId };
  }

  /**
   * 频道 id 的宽松解析。
   *
   * Bot 常把频道 id 写错（如把用户名当频道，写成 "onebot:TouchNight" 甚至 "chat:TouchNight"）。
   * 策略：
   * 1. 与已知频道（消息记录）精确匹配 → 直接通过；
   * 2. 不匹配时，用 id 中的片段模糊匹配已知频道的参与者用户名/用户 id/频道 id ——
   *    找到候选时**不执行操作**，而是返回提示（会以事件形式送达 Bot），让它下次用正确的 id 调用；
   * 3. 格式正确但完全无线索的 id 放行（可能是没有历史消息的新频道，交由平台判定）。
   */
  private async resolveChannel(
    id: string,
  ): Promise<{ platform: string; channelId: string } | { error: string }> {
    const { platform, channelId, error } = parseChannelKey(id);
    let channels: KnownChannel[] = [];
    try {
      channels = await this.store.knownChannels();
    } catch {
      /* 查询失败时退化为原有行为 */
    }

    if (!error && channels.some((c) => c.platform === platform && c.channelId === channelId)) {
      return { platform, channelId };
    }

    // 模糊匹配：取 id 中的非平台片段作为查询词
    const knownPlatforms = new Set(
      this.ctx.bots.map((b) => b.platform?.toLowerCase()).filter((p): p is string => !!p),
    );
    const GENERIC = new Set(["private", "group", "channel", "guild", "chat", "discord", "telegram", "onebot", "qq"]);
    const terms = id
      .split(":")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 2 && !knownPlatforms.has(s) && !GENERIC.has(s));

    const matches = terms.length
      ? channels.filter((c) => {
          const hay = [
            c.channelId.toLowerCase(),
            ...c.participants.flatMap((p) => [p.username.toLowerCase(), p.userId.toLowerCase()]),
          ].filter((s) => s.length >= 2);
          return terms.some((t) => hay.some((s) => s.includes(t) || t.includes(s)));
        })
      : [];

    if (matches.length) {
      const list = matches
        .slice(0, 3)
        .map((c) => {
          const names = c.participants.slice(0, 3).map((p) => p.username || p.userId).join("、");
          return `${c.key}${names ? `（${names}）` : ""}`;
        })
        .join("；");
      return {
        error:
          `（没有找到频道 "${id}"。你是想找 ${list} 吗？` +
          `什么都没有发生——请在下次调用时使用上面这种完整的频道 id。）`,
      };
    }

    if (error) return { error };
    return { platform, channelId };
  }

  /** 解析媒体引用："12" / "media:12" / "图片#12" / "gallery:name.png"，可限定允许的媒体类型 */
  private async resolveMediaRef(
    refText: string,
    allowTypes?: MediaType[],
  ): Promise<{ ref: MediaRef } | { error: string }> {
    const galleryName = parseGalleryRef(refText);
    if (galleryName !== null) {
      const safe = sanitizeName(galleryName);
      if (!safe) return { error: `（文件名不合法："${galleryName}"）` };
      const file = path.join(this.galleryDir, safe);
      const type = typeByExt(safe);
      if (type === "file") return { error: `（"${safe}" 不是媒体文件，请用 send_file 发送）` };
      if (allowTypes && !allowTypes.includes(type)) {
        return { error: `（"${safe}" 是${LABEL[type]}，不能放进普通消息；请用 send_file${type === "audio" ? " 或 send_voice" : ""} 发送）` };
      }
      const id = await this.media.ingest(`file://${file}`, type);
      if (id === null) return { error: `（读取 "${safe}" 失败，可先用 check_gallery 确认它存在。）` };
      const row = await this.media.get(id);
      if (!row) return { error: `（读取 "${safe}" 失败。）` };
      return { ref: row.ref };
    }
    const match = refText.match(/(\d+)\s*$/);
    if (!match) return { error: `（无法理解的媒体引用："${refText}"）` };
    const row = await this.media.get(Number(match[1]));
    if (!row) return { error: `（找不到媒体 #${match[1]}，它可能未被收录。）` };
    if (allowTypes && !allowTypes.includes(row.ref.type)) {
      return {
        error: `（#${row.id} 是${LABEL[row.ref.type]}，不能放进普通消息；请用 send_file${row.ref.type === "audio" ? " 或 send_voice" : ""} 发送。）`,
      };
    }
    return { ref: row.ref };
  }

  private fileElement(type: MediaType | "file", data: Buffer, mime: string, name: string): h {
    const src = toDataUrl(data, mime);
    // 图片/音频/视频用对应元素（audio 在 QQ 等平台即语音）；其他一律 file
    if (type === "video") return h("video", { src, title: name });
    if (type === "audio") return h("audio", { src, title: name });
    if (type === "image") return h("img", { src, title: name });
    return h("file", { src, title: name });
  }

  private async storeSelf(
    target: { bot: Bot; platform: string; channelId: string },
    content: string,
    messageId?: string,
  ): Promise<void> {
    await this.store.store({
      platform: target.platform,
      channelId: target.channelId,
      guildId: "",
      userId: target.bot.selfId ?? "self",
      username: "（我）",
      content,
      timestamp: new Date(),
      self: true,
      messageId: messageId ?? "",
    });
  }
}

// ---------- 工具函数 ----------

/**
 * 调用 OneBot 底层 API（adapter-onebot 的 internal._request），返回 data 部分。
 * 用于 Koishi 通用接口未覆盖的实现端扩展（set_msg_emoji_like / friend_poke / set_qq_profile 等）。
 */
async function callOnebot(bot: Bot, action: string, params: Record<string, unknown>): Promise<unknown> {
  const internal = (
    bot as unknown as {
      internal?: { _request?: (action: string, params: Record<string, unknown>) => Promise<unknown> };
    }
  ).internal;
  if (!internal?._request) throw new Error("当前 OneBot 适配器不支持该底层操作");
  const res = (await internal._request(action, params)) as
    | { status?: string; retcode?: number; message?: string; msg?: string; wording?: string; data?: unknown }
    | undefined;
  if (res && typeof res === "object" && res.retcode !== undefined && ![0, 1].includes(Number(res.retcode))) {
    throw new Error(
      `${action} 失败（retcode ${res.retcode}${res.wording || res.message || res.msg ? `：${res.wording || res.message || res.msg}` : ""}）`,
    );
  }
  return res && typeof res === "object" && "data" in res ? res.data : res;
}

/** OneBot 的 id 多为数字；能转则转成数字，转不了原样传字符串 */
function toIdValue(id: string): number | string {
  return /^-?\d+$/.test(id) ? Number(id) : id;
}

/** 宽松解析用户 id：容忍 Bot 传入 "onebot:private:123" / "private:123" / "@123" 等形式 */
function parseUserId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return null;
  const last = trimmed.split(":").pop()!.trim();
  return last || null;
}

/** 群成员排序权重：群主 → 管理员 → 普通成员 */
function roleRank(role: unknown): number {
  return role === "owner" ? 0 : role === "admin" ? 1 : 2;
}

/** emoji 参数 → OneBot 表情编号：纯数字视为编号，否则取首个 Unicode 码点（QQ 回应支持 emoji 码点作为编号） */
function emojiToOnebotId(emoji: string): number {
  const trimmed = emoji.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const cp = trimmed.codePointAt(0);
  if (!cp) throw new Error("emoji 参数为空");
  return cp;
}

function parseChannelKey(id: string): { platform: string; channelId: string; error?: string } {
  const idx = id.indexOf(":");
  if (idx <= 0) {
    return {
      platform: "",
      channelId: "",
      error: `（频道 id 格式不对："${id}"。应为 "platform:channelId"，可先用 check_msg 查看可用频道。）`,
    };
  }
  return { platform: id.slice(0, idx), channelId: id.slice(idx + 1) };
}

function parseGalleryRef(refText: string): string | null {
  const m = refText.match(/^gallery:(.+)$/);
  return m ? m[1]!.trim() : null;
}

function sanitizeName(name: string): string | null {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  return name;
}

function typeByExt(name: string): MediaType | "file" {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return "file";
}

function toDataUrl(data: Buffer, mime: string): string {
  return `data:${mime};base64,${data.toString("base64")}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const LABEL = { image: "图片", audio: "语音", video: "视频" } as const;

/** 轻量替换媒体占位符（不触发解释器，用于预览） */
function stripPlaceholders(text: string): string {
  return text.replace(MEDIA_PLACEHOLDER, (_, _id, type) => `[${LABEL[type as keyof typeof LABEL]}]`);
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\n/g, " ");
  return single.length > max ? single.slice(0, max) + "…" : single;
}

function formatTime(date: Date): string {
  const d = new Date(date);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
