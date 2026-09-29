/** Real character pauses remain blocked until elapsed or interrupted by actual perceptions. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotAgent, type BotPerception } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent, ParsedToolCall, ToolCallRecord } from "../src/types.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string, ms = 1800) {
  const end = Date.now() + ms; while (!check() && Date.now() < end) await pause(2); assert.ok(check(), label);
}
function hold(signal: AbortSignal): Promise<ParsedToolCall> {
  return new Promise((_resolve, reject) => { const abort = () => reject(signal.reason ?? Error("stopped"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); });
}
const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const action: ParsedToolCall = { name: "act", arguments: { description: "推开院门，看看外面" } };

async function fixture(kind: "wait" | "rest", opts: { strict?: boolean; compress?: boolean; priorAct?: boolean; firstGate?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-pause-event-"));
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files, "固定工具说明"); await context.load();
  const cfg = Config({ autoStart: false }); cfg.bot.growth.enabled = false; cfg.messaging.sendEcho = false; cfg.world.waitNarrateMinRealSeconds = 0;
  Object.assign(cfg.bot, { strictToolLoop: opts.strict ?? true, nativeToolCalls: false, minIntervalMs: 0, retryDelayMs: 1, waitRateThreshold: 0,
    maxWindowChars: 1e6, restCompressMinChars: opts.compress ? 0 : 1e6, spillMinChars: 0 });
  const start = Date.now(), clock: any = { now: () => (Date.now() - start) / 1000, timeLine: () => "白天", unitWorldSeconds: 1, unitRealSeconds: 1,
    realMsUntil: (at: number) => at * 1000 - (Date.now() - start) };
  const actionEntered = gate(), actionFinish = gate(), compressionEntered = gate(), compressionFinish = gate(), firstDecision = gate();
  let acts = 0, commits = 0, compressions = 0;
  const world: any = {
    adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => void, _signal: AbortSignal, commit: (phase: string) => boolean) => {
      acts++; actionEntered.resolve(); await actionFinish.promise;
      if (!commit("finish")) return false;
      commits++;
      deliver(JSON.stringify({ action: { id: `bot:${call.id}`, status: "completed" }, observation: { mode: "narrative", actorId: "bot",
        observationId: `result:${call.id}`, sourceEventIds: [`result:${call.id}`], narrative: "院门已经打开，街上传来脚步声。", observedAt: clock.now() } }));
      return true;
    },
    compress: async () => { compressions++; compressionEntered.resolve(); await compressionFinish.promise;
      return { historySummary: "记忆已完整整理。", memoryDigest: "记得窗边的约定。" }; },
  };
  const agent: any = new BotAgent(cfg, clock, files, context, world, {} as any, null, null, null, { down: false }, logger, BOT_TOOLS);
  const requests: any[][] = [], published: BotPerception[] = [];
  const timerCall: ParsedToolCall = { name: kind, arguments: kind === "wait" ? { n: 60 } : { duration: 60 }, duration: 60 };
  const sequence = opts.priorAct ? [action, timerCall] : [timerCall];
  agent.backend = { setToolNames() {}, setToolDefs() {}, resetToolSnapshot() {}, generate: async (ctx: BotContext, time: string, signal: AbortSignal) => {
    requests.push(await ctx.toChatMessages(time, false));
    if (requests.length === 1 && opts.firstGate) await Promise.race([firstDecision.promise, hold(signal)]);
    return requests.length <= sequence.length ? structuredClone(sequence[requests.length - 1]!) : hold(signal);
  } };
  const unsubscribe = agent.subscribePerceptions((item: BotPerception) => published.push(item), agent.perceptionCursor());
  function events(): BotEvent[] { return context.stream.flatMap(entry => entry.kind === "event" ? [entry.event] : []); }
  function calls(): ToolCallRecord[] { return context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call] : []); }
  function incoming(source: "world" | "koishi", text: string, wake?: boolean) {
    agent.pushEvent(source, { text, originEventIds: [source === "koishi" ? `chat-notice:${text}` : `world-perception:${text}`] }, wake === undefined ? {} : { wake });
  }
  async function startPause() {
    agent.start(); await until(() => agent.waiting?.kind === kind, `${kind} enters its actual pause timer`);
    return calls().find(call => call.name === kind)!;
  }
  return { dir, context, agent, clock, requests, published, actionEntered, actionFinish, compressionEntered, compressionFinish, firstDecision, events, calls, incoming, startPause,
    acts: () => acts, commits: () => commits, compressions: () => compressions,
    async close() { unsubscribe(); await agent.stop(); actionFinish.resolve(); compressionFinish.resolve(); await pause(5); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

async function arrivalsDuringDecisionInterruptItsNewPause() {
  for (const kind of ["wait", "rest"] as const) for (const source of ["world", "koishi"] as const) for (const quiet of [false, true]) {
    const f = await fixture(kind, { firstGate: true });
    try {
      f.agent.start(); await until(() => f.requests.length === 1, "the first pause decision is genuinely still generating");
      const text = `${source}在${kind}生成途中到达${quiet ? "静音" : "唤醒"}`;
      f.incoming(source, text, quiet ? false : source === "koishi" ? true : undefined);
      assert.equal(f.agent.waiting, null, "the incoming fact precedes timer creation");
      f.firstDecision.resolve();
      if (quiet) {
        await until(() => f.published.some(item => item.event.content === text), "a pre-pause quiet event still becomes a durable perception");
        assert.equal(f.requests.length, 1); assert.equal(f.agent.waiting?.kind, kind);
        assert.equal(f.agent.scheduler.isPending(f.agent.waiting.callId), true);
        assert.ok(!f.events().some(event => event.content.includes("计时中断")), "reevaluating queued facts preserves explicit wake=false");
      } else {
        await until(() => f.requests.length === 2, "a pre-pause arrival must immediately interrupt the subsequently created timer");
        const call = f.calls().find(entry => entry.name === kind)!;
        assert.ok(call); assert.equal(f.agent.waiting, null); assert.equal(f.agent.scheduler.isPending(call.id), false);
        assert.ok(JSON.stringify(f.requests[1]).includes(text));
        assert.equal(f.events().filter(event => event.content === text).length, 1);
        assert.equal(f.events().filter(event => event.refToolCallId === call.id && event.content.includes("计时中断")).length, 1);
      }
    } finally { await f.close(); }
  }
}

async function meaningfulPerceptionsInterruptPauses() {
  for (const strict of [true, false]) for (const kind of ["wait", "rest"] as const) for (const source of ["world", "koishi"] as const) {
    const f = await fixture(kind, { strict });
    try {
      const call = await f.startPause(); await pause(25);
      assert.equal(f.requests.length, 1, `${kind} without an event must remain a real pause`);
      assert.equal(f.agent.scheduler.isPending(call.id), true);
      const text = `${source}在${kind}期间交付的新感知`;
      f.incoming(source, text);
      await until(() => f.requests.length === 2, `default ${source} perception interrupts ${kind}, strict=${strict}`);
      assert.ok(f.clock.now() < call.expectedAt, "the perception, not timer expiry, resumed generation");
      assert.equal(f.agent.scheduler.isPending(call.id), false); assert.equal(f.agent.waiting, null);
      assert.ok(JSON.stringify(f.requests[1]).includes(text), "the triggering fact is saved before constructing the next model request");
      assert.equal(f.events().filter(event => event.content === text).length, 1);
      assert.equal(f.published.filter(item => item.event.content === text).length, 1);
      assert.equal(f.events().filter(event => event.refToolCallId === call.id && event.content.includes("计时中断")).length, 1);
      assert.ok(!f.events().some(event => event.refToolCallId === call.id && /等待结束|休息计时结束/.test(event.content)), "interruption cannot fabricate full timer completion");
      assert.deepEqual(f.calls().map(entry => entry.name), [kind], "the paused operation is not repeated to poll for events");
    } finally { await f.close(); }
  }
}

async function explicitQuietEventsStayQuiet() {
  for (const kind of ["wait", "rest"] as const) {
    const f = await fixture(kind);
    try {
      const call = await f.startPause(), before = structuredClone(f.agent.waiting);
      for (const source of ["world", "koishi"] as const) {
        const text = `${source}明确不唤醒的消息`;
        f.incoming(source, text, false);
        await until(() => f.published.some(item => item.event.content === text), "wake=false still persists and publishes the fact");
        assert.equal(f.requests.length, 1); assert.equal(f.agent.scheduler.isPending(call.id), true);
        assert.deepEqual(f.agent.waiting, before); assert.ok(!f.events().some(event => event.content.includes("计时中断")));
        assert.ok((await fs.readFile(path.join(f.dir, "stream.jsonl"), "utf8")).includes(text));
      }
      f.incoming("koishi", "后来收到确实应唤醒的通知", true);
      await until(() => f.requests.length === 2, "explicit waking notifications still interrupt after quiet input");
      assert.match(JSON.stringify(f.requests[1]), /world明确不唤醒的消息/); assert.match(JSON.stringify(f.requests[1]), /koishi明确不唤醒的消息/);
    } finally { await f.close(); }
  }
}

async function relatedWorldResultsInterruptLegacyPause() {
  for (const kind of ["wait", "rest"] as const) {
    const f = await fixture(kind, { strict: false, priorAct: true });
    try {
      const timer = await f.startPause(); await f.actionEntered.promise;
      const operation = f.calls().find(call => call.name === "act")!;
      assert.ok(f.agent.waiting.worldCalls.includes(operation.id), "the pause records the genuine pending action it was waiting for");
      assert.equal(f.requests.length, 2); assert.equal(f.acts(), 1); assert.equal(f.commits(), 0);
      f.actionFinish.resolve();
      await until(() => f.requests.length === 3, "an actual related tool completion returns control from the pause");
      assert.equal(f.agent.scheduler.isPending(timer.id), false); assert.equal(f.agent.waiting, null);
      assert.match(JSON.stringify(f.requests[2]), /院门已经打开，街上传来脚步声/);
      assert.equal(f.acts(), 1); assert.equal(f.commits(), 1);
      assert.deepEqual(f.calls().map(call => call.name), ["act", kind]);
      assert.equal(f.events().filter(event => event.refToolCallId === timer.id && event.content.includes("计时中断")).length, 1);
    } finally { await f.close(); }
  }
}

async function eventsCannotRaceMemoryCompression() {
  for (const strict of [true, false]) {
    const f = await fixture("rest", { strict, compress: true });
    try {
      const timer = await f.startPause(); await f.compressionEntered.promise;
      f.incoming("world", "整理期间看到窗外下雨"); f.incoming("koishi", "整理期间手机传来新通知");
      await pause(35);
      assert.equal(f.requests.length, 1, "an event cannot start inference against partially replaced memory");
      assert.equal(f.compressions(), 1);
      f.compressionFinish.resolve();
      await until(() => f.requests.length === 2, "after complete compression, the already delivered event resumes the next decision");
      assert.match(JSON.stringify(f.requests[1]), /记忆已完整整理/);
      assert.match(JSON.stringify(f.requests[1]), /整理期间看到窗外下雨/); assert.match(JSON.stringify(f.requests[1]), /整理期间手机传来新通知/);
      assert.equal(f.agent.scheduler.isPending(timer.id), false); assert.equal(f.compressions(), 1);
      assert.equal(f.calls().filter(call => call.name === "rest").length, 0, "the compressed snapshot is not executed again as a new rest request");
    } finally { await f.close(); }
  }
}
async function main() {
  await meaningfulPerceptionsInterruptPauses(); await explicitQuietEventsStayQuiet(); await relatedWorldResultsInterruptLegacyPause(); await eventsCannotRaceMemoryCompression(); await arrivalsDuringDecisionInterruptItsNewPause();
  console.log("PASS pause event interruption: no-event pause, meaningful world/chat input, explicit quiet delivery, real related results, no polling tool repeats and compression boundary protection");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
