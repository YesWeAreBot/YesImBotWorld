/**
 * 现实世界新闻源（RSS，可配置，免 API key）。
 *
 * 现实世界设定下：
 * - Tingle 心跳抓取各 RSS 源的最新标题作为「素材」喂给 World-LLM，由它摘编进 News.jsonl；
 * - Bot 的新闻 App 搜索新闻时，直接在这些 RSS 原文里按关键词匹配，不经过 World 摘编。
 *
 * 抽成独立模块便于复用与测试。默认源需为中国大陆服务器环境可直连；用户可自行配置替换
 * （apps.newsFeeds）。多数 RSS 源支持 /search?q= 的极少，因此关键词搜索统一走
 * 「拉取全部 → 本地模糊匹配」；若某个源支持 ?q= 也可在此扩展。
 */

import { fetchWithProxy } from "../fetch.js";
import { parseHtml } from "./html.js";

const HTTP_TIMEOUT_MS = 15_000;
const MAX_ARTICLE_BYTES = 1024 * 1024; // 文章页正文大小的上限，防止超大页面拖垮
const MAX_ARTICLE_CHARS = 6000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** 内置默认 RSS 源（大陆服务器环境直连优先，可在 apps.newsFeeds 覆盖或追加） */
export const DEFAULT_NEWS_FEEDS: string[] = [
  // BBC 中文（简体）：国际新闻，历史上大陆访问相对较稳；如被墙可自行替换
  "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml",
];

export interface RealNewsItem {
  title: string;
  link?: string;
  source?: string;
  publishedAt?: string;
  retrievedAt?: string;
}

export interface RealNewsSource {
  feeds: string[];
  /** 代理（同 browserProxy，留空回退环境变量） */
  proxy: string;
}

/** 归一化最终要抓取的 feed 列表：用户没配则用内置默认，去重、去空、剥首尾空白 */
export function resolveFeeds(configured: string[]): string[] {
  const list = (configured?.length ? configured : DEFAULT_NEWS_FEEDS)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
  return [...new Set(list)];
}

/**
 * 抓取所有源的最新标题（合并，按源顺序；单源失败只跳过不抛）。
 * 返回清洗后的 {title, link} 列表。
 */
export async function fetchAllHeadlines(source: RealNewsSource, n = 20): Promise<RealNewsItem[]> {
  const feeds = resolveFeeds(source.feeds);
  const out: RealNewsItem[] = [];
  for (const feed of feeds) {
    try {
      const items = await fetchFeed(feed, source.proxy);
      for (const it of items) {
        if (out.length >= n) break;
        out.push(it);
      }
    } catch {
      /* 单源失败跳过（后续抓取同样容忍），不阻塞其它源 */
    }
    if (out.length >= n) break;
  }
  return out;
}

/**
 * 在 RSS 原文里按关键词搜索：拉取所有源，命中标题（含 link 文本）则返回。
 * 普通 RSS 大多不支持 ?q=，因此统一拉全量后本地匹配。
 */
export async function searchHeadlines(
  source: RealNewsSource,
  keyword: string,
  n = 20,
): Promise<RealNewsItem[]> {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return fetchAllHeadlines(source, n);
  const feeds = resolveFeeds(source.feeds);
  const out: RealNewsItem[] = [];
  for (const feed of feeds) {
    try {
      for (const it of await fetchFeed(feed, source.proxy)) {
        const haystack = `${it.title} ${it.link ?? ""}`.toLowerCase();
        if (haystack.includes(kw)) {
          out.push(it);
          if (out.length >= n) return out;
        }
      }
    } catch {
      /* 跳过不可达源 */
    }
  }
  return out;
}

/** 抓取单个 RSS 源，返回清洗后的 {title, link} 列表 */
async function fetchFeed(url: string, proxy = ""): Promise<RealNewsItem[]> {
  const res = await fetchWithProxy(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/rss+xml,application/xml,text/xml,*/*" },
    redirect: "follow",
    proxy,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RSS 源返回 HTTP ${res.status}`);
  const xml = await res.text();
  const retrievedAt = new Date().toISOString();
  return parseRssItems(xml).map(item => ({ ...item, source: url, retrievedAt }));
}

/**
 * 抓取一条新闻链接的网页正文（Bot 点进 RSS 原文新闻时用）。
 * 复用浏览器 App 的零依赖 HTML→可读文本转换，返回正文纯文本（超长截断）。
 */
export async function fetchArticleText(url: string, proxy = ""): Promise<string> {
  const res = await fetchWithProxy(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    proxy,
  });
  if (!res.ok) throw new Error(`文章页返回 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_ARTICLE_BYTES) {
    throw new Error(`文章页过大（${(buf.byteLength / 1024 / 1024).toFixed(1)} MB）`);
  }
  const html = buf.toString("utf8");
  const parsed = parseHtml(html, res.url || url);
  const text = parsed.title ? `${parsed.title}\n\n${parsed.text}` : parsed.text;
  const trimmed = text.trim();
  if (!trimmed) return "（这篇新闻的网页一时加载不出可读文字。）";
  return trimmed.length > MAX_ARTICLE_CHARS ? trimmed.slice(0, MAX_ARTICLE_CHARS) + "\n…（正文过长，已截断）" : trimmed;
}

/** 极简 RSS/Atom XML 解析：抽 <item>（RSS）或 <entry>（Atom）的 title/link（够用即可，不引入 XML 依赖） */
export function parseRssItems(xml: string): RealNewsItem[] {
  const out: RealNewsItem[] = [];
  // RSS 2.0
  let re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const date = tagContent(m[1]!, "pubDate") || tagContent(m[1]!, "published") || tagContent(m[1]!, "updated");
    const millis = Date.parse(date);
    out.push({ title: cleanHtml(tagContent(m[1]!, "title")), link: attrOrTagContent(m[1]!, "link"), ...(Number.isFinite(millis) ? { publishedAt: new Date(millis).toISOString() } : {}) });
  }
  // Atom
  re = /<entry>([\s\S]*?)<\/entry>/g;
  while ((m = re.exec(xml)) !== null) {
    const date = tagContent(m[1]!, "pubDate") || tagContent(m[1]!, "published") || tagContent(m[1]!, "updated");
    const millis = Date.parse(date);
    out.push({ title: cleanHtml(tagContent(m[1]!, "title")), link: attrOrTagContent(m[1]!, "link"), ...(Number.isFinite(millis) ? { publishedAt: new Date(millis).toISOString() } : {}) });
  }
  return out;
}

function tagContent(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1]!.trim() : "";
}

/** RSS 的 <link> 是纯文本，Atom 的 <link href="…"/> 是属性：两者都兼容 */
function attrOrTagContent(xml: string, tag: string): string | undefined {
  const attr = xml.match(new RegExp(`<${tag}[^>]*href=["']([^"']+)["'][^>]*\\/?>`));
  if (attr) return attr[1]!;
  const inner = tagContent(xml, tag);
  return inner || undefined;
}

/** 把 HTML 实体与内联标签剥成纯文本 */
function cleanHtml(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
