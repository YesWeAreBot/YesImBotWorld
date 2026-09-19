import type { WorldMessageRow } from "./messages.js";

/** Numeric-only fractional keys have the same order under database collations.
 * No generated key ends in 0, so there is always space before/after any key. */
export function orderBetween(left: string, right?: string): string {
  if (right !== undefined && left >= right) throw new Error("invalid message order interval");
  let result = "";
  for (let i = 0; ; i++) {
    const low = i < left.length ? Number(left[i]) : 0;
    const high = right === undefined ? 10 : i < right.length ? Number(right[i]) : 0;
    if (high - low > 1) return result + String(Math.floor((low + high) / 2));
    result += String(low);
    if (low < high) right = undefined;
  }
}

export function messageSequence(value: unknown): string | null {
  const text = String(value ?? "");
  return /^[1-9]\d*$/.test(text) ? text : null;
}

export const MESSAGE_ORDER_GUIDANCE = "记录按本机收到消息／确认发送的先后排列，已知锚点的补拉历史插回相应位置；平台显示时间与本机时钟可能不同，不能按显示时间重新推断先后。旧记录及无锚点历史会单独标明，无法证明精确先后。";

export function formatMessageTime(row: Pick<WorldMessageRow, "timestamp" | "timestampSource" | "observedAt" | "orderSource">): string {
  const time = (value: Date | string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
  const label = row.timestampSource === "platform" ? "平台时间" : row.timestampSource === "local-confirmed" ? "本机确认发送" : row.timestampSource === "local-observed" ? "本机接收" : "旧记录时间（时钟来源未记录）";
  const observed = row.timestampSource === "platform" && row.observedAt ? `；本机接收 ${time(row.observedAt)}` : "";
  const provenance = row.orderSource === "history-unanchored" ? "；补拉历史，与本地记录先后未确认" : row.orderSource === "history" ? "；按平台锚点补拉，锚点间其他本地消息的精确先后未确认" : row.orderSource === "legacy" ? "；旧记录按入库次序，接收次序未记录" : "";
  return `${label} ${time(row.timestamp)}${observed}${provenance}`;
}
