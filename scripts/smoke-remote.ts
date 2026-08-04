/**
 * 远程桌面冒烟测试：对着 scripts/test-vnc-server.mjs 起的最小 VNC 服务器，
 * 验证 RfbSession 的连接 / 截屏 PNG / 鼠标 / 键盘 / 剪贴板粘贴链路。
 *
 * 用法（先起服务器）：
 *   node scripts/test-vnc-server.mjs &
 *   esbuild scripts/smoke-remote.ts --bundle --platform=node --format=cjs --outfile=/tmp/opencode/smoke-remote.cjs
 *   SMOKE_EVENTS=<events.jsonl> node /tmp/opencode/smoke-remote.cjs
 */

/* eslint-disable no-console */
import fs from "node:fs";
import { RfbSession, MOUSE } from "../src/remote/rfb.js";

const logger = {
  info: (...a: unknown[]) => console.log("[info]", ...a),
  warn: (...a: unknown[]) => console.log("[warn]", ...a),
  error: (...a: unknown[]) => console.log("[error]", ...a),
} as never;

let failed = 0;
function check(cond: boolean, name: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

async function main() {
  const eventsFile = process.env.SMOKE_EVENTS;
  if (!eventsFile) throw new Error("SMOKE_EVENTS 未设置");
  const port = Number(process.env.SMOKE_PORT ?? 5911);

  const session = new RfbSession(
    { host: "127.0.0.1", port, password: "tetris", connectTimeoutMs: 5000 },
    logger,
  );

  await session.connect();
  check(session.connected, "connect");
  check(session.width === 800 && session.height === 600, "screen size 800x600");

  // ---- 截屏 ----
  const s1 = await session.snapshot(400);
  check(isPng(s1.png), "snapshot(400) returns PNG");
  check(s1.width === 400 && s1.height === 300, "downscale to 400x300");
  const s2 = await session.snapshot(200);
  check(s2.width === 200 && s2.height === 150, "downscale to 200x150");

  // ---- 鼠标 ----
  session.pointer(10, 20, 0);
  await sleep(40);
  session.pointer(30, 40, MOUSE.LEFT);
  await sleep(40);
  session.pointer(30, 40, 0);
  await sleep(40);
  session.pointer(30, 40, MOUSE.RIGHT);
  await sleep(40);
  session.pointer(30, 40, 0);
  await sleep(40);
  session.pointer(50, 60, MOUSE.WHEEL_DOWN);
  await sleep(40);
  session.pointer(50, 60, 0);
  await sleep(80);

  // ---- 键盘 ----
  await session.tapKey(0xff0d); // enter
  await session.typeText("hi there");
  await session.typeText("中文");
  await session.keyCombo(["ctrl", "c"]);

  session.disconnect();
  await sleep(200);

  // ---- 校验服务器记录的事件 ----
  const lines = fs
    .readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const events = lines.map((l) => JSON.parse(l));
  check(events.length > 0, "server recorded events");

  const pointers = events.filter((e) => e.kind === "pointer");
  const keys = events.filter((e) => e.kind === "key");
  const cuts = events.filter((e) => e.kind === "cuttext");

  check(pointers.some((e) => e.buttons === 0 && e.x === 10 && e.y === 20), "pointer move (0,10,20)");
  check(pointers.some((e) => e.buttons === 1 && e.x === 30 && e.y === 40), "left press");
  check(pointers.some((e) => e.buttons === 0 && e.x === 30 && e.y === 40), "left release");
  check(pointers.some((e) => e.buttons === 4 && e.x === 30 && e.y === 40), "right press");
  check(pointers.some((e) => e.buttons === 16 && e.x === 50 && e.y === 60), "wheel down");
  check(keys.some((e) => e.keysym === 0xff0d && e.down === 1), "enter down");
  check(keys.some((e) => e.keysym === 0x68 && e.down === 1), "h down (typeText)");
  check(keys.some((e) => e.keysym === 0x20 && e.down === 1), "space down (typeText)");
  check(keys.some((e) => e.keysym === 0xffe3 && e.down === 1), "ctrl down (paste & combo)");
  check(keys.some((e) => e.keysym === 0x76 && e.down === 1), "v down (paste)");
  check(keys.some((e) => e.keysym === 0x63 && e.down === 1), "c down (combo)");
  check(cuts.some((e) => e.text === "中文"), "cuttext 中文 pasted");

  console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

function isPng(buf: Buffer): boolean {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!buf || buf.length < 40) return false;
  for (let i = 0; i < 8; i++) if (buf[i] !== magic[i]) return false;
  // IHDR width/height are big-endian at fixed offsets; the PNG must at least contain the IDAT that follows
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 && buf.includes(Buffer.from("IDAT"));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err);
  process.exit(1);
});
