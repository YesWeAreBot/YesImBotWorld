/** A send always names its destination; screen focus is not a delivery address. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { planToolNavigation, type NavigationState } from "../src/bot/navigation.js";
import { toNativeToolDefs } from "../src/bot/nativeTools.js";
import { BOT_TOOLS, renderToolHelp, renderToolsText } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ParsedToolCall, ToolCallRecord } from "../src/types.js";

const A = "onebot@fixture:group-a", B = "onebot@fixture:group-b", C = "onebot@fixture:group-c";
const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean, details?: () => unknown) {
  for (let i = 0; i < 1500 && !check(); i++) await pause(2);
  assert.ok(check(), "explicit-target fixture did not settle" + (details ? JSON.stringify(details()) : ""));
}
const agents: any[] = [], dirs: string[] = [];
const invalidTargets: Record<string, unknown>[] = [
  {}, { id: undefined }, { id: null }, { id: "" }, { id: " \n\t" }, { id: 123 }, { id: false }, { id: [A] }, { id: { toString: A } },
  { channel: A }, { id: null, channel: A }, { id: A, channel: B }, { id: A, channel: undefined }, { channel_id: A },
];
const parsed = (args: Record<string, unknown>, duration?: number): ParsedToolCall => ({ name: "send", arguments: { msg: "明确写给甲群的一句话。", ...args }, ...(duration == null ? {} : { duration }) });

async function fixture(options: { down?: boolean; typed?: boolean; generation?: Promise<void>; first?: ParsedToolCall; legacyPrefix?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-explicit-send-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files); await context.load();
  let legacy: { messages: unknown[]; native: unknown[]; toolsText: string } | undefined;
  if (options.legacyPrefix) {
    const oldSend = { ...BOT_TOOLS.find(tool => tool.name === "send")!, signature: "send(msg: string, id?: string)",
      summary: "发送原话；id 缺省为当前频道。", description: "发送原话；id 缺省为当前频道。", inputSchema: undefined };
    context.pinned.toolsText = renderToolsText([oldSend]);
    await context.appendEvent({ id: context.nextEventId(), source: "koishi", content: "升级前已实际读到的聊天记录。", worldTime: 9 });
    legacy = { messages: structuredClone(await context.toChatMessages("旧时间", false)),
      native: structuredClone(await context.nativeToolSnapshot("旧时间", toNativeToolDefs([oldSend]))), toolsText: context.pinned.toolsText };
  }
  const config = Config({ autoStart: false });
  Object.assign(config.bot, { minIntervalMs: 0, retryDelayMs: 1, maxWindowChars: 1_000_000, restCompressMinChars: 1_000_000,
    spillMinChars: 0, waitRateThreshold: 0, ignoreSendDuration: !options.typed });
  config.bot.growth.enabled = false; config.messaging.sendEcho = false;
  let deadlineReached = false;
  const clock: any = { now: () => 10, timeLine: () => "T10", unitWorldSeconds: 1, unitRealSeconds: 1,
    realMsUntil: (at: number) => at > 10 && !deadlineReached ? 15 : 0 };
  const phone = { down: options.down ?? false };
  const defs = BOT_TOOLS.filter(def => ["help", "think", "pick_up_phone", "put_down_phone", "open_app", "close_app", "select_channel", "read_channel", "send", "cancel"].includes(def.name));
  const navigation: string[] = [], sent: { key: string; msg: string }[] = [];
  const messenger: any = {
    resolveKey: async (key: string) => { navigation.push(`resolve:${key}`); return [A, B, C].includes(key) ? { key, isPrivate: false } : { error: "未知频道。" }; },
    recentChannels: async () => { navigation.push("chat-home"); return { text: "甲群、乙群、丙群。" }; },
    channelMessages: async (key: string) => { navigation.push(`read:${key}`); return { text: "该群的原始消息。" }; },
    putDownPhone: async () => "已放下手机。",
    sendReceipt: async (key: string, msg: string) => { sent.push({ key, msg }); return { text: `消息已发送到 ${key}。`, status: "sent", messageIds: ["fixture-sent"] }; },
  };
  const apps = new AppManager("chat", [], new Set(defs.map(def => def.name)), logger);
  const agent: any = new BotAgent(config, clock, files, context, {} as any, messenger, apps, null, null, phone, logger, defs);
  agents.push(agent);
  agent.phoneUi = { chatOpen: !phone.down, channelKey: B, channelIsGroup: true, forwardStack: [] };
  agent.lastNotifyKey = C;
  if (!phone.down) agent.attention = "phone";
  agent.refreshToolGate();
  const requests: unknown[][] = [];
  agent.backend = { setToolNames() {}, setToolDefs() {}, generate: async () => {
    requests.push(structuredClone(await context.toChatMessages("T10", false)));
    if (requests.length === 1) { await options.generation; return options.first ?? parsed({ id: A }); }
    agent.setManualPaused(true);
    return { name: "think", arguments: { thought: "收到了这次真实执行结果。" } };
  } };
  return { agent, context, files, legacy, phone, requests, navigation, sent, reachDeadline() { deadlineReached = true; } };
}

async function rejectedBeforeNavigationOrDispatch() {
  for (const down of [false, true]) for (const args of invalidTargets) {
    let resolutions = 0;
    const state: NavigationState = { phone: { down }, chatOpen: !down, channelKey: B, channelIsGroup: true, chatApp: "chat", builtin: true, device: "phone" };
    const plan = await planToolNavigation(parsed(args), state, async key => { resolutions++; return { key, isPrivate: false }; });
    assert.ok(plan.error, JSON.stringify(args)); assert.deepEqual(plan.steps, []);
    assert.equal(resolutions, 0, "invalid send destinations cannot trigger resolution or navigation even with a selected screen");
  }
  const direct = await fixture();
  direct.agent.running = true;
  for (let i = 0; i < invalidTargets.length; i++) {
    const call: ToolCallRecord = { ...parsed(invalidTargets[i]!), id: `invalid-${i}`, role: "system", issuedAt: 10, expectedAt: 10 };
    await direct.agent.dispatchTool(call);
    await direct.agent.scheduler.whenIdle();
    assert.equal(direct.sent.length, 0, "direct/manual dispatch cannot bypass the explicit-id rule");
    assert.equal(direct.navigation.length, 0, "a rejected direct send must not navigate, resolve, or read the selected/latest room");
    assert.ok(direct.agent.mailbox.some((event: any) => event.refToolCallId === call.id && /id|目标频道/.test(event.content)));
  }
  await direct.agent.stop();
  for (const down of [false, true]) {
    const f = await fixture({ down, first: parsed({}) });
    const before = structuredClone(f.agent.phoneUi);
    f.agent.start(); await until(() => f.requests.length === 2); await f.agent.stop();
    assert.deepEqual(f.sent, []); assert.deepEqual(f.navigation, []); assert.deepEqual(f.agent.phoneUi, before);
    assert.equal(f.phone.down, down);
    assert.ok(JSON.stringify(f.requests[1]).includes("id"), "autonomous inference receives an actionable target-parameter failure");
  }
}

async function explicitTargetSurvivesScreenChanges() {
  const immediate = await fixture();
  immediate.agent.start(); await until(() => immediate.requests.length === 2, () => ["immediate", immediate.context.stream, immediate.agent.status()]); await immediate.agent.stop();
  assert.deepEqual(immediate.sent.map(item => item.key), [A], "the actual send selects its explicit destination while another group is open");
  const generating = gate(), duringGeneration = await fixture({ generation: generating.promise });
  duringGeneration.agent.start(); await until(() => duringGeneration.requests.length === 1);
  await duringGeneration.agent.enterChannel(C, false);
  generating.resolve(); await until(() => duringGeneration.requests.length === 2, () => ["generation", duringGeneration.context.stream]); await duringGeneration.agent.stop();
  assert.deepEqual(duringGeneration.sent.map(item => item.key), [A], "a new screen during inference cannot replace the tool's explicit destination");

  const longMessage = "A complete fixture message is still being typed while the visible group changes.";
  const typing = await fixture({ typed: true, first: parsed({ id: A, msg: longMessage }, 3) });
  typing.agent.start(); await until(() => typing.agent.scheduler.pendingByName("send").length === 1, () => ["typing-pending", typing.context.stream]);
  assert.deepEqual(typing.sent, []);
  await typing.agent.enterChannel(C, false);
  typing.reachDeadline(); await until(() => typing.requests.length === 2, () => ["typing-finished", typing.context.stream, typing.agent.status()]); await typing.agent.stop();
  assert.deepEqual(typing.sent, [{ key: A, msg: longMessage }], "queued sends retain the declared destination when the screen changes before execution");
}

async function updatedContractAppendsWithoutRewritingPrefix() {
  const f = await fixture({ legacyPrefix: true });
  const original = f.legacy!;
  f.agent.running = true;
  await f.agent.drainMailbox();
  const notices = f.context.stream.filter(entry => entry.kind === "event" && entry.event.toolAvailability);
  assert.ok(notices.some(entry => entry.kind === "event" && /send\([^\n]*\bid: string/.test(entry.event.content)), "the changed required target is appended through the existing capability announcement");
  assert.equal(f.context.pinned.toolsText, original.toolsText);
  assert.deepEqual((await f.context.toChatMessages("新时间", false)).slice(0, original.messages.length), original.messages);
  assert.deepEqual(await f.context.nativeToolSnapshot("新时间", toNativeToolDefs(BOT_TOOLS)), original.native);
  const length = f.context.stream.length;
  f.agent.refreshToolGate(); await f.agent.drainMailbox();
  assert.equal(f.context.stream.length, length, "unchanged send semantics are not announced each turn");
  const reopened = new BotContext(f.files); await reopened.load();
  assert.deepEqual(await reopened.toChatMessages("重启时间", false), await f.context.toChatMessages("新时间", false));
  assert.deepEqual(await reopened.nativeToolSnapshot("重启时间", toNativeToolDefs(BOT_TOOLS)), original.native);
  await f.agent.stop();
}

async function main() {
  const timeout = setTimeout(() => { console.error("explicit send target test timed out"); process.exit(1); }, 30_000);
  try {
    const send = BOT_TOOLS.find(tool => tool.name === "send")!;
    assert.match(send.signature, /\bid: string/); assert.doesNotMatch(send.signature, /\bid\?:/);
    const native = toNativeToolDefs([send])[0]!.function.parameters;
    assert.ok((native.required as string[]).includes("id"));
    assert.equal((native.properties as Record<string, any>).id.type, "string");
    for (const text of [send.description, send.summary ?? "", renderToolHelp(send), renderToolsText([send])]) {
      assert.doesNotMatch(text, /id\s*(?:省略|缺省)|可省略\s*id|id\?:/);
    }
    await rejectedBeforeNavigationOrDispatch();
    await explicitTargetSurvivesScreenChanges();
    await updatedContractAppendsWithoutRewritingPrefix();
    console.log("PASS required send id in schema/help, invalid targets rejected before navigation/manual dispatch, and explicit destinations stable across generation and queued typing");
  } finally {
    clearTimeout(timeout);
    for (const agent of agents) await agent.stop();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
