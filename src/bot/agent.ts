import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { Config } from "../config.js";
import type { WorldFiles } from "../files.js";
import { ToolCallParseError } from "../llm/parse.js";
import type { BotEvent, CompressionResult, EventSource, MediaRef, ParsedToolCall, RichText, ToolCallRecord } from "../types.js";
import type { WorldAgent } from "../world/agent.js";
import { createBackend, type BotBackend } from "./backend.js";
import type { BotContext } from "./context.js";
import { Scheduler } from "./scheduler.js";

/** Koishi 侧能力（消息查询与发送），由 service 层实现注入 */
export interface MessengerApi {
  recentChannels(n: number): Promise<RichText>;
  channelMessages(id: string, n: number): Promise<RichText>;
  gallery(): Promise<string>;
  checkMedia(n: number, type?: "image" | "audio" | "video"): Promise<string>;
  gallerySave(mediaId: string, name?: string): Promise<string>;
  galleryRemove(name: string): Promise<string>;
  send(id: string, msg: string, media?: (string | number)[], replyTo?: string, atSender?: boolean): Promise<string>;
  sendFile(id: string, ref: string): Promise<string>;
  sendVoice(id: string, text: string): Promise<string>;
  putDownPhone(): Promise<string>;
  recall(id: string, msgId: string): Promise<string>;
  react(id: string, msgId: string, emoji: string): Promise<string>;
  poke(id: string, userId?: string): Promise<string>;
  handleRequest(requestId: string, approve: boolean, reason?: string): Promise<string>;
  listFriends(): Promise<string>;
  userInfo(userId: string): Promise<string>;
  sendLike(userId: string, times: number): Promise<string>;
  deleteFriend(userId: string): Promise<string>;
  setProfile(opts: { nickname?: string; signature?: string; avatar?: string }): Promise<string>;
  listGroups(): Promise<string>;
  groupInfo(id: string): Promise<string>;
  listMembers(id: string): Promise<string>;
  memberInfo(id: string, userId: string): Promise<string>;
  setGroupCard(id: string, card: string): Promise<string>;
  setGroupName(id: string, name: string): Promise<string>;
  setGroupPortrait(id: string, image: string): Promise<string>;
  sendGroupNotice(id: string, content: string): Promise<string>;
  setEssence(msgId: string, remove: boolean): Promise<string>;
  groupSign(id: string): Promise<string>;
  groupBan(id: string, userId: string, minutes: number): Promise<string>;
  groupWholeBan(id: string, enable: boolean): Promise<string>;
  groupKick(id: string, userId: string, block: boolean): Promise<string>;
  groupAdmin(id: string, userId: string, enable: boolean): Promise<string>;
  setSpecialTitle(id: string, userId: string, title: string): Promise<string>;
  groupLeave(id: string): Promise<string>;
}

interface MailboxItem {
  source: EventSource;
  content: string;
  attachments?: MediaRef[];
  refToolCallId?: string;
  worldTime: number;
  /** 存在时：先把此项作为 Bot 的工具调用追加进流（伪装成 Bot 主动输出），content 作为其结果事件 */
  asToolCall?: { name: string; arguments: Record<string, unknown> };
}

/**
 * Bot-LLM：持续推理的 Agent。
 *
 * 主循环：排空事件邮箱（应用上下文修改）→ 生成一个工具调用 → 追加进流 →
 * 派发执行（不等待结果）→ 立即生成下一个。
 *
 * 阻塞规则：上下文修改（事件注入、压缩）只发生在两次生成之间 ——
 * 事件先进 mailbox，在下一次生成开始前统一追加。
 *
 * wait() / rest() 是仅有的两个会暂停生成的工具。
 */
export class BotAgent {
  private backend: BotBackend;
  readonly scheduler: Scheduler;
  private mailbox: MailboxItem[] = [];
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private waiting: { callId: string; kind: "wait" | "act" } | null = null;
  private wakeFn: (() => void) | null = null;
  private lastGenAt = 0;
  /** check_status 增量返回：上次查看时的状态文件快照（target → 全文） */
  private lastStatus = new Map<string, string>();
  /** check_status(world) 已看过的最新一条 News 的世界时刻 */
  private lastNewsT: number | null = null;
  /** 上一次 send 的签名（频道+内容+图片），用于拦截连续的重复发送 */
  private lastSendSig: string | null = null;
  /** 上一次 act 的描述与调用编号，用于拦截"结果未出就重复做同一件事" */
  private lastAct: { sig: string; callId: string } | null = null;
  /**
   * 注入 system 段的"醒来时刻"：仅在 start() 与 rest 结束时更新。
   * 决不能用实时时间——那会让 system 段每 0.1 TU 变一次，
   * 前缀在 system 处断裂，整个 Tool Call 流每次请求都重新 prompt eval（缓存全灭）。
   * 当前时间由事件的 t 属性承载。
   */
  private wakeTimeLine = "";

  constructor(
    private config: Config,
    private clock: WorldClock,
    private files: WorldFiles,
    private context: BotContext,
    private world: WorldAgent,
    private messenger: MessengerApi,
    private logger: Logger,
    toolNames?: string[],
  ) {
    this.backend = createBackend(config.bot, toolNames);
    this.scheduler = new Scheduler(
      clock,
      (content, ref) => this.pushEvent("tool", content, { ref }),
      logger,
    );
  }

  // ---------- 生命周期 ----------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.wakeTimeLine = this.clock.timeLine();
    this.abort = new AbortController();
    this.loopPromise = this.runLoop().catch((err) => {
      this.logger.error("Bot-LLM 主循环异常退出: %s", err);
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    this.scheduler.stopAll();
    this.waiting = null;
    this.wakeFn?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  status(): { running: boolean; waiting: string | null; streamLength: number; approxChars: number; pendingTasks: number } {
    return {
      running: this.running,
      waiting: this.waiting?.callId ?? null,
      streamLength: this.context.stream.length,
      approxChars: this.context.approxChars(),
      pendingTasks: this.scheduler.pendingCount,
    };
  }

  // ---------- 事件注入（唯一入口） ----------

  /**
   * 向 Bot 的意识流投递事件。实际追加发生在两次生成之间（阻塞规则）。
   * wake: Bot 处于 wait() 时是否将其提前唤醒。
   */
  pushEvent(
    source: EventSource,
    content: string | RichText,
    opts: { ref?: string; wake?: boolean } = {},
  ): void {
    const rich: RichText = typeof content === "string" ? { text: content } : content;
    const isWaitResult = this.waiting !== null && opts.ref === this.waiting.callId;
    const shouldWake = this.waiting !== null && (isWaitResult || opts.wake === true);

    if (shouldWake && !isWaitResult) {
      const { callId, kind } = this.waiting!;
      if (kind === "wait") {
        // 提前唤醒：取消等待到期任务，并在事件前插入打断说明
        this.scheduler.cancel(callId);
        this.mailbox.push({
          source: "system",
          content: "你的等待被打断了。",
          refToolCallId: callId,
          worldTime: this.clock.now(),
        });
      } else {
        // 阻塞中的 act：注意力被吸引，但动作不中止，结果照常在完成时交付
        this.mailbox.push({
          source: "system",
          content: `（这动静吸引了你的注意。你手头的动作（${callId}）仍在继续，完成时你会知道结果。）`,
          refToolCallId: callId,
          worldTime: this.clock.now(),
        });
      }
    }

    this.mailbox.push({
      source,
      content: rich.text,
      attachments: rich.attachments?.length ? rich.attachments : undefined,
      refToolCallId: opts.ref,
      worldTime: this.clock.now(),
    });
    this.logger.info(
      "[event:%s]%s %s%s",
      source,
      opts.ref ? ` (${opts.ref})` : "",
      truncate(rich.text, 120),
      rich.attachments?.length ? ` [+${rich.attachments.length} 附件]` : "",
    );

    if (shouldWake) {
      this.waiting = null;
      this.wakeFn?.();
    }
  }

  /**
   * 外部（其他插件 / Koishi 指令输出）以 Bot 账号发出的消息，伪装成 Bot 自己的
   * send 工具调用注入流（externalSelfMessages = simulate）——Bot 会以为是自己发的。
   * 注入同样遵守阻塞规则：在下一次生成前统一追加。
   */
  simulateExternalSend(channelKey: string, msg: string): void {
    this.mailbox.push({
      source: "tool",
      content: `消息已发送到 ${channelKey}。`,
      worldTime: this.clock.now(),
      asToolCall: { name: "send", arguments: { id: channelKey, msg } },
    });
    this.logger.info("[external-send:simulate] %s %s", channelKey, truncate(msg, 100));
  }

  // ---------- 主循环 ----------

  private async runLoop(): Promise<void> {
    this.logger.info("Bot-LLM 开始持续推理（%s 模式）", this.config.bot.mode);
    while (this.running) {
      try {
        await this.drainMailbox();

        // 上下文满：强制休息（带世界观内的合理解释）
        if (this.context.approxChars() > this.config.bot.maxWindowChars) {
          await this.doRest(null, true);
          continue;
        }

        // wait() 中：暂停生成，直到被唤醒
        if (this.waiting) {
          await this.sleepUntilWoken();
          continue;
        }

        await this.throttle();

        // throttle 睡眠期间（含上一个即时工具的执行窗口）可能有新事件到达：
        // 生成前再次排空，避免 Bot 看不到"就差一步"的结果而误以为调用无效、重复调用
        await this.drainMailbox();

        let parsed: ParsedToolCall;
        try {
          parsed = await this.backend.generate(this.context, this.wakeTimeLine, this.abort!.signal);
        } catch (err) {
          if (!this.running) break;
          if (err instanceof ToolCallParseError) {
            this.pushEvent("system", `（意识有些恍惚，刚才的想法没有成形：${err.message}。请重新输出一个合法的工具调用。）`);
            continue;
          }
          this.logger.warn("Bot-LLM 生成失败，%dms 后重试: %s", this.config.bot.retryDelayMs, err);
          await sleep(this.config.bot.retryDelayMs);
          continue;
        }

        const call = this.finalize(parsed);
        await this.context.appendToolCall(call);
        this.logger.info(
          "[tool] %s %s(%s)%s",
          call.id,
          call.name,
          truncate(JSON.stringify(call.arguments), 100),
          call.duration ? ` +${call.duration}TU` : "",
        );
        await this.dispatch(call);
      } catch (err) {
        if (!this.running) break;
        this.logger.error("Bot-LLM 循环出错: %s", err);
        await sleep(this.config.bot.retryDelayMs);
      }
    }
    this.logger.info("Bot-LLM 停止推理");
  }

  private async drainMailbox(): Promise<void> {
    if (!this.mailbox.length) return;
    const items = this.mailbox.splice(0);
    for (const item of items) {
      // 伪装的工具调用（externalSelfMessages = simulate）：以 Bot 的口吻追加进流
      if (item.asToolCall) {
        const call: ToolCallRecord = {
          id: this.context.nextToolId(),
          role: "agent",
          name: item.asToolCall.name,
          arguments: item.asToolCall.arguments,
          issuedAt: item.worldTime,
          expectedAt: item.worldTime,
        };
        await this.context.appendToolCall(call);
        if (!item.content) continue;
        item.refToolCallId = call.id;
      }
      const event: BotEvent = {
        id: this.context.nextEventId(),
        source: item.source,
        content: item.content,
        worldTime: item.worldTime,
        refToolCallId: item.refToolCallId,
        attachments: item.attachments,
      };
      await this.context.appendEvent(event);
    }
  }

  private async sleepUntilWoken(): Promise<void> {
    if (!this.waiting || !this.running) return;
    await new Promise<void>((resolve) => {
      this.wakeFn = resolve;
      if (!this.waiting || !this.running) resolve();
    });
    this.wakeFn = null;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastGenAt + this.config.bot.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastGenAt = Date.now();
  }

  private finalize(parsed: ParsedToolCall): ToolCallRecord {
    const issuedAt = this.clock.now();
    let duration = parsed.duration;
    // wait 的等待时长以参数 n 为准（模型常输出 duration: 0 + n: x 的组合）
    if (parsed.name === "wait" && !(duration && duration > 0)) {
      const n = Number(parsed.arguments.n ?? 0);
      if (Number.isFinite(n) && n > 0) duration = n;
    }
    return {
      id: this.context.nextToolId(),
      role: "agent",
      name: parsed.name,
      arguments: parsed.arguments,
      duration,
      issuedAt,
      expectedAt: issuedAt + (duration ?? 0),
    };
  }

  // ---------- 工具派发 ----------

  private async dispatch(call: ToolCallRecord): Promise<void> {
    switch (call.name) {
      case "wait":
        return this.dispatchWait(call);
      case "act":
        return this.dispatchAct(call);
      case "rest":
        return this.doRest(call, false);
      case "check_status":
        return this.dispatchLocal(call, async () => this.readStatus(call));
      case "check_time":
        // 由世界裁定能否得知时间（允许失败）；World-LLM 不可用时退化为直接报时，保证工具可靠
        return this.dispatchLocal(call, async () => {
          const parts: string[] = [];
          await this.world.resolveCheckTime((content) => parts.push(content));
          return parts.length ? parts.join("\n") : `你看了看时间——当前 ${this.clock.timeLine()}`;
        });
      case "check_news":
        return this.dispatchLocal(call, async () => {
          const news = await this.files.readNews(clampInt(call.arguments.n, 1, 30, 10));
          if (!news.length) return "你回想近来听到的种种消息——似乎没什么值得一提的大事。";
          // 与 check_status(world) 的增量视图保持同步：这里看过的不再作为"新发生的事"重复出现
          this.lastNewsT = Math.max(...news.map((e) => e.t));
          return `你回想起近来听到的种种消息：\n` + news.map((e) => `- [${e.clock}] ${e.content}`).join("\n");
        });
      case "check_msg":
        return this.dispatchLocal(call, async () =>
          this.messenger.recentChannels(clampInt(call.arguments.n, 1, 20, 5)),
        );
      case "select_channel":
        return this.dispatchLocal(call, async () =>
          this.messenger.channelMessages(
            String(call.arguments.id ?? ""),
            clampInt(call.arguments.n, 1, 50, 10),
          ),
        );
      case "check_gallery":
        return this.dispatchLocal(call, async () => this.messenger.gallery());
      case "check_media": {
        const typeRaw = String(call.arguments.type ?? "");
        const type = typeRaw === "image" || typeRaw === "audio" || typeRaw === "video" ? typeRaw : undefined;
        return this.dispatchLocal(call, async () =>
          this.messenger.checkMedia(clampInt(call.arguments.n, 1, 30, 10), type),
        );
      }
      case "gallery_save": {
        const mediaId = String(call.arguments.media_id ?? call.arguments.mediaId ?? call.arguments.id ?? "");
        if (!mediaId) {
          this.pushEvent("system", "（gallery_save 需要 media_id 参数（媒体编号）。）", { ref: call.id });
          return;
        }
        const name = call.arguments.name != null ? String(call.arguments.name) : undefined;
        return this.dispatchLocal(call, async () => this.messenger.gallerySave(mediaId, name));
      }
      case "gallery_remove": {
        const name = String(call.arguments.name ?? "");
        if (!name) {
          this.pushEvent("system", "（gallery_remove 需要 name 参数（收藏夹文件名）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.galleryRemove(name));
      }
      case "send":
        return this.dispatchSend(call);
      case "send_file":
        return this.dispatchSendFile(call);
      case "send_voice":
        return this.dispatchSendVoice(call);
      case "put_down_phone":
        return this.dispatchLocal(call, async () => this.messenger.putDownPhone());
      case "recall": {
        const id = String(call.arguments.id ?? "");
        const msgId = String(call.arguments.msg_id ?? call.arguments.msgId ?? "");
        if (!id || !msgId) {
          this.pushEvent("system", "（recall 需要 id 和 msg_id 参数，msg_id 来自消息记录里的 (msg:xxx) 标注。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.recall(id, msgId));
      }
      case "react": {
        const id = String(call.arguments.id ?? "");
        const msgId = String(call.arguments.msg_id ?? call.arguments.msgId ?? "");
        const emoji = String(call.arguments.emoji ?? "");
        if (!id || !msgId || !emoji) {
          this.pushEvent("system", "（react 需要 id、msg_id 和 emoji 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.react(id, msgId, emoji));
      }
      case "poke": {
        const id = String(call.arguments.id ?? "");
        if (!id) {
          this.pushEvent("system", "（poke 需要 id 参数。）", { ref: call.id });
          return;
        }
        const userId = call.arguments.user_id ?? call.arguments.userId;
        return this.dispatchLocal(call, async () =>
          this.messenger.poke(id, userId !== undefined && userId !== null ? String(userId) : undefined),
        );
      }
      case "handle_request": {
        const requestId = String(call.arguments.request_id ?? call.arguments.requestId ?? call.arguments.id ?? "");
        const approveRaw = call.arguments.approve;
        if (!requestId || approveRaw === undefined || approveRaw === null) {
          this.pushEvent("system", "（handle_request 需要 request_id 和 approve 参数。）", { ref: call.id });
          return;
        }
        const approve = isTruthy(approveRaw);
        const reason = call.arguments.reason != null ? String(call.arguments.reason) : undefined;
        return this.dispatchLocal(call, async () => this.messenger.handleRequest(requestId, approve, reason));
      }
      case "list_friends":
        return this.dispatchLocal(call, async () => this.messenger.listFriends());
      case "user_info": {
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? call.arguments.id ?? "");
        if (!userId) {
          this.pushEvent("system", "（user_info 需要 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.userInfo(userId));
      }
      case "send_like": {
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? call.arguments.id ?? "");
        if (!userId) {
          this.pushEvent("system", "（send_like 需要 user_id 参数。）", { ref: call.id });
          return;
        }
        const times = clampInt(call.arguments.times, 1, 10, 1);
        return this.dispatchLocal(call, async () => this.messenger.sendLike(userId, times));
      }
      case "delete_friend": {
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? call.arguments.id ?? "");
        if (!userId) {
          this.pushEvent("system", "（delete_friend 需要 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.deleteFriend(userId));
      }
      case "set_profile": {
        const nickname = call.arguments.nickname != null ? String(call.arguments.nickname) : undefined;
        const signature = call.arguments.signature != null ? String(call.arguments.signature) : undefined;
        const avatar = call.arguments.avatar != null ? String(call.arguments.avatar) : undefined;
        if (!nickname && !signature && !avatar) {
          this.pushEvent("system", "（set_profile 需要 nickname、signature、avatar 中至少一个参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setProfile({ nickname, signature, avatar }));
      }
      case "list_groups":
        return this.dispatchLocal(call, async () => this.messenger.listGroups());
      case "group_info": {
        const id = String(call.arguments.id ?? "");
        if (!id) {
          this.pushEvent("system", "（group_info 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupInfo(id));
      }
      case "list_members": {
        const id = String(call.arguments.id ?? "");
        if (!id) {
          this.pushEvent("system", "（list_members 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.listMembers(id));
      }
      case "member_info": {
        const id = String(call.arguments.id ?? "");
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        if (!id || !userId) {
          this.pushEvent("system", "（member_info 需要 id 和 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.memberInfo(id, userId));
      }
      case "set_group_card": {
        const id = String(call.arguments.id ?? "");
        const card = String(call.arguments.card ?? call.arguments.name ?? "");
        if (!id || !card) {
          this.pushEvent("system", "（set_group_card 需要 id 和 card 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setGroupCard(id, card));
      }
      case "set_group_name": {
        const id = String(call.arguments.id ?? "");
        const name = String(call.arguments.name ?? "");
        if (!id || !name) {
          this.pushEvent("system", "（set_group_name 需要 id 和 name 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setGroupName(id, name));
      }
      case "set_group_portrait": {
        const id = String(call.arguments.id ?? "");
        const image = String(call.arguments.image ?? "");
        if (!id || !image) {
          this.pushEvent("system", "（set_group_portrait 需要 id 和 image 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setGroupPortrait(id, image));
      }
      case "send_group_notice": {
        const id = String(call.arguments.id ?? "");
        const content = String(call.arguments.content ?? "");
        if (!id || !content) {
          this.pushEvent("system", "（send_group_notice 需要 id 和 content 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.sendGroupNotice(id, content));
      }
      case "set_essence": {
        const msgId = String(call.arguments.msg_id ?? call.arguments.msgId ?? "");
        if (!msgId) {
          this.pushEvent("system", "（set_essence 需要 msg_id 参数，来自消息记录里的 (msg:xxx) 标注。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () =>
          this.messenger.setEssence(msgId, isTruthy(call.arguments.remove)),
        );
      }
      case "group_sign": {
        const id = String(call.arguments.id ?? "");
        if (!id) {
          this.pushEvent("system", "（group_sign 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupSign(id));
      }
      case "group_ban": {
        const id = String(call.arguments.id ?? "");
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        const minutes = Number(call.arguments.minutes ?? call.arguments.duration ?? NaN);
        if (!id || !userId || !Number.isFinite(minutes) || minutes < 0) {
          this.pushEvent("system", "（group_ban 需要 id、user_id 和 minutes 参数（0 表示解除禁言）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupBan(id, userId, minutes));
      }
      case "group_whole_ban": {
        const id = String(call.arguments.id ?? "");
        const enable = call.arguments.enable;
        if (!id || enable === undefined || enable === null) {
          this.pushEvent("system", "（group_whole_ban 需要 id 和 enable 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupWholeBan(id, isTruthy(enable)));
      }
      case "group_kick": {
        const id = String(call.arguments.id ?? "");
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        if (!id || !userId) {
          this.pushEvent("system", "（group_kick 需要 id 和 user_id 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () =>
          this.messenger.groupKick(id, userId, isTruthy(call.arguments.block)),
        );
      }
      case "group_admin": {
        const id = String(call.arguments.id ?? "");
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        const enable = call.arguments.enable;
        if (!id || !userId || enable === undefined || enable === null) {
          this.pushEvent("system", "（group_admin 需要 id、user_id 和 enable 参数。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupAdmin(id, userId, isTruthy(enable)));
      }
      case "set_special_title": {
        const id = String(call.arguments.id ?? "");
        const userId = String(call.arguments.user_id ?? call.arguments.userId ?? "");
        const title = String(call.arguments.title ?? "");
        if (!id || !userId) {
          this.pushEvent("system", "（set_special_title 需要 id 和 user_id 参数（title 为空表示移除头衔）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.setSpecialTitle(id, userId, title));
      }
      case "group_leave": {
        const id = String(call.arguments.id ?? "");
        if (!id) {
          this.pushEvent("system", "（group_leave 需要 id 参数（群频道 id）。）", { ref: call.id });
          return;
        }
        return this.dispatchLocal(call, async () => this.messenger.groupLeave(id));
      }
      case "cancel":
        return this.dispatchCancel(call);
      case "identity_recall":
        return this.dispatchIdentityRecall(call);
      default:
        this.pushEvent("system", `（没有名为 ${call.name} 的能力。）`, { ref: call.id });
    }
  }

  /**
   * 调度类调用的启动确认：生成后立即以事件告知"已开始执行"，随后照常生成下一个调用。
   * 这从源头消除了"结果尚未进邮箱 → Bot 以为工具没反应 → 重复调用"的信息真空，
   * 且不引入任何等待延迟。带 duration 的调用额外附上编号（可 cancel）与预计完成时刻。
   */
  private ackStart(call: ToolCallRecord): void {
    if ((call.duration ?? 0) > 0) {
      this.pushEvent(
        "system",
        `${call.id} ${call.name} 已开始，预计 T=${call.expectedAt.toFixed(1)} 完成。`,
        { ref: call.id },
      );
    } else {
      this.pushEvent(
        "system",
        `${call.id} ${call.name} 已开始执行，完成时你会收到结果——不必重复调用。`,
        { ref: call.id },
      );
    }
  }

  private dispatchWait(call: ToolCallRecord): void {
    const n = call.duration ?? 0;
    if (n <= 0) {
      this.pushEvent("system", "（等待时长必须大于 0。）", { ref: call.id });
      return;
    }
    this.waiting = { callId: call.id, kind: "wait" };
    this.scheduler.schedule(call, {
      executeAt: "expected",
      run: async () => {
        // World-LLM 认为等待时间已到：生成期间发生的事并唤醒 Bot
        let delivered = false;
        await this.world.resolveWait(call, (content) => {
          delivered = true;
          this.pushEvent("world", content, { ref: call.id });
        });
        if (!delivered) {
          this.pushEvent("system", `等待结束了。当前 ${this.clock.timeLine()}`, { ref: call.id });
        }
        return null;
      },
    });
  }

  private dispatchAct(call: ToolCallRecord): void {
    const desc = String(call.arguments.description ?? call.arguments.str ?? "");
    // 拦截"上一个相同的动作还没出结果就再做一遍"（模型常见的复读行为），除非显式声明 repeat
    const sig = desc.trim();
    if (
      sig &&
      this.lastAct?.sig === sig &&
      this.scheduler.isPending(this.lastAct.callId) &&
      !isTruthy(call.arguments.repeat)
    ) {
      this.pushEvent(
        "system",
        `（你已经在做这件事了（${this.lastAct.callId}），它还没有完成，这次没有重复开始——` +
          `耐心等它的结果，或者先做点别的。如果你确定要同时再做一遍同样的事，请在参数里加上 repeat: true。）`,
        { ref: call.id },
      );
      return;
    }
    this.lastAct = { sig, callId: call.id };
    this.ackStart(call);
    this.scheduler.schedule(call, {
      executeAt: "now", // 世界立刻开始裁定；结果压到期望完成时刻交付
      run: async (task) => {
        const parts: string[] = [];
        await this.world.adjudicateAct(call, (content) => parts.push(content));
        if (task.cancelled()) return null;
        return parts.length
          ? parts.join("\n")
          : `（${desc || "刚才的动作"}完成了。）`;
      },
    });
    // 阻塞模式：一个人同时只能专注做一件事，动作完成（结果交付）前暂停生成
    if (this.config.bot.blockingAct) {
      this.waiting = { callId: call.id, kind: "act" };
    }
  }

  private dispatchLocal(call: ToolCallRecord, run: () => Promise<string | RichText>): void {
    this.ackStart(call);
    this.scheduler.schedule(call, { executeAt: "now", run });
  }

  private dispatchSend(call: ToolCallRecord): void {
    const id = String(call.arguments.id ?? "");
    const msg = String(call.arguments.msg ?? "");
    const mediaRaw = call.arguments.media ?? call.arguments.images;
    const media = Array.isArray(mediaRaw) ? (mediaRaw as (string | number)[]) : [];
    const replyRaw = call.arguments.reply_to ?? call.arguments.replyTo ?? call.arguments.quote;
    const replyTo = replyRaw !== undefined && replyRaw !== null ? String(replyRaw) : undefined;
    // 引用回复默认自动 @ 原发送人（模拟 QQ 客户端），Bot 显式给 at_sender: false 时去掉
    const atRaw = call.arguments.at_sender ?? call.arguments.atSender ?? call.arguments.at;
    const atSender = !(atRaw === false || atRaw === "false" || atRaw === 0);
    if (!id || (!msg && !media.length)) {
      this.pushEvent("system", "（send 需要 id 和 msg（或 media）参数。）", { ref: call.id });
      return;
    }
    // 超长消息拦截：真人聊天单条消息很短；确需发长文时要求二次确认
    const longLimit = this.config.messaging.longMessageChars;
    if (longLimit > 0 && msg.length > longLimit && !isTruthy(call.arguments.confirm_long)) {
      this.pushEvent(
        "system",
        `（这条消息长达 ${msg.length} 字，没有发出。日常聊天中一条消息一般只有十来个字，` +
          `太长会显得不像真人——建议精简，或拆成几条短消息分开发。` +
          `如果你确实要一次性发送长内容（如资料、长文），请在参数里加上 confirm_long: true 再发一次。）`,
        { ref: call.id },
      );
      return;
    }
    // 拦截与上一条完全相同的发送（模型常见的复读行为），除非显式声明 resend
    const sig = JSON.stringify([id, msg, media.map(String), replyTo ?? "", atSender]);
    if (sig === this.lastSendSig && !isTruthy(call.arguments.resend)) {
      this.pushEvent(
        "system",
        `（你刚刚已经向 ${id} 发过一模一样的消息了，这次没有发出——请不要复读。` +
          `如果你确定要把相同的内容再发一遍，请在参数里加上 resend: true。）`,
        { ref: call.id },
      );
      return;
    }
    this.lastSendSig = sig;
    this.ackStart(call);
    this.scheduler.schedule(call, {
      executeAt: "expected", // 打字完成的那一刻消息才真正发出（此前可 cancel）
      run: async () => this.messenger.send(id, msg, media, replyTo, atSender),
    });
  }

  private dispatchSendFile(call: ToolCallRecord): void {
    const id = String(call.arguments.id ?? "");
    const file = String(call.arguments.file ?? call.arguments.ref ?? "");
    if (!id || !file) {
      this.pushEvent("system", "（send_file 需要 id 和 file 参数。）", { ref: call.id });
      return;
    }
    this.ackStart(call);
    this.scheduler.schedule(call, {
      executeAt: "expected",
      run: async () => this.messenger.sendFile(id, file),
    });
  }

  private dispatchSendVoice(call: ToolCallRecord): void {
    const id = String(call.arguments.id ?? "");
    const text = String(call.arguments.text ?? call.arguments.msg ?? "");
    if (!id || !text) {
      this.pushEvent("system", "（send_voice 需要 id 和 text 参数。）", { ref: call.id });
      return;
    }
    this.ackStart(call);
    this.scheduler.schedule(call, {
      executeAt: "expected", // 说完的那一刻语音才发出（此前可 cancel）
      run: async () => this.messenger.sendVoice(id, text),
    });
  }

  private dispatchCancel(call: ToolCallRecord): void {
    const target = String(call.arguments.id ?? call.arguments.toolcall_id ?? "");
    const result = this.scheduler.cancel(target);
    // 撤回成功后，重发相同内容是合理操作，不应再被重复拦截
    if (result === "cancelled") this.lastSendSig = null;
    const text =
      result === "cancelled"
        ? `你及时停下了 ${target}。`
        : result === "not_found"
          ? `（找不到进行中的 ${target}，它可能已经完成了。）`
          : `（来不及了，${target} 已经完成。）`;
    this.pushEvent("system", text, { ref: call.id });
  }

  private async dispatchIdentityRecall(call: ToolCallRecord): Promise<void> {
    // await 读取，保证事件在下一次生成前就进入邮箱（否则 Bot 可能因看不到结果而重复调用）
    const persona = await this.files.readBotStatus();
    this.pushEvent(
      "system",
      `你静下心来，回想起自己是谁——\n${persona.trim() || "（角色设定文件为空）"}`,
      { ref: call.id },
    );
  }

  /**
   * check_status：默认只返回自上次查看以来的变化（状态文件很少变，反复全文返回会撑爆上下文）。
   * full: true 时返回全文；首次查看（本次运行内没有基准快照）也返回全文。
   */
  private async readStatus(call: ToolCallRecord): Promise<string> {
    const target = String(call.arguments.target ?? "self") === "world" ? "world" : "self";
    const full = isTruthy(call.arguments.full);

    const status = target === "world" ? await this.files.readWorldStatus() : await this.files.readBotStatus();
    const prev = this.lastStatus.get(target);
    this.lastStatus.set(target, status);

    // 世界状态附带 News：增量模式只显示上次没看过的
    let newsText = "";
    let hasNewNews = false;
    if (target === "world") {
      const news = await this.files.readNews(5);
      const fresh =
        full || prev === undefined || this.lastNewsT === null
          ? news
          : news.filter((e) => e.t > this.lastNewsT!);
      hasNewNews = !full && prev !== undefined && fresh.length > 0;
      if (news.length) this.lastNewsT = Math.max(...news.map((e) => e.t));
      if (fresh.length) {
        const label = hasNewNews ? "新发生的事" : "最近发生的事";
        newsText = `\n\n${label}：\n` + fresh.map((e) => `- [${e.clock}] ${e.content}`).join("\n");
      }
    }

    // 全文模式（显式要求，或首次查看没有基准）
    if (full || prev === undefined) {
      return target === "world"
        ? `你环顾四周，感知这个世界的状态——\n${status.trim() || "（未知）"}${newsText}`
        : `你审视自己的状态——\n${status.trim() || "（未知）"}\n\n当前 ${this.clock.timeLine()}`;
    }

    // 增量模式：只返回与上次查看相比的变化
    const diff = diffLines(prev, status);
    const noChange = diff === null && !hasNewNews;
    if (noChange) {
      return target === "world"
        ? `你环顾四周——世界和你上次查看时没有任何变化，也没有新的事件。` +
            `（状态不会频繁变化，不必反复 check_status；需要重看全文可加 full: true，或者用 wait 等世界自己发生变化。）`
        : `你审视了一下自己——和上次查看时没什么两样。当前 ${this.clock.timeLine()}\n` +
            `（状态不会频繁变化，不必反复 check_status；需要重看全文可加 full: true。）`;
    }
    const diffText = diff !== null ? `\n（+ 新增/变化，- 不再如此）\n${diff}` : "（状态本身没有变化）";
    return target === "world"
      ? `你环顾四周，注意到与上次查看相比的变化——${diffText}${newsText}`
      : `你审视自己的状态，注意到与上次查看相比的变化——${diffText}\n\n当前 ${this.clock.timeLine()}`;
  }

  // ---------- rest：上下文压缩 ----------

  /**
   * 休息：由 World-LLM 压缩总结上下文，刷新置顶区，重建（text 模式预热）KV cache。
   * forced = 上下文满时的强制休息，带世界观内的合理解释。
   */
  private async doRest(call: ToolCallRecord | null, forced: boolean): Promise<void> {
    if (forced) {
      this.pushEvent(
        "system",
        "一阵强烈的疲惫感袭来——你经历了太多事，思绪已经不堪重负，撑不住地闭上了眼睛……",
      );
    }
    await this.drainMailbox();

    const startReal = Date.now();
    this.logger.info("开始休息（%s），压缩上下文：%d 条记录，约 %d 字符", forced ? "强制" : "主动", this.context.stream.length, this.context.approxChars());

    // 压缩失败绝不能让上下文原样保留：否则强制 rest 会立即再次触发，陷入死循环。
    // World-LLM 不可用时降级：直接归档丢弃工作窗口，沿用旧摘要并注明记忆模糊。
    let result: CompressionResult;
    try {
      result = await this.world.compress({
        persona: this.context.pinned.persona,
        historySummary: this.context.pinned.historySummary,
        memoryDigest: this.context.pinned.memoryDigest,
        streamText: this.context.serializeForCompression(),
        timeLine: this.clock.timeLine(),
      });
    } catch (err) {
      this.logger.warn("上下文压缩失败，降级处理（丢弃工作窗口，沿用旧摘要）: %s", err);
      const note = "（注：最近一段经历未能沉淀为记忆，这部分显得有些模糊。）";
      const oldSummary = this.context.pinned.historySummary;
      result = {
        historySummary: oldSummary.includes(note) ? oldSummary : `${oldSummary}\n${note}`.slice(0, 4000),
        memoryDigest: this.context.pinned.memoryDigest,
      };
    }
    if (result.botStatus) await this.files.writeBotStatus(result.botStatus);
    await this.context.applyCompression(result, this.clock.now());

    // 若 Bot 指定了休息时长，且压缩很快完成，则继续睡满（现实时间流逝 = 世界时间流逝）
    const desired = call ? Number(call.arguments.duration ?? call.duration ?? 0) : 0;
    const compressTU = (Date.now() - startReal) / 1000 / this.config.clock.realSecondsPerUnit;
    if (Number.isFinite(desired) && desired > compressTU) {
      const remainMs = (desired - compressTU) * this.config.clock.realSecondsPerUnit * 1000;
      await sleep(Math.min(remainMs, 6 * 3600 * 1000));
    }
    if (!this.running) return;

    // 醒来时刻更新为当前时间（这是 system 段时间唯一的合法更新时机——
    // 压缩后前缀本来就要重建，此时更新不损失缓存）
    this.wakeTimeLine = this.clock.timeLine();

    // 预热 KV cache（text 模式）
    await this.backend.warmup?.(this.context, this.wakeTimeLine).catch(() => {});

    const elapsedTU = (Date.now() - startReal) / 1000 / this.config.clock.realSecondsPerUnit;
    this.pushEvent(
      "system",
      `你睡了一觉，过去了 ${elapsedTU.toFixed(1)} 个 TU。醒来时头脑清明，近来的经历沉淀成了记忆。当前 ${this.clock.timeLine()}`,
      { ref: call?.id },
    );
    this.logger.info("休息结束，耗时 %s 秒，新上下文约 %d 字符", ((Date.now() - startReal) / 1000).toFixed(1), this.context.approxChars());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\n/g, "\\n");
  return single.length > max ? single.slice(0, max) + "…" : single;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 宽松解析布尔参数（模型可能输出 true / "true" / 1） */
function isTruthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

/**
 * 状态文件的行级 diff：返回新增/变化（+）与不再存在（-）的行；完全相同返回 null。
 * 只做逐行集合比较（行的移动会被视为无变化），对 Markdown 状态文件足够用。
 */
export function diffLines(oldText: string, newText: string): string | null {
  if (oldText === newText) return null;
  const clean = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const oldLines = clean(oldText);
  const newLines = clean(newText);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => !oldSet.has(l));
  const removed = oldLines.filter((l) => !newSet.has(l));
  if (!added.length && !removed.length) return null;
  return [...added.map((l) => `+ ${l}`), ...removed.map((l) => `- ${l}`)].join("\n");
}
