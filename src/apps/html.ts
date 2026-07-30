/**
 * 零依赖 HTML → 可读文本转换（浏览器 App 用）。
 *
 * 不构建 DOM，基于正则的轻量流程：
 * 去脚本/样式 → 提标题 → 链接编号化（[n]）→ 图片编号化（{图n}）→
 * 块级标签断行 → 剥余下标签 → 实体解码 → 空白折叠。
 *
 * 对文本浏览器友好的页面（DuckDuckGo Lite、维基、新闻站等）效果最好；
 * 重 JS 的 SPA 只能得到骨架文本（属预期降级）。
 */

export interface PageLink {
  url: string;
  text: string;
}

export interface PageImage {
  url: string;
  alt: string;
}

export interface ParsedPage {
  title: string;
  /** 可读正文：链接以 文字[n] 标注，图片以 {图n:alt} 标注 */
  text: string;
  links: PageLink[];
  images: PageImage[];
}

const MAX_LINKS = 80;
const MAX_IMAGES = 30;

/** 解析 HTML 为可读页面。baseUrl 用于解析相对链接（解析失败保留原样）。 */
export function parseHtml(html: string, baseUrl: string): ParsedPage {
  let s = html;

  // 1. 去掉不可读区块
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "style", "noscript", "template", "iframe", "svg", "object", "select"]) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }

  // 2. 标题
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? collapse(decodeEntities(stripTags(titleMatch[1]!))) : "";
  s = s.replace(/<head\b[\s\S]*?<\/head>/i, " ");

  // 3. 图片 → {图n:alt} 标注
  const images: PageImage[] = [];
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    if (images.length >= MAX_IMAGES) return " ";
    const src = attrOf(tag, "src") || attrOf(tag, "data-src");
    if (!src || src.startsWith("data:")) return " ";
    const url = resolveUrl(src, baseUrl);
    if (!url) return " ";
    const alt = collapse(decodeEntities(attrOf(tag, "alt") ?? ""));
    images.push({ url, alt });
    return ` {图${images.length}${alt ? `:${alt}` : ""}} `;
  });

  // 4. 链接 → 文字[n] 标注
  const links: PageLink[] = [];
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_whole, attrs: string, inner: string) => {
    const href = attrOf(`<a ${attrs}>`, "href");
    const text = collapse(decodeEntities(stripTags(inner)));
    if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href.trim())) return ` ${text} `;
    if (links.length >= MAX_LINKS) return ` ${text} `;
    const url = resolveUrl(href, baseUrl);
    if (!url) return ` ${text} `;
    links.push({ url, text: text || url });
    return ` ${text || "(链接)"}[${links.length}] `;
  });

  // 5. 块级标签断行
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|aside|header|footer|nav|form|table|ul|ol|dl|blockquote|pre|figure|fieldset|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(tr|dt)\b[^>]*>/gi, "\n")
    .replace(/<\/?(td|th)\b[^>]*>/gi, "  ")
    .replace(/<hr\b[^>]*>/gi, "\n----\n");

  // 6. 剥标签、解实体、折叠空白（丢弃不含任何文字/数字的纯符号噪声行）
  s = decodeEntities(stripTags(s));
  const lines = s
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .map((l) => (/[\p{L}\p{N}]/u.test(l) || l === "----" ? l : ""))
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""));
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return { title, text, links, images };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

/** 提取标签属性值（双引号/单引号/无引号），并解码实体（href 里常见 &amp;） */
function attrOf(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function resolveUrl(href: string, base: string): string | null {
  const t = href.trim();
  if (!t) return null;
  try {
    const url = new URL(t, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    // base 可能是虚构世界的非标准网址：绝对形式的原样保留
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : null;
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", middot: "·", laquo: "«", raquo: "»", times: "×",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}
