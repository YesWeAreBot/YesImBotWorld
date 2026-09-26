/** App/storage wiring regression. Real Chromium is opt-in and uses only isolated loopback pages. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BrowserApp } from "../src/apps/browser.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WorldService } from "../src/service.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function archiveCheckpointOrder() {
  const entered = deferred(), release = deferred(), order: string[] = [];
  const browser = Object.create(BrowserApp.prototype) as BrowserApp;
  browser.checkpoint = async () => { order.push("checkpoint:start"); entered.resolve(); await release.promise; order.push("checkpoint:saved"); };
  const service = Object.create(WorldService.prototype) as any;
  service.lifecycleOperation = async (_label: string, fn: () => Promise<string>) => fn();
  service.appManager = { resolve: (id: string) => { assert.equal(id, "browser"); return { kind: "app", app: browser }; } };
  service.files = { snapshot: async (label: string) => { assert.equal(label, "浏览器会话"); order.push("snapshot"); return "archive-id"; } };
  service.logger = { info() {} };
  const saving = service.saveArchive("浏览器会话");
  await entered.promise;
  assert.deepEqual(order, ["checkpoint:start"], "snapshot must wait for the current browser state to reach its file");
  release.resolve(); assert.match(await saving, /archive-id/);
  assert.deepEqual(order, ["checkpoint:start", "checkpoint:saved", "snapshot"]);
  browser.checkpoint = async () => { throw Error("fixture checkpoint write failed"); };
  await assert.rejects(service.saveArchive("浏览器会话"), /checkpoint write failed/);
  assert.equal(order.filter(item => item === "snapshot").length, 1, "a failed checkpoint cannot publish a stale successful archive");
  console.log("PASS service archive waits for browser checkpoint and propagates persistence failures");
}

async function realAppRecovery() {
  const executablePath = process.env.BROWSER_SMOKE_EXECUTABLE;
  if (!executablePath) return;
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const puppeteer = require(require.resolve("puppeteer-core", { paths: [process.env.BROWSER_SMOKE_RUNTIME || process.cwd()] }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-app-recovery-"));
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Set-Cookie", "fixture_login=cookie-private-value; HttpOnly; Path=/; SameSite=Lax");
    response.end(`<!doctype html><title>Fixture ${request.url}</title><h1>Fixture ${request.url}</h1><p>Only public page content.</p><div style="height:5000px">Long page</div>`);
  });
  let chromium: any, first: BrowserApp | undefined, restored: BrowserApp | undefined;
  const view = (app: BrowserApp): any => app.viewState();
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`, a = origin + "/a", b = origin + "/b";
    chromium = await puppeteer.launch({ executablePath, headless: true, userDataDir: path.join(dir, "chromium"), args: ["--no-sandbox"], timeout: 20_000 });
    const files = new WorldFiles(path.join(dir, "world")); await files.ensure(); await files.writeMeta({ realWorld: true, phone: { width: 600, height: 800 } });
    const cfg = { ...Config({ autoStart: false }).apps, browserHomeURL: "portal", browserAutoScreenshot: false, browserProxy: "" };
    const create = () => new BrowserApp({ puppeteer: { browser: chromium } } as any,
      { observeVirtualApp() { throw Error("real browsing must not request invented pages"); }, query() { throw Error("real browsing must not call World-LLM"); } } as any,
      files, { syncRealTime: true, timeLine: () => "2026-09-25 12:00" } as any,
      {} as any, {} as any, {} as any, () => false, cfg, { warn() {} } as any);
    first = create(); await first.open();
    await first.call("open_url", { url: a });
    await first.call("add_bookmark", { title: "Saved first page", revision: view(first).revision });
    const bookmark = view(first).library.bookmarks[0]; assert.equal(bookmark.url, a);
    const aHistoryId = view(first).library.history[0].id;
    await first.call("open_url", { url: b });
    await (first as any).live.page.evaluate(() => { localStorage.setItem("fixture-local", "local-private-value"); sessionStorage.setItem("fixture-session", "session-private-value"); });
    await first.call("scroll", { pixels: 1100, revision: view(first).revision });
    assert.equal(view(first).scrollY, 1100);
    await first.dispose(); first = undefined;
    const disk = await fs.readFile(files.phoneBrowser, "utf8");
    for (const value of ["cookie-private-value", "local-private-value", "session-private-value"]) assert.ok(disk.includes(value), "session credentials really reached WorldFiles, so the privacy assertion is non-vacuous");
    assert.equal((await fs.stat(files.phoneBrowser)).mode & 0o777, 0o600);

    const before = requests.length;
    restored = create(); const opening = await restored.open();
    assert.deepEqual(requests.slice(before), ["GET /b"], "open restores only the actual last page, without replaying historical sites or using the portal");
    assert.equal(view(restored).url, b); assert.equal(view(restored).scrollY, 1100);
    assert.equal(view(restored).library.canGoBack, true);
    assert.ok(view(restored).library.history.some((row: any) => row.id === aHistoryId && row.url === a));
    assert.deepEqual(view(restored).library.bookmarks, [bookmark]);
    const local = await (restored as any).live.page.evaluate(() => [localStorage.getItem("fixture-local"), sessionStorage.getItem("fixture-session")]);
    assert.deepEqual(local, ["local-private-value", "session-private-value"]);
    const history = await restored.call("list_history", {}), bookmarks = await restored.call("list_bookmarks", {});
    assert.ok(JSON.stringify(history).includes(aHistoryId)); assert.ok(JSON.stringify(bookmarks).includes(bookmark.id));
    const publicProjection = JSON.stringify({ opening, view: view(restored), screen: restored.peekScreen(), history, bookmarks });
    assert.doesNotMatch(publicProjection, /cookie-private-value|local-private-value|session-private-value|fixture_login|fixture-local|fixture-session/,
      "view state, advertised tools and actual read/list results must not serialize the private session store");
    await restored.call("go_back", { revision: view(restored).revision }); assert.equal(view(restored).url, a);
    assert.equal(view(restored).library.canGoForward, true);
    await restored.call("go_forward", { revision: view(restored).revision }); assert.equal(view(restored).url, b); assert.equal(view(restored).scrollY, 1100);
    await restored.call("open_bookmark", { id: bookmark.id }); assert.equal(view(restored).url, a);
    console.log("PASS real BrowserApp/WorldFiles restart: last page, scroll, history, bookmarks, back/forward and private credentials");
  } finally {
    await first?.dispose(); await restored?.dispose(); await chromium?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() { await archiveCheckpointOrder(); await realAppRecovery(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
