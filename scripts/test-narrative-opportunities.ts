import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { worldResolutionTool } from "../src/world/proposal.js";
import { WORLD_PROMPT_DEFAULTS } from "../src/prompts.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { NarrativeObservation, NarrativeOpportunity } from "../src/world/narrative-types.js";
import type { ToolCallRecord } from "../src/types.js";

const response = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "scene", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-opportunities-")), files = new WorldFiles(base); await files.ensure();
  await files.writeMeta({ realWorld: false });
  let calls = 0, now = 10;
  const clock = { now: () => now, realMsUntil: () => 0, authority: (tu: number) => ({ tu, source: "world_calendar", date: "2026-09-21", formatted: "2026-09-21", timeLine: "2026-09-21", timeZone: "Asia/Shanghai", calendarKind: "gregorian", utcOffset: "+08:00", unitRealSeconds: 1, unitWorldSeconds: 1 }) } as any;
  let handler: (request: any) => ChatResult = () => { throw Error("Unexpected model call"); };
  const runtime = new NarrativeWorld(files, clock, async (messages: ChatMessage[]) => {
    calls++; return handler(JSON.parse([...messages].reverse().find(message => message.role === "user")!.content as string));
  });
  let reopened: NarrativeWorld | undefined;
  try {
    const store = await runtime.store();
    await store.commit({ idempotencyKey: "old-record", source: "fixture", initialized: true,
      worldState: "小澈在院子里。PRIVATE_WORLD_SECRET：地下室藏有地图。另一个房间的访客独自保管钥匙。",
      actors: {
        bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在院子里。", perception: "院门外传来脚步声。" },
        "visitor:a": { id: "visitor:a", name: "旅人", controller: "player", present: true, state: "独自在房间里。", perception: "钥匙在你的手里。" },
      }, perceptions: [{ actorId: "bot", text: "院门外传来脚步声。" }] });
    const oldLine = (await fs.readFile(files.narrativeJournal, "utf8")).trim();
    const opportunities: NarrativeOpportunity[] = [
      { label: "看看告示", intent: "看看门边告示牌写着什么" },
      { label: "出门问路", intent: "走到街边，尝试向路过的人问路", exclusiveGroup: "去留" },
      { label: "留在院子", intent: "回院子整理花盆", exclusiveGroup: "去留" },
    ];
    handler = request => {
      assert.equal(request.kind, "action");
      return response({ worldState: request.worldState, perceptions: [
        { actorId: "bot", text: "你走到院门边，看见门旁立着一块告示牌。", situation: "你在院门内，右手空着，告示牌就在面前。", opportunities },
        { actorId: "visitor:a", text: "隔壁传来院门轻响。", situation: "你独自在房间，钥匙仍握在手里。", opportunities: [{ label: "收好钥匙", intent: "把手里的钥匙收进口袋" }] },
      ], outcome: { status: "completed" } });
    };
    const call: ToolCallRecord = { id: "door", role: "agent", name: "act", arguments: { description: "走到院门边" }, issuedAt: now, expectedAt: now };
    let receipt: { observation: NarrativeObservation; scene: NarrativeObservation["scene"] } | undefined;
    assert.equal(await runtime.act("bot", call, text => { receipt = JSON.parse(text); }), true);
    assert.equal(calls, 1, "suggestions do not cause follow-up inference or execute themselves");
    const view = receipt!.observation;
    assert.deepEqual(view.opportunities, opportunities); assert.deepEqual(view.scene!.opportunities, opportunities);
    assert.deepEqual(receipt!.scene!.opportunities, opportunities);
    assert.equal(view.situation, view.scene!.situation);
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE_WORLD_SECRET|地图|钥匙|旅人/);
    assert.doesNotMatch(view.narrative, /问路|整理花盆/, "possible next steps are never appended to factual narrative");
    assert.equal(store.snapshot().actors.bot!.perception, view.narrative);
    assert.doesNotMatch(store.snapshot().worldState, /问路|整理花盆/);
    assert.equal(Object.keys(store.snapshot().actions).length, 1);
    assert.deepEqual((await runtime.peek()).opportunities, opportunities);
    assert.ok((await runtime.perceptionsSince("bot")).every(item => item.actorId === "bot" && !JSON.stringify(item).includes("钥匙")));
    assert.match(JSON.stringify((await runtime.peek("visitor:a")).opportunities), /钥匙/);
    const event = store.readEvents().find(event => event.topic === "world.perception" && event.actorId === "bot" && (event.payload as any).opportunities);
    assert.deepEqual((event!.payload as any).opportunities, opportunities);
    await runtime.shutdown();
    reopened = new NarrativeWorld(files, clock, async () => { throw Error("replay must not infer"); });
    assert.deepEqual(await reopened.peek(), view);
    const replayed = await reopened.store();
    assert.deepEqual(replayed.findCommit("bot:door:commit")!.perceptions.find(item => item.actorId === "bot")!.opportunities, opportunities);
    assert.equal((await fs.readFile(files.narrativeJournal, "utf8")).split("\n")[0], oldLine, "adding optional presentation fields never rewrites old checksums");
    assert.equal(replayed.readPerceptions("bot")[0]!.opportunities, undefined, "old records keep absent fields absent");
    console.log("PASS per-actor scene/status/options are stored and replayed separately from facts, without auto-actions or old journal rewrites");

    runtime.resume();
    const beforeView = await runtime.peek();
    handler = request => response({ perceptions: [{ actorId: "bot", text: beforeView.narrative, situation: "你仍在院门内，告示牌就在身旁。", opportunities: [] }] });
    const update = await runtime.observe("bot", { intent: "看看门边" });
    assert.deepEqual(update.opportunities, [], "unchanged prose can still replace old suggestions with an empty set");
    assert.notEqual(update.observationId, beforeView.observationId);
    assert.equal(store.snapshot().actors.bot!.perception, beforeView.narrative);

    // Quiet periods are legitimate single-pass results, not missing-choices errors.
    for (const extra of [{ externalChanges: [] }, {}]) {
      const count = calls, quietBefore = store.snapshot();
      handler = () => response({ perceptions: [], ...extra });
      await runtime.evolve("平静经过片刻。");
      assert.equal(calls, count + 1, "a quiet heartbeat does not trigger another generation to fill choice slots");
      assert.deepEqual(store.snapshot(), quietBefore, "no external change means no new body state or repeated perception");
      const quiet = await runtime.peek();
      assert.deepEqual(quiet.opportunities ?? [], []);
      assert.doesNotMatch(quiet.narrative, /叫醒|敲门|突发/);
    }

    async function rejected(extra: Record<string, unknown>, pattern: RegExp) {
      const prior = store.snapshot(), count = calls;
      handler = () => response({ perceptions: [{ actorId: "bot", text: "院门边一切如旧。", ...extra }] });
      await assert.rejects(runtime.observe("bot", { intent: "看看门边" }), pattern);
      assert.equal(calls, count + 3); assert.deepEqual(store.snapshot(), prior, "invalid auxiliary text cannot be partially committed");
    }
    await rejected({ situation: "手机刚收到一条新消息。" }, /WORLD_DEVICE_BOUNDARY/);
    await rejected({ opportunities: [{ label: "读通知", intent: "查看手机的通知" }] }, /WORLD_DEVICE_BOUNDARY/);
    await rejected({ opportunities: [{ label: "去问问", intent: "回复群聊里刚刚发来的消息" }] }, /WORLD_DEVICE_BOUNDARY/);
    await rejected({ opportunities: [{ label: "查看天气", intent: "打开浏览器查询实时天气" }] }, /WORLD_DEVICE_BOUNDARY/);
    const phoneAlarm = "伸手摸一下床头柜上的手机确认明早六点五十的闹钟已设好";
    for (const field of ["label", "intent", "exclusiveGroup"] as const) {
      for (const unsafe of ["拿起床头柜上的手机，随便刷点什么", phoneAlarm])
        await rejected({ opportunities: [{ label: "在屋里活动", intent: "走到窗边", [field]: unsafe }] }, /WORLD_DEVICE_BOUNDARY/);
    }
    await rejected({ opportunities: [{ label: "随便刷点什么", intent: "拿起床头柜上的手机" }] }, /WORLD_DEVICE_BOUNDARY/);
    await rejected({ opportunities: [{ label: "睡前再确认一次闹钟", intent: phoneAlarm }] }, /WORLD_DEVICE_BOUNDARY/);
    await rejected({ opportunities: [{ label: "确认明早六点五十的闹钟已设好", intent: "伸手摸一下床头柜上的手机" }] }, /WORLD_DEVICE_BOUNDARY/);
    await rejected({ situation: "你摸了一下手机，确认明早六点五十的闹钟已设好。" }, /WORLD_DEVICE_BOUNDARY/);
    await rejected({ situation: "你握着手机，拇指在屏幕上划了六七分钟。" }, /WORLD_DEVICE_BOUNDARY/);
    await rejected({ situation: "当前日期：2001-01-01。" }, /WORLD_TIME_CONFLICT/);
    await rejected({ opportunities: [{ label: "看看周围", intent: "今天是2001-01-01，出去散步" }] }, /WORLD_TIME_CONFLICT/);
    await rejected({ opportunities: Array.from({ length: 5 }, () => ({ label: "看门", intent: "看看院门" })) }, /最多4项/);
    await rejected({ opportunities: [{ label: "看门", intent: "看看院门", completed: true }] }, /最多4项/);
    const physicalClock = [{ label: "检查机械闹钟", intent: "放下手机，检查床头独立的机械闹钟是否已设好" }];
    handler = () => response({ perceptions: [{ actorId: "bot", text: "床头放着一只机械闹钟。", opportunities: physicalClock }] });
    const physicalView = await runtime.observe("bot", { intent: "看看房间" });
    assert.deepEqual(physicalView.opportunities, physicalClock, "a separate physical clock is not a phone application");

    // Persisted legacy options receive the same read-only boundary projection.
    await store.commit({ idempotencyKey: "legacy-alarm-option", source: "migration", perceptions: [{ actorId: "bot", text: "手机放在床头柜上。",
      opportunities: [{ label: "睡前再确认一次闹钟", intent: phoneAlarm }, ...physicalClock] }] });
    const oldAlarmJournal = await fs.readFile(files.narrativeJournal, "utf8");
    assert.deepEqual((await runtime.peek()).opportunities, physicalClock);
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), oldAlarmJournal, "legacy options are filtered without rewriting historical facts");
    console.log("PASS state bars and all suggestion text enforce device/time/schema boundaries while ordinary physical observation options remain valid");

    for (const kind of ["app_observe", "app_action"] as const) for (const extra of [{ situation: "站在桌边。" }, { opportunities: [] }]) {
      handler = request => response({ ...(kind === "app_action" ? { worldState: request.worldState, outcome: { status: "completed" } } : {}), perceptions: [{ actorId: "bot", text: "文件没有新内容。", ...extra }] });
      await assert.rejects(kind === "app_observe" ? runtime.observeVirtualApp("bot", "读取文件 note.txt") : runtime.executeVirtualApp("bot", "文件操作：保存 note.txt"), /应用回执不能填写/);
    }
    handler = () => response({ perceptions: [{ actorId: "absent", text: "我看见院门。", situation: "院门内。", opportunities }] });
    await assert.rejects(runtime.evolve("一阵微风。"), /在场角色/);
    assert.throws(() => store.commit({ idempotencyKey: "bad-direct", source: "fixture", perceptions: [{ actorId: "bot", text: "门边安静。", opportunities: [{ label: "", intent: "看看院门" }] }] }), /有效文本/);
    assert.throws(() => store.commit({ idempotencyKey: "bad-receipt", source: "app_action", toolReceipt: { actorId: "bot", text: "已保存。", status: "completed", opportunities: [] } as any }), /不能附加/);
    const schema = worldResolutionTool().function.parameters as any;
    const choiceSchema = schema.properties.perceptions.items.properties.opportunities;
    assert.equal(choiceSchema.maxItems, 4);
    assert.equal(choiceSchema.minItems, undefined, "the schema does not force quiet scenes to invent choices");
    assert.ok(!schema.properties.perceptions.items.required.includes("opportunities"));
    for (const guidance of [WORLD_PROMPT_DEFAULTS.narrativeSystem, choiceSchema.description]) {
      assert.match(guidance, /有选择可做.*2至4/);
      assert.match(guidance, /喝水.*休息.*收拾/);
      assert.match(guidance, /不强迫.*(?:探索|冒险)/);
      assert.match(guidance, /同义选项凑数/);
      assert.match(guidance, /真实睡眠.*安静等待.*(?:省略|空数组)/);
      assert.match(guidance, /(?:制造人物|制造新?事件)/);
      assert.match(guidance, /手机.*闹钟.*(?:软件|工具)/);
    }
    assert.equal(schema.properties.perceptions.items.properties.situation.maxLength, 1200);
    console.log("PASS app reads/writes cannot emit scene guidance; actor visibility and direct journal admission remain validated");
  } finally { await runtime.shutdown(); await reopened?.shutdown(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
