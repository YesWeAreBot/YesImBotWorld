/** Real unread ledger, gateway and Bot device dispatch; no LLM, platform, Docker or WebUI. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h } from "koishi";
import { AppManager } from "../src/apps/manager.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { Gateway } from "../src/koishi/gateway.js";
import { MessageStore, type WorldMessageRow } from "../src/koishi/messages.js";
import { ChannelNameResolver } from "../src/koishi/names.js";
import { NotifyManager } from "../src/koishi/notify.js";
import { OwnSendTracker } from "../src/koishi/ownsends.js";
import { WorldService } from "../src/service.js";
import type { PhonePhysicalState, PhoneStatus, RichText } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const unreadKeys = ["fixture@a:unread-secret-a", "fixture@b:unread-secret-b"];
const forbidden = /unread-secret|秘密发送者|秘密正文|private-sender|private-message/;
const badge = /角标|红点/;
async function until(test: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!test() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 1));
  assert.ok(test(), "expected actual device task completion");
}

async function fixture(base: string) {
  const files = new WorldFiles(base); await files.ensure();
  const cfg = Config({ autoStart: false }); cfg.bot.ignoreSendDuration = true; cfg.apps.chatAppName = "信使聊天";
  const clock: any = { now: () => 1, timeLine: () => "T=1", realMsUntil: (at: number) => at > 1 ? 60000 : 0, unitRealSeconds: 1, unitWorldSeconds: 1 };
  const phone: PhoneStatus = { down: true }, context = new BotContext(files, "");
  const rows: WorldMessageRow[] = [];
  const ctx: any = {
    bots: ["a", "b"].map(selfId => ({ platform: "fixture", selfId, isActive: true })),
    on() {}, model: { extend() {} }, logger: () => logger,
    database: {
      async create(_table: string, value: any) { const next = { id: rows.length + 1, ...value }; rows.push(next); return next; },
      async get(_table: string, query: Record<string, any>, options: any) {
        return rows.filter((item: any) => Object.entries(query).every(([key, value]) =>
          value && typeof value === "object" ? value.$in.includes(item[key]) : item[key] === value))
          .sort((a, b) => String(b.timelineKey ?? "").localeCompare(String(a.timelineKey ?? "")) || b.id - a.id).slice(0, options?.limit);
      },
    },
  };
  const store = new MessageStore(ctx), notify = new NotifyManager(path.join(base, "notify.json"), ["*"], true); await notify.load();
  const defs = BOT_TOOLS.filter(tool => ["open_app", "close_app", "pick_up_phone", "put_down_phone", "select_channel", "observe_device", "wait"].includes(tool.name));
  let peeks = 0, screen: RichText | null = null;
  const notes = { id: "notes", name: "记事本", description: "fixture", async open() { return { tools: [], opening: "空白笔记" }; }, async close() {}, async call() { return "空白笔记"; } };
  const apps = new AppManager(cfg.apps.chatAppName, [notes], new Set(defs.map(tool => tool.name)), logger);
  const messenger: any = {
    recentChannels: async () => ({ text: "仅管理员主动打开时可见的秘密正文和秘密发送者" }),
    channelMessages: async () => ({ text: "当前会话中没有消息。" }),
    resolveKey: async (key: string) => ({ key, isPrivate: true }), putDownPhone: async () => "phone down",
  };
  const world: any = { observe: async () => ({ observationId: "fixture-observation", actorId: "bot", sourceEventIds: [], entities: [] }) };
  const computer: any = { isOpen: false, activeToolNames: () => [], activeToolDefs: () => [], view: () => null, hasTool: () => false };
  const bot: any = new BotAgent(cfg, clock, files, context, world, messenger, apps, computer, notify, phone, logger, defs, null,
    async () => { peeks++; return screen; });
  bot.running = true;
  bot.backend = { setToolNames() {}, setToolDefs() {} }; bot.refreshToolGate();
  const received: { content: RichText; wake: boolean }[] = [];
  const renderer: any = { render: async (text: string) => ({ text, parts: [{ kind: "text", text }] }) };
  const focus: any = { isFocused: () => false, async focus() {} };
  const names = new ChannelNameResolver(ctx, store);
  const gateway: any = new Gateway(ctx, { ...cfg.messaging, notifyPolicy: "channel", externalSelfMessages: "off" }, cfg.platformOps,
    store, {} as any, renderer, focus, notify, phone, {} as any, new OwnSendTracker(), names, () => null, {
      notify(content, wake) { received.push({ content, wake }); bot.pushEvent("koishi", content, { wake }); return true; },
      selfMessage() {}, channelActivity() {},
    });
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { bot, appManager: apps, computerDevice: null, remoteDesktopApp: null, worldActive: true, deviceTail: Promise.resolve(), devicePending: 0, config: cfg });
  let serial = 0;
  async function autonomous(name: string, args: Record<string, unknown> = {}) {
    const call = { id: "badge-autonomous-" + ++serial, role: "agent", name, arguments: args, issuedAt: 1, expectedAt: 1 };
    await context.appendToolCall(call as never); await bot.dispatch(call);
    await until(() => !bot.scheduler.isPending(call.id));
    const events = bot.mailbox.filter((event: any) => event.refToolCallId === call.id);
    assert.ok(events.length, `${name} must deliver a real Bot receipt`);
    return { events, text: events.map((event: any) => event.content).join("\n") };
  }
  async function incoming(account: "a" | "b", id: string) {
    const channelId = "unread-secret-" + account;
    await gateway.handle({ platform: "fixture", selfId: account, bot: ctx.bots.find((bot: any) => bot.selfId === account), channelId, guildId: channelId,
      userId: "private-sender", username: "秘密发送者", timestamp: Date.now(), isDirect: false, messageId: "private-message-" + id,
      elements: [h.text("秘密正文 " + id)] });
  }
  function waiting() {
    bot.scheduler.schedule({ id: "pending-badge-wait", role: "agent", name: "wait", arguments: {}, issuedAt: 1, expectedAt: 60 },
      { executeAt: "expected", run: async () => "wait receipt" });
    bot.waiting = { callId: "pending-badge-wait", kind: "wait", startedTU: 1 };
  }
  return { phone, notify, bot, context, received, autonomous, incoming, waiting, peeks: () => peeks,
    setScreen(value: RichText | null) { screen = value; },
    stealth: (name: string, args: Record<string, unknown> = {}) => service.deviceToolCall(name, args, 0, false, "stealth"),
    async close() { await bot.stop(); await apps.closeAll(); },
  };
}

function assertBadge(receipt: { text: string; events: unknown[] }, count: number) {
  assert.match(receipt.text, /信使聊天/, "the badge identifies the configured chat app");
  assert.match(receipt.text, badge, "the visible desktop must expose the chat app badge");
  const displayed = count > 99 ? "99\\+" : String(count);
  assert.match(receipt.text, new RegExp(`(?:未读[^\\n。]*${displayed}|${displayed}[^\\n。]*未读)`), "the badge must show aggregate unread count");
  assert.doesNotMatch(JSON.stringify(receipt.events), forbidden, "an app badge is not a preview of unread conversations");
}

async function quietModes(base: string) {
  for (const mode of ["off", "silent", "dnd"] as const) {
    const f = await fixture(path.join(base, mode));
    try {
      if (mode === "dnd") for (const key of unreadKeys) await f.notify.set(key, false);
      else await f.notify.setMode(mode);
      f.waiting();
      await f.incoming("a", "one"); await f.incoming("a", "two"); await f.incoming("b", "three");
      assert.equal(f.notify.snapshot().unread, 3, `${mode} still records unread messages`);
      assert.equal(f.received.length, 0, "background badge changes do not create a notification callback");
      assert.equal(f.bot.mailbox.length, 0, "a placed phone's badge is not pushed to the Bot");
      assert.equal(f.context.stream.length, 0); assert.equal(f.peeks(), 0);
      assert.equal(f.bot.scheduler.isPending("pending-badge-wait"), true, "unread accumulation cannot wake or cancel a Bot wait");
      assert.equal(f.bot.waiting.callId, "pending-badge-wait");
      const before = f.notify.snapshot();
      assertBadge(await f.autonomous("pick_up_phone"), 3);
      assert.equal(f.phone.down, false);
      assert.deepEqual(f.notify.snapshot(), before, "picking up reveals a count without marking any message read");
      assertBadge(await f.autonomous("observe_device", { device: "phone" }), 3);
      assert.deepEqual(f.notify.snapshot(), before, "reobserving the desktop does not clear unread or notification records");
      assert.equal(f.received.length, 0, "an explicit observation is not an unsolicited gateway notification");
      if (mode !== "silent") {
        const mailboxLength = f.bot.mailbox.length, streamLength = f.context.stream.length;
        await f.incoming("a", "arrived-while-held");
        assert.equal(f.notify.snapshot().unread, 4);
        assert.equal(f.received.length, 0, "off/DND badge changes remain passive even on an attended desktop");
        assert.equal(f.bot.mailbox.length, mailboxLength); assert.equal(f.context.stream.length, streamLength);
        assert.equal(f.bot.scheduler.isPending("pending-badge-wait"), true);
        assertBadge(await f.autonomous("observe_device", { device: "phone" }), 4);
        assert.equal(f.notify.snapshot().unread, 4);
      }
      assert.doesNotMatch((await f.autonomous("put_down_phone")).text, badge);
      assert.equal(f.bot.deviceAttention, null);
      await f.notify.markRead();
      const empty = await f.autonomous("pick_up_phone");
      assert.match(empty.text, /(?:没有|无|未显示|不显示)[^\n。]*(?:角标|红点)|(?:角标|红点)[^\n。]*(?:没有|无|0)/, "an empty desktop explicitly has no unread badge");
      assert.doesNotMatch(JSON.stringify(empty.events), forbidden);
      const emptyLook = await f.autonomous("observe_device", { device: "phone" });
      assert.match(emptyLook.text, /(?:没有|无|未显示|不显示)[^\n。]*(?:角标|红点)|(?:角标|红点)[^\n。]*(?:没有|无|0)/);
    } finally { await f.close(); }
  }
}

async function foregroundAndStealth(base: string) {
  const f = await fixture(path.join(base, "foreground"));
  try {
    await f.notify.setMode("off"); await f.incoming("a", "hidden");
    const before = f.notify.snapshot(), streamLength = f.context.stream.length;
    assert.equal((await f.stealth("open_app", { name: "chat" })).ok, true);
    assert.equal(f.bot.mailbox.length, 0); assert.equal(f.context.stream.length, streamLength);
    assert.equal(f.peeks(), 0, "the user's private phone view cannot make the Bot look at its screen");
    assert.equal((await f.stealth("close_app")).ok, true);
    assert.equal(f.bot.mailbox.length, 0); assert.equal(f.context.stream.length, streamLength);
    assert.equal(f.phone.down, true); assert.deepEqual(f.notify.snapshot(), before);
    assertBadge(await f.autonomous("pick_up_phone"), 1);
    assert.deepEqual(f.notify.snapshot(), before);

    await f.autonomous("open_app", { name: "notes" });
    assert.doesNotMatch((await f.autonomous("observe_device", { device: "phone" })).text, badge, "another app does not display a desktop app badge");
    assertBadge(await f.autonomous("close_app"), 1);
    await f.autonomous("open_app", { name: "notes" });
    await f.autonomous("put_down_phone");
    await f.stealth("open_app", { name: "notes" });
    assert.doesNotMatch((await f.autonomous("pick_up_phone")).text, badge, "picking up into another app does not pretend the desktop is visible");
    await f.autonomous("put_down_phone");
    await f.stealth("open_app", { name: "chat" });
    assert.doesNotMatch((await f.autonomous("pick_up_phone")).text, badge, "chat's message list does not contain the desktop badge");
    assert.doesNotMatch((await f.autonomous("observe_device", { device: "phone" })).text, badge);
    await f.autonomous("select_channel", { id: "fixture@a:visible-conversation" });
    assert.doesNotMatch((await f.autonomous("observe_device", { device: "phone" })).text, badge, "a selected conversation does not contain the desktop badge");
    await f.autonomous("put_down_phone");
    await f.stealth("open_app", { name: "chat" });
    await f.stealth("select_channel", { id: "fixture@a:visible-conversation" });
    assert.doesNotMatch((await f.autonomous("pick_up_phone")).text, badge);
    assert.deepEqual(f.notify.snapshot(), before, "unread in other conversations survives foreground navigation");
  } finally { await f.close(); }
}

async function physicalVisibility(base: string) {
  const f = await fixture(path.join(base, "physical"));
  try {
    await f.notify.setMode("off"); await f.incoming("a", "physical");
    const before = f.notify.snapshot();
    const states: [string, PhonePhysicalState][] = [
      ["not visible", { reachable: true, location: null, usable: true, perceptible: false }],
      ["out of reach", { reachable: false, location: "未知的远处", usable: true, perceptible: true }],
      ["damaged", { reachable: true, location: null, usable: false, perceptible: true }],
      ["no power", { reachable: true, location: null, usable: false, perceptible: true }],
    ];
    for (const [label, state] of states) {
      f.phone.down = true; f.phone.physical = state; f.bot.phonePhysicalStateChanged();
      const peeks = f.peeks();
      assert.doesNotMatch((await f.autonomous("pick_up_phone")).text, badge, `${label}: picking up cannot expose an unread badge`);
      assert.doesNotMatch((await f.autonomous("observe_device", { device: "phone" })).text, badge, `${label}: inaccessible screens have no badge perception`);
      assert.equal(f.peeks(), peeks, `${label}: no inaccessible screen capture`);
      assert.deepEqual(f.notify.snapshot(), before, `${label}: physical availability cannot delete unread`);
    }
    f.phone.down = true; delete f.phone.physical; f.bot.phonePhysicalStateChanged();
    assertBadge(await f.autonomous("pick_up_phone"), 1);
  } finally { await f.close(); }
}

async function richDesktopAndLargeCount(base: string) {
  const f = await fixture(path.join(base, "rich-desktop"));
  try {
    await f.notify.setMode("off");
    await Promise.all(Array.from({ length: 137 }, (_, index) => f.notify.receive(unreadKeys[index % 2]!, {
      id: index + 1, platform: "fixture", selfId: index % 2 ? "b" : "a", channelId: "unread-secret", guildId: "unread-secret",
      userId: "private-sender", username: "秘密发送者", content: "秘密正文", timestamp: new Date(index * 1000),
      messageId: "private-message-" + index, self: false, orderSource: "live",
    })));
    f.setScreen({ text: "桌面上的普通界面内容", parts: [{ kind: "text", text: "桌面上的普通界面内容" }] });
    const before = f.notify.snapshot();
    const look = await f.autonomous("observe_device", { device: "phone" });
    assertBadge(look, 137);
    assert.doesNotMatch(look.text, /137/, "the badge follows the visible 99+ cap rather than exposing a hidden exact count");
    assert.equal(f.phone.down, true, "explicitly observing a nearby placed phone does not pick it up");
    assert.deepEqual(f.notify.snapshot(), before);
    const event = look.events.find((event: any) => event.parts?.length);
    assert.ok(event, "the fixture exercises an ordered rich-text screen");
    assert.match(event.parts.map((part: any) => part.text ?? "").join(""), /信使聊天[^\n。]*99\+/);
    await f.bot.drainMailbox(false);
    const rendered = f.context.renderStreamText();
    assert.match(rendered, /信使聊天[^\n。]*99\+/, "BotContext's parts-based projection retains the desktop badge");
    assert.match(rendered, /桌面上的普通界面内容/);
    assert.doesNotMatch(rendered, forbidden);
    assert.deepEqual(f.notify.snapshot(), before);
  } finally { await f.close(); }
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-phone-badge-"));
  try {
    await quietModes(base); await foregroundAndStealth(base); await physicalVisibility(base); await richDesktopAndLargeCount(base);
    console.log("PASS phone badge perception: quiet unread accumulation, autonomous pickup/observation, aggregate-only privacy, no read acknowledgement, foreground/physical gating and no hidden-user or background wake leakage");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
