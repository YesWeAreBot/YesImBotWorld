import type { TtsConfig } from "../config.js";

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
};

/** OpenAI 兼容 TTS 客户端（/v1/audio/speech） */
export class TtsClient {
  constructor(private cfg: TtsConfig) {}

  get mime(): string {
    return MIME_BY_FORMAT[this.cfg.format] ?? "audio/mpeg";
  }

  async speech(text: string): Promise<{ data: Buffer; mime: string }> {
    const url = this.cfg.baseURL.replace(/\/+$/, "") + "/audio/speech";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        input: text,
        voice: this.cfg.voice,
        response_format: this.cfg.format,
        speed: this.cfg.speed,
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TTS 请求失败 (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.byteLength) throw new Error("TTS 返回了空音频");
    const headerMime = res.headers.get("content-type")?.split(";")[0]?.trim();
    return { data, mime: headerMime && headerMime.startsWith("audio/") ? headerMime : this.mime };
  }
}
