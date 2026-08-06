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
    const input = {
      url: this.endpoint(),
      model: this.cfg.model ?? "",
      prompt: prompt.slice(0, 3000),
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
      const data = (await res.json()) as { content?: string };
      if (typeof data.content !== "string") {
        debug.emit("llm.req", `${label}·无响应`, { ...input, ms: Date.now() - startedAt }, "error");
        throw new Error("text completion 响应缺少 content 字段");
      }
      const ms = Date.now() - startedAt;
      debug.emit("llm.res", `${label}·${ms}ms`, {
        url: this.endpoint(),
        model: this.cfg.model ?? "",
        ms,
        content: data.content.slice(0, 4000),
      });
      return data.content;
    }

    // 流式：边生成边把增量写进同一条 llm.res 记录，完成时原地收尾
    let streamId: number | null = null;
    let content = "";
    try {
      content = await readTextStream(res, (partial) => {
        const labelNow = `${label}·流式 ${Date.now() - startedAt}ms`;
        const detail = {
          url: this.endpoint(),
          model: this.cfg.model ?? "",
          ms: Date.now() - startedAt,
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
    const finalDetail = {
      url: this.endpoint(),
      model: this.cfg.model ?? "",
      ms,
      content: content.slice(0, 4000),
    };
    if (streamId != null) debug.update(streamId, { label: `${label}·${ms}ms`, detail: finalDetail });
    else debug.emit("llm.res", `${label}·${ms}ms`, finalDetail);
    return content;
  }
}

/**
 * 读取 llama.cpp /completion 的 NDJSON 流（stream:true），增量累加 content；
 * 每 ~500ms 有新增内容时回调一次 onProgress。兼容后端忽略 stream
 * 直接返回整段 JSON 的情况。
 */
async function readTextStream(
  res: LlmResponse,
  onProgress: (content: string) => void,
): Promise<string> {
  let content = "";
  let dirty = false;
  let lastEmit = 0;
  let sawData = false;
  let allLines = "";
  const THROTTLE_MS = 500;

  await forEachStreamLine(res, (line) => {
    allLines += line + "\n";
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload) return;
    let chunk: { content?: string };
    try {
      chunk = JSON.parse(payload) as typeof chunk;
    } catch {
      return;
    }
    sawData = true;
    if (typeof chunk.content === "string" && chunk.content) {
      content += chunk.content;
      dirty = true;
    }
    const now = Date.now();
    if (dirty && now - lastEmit >= THROTTLE_MS) {
      lastEmit = now;
      dirty = false;
      onProgress(content);
    }
  });
  if (dirty) onProgress(content);

  if (!sawData && allLines.trim()) {
    let data: { content?: string } | null = null;
    try {
      data = JSON.parse(allLines) as { content?: string };
    } catch {
      /* 非 JSON，忽略 */
    }
    if (data && typeof data.content !== "string") {
      throw new Error("text completion 响应缺少 content 字段");
    }
    if (data && typeof data.content === "string" && data.content) {
      content = data.content;
      onProgress(content);
    }
  }
  return content;
}
