import { createHash } from "node:crypto";
import type { BotEvent, RichText, ToolCallRecord } from "../types.js";
import { canonicalizeArgs } from "./repeatGuard.js";

/** Hash the actual result before presentation adds a unique spill filename. */
export function worldActionReceiptKey(call: ToolCallRecord, content: string | RichText): string {
  return createHash("sha256").update(JSON.stringify([
    call.name, call.name === "send" ? canonicalizeArgs(call.arguments) : null,
    typeof content === "string" ? content : content.text,
  ])).digest("hex");
}

/** A new chat may open bounded independent work while a World action is pending.
 * This is admission scheduling, not completion of that action or of the chat.
 * Endpoint serialization remains governed by the configured model connection. */
export class WorldActionInterleave {
  private pending = "";
  private remaining = 0;
  private ready = 0;
  private externalRoots = new Set<string>();
  private receipts = new Set<string>();

  sync(ids: readonly string[]): void {
    const key = JSON.stringify([...ids].sort());
    if (key === this.pending) return;
    this.pending = key;
    this.remaining = this.ready = 0;
    this.receipts.clear();
  }

  get canDecide(): boolean { return this.remaining > 0 && this.ready > 0; }

  consume(): void { this.remaining = Math.max(0, this.remaining - 1); this.ready = Math.max(0, this.ready - 1); }
  // A late receipt after handback cannot reopen a window deliberately closed by
  // wait/rest or manual control. Only another fresh outside event admits it again.
  pause(): void { this.remaining = this.ready = 0; }
  reset(): void { this.pending = ""; this.remaining = this.ready = 0; this.externalRoots.clear(); this.receipts.clear(); }

  external(event: BotEvent, wake: boolean): void {
    if ((event.source !== "koishi" && event.source !== "tool") || event.experience?.historicalWorld || event.experience?.internalThought ||
      event.experience?.agency === "self" || event.experience?.chat?.senderOwn || event.experience?.chat?.kind === "send") return;
    const roots = event.originEventIds ?? (event.source === "koishi" ? [event.id] : []);
    const fresh = roots.some(root => !this.externalRoots.has(root));
    for (const root of roots) this.externalRoots.add(root);
    while (this.externalRoots.size > 2048) this.externalRoots.delete(this.externalRoots.values().next().value!);
    if (event.source !== "koishi" || !wake || !fresh) return;
    this.remaining = 8;
    // One short thought/help step may precede an actual device interaction. Neither
    // its acknowledgement nor repeated reads can keep renewing that allowance.
    this.ready = 2;
  }

  receipt(event: BotEvent, call: ToolCallRecord, succeeded: boolean, key?: string): void {
    if (!succeeded || !key || !this.remaining || event.source !== "tool" || call.control || call.role !== "agent" || call.navigationFor ||
      event.experience?.historicalWorld || event.experience?.internalThought ||
      event.experience?.outcome === "failed" || event.experience?.outcome === "unknown") return;
    // Changing a read's pagination/limit without obtaining new content is not new
    // progress. Distinct confirmed sends may share a generic platform acknowledgement.
    const signatures = call.name !== "send" && event.originEventIds?.length
      ? event.originEventIds.map(root => `root:${root}`) : [`result:${key}`];
    const fresh = signatures.some(signature => !this.receipts.has(signature));
    for (const signature of signatures) this.receipts.add(signature);
    while (this.receipts.size > 4096) this.receipts.delete(this.receipts.values().next().value!);
    if (!fresh) return;
    this.ready = Math.max(this.ready, 1);
  }
}
