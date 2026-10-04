import { h, type Context, type Session } from "koishi";
import { channelKey } from "./channels.js";
import { quoteTag } from "./quotes.js";
export { quoteTag } from "./quotes.js";
import { needsMsgIds, type MessagingConfig, type PlatformOpsConfig } from "../config.js";
import type { MediaRenderer } from "../media/render.js";
import { MEDIA_PLACEHOLDER, mediaPlaceholder, escapeMediaStorageText } from "../media/render.js";
import type { MediaStore } from "../media/store.js";
import type { PhoneStatus, RichText } from "../types.js";
import type { FocusManager } from "./focus.js";
import type { MessageOrderTicket, MessageStore, WorldMessageRow } from "./messages.js";
import type { ChannelNameResolver } from "./names.js";
import type { NotifyManager } from "./notify.js";
import type { OwnSendTracker } from "./ownsends.js";
import { SelfMessageCapture, type ConfirmedSelfMessage } from "./self-message-capture.js";
import type { RequestStore } from "./requests.js";
import { anonymousChatNoticeEvidence, chatMessageEvidence, conversationKind, conversationLabel, describeConversation, isStickerElement, type ConversationContext } from "./conversation.js";
import { messageSequence } from "./message-order.js";
import { firstName, formatMessageSender, isLegacySenderPlaceholder, sessionSenderName } from "./identity.js";
import { sessionGroupMemberMetadata } from "./group-metadata.js";
import { canUsePhone, canPerceivePhone } from "../phone-state.js";
export { isStickerElement } from "./conversation.js";

export interface GatewayCallbacks {
  /** Explicitly sleeping/unconscious characters cannot read a screen; this never decides when they wake. */
  canViewScreen?(): boolean;
  /** 向 Bot-LLM 投递通知事件；wake 表示是否唤醒 wait() 中的 Bot */
  notify(content: RichText, wake: boolean): boolean | void;
  /** 外部（其他插件/指令输出）以 Bot 账号发出的消息（externalSelfMessages 开启时）；msgId 为平台消息 id（可能为空） */
  selfMessage(channelKey: string, content: RichText, msgId: string, sendArgs: { msg: string } | null, sender?: WorldMessageRow): void | Promise<void>;
  /** 任意频道收到了新消息（不管是否聚焦/通知）。用于打断"过会儿再发"的延期发送意图 */
  channelActivity(channelKey: string): void;
}

/**
 * Koishi 消息网关：
 * - 所有收到的消息一律入库（图片/音频/视频下载进资产库，存占位符）；
 * - 来自 Bot 正在关注的频道的消息以完整内容呈现；免打扰独立约束主动唤醒；
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
      const ticket = this.captureSessionTicket(session);
      const notifyOnArrival = this.notificationAllowed(key);
      const next = this.queueMessage(key, () => this.handle(session, ticket, notifyOnArrival));
      void next.catch((err) => {
        logger.warn("消息处理失败: %s", err);
      });
    });

    if (cfg.externalSelfMessages !== "off") {
      this.selfCapture = new SelfMessageCapture(ctx, ownSends, (message) => {
        const key = channelKey(message.bot.platform ?? "unknown", message.channelId, message.bot.selfId);
        const ticket = this.store.captureReceipt(message.bot.platform ?? "unknown", message.channelId, message.bot.selfId, message.messageId, new Date(message.timestamp));
        if (message.own) {
          this.ownMessageIds.add(`${key}\0${message.messageId}`);
          if (this.ownMessageIds.size > 4096) this.ownMessageIds.delete(this.ownMessageIds.values().next().value!);
          return;
        }
        void this.queueMessage(key, () => this.handleConfirmedSelfSent(message, ticket)).catch((err) => {
          logger.warn("已确认外发消息入库失败: %s", err);
        });
      });
    }
    // Keep the order of validated account echoes even when external message
    // simulation/storage is off. This ticket does not claim autonomous authorship.
    ctx.on("send", (session) => {
      const key = channelKey(session.platform ?? "unknown", session.channelId ?? "unknown", session.selfId ?? session.bot?.selfId);
      const ticket = this.captureSessionTicket(session);
      if (cfg.externalSelfMessages === "off") return;
      void this.queueMessage(key, () => this.handleSelfEcho(session, ticket)).catch((err) => logger.warn("账号回声处理失败: %s", err));
    });

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
      const ticket = this.store.captureLive();
      void this.queueMessage(key, () => this.handleRecall(session, ticket)).catch((err) => {
        logger.warn("撤回处理失败: %s", err);
      });
    });
  }

  /**
   * 撤回感知：把消息记录里被撤回的那条改写为撤回标记（上下文不动——Bot 已经看过的
   * 消息它自然记得内容，无需篡改历史）；Bot 正在关注该频道时追加事件告知是哪条被撤回了。
   * 账号自身的撤回也可能来自其他设备；没有操作归属证据时只陈述账号行为。
   */
  private async handleRecall(session: Session, ticket = this.store.captureLive()): Promise<void> {
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
    const samePerson = !!operatorId && operatorId === senderId;
    const identity = await this.names.identity(key, { isDirect: session.isDirect, guildId: session.guildId });
    const operatorNickname = selfOp ? identity.displayName : await this.lookupUsername(platform, channelId, operatorId, selfId);
    const operatorName = formatMessageSender({ platform, selfId, userId: operatorId, username: operatorNickname }, identity);
    const senderName = formatMessageSender({ platform, selfId, userId: senderId, username: row?.username || await this.lookupUsername(platform, channelId, senderId, selfId), senderOrigin: row?.senderOrigin }, identity);
    const notice = !operatorId ? `${senderName}的一条消息被撤回了`
      : samePerson ? `${operatorName}撤回了该账号的一条消息` : `${operatorName}撤回了 ${senderName} 的一条消息`;

    let saved = row;
    if (row) {
      await this.store.updateContent(row.id, `[${notice}]`);
    } else {
      // 记录里找不到原消息（发出时插件不在线 / 记录被清空过）：撤回本身也是频道里的动态，补记一条
      saved = await this.store.store({
        selfId: session.selfId ?? session.bot?.selfId ?? "",
        platform,
        channelId,
        guildId: session.guildId ?? "",
        userId: operatorId,
        username: operatorNickname,
        content: `[${notice}]`,
        timestamp: ticket.observedAt,
        timestampSource: "local-observed",
        self: selfOp,
        messageId,
        isDirect: session.isDirect,
      }, ticket);
    }

    const msgTag = needsMsgIds(this.ops) ? `（msg:${messageId}）` : "";
    if (saved) await this.notifyList.updatePreview?.(key, { ...saved, content: `[${notice}]` });
    await this.deliverChannelNotice(key, async () => ({ text: `你正留意着 ${await this.names.display(key)}，看到${notice}${msgTag}。` }),
      saved ? chatMessageEvidence(saved) : {}, ticket, true, saved ?? undefined);
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
    const ticket = this.store.captureLive();
    const notifyOnArrival = this.notificationAllowed(key);
    const who = await this.lookupUsername(platform, channelId, pokerId, selfId);

    // 入库：打开频道时能看到这条互动
    const saved = await this.store.store({
      selfId: session.selfId ?? session.bot?.selfId ?? "",
      platform,
      channelId,
      guildId: groupId,
      userId: pokerId,
      username: who,
      content: "[戳了戳你]",
      timestamp: ticket.observedAt,
      timestampSource: "local-observed",
      self: false,
      messageId: "",
      isDirect: !groupId,
    }, ticket);

    await this.notifyList.receive?.(key, saved, notifyOnArrival);
    await this.deliverChannelNotice(key, async () => ({ text: groupId
      ? `手机提示：${who} 在群 ${await this.names.display(key)} 里戳了戳你。`
      : `手机提示：${who} 戳了戳你。` }), chatMessageEvidence(saved), ticket, false, saved, notifyOnArrival);
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
    const ticket = this.store.captureLive();
    const notifyOnArrival = this.notificationAllowed(key);
    const who = operatorId ? await this.lookupUsername(platform, groupId, operatorId, selfId) : "管理员";
    const dur = formatBanDuration(Number(raw.duration ?? 0), this.clockInfo());

    // 入库：翻聊天记录时也能看到这条动态
    const saved = await this.store.store({
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
      timestamp: ticket.observedAt,
      timestampSource: "local-observed",
      self: false,
      messageId: "",
      isDirect: false,
    }, ticket);

    await this.notifyList.receive?.(key, saved, notifyOnArrival);
    await this.deliverChannelNotice(key, async () => {
    const display = await this.names.display(key);
    const text = whole
      ? lift
        ? `手机提示：群 ${display} 的全员禁言解除了，可以说话了。`
        : `手机提示：${who} 在群 ${display} 开启了全员禁言，你暂时没法在这个群里发消息。`
      : lift
        ? `手机提示：你在群 ${display} 的禁言被${who}解除了，可以说话了。`
        : `手机提示：你在群 ${display} 被${who}禁言了${dur ? `（${dur}）` : ""}，期间没法在这个群里发消息。`;
    return { text };
    }, chatMessageEvidence(saved), ticket, false, saved, notifyOnArrival);
  }

  /** Notification permission and screen visibility are independent, rechecked
   * after names/media await. A hidden screen never carries channel/subject facts. */
  private async deliverChannelNotice(key: string, render: () => Promise<RichText>, evidence: Pick<RichText, "originEventIds" | "experience">,
    ticket: MessageOrderTicket, focusedOnly = false, row?: WorldMessageRow, notifyOnArrival = this.notificationAllowed(key)): Promise<void> {
    const visible = () => this.canReadScreen() && this.focus.isFocused(key);
    if (focusedOnly && !visible()) return;
    if (!visible() && (!notifyOnArrival || !this.notificationAllowed(key))) return;
    if (!this.canReadScreen()) {
      if (notifyOnArrival) this.deliverVibration(evidence, ticket.observedAt.getTime(), key);
      return;
    }
    const content = await render();
    if (focusedOnly && !visible()) return;
    if (!visible() && (!notifyOnArrival || !this.notificationAllowed(key))) return;
    if (!this.canReadScreen()) {
      if (notifyOnArrival) this.deliverVibration(evidence, ticket.observedAt.getTime(), key);
      return;
    }
    const accepted = this.callbacks.notify({ ...content, ...evidence, experience: { ...evidence.experience, agency: "observed", chat: { channelKey: key, kind: "notice" } } },
      notifyOnArrival && this.shouldWake(key, visible()));
    if (accepted !== false && row) await this.notifyList.markSeen?.(key, [row]);
  }

  private canReadScreen(): boolean {
    return canUsePhone(this.phone) && this.callbacks.canViewScreen?.() !== false;
  }

  private notificationAllowed(key: string): boolean {
    return this.notifyList.allowsNotification?.(key) ?? (this.chatNotificationsAllowed() && this.notifyList.isNotifyChannel(key));
  }
  private shouldWake(key: string, visible = false): boolean {
    return (this.notifyList.vibrates?.(key) ?? ((this.notifyList.notificationMode ?? "vibrate") === "vibrate" && this.notifyList.isNotifyChannel(key))) && (visible || this.cfg.wakeOnNotify);
  }
  private chatNotificationsAllowed(): boolean {
    return this.notifyList.allowsAppNotification?.("chat") ?? this.notifyList.notificationMode !== "off";
  }
  private deliverVibration(evidence: Pick<RichText, "originEventIds" | "experience">, at: number, key?: string): void {
    if (!canPerceivePhone(this.phone) || !this.chatNotificationsAllowed() || !(this.notifyList.vibrates?.(key) ?? ((this.notifyList.notificationMode ?? "vibrate") === "vibrate" && (!key || this.notifyList.isNotifyChannel(key))))) return;
    this.callbacks.notify({ text: "手机震了一下。", ...anonymousChatNoticeEvidence(evidence, at) }, this.cfg.wakeOnNotify);
  }

  /** 从消息记录里查某人的名字（查不到就用 id） */
  private async lookupUsername(platform: string, channelId: string, userId: string, selfId?: string): Promise<string> {
    try {
      const channels = await this.store.knownChannels();
      for (const c of channels) {
        if (c.platform !== platform || c.channelId !== channelId || (selfId && c.selfId !== selfId)) continue;
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
    if (!this.chatNotificationsAllowed()) return;
    if (!this.canReadScreen()) {
      this.deliverVibration({}, Date.now());
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
    if (!this.canReadScreen()) { this.deliverVibration({}, Date.now()); return; }
    if (!this.chatNotificationsAllowed()) return;
    this.callbacks.notify({ text }, (this.notifyList.appVibrates?.("chat") ?? (this.notifyList.notificationMode ?? "vibrate") === "vibrate") && this.cfg.wakeOnNotify);
  }

  private captureSessionTicket(session: Session): MessageOrderTicket {
    // A validated platform echo is already an observation of the account's
    // message, even when its send promise settles later. Keep that earlier slot.
    if (consistentAccountSession(session) && session.messageId && session.channelId && session.bot &&
      session.userId === session.bot.selfId) {
      return this.store.captureReceipt(session.bot.platform ?? "unknown", session.channelId, session.bot.selfId, String(session.messageId));
    }
    return this.store.captureLive();
  }

  private queueMessage(key: string, run: () => Promise<void>): Promise<void> {
    const previous = this.messageTails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.messageTails.set(key, next);
    void next.finally(() => { if (this.messageTails.get(key) === next) this.messageTails.delete(key); }).catch(() => {});
    return next;
  }

  /** Called only for successful adapter receipts, never an attempted before-send. */
  private async handleConfirmedSelfSent(message: ConfirmedSelfMessage, ticket = this.store.captureLive()): Promise<void> {
    const { bot, channelId, messageId, session } = message;
    const memberMetadata = session?.userId === bot.selfId ? sessionGroupMemberMetadata(session) : undefined;
    const platform = bot.platform ?? "unknown";
    const key = channelKey(platform, channelId, bot.selfId);
    if (messageId && await this.store.findByMessageId(platform, channelId, messageId, bot.selfId)) return;
    // Outgoing tool arguments must not include incoming-only annotations such as
    // “@的是你”, which were never part of the platform message actually sent.
    const direct = session?.event?.channel?.type == null ? undefined : session.isDirect;
    const { content, conversation } = await this.serializeMessage(message.elements, {
      platform, channelId, selfId: bot.selfId, containerMsgId: messageId,
      isDirect: direct ?? channelId.startsWith("private:"), guildId: session?.guildId,
      // A command's before-send session can still belong to its invoking peer.
      quote: session?.userId === bot.selfId ? session.quote : undefined,
    });
    if (!content.trim()) return;
    const identity = await this.names.identity(key, { isDirect: direct ?? channelId.startsWith("private:"), guildId: session?.guildId });
    // before-send may carry the invoking peer's session; only an account-authored
    // echo may supply the account's observed nickname.
    const observedName = session?.userId === bot.selfId ? sessionSenderName(session) : "";
    const saved = await this.store.store({
      selfId: bot.selfId, platform, channelId, guildId: session?.guildId ?? "",
      userId: bot.selfId, username: firstName(observedName, identity.displayName), content, timestamp: new Date(message.timestamp), timestampSource: message.timestampSource ?? "local-confirmed", platformSequence: message.platformSequence, self: true, senderOrigin: "external", senderOwned: true, messageId,
      isDirect: direct ?? channelId.startsWith("private:"),
      conversation,
      memberMetadata,
    }, ticket);
    // Store all enabled modes, but expand media only when that mode actually exposes
    // the message. A put-down phone event must never smuggle images into awareness.
    const visible = this.cfg.externalSelfMessages === "simulate" || (this.cfg.externalSelfMessages === "event" && this.canReadScreen());
    const rendered: RichText = visible
      ? { ...prefixRichText(`〔聊天记录 #${saved.id}〕（${conversationLabel(saved.conversation, bot.selfId)}）\n`, await this.renderer.render(content)), ...chatMessageEvidence(saved) }
      : this.cfg.externalSelfMessages === "event"
        ? { text: "", ...anonymousChatNoticeEvidence(chatMessageEvidence(saved), saved.observedAt?.getTime()) }
        : { text: "", originEventIds: [] };
    await this.callbacks.selfMessage(key, rendered, messageId, selfSendArguments(message.elements, content), saved);
  }

  /** Already-observed platform traffic, including another client logged into this account. */
  private async handleSelfEcho(session: Session, ticket = this.captureSessionTicket(session)): Promise<void> {
    if (this.cfg.externalSelfMessages === "off" || !session.channelId || !session.bot) return;
    if (!consistentAccountSession(session)) return;
    const key = channelKey(session.platform ?? session.bot.platform, session.channelId, session.selfId ?? session.bot.selfId);
    await this.selfCapture?.waitForPending(key);
    await this.ownSends.waitForPending(key);
    const messageId = session.messageId ? String(session.messageId) : "";
    if (messageId && (this.ownMessageIds.has(`${key}\0${messageId}`) || this.ownSends.wasSent(key, messageId))) return;
    // Already running in the channel queue: enqueuing again here would await itself.
    // Sending does not await this consumer, so waiting for adapter receipts above
    // cannot create a transport -> consumer -> transport cycle.
    await this.handleConfirmedSelfSent({ bot: session.bot, channelId: session.channelId, messageId,
      elements: session.elements ?? h.parse(session.content ?? ""), session, own: false, timestamp: session.timestamp ?? ticket.observedAt.getTime(),
      timestampSource: session.timestamp == null ? "local-observed" : "platform", platformSequence: sessionSequence(session) }, ticket);
  }

  private async handle(session: Session, ticket: MessageOrderTicket = this.captureSessionTicket(session), arrivalPermission?: boolean): Promise<void> {
    if (!session.content && !session.elements?.length) return;
    if (!consistentAccountSession(session)) return;
    const memberMetadata = sessionGroupMemberMetadata(session);
    if (session.userId && session.bot && session.platform === session.bot.platform && String(session.userId) === String(session.selfId ?? session.bot.selfId)) {
      await this.handleSelfEcho(session, ticket);
      return;
    }

    const key = channelKey(session.platform ?? "unknown", session.channelId ?? "unknown", session.selfId ?? session.bot?.selfId);
    const notifyOnArrival = arrivalPermission ?? this.notificationAllowed(key);
    const selfId = session.selfId ?? session.bot?.selfId ?? undefined;
    const senderOwned = this.ctx.bots.some(bot => bot.platform === session.platform && bot.selfId === session.userId);
    if (session.messageId && session.channelId && await this.store.findByMessageId(
      session.platform ?? "unknown", session.channelId, String(session.messageId), selfId,
    )) return;
    const elements = session.elements ?? h.parse(session.content ?? "");
    const { content, conversation } = await this.serializeMessage(elements, {
      platform: session.platform ?? "unknown", channelId: session.channelId ?? "unknown", selfId,
      containerMsgId: session.messageId ?? undefined, isDirect: session.isDirect, guildId: session.guildId,
      quote: session.quote, annotateSelf: true,
    });
    if (!content.trim()) return;

    const saved = await this.store.store({
      selfId: session.selfId ?? session.bot?.selfId ?? "",
      platform: session.platform ?? "unknown",
      channelId: session.channelId ?? "unknown",
      guildId: session.guildId ?? "",
      userId: session.userId ?? "",
      username: sessionSenderName(session),
      content,
      timestamp: new Date(session.timestamp ?? ticket.observedAt.getTime()),
      timestampSource: session.timestamp == null ? "local-observed" : "platform",
      platformSequence: sessionSequence(session),
      self: false,
      senderOwned,
      messageId: session.messageId ?? "",
      isDirect: session.isDirect,
      conversation,
      memberMetadata,
    }, ticket);

    await this.notifyList.receive?.(key, saved, notifyOnArrival);
    // 频道有新动静：先让系统侧（延期发送意图等）知情，再走通知策略
    this.callbacks.channelActivity(key);
    // 聚焦决定可见正文；通知设置独立决定震动／唤醒。
    let focused = this.focus.isFocused(key);
    const mayNotify = notifyOnArrival && this.notificationAllowed(key);
    if (!focused && !mayNotify) return;

    // An unreadable screen (including explicit sleep) exposes only the existing anonymous signal.
    if (!this.canReadScreen()) {
      if (notifyOnArrival) this.deliverVibration(chatMessageEvidence(saved), saved.observedAt?.getTime() ?? ticket.observedAt.getTime(), key);
      return;
    }

    let notification = focused
      ? await this.renderFocused(key, session, content, conversation, saved)
      : await this.renderNotification(key, session, content, conversation, saved);
    // Rendering images or resolving names can finish after the phone was put down.
    // Recheck the actual delivery boundary before exposing text or participant facts.
    if (!this.canReadScreen()) {
      if (notifyOnArrival) this.deliverVibration(chatMessageEvidence(saved), saved.observedAt?.getTime() ?? ticket.observedAt.getTime(), key);
      return;
    }
    if (focused && !this.focus.isFocused(key)) {
      focused = false;
      if (!notifyOnArrival || !this.notificationAllowed(key)) return;
      notification = await this.renderNotification(key, session, content, conversation, saved);
      if (!this.canReadScreen()) { this.deliverVibration(chatMessageEvidence(saved), ticket.observedAt.getTime(), key); return; }
    }
    if (!focused && (!notifyOnArrival || !this.notificationAllowed(key))) return;
    // Only full message delivery grants the evidence identity and its participants.
    // A vibration/count/channel preview is not the unseen message's body.
    const evidence = focused || this.cfg.notifyPolicy === "content"
      ? chatMessageEvidence(saved)
      : anonymousChatNoticeEvidence(chatMessageEvidence(saved), ticket.observedAt.getTime());
    if (!focused && this.cfg.notifyPolicy === "channel" && evidence.experience) {
      evidence.experience.chat = { channelKey: key, kind: "notice" };
    }
    const accepted = this.callbacks.notify({ ...notification, ...evidence }, notifyOnArrival && this.shouldWake(key, focused));
    if (accepted !== false && (focused || this.cfg.notifyPolicy === "content")) await this.notifyList.markSeen?.(key, [saved]);
  }

  /** Normalize only platform quote elements/session metadata, never matching text
   * written by a participant. Adapter representations of the same reply share one tag. */
  private async serializeMessage(elements: h[], opts: {
    platform: string; channelId: string; selfId?: string; containerMsgId?: string;
    isDirect?: boolean; guildId?: string; quote?: Session["quote"]; annotateSelf?: boolean;
  }): Promise<{ content: string; conversation: ConversationContext }> {
    const quote = opts.quote;
    const elementQuotes = collectElementQuotes(elements);
    const elementIds = [...elementQuotes.keys()].filter(Boolean);
    // An adapter may strip the id from session.quote but leave it on its element.
    // A unique explicit element id is evidence; multiple conflicting ids are not.
    const quoteId = quote?.id ? String(quote.id) : quote && elementIds.length === 1 ? elementIds[0] : undefined;
    const conversation = describeConversation(elements, conversationKind(opts.isDirect, opts.channelId, opts.guildId), isStickerElement,
      quote ? { ...(quoteId ? { messageId: quoteId } : {}), ...(quote.user?.id != null ? { userId: String(quote.user.id) } : {}) } : undefined);
    const original = conversation.reply?.messageId
      ? await this.store.findByMessageId(opts.platform, opts.channelId, conversation.reply.messageId, opts.selfId) : null;
    if (original?.userId && conversation.reply && !conversation.reply.userId) conversation.reply.userId = original.userId;
    let content = await this.serializeElements(elements, {
      containerMsgId: opts.containerMsgId, selfId: opts.annotateSelf ? opts.selfId : undefined,
      elementQuotes, seenQuotes: new Set(), sessionQuote: !!quote, sessionQuoteId: quoteId,
    });
    if (quote) {
      const qUser = quote.user as { name?: string; nick?: string; id?: string } | undefined;
      const fallback = elementQuotes.get(quoteId ?? "");
      const recordedName = original && original.userId === opts.selfId && isLegacySenderPlaceholder(original) ? "" : original?.username;
      const username = firstName(recordedName, (quote as unknown as { member?: { nick?: string } }).member?.nick, qUser?.nick, qUser?.name, fallback?.name);
      const quoteUserId = conversation.reply?.userId;
      const name = username || quoteUserId ? formatMessageSender({ platform: opts.platform, selfId: opts.selfId, userId: quoteUserId ?? "", username,
        senderOrigin: original?.senderOrigin ?? (recordedName ? undefined : "unknown"), senderOwned: original?.senderOwned },
        { platform: opts.platform, selfId: opts.selfId, accountIds: this.ctx.bots.filter(bot => bot.platform === opts.platform).map(bot => bot.selfId) }) : undefined;
      content = quoteTag({ id: quoteId, name,
        text: truncate(plainText(quote.elements ?? h.parse(quote.content ?? "")), 40) || fallback?.text || undefined }) + content;
    }
    return { content, conversation };
  }

  /** 元素树 → 存储文本：媒体下载入资产库并替换为占位符 */
  private async serializeElements(
    elements: h[],
    opts: { containerMsgId?: string; selfId?: string; seenQuotes?: Set<string>;
      elementQuotes?: Map<string, { name?: string; text?: string }>; sessionQuote?: boolean; sessionQuoteId?: string } = {},
  ): Promise<string> {
    opts = { ...opts, seenQuotes: opts.seenQuotes ?? new Set(), elementQuotes: opts.elementQuotes ?? collectElementQuotes(elements) };
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
          const quotedId = el.attrs.id == null ? "" : String(el.attrs.id);
          if (opts.seenQuotes!.has(quotedId) || (opts.sessionQuote && (!quotedId || quotedId === opts.sessionQuoteId))) break;
          opts.seenQuotes!.add(quotedId);
          out += quoteTag({ id: quotedId || undefined, ...opts.elementQuotes!.get(quotedId) });
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
  private async renderFocused(key: string, session: Session, content: string, conversation: ConversationContext, sender: WorldMessageRow): Promise<RichText> {
    const rendered = await this.renderer.render(content);
    const msgTag =
      `〔聊天记录 #${sender.id}〕` + (needsMsgIds(this.ops) && session.messageId ? ` (msg:${session.messageId})` : "") + "\n";
    const identity = await this.names.identity(key, { isDirect: session.isDirect, guildId: session.guildId });
    const who = formatMessageSender(sender, identity, this.cfg.groupMetadata);
    const header = `你正留意着 ${await this.names.display(key)}，看到新消息（${conversationLabel(conversation, session.selfId ?? session.bot?.selfId)}）\n${identity.text}\n${msgTag}发送者：${who}\n消息正文：\n`;
    return prefixRichText(header, rendered, "\n〔该条消息结束〕");
  }

  private async renderNotification(key: string, session: Session, content: string, conversation: ConversationContext, sender: WorldMessageRow): Promise<RichText> {
    const cue = this.notifyList.notificationMode === "silent" ? "手机屏幕提示" : "手机响了一下";
    switch (this.cfg.notifyPolicy) {
      case "count":
        return { text: `${cue}：收到一条新消息。` };
      case "channel":
        return { text: `${cue}：收到来自 ${await this.names.display(key)} 的消息。` };
      case "content": {
        const rendered = await this.renderer.render(content);
        const msgTag = `〔聊天记录 #${sender.id}〕` + (needsMsgIds(this.ops) && session.messageId ? ` (msg:${session.messageId})` : "") + "\n";
        const identity = await this.names.identity(key, { isDirect: session.isDirect, guildId: session.guildId });
        const who = formatMessageSender(sender, identity, this.cfg.groupMetadata);
        const header = `${cue}：收到来自 ${await this.names.display(key)} 的消息（${conversationLabel(conversation, session.selfId ?? session.bot?.selfId)}）\n${identity.text}\n${msgTag}发送者：${who}\n消息正文：\n`;
        return prefixRichText(header, rendered, "\n〔该条消息结束〕");
      }
    }
  }
}

/** A mismatched adapter event cannot borrow another connection's account identity. */
function consistentAccountSession(session: Session): boolean {
  return !session.bot || ((!session.platform || session.platform === session.bot.platform)
    && (!session.selfId || String(session.selfId) === String(session.bot.selfId)));
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
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** at 元素的标签文本形式（Bot 可照抄发出） */
export function atTag(id: string, name?: string): string {
  return `<at id="${escAttr(id)}"${name ? ` name="${escAttr(name)}"` : ""}/>`;
}

/** face（平台表情）元素的标签文本形式（Bot 可照抄发出） */
export function faceTag(id: string, name?: string): string {
  return `<face id="${escAttr(id)}"${name ? ` name="${escAttr(name)}"` : ""}/>`;
}

/** Quote children describe the referenced message, not the containing message.
 * Merge adapter duplicates by their actual id without interpreting ordinary text. */
function collectElementQuotes(elements: h[], quotes = new Map<string, { name?: string; text?: string }>()): Map<string, { name?: string; text?: string }> {
  for (const element of elements) {
    if (element.type === "quote") {
      const id = element.attrs.id == null ? "" : String(element.attrs.id);
      const previous = quotes.get(id);
      const name = typeof element.attrs.name === "string" ? element.attrs.name : undefined;
      const text = typeof element.attrs.text === "string" ? element.attrs.text : plainText(element.children);
      quotes.set(id, { ...(previous?.name || name ? { name: previous?.name || name } : {}),
        ...(previous?.text || text ? { text: previous?.text || truncate(text, 40) } : {}) });
    } else if (element.type !== "forward" && element.children?.length) collectElementQuotes(element.children, quotes);
  }
  return quotes;
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

function sessionSequence(session: Session): string | null {
  const raw = ((session as unknown as { onebot?: Record<string, unknown> }).onebot ?? (session.event as unknown as { _data?: Record<string, unknown> })?._data ?? {});
  return messageSequence(raw.message_seq);
}
