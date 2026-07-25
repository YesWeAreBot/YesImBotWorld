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

export interface TextClientConfig {
  baseURL: string;
  apiKey?: string;
  /** 多模型代理（如 llama-swap）需要 model 字段路由；单模型部署可留空 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
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

    const res = await fetch(this.endpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? null,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`text completion 请求失败 (${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { content?: string };
    if (typeof data.content !== "string") throw new Error("text completion 响应缺少 content 字段");
    return data.content;
  }
}
