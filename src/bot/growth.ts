import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BotEvent } from "../types.js";

export type GrowthKind = "relationship" | "commitment" | "preference";
export type ReflectionRelation = "support" | "counter" | "revise";

/** Only a projection actually delivered to this actor may enter the evidence registry. */
export interface PerceivedEvidence {
  eventId: string;
  actorId: string;
  source: BotEvent["source"];
  observedAt: number;
  text: string;
  /** Stable original causes; rereading or summarizing them is not new evidence. */
  rootEventIds: string[];
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
}

export interface GrowthView {
  claimId: string;
  kind: GrowthKind;
  subject: string;
  statement: string;
  /** No automatic promotion from evidence count to a permanent personality trait. */
  status: "tentative" | "contested";
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
}

type LedgerLine = { type: "perceived"; evidence: PerceivedEvidence } | { type: "reflection"; record: GrowthRecord };

/** Append-only subjective growth. This class deliberately has no access to the world event store. */
export class GrowthLedger {
  readonly file: string;
  private evidence = new Map<string, PerceivedEvidence>();
  private records: GrowthRecord[] = [];
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
            this.evidence.set(item.evidence.eventId, item.evidence);
          } else if (item.type === "reflection" && item.record?.actorId === this.actorId) {
            this.records.push(item.record);
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
    await fs.appendFile(this.file, JSON.stringify(item) + "\n");
  }

  async perceive(event: BotEvent, rootEventIds: string[] = [event.id]): Promise<void> {
    return this.serial(async () => {
      if (event.source === "system" || this.evidence.has(event.id)) return;
      const roots = [...new Set(rootEventIds.filter((id) => typeof id === "string" && id.trim()))];
      if (!roots.length) return; // derived memory/tool output cannot manufacture a fresh experience
      const evidence: PerceivedEvidence = {
        eventId: event.id, actorId: this.actorId, source: event.source,
        observedAt: event.worldTime, text: event.content, rootEventIds: roots,
      };
      await this.append({ type: "perceived", evidence });
      this.evidence.set(event.id, evidence);
    });
  }

  async reflect(input: ReflectionInput, at: number): Promise<{ duplicate: boolean; view: GrowthView }> {
    return this.serial(async () => {
      if (!["relationship", "commitment", "preference"].includes(input.kind)) throw new Error("成长类型须为 relationship、commitment 或 preference");
      const subject = requiredText(input.subject, "subject", 200);
      const statement = requiredText(input.statement, "statement", 1200);
      const relation = input.relation ?? "support";
      if (!["support", "counter", "revise"].includes(relation)) throw new Error("relation 须为 support、counter 或 revise");
      if (!Array.isArray(input.evidenceIds) || !input.evidenceIds.length || input.evidenceIds.length > 20) {
        throw new Error("须引用 1 至 20 个你实际感知过的 event id");
      }
      const evidenceIds = [...new Set(input.evidenceIds)];
      const evidence = evidenceIds.map((id) => {
        const found = this.evidence.get(id);
        if (!found) throw new Error(`未感知过事件 ${id}，不能据此反思`);
        return found;
      });
      const prior = input.claimId ? this.records.filter((r) => r.claimId === input.claimId) : [];
      if (input.claimId && !prior.length) throw new Error(`找不到认识 ${input.claimId}`);
      if (!prior.length && relation !== "support") throw new Error("反证或修正须指定已有 claim_id");
      if (prior.length && (prior[0]!.kind !== input.kind || prior[0]!.subject !== subject)) {
        throw new Error("修订不能改变认识的类型或对象；请另建一条认识");
      }
      const lastStatement = [...prior].reverse().find((r) => r.relation !== "counter")?.statement;
      if (prior.length && relation === "support" && statement !== lastStatement) {
        throw new Error("改变原判断请使用 relation=revise，旧判断及其证据会保留");
      }
      const roots = [...new Set(evidence.flatMap((e) => e.rootEventIds))];
      const used = new Set(prior.flatMap((r) => r.rootEventIds));
      const fresh = roots.filter((id) => !used.has(id));
      if (prior.length && !fresh.length) return { duplicate: true, view: this.view(prior[0]!.claimId)! };
      // The same evidence/claim cannot become multiple independent personality changes by omitting claim_id.
      if (!input.claimId) {
        const existing = this.records.find((r) => r.kind === input.kind && r.subject === subject && r.statement === statement);
        if (existing) throw new Error(`已有相同认识 ${existing.claimId}，请引用 claim_id 更新证据`);
      }
      const id = `growth_${randomUUID()}`;
      const record: GrowthRecord = {
        id, claimId: input.claimId ?? id, actorId: this.actorId, kind: input.kind,
        subject, statement, relation, ...(prior.length ? { previousId: prior.at(-1)!.id } : {}),
        evidenceIds, rootEventIds: fresh, recordedAt: at,
      };
      await this.append({ type: "reflection", record });
      this.records.push(record);
      return { duplicate: false, view: this.view(record.claimId)! };
    });
  }

  private view(claimId: string): GrowthView | undefined {
    const records = this.records.filter((r) => r.claimId === claimId);
    const first = records[0];
    if (!first) return undefined;
    const latest = [...records].reverse().find((r) => r.relation !== "counter")!;
    let lastRevision = -1;
    for (let i = 0; i < records.length; i++) if (records[i]!.relation === "revise") lastRevision = i;
    const contested = records.slice(Math.max(0, lastRevision)).some((r) => r.relation === "counter");
    const ids = new Set(records.flatMap((r) => r.evidenceIds));
    return structuredClone({
      claimId, kind: first.kind, subject: first.subject, statement: latest.statement,
      status: contested ? "contested" : "tentative", records,
      evidence: [...ids].flatMap((id) => this.evidence.get(id) ? [this.evidence.get(id)!] : []),
    });
  }

  async recall(query: { kind?: GrowthKind; subject?: string; keyword?: string; claimId?: string; n?: number } = {}): Promise<GrowthView[]> {
    return this.serial(async () => {
      const ids = [...new Set(this.records.map((r) => r.claimId))];
      const keyword = query.keyword?.trim().toLowerCase();
      return ids.map((id) => this.view(id)!).filter((v) =>
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
