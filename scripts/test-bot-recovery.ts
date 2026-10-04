/** Exercise admission, backend rejection and maintenance through the real agent loop; no services. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { MaintenanceRetry } from "../src/bot/maintenance-retry.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { AppManager } from "../src/apps/manager.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { extractToolCall, ToolCallParseError } from "../src/llm/parse.js";
import type { ParsedToolCall, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 7500 && !check(); n++) await pause(2);
  assert.ok(check(), label);
}
const channel = "onebot@fixture:private:peer";
const dirs: string[] = [], agents: any[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-recovery-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files); await context.load();
  const cfg = Config({ autoStart: false });
  Object.assign(cfg.bot, { minIntervalMs: 0, retryDelayMs: 1, maxWindowChars: 1_000_000,
    restCompressMinChars: 0, waitRateThreshold: 0, ignoreSendDuration: true,
    breakLoop: true, breakLoopRemoveToolAt: 3, breakLoopForceRestAt: 99, repeatThresholds: [2, 3] });
  cfg.bot.growth.enabled = false; cfg.messaging.sendEcho = false;
  const definitions = BOT_TOOLS.filter(def => ["help", "wait", "rest", "open_app", "pick_up_phone", "select_channel", "send", "cancel"].includes(def.name));
  const apps = new AppManager("QQ", [], new Set(definitions.map(def => def.name)), logger);
  let now = 1000, compressions = 0, failCompression = true, sends = 0;
  const messenger: any = {
    resolveKey: async (id: string) => id === channel ? { key: id, isPrivate: true } : { error: `频道无效，请使用 ${channel}。` },
    sendReceipt: async () => { sends++; return { text: "已发送。", status: "sent", messageIds: ["fixture"] }; },
    recentChannels: async () => ({ text: "真实会话列表。", originEventIds: [] }),
    channelMessages: async () => ({ text: "真实会话记录。", originEventIds: [] }),
  };
  const world: any = { compress: async () => {
    compressions++;
    if (failCompression) throw new Error("fixture invalid compression format");
    return { historySummary: "真实经历摘要。", memoryDigest: "真实检索索引。" };
  } };
  const clock: any = { now: () => 1, timeLine: () => "T1", realMsUntil: () => 0, unitWorldSeconds: 1, unitRealSeconds: 1 };
  const agent: any = new BotAgent(cfg, clock, files, context, world, messenger, apps, null, null, { down: false }, logger, definitions);
  agents.push(agent);
  agent.compressionRetry = new MaintenanceRetry(() => now);
  agent.attention = "phone";
  agent.phoneUi = { chatOpen: true, channelKey: channel, channelIsGroup: false, forwardStack: [] };
  agent.refreshToolGate();
  const observed: { name: string; count: number }[] = [];
  const observe = agent.repeatGuard.observe.bind(agent.repeatGuard);
  agent.repeatGuard.observe = (call: ToolCallRecord) => {
    const result = observe(call); observed.push({ name: call.name, count: result?.count ?? 0 }); return result;
  };
  return { agent, context, cfg, observed, advance: (ms: number) => { now += ms; },
    compressions: () => compressions, recover: () => { failCompression = false; }, sends: () => sends };
}

async function rejectionLoops() {
  for (const mode of ["native", "body"] as const) {
    const f = await fixture(); let requests = 0;
    const attempt: ParsedToolCall = { name: "send", arguments: { id: "123456", msg: "不能猜接收者" } };
    f.agent.backend.client = { complete: async () => {
      if (++requests > 4) f.agent.setManualPaused(true);
      return mode === "native" ? { content: "", toolCalls: [{ function: { name: attempt.name, arguments: JSON.stringify(attempt.arguments) } }] }
        : { content: JSON.stringify(attempt), toolCalls: [] };
    } };
    f.agent.start(); await until(() => requests === 5, `${mode} rejected attempts settle`); await f.agent.stop();
    assert.deepEqual(f.observed, [1, 2, 3, 4].map(count => ({ name: "send", count })), "navigation and later backend-availability refusals count exactly once");
    assert.equal(f.sends(), 0, "bare IDs are never guessed or sent");
    assert.ok(f.agent.tempBannedTools.has("send"), "admission failures can trigger configured loop intervention");
    assert.equal(f.context.stream.filter(entry => entry.kind === "tool_call" && entry.call.name === "send").length, 4);
    assert.ok(f.context.stream.some(entry => entry.kind === "event" && /此刻不可用/.test(entry.event.content)), "the banned attempt retains its real rejection");
  }
  for (const target of [{ name: "send", arguments: { msg: "缺少频道" } }, { name: "missing_operation", arguments: {} }]) {
    const f = await fixture(); let requests = 0;
    f.agent.backend.client = { complete: async () => {
      if (++requests > 2) f.agent.setManualPaused(true);
      return { content: JSON.stringify(target), toolCalls: [] };
    } };
    f.agent.start(); await until(() => requests === 3, `${target.name} rejection settles`); await f.agent.stop();
    assert.deepEqual(f.observed.map(item => item.count), [1, 2]); assert.equal(f.sends(), 0);
  }
  const valid = await fixture(); let requests = 0;
  valid.agent.backend.client = { complete: async () => {
    if (++requests > 1) valid.agent.setManualPaused(true);
    return { content: JSON.stringify({ name: "send", arguments: { id: channel, msg: "明确的真实目标" } }), toolCalls: [] };
  } };
  valid.agent.start(); await until(() => requests === 2, "valid call settles"); await valid.agent.stop();
  assert.equal(valid.sends(), 1); assert.deepEqual(valid.observed.map(item => item.count), [1], "admission plus dispatch never double count a valid call");
  assert.throws(() => extractToolCall('{"name":"missing_operation","arguments":null}', []), (err: any) => err instanceof ToolCallParseError && !err.parsedCall,
    "invalid arguments are not a valid rejected operation");
  assert.throws(() => extractToolCall("not a tool call", []), (err: any) => err instanceof ToolCallParseError && !err.parsedCall);
}

async function maintenance() {
  let now = 0; const retry = new MaintenanceRetry(() => now);
  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    assert.equal(retry.failed().delayMs, delay); assert.equal(retry.remainingMs(), delay); now += delay;
  }
  retry.reset(); assert.equal(retry.failed().delayMs, 30_000);

  const f = await fixture(); f.cfg.bot.maxWindowChars = f.context.approxFixedChars() + 10;
  await f.context.appendEvent({ id: f.context.nextEventId(), source: "system", content: "不可丢弃的真实历史。".repeat(20), worldTime: 1 });
  const before = await f.context.toChatMessages("T1");
  let generations = 0;
  f.agent.backend.client = { complete: async () => { generations++; f.agent.setManualPaused(true); return { content: '{"name":"wait","arguments":{"n":1}}', toolCalls: [] }; } };
  f.agent.start(); await until(() => f.agent.status().maintenance?.state === "cooldown", "first compression failure enters cooldown");
  assert.equal(f.compressions(), 1); assert.equal(generations, 0); assert.equal(f.agent.status().maintenance.generationPaused, true);
  f.agent.pushEvent("koishi", { text: "新通知仍会保存。", originEventIds: ["chat-message:fixture"] });
  await f.agent.drainMailbox();
  await f.agent.doRest(null, null); await f.agent.compactContext(null);
  assert.equal(f.compressions(), 1, "manual/rest entry points cannot bypass retry cooldown");
  assert.deepEqual((await f.context.toChatMessages("different clock")).slice(0, before.length), before, "failed compression preserves the complete cached prefix");
  assert.equal(generations, 0, "new events do not bypass the hard generation budget");
  f.advance(30_001); await until(() => f.compressions() === 2 && f.agent.status().maintenance?.state === "cooldown", "second attempt waits for retry deadline");
  assert.equal(f.agent.compressionRetry.remainingMs(), 60_000);
  assert.equal(f.context.stream.filter(entry => entry.kind === "event" && /整理会稍后重试/.test(entry.event.content)).length, 1, "repeated maintenance failures do not flood the character context");
  f.recover(); f.advance(60_001); f.cfg.bot.maxWindowChars = 1_000_000;
  await until(() => generations === 1, "successful retry resumes inference");
  assert.equal(f.compressions(), 3); assert.equal(f.agent.status().maintenance, null);
  assert.equal(f.context.pinned.historySummary, "真实经历摘要。");
  assert.equal(f.agent.waiting, null, "maintenance never creates character rest"); await f.agent.stop();

  const soft = await fixture(); soft.agent.running = true;
  await soft.context.appendEvent({ id: soft.context.nextEventId(), source: "system", content: "短历史。", worldTime: 1 });
  await soft.agent.doRest(null, null);
  assert.equal(soft.agent.status().maintenance.generationPaused, false);
  soft.agent.running = false;
  let softRequests = 0;
  soft.agent.backend.client = { complete: async () => { softRequests++; soft.agent.setManualPaused(true); return { content: '{"name":"wait","arguments":{"n":1}}', toolCalls: [] }; } };
  soft.agent.start(); await until(() => softRequests === 1, "under-budget rest failure permits normal inference");
  assert.equal(soft.compressions(), 1); await soft.agent.stop();
  assert.equal(soft.agent.status().maintenance, null, "stop clears lifecycle retry state");
}

async function rejectionThrottleWithoutBans() {
  const f = await fixture(); f.cfg.bot.breakLoop = false;
  let requests = 0;
  f.agent.backend.client = { complete: async () => {
    const request = ++requests;
    if (request > 5) f.agent.setManualPaused(true);
    return { content: JSON.stringify({ name: "send", arguments: {
      id: request === 4 ? channel : "123456", msg: "只向明确的正确频道发送",
    } }), toolCalls: [] };
  } };
  f.agent.start(); await until(() => f.agent.status().awaitingToolRetry, "bare target failures enter retry cooldown with breakLoop disabled");
  assert.equal(requests, 2);
  assert.equal(f.context.stream.filter(entry => entry.kind === "event" && /频道无效/.test(entry.event.content)).length, 2,
    "waiting status is published only after both corrections are durable");
  const prefix = await f.context.toChatMessages("T1");
  await pause(40); assert.equal(requests, 2, "consecutive navigation failures cannot rapidly generate again");
  f.agent.pushEvent("koishi", "新信息允许一次重新考虑。", { originEventIds: ["chat-message:retry-first"] });
  await until(() => requests === 3 && f.agent.status().awaitingToolRetry, "one fresh perception wakes a correction attempt");
  const retryAt = f.agent.invalidToolRetryAt;
  for (let n = 0; n < 8; n++) {
    f.agent.pushEvent("koishi", `继续到达的消息 ${n}`, { originEventIds: [`chat-message:retry-flood-${n}`] });
    await pause(10);
  }
  assert.equal(requests, 3, "a busy incoming chat cannot repeatedly erase a failed-attempt cooldown");
  assert.equal(f.agent.invalidToolRetryAt, retryAt);
  assert.deepEqual((await f.context.toChatMessages("later")).slice(0, prefix.length), prefix);
  assert.equal(f.agent.tempBannedTools.size, 0); assert.equal(f.compressions(), 0); assert.equal(f.agent.waiting, null);
  await until(() => requests === 6, "deadline permits recovery and a successful send resets the failure streak");
  assert.equal(f.sends(), 1);
  assert.equal(f.agent.invalidToolFailures, 1, "the next unrelated failure starts at one after actual successful execution");
  assert.ok(!f.context.stream.some(entry => entry.kind === "tool_call" && entry.call.name === "rest"));
  await f.agent.stop(); assert.equal(f.agent.invalidToolFailures, 0);
}

async function maintenanceStorageFailures() {
  const f = await fixture(); f.agent.running = true; f.recover();
  await f.context.appendEvent({ id: f.context.nextEventId(), source: "system", content: "原始经历必须保留。", worldTime: 1 });
  const prefix = await f.context.toChatMessages("T1");
  f.agent.tempBannedTools.add("send");
  const originalApply = f.context.applyCompression.bind(f.context);
  let writes = 0;
  f.context.applyCompression = async () => { writes++; throw new Error("fixture storage unavailable"); };
  await f.agent.doRest(null, "overflow");
  assert.equal(f.compressions(), 1); assert.equal(writes, 1); assert.equal(f.agent.status().maintenance.state, "cooldown");
  await f.agent.doRest(null, "overflow"); await f.agent.compactContext(null);
  assert.equal(f.compressions(), 1, "failed durable cutover also defers the next expensive model request");
  assert.ok(f.agent.tempBannedTools.has("send"));
  assert.deepEqual((await f.context.toChatMessages("T2")).slice(0, prefix.length), prefix);
  f.advance(30_000); f.context.applyCompression = originalApply;
  await f.agent.doRest(null, "overflow");
  assert.equal(f.compressions(), 2); assert.equal(f.agent.status().maintenance, null);
  assert.ok(!f.agent.tempBannedTools.has("send"));
  await f.agent.stop();
}

async function fixedPrefixBudgetBlock() {
  for (const hasStream of [false, true]) {
    const f = await fixture();
    if (hasStream) await f.context.appendEvent({ id: f.context.nextEventId(), source: "system", content: "应当原样保留的既有事件。", worldTime: 1 });
    const prefix = await f.context.toChatMessages("T1");
    const fixedPrefixChars = f.context.approxFixedChars();
    f.cfg.bot.maxWindowChars = fixedPrefixChars;
    let generations = 0;
    f.agent.backend.client = { complete: async () => {
      generations++; f.agent.setManualPaused(true);
      return { content: '{"name":"wait","arguments":{"n":1}}', toolCalls: [] };
    } };
    f.agent.start(); await until(() => f.agent.status().maintenance?.state === "blocked", "oversized fixed prefix blocks inference even with an empty stream");
    assert.deepEqual(f.agent.status().maintenance, {
      state: "blocked", failures: 0, retryAt: 0, generationPaused: true, fixedPrefixChars,
      reason: f.agent.status().maintenance.reason,
    });
    assert.match(f.agent.status().maintenance.reason, /固定提示.*上下文预算/);
    await f.agent.doRest(null, null); await f.agent.compactContext("overflow");
    assert.equal(f.compressions(), 0, "rest and direct maintenance cannot compress a powerless dynamic stream");
    assert.equal(generations, 0);
    f.agent.pushEvent("koishi", "阻塞期间仍收到真实信息。", { originEventIds: ["chat-message:fixed-prefix-block"] });
    await until(() => f.context.stream.some(entry => entry.kind === "event" && entry.event.content === "阻塞期间仍收到真实信息。"), "blocked loop keeps durably accepting incoming facts");
    assert.equal(generations, 0); assert.equal(f.compressions(), 0);
    assert.equal(f.agent.waiting, null, "configuration blockage is not character sleep");
    assert.deepEqual((await f.context.toChatMessages("T2")).slice(0, prefix.length), prefix, "blocking never edits the cached prefix or historical entries");
    f.cfg.bot.maxWindowChars = f.context.approxChars() + 10000;
    await until(() => generations === 1, "increasing the budget resumes inference without a restart or reset");
    assert.equal(f.compressions(), 0); assert.equal(f.agent.status().maintenance, null);
    await f.agent.stop();
  }

  // Even a formally successful summary can be too large. Do not repeatedly compress the
  // account event restored after each cutover while leaving the oversized fixed block intact.
  const f = await fixture();
  f.context.accountsProvider = () => "fixture:account";
  f.cfg.bot.maxWindowChars = f.context.approxFixedChars() + 1500;
  await f.context.appendEvent({ id: f.context.nextEventId(), source: "system", content: "有来源的历史。".repeat(700), worldTime: 1 });
  let compressions = 0, generations = 0;
  f.agent.world.compress = async () => { compressions++; return { historySummary: "过长摘要。".repeat(5000), memoryDigest: "已有事实索引。" }; };
  f.agent.backend.client = { complete: async () => { generations++; throw new Error("must not generate over budget"); } };
  f.agent.start(); await until(() => compressions === 1 && f.agent.status().maintenance?.state === "blocked", "oversized post-compression prefix enters a technical block");
  await pause(1100);
  assert.equal(compressions, 1, "a tiny restored account event cannot cause a success/compact loop");
  assert.equal(generations, 0); await f.agent.stop();
}

async function main() {
  try {
    await rejectionLoops(); await rejectionThrottleWithoutBans(); await maintenance(); await maintenanceStorageFailures(); await fixedPrefixBudgetBlock();
    console.log("PASS Bot recovery: real-loop admission/backend rejection counts, exact targets, no double counting; bounded maintenance backoff, preserved cached history, hard-budget pause, fixed-prefix block/recovery, soft-budget continuation and lifecycle cleanup");
  } finally { for (const agent of agents) await agent.stop(); for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
