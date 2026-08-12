/**
 * 穿越客户端（访客侧）：Bot 前往异世界作客时与主世界通信的通道。
 *
 * 实现 RemoteWorldLink：Bot 在外期间，本地 WorldAgent 把 act 裁定 / wait 补叙 /
 * 查看时间 / 世界查询转发到这里，由主世界的 World-LLM 处理；主世界的事件经
 * SSE 推送进 Bot 的意识流。网络上只有任务与事件文本，无任何 API 凭据。
 *
 * 连接管理：SSE 断线自动重连（指数退避）；重试耗尽或会话被主世界终止时，
 * 通过 onLost 通知上层——Bot 会被"弹回"自己的世界。
 */

import crypto from "node:crypto";
import type { Logger } from "koishi";
import type { CrossingWorldConfig } from "../config.js";
import { forEachStreamLine, llmFetch } from "../llm/http.js";
import type { ToolCallRecord } from "../types.js";
import type { RemoteWorldLink } from "../world/agent.js";
import { CROSSING_LIMITS, type CrossingSseMsg, type CrossingTaskKind, type CrossingTaskPayload } from "./protocol.js";

/** 等待主世界任务结果的上限（主世界的 World-LLM 可能排队/推理很久） */
const TASK_TIMEOUT_MS = 12 * 60_000;
/** 普通 POST 请求超时 */
const POST_TIMEOUT_MS = 20_000;
/** SSE 重连：最大尝试次数与退避 */
const RECONNECT_MAX = 6;
const RECONNECT_BASE_MS = 2000;

interface PendingTask {
  resolve: (r: { ok: boolean; content: string }) => void;
  timer: NodeJS.Timeout;
}

export interface CrossingClientHooks {
  /** 主世界推来的事件（进 Bot 意识流） */
  onEvent: (content: string) => void;
  /** 主世界的 World-LLM 更新了 Bot 的状态文件（写回本地 Bot_Status.md） */
  onStatusUpdate?: (content: string) => void;
  /** 连接不可恢复地丢失（重试耗尽 / 被送别）——上层应把 Bot 弹回自己的世界 */
  onLost: (reason: string) => void;
  logger: Logger;
}

export class CrossingClient implements RemoteWorldLink {
  private token = "";
  private active = false;
  private pending = new Map<string, PendingTask>();
  private sseAbort: AbortController | null = null;
  private _worldName: string;

  constructor(
    private target: CrossingWorldConfig,
    private profile: { name: string; persona: string },
    private hooks: CrossingClientHooks,
  ) {
    this._worldName = target.name.trim();
  }

  get worldName(): string {
    return this._worldName;
  }

  private base(): string {
    // 容忍用户把引导页/ping 地址整段粘进来：剥掉尾斜杠与 /crossing/... 后缀
    return this.target.url
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/crossing(?:\/(?:arrive|events|task|leave|ping))?$/, "");
  }

  // ---------- 生命周期 ----------

  async arrive(): Promise<{ worldName: string; timeLine: string }> {
    const r = await this.post("/crossing/arrive", {
      code: this.target.inviteCode,
      name: this.profile.name.slice(0, CROSSING_LIMITS.maxNameChars),
      persona: this.profile.persona.slice(0, CROSSING_LIMITS.maxPersonaChars),
    });
    if (!r.ok || typeof r.token !== "string") {
      throw new Error(String(r.error ?? "对方世界拒绝了到达请求"));
    }
    this.token = r.token;
    if (typeof r.worldName === "string" && r.worldName.trim()) this._worldName = r.worldName.trim();
    this.active = true;
    void this.eventLoop();
    return { worldName: this._worldName, timeLine: String(r.timeLine ?? "") };
  }

  /** 离开：通知主世界并关闭连接（幂等；网络失败不阻塞回家） */
  async leave(): Promise<void> {
    if (!this.active && !this.token) return;
    this.active = false;
    this.sseAbort?.abort();
    this.failAllPending("已离开该世界");
    const token = this.token;
    this.token = "";
    if (token) {
      await this.post("/crossing/leave", { token }).catch(() => {});
    }
  }

  // ---------- RemoteWorldLink（本地 WorldAgent 转发到这里） ----------

  async adjudicateAct(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean> {
    const desc = String(call.arguments.description ?? call.arguments.str ?? JSON.stringify(call.arguments));
    return this.runTask("act", { desc, duration: call.duration ?? 0 }, deliver);
  }

  async resolveWait(call: ToolCallRecord, deliver: (content: string) => void): Promise<boolean> {
    const n = Number(call.arguments.n ?? call.duration ?? 0);
    return this.runTask("wait", { n }, deliver);
  }

  async resolveCheckTime(deliver: (content: string) => void): Promise<boolean> {
    return this.runTask("checkTime", {}, deliver);
  }

  async query(task: string): Promise<string> {
    let content = "";
    const ok = await this.runTask("query", { task }, (c) => (content = c));
    if (!ok || !content.trim()) throw new Error("异世界没有给出回答");
    return content;
  }

  private async runTask(
    kind: CrossingTaskKind,
    payload: CrossingTaskPayload,
    deliver: (content: string) => void,
  ): Promise<boolean> {
    if (!this.active) return false;
    const taskId = crypto.randomUUID();
    const resultP = new Promise<{ ok: boolean; content: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        resolve({ ok: false, content: "" });
      }, TASK_TIMEOUT_MS);
      this.pending.set(taskId, { resolve, timer });
    });
    try {
      const r = await this.post("/crossing/task", { token: this.token, taskId, kind, payload });
      if (!r.ok) throw new Error(String(r.error ?? "任务被拒绝"));
    } catch (err) {
      const p = this.pending.get(taskId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(taskId);
      }
      this.hooks.logger.warn("[穿越] 任务提交失败（%s）: %s", kind, err);
      return false;
    }
    const result = await resultP;
    if (result.ok && result.content.trim()) deliver(result.content);
    return result.ok;
  }

  // ---------- SSE 事件循环 ----------

  private async eventLoop(): Promise<void> {
    let attempt = 0;
    while (this.active) {
      const abort = new AbortController();
      this.sseAbort = abort;
      try {
        const res = await llmFetch(`${this.base()}/crossing/events?token=${encodeURIComponent(this.token)}`, {
          signal: abort.signal,
        });
        if (res.status === 403) {
          this.lost("会话已被主世界终止");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        attempt = 0; // 连接成功，重置重试计数
        let farewell: string | null = null;
        await forEachStreamLine(res, (line) => {
          if (!line.startsWith("data:")) return;
          let msg: CrossingSseMsg;
          try {
            msg = JSON.parse(line.slice(5).trim()) as CrossingSseMsg;
          } catch {
            return;
          }
          if (msg.type === "event") {
            if (msg.content?.trim()) this.hooks.onEvent(msg.content);
          } else if (msg.type === "status_update") {
            if (msg.content?.trim()) this.hooks.onStatusUpdate?.(msg.content);
          } else if (msg.type === "task_result") {
            const p = this.pending.get(msg.taskId);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(msg.taskId);
              p.resolve({ ok: !!msg.ok, content: String(msg.content ?? "") });
            }
          } else if (msg.type === "farewell") {
            farewell = msg.reason || "主世界送别了你";
          }
        });
        if (farewell) {
          this.lost(farewell);
          return;
        }
        // 流正常结束（服务端重启等）：走重连
        throw new Error("事件流中断");
      } catch (err) {
        if (!this.active) return; // 主动离开
        attempt++;
        if (attempt > RECONNECT_MAX) {
          this.lost(`与主世界的连接反复失败（${(err as Error).message ?? err}）`);
          return;
        }
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), 30_000);
        this.hooks.logger.warn("[穿越] 事件流断开（%s），%d 秒后重连（第 %d/%d 次）", err, Math.round(delay / 1000), attempt, RECONNECT_MAX);
        await new Promise((r) => setTimeout(r, delay));
      } finally {
        if (this.sseAbort === abort) this.sseAbort = null;
      }
    }
  }

  private lost(reason: string): void {
    if (!this.active) return;
    this.active = false;
    this.failAllPending(reason);
    this.hooks.onLost(reason);
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, content: "" });
    }
    this.pending.clear();
    void reason;
  }

  // ---------- HTTP ----------

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await llmFetch(`${this.base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      /* 非 JSON 响应 */
    }
    if (!res.ok && data.error === undefined) data.error = `HTTP ${res.status}`;
    return data;
  }
}
