import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClockApp, type ClockNotice } from "../src/apps/clock.js";
import { WorldClock } from "../src/clock.js";
import type { ClockConfigData } from "../src/config.js";

const logger = { warn() {} };
const directories: string[] = [];
const apps: ClockApp[] = [];
const clocks: WorldClock[] = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("clock operation did not settle")), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(overrides: Partial<ClockConfigData> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-clock-app-")); directories.push(directory);
  const clock = new WorldClock({ syncRealTime: false, epoch: "2026-01-01 23:59:30", realSecondsPerUnit: 2, worldSecondsPerUnit: 60, ...overrides } as ClockConfigData, path.join(directory, "clock.json"));
  clocks.push(clock); await clock.load();
  const file = path.join(directory, "phone-clock.json"), notices: ClockNotice[] = [];
  const read = async () => JSON.parse(await fs.readFile(file, "utf8"));
  let notify = async (notice: ClockNotice) => {
    const stored = (await read()).reminders.find((row: any) => `phone-clock:${row.id}` === notice.id);
    assert.equal(stored.status, "fired"); assert.equal(stored.delivered, true, "delivery is marked before callback, not after");
    notices.push(notice);
  };
  const create = () => {
    const app = new ClockApp({ file, clock, logger, notify: notice => notify(notice) });
    apps.push(app); return app;
  };
  const app = create(); await app.start();
  return { app, clock, file, notices, read, create, setNotify(callback: typeof notify) { notify = callback; } };
}

async function remindersAndRestart() {
  const f = await fixture();
  const opened = await f.app.open();
  assert.deepEqual(opened.tools.map(tool => tool.name), ["read_clock", "set_timer", "set_alarm", "list_reminders", "cancel_reminder", "snooze_reminder", "stopwatch"]);
  await f.app.call("set_timer", { duration_seconds: 120, label: "检查面团" });
  const first = (await f.read()).reminders[0];
  assert.equal(first.dueTU, 2, "world seconds must be divided by world seconds/TU, not treated as TU");
  const beforeView = await fs.readFile(f.file, "utf8"), view = f.app.viewState();
  assert.equal(view.secondsPerTU, 60); assert.equal(view.reminders[0]!.dueTU, 2);
  assert.equal(view.calendarKind, "gregorian"); assert.match(view.alarmHint, /00:00—23:59/);
  assert.deepEqual(view.durationUnits, [{ name: "世界秒", seconds: 1 }, { name: "分钟", seconds: 60 }, { name: "小时", seconds: 3600 }, { name: "日（24小时）", seconds: 86400 }]);
  view.reminders[0]!.label = "不得修改设备状态"; view.stopwatch.laps.push(10);
  assert.equal(f.app.viewState().reminders[0]!.label, "检查面团"); assert.deepEqual(f.app.viewState().stopwatch.laps, []);
  assert.equal(await fs.readFile(f.file, "utf8"), beforeView);
  await f.app.close();
  await assert.rejects(f.app.call("read_clock", {}), /已关闭/);
  await f.clock.advance(1.5); await f.app.refresh();
  assert.equal(f.notices.length, 0);
  await f.clock.advance(.5); await f.app.refresh();
  assert.equal(f.notices.length, 1, "background reminders remain active when screen is closed");
  assert.equal(f.notices[0]!.label, "检查面团");
  assert.doesNotMatch(f.notices[0]!.text, /睡醒|睡着|震我|发来消息/);
  await f.app.dispose();
  const restored = f.create(); await restored.start(); await restored.refresh();
  assert.equal(f.notices.length, 1, "successfully attempted reminders must not repeat after restart");
  await restored.call("snooze_reminder", { id: first.id, duration_seconds: 30 });
  const snoozed = (await f.read()).reminders[1];
  assert.notEqual(snoozed.id, first.id); assert.equal(snoozed.dueTU, 2.5);
  await f.clock.advance(.5); await restored.refresh();
  assert.equal(f.notices.length, 2); assert.notEqual(f.notices[0]!.id, f.notices[1]!.id);
  await restored.call("set_timer", { duration_seconds: 60, label: "取消这条" });
  const cancel = (await f.read()).reminders[2];
  await restored.call("cancel_reminder", { id: cancel.id });
  await f.clock.advance(2); await restored.refresh();
  assert.equal(f.notices.length, 2);
  assert.doesNotMatch(await restored.call("list_reminders", { include_finished: false }), /取消这条/);
  for (const duration of [0, -1, NaN, Infinity, "60"]) await assert.rejects(restored.call("set_timer", { duration_seconds: duration }), /duration_seconds/);
}

async function calendarAndPause() {
  const f = await fixture();
  await f.app.call("set_alarm", { time: "00:00", label: "午夜" });
  assert.equal((await f.read()).reminders[0].dueTU, .5);
  await f.clock.advance(.5); await f.app.refresh(); assert.equal(f.notices.length, 1);
  await f.app.call("set_alarm", { time: "00:00", label: "明天午夜" });
  assert.equal((await f.read()).reminders[1].dueTU, 1440.5, "an already reached clock minute means the next day");
  await assert.rejects(f.app.call("set_alarm", { time: "24:00" }), /00:00/);
  await assert.rejects(f.app.call("set_alarm", { time: "12:60" }), /00:00/);
  await assert.rejects(f.app.call("set_alarm", { time: "12:00", at_tu: 20 }), /只能/);
  await assert.rejects(f.app.call("set_alarm", { at_tu: .1 }), /未来/);
  await f.clock.setCalendar({ kind: "custom", era: "星历", units: [{ name: "日", count: 20, start: 1 }, { name: "时", count: 60 }, { name: "分", count: 60 }], epoch: [1, 19, 59] });
  await f.app.call("set_alarm", { time: "00:00" });
  assert.equal((await f.read()).reminders[2].dueTU, 1, "a custom 20-hour day must not be treated as Gregorian");
  await assert.rejects(f.app.call("set_alarm", { time: "20:00" }), /20 时/);
  await f.clock.setCalendar({ kind: "custom", units: [{ name: "轮", count: 100 }], epoch: [0] });
  await assert.rejects(f.app.call("set_alarm", { time: "07:30" }), /无歧义/);
  await f.app.call("set_alarm", { at_tu: 3, label: "精确世界时刻" });

  const realNow = Date.now;
  let wall = realNow();
  try {
    Date.now = () => wall;
    await f.clock.resume(); wall += 1000; await f.clock.pause();
    const paused = f.clock.now(); wall += 10_000_000;
    assert.equal(f.clock.now(), paused); await f.app.refresh();
    assert.equal((await f.read()).reminders.find((row: any) => row.label === "精确世界时刻").status, "scheduled");
  } finally { Date.now = realNow; }
  const sync = await fixture({ syncRealTime: true });
  const current = new Date(), time = `${current.getHours().toString().padStart(2, "0")}:${current.getMinutes().toString().padStart(2, "0")}`;
  await sync.app.call("set_alarm", { time });
  const due = (await sync.read()).reminders[0].dueTU;
  assert.ok(due > 23 * 3600 && due <= 25 * 3600, "real-time HH:MM follows the next local-calendar occurrence, not the virtual epoch");
}

async function stopwatchAndFailures() {
  const f = await fixture();
  await f.app.call("stopwatch", { action: "start" });
  await f.clock.advance(2);
  assert.match(await f.app.call("stopwatch", { action: "lap" }), /120\.000/);
  await f.app.call("stopwatch", { action: "pause" });
  await f.clock.advance(10);
  assert.match(await f.app.call("stopwatch", { action: "read" }), /已暂停：120\.000/);
  await f.app.call("stopwatch", { action: "start" }); await f.clock.advance(.5);
  await f.app.dispose();
  const next = f.create(); await next.start();
  assert.match(await next.call("stopwatch", { action: "read" }), /150\.000/);
  await next.call("stopwatch", { action: "reset" });
  assert.match(await next.call("stopwatch", { action: "read" }), /已暂停：0\.000/);
  await assert.rejects(next.call("stopwatch", { action: "lap" }), /尚未运行/);
  await next.call("set_timer", { duration_seconds: 60 });
  let failedID = "";
  f.setNotify(async notice => { failedID = notice.id; throw new Error("fixture recipient unavailable"); });
  await f.clock.advance(1); await next.refresh();
  assert.equal((await f.read()).reminders.at(-1).delivered, false);
  assert.match((await f.read()).reminders.at(-1).deliveryError, /unavailable/);
  await next.dispose();
  f.setNotify(async notice => { assert.equal(notice.id, failedID); f.notices.push(notice); });
  const retry = f.create(); await retry.start(); await retry.refresh();
  assert.equal(f.notices.length, 1, "only an explicit failed callback is retried on recovery");
  assert.equal((await f.read()).reminders.at(-1).delivered, true);
}

async function nonEarthClockFaces() {
  const f = await fixture({ worldSecondsPerUnit: 5 });
  // Ten hours/day, one hundred minutes/hour, one hundred world seconds/minute.
  // Both clock fields start at one, and larger era/day fields are nonzero too.
  await f.clock.setCalendar({ kind: "custom", era: "环历", units: [
    { name: "纪", count: 7 }, { name: "日", count: 10, start: 1 },
    { name: "时", count: 100, start: 1 }, { name: "分", count: 100, start: 1 },
  ], epoch: [3, 4, 10, 100] });
  const customView = f.app.viewState();
  assert.equal(customView.calendarKind, "custom"); assert.match(customView.alarmHint, /无地球时区映射/);
  assert.deepEqual(customView.durationUnits, [{ name: "世界秒", seconds: 1 }, { name: "分", seconds: 100 }, { name: "时", seconds: 10000 }, { name: "日", seconds: 100000 }, { name: "纪", seconds: 700000 }]);
  customView.durationUnits[1]!.seconds = 60;
  assert.equal(f.app.viewState().durationUnits[1]!.seconds, 100, "UI duration choices are detached read-only snapshots");
  assert.match(await f.app.call("read_clock", {}), /时范围 1—10，分范围 1—100/);
  assert.match(await f.app.call("read_clock", {}), /1 日 = 100000 世界秒，1 时 = 10000 世界秒，1 分 = 100 世界秒/);
  await f.app.call("set_alarm", { time: "10:100", label: "下一日同一钟点" });
  await f.app.call("set_alarm", { time: "1:1", label: "下一日开始" });
  assert.equal((await f.read()).reminders[0].dueTU, 20000, "a reached three-digit minute repeats after this calendar's day, not 86400 seconds");
  assert.equal((await f.read()).reminders[1].dueTU, 20);
  assert.match(f.clock.clockString(20), /5日1时1分/, "alarm due time agrees with WorldClock's actual calendar rendering");
  await assert.rejects(f.app.call("set_alarm", { time: "0:1" }), /时范围 1—10/);
  await assert.rejects(f.app.call("set_alarm", { time: "1:101" }), /分范围 1—100/);
  await f.app.call("set_timer", { duration_seconds: 25, label: "底层世界秒计量" });
  await f.app.call("stopwatch", { action: "start" });
  await f.clock.advance(5); await f.app.refresh();
  assert.deepEqual(f.notices.map(item => item.label), ["底层世界秒计量"]);
  assert.equal(f.app.viewState().stopwatch.elapsedSeconds, 25);
  await f.app.dispose();
  const restored = f.create(); await restored.start();
  await f.clock.advance(15); await restored.refresh();
  assert.equal(f.notices.at(-1)!.label, "下一日开始");
  assert.equal(restored.viewState().stopwatch.elapsedSeconds, 100, "stopwatch retains world seconds through a custom-calendar day and restart");

  const seconds = await fixture({ worldSecondsPerUnit: 5 });
  await seconds.clock.setCalendar({ kind: "custom", units: [
    { name: "days", count: 12, start: 1 }, { name: "hours", count: 90 },
    { name: "minutes", count: 80 }, { name: "seconds", count: 3 },
  ], epoch: [2, 11, 89, 79] });
  await seconds.app.call("set_alarm", { time: "0:0" });
  assert.equal((await seconds.read()).reminders[0].dueTU, .6, "a smallest calendar unit named seconds may contain three world seconds");
  await seconds.app.call("set_timer", { duration_seconds: 5 });
  await seconds.app.call("stopwatch", { action: "start" });
  await seconds.clock.advance(.6); await seconds.app.refresh();
  assert.equal(seconds.notices.length, 1); assert.equal(seconds.notices[0]!.kind, "alarm");
  assert.equal(seconds.app.viewState().stopwatch.elapsedSeconds, 3);
  await seconds.clock.advance(.4); await seconds.app.refresh();
  assert.equal(seconds.notices.length, 2); assert.equal(seconds.app.viewState().stopwatch.elapsedSeconds, 5);

  // No Earth fallback for exotic names, negative displayed clock fields, or
  // ambiguous nested "day" aliases. Absolute TU/timers remain independently usable.
  for (const units of [
    [{ name: "轮", count: 9 }, { name: "刻", count: 50 }],
    [{ name: "日", count: 8 }, { name: "时", count: 40, start: -1 }, { name: "分", count: 70 }],
    [{ name: "天", count: 8 }, { name: "日", count: 8 }, { name: "时", count: 40 }, { name: "分", count: 70 }],
  ]) {
    await seconds.clock.setCalendar({ kind: "custom", units, epoch: units.map(unit => unit.start ?? 0) });
    await assert.rejects(seconds.app.call("set_alarm", { time: "07:30" }), /无歧义/);
    assert.match(await seconds.app.call("read_clock", {}), /set_timer 或 at_tu/);
    await seconds.app.call("set_alarm", { at_tu: 10 });
    await seconds.app.call("set_timer", { duration_seconds: 7 });
  }
  await seconds.clock.setCalendar({ kind: "custom", units: [{ name: "轮", count: 9 }, { name: "刻", count: 50 }], epoch: [0, 0] });
  assert.deepEqual(seconds.app.viewState().durationUnits, [{ name: "世界秒", seconds: 1 }, { name: "刻", seconds: 50 }, { name: "轮", seconds: 450 }]);
  const synced = await fixture({ syncRealTime: true });
  await synced.clock.setCalendar({ kind: "custom", units: [{ name: "轮", count: 9 }], epoch: [0] });
  assert.equal(synced.app.viewState().calendarKind, "gregorian", "sync mode uses actual effective Gregorian clock, not a dormant custom epoch");
  assert.match(synced.app.viewState().alarmHint, /服务器时区/);
  assert.deepEqual(synced.app.viewState().durationUnits[1], { name: "分钟", seconds: 60 });
}

async function realBackgroundAndDispose() {
  const f = await fixture({ realSecondsPerUnit: 1, worldSecondsPerUnit: 1 });
  await f.clock.resume();
  const entered = deferred(), release = deferred();
  f.setNotify(async notice => { f.notices.push(notice); entered.resolve(); await release.promise; });
  await f.app.call("set_timer", { duration_seconds: .08, label: "后台真实定时器" });
  await f.app.close();
  await bounded(entered.promise);
  let disposed = false;
  const disposing = f.app.dispose().then(() => { disposed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(disposed, false, "dispose joins an already accepted callback before reset can delete its world files");
  release.resolve(); await bounded(disposing);
  assert.equal(f.notices.length, 1);
  assert.equal((f.app as any).timer, null);
  await assert.rejects(f.app.refresh(), /已停止/);
  await assert.rejects(f.app.open(), /已停止/);
  assert.equal((await fs.readdir(path.dirname(f.file))).some(name => name.endsWith(".tmp")), false);
}

async function main() {
  try {
    await remindersAndRestart(); await calendarAndPause(); await stopwatchAndFailures(); await nonEarthClockFaces(); await realBackgroundAndDispose();
    console.log("PASS clock app: actual world-clock units/calendars, background timer, pause, cancellation/snooze, stopwatch persistence, at-most-once restart, failed notification retry and dispose joins");
  } finally {
    await Promise.all(apps.map(app => app.dispose()));
    await Promise.all(clocks.map(clock => clock.suspend()));
    await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
