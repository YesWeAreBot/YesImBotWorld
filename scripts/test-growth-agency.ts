/** Real WorldAgent -> Scheduler -> BotContext -> growth evidence, with deterministic local inference. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { ReceiptInbox } from "../src/bot/receipts.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WorldAgent } from "../src/world/agent.js";
import type { BotEvent, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(test: () => boolean) { for (let i = 0; i < 2000 && !test(); i++) await tick(); assert.ok(test(), "expected lifecycle boundary"); }

async function fixture(base: string) {
  const files = new WorldFiles(base); await files.ensure();
  const cfg = Config({ autoStart: false }); cfg.bot.growthReviewEnabled = false; cfg.bot.ignoreSendDuration = true;
  cfg.bot.repeatThresholds = [100, 200, 300]; cfg.bot.waitRateThreshold = 0;
  let time = 1, status: "completed" | "failed" | "needs_input" = "completed";
  const clock: any = { now: () => time, timeLine: () => `T${time}`, realMsUntil: (at: number) => Math.max(0, at - time) * 1000,
    unitWorldSeconds: 10, unitRealSeconds: 1, syncRealTime: false };
  await files.atomicWrite(files.botDef, "小澈喜欢散步。");
  await files.atomicWrite(files.worldDef, "小澈住在河边，刚吃过晚饭。");
  const world = new WorldAgent(cfg.world, files, clock, logger);
  (world as any).client = { complete: async (messages: any[]) => {
    const input = JSON.parse(messages[1].content);
    const result = input.kind === "initialize"
      ? { botName: "小澈", worldState: "小澈站在家门口。", actorStates: [{ actorId: "bot", state: "已经吃完晚饭，准备休息。" }], perceptions: [{ actorId: "bot", text: "家门外的河岸很安静。" }] }
      : { worldState: `河边的路灯亮着。第 ${time} 个世界时刻。`, outcome: { status },
        actorStates: [{ actorId: "bot", state: status === "completed" ? "沿河走了一圈，回到家门口。" : "仍在家门口，尚未完成沿河散步。" }],
        perceptions: [{ actorId: "bot", text: status === "completed" ? "你沿着河边走了一圈，回来时晚风依然凉爽。"
          : status === "failed" ? "门锁卡住了，你没能出去。" : "门口在下雨，你还需要决定是否拿伞。" }] };
    return { content: "", toolCalls: [{ id: "resolution", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(result) } }] };
  } };
  await world.runtime.ensure();
  const context = new BotContext(files); await context.load();
  const defs = BOT_TOOLS.filter(tool => ["act", "observe", "pick_up_phone", "open_app", "close_app", "wait", "cancel", "reflect", "recall_growth"].includes(tool.name));
  const apps = new AppManager("chat", [{ id: "fixture", name: "fixture", description: "local fixture",
    async open() { return { tools: [{ name: "try_save", description: "fixture save", inputSchema: { type: "object", properties: {} } }] }; },
    async close() {}, async call() { return "保存失败，文件没有修改。"; } }], new Set(defs.map(tool => tool.name)), logger);
  const bot: any = new BotAgent(cfg, clock, files, context, world, {} as any, apps, null, null, { down: true }, logger, defs);
  bot.running = true; bot.backend = { setToolNames() {}, setToolDefs() {} }; bot.refreshToolGate();
  async function autonomous(name: string, args: Record<string, unknown> = {}, duration = 0) {
    const call: ToolCallRecord = { id: context.nextToolId(), role: "agent", name, arguments: args, ...(duration ? { duration } : {}), issuedAt: time, expectedAt: time + duration };
    await context.appendToolCall(call); await bot.dispatch(call); return call;
  }
  async function delivered(callId: string): Promise<BotEvent> {
    await bot.scheduler.whenIdle(); await bot.drainMailbox();
    const entry = [...context.stream].reverse().find(item => item.kind === "event" && item.event.refToolCallId === callId && item.event.source === "tool");
    assert.ok(entry?.kind === "event", `tool receipt for ${callId}: ${JSON.stringify(context.stream.filter(item => item.kind === "tool_call" ? item.call.id === callId : item.event.refToolCallId === callId))}`); return entry.event;
  }
  return { files, cfg, clock, world, context, bot, apps, autonomous, delivered,
    advance: (at: number) => { time = at; }, outcome: (next: typeof status) => { status = next; } };
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "growth-agency-"));
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
  async function make(label: string) { const value = await fixture(path.join(base, label)); fixtures.push(value); return value; }
  try {
    const f = await make("actual-world");
    const first = await f.autonomous("act", { description: "吃过晚饭，去河边散步一圈。" });
    const firstReceipt = await f.delivered(first.id);
    assert.equal(JSON.parse(firstReceipt.content).action.status, "completed", "use the actual WorldAgent action envelope, not guessed observation fields");
    assert.equal(firstReceipt.experience?.agency, "self"); assert.equal(firstReceipt.experience?.outcome, "completed");
    assert.equal(firstReceipt.experience?.opportunity, true); assert.match(firstReceipt.experience?.action ?? "", /去河边散步/);
    const firstEvidence = (await f.bot.growth.recallEvidence({ eventIds: [firstReceipt.id] }))[0];
    assert.deepEqual(firstEvidence.experience, firstReceipt.experience);
    const firstPosition = f.context.stream.findIndex(entry => entry.kind === "event" && entry.event.id === firstReceipt.id);
    const earlierWorld = f.context.stream.slice(0, firstPosition).find(entry => entry.kind === "event" && entry.event.source === "world");
    assert.ok(earlierWorld?.kind === "event", "an unread world perception keeps its position before the action receipt");
    assert.equal(earlierWorld.event.experience?.agency, "observed");
    assert.ok(earlierWorld.event.originEventIds?.every(root => !firstReceipt.originEventIds?.includes(root)),
      "background perceptions and a newly performed action must never share attribution roots");
    const ids = [firstReceipt.id];
    for (const time of [2, 3]) { f.advance(time); const call = await f.autonomous("act", { description: `晚饭后第${time}次沿河散步。` }); ids.push((await f.delivered(call.id)).id); }
    const history = await f.bot.growth.recallEvidence({ eventIds: ids });
    assert.equal(new Set(history.map((item: any) => item.experience.episodeId)).size, 1, "looping acts in a half-hour cannot manufacture three independent habits");
    await assert.rejects(f.bot.growth.reflect({ kind: "habit", subject: "饭后散步", situation: "晚饭之后", statement: "喜欢晚饭后沿河散步。", evidenceIds: ids }, 3), /自主完成/);
    f.advance(181);
    const later = await f.autonomous("act", { description: "下一段时间再次沿河散步。" });
    assert.notEqual((await f.delivered(later.id)).experience?.episodeId, firstReceipt.experience?.episodeId);

    f.outcome("needs_input"); f.advance(182);
    const needs = await f.autonomous("act", { description: "到河边散步。" }); const needsReceipt = await f.delivered(needs.id);
    assert.equal(JSON.parse(needsReceipt.content).action.status, "needs_input");
    assert.equal(needsReceipt.experience?.outcome, "unknown"); assert.equal(needsReceipt.experience?.opportunity, false);
    f.outcome("failed"); f.advance(183);
    const failed = await f.autonomous("act", { description: "打开卡住的门。" }); const failedReceipt = await f.delivered(failed.id);
    assert.equal(failedReceipt.experience?.outcome, "failed"); assert.equal(failedReceipt.experience?.opportunity, false);

    f.outcome("completed"); f.advance(184);
    await f.bot.acquireResidentControl("avatar", "avatar-session");
    const avatar = await f.bot.injectExternalToolCall("act", { description: "去河边散步，看看晚霞。" }, { control: { mode: "avatar", sessionId: "avatar-session" } });
    assert.equal(avatar.ok, true); const avatarReceipt = await f.delivered(avatar.callId);
    assert.equal(avatarReceipt.experience?.agency, "self"); assert.equal(avatarReceipt.experience?.outcome, "completed"); assert.equal(avatarReceipt.experience?.opportunity, true);
    assert.ok(f.context.stream.some(entry => entry.kind === "tool_call" && entry.call.id === avatar.callId && entry.call.control?.mode === "avatar"), "full incarnation keeps the character's chosen act in its own stream");
    await f.bot.releaseResidentControl("avatar-session");
    await f.bot.acquireResidentControl("puppet", "puppet-session"); f.advance(185);
    const hiddenIntent = "PRIVATE_CONTROLLER_INTENTION_只为管理员验证身体控制";
    const puppet = await f.bot.injectExternalToolCall("act", { description: hiddenIntent }, { control: { mode: "puppet", sessionId: "puppet-session" } });
    const puppetReceipt = await f.delivered(puppet.callId);
    assert.equal(puppetReceipt.experience?.agency, "imposed"); assert.equal(puppetReceipt.experience?.opportunity, false);
    assert.doesNotMatch(JSON.stringify(puppetReceipt), /PRIVATE_CONTROLLER_INTENTION/);
    assert.ok(!f.context.stream.some(entry => entry.kind === "tool_call" && entry.call.id === puppet.callId));
    assert.doesNotMatch(JSON.stringify(await f.bot.growth.recallEvidence({ eventIds: [puppetReceipt.id] })), /PRIVATE_CONTROLLER_INTENTION/);
    assert.doesNotMatch(JSON.stringify(await f.context.toChatMessages("T185")), /PRIVATE_CONTROLLER_INTENTION/);
    await f.bot.releaseResidentControl("puppet-session");

    const beforeStealth = (await f.bot.growth.stats()).perceivedEvents;
    assert.equal((await f.bot.injectExternalToolCall("open_app", { name: "fixture" }, { stealth: true })).ok, true);
    await f.bot.drainMailbox();
    assert.equal((await f.bot.growth.stats()).perceivedEvents, beforeStealth, "an unattended hidden operation is not a character experience");
    const pickup = await f.autonomous("pick_up_phone"); await f.delivered(pickup.id);
    assert.equal(f.bot.phone.down, false, "an autonomous app interaction requires the actual phone to be held");
    const open = await f.autonomous("open_app", { name: "fixture" }); await f.delivered(open.id);
    const save = await f.autonomous("try_save"); const saveReceipt = await f.delivered(save.id);
    assert.match(saveReceipt.content, /保存失败/);
    assert.notEqual(saveReceipt.experience?.outcome, "completed", "an application returning a soft error is not a completed voluntary choice");
    assert.notEqual(saveReceipt.experience?.opportunity, true);

    // Malformed/opaque action envelopes cannot be upgraded by the scheduler's successful return alone.
    const originalAct = f.world.adjudicateAct.bind(f.world);
    (f.world as any).adjudicateAct = async (_call: any, deliver: any, _signal: any, commit: any) => {
      assert.ok(commit()); deliver(JSON.stringify({ observation: { mode: "narrative", actorId: "bot", observationId: "missing-status", sourceEventIds: ["missing-status-source"], narrative: "没有确认动作已完成。" } })); return true;
    };
    const absent = await f.autonomous("act", { description: "尝试进行一项尚无完成确认的操作。" });
    assert.equal((await f.delivered(absent.id)).experience?.outcome, "unknown");
    (f.world as any).adjudicateAct = originalAct;

    const cancelled = await f.autonomous("wait", { n: 300 }, 300);
    assert.ok(f.bot.operationCalls.has(cancelled.id));
    await f.autonomous("cancel", { id: cancelled.id }); await f.bot.drainMailbox();
    assert.equal(f.bot.operationCalls.has(cancelled.id), false, "cancelled work must not retain a stale attribution entry");
    assert.ok(!(await f.bot.growth.recallEvidence({ n: 50 })).some((item: any) => item.experience?.action?.includes("等待") && item.experience?.outcome === "completed"));

    for (const mode of ["avatar", "puppet"] as const) {
      const retired = await make(`late-${mode}`); await retired.bot.acquireResidentControl(mode, "late-session");
      const entered = gate(), finish = gate();
      (retired.world as any).adjudicateAct = async (call: ToolCallRecord, deliver: (text: string) => void, _signal: AbortSignal, commit: () => boolean) => {
        assert.ok(commit()); entered.resolve(); await finish.promise;
        deliver(JSON.stringify({ mode: "narrative", actorId: "bot", observationId: `before-${mode}`, sourceEventIds: [`before-source-${mode}`], narrative: "行动前，河对岸的路灯亮起来。" }));
        deliver(JSON.stringify({ action: { status: "completed", intent: call.arguments.description }, observation: {
          mode: "narrative", actorId: "bot", observationId: `late-${mode}`, sourceEventIds: [`late-source-${mode}`], narrative: "身体沿着河边走了一圈。",
        } }));
        deliver(JSON.stringify({ mode: "narrative", actorId: "bot", observationId: `after-${mode}`, sourceEventIds: [`after-source-${mode}`], narrative: "回来之后，一只鸟停在窗边。" })); return true;
      };
      const pending = retired.bot.injectExternalToolCall("act", { description: hiddenIntent }, { control: { mode, sessionId: "late-session" } });
      await entered.promise;
      const active = retired.bot.scheduler.pending()[0];
      assert.equal(retired.bot.cancelExternalTool(active.id, "late-session").status, "too_late");
      assert.ok(retired.bot.operationCalls.has(active.id), "committed but undelivered actions keep their original ownership");
      await retired.bot.stop(); finish.resolve(); await pending; await retired.bot.scheduler.whenIdle(); await retired.bot.receipts.settled();
      assert.equal(retired.bot.operationCalls.has(active.id), false);
      const restoredContext = new BotContext(retired.files); await restoredContext.load();
      const restoredLedger = new GrowthLedger(retired.files.base), recovered: BotEvent[] = [];
      await new ReceiptInbox(retired.files.base).drain(async event => {
        recovered.push(event); await restoredContext.appendEvent(event); await restoredLedger.perceive(event);
      });
      assert.equal(recovered.length, 3);
      assert.deepEqual(recovered.map(item => item.source), ["world", "tool", "world"], "one durable envelope retains before/action/after order across restart");
      assert.deepEqual(recovered.map(item => item.originEventIds?.[0]), [`before-source-${mode}`, `late-source-${mode}`, `after-source-${mode}`]);
      assert.equal(recovered[1]?.experience?.agency, mode === "avatar" ? "self" : "imposed");
      assert.equal(recovered[1]?.experience?.outcome, "completed");
      assert.equal(recovered[1]?.experience?.opportunity, mode === "avatar");
      assert.equal((await restoredLedger.recallEvidence({ eventIds: [recovered[1]!.id] }))[0]?.experience?.agency, mode === "avatar" ? "self" : "imposed");
      assert.ok(recovered.filter(item => item.source === "world").every(item => item.experience?.agency === "observed" && item.experience.opportunity === false));
      if (mode === "puppet") assert.doesNotMatch(JSON.stringify(recovered), /PRIVATE_CONTROLLER_INTENTION/);
    }
    console.log("PASS growth agency: actual world outcomes, avatar/puppet ownership, hidden-intent privacy, stealth exclusion, conservative app results, episode deduplication, cancellation and durable late receipts");
  } finally {
    for (const fixture of fixtures) { await fixture.bot.stop(); await fixture.bot.controlAuditTail; fixture.world.stop(); }
    await fs.rm(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
