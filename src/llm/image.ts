import { llmFetch, type LlmResponse } from "./http.js";
import { callStore } from "../webui/calls.js";

export interface ImageClientConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  size?: string;
  quality?: string;
  maxBytes?: number;
}

export interface GeneratedImage { data: Buffer; mime: string }

/** OpenAI-compatible image generations; supports both base64 and temporary URL responses. */
export class ImageClient {
  private readonly maxBytes: number;
  constructor(private readonly config: ImageClientConfig) {
    this.maxBytes = Math.max(1024, Math.min(100 * 1024 * 1024, config.maxBytes ?? 20 * 1024 * 1024));
  }

  async generate(prompt: string, signal?: AbortSignal): Promise<GeneratedImage> {
    if (!this.config.baseURL.trim() || !this.config.model.trim()) throw new Error("相机的图像服务地址与模型尚未配置。");
    const url = this.config.baseURL.replace(/\/+$/, "") + "/images/generations";
    // GPT image models return base64 by default and reject response_format; older models
    // may return a URL. Accept both instead of imposing one backend-specific format.
    const requestBody = JSON.stringify({ model: this.config.model, prompt, n: 1,
      ...(this.config.size ? { size: this.config.size } : {}), ...(this.config.quality ? { quality: this.config.quality } : {}) });
    const callId = callStore.begin({ source: "App:Camera:Image", model: this.config.model, url, requestBody });
    try {
      signal?.throwIfAborted();
      const response = await llmFetch(url, { method: "POST", headers: { "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) }, body: requestBody, signal });
      callStore.update(callId, { httpStatus: response.status, responseFormat: "application/json" });
      const raw = (await readLimited(response, Math.ceil(this.maxBytes * 4 / 3) + 1024 * 1024, signal)).toString("utf8");
      callStore.append(callId, raw);
      if (!response.ok) throw new Error(`图像生成请求失败 (${response.status})：${raw.slice(0, 500)}`);
      const result = JSON.parse(raw) as { data?: { b64_json?: unknown; url?: unknown }[] };
      const item = result.data?.[0];
      let data: Buffer;
      if (typeof item?.b64_json === "string" && item.b64_json.trim()) {
        const base64 = item.b64_json.replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) throw new Error("图像服务返回了无效的 base64 数据。");
        data = Buffer.from(base64, "base64");
      } else if (typeof item?.url === "string") {
        const target = new URL(item.url);
        if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("图像服务返回的图片地址不是 HTTP(S)。");
        // Never forward the image API credential to a storage/CDN URL.
        const downloadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
        const imageResponse = await llmFetch(target.toString(), { signal: downloadSignal });
        if (!imageResponse.ok) { await imageResponse.body?.cancel(); throw new Error(`生成图片下载失败 (${imageResponse.status})。`); }
        data = await readLimited(imageResponse, this.maxBytes, downloadSignal);
      } else throw new Error("图像服务没有返回图片数据或可下载地址。");
      signal?.throwIfAborted();
      if (!data.length || data.length > this.maxBytes) throw new Error("生成图片为空或超出资产大小限制。");
      const mime = imageMime(data);
      if (!mime) throw new Error("图像服务返回的内容不是可识别的 PNG/JPEG/WebP/GIF 图片。");
      callStore.update(callId, { status: "completed", preview: `已生成图片（${mime}，${data.length} 字节）` });
      return { data, mime };
    } catch (error) {
      callStore.update(callId, { status: signal?.aborted ? "cancelled" : "error", error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
      throw error;
    }
  }
}

async function readLimited(response: LlmResponse, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw new Error("图像响应超出大小限制。"); }
  if (!response.body) throw new Error("图像服务响应没有正文。");
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error("图像响应超出大小限制。"); }
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts, size);
  } finally { reader.releaseLock(); }
}

function imageMime(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) return "image/gif";
  return null;
}
