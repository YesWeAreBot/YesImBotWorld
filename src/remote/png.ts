/**
 * 极简 PNG 编码器（无外部依赖）：
 * 把 RGB/RGBA8 像素编码为 PNG。只有 PNG 本身（过滤 0 + zlib），
 * 配合下采样把远程桌面截屏控制在几百 KB 以内，减少注入模型的体积。
 */

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 编码像素为 PNG。
 * @param width  图片宽（像素）
 * @param height 图片高（像素）
 * @param rgba   RGB(A) 像素，行优先，每行 width * bytesPerPixel 字节
 * @param bpp    3=RGB，4=RGBA
 */
export function encodePng(width: number, height: number, rgba: Uint8Array, bpp: 3 | 4 = 3): Buffer {
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 = None
    const srcStart = y * stride;
    const dstStart = y * (stride + 1) + 1;
    raw.set(rgba.subarray(srcStart, srcStart + stride), dstStart);
  }
  const idat = deflateSync(raw, { level: 6 });

  const chunks: Buffer[] = [SIGNATURE];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = bpp === 4 ? 6 : 2; // color type: 2=truecolor, 6=RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(pngChunk("IHDR", ihdr));
  chunks.push(pngChunk("IDAT", idat));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.byteLength, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** CRC-32（PNG 用），表驱动 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.byteLength; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
