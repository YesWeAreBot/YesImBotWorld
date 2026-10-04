/** Real device dispatch and app ownership; no LLM, external platform, or production state. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { SettingsApp } from "../src/apps/settings.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { availableTools } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { NotifyManager } from "../src/koishi/notify.js";
import type { BotEvent, PhoneStatus, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const CHANNEL = "fixture@self:group-room", CHAT_NAME = "自定义信使";
async function fixture(base: string, channelManaged: boolean, appsManaged: boolean) {
  const files = new WorldFiles(base); await files.ensure();
  const cfg = Config({ autoStart: false }); cfg.messaging.botManagedNotifyChannels = channelManaged;
  cfg.apps.botManagedNotifications = appsManaged; cfg.apps.chatAppName = CHAT_NAME; cfg.bot.growth.enabled = false;
  cfg.bot.ignoreSendDuration = true; cfg.messaging.sendEcho = false;
  let now = 100;
  const clock: any = { now: () => now, timeLine: () => `架空历 T=${now}`, unitWorldSeconds: 2, unitRealSeconds: 1, realMsUntil: () => 0 };
  const notify = new NotifyManager(path.join(base, "notify.json"), ["*"], channelManaged,
    { appsManaged, clock: () => ({ now, unitWorldSeconds: 2, format: tu => `架空历 T=${tu}` }) });
  await notify.load();
  const settings = new SettingsApp({ notify, clock, apps: () => [
    { id: "chat", name: CHAT_NAME, description: "聊天" }, { id: "camera", name: "相机", description: "照片" },
  ] });
  const operatorContexts: (boolean | undefined)[] = [], originalCall = settings.call.bind(settings);
  settings.call = async (name, args, context) => { operatorContexts.push(context?.operator); return originalCall(name, args, context); };
  const defs = availableTools({ tts: false, ops: cfg.platformOps, notifyManaged: channelManaged,
    apps: [{ name: CHAT_NAME, description: "聊天" }, { name: settings.name, description: settings.description }] });
  const apps = new AppManager(CHAT_NAME, [settings], new Set(defs.map(def => def.name)), logger);
  const context = new BotContext(files, ""); await context.load();
  const phone: PhoneStatus = { down: false };
  let chatReads = 0;
  const messenger: any = {
    async recentChannels() { chatReads++; return { text: "群消息列表正文", parts: [{ kind: "text", text: "群消息列表正文" }], originEventIds: [] }; },
    async resolveKey(id: string) { return id === CHANNEL ? { key: id, isPrivate: false } : { error: "未知频道" }; },
    async channelMessages() { return { text: "当前频道正文", parts: [{ kind: "text", text: "当前频道正文" }], originEventIds: [] }; },
    async putDownPhone() { return "手机已放下。"; },
  };
  const bot: any = new BotAgent(cfg, clock, files, context, {} as any, messenger, apps, null, notify, phone, logger, defs);
  bot.running = true; bot.attention = "phone"; bot.refreshToolGate();
  async function autonomous(name: string, args: Record<string, unknown> = {}) {
    const call: ToolCallRecord = { id: context.nextToolId(), role: "agent", name, arguments: args, issuedAt: now, expectedAt: now };
    await context.appendToolCall(call); await bot.dispatch(call); await bot.scheduler.whenSettled(call.id);
    const events = bot.mailbox.filter((event: BotEvent) => event.refToolCallId === call.id) as BotEvent[];
    assert.ok(events.length, `${name} must return an actual receipt`);
    await bot.drainMailbox(false);
    return { text: events.map(event => event.content).join("\n"), events };
  }
  async function operator(name: string, args: Record<string, unknown> = {}, stealth = false) {
    const result = await bot.injectExternalToolCall(name, args, { stealth });
    await bot.drainMailbox(false); return result;
  }
  function tools() { return bot.currentToolNames() as string[]; }
  function manual() { return bot.manualTools().map((tool: { name: string }) => tool.name) as string[]; }
  function calls() { return context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call] : []); }
  return { bot, apps, notify, settings, context, phone, operatorContexts, autonomous, operator, tools, manual, calls,
    advance(tu: number) { now += tu; }, chatReads: () => chatReads,
    async close() { await bot.stop(); await apps.closeAll(); },
  };
}

async function operatorAndAutonomousBoundaries(base: string) {
  const f = await fixture(path.join(base, "locked"), false, false);
  try {
    assert.ok(!f.tools().includes("channel_notify")); assert.ok(!f.manual().includes("channel_notify"));
    assert.ok(!f.manual().includes("notification_settings"), "Settings tools require opening Settings");
    await f.context.appendEvent({ id: "fixture-notification", source: "koishi", worldTime: 100,
      originEventIds: ["chat-notice:fixture"], content: "手机振动了一下。" });
    for (const mode of [undefined, "avatar", "puppet"] as const) {
      const option = f.bot.actionOpportunities(mode).find((item: any) => item.call?.name === "open_app");
      assert.ok(option, "a delivered anonymous phone signal supplies an app-opening opportunity");
      assert.ok(!f.bot.actionOpportunities(mode).some((item: any) => item.call?.name === "pick_up_phone"), "already holding a usable phone does not suggest repeatedly taking it");
      assert.equal(option.call.arguments.name, CHAT_NAME, "model and human action menus use the configured display name");
    }
    assert.equal((await f.operator("channel_notify", { id: CHANNEL, allow: false })).ok, false);
    assert.equal((await f.operator("open_app", { name: CHAT_NAME })).ok, true);
    assert.ok(f.manual().includes("channel_notify"), "manual chat tools contain channel control despite autonomous permission disabled");
    assert.ok(!f.tools().includes("channel_notify"), "operator capability cannot leak into autonomous definitions");
    assert.equal((await f.operator("channel_notify", { id: CHANNEL, allow: false })).ok, true);
    assert.equal(f.notify.channelPolicy(CHANNEL).enabled, false);
    assert.match((await f.autonomous("channel_notify", { id: CHANNEL, allow: true })).text, /不可用|管理员/);
    assert.equal(f.notify.channelPolicy(CHANNEL).enabled, false);
    assert.equal((await f.operator("channel_notify", { id: CHANNEL, allow: true, mute_seconds: 60 }, true)).ok, true,
      "stealth WebUI operator has the same independent management permission");
    assert.equal(f.notify.channelPolicy(CHANNEL).mutedUntil, 130);
    await f.operator("close_app");
    assert.ok(!f.manual().includes("channel_notify"), "closing chat immediately removes manual channel settings");
    assert.ok(!(f.bot.navigableToolNames() as string[]).includes("channel_notify"), "seeing an operator capability does not grant autonomous navigation permission");
    assert.equal((await f.operator("channel_notify", { id: CHANNEL, allow: false })).ok, false);
    assert.equal((await f.operator("open_app", { name: "settings" })).ok, true);
    assert.ok(f.manual().includes("notification_settings"));
    assert.equal((await f.operator("notification_settings", { action: "mode", mode: "off" })).ok, true);
    assert.equal(f.notify.notificationMode, "off"); assert.equal(f.operatorContexts.at(-1), true);
    assert.match((await f.autonomous("notification_settings", { action: "mode", mode: "silent", operator: true })).text, /管理员|不能自行/,
      "model arguments cannot forge operator context");
    assert.equal(f.notify.notificationMode, "off"); assert.equal(f.operatorContexts.at(-1), false);
    assert.equal((await f.operator("notification_settings", { action: "app", app: CHAT_NAME, enabled: false, mute_seconds: 80 })).ok, true);
    assert.deepEqual([f.notify.appPolicy("chat").enabled, f.notify.appPolicy("chat").mutedUntil], [false, 140]);
    assert.equal(f.notify.appPolicy("camera").enabled, true);
    assert.match((await f.autonomous("notification_settings", { action: "list" })).text, /自定义信使/, "Bot can inspect settings without permission to change them");
    assert.equal((await f.operator("phone_notifications", { action: "mode", mode: "vibrate" })).ok, false,
      "retired notification-center mutation cannot bypass Settings");
    await f.operator("close_app");
    assert.ok(!f.manual().includes("notification_settings"));
    assert.equal((await f.operator("notification_settings", { action: "mode", mode: "vibrate" })).ok, false);
    const before = f.calls().length;
    assert.equal(await f.bot.prepareNavigation({ name: "notification_settings", arguments: { action: "mode", mode: "silent" } }, () => true), undefined,
      "a learned settings tool can reopen its owner without an extra model roundtrip");
    assert.deepEqual(f.calls().slice(before).map(call => call.name), ["open_app"]);
    assert.equal(f.apps.view()?.id, "settings");
    assert.match((await f.autonomous("notification_settings", { action: "app", app: "chat", enabled: true })).text, /管理员|不能自行/);
    assert.equal(f.notify.appPolicy("chat").enabled, false, "automatic navigation never bypasses app management permission");
  } finally { await f.close(); }
}

async function independentPermissions(base: string) {
  for (const [channelManaged, appsManaged] of [[true, false], [false, true], [true, true]]) {
    const f = await fixture(path.join(base, `permissions-${channelManaged}-${appsManaged}`), channelManaged!, appsManaged!);
    try {
      const opened = await f.autonomous("open_app", { name: "chat" });
      assert.match(opened.text, new RegExp(CHAT_NAME));
      const parts = opened.events.flatMap(event => event.parts ?? []).map(part => "text" in part ? part.text : "").join("");
      assert.match(parts, new RegExp(`${CHAT_NAME} · 消息列表`)); assert.match(parts, /群消息列表正文/);
      assert.match(f.context.renderStreamText(), new RegExp(`${CHAT_NAME} · 消息列表`), "ordered content projection retains configured app identity");
      assert.equal(f.tools().includes("channel_notify"), channelManaged);
      const channel = await f.autonomous("channel_notify", { id: CHANNEL, mute_seconds: 600 });
      assert.equal(f.notify.channelPolicy(CHANNEL).muted, channelManaged, channel.text);
      await f.autonomous("close_app");
      assert.ok(!f.manual().includes("channel_notify"));
      if (channelManaged) {
        const before = f.calls().length;
        assert.equal(await f.bot.prepareNavigation({ name: "channel_notify", arguments: { id: CHANNEL, mute_seconds: 120 } }, () => true), undefined);
        assert.ok(f.calls().slice(before).some(call => call.name === "open_app" && call.arguments.name === CHAT_NAME));
        await f.autonomous("channel_notify", { id: CHANNEL, mute_seconds: 120 });
        assert.equal(f.notify.channelPolicy(CHANNEL).mutedUntil, 160);
      }
      await f.autonomous("open_app", { name: "设置" });
      const result = await f.autonomous("notification_settings", { action: "app", app: CHAT_NAME, mute_seconds: 90 });
      assert.equal(f.notify.appPolicy("chat").muted, appsManaged, result.text);
      assert.equal(f.operatorContexts.at(-1), false);
      if (appsManaged) {
        f.advance(45); assert.equal(f.notify.appPolicy("chat").muted, false, "world clock expiry restores app permission");
        await f.autonomous("close_app");
        assert.equal(await f.bot.prepareNavigation({ name: "notification_settings", arguments: { action: "app", app: "camera", enabled: false } }, () => true), undefined);
        await f.autonomous("notification_settings", { action: "app", app: "camera", enabled: false });
        assert.equal(f.notify.appPolicy("camera").enabled, false, "learned settings tools execute through reopened owner");
      }
    } finally { await f.close(); }
  }
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-notification-access-"));
  try {
    await independentPermissions(base); await operatorAndAutonomousBoundaries(base);
    console.log("PASS notification tool access: independent Bot/operator permissions, real app ownership, timed settings, learned navigation, no privilege spoofing and rich configured chat identity");
  } finally { await fs.rm(base, { force: true, recursive: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
