/** Temporary context/journal and deterministic inference only; no live model, platform or world action. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { RegulationRuntime, StaleRegulationDecision, readRegulationView, type RegulationChoice } from "../src/bot/regulation-runtime.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { WorldFiles } from "../src/files.js";
import type { BotModelConfig } from "../src/config.js";
import type { BotEvent, ParsedToolCall, ToolCallRecord } from "../src/types.js";
import type { ChatMessage } from "../src/llm/chat.js";

const directories: string[] = [];
const tools = BOT_TOOLS.filter(tool => ["act", "rest", "send"].includes(tool.name));
const proposal: ParsedToolCall = { name: "act", arguments: { description: "继续整理桌上的资料" } };
const alternative: ParsedToolCall = { name: "act", arguments: { description: "坐下来留出休息的时间" } };
const scope = () => ["world-character:self", "channel:mock:alice"];
const perception = (id: string, extra: Partial<BotEvent> = {}): BotEvent => ({ id, source: "world", worldTime: 10,
  content: "忙碌之后，注意到自己很需要留出恢复的空间。", originEventIds: [`root-${id}`],
  experience: { agency: "observed", outcome: "unknown", episodeId: `episode-${id}` }, ...extra });
const forecast = (id = "proposed", extra: Record<string, unknown> = {}) => ({ id, contextKey: "工作一段时间后的下一步", strategyKey: id === "proposed" ? "继续工作" : "留出休息时间",
  conditionalEffects: { competence: .5 }, probability: 1, cost: .1, risk: .1, explanation: "预估这个尚未执行的动作可能带来实际进展。", ...extra });
const response = (payload: any) => ({
  appraisals: payload.freshEvidence.map((event: any) => ({ eventIds: [event.id], needEffects: event.text.includes("已经休息") ? { recovery: .8 } : event.text.includes("没有得到") ? { competence: 0 } : { recovery: -.8 },
    salience: .7, novelty: .1, control: .7, uncertainty: .2, explanation: "只根据这一条实际收到的经历解释其影响。" })),
  candidates: [forecast()],
});
const waitFor = async (test: () => boolean) => { for (let i = 0; i < 300; i++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw Error("isolated inference never started"); };
async function fixture(old = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-regulation-runtime-")); directories.push(base);
  const files = new WorldFiles(base); await files.ensure(); await fs.writeFile(files.botDef, "小澈重视自己的承诺，也允许自己改变行动方式。");
  let context = new BotContext(files); await context.load();
  if (old) await context.appendEvent(perception("old"));
  const cfg = { baseURL: `http://isolated.invalid/${directories.length}`, model: "stub", temperature: .3, maxTokens: 4096, stream: false,
    regulation: { enabled: true, decisionEnabled: true, timeoutMs: 5000, maxInputChars: 64000, candidateCount: 3,
      learningRate: .3, driftRate: 0, sexualResponseEnabled: false } } as BotModelConfig;
  let now = 10, realNow = 1000;
  const clock = { now: () => now, unitWorldSeconds: 60 };
  const requests: any[] = [], warnings: string[] = [];
  let reply: (payload: any, signal: AbortSignal) => unknown | Promise<unknown> = response;
  const infer = async (messages: ChatMessage[], signal: AbortSignal) => {
    const payload = JSON.parse(String(messages[1]!.content)); requests.push(payload);
    const body = await reply(payload, signal);
    return { content: typeof body === "string" ? body : JSON.stringify(body), toolCalls: [] };
  };
  const make = () => new RegulationRuntime(base, cfg, clock, context, { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); } }, { infer, realNow: () => realNow });
  let runtime = make(); await runtime.restore();
  return {
    base, files, cfg, clock, requests, warnings, get context() { return context; }, get runtime() { return runtime; },
    setReply(value: typeof reply) { reply = value; }, advance(n = 1) { now += n; realNow += n * 1000; },
    async deliver(event: BotEvent) { await context.appendEvent(event); await runtime.perceive(event); },
    async view(): Promise<any> { return readRegulationView(base, cfg, clock); },
    async reload() { runtime.stop(); context = new BotContext(files); await context.load(); runtime = make(); await runtime.restore(); },
  };
}
async function bind(f: Awaited<ReturnType<typeof fixture>>, choice: RegulationChoice, id: string): Promise<ToolCallRecord> {
  const call: ToolCallRecord = { ...structuredClone(choice.call), id, role: "agent", issuedAt: f.clock.now(), expectedAt: f.clock.now() };
  await f.runtime.bind(choice, call); await f.context.appendToolCall(call); return call;
}

async function lifecycleAndLearning() {
  const f = await fixture(true), prefix = await f.context.toChatMessages("T10"), before = JSON.stringify(f.context.stream);
  await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual(f.requests[0].freshEvidence, [], "enabling starts at a baseline, without replaying all historical stimuli");
  assert.ok(f.requests[0].recentContext.some((event: any) => event.id === "old"));
  assert.equal(JSON.stringify(f.context.stream), before, "prediction alone does not append a performed action");
  const initialNotices = await f.runtime.drain(); assert.equal(initialNotices.length, 1);
  const afterNotice = await f.context.toChatMessages("T11");
  assert.deepEqual(afterNotice.slice(0, prefix.length), prefix);
  assert.deepEqual(await f.runtime.drain(), []);

  // A later history copy cannot make an already seen pre-enable root a fresh stimulus.
  await f.deliver(perception("old-copy", { originEventIds: ["root-old"] }));
  const initialNeeds = (await f.view()).state.needs;
  await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual((await f.view()).state.needs, initialNeeds, "pre-enable roots remain old when wrapped in new perception IDs");
  await f.runtime.drain();

  f.setReply(payload => ({ ...response(payload), candidates: [forecast(), forecast("alternative-1", { call: alternative, conditionalEffects: { recovery: .8 }, cost: 0, risk: 0 })] }));
  f.advance(); await f.deliver(perception("fresh"));
  const choice = await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual(JSON.parse(JSON.stringify(choice.call)), alternative, "a new unmet need changes actual selected action rather than just wording");
  assert.deepEqual(choice.prediction!.subjectIds, scope().sort(), "trusted dispatch scope survives omitted model subjectIds");
  assert.ok(f.requests.at(-1).freshEvidence.some((event: any) => event.id === "fresh"));
  await f.runtime.drain();
  await bind(f, choice, "tc_selected");
  f.advance(); await f.deliver(perception("real-result", { refToolCallId: "tc_selected", content: "已经休息了一会儿，重新投入事情的需要不再那么迫切。",
    experience: { agency: "self", outcome: "completed", episodeId: "rested-opportunity", action: alternative.arguments.description as string } }));
  const frozen = await f.context.toChatMessages("T12");
  await f.runtime.choose(proposal, tools, scope);
  const view = await f.view(), memory = Object.values(view.state.learning)[0] as any;
  assert.equal(memory.samples, 1); assert.deepEqual(memory.call, alternative); assert.equal(memory.toolName, "act");
  assert.equal(memory.strategyKey, "留出休息时间"); assert.equal(memory.last.outcome, "completed");
  assert.deepEqual(memory.last.rootIds, ["root-real-result"]);
  assert.equal(f.context.pinned.regulationSummary, undefined, "numerical state changes do not overwrite fixed context");
  await f.runtime.drain();
  assert.deepEqual((await f.context.toChatMessages("T13")).slice(0, frozen.length), frozen);
  const durable = JSON.stringify((await f.view()).state);
  await f.reload();
  assert.equal(JSON.stringify((await f.view()).state), durable, "replay restores exact numerical state and learned expectations");
  assert.deepEqual(await f.runtime.drain(), [], "acknowledged sensations are not redelivered after restart");
  await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual(f.requests.at(-1).freshEvidence, []);
  assert.equal((Object.values((await f.view()).state.learning)[0] as any).samples, 1);

  // The journal preserves delivered but not yet appraised evidence across ordinary context compression.
  await f.deliver(perception("pending-at-compression"));
  await f.context.applyCompression({ historySummary: "工作与休息的经历", memoryDigest: "保留未整理的新感知" }, f.clock.now(), undefined, undefined, await f.runtime.summary());
  assert.ok(!f.context.stream.length);
  await f.reload(); await f.runtime.choose(proposal, tools, scope);
  assert.ok(f.requests.at(-1).freshEvidence.some((event: any) => event.id === "pending-at-compression"));
  assert.match(f.context.pinned.regulationSummary ?? "", /行动|需要|恢复/);
}

async function agencyAndUnknown() {
  for (const agency of ["imposed", "unknown"] as const) {
    const f = await fixture(); const choice = await f.runtime.choose(proposal, tools, scope); await bind(f, choice, `tc_${agency}`);
    await f.deliver(perception(`result-${agency}`, { refToolCallId: `tc_${agency}`, experience: { agency, outcome: "completed", episodeId: agency } }));
    await f.runtime.choose(proposal, tools, scope);
    assert.deepEqual((await f.view()).state.learning, {}, `${agency} action must not train an autonomous strategy`);
  }
  const f = await fixture(); const choice = await f.runtime.choose(proposal, tools, scope); await bind(f, choice, "tc_unknown");
  await f.deliver(perception("unconfirmed", { refToolCallId: "tc_unknown", experience: { agency: "self", outcome: "unknown" } }));
  await f.runtime.choose(proposal, tools, scope); assert.deepEqual((await f.view()).state.learning, {});
  await f.deliver(perception("failed-confirmed", { refToolCallId: "tc_unknown", content: "认真尝试之后没有得到预计的进展。", experience: { agency: "self", outcome: "failed", episodeId: "known-failure" } }));
  await f.runtime.choose(proposal, tools, scope);
  const memory = Object.values((await f.view()).state.learning)[0] as any;
  assert.equal(memory.last.outcome, "failed"); assert.ok(memory.last.predictionError < 0, "later confirmed failure closes an earlier unknown result and corrects optimism");
}

async function advisoryRetainsExpectation() {
  const f = await fixture();
  const choice = await f.runtime.choose(proposal, tools, scope); await bind(f, choice, "tc_running");
  await f.deliver(perception("running-advisory", { source: "system", refToolCallId: "tc_running", originEventIds: [],
    content: "原动作仍在执行，请等待真实结果，不要重复提交。" }));
  await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual((await f.view()).state.learning, {}, "an operational advisory neither confirms nor disproves an outcome");
  await f.reload();
  await f.deliver(perception("running-real-failure", { refToolCallId: "tc_running", content: "认真尝试之后没有得到预计的进展。",
    experience: { agency: "self", outcome: "failed", episodeId: "running-attempt" } }));
  await f.runtime.choose(proposal, tools, scope);
  const memory = Object.values((await f.view()).state.learning)[0] as any;
  assert.ok(memory, "a system advisory must not discard the pending expectation before the actual result");
  assert.equal(memory.last.outcome, "failed"); assert.ok(memory.last.predictionError < 0);
}

async function replyIdentityScope() {
  const alice = 'chat-user:["mock","alice"]', bob = 'chat-user:["mock","bob"]';
  for (const expectedScope of [[alice], ["recipient:alice"]]) {
    const f = await fixture();
    const send: ParsedToolCall = { name: "send", arguments: { id: "mock:group", msg: '<at id="alice"/> 今晚愿意一起散步吗？' } };
    const receiverScope = () => ["channel:mock:group", ...expectedScope];
    f.setReply(payload => ({
      appraisals: payload.freshEvidence.map((event: any) => ({ eventIds: [event.id], needEffects: event.text.includes("答应") ? { connection: .8 } : {},
        salience: .5, novelty: .1, control: .5, uncertainty: .3, explanation: "说话人的真实身份与明确引用都必须和原邀请的预期对应。" })),
      candidates: [forecast("proposed", payload.proposed.name === "send" ? { settlement: "reply", strategyKey: "邀请指定朋友", conditionalEffects: { connection: .6 } } : {})],
    }));
    const choice = await f.runtime.choose(send, tools, receiverScope);
    assert.ok(choice.prediction!.subjectIds.includes(expectedScope[0]!)); await bind(f, choice, "tc_scoped_invite");
    await f.deliver(perception("sent-scoped", { source: "tool", refToolCallId: "tc_scoped_invite", originEventIds: ["outgoing-scoped"],
      content: "邀请已经发出，还不知道对方是否接受。", experience: { agency: "self", outcome: "completed" } }));
    await f.runtime.choose(proposal, tools, scope);
    await f.deliver(perception("bob-reply", { source: "koishi", content: "Bob引用这条邀请，答应一起去。", originEventIds: ["bob-answer"],
      experience: { agency: "observed", outcome: "unknown", subjectIds: [bob], responseToRoots: ["outgoing-scoped"] } }));
    await f.runtime.choose(proposal, tools, scope);
    assert.deepEqual((await f.view()).state.learning, {}, `${expectedScope}: another person's quoted response cannot satisfy Alice's expected response`);
    await f.reload();
    await f.deliver(perception("alice-reply", { source: "koishi", content: "Alice引用这条邀请，答应今晚一起散步。", originEventIds: ["alice-answer"],
      experience: { agency: "observed", outcome: "unknown", subjectIds: [alice], responseToRoots: ["outgoing-scoped"] } }));
    await f.runtime.choose(proposal, tools, scope);
    const memory = Object.values((await f.view()).state.learning)[0] as any;
    assert.ok(memory, "the intended person's later response can still settle the preserved expectation");
    assert.equal(memory.settlement, "reply"); assert.deepEqual(memory.last.rootIds, ["alice-answer"]);
    assert.ok(memory.subjectIds.includes(expectedScope[0]!));
  }
}

async function bindingIntegrity() {
  const f = await fixture(), choice = await f.runtime.choose(proposal, tools, scope);
  const actual = { ...structuredClone(choice.call), id: "actual", role: "agent" as const, issuedAt: 10, expectedAt: 10 };
  await assert.rejects(f.runtime.bind(choice, { ...actual, name: "send", arguments: { msg: "这个行为与期待不一致" } }), /行动|期待|绑定/);
  await assert.rejects(f.runtime.bind(choice, { ...actual, role: "system" }), /自主|接管|绑定/);
  for (const mode of ["avatar", "puppet"] as const) await assert.rejects(f.runtime.bind(choice, { ...actual, control: { mode, sessionId: mode } }), /自主|接管|绑定/);
}

async function delayedSocialOutcome() {
  const f = await fixture();
  const send: ParsedToolCall = { name: "send", arguments: { msg: "今晚愿意一起散步吗？", id: "mock:alice" } };
  f.setReply(payload => ({
    appraisals: payload.freshEvidence.map((event: any) => ({ eventIds: [event.id], needEffects: event.text.includes("答应") ? { connection: .8 } : {}, salience: .5, novelty: .1, control: .5, uncertainty: .3, explanation: "只有真实明确的回应才能确认对方是否接受邀请。" })),
    candidates: [forecast("proposed", payload.proposed.name === "send" ? { settlement: "reply", contextKey: "邀请朋友散步", strategyKey: "邀请散步", conditionalEffects: { connection: .6 } } : {})],
  }));
  const choice = await f.runtime.choose(send, tools, scope); assert.equal(choice.prediction!.settlement, "reply");
  await bind(f, choice, "tc_invite");
  await f.deliver(perception("sent-invite", { source: "tool", refToolCallId: "tc_invite", originEventIds: ["outgoing-invite"], content: "消息已真实发送，尚未收到对方回应。", experience: { agency: "self", outcome: "completed", episodeId: "invitation" } }));
  await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual((await f.view()).state.learning, {}, "successful send cannot settle an expectation of a social response");
  await f.deliver(perception("nearby-chat", { source: "koishi", content: "另一段对话：我答应了。", experience: { agency: "observed", outcome: "unknown", responseToRoots: [] } }));
  await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual((await f.view()).state.learning, {}, "a nearby chat message is not evidence it answered this invitation");
  await f.deliver(perception("old-answer", { source: "koishi", worldTime: 0, content: "以前的消息说答应过别的事情。", experience: { agency: "observed", outcome: "unknown", responseToRoots: ["outgoing-invite"] } }));
  await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual((await f.view()).state.learning, {}, "a historical reply older than the actual choice cannot settle it");
  await f.runtime.drain();
  await f.context.applyCompression({ historySummary: "已经发出邀请，尚未得到可归属的回应", memoryDigest: "不要把消息发出当作被接纳" }, f.clock.now());
  await f.reload(); f.advance();
  await f.deliver(perception("direct-reply", { source: "koishi", worldTime: f.clock.now(), content: "对方明确引用刚才的邀请，答应今晚一起散步。", originEventIds: ["actual-reply"], experience: { agency: "observed", outcome: "unknown", episodeId: "invitation-reply", responseToRoots: ["outgoing-invite"] } }));
  await f.runtime.choose(proposal, tools, scope);
  const memory = Object.values((await f.view()).state.learning)[0] as any;
  assert.equal(memory.settlement, "reply"); assert.deepEqual(memory.call, send);
  assert.deepEqual(memory.last.rootIds, ["actual-reply"]); assert.equal(memory.samples, 1);
  await f.deliver(perception("direct-reply-copy", { source: "koishi", worldTime: f.clock.now(), content: "再次查看对方答应的消息。", originEventIds: ["actual-reply"], experience: { agency: "observed", outcome: "unknown", responseToRoots: ["outgoing-invite"] } }));
  await f.runtime.choose(proposal, tools, scope);
  assert.equal((Object.values((await f.view()).state.learning)[0] as any).samples, 1);

  const timeout = await fixture();
  timeout.setReply(payload => ({ appraisals: [], candidates: [forecast("proposed", payload.proposed.name === "send" ? { settlement: "reply" } : {})] }));
  const unanswered = await timeout.runtime.choose(send, tools, scope); await bind(timeout, unanswered, "tc_unanswered");
  await timeout.deliver(perception("sent-unanswered", { source: "tool", refToolCallId: "tc_unanswered", originEventIds: ["unanswered-invite"], experience: { agency: "self", outcome: "completed" } }));
  await timeout.runtime.choose(proposal, tools, scope); timeout.advance(10081);
  await timeout.runtime.choose(proposal, tools, scope);
  assert.deepEqual((await timeout.view()).state.learning, {}, "expiration of an unconfirmed response does not fabricate rejection or failed reward");
}

async function fallbackCancellationAndStaleness() {
  const f = await fixture(); await f.deliver(perception("waiting"));
  f.setReply(() => { throw Error("isolated 400"); });
  const chosen = await f.runtime.choose(proposal, tools, scope);
  assert.deepEqual(chosen, { call: proposal }); assert.equal(f.warnings.length, 1);
  assert.ok((await f.view()).recent.some((record: any) => record.type === "error"));
  const requests = f.requests.length; await f.runtime.choose(proposal, tools, scope);
  assert.equal(f.requests.length, requests, "model failure enters bounded backoff without losing pending stimuli");
  const cancelledDuringBackoff = new AbortController(); cancelledDuringBackoff.abort(Error("cancelled during backoff"));
  await assert.rejects(f.runtime.choose(proposal, tools, scope, cancelledDuringBackoff.signal), /cancelled/, "backoff cannot revive an already cancelled proposal");
  f.advance(31); f.setReply(response); await f.runtime.choose(proposal, tools, scope);
  assert.ok(f.requests.at(-1).freshEvidence.some((event: any) => event.id === "waiting"));

  for (const change of ["abort", "context", "stop"] as const) {
    const other = await fixture(); let release!: (value: unknown) => void;
    other.setReply(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = other.runtime.choose(proposal, tools, scope, controller.signal);
    const rejected = assert.rejects(pending, change === "context" ? StaleRegulationDecision : /cancelled|停止/);
    await waitFor(() => !!release);
    if (change === "abort") controller.abort(Error("cancelled"));
    else if (change === "context") await other.context.appendEvent(perception("arrived-during-inference"));
    else other.runtime.stop();
    release(response(other.requests.at(-1)));
    await rejected;
    assert.equal(other.warnings.length, 0, "control or perception changes do not become model-error fallback execution");
    assert.deepEqual((await other.view()).recent, [], "cancelled or stale inference cannot commit a fictional decision");
  }
}

async function main() {
  try { await lifecycleAndLearning(); await agencyAndUnknown(); await advisoryRetainsExpectation(); await bindingIntegrity(); await replyIdentityScope(); await delayedSocialOutcome(); await fallbackCancellationAndStaleness();
    console.log("PASS regulation runtime: baseline/fresh roots, causal choice, bind/outcome learning, durable KV/restart/archive, agency/unknown/failure, advisory/binding integrity, scoped delayed quoted replies/expiry and cancellation/fallback."); }
  finally { await Promise.all(directories.map(base => fs.rm(base, { recursive: true, force: true }))); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
