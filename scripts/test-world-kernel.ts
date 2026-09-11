/** Run: esbuild scripts/test-world-kernel.ts --bundle --platform=node --format=cjs --outfile=/tmp/world-kernel-test.cjs && node /tmp/world-kernel-test.cjs */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldKernel } from "../src/world/kernel.js";
import { KernelError, type EntityInput, type WorldAttribute } from "../src/world/state.js";

const attr = (value: WorldAttribute["value"], visibility: WorldAttribute["visibility"] = "public"): WorldAttribute => ({ value, visibility });
const seed: EntityInput[] = [
  { id: "room", kind: "place", name: "Room", location: null },
  { id: "far", kind: "place", name: "Other room", location: null },
  { id: "bot", kind: "actor", name: "Bot", controller: "bot", location: "room", attributes: { health: attr(100, "owner"), secret: attr("unconscious-secret", "hidden") } },
  { id: "bob", kind: "actor", name: "Bob", controller: "world", location: "room", attributes: { worry: attr("private", "owner") } },
  { id: "outsider", kind: "actor", name: "Outsider", location: "far" },
  { id: "cup", kind: "object", name: "Cup", location: "room", attributes: { color: attr("red"), secret: attr("hidden-serial", "hidden") } },
  { id: "box", kind: "object", name: "Box", location: "room", attributes: { open: attr(false) } },
  { id: "key", kind: "object", name: "Key", location: "box" },
  { id: "pocket", kind: "object", name: "Bob's pocket contents", location: "bob", owner: "bob" },
];
let checks = 0;
function pass(label: string): void { checks++; console.log(`PASS ${label}`); }
async function rejectsCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, e => e instanceof KernelError && e.code === code);
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-kernel-"));
  let now = 100;
  try {
    const kernel = await WorldKernel.open(dir, { now: () => now });
    await kernel.initialize(seed);
    assert.equal(await kernel.initialize(seed), null);
    pass("initialization is atomic and does not replace an initialized world");

    const before = kernel.snapshot();
    await rejectsCode(() => kernel.commit({ idempotencyKey: "invalid-batch", operations: [
      { op: "move", id: "cup", location: "bot", owner: "bot" }, { op: "move", id: "box", location: "missing" },
    ] }), "MISSING_ENTITY");
    assert.deepEqual(kernel.snapshot(), before);
    await rejectsCode(() => kernel.commit({ idempotencyKey: "cycle", operations: [{ op: "move", id: "box", location: "key" }] }), "CONTAINMENT_CYCLE");
    await rejectsCode(() => kernel.commit({ idempotencyKey: "invalid-owner", operations: [{ op: "move", id: "cup", location: "room", owner: "box" }] }), "MISSING_ENTITY");
    await rejectsCode(() => kernel.commit({ idempotencyKey: "prototype-ref", operations: [{ op: "move", id: "cup", location: "toString" }] }), "MISSING_ENTITY");
    assert.deepEqual(kernel.snapshot(), before);
    pass("batch rollback, valid references, actor ownership, and containment cycles");

    const migration = await WorldKernel.open(path.join(dir, "migration"), { now: () => now });
    const forwardEntities: EntityInput[] = [
      { id: "phone", kind: "object", name: "Phone", location: "bot", owner: "bot" },
      { id: "bot", kind: "actor", name: "Bot", controller: "bot", location: "room" },
      { id: "room", kind: "place", name: "Dormitory", location: null },
    ];
    assert.equal(migration.propose({ idempotencyKey: "forward-references", operations: forwardEntities.map(entity => ({ op: "create", entity })) }).changedEntityIds.length, 3);
    const badEntities: EntityInput[] = [
      { id: "room", kind: "place", name: "Dormitory", location: "中国沈阳" },
      { id: "bot", kind: "actor", name: "Bot", controller: "bot", location: "room", owner: "bot" },
      { id: "phone", kind: "object", name: "Phone", location: "互联网", owner: "room" },
      { id: "shelf", kind: "object", name: "Shelf", location: "校园内", owner: "unknown" },
      { id: "elsewhere", kind: "place", name: "Other place", location: "phone" },
      { id: "student", kind: "actor", name: "Student", controller: "world", location: "bot" },
    ];
    const badProposal = { idempotencyKey: "all-reference-errors", operations: badEntities.map(entity => ({ op: "create" as const, entity })) };
    let referenceError: KernelError | undefined;
    try { migration.propose(badProposal); } catch (error) { assert(error instanceof KernelError); referenceError = error; }
    assert(referenceError);
    assert.equal(referenceError.code, "MISSING_ENTITY", "the first diagnostic keeps the existing error code");
    assert.equal(referenceError.details?.length, 8);
    assert.deepEqual(referenceError.details?.map(issue => [issue.entityId, issue.field, issue.targetId, issue.reason]), [
      ["room", "location", "中国沈阳", "missing"],
      ["bot", "owner", "bot", "owner_not_allowed"],
      ["phone", "location", "互联网", "missing"],
      ["phone", "owner", "room", "wrong_kind"],
      ["shelf", "location", "校园内", "missing"],
      ["shelf", "owner", "unknown", "missing"],
      ["elsewhere", "location", "phone", "wrong_kind"],
      ["student", "location", "bot", "wrong_kind"],
    ]);
    const wrongOwner = referenceError.details!.find(issue => issue.entityId === "phone" && issue.field === "owner")!;
    assert.deepEqual(wrongOwner.expectedKinds, ["actor"]); assert.equal(wrongOwner.actualKind, "place");
    for (const issue of referenceError.details!) assert(referenceError.message.includes(`${issue.entityId}.${issue.field} -> ${issue.targetId}`));
    await rejectsCode(() => migration.commit(badProposal), "MISSING_ENTITY");
    assert.equal(Object.keys(migration.snapshot().entities).length, 0);
    assert.deepEqual(migration.readEvents(), []);
    pass("migration reports every missing and wrong-kind location/owner with source paths; forward creates remain valid");

    const cyclicEntities: EntityInput[] = [
      { id: "a", kind: "place", name: "A", location: "b" },
      { id: "b", kind: "place", name: "B", location: "a" },
      { id: "orphan", kind: "object", name: "Orphan", location: "missing-parent" },
    ];
    assert.throws(() => migration.propose({ idempotencyKey: "mixed-graph-errors", operations: cyclicEntities.map(entity => ({ op: "create", entity })) }), error => {
      assert(error instanceof KernelError);
      const cycles = error.details!.filter(issue => issue.reason === "cycle");
      assert.equal(cycles.length, 1, "one diagnostic per cycle rather than one per traversal");
      assert.deepEqual(cycles[0]!.path, ["a", "b", "a"]);
      assert(error.details!.some(issue => issue.entityId === "orphan" && issue.reason === "missing"));
      return true;
    });
    assert.equal(Object.keys(migration.snapshot().entities).length, 0);
    pass("cycles remain forbidden alongside dangling references without undefined traversal failures");

    const observed = await kernel.observe("bot");
    assert(!JSON.stringify(observed).includes("hidden-serial"));
    assert(!JSON.stringify(observed).includes("unconscious-secret"));
    assert(!observed.entities.some(e => ["Key", "Outsider", "Bob's pocket contents"].includes(e.name)));
    assert.equal(observed.entities.find(e => e.self)!.attributes.health, 100);
    assert.equal(observed.entities.find(e => e.name === "Bob")!.attributes.worry, undefined);
    const cupHandle = observed.entities.find(e => e.name === "Cup")!.observedId;
    assert.equal(kernel.resolveObserved("bot", cupHandle), "cup");
    assert.throws(() => kernel.resolveObserved("bob", cupHandle), (e: unknown) => e instanceof KernelError && e.code === "NOT_OBSERVED");
    await rejectsCode(() => kernel.observe("bot", { target: "key" }), "NOT_OBSERVED");
    pass("observation filters remote actors, inventory, closed containers, and private attributes");

    await kernel.commit({ idempotencyKey: "hidden-change", operations: [{ op: "update", id: "cup", changes: { attributes: { secret: attr("new-hidden", "hidden") } } }] });
    const afterHidden = await kernel.observe("bot");
    assert.deepEqual(afterHidden.sourceEventIds.sort(), observed.sourceEventIds.sort());
    await kernel.commit({ idempotencyKey: "open-box", operations: [{ op: "update", id: "box", changes: { attributes: { open: attr(true) } } }] });
    const opened = await kernel.observe("bot");
    assert(opened.entities.some(e => e.name === "Key"));
    const repeated = await kernel.observe("bot");
    assert.deepEqual(repeated.sourceEventIds.sort(), opened.sourceEventIds.sort());
    pass("unknown details stay absent, opening reveals committed contents, evidence IDs stay stable");

    const cupVersion = kernel.snapshot().entities.cup!.revision;
    const concurrent = await Promise.allSettled(["bot", "bob"].map(owner => kernel.commit({ idempotencyKey: `take:${owner}`,
      expectedVersions: { cup: cupVersion }, operations: [{ op: "move", id: "cup", location: owner, owner }] })));
    assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(r => r.status === "rejected").length, 1);
    assert.equal(kernel.snapshot().entities.cup!.owner, "bot");
    pass("single writer and expected revisions prevent two owners acquiring the same object");

    const observeForAction = await kernel.observe("bot");
    const actionVersion = kernel.snapshot().entities.bot!.revision;
    await kernel.commit({ idempotencyKey: "action:start", actorId: "bot", expectedVersions: { bot: actionVersion }, operations: [{ op: "action.start", action: {
      id: "walk", actorId: "bot", intent: "Walk to the other room", expectedEnd: 110, basedOnObservationId: observeForAction.observationId,
    } }] });
    await rejectsCode(() => kernel.commit({ idempotencyKey: "too-early", operations: [{ op: "move", id: "bot", location: "far" }, { op: "action.finish", id: "walk", status: "completed" }] }), "ACTION_NOT_DUE");
    await rejectsCode(() => kernel.commit({ idempotencyKey: "future", effectiveAt: 110, operations: [{ op: "move", id: "bot", location: "far" }] }), "FUTURE_COMMIT");
    assert.equal(kernel.snapshot().entities.bot!.location, "room");
    now = 110;
    const finished = await kernel.commit({ idempotencyKey: "walk:finish", operations: [{ op: "move", id: "bot", location: "far" }, { op: "action.finish", id: "walk", status: "completed" }] });
    assert.equal(kernel.snapshot().entities.bot!.location, "far");
    assert.equal(kernel.snapshot().actions.walk!.status, "completed");
    const duplicate = await kernel.commit({ idempotencyKey: "walk:finish", operations: [{ op: "move", id: "bot", location: "far" }, { op: "action.finish", id: "walk", status: "completed" }] });
    assert.equal(duplicate.sequence, finished.sequence); assert(duplicate.duplicate);
    await rejectsCode(() => kernel.commit({ idempotencyKey: "walk:finish", operations: [{ op: "move", id: "bot", location: "room" }] }), "IDEMPOTENCY_CONFLICT");
    assert.throws(() => kernel.resolveObserved("bot", opened.entities.find(e => e.name === "Key")!.observedId));
    pass("actions commit at due time, complete atomically, deduplicate retries, and invalidate invisible targets");

    const beforeCancel = kernel.snapshot();
    const controller = new AbortController(); controller.abort();
    await rejectsCode(() => kernel.commit({ idempotencyKey: "cancelled", operations: [{ op: "move", id: "bot", location: "room" }] }, { signal: controller.signal }), "CANCELLED");
    await rejectsCode(() => kernel.commit({ idempotencyKey: "guard", operations: [{ op: "move", id: "bot", location: "room" }] }, { beforeCommit: () => false }), "CANCELLED");
    assert.deepEqual(kernel.snapshot(), beforeCancel);
    let commitBoundaryCalls = 0;
    await rejectsCode(() => kernel.commit({ idempotencyKey: "invalid-before-boundary", operations: [{ op: "move", id: "bot", location: "missing" }] },
      { beforeCommit: () => { commitBoundaryCalls++; return true; } }), "MISSING_ENTITY");
    assert.equal(commitBoundaryCalls, 0);
    await kernel.commit({ idempotencyKey: "valid-boundary", operations: [{ op: "update", id: "cup", changes: { attributes: { color: attr("blue") } } }] },
      { beforeCommit: () => { commitBoundaryCalls++; return true; } });
    assert.equal(commitBoundaryCalls, 1);
    pass("cancellation and final guards prevent any authoritative transition");

    let notifications = 0;
    kernel.subscribe(() => { throw new Error("subscriber failure"); });
    kernel.subscribe(async () => { throw new Error("async subscriber failure"); });
    kernel.subscribe(() => { notifications++; });
    await rejectsCode(() => kernel.commit({ idempotencyKey: "forged-speech", operations: [{ op: "say", actorId: "bot", text: "forged" }] }), "SPEAKER_AUTHORIZATION_REQUIRED");
    await kernel.commit({ idempotencyKey: "bot-speech", operations: [{ op: "say", actorId: "bot", text: "hello" }] }, { speakerId: "bot" });
    assert(notifications > 0);
    const beforePeek = kernel.snapshot();
    assert((await kernel.peek("outsider")).utterances.some(u => u.text === "hello"));
    assert.deepEqual(kernel.snapshot(), beforePeek);
    const outsiderHears = await kernel.observe("outsider");
    const bobHears = await kernel.observe("bob");
    assert(outsiderHears.utterances.some(u => u.text === "hello"));
    assert(!bobHears.utterances.some(u => u.text === "hello"));
    assert(!(await kernel.observe("outsider")).utterances.length);
    pass("controlled speech requires caller authorization; only colocated actors hear it once");

    const persisted = kernel.snapshot();
    const eventCount = kernel.readEvents(0, 10000).length;
    const notificationCount = notifications;
    await kernel.reload();
    assert.deepEqual(kernel.snapshot(), persisted); assert.equal(kernel.readEvents(0, 10000).length, eventCount);
    assert.equal(notifications, notificationCount);
    const reopened = await WorldKernel.open(dir, { now: () => now });
    assert.deepEqual(reopened.snapshot(), persisted);
    const retried = await reopened.commit({ idempotencyKey: "bot-speech", operations: [{ op: "say", actorId: "bot", text: "hello" }] }, { speakerId: "bot" });
    assert(retried.duplicate);
    pass("replay restores identical state and idempotency without republishing effects");

    await fs.appendFile(kernel.journalPath, '{"incomplete"');
    await kernel.reload();
    assert.deepEqual(kernel.snapshot(), persisted);
    assert((await fs.readFile(kernel.journalPath, "utf8")).endsWith("\n"));
    const snapshotCopy = kernel.snapshot(); snapshotCopy.entities.bot!.name = "changed outside";
    assert.notEqual(kernel.snapshot().entities.bot!.name, "changed outside");
    await kernel.reset(seed);
    assert(!(await kernel.observe("bot")).utterances.length);
    assert.equal(kernel.snapshot().entities.bot!.location, "room");
    pass("incomplete-tail recovery, snapshot isolation, and clean journaled reset");
    console.log(`\n${checks} world-kernel checks passed`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
