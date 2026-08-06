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
import path from "node:path";
import type { WebUIConfig, Config } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { GalleryStore } from "../media/gallery.js";
import { normalizeCategory, UNSORTED_CATEGORY, sanitizeFileName } from "../media/gallery.js";
import type { MediaStore } from "../media/store.js";
import type { Prompts, PromptOverrides } from "../prompts.js";
import type { WorldClock } from "../clock.js";
import { introspect, validateConfig } from "./schema.js";
import { debug, type DebugEntry } from "./debug.js";
import { PAGE_HTML } from "./page.js";

export interface BotStatusSummary {
  running: boolean;
  waiting: string | null;
  streamLength: number;
  approxChars: number;
  pendingTasks: number;
}

export interface NoteEntry {
  title: string;
  content: string;
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
  appOpen(): string | null;
  computerOn(): string | null;
  phoneDown(): boolean;
  focusChannels(): string[];
  prompts(): Prompts;
  savePromptsOverrides(overrides: PromptOverrides): Promise<void>;
  initWorld(force: boolean): Promise<string>;
  startWorld(): Promise<string>;
  stopWorld(): Promise<string>;
  reloadWorld(): Promise<string>;
  resetWorld(): Promise<string>;
  clearMsg(): Promise<string>;
  injectEvent(text: string): Promise<string>;
  applyConfig(next: Config): Promise<{ message: string; port: number }>;
  notes(): Promise<NoteEntry[]>;
  writeNote(name: string, content: string): Promise<void>;
  deleteNote(name: string): Promise<void>;
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

  constructor(private host: WebUIHost) {
    this.cfg = host.config.webui;
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
    const base = path.basename(rel);
    let signal: string | null = null;
    switch (base) {
      case "Bot_Status.md":
        signal = "botStatus";
        break;
      case "World_Status.md":
        signal = "worldStatus";
        break;
      case "News.db":
        signal = "news";
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
    if (!signal) return;
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
    const since = Number(sinceRaw ?? 0) || 0;
    const client: SseClient = { res, lastId: debug.snapshot() };
    // 断线重连：补发期间错过的调试事件
    for (const entry of debug.since(since)) {
      client.lastId = entry.id;
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify({ channel: "debug", entry })}\n\n`);
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
      if (!this.authorized(req, url)) return void sendJSON(res, 401, { error: "需要访问令牌" });
      this.handleSse(req, res, url.searchParams.get("since"));
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (!this.authorized(req, url)) return void sendJSON(res, 401, { error: "需要访问令牌（webui.token 已设置）" });
      await this.handleApi(method, pathname, url, req, res);
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

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    if (!this.cfg.token) return true;
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer ")) return header.slice(7).trim() === this.cfg.token;
    return url.searchParams.get("token") === this.cfg.token;
  }

  private async handleApi(
    method: string,
    pathname: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const host = this.host;
    const q = url.searchParams;

    // ---------- 概览 / 状态 ----------
    if (pathname === "/api/overview" && method === "GET") {
      const clock = host.getClock();
      const bot = host.botStatus();
      const news = await host.files.readNews(8);
      const counts = await host.gallery.counts();
      sendJSON(res, 200, {
        version: host.version,
        baseDir: host.baseDir,
        webuiDir: host.webuiDir,
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
        appOpen: host.appOpen(),
        computerOn: host.computerOn(),
        phoneDown: host.phoneDown(),
        focusChannels: host.focusChannels(),
        news,
        galleryCounts: counts,
        tokenSet: !!this.cfg.token,
      });
      return;
    }

    if (pathname === "/api/state" && method === "GET") {
      sendJSON(res, 200, {
        botStatus: await host.files.readBotStatus(),
        worldStatus: await host.files.readWorldStatus(),
        news: await readAllNews(host.files.news),
        botDef: await host.files.readText(host.files.botDef),
        worldDef: await host.files.readText(host.files.worldDef),
        meta: await host.files.readMeta(),
        initialized: await host.isInitialized(),
      });
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

    // ---------- 配置 ----------
    if (pathname === "/api/config" && method === "GET") {
      sendJSON(res, 200, { schema: introspect(host.configSchema), value: host.config });
      return;
    }
    if (pathname === "/api/config" && method === "POST") {
      const body = await readJson(req, 8 * 1024 * 1024);
      const next = body.config;
      if (!next || typeof next !== "object") {
        return void sendJSON(res, 400, { error: "缺少 config 字段" });
      }
      const errors = validateConfig(host.configSchema, next);
      if (errors.length) return void sendJSON(res, 400, { error: "配置校验失败", errors });
      const result = await host.applyConfig(next as Config);
      sendJSON(res, 200, result);
      return;
    }

    // ---------- 提示词 ----------
    if (pathname === "/api/prompts" && method === "GET") {
      sendJSON(res, 200, {
        defaults: host.prompts().effective(),
        overrides: host.prompts().get(),
      });
      return;
    }
    if (pathname === "/api/prompts" && method === "POST") {
      const { overrides } = await readJson(req, 4 * 1024 * 1024);
      if (!overrides || typeof overrides !== "object") {
        return void sendJSON(res, 400, { error: "缺少 overrides 字段" });
      }
      host.prompts().setOverrides(overrides as PromptOverrides);
      await host.savePromptsOverrides(overrides as PromptOverrides);
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

    // ---------- 工作窗口（stream.jsonl） ----------
    if (pathname === "/api/stream" && method === "GET") {
      const entries = await readJsonl(host.files.stream, 3000);
      sendJSON(res, 200, { entries });
      return;
    }

    // ---------- 归档 ----------
    if (pathname === "/api/archive" && method === "GET") {
      sendJSON(res, 200, { files: await listDir(host.files.archiveDir) });
      return;
    }
    if (pathname === "/api/archive/file" && method === "GET") {
      const name = q.get("name") ?? "";
      if (!safeBasename(name)) return void sendJSON(res, 400, { error: "非法文件名" });
      const file = path.join(host.files.archiveDir, name);
      const content = await fs.readFile(file, "utf8").catch(() => "");
      sendJSON(res, 200, { name, content });
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
        const file = path.join(host.files.base, name);
        const stat = await fs.stat(file).catch(() => null);
        files.push({ name, exists: !!stat, size: stat?.size ?? 0 });
      }
      sendJSON(res, 200, { files, archive: await listDir(host.files.archiveDir) });
      return;
    }
    if (pathname === "/api/data/file" && method === "GET") {
      const name = q.get("name") ?? "";
      if (!["clock.json", "meta.json", "focus.json", "notify.json", "pinned.json"].includes(name)) {
        return void sendJSON(res, 400, { error: "不允许读取该文件" });
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

    if (pathname === "/api/health" && method === "GET") {
      sendJSON(res, 200, { ok: true, version: host.version });
      return;
    }

    sendJSON(res, 404, { error: "Not Found" });
  }
}

// ---------- 辅助 ----------

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

async function listDir(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    const out: string[] = [];
    for (const n of names) {
      const stat = await fs.stat(path.join(dir, n)).catch(() => null);
      if (stat?.isFile()) out.push(n);
    }
    return out.sort().reverse();
  } catch {
    return [];
  }
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
