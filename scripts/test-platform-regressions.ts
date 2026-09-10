/**
 * 完全离线的权限、账号路由、设备与 MCP 回归测试。
 * node_modules/.bin/esbuild scripts/test-platform-regressions.ts --bundle --platform=node --format=cjs --alias:koishi="$PWD/node_modules/koishi/lib/index.cjs" --outfile=/tmp/yibw-platform-regressions.cjs
 * node /tmp/yibw-platform-regressions.cjs
 * 所有存储均使用临时目录；Docker CLI 和平台方法均为本地 stub。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Config } from "../src/config.js";
import { BotComputer } from "../src/computer.js";
import { WebUIServer } from "../src/webui/server.js";
import { PAGE_HTML } from "../src/webui/page.js";
import { VisitorStore } from "../src/webui/visitors.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { Gateway } from "../src/koishi/gateway.js";
import { channelKey, parseChannelKey } from "../src/koishi/channels.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { NotifyManager } from "../src/koishi/notify.js";
import { McpApp } from "../src/apps/mcp.js";
import { MediaRenderer } from "../src/media/render.js";

const logger = { info() {}, warn() {}, debug() {} };
const cfg = Config({ autoStart: false });

async function permissions(root: string) {
  const archive = path.join(root, "archive");
  await fs.mkdir(path.join(archive, "snapshot"), { recursive: true });
  for (const dir of [root, path.join(archive, "snapshot")]) {
    await fs.writeFile(path.join(dir, "pinned.json"), JSON.stringify({ pinned: { persona: "PRIVATE-PERSONA", botDefinition: "PRIVATE-DEFINITION" } }));
    await fs.writeFile(path.join(dir, "Bot_Status.md"), "PRIVATE-PERSONA");
    await fs.writeFile(path.join(dir, "World_Status.md"), "VISIBLE-WORLD");
    await fs.writeFile(path.join(dir, "world-state.json"), "PRIVATE-RAW-WORLD");
  }
  const host = {
    config: { ...cfg, webui: { ...cfg.webui, token: "test-admin" }, crossing: { ...cfg.crossing, invites: [{ code: "TEST-INVITE", enabled: true, name: "fixture" }] } },
    webuiDir: path.join(root, "webui"),
    files: { base: root, archiveDir: archive },
    crossingInfo: () => ({ location: null, visitors: [], worlds: [], serverEnabled: true }),
    getStructuredWorld: async () => ({ privateWorld: "PRIVATE-RAW-WORLD" }),
    getGrowth: async () => ({ skills: [], relationships: [] }),
  };
  const server = new WebUIServer(host as never);
  const visitors: VisitorStore = (server as any).visitors;
  const tokens: Record<string, string> = {};
  for (const preset of ["viewer", "operator", "player"] as const) {
    await visitors.create(preset, "test-password", preset);
    tokens[preset] = (await visitors.login(preset, "test-password"))!.token;
  }
  async function get(url: string, role = "viewer") {
    const req = { method: "GET", url, headers: role === "admin" ? { authorization: "Bearer test-admin" } : { "x-visitor-token": tokens[role] } };
    let status = 0;
    let body = "";
    const res = { writeHead(code: number) { status = code; }, end(data: string) { body = String(data); } };
    await (server as any).handle(req, res);
    return { status, body, json: JSON.parse(body) };
  }
  for (const role of ["viewer", "operator"]) {
    assert.equal((await get("/api/data/file?name=pinned.json", role)).status, 403);
    assert.equal((await get("/api/archive/file?folder=snapshot&file=pinned.json", role)).status, 403);
    const listing = await get("/api/archive", role);
    assert.ok(!listing.body.includes("pinned.json"));
    assert.ok(!listing.body.includes("world-state.json"));
    assert.ok(!(await get("/api/crossing", role)).body.includes("TEST-INVITE"));
    assert.equal((await get("/api/world/state", role)).status, 403);
    assert.equal((await get("/api/bot/growth", role)).status, 200);
  }
  assert.equal((await get("/api/archive/file?folder=snapshot&file=Bot_Status.md", "operator")).status, 403);
  assert.equal((await get("/api/archive/file?folder=snapshot&file=World_Status.md")).status, 200);
  assert.equal((await get("/api/bot/growth", "player")).status, 403);
  assert.equal((await get("/api/world/state", "admin")).status, 200);
  assert.ok((await get("/api/crossing", "admin")).body.includes("TEST-INVITE"));
  assert.equal((await get("/api/data/file?name=pinned.json", "admin")).status, 200);
  console.log("PASS: viewer/operator 文件权限、邀请码保密、结构化状态管理员限制、成长 notes 授权");
}

function shellIsolation() {
  const script = PAGE_HTML.match(/<script>([\s\S]*)<\/script>/)![1]!;
  new vm.Script(script); // 同时验证实际服务页面的整个脚本仍可解析。
  const start = script.indexOf("function phoneShellPane(");
  const end = script.indexOf("function jsonlPane(", start);
  const elements: any[] = [];
  const sandbox: any = {
    SCREEN_PLACEHOLDER: "data:image/png;base64,AA==", isVisitor: () => true,
    el(tag: string, attrs: unknown) {
      const node = { tag, attrs, appendChild() {}, srcdoc: "" };
      elements.push(node);
      return node;
    },
  };
  vm.runInNewContext(script.slice(start, end), sandbox);
  sandbox.phoneShellPane('<script>parent.localStorage.clear()</script><img src="https://invalid.test/pixel"><img src="{{screen}}">', {});
  const frame = elements.find((n) => n.tag === "iframe");
  assert.equal(frame.attrs.sandbox, "");
  assert.equal(frame.attrs.referrerpolicy, "no-referrer");
  assert.ok(frame.srcdoc.startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(frame.srcdoc.includes("default-src 'none'; script-src 'none'"));
  console.log("PASS: 实际 phoneShellPane 生成独立来源、禁脚本及外部资源的预览；页面 JavaScript 可解析");
}

async function dockerSafety(root: string) {
  for (const existing of [false, true]) {
    const log = path.join(root, `calls-${existing}.jsonl`);
    const cli = path.join(root, `docker-stub-${existing}`);
    await fs.writeFile(cli, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');\nif (args[0] === 'inspect') { console.log('false'); process.exit(${existing ? 0 : 1}); }\n`, { mode: 0o700 });
    const computer = new BotComputer({ ...cfg.apps.computer, docker: { ...cfg.apps.computer.docker, cli, pullPolicy: "never", mounts: [{ host: "/fixture/a", container: "/a", readonly: false }, { host: "/fixture/b", container: "/b", readonly: true }] } } as never, logger as never);
    const ready = await computer.ensureReady();
    const calls: string[][] = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(!calls.some((args) => args[0] === "rm"));
    if (existing) {
      assert.equal(ready.ok, false);
      assert.ok(ready.error?.includes("已保留"));
      assert.ok(!calls.some((args) => args[0] === "create"));
    } else {
      assert.equal(ready.ok, true);
      const create = calls.find((args) => args[0] === "create")!;
      assert.equal(create.filter((arg) => arg === "-v").length, 2);
      assert.ok(create.includes("/fixture/b:/b:ro"));
    }
  }
  console.log("PASS: 故障已有容器不删除/重建；每个挂载生成独立 -v 参数（仅本地 CLI stub）");
}

async function accounts(root: string) {
  const rows: WorldMessageRow[] = [];
  const sends: string[] = [];
  const bot = (selfId: string) => ({ platform: "fixture", selfId, isActive: true, sendMessage: async () => { sends.push(selfId); return ["sent-id"]; } });
  const ctx: any = {
    bots: [bot("a"), bot("b")], model: { extend() {} }, logger: () => logger, on() {},
    database: {
      async create(_table: string, row: any) { const stored = { id: rows.length + 1, selfId: "", ...row }; rows.push(stored); return stored; },
      async get(_table: string, query: Record<string, any>, opts: any) {
        let result = rows.filter((row: any) => Object.entries(query).every(([key, value]) => value && typeof value === "object" ? value.$in.includes(row[key]) : row[key] === value));
        if (opts?.sort) result = result.slice().sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return result.slice(0, opts?.limit);
      },
    },
  };
  const store = new MessageStore(ctx);
  const entry = { platform: "fixture", channelId: "private:peer", guildId: "", userId: "peer", username: "peer", self: false, messageId: "same-id", timestamp: new Date(), isDirect: true };
  await store.store({ ...entry, selfId: "a", content: "ONLY-A" });
  await store.store({ ...entry, selfId: "b", content: "ONLY-B" });
  assert.equal((await store.channelMessages("fixture", entry.channelId, 10, "b")).length, 1);
  assert.equal((await store.findByMessageId("fixture", entry.channelId, "same-id", "b"))!.content, "ONLY-B");
  assert.equal((await store.knownChannels()).length, 2);
  const renderer = { render: async (text: string) => ({ text }) };
  const focus = { focus: async () => {}, isFocused: () => false };
  const notify = new NotifyManager(path.join(root, "notify.json"), ["fixture:private:peer"], false);
  const messenger = new KoishiMessenger(ctx, store, renderer as never, {} as never, {} as never, {} as never, null, focus as never, notify, cfg.platformOps, { ...cfg.messaging, coldChannelMsgs: 0, selfCommands: false }, {} as never, new OwnSendTracker(), { display: async (key: string) => key } as never, () => null);
  assert.equal((await messenger.resolveKey("fixture@b:private:peer") as any).key, "fixture@b:private:peer");
  await messenger.send("fixture:private:peer", "ambiguous");
  assert.deepEqual(sends, []);
  await messenger.send("fixture@b:private:peer", "selected b");
  assert.deepEqual(sends, ["b"]);
  ctx.bots[1].isActive = false;
  await messenger.send("fixture@b:private:peer", "offline b");
  assert.deepEqual(sends, ["b"]); // 账号离线时不能改用 a 发出。
  assert.ok(notify.isNotifyChannel("fixture@b:private:peer"));
  const activity: string[] = [];
  const gateway = new Gateway(ctx, { ...cfg.messaging, externalSelfMessages: "off" }, cfg.platformOps, store, {} as never, renderer as never, focus as never, notify, { down: false }, {} as never, new OwnSendTracker(), { display: async (key: string) => key } as never, () => null, { notify() {}, selfMessage() {}, channelActivity: (key) => activity.push(key) });
  await (gateway as any).handle({ ...entry, selfId: "b", bot: ctx.bots[1], content: "incoming b" });
  assert.equal(rows.at(-1)!.selfId, "b");
  assert.equal(activity[0], "fixture@b:private:peer");
  ctx.bots = [bot("a")];
  rows.length = 0;
  await store.store({ ...entry, content: "LEGACY" });
  assert.equal((await store.channelMessages("fixture", entry.channelId, 10, "a"))[0]!.content, "LEGACY");
  await messenger.send("fixture:private:peer", "legacy single account");
  assert.deepEqual(sends, ["b", "a"]);
  const encoded = channelKey("fixture", "private:peer", "account:@/id");
  assert.equal(parseChannelKey(encoded).selfId, "account:@/id");
  console.log("PASS: 多账号消息/发送/事件隔离、歧义拒绝、离线不换号、旧单账号数据和通知配置兼容");
}

async function mcpMedia() {
  const items = new Map<number, any>();
  const ingested: string[] = [];
  const media: any = {
    async ingest(src: string, type: string, mime: string) {
      const id = items.size + 1;
      ingested.push(src);
      items.set(id, { ref: { id, type, mime, file: `/fixture/${id}` } });
      return id;
    },
    async get(id: number) { return items.get(id); },
  };
  const renderer = new MediaRenderer(media, { describe: async () => "" } as never, () => true, 4);
  const mcp = new McpApp({ name: "fixture" } as never, logger as never, { media, renderer });
  (mcp as any).transport = { request: async () => ({ content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "AA==" }, { type: "audio", mimeType: "audio/wav", data: "AQ==" }, { type: "resource_link", uri: "file:///private-not-read" }] }) };
  const result = await mcp.call("observe", {});
  assert.notEqual(typeof result, "string");
  assert.deepEqual((result as any).attachments.map((r: any) => r.type), ["image", "audio"]);
  assert.deepEqual((result as any).parts.filter((p: any) => p.kind === "media").map((p: any) => p.ref.id), [1, 2]);
  assert.equal(ingested.length, 2);
  assert.ok(ingested.every((src) => src.startsWith("data:")));
  console.log("PASS: MCP 图片/音频经媒体管道变成有序 RichText；resource URI 不读取本地文件");
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yibw-platform-"));
  try {
    await permissions(root);
    shellIsolation();
    await dockerSafety(root);
    await accounts(root);
    await mcpMedia();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
