import type { CompressionResult } from "../types.js";

/** Invalid output must never acknowledge (and retire) the source context. */
export function parseCompression(content: string): CompressionResult {
  const text = content.trim().replace(/^```(?:xml)?\s*\n([\s\S]*?)\n```$/i, "$1").trim();
  const match = text.match(/^<HISTORY_SUMMARY>([\s\S]*?)<\/HISTORY_SUMMARY>\s*<MEMORY_DIGEST>([\s\S]*?)<\/MEMORY_DIGEST>$/);
  if (!match || /<\/?(?:HISTORY_SUMMARY|MEMORY_DIGEST)\b/.test(match[1]! + match[2]!) ||
    !match[1]!.trim() || !match[2]!.trim()) {
    throw new Error("记忆压缩格式无效：需要依次给出唯一、完整闭合且非空的 HISTORY_SUMMARY 和 MEMORY_DIGEST，不含其他输出；没有内容请写‘（无）’。原始经历未被替换。");
  }
  return { historySummary: match[1]!.trim(), memoryDigest: match[2]!.trim() };
}
