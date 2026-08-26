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

/**
 * 从多套语义等价的文案里随机挑一套（本地实现，避免与 agent 循环依赖）。
 * 只用于非事实性的引导话术；事实性内容（工具名、次数、参数）由调用方在外层拼接，绝不随机。
 * 不传 seed 时用真随机，让同一档每次都可能有不同表述，最大限度打破"固定文案"的循环感。
 */
function pickMeta(variants: string[], seed?: number): string {
  if (variants.length <= 1) return variants[0] ?? "";
  const n = seed !== undefined && Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : Math.floor(Math.random() * 0x7fffffff);
  return variants[n % variants.length]!;
}

/** 温和首阈值提醒（不点名工具与参数），多套变体随机 */
function gentleReminder(): string {
  return pickMeta([
    "你正在用完全相同的参数重复调用同一个工具。仔细分析上一次的结果再决定是否要继续：" +
      "如果事情还没完成，试着换一种做法或换一组参数，而不是原样再调用一次；如果已经掌握足够信息，也可以就此收尾。",
    "你连续用一模一样的参数调用同一个工具。先别急着再来一次——回头看上一次的结果：" +
      "没做完就换个方法或换个参数，做完了就不必再调。",
    "同一个工具、同样的参数，你已经在反复调用了。停下来想想：这是不是真的还需要？" +
      "需要就换个方式，不需要就到此为止。",
  ]);
}

/** 详细提醒：点名工具、连击数、规范化参数。事实部分（工具/次数/参数）原样保留，只随机引导语骨架 */
function detailedReminder(toolName: string, count: number, canonicalArguments: string, previewChars: number): string {
  const preview =
    canonicalArguments.length <= previewChars
      ? canonicalArguments
      : `${canonicalArguments.slice(0, previewChars)}… (+${canonicalArguments.length - previewChars} more chars)`;
  const guidance = pickMeta([
    "这些重复调用没有在推进进度。不要再用这组参数调用这个工具；请查看最新一次结果，换一个动作、换一组参数，或在证据已足够时结束当前任务。",
    "这样重复下去只是在原地踏步。别再原样调用它了——看最新结果，换个动作或参数，或者就此收尾。",
    "同样的调用反复出现，没有带来任何新东西。请停止原样重复：要么换个做法，要么确认任务已完成、直接收尾。",
  ]);
  return `检测到重复的工具调用：\n- 工具：${toolName}\n- 连续调用次数：${count}\n- 参数：${preview}\n${guidance}`;
}

/** 交替循环提醒：点明这是一段周期性反复、没有新结果的循环，多套变体随机 */
function cycleReminder(pattern: string[], periods: number): string {
  const seq = pattern.join(" → ");
  return pickMeta([
    `检测到你在反复执行同一组动作：${seq}（这一组动作已连续重复了 ${periods} 轮，每轮完全相同）。` +
      `你陷入了循环——没有任何新结果、没有任何进展。请立即停下这个模式：换一件完全不同的事情做，或者如果手头的事其实已经做完，就明确收尾，不要再重复这一组动作。`,
    `你在一遍又一遍地做同一组事：${seq}（已经 ${periods} 轮，毫无变化）。这是循环陷阱，没有任何进展。` +
      `现在立刻换一件完全不同的事，或确认完成、就此收尾——别再走这一圈了。`,
    `警告：你在原地打转——${seq} 这组动作已经反复了 ${periods} 轮，每轮都一样，毫无推进。` +
      `请立即打破它：去做别的、完全不同的事，或者如果确实没事可做了就明确结束。`,
  ]);
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
}

/**
 * 一个 Bot 的防重复守卫。每个 BotAgent 持有一个实例；
 * 每观察到一次工具调用调用 observe()，返回「是否该注入提醒 + 被重复的工具 + 程度」。
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
      return { notice: cycleNotice, toolName: call.name, count: 0, cycle: true };
    }

    if (this.thresholds.length === 0) return null;
    if (!this.tracked(call.name)) return null;
    const count = this.chain !== null && this.chain.key === key ? this.chain.count + 1 : 1;
    this.chain = { key, count };
    const notice = !this.thresholdSet.has(count)
      ? null
      : count === this.firstThreshold
        ? gentleReminder()
        : detailedReminder(call.name, count, canonical, this.argumentsPreviewChars);
    return { notice, toolName: call.name, count, cycle: false };
  }

  /** 推进滚动窗口，检测「交替循环」；命中返回循环提醒，否则 null。
   *  只从周期 p=2 起检测——p=1 的「连续相同工具」交给单工具链计数（带参数详细提醒），
   *  这里专治两个或更多工具交替反复的循环（单工具链识别不了的那种）。 */
  private pushWindowAndDetectCycle(key: string): string | null {
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
