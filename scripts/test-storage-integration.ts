import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { WorldKernel } from "../src/world/kernel.js";
import { withEndpointLock } from "../src/llm/lock.js";
import { parseRssItems } from "../src/apps/newsFeed.js";

async function main() {
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-storage-"));
try {
  const files = new WorldFiles(dir); await files.ensure();
  const kernel = await WorldKernel.open(dir, { now: () => 10 }); files.bindKernel(kernel);
  await kernel.initialize([
    { id: "room", kind: "place", name: "房间", location: null },
    { id: "bot", kind: "actor", name: "角色", controller: "bot", location: "room" },
  ]);
  await fs.writeFile(files.growthJournal, '{"test":"generation-one"}\n');
  const archive = await files.snapshot("integration");
  await assert.rejects(files.writeWorldStatus("把叙述写成世界事实"), /结构化/);
  await assert.rejects(files.writeBotStatus("重写身份"), /结构化/);
  await kernel.commit({ idempotencyKey: "rename", operations: [{ op: "update", id: "bot", changes: { name: "changed" } }] });
  await fs.writeFile(files.growthJournal, '{"test":"generation-two"}\n');
  await files.restoreFrom(path.join(files.archiveDir, archive));
  assert.equal(kernel.snapshot().entities.bot!.name, "角色");
  assert.match(await fs.readFile(files.growthJournal, "utf8"), /generation-one/);
  const legacy = path.join(dir, "legacy"); await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, "Bot_Status.md"), "原始角色资料");
  await fs.writeFile(path.join(legacy, "World_Status.md"), "原始世界资料");
  await files.restoreFrom(legacy);
  assert.deepEqual(kernel.snapshot().entities, {});
  assert.equal(await files.exists(files.growthJournal), false, "old archives must not retain growth from a different world");
  await Promise.all(Array.from({ length: 30 }, (_, i) => files.atomicWrite(files.pinned, JSON.stringify({ value: i }))));
  assert.equal(typeof JSON.parse(await fs.readFile(files.pinned, "utf8")).value, "number");
  assert.equal((await fs.readdir(dir)).some(name => name.endsWith(".tmp")), false);

  let unblock!: () => void, executed = false;
  const holding = withEndpointLock("https://unit-test.invalid", () => new Promise<void>(resolve => { unblock = resolve; }));
  await Promise.resolve();
  const abort = new AbortController();
  const waiting = withEndpointLock("https://unit-test.invalid", async () => { executed = true; }, abort.signal);
  abort.abort();
  let deadline: ReturnType<typeof setTimeout>;
  await Promise.race([assert.rejects(waiting, /aborted/), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("cancel stuck behind endpoint lock")), 300); })]);
  clearTimeout(deadline!); unblock(); await holding; await Promise.resolve(); assert.equal(executed, false);

  const feed = parseRssItems('<rss><item><title>旧报道</title><link>https://example.test/a</link><pubDate>Tue, 09 Sep 2025 12:00:00 GMT</pubDate></item><item><title>无日期</title></item></rss>');
  assert.equal(feed[0]!.publishedAt, "2025-09-09T12:00:00.000Z");
  assert.equal(feed[1]!.publishedAt, undefined, "retrieval time must not be substituted for publication time");
  console.log("PASS storage integration: structured archive/restore, stale-state removal, concurrent atomic writes, immediate lock cancellation, news dates");
} finally { await fs.rm(dir, { recursive: true, force: true }); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
