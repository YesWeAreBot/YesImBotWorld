/** Isolated control provenance and timer completion tests. No inference or external devices. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { ReceiptInbox } from "../src/bot/receipts.js";
import type { RichText, ToolCallRecord } from "../src/types.js";

const logger = { info() {}, warn() {}, error() {} } as any;
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check: () => boolean) { for (let i = 0; i < 300 && !check(); i++) await tick(); assert.ok(check(), "condition timed out"); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const image = { id: 91, type: "image" as const, mime: "image/png", file: "fixture.png" };
const screen: RichText = { text: "屏幕发生变化", attachments: [image], parts: [{ kind: "text", text: "屏幕发生变化" }, { kind: "media", ref: image, marker: "[图片#91]" }] };
const control = { mode: "avatar" as const, sessionId: "resident-test" };
function call(id: string, name: string, duration = 0): ToolCallRecord { return { id, role: "agent", name, arguments: {}, issuedAt: 0, expectedAt: duration, duration }; }

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "world-control-receipts-"));
  const agents: any[] = [];
  async function fixture() {
    const files = new WorldFiles(path.join(root, String(agents.length))); await files.ensure();
    const context = new BotContext(files); await context.load();
    context.attachmentLoader = async () => ({ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
    const cfg = Config({ autoStart: false }); cfg.bot.waitRateThreshold = 0;
    let time = 0;
    const clock: any = { now: () => time, realMsUntil: (t: number) => Math.max(0, (t - time) * 1000), timeLine: () => "T=" + time, unitRealSeconds: 1 };
    const agent: any = new BotAgent(cfg, clock, files, context, {} as any, {} as any, null, null, null, { down: false }, logger);
    agent.running = true;
    agents.push(agent);
    return { agent, context, cfg, files, advance: (t: number) => { time = t; } };
  }
  try {
    for (const name of ["wait", "rest"]) {
      const f = await fixture(); f.agent.residentControl = control;
      const pending = f.agent.injectExternalToolCall(name, name === "wait" ? { n: 300 } : {}, { duration: 300, control });
      await until(() => !!f.agent.waiting);
      const id = f.agent.waiting.callId;
      f.advance(7);
      f.agent.pushEvent("koishi", "有人叫你", { wake: true });
      const result = await pending;
      assert.equal(result.callId, id); assert.equal(result.ok, false);
      assert.match(result.text, /实际经过 7\.0 TU/);
      assert.equal(f.agent.externalToolResults.size, 0);
      assert.equal(f.agent.scheduler.isPending(id), false);
      assert.equal(f.agent.waiting, null);
    }

    const cancelled = await fixture(); cancelled.agent.residentControl = control;
    const pending = cancelled.agent.injectExternalToolCall("wait", { n: 300 }, { control });
    await until(() => !!cancelled.agent.waiting);
    const id = cancelled.agent.waiting.callId;
    cancelled.agent.dispatchCancel({ ...call("cancel-timer", "cancel"), arguments: { id } });
    assert.equal((await pending).ok, false);
    assert.equal(cancelled.agent.externalToolResults.size, 0);

    const live = await fixture();
    live.agent.residentControl = { ...control, mode: "puppet" };
    live.cfg.bot.waitRateThreshold = 10; live.cfg.bot.waitRateWindow = 100;
    live.agent.waitedWithin = () => 100;
    live.agent.dispatchWait(call("mind-wait", "wait", 300));
    assert.ok(live.agent.waiting, "body control permits quiet consciousness despite ordinary idle-rate guard");
    live.agent.puppetCalls.add("puppet-screen");
    live.agent.scheduler.schedule({ ...call("puppet-screen", "screen"), role: "system", control: { ...control, mode: "puppet" } }, { executeAt: "now", run: async () => screen });
    await until(() => !live.agent.scheduler.isPending("puppet-screen"));
    assert.equal(live.agent.waiting, null, "a perceived external body/device receipt wakes the existing consciousness");
    await live.agent.drainMailbox();
    const request = JSON.stringify(await live.context.toChatMessages("T=0"));
    assert.match(request, /并非你自主选择/);
    assert.match(request, /image_url/);
    const actual = live.context.stream.find((entry: any) => entry.kind === "event" && entry.event.refToolCallId === "puppet-screen") as any;
    assert.equal((actual.event.content.match(/并非你自主选择/g) || []).length, 1, "no double prefix across delivery and pushEvent");
    assert.equal((actual.event.parts.filter((part: any) => part.kind === "text").map((part: any) => part.text).join("").match(/并非你自主选择/g) || []).length, 1);

    const retired = await fixture(), finish = deferred<RichText>();
    retired.agent.puppetCalls.add("late-body");
    retired.agent.scheduler.schedule({ ...call("late-body", "screen"), role: "system", control: { ...control, mode: "puppet" } }, { executeAt: "now", run: () => finish.promise });
    assert.equal(retired.agent.scheduler.cancel("late-body"), "too_late");
    retired.agent.retired = true; retired.agent.scheduler.stopAll();
    finish.resolve(screen);
    await until(() => !retired.agent.scheduler.isPending("late-body"));
    await retired.agent.receipts.settled();
    const restored = new ReceiptInbox(retired.files.base), recovered: any[] = [];
    await restored.drain(async event => { recovered.push(event); });
    assert.equal(recovered.length, 1);
    assert.match(recovered[0].content, /并非你自主选择/);
    assert.match(recovered[0].parts[0].text, /并非你自主选择/);
    assert.equal(recovered[0].attachments[0].id, image.id);

    // A cancellation attempt after commit must not falsely resolve a still-running tool as cancelled.
    const committed = await fixture(), completion = deferred<string>(), response = deferred<any>();
    committed.agent.externalToolResults.set("committed", { resolve: response.resolve, systemText: null });
    committed.agent.scheduler.schedule(call("committed", "fake-effect"), { executeAt: "now", run: () => completion.promise });
    committed.agent.dispatchCancel({ ...call("cannot-cancel", "cancel"), arguments: { id: "committed" } });
    assert.ok(committed.agent.externalToolResults.has("committed"));
    completion.resolve("真实执行完成");
    assert.equal((await response.promise).ok, true);
    console.log("PASS control receipts: puppet multimodal agency survives late persistence, body feedback wakes awareness, interrupted manual wait/rest and cancel complete promises, committed effects remain real");
  } finally {
    for (const agent of agents) { await agent.stop(); await agent.controlAuditTail; }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
