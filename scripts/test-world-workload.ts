import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { debug } from "../src/webui/debug.js";
import type { ChatMessage, ChatResult, ChatToolDef } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const native = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "test", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const scene = (extra: Record<string, unknown> = {}) => ({ perceptions: [{ actorId: "bot", text: "你走到长椅旁，树影落在椅面。", ...extra }], outcome: { status: "completed" } });
type Handler = (input: any, messages: ChatMessage[], tools: ChatToolDef[]) => ChatResult | Promise<ChatResult>;

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-workload-"));
  const files = new WorldFiles(base); await files.ensure(); await files.writeMeta({ realWorld: false });
  let now = 100, handler: Handler = () => native(scene());
  const requests: any[] = [];
  const clock = { now: () => now, realMsUntil: () => 1, unitRealSeconds: 1, unitWorldSeconds: 1,
    authority: (tu = now) => ({ tu, source: "world_calendar", formatted: "2026-09-27 12:00", date: "2026-09-27", timeLine: "2026-09-27 12:00", timeZone: "Asia/Shanghai", utcOffset: "+08:00", calendarKind: "gregorian", unitRealSeconds: 1, unitWorldSeconds: 1 }) } as any;
  const runtime = new NarrativeWorld(files, clock, (messages, tools) => {
    const input = JSON.parse(String(messages.find(message => message.role === "user")!.content)); requests.push(input);
    return Promise.resolve(handler(input, messages, tools));
  });
  const store = await runtime.store();
  await store.commit({ idempotencyKey: "seed", source: "fixture", initialized: true,
    worldState: "院子里有一张长椅。\n\n秘密：远处的阁楼里放着旧钥匙，角色尚不知道。",
    actors: { bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在院子里。", perception: "院子很安静。" } } });
  const call = (id: string, args: Record<string, unknown> = {}): ToolCallRecord => ({ id, name: "act", role: "agent", arguments: { description: "走到长椅旁", ...args }, issuedAt: now, expectedAt: now });
  return { runtime, store, requests, call, handle: (next: Handler) => { handler = next; }, time: (value: number) => { now = value; },
    close: async () => { await runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function deduplicatedInput() {
  const f = await fixture();
  try {
    const intent = "沿着石板小路走到长椅旁", target = "树下的长椅", words = "下午一起去看老槐树吧。";
    f.handle((input, messages, tools) => {
      const body = JSON.stringify(input);
      for (const value of [intent, target, words]) assert.equal(body.split(value).length - 1, 1, "action arguments appear once in input");
      assert.deepEqual(Object.keys(input.action).sort(), ["expectedEnd", "intent", "speech", "startedAt", "target"]);
      assert.deepEqual(input.pendingActions, []);
      assert.doesNotMatch(body, /requestFingerprint|"stateVersion"|"stateUpdatedAt"|"deviceAuthority"|"recentEvolutionScope"/);
      assert.equal(input.timeAuthority.tu, 100); assert.equal(input.stateAsOf.tu, 100);
      assert.match(JSON.stringify(input.worldDocument), /旧钥匙/);
      assert.equal(Object.hasOwn(input, "worldState"), false);
      assert.doesNotMatch(String(messages[0]!.content), /本次kind=evolve|本次仅处理授权的虚构应用记录/);
      const schema = tools[0]!.function.parameters as any;
      assert.ok(!schema.properties.outcome.properties.status.enum.includes("ongoing"), "a short action has no compulsory timed second phase");
      return native({ perceptions: [{ actorId: "bot", text: `你走到长椅旁，说：“${words}”` }], outcome: { status: "completed", speechSpoken: true } });
    });
    await f.runtime.act("bot", f.call("input", { description: intent, target, speech: words }), () => {});
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(await f.runtime.peek()), /旧钥匙/);
    console.log("PASS one action input, task-specific rules, preserved private facts and single short-action request");
  } finally { await f.close(); }
}

async function optionalFailuresStayOptional() {
  const f = await fixture();
  try {
    const good = { label: "看看落叶", intent: "弯腰辨认长椅下的落叶" };
    f.handle(() => native(scene({ opportunities: [good,
      { label: "看看消息", intent: "打开QQ查看消息" },
      { label: "查日历", intent: "当前日期：1999-01-01" },
      { label: "缺少意图" },
    ] })));
    await f.runtime.act("bot", f.call("suggestions"), () => {});
    assert.equal(f.requests.length, 1);
    assert.deepEqual((await f.runtime.peek()).opportunities, [good]);
    const trace = debug.recent(100).map(entry => { try { return JSON.parse(entry.detail); } catch { return {}; } }).find(entry => entry.id === "bot:suggestions" && entry.timing);
    assert.equal(trace.timing.discardedSuggestions, 3);
    f.handle(() => native(scene({ opportunities: [{ label: "翻消息", intent: "翻翻手机里的消息" }] })));
    await f.runtime.act("bot", f.call("revoke"), () => {});
    assert.deepEqual((await f.runtime.peek()).opportunities, [], "discarded options explicitly revoke a stale menu");
    const before = f.store.snapshot(), requests = f.requests.length;
    f.handle(() => native({ ...scene({ opportunities: [{ label: "非法选项", intent: "打开QQ" }] }), worldState: "当前日期：1999-01-01。" }));
    await assert.rejects(f.runtime.act("bot", f.call("facts-still-validated"), () => {}), /WORLD_TIME_CONFLICT/);
    assert.equal(f.requests.length - requests, 3);
    assert.equal(f.store.snapshot().worldState, before.worldState);
    assert.equal(f.store.snapshot().actors.bot!.state, before.actors.bot!.state);
    console.log("PASS invalid ancillary options cost no repair; factual errors still reject and cannot partially commit");
  } finally { await f.close(); }
}

async function finishWithoutRedundantSpeech() {
  const f = await fixture();
  try {
    const words = "我把长椅擦一下。";
    f.handle((input, _messages, tools) => {
      if (input.actionPhase === "start") {
        f.time(102);
        return native({ perceptions: [{ actorId: "bot", text: `你说：“${words}”然后开始擦拭长椅。` }], outcome: { status: "ongoing", speechSpoken: true } });
      }
      assert.equal(input.actionPhase, "finish");
      const schema = tools[0]!.function.parameters as any;
      assert.equal(schema.properties.outcome.properties.speechSpoken, undefined);
      return native({ perceptions: [{ actorId: "bot", text: "你擦完长椅，收好抹布。" }], outcome: { status: "completed" } });
    });
    await f.runtime.act("bot", { ...f.call("wipe", { description: "擦拭长椅", speech: words }), expectedAt: 102 }, () => {});
    assert.equal(f.requests.length, 2);
    assert.equal(f.store.readPerceptions("bot").filter(p => p.text.includes(words)).length, 1);
    const before = f.requests.length;
    f.handle(() => native(scene()));
    await f.runtime.act("bot", f.call("repeat-one"), () => {});
    await f.runtime.act("bot", f.call("repeat-two"), () => {});
    assert.equal(f.requests.length - before, 2, "a new identical intent must not reuse an old completed result");
    console.log("PASS finish speech defaults to false without re-speaking; repeated new actions retain distinct adjudications");
  } finally { await f.close(); }
}

async function cancelledWorldQueue() {
  const f = await fixture();
  let release!: (value: ChatResult) => void;
  const held = new Promise<ChatResult>(resolve => { release = resolve; });
  let operation: Promise<boolean> | undefined;
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
  let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
  try {
    await f.store.commit({ idempotencyKey: "visitor", source: "fixture", actors: { visitor: {
      id: "visitor", name: "来客", controller: "player", present: true, state: "站在院门旁。", perception: "院门开着。",
    } } });
    f.handle(() => { entered(); return held; });
    operation = f.runtime.act("visitor", f.call("hold"), () => {});
    await entering;
    assert.equal(f.requests.length, 1);
    const observation = f.runtime.observe("bot");
    const rejection = assert.rejects(observation, /abort|cancel/i);
    for (let i = 0; i < 100 && !(f.runtime as any).queue.length; i++) await tick();
    assert.ok((f.runtime as any).queue.length > 0);
    f.runtime.cancel("bot"); await rejection;
    assert.equal(f.requests.length, 1, "cancelled queued observation never requests a model");
    const trace = debug.recent(100).map(entry => { try { return JSON.parse(entry.detail); } catch { return {}; } })
      .find(entry => entry.id?.startsWith("bot:observe:") && entry.stage === "cancelled" && entry.timing?.attempts === 0);
    assert.ok(trace); assert.equal(trace.timing.modelMs, 0); assert.equal(trace.timing.repairMs, 0);
    assert.equal(trace.timing.queueMs, trace.timing.totalMs);
    release(native({ perceptions: [{ actorId: "visitor", text: "你走到长椅旁。" }], outcome: { status: "completed" } }));
    await operation;
    console.log("PASS cancellation inside the World queue records waiting cost with no model generation");
  } finally { release(native(scene())); await operation?.catch(() => {}); await f.close(); }
}

async function main() { await deduplicatedInput(); await optionalFailuresStayOptional(); await finishWithoutRedundantSpeech(); await cancelledWorldQueue(); }
const watchdog = setTimeout(() => { console.error("World regression did not settle"); process.exit(1); }, 30_000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
