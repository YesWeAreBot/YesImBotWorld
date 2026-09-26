/** A deterministic phone clock. Closing its screen never cancels its background reminders. */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "koishi";
import type { WorldClock } from "../clock.js";
import { parseGregorianEpoch, type CustomCalendar } from "../calendar.js";
import type { AppRawTool, WorldApp } from "./app.js";

export interface ClockNotice {
  /** Stable across explicitly failed delivery retries. */
  id: string;
  kind: "timer" | "alarm";
  label: string;
  dueTU: number;
  firedTU: number;
  text: string;
}

export interface ClockAppOptions {
  file: string;
  clock: WorldClock;
  /** Throw only if acceptance failed; a crashed/uncertain delivery is not replayed. */
  notify: (notice: ClockNotice) => Promise<void> | void;
  logger: Pick<Logger, "warn">;
}

export interface ClockReminder {
  id: string;
  kind: "timer" | "alarm";
  label: string;
  createdTU: number;
  dueTU: number;
  status: "scheduled" | "fired" | "cancelled";
  firedTU?: number;
  delivered?: boolean;
  deliveryError?: string;
}

interface ClockState {
  version: 1;
  reminders: ClockReminder[];
  stopwatch: { elapsedSeconds: number; startedTU: number | null; laps: number[] };
}

const MAX_REMINDERS = 200;
const MAX_LAPS = 100;
// WorldClock can be manually advanced/resumed without emitting an event. Check
// at most once per second only while a reminder exists; this never calls an LLM.
const RECHECK_MS = 1000;
const properties = {
  id: { type: "string", description: "list_reminders 中的提醒 id" },
  label: { type: "string", maxLength: 200, description: "提醒标题，不必填写" },
  duration_seconds: { type: "number", exclusiveMinimum: 0, description: "经过多少世界秒；不是 TU，也不是现实秒" },
};

const CLOCK_TOOLS: AppRawTool[] = [
  { name: "read_clock", description: "查看权威世界时钟、计时单位与暂停语义，不改变时间。", inputSchema: { type: "object", properties: {} } },
  { name: "set_timer", description: "设一个单次倒计时，duration_seconds 为世界秒。关应用、放下手机不会取消；到期只响铃提醒，不代表你睡着或睡醒。", inputSchema: { type: "object", properties: { duration_seconds: properties.duration_seconds, label: properties.label }, required: ["duration_seconds"] } },
  { name: "set_alarm", description: "设一次闹钟：time 为当前世界历法下一个 时:分 钟点，已经过去则是下一天；范围以 read_clock 为准，不预设一天24时或一时60分。或者用 at_tu 指定未来世界时刻（TU），二选一。无法明确换算钟点的自定义历法请用 set_timer。", inputSchema: { type: "object", properties: { time: { type: "string", description: "当前世界历法的 时:分，例如 07:30；自定义历法可用不同起点或位数" }, at_tu: { type: "number", description: "绝对未来世界时刻 TU，与 time 二选一" }, label: properties.label } } },
  { name: "list_reminders", description: "查看提醒 id、标题、到期世界时刻与状态。默认也显示最近已响/取消的提醒。", inputSchema: { type: "object", properties: { include_finished: { type: "boolean", default: true } } } },
  { name: "cancel_reminder", description: "取消一条尚未到期的提醒；不会抹去已响过的事实。", inputSchema: { type: "object", properties: { id: properties.id }, required: ["id"] } },
  { name: "snooze_reminder", description: "把一条未响或已响的提醒延后，从现在起 duration_seconds 世界秒后再次响铃，生成新的提醒 id；不会把贪睡操作当成你真的睡觉。", inputSchema: { type: "object", properties: { id: properties.id, duration_seconds: properties.duration_seconds }, required: ["id", "duration_seconds"] } },
  { name: "stopwatch", description: "秒表：start 开始/继续、pause 暂停、lap 记录本轮累计圈时、reset 清零并停止、read 查看。所有数值均为世界秒；不推进世界时间。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "pause", "lap", "reset", "read"] } }, required: ["action"] } },
];

export class ClockApp implements WorldApp {
  readonly id = "clock";
  readonly name = "时钟";
  readonly description = "世界时钟、后台闹钟、倒计时和秒表；关闭应用也能到时提醒";
  private state: ClockState = { version: 1, reminders: [], stopwatch: { elapsedSeconds: 0, startedTU: null, laps: [] } };
  private started = false;
  private disposed = false;
  private opened = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private options: ClockAppOptions) {}

  /** UI polling is a read: it neither rings reminders nor mutates/persists state. */
  viewState(): {
    timeLine: string; nowTU: number; secondsPerTU: number;
    calendarKind: "gregorian" | "custom"; alarmHint: string; durationUnits: { name: string; seconds: number }[];
    reminders: (ClockReminder & { timeLine: string })[];
    stopwatch: { elapsedSeconds: number; running: boolean; laps: number[] };
  } {
    const nowTU = this.options.clock.now();
    return {
      timeLine: this.options.clock.timeLine(nowTU), nowTU, secondsPerTU: this.options.clock.unitWorldSeconds,
      calendarKind: this.options.clock.syncRealTime ? "gregorian" : this.options.clock.calendar.kind,
      alarmHint: alarmClockText(this.options.clock), durationUnits: clockDurationUnits(this.options.clock),
      reminders: this.state.reminders.map(item => ({ ...item, timeLine: this.options.clock.timeLine(item.dueTU) })),
      stopwatch: { elapsedSeconds: this.elapsed(nowTU), running: this.state.stopwatch.startedTU !== null, laps: [...this.state.stopwatch.laps] },
    };
  }

  /** Start the background device at world startup, even if its screen is never opened. */
  async start(): Promise<void> {
    await this.enqueue(async () => {
      if (this.started) return;
      let raw: string | null = null;
      try { raw = await fs.readFile(this.options.file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (raw !== null) this.state = parseState(JSON.parse(raw));
      this.started = true;
      await this.fireDue();
    });
  }

  async open(): Promise<{ tools: AppRawTool[]; opening: string }> {
    await this.start();
    this.assertAlive();
    this.opened = true;
    return this.enqueue(async () => ({ tools: structuredClone(CLOCK_TOOLS), opening: `${this.clockText()}\n${this.remindersText(true)}` }));
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    this.assertAlive();
    if (!this.opened) throw new Error("时钟应用已关闭，请重新打开后操作；已设提醒仍在后台运行。");
    await this.start();
    return this.enqueue(async () => {
      await this.fireDue();
      const now = this.options.clock.now();
      if (tool === "read_clock") return this.clockText();
      if (tool === "list_reminders") {
        if (args.include_finished != null && typeof args.include_finished !== "boolean") throw new Error("include_finished 须为布尔值");
        return this.remindersText(args.include_finished !== false);
      }
      const draft = structuredClone(this.state);
      let response: string;
      switch (tool) {
        case "set_timer": {
          const duration = positiveSeconds(args.duration_seconds);
          const reminder = this.newReminder("timer", label(args.label, "倒计时"), now + duration / this.options.clock.unitWorldSeconds, now);
          addReminder(draft, reminder);
          response = `已设 ${duration} 世界秒倒计时。${this.reminderText(reminder)}`;
          break;
        }
        case "set_alarm": {
          if ((args.time != null) === (args.at_tu != null)) throw new Error("time 与 at_tu 须且只能填写一个");
          const due = args.time != null ? nextClockTime(this.options.clock, args.time, now) : args.at_tu;
          if (typeof due !== "number" || !Number.isFinite(due) || due <= now) throw new Error("闹钟必须设在未来世界时刻，at_tu 单位为 TU");
          const reminder = this.newReminder("alarm", label(args.label, "闹钟"), due, now);
          addReminder(draft, reminder);
          response = `已设单次闹钟。${this.reminderText(reminder)}`;
          break;
        }
        case "cancel_reminder": {
          const reminder = getReminder(draft, args.id);
          if (reminder.status !== "scheduled") return `该提醒${reminder.status === "fired" ? "已经响过" : "已经取消"}，未改变记录。`;
          reminder.status = "cancelled";
          response = `已取消「${reminder.label}」（id=${reminder.id}）。`;
          break;
        }
        case "snooze_reminder": {
          const previous = getReminder(draft, args.id);
          if (previous.status === "cancelled") throw new Error("已取消的提醒不能贪睡，请新设提醒");
          const duration = positiveSeconds(args.duration_seconds);
          if (previous.status === "scheduled") previous.status = "cancelled";
          const reminder = this.newReminder(previous.kind, previous.label, now + duration / this.options.clock.unitWorldSeconds, now);
          addReminder(draft, reminder);
          response = `已延后 ${duration} 世界秒再提醒。${this.reminderText(reminder)}`;
          break;
        }
        case "stopwatch": {
          const watch = draft.stopwatch;
          const elapsed = this.elapsed(now);
          switch (args.action) {
            case "read": return this.stopwatchText();
            case "start": if (watch.startedTU === null) watch.startedTU = now; break;
            case "pause": watch.elapsedSeconds = elapsed; watch.startedTU = null; break;
            case "lap":
              if (watch.startedTU === null) throw new Error("秒表尚未运行，请先 start");
              if (watch.laps.length >= MAX_LAPS) throw new Error(`最多保留 ${MAX_LAPS} 条圈时，请查看后 reset`);
              watch.laps.push(elapsed); break;
            case "reset": draft.stopwatch = { elapsedSeconds: 0, startedTU: null, laps: [] }; break;
            default: throw new Error("action 须为 start、pause、lap、reset 或 read");
          }
          await this.commit(draft);
          return this.stopwatchText();
        }
        default: throw new Error(`时钟没有 ${tool} 这个操作`);
      }
      await this.commit(draft);
      return response;
    });
  }

  /** Only closes foreground access. The service calls dispose before reset/restore/stop. */
  async close(): Promise<void> { this.opened = false; await this.tail; }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.opened = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tail;
  }

  /** Explicitly refresh after a known world-clock change; also useful to await background work. */
  async refresh(): Promise<void> { await this.start(); await this.enqueue(() => this.fireDue()); }

  private assertAlive(): void { if (this.disposed) throw new Error("时钟设备已停止，不能继续操作旧世界的提醒。"); }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("时钟设备已停止，不能继续操作旧世界的提醒。"));
    const task = this.tail.then(async () => { this.assertAlive(); return operation(); });
    this.tail = task.then(() => {}, () => {});
    // Re-arm after both successful and failed operations. A failed persistence
    // write must not disable all later alarms or poison the operation queue.
    void task.then(() => this.schedule(), () => this.schedule(RECHECK_MS));
    return task;
  }

  private schedule(retryDelay = 0): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || !this.started) return;
    const pending = this.state.reminders.filter(item => item.status === "scheduled");
    const undelivered = this.state.reminders.some(item => item.status === "fired" && !item.delivered);
    if (!pending.length && !undelivered) return;
    const due = Math.min(...pending.map(item => item.dueTU));
    const delay = undelivered ? RECHECK_MS : !this.options.clock.running ? RECHECK_MS
      : Math.max(1, Math.min(RECHECK_MS, this.options.clock.realMsUntil(due)));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(() => this.fireDue()).catch(error => this.options.logger.warn("时钟提醒处理失败: %s", error));
    }, Math.max(delay, retryDelay));
    this.timer.unref?.();
  }

  private async fireDue(): Promise<void> {
    if (this.disposed) return;
    const now = this.options.clock.now();
    const draft = structuredClone(this.state);
    let changed = false;
    for (const reminder of draft.reminders) if (reminder.status === "scheduled" && reminder.dueTU <= now) {
      reminder.status = "fired"; reminder.firedTU = now; reminder.delivered = false; changed = true;
    }
    // Record each due reminder before dispatch. Delivery is at-most-once across
    // an uncertain crash because Bot pushEvent has no durable acknowledgement.
    // Explicit callback failures remain retryable with the same notice ID.
    if (changed) await this.commit(draft);
    for (const reminder of this.state.reminders.filter(item => item.status === "fired" && !item.delivered).sort((a, b) => a.dueTU - b.dueTU)) {
      if (this.disposed) return;
      const firedTU = reminder.firedTU!;
      const late = firedTU - reminder.dueTU;
      const text = `手机时钟${reminder.kind === "timer" ? "倒计时" : "闹钟"}响了：「${reminder.label}」。预定世界时刻 ${this.options.clock.timeLine(reminder.dueTU)}。${late * this.options.clock.unitWorldSeconds >= 1 ? `当前 ${this.options.clock.timeLine(firedTU)}，这是到期提醒的补交。` : ""}`;
      const attempted = structuredClone(this.state);
      const marked = attempted.reminders.find(item => item.id === reminder.id)!;
      marked.delivered = true;
      delete marked.deliveryError;
      await this.commit(attempted);
      if (this.disposed) {
        // The callback has definitely not begun, so stopping may safely retain
        // this reminder for the next device instance instead of losing it.
        const deferred = structuredClone(this.state);
        deferred.reminders.find(item => item.id === reminder.id)!.delivered = false;
        await this.commit(deferred);
        return;
      }
      try { await this.options.notify({ id: `phone-clock:${reminder.id}`, kind: reminder.kind, label: reminder.label, dueTU: reminder.dueTU, firedTU, text }); }
      catch (error) {
        this.options.logger.warn("时钟提醒投递失败，将保留同一通知重试: %s", error);
        const failed = structuredClone(this.state);
        const item = failed.reminders.find(item => item.id === reminder.id)!;
        item.delivered = false;
        item.deliveryError = String(error).slice(0, 500);
        await this.commit(failed);
      }
    }
  }

  private async commit(state: ClockState): Promise<void> {
    await fs.mkdir(path.dirname(this.options.file), { recursive: true });
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(state), { flag: "wx" });
      await fs.rename(temporary, this.options.file);
      this.state = state;
    } finally { await fs.rm(temporary, { force: true }); }
  }

  private newReminder(kind: ClockReminder["kind"], text: string, dueTU: number, now: number): ClockReminder {
    if (!Number.isFinite(dueTU) || dueTU <= now) throw new Error("提醒时刻须为可表示的未来世界时刻");
    return { id: randomUUID(), kind, label: text, createdTU: now, dueTU, status: "scheduled" };
  }
  private clockText(): string {
    const clock = this.options.clock;
    return `世界时钟：${clock.timeLine()}。1 TU = ${clock.unitWorldSeconds} 世界秒 = ${clock.unitRealSeconds} 现实秒。${clock.syncRealTime ? "当前与现实同步；世界暂停期间时钟仍流逝，恢复设备时补交到期提醒。" : clock.running ? "世界时间正在流逝；显式暂停世界会冻结倒计时和秒表。" : "世界时间已暂停，倒计时和秒表不会继续增加。"}\n${alarmClockText(clock)}`;
  }
  private reminderText(reminder: ClockReminder): string {
    return `「${reminder.label}」[${reminder.kind === "alarm" ? "闹钟" : "倒计时"}；${reminder.status === "scheduled" ? "待响" : reminder.status === "fired" ? reminder.delivered ? "已响" : "已到期，提醒待投递" : "已取消"}] ${this.options.clock.timeLine(reminder.dueTU)}；id=${reminder.id}`;
  }
  private remindersText(includeFinished: boolean): string {
    const rows = this.state.reminders.filter(item => includeFinished || item.status === "scheduled")
      .slice().sort((a, b) => Number(b.status === "scheduled") - Number(a.status === "scheduled") || a.dueTU - b.dueTU);
    return rows.length ? rows.map(item => this.reminderText(item)).join("\n") : "没有提醒。";
  }
  private elapsed(now = this.options.clock.now()): number {
    const watch = this.state.stopwatch;
    return watch.elapsedSeconds + (watch.startedTU === null ? 0 : Math.max(0, now - watch.startedTU) * this.options.clock.unitWorldSeconds);
  }
  private stopwatchText(): string {
    const watch = this.state.stopwatch;
    return `秒表${watch.startedTU === null ? "已暂停" : "计时中"}：${this.elapsed().toFixed(3)} 世界秒。${watch.laps.length ? "\n累计圈时：" + watch.laps.map((lap, index) => `#${index + 1} ${lap.toFixed(3)} 秒`).join("；") : ""}`;
  }
}

function positiveSeconds(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) throw new Error("duration_seconds 须为大于 0 的有限数字，单位为世界秒");
  return raw;
}
function label(raw: unknown, fallback: string): string {
  if (raw == null) return fallback;
  if (typeof raw !== "string" || raw.length > 200) throw new Error("label 须为不超过 200 字符的文字");
  return raw.trim() || fallback;
}
function getReminder(state: ClockState, id: unknown): ClockReminder {
  if (typeof id !== "string") throw new Error("id 须为提醒标识");
  const reminder = state.reminders.find(item => item.id === id);
  if (!reminder) throw new Error("未找到该提醒，请先 list_reminders 查看");
  return reminder;
}
function addReminder(state: ClockState, reminder: ClockReminder): void {
  // Remove only completed history; never silently lose a pending alarm/outbox.
  while (state.reminders.length >= MAX_REMINDERS) {
    const index = state.reminders.findIndex(item => item.status === "cancelled" || item.status === "fired" && item.delivered);
    if (index < 0) throw new Error(`已有 ${MAX_REMINDERS} 条待处理提醒，请先取消不需要的提醒`);
    state.reminders.splice(index, 1);
  }
  state.reminders.push(reminder);
}

/** Convert a user-facing clock time using the same persisted calendar as WorldClock. */
function nextClockTime(clock: WorldClock, raw: unknown, now: number): number {
  const match = typeof raw === "string" ? /^(\d{1,16}):(\d{1,16})$/.exec(raw.trim()) : null;
  if (!match) throw new Error("time 须为世界钟点 时:分，例如 07:30；范围以 read_clock 为准");
  const hour = Number(match[1]), minute = Number(match[2]);
  if (!Number.isSafeInteger(hour) || !Number.isSafeInteger(minute)) throw new Error("钟点超出可可靠换算范围，请用 set_timer 或 at_tu");
  const calendar = clock.calendar;
  if (clock.syncRealTime || calendar.kind === "gregorian") {
    if (hour > 23 || minute > 59) throw new Error("公历钟点须在 00:00 至 23:59 之间");
    const epoch = calendar.kind === "gregorian" ? parseGregorianEpoch(calendar.epoch) : null;
    const currentMs = clock.syncRealTime ? Date.now() : epoch === null ? NaN : epoch + now * clock.unitWorldSeconds * 1000;
    if (!Number.isFinite(currentMs)) throw new Error("世界公历未就绪，不能猜测闹钟时间；请用 set_timer");
    const next = new Date(currentMs);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= currentMs) next.setDate(next.getDate() + 1);
    return now + (next.getTime() - currentMs) / 1000 / clock.unitWorldSeconds;
  }
  const { day, hourIndex, minuteIndex, hourStart, minuteStart, hoursPerDay, minutesPerHour, sizes } = customClockFace(calendar);
  if (hour < hourStart || hour >= hourStart + hoursPerDay || minute < minuteStart || minute >= minuteStart + minutesPerHour)
    throw new Error(`该世界一天有 ${hoursPerDay} 时，每时 ${minutesPerHour} 分；时范围 ${hourStart}—${hourStart + hoursPerDay - 1}，分范围 ${minuteStart}—${minuteStart + minutesPerHour - 1}，钟点超出范围`);
  const epoch = calendar.epoch.reduce((sum, value, index) => sum + (value - (calendar.units[index]!.start ?? 0)) * sizes[index]!, 0);
  const daySeconds = sizes[day]!;
  const elapsed = epoch + now * clock.unitWorldSeconds;
  if (!Number.isSafeInteger(epoch) || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > Number.MAX_SAFE_INTEGER - daySeconds) throw new Error("自定义历法时间超出可可靠换算范围，请用 set_timer 或 at_tu");
  const within = elapsed % daySeconds;
  let seconds = (hour - hourStart) * sizes[hourIndex]! + (minute - minuteStart) * sizes[minuteIndex]! - within;
  if (seconds <= 0) seconds += daySeconds;
  return now + seconds / clock.unitWorldSeconds;
}

/** Only interpret an unambiguous clock face, never infer Earth units from an arbitrary calendar. */
function customClockFace(calendar: CustomCalendar) {
  const dayIndices = calendar.units.flatMap((unit, index) => /^(日|天|day|days)$/i.test(unit.name) ? [index] : []);
  const day = dayIndices[0] ?? -1, hourIndex = day + 1, minuteIndex = day + 2;
  const hourUnit = calendar.units[hourIndex], minuteUnit = calendar.units[minuteIndex];
  const hourStart = hourUnit?.start ?? 0, minuteStart = minuteUnit?.start ?? 0;
  if (dayIndices.length !== 1 || !hourUnit || !minuteUnit || !/^(时|小时|hour|hours)$/i.test(hourUnit.name) || !/^(分|分钟|minute|minutes)$/i.test(minuteUnit.name)
    || !Number.isSafeInteger(hourStart) || hourStart < 0 || !Number.isSafeInteger(minuteStart) || minuteStart < 0)
    throw new Error("该自定义历法无法无歧义地换算 时:分（需唯一且连续的日/时/分，时分显示值非负）；请用 set_timer 或 at_tu");
  const sizes = new Array<number>(calendar.units.length);
  for (let index = sizes.length - 1; index >= 0; index--) {
    sizes[index] = calendar.units[index]!.count * (sizes[index + 1] ?? 1);
    if (!Number.isSafeInteger(sizes[index]) || sizes[index]! <= 0) throw new Error("自定义历法单位超出可可靠换算范围，请用 set_timer 或 at_tu");
  }
  const hoursPerDay = calendar.units[day]!.count, minutesPerHour = hourUnit.count;
  if (!Number.isSafeInteger(hourStart + hoursPerDay) || !Number.isSafeInteger(minuteStart + minutesPerHour))
    throw new Error("自定义历法钟点超出可可靠换算范围，请用 set_timer 或 at_tu");
  return { day, hourIndex, minuteIndex, hourStart, minuteStart, hoursPerDay, minutesPerHour, sizes };
}

function alarmClockText(clock: WorldClock): string {
  if (clock.syncRealTime || clock.calendar.kind === "gregorian")
    return `闹钟钟点采用世界时钟显示的公历及服务器时区（${Intl.DateTimeFormat().resolvedOptions().timeZone}），范围 00:00—23:59。`;
  const units = "倒计时和秒表的世界秒是底层计量单位，不把自定义历法中同名的“秒”默认当成 1 世界秒。";
  try {
    const face = customClockFace(clock.calendar);
    return `闹钟采用自定义历法的 时:分，无地球时区映射：时范围 ${face.hourStart}—${face.hourStart + face.hoursPerDay - 1}，分范围 ${face.minuteStart}—${face.minuteStart + face.minutesPerHour - 1}；1 日 = ${face.sizes[face.day]} 世界秒，1 时 = ${face.sizes[face.hourIndex]} 世界秒，1 分 = ${face.sizes[face.minuteIndex]} 世界秒。${units}`;
  } catch (error) { return `${error instanceof Error ? error.message : String(error)}。${units}`; }
}

function clockDurationUnits(clock: WorldClock): { name: string; seconds: number }[] {
  const result = [{ name: "世界秒", seconds: 1 }];
  if (clock.syncRealTime || clock.calendar.kind === "gregorian")
    return [...result, { name: "分钟", seconds: 60 }, { name: "小时", seconds: 3600 }, { name: "日（24小时）", seconds: 86400 }];
  let seconds = 1;
  for (const unit of [...clock.calendar.units].reverse()) {
    seconds *= unit.count;
    // An unknown unit name is still a known duration. Never infer 60 or 24
    // from its spelling; include only exact mappings representable in JS.
    if (!Number.isSafeInteger(seconds) || seconds <= 0) break;
    result.push({ name: unit.name === "世界秒" ? "世界秒（历法）" : unit.name, seconds });
  }
  return result;
}

function parseState(raw: unknown): ClockState {
  const invalid = () => { throw new Error("时钟存档格式无效，未覆盖原文件"); };
  if (!raw || typeof raw !== "object") return invalid();
  const state = raw as ClockState;
  if (state.version !== 1 || !Array.isArray(state.reminders) || state.reminders.length > MAX_REMINDERS || !state.stopwatch) return invalid();
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const ids = new Set<string>();
  for (const item of state.reminders) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || !["alarm", "timer"].includes(item.kind) || typeof item.label !== "string" || item.label.length > 200
      || !finite(item.createdTU) || !finite(item.dueTU) || !["scheduled", "fired", "cancelled"].includes(item.status)
      || item.status === "fired" && (!finite(item.firedTU) || typeof item.delivered !== "boolean")) return invalid();
    ids.add(item.id);
  }
  const watch = state.stopwatch;
  if (!finite(watch.elapsedSeconds) || watch.startedTU !== null && !finite(watch.startedTU) || !Array.isArray(watch.laps) || watch.laps.length > MAX_LAPS || watch.laps.some(lap => !finite(lap))) return invalid();
  return structuredClone(state);
}
