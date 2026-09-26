/** Interface preparation preserves explicit targets and physical/access barriers; no live services. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planToolNavigation, type NavigationState } from "../src/bot/navigation.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { AppManager } from "../src/apps/manager.js";
import { ComputerDevice } from "../src/apps/computerDevice.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { WorldFiles } from "../src/files.js";
import { Config } from "../src/config.js";
import { applyPhonePhysicalState, canUsePhone } from "../src/phone-state.js";
import type { WorldApp } from "../src/apps/app.js";
import type { ChatMessage, ChatToolDef } from "../src/llm/chat.js";
import type { ParsedToolCall, PhoneStatus } from "../src/types.js";

const PRIVATE = "onebot@fixture:private:peer", GROUP = "onebot@fixture:group:room";
const call = (name: string, arguments_: Record<string, unknown> = {}): ParsedToolCall => ({ name, arguments: arguments_ });
const state = (extra: Partial<NavigationState> = {}): NavigationState => ({ phone: { down: false }, chatOpen: false,
  channelKey: null, channelIsGroup: false, chatApp: "fixture-chat", builtin: true, device: "phone", ...extra });
const step = (name: string, arguments_: Record<string, unknown> = {}): ParsedToolCall => ({ name, arguments: arguments_, duration: 0 });
const resolved: string[] = [];
async function resolveChannel(id: string) {
  resolved.push(id);
  if (![PRIVATE, GROUP].includes(id)) return { error: "频道不属于可操作账号。" };
  return { key: id, isPrivate: id === PRIVATE };
}
async function plan(name: string, args: Record<string, unknown>, current: NavigationState) {
  return planToolNavigation(call(name, args), current, resolveChannel);
}
async function purePlans() {
  assert.deepEqual(await plan("send", { id: PRIVATE, msg: "到了告诉我" }, state({ phone: { down: true } })), {
    steps: [step("pick_up_phone"), step("open_app", { name: "fixture-chat" }), step("select_channel", { id: PRIVATE })],
  }, "explicit sends prepare the phone, app and exact recipient in that order");
  assert.deepEqual(await plan("send", { id: PRIVATE, msg: "另一条消息" }, state({ chatOpen: true, channelKey: GROUP, channelIsGroup: true })), {
    steps: [step("select_channel", { id: PRIVATE })],
  }, "an explicit recipient must override the currently visible channel");
  assert.deepEqual(await plan("send", { msg: "在当前会话继续" }, state({ chatOpen: true, channelKey: PRIVATE })), { steps: [] });
  assert.deepEqual(await plan("send", { id: PRIVATE, msg: "明确的同一会话" }, state({ chatOpen: true, channelKey: PRIVATE })), { steps: [] });
  const beforeMissing = resolved.length;
  const missing = await plan("send", { msg: "没有指定给谁" }, state({ phone: { down: true }, channelKey: PRIVATE }));
  assert.ok(missing.error); assert.deepEqual(missing.steps, []);
  assert.equal(resolved.length, beforeMissing, "a remembered channel outside the current chat is not an implicit recipient");
  for (const id of ["", " ", null, 123, false]) {
    const invalidExplicit = await plan("send", { id, msg: "不能误发当前频道" }, state({ chatOpen: true, channelKey: PRIVATE }));
    assert.ok(invalidExplicit.error); assert.deepEqual(invalidExplicit.steps, []);
  }
  assert.ok((await plan("select_channel", {}, state({ chatOpen: true, channelKey: PRIVATE }))).error);
  const invalid = await plan("send", { id: "unknown:target", msg: "不应执行" }, state({ phone: { down: true } }));
  assert.match(invalid.error!, /频道/); assert.deepEqual(invalid.steps, []);
  const privateGroup = await plan("group_ban", { id: PRIVATE, user_id: "someone" }, state({ phone: { down: true } }));
  assert.match(privateGroup.error!, /群聊/); assert.deepEqual(privateGroup.steps, []);
  assert.deepEqual(await plan("group_info", { id: GROUP }, state({ phone: { down: true } })), {
    steps: [step("pick_up_phone"), step("open_app", { name: "fixture-chat" }), step("select_channel", { id: GROUP })],
  });
  assert.deepEqual(await plan("group_info", {}, state({ chatOpen: true, channelKey: GROUP, channelIsGroup: true })), { steps: [] });
  assert.deepEqual(await plan("select_channel", { id: GROUP }, state({ phone: { down: true } })), {
    steps: [step("pick_up_phone"), step("open_app", { name: "fixture-chat" })],
  }, "the requested selector itself is not duplicated as a preparatory step");
  assert.deepEqual(await plan("list_friends", {}, state({ phone: { down: true } })), { steps: [step("pick_up_phone"), step("open_app", { name: "fixture-chat" })] });
  assert.deepEqual(await plan("check_msg", {}, state({ chatOpen: true, channelKey: GROUP })), { steps: [] });
  for (const physical of [
    { reachable: false, usable: true, perceptible: false, location: null },
    { reachable: true, usable: false, perceptible: true, location: "角色面前" },
  ]) {
    const before = resolved.length;
    const blocked = await plan("send", { id: PRIVATE, msg: "不应该恢复损坏或遗失手机" }, state({ phone: { down: true, physical } }));
    assert.ok(blocked.error); assert.deepEqual(blocked.steps, []);
    assert.equal(resolved.length, before, "physical barriers reject before any target/device preparation");
  }
  assert.deepEqual(await plan("read_note", { id: "note-1" }, state({ builtin: false, app: { id: "notes", name: "记事本" }, activeAppId: "browser", phone: { down: true } })), {
    steps: [step("pick_up_phone"), step("open_app", { name: "notes" })],
  }, "a learned app target uses its exact installed ID without guessing from the operation name");
  assert.deepEqual(await plan("read_note", { id: "note-1" }, state({ builtin: false, app: { id: "notes", name: "记事本" }, activeAppId: "notes" })), { steps: [] });
  const noOwner = await plan("read_note", { id: "note-1" }, state({ builtin: false, app: null, phone: { down: true } }));
  assert.ok(noOwner.error); assert.deepEqual(noOwner.steps, []);
  assert.deepEqual(await plan("run_command", { command: "pwd" }, state({ builtin: false, device: "computer", computerAvailable: true, computerOpen: false, phone: { down: true } })), {
    steps: [step("open_computer")],
  }, "computer preparation does not pick up or otherwise manipulate the phone");
  assert.deepEqual(await plan("run_command", { command: "pwd" }, state({ builtin: false, device: "computer", computerAvailable: true, computerOpen: true })), { steps: [] });
  const noComputer = await plan("run_command", { command: "pwd" }, state({ builtin: false, device: "computer", computerAvailable: false }));
  assert.ok(noComputer.error); assert.deepEqual(noComputer.steps, []);
  for (const name of ["pick_up_phone", "put_down_phone", "observe_device", "close_app", "close_computer"]) {
    assert.deepEqual(await plan(name, {}, state({ phone: { down: true } })), { steps: [] }, "explicit gestures/observation remain literal; they do not trigger automatic navigation");
  }
  assert.deepEqual(await plan("act", { description: "走到窗边" }, state({ device: null })), { steps: [] });
  assert.ok(resolved.every(id => id === PRIVATE || id === GROUP || id === "unknown:target"));
}

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let n = 0; n < 1500 && !check(); n++) await pause(2); assert.ok(check(), "navigation loop did not settle"); }
const dirs: string[] = [], agents: any[] = [];
type Mode = "native" | "body";
async function runtimeFixture(target: ParsedToolCall, options: { mode?: Mode; phone?: PhoneStatus; channel?: string;
  banned?: string[]; apps?: WorldApp[]; prelearn?: boolean; onChatOpen?: (agent: any) => Promise<void> | void;
  onGenerate?: (agent: any) => void; puppet?: boolean; computer?: (files: WorldFiles) => Promise<ComputerDevice>;
  ignoreSendDuration?: boolean; realMsUntil?: (at: number) => number; sendGate?: Promise<void>; holdNextGeneration?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-tool-navigation-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files); await context.load();
  const cfg = Config({ autoStart: false });
  Object.assign(cfg.bot, { nativeToolCalls: true, minIntervalMs: 0, retryDelayMs: 1, maxWindowChars: 1_000_000,
    restCompressMinChars: 1_000_000, spillMinChars: 0, ignoreSendDuration: options.ignoreSendDuration ?? true, waitRateThreshold: 0 });
  cfg.bot.growth.enabled = false; cfg.messaging.sendEcho = false; cfg.apps.chatAppName = "fixture-chat";
  const definitions = BOT_TOOLS.filter(def => ["help", "think", "pick_up_phone", "put_down_phone", "open_app", "close_app", "open_computer", "close_computer", "select_channel", "read_channel", "send", "group_info", "cancel"].includes(def.name));
  const apps = new AppManager("fixture-chat", options.apps ?? [], new Set(definitions.map(def => def.name)), logger);
  if (options.prelearn) for (const app of options.apps ?? []) { await apps.open(app); await apps.closeCurrent(); }
  const phone = options.phone ?? { down: true };
  const sends: { key: string; msg: string; callsAtSend: string[]; receiptsAtSend: string[] }[] = [];
  let chatOpens = 0, channelReads = 0, worldCalls = 0, agent: any;
  const calls = () => context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call.name] : []);
  const messenger: any = {
    resolveKey: resolveChannel,
    recentChannels: async () => { chatOpens++; await options.onChatOpen?.(agent); return { text: "本地会话列表。", originEventIds: [] }; },
    channelMessages: async () => { channelReads++; return { text: "真实适配器回显的会话内容。", originEventIds: [] }; },
    putDownPhone: async () => "通知设置不变。",
    sendReceipt: async (key: string, msg: string) => {
      assert.equal(phone.down, false, "send cannot occur before the actual pickup");
      assert.equal(agent.phoneUi.chatOpen, true, "send cannot occur before the actual app open");
      assert.equal(agent.phoneUi.channelKey, key, "send cannot occur before the intended channel is actually selected");
      sends.push({ key, msg, callsAtSend: calls(), receiptsAtSend: context.stream.flatMap(entry => entry.kind === "event" && entry.event.source === "tool" ? [entry.event.refToolCallId ?? ""] : []) });
      await options.sendGate;
      return { text: "适配器确认已发送。", status: "sent", messageIds: ["fixture-sent"] };
    },
  };
  const world: any = { adjudicateAct: async () => { worldCalls++; throw new Error("navigation must not invent a World action"); } };
  const clock: any = { now: () => 10, timeLine: () => "T10", realMsUntil: options.realMsUntil ?? (() => 0), unitWorldSeconds: 1, unitRealSeconds: 1 };
  const computer = await options.computer?.(files) ?? null;
  agent = new BotAgent(cfg, clock, files, context, world, messenger, apps, computer, null, phone, logger, definitions);
  agents.push(agent);
  if (options.channel) { phone.down = false; agent.attention = "phone"; agent.phoneUi = { chatOpen: true, channelKey: options.channel, channelIsGroup: options.channel === GROUP, forwardStack: [] }; }
  for (const name of options.banned ?? []) agent.tempBannedTools.add(name);
  if (options.puppet) agent.residentControl = { mode: "puppet", sessionId: "fixture-controller" };
  agent.refreshToolGate();
  const requests: { messages: ChatMessage[]; tools?: ChatToolDef[] }[] = [];
  agent.backend.client = { complete: async (messages: ChatMessage[], opts: { tools?: ChatToolDef[]; signal?: AbortSignal }) => {
    requests.push(structuredClone({ messages, tools: opts.tools }));
    if (requests.length === 1) options.onGenerate?.(agent);
    else if (options.holdNextGeneration) {
      // Observe the real queued send without a fixture-created takeover cancelling it.
      // The next model turn remains in flight until normal stop/abort releases it.
      assert.ok(opts.signal, "held fixture generation must be cancellable");
      return new Promise<never>((_, reject) => {
        const abort = () => reject(opts.signal!.reason ?? new Error("fixture generation aborted"));
        if (opts.signal!.aborted) abort();
        else opts.signal!.addEventListener("abort", abort, { once: true });
      });
    } else agent.setManualPaused(true);
    return options.mode === "body"
      ? { content: JSON.stringify(target), toolCalls: [] }
      : { content: "", toolCalls: [{ id: "model-navigation", type: "function", function: { name: target.name,
        arguments: JSON.stringify({ ...target.arguments, ...(target.duration !== undefined ? { duration: target.duration } : {}) }) } }] };
  } };
  return { agent, context, phone, requests, sends, calls, chatOpens: () => chatOpens, channelReads: () => channelReads, worldCalls: () => worldCalls };
}

async function runtimeNavigation() {
  for (const mode of ["native", "body"] as const) {
    const f = await runtimeFixture(call("send", { id: PRIVATE, msg: "已经到家" }), { mode });
    f.agent.start(); await until(() => f.requests.length === 2); await f.agent.stop();
    assert.deepEqual(f.calls(), ["pick_up_phone", "open_app", "select_channel", "send"], "navigation steps are real durable calls preceding the requested action");
    assert.equal(f.chatOpens(), 1, "chat opened once"); assert.equal(f.channelReads(), 1, "selected channel read once"); assert.equal(f.sends.length, 1, JSON.stringify(f.context.stream.filter(entry => entry.kind === "event")));
    assert.deepEqual(f.sends[0]!.callsAtSend, f.calls());
    assert.equal(f.sends[0]!.receiptsAtSend.length, 3, "pickup/app/channel results are persisted before sending, not fabricated afterward");
    assert.deepEqual([f.sends[0]!.key, f.sends[0]!.msg], [PRIVATE, "已经到家"]);
    assert.equal(f.worldCalls(), 0);
    assert.equal(f.requests.length, 2, "the complete navigation requires no extra model turn");
    assert.deepEqual(f.requests[1]!.tools, f.requests[0]!.tools, "navigation does not rewrite the frozen native declaration prefix");
    assert.deepEqual(f.requests[1]!.messages.slice(0, f.requests[0]!.messages.length), f.requests[0]!.messages);
    assert.ok(f.context.stream.some(entry => entry.kind === "event" && entry.event.content.includes("适配器确认已发送")));
  }
  const current = await runtimeFixture(call("send", { msg: "就在这里回复" }), { channel: PRIVATE });
  current.agent.start(); await until(() => current.requests.length === 2); await current.agent.stop();
  assert.deepEqual(current.calls(), ["send"]); assert.equal(current.chatOpens(), 0); assert.equal(current.channelReads(), 0); assert.equal(current.sends.length, 1, JSON.stringify(current.context.stream.filter(entry => entry.kind === "event")));

  for (const test of [
    { label: "missing target", target: call("send", { msg: "不要猜测给谁" }), options: {} },
    { label: "private group operation", target: call("group_info", { id: PRIVATE }), options: {} },
    { label: "lost phone", target: call("send", { id: PRIVATE, msg: "遗失不能恢复" }), options: { phone: { down: true, physical: { reachable: false, location: null, usable: true, perceptible: false } } } },
    { label: "damaged phone", target: call("send", { id: PRIVATE, msg: "损坏不能恢复" }), options: { phone: { down: true, physical: { reachable: true, location: "面前", usable: false, perceptible: true } } } },
    { label: "banned target", target: call("send", { id: PRIVATE, msg: "禁用不能绕过" }), options: { banned: ["send"] } },
    { label: "banned pickup", target: call("send", { id: PRIVATE, msg: "禁用不能绕过" }), options: { banned: ["pick_up_phone"] } },
    { label: "banned app opening", target: call("send", { id: PRIVATE, msg: "禁用不能绕过" }), options: { banned: ["open_app"] } },
    { label: "banned channel selection", target: call("send", { id: PRIVATE, msg: "禁用不能绕过" }), options: { banned: ["select_channel"] } },
    { label: "body takeover", target: call("send", { id: PRIVATE, msg: "操纵身体时不能擅自导航" }), options: { puppet: true } },
  ]) {
    const f = await runtimeFixture(test.target, test.options);
    f.agent.start(); await until(() => f.requests.length === 2); await f.agent.stop();
    assert.equal(f.sends.length, 0, test.label); assert.equal(f.chatOpens(), 0, test.label); assert.equal(f.channelReads(), 0, test.label);
    assert.equal(f.phone.down, true, test.label); assert.equal(f.worldCalls(), 0, test.label);
  }
  let appOpens = 0, appCalls = 0;
  const app: WorldApp = { id: "notes", name: "便笺", description: "fixture", open: async () => { appOpens++; return { tools: [{ name: "read_note", description: "读取便笺" }], opening: "便笺首页。" }; },
    call: async () => { appCalls++; return "便笺真实正文。"; }, close: async () => {} };
  const learned = await runtimeFixture(call("read_note", { id: "n1" }), { apps: [app], prelearn: true });
  learned.agent.start(); await until(() => learned.requests.length === 2); await learned.agent.stop();
  assert.equal(appOpens, 2, "known tool navigation reopens its recorded app once"); assert.equal(appCalls, 1);
  assert.deepEqual(learned.calls(), ["pick_up_phone", "open_app", "read_note"]);
  assert.equal(learned.worldCalls(), 0);
  const ambiguous: WorldApp = { ...app, id: "other-notes", name: "另一份便笺" };
  const conflict = await runtimeFixture(call("read_note", { id: "n1" }), { apps: [app, ambiguous], prelearn: true });
  const beforeCalls = appCalls, beforeOpens = appOpens;
  conflict.agent.start(); await until(() => conflict.requests.length === 2); await conflict.agent.stop();
  assert.equal(conflict.phone.down, true); assert.equal(appCalls, beforeCalls); assert.equal(appOpens, beforeOpens, "ambiguous known owners cannot trigger device navigation");

  let computerStarts = 0, computerCalls = 0;
  const computerApp: WorldApp = { id: "terminal", name: "终端", description: "fixture",
    open: async () => ({ tools: [{ name: "run_command", description: "执行终端命令" }], opening: "终端当前目录。" }),
    call: async () => { computerCalls++; return "实际本地测试命令结果。"; }, close: async () => {} };
  const computer = await runtimeFixture(call("run_command", { command: "pwd" }), { computer: async files => {
    await files.writeMeta({ realWorld: true });
    const device = new ComputerDevice(computerApp as any, null, null, { ensureReady: async () => { computerStarts++; return { ok: true }; } } as any,
      files, { syncRealTime: true } as any, { mode: "docker" } as any, new Set(BOT_TOOLS.map(def => def.name)), logger, () => [], true);
    await device.open(); await device.close(); return device;
  } });
  computer.agent.start(); await until(() => computer.requests.length === 2); await computer.agent.stop();
  assert.equal(computerStarts, 2); assert.equal(computerCalls, 1);
  assert.deepEqual(computer.calls(), ["open_computer", "run_command"]);
  assert.equal(computer.phone.down, true, "computer navigation preserves the independent phone's posture");

  let oldToolAvailable = true, obsoleteExecutions = 0;
  const changingApp: WorldApp = { id: "changing", name: "变化中的应用", description: "fixture",
    open: async () => ({ tools: oldToolAvailable ? [{ name: "old_operation", description: "旧能力" }] : [], opening: "实际当前界面。" }),
    call: async () => { obsoleteExecutions++; return "不能到达"; }, close: async () => {} };
  const obsolete = await runtimeFixture(call("old_operation", {}), { apps: [changingApp], prelearn: true, onGenerate: () => { oldToolAvailable = false; } });
  obsolete.agent.start(); await until(() => obsolete.requests.length === 2); await obsolete.agent.stop();
  assert.equal(obsoleteExecutions, 0, "learning that a tool used to exist does not override the actual reopened app's current hasTool result");
  assert.ok(obsolete.context.stream.some(entry => entry.kind === "event" && /不可用|未执行/.test(entry.event.content)));

  const failedOpen = await runtimeFixture(call("send", { id: PRIVATE, msg: "开应用失败后不能继续发送" }), {
    onChatOpen: () => { throw new Error("会话列表读取失败"); },
  });
  failedOpen.agent.start(); await until(() => failedOpen.requests.length === 2); await failedOpen.agent.stop();
  assert.equal(failedOpen.sends.length, 0); assert.equal(failedOpen.channelReads(), 0);
  assert.ok(!failedOpen.calls().includes("select_channel"), "a failed real prerequisite terminates the preparation chain");

  let takeoverCompleted = false;
  const interrupted = await runtimeFixture(call("send", { id: PRIVATE, msg: "接管时不得继续" }), {
    onChatOpen: async agent => { await agent.acquireManualControl(); takeoverCompleted = true; },
  });
  interrupted.agent.start(); await until(() => takeoverCompleted && interrupted.agent.scheduler.pendingCount === 0);
  await interrupted.agent.stop();
  assert.equal(interrupted.requests.length, 1, "manual control stops generation midway through navigation");
  assert.equal(interrupted.sends.length, 0); assert.equal(interrupted.channelReads(), 0);
  assert.deepEqual(interrupted.calls(), ["pick_up_phone", "open_app"], "already committed UI changes stay recorded, later selection and sending never execute");

  const puppetThink = await runtimeFixture(call("think", { thought: "身体被控制了，但我仍能思考眼前的变化。" }), { puppet: true });
  puppetThink.agent.start(); await until(() => puppetThink.requests.length === 2); await puppetThink.agent.stop();
  assert.ok(puppetThink.context.stream.some(entry => entry.kind === "event" && entry.event.experience?.internalThought), "body takeover preserves autonomous inner thought without any navigation");
  assert.equal(puppetThink.phone.down, true);
}

async function physicalChangesCancelOnlyUnsubmittedPhoneTasks() {
  for (const [label, physical] of [
    ["lost", { reachable: false, location: null, usable: true, perceptible: false }],
    ["damaged", { reachable: true, location: "眼前", usable: false, perceptible: true }],
  ] as const) {
    let deadlineReached = false;
    const f = await runtimeFixture({ ...call("send", { msg: "A complete fixture message which is still being typed and must not survive losing the phone." }), duration: 3 }, {
      channel: PRIVATE, ignoreSendDuration: false, holdNextGeneration: true,
      realMsUntil: at => at > 10 && !deadlineReached ? 20 : 0,
    });
    f.agent.start(); await until(() => !!f.agent.status().awaitingToolResult);
    assert.equal(f.requests.length, 1, "strict tool loop does not request another decision while typing");
    const pending = f.agent.scheduler.pending().find((task: any) => task.name === "send");
    assert.ok(pending && !pending.committed, `${label}: fixture must be an unsubmitted scheduled send`);
    assert.equal(f.sends.length, 0);
    applyPhonePhysicalState(f.phone, physical); f.agent.phonePhysicalStateChanged();
    assert.equal(f.agent.scheduler.isPending(pending.id), false, `${label}: actual physical failure cancels the pending send immediately`);
    applyPhonePhysicalState(f.phone, { reachable: true, location: "眼前", usable: true, perceptible: true });
    f.agent.phonePhysicalStateChanged();
    if (f.phone.down) {
      const pickup = { id: `recovery_${label}`, role: "agent" as const, name: "pick_up_phone", arguments: {}, issuedAt: 10, expectedAt: 10 };
      await f.context.appendToolCall(pickup); await f.agent.dispatchTool(pickup); await f.agent.scheduler.whenSettled(pickup.id);
    }
    assert.ok(canUsePhone(f.phone), "recovery includes actually reacquiring the phone, so current-state gates alone would permit a stale send");
    deadlineReached = true; await pause(50);
    await f.agent.stop();
    assert.equal(f.sends.length, 0, `${label}: recovery cannot revive the cancelled message after its original typing deadline`);
    assert.ok(f.context.stream.some(entry => entry.kind === "event" && entry.event.refToolCallId === pending.id && /取消/.test(entry.event.content)), "the cancelled attempt has an honest final result");
  }

  let finishSend!: () => void;
  const sendGate = new Promise<void>(resolve => { finishSend = resolve; });
  const committed = await runtimeFixture(call("send", { msg: "提交给平台后仍应保留真实回执。" }), { channel: PRIVATE, sendGate });
  committed.agent.start(); await until(() => committed.sends.length === 1);
  const sending = committed.agent.scheduler.pending().find((task: any) => task.name === "send");
  assert.ok(sending?.committed);
  applyPhonePhysicalState(committed.phone, { reachable: false, location: null, usable: false, perceptible: false });
  committed.agent.phonePhysicalStateChanged();
  assert.equal(committed.agent.scheduler.isPending(sending.id), true, "physical loss cannot erase a platform operation that has already committed");
  finishSend(); await until(() => committed.requests.length === 2); await committed.agent.stop();
  assert.equal(committed.sends.length, 1);
  assert.ok(committed.context.stream.some(entry => entry.kind === "event" && entry.event.refToolCallId === sending.id && entry.event.content.includes("适配器确认已发送")), "an in-flight platform confirmation survives phone failure");
}

async function main() {
  try {
    await purePlans();
    await runtimeNavigation();
    await physicalChangesCancelOnlyUnsubmittedPhoneTasks();
    console.log("PASS tool navigation: exact/implicit channel plans, physical/target/control/ban/ambiguity barriers, loss/recovery cancellation with committed receipt preservation, real ordered steps and receipts through native/body runLoop, learned apps and stable cached prefixes");
  } finally {
    await Promise.allSettled(agents.map(agent => agent.stop()));
    await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
