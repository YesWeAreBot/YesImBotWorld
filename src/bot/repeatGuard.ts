/**
 * 通用防重复工具调用守卫（advisory loop-breaker）。
 *
 * 移植自 DeepSeek Harness 的 `dsh-repeat-tool-reminder` 设计：
 * - 观察每个工具调用，按 (工具名, 规范化参数) 做链式计数；
 * - 连续重复达到配置阈值时，追加简短提醒，
 *   让模型停止复读、去读上一次结果、换一个动作或收尾；
 * - **纯 advisory**：从不否决、从不改写、从不拦截调用（决策权完全在模型）；
 * - **denied 调用也计数**（被拦截/拒绝的工具调用同样推进链，模型反复撞被拒的调用正是该打断的循环）；
 * - **排除项透明**：exclude 里的 bookkeeping 工具既不计数也不重置，避免穿插无关工具洗白循环。
 *
 * 与 KV cache 的关系：提醒以独立事件追加到意识流末尾（append-only），不改写任何历史前缀，
 * 因此不破坏 BotContext 精心维护的前缀缓存命中。
 */

import type { ToolCallRecord } from "../types.js";

/** 规范化参数：deep key-sort 后 JSON.stringify，让仅属性顺序不同的对象算同一次重复 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
    return sorted;
  }
  return value;
}

/** 参数规范化（deep key-sort + stringify） */
export function canonicalizeArgs(argumentsValue: Record<string, unknown>): string {
  return JSON.stringify(sortJsonValue(argumentsValue));
}

/** `*` 通配转锚定正则（其余正则元字符按字面匹配） */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

/** 链式计数状态：当前键与连击数 */
interface Chain {
  key: string;
  count: number;
}

export interface RepeatGuardConfig {
  /** 连续重复达到这些次数时各触发一次提醒（升序；每个阈值提示一次）。空数组 = 关闭 */
  thresholds: number[];
  /** 参与计数的工具名匹配（* 通配）；空 = 全部工具 */
  include: string[];
  /** 透明的工具名匹配（既不计数也不重置，如 bookkeeping 工具） */
  exclude: string[];
  /** 内部诊断参数预览的字符上限；不呈现给角色。 */
  argumentsPreviewChars: number;
  /** 交替循环检测：窗口内序列以某个短周期重复这么多轮才判定为循环（默认 3） */
  cycleRepeatMin?: number;
  /** 交替循环检测的最大周期长度（默认 3，覆盖 act↔wait 两元循环与 act↔wait↔x 三元循环） */
  cycleMaxPeriod?: number;
}

/** A repetition pattern is known; whether the attempts helped is not. */
function repeatedCallReminder(toolName: string): string {
  return `同一 ${toolName} 调用正在重复，请先检查上次结果。`;
}

function cycleReminder(pattern: string[]): string {
  return `操作序列正在重复：${pattern.join(" → ")}。请先检查上次结果。`;
}

function previewArguments(canonical: string, maxChars: number): string {
  return canonical.length <= maxChars ? canonical : `${canonical.slice(0, maxChars)}… (+${canonical.length - maxChars} more chars)`;
}

/** 校验阈值（dsh 同款 fail-loud：空/非整数/小于 2/重复都抛错，绝不静默回退） */
function validateThresholds(values: number[]): number[] {
  if (values.length === 0) return [];
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`repeatGuard: invalid threshold ${value} — every threshold must be an integer >= 2`);
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error("repeatGuard: `thresholds` must not contain duplicates");
  }
  return [...values].sort((a, b) => a - b);
}

/** 观察结果：是否触发提醒 + 被重复的工具名 + 重复程度（供 agent 决定「仅提醒/移除工具/强制 rest」） */
export interface ObserveResult {
  /** 提醒文本（命中阈值时才有；未命中但计数仍在累加时为 null） */
  notice: string | null;
  /** 本次被判定为重复的工具名 */
  toolName: string;
  /** 单工具链的当前连续计数 */
  count: number;
  /** 是否是交替循环（而非单工具重复） */
  cycle: boolean;
  /** Internal diagnostics only; model notices never repeat arguments or counts. */
  argumentsPreview: string;
  cyclePattern?: string[];
  cyclePeriods?: number;
}

/**
 * 一个 Bot 的防重复守卫。每个 BotAgent 持有一个实例；
 * 每观察到一次工具调用调用 observe()，返回「是否该注入提醒 + 被重复的工具 + 程度」。
 */
export class RepeatGuard {
  private thresholds: number[];
  private thresholdSet: Set<number>;
  private includePatterns: RegExp[];
  private excludePatterns: RegExp[];
  private argumentsPreviewChars: number;
  private chain: Chain | null = null;
  /** 交替循环检测：最近被 track 的调用键（归一化）滚动窗口，用于识别周期性反复 */
  private window: string[] = [];
  private cycleRepeatMin: number;
  private cycleMaxPeriod: number;
  /** 上一次循环提醒时的窗口快照，避免同一个循环每来一次就重复提醒刷屏 */
  private lastCycleSignature: string | null = null;

  constructor(config: RepeatGuardConfig) {
    this.thresholds = validateThresholds(config.thresholds);
    this.thresholdSet = new Set(this.thresholds);
    this.includePatterns = config.include.map(wildcardToRegExp);
    this.excludePatterns = config.exclude.map(wildcardToRegExp);
    this.argumentsPreviewChars = config.argumentsPreviewChars;
    this.cycleRepeatMin = config.cycleRepeatMin ?? 3;
    this.cycleMaxPeriod = config.cycleMaxPeriod ?? 3;
  }

  /** 该工具是否参与链（exclude/include 判定） */
  private tracked(toolName: string): boolean {
    if (this.includePatterns.length > 0 && !this.includePatterns.some((p) => p.test(toolName))) return false;
    return !this.excludePatterns.some((p) => p.test(toolName));
  }

  /**
   * 观察一次工具调用，推进链计数与交替循环检测；返回结构化结果（被排除的工具返回 null）。
   * notice 仅在命中提醒阈值/检出循环时为非 null；count 始终反映当前连续计数，
   * 供调用方（breakLoop）独立判定「达到多高就该移除工具/强制 rest」，不必绑定提醒阈值点。
   * 被拦截/拒绝（denied）的调用也走这里——模型反复撞被拒的调用，正是最该打断的循环。
   */
  observe(call: ToolCallRecord): ObserveResult | null {
    const canonical = canonicalizeArgs(call.arguments ?? {});
    const key = JSON.stringify([call.name, canonical]);

    // —— 交替循环检测（跨工具周期性反复，如 act↔wait，从周期 p=2 起）——
    const cycleNotice = this.pushWindowAndDetectCycle(key);
    if (cycleNotice) {
      return { notice: cycleNotice.notice, toolName: call.name, count: 0, cycle: true,
        argumentsPreview: previewArguments(canonical, this.argumentsPreviewChars), cyclePattern: cycleNotice.pattern, cyclePeriods: this.cycleRepeatMin };
    }

    if (this.thresholds.length === 0) return null;
    if (!this.tracked(call.name)) return null;
    const count = this.chain !== null && this.chain.key === key ? this.chain.count + 1 : 1;
    this.chain = { key, count };
    const notice = this.thresholdSet.has(count) ? repeatedCallReminder(call.name) : null;
    return { notice, toolName: call.name, count, cycle: false, argumentsPreview: previewArguments(canonical, this.argumentsPreviewChars) };
  }

  /** 推进滚动窗口，检测「交替循环」；命中返回循环提醒，否则 null。
   *  只从周期 p=2 起检测——p=1 的「连续相同工具」交给单工具链计数，
   *  这里专治两个或更多工具交替反复的循环（单工具链识别不了的那种）。 */
  private pushWindowAndDetectCycle(key: string): { notice: string; pattern: string[] } | null {
    this.window.push(key);
    const maxLen = this.cycleMaxPeriod * this.cycleRepeatMin;
    if (this.window.length > maxLen) this.window = this.window.slice(this.window.length - maxLen);
    const n = this.window.length;
    // 尝试周期 p（从 2 起）：窗口末尾至少要有 p*cycleRepeatMin 条，且这些条目是「前 p 条」的精确重复
    for (let p = 2; p <= this.cycleMaxPeriod; p++) {
      const need = p * this.cycleRepeatMin;
      if (n < need) continue;
      // 检查末尾 need 条是否 = 周期 p 的模式重复 cycleRepeatMin 次
      let ok = true;
      for (let r = 1; r < this.cycleRepeatMin && ok; r++) {
        for (let k = 0; k < p; k++) {
          if (this.window[n - need + r * p + k] !== this.window[n - need + k]) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      // 命中了：取该周期内的键名（去重后按出现顺序）作为提醒里的「那组动作」
      const rawPattern = this.window.slice(n - need, n - need + p);
      // 要求周期内的键「不完全相同」——若全相同（如 act,act 伪装成周期 2），
      // 那是连续同工具、归单工具链计数，不是真正的交替循环。
      if (new Set(rawPattern).size < 2) continue;
      const pattern = rawPattern.map(extractName);
      // 签名用「旋转归一的周期模式」——act,wait 循环无论从哪个相位截取，
      // 归一后签名一致，避免滚窗每滑一格就换相位、导致同一循环反复刷屏。
      const signature = canonicalCycle(rawPattern);
      if (signature === this.lastCycleSignature) return null; // 同一个循环不重复刷屏
      this.lastCycleSignature = signature;
      return { notice: cycleReminder(pattern), pattern };
    }
    return null;
  }

  /** 用户/外部新一轮输入到来时重置链（对应 dsh 的 agent/pre-step 重置） */
  reset(): void {
    this.chain = null;
    this.window = [];
    this.lastCycleSignature = null;
  }
}

/** 从「name + canonical」归一键里抽出工具名 */
function extractName(key: string): string {
  try {
    const arr = JSON.parse(key) as [string, string];
    return arr[0];
  } catch {
    return key;
  }
}

/** 把一个周期模式旋转到字典序最小的相位，作为相位无关的循环签名 */
function canonicalCycle(pattern: string[]): string {
  if (pattern.length === 0) return "";
  let best = pattern.join("\u0000");
  for (let i = 1; i < pattern.length; i++) {
    const rotated = [...pattern.slice(i), ...pattern.slice(0, i)].join("\u0000");
    if (rotated < best) best = rotated;
  }
  return best;
}
