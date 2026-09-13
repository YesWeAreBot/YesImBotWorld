import type { BusEnvelope } from "./bus.js";
import type { WorldObservation } from "./state.js";

/** Only identities, execution and provenance are machine state. World content is prose. */
export interface NarrativeActor {
  id: string;
  name: string;
  controller: "bot" | "player";
  present: boolean;
  /** Authored character background, retained independently from mutable current-state prose. */
  persona?: string;
  state: string;
  /** Last actor-visible scene; never the omniscient world document. */
  perception: string;
}
export interface NarrativeAction {
  id: string;
  actorId: string;
  intent: string;
  status: "pending" | "completed" | "needs_input" | "failed" | "cancelled";
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
}
export interface NarrativePerception {
  eventId: string;
  actorId: string;
  text: string;
  worldSequence: number;
  worldTime: number;
  actionId?: string;
  sourceEventIds: string[];
}
/** Private app output: persisted for replay/audit, never an actor's automatic perception. */
export interface NarrativeToolReceipt {
  actorId: string;
  text: string;
  status: "completed" | "failed" | "needs_input";
  reason?: string;
}
export interface NarrativeCommit {
  idempotencyKey: string;
  expectedSequence?: number;
  source: string;
  actorId?: string;
  actionId?: string;
  initialized?: boolean;
  worldState?: string;
  /** Changed actor entries, addressed only by runtime-established identities. */
  actors?: Record<string, NarrativeActor>;
  actions?: Record<string, NarrativeAction>;
  perceptions?: { actorId: string; text: string; sourceEventIds?: string[] }[];
  toolReceipt?: NarrativeToolReceipt;
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
  scene?: { eventId: string; actorId: string; actionId?: string; worldSequence: number; worldTime: number; sourceEventIds: string[]; text: string };
}
