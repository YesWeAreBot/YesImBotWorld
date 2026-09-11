import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorldBus, envelope, type BusEnvelope, type BusListener } from "./bus.js";
import {
  KernelError, assertJson, assertSafeKey, clone, emptyWorld,
  type EntityInput, type KernelDiagnostic, type ObserveRequest, type PreparedProposal, type TransactionProposal,
  type WorldAction, type WorldAttribute, type WorldEntity, type WorldObservation,
  type WorldOperation, type WorldSnapshot,
} from "./state.js";

export interface KernelOptions {
  /** World time, normally WorldClock.now in TU. */
  now?: () => number;
  onSubscriberError?: (error: unknown) => void;
}
export interface CommitOptions {
  signal?: AbortSignal;
  /** Called synchronously at the final boundary immediately before journal append. */
  beforeCommit?: () => boolean;
  /** Trusted caller authorization; never populate this from a model proposal. */
  speakerId?: string;
  /** Administrative controller transfer, unavailable to model-generated proposals. */
  allowControllerChanges?: boolean;
}
export interface CommitResult {
  transactionId: string;
  sequence: number;
  duplicate: boolean;
  changedEntityIds: string[];
  events: BusEnvelope[];
}
interface Handle { actorId: string; entityId: string; observationId: string }
interface JournalRecord {
  schemaVersion: 1;
  type: "transaction" | "reset" | "observation";
  sequence: number;
  transactionId: string;
  effectiveAt: number;
  idempotencyKey?: string;
  fingerprint?: string;
  proposal?: TransactionProposal;
  seed?: EntityInput[];
  envelopes: BusEnvelope[];
  handles?: [string, Handle][];
  observationActorId?: string;
  changedEntityIds: string[];
}
interface Speech { speakerId: string; speakerName: string; text: string; audience: string[] }

/**
 * Single-process authoritative store. Every transition is validated on a private copy,
 * appended and fsynced as one JSONL record, then made visible. Replay never publishes.
 * One WorldKernel instance must own a basePath; this is not a multiprocess database.
 */
export class WorldKernel {
  readonly journalPath: string;
  private state = emptyWorld();
  private records: JournalRecord[] = [];
  private committed = new Map<string, JournalRecord>();
  private handles = new Map<string, Handle>();
  private lastObserved = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  readonly bus: WorldBus;
  private writeFault: Error | null = null;

  constructor(readonly basePath: string, options: KernelOptions = {}) {
    this.journalPath = path.join(basePath, "world-transactions.jsonl");
    this.now = options.now ?? Date.now;
    this.bus = new WorldBus(options.onSubscriberError);
  }
  static async open(basePath: string, options: KernelOptions = {}): Promise<WorldKernel> {
    const kernel = new WorldKernel(basePath, options);
    await kernel.reload();
    return kernel;
  }
  snapshot(): WorldSnapshot { return clone(this.state); }
  subscribe(listener: BusListener): () => void { return this.bus.subscribe(listener); }

  /** Validation is advisory; commit always validates again against the latest state. */
  propose(input: TransactionProposal): PreparedProposal {
    const proposal = this.copyProposal(input);
    const effectiveAt = proposal.effectiveAt ?? this.now();
    const result = this.apply(this.state, proposal, effectiveAt, { preview: true });
    return { proposal, basedOnSequence: this.state.sequence, changedEntityIds: result.changed };
  }

  commit(input: TransactionProposal | PreparedProposal, options: CommitOptions = {}): Promise<CommitResult> {
    // Capture immediately: callers cannot mutate an object while it waits in the queue.
    const proposal = this.copyProposal("proposal" in input ? input.proposal : input);
    return this.enqueue(async () => {
      this.checkSignal(options);
      const fingerprint = digest(proposal);
      const prior = this.committed.get(proposal.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new KernelError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different proposal");
        return this.result(prior, true);
      }
      const effectiveAt = proposal.effectiveAt ?? this.now();
      const result = this.apply(this.state, proposal, effectiveAt, { speakerId: options.speakerId, allowControllerChanges: options.allowControllerChanges });
      const sequence = this.state.sequence + 1;
      result.state.sequence = sequence;
      const command = envelope({ kind: "command", topic: "world.commit", source: proposal.source ?? "world", sequence, effectiveAt, priority: 3,
        ...(proposal.actorId ? { actorId: proposal.actorId } : {}), ...(proposal.correlationId ? { correlationId: proposal.correlationId } : {}), payload: proposal });
      const events: BusEnvelope[] = [envelope({ kind: "event", topic: "world.committed", source: "kernel", sequence, effectiveAt, priority: 3,
        causationId: command.id, correlationId: proposal.correlationId ?? command.id,
        payload: { changedEntityIds: result.changed, actionIds: result.actionIds,
          perceptibleChanges: this.perceptibleChanges(this.state, result.state, result.changed, result.actionIds) } })];
      for (const speech of result.speeches) events.push(envelope({ kind: "event", topic: "world.speech", source: "kernel", actorId: speech.speakerId,
        sequence, effectiveAt, priority: 2, causationId: command.id, correlationId: proposal.correlationId ?? command.id, payload: speech }));
      const record: JournalRecord = { schemaVersion: 1, type: "transaction", sequence, transactionId: command.id, effectiveAt,
        idempotencyKey: proposal.idempotencyKey, fingerprint, proposal, envelopes: [command, ...events], changedEntityIds: result.changed };
      this.checkSignal(options);
      await this.append(record, () => this.checkCancellation(options));
      this.state = result.state;
      this.acceptRecord(record);
      this.publish(record);
      return this.result(record, false);
    });
  }

  /** Seed / migrate once. Callers supply explicit entities; the kernel invents no facts. */
  initialize(entities: EntityInput[], idempotencyKey = "world:initialize"): Promise<CommitResult | null> {
    const seed = clone(entities);
    return this.enqueue(async () => {
      if (Object.keys(this.state.entities).length) return null;
      return this.resetInside(seed, idempotencyKey);
    });
  }

  /** Reset is itself journaled, retaining the preceding world for audit and replay. */
  reset(entities: EntityInput[] = []): Promise<void> {
    const seed = clone(entities);
    return this.enqueue(async () => { await this.resetInside(seed); });
  }

  private async resetInside(seed: EntityInput[], idempotencyKey?: string): Promise<CommitResult> {
    const effectiveAt = this.now();
    const proposal: TransactionProposal = { idempotencyKey: idempotencyKey ?? randomUUID(), operations: seed.map(entity => ({ op: "create", entity })) };
    const result = this.apply(emptyWorld(), proposal, effectiveAt, { replay: true });
    const sequence = this.state.sequence + 1;
    result.state.sequence = sequence;
    const event = envelope({ kind: "event", topic: "world.reset", source: "kernel", sequence, effectiveAt, priority: 0, payload: { entityIds: result.changed } });
    const record: JournalRecord = { schemaVersion: 1, type: "reset", sequence, transactionId: event.id, effectiveAt, seed,
      envelopes: [event], changedEntityIds: result.changed, ...(idempotencyKey ? { idempotencyKey, fingerprint: digest(proposal) } : {}) };
    await this.append(record);
    this.state = result.state;
    this.acceptRecord(record);
    this.publish(record);
    return this.result(record, false);
  }

  /** Administrative event access. Never expose this global journal directly to an actor. */
  readEvents(afterSequence = 0, limit = 100): BusEnvelope[] {
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), 10000)) : 100;
    return clone(this.records.filter(r => r.sequence > afterSequence).flatMap(r => r.envelopes).slice(0, count));
  }

  /** Access targets only through actor-scoped opaque handles returned by observe. */
  resolveObserved(actorId: string, observedId: string): string {
    const handle = this.handles.get(observedId);
    if (!handle || handle.actorId !== actorId || !this.visibleEntities(this.state, actorId).has(handle.entityId)) {
      throw new KernelError("NOT_OBSERVED", "The target is not currently observable by this actor");
    }
    return handle.entityId;
  }

  observationIdFor(actorId: string, observedId: string): string {
    this.resolveObserved(actorId, observedId);
    return this.handles.get(observedId)!.observationId;
  }
  latestObservation(actorId: string): WorldObservation | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]!;
      if (record.type === "reset") break;
      const event = record.envelopes.find(e => e.kind === "observation" && e.actorId === actorId);
      if (event) return clone(event.payload as WorldObservation);
    }
    return null;
  }

  observe(actorId: string, request: ObserveRequest = {}): Promise<WorldObservation> {
    return this.makeObservation(actorId, request, true);
  }
  /** Administrative read; does not consume speech, journal a read, or issue target capabilities. */
  peek(actorId: string, request: ObserveRequest = {}): Promise<WorldObservation> {
    return this.makeObservation(actorId, request, false);
  }
  private makeObservation(actorId: string, request: ObserveRequest, persist: boolean): Promise<WorldObservation> {
    const captured = clone(request);
    return this.enqueue(async () => {
      const visible = this.visibleEntities(this.state, actorId);
      const targetId = captured.target ? this.resolveObserved(actorId, captured.target) : undefined;
      const ids = captured.selfOnly ? [actorId] : targetId ? [...visible].filter(id => id === actorId || id === targetId) : [...visible];
      const sequence = this.state.sequence + (persist ? 1 : 0);
      const observedAt = this.now();
      const observationId = randomUUID();
      const freshHandles = new Map(ids.map(id => [id, `seen:${randomUUID()}`]));
      const entities = ids.map(id => {
        const entity = this.state.entities[id]!;
        const owned = id === actorId || entity.owner === actorId;
        const attributes = Object.fromEntries(Object.entries(entity.attributes)
          .filter(([, attr]) => attr.visibility === "public" || (attr.visibility === "owner" && owned && !captured.publicOnly))
          .map(([key, attr]) => [key, clone(attr.value)]));
        const locationObservedId = entity.location ? freshHandles.get(entity.location) : undefined;
        const ownershipKnown = entity.owner === actorId || entity.owner === entity.location;
        const ownerObservedId = entity.owner && ownershipKnown ? freshHandles.get(entity.owner) : undefined;
        return { observedId: freshHandles.get(id)!, kind: entity.kind, name: entity.name, revision: entity.revision, self: id === actorId, attributes,
          ...(locationObservedId ? { locationObservedId } : {}), ...(ownerObservedId ? { ownerObservedId } : {}) };
      });
      const since = captured.sinceSequence ?? this.lastObserved.get(actorId) ?? 0;
      if (!Number.isFinite(since) || since < 0) throw new KernelError("INVALID_SEQUENCE", "sinceSequence must be nonnegative");
      const utterances: WorldObservation["utterances"] = [];
      let epochStart = 0;
      for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i]!.type === "reset") { epochStart = i; break; }
      const currentRecords = this.records.slice(epochStart);
      for (const record of currentRecords) {
        if (record.sequence <= since || captured.selfOnly || captured.includeSpeech === false) continue;
        for (const event of record.envelopes) {
          if (event.topic !== "world.speech") continue;
          const speech = event.payload as Speech;
          if (!speech.audience.includes(actorId)) continue;
          const speakerObservedId = freshHandles.get(speech.speakerId);
          utterances.push({ eventId: event.id, speakerName: speech.speakerName, ...(speakerObservedId ? { speakerObservedId } : {}), text: speech.text, spokenAt: event.effectiveAt });
        }
      }
      // Source identity comes from committed changes, never from this read's new ID.
      // Repeated observation of the same fact therefore cannot become fresh evidence.
      const latestSources = new Map<string, string>();
      const recentSources = new Set<string>();
      for (const record of currentRecords) for (const event of record.envelopes) {
        if (event.topic === "world.reset" && ids.some(id => record.changedEntityIds.includes(id))) {
          for (const id of ids) if (record.changedEntityIds.includes(id)) latestSources.set(id, event.id);
        }
        if (event.topic !== "world.committed") continue;
        const changes = (event.payload as { perceptibleChanges?: Record<string, string[]> }).perceptibleChanges?.[actorId] ?? [];
        for (const id of changes) {
          if (ids.includes(id)) latestSources.set(id, event.id);
          if (record.sequence > since && ((!targetId && !captured.selfOnly) || ids.includes(id))) recentSources.add(event.id);
        }
      }
      const sourceEventIds = [...new Set([...latestSources.values(), ...recentSources, ...utterances.map(u => u.eventId)])];
      const observation: WorldObservation = { observationId, actorId, worldSequence: sequence, observedAt, sourceEventIds, entities, utterances };
      if (!persist) return clone(observation);
      const event = envelope({ kind: "observation", topic: "world.observed", source: "kernel", actorId, sequence, effectiveAt: observedAt, priority: 4, payload: observation });
      const handles: [string, Handle][] = [...freshHandles].map(([entityId, handle]) => [handle, { actorId, entityId, observationId }]);
      const record: JournalRecord = { schemaVersion: 1, type: "observation", sequence, transactionId: event.id, effectiveAt: observedAt,
        envelopes: [event], handles, ...(captured.consume === false || captured.selfOnly || captured.includeSpeech === false ? {} : { observationActorId: actorId }), changedEntityIds: [] };
      await this.append(record);
      this.state = { ...this.state, sequence };
      this.acceptRecord(record);
      this.publish(record);
      return clone(observation);
    });
  }

  reload(): Promise<void> {
    return this.enqueue(async () => {
      await fs.mkdir(this.basePath, { recursive: true });
      let raw: string;
      try { raw = await fs.readFile(this.journalPath, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; raw = ""; }
      // A crash may leave an incomplete final append. Only newline-terminated records commit.
      const validEnd = raw.lastIndexOf("\n") + 1;
      if (validEnd < raw.length) await fs.truncate(this.journalPath, Buffer.byteLength(raw.slice(0, validEnd)));
      const next = emptyWorld();
      const records: JournalRecord[] = [];
      let replayState = next;
      for (const line of raw.slice(0, validEnd).split("\n")) {
        if (!line.trim()) continue;
        let record: JournalRecord;
        try { record = JSON.parse(line) as JournalRecord; assertJson(record); }
        catch (error) { throw new KernelError("CORRUPT_JOURNAL", `Cannot parse journal record ${records.length + 1}: ${String(error)}`); }
        if (record.schemaVersion !== 1 || record.sequence !== replayState.sequence + 1 || !Array.isArray(record.envelopes)) {
          throw new KernelError("CORRUPT_JOURNAL", "Journal schema or sequence is invalid");
        }
        if (record.type === "transaction" && record.proposal) {
          if (record.fingerprint !== digest(record.proposal)) throw new KernelError("CORRUPT_JOURNAL", "Transaction fingerprint mismatch");
          replayState = this.apply(replayState, record.proposal, record.effectiveAt, { replay: true }).state;
        } else if (record.type === "reset" && record.seed) {
          replayState = this.apply(emptyWorld(), { idempotencyKey: record.transactionId, operations: record.seed.map(entity => ({ op: "create", entity })) }, record.effectiveAt, { replay: true }).state;
        } else if (record.type !== "observation") throw new KernelError("CORRUPT_JOURNAL", "Unknown or incomplete journal record");
        replayState.sequence = record.sequence;
        records.push(record);
      }
      this.state = replayState;
      this.records = [];
      this.committed.clear(); this.handles.clear(); this.lastObserved.clear();
      for (const record of records) this.acceptRecord(record);
      this.writeFault = null;
    });
  }

  private copyProposal(input: TransactionProposal): TransactionProposal {
    assertJson(input);
    if (!input || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256) throw new KernelError("INVALID_PROPOSAL", "A nonempty idempotencyKey of at most 256 characters is required");
    if (!Array.isArray(input.operations) || !input.operations.length) throw new KernelError("INVALID_PROPOSAL", "At least one operation is required");
    return clone(input);
  }

  private apply(base: WorldSnapshot, proposal: TransactionProposal, effectiveAt: number,
    options: { replay?: boolean; preview?: boolean; speakerId?: string; allowControllerChanges?: boolean }): { state: WorldSnapshot; changed: string[]; actionIds: string[]; speeches: Speech[] } {
    if (!Number.isFinite(effectiveAt) || effectiveAt < 0) throw new KernelError("INVALID_TIME", "effectiveAt must be a nonnegative finite world time");
    if (effectiveAt < base.effectiveAt) throw new KernelError("PAST_COMMIT", "A transaction cannot move authoritative state backward in time");
    if (!options.replay && effectiveAt > this.now()) throw new KernelError("FUTURE_COMMIT", "Future state cannot commit before its effectiveAt");
    const state = clone(base);
    const changed = new Set<string>(); const actionIds = new Set<string>();
    const actor = proposal.actorId ? this.requireEntity(base, proposal.actorId, "actor") : undefined;
    const expected = proposal.expectedVersions ?? {};
    for (const [id, version] of Object.entries(expected)) {
      assertSafeKey(id);
      if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw new KernelError("INVALID_VERSION", `Invalid expected revision for ${id}`);
      const current = base.entities[id]?.revision ?? null;
      if (current !== version) throw new KernelError("VERSION_CONFLICT", `Entity ${id} changed: expected ${version}, got ${current}`);
    }
    // Check completion against the pre-transaction snapshot, so operation ordering cannot
    // accidentally invalidate the very changes being committed with action.finish.
    for (const operation of proposal.operations) if (operation.op === "action.finish") {
        const action = Object.hasOwn(base.actions, operation.id) ? base.actions[operation.id] : undefined;
      if (!action || action.status !== "pending") throw new KernelError("ACTION_NOT_PENDING", `Action ${operation.id} is not pending`);
      if (actor && action.actorId !== actor.id) throw new KernelError("ACTOR_MISMATCH", "An actor cannot finish another actor's action");
      if (operation.status === "completed") {
        if (action.expectedEnd !== undefined && effectiveAt < action.expectedEnd) throw new KernelError("ACTION_NOT_DUE", "The action has not reached its expected end");
        for (const [id, version] of Object.entries(action.targetVersions)) {
          if (base.entities[id]?.revision !== version) throw new KernelError("ACTION_PRECONDITION_CHANGED", `Action target ${id} changed during execution`);
        }
      }
    }
    for (const operation of proposal.operations) {
      if (!operation || typeof operation !== "object") throw new KernelError("INVALID_OPERATION", "Operation must be an object");
      if (operation.op === "create") {
        const input = operation.entity;
        this.validateEntityInput(input);
        if (Object.hasOwn(state.entities, input.id)) throw new KernelError("ENTITY_EXISTS", `Entity ${input.id} already exists`);
        state.entities[input.id] = { ...clone(input), revision: 1, attributes: clone(input.attributes ?? {}) };
        changed.add(input.id);
      } else if (operation.op === "update" || operation.op === "move") {
        const entity = this.requireEntity(state, operation.id);
        if (actor && base.entities[entity.id] && expected[entity.id] === undefined) throw new KernelError("EXPECTED_VERSION_REQUIRED", `Actor updates require expectedVersions.${entity.id}`);
        if (operation.op === "move") {
          this.nullableId(operation.location, "location");
          entity.location = operation.location;
          if ("owner" in operation) { this.nullableId(operation.owner, "owner"); entity.owner = operation.owner; }
        } else {
          if (!operation.changes || typeof operation.changes !== "object") throw new KernelError("INVALID_OPERATION", "update.changes is required");
          for (const key of Object.keys(operation.changes)) if (!["name", "controller", "attributes"].includes(key)) throw new KernelError("INVALID_OPERATION", `Unknown mutable field ${key}`);
          if ("name" in operation.changes) { this.nonempty(operation.changes.name, "name"); entity.name = operation.changes.name!; }
          if ("controller" in operation.changes) {
            if (!options.replay && !options.preview && !options.allowControllerChanges) throw new KernelError("CONTROLLER_AUTHORIZATION_REQUIRED", "Controller changes require an administrative caller");
            this.nullableId(operation.changes.controller, "controller"); entity.controller = operation.changes.controller;
          }
          if (operation.changes.attributes) for (const [key, attr] of Object.entries(operation.changes.attributes)) {
            assertSafeKey(key);
            if (attr === null) delete entity.attributes[key];
            else { this.validateAttribute(attr); entity.attributes[key] = clone(attr); }
          }
        }
        entity.revision++; changed.add(entity.id);
      } else if (operation.op === "action.start") {
        const input = operation.action;
        this.nonempty(input.id, "action.id"); assertSafeKey(input.id); this.nonempty(input.intent, "action.intent");
        this.requireEntity(state, input.actorId, "actor");
        if (actor && actor.id !== input.actorId) throw new KernelError("ACTOR_MISMATCH", "An actor cannot start another actor's action");
        if (Object.hasOwn(state.actions, input.id)) throw new KernelError("ACTION_EXISTS", `Action ${input.id} already exists`);
        if (Object.values(state.actions).some(a => a.actorId === input.actorId && a.status === "pending")) throw new KernelError("ACTOR_BUSY", "The actor already has a pending physical action");
        if (input.expectedEnd !== undefined && (!Number.isFinite(input.expectedEnd) || input.expectedEnd < 0)) throw new KernelError("INVALID_TIME", "expectedEnd must be a nonnegative finite world time");
        const targetIds = input.targetIds ?? [];
        if (!Array.isArray(targetIds)) throw new KernelError("INVALID_ACTION", "targetIds must be an array");
        const targetVersions: Record<string, number> = {};
        for (const id of new Set([input.actorId, ...targetIds])) targetVersions[id] = this.requireEntity(state, id).revision;
        if (actor && !options.replay) {
          if (!input.basedOnObservationId) throw new KernelError("OBSERVATION_REQUIRED", "Actor actions must cite an observation");
          const seen = new Set([...this.handles.values()].filter(h => h.actorId === actor.id && h.observationId === input.basedOnObservationId).map(h => h.entityId));
          if (!seen.has(actor.id)) throw new KernelError("OBSERVATION_REQUIRED", "The cited observation does not belong to this actor");
          const visible = this.visibleEntities(base, actor.id);
          for (const id of targetIds) if (!seen.has(id) || !visible.has(id)) throw new KernelError("NOT_OBSERVED", "An action target was not observed or is no longer visible");
          for (const id of new Set([actor.id, ...targetIds])) if (expected[id] === undefined) throw new KernelError("EXPECTED_VERSION_REQUIRED", `Actor actions require expectedVersions.${id}`);
        }
        state.actions[input.id] = { ...clone(input), ...(input.expectedEnd !== undefined ? { expectedEnd: Math.max(input.expectedEnd, effectiveAt) } : {}), status: "pending", startedAt: effectiveAt, targetVersions };
        actionIds.add(input.id);
      } else if (operation.op === "action.finish") {
        if (!["completed", "cancelled", "failed"].includes(operation.status)) throw new KernelError("INVALID_ACTION", "Invalid terminal action status");
        const action = state.actions[operation.id]!;
        if (action.status !== "pending") throw new KernelError("ACTION_NOT_PENDING", "Action was already finished in this transaction");
        action.status = operation.status; action.finishedAt = effectiveAt;
        if (operation.reason !== undefined) { if (typeof operation.reason !== "string") throw new KernelError("INVALID_ACTION", "reason must be text"); action.reason = operation.reason; }
        actionIds.add(operation.id);
      } else if (operation.op === "say") {
        const speaker = this.requireEntity(state, operation.actorId, "actor");
        this.nonempty(operation.text, "speech.text");
        if (actor && actor.id !== speaker.id && speaker.controller !== "world") throw new KernelError("ACTOR_MISMATCH", "An actor cannot speak for another controlled actor");
        const previousController = base.entities[speaker.id]?.controller;
        if (!options.replay && !options.preview && ((speaker.controller && speaker.controller !== "world") || (previousController && previousController !== "world")) && options.speakerId !== speaker.id) {
          throw new KernelError("SPEAKER_AUTHORIZATION_REQUIRED", "Only the controller may provide this actor's speech");
        }
        if (operation.audience && (!Array.isArray(operation.audience) || operation.audience.some(id => typeof id !== "string"))) throw new KernelError("INVALID_SPEECH", "audience must contain actor IDs");
      } else throw new KernelError("INVALID_OPERATION", `Unknown operation ${(operation as { op?: unknown }).op}`);
    }
    this.validateWorld(state);
    const speeches: Speech[] = [];
    for (const operation of proposal.operations) if (operation.op === "say") {
      const speaker = state.entities[operation.actorId]!;
      const audible = this.visibleEntities(state, speaker.id);
      const audience = [...audible].filter(id => state.entities[id]!.kind === "actor" && (!operation.audience || operation.audience.includes(id) || id === speaker.id));
      speeches.push({ speakerId: speaker.id, speakerName: speaker.name, text: operation.text, audience });
    }
    state.effectiveAt = effectiveAt;
    return { state, changed: [...changed], actionIds: [...actionIds], speeches };
  }

  private validateEntityInput(entity: EntityInput): void {
    if (!entity || typeof entity !== "object") throw new KernelError("INVALID_ENTITY", "Entity must be an object");
    this.nonempty(entity.id, "entity.id"); assertSafeKey(entity.id);
    this.nonempty(entity.name, "entity.name");
    if (!["actor", "place", "object"].includes(entity.kind)) throw new KernelError("INVALID_ENTITY", "Entity kind must be actor, place or object");
    this.nullableId(entity.location, "location");
    if (entity.owner !== undefined) this.nullableId(entity.owner, "owner");
    if (entity.controller !== undefined) this.nullableId(entity.controller, "controller");
    for (const [key, attr] of Object.entries(entity.attributes ?? {})) { assertSafeKey(key); this.validateAttribute(attr); }
  }
  private validateAttribute(attribute: WorldAttribute): void {
    if (!attribute || typeof attribute !== "object" || !["public", "owner", "hidden"].includes(attribute.visibility)) throw new KernelError("INVALID_ATTRIBUTE", "Each attribute requires value and visibility");
    assertJson(attribute.value);
  }
  private validateWorld(state: WorldSnapshot): void {
    const entities = Object.values(state.entities);
    // Validate shapes before walking any edges. Reference failures must remain diagnostics,
    // not turn into an undefined.location TypeError while inspecting a different entity.
    for (const entity of entities) this.validateEntityInput(entity);
    const details: KernelDiagnostic[] = [];
    const get = (id: string): WorldEntity | undefined => Object.hasOwn(state.entities, id) ? state.entities[id] : undefined;
    for (const entity of entities) {
      if (entity.location) {
        const parent = get(entity.location);
        const expectedKinds: EntityInput["kind"][] = entity.kind === "place" ? ["place"] : entity.kind === "actor" ? ["place", "object"] : ["actor", "place", "object"];
        if (!parent) details.push({ code: "MISSING_ENTITY", entityId: entity.id, field: "location", targetId: entity.location,
          reason: "missing", expectedKinds,
          message: `${entity.id}.location -> ${entity.location}: target entity does not exist. Use an entity ID declared in this transaction or the existing world; root places use location=null.` });
        else if (!expectedKinds.includes(parent.kind)) details.push({ code: "INVALID_LOCATION", entityId: entity.id, field: "location", targetId: parent.id,
          reason: "wrong_kind", expectedKinds, actualKind: parent.kind,
          message: `${entity.id}.location -> ${parent.id}: target kind is ${parent.kind}, expected ${expectedKinds.join(" or ")}.` });
      }
      if (entity.owner) {
        if (entity.kind !== "object") details.push({ code: "INVALID_OWNER", entityId: entity.id, field: "owner", targetId: entity.owner,
          reason: "owner_not_allowed", sourceKind: entity.kind,
          message: `${entity.id}.owner -> ${entity.owner}: only object entities may have an owner; this source is ${entity.kind}. Omit owner or use null.` });
        const owner = get(entity.owner);
        if (!owner) details.push({ code: "MISSING_ENTITY", entityId: entity.id, field: "owner", targetId: entity.owner,
          reason: "missing", expectedKinds: ["actor"],
          message: `${entity.id}.owner -> ${entity.owner}: target actor does not exist. Use a declared actor ID; unknown ownership is omitted or null.` });
        else if (owner.kind !== "actor") details.push({ code: "MISSING_ENTITY", entityId: entity.id, field: "owner", targetId: owner.id,
          reason: "wrong_kind", expectedKinds: ["actor"], actualKind: owner.kind,
          message: `${entity.id}.owner -> ${owner.id}: target exists as ${owner.kind}, but an owner must be an actor.` });
      }
    }
    const reportedCycles = new Set<string>();
    for (const entity of entities) {
      const indices = new Map<string, number>();
      const chain: string[] = [];
      let id: string | null = entity.id;
      while (id !== null) {
        const repeatedAt = indices.get(id);
        if (repeatedAt !== undefined) {
          const cycle = [...chain.slice(repeatedAt), id];
          const cycleKey = JSON.stringify(cycle.slice(0, -1).sort());
          if (!reportedCycles.has(cycleKey)) {
            reportedCycles.add(cycleKey);
            const sourceId = chain[chain.length - 1]!;
            details.push({ code: "CONTAINMENT_CYCLE", entityId: sourceId, field: "location", targetId: id, reason: "cycle", path: cycle,
              message: `${sourceId}.location -> ${id}: containment cycle ${cycle.join(" -> ")}.` });
          }
          break;
        }
        const current = get(id);
        if (!current) break; // The owning edge was already reported above.
        indices.set(id, chain.length); chain.push(id); id = current.location;
      }
    }
    if (details.length) throw new KernelError(details[0]!.code,
      `World reference validation failed (${details.length} issue${details.length === 1 ? "" : "s"}):\n${details.map(issue => `[${issue.code}] ${issue.message}`).join("\n")}`, details);
  }

  /** The observer's immediate enclosure is the visual region; closed containers occlude. */
  private visibleEntities(state: WorldSnapshot, actorId: string): Set<string> {
    const actor = this.requireEntity(state, actorId, "actor");
    const result = new Set<string>([actorId]);
    let regionId = actor.location;
    while (regionId) {
      const region = state.entities[regionId]!;
      if (region.kind === "place" || !this.isOpen(region)) break;
      if (!region.location) break;
      regionId = region.location;
    }
    if (regionId) result.add(regionId);
    for (const entity of Object.values(state.entities)) {
      if (entity.id === actorId || entity.id === regionId) continue;
      let parentId = entity.location;
      while (parentId) {
        if (parentId === actorId) { result.add(entity.id); break; }
        if (parentId === regionId) { result.add(entity.id); break; }
        const parent = state.entities[parentId]!;
        if (!this.isOpen(parent)) break;
        parentId = parent.location;
      }
    }
    return result;
  }
  private isOpen(entity: WorldEntity): boolean {
    return entity.kind === "object" && (entity.attributes.open?.value === true || entity.attributes.transparent?.value === true);
  }
  private requireEntity(state: WorldSnapshot, id: string, kind?: WorldEntity["kind"]): WorldEntity {
    if (typeof id !== "string") throw new KernelError("INVALID_ID", "Entity ID must be text");
    assertSafeKey(id);
    const entity = Object.hasOwn(state.entities, id) ? state.entities[id] : undefined;
    if (!entity || (kind && entity.kind !== kind)) throw new KernelError("MISSING_ENTITY", `Entity ${id} does not exist${kind ? ` as ${kind}` : ""}`);
    return entity;
  }
  private nonempty(value: unknown, field: string): asserts value is string {
    if (typeof value !== "string" || !value.trim()) throw new KernelError("INVALID_VALUE", `${field} must be nonempty text`);
  }
  /** Compare visible facts, omitting revision so a private-only write is not evidence. */
  private perceptibleChanges(before: WorldSnapshot, after: WorldSnapshot, changed: string[], actionIds: string[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    const actors = new Set([...Object.values(before.entities), ...Object.values(after.entities)].filter(e => e.kind === "actor").map(e => e.id));
    for (const actorId of actors) {
      const beforeVisible = Object.hasOwn(before.entities, actorId) ? this.visibleEntities(before, actorId) : new Set<string>();
      const afterVisible = Object.hasOwn(after.entities, actorId) ? this.visibleEntities(after, actorId) : new Set<string>();
      const view = (state: WorldSnapshot, visible: Set<string>, id: string) => {
        if (!visible.has(id)) return null;
        const entity = state.entities[id]!;
        return { id: entity.id, name: entity.name, kind: entity.kind,
          location: entity.location && visible.has(entity.location) ? entity.location : null,
          owner: entity.owner && visible.has(entity.owner) && (entity.owner === actorId || entity.owner === entity.location) ? entity.owner : null,
          attributes: Object.fromEntries(Object.entries(entity.attributes).filter(([, attribute]) => attribute.visibility === "public" ||
            (attribute.visibility === "owner" && (entity.id === actorId || entity.owner === actorId))).map(([key, attribute]) => [key, attribute.value])) };
      };
      // Opening a container or moving an observer can reveal entities untouched by this tx.
      const candidates = new Set([...changed, ...beforeVisible, ...afterVisible]);
      const perceived = [...candidates].filter(id => digest(view(before, beforeVisible, id)) !== digest(view(after, afterVisible, id)));
      for (const id of actionIds) if (after.actions[id]?.actorId === actorId) perceived.push(actorId);
      if (perceived.length) result[actorId] = [...new Set(perceived)];
    }
    return result;
  }
  private nullableId(value: unknown, field: string): asserts value is string | null {
    if (value !== null) { this.nonempty(value, field); assertSafeKey(value); }
  }
  private checkCancellation(options: CommitOptions): void {
    this.checkSignal(options);
    if (options.beforeCommit?.() === false) throw new KernelError("CANCELLED", "The transaction was cancelled before persistence");
  }
  private checkSignal(options: CommitOptions): void {
    if (options.signal?.aborted) throw new KernelError("CANCELLED", "The transaction was cancelled before persistence");
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async append(record: JournalRecord, beforeWrite?: () => void): Promise<void> {
    if (this.writeFault) throw new KernelError("JOURNAL_UNAVAILABLE", "A prior journal write failed; reload before attempting another write");
    const handle = await fs.open(this.journalPath, "a");
    let writeStarted = false;
    try { beforeWrite?.(); writeStarted = true; await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
    catch (error) { if (writeStarted) this.writeFault = error instanceof Error ? error : new Error(String(error)); throw error; }
    finally { await handle.close(); }
  }
  private acceptRecord(record: JournalRecord): void {
    if (record.type === "reset") { this.committed.clear(); this.handles.clear(); this.lastObserved.clear(); }
    this.records.push(record);
    if (record.idempotencyKey) this.committed.set(record.idempotencyKey, record);
    for (const [id, handle] of record.handles ?? []) this.handles.set(id, handle);
    if (record.observationActorId) this.lastObserved.set(record.observationActorId, record.sequence);
  }
  private publish(record: JournalRecord): void { for (const event of record.envelopes) this.bus.publish(event); }
  private result(record: JournalRecord, duplicate: boolean): CommitResult {
    return { transactionId: record.transactionId, sequence: record.sequence, duplicate,
      changedEntityIds: [...record.changedEntityIds], events: clone(record.envelopes.filter(e => e.kind === "event")) };
  }
}

function digest(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input !== null && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
