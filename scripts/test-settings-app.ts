import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsApp } from "../src/apps/settings.js";
import { NotifyManager } from "../src/koishi/notify.js";
import { AppManager } from "../src/apps/manager.js";
import { Config } from "../src/config.js";

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-settings-"));
  try {
    let now = 50;
    const file = path.join(dir, "notify.json"),
      clock = { now: () => now, unitWorldSeconds: 10, timeLine: () => `星历 T=${now}` },
      notificationClock = () => ({ now, unitWorldSeconds: 10, format: (tu: number) => `星历 T=${tu}` });
    const notify = new NotifyManager(file, ["*"], true, { appsManaged: false, clock: notificationClock });
    await notify.load();
    const apps = [{ id: "chat", name: "QQ", description: "聊天" }, { id: "assistant", name: "小助手", description: "提问" },
      { id: "one", name: "同名", description: "" }, { id: "two", name: "同名", description: "" }];
    const settings = new SettingsApp({ notify, apps: () => apps, clock });
    const manager = new AppManager("QQ", [settings], new Set(), { warn() {}, info() {} } as any);
    const opened = await manager.open(settings);
    assert.match(JSON.stringify(opened.opening), /管理员管理/);
    assert.ok(manager.activeToolDefs().some(def => def.name === "notification_settings"));
    await assert.rejects(manager.call("notification_settings", { action: "app", app: "QQ", enabled: false }), /管理员/);
    await manager.call("notification_settings", { action: "app", app: "QQ", mute_seconds: 600 }, { operator: true });
    const view = settings.viewState();
    assert.equal(view.appsManaged, false);
    assert.equal(view.apps.find(app => app.id === "chat")!.mutedUntil, 110, "600 world seconds means 60 TU, not real time");
    assert.equal(view.apps.find(app => app.id === "assistant")!.muted, false);
    assert.equal(notify.allowsNotification("fixture@self:group"), false);
    assert.match(manager.screen()!.text, /QQ.*免打扰至 星历 T=110/);
    await assert.rejects(settings.call("notification_settings", { action: "app", app: "unknown", enabled: false }, { operator: true }), /未找到/);
    await assert.rejects(settings.call("notification_settings", { action: "app", app: "同名", enabled: false }, { operator: true }), /重复/);
    await assert.rejects(settings.call("notification_settings", { action: "app", app: "QQ", enabled: "false" }, { operator: true }), /true 或 false/);
    await assert.rejects(settings.call("notification_settings", { action: "mode", mode: "off", app: "QQ" }, { operator: true }), /只需/);
    await assert.rejects(settings.call("notification_settings", { action: "app", app: "QQ", mute_seconds: -1 }, { operator: true }), /非负/);
    await assert.rejects(settings.call("notification_settings", { action: "app", app: "QQ" }, { operator: true }), /填写/);
    await manager.closeCurrent();
    now = 110;
    await manager.open(settings);
    assert.equal(settings.viewState().apps.find(app => app.id === "chat")!.muted, false, "leaving settings does not suspend expiry");
    const restored = new NotifyManager(file, [], false, { appsManaged: true, clock: notificationClock });
    await restored.load();
    assert.equal(restored.allowsNotification("fixture@self:group"), true);
    const autonomous = new SettingsApp({ notify: restored, apps: () => apps, clock });
    await autonomous.call("notification_settings", { action: "app", app: "assistant", enabled: false });
    assert.equal(restored.allowsAppNotification("assistant"), false);
    assert.equal(restored.allowsAppNotification("chat"), true, "app policy cannot silence unrelated apps");
    await assert.rejects(restored.set("fixture@self:group", false), /管理员/, "app grant does not grant channel management");
    await autonomous.call("notification_settings", { action: "mode", mode: "silent" });
    assert.equal(restored.appVibrates("chat"), false);
    assert.equal(restored.allowsAppNotification("chat"), true, "silent preserves screen notifications");
    assert.equal(Config({}).apps.botManagedNotifications, false);
    await manager.closeAll();
    console.log("PASS settings app: independent grants, real AppManager operator context, world time, reopening, names, validation and persistent state");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
