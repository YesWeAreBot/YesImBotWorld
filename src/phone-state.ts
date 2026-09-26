import type { PhonePhysicalState, PhoneStatus } from "./types.js";

/** Legacy worlds retain their old usable-phone behavior without inventing a recorded location. */
export const DEFAULT_PHONE_PHYSICAL_STATE: Readonly<PhonePhysicalState> = Object.freeze({
  reachable: true, location: null, usable: true, perceptible: true,
});

export function validPhonePhysicalState(value: unknown): value is PhonePhysicalState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Object.keys(state).length === 4 && Object.keys(state).every(key => ["reachable", "location", "usable", "perceptible"].includes(key))
    && typeof state.reachable === "boolean" && typeof state.usable === "boolean" && typeof state.perceptible === "boolean"
    && (state.location === null || typeof state.location === "string" && !!state.location.trim() && Array.from(state.location).length <= 300);
}

/** A read projection only: defaults never rewrite old journals or pretend a location is known. */
export function phonePhysicalState(phone: Pick<PhoneStatus, "physical">): PhonePhysicalState {
  return { ...(phone.physical ?? DEFAULT_PHONE_PHYSICAL_STATE) };
}

export function canReachPhone(phone: PhoneStatus): boolean { return phonePhysicalState(phone).reachable; }
/** Software requires an operable phone in hand; merely being within reach is not sufficient. */
export function canUsePhone(phone: PhoneStatus): boolean {
  const state = phonePhysicalState(phone);
  return !phone.down && state.reachable && state.usable;
}
/** An audible cue may be perceived across a room even when the phone cannot be reached. */
export function canPerceivePhone(phone: PhoneStatus): boolean {
  const state = phonePhysicalState(phone);
  return state.usable && state.perceptible;
}

/** Call only after the world's durable commit/reload. Never parse prose to infer these facts. */
export function applyPhonePhysicalState(phone: PhoneStatus, state?: PhonePhysicalState): boolean {
  if (state !== undefined && !validPhonePhysicalState(state)) throw new Error("手机物理状态必须完整指定 reachable、location、usable、perceptible。");
  const before = JSON.stringify(phone);
  if (state === undefined) delete phone.physical;
  else phone.physical = { ...state };
  // Losing physical reach cannot leave the execution layer claiming the phone is in hand.
  if (!canReachPhone(phone)) phone.down = true;
  return before !== JSON.stringify(phone);
}

/** Character-facing failures reveal no hidden location or invented explanation for the obstacle. */
export function phoneUnavailableReason(phone: PhoneStatus): string | undefined {
  const state = phonePhysicalState(phone);
  if (!state.reachable) return "现在够不到手机；需要先在世界中找到或接近它。";
  if (!state.usable) return "手机目前无法正常使用；需要先处理它的实际状况。";
  if (phone.down) return "手机不在手里；先拿起手机。";
}

/** Administrative/UI summary; its location is world state, not an automatic character perception. */
export function phonePhysicalSummary(phone: PhoneStatus): string {
  const state = phonePhysicalState(phone);
  return [state.reachable ? phone.down ? "未持有，可拿取" : "持有中" : "目前不可拿取", state.usable ? "设备可用" : "设备不可用",
    state.perceptible ? "通知动静可感知" : "通知动静不可感知", `位置：${state.location ?? "未记录"}`].join("；");
}
