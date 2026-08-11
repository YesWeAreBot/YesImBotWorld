/**
 * Bot 手机的屏幕规格。
 *
 * 分辨率优先级：配置显式指定（apps.phoneResolution = "宽x高"）
 * > 创世时 World-LLM 依据世界观判定（配置为 "auto"，存于 meta.json）
 * > 内置默认值。
 *
 * 影响：浏览器 App 截图的视口尺寸、WebUI「设备」页手机模型的展示比例。
 */

import type { WorldMeta } from "./files.js";

export interface PhoneResolution {
  width: number;
  height: number;
}

export const DEFAULT_PHONE_RESOLUTION: PhoneResolution = { width: 800, height: 1280 };

/** 允许的分辨率范围（防止过大的截图视口拖垮 puppeteer / 生成离谱的图） */
const MIN_W = 240;
const MAX_W = 2160;
const MIN_H = 320;
const MAX_H = 3840;

/** 解析 "800x1280" 形式的分辨率（容忍 x / X / × / * 分隔与空格） */
export function parsePhoneResolution(text: string): PhoneResolution | null {
  const m = String(text ?? "")
    .trim()
    .match(/^(\d{2,5})\s*[xX×*]\s*(\d{2,5})$/);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return clampPhoneResolution({ width, height });
}

export function clampPhoneResolution(r: PhoneResolution): PhoneResolution {
  return {
    width: Math.min(Math.max(Math.round(r.width), MIN_W), MAX_W),
    height: Math.min(Math.max(Math.round(r.height), MIN_H), MAX_H),
  };
}

/**
 * 归一出当前生效的手机分辨率。
 * @param configured 配置值：`auto` 或 "宽x高"
 * @param meta 世界元数据（创世时 World-LLM 的判定结果）
 */
export function resolvePhoneResolution(configured: string, meta: WorldMeta | null | undefined): PhoneResolution {
  const conf = String(configured ?? "").trim();
  if (conf && conf.toLowerCase() !== "auto") {
    const parsed = parsePhoneResolution(conf);
    if (parsed) return parsed;
  }
  const w = Number(meta?.phone?.width);
  const h = Number(meta?.phone?.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return clampPhoneResolution({ width: w, height: h });
  }
  return DEFAULT_PHONE_RESOLUTION;
}
