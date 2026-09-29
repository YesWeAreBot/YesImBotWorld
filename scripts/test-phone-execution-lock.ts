/** Shared phone commit fences and real Bot device operations; isolated local fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { AppManager } from "../src/apps/manager.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { applyPhonePhysicalState, phoneExecutionStamp, setPhoneDown, withPhoneExecutionLock } from "../src/phone-state.js";
import type { PhoneStatus, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 1500 && !check(); n++) await pause(2);
  assert.ok(check(), label);
}
const LOST = { reachable: false, location: "屋内", usable: true, perceptible: true };
let stage = "identity";

async function runtimeOnlyIdentityAndSerialCommit() {
  const phone: PhoneStatus = { down: true }, original = JSON.stringify(phone), initial = phoneExecutionStamp(phone);
  setPhoneDown(phone, true); assert.equal(phoneExecutionStamp(phone), initial, "no-op posture writes do not invalidate inferences");
  setPhoneDown(phone, false); const held = phoneExecutionStamp(phone); assert.notEqual(held, initial);
  setPhoneDown(phone, true); assert.notEqual(phoneExecutionStamp(phone), initial, "pickup/put-down ABA must invalidate the sampled input");
  assert.equal(JSON.stringify(phone), original, "revision and locks never become saved phone fields");
  const beforePhysical = phoneExecutionStamp(phone); applyPhonePhysicalState(phone, LOST);
  assert.notEqual(phoneExecutionStamp(phone), beforePhysical, "physical state participates in the identity");
  const unchanged = phoneExecutionStamp(phone); applyPhonePhysicalState(phone, LOST); assert.equal(phoneExecutionStamp(phone), unchanged);
  setPhoneDown(phone, false); const impossibleHeld = phoneExecutionStamp(phone); applyPhonePhysicalState(phone, LOST);
  assert.equal(phone.down, true); assert.notEqual(phoneExecutionStamp(phone), impossibleHeld, "physical loss uses the same posture revision");

  const release = gate(), entered = gate(), order: string[] = [];
  const first = withPhoneExecutionLock(phone, async () => { order.push("first"); entered.resolve(); await release.promise; throw Error("fixture commit failed"); });
  const failed = assert.rejects(first, /fixture commit failed/); await entered.promise;
  const second = withPhoneExecutionLock(phone, () => { order.push("second"); return 2; });
  const third = withPhoneExecutionLock(phone, () => { order.push("third"); return 3; });
  await withPhoneExecutionLock({ down: true }, () => { order.push("other-phone"); });
  assert.deepEqual(order, ["first", "other-phone"], "a pending local commit blocks only that phone");
  release.resolve(); await failed; assert.equal(await second, 2); assert.equal(await third, 3);
  assert.deepEqual(order, ["first", "other-phone", "second", "third"], "failed work releases the FIFO queue");
}

async function fixture(down: boolean, options: { closeGate?: Promise<void>; focusGate?: Promise<void>; focusFails?: boolean; app?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-phone-execution-"));
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files); await context.load();
  const cfg = Config({ autoStart: false }); cfg.bot.growth.enabled = false; cfg.bot.spillMinChars = 0;
  const defs = BOT_TOOLS.filter(tool => ["pick_up_phone", "put_down_phone", "open_app", "close_app", "observe_device", "think"].includes(tool.name));
  const closeEntered = gate(), focusEntered = gate(); let closed = false;
  const app: any = { id: "notes", name: "记事本", description: "本地测试应用", async open() { return { tools: [], opening: "记事本" }; },
    async close() { closeEntered.resolve(); await options.closeGate; closed = true; }, async call() { return "本地结果"; } };
  const apps = new AppManager("chat", [app], new Set(defs.map(tool => tool.name)), logger);
  if (options.app) await apps.open(app);
  const phone: PhoneStatus = { down };
  const messenger: any = { async putDownPhone() { focusEntered.resolve(); await options.focusGate; if (options.focusFails) throw Error("本地关注存储失败"); return "关注已清除"; } };
  const clock: any = { now: () => 1, timeLine: () => "T1", realMsUntil: () => 0, unitRealSeconds: 1, unitWorldSeconds: 1 };
  const bot: any = new BotAgent(cfg, clock, files, context, {}, messenger, apps, null, null, phone, logger, defs);
  bot.running = true; bot.backend = { setToolNames() {}, setToolDefs() {} }; bot.refreshToolGate();
  async function autonomous(name: string) {
    const call: ToolCallRecord = { id: context.nextToolId(), role: "agent", name, arguments: {}, issuedAt: 1, expectedAt: 1 };
    await context.appendToolCall(call); await bot.dispatch(call); return call.id;
  }
  return { bot, phone, context, closeEntered, focusEntered, autonomous, closed: () => closed,
    async close() { await bot.stop(); await bot.scheduler.whenIdle(); await bot.receipts.settled(); await apps.closeAll(); await fs.rm(dir, { recursive: true, force: true }); } };
}

async function lockPhone(phone: PhoneStatus) {
  const entered = gate(), release = gate();
  const done = withPhoneExecutionLock(phone, async () => { entered.resolve(); await release.promise; });
  await entered.promise; return { release: release.resolve, done };
}

async function actualPickupRejectsStaleWorldAndABA() {
  const f = await fixture(true);
  try {
    const old = phoneExecutionStamp(f.phone);
    assert.equal((await f.bot.injectExternalToolCall("pick_up_phone")).ok, true); assert.equal(f.phone.down, false);
    const stale = await withPhoneExecutionLock(f.phone, () => {
      if (phoneExecutionStamp(f.phone) !== old) return false;
      applyPhonePhysicalState(f.phone, LOST); return true;
    });
    assert.equal(stale, false, "a World proposal based on an old execution stamp cannot overwrite the actual pickup");
    assert.equal(f.phone.down, false); assert.equal(f.phone.physical, undefined);
    assert.equal((await f.bot.injectExternalToolCall("put_down_phone")).ok, true); assert.equal(f.phone.down, true);
    assert.notEqual(phoneExecutionStamp(f.phone), old, "real Bot pickup/down cannot hide behind identical final posture");
  } finally { await f.close(); }
}

async function queuedPickupRechecksFactsAndLifecycle() {
  for (const change of ["physical", "stop", "takeover", "session"] as const) {
    stage = `queued pickup: ${change}`;
    const f = await fixture(true), lock = await lockPhone(f.phone);
    let result: Promise<any> | undefined, callId: string | undefined;
    let releasing: Promise<any> | undefined;
    try {
      if (change === "session") await f.bot.acquireResidentControl("puppet", "old-session");
      if (change === "takeover") callId = await f.autonomous("pick_up_phone");
      else result = f.bot.injectExternalToolCall("pick_up_phone", {}, change === "session" ? { control: { mode: "puppet", sessionId: "old-session" } } : {});
      await until(() => f.bot.deviceOperations === 1, "pickup has entered the real device queue and is waiting for the World commit lock");
      assert.equal(f.phone.down, true);
      if (change === "physical") applyPhonePhysicalState(f.phone, LOST); // the simulated World already owns lock
      if (change === "stop") await f.bot.stop();
      if (change === "takeover") { await f.bot.acquireManualControl(); f.bot.setManualPaused(false); }
      if (change === "session") {
        releasing = f.bot.releaseResidentControl("old-session", true);
        await until(() => f.bot.residentClosing, "controller closes admission before joining its unfinished operation");
      }
      lock.release(); await lock.done;
      if (result) assert.equal((await result).ok, false, `${change}: late queued pickup must be rejected`);
      else { await f.bot.scheduler.whenSettled(callId!); assert.ok(f.bot.mailbox.some((event: any) => /控制权已改变/.test(event.content))); }
      assert.equal(f.phone.down, true, `${change}: validation happens after waiting for the lock`);
      await releasing;
    } finally { lock.release(); await lock.done; await result; await releasing; await f.close(); }
  }
}

async function slowIoDoesNotOwnPhoneCommitLock() {
  const closeGate = gate(), focusGate = gate();
  const f = await fixture(false, { app: true, closeGate: closeGate.promise, focusGate: focusGate.promise });
  let operation: Promise<any> | undefined;
  try {
    const original = phoneExecutionStamp(f.phone); operation = f.bot.injectExternalToolCall("put_down_phone"); await f.closeEntered.promise;
    let entered = false; await withPhoneExecutionLock(f.phone, () => { entered = true; });
    assert.ok(entered, "World commit can enter while an external application is still closing");
    assert.equal(phoneExecutionStamp(f.phone), original); assert.equal(f.phone.down, false);
    closeGate.resolve(); await f.focusEntered.promise;
    assert.equal(f.phone.down, true); assert.equal(f.closed(), true);
    await withPhoneExecutionLock(f.phone, () => { assert.equal(f.phone.down, true); });
    assert.notEqual(phoneExecutionStamp(f.phone), original, "local posture is committed before slow focus bookkeeping");
    focusGate.resolve(); const result = await operation; assert.equal(result.ok, true); assert.match(result.text, /手机已放下.*记事本.*已关闭/);
  } finally { closeGate.resolve(); focusGate.resolve(); await operation; await f.close(); }

  const failed = await fixture(false, { focusFails: true });
  try {
    const result = await failed.bot.injectExternalToolCall("put_down_phone");
    assert.equal(result.ok, true); assert.equal(failed.phone.down, true);
    assert.match(result.text, /手机已放下/); assert.match(result.text, /关注更新失败/);
    assert.doesNotMatch(result.text, /手机持有操作没有执行|工具 put_down_phone失败/);
  } finally { await failed.close(); }
}

async function closedAppIsNotErasedByLateRejection() {
  const f = await fixture(false, { app: true }), lock = await lockPhone(f.phone);
  const operation = f.bot.injectExternalToolCall("put_down_phone");
  try {
    await until(() => f.closed(), "application close finishes before queued local posture change");
    await f.bot.stop(); lock.release(); await lock.done;
    const result = await operation;
    assert.equal(result.ok, false); assert.equal(f.phone.down, false);
    assert.match(result.text, /记事本.*已关闭/); assert.match(result.text, /手机持有操作没有执行/);
  } finally { lock.release(); await lock.done; await operation; await f.close(); }
}

async function main() {
  await runtimeOnlyIdentityAndSerialCommit(); stage = "real gestures"; await actualPickupRejectsStaleWorldAndABA(); await queuedPickupRechecksFactsAndLifecycle();
  stage = "slow IO"; await slowIoDoesNotOwnPhoneCommitLock(); stage = "partial completion"; await closedAppIsNotErasedByLateRejection();
  console.log("PASS phone execution lock: runtime-only ABA stamps, no-op stability, FIFO/failure release, real pickup/down, queued physical/lifecycle/control revalidation, short commit sections and truthful partial/completed operations");
}
const watchdog = setTimeout(() => { console.error(`Phone execution test timed out: ${stage}`); process.exit(1); }, 15000);
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
