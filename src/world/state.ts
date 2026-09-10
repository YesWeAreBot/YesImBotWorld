/** JSON values are the only values admitted to the authoritative world. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AttributeVisibility = "public" | "owner" | "hidden";
export interface WorldAttribute { value: JsonValue; visibility: AttributeVisibility }
export interface EntityInput {
  id: string;
  kind: "actor" | "place" | "object";
  name: string;
  location: string | null;
  owner?: string | null;
  controller?: string | null;
  attributes?: Record<string, WorldAttribute>;
}
export interface WorldEntity extends EntityInput {
  revision: number;
  attributes: Record<string, WorldAttribute>;
}
export interface ActionInput {
  id: string;
  actorId: string;
  intent: string;
  targetIds?: string[];
  expectedEnd?: number;
  basedOnObservationId?: string;
  requestFingerprint?: string;
}
export interface WorldAction extends ActionInput {
  status: "pending" | "completed" | "cancelled" | "failed";
  startedAt: number;
  finishedAt?: number;
  reason?: string;
  /** Preconditions captured when the action starts; completion must recheck them. */
  targetVersions: Record<string, number>;
}
export type WorldOperation =
  | { op: "create"; entity: EntityInput }
  | { op: "update"; id: string; changes: { name?: string; controller?: string | null; attributes?: Record<string, WorldAttribute | null> } }
  | { op: "move"; id: string; location: string | null; owner?: string | null }
  | { op: "action.start"; action: ActionInput }
  | { op: "action.finish"; id: string; status: "completed" | "cancelled" | "failed"; reason?: string }
  | { op: "say"; actorId: string; text: string; audience?: string[] };
export interface TransactionProposal {
  idempotencyKey: string;
  actorId?: string;
  expectedVersions?: Record<string, number | null>;
  effectiveAt?: number;
  operations: WorldOperation[];
  source?: string;
  correlationId?: string;
}
export interface PreparedProposal {
  proposal: TransactionProposal;
  basedOnSequence: number;
  changedEntityIds: string[];
}
export interface WorldSnapshot {
  schemaVersion: 1;
  sequence: number;
  effectiveAt: number;
  entities: Record<string, WorldEntity>;
  actions: Record<string, WorldAction>;
}
export interface ObservedEntity {
  observedId: string;
  kind: WorldEntity["kind"];
  name: string;
  revision: number;
  self: boolean;
  attributes: Record<string, JsonValue>;
  locationObservedId?: string;
  ownerObservedId?: string;
}
export interface WorldObservation {
  observationId: string;
  actorId: string;
  worldSequence: number;
  observedAt: number;
  /** Stable IDs of perceptible source events, suitable as deduplicated memory evidence. */
  sourceEventIds: string[];
  entities: ObservedEntity[];
  utterances: { eventId: string; speakerName: string; speakerObservedId?: string; text: string; spokenAt: number }[];
}
export interface ObserveRequest { target?: string; sinceSequence?: number; consume?: boolean; publicOnly?: boolean; selfOnly?: boolean; includeSpeech?: boolean }
export class KernelError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "KernelError"; }
}
export function emptyWorld(): WorldSnapshot {
  return { schemaVersion: 1, sequence: 0, effectiveAt: 0, entities: {}, actions: {} };
}
/** Reject values that JSON would silently coerce or discard, and unsafe record keys. */
export function assertJson(value: unknown, path = "value"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach((v, i) => assertJson(v, `${path}[${i}]`)); return; }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      assertSafeKey(key);
      assertJson(item, `${path}.${key}`);
    }
    return;
  }
  throw new KernelError("INVALID_JSON", `${path} must contain finite JSON values only`);
}
export function assertSafeKey(key: string): void {
  if (!key || key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new KernelError("INVALID_ID", `Invalid identifier: ${key}`);
  }
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
