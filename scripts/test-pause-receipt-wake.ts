/** Late receipts and queued perceptions must interrupt only the intended pause. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { ReceiptInbox } from "../src/bot/receipts.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent, RichText, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-pause-receipt-"));
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files, "固定说明"); await context.load();
  const cfg = Config({ autoStart: false }); cfg.bot.growth.enabled = false;
  Object.assign(cfg.bot, { restCompressMinChars: 1e9, maxWindowChars: 1e9, waitRateThreshold: 0 });
  let time = 100;
  const clock: any = { now: () => time, timeLine: () => "白天", unitWorldSeconds: 1,
    unitRealSeconds: 1, realMsUntil: () => 60_000 };
  const agent: any = new BotAgent(cfg, clock, files, context, {}, {} as any, null, null, null, { down: false }, logger, BOT_TOOLS);
  // Exercise the real durable drain without starting a model or a background loop.
  agent.running = true;
  const late = new ReceiptInbox(dir); await late.ready();
  function events(): BotEvent[] { return context.stream.flatMap(entry => entry.kind === "event" ? [entry.event] : []); }
  async function call(name: string): Promise<ToolCallRecord> {
    const value: ToolCallRecord = { id: context.nextToolId(), role: "agent", name,
      arguments: name === "wait" ? { n: 60 } : name === "rest" ? { duration: 60 } : {},
      issuedAt: time, expectedAt: time + 60, duration: 60 };
    await context.appendToolCall(value); return value;
  }
  async function pause(kind: "wait" | "rest" = "wait") {
    const value = await call(kind);
    if (kind === "wait") agent.dispatchWait(value); else agent.dispatchRest(value);
    assert.equal(agent.waiting?.callId, value.id); return value;
  }
  async function receipt(origin: ToolCallRecord, value: RichText = { text: "此前操作的真实回执。", originEventIds: [] }) {
    await late.save(value, time, origin.id);
    const names = await fs.readdir(late.directory);
    assert.equal(names.length, 1);
    const file = path.join(late.directory, names[0]!);
    const raw = await fs.readFile(file, "utf8");
    return { file, raw, id: JSON.parse(raw).event.id as string };
  }
  return { dir, agent, context, late, events, call, pause, receipt,
    advance: (seconds: number) => { time += seconds; },
    close: async () => { await agent.stop(); await late.settled(); await fs.rm(dir, { recursive: true, force: true }); } };
}

async function freshReceiptWakesButReplayDoesNot() {
  for (const kind of ["wait", "rest"] as const) {
    const f = await fixture();
    try {
      const origin = await f.call("send"), first = await f.pause(kind);
      f.advance(7);
      const saved = await f.receipt(origin);
      await f.agent.drainMailbox(false);
      assert.equal(f.agent.waiting, null, "a newly delivered real result interrupts the character's pause");
      assert.equal(f.agent.scheduler.isPending(first.id), false);
      assert.equal(f.agent.waitedWithin(0, 107), 7, "interruption charges only elapsed world time");
      assert.equal(f.events().filter(event => event.refToolCallId === first.id && event.content.startsWith("计时中断")).length, 1);
      assert.equal(f.events().filter(event => event.id === saved.id).length, 1);

      const second = await f.pause(kind);
      // Simulate a crash after append and before removing the saved receipt envelope.
      await fs.writeFile(saved.file, saved.raw);
      await f.agent.drainMailbox(false);
      assert.equal(f.agent.waiting?.callId, second.id, "a replayed event does not interrupt a later pause");
      assert.equal(f.agent.scheduler.isPending(second.id), true);
      assert.equal(f.events().filter(event => event.id === saved.id).length, 1, "replay is append-idempotent");
      assert.equal(f.events().filter(event => event.refToolCallId === second.id && event.content.startsWith("计时中断")).length, 0);
    } finally { await f.close(); }
  }
}

async function oldTimersAndInternalReceiptsStayQuiet() {
  for (const name of ["wait", "rest", "think", "reflect", "recall_growth", "recall", "help"]) {
    const f = await fixture();
    try {
      const previous = await f.call(name), current = await f.pause("rest");
      await f.receipt(previous);
      await f.agent.drainMailbox(false);
      assert.equal(f.agent.waiting?.callId, current.id, `${name} receipt cannot end a different timer`);
      assert.equal(f.agent.scheduler.isPending(current.id), true);
    } finally { await f.close(); }
  }
  for (const experience of [{ historicalWorld: true }, { internalThought: true }]) {
    const f = await fixture();
    try {
      const previous = await f.call("act"), current = await f.pause();
      await f.receipt(previous, { text: "历史或内心内容。", experience, originEventIds: [] });
      await f.agent.drainMailbox(false);
      assert.equal(f.agent.waiting?.callId, current.id, "historical and internal content stays quiet even with an action origin");
    } finally { await f.close(); }
  }
}

async function queuedPoliciesSurvivePauseCreation() {
  for (const source of ["world", "koishi"] as const) {
    for (const kind of ["wait", "rest"] as const) {
      const f = await fixture();
      try {
        // Delivered while inference is choosing a timer, before waiting has been set.
        f.agent.pushEvent(source, { text: "明确安静的感知。", originEventIds: [] }, { wake: false });
        const current = await f.pause(kind);
        await f.agent.drainMailbox(false);
        assert.equal(f.agent.waiting?.callId, current.id, "explicit quiet delivery remains quiet across the inference boundary");
        f.agent.dispatchCancel(await f.call("cancel").then(call => ({ ...call, arguments: { id: current.id } })));
        await f.agent.drainMailbox(false);

        f.agent.pushEvent(source, { text: "新的实际动静。", originEventIds: [`test:${source}:${kind}`] });
        const next = await f.pause(kind);
        await f.agent.drainMailbox(false);
        assert.equal(f.agent.waiting, null, "queued wake intent interrupts the pause chosen after arrival");
        assert.equal(f.agent.scheduler.isPending(next.id), false);
        assert.equal(f.events().filter(event => event.content === "新的实际动静。").length, 1);
      } finally { await f.close(); }
    }
  }
}

async function adoptedAccountMessagesInterruptPauses() {
  for (const kind of ["wait", "rest"] as const) {
    for (const unsupported of [false, true]) {
      for (const beforePause of [false, true]) {
        const f = await fixture();
        try {
          const text = `账号已发消息_${kind}_${unsupported}_${beforePause}`;
          const inject = () => f.agent.simulateExternalSend("fixture@self:private:friend", { text, originEventIds: [`account:${text}`] },
            "platform-message", unsupported ? null : { msg: text });
          // Both visible send arguments and unsupported message types can arrive
          // during inference, before its newly chosen wait/rest has been dispatched.
          if (beforePause) inject();
          const current = await f.pause(kind);
          if (!beforePause) inject();
          await f.agent.drainMailbox(false);
          assert.equal(f.agent.waiting, null, "an adopted completed account action interrupts the pause");
          assert.equal(f.agent.scheduler.isPending(current.id), false);
          const delivered = f.events().filter(event => event.content.includes(text));
          assert.equal(delivered.length, 1, "the actual sent content is delivered exactly once");
          assert.equal(delivered[0]!.source, unsupported ? "koishi" : "tool");
          const sends = f.context.stream.flatMap(entry => entry.kind === "tool_call" && entry.call.name === "send" ? [entry.call] : []);
          assert.equal(sends.length, unsupported ? 0 : 1, "unsupported message types do not invent a send tool invocation");
          if (!unsupported) assert.deepEqual(sends[0]!.arguments, { id: "fixture@self:private:friend", msg: text });
          // Interruption created while draining is queued after the current batch.
          await f.agent.drainMailbox(false);
          assert.equal(f.events().filter(event => event.refToolCallId === current.id && event.content.startsWith("计时中断")).length, 1);
        } finally { await f.close(); }
      }
    }
  }
}

async function persistedWakePolicySurvivesMissingOrigin() {
  for (const kind of ["wait", "rest"] as const) {
    for (const wake of [false, true]) {
      const f = await fixture();
      try {
        const current = await f.pause(kind), originId = "tc_already_compacted";
        assert.ok(!f.context.stream.some(entry => entry.kind === "tool_call" && entry.call.id === originId));
        await f.late.save({ text: `压缩之前操作的迟到回执_${wake}`, originEventIds: [] }, 100, originId, wake);
        const names = await fs.readdir(f.late.directory);
        assert.equal(names.length, 1);
        const stored = JSON.parse(await fs.readFile(path.join(f.late.directory, names[0]!), "utf8"));
        assert.equal(stored.wake, wake, "the receipt envelope durably preserves interruption policy");
        assert.ok(!Object.hasOwn(stored.event, "wake"), "scheduling metadata is not part of the character's event");

        // Recreate the inbox reader, as after process restart. No originating tool
        // call remains available to infer whether this was an old timer or action.
        f.agent.receipts = new ReceiptInbox(f.dir);
        await f.agent.drainMailbox(false);
        assert.equal(f.agent.waiting?.callId ?? null, wake ? null : current.id);
        assert.equal(f.agent.scheduler.isPending(current.id), !wake);
        const delivered = f.events().find(event => event.id === stored.event.id)!;
        assert.ok(delivered);
        assert.ok(!Object.hasOwn(delivered, "wake"), "restored policy never leaks into BotEvent or its context");
      } finally { await f.close(); }
    }
  }

  const f = await fixture();
  try {
    await f.late.save({ text: "安静回执", originEventIds: [],
      precedingObservations: [{ text: "先前的实际世界感知", source: "world" }],
      followingObservations: [{ text: "随后实际读到的消息", source: "koishi" }],
    }, 100, "tc_compacted", false);
    const restored = new ReceiptInbox(f.dir), policies: { source: string; wake: boolean | undefined }[] = [];
    await restored.drain(async (event, wake) => { policies.push({ source: event.source, wake }); });
    assert.deepEqual(policies, [{ source: "world", wake: undefined }, { source: "tool", wake: false }, { source: "koishi", wake: undefined }],
      "a quiet receipt does not silently suppress independent surrounding perceptions");
  } finally { await f.close(); }
}

async function main() {
  await freshReceiptWakesButReplayDoesNot();
  await oldTimersAndInternalReceiptsStayQuiet();
  await queuedPoliciesSurvivePauseCreation();
  await adoptedAccountMessagesInterruptPauses();
  await persistedWakePolicySurvivesMissingOrigin();
  console.log("PASS pause receipt wake: fresh versus replay, no stale timer interruption, quiet/internal/historical results, queued/adopted account events, and persisted wake policy after origin compaction/restart");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
