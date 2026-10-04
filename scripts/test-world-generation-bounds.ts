import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorldFiles } from "../src/files.js";
import { Prompts } from "../src/prompts.js";
import { WorldAgent } from "../src/world/agent.js";
import { worldResolutionSchema } from "../src/world/proposal.js";
import type { ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const json = (value: unknown): ChatResult => ({ content: JSON.stringify(value), toolCalls: [] });
const completed = (text = "你把杯子放回桌上。") => ({ perceptions: [{ actorId: "bot", text }], outcome: { status: "completed" } });
const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(timeout = 1000, endpoint = `http://${randomUUID()}.invalid`, extra: Record<string, unknown> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "world-generation-bounds-"));
  const files = new WorldFiles(directory); await files.ensure(); await files.writeMeta({ realWorld: false });
  let now = 0;
  const clock = { now: () => now, realMsUntil: () => 2, unitRealSeconds: 1, unitWorldSeconds: 1, syncRealTime: false } as any;
  const world = new WorldAgent({ baseURL: endpoint, model: "offline-fixture", actionTimeoutMs: timeout, maxTokens: 20480, compressMaxInputChars: 24000, ...extra } as any, files, clock, logger, new Prompts());
  const store = await world.runtime.store();
  await store.commit({ idempotencyKey: "fixture", source: "fixture", initialized: true, worldState: "房间里有桌子和杯子。", actors: {
    bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在桌边。", perception: "你站在桌边。" },
  } });
  const call = (id: string, duration = 0): ToolCallRecord => ({ id, name: "act", role: "agent", issuedAt: now, expectedAt: now + duration, duration, arguments: { description: "放下杯子" } });
  return { world, files, store, call, setNow: (value: number) => { now = value; }, close: async () => { await world.shutdown(); await fs.rm(directory, { recursive: true, force: true }); } };
}

async function jsonContractAndValidation() {
  const requests: any[] = [];
  let finishReason = "stop";
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(completed()) }, finish_reason: finishReason }] }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const f = await fixture(1500, `http://127.0.0.1:${address.port}`);
  try {
    assert.equal(await f.world.runtime.act("bot", f.call("json"), () => {}), true);
    const request = requests[0]; assert.equal(request.tools, undefined); assert.equal(request.tool_choice, undefined);
    assert.equal(request.response_format.type, "json_schema"); assert.equal(request.max_tokens, 2048);
    assert.doesNotMatch(request.messages[0].content, /只调用一次resolve_world/);
    const schema = request.response_format.json_schema.schema;
    assert.equal(schema.properties.perceptions.maxItems, 1);
    assert.deepEqual(schema.properties.perceptions.items.properties.actorId.enum, ["bot"]);
    assert.equal(schema.not, undefined, "decoder schema omits unsupported constraints; runtime still rejects conflicting state updates below");
    finishReason = "length";
    await assert.rejects(f.world.runtime.act("bot", f.call("truncated"), () => {}), /LLM_OUTPUT_TRUNCATED/);
    assert.equal(requests.length, 2, "truncated output does not trigger repeated long-output repair requests");
    assert.equal(f.store.snapshot().actions["bot:truncated"]!.status, "failed", "even a parseable fragment is rejected when the provider reports truncation");
    let calls = 0;
    (f.world as any).client = { complete: async () => { calls++; return json({ ...completed(), worldState: "不能保存的候选", worldPatch: { revision: "bad", edits: [] } }); } };
    await assert.rejects(f.world.runtime.act("bot", f.call("conflict"), () => {}), /WORLD_PATCH_CONFLICT/);
    assert.equal(calls, 3); assert.equal(f.store.snapshot().worldState, "房间里有桌子和杯子。");
    (f.world as any).client = { complete: async () => json({ ...completed(), outcome: { status: "completed", speechSpoken: true } }) };
    const speech = f.call("speech"); speech.arguments.speech = "杯子放好了";
    await assert.rejects(f.world.runtime.act("bot", speech, () => {}), /逐字包含请求原话/);
    assert.equal(f.store.snapshot().actions["bot:speech"]!.status, "failed");
    const multi: any = worldResolutionSchema(false, false, { kind: "action", actorIds: ["bot", "visitor:a"] });
    assert.equal(multi.properties.perceptions.maxItems, 2);
    assert.deepEqual(multi.properties.perceptions.items.properties.actorId.enum, ["bot", "visitor:a"]);
    console.log("PASS World JSON schema request without tools, bounded output, explicit recipients and unchanged semantic validation");
  } finally { await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function continuousStreamDeadline() {
  let disconnected = false, chunks = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain fixture */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => { chunks++; res.write('data: {"choices":[{"delta":{"content":" "},"finish_reason":null}]}\n\n'); }, 5);
    res.on("close", () => { disconnected = true; clearInterval(timer); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const f = await fixture(100, `http://127.0.0.1:${address.port}`);
  try {
    const started = performance.now();
    await assert.rejects(f.world.runtime.act("bot", f.call("loop"), () => { throw Error("uncommitted output delivered"); }), /WORLD_ACTION_TIMEOUT/);
    assert.ok(performance.now() - started < 1500); assert.ok(chunks > 2);
    for (let i = 0; i < 50 && !disconnected; i++) await delay(5);
    assert.equal(disconnected, true); assert.equal(f.store.snapshot().actions["bot:loop"]!.status, "failed");
    assert.equal(f.store.snapshot().worldState, "房间里有桌子和杯子。");
    console.log("PASS continuous SSE cannot evade the total action deadline; transport closes and no proposal commits");
  } finally { await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function sharedDeadlineAndLateResult() {
  const f = await fixture(120), late = deferred<ChatResult>();
  let calls = 0, aborted = false;
  (f.world.runtime as any).infer = async (_messages: unknown, _tools: unknown, signal: AbortSignal) => {
    calls++; signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    if (calls === 1) { await delay(65); return json({ perceptions: "invalid" }); }
    return late.promise;
  };
  try {
    const started = performance.now();
    await assert.rejects(f.world.runtime.act("bot", f.call("repair"), () => {}), /WORLD_ACTION_TIMEOUT/);
    assert.equal(calls, 2); assert.equal(aborted, true); assert.ok(performance.now() - started < 230, "repairs must not reset the deadline");
    late.resolve(json({ ...completed(), worldState: "LATE_MUTATION" })); await delay(10);
    assert.equal(f.store.snapshot().worldState, "房间里有桌子和杯子。");
    assert.equal(f.store.snapshot().actions["bot:repair"]!.status, "failed");
    (f.world.runtime as any).infer = async () => json(completed());
    assert.equal(await f.world.runtime.act("bot", f.call("next"), () => {}), true, "abandoned inference releases the world serial worker");
    console.log("PASS repairs share one budget, late noncooperative responses cannot commit, later actions proceed");
  } finally { late.resolve(json(completed())); await f.close(); }
}

async function queuedAndPhysicalWait() {
  const f = await fixture(110), blocker = deferred<ChatResult>();
  let entered = false;
  (f.world.runtime as any).infer = async () => { entered = true; return blocker.promise; };
  try {
    const observation = f.world.runtime.observe(); while (!entered) await delay(2);
    let actionInferences = 0;
    await assert.rejects(f.world.runtime.act("bot", f.call("queued"), () => {}), /WORLD_ACTION_TIMEOUT/);
    blocker.resolve(json({ perceptions: [{ actorId: "bot", text: "你看见桌子。" }] })); await observation;
    assert.equal(f.store.snapshot().actions["bot:queued"], undefined, "an expired request is never accepted later");
    (f.world.runtime as any).infer = async () => { actionInferences++; return json({ ...completed(), outcome: { status: actionInferences === 1 ? "ongoing" : "completed" } }); };
    const work = f.world.runtime.act("bot", f.call("long-physical", 100), () => {});
    while (f.store.snapshot().actions["bot:long-physical"]?.phase !== "ongoing") await delay(2);
    await delay(150); f.setNow(100); assert.equal(await work, true); assert.equal(actionInferences, 2);
    console.log("PASS queue time counts, expired queue entries never execute; committed physical waiting does not spend generation budget");
  } finally { blocker.resolve(json({ perceptions: [{ actorId: "bot", text: "桌子还在原处。" }] })); await f.close(); }
}

async function maintenanceDeadlineAndCompatibility() {
  const f = await fixture(80), late = deferred<ChatResult>();
  let captured: any;
  (f.world as any).client = { complete: async (_messages: unknown, options: any) => { captured = options; return late.promise; } };
  try {
    await assert.rejects(f.world.compress({ persona: "小澈", historySummary: "旧摘要", memoryDigest: "旧记忆", streamText: "已发生的事实。", timeLine: "T=0" }), /WORLD_MAINTENANCE_TIMEOUT/);
    assert.equal(captured.signal.aborted, true); assert.equal(captured.responseSchema, undefined); assert.equal(captured.tools, undefined);
    late.resolve({ content: "<HISTORY_SUMMARY>迟到摘要</HISTORY_SUMMARY><MEMORY_DIGEST>迟到记忆</MEMORY_DIGEST>", toolCalls: [] });
    await delay(5); assert.equal(f.world.queueLength, 0);
  } finally { late.resolve(json({})); await f.close(); }
  const legacy = await fixture(1000, undefined, { responseFormat: "tool", maxTokens: 900 });
  try {
    (legacy.world as any).client = { complete: async (messages: any[], options: any) => {
      assert.equal(options.responseSchema, undefined); assert.equal(options.maxTokens, 900);
      assert.equal(options.toolChoice.function.name, "resolve_world"); assert.equal(options.tools.length, 1);
      assert.deepEqual(options.tools[0].function.parameters.not, { required: ["worldState", "worldPatch"] }, "native tools retain their complete historical declaration");
      assert.match(messages[0].content, /只调用一次resolve_world/); return json(completed());
    } };
    assert.equal(await legacy.world.runtime.act("bot", legacy.call("legacy"), () => {}), true);
    console.log("PASS bounded compression request preserves original memory; explicit tool compatibility and configured smaller output cap");
  } finally { await legacy.close(); }
  const object = await fixture(1000, undefined, { responseFormat: "json_object" });
  try {
    (object.world as any).client = { complete: async (_messages: unknown, options: any) => {
      assert.equal(options.responseFormat, "json_object"); assert.equal(options.tools, undefined);
      assert.deepEqual(options.responseSchema.schema.not, { required: ["worldState", "worldPatch"] }, "JSON object compatibility keeps its full textual contract");
      return json(completed());
    } };
    assert.equal(await object.world.runtime.act("bot", object.call("json-object"), () => {}), true);
  } finally { await object.close(); }
}

async function failureCommitDoesNotInvalidateAnotherActor() {
  const f = await fixture(400), releaseA = deferred<ChatResult>();
  let aEntered = false;
  await f.store.commit({ idempotencyKey: "visitor", source: "fixture", actors: {
    "visitor:b": { id: "visitor:b", name: "访客", controller: "player", present: true, state: "站在另一张桌边。", perception: "你站在另一张桌边。" },
  } });
  (f.world.runtime as any).infer = async (messages: any[]) => {
    const input = JSON.parse(messages[1].content);
    if (input.actorId === "visitor:b") {
      assert.equal(input.actionPhase, "start", "the expired queued finish must never infer");
      await delay(250);
      return json({ perceptions: [{ actorId: "visitor:b", text: "你开始慢慢擦桌面。" }], outcome: { status: "ongoing" } });
    }
    aEntered = true; return releaseA.promise;
  };
  try {
    const b = f.world.runtime.act("visitor:b", f.call("b", 10), () => {});
    const bFailed = assert.rejects(b, /WORLD_ACTION_TIMEOUT/);
    while (f.store.snapshot().actions["visitor:b:b"]?.phase !== "ongoing") await delay(2);
    const a = f.world.runtime.act("bot", f.call("a"), () => {});
    while (!aEntered) await delay(2);
    const sequenceAtA = f.store.snapshot().sequence;
    f.setNow(10); await delay(200);
    assert.equal(f.store.snapshot().sequence, sequenceAtA, "queued B failure cannot change A's input revision while A is generating");
    releaseA.resolve(json({ ...completed(), worldState: "杯子已经放回桌上。" }));
    assert.equal(await a, true, "A's valid result does not fail with VERSION_CONFLICT because B timed out");
    await bFailed;
    assert.equal(f.store.snapshot().actions["bot:a"]!.status, "completed");
    assert.equal(f.store.snapshot().actions["visitor:b:b"]!.status, "failed");
    assert.equal(f.store.snapshot().worldState, "杯子已经放回桌上。");
    const events = f.store.readEvents(0, 1000).filter(event => event.topic === "world.committed");
    const aEnd = events.findIndex(event => (event.payload as any).actionIds.includes("bot:a") && event.sequence > sequenceAtA);
    const bEnd = events.findIndex(event => (event.payload as any).actionIds.includes("visitor:b:b") && event.sequence > sequenceAtA);
    assert.ok(aEnd >= 0 && bEnd > aEnd, "failure termination is durable after the preceding actor's transaction");
    console.log("PASS queued action timeout terminates through the same coordinator without invalidating another actor's in-flight proposal");
  } finally { releaseA.resolve(json(completed())); await f.close(); }
}

async function queuedFailureCannotHangBehindStalledActor() {
  const f = await fixture(160), lateA = deferred<ChatResult>();
  let aEntered = false;
  await f.store.commit({ idempotencyKey: "visitor", source: "fixture", actors: {
    "visitor:b": { id: "visitor:b", name: "访客", controller: "player", present: true, state: "坐在桌边。", perception: "你坐在桌边。" },
  } });
  (f.world.runtime as any).infer = async (messages: any[]) => {
    const input = JSON.parse(messages[1].content);
    if (input.actorId === "visitor:b") {
      await delay(100);
      return json({ perceptions: [{ actorId: "visitor:b", text: "你开始慢慢整理桌面。" }], outcome: { status: "ongoing" } });
    }
    aEntered = true; return lateA.promise;
  };
  try {
    const bFailed = assert.rejects(f.world.runtime.act("visitor:b", f.call("b", 10), () => {}), /WORLD_ACTION_TIMEOUT/);
    while (f.store.snapshot().actions["visitor:b:b"]?.phase !== "ongoing") await delay(2);
    const started = performance.now();
    const aFailed = assert.rejects(f.world.runtime.act("bot", f.call("a"), () => {}), /WORLD_ACTION_TIMEOUT/);
    while (!aEntered) await delay(2);
    f.setNow(10); await Promise.all([aFailed, bFailed]);
    assert.ok(performance.now() - started < 1000, "A's own deadline releases the coordinator even if its provider ignores cancellation");
    assert.equal(f.store.snapshot().actions["bot:a"]!.status, "failed");
    assert.equal(f.store.snapshot().actions["visitor:b:b"]!.status, "failed");
    await f.world.shutdown();
    const finalSequence = f.store.snapshot().sequence;
    lateA.resolve(json({ ...completed(), worldState: "UNCOMMITTED_LATE_STATE" })); await delay(5);
    assert.equal(f.store.snapshot().sequence, finalSequence);
    assert.equal(f.store.snapshot().worldState, "房间里有桌子和杯子。");
    console.log("PASS queued terminal failure stays bounded behind a noncooperative actor; shutdown rejects late old-lifetime state");
  } finally { lateA.resolve(json(completed())); await f.close(); }
}

async function main() { await jsonContractAndValidation(); await continuousStreamDeadline(); await sharedDeadlineAndLateResult(); await queuedAndPhysicalWait(); await maintenanceDeadlineAndCompatibility(); await failureCommitDoesNotInvalidateAnotherActor(); await queuedFailureCannotHangBehindStalledActor(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
