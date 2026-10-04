import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorldFiles } from "../files.js";
import { WorldKernel } from "./kernel.js";
import { WorldBus, envelope, type BusEnvelope, type BusListener } from "./bus.js";
import { assertJson, assertSafeKey, KernelError, type JsonValue, type WorldEntity, type WorldObservation, type WorldSnapshot } from "./state.js";
import type { NarrativeActor, NarrativeAction, NarrativeCommit, NarrativeCommitResult, NarrativePerception, NarrativeSnapshot } from "./narrative-types.js";
import { validNarrativeEvolution, validNarrativePresentation } from "./narrative-types.js";
import { validPhonePhysicalState } from "../phone-state.js";
import { validNarrativeConsciousness } from "./consciousness.js";

interface StoreOptions {
  now?: () => number;
  onSubscriberError?: (error: unknown) => void;
  onMirrorError?: (error: unknown) => void;
}
interface CommitOptions {
  signal?: AbortSignal;
  beforeCommit?: () => boolean;
  /** Trusted import boundary only: preserve the source world's clock even if its clock file lags. */
  effectiveAt?: number;
}
interface JournalRecord {
  schemaVersion: 1;
  type: "commit";
  sequence: number;
  effectiveAt: number;
  transactionId: string;
  fingerprint: string;
  commit: NarrativeCommit;
  perceptions: NarrativePerception[];
  events: BusEnvelope[];
  checksum: string;
}

/** One process owns the directory. Publish only after a complete durable state-and-event append. */
export class NarrativeStore {
  readonly journalPath: string;
  readonly bus: WorldBus;
  private state = emptyState();
  private records: JournalRecord[] = [];
  private committed = new Map<string, JournalRecord>();
  private tail: Promise<unknown> = Promise.resolve();
  private writeFault: unknown;
  private readonly now: () => number;
  constructor(readonly basePath: string, private options: StoreOptions = {}) {
    this.journalPath = path.join(basePath, "world-narrative.jsonl");
    this.now = options.now ?? Date.now;
    this.bus = new WorldBus(options.onSubscriberError);
  }
  static async open(basePath: string, options: StoreOptions = {}): Promise<NarrativeStore> {
    const store = new NarrativeStore(basePath, options);
    await store.reload();
    return store;
  }
  snapshot(): NarrativeSnapshot { return clone(this.state); }
  subscribe(listener: BusListener): () => void { return this.bus.subscribe(listener); }
  findCommit(idempotencyKey: string): NarrativeCommitResult | null {
    const record = this.committed.get(idempotencyKey);
    return record ? result(record, true) : null;
  }
  readEvents(sinceSequence = 0, limit = 1000): BusEnvelope[] {
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 1000;
    return clone(this.records.filter(record => record.sequence > sinceSequence).flatMap(record => record.events).slice(0, count));
  }
  readPerceptions(actorId: string, sinceSequence = 0, actionId?: string): NarrativePerception[] {
    return clone(this.records.filter(record => record.sequence > sinceSequence).flatMap(record => record.perceptions)
      .filter(perception => perception.actorId === actorId && (actionId === undefined || perception.actionId === actionId)));
  }
  /** Recent terminal requests, not a replay of scenes or proof that an intent succeeded. */
  readRecentActions(actorId: string, excludeActionId?: string, limit = 3, maxChars = 1800,
    feedback?: { currentPerception?: string; projectText?: (text: string) => string },
  ): { sequence: number; worldTime: number; intent: string; status: NarrativeAction["status"]; reason?: string; reasonOmitted?: true;
    result?: { eventId: string; text?: string; inCurrentPerception?: true; omitted?: true } }[] {
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 3;
    const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 1800;
    const recent: ReturnType<NarrativeStore["readRecentActions"]> = [];
    const seen = new Set<string>();
    let chars = 2;
    for (let index = this.records.length - 1; index >= 0 && recent.length < count; index--) {
      const record = this.records[index]!;
      for (const action of Object.values(record.commit.actions ?? {})) {
        if (action.actorId !== actorId || action.id === excludeActionId || seen.has(action.id)) continue;
        seen.add(action.id);
        if (action.status === "pending") continue;
        const row: (typeof recent)[number] = { sequence: record.sequence, worldTime: record.effectiveAt, intent: action.intent, status: action.status };
        if (feedback) {
          if (action.reason) {
            const reason = feedback.projectText?.(action.reason) ?? action.reason;
            if (reason.trim() && reason.length <= 600) row.reason = reason;
            else row.reasonOmitted = true;
          }
          // Only this committed action's actual actor-visible outcome is evidence. A
          // suggestion, another actor's scene or an earlier accepted phase is not.
          const perception = record.perceptions.find(item => item.actorId === actorId && item.actionId === action.id);
          if (perception) {
            const text = feedback.projectText?.(perception.text) ?? perception.text;
            row.result = !text.trim() ? { eventId: perception.eventId, omitted: true }
              : perception.text === feedback.currentPerception
              ? { eventId: perception.eventId, inCurrentPerception: true }
              : text.length <= 1800 ? { eventId: perception.eventId, text } : { eventId: perception.eventId, omitted: true };
          }
        }
        const size = () => JSON.stringify(row).length + (recent.length ? 1 : 0);
        // Prefer intact execution metadata over a clipped quote. Omission remains
        // explicit and never means that an action had no result or no obstacle.
        if (chars + size() > budget && row.result?.text !== undefined) row.result = { eventId: row.result.eventId, omitted: true };
        if (chars + size() > budget && row.reason !== undefined) { delete row.reason; row.reasonOmitted = true; }
        // Keep complete intent/status pairs; never clip an instruction into a different
        // meaning or skip an oversized recent request and hide that chronological gap.
        if (chars + size() > budget) return recent.reverse();
        recent.push(row); chars += size();
        if (recent.length >= count) break;
      }
    }
    return recent.reverse();
  }
  /** Bounded, chronological window of actual external changes; never infer causes from legacy prose. */
  readRecentEvolution(limit = 3, maxChars = 6000): { sequence: number; worldTime: number; changes: { id: string; description: string }[] }[] {
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 3;
    const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 6000;
    const recent: { sequence: number; worldTime: number; changes: { id: string; description: string }[] }[] = [];
    let chars = 2; // JSON array brackets; later rows also need a comma.
    for (let index = this.records.length - 1; index >= 0 && recent.length < count; index--) {
      const record = this.records[index]!, changes = record.commit.evolution?.changes;
      if (!changes?.length) continue;
      const row = { sequence: record.sequence, worldTime: record.effectiveAt, changes: changes.map(({ id, description }) => ({ id, description })) };
      const size = JSON.stringify(row).length + (recent.length ? 1 : 0);
      // Do not skip a large recent event and present older ones as if no gap existed.
      if (chars + size > budget) break;
      recent.push(row); chars += size;
    }
    return recent.reverse();
  }
  /** Last committed evolution, including legacy records without external-cause metadata. */
  lastEvolutionAt(): number | undefined {
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index]!;
      if (record.commit.source === "evolve") return record.effectiveAt;
    }
    return undefined;
  }
  /** Complete committed records only, so a concurrent archive can never copy a half-written append. */
  exportJournal(): Promise<string> {
    return this.enqueue(async () => this.records.map(record => JSON.stringify(record) + "\n").join(""));
  }
  commit(input: NarrativeCommit, options: CommitOptions = {}): Promise<NarrativeCommitResult> {
    // Historical journals predate external-cause metadata; replay remains permissive.
    // Fresh writers cannot use that compatibility path to bypass evolve authority.
    if (input?.source === "evolve" && input.evolution === undefined) throw new KernelError("INVALID_EVOLUTION", "新的世界演化事务必须包含本轮外部变化及evolution来源；无变化时不要提交。");
    const commit = copyCommit(input);
    return this.enqueue(async () => {
      checkCancellation(options);
      if (this.writeFault) throw new KernelError("JOURNAL_UNAVAILABLE", "自然语言世界日志写入失败；重新加载确认已提交状态后才能继续。");
      const fingerprint = digest(commit), prior = this.committed.get(commit.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new KernelError("IDEMPOTENCY_CONFLICT", "相同请求标识不能用于不同世界更新。");
        return result(prior, true);
      }
      const sequence = this.state.sequence + 1;
      const effectiveAt = Math.max(this.state.effectiveAt, this.now(), options.effectiveAt ?? 0);
      if (!Number.isFinite(effectiveAt) || effectiveAt < 0) throw new KernelError("INVALID_TIME", "世界时间必须是非负有限数。");
      const transactionId = randomUUID();
      const perceptions: NarrativePerception[] = (commit.perceptions ?? []).map(perception => {
        const eventId = randomUUID();
        const actor = Object.hasOwn(commit.actors ?? {}, perception.actorId) ? commit.actors![perception.actorId] : this.state.actors[perception.actorId];
        return { eventId, actorId: perception.actorId, text: perception.text, worldSequence: sequence, worldTime: effectiveAt,
          ...(actor?.consciousness !== undefined ? { consciousness: actor.consciousness } : {}),
          ...(perception.situation !== undefined ? { situation: perception.situation } : {}),
          ...(perception.opportunities !== undefined ? { opportunities: perception.opportunities } : {}),
          ...(commit.actionPhase !== undefined ? { phase: commit.actionPhase } : {}),
          ...(commit.actionId ? { actionId: commit.actionId } : {}), sourceEventIds: [...new Set(perception.sourceEventIds === undefined ? [eventId] : perception.sourceEventIds)] };
      });
      const next = applyCommit(this.state, commit, sequence, effectiveAt, perceptions);
      const events: BusEnvelope[] = [envelope({ kind: "event", topic: "world.committed", source: commit.source, sequence, effectiveAt, priority: 3,
        ...(commit.actorId ? { actorId: commit.actorId } : {}), ...(commit.actionId ? { correlationId: commit.actionId } : {}),
        payload: { changedActorIds: Object.keys(commit.actors ?? {}), actionIds: Object.keys(commit.actions ?? {}),
          ...(commit.phoneState !== undefined ? { phoneStateChanged: JSON.stringify(commit.phoneState) !== JSON.stringify(this.state.phoneState) } : {}),
          perceptibleChanges: Object.fromEntries(perceptions.map(item => [item.actorId, [item.actorId]])) } }),
        ...perceptions.map(perception => ({ ...envelope({ kind: "observation", topic: "world.perception", source: commit.source,
          actorId: perception.actorId, sequence, effectiveAt, priority: 2, causationId: transactionId,
          ...(commit.actionId ? { correlationId: commit.actionId } : {}), payload: perception }), id: perception.eventId }))];
      const body = { schemaVersion: 1 as const, type: "commit" as const, sequence, effectiveAt, transactionId, fingerprint, commit, perceptions, events };
      const record: JournalRecord = { ...body, checksum: digest(body) };
      await this.append(record, options);
      this.state = next;
      this.records.push(record); this.committed.set(commit.idempotencyKey, record);
      for (const event of events) this.bus.publish(event);
      await this.writeMirrors();
      return result(record, false);
    });
  }
  reload(): Promise<void> {
    return this.enqueue(async () => {
      // A failed reload must never permit appending behind a corrupt or unconfirmed journal.
      this.writeFault = new Error("世界日志尚未成功恢复。");
      await fs.mkdir(this.basePath, { recursive: true });
      const raw = await readOptional(this.journalPath);
      const validEnd = raw.lastIndexOf("\n") + 1;
      let next = emptyState();
      const records: JournalRecord[] = [], committed = new Map<string, JournalRecord>();
      for (const line of raw.slice(0, validEnd).split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as JournalRecord;
          assertJson(record);
          const checksum = record.checksum, body = { ...(record as unknown as Record<string, unknown>) };
          delete body.checksum;
          if (record.schemaVersion !== 1 || record.type !== "commit" || record.sequence !== next.sequence + 1 ||
              checksum !== digest(body) || record.fingerprint !== digest(record.commit) ||
              !Array.isArray(record.events) || !Array.isArray(record.perceptions) || committed.has(record.commit.idempotencyKey)) throw new Error("记录校验或顺序无效");
          const commit = copyCommit(record.commit);
          if (record.perceptions.length !== (commit.perceptions?.length ?? 0)) throw new Error("感知记录数量不一致");
          record.perceptions.forEach((perception, index) => {
            const draft = commit.perceptions![index]!;
            const actor = Object.hasOwn(commit.actors ?? {}, perception.actorId) ? commit.actors![perception.actorId] : next.actors[perception.actorId];
            // Older journals did not record this fact on each perception. Do not
            // reconstruct it during replay or replace it with today's actor state.
            if (Object.hasOwn(perception, "consciousness") && (!validNarrativeConsciousness(perception.consciousness)
              || perception.consciousness !== actor?.consciousness)) throw new Error("感知意识状态与同笔角色事实不一致");
            const event = record.events.find(event => event.id === perception.eventId);
            const payload = event?.payload as { consciousness?: unknown } | undefined;
            if (payload?.consciousness !== perception.consciousness) throw new Error("感知事件意识状态与记录不一致");
            if (perception.actorId !== draft.actorId || perception.text !== draft.text || perception.worldSequence !== record.sequence ||
              perception.situation !== draft.situation || JSON.stringify(perception.opportunities) !== JSON.stringify(draft.opportunities) ||
              perception.phase !== commit.actionPhase ||
              perception.worldTime !== record.effectiveAt || perception.actionId !== commit.actionId || !perception.eventId ||
              !Array.isArray(perception.sourceEventIds) || perception.sourceEventIds.some(id => typeof id !== "string" || !id.trim())) throw new Error("感知记录无效");
          });
          next = applyCommit(next, commit, record.sequence, record.effectiveAt, record.perceptions);
          records.push(record); committed.set(commit.idempotencyKey, record);
        } catch (error) { throw new KernelError("CORRUPT_JOURNAL", `自然语言世界日志第 ${records.length + 1} 条记录损坏：${String(error)}`); }
      }
      if (validEnd < raw.length) {
        // Keep forensic data before removing an uncommitted crash tail. Never skip a damaged full row.
        await fs.writeFile(`${this.journalPath}.incomplete-${randomUUID()}`, raw.slice(validEnd), { flag: "wx" });
        const handle = await fs.open(this.journalPath, "r+");
        try { await handle.truncate(Buffer.byteLength(raw.slice(0, validEnd))); await handle.sync(); } finally { await handle.close(); }
      } else if (raw.length) {
        // A previous fsync error can leave a complete but unconfirmed row in the page cache.
        // Recovery confirms persistence before exposing that row as authoritative reality.
        const handle = await fs.open(this.journalPath, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      this.state = next; this.records = records; this.committed = committed; this.writeFault = undefined;
      if (records.length) await this.writeMirrors();
    });
  }
  async migrateLegacy(files: WorldFiles): Promise<void> {
    if (this.state.sequence || this.state.initialized) return;
    const [legacy, oldBot, oldWorld] = await Promise.all([readOptional(files.worldJournal), readOptional(files.botStatus), readOptional(files.worldStatus)]);
    if (!legacy.trim() && !oldBot.trim() && !oldWorld.trim()) return;
    await files.snapshot("before-narrative-migration");
    let worldState = oldWorld, actors: Record<string, NarrativeActor> = {}, actions: Record<string, NarrativeAction> = {};
    let importedAt = 0;
    if (legacy.trim()) {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-world-import-"));
      try {
        // The legacy replay repairs an incomplete tail. Only its private copy may be changed.
        await fs.writeFile(path.join(temp, "world-transactions.jsonl"), legacy);
        const kernel = await WorldKernel.open(temp, { now: this.now });
        const snapshot = kernel.snapshot();
        importedAt = snapshot.effectiveAt;
        const complete = legacy.slice(0, legacy.lastIndexOf("\n") + 1).split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as { type: string; envelopes: BusEnvelope[] });
        let lastReset = -1;
        for (let index = complete.length - 1; index >= 0; index--) if (complete[index]!.type === "reset") { lastReset = index; break; }
        const events = complete.slice(Math.max(0, lastReset)).flatMap(record => record.envelopes);
        // A failed first append is not a structured world. Keep the real Markdown world rather
        // than replacing it with an empty-kernel migration heading after discarding that tail.
        worldState = complete.length || Object.keys(snapshot.entities).length ? legacyWorldText(snapshot, events) : oldWorld;
        for (const entity of Object.values(snapshot.entities)) if (entity.kind === "actor" && (entity.id === "bot" || entity.controller === "player")) {
          const visible = await kernel.peek(entity.id);
          const history = legacyHistory(events, entity.id);
          actors[entity.id] = { id: entity.id, name: entity.name, controller: entity.id === "bot" ? "bot" : "player", present: entity.id === "bot" || entity.location !== null,
            state: legacyActorState(entity, snapshot), perception: [legacyPerception(visible), ...(history.length ? [`近期亲历（历史，不是当前状态）：\n\n${history.join("\n\n")}`] : [])].join("\n\n") };
        }
        if (!actors.bot && (oldBot.trim() || oldWorld.trim())) actors.bot = await legacyMarkdownActor(files, oldBot);
        for (const action of Object.values(snapshot.actions)) if (Object.hasOwn(actors, action.actorId)) {
          actions[action.id] = { id: action.id, actorId: action.actorId, intent: action.intent, status: action.status,
            startedAt: action.startedAt, expectedEnd: Math.max(action.startedAt, action.expectedEnd ?? action.startedAt),
            requestFingerprint: action.requestFingerprint ?? `legacy-without-fingerprint:${digest(action)}`,
            ...(action.finishedAt !== undefined ? { finishedAt: action.finishedAt } : {}), ...(action.reason !== undefined ? { reason: action.reason } : {}) };
        }
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    } else {
      actors.bot = await legacyMarkdownActor(files, oldBot);
    }
    if (!Object.keys(actors).length) return;
    await this.commit({ idempotencyKey: `migration:${digest({ legacy, oldBot, oldWorld })}`, expectedSequence: 0,
      source: "migration", initialized: true, worldState: worldState.trim() || "世界具体情境尚未记载，须结合定义与角色现状继续确立。", actors, actions }, { effectiveAt: importedAt });
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const promise = this.tail.then(fn, fn); this.tail = promise.catch(() => {}); return promise;
  }
  private async append(record: JournalRecord, options: CommitOptions): Promise<void> {
    const handle = await fs.open(this.journalPath, "a");
    let started = false;
    try {
      checkCancellation(options);
      started = true;
      await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync();
      if (process.platform !== "win32") {
        const directory = await fs.open(this.basePath, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) { if (started) this.writeFault = error; throw error; }
    finally {
      try { await handle.close(); }
      catch (error) { if (started) this.writeFault = error; throw error; }
    }
  }
  private async writeMirrors(): Promise<void> {
    try {
      await writeAtomic(path.join(this.basePath, "World_Status.md"), this.state.worldState);
      await writeAtomic(path.join(this.basePath, "Bot_Status.md"), this.state.actors.bot?.state ?? "");
    } catch (error) { try { this.options.onMirrorError?.(error); } catch { /* A display mirror cannot invalidate committed reality. */ } }
  }
}

function emptyState(): NarrativeSnapshot { return { schemaVersion: 1, mode: "narrative", initialized: false, sequence: 0, effectiveAt: 0, stateUpdatedAt: 0, stateSequence: 0, worldState: "", actors: {}, actions: {} }; }
function copyCommit(input: NarrativeCommit): NarrativeCommit {
  assertJson(input);
  if (!input || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256 || typeof input.source !== "string" || !input.source.trim()) throw new KernelError("INVALID_PROPOSAL", "世界更新需要有效请求标识和来源。");
  if (input.expectedSequence !== undefined && (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0)) throw new KernelError("INVALID_VERSION", "世界版本必须是非负整数。");
  if (input.worldState !== undefined && typeof input.worldState !== "string") throw new KernelError("INVALID_PROPOSAL", "世界状态必须是自然语言文本。");
  if (input.phoneState !== undefined && (!validPhonePhysicalState(input.phoneState)
    || !["initialize", "action", "observe", "evolve", "administrator", "phone_restore"].includes(input.source)
    || input.actorId !== undefined && input.actorId !== "bot")) throw new KernelError("INVALID_PHONE_STATE", "手机物理状态必须完整且有效，仅常驻角色的物理世界裁定或管理员可更新；访客和应用任务不能修改。");
  if (input.source === "phone_restore" && (input.actorId !== "bot" || !input.phoneState?.reachable || !input.phoneState.usable || !input.phoneState.perceptible
    || input.phoneState.location !== "持有者手中" || Object.keys(input).some(key => !["idempotencyKey", "source", "actorId", "phoneState"].includes(key)))) {
    throw new KernelError("INVALID_PHONE_RESTORATION", "手机恢复只能提交常驻角色手机回到手中且可用的事实，不能附带剧情、感知或其他状态修改。");
  }
  if (input.initialized !== undefined && typeof input.initialized !== "boolean") throw new KernelError("INVALID_PROPOSAL", "初始化状态必须为布尔值。");
  if (input.actionPhase !== undefined && (!input.actionId || !["start", "finish"].includes(input.actionPhase))) throw new KernelError("INVALID_ACTION", "行动感知阶段需要有效动作编号和start/finish。");
  if (input.toolReceipt !== undefined) {
    const receipt = input.toolReceipt;
    if (!receipt || typeof receipt.actorId !== "string" || !receipt.actorId.trim() || typeof receipt.text !== "string" || !receipt.text.trim() ||
        !["completed", "failed", "needs_input"].includes(receipt.status) || (receipt.reason !== undefined && typeof receipt.reason !== "string") ||
        "situation" in receipt || "opportunities" in receipt) throw new KernelError("INVALID_TOOL_RECEIPT", "应用回执需要角色、实际输出和明确执行结果，不能附加角色状态栏或剧情建议。");
  }
  for (const value of [input.actors, input.actions]) if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new KernelError("INVALID_PROPOSAL", "角色与行动更新必须按标识寻址。");
  for (const [id, actor] of Object.entries(input.actors ?? {})) {
    assertSafeKey(id);
    if (!actor || actor.id !== id || !actor.name?.trim() || !["bot", "player"].includes(actor.controller) || typeof actor.present !== "boolean" || typeof actor.state !== "string" || typeof actor.perception !== "string" || (actor.persona !== undefined && typeof actor.persona !== "string")
      || actor.consciousness !== undefined && !validNarrativeConsciousness(actor.consciousness)) throw new KernelError("INVALID_ACTOR", "角色身份、自然语言状态或意识状态无效。");
  }
  for (const [id, action] of Object.entries(input.actions ?? {})) {
    assertSafeKey(id);
    if (!action || action.id !== id || typeof action.actorId !== "string" || !action.intent?.trim() || !["pending", "completed", "needs_input", "failed", "cancelled"].includes(action.status) ||
        typeof action.requestFingerprint !== "string" || !Number.isFinite(action.startedAt) || action.startedAt < 0 || !Number.isFinite(action.expectedEnd) || action.expectedEnd < action.startedAt ||
        (action.phase !== undefined && (!(["accepted", "ongoing", "finished"] as string[]).includes(action.phase) || (action.status === "pending") !== (action.phase !== "finished"))) ||
        (action.finishedAt !== undefined && (!Number.isFinite(action.finishedAt) || action.finishedAt < action.startedAt))) throw new KernelError("INVALID_ACTION", "行动执行记录无效。");
  }
  if (input.perceptions !== undefined && !Array.isArray(input.perceptions)) throw new KernelError("INVALID_PROPOSAL", "感知必须是列表。");
  for (const perception of input.perceptions ?? []) if (!perception || typeof perception.actorId !== "string" || typeof perception.text !== "string" || !perception.text.trim() ||
    !validNarrativePresentation(perception) ||
    (perception.sourceEventIds !== undefined && (!Array.isArray(perception.sourceEventIds) || perception.sourceEventIds.some(id => typeof id !== "string" || !id.trim())))) throw new KernelError("INVALID_PERCEPTION", "角色感知必须包含有效文本和来源；可选状态栏最多1200字，行动建议最多4条且须有有效标题和意图。");
  if (["app_observe", "app_action"].includes(input.source) && input.perceptions?.some(p => p.situation !== undefined || p.opportunities !== undefined)) throw new KernelError("INVALID_PERCEPTION", "应用回执不能提供角色状态栏或剧情行动建议。");
  if (input.evolution !== undefined) {
    if (input.source !== "evolve" || input.actionId !== undefined || input.actionPhase !== undefined || input.actions !== undefined || input.initialized !== undefined || input.toolReceipt !== undefined || !validNarrativeEvolution(input.evolution)) throw new KernelError("INVALID_EVOLUTION", "外部演化需要本轮外部变化及有效来源，不能结算角色行动。");
    const effects = new Set(input.evolution.actorEffects.map(effect => effect.actorId));
    const recipients = new Set(input.evolution.perceptionSources.map(source => source.actorId));
    if (Object.keys(input.actors ?? {}).length !== effects.size || Object.keys(input.actors ?? {}).some(id => !effects.has(id)) ||
      (input.perceptions ?? []).length !== recipients.size || (input.perceptions ?? []).some(perception => !recipients.has(perception.actorId)) ||
      (input.phoneState !== undefined) !== (input.evolution.phoneChangeIds !== undefined) || !input.worldState?.trim()) throw new KernelError("INVALID_EVOLUTION", "角色影响、感知和手机物理变化须分别引用本轮外部原因，并同笔保存世界经过。");
  }
  return clone(input);
}
function applyCommit(base: NarrativeSnapshot, commit: NarrativeCommit, sequence: number, effectiveAt: number, perceptions: NarrativePerception[]): NarrativeSnapshot {
  if (commit.expectedSequence !== undefined && commit.expectedSequence !== base.sequence) throw new KernelError("VERSION_CONFLICT", `世界已更新：预期版本 ${commit.expectedSequence}，当前版本 ${base.sequence}。`);
  if (commit.evolution) for (const [id, actor] of Object.entries(commit.actors ?? {})) {
    const previous = base.actors[id];
    if (!previous?.present || JSON.stringify({ ...actor, state: previous.state, consciousness: previous.consciousness }) !== JSON.stringify(previous)) throw new KernelError("INVALID_EVOLUTION", "外部身体影响只能更新既有在场角色的客观状态和意识状态，不能改写身份、在场登记或感知记录。");
  }
  if (!Number.isFinite(effectiveAt) || effectiveAt < base.effectiveAt || sequence !== base.sequence + 1) throw new KernelError("INVALID_TIME", "世界更新顺序或时间无效。");
  const next = clone(base);
  next.sequence = sequence; next.effectiveAt = effectiveAt;
  const proseChanged = (commit.worldState !== undefined && commit.worldState !== base.worldState)
    || (commit.phoneState !== undefined && JSON.stringify(commit.phoneState) !== JSON.stringify(base.phoneState)) || Object.entries(commit.actors ?? {}).some(([id, actor]) => {
    const previous = Object.hasOwn(base.actors, id) ? base.actors[id] : undefined;
    return !previous || previous.state !== actor.state || previous.present !== actor.present || previous.consciousness !== actor.consciousness;
  });
  if (proseChanged) { next.stateUpdatedAt = effectiveAt; next.stateSequence = sequence; }
  if (commit.initialized !== undefined) next.initialized = commit.initialized;
  if (commit.worldState !== undefined) next.worldState = commit.worldState;
  if (commit.phoneState !== undefined) next.phoneState = clone(commit.phoneState);
  if (commit.source === "phone_restore") {
    if (!base.initialized) throw new KernelError("WORLD_NOT_INITIALIZED", "世界尚未创建，不能恢复手机。");
    next.phoneAccessRestoration = { sequence, worldTime: effectiveAt };
  }
  for (const [id, actor] of Object.entries(commit.actors ?? {})) next.actors[id] = clone(actor);
  if (commit.phoneState !== undefined && !next.actors.bot?.present) throw new KernelError("INVALID_PHONE_STATE", "常驻角色不在本世界时不能裁定其手机物理状态。");
  if (commit.toolReceipt && !Object.hasOwn(next.actors, commit.toolReceipt.actorId)) throw new KernelError("MISSING_ACTOR", "应用操作角色不存在。");
  for (const [id, action] of Object.entries(commit.actions ?? {})) {
    if (!Object.hasOwn(next.actors, action.actorId)) throw new KernelError("MISSING_ACTOR", "行动角色不存在。");
    next.actions[id] = clone(action);
  }
  if (next.initialized && (!Object.hasOwn(next.actors, "bot") || !next.worldState.trim())) throw new KernelError("INVALID_WORLD", "初始化世界需要常驻 Bot 和自然语言世界状态。");
  for (const perception of perceptions) {
    if (!Object.hasOwn(next.actors, perception.actorId)) throw new KernelError("MISSING_ACTOR", "感知接收角色不存在。");
    next.actors[perception.actorId]!.perception = perception.text;
  }
  return next;
}
function checkCancellation(options: CommitOptions): void {
  if (options.signal?.aborted || options.beforeCommit?.() === false) throw new KernelError("CANCELLED", "世界更新已在提交前取消。");
}
function result(record: JournalRecord, duplicate: boolean): NarrativeCommitResult {
  return clone({ transactionId: record.transactionId, sequence: record.sequence, duplicate, perceptions: record.perceptions, events: record.events,
    ...(record.commit.toolReceipt ? { toolReceipt: record.commit.toolReceipt } : {}) });
}
async function readOptional(file: string): Promise<string> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
async function writeAtomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { flag: "wx" }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function legacyMarkdownActor(files: WorldFiles, state: string): Promise<NarrativeActor> {
  const meta = await files.readMeta();
  const known = state.trim() || "当前身体状态与可感知情境尚未记载，请通过观察了解。";
  return { id: "bot", name: meta.botName?.trim() || "Bot", controller: "bot", present: true, state: known, perception: known };
}

/** Migration preserves data verbatim in an archive; this renders the current facts for the model. */
function legacyWorldText(snapshot: WorldSnapshot, events: BusEnvelope[]): string {
  const sections = [`# 当前世界\n\n从旧结构化存档迁移。下列现状成立于世界时间 ${snapshot.effectiveAt}；历史经过单列，不能用旧经过覆盖现状。`];
  const name = (id: string | null | undefined): string => id ? snapshot.entities[id]?.name ?? id : "未记载";
  for (const entity of Object.values(snapshot.entities)) {
    const facts = [entity.location ? `所在位置：${name(entity.location)}。` : "没有记录所属位置。"];
    if (entity.owner) facts.push(`持有人：${name(entity.owner)}。`);
    for (const [key, attribute] of Object.entries(entity.attributes)) {
      const scope = attribute.visibility === "hidden" ? "世界私密事实，不能直接向角色透露" : attribute.visibility === "owner" ? "持有人或本人私有" : "公开属性，仍须符合感知条件";
      facts.push(`${key}（${scope}）：${valueText(attribute.value)}`);
    }
    sections.push(`## ${entity.kind === "actor" ? "角色" : entity.kind === "place" ? "地点" : "物件"}：${entity.name}\n\n${facts.join("\n\n")}`);
  }
  const actions = Object.values(snapshot.actions), renderAction = (action: WorldSnapshot["actions"][string]) => {
    const status = action.status === "pending" ? "进程已中断，意图尚未完成，不能视为行动结果" : ({ completed: "当时已完成", failed: "当时未完成", cancelled: "当时已取消", needs_input: "当时停在决定点；是否已继续须以当前状态为准" } as const)[action.status];
    return `${name(action.actorId)}在时间 ${action.startedAt} 的意图：${action.intent}。记录状态：${status}。${action.reason ? `原裁定记录：${action.reason}` : ""}`;
  };
  const pending = actions.filter(action => action.status === "pending");
  if (pending.length) sections.push(`## 尚未确认完成的旧行动\n\n原进程已经中断，下列意图不能视为仍在后台执行或已经成功。\n\n${pending.map(renderAction).join("\n\n")}`);
  const chronological = (a: WorldSnapshot["actions"][string], b: WorldSnapshot["actions"][string]) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt);
  const decisions = actions.filter(action => action.status === "needs_input").sort(chronological).slice(-24);
  const terminal = actions.filter(action => action.status !== "pending" && action.status !== "needs_input").sort(chronological).slice(-24);
  const recentActions = [...decisions, ...terminal].sort(chronological).map(renderAction);
  if (recentActions.length) sections.push(`## 近期行动记录（历史）\n\n这些是当时的裁定，不表示现在仍待执行，也不是新的行动请求。\n\n${boundedHistory(recentActions.map(text => ({ text, actors: [] })), 48, 12_000, actions.length - pending.length).join("\n\n")}`);
  const history = legacyHistory(events);
  if (history.length) sections.push(`## 已发生的近期经过与对话\n\n以下是带时间的历史证据；没有明确结束的交谈仍需结合当前状态承接。\n\n${history.join("\n\n")}`);
  return sections.join("\n\n");
}

function legacyHistory(events: BusEnvelope[], actorId?: string): string[] {
  const seen = new Set<string>(), lines: { text: string; actors: string[] }[] = [];
  for (const event of events) {
    if (event.topic === "world.speech") {
      const speech = event.payload as { speakerName?: unknown; text?: unknown; audience?: unknown };
      if (typeof speech.text !== "string" || (actorId && (!Array.isArray(speech.audience) || !speech.audience.includes(actorId)))) continue;
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      lines.push({ text: `时间 ${event.effectiveAt}，${typeof speech.speakerName === "string" ? speech.speakerName : "一位角色"}说：“${speech.text}”${actorId ? "" : `（当时的听众：${Array.isArray(speech.audience) ? speech.audience.join("、") : "未记录"}）`}`,
        actors: actorId ? [actorId] : Array.isArray(speech.audience) ? speech.audience.filter((id): id is string => typeof id === "string") : [] });
    } else if (event.topic === "world.committed") {
      const payload = event.payload as { experiences?: Record<string, { experience?: { eventId?: string; text?: string; kind?: string } }[]> };
      const audiences = actorId ? [actorId] : Object.keys(payload.experiences ?? {});
      for (const audience of audiences) {
        const entries = payload.experiences && Object.hasOwn(payload.experiences, audience) ? payload.experiences[audience] : undefined;
        if (!Array.isArray(entries)) continue;
        for (const { experience } of entries) {
          if (!experience?.eventId || !experience.text || experience.kind === "speech" || seen.has(experience.eventId)) continue;
          seen.add(experience.eventId);
          lines.push({ text: `时间 ${event.effectiveAt}${actorId ? "" : `，${audience}当时感知到`}：${experience.text}`, actors: [audience] });
        }
      }
    }
  }
  return boundedHistory(lines, actorId ? 16 : 64, actorId ? 8_000 : 32_000);
}

/** Keep complete recent events, never a clipped sentence that could change the recorded facts. */
function boundedHistory(lines: { text: string; actors: string[] }[], perActor: number, budget: number, total = lines.length): string[] {
  const counts = new Map<string, number>(), chosen: string[] = [];
  let remaining = Math.max(0, budget - 256);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!, audiences = line.actors.length ? line.actors : ["unaddressed"];
    if (!audiences.some(actor => (counts.get(actor) ?? 0) < perActor)) continue;
    for (const actor of audiences) counts.set(actor, (counts.get(actor) ?? 0) + 1);
    if (line.text.length > 4_000 || line.text.length + 2 > remaining) continue;
    chosen.push(line.text); remaining -= line.text.length + 2;
  }
  chosen.reverse();
  if (total > chosen.length) chosen.unshift(`另有 ${total - chosen.length} 条较早或过长的历史未放入当前上下文，完整原文保留在旧世界日志与迁移备份中。此处没有截断或补写历史原话。`);
  return chosen;
}

/** The old kernel is used only to enforce the original actor visibility during import. */
function legacyPerception(observation: WorldObservation): string {
  const names = new Map(observation.entities.map(entity => [entity.observedId, entity.name]));
  return observation.entities.map(entity => {
    const facts = [`${entity.self ? "你" : entity.name}${entity.locationObservedId && names.has(entity.locationObservedId) ? `位于${names.get(entity.locationObservedId)}` : "在当前可感知范围内"}。`];
    if (entity.ownerObservedId && names.has(entity.ownerObservedId)) facts.push(`持有人：${names.get(entity.ownerObservedId)}。`);
    for (const [key, value] of Object.entries(entity.attributes)) facts.push(`${key}：${valueText(value)}`);
    return facts.join("\n");
  }).join("\n\n");
}

function legacyActorState(entity: WorldEntity, snapshot: WorldSnapshot): string {
  const lines = [`你是${entity.name}。`, entity.location ? `当前位于${snapshot.entities[entity.location]?.name ?? entity.location}。` : "当前位置尚未记载。"];
  for (const [key, attribute] of Object.entries(entity.attributes)) if (attribute.visibility !== "hidden") lines.push(`${key}：${valueText(attribute.value)}`);
  return lines.join("\n\n");
}

function valueText(value: JsonValue): string {
  if (value === null) return "空值（原存档未提供内容）";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item, index) => `${index + 1}. ${valueText(item)}`).join("\n") : "空列表";
  return Object.entries(value).map(([key, item]) => `${key}：${valueText(item)}`).join("\n") || "空记录";
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
