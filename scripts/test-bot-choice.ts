/** Suggestions route directly through real tools; model-side choose is retired. No external requests. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ActionOpportunity } from "../src/bot/opportunities.js";
import type { ParsedToolCall, ToolCallRecord } from "../src/types.js";

const directories: string[] = [], agents: any[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, reason: string) {
  for (let i = 0; i < 1500 && !test(); i++) await sleep(2);
  assert.ok(test(), reason);
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const events = (context: BotContext) => context.stream.flatMap(entry => entry.kind === "event" ? [entry.event] : []);
const allCalls = (context: BotContext) => context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call] : []);
const calls = (context: BotContext) => allCalls(context).filter(call => !call.navigationFor);
const options = [{ label: "看看花园", intent: "走进花园，看看新开的花" }, { label: "去河边", intent: "沿小路走到河边" }];
function scene(id: string, sequence: number, choices = options) {
  return { text: JSON.stringify({ scene: { eventId: id, actorId: "bot", worldSequence: sequence, worldTime: 10,
    text: "你在院门旁，看见通往花园和河边的两条小路。", situation: "院门旁，尚未动身。", opportunities: choices } }),
    originEventIds: [id], experience: { worldPerception: true } };
}
type Generation = { menu: ActionOpportunity[]; tools: string[]; messages: any[] };
type Generate = (request: Generation, ordinal: number, signal: AbortSignal) => ParsedToolCall | Promise<ParsedToolCall>;
async function fixture(generate: Generate, names = ["act"], phoneDown = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "bot-choice-")); directories.push(base);
  const files = new WorldFiles(base); await files.ensure();
  const context = new BotContext(files, "frozen pre-upgrade tool declarations"); await context.load();
  const cfg = Config({ autoStart: false }); cfg.bot.growth.enabled = false;
  Object.assign(cfg.bot, { nativeToolCalls: false, minIntervalMs: 0, retryDelayMs: 1000, maxWindowChars: 1_000_000,
    restCompressMinChars: 1_000_000, spillMinChars: 0, ignoreSendDuration: true });
  cfg.messaging.sendEcho = false;
  const errors: unknown[][] = [], logger: any = { info() {}, warn() {}, debug() {}, error(...args: unknown[]) { errors.push(args); } };
  const worldCalls: ToolCallRecord[] = [], sent: { id: string; msg: string }[] = [];
  const clock: any = { now: () => 10, timeLine: () => "T10", unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: () => 0 };
  const world: any = { adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => Promise<void>, _signal: AbortSignal, commit: () => boolean) => {
    assert.ok(commit()); worldCalls.push(structuredClone(call));
    const id = `result-${call.id}`;
    await deliver(JSON.stringify({ action: { id: `bot:${call.id}`, intent: call.arguments.description, status: "completed" },
      observation: { actorId: "bot", mode: "narrative", observationId: id, sourceEventIds: [id], worldSequence: 20,
        observedAt: 10, narrative: "你走到花园边，闻见花香。" } }));
    return true;
  } };
  const messenger: any = {
    resolveKey: async (id: string) => ({ key: id, isPrivate: true }),
    channelMessages: async (id: string) => ({ text: `当前会话 ${id}`, originEventIds: [] }),
    sendReceipt: async (id: string, msg: string) => { sent.push({ id, msg }); return { status: "sent", text: "平台确认消息已发送。", messageIds: ["sent-1"], originEventIds: ["chat:sent-1"] }; },
    send: async () => { throw Error("the richer send receipt path should be used"); },
  };
  const phone = { down: phoneDown };
  const agent: any = new BotAgent(cfg, clock, files, context, world, messenger, null, null, null, phone, logger,
    BOT_TOOLS.filter(tool => names.includes(tool.name) || names.includes("send") && tool.name === "select_channel"));
  agents.push(agent);
  const generations: Generation[] = [], advertised: string[][] = [];
  let allowed: string[] = [];
  agent.backend = {
    setToolNames(next: string[]) { allowed = [...next]; advertised.push([...next]); }, setToolDefs() {},
    async generate(ctx: BotContext, time: string, signal: AbortSignal) {
      const request = { menu: structuredClone(agent.announcedOpportunities), tools: [...allowed], messages: await ctx.toChatMessages(time, false) };
      generations.push(request);
      return Promise.race([Promise.resolve(generate(request, generations.length, signal)), hold(signal)]);
    },
  };
  // Pause only after a real dispatch; malformed choices must reach the next model boundary themselves.
  const dispatch = agent.dispatch.bind(agent);
  agent.dispatch = async (call: ToolCallRecord) => { await dispatch(call); if (!call.navigationFor) agent.setManualPaused(true); };
  async function finish(expectReceipt = true) {
    await until(() => calls(context).length === 1 && agent.status().paused, "one actual call must reach the dispatcher");
    if (expectReceipt) await until(() => events(context).some(event => !!event.refToolCallId), "a real receipt must return");
    await agent.stop();
    assert.deepEqual(errors, [], "the real loop must not crash");
  }
  function chat(target = "onebot@100:private:friend-a") {
    agent.phoneUi = { chatOpen: true, channelKey: "onebot@100:private:friend-b", channelIsGroup: false, forwardStack: [] };
    agent.attention = "phone"; agent.refreshToolGate();
    agent.pushEvent("koishi", { text: "小明：明天一起散步吗？", originEventIds: ["chat:friend-a:one"],
      experience: { chat: { kind: "message", channelKey: target, senderOwn: false } } });
    return target;
  }
  return { agent, context, files, cfg, phone, errors, worldCalls, sent, generations, advertised, finish, chat };
}
function hold(signal: AbortSignal): Promise<ParsedToolCall> {
  return new Promise((_resolve, reject) => {
    const stop = () => reject(new Error("test generation aborted"));
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
}

async function worldActionAndCache() {
  const speech = "  你好，我想看看这里的花。\n";
  const f = await fixture(request => ({ ...structuredClone(request.menu[0]!.call!), arguments: { ...request.menu[0]!.call!.arguments, speech }, duration: 17 }));
  const before = await f.context.toChatMessages("before", false);
  f.agent.pushEvent("world", scene("garden-menu", 1)); f.agent.start(); await f.finish();
  const [actual] = calls(f.context);
  assert.equal(f.generations.length, 1, "a suggestion needs only one direct Bot decision");
  assert.equal(f.worldCalls.length, 1, "one selected action executes exactly once");
  assert.equal(actual!.name, "act"); assert.deepEqual(actual!.arguments, { description: options[0]!.intent, speech });
  assert.equal(actual!.duration, 17); assert.equal(actual!.expectedAt, 27);
  assert.equal(actual!.selection, undefined, "ordinary model actions need no choice wrapper");
  assert.deepEqual(f.worldCalls, calls(f.context));
  assert.ok(!f.generations[0]!.tools.includes("choose"));
  const menuEvent = events(f.context).find(event => event.content.startsWith("（当前可考虑的行动机会；"))!;
  assert.match(menuEvent.content, /对应工具.*act/); assert.doesNotMatch(menuEvent.content, /choose\(/);
  assert.ok(f.advertised.at(-1) && !f.advertised.at(-1)!.includes("choose"), "consumed world options stop advertising choose");
  assert.ok(!f.agent.manualTools("avatar").some((tool: { name: string }) => tool.name === "choose"), "manual cockpit retains explicit operations");
  const after = await f.context.toChatMessages("after", false);
  assert.deepEqual(after.slice(0, before.length), before, "capability/menu updates never rewrite the frozen prefix");
  const restored = new BotContext(f.files); await restored.load();
  assert.deepEqual(calls(restored), calls(f.context), "actual operation and selection metadata survive a restart");
  assert.ok(events(f.context).some(event => event.refToolCallId === actual!.id && event.experience?.worldPerception));
  assert.ok(!calls(f.context).some(call => call.name === "choose"), "history stores the real executable operation");
}

async function phoneChoice() {
  const f = await fixture(request => ({ ...structuredClone(request.menu[0]!.call!), duration: 0 }), ["pick_up_phone"], true);
  f.agent.pushEvent("koishi", { text: "手机轻轻震了一下。", originEventIds: ["chat-notice:anonymous"] });
  f.agent.start(); await f.finish();
  assert.equal(calls(f.context)[0]!.name, "pick_up_phone"); assert.equal(calls(f.context)[0]!.duration, 0);
  assert.equal(f.phone.down, false); assert.equal(f.worldCalls.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.generations.length, 1);
}

async function replyAndLengthGuard() {
  for (const blocked of [false, true]) {
    const text = blocked ? "这条消息真的很长，应该先征求长度确认而不是直接发出。" : "好，明天早上见！";
    const f = await fixture(request => {
      const option = request.menu.find(option => !!option.replyTo);
      assert.ok(option); return { name: "send", arguments: { id: option.replyTo, msg: text }, duration: 0 };
    }, ["send"]);
    f.cfg.messaging.longMessageChars = blocked ? 5 : 1000;
    const target = f.chat(); f.agent.start(); await f.finish();
    const actual = calls(f.context)[0]!;
    assert.equal(actual.name, "send"); assert.deepEqual(actual.arguments, { id: target, msg: text });
    assert.equal(actual.selection, undefined);
    const menu = events(f.context).find(event => event.content.startsWith("（当前可考虑的行动机会；"))!.content;
    assert.match(menu, /使用 send/); assert.ok(menu.includes(target)); assert.match(menu, /不是物理 act/);
    assert.equal(f.worldCalls.length, 0); assert.equal(f.generations.length, 1);
    const navigation = allCalls(f.context).filter(call => !!call.navigationFor);
    assert.equal(navigation.length, 1);
    assert.equal(navigation[0]!.name, "select_channel");
    assert.equal(navigation[0]!.arguments.id, target, "automatic navigation retains the original explicit recipient");
    assert.ok(allCalls(f.context).indexOf(navigation[0]!) < allCalls(f.context).indexOf(actual), "the actual navigation precedes the selected send");
    if (blocked) {
      assert.deepEqual(f.sent, []);
      assert.ok(events(f.context).some(event => event.refToolCallId === actual.id && /正文过长，本次未发送.*confirm_long: true/.test(event.content)));
    } else {
      assert.deepEqual(f.sent, [{ id: target, msg: text }], "reply target is the read message, never another current screen");
      assert.ok(events(f.context).some(event => event.refToolCallId === actual.id && event.content.includes("平台确认")));
    }
  }
}

async function invalidActionDoesNotConsume() {
  const f = await fixture(() => ({ name: "act", arguments: { description: "" }, duration: 0 }));
  f.agent.pushEvent("world", scene("stable-menu", 1)); f.agent.start(); await f.finish();
  assert.equal(f.worldCalls.length, 0);
  assert.deepEqual(f.agent.actionOpportunities(), f.generations[0]!.menu, "rejected physical intent retains the known suggestions");
}

async function sceneChangedDuringGeneration() {
  const release = gate<ParsedToolCall>();
  const f = await fixture((_request, ordinal, signal) => ordinal === 1 ? release.promise : hold(signal));
  f.agent.pushEvent("world", scene("old-scene", 1)); f.agent.start();
  await until(() => f.generations.length === 1, "the model must first receive the old menu");
  f.agent.pushEvent("world", scene("new-scene", 2, [...options].reverse()));
  release.resolve({ name: "act", arguments: { description: options[0]!.intent } });
  await f.finish();
  assert.equal(f.generations[0]!.menu[0]!.intent, options[0]!.intent);
  assert.equal(f.worldCalls[0]!.arguments.description, options[0]!.intent, "an explicit intent cannot be redirected by reordered suggestions");
  assert.equal(f.worldCalls.length, 1);

}

async function newMessageCannotRedirectReply() {
  const release = gate<ParsedToolCall>();
  const f = await fixture((_request, ordinal, signal) => ordinal === 1 ? release.promise : hold(signal), ["send"]);
  const originalTarget = f.chat(); f.agent.start();
  await until(() => f.generations.length === 1, "the model must first receive the original reply opportunity");
  const originalIndex = f.generations[0]!.menu.findIndex(option => option.replyTo === originalTarget) + 1;
  assert.ok(originalIndex, "the original menu offers a reply to the observed sender");
  const newerTarget = "onebot@100:private:friend-c";
  f.agent.pushEvent("koishi", { text: "小红：你现在有空吗？", originEventIds: ["chat:friend-c:two"],
    experience: { chat: { kind: "message", channelKey: newerTarget, senderOwn: false } } });
  release.resolve({ name: "send", arguments: { id: originalTarget, msg: "好的，明天见。" } });
  await f.finish();
  assert.deepEqual(f.sent, [{ id: originalTarget, msg: "好的，明天见。" }], "a new notification cannot redirect explicitly addressed text");
  assert.equal(f.worldCalls.length, 0);

}

async function freedomAndUnavailableChoice() {
  const f = await fixture(() => ({ name: "act", arguments: { description: "留在原处，整理衣服" }, duration: 0 }));
  f.agent.pushEvent("world", scene("optional-menu", 1)); f.agent.start(); await f.finish();
  assert.equal(f.worldCalls.length, 1); assert.equal(calls(f.context)[0]!.selection, undefined);
  assert.equal(calls(f.context)[0]!.arguments.description, "留在原处，整理衣服");
  assert.ok(!BOT_TOOLS.some(tool => tool.name === "choose"));
  assert.ok(f.generations.every(request => !request.tools.includes("choose")));

}

async function main() {
  try {
    await worldActionAndCache(); await phoneChoice(); await replyAndLengthGuard(); await invalidActionDoesNotConsume();
    await sceneChangedDuringGeneration(); await newMessageCannotRedirectReply(); await freedomAndUnavailableChoice();
    console.log("PASS direct suggestion loop: retired choose, actual tool calls, literal speech, phone posture, explicit send targets and guards, failed-action retention, reordered menus, append-only cache and free actions");
  } finally {
    for (const agent of agents) await agent.stop();
    for (const base of directories) await fs.rm(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
