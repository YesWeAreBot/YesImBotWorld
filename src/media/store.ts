import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Context, Logger } from "koishi";
import type { MediaRef, MediaType } from "../types.js";

declare module "koishi" {
  interface Tables {
    yesimbot_world_media: WorldMediaRow;
  }
}

export interface WorldMediaRow {
  id: number;
  sha256: string;
  type: string;
  mime: string;
  /** 资产目录内的文件名 */
  file: string;
  size: number;
  /** 解释器产出的文本描述缓存；空串 = 尚未解释 */
  summary: string;
  createdAt: Date;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/amr": ".amr",
  "audio/silk": ".silk",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/quicktime": ".mov",
};

/**
 * 媒体资产库：下载消息中的图片/音频/视频到本地（平台的媒体 URL 会过期），
 * 按 sha256 去重，元数据与解释缓存存 Koishi database。
 */
export class MediaStore {
  constructor(
    private ctx: Context,
    private assetsDir: string,
    private maxBytes: number,
    private logger: Logger,
  ) {
    ctx.model.extend(
      "yesimbot_world_media",
      {
        id: "unsigned",
        sha256: "string(64)",
        type: "string(16)",
        mime: "string(64)",
        file: "string(255)",
        size: "unsigned",
        summary: "text",
        createdAt: "timestamp",
      },
      { autoInc: true, primary: "id" },
    );
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.assetsDir, { recursive: true });
  }

  /**
   * 摄取一个媒体资源（http(s):// 或 data: URL），返回媒体 id。
   * 下载失败 / 超限时返回 null。
   */
  async ingest(src: string, type: MediaType, mimeHint?: string): Promise<number | null> {
    try {
      const fetched = await this.fetchSource(src, mimeHint);
      if (!fetched) return null;
      const { data, mime } = fetched;
      const sha256 = createHash("sha256").update(data).digest("hex");

      const existing = await this.ctx.database.get("yesimbot_world_media", { sha256 }, { limit: 1 });
      if (existing.length) return existing[0]!.id;

      await this.ensureDir();
      const ext = EXT_BY_MIME[mime] ?? defaultExt(type);
      const file = `${sha256.slice(0, 32)}${ext}`;
      await fs.writeFile(path.join(this.assetsDir, file), data);
      const row = await this.ctx.database.create("yesimbot_world_media", {
        sha256,
        type,
        mime,
        file,
        size: data.byteLength,
        summary: "",
        createdAt: new Date(),
      });
      return row.id;
    } catch (err) {
      this.logger.warn("媒体摄取失败 (%s): %s", type, err);
      return null;
    }
  }

  async get(id: number): Promise<(WorldMediaRow & { ref: MediaRef }) | null> {
    const rows = await this.ctx.database.get("yesimbot_world_media", { id }, { limit: 1 });
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      ref: {
        id: row.id,
        type: row.type as MediaType,
        mime: row.mime,
        file: path.join(this.assetsDir, row.file),
      },
    };
  }

  async setSummary(id: number, summary: string): Promise<void> {
    await this.ctx.database.set("yesimbot_world_media", { id }, { summary });
  }

  async readFile(ref: MediaRef): Promise<Buffer> {
    return fs.readFile(ref.file);
  }

  private async fetchSource(
    src: string,
    mimeHint?: string,
  ): Promise<{ data: Buffer; mime: string } | null> {
    if (src.startsWith("data:")) {
      const match = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!match) return null;
      const data = match[2]
        ? Buffer.from(match[3]!, "base64")
        : Buffer.from(decodeURIComponent(match[3]!), "utf8");
      if (data.byteLength > this.maxBytes) return null;
      const mime = match[1] || mimeHint || sniffMime(data);
      return { data, mime };
    }
    if (src.startsWith("file://")) {
      const filePath = decodeURIComponent(src.slice("file://".length));
      const stat = await fs.stat(filePath);
      if (stat.size > this.maxBytes) return null;
      const data = await fs.readFile(filePath);
      return { data, mime: mimeHint || sniffMime(data) };
    }
    if (src.startsWith("http://") || src.startsWith("https://")) {
      const res = await fetch(src, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        this.logger.warn("媒体下载失败 (%d): %s", res.status, src.slice(0, 120));
        return null;
      }
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > this.maxBytes) return null;
      const data = Buffer.from(await res.arrayBuffer());
      if (data.byteLength > this.maxBytes) return null;
      const headerMime = res.headers.get("content-type")?.split(";")[0]?.trim();
      const mime =
        headerMime && headerMime !== "application/octet-stream"
          ? headerMime
          : mimeHint || sniffMime(data);
      return { data, mime };
    }
    return null;
  }
}

function defaultExt(type: MediaType): string {
  return type === "image" ? ".png" : type === "audio" ? ".bin" : ".mp4";
}

/** 通过 magic bytes 嗅探常见格式 */
function sniffMime(data: Buffer): string {
  if (data.length >= 4) {
    if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif";
    if (data.length >= 12 && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.length >= 12 && data.subarray(8, 12).toString("ascii") === "WAVE")
      return "audio/wav";
    if (data.subarray(0, 3).toString("ascii") === "ID3" || (data[0] === 0xff && (data[1]! & 0xe0) === 0xe0))
      return "audio/mpeg";
    if (data.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
    if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "video/webm";
  }
  return "application/octet-stream";
}
