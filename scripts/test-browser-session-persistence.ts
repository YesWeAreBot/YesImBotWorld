/** Pure session-store checks; optional real Chromium checks use only temporary loopback sites. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { BrowserSession, parseBrowserSessionState, type BrowserSessionState } from "../src/apps/browser-session.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, timeout = 3000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("browser shutdown did not settle")), timeout); })]); }
  finally { clearTimeout(timer); }
}

const initial: BrowserSessionState = { schemaVersion: 1, navigation: { entries: [
  { url: "https://a.example/page", title: "A", scrollX: 0, scrollY: 100, restorable: true },
  { url: "https://b.example/page", title: "B", scrollX: 0, scrollY: 500, restorable: true },
], cursor: 1 }, cookies: [{ name: "session", value: "secret-token", domain: "a.example", path: "/", httpOnly: true, secure: true, expires: -1, size: 30 }],
  origins: [{ origin: "https://a.example", localStorage: { token: "local-token" }, sessionStorage: { draft: "session-note" } }, { origin: "https://b.example", localStorage: { theme: "dark" } }] };

async function storeContract() {
  const parsed = parseBrowserSessionState(initial)!; assert.ok(parsed);
  assert.equal(parsed.cookies[0]!.size, undefined, "only replayable cookie metadata is persisted");
  parsed.navigation.entries[0]!.title = "changed"; assert.equal(initial.navigation.entries[0]!.title, "A");
  for (const bad of [{ ...initial, schemaVersion: 2 }, { ...initial, navigation: { entries: initial.navigation.entries, cursor: 4 } },
    { ...initial, navigation: { entries: [{ ...initial.navigation.entries[0], url: "file:///etc/passwd" }], cursor: 0 } },
    { ...initial, navigation: { entries: [{ ...initial.navigation.entries[0], url: "https://user:secret@example.com" }], cursor: 0 } },
    { ...initial, origins: [{ origin: "https://a.example/path", localStorage: {} }] }, { ...initial, cookies: [{ name: "bad" }] }]) assert.equal(parseBrowserSessionState(bad), undefined);
  let writes = 0;
  const bad = new BrowserSession(() => null, async () => ({ width: 400, height: 800 }), "", { load: async () => ({ ...initial, schemaVersion: 4 } as any), save: async () => { writes++; } });
  await assert.rejects(bad.restore(), /格式无效/); await bad.dispose(); assert.equal(writes, 0, "invalid archives cannot be silently overwritten");
  const empty = new BrowserSession(() => null, async () => ({ width: 400, height: 800 }), "", { load: async () => undefined, save: async () => { writes++; } });
  assert.equal(await empty.restore(), undefined); await empty.dispose(); assert.equal(writes, 0);
  const home = new BrowserSession(() => null, async () => ({ width: 400, height: 800 }), "", { load: async () => ({ ...initial, navigation: { entries: [{ url: "about:blank", title: "主页", scrollX: 0, scrollY: 0, restorable: true }], cursor: 0 } }), save: async () => { writes++; } });
  assert.equal(await home.restore(), undefined, "the app may rebuild its portal instead of restoring empty HTML"); await home.dispose();
  console.log("PASS browser persistence schema, safe URLs, independent state copies, unavailable/invalid-state preservation and portal fallback");
}

async function realChromium() {
  const executablePath = process.env.BROWSER_SMOKE_EXECUTABLE;
  if (!executablePath) return;
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const puppeteer = require(require.resolve("puppeteer-core", { paths: [process.env.BROWSER_SMOKE_RUNTIME || process.cwd()] }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-session-persistence-")), file = path.join(dir, "browser.json");
  const requests: { site: string; method: string; url: string }[] = [];
  const servers: http.Server[] = [];
  const slowEntered = deferred<void>();
  let browser: any, first: BrowserSession | undefined, restored: BrowserSession | undefined, postSession: BrowserSession | undefined, delayedSession: BrowserSession | undefined;
  const makeSite = async (site: string) => {
    const server = http.createServer((request, response) => {
      if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      requests.push({ site, method: request.method!, url: request.url! });
      if (request.url === "/slow") { slowEntered.resolve(); return; }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Set-Cookie", `${site}_login=present; HttpOnly; Path=/; SameSite=Lax`);
      response.end(`<!doctype html><title>${site} ${request.url}</title><h1>${site}</h1><p id="stored"></p><p id="auth">${request.headers.cookie || "none"}</p><label>Password<input type="password" id="password"></label><form method="post" action="/submitted"><input name="secret" value="form-body-must-not-be-saved"><button>Submit</button></form><div id="spacer" style="height:100px"></div><script>document.querySelector('#stored').textContent='local='+localStorage.getItem('saved')+';session='+sessionStorage.getItem('saved');setTimeout(()=>document.querySelector('#spacer').style.height='4000px',80);</script>`);
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as any).port}`;
  };
  const a = await makeSite("a"), b = await makeSite("b");
  let saves = 0;
  const persistence = { load: async () => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; } },
    save: async (state: BrowserSessionState) => { saves++; await fs.writeFile(file, JSON.stringify(state)); } };
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: path.join(dir, "chromium"), args: ["--no-sandbox"], timeout: 20_000 });
    const shared = await browser.newPage();
    await shared.setCookie({ name: "host_private", value: "must-not-leak", url: a });
    const create = () => new BrowserSession(() => ({ browser }), async () => ({ width: 600, height: 800 }), "", persistence);
    first = create(); assert.equal(await first.restore(), undefined);
    await first.navigate(a + "/a");
    await (first as any).page.evaluate(() => { localStorage.setItem("saved", "A-kept"); sessionStorage.setItem("saved", "A-session"); (globalThis as any).scrollTo(0, 700); });
    await first.checkpoint();
    await first.navigate(b + "/b");
    await (first as any).page.evaluate(() => { localStorage.setItem("saved", "B-kept"); sessionStorage.setItem("saved", "B-session"); (globalThis as any).document.querySelector("#password").value = "typed-password-never-persist"; (globalThis as any).scrollTo(0, 1100); });
    await first.dispose(); first = undefined;
    const saved = await persistence.load();
    assert.equal(saved.navigation.cursor, 1); assert.equal(saved.navigation.entries[0].scrollY, 700); assert.equal(saved.navigation.entries[1].scrollY, 1100);
    assert.equal(saved.origins.find((item: any) => item.origin === a).localStorage.saved, "A-kept");
    assert.equal(saved.origins.find((item: any) => item.origin === b).sessionStorage.saved, "B-session");
    assert.ok(saved.cookies.some((item: any) => item.name === "a_login" && item.httpOnly));
    assert.ok(!saved.cookies.some((item: any) => item.name === "host_private"));
    assert.doesNotMatch(JSON.stringify(saved), /typed-password|form-body-must-not-be-saved/);
    const before = requests.length;
    restored = create(); let view = (await restored.restore())!;
    assert.deepEqual(requests.slice(before), [{ site: "b", method: "GET", url: "/b" }], "storage bootstrap never contacts or executes historical pages");
    assert.equal(view.url, b + "/b"); assert.equal(view.scrollY, 1100); assert.match(view.text, /B-kept.*B-session/); assert.match(view.text, /b_login=present/);
    assert.equal(view.canGoBack, true); assert.equal(view.canGoForward, false);
    view = await restored.act({ kind: "back", revision: view.revision }); assert.equal(view.url, a + "/a"); assert.equal(view.scrollY, 700); assert.match(view.text, /A-kept.*A-session/);
    assert.equal(view.canGoForward, true);
    view = await restored.act({ kind: "forward", revision: view.revision }); assert.equal(view.url, b + "/b"); assert.equal(view.scrollY, 1100);
    // Clearing credentials must stay cleared; there is no every-navigation init script
    // that silently reintroduces the persisted values after logout.
    await (restored as any).page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    view = await restored.act({ kind: "reload", revision: view.revision }); assert.match(view.text, /local=null;session=null/);
    await (restored as any).page.deleteCookie({ name: "a_login", url: a });
    const loggedOut = await restored.checkpoint(); assert.ok(!loggedOut!.cookies.some(cookie => cookie.name === "a_login"), "deleted authentication cookies replace the saved set rather than merging back old login state");
    await restored.navigate(a + "/form");
    await (restored as any).page.evaluate(() => (globalThis as any).document.querySelector("form").submit());
    await (restored as any).page.waitForFunction(() => (globalThis as any).location.pathname === "/submitted");
    await restored.observe();
    const postState = await restored.checkpoint(); assert.equal(postState!.navigation.entries[postState!.navigation.cursor]!.restorable, false);
    await restored.dispose(); restored = undefined;
    const postCount = requests.length; postSession = create(); const postView = (await postSession.restore())!;
    assert.match(postView.notice!, /不能安全自动恢复/); assert.equal(requests.length, postCount, "restoring POST results sends no request or old body");
    await postSession.dispose(); postSession = undefined;
    const stillPost = await persistence.load(); assert.equal(stillPost.navigation.entries[stillPost.navigation.cursor].restorable, false, "closing an unrestored POST result cannot silently replace it with a blank history entry");
    postSession = create(); await postSession.navigate(b + "/safe");
    const hanging = postSession.navigate(b + "/slow"), stoppedNavigation = assert.rejects(hanging, /结束/);
    await bounded(slowEntered.promise); await bounded(postSession.dispose()); await stoppedNavigation; postSession = undefined;
    // Disposal joins an already-running save before its own final checkpoint. No older
    // asynchronous writer may arrive after the caller starts loading the next world.
    const saveEntered = deferred<void>(), releaseSave = deferred<void>();
    let delayedWrites = 0;
    delayedSession = new BrowserSession(() => ({ browser }), async () => ({ width: 600, height: 800 }), "", {
      load: async () => undefined,
      save: async () => { if (++delayedWrites === 1) { saveEntered.resolve(); await releaseSave.promise; } },
    });
    const savingNavigation = delayedSession.navigate(a + "/save"), rejectedSave = assert.rejects(savingNavigation, /结束/);
    await bounded(saveEntered.promise, 5000);
    let finished = false; const disposing = delayedSession.dispose().then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
    releaseSave.resolve(); await bounded(disposing); await rejectedSave;
    assert.equal(delayedWrites, 2); delayedSession = undefined;
    const writesAfterDispose = saves; await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(saves, writesAfterDispose);
    console.log("PASS real Chromium persistence: isolated HttpOnly cookies, all visited origins, sessionStorage, delayed-layout scroll, restored navigation, no history/form/password replay, logout stays cleared, interrupted navigation and joined final save");
  } finally {
    await Promise.allSettled([first?.dispose(), restored?.dispose(), postSession?.dispose(), delayedSession?.dispose()]);
    await browser?.close(); await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() { await storeContract(); await realChromium(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
