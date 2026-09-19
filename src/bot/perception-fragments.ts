import { createHash } from "node:crypto";
import { richPartsText } from "../media/presentation.js";
import type { BotEvent, RichTextPart, StreamEntry } from "../types.js";

/**
 * Project only program-marked message parts from the durable actor context.
 * The caller supplies an ID, never a replacement parent body or guessed delimiter.
 * null preserves conservative treatment of legacy or inconsistent projections.
 */
export function projectObservedMessages(parentEventId: string, stream: readonly StreamEntry[]): BotEvent[] | null {
  const entry = stream.find(item => item.kind === "event" && item.event.id === parentEventId);
  if (!entry || entry.kind !== "event") throw Error("消息投影的父事件尚未交付，不能读取未感知材料");
  const parent = entry.event;
  if ((parent.source !== "tool" && parent.source !== "koishi") || !parent.parts?.length || !parent.originEventIds?.length) return null;
  const roots = new Set(parent.originEventIds);
  const groups: { root: string; metadata: NonNullable<RichTextPart["observedMessage"]>; indexes: number[] }[] = [];
  let previous: (typeof groups)[number] | undefined;
  for (const [index, part] of parent.parts.entries()) {
    const metadata = part.observedMessage;
    if (!metadata) { previous = undefined; continue; }
    if (!Array.isArray(metadata.originEventIds) || metadata.originEventIds.length !== 1 ||
      typeof metadata.originEventIds[0] !== "string" || !metadata.originEventIds[0].startsWith("chat-message:") || !roots.has(metadata.originEventIds[0]) ||
      !metadata.experience || metadata.experience.agency !== "observed" || metadata.experience.worldPerception === true ||
      (metadata.experience.outcome !== undefined && metadata.experience.outcome !== "unknown") || metadata.experience.opportunity === true) return null;
    const root = metadata.originEventIds[0];
    if (previous?.root === root) {
      if (JSON.stringify(previous.metadata) !== JSON.stringify(metadata)) return null;
      previous.indexes.push(index);
    } else {
      // One platform message represented inconsistently twice is not safe to split.
      if (groups.some(group => group.root === root)) return null;
      previous = { root, metadata, indexes: [index] }; groups.push(previous);
    }
  }
  if (!groups.length || groups.length !== roots.size || groups.some(group => !roots.has(group.root))) return null;
  return groups.map(group => {
    const parts = group.indexes.map(index => {
      const { observedMessage: _metadata, ...visible } = parent.parts![index]!;
      return structuredClone(visible) as RichTextPart;
    });
    const text = richPartsText(parts);
    const id = "ev_message_" + createHash("sha256").update(JSON.stringify([parent.id, group.root])).digest("hex").slice(0, 24);
    return { id, source: "koishi", worldTime: parent.worldTime, content: text, contextText: text, parts,
      originEventIds: [group.root], experience: structuredClone(group.metadata.experience),
      perceptionOf: { eventId: parent.id, partIndexes: [...group.indexes] } };
  });
}
