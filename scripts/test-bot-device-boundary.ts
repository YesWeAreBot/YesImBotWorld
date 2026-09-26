/** Actual Bot dispatch/scheduler/context with an in-memory World stub; no platform or model is contacted. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { WORLD_PERCEPTION_SCOPE } from "../src/prompts.js";
import type { BotEvent, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const observation = (id: string, text: string) => ({ mode: "narrative", observationId: id, actorId: "bot", worldSequence: 1,
  observedAt: 100, sourceEventIds: [id], entities: [], utterances: [], narrative: text });

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "bot-device-boundary-"));
  let bot: any;
  try {
    const files = new WorldFiles(base); await files.ensure(); await files.atomicWrite(files.botDef, "小澈，住在一间普通的房间。");
    // This already committed provider prefix represents history written by the previous renderer.
    const old: BotEvent = { id: "legacy-world", source: "world", worldTime: 90, originEventIds: ["legacy-cause"],
      content: JSON.stringify(observation("legacy-cause", "窗边放着一张椅子。")) };
    await fs.appendFile(files.stream, JSON.stringify({ kind: "event", event: old }) + "\n");
    const context = new BotContext(files); await context.load(); const prefix = await context.toChatMessages("T100");
    const cfg = Config({ autoStart: false }); cfg.bot.growth.enabled = false;
    cfg.bot.repeatThresholds = [100, 200, 300]; cfg.bot.spillMinChars = 0; cfg.bot.breakLoop = false;
    const clock: any = { now: () => 100, timeLine: () => "T100", unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: () => 0, syncRealTime: false };
    const calls: { kind: "act" | "observe"; input: unknown }[] = [];
    const world: any = {
      async adjudicateAct(call: ToolCallRecord, deliver: (content: string) => void, _signal: AbortSignal, beginCommit: () => boolean) {
        calls.push({ kind: "act", input: call }); assert.ok(beginCommit());
        const text = String(call.arguments.description).includes("纸信") ? "纸信上的字迹清晰，落款是一朵手绘的小花。" : call.arguments.speech ? `你当面对店员说：“${call.arguments.speech}”店员停下手中的工作，朝你点头。` : "你拿起桌上的手机，机身有一点凉。";
        deliver(JSON.stringify({ action: { id: "bot:" + call.id, intent: call.arguments.description, status: "completed" }, observation: observation("physical:" + call.id, text) }));
        return true;
      },
      async observe(actor: string, input: unknown) { assert.equal(actor, "bot"); calls.push({ kind: "observe", input }); return observation("physical-observe:" + calls.length, "纸信上的字迹清晰，落款是一朵手绘的小花。"); },
    };
    const tools = BOT_TOOLS.filter(tool => ["act"].includes(tool.name));
    bot = new BotAgent(cfg, clock, files, context, world, {} as any, null, null, null, { down: false }, logger, tools);
    bot.running = true; bot.backend = { setToolNames() {}, setToolDefs() {} }; bot.refreshToolGate();
    async function dispatch(name: string, args: Record<string, unknown>) {
      const call: ToolCallRecord = { id: context.nextToolId(), role: "agent", name, arguments: args, issuedAt: 100, expectedAt: 100 };
      await context.appendToolCall(call); await bot.dispatch(call); await bot.scheduler.whenIdle(); await bot.drainMailbox();
      const results = context.stream.flatMap(entry => entry.kind === "event" && entry.event.refToolCallId === call.id ? [entry.event] : []);
      assert.ok(results.length, `an actual receipt must explain ${name}`);
      return { call, results, result: results.at(-1)! };
    }
    for (const [name, args] of [
      ["act", { description: "拿起手机，查看Touch Night发来的消息", target: "手机" }],
      ["act", { description: "查看Touch Night发来的私信", target: "手机" }],
      ["act", { description: "给Touch Night发一条消息，问他在不在" }],
      ["act", { description: "查看QQ聊天记录", target: "QQ聊天记录" }],
      ["act", { description: "阅读QQ聊天记录" }],
      ["act", { description: "拿起床头柜上的手机，随便刷点什么" }],
      ["act", { description: "玩一会儿手机" }],
      ["act", { description: "翻翻消息" }],
      ["act", { description: "随便刷点什么", target: "手机" }],
      ["act", { description: "伸手摸一下床头柜上的手机确认明早六点五十的闹钟已设好" }],
      ["act", { description: "确认明早六点五十的闹钟已设好", target: "手机" }],
    ] as const) {
      const before = calls.length, denied = await dispatch(name, args);
      assert.equal(calls.length, before, `${name} must reject explicit device I/O before invoking World`);
      assert.match(denied.result.content, /专用|read_channel|select_channel|open_app|observe_device/);
      assert.match(denied.result.content, /未提交|未执行|执行失败|不能|拒绝/);
      for (const result of denied.results) {
        assert.notEqual(result.experience?.outcome, "completed", "a denied request never becomes an autonomous completed choice");
        assert.notEqual(result.experience?.opportunity, true);
        assert.doesNotMatch(result.contextText ?? result.content, /行动结果：已完成|动作已完成/);
      }
      const evidence = await bot.growth.recallEvidence({ eventIds: denied.results.map(result => result.id), n: 50 });
      assert.ok(evidence.every((item: any) => item.experience?.outcome !== "completed"), "failed I/O cannot become completed growth evidence");
    }
    const physical = await dispatch("act", { description: "拿起手机", target: "手机" });
    assert.equal(calls.length, 1); assert.equal(physical.result.experience?.outcome, "completed");
    assert.match(physical.result.contextText ?? "", /机身有一点凉/);
    assert.ok(physical.result.contextText?.includes(WORLD_PERCEPTION_SCOPE), "the actual action receipt identifies its physical-world authority");
    assert.equal(physical.result.contextText!.split(WORLD_PERCEPTION_SCOPE).length - 1, 1);
    const conversation = await dispatch("act", { description: "当面向店员点一碗面", speech: "请给我一碗面，谢谢。" });
    assert.equal(calls.length, 2); assert.equal(conversation.result.experience?.outcome, "completed");
    assert.match(conversation.result.contextText ?? "", /请给我一碗面，谢谢/);
    const paper = await dispatch("act", { description: "查看纸信上的文字", target: "纸信" });
    assert.equal(calls.length, 3); assert.equal(calls[2]!.kind, "act"); assert.match(paper.result.contextText ?? "", /纸信/);
    assert.ok(paper.result.contextText?.includes(WORLD_PERCEPTION_SCOPE), "an active physical observation carries the same domain boundary");
    const retired = await dispatch("observe", { intent: "查看纸信上的文字" });
    assert.equal(calls.length, 3, "the retired public observer never invokes World");
    assert.match(retired.result.content, /observe.*此刻不可用/);
    assert.ok(!BOT_TOOLS.some(tool => tool.name === "observe"));
    assert.deepEqual((await context.toChatMessages("T101")).slice(0, prefix.length), prefix, "boundary failures and new world projections only append to the provider history");
    const replay = new BotContext(files); await replay.load();
    assert.deepEqual(await replay.toChatMessages("T999"), await context.toChatMessages("T101"), "reload keeps the same frozen provider rendering");
    const oldReloaded = replay.stream.find(entry => entry.kind === "event" && entry.event.id === old.id);
    assert.ok(oldReloaded?.kind === "event"); assert.equal(oldReloaded.event.contextText, undefined);
    assert.equal(oldReloaded.event.content, old.content, "the new domain label does not rewrite historical events");
    console.log("PASS Bot device boundary: World-free rejection, truthful failure receipts, physical phone and face-to-face actions, paper observation, growth provenance and immutable context/restart");
  } finally { if (bot) await bot.stop(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
