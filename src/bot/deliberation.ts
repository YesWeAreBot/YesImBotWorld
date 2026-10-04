import { createHash } from "node:crypto";
import type { BotEvent, ParsedToolCall, StreamEntry, ToolCallRecord } from "../types.js";
import { canonicalizeArgs } from "./repeatGuard.js";

/** Scheduling backoff is not lost ability, fatigue, sleep, or a bodily change. */
export class DeliberationBudget {
  private thoughts = new Set<string>();
  private thoughtCount = 0;
  private roots = new Set<string>();

  constructor(entries: StreamEntry[] = []) {
    const calls = new Map<string, ToolCallRecord>();
    for (const entry of entries) {
      if (entry.kind === "tool_call") {
        calls.set(entry.call.id, entry.call);
        if (entry.call.name === "think" && entry.call.role === "agent" && !thoughtError(entry.call.arguments.thought)) {
          this.recordThought(entry.call.arguments.thought as string);
        }
      } else this.perceive(entry.event, calls.get(entry.event.refToolCallId ?? ""));
    }
  }

  /** Continuous monologue can yield computation without declaring thought unavailable. */
  get pauseMs(): number { return this.thoughtCount < 3 ? 0 : Math.min(30_000, 1000 * 2 ** Math.min(5, this.thoughtCount - 3)); }

  hasThought(thought: string): boolean { return this.thoughts.has(thought.trim().replace(/\s+/gu, " ")); }

  recordThought(thought: string): void {
    this.thoughtCount++;
    this.thoughts.add(thought.trim().replace(/\s+/gu, " "));
    while (this.thoughts.size > 128) this.thoughts.delete(this.thoughts.values().next().value!);
  }

  /** Rereads, timers and our own acknowledgements cannot restart an inner monologue. */
  perceive(event: BotEvent, call?: ParsedToolCall): boolean {
    if (event.source === "system" || event.experience?.internalThought ||
      ["think", "wait", "rest", "reflect", "recall_growth", "recall"].includes(call?.name ?? "")) return false;
    // Legacy/local readers may have no event provenance. Reading the same note or screen
    // twice is still the same input, even though its acknowledgement gets a new event ID.
    const roots = event.originEventIds ?? [event.source === "tool"
      ? "receipt:" + createHash("sha256").update(JSON.stringify([call?.name, canonicalizeArgs(call?.arguments ?? {}), event.content])).digest("hex")
      : event.id];
    const fresh = roots.some(root => !this.roots.has(root));
    for (const root of roots) this.roots.add(root);
    while (this.roots.size > 4096) this.roots.delete(this.roots.values().next().value!);
    if (!fresh) return false;
    this.thoughts.clear();
    this.thoughtCount = 0;
    return true;
  }
}

export function thoughtError(thought: unknown): string | undefined {
  if (typeof thought !== "string" || !thought.trim()) return "think.thought 须是一段非空的内心独白。";
  if (Array.from(thought).length > 1200) return "think.thought 最多 1200 字，请只留下这一刻有意义的想法。";
}
