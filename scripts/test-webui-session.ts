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
  setAttribute(key: string, value: unknown) { this[key] = value; }
  addEventListener(type: string, handler: unknown) { this["on" + type] = handler; }
  focus() {}
}

function harness() {
  const nodes = new Map<string, Element>(), storage = new Map<string, string>(), events: string[] = [];
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, Object.assign(new Element("div"), { root: true }));
    return nodes.get(selector)!;
  };
  const context: any = vm.createContext({
    document: { querySelector: node, createElement: (name: string) => new Element(name), createDocumentFragment: () => new Element("fragment") },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    window: { dispatchEvent: (event: { type: string }) => events.push(event.type) },
    CustomEvent: class { constructor(readonly type: string) {} },
    // Focus/refresh timers are unrelated to this suite. Promise scheduling remains native.
    setTimeout() {}, setInterval() {}, clearInterval() {}, AbortController, console,
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
  return { context, node, storage, events, find, click };
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

async function main() { await authentication(); await managementLifecycle(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
