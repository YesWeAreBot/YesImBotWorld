import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldKernel } from "../src/world/kernel.js";
import { KernelError, type EntityInput, type WorldAttribute, type WorldExperience, type WorldOperation } from "../src/world/state.js";

const attr = (value: WorldAttribute["value"], visibility: WorldAttribute["visibility"] = "public"): WorldAttribute => ({ value, visibility });
const seed: EntityInput[] = [
  { id: "room", kind: "place", name: "起居室", location: null },
  { id: "hall", kind: "place", name: "走廊", location: null },
  { id: "far", kind: "place", name: "远处密室", location: null },
  { id: "bot", kind: "actor", name: "小澈", controller: "bot", location: "room", attributes: { 疲劳: attr(1, "owner"), 秘密: attr("SELF_HIDDEN", "hidden") } },
  { id: "npc", kind: "actor", name: "阿青", controller: "world", location: "room", attributes: { 心事: attr("NPC_PRIVATE", "owner") } },
  { id: "outsider", kind: "actor", name: "远方的人", controller: "world", location: "far" },
  { id: "cup", kind: "object", name: "杯子", location: "room", attributes: { 颜色: attr("红色"), 序列号: attr("CUP_HIDDEN", "hidden") } },
  { id: "box", kind: "object", name: "盒子", location: "room", attributes: { open: attr(false) } },
  { id: "letter", kind: "object", name: "盒中的信", location: "box", attributes: { 内容: attr("VISIBLE_AFTER_OPEN") } },
  { id: "remote", kind: "object", name: "REMOTE_OBJECT", location: "far", attributes: { 说明: attr("REMOTE_ATTRIBUTE") } },
];

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-world-experiences-"));
  let now = 10, serial = 0;
  const kernel = await WorldKernel.open(dir, { now: () => now });
  const commit = (operations: WorldOperation[], idempotencyKey = `fixture:${++serial}`) => kernel.commit({ idempotencyKey, operations, correlationId: "bot:tc_fixture" });
  const ids = (items: WorldExperience[]) => items.map(item => item.eventId);
  try {
    await kernel.initialize(seed);
    const baseline = await kernel.observe("bot");
    assert.deepEqual(baseline.experiences, [], "seed/reset does not manufacture past experiences");
    const operations: WorldOperation[] = [
      { op: "update", id: "cup", changes: { attributes: { 颜色: attr("蓝色") } } },
      { op: "update", id: "cup", changes: { attributes: { 颜色: attr("红色") } } },
      { op: "move", id: "npc", location: "hall" },
      { op: "move", id: "npc", location: "room" },
      { op: "update", id: "npc", changes: { attributes: { 心事: attr("NEW_NPC_PRIVATE", "owner") } } },
      { op: "update", id: "cup", changes: { attributes: { 序列号: attr("NEW_HIDDEN", "hidden") } } },
      { op: "update", id: "remote", changes: { attributes: { 说明: attr("NEW_REMOTE") } } },
    ];
    const changed = await commit(operations, "round-trip");
    const peek = await kernel.peek("bot"), peekAgain = await kernel.peek("bot");
    const experiences = peek.experiences!;
    assert.equal(experiences.filter(item => item.details?.attribute === "颜色").length, 2, "reverted attribute values keep both perceptible steps");
    assert.deepEqual(experiences.filter(item => item.kind === "movement").map(item => item.details?.presence), ["absent", "visible"]);
    assert.ok(!JSON.stringify(peek).match(/NPC_PRIVATE|NEW_NPC_PRIVATE|NEW_HIDDEN|NEW_REMOTE|走廊|远处密室|SELF_HIDDEN|CUP_HIDDEN|VISIBLE_AFTER_OPEN/));
    assert.deepEqual(ids(peekAgain.experiences!), ids(experiences), "peek never consumes or invents event identity");
    assert.ok(experiences.every(item => item.worldSequence === changed.sequence && item.worldTime === now && item.correlationId === "bot:tc_fixture"));
    assert.deepEqual(experiences.map(item => item.order), experiences.map((_, index) => index), "order is the stable per-actor position in the committed transaction");
    assert.deepEqual(peekAgain.experiences!.map(item => item.order), experiences.map(item => item.order));
    assert.equal(new Set(ids(experiences)).size, experiences.length);
    const committedRoot = changed.events.find(item => item.topic === "world.committed")!.id;
    assert.ok(experiences.every(item => item.sourceEventIds.length === 1 && item.sourceEventIds[0] === committedRoot));
    const duplicate = await commit(operations, "round-trip");
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(ids((await kernel.peek("bot")).experiences!), ids(experiences));
    const inspection = await kernel.observe("bot", { consume: false });
    assert.deepEqual(ids(inspection.experiences!), ids(experiences));
    const observed = await kernel.observe("bot");
    assert.deepEqual(ids(observed.experiences!), ids(experiences));
    const repeated = await kernel.observe("bot");
    assert.deepEqual(repeated.experiences, []);
    assert.deepEqual(repeated.sourceEventIds, observed.sourceEventIds, "reobserving facts must keep evidence roots stable");
    assert.deepEqual(ids((await kernel.peek("bot", { sinceSequence: baseline.worldSequence })).experiences!), ids(experiences));

    // Sensory scopes filter private facts without confusing ephemeral entity handles with IDs.
    await commit([{ op: "update", id: "bot", changes: { attributes: { 疲劳: attr(2, "owner") } } },
      { op: "update", id: "cup", changes: { attributes: { 颜色: attr("绿色") } } }]);
    assert.ok((await kernel.peek("bot")).experiences!.some(item => item.details?.attribute === "疲劳"));
    assert.ok(!(await kernel.peek("bot", { publicOnly: true })).experiences!.some(item => item.details?.attribute === "疲劳"));
    const fullScope = (await kernel.peek("bot")).experiences!, publicScope = (await kernel.peek("bot", { publicOnly: true })).experiences!;
    assert.equal(publicScope[0]!.order, fullScope.find(item => item.eventId === publicScope[0]!.eventId)!.order, "filtered observations retain committed indexes, never renumber the remaining experiences");
    assert.ok(publicScope[0]!.order! > 0, "a filtered-out private step leaves its original place in the ordering");
    assert.ok((await kernel.peek("bot", { selfOnly: true })).experiences!.every(item => item.details?.subjectName === "小澈"));
    const cup = repeated.entities.find(entity => entity.name === "杯子")!.observedId;
    assert.ok((await kernel.peek("bot", { target: cup })).experiences!.every(item => ["小澈", "杯子"].includes(String(item.details?.subjectName))));
    await kernel.observe("bot");

    // Opening and closing in one transaction reveals the intervening view, never closed contents.
    await commit([{ op: "update", id: "box", changes: { attributes: { open: attr(true) } } },
      { op: "update", id: "box", changes: { attributes: { open: attr(false) } } }]);
    const box = await kernel.observe("bot");
    assert.ok(box.experiences!.some(item => item.kind === "appearance" && item.details?.subjectName === "盒中的信" && item.details.presence === "visible"));
    assert.ok(box.experiences!.some(item => item.text.includes("VISIBLE_AFTER_OPEN")));
    assert.ok(!box.entities.some(entity => entity.name === "盒中的信"));
    await commit([{ op: "move", id: "bot", location: "hall" }, { op: "move", id: "bot", location: "room" }]);
    const journey = await kernel.observe("bot");
    assert.deepEqual(journey.experiences!.filter(item => item.kind === "movement" && item.details?.subjectName === "小澈").map(item => item.details?.to), ["走廊", "起居室"]);
    assert.ok(!JSON.stringify(journey).includes("远处密室"));

    // Speech is delivered where the speaker was at that step, preserving exact original words.
    const phrase = '别着急。\n我说的是“红色的那只”。';
    const spoke = await commit([{ op: "say", actorId: "npc", text: phrase },
      { op: "move", id: "npc", location: "far" }, { op: "say", actorId: "npc", text: "REMOTE_WORDS" }]);
    const speechObservation = await kernel.peek("bot");
    const spoken = speechObservation.experiences!.filter(item => item.kind === "speech");
    assert.equal(spoken.length, 1); assert.equal(spoken[0]!.details?.text, phrase);
    assert.equal(spoken[0]!.eventId, speechObservation.utterances[0]!.eventId);
    assert.deepEqual(spoken[0]!.sourceEventIds, [spoke.events.find(item => item.topic === "world.speech")!.id]);
    assert.ok(!JSON.stringify(speechObservation).includes("REMOTE_WORDS"));
    assert.ok(!(await kernel.peek("bot", { includeSpeech: false })).experiences!.some(item => item.kind === "speech"));
    const remoteSpeech = await kernel.peek("outsider");
    assert.ok(remoteSpeech.experiences!.some(item => item.kind === "speech" && item.details?.text === "REMOTE_WORDS"));
    assert.ok(!remoteSpeech.experiences!.some(item => item.kind === "speech" && item.details?.text === phrase));
    await kernel.observe("bot");

    // An intention is only known to its actor. End status does not invent success or expose reason.
    await commit([{ op: "action.start", action: { id: "walk", actorId: "bot", intent: "走遍世界并找到答案", expectedEnd: 11 } }]);
    const start = await kernel.observe("bot");
    assert.ok(start.experiences!.some(item => item.kind === "action" && item.details?.phase === "start" && item.text.includes("开始尝试")));
    assert.ok(!(await kernel.peek("npc", { sinceSequence: start.worldSequence - 1 })).experiences!.some(item => item.kind === "action"));
    await assert.rejects(commit([{ op: "action.finish", id: "walk", status: "needs_input" }]), (error: unknown) => error instanceof KernelError && error.code === "ACTION_NOT_DUE");
    now = 11;
    await commit([{ op: "move", id: "bot", location: "hall" }, { op: "action.finish", id: "walk", status: "needs_input", reason: "SECRET_DIAGNOSTIC_NOT_FOR_ACTOR" }]);
    const decision = await kernel.observe("bot");
    assert.equal(kernel.snapshot().actions.walk!.status, "needs_input");
    const finish = decision.experiences!.find(item => item.kind === "action")!;
    assert.equal(finish.details?.phase, "finish"); assert.equal(finish.details?.status, "needs_input");
    assert.match(finish.text, /行动推进到需要你决定的地方/); assert.ok(!JSON.stringify(decision).includes("SECRET_DIAGNOSTIC"));
    assert.ok(decision.experiences!.some(item => item.kind === "movement" && item.details?.to === "走廊"));
    await commit([{ op: "action.start", action: { id: "next", actorId: "bot", intent: "继续下一步" } }]);
    await commit([{ op: "action.finish", id: "next", status: "failed", reason: "OTHER_PRIVATE_REASON" }]);
    assert.ok(!JSON.stringify(await kernel.peek("bot")).includes("OTHER_PRIVATE_REASON"));

    // Another observer can consume the ordinary cursor before an HTTP action receipt is read.
    const receiptId = "bot:tc_receipt";
    await kernel.commit({ idempotencyKey: "receipt:start", correlationId: receiptId,
      operations: [{ op: "action.start", action: { id: receiptId, actorId: "bot", intent: "在走廊来回走一步" } }] });
    const receiptCommit = await kernel.commit({ idempotencyKey: "receipt:finish", correlationId: receiptId, operations: [
      { op: "move", id: "bot", location: "room" }, { op: "move", id: "bot", location: "hall" },
      { op: "action.finish", id: receiptId, status: "completed" },
    ] });
    const consumedEarly = await kernel.observe("bot");
    const actionReceipt = kernel.actionExperiences("bot", receiptId);
    assert.ok(actionReceipt.some(item => item.kind === "action" && item.details?.phase === "start"));
    assert.equal(actionReceipt.filter(item => item.kind === "movement" && item.details?.subjectName === "小澈").length, 2);
    assert.ok(actionReceipt.some(item => item.kind === "action" && item.details?.phase === "finish"));
    assert.ok(actionReceipt.every(item => item.correlationId === receiptId));
    assert.ok(actionReceipt.every(item => consumedEarly.experiences!.some(consumed => consumed.eventId === item.eventId)));
    assert.ok(actionReceipt.every(item => item.sourceEventIds.every(source => consumedEarly.sourceEventIds.includes(source))), "intermediate movement roots remain evidence even when the final location is unchanged");
    assert.ok(actionReceipt.some(item => item.sourceEventIds.includes(receiptCommit.events.find(event => event.topic === "world.committed")!.id)));
    assert.deepEqual((await kernel.observe("bot")).experiences, []);
    assert.deepEqual(kernel.actionExperiences("bot", receiptId), actionReceipt, "receipt retrieval ignores consumed observation cursors and keeps stable IDs");
    assert.deepEqual(kernel.actionExperiences("npc", receiptId), [], "an action's private intent and own-body experiences stay actor scoped");
    assert.deepEqual(kernel.actionExperiences("bot", "unknown-action"), []);
    const detached = kernel.actionExperiences("bot", receiptId); detached[0]!.text = "caller mutation";
    assert.notEqual(kernel.actionExperiences("bot", receiptId)[0]!.text, "caller mutation");

    const history = await kernel.peek("bot", { sinceSequence: baseline.worldSequence });
    const reopened = await WorldKernel.open(dir, { now: () => now });
    assert.deepEqual((await reopened.peek("bot", { sinceSequence: baseline.worldSequence })).experiences, history.experiences, "restart reads the stored projection without regenerating its identity or prose");
    assert.deepEqual(reopened.actionExperiences("bot", receiptId), actionReceipt, "exact action receipts survive process restart");
    const current = await reopened.observe("bot");
    assert.deepEqual(current.experiences, []);
    const reopenedAgain = await WorldKernel.open(dir, { now: () => now });
    assert.deepEqual((await reopenedAgain.observe("bot")).experiences, [], "consumed cursor persists through restart");

    // An older journal lacking experiences remains readable; replay cannot invent what was felt.
    const oldDir = path.join(dir, "legacy"); await fs.mkdir(oldDir);
    const orderlessDir = path.join(dir, "orderless"); await fs.mkdir(orderlessDir);
    const orderlessJournal = (await fs.readFile(kernel.journalPath, "utf8")).trim().split("\n").map(line => {
      const record = JSON.parse(line);
      for (const event of record.envelopes) {
        if (event.topic !== "world.committed") continue;
        for (const items of Object.values(event.payload.experiences ?? {}) as any[][]) for (const item of items) delete item.experience.order;
      }
      return JSON.stringify(record);
    }).join("\n") + "\n";
    await fs.writeFile(path.join(orderlessDir, "world-transactions.jsonl"), orderlessJournal);
    const orderless = await WorldKernel.open(orderlessDir, { now: () => now });
    const legacyExperiences = (await orderless.peek("bot", { sinceSequence: baseline.worldSequence })).experiences!;
    assert.deepEqual(ids(legacyExperiences), ids(history.experiences!), "older ordered-by-journal experiences retain their original identities");
    assert.ok(legacyExperiences.every(item => item.order === undefined), "replay does not rewrite order onto historical records");
    const journal = (await fs.readFile(kernel.journalPath, "utf8")).trim().split("\n").map(line => {
      const record = JSON.parse(line); for (const event of record.envelopes) if (event.payload) delete event.payload.experiences; return JSON.stringify(record);
    }).join("\n") + "\n";
    await fs.writeFile(path.join(oldDir, "world-transactions.jsonl"), journal);
    const legacy = await WorldKernel.open(oldDir, { now: () => now });
    assert.deepEqual((await legacy.peek("bot", { sinceSequence: 0 })).experiences, []);
    assert.ok((await legacy.peek("bot", { sinceSequence: 0 })).utterances.length > 0, "old speech is still its original committed record");
    await reopenedAgain.reset(seed);
    assert.deepEqual(reopenedAgain.actionExperiences("bot", receiptId), [], "reset separates action receipts even for reused actor IDs");
    assert.deepEqual((await reopenedAgain.peek("bot", { sinceSequence: 0 })).experiences, [], "reset isolates earlier experiences even when actors reuse IDs");
    assert.deepEqual((await reopenedAgain.peek("bot", { sinceSequence: 0 })).utterances, []);

    // Progress means an actual perceived change, not a nonempty proposal or lifecycle marker.
    await reopenedAgain.commit({ idempotencyKey: "preview:start", correlationId: "preview:action", operations: [
      { op: "action.start", action: { id: "preview:action", actorId: "bot", intent: "等一个新的决定点" } },
    ] });
    const terminal: WorldOperation = { op: "action.finish", id: "preview:action", status: "needs_input" };
    const progress = (operations: WorldOperation[]) => reopenedAgain.hasPerceptibleProgress(reopenedAgain.propose({ idempotencyKey: "preview:only", operations: [...operations, terminal] }), "bot");
    const previewState = reopenedAgain.snapshot(), previewJournal = await fs.readFile(reopenedAgain.journalPath, "utf8"), previewObservation = await reopenedAgain.peek("bot");
    assert.equal(progress([]), false);
    assert.equal(progress([{ op: "move", id: "bot", location: "room" }]), false);
    assert.equal(progress([{ op: "update", id: "cup", changes: { attributes: { 颜色: attr("红色") } } }]), false);
    assert.equal(progress([{ op: "update", id: "bot", changes: { attributes: { hidden: attr("UNSEEN_PREVIEW", "hidden") } } }]), false);
    assert.equal(progress([{ op: "say", actorId: "outsider", text: "远处发生的对话" }]), false);
    assert.equal(progress([{ op: "say", actorId: "npc", text: "你想往哪边走？" }]), true);
    assert.equal(progress([{ op: "say", actorId: "bot", text: "原话仅供预演，实际提交仍需授权。" }]), true);
    assert.equal(progress([{ op: "move", id: "bot", location: "hall" }, { op: "move", id: "bot", location: "room" }]), true);
    assert.equal(progress([{ op: "update", id: "bot", changes: { attributes: { energy: attr(3, "owner") } } }]), true);
    assert.deepEqual(reopenedAgain.snapshot(), previewState);
    assert.equal(await fs.readFile(reopenedAgain.journalPath, "utf8"), previewJournal);
    assert.deepEqual((await reopenedAgain.peek("bot")).experiences, previewObservation.experiences, "previews cannot publish experiences or advance the observation cursor");

    const long = "👩🏽‍🚀".repeat(180) + "末尾仍保留在完整数据中";
    const structured = { 一: long, 二: [1, 2, 3, 4, 5], 三: { nested: { deeper: { value: long } } }, 四: false, 五: "原始第五项" };
    await reopenedAgain.commit({ idempotencyKey: "readable-values", operations: [
      { op: "update", id: "bot", changes: { attributes: { hunger: attr(2, "owner"), health: attr(90, "owner"), energy: attr(3, "owner"), thirst: attr(4, "owner"), temperature: attr(36.5, "owner"), posture: attr("standing"), wetness: attr(0), 摘录: attr(structured), toString: attr("constructor") } } },
      { op: "update", id: "box", changes: { attributes: { open: attr(true) } } },
    ] });
    const readable = (await reopenedAgain.peek("bot")).experiences!;
    assert.ok(readable.some(item => item.text === "你的饥饿程度为2。"));
    assert.ok(readable.some(item => item.text === "你的温度为36.5。"), "numeric values acquire no invented unit or interpretation");
    assert.ok(readable.some(item => item.text === "你的姿势为站立。"));
    assert.ok(readable.some(item => item.text === "盒子的开合状态从关闭变为打开。"));
    assert.ok(readable.some(item => item.text === "你的toString为constructor。"), "prototype properties are never read as translation entries");
    const excerpt = readable.find(item => item.details?.attribute === "摘录")!;
    assert.ok([...excerpt.text].length < 180);
    assert.ok(excerpt.text.includes("…"));
    assert.ok(!excerpt.text.includes("[object Object]"));
    assert.deepEqual(excerpt.details?.after, structured);
    assert.ok(!excerpt.text.replaceAll("👩🏽‍🚀", "").match(/[\u{1F469}\u{1F3FD}\u{1F680}\u200D]/u), "an excerpt never cuts apart an emoji grapheme");

    // A legal actor ID can also name an Object.prototype member. Missing actor rows stay empty.
    const prototypeDir = path.join(dir, "prototype-actor");
    const prototypeWorld = await WorldKernel.open(prototypeDir, { now: () => now });
    await prototypeWorld.initialize([...seed, { id: "toString", kind: "actor", name: "词名角色", controller: "world", location: "far" }]);
    await prototypeWorld.commit({ idempotencyKey: "unseen-by-prototype", operations: [{ op: "update", id: "cup", changes: { attributes: { 颜色: attr("橙色") } } }] });
    assert.deepEqual((await prototypeWorld.observe("toString")).experiences, [], "another room's transaction has no inherited experiences for this actor");
    const noProgress = prototypeWorld.propose({ idempotencyKey: "prototype-noop", operations: [{ op: "move", id: "toString", location: "far" }] });
    assert.equal(prototypeWorld.hasPerceptibleProgress(noProgress, "toString"), false);
    const trip = prototypeWorld.propose({ idempotencyKey: "prototype-trip", operations: [{ op: "move", id: "toString", location: "room" }, { op: "move", id: "toString", location: "far" }] });
    assert.equal(prototypeWorld.hasPerceptibleProgress(trip, "toString"), true);
    await prototypeWorld.commit(trip);
    assert.equal((await prototypeWorld.observe("toString")).experiences!.filter(item => item.kind === "movement" && item.details?.subjectName === "词名角色").length, 2);
    await prototypeWorld.commit({ idempotencyKey: "prototype-speech", operations: [{ op: "say", actorId: "toString", text: "这个名字也是普通角色 ID。" }] });
    assert.ok((await prototypeWorld.observe("toString")).experiences!.some(item => item.kind === "speech"));
    await prototypeWorld.commit({ idempotencyKey: "prototype-action", correlationId: "prototype:action", operations: [{ op: "action.start", action: { id: "prototype:action", actorId: "toString", intent: "静待" } }] });
    assert.ok(prototypeWorld.actionExperiences("toString", "prototype:action").some(item => item.kind === "action"));
    const prototypeReloaded = await WorldKernel.open(prototypeDir, { now: () => now });
    assert.deepEqual(prototypeReloaded.actionExperiences("toString", "prototype:action"), prototypeWorld.actionExperiences("toString", "prototype:action"));
    assert.ok((await prototypeReloaded.peek("toString", { sinceSequence: 0 })).experiences!.length > 0);
    console.log("PASS world experiences: atomic per-step projections, scoped visibility, speech audiences, stable roots/IDs, observe/peek cursors, needs_input, restart, legacy journals and reset isolation");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
