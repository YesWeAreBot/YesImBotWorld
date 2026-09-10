import { randomUUID } from "node:crypto";

/** CAN-inspired addressing and arbitration metadata; payloads remain application typed. */
export interface BusEnvelope<T = unknown> {
  id: string;
  kind: "command" | "event" | "observation";
  topic: string;
  source: string;
  actorId?: string;
  correlationId?: string;
  causationId?: string;
  sequence: number;
  effectiveAt: number;
  emittedAt: number;
  /** Lower values mean greater urgency. State ordering is always journal ordering. */
  priority: number;
  payload: T;
}
export type BusListener = (envelope: BusEnvelope) => void | Promise<void>;
export function envelope<T>(input: Omit<BusEnvelope<T>, "id" | "emittedAt">): BusEnvelope<T> {
  return { id: randomUUID(), emittedAt: Date.now(), ...input };
}
/** Subscribers run after persistence; their failures cannot roll back or stall a commit. */
export class WorldBus {
  private listeners = new Set<BusListener>();
  constructor(private onListenerError: (error: unknown) => void = () => {}) {}
  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  publish(message: BusEnvelope): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(JSON.parse(JSON.stringify(message)) as BusEnvelope);
        Promise.resolve(result).catch((error: unknown) => this.report(error));
      } catch (error) { this.report(error); }
    }
  }
  private report(error: unknown): void {
    try { this.onListenerError(error); } catch { /* Observability must not affect world state. */ }
  }
}
