/** Offline Bot dispatch, device state and compression boundaries. No model or platform requests. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { ComputerDevice } from "../src/apps/computerDevice.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { toNativeToolDefs } from "../src/bot/nativeTools.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(test: () => boolean) { for (let i = 0; i < 300 && !test(); i++) await tick(); assert.ok(test(), "local task did not finish"); }
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-tool-state-"));
  let agent: any;
  try {
    const files = new WorldFiles(dir); await files.ensure();
    const cfg = Config({ autoStart: false }); cfg.bot.retryDelayMs = 1;
    const clock: any = { syncRealTime: true, now: () => 1, timeLine: () => "T=1", realMsUntil: (at: number) => at > 1 ? 60000 : 0, unitRealSeconds: 1, unitWorldSeconds: 1 };
    const context = new BotContext(files, "outdated default tools"); await context.load();
    const phone = { down: false };
    let calls = 0, location: string | null = null, compressFails = false;
    const app = {
      id: "fixture", name: "Fixture", description: "offline", connected: false,
      async open() { this.connected = true; return { tools: [{ name: "fixture_read", description: "read selected item", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }] }; },
      async close() { this.connected = false; },
      async call() { calls++; return "visible item"; },
    };
    const apps = new AppManager("chat", [app], new Set(BOT_TOOLS.map(def => def.name)), logger);
    const computer = new ComputerDevice({} as any, null, null, {} as any, files, clock, { ...cfg.apps.computer, mode: "off" }, new Set(), logger, undefined, true);
    assert.equal(computer.available, false, "real world computer mode off is unavailable even though the device object exists");
    const virtual = new ComputerDevice({} as any, null, null, {} as any, files, clock, { ...cfg.apps.computer, mode: "off" }, new Set(), logger, undefined, false);
    assert.equal(virtual.available, true, "fictional computers do not require a real implementation");
    const world: any = { compress: async () => { if (compressFails) throw new Error("offline compression failure"); return { historySummary: "compressed fixture", memoryDigest: "fixture facts" }; } };
    agent = new BotAgent(cfg, clock, files, context, world, {} as any, apps, computer, null, phone, logger, BOT_TOOLS,
      { location: () => location, voluntaryWorlds: () => ["Destination"], travelTo: async name => name, goHome: async () => "home" });
    agent.running = true;
    let allowed: string[] = [], resets = 0;
    agent.backend = { setToolNames(names: string[]) { allowed = [...names]; }, setToolDefs() {}, resetToolSnapshot() { resets++; } };
    agent.refreshToolGate();
    const has = (name: string) => allowed.includes(name);
    assert.ok(has("put_down_phone") && !has("pick_up_phone"));
    for (const name of ["close_app", "open_computer", "close_computer", "cancel", "go_home", "exit_forward", "channel_notify"]) assert.equal(has(name), false, name);
    assert.ok(has("travel"));
    assert.match(context.pinned.toolsText!, /put_down_phone/);
    assert.doesNotMatch(context.pinned.toolsText!, /- pick_up_phone\(/);
    assert.equal(agent.mailbox.length, 0, "fresh context initializes without a redundant capability event");
    await context.appendEvent({ id: context.nextEventId(), source: "system", content: "original observation", worldTime: 1 });
    const first = await context.toChatMessages("original clock");
    const prefix = first[0]!.content;
    const nativePrefix = await context.nativeToolSnapshot("original clock", toNativeToolDefs(BOT_TOOLS.filter(def => has(def.name))));
    const capabilityEvents = () => context.stream.flatMap(entry => entry.kind === "event" && entry.event.toolAvailability ? [entry.event] : []);

    agent.attention = "phone"; await apps.open(app); agent.refreshToolGate();
    assert.ok(has("fixture_read") && has("close_app"));
    assert.equal(agent.mailbox.length, 0, "live gate updates do not announce intermediate scheduler states");
    await agent.drainMailbox();
    assert.ok(context.stream.some(entry => entry.kind === "event" && /现在新增可用/.test(entry.event.content) && /fixture_read/.test(entry.event.content)));
    const next = await context.toChatMessages("later clock");
    assert.equal(next[0]!.content, prefix, "changing app eligibility does not rewrite the system prefix");
    assert.ok(String(next[1]!.content).startsWith(String(first[1]!.content)), "capability changes append to existing perceptions");
    const n = context.stream.length; agent.refreshToolGate(); await agent.drainMailbox();
    assert.equal(context.stream.length, n, "unchanged state must not append repeated capability notices");
    (apps as any).current.defs[0].inputSchema.properties.key.enum = ["alpha", "beta"];
    agent.refreshToolGate();
    await agent.drainMailbox();
    assert.ok(context.stream.some(entry => entry.kind === "event" && /参数或语义已更新/.test(entry.event.content) && /alpha/.test(entry.event.content)));
    assert.equal((await context.toChatMessages("T"))[0]!.content, prefix);
    agent.tempBannedTools.add("fixture_read"); agent.refreshToolGate(); assert.ok(!has("fixture_read"));
    agent.attention = null; agent.tempBannedTools.clear(); agent.refreshToolGate();
    assert.ok(has("fixture_read"), "temporary inhibition must not erase the last known device capability");
    await agent.drainMailbox();

    // A transport can die while the character looks away. Admin controls use live state;
    // the model retains its last observation until touching/looking at the device again.
    agent.attention = null; app.connected = false; agent.refreshToolGate();
    assert.ok(has("fixture_read")); assert.equal(agent.mailbox.length, 0);
    assert.ok(!agent.manualTools().some((tool: any) => tool.name === "fixture_read"));
    let serial = 0;
    const call = (name: string, args: Record<string, unknown> = {}, expectedAt = 1): ToolCallRecord => ({ id: `state_${++serial}`, role: "agent", name, arguments: args, issuedAt: 1, expectedAt });
    const stale = call("fixture_read", { key: "alpha" }); await agent.dispatch(stale);
    await until(() => !agent.scheduler.isPending(stale.id));
    assert.equal(calls, 0, "stale generated tool is rejected before any app effect");
    assert.equal(agent.deviceAttention, "phone"); assert.ok(!has("fixture_read"));
    assert.ok(agent.mailbox.some((event: any) => /设备界面已改变/.test(event.content)));
    await agent.drainMailbox();
    assert.ok(context.stream.some(entry => entry.kind === "event" && /当前界面收起.*fixture_read/.test(entry.event.content)), "known app operations retain a reopen path while the current interface is unavailable");
    await apps.closeCurrent(); agent.refreshToolGate(); assert.ok(!has("close_app"));
    phone.down = true; agent.refreshToolGate(); assert.ok(has("pick_up_phone") && !has("put_down_phone"));
    phone.down = false; agent.refreshToolGate(); assert.ok(!has("pick_up_phone") && has("put_down_phone"));
    agent.phoneUi = { chatOpen: true, channelKey: "fixture:chat", channelIsGroup: true, forwardStack: [] };
    agent.attention = "phone"; agent.refreshToolGate(); assert.ok(!has("exit_forward"));
    agent.phoneUi.forwardStack.push("msg:123"); agent.refreshToolGate(); assert.ok(has("exit_forward"));
    agent.phoneUi.forwardStack = []; agent.refreshToolGate(); assert.ok(!has("exit_forward"));

    await agent.drainMailbox();
    const beginCooperativeTask = () => {
      const task = call("recall_growth");
      let finish!: () => void;
      const completed = new Promise<void>(resolve => { finish = resolve; });
      agent.schedule(task, { executeAt: "now", cancellation: "cooperative", run: async (control: any) => {
        await completed;
        assert.ok(control.beginCommit());
        return "offline local operation completed";
      } });
      assert.ok(has("cancel"), "the real scheduler exposes its uncommitted operation immediately");
      return { task, finish };
    };
    // The same real operation can begin and finish before the next generation boundary.
    // Its live gate must change, but neither intermediate state belongs in model history.
    const beforeTransient = capabilityEvents().length;
    const transient = beginCooperativeTask();
    await agent.drainMailbox(false);
    assert.equal(capabilityEvents().length, beforeTransient, "an early mailbox drain before throttle/rest does not announce capabilities yet");
    transient.finish();
    await until(() => !agent.scheduler.isPending(transient.task.id));
    assert.equal(has("cancel"), false);
    await agent.drainMailbox();
    assert.equal(capabilityEvents().length, beforeTransient, "an unobserved begin/end pair must not create cancel capability chatter");

    const ongoing = beginCooperativeTask();
    await agent.drainMailbox();
    const firstCancel = capabilityEvents().at(-1)!;
    assert.ok(firstCancel.toolAvailability!.definitions.cancel, "a task still cancellable at a generation boundary declares cancel once");
    assert.match(firstCancel.content, /- cancel\(id: string\)/);
    const afterFirstCancel = capabilityEvents().length;
    await agent.drainMailbox();
    assert.equal(capabilityEvents().length, afterFirstCancel, "the same pending task does not repeat its declaration");
    ongoing.finish(); await until(() => !agent.scheduler.isPending(ongoing.task.id));
    await agent.drainMailbox();
    assert.ok(capabilityEvents().at(-1)!.toolAvailability!.removed.includes("cancel"));
    assert.doesNotMatch(capabilityEvents().at(-1)!.content, /- cancel\(/);

    const secondOngoing = call("recall_growth", {}, 60);
    agent.schedule(secondOngoing, { executeAt: "expected", run: async () => "must be cancelled first" });
    await agent.drainMailbox();
    const restoredCancel = capabilityEvents().at(-1)!;
    assert.ok(restoredCancel.toolAvailability!.restored.includes("cancel"));
    assert.match(restoredCancel.content, /恢复可用：cancel。/);
    assert.doesNotMatch(restoredCancel.content, /- cancel\(|原生 function|参数 JSON Schema/);
    await agent.dispatch(call("cancel", { id: secondOngoing.id }));
    assert.equal(agent.scheduler.isPending(secondOngoing.id), false, "a briefly declared cancellation capability still uses the real dispatch path");
    await agent.drainMailbox();

    // Simulate a caller observing a write failure after the journal actually committed.
    // Retrying must reuse the pending event ID and the context's idempotent append path.
    const appendEvent = context.appendEvent.bind(context);
    const attemptedIds: string[] = [];
    let failAfterJournal = true;
    context.appendEvent = async event => {
      await appendEvent(event);
      if (!event.toolAvailability?.removed.includes("recall_growth")) return;
      attemptedIds.push(event.id);
      if (failAfterJournal) { failAfterJournal = false; throw Error("fixture failure after capability journal append"); }
    };
    try {
      agent.tempBannedTools.add("recall_growth"); agent.refreshToolGate();
      const beforeFailedAppend = capabilityEvents().length;
      await assert.rejects(agent.drainMailbox(), /fixture failure after capability journal append/);
      assert.ok(agent.pendingCapabilityNotice, "a failed caller keeps the exact notice available for retry");
      assert.ok(agent.capabilityAnnouncements.names.includes("recall_growth"), "delivery knowledge is not advanced after a failed append call");
      assert.equal(capabilityEvents().length, beforeFailedAppend + 1, "the fixture did commit its journal entry before throwing");
      const pendingId = agent.pendingCapabilityNotice.id;
      await agent.drainMailbox();
      assert.deepEqual(attemptedIds, [pendingId, pendingId]);
      assert.equal(agent.pendingCapabilityNotice, null);
      assert.equal(agent.capabilityAnnouncements.names.includes("recall_growth"), false);
      assert.equal(capabilityEvents().length, beforeFailedAppend + 1, "successful retry cannot duplicate the already stored capability event");
      const diskEntries = (await fs.readFile(files.stream, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(diskEntries.filter(entry => entry.kind === "event" && entry.event.id === pendingId).length, 1, "the append-only journal also contains one copy");
    } finally { context.appendEvent = appendEvent; }
    agent.tempBannedTools.delete("recall_growth"); agent.refreshToolGate(); await agent.drainMailbox();
    assert.ok(capabilityEvents().at(-1)!.toolAvailability!.restored.includes("recall_growth"));

    // A recreated announcer reconstructs the current window instead of re-explaining every
    // available tool or replacing either half of the provider's fixed system/native prefix.
    const beforeRecreation = await context.toChatMessages("before restart");
    const beforeRecreationNotices = capabilityEvents().length;
    agent.capabilityAnnouncements = null;
    await agent.drainMailbox();
    assert.equal(capabilityEvents().length, beforeRecreationNotices);
    assert.deepEqual(await context.toChatMessages("after restart"), beforeRecreation);
    assert.equal((await context.toChatMessages("after restart"))[0]!.content, prefix);
    assert.deepEqual(await context.nativeToolSnapshot("after restart", []), nativePrefix, "an empty or changed candidate cannot rewrite frozen native declarations");

    const pending = call("observe", {}, 60);
    agent.schedule(pending, { executeAt: "expected", run: async () => "must never execute" });
    assert.ok(has("cancel"));
    agent.scheduler.cancel(pending.id); agent.refreshToolGate(); assert.ok(!has("cancel"));
    const hiddenPending = call("observe", {}, 60); agent.stealthCalls.add(hiddenPending.id);
    agent.scheduler.schedule(hiddenPending, { executeAt: "expected", run: async () => "hidden" }); agent.refreshToolGate();
    assert.ok(!has("cancel"), "hidden human work cannot leak through cancel availability");
    const visiblePending = call("recall_growth", {}, 60);
    agent.schedule(visiblePending, { executeAt: "expected", run: async () => "visible" });
    assert.ok(has("cancel"), "an unrelated visible task makes the cancellation tool legitimately available");
    await agent.drainMailbox();
    const guessed = call("cancel", { id: hiddenPending.id });
    await agent.dispatch(guessed);
    assert.equal(agent.scheduler.isPending(hiddenPending.id), true, "guessing a hidden operation ID must not cancel it even while cancel is available");
    assert.equal(agent.scheduler.isPending(visiblePending.id), true);
    assert.ok(agent.stealthCalls.has(hiddenPending.id));
    assert.ok(agent.mailbox.some((event: any) => event.refToolCallId === guessed.id && /找不到进行中的/.test(event.content)));
    await agent.dispatch(call("cancel", { id: visiblePending.id }));
    assert.equal(agent.scheduler.isPending(visiblePending.id), false);
    assert.equal(has("cancel"), false, "only the undisclosed task remains and must not keep cancel visible");
    agent.scheduler.cancel(hiddenPending.id); agent.stealthCalls.delete(hiddenPending.id);
    location = "Destination"; agent.refreshToolGate(); assert.ok(has("go_home") && !has("travel"));
    const journey = call("go_home", {}, 60);
    agent.schedule(journey, { executeAt: "expected", run: async () => "home" });
    assert.ok(!has("go_home") && !has("travel"));
    assert.ok(agent.currentToolNames(journey.id).includes("go_home"), "queued travel must not invalidate itself at execution");
    agent.scheduler.cancel(journey.id); location = null; agent.refreshToolGate();

    agent.tempBannedTools.add("act"); agent.refreshToolGate(); await agent.drainMailbox();
    context.requestAttachmentCompaction(); compressFails = true;
    await agent.compactContext("overflow");
    assert.equal(resets, 0); assert.equal(context.attachmentBudgetExceeded, true);
    assert.equal((await context.toChatMessages("T"))[0]!.content, prefix);
    assert.ok(!has("act"), "failed compression retains temporary bans");
    compressFails = false;
    await agent.compactContext("overflow");
    assert.equal(resets, 1); assert.equal(context.attachmentBudgetExceeded, false);
    assert.ok(has("act")); assert.match(context.pinned.toolsText!, /- act\(/);
    assert.doesNotMatch(context.pinned.toolsText!, /- open_computer\(/);
    assert.notEqual((await context.toChatMessages("new clock"))[0]!.content, prefix);
    console.log("PASS dynamic tools: meaningful states, independent live/perceived device gates, schema events, stale-dispatch protection and compression-only prefix/native refresh");
  } finally { await agent?.stop(); await fs.rm(dir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
