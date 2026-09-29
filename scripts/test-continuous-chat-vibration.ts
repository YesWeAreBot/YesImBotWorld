/** Continuous incoming messages reach the notification callback without a one-shot latch. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { Gateway } from "../src/koishi/gateway.js";
import { NotifyManager } from "../src/koishi/notify.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { ChannelNameResolver } from "../src/koishi/names.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import type { RichText, PhoneStatus } from "../src/types.js";

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-continuous-vibration-"));
  try {
    const cfg = Config({ autoStart: false }), rows: WorldMessageRow[] = [], delivered: { content: RichText; wake: boolean }[] = [];
    const handlers = new Map<string, (session: any) => void>();
    const bot = { platform: "fixture", selfId: "account", isActive: true };
    const ctx: any = { bots: [bot], on(name: string, fn: (session: any) => void) { handlers.set(name, fn); }, model: { extend() {} }, logger: () => ({ warn() {} }), database: {
      async create(_table: string, row: any) { const saved = { id: rows.length + 1, ...row }; rows.push(saved); return saved; },
      async get(_table: string, query: any, options: any) {
        return rows.filter((row: any) => Object.entries(query).every(([key, value]: [string, any]) => value && typeof value === "object" ? value.$in.includes(row[key]) : row[key] === value))
          .sort((a, b) => String(b.timelineKey ?? "").localeCompare(String(a.timelineKey ?? "")) || b.id - a.id).slice(0, options?.limit);
      },
    } };
    const store = new MessageStore(ctx), notify = new NotifyManager(path.join(dir, "notify.json"), ["*"], true);
    await notify.load();
    const phone: PhoneStatus = { down: true }, names = new ChannelNameResolver(ctx, store);
    let accept = true;
    const gateway: any = new Gateway(ctx, { ...cfg.messaging, wakeOnNotify: true, externalSelfMessages: "off" }, cfg.platformOps, store,
      {} as any, { render: async (text: string) => ({ text }) } as any, { isFocused: () => true } as any, notify, phone,
      {} as any, new OwnSendTracker(), names, () => null,
      { notify(content, wake) { delivered.push({ content, wake }); return accept; }, channelActivity() {}, selfMessage() {} });
    function emit(messageId: string, channelId = "group") {
      handlers.get("message")!({ platform: bot.platform, selfId: bot.selfId, bot, channelId, guildId: channelId,
        userId: "peer", username: "朋友", messageId, isDirect: false, timestamp: 1700000000000, elements: [h.text("相同正文")] });
    }
    async function drain() { await Promise.all([...gateway.messageTails.values()]); }
    for (let index = 0; index < 8; index++) emit("message-" + index);
    await drain();
    assert.equal(rows.length, 8); assert.equal(notify.snapshot().unread, 8); assert.equal(notify.snapshot().count, 8);
    assert.equal(delivered.length, 8, "every newly identified message emits a vibration, even with identical content and platform timestamps");
    assert.ok(delivered.every(item => item.content.text === "手机震了一下。" && item.wake));
    assert.equal(new Set(delivered.map(item => item.content.originEventIds?.[0])).size, 8, "identical vibration text has distinct opaque message-derived evidence roots");
    assert.ok(delivered.every(item => item.content.originEventIds?.[0]?.startsWith("chat-notice:")));
    assert.ok(delivered.every(item => !item.content.experience?.chat && !item.content.experience?.subjectIds), "anonymous cues do not expose the account/channel/sender");
    assert.equal(new Set(delivered.map(item => item.content.experience?.episodeId)).size, 1, "episode grouping is not used as a per-message notification deduplicator");
    emit("message-0"); await drain(); assert.equal(delivered.length, 8, "a platform echo of the same message id is deduplicated");
    emit("message-0", "other-group"); await drain(); assert.equal(delivered.length, 9, "the same id in another channel remains a different message");
    await notify.clearNotifications(); await notify.markRead();
    emit("after-clear"); await drain(); assert.equal(delivered.length, 10, "notification/card housekeeping creates no suppression latch");
    accept = false; emit("rejected-by-recipient"); await drain();
    accept = true; emit("after-rejected-recipient"); await drain();
    assert.equal(delivered.length, 12, "a callback rejection cannot permanently suppress later gateway delivery");
    await notify.setApp("chat", false); emit("app-disabled"); await drain(); assert.equal(delivered.length, 12);
    await notify.setApp("chat", true); emit("app-restored"); await drain(); assert.equal(delivered.length, 13);
    phone.physical = { reachable: false, usable: true, perceptible: false, location: "隔壁" };
    emit("unperceivable"); await drain(); assert.equal(delivered.length, 13);
    phone.physical.perceptible = true; emit("perceivable-again"); await drain(); assert.equal(delivered.length, 14, "physical visibility gating is stateful but has no one-shot notification limit");
    emit(""); emit(""); await drain(); assert.equal(delivered.length, 16, "platforms without message ids use independent stored-row identities");
    console.log("PASS continuous chat vibration: all consecutive arrivals emitted, distinct roots despite identical cues, scoped ID dedup, housekeeping/rejection recovery and explicit policy/physical boundaries");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
