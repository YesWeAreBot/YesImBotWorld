/** Exercises actual legacy.js with an in-memory DOM; no server, browser or credentials. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const source = readFileSync(resolve("src/webui/client/legacy.js"), "utf8");
const tick = () => new Promise<void>(done => setImmediate(done));
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("WebUI promise did not settle")), 1000);
    })]);
  } finally { clearTimeout(timer!); }
}

/** Just DOM/storage mechanics: authentication and page lifecycle logic come from the source. */
class Element {
  [key: string]: any;
  children: Element[] = [];
  parent: Element | null = null;
  root = false;
  style: Record<string, unknown> = {};
  value = "";
  private text = "";
  private classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string) => this.classes.has(name) ? this.classes.delete(name) : this.classes.add(name),
  };
  constructor(readonly tagName: string) {}
  get childNodes() { return this.children; }
  get isConnected(): boolean { return this.root || !!this.parent?.isConnected; }
  get textContent() { return this.text; }
  set textContent(value: string) {
    this.text = value;
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  appendChild(node: Element) { node.parent = this; this.children.push(node); return node; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      const matches = selector.startsWith(".") ? String(child.className ?? "").split(/\s+/).includes(selector.slice(1))
        : selector.startsWith("#") ? child.id === selector.slice(1) : child.tagName === selector;
      if (matches) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  setAttribute(key: string, value: unknown) { this[key] = value; }
  addEventListener(type: string, handler: unknown) { this["on" + type] = handler; }
  focus() {}
}

function harness() {
  const nodes = new Map<string, Element>(), storage = new Map<string, string>(), events: string[] = [];
  const details: { type: string; detail?: any }[] = [], timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, Object.assign(new Element("div"), { root: true }));
    return nodes.get(selector)!;
  };
  const context: any = vm.createContext({
    document: { querySelector: node, createElement: (name: string) => new Element(name), createDocumentFragment: () => new Element("fragment") },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    window: { dispatchEvent: (event: { type: string; detail?: unknown }) => { events.push(event.type); details.push(event); } },
    CustomEvent: class { detail?: unknown; constructor(readonly type: string, options?: { detail: unknown }) { this.detail = options?.detail; } },
    // Timers run only when explicitly selected by a test. Promise scheduling remains native.
    setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); }, setInterval() {}, clearInterval() {}, AbortController, FormData, Blob, console,
    fetch() { throw new Error("Unexpected external request"); },
  });
  vm.runInContext(source, context, { filename: "src/webui/client/legacy.js" });
  const find = (predicate: (element: Element) => boolean): Element => {
    const descendants: Element[] = [];
    function walk(element: Element) { descendants.push(element); element.children.forEach(walk); }
    walk(node("#modal-body"));
    const result = descendants.find(predicate);
    assert.ok(result, "expected real authentication form element");
    return result;
  };
  const click = (label: string) => find(element => element.tagName === "button" && element.textContent === label).onclick();
  const runTimers = (delay: number) => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
  };
  return { context, node, storage, events, details, find, click, runTimers };
}

async function authentication() {
  const h = harness(), c = h.context;
  for (const close of [
    () => h.node("#modal-x").onclick(),
    () => { const modal = h.node("#modal"); modal.onclick.call(modal, { target: modal }); },
    () => { c.authCancel(); c.hideModal(); },
  ]) {
    const pending = c.promptAuth();
    assert.equal(c.promptAuth(), pending, "concurrent callers share one login promise");
    close();
    assert.equal(await deadline(pending), null);
    assert.equal(c.authPromise, null); assert.equal(c.authCancel, null);
    assert.equal(h.node("#modal").classList.contains("show"), false);
  }
  let pending = c.promptAuth();
  h.find(element => element.placeholder === "webui.token").value = "fixture-admin";
  h.click("登录");
  assert.equal(await deadline(pending), "fixture-admin");
  assert.deepEqual(h.events, ["studio:auth"]);

  let finishLogin!: (value: unknown) => void, loginSignal!: AbortSignal, requests = 0;
  c.fetch = (_url: string, options: { signal: AbortSignal }) => {
    requests++; loginSignal = options.signal;
    return new Promise(resolve => { finishLogin = resolve; });
  };
  pending = c.promptAuth(); h.click("访客"); h.click("登录"); h.click("登录");
  assert.equal(requests, 1, "a pending login must not submit twice");
  c.hideModal(); assert.equal(await deadline(pending), null); assert.equal(loginSignal.aborted, true);
  // A transport may return a response despite abort; it must not override a newer identity/modal.
  const replacement = c.promptAuth();
  finishLogin({ ok: true, json: async () => ({ token: "late-fixture", grants: [], preset: "viewer" }) });
  await tick();
  assert.equal(c.MODE, "admin"); assert.equal(c.TOKEN, "fixture-admin"); assert.equal(c.VISITOR_TOKEN, "");
  assert.equal(h.storage.get("wui_mode"), "admin"); assert.deepEqual(h.events, ["studio:auth"]);
  assert.equal(c.authPromise, replacement, "late results cannot settle a replacement modal");
  h.click("取消"); assert.equal(await deadline(replacement), null);

  pending = c.promptAuth(); h.click("访客"); h.click("登录");
  finishLogin({ ok: true, json: async () => ({ token: "fixture-visitor", grants: ["overview"], preset: "viewer" }) });
  assert.equal(await deadline(pending), "fixture-visitor");
  assert.equal(c.MODE, "visitor"); assert.equal(h.storage.has("wui_token"), false);
  assert.deepEqual(h.events, ["studio:auth", "studio:auth"]);

  const apiHarness = harness(); let apiRequests = 0;
  apiHarness.context.fetch = async () => { apiRequests++; return { status: 401 }; };
  const apiCall = apiHarness.context.api("GET", "/api/config");
  const rejected = assert.rejects(deadline(apiCall), /未授权/);
  await tick(); apiHarness.node("#modal-x").onclick(); await rejected;
  assert.equal(apiRequests, 1, "cancelled authentication does not replay the original request");
  console.log("PASS WebUI auth: singleton, X/backdrop/cancel settle, late responses stay isolated, identity events and cancelled 401 requests");
}

async function managementLifecycle() {
  const h = harness(), c = h.context, pending: ((value: unknown) => void)[] = [], errors: unknown[] = [];
  c.api = () => new Promise(resolve => pending.push(resolve));
  c.showErr = (error: unknown) => errors.push(error);
  const routes = [["loadConfig", "config"], ["loadPrompts", "prompts"], ["loadVisitors", "visitors"], ["loadGallery", "gallery"], ["loadMedia", "media"], ["refreshData", "data"]];
  for (const [loader, route] of routes) {
    c.activeView = route; c[loader!]();
    const complete = pending.shift(); assert.ok(complete, loader);
    c.activeView = "overview";
    h.node("#main").textContent = "new page";
    // Malformed late data must never reach page renderers or mutate shared caches.
    complete(null); await tick();
    assert.equal(errors.length, 0, loader + " must discard responses after navigation");
    assert.equal(h.node("#main").textContent, "new page");
  }
  c.activeView = "config"; c.loadConfig(); const stale = pending.shift()!;
  c.loadConfig(); const current = pending.shift()!;
  stale({ schema: { children: [] }, value: { stale: true } }); await tick();
  assert.equal(c.cfgCache, null); assert.equal(c.schemaCache, null);
  assert.equal(errors.length, 0, "a detached earlier holder cannot update a remounted config page");
  // Keep the actual loader, but leave detailed config rendering to browser smoke tests.
  c.renderConfigShell = () => new Element("config"); c.renderCfgBody = () => {};
  current({ schema: { children: [] }, value: { current: true } }); await tick();
  assert.equal(c.cfgCache.current, true, "the current mounted response still takes effect");
  c.activeView = "overview";
  for (const [loader] of routes) c[loader!]();
  assert.equal(pending.length, 0, "late save callbacks cannot reopen management pages");
  assert.equal(errors.length, 0);
  console.log("PASS WebUI management: route changes and remounts reject stale responses; current responses remain functional");
}

async function configurationSave() {
  const h = harness(), c = h.context;
  const requests: { url: string; options: any; resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
  c.fetch = (url: string, options: any) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  c.activeView = 'config'; c.TOKEN = 'fixture-old'; h.storage.set('wui_token', 'fixture-old');
  c.cfgCache = { bot: { model: 'saved-model' }, webui: { token: 'fixture-new', port: 5100 } };
  c.cfgPortOriginal = 5100; c.cfgDirty = true;
  let closed = 0, reconnected = 0;
  c.evtSource = { close() { closed++; } };
  c.connectSSE = () => { reconnected++; assert.equal(c.TOKEN, 'fixture-new'); };
  c.refreshOverview = async () => ({});
  const phases = () => h.details.filter(event => event.type === 'studio:config-save').map(event => event.detail.phase);
  const saving = c.saveConfig();
  assert.equal(c.saveConfig(), saving, 'double submit reuses the pending save');
  assert.equal(h.node('#cfg-savebar').children[1]!.children.every(button => button.disabled), true);
  await tick();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.options.headers.Authorization, 'Bearer fixture-old');
  assert.equal(c.TOKEN, 'fixture-old'); assert.equal(h.storage.get('wui_token'), 'fixture-old');
  assert.deepEqual(phases(), ['saving']);
  c.cfgCache.bot.model = 'edited-while-saving';
  assert.equal(JSON.parse(requests[0]!.options.body).config.bot.model, 'saved-model', 'the outgoing snapshot is stable');
  requests.shift()!.resolve({ ok: true, json: async () => ({ message: 'accepted' }) });
  assert.equal((await deadline(saving)).message, 'accepted');
  assert.equal(c.cfgDirty, true, 'edits made while saving remain unsaved');
  assert.equal(c.TOKEN, 'fixture-new'); assert.equal(h.storage.get('wui_token'), 'fixture-new');
  assert.equal(closed, 1); assert.equal(c.evtSource, null); assert.equal(reconnected, 0);
  assert.deepEqual(phases(), ['saving', 'saved']); assert.equal(c.cfgSavePromise, null);
  assert.equal(h.node('#cfg-savebar').children[1]!.children.every(button => !button.disabled), true);
  h.runTimers(1500); await tick();
  assert.equal(requests[0]!.url, '/api/overview');
  assert.equal(requests[0]!.options.headers.Authorization, 'Bearer fixture-new');
  requests.shift()!.resolve({ ok: false, status: 401, json: async () => ({ error: 'still restarting' }) });
  await tick(); assert.equal(c.authPromise, null, 'restart probes do not interrupt the draft with authentication');
  assert.equal(reconnected, 0);
  h.runTimers(1500); await tick();
  requests.shift()!.resolve({ ok: true, json: async () => ({}) });
  await tick(); assert.equal(reconnected, 1, 'SSE resumes only after the saved credentials are accepted');

  c.cfgCache.webui.token = '******';
  const unchanged = c.saveConfig(); await tick();
  requests.shift()!.resolve({ ok: true, json: async () => ({}) }); await deadline(unchanged);
  assert.equal(c.cfgDirty, false); assert.equal(c.TOKEN, 'fixture-new', 'a mask never becomes the login token');
  c.cfgCache.webui.token = 'fixture-failed'; c.cfgDirty = true;
  const draft = c.cfgCache, failed = c.saveConfig(); await tick();
  requests.shift()!.resolve({ ok: false, status: 401, json: async () => ({ error: 'fixture-failed was not accepted' }) });
  assert.equal(await deadline(failed), null);
  assert.equal(c.cfgCache, draft); assert.equal(c.cfgDirty, true); assert.equal(c.cfgSavePromise, null);
  assert.equal(c.cfgCache.webui.token, 'fixture-failed'); assert.equal(c.TOKEN, 'fixture-new');
  assert.equal(h.storage.get('wui_token'), 'fixture-new'); assert.equal(c.authPromise, null);
  assert.equal(requests.length, 0, 'failed mutations are not automatically retried');
  assert.equal(phases().at(-1), 'error');
  assert.equal(JSON.stringify(h.details).includes('fixture-'), false, 'save events contain no credentials or full configuration');
  console.log('PASS WebUI config save: busy guard, stable drafts, token acknowledgment, safe events and delayed authorized SSE reconnect');
}

async function configurationTourHooks() {
  const h = harness(), c = h.context;
  c.activeView = 'config'; c.cfgCache = { bot: { apiKey: '******' } };
  c.schemaCache = { children: ['bot', 'world'].map(key => ({ children: [{ key, type: 'object' }] })) };
  c.cfgDirty = true; c.cfgSearch = 'previous-search'; h.node('#cfg-q').value = 'previous-search';
  let rendered = 0, navigated = '';
  c.renderCfgBody = () => { rendered++; }; c.switchView = (view: string) => { navigated = view; };
  const draft = c.cfgCache;
  c.focusConfigGroup('world');
  assert.equal(c.cfgCache, draft); assert.equal(c.cfgDirty, true); assert.equal(c.cfgGroup, 'world');
  assert.equal(c.cfgSearch, ''); assert.equal(h.node('#cfg-q').value, ''); assert.equal(navigated, '');
  const botNav = h.node('#cfg-nav').children.find(node => node['data-config-nav'] === 'bot')!;
  assert.equal(botNav.role, 'button'); assert.equal(botNav.tabindex, '0');
  let prevented = false;
  botNav.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(c.cfgGroup, 'bot'); assert.equal(prevented, true); assert.equal(rendered, 2);
  c.activeView = 'overview'; c.focusConfigGroup('webui'); assert.equal(navigated, 'config');

  const field = c.renderInput({ type: 'string', role: 'secret' }, ['bot', 'apiKey'], '******');
  const input = field.children[0];
  assert.equal(input.value, '');
  input.value = 'replacement'; input.oninput(); assert.equal(c.cfgCache.bot.apiKey, 'replacement');
  input.value = ''; input.oninput(); assert.equal(c.cfgCache.bot.apiKey, '******', 'clearing a temporary replacement preserves the server secret');
  field.children[1].onclick(); assert.equal(c.cfgCache.bot.apiKey, '');
  input.value = 'another-replacement'; input.oninput(); input.value = ''; input.oninput();
  assert.equal(c.cfgCache.bot.apiKey, '', 'an explicit clear remains cleared');

  const pending: ((value: unknown) => void)[] = [];
  c.api = () => new Promise(resolve => pending.push(resolve));
  c.stateCache = { botDef: 'old', worldDef: 'world' };
  const pane = c.statePane('botdef', '角色定义', 'old', '/api/definitions/bot');
  const definition = pane.querySelector('textarea'), save = pane.querySelector('button');
  assert.equal(definition['aria-label'], '角色定义'); assert.equal(definition['data-tour-definition'], 'botdef');
  assert.equal(save['data-tour-definition-save'], 'botdef');
  definition.value = 'saved definition'; save.onclick(); definition.value = 'new unsaved edit';
  assert.equal(c.stateCache.botDef, 'old'); pending.shift()!({}); await tick();
  assert.equal(c.stateCache.botDef, 'saved definition'); assert.equal(definition.value, 'new unsaved edit');
  const event = h.details.at(-1)!;
  assert.equal(event.type, 'studio:definition-save'); assert.equal(event.detail.id, 'botdef'); assert.equal(event.detail.phase, 'saved');
  console.log('PASS WebUI tour hooks: group navigation preserves drafts, masked secrets require explicit clearing and definitions report acknowledged saves');
}

async function main() { await authentication(); await managementLifecycle(); await configurationSave(); await configurationTourHooks(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
