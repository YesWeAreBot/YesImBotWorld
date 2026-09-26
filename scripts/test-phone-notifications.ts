/** Persisted unread/notification state and live message perception, without real platform traffic. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { NotifyManager } from "../src/koishi/notify.js";
import { Gateway } from "../src/koishi/gateway.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { ChannelNameResolver } from "../src/koishi/names.js";
import type { PhoneStatus, RichText } from "../src/types.js";

const keyA = "fixture@a:group", keyB = "fixture@b:group";
function row(id: number, overrides: Partial<WorldMessageRow> = {}): WorldMessageRow {
  return { id, platform: "fixture", channelId: "group", selfId: "a", guildId: "group", userId: "friend", username: "朋友", content: "消息" + id,
    timestamp: new Date(id * 1000), observedAt: new Date(id * 1000), messageId: "msg-" + id, self: false, orderSource: "live", ...overrides };
}

async function ledger(dir: string) {
  const file = path.join(dir, "notify.json"), notify = new NotifyManager(file, ["*"], true);
  await notify.load();
  await Promise.all([notify.receive(keyA, row(1)), notify.receive(keyB, row(1)), notify.receive(keyA, row(2))]);
  assert.equal(notify.unreadCount(keyA), 2); assert.equal(notify.unreadCount(keyB), 1);
  await notify.markSeen(keyA, [row(1)]);
  assert.equal(notify.unreadCount(keyA), 1); assert.equal(notify.unreadCount(keyB), 1, "account A reading a shared message ID never clears account B");
  await notify.receive(keyA, row(1)); assert.equal(notify.unreadCount(keyA), 1, "rereceived already-read identities stay read");
  await notify.updatePreview(keyA, row(2, { content: "[消息已撤回]" }));
  assert.equal(notify.snapshot().channels.find(value => value.key === keyA)?.latest?.preview, "[消息已撤回]");
  assert.equal(notify.unreadCount(keyA), 1, "recall changes the existing preview without manufacturing another unread item");
  await notify.receive(keyA, row(100, { orderSource: "history" }));
  await notify.receive(keyA, row(101, { self: true }));
  assert.equal(notify.unreadCount(keyA), 1, "cloud history and own sends do not increment unread");
  await notify.markSeen(keyA, [row(0), row(100), row(101)]);
  assert.equal(notify.unreadCount(keyA), 1, "older history or own send readback never clears unseen live messages");
  await notify.clearNotifications(keyA);
  assert.equal(notify.unreadCount(keyA), 1); assert.equal(notify.snapshot().count, 1, "clear only removes A's notification, not B or unread");
  await notify.receive(keyA, row(3)); assert.equal(notify.snapshot().count, 2, "a new message creates a new notification after clearing");
  await notify.set(keyA, false); await notify.receive(keyA, row(4));
  assert.equal(notify.unreadCount(keyA), 3); assert.equal(notify.snapshot().count, 2, "DND retains unread without a new notification");
  await notify.setMode("off"); await notify.receive(keyB, row(5));
  assert.equal(notify.unreadCount(keyB), 2); assert.equal(notify.snapshot().count, 2);
  const reloaded = new NotifyManager(file, ["*"], true); await reloaded.load();
  assert.deepEqual(reloaded.snapshot(), notify.snapshot(), "unread, cleared notices, DND and phone mode survive reload");
  const archivedBytes = await fs.readFile(file, "utf8"), archivedState = reloaded.snapshot();
  await reloaded.setMode("silent"); await reloaded.clearMessages();
  await fs.writeFile(file, archivedBytes); await reloaded.load(true);
  assert.deepEqual(reloaded.snapshot(), archivedState, "explicit archive reload replaces in-memory readings and mode from restored disk state");
  await reloaded.receive(keyA, row(1)); assert.equal(reloaded.unreadCount(keyA), 3, "read identities survive reload");
  await reloaded.operate({ action: "read", id: keyA });
  assert.equal(reloaded.unreadCount(keyA), 0); assert.equal(reloaded.unreadCount(keyB), 2);
  assert.match(await reloaded.operate({ action: "list" }), /2 条未读/);
  const locked = new NotifyManager(path.join(dir, "locked.json"), [keyA], false); await locked.load();
  await locked.receive(keyB, row(7));
  await assert.rejects(locked.set(keyB, true), /管理员/); await assert.rejects(locked.setMode("silent"), /管理员/);
  await locked.operate({ action: "clear" }); await locked.operate({ action: "read" });
  assert.equal(locked.unreadCount(keyB), 0, "administrator-owned policies do not prevent notification housekeeping");
  const lockedReloaded = new NotifyManager(path.join(dir, "locked.json"), [keyA], false); await lockedReloaded.load();
  await lockedReloaded.receive(keyB, row(7)); assert.equal(lockedReloaded.unreadCount(keyB), 0);
  await fs.writeFile(path.join(dir, "legacy.json"), JSON.stringify({ allow: ["*"], deny: [keyA] }));
  const legacy = new NotifyManager(path.join(dir, "legacy.json"), [], true); await legacy.load();
  assert.equal(legacy.notificationMode, "vibrate"); assert.equal(legacy.isNotifyChannel(keyA), false); assert.equal(legacy.unreadCount(keyA), 0);
  const starting = new NotifyManager(path.join(dir, "starting.json"), ["*"], true);
  await Promise.all([starting.receive(keyA, row(10)), starting.load(), starting.receive(keyB, row(11))]);
  assert.equal(starting.snapshot().unread, 2, "traffic arriving while initial loading is pending is retained");
  await Promise.all([starting.receive(keyA, row(12)), starting.reset(), starting.receive(keyB, row(13))]);
  assert.equal(starting.unreadCount(keyA), 0); assert.equal(starting.unreadCount(keyB), 1, "reset serializes with live updates and retains only arrivals after its boundary");
  console.log("PASS notification ledger: account isolation, exact read slices, deduplication, clear/read separation, history/self exclusions, restart and permissions");
}

async function delivery(dir: string) {
  const cfg = Config({ autoStart: false }), rows: WorldMessageRow[] = [];
  const handlers = new Map<string, (session: any) => void>();
  const ctx: any = { bots: ["a", "b"].map(selfId => ({ platform: "fixture", selfId, isActive: true })), on(name: string, handle: (session: any) => void) { handlers.set(name, handle); }, model: { extend() {} }, logger: () => ({ warn() {} }),
    database: {
      async create(_table: string, value: any) { const next = { id: rows.length + 1, ...value }; rows.push(next); return next; },
      async get(_table: string, query: Record<string, any>, options: any) {
        return rows.filter((item: any) => Object.entries(query).every(([key, value]) => value && typeof value === "object" ? value.$in.includes(item[key]) : item[key] === value))
          .sort((a, b) => String(b.timelineKey ?? "").localeCompare(String(a.timelineKey ?? "")) || b.id - a.id).slice(0, options?.limit);
      },
    } };
  let worldNow = 0;
  const store = new MessageStore(ctx), notify = new NotifyManager(path.join(dir, "live-notify.json"), ["*"], true,
    { clock: () => ({ now: worldNow, unitWorldSeconds: 60, format: tu => `世界分钟 ${tu}` }) }); await notify.load();
  let focused = false, accepted = true;
  const focus: any = { isFocused: () => focused, focus: async () => {} };
  const renderer: any = { render: async (text: string) => ({ text, parts: [{ kind: "text", text }] }) };
  const phone: PhoneStatus = { down: true };
  const names = Object.assign(new ChannelNameResolver(ctx, store), { display: async (key: string) => "会话 " + key });
  const messaging = { ...cfg.messaging, notifyPolicy: "channel" as "channel" | "content", externalSelfMessages: "off" as const };
  const received: { content: RichText; wake: boolean }[] = [];
  const gateway: any = new Gateway(ctx, messaging, cfg.platformOps, store, {} as any, renderer, focus, notify, phone, {} as any, new OwnSendTracker(), names, () => null,
    { notify(content, wake) { if (!accepted) return false; received.push({ content, wake }); return true; }, selfMessage() {}, channelActivity() {} });
  const incoming = async (id: string) => gateway.handle({ platform: "fixture", selfId: "a", bot: ctx.bots[0], channelId: "group", guildId: "group",
    userId: "friend", username: "朋友", timestamp: Date.now(), isDirect: false, messageId: id, elements: [h.text("原文 " + id)] });
  await incoming("placed"); assert.equal(notify.unreadCount(keyA), 1); assert.equal(received.length, 1); assert.match(received[0]!.content.text, /震/);
  assert.ok(!received[0]!.content.text.includes("原文"));
  phone.physical = { reachable: false, location: "另一栋楼", usable: true, perceptible: false };
  await incoming("far-away"); assert.equal(notify.unreadCount(keyA), 2); assert.equal(received.length, 1, "unperceivable phone does not wake or leak content");
  phone.physical = { reachable: true, location: "手边", usable: false, perceptible: true }; phone.down = false;
  await incoming("broken"); assert.equal(received.length, 1, "broken phone does not produce a perceived vibration or visible content");
  phone.physical.usable = true; phone.down = true; await notify.setMode("silent");
  await incoming("muted-placed"); assert.equal(received.length, 1);
  phone.down = false;
  await incoming("muted-held"); assert.equal(received.length, 2); assert.equal(received.at(-1)!.wake, false);
  assert.match(received.at(-1)!.content.text, /屏幕提示/); assert.doesNotMatch(received.at(-1)!.content.text, /响|震/);
  assert.equal(notify.unreadCount(keyA), 5, "channel previews are not full-message reads");
  focused = true; await incoming("visible-silent"); assert.equal(received.at(-1)!.wake, false);
  assert.ok(received.at(-1)!.content.text.includes("原文 visible-silent")); assert.equal(notify.unreadCount(keyA), 5);
  await notify.setMode("off"); await incoming("visible-off");
  assert.ok(received.at(-1)!.content.text.includes("原文 visible-off")); assert.equal(notify.unreadCount(keyA), 5, "currently visible messages stay readable with notifications off");
  accepted = false; await incoming("world-stopped"); assert.equal(notify.unreadCount(keyA), 6, "dropped/inactive delivery does not mark messages read");
  accepted = true; focused = false;
  const beforeOff = received.length; await incoming("off-hidden"); assert.equal(received.length, beforeOff); assert.equal(notify.unreadCount(keyA), 7);
  await notify.setMode("vibrate"); focused = true;
  const render = renderer.render;
  renderer.render = async (text: string) => { phone.physical = { reachable: false, location: "走廊外", usable: true, perceptible: false }; return render(text); };
  await incoming("lost-while-rendering"); assert.equal(received.length, beforeOff); assert.equal(notify.unreadCount(keyA), 8, "media/name await rechecks physical perceptibility before delivery");
  renderer.render = render; phone.physical = { reachable: true, location: "桌上", usable: true, perceptible: true }; phone.down = false;
  const messenger = new KoishiMessenger(ctx, store, renderer, {} as any, {} as any, {} as any, null, focus, notify, cfg.platformOps, messaging, {} as any, new OwnSendTracker(), names, () => null);
  const read = await messenger.channelMessages(keyA, 2, { intro: "echo" });
  assert.ok(read.text.includes("lost-while-rendering")); assert.equal(notify.unreadCount(keyA), 6, "reading two actual rows clears only those rows");
  await messenger.channelMessages(keyA, 2, { intro: "echo" }); assert.equal(notify.unreadCount(keyA), 6, "reading the same page does not clear older unread rows");
  focused = false;
  await notify.setApp("chat", false);
  let before = received.length, unread = notify.unreadCount(keyA);
  await incoming("chat-app-disabled");
  assert.equal(received.length, before); assert.equal(notify.unreadCount(keyA), unread + 1);
  focused = true; await incoming("visible-chat-app-disabled");
  assert.equal(received.length, before + 1); assert.equal(received.at(-1)!.wake, false);
  assert.match(received.at(-1)!.content.text, /原文 visible-chat-app-disabled/);
  assert.equal(notify.unreadCount(keyA), unread + 1, "app-level DND does not hide an already visible conversation");
  focused = false; await notify.setApp("chat", true);
  await notify.setApp("chat", undefined, 60);
  before = received.length;
  const serialize = gateway.serializeElements.bind(gateway);
  gateway.serializeElements = async (...args: unknown[]) => { const text = await serialize(...args); worldNow = 1; return text; };
  await incoming("mute-expires-during-media");
  assert.equal(received.length, before, "a message received while muted is not newly notified when media processing outlasts the mute");
  assert.equal(notify.snapshot().channels.find(item => item.key === keyA)!.latest!.preview, "原文 mute-expires-during-media");
  gateway.serializeElements = serialize;
  await incoming("after-mute-expiry"); assert.equal(received.length, before + 1, "new messages notify normally after expiry");
  before = received.length;
  renderer.render = async (text: string) => { await notify.setApp("chat", false); return render(text); };
  messaging.notifyPolicy = "content";
  await incoming("app-disabled-during-render");
  assert.equal(received.length, before, "app notification permission is rechecked after async rendering");
  renderer.render = render;
  let registered = 0;
  gateway.requests = { add: (request: unknown) => { registered++; return { ...(request as object), id: "request-1" }; } };
  await gateway.handleRequestEvent({ platform: "fixture", selfId: "a", userId: "friend", username: "朋友", content: "申请" }, "friend");
  assert.equal(registered, 1); assert.equal(received.length, before, "app-muted friend requests remain registered without a notification");
  unread = notify.unreadCount(keyA);
  await gateway.handlePoke({ type: "notice", platform: "fixture", selfId: "a", bot: ctx.bots[0], onebot: {
    notice_type: "notify", sub_type: "poke", user_id: "friend", target_id: "a", group_id: "group" } });
  assert.equal(received.length, before); assert.equal(notify.unreadCount(keyA), unread + 1, "app-muted pokes retain unread without notifying");
  await notify.setApp("chat", true);
  phone.down = true;
  await notify.set(keyA, undefined, 120);
  before = received.length; await incoming("timed-channel-phone-down");
  assert.equal(received.length, before, "timed channel DND also blocks anonymous vibrations");
  worldNow = 3;
  await incoming("timed-channel-expired-phone-down");
  assert.equal(received.length, before + 1); assert.match(received.at(-1)!.content.text, /震/);
  await notify.setApp("chat", undefined, 60);
  const release: { run?: () => void } = {};
  gateway.messageTails.set(keyA, new Promise<void>(resolve => { release.run = resolve; }));
  before = received.length;
  handlers.get("message")!({ platform: "fixture", selfId: "a", bot: ctx.bots[0], channelId: "group", guildId: "group", userId: "friend", username: "朋友",
    timestamp: Date.now(), isDirect: false, messageId: "muted-in-queue", elements: [h.text("排队消息")] });
  const queued = gateway.messageTails.get(keyA);
  worldNow = 4; release.run!(); await queued;
  assert.equal(received.length, before, "a message queued during DND is not notified when it reaches the handler after expiry");
  console.log("PASS actual gateway/messenger: physical phone, silent/off/visible semantics, inactive delivery, async visibility race and exact history read acknowledgement");
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-phone-notifications-"));
  try { await ledger(dir); await delivery(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
