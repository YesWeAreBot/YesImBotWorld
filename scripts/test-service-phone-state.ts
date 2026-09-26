/** Service binding to durable phone state and real app-notice projection; no external IO. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldService } from "../src/service.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { NotifyManager } from "../src/koishi/notify.js";
import { WorldFiles } from "../src/files.js";
import type { PhonePhysicalState, RichText } from "../src/types.js";

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const usable: PhonePhysicalState = { reachable: true, usable: true, perceptible: true, location: "书桌上" };
const distant: PhonePhysicalState = { reachable: false, usable: true, perceptible: false, location: "另一栋楼" };

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-service-phone-"));
  try {
    const files = new WorldFiles(dir); await files.ensure();
    const store = await NarrativeStore.open(dir, { now: () => 10 });
    await store.commit({ idempotencyKey: "initial", source: "administrator", initialized: true, worldState: "房间很安静。", phoneState: distant,
      actors: { bot: { id: "bot", name: "测试角色", controller: "bot", present: true, state: "坐在书桌前", perception: "房间里没有其他声音" } } });
    const notify = new NotifyManager(path.join(dir, "notify.json"), ["*"], true); await notify.load();
    let changes = 0;
    const notices: { rich: RichText; wake: boolean }[] = [];
    const bot: any = { deviceAttention: "phone", phonePhysicalStateChanged() { changes++; },
      notifyDevice(rich: RichText, opts: { wake: boolean }) { notices.push({ rich, wake: opts.wake }); },
      status: () => ({ running: true, phoneUi: { chatOpen: false, channelKey: null, channelIsGroup: false } }) };
    const world: any = { runtime: { store: async () => store } };
    const service: any = Object.create(WorldService.prototype);
    Object.assign(service, { world, phoneStatus: { down: false }, bot, worldActive: true, serviceStopped: false,
      files, notifyMgr: notify, config: Config({ autoStart: false }), clock: { syncRealTime: true },
      store: { knownChannels: async () => [{ key: "fixture@a:group", platform: "fixture", channelId: "group", selfId: "a", participants: [] }], recentChannels: async () => [] },
      deviceToolDefs: () => [] });
    await service.bindPhoneState();
    assert.deepEqual(service.phoneStatus.physical, distant); assert.equal(service.phoneStatus.down, true); assert.equal(changes, 1);
    assert.equal(world.runtime.phoneStatusProvider(), service.phoneStatus, "world observes the shared execution posture, not a stale copy");
    await store.commit({ idempotencyKey: "returned", source: "administrator", phoneState: usable });
    assert.deepEqual(service.phoneStatus.physical, usable); assert.equal(changes, 2); assert.equal(service.phoneStatus.down, true, "world reachability never silently picks up the device");
    const info = await service.devicesInfo(); assert.deepEqual(info.phone.physical, usable); assert.ok(info.phone.description.includes("书桌上"));
    const session = await service.deviceSession(); assert.equal(session.notifications.channels[0].key, "fixture@a:group");
    assert.equal(session.notifications.channels[0].enabled, true, "even channels without tracked incoming messages expose accurate notification policy");
    assert.equal(notices.length, 0, "hidden location metadata never becomes a character perception merely by synchronizing state");

    service.releasePhoneState();
    await store.commit({ idempotencyKey: "old-unsubscribed", source: "administrator", phoneState: distant });
    assert.deepEqual(service.phoneStatus.physical, usable, "retired subscriptions cannot mutate current execution state");
    const wait = gate();
    const oldWorld: any = { runtime: { store: async () => { await wait.promise; return store; } } };
    service.world = oldWorld; const opening = service.bindPhoneState();
    service.releasePhoneState();
    service.world = world;
    await store.commit({ idempotencyKey: "new-active", source: "administrator", phoneState: usable });
    await service.bindPhoneState(); wait.resolve(); await opening;
    assert.deepEqual(service.phoneStatus.physical, usable, "late store openings from retired worlds cannot apply or subscribe");

    const body: RichText = { text: "助手完成：只有查看屏幕才可见的回答", attachments: [{ id: 1, type: "image", mime: "image/png", file: "fixture.png" }], originEventIds: ["app:job"] };
    service.phoneStatus.down = false; await notify.setMode("silent");
    service.deliverAppNotice(bot, body); assert.deepEqual(notices.at(-1), { rich: body, wake: false });
    const count = notices.length; bot.deviceAttention = null;
    service.deliverAppNotice(bot, body); assert.equal(notices.length, count, "silent unseen completion does not wake or expose text");
    await notify.setMode("vibrate"); service.deliverAppNotice(bot, body);
    assert.equal(notices.length, count + 1); assert.match(notices.at(-1)!.rich.text, /振动/);
    assert.equal(notices.at(-1)!.rich.attachments, undefined); assert.ok(!notices.at(-1)!.rich.text.includes("回答"));
    await notify.setMode("off"); service.deliverAppNotice(bot, body); assert.equal(notices.length, count + 1);
    service.deliverAppNotice(bot, { text: "私人闹钟标签与世界时刻", originEventIds: ["clock:alarm"] }, "alarm");
    assert.equal(notices.at(-1)!.rich.text, "手机闹钟响了。"); assert.equal(notices.at(-1)!.wake, true);
    await notify.setMode("vibrate");
    await notify.setApp("assistant", false);
    const beforeAppMute = notices.length;
    service.deliverAppNotice(bot, body, undefined, "assistant");
    assert.equal(notices.length, beforeAppMute, "assistant permission suppresses its background signal");
    service.deliverAppNotice(bot, body, undefined, "camera");
    assert.equal(notices.length, beforeAppMute + 1, "muting assistant cannot suppress another application's signal");
    bot.deviceAttention = "phone";
    service.deliverAppNotice(bot, body, undefined, "assistant");
    assert.equal(notices.length, beforeAppMute + 1, "an app's permission also blocks notification banners while viewing another app");
    await notify.setApp("camera", undefined, 60);
    service.deliverAppNotice(bot, body, undefined, "camera");
    assert.equal(notices.length, beforeAppMute + 1, "temporary app mute applies to service completion notices");
    await notify.setApp("camera", undefined, 0);
    service.deliverAppNotice(bot, body, undefined, "camera");
    assert.deepEqual(notices.at(-1), { rich: body, wake: true }, "cancelling temporary mute restores the camera's prior permission");
    service.phoneStatus.physical = distant;
    const beforeMissed = notices.length;
    service.deliverAppNotice(bot, body); service.deliverAppNotice(bot, body, "timer");
    assert.equal(notices.length, beforeMissed, "an unperceivable phone cannot deliver even alarm cues");
    service.worldActive = false;
    assert.throws(() => service.deliverAppNotice(bot, body), /世界已停止/);
    service.releasePhoneState();
    console.log("PASS service phone wiring: durable state, holding authority, stale subscription/opening isolation, administrative snapshots, silent/off/alarm visibility");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
