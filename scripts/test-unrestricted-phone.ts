import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { AppManager } from "../src/apps/manager.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { applyPhonePhysicalState, canUsePhone } from "../src/phone-state.js";
import { planToolNavigation } from "../src/bot/navigation.js";
import type { PhonePhysicalState, PhoneStatus } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const blocked: PhonePhysicalState = { reachable: false, usable: false, perceptible: false, location: "遗落在远处，机身损坏" };
const dirs: string[] = [], agents: BotAgent[] = [], worlds: NarrativeWorld[] = [];
async function fixture(unrestricted = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-phone-access-")); dirs.push(dir);
  const files = new WorldFiles(dir); await files.ensure();
  const cfg = Config({ autoStart: false }); cfg.bot.unrestrictedPhone = unrestricted; cfg.bot.growth.enabled = false;
  const clock: any = { now: () => 100, timeLine: () => "T100", realMsUntil: () => 0, unitWorldSeconds: 1, unitRealSeconds: 1, syncRealTime: false };
  const world = new NarrativeWorld(files, clock, async () => { throw new Error("phone access must not request model generation"); }); worlds.push(world);
  const store = await world.store();
  await store.commit({ idempotencyKey: "seed", source: "initialize", initialized: true, worldState: "手机遗落在远处，机身损坏。",
    actors: { bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在窗边。", perception: "手机在远处。" } }, phoneState: blocked });
  const phone: PhoneStatus = { down: true }; applyPhonePhysicalState(phone, store.snapshot().phoneState);
  world.phoneStatusProvider = () => phone;
  const context = new BotContext(files); await context.load();
  const apps = new AppManager("QQ", [], new Set(BOT_TOOLS.map(tool => tool.name)), logger);
  const messenger: any = { resolveKey: async (key: string) => ({ key, isPrivate: true }),
    recentChannels: async () => ({ text: "真实的消息列表。", originEventIds: [] }),
    channelMessages: async () => ({ text: "真实的会话内容。", originEventIds: [] }) };
  const bot = new BotAgent(cfg, clock, files, context, world as any, messenger, apps, null, null, phone, logger, BOT_TOOLS) as any;
  agents.push(bot); bot.running = true;
  store.subscribe(event => {
    if (event.topic === "world.committed" && (event.payload as any).phoneStateChanged) {
      applyPhonePhysicalState(phone, store.snapshot().phoneState);
      bot.phonePhysicalStateChanged();
    }
  });
  bot.refreshToolGate();
  return { bot, context, cfg, phone, world, store, files };
}

async function main() {
  try {
    const f = await fixture();
    const prefix = await f.context.toChatMessages("initial");
    const oldJournal = await fs.readFile(f.files.narrativeJournal, "utf8");
    assert.ok(f.bot.currentToolNames().includes("pick_up_phone"), "physical loss cannot remove the recovery entry point");
    const result = await f.bot.injectExternalToolCall("pick_up_phone");
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /已拿到可正常使用的手机/);
    assert.ok(canUsePhone(f.phone));
    assert.deepEqual(f.store.snapshot().phoneState, { reachable: true, usable: true, perceptible: true, location: "持有者手中" });
    const reopened = await NarrativeStore.open(f.files.base, { now: () => 100 });
    assert.deepEqual(reopened.snapshot().phoneState, f.store.snapshot().phoneState, "successful pickup must survive restart");
    assert.ok((await fs.readFile(f.files.narrativeJournal, "utf8")).startsWith(oldJournal), "the earlier loss remains historical fact");
    await f.bot.drainMailbox();
    assert.deepEqual((await f.context.toChatMessages("later")).slice(0, prefix.length), prefix);
    const sequence = f.store.snapshot().sequence;
    const again = await f.bot.injectExternalToolCall("pick_up_phone");
    assert.equal(again.ok, true); assert.match(again.text, /本来就在你手里/);
    assert.equal(f.store.snapshot().sequence, sequence, "a healthy held phone needs no repeated restoration commit");

    const strict = await fixture(false);
    const denied = await strict.bot.injectExternalToolCall("pick_up_phone");
    assert.equal(denied.ok, false); assert.ok(!canUsePhone(strict.phone));
    assert.deepEqual(strict.store.snapshot().phoneState, blocked);

    const failure = await fixture();
    failure.world.restorePhoneAccess = async () => { throw new Error("模拟存储失败"); };
    const failed = await failure.bot.injectExternalToolCall("pick_up_phone");
    assert.equal(failed.ok, false); assert.match(failed.text, /模拟存储失败/);
    assert.ok(!canUsePhone(failure.phone)); assert.deepEqual(failure.store.snapshot().phoneState, blocked);

    const navigated = await fixture();
    const navigationError = await navigated.bot.prepareNavigation({ name: "send", arguments: { id: "fixture:private:peer", msg: "你好" } }, () => true);
    assert.equal(navigationError, undefined, JSON.stringify(navigated.context.stream.filter(entry => entry.kind === "event")));
    await navigated.bot.drainMailbox();
    assert.deepEqual(navigated.context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call.name] : []),
      ["pick_up_phone", "open_app", "select_channel"], "automatic prerequisites use the actual durable recovery path before opening a conversation");
    assert.ok(canUsePhone(navigated.phone));
    assert.equal(navigated.bot.phoneUi.channelKey, "fixture:private:peer");
    assert.equal(navigated.store.snapshot().phoneState?.usable, true);

    // Navigation only plans a real pickup; it does not silently modify world/device facts.
    const initial: PhoneStatus = { down: true, physical: blocked };
    const navState = { phone: initial, unrestrictedPhone: true, chatOpen: false, channelKey: null, channelIsGroup: false,
      chatApp: "QQ", builtin: true, device: "phone" as const };
    const plan = await planToolNavigation({ name: "send", arguments: { id: "fixture:private:peer", msg: "你好" } }, navState,
      async id => ({ key: id, isPrivate: true }));
    assert.deepEqual(plan.steps.map(step => step.name), ["pick_up_phone", "open_app", "select_channel"]);
    assert.deepEqual(initial, { down: true, physical: blocked });
    const missing = await planToolNavigation({ name: "send", arguments: { msg: "缺少目标" } }, navState,
      async () => { throw new Error("missing target must not trigger restoration or lookup"); });
    assert.match(missing.error!, /id/); assert.deepEqual(missing.steps, []);
    const noRestore = await planToolNavigation({ name: "send", arguments: { id: "fixture:private:peer", msg: "你好" } },
      { ...navState, unrestrictedPhone: false }, async id => ({ key: id, isPrivate: true }));
    assert.ok(noRestore.error); assert.deepEqual(noRestore.steps, []);
    console.log("PASS unrestricted phone: durable real pickup and receipt, unchanged history/prefix, strict mode, no fake success on storage failure, explicit automatic prerequisites and target validation");
  } finally {
    for (const bot of agents) await bot.stop();
    for (const world of worlds) await world.shutdown();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
