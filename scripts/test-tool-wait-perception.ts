/** Pending tool results block decisions, not durable perception; isolated real BotAgent loop. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotAgent, type BotPerception } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent, ParsedToolCall, ToolCallRecord } from "../src/types.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string, limit = 1800) {
  const deadline = Date.now() + limit;
  while (!check() && Date.now() < deadline) await pause(2);
  assert.ok(check(), label);
}
function hold(signal: AbortSignal): Promise<ParsedToolCall> {
  return new Promise((_resolve, reject) => { const abort = () => reject(signal.reason ?? Error("stopped"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); });
}
const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const ACTION: ParsedToolCall = { name: "act", arguments: { description: "慢慢推开院门，看看外面" } };
const SEND: ParsedToolCall = { name: "send", arguments: { id: "fixture@self:private:friend", msg: "我在门口" } };

async function fixture(first: ParsedToolCall = ACTION, strictToolLoop = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-tool-wait-perception-"));
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files, "固定的工具说明"); await context.load();
  const cfg = Config({ autoStart: false }); cfg.bot.growth.enabled = false; cfg.messaging.sendEcho = false;
  Object.assign(cfg.bot, { strictToolLoop, interruptibleWorldActions: false, nativeToolCalls: false, ignoreSendDuration: true, minIntervalMs: 0, retryDelayMs: 1,
    maxWindowChars: 1e6, restCompressMinChars: 1e6, spillMinChars: 0, waitRateThreshold: 0 });
  const startedAt = Date.now(), clock: any = { now: () => (Date.now() - startedAt) / 1000, timeLine: () => "白天",
    unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: (at: number) => at * 1000 - (Date.now() - startedAt) };
  const finish = gate(), entered = gate(); let executions = 0, commits = 0;
  // A deliberately slow local provider may return after cancellation. Its result can
  // only commit through the real scheduler's commit callback.
  const world: any = { adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => void, _signal: AbortSignal, commit: (phase: string) => boolean) => {
    executions++; entered.resolve();
    deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "pending" }, observation: { narrative: "手搭上院门。" } }));
    await finish.promise;
    if (!commit("finish")) return false;
    commits++;
    deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "completed" }, observation: { mode: "narrative", actorId: "bot",
      observationId: `result:${call.id}`, sourceEventIds: [`result:${call.id}`], narrative: "院门打开，街上有人经过。", observedAt: clock.now() } }));
    return true;
  } };
  const messenger: any = { resolveKey: async (id: string) => ({ key: id, isPrivate: true }),
    channelMessages: async () => ({ text: "实际消息列表", originEventIds: [] }),
    sendReceipt: async () => { executions++; entered.resolve(); await finish.promise; commits++;
      return { status: "sent", text: "平台已确认这一条消息。", messageIds: ["confirmed-once"] }; } };
  const agent: any = new BotAgent(cfg, clock, files, context, world, messenger, null, null, null, { down: false }, logger, BOT_TOOLS);
  agent.phoneUi = { chatOpen: true, channelKey: "fixture@self:private:friend", channelIsGroup: false, forwardStack: [] }; agent.attention = "phone";
  const requests: any[][] = [], published: BotPerception[] = [];
  agent.backend = { setToolNames() {}, setToolDefs() {}, generate: async (ctx: BotContext, time: string, signal: AbortSignal) => {
    requests.push(await ctx.toChatMessages(time, false));
    return requests.length === 1 ? structuredClone(first) : hold(signal);
  } };
  const unsubscribe = agent.subscribePerceptions((perception: BotPerception) => { published.push(perception); }, agent.perceptionCursor());
  function events(): BotEvent[] { return context.stream.flatMap(entry => entry.kind === "event" ? [entry.event] : []); }
  function notify(text: string, wake: boolean, source: "koishi" | "world" = "koishi") {
    agent.pushEvent(source, { text, originEventIds: [`fixture-notice:${text}`] }, { wake });
  }
  async function assertDelivered(text: string) {
    await until(() => published.some(item => item.event.content === text), `pending result must publish ${text} before tool completion`);
    assert.equal(events().filter(event => event.content === text).length, 1);
    const persisted = await fs.readFile(path.join(dir, "stream.jsonl"), "utf8");
    assert.ok(persisted.includes(text), "a published perception has already been appended durably");
  }
  async function start() { agent.start(); await entered.promise; await until(() => !!agent.status().awaitingToolResult, "the result gate has been entered"); }
  return { dir, files, context, agent, requests, published, events, notify, assertDelivered, start, unsubscribe, finish,
    executions: () => executions, commits: () => commits,
    async close() { unsubscribe(); await agent.stop(); finish.resolve(); await pause(10); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

async function actionPerceptionContinues() {
  const f = await fixture();
  try {
    await f.start();
    const waitId = f.agent.status().awaitingToolResult, frozen = await f.context.toChatMessages("白天", false);
    const originalJournal = await fs.readFile(path.join(f.dir, "stream.jsonl"), "utf8");
    for (const [text, wake, source] of [
      ["手机第一次振动", true, "koishi"], ["手机第二次振动", true, "koishi"],
      ["静音消息已经显示在屏幕上", false, "koishi"], ["窗外的风声变大了", false, "world"],
    ] as const) {
      f.notify(text, wake, source); await f.assertDelivered(text);
      assert.equal(f.agent.status().awaitingToolResult, waitId, "persisting a perception does not release the unfinished operation");
      assert.equal(f.requests.length, 1, "incoming facts cannot trigger another model decision while waiting for a result");
      assert.equal(f.executions(), 1); assert.equal(f.commits(), 0);
    }
    const burst = Array.from({ length: 12 }, (_, index) => `连续通知_${index}`);
    burst.forEach((text, index) => f.notify(text, index % 2 === 0));
    await f.assertDelivered(burst.at(-1)!);
    assert.deepEqual(f.events().filter(event => burst.includes(event.content)).map(event => event.content), burst, "burst delivery remains chronological");
    assert.deepEqual(f.published.filter(item => burst.includes(item.event.content)).map(item => item.event.content), burst);
    assert.equal(new Set(f.published.map(item => item.event.id)).size, f.published.length, "each durable event is published once");
    assert.equal(f.requests.length, 1); assert.equal(f.executions(), 1);
    assert.deepEqual(f.context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call.name] : []), ["act"], "no extra act, wait, rest or poll tool is generated");
    assert.ok((await fs.readFile(path.join(f.dir, "stream.jsonl"), "utf8")).startsWith(originalJournal));
    const afterIncoming = await f.context.toChatMessages("白天", false); assert.deepEqual(afterIncoming.slice(0, frozen.length), frozen);
    f.finish.resolve(); await until(() => f.requests.length === 2, "final action result resumes exactly one next generation");
    assert.match(JSON.stringify(f.requests[1]), /院门打开，街上有人经过/);
    for (const text of burst) assert.ok(JSON.stringify(f.requests[1]).includes(text));
    const resultIndex = f.events().findIndex(event => event.content.includes("院门打开，街上有人经过"));
    assert.ok(resultIndex > f.events().findIndex(event => event.content === burst.at(-1)), "the actual result follows already delivered external perceptions");
    assert.equal(f.commits(), 1); assert.equal(f.executions(), 1); assert.equal(f.agent.status().awaitingToolResult, null);
  } finally { await f.close(); }
}

async function committedSendAndControlHandoff() {
  const f = await fixture(SEND), nextSession: BotPerception[] = [];
  try {
    await f.start();
    f.notify("发送等待期间的通知", false); await f.assertDelivered("发送等待期间的通知");
    const cursor = f.agent.perceptionCursor(); f.unsubscribe(); const formerSessionCount = f.published.length;
    const subscribe = f.agent.subscribePerceptions((perception: BotPerception) => nextSession.push(perception), cursor);
    try {
      const controlled = await f.agent.acquireManualControl(); assert.equal(controlled.busy, true, "a submitted send cannot be undone by taking control");
      f.notify("接管期间的新消息", false);
      await until(() => nextSession.some(item => item.event.content === "接管期间的新消息"), "control mode continues durable perception");
      assert.equal(f.requests.length, 1); assert.equal(f.published.length, formerSessionCount, "closed perception subscribers receive no new control-session data");
      assert.ok(nextSession.every(item => item.sequence > cursor));
      assert.ok(!nextSession.some(item => item.event.content === "发送等待期间的通知"), "new sessions cannot replay private perceptions before their cursor");
      f.agent.setManualPaused(false);
      await until(() => !!f.agent.status().awaitingToolResult, "handback still waits for the committed send");
      f.notify("交还后仍在等待确认的通知", false);
      await until(() => nextSession.some(item => item.event.content === "交还后仍在等待确认的通知"), "handback installs a fresh perception wakeup");
      assert.ok((await fs.readFile(path.join(f.dir, "stream.jsonl"), "utf8")).includes("交还后仍在等待确认的通知"));
      assert.equal(f.requests.length, 1); assert.equal(f.executions(), 1);
      f.finish.resolve(); await until(() => f.requests.length === 2, "the real platform confirmation, not a notice, resumes decisions");
      const request = JSON.stringify(f.requests[1]);
      for (const text of ["发送等待期间的通知", "接管期间的新消息", "交还后仍在等待确认的通知", "平台已确认这一条消息"]) assert.ok(request.includes(text));
      assert.equal(f.executions(), 1); assert.equal(f.commits(), 1);
    } finally { subscribe(); }
  } finally { await f.close(); }
}

async function stopCancelsWaitWithoutLatePublication() {
  const f = await fixture();
  try {
    await f.start(); f.notify("停止前已交付的安静通知", false); await f.assertDelivered("停止前已交付的安静通知");
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([f.agent.stop(), new Promise<never>((_, reject) => { stopTimer = setTimeout(() => reject(Error("stop did not interrupt result waiting")), 1000); })]); }
    finally { clearTimeout(stopTimer); }
    const publications = f.published.length, stream = await fs.readFile(path.join(f.dir, "stream.jsonl"), "utf8");
    const postStop: BotPerception[] = []; f.agent.subscribePerceptions((perception: BotPerception) => postStop.push(perception), 0);
    f.finish.resolve(); await pause(30);
    assert.equal(f.requests.length, 1); assert.equal(f.commits(), 0, "a slow uncommitted action cannot commit after stop");
    assert.equal(f.published.length, publications); assert.deepEqual(postStop, [], "retired perception sessions never replay or publish data");
    assert.equal(await fs.readFile(path.join(f.dir, "stream.jsonl"), "utf8"), stream, "late cancelled provider completion cannot mutate the old context");
    const restored = new BotContext(f.files); await restored.load();
    assert.ok(restored.stream.some(entry => entry.kind === "event" && entry.event.content === "停止前已交付的安静通知"));
    assert.ok(!restored.stream.some(entry => entry.kind === "event" && entry.event.content.includes("院门打开，街上有人经过")));
  } finally { await f.close(); }
}

async function quietPerceptionsDoNotEndWaitOrRest() {
  for (const kind of ["wait", "rest"] as const) {
    const f = await fixture({ name: kind, arguments: kind === "wait" ? { n: 60 } : { duration: 60 }, duration: 60 });
    try {
      f.agent.start(); await until(() => f.agent.waiting?.kind === kind, `${kind} timer is active`);
      const timerId = f.agent.waiting.callId, waiting = structuredClone(f.agent.waiting);
      const due = f.agent.scheduler.pending().find((task: any) => task.id === timerId)?.expectedAt;
      assert.ok(f.agent.scheduler.isPending(timerId));
      for (let index = 0; index < 3; index++) {
        const text = `${kind}期间无需唤醒的感知_${index}`;
        f.notify(text, false, index === 1 ? "world" : "koishi"); await f.assertDelivered(text);
        assert.deepEqual(f.agent.waiting, waiting, "saving passive input does not alter the character's pause state");
        assert.equal(f.agent.scheduler.pending().find((task: any) => task.id === timerId)?.expectedAt, due, "quiet arrivals neither end nor extend the original timer");
        assert.equal(f.agent.scheduler.isPending(timerId), true);
        assert.equal(f.requests.length, 1); assert.equal(f.executions(), 0);
        assert.ok(!f.events().some(event => event.content.includes("计时中断")), "wake=false is not interpreted as an interruption");
      }
      assert.deepEqual(f.context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call.name] : []), [kind]);
      f.notify(`${kind}期间明确要求唤醒的通知`, true);
      await until(() => f.requests.length === 2, "a separately authorized wake still interrupts the timer and resumes generation");
      assert.equal(f.agent.waiting, null); assert.equal(f.agent.scheduler.isPending(timerId), false);
      assert.ok(f.events().some(event => event.content.includes("计时中断")));
      const next = JSON.stringify(f.requests[1]);
      for (let index = 0; index < 3; index++) assert.ok(next.includes(`${kind}期间无需唤醒的感知_${index}`));
      assert.ok(next.includes(`${kind}期间明确要求唤醒的通知`));
    } finally { await f.close(); }
  }
}

async function legacyDeviceWaitAlsoDeliversPerceptions() {
  const f = await fixture(SEND, false);
  try {
    await f.start();
    const pending = f.agent.status().awaitingToolResult;
    for (const [text, wake] of [["非严格模式发送中收到通知", true], ["非严格模式发送中收到静音感知", false]] as const) {
      f.notify(text, wake); await f.assertDelivered(text);
      assert.equal(f.requests.length, 1, "legacy synchronous device calls still own their decision until the actual receipt");
      assert.equal(f.agent.status().awaitingToolResult, pending); assert.equal(f.executions(), 1); assert.equal(f.commits(), 0);
    }
    assert.deepEqual(f.context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call.name] : []), ["send"]);
    f.finish.resolve(); await until(() => f.requests.length === 2, "legacy device completion resumes generation after persisted perceptions");
    const next = JSON.stringify(f.requests[1]);
    assert.match(next, /非严格模式发送中收到通知/); assert.match(next, /非严格模式发送中收到静音感知/); assert.match(next, /平台已确认这一条消息/);
    assert.equal(f.executions(), 1); assert.equal(f.commits(), 1);
  } finally { await f.close(); }
}

async function main() {
  await actionPerceptionContinues(); await committedSendAndControlHandoff(); await stopCancelsWaitWithoutLatePublication(); await quietPerceptionsDoNotEndWaitOrRest(); await legacyDeviceWaitAlsoDeliversPerceptions();
  console.log("PASS tool-wait perception: timely durable/published incoming facts (including wake=false), ordered bursts, no extra generation/tools, actual-result recovery, legacy device waits, wait/rest timer preservation, control-session isolation and prompt stop");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
