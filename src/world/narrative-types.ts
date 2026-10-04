import type { BusEnvelope } from "./bus.js";
import type { WorldObservation } from "./state.js";
import type { PhonePhysicalState } from "../types.js";
import type { NarrativeConsciousness } from "./consciousness.js";

/** Only identities, execution and provenance are machine state. World content is prose. */
export interface NarrativeActor {
  id: string;
  name: string;
  controller: "bot" | "player";
  present: boolean;
  /** Authored character background, retained independently from mutable current-state prose. */
  persona?: string;
  state: string;
  /** Explicit World fact. Missing older records are unknown, never guessed from prose. */
  consciousness?: NarrativeConsciousness;
  /** Last actor-visible scene; never the omniscient world document. */
  perception: string;
}
export interface NarrativeAction {
  id: string;
  actorId: string;
  intent: string;
  status: "pending" | "completed" | "needs_input" | "failed" | "cancelled";
  /** Accepted is only a queued request; ongoing requires a committed, actual beginning. */
  phase?: "accepted" | "ongoing" | "finished";
  /** Acceptance/timing origin; phase=accepted alone does not establish a bodily start. */
  startedAt: number;
  expectedEnd: number;
  finishedAt?: number;
  requestFingerprint: string;
  reason?: string;
  speech?: string;
}
export interface NarrativeSnapshot {
  schemaVersion: 1;
  mode: "narrative";
  initialized: boolean;
  sequence: number;
  effectiveAt: number;
  /** World time of the last changed world/actor prose or presence, excluding execution markers and rereads. */
  stateUpdatedAt: number;
  /** Journal sequence of that state change; rereads cite its persisted event as shared evidence. */
  stateSequence: number;
  worldState: string;
  actors: Record<string, NarrativeActor>;
  actions: Record<string, NarrativeAction>;
  /** Explicitly adjudicated physical facts; absence preserves legacy behavior without a guessed location. */
  phoneState?: PhonePhysicalState;
  /** Latest program-owned recovery; old prose is retained, not allowed to undo this newer fact. */
  phoneAccessRestoration?: { sequence: number; worldTime: number };
}
/** A possible next intention, never a fact, instruction, or guaranteed outcome. */
export interface NarrativeOpportunity {
  label: string;
  intent: string;
  /** Options with the same nonempty group offer mutually exclusive directions for this moment. */
  exclusiveGroup?: string;
}
export interface NarrativePresentation {
  /** Brief current circumstances knowable to the addressed actor, not omniscient state. */
  situation?: string;
  /** Optional, ignorable physical-world possibilities; free-form actions remain available. */
  opportunities?: NarrativeOpportunity[];
}
export interface NarrativePerception extends NarrativePresentation {
  eventId: string;
  actorId: string;
  text: string;
  worldSequence: number;
  worldTime: number;
  /** Captured from committed actor state at delivery, never inferred from the narrative text. */
  consciousness?: NarrativeConsciousness;
  actionId?: string;
  phase?: "start" | "finish";
  sourceEventIds: string[];
}
/** Private app output: persisted for replay/audit, never an actor's automatic perception. */
export interface NarrativeToolReceipt {
  actorId: string;
  text: string;
  status: "completed" | "failed" | "needs_input";
  reason?: string;
}
/** External evolution has no authority to choose or finish a controlled actor's action. */
export interface NarrativeExternalChange { id: string; description: string }
export interface NarrativeEvolution {
  changes: NarrativeExternalChange[];
  /** Each bodily update/delivery cites a newly established external cause in this commit. */
  actorEffects: { actorId: string; changeIds: string[] }[];
  perceptionSources: { actorId: string; changeIds: string[] }[];
  phoneChangeIds?: string[];
}
export interface NarrativeCommit {
  idempotencyKey: string;
  expectedSequence?: number;
  source: string;
  actorId?: string;
  actionId?: string;
  actionPhase?: "start" | "finish";
  initialized?: boolean;
  worldState?: string;
  phoneState?: PhonePhysicalState;
  /** Changed actor entries, addressed only by runtime-established identities. */
  actors?: Record<string, NarrativeActor>;
  actions?: Record<string, NarrativeAction>;
  perceptions?: ({ actorId: string; text: string; sourceEventIds?: string[] } & NarrativePresentation)[];
  toolReceipt?: NarrativeToolReceipt;
  /** Present for new evolve commits; absent on historical journals and other operations. */
  evolution?: NarrativeEvolution;
}
export interface NarrativeCommitResult {
  transactionId: string;
  sequence: number;
  duplicate: boolean;
  perceptions: NarrativePerception[];
  events: BusEnvelope[];
  toolReceipt?: NarrativeToolReceipt;
}
export interface NarrativeObservation extends WorldObservation {
  mode: "narrative";
  narrative: string;
  scene?: { eventId: string; actorId: string; actionId?: string; phase?: "start" | "finish"; worldSequence: number; worldTime: number; sourceEventIds: string[]; text: string } & NarrativePresentation;
}

/** Shared admission check for model proposals and direct durable commits; absent fields stay absent. */
export function validNarrativePresentation(value: { situation?: unknown; opportunities?: unknown }): boolean {
  const prose = (text: unknown, max: number) => typeof text === "string" && !!text.trim() && Array.from(text).length <= max;
  if (value.situation !== undefined && !prose(value.situation, 1200)) return false;
  if (value.opportunities === undefined) return true;
  return Array.isArray(value.opportunities) && value.opportunities.length <= 4 && value.opportunities.every(item =>
    !!item && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).every(key => ["label", "intent", "exclusiveGroup"].includes(key)) &&
    prose(item.label, 80) && prose(item.intent, 600) && (item.exclusiveGroup === undefined || prose(item.exclusiveGroup, 80)));
}

export function validNarrativeEvolution(value: NarrativeEvolution): boolean {
  const text = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["changes", "actorEffects", "perceptionSources", "phoneChangeIds"].includes(key)) ||
    !Array.isArray(value.changes) || !value.changes.length || value.changes.length > 100) return false;
  const ids = new Set<string>();
  for (const change of value.changes) {
    if (!change || Object.keys(change).some(key => !["id", "description"].includes(key)) || !text(change.id, 80) || !text(change.description, 200_000) || ids.has(change.id)) return false;
    ids.add(change.id);
  }
  const references = (refs: unknown): refs is string[] => Array.isArray(refs) && refs.length > 0 && refs.length <= 100 && new Set(refs).size === refs.length && refs.every(id => ids.has(id));
  for (const sources of [value.actorEffects, value.perceptionSources]) {
    if (!Array.isArray(sources) || sources.length > 100) return false;
    const actors = new Set<string>();
    for (const source of sources) {
      if (!source || Object.keys(source).some(key => !["actorId", "changeIds"].includes(key)) || !text(source.actorId, 256) || actors.has(source.actorId) || !references(source.changeIds)) return false;
      actors.add(source.actorId);
    }
  }
  return value.phoneChangeIds === undefined || references(value.phoneChangeIds);
}
