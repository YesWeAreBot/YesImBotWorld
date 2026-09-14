/**
 * A deterministic, dimensionless neuromodulation-inspired simulation.
 * These coefficients are engineering assumptions, not human concentrations or a
 * claim that a language model experiences the corresponding sensations.
 * Callers validate evidence, persist returned states atomically and commit any
 * physical consequence through the world's ordinary fact-update path.
 */
import { createHash } from "node:crypto";
import type { ParsedToolCall } from "../types.js";

export const NEEDS = ["recovery", "connection", "autonomy", "competence", "novelty"] as const;
export type Need = typeof NEEDS[number];
export type NeedEffects = Partial<Record<Need, number>>;
export type OutcomeSettlement = "completion" | "reply";
export const MODULATORS = ["dopamine", "noradrenaline", "serotonin", "opioid", "oxytocin"] as const;
export type Modulator = typeof MODULATORS[number];
export interface ModulatorState { tonic: number; phasic: number; adaptation: number }
export interface RegulationOptions {
  /** Deficit accumulation per world hour; zero by default, since time alone is not a body observation. */
  needDriftPerHour: Record<Need, number>;
  tonicHalfLifeSeconds: number;
  phasicHalfLifeSeconds: number;
  adaptationHalfLifeSeconds: number;
  baseline: number;
  learningRate: number;
  physiologyEnabled: boolean;
  peakSeconds: number;
  recoverySeconds: number;
}
export interface PhysiologyState {
  excitation: number;
  inhibition: number;
  phase: "idle" | "rising" | "peak" | "recovery";
  peakUntil?: number;
  recoveryUntil?: number;
  peaks: number;
}
export interface LearningRecord {
  key: string;
  contextKey: string;
  actionKey: string;
  toolName: string;
  call: ParsedToolCall;
  strategyKey?: string;
  /** Settle direct execution separately from a subsequent social response. */
  settlement?: OutcomeSettlement;
  subjectIds: string[];
  expectedEffects: Record<Need, number>;
  samples: number;
  weight: number;
  updatedAt: number;
  /** Latest comparison uses the prediction saved BEFORE the outcome arrived. */
  last: { expected: number; observed: number; predictionError: number; outcome: "completed" | "failed"; eventIds: string[]; rootIds: string[]; episodeId?: string };
}
export interface RegulationState {
  version: 1;
  at: number;
  options: RegulationOptions;
  needs: Record<Need, number>;
  modulators: Record<Modulator, ModulatorState>;
  control: number;
  uncertainty: number;
  physiology: PhysiologyState;
  learning: Record<string, LearningRecord>;
  /** Kept separately: perceiving an outcome and learning from one's choice are different operations. */
  appraisalRoots: string[];
  learnedRoots: string[];
  appraisalEpisodes: Record<string, number>;
  learningEpisodes: Record<string, number>;
}
export interface Appraisal {
  id: string;
  eventIds: string[];
  rootIds: string[];
  episodeId?: string;
  subjectIds?: string[];
  /** Positive = relative relief of existing deficit; negative = relative increase. */
  needEffects?: NeedEffects;
  salience: number;
  novelty: number;
  control: number;
  uncertainty: number;
  /** Optional validated bodily stimulus. It does not assert consent, pleasure or relationship affinity. */
  physiology?: { stimulation: number; inhibition: number };
}
export interface AppraisalEffect {
  applied: boolean;
  reason?: "no-evidence" | "duplicate-root";
  weight: number;
  satisfaction: number;
  needChanges: Record<Need, number>;
  physiologyTransition?: "peak";
}
export interface DecisionCandidate {
  id: string;
  call: ParsedToolCall;
  contextKey: string;
  subjectIds?: string[];
  /** Optional stable strategy identifier; tool name and actual identity scope remain part of its key. */
  strategyKey?: string;
  /** Settle direct execution separately from a subsequent social response. */
  settlement?: OutcomeSettlement;
  expectedEffects: NeedEffects;
  cost: number;
  risk: number;
  /** A commitment can justify accepting immediate discomfort; never overrides tool authorization. */
  commitment?: number;
}
export interface OutcomePrediction {
  decisionId: string;
  candidateId: string;
  contextKey: string;
  actionKey: string;
  learningKey: string;
  toolName: string;
  call: ParsedToolCall;
  strategyKey?: string;
  /** Settle direct execution separately from a subsequent social response. */
  settlement?: OutcomeSettlement;
  subjectIds: string[];
  expectedEffects: Record<Need, number>;
  needWeights: Record<Need, number>;
  /** Negative effects endanger conditions already maintained, even when there is little unmet need. */
  needIncreaseWeights: Record<Need, number>;
  expectedUtility: number;
  at: number;
}
export interface ScoredCandidate {
  candidate: DecisionCandidate;
  score: number;
  prediction: OutcomePrediction;
  factors: { needValue: number; cost: number; risk: number; commitment: number; exploration: number; learnedSamples: number };
}
export interface ObservedOutcome {
  eventIds: string[];
  rootIds: string[];
  episodeId?: string;
  agency: "self" | "avatar" | "imposed" | "observed" | "unknown";
  outcome: "completed" | "failed" | "unknown";
  observedEffects: NeedEffects;
}
export interface LearningResult { state: RegulationState; learning?: LearningRecord; reason?: string }

const zeros = (): Record<Need, number> => Object.fromEntries(NEEDS.map(k => [k, 0])) as Record<Need, number>;
const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : 0));
const finite = (x: number, fallback: number): number => Number.isFinite(x) ? x : fallback;
const halfDecay = (seconds: number, halfLife: number): number => 2 ** (-seconds / halfLife);
const cleanEffects = (effects: NeedEffects): Record<Need, number> => Object.fromEntries(NEEDS.map(k => [k, clamp(effects[k] ?? 0, -1, 1)])) as Record<Need, number>;
const sortedIds = (ids: string[] = []): string[] => [...new Set(ids.filter(id => typeof id === "string" && id.length > 0))].sort();
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function clone(state: RegulationState): RegulationState { return structuredClone(state); }

export function createState(worldSeconds = 0, options: Partial<Omit<RegulationOptions, "needDriftPerHour">> & { needDriftPerHour?: NeedEffects } = {}): RegulationState {
  const configured: RegulationOptions = {
    needDriftPerHour: zeros(), tonicHalfLifeSeconds: 3600, phasicHalfLifeSeconds: 60,
    adaptationHalfLifeSeconds: 1800, baseline: 0.5, learningRate: 0.3,
    physiologyEnabled: false, peakSeconds: 5, recoverySeconds: 120,
  };
  for (const need of NEEDS) configured.needDriftPerHour[need] = clamp(options.needDriftPerHour?.[need] ?? 0);
  for (const key of ["tonicHalfLifeSeconds", "phasicHalfLifeSeconds", "adaptationHalfLifeSeconds", "peakSeconds", "recoverySeconds"] as const) {
    configured[key] = clamp(options[key] ?? configured[key], 1, 604800);
  }
  configured.baseline = clamp(options.baseline ?? configured.baseline);
  configured.learningRate = clamp(options.learningRate ?? configured.learningRate);
  configured.physiologyEnabled = options.physiologyEnabled === true;
  return {
    version: 1, at: finite(worldSeconds, 0), options: configured,
    needs: { recovery: 0.2, connection: 0.2, autonomy: 0.2, competence: 0.2, novelty: 0.2 },
    modulators: Object.fromEntries(MODULATORS.map(k => [k, { tonic: configured.baseline, phasic: 0, adaptation: 0 }])) as Record<Modulator, ModulatorState>,
    control: 0.5, uncertainty: 0.5,
    physiology: { excitation: 0, inhibition: 0, phase: "idle", peaks: 0 },
    learning: {}, appraisalRoots: [], learnedRoots: [], appraisalEpisodes: {}, learningEpisodes: {},
  };
}

/** Exact exponential transitions make split updates equivalent to one update. No real-time timer is involved. */
export function advanceState(state: RegulationState, worldSeconds: number): RegulationState {
  const next = clone(state);
  const at = Math.max(state.at, finite(worldSeconds, state.at));
  const elapsed = at - state.at;
  if (!elapsed) return next;
  const o = next.options;
  for (const need of NEEDS) if (o.needDriftPerHour[need] > 0) next.needs[need] = clamp(1 - (1 - next.needs[need]) * Math.exp(-o.needDriftPerHour[need] * elapsed / 3600));
  for (const key of MODULATORS) {
    const m = next.modulators[key];
    m.tonic = clamp(o.baseline + (m.tonic - o.baseline) * halfDecay(elapsed, o.tonicHalfLifeSeconds));
    m.phasic = clamp(m.phasic * halfDecay(elapsed, o.phasicHalfLifeSeconds), -1, 1);
    m.adaptation = clamp(m.adaptation * halfDecay(elapsed, o.adaptationHalfLifeSeconds));
  }
  const slow = halfDecay(elapsed, o.tonicHalfLifeSeconds);
  next.control = clamp(0.5 + (next.control - 0.5) * slow);
  next.uncertainty = clamp(0.5 + (next.uncertainty - 0.5) * slow);
  const body = next.physiology;
  body.excitation *= halfDecay(elapsed, 30);
  body.inhibition *= halfDecay(elapsed, 60);
  if (body.phase === "peak" && at >= (body.peakUntil ?? at)) body.phase = "recovery";
  if (body.phase === "recovery" && at >= (body.recoveryUntil ?? at)) {
    body.phase = body.excitation > 0.01 ? "rising" : "idle";
    delete body.peakUntil; delete body.recoveryUntil;
  }
  if (body.phase === "rising" && body.excitation <= 0.01) body.phase = "idle";
  next.at = at;
  return next;
}

function pulse(state: RegulationState, key: Modulator, input: number): void {
  const m = state.modulators[key];
  const raw = clamp(input, -1, 1);
  const drive = raw * (1 - m.adaptation);
  m.phasic = clamp(m.phasic + drive * (drive >= 0 ? 1 - m.phasic : 1 + m.phasic), -1, 1);
  m.tonic = clamp(m.tonic + drive * 0.08 * (raw >= 0 ? 1 - m.tonic : m.tonic));
  m.adaptation = clamp(m.adaptation + Math.abs(raw) * 0.22 * (1 - m.adaptation));
}

export function applyAppraisal(state: RegulationState, appraisal: Appraisal, worldSeconds = state.at): { state: RegulationState; effect: AppraisalEffect } {
  const next = advanceState(state, worldSeconds);
  const roots = sortedIds(appraisal.rootIds);
  const effect: AppraisalEffect = { applied: false, weight: 0, satisfaction: 0, needChanges: zeros() };
  if (!roots.length || !sortedIds(appraisal.eventIds).length) return { state: next, effect: { ...effect, reason: "no-evidence" } };
  // Mixed old/new batches must be split by the caller; their aggregated interpretation cannot safely be disentangled here.
  if (roots.some(root => next.appraisalRoots.includes(root))) return { state: next, effect: { ...effect, reason: "duplicate-root" } };
  next.appraisalRoots.push(...roots);
  const episode = hash(appraisal.episodeId ? ["episode", appraisal.episodeId] : ["roots", roots]);
  const exposures = next.appraisalEpisodes[episode] ?? 0;
  const weight = 1 / (1 + exposures);
  next.appraisalEpisodes[episode] = exposures + 1;
  effect.applied = true; effect.weight = weight;
  const impacts = cleanEffects(appraisal.needEffects ?? {});
  for (const need of NEEDS) {
    const old = next.needs[need];
    const impact = impacts[need] * weight;
    next.needs[need] = clamp(impact >= 0 ? old * (1 - impact) : old + (1 - old) * -impact);
    effect.needChanges[need] = old - next.needs[need];
    effect.satisfaction += effect.needChanges[need] / NEEDS.length;
  }
  const novelty = clamp(appraisal.novelty) * weight;
  const salience = clamp(appraisal.salience) * weight;
  const uncertainty = clamp(appraisal.uncertainty);
  const control = clamp(appraisal.control);
  const response = salience * 0.35;
  next.control = clamp(next.control + (control - next.control) * response);
  next.uncertainty = clamp(next.uncertainty + (uncertainty - next.uncertainty) * response);
  // A novelty signal is separate from the outcome prediction error used by learnOutcome.
  pulse(next, "dopamine", novelty * 0.15);
  pulse(next, "noradrenaline", salience * (0.25 + 0.65 * uncertainty + 0.1 * (1 - control)));
  pulse(next, "serotonin", salience * (control - 0.5) * 0.3);
  pulse(next, "opioid", effect.satisfaction * 2);
  pulse(next, "oxytocin", effect.needChanges.connection * 0.7);
  if (next.options.physiologyEnabled && appraisal.physiology) {
    const body = next.physiology;
    const inhibition = clamp(appraisal.physiology.inhibition);
    body.inhibition = clamp(body.inhibition + inhibition * (1 - body.inhibition));
    if (body.phase !== "peak" && body.phase !== "recovery") {
      body.excitation = clamp(body.excitation + clamp(appraisal.physiology.stimulation) * (1 - body.inhibition) * weight * 0.8);
      if (body.excitation >= 0.75) {
        body.phase = "peak"; body.peaks++;
        body.peakUntil = next.at + next.options.peakSeconds;
        body.recoveryUntil = body.peakUntil + next.options.recoverySeconds;
        effect.physiologyTransition = "peak";
      } else if (body.excitation > 0.01) body.phase = "rising";
    }
  }
  return { state: next, effect };
}

/** This is the concrete receiver side: signal ablation changes action scores and learning rates. */
export function regulationGains(state: RegulationState): { learning: number; effort: number; caution: number; exploration: number; connection: number; inhibition: number; attention: number; recovery: number } {
  const activity = (key: Modulator): number => clamp(state.modulators[key].tonic + state.modulators[key].phasic * 0.5);
  const da = activity("dopamine"), na = activity("noradrenaline"), se = activity("serotonin"), op = activity("opioid"), ox = activity("oxytocin");
  // Engineering assumptions for a generic bodily reflex: during a peak less processing
  // is available for new external exploration; afterwards low-effort recovery choices
  // become relatively attractive. This changes receivers, never physical world facts,
  // attachment, willingness, pleasure scores, or the deficits themselves.
  const phase = state.options.physiologyEnabled ? state.physiology.phase : "idle";
  const body = {
    idle: { attention: 1, effort: 1, inhibition: 1, recovery: 1 },
    rising: { attention: 0.85, effort: 0.9, inhibition: 1.1, recovery: 1.05 },
    peak: { attention: 0.35, effort: 0.45, inhibition: 1.5, recovery: 1.4 },
    recovery: { attention: 0.8, effort: 0.7, inhibition: 1.2, recovery: 1.6 },
  }[phase];
  return {
    attention: body.attention, recovery: body.recovery,
    learning: (0.5 + da * 0.7 + na * 0.4) * body.attention,
    effort: (0.55 + da * 0.65 - state.needs.recovery * 0.25) * body.effort,
    caution: 0.6 + na * state.uncertainty * 1.1 + (1 - state.control) * 0.35,
    exploration: (0.1 + da * 0.35 + state.control * 0.25 - na * state.uncertainty * 0.25) * body.attention,
    connection: 0.75 + ox * 0.5,
    inhibition: (0.55 + se * 0.35 + op * 0.1) * body.inhibition,
  };
}

export function scoreCandidates(state: RegulationState, candidates: DecisionCandidate[], decisionId = `decision-${state.at}`): ScoredCandidate[] {
  const gains = regulationGains(state);
  return candidates.map(candidate => {
    const subjectIds = sortedIds(candidate.subjectIds);
    const actionKey = hash(candidate.strategyKey
      ? [candidate.call.name, candidate.strategyKey]
      : [candidate.call.name, canonical(candidate.call.arguments), candidate.call.duration ?? null]);
    const settlement = candidate.settlement ?? "completion";
    const learningKey = hash([candidate.contextKey, actionKey, subjectIds, settlement]);
    const memory = state.learning[learningKey];
    const proposed = cleanEffects(candidate.expectedEffects);
    const confidence = memory ? memory.weight / (memory.weight + 2) : 0;
    const expectedEffects = zeros(), needWeights = zeros(), needIncreaseWeights = zeros();
    for (const need of NEEDS) {
      expectedEffects[need] = proposed[need] * (1 - confidence) + (memory?.expectedEffects[need] ?? 0) * confidence;
      const receiver = need === "connection" ? gains.connection : need === "recovery" ? gains.recovery : 1;
      needWeights[need] = state.needs[need] * receiver;
      needIncreaseWeights[need] = (1 - state.needs[need]) * receiver;
    }
    const utility = NEEDS.reduce((sum, need) => sum + expectedEffects[need] * (expectedEffects[need] >= 0 ? needWeights[need] : needIncreaseWeights[need]), 0);
    const factors = {
      needValue: utility, cost: clamp(candidate.cost) * (1.2 - gains.effort * 0.5), risk: clamp(candidate.risk) * gains.caution,
      commitment: clamp(candidate.commitment ?? 0) * (0.65 + gains.inhibition * 0.2),
      exploration: state.needs.novelty * gains.exploration * 0.15 / (1 + (memory?.samples ?? 0)),
      learnedSamples: memory?.samples ?? 0,
    };
    return {
      candidate, score: utility - factors.cost - factors.risk + factors.commitment + factors.exploration,
      factors,
      prediction: { decisionId, candidateId: candidate.id, contextKey: candidate.contextKey, actionKey, learningKey, subjectIds,
        toolName: candidate.call.name, call: structuredClone(candidate.call), settlement, ...(candidate.strategyKey ? { strategyKey: candidate.strategyKey } : {}),
        expectedEffects, needWeights, needIncreaseWeights, expectedUtility: utility, at: state.at },
    };
  }).sort((a, b) => b.score - a.score); // Stable sort preserves the caller's original-choice priority on ties.
}

export function learnOutcome(state: RegulationState, prediction: OutcomePrediction, outcome: ObservedOutcome, worldSeconds = state.at): LearningResult {
  const next = advanceState(state, worldSeconds);
  if (next.options.learningRate === 0) return { state: next, reason: "learning-paused" };
  if (outcome.agency !== "self") return { state: next, reason: "not-an-autonomous-choice" };
  // Unlike habit evidence, a known failed attempt is useful for learning action reliability.
  if (outcome.outcome === "unknown") return { state: next, reason: "outcome-not-confirmed" };
  if (prediction.at > next.at) return { state: next, reason: "prediction-after-outcome" };
  const roots = sortedIds(outcome.rootIds);
  if (!roots.length || !sortedIds(outcome.eventIds).length) return { state: next, reason: "no-evidence" };
  if (roots.some(root => next.learnedRoots.includes(root))) return { state: next, reason: "duplicate-root" };
  next.learnedRoots.push(...roots);
  const episodeKey = hash([prediction.learningKey, outcome.episodeId || hash(roots)]);
  const count = next.learningEpisodes[episodeKey] ?? 0;
  next.learningEpisodes[episodeKey] = count + 1;
  const weight = 1 / (1 + count) ** 2;
  const actual = cleanEffects(outcome.observedEffects);
  const observed = NEEDS.reduce((sum, need) => sum + actual[need] * (actual[need] >= 0 ? prediction.needWeights[need] : prediction.needIncreaseWeights[need]), 0);
  const predictionError = observed - prediction.expectedUtility;
  const previous = next.learning[prediction.learningKey];
  const alpha = clamp(next.options.learningRate * regulationGains(next).learning * weight);
  const expectedEffects = zeros();
  for (const need of NEEDS) {
    const old = previous?.expectedEffects[need] ?? prediction.expectedEffects[need];
    expectedEffects[need] = clamp(old + alpha * (actual[need] - old), -1, 1);
  }
  const learning: LearningRecord = {
    key: prediction.learningKey, contextKey: prediction.contextKey, actionKey: prediction.actionKey,
    toolName: prediction.toolName, call: structuredClone(prediction.call), settlement: prediction.settlement ?? "completion", ...(prediction.strategyKey ? { strategyKey: prediction.strategyKey } : {}),
    subjectIds: [...prediction.subjectIds], expectedEffects, samples: (previous?.samples ?? 0) + (count === 0 ? 1 : 0),
    weight: (previous?.weight ?? 0) + weight, updatedAt: next.at,
    last: { expected: prediction.expectedUtility, observed, predictionError, outcome: outcome.outcome, eventIds: sortedIds(outcome.eventIds), rootIds: roots, ...(outcome.episodeId ? { episodeId: outcome.episodeId } : {}) },
  };
  next.learning[learning.key] = learning;
  pulse(next, "dopamine", clamp(predictionError, -1, 1) * weight);
  return { state: next, learning };
}

export function describeRegulation(state: RegulationState): string {
  const labels: Record<Need, string> = { recovery: "留出恢复与休息的空间", connection: "获得可靠的交流与联系", autonomy: "能够自主决定与改变处境", competence: "取得切实进展", novelty: "接触新的事物" };
  const priorities = NEEDS.filter(need => state.needs[need] >= 0.35).sort((a, b) => state.needs[b] - state.needs[a]);
  const lines = priorities.length ? [`眼下更在意${priorities.slice(0, 3).map(need => labels[need]).join("、")}。`] : ["眼下没有特别强的未满足需要，可以结合处境和已有承诺决定下一步。"];
  if (state.uncertainty > 0.65) lines.push("重要结果还有不少不确定性，可以优先留意能帮助判断的信息；反复查看同一信息不会带来新证据。");
  if (state.control < 0.35) lines.push("目前对改变处境的把握较小，尝试较小的步骤或寻求帮助也有意义。");
  lines.push("这些是此刻的行动倾向，可以为了自己的承诺与长期目标接受眼前的成本；不代表外界事实或他人的意愿。");
  return lines.join("\n");
}
