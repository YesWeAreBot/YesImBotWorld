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

import { Agent, fetch as undiciFetch, Response as UndiciResponse } from "undici";
import { ChatCompletionError } from "./errors.js";

export type LlmResponse = UndiciResponse;

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

/**
 * 逐行读取流式响应体（OpenAI SSE / llama.cpp NDJSON 都按行切分）。
 * 同时兼容两种换行；每行 trim 后回调（空行跳过）。
 */
export async function forEachStreamLine(res: LlmResponse, onLine: (line: string) => void, onText?: (text: string) => void): Promise<void> {
  if (!res.body) throw new Error("LLM 响应无 body 流（后端不支持流式？）");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      onText?.(text);
      buf += text;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (raw) onLine(raw);
      }
    }
    const tail = decoder.decode();
    onText?.(tail);
    buf += tail;
    buf
      .trim()
      .split("\n")
      .forEach((l) => {
        const t = l.trim();
        if (t) onLine(t);
      });
  } catch (error) {
    // Releasing the lock alone leaves a rejected SSE response generating upstream.
    // Cancel before returning the endpoint lease, without masking the parser error.
    try { await reader.cancel(error); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Native APIs use framed SSE (including multiline data), sometimes returning JSON
 * even when stream was requested. Preserve the wire text for the call inspector. */
export async function readProtocolStream(
  res: LlmResponse,
  onEvent: (event: { event: string; data: string }) => void,
  onText?: (text: string) => void,
): Promise<unknown | undefined> {
  if (!res.body) throw new ChatCompletionError("LLM_STREAM_INCOMPLETE", "响应没有可读取的内容。");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let mode: "sse" | "json" | undefined = /text\/event-stream/i.test(res.headers.get("content-type") ?? "") ? "sse" : undefined;
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) onEvent({ event, data: data.join("\n") });
    event = "message";
    data = [];
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let body = colon < 0 ? "" : value.slice(colon + 1);
    if (body.startsWith(" ")) body = body.slice(1);
    if (field === "event") event = body;
    else if (field === "data") data.push(body);
  };
  const consume = (text: string, eof = false) => {
    buffer += text;
    if (!mode && buffer.trimStart()) mode = /^[\[{]/.test(buffer.trimStart()) ? "json" : "sse";
    if (mode !== "sse") return;
    // Keep a trailing CR until the next chunk: it may be the first half of CRLF.
    for (;;) {
      const match = /[\r\n]/.exec(buffer);
      if (!match || (!eof && match[0] === "\r" && match.index === buffer.length - 1)) break;
      const at = match.index;
      const width = buffer[at] === "\r" && buffer[at + 1] === "\n" ? 2 : 1;
      line(buffer.slice(0, at));
      buffer = buffer.slice(at + width);
    }
    if (eof) {
      if (buffer) line(buffer);
      buffer = "";
      dispatch();
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      onText?.(text);
      consume(text);
    }
    const tail = decoder.decode();
    if (tail) onText?.(tail);
    consume(tail, true);
    if (mode === "sse") return undefined;
    try { return JSON.parse(buffer); }
    catch { throw new ChatCompletionError("LLM_RESPONSE_INVALID", "响应不是有效的 SSE 或 JSON。"); }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* keep the original failure */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
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
