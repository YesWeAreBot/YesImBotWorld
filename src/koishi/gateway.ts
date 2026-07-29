import { h, type Context, type Session } from "koishi";
import { needsMsgIds, type MessagingConfig, type PlatformOpsConfig } from "../config.js";
import type { MediaRenderer } from "../media/render.js";
import { MEDIA_PLACEHOLDER, mediaPlaceholder } from "../media/render.js";
import type { MediaStore } from "../media/store.js";
import type { PhoneStatus, RichText } from "../types.js";
import type { FocusManager } from "./focus.js";
import type { MessageStore } from "./messages.js";
import type { NotifyManager } from "./notify.js";
import type { OwnSendTracker } from "./ownsends.js";
import type { RequestStore } from "./requests.js";

export interface GatewayCallbacks {
  /** 向 Bot-LLM 投递通知事件；wake 表示是否唤醒 wait() 中的 Bot */
  notify(content: RichText, wake: boolean): void;
  /** 外部（其他插件/指令输出）以 Bot 账号发出的消息（externalSelfMessages 开启时） */
  selfMessage(channelKey: string, content: string): void;
}

/**
 * Koishi 消息网关：
 * - 所有收到的消息一律入库（图片/音频/视频下载进资产库，存占位符）；
 * - 来自 Bot 正在关注的频道的消息，无视通知策略，必定以完整内容呈现并唤醒 Bot；
 * - 来自 Allow Notification 频道列表的消息，按处理策略生成 Event 投递给 Bot-LLM。
 */
export class Gateway {
  constructor(
    private ctx: Context,
    private cfg: MessagingConfig,
    private ops: PlatformOpsConfig,
    private store: MessageStore,
    private media: MediaStore,
    private renderer: MediaRenderer,
    private focus: FocusManager,
    private notifyList: NotifyManager,
    private phone: PhoneStatus,
    private requests: RequestStore,
    private ownSends: OwnSendTracker,
    private callbacks: GatewayCallbacks,
  ) {
    // 用 message 事件而非中间件：保证他人的指令消息（会被指令系统处理）也一样被当作普通消息
    // 入库并按通知策略投递（指令照常执行，互不影响）
    ctx.on("message", (session) => {
      void this.handle(session).catch((err) => {
        ctx.logger("yesimbot-world").warn("消息处理失败: %s", err);
      });
    });

    // Bot 账号发出的、非本插件产生的消息（其他插件/指令输出等）
    if (cfg.externalSelfMessages !== "off") {
      ctx.on("send", (session) => {
        void this.handleSelfSent(session).catch((err) => {
          ctx.logger("yesimbot-world").warn("外发消息处理失败: %s", err);
        });
      });
    }

    // 平台请求事件（好友申请 / 入群邀请 / 入群申请）：登记后以手机通知的形式告知 Bot
    if (ops.handleRequests) {
      ctx.on("friend-request", (session) => this.handleRequestEvent(session, "friend"));
      ctx.on("guild-request", (session) => this.handleRequestEvent(session, "guild"));
      ctx.on("guild-member-request", (session) => this.handleRequestEvent(session, "member"));
    }

    // 戳一戳：OneBot 的 notify/poke 是 notice 而非 message，不会走 message 事件。
    // NapCat 系适配器把这类 notice 以 internal/session 派发（type: "notice", subtype: "poke"）
    ctx.on("internal/session" as never, ((session: Session) => {
      void this.handlePoke(session).catch((err) => {
        ctx.logger("yesimbot-world").warn("戳一戳处理失败: %s", err);
      });
    }) as never);
  }

  /** 别人戳了 Bot：转为手机通知并入库（群里别人互戳与 Bot 自己戳人不理会） */
  private async handlePoke(session: Session): Promise<void> {
    if (session.type !== "notice") return;
    const raw = ((session as unknown as { onebot?: Record<string, unknown> }).onebot ??
      (session.event as unknown as { _data?: Record<string, unknown> })?._data ??
      {}) as Record<string, unknown>;
    const subtype = (session as unknown as { subtype?: string }).subtype ?? String(raw.sub_type ?? "");
    if (subtype !== "poke") return;

    const selfId = String(session.selfId ?? session.bot?.selfId ?? "");
    const pokerId = String(raw.user_id ?? session.userId ?? "");
    const targetId = String(raw.target_id ?? "");
    if (!selfId || targetId !== selfId || pokerId === selfId) return;

    const platform = session.platform ?? "onebot";
    const groupId = raw.group_id != null ? String(raw.group_id) : "";
    const channelId = groupId || `private:${pokerId}`;
    const key = `${platform}:${channelId}`;
    const who = await this.lookupUsername(platform, channelId, pokerId);

    // 入库：打开频道时能看到这条互动
    await this.store.store({
      platform,
      channelId,
      guildId: groupId,
      userId: pokerId,
      username: who,
      content: "[戳了戳你]",
      timestamp: new Date(),
      self: false,
      messageId: "",
    });

    if (this.phone.down) {
      this.callbacks.notify({ text: "放在一边的手机震了一下。" }, this.cfg.wakeOnNotify);
      return;
    }
    const text = groupId
      ? `手机提示：${who} 在群 ${key} 里戳了戳你。`
      : `手机提示：${who} 戳了戳你。`;
    this.callbacks.notify({ text }, this.cfg.wakeOnNotify);
  }

  /** 从消息记录里查某人的名字（查不到就用 id） */
  private async lookupUsername(platform: string, channelId: string, userId: string): Promise<string> {
    try {
      const channels = await this.store.knownChannels();
      for (const c of channels) {
        if (c.platform !== platform) continue;
        const hit = c.participants.find((p) => p.userId === userId && p.username);
        if (hit) return hit.username;
      }
    } catch {
      /* 查询失败退回 id */
    }
    return userId;
  }

  private handleRequestEvent(session: Session, kind: "friend" | "guild" | "member"): void {
    const req = this.requests.add({
      kind,
      platform: session.platform ?? "unknown",
      selfId: session.selfId ?? "",
      messageId: session.messageId ?? "",
      userId: session.userId ?? "",
      username: session.username ?? session.userId ?? "",
      guildId: session.guildId,
      comment: session.content?.trim() || undefined,
    });
    // 手机被放下：只感觉到震动，不呈现内容（请求仍已登记，拿起手机后可处理）
    if (this.phone.down) {
      this.callbacks.notify({ text: "放在一边的手机震了一下。" }, this.cfg.wakeOnNotify);
      return;
    }
    const who = req.username && req.username !== req.userId ? `${req.username}（${req.userId}）` : req.userId;
    const note = req.comment ? `，附言：「${req.comment}」` : "";
    const hint = `（请求编号 ${req.id}，可用 handle_request 同意或拒绝）`;
    const text =
      kind === "friend"
        ? `手机弹出提示：${req.platform} 上 ${who} 请求添加你为好友${note}。${hint}`
        : kind === "guild"
          ? `手机弹出提示：${who} 邀请你加入群 ${req.guildId}${note}。${hint}`
          : `手机弹出提示：${who} 申请加入你管理的群 ${req.guildId}${note}。${hint}`;
    this.callbacks.notify({ text }, this.cfg.wakeOnNotify);
  }

  /** Koishi send 事件：Bot 账号发出了一条消息。区分本插件发送与外部发送 */
  private async handleSelfSent(session: Session): Promise<void> {
    if (!session.channelId) return;
    const key = `${session.platform}:${session.channelId}`;
    // 本插件（messenger）发出的：已由 storeSelf 入库并有工具调用结果，跳过
    if (this.ownSends.consume(key)) return;

    const elements = session.elements ?? h.parse(session.content ?? "");
    const content = await this.serializeElements(elements, {
      containerMsgId: session.messageId ?? undefined,
      selfId: session.selfId ?? session.bot?.selfId ?? undefined,
    });
    if (!content.trim()) return;

    await this.store.store({
      platform: session.platform ?? "unknown",
      channelId: session.channelId,
      guildId: session.guildId ?? "",
      userId: session.selfId ?? "self",
      username: "（我）",
      content,
      timestamp: new Date(),
      self: true,
      messageId: session.messageId ?? "",
    });
    this.callbacks.selfMessage(key, toMarkerText(content));
  }

  private async handle(session: Session): Promise<void> {
    if (!session.content && !session.elements?.length) return;
    // 忽略机器人自己发出的回环消息（自己发送的消息在 send 工具中入库）
    if (session.userId && session.bot && session.userId === session.bot.selfId) return;

    const selfId = session.selfId ?? session.bot?.selfId ?? undefined;
    const elements = session.elements ?? h.parse(session.content ?? "");
    let content = await this.serializeElements(elements, {
      containerMsgId: session.messageId ?? undefined,
      selfId,
    });
    if (!content.trim()) return;

    // 引用回复：适配器会把被引用消息摘到 session.quote（不在 elements 里）。
    // 以标签形式前置：信息可读（谁、说了什么），且 Bot 照抄 <quote id="…"/> 即可自己引用回复。
    // 被引用的是 Bot 自己的消息时显式点破——账号昵称未必等于它的自我认知
    const quote = session.quote;
    if (quote && (quote.id || quote.content || quote.elements)) {
      const qUser = quote.user as { name?: string; nick?: string; id?: string } | undefined;
      const isSelf = !!selfId && qUser?.id != null && String(qUser.id) === String(selfId);
      content =
        quoteTag({
          id: needsMsgIds(this.ops) && quote.id ? quote.id : undefined,
          name: isSelf ? "你自己" : qUser?.nick || qUser?.name || qUser?.id || undefined,
          text: truncate(plainText(quote.elements ?? h.parse(quote.content ?? "")), 40) || undefined,
        }) + ` ${content}`;
    }

    await this.store.store({
      platform: session.platform ?? "unknown",
      channelId: session.channelId ?? "unknown",
      guildId: session.guildId ?? "",
      userId: session.userId ?? "",
      username: session.username ?? session.userId ?? "",
      content,
      timestamp: new Date(session.timestamp ?? Date.now()),
      self: false,
      messageId: session.messageId ?? "",
    });

    const key = `${session.platform}:${session.channelId}`;
    // Bot 正在关注的频道：无视通知策略与频道列表，必定呈现完整内容并唤醒
    const focused = this.focus.isFocused(key);
    if (!focused && !this.notifyList.isNotifyChannel(key)) return;

    // 手机被放下：本会通知的消息一律降级为"感觉到震动"，不呈现任何内容
    if (this.phone.down) {
      this.callbacks.notify({ text: "放在一边的手机震了一下。" }, this.cfg.wakeOnNotify);
      return;
    }

    const notification = focused
      ? await this.renderFocused(key, session, content)
      : await this.renderNotification(key, session, content);
    this.callbacks.notify(notification, focused ? true : this.cfg.wakeOnNotify);
  }

  /** 元素树 → 存储文本：媒体下载入资产库并替换为占位符 */
  private async serializeElements(
    elements: h[],
    opts: { containerMsgId?: string; selfId?: string } = {},
  ): Promise<string> {
    let out = "";
    for (const el of elements) {
      switch (el.type) {
        case "text":
          out += String(el.attrs.content ?? "");
          break;
        case "img":
        case "image": {
          out += await this.ingest(el, "image", "[图片（获取失败）]");
          break;
        }
        case "audio": {
          out += await this.ingest(el, "audio", "[语音（获取失败）]");
          break;
        }
        case "video": {
          out += await this.ingest(el, "video", "[视频（获取失败）]");
          break;
        }
        case "at":
          // 保留标签形式：Bot 照抄同样的标签发出时，messenger 会还原成真正的 at 元素。
          // @ 的是 Bot 自己时显式点破——Bot 未必认得自己的账号 id
          if (el.attrs.type === "all") out += `<at type="all"/>`;
          else if (el.attrs.id) {
            out += atTag(String(el.attrs.id), el.attrs.name ? String(el.attrs.name) : undefined);
            if (opts.selfId && String(el.attrs.id) === opts.selfId) out += "（@的是你）";
          } else out += `@${el.attrs.name ?? ""}`;
          break;
        case "face":
          // 保留标签形式：Bot 照抄即可发出同样的平台表情
          out += faceTag(String(el.attrs.id ?? ""), el.attrs.name ? String(el.attrs.name) : undefined);
          break;
        case "forward": {
          // 不展开内容：Bot 可像真人一样用 view_forward 点开查看。
          // id 优先用所在消息的 message_id——NapCat 的 get_forward_msg 只认它，
          // 内层 resid 会报"内层消息无法获取"（嵌套层由 view_forward 的内联缓存处理）
          const fid = opts.containerMsgId || (el.attrs.id ? String(el.attrs.id) : "");
          out += fid ? `<forward id="${fid.replace(/"/g, "&quot;")}"/>` : "[合并转发的聊天记录]";
          break;
        }
        case "quote": {
          // 开启需要消息编号的操作时带上被引用的消息 id，Bot 能看懂引用链并可跟进引用
          const quotedId = el.attrs.id;
          out += needsMsgIds(this.ops) && quotedId ? `[引用 msg:${quotedId}]` : "[引用了一条消息]";
          break;
        }
        default:
          if (el.children?.length) out += await this.serializeElements(el.children, opts);
          break;
      }
    }
    return out;
  }

  private async ingest(el: h, type: "image" | "audio" | "video", fallback: string): Promise<string> {
    const src = String(el.attrs.src ?? el.attrs.url ?? "");
    if (!src) return fallback;
    const mimeHint = typeof el.attrs.type === "string" && el.attrs.type.includes("/") ? el.attrs.type : undefined;
    const id = await this.media.ingest(src, type, mimeHint);
    return id !== null ? mediaPlaceholder(id, type) : fallback;
  }

  /** 关注中的频道：始终呈现完整内容（相当于强制 content 策略） */
  private async renderFocused(key: string, session: Session, content: string): Promise<RichText> {
    const rendered = await this.renderer.render(content);
    const msgTag =
      needsMsgIds(this.ops) && session.messageId ? `(msg:${session.messageId}) ` : "";
    return {
      text: `你正留意着 ${key}，看到新消息——${msgTag}${session.username ?? session.userId}说：${rendered.text}`,
      attachments: rendered.attachments,
    };
  }

  private async renderNotification(key: string, session: Session, content: string): Promise<RichText> {
    switch (this.cfg.notifyPolicy) {
      case "count":
        return { text: "手机响了一下：收到一条新消息。" };
      case "channel":
        return { text: `手机响了一下：收到来自 ${key} 的消息。` };
      case "content": {
        const rendered = await this.renderer.render(content);
        return {
          text: `手机响了一下：收到来自 ${key} 的消息，${session.username ?? session.userId}说：${rendered.text}`,
          attachments: rendered.attachments,
        };
      }
    }
  }
}

/** 标签属性转义（与 Koishi 元素语法一致） */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** at 元素的标签文本形式（Bot 可照抄发出） */
export function atTag(id: string, name?: string): string {
  return `<at id="${escAttr(id)}"${name ? ` name="${escAttr(name)}"` : ""}/>`;
}

/** face（平台表情）元素的标签文本形式（Bot 可照抄发出） */
export function faceTag(id: string, name?: string): string {
  return `<face id="${escAttr(id)}"${name ? ` name="${escAttr(name)}"` : ""}/>`;
}

/** quote（引用回复）的标签文本形式：带上被引用者与摘要，信息可读、照抄可用（出站只认 id） */
export function quoteTag(opts: { id?: string; name?: string; text?: string }): string {
  const attrs = [
    opts.id ? `id="${escAttr(opts.id)}"` : "",
    opts.name ? `name="${escAttr(opts.name)}"` : "",
    opts.text ? `text="${escAttr(opts.text)}"` : "",
  ].filter(Boolean);
  return `<quote ${attrs.join(" ")}/>`;
}

/** 元素树 → 纯文本摘要（不下载媒体，用于引用消息的内容预览） */
function plainText(elements: h[]): string {
  let out = "";
  for (const el of elements) {
    switch (el.type) {
      case "text":
        out += String(el.attrs.content ?? "");
        break;
      case "img":
      case "image":
        out += "[图片]";
        break;
      case "audio":
        out += "[语音]";
        break;
      case "video":
        out += "[视频]";
        break;
      case "at":
        out += `@${el.attrs.name ?? el.attrs.id ?? ""}`;
        break;
      case "face":
        out += "[表情]";
        break;
      default:
        if (el.children?.length) out += plainText(el.children);
        break;
    }
  }
  return out;
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? single.slice(0, max) + "…" : single;
}

const MARKER_LABEL: Record<string, string> = { image: "图片", audio: "音频", video: "视频" };

/** 媒体占位符 → Bot 的内联标记形式（[图片#12]），用于伪装 send 工具调用的 msg 参数 */
function toMarkerText(content: string): string {
  return content.replace(
    MEDIA_PLACEHOLDER,
    (_, id, type) => `[${MARKER_LABEL[type as string] ?? type}#${id}]`,
  );
}
