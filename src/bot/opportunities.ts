import { createHash } from "node:crypto";
import type { BotEvent, ParsedToolCall, StreamEntry } from "../types.js";

/** A possible next choice, never a new perception or evidence that it was performed. */
export interface ActionOpportunity {
  id: string;
  label: string;
  intent: string;
  source: "world" | "device";
  sourceEventId: string;
  exclusiveGroup?: string;
  call?: ParsedToolCall;
}
export interface PerceivedDeviceContext { channelKey?: string | null }
type AvailableTool = string | { name: string };
const DEVICE_TOOLS = ["pick_up_phone", "open_app", "check_msg", "select_channel", "read_channel", "send", "open_computer"];
const DERIVED_TOOLS = new Set(["think", "reflect", "recall_growth", "recall", "wait", "rest"]);
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown, maximum: number): string | undefined => typeof value === "string" && value.trim() && Array.from(value.trim()).length <= maximum ? value.trim() : undefined;
const stableId = (source: string, eventId: string, choice: string | number) => "opportunity_" + createHash("sha256").update(JSON.stringify([source, eventId, choice])).digest("hex").slice(0, 24);

/** Current-screen knowledge must come from delivered attention, never the controller's live device state. */
export function derivePerceivedDeviceContext(stream: readonly StreamEntry[]): PerceivedDeviceContext {
  const calls = new Map<string, Extract<StreamEntry, { kind: "tool_call" }>["call"]>();
  let channelKey: string | undefined;
  for (const entry of stream) {
    if (entry.kind === "tool_call") { calls.set(entry.call.id, entry.call); continue; }
    const event = entry.event;
    if (event.source === "world" || event.experience?.internalThought === true || event.experience?.worldPerception === true) continue;
    const call = calls.get(event.refToolCallId ?? "");
    if (call?.name === "observe_device" && call.arguments.device === "computer") continue;
    const chat = event.experience?.chat;
    if (chat?.kind === "attention" && typeof chat.channelKey === "string" && chat.channelKey.trim()) {
      channelKey = chat.channelKey; continue;
    }
    // A notice, incoming message or send receipt names a conversation, not the visible screen.
    if (event.source !== "tool") continue;
    if (!call) continue;
    const own = call.role === "agent" || call.control?.mode === "avatar";
    if ((own && ["open_app", "close_app", "put_down_phone", "pick_up_phone"].includes(call.name)) ||
      (call.name === "observe_device" && call.arguments.device === "phone")) {
      // A final receipt without screen metadata no longer substantiates the previous channel.
      // This conservative invalidation does not claim a possibly failed app operation succeeded.
      channelKey = undefined;
    }
  }
  return channelKey === undefined ? {} : { channelKey };
}

function deliveredEvents(stream: readonly StreamEntry[]): { event: BotEvent; index: number }[] {
  const calls = new Map(stream.flatMap(entry => entry.kind === "tool_call" ? [[entry.call.id, entry.call.name] as const] : []));
  return stream.flatMap((entry, index) => entry.kind === "event" && entry.event.source !== "system" &&
    entry.event.experience?.internalThought !== true && entry.event.originEventIds?.length !== 0 &&
    !DERIVED_TOOLS.has(calls.get(entry.event.refToolCallId ?? "") ?? "") ? [{ event: entry.event, index }] : []);
}

/** Late receipts and repeated projections cannot restore an older scene or undo a new action. */
function currentWorldScene(stream: readonly StreamEntry[]): { event: BotEvent; scene?: Record<string, any>; index: number } | undefined {
  let current: { event: BotEvent; scene?: Record<string, any>; index: number } | undefined, highestSequence = -Infinity;
  const seen = new Set<string>();
  const delivered = new Map(deliveredEvents(stream).map(item => [item.index, item]));
  for (const [index, entry] of stream.entries()) {
    // Sequences belong to one world. A journey invalidates the old scene and
    // resets its watermark; already-delivered scene identities remain retired.
    if (entry.kind === "tool_call" && ["travel", "go_home"].includes(entry.call.name)) {
      current = undefined; highestSequence = -Infinity; continue;
    }
    const item = delivered.get(index);
    if (!item) continue;
    if (item.event.source !== "world" && !(item.event.source === "tool" && item.event.experience?.worldPerception === true)) continue;
    let value: Record<string, any> | undefined;
    let body = item.event.content;
    if (body.startsWith("（以下是外部操纵你身体/设备产生的回执，")) {
      const boundary = body.indexOf("\n"); if (boundary >= 0) body = body.slice(boundary + 1);
    }
    try { value = object(JSON.parse(body)); } catch { /* Unstructured new perceptions invalidate stale options. */ }
    const observation = object(value?.observation);
    const scene = object(observation?.scene) ?? object(value?.scene) ??
      (typeof value?.eventId === "string" && typeof value.text === "string" ? value : undefined);
    const identity = typeof scene?.eventId === "string" ? scene.eventId : item.event.id;
    if (seen.has(identity)) continue;
    const sequence = scene?.worldSequence ?? observation?.worldSequence ?? value?.worldSequence;
    if (typeof sequence === "number" && Number.isFinite(sequence)) {
      if (sequence < highestSequence) continue;
      highestSequence = sequence;
    }
    seen.add(identity); current = { ...item, scene };
  }
  if (!current) return;
  if (stream.slice(current.index + 1).some(entry => entry.kind === "tool_call" && ["act", "travel", "go_home"].includes(entry.call.name))) return;
  return current;
}

function worldChoices(stream: readonly StreamEntry[]): ActionOpportunity[] {
  const current = currentWorldScene(stream);
  if (!current || !Array.isArray(current.scene?.opportunities)) return [];
  const seen = new Set<string>();
  return current.scene.opportunities.slice(0, 4).flatMap((value: unknown, index: number) => {
    const option = object(value), label = text(option?.label, 80), intent = text(option?.intent, 600);
    if (!label || !intent || seen.has(intent)) return [];
    seen.add(intent);
    const exclusiveGroup = text(option?.exclusiveGroup, 80);
    return [{ id: stableId("world", current.event.id, index), label, intent, source: "world" as const,
      sourceEventId: current.event.id, ...(exclusiveGroup ? { exclusiveGroup } : {}), call: { name: "act", arguments: { description: intent } } }];
  });
}

function deviceChoices(stream: readonly StreamEntry[], names: Set<string>, phoneUi: PerceivedDeviceContext): ActionOpportunity[] {
  const delivered = deliveredEvents(stream);
  const calls = new Map(stream.flatMap(entry => entry.kind === "tool_call" ? [[entry.call.id, entry.call.name] as const] : []));
  const records = delivered.filter(({ event }) => (event.source === "koishi" || event.source === "tool") && event.experience?.worldPerception !== true);
  // Retire the old cue after a read/send receipt. This does not declare the operation
  // successful: unknown sends in particular must not keep provoking another reply.
  const handled = stream.reduce((last, entry, index) => entry.kind === "event" &&
    entry.event.experience?.internalThought !== true && entry.event.experience?.worldPerception !== true &&
    ((entry.event.source === "tool" && (["check_msg", "select_channel", "read_channel", "send"].includes(calls.get(entry.event.refToolCallId ?? "") ?? "") ||
      ["attention", "send"].includes(entry.event.experience?.chat?.kind ?? ""))) ||
      (entry.event.source === "system" && entry.event.experience?.chat?.kind === "attention")) ? index : last, -1);
  const alreadyHandled = new Set(stream.slice(0, handled + 1).flatMap(entry => entry.kind === "event" ? entry.event.originEventIds ?? [entry.event.id] : []));
  const latest = [...records].reverse().find(({ event, index }) => index > handled &&
    (event.originEventIds ?? [event.id]).some(root => !alreadyHandled.has(root)) &&
    (event.experience?.chat || event.originEventIds?.some(root => root.startsWith("chat-notice:"))));
  const choices: ActionOpportunity[] = [];
  const add = (event: BotEvent, key: string, tool: string, label: string, intent: string, args?: Record<string, unknown>) => {
    if (!names.has(tool)) return;
    choices.push({ id: stableId("device", event.id, key), label, intent, source: "device", sourceEventId: event.id,
      ...(args ? { call: { name: tool, arguments: args } } : {}) });
  };
  if (latest) {
    const { event } = latest, chat = event.experience?.chat;
    const notice = chat?.kind === "notice" || (!chat && event.originEventIds?.some(root => root.startsWith("chat-notice:")));
    if (notice) {
      add(event, "pick-up", "pick_up_phone", "拿起手机看看", "拿起手机，再决定是否查看通知。", {});
      add(event, "message-list", "check_msg", "查看消息列表", "查看实际消息列表，确认刚才通知的来源。", { n: 10 });
      if (!names.has("pick_up_phone") && !names.has("check_msg")) {
        add(event, "open-chat", "open_app", "打开聊天应用", "打开聊天应用，再查看实际通知来源。", { name: "chat" });
      }
      // An anonymous signal never supplies a channel, sender, message topic or reply obligation.
      if (chat?.channelKey) {
        if (phoneUi.channelKey === chat.channelKey) add(event, "read-current", "read_channel", "查看当前频道的新消息", "读取通知已经标明的当前频道，确认实际消息。", { n: 10 });
        else add(event, "known-channel", "select_channel", "查看通知所在频道", "进入通知已经标明的频道，阅读实际消息。", { id: chat.channelKey });
      }
    } else if ((chat?.kind === "message" || chat?.kind === "attention") && chat.channelKey) {
      if (phoneUi.channelKey === chat.channelKey) {
        add(event, "read-current", "read_channel", "回看当前对话", "回看已经进入的频道，确认上下文。", { n: 10 });
      } else {
        add(event, "known-channel", "select_channel", "查看已经知道的对话", "进入已经读到其记录的频道，确认当前对话。", { id: chat.channelKey });
      }
      // Only an actual non-self message can cue considering a reply; no generated text or send call.
      if (chat.kind === "message" && chat.senderOwn === false) {
        add(event, "consider-reply", "send", "考虑是否回应", "考虑是否需要回应已经读到的消息；若决定回复，再自行组织内容。");
      }
    }
  }
  const anchor = delivered.at(-1)?.event;
  if (anchor && names.has("open_computer")) add(anchor, "computer", "open_computer", "打开电脑", "打开电脑，看看有哪些可做的事情。", {});
  return choices;
}

/** Reads only delivered character history and its advertised capabilities; never queries a device or model. */
export function collectOpportunities(stream: readonly StreamEntry[], tools: readonly AvailableTool[], phoneUi: PerceivedDeviceContext = derivePerceivedDeviceContext(stream)): ActionOpportunity[] {
  const names = new Set(tools.map(tool => typeof tool === "string" ? tool : tool.name));
  return [...(names.has("act") ? worldChoices(stream) : []), ...deviceChoices(stream, names, phoneUi)].slice(0, 10);
}

/** Verify search cues against their delivered source; caller prose is not evidence or an identity grant. */
export function verifiedOpportunityQueries(stream: readonly StreamEntry[], opportunities: readonly ActionOpportunity[]): ActionOpportunity[] {
  const worlds = worldChoices(stream), allDevices = new Set(DEVICE_TOOLS);
  const ordinary = deviceChoices(stream, allDevices, {});
  const events = new Map(deliveredEvents(stream).map(({ event }) => [event.id, event]));
  return opportunities.slice(0, 10).flatMap(candidate => {
    const event = events.get(candidate.sourceEventId);
    if (!event) return [];
    const knownChannel = event.experience?.chat?.channelKey;
    const canonical = candidate.source === "world" ? worlds : [...ordinary, ...deviceChoices(stream, allDevices, { channelKey: knownChannel }),
      ...deviceChoices(stream, new Set([candidate.call?.name ?? "send"]), { channelKey: knownChannel })];
    const found = canonical.find(item => item.id === candidate.id && item.sourceEventId === candidate.sourceEventId && item.intent === candidate.intent && item.label === candidate.label);
    return found ? [found] : [];
  });
}
