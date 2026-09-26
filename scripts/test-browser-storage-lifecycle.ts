/** Actual WorldFiles archive lifecycle and raw-file HTTP guards; no browser or network. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { WorldFiles } from "../src/files.js";
import { WebUIServer } from "../src/webui/server.js";
import { Config } from "../src/config.js";

const privateName = "phone-browser.json";
const original = JSON.stringify({
  version: 1,
  history: [{ id: "old-visit", url: "https://example.invalid/article", title: "过去读过的文章", at: 10 }],
  bookmarks: [{ id: "saved", url: "https://example.invalid/article", title: "想回看的内容" }],
  session: { tabs: [{ url: "https://example.invalid/article" }], cookies: [{ name: "session", value: "fixture-secret-cookie", domain: "example.invalid" }] },
});
const future = JSON.stringify({ version: 1, history: [{ id: "future-visit" }], bookmarks: [], session: { cookies: [{ value: "future-cookie" }] } });
const mode = async (file: string) => (await fs.stat(file)).mode & 0o777;

async function lifecycle(files: WorldFiles) {
  assert.equal(files.phoneBrowser, path.join(files.base, privateName));
  await files.ensure();
  const empty = await files.snapshot("浏览器首次使用前");
  assert.equal(await files.exists(path.join(files.archiveDir, empty, privateName)), false);
  await fs.writeFile(files.phoneBrowser, original, { mode: 0o644 });
  await fs.chmod(files.phoneBrowser, 0o644); // imported legacy permissions must not leak into the archive
  const archive = await files.snapshot("过去的浏览器");
  const saved = path.join(files.archiveDir, archive, privateName);
  assert.equal(await fs.readFile(saved, "utf8"), original, "Archive preserves exact history, bookmarks and session bytes");
  assert.equal(await mode(saved), 0o600, "Even permissive live input is copied into a private archive inode");
  const manifest = JSON.parse(await fs.readFile(path.join(files.archiveDir, archive, "manifest.json"), "utf8"));
  assert.ok(manifest.files.includes(privateName), "Browser state participates in full archive restore");

  await fs.writeFile(files.phoneBrowser, future); await fs.chmod(files.phoneBrowser, 0o666);
  await fs.chmod(saved, 0o644); // simulate a copied/imported archive losing its original permissions
  await files.restoreFrom(path.join(files.archiveDir, archive));
  assert.equal(await fs.readFile(files.phoneBrowser, "utf8"), original);
  assert.equal(await mode(files.phoneBrowser), 0o600, "Restore replaces an existing permissive destination with an owner-only inode");
  assert.ok(!(await fs.readdir(files.base)).some(name => name.startsWith(privateName + ".")), "Private temporary copies are removed");
  await files.restoreFrom(path.join(files.archiveDir, empty));
  assert.equal(await files.exists(files.phoneBrowser), false, "An old archive without browser state must remove future cookies and browsing history");

  await fs.writeFile(files.phoneBrowser, future, { mode: 0o600 });
  await files.writePhoneShell("<html>独立外壳</html>");
  const archivesBefore = new Set(await fs.readdir(files.archiveDir));
  await files.reset();
  assert.equal(await files.exists(files.phoneBrowser), false, "A fresh world's browser cannot inherit the previous session");
  assert.equal(await files.readPhoneShell(), "<html>独立外壳</html>", "The reusable phone shell has a distinct lifecycle");
  const resetArchive = (await fs.readdir(files.archiveDir)).find(name => !archivesBefore.has(name))!;
  assert.ok(resetArchive);
  assert.equal(await fs.readFile(path.join(files.archiveDir, resetArchive, privateName), "utf8"), future, "Reset backs up browser data before removing it");
  assert.equal(await mode(path.join(files.archiveDir, resetArchive, privateName)), 0o600);
  await files.restoreFrom(path.join(files.archiveDir, archive));
  assert.equal(await fs.readFile(files.phoneBrowser, "utf8"), original, "The archived session is recoverable after reset");
  return archive;
}

async function privateArchiveApi(files: WorldFiles, archive: string) {
  const config = Config({ autoStart: false }); config.webui.token = "offline-browser-admin";
  const server: any = new WebUIServer({ config, files, webuiDir: path.join(files.base, "webui") } as never);
  const privateFiles = [privateName, privateName + ".tmp", privateName + ".partial-write.tmp"];
  for (const name of privateFiles) {
    await fs.writeFile(path.join(files.archiveDir, name), "fixture-legacy-cookie", { mode: 0o600 });
    if (name !== privateName) await fs.writeFile(path.join(files.archiveDir, archive, name), "fixture-interrupted-cookie", { mode: 0o600 });
  }
  await fs.writeFile(path.join(files.archiveDir, archive, "clock.json"), '{"elapsed":42}');
  async function request(url: string) {
    const req: any = Readable.from([]);
    Object.assign(req, { method: "GET", url, headers: { authorization: "Bearer offline-browser-admin" } });
    let status = 0, body = "";
    await server.handle(req, { writeHead(value: number) { status = value; }, end(value: unknown) { body = String(value); }, setHeader() {} });
    return { status, body: JSON.parse(body) };
  }
  for (const route of ["/api/archive", "/api/data"]) {
    const response = await request(route); assert.equal(response.status, 200);
    const listed = route === "/api/data" ? response.body.archive : response.body;
    assert.ok(listed.snapshots.every((snapshot: any) => snapshot.files.every((file: any) => !privateFiles.includes(file.name))), "General archive listings do not advertise private browser files");
    assert.ok(listed.legacy.every((name: string) => !privateFiles.includes(name)));
    if (route === "/api/data") assert.ok(response.body.files.every((file: any) => file.name !== privateName));
  }
  for (const name of privateFiles) {
    for (const folder of [archive, ""]) {
      const response = await request("/api/archive/file?folder=" + encodeURIComponent(folder) + "&file=" + encodeURIComponent(name));
      assert.equal(response.status, 403, "Direct raw-file reads cannot bypass hiding, including admin access and interrupted copies");
      assert.ok(!JSON.stringify(response.body).includes("cookie"), "Denied responses contain no credential bytes");
    }
  }
  assert.equal((await request("/api/data/file?name=" + privateName)).status, 400);
  const ordinary = await request("/api/archive/file?folder=" + encodeURIComponent(archive) + "&file=clock.json");
  assert.equal(ordinary.status, 200); assert.equal(ordinary.body.content, '{"elapsed":42}', "Unrelated archive content remains readable");
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-browser-storage-"));
  try {
    const files = new WorldFiles(base);
    const archive = await lifecycle(files);
    await privateArchiveApi(files, archive);
    console.log("PASS browser storage lifecycle: exact archive/restore, legacy absence, reset backup, private 0600 copies and inaccessible raw cookie files");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
