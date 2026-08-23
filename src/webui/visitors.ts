/**
 * WebUI 访客账号管理：只读、可分级授权、多账号。
 *
 * - 存储：<webuiDir>/visitors.json（管理员在 WebUI 里增删改）。
 * - 密码：scrypt 哈希（含随机盐），不存明文。
 * - 会话：密码登录后派发短期会话 token（内存态，TTL 内有效，重启失效）。
 *
 * 档位（preset）决定默认可见数据块：
 * - operator：全读（含 debug 原始请求/响应体、config、prompts、usage），唯独 bot_status 默认关；
 * - viewer：读世界演化产物（world_status/bot_status/news/facts/stream/notes/gallery/media/
 *   archive/devices/crossing/overview），关 definitions/config/prompts/debug/usage；
 * - custom：按 grants 块开关逐项控制。
 *
 * 两种角色共同承诺：只读。写端点对访客一律拒绝（见 server.ts 的强制）。
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";

/** 数据块：与 WebUI 视图 / API 端点对应的可授权单元 */
export type VisitorGrant =
  | "overview"
  | "world_status"
  | "bot_status"
  | "news"
  | "facts"
  | "stream"
  | "notes"
  | "gallery"
  | "archive"
  | "devices"
  | "crossing"
  | "definitions"
  | "config"
  | "prompts"
  | "debug"
  | "usage";

export type VisitorPreset = "operator" | "viewer" | "custom";

export interface VisitorAccount {
  id: string;
  username: string;
  /** "salt:hash"（scrypt） */
  passwordHash: string;
  preset: VisitorPreset;
  /** 仅 custom 档使用：块 → 是否可见（缺省视为 false） */
  grants?: Partial<Record<VisitorGrant, boolean>>;
  createdAt: number;
}

interface VisitorsFile {
  visitors: VisitorAccount[];
}

/** 档位预设的可见块集合（不含 bot_status 的特殊反向） */
const PRESET_GRANTS: Record<VisitorPreset, VisitorGrant[]> = {
  operator: [
    "overview", "world_status", "news", "facts", "stream", "notes",
    "gallery", "archive", "devices", "crossing",
    "definitions", "config", "prompts", "debug", "usage",
    // 注意：operator 不含 bot_status（运维员不看 Bot 人设/现状）
  ],
  viewer: [
    "overview", "world_status", "bot_status", "news", "facts", "stream",
    "notes", "gallery", "archive", "devices", "crossing",
    // 不含 definitions / config / prompts / debug / usage（用户输入 + 调试内部）
  ],
  custom: [],
};

/** 会话：密码登录后派发，内存态 */
export interface VisitorSession {
  username: string;
  preset: VisitorPreset;
  grants: Set<VisitorGrant>;
  expiresAt: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

export class VisitorStore {
  private sessions = new Map<string, VisitorSession>();
  private loadPromise: Promise<VisitorAccount[]> | null = null;
  private accounts: VisitorAccount[] = [];

  constructor(private file: string) {}

  private async ensureLoaded(): Promise<VisitorAccount[]> {
    if (this.accounts.length) return this.accounts;
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    this.accounts = await this.loadPromise;
    return this.accounts;
  }

  private async load(): Promise<VisitorAccount[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as VisitorsFile;
      if (Array.isArray(parsed?.visitors)) return parsed.visitors;
    } catch {
      /* 无文件 / 解析失败：视为空 */
    }
    return [];
  }

  private async persist(): Promise<void> {
    const data: VisitorsFile = { visitors: this.accounts };
    await fs.mkdir(this.file.replace(/\/visitors\.json$/, ""), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2));
  }

  static hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 32).toString("hex");
    return `${salt}:${hash}`;
  }

  static verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 32).toString("hex");
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** 块的可见集合（preset 展开 / custom 用 grants） */
  static grantsOf(acct: VisitorAccount): Set<VisitorGrant> {
    if (acct.preset === "custom") {
      const set = new Set<VisitorGrant>();
      for (const [k, v] of Object.entries(acct.grants ?? {})) {
        if (v) set.add(k as VisitorGrant);
      }
      return set;
    }
    return new Set(PRESET_GRANTS[acct.preset]);
  }

  // ---------- 账号 CRUD（管理员用） ----------

  async list(): Promise<VisitorAccount[]> {
    const accounts = await this.ensureLoaded();
    return accounts.map(({ passwordHash: _ph, ...safe }) => ({
      ...safe,
      passwordHash: "",
    }));
  }

  async create(username: string, password: string, preset: VisitorPreset): Promise<{ ok: true } | { ok: false; error: string }> {
    const uname = username.trim();
    if (!uname) return { ok: false, error: "用户名不能为空" };
    if (!password) return { ok: false, error: "密码不能为空" };
    const accounts = await this.ensureLoaded();
    if (accounts.some((a) => a.username === uname)) return { ok: false, error: "用户名已存在" };
    accounts.push({
      id: `v_${crypto.randomBytes(8).toString("hex")}`,
      username: uname,
      passwordHash: VisitorStore.hashPassword(password),
      preset,
      createdAt: Date.now(),
    });
    await this.persist();
    return { ok: true };
  }

  async update(id: string, patch: { username?: string; password?: string; preset?: VisitorPreset; grants?: Partial<Record<VisitorGrant, boolean>> }): Promise<{ ok: true } | { ok: false; error: string }> {
    const accounts = await this.ensureLoaded();
    const acct = accounts.find((a) => a.id === id);
    if (!acct) return { ok: false, error: "账号不存在" };
    if (patch.username !== undefined) {
      const uname = patch.username.trim();
      if (!uname) return { ok: false, error: "用户名不能为空" };
      if (accounts.some((a) => a.id !== id && a.username === uname)) return { ok: false, error: "用户名已存在" };
      acct.username = uname;
    }
    if (patch.password) acct.passwordHash = VisitorStore.hashPassword(patch.password);
    if (patch.preset !== undefined) acct.preset = patch.preset;
    if (patch.grants !== undefined) acct.grants = patch.grants;
    await this.persist();
    return { ok: true };
  }

  async remove(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const accounts = await this.ensureLoaded();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, error: "账号不存在" };
    accounts.splice(idx, 1);
    await this.persist();
    return { ok: true };
  }

  // ---------- 登录 / 会话 ----------

  async login(username: string, password: string): Promise<{ token: string } | null> {
    const accounts = await this.ensureLoaded();
    const acct = accounts.find((a) => a.username === username.trim());
    if (!acct || !VisitorStore.verifyPassword(password, acct.passwordHash)) return null;
    const token = crypto.randomBytes(24).toString("base64url");
    this.sessions.set(token, {
      username: acct.username,
      preset: acct.preset,
      grants: VisitorStore.grantsOf(acct),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { token };
  }

  /** 校验会话 token，返回会话（可见块集合）；无效返回 null */
  resolve(token: string | null | undefined): VisitorSession | null {
    if (!token) return null;
    this.sweep();
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() >= s.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  /** 会话是否可见某个数据块 */
  can(session: VisitorSession, grant: VisitorGrant): boolean {
    return session.grants.has(grant);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (now >= v.expiresAt) this.sessions.delete(k);
    }
  }

  /** 数据块列表（custom 档的勾选项枚举，前端渲染用） */
  static allGrants(): VisitorGrant[] {
    return [
      "overview", "world_status", "bot_status", "news", "facts", "stream",
      "notes", "gallery", "archive", "devices", "crossing",
      "definitions", "config", "prompts", "debug", "usage",
    ];
  }
}
