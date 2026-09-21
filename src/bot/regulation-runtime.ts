import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "koishi";
import type { BotModelConfig } from "../config.js";
import { appendJsonLine } from "../jsonl.js";
import { richPartsText } from "../media/presentation.js";
import type { BotEvent, ParsedToolCall, StreamEntry, ToolCallRecord } from "../types.js";
import type { BotContext } from "./context.js";
import type { NamedToolDef } from "./nativeTools.js";
import { projectObservedMessages } from "./perception-fragments.js";
import { narrativeFactText } from "./narrative-facts.js";
import { RegulationModel, type RegulationModelOptions, type RegulationModelResult } from "./regulation-model.js";
import { advanceState, applyAppraisal, createState, describeRegulation, learnOutcome, scoreCandidates, MODULATORS,
  type Appraisal, type AppraisalEffect, type LearningRecord, type ObservedOutcome, type OutcomePrediction,
  type RegulationOptions, type RegulationState, type ScoredCandidate } from "./regulation-core.js";

interface Clock { now(): number; unitWorldSeconds: number }
/** World seconds copied from the actual delivered event, never an evaluator-supplied timestamp. */
interface TimedAppraisal extends Appraisal { observedAt?: number }
interface Comparison { prediction: OutcomePrediction; outcome: ObservedOutcome; observedAt?: number }
interface AwaitingReply { callId: string; prediction: OutcomePrediction; roots: string[] }
export interface RegulationRecent {
  id: string; type: "decision" | "error"; at: number; summary: string;
  state?: Pick<RegulationState, "at" | "needs" | "modulators" | "physiology">;
  appraisals?: TimedAppraisal[]; effects?: AppraisalEffect[]; candidates?: ScoredCandidate[];
  selectedId?: string; learning?: LearningRecord[];
  candidateForecasts?: RegulationModelResult["candidateForecasts"];
  appraisalExplanations?: RegulationModelResult["appraisalExplanations"];
  rejections?: RegulationModelResult["rejections"];
  unresolvedEvidenceIds?: string[];
}
interface DecisionRecord {
  type: "decision"; id: string; at: number; options: RegulationOptions;
  appraisals: TimedAppraisal[]; comparisons: Comparison[]; examined: string[]; settledCalls: string[];
  awaitingReplies: AwaitingReply[];
  candidates: ScoredCandidate[]; selectedId?: string; notice?: BotEvent;
  rejections?: RegulationModelResult["rejections"];
  unresolvedEvidenceIds?: string[];
  candidateForecasts: RegulationModelResult["candidateForecasts"];
  appraisalExplanations: RegulationModelResult["appraisalExplanations"];
}
type JournalRecord =
  | { type: "init"; version: 1; state: RegulationState; baselineIds: string[] }
  | { type: "evidence"; event: BotEvent; fragments?: BotEvent[] }
  | DecisionRecord
  | { type: "bind"; callId: string; prediction: OutcomePrediction }
  | { type: "abandon"; callId: string }
  | { type: "ack"; id: string }
  | { type: "error"; id: string; at: number; summary: string };

/** Event-sourced numerical state: no full growing state is copied on every action. */
class RegulationJournal {
  readonly file: string;
  state: RegulationState | null = null;
  readonly seen = new Set<string>();
  readonly examinedRoots = new Set<string>();
  readonly pending = new Map<string, BotEvent>();
  readonly predictions = new Map<string, OutcomePrediction>();
  readonly awaitingReplies = new Map<string, AwaitingReply>();
  readonly notices = new Map<string, BotEvent>();
  readonly recent: RegulationRecent[] = [];
  lastNotice = "";
  validationFeedback: string[] = [];
  private loaded: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor(base: string) { this.file = path.join(base, "regulation.jsonl"); }
  async ready(readonly = false): Promise<void> {
    this.loaded ??= (async () => {
      let raw: string;
      try { raw = await fs.readFile(this.file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const boundary = raw.lastIndexOf("\n") + 1;
      if (!readonly && boundary !== raw.length) throw Error("内在调节记录有未提交的尾部，保留原文件并停止写入，请检查磁盘或恢复完整存档");
      for (const line of raw.slice(0, boundary).split("\n")) {
        if (!line.trim()) continue;
        this.apply(JSON.parse(line) as JournalRecord);
      }
    })();
    await this.loaded;
  }
  append(record: JournalRecord): Promise<void> {
    const next = this.tail.then(async () => { await this.ready(); await appendJsonLine(this.file, record); this.apply(record); });
    this.tail = next.catch(() => {}); return next;
  }
  async settled(): Promise<void> { await this.tail; }
  private apply(record: JournalRecord): void {
    if (record.type === "init") {
      if (this.state || record.version !== 1 || record.state.version !== 1) throw Error("内在调节记录版本或初始状态不一致");
      this.state = structuredClone(record.state); record.baselineIds.forEach(id => this.seen.add(id));
      record.state.appraisalRoots.forEach(root => this.examinedRoots.add(root)); return;
    }
    if (!this.state) throw Error("内在调节记录缺少初始状态");
    switch (record.type) {
      case "evidence": {
        this.seen.add(record.event.id);
        const pendingMessageRoots = new Set([...this.pending.values()].flatMap(event => event.originEventIds?.length === 1 ? event.originEventIds : []));
        for (const event of record.fragments ?? [record.event]) {
          this.seen.add(event.id);
          const roots = event.originEventIds ?? [event.id];
          // Preserve execution receipts even when their visible message was already seen;
          // they may still confirm a pending send. Read-only message copies add no stimulus.
          if ((event.perceptionOf || !event.refToolCallId) &&
            (roots.every(root => this.examinedRoots.has(root)) || (roots.length === 1 && pendingMessageRoots.has(roots[0]!)))) continue;
          this.pending.set(event.id, event);
          if (roots.length === 1) pendingMessageRoots.add(roots[0]!);
        }
        break;
      }
      case "bind": this.predictions.set(record.callId, record.prediction); break;
      case "abandon": this.predictions.delete(record.callId); this.awaitingReplies.delete(record.callId); break;
      case "ack": this.notices.delete(record.id); break;
      case "error": this.validationFeedback = [record.summary]; this.recent.unshift(record); break;
      case "decision": {
        let state = advanceState(this.state, record.at);
        state.options = structuredClone(record.options);
        const effects: AppraisalEffect[] = [], learning: LearningRecord[] = [];
        for (const appraisal of record.appraisals) { const result = applyTimedAppraisal(state, appraisal, record.at); state = result.state; effects.push(result.effect); }
        for (const comparison of record.comparisons) { const result = learnTimedOutcome(state, comparison, record.at); state = result.state; if (result.learning) learning.push(result.learning); }
        this.state = state;
        for (const id of record.examined) {
          const event = this.pending.get(id);
          if (event) for (const root of event.originEventIds ?? [event.id]) this.examinedRoots.add(root);
          this.pending.delete(id);
        }
        // A rejected interpretation is neither a zero effect nor a reason to block
        // every later perception. Retain it and move it behind other pending work.
        for (const id of record.unresolvedEvidenceIds ?? []) {
          const event = this.pending.get(id);
          if (event) { this.pending.delete(id); this.pending.set(id, event); }
        }
        this.validationFeedback = (record.rejections ?? []).map(item => `${item.section}[${item.index}]: ${item.reason}`).slice(0, 8);
        for (const id of record.settledCalls) { this.predictions.delete(id); this.awaitingReplies.delete(id); }
        for (const awaiting of record.awaitingReplies ?? []) { this.predictions.delete(awaiting.callId); this.awaitingReplies.set(awaiting.callId, awaiting); }
        if (record.notice) { this.notices.set(record.notice.id, record.notice); this.lastNotice = record.notice.content; }
        const audit = record.rejections?.length ? `本次保留 ${record.appraisals.length} 项有效经历评价，拒绝 ${record.rejections.length} 项无效提案。${record.selectedId ? "已比较有效候选。" : "原候选预测无效，实际行动沿用原候选；未制造评分。"}\n` : "";
        this.recent.unshift({ id: record.id, type: "decision", at: record.at, summary: audit + (record.notice?.content ?? describeRegulation(state)),
          state: { at: state.at, needs: structuredClone(state.needs), modulators: structuredClone(state.modulators), physiology: structuredClone(state.physiology) },
          appraisals: record.appraisals, effects, candidates: record.candidates, selectedId: record.selectedId, learning,
          candidateForecasts: record.candidateForecasts, appraisalExplanations: record.appraisalExplanations,
          rejections: record.rejections, unresolvedEvidenceIds: record.unresolvedEvidenceIds });
        break;
      }
      default: throw Error("内在调节记录包含未知操作，停止解释以免覆盖历史");
    }
    this.recent.splice(50);
  }
}

export interface RegulationChoice { call: ParsedToolCall; prediction?: OutcomePrediction }
export class StaleRegulationDecision extends Error {}
export interface RegulationRuntimeOptions extends Pick<RegulationModelOptions, "infer"> { realNow?: () => number }

/** Owns delivered evidence and durable expectations. It never dispatches a tool or writes a world fact. */
export class RegulationRuntime {
  private journal: RegulationJournal;
  private model: RegulationModel;
  private restored = false;
  private nextAttemptAt = 0;
  private controller: AbortController | null = null;
  private epoch = 0;
  private realNow: () => number;
  constructor(base: string, private cfg: BotModelConfig, private clock: Clock, private context: BotContext,
    private logger: Pick<Logger, "warn">, options: RegulationRuntimeOptions = {}) {
    this.journal = new RegulationJournal(base);
    this.realNow = options.realNow ?? Date.now;
    this.model = new RegulationModel(cfg, context, { infer: options.infer,
      resolveEvidence: async ids => ids.flatMap(id => { const event = this.journal.pending.get(id); return event ? [structuredClone(event)] : []; }) });
  }
  /** First enable starts at the current boundary; old history is context, not a burst of fresh stimuli. */
  async restore(): Promise<void> {
    if (!this.cfg.regulation?.enabled || this.restored) return;
    await this.journal.ready();
    if (!this.journal.state) {
      const state = createState(this.seconds(), configured(this.cfg));
      state.appraisalRoots = [...new Set(this.context.stream.flatMap(entry => entry.kind === "event" && eligible(entry.event, this.context.stream)
        ? entry.event.originEventIds ?? [entry.event.id] : []))];
      await this.journal.append({ type: "init", version: 1, state,
        baselineIds: this.context.stream.flatMap(entry => entry.kind === "event" ? [entry.event.id] : []) });
    } else for (const entry of this.context.stream) if (entry.kind === "event") await this.perceive(entry.event);
    this.restored = true;
  }
  async perceive(event: BotEvent): Promise<void> {
    if (!this.cfg.regulation?.enabled || !eligible(event, this.context.stream)) return;
    await this.journal.ready();
    if (!this.journal.state) throw Error("内在调节尚未初始化感知边界");
    if (this.journal.seen.has(event.id)) return;
    const canonical = this.context.stream.find(entry => entry.kind === "event" && entry.event.id === event.id);
    if (!canonical || canonical.kind !== "event") throw Error("内在调节不能读取尚未交付的事件");
    // Keep ordered media identity and its delivered summary, without copying local files/base64.
    const value = canonical.event;
    const text = value.contextText ?? (value.parts?.length ? richPartsText(value.parts) : narrativeFactText(value));
    const fragments = projectObservedMessages(value.id, this.context.stream);
    await this.journal.append({ type: "evidence", event: { id: value.id, source: value.source, worldTime: value.worldTime,
      content: text, contextText: text, refToolCallId: value.refToolCallId, originEventIds: value.originEventIds,
      experience: structuredClone(value.experience), statusEcho: value.statusEcho },
      ...(fragments ? { fragments: fragments.map(({ parts: _parts, ...fragment }) => fragment) } : {}) });
  }
  stop(): void { this.epoch++; this.controller?.abort(Error("内在调节已停止")); }
  async settled(): Promise<void> { await this.journal.settled(); }
  async view(): Promise<unknown> {
    await this.journal.ready();
    return regulationView(this.journal, this.cfg, this.clock);
  }
  async summary(): Promise<string> {
    if (!this.cfg.regulation?.enabled) return "";
    await this.journal.ready();
    return this.journal.state ? describeRegulation(advanceState(this.journal.state, this.seconds())) : "";
  }
  async drain(): Promise<BotEvent[]> {
    if (!this.cfg.regulation?.enabled) return [];
    await this.journal.ready();
    const delivered: BotEvent[] = [];
    for (const event of this.journal.notices.values()) {
      await this.context.appendEvent(event);
      await this.journal.append({ type: "ack", id: event.id });
      delivered.push(event);
    }
    return delivered;
  }
  /** Persist the expectation before the actual call enters history or touches an external system. */
  async bind(choice: RegulationChoice, call: ToolCallRecord): Promise<void> {
    if (call.name === "think" || choice.call.name === "think") return;
    if (!choice.prediction) return;
    if (call.role !== "agent" || call.control) throw Error("接管行动不能绑定自主选择的期待");
    if (actionSignature(choice.call) !== actionSignature(choice.prediction.call) || actionSignature(call) !== actionSignature(choice.prediction.call)) {
      throw Error("行动已改变，不能绑定另一动作的期待");
    }
    await this.journal.append({ type: "bind", callId: call.id, prediction: choice.prediction });
  }
  async abandon(callId: string): Promise<void> {
    if (this.journal.predictions.has(callId)) await this.journal.append({ type: "abandon", callId });
  }
  async choose(proposed: ParsedToolCall, tools: NamedToolDef[], scope: (call: ParsedToolCall) => string[],
    signal?: AbortSignal, current: () => boolean = () => true): Promise<RegulationChoice> {
    signal?.throwIfAborted();
    if (!current()) throw new StaleRegulationDecision("控制权或能力已改变，本次旧候选未执行");
    // Subjective character prose is retained locally, never appraised as a new action or stimulus.
    if (proposed.name === "think") return { call: proposed };
    if (!this.cfg.regulation?.enabled || this.realNow() < this.nextAttemptAt) return { call: proposed };
    await this.restore();
    const epoch = this.epoch, signature = this.contextSignature(), optionsSignature = JSON.stringify(this.cfg.regulation);
    const controller = new AbortController(); this.controller = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const guard = () => {
      combined.throwIfAborted();
      if (epoch !== this.epoch || !current() || signature !== this.contextSignature() || optionsSignature !== JSON.stringify(this.cfg.regulation)) throw new StaleRegulationDecision("感知、能力或控制权已改变，本次旧候选未执行");
    };
    const state = advanceState(this.journal.state!, this.seconds()); state.options = configured(this.cfg);
    const confirmedReplies = new Map<string, AwaitingReply>();
    let result: RegulationModelResult;
    try {
      guard();
      const pendingExpectations = new Map(this.journal.awaitingReplies);
      for (const event of this.journal.pending.values()) {
        const prediction = event.refToolCallId && this.journal.predictions.get(event.refToolCallId);
        if (prediction && prediction.settlement === "reply" && event.experience?.agency === "self" && event.experience.outcome === "completed" && event.originEventIds?.length && state.at - prediction.at <= 7 * 86400) {
          const item = { callId: event.refToolCallId!, prediction, roots: event.originEventIds };
          pendingExpectations.set(item.callId, item); confirmedReplies.set(item.callId, item);
        }
      }
      const responseRoots = new Set([...this.journal.pending.values()].flatMap(event => event.experience?.responseToRoots ?? []));
      // Six recent perceptions keep decisions grounded in the present; two older
      // pending entries continue recovery without calling them newly occurring events.
      const pending = [...this.journal.pending.values()];
      const recent = [...pending].sort((a, b) => b.worldTime - a.worldTime).slice(0, 6);
      const recentIds = new Set(recent.map(event => event.id));
      const events = pending.length <= 8 ? pending : [...recent.reverse(), ...pending.filter(event => !recentIds.has(event.id)).slice(0, 2)];
      result = await this.model.evaluate({ events, state, proposed, tools: tools.filter(tool => tool.name !== "think"), at: this.clock.now(), secondsPerTU: this.unit(),
        validationFeedback: this.journal.validationFeedback,
        pendingExpectations: [...pendingExpectations.values()].filter(item => item.roots.some(root => responseRoots.has(root))) }, combined);
      guard();
    } catch (error) {
      guard(); // Cancellation/staleness must not execute the old proposal as a fallback.
      this.nextAttemptAt = this.realNow() + 30_000;
      const summary = `内在调节未完成，沿用原候选，保留未评价经历：${error instanceof Error ? error.message : String(error)}`;
      this.logger.warn("%s", summary);
      await this.journal.append({ type: "error", id: randomUUID(), at: this.seconds(), summary });
      return { call: proposed };
    } finally { if (this.controller === controller) this.controller = null; }
    const id = randomUUID(), at = this.seconds();
    let next = advanceState(state, at);
    const appraisals: TimedAppraisal[] = [], comparisons: Comparison[] = [], settledCalls: string[] = [];
    const awaiting = new Map(this.journal.awaitingReplies);
    // Delivery confirmation is program evidence, independent of appraisal sampling.
    // A new explicit reply can be reviewed before its older send receipt; promote
    // that receipt now so the reply is not consumed without settling its expectation.
    const awaitingReplies = [...confirmedReplies.values()].filter(item => at - item.prediction.at <= 7 * 86400);
    for (const item of awaitingReplies) awaiting.set(item.callId, item);
    // Expiring an unconfirmed expectation is not evidence of rejection or failure.
    for (const [callId, item] of awaiting) if (at - item.prediction.at > 7 * 86400) { awaiting.delete(callId); settledCalls.push(callId); }
    for (const [callId, prediction] of this.journal.predictions) if (at - prediction.at > 7 * 86400) settledCalls.push(callId);
    const validIds = new Set(result.evidenceIds);
    const unresolved = new Set(result.unresolvedEvidenceIds ?? []);
    const examined = result.evidenceIds.filter(eventId => !unresolved.has(eventId));
    for (const appraisal of result.appraisals) {
      const event = appraisal.eventIds.length === 1 && this.journal.pending.get(appraisal.eventIds[0]!);
      if (!event || !validIds.has(event.id)) throw Error("评价引用未展示的经历");
      const roots = event.originEventIds ?? [event.id];
      const canonical = { ...appraisal, id: `${id}:${appraisal.id}`, rootIds: roots, episodeId: event.experience?.episodeId,
        observedAt: event.worldTime * this.unit() };
      // A mixed old/new chat snapshot cannot safely isolate which sentence caused an effect.
      // Skip the whole appraisal rather than assigning an old stimulus to a new message.
      if (roots.some(root => this.journal.examinedRoots.has(root) || next.appraisalRoots.includes(root))) continue;
      appraisals.push(canonical);
      next = applyTimedAppraisal(next, canonical, at).state;
    }
    for (const eventId of examined) {
      const event = this.journal.pending.get(eventId);
      if (!event) throw Error("评价消费了未知经历");
      if (!event.refToolCallId) continue;
      const prediction = this.journal.predictions.get(event.refToolCallId);
      const appraisal = appraisals.find(item => item.eventIds.includes(eventId));
      if (!prediction) continue;
      if (!event.experience?.outcome || event.experience.outcome === "unknown") continue;
      settledCalls.push(event.refToolCallId);
      if (prediction.settlement === "reply" && event.experience?.agency === "self" && event.experience.outcome === "completed" && event.originEventIds?.length) {
        continue; // Already promoted from all confirmed receipts, even if its appraisal is unresolved.
      }
      if (!appraisal) continue;
      // Binding is created exclusively for autonomous dispatch; source metadata must still agree.
      const outcome: ObservedOutcome = { eventIds: [eventId], rootIds: event.originEventIds ?? [eventId], episodeId: event.experience.episodeId,
        agency: event.experience.agency ?? "unknown", outcome: event.experience.outcome, observedEffects: appraisal.needEffects ?? {} };
      const comparison = { prediction, outcome, observedAt: event.worldTime * this.unit() };
      comparisons.push(comparison);
      next = learnTimedOutcome(next, comparison, at).state;
    }
    for (const appraisal of appraisals) {
      const event = this.journal.pending.get(appraisal.eventIds[0]!)!;
      // A multi-message snapshot has no per-message effect attribution. Only a single
      // delivered reply with a platform-confirmed reference can settle social expectations.
      if (event.source !== "koishi" || event.originEventIds?.length !== 1 || event.experience?.agency !== "observed") continue;
      const replyRoots = new Set(event.experience.responseToRoots ?? []);
      const matches = [...awaiting.values()].filter(item => item.roots.some(root => replyRoots.has(root)) && event.worldTime * this.unit() >= item.prediction.at && replyIdentityMatches(item.prediction, event));
      if (matches.length !== 1) continue;
      const item = matches[0]!;
      const outcome: ObservedOutcome = { eventIds: [event.id], rootIds: event.originEventIds, episodeId: event.experience.episodeId,
        agency: "self", outcome: "completed", observedEffects: appraisal.needEffects ?? {} };
      const comparison = { prediction: item.prediction, outcome, observedAt: event.worldTime * this.unit() };
      comparisons.push(comparison);
      next = learnTimedOutcome(next, comparison, at).state;
      settledCalls.push(item.callId); awaiting.delete(item.callId);
      const index = awaitingReplies.findIndex(value => value.callId === item.callId); if (index >= 0) awaitingReplies.splice(index, 1);
    }
    const candidates = result.candidates.map(candidate => ({ ...candidate,
      subjectIds: [...new Set([...(candidate.subjectIds ?? []), ...scope(candidate.call)])].sort() }));
    const scored = scoreCandidates(next, candidates, id);
    const selected = this.cfg.regulation.decisionEnabled ? scored[0]! : scored.find(item => item.candidate.id === "proposed")!;
    const text = describeRegulation(next);
    const content = `（内在倾向的变化，并非外界的新事件）\n${text}`;
    const notice: BotEvent | undefined = content !== this.journal.lastNotice ? { id: `ev_regulation_${id}`, source: "system", originEventIds: [], worldTime: this.clock.now(), content } : undefined;
    guard();
    await this.journal.append({ type: "decision", id, at, options: next.options, appraisals, comparisons,
      examined, settledCalls, awaitingReplies, candidates: scored, selectedId: selected?.candidate.id,
      rejections: result.rejections, unresolvedEvidenceIds: [...unresolved],
      candidateForecasts: result.candidateForecasts,
      appraisalExplanations: result.appraisalExplanations.map(item => ({ ...item, appraisalId: `${id}:${item.appraisalId}` })),
      notice });
    guard();
    return selected ? { call: structuredClone(selected.candidate.call), prediction: structuredClone(selected.prediction) } : { call: proposed };
  }
  private unit(): number { return Number.isFinite(this.clock.unitWorldSeconds) && this.clock.unitWorldSeconds > 0 ? this.clock.unitWorldSeconds : 1; }
  private seconds(): number { return this.clock.now() * this.unit(); }
  private contextSignature(): string { return createHash("sha256").update(JSON.stringify([this.context.pinned, this.context.windowRevision, this.context.stream])).digest("hex"); }
}

function evidenceAge(observedAt: number | undefined, at: number): number {
  // Old journal entries had no observedAt; preserving their original behavior
  // keeps replay compatible. New entries always store the canonical event time.
  return Number.isFinite(observedAt) ? Math.max(0, at - observedAt!) : 0;
}

/** Attenuate only this delayed update, without decaying other current experiences again. */
function dampSignalChange(before: RegulationState, after: RegulationState, age: number): void {
  if (!age) return;
  const decay = (halfLife: number) => 2 ** (-age / halfLife);
  for (const name of MODULATORS) {
    const old = before.modulators[name], next = after.modulators[name];
    next.phasic = old.phasic + (next.phasic - old.phasic) * decay(after.options.phasicHalfLifeSeconds);
    next.tonic = old.tonic + (next.tonic - old.tonic) * decay(after.options.tonicHalfLifeSeconds);
    next.adaptation = old.adaptation + (next.adaptation - old.adaptation) * decay(after.options.adaptationHalfLifeSeconds);
  }
  const slow = decay(after.options.tonicHalfLifeSeconds);
  after.control = before.control + (after.control - before.control) * slow;
  after.uncertainty = before.uncertainty + (after.uncertainty - before.uncertainty) * slow;
}

function applyTimedAppraisal(state: RegulationState, appraisal: TimedAppraisal, at: number): ReturnType<typeof applyAppraisal> {
  const before = advanceState(state, at), age = evidenceAge(appraisal.observedAt, at);
  // An entire simulated reflex period is a conservative freshness boundary,
  // using the existing engineering durations rather than claiming biological precision.
  // Persistent need effects can still be understood; old body stimuli cannot
  // produce a new current peak without another actual bodily perception.
  const effective = age > before.options.peakSeconds + before.options.recoverySeconds
    ? { ...appraisal, physiology: undefined } : appraisal;
  const result = applyAppraisal(before, effective, at);
  dampSignalChange(before, result.state, age);
  return result;
}

function learnTimedOutcome(state: RegulationState, comparison: Comparison, at: number): ReturnType<typeof learnOutcome> {
  const before = advanceState(state, at), result = learnOutcome(before, comparison.prediction, comparison.outcome, at);
  // Learning is retained when an old result is finally reviewed; its historical
  // reward-prediction pulse must not reappear at full intensity in the present.
  dampSignalChange(before, result.state, evidenceAge(comparison.observedAt, at));
  return result;
}

function eligible(event: BotEvent, stream: StreamEntry[]): boolean {
  if (event.source === "system" || event.experience?.internalThought === true || event.originEventIds?.length === 0) return false;
  const call = event.refToolCallId && stream.find(entry => entry.kind === "tool_call" && entry.call.id === event.refToolCallId);
  return !call || call.kind !== "tool_call" || !["think", "reflect", "recall_growth", "recall"].includes(call.call.name);
}
function configured(cfg: BotModelConfig): RegulationOptions {
  return createState(0, { learningRate: cfg.regulation?.learningRate ?? .3, physiologyEnabled: cfg.regulation?.sexualResponseEnabled === true,
    needDriftPerHour: { connection: cfg.regulation?.driftRate ?? 0, novelty: cfg.regulation?.driftRate ?? 0 } }).options;
}
function actionSignature(call: ParsedToolCall): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const duration = call.name === "wait" && !(call.duration && call.duration > 0) && Number(call.arguments.n) > 0 ? Number(call.arguments.n) : call.duration ?? 0;
  return JSON.stringify([call.name, canonical(call.arguments), duration]);
}
function replyIdentityMatches(prediction: OutcomePrediction, event: BotEvent): boolean {
  const actual = event.experience?.subjectIds ?? [];
  const intended = prediction.subjectIds.filter(id => id.startsWith("chat-user:"));
  if (intended.length && !intended.some(id => actual.includes(id))) return false;
  const recipients = prediction.subjectIds.filter(id => id.startsWith("recipient:")).map(id => id.slice(10));
  if (recipients.length && !actual.some(id => {
    try { return id.startsWith("chat-user:") && recipients.includes(JSON.parse(id.slice(10))[1]); } catch { return false; }
  })) return false;
  return true;
}
/** Read-only: disabling the feature does not erase its audit trail or start inference. */
export async function readRegulationView(base: string, cfg: BotModelConfig, clock?: Clock): Promise<unknown> {
  const journal = new RegulationJournal(base); await journal.ready(true);
  return regulationView(journal, cfg, clock);
}
function regulationView(journal: RegulationJournal, cfg: BotModelConfig, clock?: Clock): unknown {
  const unit = clock?.unitWorldSeconds && clock.unitWorldSeconds > 0 ? clock.unitWorldSeconds : 1;
  const at = clock ? clock.now() * unit : journal.state?.at ?? 0;
  const source = journal.state ?? createState(at, configured(cfg));
  // The UI needs current signals and a bounded learning sample, not the deduplication ledger.
  const state = advanceState({ ...source, appraisalRoots: [], learnedRoots: [], appraisalEpisodes: {}, learningEpisodes: {},
    learning: Object.fromEntries(Object.entries(source.learning).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, 64)) }, at);
  return { enabled: cfg.regulation?.enabled === true, decisionEnabled: cfg.regulation?.decisionEnabled === true,
    worldSecondsPerUnit: unit, state, learningCount: Object.keys(source.learning).length,
    pendingEvidence: journal.pending.size,
    pendingExpectations: journal.predictions.size + journal.awaitingReplies.size, recent: structuredClone(journal.recent) };
}
