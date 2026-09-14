import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BotEvent, ExperienceMetadata, StreamEntry } from "../types.js";
import { richPartsText } from "../media/presentation.js";
import { appendJsonLine } from "../jsonl.js";

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
}

export interface GrowthView {
  claimId: string;
  kind: GrowthKind;
  subject: string;
  statement: string;
  /** No automatic promotion from evidence count to a permanent personality trait. */
  status: "tentative" | "contested";
  active: boolean;
  inactiveReason?: "expired" | "retired";
  situation?: string;
  cues?: string[];
  subjectId?: string;
  expiresAt?: number;
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
}

export interface GrowthReviewResult {
  id: string;
  at: number;
  records: GrowthRecord[];
  views: GrowthView[];
  duplicate: boolean;
}

interface ReviewCommit {
  type: "review_committed";
  actorId: string;
  id: string;
  afterCursor: number;
  throughCursor: number;
  at: number;
  records: GrowthRecord[];
}

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
  | ReviewCommit | { type: "review_acknowledged"; actorId: string; id: string };

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
            this.reviewCursor = Math.max(this.reviewCursor, item.throughCursor);
          } else if (item.type === "review_acknowledged" && item.actorId === this.actorId) {
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
    if (this.evidence.has(evidence.eventId)) return;
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
    if (event.source === "system" || this.evidence.has(event.id)) return;
    const roots = [...new Set(rootEventIds.filter((id) => typeof id === "string" && id.trim()))];
    if (!roots.length) return; // derived memory/tool output cannot manufacture a fresh experience
    const evidence: PerceivedEvidence = {
      eventId: event.id, actorId: this.actorId, source: event.source,
      observedAt: event.worldTime, text: event.parts?.length ? richPartsText(event.parts) : event.content, rootEventIds: roots,
      ...(metadata ? { experience: normalizeMetadata(metadata) } : {}),
    };
    await this.append({ type: "perceived", evidence });
    this.acceptEvidence(evidence);
  }

  /** Repair a crash between durable context delivery and the evidence append. Never read world history. */
  async restorePerceptions(entries: readonly StreamEntry[]): Promise<void> {
    return this.serial(async () => {
      const derivedCalls = new Set(entries.flatMap(entry => entry.kind === "tool_call" &&
        ["reflect", "recall_growth", "recall"].includes(entry.call.name) ? [entry.call.id] : []));
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
  async snapshotReview(options: { at: number; minimumEpisodes?: number; maxEpisodes?: number; maxEvidence?: number } ): Promise<GrowthReviewSnapshot | null> {
    return this.serial(async () => {
      const at = finiteTime(options.at, "at");
      const minimum = boundedInteger(options.minimumEpisodes, 4, 1, 100);
      const maxEpisodes = boundedInteger(options.maxEpisodes, 12, minimum, 100);
      const maxEvidence = boundedInteger(options.maxEvidence, 24, 1, 100);
      const episodeIds = new Set<string>();
      const selectedRuns: ReviewRun[] = [];
      let throughCursor = this.reviewCursor;
      // Runs skip arbitrarily busy stretches of one conversation in constant time. Bound highly
      // interleaved runs too; an oversized batch may be reviewed with fewer than the usual minimum.
      const runBudget = 256;
      let low = 0, high = this.reviewRuns.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.reviewRuns[middle]!.end <= this.reviewCursor) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < this.reviewRuns.length && selectedRuns.length < runBudget; index++) {
        const run = this.reviewRuns[index]!;
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
        const start = Math.max(run.start, this.reviewCursor);
        const samples = Math.min(maxEvidence, run.end - start);
        for (let step = 0; step < samples; step++) {
          const index = samples === 1 ? start : start + Math.floor(step * (run.end - start - 1) / (samples - 1));
          candidates.set(index, Math.max(candidates.get(index) ?? 0, 1));
        }
        const roles = [[run.samples.last, 4], [run.samples.failed, 7], [run.samples.imposed, 7],
          [run.samples.choice, 6], [run.samples.first, 3], [Math.max(run.start, this.reviewCursor), 3]] as const;
        for (const [index, priority] of roles) if (index !== undefined && index >= this.reviewCursor && index < throughCursor) {
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
          (index === undefined || index < this.reviewCursor || index >= throughCursor);
      })
        .map(e => ({ evidence: e, score:
          (e.experience?.episodeId && episodeIds.has(e.experience.episodeId) ? 30 : 0) +
          (e.experience?.subjectIds?.some(id => subjectIds.includes(id)) ? 15 : 0) +
          overlapScore(`${e.experience?.situation ?? ""} ${e.experience?.action ?? ""} ${e.text}`, queryText) }))
        .filter(item => item.score >= 3)
        .sort((a, b) => b.score - a.score || b.evidence.observedAt - a.evidence.observedAt);
      // Repeated readings of a snapshot must not crowd original independent choices out of the review.
      const contextEpisodes = new Set<string>();
      const relatedHistory = contextEvidence.filter(item => {
        const key = item.evidence.experience?.episodeId ?? item.evidence.rootEventIds.join("\0");
        if (contextEpisodes.has(key)) return false;
        contextEpisodes.add(key); return true;
      });
      // Reserve a third of the request for related independent older experiences. Otherwise a
      // dense new batch can perpetually crowd out earlier no-change batches and prevent a sparse
      // habit from ever being recognized. Keep at least one representative of every fresh episode.
      const historicalBudget = Math.min(relatedHistory.length, Math.floor(maxEvidence / 3), maxEvidence - representatives.size);
      const freshBudget = maxEvidence - historicalBudget;
      const finalSelected = new Set(representatives);
      for (const [index] of ranked) { if (finalSelected.size >= freshBudget) break; finalSelected.add(index); }
      const finalFresh = [...finalSelected].sort((a, b) => a - b).map(index => this.evidence.get(this.reviewItems[index]!.eventId)!);
      const context = relatedHistory.slice(0, maxEvidence - finalFresh.length).map(item => item.evidence);
      const evidence = [...context, ...finalFresh];
      // Inactive claims remain available to a review so an expired state is not silently re-created.
      const visibleEvidence = new Set(evidence.map(item => item.eventId));
      const claims = this.retrieveUnlocked({ text, subjectIds, at, n: 8 }, true).map(claim => {
        const counter = claim.status === "contested" ? [...claim.records].reverse().find(record => record.relation === "counter") : undefined;
        return { ...claim,
          // Later supporting records do not resolve a counterexample; keep its actual content
          // available to the next reviewer even when the recent revision list is abbreviated.
          records: claim.records.filter((record, index) => index >= claim.records.length - 4 || record === counter),
          evidence: claim.evidence.filter(item => visibleEvidence.has(item.eventId)) };
      });
      const snapshot = { actorId: this.actorId, afterCursor: this.reviewCursor, throughCursor,
        revision: this.records.length, createdAt: at, episodeIds: [...episodeIds],
        coveredEventCount: throughCursor - this.reviewCursor,
        omittedEvidenceCount: throughCursor - this.reviewCursor - finalFresh.length, evidence, claims };
      return structuredClone({ id: snapshotId(snapshot), ...snapshot });
    });
  }

  /** One JSONL line is the transaction: every reflection and the consumed cursor succeed or fail together. */
  async commitReview(snapshot: GrowthReviewSnapshot, proposals: ReflectionInput[], at: number, signal?: AbortSignal): Promise<GrowthReviewResult> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      const previous = this.reviews.get(snapshot.id);
      if (previous) return this.reviewResult(previous, true);
      finiteTime(at, "at");
      const { id, ...unsigned } = snapshot;
      if (snapshot.actorId !== this.actorId || id !== snapshotId(unsigned) || snapshot.afterCursor !== this.reviewCursor ||
        snapshot.throughCursor <= snapshot.afterCursor || snapshot.throughCursor > this.reviewItems.length ||
        snapshot.revision !== this.records.length || at < snapshot.createdAt) {
        throw new Error("成长整理快照已失效；请重新读取经历与当前认识，游标未前移");
      }
      if (!Array.isArray(proposals) || proposals.length > 8) throw new Error("每次成长整理须为 0 至 8 条认识；没有变化请返回空数组");
      const included = [...snapshot.evidence, ...snapshot.claims.flatMap(claim => claim.evidence)];
      for (const evidence of included) {
        if (JSON.stringify(this.evidence.get(evidence.eventId)) !== JSON.stringify(evidence)) throw new Error("成长整理证据已失效；请重新读取快照");
      }
      const allowed = new Set(included.map(e => e.eventId));
      const allowedClaims = new Set(snapshot.claims.map(claim => claim.claimId));
      const staged = [...this.records];
      const changes: GrowthRecord[] = [];
      for (const input of proposals) {
        if (input.claimId && !allowedClaims.has(input.claimId)) throw new Error(`认识 ${input.claimId} 未包含在本次整理快照中`);
        const proposed = this.propose(input, at, staged, allowed);
        if (proposed.record) { proposed.record.origin = "automatic"; staged.push(proposed.record); changes.push(proposed.record); }
      }
      const commit: ReviewCommit = { type: "review_committed", actorId: this.actorId, id,
        afterCursor: snapshot.afterCursor, throughCursor: snapshot.throughCursor, at, records: changes };
      signal?.throwIfAborted();
      await this.append(commit);
      this.records.push(...changes);
      this.reviews.set(id, commit);
      this.reviewCursor = snapshot.throughCursor;
      return this.reviewResult(commit, false);
    });
  }

  private reviewResult(commit: ReviewCommit, duplicate: boolean): GrowthReviewResult {
    const last = commit.records.at(-1);
    const end = last ? this.records.findIndex(record => record.id === last.id) + 1 : 0;
    const committedRecords = this.records.slice(0, end);
    return structuredClone({ id: commit.id, at: commit.at, records: commit.records, duplicate,
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

  private retrieveUnlocked(query: { text: string; subjectIds?: string[]; at: number; n?: number }, includeInactive = false): GrowthView[] {
    const text = normalize(query.text);
    const subjects = new Set(query.subjectIds ?? []);
    return [...new Set(this.records.map(record => record.claimId))].map(id => this.view(id, query.at)!)
      .filter(view => includeInactive || view.active)
      .map(view => ({ view, score: relevance(view, text, subjects) }))
      .filter(item => item.score >= 3)
      .sort((a, b) => b.score - a.score || b.view.records.at(-1)!.recordedAt - a.view.records.at(-1)!.recordedAt || a.view.claimId.localeCompare(b.view.claimId))
      .slice(0, boundedInteger(query.n, 4, 1, 12)).map(item => item.view);
  }

  /** Deterministic phrase/Chinese-word matching; no extra model and no unrelated memory injected. */
  async retrieve(query: { text: string; subjectIds?: string[]; at: number; n?: number }): Promise<GrowthView[]> {
    return this.serial(async () => this.retrieveUnlocked({ ...query, at: finiteTime(query.at, "at") }));
  }

  /** Called when a new fixed context is created, never to rewrite an active request prefix. */
  async summary(at: number, maxChars = 2400): Promise<string> {
    return this.serial(async () => {
      finiteTime(at, "at");
      const limit = boundedInteger(maxChars, 2400, 100, 12_000);
      const views = [...new Set(this.records.map(record => record.claimId))].map(id => this.view(id, at)!)
        .filter(view => view.active).sort((a, b) => b.records.at(-1)!.recordedAt - a.records.at(-1)!.recordedAt);
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

  async reflect(input: ReflectionInput, at: number): Promise<{ duplicate: boolean; view: GrowthView }> {
    return this.serial(async () => {
      const proposed = this.propose(input, at, this.records);
      if (!proposed.record) return { duplicate: true, view: this.view(proposed.claimId, at)! };
      await this.append({ type: "reflection", record: proposed.record });
      this.records.push(proposed.record);
      return { duplicate: false, view: this.view(proposed.claimId, at)! };
    });
  }

  /** Validation and construction are pure; an entire review is checked before its single append. */
  private propose(input: ReflectionInput, at: number, records: GrowthRecord[], allowedEvidence?: Set<string>): { claimId: string; record?: GrowthRecord } {
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
    const subjectId = input.subjectId === undefined ? latest?.subjectId : requiredText(input.subjectId, "subjectId", 300);
    if (latest?.subjectId && subjectId !== latest.subjectId) throw new Error("修订不能改变认识所关联的身份");
    if (subjectId && !latest?.subjectId && !evidence.some(item => item.experience?.subjectIds?.includes(subjectId))) {
      throw new Error("subjectId 必须是本次引用经历中实际感知过的身份，不能把他人的证据绑定给另一个人");
    }
    const situation = input.situation === undefined ? latest?.situation : requiredText(input.situation, "situation", 500);
    const cues = input.cues === undefined ? latest?.cues : stringList(input.cues, "cues", 12, 100);
    const expiresAt = input.expiresAt === undefined ? latest?.expiresAt : finiteTime(input.expiresAt, "expiresAt");
    if (input.kind === "state" && relation !== "retire" && relation !== "counter" && (expiresAt === undefined || expiresAt <= at)) {
      throw new Error("临时状态须指定晚于当前世界时刻的 expiresAt；过期状态不能继续作为当前状态");
    }
    if (input.kind !== "state" && input.expiresAt !== undefined) throw new Error("expiresAt 仅用于临时状态 state");
    if ((input.kind === "habit" || input.kind === "trait" || input.kind === "state") && !situation) throw new Error("临时状态、习惯或性格倾向须说明适用的 situation，不能直接泛化到所有情境");
    const roots = [...new Set(evidence.flatMap((e) => e.rootEventIds))];
    const used = new Set(prior.flatMap((r) => r.rootEventIds));
    const fresh = roots.filter((id) => !used.has(id));
    if (prior.length && !fresh.length) return { claimId: prior[0]!.claimId };
    if (!input.claimId) {
      const existing = records.find((r) => r.kind === input.kind && r.subject === subject && r.statement === statement && r.subjectId === subjectId);
      if (existing) throw new Error(`已有相同认识 ${existing.claimId}，请引用 claim_id 更新证据`);
    }
    if ((input.kind === "habit" || input.kind === "trait") && (relation === "support" || relation === "revise")) {
      // A revision cannot convert counterevidence or one forced act into a positive behavioral pattern.
      // Previously supportive evidence can establish continuity; the current choice still needs fresh evidence.
      const supportingIds = new Set([...prior.filter(r => r.relation === "support" || r.relation === "revise").flatMap(r => r.evidenceIds), ...evidenceIds]);
      const voluntary = [...supportingIds].map(id => this.evidence.get(id)).filter((e): e is PerceivedEvidence => !!e &&
        e.experience?.agency === "self" &&
        e.experience.outcome === "completed" && e.experience.opportunity === true && !!e.experience.episodeId);
      const choices = independentChoices(voluntary);
      const minimum = input.kind === "habit" ? 3 : 6;
      if (choices.length < minimum) throw new Error(`${input.kind} 至少须有 ${minimum} 次不同经历中的自主完成选择；未知、被迫、失败与重复读取不计入`);
      if (!evidence.some(e => voluntary.includes(e) && e.rootEventIds.some(id => fresh.includes(id)))) {
        throw new Error("支持或修订行为倾向须有本次新增的自主完成选择；未知、被迫或失败经历可作为反证，但不能证明新的自愿习惯");
      }
      if (input.kind === "trait" && new Set(choices.map(e => normalize(e.experience!.situation ?? "")).filter(Boolean)).size < 3) {
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
    };
    return { claimId: record.claimId, record };
  }

  private currentAt(): number {
    return Math.max(0, this.records.at(-1)?.recordedAt ?? 0, ...[...this.evidence.values()].slice(-1).map(e => e.observedAt));
  }

  private view(claimId: string, at = this.currentAt(), allRecords = this.records): GrowthView | undefined {
    const records = allRecords.filter((r) => r.claimId === claimId);
    const first = records[0];
    if (!first) return undefined;
    const latest = [...records].reverse().find((r) => r.relation !== "counter")!;
    let lastRevision = -1;
    for (let i = 0; i < records.length; i++) if (records[i]!.relation === "revise") lastRevision = i;
    const contested = records.slice(Math.max(0, lastRevision)).some((r) => r.relation === "counter");
    const ids = new Set(records.flatMap((r) => r.evidenceIds));
    const inactiveReason = latest.relation === "retire" ? "retired" as const
      : first.kind === "state" && (latest.expiresAt === undefined || latest.expiresAt <= at) ? "expired" as const : undefined;
    return structuredClone({
      claimId, kind: first.kind, subject: first.subject, statement: latest.statement,
      status: contested ? "contested" : "tentative", active: !inactiveReason,
      ...(inactiveReason ? { inactiveReason } : {}),
      ...(latest.subjectId ? { subjectId: latest.subjectId } : {}),
      ...(latest.situation ? { situation: latest.situation } : {}),
      ...(latest.cues ? { cues: latest.cues } : {}),
      ...(latest.expiresAt !== undefined ? { expiresAt: latest.expiresAt } : {}),
      records,
      evidence: [...ids].flatMap((id) => this.evidence.get(id) ? [this.evidence.get(id)!] : []),
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
    ...(Array.isArray(value.responseToRoots) ? { responseToRoots: [...new Set(value.responseToRoots.filter((id): id is string => typeof id === "string" && !!id))] } : {}),
  };
}

function snapshotId(snapshot: Omit<GrowthReviewSnapshot, "id">): string {
  return `growth_review_${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 24)}`;
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
  return `${labels[view.kind]}：${view.subject}${view.subjectId ? `〔${growthIdentityText(view.subjectId)}〕` : ""}${view.situation ? `（${view.situation}）` : ""}。${view.statement}` +
    (view.kind === "state" && view.expiresAt !== undefined ? `（仅适用于世界时刻 ${view.expiresAt} 之前。）` : "") +
    (counter ? ` 存在反例，尚不能一概而论：${counter.statement}` : "") +
    (!view.active ? `（${view.inactiveReason === "retired" ? "已停止适用" : "已过期"}。）` : "");
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
