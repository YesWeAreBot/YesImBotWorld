/** Real memory database; clocks, transport, media and history are local controlled fixtures. */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { App, Bot, Universal, h } from "koishi";
import memory from "@koishijs/plugin-database-memory";
import { Config } from "../src/config.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { orderBetween, formatMessageTime } from "../src/koishi/message-order.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { Gateway } from "../src/koishi/gateway.js";
import { NotifyManager } from "../src/koishi/notify.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";

class LocalBot extends Bot {
  dispose() { if (this.ctx.bots) return super.dispose(); }
  constructor(ctx: App) { super(ctx, {}); this.platform = "onebot"; this.selfId = "account"; this.status = Universal.Status.ONLINE; }
}
const row = (id: string, time: number, extra: Partial<WorldMessageRow> = {}): Omit<WorldMessageRow, "id"> => ({
  platform: "onebot", selfId: "account", channelId: "group", guildId: "group", userId: "peer", username: "朋友", content: id,
  timestamp: new Date(time), timestampSource: "platform", self: false, messageId: id, isDirect: false, ...extra,
});
async function main() {
  const app = new App(); app.plugin((memory as any).default ?? memory); app.plugin(LocalBot); await app.start();
  const dir = await mkdtemp(path.join(tmpdir(), "message-order-"));
  try {
    const bot = app.bots[0]!, cfg = Config({ autoStart: false });
    const store = new MessageStore(app);
    // Simulate pre-upgrade rows. Only the additive model is initialized; no store query yet.
    await app.database.create("yesimbot_world_message", row("old-self", 120000, { self: true, userId: "account", senderOrigin: "tool" }));
    await app.database.create("yesimbot_world_message", row("old-reply", 15000));
    await app.database.create("yesimbot_world_message", row("old-import", 10000, { senderOrigin: "unknown" }));
    const legacy = await store.channelMessages("onebot", "group", 20, "account");
    assert.deepEqual(legacy.map(x => x.messageId), ["old-import", "old-self", "old-reply"]);
    assert.equal(legacy[1]!.timestamp.getTime(), 120000); assert.equal(legacy[1]!.observedAt, null);
    assert.match(formatMessageTime(legacy[1]!), /接收次序未记录/);
    assert.match(formatMessageTime(legacy[0]!), /先后未确认/);

    // Reserve before media/profile work. Deliberately persist in the opposite order.
    const first = store.captureLive(new Date(200000)), sent = store.captureReceipt("onebot", "group", "account", "sent", new Date(200010)), reply = store.captureLive(new Date(200020));
    const replyRow = await store.store(row("reply", 95000), reply);
    await store.store(row("sent", 200010, { self: true, userId: "account", senderOrigin: "tool", timestampSource: "local-confirmed" }), sent);
    await store.store(row("slow-image", 95000), first);
    assert.deepEqual((await store.channelMessages("onebot", "group", 3, "account")).map(x => x.messageId), ["slow-image", "sent", "reply"]);
    assert.equal((await store.channelMessages("onebot", "group", 1, "account"))[0]!.messageId, "reply");
    assert.equal((await store.recentChannels(1))[0]!.latest.messageId, "reply");
    assert.match(formatMessageTime(replyRow), /平台时间.*本机接收/);
    assert.equal((await store.captureReceipt("onebot", "group", "account", "sent").key), await sent.key, "transport capture and own bookkeeping reuse the confirmation slot");
    // Live key width remains bounded for a busy deployment, without a clock guess.
    for (let i = 0; i < 5000; i++) assert.equal((await store.captureLive().key).length, 25);

    const fence = store.captureLive();
    await store.store(row("during-history", 97000));
    const historyRows = [row("reply", 95000), row("missed-1", 95000, { platformSequence: "11" }), row("missed-2", 90000, { platformSequence: "12" })];
    assert.equal(await store.importHistory(historyRows, fence), 2);
    assert.deepEqual((await store.channelMessages("onebot", "group", 4, "account")).map(x => x.messageId), ["reply", "missed-1", "missed-2", "during-history"]);
    await store.importHistory([row("reply", 95000), row("missed-3", 90000, { platformSequence: "13" })], store.captureLive());
    const repeated = await store.channelMessages("onebot", "group", 5, "account");
    assert.deepEqual(repeated.map(x => x.messageId), ["reply", "missed-1", "missed-2", "missed-3", "during-history"], "previous imported platform sequence constrains a later page even when those rows are absent from that page");
    const noAnchor = store.captureLive();
    await store.importHistory([row("ancient-late", 9999999999999)], noAnchor);
    assert.equal((await store.channelMessages("onebot", "group", 1, "account"))[0]!.messageId, "during-history", "a late import with no causal anchor must not displace live activity, even if its clock is in the future");
    assert.equal((await store.findByMessageId("onebot", "group", "ancient-late", "account"))!.orderSource, "history-unanchored");
    await store.importHistory([row("unknown-time-a", 100), row("unknown-time-b", 100)], store.captureLive());
    await store.importHistory([row("unknown-time-c", 100)], store.captureLive());
    const unknowns = await Promise.all(["unknown-time-a", "unknown-time-b", "unknown-time-c"].map(id => store.findByMessageId("onebot", "group", id, "account")));
    assert.equal(new Set(unknowns.map(x => x!.timelineKey)).size, 3, "same-time history without sequence gets distinct stable slots, without claiming known chronology");
    const front = await store.store(row("front-anchor", 1, { channelId: "fence-group" }));
    const strictFence = store.captureLive();
    await store.store(row("live-between", 1, { channelId: "fence-group" }));
    await store.store(row("late-anchor", 1, { channelId: "fence-group" }));
    await store.importHistory([front, ...[1, 2, 3].map(n => row(`before-fence-${n}`, 1, { channelId: "fence-group" })), row("late-anchor", 1, { channelId: "fence-group" })], strictFence);
    const fenced = await store.channelMessages("onebot", "fence-group", 20, "account");
    assert.deepEqual(fenced.map(x => x.messageId), ["front-anchor", "before-fence-1", "before-fence-2", "before-fence-3", "live-between", "late-anchor"]);
    assert.equal(new Set(fenced.map(x => x.timelineKey)).size, fenced.length, "history cannot collide with an unmatched local row");
    for (const entry of fenced.filter(x => x.orderSource === "history")) assert.ok(entry.timelineKey! < await strictFence.key, "a newly observed following anchor cannot move history across the original fetch fence");
    const restarted = new MessageStore(app);
    await restarted.store(row("after-restart", 1));
    assert.equal((await restarted.channelMessages("onebot", "group", 1, "account"))[0]!.messageId, "after-restart");

    const notify = new NotifyManager(path.join(dir, "notify.json"), ["*"], true); await notify.load();
    const key = "onebot@account:group";
    await notify.set("onebot:group", false); assert.equal(notify.isNotifyChannel(key), false);
    await notify.set(key, true); assert.equal(notify.isNotifyChannel(key), true, "explicit enable overrides legacy wildcard exception");
    await Promise.all([notify.set(key, false), notify.set(key, true), notify.set(key, false)]);
    assert.equal(notify.isNotifyChannel(key), false); assert.ok(JSON.parse(await readFile(path.join(dir, "notify.json"), "utf8")).deny.includes(key));
    const failure = new NotifyManager(path.join(dir, "missing", "notify.json"), ["*"], true);
    await assert.rejects(failure.set(key, false)); assert.equal(failure.isNotifyChannel(key), true);
    assert.match(notify.channelStatusText(key), /频道通知：免打扰；未读 0 条/, "status exposes actual policy/count; focus and delivery behavior are verified below");

    const phone = { down: false }, focus = { isFocused: () => true, focus: async () => {} };
    const names: any = { display: async () => "测试群", identity: async () => ({ platform: "onebot", channelId: "group", selfId: "account", accountIds: ["account"], displayName: "群名片", text: "你的群名片：群名片" }) };
    const renderer: any = { render: async (text: string) => ({ text }) };
    const delivered: { value: any; wake: boolean }[] = [];
    const gateway: any = new Gateway(app, { ...cfg.messaging, externalSelfMessages: "off", wakeOnNotify: true }, cfg.platformOps, restarted, {} as any, renderer, focus as any, notify, phone, {} as any, new OwnSendTracker(), names, () => null,
      { notify(value, wake) { delivered.push({ value, wake }); }, channelActivity() {}, selfMessage() {} });
    let serial = 0;
    const receive = () => gateway.handle({ bot, platform: "onebot", selfId: "account", channelId: "group", guildId: "group", userId: "peer", username: "朋友", messageId: `notify-${++serial}`, timestamp: 1000, elements: h.parse("真实正文"), isDirect: false });
    await receive(); assert.equal(delivered.at(-1)!.wake, false); assert.match(delivered.at(-1)!.value.text, /真实正文/);
    assert.equal(delivered.at(-1)!.value.experience.chat.kind, "message");
    phone.down = true; const before = delivered.length; await receive(); assert.equal(delivered.length, before, "muted phone does not vibrate even if stale focus remains");
    await notify.set(key, true); await receive(); assert.equal(delivered.at(-1)!.wake, true); assert.match(delivered.at(-1)!.value.text, /震了一下/); assert.equal(delivered.at(-1)!.value.experience.chat, undefined);

    // Every channel interaction uses the same delivery boundary, including after awaits.
    const poke = { bot, platform: "onebot", selfId: "account", type: "notice", onebot: { sub_type: "poke", user_id: "peer", target_id: "account", group_id: "group" } };
    const ban = { bot, platform: "onebot", selfId: "account", onebot: { notice_type: "group_ban", group_id: "group", user_id: "account", operator_id: "admin", duration: 60 } };
    await notify.set(key, false);
    const eventStart = delivered.length; await gateway.handlePoke(poke); await gateway.handleGroupBan(ban);
    assert.equal(delivered.length, eventStart, "DND applies to hidden poke/ban events as well as messages");
    phone.down = false; await gateway.handlePoke(poke); assert.equal(delivered.at(-1)!.wake, false); assert.equal(delivered.at(-1)!.value.experience.chat.kind, "notice");
    await gateway.handleGroupBan(ban); assert.equal(delivered.at(-1)!.wake, false);
    await gateway.handleRecall({ bot, platform: "onebot", selfId: "account", channelId: "group", messageId: "reply", userId: "peer", isDirect: false, onebot: { operator_id: "peer" } });
    assert.equal(delivered.at(-1)!.wake, false);
    await notify.set(key, true);
    let releaseName!: () => void, startedName!: () => void;
    const nameWait = new Promise<void>(resolve => { releaseName = resolve; }), nameStarted = new Promise<void>(resolve => { startedName = resolve; });
    const oldLookup = gateway.lookupUsername; gateway.lookupUsername = async () => { startedName(); await nameWait; return "朋友"; };
    const delayedPoke = gateway.handlePoke(poke); await nameStarted;
    phone.down = true; releaseName(); await delayedPoke; gateway.lookupUsername = oldLookup;
    assert.match(delivered.at(-1)!.value.text, /震了一下/); assert.equal(delivered.at(-1)!.value.experience.chat, undefined);

    // A validated self echo can precede the transport promise settling and a peer reply.
    // Reserve its observed slot, then only persist the own message after confirmation.
    const echoTicket = gateway.captureSessionTicket({ bot, platform: "onebot", selfId: "account", channelId: "echo-group", messageId: "early-self-echo", userId: "account" });
    await restarted.store(row("fast-peer-reply", 100, { channelId: "echo-group" }));
    const confirmedTicket = restarted.captureReceipt("onebot", "echo-group", "account", "early-self-echo", new Date(300000));
    assert.equal(await confirmedTicket.key, await echoTicket.key);
    await restarted.store(row("early-self-echo", 300000, { channelId: "echo-group", self: true, userId: "account", timestampSource: "local-confirmed" }), confirmedTicket);
    assert.deepEqual((await restarted.channelMessages("onebot", "echo-group", 2, "account")).map(x => x.messageId), ["early-self-echo", "fast-peer-reply"]);
    assert.equal((await restarted.findByMessageId("onebot", "echo-group", "early-self-echo", "account"))!.timestamp.getTime(), 300000, "earlier observation must not falsify the later actual confirmation clock");

    // Actual syncGroupHistory accepts platform clocks ahead/behind host and uses ID overlap.
    const messenger: any = new KoishiMessenger(app, restarted, renderer, {} as any, {} as any, {} as any, null, focus as any, notify, cfg.platformOps, cfg.messaging, {} as any, new OwnSendTracker(), names, () => null);
    (bot as any).internal = { _request: async () => ({ messages: [
      { message_id: "after-restart", message_seq: 100, time: 1, sender: { user_id: "peer" }, message: "anchor" },
      { message_id: "future-platform", message_seq: 101, time: 9999999999, sender: { user_id: "peer" }, message: "not discarded for clock skew" },
    ] }) };
    assert.equal(await messenger.syncGroupHistory("onebot", "group", "account"), 1);
    assert.equal((await restarted.findByMessageId("onebot", "group", "future-platform", "account"))!.timestamp.getTime(), 9999999999000);
    assert.equal(await messenger.syncGroupHistory("onebot", "group", "account"), 0);
    const screen = await messenger.channelMessages(key, 20);
    assert.equal(screen.experience.chat.kind, "attention"); assert.match(screen.text, /不能按显示时间重新推断先后/);
    assert.equal((await messenger.recentChannels(5)).experience.chat, undefined, "channel list is not attention to its first preview");

    let left = "5", right = "6";
    for (let i = 0; i < 200; i++) { const key = orderBetween(left, right); assert.ok(left < key && key < right); assert.match(key, /^\d*[1-9]$/); left = key; }
    console.log("PASS independent receive/confirm order, skewed/same-second clocks, delayed persistence, legacy migration/restart, bounded keys, anchored/unanchored history, ID overlap, real-time labels, DND persistence and focus/privacy semantics");
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
