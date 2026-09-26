/** Offline browser integration: execute the real DOM projection in an isolated JS page realm. */
import assert from "node:assert/strict";
import vm from "node:vm";
import { BrowserSession, safeBrowserUrl } from "../src/apps/browser-session.js";
import { BrowserApp } from "../src/apps/browser.js";
import { Config } from "../src/config.js";
import { browserPortalHtml } from "../src/apps/browser-home.js";

class Element {
  isConnected = true; disabled = false; readOnly = false; checked = false;
  value = ""; name = ""; options: any[] = []; labels: any[] = [];
  constructor(public tagName: string, public innerText: string, public type = "", public href = "", public y = 30) {}
  getAttribute(name: string) { return name === "aria-label" ? this.innerText : null; }
  getBoundingClientRect() { return { x: 20, y: this.y, left: 20, top: this.y, right: 250, bottom: this.y + 30, width: 230, height: 30 }; }
  contains(value: unknown) { return this === value; }
}
class Page {
  realm: any; listeners = new Map<string, Function>(); closed = false; focused?: Element;
  nodes = [new Element("INPUT", "搜索内容", "text"), new Element("BUTTON", "搜索", "submit", "", 80), new Element("A", "视频", "", "https://video.example/1", 140)];
  clicks: number[][] = []; keys: string[] = []; visits: string[] = []; history: string[] = [];
  failNavigation = false; duringScreenshot?: () => void; beforeGoto?: () => Promise<void>;
  constructor() {
    this.realm = vm.createContext({ URL, Math, WeakMap, Map });
    this.realm.innerWidth = 600; this.realm.innerHeight = 800; this.realm.scrollX = this.realm.scrollY = 0;
    this.realm.location = { href: "about:blank" }; this.realm.getComputedStyle = () => ({ visibility: "visible", display: "block" });
    this.document("初始页面");
  }
  document(title: string) {
    this.realm.document = {
      title, baseURI: "https://video.example/", body: { innerText: "由网页 JavaScript 渲染的视频标题与简介" }, images: [],
      querySelectorAll: (selector: string) => selector === "video" ? [{ currentSrc: "blob:https://video.example/video", poster: "", paused: true, duration: NaN }] : this.nodes,
      querySelector: (selector: string) => selector.includes("og:image") ? { content: "/cover.jpg" } : { content: "真实页面摘要" },
      elementFromPoint: (_x: number, y: number) => this.nodes.find(node => y >= node.y && y <= node.y + 30),
    };
  }
  async setViewport(viewport: any) { this.realm.innerWidth = viewport.width; this.realm.innerHeight = viewport.height; }
  async setJavaScriptEnabled(enabled: boolean) { assert.equal(enabled, false, "shell rendering cannot execute scripts"); }
  async setRequestInterception(enabled: boolean) { assert.equal(enabled, true, "shell rendering blocks external network"); }
  on(name: string, fn: Function) { this.listeners.set(name, fn); }
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
  async goto(url: string) {
    await this.beforeGoto?.(); if (this.closed) throw new Error("Target closed");
    this.visits.push(url); if (this.failNavigation) throw new Error("fixture timeout");
    this.history.push(this.realm.location.href); this.realm.location.href = url; this.document(url); return { status: () => 200 };
  }
  async setContent(html: string) { this.document(html.match(/<title>(.*?)<\/title>/i)?.[1] || "本地主页"); }
  async evaluate(fn: Function, ...args: any[]) { this.realm.args = args; return vm.runInContext(`(${fn.toString()})(...args)`, this.realm); }
  async evaluateHandle(fn: Function, ...args: any[]) {
    const node = await this.evaluate(fn, ...args);
    return { asElement: () => node ? {
      click: async () => { this.focused = node; this.realm.document.activeElement = node; }, type: async (value: string) => { node.value += value; },
      select: async (value: string) => { node.value = value; },
    } : null, dispose: async () => {} };
  }
  mouse = { click: async (x: number, y: number) => { this.clicks.push([x, y]); }, wheel: async ({ deltaY }: any) => { this.realm.scrollY += deltaY; } };
  keyboard = {
    press: async (key: string) => { this.keys.push(key); if (key === "Backspace" && this.focused) this.focused.value = ""; },
    down: async (key: string) => { this.keys.push("down:" + key); }, up: async (key: string) => { this.keys.push("up:" + key); },
  };
  async screenshot() { this.duringScreenshot?.(); return Buffer.from("fixture PNG"); }
  async goBack() { this.realm.location.href = this.history.pop() || "about:blank"; this.document("后退页面"); }
  async reload() { this.document("重新加载页面"); }
}
function service() {
  const pages: Page[] = []; let contexts = 0, closed = 0;
  return {
    pages, get contexts() { return contexts; }, get closed() { return closed; },
    page: () => { throw new Error("must never use the shared default page"); },
    browser: { createBrowserContext: async () => { contexts++; return {
      newPage: async () => { const page = new Page(); pages.push(page); return page; },
      close: async () => { closed++; await Promise.all(pages.map(page => page.close())); },
    }; } },
  };
}
async function sessionTests() {
  const host = service(), session = new BrowserSession(() => host, async () => ({ width: 600, height: 800 }));
  const first = await session.navigate("https://video.example/1"), page = host.pages[0]!;
  assert.equal(host.contexts, 1); assert.equal(first.title, "https://video.example/1");
  assert.equal(first.images[0]!.url, "https://video.example/cover.jpg"); assert.ok(first.text.includes("JavaScript"));
  assert.equal(first.videos[0]!.url, "blob:https://video.example/video");
  const second = await session.observe(); assert.equal(first.elements[0]!.ref, second.elements[0]!.ref, "same DOM node has a stable ref");
  await assert.rejects(session.act({ kind: "click", revision: first.revision, ref: first.elements[1]!.ref }), /版本/);
  page.realm.document.body.innerText = "异步网站变化";
  await session.act({ kind: "click", revision: second.revision, ref: second.elements[1]!.ref });
  assert.equal(page.clicks.length, 1, "unrelated live counters do not block a stable DOM target");
  let changed = await session.observe(); page.nodes[1]!.innerText = "购买并付款";
  await assert.rejects(session.act({ kind: "click", revision: changed.revision, ref: changed.elements[1]!.ref }), /语义/);
  assert.equal(page.clicks.length, 1, "a changed target cannot borrow an earlier reference's meaning");
  page.clicks.length = 0;
  let state = await session.observe();
  state = await session.act({ kind: "fill", revision: state.revision, ref: state.elements[0]!.ref, value: "猫的视频" });
  assert.equal(page.nodes[0]!.value, "猫的视频"); assert.equal(page.clicks.length, 0, "fill does not submit");
  state = await session.act({ kind: "key", revision: state.revision, key: "Control+A" });
  assert.deepEqual(page.keys.slice(-3), ["down:Control", "A", "up:Control"]);
  state = await session.act({ kind: "scroll", revision: state.revision, pixels: 200 }); assert.equal(state.scrollY, 200);
  await session.capture(state.revision);
  await assert.rejects(session.act({ kind: "point", revision: state.revision, x: 30, y: 40, width: 601, height: 800 }), /尺寸/);
  await assert.rejects(session.act({ kind: "point", revision: state.revision, x: 600, y: 40, width: 600, height: 800 }), /范围/);
  state = await session.act({ kind: "point", revision: state.revision, x: 30, y: 40, width: 600, height: 800 });
  assert.deepEqual(page.clicks, [[30, 40]]);
  await assert.rejects(session.act({ kind: "point", revision: state.revision, x: 30, y: 40, width: 600, height: 800 }), /截图/);
  page.duringScreenshot = () => { page.realm.document.body.innerText = "capture race"; };
  await assert.rejects(session.capture(state.revision), /内容或位置/); page.duringScreenshot = undefined;
  state = await session.observe(); page.realm.document.elementFromPoint = () => ({});
  await assert.rejects(session.act({ kind: "click", revision: state.revision, ref: state.elements[1]!.ref }), /遮挡/);
  page.failNavigation = true;
  state = await session.navigate("https://other.example/"); assert.equal(page.visits.length, 2, "failed navigation is not retried");
  assert.equal(state.url, "https://video.example/1"); assert.match(state.notice!, /不代表成功/);
  assert.equal(host.contexts, 1, "all navigation retains the same isolated cookie context");
  await session.dispose(); assert.ok(page.closed); await assert.rejects(session.observe(), /结束/);
  for (const url of ["file:///tmp/a", "javascript:alert(1)", "https://user:password@example.com"]) assert.throws(() => safeBrowserUrl(url));
  assert.equal(safeBrowserUrl("example.com"), "https://example.com/");
}
async function appTests() {
  const cfg = Config({ autoStart: false }).apps, host = service();
  const rows: any[] = []; let saved = 0;
  const media = { ingest: async (url: string) => {
    assert.ok(url.startsWith("data:image/png;base64,"), "screenshots come from the actual page, never another network fetch");
    const id = rows.length + 1; rows.push({ id, ref: { id, type: "image", mime: "image/png", path: "fixture.png", sha256: "fixture" + id } }); return id;
  }, get: async (id: number) => rows[id - 1], setSummary: async () => {} };
  const app = new BrowserApp({ puppeteer: host } as any, { query() { throw new Error("real browsing has no additional World-LLM request"); } } as any,
    { readMeta: async () => ({ realWorld: true, phone: { width: 600, height: 800 } }), readPhoneShell: async () => "" } as any, { syncRealTime: true, timeLine: () => "12:00" } as any,
    media as any, { importFile: async () => { saved++; return 'web.png'; } } as any,
    { describe() { throw new Error("native screenshots need no extra caption request"); } } as any, () => true, cfg, { warn() {} } as any);
  const opened = await app.open(); assert.equal(typeof opened.opening, "object");
  assert.ok((opened.opening as any).attachments?.length); assert.ok(opened.tools.some(tool => tool.name === "click_point"));
  let state: any = app.viewState(); assert.equal(state.mode, "real"); assert.ok(state.title.includes("探索"));
  assert.equal(state.screenshot.mediaId, (opened.opening as any).attachments[0].id);
  assert.match(String(await app.call("click_point", { ...state.screenshot, screenshot_id: 999, x: 5, y: 5 })), /媒体ID/);
  const noVideo = await app.call("view_video", { revision: state.revision, n: 1 }); assert.match(String(noVideo), /blob/);
  assert.equal(saved, 0, "automatic GUI frames do not fill the gallery");
  const visits = host.pages[0]!.visits.slice();
  const actualScreen = app.peekScreen();
  assert.match(String(await app.call("save_screenshot", { revision: state.revision })), /截图已存进收藏夹/);
  assert.deepEqual(app.peekScreen(), actualScreen, "a save confirmation never replaces the observed browser page");
  assert.equal(saved, 1); assert.deepEqual(host.pages[0]!.visits, visits, "saved screenshots preserve the current real page instead of reloading URL");
  assert.deepEqual(host.pages[1]!.visits, [], "the compositor never navigates the target URL"); assert.ok(host.pages[1]!.closed);
  host.pages[0]!.nodes[0]!.value = "session cookie surrogate";
  await app.close(); await app.open(); assert.equal(host.contexts, 1); assert.equal(host.pages[0]!.nodes[0]!.value, "session cookie surrogate");
  await app.dispose(); assert.ok(host.pages[0]!.closed);
  const fallback = new BrowserApp({ puppeteer: { page() { throw new Error("text fallback cannot borrow a shared browser page"); } } } as any,
    {} as any, { readMeta: async () => ({ realWorld: true }) } as any, {} as any, {} as any, {} as any, {} as any, () => false, cfg, {} as any);
  const plain = await fallback.open(); assert.equal(typeof plain.opening, "string"); assert.match(plain.opening as string, /文字浏览/);
  assert.ok(!plain.tools.some(tool => ["click", "screenshot", "click_point", "fill"].includes(tool.name)));
  assert.match(String(await fallback.call("screenshot", {})), /文字浏览模式不能截图/);
  assert.equal((fallback.viewState() as any).mode, "text"); await fallback.dispose();
}
async function shutdownRace() {
  const host = service(), session = new BrowserSession(() => host, async () => ({ width: 600, height: 800 }));
  await session.observe(); let release!: () => void;
  host.pages[0]!.beforeGoto = () => new Promise<void>(resolve => { release = resolve; });
  const navigate = session.navigate("https://late.example/");
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const stopped = session.dispose(); release();
  await assert.rejects(navigate, /结束/); await stopped;
  assert.equal(session.view(), undefined, "late navigation does not republish disposed state");
}
async function virtualMode() {
  let realWorld = false, queries = 0;
  const cfg = { ...Config({ autoStart: false }).apps, browserHomeURL: 'https://real-home.invalid/', browserSearchURL: 'https://real-search.invalid/?q=%s' };
  const world = { observeVirtualApp: async (task: string) => {
    queries++; assert.match(task, /主页|本地新闻|bilibili/);
    assert.doesNotMatch(task, /real-home\.invalid|real-search\.invalid/);
    return { text: '<html><head><title>临海导航</title></head><body><a href="https://linhai.invalid/news">临海公告</a></body></html>', originEventIds: ['world-page'] };
  } };
  const app = new BrowserApp({ puppeteer: { page() { throw new Error('virtual browsing must not load real pages'); } } } as any,
    world as any, { readMeta: async () => ({ realWorld }) } as any, { syncRealTime: true, timeLine: () => 'T10' } as any,
    {} as any, {} as any, {} as any, () => false, cfg, { warn() {} } as any);
  assert.equal(app.viewState().mode, 'unknown'); assert.deepEqual(app.viewState().searchProviders, []);
  const opened = await app.open();
  assert.equal(queries, 0, 'opening a virtual browser is immediate, not an unsolicited World-LLM read');
  assert.equal(app.viewState().mode, 'virtual', 'no current page does not make a virtual world look like real text fallback');
  assert.deepEqual(app.viewState().searchProviders, []); assert.ok(opened.tools.some(tool => tool.name === 'home'));
  assert.match(String(opened.opening), /尚未查看网页/);
  assert.doesNotMatch(String(opened.opening), /可用 home|search 搜索/, 'opening reports actual state; the tool catalog provides usage');
  await app.call('home', {}); assert.equal(queries, 1); assert.equal(app.viewState().mode, 'virtual');
  assert.equal(app.viewState().links[0]!.url, 'https://linhai.invalid/news');
  await app.call('search', { query: '本地新闻', provider: 99 }); assert.equal(queries, 2, 'virtual search ignores real provider parameters');
  await app.call('open_url', { url: 'https://www.bilibili.com/' }); assert.equal(queries, 3, 'a real-looking URL remains inside the World read boundary');
  (app as any).realOpen = async () => '真实网络失败'; realWorld = true;
  assert.equal(await app.call('open_url', { url: 'https://real-home.invalid/' }), '真实网络失败');
  assert.equal(queries, 3, 'a real network failure never falls back to generated fictional content');
  assert.equal(app.viewState().mode, 'text'); assert.deepEqual(app.viewState().links, [], 'mode transitions remove the other world page');
  realWorld = false; world.observeVirtualApp = async () => { throw new Error('World unavailable'); };
  await app.open(); await app.call('home', {});
  assert.equal(app.viewState().mode, 'virtual'); assert.deepEqual(app.viewState().searchProviders, []);
  const actions: string[] = []; let request!: (request: any) => void;
  const tab = {
    setViewport: async () => {}, setJavaScriptEnabled: async (enabled: boolean) => { assert.equal(enabled, false); actions.push('scripts-off'); },
    setRequestInterception: async (enabled: boolean) => { assert.equal(enabled, true); actions.push('network-controlled'); },
    on: (_event: string, callback: typeof request) => { request = callback; }, screenshot: async () => Buffer.from('png'), close: async () => { actions.push('closed'); },
  };
  await (app as any).capture({ page: async () => tab }, { width: 600, height: 800 }, async () => {
    assert.deepEqual(actions, ['scripts-off', 'network-controlled'], 'offline isolation is installed before generated HTML loads');
    request({ url: () => 'https://real-tracker.invalid/', abort: async () => { actions.push('blocked'); }, continue: async () => { throw new Error('fictional screenshot cannot load reality'); } });
    request({ url: () => 'data:image/png;base64,AA==', continue: async () => { actions.push('local-image'); }, abort: async () => { throw new Error('inline artwork should remain available'); } });
  });
  assert.deepEqual(actions, ['scripts-off', 'network-controlled', 'blocked', 'local-image', 'closed']);
  await app.dispose();
}
async function main() {
  const portal = browserPortalHtml('https://search.example/find?term=%s&lang=zh&extra=%22%3E%3Cscript%3E');
  assert.match(portal, /action="https:\/\/search.example\/find"/); assert.match(portal, /name="term"/);
  assert.match(portal, /value="&quot;&gt;&lt;script&gt;"/); assert.doesNotMatch(portal, /<script>/);
  assert.doesNotMatch(browserPortalHtml('https://search.example/prefix-%s'), /<form/);
  await sessionTests(); await appTests(); await shutdownRace(); await virtualMode();
  console.log("browser-session: isolated persistence, DOM/GUI revisions, media routing, fallback and shutdown passed");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
