import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { h, Universal, type Bot, type Context } from "koishi";
import type { MessageSendReceipt, MessengerApi } from "../bot/agent.js";
import type { CaptionService } from "../media/captioner.js";
import {
  MAIN_CATEGORIES,
  STICKER_CATEGORY,
  UNSORTED_CATEGORY,
  ALL_CATEGORIES,
  normalizeCategory,
  sanitizeFileName,
  type GalleryStore,
} from "../media/gallery.js";
import { MEDIA_PLACEHOLDER, mediaPlaceholder, escapeMediaStorageText, type MediaRenderer } from "../media/render.js";
import type { MediaStore } from "../media/store.js";
import { mediaPart, mediaText, parseMediaId, richPartsText } from "../media/presentation.js";
import type { TtsClient } from "../media/tts.js";
import type { MediaRef, MediaType, PickFailure, PickResult, RichText, RichTextPart } from "../types.js";
import type { FocusManager } from "./focus.js";
import { atTag, faceTag, formatBanDuration, isStickerElement } from "./gateway.js";
import { needsMsgIds, type MessagingConfig, type PlatformOpsConfig } from "../config.js";
import type { KnownChannel, MessageStore } from "./messages.js";
import type { ChannelNameResolver } from "./names.js";
import type { NotifyManager } from "./notify.js";
import type { OwnSendTracker } from "./ownsends.js";
import type { RequestStore } from "./requests.js";
import { channelKey as makeChannelKey, parseChannelKey } from "./channels.js";
import { chatMessageEvidence, evidenceHash, conversationKind, conversationLabel, describeConversation, type ConversationContext } from "./conversation.js";
import { normalizeMsgId } from "./markers.js";
import { executeSelfCommand } from "./self-commands.js";

/** Explicit stable references retain interleaved text/media order without ordinal placeholders. */
const INLINE_MEDIA = /<media\s+ref=(["'])(media:[1-9]\d*|gallery:[^"'<>]+)\1\s*\/>/g;

/**
 * 「表情包」分类图片的表情标记：OneBot image 段的 sub_type=1 表示表情（QQ 按表情包渲染，
 * 对方无法"保存为图片"），summary 为聊天列表/引用中的预览文案，与 QQ 客户端发表情的行为一致。
 */
const STICKER_ATTRS = { sub_type: 1, summary: "[动画表情]" } as const;

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

type MessageTarget = { bot: Bot; platform: string; channelId: string; isDirect: boolean };

const blockedSend = (text: string): MessageSendReceipt => ({ status: "blocked", text, messageIds: [] });

/** MessengerApi 的 Koishi 实现：查看/发送消息、图片、文件、语音，浏览收藏夹 */
export class KoishiMessenger implements MessengerApi {
  private sendQueues = new Map<string, Promise<void>>();
  constructor(
    private ctx: Context,
    private store: MessageStore,
    private renderer: MediaRenderer,
    private media: MediaStore,
    private captioner: CaptionService,
    private galleryStore: GalleryStore,
    private tts: TtsClient | null,
    private focus: FocusManager,
    private notify: NotifyManager,
    private ops: PlatformOpsConfig,
    private messaging: MessagingConfig,
    private requests: RequestStore,
    private ownSends: OwnSendTracker,
    private names: ChannelNameResolver,
    /** 世界时钟的惰性访问器（禁言剩余时长按历法模式渲染；未就绪时为 null） */
    private clockInfo: () => { syncRealTime: boolean; unitRealSeconds: number } | null,
  ) {}

  /**
   * 禁言自查：查自己在这个群里的禁言状态。用于发送失败与打开群聊页时的惰性感知——
   * 即使禁言发生在插件离线期间（当刻的 group_ban notice 没被捕获）也能发现。
   * 两级检查：
   * 1. 个人禁言：get_group_member_info 的 shut_up_timestamp（禁言解除时间戳）；
   * 2. 全员禁言：get_group_info 的 group_all_shut（NapCat 扩展字段，非 0 即开启；
   *    其他实现端没有该字段时自然跳过）。管理员/群主不受全员禁言影响，不提示。
   * 未被禁言、私聊、非 OneBot 或查询失败返回 ""。
   */
  private async muteHint(target: { bot: Bot; platform: string; channelId: string }): Promise<string> {
    if (target.platform !== "onebot" || target.channelId.startsWith("private:")) return "";
    try {
      const member = (await callOnebot(target.bot, "get_group_member_info", {
        group_id: toIdValue(target.channelId),
        user_id: toIdValue(target.bot.selfId),
        no_cache: true,
      })) as { shut_up_timestamp?: number; role?: string } | undefined;
      const until = Number(member?.shut_up_timestamp ?? 0) * 1000;
      if (until > Date.now()) {
        const remain = formatBanDuration(Math.round((until - Date.now()) / 1000), this.clockInfo());
        return `你在这个群里被禁言了${remain ? `（还剩 ${remain}）` : ""}`;
      }
      // 全员禁言只约束普通成员，管理员/群主照常说话
      if ((member?.role ?? "member") === "member") {
        const group = (await callOnebot(target.bot, "get_group_info", {
          group_id: toIdValue(target.channelId),
          no_cache: true,
        })) as { group_all_shut?: number } | undefined;
        if (Number(group?.group_all_shut ?? 0) !== 0) {
          return "这个群正处于全员禁言中";
        }
      }
    } catch {
      /* 查询失败不误报，退回调用方的原始报错 */
    }
    return "";
  }

  /** 是否需要在消息记录中展示平台消息 id（撤回/回应/引用/转发/精华等操作需要引用消息编号） */
  private get showMsgId(): boolean {
    return needsMsgIds(this.ops);
  }

  // ---------- 查看 ----------

  /** 宽松解析频道 id → 规范化 key 与是否私聊（agent 进入频道页 / 自动切频道用） */
  async resolveKey(id: string): Promise<{ key: string; isPrivate: boolean } | { error: string }> {
    const resolved = await this.resolveChannel(id);
    if ("error" in resolved) return resolved;
    return {
      key: makeChannelKey(resolved.platform, resolved.channelId, resolved.selfId),
      isPrivate: resolved.isDirect,
    };
  }

  async recentChannels(n: number): Promise<RichText> {
    const channels = await this.store.recentChannels(n);
    if (!channels.length) return { text: "你翻了翻手机，最近没有任何频道有消息。", originEventIds: [] };
    const lines = await Promise.all(
      channels.map(async ({ key, latest }) => {
        const time = formatTime(latest.timestamp);
        const who = latest.self ? "本账号" : latest.username || latest.userId;
        // 预览只做轻量替换，不触发解释器
        const kind = conversationKind(latest.isDirect, latest.channelId, latest.guildId);
        return `- ${await this.names.display(key)}（${kind === "direct" ? "私聊" : kind === "group" ? "群聊" : "会话类型未知"}） [${time}] ${who}: ${truncate(stripPlaceholders(latest.content), 80)}`;
      }),
    );
    return {
      text: `你翻了翻手机，最近活跃的频道：\n${lines.join("\n")}`,
      originEventIds: [...new Set(channels.flatMap(({ key, latest }) => chatMessageEvidence(latest, parseChannelKey(key).selfId).originEventIds ?? []))],
      experience: { agency: "observed", situation: "聊天频道列表" },
    };
  }

  async channelMessages(id: string, n: number, opts?: { intro?: "open" | "read" | "echo" }): Promise<RichText> {
    const resolved = await this.resolveChannel(id);
    if ("error" in resolved) return { text: resolved.error, originEventIds: [] };
    const { platform, channelId, selfId } = resolved;
    // 打开频道 = 开始关注：一段时间内该频道的新消息会直接呈现内容
    await this.focus.focus(makeChannelKey(platform, channelId, selfId));
    const display = await this.names.display(makeChannelKey(platform, channelId, selfId));
    const rows = await this.store.channelMessages(platform, channelId, n, selfId);
    if (!rows.length) return { text: `频道 ${display} 里还没有任何消息记录。`, originEventIds: [] };

    const attachments: MediaRef[] = [];
    const lines: string[] = [];
    // 有序图文分段：让每张图的 content part 出现在它所属那条消息文字的正下方，
    // 而不是全部平铺到整段文字末尾——多图时模型才能把「哪张图」和「哪条 msg」对上，
    // 避免引用回复（reply_to）张冠李戴。
    const parts: RichTextPart[] = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx]!;
      const who = row.self ? "本账号" : row.username || row.userId;
      const rendered = await this.renderer.render(row.content);
      if (rendered.attachments) attachments.push(...rendered.attachments);
      const msgTag = this.showMsgId && row.messageId ? ` (msg:${row.messageId})` : "";
      const address = row.self ? "本账号发出的消息" : conversationLabel(row.conversation, selfId);
      const header = `〔聊天记录 #${row.id} · ${formatTime(row.timestamp)}${msgTag}〕\n发送者：${who}（账号 ${JSON.stringify(row.userId)}；${address}）\n消息正文：\n`;
      const ending = "\n〔该条消息结束〕";
      lines.push(header + rendered.text + ending);
      // 行头作为 text 段，随后依序展开该消息的图文交错分段
      if (rendered.parts?.length) {
        // 行头直接拼进第一个 text 段（若有），避免图文之间多出一个空段
        const first = rendered.parts[0]!;
        if (first.kind === "text") {
          parts.push({ kind: "text", text: header + first.text });
          for (const seg of rendered.parts.slice(1)) parts.push(seg);
        } else {
          parts.push({ kind: "text", text: header });
          for (const seg of rendered.parts) parts.push(seg);
        }
      } else {
        parts.push({ kind: "text", text: header + rendered.text });
      }
      parts.push({ kind: "text", text: ending + (idx < rows.length - 1 ? "\n" : "") });
    }
    // 最后一条是自己发的：显式点破，防止 Bot 把自己的消息当成别人的来"接话"
    let tail = rows[rows.length - 1]?.self
      ? "\n（最后一条来自本账号，之后还没有其他人的新消息；账号身份本身不证明是你亲自发送）"
      : "";
    // 打开群聊页时自查禁言状态（像 QQ 顶部的禁言横幅）：
    // 即使禁言发生在插件离线期间（notice 没被捕获），Bot 也能在这里发现
    const bot = this.ctx.bots.find((b) => b.platform === platform && (!selfId || b.selfId === selfId));
    if (bot) {
      const mute = await this.muteHint({ bot, platform, channelId });
      if (mute) tail += `\n（${mute}，禁言解除前没法在这个群里发消息）`;
    }
    const intro = opts?.intro === "read"
      ? `你翻阅了 ${display} 的聊天记录（最近 ${rows.length} 条）`
      : opts?.intro === "echo"
        ? `发送后回看 ${display} 的聊天记录（最近 ${rows.length} 条）`
        : `你打开了 ${display} 的聊天记录（最近 ${rows.length} 条）`;
    const channelKind = conversationKind(resolved.isDirect, channelId);
    const channelNote = channelKind === "group" ? "群聊 · 这是多人对话，关注或收到通知只表示看见，不表示每条都在找你。" : "私聊";
    const heading = `${intro}（${channelNote}）。这是此刻可见记录的快照，按消息时间从早到晚排列；同一频道、同一记录编号或 msg 编号再次出现是回读，不是对方又说了一遍。更早看过的内容仍属于你的经历，不因这次只显示最近几条而作废。\n发送者、时间和对话指向是界面标注；只有“消息正文”内是对方的话，不要把昵称标头当成自己要发送的内容。\n`;
    return {
      text: `${heading}${lines.join("\n")}${tail}`,
      originEventIds: [...new Set(rows.flatMap(row => chatMessageEvidence(row, selfId).originEventIds ?? []))],
      experience: {
        ...chatMessageEvidence(rows[rows.length - 1]!, selfId).experience,
        subjectIds: [...new Set(rows.flatMap(row => chatMessageEvidence(row, selfId).experience?.subjectIds ?? []))],
      },
      attachments: attachments.length ? attachments : undefined,
      parts: [{ kind: "text", text: heading }, ...parts, ...(tail ? [{ kind: "text" as const, text: tail }] : [])],
    };
  }

  /**
   * 浏览收藏夹。
   * - 不带分类：总览（各分类的条目数），未整理有存货时提醒 Bot 找空整理；
   * - 带分类：列出该分类的条目（编号、名字、描述），Bot-LLM 原生识图时附上前几张原图。
   * 描述优先用 Bot 自己写下的（gallery_save / gallery_move 时记录），没有则退回解释器摘要。
   */
  async gallery(category?: string): Promise<RichText> {
    await this.galleryStore.sweepRoot();

    if (!category?.trim()) {
      const counts = await this.galleryStore.counts();
      const total = counts.reduce((s, c) => s + c.count, 0);
      if (!total) {
        return { text: "你的收藏夹空空如也。（看到喜欢的图可以用 gallery_save 分类存进来）" };
      }
      const lines = counts.map(({ category: c, count }) => {
        const note = c === UNSORTED_CATEGORY && count > 0 ? "（尚未归类的导入内容）" : "";
        return `- ${c}：${count} 项${note}`;
      });
      const unsorted = counts.find((c) => c.category === UNSORTED_CATEGORY)?.count ?? 0;
      const tip =
        unsorted > 0
          ? `\n（「未整理」里有 ${unsorted} 项：有空时打开看看，view_media 看清内容后用 gallery_move 归类并写好描述。）`
          : "";
      return {
        text:
          `你翻了翻自己的收藏夹：\n${lines.join("\n")}\n` +
          `（用 category 参数打开某一类查看具体内容，如 check_gallery 的 category: "表情包"）${tip}`,
      };
    }

    const cat = normalizeCategory(category);
    if (!cat) {
      return { text: `（收藏夹里没有「${category}」这个分类。分类有：${ALL_CATEGORIES.join("、")}。）` };
    }
    const names = await this.galleryStore.listNames(cat);
    if (!names.length) return { text: `「${cat}」分类是空的。` };

    const attachments: MediaRef[] = [];
    const parts: RichTextPart[] = [{ kind: "text", text: `你打开了收藏夹的「${cat}」分类：\n` }];
    for (const name of names.slice(0, 50)) {
      const file = path.join(this.galleryStore.dirOf(cat), name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const type = typeByExt(name);
      if (type === "file") {
        parts.push({ kind: "text", text: `- gallery:${cat}/${name}（文件，${formatSize(stat.size)}）\n` });
        continue;
      }
      const id = await this.media.ingest(pathToFileURL(file).href, type);
      const row = id === null ? null : await this.media.get(id);
      if (!row) {
        parts.push({ kind: "text", text: `- gallery:${cat}/${name}（读取失败）\n` });
        continue;
      }
      const meta = await this.galleryStore.findMeta(cat, name, row.sha256);
      const summary = meta?.description || await this.captioner.describe(row.ref) || undefined;
      const part = mediaPart(row.ref, { name: `gallery:${cat}/${name}`, summary, ...(cat === STICKER_CATEGORY ? { sticker: true } : {}) });
      if (this.renderer.canAttach(row.ref) && attachments.length < this.renderer.maxAttach) {
        attachments.push(row.ref); parts.push(part);
      } else parts.push({ kind: "text", text: mediaText(part) });
      parts.push({ kind: "text", text: "\n" });
    }
    if (names.length > 50) parts.push({ kind: "text", text: `（还有 ${names.length - 50} 项未显示）\n` });
    parts.push({ kind: "text", text: cat === UNSORTED_CATEGORY
      ? "（这些是尚未归类的导入内容：先 view_media 看清内容，再用 gallery_move 移到合适的分类并写好描述。）"
      : "（发出前确认具体媒体内容；用 media:N 或完整 gallery:分类/文件名选择同一个媒体，不凭展示顺序猜编号。）" });
    return { text: richPartsText(parts), attachments: attachments.length ? attachments : undefined, parts };
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
        `- ${label} media:${row.id} ${formatSize(row.size)} ${formatTime(row.createdAt)}` +
          (summary ? `：${truncate(summary, 100)}` : "（无内容摘要）"),
      );
    }
    return (
      `你翻看了最近的媒体缓存（最新在前，缓存只读）：\n${lines.join("\n")}\n` +
      `（想留下的用 gallery_save 存进收藏夹——记得选好分类、写清描述）`
    );
  }

  /** 把缓存里的媒体存进收藏夹：必须选定分类并由 Bot 亲自写下描述（日后挑图全靠它） */
  async gallerySave(mediaId: string, category: string, description: string, name?: string): Promise<string> {
    const id = parseMediaId(mediaId);
    if (id === null) return `（无法理解的媒体引用："${mediaId}"。请使用 check_media 展示的 media:N。）`;
    const row = await this.media.get(id);
    if (!row) return `（找不到媒体 media:${id}，可先用 check_media 查看缓存。）`;

    const cat = normalizeCategory(category);
    if (!cat || cat === UNSORTED_CATEGORY) {
      return `（category 必须是这几类之一：${MAIN_CATEGORIES.join(" / ")}。「${UNSORTED_CATEGORY}」用于暂存导入内容，主动收藏时请选定分类。）`;
    }
    const desc = description.trim();
    if (!desc) return "（description 不能为空：用你自己的话写清这是什么、什么梗/情绪、适合什么场合发。）";

    const ext = path.extname(row.file) || "";
    let filename: string;
    if (name?.trim()) {
      const safe = sanitizeFileName(name.trim());
      if (!safe) return `（文件名不合法："${name}"）`;
      // 扩展名缺失或与媒体实际类型不符时，补上正确的扩展名（避免收藏夹误判类型）
      filename = path.extname(safe) && typeByExt(safe) === row.type ? safe : safe + ext;
    } else {
      filename = `${row.type}-${row.id}${ext}`;
    }
    await this.galleryStore.ensureDirs();
    const dest = path.join(this.galleryStore.dirOf(cat), filename);
    if (await fs.stat(dest).then((s) => s.isFile()).catch(() => false)) {
      return `（「${cat}」里已经有 "${filename}" 了，换个名字试试。）`;
    }
    await fs.copyFile(row.ref.file, dest);
    await this.galleryStore.upsertMeta(cat, filename, row.sha256, desc);
    const label = LABEL[row.type as MediaType] ?? row.type;
    return `你把${label} media:${row.id} 存进了收藏夹 ${cat}/${filename}，并记下：${truncate(desc, 100)}`;
  }

  /** 整理收藏夹：把文件移到某个分类（主要用于「未整理」的归类），可顺带写描述 */
  async galleryMove(name: string, category: string, description?: string): Promise<string> {
    const entry = await this.galleryStore.resolve(name);
    if (!entry) return `（收藏夹里没有 "${name}"，可先用 check_gallery 看看。名字可带分类前缀，如 "未整理/xx.png"。）`;
    const cat = normalizeCategory(category);
    if (!cat || cat === UNSORTED_CATEGORY) {
      return `（category 必须是这几类之一：${MAIN_CATEGORIES.join(" / ")}。）`;
    }
    if (entry.category === cat) return `（"${entry.name}" 本来就在「${cat}」里。）`;

    const desc = description?.trim();
    if (!desc) {
      // 没带新描述：必须已有 Bot 写下的描述，否则要求先看图再写
      const sha = await this.galleryStore.hashFile(entry.file).catch(() => undefined);
      const meta = entry.category
        ? await this.galleryStore.findMeta(entry.category, entry.name, sha)
        : null;
      if (!meta?.description) {
        return (
          `（"${entry.name}" 还没有描述。先用 view_media 看清它的内容，` +
          `再带上 description 参数（这是什么、什么梗/情绪、适合什么场合发）一起移动。）`
        );
      }
    }
    const moved = await this.galleryStore.move(entry, cat, desc || undefined);
    return (
      `你把 ${entry.category ? `${entry.category}/` : ""}${entry.name} 移进了「${cat}」` +
      `${moved.name !== entry.name ? `（重名，改叫 ${moved.name}）` : ""}` +
      `${desc ? `，并记下：${truncate(desc, 100)}` : "。"}`
    );
  }

  /** 把文件移出收藏夹 */
  async galleryRemove(name: string): Promise<string> {
    const entry = await this.galleryStore.resolve(name);
    if (!entry) return `（收藏夹里没有 "${name}"，可先用 check_gallery 看看。名字可带分类前缀，如 "表情包/xx.png"。）`;
    await this.galleryStore.remove(entry);
    return `你把 ${entry.category ? `${entry.category}/` : ""}${entry.name} 移出了收藏夹。`;
  }

  /**
   * 细看媒体（发图前确认内容用）：
   * - Bot-LLM 原生支持该模态 → 附原始媒体（直接看）；
   * - 否则 → 用解释器产出比常规摘要更完整的详述。
   * 同时带出收藏夹里已记下的描述（如果有）。
   */
  async viewMedia(refs: string[]): Promise<RichText> {
    const list = refs.filter((r) => String(r).trim());
    if (!list.length) return { text: "（view_media 需要 media 参数：media:N 或 gallery:分类/文件名的列表。）" };
    if (list.length > 6) return { text: "（view_media 每次最多查看 6 个媒体，本次未查看；请拆成多次调用。）" };

    const attachments: MediaRef[] = [];
    const parts: RichTextPart[] = [{ kind: "text", text: "你把这些媒体逐一打开查看；每个条目的身份、摘要与原始内容位于同一 media 块内：\n" }];
    for (const refText of list) {
      const resolved = await this.resolveMediaRef(String(refText));
      if ("error" in resolved) {
        parts.push({ kind: "text", text: `- ${refText}：${resolved.error}\n` });
        continue;
      }
      const { ref } = resolved;
      const row = await this.media.get(ref.id);
      const meta = resolved.gallery
        ? await this.galleryStore.findMeta(resolved.gallery.category, resolved.gallery.name, row?.sha256)
        : row ? await this.galleryStore.findBySha(row.sha256) : null;
      const native = this.renderer.canAttach(ref) && attachments.length < this.renderer.maxAttach;
      const summary = native ? await this.captioner.describe(ref) : await this.captioner.describeDetailed(ref);
      const description = [summary, meta?.description ? `收藏时记下的描述：${meta.description}` : ""].filter(Boolean).join("\n");
      const name = resolved.gallery ?? meta;
      const part = mediaPart(ref, { name: name ? `gallery:${name.category}/${name.name}` : undefined, summary: description || undefined, ...(resolved.sticker ? { sticker: true } : {}) });
      if (native) { attachments.push(ref); parts.push(part); }
      else parts.push({ kind: "text", text: mediaText(part, description ? "当前通过文字描述了解内容，未展开原始媒体" : "当前无法查看内容") });
      parts.push({ kind: "text", text: "\n" });
    }
    return { text: richPartsText(parts), attachments: attachments.length ? attachments : undefined, parts };
  }

  /**
   * 选图：解析一串媒体引用（media:N / gallery:分类/文件）为具体的 MediaRef + sticker，
   * 供 agent 的 pick_media 工具「选定并插入输入框」用。每项返回判别联合：解析成功或失败。
   */
  async resolveMediaRefs(
    refs: string[],
  ): Promise<(PickResult | PickFailure)[]> {
    const out: (PickResult | PickFailure)[] = [];
    for (const refText of refs) {
      const r = await this.resolveMediaRef(String(refText));
      if ("error" in r) out.push({ ok: false, refText: String(refText), error: r.error });
      else out.push({ ok: true, ref: r.ref, sticker: r.sticker });
    }
    return out;
  }

  // ---------- 发送 ----------


  async send(
    id: string,
    msg: string,
    media: (string | number)[] = [],
    replyTo?: string,
    atSender = true,
    insist = false,
  ): Promise<string> {
    return (await this.sendReceipt(id, msg, media, replyTo, atSender, insist)).text;
  }

  async sendReceipt(id: string, msg: string, media: (string | number)[] = [], replyTo?: string, atSender = true, insist = false): Promise<MessageSendReceipt> {
    const target = await this.resolveBot(id);
    if ("error" in target) return blockedSend(target.error);
    const key = makeChannelKey(target.platform, target.channelId, target.bot.selfId);
    // All callers share one channel queue. A cold-channel check cannot race another send,
    // and a split sticker/text message cannot interleave with the next call.
    this.sendQueues ??= new Map();
    const result = (this.sendQueues.get(key) ?? Promise.resolve()).then(() => this.sendResolved(target, id, msg, media, replyTo, atSender, insist));
    const tail = result.then(() => undefined, () => undefined);
    this.sendQueues.set(key, tail);
    void tail.then(() => { if (this.sendQueues.get(key) === tail) this.sendQueues.delete(key); });
    return result;
  }

  private async sendResolved(target: MessageTarget, id: string, msg: string, media: (string | number)[], replyTo: string | undefined, atSender: boolean, insist: boolean): Promise<MessageSendReceipt> {
    if (/<img\b|\[(?:图片|视频|音频|语音)#\d+/i.test(msg)) {
      return blockedSend('（消息没有发出：旧媒体占位格式已停用。请先 view_media 确认内容，再在原位置填写 <media ref="media:12"/>，或在 media 参数里给出明确引用。）');
    }
    if (/<media\b/i.test(msg.replace(INLINE_MEDIA, ""))) return blockedSend('（消息没有发出：媒体标签格式无效。请使用 <media ref="media:12"/>；摘要或名称不能代替媒体引用。）');
    if (media.length > 9) return blockedSend("（消息没有发出：media 参数最多包含 9 个媒体，请分开选择。）");
    if (replyTo !== undefined) {
      const normalized = normalizeMsgId(replyTo);
      if (!normalized) return blockedSend("（消息没有发出：reply_to 必须是完整消息 ID 或 msg:ID / (msg:ID)，不能使用 media:N、gallery:路径或说明文字。）");
      replyTo = normalized;
    }

    // 冷频道刷屏拦截：最近 N 条消息全是自己发的（无人回应）时，继续发送需要 insist 确认。
    // 在实际发出时刻检查（而非生成时刻）——打字期间对方回复了就不拦。
    const coldLimit = this.messaging.coldChannelMsgs;
    if (coldLimit > 0 && !insist) {
      const recent = await this.store.channelMessages(target.platform, target.channelId, coldLimit, target.bot.selfId);
      if (recent.length >= coldLimit && recent.every((r) => r.self)) {
        return blockedSend(
          `（消息没有发出：你已经连着给 ${id} 发了至少 ${recent.length} 条消息，对方一直没有回应。` +
          `先等其他人有新回应；不要将已经说过的内容缩短或换个措辞再发。` +
          `如果你确实还有必须现在说的话，在参数里加上 insist: true 再发。）`
        );
      }
    }

    const ordered: { el: h; stored: string; sticker: boolean }[] = [];
    const add = (el: h, stored: string, sticker = false) => ordered.push({ el, stored, sticker });
    const sentRefs: MediaRef[] = [];
    const problems: string[] = [];
    const inlineIds = new Set<number>();
    let atNote = "";

    // 出站富文本解析：<at …/>、<face …/> 标签（入站渲染的照抄形式）与
    // at 标记/裸 @名字（按频道参与者解析）→ 真正的消息元素，杜绝"字面假 @"。
    // 私聊没有 at：at 一律降级为 @名字 文本，表情照常可用
    const isGroup = !target.isDirect;
    let participants: { userId: string; username: string }[] | null = null;
    const getParticipants = async (): Promise<{ userId: string; username: string }[]> => {
      if (participants) return participants;
      try {
        const channels = await this.store.knownChannels();
        participants =
          channels.find((c) => c.platform === target.platform && c.channelId === target.channelId && c.selfId === target.bot.selfId)
            ?.participants ?? [];
      } catch {
        participants = [];
      }
      return participants;
    };
    const pushText = async (text: string): Promise<void> => {
      if (!text) return;
      const parts = renderRichParts(text, isGroup ? await getParticipants() : [], { allowAt: isGroup });
      for (const part of parts) {
        if (typeof part === "string") {
          add(h.text(part), part);
        } else {
          add(part.el, part.stored);
        }
      }
    };

    // A copied quote and reply_to use the same message-ID namespace and validation.
    let quoteFromTag: string | undefined;
    let quoteError = false;
    msg = msg
      .replace(/<quote\s+([^<>]*?)\/?>(?:<\/quote>)?/g, (_whole, attrsRaw: string) => {
        const attrs = parseTagAttrs(attrsRaw);
        const normalized = normalizeMsgId(attrs.id);
        if (!normalized || (quoteFromTag && quoteFromTag !== normalized)) quoteError = true;
        else quoteFromTag = normalized;
        return "";
      })
      .trimStart();
    if (quoteError || /<quote\b/i.test(msg) || (replyTo && quoteFromTag && replyTo !== quoteFromTag)) {
      return blockedSend("（消息没有发出：引用标签必须指定同一条消息的完整 ID，且须与 reply_to 一致；media:N、gallery:路径和多个不同引用不能代替消息 ID。）");
    }
    replyTo ??= quoteFromTag;
    if (replyTo && !this.ops.reply) return blockedSend("（消息没有发出：当前未启用引用回复能力；若要发送普通消息，请移除 reply_to 和引用标签后重新决定。）");

    // 引用回复：模拟 QQ 客户端行为——群聊里引用时自动在开头 @ 原发送人 + 空格，
    // Bot 可用 at_sender: false 去掉（如同真人手动删掉自动加上的 @）。
    // 私聊没有 @ 的概念，强制不附加 at（QQ 私聊无法渲染 at，只会留下一个孤零零的空格）。
    if (replyTo) {
      add(h("quote", { id: replyTo }), `[引用 msg:${replyTo}] `);
      if (target.isDirect) atSender = false;
      if (atSender) {
        const quoted = await this.store.findByMessageId(target.platform, target.channelId, replyTo, target.bot.selfId);
        if (quoted && !quoted.self && quoted.userId) {
          add(h("at", { id: quoted.userId, name: quoted.username || undefined }), `@${quoted.username || quoted.userId}`);
          add(h.text(" "), " ");
          atNote = `，并 @ 了 ${quoted.username || quoted.userId}`;
          // 去重兜底：reply_to 已自动 @ 了原发送人，把 msg 里指向同一人的 <at id> 剥掉（避免连续重复 @）。
          // 只剥"恰好这个 user id"的标签，不伤及 @ 他人的正常写法。
          msg = stripAtTagById(msg, quoted.userId).trimStart();
        }
      }
    }

    // Explicit media references expand exactly where they occur in the outgoing message.
    let cursor = 0;
    for (const match of msg.matchAll(INLINE_MEDIA)) {
      const before = msg.slice(cursor, match.index);
      cursor = match.index! + match[0].length;
      const resolved = await this.resolveMediaRef(match[2]!, ["image", "video"]);
      if ("error" in resolved) {
        problems.push(resolved.error);
        await pushText(before); // 标记未被替换：保留原空白，避免两侧文字粘连
        continue;
      }
      await pushText(before);
      const mediaEl = await this.mediaElement(resolved.ref, resolved.sticker);
      add(mediaEl, mediaPlaceholder(resolved.ref.id, resolved.ref.type, resolved.sticker), resolved.sticker);
      sentRefs.push(resolved.ref);
      inlineIds.add(resolved.ref.id);
    }
    await pushText(msg.slice(cursor));

    // media 参数中的媒体（未在 msg 中内联过的）追加在末尾
    for (const item of media.slice(0, 9)) {
      const resolved = await this.resolveMediaRef(String(item), ["image", "video"]);
      if ("error" in resolved) {
        problems.push(resolved.error);
        continue;
      }
      if (inlineIds.has(resolved.ref.id)) continue;
      const mediaEl = await this.mediaElement(resolved.ref, resolved.sticker);
      add(mediaEl, mediaPlaceholder(resolved.ref.id, resolved.ref.type, resolved.sticker), resolved.sticker);
      sentRefs.push(resolved.ref);
    }
    if (problems.length) return blockedSend(`（消息没有发出：媒体选择未通过验证。${problems.join("；")}）`);
    if (!ordered.some(part => part.el.type !== "quote")) return blockedSend("（消息没有发出：没有可发送的内容。）");
    // Split only at sticker boundaries. Moving all stickers behind all text reverses the meaning
    // of messages such as "第一张 <sticker A> 第二张 <image B>".
    const batches: { elements: h[]; stored: string; sticker: boolean }[] = [];
    for (const part of ordered) {
      const last = batches.at(-1);
      if (last && last.sticker === part.sticker) { last.elements.push(part.el); last.stored += part.stored; }
      else batches.push({ elements: [part.el], stored: part.stored, sticker: part.sticker });
    }
    // A quote-only prefix is metadata for the first actual batch, never a standalone message.
    if (batches[0]?.elements.every(el => el.type === "quote") && batches[1]) {
      const prefix = batches.shift()!;
      batches[0]!.elements.unshift(...prefix.elements); batches[0]!.stored = prefix.stored + batches[0]!.stored;
    }

    const sentMsgIds: string[] = [];
    const receiptProblems: string[] = [];
    const channelKey = makeChannelKey(target.platform, target.channelId, target.bot.selfId);
    let confirmedAt: Date | undefined;
    const confirmedEvidence = (): Pick<MessageSendReceipt, "originEventIds" | "experience"> => {
      if (!sentMsgIds.length || !confirmedAt) return {};
      const metadata = sentMsgIds.map(messageId => chatMessageEvidence({ id: 0,
        platform: target.platform, channelId: target.channelId, selfId: target.bot.selfId,
        userId: target.bot.selfId, messageId, timestamp: confirmedAt! }));
      return { originEventIds: [...new Set(metadata.flatMap(item => item.originEventIds ?? []))],
        // Only the action runner knows whether a human or the character chose this.
        experience: { episodeId: metadata[0]!.experience?.episodeId, situation: metadata[0]!.experience?.situation } };
    };
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]!;
      let ids: string[];
      try {
        ids = await this.runOwnSend(channelKey, () => target.bot.sendMessage(target.channelId, batch.elements));
      } catch (err) {
        const mute = await this.muteHint(target);
        const text = `${bi > 0 ? `（消息已部分发出：前 ${bi} 批已由平台确认${sentMsgIds.length ? `（msg:${sentMsgIds.join("、")}）` : ""}。` : "（"}` +
          `第 ${bi + 1} 批没有取得发送确认：${sendFailText(err)}。${mute ? `${mute}。` : ""}` +
          `这不等于消息一定没有送达，请先查看聊天记录；不要将整条内容缩短后重发，也不要重复已确认的部分。后续 ${batches.length - bi - 1} 批没有提交。）`;
        return { status: bi > 0 ? "partial" : "unknown", text, messageIds: sentMsgIds, ...confirmedEvidence() };
      }
      if (!Array.isArray(ids) || !ids.some(Boolean)) {
        return { status: bi > 0 ? "partial" : "unknown", messageIds: sentMsgIds, ...confirmedEvidence(),
          text: `（${bi ? `前 ${bi} 批已确认发送；` : ""}第 ${bi + 1} 批的调用已经返回，但平台没有提供消息确认，送达状态未知。后续批次没有提交，也未执行聊天指令。请先查看聊天记录，不要直接重复发送。）` };
      }
      sentMsgIds.push(...ids.filter(Boolean));
      confirmedAt = new Date();
      // Platform success is irreversible. A local record failure must never claim it did not send.
      try { await this.storeSelf(target, batch.stored, ids[0], confirmedAt); }
      catch { receiptProblems.push(`第 ${bi + 1} 批已由平台确认发送，但本地聊天记录保存失败`); }
    }
    try { await this.focus.focus(channelKey); }
    catch { receiptProblems.push("消息已发送，但本地频道关注状态更新失败"); }
    // Bot 自己玩 Koishi 指令（可选）：消息以已注册指令名开头时，以它自己的身份执行
    if (this.messaging.selfCommands && ordered.every(part => part.el.type === "text")) {
      const sentText = ordered.map(part => String(part.el.attrs.content ?? "")).join("");
      void this.tryExecuteSelfCommand(target, sentText, sentMsgIds[0]).catch((err) => {
        this.ctx.logger("yesimbot-world").warn("自发指令执行失败: %s", err);
      });
    }
    let result = `消息已发送到 ${id}。`;
    if (this.showMsgId && sentMsgIds[0]) result = `消息已发送到 ${id}（msg:${sentMsgIds.join("、")}）。`;
    if (replyTo) result += `（引用回复了 msg:${replyTo}${atNote}）`;
    if (sentRefs.length) result += `（附 ${sentRefs.length} 个媒体，依次为 ${sentRefs.map(ref => `media:${ref.id}`).join("、")}）`;
    const stickerCount = ordered.filter(part => part.sticker).length;
    if (stickerCount) result += `（其中 ${stickerCount} 个表情包按原顺序单独发送）`;
    if (problems.length) result += `注意：${problems.join("；")}`;
    if (receiptProblems.length) result += `注意：${receiptProblems.join("；")}；不要重复发送。`;
    return { status: "sent", text: result, messageIds: sentMsgIds, ...confirmedEvidence() };
  }

  private runOwnSend<T>(key: string, run: () => Promise<T>): Promise<T> {
    return typeof this.ownSends.run === "function" ? this.ownSends.run(key, run) : run();
  }

  /**
   * 媒体引用 → 消息元素（图片 / 视频）。
   * sticker = true 的图片标记为平台表情：OneBot 适配器会把元素上的额外属性原样并入
   * image 段的 data，NapCat 端据此以 sub_type=1（表情）发送——QQ 会按表情包尺寸渲染，
   * 且别人无法将其"保存为图片"，与真人发的表情包行为一致（发普通大图反而容易暴露是 Bot）。
   * 其他平台的适配器会忽略这两个未知属性，不受影响。
   */
  private async mediaElement(ref: MediaRef, sticker = false): Promise<h> {
    const data = await this.media.readFile(ref);
    const src = toDataUrl(data, ref.mime);
    if (ref.type === "video") return h("video", { src });
    return sticker ? h("img", { src, ...STICKER_ATTRS }) : h("img", { src });
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
      const entry = await this.galleryStore.resolve(gallery);
      if (!entry) return `（收藏夹里没有 "${gallery}"，可先用 check_gallery 查看。）`;
      const data = await fs.readFile(entry.file);
      const ext = path.extname(entry.name).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
      const type = typeByExt(entry.name);
      element = this.fileElement(type, data, mime, entry.name, {
        sticker: type === "image" && entry.category === STICKER_CATEGORY,
      });
      if (type === "audio" || type === "video" || type === "image") {
        const mediaId = await this.media.ingest(toDataUrl(data, mime), type);
        stored = mediaId !== null ? mediaPlaceholder(mediaId, type, type === "image" && entry.category === STICKER_CATEGORY) : `[文件 ${entry.name}]`;
      } else {
        stored = `[文件 ${entry.name}]`;
      }
    } else {
      const resolved = await this.resolveMediaRef(refText);
      if ("error" in resolved) return resolved.error;
      const data = await this.media.readFile(resolved.ref);
      const name = path.basename(resolved.ref.file);
      element = this.fileElement(resolved.ref.type, data, resolved.ref.mime, name, {
        sticker: resolved.sticker,
      });
      stored = mediaPlaceholder(resolved.ref.id, resolved.ref.type, resolved.sticker);
    }

    let msgIds: string[] = [];
    const channelKey = makeChannelKey(target.platform, target.channelId, target.bot.selfId);
    try {
      msgIds = await this.runOwnSend(channelKey, () => target.bot.sendMessage(target.channelId, element));
    } catch (err) {
      const mute = await this.muteHint(target);
      return `（文件发送没有取得确认：${sendFailText(err)}。${mute ? `${mute}。` : ""}可能已送达，请先查看记录，不要直接重发。）`;
    }
    if (!msgIds?.some(Boolean)) return "（文件发送调用已返回，但未取得平台消息确认，送达状态未知；请先查看聊天记录，不要直接重发。）";
    const notes = await this.recordConfirmedSend(target, stored, msgIds[0]);
    return `文件已发送到 ${id}。${notes}`;
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
    const channelKey = makeChannelKey(target.platform, target.channelId, target.bot.selfId);
    try {
      msgIds = await this.runOwnSend(channelKey, () => target.bot.sendMessage(
        target.channelId,
        h("audio", { src: toDataUrl(audio.data, audio.mime) }),
      ));
    } catch (err) {
      const mute = await this.muteHint(target);
      return `（语音发送没有取得确认：${sendFailText(err)}。${mute ? `${mute}。` : ""}可能已送达，请先查看记录，不要直接重发。）`;
    }
    if (!msgIds?.some(Boolean)) return "（语音发送调用已返回，但未取得平台消息确认，送达状态未知；请先查看聊天记录，不要直接重发。）";
    // 入资产库留痕，历史记录中可回看
    let mediaId: number | null = null;
    let assetNote = "";
    try {
      mediaId = await this.media.ingest(toDataUrl(audio.data, audio.mime), "audio");
      if (mediaId !== null) await this.media.setSummary(mediaId, `（语音转写）${text}`);
    } catch { assetNote = "（语音已发送，但本地音频保存失败；不要重复发送。）"; }
    const stored =
      mediaId !== null ? `${mediaPlaceholder(mediaId, "audio")}（语音内容：${text}）` : `[语音] ${text}`;
    const notes = await this.recordConfirmedSend(target, stored, msgIds[0]);
    return `语音已发送到 ${id}：「${text}」${assetNote}${notes}`;
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

  /** 给某条消息贴 / 移除表情回应 */
  async react(id: string, msgId: string, emoji: string, remove = false): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;
    try {
      if (target.platform === "onebot") {
        // OneBot：set_msg_emoji_like（NapCat / LLOneBot / Lagrange 扩展）
        await callOnebot(target.bot, "set_msg_emoji_like", {
          message_id: toIdValue(msgId),
          emoji_id: emojiToOnebotId(emoji),
          set: !remove,
        });
      } else if (remove) {
        await target.bot.deleteReaction(target.channelId, msgId, emoji);
      } else {
        await target.bot.createReaction(target.channelId, msgId, emoji);
      }
    } catch (err) {
      return `（${remove ? "移除回应" : "贴表情"}失败：${(err as Error).message ?? err}）`;
    }
    return remove
      ? `你移除了自己给 ${id} 里的消息（msg:${msgId}）贴的 ${emoji} 回应。`
      : `你给 ${id} 里的消息（msg:${msgId}）贴上了 ${emoji} 的回应。`;
  }

  /** 查看某条消息上某个表情回应的用户列表（NapCat 特有） */
  async emojiLikes(id: string, msgId: string, emoji: string): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;
    if (target.platform !== "onebot") return "（查看回应者目前只支持 QQ（OneBot/NapCat）平台。）";
    const emojiId = emojiToOnebotId(emoji);
    // NapCat 按 id 长度区分回应类型：不超过三位为 QQ 系统表情，更长的为 Unicode emoji 码点
    const emojiType = String(emojiId).length <= 3 ? "1" : "2";
    let data: Record<string, unknown>;
    try {
      data = ((await callOnebot(target.bot, "fetch_emoji_like", {
        message_id: toIdValue(msgId),
        emojiId: String(emojiId),
        emojiType,
        emoji_id: String(emojiId),
        emoji_type: emojiType,
      })) ?? {}) as Record<string, unknown>;
    } catch (err) {
      return `（查看回应者失败：${(err as Error).message ?? err}。需要 NapCat 支持 fetch_emoji_like。）`;
    }
    const list = Array.isArray(data.emojiLikesList) ? (data.emojiLikesList as Record<string, unknown>[]) : [];
    if (!list.length) return `（消息（msg:${msgId}）上还没有人贴 ${emoji} 的回应。）`;
    const names = list.slice(0, 50).map((u) => String(u.nickName ?? u.tinyId ?? "?"));
    return `你看了看消息（msg:${msgId}）上 ${emoji} 回应的名单（${list.length} 人）：${names.join("、")}`;
  }

  /** 把几条已有消息合并转发到某个频道（仅 OneBot） */
  async forwardMsgs(id: string, msgIds: string[]): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;
    if (target.platform !== "onebot") return "（合并转发目前只支持 QQ（OneBot）平台。）";
    const ids = msgIds.slice(0, 50);
    const messages = ids.map((m) => ({ type: "node", data: { id: toIdValue(m) } }));
    const isPrivate = target.isDirect;
    const key = makeChannelKey(target.platform, target.channelId, target.bot.selfId);
    let data: Record<string, unknown>;
    try {
      data = ((await this.runOwnSend(key, () => callOnebot(
        target.bot,
        isPrivate ? "send_private_forward_msg" : "send_group_forward_msg",
        isPrivate
          ? { user_id: toIdValue(target.channelId.slice("private:".length)), messages }
          : { group_id: toIdValue(target.channelId), messages },
      ))) ?? {}) as Record<string, unknown>;
    } catch (err) {
      return `（合并转发没有取得确认：${(err as Error).message ?? err}。可能已送达，请先查看记录，不要直接重发。）`;
    }
    const newId = data.message_id != null ? String(data.message_id) : "";
    if (!newId) return "（合并转发调用已返回，但未取得平台消息确认，送达状态未知；请先查看聊天记录，不要直接重发。）";
    const notes = await this.recordConfirmedSend(target, `[合并转发了 ${ids.length} 条消息：${ids.map((m) => `msg:${m}`).join("、")}]`, newId);
    return `你把 ${ids.length} 条消息打包成聊天记录，合并转发到了 ${id}${this.showMsgId ? `（msg:${newId}）` : ""}。${notes}`;
  }

  /**
   * 嵌套聊天记录的内容缓存：NapCat 不支持按内层 resid 拉取（retcode 1200），
   * 但会把内层内容内联在外层响应里——查看外层时缓存下来，点开内层直接读缓存。
   */
  private forwardCache = new Map<string, Record<string, unknown>[]>();

  private cacheForward(nodes: Record<string, unknown>[], preferId?: string): string {
    // Reopening an outer record must not invent a fresh ID/experience for the same
    // embedded child. Platforms without nested IDs still expose a stable payload.
    const key = preferId?.trim() || `nested_${evidenceHash(nodes).slice(0, 32)}`;
    this.forwardCache.delete(key);
    this.forwardCache.set(key, nodes);
    while (this.forwardCache.size > 30) {
      const oldest = this.forwardCache.keys().next().value;
      if (oldest === undefined) break;
      this.forwardCache.delete(oldest);
    }
    return key;
  }

  /**
   * 点开一条合并转发的聊天记录，返回内部消息列表。
   * 嵌套的聊天记录不展开，渲染为 <forward id="…"/> 供继续点开。
   */
  async viewForward(rawId: string): Promise<RichText> {
    return this.viewForwardInner(rawId, true);
  }

  private async viewForwardInner(rawId: string, allowRedirect: boolean): Promise<RichText> {
    // 嵌套层：内容已随外层响应内联缓存，直接读取
    let nodes = this.forwardCache.get(rawId) ?? null;
    let lastErr = "";
    if (!nodes) {
      const bot = this.findOnebot();
      if (!bot) return { text: "（查看聊天记录目前只支持 QQ（OneBot）平台，但当前没有唯一可确定的在线 OneBot 账号。）", originEventIds: [] };
      // 依次尝试：message_id（NapCat 按所在消息取）→ id（resid，go-cqhttp/旧记录）。
      // 不能同时传：部分实现端优先读 id，resid 失效时会直接报错、轮不到 message_id
      for (const params of [{ message_id: toIdValue(rawId) }, { id: rawId }]) {
        try {
          const data = ((await callOnebot(bot, "get_forward_msg", params)) ?? {}) as Record<string, unknown>;
          const got = (Array.isArray(data.messages) ? data.messages : Array.isArray(data.message) ? data.message : []) as Record<string, unknown>[];
          if (got.length) {
            nodes = got;
            break;
          }
        } catch (err) {
          lastErr = String((err as Error).message ?? err);
        }
      }
    }
    if (!nodes?.length) {
      // 纠错：Bot 可能把 (msg:xxx) 消息编号当成了转发 id——找到那条消息，
      // 提取其中 <forward id="…"/> 标签里的真实 id 再试一次
      if (allowRedirect) {
        const row = await this.store.findAnyByMessageId(rawId);
        if (row) {
          const m = row.content.match(/<forward id="([^"]+)"\/>/);
          const tagId = m?.[1];
          if (tagId && tagId !== rawId) return this.viewForwardInner(tagId, false);
          if (!m) {
            return {
              text: `（消息（msg:${rawId}）不是合并转发的聊天记录——view_forward 的 id 要用消息里 <forward id="…"/> 标签中的那个。）`,
              originEventIds: [],
            };
          }
        }
      }
      return { text: `（点不开这份聊天记录：${lastErr || "内容为空或格式无法解析"}。它可能已过期，或需要先点开包含它的那一层。）`, originEventIds: [] };
    }

    const selfId = this.findOnebot()?.selfId ?? "";
    const lines: string[] = [];
    const shown = nodes.slice(0, 50);
    for (const node of shown) {
      // NapCat/go-cqhttp 的节点形态：{ sender: {nickname}, time?, content|message: 消息段数组 }
      const sender = (node.sender ?? {}) as Record<string, unknown>;
      const who =
        selfId && String(sender.user_id ?? "") === String(selfId)
          ? "本账号"
          : String(sender.nickname ?? sender.card ?? node.nickname ?? sender.user_id ?? "?");
      const time =
        typeof node.time === "number" && node.time > 0 ? `[${formatTime(new Date(node.time * 1000))}] ` : "";
      const segments = (Array.isArray(node.content) ? node.content : Array.isArray(node.message) ? node.message : []) as Record<string, unknown>[];
      const body = typeof node.content === "string" ? escapeMediaStorageText(node.content) : await this.serializeRawSegments(segments);
      lines.push(`〔转发条目 · ${time || "原时间未知"}〕\n转发内署名：${who}\n转发正文：\n${body || "（空消息）"}\n〔转发条目结束〕`);
    }
    if (nodes.length > shown.length) lines.push(`（还有 ${nodes.length - shown.length} 条未显示）`);

    // 媒体占位符 → 按当前能力渲染（原生附件 / 解释文本）
    const rendered = await this.renderer.render("你读到这份转发记录。下面的署名、时间和正文来自转发内容；它们不是这些人此刻在当前聊天中又说了一遍，也不证明本账号署名的内容由你亲自发出。\n" + lines.join("\n"));
    const root = "chat-forward:" + evidenceHash(["onebot", selfId, rawId]);
    return { ...rendered, originEventIds: [root], experience: {
      episodeId: root, agency: "observed", situation: "阅读转发记录", subjectIds: [],
    } };
  }

  /** 原始 OneBot 消息段 → 存储文本（媒体入资产库，嵌套聊天记录保留为标签） */
  private async serializeRawSegments(segments: Record<string, unknown>[]): Promise<string> {
    let out = "";
    for (const seg of segments) {
      const d = (seg.data ?? {}) as Record<string, unknown>;
      switch (seg.type) {
        case "text":
          out += escapeMediaStorageText(String(d.text ?? ""));
          break;
        case "image":
        case "mface":
        case "sticker": {
          const src = String(d.url ?? d.file ?? "");
          const sticker = isStickerElement(h(seg.type === "image" ? "img" : String(seg.type), d));
          const id = src ? await this.media.ingest(src, "image", undefined, undefined, sticker) : null;
          out += id !== null ? mediaPlaceholder(id, "image", sticker) : sticker ? "[表情包（获取失败）]" : "[图片（获取失败）]";
          break;
        }
        case "record": {
          const src = String(d.url ?? d.file ?? "");
          const id = src ? await this.media.ingest(src, "audio") : null;
          out += id !== null ? mediaPlaceholder(id, "audio") : "[语音（获取失败）]";
          break;
        }
        case "video": {
          const src = String(d.url ?? d.file ?? "");
          const id = src ? await this.media.ingest(src, "video") : null;
          out += id !== null ? mediaPlaceholder(id, "video") : "[视频（获取失败）]";
          break;
        }
        case "at":
          out += d.qq === "all" ? "@全体成员" : `@${d.name ?? d.qq ?? ""}`;
          break;
        case "face":
          out += faceTag(String(d.id ?? ""), d.name ? String(d.name) : undefined);
          break;
        case "forward":
        case "node": {
          // 嵌套的聊天记录：内联内容缓存下来（NapCat 无法按内层 resid 拉取），
          // 渲染为标签供 view_forward 继续点开
          const inline = Array.isArray(d.content) ? (d.content as Record<string, unknown>[]) : null;
          if (inline?.length) {
            const key = this.cacheForward(inline, d.id != null ? String(d.id) : undefined);
            out += `<forward id="${key.replace(/"/g, "&quot;")}"/>`;
          } else if (d.id != null) {
            out += `<forward id="${String(d.id).replace(/"/g, "&quot;")}"/>`;
          } else {
            out += "[嵌套的聊天记录（无法点开）]";
          }
          break;
        }
        case "reply":
          out += "[引用了一条消息]";
          break;
        case "json":
        case "xml":
          out += "[卡片消息]";
          break;
        default:
          out += `[${String(seg.type ?? "?")}]`;
          break;
      }
    }
    return out;
  }

  /** 识别图片中的文字（OCR，仅 OneBot） */
  async ocrImage(image: string): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（图片文字识别目前只支持 QQ（OneBot）平台，但没有唯一可确定的在线 OneBot 账号（多账号的全局资料操作需先明确账号）。）";
    const resolved = await this.resolveMediaRef(image, ["image"]);
    if ("error" in resolved) return resolved.error;
    const data = await this.media.readFile(resolved.ref);
    const params = { image: `base64://${data.toString("base64")}` };
    let result: unknown;
    try {
      result = await callOnebot(bot, "ocr_image", params);
    } catch {
      try {
        result = await callOnebot(bot, ".ocr_image", params);
      } catch (err) {
        return `（图片文字识别失败：${(err as Error).message ?? err}）`;
      }
    }
    // go-cqhttp / NapCat：{ texts: [{text, ...}], language } 或直接返回数组
    const items = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : Array.isArray((result as Record<string, unknown> | undefined)?.texts)
        ? ((result as Record<string, unknown>).texts as Record<string, unknown>[])
        : [];
    const texts = items.map((t) => String(t.text ?? "").trim()).filter(Boolean);
    if (!texts.length) return `你仔细看了看图片 media:${resolved.ref.id}，上面没认出什么文字。`;
    return `你仔细辨认了图片 media:${resolved.ref.id} 上的文字：\n${texts.slice(0, 100).join("\n")}`;
  }

  /** 戳一戳（仅 OneBot，需实现端支持 friend_poke / group_poke） */
  async poke(id: string, userId?: string): Promise<string> {
    const target = await this.resolveBot(id);
    if ("error" in target) return target.error;
    if (target.platform !== "onebot") return "（戳一戳目前只支持 QQ（OneBot）平台。）";
    const isPrivate = target.isDirect;
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
    const candidates = this.ctx.bots.filter((b) => b.platform === req.platform && b.isActive);
    const bot = req.selfId ? candidates.find((b) => b.selfId === req.selfId) : candidates.length === 1 ? candidates[0] : undefined;
    if (!bot) return `（手机没有信号：${req.platform} 的连接暂时断开，处理不了这个请求。稍后再试。）`;
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
        ? `你通过了 ${who} 的好友申请。现在可以在 ${makeChannelKey(req.platform, `private:${req.userId}`, bot.selfId)} 和 TA 聊天了。`
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
    if (!bot) return "（修改资料目前只支持 QQ（OneBot）平台，但没有唯一可确定的在线 OneBot 账号（多账号的全局资料操作需先明确账号）。）";
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

  /** 修改资料卡上显示的在线机型（仅 OneBot） */
  async setModelShow(model: string): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（修改在线机型目前只支持 QQ（OneBot）平台，但没有唯一可确定的在线 OneBot 账号（多账号的全局资料操作需先明确账号）。）";
    const params = { model, model_show: model };
    try {
      await callOnebot(bot, "set_model_show", params);
    } catch {
      try {
        await callOnebot(bot, "_set_model_show", params);
      } catch (err) {
        return `（修改在线机型失败：${(err as Error).message ?? err}）`;
      }
    }
    return `你把资料卡上显示的在线机型改成了「${model}」。`;
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
    if (!bot) return "（没有唯一可确定的在线 OneBot 账号（多账号的全局资料操作需先明确账号）。）";
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
    if (!bot) return "（没有唯一可确定的在线 OneBot 账号（多账号的全局资料操作需先明确账号）。）";
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
    if (!bot) return "（没有唯一可确定的在线 OneBot 账号（多账号的全局资料操作需先明确账号）。）";
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
    if (!bot) return "（没有唯一可确定的在线 OneBot 账号（多账号的全局资料操作需先明确账号）。）";
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

  /** 查看群荣誉（龙王、群聊之火等） */
  async groupHonor(id: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    let data: Record<string, unknown>;
    try {
      data = ((await callOnebot(target.bot, "get_group_honor_info", {
        group_id: toIdValue(target.groupId),
        type: "all",
      })) ?? {}) as Record<string, unknown>;
    } catch (err) {
      return `（查看群荣誉失败：${(err as Error).message ?? err}）`;
    }
    const lines: string[] = [];
    const current = data.current_talkative as Record<string, unknown> | undefined;
    if (current?.user_id != null) {
      const days = typeof current.day_count === "number" && current.day_count > 0 ? `，蝉联 ${current.day_count} 天` : "";
      lines.push(`- 当前龙王：${current.nickname ?? current.user_id}（${current.user_id}${days}）`);
    }
    const section = (key: string, label: string) => {
      const list = data[key];
      if (!Array.isArray(list) || !list.length) return;
      const names = (list as Record<string, unknown>[])
        .slice(0, 10)
        .map((m) => `${m.nickname ?? m.user_id}${m.description ? `（${m.description}）` : ""}`);
      lines.push(`- ${label}：${names.join("、")}${list.length > 10 ? ` 等 ${list.length} 人` : ""}`);
    };
    section("talkative_list", "历史龙王");
    section("performer_list", "群聊之火");
    section("legend_list", "群聊炽焰");
    section("strong_newbie_list", "冒尖小春笋");
    section("emotion_list", "快乐之源");
    if (!lines.length) return `（群 ${id} 目前没有任何群荣誉记录。）`;
    return `你看了看群 ${id} 的群荣誉：\n${lines.join("\n")}`;
  }

  /** 浏览群文件（只读）：默认根目录，folderId 可进入子文件夹 */
  async groupFiles(id: string, folderId?: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    let data: Record<string, unknown>;
    try {
      data = ((await callOnebot(
        target.bot,
        folderId ? "get_group_files_by_folder" : "get_group_root_files",
        folderId
          ? { group_id: toIdValue(target.groupId), folder_id: folderId }
          : { group_id: toIdValue(target.groupId) },
      )) ?? {}) as Record<string, unknown>;
    } catch (err) {
      return `（浏览群文件失败：${(err as Error).message ?? err}）`;
    }
    const folders = Array.isArray(data.folders) ? (data.folders as Record<string, unknown>[]) : [];
    const files = Array.isArray(data.files) ? (data.files as Record<string, unknown>[]) : [];
    if (!folders.length && !files.length) {
      return folderId ? `（这个文件夹是空的。）` : `（群 ${id} 的群文件是空的。）`;
    }
    const lines: string[] = [];
    for (const f of folders.slice(0, 30)) {
      lines.push(
        `- [文件夹] ${f.folder_name ?? "（未命名）"}（${f.total_file_count ?? "?"} 个文件，folder:${f.folder_id}）`,
      );
    }
    for (const f of files.slice(0, 50)) {
      const size = typeof f.file_size === "number" ? formatSize(f.file_size) : "?";
      const uploader = f.uploader_name ? `，${f.uploader_name} 上传` : "";
      const time =
        typeof f.upload_time === "number" && f.upload_time > 0
          ? `，${formatTime(new Date(f.upload_time * 1000))}`
          : "";
      lines.push(`- ${f.file_name ?? "（未命名）"}（${size}${uploader}${time}）`);
    }
    const omitted = Math.max(0, folders.length - 30) + Math.max(0, files.length - 50);
    if (omitted > 0) lines.push(`（还有 ${omitted} 项未显示）`);
    const where = folderId ? `群 ${id} 的一个文件夹` : `群 ${id} 的群文件`;
    return `你翻了翻${where}（${folders.length} 个文件夹、${files.length} 个文件）：\n${lines.join("\n")}`;
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
    await this.focus.unfocus(makeChannelKey(target.platform, target.channelId, target.bot.selfId));
    return `你退出了群 ${id}。`;
  }

  /** 设置 / 移出群精华消息 */
  async setEssence(msgId: string, remove: boolean): Promise<string> {
    const bot = this.findOnebot();
    if (!bot) return "（没有唯一可确定的在线 OneBot 账号（多账号的全局资料操作需先明确账号）。）";
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

  /** 查看群公告列表 */
  async getGroupNotice(id: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    let data: Record<string, unknown>[];
    try {
      data = ((await callOnebot(target.bot, "_get_group_notice", {
        group_id: toIdValue(target.groupId),
      })) ?? []) as Record<string, unknown>[];
    } catch (err) {
      return `（查看群公告失败：${(err as Error).message ?? err}）`;
    }
    if (!Array.isArray(data) || !data.length) return `（群 ${id} 目前没有公告。）`;
    const lines = data.slice(0, 10).map((n) => {
      const msg = n.message as Record<string, unknown> | undefined;
      const text = truncate(String(msg?.text ?? "").replace(/&#10;/g, " "), 120) || "（无文字内容）";
      const images = Array.isArray(msg?.images) && msg.images.length ? `（附 ${msg.images.length} 张图）` : "";
      const time =
        typeof n.publish_time === "number" && n.publish_time > 0
          ? `[${formatTime(new Date(n.publish_time * 1000))}] `
          : "";
      return `- ${time}${text}${images}`;
    });
    const more = data.length > 10 ? `\n（还有 ${data.length - 10} 条较早的公告未显示）` : "";
    return `你看了看群 ${id} 的公告（共 ${data.length} 条，新的在前）：\n${lines.join("\n")}${more}`;
  }

  /** 查看群精华消息列表 */
  async essenceList(id: string): Promise<string> {
    const target = await this.resolveOnebotGroup(id);
    if ("error" in target) return target.error;
    let data: Record<string, unknown>[];
    try {
      data = ((await callOnebot(target.bot, "get_essence_msg_list", {
        group_id: toIdValue(target.groupId),
      })) ?? []) as Record<string, unknown>[];
    } catch (err) {
      return `（查看群精华失败：${(err as Error).message ?? err}）`;
    }
    if (!Array.isArray(data) || !data.length) return `（群 ${id} 还没有精华消息。）`;
    const lines = data.slice(0, 20).map((e) => {
      const sender = e.sender_nick ?? e.sender_id ?? "?";
      const time =
        typeof e.sender_time === "number" && e.sender_time > 0
          ? `[${formatTime(new Date(e.sender_time * 1000))}] `
          : "";
      const msgTag = this.showMsgId && e.message_id != null ? ` (msg:${e.message_id})` : "";
      return `- ${time}${sender}${msgTag}：${essencePreview(e)}`;
    });
    const more = data.length > 20 ? `\n（还有 ${data.length - 20} 条未显示）` : "";
    return `你翻了翻群 ${id} 的精华消息（共 ${data.length} 条）：\n${lines.join("\n")}${more}`;
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

  /** Only confirmed, plain-text sends may enter the account's normal Koishi command path. */
  private async tryExecuteSelfCommand(
    target: { bot: Bot; platform: string; channelId: string; isDirect?: boolean },
    msg: string,
    messageId?: string,
  ): Promise<void> {
    await executeSelfCommand(this.ctx, target, msg, messageId);
  }

  private findOnebot(): Bot | undefined {
    // 只返回在线实例（断线中的实例 internal 未就绪，见 resolveBot）
    const candidates = this.ctx.bots.filter((b) => b.platform === "onebot");
    const accounts = new Set(candidates.map((b) => b.selfId));
    return accounts.size === 1 ? candidates.find((b) => b.isActive) : undefined;
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
            // 兼容两种返回形态：Universal.User 本体（onebot 等适配器）或 { user: {...} } 包装
            const user = (friend.user ?? friend) as { id?: string; name?: string; nick?: string };
            const uid = user.id;
            if (!uid) continue;
            const name = friend.nick || user.nick || user.name || uid;
            lines.push(`- ${name}（${makeChannelKey(bot.platform ?? "unknown", `private:${uid}`, bot.selfId)}）`);
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

  // ---------- 离线历史补拉 ----------

  /**
   * 插件离线期间错过的群消息补拉（OneBot 扩展接口 get_group_msg_history）。
   * 世界启动时由 service 调用一次：把离线期间目标群的消息写进消息记录（翻记录时
   * 能看到这段时间发生了什么），不注入逐条事件打扰当前上下文。
   * 目标群 = 正在关注的 + 通知列表里的 + 最近活跃的，且仅限 OneBot 群（私聊无此接口）。
   * 返回各群补到的消息条数；群还没有任何已存消息时不拉（尊重创世 / 清空记录）。
   */
  async syncOfflineHistory(): Promise<{ total: number; channels: { key: string; count: number }[] }> {
    const empty = { total: 0, channels: [] as { key: string; count: number }[] };
    if (!this.messaging.offlineHistory) return empty;

    const keys = new Set<string>();
    for (const k of this.focus.activeKeys()) keys.add(k);
    for (const k of this.notify.keys()) {
      if (k !== "*") keys.add(k);
    }
    // 通知列表里配了 "*" 时用最近活跃的频道兜底（"*" 本身不是具体频道）
    for (const { key } of await this.store.recentChannels(10)) keys.add(key);

    const channels: { key: string; count: number }[] = [];
    let total = 0;
    for (const key of keys) {
      const resolved = await this.resolveChannel(key);
      if ("error" in resolved) continue;
      const { platform, channelId, selfId } = resolved;
      if (platform !== "onebot" || channelId.startsWith("private:")) continue;
      try {
        const count = await this.syncGroupHistory(platform, channelId, selfId);
        if (count > 0) {
          channels.push({ key, count });
          total += count;
        }
      } catch (err) {
        this.ctx
          .logger("yesimbot-world")
          .warn("离线历史补拉失败 %s: %s", key, (err as Error).message ?? err);
      }
    }
    return { total, channels };
  }

  /**
   * 单个群的离线历史补拉：以群内已存消息的最大时间为水位线，向前翻 get_group_msg_history。
   * 按 messageId 去重（含边界上同一秒实时入库的新消息）；早于水位线 / 未来的消息跳过。
   * count=50/页，最多 4 页，按时间正序入库；取本页最小 message_seq（或响应的 next_seq）
   * 继续往前翻，翻到水位线以内、页不满或 seq 不再递减时终止。
   */
  private async syncGroupHistory(platform: string, channelId: string, accountId?: string): Promise<number> {
    const bot = accountId
      ? this.ctx.bots.find((b) => b.platform === platform && b.selfId === accountId && b.isActive)
      : this.findOnebot();
    if (!bot) return 0;

    // 水位线：群内最后一条已存消息的时间（毫秒）；群还没有记录就不拉
    const latest = await this.store.channelMessages(platform, channelId, 1, bot.selfId);
    if (!latest.length) return 0;
    const watermarkMs = latest[0]!.timestamp.getTime();
    // 去重依据：该群已存的最近消息 id（也覆盖边界上同一秒实时入库的新消息）
    const known = new Set<string>();
    for (const row of await this.store.channelMessages(platform, channelId, 500, bot.selfId)) {
      if (row.messageId) known.add(row.messageId);
    }

    const params: Record<string, unknown> = { group_id: toIdValue(channelId), count: 50 };
    const selfId = String(bot.selfId ?? "");
    let added = 0;
    for (let page = 0; page < 4; page++) {
      const data = ((await callOnebot(bot, "get_group_msg_history", params)) ?? {}) as {
        messages?: unknown[];
        next_seq?: number | string;
      };
      const messages = (Array.isArray(data.messages) ? data.messages : []) as Record<string, unknown>[];
      if (!messages.length) break;

      const rows: { timeMs: number; msgId: string; seq: number; self: boolean; userId: string; username: string; content: string; conversation?: ConversationContext }[] = [];
      let minSeq = Infinity;
      let anyOlderThanWatermark = false;
      for (const raw of messages) {
        const timeMs = Number(raw.time ?? 0) * 1000;
        if (timeMs > 0 && timeMs < watermarkMs) anyOlderThanWatermark = true;
        const msgId = String(raw.message_id ?? "");
        if (!msgId || known.has(msgId)) continue;
        known.add(msgId);
        if (timeMs <= 0 || timeMs < watermarkMs || timeMs > Date.now()) continue;
        const seq = Number(raw.message_seq ?? 0);
        if (Number.isFinite(seq) && seq > 0 && seq < minSeq) minSeq = seq;
        const sender = (raw.sender ?? {}) as Record<string, unknown>;
        const senderId = String(sender.user_id ?? "");
        const self = !!selfId && senderId === selfId;
        const username = self ? "（我）" : String(sender.card ?? sender.nickname ?? sender.user_id ?? "?");
        let content = "";
        let conversation: ConversationContext | undefined;
        if (Array.isArray(raw.message)) {
          content = await this.serializeRawSegments(raw.message as Record<string, unknown>[]);
          conversation = rawGroupConversation(raw.message as Record<string, unknown>[]);
        } else if (typeof raw.message === "string") {
          content = raw.message;
        } else if (Array.isArray(raw.content)) {
          content = await this.serializeRawSegments(raw.content as Record<string, unknown>[]);
          conversation = rawGroupConversation(raw.content as Record<string, unknown>[]);
        } else if (typeof raw.content === "string") {
          content = raw.content;
        }
        if (!content.trim()) continue;
        rows.push({ timeMs, msgId, seq, self, userId: senderId, username, content, conversation });
      }

      rows.sort((a, b) => a.timeMs - b.timeMs || a.seq - b.seq);
      for (const r of rows) {
        if (r.conversation?.reply?.messageId) {
          const original = await this.store.findByMessageId(platform, channelId, r.conversation.reply.messageId, bot.selfId);
          if (original?.userId) r.conversation.reply.userId = original.userId;
        }
        await this.store.store({
          platform,
          channelId,
          selfId: bot.selfId,
          guildId: "",
          userId: r.userId,
          username: r.username,
          content: r.content,
          timestamp: new Date(r.timeMs),
          self: r.self,
          messageId: r.msgId,
          isDirect: false,
          conversation: r.conversation,
        });
        added++;
      }

      // 本页已翻到水位线以内 → 前面的都更早，无需再翻
      if (anyOlderThanWatermark) break;
      // 页不满说明到底了
      if (messages.length < 50) break;
      const nextSeq = (() => {
        const fromResp = Number(data.next_seq ?? 0);
        if (Number.isFinite(fromResp) && fromResp > 0) return fromResp;
        return Number.isFinite(minSeq) && minSeq < Infinity ? minSeq : 0;
      })();
      // seq 没有往前推进（与上一页相同）说明没有更早的消息了
      if (nextSeq <= 0 || nextSeq === params.message_seq) break;
      params.message_seq = nextSeq;
    }
    return added;
  }

  // ---------- 内部 ----------

  private async resolveBot(
    id: string,
  ): Promise<{ bot: Bot; platform: string; channelId: string; isDirect: boolean } | { error: string }> {
    const resolved = await this.resolveChannel(id);
    if ("error" in resolved) return resolved;
    const { platform, channelId, isDirect, selfId } = resolved;
    const candidates = this.ctx.bots.filter((b) => b.platform === platform && (!selfId || b.selfId === selfId));
    if (!candidates.length) return { error: `（消息没发出去：没有接入 ${platform} 平台的账号。）` };
    // 只用在线的实例：断线/重连中的僵尸实例内部未就绪，调用会炸出费解的底层错误
    const bot = candidates.find((b) => b.isActive);
    if (!bot) return { error: `（手机没有信号：${platform} 的连接暂时断开了，消息没发出去。稍等片刻再试。）` };
    return { bot, platform, channelId, isDirect };
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
  ): Promise<{ platform: string; channelId: string; selfId?: string; isDirect: boolean } | { error: string }> {
    const { platform, channelId, selfId, error } = parseChannelKey(id);
    let channels: KnownChannel[] = [];
    try {
      channels = await this.store.knownChannels();
    } catch {
      /* 查询失败时退化为原有行为 */
    }

    if (!error) {
      const hits = channels.filter((c) => c.platform === platform && c.channelId === channelId && (!selfId || c.selfId === selfId));
      const accounts = [...new Set(hits.map((c) => c.selfId).filter(Boolean))];
      if (hits.length) return this.withAccount(platform, channelId, hits[0]!.isDirect, selfId ?? (accounts.length === 1 ? accounts[0] : undefined));
      // 显式账号可打开该账号尚无历史的新频道；不能被另一个账号的同名频道纠错抢走。
      if (selfId) return this.withAccount(platform, channelId, channelId.startsWith("private:"), selfId);
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
    // 存储查不到（新频道/历史数据）：回退 onebot 的 private: 前缀约定
    return this.withAccount(platform, channelId, channelId.startsWith("private:"), selfId);
  }

  private withAccount(platform: string, channelId: string, isDirect: boolean, selfId?: string):
    { platform: string; channelId: string; selfId?: string; isDirect: boolean } | { error: string } {
    if (selfId) return { platform, channelId, selfId, isDirect };
    const accounts = [...new Set(this.ctx.bots.filter((b) => b.platform === platform).map((b) => b.selfId).filter(Boolean))];
    if (accounts.length > 1) {
      return { error: `（频道属于哪个账号尚不明确，没有执行操作。请使用：${accounts.map((account) => makeChannelKey(platform, channelId, account)).join("、")}。）` };
    }
    return { platform, channelId, selfId: accounts[0], isDirect };
  }

  /**
   * 解析媒体引用：media:N 或 gallery:分类/文件名；裸数字仅为界面输入便利，禁止末尾数字猜测。
   * sticker：图片是否属于收藏夹「表情包」分类（发送时应作为平台表情而非普通图片呈现）——
   * 收藏夹引用直接看分类；裸媒体编号按 sha256 反查收藏记录（同一张图无论怎么引用都一致）。
   */
  private async resolveMediaRef(
    refText: string,
    allowTypes?: MediaType[],
  ): Promise<{ ref: MediaRef; sticker: boolean; gallery?: { category: string; name: string } } | { error: string }> {
    const galleryName = parseGalleryRef(refText);
    if (galleryName !== null) {
      const entry = await this.galleryStore.resolve(galleryName);
      if (!entry) return { error: `（收藏夹里没有唯一匹配的 "${galleryName}"；先用 check_gallery 确认，并使用 gallery:分类/文件名。）` };
      const type = typeByExt(entry.name);
      if (type === "file") return { error: `（"${entry.name}" 不是图片/语音/视频，不能当作媒体插入。）` };
      if (allowTypes && !allowTypes.includes(type)) {
        return { error: `（"${entry.name}" 是${LABEL[type]}，不能放进这里。）` };
      }
      const id = await this.media.ingest(pathToFileURL(entry.file).href, type);
      if (id === null) return { error: `（读取 "${entry.name}" 失败，可先用 check_gallery 确认它存在。）` };
      const row = await this.media.get(id);
      if (!row) return { error: `（读取 "${entry.name}" 失败。）` };
      return { ref: row.ref, sticker: type === "image" && entry.category === STICKER_CATEGORY, gallery: { category: entry.category, name: entry.name } };
    }
    const id = parseMediaId(refText);
    if (id === null) return { error: `（无法理解的媒体引用："${refText}"。请使用 media:N 或 gallery:分类/文件名，不能用 msg:消息编号。）` };
    const row = await this.media.get(id);
    if (!row) return { error: `（找不到媒体 media:${id}，它可能未被收录。）` };
    if (allowTypes && !allowTypes.includes(row.ref.type)) {
      return {
        error: `（media:${row.id} 是${LABEL[row.ref.type]}，不能放进这里。）`,
      };
    }
    let sticker = false;
    if (row.ref.type === "image") {
      // 优先级：收藏夹显式分类「表情包」> 媒体库的 sticker 标记（入站时识别为图片表情）
      const meta = await this.galleryStore.findBySha(row.sha256).catch(() => null);
      sticker = meta?.category === STICKER_CATEGORY || row.sticker === true;
    }
    return { ref: row.ref, sticker };
  }

  private fileElement(
    type: MediaType | "file",
    data: Buffer,
    mime: string,
    name: string,
    opts: { sticker?: boolean } = {},
  ): h {
    const src = toDataUrl(data, mime);
    // 图片/音频/视频用对应元素（audio 在 QQ 等平台即语音）；其他一律 file
    if (type === "video") return h("video", { src, title: name });
    if (type === "audio") return h("audio", { src, title: name });
    // 「表情包」分类的图片作为平台表情发送（见 mediaElement 的说明）
    if (type === "image") return h("img", { src, title: name, ...(opts.sticker ? STICKER_ATTRS : {}) });
    return h("file", { src, title: name });
  }

  private async storeSelf(
    target: { bot: Bot; platform: string; channelId: string; isDirect: boolean },
    content: string,
    messageId?: string,
    timestamp = new Date(),
  ): Promise<void> {
    await this.store.store({
      platform: target.platform,
      channelId: target.channelId,
      selfId: target.bot.selfId,
      guildId: "",
      userId: target.bot.selfId ?? "self",
      username: "（我）",
      content,
      timestamp,
      self: true,
      messageId: messageId ?? "",
      isDirect: target.isDirect,
    });
  }

  /** Best-effort bookkeeping may add a warning, but can never turn a confirmed send into failure. */
  private async recordConfirmedSend(target: MessageTarget, content: string, messageId?: string): Promise<string> {
    const warnings: string[] = [];
    try { await this.storeSelf(target, content, messageId); }
    catch { warnings.push("本地聊天记录保存失败"); }
    try { await this.focus.focus(makeChannelKey(target.platform, target.channelId, target.bot.selfId)); }
    catch { warnings.push("本地关注状态更新失败"); }
    return warnings.length ? `（平台已经确认发送；${warnings.join("、")}。不要重复发送。）` : "";
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

/** 把底层适配器的费解报错翻译成 Bot 能理解的表述 */
function sendFailText(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (msg.includes("_request is not a function")) {
    return "聊天平台的连接未就绪（可能正在重连），稍后再试";
  }
  return msg;
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

export type RichPart = string | { el: h; stored: string };

function unescTag(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

/** 宽容解析标签属性：双引号 / 单引号 / 无引号（模型在 JSON 里转义失败时的变体） */
export function parseTagAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of raw.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+))/g)) {
    attrs[a[1]!] = unescTag(a[2] ?? a[3] ?? a[4] ?? "");
  }
  return attrs;
}

/**
 * 从文本里剥离指向指定 user id 的 <at …/> 标签（去重兜底：reply_to 已自动 @ 了此人，
 * Bot 又在 msg 里手写了同一个 <at id>，这里剥掉后者避免连续重复 @）。
 * 只匹配 id 恰好等于目标 id 的标签；不伤及 @ 他人、<at type="all"/> 或裸 @名字。
 */
function stripAtTagById(text: string, userId: string): string {
  if (!userId) return text;
  return text.replace(/<at\s+([^<>]*?)\/?>/g, (whole, attrsRaw: string) => {
    const attrs = parseTagAttrs(attrsRaw);
    return attrs.id === userId ? "" : whole;
  });
}

/**
 * 出站富文本解析：文本中的结构标签 → 真正的消息元素（与入站渲染同构，Bot 照抄即可），
 * 按优先级：
 * 1. 标签形式（最精准）：<at id="10001" name="小明"/>、<at type="all"/>、<face id="212"/>；
 * 2. at 标记形式（宽容变体）：[@名字(10001)] / [@10001] / [@名字] / [@全体成员]；
 * 3. 裸 @名字：按频道参与者解析（参与者名是 token 前缀也算命中，如 "@小明你好"）。
 * 解析不了的保持原文，绝不误伤普通文本。
 * allowAt=false（私聊）时 at 一律降级为 @名字 文本（QQ 私聊没有 at）。
 */
export function renderRichParts(
  text: string,
  participants: { userId: string; username: string }[],
  opts: { allowAt: boolean } = { allowAt: true },
): RichPart[] {
  const out: RichPart[] = [];
  const atEl = (id: string, name?: string): RichPart =>
    opts.allowAt
      ? { el: h("at", { id, name: name || undefined }), stored: atTag(id, name) }
      : `@${name || id}`;
  const byName = (name: string) => participants.find((p) => p.username && p.username === name);

  const pushWithBareAts = (chunk: string): void => {
    if (!chunk) return;
    const bare = /@([^\s@，。,.!！？?:：;；()（）[\]]{1,24})/g;
    let cur = 0;
    for (const m of chunk.matchAll(bare)) {
      const token = m[1]!;
      let hit = byName(token);
      let rest = "";
      if (!hit) {
        const pre = [...participants]
          .filter((p) => p.username)
          .sort((a, b) => b.username.length - a.username.length)
          .find((p) => token.startsWith(p.username));
        if (pre) {
          hit = pre;
          rest = token.slice(pre.username.length);
        }
      }
      if (!hit) continue; // 不是任何参与者：保持原文
      const before = chunk.slice(cur, m.index);
      if (before) out.push(before);
      out.push(atEl(hit.userId, hit.username));
      if (rest) out.push(rest);
      cur = m.index! + m[0].length;
    }
    const tail = chunk.slice(cur);
    if (tail) out.push(tail);
  };

  const atAll = (): RichPart =>
    opts.allowAt ? { el: h("at", { type: "all" }), stored: `<at type="all"/>` } : "@全体成员";

  // 标记形式（宽容变体）：[@名字(10001)] / [@10001] / [@名字] / [@全体成员]
  const pushWithMarkers = (chunk: string): void => {
    if (!chunk) return;
    const marker = /\[@([^[\]\n]{1,32})\]/g;
    let cur = 0;
    for (const m of chunk.matchAll(marker)) {
      pushWithBareAts(chunk.slice(cur, m.index));
      cur = m.index! + m[0].length;
      const inner = m[1]!.trim();
      if (inner === "全体成员" || inner.toLowerCase() === "all") {
        out.push(atAll());
        continue;
      }
      const withId = inner.match(/^(.*?)\s*\((\d{3,})\)$/);
      if (withId) {
        out.push(atEl(withId[2]!, withId[1]!.trim() || undefined));
        continue;
      }
      if (/^\d{3,}$/.test(inner)) {
        out.push(atEl(inner, participants.find((p) => p.userId === inner)?.username));
        continue;
      }
      const p = byName(inner);
      if (p) out.push(atEl(p.userId, p.username));
      else out.push(m[0]); // 解析不了：保留原文
    }
    pushWithBareAts(chunk.slice(cur));
  };

  // 标签形式（最高优先级）：<at …/>、<face …/>
  const tag = /<(at|face)\s+([^<>]*?)\/?>(?:<\/(?:at|face)>)?/g;
  let cursor = 0;
  for (const m of text.matchAll(tag)) {
    pushWithMarkers(text.slice(cursor, m.index));
    cursor = m.index! + m[0].length;
    const kind = m[1]!;
    const attrs = parseTagAttrs(m[2]!);
    if (kind === "face") {
      if (attrs.id) {
        out.push({
          el: h("face", { id: attrs.id, name: attrs.name || undefined }),
          stored: faceTag(attrs.id, attrs.name || undefined),
        });
      } else {
        out.push(m[0]); // 没有 id 的表情标签：无法还原，保留原文
      }
      continue;
    }
    if (attrs.type === "all") {
      out.push(atAll());
    } else if (attrs.id) {
      out.push(atEl(attrs.id, attrs.name || participants.find((p) => p.userId === attrs.id)?.username));
    } else if (attrs.name && byName(attrs.name)) {
      const p = byName(attrs.name)!;
      out.push(atEl(p.userId, p.username));
    } else {
      out.push(m[0]); // 无法解析的标签：保留原文
    }
  }
  pushWithMarkers(text.slice(cursor));
  return out;
}

/** 精华消息条目的内容预览：兼容 content 为消息段数组 / 字符串 / 缺失（不同实现端返回不一） */
function essencePreview(entry: Record<string, unknown>): string {
  const content = entry.content;
  if (typeof content === "string" && content.trim()) return truncate(content, 80);
  if (Array.isArray(content)) {
    const parts = (content as Record<string, unknown>[]).map((seg) => {
      const data = (seg.data ?? {}) as Record<string, unknown>;
      if (seg.type === "text") return String(data.text ?? "");
      if (seg.type === "image") return "[图片]";
      if (seg.type === "face") return "[表情]";
      return `[${String(seg.type ?? "?")}]`;
    });
    const text = parts.join("").trim();
    if (text) return truncate(text, 80);
  }
  return "（无法预览的内容）";
}

/** emoji 参数 → OneBot 表情编号：纯数字视为编号，否则取首个 Unicode 码点（QQ 回应支持 emoji 码点作为编号） */
function emojiToOnebotId(emoji: string): number {
  const trimmed = emoji.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const cp = trimmed.codePointAt(0);
  if (!cp) throw new Error("emoji 参数为空");
  return cp;
}

function parseGalleryRef(refText: string): string | null {
  const m = refText.match(/^gallery:(.+)$/);
  return m ? m[1]!.trim() : null;
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
  return text.replace(MEDIA_PLACEHOLDER, (_, _id, type, sticker) => `[${sticker === "true" ? "表情包" : LABEL[type as keyof typeof LABEL]}]`);
}

/** Offline OneBot history carries structured segments too; preserve the same evidence as live sessions. */
export function rawGroupConversation(segments: Record<string, unknown>[]): ConversationContext {
  const elements = segments.map(segment => {
    const data = (segment.data && typeof segment.data === "object" ? segment.data : {}) as Record<string, unknown>;
    switch (segment.type) {
      case "text": return h.text(String(data.text ?? ""));
      case "at": return h("at", data.qq === "all" ? { type: "all" } : { id: data.qq });
      case "reply": return h("quote", { id: data.id });
      case "image": return h("img", data);
      case "mface":
      case "sticker": return h(String(segment.type), data);
      case "record": return h("audio", data);
      case "video": return h("video", data);
      case "face": return h("face", data);
      case "forward":
      case "node": return h("forward", {});
      default: return h("unknown", {});
    }
  });
  return describeConversation(elements, "group", isStickerElement);
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
