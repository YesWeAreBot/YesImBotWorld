import { createHash } from "node:crypto";
import type { BotEvent, StreamEntry, ToolCallRecord } from "../types.js";
import { detectDeviceClaim } from "../world/device-boundary.js";
import { derivePerceivedDeviceContext } from "./opportunities.js";

const NOTICE_ID = "ev_conversation_material_";
export const CONVERSATION_MATERIAL_PREFIX = "（谈话前可回想的亲历片段；不是新事件，也不是待发消息。）";
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const own = (call: ToolCallRecord | undefined) => !!call && call.control?.mode !== "puppet" &&
  (call.role === "agent" || call.control?.mode === "avatar");
const excerpt = (text: string) => {
  const chars = Array.from(text.trim());
  return chars.length <= 420 ? text.trim() : chars.slice(0, 420).join("") + "〔片段未完，细节以原事件为准〕";
};

interface Material { event: BotEvent; index: number; text: string; state: string; observedAt?: number }

/** Only a dispatched, self-chosen physical action's delivered narration is a personal episode.
 * Suggestions, passive world updates, web pages, thoughts and administrative body control
 * cannot pass this boundary. A pending/failed action may still have real, limited progress.
 */
function material(event: BotEvent, call: ToolCallRecord | undefined, index: number): Material | undefined {
  if (!own(call) || call?.name !== "act" || !["tool", "world"].includes(event.source) ||
    event.experience?.agency !== "self" || event.experience.worldPerception !== true ||
    event.experience.internalThought || event.originEventIds?.length === 0 || event.parts?.length || event.attachments?.length) return;
  try {
    const raw = JSON.parse(event.content), observation = raw?.observation;
    if (raw.recovered === true || observation?.mode !== "narrative" || observation.actorId !== "bot" ||
      typeof observation.observationId !== "string" || !raw.action) return;
    const states: Record<string, string> = { completed: "已完成的实际经过", pending: "仅已发生的进展，尚未结束",
      needs_input: "已推进到新的决定点，后续未执行", failed: "未能完成的实际经过" };
    const state = states[raw.action.status];
    if (!state || (raw.action.status === "completed" && event.experience.outcome !== "completed")) return;
    const text = observation.narrative ?? observation.scene?.text ?? raw.scene?.text;
    if (typeof text !== "string" || !text.trim() || detectDeviceClaim(text)) return;
    const observedAt = observation.scene?.worldTime ?? raw.scene?.worldTime ?? observation.observedAt;
    return { event, index, text, state, ...(typeof observedAt === "number" && Number.isFinite(observedAt) ? { observedAt } : {}) };
  } catch { return; }
}

/** Optional recall at an explicit chat read, not a timer, message-triggered reply, or posting queue.
 * Derive from the append-only stream so restart/re-reading cannot keep prompting the same material.
 * Normal compression retires both the source window and its cues; the summary retains experiences.
 */
export function conversationMaterialReminder(stream: readonly StreamEntry[], worldTime: number): BotEvent | undefined {
  const calls = new Map<string, ToolCallRecord>();
  const sources = new Set<string>(), bodies = new Set<string>();
  const materials: Material[] = [];
  let lastCue = -1, lastSend = -1, attention = -1, channel: string | undefined;
  for (const [index, entry] of stream.entries()) {
    if (entry.kind === "tool_call") {
      calls.set(entry.call.id, entry.call);
      if (entry.call.name === "send") lastSend = index;
      continue;
    }
    const event = entry.event, call = calls.get(event.refToolCallId ?? "");
    if (event.experience?.chat?.kind === "send") lastSend = index;
    if (event.source === "system" && event.originEventIds?.length === 0 &&
      event.id.startsWith(NOTICE_ID) && event.content.startsWith(CONVERSATION_MATERIAL_PREFIX)) lastCue = index;
    // A send's automatic history echo and incoming notifications are not a fresh decision
    // to visit a conversation. Private controller reads also must not cue public sharing.
    if (event.source === "tool" && own(call) && ["select_channel", "read_channel"].includes(call!.name) &&
      event.experience?.agency !== "imposed" && event.experience?.chat?.kind === "attention") {
      attention = index; channel = event.experience.chat.channelKey;
    }
    const item = material(event, call, index);
    if (!item) continue;
    const roots = event.originEventIds?.length ? event.originEventIds : [event.id];
    const body = digest(item.text.trim());
    const duplicate = roots.some(root => sources.has(root)) || bodies.has(body);
    for (const root of roots) sources.add(root);
    bodies.add(body);
    if (!duplicate) materials.push(item);
  }
  // A send may already have shared any earlier episode. Without interpreting its prose,
  // conservatively consume earlier suggestions across channels, even for failed/unknown
  // attempts. This retires only the cue eligibility, never the underlying memory.
  const consumedThrough = Math.max(lastCue, lastSend);
  if (attention <= consumedThrough || !channel || derivePerceivedDeviceContext(stream).channelKey !== channel) return;
  const selected = materials.filter(item => item.index > consumedThrough && item.index < attention).slice(-2);
  if (!selected.length) return;
  const read = stream[attention] as Extract<StreamEntry, { kind: "event" }>;
  return {
    id: NOTICE_ID + digest(JSON.stringify([read.event.id, selected.map(item => item.event.id)])),
    source: "system", originEventIds: [], worldTime,
    content: CONVERSATION_MATERIAL_PREFIX + "\n" +
      "刚读过会话时，也可以想起自己生活里发生过什么；是否公开、是否切题、是否此刻想说由你决定。无需先附和最后一句、把每段经历都汇报，或为了分享先 think；不合适就继续做自己的事。以下只是物理世界旧感知的原文片段，不证明平台消息或软件内容；发生时刻不等于现在，也不替你认定感受。\n" +
      selected.map(item => `来源 ${item.event.id} · ${item.observedAt === undefined ? `交付时刻 ${item.event.worldTime} TU（经历时刻未提供）` : `经历时刻 ${item.observedAt} TU`} · ${item.state}\n${excerpt(item.text)}`).join("\n\n") +
      "\n若想分享，只说自己确实愿意表达的部分，不转发这些来源标签，不把未发生的后续说成完成，也不要求对方回应。",
  };
}
