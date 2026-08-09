/**
 * send 系工具 duration 的语义判定（koishi-free，纯函数，可独立冒烟测试）。
 *
 * duration 表示的是"打字/说话耗时"还是"过会儿再发"？按消息字数线性估算打字时间：
 * 耗时明显超过估算值（超出门槛倍数）的，视为延期发送的意图——不再当作打字时间。
 */

/** 按消息字数线性估算打字耗时（TU）。len = 消息字符数；charsPerSec = 打字速度（字/现实秒） */
export function typingTimeTU(len: number, charsPerSec: number, unitRealSeconds: number): number {
  if (len <= 0 || charsPerSec <= 0) return 0;
  const secs = len / charsPerSec;
  return Math.max(1, Math.ceil(secs / Math.max(1e-3, unitRealSeconds)));
}

/**
 * "模拟打字"的 duration 上限（TU）：打字估算 × 门槛倍数。
 * duration 不超过它 → 当作打字耗时；超过它 → 视为延期发送意图。
 */
export function typingSlackTU(len: number, charsPerSec: number, unitRealSeconds: number, factor: number): number {
  const typing = typingTimeTU(len, charsPerSec, unitRealSeconds);
  return Math.max(typing, 1) * Math.max(factor, 1);
}
