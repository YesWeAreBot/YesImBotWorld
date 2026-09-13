/** Fault injection in isolated directories; no live world, model or platform. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { GrowthLedger } from "../src/bot/growth.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent, RichText } from "../src/types.js";

const append = fs.appendFile;
const dirs: string[] = [];
const event = (id: string): BotEvent => ({ id, source: "koishi", content: `原始经历 ${id}`, worldTime: 1 });
async function fixture(reflection = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-durable-")); dirs.push(base);
  const files = new WorldFiles(base); await files.ensure();
  const context = new BotContext(files); await context.load();
  const config = { bot: { baseURL: "http://invalid", model: "fake", nativeToolCalls: false, repeatThresholds: [99], repeatExclude: [], spillMinChars: 200 }, world: {}, platformOps: {} } as any;
  const clock = { now: () => 42, timeLine: () => "T42" } as any;
  const make = (ctx: BotContext) => new BotAgent(config, clock, files, ctx, {} as any, {} as any, null, null, null, { down: false }, { info() {}, warn() {}, error() {} } as any,
    reflection ? BOT_TOOLS.filter(tool => tool.name === "reflect") : []) as any;
  return { files, context, make, agent: make(context) };
}

async function partialAppends() {
  const f = await fixture(), ledger = new GrowthLedger(path.join(f.files.base, "ledger"));
  let fail = true;
  fs.appendFile = (async (file: any, data: any, options: any) => {
    if (file === ledger.file && fail) { fail = false; await append(file, String(data).slice(0, 25)); throw Error("partial growth write"); }
    return append(file, data, options);
  }) as typeof fs.appendFile;
  await assert.rejects(ledger.perceive(event("ev_1")), /partial growth write/);
  assert.equal((await ledger.recallEvidence()).length, 0, "failed persistence is never acknowledged in memory");
  await ledger.perceive(event("ev_1")); fs.appendFile = append;
  assert.equal((await new GrowthLedger(path.join(f.files.base, "ledger")).recallEvidence()).length, 1);

  await f.agent.drainMailbox();
  fail = true;
  fs.appendFile = (async (file: any, data: any, options: any) => {
    if (file === f.files.stream && fail) { fail = false; await append(file, String(data).slice(0, 25)); throw Error("partial context write"); }
    return append(file, data, options);
  }) as typeof fs.appendFile;
  f.agent.pushEvent("koishi", "邮箱第一条"); f.agent.pushEvent("koishi", "邮箱第二条");
  await assert.rejects(f.agent.drainMailbox(), /partial context write/);
  assert.equal(f.agent.mailbox.length, 2, "neither current item nor remaining inbox may be discarded");
  assert.equal(f.context.stream.length, 0);
  await f.agent.drainMailbox(); fs.appendFile = append;
  const resumed = new BotContext(f.files); await resumed.load();
  assert.equal(resumed.stream.length, 2); assert.equal(f.agent.mailbox.length, 0);
  assert.equal(new Set(resumed.stream.map(entry => entry.kind === "event" ? entry.event.id : entry.call.id)).size, 2);

  const damaged = await fixture();
  await fs.writeFile(damaged.files.stream, '{"kind":"event"');
  const fromDamaged = new BotContext(damaged.files); await fromDamaged.load();
  await fromDamaged.appendEvent(event("ev_7"));
  const clean = new BotContext(damaged.files); await clean.load();
  assert.equal(clean.stream.length, 1); assert.equal(clean.nextEventId(), "ev_8", "bad historical tail cannot swallow the next event or its counter");
}

async function pinnedFailure() {
  const f = await fixture(); await f.agent.drainMailbox();
  const atomic = f.files.atomicWrite.bind(f.files); let fail = true;
  f.files.atomicWrite = async (file, text) => { if (file === f.files.pinned && fail) { fail = false; throw Error("pinned checkpoint failed"); } return atomic(file, text); };
  f.agent.pushEvent("koishi", "已经落盘，尚未保存计数器"); f.agent.pushEvent("koishi", "仍在邮箱中的后续经历");
  await assert.rejects(f.agent.drainMailbox(), /pinned checkpoint failed/);
  assert.equal(f.context.stream.length, 1); assert.equal(f.agent.mailbox.length, 2);
  assert.equal((await f.agent.growth.recallEvidence()).length, 0);
  await f.agent.drainMailbox();
  assert.equal(f.context.stream.length, 2, "retry must reuse the delivered event ID");
  assert.equal(f.agent.mailbox.length, 0); assert.equal((await f.agent.growth.recallEvidence()).length, 2);
  const restored = new BotContext(f.files); await restored.load();
  assert.equal(restored.stream.length, 2); assert.equal(restored.nextEventId(), "ev_3");

  const restart = await fixture();
  const save = restart.files.atomicWrite.bind(restart.files); fail = true;
  restart.files.atomicWrite = async (file, text) => { if (file === restart.files.pinned && fail) { fail = false; throw Error("crash after stream append"); } return save(file, text); };
  restart.agent.pushEvent("koishi", "在进程重启前已经交付的经历");
  await assert.rejects(restart.agent.drainMailbox(), /crash after stream append/);
  const recovered = new BotContext(restart.files); await recovered.load();
  const replacement = restart.make(recovered); await replacement.drainMailbox();
  assert.equal(recovered.stream.length, 1); assert.equal((await replacement.growth.recallEvidence()).length, 1);
  const snapshot = await recovered.compressionSnapshot();
  await recovered.applyCompression({ historySummary: "经历已整理", memoryDigest: "保留原事件 ev_1" }, 43, snapshot);
  assert.equal((await new GrowthLedger(restart.files.base).recallEvidence())[0]?.eventId, "ev_1", "compression cannot discard the recovered evidence");
}

async function reflectionCheckpoint() {
  const f = await fixture(true); let failures = 2;
  fs.appendFile = (async (file: any, data: any, options: any) => {
    if (file === f.files.growthJournal && String(data).includes('"type":"review_offered"') && failures-- > 0) {
      await append(file, String(data).slice(0, 25)); throw Error("reflection checkpoint failed");
    }
    return append(file, data, options);
  }) as typeof fs.appendFile;
  f.agent.waiting = { callId: "sleeping", kind: "nap" }; let woke = false; f.agent.wakeFn = () => { woke = true; };
  for (let i = 0; i < 24; i++) f.agent.pushEvent("koishi", `新经历 ${i}`);
  await assert.rejects(f.agent.drainMailbox(), /reflection checkpoint failed/);
  const cues = (ctx: BotContext) => ctx.stream.filter(entry => entry.kind === "event" && entry.event.id.startsWith("ev_growth_review_"));
  assert.equal(cues(f.context).length, 1); assert.equal(f.agent.waiting.callId, "sleeping"); assert.equal(woke, false);
  await assert.rejects(f.agent.drainMailbox(), /reflection checkpoint failed/);
  assert.equal(cues(f.context).length, 1, "failed checkpoint retry cannot append another invitation");
  // Recreate the process while the cue is durable but its ledger checkpoint is still absent.
  const loaded = new BotContext(f.files); await loaded.load(); const replacement = f.make(loaded);
  await replacement.drainMailbox(); fs.appendFile = append;
  await replacement.drainMailbox();
  assert.equal(cues(loaded).length, 1); assert.equal(await replacement.growth.reflectionOpportunity(), null);
  assert.equal((await replacement.growth.recallEvidence({ n: 50 })).length, 24);
  assert.equal(loaded.nextEventId(), "ev_25", "cue checkpoint identifiers are not event sequence counters");
}

async function compressionRecoveryBarrier() {
  for (const stage of ["pinned", "cleanup"] as const) {
    const f = await fixture();
    await f.context.appendEvent(event(f.context.nextEventId()));
    const snapshot = await f.context.compressionSnapshot();
    const tail = event(f.context.nextEventId()); await f.context.appendEvent(tail);
    const before = structuredClone(f.context.stream), pinned = structuredClone(f.context.pinned);
    const rendered = f.context.renderSystemText("旧窗口"), revision = f.context.windowRevision;
    const atomic = f.files.atomicWrite.bind(f.files), remove = fs.rm;
    let blocked = true;
    f.files.atomicWrite = async (file, text) => {
      if (blocked && stage === "pinned" && file === f.files.pinned) throw Error("compression pinned blocked");
      return atomic(file, text);
    };
    fs.rm = (async (file: any, options: any) => {
      if (blocked && stage === "cleanup" && file === f.files.contextCommit) throw Error("compression cleanup blocked");
      return remove(file, options);
    }) as typeof fs.rm;
    try {
      await assert.rejects(f.context.applyCompression({ historySummary: "压缩后的窗口", memoryDigest: "完整提交" }, 43, snapshot), /compression .* blocked/);
      assert.deepEqual(f.context.stream, before, `${stage}: retain the entire old memory window until committed`);
      assert.deepEqual(f.context.pinned, pinned);
      assert.equal(f.context.renderSystemText("变化的时间"), rendered);
      assert.equal(f.context.windowRevision, revision);
      await assert.rejects(f.context.settled(), /compression .* blocked/);
      await assert.rejects(f.context.toChatMessages("不能生成"), /compression .* blocked/);
      await assert.rejects(f.context.compressionSnapshot(), /compression .* blocked/, "cannot summarize a partially cut-over context");
      assert.equal(f.context.windowRevision, revision);
      assert.ok(await f.files.exists(f.files.contextCommit));

      blocked = false;
      await f.context.settled();
      assert.deepEqual(f.context.stream, [{ kind: "event", event: tail }], "suffix received during compression survives recovery");
      assert.equal(f.context.pinned.historySummary, "压缩后的窗口");
      assert.equal(f.context.windowRevision, revision + 1);
      assert.equal(await f.files.exists(f.files.contextCommit), false);
      const messages = await f.context.toChatMessages("新窗口");
      assert.match(String(messages[0]!.content), /压缩后的窗口/);
      const resumed = new BotContext(f.files); await resumed.load();
      assert.deepEqual(resumed.stream, f.context.stream);
      assert.deepEqual(resumed.pinned, f.context.pinned);
      assert.equal(resumed.nextEventId(), "ev_3");
    } finally { fs.rm = remove; }
  }
}

async function spillProvenance() {
  const f = await fixture();
  const raw: RichText = { text: "很长的已感知旧经历。".repeat(200), originEventIds: [] };
  const output = f.agent.spillResult(f.agent.puppetReceipt(raw), "tc_recall_growth");
  assert.ok(output.text.length < raw.text.length);
  assert.deepEqual(output.originEventIds, [], "clipping must not turn a memory into new evidence");
  assert.equal(raw.text.length, "很长的已感知旧经历。".length * 200);
  const original = { ...raw, originEventIds: ["source_1"] };
  assert.deepEqual(f.agent.spillResult(original, "tc_other").originEventIds, ["source_1"]);
  const ordered = { ...raw, parts: [{ kind: "text", text: raw.text }] };
  assert.equal(f.agent.spillResult(ordered), ordered, "ordered multimedia projection is never flattened by text clipping");
  // spill writes run asynchronously, so wait for the fixture file before removing its directory.
  for (let i = 0; i < 100 && (!(await f.files.exists(f.files.spillPath("tc_other.txt"))) || !(await f.files.exists(f.files.spillPath("tc_recall_growth.txt")))); i++) await new Promise(resolve => setTimeout(resolve, 2));
}

async function main() {
  try { await partialAppends(); await pinnedFailure(); await reflectionCheckpoint(); await compressionRecoveryBarrier(); await spillProvenance(); console.log("PASS durable context: partial append rollback, damaged-tail isolation, idempotent pinned recovery, retained inbox, reflection retry/restart, compression recovery barrier and spill provenance"); }
  finally { fs.appendFile = append; await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
