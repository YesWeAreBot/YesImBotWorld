/** Disk-backed raw LLM calls. Byte limits apply to the memory cache, never the recording. */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
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
  /** Capture remains available in memory when persistence is temporarily unavailable. */
  storageWarning?: string;
  responseFormat?: string;
  httpStatus?: number;
  preview: string;
  usage?: unknown;
  error?: string;
  unicodeRepairedStrings?: number;
}
interface StoredCall {
  meta: CallMeta;
  debugId?: number;
  lastPublished?: number;
  lastCheckpoint?: number;
  disk?: { request: string; response: string; metadata: string; fd?: number; healthy: boolean };
}
interface RawCall { request: string; chunks: { start: number; text: string }[]; bytes: number; chars: number }
const terminal = (meta: CallMeta) => ["completed", "error", "cancelled"].includes(meta.status);
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  private directory = "";
  private temporary = false;
  private storageWarning?: string;
  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxCallBytes = 8 * 1024 * 1024,
    private readonly maxCalls = 200,
    private readonly notify: (meta: CallMeta, debugId?: number) => number | undefined = () => undefined,
  ) {}

  /** Called before agents start; a plugin reload restores its own history from this directory. */
  init(directory: string): void {
    const resolved = path.resolve(directory);
    if (this.directory === resolved && !this.temporary) return;
    this.dispose();
    this.directory = resolved;
    this.temporary = false;
    try {
      mkdirSync(resolved, { recursive: true, mode: 0o700 });
      const restored: StoredCall[] = [];
      for (const name of readdirSync(resolved)) {
        if (!name.endsWith(".json") || !validId.test(name.slice(0, -5))) continue;
        try {
          const record = JSON.parse(readFileSync(path.join(resolved, name), "utf8"));
          const meta = record.meta as CallMeta;
          if (record.version !== 1 || !meta || meta.callId !== name.slice(0, -5) || !Number.isFinite(meta.startedAt) || !Number.isSafeInteger(meta.responseChars) || typeof meta.source !== "string" || typeof meta.model !== "string") continue;
          const entry: StoredCall = { meta, disk: this.paths(meta.callId) };
          try {
            statSync(entry.disk!.request);
            const size = statSync(entry.disk!.response).size;
            // A crash may leave metadata behind the last appended frame. File length is authoritative.
            if (size % 2) truncateSync(entry.disk!.response, size - 1);
            const chars = Math.floor(size / 2);
            if (chars !== meta.responseChars) meta.responseBytes = this.countResponseBytes(entry.disk!.response);
            meta.responseChars = chars;
            meta.rawAvailable = true;
            delete meta.rawUnavailableReason;
            delete meta.storageWarning;
          } catch {
            entry.disk!.healthy = false;
            meta.rawAvailable = false;
            meta.rawUnavailableReason = "本地调用文件缺失或无法读取";
          }
          if (!terminal(meta)) {
            meta.status = "cancelled";
            meta.endedAt = Date.now();
            meta.error = "上次服务运行已中断；已保留当时收到的请求与返回。";
            meta.revision++;
          }
          restored.push(entry);
        } catch { /* A damaged record must not hide the rest of the history. */ }
      }
      restored.sort((a, b) => a.meta.startedAt - b.meta.startedAt);
      for (const entry of restored) { this.calls.set(entry.meta.callId, entry); this.checkpoint(entry, true); }
      this.enforceHistory();
    } catch (error) { this.storageWarning = this.warning(error); }
  }

  begin(input: { source: string; model: string; url: string; requestBody: string; unicodeRepairedStrings?: number }): string {
    const callId = randomUUID(), now = Date.now(), bytes = Buffer.byteLength(input.requestBody);
    const meta: CallMeta = { callId, source: input.source, model: input.model, url: input.url, startedAt: now, updatedAt: now, status: "pending", revision: 1, requestBytes: bytes, responseBytes: 0, responseChars: 0, rawAvailable: true, preview: "", unicodeRepairedStrings: input.unicodeRepairedStrings };
    const entry: StoredCall = { meta };
    this.calls.set(callId, entry);
    this.cache(callId, { request: input.requestBody, chunks: [], bytes: input.requestBody.length * 2, chars: 0 });
    try {
      this.ensureDirectory();
      entry.disk = this.paths(callId);
      writeFileSync(entry.disk.request, input.requestBody, { encoding: "utf16le", mode: 0o600, flag: "wx" });
      entry.disk.fd = openSync(entry.disk.response, "wx", 0o600);
    } catch (error) { this.persistenceFailed(entry, error); }
    this.checkpoint(entry, true);
    this.enforceCache();
    this.publish(callId);
    return callId;
  }

  /** Append transport text without joining or rewriting earlier response frames. */
  append(callId: string, text: string): void {
    const entry = this.calls.get(callId); if (!entry || !text) return;
    const before = entry.meta.responseChars;
    if (entry.disk?.healthy) {
      try {
        if (entry.disk.fd === undefined) entry.disk.fd = openSync(entry.disk.response, "r+");
        const encoded = Buffer.from(text, "utf16le");
        let written = 0;
        while (written < encoded.length) {
          const count = writeSync(entry.disk.fd, encoded, written, encoded.length - written, before * 2 + written);
          if (!count) throw new Error("调用文件写入未完成");
          written += count;
        }
      } catch (error) {
        // Restore the committed prefix before retaining this frame in memory. A partial write
        // must neither duplicate a suffix nor discard a call that has already left the cache.
        if (!this.raw.has(callId)) {
          try {
            const request = readFileSync(entry.disk.request, "utf16le");
            const response = this.readResponse(entry.disk.response, 0, before);
            this.cache(callId, { request, chunks: response ? [{ start: 0, text: response }] : [], bytes: (request.length + response.length) * 2, chars: before });
          } catch {
            entry.meta.rawAvailable = false;
            entry.meta.rawUnavailableReason = "本地调用文件写入失败，且先前内容无法读取";
          }
        }
        this.persistenceFailed(entry, error);
      }
    }
    const raw = this.raw.get(callId);
    if (raw) { raw.chunks.push({ start: before, text }); raw.bytes += text.length * 2; raw.chars += text.length; this.bytes += text.length * 2; }
    entry.meta.responseBytes += Buffer.byteLength(text);
    entry.meta.responseChars += text.length;
    entry.meta.updatedAt = Date.now(); entry.meta.revision++;
    if (entry.meta.status === "pending") entry.meta.status = "streaming";
    this.checkpoint(entry);
    this.enforceCache();
    if (entry.meta.updatedAt - (entry.lastPublished ?? 0) >= 400) this.publish(callId);
  }

  update(callId: string, patch: Partial<Pick<CallMeta, "status" | "httpStatus" | "responseFormat" | "usage" | "error" | "preview">>): void {
    const entry = this.calls.get(callId); if (!entry) return;
    Object.assign(entry.meta, patch);
    if (patch.preview !== undefined) entry.meta.preview = patch.preview.slice(-1800);
    if (patch.error !== undefined) entry.meta.error = patch.error.slice(0, 4000);
    entry.meta.updatedAt = Date.now(); entry.meta.revision++;
    if (terminal(entry.meta)) { entry.meta.endedAt = entry.meta.updatedAt; this.close(entry); this.recoverPersistence(entry); }
    this.checkpoint(entry, terminal(entry.meta));
    this.publish(callId);
    this.enforceHistory();
  }

  recent(): CallMeta[] { return [...this.calls.values()].map(entry => structuredClone(entry.meta)); }
  detail(callId: string, after = 0, includeRequest = true): CallDetail | null {
    const entry = this.calls.get(callId); if (!entry) return null;
    const invalid = !Number.isSafeInteger(after) || after < 0 || after > entry.meta.responseChars;
    const offset = invalid ? 0 : after;
    const raw = this.raw.get(callId);
    let request: string | null = null, response: string | null = null;
    if (raw) {
      this.raw.delete(callId); this.raw.set(callId, raw);
      if (includeRequest) request = raw.request;
      response = this.cachedResponse(raw, offset);
    } else if (entry.disk?.healthy) {
      try {
        if (includeRequest) request = readFileSync(entry.disk.request, "utf16le");
        response = this.readResponse(entry.disk.response, offset, entry.meta.responseChars);
        entry.meta.rawAvailable = true;
        delete entry.meta.rawUnavailableReason;
      } catch (error) {
        entry.meta.rawAvailable = false;
        entry.meta.rawUnavailableReason = "无法读取本地调用文件：" + String((error as Error).message ?? error).slice(0, 500);
      }
    }
    return { call: structuredClone(entry.meta), ...(includeRequest ? { requestBody: request } : {}), responseText: response, responseOffset: offset, nextOffset: entry.meta.responseChars, reset: invalid };
  }

  /** Explicitly clear recorded history. Ordinary cache pressure never calls this. */
  clear(): void {
    for (const [id, entry] of this.calls) { this.close(entry); this.deleteFiles(id); }
    this.calls.clear(); this.raw.clear(); this.bytes = 0;
  }

  /** Flush and release descriptors on plugin shutdown; persistent history stays on disk. */
  dispose(): void {
    for (const entry of this.calls.values()) {
      if (!terminal(entry.meta)) {
        entry.meta.status = "cancelled"; entry.meta.endedAt = Date.now(); entry.meta.updatedAt = entry.meta.endedAt;
        entry.meta.error = "服务已停止；已保留当时收到的请求与返回。"; entry.meta.revision++;
      }
      this.close(entry); this.recoverPersistence(entry); this.checkpoint(entry, true);
    }
    this.calls.clear(); this.raw.clear(); this.bytes = 0;
    if (this.temporary && this.directory) { try { rmSync(this.directory, { recursive: true, force: true }); } catch { /* best effort */ } }
    this.directory = ""; this.temporary = false; this.storageWarning = undefined;
  }

  get retainedBytes(): number { return this.bytes; }
  get retention() {
    return { maxCalls: this.maxCalls, maxCompletedCalls: this.maxCalls, activeCallsPreserved: true, maxBytes: this.maxBytes, maxCallBytes: this.maxCallBytes, cacheOnly: true, persistent: !!this.directory && !this.temporary && !this.storageWarning, storage: this.directory && !this.storageWarning ? "disk" : "memory", ...(this.storageWarning ? { storageWarning: this.storageWarning } : {}) };
  }

  private ensureDirectory(): void {
    if (this.directory) { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); return; }
    this.directory = mkdtempSync(path.join(tmpdir(), "yesimbot-calls-"));
    this.temporary = true;
  }
  private paths(id: string): NonNullable<StoredCall["disk"]> {
    return { request: path.join(this.directory, id + ".request"), response: path.join(this.directory, id + ".response"), metadata: path.join(this.directory, id + ".json"), healthy: true };
  }
  private warning(error: unknown): string { return "本地调用记录暂时无法写入，原始数据保留在内存：" + String((error as Error)?.message ?? error).slice(0, 500); }
  private persistenceFailed(entry: StoredCall, error: unknown): void {
    this.close(entry);
    if (entry.disk) entry.disk.healthy = false;
    entry.meta.storageWarning = this.warning(error);
    this.storageWarning = entry.meta.storageWarning;
  }
  private checkpoint(entry: StoredCall, force = false): void {
    if (!entry.disk || !entry.disk.healthy || (!force && Date.now() - (entry.lastCheckpoint ?? 0) < 400)) return;
    try {
      const temporary = entry.disk.metadata + ".tmp";
      delete entry.meta.storageWarning;
      writeFileSync(temporary, JSON.stringify({ version: 1, meta: entry.meta }), { mode: 0o600 });
      renameSync(temporary, entry.disk.metadata);
      entry.lastCheckpoint = Date.now();
      this.storageWarning = [...this.calls.values()].find(value => value.meta.storageWarning)?.meta.storageWarning;
    } catch (error) {
      // A failed metadata checkpoint does not invalidate successfully captured raw files.
      entry.meta.storageWarning = "原始内容已落盘，但调用索引暂时无法保存：" + String((error as Error)?.message ?? error).slice(0, 500);
      this.storageWarning = entry.meta.storageWarning;
    }
  }
  /** Retry transient disk failures at completion/shutdown, using the complete fallback cache. */
  private recoverPersistence(entry: StoredCall): void {
    const raw = this.raw.get(entry.meta.callId);
    if (entry.disk?.healthy || !raw || !entry.meta.rawAvailable) return;
    let fd: number | undefined;
    try {
      this.ensureDirectory();
      const disk = this.paths(entry.meta.callId);
      writeFileSync(disk.request + ".tmp", raw.request, { encoding: "utf16le", mode: 0o600 });
      fd = openSync(disk.response + ".tmp", "w", 0o600);
      for (const chunk of raw.chunks) {
        const buffer = Buffer.from(chunk.text, "utf16le");
        let written = 0;
        while (written < buffer.length) {
          const count = writeSync(fd, buffer, written, buffer.length - written);
          if (!count) throw new Error("调用文件写入未完成");
          written += count;
        }
      }
      closeSync(fd); fd = undefined;
      renameSync(disk.request + ".tmp", disk.request);
      renameSync(disk.response + ".tmp", disk.response);
      entry.disk = disk;
      delete entry.meta.storageWarning;
      this.enforceCache();
    } catch (error) { this.persistenceFailed(entry, error); }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
  }
  private close(entry: StoredCall): void {
    if (entry.disk?.fd !== undefined) {
      try { closeSync(entry.disk.fd); } catch { /* Observation must not interrupt shutdown. */ }
      entry.disk.fd = undefined;
    }
  }
  private readResponse(file: string, offset: number, end: number): string {
    if (offset === end) return "";
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.allocUnsafe((end - offset) * 2);
      let read = 0;
      while (read < buffer.length) {
        const count = readSync(fd, buffer, read, buffer.length - read, offset * 2 + read);
        if (!count) throw new Error("调用文件内容不完整");
        read += count;
      }
      return buffer.toString("utf16le");
    } finally { closeSync(fd); }
  }
  private countResponseBytes(file: string): number {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let count = 0, carry = "", read: number;
      while ((read = readSync(fd, buffer))) {
        let text = carry + buffer.subarray(0, read).toString("utf16le");
        const last = text.charCodeAt(text.length - 1);
        carry = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : "";
        if (carry) text = text.slice(0, -1);
        count += Buffer.byteLength(text);
      }
      return count + Buffer.byteLength(carry);
    } finally { closeSync(fd); }
  }
  private cachedResponse(raw: RawCall, offset: number): string {
    let low = 0, high = raw.chunks.length;
    while (low < high) {
      const middle = (low + high) >>> 1, chunk = raw.chunks[middle]!;
      if (chunk.start + chunk.text.length <= offset) low = middle + 1; else high = middle;
    }
    return raw.chunks.slice(low).map(chunk => chunk.text.slice(Math.max(0, offset - chunk.start))).join("");
  }
  private cache(id: string, value: RawCall): void { this.bytes -= this.raw.get(id)?.bytes ?? 0; this.raw.set(id, value); this.bytes += value.bytes; }
  private enforceCache(): void {
    for (const [id, raw] of this.raw) {
      if ((raw.bytes > this.maxCallBytes || this.bytes > this.maxBytes) && this.calls.get(id)?.disk?.healthy) { this.bytes -= raw.bytes; this.raw.delete(id); }
    }
  }
  private enforceHistory(): void {
    // Retain the latest completions. A long-running call may start before hundreds of
    // short calls; its newly received final response must not immediately leave history.
    const completed = [...this.calls.values()].filter(entry => terminal(entry.meta)).sort((a, b) =>
      (a.meta.endedAt ?? a.meta.updatedAt) - (b.meta.endedAt ?? b.meta.updatedAt) ||
      a.meta.updatedAt - b.meta.updatedAt || a.meta.startedAt - b.meta.startedAt || a.meta.callId.localeCompare(b.meta.callId));
    for (const entry of completed.slice(0, Math.max(0, completed.length - this.maxCalls))) {
      const id = entry.meta.callId;
      this.close(entry); this.deleteFiles(id);
      this.bytes -= this.raw.get(id)?.bytes ?? 0;
      this.raw.delete(id); this.calls.delete(id);
    }
  }
  private deleteFiles(id: string): void {
    if (!this.directory || !validId.test(id)) return;
    for (const suffix of [".request", ".response", ".json", ".json.tmp", ".request.tmp", ".response.tmp"]) {
      try { rmSync(path.join(this.directory, id + suffix), { force: true }); } catch { /* best effort history cleanup */ }
    }
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
