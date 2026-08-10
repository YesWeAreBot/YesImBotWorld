/**
 * LLM Token 用量统计（模块级单例，与 debug.ts 平级）。
 *
 * ChatClient / TextClient 在每次请求完成后调用 record()，持久化到
 * <webuiDir>/usage.jsonl（JSONL 追加写，崩溃最多丢最后一条），
 * WebUI 服务器据此提供 /api/usage 汇总接口。
 */

import { promises as fs } from "node:fs";

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
}

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  byLabel: Record<string, UsageTotals>;
  byModel: Record<string, UsageTotals>;
  /** 按日（本地日期）倒序 */
  byDay: { day: string; totals: UsageTotals }[];
}

export class UsageStore {
  private file = "";
  private records: UsageRecord[] = [];
  private nextId = 1;
  private readonly maxKeep = 5000;

  /** 初始化持久化文件；WebUI 启动时调用。重复调用只生效一次 */
  init(filePath: string): void {
    if (this.file) return;
    this.file = filePath;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (typeof r.id !== "number" || typeof r.ts !== "number") continue;
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
  record(r: Omit<UsageRecord, "id" | "ts">): void {
    const rec: UsageRecord = { id: this.nextId++, ts: Date.now(), ...r };
    this.records.push(rec);
    if (this.records.length > this.maxKeep) this.records.splice(0, this.records.length - this.maxKeep);
    if (this.file) void fs.appendFile(this.file, JSON.stringify(rec) + "\n").catch(() => {});
  }

  recent(n: number): UsageRecord[] {
    return this.records.slice(-n);
  }

  clear(): void {
    this.records = [];
    if (this.file) void fs.writeFile(this.file, "").catch(() => {});
  }

  summary(): UsageSummary {
    const totals: UsageTotals = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const byLabel: Record<string, UsageTotals> = {};
    const byModel: Record<string, UsageTotals> = {};
    const byDayMap = new Map<string, UsageTotals>();
    for (const r of this.records) {
      totals.requests++;
      totals.promptTokens += r.promptTokens;
      totals.completionTokens += r.completionTokens;
      totals.totalTokens += r.totalTokens;
      add(byLabel, r.label || "未知", r);
      add(byModel, r.model || "未知", r);
      const d = new Date(r.ts);
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      let dt = byDayMap.get(day);
      if (!dt) byDayMap.set(day, (dt = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }));
      dt.requests++;
      dt.promptTokens += r.promptTokens;
      dt.completionTokens += r.completionTokens;
      dt.totalTokens += r.totalTokens;
    }
    const byDay = [...byDayMap.entries()]
      .map(([day, totals2]) => ({ day, totals: totals2 }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    return { totals, byLabel, byModel, byDay };
  }
}

function add(map: Record<string, UsageTotals>, key: string, r: UsageRecord): void {
  let t = map[key];
  if (!t) map[key] = t = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  t.requests++;
  t.promptTokens += r.promptTokens;
  t.completionTokens += r.completionTokens;
  t.totalTokens += r.totalTokens;
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 模块级单例：全局共享 */
export const usageStore = new UsageStore();
