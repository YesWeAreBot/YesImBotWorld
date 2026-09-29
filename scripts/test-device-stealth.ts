/** Real Bot/device dispatch with local stubs. No LLM, platform, Docker or online WebUI. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { AssistantApp } from "../src/apps/assistant.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { signatureParams } from "../src/bot/nativeTools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WorldService } from "../src/service.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(test: () => boolean) {
  // Real filesystem completion is not bounded by a number of event-loop spins.
  const deadline = Date.now() + 2000;
  while (!test() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 1));
  assert.ok(test(), "expected actual task completion");
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-stealth-"));
  let bot: any;
  try {
    const files = new WorldFiles(dir); await files.ensure();
    const cfg = Config({ autoStart: false }); cfg.bot.ignoreSendDuration = true;
    const clock: any = { now: () => 1, timeLine: () => "T=1", realMsUntil: (at: number) => at > 1 ? 60000 : 0, unitRealSeconds: 1, unitWorldSeconds: 1 };
    const phone = { down: true }, context = new BotContext(files, "");
    let calls = 0, opens = 0, sends = 0, peeks = 0, block = false, fail = false;
    const entered = gate(), finish = gate(), order: string[] = [];
    const assistantEntered = gate(), assistantFinish = gate();
    const assistant = new AssistantApp({ historyFile: path.join(dir, "phone-assistant.json"), llm: {} as any,
      client: { complete: async () => { assistantEntered.resolve(); await assistantFinish.promise; return { content: "仅在助手屏幕阅读的答案" } as any; } },
      onComplete: notice => bot.notifyDevice(notice),
    });
    const app = { id: "notes", name: "记事本", description: "fixture", async open() { opens++; return { tools: [{ name: "read_note", description: "read fixture", inputSchema: { type: "object", properties: {} } }] }; }, async close() { order.push("close"); }, async call() {
      calls++; order.push("call-start"); if (block) { entered.resolve(); await finish.promise; } if (fail) throw new Error("fixture device disconnected"); order.push("call-finish"); return "visible fixture content";
    } };
    const defs = BOT_TOOLS.filter(tool => ["open_app", "close_app", "pick_up_phone", "put_down_phone", "select_channel", "send", "check_msg", "observe_device", "act", "think", "check_status", "check_time"].includes(tool.name));
    assert.deepEqual(signatureParams(defs.find(tool => tool.name === "observe_device")!.signature), [{ name: "device", required: true, schema: { type: "string", enum: ["phone", "computer"] } }]);
    const apps = new AppManager("chat", [app, assistant], new Set(defs.map(tool => tool.name)), logger);
    const messenger: any = { recentChannels: async () => ({ text: "cached channels" }), channelMessages: async () => ({ text: "cached messages" }), resolveKey: async () => ({ key: "onebot@fixture:channel", isPrivate: true }), putDownPhone: async () => "phone down", send: async () => { sends++; return "sent fixture message"; } };
    const world: any = { adjudicateAct: async (_call: any, deliver: any, _signal: any, commit: any) => { assert.ok(commit()); deliver("你看向周围的环境。"); return true; }, observe: async () => ({ observationId: "fixture-observation", actorId: "bot", sourceEventIds: [], entities: [] }), resolveCheckTime: async () => {} };
    const computer: any = { isOpen: false, activeToolNames: () => [], activeToolDefs: () => [], view: () => null, hasTool: () => false };
    bot = new BotAgent(cfg, clock, files, context, world, messenger, apps, computer, null, phone, logger, defs, null, async () => { peeks++; return { text: "actual visible screen" }; });
    bot.running = true;
    let declared: string[] = [];
    bot.backend = { setToolNames(names: string[]) { declared = [...names]; }, setToolDefs() {} };
    bot.refreshToolGate();
    const service: any = Object.create(WorldService.prototype);
    Object.assign(service, { bot, appManager: apps, computerDevice: null, remoteDesktopApp: null, worldActive: true, deviceTail: Promise.resolve(), devicePending: 0, config: cfg });
    const stealth = (name: string, args: Record<string, unknown> = {}, confirm = false) => service.deviceToolCall(name, args, 0, confirm, "stealth");
    let serial = 0;
    async function autonomous(name: string, args: Record<string, unknown> = {}) {
      const call = { id: "autonomous-" + ++serial, role: "agent", name, arguments: args, issuedAt: 1, expectedAt: 1 };
      await context.appendToolCall(call as never); await bot.dispatch(call); return call.id;
    }
    bot.scheduler.schedule({ id: "pending-wait", role: "agent", name: "wait", arguments: {}, issuedAt: 1, expectedAt: 60 }, { executeAt: "expected", run: async () => "wait receipt" });
    let independentActExecutions = 0;
    bot.scheduler.schedule({ id: "pending-act", role: "agent", name: "act", arguments: { description: "等待院门打开" }, issuedAt: 1, expectedAt: 60 }, {
      executeAt: "expected", run: async () => { independentActExecutions++; return "院门已经打开。"; },
    });
    bot.waiting = { callId: "pending-wait", kind: "wait", startedTU: 1 };
    assert.equal((await stealth("open_app", { name: "notes" })).ok, true);
    assert.equal(bot.manualMode, false); assert.equal(opens, 1);
    assert.equal(bot.scheduler.isPending("pending-wait"), true); assert.equal(bot.waiting.callId, "pending-wait");
    assert.equal(bot.scheduler.isPending("pending-act"), true);
    assert.equal(context.stream.length, 0, "stealth is never represented as Bot's own tool call");
    assert.equal(bot.mailbox.length, 0); assert.equal(peeks, 0, "unattended device does not capture or disclose content");
    bot.refreshToolGate();
    assert.equal(declared.includes("read_note"), false, "unrelated refresh cannot leak a hidden app through model tool declarations");
    assert.ok(declared.includes("open_app"), "Bot retains its previously known device entry point");
    assert.ok(bot.manualTools().some((tool: any) => tool.name === "read_note"), "admin sees the actual active device schema");
    bot.pushEvent("koishi", "手机震了一下"); assert.equal(bot.mailbox.length, 2);
    assert.equal(bot.mailbox.filter((event: any) => event.source === "koishi" && event.content === "手机震了一下").length, 1, "the normal notification body keeps its route without duplication");
    const interruption = bot.mailbox.filter((event: any) => event.source === "system" && event.refToolCallId === "pending-wait");
    assert.equal(interruption.length, 1); assert.match(interruption[0].content, /计时中断/);
    assert.equal(bot.waiting, null); assert.equal(bot.scheduler.isPending("pending-wait"), false, "a real notification interrupts the character's pause");
    assert.equal(bot.scheduler.isPending("pending-act"), true, "interrupting the pause must not cancel independent world work");
    assert.equal(independentActExecutions, 0, "a notification cannot execute a scheduled world action prematurely");
    bot.mailbox = [];

    const look = await autonomous("observe_device", { device: "phone" }); await until(() => !bot.scheduler.isPending(look));
    assert.equal(bot.deviceAttention, "phone");
    assert.equal(phone.down, true, "looking at the nearby screen does not pick up the phone");
    assert.equal(opens, 1); assert.equal(calls, 0, "read-only attention never opens or operates an app");
    assert.ok(declared.includes("read_note"), "explicit observation restores the actual visible app tools");
    assert.equal(peeks, 1, "Bot sees the actual device when it next looks, without a hidden-operation history");
    assert.ok(bot.mailbox.some((event: any) => /当前可见界面.*记事本/.test(event.content)));
    for (const [name, args] of [["think", { thought: "我还想看完这篇笔记。" }], ["think", { thought: "刚才那个问题可以稍后再想。" }]] as const) {
      const id = await autonomous(name, args); await until(() => !bot.scheduler.isPending(id));
      assert.equal(bot.deviceAttention, "phone", `${name} must not invent looking away`);
    }
    bot.mailbox = [];
    const before = context.stream.length;
    await stealth("open_app", { name: "chat" });
    assert.equal(context.stream.length, before);
    assert.equal(peeks, 2);
    const screen = bot.mailbox.filter((event: any) => /当前可见界面/.test(event.content));
    assert.equal(screen.length, 1);
    assert.match(screen[0].content, /当前可见界面.*QQ/);
    assert.match(screen[0].content, /actual visible screen/);
    assert.doesNotMatch(screen[0].content, /管理员|偷偷|人类|黑客|你打开了|疑惑|感到/);
    assert.equal(bot.scheduler.isPending("pending-act"), true, "visible changes do not cancel unrelated autonomous world tasks");
    assert.equal(independentActExecutions, 0);
    assert.equal(bot.scheduler.pending().find((task: any) => task.id === "pending-act").committed, false, "protection is not merely caused by an irreversible commit");
    assert.equal(bot.scheduler.cancel("pending-act"), "cancelled", "explicit fixture cleanup releases the still-cancellable independent action");
    const pickUp = await autonomous("pick_up_phone"); await until(() => !bot.scheduler.isPending(pickUp));
    const putDown = await autonomous("put_down_phone"); await until(() => !bot.scheduler.isPending(putDown));
    bot.mailbox = []; const priorPeeks = peeks;
    await stealth("open_app", { name: "notes" });
    assert.equal(bot.deviceAttention, null); assert.equal(bot.mailbox.length, 0); assert.equal(peeks, priorPeeks);
    assert.equal((await stealth("pick_up_phone")).ok, false, "stealth never controls the character's body");
    assert.equal((await stealth("observe_device", { device: "phone" })).ok, false, "a hidden admin call cannot force the Bot's attention");
    const closedComputer = await autonomous("observe_device", { device: "computer" }); await until(() => !bot.scheduler.isPending(closedComputer));
    assert.equal(peeks, priorPeeks, "observing a closed computer cannot connect or capture a screen");
    assert.ok(bot.mailbox.some((event: any) => /电脑当前已关闭/.test(event.content)));
    assert.equal(computer.isOpen, false); assert.equal(opens, 2);
    const worldLook = await autonomous("act", { description: "看向周围的环境" }); await until(() => !bot.scheduler.isPending(worldLook));
    assert.equal(bot.deviceAttention, null, "explicitly observing surroundings changes the focus without guessing prose");

    // Bot operation -> human close -> stale Bot operation. Only individual effects hold the queue.
    const lookAgain = await autonomous("observe_device", { device: "phone" }); await until(() => !bot.scheduler.isPending(lookAgain));
    phone.down = false; block = true; order.length = 0; calls = 0;
    await autonomous("read_note"); await entered.promise;
    const close = stealth("close_app"); await tick();
    const stale = await autonomous("read_note");
    await tick(); assert.equal(calls, 1); assert.equal(apps.currentName, "记事本");
    finish.resolve(); await close; await until(() => !bot.scheduler.isPending(stale));
    assert.equal(calls, 1, "Bot's queued operation cannot run against a closed app");
    assert.deepEqual(order, ["call-start", "call-finish", "close"]);
    assert.ok(bot.mailbox.some((event: any) => /界面已改变/.test(event.content)));
    block = false;
    const reopen = await autonomous("open_app", { name: "notes" }); await until(() => !bot.scheduler.isPending(reopen));
    assert.equal(apps.currentName, "记事本", "Bot can reopen the device after human intervention");
    fail = true; bot.mailbox = [];
    const failure = await stealth("read_note");
    assert.equal(failure.ok, false); assert.match(failure.text, /fixture device disconnected/);
    assert.equal(bot.mailbox.length, 0, "failed hidden operations cannot become a Bot action receipt"); fail = false;

    await stealth("open_app", { name: "chat" }); await stealth("select_channel", { id: "onebot@fixture:channel" });
    assert.equal((await stealth("send", { id: "onebot@fixture:channel", msg: "explicit fixture message" })).ok, false); assert.equal(sends, 0);
    assert.equal((await stealth("send", { id: "onebot@fixture:channel", msg: "explicit fixture message" }, true)).ok, true); assert.equal(sends, 1);
    assert.equal(bot.manualMode, false);
    assert.equal((await stealth("send", { id: "onebot@fixture:channel", msg: "unfinished <img>" }, true)).ok, false);

    const downForBackground = await autonomous("put_down_phone"); await until(() => !bot.scheduler.isPending(downForBackground));
    bot.mailbox = [];
    const streamBeforeBackground = context.stream.length;
    await stealth("open_app", { name: "assistant" });
    const asking = await stealth("ask", { question: "秘密输入的问题" });
    assert.equal(asking.ok, true); await assistantEntered.promise;
    assert.equal(bot.mailbox.length, 0, "background work does not leak the hidden immediate tool acknowledgement");
    assert.equal(context.stream.length, streamBeforeBackground, "a hidden question is not recorded as the character's own decision");
    await stealth("close_app");
    assistantFinish.resolve();
    await until(() => bot.mailbox.some((event: any) => /任务.*已完成/.test(event.content)));
    const completion = bot.mailbox.find((event: any) => /任务.*已完成/.test(event.content));
    assert.equal(phone.down, true);
    assert.equal(completion.source, "system"); assert.deepEqual(completion.originEventIds, []);
    assert.equal(completion.experience.worldPerception, false); assert.equal(completion.experience.agency, "observed");
    assert.doesNotMatch(completion.content, /秘密输入的问题|仅在助手屏幕阅读的答案|已向.*提交问题/);
    assert.equal(bot.mailbox.some((event: any) => event.refToolCallId === asking.callId), false, "only the normal device notification bypasses the hidden receipt filter");
    await assistant.dispose();
    // Device notification sources are excluded from Growth even if their wording
    // mentions a world event; reading an assistant is not a physical perception.
    await bot.growth.perceive({ ...completion, id: "fixture-background-completion", worldTime: 1 });
    assert.equal((await bot.growth.recallEvidence({ eventIds: ["fixture-background-completion"] })).length, 0);

    await stealth("open_app", { name: "notes" });
    const lookAfterBackground = await autonomous("observe_device", { device: "phone" }); await until(() => !bot.scheduler.isPending(lookAfterBackground));
    phone.down = false;
    const previousCalls = calls;
    let delayedDone = false;
    const delayed = service.deviceToolCall("read_note", {}, 9, false, "stealth").then((result: any) => { delayedDone = true; return result; });
    await until(() => calls > previousCalls);
    const duringReceiptDelay = await autonomous("read_note");
    await until(() => !bot.scheduler.isPending(duringReceiptDelay));
    assert.equal(delayedDone, false, "the hidden receipt still follows its declared duration");
    assert.equal(calls, previousCalls + 2, "Bot can operate again before the earlier human receipt is due");
    await bot.stop();
    assert.equal((await delayed).ok, true, "world stop preserves the already-completed hidden result");
    console.log("PASS stealth devices: explicit sends, autonomous continuity, serialized contention, stale-tool rejection, attended perception and no unattended leakage");
  } finally { await bot?.stop(); await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
