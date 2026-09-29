import type { ClockAuthority } from "../clock.js";

export const WORLD_TIME_AUTHORITY = "程序时间边界（不可由世界定义或旧状态覆盖）：timeAuthority 是本轮唯一的当前时刻，其 tu 是同一次采样的世界计时；1 TU 的世界秒数、历法、时区与 UTC 偏移均由程序给出。source=wall_clock 时当前日期来自现实服务器时钟，不能自行创设另一个今天；source=world_calendar 时使用作者定义与配置确定并持久化的历法，不能改成现实今天。realWorld 只描述世界/设备性质，不决定时间同步。stateAsOf 是旧状态成立时刻，不是现在；按 elapsedWorldSeconds 推进已经授权的自然过程，不能为配合旧叙述移动时钟或跳到动作计划的未来。初始化、观察、行动、到离场与演化均遵守这条边界。过去事件、人物记忆、文件原文、引文和假设中的日期保持原样，它们不是当前日期。时间资料属于引擎裁定上下文，不意味着角色无需钟表就知道精确日期时间。";

export interface CurrentTimeConflict { start: number; end: number; actual: string; expected: string }
const datePattern = "(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{4}/\\d{1,2}/\\d{1,2}|\\d{4}年\\d{1,2}月\\d{1,2}日)";
const currentLabel = "(?:(?:当前|现在|此刻)(?:的)?(?:世界)?(?:日期|时间|时刻|年份)?|世界当前(?:日期|时间|时刻|年份)|今天|今日)";
const reported = /(?:假设|假如|假定|如果|倘若|若是|比如|例如|以为|认为|猜测|记得|回忆|当时|那时|彼时|过去|此前|曾经|原文|引用|记载|日记|信中|书中|写着|写道|说道|他说|她说|声称|表示|标题|题为|名为|约定|计划|预计|\b(?:if|suppose|assuming|said|says|wrote|believed|remembered)\b)/i;

function protectedRanges(text: string, suppliedSpeech?: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const pattern of [/```[\s\S]*?(?:```|$)/g, /`[^`\n]*`/g, /"(?:\\.|[^"\\])*"|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|《[^》]*》/g, /^\s*>.*$/gm]) {
    for (const match of text.matchAll(pattern)) ranges.push({ start: match.index!, end: match.index! + match[0].length });
  }
  if (suppliedSpeech) {
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(suppliedSpeech, from); if (index < 0) break;
      ranges.push({ start: index, end: index + suppliedSpeech.length }); from = index + suppliedSpeech.length;
    }
  }
  return ranges;
}
function dateValue(value: string): string {
  const parts = value.match(/\d+/g)!;
  return `${parts[0]}-${parts[1]!.padStart(2, "0")}-${parts[2]!.padStart(2, "0")}`;
}

/** Narrow checks of explicit present-date assertions, never arbitrary dates in prose. */
export function currentTimeConflicts(text: string, authority: ClockAuthority, suppliedSpeech?: string): CurrentTimeConflict[] {
  if (!authority.date) return [];
  const protectedText = protectedRanges(text, suppliedSpeech), found: CurrentTimeConflict[] = [];
  const patterns = [
    new RegExp(`${currentLabel}\\s*(?:为|是|[:：=])?\\s*(${datePattern})(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?`, "g"),
    new RegExp(`^[ \\t]*(?:#{1,6}\\s*|[-*]\\s*)?(?:日期|时间|时刻)[ \\t]*[:：=][ \\t]*(${datePattern})(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?`, "gm"),
  ];
  const consider = (start: number, end: number, actual: string, expected: string): void => {
    if (actual === expected || protectedText.some(range => start < range.end && end > range.start)) return;
    const clauseStart = Math.max(text.lastIndexOf("\n", start - 1), text.lastIndexOf("。", start - 1), text.lastIndexOf("；", start - 1), text.lastIndexOf("，", start - 1));
    const before = text.slice(Math.max(clauseStart + 1, start - 48), start);
    if (reported.test(before) || /(?:不是|并非|不再是|不能认为)\s*$/.test(before)) return;
    const heading = [...text.slice(0, start).matchAll(/^#{1,6}\s+(.+)$/gm)].at(-1)?.[1];
    if (heading && /(?:历史|回忆|往事|日记|引文|档案|计划|假设)/.test(heading)) return;
    if (!found.some(item => start < item.end && end > item.start)) found.push({ start, end, actual, expected });
  };
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) consider(match.index!, match.index! + match[0].length, dateValue(match[1]!), authority.date);
  const yearPatterns = [
    new RegExp(`${currentLabel}\\s*(?:为|是|[:：=])?\\s*(\\d{4})年`, "g"),
    /(?:当前|现在)(?:的)?年份\s*(?:为|是|[:：=])?\s*(\d{4})(?:年)?/g,
    /^[ \t]*(?:#{1,6}\s*|[-*]\s*)?(?:日期|时间|时刻|年份)[ \t]*[:：=][ \t]*(\d{4})年/gm,
  ];
  for (const pattern of yearPatterns) for (const match of text.matchAll(pattern)) consider(match.index!, match.index! + match[0].length, match[1]!, authority.date.slice(0, 4));
  if (authority.weekday) {
    const pattern = new RegExp(`${currentLabel}\\s*(?:为|是|[:：=])?\\s*(?:星期|礼拜|周)([一二三四五六日天])`, "g");
    for (const match of text.matchAll(pattern)) consider(match.index!, match.index! + match[0].length, "星期" + (match[1] === "天" ? "日" : match[1]), authority.weekday);
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Read-time isolation only. Author definitions, archived history and quoted dates are untouched. */
export function projectCurrentTime(text: string, authority: ClockAuthority, suppliedSpeech?: string): string {
  let result = text;
  for (const conflict of currentTimeConflicts(text, authority, suppliedSpeech).reverse()) result = result.slice(0, conflict.start) + "〔旧的当前日期断言已隔离，当前时刻以程序时钟为准〕" + result.slice(conflict.end);
  return result;
}

export function assertCurrentTime(text: string, authority: ClockAuthority, field: string, suppliedSpeech?: string): void {
  const conflict = currentTimeConflicts(text, authority, suppliedSpeech)[0];
  if (conflict) throw new Error(`WORLD_TIME_CONFLICT: ${field}把当前日期写成${conflict.actual}，程序时钟为${conflict.expected}（${authority.timeLine}，${authority.timeZone}）。结果未保存；只修正当前时间断言，不改写历史事件、引文或假设。`);
}
