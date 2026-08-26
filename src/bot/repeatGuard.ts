/**
 * 通用防重复工具调用守卫（advisory loop-breaker）。
 *
 * 移植自 DeepSeek Harness 的 `dsh-repeat-tool-reminder` 设计：
 * - 观察每个工具调用，按 (工具名, 规范化参数) 做链式计数；
 * - 连续重复达到配置阈值时，注入**递进式**提醒（首阈值温和、后续详细），
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
  /** 连续重复达到这些次数时各触发一次提醒（升序；首个为温和档，其余为详细档）。空数组 = 关闭 */
  thresholds: number[];
  /** 参与计数的工具名匹配（* 通配）；空 = 全部工具 */
  include: string[];
  /** 透明的工具名匹配（既不计数也不重置，如 bookkeeping 工具） */
  exclude: string[];
  /** 详细提醒里参数预览的字符上限（防止大 payload 无限进入下一次请求） */
  argumentsPreviewChars: number;
  /** 交替循环检测：窗口内序列以某个短周期重复这么多轮才判定为循环（默认 3） */
  cycleRepeatMin?: number;
  /** 交替循环检测的最大周期长度（默认 3，覆盖 act↔wait 两元循环与 act↔wait↔x 三元循环） */
  cycleMaxPeriod?: number;
}

/** 温和首阈值提醒（不点名工具与参数） */
const GENTLE_REMINDER =
  "你正在用完全相同的参数重复调用同一个工具。仔细分析上一次的结果再决定是否要继续：" +
  "如果事情还没完成，试着换一种做法或换一组参数，而不是原样再调用一次；如果已经掌握足够信息，也可以就此收尾。";

/** 详细提醒：点名工具、连击数、规范化参数 */
function detailedReminder(toolName: string, count: number, canonicalArguments: string, previewChars: number): string {
  const preview =
    canonicalArguments.length <= previewChars
      ? canonicalArguments
      : `${canonicalArguments.slice(0, previewChars)}… (+${canonicalArguments.length - previewChars} more chars)`;
  return (
    `检测到重复的工具调用：\n` +
    `- 工具：${toolName}\n` +
    `- 连续调用次数：${count}\n` +
    `- 参数：${preview}\n` +
    `这些重复调用没有在推进进度。不要再用这组参数调用这个工具；请查看最新一次结果，` +
    `换一个动作、换一组参数，或在证据已足够时结束当前任务。`
  );
}

/** 交替循环提醒：点明这是一段周期性反复、没有新结果的循环 */
function cycleReminder(pattern: string[], periods: number): string {
  const seq = pattern.join(" → ");
  return (
    `检测到你在反复执行同一组动作：${seq}（这一组动作已连续重复了 ${periods} 轮，每轮完全相同）。` +
    `你陷入了循环——没有任何新结果、没有任何进展。请立即停下这个模式：` +
    `换一件完全不同的事情做，或者如果手头的事其实已经做完，就明确收尾，不要再重复这一组动作。`
  );
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

/**
 * 一个 Bot 的防重复守卫。每个 BotAgent 持有一个实例；
 * 每观察到一次工具调用调用 observe()，返回「是否该注入提醒 + 提醒文本」。
 */
export class RepeatGuard {
  private thresholds: number[];
  private thresholdSet: Set<number>;
  private firstThreshold: number | null;
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
    this.firstThreshold = this.thresholds[0] ?? null;
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
   * 观察一次工具调用，推进链计数与交替循环检测；命中时返回提醒文本，否则返回 null。
   * 被拦截/拒绝（denied）的调用也走这里——模型反复撞被拒的调用，正是最该打断的循环。
   */
  observe(call: ToolCallRecord): string | null {
    const canonical = canonicalizeArgs(call.arguments ?? {});
    const key = JSON.stringify([call.name, canonical]);

    // —— 交替循环检测（跨工具周期性反复，如 act↔wait）——
    // 单工具连续计数无效的场景：两个工具交替，每个工具的连续计数都被对方重置。
    // 窗口记录**所有**工具调用（含 wait/rest 这类"呼吸间隙"），因为交替循环正是由
    // "动作工具 + 计时工具" 成对反复构成；只有单工具连续计数才用 tracked() 过滤。
    const cycleNotice = this.pushWindowAndDetectCycle(key);
    if (cycleNotice) return cycleNotice;

    if (this.thresholds.length === 0) return null;
    if (!this.tracked(call.name)) return null;
    const count = this.chain !== null && this.chain.key === key ? this.chain.count + 1 : 1;
    this.chain = { key, count };
    if (!this.thresholdSet.has(count)) return null;
    if (count === this.firstThreshold) return GENTLE_REMINDER;
    return detailedReminder(call.name, count, canonical, this.argumentsPreviewChars);
  }

  /** 推进滚动窗口，检测短周期反复；命中返回循环提醒，否则 null */
  private pushWindowAndDetectCycle(key: string): string | null {
    this.window.push(key);
    const maxLen = this.cycleMaxPeriod * this.cycleRepeatMin;
    if (this.window.length > maxLen) this.window = this.window.slice(this.window.length - maxLen);
    const n = this.window.length;
    // 尝试周期 p：窗口末尾至少要有 p*cycleRepeatMin 条，且这些条目是「前 p 条」的精确重复
    for (let p = 1; p <= this.cycleMaxPeriod; p++) {
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
      const pattern = this.window.slice(n - need, n - need + p).map(extractName);
      // 签名用「旋转归一的周期模式」——act,wait 循环无论从哪个相位截取，
      // 归一后签名一致，避免滚窗每滑一格就换相位、导致同一循环反复刷屏。
      const rawPattern = this.window.slice(n - need, n - need + p);
      const signature = canonicalCycle(rawPattern);
      if (signature === this.lastCycleSignature) return null; // 同一个循环不重复刷屏
      this.lastCycleSignature = signature;
      return cycleReminder(pattern, this.cycleRepeatMin);
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
