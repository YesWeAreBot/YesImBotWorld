/** Bounded, in-memory raw LLM calls. Debug events contain metadata only. */
import { randomUUID } from "node:crypto";
import { debug } from "./debug.js";

export type CallStatus = "pending" | "streaming" | "completed" | "error" | "cancelled";
export interface CallMeta {
  callId: string;
  source: string;
  model: string;
  url: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  status: CallStatus;
  revision: number;
  requestBytes: number;
  responseBytes: number;
  responseChars: number;
  rawAvailable: boolean;
  rawUnavailableReason?: string;
  responseFormat?: string;
  httpStatus?: number;
  preview: string;
  usage?: unknown;
  error?: string;
  unicodeRepairedStrings?: number;
}
interface StoredCall { meta: CallMeta; debugId?: number; lastPublished?: number }
interface RawCall { request: string; chunks: string[]; bytes: number; chars: number }
export interface CallDetail {
  call: CallMeta;
  requestBody?: string | null;
  responseText: string | null;
  responseOffset: number;
  nextOffset: number;
  reset: boolean;
}

export class CallStore {
  private calls = new Map<string, StoredCall>();
  private raw = new Map<string, RawCall>();
  private bytes = 0;
  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxCallBytes = 8 * 1024 * 1024,
    private readonly maxCalls = 200,
    private readonly notify: (meta: CallMeta, debugId?: number) => number | undefined = () => undefined,
  ) {}

  begin(input: { source: string; model: string; url: string; requestBody: string; unicodeRepairedStrings?: number }): string {
    const callId = randomUUID(), now = Date.now(), bytes = Buffer.byteLength(input.requestBody);
    const meta: CallMeta = { callId, source: input.source, model: input.model, url: input.url, startedAt: now, updatedAt: now, status: "pending", revision: 1, requestBytes: bytes, responseBytes: 0, responseChars: 0, rawAvailable: true, preview: "", unicodeRepairedStrings: input.unicodeRepairedStrings };
    this.calls.set(callId, { meta });
    this.raw.set(callId, { request: input.requestBody, chunks: [], bytes, chars: 0 });
    this.bytes += bytes;
    this.enforce(callId);
    while (this.calls.size > this.maxCalls) {
      const oldest = this.calls.keys().next().value!;
      this.dropRaw(oldest, "调用已超出历史保留数量");
      this.calls.delete(oldest);
    }
    this.publish(callId);
    return callId;
  }

  /** Capture the decoded transport text before SSE parsing; never joins the buffer per token. */
  append(callId: string, text: string): void {
    const entry = this.calls.get(callId); if (!entry || !text) return;
    const bytes = Buffer.byteLength(text);
    entry.meta.responseBytes += bytes;
    entry.meta.responseChars += text.length;
    const raw = this.raw.get(callId);
    if (raw) { raw.chunks.push(text); raw.bytes += bytes; raw.chars += text.length; this.bytes += bytes; this.enforce(callId); }
    entry.meta.updatedAt = Date.now(); entry.meta.revision++;
    if (entry.meta.status === "pending") entry.meta.status = "streaming";
    if (entry.meta.updatedAt - (entry.lastPublished ?? 0) >= 400) this.publish(callId);
  }

  update(callId: string, patch: Partial<Pick<CallMeta, "status" | "httpStatus" | "responseFormat" | "usage" | "error" | "preview">>): void {
    const entry = this.calls.get(callId); if (!entry) return;
    Object.assign(entry.meta, patch);
    if (patch.preview !== undefined) entry.meta.preview = patch.preview.slice(-1800);
    if (patch.error !== undefined) entry.meta.error = patch.error.slice(0, 4000);
    entry.meta.updatedAt = Date.now(); entry.meta.revision++;
    if (patch.status && ["completed", "error", "cancelled"].includes(patch.status)) entry.meta.endedAt = entry.meta.updatedAt;
    this.publish(callId);
  }

  recent(): CallMeta[] { return [...this.calls.values()].map(entry => structuredClone(entry.meta)); }
  detail(callId: string, after = 0, includeRequest = true): CallDetail | null {
    const entry = this.calls.get(callId); if (!entry) return null;
    const raw = this.raw.get(callId);
    if (raw) { this.raw.delete(callId); this.raw.set(callId, raw); }
    const invalid = !Number.isSafeInteger(after) || after < 0 || after > (raw?.chars ?? 0);
    const offset = invalid ? 0 : after;
    // Compact chunks only for an explicit reader; subsequent writes continue appending.
    const joined = raw?.chunks.join("") ?? null;
    if (raw && raw.chunks.length > 1) raw.chunks = joined ? [joined] : [];
    return { call: structuredClone(entry.meta), ...(includeRequest ? { requestBody: raw?.request ?? null } : {}), responseText: joined === null ? null : joined.slice(offset), responseOffset: offset, nextOffset: raw?.chars ?? 0, reset: invalid };
  }
  clear(): void { this.calls.clear(); this.raw.clear(); this.bytes = 0; }
  get retainedBytes(): number { return this.bytes; }

  private enforce(current: string): void {
    if ((this.raw.get(current)?.bytes ?? 0) > this.maxCallBytes) this.dropRaw(current, "单次调用超过原始数据保留上限");
    while (this.bytes > this.maxBytes && this.raw.size) this.dropRaw(this.raw.keys().next().value!, "原始数据已按内存容量淘汰");
  }
  private dropRaw(callId: string, reason: string): void {
    const raw = this.raw.get(callId); if (raw) { this.bytes -= raw.bytes; this.raw.delete(callId); }
    const entry = this.calls.get(callId);
    if (entry) { entry.meta.rawAvailable = false; entry.meta.rawUnavailableReason = reason; entry.meta.revision++; this.publish(callId); }
  }
  private publish(callId: string): void {
    const entry = this.calls.get(callId); if (!entry) return;
    entry.lastPublished = Date.now();
    try { entry.debugId = this.notify(structuredClone(entry.meta), entry.debugId); } catch { /* Observation must not affect an LLM call. */ }
  }
}

export const callStore = new CallStore(undefined, undefined, undefined, (meta, debugId) => {
  const label = `${meta.source}·${meta.status}`;
  const level = meta.status === "error" ? "error" : "info";
  if (debugId !== undefined && debug.has(debugId)) { debug.update(debugId, { label, detail: meta, level }); return debugId; }
  return debug.emit("llm.call", label, meta, level);
});
