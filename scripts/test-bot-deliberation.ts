import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { DeliberationBudget, thoughtError } from "../src/bot/deliberation.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { ToolCallParseError } from "../src/llm/parse.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent, ParsedToolCall, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let i = 0; i < 1500 && !test(); i++) await sleep(2);
  assert.ok(test(), "asynchronous deliberation did not settle");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const dirs: string[] = [], agents: any[] = [];
const thought = (text: string): ParsedToolCall => ({ name: "think", arguments: { thought: text } });
const observation = (id: string) => ({ mode: "narrative", actorId: "bot", observationId: id, sourceEventIds: [id],
  worldSequence: 1, observedAt: 1, entities: [], utterances: [], narrative: "绿植的叶子微微垂下，土壤干燥。" });
const act = (description: string): ParsedToolCall => ({ name: "act", arguments: { description } });
const wait = (): ParsedToolCall => ({ name: "wait", arguments: { n: 3600 } });
function slowWorld() {
  const pending: { call: ToolCallRecord; finish: () => void }[] = [];
  return { pending, world: { adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => void, signal?: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("cancelled")); };
      pending.push({ call, finish: () => { signal?.removeEventListener("abort", abort); resolve(); } });
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    });
    deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "completed", intent: call.arguments.description }, observation: observation(`result:${call.id}`) }));
    return true;
  } } };
}

async function fixture(world: any = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-deliberation-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files, "old tool block"); await context.load();
  const cfg = Config({ autoStart: false });
  Object.assign(cfg.bot, { minIntervalMs: 0, retryDelayMs: 1, maxWindowChars: 1_000_000, restCompressMinChars: 1_000_000,
    nativeToolCalls: false, strictToolLoop: false, waitRateThreshold: 0 });
  cfg.bot.growth.enabled = false;
  const clock: any = { now: () => 10, timeLine: () => "T=10", realMsUntil: (at: number) => at > 10 ? 60_000 : 0,
    unitWorldSeconds: 1, unitRealSeconds: 1, syncRealTime: true };
  const agent = new BotAgent(cfg, clock, files, context, world, {} as any, null, null, null, { down: false }, logger, BOT_TOOLS) as any;
  agents.push(agent);
  let allowed: string[] = [];
  agent.backend = { setToolNames: (names: string[]) => { allowed = [...names]; }, setToolDefs() {} };
  agent.refreshToolGate();
  return { agent, context, files, cfg, clock, allowed: () => allowed };
}

async function localThoughtAndFrozenPrefix() {
  const f = await fixture(new Proxy({}, { get() { throw new Error("thought must never call World"); } }));
  f.agent.running = true;
  const original = await f.context.toChatMessages("original time", true);
  const result = await f.agent.injectExternalToolCall("think", { thought: "也许他只是忙，我还不知道。" }, { duration: 600 });
  assert.equal(result.ok, true);
  assert.equal(f.agent.scheduler.pendingCount, 0, "thinking does not schedule a timer");
  await f.agent.drainMailbox();
  const call = f.context.stream.find(entry => entry.kind === "tool_call");
  assert.equal(call?.kind, "tool_call");
  if (call?.kind !== "tool_call") throw new Error("missing thought");
  assert.equal(call.call.expectedAt, call.call.issuedAt);
  const ack = f.context.stream.find(entry => entry.kind === "event" && entry.event.refToolCallId === call.call.id);
  assert.ok(ack?.kind === "event" && ack.event.experience?.internalThought);
  assert.ok(ack?.kind === "event" && !ack.event.content.includes("也许他"), "do not echo an imagined fact as a new observation");
  assert.deepEqual(await f.agent.growth.recallEvidence({ n: 10 }), []);
  const messages = await f.context.toChatMessages("new time", true);
  assert.ok(ack?.kind === "event" && ack.event.contextText === "", "the internal thought receipt is durable but silent to the model");
  assert.ok(!JSON.stringify(messages).includes("这段内心独白已记下"));
  assert.deepEqual(messages.slice(0, original.length), original, "upgrading and thinking preserve the entire sent prefix");
  assert.equal(messages.filter(message => JSON.stringify(message.content).includes("也许他只是忙")).length, 1);
  const reloaded = new BotContext(f.files, "different tools"); await reloaded.load();
  assert.deepEqual(await reloaded.toChatMessages("restart", true), messages, "thought history survives restart without rerendering the prefix");
  assert.equal((await f.agent.injectExternalToolCall("think", { thought: " " })).ok, false);
  assert.equal((await f.agent.injectExternalToolCall("think", { thought: "🪴".repeat(1201) })).ok, false);
  assert.equal(thoughtError("🪴".repeat(1200)), undefined, "length is Unicode code points, not UTF-16 units");
  assert.ok(f.agent.autonomousDuringPuppet("think"));
  assert.ok(!f.agent.manualTools("puppet").some(tool => tool.name === "think"), "body control cannot replace consciousness");
  f.agent.residentControl = { mode: "puppet", sessionId: "controller" };
  assert.equal((await f.agent.injectExternalToolCall("think", { thought: "替他想" }, { control: f.agent.residentControl })).ok, false);
  await f.agent.stop();
}

async function slowActionAllowsThoughtAndIndependentWork() {
  const slow = slowWorld(); let generations = 0;
  const f = await fixture(slow.world); f.cfg.bot.blockingAct = true;
  const before = await f.context.toChatMessages("frozen", false);
  f.agent.backend.generate = async () => {
    generations++;
    if (generations === 1) return act("看看绿植的叶片与盆土");
    if (generations === 2) return thought("这盆植物让我想起以前的阳台。");
    if (generations === 3) return thought("等看清土壤再决定是否浇水。");
    if (generations === 4) return { name: "observe_device", arguments: { device: "phone" } };
    return wait();
  };
  f.agent.start();
  await until(() => generations === 5 && !!f.agent.waiting);
  await sleep(25);
  assert.equal(generations, 5); assert.equal(slow.pending.length, 1);
  assert.ok(f.context.stream.some(entry => entry.kind === "tool_call" && entry.call.name === "observe_device"), "two thoughts cannot globally pause independent device work");
  assert.equal(f.agent.status().awaitingToolRetry, false);
  for (const name of ["act", "observe", "think"]) assert.ok(!f.allowed().includes(name), `${name} is unavailable while the action is pending / thought allowance is exhausted`);
  assert.ok(f.allowed().includes("observe_device"));
  assert.ok(f.context.stream.some(entry => entry.kind === "event" && entry.event.toolProgress === "pending"), "the unfinished action is announced when a later decision needs its status");
  assert.ok(!f.context.stream.some(entry => entry.kind === "event" && entry.event.content.includes("睡醒")));
  assert.deepEqual((await f.context.toChatMessages("later", false)).slice(0, before.length), before);
  slow.pending[0]!.finish();
  await until(() => generations === 6 && !!f.agent.waiting);
  for (const name of ["act", "think"]) assert.ok(f.allowed().includes(name), `${name} should recover after real delivery`);
  assert.ok(!f.allowed().includes("observe"), "physical observation remains an act intent, never a public tool");
  await f.agent.stop();
}

async function repeatedUnavailableCallsBackoffAndRealResultWakes() {
  const slow = slowWorld(); let generations = 0, released = false;
  const f = await fixture(slow.world);
  f.agent.backend.generate = async () => {
    generations++;
    if (generations === 1) return act("给绿植浇水");
    if (!released) throw new ToolCallParseError("工具 act 此刻不可用");
    return wait();
  };
  f.agent.start(); await until(() => f.agent.status().awaitingToolRetry);
  assert.equal(generations, 3); assert.equal(slow.pending.length, 1);
  assert.equal(f.agent.scheduler.pendingCount, 1);
  await sleep(25); assert.equal(generations, 3, "rejected attempts cannot flood either model or World");
  released = true; slow.pending[0]!.finish();
  await until(() => generations === 4 && !!f.agent.waiting);
  assert.equal(f.agent.parseFailures, 0);
  assert.equal(f.agent.status().awaitingToolRetry, false);
  await f.agent.stop();
}

async function nonblockingActsRemainConcurrent() {
  const slow = slowWorld(); let generations = 0;
  const f = await fixture(slow.world); f.cfg.bot.blockingAct = false;
  f.agent.backend.generate = async () => ++generations <= 4 ? act(["走到窗边", "看看远处的山", "听一听风声", "整理桌面的书本"][generations - 1]!) : wait();
  f.agent.start(); await until(() => generations === 5 && !!f.agent.waiting);
  assert.equal(slow.pending.length, 4, "disabling blockingAct permits more than two independent pending actions");
  assert.equal(f.agent.scheduler.pendingByName("act").length, 4);
  assert.ok(f.allowed().includes("act"));
  assert.equal(f.agent.status().awaitingToolRetry, false);
  await f.agent.stop(); assert.equal(f.agent.scheduler.pendingCount, 0);
}

async function invalidThoughtsYieldWithoutWorldWork() {
  const f = await fixture(); let generations = 0, freshInput = false;
  f.agent.backend.generate = async () => {
    generations++;
    if (generations <= 2) return thought(`等待前的第${generations}个想法`);
    if (!freshInput) throw new ToolCallParseError("工具 think 此刻不可用");
    return generations === 5 ? thought("听见门外有脚步声了，先留意一下。") : { name: "wait", arguments: { n: 3600 } };
  };
  f.agent.start(); await until(() => f.agent.status().awaitingToolRetry);
  assert.equal(generations, 4, "two exhausted-tool corrections are followed by execution backoff");
  assert.equal(f.agent.scheduler.pendingCount, 0, "thought retry backoff needs no pending world task or character timer");
  assert.equal(f.agent.waiting, null);
  assert.ok(!f.allowed().includes("think"), "backoff does not renew the thought allowance");
  assert.equal(f.context.stream.filter(entry => entry.kind === "event" && entry.event.content.includes("工具 think 此刻不可用")).length, 2, "correction messages are durable before backoff");
  await sleep(35);
  assert.equal(generations, 4, "unavailable think must not create a rapid generation loop");
  freshInput = true;
  f.agent.pushEvent("world", "你听见门外传来脚步声。", { originEventIds: ["new-footsteps"] });
  await until(() => generations === 6 && !!f.agent.waiting);
  assert.equal(f.agent.status().awaitingToolRetry, false);
  assert.equal(f.agent.parseFailures, 0);
  assert.ok(f.allowed().includes("think"), "actual new perception restores the allowance");
  assert.ok(f.context.stream.some(entry => entry.kind === "tool_call" && entry.call.arguments.thought === "听见门外有脚步声了，先留意一下。"));
  assert.ok(!f.context.stream.some(entry => entry.kind === "tool_call" && entry.call.name === "rest"), "scheduler backoff never fabricates character rest");
  await f.agent.stop();

  const invalid = await fixture(); let invalidGenerations = 0;
  invalid.agent.backend.generate = async () => { invalidGenerations++; return thought(" "); };
  invalid.agent.start(); await until(() => invalid.agent.status().awaitingToolRetry);
  assert.equal(invalidGenerations, 2, "invalid thought arguments also enter bounded correction backoff");
  invalid.agent.setManualPaused(true);
  await until(() => !invalid.agent.status().awaitingToolRetry);
  assert.equal(invalidGenerations, 2, "taking control interrupts backoff without another autonomous request");
  invalid.agent.setManualPaused(false);
  await until(() => invalid.agent.status().awaitingToolRetry);
  assert.equal(invalidGenerations, 3);
  await Promise.race([invalid.agent.stop(), sleep(500).then(() => { throw new Error("stop blocked on thought retry backoff"); })]);
  assert.equal(invalid.agent.status().awaitingToolRetry, false);

  const legacy = await fixture(); let legacyGenerations = 0;
  legacy.agent.backend.generate = async () => { legacyGenerations++; throw new ToolCallParseError("工具 observe 此刻不可用，主动观察已合并到 act(description)"); };
  legacy.agent.start(); await until(() => legacy.agent.status().awaitingToolRetry);
  assert.equal(legacyGenerations, 2);
  assert.ok(!legacy.allowed().includes("observe"));
  assert.ok(!legacy.agent.manualTools().some((tool: any) => tool.name === "observe"));
  assert.equal((await legacy.agent.injectExternalToolCall("observe", { intent: "看看周围" })).ok, false);
  await Promise.race([legacy.agent.stop(), sleep(500).then(() => { throw new Error("stop blocked on unavailable-tool retry"); })]);
  const unknown = await fixture(); let unknownGenerations = 0;
  unknown.agent.backend.generate = async () => { unknownGenerations++; throw new ToolCallParseError('未知工具 "invented"'); };
  unknown.agent.start(); await until(() => unknown.agent.status().awaitingToolRetry);
  assert.equal(unknownGenerations, 2); await unknown.agent.stop();
}

async function manualTakeoverAndCancellationWakeLoop() {
  let generations = 0;
  const f = await fixture();
  const controlled: ToolCallRecord = { id: "controlled-act", name: "act", arguments: { description: "倒水" }, role: "system",
    control: { mode: "puppet", sessionId: "body" }, issuedAt: 10, expectedAt: 10 };
  f.agent.residentControl = { mode: "puppet", sessionId: "body" };
  f.agent.puppetCalls.add(controlled.id);
  f.agent.schedule(controlled, { executeAt: "now", cancellation: "cooperative", run: (task: any) => new Promise((_resolve, reject) => {
    task.signal.addEventListener("abort", () => reject(task.signal.reason), { once: true });
  }) });
  let cancelled = false;
  f.agent.backend.generate = async () => {
    generations++;
    if (generations <= 2) return thought(`第${generations}个自己的想法`);
    if (!cancelled) throw new ToolCallParseError("工具 think 此刻不可用");
    return wait();
  };
  f.agent.start(); await until(() => f.agent.status().awaitingToolRetry);
  assert.equal(generations, 4);
  cancelled = true;
  assert.equal(f.agent.cancelExternalTool(controlled.id, "body").ok, true);
  await until(() => generations === 5 && !!f.agent.waiting);
  assert.equal(f.agent.status().awaitingToolRetry, false);
  await f.agent.stop();

  const slow = slowWorld();
  const avatar = await fixture(slow.world);
  let next = 0;
  avatar.agent.backend.generate = async () => {
    if (++next === 1) return act("看看院门边的告示牌");
    throw new ToolCallParseError("工具 act 此刻不可用");
  };
  avatar.agent.start(); await until(() => avatar.agent.status().awaitingToolRetry);
  avatar.agent.setManualPaused(true);
  avatar.agent.pushEvent("system", "接管期间的系统输入");
  await until(() => avatar.context.stream.some(entry => entry.kind === "event" && entry.event.content === "接管期间的系统输入"));
  assert.equal(avatar.agent.status().awaitingToolRetry, false);
  assert.equal(next, 3, "taking control wakes backoff but does not request another autonomous call");
  await avatar.agent.stop(); assert.equal(avatar.agent.scheduler.pendingCount, 0);
}

async function pendingActionReturnsDuringRest() {
  const finished = deferred<void>();
  const f = await fixture({ adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => void) => {
    await finished.promise;
    deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "completed", intent: "给绿植浇水" },
      observation: { ...observation("watered"), narrative: "水渗进盆土，土色变深。" } }));
    return true;
  } });
  f.agent.running = true;
  const action: ToolCallRecord = { id: "tc_water", name: "act", arguments: { description: "给绿植浇水" }, role: "agent", issuedAt: 10, expectedAt: 10 };
  await f.context.appendToolCall(action); await f.agent.dispatch(action);
  assert.ok(!f.allowed().includes("act") && !f.allowed().includes("observe"));
  f.agent.dispatchRest({ id: "tc_timer", name: "rest", arguments: { duration: 3600 }, role: "agent", issuedAt: 10, expectedAt: 3610 });
  assert.deepEqual(f.agent.waiting.worldCalls, [action.id]);
  finished.resolve();
  await until(() => f.agent.waiting === null);
  assert.ok(f.allowed().includes("act") && !f.allowed().includes("observe"));
  assert.equal(f.agent.scheduler.pendingCount, 0);
  await f.agent.drainMailbox();
  const timer = f.context.stream.find(entry => entry.kind === "event" && entry.event.refToolCallId === "tc_timer");
  assert.ok(timer?.kind === "event" && /已有操作的结果到达/.test(timer.event.content));
  assert.ok(timer?.kind === "event" && !/睡醒|恢复体力/.test(timer.event.content));
  await f.agent.stop();
}

async function committedBeginningArrivesBeforeDeadline() {
  const finished = deferred<void>();
  const f = await fixture({ adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => Promise<void>, _signal: AbortSignal,
    commit: (phase: "start" | "finish") => boolean) => {
    assert.equal(commit("start"), true);
    await deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "pending", phase: "ongoing", intent: "走向院门" },
      observation: { ...observation("walk-start"), narrative: "你走上通往院门的小径，脚下石板仍湿润。" } }));
    await finished.promise;
    if (!commit("finish")) return false;
    await deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "completed", phase: "finished", intent: "走向院门" },
      observation: { ...observation("walk-finish"), narrative: "你抵达院门，看见门边的信箱。" } }));
    return true;
  } });
  f.agent.running = true;
  const call: ToolCallRecord = { id: "tc_stages", name: "act", arguments: { description: "走向院门" }, role: "agent", issuedAt: 10, expectedAt: 310 };
  await f.context.appendToolCall(call); await f.agent.dispatch(call);
  await until(() => f.agent.scheduler.pendingCount === 1);
  await f.agent.drainMailbox();
  const start = f.context.stream.find(entry => entry.kind === "event" && entry.event.content.includes("石板仍湿润"));
  assert.ok(start?.kind === "event", "a committed beginning is immediately available without advancing the clock");
  assert.equal(start.event.experience?.outcome, "unknown", "beginning is not a successful final outcome");
  assert.equal(start.event.experience?.opportunity, false, "beginning is not a completed autonomous choice for growth");
  assert.equal(f.agent.scheduler.pending()[0].committed, false, "remaining work can still be cancelled");
  finished.resolve();
  await until(() => f.agent.scheduler.pendingCount === 0);
  await f.agent.drainMailbox();
  assert.ok(f.context.stream.some(entry => entry.kind === "event" && entry.event.content.includes("看见门边的信箱")),
    "an available final result must not wait again for the scheduler deadline");
  assert.ok(f.allowed().includes("act"));
  await f.agent.stop();
}

function noSyntheticProgress() {
  const budget = new DeliberationBudget();
  const event = (id: string, content: string): BotEvent => ({ id, source: "tool", worldTime: 1, content });
  const read = { name: "view_note", arguments: { title: "求职" } };
  budget.perceive(event("r1", "同一份笔记"), read);
  budget.recordThought("一个想法"); budget.recordThought("另一个想法");
  assert.equal(budget.canThink, false);
  assert.equal(budget.perceive(event("r2", "同一份笔记"), read), false);
  assert.equal(budget.perceive(event("timer", "计时结束"), { name: "rest", arguments: {} }), false);
  assert.equal(budget.perceive({ ...event("self", "想象"), experience: { internalThought: true } }), false);
  assert.equal(budget.canThink, false);
  assert.equal(budget.perceive(event("r3", "实际改过的笔记"), read), true);
  assert.equal(budget.canThink, true);
}

async function main() {
  try {
    noSyntheticProgress();
    await localThoughtAndFrozenPrefix();
    await slowActionAllowsThoughtAndIndependentWork();
    await repeatedUnavailableCallsBackoffAndRealResultWakes();
    await nonblockingActsRemainConcurrent();
    await invalidThoughtsYieldWithoutWorldWork();
    await manualTakeoverAndCancellationWakeLoop();
    await pendingActionReturnsDuringRest();
    await committedBeginningArrivesBeforeDeadline();
    console.log("PASS inner thought integration: local receipts, frozen history, blockingAct semantics, independent work/concurrent actions, bounded invalid-call retries, wake/cancel/takeover and evidence boundaries");
  } finally {
    for (const agent of agents) await agent.stop();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
