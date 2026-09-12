/**
 * 运维 WebUI 的 HTTP 服务器（零依赖，node:http 实现）。
 *
 * 职责：
 * - 提供静态页面（index.html，内嵌于 page.ts）；
 * - REST API：状态/新闻/定义/配置/提示词/相册/媒体/记事本/数据文件 的读写；
 * - SSE（/api/events）：推送调试事件（LLM 原始请求响应、Bot 工具调用与事件、World 任务）、
 *   文件变更信号与生命周期事件，浏览器据此实时刷新；
 * - 文件监视：世界数据目录里的关键文件变化即时通知前端。
 *
 * 鉴权：config.webui.token 非空时，所有 /api/* 与 /api/events 要求
 * `Authorization: Bearer <token>` 或 `?token=`（EventSource 无法自定义请求头）。
 */

import http from "node:http";
import { promises as fs } from "node:fs";
import { watch as watchDir, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebUIConfig, Config } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { GalleryStore } from "../media/gallery.js";
import { normalizeCategory, UNSORTED_CATEGORY, sanitizeFileName } from "../media/gallery.js";
import type { MediaStore } from "../media/store.js";
import { DEFAULT_PROMPTS, type Prompts, type PromptOverrides } from "../prompts.js";
import type { WorldClock } from "../clock.js";
import type { ComputerExecResult, ComputerInspection } from "../computer.js";
import { collectSecretPaths, introspect, validateConfig } from "./schema.js";
import { debug, type DebugEntry } from "./debug.js";
import { usageStore } from "./usage.js";
import { callStore } from "./calls.js";
import { llmFetch, forEachStreamLine } from "../llm/http.js";
import { PAGE_HTML } from "./page.js";
import { VisitorStore, type VisitorSession, type VisitorGrant, type VisitorPreset, type PlayerProfile } from "./visitors.js";
import type { PlayerMode } from "../crossing/protocol.js";
import type { ManualToolResult } from "../bot/agent.js";
import type { DeviceSession, DeviceControlResult, DeviceOperationMode } from "./device.js";
import type { BotIdentity } from "./avatar.js";
import { CommandRequestError, WebCommandRunner } from "./commands.js";

export interface BotStatusSummary {
  running: boolean;
  waiting: string | null;
  streamLength: number;
  approxChars: number;
  pendingTasks: number;
  /** 手动驾驶（管理员接管 Bot）是否暂停了自主生成 */
  paused?: boolean;
  /** 手机界面状态（设备页窥视用）；老版本 Bot 可能不提供 */
  phoneUi?: { chatOpen: boolean; channelKey: string | null; channelIsGroup: boolean; forwardDepth: number };
}

export interface NoteEntry {
  title: string;
  content: string;
}

/** 「设备」页聚合信息：电脑（docker 管理 / 远程桌面）+ 手机 */
export interface DevicesInfo {
  computer: {
    mode: "off" | "docker" | "remote_desktop";
    /** 实际世界中的实现；虚构世界始终使用模型模拟，mode 只保留用户配置。 */
    effectiveMode?: "off" | "docker" | "remote_desktop" | "virtual";
    /** Bot 侧打开着的电脑应用名（开着 = 电脑开机中） */
    on: string | null;
    docker: ComputerInspection | null;
    remote: { host: string; port: number; connected?: boolean } | null;
  };
  phone: {
    down: boolean;
    appOpen: string | null;
    chatOpen: boolean;
    channelKey: string | null;
    channelIsGroup: boolean;
    /** 聊天应用显示名（如 QQ / 微信），用于手机窥视屏 */
    chatAppName: string;
    /** 屏幕分辨率（配置显式指定 > 创世判定 > 默认），WebUI 手机模型按此比例展示 */
    resolution: { width: number; height: number };
  };
}

/** WorldService 提供给 WebUI 的能力（结构性实现） */
export interface WebUIHost {
  baseDir: string;
  version: string;
  config: Config;
  configSchema: unknown;
  files: WorldFiles;
  gallery: GalleryStore;
  media: MediaStore;
  webuiDir: string;
  getClock(): WorldClock | null;
  isInitialized(): Promise<boolean>;
  worldRunning(): boolean;
  worldQueue(): number;
  botStatus(): BotStatusSummary | null;
  getBotIdentity?(): Promise<BotIdentity | null>;
  appOpen(): string | null;
  computerOn(): string | null;
  phoneDown(): boolean;
  focusChannels(): string[];
  /** 世界完整结构化真值，仅管理员可查看。 */
  getStructuredWorld?(): Promise<unknown>;
  /** 独立的成长记录，不包含置顶人设或内部上下文。 */
  getGrowth?(): Promise<unknown>;
  prompts(): Prompts;
  savePromptsOverrides(overrides: PromptOverrides): Promise<void>;
  initWorld(force: boolean): Promise<string>;
  startWorld(): Promise<string>;
  stopWorld(): Promise<string>;
  reloadWorld(): Promise<string>;
  resetWorld(): Promise<string>;
  clearMsg(): Promise<string>;
  statusText(): Promise<string>;
  /** 用户手动设置常驻 Bot 名字（写 meta.json + 刷新内存，立即生效） */
  setBotName(name: string): Promise<void>;
  injectEvent(text: string): Promise<string>;
  applyConfig(next: Config): Promise<{ message: string; port: number }>;
  notes(): Promise<NoteEntry[]>;
  writeNote(name: string, content: string): Promise<void>;
  deleteNote(name: string): Promise<void>;
  /** 设备页：电脑 + 手机的实时状态 */
  devicesInfo(): Promise<DevicesInfo>;
  deviceSession(): Promise<DeviceSession>;
  deviceControl(paused: boolean): Promise<DeviceControlResult>;
  deviceToolCall(name: string, args: Record<string, unknown>, duration?: number, confirmSend?: boolean, mode?: DeviceOperationMode): Promise<ManualToolResult>;
  /** 远程桌面实时截屏（peek，不影响 Bot 视野）；不可用/连不上时抛错 */
  computerScreen(maxWidth?: number): Promise<{ png: Buffer; width: number; height: number; desktopWidth?: number; desktopHeight?: number }>;
  /** Docker 电脑的开关机管理 */
  computerAction(action: "start" | "stop" | "restart"): Promise<string>;
  /** 在 Docker 电脑里执行一条命令（运维用途） */
  computerExec(command: string): Promise<ComputerExecResult>;
  /** 穿越：当前位置 / 服务状态 / 在场访客 / 可去的世界 */
  crossingInfo(): {
    location: string | null;
    serverEnabled: boolean;
    visitors: { name: string; arrivedAt: number }[];
    worlds: { name: string; allowVoluntary: boolean; note: string }[];
  };
  /** 穿越：强制送往某个世界（"home" = 送回自己的世界） */
  crossingForce(target: string): Promise<string>;
  /** 玩家入世界（同部署真人玩家，不走邀请码）：到达返回 crossing token */
  arrivePlayer(name: string, persona: string, mode?: PlayerMode): { ok: true; token: string; worldName: string; timeLine: string } | { ok: false; error: string };
  /** 管理员代理 Bot 执行任意工具调用（手动驾驶） */
  botToolCall(name: string, args: Record<string, unknown>, duration?: number, token?: string, confirmSend?: boolean): Promise<ManualToolResult>;
  acquirePlayerControl(token: string): Promise<DeviceControlResult>;
  releasePlayerControl(token: string): Promise<DeviceControlResult>;
  playerCockpit(token: string): Promise<unknown>;
  cancelPlayerTool(token: string, callId: string): ManualToolResult & { status: string };
  /** 管理员接管 Bot 时暂停/恢复其自主生成（扮演=暂停；操纵/交还=恢复） */
  botSetManualPaused(paused: boolean): void | DeviceControlResult | Promise<void | DeviceControlResult>;
  /** 当前有效 crossing 会话是否为管理员同名接管常驻 Bot。 */
  playerControlsBot?(token: string): boolean;
  /** Bot 是否处于手动驾驶（自主生成已暂停） */
  botManualMode(): boolean;
  /** 常驻 Bot 名字（供管理员同名判定） */
  residentBotName(): string;
  /** 归档：手动存档（把当前全部世界状态复制成一份新快照） */
  saveArchive(label: string): Promise<string>;
  /** 归档：回档到某个快照（当前状态先自动存档） */
  restoreArchive(name: string): Promise<string>;
  /** 归档：删除某个快照 */
  deleteArchive(name: string): Promise<void>;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".amr": "audio/amr",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
};

function mimeOf(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function isImageFile(name: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(path.extname(name).toLowerCase());
}

interface SseClient {
  res: http.ServerResponse;
  lastId: number;
}

export class WebUIServer {
  private server: http.Server | null = null;
  private clients = new Set<SseClient>();
  private heartbeat: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private unsubDebug: (() => void) | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private readonly cfg: WebUIConfig;
  private readonly visitors: VisitorStore;
  private readonly commands: WebCommandRunner;

  constructor(private host: WebUIHost) {
    this.cfg = host.config.webui;
    this.visitors = new VisitorStore(path.join(host.webuiDir, "visitors.json"));
    this.commands = new WebCommandRunner(host);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        try {
          if (!res.headersSent) {
            sendJSON(res, 500, { error: String((err as Error).message ?? err) });
          } else {
            res.end();
          }
        } catch {
          /* ignore */
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once("error", onError);
      this.server!.listen(this.cfg.port, this.cfg.host, () => {
        this.server!.removeListener("error", onError);
        resolve();
      });
    });

    debug.enabled = true;
    usageStore.init(this.host.webuiDir ? path.join(this.host.webuiDir, "usage.jsonl") : "");
    this.unsubDebug = debug.subscribe((entry, isUpdate) =>
      this.sendEvent({ channel: "debug", entry, update: isUpdate === true }, entry.id),
    );
    this.heartbeat = setInterval(() => {
      for (const c of [...this.clients]) {
        c.res.write(": ping\n\n");
      }
    }, 20000);

    // 监视世界数据目录：Bot_Status / World_Status / News / stream / Notes / gallery 等
    this.watcher = watchDir(this.host.files.base, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join("/");
      this.signalFile(rel);
    });
    this.watcher.on("error", () => {
      /* 目录被删除等：忽略，靠轮询兜底 */
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.unsubDebug?.();
    this.unsubDebug = null;
    debug.enabled = false;
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = null;
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      // 强制断开全部连接：SSE 客户端 keep-alive 会阻止 close() 完成，
      // 插件作用域热重载（改配置）时必须在短时间内释放端口
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** 关键文件的变更信号（小写字母标识，前端据此刷新对应视图） */
  private signalFile(rel: string): void {
    // 归档目录里的变动一律发 archive 信号（避免快照文件名的基名干扰其他信号）
    if (rel.startsWith("archive/")) {
      this.emitSignal("archive");
      return;
    }
    const base = path.basename(rel);
    let signal: string | null = null;
    switch (base) {
      case "Bot_Status.md":
        signal = "botStatus";
        break;
      case "World_Status.md":
        signal = "worldStatus";
        break;
      case "News.jsonl":
        signal = "news";
        break;
      case "facts.jsonl":
        signal = "facts";
        break;
      case "stream.jsonl":
        signal = "stream";
        break;
      case "clock.json":
        signal = "clock";
        break;
      case "meta.json":
        signal = "meta";
        break;
      case "pinned.json":
        signal = "pinned";
        break;
      case "Bot_Definition.md":
        signal = "botDef";
        break;
      case "World_Definition.md":
        signal = "worldDef";
        break;
      case "focus.json":
      case "notify.json":
        signal = "data";
        break;
      default:
        if (rel.startsWith("gallery/")) signal = "gallery";
        else if (rel.startsWith("assets/")) signal = "media";
        else if (rel.startsWith("Notes/")) signal = "notes";
        else signal = null;
    }
    if (signal) this.emitSignal(signal);
  }

  /** 信号防抖后发送（同一信号 200ms 内的多次变动合并为一次推送） */
  private emitSignal(signal: string): void {
    const prev = this.debounce.get(signal);
    if (prev) clearTimeout(prev);
    this.debounce.set(
      signal,
      setTimeout(() => {
        this.debounce.delete(signal);
        this.sendEvent({ channel: "file", file: signal });
      }, 200),
    );
  }

  // ---------- SSE ----------

  private sendEvent(obj: unknown, id?: number): void {
    if (!this.clients.size) return;
    const data = JSON.stringify(obj);
    const frame = id == null ? `data: ${data}\n\n` : `id: ${id}\ndata: ${data}\n\n`;
    for (const c of [...this.clients]) {
      if (id != null && id > c.lastId) c.lastId = id;
      c.res.write(frame);
    }
  }

  private sendLifecycle(event: string, detail?: unknown): void {
    this.sendEvent({ channel: "lifecycle", event, detail }, debug.snapshot() + 1);
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse, sinceRaw: string | null): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // 断线续传锚点：优先读标准的 Last-Event-ID 请求头（EventSource 自动重连会带），
    // 其次取前端 URL 里的 since 参数。since=0 表示全新订阅（首次访问/无缓存），
    // 历史由前端通过 /api/debug 自行种子化，**不**整体重放——
    // 否则每次无缓存刷新都会把整段调试历史逐条推给浏览器，造成"从头重播一遍"的闪烁。
    const lastEventIdHeader = req.headers["last-event-id"];
    const since = Number(lastEventIdHeader ?? sinceRaw ?? 0) || 0;
    const client: SseClient = { res, lastId: debug.snapshot() };
    if (since > 0) {
      for (const entry of debug.since(since)) {
        client.lastId = entry.id;
        res.write(`id: ${entry.id}\ndata: ${JSON.stringify({ channel: "debug", entry })}\n\n`);
      }
    }
    this.clients.add(client);
    res.write(`id: ${client.lastId}\ndata: ${JSON.stringify({ channel: "hello", snapshot: debug.snapshot() })}\n\n`);
    req.on("close", () => this.clients.delete(client));
  }

  // ---------- HTTP ----------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    if (pathname === "/api/events") {
      const access = this.resolveAccess(req, url);
      if (!access) return void sendJSON(res, 401, { error: "需要访问令牌" });
      if (access.kind === "visitor" && !access.session.grants.has("debug")) {
        return void sendJSON(res, 403, { error: "访客无权访问调试事件流" });
      }
      this.handleSse(req, res, url.searchParams.get("since"));
      return;
    }

    if (pathname.startsWith("/api/")) {
      // 登录与账号管理端点为独立鉴权，不走通用 access
      if (pathname === "/api/login") {
        await this.handleLogin(req, url, res);
        return;
      }
      if (pathname === "/api/visitors/me") {
        return this.handleVisitorMe(req, url, res);
      }
      // 访客自主修改密码（任何访客档，需旧密码验证）
      if (pathname === "/api/account/password" && method === "POST") {
        return this.handleChangePassword(req, url, res);
      }
      if (pathname === "/api/visitors") {
        await this.handleVisitors(method, url, req, res);
        return;
      }
      // 玩家入世界端点：仅 player 档账号可用（有自己的写操作：arrive/task/leave）
      if (pathname.startsWith("/api/player")) {
        await this.handlePlayer(pathname, method, url, req, res);
        return;
      }
      const access = this.resolveAccess(req, url);
      if (!access) return void sendJSON(res, 401, { error: "需要访问令牌" });
      // 访客只读：所有写方法一律拒绝
      if (access.kind === "visitor" && method !== "GET") {
        return void sendJSON(res, 403, { error: "访客无写权限" });
      }
      await this.handleApi(method, pathname, url, req, res, access);
      return;
    }

    // 静态页面
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }

    sendJSON(res, 404, { error: "Not Found" });
  }

  /** 解析访问者：admin（token 匹配）→ {kind:"admin"}；访客会话 → {kind:"visitor", session}；否则 null */
  private resolveAccess(req: http.IncomingMessage, url: URL): { kind: "admin" } | { kind: "visitor"; session: VisitorSession } | null {
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const visitorToken = url.searchParams.get("visitor") ?? (req.headers["x-visitor-token"] as string | undefined) ?? null;

    // 1. 优先精确匹配 admin token（若设置了 webui.token）
    if (this.cfg.token && (bearer === this.cfg.token || url.searchParams.get("token") === this.cfg.token)) {
      return { kind: "admin" };
    }

    // 2. 带了 visitor 会话：只可能按访客处理（无论 token 是否设置）
    if (visitorToken) {
      const session = this.visitors.resolve(visitorToken);
      if (session) return { kind: "visitor", session };
      // 无效访客会话：拒绝（不要 fallback 成 admin）
      return null;
    }

    // 3. 未设置 admin token：视为 admin（保持旧的"不鉴权"行为）
    if (!this.cfg.token) return { kind: "admin" };

    // 4. 设置了 admin token 但没给对：拒绝
    return null;
  }

  /** 当前访客会话的实时身份（前端同步导航过滤用）；会话失效/账号被删返回 401 */
  private handleVisitorMe(req: http.IncomingMessage, url: URL, res: http.ServerResponse): void {
    const access = this.resolveAccess(req, url);
    if (!access || access.kind !== "visitor") {
      return void sendJSON(res, 401, { error: "访客会话无效" });
    }
    sendJSON(res, 200, {
      username: access.session.username,
      preset: access.session.preset,
      grants: [...access.session.grants],
    });
  }

  /** 访客自主修改自己的密码（需旧密码验证） */
  private async handleChangePassword(req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<void> {
    const access = this.resolveAccess(req, url);
    if (!access || access.kind !== "visitor") {
      return void sendJSON(res, 401, { error: "访客会话无效" });
    }
    const body = await readJson(req, 64 * 1024).catch(() => null);
    if (!body) return void sendJSON(res, 400, { error: "请求体不是合法 JSON" });
    const oldPassword = String(body.oldPassword ?? "");
    const newPassword = String(body.newPassword ?? "");
    const r = await this.visitors.changePassword(access.session.accountId, oldPassword, newPassword);
    if (!r.ok) return void sendJSON(res, 400, { error: r.error });
    sendJSON(res, 200, { ok: true });
  }

  /** crossing 服务的本机回环地址（玩家代理端点内部转发用） */
  private crossingBase(): string {
    const port = this.host.config.crossing?.port ?? 18112;
    return `http://127.0.0.1:${port}`;
  }

  /**
   * 玩家入世界端点：player 档账号 与 管理员 均可用。
   * - 玩家（visitor, preset=player）：角色档案持久化在账号（session.playerProfile）。
   * - 管理员（admin）：无账号档案，角色身份由前端 localStorage 保存、arrive 时随请求体传入。
   */
  private async handlePlayer(pathname: string, method: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const access = this.resolveAccess(req, url);
    if (!access) return void sendJSON(res, 401, { error: "需要访问令牌" });
    const isAdmin = access.kind === "admin";
    const isPlayer = access.kind === "visitor" && access.session.preset === "player";
    if (!isAdmin && !isPlayer) {
      return void sendJSON(res, 403, { error: "仅玩家账号或管理员可用" });
    }
    const session = access.kind === "visitor" ? access.session : null;

    // 角色身份：GET 读 / PUT 存（玩家首次登录填完后持久化；管理员无账号档案，不走此端点）
    if (pathname === "/api/player/profile") {
      if (isAdmin) return void sendJSON(res, 200, { profile: null });
      if (method === "GET") {
        return void sendJSON(res, 200, { profile: session!.playerProfile });
      }
      if (method === "PUT") {
        const body = await readJson(req, 1024 * 1024).catch(() => null);
        if (!body) return void sendJSON(res, 400, { error: "请求体不是合法 JSON" });
        const profile: PlayerProfile = {
          name: String(body.name ?? "").trim(),
          persona: String(body.persona ?? "").trim(),
          mode: body.mode === "avatar" || body.mode === "puppet" || body.mode === "cross" ? body.mode : undefined,
        };
        if (!profile.name) return void sendJSON(res, 400, { error: "角色名不能为空" });
        // 玩家角色不能与常驻 Bot 同名（避免世界裁决时主体混淆）——仅对真人玩家档生效；
        // 管理员是例外：可与常驻 Bot 同名，以进入「接管 Bot」模式。
        const botName = (await this.host.files.readMeta()).botName?.trim();
        if (botName && profile.name === botName) {
          return void sendJSON(res, 400, { error: `角色名不能与常驻 Bot「${botName}」相同` });
        }
        const r = await this.visitors.savePlayerProfile(session!.accountId, profile);
        if (!r.ok) return void sendJSON(res, 400, { error: r.error });
        return void sendJSON(res, 200, { ok: true });
      }
      return void sendJSON(res, 405, { error: "不支持的方法" });
    }

    // 到达：玩家用账号档案；管理员用请求体里的角色身份（含 mode=进入语义）
    if (pathname === "/api/player/arrive" && method === "POST") {
      const body = await readJson(req, 1024 * 1024).catch(() => null);
      let name: string;
      let persona: string;
      let mode: PlayerMode;
      if (isAdmin) {
        name = String(body?.name ?? "").trim();
        persona = String(body?.persona ?? "").trim();
        mode = body && (body.mode === "avatar" || body.mode === "puppet" || body.mode === "cross") ? body.mode : "cross";
        if (!name) return void sendJSON(res, 400, { error: "请先填写角色身份" });
      } else {
        const profile = session!.playerProfile;
        if (!profile || !profile.name) {
          return void sendJSON(res, 400, { error: "请先填写角色身份" });
        }
        name = profile.name;
        persona = profile.persona;
        mode = body && (body.mode === "avatar" || body.mode === "puppet" || body.mode === "cross")
          ? body.mode
          : (profile.mode ?? "cross");
      }
      if (mode !== "cross" && (!isAdmin || name !== this.host.residentBotName().trim())) {
        return void sendJSON(res, 400, { error: "目前只支持穿越独立角色；已有 NPC 的扮演/操纵尚未实现。管理员可同名接管常驻 Bot。" });
      }
      const r = this.host.arrivePlayer(name, persona, mode);
      if (!r.ok) return void sendJSON(res, 400, { error: r.error });
      // 管理员与常驻 Bot 同名（扮演/操纵）＝接管 Bot：扮演=暂停 Bot-LLM 自主生成，操纵=继续自主运行
      const botName = this.host.residentBotName().trim();
      let control: void | DeviceControlResult = undefined;
      if (isAdmin && botName && name === botName && (mode === "avatar" || mode === "puppet")) {
        control = await this.host.acquirePlayerControl(r.token);
        if (control && !control.ok) {
          await this.crossingPost("/crossing/leave", { token: r.token });
          return void sendJSON(res, 409, { error: control.text, control });
        }
      }
      return void sendJSON(res, 200, { ok: true, token: r.token, worldName: r.worldName, timeLine: r.timeLine, mode, botName, ...(control ? { control } : {}) });
    }

    if (pathname === "/api/player/cockpit" && method === "GET") {
      if (!isAdmin) return void sendJSON(res, 403, { error: "驾驶舱仅供管理员接管常驻角色时使用" });
      const token = String(url.searchParams.get("ctoken") ?? "");
      if (!token || !this.host.playerControlsBot?.(token)) return void sendJSON(res, 403, { error: "接管会话不存在或已结束" });
      try { return void sendJSON(res, 200, await this.host.playerCockpit(token)); }
      catch (error) { return void sendJSON(res, 409, { error: (error as Error).message }); }
    }

    if (pathname === "/api/player/tool/cancel" && method === "POST") {
      if (!isAdmin) return void sendJSON(res, 403, { error: "只有管理员可取消代理调用" });
      const body = await readJson(req, 64 * 1024).catch(() => null);
      if (!body || typeof body.token !== "string" || typeof body.callId !== "string" || !body.callId || body.callId.length > 64) return void sendJSON(res, 400, { error: "需要有效 token 与 callId" });
      if (!this.host.playerControlsBot?.(body.token)) return void sendJSON(res, 403, { error: "接管会话不存在或已结束" });
      return void sendJSON(res, 200, this.host.cancelPlayerTool(body.token, body.callId));
    }

    // 代理 Bot 工具调用（管理员手动驾驶）：管理员接管 Bot 时经此真正执行任意 Bot 工具
    if (pathname === "/api/player/tool" && method === "POST") {
      if (!isAdmin) return void sendJSON(res, 403, { error: "仅管理员可代理 Bot 工具调用" });
      const body = await readJson(req, 1024 * 1024).catch(() => null);
      if (!body) return void sendJSON(res, 400, { error: "请求体不是合法 JSON" });
      if (typeof body.token !== "string" || !this.host.playerControlsBot?.(body.token)) return void sendJSON(res, 403, { error: "需要有效的常驻角色接管会话 token" });
      const name = String(body.name ?? "").trim();
      if (!name) return void sendJSON(res, 400, { error: "缺少工具名 name" });
      const args = (body.arguments ?? body.args ?? {}) as Record<string, unknown>;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return void sendJSON(res, 400, { error: "arguments 必须是 JSON 对象" });
      }
      const duration = body.duration;
      if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) return void sendJSON(res, 400, { error: "duration 必须为有限非负数（单位 TU）" });
      const r = await this.host.botToolCall(name, args, duration, body.token, body.confirmSend === true);
      return void sendJSON(res, 200, r);
    }

    // 提交行动（act）：真人玩家走 crossing 的 visitorAct；管理员接管 Bot（同名扮演/操纵）走 Bot 的 adjudicateAct
    if (pathname === "/api/player/task" && method === "POST") {
      const body = await readJson(req, 1024 * 1024).catch(() => null);
      if (!body) return void sendJSON(res, 400, { error: "请求体不是合法 JSON" });
      const kind = String(body.kind ?? "");
      const payload = (body.payload ?? {}) as Record<string, unknown>;
      // 常驻角色必须使用已授权的驾驶舱；actorName 不是身份凭据。
      if (this.host.playerControlsBot?.(String(body.token ?? ""))) return void sendJSON(res, 400, { error: "请通过常驻角色驾驶舱提交工具调用" });
      const r = await this.crossingPost("/crossing/task", body);
      if (!r.ok) return void sendJSON(res, 400, { error: String(r.error ?? "任务被拒绝") });
      return void sendJSON(res, 200, { ok: true });
    }

    // 离开
    if (pathname === "/api/player/cancel" && method === "POST") {
      const body = await readJson(req, 64 * 1024).catch(() => null);
      if (!body || typeof body.token !== "string" || !body.token || typeof body.taskId !== "string" || !body.taskId || body.taskId.length > 64) {
        return void sendJSON(res, 400, { error: "需要 crossing 会话 token 与有效 taskId；管理员直调工具没有可撤销的 crossing taskId。" });
      }
      const result = await this.crossingPost("/crossing/cancel", { token: body.token, taskId: body.taskId });
      return void sendJSON(res, 200, result);
    }

    // 离开
    if (pathname === "/api/player/leave" && method === "POST") {
      const body = await readJson(req, 64 * 1024).catch(() => null);
      if (!body || typeof body.token !== "string" || !body.token) return void sendJSON(res, 400, { error: "需要 crossing 会话 token" });
      // 只有有效的常驻角色接管会话才交还 Bot；独立访客离开不影响设备页的接管。
      if (isAdmin && this.host.playerControlsBot?.(body.token)) {
        const control = await this.host.releasePlayerControl(body.token);
        if (control && !control.ok) return void sendJSON(res, 409, { error: control.text, control });
      }
      const r = await this.crossingPost("/crossing/leave", body);
      return void sendJSON(res, r.ok ? 200 : 400, r);
    }

    // 事件流：SSE 转发 crossing events
    if (pathname === "/api/player/events" && method === "GET") {
      const token = String(url.searchParams.get("ctoken") ?? "");
      if (!token) return void sendJSON(res, 400, { error: "缺少 crossing token" });
      return void this.proxyPlayerEvents(token, res, req);
    }

    sendJSON(res, 404, { error: "Not Found" });
  }

  /** 转发 POST 到本机 crossing 服务 */
  private async crossingPost(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await llmFetch(this.crossingBase() + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      /* 非 JSON */
    }
    if (!res.ok && data.error === undefined) data.error = `HTTP ${res.status}`;
    // 给 ok 打标（crossing 返回 {ok,...}；失败时补 ok:false）
    if (data.ok === undefined) data.ok = res.ok;
    return data;
  }

  /** SSE 转发：把本机 crossing 的 events 流透传给浏览器 */
  private async proxyPlayerEvents(token: string, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    // 玩家浏览器断开（关网页/断网/刷新）时，必须把断连传导给上游 crossing 的 SSE，
    // 否则 crossing 永远以为玩家还在场（session.res 不置 null），下次进入会报"同名在场"。
    const abort = new AbortController();
    const onClientClose = () => abort.abort();
    req.on("close", onClientClose);
    try {
      const upstream = await llmFetch(`${this.crossingBase()}/crossing/events?token=${encodeURIComponent(token)}`, {
        signal: abort.signal,
      });
      if (!upstream.ok) {
        return void sendJSON(res, upstream.status, { error: "穿越事件流不可用" });
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      await forEachStreamLine(upstream, (line) => {
        res.write(line + "\n\n");
      });
      res.end();
    } catch (err) {
      // 客户端断开导致的 abort：静默结束，不写错误
      if (abort.signal.aborted) return;
      if (!res.headersSent) {
        sendJSON(res, 502, { error: `穿越服务不可用：${(err as Error).message ?? err}` });
      } else {
        res.end();
      }
    } finally {
      req.off("close", onClientClose);
    }
  }


  /** 访客登录：POST /api/login {username, password} → {token} 或 401 */
  private async handleLogin(req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "POST") return void sendJSON(res, 405, { error: "仅支持 POST" });
    const body = await readJson(req, 4 * 1024).catch(() => null);
    if (!body) return void sendJSON(res, 400, { error: "请求体不是合法 JSON" });
    const result = await this.visitors.login(String(body.username ?? ""), String(body.password ?? ""));
    if (!result) return void sendJSON(res, 401, { error: "用户名或密码错误" });
    sendJSON(res, 200, {
      ok: true,
      token: result.token,
      preset: result.preset,
      grants: result.grants,
      playerProfile: result.playerProfile ?? null,
    });
  }

  /** 访客账号管理（仅 admin）：GET 列出 / POST 增 / PUT 改 / DELETE 删 */
  private async handleVisitors(method: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 仅 admin 可管理访客账号
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const isAdmin = this.cfg.token === "" || bearer === this.cfg.token || url.searchParams.get("token") === this.cfg.token;
    if (!isAdmin) return void sendJSON(res, 403, { error: "仅管理员可管理访客账号" });

    if (method === "GET") {
      sendJSON(res, 200, { visitors: await this.visitors.list() });
      return;
    }
    const body = await readJson(req, 1024 * 1024).catch(() => null);
    if (!body) return void sendJSON(res, 400, { error: "请求体不是合法 JSON" });
    if (method === "POST") {
      const r = await this.visitors.create(String(body.username ?? ""), String(body.password ?? ""), (body.preset as VisitorPreset) ?? "viewer");
      if (!r.ok) return void sendJSON(res, 400, { error: r.error });
      return void sendJSON(res, 200, { ok: true, visitors: await this.visitors.list() });
    }
    if (method === "PUT") {
      const id = String(body.id ?? "");
      const r = await this.visitors.update(id, {
        username: body.username !== undefined ? String(body.username) : undefined,
        password: body.password !== undefined ? String(body.password) : undefined,
        preset: body.preset !== undefined ? (body.preset as VisitorPreset) : undefined,
        grants: body.grants as Partial<Record<VisitorGrant, boolean>> | undefined,
      });
      if (!r.ok) return void sendJSON(res, 400, { error: r.error });
      return void sendJSON(res, 200, { ok: true, visitors: await this.visitors.list() });
    }
    if (method === "DELETE") {
      const r = await this.visitors.remove(String(body.id ?? ""));
      if (!r.ok) return void sendJSON(res, 400, { error: r.error });
      return void sendJSON(res, 200, { ok: true, visitors: await this.visitors.list() });
    }
    sendJSON(res, 405, { error: "不支持的方法" });
  }

  private async handleApi(
    method: string,
    pathname: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    access: { kind: "admin" } | { kind: "visitor"; session: VisitorSession },
  ): Promise<void> {
    const host = this.host;
    const q = url.searchParams;

    // The entire catalogue and execution history are administrator-only, including GETs.
    if (pathname === "/api/commands" || pathname.startsWith("/api/commands/")) {
      if (access.kind !== "admin") return void sendJSON(res, 403, { error: "仅管理员可使用工作室指令。" });
      if (pathname === "/api/commands" && method === "GET") return void sendJSON(res, 200, this.commands.catalog());
      if (pathname === "/api/commands" && method === "POST") {
        try {
          const body = await readJson(req, 32 * 1024);
          const run = this.commands.start(body);
          return void sendJSON(res, run.status === "running" ? 202 : 200, { instanceId: this.commands.instanceId, run });
        } catch (error) {
          return void sendJSON(res, error instanceof CommandRequestError ? error.status : 400, { error: String((error as Error).message ?? error) });
        }
      }
      if (method === "GET" && pathname.startsWith("/api/commands/")) {
        const run = this.commands.get(pathname.slice("/api/commands/".length));
        return void sendJSON(res, run ? 200 : 404, run ? { instanceId: this.commands.instanceId, run } : { error: "找不到此执行记录，服务可能已经重启。请检查世界状态，勿重复执行不确定的操作。" });
      }
      return void sendJSON(res, 405, { error: "不支持的方法" });
    }

    // 访客分级过滤：按端点映射到数据块，无授权则 403
    if (access.kind === "visitor") {
      const grant = grantForEndpoint(pathname, method);
      if (grant && !this.visitors.can(access.session, grant)) {
        return void sendJSON(res, 403, { error: `访客无权访问该数据（需要 ${grant} 权限）` });
      }
    }

    // ---------- 概览 / 状态 ----------
    if (pathname === "/api/world/state" && method === "GET") {
      if (access.kind !== "admin") return void sendJSON(res, 403, { error: "仅管理员可读取世界完整结构化状态" });
      if (!host.getStructuredWorld) return void sendJSON(res, 503, { error: "结构化世界尚未就绪" });
      return void sendJSON(res, 200, { state: await host.getStructuredWorld() });
    }
    if (pathname === "/api/bot/growth" && method === "GET") {
      if (!host.getGrowth) return void sendJSON(res, 503, { error: "成长记录尚未就绪" });
      return void sendJSON(res, 200, { growth: await host.getGrowth() });
    }
    if (pathname === "/api/overview" && method === "GET") {
      const clock = host.getClock();
      const bot = host.botStatus();
      const news = await host.files.readNews(8);
      const facts = await host.files.readFacts(8);
      const counts = await host.gallery.counts();
      const isVisitor = access.kind === "visitor";
      const can = (g: VisitorGrant) => !isVisitor || this.visitors.can(access.session, g);
      sendJSON(res, 200, {
        version: host.version,
        // 敏感路径（baseDir / webuiDir / tokenSet / addresses）仅 admin 可见
        ...(isVisitor ? {} : { baseDir: host.baseDir, webuiDir: host.webuiDir }),
        initialized: await host.isInitialized(),
        worldRunning: host.worldRunning(),
        worldQueue: host.worldQueue(),
        clock: clock
          ? {
              syncRealTime: clock.syncRealTime,
              timeLine: clock.timeLine(),
              unitRealSeconds: clock.unitRealSeconds,
              unitWorldSeconds: clock.unitWorldSeconds,
            }
          : null,
        bot,
        botIdentity: await host.getBotIdentity?.() ?? null,
        appOpen: host.appOpen(),
        computerOn: host.computerOn(),
        phoneDown: host.phoneDown(),
        focusChannels: host.focusChannels(),
        news: can("news") ? news : [],
        facts: can("facts") ? facts : [],
        galleryCounts: can("gallery") ? counts : [],
        crossing: can("crossing") ? host.crossingInfo() : undefined,
        ...(isVisitor ? {} : { tokenSet: !!this.cfg.token, addresses: accessUrls(this.cfg.host, this.cfg.port) }),
      });
      return;
    }

    // ---------- 设备（电脑 + 手机窥视） ----------
    if (pathname.startsWith("/api/device/")) {
      if (access.kind !== "admin") return void sendJSON(res, 403, { error: "仅管理员可读取和操作 Bot 的真实设备会话" });
      res.setHeader?.("cache-control", "no-store");
      if (pathname === "/api/device/session" && method === "GET") return void sendJSON(res, 200, await host.deviceSession());
      if (pathname === "/api/device/control" && method === "POST") {
        const body = await readJson(req, 64 * 1024).catch(() => null);
        if (!body || typeof body.paused !== "boolean") return void sendJSON(res, 400, { error: "paused 必须是布尔值" });
        return void sendJSON(res, 200, await host.deviceControl(body.paused));
      }
      if (pathname === "/api/device/tool" && method === "POST") {
        const body = await readJson(req, 1024 * 1024).catch(() => null);
        if (!body || typeof body.name !== "string" || !body.name.trim() || !body.args || typeof body.args !== "object" || Array.isArray(body.args)) return void sendJSON(res, 400, { error: "需要工具名 name 与 JSON 对象 args" });
        if (body.duration !== undefined && (typeof body.duration !== "number" || !Number.isFinite(body.duration) || body.duration < 0)) return void sendJSON(res, 400, { error: "duration 必须为有限非负数" });
        if (body.mode !== undefined && body.mode !== "stealth" && body.mode !== "takeover") return void sendJSON(res, 400, { error: "mode 必须为 stealth 或 takeover" });
        return void sendJSON(res, 200, await host.deviceToolCall(body.name.trim(), body.args as Record<string, unknown>, body.duration as number | undefined, body.confirmSend === true, body.mode as DeviceOperationMode | undefined));
      }
      return void sendJSON(res, 404, { error: "设备端点或方法不存在" });
    }
    if (pathname === "/api/devices" && method === "GET") {
      sendJSON(res, 200, await host.devicesInfo());
      return;
    }

    if (pathname === "/api/computer/screen" && method === "GET") {
      try {
        const w = Number(q.get("w")) || undefined;
        const shot = await host.computerScreen(w);
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
          "x-screen-width": String(shot.width),
          "x-screen-height": String(shot.height),
          "x-desktop-width": String(shot.desktopWidth ?? shot.width),
          "x-desktop-height": String(shot.desktopHeight ?? shot.height),
        });
        res.end(shot.png);
      } catch (err) {
        sendJSON(res, 503, { error: (err as Error).message ?? String(err) });
      }
      return;
    }

    if (pathname === "/api/computer/action" && method === "POST") {
      const { action } = await readJson(req);
      if (action !== "start" && action !== "stop" && action !== "restart") {
        sendJSON(res, 400, { error: "action 只能是 start / stop / restart" });
        return;
      }
      try {
        const text = await host.computerAction(action);
        this.sendLifecycle("computer." + action, text);
        sendJSON(res, 200, { ok: true, text });
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message ?? String(err) });
      }
      return;
    }

    if (pathname === "/api/computer/exec" && method === "POST") {
      const { command } = await readJson(req);
      if (!String(command ?? "").trim()) {
        sendJSON(res, 400, { error: "command 不能为空" });
        return;
      }
      if (String(command).length > 4000) {
        sendJSON(res, 400, { error: "command 过长（>4000 字符）" });
        return;
      }
      try {
        sendJSON(res, 200, await host.computerExec(String(command)));
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message ?? String(err) });
      }
      return;
    }

    if (pathname === "/api/state" && method === "GET") {
      // 打包端点：对访客按 grant 裁剪字段（user 输入的 botDef/worldDef 需 definitions 权限）
      const isVisitor = access.kind === "visitor";
      const can = (g: VisitorGrant) => !isVisitor || this.visitors.can(access.session, g);
      const payload: Record<string, unknown> = {
        botStatus: can("bot_status") ? await host.files.readBotStatus() : "",
        worldStatus: can("world_status") ? await host.files.readWorldStatus(isVisitor) : "",
        news: can("news") ? await readAllNews(host.files.news) : [],
        facts: can("facts") ? await readAllNews(host.files.facts) : [],
        botDef: can("definitions") ? await host.files.readText(host.files.botDef) : "",
        worldDef: can("definitions") ? await host.files.readText(host.files.worldDef) : "",
        meta: can("world_status") ? await host.files.readMeta() : {},
        phoneShell: can("world_status") ? await host.files.readPhoneShell() : "",
        initialized: await host.isInitialized(),
      };
      sendJSON(res, 200, payload);
      return;
    }

    // ---------- 定义文件（用户编写） ----------
    if (pathname === "/api/definitions/bot" && method === "PUT") {
      const { content } = await readJson(req);
      await host.files.writeBotDef(String(content ?? ""));
      this.sendLifecycle("definitions", "bot");
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/definitions/world" && method === "PUT") {
      const { content } = await readJson(req);
      await host.files.writeWorldDef(String(content ?? ""));
      this.sendLifecycle("definitions", "world");
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- 状态文件（Bot_Status / World_Status） ----------
    if (pathname === "/api/state/bot-status" && method === "PUT") {
      const { content } = await readJson(req);
      await host.files.writeBotStatus(String(content ?? ""));
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/state/world-status" && method === "PUT") {
      const { content } = await readJson(req);
      await host.files.writeWorldStatus(String(content ?? ""));
      sendJSON(res, 200, { ok: true });
      return;
    }

    // 常驻 Bot 名字（用户手动编辑，写 meta.json + 刷新内存）
    if (pathname === "/api/state/bot-name" && method === "PUT") {
      const { name } = await readJson(req);
      await host.setBotName(String(name ?? ""));
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- 手机外壳 HTML ----------
    if (pathname === "/api/state/phone-shell" && method === "GET") {
      sendJSON(res, 200, { content: await host.files.readPhoneShell() });
      return;
    }
    if (pathname === "/api/state/phone-shell" && method === "PUT") {
      const { content } = await readJson(req, 4 * 1024 * 1024);
      await host.files.writePhoneShell(String(content ?? ""));
      this.sendLifecycle("phoneShell");
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- 世界新闻 ----------
    if (pathname === "/api/state/news" && method === "POST") {
      const { content } = await readJson(req);
      const t = host.getClock()?.now() ?? Date.now();
      await host.files.appendNews({
        t,
        clock: host.getClock()?.clockString(t) ?? String(t),
        content: String(content ?? "").trim(),
      });
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/state/news" && method === "PUT") {
      const { index, content } = await readJson(req);
      await editNews(host.files.news, Number(index), String(content ?? ""));
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/state/news" && method === "DELETE") {
      const index = Number(q.get("index"));
      await removeNews(host.files.news, index);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- Bot 小事记 ----------
    if (pathname === "/api/state/facts" && method === "POST") {
      const { content } = await readJson(req);
      const t = host.getClock()?.now() ?? Date.now();
      await host.files.appendFacts({
        t,
        clock: host.getClock()?.clockString(t) ?? String(t),
        content: String(content ?? "").trim(),
      });
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/state/facts" && method === "PUT") {
      const { index, content } = await readJson(req);
      await editNews(host.files.facts, Number(index), String(content ?? ""));
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/state/facts" && method === "DELETE") {
      const index = Number(q.get("index"));
      await removeNews(host.files.facts, index);
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/state/facts/pin" && method === "POST") {
      const { index, pinned } = await readJson(req);
      await setFactsPinned(host.files.facts, Number(index), pinned !== false);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- 配置 ----------
    if (pathname === "/api/config" && method === "GET") {
      const schemaNode = introspect(host.configSchema);
      const secretPaths = collectSecretPaths(schemaNode);
      sendJSON(res, 200, {
        schema: schemaNode,
        // 深度复制后把 secret 字段脱敏，避免 API key / 令牌 / 密码明文回传到浏览器
        value: maskSecrets(host.config, secretPaths),
      });
      return;
    }
    if (pathname === "/api/config" && method === "POST") {
      const body = await readJson(req, 8 * 1024 * 1024);
      const next = body.config;
      if (!next || typeof next !== "object") {
        return void sendJSON(res, 400, { error: "缺少 config 字段" });
      }
      // 把未改动的（仍是掩码的）secret 还原为当前真实值，避免脱敏值覆盖原密钥
      const secretPaths = collectSecretPaths(introspect(host.configSchema));
      const restored = restoreSecrets(next as Config, host.config, secretPaths);
      const errors = validateConfig(host.configSchema, restored);
      if (errors.length) return void sendJSON(res, 400, { error: "配置校验失败", errors });
      const result = await host.applyConfig(restored as Config);
      sendJSON(res, 200, result);
      return;
    }

    // ---------- LLM 模型列表（配置页获取可选模型） ----------
    if (pathname === "/api/llm/models" && method === "POST") {
      const body = await readJson(req);
      const baseURL = String(body.baseURL ?? "").trim();
      let apiKey = String(body.apiKey ?? "");
      // apiKey 被脱敏回传时（仍是掩码），按 group 路径从当前配置回填真实密钥
      if (apiKey === SECRET_MASK) {
        apiKey = getSecretByPath(host.config, String(body.group ?? ""));
      }
      if (!baseURL) return void sendJSON(res, 400, { error: "缺少 baseURL" });
      try {
        const models = await fetchLlmModels(baseURL, apiKey);
        sendJSON(res, 200, { models });
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message ?? String(err) });
      }
      return;
    }

    // ---------- 提示词 ----------
    if (pathname === "/api/prompts" && method === "GET") {
      sendJSON(res, 200, {
        defaults: DEFAULT_PROMPTS,
        overrides: host.prompts().get(),
      });
      return;
    }
    if (pathname === "/api/prompts" && method === "POST") {
      const { overrides } = await readJson(req, 4 * 1024 * 1024);
      if (!overrides || typeof overrides !== "object") {
        return void sendJSON(res, 400, { error: "缺少 overrides 字段" });
      }
      await host.savePromptsOverrides(overrides as PromptOverrides);
      host.prompts().setOverrides(overrides as PromptOverrides);
      sendJSON(res, 200, { ok: true, effective: host.prompts().effective() });
      return;
    }

    // ---------- 世界控制 ----------
    const worldAction = pathname.match(/^\/api\/world\/(init|start|stop|reload|reset|clearmsg|inject)$/);
    if (worldAction && method === "POST") {
      const action = worldAction[1];
      const body = (await readJson(req, 4 * 1024 * 1024).catch(() => ({}))) as Record<string, unknown>;
      let text = "";
      try {
        switch (action) {
          case "init":
            text = await host.initWorld(body.force === true);
            break;
          case "start":
            text = await host.startWorld();
            break;
          case "stop":
            text = await host.stopWorld();
            break;
          case "reload":
            text = await host.reloadWorld();
            break;
          case "reset":
            text = await host.resetWorld();
            break;
          case "clearmsg":
            text = await host.clearMsg();
            break;
          case "inject":
            text = await host.injectEvent(String(body.text ?? ""));
            break;
        }
      } catch (err) {
        return void sendJSON(res, 500, { error: String((err as Error).message ?? err) });
      }
      this.sendLifecycle(`world.${action}`, { text });
      sendJSON(res, 200, { ok: true, text });
      return;
    }

    // ---------- 穿越 ----------
    if (pathname === "/api/crossing" && method === "GET") {
      const info = host.crossingInfo();
      const cc = host.config.crossing;
      sendJSON(res, 200, {
        ...info,
        server: {
          enabled: cc.serverEnabled,
          running: info.serverEnabled,
          host: cc.host,
          port: cc.port,
          worldName: cc.worldName.trim() || "未命名世界",
        },
        botName: cc.botName.trim() || "异界来客",
        invites: access.kind === "admin"
          ? cc.invites.map((i) => ({ name: i.name, enabled: i.enabled, code: i.code }))
          : [],
        // 配置里的完整世界列表（含未填全的，便于用户发现配置问题）
        configuredWorlds: cc.worlds.map((w) => ({
          name: w.name,
          url: w.url,
          hasCode: !!w.inviteCode.trim(),
          allowVoluntary: w.allowVoluntary,
          note: w.note,
        })),
      });
      return;
    }
    if (pathname === "/api/crossing/travel" && method === "POST") {
      const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
      const target = String(body.world ?? "").trim();
      if (!target) return void sendJSON(res, 400, { error: "缺少 world 参数（世界名，或 home 送回）" });
      try {
        const text = await host.crossingForce(target);
        this.sendLifecycle("crossing.travel", { target, text });
        sendJSON(res, 200, { ok: true, text });
      } catch (err) {
        sendJSON(res, 500, { error: String((err as Error).message ?? err) });
      }
      return;
    }

    // ---------- 工作窗口（stream.jsonl） ----------
    if (pathname === "/api/stream" && method === "GET") {
      const entries = await readJsonl(host.files.stream, 3000);
      sendJSON(res, 200, { entries });
      return;
    }

    // ---------- 归档 ----------
    if (pathname === "/api/archive" && method === "GET") {
      sendJSON(res, 200, await listArchive(host.files.archiveDir,
        access.kind === "visitor" ? (name) => canReadDataFile(access.session, name) : undefined));
      return;
    }
    if (pathname === "/api/archive/file" && method === "GET") {
      const folder = q.get("folder") ?? "";
      const file = q.get("file") ?? "";
      if (!safeBasename(file)) return void sendJSON(res, 400, { error: "非法文件名" });
      if (folder && !safeBasename(folder)) return void sendJSON(res, 400, { error: "非法归档名" });
      if (access.kind === "visitor" && !canReadDataFile(access.session, file)) {
        return void sendJSON(res, 403, { error: "访客无权读取该归档文件的内容" });
      }
      const target = folder
        ? path.join(host.files.archiveDir, folder, file)
        : path.join(host.files.archiveDir, file);
      const ok = await fs.access(target).then(() => true, () => false);
      if (!ok) return void sendJSON(res, 404, { error: "文件不存在" });
      const content = await fs.readFile(target, "utf8").catch(() => "");
      sendJSON(res, 200, { name: file, content });
      return;
    }
    if (pathname === "/api/archive/save" && method === "POST") {
      const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
      const text = await host.saveArchive(String(body.label ?? ""));
      this.sendLifecycle("archive.save", { text });
      sendJSON(res, 200, { ok: true, text });
      return;
    }
    if (pathname === "/api/archive/restore" && method === "POST") {
      const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
      const name = String(body.name ?? "");
      if (!safeBasename(name)) return void sendJSON(res, 400, { error: "非法归档名" });
      try {
        const text = await host.restoreArchive(name);
        this.sendLifecycle("archive.restore", { name, text });
        sendJSON(res, 200, { ok: true, text });
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message ?? String(err) });
      }
      return;
    }
    if (pathname === "/api/archive/delete" && method === "POST") {
      const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
      const name = String(body.name ?? "");
      if (!safeBasename(name)) return void sendJSON(res, 400, { error: "非法归档名" });
      try {
        await host.deleteArchive(name);
        this.sendLifecycle("archive.delete", { name });
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message ?? String(err) });
      }
      return;
    }

    // ---------- 相册 ----------
    if (pathname === "/api/gallery" && method === "GET") {
      sendJSON(res, 200, { entries: await galleryEntries(host) });
      return;
    }
    if (pathname === "/api/gallery/file" && method === "GET") {
      const category = normalizeCategory(q.get("category") ?? "");
      const name = sanitizeFileName(q.get("name") ?? "");
      if (!category || !name) return void sendJSON(res, 400, { error: "非法分类或文件名" });
      const file = path.join(host.gallery.dirOf(category), name);
      await sendFile(res, file);
      return;
    }
    if (pathname === "/api/gallery/upload" && method === "POST") {
      const category = normalizeCategory(q.get("category") ?? "") ?? UNSORTED_CATEGORY;
      const name = sanitizeFileName(q.get("name") ?? "");
      const data = await readBody(req, 64 * 1024 * 1024);
      if (!data.length) return void sendJSON(res, 400, { error: "空文件" });
      const tmp = path.join(host.webuiDir, `upload-${Date.now()}`);
      await fs.mkdir(host.webuiDir, { recursive: true });
      await fs.writeFile(tmp, data);
      const sha = await host.gallery.hashFile(tmp);
      const finalName = await host.gallery.importFile(
        tmp,
        category,
        name || `upload-${Date.now()}${extFor(data)}`,
        sha,
        "",
      );
      await fs.rm(tmp, { force: true });
      this.sendLifecycle("gallery.upload", { category, name: finalName });
      sendJSON(res, 200, { ok: true, category, name: finalName });
      return;
    }
    if (pathname === "/api/gallery/move" && method === "POST") {
      const body = await readJson(req);
      const category = normalizeCategory(String(body.category ?? ""));
      const name = sanitizeFileName(String(body.name ?? ""));
      const target = normalizeCategory(String(body.targetCategory ?? ""));
      if (!category || !name || !target) return void sendJSON(res, 400, { error: "参数不合法" });
      const entry = await host.gallery.resolve(`${category}/${name}`);
      if (!entry) return void sendJSON(res, 404, { error: "文件不存在" });
      const desc = body.description != null && String(body.description).trim() ? String(body.description) : undefined;
      const moved = await host.gallery.move(entry, target, desc);
      this.sendLifecycle("gallery.move", moved);
      sendJSON(res, 200, { ok: true, ...moved });
      return;
    }
    if (pathname === "/api/gallery/description" && method === "POST") {
      const body = await readJson(req);
      const category = normalizeCategory(String(body.category ?? ""));
      const name = sanitizeFileName(String(body.name ?? ""));
      if (!category || !name) return void sendJSON(res, 400, { error: "参数不合法" });
      const entry = await host.gallery.resolve(`${category}/${name}`);
      if (!entry) return void sendJSON(res, 404, { error: "文件不存在" });
      const sha = await host.gallery.hashFile(entry.file);
      await host.gallery.upsertMeta(entry.category, entry.name, sha, String(body.description ?? ""));
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/gallery/remove" && method === "POST") {
      const body = await readJson(req);
      const category = normalizeCategory(String(body.category ?? ""));
      const name = sanitizeFileName(String(body.name ?? ""));
      if (!category || !name) return void sendJSON(res, 400, { error: "参数不合法" });
      const entry = await host.gallery.resolve(`${category}/${name}`);
      if (!entry) return void sendJSON(res, 404, { error: "文件不存在" });
      await host.gallery.remove(entry);
      this.sendLifecycle("gallery.remove", { category, name });
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- 媒体资产库 ----------
    if (pathname === "/api/media" && method === "GET") {
      const rows = await host.media.recent(200);
      sendJSON(res, 200, {
        rows: rows.map((r) => ({
          id: r.id,
          type: r.type,
          mime: r.mime,
          size: r.size,
          summary: r.summary,
          createdAt: r.createdAt,
        })),
      });
      return;
    }
    if (pathname === "/api/media/file" && method === "GET") {
      const row = await host.media.get(Number(q.get("id")) || 0);
      if (!row) return void sendJSON(res, 404, { error: "媒体不存在" });
      await sendFile(res, row.ref.file, row.mime);
      return;
    }

    // ---------- 记事本 ----------
    if (pathname === "/api/notes" && method === "GET") {
      sendJSON(res, 200, { notes: await host.notes() });
      return;
    }
    if (pathname === "/api/notes" && method === "PUT") {
      const body = await readJson(req, 2 * 1024 * 1024);
      await host.writeNote(String(body.name ?? ""), String(body.content ?? ""));
      this.sendLifecycle("notes");
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/notes" && method === "DELETE") {
      const name = q.get("name") ?? "";
      await host.deleteNote(name);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- 数据文件（clock/meta/focus/notify/pinned/archive） ----------
    if (pathname === "/api/data" && method === "GET") {
      const dataFiles = ["clock.json", "meta.json", "focus.json", "notify.json", "pinned.json"];
      const files = [];
      for (const name of dataFiles) {
        if (access.kind === "visitor" && !canReadDataFile(access.session, name)) continue;
        const file = path.join(host.files.base, name);
        const stat = await fs.stat(file).catch(() => null);
        files.push({ name, exists: !!stat, size: stat?.size ?? 0 });
      }
      const archive = access.kind === "visitor"
        ? access.session.grants.has("archive")
          ? await listArchive(host.files.archiveDir, (name) => canReadDataFile(access.session, name))
          : { snapshots: [], legacy: [] }
        : await listArchive(host.files.archiveDir);
      sendJSON(res, 200, { files, archive });
      return;
    }
    if (pathname === "/api/data/file" && method === "GET") {
      const name = q.get("name") ?? "";
      if (!["clock.json", "meta.json", "focus.json", "notify.json", "pinned.json"].includes(name)) {
        return void sendJSON(res, 400, { error: "不允许读取该文件" });
      }
      if (access.kind === "visitor" && !canReadDataFile(access.session, name)) {
        return void sendJSON(res, 403, { error: "访客无权读取该数据文件的内容" });
      }
      const content = await fs.readFile(path.join(host.files.base, name), "utf8").catch(() => "");
      sendJSON(res, 200, { name, content });
      return;
    }
    if (pathname === "/api/data/file" && method === "POST") {
      const body = await readJson(req, 8 * 1024 * 1024);
      const name = String(body.name ?? "");
      if (!["clock.json", "meta.json", "focus.json", "notify.json", "pinned.json"].includes(name)) {
        return void sendJSON(res, 400, { error: "不允许写入该文件" });
      }
      try {
        JSON.parse(String(body.content ?? ""));
      } catch {
        return void sendJSON(res, 400, { error: "内容不是合法 JSON" });
      }
      await host.files.atomicWrite(path.join(host.files.base, name), String(body.content ?? ""));
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- 调试 ----------
    if (pathname === "/api/calls" && method === "GET") {
      sendJSON(res, 200, { calls: callStore.recent(), retention: { maxCalls: 200, maxBytes: 32 * 1024 * 1024, maxCallBytes: 8 * 1024 * 1024, persistent: false } });
      return;
    }
    if (pathname.startsWith("/api/calls/") && method === "GET") {
      const id = pathname.slice("/api/calls/".length);
      const detail = callStore.detail(id, Number(q.get("after") ?? 0), q.get("request") !== "0");
      if (!detail) return void sendJSON(res, 404, { error: "调用不存在或已超出历史保留数量" });
      sendJSON(res, 200, detail);
      return;
    }
    if (pathname === "/api/debug" && method === "GET") {
      const n = Math.min(Number(q.get("n")) || 200, 500);
      sendJSON(res, 200, { entries: debug.recent(n), snapshot: debug.snapshot() });
      return;
    }
    if (pathname === "/api/debug" && method === "DELETE") {
      debug.clear();
      sendJSON(res, 200, { ok: true });
      return;
    }

    // ---------- Token 用量统计 ----------
    if (pathname === "/api/usage" && method === "GET") {
      const n = Math.min(Number(q.get("n")) || 300, 2000);
      const summary = usageStore.summary();
      sendJSON(res, 200, {
        summary,
        entries: usageStore.recent(n),
        snapshot: summary.totals.requests,
      });
      return;
    }
    if (pathname === "/api/usage" && method === "DELETE") {
      usageStore.clear();
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/health" && method === "GET") {
      sendJSON(res, 200, { ok: true, version: host.version });
      return;
    }

    sendJSON(res, 404, { error: "Not Found" });
  }
}

// ---------- 辅助 ----------

/**
 * secret 字段回传浏览器时的占位值：前端显示为「已设置/未设置」，而非真实密钥。
 * 与 restoreSecrets 配对：用户未修改的掩码值在保存时还原为原值。
 */
export const SECRET_MASK = "******";

/** 判断某个路径段是否为通配（array[任意索引] / dict[任意键]） */
function segMatches(seg: string, key: string | number): boolean {
  return seg === "*" || seg === String(key);
}

/** 判断 config 路径是否命中 schema 里的一条 secret 路径（支持 "*" 通配段） */
function pathIsSecret(pathSegs: string[], secretPaths: string[]): boolean {
  return secretPaths.some((p) => {
    const parts = p.split(".");
    if (parts.length !== pathSegs.length) return false;
    for (let i = 0; i < parts.length; i++) {
      if (!segMatches(parts[i]!, pathSegs[i]!)) return false;
    }
    return true;
  });
}

/** 深度复制 config，并把 secret 字段替换为掩码 */
function maskSecrets(config: unknown, secretPaths: string[]): unknown {
  const walk = (v: unknown, segs: string[]): unknown => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, [...segs, String(i)]));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        const nextSegs = [...segs, k];
        out[k] = pathIsSecret(nextSegs, secretPaths) ? maskOf(val) : walk(val, nextSegs);
      }
      return out;
    }
    return v;
  };
  return walk(config, []);
}

/** 掩码占位：字符串用固定掩码；数组的 secret 元素同理（每个元素用掩码） */
function maskOf(val: unknown): unknown {
  if (val == null || val === "") return val;
  return SECRET_MASK;
}

/** 按点分隔路径从配置对象取值（无 "*" 通配；用于回填 group + apiKey） */
function getSecretByPath(config: unknown, pathStr: string): string {
  const parts = pathStr.split(".").filter(Boolean);
  let cur: unknown = config;
  for (const p of parts) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[p];
    else return "";
  }
  return typeof cur === "string" ? cur : "";
}

/** 把「仍是掩码（未改动）」的 secret 字段还原为当前真实值；非掩码值（用户新填）原样保留 */
function restoreSecrets(next: unknown, current: unknown, secretPaths: string[]): unknown {
  const walk = (n: unknown, c: unknown, segs: string[]): unknown => {
    if (Array.isArray(n)) {
      const curArr = Array.isArray(c) ? c : [];
      return n.map((item, i) => walk(item, curArr[i], [...segs, String(i)]));
    }
    if (n && typeof n === "object") {
      const curObj = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(n)) {
        const nextSegs = [...segs, k];
        if (pathIsSecret(nextSegs, secretPaths) && val === SECRET_MASK) {
          out[k] = curObj[k];
        } else {
          out[k] = walk(val, curObj[k], nextSegs);
        }
      }
      return out;
    }
    return n;
  };
  return walk(next, current, []);
}

/** 向 OpenAI 兼容端点拉取可选模型列表（GET {baseURL}/models） */
async function fetchLlmModels(baseURL: string, apiKey: string): Promise<string[]> {
  const root = baseURL.replace(/\/+$/, "");
  const url = root + "/models";
  const res = await llmFetch(url, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`列出模型失败 (${res.status})：${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: { id?: string }[] };
  const ids = (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && !!id);
  return ids;
}

async function galleryEntries(host: WebUIHost): Promise<unknown[]> {
  const counts = await host.gallery.counts();
  const rows = await host.gallery.ctx.database.get("yesimbot_world_gallery", {});
  const metaByKey = new Map(rows.map((r) => [`${r.category}/${r.name}`, r]));
  const entries: unknown[] = [];
  for (const { category, count } of counts) {
    const names = await host.gallery.listNames(category);
    for (const name of names) {
      const meta = metaByKey.get(`${category}/${name}`);
      const file = path.join(host.gallery.dirOf(category), name);
      const stat = await fs.stat(file).catch(() => null);
      entries.push({
        category,
        name,
        description: meta?.description ?? "",
        size: stat?.size ?? 0,
        image: isImageFile(name),
      });
    }
  }
  return entries;
}

function extFor(data: Buffer): string {
  // 嗅探常见图片头，缺省 .png
  if (data.length >= 4) {
    if (data[0] === 0xff && data[1] === 0xd8) return ".jpg";
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return ".png";
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return ".gif";
    if (data.length >= 12 && data.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  }
  return ".png";
}

async function readAllNews(file: string): Promise<unknown[]> {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

async function editNews(file: string, index: number, content: string): Promise<void> {
  const entries = (await readAllNews(file)) as { content: string }[];
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("索引越界");
  entries[index]!.content = content;
  await writeNewsLines(file, entries);
}

async function removeNews(file: string, index: number): Promise<void> {
  const entries = (await readAllNews(file)) as { content: string }[];
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("索引越界");
  entries.splice(index, 1);
  await writeNewsLines(file, entries);
}

/** 固定/取消固定 facts.jsonl 的一条小事记（固定条目在重置世界/重新创世时保留） */
async function setFactsPinned(file: string, index: number, pinned: boolean): Promise<void> {
  const entries = (await readAllNews(file)) as { content: string; pinned?: boolean }[];
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("索引越界");
  if (pinned) entries[index]!.pinned = true;
  else delete entries[index]!.pinned;
  await writeNewsLines(file, entries);
}

async function writeNewsLines(file: string, entries: unknown[]): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await fs.rename(tmp, file);
}

async function readJsonl(file: string, max: number): Promise<unknown[]> {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  const lines = raw.split("\n").slice(-max);
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

/** 归档快照（文件夹，含 manifest 备注）与旧版扁平归档文件 */
interface ArchiveSnapshot {
  name: string;
  mtime: number;
  label: string;
  files: { name: string; size: number }[];
}

async function listArchive(
  dir: string,
  canRead: (name: string) => boolean = () => true,
): Promise<{ snapshots: ArchiveSnapshot[]; legacy: string[] }> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { snapshots: [], legacy: [] };
  }
  const snapshots: ArchiveSnapshot[] = [];
  const legacy: string[] = [];
  for (const n of names) {
    const full = path.join(dir, n);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const files: { name: string; size: number }[] = [];
      let label = "";
      try {
        for (const f of await fs.readdir(full)) {
          const fsStat = await fs.stat(path.join(full, f)).catch(() => null);
          if (fsStat?.isFile() && canRead(f)) files.push({ name: f, size: fsStat.size });
        }
        const manifest = await fs.readFile(path.join(full, "manifest.json"), "utf8").catch(() => "");
        if (manifest) {
          const m = JSON.parse(manifest) as { label?: string };
          label = String(m.label ?? "");
        }
      } catch {
        /* 读取失败按无备注处理 */
      }
      snapshots.push({
        name: n,
        mtime: stat.mtimeMs,
        label,
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
      });
    } else {
      if (canRead(n)) legacy.push(n);
    }
  }
  snapshots.sort((a, b) => b.mtime - a.mtime);
  return { snapshots, legacy: legacy.sort().reverse() };
}

async function sendFile(res: http.ServerResponse, file: string, mime?: string): Promise<void> {
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      "content-type": mime ?? mimeOf(file),
      "content-length": data.length,
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    if (!res.headersSent) sendJSON(res, 404, { error: "文件不存在" });
  }
}

function safeBasename(name: string): boolean {
  return !!name && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

/**
 * 端点 → 数据块映射（用于访客分级过滤）。返回 null 表示「无需整端点授权」：
 * 打包端点（overview/state）的字段级裁剪已在 handleApi 内处理，或（health）本就公开。
 * 写端点也会走进这里，但访客的写请求已在 handle 层统一 403，不会到达。
 */
/** 原始文件可聚合多个权限块；不能把“笔记/存档可见”视为其全部内容可见。 */
function canReadDataFile(session: VisitorSession, name: string): boolean {
  const grants: Record<string, VisitorGrant[]> = {
    "Bot_Definition.md": ["definitions"],
    "World_Definition.md": ["definitions"],
    "Bot_Status.md": ["bot_status"],
    "World_Status.md": ["world_status"],
    "News.jsonl": ["news"],
    "facts.jsonl": ["facts"],
    "stream.jsonl": ["stream"],
    "pinned.json": ["definitions", "bot_status", "stream"],
    "clock.json": ["overview"],
    "meta.json": ["world_status"],
    "focus.json": ["devices"],
    "notify.json": ["devices"],
    "phoneShell.html": ["world_status"],
    "manifest.json": ["archive"],
  };
  const required = grants[name];
  // 新增状态文件默认不向访客暴露，显式声明内容所属权限后再开放。
  return !!required && required.every((grant) => session.grants.has(grant));
}

function grantForEndpoint(pathname: string, method: string): VisitorGrant | null {
  if (pathname === "/api/bot/growth") return "notes";
  // 设备
  if (pathname === "/api/devices" || pathname === "/api/computer/screen") return "devices";

  // 打包端点：字段级裁剪
  if (pathname === "/api/overview" || pathname === "/api/state") return null;
  if (pathname === "/api/state/phone-shell") return "world_status";

  // 定义 / 配置 / 提示词 / 用量 / 调试
  if (pathname === "/api/definitions/bot" || pathname === "/api/definitions/world") return "definitions";
  if (pathname === "/api/config") return "config";
  if (pathname === "/api/prompts") return "prompts";
  if (pathname === "/api/usage") return "usage";
  if (pathname === "/api/debug" || pathname === "/api/calls" || pathname.startsWith("/api/calls/")) return "debug";

  // 意识流 / 归档
  if (pathname === "/api/stream") return "stream";
  if (pathname === "/api/archive" || pathname === "/api/archive/file") return "archive";

  // 相册 / 媒体
  if (pathname === "/api/gallery" || pathname === "/api/gallery/file") return "gallery";
  if (pathname === "/api/media" || pathname === "/api/media/file") return "gallery";

  // 笔记 / 数据文件
  if (pathname === "/api/notes" || pathname === "/api/data" || pathname === "/api/data/file") return "notes";

  // 穿越状态
  if (pathname === "/api/crossing") return "crossing";

  // 健康检查：公开
  if (pathname === "/api/health") return null;

  // 未匹配：默认无需整端点授权（admin 场景或已在字段裁剪内覆盖）
  return null;
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) throw new Error(`请求体过大（上限 ${limit} 字节）`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<Record<string, unknown>> {
  const data = await readBody(req, limit);
  if (!data.length) return {};
  const parsed = JSON.parse(data.toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function sendJSON(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** 概览页「访问与安全」：本机 + 局域网可访问的 WebUI 地址列表 */
function accessUrls(host: string, port: number): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  const push = (label: string, h: string) => {
    const url = `http://${h}:${port}/`;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ label, url });
  };
  const wild = host === "0.0.0.0" || host === "::" || host === "";
  if (!wild) push(host === "127.0.0.1" || host === "localhost" ? "本机" : "监听地址", host);
  push("本机", "127.0.0.1");
  if (wild) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list ?? []) {
        if (it.internal || it.family !== "IPv4") continue;
        push("局域网", it.address);
      }
    }
  }
  return out;
}
