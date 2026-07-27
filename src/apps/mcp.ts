/**
 * 极简 MCP（Model Context Protocol）客户端：零依赖实现。
 *
 * 只实现让 MCP Server 作为"手机 App"所需的最小集：
 * initialize / notifications/initialized / tools/list / tools/call。
 * 传输支持 stdio（子进程，行分隔 JSON-RPC）与 Streamable HTTP（POST，JSON 或 SSE 响应）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "koishi";
import type { McpServerConfig } from "../config.js";
import type { AppRawTool, WorldApp } from "./app.js";

const PROTOCOL_VERSION = "2025-03-26";
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface McpTransport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

// ---------- stdio 传输 ----------

class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  private dead: Error | null = null;

  constructor(command: string, args: string[], logger: Logger) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text) logger.debug("[mcp:%s] %s", command, text.slice(0, 500));
    });
    this.child.on("error", (err) => this.fail(new Error(`MCP 进程启动失败：${err.message}`)));
    this.child.on("exit", (code, signal) => this.fail(new Error(`MCP 进程已退出（${signal ?? `code ${code}`}）`)));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // 忽略非 JSON 输出（有些 server 把日志混进 stdout）
      }
      this.settle(msg);
    }
  }

  private settle(msg: JsonRpcMessage): void {
    if (msg.id === undefined || msg.id === null) return; // 通知/请求，忽略
    const entry = this.pending.get(Number(msg.id));
    if (!entry) return;
    this.pending.delete(Number(msg.id));
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message ?? `MCP 错误（code ${msg.error.code}）`));
    else entry.resolve(msg.result);
  }

  private fail(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private write(payload: Record<string, unknown>): void {
    if (this.dead) throw this.dead;
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求 ${method} 超时（${timeoutMs / 1000}s）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async close(): Promise<void> {
    this.fail(new Error("连接已关闭"));
    this.child.kill();
  }
}

// ---------- Streamable HTTP 传输 ----------

class HttpTransport implements McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private url: string,
    private headers: Record<string, string>,
  ) {}

  private buildHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...this.headers,
    };
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}：${text.slice(0, 300)}`);
    }
    const ctype = res.headers.get("content-type") ?? "";
    const msg = ctype.includes("text/event-stream")
      ? await readSseResponse(res, id, timeoutMs)
      : pickResponse((await res.json()) as JsonRpcMessage | JsonRpcMessage[], id);
    if (!msg) throw new Error(`MCP 响应中没有 id=${id} 的结果`);
    if (msg.error) throw new Error(msg.error.message ?? `MCP 错误（code ${msg.error.code}）`);
    return msg.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    // 202 Accepted 是标准响应；其他状态忽略即可（通知不要求结果）
    void res.body?.cancel().catch(() => {});
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    // 按规范尝试终止会话，不支持的 server 会返回 405，忽略
    await fetch(this.url, {
      method: "DELETE",
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
    this.sessionId = null;
  }
}

function pickResponse(data: JsonRpcMessage | JsonRpcMessage[], id: number): JsonRpcMessage | null {
  const list = Array.isArray(data) ? data : [data];
  return list.find((m) => Number(m.id) === id) ?? null;
}

/** 从 SSE 流中读出指定 id 的 JSON-RPC 响应（读到即取消流） */
async function readSseResponse(res: Response, id: number, timeoutMs: number): Promise<JsonRpcMessage | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error("MCP SSE 响应超时");
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔；data: 行为 JSON-RPC 消息
      let sep: number;
      while ((sep = buffer.search(/\n\n|\r\n\r\n/)) >= 0) {
        const eventText = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer.slice(sep, sep + 2) === "\n\n" ? 2 : 4));
        const data = eventText
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          const msg = pickResponse(JSON.parse(data) as JsonRpcMessage | JsonRpcMessage[], id);
          if (msg) return msg;
        } catch {
          /* 跳过非 JSON 事件 */
        }
      }
      if (done) return null;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// ---------- MCP App ----------

/** 把一个 MCP Server 包装成手机里的 App */
export class McpApp implements WorldApp {
  private transport: McpTransport | null = null;

  constructor(
    private cfg: McpServerConfig,
    private logger: Logger,
  ) {}

  get id(): string {
    return this.cfg.name;
  }

  get name(): string {
    return this.cfg.name;
  }

  get description(): string {
    return this.cfg.description || "外部应用";
  }

  private async connect(): Promise<McpTransport> {
    if (this.transport) return this.transport;
    let transport: McpTransport;
    if (this.cfg.transport === "http") {
      if (!this.cfg.url.trim()) throw new Error("未配置 MCP Server 的 url");
      transport = new HttpTransport(this.cfg.url.trim(), this.cfg.headers ?? {});
    } else {
      // 便于配置：args 为空时允许把整条命令写在 command 里（按空白切分）
      let command = this.cfg.command.trim();
      let args = this.cfg.args ?? [];
      if (!command) throw new Error("未配置 MCP Server 的 command");
      if (!args.length && command.includes(" ")) {
        const parts = command.split(/\s+/);
        command = parts[0]!;
        args = parts.slice(1);
      }
      transport = new StdioTransport(command, args, this.logger);
    }
    try {
      const init = (await transport.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "koishi-plugin-yesimbot-world", version: "0.1.0" },
        },
        CONNECT_TIMEOUT_MS,
      )) as Record<string, unknown> | undefined;
      await transport.notify("notifications/initialized");
      const serverInfo = (init?.serverInfo ?? {}) as Record<string, unknown>;
      this.logger.info("MCP「%s」已连接：%s %s", this.cfg.name, serverInfo.name ?? "?", serverInfo.version ?? "");
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    }
    this.transport = transport;
    return transport;
  }

  async open(): Promise<{ tools: AppRawTool[] }> {
    const transport = await this.connect();
    const tools: AppRawTool[] = [];
    let cursor: string | undefined;
    do {
      const result = (await transport.request(
        "tools/list",
        cursor ? { cursor } : {},
        CALL_TIMEOUT_MS,
      )) as Record<string, unknown>;
      const page = Array.isArray(result?.tools) ? (result.tools as Record<string, unknown>[]) : [];
      for (const t of page) {
        const name = String(t.name ?? "").trim();
        if (!name) continue;
        tools.push({
          name,
          description: String(t.description ?? "").trim(),
          inputSchema:
            typeof t.inputSchema === "object" && t.inputSchema !== null
              ? (t.inputSchema as Record<string, unknown>)
              : undefined,
        });
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor && tools.length < 100);
    return { tools };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const transport = await this.connect();
    const result = (await transport.request(
      "tools/call",
      { name: tool, arguments: args },
      CALL_TIMEOUT_MS,
    )) as Record<string, unknown>;
    const content = Array.isArray(result?.content) ? (result.content as Record<string, unknown>[]) : [];
    const parts = content.map((c) => {
      if (c.type === "text") return String(c.text ?? "");
      if (c.type === "image") return "[图片（此应用返回的图片暂无法查看）]";
      if (c.type === "audio") return "[音频（此应用返回的音频暂无法收听）]";
      if (c.type === "resource" || c.type === "resource_link") return `[资源 ${String((c.resource as Record<string, unknown>)?.uri ?? c.uri ?? "")}]`;
      return `[${String(c.type ?? "?")}]`;
    });
    const text = parts.join("\n").trim() || "（应用没有返回内容）";
    if (result?.isError) throw new Error(text);
    return text;
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.close().catch(() => {});
  }
}
