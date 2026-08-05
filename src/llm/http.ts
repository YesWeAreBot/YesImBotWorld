/**
 * LLM 请求专用 fetch。
 *
 * 为什么不用全局 fetch：Node 内置 fetch（undici）默认 headersTimeout = 300 秒——
 * 响应头 5 分钟内不到达就掐断连接，抛出笼统的 "TypeError: fetch failed"。
 * LLM 推理（长 prompt 评估、与 Bot-LLM 并发争抢算力时）经常合法地超过 5 分钟，
 * 典型症状：act 裁定期间 Bot-LLM 持续生成，World-LLM 的响应被拖过时限，
 * 每次 act 都在几分钟后以 "fetch failed" 失败。
 *
 * 这里用显式的 undici Agent 关闭响应头/响应体超时：LLM 请求要么等到结果，
 * 要么由调用方的 AbortSignal 主动取消。同时把 undici 藏在 err.cause 里的
 * 真实原因（ECONNREFUSED / ECONNRESET / 超时……）展开进错误信息，便于排查。
 */

import { Agent, fetch as undiciFetch } from "undici";

/**
 * 宽松的超时兜底（默认 5 分钟太紧，LLM 推理经常合法地超过它；
 * 但也不能完全不限时——被中间层黑洞的请求会永久悬挂，堵死 World-LLM 的
 * 串行队列与共享端点锁）。10 分钟内没有任何响应视为请求已死。
 */
const LLM_TIMEOUT_MS = 10 * 60_000;

const llmAgent = new Agent({
  // 连接建立超时保留 undici 默认（10 秒），连不上时能尽快报错
  headersTimeout: LLM_TIMEOUT_MS,
  bodyTimeout: LLM_TIMEOUT_MS,
});

export interface LlmFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal | null;
}

export async function llmFetch(url: string, init: LlmFetchInit = {}) {
  try {
    return await undiciFetch(url, { ...init, dispatcher: llmAgent });
  } catch (err) {
    // 主动取消（AbortSignal / AbortSignal.timeout）原样抛出，调用方按取消处理
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
    throw new Error(`LLM 请求失败（${url}）: ${describeError(err)}`, { cause: err });
  }
}

/** 展开 Error.cause 链："fetch failed ← connect ECONNREFUSED 127.0.0.1:8080" */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error) {
    parts.push(cur.message || cur.name);
    cur = cur.cause;
  }
  if (cur !== undefined && cur !== null) parts.push(String(cur));
  return parts.join(" ← ") || String(err);
}
