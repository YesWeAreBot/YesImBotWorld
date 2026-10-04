import { worldInputText } from "./world-input-fixture.js";
/** Deterministic local clocks and fake inference only; never touches a running world. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorldClock } from "../src/clock.js";
import { formatWorldTime, parseCalendarSpec, parseGregorianEpoch, type CustomCalendar } from "../src/calendar.js";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { WorldAgent } from "../src/world/agent.js";
import { Prompts } from "../src/prompts.js";
import { currentTimeConflicts, projectCurrentTime, WORLD_TIME_AUTHORITY } from "../src/world/time-boundary.js";
import type { ClockConfigData } from "../src/config.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";

const directories: string[] = [];
const logger = { info() {}, warn() {}, error() {} } as any;
const config = (syncRealTime: boolean, epoch = "2012-03-04 05:06"): ClockConfigData => ({ syncRealTime, epoch, realSecondsPerUnit: 2, worldSecondsPerUnit: 60, tingleEveryUnits: 30, tingleMode: "fixed", tingleMinUnits: 1, tingleMaxUnits: 100 } as ClockConfigData);
const custom: CustomCalendar = { kind: "custom", era: "星历", units: [{ name: "年", count: 10, start: 1 }, { name: "月", count: 20, start: 1 }, { name: "日", count: 24, start: 1 }, { name: "时", count: 60, pad: 2 }, { name: "分", count: 60, pad: 2 }], epoch: [112, 3, 5, 6, 0], format: "{era}{年}年{月}月{日}日 {时}:{分}" };
const response = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "local", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const inputOf = (messages: ChatMessage[]) => {
  const task = messages.filter(message => message.role === "user").map(message => JSON.parse(String(message.content)))
    .find(value => typeof value.kind === "string" && (Object.hasOwn(value, "worldState") || Object.hasOwn(value, "worldDocument")));
  assert.ok(task, "read the original world task rather than a later validation diagnostic");
  return task;
};
const initial = (date = "2026-09-19") => ({ botName: "小澈", worldState: `当前日期：${date}。房间安静。历史：2010年5月1日建成。`, actorStates: [{ actorId: "bot", state: "你站在窗边。" }], perceptions: [{ actorId: "bot", text: "阳光落在窗台。" }] });
async function filesAndClock(sync = true, realWorld = true, epoch?: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "world-time-")); directories.push(directory);
  const files = new WorldFiles(directory); await files.ensure(); await files.writeMeta({ realWorld });
  await files.atomicWrite(files.botDef, "小澈，喜欢看书。"); await files.atomicWrite(files.worldDef, "这是一间房间。历史上的2010年5月1日落成。");
  const clock = new WorldClock(config(sync, epoch), files.clock); await clock.load();
  return { files, clock };
}

async function main(): Promise<void> {
  const originalNow = Date.now, originalTZ = process.env.TZ;
  let wall = Date.parse("2026-09-19T04:00:00Z");
  Date.now = () => wall; process.env.TZ = "Asia/Shanghai";
  try {
    assert.equal(parseGregorianEpoch("2026-02-30 12:00"), null);
    assert.equal(parseCalendarSpec({ kind: "gregorian", epoch: "2026-02-30" }), null);
    assert.match(formatWorldTime({ kind: "gregorian", epoch: "王历某年" }, 0), /历法未就绪/);
    const sync = await filesAndClock(true, false);
    assert.equal(sync.clock.authority().date, "2026-09-19"); assert.equal(sync.clock.authority().formatted, "2026-09-19 12:00");
    assert.equal(sync.clock.authority().utcOffset, "+08:00"); assert.equal(sync.clock.authority().timeZone, "Asia/Shanghai");
    assert.equal(sync.clock.authority().source, "wall_clock"); assert.equal(sync.clock.authority().unitWorldSeconds, 1);
    const historical = await filesAndClock(false, true);
    assert.equal(historical.clock.authority().date, "2012-03-04"); assert.equal(historical.clock.authority().source, "world_calendar");
    await historical.clock.advance(60); assert.equal(historical.clock.authority().formatted, "2012-03-04 06:06");
    await historical.clock.setCalendar(custom); assert.equal(historical.clock.authority().calendarKind, "custom");
    assert.equal(historical.clock.authority().formatted, "星历112年3月5日 07:00"); assert.equal(historical.clock.authority().date, undefined);
    const reloaded = new WorldClock(config(false), historical.files.clock); await reloaded.load(); assert.deepEqual(reloaded.authority(), historical.clock.authority());

    const now = sync.clock.authority();
    for (const text of ["当前日期：2018-01-02", "现在是2018年1月2日。", "# 时间：2018-01-02 20:30", "今天是星期一。", "时间：2024年，深夜", "当前年份：2024", "现在是2024年。"]) assert.ok(currentTimeConflicts(text, now).length, text);
    for (const text of ["当前日期：2026-09-19", "2018年1月2日发生过一场大雪。", "历史日期：2018-01-02", "他回忆当时今天是2018年1月2日。", "如果今天是2018-01-02，我们就会相遇。", "日记写着：“今天是2018年1月2日。”", "`当前日期：2018-01-02`", "> 当前日期：2018-01-02", "## 历史事件\n时间：2010年，深夜", "如果现在是2024年，这栋楼还不存在。", "计划时间：2024年", "书名是《今天是2024年》"]) assert.equal(currentTimeConflicts(text, now).length, 0, text);
    assert.equal(projectCurrentTime("她说：“今天是2018-01-02。”", now), "她说：“今天是2018-01-02。”");
    assert.equal(currentTimeConflicts("今天是2018-01-02。", now, "今天是2018-01-02。").length, 0);

    // Initialization, including all three mutable surfaces, must reject a fabricated today.
    for (const field of ["worldState", "actorStates", "perceptions"] as const) {
      const f = await filesAndClock(); let calls = 0;
      const runtime = new NarrativeWorld(f.files, f.clock, async () => {
        calls++; const value = initial();
        if (field === "worldState") value.worldState = "当前日期：2018-01-02。房间安静。";
        else if (field === "actorStates") value.actorStates[0]!.state = "现在是2018年1月2日，你站在窗边。";
        else value.perceptions[0]!.text = "今天是2018年1月2日。";
        return response(value);
      });
      await assert.rejects(runtime.ensure(), /WORLD_TIME_CONFLICT/); assert.equal(calls, 3); assert.equal((await runtime.store()).snapshot().sequence, 0);
      await runtime.shutdown();
    }

    const f = await filesAndClock(); let handler: (messages: ChatMessage[]) => Promise<ChatResult>;
    const kinds: string[] = [];
    handler = async messages => {
      const input = inputOf(messages); kinds.push(input.kind);
      assert.equal(Object.hasOwn(input, "time"), false); assert.equal(Object.hasOwn(input, "timeLine"), false);
      assert.equal(input.timeAuthority.date, "2026-09-19"); assert.equal(input.timeAuthority.utcOffset, "+08:00");
      assert.match(messages[0]!.content as string, /程序时间边界/); assert.ok((messages[0]!.content as string).includes(WORLD_TIME_AUTHORITY));
      if (input.kind === "initialize") return response(initial());
      return response({ perceptions: input.kind === "evolve" || input.kind === "leave" ? [] : [{ actorId: input.actorId, text: "窗外传来鸟鸣。" }], ...(input.kind === "action" ? { outcome: { status: "completed" } } : {}) });
    };
    const runtime = new NarrativeWorld(f.files, f.clock, messages => handler(messages), new Prompts({ world: { narrativeSystem: "自定义角色环境提示" } } as any));
    await runtime.ensure(); await runtime.observe();
    await runtime.act("bot", { id: "look", name: "act", role: "agent", arguments: { description: "望向窗外" }, issuedAt: f.clock.now(), expectedAt: f.clock.now() }, () => {});
    wall += 90_000; await runtime.evolve("片刻过去。"); await runtime.arrive("visitor", "来客", "谨慎的旅人。"); await runtime.leave("visitor");
    assert.deepEqual(kinds, ["initialize", "observe", "action", "evolve", "arrive", "leave"]);
    const store = await runtime.store(), original = store.snapshot();
    for (const field of ["worldState", "actorStates", "perceptions"] as const) {
      handler = async () => response({ perceptions: field === "perceptions" ? [{ actorId: "bot", text: "现在是2018年1月2日。" }] : [], ...(field === "worldState" ? { worldState: "当前日期：2018-01-02" } : {}), ...(field === "actorStates" ? { actorStates: [{ actorId: "bot", state: "当前日期：2018-01-02" }] } : {}) });
      await assert.rejects(runtime.evolve("自然经过片刻。"), /WORLD_TIME_CONFLICT/); assert.deepEqual(store.snapshot(), original);
    }
    await store.commit({ idempotencyKey: "old-wrong-date", source: "migration", worldState: "当前日期：2018-01-02。房间安静。\n历史：2010年5月1日落成。", actors: { bot: { ...original.actors.bot!, state: "当前日期：2018-01-02。你站在窗边。" } }, perceptions: [{ actorId: "bot", text: "今天是2018-01-02。你站在窗边。" }] });
    const journal = await fs.readFile(f.files.narrativeJournal, "utf8");
    handler = async messages => {
      const input = inputOf(messages); assert.doesNotMatch(worldInputText(input), /2018-01-02/); assert.match(worldInputText(input), /2010年5月1日/);
      assert.doesNotMatch(JSON.stringify(input.actors), /2018-01-02/); assert.equal(input.stateAsOf.date, "2026-09-19");
      assert.ok(input.elapsedWorldSeconds >= 0); return response({ perceptions: [] });
    };
    await runtime.evolve("平静片刻。"); assert.equal(await fs.readFile(f.files.narrativeJournal, "utf8"), journal);
    assert.doesNotMatch((await runtime.peek()).narrative, /2018-01-02/);
    await runtime.shutdown();

    // Inference may finish on the next date; the model must not be punished for using
    // its provided sample. The next request receives the new date and no stale 'today'.
    wall = Date.parse("2026-09-19T15:59:30Z");
    const midnight = await filesAndClock(); let midnightCalls = 0;
    const midnightRuntime = new NarrativeWorld(midnight.files, midnight.clock, async messages => {
      midnightCalls++; const input = inputOf(messages);
      if (input.kind === "initialize") {
        assert.equal(input.timeAuthority.date, "2026-09-19"); wall += 90_000;
        return response(initial("2026-09-19"));
      }
      assert.equal(input.timeAuthority.date, "2026-09-20"); assert.doesNotMatch(worldInputText(input), /当前日期：2026-09-19/);
      assert.match(worldInputText(input), /2010年5月1日/); return response({ perceptions: [] });
    });
    await midnightRuntime.ensure(); assert.equal(midnightCalls, 1, "crossing midnight does not trigger a false invalid-generation retry");
    await midnightRuntime.evolve("继续经过片刻。"); assert.equal(midnightCalls, 2); await midnightRuntime.shutdown();

    // Calendar setup precedes the stateless initialization input and cannot overwrite a
    // configured Gregorian anchor. Custom epochs never silently become the default 2026.
    for (const variant of ["gregorian", "custom", "invalid"] as const) {
      const epoch = variant === "gregorian" ? "2012-03-04 05:06" : "星历112年3月5日 清晨六时";
      const box = await filesAndClock(false, variant === "gregorian", epoch);
      const world = new WorldAgent({ baseURL: `http://fixture-${randomUUID()}.invalid`, model: "fixture", compressMaxInputChars: 1000 } as any, box.files, box.clock, logger, new Prompts(), { resolution: "320x640", generateShell: false });
      const order: string[] = [];
      (world as any).client = { complete: async (messages: ChatMessage[], options: any = {}) => {
        if (options.responseSchema || options.tools?.length) {
          order.push("initialize"); const input = inputOf(messages);
          assert.equal(input.timeAuthority.formatted, variant === "gregorian" ? "2012-03-04 05:06" : "星历112年3月5日 06:00");
          return response({ ...initial(variant === "gregorian" ? "2012-03-04" : "2026-09-19"), worldState: "这间房间十分安静。" });
        }
        const calendar = (messages[0]!.content as string).includes("历法"); order.push(calendar ? "calendar" : "meta");
        return { content: JSON.stringify(calendar ? variant === "gregorian" ? { kind: "gregorian", epoch: "2040-08-09 11:12" } : variant === "custom" ? custom : { bad: true } : { real_world: variant === "gregorian" }), toolCalls: [] };
      } };
      if (variant === "invalid") { await assert.rejects(world.initialize("小澈", "使用星历的虚构世界。"), /不会用默认公历日期/); assert.deepEqual(order, ["meta", "calendar"]); }
      else { await world.initialize("小澈", variant === "custom" ? "使用星历的虚构世界。" : "现实地理，独立历史时间线。"); assert.deepEqual(order, ["meta", "calendar", "initialize"]); }
      await world.runtime.shutdown();
    }
    console.log("PASS authoritative World time: actual clock/zone, independent epochs, custom calendars, all request kinds, date conflict rejection, preserved history/quotes, old-state projection and initialization order");
  } finally {
    Date.now = originalNow; if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    await Promise.all(directories.map(dir => fs.rm(dir, { recursive: true, force: true })));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
