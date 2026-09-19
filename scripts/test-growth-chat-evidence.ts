import { ChannelNameResolver } from "../src/koishi/names.js";
/** Platform delivery -> history -> durable context/growth. No live platform or model. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { BotContext } from "../src/bot/context.js";
import { BotAgent } from "../src/bot/agent.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { ReceiptInbox } from "../src/bot/receipts.js";
import { Gateway } from "../src/koishi/gateway.js";
import { KoishiMessenger } from "../src/koishi/messenger.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { anonymousChatNoticeEvidence, chatMessageEvidence, chatSubjectId } from "../src/koishi/conversation.js";
import type { BotEvent, RichText, ToolCallRecord } from "../src/types.js";

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-growth-chat-"));
  try {
    const cfg = Config({ autoStart: false });
    const rows: WorldMessageRow[] = [];
    const ctx: any = {
      bots: ["a", "b"].map(selfId => ({ platform: "fixture", selfId, isActive: true })),
      on() {}, model: { extend() {} }, logger: () => ({ warn() {} }),
      database: {
        async create(_table: string, row: any) { const next = { id: rows.length + 1, ...row }; rows.push(next); return next; },
        async get(_table: string, query: Record<string, any>, options: any) {
          return rows.filter((row: any) => Object.entries(query).every(([key, value]) => value && typeof value === "object" ? value.$in.includes(row[key]) : row[key] === value))
            .sort((a, b) => (options?.sort?.timelineKey ? String(b.timelineKey ?? "").localeCompare(String(a.timelineKey ?? "")) : 0) || b.timestamp.getTime() - a.timestamp.getTime() || b.id - a.id).slice(0, options?.limit);
        },
      },
    };
    const store = new MessageStore(ctx);
    const renderer: any = { render: async (text: string) => ({ text, parts: [{ kind: "text", text }] }) };
    let focused = true;
    const focus: any = { isFocused: () => focused, focus: async () => {} };
    const notify: any = { isNotifyChannel: () => true, channelStatusText: () => "频道通知：开启" };
    const phone = { down: false };
    const names = Object.assign(new ChannelNameResolver(ctx, store), { display: async (key: string) => "朋友群 / " + key });
    const messaging = { ...cfg.messaging, externalSelfMessages: "event" as const, notifyPolicy: "content" as const };
    const received: RichText[] = [], external: RichText[] = [];
    const gateway: any = new Gateway(ctx, messaging, cfg.platformOps, store, {} as any, renderer, focus, notify, phone, {} as any, new OwnSendTracker(), names, () => null, {
      notify(value) { received.push(value); }, selfMessage(_key, value) { external.push(value); }, channelActivity() {},
    });
    const messenger = new KoishiMessenger(ctx, store, renderer, {} as any, {} as any, {} as any, null, focus, notify, cfg.platformOps, messaging, {} as any, new OwnSendTracker(), names, () => null);
    const base: any = { platform: "fixture", selfId: "a", bot: ctx.bots[0], channelId: "group", guildId: "guild", userId: "alice", username: "青哥", isDirect: false, timestamp: 3_600_000 };
    const incoming = async (id: string, text: string, extra: Record<string, any> = {}) => {
      await gateway.handle({ ...base, messageId: id, elements: [h.text(text)], ...extra });
      return received.at(-1)!;
    };

    const first = await incoming("m1", "每次画完画一起散步吧。");
    assert.equal(first.originEventIds?.length, 1);
    assert.deepEqual(first.experience?.subjectIds, [chatSubjectId("fixture", "alice")]);
    assert.equal(first.experience?.agency, "observed");
    const files = new WorldFiles(dir); await files.ensure();
    const context = new BotContext(files, ""); await context.load();
    const ledger = new GrowthLedger(dir);
    let time = 0;
    const append = async (rich: RichText) => {
      const event: BotEvent = { id: context.nextEventId(), source: "koishi", worldTime: ++time,
        content: rich.text, parts: rich.parts, originEventIds: rich.originEventIds, experience: rich.experience };
      await context.appendEvent(event); await ledger.perceive(event);
      return event;
    };
    await append(first);
    const prefix = await context.toChatMessages("T=0");
    for (let i = 0; i < 30; i++) {
      const snapshot = await messenger.channelMessages("fixture@a:group", 10);
      assert.deepEqual(snapshot.originEventIds, first.originEventIds, "live and each reread identify the same underlying message");
      await append(snapshot);
    }
    assert.equal((await ledger.stats()).uniqueRoots, 1, "tool call count never becomes conversation experience count");
    assert.equal(await ledger.snapshotReview({ at: time, minimumEpisodes: 2 }), null, "many rereads cannot trigger a multi-episode review");
    assert.deepEqual((await context.toChatMessages("T=1")).slice(0, prefix.length), prefix, "evidence enrichment only appends to the existing model prefix");
    const restored = new BotContext(files, ""); await restored.load();
    const reloaded = new GrowthLedger(dir); await reloaded.restorePerceptions(restored.stream);
    assert.equal((await reloaded.stats()).uniqueRoots, 1, "restart repair retains stable causes");

    const second = await incoming("m2", "明天还在这里聊。", { timestamp: base.timestamp + 1000, username: "阿青" });
    assert.equal(first.experience?.episodeId, second.experience?.episodeId, "renames and messages in the same conversation window stay one episode");
    assert.deepEqual(first.experience?.subjectIds, second.experience?.subjectIds, "account identity survives nickname changes");
    const later = await incoming("m3", "第二天再见。", { timestamp: base.timestamp + 86_400_000 });
    assert.notEqual(first.experience?.episodeId, later.experience?.episodeId);
    const otherAccount = await incoming("m1", "另一个接收账号的独立消息", { selfId: "b", bot: ctx.bots[1] });
    assert.notDeepEqual(first.originEventIds, otherAccount.originEventIds, "identical platform message IDs are account-scoped");

    const withoutId = await incoming("", "平台没有给编号", { channelId: "no-id" });
    const noIdRow = rows.at(-1)!;
    assert.ok(noIdRow.id);
    assert.deepEqual((await messenger.channelMessages("fixture@a:no-id", 10)).originEventIds, withoutId.originEventIds, "database IDs identify messages without platform IDs");
    assert.deepEqual(chatMessageEvidence(noIdRow).originEventIds, withoutId.originEventIds);
    const quote = await incoming("quoted", "我对这件事的回复", { channelId: "quoted", quote: { id: "unseen-original", user: { id: "bob", name: "小白" }, content: "被引用的原话" } });
    assert.deepEqual(quote.experience?.subjectIds, [chatSubjectId("fixture", "alice")]);
    assert.equal(quote.originEventIds?.length, 1, "a quotation is not a new live message from its original author");
    assert.match(quote.text, /被引用的原话/);
    const quoteRow = rows.at(-1)!;
    const quotedOrigin = chatMessageEvidence({ ...quoteRow, messageId: "unseen-original", userId: "bob" }).originEventIds;
    assert.deepEqual(quote.experience?.responseToRoots, quotedOrigin, "an explicit delivered quote links to the original message's exact platform/account/channel root");
    assert.deepEqual((await messenger.channelMessages("fixture@a:quoted", 10)).experience?.responseToRoots, quotedOrigin, "a stored single-message reread retains explicit reply provenance");
    for (const changed of [{ platform: "another-platform" }, { selfId: "b" }, { channelId: "another-channel" }]) {
      assert.notDeepEqual(chatMessageEvidence({ ...quoteRow, ...changed }).experience?.responseToRoots, quotedOrigin, "same message IDs in a different identity scope never link a reply");
    }
    assert.equal(anonymousChatNoticeEvidence(quote).experience?.responseToRoots, undefined, "hearing an anonymous vibration does not reveal that a message answered a particular earlier send");
    const adjacent = await incoming("adjacent-but-no-quote", "好的", { channelId: "quoted", timestamp: base.timestamp + 1 });
    assert.equal(adjacent.experience?.responseToRoots, undefined, "a nearby message is not automatically interpreted as a response to the previous send");

    focused = false;
    messaging.notifyPolicy = "count" as any;
    const count = await incoming("count-only", "尚未看见的秘密", { channelId: "hidden-count" });
    assert.equal(count.experience?.subjectIds, undefined);
    assert.equal(count.experience?.situation, "手机通知");
    assert.match(count.originEventIds?.[0] ?? "", /^chat-notice:/);
    assert.match(count.experience?.episodeId ?? "", /^phone-notice-episode:/);
    assert.doesNotMatch(JSON.stringify(count), /alice|秘密|group/);
    await append(count);
    const hiddenBody = await messenger.channelMessages("fixture@a:hidden-count", 10);
    assert.notDeepEqual(hiddenBody.originEventIds, count.originEventIds);
    const beforeBody = (await ledger.stats()).uniqueRoots;
    await append(hiddenBody);
    assert.equal((await ledger.stats()).uniqueRoots, beforeBody + 1, "hearing a count notification cannot consume unseen message-body evidence");
    messaging.notifyPolicy = "content";
    phone.down = true;
    const vibration = await incoming("phone-down", "不能透过手机看见这句话");
    assert.equal(vibration.experience?.subjectIds, undefined);
    assert.equal(vibration.experience?.episodeId, count.experience?.episodeId, "anonymous notifications from different channels share one phone episode");
    assert.doesNotMatch(JSON.stringify(vibration), /alice|这句话|group/);
    assert.deepEqual(anonymousChatNoticeEvidence(vibration), { originEventIds: vibration.originEventIds, experience: vibration.experience }, "service-side privacy rechecks retain the same anonymous notice cause");
    const notificationLedger = new GrowthLedger(path.join(dir, "notifications"));
    for (let i = 0; i < 30; i++) {
      const notification = await incoming("noise-" + i, "不应可见", { channelId: "hidden-" + i, timestamp: base.timestamp + i });
      await notificationLedger.perceive({ id: "notice-" + i, source: "koishi", worldTime: i, content: notification.text,
        originEventIds: notification.originEventIds, experience: notification.experience });
    }
    assert.equal(await notificationLedger.snapshotReview({ at: 40, minimumEpisodes: 2 }), null, "a busy phone cannot turn thirty nearby vibrations into independent growth episodes");
    const renderBeforeRace = renderer.render;
    phone.down = false;
    renderer.render = async (text: string) => { const rich = await renderBeforeRace(text); phone.down = true; return rich; };
    const delayed = await incoming("render-race", "渲染完成时已放下手机，不能看到");
    assert.equal(delayed.text, "放在一边的手机震了一下。");
    assert.doesNotMatch(JSON.stringify(delayed), /alice|渲染完成|group|chat-user/);
    renderer.render = renderBeforeRace;
    phone.down = false;
    await gateway.handleConfirmedSelfSent({ bot: ctx.bots[0], channelId: "external", messageId: "external-1", timestamp: base.timestamp,
      elements: [h.text("另一台设备发送的内容")], own: false });
    assert.equal(external.at(-1)?.experience?.agency, "observed", "account ownership never proves a voluntary character action");
    assert.deepEqual(external.at(-1)?.originEventIds, (await messenger.channelMessages("fixture@a:external", 10)).originEventIds);
    phone.down = true;
    await gateway.handleConfirmedSelfSent({ bot: ctx.bots[0], channelId: "external-hidden", messageId: "external-2", timestamp: base.timestamp,
      elements: [h.text("不应看见的其他设备消息")], own: false });
    assert.equal(external.at(-1)?.text, "");
    assert.equal(external.at(-1)?.experience?.subjectIds, undefined);
    assert.match(external.at(-1)?.originEventIds?.[0] ?? "", /^chat-notice:/);
    assert.doesNotMatch(JSON.stringify(external.at(-1)), /不应看见|external-hidden|fixture|chat-user/);

    messaging.selfCommands = false; messaging.coldChannelMsgs = 0;
    ctx.bots[0].sendMessage = async () => ["outbound-1"];
    const sent = await messenger.sendReceipt("fixture@a:group", "今天画完后再聊。", []);
    assert.equal(sent.status, "sent");
    assert.equal(sent.experience?.agency, undefined, "messenger cannot infer who chose the send");
    const sentRow = await store.findByMessageId("fixture", "group", "outbound-1", "a");
    assert.deepEqual(sent.originEventIds, chatMessageEvidence(sentRow!).originEventIds);
    assert.equal(sent.experience?.episodeId, chatMessageEvidence(sentRow!).experience?.episodeId);
    ctx.bots[0].sendMessage = async () => [];
    const uncertain = await messenger.sendReceipt("fixture@a:group", "尚不确定是否送达。", []);
    assert.equal(uncertain.status, "unknown");
    assert.equal(uncertain.originEventIds, undefined, "unconfirmed sends never invent a platform message cause");

    await store.store({ ...base, channelId: "older", messageId: "old", content: "另一个频道的记录", self: false, timestamp: new Date(0) });
    const empty = await messenger.channelMessages("fixture@a:empty", 10);
    assert.deepEqual(empty.originEventIds, []);
    const beforeEmpty = await ledger.stats(); await append(empty);
    assert.equal((await ledger.stats()).uniqueRoots, beforeEmpty.uniqueRoots, "empty history checks do not manufacture evidence");

    (messenger as any).forwardCache.set("forward-1", [{ sender: { user_id: "bob", nickname: "小白" }, time: 60, content: [{ type: "text", data: { text: "转发里的往事" } }] }]);
    const forward = await messenger.viewForward("forward-1");
    assert.deepEqual(forward.originEventIds, (await messenger.viewForward("forward-1")).originEventIds);
    assert.deepEqual(forward.experience?.subjectIds, []);
    assert.match(forward.text, /转发内署名：小白/);
    assert.match(forward.text, /不是这些人此刻/);
    const nestedNodes = [{ sender: { user_id: "bob" }, content: [{ type: "text", data: { text: "内层往事" } }] }];
    const nestedA = (messenger as any).cacheForward(nestedNodes);
    const nestedB = (messenger as any).cacheForward(structuredClone(nestedNodes));
    assert.equal(nestedA, nestedB, "reopening an outer forward does not invent new nested record IDs");

    // Exercise the real production mailbox boundary, not just direct ledger calls.
    const runtimeFiles = new WorldFiles(path.join(dir, "actual-agent")); await runtimeFiles.ensure();
    const runtimeContext = new BotContext(runtimeFiles, ""); await runtimeContext.load();
    const agent = new BotAgent(cfg, { now: () => time, timeLine: () => "T=1", realMsUntil: () => 0 } as any,
      runtimeFiles, runtimeContext, {} as any, messenger, null, null, null, { down: false },
      { info() {}, warn() {}, error() {}, debug() {} } as any, BOT_TOOLS.filter(tool => ["read_channel", "send"].includes(tool.name)));
    agent.pushEvent("koishi", withoutId);
    await (agent as any).drainMailbox();
    const liveEvidence = (await agent.growth.recallEvidence())[0]!;
    assert.deepEqual(liveEvidence.experience, { ...withoutId.experience, outcome: "unknown" }, "pushEvent and durable mailbox delivery preserve platform episode and participant facts");
    const runtimePrefix = await runtimeContext.toChatMessages("T=1");
    for (let i = 0; i < 3; i++) {
      agent.pushEvent("tool", await messenger.channelMessages("fixture@a:no-id", 10));
      await (agent as any).drainMailbox();
    }
    assert.equal((await agent.growth.stats()).uniqueRoots, 1);
    assert.deepEqual((await runtimeContext.toChatMessages("T=1")).slice(0, runtimePrefix.length), runtimePrefix);
    agent.simulateExternalSend("fixture@a:external", external[0]!, "external-1", { msg: external[0]!.text });
    await (agent as any).drainMailbox();
    const simulated = (await agent.growth.recallEvidence())[0]!;
    assert.deepEqual(simulated.rootEventIds, external[0]!.originEventIds, "simulated account delivery keeps the same message root as later history");
    assert.equal(simulated.experience?.episodeId, external[0]!.experience?.episodeId);
    const restart = new BotContext(runtimeFiles, ""); await restart.load();
    const restartedLedger = new GrowthLedger(runtimeFiles.base); await restartedLedger.restorePerceptions(restart.stream);
    assert.deepEqual((await restartedLedger.recallEvidence())[0]?.experience, simulated.experience, "production-delivered metadata survives restart repair");

    // The real history limit can include 200 different speakers, not just the 30 visible by default.
    for (let i = 0; i < 200; i++) await store.store({ ...base, channelId: "crowded", userId: `speaker-${i}`, username: `群友${i}`,
      messageId: `crowded-${i}`, content: `第${i}位群友的实际发言。`, self: false, timestamp: new Date(base.timestamp + i) });
    const crowdedHistory = await messenger.channelMessages("fixture@a:crowded", 200);
    assert.equal(crowdedHistory.experience?.subjectIds?.length, 200);
    agent.pushEvent("tool", crowdedHistory); await (agent as any).drainMailbox();
    const crowdedEvidence = (await agent.growth.recallEvidence())[0]!;
    assert.equal(crowdedEvidence.experience?.subjectIds?.length, 200, "a large participant list must cross the actual mailbox boundary without blocking the actor");
    assert.equal((agent as any).mailbox.length, 0);

    const longSelfMessage = "这是一条由其他设备发出的完整长消息。".repeat(200);
    agent.simulateExternalSend("fixture@a:external", { text: longSelfMessage, originEventIds: ["external-long-root"],
      experience: { episodeId: "external-long-episode", agency: "observed", subjectIds: [chatSubjectId("fixture", "a")] },
    }, "external-long", { msg: longSelfMessage });
    await (agent as any).drainMailbox();
    const longEvidence = (await agent.growth.recallEvidence())[0]!;
    assert.ok((longEvidence.experience?.action?.length ?? 0) <= 1200, "the bounded growth action description cannot reject a successfully delivered long account message");
    assert.ok(longEvidence.text.includes(longSelfMessage), "bounding the metadata must preserve the full original message as evidence");
    assert.equal(longEvidence.experience?.agency, "self"); assert.equal((agent as any).mailbox.length, 0);

    cfg.bot.ignoreSendDuration = true; cfg.bot.sendBlocking = false; cfg.bot.growth.enabled = false;
    cfg.messaging.sendEcho = true;
    const driver: any = agent;
    driver.running = true;
    driver.phoneUi = { chatOpen: true, channelKey: "fixture@a:group", channelIsGroup: true, forwardStack: [] };
    driver.currentToolNames = () => ["send"]; driver.refreshToolGate = () => {};
    let sendNumber = 0;
    const makeSend = (msg: string): ToolCallRecord => ({ id: "growth-send-" + ++sendNumber, name: "send", role: "agent",
      arguments: { id: "fixture@a:group", msg }, issuedAt: time, expectedAt: time, duration: 0 });
    const performSend = async (call: ToolCallRecord, stealth = false) => {
      if (!stealth) await runtimeContext.appendToolCall(call);
      else { call.role = "system"; driver.stealthCalls.add(call.id); driver.attention = null; }
      const start = runtimeContext.stream.length;
      driver.dispatchSend(call); await driver.scheduler.whenIdle(); await driver.drainMailbox();
      return runtimeContext.stream.slice(start).flatMap(entry => entry.kind === "event" ? [entry.event] : []);
    };
    ctx.bots[0].sendMessage = async () => ["own-send-" + sendNumber];
    const sendOne = makeSend("我的实际新回复甲");
    const sendEvents = await performSend(sendOne);
    const sendReceipt = sendEvents.find(event => event.source === "tool" && event.refToolCallId === sendOne.id)!;
    const readback = sendEvents.find(event => event.source === "koishi")!;
    assert.ok(sendReceipt && readback);
    assert.ok(sendEvents.indexOf(sendReceipt) < sendEvents.indexOf(readback), "the confirmed receipt is delivered before its observed readback");
    assert.equal(sendReceipt.experience?.agency, "self");
    assert.match(sendReceipt.experience?.action ?? "", /我的实际新回复甲/);
    assert.equal(sendReceipt.originEventIds?.length, 1, "the action contains only its own platform-confirmed message root");
    assert.equal(readback.experience?.agency, "observed");
    assert.equal(readback.experience?.action, undefined);
    assert.equal(readback.refToolCallId, undefined);
    assert.ok(readback.originEventIds!.length > sendReceipt.originEventIds!.length);
    assert.doesNotMatch(sendReceipt.content, /阿青|转发内署名|每次画完画/);
    const sendTwo = makeSend("我的实际新回复乙");
    const sendTwoEvents = await performSend(sendTwo);
    const sendTwoReceipt = sendTwoEvents.find(event => event.source === "tool" && event.refToolCallId === sendTwo.id)!;
    assert.equal(sendTwoReceipt.originEventIds?.length, 1);
    assert.ok(!sendTwoReceipt.originEventIds!.some(root => sendReceipt.originEventIds!.includes(root)), "overlapping history cannot join independent sends by shared roots");
    assert.deepEqual((await runtimeContext.toChatMessages("T=1")).slice(0, runtimePrefix.length), runtimePrefix, "separate send/readback delivery leaves the previously submitted request prefix unchanged");

    const stealthEvents = await performSend(makeSend("偷偷发送的内容"), true);
    assert.equal(stealthEvents.length, 0, "a stealth send suppresses its entire direct receipt/readback batch");

    let entered!: () => void, release!: () => void;
    const enteredSend = new Promise<void>(resolve => { entered = resolve; });
    const sendGate = new Promise<void>(resolve => { release = resolve; });
    ctx.bots[0].sendMessage = async () => { entered(); await sendGate; return ["late-confirmation"]; };
    const late = makeSend("停止前已经提交的回复");
    await runtimeContext.appendToolCall(late); driver.dispatchSend(late);
    await enteredSend; await agent.stop();
    const stoppedLength = runtimeContext.stream.length;
    release(); await driver.scheduler.whenIdle(); await driver.receipts.settled();
    assert.equal(runtimeContext.stream.length, stoppedLength, "a retired sender does not append into its stale context");
    const lateContext = new BotContext(runtimeFiles, ""); await lateContext.load();
    const inbox = new ReceiptInbox(runtimeFiles.base);
    const stored = (await fs.readdir(inbox.directory)).filter(name => name.endsWith(".json"));
    assert.equal(stored.length, 1, "receipt and readback share one durable envelope");
    const rawReceipt = JSON.parse(await fs.readFile(path.join(inbox.directory, stored[0]!), "utf8"));
    assert.equal(rawReceipt.event.experience.agency, "self");
    assert.equal(rawReceipt.followingObservations.length, 1);
    assert.equal(rawReceipt.followingObservations[0].experience.agency, "observed");
    await assert.rejects(inbox.drain(async event => {
      await lateContext.appendEvent(event);
      throw new Error("crash after primary append");
    }), /crash after primary append/);
    await new ReceiptInbox(runtimeFiles.base).drain(event => lateContext.appendEvent(event));
    const recovered = lateContext.stream.slice(stoppedLength).flatMap(entry => entry.kind === "event" ? [entry.event] : []);
    assert.equal(recovered.length, 2, "recovery does not duplicate a primary persisted before the crash");
    assert.equal(recovered[0]!.refToolCallId, late.id);
    assert.equal(recovered[0]!.originEventIds?.length, 1);
    assert.equal(recovered[1]!.source, "koishi");
    assert.equal(recovered[1]!.experience?.agency, "observed");
    const recoveredLedger = new GrowthLedger(runtimeFiles.base); await recoveredLedger.restorePerceptions(lateContext.stream);
    assert.equal((await recoveredLedger.recallEvidence({ eventIds: [recovered[0]!.id] }))[0]?.experience?.agency, "self");
    assert.equal((await recoveredLedger.recallEvidence({ eventIds: [recovered[1]!.id] }))[0]?.experience?.agency, "observed");
    console.log("PASS chat growth evidence: stable live/history IDs, episode grouping, nickname identity, no-ID/restart recovery, privacy and quote/forward attribution");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
