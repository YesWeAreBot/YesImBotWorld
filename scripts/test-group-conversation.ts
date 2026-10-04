import { ChannelNameResolver } from "../src/koishi/names.js";
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
import { collectOpportunities } from "../src/bot/opportunities.js";
import { explicitlyAddressesOthers, explicitlyAddressesSelf } from "../src/bot/chat-attention.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Gateway } from "../src/koishi/gateway.js";
import { KoishiMessenger, rawGroupConversation } from "../src/koishi/messenger.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { chatMessageEvidence, conversationKind, conversationLabel, describeConversation, isStickerElement } from "../src/koishi/conversation.js";
import { MediaRenderer } from "../src/media/render.js";
import { richPartsText } from "../src/media/presentation.js";
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
            .sort((a, b) => (options?.sort?.timelineKey ? String(b.timelineKey ?? "").localeCompare(String(a.timelineKey ?? "")) : 0) || b.timestamp.getTime() - a.timestamp.getTime() || (options?.sort?.id === "desc" ? b.id - a.id : a.id - b.id)).slice(0, options?.limit);
        },
      },
    };
    const store = new MessageStore(ctx);
    const mediaRows = new Map<number, any>();
    const mediaBySource = new Map<string, number>();
    const media: any = {
      async ingest(_src: string, type: string, _mime: string, _unused: unknown, sticker: boolean) {
        const prior = mediaBySource.get(_src);
        if (prior !== undefined) { mediaRows.get(prior).sticker ||= sticker; return prior; }
        const id = mediaRows.size + 1;
        mediaRows.set(id, { ref: { id, type, mime: "image/png", file: "fixture.png" }, sticker });
        mediaBySource.set(_src, id);
        return id;
      },
      async get(id: number) { return mediaRows.get(id); },
    };
    let focused = true, allowed = true;
    const focus: any = { isFocused: () => focused, focus: async () => {} };
    const notify: any = { isNotifyChannel: () => allowed, channelStatusText: () => allowed ? "频道通知：开启" : "频道通知：免打扰" };
    const phone = { down: false };
    const names = Object.assign(new ChannelNameResolver(ctx, store), { display: async (key: string) => "朋友群 / " + key });
    const renderer = new MediaRenderer(media, { describe: async () => "猫的简笔画，没有文字" } as any, () => true, 4);
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
    assert.deepEqual(rows.at(-1)!.conversation, { kind: "group", mentions: [], mentionsEveryone: false, hasText: false, media: ["sticker"], mediaCounts: { sticker: 1 } });

    const files = new WorldFiles(path.join(dir, "world")); await files.ensure();
    const prompts = new Prompts({ bot: { constitution: "已有用户覆盖保持不变" }, world: {} });
    const context = new BotContext(files, "", prompts); await context.load();
    context.attachmentLoader = async () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
    async function requestParts(value: RichText, attachments = true) {
      // Independent projection scenarios: start a new window instead of mutating an
      // already-rendered event under the same ID (production history is immutable).
      context.stream = [];
      context.resetRenderingAfterCompression();
      context.attachmentsDisabled = !attachments;
      await context.appendEvent({ id: "ev-" + seq, source: "phone" as any, worldTime: seq, content: value.text, parts: value.parts, attachments: value.attachments });
      const messages = await context.toChatMessages("T=1");
      const content = messages.at(-1)!.content;
      return typeof content === "string" ? [{ type: "text", text: content }] : content;
    }
    const parts = await requestParts(plainSticker);
    assert.equal(parts[1]!.type, "image_url", "image remains immediately after its sender and conversation header");
    assert.match((parts[0] as any).text, /朋友群.*群聊.*无明确 @.*仅含表情包.*小明.*alice/s);
    assert.match((parts[0] as any).text, /usage="sticker"/);
    assert.match(plainSticker.text, /会话表情包（像 emoji 一样的表意符号/);
    assert.match(context.renderSystemText("T=1"), /已有用户覆盖保持不变/);
    assert.match(context.renderSystemText("T=1"), /群聊是多人共享的场合/);
    assert.match(JSON.stringify(await requestParts(plainSticker, false)), /朋友群.*小明/s);
    assert.match(JSON.stringify(await requestParts(plainSticker, false)), /usage=\\"sticker\\"/);
    assert.equal(isStickerElement(h("img", { file: "marketface" })), true);
    assert.equal(isStickerElement(h("mface", { url: "fixture:sticker" })), true);
    assert.equal(isStickerElement(h("img", { file: "vacation.gif", summary: "普通动图" })), false, "a GIF/summary is not platform evidence of sticker usage");
    assert.equal(isStickerElement(h("img", { sub_type: 0, file: "vacation.gif", summary: "[动画表情]" })), false);
    const mixedSticker = await incoming([h.text("哈哈"), sticker]);
    assert.match(mixedSticker.text, /附有表情包/);
    assert.match(mixedSticker.text, /表情与文字共同表意/);
    const paired = await incoming([h("at", { id: "bob" }), sticker, sticker, h("face", { id: "14", name: "微笑" })]);
    const pairedRow = rows.at(-1)!;
    assert.deepEqual(pairedRow.conversation!.mediaCounts, { sticker: 2, face: 1 });
    assert.match(paired.text, /@ 其他账号 "bob".*仅含表情包×2、平台表情×1.*未附文字/);
    const pairedWire = JSON.stringify(await requestParts(paired));
    assert.match(pairedWire, /聊天记录 #.*猫的简笔画/);
    assert.equal((await requestParts(paired)).filter((part: any) => part.type === "image_url").length, 2, "both occurrences preserve their actual positions inside the same message");
    assert.deepEqual(paired.parts!.filter(part => part.kind === "media").map(part => part.ref.id), [mediaBySource.get("fixture:never-fetched"), mediaBySource.get("fixture:never-fetched")]);
    assert.doesNotMatch(paired.text, /发送者.*(?:正在开心|表示已读|喜欢猫|喜欢这张|值得收藏)/, "an image of a cat does not identify the sender's feeling or conversational meaning");
    const again = await incoming([sticker], { userId: "bob", username: "小李" });
    const againRow = rows.at(-1)!;
    assert.notEqual(againRow.id, pairedRow.id);
    assert.notDeepEqual(again.originEventIds, paired.originEventIds, "identical media sent in a different platform message is a new conversational turn");
    assert.deepEqual(chatMessageEvidence(againRow).originEventIds, again.originEventIds, "rereading the same stored message has the same evidence identity");
    assert.match(again.text, new RegExp("聊天记录 #" + againRow.id));
    const deliveriesBeforeDuplicate = received.length;
    await gateway.handle({ ...base, messageId: againRow.messageId, userId: "bob", elements: [sticker] });
    assert.equal(received.length, deliveriesBeforeDuplicate, "a duplicated platform echo is not another sticker reply");
    const quotedOnly = describeConversation([h("quote", { id: "q1" }, [sticker, h("at", { id: "bot-a" }), h.text("quoted words")]), sticker], "group", isStickerElement);
    assert.deepEqual(quotedOnly.mediaCounts, { sticker: 1 });
    assert.deepEqual(quotedOnly.mentions, []);
    assert.equal(quotedOnly.hasText, false, "quoted text cannot turn a sticker-only reply into a text-plus-sticker message");
    assert.doesNotMatch(conversationLabel({ kind: "group", mentions: [], mentionsEveryone: false, hasText: false, media: ["sticker"] }), /×\d/, "unknown historical quantity remains unknown");
    const ordinary = await incoming([h("img", { src: "fixture:photo" })]);
    const ordinaryId = mediaRows.size;
    mediaRows.get(ordinaryId).sticker = true; // The same bytes may later be sent as a sticker.
    assert.doesNotMatch((await renderer.render(rows.at(-1)!.content)).text, /usage="sticker"/, "per-message plain-image use survives asset metadata becoming a known sticker");
    assert.doesNotMatch(ordinary.text, /usage="sticker"/);
    const reusedAsPlain = await incoming([h("img", { src: "fixture:never-fetched", sub_type: 0, file: "cute-cat.gif" })]);
    assert.equal(reusedAsPlain.parts!.find(part => part.kind === "media")!.ref.id, mediaBySource.get("fixture:never-fetched"));
    assert.match(reusedAsPlain.text, /仅含图片×1/);
    assert.doesNotMatch(JSON.stringify(await requestParts(reusedAsPlain)), /usage=\\"sticker\\"/);
    assert.match(JSON.stringify(await requestParts(plainSticker)), /usage=\\"sticker\\"/, "an earlier sticker occurrence keeps its own usage after the same asset is used as a normal image");

    // Exercise the real forwarding dispatch branch while replacing only scheduling and the platform fetch.
    let forwarded: RichText | undefined;
    const forwardingAgent: any = Object.assign(new BotAgent(cfg,
      { now: () => seq, timeLine: () => "T=1", realMsUntil: () => 0 } as any,
      files, context, {} as any, { viewForward: async () => plainSticker } as any,
      null, null, null, phone, { info() {}, warn() {}, error() {}, debug() {} } as any,
      BOT_TOOLS.filter(tool => ["view_forward", "exit_forward"].includes(tool.name))), {
      phoneUi: { chatOpen: true, channelKey: "fixture@bot-a:group", channelIsGroup: true, forwardStack: [] },
      attention: "phone",
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
    assert.equal(explicitlyAddressesOthers(received.at(-1)!.value.experience?.chat), true);
    await incoming([h("at", { id: "bot-a" }), h.text("你觉得呢？")]);
    assert.match(received.at(-1)!.value.text, /明确 @ 本账号/);
    assert.equal(explicitlyAddressesSelf(received.at(-1)!.value.experience?.chat), true);
    await incoming([h("at", { type: "all" }), h.text("晚上集合")]);
    assert.match(received.at(-1)!.value.text, /@ 全体，不是单独找你/);
    assert.equal(explicitlyAddressesSelf(received.at(-1)!.value.experience?.chat), false);

    await store.store({ ...base, userId: "bob", self: false, content: "谁一起去？", timestamp: new Date(), messageId: "q1" });
    await incoming([h.text("我也去")], { quote: { id: "q1" } });
    assert.equal(rows.at(-1)!.conversation!.reply!.userId, "bob");
    assert.match(received.at(-1)!.value.text, /引用其他账号 "bob"/);
    assert.equal(explicitlyAddressesOthers(received.at(-1)!.value.experience?.chat), true);
    assert.deepEqual(collectOpportunities([{ kind: "event", event: { id: "others-live", source: "koishi", worldTime: 1,
      content: received.at(-1)!.value.text, ...received.at(-1)!.value } }], ["read_channel", "select_channel", "send"]), [],
      "a live A-to-B quote is visible without recommending that our account read or answer it");
    await store.store({ ...base, userId: "bot-a", self: true, content: "谁一起去？", timestamp: new Date(), messageId: "q2" });
    await incoming([h.text("我也去")], { quote: { id: "q2" } });
    assert.match(received.at(-1)!.value.text, /引用本账号/);
    assert.equal(explicitlyAddressesSelf(received.at(-1)!.value.experience?.chat), true);
    await store.store({ ...base, selfId: "bot-b", userId: "bot-a", self: false, content: "隔离账号", timestamp: new Date(), messageId: "other-account-only" });
    await incoming([h.text("我也去")], { quote: { id: "other-account-only" } });
    assert.equal(rows.at(-1)!.conversation!.reply!.userId, undefined, "quote lookup cannot cross Bot accounts");
    assert.match(received.at(-1)!.value.text, /原作者未知/);
    assert.equal(explicitlyAddressesSelf(received.at(-1)!.value.experience?.chat), false);
    assert.equal(explicitlyAddressesOthers(received.at(-1)!.value.experience?.chat), false);
    await incoming([h("quote", { id: "q1" }, [h("at", { id: "bot-a" })]), h.text("哈哈")]);
    assert.deepEqual(rows.at(-1)!.conversation!.mentions, [], "mentions inside quoted text do not address the outer message");
    await incoming([h("forward", { id: "f1" }, [h("at", { id: "bot-a" })])]);
    assert.deepEqual(rows.at(-1)!.conversation!.mentions, [], "forwarded mentions do not address the Bot");

    // isDirect is authoritative even when the platform uses numeric channel ids or includes guild metadata.
    await incoming([h.text("今天好吗")], { isDirect: true, channelId: "12345" });
    assert.equal(rows.at(-1)!.conversation!.kind, "direct");
    assert.match(received.at(-1)!.value.text, /私聊/);
    assert.equal(explicitlyAddressesSelf(received.at(-1)!.value.experience?.chat), true);
    assert.equal(conversationKind(undefined, "12345", ""), "unknown");
    assert.deepEqual(rawGroupConversation([
      { type: "at", data: { qq: "bob" } }, { type: "reply", data: { id: "quoted" } },
      { type: "image", data: { sub_type: 1 } }, { type: "forward", data: { content: [{ type: "at", data: { qq: "bot-a" } }] } },
    ]), { kind: "group", mentions: ["bob"], mentionsEveryone: false, hasText: false, media: ["sticker", "forward"], mediaCounts: { sticker: 1, forward: 1 }, reply: { messageId: "quoted" } });

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
    assert.equal(received.at(-1)!.value.text, "手机震了一下。", "put-down phone does not expose message context or invent a position");
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
    assert.match(full, /最后一条来自你的连接账号/);
    assert.ok(!full.includes("隔离账号"));
    const allText = richPartsText(history.parts!);
    assert.equal(allText, history.text, "history prose and ordered media parts preserve identical contextual framing");
    assert.equal(history.experience!.chat!.senderOwn, true, "history attention retains who sent its last visible row");
    assert.equal(history.experience!.chat!.direction!.kind, "group");
    await store.store({ ...base, userId: "alice", senderOwned: false, self: false, content: "模型配置那里", timestamp: new Date(Date.now() + 2000),
      messageId: "reply-to-bob", conversation: { kind: "group", mentions: [], mentionsEveryone: false, reply: { userId: "bob", messageId: "q1" }, hasText: true, media: [] } });
    const exchange = await messenger.channelMessages("fixture@bot-a:group", 50);
    const voluntaryRead = [{ kind: "tool_call" as const, call: { id: "read-exchange", role: "agent" as const, name: "read_channel", arguments: {}, issuedAt: 1, expectedAt: 1 } },
      { kind: "event" as const, event: { id: "read-exchange-result", source: "tool" as const, worldTime: 2, refToolCallId: "read-exchange", content: exchange.text,
        experience: exchange.experience, originEventIds: exchange.originEventIds } }];
    assert.equal(explicitlyAddressesOthers(exchange.experience?.chat), true);
    assert.deepEqual(collectOpportunities(voluntaryRead, ["send", "read_channel", "select_channel"]), [],
      "real messenger snapshots keep quote authorship so reading another pair's exchange does not invite a reply/topic");
    assert.match(history.text, /这是此刻可见记录的快照/);
    assert.match(history.text, /发送者：[\s\S]*消息正文：[\s\S]*〔该条消息结束〕/);
    const rawSticker = await (messenger as any).serializeRawSegments([{ type: "image", data: { file: "marketface", url: "fixture:marketface" } }]);
    assert.match((await renderer.render(rawSticker)).text, /usage="sticker"/, "offline and forwarded raw messages retain platform sticker semantics");

    const time = new Date(1000);
    for (const [i, content] of ["先问：明天约几点？", "后答：下午三点。"].entries()) {
      await store.store({ ...base, channelId: "same-second", userId: "peer", self: false, content, timestamp: time, messageId: "order-" + i });
    }
    assert.deepEqual((await store.channelMessages("fixture", "same-second", 2, "bot-a")).map(row => row.content), ["先问：明天约几点？", "后答：下午三点。"], "same-second messages preserve receipt order instead of reversing question and answer");
    assert.equal((await store.channelMessages("fixture", "same-second", 1, "bot-a"))[0]!.messageId, "order-1", "latest-N cuts include the most recent same-second row");

    // Seeing the newest 10 never replaces the older conversation in the actual model request.
    const memoryFiles = new WorldFiles(path.join(dir, "chat-memory")); await memoryFiles.ensure();
    const memory = new BotContext(memoryFiles, ""); await memory.load();
    for (let i = 0; i < 12; i++) await store.store({ ...base, channelId: "ongoing", userId: i % 2 ? "bob" : "alice", self: false, content: i === 0 ? "周六下午三点在旧书店见，不是周日。" : `正在继续的话题 ${i}`, timestamp: new Date(2000 + i), messageId: `ongoing-${i}` });
    const appendHistory = async (n: number) => {
      const value = await messenger.channelMessages("fixture@bot-a:ongoing", n, { intro: "echo" });
      await memory.appendEvent({ id: memory.nextEventId(), source: "koishi", worldTime: n, content: value.text, parts: value.parts, attachments: value.attachments });
      return memory.toChatMessages("T=1");
    };
    const beforeRead = await appendHistory(12);
    const afterRead = await appendHistory(10);
    assert.deepEqual(afterRead.slice(0, beforeRead.length), beforeRead, "new history read leaves every prior model message byte-identical");
    assert.match(JSON.stringify(afterRead), /周六下午三点在旧书店见，不是周日/);
    assert.doesNotMatch(JSON.stringify(afterRead.at(-1)), /周六下午三点在旧书店见/);
    assert.match((await memory.compressionSnapshot()).text, /周六下午三点在旧书店见，不是周日/);
    const resumed = new BotContext(memoryFiles, ""); await resumed.load();
    assert.deepEqual(await resumed.toChatMessages("T=1"), afterRead, "the full append-only conversation survives a restart");
    console.log("PASS group conversation: sender/channel retained in actual multimodal requests, scoped quote attribution, mentions/DM/stickers, history framing and notification privacy");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
