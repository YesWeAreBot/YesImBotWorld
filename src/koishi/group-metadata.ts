import type { Session } from "koishi";

/** An observation of one member in one group, never part of their nickname.
 * Missing fields mean the adapter did not supply them. An empty title explicitly
 * supplied by the platform means there was no such title at observation time. */
export interface GroupMemberMetadata {
  role?: "owner" | "admin" | "member";
  specialTitle?: string;
  levelTitle?: string;
  /** The platform's raw group activity level, not an inferred title or QQ level. */
  level?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function title(sources: Record<string, unknown>[], fields: string[]): string | undefined {
  for (const source of sources) for (const field of fields) {
    if (typeof source[field] === "string") return (source[field] as string).trim();
  }
  return undefined;
}

/** Accept an original OneBot message/member response and an optional normalized
 * Satori member. OneBot title is the awarded special title; level is ONLY a value.
 * NapCat's standard member API does not expose the gray activity-title text. An
 * adapter must explicitly provide level_title / levelTitle to populate that field. */
export function extractGroupMemberMetadata(raw: unknown, member?: unknown): GroupMemberMetadata | undefined {
  const root = object(raw);
  const sender = object(root?.sender) ?? root;
  const normalized = object(member);
  const sources = [sender, normalized].filter((value): value is Record<string, unknown> => !!value);
  const result: GroupMemberMetadata = {};
  for (const source of sources) {
    const directRole = source.role;
    if (directRole === "owner" || directRole === "admin" || directRole === "member") {
      result.role = directRole; break;
    }
    // Only semantic IDs emitted by adapters count. A role *name* containing
    // "admin", or an arbitrary platform role number, is not proof of authority.
    const roles = Array.isArray(source.roles) ? source.roles.map(value => typeof value === "string" ? value : object(value)?.id) : [];
    const role = (["owner", "admin", "member"] as const).find(value => roles.includes(value));
    if (role) { result.role = role; break; }
  }
  const specialTitle = title(sources, ["specialTitle", "special_title", "title"]);
  const levelTitle = title(sources, ["levelTitle", "level_title"]);
  if (specialTitle !== undefined) result.specialTitle = specialTitle;
  if (levelTitle !== undefined) result.levelTitle = levelTitle;
  for (const source of sources) {
    const level = source.level;
    if (typeof level === "string" && level.trim()) { result.level = level.trim(); break; }
    if (typeof level === "number" && Number.isFinite(level)) { result.level = String(level); break; }
  }
  return Object.keys(result).length ? result : undefined;
}

/** Snapshot metadata from the actual inbound sender. Never request today's
 * profile to fill a historical event, and never attach group facts to a DM. */
export function sessionGroupMemberMetadata(session: Session): GroupMemberMetadata | undefined {
  const raw = object((session as unknown as { onebot?: unknown }).onebot) ?? object(session.event?._data);
  if (session.isDirect === true || session.channelId?.startsWith("private:") || raw?.message_type === "private") return;
  if (session.isDirect !== false && !session.guildId && !raw?.group_id && !["group", "guild"].includes(String(raw?.message_type ?? ""))) return;
  const mismatches = (observed: unknown, expected?: string) => observed != null && !!expected && String(observed) !== String(expected);
  // Reused command sessions may point at a new room but retain the original
  // adapter payload AND its normalized member. Neither belongs to the new room.
  if (mismatches(raw?.group_id, session.guildId || session.channelId)
    || mismatches(raw?.guild_id, session.guildId)
    || mismatches(raw?.channel_id, session.channelId)) return;
  const sender = object(raw?.sender);
  const rawUserIds = [sender?.user_id, sender?.tiny_id].filter(value => value != null).map(String);
  const member = session.event?.member;
  // Mismatched raw/session identities must not give the current sender somebody
  // else's permissions or titles (notably command-triggered outbound sessions).
  const sameRawSender = !rawUserIds.length || !session.userId || rawUserIds.includes(String(session.userId));
  const memberUserId = member?.user?.id;
  const sameMember = memberUserId != null && session.userId
    ? String(memberUserId) === String(session.userId)
    : sameRawSender;
  return extractGroupMemberMetadata(sameRawSender ? sender : undefined, sameMember ? member : undefined);
}
