import { worldInputText } from "./world-input-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { WorldKernel } from "../src/world/kernel.js";
import type { WorldClock } from "../src/clock.js";
import type { ChatMessage, ChatResult, ChatToolDef } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

type Infer = (messages: ChatMessage[], tools: ChatToolDef[]) => Promise<ChatResult>;
const call = (id: string, description: string, expectedAt = 100): ToolCallRecord => ({ id, role: "agent", name: "act", arguments: { description }, issuedAt: 100, expectedAt });
/** Keep v0.3's exact identity algorithm to catch accidental execution during replay. */
const oldFingerprint = (request: ToolCallRecord): string => createHash("sha256").update(JSON.stringify({ actorId: "bot", arguments: request.arguments, expectedAt: request.expectedAt })).digest("hex");
const result = (data: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "new-prose", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(data) } }] });

async function fixture(root: string, name: string) {
  const files = new WorldFiles(path.join(root, name)); await files.ensure();
  const originals = new Map([
    [files.botDef, "AUTHOR_BOT：小澈是一名大学生。"], [files.worldDef, "AUTHOR_WORLD：校园里有一家餐厅。"],
    [files.botStatus, "LEGACY_BOT：你站在柜台前，正在看菜单。"], [files.worldStatus, "LEGACY_WORLD：店员等小澈点餐。后厨有 WORLD_ONLY_SECRET。"],
    [files.news, '{"t":99,"text":"保留旧世界新闻"}\n'], [files.facts, '{"t":100,"text":"保留旧记忆"}\n'],
    [files.stream, '{"kind":"event","event":{"id":"ev_1","source":"world","content":"保留原始经历","worldTime":100}}\n'],
    [files.pinned, '{"pinned":{"persona":"保留旧置顶原文"},"counters":{"event":1,"tool":0}}'], [files.meta, '{"botName":"小澈"}'],
  ]);
  await Promise.all([...originals].map(([file, text]) => fs.writeFile(file, text)));
  let requests = 0;
  let infer: Infer = async () => { throw new Error("Migration, recovery and receipt replay must not infer"); };
  const instances: NarrativeWorld[] = [];
  const create = (at = 110) => {
    const freshFiles = new WorldFiles(files.base), clock = { now: () => at, realMsUntil: () => 0 } as unknown as WorldClock;
    const runtime = new NarrativeWorld(freshFiles, clock, async (messages, tools) => { requests++; return infer(messages, tools); });
    instances.push(runtime); return { files: freshFiles, runtime };
  };
  return { files, originals, create, requests: () => requests, setInfer(next: Infer) { infer = next; }, async shutdown() { await Promise.all(instances.map(runtime => runtime.shutdown())); } };
}
async function assertBackup(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const backups = (await fs.readdir(f.files.archiveDir)).filter(name => name.includes("before-narrative-migration"));
  assert.equal(backups.length, 1, "migration is backed up once, not again on every restart");
  const directory = path.join(f.files.archiveDir, backups[0]!);
  for (const [file, text] of f.originals) {
    if (file === f.files.botDef || file === f.files.worldDef) assert.equal(await fs.readFile(file, "utf8"), text, "authored definitions remain untouched");
    else assert.equal(await fs.readFile(path.join(directory, path.basename(file)), "utf8"), text, `migration backup must preserve ${path.basename(file)}`);
    if (![f.files.botStatus, f.files.worldStatus].includes(file)) assert.equal(await fs.readFile(file, "utf8"), text, `migration must not rewrite ${path.basename(file)}`);
  }
}
async function structuredMigration(root: string): Promise<void> {
  const f = await fixture(root, "v0.3");
  try {
    const legacy = await WorldKernel.open(f.files.base, { now: () => 123 });
    await legacy.initialize([
      { id: "room", kind: "place", name: "校园餐厅", location: null }, { id: "kitchen", kind: "place", name: "后厨", location: null },
      { id: "bot", kind: "actor", name: "小澈", controller: "bot", location: "room", attributes: { hunger: { value: 7, visibility: "owner" }, latent: { value: "BOT_HIDDEN_SECRET", visibility: "hidden" } } },
      { id: "waiter", kind: "actor", name: "店员", controller: "world", location: "room", attributes: { motive: { value: "NPC_PRIVATE_SECRET", visibility: "owner" } } },
      { id: "safe", kind: "object", name: "隐藏保险箱", location: "kitchen", attributes: { code: { value: "REMOTE_SECRET", visibility: "hidden" } } },
      { id: "old-visitor", kind: "actor", name: "离开的访客", controller: "player", location: null },
    ]);
    await legacy.commit({ idempotencyKey: "dialogue", operations: [{ op: "say", actorId: "waiter", text: "今天想吃什么？" }] });
    const completed = call("tc_completed", "走到餐厅柜台前"), pending = call("tc_pending", "读完菜单后点面", 999);
    await legacy.commit({ idempotencyKey: "old-start", operations: [{ op: "action.start", action: { id: `bot:${completed.id}`, actorId: "bot", intent: completed.arguments.description as string, expectedEnd: 123, requestFingerprint: oldFingerprint(completed) } }] });
    await legacy.commit({ idempotencyKey: "old-end", operations: [{ op: "action.finish", id: `bot:${completed.id}`, status: "completed" }] });
    await legacy.commit({ idempotencyKey: "old-pending", operations: [{ op: "action.start", action: { id: `bot:${pending.id}`, actorId: "bot", intent: pending.arguments.description as string, expectedEnd: pending.expectedAt, requestFingerprint: oldFingerprint(pending) } }] });
    await fs.appendFile(f.files.worldJournal, '{"incomplete_legacy_tail":');
    const originalJournal = await fs.readFile(f.files.worldJournal, "utf8"); f.originals.set(f.files.worldJournal, originalJournal);
    const current = f.create(); await current.runtime.ensure();
    const store = await current.runtime.store(), snapshot = store.snapshot();
    assert.equal(snapshot.mode, "narrative"); assert.equal(snapshot.initialized, true);
    assert.equal(snapshot.effectiveAt, 123, "clock.json lag cannot rewind imported world time");
    assert.equal(snapshot.actions[`bot:${completed.id}`]!.status, "completed");
    assert.equal(snapshot.actions[`bot:${completed.id}`]!.requestFingerprint, oldFingerprint(completed));
    assert.equal(snapshot.actions[`bot:${pending.id}`]!.status, "failed", "pending work becomes a durable recovery failure, never a fictional success");
    assert.equal(snapshot.actions[`bot:${pending.id}`]!.finishedAt, 123); assert.equal(snapshot.actors["old-visitor"]!.present, false);
    assert.equal(f.requests(), 0, "neither migration nor interrupted-action recovery invokes a model");
    for (const text of [/今天想吃什么/, /读完菜单后点面/, /BOT_HIDDEN_SECRET/, /NPC_PRIVATE_SECRET/, /REMOTE_SECRET/]) assert.match(snapshot.worldState, text);
    const recovered = await current.runtime.peek();
    assert.match(recovered.narrative, /读完菜单后点面/); assert.match(recovered.narrative, /没有确认完成/);
    assert.doesNotMatch(JSON.stringify(recovered), /BOT_HIDDEN_SECRET|NPC_PRIVATE_SECRET|REMOTE_SECRET/);
    assert.doesNotMatch(await current.files.readWorldStatus(true), /BOT_HIDDEN_SECRET|NPC_PRIVATE_SECRET|REMOTE_SECRET/);
    const beforeReplays = await fs.readFile(f.files.narrativeJournal, "utf8"), receipts: any[] = [];
    assert.equal(await current.runtime.act("bot", completed, text => receipts.push(JSON.parse(text))), true);
    assert.equal(receipts.at(-1).action.status, "completed");
    assert.equal(receipts.at(-1).scene, undefined, "an imported terminal receipt must not attach another action's recovery scene");
    assert.equal(receipts.at(-1).observation.scene, undefined, "current observation remains available without relabeling another action's scene");
    assert.equal(await current.runtime.act("bot", pending, text => receipts.push(JSON.parse(text))), false);
    assert.equal(receipts.at(-1).action.status, "failed"); assert.match(receipts.at(-1).observation.narrative, /没有确认完成/);
    await assert.rejects(current.runtime.act("bot", { ...completed, arguments: { description: "另一个操作" } }, () => { throw Error("conflicting call cannot deliver"); }), /另一项请求|不同操作/);
    assert.equal(f.requests(), 0); assert.equal(await fs.readFile(f.files.narrativeJournal, "utf8"), beforeReplays, "old terminal replay must not append another action");
    assert.doesNotMatch(JSON.stringify(receipts), /BOT_HIDDEN_SECRET|NPC_PRIVATE_SECRET|REMOTE_SECRET/); await assertBackup(f);
    f.setInfer(async (messages, tools) => {
      assert.equal(tools[0]!.function.name, "resolve_world");
      const body = JSON.parse([...messages].reverse().find(message => message.role === "user")!.content as string);
      assert.equal(body.timeAuthority.tu, 110, "the current clock remains authoritative; importing a future record cannot silently move the present");
      assert.equal(body.timeAuthority.tu, 110); assert.equal(Object.hasOwn(body, "stateUpdatedAt"), false); assert.equal(body.stateAsOf.tu, 123);
      assert.equal(body.stateAheadOfClock, true); assert.equal(body.elapsedWorldSeconds, 0, "a future imported snapshot cannot create negative elapsed time or an invented advance");
      assert.match(worldInputText(body), /今天想吃什么/); assert.match(worldInputText(body), /NPC_PRIVATE_SECRET/, "World receives omniscient state while Bot never does");
      return result({ perceptions: [] });
    });
    await current.runtime.evolve("程序时钟尚未赶上迁移记录，没有可结算的正向流逝。"); assert.equal(f.requests(), 1);
    assert.deepEqual(store.snapshot(), snapshot, "an idle pass with an ahead-of-clock record cannot rewind or rewrite the imported snapshot");
    assert.equal(await fs.readFile(f.files.narrativeJournal, "utf8"), beforeReplays, "read-time temporal diagnostics are not a migration rewrite");
    await current.runtime.shutdown();
    const aligned = f.create(124); await aligned.runtime.ensure();
    f.setInfer(async messages => {
      const body = JSON.parse([...messages].reverse().find(message => message.role === "user")!.content as string);
      assert.equal(body.timeAuthority.tu, 124); assert.equal(body.stateAsOf.tu, 123); assert.equal(body.elapsedWorldSeconds, 1);
      assert.equal(body.stateAheadOfClock, undefined);
      return result({ worldState: (await aligned.runtime.store()).snapshot().worldState + "\n现在店员告知今日面食需要等十分钟。", externalChanges: [{ id: "clerk", description: "店员补充说明今日面食的等待时间。" }], perceptions: [{ actorId: "bot", text: "店员补充道：“面要等十分钟，你可以先看看其他的。”", changeIds: ["clerk"] }] });
    });
    await aligned.runtime.evolve("店员继续说明等待时间。"); assert.equal(f.requests(), 2);
    const committed = (await aligned.runtime.store()).snapshot(), perception = await aligned.runtime.peek(); await aligned.runtime.shutdown();
    assert.equal(committed.effectiveAt, 124); assert.deepEqual(committed.actions, snapshot.actions, "new progress leaves imported action dates intact");
    f.setInfer(async () => { throw Error("Restart must reuse current persisted prose"); });
    const restarted = f.create(125); await restarted.runtime.ensure();
    assert.deepEqual((await restarted.runtime.store()).snapshot(), committed); assert.deepEqual(await restarted.runtime.peek(), perception);
    assert.match(await restarted.files.readWorldStatus(), /现在店员告知今日面食需要等十分钟/); assert.equal(await restarted.files.readBotStatus(), snapshot.actors.bot!.state, "hearing an NPC does not grant heartbeat permission to rewrite actor state");
    assert.equal(f.requests(), 2, "restart cannot regenerate or remigrate the world");
    assert.equal(await fs.readFile(f.files.worldJournal, "utf8"), originalJournal); await assertBackup(f);
    console.log("PASS v0.3 runtime migration preserves private facts, dialogue, old action idempotency, interrupted failures, visitor absence and latest prose across restart");
  } finally { await f.shutdown(); }
}
async function markdownMigration(root: string): Promise<void> {
  const f = await fixture(root, "v0.2.1");
  try {
    const current = f.create(); await current.runtime.ensure(); const snapshot = (await current.runtime.store()).snapshot();
    assert.equal(f.requests(), 0, "existing Markdown state is imported without a generation step");
    assert.equal(snapshot.worldState, f.originals.get(f.files.worldStatus)); assert.equal(snapshot.actors.bot!.state, f.originals.get(f.files.botStatus));
    assert.equal(snapshot.actors.bot!.name, "小澈"); assert.equal((await current.runtime.peek()).narrative, f.originals.get(f.files.botStatus));
    assert.doesNotMatch(JSON.stringify(await current.runtime.peek()), /WORLD_ONLY_SECRET/); await assertBackup(f); await current.runtime.shutdown();
    const restarted = f.create(); await restarted.runtime.ensure();
    assert.deepEqual((await restarted.runtime.store()).snapshot(), snapshot); assert.equal(f.requests(), 0); await assertBackup(f);
    console.log("PASS v0.2.1 Markdown imports verbatim without inference, retains author/context files and never exposes omniscient secrets as Bot perception");
  } finally { await f.shutdown(); }
}
async function damagedSource(root: string): Promise<void> {
  const f = await fixture(root, "damaged");
  try {
    await fs.writeFile(f.files.worldJournal, '{"broken":"complete journal row"}\n'); const current = f.create();
    await assert.rejects(current.runtime.ensure(), /CORRUPT_JOURNAL|Journal schema|journal/i);
    assert.equal(f.requests(), 0, "damaged structured state must not silently fall back to model initialization from older Markdown");
    assert.equal(await fs.readFile(f.files.worldJournal, "utf8"), '{"broken":"complete journal row"}\n');
    assert.equal(await current.files.exists(current.files.narrativeJournal), false);
    assert.equal(await fs.readFile(f.files.botStatus, "utf8"), f.originals.get(f.files.botStatus));
    assert.equal(await fs.readFile(f.files.worldStatus, "utf8"), f.originals.get(f.files.worldStatus));
    console.log("PASS corrupted source journal refuses migration and preserves originals without invoking a model");
  } finally { await f.shutdown(); }
}
async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-migration-runtime-"));
  try { await structuredMigration(root); await markdownMigration(root); await damagedSource(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
