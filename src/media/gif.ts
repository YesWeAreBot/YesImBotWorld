/**
 * 零依赖 GIF 处理：解码动图帧 → 拼成一张网格图（PNG）。
 *
 * 用途：Bot-LLM 原生支持图像但不支持视频时，把 GIF 的采样帧拼成一张大图注入，
 * 让模型"看到"动图的过程（按行从左到右为播放顺序）。
 *
 * 解码支持：GIF87a/89a、全局/局部色表、隔行、透明索引、disposal 1/2/3。
 * 编码：PNG（RGBA、filter 0、node:zlib deflate）。
 */

import { deflateSync } from "node:zlib";

/** 采样帧数上限（网格 3x3） */
const MAX_SAMPLE_FRAMES = 9;
/** 输出图总像素预算（超出则减少采样帧数） */
const PIXEL_BUDGET = 4_000_000;
/** 最多解码的帧数（超长动图只看前面部分） */
const MAX_SCAN_FRAMES = 120;
/** 帧间分隔（白色，像素） */
const GAP = 4;

interface GifHeader {
  width: number;
  height: number;
  gct: Uint8Array | null;
  bgIndex: number;
  /** 数据块起始偏移 */
  offset: number;
}

function parseHeader(buf: Buffer): GifHeader {
  const sig = buf.subarray(0, 6).toString("ascii");
  if (sig !== "GIF87a" && sig !== "GIF89a") throw new Error("不是 GIF 文件");
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height) throw new Error("GIF 尺寸异常");
  const packed = buf[10]!;
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = 2 << (packed & 0x07);
  let offset = 13;
  let gct: Uint8Array | null = null;
  if (hasGct) {
    gct = new Uint8Array(buf.subarray(offset, offset + gctSize * 3));
    offset += gctSize * 3;
  }
  return { width, height, gct, bgIndex: buf[11]!, offset };
}

/** 跳过数据子块，返回终止符后的偏移 */
function skipSubBlocks(buf: Buffer, pos: number): number {
  while (pos < buf.length) {
    const size = buf[pos]!;
    pos += 1;
    if (size === 0) break;
    pos += size;
  }
  return pos;
}

/** 收集数据子块内容 */
function readSubBlocks(buf: Buffer, pos: number): { data: Uint8Array; next: number } {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (pos < buf.length) {
    const size = buf[pos]!;
    pos += 1;
    if (size === 0) break;
    chunks.push(buf.subarray(pos, pos + size));
    total += size;
    pos += size;
  }
  const data = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    data.set(c, o);
    o += c.length;
  }
  return { data, next: pos };
}

/** GIF LZW 解码 */
function lzwDecode(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  const MAX_CODES = 4096;
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const prefix = new Int32Array(MAX_CODES);
  const suffix = new Uint8Array(MAX_CODES);
  const stack = new Uint8Array(MAX_CODES);
  const out = new Uint8Array(pixelCount);

  let codeSize = minCodeSize + 1;
  let dictSize = eoiCode + 1;
  for (let i = 0; i < clearCode; i++) {
    prefix[i] = -1;
    suffix[i] = i;
  }

  let bits = 0;
  let cur = 0;
  let pos = 0;
  let op = 0;
  let prev = -1;

  while (op < pixelCount) {
    while (bits < codeSize) {
      if (pos >= data.length) return out; // 数据提前结束：返回已解码部分
      cur |= data[pos++]! << bits;
      bits += 8;
    }
    const code = cur & ((1 << codeSize) - 1);
    cur >>= codeSize;
    bits -= codeSize;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      dictSize = eoiCode + 1;
      prev = -1;
      continue;
    }
    if (code === eoiCode) break;

    if (prev === -1) {
      if (code >= dictSize) return out; // 损坏
      out[op++] = suffix[code]!;
      prev = code;
      continue;
    }

    let sp = 0;
    let c = code;
    if (code >= dictSize) {
      // KwKwK：先压入 prev 链的首字符
      c = prev;
      stack[sp++] = firstOf(prefix, suffix, prev);
    }
    while (c >= clearCode) {
      stack[sp++] = suffix[c]!;
      c = prefix[c]!;
    }
    stack[sp++] = suffix[c]!;
    const first = suffix[c]!;
    // 逆序输出
    while (sp > 0 && op < pixelCount) out[op++] = stack[--sp]!;

    if (dictSize < MAX_CODES) {
      prefix[dictSize] = prev;
      suffix[dictSize] = first;
      dictSize++;
      if (dictSize === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

function firstOf(prefix: Int32Array, suffix: Uint8Array, code: number): number {
  let c = code;
  while (prefix[c]! >= 0) c = prefix[c]!;
  return suffix[c]!;
}

/** 隔行扫描的行序还原 */
function deinterlace(indices: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(indices.length);
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ];
  let src = 0;
  for (const p of passes) {
    for (let y = p.start; y < h; y += p.step) {
      out.set(indices.subarray(src * w, (src + 1) * w), y * w);
      src++;
    }
  }
  return out;
}

/**
 * 解码 GIF，按均匀采样返回至多 sampleCount 张完整画布快照（RGBA）。
 */
export function decodeGifFrames(
  buf: Buffer,
  sampleCount: number,
): { width: number; height: number; frames: Uint8Array[] } {
  const header = parseHeader(buf);
  const { width, height } = header;

  // 第一遍：数帧（只走块结构，不解码）
  let total = 0;
  {
    let pos = header.offset;
    while (pos < buf.length && total < MAX_SCAN_FRAMES) {
      const block = buf[pos]!;
      if (block === 0x3b) break;
      if (block === 0x21) {
        pos = skipSubBlocks(buf, pos + 2);
      } else if (block === 0x2c) {
        const packed = buf[pos + 9]!;
        pos += 10;
        if (packed & 0x80) pos += (2 << (packed & 0x07)) * 3; // 局部色表
        pos += 1; // LZW min code size
        pos = skipSubBlocks(buf, pos);
        total++;
      } else {
        break; // 未知块：停止解析
      }
    }
  }
  if (!total) throw new Error("GIF 中没有图像帧");

  const n = Math.min(sampleCount, total);
  const wanted = new Set<number>();
  for (let i = 0; i < n; i++) wanted.add(Math.round((i * (total - 1)) / Math.max(1, n - 1)));

  // 第二遍：顺序解码合成，在采样点截取画布
  const canvas = new Uint8Array(width * height * 4); // 初始全透明
  const frames: Uint8Array[] = [];
  let frameIdx = 0;
  let disposal = 0;
  let transIndex = -1;
  let pos = header.offset;

  while (pos < buf.length && frameIdx < total) {
    const block = buf[pos]!;
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = buf[pos + 1]!;
      if (label === 0xf9 && buf[pos + 2] === 4) {
        const packed = buf[pos + 3]!;
        disposal = (packed >> 2) & 0x07;
        transIndex = packed & 0x01 ? buf[pos + 6]! : -1;
      }
      pos = skipSubBlocks(buf, pos + 2);
      continue;
    }
    if (block !== 0x2c) break;

    const left = buf.readUInt16LE(pos + 1);
    const top = buf.readUInt16LE(pos + 3);
    const fw = buf.readUInt16LE(pos + 5);
    const fh = buf.readUInt16LE(pos + 7);
    const packed = buf[pos + 9]!;
    pos += 10;
    let palette = header.gct;
    if (packed & 0x80) {
      const size = 2 << (packed & 0x07);
      palette = new Uint8Array(buf.subarray(pos, pos + size * 3));
      pos += size * 3;
    }
    const minCodeSize = buf[pos]!;
    pos += 1;
    const { data, next } = readSubBlocks(buf, pos);
    pos = next;
    if (!palette) throw new Error("GIF 缺少色表");

    let indices = lzwDecode(minCodeSize, data, fw * fh);
    if (packed & 0x40) indices = deinterlace(indices, fw, fh);

    const preDraw = disposal === 3 ? canvas.slice() : null;

    // 绘制到画布（跳过透明索引）
    for (let y = 0; y < fh; y++) {
      const cy = top + y;
      if (cy >= height) break;
      for (let x = 0; x < fw; x++) {
        const cx = left + x;
        if (cx >= width) continue;
        const idx = indices[y * fw + x]!;
        if (idx === transIndex) continue;
        const p = (cy * width + cx) * 4;
        canvas[p] = palette[idx * 3] ?? 0;
        canvas[p + 1] = palette[idx * 3 + 1] ?? 0;
        canvas[p + 2] = palette[idx * 3 + 2] ?? 0;
        canvas[p + 3] = 255;
      }
    }

    if (wanted.has(frameIdx)) frames.push(canvas.slice());

    // 为下一帧应用 disposal
    if (disposal === 2) {
      for (let y = 0; y < fh; y++) {
        const cy = top + y;
        if (cy >= height) break;
        for (let x = 0; x < fw; x++) {
          const cx = left + x;
          if (cx >= width) continue;
          canvas.fill(0, (cy * width + cx) * 4, (cy * width + cx) * 4 + 4);
        }
      }
    } else if (disposal === 3 && preDraw) {
      canvas.set(preDraw);
    }
    disposal = 0;
    transIndex = -1;
    frameIdx++;
  }

  if (!frames.length) throw new Error("GIF 解码没有得到任何帧");
  return { width, height, frames };
}

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/** RGBA 像素 → PNG（filter 0） */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * GIF → 帧拼图 PNG：均匀采样至多 9 帧，按网格拼接（白底、白色分隔），
 * 按行从左到右为播放顺序。静态（单帧）GIF 得到单帧图。
 */
export function gifToFilmstripPng(buf: Buffer): { png: Buffer; frameCount: number } {
  const header = parseHeader(buf);
  const perFrame = header.width * header.height;
  const budgetFrames = Math.max(1, Math.floor(PIXEL_BUDGET / Math.max(1, perFrame)));
  const { width, height, frames } = decodeGifFrames(buf, Math.min(MAX_SAMPLE_FRAMES, budgetFrames));

  const n = frames.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const gap = n > 1 ? GAP : 0;
  const W = cols * width + (cols - 1) * gap;
  const H = rows * height + (rows - 1) * gap;

  const out = new Uint8Array(W * H * 4).fill(255); // 白底
  for (let i = 0; i < n; i++) {
    const ox = (i % cols) * (width + gap);
    const oy = Math.floor(i / cols) * (height + gap);
    const frame = frames[i]!;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4;
        const a = frame[s + 3]!;
        if (a === 0) continue; // 透明：保持白底
        const d = ((oy + y) * W + (ox + x)) * 4;
        out[d] = frame[s]!;
        out[d + 1] = frame[s + 1]!;
        out[d + 2] = frame[s + 2]!;
        out[d + 3] = 255;
      }
    }
  }
  return { png: encodePng(out, W, H), frameCount: n };
}
