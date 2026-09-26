/** Browser history/bookmarks survive a world lifetime without replaying virtual inference. Offline only. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserApp } from "../src/apps/browser.js";
import { BrowserLibrary } from "../src/apps/browser-library.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { RichText } from "../src/types.js";

const logger: any = { warn() {} };
const clock: any = { syncRealTime: false, timeLine: () => "星历12年·第二日午后" };
const html = (title: string) => `<html><head><title>${title}</title></head><body><h1>${title}</h1>` +
  Array.from({ length: 100 }, (_, index) => `<p>${index}：这是已经读过的页面正文。${"雨落在屋檐边，书店今天仍然开门。".repeat(3)}</p>`).join("") +
  '<a href="https://fiction.invalid/b">第二页</a><img src="https://fixture.invalid/cover.png" alt="书店外观"></body></html>';
const text = (value: string | RichText) => typeof value === "string" ? value : value.text;
const origins = (value: string | RichText) => typeof value === "string" ? undefined : value.originEventIds;
const view = (app: BrowserApp): any => app.viewState();
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("fixture operation did not settle")), 3000); })]); }
  finally { clearTimeout(timer!); }
};
function app(files: WorldFiles, world: any): BrowserApp {
  const cfg = { ...Config({ autoStart: false }).apps, browserHomeURL: "portal", browserAutoScreenshot: false, browserProxy: "" };
  return new BrowserApp({} as any, world, files, clock,
    { ingest: async () => 77, get: async () => ({ id: 77, summary: "已保存", ref: { id: 77, type: "image", mime: "image/png" } }) } as any,
    {} as any, { enabledFor: () => false } as any, () => false, cfg, logger);
}

async function virtualHistoryAndModeIsolation(base: string) {
  const files = new WorldFiles(base); await files.ensure(); await files.writeMeta({ realWorld: false });
  let queries = 0;
  const world = { observeVirtualApp: async (task: string) => {
    queries++; assert.match(task, /只读呈现已有网页/);
    return { text: html(task.includes("fiction.invalid/b") ? "虚构第二页" : "虚构第一页"), originEventIds: [`virtual-page-${queries}`] };
  } };
  const first = app(files, world);
  const opening = await first.open(); assert.equal(queries, 0); assert.match(text(opening.opening!), /尚未查看网页/);
  for (const name of ["go_forward", "list_history", "open_history", "list_bookmarks", "add_bookmark", "rename_bookmark", "remove_bookmark", "open_bookmark"]) {
    assert.ok(opening.tools.some(tool => tool.name === name), `${name} must be advertised`);
  }
  const a = await first.call("open_url", { url: "https://fiction.invalid/a" });
  assert.deepEqual(origins(a), ["virtual-page-1"]);
  await first.call("scroll_down", {});
  const scrolled = first.peekScreen()!; assert.match(scrolled.text, /第 2\//);
  const firstHistoryId = view(first).library.history[0].id;
  await first.call("add_bookmark", { title: "窗边书店" });
  const bookmarkId = view(first).library.bookmarks[0].id;
  assert.deepEqual(first.peekScreen(), scrolled, "bookmark/save confirmations never replace the actual page");
  await first.call("add_bookmark", { title: "重复收藏" });
  assert.equal(view(first).library.bookmarks.length, 1); assert.equal(view(first).library.bookmarks[0].id, bookmarkId);
  await first.call("rename_bookmark", { id: bookmarkId, title: "午后书店" });
  assert.equal(view(first).library.bookmarks[0].id, bookmarkId); assert.equal(view(first).library.bookmarks[0].title, "午后书店");
  assert.match(text(await first.call("list_bookmarks", { query: "午后", limit: 1 })), new RegExp(bookmarkId));
  assert.match(text(await first.call("list_history", { limit: 1 })), /星历12年/);
  assert.deepEqual(first.peekScreen(), scrolled, "library inspection does not become a fabricated webpage");
  await first.call("open_url", { url: "https://fiction.invalid/b" });
  const b = first.peekScreen()!;
  assert.equal(queries, 2); assert.equal(view(first).library.canGoBack, true);
  const back = await first.call("go_back", {});
  assert.deepEqual(origins(back), ["virtual-page-1"]); assert.match(text(back), /第 2\//);
  const ahead = await first.call("go_forward", {});
  assert.deepEqual(origins(ahead), b.originEventIds); assert.equal(queries, 2, "virtual back/forward rereads saved pages, never a fresh World result");
  await first.close(); await first.dispose();
  assert.equal((await fs.stat(files.phoneBrowser)).mode & 0o777, 0o600);

  let restored = app(files, world);
  const reopened = await restored.open();
  assert.equal(queries, 2); assert.deepEqual(origins(reopened.opening!), b.originEventIds);
  assert.equal(view(restored).url, "https://fiction.invalid/b");
  assert.equal(view(restored).library.bookmarks[0].id, bookmarkId);
  const restoreBack = await restored.call("go_back", {});
  assert.deepEqual(origins(restoreBack), ["virtual-page-1"]); assert.match(text(restoreBack), /第 2\//);
  await restored.dispose(); restored = app(files, world); await restored.open();
  assert.equal(view(restored).library.canGoForward, true, "the forward stack persists independently of the current page");
  assert.match(restored.peekScreen()!.text, /第 2\//);
  await restored.call("go_forward", {}); assert.equal(view(restored).url, "https://fiction.invalid/b");
  const history = await restored.call("open_history", { id: firstHistoryId });
  assert.equal(queries, 2); assert.deepEqual(origins(history), ["virtual-page-1"]);
  assert.match(text(history), /当时.*快照|快照.*当时/);
  assert.ok(view(restored).library.history.some((row: any) => row.id === firstHistoryId), "new visits never renumber previous history links");

  await files.writeMeta({ realWorld: true }); await restored.open();
  assert.equal(view(restored).mode, "text");
  assert.deepEqual(view(restored).library.bookmarks, []); assert.deepEqual(view(restored).library.history, []);
  assert.equal(view(restored).url, "browser://home", "real mode cannot revive a virtual page or fictional address");
  assert.doesNotMatch(JSON.stringify(view(restored)), /午后书店|虚构第一页|virtual-page/);
  await files.writeMeta({ realWorld: false }); await restored.open();
  assert.equal(view(restored).url, "https://fiction.invalid/a");
  assert.equal(view(restored).library.bookmarks[0].id, bookmarkId); assert.equal(queries, 2);
  await restored.call("remove_bookmark", { id: bookmarkId });
  assert.deepEqual(view(restored).library.bookmarks, []);
  assert.match(text(await restored.call("open_bookmark", { id: bookmarkId })), /不存在/);
  await restored.dispose();

  const archive = await files.snapshot("浏览器历史");
  const archivePath = path.join(files.archiveDir, archive);
  assert.equal((await fs.stat(path.join(archivePath, "phone-browser.json"))).mode & 0o777, 0o600);
  await files.reset(); assert.equal(await files.exists(files.phoneBrowser), false);
  await files.writeMeta({ realWorld: false });
  const reset = app(files, world); await reset.open();
  assert.equal(view(reset).url, ""); assert.deepEqual(view(reset).library.history, []); await reset.dispose();
  await files.restoreFrom(archivePath);
  const recovered = app(files, world); await recovered.open();
  assert.equal(view(recovered).url, "https://fiction.invalid/a");
  assert.ok(view(recovered).library.history.some((row: any) => row.id === firstHistoryId));
  assert.equal(queries, 2, "save restoration restores observed snapshots instead of regenerating fictional history");
  await recovered.dispose();
}

async function textHistory(base: string) {
  const files = new WorldFiles(base); await files.ensure(); await files.writeMeta({ realWorld: true });
  const fetchOriginal = globalThis.fetch;
  const env = new Map(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].map(name => [name, process.env[name]]));
  for (const name of env.keys()) delete process.env[name];
  const requests: string[] = [];
  globalThis.fetch = async input => { const url = String(input); requests.push(url); return new Response(html(url), { headers: { "content-type": "text/html" } }); };
  const world = { observeVirtualApp() { throw Error("real text navigation cannot call World"); } };
  try {
    const first = app(files, world); await first.open();
    await first.call("open_url", { url: "https://fixture.invalid/one" }); await first.call("scroll_down", {});
    const screen = first.peekScreen()!;
    await first.call("save_image", { n: 1 }); assert.deepEqual(first.peekScreen(), screen);
    await first.call("add_bookmark", {}); const bookmark = view(first).library.bookmarks[0];
    await first.call("open_url", { url: "https://fixture.invalid/two" }); await first.call("go_back", {});
    await first.dispose();
    const restored = app(files, world), opening = await restored.open();
    assert.equal(requests.length, 2, "reopening text browsing restores the persisted page without an unsolicited network load");
    assert.match(text(opening.opening!), /快照.*尚未重新联网/);
    assert.match(restored.peekScreen()!.text, /第 2\//); assert.equal(view(restored).library.bookmarks[0].id, bookmark.id);
    assert.equal(view(restored).library.canGoForward, true);
    await restored.call("go_forward", {}); assert.equal(view(restored).url, "https://fixture.invalid/two"); assert.equal(requests.length, 2);
    await restored.call("open_bookmark", { id: bookmark.id }); assert.equal(requests.length, 3, "explicit real bookmark navigation performs a genuine fetch");
    await restored.dispose();
  } finally { globalThis.fetch = fetchOriginal; for (const [name, value] of env) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}

async function privateSessionProjection(base: string) {
  const files = new WorldFiles(base); await files.ensure();
  const library = new BrowserLibrary(files.phoneBrowser); await library.load();
  library.get("real").session = { schemaVersion: 1, navigation: { entries: [], cursor: -1 },
    cookies: [{ name: "login", value: "PRIVATE_BROWSER_COOKIE", domain: ".fixture.invalid", httpOnly: true }],
    origins: [{ origin: "https://fixture.invalid", localStorage: { token: "PRIVATE_BROWSER_TOKEN" } }] };
  await library.save();
  const reloaded = new BrowserLibrary(files.phoneBrowser); await reloaded.load();
  assert.equal(reloaded.get("real").session!.cookies[0]!.value, "PRIVATE_BROWSER_COOKIE");
  assert.doesNotMatch(JSON.stringify(reloaded.view("real")), /PRIVATE_BROWSER|cookies|localStorage|sessionStorage/);
  assert.equal((await fs.stat(files.phoneBrowser)).mode & 0o777, 0o600);
  const brokenFile = path.join(base, "invalid-browser.json"), original = '{"version":999,"private":"keep this source"}';
  await fs.writeFile(brokenFile, original); await assert.rejects(new BrowserLibrary(brokenFile).load(), /存档格式无效/);
  assert.equal(await fs.readFile(brokenFile, "utf8"), original, "invalid persisted data is not overwritten as an empty browser");
  const malformedBookmark = JSON.parse(await fs.readFile(files.phoneBrowser, "utf8"));
  malformedBookmark.real.bookmarks = [{ id: "old", url: "https://fixture.invalid/old", title: "旧书签", createdAt: "2026-01-01" }];
  const malformedSource = JSON.stringify(malformedBookmark);
  await fs.writeFile(brokenFile, malformedSource);
  await assert.rejects(new BrowserLibrary(brokenFile).load(), /存档格式无效/, "missing bookmark sort metadata is rejected at the file boundary");
  assert.equal(await fs.readFile(brokenFile, "utf8"), malformedSource);
}

async function disposeDuringVirtualRead(base: string) {
  const files = new WorldFiles(base); await files.ensure(); await files.writeMeta({ realWorld: false });
  const started = deferred<void>(), result = deferred<RichText>(); let slow = false;
  const world = { observeVirtualApp: async () => {
    if (slow) { started.resolve(); return result.promise; }
    return { text: html("已确认旧页面"), originEventIds: ["confirmed-old-page"] };
  } };
  const browser = app(files, world); await browser.open(); await browser.call("open_url", { url: "https://fiction.invalid/confirmed" });
  slow = true;
  const pending = browser.call("open_url", { url: "https://fiction.invalid/late" });
  const rejected = assert.rejects(pending, /停止|结束/);
  await bounded(started.promise); const stopping = browser.dispose();
  result.resolve({ text: html("停止后才返回的新页面"), originEventIds: ["unseen-late-page"] });
  await bounded(Promise.all([stopping, rejected]));
  const saved = await fs.readFile(files.phoneBrowser, "utf8");
  assert.doesNotMatch(saved, /unseen-late-page|停止后才返回|fiction\.invalid\/late/, "a canceled late read cannot become the next world's persisted current page");
  const restored = app(files, { observeVirtualApp() { throw Error("restoration cannot re-infer a page"); } });
  await restored.open(); assert.equal(view(restored).url, "https://fiction.invalid/confirmed");
  assert.deepEqual(restored.peekScreen()!.originEventIds, ["confirmed-old-page"]);
  await restored.dispose();
}

async function disposeDuringRealRead(base: string) {
  const files = new WorldFiles(base); await files.ensure(); await files.writeMeta({ realWorld: true });
  const fetchOriginal = globalThis.fetch;
  const env = new Map(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].map(name => [name, process.env[name]]));
  for (const name of env.keys()) delete process.env[name];
  const started = deferred<void>(), response = deferred<Response>(); let slow = false;
  globalThis.fetch = async () => {
    if (slow) { started.resolve(); return response.promise; }
    return new Response(html("真实旧页面"), { headers: { "content-type": "text/html" } });
  };
  try {
    const browser = app(files, { observeVirtualApp() { throw Error("real browsing cannot infer pages"); } });
    await browser.open(); await browser.call("open_url", { url: "https://fixture.invalid/confirmed" });
    slow = true;
    const pending = browser.call("open_url", { url: "https://fixture.invalid/late" });
    const rejected = assert.rejects(pending, /停止|结束/);
    await bounded(started.promise); const stopping = browser.dispose();
    response.resolve(new Response(html("停机之后的真实页面"), { headers: { "content-type": "text/html" } }));
    await bounded(Promise.all([stopping, rejected]));
    const saved = await fs.readFile(files.phoneBrowser, "utf8");
    assert.doesNotMatch(saved, /停机之后|fixture\.invalid\/late/, "a fetch completing after shutdown cannot replace the confirmed page");
    const restored = app(files, {}); await restored.open();
    assert.equal(view(restored).url, "https://fixture.invalid/confirmed"); await restored.dispose();
  } finally { globalThis.fetch = fetchOriginal; for (const [name, value] of env) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}

async function disposeBeforeModeResolution(base: string) {
  const files = new WorldFiles(base); await files.ensure(); await files.writeMeta({ realWorld: false });
  let queries = 0;
  const browser = app(files, { observeVirtualApp: async () => {
    queries++; return { text: html("已确认页面"), originEventIds: ["old-mode-page"] };
  } });
  await browser.open(); await browser.call("open_url", { url: "https://fiction.invalid/confirmed" });
  const started = deferred<void>(), metadata = deferred<{ realWorld: boolean }>();
  files.readMeta = async () => { started.resolve(); return metadata.promise; };
  const pending = browser.call("open_url", { url: "https://fiction.invalid/after-stop" });
  const rejected = assert.rejects(pending, /停止|结束/);
  await bounded(started.promise); const stopping = browser.dispose(); metadata.resolve({ realWorld: false });
  await bounded(Promise.all([stopping, rejected]));
  assert.equal(queries, 1, "an operation canceled while resolving world mode must not start another World read");
  assert.doesNotMatch(await fs.readFile(files.phoneBrowser, "utf8"), /after-stop/);
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "browser-library-"));
  try {
    await virtualHistoryAndModeIsolation(path.join(base, "virtual"));
    await textHistory(path.join(base, "text"));
    await privateSessionProjection(path.join(base, "private"));
    await disposeDuringVirtualRead(path.join(base, "dispose"));
    await disposeDuringRealRead(path.join(base, "dispose-real"));
    await disposeBeforeModeResolution(path.join(base, "dispose-mode"));
    console.log("PASS browser library: stable history/bookmark IDs, CRUD, paged lists, persisted current/scroll/back/forward, virtual evidence reuse, mode isolation, private credentials, save/restore/reset and no late shutdown writes");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
