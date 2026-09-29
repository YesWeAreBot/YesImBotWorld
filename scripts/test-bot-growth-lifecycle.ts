/** Stop/reset interleavings with real journals and deferred local IO; no model or platform calls. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import type { BotEvent } from "../src/types.js";

const insight = { dimension: "饭后散步", significance: "河边活动带来平静，饭后想放松时可优先考虑散步。", anchors: [{ eventId: "old-event", quote: "晚饭后在河边散步，感到平静。" }] };
const logger = { info() {}, warn() {}, error() {} } as any;
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("lifecycle fixture timed out")), 2000); })]); }
  finally { clearTimeout(timer); }
}
const directories: string[] = [];
async function fixture(running = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "bot-growth-lifecycle-")); directories.push(base);
  const files = new WorldFiles(base); await files.ensure();
  await files.atomicWrite(files.botDef, "喜欢散步的角色。");
  const context = new BotContext(files); await context.load();
  const config = Config({ autoStart: false });
  config.bot.baseURL = `http://${randomUUID()}.invalid`; config.bot.model = "fixture";
  config.bot.growth.enabled = true; config.bot.growth.minEpisodes = 1;
  const clock = { now: () => 100000, unitWorldSeconds: 1, syncRealTime: true, timeLine: () => "T100000", realMsUntil: () => 0 } as any;
  const agent = new BotAgent(config, clock, files, context, {} as any, {} as any, null, null, null, { down: false }, logger) as any;
  const event: BotEvent = { id: "old-event", source: "world", worldTime: 99999, content: "晚饭后在河边散步，感到平静。", originEventIds: ["old-root"],
    experience: { agency: "self", outcome: "completed", episodeId: "old-episode", action: "散步", situation: "晚饭后河边", opportunity: true } };
  await context.appendEvent(event); await agent.growth.perceive(event); agent.growthRestored = true;
  agent.growthRuntime.infer = async () => ({ content: '{"changes":[]}', toolCalls: [] });
  if (running) {
    // The main loop is already leaving; its independently running maintenance still owns IO.
    agent.running = true; agent.loopPromise = Promise.resolve(); agent.abort = new AbortController();
  }
  return { files, context, agent, runtime: agent.growthRuntime, ledger: agent.growth };
}

async function committedAppendIsJoined(running: boolean) {
  const f = await fixture(running), entered = deferred(), release = deferred();
  const append = f.ledger.append.bind(f.ledger);
  f.ledger.append = async (line: any) => {
    if (line.type === "review_committed") { entered.resolve(); await release.promise; }
    return append(line);
  };
  f.runtime.tick(f.agent.abort?.signal, true); await bounded(entered.promise);
  let stopped = false;
  const stopping = f.agent.stop().then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false, "stop must join an append which passed its cancellation boundary");
  release.resolve(); await bounded(stopping);
  assert.equal(f.runtime.working, false);
  assert.match(await f.files.readText(f.files.growthJournal), /review_committed/);
  await f.files.reset(); await turn();
  assert.equal(await f.files.exists(f.files.growthJournal), false, "old IO cannot recreate the reset growth journal");
}

async function maintenanceStopsBetweenWrites() {
  const f = await fixture(), entered = deferred(), release = deferred();
  let isolationCalls = 0, inferenceCalls = 0;
  const correct = f.ledger.correctStaleAutomaticStates.bind(f.ledger);
  f.ledger.correctStaleAutomaticStates = async (options: any) => { entered.resolve(); await release.promise; return correct(options); };
  f.ledger.isolateUnverifiedClaims = async () => { isolationCalls++; };
  f.runtime.infer = async () => { inferenceCalls++; return { content: '{"changes":[]}', toolCalls: [] }; };
  f.runtime.tick(undefined, true); await bounded(entered.promise);
  const stopping = f.agent.stop(); release.resolve(); await bounded(stopping);
  assert.equal(isolationCalls, 0, "stop during one maintenance write must prevent the next maintenance mutation");
  assert.equal(inferenceCalls, 0);
  await f.files.reset();
  f.runtime.tick(undefined, true);
  assert.deepEqual(await f.runtime.drain(), []); assert.deepEqual(await f.runtime.remember(), []);
  await f.runtime.settled();
  assert.equal(await f.files.exists(f.files.growthJournal), false, "a stale callback cannot restart a stopped runtime");
}

async function explicitReflectionIsJoined() {
  const f = await fixture(true), entered = deferred(), release = deferred();
  const append = f.ledger.append.bind(f.ledger);
  f.ledger.append = async (line: any) => {
    if (line.type === "reflection") { entered.resolve(); await release.promise; }
    return append(line);
  };
  const call = { id: "explicit-reflection", role: "agent" as const, name: "reflect", issuedAt: 100000, expectedAt: 100000,
    arguments: { kind: "preference", subject: "饭后散步", statement: "我喜欢饭后在河边散步。", event_ids: ["old-event"], insight } };
  await f.context.appendToolCall(call); await f.agent.dispatch(call); await bounded(entered.promise);
  let stopped = false; const stopping = f.agent.stop().then(() => { stopped = true; });
  await turn(); assert.equal(stopped, false, "a committed reflect tool owns a local journal write too");
  release.resolve(); await bounded(stopping); await f.agent.scheduler.whenIdle(); await f.agent.receipts.settled();
  await f.files.reset(); await turn();
  assert.equal(await f.files.exists(f.files.growthJournal), false);
}

async function uncooperativeInferenceDoesNotBlockStop() {
  const f = await fixture(), entered = deferred(), response = deferred<any>();
  let signal: AbortSignal | undefined;
  f.runtime.infer = async (_messages: unknown, passed: AbortSignal) => { signal = passed; entered.resolve(); return response.promise; };
  f.runtime.tick(undefined, true); await bounded(entered.promise);
  await bounded(f.agent.stop());
  assert.equal(signal?.aborted, true); assert.equal(f.runtime.working, false);
  await f.files.reset();
  response.resolve({ content: '{"changes":[]}', toolCalls: [] });
  await turn(); await turn();
  assert.equal(await f.files.exists(f.files.growthJournal), false, "a late model result cannot create an old review after reset");
}

async function outboxDeliveryIsJoined() {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.runtime.infer = async () => ({ content: JSON.stringify({ changes: [{ kind: "preference", subject: "饭后散步", statement: "我喜欢饭后在河边散步。", evidenceIds: ["old-event"], insight }] }), toolCalls: [] });
  f.runtime.tick(undefined, true); await bounded(f.runtime.settled());
  assert.equal((await f.ledger.pendingReviews()).length, 1);
  const append = f.context.appendEvent.bind(f.context);
  f.context.appendEvent = async event => { if (event.id.startsWith("ev_growth_")) { entered.resolve(); await release.promise; } return append(event); };
  const delivery = f.runtime.drain(); await bounded(entered.promise);
  let stopped = false; const stopping = f.agent.stop().then(() => { stopped = true; });
  await turn(); assert.equal(stopped, false, "stop must also join background outbox delivery, not just inference");
  release.resolve(); await bounded(stopping); assert.deepEqual(await delivery, []);
  assert.equal((await f.ledger.pendingReviews()).length, 1, "interrupted delivery keeps its durable acknowledgement pending");
  await f.files.reset(); await turn();
  assert.equal(await f.files.exists(f.files.stream), false);
  assert.equal(await f.files.exists(f.files.growthJournal), false);
}

async function main() {
  try {
    await committedAppendIsJoined(false); await committedAppendIsJoined(true);
    await explicitReflectionIsJoined(); await maintenanceStopsBetweenWrites(); await uncooperativeInferenceDoesNotBlockStop(); await outboxDeliveryIsJoined();
    console.log("PASS Bot/Growth lifecycle: stop joins committed disk writes and delivery, cancels inference promptly, closes maintenance admission, reset stays empty");
  } finally { await Promise.all(directories.map(base => fs.rm(base, { recursive: true, force: true }))); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
