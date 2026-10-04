import { createHash } from "node:crypto";
import type { BotEvent, StreamEntry, ToolCallRecord } from "../types.js";
import { detectDeviceClaim } from "../world/device-boundary.js";
import { currentWorldEpoch, derivePerceivedDeviceContext, type PerceivedDeviceContext } from "./opportunities.js";
import { allowsVoluntaryConversationCue, explicitlyAddressesSelf } from "./chat-attention.js";

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

/** Optional recall at a chat read or a fresh message in the conversation already being viewed.
 * Notifications, other conversations and self echoes do not create a sharing obligation.
 * Derive from the append-only stream so restart/re-reading cannot keep prompting the same material.
 * Normal compression retires both the source window and its cues; the summary retains experiences.
 */
export function conversationMaterialReminder(stream: readonly StreamEntry[], worldTime: number,
  perceived: PerceivedDeviceContext & { worldEpoch?: string } = derivePerceivedDeviceContext(stream)): BotEvent | undefined {
  const calls = new Map<string, ToolCallRecord>();
  const sources = new Set<string>(), bodies = new Set<string>(), seenMessages = new Set<string>();
  const materials: Material[] = [];
  const epoch = perceived.worldEpoch ?? currentWorldEpoch(stream);
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
    // A send's automatic history echo is not a fresh decision to visit a conversation.
    // Actual new messages can prompt recall only in the already-known visible channel.
    // A replay of a row previously included in a history snapshot is not a new message.
    const chat = event.experience?.chat;
    const messageRoots = (event.originEventIds ?? []).filter(root => root.startsWith("chat-message:"));
    const freshVisibleMessage = event.source === "koishi" && chat?.kind === "message" && explicitlyAddressesSelf(chat) &&
      event.experience?.agency !== "imposed" && !event.experience?.worldPerception && !event.experience?.internalThought &&
      chat.channelKey === perceived.channelKey && messageRoots.some(root => !seenMessages.has(root));
    for (const root of messageRoots) seenMessages.add(root);
    // A newer exchange between other people cannot inherit an old "share now"
    // cue from our previous read. The underlying lived memories remain untouched.
    if (chat && ["message", "attention"].includes(chat.kind) && chat.channelKey === perceived.channelKey &&
      !allowsVoluntaryConversationCue(chat)) { attention = -1; channel = undefined; }
    if ((event.source === "tool" && own(call) && ["select_channel", "read_channel"].includes(call!.name) &&
      event.experience?.agency !== "imposed" && event.experience?.outcome !== "failed" && chat?.kind === "attention" &&
      allowsVoluntaryConversationCue(chat)) || freshVisibleMessage) {
      attention = index; channel = chat!.channelKey;
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
  if (attention <= consumedThrough || !channel || perceived.channelKey !== channel) return;
  const selected = materials.filter(item => item.index > consumedThrough && item.index < attention).slice(-2);
  if (!selected.length) return;
  const read = stream[attention] as Extract<StreamEntry, { kind: "event" }>;
  return {
    id: NOTICE_ID + digest(JSON.stringify([read.event.id, selected.map(item => item.event.id)])),
    source: "system", originEventIds: [], worldTime,
    content: CONVERSATION_MATERIAL_PREFIX + "\n" +
      "当前正在看的会话里，也可以谈起自己的实际经历；先顾及对方正在说什么，是否切题、适合公开、此刻想说由你决定。不必汇报每段经历或先 think。以下是旧感知的原文片段，不证明平台消息或软件内容，也不替你认定感受。\n" +
      selected.map(item => `来源 ${item.event.id} · ${item.observedAt === undefined ? `交付时刻 ${item.event.worldTime} TU（经历时刻未提供）` : `经历时刻 ${item.observedAt} TU`} · ${item.state}${item.event.experience?.historicalWorld || item.event.experience?.worldEpoch !== undefined && item.event.experience.worldEpoch !== epoch ? " · 先前世界的经历，不代表当前处境" : ""}\n${excerpt(item.text)}`).join("\n\n") +
      "\n想分享就用自己的话表达；不用来源标签，不把未发生的后续说成完成，不要求对方回应。没有想说的也可继续生活。",
  };
}
