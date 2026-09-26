import type { WorldClock } from "../clock.js";
import type { NotifyManager, PhoneNotificationMode } from "../koishi/notify.js";
import type { AppRawTool, WorldApp } from "./app.js";

const modes = { vibrate: "振动", silent: "静音", off: "关闭" };
const tool: AppRawTool = {
  name: "notification_settings",
  description: "手机通知设置。list 查看；mode 调整全局振动/静音/关闭；app 调整指定应用。enabled 修改长期权限；仅填 mute_seconds>0 则按世界秒限时免打扰，到期恢复原设置；0 取消限时。未读保留，闹钟与计时器仍响铃。",
  inputSchema: { type: "object", properties: {
    action: { type: "string", enum: ["list", "app", "mode"] },
    app: { type: "string", description: "列表中的应用名称或 ID" },
    enabled: { type: "boolean", description: "是否长期允许该应用通知" },
    mute_seconds: { type: "number", minimum: 0, description: "免打扰世界秒数；0 取消限时，不改变长期权限" },
    mode: { type: "string", enum: ["vibrate", "silent", "off"] },
  }, additionalProperties: false },
};

/** System settings are ordinary phone UI; policy storage and time remain deterministic. */
export class SettingsApp implements WorldApp {
  readonly id = "settings";
  readonly name = "设置";
  readonly description = "应用通知权限、全局通知模式与限时免打扰";
  constructor(private options: {
    notify: NotifyManager;
    apps: () => { id: string; name: string; description: string }[];
    clock: Pick<WorldClock, "now" | "unitWorldSeconds" | "timeLine"> & Partial<Pick<WorldClock, "syncRealTime" | "calendar">>;
  }) {}

  viewState() {
    return { mode: this.options.notify.notificationMode, appsManaged: this.options.notify.appsBotManaged,
      apps: this.options.apps().map(app => ({ ...app, ...this.options.notify.appPolicy(app.id) })),
      calendarKind: this.options.clock.syncRealTime ? "gregorian" : this.options.clock.calendar?.kind ?? "gregorian",
      nowTU: this.options.clock.now(), secondsPerTU: this.options.clock.unitWorldSeconds, timeLine: this.options.clock.timeLine() };
  }
  peekScreen() {
    const state = this.viewState();
    return { text: `设置 · 通知\n${state.timeLine}\n全局模式：${modes[state.mode]}。${state.appsManaged ? "" : "通知设置由管理员管理。"}\n` +
      state.apps.map(app => `${app.name}（${app.id}）：${app.enabled ? "允许通知" : "通知关闭"}${app.muted ? `；免打扰至 ${app.mutedUntilText ?? `T=${app.mutedUntil}`}` : ""}`).join("\n") +
      "\n免打扰期间未读保留；具体会话通知在聊天应用内设置。闹钟与计时器独立响铃。", originEventIds: [] };
  }
  async open() { return { tools: [tool], opening: this.peekScreen() }; }
  async close(): Promise<void> {}
  async call(name: string, args: Record<string, unknown>, context?: { operator?: boolean }): Promise<string> {
    if (name !== tool.name) throw new Error("设置中没有此操作。");
    const action = args.action ?? "list", operator = context?.operator === true;
    if (action === "list") return this.peekScreen().text;
    if (action === "mode") {
      if (args.app !== undefined || args.enabled !== undefined || args.mute_seconds !== undefined) throw new Error("全局模式只需填写 mode；应用设置使用 action=app。");
      await this.options.notify.setMode(args.mode as PhoneNotificationMode, operator);
      return `全局通知：${modes[this.options.notify.notificationMode]}。`;
    }
    if (action !== "app") throw new Error("action 须为 list、app 或 mode。");
    if (typeof args.app !== "string" || !args.app.trim()) throw new Error("请选择要设置的应用。");
    if (args.enabled !== undefined && typeof args.enabled !== "boolean") throw new Error("enabled 须为 true 或 false。");
    if (args.mode !== undefined) throw new Error("全局模式请使用 action=mode。");
    if (args.enabled === undefined && args.mute_seconds === undefined) throw new Error("请填写 enabled 或 mute_seconds。");
    const query = args.app.trim().toLowerCase(), apps = this.options.apps();
    const exact = apps.find(app => app.id.toLowerCase() === query);
    const matches = exact ? [exact] : apps.filter(app => app.name.toLowerCase() === query);
    if (matches.length !== 1) throw new Error(matches.length ? "应用名称重复，请使用列表中的 ID。" : "未找到该应用，请查看设置中的应用列表。");
    const app = matches[0]!;
    await this.options.notify.setApp(app.id, args.enabled as boolean | undefined, args.mute_seconds as number | undefined, operator);
    const state = this.options.notify.appPolicy(app.id);
    return `${app.name}：${state.enabled ? "允许通知" : "通知关闭"}${state.muted ? `，免打扰至 ${state.mutedUntilText ?? `T=${state.mutedUntil}`}` : ""}。`;
  }
}
