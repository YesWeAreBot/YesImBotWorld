/**
 * 本次修复的冒烟测试：
 * - WorldFiles.snapshot / reset：归档成快照文件夹 + 固定小事记在重置后保留；
 * - WorldFiles.restoreFrom：快照回档覆盖运行时状态；
 * - browserCacheKey：同一网址/搜索词的缓存键归一化。
 *
 * 用法：
 *   esbuild scripts/smoke-archives.ts --bundle --platform=node --format=cjs --outfile=/tmp/opencode/smoke-archives.cjs
 *   node /tmp/opencode/smoke-archives.cjs
 */

/* eslint-disable no-console */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { browserCacheKey } from "../src/apps/browser.js";

let failed = 0;
function check(cond: boolean, name: string) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

async function main() {
  // ---- browserCacheKey ----
  check(browserCacheKey({ search: "天气" }) === "search://天气", "搜索词缓存键");
  check(
    browserCacheKey({ url: "https://Example.COM/news/" }) === browserCacheKey({ url: "http://example.com/news" }),
    "http/https 与尾斜杠归一化为同一键",
  );
  check(browserCacheKey({ url: "example.com/page?x=1" }).startsWith("url://"), "裸域名也生成键");

  // ---- WorldFiles ----
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "yibw-smoke-"));
  const files = new WorldFiles(tmp);
  await files.ensure();

  await files.writeBotStatus("bot-status-1");
  await files.writeWorldStatus("world-status-1");
  await files.appendNews({ t: 1, clock: "T=1", content: "新闻" });
  await files.appendFacts({ t: 1, clock: "T=1", content: "普通小事" });
  await files.appendFacts({ t: 2, clock: "T=2", content: "固定小事", pinned: true });
  await files.atomicWrite(files.clock, JSON.stringify({ accumulatedTU: 5 }));
  await fs.mkdir(files.notesDir, { recursive: true });
  await fs.writeFile(path.join(files.notesDir, "笔记.md"), "note");

  // 手动存档快照
  const snapName = await files.snapshot("测试存档");
  const snapDir = path.join(files.archiveDir, snapName);
  const has = (p: string) => fs.access(p).then(() => true, () => false);
  check(await has(snapDir), "快照文件夹已创建");
  check(await has(path.join(snapDir, "facts.jsonl")), "快照包含 facts.jsonl");
  check(await has(path.join(snapDir, "Bot_Status.md")), "快照包含 Bot_Status.md");
  check(await has(path.join(snapDir, "clock.json")), "快照包含 clock.json");
  check(await has(path.join(snapDir, "manifest.json")), "快照包含 manifest.json");
  check(await has(path.join(snapDir, "Notes", "笔记.md")), "快照包含记事本");

  // 修改当前状态后再回档
  await files.writeBotStatus("bot-status-2");
  await files.restoreFrom(snapDir);
  check((await files.readBotStatus()) === "bot-status-1", "回档后 Bot_Status 恢复");
  const restoredFacts = await files.readFactsAll();
  check(restoredFacts.length === 2 && restoredFacts[1]!.pinned === true, "回档后 facts 恢复且带 pinned 标记");

  // 重置：固定小事记保留，其余清空，旧状态进快照
  const dirsBefore = (await fs.readdir(files.archiveDir)).length;
  await files.reset();
  check((await files.readBotStatus()) === "", "重置后 Bot_Status 清空");
  const leftFacts = await files.readFactsAll();
  check(leftFacts.length === 1 && leftFacts[0]!.content === "固定小事" && leftFacts[0]!.pinned === true, "重置后仅保留固定小事");
  check((await fs.readdir(files.archiveDir)).length === dirsBefore + 1, "重置产生新快照文件夹");
  check(!(await has(files.notesDir)), "重置后记事本目录清空");

  // 重置后再创世不会清掉固定小事（initWorld 只在文件不存在时写空文件）
  check(await has(files.facts), "重置后 facts.jsonl 存在（含固定条目）");

  await fs.rm(tmp, { recursive: true, force: true });
}

main().then(() => {
  if (failed) {
    console.log(`\n${failed} 项失败`);
    process.exit(1);
  }
  console.log("\n全部通过");
});
