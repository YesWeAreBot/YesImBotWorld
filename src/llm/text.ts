/**
 * llama.cpp server 原生 /completion 客户端。
 *
 * 使用 grammar (GBNF) 强制输出格式：当语法匹配完成后，唯一合法的下一个 token
 * 是 EOS，因此模型天然在一个完整的工具调用结束时停止 —— 生成过程中 EOS 被
 * 语法屏蔽，实现"禁止 EOS 提前生成"。
 *
 * cache_prompt: true 让 llama.cpp 复用最长公共前缀的 KV cache；
 * 由于上下文渲染是确定性的、追加式的，每次请求几乎全量命中缓存。
 */

import { llmFetch, forEachStreamLine, type LlmResponse } from "./http.js";
import { debug } from "../webui/debug.js";
import { usageStore } from "../webui/usage.js";

export interface TextClientConfig {
  baseURL: string;
  apiKey?: string;
  /** 多模型代理（如 llama-swap）需要 model 字段路由；单模型部署可留空 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 是否以流式请求（SSE）。默认 true；后端不支持 stream 时可关闭 */
  stream?: boolean;
  /** WebUI 调试流里的显示名 */
  label?: string;
}

export class TextClient {
  constructor(private cfg: TextClientConfig) {}

  private endpoint(): string {
    // 用户可能填了 OpenAI 风格的 /v1 路径，剥掉后使用 llama.cpp 原生端点
    const root = this.cfg.baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${root}/completion`;
  }

  async complete(
    prompt: string,
    opts: { grammar?: string; signal?: AbortSignal; stop?: string[]; nPredict?: number } = {},
  ): Promise<string> {
    const body: Record<string, unknown> = {
      prompt,
      temperature: this.cfg.temperature ?? 0.8,
      n_predict: opts.nPredict ?? this.cfg.maxTokens ?? 1024,
      cache_prompt: true,
    };
    if (this.cfg.model) body.model = this.cfg.model;
    if (opts.grammar) body.grammar = opts.grammar;
    if (opts.stop?.length) body.stop = opts.stop;

    const startedAt = Date.now();
    const stream = this.cfg.stream !== false;
    // prompt 摘要仅用于调试视图展示；实际请求体始终发送完整 prompt
    const input = {
      url: this.endpoint(),
      model: this.cfg.model ?? "",
      prompt:
        prompt.length > 3000
          ? prompt.slice(0, 3000) + `…（后略 ${prompt.length - 3000} 字符——仅调试视图截断显示，实际请求已完整发送）`
          : prompt,
      n_predict: body.n_predict,
      stream,
    };
    const label = this.cfg.label ?? "LLM";
    debug.emit("llm.req", `${label}·请求发送`, input);

    const res = await llmFetch(this.endpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...body, ...(stream ? { stream: true } : {}) }),
      signal: opts.signal ?? null,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      debug.emit("llm.req", `${label}·请求失败(${res.status})`, { ...input, ms: Date.now() - startedAt }, "error");
      throw new Error(`text completion 请求失败 (${res.status}): ${text.slice(0, 500)}`);
    }

    // 非流式：一次性 JSON 响应
    if (!stream) {
      const data = (await res.json()) as { content?: string; timings?: LlmTimings; tokens_cached?: number };
      if (typeof data.content !== "string") {
        debug.emit("llm.req", `${label}·无响应`, { ...input, ms: Date.now() - startedAt }, "error");
        throw new Error("text completion 响应缺少 content 字段");
      }
      const ms = Date.now() - startedAt;
      const usage = timingsToUsage(data.timings, data.tokens_cached);
      debug.emit("llm.res", `${label}·${ms}ms${usage ? ` · ${usage.total} tok` : ""}`, {
        url: this.endpoint(),
        model: this.cfg.model ?? "",
        ms,
        usage,
        content: data.content.slice(0, 4000),
      });
      this.recordUsage(usage);
      return data.content;
    }

    // 流式：边生成边把增量写进同一条 llm.res 记录，完成时原地收尾
    let streamId: number | null = null;
    let result: { content: string; timings?: LlmTimings; tokensCached?: number };
    try {
      result = await readTextStream(res, (partial, u) => {
        const usageNow = timingsToUsage(u);
        const labelNow = `${label}·流式 ${Date.now() - startedAt}ms`;
        const detail = {
          url: this.endpoint(),
          model: this.cfg.model ?? "",
          ms: Date.now() - startedAt,
          usage: usageNow,
          content: partial.slice(-6000),
        };
        if (streamId == null) streamId = debug.emit("llm.res", labelNow, detail);
        else debug.update(streamId, { label: labelNow, detail });
      });
    } catch (err) {
      debug.emit("llm.req", `${label}·流式中断`, { ...input, ms: Date.now() - startedAt }, "error");
      throw err;
    }
    const ms = Date.now() - startedAt;
    const content = result.content;
    const usage = timingsToUsage(result.timings, result.tokensCached);
    this.recordUsage(usage);
    const finalDetail = {
      url: this.endpoint(),
      model: this.cfg.model ?? "",
      ms,
      usage,
      content: content.slice(0, 4000),
    };
    if (streamId != null) debug.update(streamId, { label: `${label}·${ms}ms${usage ? ` · ${usage.total} tok` : ""}`, detail: finalDetail });
    else debug.emit("llm.res", `${label}·${ms}ms${usage ? ` · ${usage.total} tok` : ""}`, finalDetail);
    return content;
  }

  private recordUsage(usage: LlmUsage | null): void {
    if (!usage) return;
    usageStore.record({
      label: this.cfg.label ?? "LLM",
      model: this.cfg.model ?? "",
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      totalTokens: usage.total,
      cachedTokens: usage.cached,
      cacheReported: usage.cacheReported,
    });
  }
}

interface LlmTimings {
  prompt_n?: number;
  predicted_n?: number;
  prompt_eval_count?: number;
  predicted_eval_count?: number;
  /** llama.cpp：命中 KV cache 而无需重新求值的 prompt token 数 */
  cache_n?: number;
}

interface LlmUsage {
  prompt: number;
  completion: number;
  total: number;
  /** 命中 KV cache 的输入 token 数 */
  cached: number;
  /** 是否上报了缓存命中信息（cache_n / tokens_cached 存在才算上报） */
  cacheReported: boolean;
}

function timingsToUsage(t: LlmTimings | undefined, tokensCached?: number): LlmUsage | null {
  if (!t) return null;
  // llama.cpp 的 timings.prompt_n 是"本次真正求值"的 token 数，缓存命中数在
  // timings.cache_n（新版）或顶层 tokens_cached（旧版）；完整输入 = 求值 + 缓存命中
  const evaluated = Number(t.prompt_n ?? t.prompt_eval_count) || 0;
  const cached = Math.max(Number(t.cache_n ?? tokensCached) || 0, 0);
  const completion = Number(t.predicted_n ?? t.predicted_eval_count) || 0;
  const prompt = evaluated + cached;
  if (!prompt && !completion) return null;
  const cacheReported = t.cache_n !== undefined || tokensCached !== undefined;
  return { prompt, completion, total: prompt + completion, cached, cacheReported };
}

/**
 * 读取 llama.cpp /completion 的 NDJSON 流（stream:true），增量累加 content；
 * 每 ~500ms 有新增内容时回调一次 onProgress(content, timings)。
 * 兼容后端忽略 stream 直接返回整段 JSON 的情况。
 */
async function readTextStream(
  res: LlmResponse,
  onProgress: (content: string, timings?: LlmTimings) => void,
): Promise<{ content: string; timings?: LlmTimings; tokensCached?: number }> {
  let content = "";
  let timings: LlmTimings | undefined;
  let tokensCached: number | undefined;
  let dirty = false;
  let lastEmit = 0;
  let sawData = false;
  let allLines = "";
  const THROTTLE_MS = 500;

  await forEachStreamLine(res, (line) => {
    allLines += line + "\n";
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload) return;
    let chunk: { content?: string; timings?: LlmTimings; tokens_cached?: number };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      return;
    }
    sawData = true;
    if (chunk.timings) timings = chunk.timings;
    if (typeof chunk.tokens_cached === "number") tokensCached = chunk.tokens_cached;
    if (typeof chunk.content === "string" && chunk.content) {
      content += chunk.content;
      dirty = true;
    }
    const now = Date.now();
    if (dirty && now - lastEmit >= THROTTLE_MS) {
      lastEmit = now;
      dirty = false;
      onProgress(content, timings);
    }
  });
  if (dirty) onProgress(content, timings);

  if (!sawData && allLines.trim()) {
    let data: { content?: string; timings?: LlmTimings; tokens_cached?: number } | null = null;
    try {
      data = JSON.parse(allLines) as { content?: string; timings?: LlmTimings; tokens_cached?: number };
    } catch {
      /* 非 JSON，忽略 */
    }
    if (data && typeof data.content !== "string") {
      throw new Error("text completion 响应缺少 content 字段");
    }
    if (data && typeof data.content === "string" && data.content) {
      content = data.content;
      timings = data.timings ?? timings;
      if (typeof data.tokens_cached === "number") tokensCached = data.tokens_cached;
      onProgress(content, data.timings);
    }
  }
  return { content, timings, tokensCached };
}
