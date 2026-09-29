/** Real World runtime and journal in temporary directories; deterministic inference only. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import type { ChatMessage, ChatResult, ChatToolDef } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const SECRET = "ADMIN_PRIVATE_SECRET：锁着的地窖里藏着蓝色宝石，角色尚不知道。";
const INITIAL = `院子里有一张木制长椅。\n\n${SECRET}\n\n树下有一片落叶。`;
const native = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const prose = (text = "你看见木制长椅与树下的落叶。") => [{ actorId: "bot", text }];
const inputOf = (messages: ChatMessage[]) => JSON.parse(String(messages.find(message => message.role === "user")!.content));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Handler = (input: any, messages: ChatMessage[], signal?: AbortSignal) => Promise<ChatResult>;
type Document = { revision: string; paragraphs: { id: string; text: string }[] };

function documentOf(input: any): Document {
  assert.equal(Object.hasOwn(input, "worldState"), false, "incremental inputs do not duplicate the full worldState");
  const doc = input.worldDocument as Document;
  assert.ok(doc && typeof doc.revision === "string" && doc.revision.length > 0);
  assert.ok(Array.isArray(doc.paragraphs) && doc.paragraphs.length > 0);
  assert.equal(new Set(doc.paragraphs.map(p => p.id)).size, doc.paragraphs.length);
  for (const p of doc.paragraphs) assert.ok(typeof p.id === "string" && p.id && typeof p.text === "string");
  return doc;
}
function paragraph(doc: Document, fragment: string): string {
  const found = doc.paragraphs.find(item => item.text.includes(fragment));
  assert.ok(found, `missing source paragraph: ${fragment}`); return found.id;
}

async function fixture(options: { initial?: string; initialized?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "world-incremental-runtime-"));
  const files = new WorldFiles(directory); await files.ensure(); await files.writeMeta({ realWorld: false });
  let now = 100, handler: Handler = async () => native({ perceptions: prose() });
  const requests: ChatMessage[][] = [], schemas: ChatToolDef[][] = [];
  const clock = { now: () => now, realMsUntil: () => 5, unitRealSeconds: 1, unitWorldSeconds: 1,
    authority: (tu = now) => ({ tu, source: "world_calendar", date: "2026-09-27", weekday: "星期日", formatted: "2026-09-27 12:00",
      timeLine: "2026-09-27 12:00", timeZone: "Asia/Shanghai", utcOffset: "+08:00", calendarKind: "gregorian", unitRealSeconds: 1, unitWorldSeconds: 1 }) } as any;
  const runtime = new NarrativeWorld(files, clock, async (messages, tools, signal) => {
    requests.push(structuredClone(messages)); schemas.push(structuredClone(tools));
    assert.equal(tools.length, 1); assert.equal(tools[0]!.function.name, "resolve_world");
    return handler(inputOf(messages), messages, signal);
  });
  const store = await runtime.store();
  if (options.initialized !== false) await store.commit({ idempotencyKey: "fixture", source: "fixture", initialized: true,
    worldState: options.initial ?? INITIAL, actors: { bot: { id: "bot", name: "小澈", controller: "bot", present: true,
      state: "你站在院子里的长椅旁。", perception: "院子很安静。" } } });
  const call = (id: string): ToolCallRecord => ({ id, name: "act", role: "agent", arguments: { description: "把树下的落叶拿到长椅旁" }, issuedAt: now, expectedAt: now });
  return { runtime, store, files, requests, schemas, call, setNow: (value: number) => { now = value; },
    setHandler: (value: Handler) => { handler = value; },
    close: async () => { await runtime.shutdown(); await fs.rm(directory, { recursive: true, force: true }); } };
}

async function patchTransactionAndReplay() {
  const f = await fixture();
  try {
    let originalRevision = "";
    const receipt: string[] = [], events: unknown[] = [];
    const before = f.store.snapshot();
    const unsubscribe = f.store.subscribe(event => {
      if (event.topic !== "world.perception") return;
      assert.match(f.store.snapshot().worldState, /长椅旁放着一片落叶/);
      events.push(event);
    });
    f.setNow(120);
    f.setHandler(async input => {
      const doc = documentOf(input); originalRevision = doc.revision;
      assert.match(JSON.stringify(doc.paragraphs), /ADMIN_PRIVATE_SECRET/, "World retains its private facts");
      assert.equal(input.actors.find((actor: any) => actor.id === "bot").state, before.actors.bot!.state, "short actor state remains full prose");
      return native({ worldPatch: { revision: doc.revision, edits: [
        { op: "replace", id: paragraph(doc, "木制长椅"), text: "院子里有一张木制长椅，长椅旁放着一片落叶。" },
        { op: "delete", id: paragraph(doc, "树下有一片落叶") },
        { op: "append", text: "树下的空地已没有落叶。" },
      ] }, actorStates: [{ actorId: "bot", state: "你站在长椅旁，双手空着。" }], perceptions: prose("你把落叶放在长椅旁，树下空了出来。"), outcome: { status: "completed" } });
    });
    const request = f.call("patch-and-replay");
    assert.equal(await f.runtime.act("bot", request, text => {
      assert.match(f.store.snapshot().worldState, /长椅旁放着一片落叶/); receipt.push(text);
    }), true);
    unsubscribe();
    assert.equal(f.requests.length, 1); assert.equal(events.length, 1); assert.equal(receipt.length, 1);
    const state = f.store.snapshot();
    assert.equal(state.worldState, `院子里有一张木制长椅，长椅旁放着一片落叶。\n\n${SECRET}\n\n树下的空地已没有落叶。`);
    assert.equal(state.actors.bot!.state, "你站在长椅旁，双手空着。");
    assert.equal(state.stateUpdatedAt, 120); assert.doesNotMatch(receipt[0]!, /ADMIN_PRIVATE_SECRET|蓝色宝石/);
    assert.doesNotMatch(JSON.stringify(await f.runtime.peek()), /ADMIN_PRIVATE_SECRET|蓝色宝石/);
    assert.doesNotMatch(JSON.stringify(events), /ADMIN_PRIVATE_SECRET|蓝色宝石/);
    const journal = await f.store.exportJournal();
    assert.equal(await f.runtime.act("bot", request, text => receipt.push(text)), true);
    assert.equal(f.requests.length, 1); assert.equal(await f.store.exportJournal(), journal);
    assert.deepEqual(JSON.parse(receipt[1]!), JSON.parse(receipt[0]!));
    await f.store.reload(); assert.deepEqual(f.store.snapshot(), state, "patch is persisted as the ordinary complete atomic state");
    f.setHandler(async input => {
      const doc = documentOf(input); assert.notEqual(doc.revision, originalRevision);
      assert.equal(Object.hasOwn(input, "stateVersion"), false, "document revision already carries the edit address");
      return native({ perceptions: prose("你看见落叶还在长椅旁。") });
    });
    f.setNow(140); await f.runtime.observe();
    const unchanged = f.store.snapshot();
    assert.equal(unchanged.worldState, state.worldState); assert.equal(unchanged.stateUpdatedAt, state.stateUpdatedAt);
    assert.equal(unchanged.sequence, state.sequence + 1, "new perception advances transaction sequence without rewriting world memory");
    console.log("PASS paragraph replace/delete/append preserve private facts, atomic perception, durable versions and action idempotency");
  } finally { await f.close(); }
}

async function rejectedPatchesAreAtomic() {
  const f = await fixture();
  try {
    const proposals: [string, (doc: Document) => unknown, RegExp][] = [
      ["conflicting full state", doc => ({ worldState: INITIAL, worldPatch: { revision: doc.revision, edits: [] }, perceptions: prose() }), /worldPatch|worldState|同时|冲突/],
      ["stale revision", doc => ({ worldPatch: { revision: "obsolete-" + doc.revision, edits: [{ op: "append", text: "一块石头出现在树下。" }] }, perceptions: prose() }), /revision|版本/],
      ["unknown paragraph", doc => ({ worldPatch: { revision: doc.revision, edits: [{ op: "replace", id: "missing-paragraph", text: "一块石头出现在树下。" }] }, perceptions: prose() }), /段落|paragraph|missing-paragraph/],
      ["merged device claim", doc => ({ worldPatch: { revision: doc.revision, edits: [{ op: "append", text: "手机收到一条新消息：你好。" }] }, perceptions: prose() }), /WORLD_DEVICE_BOUNDARY/],
      ["merged time conflict", doc => ({ worldPatch: { revision: doc.revision, edits: [{ op: "append", text: "当前日期：1999-01-01。" }] }, perceptions: prose() }), /WORLD_TIME_CONFLICT/],
      ["unknown perception actor", doc => ({ worldPatch: { revision: doc.revision, edits: [{ op: "append", text: "长椅下有一颗石子。" }] }, perceptions: [{ actorId: "absent", text: "长椅下有一颗石子。" }] }), /在场角色/],
    ];
    for (const [label, build, pattern] of proposals) {
      const before = f.store.snapshot(), journal = await f.store.exportJournal(), requests = f.requests.length;
      f.setHandler(async input => native(build(documentOf(input))));
      await assert.rejects(f.runtime.observe("bot", { intent: `检查${label}` }), pattern);
      assert.equal(f.requests.length, requests + 3, `${label}: bounded repair budget`);
      assert.deepEqual(f.store.snapshot(), before, `${label}: no state, actor or perception mutation`);
      assert.equal(await f.store.exportJournal(), journal, `${label}: no partial journal commit`);
    }
    console.log("PASS conflicting/stale/unknown patches and merged device/time/actor violations reject without partial state or perceptions");
  } finally { await f.close(); }
}

async function localRepairRetainsTheDraft() {
  const f = await fixture();
  try {
    let attempt = 0, draft: any;
    const before = f.store.snapshot(), journal = await f.store.exportJournal();
    f.setHandler(async (input, messages) => {
      attempt++;
      assert.deepEqual(f.store.snapshot(), before); assert.equal(await f.store.exportJournal(), journal, "invalid drafts cannot leak a partial commit");
      const doc = documentOf(input);
      if (attempt === 1) {
        draft = { worldPatch: { revision: doc.revision, edits: [{ op: "append", text: "长椅下方有一个浅浅的脚印。" }] },
          actorStates: [{ actorId: "bot", state: "你站在长椅旁，袖口沾着一片小叶子。" }],
          perceptions: [{ actorId: "bot", situation: "只给状态栏会被拒绝。" }], unsupported: "REMOVE_THIS_FIELD" };
        return native(draft);
      }
      assert.deepEqual(messages.slice(0, 2), f.requests[0]!, "repair preserves original world request and sampled time");
      const supplemental = JSON.stringify(messages.slice(2));
      assert.match(supplemental, /REMOVE_THIS_FIELD/); assert.match(supplemental, /长椅下方有一个浅浅的脚印/);
      assert.match(supplemental, /error/); assert.doesNotMatch(supplemental, /ADMIN_PRIVATE_SECRET/, "repair attaches a draft, not another copy of world memory");
      return native({ repair: { set: { perceptions: prose("你看见长椅下有一个浅浅的脚印。") }, remove: ["unsupported"] } });
    });
    const result = await f.runtime.observe();
    assert.equal(attempt, 2); assert.match(result.narrative, /浅浅的脚印/);
    assert.equal(f.store.snapshot().worldState, INITIAL + "\n\n长椅下方有一个浅浅的脚印。");
    assert.equal(f.store.snapshot().actors.bot!.state, draft.actorStates[0].state, "repair changes only the selected top-level fields");
    assert.equal(f.store.snapshot().sequence, before.sequence + 1); assert.doesNotMatch(JSON.stringify(result), /ADMIN_PRIVATE_SECRET/);
    console.log("PASS top-level local repair replaces one whole field, removes invalid field and preserves all other proposed changes");
  } finally { await f.close(); }
}

async function repairNeedsAParsedDraftAndSupportsFullRetry() {
  for (const first of ["repair", "syntax"] as const) {
    const f = await fixture();
    try {
      let attempt = 0;
      const before = f.store.snapshot(), journal = await f.store.exportJournal();
      f.setHandler(async (_input, messages) => {
        attempt++; assert.deepEqual(f.store.snapshot(), before); assert.equal(await f.store.exportJournal(), journal);
        if (attempt === 1) return first === "syntax"
          ? { content: "", toolCalls: [{ id: "broken", type: "function", function: { name: "resolve_world", arguments: '{"perceptions":[],"worldState":"BROKEN_DRAFT_MUST_NOT_REPLAY",' } }] }
          : native({ repair: { set: { perceptions: prose("没有草稿时不能局部修正。") } } });
        if (attempt === 2 && first === "syntax") {
          assert.match(String(messages.at(-1)!.content), /WORLD_RESPONSE_JSON/);
          assert.doesNotMatch(JSON.stringify(messages), /BROKEN_DRAFT_MUST_NOT_REPLAY/);
          return native({ repair: { set: { perceptions: prose("语法无效不能成为草稿。") } } });
        }
        assert.match(String(messages.at(-1)!.content), /repair|草稿|修正/);
        return native({ worldState: INITIAL + "\n\n院墙边还有一朵白花。", perceptions: prose("你看见院墙边有一朵白花。") });
      });
      await f.runtime.observe(); assert.equal(attempt, first === "syntax" ? 3 : 2);
      assert.match(f.store.snapshot().worldState, /院墙边还有一朵白花/);
    } finally { await f.close(); }
  }
  console.log("PASS initial/parse-failed proposals cannot be repaired; complete proposals remain valid after either retry error");
}

async function repairedProposalStillUsesAllGuards() {
  const f = await fixture();
  try {
    let attempt = 0;
    const before = f.store.snapshot(), journal = await f.store.exportJournal();
    f.setHandler(async input => {
      attempt++;
      if (attempt === 1) return native({ worldPatch: { revision: documentOf(input).revision, edits: [{ op: "append", text: "长椅下方有一个脚印。" }] }, perceptions: [] });
      return native({ repair: { set: { perceptions: prose("手机收到一条新消息：你好。") } } });
    });
    await assert.rejects(f.runtime.observe(), /WORLD_DEVICE_BOUNDARY/);
    assert.equal(attempt, 3); assert.deepEqual(f.store.snapshot(), before); assert.equal(await f.store.exportJournal(), journal);
    console.log("PASS repaired proposals run normal semantic guards and exhaust the same three-attempt budget without committing");
  } finally { await f.close(); }
}

async function fullStateExceptionsAndTimeProjection() {
  const f = await fixture({ initialized: false });
  try {
    f.setHandler(async input => {
      assert.equal(input.kind, "initialize"); assert.equal(Object.hasOwn(input, "worldDocument"), false); assert.equal(typeof input.worldState, "string");
      return native({ botName: "小澈", worldState: INITIAL, actorStates: [{ actorId: "bot", state: "你站在院子里。" }], perceptions: prose() });
    });
    await f.runtime.ensure();
    f.setHandler(async input => {
      assert.equal(input.kind, "app_observe"); assert.equal(Object.hasOwn(input, "worldDocument"), false); assert.equal(input.worldState, INITIAL);
      return native({ perceptions: prose("没有记录这份虚构文件的内容。") });
    });
    await f.runtime.observeVirtualApp("bot", "读取虚构文件 /home/bot/notes.txt");
    f.setHandler(async input => {
      assert.equal(input.kind, "app_action"); assert.equal(Object.hasOwn(input, "worldDocument"), false); assert.equal(input.worldState, INITIAL);
      return native({ worldState: input.worldState, perceptions: prose("这个虚构文件没有发生更改。"), outcome: { status: "completed" } });
    });
    await f.runtime.executeVirtualApp("bot", "保留虚构文件 /home/bot/notes.txt 的原有内容");
    assert.equal(f.store.snapshot().worldState, INITIAL);
  } finally { await f.close(); }
  const projected = await fixture({ initial: "当前日期：2020-01-01。\n\n" + INITIAL });
  try {
    const before = projected.store.snapshot();
    projected.setHandler(async input => {
      assert.equal(Object.hasOwn(input, "worldDocument"), false, "time-isolated prose cannot be patched using stale original paragraph identities");
      assert.equal(typeof input.worldState, "string"); assert.doesNotMatch(input.worldState, /2020-01-01/); assert.match(input.worldState, /旧的当前日期断言已隔离/);
      return native({ perceptions: prose() });
    });
    await projected.runtime.observe();
    assert.equal(projected.store.snapshot().worldState, before.worldState, "time projection is read-only when output omits state");
  } finally { await projected.close(); }
  console.log("PASS initialization and virtual apps retain full-state protocol; changed time projection falls back without rewriting archives");
}

async function hiddenLegacyFilesSurvivePatch() {
  const hidden = "\n\n文件 /home/bot/notes.txt 原文如下\nFILE_PRIVATE_SECRET：不能作为角色感知。\n当前日期：1999-01-01。";
  const f = await fixture({ initial: INITIAL + hidden });
  try {
    f.setHandler(async input => {
      const doc = documentOf(input); assert.doesNotMatch(JSON.stringify(doc), /FILE_PRIVATE_SECRET|1999-01-01/);
      return native({ worldPatch: { revision: doc.revision, edits: [{ op: "append", text: "院墙脚下有几朵白花。" }] }, perceptions: prose("你看见院墙脚下的白花。") });
    });
    const result = await f.runtime.observe();
    assert.match(f.store.snapshot().worldState, /院墙脚下有几朵白花/);
    assert.ok(f.store.snapshot().worldState.endsWith(hidden.trimStart()), "unseen file tail stays byte-for-byte intact");
    assert.doesNotMatch(JSON.stringify(result), /FILE_PRIVATE_SECRET|ADMIN_PRIVATE_SECRET|1999-01-01/);
    console.log("PASS incremental physical prose preserves opaque legacy file records without adding them to input or perception");
  } finally { await f.close(); }
}

async function stopAndStorageFailureNeverPublish() {
  const f = await fixture(), entered = deferred<void>(), late = deferred<ChatResult>();
  try {
    const before = f.store.snapshot(), journal = await f.store.exportJournal();
    let signal: AbortSignal | undefined, patch: unknown;
    f.setHandler(async (input, _messages, currentSignal) => {
      signal = currentSignal; patch = { worldPatch: { revision: documentOf(input).revision, edits: [{ op: "append", text: "迟到的石头不应出现在院中。" }] }, perceptions: prose("迟到的感知不应交付。") };
      entered.resolve(); return late.promise;
    });
    const operation = f.runtime.observe(); const rejection = assert.rejects(operation);
    await entered.promise; await f.runtime.shutdown(); await rejection; assert.equal(signal?.aborted, true);
    late.resolve(native(patch)); await tick(); await tick();
    assert.deepEqual(f.store.snapshot(), before); assert.equal(await f.store.exportJournal(), journal);
  } finally { late.resolve(native({ perceptions: prose() })); await f.close(); }
  const disk = await fixture();
  try {
    const before = disk.store.snapshot(), journal = await disk.store.exportJournal(), commit = disk.store.commit.bind(disk.store);
    let published = 0; const unsubscribe = disk.store.subscribe(() => { published++; });
    disk.setHandler(async input => native({ worldPatch: { revision: documentOf(input).revision, edits: [{ op: "append", text: "未保存的变化。" }] }, perceptions: prose("未保存的感知。") }));
    disk.store.commit = (input, options) => input.source === "observe" ? Promise.reject(new Error("FIXTURE_DISK_FAILURE")) : commit(input, options);
    try { await assert.rejects(disk.runtime.observe(), /FIXTURE_DISK_FAILURE/); }
    finally { disk.store.commit = commit; unsubscribe(); }
    assert.equal(disk.requests.length, 1, "storage faults are not inference repair opportunities"); assert.equal(published, 0);
    assert.deepEqual(disk.store.snapshot(), before); assert.equal(await disk.store.exportJournal(), journal);
  } finally { await disk.close(); }
  console.log("PASS stop discards late incremental output; storage failure neither retries inference nor publishes uncommitted perceptions");
}

async function main() {
  await patchTransactionAndReplay(); await rejectedPatchesAreAtomic(); await localRepairRetainsTheDraft();
  await repairNeedsAParsedDraftAndSupportsFullRetry(); await repairedProposalStillUsesAllGuards();
  await fullStateExceptionsAndTimeProjection(); await hiddenLegacyFilesSurvivePatch(); await stopAndStorageFailureNeverPublish();
  const large = await fixture({ initial: "长".repeat(200_001) });
  try {
    const before = large.store.snapshot();
    large.setHandler(async input => {
      assert.equal(input.worldDocument, undefined, "large legacy state falls back instead of failing before inference");
      assert.equal(input.worldState, before.worldState);
      return native({ perceptions: [] });
    });
    await large.runtime.evolve("没有外部变化。");
    assert.equal(large.requests.length, 1); assert.deepEqual(large.store.snapshot(), before);
  } finally { await large.close(); }
  const authority = await fixture();
  try {
    const before = authority.store.snapshot();
    authority.setHandler(async () => native({ perceptions: prose(), outcome: { status: "completed" } }));
    await assert.rejects(authority.runtime.observe(), /WORLD_OUTCOME_AUTHORITY/);
    assert.deepEqual(authority.store.snapshot(), before);
  } finally { await authority.close(); }
  console.log("PASS oversized legacy state remains readable without editing, and non-action tasks cannot smuggle outcomes through full or repaired proposals");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
