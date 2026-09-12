/**
 * 穿越服务（主世界侧）：接待异世界访客的 HTTP + SSE 服务器。
 *
 * - 邀请码鉴权（crossing.invites，可随时吊销）；
 * - 访客到达/离开由本世界的 World-LLM 叙述并记录进 World_Status；
 * - 访客的 act 裁定 / wait 补叙 / 查看时间 / 世界查询由本世界的 World-LLM 处理，
 *   结果经 SSE 回传（task_result）；世界也可主动向访客广播事件（send_event to=访客名）。
 * - 零依赖（node:http），风格与 webui/server.ts 一致。
 *
 * 安全：网络上只有任务与事件文本；本服务不暴露任何 LLM API 地址/密钥，
 * 也不暴露世界文件——访客能"看到"的一切都经由 World-LLM 生成。
 */

import crypto from "node:crypto";
import http from "node:http";
import type { Logger } from "koishi";
import type { CrossingConfig } from "../config.js";
import type { WorldClock } from "../clock.js";
import type { WorldAgent } from "../world/agent.js";
import { debug } from "../webui/debug.js";
import {
  CROSSING_LIMITS,
  type CrossingSseMsg,
  type CrossingTaskKind,
  type CrossingTaskPayload,
  type PlayerMode,
  type VisitorInfo,
} from "./protocol.js";

/** 访客 SSE 断线后保留会话的时长：超时视为失联，自动按离开处理 */
const ABSENCE_MS = 180_000;
/** SSE 心跳间隔 */
const HEARTBEAT_MS = 20_000;

/** 真人玩家到达时告知常驻 Bot 的语义说明（按进入语义区分） */
function playerArriveNotice(name: string, mode: PlayerMode): string {
  switch (mode) {
    case "avatar":
      return `一位真人玩家以角色「${name}」的身份进入了这个世界——他要**扮演**这位角色（入替，完全接管其言行）。`;
    case "puppet":
      return `一位真人玩家以角色「${name}」的身份进入了这个世界——他要**操纵**这位角色的身体行动，但该角色仍保有自己的意识（身体可能不听使唤、有内心活动）。`;
    default:
      return `一位真人玩家以角色「${name}」的身份进入了这个世界（从外界穿越降临）。`;
  }
}

/** 真人玩家离开时告知常驻 Bot 的语义说明（按进入语义 + 离场原因区分） */
function playerLeaveNotice(name: string, mode: PlayerMode, cause: "returned" | "lost"): string {
  const gone = cause === "lost";
  const how = gone ? "与这个世界的联系突然断开（失联）" : "";
  switch (mode) {
    case "avatar":
      return gone
        ? `真人玩家扮演的角色「${name}」${how}——玩家不再操控，这个角色已归还给世界，之后可继续演化其后续。`
        : `真人玩家扮演的角色「${name}」停止了扮演——这个角色仍在世界，之后由世界继续演化它的后续行动与决策。`;
    case "puppet":
      return gone
        ? `真人玩家操纵的角色「${name}」${how}——操纵中断，这个角色恢复了自主意识，之后由世界继续演化。`
        : `真人玩家对角色「${name}」放开了操纵——它挣脱束缚、恢复自主意识，之后由世界继续演化。`;
    default:
      return gone
        ? `异世界的访客「${name}」${how}，身影消散了。`
        : `异世界的访客「${name}」回自己的世界去了。`;
  }
}

interface VisitorSession extends VisitorInfo {
  token: string;
  res: http.ServerResponse | null;
  /** SSE 未连接期间的暂存消息（重连后补发） */
  outbox: CrossingSseMsg[];
  pendingTasks: number;
  absenceTimer: NodeJS.Timeout | null;
  arrivedAt: number;
  /** World-LLM 写回的访客状态（同步会话内的 persona，并经 SSE 回传访客世界） */
  updateStatus: (content: string) => void;
  /** 真人玩家（同部署 WebUI 驾驶舱）：World 裁定过程实时推送 event（流式剧情），而非聚合到 task_result */
  live: boolean;
  /** 管理员操控现有常驻 Bot 的控制通道，不在世界中创建第二个角色。 */
  residentControl: boolean;
  ready: Promise<boolean>;
  arrivalAbort: AbortController;
  closed: boolean;
  tasks: Map<string, SessionTask>;
  cancelledTaskIds: Set<string>;
}

interface SessionTask {
  fingerprint: string;
  abort: AbortController;
  promise?: Promise<void>;
  result?: Extract<CrossingSseMsg, { type: "task_result" }>;
}

export interface CrossingServerHost {
  cfg: CrossingConfig;
  logger: Logger;
  world: WorldAgent;
  clock: () => WorldClock | null;
  /** 世界是否在运行（未运行时拒绝到达） */
  ready: () => boolean;
  /** 向本世界的常驻 Bot 注入事件（访客到达/离开的感知） */
  notifyHostBot: (content: string) => void;
  /** 常驻角色会话结束（包括断线超时）后释放角色控制，等待已提交回执。 */
  releaseResidentControl?: (sessionId: string, cause: "returned" | "lost") => Promise<void>;
}

export class CrossingServer {
  private server: http.Server | null = null;
  private sessions = new Map<string, VisitorSession>(); // token → session
  private heartbeat: NodeJS.Timeout | null = null;
  /** 包含已从 sessions 移除、但仍在旧世界完成任务/离场的会话。 */
  private pendingCleanups = new Set<Promise<void>>();
  private disconnecting: Promise<void> | null = null;
  private stopping = false;

  constructor(private host: CrossingServerHost) {}

  get worldName(): string {
    return this.host.cfg.worldName.trim() || "未命名世界";
  }

  /** 当前世界观时间戳（`T=12.5（世界时间 ...）`）；World 未运行则为空串 */
  private worldTimeLine(): string {
    return this.host.clock()?.timeLine() ?? "";
  }

  private timeUnits(): { unitWorldSeconds: number; unitRealSeconds: number } {
    const clock = this.host.clock();
    return { unitWorldSeconds: clock?.unitWorldSeconds ?? 1, unitRealSeconds: clock?.unitRealSeconds ?? 1 };
  }

  /** 推一条剧情事件给访客，附带当前世界观时间戳 */
  private pushEvent(session: VisitorSession, content: string): void {
    this.push(session, { type: "event", content, timeLine: this.worldTimeLine() });
  }

  /**
   * 当前在场访客的完整通道（按到达顺序，逐字稳定）：
   * 状态档案进 World-LLM 系统提示的 <visitors> 区、send_event to= 定向投递、
   * update_visitor_status 状态写回。
   */
  visitors(): { id: string; name: string; persona: string; mode: PlayerMode; deliver: (content: string) => void; updateStatus: (content: string) => void; expel: (reason: string) => void }[] {
    return [...this.sessions.values()].filter((s) => !s.residentControl).map((s) => ({
      id: s.id,
      name: s.name,
      persona: s.persona,
      mode: s.mode ?? "cross",
      deliver: (content: string) => this.pushEvent(s, content),
      updateStatus: s.updateStatus,
      expel: (reason: string) => this.expelVisitor(s.name, reason),
    }));
  }

  /**
   * 强行驱逐一位在场访客（World-LLM 在演化中判定该角色死亡/消散/升天等，
   * 不应再有任何可能主动互动）。与主动离开不同：直接关闭会话、切断后续任务通道，
   * **不**触发 visitorLeave 的"离开善后"叙事——死亡结局由 World 自己写进 world_status。
   */
  expelVisitor(name: string, reason: string): void {
    const session = [...this.sessions.values()].find((s) => s.name === name);
    if (!session) return;
    this.sessions.delete(session.token);
    this.push(session, { type: "farewell", reason: reason || "你已被这个世界排除，无法再主动互动。" });
    this.closeSession(session);
    this.host.logger.info("[穿越] 访客「%s」被世界驱逐（%s）", name, reason || "未说明原因");
    debug.emit("world.task", `穿越·访客「${name}」被驱逐`, { reason });
    this.host.notifyHostBot(`${name ? `「${name}」` : "一位访客"}已被这个世界排除（${reason || "死亡/消散/升天等"}），不再在场。`);
    // 清掉它尚未开始执行的 act/wait，避免"已死角色"的旧行动照常演出来
    this.host.world.cancelPending("visitor:" + session.id);
    this.trackCleanup(session, false);
    // 最后一位访客离场且常驻 Bot 在外：世界重新进入沉睡
    if (this.sessions.size === 0) this.host.world.notePresenceChange();
  }

  visitorList(): { name: string; arrivedAt: number }[] {
    return [...this.sessions.values()].filter((s) => !s.residentControl).map((s) => ({ name: s.name, arrivedAt: s.arrivedAt }));
  }

  /** 只查询仍有效的接管会话；过期 token 不得交还后来建立的设备控制。 */
  playerControlsBot(token: string): boolean { return this.residentSession(token) !== null; }

  residentSession(token: string): { id: string; name: string; mode: "avatar" | "puppet" } | null {
    const session = this.sessions.get(token);
    if (!session?.residentControl || session.closed || (session.mode !== "avatar" && session.mode !== "puppet")) return null;
    return { id: session.id, name: session.name, mode: session.mode };
  }

  /**
   * 同部署真人玩家到达（供 WebUI 内部调用，不走 HTTP / 不校验邀请码——玩家已通过 WebUI 登录鉴权）。
   * 其余与 handleArrive 一致：创建会话、同名顶替、触发到达叙事、通知常驻 Bot。
   */
  arrivePlayer(name: string, persona: string, mode: PlayerMode = "cross"): { ok: true; token: string; worldName: string; timeLine: string } | { ok: false; error: string } {
    if (!this.accepting()) return { ok: false, error: "这个世界当前未在运行或正在关闭会话，无法接待访客" };
    if (this.sessions.size >= Math.max(1, this.host.cfg.maxVisitors)) {
      return { ok: false, error: "这个世界的访客已满，稍后再来" };
    }
    const safeName = name.trim().slice(0, CROSSING_LIMITS.maxNameChars) || "异界来客";
    const safePersona = persona.slice(0, CROSSING_LIMITS.maxPersonaChars);
    const safeMode: PlayerMode = mode === "avatar" || mode === "puppet" ? mode : "cross";
    const residentControl = safeMode !== "cross" && safeName === this.host.world.residentBotName;
    if (safeMode !== "cross" && !residentControl) {
      return { ok: false, error: "目前只支持穿越独立角色；已有 NPC 的扮演/操纵尚未实现实体授权绑定。管理员仍可同名接管常驻 Bot。" };
    }
    const dupe = [...this.sessions.values()].find((s) => s.name === safeName);
    if (dupe) {
      return { ok: false, error: `已有同名访客「${safeName}」在场` };
    }
    const session: VisitorSession = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString("base64url"),
      name: safeName,
      persona: safePersona,
      mode: safeMode,
      res: null,
      outbox: [],
      pendingTasks: 0,
      absenceTimer: null,
      arrivedAt: Date.now(),
      live: true,
      residentControl,
      ready: Promise.resolve(false),
      arrivalAbort: new AbortController(),
      closed: false,
      tasks: new Map(),
      cancelledTaskIds: new Set(),
      updateStatus: (content: string) => {
        session.persona = content.slice(0, CROSSING_LIMITS.maxPersonaChars);
        this.push(session, { type: "status_update", content });
      },
    };
    this.sessions.set(session.token, session);
    this.armAbsence(session);
    const timeLine = this.host.clock()?.timeLine() ?? "";
    this.host.logger.info("[穿越] 玩家「%s」入世界", safeName);
    debug.emit("world.task", `穿越·玩家「${safeName}」入世界`, {});
    if (!residentControl) this.host.notifyHostBot(playerArriveNotice(safeName, safeMode));
    session.ready = this.initializeSession(session);
    return { ok: true, token: session.token, worldName: this.worldName, timeLine };
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.stopping = false;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        try {
          if (!res.headersSent) sendJSON(res, 500, { error: String((err as Error).message ?? err) });
          else res.end();
        } catch {
          /* ignore */
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once("error", onError);
      this.server!.listen(this.host.cfg.port, this.host.cfg.host, () => {
        this.server!.removeListener("error", onError);
        resolve();
      });
    });
    this.heartbeat = setInterval(() => {
      for (const s of this.sessions.values()) {
        try {
          s.res?.write(": ping\n\n");
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
    // 让本世界的 World-LLM 在 Tingle 时感知在场访客并能向他们广播事件
    this.host.world.setVisitorsProvider(() => this.visitors());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.disconnectVisitors("主世界的穿越服务关闭了");
    this.host.world.setVisitorsProvider(null);
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** 等待所有旧世界工作收尾；保留监听器，供暂停后恢复/切换存档继续使用。 */
  disconnectVisitors(reason: string): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    const drain = Promise.resolve().then(async () => {
      for (const session of [...this.sessions.values()]) {
        this.push(session, { type: "farewell", reason });
        this.depart(session, "lost");
      }
      // depart/expel 在移除 token 后仍保留清理屏障，不能只检查 sessions.size。
      await Promise.all([...this.pendingCleanups]);
    });
    this.disconnecting = drain;
    // 失败时保持拒绝接待；调用方不得继续切换到新世界。
    void drain.then(() => { if (this.disconnecting === drain) this.disconnecting = null; }, () => {});
    return drain;
  }

  private accepting(): boolean {
    return !this.stopping && !this.disconnecting && this.host.ready();
  }

  // ---------- HTTP ----------

  /**
   * 提取 API 端点名：按**路径后缀**匹配，容忍反向代理加的任意前缀
   * （如 nginx `location /world/ { proxy_pass http://…:18112; }` 未加尾斜杠时，
   * 上游收到的是 /world/crossing/arrive）。
   */
  private endpointOf(pathname: string): string | null {
    const m = pathname.match(/(?:^|\/)crossing\/(arrive|events|task|cancel|leave|ping)\/?$/);
    return m ? m[1]! : null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    const ep = this.endpointOf(url.pathname);

    if (ep === "arrive" && method === "POST") return this.handleArrive(req, res);
    if (ep === "events" && method === "GET") return this.handleEvents(url, req, res);
    if (ep === "task" && method === "POST") return this.handleTask(req, res);
    if (ep === "cancel" && method === "POST") return this.handleCancel(req, res);
    if (ep === "leave" && method === "POST") return this.handleLeave(req, res);
    if (ep === "ping" && method === "GET") {
      return void sendJSON(res, 200, {
        ok: true,
        service: "yesimbot-world-crossing",
        worldName: this.worldName,
        accepting: this.accepting(),
        ...this.timeUnits(),
      });
    }
    // 其余 GET 请求（浏览器直接访问任意路径）：引导页——检验网络联通 + 指引对方配置
    if (method === "GET" || method === "HEAD") {
      const html = this.guidePage();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(method === "HEAD" ? undefined : html);
      return;
    }
    sendJSON(res, 404, { error: "Not Found" });
  }

  private async handleArrive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJSON(req);
    const code = String(body.code ?? "").trim();
    const invite = this.host.cfg.invites.find((i) => i.enabled && i.code && i.code === code);
    if (!invite) return void sendJSON(res, 403, { error: "邀请码无效或已被吊销" });
    if (body.mode != null && body.mode !== "cross") return void sendJSON(res, 400, { error: "跨部署访客目前只支持 cross，已有角色的控制权转移尚未实现" });
    if (!this.accepting()) return void sendJSON(res, 503, { error: "这个世界当前未在运行或正在关闭会话，无法接待访客" });
    if (this.sessions.size >= Math.max(1, this.host.cfg.maxVisitors)) {
      return void sendJSON(res, 429, { error: "这个世界的访客已满，稍后再来" });
    }
    const name = String(body.name ?? "").trim().slice(0, CROSSING_LIMITS.maxNameChars) || "异界来客";
    const dupe = [...this.sessions.values()].find((s) => s.name === name);
    if (dupe) {
      // 名字不是认证凭据，断线不能允许另一客户端顶替原会话。
      return void sendJSON(res, 409, { error: `已有同名访客「${name}」在场，请用原会话令牌重连或等待其离开` });
    }
    const persona = String(body.persona ?? "").slice(0, CROSSING_LIMITS.maxPersonaChars);
    const session: VisitorSession = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString("base64url"),
      name,
      persona,
      mode: "cross",
      res: null,
      outbox: [],
      pendingTasks: 0,
      absenceTimer: null,
      arrivedAt: Date.now(),
      live: false,
      residentControl: false,
      ready: Promise.resolve(false),
      arrivalAbort: new AbortController(),
      closed: false,
      tasks: new Map(),
      cancelledTaskIds: new Set(),
      updateStatus: (content: string) => {
        // 同步会话内 persona（后续任务的前言用最新状态）并回传访客世界持久化
        session.persona = content.slice(0, CROSSING_LIMITS.maxPersonaChars);
        this.push(session, { type: "status_update", content });
      },
    };
    this.sessions.set(session.token, session);
    this.armAbsence(session);
    const timeLine = this.host.clock()?.timeLine() ?? "";
    sendJSON(res, 200, { ok: true, token: session.token, visitorId: session.id, worldName: this.worldName, timeLine, ...this.timeUnits(), protocolVersion: 2 });
    this.host.logger.info("[穿越] 访客「%s」到达（邀请码备注：%s）", name, invite.name || "未备注");
    debug.emit("world.task", `穿越·访客「${name}」到达`, { invite: invite.name });

    // 到达叙事（异步）：World-LLM 生成到达场景、记录访客在场；主世界 Bot 同步感知。
    // 世界若在沉睡（常驻 Bot 外出、此前无访客），先补叙沉睡期间的演化再接待
    // （两个任务同步入队，串行队列保证先后顺序）
    this.host.notifyHostBot(`一位异世界的访客「${name}」穿越降临到了这个世界。`);
    session.ready = this.initializeSession(session);
  }

  private async initializeSession(session: VisitorSession): Promise<boolean> {
    try {
      if (session.residentControl) {
        this.pushEvent(session, "常驻角色控制通道已连接。请通过驾驶舱 observe 查看角色实际可感知的内容；观察与结果会进入角色的经历。");
        return !session.closed;
      }
      await this.host.world.wakeDormant();
      if (session.closed) return false;
      return await this.host.world.visitorArrive(session, (content) => {
        if (!session.closed) this.pushEvent(session, content);
      }, session.arrivalAbort.signal);
    } catch (err) {
      this.host.logger.warn("[穿越] 到达初始化失败: %s", err);
      return false;
    }
  }

  private handleEvents(url: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this.sessions.get(String(url.searchParams.get("token") ?? ""));
    if (!session) return void sendJSON(res, 403, { error: "会话不存在或已结束" });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // 顶掉旧连接（重连场景）
    try {
      session.res?.end();
    } catch {
      /* ignore */
    }
    session.res = res;
    if (session.absenceTimer) clearTimeout(session.absenceTimer);
    session.absenceTimer = null;
    const timeLine = this.host.clock()?.timeLine() ?? "";
    res.write(sseFrame({ type: "hello", worldName: this.worldName, timeLine, visitorId: session.id, ...this.timeUnits() }));
    // 补发离线期间暂存的消息
    for (const msg of session.outbox.splice(0)) res.write(sseFrame(msg));
    req.on("close", () => {
      if (session.res === res) {
        session.res = null;
        this.armAbsence(session);
      }
    });
  }

  private async handleTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJSON(req);
    const session = this.sessions.get(String(body.token ?? ""));
    if (!session || session.closed) return void sendJSON(res, 403, { error: "会话不存在或已结束" });
    const taskId = String(body.taskId ?? "");
    const kind = String(body.kind ?? "") as CrossingTaskKind;
    if (!taskId || taskId.length > 64 || !["act", "wait", "checkTime", "query", "observe"].includes(kind)) {
      return void sendJSON(res, 400, { error: "taskId / kind 无效" });
    }
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return void sendJSON(res, 400, { error: "payload 必须是对象" });
    }
    const payload = body.payload as CrossingTaskPayload;
    try {
      if (kind === "act") this.taskDuration(payload.durationWorldSeconds, payload.duration);
      if (kind === "wait") this.taskDuration(payload.waitWorldSeconds, payload.n);
    } catch (err) { return void sendJSON(res, 400, { error: String(err) }); }
    if (session.cancelledTaskIds.has(taskId)) return void sendJSON(res, 409, { error: "该 taskId 已在接收前取消" });
    const fingerprint = JSON.stringify([kind, Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)))]);
    const existing = session.tasks.get(taskId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return void sendJSON(res, 409, { error: "同一 taskId 不得提交不同任务" });
      sendJSON(res, 200, { ok: true, duplicate: true, ...this.timeUnits() });
      if (existing.result) this.push(session, existing.result);
      return;
    }
    if (session.pendingTasks >= CROSSING_LIMITS.maxPendingTasks) {
      return void sendJSON(res, 429, { error: "待处理任务过多，稍后再试" });
    }
    // 保留已完成 id，防止迟到重试重复执行。满额后要求建立新会话，而非丢掉去重记录。
    if (session.tasks.size + session.cancelledTaskIds.size >= 4096) return void sendJSON(res, 429, { error: "会话任务记录已满，请离开后重新进入" });
    const task: SessionTask = { fingerprint, abort: new AbortController() };
    session.tasks.set(taskId, task);
    session.pendingTasks++;
    sendJSON(res, 200, { ok: true, ...this.timeUnits() });
    task.promise = this.runTask(session, taskId, kind, payload, task)
      .catch((err) => {
        this.host.logger.warn("[穿越] 访客「%s」任务 %s 失败: %s", session.name, kind, err);
        task.result = { type: "task_result", taskId, ok: false, content: task.abort.signal.aborted ? "取消请求已处理；已提交的变更不会回滚，请重新观察确认状态。" : "主世界任务失败。" };
        if (!session.closed) this.push(session, task.result);
      })
      .finally(() => { session.pendingTasks--; });
  }

  /** 新协议用世界秒，旧 duration/n 明确按主世界 TU 解读。 */
  private taskDuration(worldSeconds: unknown, legacyUnits: unknown): number {
    const value = Number(worldSeconds ?? legacyUnits ?? 0);
    if (!Number.isFinite(value) || value < 0) throw new Error("时长必须为有限非负数");
    return worldSeconds != null ? value / this.timeUnits().unitWorldSeconds : value;
  }

  private async handleCancel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJSON(req);
    const session = this.sessions.get(String(body.token ?? ""));
    if (!session) return void sendJSON(res, 403, { error: "会话不存在或已结束" });
    const taskId = String(body.taskId ?? "");
    if (!taskId || taskId.length > 64) return void sendJSON(res, 400, { error: "taskId 无效" });
    const task = session.tasks.get(taskId);
    if (!task) {
      if (session.tasks.size + session.cancelledTaskIds.size >= 4096) return void sendJSON(res, 429, { error: "会话任务记录已满" });
      // cancel 可能比 task 请求先到；保留墓碑阻止稍后到达的任务执行。
      session.cancelledTaskIds.add(taskId);
      return void sendJSON(res, 200, { ok: true, status: "cancellation_requested" });
    }
    if (task.result) return void sendJSON(res, 200, { ok: false, status: "too_late", result: task.result });
    task.abort.abort();
    // 请求中止不等于回滚已提交状态；客户端必须以最终 task_result 为准。
    sendJSON(res, 200, { ok: true, status: "cancellation_requested" });
  }

  private async runTask(
    session: VisitorSession,
    taskId: string,
    kind: CrossingTaskKind,
    payload: CrossingTaskPayload,
    task: SessionTask,
  ): Promise<void> {
    if (!await session.ready) throw new Error("访客到达初始化尚未成功");
    task.abort.signal.throwIfAborted();
    if (session.closed) throw new Error("访客已离开");
    const clip = (s: unknown) => String(s ?? "").slice(0, CROSSING_LIMITS.maxTaskChars);
    const parts: string[] = [];
    const deliver = (content: string) => {
      parts.push(content);
      if (session.live && !session.closed) this.pushEvent(session, content);
    };
    let ok = false;
    if (session.residentControl) throw new Error("常驻角色的能力与观察请通过已授权的驾驶舱工具调用");
    if (kind === "act") {
      ok = await this.host.world.visitorAct(session, clip(payload.desc), this.taskDuration(payload.durationWorldSeconds, payload.duration), deliver, task.abort.signal, taskId, {
        ...(payload.speech ? { speech: clip(payload.speech) } : {}),
        ...(payload.target ? { target: clip(payload.target) } : {}),
        ...(payload.observationId ? { observationId: clip(payload.observationId) } : {}),
      });
    } else if (kind === "wait") {
      ok = await this.host.world.visitorWait(session, this.taskDuration(payload.waitWorldSeconds, payload.n), deliver, task.abort.signal, taskId);
    } else if (kind === "checkTime") {
      ok = await this.host.world.visitorCheckTime(session, deliver);
    } else if (kind === "observe") {
      const observation = await this.host.world.structured.observe("visitor:" + session.id, {
        ...(payload.target ? { target: clip(payload.target) } : {}),
        ...(payload.modality ? { modality: clip(payload.modality) } : {}),
      });
      parts.push(JSON.stringify(observation));
      ok = true;
    } else {
      parts.push(await this.host.world.visitorQuery(session, clip(payload.task)));
      ok = true;
    }
    task.result = { type: "task_result", taskId, ok, content: parts.join("\n") };
    if (!session.closed) this.push(session, task.result);
  }

  private async handleLeave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJSON(req);
    const session = this.sessions.get(String(body.token ?? ""));
    if (!session) return void sendJSON(res, 200, { ok: true });
    sendJSON(res, 200, { ok: true });
    this.depart(session, "returned");
  }

  // ---------- 会话管理 ----------

  /** 访客离场（主动离开 / 失联超时）：清理会话 + World-LLM 善后 + 通知主世界 Bot */
  private depart(session: VisitorSession, cause: "returned" | "lost"): void {
    if (!this.sessions.delete(session.token)) return;
    this.closeSession(session);
    this.host.logger.info("[穿越] 访客「%s」离开（%s，mode=%s）", session.name, cause, session.mode ?? "cross");
    debug.emit("world.task", `穿越·访客「${session.name}」离开`, { cause, mode: session.mode ?? "cross" });
    if (!session.residentControl) this.host.notifyHostBot(playerLeaveNotice(session.name, session.mode ?? "cross", cause));
    // 先清掉该玩家尚未开始执行的 act/wait（避免它离开后，队列里的旧行动还照常演一遍）
    if (!session.residentControl) {
      this.host.world.cancelPending("visitor:" + session.id);
    }
    this.trackCleanup(session, !session.residentControl, cause);
    // 最后一位访客离开且常驻 Bot 也在外：世界重新进入沉睡
    if (this.sessions.size === 0) this.host.world.notePresenceChange();
  }

  private trackCleanup(session: VisitorSession, leave: boolean, cause: "returned" | "lost" = "lost"): void {
    const cleanup = (async () => {
      await session.ready;
      await Promise.all([...session.tasks.values()].map((task) => task.promise));
      if (leave) await this.host.world.visitorLeave(session);
      else if (session.residentControl) await this.host.releaseResidentControl?.(session.id, cause);
    })();
    this.pendingCleanups.add(cleanup);
    // 拒绝的清理保留在集合中，让后续 disconnect 明确失败，避免覆盖新世界。
    void cleanup.then(() => this.pendingCleanups.delete(cleanup), (err) => {
      this.host.logger.warn("[穿越] 离开善后失败: %s", err);
    });
  }

  private armAbsence(session: VisitorSession): void {
    if (session.closed) return;
    if (session.absenceTimer) clearTimeout(session.absenceTimer);
    session.absenceTimer = setTimeout(() => this.depart(session, "lost"), ABSENCE_MS);
  }

  private push(session: VisitorSession, msg: CrossingSseMsg): void {
    if (session.res) {
      try {
        session.res.write(sseFrame(msg));
        return;
      } catch {
        session.res = null;
      }
    }
    session.outbox.push(msg);
    if (session.outbox.length > 100) session.outbox.splice(0, session.outbox.length - 100);
  }

  private closeSession(session: VisitorSession): void {
    session.closed = true;
    session.arrivalAbort.abort();
    for (const task of session.tasks.values()) if (!task.result) task.abort.abort();
    if (session.absenceTimer) clearTimeout(session.absenceTimer);
    session.absenceTimer = null;
    try {
      session.res?.end();
    } catch {
      /* ignore */
    }
    session.res = null;
  }

  /**
   * 浏览器引导页：能看到这个页面 = 网络已联通。
   * 指引访客的主人如何把这个世界加进自己的 crossing.worlds；
   * 页面内不含任何敏感信息（API 仍需邀请码）。
   */
  private guidePage(): string {
    const name = escapeHtml(this.worldName);
    const accepting = this.accepting();
    const visitors = this.sessions.size;
    const max = Math.max(1, this.host.cfg.maxVisitors);
    const statusText = accepting
      ? `开放中 · 访客 ${visitors}/${max}`
      : "世界当前未在运行（暂不接待，联通性不受影响）";
    const statusColor = accepting ? "#4ade80" : "#fbbf24";
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${name} · 穿越服务</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font:14px/1.7 -apple-system,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;color:#e4eaf4;
  background:radial-gradient(900px 480px at 85% -8%, rgba(138,123,255,.14), transparent 62%),
             radial-gradient(700px 420px at -8% 110%, rgba(110,231,255,.09), transparent 58%), #07090f}
.card{width:640px;max-width:100%;background:rgba(148,163,184,.06);border:1px solid rgba(148,163,184,.16);
  border-radius:18px;padding:28px 30px;box-shadow:0 24px 70px rgba(0,0,0,.45)}
h1{font-size:20px;margin:0 0 4px;letter-spacing:.3px}
.sub{color:#93a0b4;font-size:12.5px;margin:0 0 18px}
.ok{display:inline-flex;align-items:center;gap:8px;font-size:13px;padding:6px 14px;border-radius:999px;
  background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.4);color:#4ade80;margin-bottom:14px}
.ok:before{content:"";width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px rgba(74,222,128,.7)}
.kv{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dashed rgba(148,163,184,.14);font-size:13px}
.kv:last-of-type{border-bottom:none}
.kv .k{color:#93a0b4}
h2{font-size:14px;margin:22px 0 8px;color:#6ee7ff;letter-spacing:.5px}
ol{margin:0;padding-left:20px;color:#c5cfdd;font-size:13px}
ol li{margin-bottom:6px}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:rgba(148,163,184,.12);padding:1px 7px;border-radius:6px;word-break:break-all}
.urlbox{display:flex;gap:8px;align-items:center;margin:8px 0 2px}
.urlbox code{flex:1;padding:8px 12px;font-size:12.5px}
button{font:inherit;color:#e4eaf4;background:rgba(110,231,255,.14);border:1px solid rgba(110,231,255,.4);
  border-radius:9px;padding:6px 16px;cursor:pointer;font-size:12.5px}
button:hover{background:rgba(110,231,255,.22)}
.dim{color:#5b6678;font-size:11.5px;margin-top:18px}
</style>
</head>
<body>
<div class="card">
  <h1>「${name}」</h1>
  <p class="sub">YesImBot World · 穿越服务（联机）</p>
  <div class="ok">网络联通正常——你能看到这个页面，说明穿越服务可以从你的位置访问</div>
  <div class="kv"><span class="k">接待状态</span><span style="color:${statusColor}">${escapeHtml(statusText)}</span></div>
  <div class="kv"><span class="k">用途</span><span>持有邀请码的用户，其 Bot 可穿越到这个世界作客</span></div>
  <h2>如何让你的 Bot 来这个世界</h2>
  <ol>
    <li>向这个世界的主人索取<b>邀请码</b>；</li>
    <li>在你自己的 YesImBot World 插件<b>配置页面</b>里，找到 <code>crossing</code>（穿越 · 联机）配置组下的
      <code>worlds</code> 列表，添加一项：<code>name</code> 世界名随意（如「${name}」）、
      <code>url</code> 填下方地址、<code>inviteCode</code> 填对方给你的邀请码；</li>
    <li>保存配置后，在 WebUI「穿越」页把 Bot 送过来，或让它自己用 <code>travel</code> 工具前来。</li>
  </ol>
  <h2>要填写的服务地址</h2>
  <div class="urlbox"><code id="u">（正在读取…）</code><button onclick="copyUrl()">复制</button></div>
  <p class="dim">本页不包含任何敏感信息；所有穿越 API 均需邀请码。程序化联通检查：<code id="ping">…/crossing/ping</code></p>
</div>
<script>
var base = location.origin + location.pathname.replace(/\\/+$/, '').replace(/\\/crossing\\/(arrive|events|task|leave|ping)$/, '');
document.getElementById('u').textContent = base || location.origin;
document.getElementById('ping').textContent = (base || location.origin) + '/crossing/ping';
function copyUrl(){
  var t = document.getElementById('u').textContent;
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t); }
  else { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
}
</script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- 辅助 ----------

function sseFrame(msg: CrossingSseMsg): string {
  return `data: ${JSON.stringify(msg)}\n\n`;
}

function sendJSON(res: http.ServerResponse, status: number, obj: unknown): void {
  const data = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readJSON(req: http.IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
