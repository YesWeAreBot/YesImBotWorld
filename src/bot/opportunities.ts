import { createHash } from "node:crypto";
import type { BotEvent, ParsedToolCall, StreamEntry } from "../types.js";
import { detectDeviceRequest } from "../world/device-boundary.js";
import { allowsVoluntaryConversationCue, explicitlyAddressesSelf } from "./chat-attention.js";

/** A possible next choice, never a new perception or evidence that it was performed. */
export interface ActionOpportunity {
  id: string;
  label: string;
  intent: string;
  source: "world" | "device";
  sourceEventId: string;
  exclusiveGroup?: string;
  call?: ParsedToolCall;
  /** An already-read message's exact channel. A choice must supply its own reply text. */
  replyTo?: string;
}
export interface PerceivedDeviceContext { channelKey?: string | null }
type AvailableTool = string | { name: string };
interface WorldChoiceState { highestSequence: number | null; epoch: string; seen: string[]; epochs: string[]; choices: ActionOpportunity[] }
interface OpportunityCheckpoint {
  version: 1;
  world: WorldChoiceState;
  phoneUi: PerceivedDeviceContext;
  handledRoots: string[];
  /** A voluntary read is a conversation decision, not an unread-message cue. */
  conversationReadEventId?: string | null;
}
type CheckpointEvent = BotEvent & { opportunityCheckpoint?: OpportunityCheckpoint };
const CHECKPOINT_ID = "ev_opportunity_checkpoint";
/** Legacy contexts have one implicit local epoch until a confirmed routing transition. */
export const INITIAL_WORLD_EPOCH = "world:initial";
// The delivery layer owns full historical deduplication. A menu keeps only recent replay
// guards, not an ever-growing second message/event database inside pinned context.
const MAX_RECENT_IDENTITIES = 256;
function checkpoint(entry: StreamEntry): OpportunityCheckpoint | undefined {
  if (entry.kind !== "event" || entry.event.source !== "system" || entry.event.id !== CHECKPOINT_ID) return;
  const value = (entry.event as CheckpointEvent).opportunityCheckpoint;
  return value?.version === 1 && Array.isArray(value.world?.choices) && Array.isArray(value.world?.seen) && Array.isArray(value.handledRoots) ? value : undefined;
}
const DEVICE_TOOLS = ["pick_up_phone", "open_app", "check_msg", "select_channel", "read_channel", "send", "open_computer"];
const DEVICE_CONTEXT_CALLS = new Set([...DEVICE_TOOLS, "close_app", "put_down_phone", "observe_device"]);
const DERIVED_TOOLS = new Set(["think", "reflect", "recall_growth", "recall", "wait", "rest"]);
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown, maximum: number): string | undefined => typeof value === "string" && value.trim() && Array.from(value.trim()).length <= maximum ? value.trim() : undefined;
const stableId = (source: string, eventId: string, choice: string | number) => "opportunity_" + createHash("sha256").update(JSON.stringify([source, eventId, choice])).digest("hex").slice(0, 24);

/** Current-screen knowledge must come from delivered attention, never the controller's live device state. */
export function derivePerceivedDeviceContext(stream: readonly StreamEntry[]): PerceivedDeviceContext {
  const calls = new Map<string, Extract<StreamEntry, { kind: "tool_call" }>["call"]>();
  let channelKey: string | undefined;
  for (const entry of stream) {
    const saved = checkpoint(entry);
    if (saved) { channelKey = saved.phoneUi.channelKey ?? undefined; continue; }
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
    entry.event.experience?.historicalWorld !== true &&
    !DERIVED_TOOLS.has(calls.get(entry.event.refToolCallId ?? "") ?? "") ? [{ event: entry.event, index }] : []);
}

/** Menus survive unrelated observations; only explicit replacement or committed action results consume them. */
function worldChoiceState(stream: readonly StreamEntry[]): WorldChoiceState {
  let state: WorldChoiceState = { highestSequence: null, epoch: INITIAL_WORLD_EPOCH, seen: [], epochs: [], choices: [] };
  let seen = new Set<string>();
  const delivered = new Map(deliveredEvents(stream).map(item => [item.index, item]));
  for (const [index, entry] of stream.entries()) {
    const saved = checkpoint(entry);
    if (saved) { state = structuredClone(saved.world); state.epochs ??= []; state.epoch ??= state.epochs.at(-1) ?? INITIAL_WORLD_EPOCH; seen = new Set(state.seen); continue; }
    // Only confirmed service admission crosses sequence namespaces, never a requested journey
    // or success-looking prose. Replaying the same boundary cannot erase its subsequent scene.
    const epoch = entry.kind === "event" && entry.event.source === "system" ? entry.event.experience?.worldTransition?.epoch : undefined;
    if (typeof epoch === "string" && epoch.trim()) {
      if (!state.epochs.includes(epoch)) {
        state.choices = []; state.highestSequence = null; state.epoch = epoch; state.epochs.push(epoch); seen = new Set();
      }
      continue;
    }
    const item = delivered.get(index);
    if (!item || item.event.source !== "world" && !(item.event.source === "tool" && item.event.experience?.worldPerception === true)) continue;
    // Late receipts remain real historical outcomes, but cannot change a different world's
    // current menu or sequence. Untagged pre-upgrade history keeps its existing interpretation.
    if (item.event.experience?.worldEpoch !== undefined && item.event.experience.worldEpoch !== state.epoch) continue;
    let body = item.event.content;
    if (body.startsWith("（以下是外部操纵你身体/设备产生的回执，")) {
      const boundary = body.indexOf("\n"); if (boundary >= 0) body = body.slice(boundary + 1);
    }
    let value: Record<string, any> | undefined;
    try { value = object(JSON.parse(body)); } catch { continue; }
    const observation = object(value?.observation);
    const scene = object(observation?.scene) ?? object(value?.scene) ??
      (typeof value?.eventId === "string" && typeof value.text === "string" ? value : undefined);
    const identity = typeof scene?.eventId === "string" ? scene.eventId : item.event.id;
    if (seen.has(identity)) continue;
    const sequence = scene?.worldSequence ?? observation?.worldSequence ?? value?.worldSequence;
    if (typeof sequence === "number" && Number.isFinite(sequence)) {
      if (state.highestSequence !== null && sequence < state.highestSequence) continue;
      state.highestSequence = sequence;
    }
    seen.add(identity);
    // Issuing an intent, a validation refusal, cancellation, or failed attempt is not a new physical fact.
    // A saved beginning/completion/decision-point receipt is. Its newly offered menu follows below.
    if (["completed", "needs_input"].includes(value?.action?.status) ||
      value?.action?.status === "pending" && value.action.phase === "ongoing") state.choices = [];
    const raw = scene && Object.hasOwn(scene, "opportunities") ? scene.opportunities
      : observation && Object.hasOwn(observation, "opportunities") ? observation.opportunities
      : value && Object.hasOwn(value, "opportunities") ? value.opportunities : undefined;
    if (!Array.isArray(raw)) continue;
    const existing = new Map(state.choices.map(option => [optionMeaning(option), option]));
    const intents = new Set<string>();
    state.choices = raw.slice(0, 4).flatMap((candidate: unknown, index: number) => {
      const option = object(candidate), label = text(option?.label, 80), intent = text(option?.intent, 600);
      if (!label || !intent || intents.has(intent) || detectDeviceRequest(`${label}\n${intent}`)) return [];
      intents.add(intent);
      const exclusiveGroup = text(option?.exclusiveGroup, 80);
      const next: ActionOpportunity = { id: stableId("world", item.event.id, index), label, intent, source: "world",
        sourceEventId: item.event.id, ...(exclusiveGroup ? { exclusiveGroup } : {}), call: { name: "act", arguments: { description: intent } } };
      // An unchanged suggestion does not become a different choice just because a heartbeat rereads it.
      return [existing.get(optionMeaning(next)) ?? next];
    });
  }
  state.seen = [...seen];
  return state;
}
function optionMeaning(option: ActionOpportunity): string { return JSON.stringify([option.label, option.intent, option.exclusiveGroup ?? null]); }
function worldChoices(stream: readonly StreamEntry[]): ActionOpportunity[] { return worldChoiceState(stream).choices; }
/** Record this at operation dispatch; a later routing change cannot relabel its outcome. */
export function currentWorldEpoch(stream: readonly StreamEntry[]): string { return worldChoiceState(stream).epoch; }

function deviceChoiceFacts(stream: readonly StreamEntry[]) {
  const epoch = currentWorldEpoch(stream);
  const delivered = deliveredEvents(stream).filter(({ event }) => event.source !== "world" && event.experience?.worldPerception !== true ||
    event.experience?.worldEpoch === undefined || event.experience.worldEpoch === epoch);
  const calls = new Map(stream.flatMap(entry => entry.kind === "tool_call" ? [[entry.call.id, entry.call.name] as const] : []));
  const records = delivered.filter(({ event }) => (event.source === "koishi" || event.source === "tool") && event.experience?.worldPerception !== true);
  // A real read/send receipt retires its previous cue, even if sending was unsuccessful or uncertain.
  const handled = stream.reduce((last, entry, index) => entry.kind === "event" &&
    entry.event.experience?.internalThought !== true && entry.event.experience?.worldPerception !== true &&
    ((entry.event.source === "tool" && (["check_msg", "select_channel", "read_channel", "send"].includes(calls.get(entry.event.refToolCallId ?? "") ?? "") ||
      ["attention", "send"].includes(entry.event.experience?.chat?.kind ?? ""))) ||
      (entry.event.source === "system" && entry.event.experience?.chat?.kind === "attention")) ? index : last, -1);
  const alreadyHandled = new Set<string>();
  for (const entry of stream) for (const root of checkpoint(entry)?.handledRoots ?? []) alreadyHandled.add(root);
  for (const entry of stream.slice(0, handled + 1)) if (entry.kind === "event") {
    for (const root of entry.event.originEventIds ?? [entry.event.id]) { alreadyHandled.delete(root); alreadyHandled.add(root); }
  }
  const outstanding = records.filter(({ event, index }) => index > handled &&
    (event.originEventIds ?? [event.id]).some(root => !alreadyHandled.has(root)) &&
    (event.experience?.chat || event.originEventIds?.some(root => root.startsWith("chat-notice:"))));
  let latest = outstanding.at(-1);
  // Identical outstanding affordances are not new instructions every time another
  // message arrives. Keep their original delivered anchor until a real read/send.
  const cueKind = (event: BotEvent) => {
    const chat = event.experience?.chat;
    if (chat?.kind === "notice" || !chat && event.originEventIds?.some(root => root.startsWith("chat-notice:"))) return `notice:${chat?.channelKey ?? ""}`;
    return chat?.kind === "message" && explicitlyAddressesSelf(chat) ? `reply:${chat.channelKey}` : undefined;
  };
  const kind = latest && cueKind(latest.event);
  if (kind) for (let index = outstanding.length - 2; index >= 0; index--) {
    if (cueKind(outstanding[index]!.event) !== kind) break;
    latest = outstanding[index];
  }
  return { delivered, calls, handled, alreadyHandled, latest };
}

/** A successful voluntary read can lead to a reply, a new topic, or silence. Keep
 * that choice after consuming the notification, without repeatedly asking to read.
 * Screen updates and send echoes may preserve/retire it, but cannot originate it.
 */
function conversationChoiceSource(stream: readonly StreamEntry[]): { event: BotEvent; index: number } | undefined {
  const calls = new Map<string, Extract<StreamEntry, { kind: "tool_call" }>["call"]>();
  const sources = new Map<string, { event: BotEvent; index: number }>();
  let current: { event: BotEvent; index: number } | undefined;
  for (const [index, entry] of stream.entries()) {
    const saved = checkpoint(entry);
    if (saved) {
      // The explicit null also prevents retained audit receipts from reviving a
      // choice retired before compaction by a send or departure from the phone.
      if (Object.hasOwn(saved, "conversationReadEventId")) current = sources.get(saved.conversationReadEventId ?? "");
      if (current?.event.experience?.chat?.channelKey !== saved.phoneUi.channelKey) current = undefined;
      continue;
    }
    if (entry.kind === "tool_call") { calls.set(entry.call.id, entry.call); continue; }
    const event = entry.event, call = calls.get(event.refToolCallId ?? ""), chat = event.experience?.chat;
    if (event.experience?.worldPerception || event.experience?.historicalWorld || event.experience?.internalThought || event.source === "world") continue;
    if (chat?.kind === "send" || event.source === "tool" && call &&
      ["send", "close_app", "put_down_phone", "open_app", "pick_up_phone"].includes(call.name)) {
      current = undefined;
      continue;
    }
    if (call?.name === "observe_device" && call.arguments.device === "computer") continue;
    if (chat?.kind === "message" && chat.channelKey === current?.event.experience?.chat?.channelKey &&
      !allowsVoluntaryConversationCue(chat)) current = undefined;
    if (chat?.kind !== "attention" || !chat.channelKey?.trim()) {
      if (event.source === "tool" && call?.name === "observe_device" && call.arguments.device === "phone") current = undefined;
      continue;
    }
    const ownRead = event.source === "tool" && call && ["select_channel", "read_channel"].includes(call.name) &&
      call.control?.mode !== "puppet" && (call.role === "agent" || call.control?.mode === "avatar") &&
      event.experience?.agency !== "imposed" && event.experience?.outcome !== "failed";
    if (!ownRead) {
      if (chat.channelKey !== current?.event.experience?.chat?.channelKey) current = undefined;
      continue;
    }
    if (!allowsVoluntaryConversationCue(chat)) { current = undefined; continue; }
    // Re-reading the same snapshot while considering it does not change button
    // identity or add another identical guidance event to the cached context.
    if (current?.event.experience?.chat?.channelKey === chat.channelKey) continue;
    current = { event, index };
    sources.set(event.id, current);
  }
  return current;
}

function deviceChoices(stream: readonly StreamEntry[], names: Set<string>, phoneUi: PerceivedDeviceContext): ActionOpportunity[] {
  const { delivered, latest } = deviceChoiceFacts(stream);
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
      // Pickup can remain available as an idempotent recovery capability. Its
      // presence alone no longer proves the phone was put down.
      const heldAndUsable = names.has("put_down_phone") && names.has("open_app");
      if (!heldAndUsable) add(event, "pick-up", "pick_up_phone", "拿起手机看看", "拿起手机，再决定是否查看通知。", {});
      add(event, "message-list", "check_msg", "查看消息列表", "查看实际消息列表，确认刚才通知的来源。", { n: 10 });
      if ((!names.has("pick_up_phone") || heldAndUsable) && !names.has("check_msg")) {
        add(event, "open-chat", "open_app", "打开聊天应用", "打开聊天应用，再查看实际通知来源。", { name: "chat" });
      }
      // An anonymous signal never supplies a channel, sender, message topic or reply obligation.
      if (chat?.channelKey) {
        if (phoneUi.channelKey === chat.channelKey) add(event, "read-current", "read_channel", "查看当前频道的新消息", "读取通知已经标明的当前频道，确认实际消息。", { n: 10 });
        else add(event, "known-channel", "select_channel", "查看通知所在频道", "进入通知已经标明的频道，阅读实际消息。", { id: chat.channelKey });
      }
    } else if (chat?.kind === "message" && chat.channelKey && explicitlyAddressesSelf(chat)) {
      // The body has already been delivered. Don't instruct another read, or turn
      // every group member's utterance into an invitation addressed to the character.
      if (names.has("send")) {
        add(event, "consider-reply", "send", "考虑是否回应", "这条消息来自私聊或明确指向你的账号；是否回应由你决定。");
        choices[choices.length - 1]!.replyTo = chat.channelKey;
      }
    }
  }
  const conversation = conversationChoiceSource(stream);
  const conversationChannel = conversation?.event.experience?.chat?.channelKey;
  if (conversation && conversationChannel && phoneUi.channelKey === conversationChannel && names.has("send") &&
    !choices.some(choice => choice.replyTo === conversationChannel)) {
    add(conversation.event, "conversation", "send", "聊聊眼前的话题或近况",
      "结合已经读过的对话，决定是否回应，或分享自己实际经历的事、感受与疑问；没有想说的也可继续生活。");
    choices[choices.length - 1]!.replyTo = conversationChannel;
  }
  const anchor = delivered[0]?.event;
  if (anchor && names.has("open_computer")) add(anchor, "computer", "open_computer", "打开电脑", "打开电脑，看看有哪些可做的事情。", {});
  return choices;
}

/** Reads only delivered character history and its advertised capabilities; never queries a device or model. */
export function collectOpportunities(stream: readonly StreamEntry[], tools: readonly AvailableTool[], phoneUi: PerceivedDeviceContext = derivePerceivedDeviceContext(stream)): ActionOpportunity[] {
  const names = new Set(tools.map(tool => typeof tool === "string" ? tool : tool.name));
  return [...(names.has("act") ? worldChoices(stream) : []), ...deviceChoices(stream, names, phoneUi)].slice(0, 10);
}

/** Compact only previously delivered sources and lifecycle watermarks, never new world state.
 * These entries are metadata for future menus, not replayed model messages or growth evidence. */
export function archiveOpportunityHistory(stream: readonly StreamEntry[]): StreamEntry[] {
  const world = worldChoiceState(stream), { delivered, handled, alreadyHandled, latest } = deviceChoiceFacts(stream);
  const conversation = conversationChoiceSource(stream);
  world.seen = world.seen.slice(-MAX_RECENT_IDENTITIES);
  world.epochs = world.epochs.slice(-MAX_RECENT_IDENTITIES);
  const sourceIds = new Set(world.choices.map(option => option.sourceEventId));
  const kept = new Set<number>();
  for (const [index, entry] of stream.entries()) if (entry.kind === "event" && sourceIds.has(entry.event.id)) kept.add(index);
  if (latest) kept.add(latest.index);
  if (conversation) kept.add(conversation.index);
  if (handled >= 0) kept.add(handled);
  if (delivered.length) kept.add(delivered[delivered.length - 1]!.index);
  if (delivered.length) kept.add(delivered[0]!.index);
  // Screen knowledge itself is saved in the checkpoint; retain its source for audit/identity only.
  const selected = [...kept].sort((a, b) => a - b).map(index => stream[index]!);
  const refs = new Set(selected.flatMap(entry => entry.kind === "event" && entry.event.refToolCallId ? [entry.event.refToolCallId] : []));
  // Compaction can finish before an in-flight operation does. Keep its identity until the
  // actual tool receipt arrives, so a late empty check or screen change still retires its cue.
  const returned = new Set(stream.flatMap(entry => entry.kind === "event" && entry.event.source === "tool" && entry.event.refToolCallId ? [entry.event.refToolCallId] : []));
  for (const entry of stream) if (entry.kind === "tool_call" && DEVICE_CONTEXT_CALLS.has(entry.call.name) && !returned.has(entry.call.id)) refs.add(entry.call.id);
  const entries = stream.filter((entry, index) => kept.has(index) || entry.kind === "tool_call" && refs.has(entry.call.id));
  const saved: OpportunityCheckpoint = { version: 1, world, phoneUi: derivePerceivedDeviceContext(stream), handledRoots: [...alreadyHandled].slice(-MAX_RECENT_IDENTITIES),
    conversationReadEventId: conversation?.event.id ?? null };
  const event: CheckpointEvent = { id: CHECKPOINT_ID, source: "system", worldTime: 0, content: "", contextText: "", originEventIds: [], opportunityCheckpoint: saved };
  return [...structuredClone(entries), { kind: "event", event }];
}

/** Verify search cues against their delivered source; caller prose is not evidence or an identity grant. */
export function verifiedOpportunityQueries(stream: readonly StreamEntry[], opportunities: readonly ActionOpportunity[]): ActionOpportunity[] {
  const worlds = worldChoices(stream), allDevices = new Set(DEVICE_TOOLS);
  const ordinary = deviceChoices(stream, allDevices, {});
  const events = new Map(deliveredEvents(stream).map(({ event }) => [event.id, event]));
  const conversation = conversationChoiceSource(stream);
  // An explicitly opened empty channel has no message roots, but still proves
  // the voluntarily selected target. It does not prove anyone spoke or replied.
  if (conversation) events.set(conversation.event.id, conversation.event);
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
