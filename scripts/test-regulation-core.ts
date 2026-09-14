import assert from "node:assert/strict";
import {
  NEEDS, MODULATORS, createState, advanceState, applyAppraisal, scoreCandidates, learnOutcome,
  describeRegulation, regulationGains, type Appraisal, type DecisionCandidate, type RegulationState,
} from "../src/bot/regulation-core.js";

const close = (a: number, b: number, message = "world-time integration must be partition invariant") => assert.ok(Math.abs(a - b) < 1e-10, `${message}: ${a} vs ${b}`);
const stimulus = (id: string, effects: Appraisal["needEffects"] = { connection: 0.5 }, extra: Partial<Appraisal> = {}): Appraisal => ({
  id, eventIds: [`event-${id}`], rootIds: [`root-${id}`], episodeId: `episode-${id}`, needEffects: effects,
  salience: 0.6, novelty: 0.2, control: 0.7, uncertainty: 0.2, ...extra,
});
const candidate = (id: string, effects: DecisionCandidate["expectedEffects"], extra: Partial<DecisionCandidate> = {}): DecisionCandidate => ({
  id, call: { name: "act", arguments: { description: id } }, contextKey: "在家选择下一件事情",
  expectedEffects: effects, cost: 0.05, risk: 0.01, ...extra,
});
const selected = (state: RegulationState, candidates: DecisionCandidate[]): string => scoreCandidates(state, candidates)[0]!.candidate.id;

// Needs have causal force on action selection without any emotion adjective or an LLM being involved.
const choices = [candidate("休息", { recovery: 0.8 }), candidate("联系朋友", { connection: 0.8 })];
const tired = createState(); tired.needs.recovery = 0.9; tired.needs.connection = 0.1;
const isolated = createState(); isolated.needs.recovery = 0.1; isolated.needs.connection = 0.9;
assert.equal(selected(tired, choices), "休息");
assert.equal(selected(isolated, choices), "联系朋友");
const relieved = applyAppraisal(tired, stimulus("rested", { recovery: 1 }), 60);
assert.equal(selected(relieved.state, choices), "联系朋友", "verified relief removes the incentive to keep harvesting the same need");
assert.deepEqual(tired.needs, { recovery: 0.9, connection: 0.1, autonomy: 0.2, competence: 0.2, novelty: 0.2 }, "core calls do not mutate a caller's committed state");

// Preserving a satisfied condition still matters: a full connection need is not permission to damage it.
const secure = createState(); secure.needs.connection = 0; secure.needs.novelty = 0.4;
assert.equal(selected(secure, [candidate("损害可靠联系换取新鲜感", { connection: -1, novelty: 1 }), candidate("保留联系", {})]), "保留联系");

// A transmitter-inspired receiver genuinely changes the chosen action: ablation removes its effect.
const riskChoices = [candidate("尝试困难方案", { competence: 0.9 }, { risk: 0.4, cost: 0 }), candidate("走熟悉路线", { competence: 0.2 }, { risk: 0, cost: 0 })];
const alert = createState(); alert.needs.competence = 0.65; alert.uncertainty = 1; alert.control = 0.5;
alert.modulators.noradrenaline.tonic = 1;
const ablated = structuredClone(alert); ablated.modulators.noradrenaline.tonic = 0;
assert.equal(selected(alert, riskChoices), "走熟悉路线");
assert.equal(selected(ablated, riskChoices), "尝试困难方案");
assert.notEqual(regulationGains(alert).caution, regulationGains(ablated).caution);
const promise = candidate("完成答应的事情", { recovery: -0.1 }, { cost: 0.2, commitment: 1 });
assert.equal(selected(tired, [candidate("即时轻松", { recovery: 0.2 }), promise]), "完成答应的事情", "immediate need relief does not erase commitment");

// Recovery follows world seconds, not call frequency; the state survives JSON persistence.
let activated = applyAppraisal(createState(100, { needDriftPerHour: { recovery: 0.1 } }), stimulus("important"), 100).state;
const oneStep = advanceState(activated, 10900);
let manySteps = JSON.parse(JSON.stringify(activated)) as RegulationState;
for (let at = 101; at <= 10900; at += 1) manySteps = advanceState(manySteps, at);
for (const key of NEEDS) close(oneStep.needs[key], manySteps.needs[key]);
for (const key of MODULATORS) for (const dimension of ["tonic", "phasic", "adaptation"] as const) close(oneStep.modulators[key][dimension], manySteps.modulators[key][dimension]);
close(oneStep.control, manySteps.control); close(oneStep.uncertainty, manySteps.uncertainty);
assert.deepEqual(advanceState(activated, 0), activated, "a clock correction cannot rewind completed adaptation");
assert.ok(oneStep.modulators.noradrenaline.phasic < 1e-10);
assert.equal(advanceState(createState(), 1e12).needs.recovery, 0.2, "elapsed time alone must not fabricate body fatigue or its recovery");

// Re-reading is not rewarding again. New messages in one episode have diminishing influence.
const original = stimulus("praise", { connection: 0.7 });
const first = applyAppraisal(isolated, original);
const repeated = applyAppraisal(first.state, { ...original, id: "reread", eventIds: ["history-copy"], episodeId: "new-label" });
assert.equal(repeated.effect.reason, "duplicate-root"); assert.deepEqual(repeated.state, first.state);
let praise = first.state;
let lastSatisfaction = first.effect.satisfaction;
for (let i = 0; i < 60; i++) {
  const result = applyAppraisal(praise, stimulus(`praise-${i}`, { connection: 0.7 }, { episodeId: original.episodeId, novelty: 0 }));
  assert.ok(result.effect.satisfaction < lastSatisfaction);
  lastSatisfaction = result.effect.satisfaction; praise = result.state;
}
assert.ok(lastSatisfaction < first.effect.satisfaction / 100, "repeat praise cannot provide a stationary stream of satisfaction");
assert.ok(praise.modulators.oxytocin.phasic < 1 && praise.modulators.oxytocin.tonic < 1);
const noEvidence = applyAppraisal(praise, stimulus("fabricated", { connection: 1 }, { rootIds: [] }));
assert.equal(noEvidence.effect.applied, false); assert.deepEqual(noEvidence.state, praise);

// Learn a disappointing strategy through independent completed choices, then prefer its alternative.
const askAlice = candidate("找甲帮忙", { competence: 0.9 }, { strategyKey: "请对方协助排查", subjectIds: ["platform:alice"] });
const selfWork = candidate("自己查资料", { competence: 0.4 });
let learner = createState(); learner.needs.competence = 0.8;
assert.equal(selected(learner, [askAlice, selfWork]), "找甲帮忙");
for (let i = 0; i < 8; i++) {
  const prediction = scoreCandidates(learner, [askAlice], `decision-${i}`)[0]!.prediction;
  const result = learnOutcome(learner, prediction, { eventIds: [`outcome-${i}`], rootIds: [`choice-${i}`], episodeId: `day-${i}`, agency: "self", outcome: "completed", observedEffects: { competence: -0.3 } }, i + 1);
  assert.ok(result.learning!.last.predictionError < 0);
  learner = result.state;
}
assert.equal(selected(learner, [askAlice, selfWork]), "自己查资料", "repeated counterevidence changes actual decisions");
const askBob = { ...askAlice, subjectIds: ["platform:bob"], id: "找乙帮忙" };
assert.equal(scoreCandidates(learner, [askBob])[0]!.factors.learnedSamples, 0, "one person's unreliability is not inherited by another person");
const noDuplicate = learnOutcome(learner, scoreCandidates(learner, [askAlice])[0]!.prediction,
  { eventIds: ["reread-result"], rootIds: ["choice-1"], episodeId: "misleading-new-episode", agency: "self", outcome: "completed", observedEffects: { competence: 1 } }, 9);
assert.equal(noDuplicate.reason, "duplicate-root");
for (const agency of ["avatar", "imposed", "observed", "unknown"] as const) {
  const forbidden = learnOutcome(learner, scoreCandidates(learner, [askAlice])[0]!.prediction,
    { eventIds: ["result"], rootIds: [`controlled-${agency}`], agency, outcome: "completed", observedEffects: { competence: 1 } }, 10);
  assert.equal(forbidden.learning, undefined); assert.deepEqual(forbidden.state.learning, learner.learning);
}
assert.equal(learnOutcome(learner, scoreCandidates(learner, [askAlice])[0]!.prediction,
  { eventIds: ["result"], rootIds: ["unconfirmed"], agency: "self", outcome: "unknown", observedEffects: {} }).learning, undefined);

// Confirmed autonomous failure changes expected usefulness, but an unknown result does not fabricate it.
const hopeful = createState(); hopeful.needs.competence = 0.8;
let failures = hopeful;
for (let i = 0; i < 8; i++) {
  const prediction = scoreCandidates(failures, [askAlice], `failed-decision-${i}`)[0]!.prediction;
  const knownFailure = learnOutcome(failures, prediction, { eventIds: [`failed-event-${i}`], rootIds: [`failed-root-${i}`],
    episodeId: `failed-day-${i}`, agency: "self", outcome: "failed", observedEffects: { competence: 0 } }, i + 1);
  assert.equal(knownFailure.learning!.last.outcome, "failed");
  assert.ok(knownFailure.learning!.last.predictionError < 0);
  failures = knownFailure.state;
}
assert.equal(selected(failures, [askAlice, selfWork]), "自己查资料", "known failed attempts revise overoptimistic expectations");
for (const agency of ["imposed", "avatar"] as const) {
  const result = learnOutcome(hopeful, scoreCandidates(hopeful, [askAlice])[0]!.prediction,
    { eventIds: ["controlled-failure"], rootIds: [`controlled-failure-${agency}`], agency, outcome: "failed", observedEffects: { competence: -1 } });
  assert.equal(result.learning, undefined); assert.deepEqual(result.state.learning, {});
}
const reloaded = JSON.parse(JSON.stringify(failures)) as RegulationState;
const understandable = Object.values(reloaded.learning)[0]!;
assert.equal(understandable.toolName, "act"); assert.deepEqual(understandable.call, askAlice.call);
assert.equal(understandable.strategyKey, "请对方协助排查");
assert.equal(understandable.last.outcome, "failed"); assert.deepEqual(understandable.subjectIds, ["platform:alice"]);
const newWording = { ...askAlice, call: { name: "act", arguments: { description: "再次向甲请教排查的方法" } } };
assert.ok(scoreCandidates(reloaded, [newWording])[0]!.factors.learnedSamples > 0, "readable stable strategies can reuse learned expectations across wording after restart");
const copiedPrediction = scoreCandidates(hopeful, [newWording])[0]!.prediction;
newWording.call.arguments.description = "后来改写的动作";
assert.notEqual(copiedPrediction.call.arguments.description, newWording.call.arguments.description, "a saved prediction owns an immutable copy of the action actually considered");

// A predictable useful result still relieves a need, even when its prediction error is exactly zero.
const familiar = createState(); familiar.needs.connection = 0.8;
const company = candidate("熟悉的陪伴", { connection: 0.5 });
const expected = scoreCandidates(familiar, [company])[0]!.prediction;
const satisfied = applyAppraisal(familiar, stimulus("company", { connection: 0.5 }, { novelty: 0 }));
const learned = learnOutcome(satisfied.state, expected, { eventIds: ["company"], rootIds: ["root-company"], episodeId: "evening", agency: "self", outcome: "completed", observedEffects: { connection: 0.5 } });
assert.ok(satisfied.effect.satisfaction > 0); close(learned.learning!.last.predictionError, 0);
assert.equal(learned.state.modulators.dopamine.phasic, familiar.modulators.dopamine.phasic, "satisfaction must not manufacture surprise");

// Zero learning rate is a true pause: no evidence consumption, surprise pulse, sample or confidence increase.
const paused = createState(0, { learningRate: 0 });
const pausedPrediction = scoreCandidates(paused, [company])[0]!.prediction;
const pausedLearning = learnOutcome(paused, pausedPrediction, { eventIds: ["pause-result"], rootIds: ["pause-root"], episodeId: "pause-evening", agency: "self", outcome: "completed", observedEffects: { connection: 1 } });
assert.equal(pausedLearning.reason, "learning-paused"); assert.deepEqual(pausedLearning.state, paused);
assert.deepEqual(scoreCandidates(createState(), [candidate("proposed", {}), candidate("alternative", {})]).map(item => item.candidate.id), ["proposed", "alternative"], "equal scores preserve the original action rather than imposing alphabetical preference");

// Execution and a later social response are distinct expectations even for the identical strategy.
const immediateSend = { ...company, call: { name: "send", arguments: { msg: "今晚一起散步吗？" } }, strategyKey: "邀请散步", settlement: "completion" as const };
const awaitedReply = { ...immediateSend, settlement: "reply" as const };
const sendPrediction = scoreCandidates(familiar, [immediateSend])[0]!.prediction;
const replyPrediction = scoreCandidates(familiar, [awaitedReply])[0]!.prediction;
assert.notEqual(sendPrediction.learningKey, replyPrediction.learningKey);
assert.equal(replyPrediction.settlement, "reply");
const responseLearned = learnOutcome(familiar, replyPrediction, { eventIds: ["friend-answer"], rootIds: ["friend-answer"], agency: "self", outcome: "completed", observedEffects: { connection: .5 } });
assert.equal(responseLearned.learning!.settlement, "reply");
assert.equal(scoreCandidates(responseLearned.state, [immediateSend])[0]!.factors.learnedSamples, 0, "social response cannot be learned as delivery success");
assert.equal(scoreCandidates(familiar, [{ ...immediateSend, settlement: undefined }])[0]!.prediction.learningKey, sendPrediction.learningKey, "legacy omitted settlement means direct completion");

// The modulation receiver changes how strongly counterevidence is learned, not just its textual description.
const lowPlasticity = createState(); lowPlasticity.modulators.dopamine.tonic = 0;
const highPlasticity = structuredClone(lowPlasticity); highPlasticity.modulators.dopamine.tonic = 1;
const newPlan = candidate("尝试新方案", { competence: 0 });
const positiveResult = { eventIds: ["new-result"], rootIds: ["new-result"], episodeId: "new-opportunity", agency: "self" as const, outcome: "completed" as const, observedEffects: { competence: 0.8 } };
const slowly = learnOutcome(lowPlasticity, scoreCandidates(lowPlasticity, [newPlan])[0]!.prediction, positiveResult);
const quickly = learnOutcome(highPlasticity, scoreCandidates(highPlasticity, [newPlan])[0]!.prediction, positiveResult);
assert.ok(quickly.learning!.expectedEffects.competence > slowly.learning!.expectedEffects.competence);

// One activity repeated without a new episode cannot pretend to be many independent learning samples.
let loop = createState();
for (let i = 0; i < 10; i++) loop = learnOutcome(loop, scoreCandidates(loop, [company])[0]!.prediction,
  { eventIds: [`loop-${i}`], rootIds: [`loop-${i}`], episodeId: "same-evening", agency: "self", outcome: "completed", observedEffects: { connection: 0.5 } }).state;
const loopMemory = Object.values(loop.learning)[0]!;
assert.equal(loopMemory.samples, 1); assert.ok(loopMemory.weight < 1.65);

// Optional physiological response is a threshold event with a refractory interval, not a social preference.
const bodyInput = stimulus("body", {}, { novelty: 0, salience: 0, physiology: { stimulation: 1, inhibition: 0 } });
assert.equal(applyAppraisal(createState(), bodyInput).state.physiology.phase, "idle", "physical reflex is opt-in");
const body = createState(0, { physiologyEnabled: true });
const peak = applyAppraisal(body, bodyInput);
assert.equal(peak.effect.physiologyTransition, "peak"); assert.equal(peak.state.physiology.peaks, 1);
assert.deepEqual(peak.state.needs, body.needs); assert.deepEqual(peak.state.learning, {});
assert.equal(peak.state.modulators.oxytocin.phasic, 0, "a bodily response does not assert attachment, pleasure or voluntary preference");
const reflexActive = structuredClone(peak.state); reflexActive.needs.competence = 0.8;
const reflexAblated = structuredClone(reflexActive); reflexAblated.options.physiologyEnabled = false;
const bodyChoices = [candidate("投入困难工作", { competence: 0.8 }, { cost: 0.4, risk: 0.1 }), candidate("留出休息空间", { recovery: 0.8 }, { cost: 0, risk: 0 })];
assert.equal(selected(reflexAblated, bodyChoices), "投入困难工作");
assert.equal(selected(reflexActive, bodyChoices), "留出休息空间", "enabled body phase affects actual choices even without injecting a narrative sensation");
assert.ok(regulationGains(reflexActive).attention < regulationGains(reflexAblated).attention);
assert.ok(regulationGains(reflexActive).inhibition > regulationGains(reflexAblated).inhibition);
assert.deepEqual(reflexActive.needs, reflexAblated.needs, "phase receiver does not fabricate changes in body needs");
assert.equal(regulationGains(advanceState(reflexActive, 600)).attention, 1, "phase's attentional effect ends after recovery");
const recovering = advanceState(peak.state, 6);
assert.equal(recovering.physiology.phase, "recovery");
assert.equal(applyAppraisal(recovering, { ...bodyInput, id: "again", rootIds: ["body-again"] }, 7).state.physiology.peaks, 1);
const settled = advanceState(peak.state, 600);
assert.equal(settled.physiology.phase, "idle"); assert.ok(settled.physiology.excitation < 0.001);
const splitRecovery = advanceState(advanceState(peak.state, 6), 600);
close(splitRecovery.physiology.excitation, settled.physiology.excitation);
close(splitRecovery.physiology.inhibition, settled.physiology.inhibition);
assert.equal(splitRecovery.physiology.phase, settled.physiology.phase);
assert.equal(splitRecovery.physiology.peaks, settled.physiology.peaks);
assert.notEqual(applyAppraisal(body, { ...bodyInput, physiology: { stimulation: 1, inhibition: 1 } }).state.physiology.phase, "peak");
assert.match(describeRegulation(tired), /恢复与休息/);
assert.doesNotMatch(describeRegulation(tired), /多巴胺|开心|难过|愤怒|快乐值/);
console.log("PASS regulation core: causal choice/receiver ablation, exact recovery, saturation, scoped counterevidence, agency, prediction error and optional reflex.");
