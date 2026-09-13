import { h, type Context, type Session } from "koishi";
import { channelKey } from "./channels.js";
import { needsMsgIds, type MessagingConfig, type PlatformOpsConfig } from "../config.js";
import type { MediaRenderer } from "../media/render.js";
import { MEDIA_PLACEHOLDER, mediaPlaceholder, escapeMediaStorageText } from "../media/render.js";
import type { MediaStore } from "../media/store.js";
import type { PhoneStatus, RichText } from "../types.js";
import type { FocusManager } from "./focus.js";
import { recallNoticeText } from "./markers.js";
import type { MessageStore } from "./messages.js";
import type { ChannelNameResolver } from "./names.js";
import type { NotifyManager } from "./notify.js";
import type { OwnSendTracker } from "./ownsends.js";
import { SelfMessageCapture, type ConfirmedSelfMessage } from "./self-message-capture.js";
import type { RequestStore } from "./requests.js";
import { conversationKind, conversationLabel, describeConversation, isStickerElement, type ConversationContext } from "./conversation.js";
export { isStickerElement } from "./conversation.js";

export interface GatewayCallbacks {
  /** 向 Bot-LLM 投递通知事件；wake 表示是否唤醒 wait() 中的 Bot */
  notify(content: RichText, wake: boolean): void;
  /** 外部（其他插件/指令输出）以 Bot 账号发出的消息（externalSelfMessages 开启时）；msgId 为平台消息 id（可能为空） */
  selfMessage(channelKey: string, content: RichText, msgId: string, sendArgs: { msg: string } | null): void | Promise<void>;
  /** 任意频道收到了新消息（不管是否聚焦/通知）。用于打断"过会儿再发"的延期发送意图 */
  channelActivity(channelKey: string): void;
}

/**
 * Koishi 消息网关：
 * - 所有收到的消息一律入库（图片/音频/视频下载进资产库，存占位符）；
 * - 来自 Bot 正在关注的频道的消息，无视通知策略，必定以完整内容呈现并唤醒 Bot；
 * - 来自 Allow Notification 频道列表的消息，按处理策略生成 Event 投递给 Bot-LLM。
 */
export class Gateway {
  private selfCapture?: SelfMessageCapture;
  private messageTails = new Map<string, Promise<void>>();
  private ownMessageIds = new Set<string>();

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
    private names: ChannelNameResolver,
    /** 世界时钟的惰性访问器（Gateway 先于时钟创建；世界未就绪时为 null） */
    private clockInfo: () => { syncRealTime: boolean; unitRealSeconds: number } | null,
    private callbacks: GatewayCallbacks,
  ) {
    const logger = ctx.logger("yesimbot-world");
    // 用 message 事件而非中间件：保证他人的指令消息（会被指令系统处理）也一样被当作普通消息
    // 入库并按通知策略投递（指令照常执行，互不影响）
    ctx.on("message", (session) => {
      const key = channelKey(session.platform ?? "unknown", session.channelId ?? "unknown", session.selfId ?? session.bot?.selfId);
      // Reserve the same queue position used by confirmed account replies before any
      // media work starts. Never return the queued promise to platform dispatch.
      const next = this.queueMessage(key, () => this.handle(session));
      void next.catch((err) => {
        logger.warn("消息处理失败: %s", err);
      });
    });

    if (cfg.externalSelfMessages !== "off") {
      this.selfCapture = new SelfMessageCapture(ctx, ownSends, (message) => {
        const key = channelKey(message.bot.platform ?? "unknown", message.channelId, message.bot.selfId);
        if (message.own) {
          this.ownMessageIds.add(`${key}\0${message.messageId}`);
          if (this.ownMessageIds.size > 4096) this.ownMessageIds.delete(this.ownMessageIds.values().next().value!);
          return;
        }
        void this.queueMessage(key, () => this.handleConfirmedSelfSent(message)).catch((err) => {
          logger.warn("已确认外发消息入库失败: %s", err);
        });
      });
      // Some adapters dispatch account echoes as send; others use message with the
      // account's own userId. Both enter the same confirmed-ID deduplication path.
      ctx.on("send", (session) => {
        const key = channelKey(session.platform ?? "unknown", session.channelId ?? "unknown", session.selfId ?? session.bot?.selfId);
        void this.queueMessage(key, () => this.handleSelfEcho(session)).catch((err) => logger.warn("账号回声处理失败: %s", err));
      });
    }

    // 平台请求事件（好友申请 / 入群邀请 / 入群申请）：登记后以手机通知的形式告知 Bot
    if (ops.handleRequests) {
      ctx.on("friend-request", (session) => void this.handleRequestEvent(session, "friend"));
      ctx.on("guild-request", (session) => void this.handleRequestEvent(session, "guild"));
      ctx.on("guild-member-request", (session) => void this.handleRequestEvent(session, "member"));
    }

    // 戳一戳：OneBot 的 notify/poke 是 notice 而非 message，不会走 message 事件。
    // NapCat 系适配器把这类 notice 以 internal/session 派发（type: "notice", subtype: "poke"）。
    // 禁言（group_ban）同理：适配器把它映射为 guild-member 会话，也从 internal/session 感知
    ctx.on("internal/session" as never, ((session: Session) => {
      void this.handlePoke(session).catch((err) => {
        logger.warn("戳一戳处理失败: %s", err);
      });
      void this.handleGroupBan(session).catch((err) => {
        logger.warn("禁言通知处理失败: %s", err);
      });
    }) as never);

    // 撤回：message-deleted 是 satori 标准事件（OneBot 的 group_recall / friend_recall
    // 都会映射到这里）。别人撤回消息后，消息记录里对应的那条会被改写为"撤回了一条消息"，
    // 否则消息已经缓存在记录里，Bot 会一直"看到"一条其实已经不存在了的消息
    ctx.on("message-deleted", (session) => {
      const key = channelKey(session.platform ?? "unknown", session.channelId ?? "unknown", session.selfId ?? session.bot?.selfId);
      void this.queueMessage(key, () => this.handleRecall(session)).catch((err) => {
        logger.warn("撤回处理失败: %s", err);
      });
    });
  }

  /**
   * 撤回感知：把消息记录里被撤回的那条改写为撤回标记（上下文不动——Bot 已经看过的
   * 消息它自然记得内容，无需篡改历史）；Bot 正在关注该频道时追加事件告知是哪条被撤回了。
   * 账号自身的撤回也可能来自其他设备；没有操作归属证据时只陈述账号行为。
   */
  private async handleRecall(session: Session): Promise<void> {
    const channelId = session.channelId ?? "";
    const messageId = session.messageId ? String(session.messageId) : "";
    if (!channelId || !messageId) return;
    const platform = session.platform ?? "unknown";
    const key = channelKey(platform, channelId, session.selfId ?? session.bot?.selfId);
    const selfId = String(session.selfId ?? session.bot?.selfId ?? "");
    const row = await this.store.findByMessageId(platform, channelId, messageId, selfId);
    // Group user_id identifies the original author, not necessarily the operator.
    // Missing operator metadata must not turn an admin recall into a self action.
    const senderId = String(session.userId ?? row?.userId ?? "");
    const raw = ((session as unknown as { onebot?: Record<string, unknown> }).onebot ??
      (session.event as unknown as { _data?: Record<string, unknown> })?._data ?? {}) as Record<string, unknown>;
    const operatorId = String((session as unknown as { operatorId?: string }).operatorId ?? raw.operator_id ?? "") ||
      (session.isDirect || channelId.startsWith("private:") ? senderId : "");
    const selfOp = !!selfId && operatorId === selfId;
    const selfSender = !!selfId && senderId === selfId;
    const samePerson = !!operatorId && operatorId === senderId;
    const operatorName = selfOp ? "你的账号" : await this.lookupUsername(platform, channelId, operatorId);
    const senderName = selfSender
      ? "你"
      : (row?.username || (await this.lookupUsername(platform, channelId, senderId)));
    const notice = !operatorId ? `${selfSender ? "本账号" : senderName || "未知发送者"}的一条消息被撤回了`
      : selfOp
      ? selfSender ? "你的账号撤回了一条消息" : `你的账号撤回了 ${senderName} 的一条消息`
      : recallNoticeText({ operatorName, selfOp, senderName, selfSender, samePerson });

    if (row) {
      await this.store.updateContent(row.id, `[${notice}]`);
    } else {
      // 记录里找不到原消息（发出时插件不在线 / 记录被清空过）：撤回本身也是频道里的动态，补记一条
      await this.store.store({
        selfId: session.selfId ?? session.bot?.selfId ?? "",
        platform,
        channelId,
        guildId: session.guildId ?? "",
        userId: operatorId,
        username: selfOp ? "（我）" : operatorName,
        content: `[${notice}]`,
        timestamp: new Date(),
        self: selfOp,
        messageId,
        isDirect: session.isDirect,
      });
    }

    // The account's operator ID alone is not proof of a known, voluntary action.
    // 只有正在关注这个频道时才追加事件（翻记录时总能看到撤回标记，不必每条都提醒）
    if (this.phone.down || !this.focus.isFocused(key)) return;
    const msgTag = needsMsgIds(this.ops) ? `（msg:${messageId}）` : "";
    this.callbacks.notify(
      { text: `你正留意着 ${await this.names.display(key)}，看到${notice}${msgTag}。` },
      true,
    );
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
    const key = channelKey(platform, channelId, session.selfId ?? session.bot?.selfId);
    const who = await this.lookupUsername(platform, channelId, pokerId);

    // 入库：打开频道时能看到这条互动
    await this.store.store({
      selfId: session.selfId ?? session.bot?.selfId ?? "",
      platform,
      channelId,
      guildId: groupId,
      userId: pokerId,
      username: who,
      content: "[戳了戳你]",
      timestamp: new Date(),
      self: false,
      messageId: "",
      isDirect: !groupId,
    });

    if (this.phone.down) {
      this.callbacks.notify({ text: "放在一边的手机震了一下。" }, this.cfg.wakeOnNotify);
      return;
    }
    const text = groupId
      ? `手机提示：${who} 在群 ${await this.names.display(key)} 里戳了戳你。`
      : `手机提示：${who} 戳了戳你。`;
    this.callbacks.notify({ text }, this.cfg.wakeOnNotify);
  }

  /**
   * 禁言感知：自己被禁言/解除禁言、全员禁言开关（OneBot notice: group_ban）。
   * 适配器把它映射为 type="guild-member"（ban 与 lift_ban 的 subtype 都被归为 "ban"），
   * 因此从原始 payload 判断类型与对象；别人被禁言不理会。
   */
  private async handleGroupBan(session: Session): Promise<void> {
    const raw = ((session as unknown as { onebot?: Record<string, unknown> }).onebot ??
      (session.event as unknown as { _data?: Record<string, unknown> })?._data ??
      {}) as Record<string, unknown>;
    if (String(raw.notice_type ?? "") !== "group_ban") return;

    const selfId = String(session.selfId ?? session.bot?.selfId ?? "");
    const targetId = String(raw.user_id ?? "");
    const whole = !targetId || targetId === "0"; // user_id=0 表示全员禁言开关
    if (!selfId || (!whole && targetId !== selfId)) return;

    const platform = session.platform ?? "onebot";
    const groupId = String(raw.group_id ?? session.guildId ?? "");
    if (!groupId) return;
    const key = channelKey(platform, groupId, session.selfId ?? session.bot?.selfId);
    const lift = String(raw.sub_type ?? "") === "lift_ban" || Number(raw.duration ?? 0) <= 0;
    const operatorId = String(raw.operator_id ?? "");
    const who = operatorId ? await this.lookupUsername(platform, groupId, operatorId) : "管理员";
    const dur = formatBanDuration(Number(raw.duration ?? 0), this.clockInfo());

    // 入库：翻聊天记录时也能看到这条动态
    await this.store.store({
      selfId: session.selfId ?? session.bot?.selfId ?? "",
      platform,
      channelId: groupId,
      guildId: groupId,
      userId: operatorId,
      username: who,
      content: whole
        ? lift
          ? `[${who} 关闭了全员禁言]`
          : `[${who} 开启了全员禁言]`
        : lift
          ? `[${who} 解除了对你的禁言]`
          : `[${who} 禁言了你${dur ? `（${dur}）` : ""}]`,
      timestamp: new Date(),
      self: false,
      messageId: "",
      isDirect: false,
    });

    if (this.phone.down) {
      this.callbacks.notify({ text: "放在一边的手机震了一下。" }, this.cfg.wakeOnNotify);
      return;
    }
    const display = await this.names.display(key);
    const text = whole
      ? lift
        ? `手机提示：群 ${display} 的全员禁言解除了，可以说话了。`
        : `手机提示：${who} 在群 ${display} 开启了全员禁言，你暂时没法在这个群里发消息。`
      : lift
        ? `手机提示：你在群 ${display} 的禁言被${who}解除了，可以说话了。`
        : `手机提示：你在群 ${display} 被${who}禁言了${dur ? `（${dur}）` : ""}，期间没法在这个群里发消息。`;
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

  private async handleRequestEvent(session: Session, kind: "friend" | "guild" | "member"): Promise<void> {
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
    const guild = req.guildId ? await this.names.display(channelKey(req.platform, req.guildId, req.selfId)) : req.guildId;
    const text =
      kind === "friend"
        ? `手机弹出提示：${req.platform} 上 ${who} 请求添加你为好友${note}。${hint}`
        : kind === "guild"
          ? `手机弹出提示：${who} 邀请你加入群 ${guild}${note}。${hint}`
          : `手机弹出提示：${who} 申请加入你管理的群 ${guild}${note}。${hint}`;
    this.callbacks.notify({ text }, this.cfg.wakeOnNotify);
  }

  private queueMessage(key: string, run: () => Promise<void>): Promise<void> {
    const previous = this.messageTails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.messageTails.set(key, next);
    void next.finally(() => { if (this.messageTails.get(key) === next) this.messageTails.delete(key); }).catch(() => {});
    return next;
  }

  /** Called only for successful adapter receipts, never an attempted before-send. */
  private async handleConfirmedSelfSent(message: ConfirmedSelfMessage): Promise<void> {
    const { bot, channelId, messageId, session } = message;
    const platform = bot.platform ?? "unknown";
    const key = channelKey(platform, channelId, bot.selfId);
    if (messageId && await this.store.findByMessageId(platform, channelId, messageId, bot.selfId)) return;
    // Outgoing tool arguments must not include incoming-only annotations such as
    // “@的是你”, which were never part of the platform message actually sent.
    const content = await this.serializeElements(message.elements, { containerMsgId: messageId });
    if (!content.trim()) return;
    const direct = session?.event?.channel?.type == null ? undefined : session.isDirect;
    await this.store.store({
      selfId: bot.selfId, platform, channelId, guildId: session?.guildId ?? "",
      userId: bot.selfId, username: "（我）", content, timestamp: new Date(message.timestamp), self: true, messageId,
      isDirect: direct ?? channelId.startsWith("private:"),
      conversation: describeConversation(message.elements,
        conversationKind(direct, channelId, session?.guildId), isStickerElement),
    });
    // Store all enabled modes, but expand media only when that mode actually exposes
    // the message. A put-down phone event must never smuggle images into awareness.
    const visible = this.cfg.externalSelfMessages === "simulate" || (this.cfg.externalSelfMessages === "event" && !this.phone.down);
    const rendered = visible ? await this.renderer.render(content) : { text: "" };
    await this.callbacks.selfMessage(key, rendered, messageId, selfSendArguments(message.elements, content));
  }

  /** Already-observed platform traffic, including another client logged into this account. */
  private async handleSelfEcho(session: Session): Promise<void> {
    if (this.cfg.externalSelfMessages === "off" || !session.channelId || !session.bot) return;
    const key = channelKey(session.platform ?? session.bot.platform, session.channelId, session.selfId ?? session.bot.selfId);
    await this.selfCapture?.waitForPending(key);
    await this.ownSends.waitForPending(key);
    const messageId = session.messageId ? String(session.messageId) : "";
    if (messageId && (this.ownMessageIds.has(`${key}\0${messageId}`) || this.ownSends.wasSent(key, messageId))) return;
    // Already running in the channel queue: enqueuing again here would await itself.
    // Sending does not await this consumer, so waiting for adapter receipts above
    // cannot create a transport -> consumer -> transport cycle.
    await this.handleConfirmedSelfSent({ bot: session.bot, channelId: session.channelId, messageId,
      elements: session.elements ?? h.parse(session.content ?? ""), session, own: false, timestamp: session.timestamp ?? Date.now() });
  }

  private async handle(session: Session): Promise<void> {
    if (!session.content && !session.elements?.length) return;
    if (session.userId && session.bot && String(session.userId) === String(session.bot.selfId)) {
      await this.handleSelfEcho(session);
      return;
    }

    const selfId = session.selfId ?? session.bot?.selfId ?? undefined;
    if (session.messageId && session.channelId && await this.store.findByMessageId(
      session.platform ?? "unknown", session.channelId, String(session.messageId), selfId,
    )) return;
    const elements = session.elements ?? h.parse(session.content ?? "");
    let content = await this.serializeElements(elements, {
      containerMsgId: session.messageId ?? undefined,
      selfId,
    });
    if (!content.trim()) return;

    const conversation = describeConversation(elements,
      conversationKind(session.isDirect, session.channelId, session.guildId), isStickerElement,
      session.quote ? {
        ...(session.quote.id ? { messageId: String(session.quote.id) } : {}),
        ...(session.quote.user?.id != null ? { userId: String(session.quote.user.id) } : {}),
      } : undefined);
    // Some adapters expose only a quoted message id. Resolve it locally and within this account/channel;
    // a missing author is unknown, never evidence that the reply is addressed to the Bot.
    if (conversation.reply?.messageId && !conversation.reply.userId) {
      const original = await this.store.findByMessageId(session.platform ?? "unknown", session.channelId ?? "unknown", conversation.reply.messageId, selfId);
      if (original?.userId) conversation.reply.userId = original.userId;
    }

    // 引用回复：适配器会把被引用消息摘到 session.quote（不在 elements 里）。
    // 以标签形式前置：信息可读（谁、说了什么），且 Bot 照抄 <quote id="…"/> 即可自己引用回复。
    // 被引用的是 Bot 自己的消息时显式点破——账号昵称未必等于它的自我认知
    const quote = session.quote;
    if (quote && (quote.id || quote.content || quote.elements)) {
      const qUser = quote.user as { name?: string; nick?: string; id?: string } | undefined;
      const quoteUserId = conversation.reply?.userId;
      const isSelf = !!selfId && quoteUserId === String(selfId);
      content =
        quoteTag({
          id: needsMsgIds(this.ops) && quote.id ? quote.id : undefined,
          name: isSelf ? "本账号" : qUser?.nick || qUser?.name || quoteUserId || undefined,
          text: truncate(plainText(quote.elements ?? h.parse(quote.content ?? "")), 40) || undefined,
        }) + ` ${content}`;
    }

    await this.store.store({
      selfId: session.selfId ?? session.bot?.selfId ?? "",
      platform: session.platform ?? "unknown",
      channelId: session.channelId ?? "unknown",
      guildId: session.guildId ?? "",
      userId: session.userId ?? "",
      username: session.username ?? session.userId ?? "",
      content,
      timestamp: new Date(session.timestamp ?? Date.now()),
      self: false,
      messageId: session.messageId ?? "",
      isDirect: session.isDirect,
      conversation,
    });

    const key = channelKey(session.platform ?? "unknown", session.channelId ?? "unknown", session.selfId ?? session.bot?.selfId);
    // 频道有新动静：先让系统侧（延期发送意图等）知情，再走通知策略
    this.callbacks.channelActivity(key);
    // Bot 正在关注的频道：无视通知策略与频道列表，必定呈现完整内容并唤醒
    const focused = this.focus.isFocused(key);
    if (!focused && !this.notifyList.isNotifyChannel(key)) return;

    // 手机被放下：本会通知的消息一律降级为"感觉到震动"，不呈现任何内容
    if (this.phone.down) {
      this.callbacks.notify({ text: "放在一边的手机震了一下。" }, this.cfg.wakeOnNotify);
      return;
    }

    const notification = focused
      ? await this.renderFocused(key, session, content, conversation)
      : await this.renderNotification(key, session, content, conversation);
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
          out += escapeMediaStorageText(String(el.attrs.content ?? ""));
          break;
        case "img":
        case "image":
        case "mface":
        case "sticker": {
          out += await this.ingest(el, "image", "[图片（获取失败）]", isStickerElement(el));
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

  private async ingest(
    el: h,
    type: "image" | "audio" | "video",
    fallback: string,
    sticker = false,
  ): Promise<string> {
    const src = String(el.attrs.src ?? el.attrs.url ?? "");
    if (!src) return fallback;
    const mimeHint = typeof el.attrs.type === "string" && el.attrs.type.includes("/") ? el.attrs.type : undefined;
    const id = await this.media.ingest(src, type, mimeHint, undefined, sticker);
    return id !== null ? mediaPlaceholder(id, type, type === "image" ? sticker : undefined) : fallback;
  }

  /** 关注中的频道：始终呈现完整内容（相当于强制 content 策略） */
  private async renderFocused(key: string, session: Session, content: string, conversation: ConversationContext): Promise<RichText> {
    const rendered = await this.renderer.render(content);
    const msgTag =
      needsMsgIds(this.ops) && session.messageId ? `(msg:${session.messageId}) ` : "";
    const header = `你正留意着 ${await this.names.display(key)}，看到新消息（${conversationLabel(conversation, session.selfId ?? session.bot?.selfId)}）\n${msgTag}发送者：${session.username ?? session.userId}（账号 ${JSON.stringify(session.userId ?? "未知")}）\n消息正文：\n`;
    return prefixRichText(header, rendered, "\n〔该条消息结束〕");
  }

  private async renderNotification(key: string, session: Session, content: string, conversation: ConversationContext): Promise<RichText> {
    switch (this.cfg.notifyPolicy) {
      case "count":
        return { text: "手机响了一下：收到一条新消息。" };
      case "channel":
        return { text: `手机响了一下：收到来自 ${await this.names.display(key)} 的消息。` };
      case "content": {
        const rendered = await this.renderer.render(content);
        const msgTag = needsMsgIds(this.ops) && session.messageId ? `(msg:${session.messageId}) ` : "";
        const header = `手机响了一下：收到来自 ${await this.names.display(key)} 的消息（${conversationLabel(conversation, session.selfId ?? session.bot?.selfId)}）\n${msgTag}发送者：${session.username ?? session.userId}（账号 ${JSON.stringify(session.userId ?? "未知")}）\n消息正文：\n`;
        return prefixRichText(header, rendered, "\n〔该条消息结束〕");
      }
    }
  }
}

/** Both representations must retain sender/channel identity when BotContext uses ordered media parts. */
export function prefixRichText(prefix: string, rendered: RichText, suffix = ""): RichText {
  return {
    ...rendered,
    text: prefix + rendered.text + suffix,
    parts: rendered.parts ? [{ kind: "text", text: prefix }, ...rendered.parts, ...(suffix ? [{ kind: "text" as const, text: suffix }] : [])] : undefined,
  };
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
      case "mface":
      case "sticker":
        out += isStickerElement(el) ? "[表情包]" : "[图片]";
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

/**
 * 禁言时长（平台给的现实秒）→ Bot 视角的时长文本：
 * - 现实历法（世界时间与现实同步）：用人类单位（"30 分钟"、"1 天 12 小时"）；
 * - 独立时间线的世界：现实秒按流速换算成 TU（Bot 的计时单位，自定义历法下
 *   "分钟/小时"未必存在）。时钟未就绪时退回人类单位。
 */
export function formatBanDuration(
  seconds: number,
  clock: { syncRealTime: boolean; unitRealSeconds: number } | null,
): string {
  if (seconds <= 0) return "";
  if (clock && !clock.syncRealTime) {
    const tu = seconds / clock.unitRealSeconds;
    const text = Number.isInteger(tu) ? String(tu) : tu.toFixed(1);
    return `${text} TU`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m) parts.push(`${m} 分钟`);
  return parts.join(" ") || `${seconds} 秒`;
}

/** A simulated send must use its actual supported media references, not observation
 * summaries or persisted media tags. Other message kinds remain account-action events. */
function selfSendArguments(elements: h[], content: string): { msg: string } | null {
  const supported = new Set(["text", "img", "image", "mface", "sticker", "video", "at", "face"]);
  if (elements.some(element => !supported.has(element.type))) return null;
  const mediaCount = elements.filter(element => ["img", "image", "mface", "sticker", "video"].includes(element.type)).length;
  const references = [...content.matchAll(MEDIA_PLACEHOLDER)];
  if (references.some(match => match[2] === "audio") || references.length !== mediaCount) return null;
  const msg = content.replace(
    MEDIA_PLACEHOLDER,
    (_, id) => `<media ref="media:${id}"/>`,
  );
  return { msg };
}
