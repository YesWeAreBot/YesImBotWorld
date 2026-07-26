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
import type { KnownChannel, MessageStore } from "./messages.js";

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
  ) {}

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
      lines.push(`[${formatTime(row.timestamp)}] ${who}: ${rendered.text}`);
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

  // ---------- 发送 ----------

  async send(id: string, msg: string, images: (string | number)[] = []): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;

    const elements: h[] = [];
    if (msg) elements.push(h.text(msg));
    const sentRefs: MediaRef[] = [];
    const problems: string[] = [];
    for (const item of images.slice(0, 9)) {
      const resolved = await this.resolveMediaRef(String(item), "image");
      if ("error" in resolved) {
        problems.push(resolved.error);
        continue;
      }
      const data = await this.media.readFile(resolved.ref);
      elements.push(h("img", { src: toDataUrl(data, resolved.ref.mime) }));
      sentRefs.push(resolved.ref);
    }
    if (!elements.length) return `（消息没发出去：没有可发送的内容。${problems.join("；")}）`;

    try {
      await target.bot.sendMessage(target.channelId, elements);
    } catch (err) {
      return `（消息发送失败：${(err as Error).message ?? err}）`;
    }
    const stored =
      (msg || "") + sentRefs.map((ref) => mediaPlaceholder(ref.id, ref.type)).join("");
    await this.storeSelf(target, stored);
    await this.focus.focus(`${target.platform}:${target.channelId}`);
    let result = `消息已发送到 ${id}。`;
    if (sentRefs.length) result += `（附 ${sentRefs.length} 张图片）`;
    if (problems.length) result += `注意：${problems.join("；")}`;
    return result;
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

    try {
      await target.bot.sendMessage(target.channelId, element);
    } catch (err) {
      return `（文件发送失败：${(err as Error).message ?? err}）`;
    }
    await this.storeSelf(target, stored);
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
    try {
      await target.bot.sendMessage(
        target.channelId,
        h("audio", { src: toDataUrl(audio.data, audio.mime) }),
      );
    } catch (err) {
      return `（语音发送失败：${(err as Error).message ?? err}）`;
    }
    // 入资产库留痕，历史记录中可回看
    const mediaId = await this.media.ingest(toDataUrl(audio.data, audio.mime), "audio");
    if (mediaId !== null) await this.media.setSummary(mediaId, `（语音转写）${text}`);
    const stored =
      mediaId !== null ? `${mediaPlaceholder(mediaId, "audio")}（语音内容：${text}）` : `[语音] ${text}`;
    await this.storeSelf(target, stored);
    await this.focus.focus(`${target.platform}:${target.channelId}`);
    return `语音已发送到 ${id}：「${text}」`;
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

  /** 解析媒体引用："12" / "media:12" / "图片#12" / "gallery:name.png" */
  private async resolveMediaRef(
    refText: string,
    requireType?: MediaType,
  ): Promise<{ ref: MediaRef } | { error: string }> {
    const galleryName = parseGalleryRef(refText);
    if (galleryName !== null) {
      const safe = sanitizeName(galleryName);
      if (!safe) return { error: `（文件名不合法："${galleryName}"）` };
      const file = path.join(this.galleryDir, safe);
      const type = typeByExt(safe);
      if (requireType && type !== requireType) {
        return { error: `（"${safe}" 不是${requireType === "image" ? "图片" : "所需类型"}，请用 send_file 发送）` };
      }
      if (type === "file") return { error: `（"${safe}" 不是媒体文件，请用 send_file 发送）` };
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
    if (requireType && row.ref.type !== requireType) {
      return { error: `（#${row.id} 是${row.ref.type}，不是${requireType}；音视频请用 send_file 发送。）` };
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
    });
  }
}

// ---------- 工具函数 ----------

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
