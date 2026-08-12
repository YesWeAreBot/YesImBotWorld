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
  type VisitorInfo,
} from "./protocol.js";

/** 访客 SSE 断线后保留会话的时长：超时视为失联，自动按离开处理 */
const ABSENCE_MS = 180_000;
/** SSE 心跳间隔 */
const HEARTBEAT_MS = 20_000;

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
}

export class CrossingServer {
  private server: http.Server | null = null;
  private sessions = new Map<string, VisitorSession>(); // token → session
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private host: CrossingServerHost) {}

  get worldName(): string {
    return this.host.cfg.worldName.trim() || "未命名世界";
  }

  /**
   * 当前在场访客的完整通道（按到达顺序，逐字稳定）：
   * 状态档案进 World-LLM 系统提示的 <visitors> 区、send_event to= 定向投递、
   * update_visitor_status 状态写回。
   */
  visitors(): { name: string; persona: string; deliver: (content: string) => void; updateStatus: (content: string) => void }[] {
    return [...this.sessions.values()].map((s) => ({
      name: s.name,
      persona: s.persona,
      deliver: (content: string) => this.push(s, { type: "event", content }),
      updateStatus: s.updateStatus,
    }));
  }

  visitorList(): { name: string; arrivedAt: number }[] {
    return [...this.sessions.values()].map((s) => ({ name: s.name, arrivedAt: s.arrivedAt }));
  }

  async start(): Promise<void> {
    if (this.server) return;
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
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.host.world.setVisitorsProvider(null);
    for (const s of [...this.sessions.values()]) {
      this.push(s, { type: "farewell", reason: "主世界的穿越服务关闭了" });
      this.closeSession(s);
    }
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // ---------- HTTP ----------

  /**
   * 提取 API 端点名：按**路径后缀**匹配，容忍反向代理加的任意前缀
   * （如 nginx `location /world/ { proxy_pass http://…:18112; }` 未加尾斜杠时，
   * 上游收到的是 /world/crossing/arrive）。
   */
  private endpointOf(pathname: string): string | null {
    const m = pathname.match(/(?:^|\/)crossing\/(arrive|events|task|leave|ping)\/?$/);
    return m ? m[1]! : null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    const ep = this.endpointOf(url.pathname);

    if (ep === "arrive" && method === "POST") return this.handleArrive(req, res);
    if (ep === "events" && method === "GET") return this.handleEvents(url, req, res);
    if (ep === "task" && method === "POST") return this.handleTask(req, res);
    if (ep === "leave" && method === "POST") return this.handleLeave(req, res);
    if (ep === "ping" && method === "GET") {
      return void sendJSON(res, 200, {
        ok: true,
        service: "yesimbot-world-crossing",
        worldName: this.worldName,
        accepting: this.host.ready(),
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
    if (!this.host.ready()) return void sendJSON(res, 503, { error: "这个世界当前未在运行，无法接待访客" });
    if (this.sessions.size >= Math.max(1, this.host.cfg.maxVisitors)) {
      return void sendJSON(res, 429, { error: "这个世界的访客已满，稍后再来" });
    }
    const name = String(body.name ?? "").trim().slice(0, CROSSING_LIMITS.maxNameChars) || "异界来客";
    const dupe = [...this.sessions.values()].find((s) => s.name === name);
    if (dupe) {
      // 旧会话仍有活跃 SSE 连接：真正的同名冲突，拒绝
      if (dupe.res) return void sendJSON(res, 409, { error: `已有同名访客「${name}」在场` });
      // 旧会话已断线（多半是访客进程重启后重连）：静默顶替，不做离场叙事
      this.sessions.delete(dupe.token);
      this.closeSession(dupe);
      this.host.logger.info("[穿越] 访客「%s」重连，顶替断线的旧会话", name);
    }
    const persona = String(body.persona ?? "").slice(0, CROSSING_LIMITS.maxPersonaChars);
    const session: VisitorSession = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString("base64url"),
      name,
      persona,
      res: null,
      outbox: [],
      pendingTasks: 0,
      absenceTimer: null,
      arrivedAt: Date.now(),
      updateStatus: (content: string) => {
        // 同步会话内 persona（后续任务的前言用最新状态）并回传访客世界持久化
        session.persona = content.slice(0, CROSSING_LIMITS.maxPersonaChars);
        this.push(session, { type: "status_update", content });
      },
    };
    this.sessions.set(session.token, session);
    this.armAbsence(session);
    const timeLine = this.host.clock()?.timeLine() ?? "";
    sendJSON(res, 200, { ok: true, token: session.token, worldName: this.worldName, timeLine });
    this.host.logger.info("[穿越] 访客「%s」到达（邀请码备注：%s）", name, invite.name || "未备注");
    debug.emit("world.task", `穿越·访客「${name}」到达`, { invite: invite.name });

    // 到达叙事（异步）：World-LLM 生成到达场景、记录访客在场；主世界 Bot 同步感知。
    // 世界若在沉睡（常驻 Bot 外出、此前无访客），先补叙沉睡期间的演化再接待
    // （两个任务同步入队，串行队列保证先后顺序）
    this.host.notifyHostBot(`一位异世界的访客「${name}」穿越降临到了这个世界。`);
    void this.host.world
      .wakeDormant()
      .catch((err) => this.host.logger.warn("[穿越] 沉睡补叙失败: %s", err));
    void this.host.world
      .visitorArrive(session, (content) => this.push(session, { type: "event", content }))
      .catch((err) => this.host.logger.warn("[穿越] 到达叙事失败: %s", err));
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
    res.write(sseFrame({ type: "hello", worldName: this.worldName, timeLine }));
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
    if (!session) return void sendJSON(res, 403, { error: "会话不存在或已结束" });
    const taskId = String(body.taskId ?? "").slice(0, 64);
    const kind = String(body.kind ?? "") as CrossingTaskKind;
    if (!taskId || !["act", "wait", "checkTime", "query"].includes(kind)) {
      return void sendJSON(res, 400, { error: "taskId / kind 无效" });
    }
    if (session.pendingTasks >= CROSSING_LIMITS.maxPendingTasks) {
      return void sendJSON(res, 429, { error: "待处理任务过多，稍后再试" });
    }
    const payload = (body.payload ?? {}) as CrossingTaskPayload;
    sendJSON(res, 200, { ok: true });

    session.pendingTasks++;
    void this.runTask(session, taskId, kind, payload)
      .catch((err) => {
        this.host.logger.warn("[穿越] 访客「%s」任务 %s 失败: %s", session.name, kind, err);
        this.push(session, { type: "task_result", taskId, ok: false, content: "" });
      })
      .finally(() => {
        session.pendingTasks--;
      });
  }

  private async runTask(
    session: VisitorSession,
    taskId: string,
    kind: CrossingTaskKind,
    payload: CrossingTaskPayload,
  ): Promise<void> {
    const clip = (s: unknown) => String(s ?? "").slice(0, CROSSING_LIMITS.maxTaskChars);
    const parts: string[] = [];
    const deliver = (content: string) => parts.push(content);
    let ok = false;
    if (kind === "act") {
      ok = await this.host.world.visitorAct(session, clip(payload.desc), Number(payload.duration) || 0, deliver);
    } else if (kind === "wait") {
      ok = await this.host.world.visitorWait(session, Number(payload.n) || 0, deliver);
    } else if (kind === "checkTime") {
      ok = await this.host.world.visitorCheckTime(session, deliver);
    } else {
      try {
        parts.push(await this.host.world.visitorQuery(session, clip(payload.task)));
        ok = true;
      } catch {
        ok = false;
      }
    }
    this.push(session, { type: "task_result", taskId, ok, content: parts.join("\n") });
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
    const how = cause === "returned" ? "回自己的世界去了" : "与这个世界的联系突然断开，身影消散了";
    this.host.logger.info("[穿越] 访客「%s」离开（%s）", session.name, cause);
    debug.emit("world.task", `穿越·访客「${session.name}」离开`, { cause });
    this.host.notifyHostBot(`异世界的访客「${session.name}」${how}。`);
    void this.host.world
      .visitorLeave(session)
      .catch((err) => this.host.logger.warn("[穿越] 离开善后失败: %s", err));
    // 最后一位访客离开且常驻 Bot 也在外：世界重新进入沉睡
    if (this.sessions.size === 0) this.host.world.notePresenceChange();
  }

  private armAbsence(session: VisitorSession): void {
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
    const accepting = this.host.ready();
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
