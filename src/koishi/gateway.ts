import { h, type Context, type Session } from "koishi";
import type { MessagingConfig } from "../config.js";
import type { MediaRenderer } from "../media/render.js";
import { mediaPlaceholder } from "../media/render.js";
import type { MediaStore } from "../media/store.js";
import type { RichText } from "../types.js";
import type { FocusManager } from "./focus.js";
import type { MessageStore } from "./messages.js";

export interface GatewayCallbacks {
  /** 向 Bot-LLM 投递通知事件；wake 表示是否唤醒 wait() 中的 Bot */
  notify(content: RichText, wake: boolean): void;
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
    private store: MessageStore,
    private media: MediaStore,
    private renderer: MediaRenderer,
    private focus: FocusManager,
    private callbacks: GatewayCallbacks,
  ) {
    ctx.middleware(async (session, next) => {
      try {
        await this.handle(session);
      } catch (err) {
        ctx.logger("yesimbot-world").warn("消息处理失败: %s", err);
      }
      return next();
    });
  }

  private async handle(session: Session): Promise<void> {
    if (!session.content && !session.elements?.length) return;
    // 忽略机器人自己发出的回环消息（自己发送的消息在 send 工具中入库）
    if (session.userId && session.bot && session.userId === session.bot.selfId) return;

    const elements = session.elements ?? h.parse(session.content ?? "");
    const content = await this.serializeElements(elements);
    if (!content.trim()) return;

    await this.store.store({
      platform: session.platform ?? "unknown",
      channelId: session.channelId ?? "unknown",
      guildId: session.guildId ?? "",
      userId: session.userId ?? "",
      username: session.username ?? session.userId ?? "",
      content,
      timestamp: new Date(session.timestamp ?? Date.now()),
      self: false,
    });

    const key = `${session.platform}:${session.channelId}`;
    // Bot 正在关注的频道：无视通知策略与频道列表，必定呈现完整内容并唤醒
    const focused = this.focus.isFocused(key);
    if (!focused && !this.isNotifyChannel(key)) return;

    const notification = focused
      ? await this.renderFocused(key, session, content)
      : await this.renderNotification(key, session, content);
    this.callbacks.notify(notification, focused ? true : this.cfg.wakeOnNotify);
  }

  /** 元素树 → 存储文本：媒体下载入资产库并替换为占位符 */
  private async serializeElements(elements: h[]): Promise<string> {
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
          out += `@${el.attrs.name ?? el.attrs.id ?? ""}`;
          break;
        case "face":
          out += `[表情:${el.attrs.name ?? el.attrs.id ?? ""}]`;
          break;
        case "quote":
          out += "[引用了一条消息]";
          break;
        default:
          if (el.children?.length) out += await this.serializeElements(el.children);
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

  private isNotifyChannel(key: string): boolean {
    return this.cfg.notifyChannels.includes("*") || this.cfg.notifyChannels.includes(key);
  }

  /** 关注中的频道：始终呈现完整内容（相当于强制 content 策略） */
  private async renderFocused(key: string, session: Session, content: string): Promise<RichText> {
    const rendered = await this.renderer.render(content);
    return {
      text: `你正留意着 ${key}，看到新消息——${session.username ?? session.userId}说：${rendered.text}`,
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
