import { worldInputText, assertWorldInputText } from "./world-input-fixture.js";
/** Real runtime/store with deterministic inference; no production world or external services. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { Prompts } from "../src/prompts.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";

const body = (value: unknown): ChatResult => ({ content: JSON.stringify(value), toolCalls: [] });
const native = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const cause = { id: "gust", description: "又一阵风吹过院子。" };
const observed = { actorId: "bot", changeIds: ["gust"], text: "风拂过你的脸颊。" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Handler = (input: any, messages: ChatMessage[], signal?: AbortSignal) => Promise<ChatResult>;

async function fixture(options: { worldState?: string; heartbeatTimeoutMs?: number } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-response-runtime-")), files = new WorldFiles(base);
  await files.ensure(); await files.writeMeta({ realWorld: false });
  let now = 100, handler: Handler = async () => body({ perceptions: [] });
  const requests: ChatMessage[][] = [];
  const clock = { now: () => now, unitRealSeconds: 1, authority: (tu = now) => ({ tu, source: "world_calendar", date: "2026-09-26", weekday: "星期六",
    formatted: "2026-09-26 12:00", timeLine: "2026-09-26 12:00", timeZone: "Asia/Shanghai", utcOffset: "+08:00", calendarKind: "gregorian", unitRealSeconds: 1, unitWorldSeconds: 1 }) } as any;
  const runtime = new NarrativeWorld(files, clock, async (messages, _tools, signal) => {
    requests.push(structuredClone(messages));
    return handler(JSON.parse(messages.find(message => message.role === "user")!.content as string), messages, signal);
  }, new Prompts(), { heartbeatTimeoutMs: options.heartbeatTimeoutMs });
  const store = await runtime.store();
  await store.commit({ idempotencyKey: "fixture", source: "fixture", initialized: true,
    worldState: options.worldState ?? "院子里有风，树下有一张长椅。", actors: { bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "坐在长椅上。", perception: "院子很安静。" } } });
  return { runtime, store, requests, setHandler: (value: Handler) => { handler = value; }, setNow: (value: number) => { now = value; },
    close: async () => { await runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function jsonCommitsAndSemanticGuards() {
  const f = await fixture();
  try {
    const before = f.store.snapshot();
    f.setHandler(async input => body({ worldState: f.store.snapshot().worldState + "风吹落了一片树叶。", externalChanges: [cause], perceptions: [observed], nextIntervalTU: 60 }));
    const result = await f.runtime.evolve("外部变化。", { heartbeat: true });
    assert.equal(result.status, "committed"); assert.equal(result.nextIntervalTU, 60); assert.equal(result.attempts, 1);
    assert.equal(result.perceptions, 1); assert.equal(result.sequence, before.sequence + 1);
    assert.match(f.store.snapshot().worldState, /吹落/); assert.equal(f.store.readPerceptions("bot").at(-1)!.text, observed.text);
    const commit = JSON.parse((await f.store.exportJournal()).trim().split("\n").at(-1)!).commit;
    assert.deepEqual(commit.evolution.changes, [cause]); assert.deepEqual(commit.evolution.perceptionSources, [{ actorId: "bot", changeIds: ["gust"] }]);
    const denied: [unknown, RegExp][] = [
      [{ externalChanges: [cause], perceptions: [{ ...observed, text: "手机收到一条新消息：你好。" }] }, /WORLD_DEVICE_BOUNDARY/],
      [{ externalChanges: [{ id: "gust", description: "当前日期：2020-01-01。院子起风。" }], perceptions: [] }, /WORLD_TIME_CONFLICT/],
      [{ actorStates: [{ actorId: "bot", state: "你走进屋内。" }], perceptions: [] }, /EVOLUTION_ACTOR_AUTHORITY/],
      [{ outcome: { status: "completed" }, perceptions: [] }, /EVOLUTION_ACTOR_AUTHORITY/],
      [{ externalChanges: [cause], perceptions: [{ ...observed, actorId: "absent" }] }, /在场角色/],
      [{ externalChanges: [cause], actorEffects: [{ actorId: "absent", state: "衣服被吹起。", changeIds: ["gust"] }], perceptions: [] }, /在场角色/],
    ];
    for (const [proposal, expected] of denied) {
      const saved = f.store.snapshot(), journal = await f.store.exportJournal(), count = f.requests.length;
      f.setHandler(async () => body(proposal));
      await assert.rejects(f.runtime.evolve("只接受合法的外部变化。"), expected);
      assert.equal(f.requests.length, count + 3); assert.deepEqual(f.store.snapshot(), saved); assert.equal(await f.store.exportJournal(), journal);
    }
    f.runtime.phoneAuthorityProvider = () => false;
    f.setHandler(async () => body({ externalChanges: [cause], perceptions: [], phoneState: { reachable: false, location: null, usable: true, perceptible: false }, phoneChangeIds: ["gust"] }));
    const saved = f.store.snapshot(); await assert.rejects(f.runtime.evolve("无手机裁定权限。"), /PHONE_PHYSICAL_AUTHORITY/); assert.deepEqual(f.store.snapshot(), saved);
    console.log("PASS body-only JSON reaches real transaction/delivery; device/time/actor/phone authority remain enforced");
  } finally { await f.close(); }
}

function checkRepairRequests(requests: ChatMessage[][], marker: string): void {
  assert.ok(requests.length >= 2); assert.equal(requests[0]!.length, 2);
  for (const [index, request] of requests.entries()) {
    assert.deepEqual(request.slice(0, 2), requests[0]!, "world state/time/system prefix stays unchanged during repair");
    assert.equal(request.length, 2 + index * 2, "only a short acknowledgement and repair diagnosis are appended");
    assert.equal(request.filter(message => message.role === "user" && String(message.content).includes(marker)).length, 1, "full world input appears only once");
    assert.ok(request.every(message => !message.tool_calls && message.role !== "tool"), "invalid native tool history is never sent to provider");
    for (const message of request.slice(2)) {
      assert.ok(String(message.content).length < 1800, "repair instruction stays short");
      assert.ok(!String(message.content).includes(marker), "repair does not repeat world state");
    }
  }
}

async function malformedRepairsPreservePrefix() {
  const marker = "唯一世界正文标记_稳定前缀";
  const longState = marker + "。" + "院中树木仍在原处。".repeat(700);
  const f = await fixture({ worldState: longState });
  try {
    let attempt = 0;
    const broken = '{"perceptions":[],"worldState":"不应重新发送的坏提案",';
    f.setHandler(async () => {
      attempt++; f.setNow(100 + attempt * 50);
      if (attempt === 1) return { content: "", toolCalls: [{ id: "broken", type: "function", function: { name: "resolve_world", arguments: broken } }] };
      if (attempt === 2) return body({ externalChanges: [cause], perceptions: [{ actorId: "bot", changeIds: ["gust"], situation: "凉风经过。" }] });
      return native({ externalChanges: [cause], perceptions: [observed] });
    });
    const result = await f.runtime.evolve("检查与纠正。", { heartbeat: true });
    assert.equal(result.status, "committed"); assert.equal(result.attempts, 3); assert.equal(f.requests.length, 3);
    checkRepairRequests(f.requests, marker);
    const request = JSON.parse(f.requests[0]![1]!.content as string);
    assertWorldInputText(request, longState, "a soft memory target never truncates existing world facts");
    assert.equal(Object.hasOwn(request.worldMemory, "currentChars"), false);
    assert.equal(request.worldMemory.targetChars, 6000); assert.ok(longState.length > request.worldMemory.targetChars);
    assert.equal(Object.hasOwn(request.worldMemory, "guidance"), false);
    assert.match(String(f.requests[0]![0]!.content), /软目标/); assert.match(String(f.requests[0]![0]!.content), /不硬截断/);
    assert.equal(f.store.snapshot().worldState, longState, "repair/event-only round does not compact or silently rewrite memory");
    assert.match(String(f.requests[1]!.at(-1)!.content), /WORLD_RESPONSE_JSON/);
    assert.match(String(f.requests[2]!.at(-1)!.content), /perceptions\[0\]\.text/);
    for (const request of f.requests) assert.ok(!JSON.stringify(request).includes("不应重新发送的坏提案"));
    const before = f.store.snapshot(), journal = await f.store.exportJournal(); f.requests.length = 0;
    f.setHandler(async () => body({ externalChanges: [cause], perceptions: [{ actorId: "bot", changeIds: ["gust"], situation: "只有状态栏，没有正文。" }] }));
    await assert.rejects(f.runtime.evolve("仍需正文。", { heartbeat: true }), /perceptions\[0\]\.text/);
    assert.equal(f.requests.length, 3); checkRepairRequests(f.requests, marker);
    assert.deepEqual(f.store.snapshot(), before); assert.equal(await f.store.exportJournal(), journal, "three rejected proposals do not partially commit");
    console.log("PASS truncated native repair omits broken calls/output; full memory above soft target, immutable prefix and precise short repair");
  } finally { await f.close(); }
}

async function quietAndEventOnlyPersistence() {
  for (const initial of ["院子很安静。\n\n\n长椅在树下。", "院子很安静。\n\n\n长椅在树下。\n文件 /home/bot/notes.txt 原文如下\n这段文件原文不可在普通感知中暴露。\n当前日期：1999-01-01。", "当前日期：2020-01-01。\n\n院子很安静。\n\n手机收到一条新消息：你好。"] ) {
    const f = await fixture({ worldState: initial });
    try {
      const saved = f.store.snapshot(), journal = await f.store.exportJournal();
      f.setHandler(async input => body({ worldState: worldInputText(input), externalChanges: [], perceptions: [] }));
      const quiet = await f.runtime.evolve("没有外部变化。", { heartbeat: true });
      assert.equal(quiet.status, "quiet"); assert.equal(quiet.attempts, 1); assert.equal(quiet.perceptions, 0);
      assert.deepEqual(f.store.snapshot(), saved); assert.equal(await f.store.exportJournal(), journal);
      const seen = worldInputText(JSON.parse(f.requests[0]![1]!.content as string));
      assert.ok(!seen.includes("文件原文不可")); assert.ok(!seen.includes("手机收到")); assert.ok(!seen.includes("\n\n\n"));
      for (const provideState of [false, true]) {
        const before = f.store.snapshot();
        f.setHandler(async input => body({ ...(provideState ? { worldState: worldInputText(input) } : {}), externalChanges: [cause], perceptions: [] }));
        const event = await f.runtime.evolve("仅有一阵风经过。", { heartbeat: true });
        assert.equal(event.status, "committed"); assert.equal(event.sequence, before.sequence + 1); assert.equal(event.perceptions, 0);
        assert.equal(f.store.snapshot().worldState, initial); assert.deepEqual(f.store.snapshot().actors, saved.actors);
        const record = JSON.parse((await f.store.exportJournal()).trim().split("\n").at(-1)!);
        assert.deepEqual(record.commit.evolution.changes, [cause]); assert.equal(record.commit.worldState, initial);
      }
    } finally { await f.close(); }
  }
  console.log("PASS quiet projection and hidden file tails preserve archive; same/omitted-state events still commit sources");
}

async function committedEventHistoryAndDistinctClocks() {
  const f = await fixture(), first = { id: "wind-130", description: "一阵风经过长椅。" }, second = { id: "bird-160", description: "一只鸟从院墙飞过。" };
  const inputOfLast = () => JSON.parse(f.requests.at(-1)![1]!.content as string);
  try {
    const initial = f.store.snapshot(); assert.equal(initial.stateUpdatedAt, 100);
    f.setNow(130);
    f.setHandler(async input => body({ worldState: worldInputText(input), externalChanges: [first], perceptions: [] }));
    const firstResult = await f.runtime.evolve("短暂风声。", { heartbeat: true });
    assert.equal(firstResult.status, "committed");
    assert.equal(inputOfLast().evolutionSinceTU, 100); assert.equal(inputOfLast().elapsedWorldSeconds, 30);
    assert.equal(inputOfLast().elapsedEvolutionWorldSeconds, 30); assert.deepEqual(inputOfLast().recentEvolution, []);
    assert.equal(f.store.snapshot().stateUpdatedAt, 100); assert.equal(f.store.snapshot().effectiveAt, 130);

    f.setNow(160);
    f.setHandler(async () => body({ externalChanges: [second], perceptions: [] }));
    const secondResult = await f.runtime.evolve("飞鸟经过。", { heartbeat: true });
    assert.equal(secondResult.status, "committed");
    const secondInput = inputOfLast();
    assert.equal(secondInput.evolutionSinceTU, 130); assert.equal(secondInput.elapsedWorldSeconds, 60);
    assert.equal(secondInput.elapsedEvolutionWorldSeconds, 30);
    assert.deepEqual(secondInput.recentEvolution, [{ sequence: firstResult.sequence, worldTime: 130, changes: [first] }]);
    assert.equal(Object.hasOwn(secondInput, "recentEvolutionScope"), false, "event scope belongs to the stable task rules");
    assert.equal(f.store.snapshot().worldState, initial.worldState); assert.equal(f.store.snapshot().stateUpdatedAt, 100);
    assert.equal(f.store.snapshot().effectiveAt, 160); assert.equal(f.store.lastEvolutionAt(), 160);

    const durable = f.store.snapshot(), journal = await f.store.exportJournal();
    f.setHandler(async () => body({ perceptions: [] }));
    for (const now of [190, 220]) {
      f.setNow(now); const quiet = await f.runtime.evolve("没有新的外部变化。", { heartbeat: true });
      assert.equal(quiet.status, "quiet");
      const input = inputOfLast();
      assert.equal(input.stateAsOf.tu, 100); assert.equal(input.elapsedWorldSeconds, now - 100);
      assert.equal(input.evolutionSinceTU, 160); assert.equal(input.elapsedEvolutionWorldSeconds, now - 160,
        "quiet checks do not fabricate a new durable evolution timestamp");
      assert.deepEqual(input.recentEvolution, [
        { sequence: firstResult.sequence, worldTime: 130, changes: [first] },
        { sequence: secondResult.sequence, worldTime: 160, changes: [second] },
      ], "both same-state and omitted-state transactions remain visible in chronological event history");
      assert.deepEqual(f.store.snapshot(), durable); assert.equal(f.store.lastEvolutionAt(), 160); assert.equal(await f.store.exportJournal(), journal);
    }
    console.log("PASS committed event history feeds subsequent inference; state/evolution elapsed time separate and quiet preserves durable clocks");
  } finally { await f.close(); }
}

async function deadlineRejectsLateProposal() {
  const f = await fixture({ heartbeatTimeoutMs: 20 }), entered = deferred<AbortSignal>(), late = deferred<ChatResult>();
  try {
    const before = f.store.snapshot(), journal = await f.store.exportJournal();
    f.setHandler(async (_input, _messages, signal) => { entered.resolve(signal!); return late.promise; });
    const pending = f.runtime.evolve("慢速心跳。", { heartbeat: true });
    const rejected = assert.rejects(pending, /WORLD_HEARTBEAT_TIMEOUT/);
    const signal = await entered.promise; await rejected;
    assert.equal(signal.aborted, true); assert.equal(f.requests.length, 1);
    late.resolve(body({ externalChanges: [cause], perceptions: [observed] }));
    await tick(); await tick();
    assert.deepEqual(f.store.snapshot(), before); assert.equal(await f.store.exportJournal(), journal, "late successful HTTP output cannot cross expired commit deadline");
    f.setHandler(async () => body({ perceptions: [] }));
    const recovery = await f.runtime.evolve("下一轮仍可正常运行。", { heartbeat: true }); assert.equal(recovery.status, "quiet");
    console.log("PASS heartbeat total deadline aborts inference, prevents late commit and releases next round");
  } finally { late.resolve(body({ perceptions: [] })); await f.close(); }
}

async function main() { await jsonCommitsAndSemanticGuards(); await malformedRepairsPreservePrefix(); await quietAndEventOnlyPersistence(); await committedEventHistoryAndDistinctClocks(); await deadlineRejectsLateProposal(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
