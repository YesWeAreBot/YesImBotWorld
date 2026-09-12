import type { AppToolDef } from "../apps/app.js";
import type { ManualToolResult } from "../bot/agent.js";
import type { RichText } from "../types.js";
import { deviceKind } from "../apps/deviceTools.js";
import type { KnownChannel, WorldMessageRow } from "../koishi/messages.js";
import type { DevicesInfo } from "./server.js";

export interface DeviceTool extends AppToolDef {
  device: "phone" | "computer";
  effect: "read" | "action" | "send";
}
export interface DeviceSession {
  running: boolean;
  control: { paused: boolean; busy: boolean; residentMode?: "avatar" | "puppet" | null; deviceBusy?: boolean; attention?: "phone" | "computer" | null };
  devices: DevicesInfo;
  apps: { id: string; name: string; description: string; kind: "chat" | "app"; active: boolean }[];
  tools: DeviceTool[];
  appView: { id: string; name: string; opening?: string; lastTool?: string; result?: string | RichText } | null;
  computerView: { lastTool?: string; result?: string | RichText } | null;
  chat: { channelKey: string | null; channels: (KnownChannel & { latest?: WorldMessageRow })[]; messages: WorldMessageRow[] };
}
export interface DeviceControlResult extends ManualToolResult { paused: boolean; busy: boolean }
export type DeviceOperationMode = "takeover" | "stealth";

const SEND = new Set(["send", "pick_media", "forward_msgs", "send_group_notice"]);
const READ = new Set(["check_msg", "select_channel", "read_channel", "check_gallery", "check_media", "view_media", "view_forward", "exit_forward", "get_emoji_likes", "list_friends", "list_groups", "user_info", "group_info", "list_members", "member_info", "group_honor", "group_files", "get_group_notice", "get_essence_list", "screen"]);

/** Only genuine device tools; world actions, memory mutation and lifecycle commands stay out. */
export function deviceTools(defs: AppToolDef[], phone: ReadonlySet<string>, computer: ReadonlySet<string>): DeviceTool[] {
  return defs.flatMap(def => {
    const device = deviceKind(def.name, phone, computer);
    if (!device) return [];
    return [{ ...def, device, effect: SEND.has(def.name) ? "send" as const : READ.has(def.name) ? "read" as const : "action" as const }];
  });
}
