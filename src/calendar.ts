/**
 * 世界历法：把世界时间（自 epoch 起经过的世界秒数）确定性地格式化为可读字符串。
 *
 * 历法规格在创世（world.init）时由 World-LLM 依据世界定义生成，
 * 持久化在 clock.json 中，此后由代码确定性地完成 TU → 世界时间的换算与渲染。
 */

/** 现实公历：epoch 为可被 Date 解析的时间（如 "2026-01-01 08:00"） */
export interface GregorianCalendar {
  kind: "gregorian";
  /** 世界初始时刻（T=0 对应的世界时间） */
  epoch: string;
}

/** 自定义历法中的一个时间单位 */
export interface CustomCalendarUnit {
  /** 单位名，如 "年" "月" "日" "时" "分" */
  name: string;
  /** 此单位包含多少个下一级单位；最小的单位则表示它等于多少世界秒 */
  count: number;
  /** 显示起点：月/日通常从 1 数起，时/分从 0 数起。默认 0 */
  start?: number;
  /** 显示时的零填充宽度（如 分 用 2 → "05"）。默认不填充 */
  pad?: number;
}

/** 自定义历法：单位从大到小排列，各级均匀进位（不支持大小月/闰年等不规则历法） */
export interface CustomCalendar {
  kind: "custom";
  /** 纪年名，如 "王历"、"星历" */
  era?: string;
  /** 时间单位，从大到小排列，最大的单位无上限 */
  units: CustomCalendarUnit[];
  /** 世界初始时刻（T=0），与 units 一一对应的各单位显示值 */
  epoch: number[];
  /** 格式模板：用 {单位名} 引用各单位的值、{era} 引用纪年名，如 "{era}{年}年{月}月{日}日 {时}:{分}" */
  format?: string;
}

export type CalendarSpec = GregorianCalendar | CustomCalendar;

export const DEFAULT_EPOCH = "2026-01-01 08:00";

export function gregorian(epoch: string): GregorianCalendar {
  return { kind: "gregorian", epoch };
}

/** 把世界时间（自 epoch 起经过的世界秒数）格式化为可读字符串 */
export function formatWorldTime(cal: CalendarSpec, worldSeconds: number): string {
  return cal.kind === "gregorian" ? formatGregorian(cal, worldSeconds) : formatCustom(cal, worldSeconds);
}

/** 历法的一句话描述（用于日志与状态展示） */
export function describeCalendar(cal: CalendarSpec): string {
  if (cal.kind === "gregorian") return `现实公历（初始时刻 ${cal.epoch}）`;
  const units = cal.units.map((u) => u.name).join("/");
  return `自定义历法${cal.era ? `「${cal.era}」` : ""}（单位 ${units}）`;
}

/** 把现实时间戳（ms）渲染为 `YYYY-MM-DD HH:mm` */
export function formatDateMs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatGregorian(cal: GregorianCalendar, worldSeconds: number): string {
  const epochMs = Date.parse(cal.epoch.replace(" ", "T"));
  const base = Number.isNaN(epochMs) ? Date.parse(DEFAULT_EPOCH.replace(" ", "T")) : epochMs;
  return formatDateMs(base + worldSeconds * 1000);
}

function formatCustom(cal: CustomCalendar, worldSeconds: number): string {
  const units = cal.units;
  const n = units.length;
  // 各单位的长度（世界秒）：最小单位的 count 即世界秒数，向上逐级累乘
  const sizes = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    const count = units[i]?.count ?? 1;
    sizes[i] = i === n - 1 ? count : count * (sizes[i + 1] ?? 1);
  }
  // epoch 显示值 → 距历法零点的世界秒
  let epochSeconds = 0;
  for (let i = 0; i < n; i++) {
    const start = units[i]?.start ?? 0;
    epochSeconds += ((cal.epoch[i] ?? start) - start) * (sizes[i] ?? 1);
  }
  let rem = Math.max(0, Math.floor(epochSeconds + worldSeconds));
  const values = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const size = sizes[i] ?? 1;
    values[i] = Math.floor(rem / size) + (units[i]?.start ?? 0);
    rem %= size;
  }
  const rendered = (i: number) => {
    const pad = units[i]?.pad ?? 0;
    const v = String(values[i] ?? 0);
    return pad > 0 ? v.padStart(pad, "0") : v;
  };
  if (cal.format) {
    let out = cal.format.replaceAll("{era}", cal.era ?? "");
    for (let i = 0; i < n; i++) out = out.replaceAll(`{${units[i]?.name ?? ""}}`, rendered(i));
    return out;
  }
  return (cal.era ?? "") + units.map((u, i) => `${rendered(i)}${u.name}`).join("");
}

/** 校验并规整（可能来自 LLM 的）历法规格，不合法时返回 null */
export function parseCalendarSpec(raw: unknown): CalendarSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "gregorian") {
    if (typeof o.epoch !== "string" || Number.isNaN(Date.parse(o.epoch.replace(" ", "T")))) return null;
    return { kind: "gregorian", epoch: o.epoch };
  }
  if (o.kind === "custom") {
    if (!Array.isArray(o.units) || o.units.length === 0 || o.units.length > 8) return null;
    const units: CustomCalendarUnit[] = [];
    for (const u of o.units) {
      if (typeof u !== "object" || u === null) return null;
      const uu = u as Record<string, unknown>;
      const name = typeof uu.name === "string" ? uu.name.trim() : "";
      const count = Number(uu.count);
      if (!name || !Number.isFinite(count) || count < 1) return null;
      const unit: CustomCalendarUnit = { name, count: Math.round(count) };
      const start = Number(uu.start);
      if (Number.isFinite(start)) unit.start = Math.round(start);
      const pad = Number(uu.pad);
      if (Number.isFinite(pad) && pad > 0) unit.pad = Math.round(pad);
      units.push(unit);
    }
    // 单位名必须唯一（作为格式模板的占位符）
    if (new Set(units.map((u) => u.name)).size !== units.length) return null;
    if (!Array.isArray(o.epoch) || o.epoch.length !== units.length) return null;
    const epoch = (o.epoch as unknown[]).map(Number);
    if (epoch.some((v) => !Number.isFinite(v))) return null;
    const spec: CustomCalendar = { kind: "custom", units, epoch: epoch.map(Math.round) };
    if (typeof o.era === "string" && o.era.trim()) spec.era = o.era.trim();
    if (typeof o.format === "string" && o.format.trim()) spec.format = o.format.trim();
    return spec;
  }
  return null;
}
