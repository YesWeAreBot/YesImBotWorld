/**
 * LLM Token 用量统计（模块级单例，与 debug.ts 平级）。
 *
 * ChatClient / TextClient 在每次请求完成后调用 record()，持久化到
 * <webuiDir>/usage.jsonl（JSONL 追加写，崩溃最多丢最后一条），
 * WebUI 服务器据此提供 /api/usage 汇总接口。
 */

import { promises as fs } from "node:fs";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface UsageRecord {
  id: number;
  /** 现实时间戳（ms） */
  ts: number;
  /** 来源显示名（Bot / World / 解释器 / LLM） */
  label: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 输入中命中提示词缓存的 token 数（后端不支持时为 0） */
  cachedTokens: number;
}

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  byLabel: Record<string, UsageTotals>;
  byModel: Record<string, UsageTotals>;
  /** 按日（本地日期）倒序 */
  byDay: { day: string; totals: UsageTotals }[];
  /** 最近 48 小时按小时（本地时间）正序，空桶补零 */
  byHour: { hour: string; ts: number; totals: UsageTotals }[];
}

export class UsageStore {
  private file = "";
  /** 累计聚合的持久化文件（与明细 usage.jsonl 分离，不受明细裁剪影响） */
  private aggFile = "";
  private records: UsageRecord[] = [];
  /** 全程累计聚合：总数 / 按标签 / 按模型 / 按日（不随明细裁剪） */
  private agg: UsageAggregate = emptyAggregate();
  private nextId = 1;
  private readonly maxKeep = 5000;
  /** 目录就绪（mkdir 完成）的承诺，用于让 record 的追加写等待目录存在后再落盘 */
  private ensured: Promise<void> | null = null;

  /** 初始化持久化文件；WebUI 启动时调用。重复调用只生效一次 */
  init(filePath: string): void {
    if (this.file) return;
    this.file = filePath;
    if (!filePath) return;
    this.aggFile = filePath.replace(/\.jsonl$/, ".agg.json");
    // 先确保父目录存在（同步），并**同步**确定累计聚合（读 agg 文件，或从明细一次性迁移）——
    // 必须同步完成，否则 init 后立即到来的 record 会与异步迁移重叠，导致重复计数。
    const dir = path.dirname(filePath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 目录创建失败不致命 */
    }
    this.loadAggregateSync();
    this.ensured = Promise.resolve();
    void this.loadDetail();
  }

  /**
   * 同步确定累计聚合：读 usage.agg.json；若不存在（旧版本/首次），从 usage.jsonl 全量迁移重建。
   * 用 readFileSync 保证 init 返回时 agg 已就绪，后续 record 的同步累计不会重叠。
   */
  private loadAggregateSync(): void {
    let raw = "";
    try {
      raw = readFileSync(this.aggFile, "utf8");
      this.agg = normalizeAggregate(JSON.parse(raw));
      return;
    } catch {
      /* 无累计文件：迁移 */
    }
    // 迁移：无 agg 文件时，从明细 jsonl 全量重建累计（不裁剪）
    try {
      raw = readFileSync(this.file, "utf8");
      const agg = emptyAggregate();
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (typeof r.id !== "number" || typeof r.ts !== "number") continue;
          if (typeof r.cachedTokens !== "number") r.cachedTokens = 0;
          accumulateRecord(agg, r);
        } catch {
          /* skip */
        }
      }
      this.agg = agg;
      // 迁移结果落盘，此后走增量
      void this.persistAgg().catch(() => {});
    } catch {
      /* 明细文件也不存在：全新开始 */
    }
  }

  /** 异步恢复明细记录（裁剪到 maxKeep，仅用于表格展示与按小时趋势） */
  private async loadDetail(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (typeof r.id !== "number" || typeof r.ts !== "number") continue;
          if (typeof r.cachedTokens !== "number") r.cachedTokens = 0; // 兼容旧记录
          this.records.push(r);
          if (r.id >= this.nextId) this.nextId = r.id + 1;
        } catch {
          /* skip */
        }
      }
      if (this.records.length > this.maxKeep) this.records.splice(0, this.records.length - this.maxKeep);
    } catch {
      /* 无历史文件 */
    }
  }

  /** 记录一次用量；持久化失败不影响主流程（追加写，fire-and-forget） */
  record(r: Omit<UsageRecord, "id" | "ts" | "cachedTokens"> & { cachedTokens?: number }): void {
    const rec: UsageRecord = { id: this.nextId++, ts: Date.now(), cachedTokens: 0, ...r };
    this.records.push(rec);
    if (this.records.length > this.maxKeep) this.records.splice(0, this.records.length - this.maxKeep);
    // 累计聚合：同步累加（init 已同步就绪 agg，不会与迁移重叠）
    accumulateRecord(this.agg, rec);
    if (this.file) {
      const line = JSON.stringify(rec) + "\n";
      void (this.ensured ?? Promise.resolve())
        .then(() => fs.appendFile(this.file, line))
        .then(() => this.persistAgg())
        .catch(() => {});
    }
  }

  recent(n: number): UsageRecord[] {
    return this.records.slice(-n);
  }

  clear(): void {
    this.records = [];
    this.agg = emptyAggregate();
    this.nextId = 1;
    if (this.file) void fs.writeFile(this.file, "").catch(() => {});
    if (this.aggFile) void fs.writeFile(this.aggFile, "").catch(() => {});
  }

  summary(): UsageSummary {
    // 累计总量 / 按标签 / 按模型 / 按日：来自全程累计聚合（不随明细裁剪）
    const byDay = Object.entries(this.agg.byDay)
      .map(([day, totals]) => ({ day, totals }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    // 最近 48 小时按小时：只能从明细算（近期视图）
    const byHourMap = new Map<number, UsageTotals>();
    const hourMs = 3600_000;
    const hourFloor = Math.floor(Date.now() / hourMs) * hourMs;
    const hourFrom = hourFloor - 47 * hourMs;
    for (const r of this.records) {
      if (r.ts < hourFrom) continue;
      const bucket = Math.floor(r.ts / hourMs) * hourMs;
      let ht = byHourMap.get(bucket);
      if (!ht) byHourMap.set(bucket, (ht = emptyTotals()));
      accumulate(ht, r);
    }
    const byHour: UsageSummary["byHour"] = [];
    for (let ts = hourFrom; ts <= hourFloor; ts += hourMs) {
      const d = new Date(ts);
      byHour.push({
        hour: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`,
        ts,
        totals: byHourMap.get(ts) ?? emptyTotals(),
      });
    }
    return {
      totals: this.agg.totals,
      byLabel: this.agg.byLabel,
      byModel: this.agg.byModel,
      byDay,
      byHour,
    };
  }

  private async persistAgg(): Promise<void> {
    if (!this.aggFile) return;
    const tmp = `${this.aggFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.agg));
    await fs.rename(tmp, this.aggFile);
  }
}

/** 全程累计聚合（持久化到 usage.agg.json） */
interface UsageAggregate {
  totals: UsageTotals;
  byLabel: Record<string, UsageTotals>;
  byModel: Record<string, UsageTotals>;
  /** 本地日期（YYYY-MM-DD）→ 当日累计 */
  byDay: Record<string, UsageTotals>;
}

function emptyAggregate(): UsageAggregate {
  return { totals: emptyTotals(), byLabel: {}, byModel: {}, byDay: {} };
}

/** 从磁盘读取的聚合对象补全缺失字段（容错旧版本/损坏） */
function normalizeAggregate(raw: unknown): UsageAggregate {
  const base = emptyAggregate();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<UsageAggregate>;
  if (obj.totals && typeof obj.totals === "object") base.totals = normalizeTotals(obj.totals);
  if (obj.byLabel && typeof obj.byLabel === "object") base.byLabel = normalizeTotalsMap(obj.byLabel as Record<string, unknown>);
  if (obj.byModel && typeof obj.byModel === "object") base.byModel = normalizeTotalsMap(obj.byModel as Record<string, unknown>);
  if (obj.byDay && typeof obj.byDay === "object") base.byDay = normalizeTotalsMap(obj.byDay as Record<string, unknown>);
  return base;
}

function normalizeTotalsMap(map: Record<string, unknown>): Record<string, UsageTotals> {
  const out: Record<string, UsageTotals> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === "object") out[k] = normalizeTotals(v);
  }
  return out;
}

function normalizeTotals(t: unknown): UsageTotals {
  if (!t || typeof t !== "object") return emptyTotals();
  const o = t as Partial<UsageTotals>;
  return {
    requests: num(o.requests),
    promptTokens: num(o.promptTokens),
    completionTokens: num(o.completionTokens),
    totalTokens: num(o.totalTokens),
    cachedTokens: num(o.cachedTokens),
  };
}

function num(v: unknown): number {
  return Number(v) || 0;
}

/** 把一条记录累加进聚合（totals / byLabel / byModel / byDay） */
function accumulateRecord(agg: UsageAggregate, r: UsageRecord): void {
  accumulate(agg.totals, r);
  add(agg.byLabel, r.label || "未知", r);
  add(agg.byModel, r.model || "未知", r);
  const d = new Date(r.ts);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  add(agg.byDay, day, r);
}

function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
}

function accumulate(t: UsageTotals, r: UsageRecord): void {
  t.requests++;
  t.promptTokens += r.promptTokens;
  t.completionTokens += r.completionTokens;
  t.totalTokens += r.totalTokens;
  t.cachedTokens += r.cachedTokens || 0;
}

function add(map: Record<string, UsageTotals>, key: string, r: UsageRecord): void {
  let t = map[key];
  if (!t) map[key] = t = emptyTotals();
  accumulate(t, r);
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 模块级单例：全局共享 */
export const usageStore = new UsageStore();
