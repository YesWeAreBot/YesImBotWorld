import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { WorldFiles } from "../src/files.js";
import { WorldKernel } from "../src/world/kernel.js";
import type { NarrativeCommit } from "../src/world/narrative-types.js";

const seed: NarrativeCommit = { idempotencyKey: "init", source: "test", initialized: true,
  worldState: "小澈在餐厅。店员刚问想吃什么。柜台内藏着 PRIVATE_SECRET。",
  actors: { bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "小澈有些饿，尚未点餐。", perception: "店员正在等你回答。" } } };
const code = (expected: string) => (error: unknown) => !!error && (error as { code?: string }).code === expected;

async function main(): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-storage-"));
  const realOpen = fs.open;
  try {
    const files = new WorldFiles(path.join(base, "atomic")); await files.ensure();
    let now = 10, mirrorErrors = 0, subscriberErrors = 0;
    const store = await NarrativeStore.open(files.base, { now: () => now, onMirrorError: () => { mirrorErrors++; }, onSubscriberError: () => { subscriberErrors++; } });
    files.bindNarrativeStore(store);
    assert.equal(await files.isInitialized(), false);
    await store.migrateLegacy(files);
    assert.equal(store.snapshot().sequence, 0, "new worlds remain uninitialized without an inference");
    const events: unknown[] = [];
    store.subscribe(event => { events.push(event); (event.payload as any).tampered = true; throw new Error("listener failure"); });
    store.subscribe(event => { assert.equal((event.payload as any).tampered, undefined); });
    const initialized = await store.commit(seed);
    assert.equal(initialized.sequence, 1); assert.equal(store.snapshot().initialized, true);
    assert.equal(subscriberErrors, 1);
    assert.equal(await files.readBotStatus(), seed.actors!.bot!.state);
    assert.equal(await files.readWorldStatus(), seed.worldState);
    assert.equal(await files.readWorldStatus(true), seed.actors!.bot!.perception);
    assert.doesNotMatch(await files.readWorldStatus(true), /PRIVATE_SECRET/);
    await assert.rejects(files.writeWorldStatus("overwrite"), /事务/);
    const update: NarrativeCommit = { idempotencyKey: "meal", expectedSequence: 1, source: "act", actorId: "bot", actionId: "bot:meal",
      worldState: "小澈点了一碗面，店员开始下单。柜台内藏着 PRIVATE_SECRET。",
      actors: { bot: { ...store.snapshot().actors.bot!, state: "小澈已经点餐，等待上菜。" } },
      perceptions: [{ actorId: "bot", text: "店员点点头：“一碗面，马上就好。”" }] };
    now = 11;
    const committed = await store.commit(update);
    assert.equal(committed.perceptions.length, 1);
    assert.deepEqual(committed.perceptions[0]!.sourceEventIds, [committed.perceptions[0]!.eventId]);
    assert.equal(store.snapshot().actors.bot!.perception, update.perceptions![0]!.text);
    const journal = await fs.readFile(files.narrativeJournal, "utf8");
    assert.equal((await store.commit(update)).duplicate, true);
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), journal);
    await assert.rejects(store.commit({ ...update, worldState: "different" }), code("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(store.commit({ idempotencyKey: "stale", source: "test", expectedSequence: 1, worldState: "stale" }), code("VERSION_CONFLICT"));
    const all = store.readPerceptions("bot", 0, "bot:meal");
    all[0]!.text = "tampered";
    assert.equal(store.readPerceptions("bot", 0, "bot:meal")[0]!.text, committed.perceptions[0]!.text);
    assert.deepEqual(store.readPerceptions("other"), []);
    assert.equal(await store.exportJournal(), journal);

    const reopened = await NarrativeStore.open(files.base, { now: () => now });
    assert.deepEqual(reopened.snapshot(), store.snapshot());
    assert.deepEqual(reopened.findCommit("meal")!.perceptions, committed.perceptions);
    assert.deepEqual(reopened.readPerceptions("bot"), committed.perceptions);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(store.commit({ idempotencyKey: "aborted", source: "test", worldState: "wrong" }, { signal: abort.signal }), code("CANCELLED"));
    let boundaryChecks = 0;
    await assert.rejects(store.commit({ idempotencyKey: "revoked", source: "test", worldState: "wrong" }, { beforeCommit: () => ++boundaryChecks < 2 }), code("CANCELLED"));
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), journal);
    const raced = await Promise.allSettled(["one", "two"].map(id => store.commit({ idempotencyKey: id, source: "test", expectedSequence: 2, worldState: id })));
    assert.equal(raced.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(store.snapshot().sequence, 3);

    // A failed display mirror cannot turn an already committed action into a failure.
    await fs.rm(files.worldStatus);
    await fs.mkdir(files.worldStatus);
    const mirrored = await store.commit({ idempotencyKey: "mirror-failed", source: "test", worldState: "世界更新已提交。" });
    assert.equal(mirrored.sequence, 4); assert.equal(mirrorErrors, 1);
    assert.equal(await files.readWorldStatus(), "世界更新已提交。");
    await fs.rm(files.worldStatus, { recursive: true });
    await store.reload();
    assert.equal(await fs.readFile(files.worldStatus, "utf8"), "世界更新已提交。");

    // An fsync failure leaves an uncertain append: publish nothing and fence subsequent writes.
    const beforeFault = store.snapshot(), eventCount = events.length;
    (fs as any).open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === files.narrativeJournal && args[1] === "a") return new Proxy(handle, { get(target, property) {
        if (property === "sync") return async () => { throw new Error("injected fsync failure"); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      return handle;
    };
    const uncertain = { idempotencyKey: "uncertain", source: "test", worldState: "fsync 失败后的完整记录，重启按日志恢复。" };
    await assert.rejects(store.commit(uncertain), /injected fsync/);
    (fs as any).open = realOpen;
    assert.deepEqual(store.snapshot(), beforeFault); assert.equal(events.length, eventCount);
    await assert.rejects(store.commit({ idempotencyKey: "after-fault", source: "test", worldState: "wrong" }), code("JOURNAL_UNAVAILABLE"));
    await store.reload();
    assert.equal(store.snapshot().worldState, uncertain.worldState);
    assert.equal((await store.commit(uncertain)).duplicate, true);
    assert.equal(events.length, eventCount, "recovery and duplicate replay never republish a committed event");
    await fs.appendFile(files.narrativeJournal, '{"partial":');
    await store.reload();
    assert.equal(store.snapshot().worldState, uncertain.worldState);
    assert.ok((await fs.readdir(files.base)).some(file => file.includes(".incomplete-")));
    const archived = await files.snapshot("story-save");
    const saved = store.snapshot();
    await store.commit({ idempotencyKey: "after-save", source: "test", worldState: "后来的世界" });
    await files.restoreFrom(path.join(files.archiveDir, archived));
    assert.deepEqual(store.snapshot(), saved);
    await files.reset();
    assert.equal(store.snapshot().initialized, false); assert.equal(store.snapshot().sequence, 0);
    assert.equal(await files.isInitialized(), false);

    const partial = await NarrativeStore.open(path.join(base, "partial"), { now: () => 10 });
    await partial.commit(seed);
    (fs as any).open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === partial.journalPath && args[1] === "a") return new Proxy(handle, { get(target, property) {
        if (property === "writeFile") return async (text: string) => { await target.writeFile(text.slice(0, Math.floor(text.length / 2))); throw new Error("partial write"); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      return handle;
    };
    await assert.rejects(partial.commit({ idempotencyKey: "half", source: "test", worldState: "不能显示一半的现实。" }), /partial write/);
    (fs as any).open = realOpen;
    await partial.reload();
    assert.equal(partial.snapshot().sequence, 1); assert.equal(partial.snapshot().worldState, seed.worldState);
    assert.equal(partial.findCommit("half"), null);
    await partial.commit({ idempotencyKey: "half", source: "test", worldState: "恢复后重试可以完整提交。" });
    assert.equal(partial.snapshot().sequence, 2);

    let adjudicationTime = 100;
    const timed = await NarrativeStore.open(path.join(base, "state-time"), { now: () => adjudicationTime });
    assert.equal(timed.snapshot().stateUpdatedAt, 0); assert.equal(timed.snapshot().stateSequence, 0);
    await timed.commit(seed); assert.equal(timed.snapshot().stateUpdatedAt, 100); assert.equal(timed.snapshot().stateSequence, 1);
    const stateRoot = timed.readEvents(timed.snapshot().stateSequence - 1, 1)[0]!.id;
    adjudicationTime = 105;
    await timed.commit({ idempotencyKey: "time-start", source: "action", actions: { pending: { id: "pending", actorId: "bot", intent: "等店员做面", status: "pending", startedAt: 105, expectedEnd: 130, requestFingerprint: "timed" } } });
    assert.equal(timed.snapshot().effectiveAt, 105); assert.equal(timed.snapshot().stateUpdatedAt, 100, "registering work cannot erase time elapsed since the world last advanced");
    assert.equal(timed.snapshot().stateSequence, 1, "action lifecycle markers do not become new state evidence");
    adjudicationTime = 110;
    await timed.commit({ idempotencyKey: "time-reread", source: "observe", worldState: seed.worldState, actors: { bot: { ...timed.snapshot().actors.bot!, perception: "同一场景的另一次回读" } }, perceptions: [{ actorId: "bot", text: "店员仍在忙。" }] });
    assert.equal(timed.snapshot().stateUpdatedAt, 100, "equal world prose, perception updates and rereads cannot reset the simulation interval");
    assert.equal(timed.snapshot().stateSequence, 1);
    assert.equal(timed.readEvents(timed.snapshot().stateSequence - 1, 1)[0]!.id, stateRoot, "rereads share the actual state commit, not an unrelated later perception event");
    adjudicationTime = 115;
    await timed.commit({ idempotencyKey: "time-body", source: "evolve", actors: { bot: { ...timed.snapshot().actors.bot!, state: "等了片刻，现在觉得有些冷。" } } });
    assert.equal(timed.snapshot().stateUpdatedAt, 115); assert.equal(timed.snapshot().stateSequence, 4);
    adjudicationTime = 120;
    await timed.commit({ idempotencyKey: "time-presence", source: "leave", actors: { bot: { ...timed.snapshot().actors.bot!, present: false } } });
    assert.equal(timed.snapshot().stateUpdatedAt, 120); assert.equal(timed.snapshot().stateSequence, 5);
    adjudicationTime = 125;
    await timed.commit({ idempotencyKey: "time-world", source: "evolve", worldState: "店员已经把面煮好。" });
    assert.equal(timed.snapshot().stateUpdatedAt, 125); assert.equal(timed.snapshot().stateSequence, 6);
    const updatedStateRoot = timed.readEvents(timed.snapshot().stateSequence - 1, 1)[0]!.id;
    assert.notEqual(updatedStateRoot, stateRoot);
    await timed.reload(); assert.equal(timed.snapshot().stateUpdatedAt, 125, "replay reconstructs the same narrative update clock");
    assert.equal(timed.snapshot().stateSequence, 6); assert.equal(timed.readEvents(5, 1)[0]!.id, updatedStateRoot);

    const background = await NarrativeStore.open(path.join(base, "background"), { now: () => 10 });
    await background.commit({ ...seed, actors: { bot: { ...seed.actors!.bot!, persona: "角色卡原文：说话谨慎，曾在天文台工作。" } } });
    const reread = await background.commit({ idempotencyKey: "no-evidence", source: "observe", perceptions: [{ actorId: "bot", text: "重读已经掌握的场景。", sourceEventIds: [] }] });
    assert.deepEqual(reread.perceptions[0]!.sourceEventIds, [], "explicit empty roots are a reread, not a new observation source");
    await background.reload();
    assert.deepEqual(background.readPerceptions("bot").at(-1)!.sourceEventIds, []);
    assert.match(background.snapshot().actors.bot!.persona!, /天文台/);
    await background.commit({ idempotencyKey: "new-body", source: "act", actors: { bot: { ...background.snapshot().actors.bot!, state: "角色现在坐在窗边。" } } });
    assert.match(background.snapshot().actors.bot!.persona!, /说话谨慎/, "editing current body state cannot erase retained character background");
    assert.throws(() => background.commit({ idempotencyKey: "bad-persona", source: "test", actors: { bot: { ...background.snapshot().actors.bot!, persona: 42 as any } } }), /角色身份/);

    const migrationFiles = new WorldFiles(path.join(base, "legacy-structured")); await migrationFiles.ensure();
    const kernel = await WorldKernel.open(migrationFiles.base, { now: () => 20 });
    await kernel.initialize([
      { id: "room", kind: "place", name: "餐厅", location: null },
      { id: "elsewhere", kind: "place", name: "远处", location: null },
      { id: "bot", kind: "actor", name: "小澈", controller: "bot", location: "room", attributes: { hunger: { value: 7, visibility: "owner" }, latent: { value: "BOT_HIDDEN", visibility: "hidden" } } },
      { id: "waiter", kind: "actor", name: "店员", controller: "world", location: "room", attributes: { motive: { value: "NPC_PRIVATE", visibility: "owner" } } },
      { id: "guest", kind: "actor", name: "已经离开的访客", controller: "player", location: null },
      { id: "secret", kind: "object", name: "REMOTE_SECRET_ITEM", location: "elsewhere", attributes: { contents: { value: "REMOTE_SECRET", visibility: "hidden" } } },
    ]);
    await kernel.commit({ idempotencyKey: "question", operations: [{ op: "say", actorId: "waiter", text: "今天想吃什么？" }] });
    await kernel.commit({ idempotencyKey: "completed-start", operations: [{ op: "action.start", action: { id: "past", actorId: "bot", intent: "走到柜台", requestFingerprint: "past-request" } }] });
    await kernel.commit({ idempotencyKey: "completed-finish", operations: [{ op: "action.finish", id: "past", status: "completed" }] });
    await kernel.commit({ idempotencyKey: "pending", operations: [{ op: "action.start", action: { id: "interrupted", actorId: "bot", intent: "看菜单后点餐", requestFingerprint: "pending-request" } }] });
    await fs.appendFile(migrationFiles.worldJournal, '{"unfinished":');
    const original = await fs.readFile(migrationFiles.worldJournal, "utf8");
    const migrated = await NarrativeStore.open(migrationFiles.base, { now: () => 5 });
    await migrated.migrateLegacy(migrationFiles); migrationFiles.bindNarrativeStore(migrated);
    assert.equal(await fs.readFile(migrationFiles.worldJournal, "utf8"), original, "legacy journal bytes remain untouched including incomplete tails");
    assert.ok((await fs.readdir(migrationFiles.archiveDir)).some(name => name.includes("before-narrative-migration")));
    const imported = migrated.snapshot();
    assert.equal(imported.initialized, true);
    assert.equal(imported.effectiveAt, 20, "migration cannot move the world's time backward when clock.json lags");
    assert.equal(imported.actions.past!.status, "completed"); assert.equal(imported.actions.past!.requestFingerprint, "past-request");
    assert.equal(imported.actions.interrupted!.status, "pending"); assert.equal(imported.actions.interrupted!.requestFingerprint, "pending-request");
    assert.match(imported.worldState, /BOT_HIDDEN/); assert.match(imported.worldState, /NPC_PRIVATE/); assert.match(imported.worldState, /REMOTE_SECRET/);
    assert.match(imported.worldState, /今天想吃什么/); assert.match(imported.worldState, /看菜单后点餐/); assert.match(imported.worldState, /尚未完成/);
    assert.match(imported.actors.bot!.perception, /今天想吃什么/);
    assert.doesNotMatch(JSON.stringify(imported.actors), /BOT_HIDDEN|NPC_PRIVATE|REMOTE_SECRET/);
    assert.deepEqual(Object.keys(imported.actors), ["bot", "guest"], "NPC facts live in prose, not a recreated entity graph");
    assert.equal(imported.actors.guest!.present, false, "an old visitor who left cannot silently reappear during migration");
    await migrated.migrateLegacy(migrationFiles);
    assert.equal(migrated.snapshot().sequence, 1);

    const markdownFiles = new WorldFiles(path.join(base, "legacy-markdown")); await markdownFiles.ensure();
    await fs.writeFile(markdownFiles.worldStatus, "# 世界\n店员等着回答。后厨藏有 WORLD_ONLY_SECRET。");
    await fs.writeFile(markdownFiles.botStatus, "# 小澈\n你在柜台前，正看菜单。");
    const markdown = await NarrativeStore.open(markdownFiles.base, { now: () => 10 });
    await markdown.migrateLegacy(markdownFiles); markdownFiles.bindNarrativeStore(markdown);
    assert.match(await markdownFiles.readWorldStatus(), /WORLD_ONLY_SECRET/);
    assert.doesNotMatch(await markdownFiles.readWorldStatus(true), /WORLD_ONLY_SECRET/);
    assert.equal(markdown.snapshot().actors.bot!.state, "# 小澈\n你在柜台前，正看菜单。");

    const partialMigrationFiles = new WorldFiles(path.join(base, "legacy-first-append")); await partialMigrationFiles.ensure();
    await fs.writeFile(partialMigrationFiles.worldJournal, '{"first-append-never-committed":');
    await fs.writeFile(partialMigrationFiles.worldStatus, "原有世界仍在继续。隐藏的 OLD_PRIVATE_FACT 必须保留。");
    await fs.writeFile(partialMigrationFiles.botStatus, "你仍在看菜单。");
    const partialMigration = await NarrativeStore.open(partialMigrationFiles.base, { now: () => 10 });
    await partialMigration.migrateLegacy(partialMigrationFiles);
    assert.equal(partialMigration.snapshot().worldState, "原有世界仍在继续。隐藏的 OLD_PRIVATE_FACT 必须保留。", "an incomplete first kernel append cannot replace the real Markdown world with an empty migration summary");
    assert.doesNotMatch(partialMigration.snapshot().actors.bot!.perception, /OLD_PRIVATE_FACT/);
    assert.equal(await fs.readFile(partialMigrationFiles.worldJournal, "utf8"), '{"first-append-never-committed":');

    const busyFiles = new WorldFiles(path.join(base, "long-legacy-history")); await busyFiles.ensure();
    let legacyTime = 100;
    const busyKernel = await WorldKernel.open(busyFiles.base, { now: () => legacyTime });
    const privateCurrentFact = "CURRENT_PRIVATE_FACT:" + "精确秘密".repeat(600);
    await busyKernel.initialize([
      { id: "room", kind: "place", name: "餐厅", location: null },
      { id: "bot", kind: "actor", name: "小澈", controller: "bot", location: "room" },
      { id: "waiter", kind: "actor", name: "店员", controller: "world", location: "room", attributes: { secret: { value: privateCurrentFact, visibility: "hidden" } } },
    ]);
    for (let index = 0; index < 96; index++) {
      legacyTime++;
      await busyKernel.commit({ idempotencyKey: `history-start-${index}`, operations: [{ op: "action.start", action: { id: `history-${index}`, actorId: "bot", intent: `OLD_ACTION_${String(index).padStart(3, "0")}` } }] });
      await busyKernel.commit({ idempotencyKey: `history-end-${index}`, operations: [
        { op: "say", actorId: "waiter", text: `HISTORY_LINE_${String(index).padStart(3, "0")}:` + "x".repeat(800) },
        { op: "action.finish", id: `history-${index}`, status: index % 3 === 0 ? "needs_input" : "completed" },
      ] });
    }
    await busyKernel.commit({ idempotencyKey: "long-utterance", operations: [{ op: "say", actorId: "waiter", text: "OVERSIZED_HISTORY_BEGIN" + "y".repeat(12_000) + "OVERSIZED_HISTORY_END" }] });
    await busyKernel.commit({ idempotencyKey: "last-question", operations: [{ op: "say", actorId: "waiter", text: "FINAL_QUESTION：要清汤还是红汤？" }] });
    await busyKernel.commit({ idempotencyKey: "still-pending", operations: [{ op: "action.start", action: { id: "still-pending", actorId: "bot", intent: "PENDING_INTENT_MUST_SURVIVE" } }] });
    const busyRaw = await fs.readFile(busyFiles.worldJournal, "utf8");
    const bounded = await NarrativeStore.open(busyFiles.base, { now: () => legacyTime }); await bounded.migrateLegacy(busyFiles);
    const boundedState = bounded.snapshot(), actorHistory = boundedState.actors.bot!.perception.split("近期亲历（历史，不是当前状态）：")[1]!;
    assert.ok(boundedState.worldState.length < 48_000, "old terminal actions and historical speech cannot replay an entire lifetime into every World request");
    assert.ok(actorHistory.length < 8_000, "actor migration gets a bounded recent history in addition to current visible facts");
    assert.ok(boundedState.worldState.includes(privateCurrentFact), "history limits never trim current private facts");
    assert.match(boundedState.worldState, /PENDING_INTENT_MUST_SURVIVE/); assert.match(boundedState.worldState, /FINAL_QUESTION/);
    assert.match(actorHistory, /FINAL_QUESTION/); assert.match(boundedState.worldState, /完整原文保留/);
    assert.doesNotMatch(boundedState.worldState, /HISTORY_LINE_000|OLD_ACTION_000|OVERSIZED_HISTORY_BEGIN|OVERSIZED_HISTORY_END/);
    assert.doesNotMatch(actorHistory, /HISTORY_LINE_000|OVERSIZED_HISTORY_BEGIN|CURRENT_PRIVATE_FACT/);
    assert.equal(Object.keys(boundedState.actions).length, 97, "mechanical action receipts remain complete for idempotency regardless of context history limits");
    assert.equal(await fs.readFile(busyFiles.worldJournal, "utf8"), busyRaw, "history omission does not remove original evidence");

    // Interior corruption must fail loudly and must never fall back to stale Markdown mirrors.
    await fs.appendFile(markdownFiles.narrativeJournal, '{"broken":true}\n');
    await assert.rejects(markdown.reload(), code("CORRUPT_JOURNAL"));
    await assert.rejects(markdown.commit({ idempotencyKey: "behind-corruption", source: "test", worldState: "wrong" }), code("JOURNAL_UNAVAILABLE"));
    console.log("PASS narrative storage: atomic state/perception commits, replay, concurrent versions, cancellation, fsync fencing, mirrors, archives/reset, private-safe v0.3/v0.2.1 migration and corruption refusal");
  } finally { (fs as any).open = realOpen; await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
