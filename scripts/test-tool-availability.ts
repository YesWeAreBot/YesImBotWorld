/** Offline Bot dispatch, device state and compression boundaries. No model or platform requests. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { ComputerDevice } from "../src/apps/computerDevice.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
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

    agent.attention = "phone"; await apps.open(app); agent.refreshToolGate();
    assert.ok(has("fixture_read") && has("close_app"));
    assert.ok(agent.mailbox.some((event: any) => /现在新增可用/.test(event.content) && /fixture_read/.test(event.content)));
    await agent.drainMailbox();
    const next = await context.toChatMessages("later clock");
    assert.equal(next[0]!.content, prefix, "changing app eligibility does not rewrite the system prefix");
    assert.ok(String(next[1]!.content).startsWith(String(first[1]!.content)), "capability changes append to existing perceptions");
    const n = context.stream.length; agent.refreshToolGate(); await agent.drainMailbox();
    assert.equal(context.stream.length, n, "unchanged state must not append repeated capability notices");
    (apps as any).current.defs[0].inputSchema.properties.key.enum = ["alpha", "beta"];
    agent.refreshToolGate();
    assert.ok(agent.mailbox.some((event: any) => /参数或语义已更新/.test(event.content) && /alpha/.test(event.content)));
    await agent.drainMailbox();
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
    assert.ok(agent.mailbox.some((event: any) => /现在不可用.*fixture_read/.test(event.content)));
    assert.ok(agent.mailbox.some((event: any) => /设备界面已改变/.test(event.content)));
    await agent.drainMailbox();
    await apps.closeCurrent(); agent.refreshToolGate(); assert.ok(!has("close_app"));
    phone.down = true; agent.refreshToolGate(); assert.ok(has("pick_up_phone") && !has("put_down_phone"));
    phone.down = false; agent.refreshToolGate(); assert.ok(!has("pick_up_phone") && has("put_down_phone"));
    agent.phoneUi = { chatOpen: true, channelKey: "fixture:chat", channelIsGroup: true, forwardStack: [] };
    agent.attention = "phone"; agent.refreshToolGate(); assert.ok(!has("exit_forward"));
    agent.phoneUi.forwardStack.push("msg:123"); agent.refreshToolGate(); assert.ok(has("exit_forward"));
    agent.phoneUi.forwardStack = []; agent.refreshToolGate(); assert.ok(!has("exit_forward"));

    const pending = call("observe", {}, 60);
    agent.schedule(pending, { executeAt: "expected", run: async () => "must never execute" });
    assert.ok(has("cancel"));
    agent.scheduler.cancel(pending.id); agent.refreshToolGate(); assert.ok(!has("cancel"));
    const hiddenPending = call("observe", {}, 60); agent.stealthCalls.add(hiddenPending.id);
    agent.scheduler.schedule(hiddenPending, { executeAt: "expected", run: async () => "hidden" }); agent.refreshToolGate();
    assert.ok(!has("cancel"), "hidden human work cannot leak through cancel availability");
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
