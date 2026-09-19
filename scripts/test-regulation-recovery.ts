/** Real model parser/runtime with deterministic inference and temporary journals only. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BotModelConfig } from "../src/config.js";
import { BotContext } from "../src/bot/context.js";
import { RegulationRuntime, type RegulationChoice } from "../src/bot/regulation-runtime.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent, ParsedToolCall, ToolCallRecord } from "../src/types.js";

const directories: string[] = [], runtimes: RegulationRuntime[] = [];
const tools = BOT_TOOLS.filter(tool => tool.name === "act");
const proposed: ParsedToolCall = { name: "act", arguments: { description: "整理桌上的练习记录" } };
const alternative: ParsedToolCall = { name: "act", arguments: { description: "停下来检查刚才的练习方法" } };
const scope = () => ["world-character:self"];
const event = (id: string, at: number, extra: Partial<BotEvent> = {}): BotEvent => ({ id, source: "world", worldTime: at,
  content: "刚才的尝试有了清楚的结果，眼前仍有需要处理的事情。", originEventIds: ["root-" + id],
  experience: { agency: "observed", outcome: "unknown", episodeId: "episode-" + id }, ...extra });
const forecast = (extra: Record<string, unknown> = {}) => ({ id: "proposed", contextKey: "复盘练习后的安排", strategyKey: "整理练习记录",
  conditionalEffects: { competence: .5 }, probability: .8, cost: .1, risk: .1, explanation: "整理记录可能帮助理解练习结果。", ...extra });
const appraisal = (id: string, extra: Record<string, unknown> = {}) => ({ eventIds: [id], needEffects: { competence: -.3 },
  salience: .6, novelty: .2, control: .6, uncertainty: .3, explanation: "这条已经收到的结果说明仍有一些事情需要处理。", ...extra });
const validResponse = (payload: any) => ({ appraisals: payload.freshEvidence.map((item: any) => appraisal(item.id)), candidates: [forecast()] });

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-regulation-recovery-")); directories.push(base);
  const files = new WorldFiles(base); await files.ensure(); await fs.writeFile(files.botDef, "小澈重视认真练习，也愿意根据真实结果调整方法。");
  let context = new BotContext(files); await context.load();
  const cfg = { baseURL: "http://isolated.invalid", model: "regulation-recovery-fixture", temperature: .3, maxTokens: 4096, stream: false,
    regulation: { enabled: true, decisionEnabled: true, timeoutMs: 5000, maxInputChars: 64000, candidateCount: 3,
      learningRate: .3, driftRate: 0, sexualResponseEnabled: false } } as BotModelConfig;
  let now = 100;
  const clock = { now: () => now, unitWorldSeconds: 60 }, requests: any[] = [], warnings: string[] = [];
  let response: (payload: any) => unknown = validResponse;
  const make = () => {
    const runtime = new RegulationRuntime(base, cfg, clock, context, { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); } }, {
      realNow: () => now * 1000,
      infer: async messages => { const payload = JSON.parse(String(messages[1]!.content)); requests.push(payload); return { content: JSON.stringify(response(payload)), toolCalls: [] }; },
    });
    runtimes.push(runtime); return runtime;
  };
  let runtime = make(); await runtime.restore();
  return { base, files, cfg, clock, requests, warnings, get runtime() { return runtime; }, get context() { return context; },
    setResponse(value: typeof response) { response = value; }, advance(amount = 1) { now += amount; },
    async deliver(value: BotEvent) { await context.appendEvent(value); await runtime.perceive(value); },
    async view(): Promise<any> { return runtime.view(); },
    async reload() { runtime.stop(); await runtime.settled(); context = new BotContext(files); await context.load(); runtime = make(); await runtime.restore(); },
    async journal(): Promise<any[]> { return (await fs.readFile(files.regulationJournal, "utf8")).trim().split("\n").map(line => JSON.parse(line)); },
  };
}
async function bind(f: Awaited<ReturnType<typeof fixture>>, choice: RegulationChoice, id: string) {
  const call: ToolCallRecord = { ...structuredClone(choice.call), id, role: "agent", issuedAt: f.clock.now(), expectedAt: f.clock.now() };
  await f.runtime.bind(choice, call); await f.context.appendToolCall(call);
}

async function independentCandidateFailures() {
  const f = await fixture(), before = (await f.view()).state;
  await f.deliver(event("perceived-result", f.clock.now()));
  const prefix = await f.context.toChatMessages("T100");
  f.setResponse(payload => ({ ...validResponse(payload), candidates: [forecast(), forecast({ id: "alternative-1", call: { name: "act", arguments: {} } })] }));
  const selected = await f.runtime.choose(proposed, tools, scope), view = await f.view();
  assert.deepEqual(JSON.parse(JSON.stringify(selected.call)), proposed);
  assert.ok(selected.prediction, "an invalid alternative cannot erase the valid original forecast");
  assert.ok(view.state.needs.competence > before.needs.competence);
  assert.notDeepEqual(view.state.modulators, before.modulators, "a rejected alternative must not freeze valid perceived effects");
  assert.equal(view.pendingEvidence, 0); assert.equal(view.recent[0].type, "decision");
  assert.ok(view.recent[0].rejections.some((item: any) => item.section === "candidate" && /description/.test(item.reason)));
  assert.deepEqual(await f.context.toChatMessages("T101"), prefix, "evaluation does not rewrite or append an executed action");
  const snapshot = JSON.stringify(view.state); await f.reload();
  assert.equal(JSON.stringify((await f.view()).state), snapshot, "valid effects survive restart despite malformed sibling forecast");
  await f.runtime.drain(); assert.deepEqual((await f.context.toChatMessages("T101")).slice(0, prefix.length), prefix);

  const noPrediction = await fixture(), initial = (await noPrediction.view()).state;
  await noPrediction.deliver(event("genuine-perception", noPrediction.clock.now()));
  noPrediction.setResponse(payload => ({ ...validResponse(payload), candidates: [forecast({ probability: 2 }),
    forecast({ id: "alternative-1", call: alternative, cost: 0, risk: 0 })] }));
  const fallback = await noPrediction.runtime.choose(proposed, tools, scope), fallbackView = await noPrediction.view();
  assert.deepEqual(fallback.call, proposed); assert.equal(fallback.prediction, undefined);
  assert.ok(fallbackView.state.needs.competence > initial.needs.competence);
  assert.deepEqual(fallbackView.recent[0].candidates, []); assert.equal(fallbackView.recent[0].selectedId, undefined);
  assert.equal(fallbackView.recent[0].appraisals.length, 1); assert.equal(fallbackView.pendingEvidence, 0);
  await bind(noPrediction, fallback, "unforecasted-action");
  assert.equal((await noPrediction.view()).pendingExpectations, 0, "fallback cannot invent an expected outcome to train against");
  assert.equal((await noPrediction.journal()).filter(item => item.type === "bind").length, 0);
}

async function unresolvedOutcomeAndRecovery() {
  const f = await fixture(), choice = await f.runtime.choose(proposed, tools, scope);
  await bind(f, choice, "attempt"); f.advance();
  await f.deliver(event("actual-outcome", f.clock.now(), { source: "tool", refToolCallId: "attempt",
    experience: { agency: "self", outcome: "completed", episodeId: "completed-attempt", worldPerception: true } }));
  await f.deliver(event("independent-perception", f.clock.now()));
  f.setResponse(payload => ({ appraisals: payload.freshEvidence.map((item: any) => appraisal(item.id,
    item.id === "actual-outcome" ? { needEffects: { competence: .7 }, physiology: {} } : { needEffects: { connection: -.2 } })), candidates: [forecast()] }));
  await f.runtime.choose(proposed, tools, scope);
  const rejected = await f.view(), decision = (await f.journal()).filter(item => item.type === "decision").at(-1)!;
  assert.equal(rejected.pendingEvidence, 1); assert.equal(rejected.pendingExpectations, 1);
  assert.deepEqual(rejected.state.learning, {}, "an invalid interpretation is neither zero reward nor a completed expectation");
  assert.ok(rejected.recent[0].unresolvedEvidenceIds.includes("actual-outcome"));
  assert.deepEqual(decision.examined, ["independent-perception"]);
  assert.equal(decision.comparisons.length, 0); assert.ok(!decision.settledCalls.includes("attempt"));
  const needs = structuredClone(rejected.state.needs); await f.reload();
  assert.equal((await f.view()).pendingEvidence, 1); assert.equal((await f.view()).pendingExpectations, 1);
  assert.deepEqual((await f.view()).state.needs, needs);
  f.setResponse(payload => ({ appraisals: payload.freshEvidence.map((item: any) => appraisal(item.id, { needEffects: { competence: .7 } })), candidates: [forecast()] }));
  await f.runtime.choose(proposed, tools, scope);
  const recovered = await f.view(), memory = Object.values(recovered.state.learning)[0] as any;
  assert.deepEqual(f.requests.at(-1).freshEvidence.map((item: any) => item.id), ["actual-outcome"]);
  assert.ok(f.requests.at(-1).validationFeedback.some((item: string) => /appraisal\[0\]|身体/.test(item)), "validation feedback survives restart and reaches the correction request");
  assert.equal(memory.samples, 1); assert.deepEqual(memory.last.rootIds, ["root-actual-outcome"]);
  assert.equal(recovered.pendingEvidence, 0); assert.equal(recovered.pendingExpectations, 0);
  await f.runtime.choose(proposed, tools, scope);
  assert.deepEqual(f.requests.at(-1).freshEvidence, []); assert.deepEqual(f.requests.at(-1).validationFeedback, []);
  assert.equal((Object.values((await f.view()).state.learning)[0] as any).samples, 1, "recovered evidence cannot train again");

  const unknown = await fixture(), expected = await unknown.runtime.choose(proposed, tools, scope);
  await bind(unknown, expected, "uncertain-attempt");
  await unknown.deliver(event("unknown-result", unknown.clock.now(), { source: "tool", refToolCallId: "uncertain-attempt",
    experience: { agency: "self", outcome: "unknown", episodeId: "uncertain-attempt" } }));
  unknown.setResponse(payload => ({ appraisals: payload.freshEvidence.map((item: any) => appraisal(item.id, { needEffects: {} })), candidates: [forecast()] }));
  await unknown.runtime.choose(proposed, tools, scope); await unknown.reload();
  assert.deepEqual((await unknown.view()).state.learning, {}); assert.equal((await unknown.view()).pendingExpectations, 1);
  unknown.advance(); await unknown.deliver(event("confirmed-failure", unknown.clock.now(), { source: "tool", refToolCallId: "uncertain-attempt",
    experience: { agency: "self", outcome: "failed", episodeId: "uncertain-attempt" } }));
  await unknown.runtime.choose(proposed, tools, scope);
  const failed = Object.values((await unknown.view()).state.learning)[0] as any;
  assert.equal(failed.last.outcome, "failed"); assert.ok(failed.last.predictionError < 0, "only the later confirmed failure settles the earlier unknown outcome");
}

async function recentAndHistoricalQueue() {
  const f = await fixture();
  for (let index = 0; index < 16; index++) await f.deliver(event("pending" + index, index));
  f.setResponse(payload => ({ appraisals: [], candidates: [forecast()] }));
  await f.runtime.choose(proposed, tools, scope);
  const first = f.requests[0].freshEvidence;
  assert.deepEqual(first.map((item: any) => item.id), ["pending10", "pending11", "pending12", "pending13", "pending14", "pending15", "pending0", "pending1"],
    "each overfull request starts with six recent perceptions and still reviews two old ones");
  assert.ok(first.every((item: any) => item.ageWorldSeconds === (100 - item.at) * 60));
  assert.equal((await f.view()).pendingEvidence, 8);
  await f.context.applyCompression({ historySummary: "已收到一些练习记录，仍有未评价的旧材料。", memoryDigest: "原始材料留在内在调节日志中。" }, 100);
  await f.reload(); await f.runtime.choose(proposed, tools, scope);
  assert.deepEqual(f.requests.at(-1).freshEvidence.map((item: any) => item.id), ["pending2", "pending3", "pending4", "pending5", "pending6", "pending7", "pending8", "pending9"]);
  assert.equal((await f.view()).pendingEvidence, 0);
  const records = await f.journal();
  assert.equal(records.filter(item => item.type === "evidence").length, 16, "review scheduling never drops original historical perceptions");
  const examined = records.filter(item => item.type === "decision").flatMap(item => item.examined);
  assert.equal(examined.length, 16); assert.equal(new Set(examined).size, 16);
  assert.deepEqual((await f.view()).state.learning, {}, "an honest empty appraisal does not create action outcomes");
  await f.reload();
  await f.deliver(event("read-again-with-new-wrapper", f.clock.now(), { originEventIds: ["root-pending0"] }));
  await f.runtime.choose(proposed, tools, scope);
  assert.deepEqual(f.requests.at(-1).freshEvidence, [], "an explicitly examined no-effect root stays examined after restart and cannot become a fresh stimulus on reread");
}

async function main() {
  try {
    await independentCandidateFailures(); await unresolvedOutcomeAndRecovery(); await recentAndHistoricalQueue();
    console.log("PASS regulation recovery: independent appraisal/candidate admission, truthful primary fallback, durable unresolved outcomes and feedback, no fabricated learning, six-recent/two-backlog sampling and compression recovery");
  } finally {
    runtimes.forEach(runtime => runtime.stop()); await Promise.all(runtimes.map(runtime => runtime.settled()));
    await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
