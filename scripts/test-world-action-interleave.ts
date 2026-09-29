/** Real BotAgent scheduling with delayed local providers; no model/platform/production access. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { applyPhonePhysicalState } from "../src/phone-state.js";
import type { BotEvent, ParsedToolCall, PhoneStatus, ToolCallRecord } from "../src/types.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string, limit = 2500) {
  const deadline = Date.now() + limit;
  while (!check() && Date.now() < deadline) await pause(2);
  assert.ok(check(), label);
}
function hold(signal: AbortSignal): Promise<ParsedToolCall> {
  return new Promise((_resolve, reject) => { const abort = () => reject(signal.reason ?? Error("stopped"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); });
}
const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const CHANNEL = "fixture@self:room";
const ACTION: ParsedToolCall = { name: "act", arguments: { description: "慢慢推开院门，看看外面" } };
const READ: ParsedToolCall = { name: "read_channel", arguments: { id: CHANNEL } };
const SEND: ParsedToolCall = { name: "send", arguments: { id: CHANNEL, msg: "我在门口，等一下就来。" } };
const HELP: ParsedToolCall = { name: "help", arguments: { tool: "send" } };
type Decision = (index: number, signal: AbortSignal) => ParsedToolCall | Promise<ParsedToolCall>;

async function fixture(decide: Decision, options: { strict?: boolean; interruptible?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-world-interleave-"));
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files, "固定工具声明"); await context.load();
  const cfg = Config({ autoStart: false }); cfg.bot.growth.enabled = false; cfg.messaging.sendEcho = false;
  Object.assign(cfg.bot, { nativeToolCalls: false, ignoreSendDuration: true, minIntervalMs: 0, retryDelayMs: 1,
    maxWindowChars: 1e6, restCompressMinChars: 1e6, spillMinChars: 0, waitRateThreshold: 0, repeatThresholds: [] });
  if (options.strict !== undefined) cfg.bot.strictToolLoop = options.strict;
  if (options.interruptible !== undefined) cfg.bot.interruptibleWorldActions = options.interruptible;
  cfg.world.waitNarrateMinRealSeconds = 0;
  const started = Date.now(), clock: any = { now: () => (Date.now() - started) / 1000, timeLine: () => "白天",
    unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: (at: number) => at * 1000 - (Date.now() - started) };
  const finish = gate(), entered = gate(), sendDone = gate();
  const phone: PhoneStatus = { down: false };
  let actions = 0, commits = 0, sends = 0, reads = 0, holdSend = false, failRead = false, uniqueRead = false, disablePhone = false;
  let longRead = false, reformattedRead = false, earlyCommit = false;
  const world: any = { adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => void, _signal: AbortSignal, commit: (phase: string) => boolean) => {
    actions++; entered.resolve();
    if (earlyCommit && !commit("finish")) return false;
    deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "pending" }, observation: { narrative: "手搭上院门。" } }));
    await finish.promise;
    if (!commit("finish")) return false;
    commits++;
    if (disablePhone) {
      applyPhonePhysicalState(phone, { reachable: false, location: "留在屋里", usable: true, perceptible: true });
      agent.phonePhysicalStateChanged();
    }
    deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "completed" }, observation: { mode: "narrative", actorId: "bot",
      observationId: `result:${call.id}`, sourceEventIds: [`result:${call.id}`], narrative: "院门打开，街上有人经过。", observedAt: clock.now() } }));
    return true;
  } };
  const messenger: any = { resolveKey: async (id: string) => ({ key: id, isPrivate: false }),
    channelMessages: async () => { reads++; if (failRead) throw Error(`读屏请求失败 ${reads}`);
      return { text: `群友：今天要去哪里？${uniqueRead ? ` 新消息 ${reads}` : ""}${longRead ? "很长的旧消息。".repeat(1000) : ""}${reformattedRead ? ` 已刷新显示 ${reads}` : ""}`,
        ...(longRead ? {} : { originEventIds: [`chat:read:${uniqueRead ? reads : 1}`] }) }; },
    sendReceipt: async () => { sends++; if (holdSend) await sendDone.promise;
      return { status: "sent", text: "平台确认已经发送到群里。", messageIds: [`sent:${sends}`] }; },
  };
  const agent: any = new BotAgent(cfg, clock, files, context, world, messenger, null, null, null, phone, logger, BOT_TOOLS);
  agent.phoneUi = { chatOpen: true, channelKey: CHANNEL, channelIsGroup: true, forwardStack: [] }; agent.attention = "phone";
  const requests: { messages: any[]; tools: string[] }[] = []; let tools: string[] = [];
  agent.backend = { setToolNames(names: string[]) { tools = [...names]; }, setToolDefs() {},
    generate: async (ctx: BotContext, time: string, signal: AbortSignal) => {
      requests.push({ messages: await ctx.toChatMessages(time, false), tools: [...tools] });
      return structuredClone(await decide(requests.length, signal));
    } };
  function events(): BotEvent[] { return context.stream.flatMap(entry => entry.kind === "event" ? [entry.event] : []); }
  function calls(): ToolCallRecord[] { return context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call] : []); }
  function notify(root: string, wake = true, source: "koishi" | "world" = "koishi", own = false) {
    agent.pushEvent(source, { text: `通知 ${root}`, originEventIds: [root],
      ...(own ? { experience: { agency: "self", chat: { channelKey: CHANNEL, kind: "send", senderOwn: true } } } : {}) }, { wake });
  }
  async function start() { agent.start(); await entered.promise; await until(() => !!agent.status().awaitingToolResult, "World result is pending"); }
  async function waiting() { await until(() => !!agent.status().awaitingToolResult, "independent work returns to result wait"); await pause(25); }
  async function close() { await agent.stop(); finish.resolve(); sendDone.resolve(); await pause(10); await agent.receipts.settled(); await fs.rm(dir, { recursive: true, force: true }); }
  return { agent, cfg, context, files, dir, requests, events, calls, notify, start, waiting, close, finish, sendDone,
    actions: () => actions, commits: () => commits, sends: () => sends, reads: () => reads,
    holdSend: () => { holdSend = true; }, failRead: () => { failRead = true; }, uniqueRead: () => { uniqueRead = true; }, disablePhone: () => { disablePhone = true; },
    longRead: () => { longRead = true; cfg.bot.spillMinChars = 100; }, reformattedRead: () => { reformattedRead = true; }, earlyCommit: () => { earlyCommit = true; } };
}

async function realChatAdmitsOrderedDeviceWork() {
  assert.equal(Config({}).bot.strictToolLoop, true); assert.equal(Config({}).bot.interruptibleWorldActions, true);
  const sequence = [ACTION, READ, SEND, { name: "think", arguments: { thought: "已经回给大家了，等院门这边的实际结果。" } }, HELP];
  const f = await fixture((index, signal) => sequence[index - 1] ?? hold(signal)); f.holdSend();
  try {
    await f.start(); const prefix = await f.context.toChatMessages("白天", false);
    f.notify("quiet", false); f.notify("world-only", true, "world"); f.notify("own-send", true, "koishi", true);
    await until(() => f.events().some(event => event.content === "通知 own-send"), "quiet and own observations still persist");
    assert.equal(f.requests.length, 1, "World progress, quiet delivery and own echoes cannot open independent work");
    f.notify("quiet", true); await f.waiting();
    assert.equal(f.requests.length, 1, "an already delivered quiet root is not new input when replayed as wakeable");
    f.notify("chat:one"); await until(() => f.sends() === 1, "new group chat permits reading and sending before World completion");
    assert.equal(f.actions(), 1); assert.equal(f.commits(), 0); assert.equal(f.requests.length, 3);
    assert.match(JSON.stringify(f.requests[1].messages), /通知 chat:one/);
    assert.match(JSON.stringify(f.requests[2].messages), /群友：今天要去哪里/);
    assert.deepEqual(f.requests[1].messages.slice(0, prefix.length), prefix, "old context prefix stays byte-for-byte represented");
    for (const request of f.requests.slice(1)) {
      assert.ok(request.tools.includes("send"));
      for (const name of ["act", "travel", "go_home", "observe"]) assert.ok(!request.tools.includes(name), `${name} is dependent and unavailable`);
    }
    f.notify("chat:during-send"); await until(() => f.events().some(event => event.content === "通知 chat:during-send"), "new input persists while send awaits acknowledgement");
    await pause(25); assert.equal(f.requests.length, 3, "new chat cannot bypass a real device acknowledgement");
    f.sendDone.resolve(); await until(() => f.calls().length === 5, "confirmed send permits a short thought and independent followup"); await f.waiting();
    assert.equal(f.requests.length, 5, "thought/help receipts cannot spin the loop");
    assert.match(JSON.stringify(f.requests[3].messages), /平台确认已经发送到群里/);
    assert.ok(!f.calls().some(call => ["wait", "rest"].includes(call.name)), "scheduling suspension invents no character action");
    const availabilityCount = f.events().filter(event => event.toolAvailability).length;
    f.notify("passive", false); await f.waiting(); assert.equal(f.events().filter(event => event.toolAvailability).length, availabilityCount, "passive arrivals do not repeat full capability append events");
    f.finish.resolve(); await until(() => f.requests.length === 6, "actual World completion restores ordinary decisions");
    assert.match(JSON.stringify(f.requests[5].messages), /院门打开，街上有人经过/); assert.equal(f.commits(), 1);
  } finally { await f.close(); }
}

async function failuresAndRepeatedReadsDoNotRenew() {
  for (const variant of ["read", "failure", "help", "spill", "format"] as const) {
    const f = await fixture(index => index === 1 ? ACTION : variant === "help" ? HELP : { ...READ, arguments: { id: CHANNEL, n: index * 10 } });
    if (variant === "failure") f.failRead();
    if (variant === "spill") f.longRead();
    if (variant === "format") f.reformattedRead();
    try {
      await f.start(); f.notify(`chat:${variant}`);
      await until(() => f.calls().length === 3, `${variant}: two admitted decisions completed`); await f.waiting();
      assert.equal(f.requests.length, 3, `${variant}: identical result text, errors or help cannot renew the allowance`);
      f.notify(`chat:${variant}`); f.notify(`quiet:${variant}`, false); f.notify(`outside:${variant}`, true, "world"); await f.waiting();
      assert.equal(f.requests.length, 3, "duplicate roots, quiet input and World observations do not reopen the window");
      f.notify(`new:${variant}`); await until(() => f.calls().length === 5, "a fresh external root opens another short window"); await f.waiting();
      assert.equal(f.requests.length, 5); assert.equal(f.actions(), 1);
      assert.ok(!f.calls().some(call => ["wait", "rest"].includes(call.name)));
    } finally { await f.close(); }
  }
}

async function boundedEvenWithContinuousProgress() {
  const f = await fixture(index => index === 1 ? ACTION : READ); f.uniqueRead();
  try {
    await f.start(); f.notify("chat:bounded"); await until(() => f.calls().length === 9, "eight independent decisions can obtain fresh device facts"); await f.waiting();
    assert.equal(f.requests.length, 9); assert.equal(f.reads(), 8); assert.equal(f.actions(), 1); assert.equal(f.commits(), 0);
    const before = await fs.readFile(path.join(f.dir, "stream.jsonl"), "utf8"); await pause(35);
    assert.equal(await fs.readFile(path.join(f.dir, "stream.jsonl"), "utf8"), before, "budget exhaustion appends no invented completion, failure or pause");
    f.notify("chat:bounded-new"); await until(() => f.calls().length === 17, "a genuinely new chat supplies a new bounded window"); await f.waiting();
    assert.equal(f.reads(), 16); assert.equal(f.requests.length, 17); assert.equal(f.actions(), 1);
  } finally { await f.close(); }
}

async function readbackIsNotANewExternalMessage() {
  const f = await fixture(index => index === 1 ? ACTION : { ...SEND, arguments: { ...SEND.arguments, msg: `群回复 ${index}` } });
  f.cfg.messaging.sendEcho = true; f.uniqueRead();
  try {
    await f.start(); f.notify("chat:echo"); await until(() => f.calls().length >= 9, "confirmed sends and their readbacks can finish independent work"); await f.waiting();
    assert.equal(f.requests.length, 9); assert.equal(f.sends(), 8); assert.equal(f.reads(), 8);
    assert.ok(f.events().some(event => event.source === "koishi" && event.content.includes("新消息 8")), "readback remains a truthful separate observation");
    f.notify("chat:read:8"); await f.waiting();
    assert.equal(f.requests.length, 9, "replaying a message already delivered by readback cannot open another window");
    assert.equal(f.actions(), 1); assert.equal(f.commits(), 0);
  } finally { await f.close(); }
}

async function explicitPausesRemainReal() {
  for (const kind of ["wait", "rest"] as const) {
    const duration = kind === "wait" ? 0.05 : 30;
    const f = await fixture((index, signal) => index === 1 ? ACTION : index === 2
      ? { name: kind, arguments: kind === "wait" ? { n: duration } : { duration }, duration }
      : hold(signal));
    try {
      await f.start(); f.notify(`chat:${kind}`); await until(() => f.agent.waiting?.kind === kind, `${kind} schedules a real timer`);
      const pauseId = f.agent.waiting.callId;
      f.notify(`quiet:${kind}`, false); await pause(20); assert.equal(f.requests.length, 2);
      if (kind === "wait") {
        await until(() => f.agent.waiting === null, "the timer ends normally even while a World action remains pending"); await f.waiting();
        assert.equal(f.requests.length, 2, "a timer result does not recreate independent-work credit");
        assert.ok(f.events().some(event => event.refToolCallId === pauseId && event.content.includes("等待结束")));
        f.notify("chat:after-wait"); await until(() => f.requests.length === 3, "new chat can reopen after elapsed wait");
      } else {
        assert.equal(f.agent.waiting.callId, pauseId); assert.equal(f.agent.scheduler.isPending(pauseId), true);
        f.finish.resolve(); await until(() => f.requests.length === 3, "real World completion interrupts rest by the existing wake policy");
        assert.equal(f.agent.waiting, null); assert.equal(f.agent.scheduler.isPending(pauseId), false);
        assert.match(JSON.stringify(f.requests[2].messages), /院门打开，街上有人经过/);
      }
    } finally { await f.close(); }
  }
}

async function dependentDecisionCannotRaceWorldCompletion() {
  for (const name of ["act", "travel", "go_home"] as const) {
    const delayed = gate<ParsedToolCall>();
    const f = await fixture((index, signal) => index === 1 ? ACTION : index === 2 ? Promise.race([delayed.promise, hold(signal)]) : hold(signal));
    try {
      await f.start(); f.notify(`chat:race:${name}`); await until(() => f.requests.length === 2, "independent request starts without final action facts");
      assert.ok(!JSON.stringify(f.requests[1].messages).includes("院门打开，街上有人经过"));
      f.finish.resolve(); await until(() => f.commits() === 1, "World completes while the model is still deciding");
      delayed.resolve({ name, arguments: name === "act" ? { description: "走过已经打开的门" } : name === "travel" ? { world: "山间" } : {} });
      await until(() => f.requests.length === 3, "the obsolete dependent intention is rejected, then actual facts are delivered");
      assert.equal(f.actions(), 1); assert.match(JSON.stringify(f.requests[2].messages), /本次决定|实际结果尚未进入/);
      assert.match(JSON.stringify(f.requests[2].messages), /院门打开，街上有人经过/);
    } finally { await f.close(); }
  }
}

async function currentPhysicalGateAndCommittedWriteTruth() {
  const delayed = gate<ParsedToolCall>();
  const blocked = await fixture((index, signal) => index === 1 ? ACTION : index === 2 ? Promise.race([delayed.promise, hold(signal)]) : hold(signal)); blocked.disablePhone();
  try {
    await blocked.start(); blocked.notify("chat:lost-phone"); await until(() => blocked.requests.length === 2, "device decision starts with reachable phone");
    blocked.finish.resolve(); await until(() => blocked.commits() === 1, "World commits the changed physical state"); delayed.resolve(SEND);
    await until(() => blocked.requests.length === 3, "new physical state is checked before device execution");
    assert.equal(blocked.sends(), 0); assert.match(JSON.stringify(blocked.requests[2].messages), /够不到手机/);
  } finally { await blocked.close(); }

  const committed = await fixture((index, signal) => index === 1 ? ACTION : index === 2 ? SEND : hold(signal)); committed.disablePhone(); committed.holdSend();
  try {
    await committed.start(); committed.notify("chat:committed"); await until(() => committed.sends() === 1, "platform write is already submitted");
    committed.finish.resolve(); await until(() => committed.commits() === 1, "phone becomes unreachable after write was committed");
    await pause(25); assert.equal(committed.requests.length, 2, "World completion cannot skip the pending platform acknowledgement");
    committed.sendDone.resolve(); await until(() => committed.requests.length === 3, "the already committed write still reports its actual result");
    assert.match(JSON.stringify(committed.requests[2].messages), /平台确认已经发送到群里/);
    const send = committed.calls().find(call => call.name === "send")!;
    assert.ok(committed.events().some(event => event.refToolCallId === send.id && event.experience?.outcome === "completed"));
    assert.ok(!committed.events().some(event => event.refToolCallId === send.id && event.experience?.outcome === "failed"));
  } finally { await committed.close(); }
}

async function cancellationFencesAndCompatibility() {
  for (const mode of ["stop", "takeover"] as const) {
    const delayed = gate<ParsedToolCall>();
    const f = await fixture((index, signal) => index === 1 ? ACTION : index === 2 ? Promise.race([delayed.promise, hold(signal)]) : hold(signal));
    try {
      await f.start(); f.notify(`chat:${mode}`); await until(() => f.requests.length === 2, "independent generation is pending");
      if (mode === "stop") await f.agent.stop(); else await f.agent.acquireManualControl();
      delayed.resolve(SEND); f.finish.resolve(); await pause(25);
      assert.equal(f.sends(), 0); assert.equal(f.commits(), 0); assert.ok(!f.calls().some(call => call.name === "send"));
      assert.ok(!f.events().some(event => event.content.includes("院门打开，街上有人经过")), "late cancelled World output cannot enter the context");
      if (mode === "takeover") {
        f.agent.setManualPaused(false); await until(() => f.requests.length === 3, "handback resumes on the cancellation's true state");
        assert.match(JSON.stringify(f.requests[2].messages), /取消/);
      }
    } finally { await f.close(); }
  }
  const handback = await fixture((index, signal) => index === 1 ? ACTION : index === 2 ? SEND : hold(signal));
  handback.earlyCommit(); handback.holdSend();
  try {
    await handback.start(); handback.notify("chat:handoff-late-receipt"); await until(() => handback.sends() === 1, "send and World are committed but awaiting their actual receipts");
    const control = await handback.agent.acquireManualControl(); assert.equal(control.busy, true);
    handback.agent.setManualPaused(false); handback.sendDone.resolve();
    await until(() => handback.events().some(event => event.content.includes("平台确认已经发送到群里")), "late committed send retains its truth after handback");
    await handback.waiting(); assert.equal(handback.requests.length, 2, "late old-window receipt cannot revive independent generation after manual control");
    handback.finish.resolve(); await until(() => handback.requests.length === 3, "actual World completion still resumes handback normally");
  } finally { await handback.close(); }
  for (const options of [{ strict: true, interruptible: false }, { strict: false, interruptible: true }]) {
    const f = await fixture((index, signal) => index === 1 ? ACTION : hold(signal), options);
    try {
      if (options.strict) {
        await f.start(); f.notify("chat:disabled"); await f.waiting(); assert.equal(f.requests.length, 1, "opt-out preserves complete strict result waiting");
        f.finish.resolve(); await until(() => f.requests.length === 2, "opt-out still resumes at actual result");
      } else {
        f.agent.start(); await until(() => f.requests.length === 2, "strict=false keeps existing immediate independent decisions without a chat");
      }
    } finally { await f.close(); }
  }
}

async function main() {
  await realChatAdmitsOrderedDeviceWork(); await failuresAndRepeatedReadsDoNotRenew(); await boundedEvenWithContinuousProgress(); await readbackIsNotANewExternalMessage();
  await explicitPausesRemainReal(); await dependentDecisionCannotRaceWorldCompletion(); await currentPhysicalGateAndCommittedWriteTruth();
  await cancellationFencesAndCompatibility();
  console.log("PASS World-action interleave: fresh-chat admission, ordered real receipts, bounded progress, no reread/error spin, wait/rest, dependent-action race, physical gates, committed writes, cancellation and compatibility");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
