import type { ParsedToolCall, PhoneStatus } from "../types.js";
import { canReachPhone, phonePhysicalState, phoneUnavailableReason } from "../phone-state.js";
import { toolLayer } from "./tools.js";

export interface NavigationState {
  phone: PhoneStatus;
  /** An explicit pick-up will commit restoration before any software operation. */
  unrestrictedPhone?: boolean;
  chatOpen: boolean;
  channelKey: string | null;
  channelIsGroup: boolean;
  chatApp: string;
  builtin: boolean;
  device: "phone" | "computer" | null;
  app?: { id: string; name: string } | null;
  activeAppId?: string | null;
  computerOpen?: boolean;
  computerAvailable?: boolean;
}

export type NavigationPlan = { steps: ParsedToolCall[]; error?: undefined } | { steps: []; error: string };

/** Sending must bind an explicit target, even with an old cached tool schema. */
export function sendTargetError(args: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(args, "id") || typeof args.id !== "string" || !args.id.trim()) {
    return "本次未发送：send 需要明确的频道 id（非空字符串）。";
  }
  if (Object.hasOwn(args, "channel")) return "本次未发送：send 的目标只用 id，不使用 channel。";
}

/** Report a misspelled target before treating the request as an implicit read.
 * Never recover an address from these fields or fall back to the visible channel.
 * user_id remains a valid member selector for group operations.
 */
export function misusedTargetKeys(args: Record<string, unknown>): string[] {
  if (args.id != null || args.channel != null) return [];
  return ["detail", "channel_id", "channelId", "target", "to", "group_id"].filter(key => args[key] != null);
}

export function channelTargetError(call: ParsedToolCall): string | undefined {
  const layer = toolLayer(call.name);
  if (layer === "core") return;
  const misused = misusedTargetKeys(call.arguments);
  if (misused.length) return `${call.name} 不接受 ${misused.join("、")}；目标频道参数请改用 id。本次未执行。`;
  if (call.name === "send") {
    const error = sendTargetError(call.arguments);
    if (error) return error;
  }
  if (layer !== "channel" && layer !== "group" && call.name !== "select_channel") return;
  if (!Object.hasOwn(call.arguments, "id") && !Object.hasOwn(call.arguments, "channel")) return;
  const raw = call.arguments.id ?? call.arguments.channel;
  if (typeof raw !== "string" || !raw.trim()) return `${call.name} 的 id 必须为非空频道字符串。本次未执行。`;
  const id = raw.trim();
  if (id.length > 1 && (id[0] === '"' || id[0] === "'") && id.at(-1) === id[0]) {
    return `${call.name} 的频道值包含额外引号，请去掉值两端的引号。本次未执行。`;
  }
}

/** Plan only reversible interface navigation. Missing identities and physical obstacles are
 * not guessed; every returned step must actually execute and deliver its own receipt.
 */
export async function planToolNavigation(
  call: ParsedToolCall, state: NavigationState,
  resolveChannel: (id: string) => Promise<{ key: string; isPrivate: boolean } | { error: string }>,
): Promise<NavigationPlan> {
  const steps: ParsedToolCall[] = [];
  const targetError = state.builtin ? channelTargetError(call) : undefined;
  if (targetError) return { steps: [], error: targetError };
  const add = (name: string, args: Record<string, unknown> = {}) => steps.push({ name, arguments: args, duration: 0 });
  if (!state.device || ["pick_up_phone", "put_down_phone", "observe_device", "close_computer", "close_app"].includes(call.name)) return { steps };
  if (state.device === "computer") {
    if (!state.computerAvailable) return { steps: [], error: "电脑不可用。" };
    if (call.name !== "open_computer" && !state.computerOpen) add("open_computer");
    return { steps };
  }
  const physical = phonePhysicalState(state.phone);
  const restore = state.unrestrictedPhone === true && (!physical.reachable || !physical.usable || !physical.perceptible);
  if (!restore && (!physical.reachable || !physical.usable)) return { steps: [], error: phoneUnavailableReason(state.phone) ?? "手机暂时无法使用。" };
  const layer = state.builtin ? toolLayer(call.name) : "core";
  if (!state.builtin && !state.app) return { steps: [], error: "尚未确认此工具所属应用。" };
  let target: { key: string; isPrivate: boolean } | undefined;
  if (layer === "channel" || layer === "group" || call.name === "select_channel") {
    const explicit = Object.hasOwn(call.arguments, "id") || Object.hasOwn(call.arguments, "channel");
    const raw = call.arguments.id ?? call.arguments.channel;
    if (explicit && (typeof raw !== "string" || !raw.trim())) return { steps: [], error: "id 必须为有效频道。" };
    const id = explicit ? String(raw).trim() : call.name !== "select_channel" && state.chatOpen ? state.channelKey : null;
    if (!id) return { steps: [], error: "缺少目标频道：填写 id，或先选择频道。" };
    const resolved = await resolveChannel(id);
    if ("error" in resolved) return { steps: [], error: resolved.error };
    if (layer === "group" && resolved.isPrivate) return { steps: [], error: "此操作需要群聊频道。" };
    target = resolved;
  }
  if (state.phone.down || restore) add("pick_up_phone");
  if (layer !== "core") {
    if (!state.chatOpen) add("open_app", { name: state.chatApp });
    if (target && call.name !== "select_channel" && (!state.chatOpen || target.key !== state.channelKey)) add("select_channel", { id: target.key });
  } else if (state.app && state.activeAppId !== state.app.id) add("open_app", { name: state.app.id });
  return { steps };
}
