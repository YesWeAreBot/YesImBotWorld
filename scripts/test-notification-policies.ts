/** Independent, persisted app/channel notification permissions on world time. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotifyManager } from "../src/koishi/notify.js";
import type { WorldMessageRow } from "../src/koishi/messages.js";

const group = "fixture@account:group", other = "fixture@account:other";
function row(id: number): WorldMessageRow {
  return { id, platform: "fixture", selfId: "account", channelId: "group", guildId: "group", userId: "friend", username: "朋友", content: "消息 " + id,
    timestamp: new Date(id * 1000), observedAt: new Date(id * 1000), messageId: "message-" + id, self: false, orderSource: "live" };
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-notification-policies-"));
  try {
    let now = 10;
    const clock = () => ({ now, unitWorldSeconds: 60, format: (tu: number) => `世界时刻 ${tu}` });
    const file = path.join(dir, "notifications.json");
    const notify = new NotifyManager(file, ["*"], true, { appsManaged: false, clock });
    await notify.load();
    assert.equal(notify.botManaged, true); assert.equal(notify.appsBotManaged, false);
    await notify.set(group, false);
    await assert.rejects(notify.setApp("chat", false), /管理员/);
    await assert.rejects(notify.setMode("silent"), /管理员/);
    await notify.setApp("chat", false, undefined, true);
    assert.equal(notify.isNotifyChannel(other), true, "app permission does not rewrite channel policy");
    assert.equal(notify.allowsNotification(other), false);
    assert.match(notify.channelStatusText(other), /频道通知：开启.*本应用通知已关闭/);
    assert.equal(notify.allowsAppNotification("clock"), true, "muting chat does not mute other apps");
    await notify.receive(other, row(1));
    assert.equal(notify.snapshot().unread, 1); assert.equal(notify.snapshot().count, 0);
    await notify.setApp("chat", true, undefined, true);
    assert.equal(notify.allowsNotification(other), true); assert.equal(notify.allowsNotification(group), false);
    assert.equal(notify.snapshot().count, 0, "reenabling never invents old notifications");
    await notify.set(group, true);
    await notify.set(group, undefined, 120);
    await notify.setApp("chat", undefined, 300, true);
    assert.deepEqual(notify.appPolicy("chat"), { id: "chat", enabled: true, muted: true, mutedUntil: 15, mutedUntilText: "世界时刻 15" });
    const channel = notify.snapshot().channels.find(item => item.key === group)!;
    assert.equal(channel.enabled, true); assert.equal(channel.mutedUntil, 12);
    assert.equal(channel.mutedUntilText, "世界时刻 12");
    assert.match(notify.channelStatusText(group), /免打扰至 世界时刻 12.*本应用免打扰至 世界时刻 15/);
    assert.equal(notify.isNotifyChannel(group), false);
    assert.equal(notify.vibrates(group), false); assert.equal(notify.appVibrates("clock"), true);
    await notify.receive(group, row(2));
    now = 12;
    assert.equal(notify.isNotifyChannel(group), true, "channel DND expires on world time");
    assert.equal(notify.allowsNotification(group), false, "longer app mute still applies");
    const reloaded = new NotifyManager(file, [], false, { appsManaged: true, clock });
    await reloaded.load();
    assert.deepEqual(reloaded.appPolicy("chat"), notify.appPolicy("chat"), "restart preserves remaining world-time DND");
    assert.equal(reloaded.isNotifyChannel(other), true, "disabling management does not revoke persisted channel settings");
    await assert.rejects(reloaded.set(other, false), /管理员/);
    await reloaded.setApp("notes", false);
    await reloaded.set(other, false, undefined, true);
    assert.equal(reloaded.isNotifyChannel(other), false, "operator edits apply while character management is disabled");
    now = 15;
    assert.equal(reloaded.appPolicy("chat").muted, false); assert.equal(reloaded.allowsNotification(group), true);
    assert.equal(reloaded.snapshot().unread, 2); assert.equal(reloaded.snapshot().count, 0, "expiry preserves unread without retroactive delivery");
    await reloaded.receive(group, row(3)); assert.equal(reloaded.snapshot().count, 1);
    await reloaded.setMode("silent");
    assert.match(reloaded.channelStatusText(group), /手机已静音/);
    assert.equal(reloaded.allowsNotification(group), true); assert.equal(reloaded.vibrates(group), false);
    await reloaded.setMode("vibrate");
    await reloaded.set(group, false, undefined, true);
    await reloaded.set(group, undefined, 60, true);
    assert.equal(reloaded.snapshot().channels.find(item => item.key === group)!.enabled, false, "temporary mute never changes base permission");
    now = 16;
    assert.equal(reloaded.isNotifyChannel(group), false, "expiry does not enable a permanently disabled channel");
    await reloaded.setApp("notes", undefined, 600);
    assert.equal(reloaded.appPolicy("notes").enabled, false, "app DND also preserves base permission");
    await reloaded.setApp("notes", undefined, 0);
    assert.deepEqual(reloaded.appPolicy("notes"), { id: "notes", enabled: false, muted: false });
    await reloaded.set(group, true, 120, true);
    await reloaded.setApp("notes", true, 120);
    assert.equal(reloaded.snapshot().channels.find(item => item.key === group)!.enabled, true, "explicit allow updates the base policy alongside DND");
    assert.deepEqual(reloaded.appPolicy("notes"), { id: "notes", enabled: true, muted: true, mutedUntil: 18, mutedUntilText: "世界时刻 18" });
    assert.equal(reloaded.isNotifyChannel(group), false); assert.equal(reloaded.allowsAppNotification("notes"), false);
    now = 18;
    assert.equal(reloaded.isNotifyChannel(group), true); assert.equal(reloaded.allowsAppNotification("notes"), true, "expiry restores the explicitly updated base permission");
    await reloaded.set(group, false, 60, true); await reloaded.setApp("notes", false, 60);
    assert.equal(reloaded.snapshot().channels.find(item => item.key === group)!.enabled, false);
    assert.equal(reloaded.appPolicy("notes").enabled, false);
    now = 19;
    assert.equal(reloaded.isNotifyChannel(group), false); assert.equal(reloaded.allowsAppNotification("notes"), false, "explicit base disable also survives expiry");
    await reloaded.set(group, true, 0, true);
    await reloaded.set(group, undefined, 600, true);
    await reloaded.set(group, undefined, 0, true);
    assert.equal(reloaded.isNotifyChannel(group), true, "timer cancellation preserves an enabled base policy");
    for (const duration of [-1, NaN, Infinity]) {
      await assert.rejects(reloaded.setApp("chat", undefined, duration), /非负秒数/);
      await assert.rejects(reloaded.set(group, undefined, duration, true), /非负秒数/);
    }
    let edgeTime = { now: 16, unitWorldSeconds: 60 };
    const edgeFile = path.join(dir, "duration-edge.json");
    const edge = new NotifyManager(edgeFile, ["*"], true, { clock: () => ({ ...edgeTime, format: tu => String(tu) }) });
    await edge.load();
    const initialEdgeState = await fs.readFile(edgeFile, "utf8");
    for (const test of [
      { now: 16, unitWorldSeconds: 60, duration: Number.MIN_VALUE },
      { now: Number.MAX_VALUE, unitWorldSeconds: 1, duration: Number.MAX_VALUE },
      { now: 0, unitWorldSeconds: Number.MIN_VALUE, duration: 1 },
    ]) {
      edgeTime = test;
      await assert.rejects(edge.setApp("chat", undefined, test.duration), /可表示的范围/);
      await assert.rejects(edge.set(group, undefined, test.duration), /可表示的范围/);
      assert.equal(await fs.readFile(edgeFile, "utf8"), initialEdgeState, "unrepresentable deadlines cannot mutate or persist policy");
    }
    // Even extreme world clocks allow explicitly cancelling a timer.
    await edge.setApp("chat", undefined, 0); await edge.set(group, undefined, 0);
    await assert.rejects(reloaded.operate({ action: "mode", mode: "off" }), /设置应用/);
    const reopened = new NotifyManager(file, [], false, { appsManaged: false, clock }); await reopened.load();
    assert.equal(reopened.isNotifyChannel(group), true); assert.equal(reopened.isNotifyChannel(other), false);
    assert.equal(reopened.appPolicy("notes").enabled, false);
    await reopened.clearNotifications(); assert.equal(reopened.snapshot().count, 0); assert.equal(reopened.snapshot().unread, 3);
    await reopened.reset();
    assert.equal(reopened.appPolicy("notes").enabled, true); assert.equal(reopened.snapshot().unread, 0);
    assert.equal(reopened.isNotifyChannel(group), false, "world reset reseeds configured initial channels");

    const legacyFile = path.join(dir, "legacy.json");
    await fs.writeFile(legacyFile, JSON.stringify({ allow: ["*"], deny: [group], mode: "off" }));
    const legacy = new NotifyManager(legacyFile, [group], false, { appsManaged: false, clock }); await legacy.load();
    assert.equal(legacy.isNotifyChannel(group), true, "unmanaged v1 used configured list; migration preserves its effective policy");
    assert.equal(legacy.isNotifyChannel(other), false); assert.equal(legacy.notificationMode, "off");
    assert.match(legacy.channelStatusText(group), /频道通知：开启.*手机通知已关闭/);
    await legacy.setMode("vibrate", true);
    await legacy.set(other, true, undefined, true);
    const migrated = new NotifyManager(legacyFile, [], false, { appsManaged: false, clock }); await migrated.load();
    assert.equal(migrated.isNotifyChannel(other), true); assert.equal(migrated.notificationMode, "vibrate");
    assert.equal(JSON.parse(await fs.readFile(legacyFile, "utf8")).version, 2);
    console.log("PASS notification policies: split permissions, app/channel layering, world-time DND, restart/expiry, administrator controls, unread independence and v1 migration");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
