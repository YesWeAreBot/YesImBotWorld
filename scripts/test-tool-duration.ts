import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { ChatBackend } from "../src/bot/backend.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { extractToolCall, ToolCallParseError, validateToolCall } from "../src/llm/parse.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import type { ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const names = ["act", "wait", "rest", "think", "clock.set_timer"];
const description = "缓缓给花盆浇水";
const native = (name: string, args: unknown) => ({ role: "assistant", content: "", tool_calls: [{ id: "duration-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const body = (call: unknown) => ({ role: "assistant", content: JSON.stringify(call) });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(test: () => boolean) { for (let i = 0; i < 1000 && !test(); i++) await sleep(2); assert.ok(test(), "duration fixture did not settle"); }

function parserCases() {
  const parse = (value: unknown) => extractToolCall(JSON.stringify(value), names);
  for (const duration of [0, 0.25, 1800, 7200, "7200"]) {
    const expected = Number(duration);
    for (const call of [
      { name: "act", arguments: { description }, duration },
      { name: "act", arguments: { description, duration } },
      { name: "act", arguments: JSON.stringify({ description, duration }) },
      { name: "act", arguments: { description, duration }, duration: expected },
    ]) assert.deepEqual(parse(call), { name: "act", arguments: { description }, duration: expected });
  }
  assert.deepEqual(parse({ name: "act", arguments: { description } }), { name: "act", arguments: { description }, duration: undefined });
  for (const [top, nested] of [[0, 7200], [7200, 0], [12, 13]]) {
    assert.throws(() => parse({ name: "act", arguments: { description, duration: nested }, duration: top }), /duration.*冲突/);
  }
  for (const value of [-1, NaN, Infinity, -Infinity, null, false, true, [], [7200], {}, "", " ", "NaN", "Infinity", "tomorrow"]) {
    for (const call of [
      { name: "act", arguments: { description }, duration: value },
      { name: "act", arguments: { description, duration: value } },
      { name: "act", arguments: { description, duration: value }, duration: 7200 },
      { name: "act", arguments: { description, duration: 7200 }, duration: value },
    ]) assert.throws(() => validateToolCall(call, names), error => error instanceof ToolCallParseError && /duration/.test(error.message));
  }
  const args = Object.freeze({ description, duration: "7200", target: Object.freeze({ label: "测试嵌套参数" }) });
  const original = Object.freeze({ name: "act", arguments: args, duration: 7200 });
  const normalized = validateToolCall(original, names);
  assert.equal(original.arguments.duration, "7200"); assert.notEqual(normalized.arguments, args);
  assert.equal("duration" in normalized.arguments, false);
  assert.deepEqual(normalized.arguments.target, args.target, "normalization only removes the reserved envelope field");
  assert.deepEqual(parse({ name: "clock.set_timer", arguments: { duration_seconds: 120, label: "茶泡好了" }, duration: 0 }).arguments,
    { duration_seconds: 120, label: "茶泡好了" }, "application-specific duration_seconds stays an application argument");

  const backend = new ChatBackend(Config({}).bot, names) as any;
  for (const duration of [undefined, 0, 7200, "7200"]) {
    const args = { description, ...(duration === undefined ? {} : { duration }) };
    const response: ChatResult = { content: "", toolCalls: native("act", args).tool_calls };
    assert.deepEqual(backend.parseResult(response), parse({ name: "act", arguments: args }), "native/body parsing must produce the same normalized call");
  }
  for (const duration of [null, false, [], -1, " ", "Infinity"]) {
    assert.throws(() => backend.parseResult({ content: "", toolCalls: native("act", { description, duration }).tool_calls }), /duration/);
  }
  console.log("PASS shared duration parsing: nested/top-level equality, conflicts, invalid values, zero/default, no mutation and native/body parity");
}

async function actualActionTiming() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "tool-duration-"));
  let reply: unknown = {}, requests = 0, now = 100;
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* Consume the local model request without logging private content. */ }
    requests++; response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: reply }] }));
  });
  let runtime: NarrativeWorld | undefined, agent: any;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const files = new WorldFiles(base); await files.ensure();
    const context = new BotContext(files); await context.load();
    const cfg = Config({ autoStart: false });
    Object.assign(cfg.bot, { baseURL: `http://127.0.0.1:${address.port}/v1`, model: "duration-fixture", apiKey: "", nativeToolCalls: true, stream: false,
      waitRateThreshold: 0, maxWindowChars: 1_000_000, restCompressMinChars: 1_000_000 });
    cfg.bot.growth.enabled = false;
    const clock: any = { now: () => now, realMsUntil: (at: number) => at > now ? 2 : 0, timeLine: () => `T=${now}`, unitWorldSeconds: 1, unitRealSeconds: 1 };
    const worldRequests: any[] = [], receipts: any[] = [];
    runtime = new NarrativeWorld(files, clock, async messages => {
      const input = JSON.parse([...messages].reverse().find(message => message.role === "user")!.content as string); worldRequests.push(input);
      const starting = input.actionPhase === "start";
      return { content: "", toolCalls: [{ id: "resolve", type: "function", function: { name: "resolve_world", arguments: JSON.stringify({
        perceptions: [{ actorId: "bot", text: starting ? "你拿起水壶，开始缓缓往花盆里浇水。" : "你放下水壶，浇水已经结束。" }],
        outcome: { status: starting ? "ongoing" : "completed" },
      }) } }] };
    });
    const store = await runtime.store();
    await store.commit({ idempotencyKey: "duration-world", source: "fixture", initialized: true, worldState: "桌边有花盆和水壶。", actors: {
      bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在桌边。", perception: "看见花盆和水壶。" },
    } });
    const world: any = { adjudicateAct: (call: ToolCallRecord, deliver: (content: string) => void, signal: AbortSignal, commit: any) => runtime!.act("bot", call, async content => { receipts.push(JSON.parse(content)); await deliver(content); }, signal, commit) };
    const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
    const defs = BOT_TOOLS.filter(tool => names.includes(tool.name));
    agent = new BotAgent(cfg, clock, files, context, world, {} as any, null, null, null, { down: false }, logger, defs) as any;
    agent.running = true;
    const backend = new ChatBackend(cfg.bot, names, defs); agent.backend = backend;
    for (const protocol of ["body", "native"]) {
      agent.refreshToolGate();
      const duration = protocol === "body" ? 7200 : 1800, before = now;
      reply = protocol === "body" ? body({ name: "act", arguments: { description, duration } }) : native("act", { description, duration });
      const parsed = await backend.generate(context, clock.timeLine());
      const call: ToolCallRecord = agent.finalize(parsed);
      assert.equal(call.duration, duration); assert.equal(call.expectedAt, before + duration);
      assert.equal("duration" in call.arguments, false);
      await context.appendToolCall(call); await agent.dispatch(call);
      const id = `bot:${call.id}`;
      await eventually(() => receipts.some(receipt => receipt.action.id === id && receipt.action.phase === "ongoing"));
      assert.equal(store.snapshot().actions[id]!.expectedEnd, before + duration);
      const start = worldRequests.find(request => request.action.id === id && request.actionPhase === "start");
      assert.equal(start.action.expectedEnd, before + duration, "the normalized duration reaches the actual World request");
      now = before + duration - 1; await sleep(8);
      assert.equal(store.snapshot().actions[id]!.status, "pending", "a real ongoing action cannot finish before its intended world time");
      now = before + duration;
      await eventually(() => !agent.scheduler.isPending(call.id)); await agent.drainMailbox();
      assert.equal(store.snapshot().actions[id]!.status, "completed");
      assert.equal(worldRequests.find(request => request.action.id === id && request.actionPhase === "finish").time, now);
    }
    assert.equal(requests, 2, "two protocol fixtures use exactly two Bot requests, without extra inference");
    const parse = (name: string, args: Record<string, unknown>, duration?: number) => validateToolCall({ name, arguments: args, duration }, names);
    assert.equal(agent.finalize(parse("wait", { n: 25 })).expectedAt, now + 25);
    assert.equal(agent.finalize(parse("wait", { n: 25, duration: 0 })).expectedAt, now + 25, "wait retains its n fallback for a zero duration");
    assert.equal(agent.finalize(parse("wait", { n: 25 }, 10)).expectedAt, now + 10, "positive explicit wait duration retains the existing precedence");
    for (const [args, expected] of [[{}, 300], [{ duration: 0 }, 300], [{ duration: 20 }, 20]] as const) {
      const call: ToolCallRecord = agent.finalize(parse("rest", args));
      agent.dispatchRest(call); assert.equal(call.expectedAt, now + expected);
      agent.scheduler.cancel(call.id); agent.waiting = null;
    }
    console.log("PASS real HTTP Bot responses -> Agent scheduling -> World ongoing/finish timing; wait n and rest zero/default semantics preserved");
  } finally {
    await agent?.stop(); await runtime?.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function main() { parserCases(); await actualActionTiming(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
