import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { CameraApp } from "../src/apps/camera.js";
import { ImageClient } from "../src/llm/image.js";
import { MediaStore } from "../src/media/store.js";
import { GalleryStore } from "../src/media/gallery.js";
import { callStore } from "../src/webui/calls.js";
import type { RichText } from "../src/types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lXYAAAAASUVORK5CYII=", "base64");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (check()) return; await sleep(5); }
  throw new Error(`Timed out: ${label}`);
}
function database() {
  const tables = new Map<string, any[]>();
  const rows = (table: string) => { if (!tables.has(table)) tables.set(table, []); return tables.get(table)!; };
  const matches = (row: any, query: any) => Object.entries(query).every(([key, value]) => row[key] === value);
  return {
    async get(table: string, query: any) { return rows(table).filter(row => matches(row, query)).map(row => ({ ...row })); },
    async create(table: string, value: any) { const row = { id: rows(table).length + 1, ...value }; rows(table).push(row); return row; },
    async set(table: string, query: any, value: any) { for (const row of rows(table)) if (matches(row, query)) Object.assign(row, value); },
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-camera-app-"));
  const notices: RichText[] = [], imageRequests: any[] = [], briefs: any[] = [], downloads: any[] = [];
  let mode = "base64", baseURL = "";
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/asset")) {
      downloads.push(req.headers);
      if (mode === "invalid") { res.writeHead(200); res.end("<html>this is not a photo</html>"); return; }
      if (mode === "oversize") { res.writeHead(200, { "content-length": "50000000" }); res.end("x"); return; }
      if (mode === "stall") { res.writeHead(200, { "content-type": "image/png" }); res.write(png.subarray(0, 8)); return; }
      res.writeHead(200, { "content-type": "image/png" }); res.end(png); return;
    }
    let body = ""; for await (const data of req) body += data;
    const request = JSON.parse(body);
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/chat/completions") {
      briefs.push(request);
      const input = JSON.parse(request.messages.at(-1).content);
      const content = input.framingRequest.subject === "不可见的房间" || (input.framingRequest.facing === "front" && !input.scene.appearance && !input.scene.visible.includes("自己的手"))
        ? JSON.stringify({ canPhotograph: false, reason: "没有明确外貌或可见主体，先观察自己或需要的场景。" })
        : JSON.stringify({ canPhotograph: true, brief: input.framingRequest.facing === "front" ? "只取明确可见的手部，不显示未知面部或背景。" : "后置特写已见到的木桌与白杯，杯子位于桌面左侧，画面裁切至桌面，不添加背景。" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
    assert.equal(req.url, "/v1/images/generations");
    imageRequests.push(request);
    res.end(JSON.stringify({ data: mode === "base64" ? [{ b64_json: png.toString("base64") }] : [{ url: baseURL.replace(/\/v1$/, "") + "/asset?temporary=true" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const releaseCalls = callStore.init(path.join(root, "calls"));
  const ctx = { model: { extend() {} }, database: database() } as any;
  const media = new MediaStore(ctx, path.join(root, "assets"), 100_000, { info() {}, debug() {}, warn() {}, error() {} } as any);
  const gallery = new GalleryStore(ctx, path.join(root, "gallery"));
  const imageConfig = { baseURL, apiKey: "fixture-key", model: "fixture-image", size: "1024x1024", quality: "standard", maxBytes: 100_000, promptMaxChars: 5000 };
  const briefLlm = { baseURL, apiKey: "fixture-key", model: "fixture-world-config", stream: false, label: "World" };
  let scene = { visible: "木桌左侧放着一只白杯。", appearance: "", actorName: "角色甲", worldState: "PRIVATE_WORLD_SECRET", chat: "PRIVATE_CHAT_SECRET", persona: "PRIVATE_PERSONA_SECRET" };
  const options = { imageConfig, briefLlm, media, gallery, getScene: () => scene, onComplete: (notice: RichText) => { notices.push(notice); } };
  const app = new CameraApp(options), apps = [app];
  try {
    assert.deepEqual((await app.open()).tools.map(tool => tool.name), ["take_photo", "read_photo", "cancel"]);
    const accepted = await app.call("take_photo", { subject: "桌上的白杯", facing: "rear" });
    assert.match(String(accepted), /图片尚未生成/);
    await app.close();
    await until(() => !app.viewState().busy, "saved photo");
    assert.equal(app.viewState().jobs[0]!.status, "completed");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.attachments, undefined, "completion notification does not auto-view an image after switching apps");
    const result = await app.call("read_photo", {}) as RichText;
    assert.equal(result.attachments!.length, 1);
    assert.deepEqual(await media.readFile(result.attachments![0]!), png);
    assert.equal(result.parts!.filter(part => part.kind === "media").length, 1);
    assert.match(result.text, /没有发给任何聊天对象/);
    assert.match(result.text, /不构成新的世界事实/);
    assert.ok(!result.experience?.worldPerception);
    const galleryRef = app.viewState().jobs[0]!.galleryRef!;
    assert.match(galleryRef, /^gallery:照片\/相机-[0-9a-f]{12}\.png$/, "photo names use an opaque ID instead of a real-world calendar date");
    const publicPhotoJob = app.viewState().jobs[0]!;
    assert.equal((publicPhotoJob as any).createdAt, undefined);
    assert.equal((publicPhotoJob as any).finishedAt, undefined);
    assert.ok(publicPhotoJob.realStartedAt && publicPhotoJob.realFinishedAt, "real processing dates are explicitly named audit fields");
    assert.ok(!JSON.stringify(result).includes(publicPhotoJob.realStartedAt));
    assert.doesNotMatch(result.text, /\d{4}-\d{2}-\d{2}[T_]/, "the character's photo result must not introduce the server's ISO timestamp");
    const saved = await gallery.resolve(galleryRef.slice("gallery:".length));
    assert.ok(saved); assert.deepEqual(await fs.readFile(saved.file), png);
    assert.ok(!JSON.stringify(briefs).includes("PRIVATE_"));
    assert.ok(!JSON.stringify(imageRequests).includes("PRIVATE_"));
    assert.equal(imageRequests[0].n, 1);
    assert.equal(imageRequests[0].response_format, undefined, "GPT image services must not receive unsupported response_format");
    assert.match(imageRequests[0].prompt, /confirmedScene是唯一已知/);
    assert.match(imageRequests[0].prompt, /不自行把拍摄者放进画面/);
    assert.ok(callStore.recent().every(call => call.source === "App:Camera" || call.source === "App:Camera:Image"));

    // Services returning expiring HTTP URLs are downloaded into the same stable asset system.
    mode = "url";
    await app.call("take_photo", { subject: "白杯" });
    await until(() => !app.viewState().busy, "url photo");
    assert.equal(app.viewState().jobs.at(-1)!.status, "completed");
    assert.equal(downloads.at(-1).authorization, undefined, "storage URLs must never receive the image API key");
    assert.equal((await app.call("read_photo", {}) as RichText).attachments![0]!.id, result.attachments![0]!.id, "identical bytes keep canonical media identity");

    const beforeDenied = imageRequests.length;
    await app.call("take_photo", { facing: "front" });
    await until(() => !app.viewState().busy, "unknown appearance refusal");
    assert.equal(app.viewState().jobs.at(-1)!.status, "failed");
    assert.equal(imageRequests.length, beforeDenied);
    scene = { ...scene, visible: "你看见自己的手，有浅色毛发，戴着黑色指环。" };
    await app.call("take_photo", { facing: "front", subject: "拍自己的手" });
    await until(() => !app.viewState().busy, "evidenced partial selfie");
    assert.equal(app.viewState().jobs.at(-1)!.status, "completed");
    assert.match(imageRequests.at(-1).prompt, /只知道局部时仅拍局部/);
    await app.call("take_photo", { subject: "不可见的房间" });
    await until(() => !app.viewState().busy, "unseen subject refusal");
    assert.equal(app.viewState().jobs.at(-1)!.status, "failed");
    assert.equal(imageRequests.length, beforeDenied + 1, "refused framing does not spend an image request");

    mode = "invalid";
    const beforeFiles = await gallery.listNames("照片");
    await app.call("take_photo", {});
    await until(() => !app.viewState().busy, "invalid image");
    assert.equal(app.viewState().jobs.at(-1)!.status, "failed");
    assert.deepEqual(await gallery.listNames("照片"), beforeFiles);
    mode = "oversize";
    await assert.rejects(new ImageClient(imageConfig).generate("known view"), /大小限制/);
    mode = "stall";
    const downloadAbort = new AbortController(), downloadCount = downloads.length;
    const stalledDownload = new ImageClient(imageConfig).generate("known view", downloadAbort.signal);
    const downloadRejected = assert.rejects(stalledDownload, /abort/i);
    await until(() => downloads.length > downloadCount, "image download started");
    downloadAbort.abort();
    await downloadRejected;

    // A cancellable brief cannot finish later and start the expensive image request.
    let signal: AbortSignal | undefined, imageCalls = 0;
    const slow = new CameraApp({ ...options, briefClient: { complete: async (_messages, opts) => {
      signal = opts?.signal;
      await new Promise<void>((_resolve, reject) => opts!.signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
      return { content: "", toolCalls: [] };
    } }, imageClient: { generate: async () => { imageCalls++; return { data: png, mime: "image/png" }; } } }); apps.push(slow);
    await slow.call("take_photo", {});
    await until(() => !!signal, "slow brief");
    await slow.close(); assert.equal(signal!.aborted, false);
    assert.match(String(await slow.call("take_photo", {})), /仍在处理/);
    await slow.call("cancel", {});
    assert.equal(slow.viewState().jobs.at(-1)!.status, "cancelled");
    assert.equal(imageCalls, 0);
    signal = undefined;
    await slow.call("take_photo", {}); await until(() => !!signal, "second slow brief");
    await slow.dispose();
    assert.equal(signal!.aborted, true);
    assert.equal(imageCalls, 0);

    // Stopping the world joins already-started local persistence before a reset can move files.
    let releaseSave!: () => void, saving = false, disposed = false;
    const savingApp = new CameraApp({ ...options,
      briefClient: { complete: async () => ({ content: JSON.stringify({ canPhotograph: true, brief: "只拍已知可见的手部" }), toolCalls: [] }) },
      imageClient: { generate: async () => ({ data: png, mime: "image/png" }) },
      gallery: { importFile: async (...args: Parameters<GalleryStore["importFile"]>) => { saving = true; await new Promise<void>(resolve => { releaseSave = resolve; }); return gallery.importFile(...args); } } as GalleryStore,
    }); apps.push(savingApp);
    await savingApp.call("take_photo", {}); await until(() => saving, "saving started");
    const noticeCount = notices.length;
    const disposing = savingApp.dispose().then(() => { disposed = true; });
    await sleep(10); assert.equal(disposed, false);
    releaseSave(); await disposing;
    assert.equal(savingApp.viewState().jobs.at(-1)!.status, "completed", "a late stop does not lie about a saved asset");
    assert.equal(notices.length, noticeCount, "a stopped lifetime cannot deliver stale photo notifications");
    await assert.rejects(savingApp.call("take_photo", {}), /已停止/);
    console.log("PASS camera grounded framing, evidence-limited selfie, real base64/URL image assets and gallery refs, private-field isolation, failure/cancel/dispose and no auto-send");
  } finally {
    await Promise.all(apps.map(item => item.dispose()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    releaseCalls();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
