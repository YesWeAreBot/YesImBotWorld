/**
 * 内置浏览器 App：Bot 用它浏览互联网。
 *
 * 双模式（创世时判定的世界性质，meta.json）：
 * - 现实世界：对接真实互联网——fetch 网页 → HTML 转可读文本（链接/图片编号化），
 *   搜索走可配置的引擎（默认 DuckDuckGo Lite）；网页里的图片可存进媒体缓存供发送/收藏；
 * - 虚构世界：World-LLM 扮演"这个世界的互联网"，直接生成完整 HTML 网页
 *   （与世界状态一致），文本浏览与截图共用同一份 HTML。
 *
 * 截图（两种模式都支持）依赖 koishi-plugin-puppeteer 提供的 ctx.puppeteer 服务：
 * - 现实世界：无头浏览器打开当前网址实拍；
 * - 虚构世界：渲染 World-LLM 生成的 HTML 后拍摄。
 * 截图自动存进收藏夹「截图」分类（未安装 puppeteer 时该操作优雅降级）。
 *
 * 带壳截图：网页画面外包一层手机 UI（状态栏、地址栏与浏览器按钮、底部手势条），
 * 像真实手机截屏。外壳来源优先级：用户自定义图片（apps.phoneShellImage）
 * > 创世时 World-LLM 依据世界观生成的外壳 HTML（meta.json）> 内置通用外壳。
 * 截图视口 = 手机分辨率（apps.phoneResolution，auto 时用创世判定值）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Context, Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import type { AppsConfig } from "../config.js";
import type { WorldFiles, WorldMeta } from "../files.js";
import type { CaptionService } from "../media/captioner.js";
import type { GalleryStore } from "../media/gallery.js";
import type { MediaStore } from "../media/store.js";
import type { MediaRef, RichText } from "../types.js";
import type { WorldAgent } from "../world/agent.js";
import type { AppRawTool, WorldApp } from "./app.js";
import { fetchWithProxy } from "../fetch.js";
import { fill } from "../prompts.js";
import { resolvePhoneResolution, type PhoneResolution } from "../phone.js";
import { extractHtml, parseHtml, type ParsedPage } from "./html.js";

const HTTP_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
/** 每屏正文字符数（长页面分屏，scroll_down 翻页） */
const SCREEN_CHARS = 2600;
const HISTORY_LIMIT = 10;
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

/**
 * 内置带壳截图外壳：手机状态栏 + 浏览器工具栏 + 屏幕区 + 底部手势条。
 * 全部使用 vw/vh 相对单位，适配任意分辨率；{{time}} {{url}} {{screen}} 渲染时替换。
 * 仅在「用户未配置外壳图片、创世也没生成外壳 HTML」时使用。
 */
const DEFAULT_SHELL_TEMPLATE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100vw;height:100vh;overflow:hidden;background:#0b0e13}
body{display:flex;flex-direction:column;font-family:-apple-system,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif}
.statusbar{height:3.2vh;flex:none;background:#0b0e13;color:#e8edf4;display:flex;align-items:center;justify-content:space-between;padding:0 4vw;font-size:1.55vh;font-weight:600}
.statusbar .icons{display:flex;align-items:center;gap:1.8vw}
.statusbar svg{height:1.7vh;width:auto;display:block}
.toolbar{height:5.4vh;flex:none;background:#151a22;display:flex;align-items:center;gap:2.2vw;padding:0 3vw;border-bottom:1px solid #232a35}
.tbtn{color:#aeb9c8;font-size:2.6vh;line-height:1;flex:none;width:3.2vh;text-align:center;font-weight:300}
.tbtn.dim{color:#4a5464}
.addr{flex:1;min-width:0;height:3.7vh;background:#0d1117;border:1px solid #232a35;border-radius:2vh;display:flex;align-items:center;padding:0 3.2vw;color:#9aa7b8;font-size:1.5vh;overflow:hidden;white-space:nowrap}
.addr svg{height:1.5vh;width:auto;flex:none;margin-right:1.8vw;opacity:.65}
.addr span{overflow:hidden;text-overflow:ellipsis}
.screen{flex:1;width:100%;min-height:0;object-fit:cover;object-position:top center;display:block;background:#fff}
.navbar{height:2.8vh;flex:none;background:#0b0e13;display:flex;align-items:center;justify-content:center}
.navbar i{width:12vw;height:.55vh;border-radius:99px;background:#39424f;display:block}
</style></head><body>
<div class="statusbar"><span>{{time}}</span><span class="icons">
<svg viewBox="0 0 18 12" fill="#e8edf4"><rect x="0" y="8" width="3" height="4" rx="0.8"/><rect x="5" y="5.5" width="3" height="6.5" rx="0.8"/><rect x="10" y="3" width="3" height="9" rx="0.8"/><rect x="15" y="0" width="3" height="12" rx="0.8"/></svg>
<svg viewBox="0 0 16 12" fill="none" stroke="#e8edf4" stroke-width="1.6" stroke-linecap="round"><path d="M1.5 4.5a10 10 0 0 1 13 0"/><path d="M4 7.2a6.4 6.4 0 0 1 8 0"/><circle cx="8" cy="10" r="1.3" fill="#e8edf4" stroke="none"/></svg>
<svg viewBox="0 0 24 12"><rect x="0.8" y="0.8" width="19" height="10.4" rx="2.6" fill="none" stroke="#e8edf4" stroke-width="1.4"/><rect x="3" y="3" width="12" height="6" rx="1.2" fill="#e8edf4"/><rect x="21.4" y="3.6" width="2.2" height="4.8" rx="1.1" fill="#e8edf4"/></svg>
</span></div>
<div class="toolbar"><span class="tbtn">&#8249;</span><span class="tbtn dim">&#8250;</span><div class="addr"><svg viewBox="0 0 10 13" fill="#9aa7b8"><rect x="0" y="5" width="10" height="8" rx="1.6"/><path d="M2.4 5V3.6a2.6 2.6 0 0 1 5.2 0V5" fill="none" stroke="#9aa7b8" stroke-width="1.5"/></svg><span>{{url}}</span></div><span class="tbtn">&#10227;</span></div>
<img class="screen" src="{{screen}}">
<div class="navbar"><i></i></div>
</body></html>`;

/**
 * 用户自定义外壳图片的合成模板：网页画面垫底、外壳图片拉伸覆盖在最上层
 * （屏幕区域透明的设备边框素材）。
 */
const IMAGE_SHELL_TEMPLATE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100vw;height:100vh;overflow:hidden;background:#000}
.screen,.shell{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.screen{object-fit:cover;object-position:top center}
.shell{object-fit:fill;pointer-events:none}
</style></head><body><img class="screen" src="{{screen}}"><img class="shell" src="{{shellImage}}"></body></html>`;

/** koishi-plugin-puppeteer 的 ctx.puppeteer 服务（可选依赖，宽松类型） */
interface PuppeteerPageLike {
  setViewport(v: { width: number; height: number }): Promise<void>;
  setUserAgent?(ua: string): Promise<void>;
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  setContent(html: string, opts?: Record<string, unknown>): Promise<void>;
  screenshot(opts?: Record<string, unknown>): Promise<Uint8Array | Buffer | string>;
  close(): Promise<void>;
}
interface PuppeteerLike {
  page(): Promise<PuppeteerPageLike>;
}

interface BrowserPage extends ParsedPage {
  /** 展示用地址（现实=真实 URL；虚构=虚构网址或「搜索：xxx」） */
  url: string;
  /** 虚构模式：World-LLM 生成的原始 HTML（截图用）；现实模式不缓存 */
  html?: string;
  /** 当前滚动到第几屏（0 起） */
  screen: number;
}

export class BrowserApp implements WorldApp {
  readonly id = "browser";
  readonly name = "浏览器";
  readonly description = "上网：搜索、打开网页，可以截图保存";

  private current: BrowserPage | null = null;
  private history: BrowserPage[] = [];

  constructor(
    private ctx: Context,
    private world: WorldAgent,
    private files: WorldFiles,
    private clock: WorldClock,
    private media: MediaStore,
    private gallery: GalleryStore,
    private captioner: CaptionService,
    /** Bot-LLM 能否原生看到该媒体（service 注入，与渲染管线同一判定） */
    private canAttach: (ref: MediaRef) => boolean,
    private cfg: AppsConfig,
    private logger: Logger,
  ) {}

  private async isRealWorld(): Promise<boolean> {
    const meta = await this.files.readMeta();
    return meta.realWorld ?? this.clock.syncRealTime;
  }

  async open(): Promise<{ tools: AppRawTool[] }> {
    const real = await this.isRealWorld();
    const tools: AppRawTool[] = [
      {
        name: "search",
        description: "搜索互联网，得到一页搜索结果（结果里的链接可用 open_link 点开）。",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "搜索词" } },
          required: ["query"],
        },
      },
      {
        name: "open_url",
        description: "在地址栏输入网址并打开。",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", description: "网址" } },
          required: ["url"],
        },
      },
      {
        name: "open_link",
        description: "点开当前页面里的一个链接。n 为页面文字后 [n] 标注的链接编号。",
        inputSchema: {
          type: "object",
          properties: { n: { type: "number", description: "链接编号" } },
          required: ["n"],
        },
      },
      {
        name: "scroll_down",
        description: "向下滚动，继续阅读当前页面的后续内容（页面太长时分屏显示）。",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "go_back",
        description: "后退到上一个页面。",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    // 截图组件（puppeteer）可用时才提供 screenshot：避免 Bot 反复尝试不存在的能力后拿页内图凑数
    if (this.puppeteer) {
      tools.push({
        name: "screenshot",
        description:
          "把**浏览器当前画面**拍成一张截图（像手机截屏：网址栏下是排版好的网页，别人一看就知道是网页截图），" +
          "自动存进你收藏夹的「截图」分类，并给出图片编号供 send 发送。" +
          "**别人想看『这个网页/页面的样子』时用这个**——发网页内容里的某张图片（save_image）代替不了网页截图。" +
          "description 可选：给这张截图写一句描述（默认用页面标题）。",
        inputSchema: {
          type: "object",
          properties: { description: { type: "string", description: "截图描述" } },
        },
      });
    }
    if (real) {
      tools.splice(
        5,
        0,
        {
          name: "view_image",
          description:
            "点开当前页面里的一张图片仔细看看内容（{图n} 的 alt 文字常常缺失或含糊，" +
            "**决定保存/发送某张页内图之前先用它确认**，别只凭标注猜）。n 为 {图n} 标注的图片编号。",
          inputSchema: {
            type: "object",
            properties: { n: { type: "number", description: "图片编号" } },
            required: ["n"],
          },
        },
        {
          name: "save_image",
          description:
            "把当前页面**内容里嵌的某一张图片**（{图n} 标注）单独保存下来（存入媒体缓存，得到图片编号——" +
            "可直接用 send 发送，喜欢可 gallery_save 收藏）。拿不准内容先 view_image 看一眼。" +
            "注意：这保存的是网页里的插图/配图本身，**不是网页截图**；要发『网页的样子』请用 screenshot。",
          inputSchema: {
            type: "object",
            properties: { n: { type: "number", description: "图片编号" } },
            required: ["n"],
          },
        },
      );
    }
    return { tools };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string | RichText> {
    const real = await this.isRealWorld();
    switch (tool) {
      case "search": {
        const query = String(args.query ?? args.q ?? "").trim();
        if (!query) return "（search 需要 query 参数：想搜什么？）";
        return real ? this.realSearch(query) : this.virtualNavigate({ search: query });
      }
      case "open_url": {
        const url = String(args.url ?? args.href ?? "").trim();
        if (!url) return "（open_url 需要 url 参数。）";
        return real ? this.realOpen(normalizeUrl(url)) : this.virtualNavigate({ url });
      }
      case "open_link": {
        const n = Number(args.n ?? args.link ?? args.index);
        if (!this.current) return "（还没有打开任何页面：先 search 或 open_url。）";
        if (!Number.isFinite(n) || n < 1 || n > this.current.links.length) {
          return `（当前页面没有链接 [${args.n}]。页面上共有 ${this.current.links.length} 个链接。）`;
        }
        const link = this.current.links[n - 1]!;
        return real
          ? this.realOpen(link.url)
          : this.virtualNavigate({ url: link.url, fromLink: link.text });
      }
      case "scroll_down":
        return this.scrollDown();
      case "go_back": {
        const prev = this.history.pop();
        if (!prev) return "（没有可以后退的页面了。）";
        this.current = prev;
        this.current.screen = 0;
        return this.renderScreen("你按了后退，回到之前的页面。");
      }
      case "view_image":
      case "save_image": {
        if (!real) return "（这个操作不可用。）";
        const n = Number(args.n ?? args.image ?? args.index);
        if (!this.current) return "（还没有打开任何页面。）";
        if (!Number.isFinite(n) || n < 1 || n > this.current.images.length) {
          return `（当前页面没有图片 {图${args.n}}。页面上共标注了 ${this.current.images.length} 张图。）`;
        }
        const img = this.current.images[n - 1]!;
        return tool === "view_image" ? this.viewImage(n, img) : this.saveImage(img);
      }
      case "screenshot": {
        if (!this.current) return "（还没有打开任何页面，没什么可截的。）";
        const desc = args.description != null ? String(args.description).trim() : "";
        return this.screenshot(real, desc);
      }
      default:
        throw new Error(`浏览器没有 ${tool} 这个操作`);
    }
  }

  async close(): Promise<void> {
    /* 页面状态保留（像真实手机浏览器一样，下次打开还在） */
  }

  // ---------- 页面呈现 ----------

  private pushHistory(): void {
    if (!this.current) return;
    this.history.push(this.current);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  /** 当前页按屏渲染：标题栏 + 本屏正文 + 页脚导航提示 */
  private renderScreen(prefix?: string): string {
    const page = this.current;
    if (!page) return "（没有打开的页面。）";
    const screens = splitScreens(page.text);
    const idx = Math.min(page.screen, screens.length - 1);
    const body = screens.length ? screens[idx]! : "（这个页面上没有可读的文字。）";

    const header = `「${page.title || "无标题"}」 ${page.url}`;
    const footer: string[] = [];
    if (screens.length > 1) {
      footer.push(`第 ${idx + 1}/${screens.length} 屏${idx < screens.length - 1 ? "，scroll_down 继续往下看" : "（已到底）"}`);
    }
    if (page.links.length) footer.push(`链接 [n] 用 open_link 点开`);
    if (page.images.length) footer.push(`页内图片 {图n}：view_image 点开细看，save_image 单独保存`);
    if (this.puppeteer) footer.push(`想把这个页面的样子发给别人/留档：screenshot 截图后 send 截图编号`);
    return (
      (prefix ? `${prefix}\n` : "") +
      `${header}\n----\n${body}` +
      (footer.length ? `\n----\n（${footer.join("；")}）` : "")
    );
  }

  private scrollDown(): string {
    const page = this.current;
    if (!page) return "（还没有打开任何页面。）";
    const screens = splitScreens(page.text);
    if (page.screen >= screens.length - 1) return "（已经到页面底部了。）";
    page.screen++;
    return this.renderScreen();
  }

  // ---------- 现实模式：真实互联网 ----------

  private async realSearch(query: string): Promise<string> {
    const base = this.cfg.browserSearchURL.trim() || "https://www.so.com/s?q=%s";
    const url = base.includes("%s")
      ? base.replace("%s", encodeURIComponent(query))
      : base + encodeURIComponent(query);
    return this.realOpen(url, `你搜索了「${query}」。`);
  }

  private async realOpen(url: string, prefix?: string): Promise<string> {
    let res: Response;
    try {
      res = await fetchWithProxy(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        proxy: this.cfg.browserProxy,
      });
    } catch (err) {
      return `（打不开 ${url}：${(err as Error).message ?? err}。检查网址，或稍后再试。）`;
    }
    if (!res.ok) return `（${url} 返回了错误：HTTP ${res.status}。）`;

    const ctype = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    // 直接打开的是图片：顺手存进媒体缓存
    if (ctype.startsWith("image/")) {
      const id = await this.media.ingest(res.url || url, "image", undefined, this.cfg.browserProxy);
      return id !== null
        ? `这个网址是一张图片，已存入你的媒体缓存：[图片#${id}]（可用 send 发送，喜欢可 gallery_save 收藏）。`
        : "（这个网址是一张图片，但下载失败了。）";
    }
    if (ctype && !ctype.includes("html") && !ctype.startsWith("text/")) {
      return `（${url} 不是网页（${ctype}），浏览器打不开它。）`;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_HTML_BYTES) return `（这个页面太大了（${(buf.byteLength / 1024 / 1024).toFixed(1)} MB），加载不动。）`;
    const html = decodeHtmlBytes(buf, res.headers.get("content-type"));
    const finalUrl = res.url || url;
    const parsed = parseHtml(html, finalUrl);
    // 搜索引擎的跳转链接还原为真实目标（DuckDuckGo /l/?uddg=）
    for (const link of parsed.links) link.url = unwrapRedirect(link.url);

    this.pushHistory();
    this.current = { ...parsed, url: finalUrl, screen: 0 };
    return this.renderScreen(prefix);
  }

  /** 点开页内图片细看：原生识图 → 附原图；否则 → 解释器详述 */
  private async viewImage(n: number, img: { url: string; alt: string }): Promise<string | RichText> {
    const id = await this.media.ingest(img.url, "image", undefined, this.cfg.browserProxy);
    if (id === null) return `（图片加载失败（${img.url.slice(0, 100)}），点不开。）`;
    const row = await this.media.get(id);
    if (!row) return "（图片加载失败。）";
    const label = `{图${n}} [图片#${id}]${img.alt ? `（${img.alt}）` : ""}`;
    if (this.canAttach(row.ref)) {
      return {
        text: `你点开了 ${label}，原图见附件。（想保存/发送就 save_image 或直接 send 这个编号）`,
        attachments: [row.ref],
      };
    }
    const detail = await this.captioner.describeDetailed(row.ref);
    return detail
      ? `你点开了 ${label}，仔细看了看：${detail}\n（想保存/发送就 save_image 或直接 send 这个编号）`
      : `（你点开了 ${label}，但没有可用的识图能力，看不清内容。）`;
  }

  private async saveImage(img: { url: string; alt: string }): Promise<string> {
    const id = await this.media.ingest(img.url, "image", undefined, this.cfg.browserProxy);
    if (id === null) return `（保存失败：图片下载不下来（${img.url.slice(0, 100)}）。）`;
    // alt 只在没有图片解释器时充当摘要兜底（有解释器时留空，让它产出更可靠的内容描述）
    if (img.alt && !this.captioner.enabledFor("image")) {
      const row = await this.media.get(id);
      if (row && !row.summary) await this.media.setSummary(id, `网页图片：${img.alt}`);
    }
    return (
      `图片已保存到你的媒体缓存：[图片#${id}]${img.alt ? `（${img.alt}）` : ""}。` +
      `可以直接用 send 发送；想长期留着就 gallery_save 收藏（记得选分类、写描述）。`
    );
  }

  // ---------- 虚构模式：World-LLM 扮演互联网 ----------

  private async virtualNavigate(
    nav: { url?: string; search?: string; fromLink?: string },
  ): Promise<string> {
    const what = nav.search
      ? `在浏览器里搜索了「${nav.search}」`
      : nav.fromLink
        ? `在当前网页（${this.current?.url ?? "未知页面"}，标题「${this.current?.title ?? ""}」）里点开了链接「${nav.fromLink}」（指向 ${nav.url}）`
        : `在浏览器地址栏输入并打开了 ${nav.url}`;
    const task =
      `Bot 拿出手机，${what}（当前 ${this.clock.timeLine()}）。\n` +
      `请扮演这个世界的互联网，生成 Bot 屏幕上加载出的网页：\n` +
      `1. check world_status（必要时也看 bot_status 与 news）：网页内容必须符合世界观与世界当前状态；` +
      `如果这个世界没有互联网、无信号、或该网址不存在，就如实生成对应的错误页（如无法连接/404）。\n` +
      `2. 若网页披露了世界状态中没有的重要新信息（新的组织、事件、事实），酌情 update world_status 记录，保证以后一致。\n` +
      `3. 最后输出这个网页的完整 HTML 文档（从 <!DOCTYPE html> 或 <html> 开始）：\n` +
      `   - 像真实网页：有 <title>，正文内容具体、信息量适中（正文几百字为宜），不要写"这是一个关于…的网页"式的描述；\n` +
      `   - ${nav.search ? "这是搜索结果页：列出若干条结果，每条是一个 <a href=\"虚构但合理的网址\">标题</a> 加一两句摘要；" : "页面里可以放几个 <a href=\"虚构但合理的网址\">链接</a> 供继续点击；"}\n` +
      `   - 不要引用任何外部资源（图片、脚本、样式表都不要）；需要样式就写在 <style> 里；\n` +
      `   - 除 HTML 外不要输出任何解释。`;

    let raw: string;
    try {
      raw = await this.world.query(task);
    } catch (err) {
      this.logger.warn("虚构网页生成失败: %s", err);
      return "（浏览器转了半天圈，页面加载失败了。稍后再试试。）";
    }
    const html = extractHtml(raw);
    if (!html) return "（页面加载出来一片乱码，什么都看不清。刷新试试。）";

    const displayUrl = nav.search ? `search://${nav.search}` : nav.url!;
    const parsed = parseHtml(html, displayUrl);
    this.pushHistory();
    this.current = { ...parsed, url: displayUrl, html, screen: 0 };
    return this.renderScreen(nav.search ? `你搜索了「${nav.search}」。` : undefined);
  }

  // ---------- 截图（两种模式通用，依赖 ctx.puppeteer） ----------

  private get puppeteer(): PuppeteerLike | null {
    const svc = (this.ctx as unknown as Record<string, unknown>).puppeteer;
    return svc && typeof (svc as PuppeteerLike).page === "function" ? (svc as PuppeteerLike) : null;
  }

  private async screenshot(real: boolean, desc: string): Promise<string> {
    const page = this.current!;
    const pptr = this.puppeteer;
    if (!pptr) {
      return "（截图失败：这台手机没有截图组件。让主人安装并启用 koishi-plugin-puppeteer 后就能截图了。）";
    }
    if (!real && !page.html) {
      return "（这个页面没法截图（缺少页面内容）。重新打开它试试。）";
    }

    const meta = await this.files.readMeta();
    const viewport = resolvePhoneResolution(this.cfg.phoneResolution, meta);

    // 第一步：拍网页本身（手机分辨率视口）
    let png: Buffer;
    try {
      png = await this.capture(pptr, viewport, async (tab) => {
        if (real) {
          await tab.goto(page.url, { waitUntil: "networkidle2", timeout: HTTP_TIMEOUT_MS });
        } else {
          await tab.setContent(page.html!, { waitUntil: "load", timeout: HTTP_TIMEOUT_MS });
        }
      });
    } catch (err) {
      this.logger.warn("网页截图失败 (%s): %s", page.url, err);
      return `（截图失败：${(err as Error).message ?? err}）`;
    }

    // 第二步：带壳合成——手机状态栏 + 浏览器工具栏等 UI 包住网页画面。
    // 外壳来源：用户自定义图片 > 创世时 World-LLM 生成的外壳 HTML > 内置外壳。
    // 合成失败不阻塞主流程，退回裸截图。
    try {
      const shellHtml = await this.buildShellHtml(meta, viewport, page, png);
      png = await this.capture(pptr, viewport, (tab) =>
        tab.setContent(shellHtml, { waitUntil: "load", timeout: HTTP_TIMEOUT_MS }),
      );
    } catch (err) {
      this.logger.warn("带壳截图合成失败，使用裸截图 (%s): %s", page.url, err);
    }

    // 入媒体缓存 + 存进收藏夹「截图」分类
    const id = await this.media.ingest(`data:image/png;base64,${png.toString("base64")}`, "image");
    if (id === null) return "（截图拍下来了，但保存失败。）";
    const row = await this.media.get(id);
    if (!row) return "（截图拍下来了，但保存失败。）";
    const description =
      desc || `「${page.title || "无标题"}」网页截图（${page.url}）`;
    if (!row.summary) await this.media.setSummary(id, description);
    const name = await this.gallery.importFile(
      row.ref.file,
      "截图",
      `web-${id}.png`,
      row.sha256,
      description,
    );
    return (
      `咔嚓——截图已存进收藏夹 截图/${name}：[图片#${id}]（${description}）。` +
      `可以直接用 send 发送。`
    );
  }

  /** 开一个页签完成一次加载 + 截图（视口 = 手机分辨率），保证页签关闭 */
  private async capture(
    pptr: PuppeteerLike,
    viewport: PhoneResolution,
    load: (tab: PuppeteerPageLike) => Promise<unknown>,
  ): Promise<Buffer> {
    const tab = await pptr.page();
    try {
      await tab.setViewport(viewport);
      if (tab.setUserAgent) await tab.setUserAgent(USER_AGENT).catch(() => {});
      await load(tab);
      const shot = await tab.screenshot({ type: "png" });
      return Buffer.isBuffer(shot) ? shot : Buffer.from(shot as Uint8Array);
    } finally {
      await tab.close().catch(() => {});
    }
  }

  /** 组装带壳合成页：外壳来源依次为 用户图片 > 创世生成 HTML > 内置模板 */
  private async buildShellHtml(
    meta: WorldMeta,
    viewport: PhoneResolution,
    page: BrowserPage,
    contentPng: Buffer,
  ): Promise<string> {
    const vars: Record<string, string | number> = {
      screen: `data:image/png;base64,${contentPng.toString("base64")}`,
      url: escapeHtml(page.url.slice(0, 160)),
      title: escapeHtml((page.title || "").slice(0, 80)),
      time: clockHm(this.clock.timeLine()),
      width: viewport.width,
      height: viewport.height,
    };
    // 1. 用户自定义外壳图片（屏幕区域透明的边框素材，拉伸覆盖在最上层）
    const imgPath = (this.cfg.phoneShellImage || "").trim();
    if (imgPath) {
      const dataUrl = await this.readShellImage(imgPath);
      if (dataUrl) return fill(IMAGE_SHELL_TEMPLATE, { ...vars, shellImage: dataUrl });
      this.logger.warn("自定义外壳图片不可用（%s），退回生成/内置外壳", imgPath);
    }
    // 2. 创世时 World-LLM 生成的外壳（meta.json phoneShellHtml，可手动编辑）
    if (meta.phoneShellHtml && meta.phoneShellHtml.includes("{{screen}}")) {
      return fill(meta.phoneShellHtml, vars);
    }
    // 3. 内置通用外壳
    return fill(DEFAULT_SHELL_TEMPLATE, vars);
  }

  private async readShellImage(p: string): Promise<string | null> {
    try {
      const abs = path.isAbsolute(p) ? p : path.resolve(this.ctx.baseDir, p);
      const buf = await fs.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : "image/png";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  }
}

// ---------- 工具函数 ----------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 从世界时刻串里提取 HH:mm（自定义历法无标准时分时返回空串） */
function clockHm(timeLine: string): string {
  return timeLine.match(/\b(\d{1,2}:\d{2})\b/)?.[1] ?? "";
}

function normalizeUrl(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

/** 还原搜索引擎的跳转链接为真实目标（360 /jump?u=、DuckDuckGo /l/?uddg=、Bing /ck/a?u=a1…） */
export function unwrapRedirect(url: string): string {
  try {
    const u = new URL(url);
    // 360 搜索：/jump?u=<目标>
    if (u.hostname.endsWith("so.com") && u.pathname === "/jump") {
      const target = u.searchParams.get("u");
      if (target && /^https?:\/\//i.test(target)) return target;
    }
    // DuckDuckGo：/l/?uddg=<目标>
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname.startsWith("/l/")) {
      const target = u.searchParams.get("uddg");
      if (target && /^https?:\/\//i.test(target)) return target;
    }
    // Bing：/ck/a?...&u=a1<base64url(目标)>
    if (u.hostname.endsWith("bing.com") && u.pathname.startsWith("/ck/")) {
      const packed = u.searchParams.get("u");
      if (packed?.startsWith("a1")) {
        const decoded = Buffer.from(
          packed.slice(2).replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
        ).toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
  } catch {
    /* 保留原样 */
  }
  return url;
}

/** 按字符数把正文切成屏（按行切，不打断段落行） */
function splitScreens(text: string): string[] {
  if (!text) return [];
  const screens: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf && buf.length + line.length + 1 > SCREEN_CHARS) {
      screens.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) screens.push(buf);
  return screens;
}

/** 按 content-type / meta 提示解码 HTML 字节（默认 UTF-8，兼容 GBK 站点） */
function decodeHtmlBytes(buf: Buffer, contentType: string | null): string {
  const charset =
    contentType?.match(/charset=([\w-]+)/i)?.[1] ??
    buf.subarray(0, 2048).toString("latin1").match(/charset=["']?([\w-]+)/i)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset.toLowerCase()).decode(buf);
    } catch {
      /* 未知编码：退回 UTF-8 */
    }
  }
  return buf.toString("utf8");
}
