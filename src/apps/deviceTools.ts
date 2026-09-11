import { toolLayer } from "../bot/tools.js";

export type DeviceKind = "phone" | "computer";
const PHONE_CORE = new Set(["open_app", "close_app", "pick_up_phone", "put_down_phone", "check_gallery", "check_media", "view_media", "gallery_save", "gallery_move", "gallery_remove"]);
/** Shared by the runtime queue and WebUI allowlist; never includes world/body actions. */
export function deviceKind(name: string, phone: ReadonlySet<string>, computer: ReadonlySet<string>): DeviceKind | null {
  if (computer.has(name) || name === "open_computer" || name === "close_computer") return "computer";
  if (phone.has(name) || PHONE_CORE.has(name) || toolLayer(name) !== "core") return "phone";
  return null;
}
