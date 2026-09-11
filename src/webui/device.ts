import type { AppToolDef } from "../apps/app.js";
import type { ManualToolResult } from "../bot/agent.js";
import type { RichText } from "../types.js";
import { toolLayer } from "../bot/tools.js";
import type { KnownChannel, WorldMessageRow } from "../koishi/messages.js";
import type { DevicesInfo } from "./server.js";

export interface DeviceTool extends AppToolDef {
  device: "phone" | "computer";
  effect: "read" | "action" | "send";
}
export interface DeviceSession {
  running: boolean;
  control: { paused: boolean; busy: boolean };
  devices: DevicesInfo;
  apps: { id: string; name: string; description: string; kind: "chat" | "app"; active: boolean }[];
  tools: DeviceTool[];
  appView: { id: string; name: string; opening?: string; lastTool?: string; result?: string | RichText } | null;
  computerView: { lastTool?: string; result?: string | RichText } | null;
  chat: { channelKey: string | null; channels: (KnownChannel & { latest?: WorldMessageRow })[]; messages: WorldMessageRow[] };
}
export interface DeviceControlResult extends ManualToolResult { paused: boolean; busy: boolean }

const PHONE_CORE = new Set(["open_app", "close_app", "pick_up_phone", "put_down_phone", "check_gallery", "check_media", "view_media", "gallery_save", "gallery_move", "gallery_remove"]);
const SEND = new Set(["send", "pick_media", "forward_msgs", "send_group_notice"]);
const READ = new Set(["check_msg", "select_channel", "read_channel", "check_gallery", "check_media", "view_media", "view_forward", "exit_forward", "get_emoji_likes", "list_friends", "list_groups", "user_info", "group_info", "list_members", "member_info", "group_honor", "group_files", "get_group_notice", "get_essence_list", "screen"]);

/** Only genuine device tools; world actions, memory mutation and lifecycle commands stay out. */
export function deviceTools(defs: AppToolDef[], phone: ReadonlySet<string>, computer: ReadonlySet<string>): DeviceTool[] {
  return defs.flatMap(def => {
    const desktop = computer.has(def.name) || def.name === "open_computer" || def.name === "close_computer";
    if (!desktop && !phone.has(def.name) && !PHONE_CORE.has(def.name) && toolLayer(def.name) === "core") return [];
    return [{ ...def, device: desktop ? "computer" as const : "phone" as const, effect: SEND.has(def.name) ? "send" as const : READ.has(def.name) ? "read" as const : "action" as const }];
  });
}
