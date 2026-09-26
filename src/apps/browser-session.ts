import { createHash, randomUUID } from "node:crypto";
import { browserClickPoint, browserElement, inspectBrowserDocument } from "./browser-dom.js";
import type { PhoneResolution } from "../phone.js";

// Evaluated inside Chromium; the plugin itself is compiled without the DOM library.
declare const location: { protocol: string; origin: string };
declare const window: { scrollTo(x: number, y: number): void };

export interface BrowserServiceLike {
  browser?: {
    createBrowserContext?(options?: { proxyServer?: string }): Promise<any>;
    createIncognitoBrowserContext?(): Promise<any>;
  };
}
export interface BrowserControl {
  ref: string; role: string; label: string; type?: string; href?: string; disabled?: boolean; readonly?: boolean;
  value?: string; checked?: boolean; options?: { value: string; label: string }[];
  x: number; y: number; width: number; height: number;
}
export interface BrowserSnapshot {
  revision: number; url: string; title: string; text: string; description: string;
  elements: BrowserControl[]; links: { url: string; text: string; ref: string }[];
  images: { url: string; alt: string; width: number; height: number }[];
  videos: { url: string; poster: string; paused: boolean; duration: number | null }[];
  viewport: PhoneResolution; scrollX: number; scrollY: number; notice?: string;
  focusedRef: string | null;
  canGoBack?: boolean; canGoForward?: boolean;
}
export interface BrowserNavigationEntry { url: string; title: string; scrollX: number; scrollY: number; restorable: boolean }
export interface BrowserOriginState { origin: string; localStorage: Record<string, string>; sessionStorage?: Record<string, string> }
export interface BrowserSessionState {
  schemaVersion: 1;
  navigation: { entries: BrowserNavigationEntry[]; cursor: number };
  /** Context-scoped Chromium cookies, including HttpOnly cookies; never exposed as page content. */
  cookies: Record<string, unknown>[];
  origins: BrowserOriginState[];
}
export interface BrowserSessionPersistence {
  load(): Promise<BrowserSessionState | undefined>;
  save(state: BrowserSessionState): Promise<void>;
}
export type BrowserAction =
  | { kind: "click" | "fill"; revision: number; ref: string; value?: string }
  | { kind: "key"; revision: number; key: string }
  | { kind: "scroll"; revision: number; pixels: number }
  | { kind: "back" | "forward" | "reload"; revision: number }
  | { kind: "point"; revision: number; x: number; y: number; width: number; height: number };

export function safeBrowserUrl(value: string): string {
  const raw = value.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : "https://" + raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("浏览器只允许 http/https 网页地址；不能打开本地文件、脚本地址或含密码的 URL。");
  return url.href;
}

/** A dedicated, persistent browser context. It never uses Puppeteer's shared default page. */
export class BrowserSession {
  private context: any;
  private page: any;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private snapshot?: BrowserSnapshot;
  private stamp = "";
  private documentId = "";
  private readonly registry = "__yib_" + randomUUID().replaceAll("-", "");
  private popup?: Promise<void>;
  private disposing?: Promise<void>;
  private loaded = false;
  private restored = false;
  private navigation: BrowserSessionState["navigation"] = { entries: [], cursor: -1 };
  private origins = new Map<string, BrowserOriginState>();
  private cookies: Record<string, unknown>[] = [];
  private clients = new Map<any, any>();
  private methods = new Map<any, string>();
  private homeHtml = "";
  private restoreNotice = "";
  private restoringStorage = false;
  private currentPageUnrestored = false;
  private screenshotRevision = 0;
  private screenshotAt = 0;
  constructor(private service: () => BrowserServiceLike | null, private viewport: () => Promise<PhoneResolution>, private proxy = "", private persistence?: BrowserSessionPersistence) {}

  get available(): boolean {
    const browser = this.service()?.browser;
    return !!(browser?.createBrowserContext || (!this.proxy && browser?.createIncognitoBrowserContext));
  }
  get hasPage(): boolean { return !!this.page && !this.page.isClosed(); }
  view(): BrowserSnapshot | undefined { return this.snapshot ? structuredClone(this.snapshot) : undefined; }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(async () => { if (this.disposed) throw new Error("浏览器会话已结束。"); return fn(); });
    this.tail = result; return result;
  }
  private async ensure(restoreCurrent = true): Promise<any> {
    if (this.hasPage) return this.page;
    await this.load();
    const browser = this.service()?.browser;
    if (!this.available || !browser) throw new Error("当前没有可隔离会话的浏览器服务，只支持文字浏览。");
    this.context ??= browser.createBrowserContext
      ? await browser.createBrowserContext(this.proxy ? { proxyServer: this.proxy } : {})
      : await browser.createIncognitoBrowserContext!();
    if (this.disposed) { await this.context.close(); throw new Error("浏览器会话已结束。"); }
    const page = await this.context.newPage();
    await this.configure(page);
    if (this.disposed) { await page.close(); throw new Error("浏览器会话已结束。"); }
    this.page = page;
    try {
      await this.restoreStorage(page);
      const entry = this.navigation.entries[this.navigation.cursor];
      if (restoreCurrent && !this.restored && entry && entry.url !== "about:blank") {
        this.restored = true;
        if (entry.restorable) {
          try {
            const response = await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
            if (response && response.status() >= 400) this.restoreNotice = `恢复的页面返回 HTTP ${response.status()}；保存的登录状态可能已失效，请以当前网页为准。`;
            await this.settle(); await this.restoreScroll(entry);
          } catch (error) { this.restoreNotice = `此前页面未能恢复：${(error as Error).message}；没有重复提交表单或点击。`; }
        } else {
          this.currentPageUnrestored = true;
          this.restoreNotice = "此前页面由表单提交等操作产生，不能安全自动恢复；没有重新提交，请打开网页后确认真实状态。";
        }
      }
      this.restored = true;
      return page;
    } catch (error) {
      // Failed storage bootstrap is not a new blank authenticated session. Preserve the
      // loaded archive and release the partial context before permitting another attempt.
      await this.context?.close().catch(() => {}); this.context = undefined; this.page = undefined;
      this.clients.clear(); this.methods.clear(); this.restored = false;
      throw error;
    }
  }
  private async configure(page: any): Promise<void> {
    await page.setViewport({ ...await this.viewport(), deviceScaleFactor: 1 });
    page.setDefaultTimeout?.(12_000); page.setDefaultNavigationTimeout?.(20_000);
    // Keep the browser's real user agent. No spoofed mobile Chrome or anti-detection patches.
    page.on?.("dialog", (dialog: any) => { void dialog.dismiss().catch(() => {}); });
    page.on?.("request", (request: any) => {
      if (request.isNavigationRequest?.() && request.frame?.() === page.mainFrame?.()) this.methods.set(page, request.method?.() ?? "GET");
    });
    if (this.persistence) {
      const client = await (page.createCDPSession?.() ?? page.target?.().createCDPSession?.());
      if (client) {
        this.clients.set(page, client);
        await client.send("DOMStorage.enable");
        for (const event of ["domStorageItemAdded", "domStorageItemUpdated", "domStorageItemRemoved", "domStorageItemsCleared"]) client.on("DOMStorage." + event, (value: any) => {
          if (this.disposed || this.restoringStorage) return;
          const origin = originOf(value.storageId?.securityOrigin); if (!origin) return;
          const state = this.origins.get(origin) ?? { origin, localStorage: {}, sessionStorage: {} };
          const field = value.storageId.isLocalStorage ? "localStorage" : "sessionStorage";
          if (event === "domStorageItemsCleared") state[field] = {};
          else if (event === "domStorageItemRemoved") { state[field] = { ...state[field] }; delete state[field]![value.key]; }
          else if (typeof value.key === "string" && typeof value.newValue === "string") state[field] = { ...state[field], [value.key]: value.newValue };
          this.origins.set(origin, state);
        });
      }
    }
    page.on?.("popup", (popup: any) => {
      this.popup = (async () => {
        if (this.disposed) { await popup.close(); return; }
        await this.configure(popup);
        if (!this.disposed) this.page = popup; else await popup.close();
      })();
      void this.popup.catch(() => {});
    });
  }
  private async settle(): Promise<void> {
    await this.popup; this.popup = undefined;
    if (this.page?.waitForNetworkIdle) await this.page.waitForNetworkIdle({ idleTime: 200, timeout: 1500 }).catch(() => {});
    if (this.disposed) throw new Error("浏览器会话已结束。");
  }
  private digest(raw: ReturnType<typeof inspectBrowserDocument>): string { return createHash("sha256").update(JSON.stringify(raw)).digest("hex"); }
  private async load(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.persistence?.load();
    if (saved !== undefined) {
      const state = parseBrowserSessionState(saved);
      if (!state) throw new Error("保存的浏览器会话格式无效，未覆盖原数据。");
      this.navigation = state.navigation; this.cookies = state.cookies;
      this.origins = new Map(state.origins.map(origin => [origin.origin, origin]));
    }
    this.loaded = true;
  }
  /** Seed origin storage without requesting any old webpage or executing its scripts. */
  private async restoreStorage(page: any): Promise<void> {
    if (this.cookies.length) {
      const cookies = this.cookies.filter(cookie => typeof cookie.expires !== "number" || cookie.expires < 0 || cookie.expires > Date.now() / 1000);
      if (cookies.length) {
        const client = this.clients.get(page);
        if (client) await client.send("Network.setCookies", { cookies });
        else if (this.context.setCookie) await this.context.setCookie(...cookies);
        else throw new Error("浏览器服务不支持恢复隔离会话的Cookies。");
      }
    }
    if (!this.origins.size) return;
    const seed = (request: any) => { void request.respond({ status: 200, contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>恢复浏览器会话</title>" }).catch(() => {}); };
    this.restoringStorage = true;
    await page.setJavaScriptEnabled(false); await page.setRequestInterception(true); page.on("request", seed);
    try {
      for (const state of this.origins.values()) {
        if (this.disposed) throw new Error("浏览器会话已结束。");
        await page.goto(state.origin + "/", { waitUntil: "domcontentloaded", timeout: 12_000 });
        await page.evaluate((saved: BrowserOriginState) => {
          localStorage.clear(); sessionStorage.clear();
          for (const [key, value] of Object.entries(saved.localStorage)) localStorage.setItem(key, value);
          for (const [key, value] of Object.entries(saved.sessionStorage ?? {})) sessionStorage.setItem(key, value);
        }, state);
      }
      await page.goto("about:blank", { waitUntil: "domcontentloaded" });
      await this.clients.get(page)?.send("Page.resetNavigationHistory").catch(() => {});
    } finally { page.off?.("request", seed); await page.setRequestInterception(false); await page.setJavaScriptEnabled(true); this.restoringStorage = false; }
  }
  private rememberNavigation(raw: ReturnType<typeof inspectBrowserDocument>, mode: "auto" | "replace" = "auto"): void {
    if (!navigationUrl(raw.url)) return;
    if (this.currentPageUnrestored && raw.url === "about:blank") return;
    const prior = this.navigation.entries[this.navigation.cursor];
    if (mode === "replace" && raw.url === "about:blank" && prior?.url !== "about:blank") return;
    const changedDocument = !!this.documentId && raw.document !== this.documentId;
    const entry: BrowserNavigationEntry = { url: raw.url, title: raw.title, scrollX: raw.scrollX, scrollY: raw.scrollY,
      restorable: raw.url === "about:blank" || (this.methods.get(this.page) ?? "GET") === "GET" || this.methods.get(this.page) === "HEAD" };
    if (prior && (mode === "replace" || !changedDocument && prior.url === raw.url)) this.navigation.entries[this.navigation.cursor] = { ...entry, restorable: changedDocument ? entry.restorable : prior.restorable };
    else {
      this.navigation.entries.splice(this.navigation.cursor + 1);
      this.navigation.entries.push(entry); this.navigation.cursor = this.navigation.entries.length - 1;
    }
  }
  private async rememberStorage(): Promise<void> {
    if (!this.persistence || !this.page || this.page.isClosed()) return;
    const pages = this.context.pages ? await this.context.pages() : [this.page];
    for (const page of pages) for (const frame of page.frames ? page.frames() : [page]) {
      const state = await frame.evaluate(() => {
        if (!["http:", "https:"].includes(location.protocol)) return null;
        const read = (storage: Storage) => Object.fromEntries(Array.from({ length: storage.length }, (_, index) => storage.key(index)!).map(key => [key, storage.getItem(key)!]));
        try { return { origin: location.origin, localStorage: read(localStorage), sessionStorage: read(sessionStorage) }; } catch { return null; }
      }).catch(() => null) as BrowserOriginState | null;
      if (state && originOf(state.origin)) this.origins.set(state.origin, state);
    }
    const client = this.clients.get(this.page);
    const cookies = this.context.cookies ? await this.context.cookies() : client ? (await client.send("Network.getAllCookies")).cookies : this.cookies;
    this.cookies = cookies.map(cookieForStorage).filter((cookie: Record<string, unknown> | undefined) => cookie !== undefined);
  }
  private state(): BrowserSessionState {
    return structuredClone({ schemaVersion: 1, navigation: this.navigation, cookies: this.cookies, origins: [...this.origins.values()] });
  }
  private async save(): Promise<BrowserSessionState | undefined> {
    if (!this.loaded || !this.navigation.entries.length) return undefined;
    await this.rememberStorage();
    const state = this.state(); await this.persistence?.save(state); return state;
  }
  /** Restore only the current GET page. The caller supplies its own portal for about:blank. */
  async restore(): Promise<BrowserSnapshot | undefined> {
    return this.run(async () => {
      await this.load();
      if (!this.hasPage && (!this.navigation.entries.length || this.navigation.entries[this.navigation.cursor]?.url === "about:blank")) return undefined;
      await this.ensure(); await this.settle();
      return this.read(this.restoreNotice || "已恢复此前网页；登录是否仍有效以网站当前显示为准。", "replace");
    });
  }
  /** Includes page storage/cookies changed after the last explicit browser action. */
  async checkpoint(): Promise<BrowserSessionState | undefined> {
    return this.run(async () => {
      if (this.hasPage) {
        const raw = await this.page.evaluate(inspectBrowserDocument, this.registry); this.rememberNavigation(raw);
        this.documentId = raw.document;
      }
      return this.save();
    });
  }
  private async restoreScroll(entry: BrowserNavigationEntry): Promise<void> {
    await this.page.evaluate((x: number, y: number) => window.scrollTo(x, y), entry.scrollX, entry.scrollY);
  }
  private async beforeNavigation(): Promise<void> {
    if (!this.hasPage) return;
    const raw = await this.page.evaluate(inspectBrowserDocument, this.registry);
    this.rememberNavigation(raw); this.documentId = raw.document;
    await this.rememberStorage();
  }
  private async read(notice?: string, mode: "auto" | "replace" = "auto"): Promise<BrowserSnapshot> {
    const raw = await this.page.evaluate(inspectBrowserDocument, this.registry);
    if (this.disposed) throw new Error("浏览器会话已结束。");
    this.rememberNavigation(raw, mode);
    this.stamp = this.digest(raw);
    this.documentId = raw.document;
    const { document: _document, ...content } = raw;
    this.snapshot = { ...content, revision: ++this.revision, canGoBack: this.navigation.cursor > 0,
      canGoForward: this.navigation.cursor < this.navigation.entries.length - 1, ...(notice ? { notice } : {}) };
    try { await this.save(); }
    catch (error) { if (this.snapshot) this.snapshot.notice = [notice, `网页操作已发生，但会话保存失败：${(error as Error).message}`].filter(Boolean).join("\n"); }
    if (this.disposed) throw new Error("浏览器会话已结束。");
    return structuredClone(this.snapshot!);
  }
  async navigate(url: string): Promise<BrowserSnapshot> {
    return this.run(async () => {
      await this.beforeNavigation();
      const page = await this.ensure(false); this.currentPageUnrestored = false; let notice = "";
      try { const response = await page.goto(safeBrowserUrl(url), { waitUntil: "domcontentloaded", timeout: 20_000 });
        if (response && response.status() >= 400) notice = `页面返回 HTTP ${response.status()}；可检查当前页面、换入口或手动处理，未自动重试。`;
      } catch (error) { notice = `页面加载未完成：${(error as Error).message}；以下是当前实际页面，不代表成功打开目标。`; }
      await this.settle(); return this.read(notice);
    });
  }
  async home(html: string): Promise<BrowserSnapshot> {
    return this.run(async () => {
      await this.beforeNavigation(); this.homeHtml = html;
      const wasHome = this.navigation.entries[this.navigation.cursor]?.url === "about:blank";
      const page = await this.ensure(false); this.currentPageUnrestored = false; await page.goto("about:blank"); await page.setContent(html, { waitUntil: "domcontentloaded" });
      return this.read(undefined, wasHome ? "replace" : "auto");
    });
  }
  async observe(): Promise<BrowserSnapshot> {
    return this.run(async () => { await this.ensure(); await this.settle(); return this.read(); });
  }
  private async validate(revision: number, target?: { ref?: string; focus?: boolean }): Promise<void> {
    if (!this.snapshot || revision !== this.snapshot.revision) throw new Error("页面版本已变化，请先 read_page 获取最新版本和元素引用。");
    const raw = await this.page.evaluate(inspectBrowserDocument, this.registry);
    if (raw.document !== this.documentId || raw.url !== this.snapshot.url) throw new Error("页面已经导航或重载，本次没有操作；请先 read_page 获取最新页面。");
    if (!target) {
      if (this.digest(raw) !== this.stamp) throw new Error("页面内容或位置已变化，本次没有操作；请先 read_page 获取最新页面。");
      return;
    }
    if (target.focus && raw.focusedRef !== this.snapshot.focusedRef) throw new Error("键盘焦点已变化，本次没有按键；请先 read_page 确认当前焦点。");
    const ref = target.ref || (target.focus ? this.snapshot.focusedRef : null);
    if (ref) {
      const before = this.snapshot.elements.find(element => element.ref === ref), after = raw.elements.find((element: BrowserControl) => element.ref === ref);
      const semantic = (element: BrowserControl) => [element.role, element.type, element.label, element.href, element.disabled, element.readonly, element.value, element.checked, element.options];
      if (!before || !after || JSON.stringify(semantic(before)) !== JSON.stringify(semantic(after))) throw new Error("目标元素已消失或语义/内容发生变化，本次没有操作；请先 read_page 确认。");
    }
  }
  async act(action: BrowserAction): Promise<BrowserSnapshot> {
    return this.run(async () => {
      await this.ensure();
      // Stable DOM targets tolerate unrelated live counters/ads. Coordinates must match the whole frame.
      await this.validate(action.revision, action.kind === "point" ? undefined : action.kind === "click" || action.kind === "fill" ? { ref: action.ref } : action.kind === "key" ? { focus: true } : {});
      await this.beforeNavigation();
      let notice = "", mode: "auto" | "replace" = "auto";
      if (action.kind === "click" || action.kind === "fill") {
        const item = this.snapshot!.elements.find(element => element.ref === action.ref);
        if (!item || item.disabled) throw new Error("当前版本没有这个可用元素，请 read_page 后重新选择。");
        if (action.kind === "click") {
          const point = await this.page.evaluate(browserClickPoint, this.registry, action.ref);
          if (!point) throw new Error("元素被遮挡或不可点击；请查看页面，处理弹窗或滚动后重试。");
          await this.page.mouse.click(point.x, point.y);
        } else {
          if (item.readonly || ["file", "checkbox", "radio", "button", "submit", "reset", "image", "range", "color"].includes(item.type ?? "") || !["input", "textarea", "textbox", "select", "combobox", "searchbox"].includes(item.role)) throw new Error("这个元素不是可填写的文本框或下拉框；不支持网页文件上传。");
          const value = String(action.value ?? ""); if (value.length > 8000) throw new Error("输入文字过长，请缩短到 8000 字符以内。");
          if (!await this.page.evaluate(browserClickPoint, this.registry, action.ref)) throw new Error("输入框被遮挡或不可见，请先处理页面弹窗或滚动。");
          const handle = await this.page.evaluateHandle(browserElement, this.registry, action.ref);
          try { const element = handle.asElement(); if (!element) throw new Error("元素已消失，请重新读取页面。");
            if (item.options) await element.select(value);
            else {
              await element.click(); const modifier = process.platform === "darwin" ? "Meta" : "Control";
              try { await this.page.keyboard.down(modifier); await this.page.keyboard.press("A"); }
              finally { await this.page.keyboard.up(modifier); }
              await this.page.keyboard.press("Backspace"); await element.type(value);
            }
          } finally { await handle.dispose(); }
        }
      } else if (action.kind === "key") {
        const keys = action.key.split("+");
        if (keys.length > 4 || keys.some(key => !/^(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|Space|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Control|Shift|Alt|Meta)$/.test(key))) throw new Error("不支持这个按键组合。");
        const modifiers = keys.slice(0, -1);
        try { for (const key of modifiers) await this.page.keyboard.down(key); await this.page.keyboard.press(keys.at(-1)!); }
        finally { for (const key of modifiers.reverse()) await this.page.keyboard.up(key); }
      } else if (action.kind === "scroll") {
        if (!Number.isFinite(action.pixels) || Math.abs(action.pixels) > 4000) throw new Error("滚动距离须为 -4000 到 4000 像素。");
        await this.page.mouse.wheel({ deltaY: action.pixels });
      } else if (action.kind === "point") {
        const viewport = this.snapshot!.viewport;
        if (this.screenshotRevision !== action.revision || Date.now() - this.screenshotAt > 30_000 || action.width !== viewport.width || action.height !== viewport.height) throw new Error("截图已过期或尺寸不符，请重新 read_page 或 screenshot 后再点击。");
        if (![action.x, action.y].every(Number.isFinite) || action.x < 0 || action.y < 0 || action.x >= viewport.width || action.y >= viewport.height) throw new Error("点击坐标不在当前截图范围内。");
        await this.page.mouse.click(action.x, action.y);
      } else {
        const cursor = this.navigation.cursor + (action.kind === "back" ? -1 : action.kind === "forward" ? 1 : 0);
        const entry = this.navigation.entries[cursor];
        if (!entry) throw new Error(action.kind === "back" ? "没有可后退的页面。" : "没有可前进的页面。");
        if (!entry.restorable) throw new Error("该历史页面来自提交操作，不能自动重放表单；请直接打开网址确认当前状态。");
        try {
          await this.page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
          if (entry.url === "about:blank" && this.homeHtml) await this.page.setContent(this.homeHtml, { waitUntil: "domcontentloaded" });
          this.navigation.cursor = cursor; this.currentPageUnrestored = false;
          await this.settle(); await this.restoreScroll(entry); mode = "replace";
        } catch (error) { notice = `页面加载未完成：${(error as Error).message}；没有重放表单提交。`; }
      }
      await this.settle(); return this.read(notice, mode);
    });
  }
  async capture(revision: number): Promise<Buffer> {
    return this.run(async () => {
      await this.validate(revision);
      const result = Buffer.from(await this.page.screenshot({ type: "png", fullPage: false }));
      if (this.disposed) throw new Error("浏览器会话已结束。");
      // A screenshot taken while a page navigates/layout shifts must not become a clickable frame.
      await this.validate(revision);
      this.screenshotRevision = revision; this.screenshotAt = Date.now(); return result;
    });
  }
  /** Compose an already captured page; never reload its URL or share the host default context. */
  async compose(html: string, viewport: PhoneResolution): Promise<Buffer> {
    return this.run(async () => {
      await this.ensure(); const page = await this.context.newPage();
      try {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", (request: any) => { void (/^(?:data:|about:)/.test(request.url()) ? request.continue() : request.abort()).catch(() => {}); });
        await page.setContent(html, { waitUntil: "load", timeout: 12_000 });
        const png = Buffer.from(await page.screenshot({ type: "png", fullPage: false }));
        if (this.disposed) throw new Error("浏览器会话已结束。");
        return png;
      } finally { await page.close().catch(() => {}); }
    });
  }
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      try {
        await this.clients.get(this.page)?.send("Page.stopLoading").catch(() => {});
        await this.tail.catch(() => {});
        await this.popup?.catch(() => {});
        if (this.hasPage) {
          const raw = await this.page.evaluate(inspectBrowserDocument, this.registry).catch(() => undefined);
          if (raw) { this.rememberNavigation(raw); this.documentId = raw.document; }
        }
        await this.save();
      } finally {
        await this.context?.close().catch(() => {});
        this.page = undefined; this.context = undefined; this.snapshot = undefined;
        this.clients.clear(); this.methods.clear();
      }
    })();
    return this.disposing;
  }
}

function originOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : undefined; } catch { return undefined; }
}
function navigationUrl(value: unknown): value is string {
  if (value === "about:blank") return true;
  if (typeof value !== "string") return false;
  try { return safeBrowserUrl(value) === value; } catch { return false; }
}
function cookieForStorage(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.name !== "string" || typeof value.value !== "string" || typeof value.domain !== "string" || typeof value.path !== "string") return undefined;
  const keys = ["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite", "priority", "sameParty", "sourceScheme", "sourcePort", "partitionKey"];
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));
}
/** Invalid state is rejected, never silently replaced with an empty authenticated session. */
export function parseBrowserSessionState(input: unknown): BrowserSessionState | undefined {
  if (!input || typeof input !== "object") return undefined;
  const state = input as BrowserSessionState, nav = state.navigation;
  if (state.schemaVersion !== 1 || !nav || !Array.isArray(nav.entries) || !Number.isSafeInteger(nav.cursor) || nav.cursor < -1 || nav.cursor >= nav.entries.length || (nav.entries.length > 0 && nav.cursor < 0) || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) return undefined;
  if (nav.entries.some(entry => !entry || !navigationUrl(entry.url) || typeof entry.title !== "string" || !Number.isFinite(entry.scrollX) || !Number.isFinite(entry.scrollY) || typeof entry.restorable !== "boolean")) return undefined;
  const records = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");
  if (state.origins.some(origin => !origin || originOf(origin.origin) !== origin.origin || !records(origin.localStorage) || origin.sessionStorage !== undefined && !records(origin.sessionStorage)) || new Set(state.origins.map(origin => origin.origin)).size !== state.origins.length) return undefined;
  const cookies = state.cookies.map(cookieForStorage); if (cookies.some(cookie => cookie === undefined)) return undefined;
  return structuredClone({ schemaVersion: 1, navigation: { entries: nav.entries.map(({ url, title, scrollX, scrollY, restorable }) => ({ url, title, scrollX, scrollY, restorable })), cursor: nav.cursor },
    cookies: cookies as Record<string, unknown>[], origins: state.origins.map(({ origin, localStorage, sessionStorage }) => ({ origin, localStorage, ...(sessionStorage ? { sessionStorage } : {}) })) });
}
