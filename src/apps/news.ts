/**
 * 内置新闻 App。
 *
 * Bot 手机里的「新闻」应用：翻阅世界的最近大事（News.jsonl，World-LLM 维护的世界中心重大事件）。
 * 支持像新闻 App 一样：
 * - 看最近头条（headlines）；
 * - 按关键词搜索（search_news）；
 * - 按时间范围回看（search_news_time，T 时间单位）；
 * - 点进某条新闻看详情（open_news）。
 *
 * 现实世界设定下，真实新闻会由 Tingle 心跳自动抓取、经 World-LLM 摘编后写入 News.jsonl
 * （含 title 简述 + detail 详情正文），所以 Bot 点进世界新闻时能看到完整的展开内容；
 * search_news 还会直接搜 RSS 原文，这些原文标题也能点进去抓取网页正文。
 * 对 Bot 而言这些都是"它的世界的新闻"，无需区分来源。
 */

import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { AppsConfig } from "../config.js";
import type { WorldFiles } from "../files.js";
import type { NewsEntry } from "../types.js";
import type { AppRawTool, WorldApp } from "./app.js";
import { fetchArticleText, searchHeadlines } from "./newsFeed.js";

/** 一条"可点进去"的新闻项：要么是世界内新闻（含 detail），要么是 RSS 原文（含 link） */
interface OpenableItem {
  kind: "world" | "rss";
  /** 列表显示用的标题行 */
  headline: string;
  /** 世界内新闻条目（kind=world） */
  entry?: NewsEntry;
  /** RSS 原文标题 + 链接（kind=rss） */
  title?: string;
  link?: string;
}

export class NewsApp implements WorldApp {
  readonly id = "news";
  readonly name = "新闻";
  readonly description = "翻阅世界的最近大事：看头条、搜索、按时间回看，还能点进某条看详情";

  /** 最近一次列表展示的条目（供 open_news 按编号点进去） */
  private current: OpenableItem[] = [];

  constructor(
    private files: WorldFiles,
    private clock: WorldClock,
    private cfg: AppsConfig,
    private logger: Logger,
  ) {}

  private async isRealWorld(): Promise<boolean> {
    const meta = await this.files.readMeta();
    return meta.realWorld ?? this.clock.syncRealTime;
  }

  async open(): Promise<{ tools: AppRawTool[]; opening: string }> {
    const recent = await this.files.readNews(5);
    const opening = recent.length
      ? `你点开了新闻应用，首页头条扑面而来：\n${recent.map((e) => `· [${e.clock}] ${e.content}`).join("\n")}`
      : "你点开了新闻应用，首页空荡荡的——世界近来还没有什么大事。";
    return {
      tools: [
        {
          name: "headlines",
          description: "看最近的新闻头条，列出最近 n 条（默认 10），每条带编号，可用 open_news 点进看详情。打开应用时已看到前几条。",
          inputSchema: {
            type: "object",
            properties: { n: { type: "integer", description: "条数（默认 10）" } },
          },
        },
        {
          name: "search_news",
          description:
            "按关键词搜索新闻（同时命中世界内已记录的新闻与现实世界当下真实的新闻），结果带编号，可 open_news 点进看详情。如 search_news(keyword: \"地震\")。",
          inputSchema: {
            type: "object",
            properties: {
              keyword: { type: "string", description: "关键词" },
              n: { type: "integer", description: "最多返回条数（默认 10）" },
            },
            required: ["keyword"],
          },
        },
        {
          name: "search_news_time",
          description:
            "按时间范围回看新闻：只返回 T（时间单位）落在 since 与 until 之间的世界内新闻。since / until 填 T 的数值（可在结果里的「T=12.5」或 check_time 里看到），可只给一端；不填则默认最近 n 条。结果带编号，可 open_news 点进。",
          inputSchema: {
            type: "object",
            properties: {
              since: { type: "number", description: "起始时间（T，含）" },
              until: { type: "number", description: "结束时间（T，含）" },
              n: { type: "integer", description: "最多返回条数（默认 10）" },
            },
          },
        },
        {
          name: "open_news",
          description:
            "点进某条新闻查看详情（标题列表里的编号 n，如 open_news(3)）。世界内新闻会展开它的详情正文；现实世界的原文新闻会抓取该新闻的网页正文。",
          inputSchema: {
            type: "object",
            properties: { n: { type: "integer", description: "列表里的第几号新闻（从 1 开始）" } },
            required: ["n"],
          },
        },
      ],
      opening,
    };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case "headlines":
        return this.headlines(args);
      case "search_news":
        return this.search(args);
      case "search_news_time":
        return this.searchTime(args);
      case "open_news":
        return this.openNews(args);
      default:
        throw new Error(`新闻应用没有 ${tool} 这个操作`);
    }
  }

  async close(): Promise<void> {
    /* 列表状态保留（像真实 App 一样，下次打开还能接着点当前列表） */
  }

  // ---------- 操作 ----------

  private async headlines(args: Record<string, unknown>): Promise<string> {
    const n = clampInt(args.n, 1, 50, 10);
    const news = await this.files.readNews(n);
    this.current = news.map((e) => ({ kind: "world", headline: worldHeadline(e), entry: e }));
    return this.renderList(this.current, "最近的新闻头条");
  }

  private async search(args: Record<string, unknown>): Promise<string> {
    const keyword = String(args.keyword ?? "").trim();
    if (!keyword) return "（搜索新闻需要 keyword 参数。）";
    const n = clampInt(args.n, 1, 50, 10);

    const items: OpenableItem[] = [];
    // 世界内已记录的新闻（含 detail）
    const kw = keyword.toLowerCase();
    for (const e of (await this.files.readNewsAll()).filter((e) => e.content.toLowerCase().includes(kw)).slice(-n)) {
      items.push({ kind: "world", headline: worldHeadline(e), entry: e });
    }
    // 现实世界设定：额外搜 RSS 原文
    if (await this.isRealWorld()) {
      try {
        for (const it of await searchHeadlines({ feeds: this.cfg.newsFeeds, proxy: this.cfg.browserProxy }, keyword, n)) {
          items.push({ kind: "rss", headline: it.title, title: it.title, link: it.link });
        }
      } catch (err) {
        this.logger.warn("搜索现实新闻失败: %s", err);
      }
    }
    this.current = items.slice(0, n);
    return this.renderList(this.current, `与「${keyword}」相关的新闻`);
  }

  private async searchTime(args: Record<string, unknown>): Promise<string> {
    const n = clampInt(args.n, 1, 50, 10);
    const since = asFiniteNumber(args.since);
    const until = asFiniteNumber(args.until);
    let news = await this.files.readNewsAll();
    if (since != null) news = news.filter((e) => e.t >= since);
    if (until != null) news = news.filter((e) => e.t <= until);
    news = news.slice(-n);
    this.current = news.map((e) => ({ kind: "world", headline: worldHeadline(e), entry: e }));
    if (since == null && until == null) {
      return this.renderList(this.current, "最近的新闻头条");
    }
    const range = [since != null ? `T≥${since.toFixed(1)}` : "", until != null ? `T≤${until.toFixed(1)}` : ""]
      .filter(Boolean)
      .join(" 且 ");
    return this.renderList(this.current, `时间范围（${range}）内的新闻`);
  }

  private async openNews(args: Record<string, unknown>): Promise<string> {
    const idx = clampInt(args.n, 1, 1 << 20, 0);
    const item = this.current[idx - 1];
    if (!item) {
      return this.current.length
        ? `（新闻列表里没有第 ${args.n} 条。当前列表共有 ${this.current.length} 条，编号从 1 开始。）`
        : "（你还没看过任何新闻列表：先用 headlines / search_news / search_news_time 列出新闻，再点进去。）";
    }
    if (item.kind === "world") {
      const e = item.entry!;
      const detail = e.detail?.trim();
      return detail
        ? `你点开了这条新闻——\n【T=${e.t.toFixed(1)} ${e.clock}】${e.content}\n\n${detail}`
        : `你点开了这条新闻——\n【T=${e.t.toFixed(1)} ${e.clock}】${e.content}\n\n（这条只有一句简讯，没有更多详情。）`;
    }
    // RSS 原文：抓取网页正文
    if (!item.link) return `你点开了「${item.title ?? ""}」——但它没有附带原文链接。`;
    try {
      const text = await fetchArticleText(item.link, this.cfg.browserProxy);
      return `你点开了这条新闻——\n${item.title}\n\n${text}`;
    } catch (err) {
      this.logger.warn("抓取新闻原文失败（%s）: %s", item.link, err);
      return `你点开了「${item.title ?? ""}」，但原文网页打不开（${(err as Error).message ?? err}）。过会儿再试，或换一条。`;
    }
  }

  private renderList(items: OpenableItem[], label: string): string {
    if (!items.length) return `（新闻应用上${label ? `「${label}」` : ""}这一栏还是一片空白。）`;
    return (
      `你划着新闻应用，${label}映入眼帘：\n` +
      items.map((it, i) => `[${i + 1}] ${it.headline}`).join("\n") +
      `\n（想细看哪条，就用 open_news(编号) 点进去。）`
    );
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 世界内新闻的列表行：同时带 T 数值与可读时间，便于按 T 继续回看 */
function worldHeadline(e: NewsEntry): string {
  return `[T=${e.t.toFixed(1)} ${e.clock}] ${e.content}`;
}

function asFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
