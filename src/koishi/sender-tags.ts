import type { GroupMetadataConfig, GroupMetadataPresentation } from "../config.js";
import type { GroupMemberMetadata } from "./group-metadata.js";

const DEFAULTS: GroupMetadataConfig = { role: "inline", specialTitle: "on_demand", levelTitle: "on_demand" };

export function groupMetadataPresentation(config: GroupMetadataConfig | undefined, key: keyof GroupMetadataConfig): GroupMetadataPresentation {
  const value = config?.[key];
  return value === "inline" || value === "on_demand" || value === "hidden" ? value : DEFAULTS[key];
}

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\r\n\t]/g, char => `&#${char.charCodeAt(0)};`);
}

/** Raw profile fields may coexist, but the platform displays one title. Resolve
 * its source before applying presentation settings; hiding a special title must
 * never reveal the lower-priority level or role text it replaced. */
export function resolveGroupMemberTitle(metadata: GroupMemberMetadata | null | undefined): { title: string; source: keyof GroupMetadataConfig } | undefined {
  if (!metadata || typeof metadata.specialTitle !== "string") return;
  if (metadata.specialTitle.trim()) return { title: metadata.specialTitle, source: "specialTitle" };
  if (metadata.role === "owner") return { title: "群主", source: "role" };
  if (metadata.role === "admin") return { title: "管理员", source: "role" };
  if (metadata.role === "member" && typeof metadata.levelTitle === "string" && metadata.levelTitle.trim()) {
    return { title: metadata.levelTitle, source: "levelTitle" };
  }
  // Missing special-title or role data cannot establish which title is visible.
  // A numeric activity level is not the gray title's text.
}

/** One displayed title and an independent group role, never a nickname or an
 * instruction. Raw special/level values stay in the captured profile snapshot. */
export function senderMetadataTag(
  metadata: GroupMemberMetadata | null | undefined, config?: GroupMetadataConfig,
  mode: "inline" | "detail" = "inline", userId?: string,
): string {
  if (!metadata) return "";
  const attrs: [string, string][] = [];
  const visible = (key: keyof GroupMetadataConfig) => {
    const presentation = groupMetadataPresentation(config, key);
    return presentation === "inline" || mode === "detail" && presentation === "on_demand";
  };
  const resolvedTitle = resolveGroupMemberTitle(metadata);
  const title = resolvedTitle && visible(resolvedTitle.source) ? resolvedTitle.title : undefined;
  if (visible("role") && ["owner", "admin", "member"].includes(metadata.role ?? "") && (metadata.role !== "member" || mode === "detail" || title)) attrs.push(["group_role", metadata.role!]);
  if (title) attrs.push(["title", title]);
  if (!attrs.length) return "";
  if (userId) attrs.unshift(["user_id", userId]);
  return `<sender ${attrs.map(([key, value]) => `${key}="${attribute(value)}"`).join(" ")}/>`;
}

/** Do not silently alter a submitted message or pass internal metadata to the
 * platform parser. Public Koishi at/quote/face/media elements remain untouched. */
export function senderTagError(msg: string): string | undefined {
  if (/<\/?sender(?=[\s/>]|$)/iu.test(msg)) return "正文包含界面身份标签，请只填写消息正文。";
}
