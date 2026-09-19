import { ChannelNameResolver } from "../src/koishi/names.js";
/** Real local Koishi sessions, command permissions and MessageEncoder lifecycle.
 * Transport is an in-memory encoder; no network, production files or model calls. */
import assert from "node:assert/strict";
import { App, Bot, MessageEncoder, Universal, h, type Session } from "koishi";
import memory from "@koishijs/plugin-database-memory";
import { Config } from "../src/config.js";
import { Gateway } from "../src/koishi/gateway.js";
import { MessageStore } from "../src/koishi/messages.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { executeSelfCommand } from "../src/koishi/self-commands.js";

let serial = 0;
let echoEnabled = true;
const transported: { id: string; content: string }[] = [];
const delays = new Map<string, Promise<void>>();
class LocalEncoder extends MessageEncoder {
  private chunks: h[] = [];
  async visit(element: h) { this.chunks.push(element); }
  async flush() {
    if (!this.chunks.length) return;
    const content = this.chunks.splice(0).join("");
    if (content === "FAIL-TRANSPORT") throw new Error("offline fixture failure");
    await delays.get(content);
    const message = { id: `confirmed-${++serial}`, content, elements: h.parse(content) };
    transported.push(message);
    // Like adapters which echo immediately, dispatch before the send promise settles.
    if (echoEnabled) this.bot.dispatch(this.bot.session({ type: "message", channel: { id: this.channelId },
      user: { id: this.bot.selfId }, message }));
    this.results.push(message);
    // Deliberately never write session.messageId: not required by MessageEncoder.
  }
}
class LocalBot extends Bot {
  static MessageEncoder = LocalEncoder;
  dispose() { if (this.ctx.bots) return super.dispose(); }
  constructor(ctx: App) {
    super(ctx, {});
    this.platform = "fixture"; this.selfId = "account"; this.status = Universal.Status.ONLINE;
  }
}

async function main() {
  const app = new App({ prefix: ["/"] });
  app.plugin((memory as any).default ?? memory);
  app.plugin(LocalBot);
  await app.start();
  const bot = app.bots[0]!;
  const cfg = Config({ autoStart: false });
  const store = new MessageStore(app);
  const selfEvents: { key: string; content: string; id: string }[] = [];
  const deliveryOrder: { kind: "incoming" | "self"; content: string }[] = [];
  const focusedKeys = new Set<string>();
  const deliveryDelays = new Map<string, Promise<void>>();
  const tracker = new OwnSendTracker();
  const originalSendMessage = Object.getOwnPropertyDescriptor(bot, "sendMessage");
  const originalCreateMessage = Object.getOwnPropertyDescriptor(bot, "createMessage");
  const gateway = new Gateway(app, { ...cfg.messaging, externalSelfMessages: "event" }, cfg.platformOps,
    store, {} as never, { render: async (text: string) => ({ text }) } as never,
    { isFocused: (key: string) => focusedKeys.has(key) } as never, { isNotifyChannel: () => false } as never,
    { down: false }, {} as never, tracker, new ChannelNameResolver(app, store), () => null,
    { notify(value) { deliveryOrder.push({ kind: "incoming", content: value.text }); }, channelActivity() {}, async selfMessage(key, rich, id) { const content = rich.text; await deliveryDelays.get(content); selfEvents.push({ key, content, id }); deliveryOrder.push({ kind: "self", content }); } });
  const drain = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await Promise.allSettled([...(gateway as any).messageTails.values()]);
    }
  };
  const rows = () => store.channelMessages("fixture", "group", 100, "account");
  try {
    // cancelled/failed attempts must not appear in history, even after before-send.
    app.on("before-send", session => session.content === "CANCEL-TRANSPORT" ? true : undefined);
    assert.deepEqual(await bot.sendMessage("group", "CANCEL-TRANSPORT"), []);
    await assert.rejects(bot.sendMessage("group", "FAIL-TRANSPORT"));
    await drain();
    assert.equal((await rows()).length, 0);
    assert.equal(selfEvents.length, 0);

    // A fulfilled receipt is sufficient; no fabricated ID and no three-second timer.
    const ids = await bot.sendMessage("group", "external plugin reply");
    await drain();
    assert.equal((await rows()).length, 1);
    assert.equal(selfEvents.length, 1);
    assert.equal(selfEvents[0]!.id, ids[0]);
    assert.equal((await rows())[0]!.self, true);
    assert.equal((await rows())[0]!.content, "external plugin reply");

    // An unrelated plugin send during our delayed send must not consume its identity.
    let release!: () => void;
    delays.set("own delayed", new Promise(resolve => { release = resolve; }));
    const own = tracker.run("fixture@account:group", () => bot.sendMessage("group", "own delayed"));
    await bot.sendMessage("group", "other plugin while own pending");
    release(); await own; await drain();
    assert.equal(selfEvents.filter(event => event.content === "other plugin while own pending").length, 1);
    assert.equal(selfEvents.filter(event => event.content === "own delayed").length, 0);
    assert.ok(!(await rows()).some(row => row.content === "own delayed")); // Messenger owns this row.

    // Plugins can themselves send from before-send hooks, including createMessage.
    app.on("before-send", async session => {
      if (session.content === "own triggers hook") await bot.createMessage("group", "nested other-plugin send");
    });
    await tracker.run("fixture@account:group", () => bot.sendMessage("group", "own triggers hook"));
    await drain();
    assert.equal(selfEvents.filter(event => event.content === "nested other-plugin send").length, 1);
    assert.equal(selfEvents.filter(event => event.content === "own triggers hook").length, 0);

    // Direct OneBot API calls do not pass through sendMessage/createMessage wrappers.
    await tracker.run("fixture@account:group", async () => {
      bot.dispatch(bot.session({ type: "message", channel: { id: "group" }, user: { id: "account" },
        message: { id: "forward-id", elements: h.parse("our forwarded messages") } }));
      return { message_id: "forward-id" };
    });
    await drain();
    assert.equal(selfEvents.filter(event => event.id === "forward-id").length, 0);

    // An earlier media message must not be overtaken by a later quick text message.
    let finishMedia!: () => void;
    const pendingMedia = new Promise<void>(resolve => { finishMedia = resolve; });
    (gateway as any).media = { ingest: async () => { await pendingMedia; return 9; } };
    const stamp = Date.now();
    bot.dispatch(bot.session({ type: "message", timestamp: stamp, channel: { id: "ordered" }, user: { id: "peer" },
      message: { id: "media-first", elements: [h("img", { src: "fixture://local-image" })] } }));
    bot.dispatch(bot.session({ type: "message", timestamp: stamp, channel: { id: "ordered" }, user: { id: "peer" },
      message: { id: "text-second", elements: h.parse("the later answer") } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await store.channelMessages("fixture", "ordered", 10, "account")).length, 0);
    finishMedia(); await drain();
    bot.dispatch(bot.session({ type: "message", timestamp: stamp, channel: { id: "ordered" }, user: { id: "peer" },
      message: { id: "text-second", elements: h.parse("the later answer") } }));
    await drain();
    assert.deepEqual((await store.channelMessages("fixture", "ordered", 10, "account")).map(row => row.messageId), ["media-first", "text-second"]);

    // The two former media queues also allowed confirmed self replies to overtake a
    // peer's earlier slow image. Capture callback and inbound echo share one order.
    let releaseCrossMedia!: () => void;
    const crossMedia = new Promise<void>(resolve => { releaseCrossMedia = resolve; });
    (gateway as any).media = { ingest: async () => { await crossMedia; return 10; } };
    focusedKeys.add("fixture@account:cross-order");
    const deliveryStart = deliveryOrder.length;
    bot.dispatch(bot.session({ type: "message", channel: { id: "cross-order" }, user: { id: "peer" },
      message: { id: "cross-image-first", elements: [h("img", { src: "fixture://slow-image" })] } }));
    await bot.sendMessage("cross-order", "cross reply after image");
    await bot.sendMessage("other-channel", "other channel remains independent");
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
    const replyOvertookImage = selfEvents.some(event => event.content === "cross reply after image");
    assert.ok(selfEvents.some(event => event.content === "other channel remains independent"));
    releaseCrossMedia(); await drain();
    assert.equal(replyOvertookImage, false, "a confirmed self reply must wait for an earlier peer image in the same account/channel");
    assert.deepEqual(deliveryOrder.slice(deliveryStart).filter(event => event.content !== "other channel remains independent").map(event => event.kind), ["incoming", "self"]);

    // Reverse direction without adapter echoes: an external image's confirmed
    // receipt reserves its position ahead of the next peer text, including history.
    let finishSelfMedia!: () => void;
    const pendingSelfMedia = new Promise<void>(resolve => { finishSelfMedia = resolve; });
    (gateway as any).media = { ingest: async () => { await pendingSelfMedia; return 11; } };
    focusedKeys.add("fixture@account:self-image-first");
    const reverseStart = deliveryOrder.length;
    echoEnabled = false;
    const selfImageIds = await bot.sendMessage("self-image-first", h("img", { src: "fixture://slow-self-image" }));
    echoEnabled = true;
    const peerStamp = Date.now() + 1;
    bot.dispatch(bot.session({ type: "message", timestamp: peerStamp, channel: { id: "self-image-first" }, user: { id: "peer" },
      message: { id: "after-self-image-peer", elements: h.parse("peer after self image") } }));
    await new Promise<void>(resolve => setTimeout(resolve, 8));
    const peerOvertookSelf = deliveryOrder.slice(reverseStart).some(event => event.kind === "incoming");
    finishSelfMedia(); await drain();
    assert.equal(peerOvertookSelf, false);
    assert.deepEqual(deliveryOrder.slice(reverseStart).map(event => event.kind), ["self", "incoming"]);
    assert.deepEqual((await store.channelMessages("fixture", "self-image-first", 10, "account")).map(row => row.messageId), [selfImageIds[0], "after-self-image-peer"]);

    // The actual delivery callback may await channel-name lookup. Queue consumption
    // must await it too, while the platform send promise itself stays independent.
    let finishDelivery!: () => void;
    deliveryDelays.set("delayed final delivery", new Promise<void>(resolve => { finishDelivery = resolve; }));
    focusedKeys.add("fixture@account:delivery-order");
    const asyncDeliveryStart = deliveryOrder.length;
    await bot.sendMessage("delivery-order", "delayed final delivery");
    bot.dispatch(bot.session({ type: "message", channel: { id: "delivery-order" }, user: { id: "peer" },
      message: { id: "after-async-self-delivery", elements: h.parse("peer after async delivery") } }));
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(deliveryOrder.length, asyncDeliveryStart, "later ordinary notifications cannot bypass an earlier async self-message callback");
    finishDelivery(); await drain();
    assert.deepEqual(deliveryOrder.slice(asyncDeliveryStart).map(event => event.kind), ["self", "incoming"]);

    // Recall must wait behind ingestion of the same earlier message, or the late
    // original image resurrects after an already-recorded recall marker.
    let finishRecalledImage!: () => void;
    const recalledImage = new Promise<void>(resolve => { finishRecalledImage = resolve; });
    (gateway as any).media = { ingest: async () => { await recalledImage; return 12; } };
    focusedKeys.add("fixture@account:recall-order");
    bot.dispatch(bot.session({ type: "message", channel: { id: "recall-order" }, user: { id: "peer" },
      message: { id: "slow-recalled-image", elements: [h("img", { src: "fixture://recalled-image" })] } }));
    const deletion = bot.session({ type: "message-deleted", channel: { id: "recall-order" }, user: { id: "peer" },
      message: { id: "slow-recalled-image" } });
    bot.dispatch(deletion);
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
    finishRecalledImage(); await drain();
    const recallRows = await store.channelMessages("fixture", "recall-order", 10, "account");
    assert.equal(recallRows.length, 1, "a recalled slow image must not be reinserted after the recall marker");
    assert.match(recallRows[0]!.content, /撤回/);
    assert.doesNotMatch(recallRows[0]!.content, /media id=/);

    // Account identity alone does not prove that the character chose to recall.
    const ownRecallStart = deliveryOrder.length;
    focusedKeys.add("fixture@account:group");
    bot.dispatch(bot.session({ type: "message-deleted", channel: { id: "group" }, user: { id: "account" },
      message: { id: ids[0] } }));
    await drain();
    assert.ok(deliveryOrder.slice(ownRecallStart).some(event => /账号.*撤回/.test(event.content)));
    assert.ok(deliveryOrder.slice(ownRecallStart).every(event => !/你撤回了/.test(event.content)));
    assert.ok(deliveryOrder.slice(ownRecallStart).some(event => /当前会话使用的你的账号.*的一条消息被撤回了/.test(event.content)), "missing group operator metadata must not be attributed to the author");
    const explicitSelfRecall = bot.session({ type: "message-deleted", channel: { id: "group" }, user: { id: "account" },
      message: { id: "another-account-recall" } });
    (explicitSelfRecall as any).operatorId = "account";
    bot.dispatch(explicitSelfRecall); await drain();
    assert.ok(deliveryOrder.slice(ownRecallStart).some(event => /当前会话使用的你的账号.*撤回了该账号的一条消息/.test(event.content)), "an account operator is observable but is not proof of the character's voluntary intent");
    focusedKeys.delete("fixture@account:group");

    // Other login devices arrive as account messages, without any local send call.
    const human = bot.session({ type: "message", channel: { id: "group" }, user: { id: "account" },
      message: { id: "other-client-message", elements: h.parse("human typed on another device") } });
    await (gateway as any).handle(human);
    await (gateway as any).handle(human);
    assert.equal(selfEvents.filter(event => event.id === "other-client-message").length, 1);

    // A second account's identical ID is a different message.
    const other = Object.create(bot) as Bot; Object.defineProperty(other, "selfId", { value: "other-account" });
    const humanOther = other.session({ type: "message", channel: { id: "group" }, user: { id: "other-account" },
      message: { id: "other-client-message", elements: h.parse("second account") } });
    await (gateway as any).handle(humanOther);
    assert.equal(selfEvents.filter(event => event.id === "other-client-message").length, 2);

    // The feature-off path ignores both adapter echoes and other-client messages.
    const off = new Gateway(app, { ...cfg.messaging, externalSelfMessages: "off" }, cfg.platformOps,
      store, {} as never, {} as never, {} as never, {} as never, { down: false }, {} as never,
      new OwnSendTracker(), {} as never, () => null,
      { notify() {}, channelActivity() {}, selfMessage() { assert.fail("off must not notify"); } });
    await (off as any).handle(human);

    // Actual Koishi authority and command aliases, with a real originating message ID.
    await app.database.createUser("fixture", "account", { authority: 1 });
    let invoked = 0, management = 0, protectedCount = 0;
    let expectedCommandName = "真实群名片";
    app.command("fixture_echo <value:text>", { authority: 1 }).action(({ session }, value) => {
      invoked++; assert.equal(session!.userId, "account");
      assert.equal(session!.messageId, "sent-command-id");
      assert.equal(session!.username, expectedCommandName);
      assert.equal(session!.event.member?.nick, expectedCommandName === "真实群名片" ? "真实群名片" : undefined);
      return `command result ${value}`;
    });
    app.command("fixture_admin", { authority: 4 }).action(() => { protectedCount++; return "forbidden"; });
    app.command("world.status", { authority: 0 }).alias("hidden_world_alias").action(() => { management++; return "private world"; });
    app.command("fixture_nested", { authority: 0 }).action(({ session }) => session!.execute("hidden_world_alias"));
    const target = { bot, platform: "fixture", channelId: "group", isDirect: false };
    await executeSelfCommand(app, target, "fixture_echo hello", "sent-command-id", {
      platform: "fixture", selfId: "account", channelId: "group", displayName: "真实群名片", source: "group_card",
    });
    await drain();
    assert.equal(invoked, 1);
    assert.equal(selfEvents.filter(event => event.content === "command result hello").length, 1);
    expectedCommandName = "昵称未知";
    await executeSelfCommand(app, target, "/fixture_echo prefix is not bare", "sent-command-id");
    assert.equal(invoked, 1);
    await executeSelfCommand(app, target, "fixture_admin");
    assert.equal(protectedCount, 0);
    await executeSelfCommand(app, target, "world.status");
    await executeSelfCommand(app, target, "hidden_world_alias");
    await executeSelfCommand(app, target, "fixture_nested");
    await executeSelfCommand(app, target, "fixture_echo $(hidden_world_alias)", "sent-command-id");
    await executeSelfCommand(app, target, "fixture_echo no fake card", "sent-command-id", {
      platform: "fixture", selfId: "someone-else", channelId: "group", displayName: "不是本账号的名片", source: "group_card",
    });
    await drain();
    assert.equal(management, 0);
    (gateway as any).selfCapture.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(bot, "sendMessage"), originalSendMessage);
    assert.deepEqual(Object.getOwnPropertyDescriptor(bot, "createMessage"), originalCreateMessage);
    console.log("PASS: confirmed self-message capture, cancellation/failure exclusion, immediate-echo dedup, concurrent own/external sends, shared cross-direction media ordering with independent channels, other-client/account isolation, feature-off, real Koishi command authority/aliases/interpolation guard and message IDs");
  } finally { await app.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
