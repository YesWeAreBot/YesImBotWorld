import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BotEvent, ExperienceMetadata, StreamEntry } from "../types.js";
import { richPartsText } from "../media/presentation.js";
import { appendJsonLine } from "../jsonl.js";
import { projectObservedMessages } from "./perception-fragments.js";
import { narrativeFactText } from "./narrative-facts.js";
import { actionContains, chatEvidence, deriveGrowthScope, growthMatchesScope, growthNeedsReview, matchingBehavior, stateBasis, type GrowthMessageEvidence, type GrowthScope } from "./growth-grounding.js";
import { selectLongitudinalEvidence } from "./growth-longitudinal.js";
import { validateGrowthInsight, type GrowthInsight } from "./growth-semantics.js";

export type GrowthKind = "relationship" | "commitment" | "preference" | "state" | "habit" | "trait";
export type ReflectionRelation = "support" | "counter" | "revise" | "retire";

/** Only a projection actually delivered to this actor may enter the evidence registry. */
export interface PerceivedEvidence {
  eventId: string;
  actorId: string;
  source: BotEvent["source"];
  observedAt: number;
  text: string;
  /** Stable original causes; rereading or summarizing them is not new evidence. */
  rootEventIds: string[];
  experience?: ExperienceMetadata;
  /** Renderer-owned message boundaries; no splitting a user's message by textual delimiters. */
  messages?: GrowthMessageEvidence[];
}

export interface GrowthRecord {
  id: string;
  claimId: string;
  actorId: string;
  kind: GrowthKind;
  subject: string;
  statement: string;
  relation: ReflectionRelation;
  previousId?: string;
  evidenceIds: string[];
  rootEventIds: string[];
  recordedAt: number;
  origin?: "automatic" | "manual";
  situation?: string;
  cues?: string[];
  subjectId?: string;
  expiresAt?: number;
  /** Program-derived timing, never supplied by a reflection proposal. */
  stateTiming?: { evidenceAt: number; secondsPerTU: number; requestedExpiresAt?: number };
  scope?: GrowthScope;
  groundingVersion?: 1;
  behavior?: string;
  insight?: GrowthInsight;
  semanticVersion?: 1;
}

export interface GrowthView {
  claimId: string;
  kind: GrowthKind;
  subject: string;
  statement: string;
  /** No automatic promotion from evidence count to a permanent personality trait. */
  status: "tentative" | "contested";
  active: boolean;
  inactiveReason?: "expired" | "retired" | "corrected";
  situation?: string;
  cues?: string[];
  subjectId?: string;
  expiresAt?: number;
  stateTimingCorrection?: StateTimingCorrection;
  correction?: GrowthCorrection;
  needsReview?: boolean;
  isolationReason?: string;
  scope?: GrowthScope;
  behavior?: string;
  insight?: GrowthInsight;
  records: GrowthRecord[];
  evidence: PerceivedEvidence[];
}

export interface ReflectionInput {
  kind: GrowthKind;
  subject: string;
  statement: string;
  evidenceIds: string[];
  relation?: ReflectionRelation;
  claimId?: string;
  situation?: string;
  cues?: string[];
  subjectId?: string;
  expiresAt?: number;
  behavior?: string;
  insight?: GrowthInsight;
}

export interface GrowthPageQuery {
  kind?: GrowthKind | "long_term" | "all";
  keyword?: string;
  lifecycle?: "active" | "inactive" | "all";
  offset?: number;
  limit?: number;
  at?: number;
}
export interface GrowthPage {
  items: GrowthView[];
  total: number;
  offset: number;
  limit: number;
  counts: Record<GrowthKind, number>;
}

export interface GrowthReviewSnapshot {
  id: string;
  actorId: string;
  afterCursor: number;
  throughCursor: number;
  /** Reject results based on a concurrently revised set of beliefs. */
  revision: number;
  createdAt: number;
  episodeIds: string[];
  /** All delivered events in the consumed prefix; evidence below is a bounded representative sample. */
  coveredEventCount: number;
  omittedEvidenceCount: number;
  evidence: PerceivedEvidence[];
  claims: GrowthView[];
  /** A deferred interval has its own cursor; it must never move the current-experience cursor. */
  backlogId?: string;
  reviewEventIds?: string[];
  /** Reassess the original sources of legacy claims without inventing a new experience. */
  revalidation?: { claimId: string; recordId: string }[];
}

export interface GrowthReviewRejection { index: number; reason: string }
export interface GrowthReviewResult {
  id: string;
  at: number;
  records: GrowthRecord[];
  views: GrowthView[];
  duplicate: boolean;
  rejected?: GrowthReviewRejection[];
}

interface ReviewCommit {
  type: "review_committed";
  actorId: string;
  id: string;
  afterCursor: number;
  throughCursor: number;
  at: number;
  records: GrowthRecord[];
  backlogId?: string;
  rejected?: GrowthReviewRejection[];
  sampledEventIds?: string[];
  relatedEventIds?: string[];
  omittedEvidenceCount?: number;
  revalidation?: { claimId: string; recordId: string }[];
}

interface ReviewDeferred {
  type: "review_deferred";
  actorId: string;
  id: string;
  afterCursor: number;
  throughCursor: number;
  at: number;
  firstEventId: string;
  lastEventId: string;
  reason: string;
}
interface ReviewFailure {
  type: "review_failed";
  actorId: string;
  at: number;
  realAt: number;
  reason: string;
  reviewId?: string;
}
export interface StateTimingCorrection {
  type: "state_timing_corrected";
  id: string;
  actorId: string;
  claimId: string;
  recordId: string;
  subject: string;
  at: number;
  recordedAt: number;
  evidenceAt: number;
  evidenceIds: string[];
  secondsPerTU: number;
  previousExpiresAt: number;
  expiresAt: number;
  reason: string;
}
/** Audited withdrawal of a demonstrably unsupported inference; never a fictional new experience. */
export interface GrowthCorrection {
  type: "growth_corrected";
  id: string;
  actorId: string;
  claimId: string;
  recordId: string;
  subject: string;
  statement: string;
  at: number;
  evidenceIds: string[];
  reason: string;
}
export interface GrowthIsolation {
  type: "growth_isolated";
  id: string;
  actorId: string;
  at: number;
  claims: { claimId: string; recordId: string; subject: string; statement: string; reason: string }[];
}
interface ReviewBacklog extends ReviewDeferred { cursor: number }
interface ReviewOptions { at: number; minimumEpisodes?: number; maxEpisodes?: number; maxEvidence?: number; secondsPerTU?: number }

interface ReviewRun {
  start: number;
  end: number;
  episodeIds: string[];
  maxObservedAt: number;
  samples: Partial<Record<"first" | "last" | "failed" | "imposed" | "choice", number>>;
}

export interface ReflectionOpportunity {
  afterRootCount: number;
  /** A stable checkpoint, so a restart does not repeat the same reminder. */
  rootCount: number;
  eventIds: string[];
}

type LedgerLine = { type: "perceived"; evidence: PerceivedEvidence } | { type: "reflection"; record: GrowthRecord }
  | { type: "review_offered"; actorId: string; rootCount: number }
  | ReviewCommit | ReviewDeferred | ReviewFailure | StateTimingCorrection | GrowthCorrection | GrowthIsolation
  | { type: "review_acknowledged" | "state_timing_acknowledged" | "growth_correction_acknowledged" | "growth_isolation_acknowledged"; actorId: string; id: string };

/** Append-only subjective growth. This class deliberately has no access to the world event store. */
export class GrowthLedger {
  readonly file: string;
  private evidence = new Map<string, PerceivedEvidence>();
  private records: GrowthRecord[] = [];
  private roots = new Set<string>();
  private reviewedRootCount = 0;
  private reviewCursor = 0;
  private reviewItems: { eventId: string; episodeIds: string[] }[] = [];
  private reviewRuns: ReviewRun[] = [];
  private reviewIndex = new Map<string, number>();
  private reviews = new Map<string, ReviewCommit>();
  private reviewBacklogs = new Map<string, ReviewBacklog>();
  private reviewFailures: ReviewFailure[] = [];
  private reviewFailureCount = 0;
  private lastReviewOutcome?: "completed" | "failed";
  private stateTimingCorrections = new Map<string, StateTimingCorrection>();
  private claimCorrections = new Map<string, GrowthCorrection>();
  private isolations = new Map<string, GrowthIsolation>();
  private acknowledged = new Set<string>();
  private loaded: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(base: string, readonly actorId = "bot") {
    this.file = path.join(base, "growth.jsonl");
  }

  private async load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        let raw: string;
        try { raw = await fs.readFile(this.file, "utf8"); }
        catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let item: LedgerLine;
          try { item = JSON.parse(line); } catch { continue; } // tolerate an interrupted final append
          if (item.type === "perceived" && item.evidence?.actorId === this.actorId) {
            this.acceptEvidence(item.evidence);
          } else if (item.type === "reflection" && item.record?.actorId === this.actorId) {
            this.records.push(item.record);
          } else if (item.type === "review_offered" && item.actorId === this.actorId && Number.isSafeInteger(item.rootCount)) {
            this.reviewedRootCount = Math.max(this.reviewedRootCount, item.rootCount);
          } else if (item.type === "review_committed" && item.actorId === this.actorId && !this.reviews.has(item.id)) {
            this.records.push(...item.records);
            this.reviews.set(item.id, item);
            this.lastReviewOutcome = "completed";
            if (item.backlogId) {
              const backlog = this.reviewBacklogs.get(item.backlogId);
              if (backlog) backlog.cursor = Math.max(backlog.cursor, item.throughCursor);
            } else this.reviewCursor = Math.max(this.reviewCursor, item.throughCursor);
          } else if (item.type === "review_deferred" && item.actorId === this.actorId && !this.reviewBacklogs.has(item.id)) {
            this.reviewBacklogs.set(item.id, { ...item, cursor: item.afterCursor });
            this.reviewCursor = Math.max(this.reviewCursor, item.throughCursor);
          } else if (item.type === "review_failed" && item.actorId === this.actorId) {
            this.acceptReviewFailure(item);
          } else if (item.type === "state_timing_corrected" && item.actorId === this.actorId) {
            this.stateTimingCorrections.set(item.recordId, item);
          } else if (item.type === "growth_corrected" && item.actorId === this.actorId) {
            this.claimCorrections.set(item.recordId, item);
          } else if (item.type === "growth_isolated" && item.actorId === this.actorId) {
            this.isolations.set(item.id, item);
          } else if ((item.type === "review_acknowledged" || item.type === "state_timing_acknowledged" || item.type === "growth_correction_acknowledged" || item.type === "growth_isolation_acknowledged") && item.actorId === this.actorId) {
            this.acknowledged.add(item.id);
          }
        }
      })();
    }
    await this.loaded;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => { await this.load(); return run(); });
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  private async append(item: LedgerLine): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await appendJsonLine(this.file, item);
  }

  async perceive(event: BotEvent, rootEventIds: string[] = event.originEventIds ?? [event.id], metadata?: ExperienceMetadata): Promise<void> {
    return this.serial(() => this.perceiveUnlocked(event, rootEventIds, metadata ?? event.experience));
  }

  private acceptEvidence(evidence: PerceivedEvidence): void {
    if (evidence.experience?.internalThought === true || this.evidence.has(evidence.eventId)) return;
    const fresh = evidence.rootEventIds.filter(id => !this.roots.has(id));
    this.evidence.set(evidence.eventId, evidence);
    evidence.rootEventIds.forEach(id => this.roots.add(id));
    if (fresh.length) {
      const episodeIds = evidence.experience?.episodeId ? [evidence.experience.episodeId] : fresh;
      const index = this.reviewItems.length;
      this.reviewItems.push({ eventId: evidence.eventId, episodeIds });
      this.reviewIndex.set(evidence.eventId, index);
      let run = this.reviewRuns.at(-1);
      if (!run || !sameStrings(run.episodeIds, episodeIds)) {
        run = { start: index, end: index + 1, episodeIds, maxObservedAt: evidence.observedAt, samples: { first: index } };
        this.reviewRuns.push(run);
      }
      run.end = index + 1;
      run.maxObservedAt = Math.max(run.maxObservedAt, evidence.observedAt);
      run.samples.last = index;
      if (evidence.experience?.outcome === "failed") run.samples.failed = index;
      if (evidence.experience?.agency === "imposed") run.samples.imposed = index;
      if (evidence.experience?.agency === "self" && evidence.experience.outcome === "completed" && evidence.experience.opportunity === true) {
        run.samples.choice = index;
      }
    }
  }

  private async perceiveUnlocked(event: BotEvent, rootEventIds: string[], metadata?: ExperienceMetadata): Promise<void> {
    if (event.source === "system" || event.experience?.internalThought === true || metadata?.internalThought === true || this.evidence.has(event.id)) return;
    const roots = [...new Set(rootEventIds.filter((id) => typeof id === "string" && id.trim()))];
    if (!roots.length) return; // derived memory/tool output cannot manufacture a fresh experience
    // `event` is the delivered receipt passed by the append boundary; projection validates
    // renderer-owned part indexes and their parent roots, never parses body delimiters.
    const projected = event.parts?.some(part => part.observedMessage) ? projectObservedMessages(event.id, [{ kind: "event", event }]) : null;
    const messages = projected?.flatMap(part => part.experience?.chat?.kind === "message"
      ? [{ text: part.content, rootEventIds: part.originEventIds!, chat: part.experience.chat }] : []);
    const evidence: PerceivedEvidence = {
      eventId: event.id, actorId: this.actorId, source: event.source,
      observedAt: event.worldTime, text: event.parts?.length ? richPartsText(event.parts) : narrativeFactText(event), rootEventIds: roots,
      ...(metadata ? { experience: normalizeMetadata(metadata) } : {}),
      ...(messages?.length ? { messages } : {}),
    };
    await this.append({ type: "perceived", evidence });
    this.acceptEvidence(evidence);
  }

  /** Repair a crash between durable context delivery and the evidence append. Never read world history. */
  async restorePerceptions(entries: readonly StreamEntry[]): Promise<void> {
    return this.serial(async () => {
      const derivedCalls = new Set(entries.flatMap(entry => entry.kind === "tool_call" &&
        ["think", "reflect", "recall_growth", "recall"].includes(entry.call.name) ? [entry.call.id] : []));
      for (const entry of entries) {
        if (entry.kind !== "event") continue;
        const event = entry.event;
        await this.perceiveUnlocked(event, event.refToolCallId && derivedCalls.has(event.refToolCallId)
          ? [] : event.originEventIds ?? [event.id], event.experience);
      }
    });
  }

  /** These are original delivered experiences, including ones no longer in the working context. */
  async recallEvidence(query: { eventIds?: string[]; source?: BotEvent["source"]; keyword?: string; n?: number } = {}): Promise<PerceivedEvidence[]> {
    return this.serial(async () => {
      const keyword = query.keyword?.trim().toLowerCase();
      const ids = query.eventIds ? new Set(query.eventIds) : null;
      const n = Math.max(1, Math.min(50, Math.floor(query.n ?? 10)));
      return structuredClone([...this.evidence.values()].reverse().filter(e =>
        (!ids || ids.has(e.eventId)) && (!query.source || query.source === e.source) &&
        (!keyword || e.text.toLowerCase().includes(keyword)),
      ).slice(0, n));
    });
  }

  async stats(): Promise<{ perceivedEvents: number; uniqueRoots: number; claims: number; records: number }> {
    return this.serial(async () => ({
      perceivedEvents: this.evidence.size, uniqueRoots: this.roots.size,
      claims: new Set(this.records.map(record => record.claimId)).size, records: this.records.length,
    }));
  }

  /** Move a large old prefix to an explicit, durable background queue, never pretend it was read. */
  async prioritizeRecent(options: { at: number; since: number; minimumBacklog?: number }): Promise<void> {
    return this.serial(async () => {
      finiteTime(options.at, "at"); finiteTime(options.since, "since");
      let throughCursor = this.reviewCursor;
      while (throughCursor < this.reviewItems.length) {
        const evidence = this.evidence.get(this.reviewItems[throughCursor]!.eventId)!;
        if (evidence.observedAt >= options.since) break;
        throughCursor++;
      }
      if (throughCursor - this.reviewCursor < boundedInteger(options.minimumBacklog, 128, 24, 100_000) || throughCursor === this.reviewItems.length) return;
      const deferred: ReviewDeferred = { type: "review_deferred", actorId: this.actorId, id: `growth_backlog_${randomUUID()}`,
        afterCursor: this.reviewCursor, throughCursor, at: options.at,
        firstEventId: this.reviewItems[this.reviewCursor]!.eventId, lastEventId: this.reviewItems[throughCursor - 1]!.eventId,
        reason: "较早积压转入历史补审队列，尚未逐条审阅；优先整理近期经历，原始证据保留并可检索。" };
      await this.append(deferred);
      this.reviewBacklogs.set(deferred.id, { ...deferred, cursor: deferred.afterCursor });
      this.reviewCursor = throughCursor;
    });
  }

  async reviewStatus(): Promise<{ pending: number; deferred: number; reviews: number; rejected: number; recent: ReviewCommit[]; backlogs: ReviewBacklog[];
    failures: number; lastOutcome?: "completed" | "failed"; lastFailure?: ReviewFailure; recentFailures: ReviewFailure[];
    timingCorrections: number; recentTimingCorrections: StateTimingCorrection[];
    corrections: number; recentCorrections: GrowthCorrection[]; isolations: number; recentIsolations: GrowthIsolation[] }> {
    return this.serial(async () => structuredClone({ pending: this.reviewItems.length - this.reviewCursor,
      deferred: [...this.reviewBacklogs.values()].reduce((sum, item) => sum + item.throughCursor - item.cursor, 0),
      reviews: this.reviews.size, rejected: [...this.reviews.values()].reduce((sum, item) => sum + (item.rejected?.length ?? 0), 0),
      recent: [...this.reviews.values()].slice(-8).reverse(), backlogs: [...this.reviewBacklogs.values()],
      failures: this.reviewFailureCount, lastOutcome: this.lastReviewOutcome,
      lastFailure: this.reviewFailures[0], recentFailures: this.reviewFailures,
      timingCorrections: this.stateTimingCorrections.size, recentTimingCorrections: [...this.stateTimingCorrections.values()].slice(-8).reverse(),
      corrections: this.claimCorrections.size, recentCorrections: [...this.claimCorrections.values()].slice(-8).reverse(),
      isolations: this.isolations.size, recentIsolations: [...this.isolations.values()].slice(-8).reverse() }));
  }

  /** Repair only a demonstrably stale legacy automatic state; retain the original record and its evidence. */
  async correctStaleAutomaticStates(options: { at: number; secondsPerTU: number }): Promise<StateTimingCorrection[]> {
    return this.serial(async () => {
      const at = finiteTime(options.at, "at");
      const unit = Number.isFinite(options.secondsPerTU) && options.secondsPerTU > 0 ? options.secondsPerTU : 1;
      const latest = new Map<string, GrowthRecord>();
      for (const record of this.records) if (record.relation !== "counter") latest.set(record.claimId, record);
      const corrected: StateTimingCorrection[] = [];
      for (const record of latest.values()) {
        if (record.kind !== "state" || record.origin !== "automatic" || record.relation === "retire" || record.stateTiming ||
          this.stateTimingCorrections.has(record.id) || record.recordedAt > at || record.expiresAt === undefined || record.expiresAt <= record.recordedAt) continue;
        const evidence = record.evidenceIds.map(id => this.evidence.get(id));
        if (!evidence.length || evidence.some(item => !item || !Number.isFinite(item.observedAt) || item.observedAt > record.recordedAt)) continue;
        const evidenceAt = Math.max(...evidence.map(item => item!.observedAt));
        const expiresAt = evidenceAt + 7200 / unit;
        if (expiresAt > record.recordedAt) continue;
        const correction: StateTimingCorrection = { type: "state_timing_corrected", id: `growth_state_timing_${record.id}`,
          actorId: this.actorId, claimId: record.claimId, recordId: record.id, subject: record.subject, at,
          recordedAt: record.recordedAt, evidenceAt, evidenceIds: [...record.evidenceIds], secondsPerTU: unit,
          previousExpiresAt: record.expiresAt, expiresAt,
          reason: "旧版自动回顾把两世界小时以前的经历记成了当前临时状态；有效期更正为支持证据时刻加两小时。原记录保留，此为程序时间校正，不是新经历或新的成长。" };
        await this.append(correction);
        this.stateTimingCorrections.set(record.id, correction);
        corrected.push(correction);
      }
      return structuredClone(corrected);
    });
  }

  async pendingStateTimingCorrections(n = 50): Promise<StateTimingCorrection[]> {
    return this.serial(async () => structuredClone([...this.stateTimingCorrections.values()]
      .filter(item => !this.acknowledged.has(item.id)).slice(0, boundedInteger(n, 50, 1, 50))));
  }

  async ackStateTimingCorrection(id: string): Promise<void> {
    return this.serial(async () => {
      if (this.acknowledged.has(id)) return;
      if (![...this.stateTimingCorrections.values()].some(item => item.id === id)) throw new Error(`找不到状态时间校正 ${id}`);
      await this.append({ type: "state_timing_acknowledged", actorId: this.actorId, id });
      this.acknowledged.add(id);
    });
  }

  /** Explicit evidence audit: withdraw this exact current inference without changing its history. */
  async correctClaim(input: { claimId: string; expectedRecordId: string; evidenceIds: string[]; reason: string; at: number }): Promise<GrowthCorrection> {
    return this.serial(async () => {
      const at = finiteTime(input.at, "at"), reason = requiredText(input.reason, "reason", 1200);
      const previous = this.claimCorrections.get(input.expectedRecordId);
      if (previous) {
        if (previous.claimId !== input.claimId) throw new Error("更正记录与认识不对应");
        return structuredClone(previous);
      }
      const view = this.view(input.claimId, at);
      const current = view && [...view.records].reverse().find(record => record.relation !== "counter");
      if (!current || current.id !== input.expectedRecordId) throw new Error("待更正认识已变化；请重新核对当前记录，不能撤回未审阅的新判断");
      if (current.relation === "retire") throw new Error("此认识已停止适用，无需重复撤回");
      if (at < current.recordedAt) throw new Error("更正时刻不能早于被更正记录");
      const evidenceIds = stringList(input.evidenceIds, "evidenceIds", 20, 300);
      if (!evidenceIds.length || evidenceIds.some(id => !this.evidence.has(id) || this.evidence.get(id)!.observedAt > at)) throw new Error("更正须引用实际已交付、可审计的原始证据");
      const supportingIds = new Set(view!.records.flatMap(record => record.evidenceIds));
      if (!evidenceIds.some(id => supportingIds.has(id))) throw new Error("更正须核对至少一条该认识曾引用的证据，不能凭无关材料撤回认识");
      const correction: GrowthCorrection = { type: "growth_corrected", id: `growth_correction_${current.id}`, actorId: this.actorId,
        claimId: current.claimId, recordId: current.id, subject: current.subject, statement: current.statement, at, evidenceIds, reason };
      await this.append(correction); this.claimCorrections.set(current.id, correction);
      return structuredClone(correction);
    });
  }

  async pendingCorrections(n = 50): Promise<GrowthCorrection[]> {
    return this.serial(async () => structuredClone([...this.claimCorrections.values()].filter(item => !this.acknowledged.has(item.id))
      .slice(0, boundedInteger(n, 50, 1, 50))));
  }

  async ackCorrection(id: string): Promise<void> {
    return this.serial(async () => {
      if (this.acknowledged.has(id)) return;
      if (![...this.claimCorrections.values()].some(item => item.id === id)) throw new Error(`找不到认识更正 ${id}`);
      await this.append({ type: "growth_correction_acknowledged", actorId: this.actorId, id }); this.acknowledged.add(id);
    });
  }

  /** Old ungrounded inferences are uncertain, not automatically false. Explain their quarantine once. */
  async isolateUnverifiedClaims(at: number): Promise<void> {
    return this.serial(async () => {
      finiteTime(at, "at");
      const seen = new Set([...this.isolations.values()].flatMap(item => item.claims.map(claim => claim.recordId)));
      const claims = [...new Set(this.records.map(record => record.claimId))].map(id => this.view(id, at)!)
        .filter(view => view.needsReview && view.inactiveReason !== "retired" && view.inactiveReason !== "corrected")
        .flatMap(view => {
          const record = [...view.records].reverse().find(item => item.relation !== "counter")!;
          return seen.has(record.id) ? [] : [{ claimId: view.claimId, recordId: record.id, subject: view.subject, statement: view.statement,
            reason: view.isolationReason ?? (view.kind === "habit" || view.kind === "trait" ? "旧倾向缺少可核验的共同自主动作与跨日依据；重复次数本身不证明稳定人格"
              : "旧聊天认识缺少可核验的发送者或频道范围；不能按名字、当前界面或通知补猜归属") }];
        });
      // Bounded batches keep both durable audit and appended clarification readable.
      for (let offset = 0; offset < claims.length; offset += 8) {
        const batch = claims.slice(offset, offset + 8);
        const id = "growth_isolation_" + createHash("sha256").update(JSON.stringify(batch.map(item => item.recordId))).digest("hex").slice(0, 24);
        const isolation: GrowthIsolation = { type: "growth_isolated", id, actorId: this.actorId, at, claims: batch };
        await this.append(isolation); this.isolations.set(id, isolation);
      }
    });
  }

  async pendingIsolations(n = 1): Promise<GrowthIsolation[]> {
    return this.serial(async () => structuredClone([...this.isolations.values()].filter(item => !this.acknowledged.has(item.id))
      .slice(0, boundedInteger(n, 1, 1, 8))));
  }

  async ackIsolation(id: string): Promise<void> {
    return this.serial(async () => {
      if (this.acknowledged.has(id)) return;
      if (!this.isolations.has(id)) throw new Error(`找不到认识隔离记录 ${id}`);
      await this.append({ type: "growth_isolation_acknowledged", actorId: this.actorId, id }); this.acknowledged.add(id);
    });
  }

  /** Transport/format failure is an audit event, never a consumed review or a new experience. */
  async recordReviewFailure(input: { at: number; realAt: number; reason: string; reviewId?: string }, current: () => boolean = () => true): Promise<void> {
    return this.serial(async () => {
      if (!current()) return;
      finiteTime(input.at, "at"); finiteTime(input.realAt, "realAt");
      const reason = [...input.reason].slice(0, 500).join("");
      const last = this.reviewFailures[0];
      // Aggressive test/user intervals must not generate a new identical journal line every tick.
      if (this.lastReviewOutcome === "failed" && last?.reason === reason && input.realAt >= last.realAt && input.realAt - last.realAt < 60_000) return;
      const failed: ReviewFailure = { type: "review_failed", actorId: this.actorId, at: input.at, realAt: input.realAt, reason,
        ...(input.reviewId ? { reviewId: input.reviewId } : {}) };
      await this.append(failed); this.acceptReviewFailure(failed);
    });
  }

  private acceptReviewFailure(failed: ReviewFailure): void {
    this.reviewFailures.unshift(failed); this.reviewFailures.splice(8); this.reviewFailureCount++;
    this.lastReviewOutcome = "failed";
  }

  /** A bounded invitation to deliberate; accumulating observations never manufactures a claim. */
  async reflectionOpportunity(minimumFreshRoots = 24): Promise<ReflectionOpportunity | null> {
    return this.serial(async () => {
      if (this.roots.size - this.reviewedRootCount < minimumFreshRoots) return null;
      const claimed = new Set(this.records.flatMap(record => record.rootEventIds));
      const candidateRoots = new Set<string>();
      const eventIds: string[] = [];
      for (const evidence of [...this.evidence.values()].reverse()) {
        const fresh = evidence.rootEventIds.filter(id => !claimed.has(id) && !candidateRoots.has(id));
        if (!fresh.length) continue;
        eventIds.push(evidence.eventId);
        fresh.forEach(id => candidateRoots.add(id));
        if (eventIds.length >= 6) break;
      }
      return eventIds.length ? { afterRootCount: this.reviewedRootCount, rootCount: this.roots.size, eventIds } : null;
    });
  }

  /** Call only after the invitation itself has been appended to the actor's context. */
  async markReflectionOffered(opportunity: ReflectionOpportunity): Promise<void> {
    return this.serial(async () => {
      const rootCount = Math.min(opportunity.rootCount, this.roots.size);
      if (rootCount <= this.reviewedRootCount) return;
      await this.append({ type: "review_offered", actorId: this.actorId, rootCount });
      this.reviewedRootCount = rootCount;
    });
  }

  /** Read only delivered evidence. The cursor advances exclusively with a complete committed review. */
  async snapshotReview(options: ReviewOptions): Promise<GrowthReviewSnapshot | null> {
    return this.serial(async () => {
      // Share the existing review cadence: legacy audits must neither starve nor add model calls per action.
      if (this.reviews.size % 4 === 3) {
        const audit = this.snapshotRevalidationUnlocked(options);
        if (audit) return audit;
      }
      const current = this.snapshotReviewUnlocked(options, this.reviewCursor, this.reviewItems.length);
      if (current) return current;
      for (const backlog of this.reviewBacklogs.values()) {
        if (backlog.cursor >= backlog.throughCursor) continue;
        const snapshot = this.snapshotReviewUnlocked({ ...options, minimumEpisodes: 1 }, backlog.cursor, backlog.throughCursor, backlog.id);
        if (snapshot) return snapshot;
      }
      return this.snapshotRevalidationUnlocked(options);
    });
  }

  private snapshotRevalidationUnlocked(options: ReviewOptions): GrowthReviewSnapshot | null {
    const at = finiteTime(options.at, "at");
    const attempted = new Set([...this.reviews.values()].flatMap(review => review.revalidation?.map(item => item.recordId) ?? []));
    const claims: GrowthView[] = [], evidence = new Map<string, PerceivedEvidence>();
    for (const id of new Set(this.records.map(record => record.claimId))) {
      const view = this.view(id, at)!;
      const latest = [...view.records].reverse().find(record => record.relation !== "counter")!;
      if (!view.active || !view.needsReview || view.kind === "state" || attempted.has(latest.id)) continue;
      const sources = view.evidence.filter(item => latest.evidenceIds.includes(item.eventId) && item.observedAt <= at);
      if (!sources.length || sources.length + evidence.size > boundedInteger(options.maxEvidence, 24, 1, 100)) continue;
      claims.push(view);
      for (const source of sources) evidence.set(source.eventId, source);
      if (claims.length >= 2) break;
    }
    if (!claims.length) return null;
    const snapshot: Omit<GrowthReviewSnapshot, "id"> = { actorId: this.actorId,
      afterCursor: this.reviewCursor, throughCursor: this.reviewCursor,
      revision: this.records.length + this.stateTimingCorrections.size + this.claimCorrections.size,
      createdAt: at, episodeIds: [], coveredEventCount: 0, omittedEvidenceCount: 0, reviewEventIds: [],
      claims, evidence: [...evidence.values()], revalidation: claims.map(view => ({ claimId: view.claimId,
        recordId: [...view.records].reverse().find(record => record.relation !== "counter")!.id })) };
    return structuredClone({ id: snapshotId(snapshot), ...snapshot });
  }

  private snapshotReviewUnlocked(options: ReviewOptions, cursor: number, limit: number, backlogId?: string): GrowthReviewSnapshot | null {
    const at = finiteTime(options.at, "at");
    const minimum = boundedInteger(options.minimumEpisodes, 4, 1, 100);
    const maxEpisodes = boundedInteger(options.maxEpisodes, 12, minimum, 100);
    const maxEvidence = boundedInteger(options.maxEvidence, 24, 1, 100);
    const episodeIds = new Set<string>();
    const selectedRuns: ReviewRun[] = [];
    let throughCursor = cursor;
    // Runs skip arbitrarily busy stretches of one conversation in constant time. Bound highly
    // interleaved runs too; an oversized batch may be reviewed with fewer than the usual minimum.
    const runBudget = 256;
    let low = 0, high = this.reviewRuns.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.reviewRuns[middle]!.end <= cursor) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.reviewRuns.length && selectedRuns.length < runBudget; index++) {
      const original = this.reviewRuns[index]!;
      if (original.start >= limit) break;
      const run = original.end > limit ? { ...original, end: limit, maxObservedAt: this.evidence.get(this.reviewItems[limit - 1]!.eventId)!.observedAt } : original;
      if (run.maxObservedAt > at) break;
      const additions = run.episodeIds.filter(id => !episodeIds.has(id));
      if (episodeIds.size && episodeIds.size + additions.length > maxEpisodes) break;
      run.episodeIds.forEach(id => episodeIds.add(id));
      selectedRuns.push(run);
      throughCursor = run.end;
      if (episodeIds.size >= maxEpisodes) break;
    }
    const boundedOverflow = selectedRuns.length === runBudget;
    if (!selectedRuns.length || (episodeIds.size < minimum && !boundedOverflow)) return null;
    const candidates = new Map<number, number>();
    for (const run of selectedRuns) {
      const start = Math.max(run.start, cursor);
      const samples = Math.min(maxEvidence, run.end - start);
      for (let step = 0; step < samples; step++) {
        const index = samples === 1 ? start : start + Math.floor(step * (run.end - start - 1) / (samples - 1));
        candidates.set(index, Math.max(candidates.get(index) ?? 0, 1));
      }
      const roles = [[run.samples.last, 4], [run.samples.failed, 7], [run.samples.imposed, 7],
        [run.samples.choice, 8], [run.samples.first, 3], [Math.max(run.start, cursor), 3]] as const;
      for (const [index, priority] of roles) if (index !== undefined && index >= cursor && index < throughCursor) {
        candidates.set(index, Math.max(candidates.get(index) ?? 0, priority));
      }
    }
    const ranked = [...candidates].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const selected = new Set<number>();
    // First cover every episode; then spend the remaining slots on different outcomes and boundaries.
    for (const episode of episodeIds) {
      const representative = ranked.find(([index]) => this.reviewItems[index]!.episodeIds.includes(episode));
      if (representative) selected.add(representative[0]);
      if (selected.size >= maxEvidence) break;
    }
    const representatives = new Set(selected);
    for (const [index] of ranked) { if (selected.size >= maxEvidence) break; selected.add(index); }
    const fresh = [...selected].sort((a, b) => a - b).map(index => this.evidence.get(this.reviewItems[index]!.eventId)!);
    const freshIds = new Set(fresh.map(item => item.eventId));
    const subjectIds = [...new Set(fresh.flatMap(e => e.experience?.subjectIds ?? []))];
    const text = fresh.map(e => `${e.experience?.situation ?? ""} ${e.text}`).join("\n");
    const queryText = normalize(text);
    const contextEvidence = [...this.evidence.values()].filter(e => {
      const index = this.reviewIndex.get(e.eventId);
      return !freshIds.has(e.eventId) && e.observedAt <= at &&
        (index === undefined || index < cursor || index >= throughCursor);
    })
      .map(e => ({ evidence: e, score:
        (e.experience?.episodeId && episodeIds.has(e.experience.episodeId) ? 30 : 0) +
        (e.experience?.subjectIds?.some(id => subjectIds.includes(id)) ? 15 : 0) +
        overlapScore(`${e.experience?.situation ?? ""} ${e.experience?.action ?? ""} ${e.text}`, queryText) }))
      .sort((a, b) => b.score - a.score || b.evidence.observedAt - a.evidence.observedAt);
    // Repeated readings of a snapshot must not crowd original independent choices out of the review.
    const contextEpisodes = new Set<string>();
    const relatedHistory = contextEvidence.filter(item => item.score >= 3).filter(item => {
      const key = item.evidence.experience?.episodeId ?? item.evidence.rootEventIds.join("\0");
      if (contextEpisodes.has(key)) return false;
      contextEpisodes.add(key); return true;
    });
    // Reserve a third of the request for related independent older experiences. Otherwise a
    // dense new batch can perpetually crowd out earlier no-change batches and prevent a sparse
    // habit from ever being recognized. Keep at least one representative of every fresh episode.
    const historyCapacity = Math.min(Math.floor(maxEvidence / 3), maxEvidence - representatives.size);
    const freshChoices = independentGrowthChoices([...representatives].sort((a, b) => a - b)
      .map(index => this.evidence.get(this.reviewItems[index]!.eventId)!));
    const longitudinal = selectLongitudinalEvidence({ fresh: freshChoices, historical: contextEvidence.map(item => item.evidence),
      behaviors: this.records.flatMap(record => record.behavior ? [record.behavior] : []),
      secondsPerTU: options.secondsPerTU, budget: historyCapacity, independentChoices: independentGrowthChoices });
    const history = [...longitudinal, ...relatedHistory.map(item => item.evidence).filter(item => !longitudinal.some(chosen => chosen.eventId === item.eventId))];
    const historicalBudget = Math.min(history.length, historyCapacity);
    const freshBudget = maxEvidence - historicalBudget;
    const finalSelected = new Set(representatives);
    for (const [index] of ranked) { if (finalSelected.size >= freshBudget) break; finalSelected.add(index); }
    const finalFresh = [...finalSelected].sort((a, b) => a - b).map(index => this.evidence.get(this.reviewItems[index]!.eventId)!);
    const context = history.slice(0, maxEvidence - finalFresh.length);
    const evidence = [...context, ...finalFresh];
    // Inactive claims remain available to a review so an expired state is not silently re-created.
    const visibleEvidence = new Set(evidence.map(item => item.eventId));
    const subjects = new Set(subjectIds);
    const dimensions = new Set<string>();
    const rankedClaims = [...new Set(this.records.map(record => record.claimId))].map(id => this.view(id, at)!)
      .map(view => ({ view, score: relevance(view, queryText, subjects) }))
      .filter(item => item.score >= 3)
      .sort((a, b) => Number(a.view.kind === "state") - Number(b.view.kind === "state")
        || b.score - a.score || semanticRecord(b.view).recordedAt - semanticRecord(a.view).recordedAt);
    const representativesBySubject = rankedClaims.filter(({ view }) => {
        const dimension = JSON.stringify([view.kind, view.subjectId, normalize(view.insight?.dimension ?? view.subject)]);
        if (dimensions.has(dimension)) return false;
        dimensions.add(dimension); return true;
      });
    const representedClaims = new Set(representativesBySubject.map(item => item.view.claimId));
    const claims = [...representativesBySubject.filter(item => item.view.kind !== "state"),
      ...rankedClaims.filter(item => item.view.kind !== "state" && !representedClaims.has(item.view.claimId)),
      ...representativesBySubject.filter(item => item.view.kind === "state")].slice(0, 8).map(({ view: claim }) => {
      const counter = claim.status === "contested" ? [...claim.records].reverse().find(record => record.relation === "counter") : undefined;
      return { ...claim,
        // Later supporting records do not resolve a counterexample; keep its actual content
        // available to the next reviewer even when the recent revision list is abbreviated.
        records: claim.records.filter((record, index) => index >= claim.records.length - 4 || record === counter),
        evidence: claim.evidence.filter(item => visibleEvidence.has(item.eventId)) };
    });
    const snapshot = { actorId: this.actorId, afterCursor: cursor, throughCursor,
      revision: this.records.length + this.stateTimingCorrections.size + this.claimCorrections.size, createdAt: at, episodeIds: [...episodeIds],
      coveredEventCount: throughCursor - cursor,
      omittedEvidenceCount: throughCursor - cursor - finalFresh.length, evidence, claims,
      reviewEventIds: finalFresh.map(item => item.eventId), ...(backlogId ? { backlogId } : {}) };
    return structuredClone({ id: snapshotId(snapshot), ...snapshot });
  }

  /** One JSONL line is the transaction: every reflection and the consumed cursor succeed or fail together. */
  async commitReview(snapshot: GrowthReviewSnapshot, proposals: ReflectionInput[], at: number, signal?: AbortSignal, secondsPerTU = 1): Promise<GrowthReviewResult> {
    return this.commitReviewItems(snapshot, proposals, at, signal, undefined, undefined, secondsPerTU);
  }

  /** Automatic proposals are independent: retain strict evidence guards without poisoning other valid items. */
  async commitAutomaticReview(snapshot: GrowthReviewSnapshot, proposals: unknown[], at: number,
    prepare: (input: unknown) => ReflectionInput, signal?: AbortSignal, shownEvidenceIds?: string[], secondsPerTU = 1): Promise<GrowthReviewResult> {
    return this.commitReviewItems(snapshot, proposals, at, signal, prepare, shownEvidenceIds, secondsPerTU);
  }

  private async commitReviewItems(snapshot: GrowthReviewSnapshot, proposals: unknown[], at: number, signal?: AbortSignal,
    prepare?: (input: unknown) => ReflectionInput, shownEvidenceIds?: string[], secondsPerTU = 1): Promise<GrowthReviewResult> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const previous = this.reviews.get(snapshot.id);
      if (previous) return this.reviewResult(previous, true);
      finiteTime(at, "at");
      const { id, ...unsigned } = snapshot;
      const backlog = snapshot.backlogId ? this.reviewBacklogs.get(snapshot.backlogId) : undefined;
      if (snapshot.actorId !== this.actorId || id !== snapshotId(unsigned) || (snapshot.backlogId && !backlog) ||
        snapshot.afterCursor !== (backlog?.cursor ?? this.reviewCursor) ||
        (snapshot.revalidation?.length ? snapshot.throughCursor !== snapshot.afterCursor || !!snapshot.backlogId
          : snapshot.throughCursor <= snapshot.afterCursor) || snapshot.throughCursor > (backlog?.throughCursor ?? this.reviewItems.length) ||
        snapshot.revision !== this.records.length + this.stateTimingCorrections.size + this.claimCorrections.size || at < snapshot.createdAt) {
        throw new Error("成长整理快照已失效；请重新读取经历与当前认识，游标未前移");
      }
      if (!Array.isArray(proposals) || proposals.length > 8) throw new Error("每次成长整理须为 0 至 8 条认识；没有变化请返回空数组");
      const included = [...snapshot.evidence, ...snapshot.claims.flatMap(claim => claim.evidence)];
      for (const evidence of included) {
        if (JSON.stringify(this.evidence.get(evidence.eventId)) !== JSON.stringify(evidence)) throw new Error("成长整理证据已失效；请重新读取快照");
      }
      const allowed = new Set(included.map(e => e.eventId));
      const shown = new Set(shownEvidenceIds ?? snapshot.evidence.map(item => item.eventId));
      if ([...shown].some(id => !allowed.has(id))) throw new Error("成长整理请求样本不属于已交付快照，游标未前移");
      const batchIds = new Set(snapshot.reviewEventIds ?? snapshot.evidence.map(item => item.eventId));
      const sampledEventIds = [...shown].filter(id => batchIds.has(id));
      const allowedClaims = new Set(snapshot.claims.map(claim => claim.claimId));
      const staged = [...this.records];
      const changes: GrowthRecord[] = [];
      const rejected: GrowthReviewRejection[] = [];
      for (const [index, raw] of proposals.entries()) {
        try {
          const input = prepare ? prepare(raw) : raw as ReflectionInput;
          if (input.claimId && !allowedClaims.has(input.claimId)) throw new Error(`认识 ${input.claimId} 未包含在本次整理快照中`);
          if (input.kind === "state" && input.relation !== "retire") throw new Error("自动成长不记录临时处境或行动流水账；这些内容保留在原始经历中");
          if (snapshot.revalidation?.length) {
            if (!input.claimId || !snapshot.revalidation.some(item => item.claimId === input.claimId) ||
              !["revise", "retire"].includes(input.relation ?? "support")) throw new Error("旧认识核对只能 revise 或 retire 本次指定的认识，不能把重读当新成长");
          } else if (!input.evidenceIds.some(id => batchIds.has(id))) throw new Error("整理须引用本批实际经历，不能只重读旧证据反复新增认识");
          const proposed = this.propose(input, at, staged, shownEvidenceIds ? shown : allowed, secondsPerTU);
          if (proposed.record) { proposed.record.origin = "automatic"; staged.push(proposed.record); changes.push(proposed.record); }
        } catch (error) {
          if (!prepare) throw error;
          rejected.push({ index, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      const commit: ReviewCommit = { type: "review_committed", actorId: this.actorId, id,
        afterCursor: snapshot.afterCursor, throughCursor: snapshot.throughCursor, at, records: changes,
        ...(snapshot.backlogId ? { backlogId: snapshot.backlogId } : {}), ...(rejected.length ? { rejected } : {}),
        ...(snapshot.revalidation?.length ? { revalidation: snapshot.revalidation } : {}),
        sampledEventIds, relatedEventIds: [...shown].filter(id => !batchIds.has(id)),
        omittedEvidenceCount: snapshot.coveredEventCount - sampledEventIds.length };
      signal?.throwIfAborted();
      await this.append(commit);
      this.records.push(...changes);
      this.reviews.set(id, commit);
      this.lastReviewOutcome = "completed";
      if (backlog) backlog.cursor = snapshot.throughCursor;
      else this.reviewCursor = snapshot.throughCursor;
      return this.reviewResult(commit, false);
    });
  }

  private reviewResult(commit: ReviewCommit, duplicate: boolean): GrowthReviewResult {
    const last = commit.records.at(-1);
    const end = last ? this.records.findIndex(record => record.id === last.id) + 1 : 0;
    const committedRecords = this.records.slice(0, end);
    return structuredClone({ id: commit.id, at: commit.at, records: commit.records, duplicate, ...(commit.rejected?.length ? { rejected: commit.rejected } : {}),
      views: [...new Set(commit.records.map(record => record.claimId))].map(id => this.view(id, commit.at, committedRecords)!) });
  }

  /** Durable outbox; the caller appends an event with this stable review id before acknowledging it. */
  async pendingReviews(n = 10): Promise<GrowthReviewResult[]> {
    return this.serial(async () => [...this.reviews.values()].filter(review => review.records.length && !this.acknowledged.has(review.id))
      .slice(0, boundedInteger(n, 10, 1, 50)).map(review => this.reviewResult(review, true)));
  }

  async ackReview(id: string): Promise<void> {
    return this.serial(async () => {
      if (this.acknowledged.has(id)) return;
      if (!this.reviews.has(id)) throw new Error(`找不到已完成的成长整理 ${id}`);
      await this.append({ type: "review_acknowledged", actorId: this.actorId, id });
      this.acknowledged.add(id);
    });
  }

  private retrieveUnlocked(query: { text: string; subjectIds?: string[]; channelKeys?: string[]; at: number; n?: number }, includeInactive = false): GrowthView[] {
    const text = normalize(query.text);
    const subjects = new Set(query.subjectIds ?? []);
    return [...new Set(this.records.map(record => record.claimId))].map(id => this.view(id, query.at)!)
      .filter(view => includeInactive || view.active && view.kind !== "state")
      .filter(view => includeInactive || growthMatchesScope(view, query.channelKeys ?? [], subjects))
      .map(view => ({ view, score: relevance(view, text, subjects) }))
      .filter(item => item.score >= 3)
      .sort((a, b) => b.score - a.score || semanticRecord(b.view).recordedAt - semanticRecord(a.view).recordedAt || a.view.claimId.localeCompare(b.view.claimId))
      .slice(0, boundedInteger(query.n, 4, 1, 12)).map(item => item.view);
  }

  /** Deterministic phrase/Chinese-word matching; no extra model and no unrelated memory injected. */
  async retrieve(query: { text: string; subjectIds?: string[]; channelKeys?: string[]; at: number; n?: number }): Promise<GrowthView[]> {
    return this.serial(async () => this.retrieveUnlocked({ ...query, at: finiteTime(query.at, "at") }));
  }

  /** Called when a new fixed context is created, never to rewrite an active request prefix. */
  async summary(at: number, maxChars = 2400): Promise<string> {
    return this.serial(async () => {
      finiteTime(at, "at");
      const limit = boundedInteger(maxChars, 2400, 100, 12_000);
      const views = [...new Set(this.records.map(record => record.claimId))].map(id => this.view(id, at)!)
        .filter(view => view.active && !view.needsReview && view.kind !== "state").sort((a, b) => semanticRecord(b).recordedAt - semanticRecord(a).recordedAt);
      const lines: string[] = [];
      let size = 0;
      for (const view of views) {
        const line = growthViewText(view);
        if (size + line.length + (lines.length ? 1 : 0) > limit) continue;
        lines.push(line); size += line.length + (lines.length > 1 ? 1 : 0);
      }
      return lines.join("\n");
    });
  }

  async reflect(input: ReflectionInput, at: number, secondsPerTU = 1): Promise<{ duplicate: boolean; view: GrowthView }> {
    return this.serial(async () => {
      const proposed = this.propose(input, at, this.records, undefined, secondsPerTU);
      if (!proposed.record) return { duplicate: true, view: this.view(proposed.claimId, at)! };
      await this.append({ type: "reflection", record: proposed.record });
      this.records.push(proposed.record);
      return { duplicate: false, view: this.view(proposed.claimId, at)! };
    });
  }

  /** Validation and construction are pure; an entire review is checked before its single append. */
  private propose(input: ReflectionInput, at: number, records: GrowthRecord[], allowedEvidence?: Set<string>, secondsPerTU = 1): { claimId: string; record?: GrowthRecord } {
    if (!["relationship", "commitment", "preference", "state", "habit", "trait"].includes(input.kind)) {
      throw new Error("成长类型须为 relationship、commitment、preference、state、habit 或 trait");
    }
    finiteTime(at, "at");
    const subject = requiredText(input.subject, "subject", 200);
    const statement = requiredText(input.statement, "statement", 1200);
    const relation = input.relation ?? "support";
    if (!["support", "counter", "revise", "retire"].includes(relation)) throw new Error("relation 须为 support、counter、revise 或 retire");
    if (!Array.isArray(input.evidenceIds) || !input.evidenceIds.length || input.evidenceIds.length > 20) {
      throw new Error("须引用 1 至 20 个你实际感知过的 event id");
    }
    const evidenceIds = [...new Set(input.evidenceIds)];
    const evidence = evidenceIds.map((id) => {
      if (typeof id !== "string") throw new Error("evidenceIds 必须为事件 id 列表");
      const found = this.evidence.get(id);
      if (!found) throw new Error(`未感知过事件 ${id}，不能据此反思`);
      if (allowedEvidence && !allowedEvidence.has(id)) throw new Error(`事件 ${id} 未包含在本次成长整理的已交付证据中`);
      if (found.observedAt > at) throw new Error(`事件 ${id} 尚未发生，不能据此反思`);
      return found;
    });
    const prior = input.claimId ? records.filter((r) => r.claimId === input.claimId) : [];
    if (input.claimId && !prior.length) throw new Error(`找不到认识 ${input.claimId}`);
    if (!prior.length && relation !== "support") throw new Error("反证、修正或停止适用须指定已有 claim_id");
    if (prior.length && (prior[0]!.kind !== input.kind || prior[0]!.subject !== subject)) {
      throw new Error("修订不能改变认识的类型或对象；请另建一条认识");
    }
    const latest = [...prior].reverse().find((r) => r.relation !== "counter");
    if (prior.length && relation === "support" && statement !== latest?.statement) {
      throw new Error("改变原判断请使用 relation=revise，旧判断及其证据会保留");
    }
    if (latest?.relation === "retire" && relation === "support") throw new Error("此认识已停止适用；如有新的改变，请引用新经历并使用 revise");
    if (latest && this.claimCorrections.has(latest.id) && (relation === "support" || relation === "revise" && statement === latest.statement)) {
      throw new Error("此认识已因证据归属或支持不足而撤回；不能沿用原判断，须依据新的实际经历作明确修订");
    }
    const subjectId = input.subjectId === undefined ? latest?.subjectId : requiredText(input.subjectId, "subjectId", 300);
    if (latest?.subjectId && subjectId !== latest.subjectId) throw new Error("修订不能改变认识所关联的身份");
    if (subjectId && !latest?.subjectId && !evidence.some(item => item.experience?.subjectIds?.includes(subjectId))) {
      throw new Error("subjectId 必须是本次引用经历中实际感知过的身份，不能把他人的证据绑定给另一个人");
    }
    const situation = input.situation === undefined ? latest?.situation : requiredText(input.situation, "situation", 500);
    const cues = input.cues === undefined ? latest?.cues : stringList(input.cues, "cues", 12, 100);
    const behavior = input.behavior === undefined ? latest?.behavior : requiredText(input.behavior, "behavior", 200);
    if (input.behavior !== undefined && input.kind !== "habit" && input.kind !== "trait") throw new Error("behavior 仅用于习惯或性格倾向的实际动作依据");
    const scope = relation === "retire" || relation === "counter" ? latest?.scope : deriveGrowthScope(input.kind, evidence, subjectId);
    const positive = relation === "support" || relation === "revise";
    const insight = positive && (["relationship", "commitment", "preference"].includes(input.kind) || input.insight)
      ? validateGrowthInsight({ ...input, subjectId }, evidence) : latest?.insight;
    if (latest?.scope?.domain === "chat" && scope?.domain === "chat" && input.kind === "state" && latest.scope.channelKey !== scope.channelKey) throw new Error("不能把一个频道的注意状态续接到另一个频道");
    let expiresAt = input.expiresAt === undefined ? latest?.expiresAt : finiteTime(input.expiresAt, "expiresAt（expires_at）");
    let stateTiming: GrowthRecord["stateTiming"];
    if (input.kind === "state" && relation !== "retire" && relation !== "counter") {
      const unit = Number.isFinite(secondsPerTU) && secondsPerTU > 0 ? secondsPerTU : 1;
      const evidenceAt = Math.max(...evidence.filter(stateBasis).map(item => item.observedAt));
      // A delayed review describes the past; reviewing it now cannot renew a bodily or situational state.
      if (evidenceAt + 7200 / unit <= at) throw new Error("临时状态缺少最近两世界小时内实际支持它的经历；旧经历不能恢复成当前 state，未来 expiresAt 也不能代替新证据");
      if (input.expiresAt !== undefined && input.expiresAt <= at) throw new Error("临时状态 expiresAt（expires_at）必须晚于当前世界时刻");
      expiresAt = Math.min(input.expiresAt ?? evidenceAt + 7200 / unit, evidenceAt + 86400 / unit);
      stateTiming = { evidenceAt, secondsPerTU: unit, ...(input.expiresAt !== undefined ? { requestedExpiresAt: input.expiresAt } : {}) };
    }
    if (input.kind !== "state" && input.expiresAt !== undefined) throw new Error("expiresAt 仅用于临时状态 state");
    if ((input.kind === "habit" || input.kind === "trait" || input.kind === "state") && !situation) throw new Error("临时状态、习惯或性格倾向须说明适用的 situation，不能直接泛化到所有情境");
    const roots = [...new Set(evidence.flatMap((e) => e.rootEventIds))];
    const used = new Set(prior.flatMap((r) => r.rootEventIds));
    const fresh = roots.filter((id) => !used.has(id));
    const revalidating = latest && latest.relation !== "retire" && !this.claimCorrections.has(latest.id) &&
      this.view(latest.claimId, at, records)?.needsReview && (relation === "revise" || relation === "retire");
    if (prior.length && !fresh.length && !revalidating) return { claimId: prior[0]!.claimId };
    if (!input.claimId) {
      const existing = records.find((r) => r.kind === input.kind && r.subject === subject && r.statement === statement && r.subjectId === subjectId);
      if (existing) throw new Error(`已有相同认识 ${existing.claimId}，请引用 claim_id 更新证据`);
      if (insight) {
        const sameDimension = [...new Set(records.map(record => record.claimId))].map(id => this.view(id, at, records)!)
          .find(view => view.kind === input.kind && view.subjectId === subjectId &&
            (subjectId || input.kind === "preference" || input.kind === "commitment" || view.subject === subject) &&
            normalize(view.insight?.dimension ?? "") === normalize(insight.dimension) &&
            view.scope?.domain === scope?.domain && (view.scope?.domain !== "chat" || scope?.domain === "chat" && view.scope.channelKey === scope.channelKey));
        if (sameDimension) throw new Error(`已有同一认识维度 ${sameDimension.claimId}；请沿用 claimId 修订，不要换标题重复新建`);
      }
      if (behavior && (input.kind === "habit" || input.kind === "trait")) {
        const sameBehavior = matchingBehavior(records, input.kind, behavior, subjectId);
        if (sameBehavior) throw new Error(`已有同一行为的认识 ${sameBehavior.claimId}，不能换个近义标题再次强化；请核对原有情境、例外并修订`);
      }
    }
    if ((input.kind === "habit" || input.kind === "trait") && (relation === "support" || relation === "revise")) {
      // A revision cannot convert counterevidence or one forced act into a positive behavioral pattern.
      // Previously supportive evidence can establish continuity; the current choice still needs fresh evidence.
      const supportingIds = new Set([...prior.filter(r => r.relation === "support" || r.relation === "revise").flatMap(r => r.evidenceIds), ...evidenceIds]);
      const voluntary = [...supportingIds].map(id => this.evidence.get(id)).filter((e): e is PerceivedEvidence => !!e &&
        e.experience?.internalThought !== true && e.experience?.agency === "self" &&
        e.experience.outcome === "completed" && e.experience.opportunity === true && !!e.experience.episodeId);
      const choices = independentChoices(voluntary);
      const minimum = input.kind === "habit" ? 3 : 6;
      if (choices.length < minimum) throw new Error(`${input.kind} 至少须有 ${minimum} 次不同经历中的自主完成选择；未知、被迫、失败与重复读取不计入`);
      if (!behavior || behavior.trim().length < 2) throw new Error("习惯与性格须给出 behavior：实际自主 action 里共同出现的明确动作短语，不能仅凭重复次数归纳");
      const relevantChoices = independentChoices(voluntary.filter(item => actionContains(item, behavior)));
      if (relevantChoices.length < minimum) throw new Error(`${input.kind} 的 behavior 必须由至少 ${minimum} 次实际自主动作逐字支持；不能把无关动作凑成习惯`);
      const unit = Number.isFinite(secondsPerTU) && secondsPerTU > 0 ? secondsPerTU : 1;
      const elapsed = (Math.max(...relevantChoices.map(item => item.observedAt)) - Math.min(...relevantChoices.map(item => item.observedAt))) * unit;
      if (elapsed < (input.kind === "trait" ? 7 : 1) * 86400) throw new Error(`${input.kind} 的支持经历尚未跨越${input.kind === "trait" ? "七个" : "一个"}世界日；连续循环只能说明当时行为，不能靠多次调用立刻固化人格`);
      if (!revalidating && !evidence.some(e => voluntary.includes(e) && e.rootEventIds.some(id => fresh.includes(id)))) {
        throw new Error("支持或修订行为倾向须有本次新增的自主完成选择；未知、被迫或失败经历可作为反证，但不能证明新的自愿习惯");
      }
      if (!revalidating && !evidence.some(e => voluntary.includes(e) && actionContains(e, behavior) && e.rootEventIds.some(id => fresh.includes(id)))) throw new Error("补充行为依据必须含新增的同一 behavior 实践；无关的新经历不能重复强化原有习惯");
      if (input.kind === "trait" && new Set(relevantChoices.map(e => normalize(e.experience!.situation ?? "")).filter(Boolean)).size < 3) {
        throw new Error("性格倾向至少须有 3 种不同情境的自主经历；单一关系或场景应保留为局部认识");
      }
    }
    const id = `growth_${randomUUID()}`;
    const record: GrowthRecord = {
      id, claimId: input.claimId ?? id, actorId: this.actorId, kind: input.kind,
      subject, statement, relation, ...(prior.length ? { previousId: prior.at(-1)!.id } : {}),
      evidenceIds, rootEventIds: fresh, recordedAt: at,
      origin: "manual",
      ...(subjectId ? { subjectId } : {}), ...(situation ? { situation } : {}),
      ...(cues ? { cues } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(stateTiming ? { stateTiming } : {}),
      ...(scope ? { scope } : {}), ...(behavior ? { behavior } : {}), groundingVersion: 1,
      ...(insight ? { insight, semanticVersion: 1 as const } : {}),
    };
    return { claimId: record.claimId, record };
  }

  private currentAt(): number {
    return Math.max(0, this.records.at(-1)?.recordedAt ?? 0, ...[...this.evidence.values()].slice(-1).map(e => e.observedAt));
  }

  private view(claimId: string, at = this.currentAt(), allRecords = this.records, clone = true): GrowthView | undefined {
    const records = allRecords.filter((r) => r.claimId === claimId);
    const first = records[0];
    if (!first) return undefined;
    const latest = [...records].reverse().find((r) => r.relation !== "counter")!;
    let lastRevision = -1;
    for (let i = 0; i < records.length; i++) if (records[i]!.relation === "revise") lastRevision = i;
    const contested = records.slice(Math.max(0, lastRevision)).some((r) => r.relation === "counter");
    const ids = new Set(records.flatMap((r) => r.evidenceIds));
    const stateTimingCorrection = this.stateTimingCorrections.get(latest.id);
    const correction = this.claimCorrections.get(latest.id);
    const expiresAt = stateTimingCorrection?.expiresAt ?? latest.expiresAt;
    const inactiveReason = latest.relation === "retire" ? "retired" as const : correction ? "corrected" as const
      : first.kind === "state" && (expiresAt === undefined || expiresAt <= at) ? "expired" as const : undefined;
    const view: GrowthView = {
      claimId, kind: first.kind, subject: first.subject, statement: latest.statement,
      status: contested ? "contested" : "tentative", active: !inactiveReason,
      ...(inactiveReason ? { inactiveReason } : {}),
      ...(latest.subjectId ? { subjectId: latest.subjectId } : {}),
      ...(latest.situation ? { situation: latest.situation } : {}),
      ...(latest.cues ? { cues: latest.cues } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}), ...(stateTimingCorrection ? { stateTimingCorrection } : {}),
      ...(correction ? { correction } : {}),
      ...(latest.scope ? { scope: latest.scope } : {}), ...(latest.behavior ? { behavior: latest.behavior } : {}),
      ...(latest.insight ? { insight: latest.insight } : {}),
      records,
      evidence: [...ids].flatMap((id) => this.evidence.get(id) ? [this.evidence.get(id)!] : []),
    };
    if (growthNeedsReview(view)) {
      view.needsReview = true;
      view.isolationReason = (latest.semanticVersion !== 1 || !latest.insight) && ["relationship", "commitment", "preference"].includes(view.kind)
        ? "旧认识尚未核对其长期意义与支持原文；暂不作为已确认的关系、承诺或偏好沿用"
        : view.kind === "habit" || view.kind === "trait" ? "缺少可核验的共同自主动作与跨日依据"
          : "缺少可核验的发送者或频道范围";
    }
    return clone ? structuredClone(view) : view;
  }

  /** Filter the complete ledger before pagination; recent routine states cannot hide older insights. */
  async queryPage(query: GrowthPageQuery = {}): Promise<GrowthPage> {
    return this.serial(async () => {
      const at = query.at === undefined ? this.currentAt() : finiteTime(query.at, "at");
      const keyword = query.keyword?.trim().toLowerCase();
      const lifecycle = query.lifecycle ?? "active", kind = query.kind ?? "long_term";
      const limit = boundedInteger(query.limit, 30, 1, 100);
      const counts: Record<GrowthKind, number> = { relationship: 0, commitment: 0, preference: 0, state: 0, habit: 0, trait: 0 };
      const grouped = new Map<string, GrowthRecord[]>();
      for (const record of this.records) {
        const records = grouped.get(record.claimId) ?? [];
        records.push(record); grouped.set(record.claimId, records);
      }
      const candidates = [...grouped].map(([id, records]) => this.view(id, at, records, false)!)
        .filter(view => lifecycle === "all" || (view.active && !view.needsReview) === (lifecycle === "active"))
        .filter(view => !keyword || [view.subject, view.statement, view.subjectId, view.situation,
          view.insight?.dimension, view.insight?.significance, view.isolationReason, ...(view.cues ?? []), ...view.records.map(record => record.statement)].join(" ").toLowerCase().includes(keyword));
      for (const view of candidates) counts[view.kind]++;
      const filtered = candidates.filter(view => kind === "all" || (kind === "long_term" ? view.kind !== "state" : view.kind === kind))
        .sort((a, b) => semanticRecord(b).recordedAt - semanticRecord(a).recordedAt || a.claimId.localeCompare(b.claimId));
      const total = filtered.length;
      const offset = Math.min(boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), Math.max(0, Math.floor((total - 1) / limit) * limit));
      return structuredClone({ items: filtered.slice(offset, offset + limit), total, offset, limit, counts });
    });
  }

  async recall(query: { kind?: GrowthKind; subject?: string; keyword?: string; claimId?: string; n?: number; at?: number; active?: boolean } = {}): Promise<GrowthView[]> {
    return this.serial(async () => {
      const ids = [...new Set(this.records.map((r) => r.claimId))];
      const keyword = query.keyword?.trim().toLowerCase();
      return ids.map((id) => this.view(id, query.at ?? this.currentAt())!).filter((v) =>
        (query.active === undefined || v.active === query.active) &&
        (!query.claimId || v.claimId === query.claimId) &&
        (!query.kind || v.kind === query.kind) &&
        (!query.subject || v.subject === query.subject) &&
        (!keyword || `${v.subject} ${v.statement} ${v.records.map((r) => r.statement).join(" ")}`.toLowerCase().includes(keyword)),
      ).slice(-Math.max(1, Math.min(50, Math.floor(query.n ?? 10))));
    });
  }
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 必须为 1 至 ${max} 字符的非空文本`);
  return value.trim();
}

function finiteTime(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} 必须为非负的有限世界时刻`);
  return value;
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function stringList(value: unknown, name: string, count: number, width: number): string[] {
  if (!Array.isArray(value) || value.length > count) throw new Error(`${name} 必须为最多 ${count} 项的文本列表`);
  return [...new Set(value.map(item => requiredText(item, name, width)))];
}

function normalizeMetadata(value: ExperienceMetadata): ExperienceMetadata {
  const agency = value.agency ?? "unknown";
  const outcome = value.outcome ?? "unknown";
  if (!["self", "imposed", "observed", "unknown"].includes(agency)) throw new Error("经历的行动归属无效");
  if (!["completed", "failed", "unknown"].includes(outcome)) throw new Error("经历的完成状态无效");
  return {
    agency, outcome,
    ...(value.episodeId ? { episodeId: requiredText(value.episodeId, "episodeId", 500) } : {}),
    ...(value.action ? { action: requiredText(value.action, "action", 1200) } : {}),
    ...(value.situation ? { situation: requiredText(value.situation, "situation", 500) } : {}),
    // read_channel can deliver 200 distinct participants in one real history snapshot.
    ...(value.subjectIds ? { subjectIds: stringList(value.subjectIds, "subjectIds", 200, 300) } : {}),
    ...(typeof value.opportunity === "boolean" ? { opportunity: value.opportunity } : {}),
    ...(value.worldPerception === true ? { worldPerception: true } : {}),
    ...(value.worldEpoch !== undefined ? { worldEpoch: requiredText(value.worldEpoch, "worldEpoch", 500) } : {}),
    ...(value.historicalWorld === true ? { historicalWorld: true } : {}),
    ...(Array.isArray(value.responseToRoots) ? { responseToRoots: [...new Set(value.responseToRoots.filter((id): id is string => typeof id === "string" && !!id))] } : {}),
    ...(value.chat ? { chat: normalizeChat(value.chat) } : {}),
  };
}

function normalizeChat(chat: NonNullable<ExperienceMetadata["chat"]>): NonNullable<ExperienceMetadata["chat"]> {
  if (!["message", "notice", "attention", "send"].includes(chat.kind)) throw new Error("聊天证据类别无效");
  return { kind: chat.kind, channelKey: requiredText(chat.channelKey, "chat.channelKey", 500),
    ...(chat.senderId ? { senderId: requiredText(chat.senderId, "chat.senderId", 300) } : {}),
    ...(typeof chat.senderOwn === "boolean" ? { senderOwn: chat.senderOwn } : {}) };
}

/** Additional support is audit history, not a stronger personality instruction or a fresh recollection. */
export function semanticRecord(view: GrowthView): GrowthRecord {
  return [...view.records].reverse().find(record => record.relation !== "support") ?? view.records[0]!;
}

function snapshotId(snapshot: Omit<GrowthReviewSnapshot, "id">): string {
  return `growth_review_${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 24)}`;
}

/** The same program-verified admission rule used by habit/trait validation, for model evidence hints. */
export function independentGrowthChoices(evidence: PerceivedEvidence[]): PerceivedEvidence[] {
  return independentChoices(evidence.filter(item => item.experience?.internalThought !== true && item.experience?.agency === "self" && item.experience.outcome === "completed" &&
    item.experience.opportunity === true && !!item.experience.episodeId));
}

/** Multiple tools in one episode, and projections sharing an original cause, are one choice. */
function independentChoices(evidence: PerceivedEvidence[]): PerceivedEvidence[] {
  const parents = evidence.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]!]!; index = parents[index]!; }
    return index;
  };
  const owners = new Map<string, number>();
  evidence.forEach((item, index) => {
    for (const key of [`episode:${item.experience!.episodeId}`, ...item.rootEventIds.map(id => `root:${id}`)]) {
      const previous = owners.get(key);
      if (previous !== undefined) parents[find(index)] = find(previous);
      else owners.set(key, index);
    }
  });
  const selected = new Map<number, PerceivedEvidence>();
  evidence.forEach((item, index) => { const key = find(index); if (!selected.has(key)) selected.set(key, item); });
  return [...selected.values()];
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
}

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const genericWords = new Set(["自己", "现在", "今天", "最近", "时候", "事情", "可以", "已经", "还是", "一个", "这个", "那个", "这样", "没有", "什么", "因为", "所以", "觉得", "开始", "一起", "一次", "关系", "状态", "情境", "发生", "认识", "行为", "进行", "结果", "之后", "之前", "角色", "当前", "the", "and", "with", "this", "that", "have", "from"]);

function words(text: string): string[] {
  return [...new Set([...segmenter.segment(normalize(text))].filter(part => part.isWordLike)
    .map(part => part.segment).filter(part => part.length >= 2 && !genericWords.has(part) && !/^\d+$/.test(part)))];
}

function overlapScore(description: string, normalizedQuery: string): number {
  const matched = words(description).filter(word => normalizedQuery.includes(word));
  return Math.min(12, matched.reduce((score, word) => score + (word.length >= 3 ? 2 : 1), 0));
}

function relevance(view: GrowthView, normalizedQuery: string, subjectIds: Set<string>): number {
  const identityMatch = !!view.subjectId && subjectIds.has(view.subjectId);
  const subject = normalize(view.subject);
  const subjectMatch = subject.length >= 2 && !["自己", "自身", "自我", "性格", "习惯", "日常", "他人"].includes(subject) && normalizedQuery.includes(subject);
  // A similar topic is not permission to transfer one person's relationship to another person.
  if (view.subjectId ? !identityMatch : view.kind === "relationship" && !subjectMatch) return 0;
  let score = identityMatch ? 30 : 0;
  if (subjectMatch) score += 8;
  for (const cue of view.cues ?? []) if (cue.length >= 2 && normalizedQuery.includes(normalize(cue))) score += 8;
  if (view.situation && normalize(view.situation).length >= 2 && normalizedQuery.includes(normalize(view.situation))) score += 8;
  score += overlapScore(`${view.situation ?? ""} ${view.statement}`, normalizedQuery);
  return score;
}

export function growthViewText(view: GrowthView): string {
  const labels: Record<GrowthKind, string> = { relationship: "关系认识", commitment: "承诺", preference: "偏好", state: "临时状态", habit: "情境习惯", trait: "性格倾向" };
  const counter = view.status === "contested" ? [...view.records].reverse().find(record => record.relation === "counter") : undefined;
  const withdrawn = view.inactiveReason === "corrected" || !!view.correction;
  const status = withdrawn ? "【已撤回，不作为当前事实或行动依据】" : view.inactiveReason === "retired" ? "【已停止沿用】" : view.needsReview ? "【待复核，已隔离，不作为当前事实或行动依据】" : "";
  return status + `${labels[view.kind]}：${view.subject}${view.subjectId ? `〔${growthIdentityText(view.subjectId)}〕` : ""}${view.situation ? `（${view.situation}）` : ""}。${view.statement}` +
    (view.kind === "state" && view.expiresAt !== undefined ? `（${withdrawn || view.needsReview ? "原记录期限为世界时刻" : "仅适用于世界时刻"} ${view.expiresAt} 之前。）` : "") +
    (counter ? ` 存在反例，尚不能一概而论：${counter.statement}` : "") +
    (withdrawn ? `（撤回原因：${view.correction?.reason ?? "原判断缺少依据"}。）` :
      view.needsReview ? "（原始记录与证据保留供复核，隔离不代表结论真伪已经确定。）" :
        !view.active ? `（${view.inactiveReason === "retired" ? "已停止适用" : "已过期"}。）` : "");
}

function growthIdentityText(subjectId: string): string {
  if (subjectId.startsWith("chat-user:")) {
    try {
      const identity: unknown = JSON.parse(subjectId.slice("chat-user:".length));
      if (Array.isArray(identity) && identity.length === 2 && identity.every(part => typeof part === "string" && part)) {
        return `${identity[0]} 账号 ${identity[1]}`;
      }
    } catch { /* Preserve unfamiliar stable identities explicitly, without guessing an account. */ }
  }
  return `身份 ${subjectId}`;
}
