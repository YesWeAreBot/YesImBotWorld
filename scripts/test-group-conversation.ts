/** Actual inbound -> storage/history -> Bot multimodal request. Entirely local, no chat or LLM service. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { Prompts } from "../src/prompts.js";
import { BotContext } from "../src/bot/context.js";
import { BotAgent } from "../src/bot/agent.js";
import { Gateway } from "../src/koishi/gateway.js";
import { KoishiMessenger, rawGroupConversation } from "../src/koishi/messenger.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { conversationKind } from "../src/koishi/conversation.js";
import { MediaRenderer } from "../src/media/render.js";
import type { RichText } from "../src/types.js";

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-group-conversation-"));
  try {
    const cfg = Config({ autoStart: false });
    const rows: WorldMessageRow[] = [];
    const ctx: any = {
      bots: [{ platform: "fixture", selfId: "bot-a", isActive: true }, { platform: "fixture", selfId: "bot-b", isActive: true }],
      on() {}, model: { extend() {} }, logger: () => ({ warn() {} }),
      database: {
        async create(_table: string, row: any) { const next = { id: rows.length + 1, ...row }; rows.push(next); return next; },
        async get(_table: string, query: Record<string, any>, options: any) {
          return rows.filter((row: any) => Object.entries(query).every(([key, value]) => value && typeof value === "object" ? value.$in.includes(row[key]) : row[key] === value))
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, options?.limit);
        },
      },
    };
    const store = new MessageStore(ctx);
    const mediaRows = new Map<number, any>();
    const media: any = {
      async ingest(_src: string, type: string, _mime: string, _unused: unknown, sticker: boolean) {
        const id = mediaRows.size + 1;
        mediaRows.set(id, { ref: { id, type, mime: "image/png", file: "fixture.png" }, sticker });
        return id;
      },
      async get(id: number) { return mediaRows.get(id); },
    };
    let focused = true, allowed = true;
    const focus: any = { isFocused: () => focused, focus: async () => {} };
    const notify: any = { isNotifyChannel: () => allowed };
    const phone = { down: false };
    const names: any = { display: async (key: string) => "朋友群 / " + key };
    const renderer = new MediaRenderer(media, { describe: async () => "一张用于表达情绪的图" } as any, () => true, 4);
    const messaging = { ...cfg.messaging, externalSelfMessages: "off" as const, notifyPolicy: "content" as const, wakeOnNotify: false };
    const received: { value: RichText; wake: boolean }[] = [];
    let activities = 0;
    const gateway: any = new Gateway(ctx, messaging, cfg.platformOps, store, media, renderer, focus, notify, phone, {} as any, new OwnSendTracker(), names, () => null, {
      notify(value, wake) { received.push({ value, wake }); }, selfMessage() {}, channelActivity() { activities++; },
    });
    const base: any = { platform: "fixture", selfId: "bot-a", bot: ctx.bots[0], channelId: "group", guildId: "guild", userId: "alice", username: "小明", isDirect: false };
    let seq = 0;
    async function incoming(elements: h[], extra: any = {}) {
      await gateway.handle({ ...base, timestamp: Date.now() + ++seq, messageId: "m" + seq, elements, ...extra });
      return received.at(-1)!.value;
    }
    const sticker = h("img", { src: "fixture:never-fetched", sub_type: 1 });
    const plainSticker = await incoming([sticker]);
    assert.equal(received.at(-1)!.wake, true, "focused messages retain configured observation/wake behavior");
    assert.deepEqual(rows.at(-1)!.conversation, { kind: "group", mentions: [], mentionsEveryone: false, hasText: false, media: ["sticker"] });

    const files = new WorldFiles(path.join(dir, "world")); await files.ensure();
    const prompts = new Prompts({ bot: { constitution: "已有用户覆盖保持不变" }, world: {} });
    const context = new BotContext(files, "", prompts); await context.load();
    context.attachmentLoader = async () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
    async function requestParts(value: RichText, attachments = true) {
      context.stream = [];
      context.attachmentsDisabled = !attachments;
      await context.appendEvent({ id: "ev-" + seq, source: "phone" as any, worldTime: seq, content: value.text, parts: value.parts, attachments: value.attachments });
      const messages = await context.toChatMessages("T=1");
      const content = messages.at(-1)!.content;
      return typeof content === "string" ? [{ type: "text", text: content }] : content;
    }
    const parts = await requestParts(plainSticker);
    assert.equal(parts[1]!.type, "image_url", "image remains immediately after its sender and conversation header");
    assert.match((parts[0] as any).text, /朋友群.*群聊.*无明确 @.*仅含表情包.*小明.*alice/s);
    assert.match(context.renderSystemText("T=1"), /已有用户覆盖保持不变/);
    assert.match(context.renderSystemText("T=1"), /群聊是多人共享的场合/);
    assert.match(JSON.stringify(await requestParts(plainSticker, false)), /朋友群.*小明/s);
    // Exercise the real forwarding dispatch branch while replacing only scheduling and the platform fetch.
    let forwarded: RichText | undefined;
    const forwardingAgent: any = Object.assign(Object.create(BotAgent.prototype), {
      phoneUi: { forwardStack: [] },
      messenger: { viewForward: async () => plainSticker },
      dispatchLocal: async (_call: unknown, run: () => Promise<RichText>) => { forwarded = await run(); },
    });
    for (let depth = 1; depth <= 2; depth++) {
      await forwardingAgent.dispatch({ id: "forward-" + depth, role: "system", name: "view_forward", arguments: { id: "fixture-forward" } });
      const renderedForward = JSON.stringify(await requestParts(forwarded!));
      assert.match(renderedForward, /不是.*当前聊天/s);
      assert.match(renderedForward, /exit_forward/);
      assert.equal(forwardingAgent.phoneUi.forwardStack.length, depth);
    }

    await incoming([h("at", { id: "bob" }), h.text("你觉得呢？")]);
    assert.deepEqual(rows.at(-1)!.conversation!.mentions, ["bob"]);
    assert.match(received.at(-1)!.value.text, /@ 其他账号 "bob"/);
    assert.doesNotMatch(received.at(-1)!.value.text, /明确 @ 本账号/);
    await incoming([h("at", { id: "bot-a" }), h.text("你觉得呢？")]);
    assert.match(received.at(-1)!.value.text, /明确 @ 本账号/);
    await incoming([h("at", { type: "all" }), h.text("晚上集合")]);
    assert.match(received.at(-1)!.value.text, /@ 全体，不是单独找你/);

    await store.store({ ...base, userId: "bob", self: false, content: "谁一起去？", timestamp: new Date(), messageId: "q1" });
    await incoming([h.text("我也去")], { quote: { id: "q1" } });
    assert.equal(rows.at(-1)!.conversation!.reply!.userId, "bob");
    assert.match(received.at(-1)!.value.text, /引用其他账号 "bob"/);
    await store.store({ ...base, userId: "bot-a", self: true, content: "谁一起去？", timestamp: new Date(), messageId: "q2" });
    await incoming([h.text("我也去")], { quote: { id: "q2" } });
    assert.match(received.at(-1)!.value.text, /引用本账号/);
    await store.store({ ...base, selfId: "bot-b", userId: "bot-a", self: false, content: "隔离账号", timestamp: new Date(), messageId: "other-account-only" });
    await incoming([h.text("我也去")], { quote: { id: "other-account-only" } });
    assert.equal(rows.at(-1)!.conversation!.reply!.userId, undefined, "quote lookup cannot cross Bot accounts");
    assert.match(received.at(-1)!.value.text, /原作者未知/);
    await incoming([h("quote", { id: "q1" }, [h("at", { id: "bot-a" })]), h.text("哈哈")]);
    assert.deepEqual(rows.at(-1)!.conversation!.mentions, [], "mentions inside quoted text do not address the outer message");
    await incoming([h("forward", { id: "f1" }, [h("at", { id: "bot-a" })])]);
    assert.deepEqual(rows.at(-1)!.conversation!.mentions, [], "forwarded mentions do not address the Bot");

    // isDirect is authoritative even when the platform uses numeric channel ids or includes guild metadata.
    await incoming([h.text("今天好吗")], { isDirect: true, channelId: "12345" });
    assert.equal(rows.at(-1)!.conversation!.kind, "direct");
    assert.match(received.at(-1)!.value.text, /私聊/);
    assert.equal(conversationKind(undefined, "12345", ""), "unknown");
    assert.deepEqual(rawGroupConversation([
      { type: "at", data: { qq: "bob" } }, { type: "reply", data: { id: "quoted" } },
      { type: "image", data: { sub_type: 1 } }, { type: "forward", data: { content: [{ type: "at", data: { qq: "bot-a" } }] } },
    ]), { kind: "group", mentions: ["bob"], mentionsEveryone: false, hasText: false, media: ["sticker", "forward"], reply: { messageId: "quoted" } });

    focused = false;
    const popup = await incoming([sticker]);
    assert.match(JSON.stringify(await requestParts(popup)), /朋友群.*群聊.*小明.*alice/s);
    assert.equal(received.at(-1)!.wake, false, "notification wake policy unchanged");
    messaging.notifyPolicy = "count" as any;
    await incoming([h("at", { id: "bot-a" }), sticker]);
    assert.equal(received.at(-1)!.value.text, "手机响了一下：收到一条新消息。", "count policy does not leak identity/content");
    messaging.notifyPolicy = "content";
    phone.down = true;
    await incoming([h("at", { id: "bot-a" }), sticker]);
    assert.equal(received.at(-1)!.value.text, "放在一边的手机震了一下。", "put-down phone does not expose message context");
    phone.down = false; allowed = false;
    const before = received.length;
    await incoming([h("at", { id: "bot-a" }), h.text("看这里")]);
    assert.equal(received.length, before, "explicit @ never bypasses notification restrictions");
    assert.equal(activities, seq, "all messages still record channel activity");

    const messenger = new KoishiMessenger(ctx, store, renderer, media, {} as any, {} as any, null, focus, notify, cfg.platformOps, messaging, {} as any, new OwnSendTracker(), names, () => null);
    await store.store({ ...base, userId: "bot-a", self: true, content: "已发出的消息", timestamp: new Date(Date.now() + 1000), messageId: "last-self" });
    const history = await messenger.channelMessages("fixture@bot-a:group", 50);
    const historyParts = await requestParts(history);
    const full = JSON.stringify(historyParts);
    assert.match(full, /朋友群.*这是多人对话/s);
    assert.match(full, /明确 @ 本账号/);
    assert.match(full, /引用其他账号/);
    assert.match(full, /最后一条来自本账号/);
    assert.ok(!full.includes("隔离账号"));
    const allText = history.parts!.filter(p => p.kind === "text").map(p => p.text).join("");
    assert.equal(allText, history.text, "history prose and ordered media parts preserve identical contextual framing");
    console.log("PASS group conversation: sender/channel retained in actual multimodal requests, scoped quote attribution, mentions/DM/stickers, history framing and notification privacy");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
