/** Real Bot loop with deterministic delayed tools; no model or platform requests. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ParsedToolCall, ToolCallRecord } from "../src/types.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 2000 && !check(); i++) await sleep(2);
  assert.ok(check(), label);
}
const dirs: string[] = [], agents: any[] = [];
const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const act: ParsedToolCall = { name: "act", arguments: { description: "推开院门看看街上" } };
const hold = (signal: AbortSignal): Promise<ParsedToolCall> => new Promise((_resolve, reject) => {
  const abort = () => reject(signal.reason ?? Error("aborted"));
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
});

async function fixture(first: ParsedToolCall = act, strict: boolean | undefined = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-strict-loop-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files, "frozen tool block"); await context.load();
  const cfg = Config({ autoStart: false }); cfg.bot.growth.enabled = false;
  Object.assign(cfg.bot, { strictToolLoop: strict, nativeToolCalls: false, minIntervalMs: 0, retryDelayMs: 1,
    maxWindowChars: 1e6, restCompressMinChars: 1e6, spillMinChars: 0, waitRateThreshold: 0 });
  cfg.messaging.sendEcho = false;
  const started = Date.now(), clock: any = { now: () => (Date.now() - started) / 1000,
    timeLine: () => "清晨", unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: (at: number) => at * 1000 - (Date.now() - started) };
  const finish = gate(), startedWorld = gate(); let fail = false, status = "completed", commits = 0, sends = 0;
  const world: any = { adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => void, signal: AbortSignal, commit: (phase: string) => boolean) => {
    startedWorld.resolve();
    deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "pending" }, observation: { narrative: "手已经搭上门把。" } }));
    await Promise.race([finish.promise, new Promise((_r, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }))]);
    if (fail) throw Error("裁定服务失败");
    if (!commit("finish")) return false;
    commits++;
    deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status }, observation: { mode: "narrative", actorId: "bot",
      observationId: `result:${call.id}`, sourceEventIds: [`result:${call.id}`], narrative: "门外有人经过。", observedAt: clock.now() } }));
    return true;
  } };
  const sendDone = gate();
  const messenger: any = { resolveKey: async (id: string) => ({ key: id, isPrivate: true }),
    channelMessages: async () => ({ text: "当前聊天记录", originEventIds: [] }),
    sendReceipt: async () => { sends++; await sendDone.promise; return { status: "sent", text: "平台确认已发送。", messageIds: ["m1"] }; } };
  const agent: any = new BotAgent(cfg, clock, files, context, world, messenger, null, null, null, { down: false }, logger, BOT_TOOLS);
  agents.push(agent);
  agent.phoneUi = { chatOpen: true, channelKey: "platform@account:private:friend", channelIsGroup: false, forwardStack: [] };
  agent.attention = "phone";
  const requests: any[][] = [];
  agent.backend = { setToolNames() {}, setToolDefs() {}, generate: async (ctx: BotContext, time: string, signal: AbortSignal) => {
    requests.push(await ctx.toChatMessages(time, false));
    return requests.length === 1 ? structuredClone(first) : hold(signal);
  } };
  return { agent, context, files, cfg, requests, finish, startedWorld, sendDone, fail: () => { fail = true; }, status: (s: string) => { status = s; }, commits: () => commits, sends: () => sends };
}

async function actualResultBeforeNextRequest() {
  assert.equal(Config({}).bot.strictToolLoop, true);
  for (const legacy of [false, true]) {
    const f = await fixture(act, legacy ? undefined : true);
    const before = await f.context.toChatMessages("initial", false);
    f.agent.start(); await f.startedWorld.promise;
    await until(() => !!f.agent.status().awaitingToolResult, "tool result wait is visible");
    f.agent.pushEvent("koishi", { text: "朋友：早上好。", originEventIds: ["chat:new"] });
    f.agent.pushEvent("world", { text: "街口的面包店开门了。", originEventIds: ["outside:new"] });
    await sleep(30);
    assert.equal(f.requests.length, 1, "partial progress and outside messages must not start another model request");
    assert.ok(!f.context.stream.some(e => e.kind === "tool_call" && e.call.name === "wait"));
    f.finish.resolve(); await until(() => f.requests.length === 2, "real result resumes generation");
    const next = JSON.stringify(f.requests[1]);
    assert.match(next, /门外有人经过/); assert.match(next, /朋友：早上好/); assert.match(next, /面包店开门/);
    assert.deepEqual(f.requests[1]!.slice(0, before.length), before, "existing request prefix remains unchanged");
    assert.equal(f.commits(), 1); await f.agent.stop();
  }
}
async function failureAndInputAreResults() {
  for (const failure of [true, false]) {
    const f = await fixture(); failure ? f.fail() : f.status("needs_input");
    f.agent.start(); await f.startedWorld.promise; f.finish.resolve();
    await until(() => f.requests.length === 2, "failure or a decision point returns control");
    assert.match(JSON.stringify(f.requests[1]), failure ? /裁定服务失败/ : /门外有人经过/);
    assert.equal(f.agent.status().awaitingToolResult, null); await f.agent.stop();
  }
}
async function legacyConcurrencyAndCancellation() {
  const async = await fixture(act, false); async.agent.start(); await async.startedWorld.promise;
  await until(() => async.requests.length === 2, "explicitly disabled strict loop preserves independent decisions");
  await async.agent.stop(); async.finish.resolve();
  const f = await fixture(); f.agent.start(); await f.startedWorld.promise;
  await until(() => !!f.agent.status().awaitingToolResult, "strict action is waiting");
  await f.agent.acquireManualControl();
  assert.equal(f.agent.status().paused, true);
  f.agent.setManualPaused(false);
  await until(() => f.requests.length === 2, "cancellation and handback release the generation wait");
  assert.match(JSON.stringify(f.requests[1]), /取消/); assert.equal(f.commits(), 0);
  await f.agent.stop(); f.finish.resolve();
}
async function platformAcknowledgementAndStop() {
  const f = await fixture({ name: "send", arguments: { id: "platform@account:private:friend", msg: "早上好" }, duration: 0.1 });
  f.cfg.bot.ignoreSendDuration = false;
  f.agent.start(); await until(() => !!f.agent.status().awaitingToolResult, "scheduled send owns the turn");
  assert.equal(f.requests.length, 1); assert.equal(f.sends(), 0, "waiting includes the actual scheduled send time");
  await until(() => f.sends() === 1, "send reaches the platform"); await sleep(25);
  assert.equal(f.requests.length, 1, "submitting the request is not receiving its acknowledgement");
  await f.agent.acquireManualControl(); f.agent.setManualPaused(false); await sleep(25);
  assert.equal(f.requests.length, 1, "handback cannot skip an already committed platform request");
  f.sendDone.resolve(); await until(() => f.requests.length === 2, "real platform acknowledgement resumes generation");
  assert.match(JSON.stringify(f.requests[1]), /平台确认已发送/); assert.equal(f.sends(), 1); await f.agent.stop();
  const stop = await fixture(); stop.agent.start(); await stop.startedWorld.promise;
  await Promise.race([stop.agent.stop(), sleep(500).then(() => { throw Error("stop must interrupt a tool-result wait"); })]);
  stop.finish.resolve(); assert.equal(stop.requests.length, 1);
}

async function crossingKeepsOldResultHistorical() {
  const f = await fixture(); f.agent.start(); await f.startedWorld.promise;
  await until(() => !!f.agent.status().awaitingToolResult, "old world's operation is in flight");
  f.agent.pushEvent("system", { text: "现在来到了海边。", experience: { worldTransition: { epoch: "world:seaside" } }, originEventIds: [] });
  f.agent.pushEvent("world", { text: JSON.stringify({ mode: "narrative", actorId: "bot", observationId: "seaside",
    narrative: "眼前是海岸与灯塔。", scene: { eventId: "seaside", actorId: "bot", worldSequence: 1, text: "眼前是海岸与灯塔。",
      opportunities: [{ label: "沿海岸走走", intent: "沿海岸向灯塔散步" }] } }), originEventIds: ["seaside"] });
  await sleep(30); assert.equal(f.requests.length, 1, "routing aborts a generation wait, but does not skip an unfinished actual result");
  f.finish.resolve(); await until(() => f.requests.length === 2, "earlier result arrives with its original provenance");
  const receipt = f.context.stream.find(entry => entry.kind === "event" && entry.event.source === "tool" && entry.event.content.includes("门外有人经过"));
  assert.ok(receipt?.kind === "event" && receipt.event.experience?.historicalWorld);
  assert.equal(receipt.event.experience?.worldEpoch, "world:initial");
  assert.match(receipt.event.contextText!, /先前世界的操作结果，不代表当前处境/);
  assert.deepEqual(f.agent.actionOpportunities().filter((option: any) => option.source === "world").map((option: any) => option.intent), ["沿海岸向灯塔散步"]);
  const before = await f.context.toChatMessages("now", false); await f.agent.stop();
  const loaded = new BotContext(f.files); await loaded.load();
  assert.deepEqual(await loaded.toChatMessages("reload", false), before, "historical result projection survives restart without prefix edits");

  const generating = await fixture(), decision = gate<ParsedToolCall>(); let requests = 0;
  generating.agent.backend.generate = async (_ctx: BotContext, _time: string, signal: AbortSignal) => {
    requests++; return requests === 1 ? Promise.race([decision.promise, hold(signal)]) : hold(signal);
  };
  generating.agent.start(); await until(() => requests === 1, "old-route decision started");
  generating.agent.pushEvent("system", { text: "进入新世界。", experience: { worldTransition: { epoch: "new-route" } }, originEventIds: [] });
  await until(() => requests === 2, "confirmed route change interrupts the obsolete decision");
  decision.resolve(act); await sleep(20);
  assert.equal(generating.commits(), 0);
  assert.ok(!generating.context.stream.some(entry => entry.kind === "tool_call"), "an old-route intention is never interpreted as a new-world action");
  await generating.agent.stop();
}

async function main() {
  try {
    await actualResultBeforeNextRequest(); await failureAndInputAreResults(); await legacyConcurrencyAndCancellation(); await platformAcknowledgementAndStop(); await crossingKeepsOldResultHistorical();
    console.log("PASS strict tool loop: default and legacy configs, final receipts before generation, no wait churn, ordered incoming facts, failures/needs_input, opt-out, cancellation, takeover, committed sends and stop");
  } finally {
    for (const agent of agents) await agent.stop();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
