import type { ParsedToolCall, PhoneStatus } from "../types.js";
import { canReachPhone, phonePhysicalState, phoneUnavailableReason } from "../phone-state.js";
import { toolLayer } from "./tools.js";

export interface NavigationState {
  phone: PhoneStatus;
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

/** Plan only reversible interface navigation. Missing identities and physical obstacles are
 * not guessed; every returned step must actually execute and deliver its own receipt.
 */
export async function planToolNavigation(
  call: ParsedToolCall, state: NavigationState,
  resolveChannel: (id: string) => Promise<{ key: string; isPrivate: boolean } | { error: string }>,
): Promise<NavigationPlan> {
  const steps: ParsedToolCall[] = [];
  const add = (name: string, args: Record<string, unknown> = {}) => steps.push({ name, arguments: args, duration: 0 });
  if (!state.device || ["pick_up_phone", "put_down_phone", "observe_device", "close_computer", "close_app"].includes(call.name)) return { steps };
  if (state.device === "computer") {
    if (!state.computerAvailable) return { steps: [], error: "电脑不可用。" };
    if (call.name !== "open_computer" && !state.computerOpen) add("open_computer");
    return { steps };
  }
  if (!canReachPhone(state.phone) || !phonePhysicalState(state.phone).usable) return { steps: [], error: phoneUnavailableReason(state.phone) ?? "手机暂时无法使用。" };
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
  if (state.phone.down) add("pick_up_phone");
  if (layer !== "core") {
    if (!state.chatOpen) add("open_app", { name: state.chatApp });
    if (target && call.name !== "select_channel" && (!state.chatOpen || target.key !== state.channelKey)) add("select_channel", { id: target.key });
  } else if (state.app && state.activeAppId !== state.app.id) add("open_app", { name: state.app.id });
  return { steps };
}
