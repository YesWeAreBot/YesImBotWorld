import type { StreamEntry } from "../types.js";
import { renderToolsText, type BotToolDef } from "./tools.js";

/** Persist this beside the delivered notice; it contains only model-visible definitions. */
export interface ToolAvailabilityUpdate {
  removed: string[];
  definitions: Record<string, string>;
  restored: string[];
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const TOOL_START = /^- ([A-Za-z_][A-Za-z0-9_.:-]*)\s*\(/;

/** Read both current compact indexes and historical full declarations without rewriting them. */
export function parseToolDefinitionBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];
  const flush = () => { if (name) blocks.set(name, lines.join("\n").trimEnd()); };
  for (const line of text.split("\n")) {
    const match = TOOL_START.exec(line);
    if (match) { flush(); name = match[1]!; lines = [line]; }
    else if (name) lines.push(line);
  }
  flush();
  return blocks;
}

function names(text: string): string[] {
  return text.split(/[、，,]/).map(name => name.trim()).filter(name => TOOL_NAME.test(name));
}

/** Pre-metadata notices are trusted only at their specific system-notice prefixes. */
function legacyUpdate(content: string): ToolAvailabilityUpdate | undefined {
  if (!/^(?:（当前能力发生变化|（你的能力发生了变化)/.test(content)) return undefined;
  const removed = [...content.matchAll(/(?:现在不可用：|当前界面收起：|【失效】)([^。\n（]*)/g)].flatMap(match => names(match[1]!));
  const restored = [...content.matchAll(/恢复可用：([^。\n]*)/g)].flatMap(match => names(match[1]!));
  const definitions: Record<string, string> = Object.create(null);
  // Each section is parsed separately: protocol instructions and following section headings
  // must not become part of the last tool's description and cause a false schema change.
  const body = content.replace(/）\s*$/, "");
  const sections = body.split(/^(?:现在新增可用：|以下工具的参数或语义已更新：|以下工具的用法已更新：|【新增】|【用法更新】)\s*\n/m);
  for (const section of sections.slice(1)) {
    const toolText = section.split(/^(?:原生 function 声明|置顶的可用工具列表|现在不可用：|当前界面收起：|恢复可用：|【失效】|已有动作尚未返回|这一段内心活动)/m)[0]!;
    for (const [name, block] of parseToolDefinitionBlocks(toolText)) definitions[name] = block;
  }
  return { removed, definitions, restored };
}

/**
 * Tracks what was delivered, rather than every intermediate scheduler state. prepare() is
 * side-effect free; commit() belongs after the context append succeeds. Recreate at each
 * compression window from its pinned definitions and retained events.
 */
export class ToolCapabilityAnnouncements {
  private announced = new Map<string, string>();
  private known = new Map<string, string>();

  constructor(pinnedToolsText: string, stream: readonly StreamEntry[] = []) {
    this.announced = parseToolDefinitionBlocks(pinnedToolsText);
    this.known = new Map(this.announced);
    for (const entry of stream) {
      if (entry.kind !== "event" || entry.event.source !== "system") continue;
      const event = entry.event as typeof entry.event & { toolAvailability?: ToolAvailabilityUpdate };
      const update = event.toolAvailability ?? legacyUpdate(event.content);
      if (update) this.commit(update);
    }
  }

  get names(): string[] { return [...this.announced.keys()]; }

  prepare(defs: readonly BotToolDef[], navigableNames: readonly string[] = []): { content: string; update: ToolAvailabilityUpdate } | undefined {
    const next = new Map(defs.map(def => [def.name, renderToolsText([def]).trimEnd()]));
    const removed = [...this.announced.keys()].filter(name => !next.has(name));
    const restored: string[] = [];
    const added: string[] = [];
    const changed: string[] = [];
    const definitions: Record<string, string> = Object.create(null);
    for (const [name, block] of next) {
      if (this.announced.get(name) === block) continue;
      if (!this.announced.has(name) && this.known.get(name) === block) restored.push(name);
      else {
        definitions[name] = block;
        (this.known.has(name) ? changed : added).push(block);
      }
    }
    if (!removed.length && !restored.length && !added.length && !changed.length) return undefined;
    const navigable = new Set(navigableNames);
    const folded = removed.filter(name => navigable.has(name));
    const unavailable = removed.filter(name => !navigable.has(name));
    const lines = ["（当前能力发生变化："];
    if (folded.length) lines.push(`当前界面收起：${folded.join("、")}。`);
    if (unavailable.length) lines.push(`现在不可用：${unavailable.join("、")}。`);
    if (restored.length) lines.push(`恢复可用：${restored.join("、")}。`);
    if (added.length) lines.push(`现在新增可用：\n${added.join("\n")}`);
    if (changed.length) lines.push(`以下工具的参数或语义已更新：\n${changed.join("\n")}`);
    lines.push("）");
    // Persist ordinary JSON objects so the in-memory and reloaded stream have identical shape.
    // Spread defines own properties even for names such as __proto__.
    return { content: lines.join("\n"), update: { removed, definitions: { ...definitions }, restored } };
  }

  commit(update: ToolAvailabilityUpdate): void {
    for (const name of update.removed) this.announced.delete(name);
    for (const [name, block] of Object.entries(update.definitions)) {
      this.known.set(name, block);
      this.announced.set(name, block);
    }
    for (const name of update.restored) {
      const block = this.known.get(name);
      // An old/corrupt restoration without its declaration is not proof that the model knows
      // how to use it. A later prepare will safely declare its short index entry once.
      if (block !== undefined) this.announced.set(name, block);
    }
  }
}
