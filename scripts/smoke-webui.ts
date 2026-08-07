/**
 * WebUI 冒烟测试：
 * - 用 @koishijs/plugin-database-memory + @koishijs/plugin-mock 起一个最小 Koishi App，
 *   挂载本插件（webui.enabled=true，随机端口 + 令牌）；
 * - 验证 /api/health、/api/overview、静态页面、SSE 与鉴权；
 * - 验证 /api/prompts 覆盖会持久化到 <webuiDir>/prompts.json；
 * - 验证 /api/config POST 触发插件作用域热重载（同端口恢复、配置生效）；
 * - 验证非法配置会被 400 拒绝。
 *
 * 用法：
 *   esbuild scripts/smoke-webui.ts --bundle --platform=node --format=cjs --alias:koishi=$PWD/node_modules/koishi/lib/index.cjs --outfile=/tmp/opencode/smoke-webui.cjs
 *   node /tmp/opencode/smoke-webui.cjs
 */

/* eslint-disable no-console */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "koishi";
import * as memoryMod from "@koishijs/plugin-database-memory";
import { Config } from "../src/config.js";
import { apply } from "../src/index.js";
import { debug } from "../src/webui/debug.js";

// esbuild 的 CJS 互操作会让 default 指向整个模块对象：逐层剥到类本身
const memory = (memoryMod as unknown as { default?: { default?: unknown } }).default?.default;
if (typeof memory !== "function") {
  throw new Error("无法解析 database-memory 导出");
}

let failed = 0;
function check(cond: boolean, name: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TOKEN = "smoke-token";
const PORT = 20000 + Math.floor(Math.random() * 9000);

async function waitFor(ok: () => Promise<boolean>, timeout = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await ok()) return true;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  return false;
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yibw-webui-"));
  const baseDir = path.join(tmpRoot, "app");

  const app = new Context();
  app.baseDir = baseDir;
  app.plugin(memory);
  const config = Config({
    basePath: "world",
    autoStart: false,
    webui: { enabled: true, host: "127.0.0.1", port: PORT, token: TOKEN },
  });
  app.plugin(apply, config);
  await app.start();

  const base = `http://127.0.0.1:${PORT}`;
  const health = `${base}/api/health`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  check(
    await waitFor(async () => (await fetch(health, { headers: auth })).status === 200),
    "WebUI 已监听并响应 /api/health",
  );

  // ---- 静态页面（无需鉴权） ----
  const pageRes = await fetch(base + "/");
  const page = await pageRes.text();
  check(pageRes.status === 200 && page.includes("YesImBot World"), "静态页面可访问");

  // ---- 鉴权 ----
  const noToken = await fetch(health);
  check(noToken.status === 401, "无令牌访问 /api/* 返回 401");
  const queryToken = await fetch(`${health}?token=${TOKEN}`);
  check(queryToken.status === 200, "?token= 查询参数鉴权通过");
  const wrongToken = await fetch(`${base}/api/overview`, { headers: { Authorization: "Bearer wrong" } });
  check(wrongToken.status === 401, "错误令牌返回 401");

  // ---- 概览 ----
  const overview = (await (await fetch(`${base}/api/overview`, { headers: auth })).json()) as {
    version: string;
    initialized: boolean;
    worldRunning: boolean;
    worldQueue: number;
    galleryCounts: unknown[];
    news: unknown[];
  };
  check(overview.version === "0.1.0", "overview 带版本号");
  check(overview.initialized === false, "未初始化状态正确");
  check(overview.worldRunning === false && overview.worldQueue === 0, "世界未运行、队列为 0");
  check(Array.isArray(overview.galleryCounts) && Array.isArray(overview.news), "overview 含相册/新闻字段");
  const ovAddresses = (overview as { addresses?: { label: string; url: string }[] }).addresses;
  check(
    Array.isArray(ovAddresses) && ovAddresses.some((a) => a.url.includes(`:${PORT}/`)),
    "overview 含访问地址列表（访问与安全）",
  );

  // ---- 设备（电脑 + 手机窥视） ----
  const devices = (await (await fetch(`${base}/api/devices`, { headers: auth })).json()) as {
    computer: { mode: string; on: string | null; docker: unknown; remote: unknown };
    phone: { down: boolean; appOpen: string | null; chatOpen: boolean; chatAppName: string };
  };
  check(devices.computer.mode === "off", "设备：电脑默认 off 模式");
  check(devices.phone.down === false && typeof devices.phone.chatAppName === "string", "设备：手机状态完整");
  const scrRes = await fetch(`${base}/api/computer/screen`, { headers: auth });
  check(scrRes.status === 503, "窥屏：off 模式返回 503（优雅降级）");
  const actRes = await fetch(`${base}/api/computer/action`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ action: "start" }),
  });
  const actJson = (await actRes.json()) as { ok?: boolean; text?: string };
  check(actRes.status === 200 && typeof actJson.text === "string", "电脑管理：非 docker 模式动作优雅返回");
  const badAct = await fetch(`${base}/api/computer/action`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ action: "rm -rf /" }),
  });
  check(badAct.status === 400, "电脑管理：非法 action 返回 400");
  const execRes = await fetch(`${base}/api/computer/exec`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ command: "echo hi" }),
  });
  const execJson = (await execRes.json()) as { output?: string };
  check(execRes.status === 200 && typeof execJson.output === "string", "电脑终端：非 docker 模式优雅返回");
  const emptyExec = await fetch(`${base}/api/computer/exec`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ command: "  " }),
  });
  check(emptyExec.status === 400, "电脑终端：空命令返回 400");

  // ---- SSE ----
  const sseRes = await fetch(`${base}/api/events?token=${TOKEN}`);
  const ctype = sseRes.headers.get("content-type") ?? "";
  check(sseRes.status === 200 && ctype.startsWith("text/event-stream"), "SSE 端点返回 event-stream");
  // 验证调试事件经 SSE 实时推送（debug.enabled 由服务器置位，事件能到达浏览器）
  if (sseRes.body) {
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let sawDebug = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !sawDebug) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk.includes('"channel":"debug"')) sawDebug = true;
      if (!sawDebug) {
        // 推送一条调试事件，验证它能经 SSE 到达
        debug.emit("op", "smoke·SSE 事件", { via: "smoke-test" });
      }
    }
    check(sawDebug, "调试事件经 SSE 实时推送到浏览器");
    reader.releaseLock();
  }
  await sseRes.body?.cancel();

  // ---- 提示词覆盖持久化 ----
  const promptsBody = { overrides: { bot: { constitution: "你是冒烟测试的 Bot。" }, world: {} } };
  const promptsRes = await fetch(`${base}/api/prompts`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(promptsBody),
  });
  check(promptsRes.status === 200, "POST /api/prompts 接受覆盖");
  const ov = (await (await fetch(`${base}/api/overview`, { headers: auth })).json()) as { webuiDir: string };
  const savedPath = path.join(ov.webuiDir, "prompts.json");
  const saved = JSON.parse(await fs.readFile(savedPath, "utf8")) as {
    bot?: Record<string, string>;
  };
  check(saved.bot?.constitution === "你是冒烟测试的 Bot。", "覆盖已持久化到 prompts.json");

  // ---- 配置热重载（插件作用域重启，同端口恢复） ----
  const current = (await (await fetch(`${base}/api/config`, { headers: auth })).json()) as { value: Record<string, unknown> };
  const next = { ...current.value, serializeSameEndpoint: true };
  const applyRes = await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ config: next }),
  });
  const applyJson = (await applyRes.json()) as { message?: string; port?: number };
  check(applyRes.status === 200 && !!applyJson.message, "POST /api/config 返回应用成功");
  check(applyJson.port === PORT, "返回的是新端口");
  check(
    await waitFor(async () => {
      try {
        const res = await fetch(`${base}/api/config`, { headers: auth });
        if (res.status !== 200) return false;
        const data = (await res.json()) as { value: { serializeSameEndpoint: boolean } };
        return data.value.serializeSameEndpoint === true;
      } catch {
        return false;
      }
    }, 15000),
    "热重载后同端口恢复且新配置生效",
  );

  // ---- 非法配置拒绝（枚举外取值） ----
  const badRes = await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ config: { bot: { mode: "invalid-mode" } } }),
  });
  check(badRes.status === 400, "非法配置返回 400");

  await app.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });

  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
