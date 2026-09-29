/** Delivered longitudinal evidence survives dense recent activity; no live data/models. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrowthLedger, independentGrowthChoices, type GrowthRecord, type PerceivedEvidence } from "../src/bot/growth.js";
import { selectLongitudinalEvidence } from "../src/bot/growth-longitudinal.js";
import type { BotEvent } from "../src/types.js";

const DAY = 86400;
function choice(id: string, at: number, action = "晚饭后沿河散步", situation = "晚饭后", root = id): BotEvent {
  return { id, source: "world", worldTime: at, content: `在河边经历了实际行动：${action}。`, originEventIds: [root],
    experience: { agency: "self", outcome: "completed", opportunity: true, episodeId: id, action, situation } };
}
function evidence(event: BotEvent): PerceivedEvidence {
  return { eventId: event.id, actorId: "bot", source: event.source, observedAt: event.worldTime, text: event.content,
    rootEventIds: event.originEventIds!, experience: event.experience };
}
async function consume(ledger: GrowthLedger, at: number) {
  for (let i = 0; i < 100; i++) {
    const snapshot = await ledger.snapshotReview({ at, minimumEpisodes: 1, maxEpisodes: 100 });
    if (!snapshot) return;
    await ledger.commitReview(snapshot, [], at);
  }
  throw new Error("test fixture did not consume its finite evidence backlog");
}

async function denseHistory(base: string) {
  const ledger = new GrowthLedger(base);
  await ledger.perceive(choice("old-day-zero", 10));
  await ledger.perceive(choice("old-day-two", 2 * DAY));
  for (let i = 0; i < 100; i++) await ledger.perceive(choice(`dense-${i}`, 8 * DAY + i));
  await consume(ledger, 8 * DAY + 100);
  const now = 8 * DAY + 200;
  await ledger.perceive(choice("current-walk", now));
  await ledger.perceive(choice("current-other", now + 1, "给阳台花盆浇水", "照顾花草"));
  const snapshot = (await ledger.snapshotReview({ at: now + 1, minimumEpisodes: 1, secondsPerTU: 1 }))!;
  assert.ok(snapshot.evidence.length <= 24);
  for (const id of ["old-day-zero", "old-day-two", "current-walk", "current-other"]) {
    assert.ok(snapshot.evidence.some(item => item.eventId === id), `${id} must survive the dense recent streak`);
  }
  const walks = independentGrowthChoices(snapshot.evidence).filter(item => item.experience!.action === "晚饭后沿河散步");
  assert.ok(walks.length >= 6);
  assert.ok(Math.max(...walks.map(item => item.observedAt)) - Math.min(...walks.map(item => item.observedAt)) >= 7 * DAY);
  assert.ok(snapshot.reviewEventIds!.includes("current-walk") && snapshot.reviewEventIds!.includes("current-other"), "all current episodes retain a representative");
}

async function sparseCalendarAndRepeatedReads(base: string) {
  for (const unit of [1, 10_000]) {
    const ledger = new GrowthLedger(path.join(base, String(unit)));
    await ledger.perceive(choice("first", 10 / unit, "饭后喝茶"));
    await ledger.perceive(choice("second", DAY / unit, "饭后喝茶"));
    for (let i = 0; i < 20; i++) await ledger.perceive(choice(`reread-${i}`, (DAY + i + 1) / unit, "饭后喝茶", "晚饭后", "first"));
    await consume(ledger, (DAY + 30) / unit);
    await ledger.perceive(choice("current", 2 * DAY / unit, "饭后喝茶"));
    const snapshot = (await ledger.snapshotReview({ at: 2 * DAY / unit, minimumEpisodes: 1, secondsPerTU: unit }))!;
    const choices = independentGrowthChoices(snapshot.evidence);
    assert.equal(choices.length, 3, "re-reading a root with another episode label is not an independent practice");
    assert.ok(choices.some(item => item.eventId === "current"));
    assert.ok(choices.some(item => item.eventId === "second"));
    assert.ok(choices.some(item => item.rootEventIds.includes("first")));
    assert.ok((Math.max(...choices.map(item => item.observedAt)) - Math.min(...choices.map(item => item.observedAt))) * unit >= DAY,
      "sparse behavior uses elapsed world seconds, not raw TU or real calendar dates");
  }
}

function scopeAndBehaviorBoundaries() {
  const current = evidence(choice("current", 10 * DAY, "饭后沿河散步"));
  const old = evidence(choice("old", 0, "饭后沿河散步"));
  const unrelated = evidence(choice("unrelated", 5 * DAY, "饭后坐在河边吃饭"));
  unrelated.text = "朋友谈论沿河散步；我只在河边吃饭。";
  const wrongPerson = evidence(choice("other-person", DAY, "饭后沿河散步"));
  wrongPerson.experience!.subjectIds = ["person-other"];
  const unknown = evidence(choice("unknown", DAY, "饭后沿河散步")); unknown.experience!.agency = "unknown";
  const forced = evidence(choice("forced", 2 * DAY, "饭后沿河散步")); forced.experience!.agency = "imposed";
  const failed = evidence(choice("failed", 3 * DAY, "饭后沿河散步")); failed.experience!.outcome = "failed";
  const unclassified = evidence(choice("unclassified", DAY, "饭后沿河散步")); delete unclassified.experience;
  const selected = selectLongitudinalEvidence({ independentChoices: independentGrowthChoices, fresh: [current], historical: [old, unrelated, wrongPerson, unknown, forced, failed, unclassified], budget: 8 });
  assert.deepEqual(selected.map(item => item.eventId), ["old"], "a repeated name/topic or distant timestamp is not evidence of the same voluntary action");
  const otherStep = evidence(choice("same-episode-other-action", 1, "坐在电脑前等待"));
  otherStep.experience!.episodeId = old.experience!.episodeId;
  assert.deepEqual(selectLongitudinalEvidence({ independentChoices: independentGrowthChoices, fresh: [current], historical: [otherStep, old], budget: 8 })
    .map(item => item.eventId), ["old"], "match behavior before selecting an episode representative; an unrelated step in that episode cannot hide the actual practice");
  const chat = (id: string, channelKey: string, at: number) => {
    const item = evidence(choice(id, at, "主动询问今天过得怎样"));
    item.experience!.chat = { kind: "send", channelKey };
    return item;
  };
  const here = chat("here", "fixture:room-a", 10 * DAY);
  assert.deepEqual(selectLongitudinalEvidence({ independentChoices: independentGrowthChoices, fresh: [here], historical: [chat("there", "fixture:room-b", 0)], budget: 8 }), [], "cross-channel similarity cannot manufacture one social pattern");
}

function traitSituationCoverage() {
  const current = evidence(choice("new", 10 * DAY, "先听对方解释", "工作"));
  const historical = [evidence(choice("oldest", 0, "先听对方解释", "工作")),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(day => evidence(choice(`work-${day}`, day * DAY, "先听对方解释", "工作"))),
    evidence(choice("home", 9 * DAY, "先听对方解释", "家庭")), evidence(choice("trip", 9 * DAY + 1, "先听对方解释", "旅行"))];
  const selected = selectLongitudinalEvidence({ independentChoices: independentGrowthChoices, fresh: [current], historical, secondsPerTU: 1, budget: 5 });
  assert.equal(selected.length, 5);
  assert.ok(selected.some(item => item.eventId === "oldest"));
  assert.equal(new Set([current, ...selected].map(item => item.experience!.situation)).size, 3,
    "after preserving the seven-day span, available distinct contexts survive a same-context streak");
}

function sceneryIsNotAnActionAnchor() {
  const current = evidence(choice("new", 10 * DAY, "动作「双手虚搭在键盘上，目光直直地盯着屏幕发呆。屋里安静，只有机箱风扇的低鸣，屏幕的光映在脸上，窗外偶尔传来远处马路上车辆驶过的声音。」"));
  const unrelated = [
    evidence(choice("old-quiet", DAY, "动作「胳膊肘搭桌沿靠着，什么都不干，让屋里安静一会儿」")),
    evidence(choice("old-fan", 2 * DAY, "翻开书读了一页，只有机箱风扇的低鸣")),
    evidence(choice("old-light", 3 * DAY, "和家人通话，屏幕的光映在脸上")),
    evidence(choice("old-traffic", 4 * DAY, "把外套挂起来，窗外偶尔传来远处马路上车辆驶过的声音")),
  ];
  const matching = evidence(choice("actual-same-action", 8 * DAY, "目光直直地盯着屏幕发呆"));
  const select = (fresh: PerceivedEvidence[], historical: PerceivedEvidence[]) => selectLongitudinalEvidence({
    fresh, historical, behaviors: ["屋里安静"], independentChoices: independentGrowthChoices, budget: 8,
  });
  assert.deepEqual(select([current], [...unrelated, matching]).map(item => item.eventId), [matching.eventId],
    "quiet rooms, fan sounds, screen light and traffic cannot connect unrelated choices; the actual action in a mixed description survives");
  assert.deepEqual(select([evidence(choice("scenery-only", 10 * DAY, "屋里安静。只有机箱风扇的低鸣。"))], unrelated), [],
    "the full action string cannot reintroduce an all-scenery fragment as a behavior");
}

async function longTermClaimsRemainEditable(base: string) {
  await fs.mkdir(base, { recursive: true });
  const rows: unknown[] = [];
  const record = (id: string, kind: GrowthRecord["kind"], subject: string, at: number): GrowthRecord => ({
    id, claimId: id, actorId: "bot", kind, subject, statement: "天气适合时喜欢晚饭后去河边散步。", relation: "support",
    evidenceIds: [], rootEventIds: [], recordedAt: at, origin: "automatic", situation: "晚饭后河边", cues: ["沿河散步"],
    scope: { domain: "physical" }, groundingVersion: 1, ...(kind === "state" ? { expiresAt: 100_000 } : {}),
  });
  rows.push({ type: "reflection", record: record("older-preference", "preference", "散步偏好", 1) });
  rows.push({ type: "reflection", record: record("older-commitment", "commitment", "与朋友散步约定", 2) });
  for (let i = 0; i < 20; i++) rows.push({ type: "reflection", record: record(`recent-state-${i}`, "state", `沿河散步当前状态${i}`, 100 + i) });
  await fs.writeFile(path.join(base, "growth.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const ledger = new GrowthLedger(base);
  await ledger.perceive(choice("new-walk", 1000));
  const snapshot = (await ledger.snapshotReview({ at: 1000, minimumEpisodes: 1 }))!;
  assert.ok(snapshot.claims.length <= 8);
  assert.deepEqual(snapshot.claims.slice(0, 2).map(item => item.kind).sort(), ["commitment", "preference"]);
  assert.ok(snapshot.claims.some(item => item.claimId === "older-preference"));
  assert.ok(snapshot.claims.some(item => item.claimId === "older-commitment"));
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-growth-longitudinal-"));
  try {
    await denseHistory(path.join(dir, "dense"));
    await sparseCalendarAndRepeatedReads(path.join(dir, "sparse"));
    scopeAndBehaviorBoundaries(); traitSituationCoverage(); sceneryIsNotAnActionAnchor();
    await longTermClaimsRemainEditable(path.join(dir, "claims"));
    console.log("PASS longitudinal growth: dense recent streaks preserve cross-day/week related autonomous evidence, root deduplication, calendar scaling, current representatives, scope/action boundaries and older editable lasting claims");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
