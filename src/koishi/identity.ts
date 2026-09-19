import type { Session } from "koishi";

export interface ChannelIdentity {
  platform: string;
  channelId: string;
  selfId?: string;
  /** Connected accounts on this platform, not nicknames or accounts on other platforms. */
  accountIds: string[];
  displayName: string;
  source: "group_card" | "account_name" | "unknown";
  text: string;
}

type Sender = { platform: string; selfId?: string; userId: string; username?: string; senderOrigin?: string | null; senderOwned?: boolean | null };

export function firstName(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

/** Only pre-provenance rows used these literals as generated labels. New platform
 * nicknames may legitimately contain exactly the same characters. */
export function isLegacySenderPlaceholder(row: Sender): boolean {
  return row.senderOwned == null && row.senderOrigin == null && ["（我）", "本账号", "你自己"].includes(row.username ?? "");
}

/** Platform event names are snapshots. Do not replace them with today's member profile. */
export function sessionSenderName(session: Session): string {
  const raw = ((session as unknown as { onebot?: Record<string, any> }).onebot ??
    (session.event as unknown as { _data?: Record<string, any> })?._data ?? {});
  return firstName(raw.sender?.card, session.event?.member?.nick, raw.sender?.nickname,
    session.event?.user?.nick, session.event?.user?.name, session.username);
}

export function messageAccountRelation(row: Sender, identity?: Pick<ChannelIdentity, "platform" | "selfId" | "accountIds">): "current" | "connected" | "historical" | "other" | "unknown" {
  if (!row.userId) return "unknown";
  // The receiving account is recorded provenance; today's other connected accounts
  // cannot establish ownership at the time of an older message.
  const knownOwned = row.senderOwned === true || (row.senderOwned !== false && !!row.selfId && row.userId === row.selfId);
  if (row.senderOwned === false) return "other";
  if (!knownOwned) return "unknown";
  if (identity) {
    if (identity.platform !== row.platform) return "historical";
    if (identity.selfId && row.userId === identity.selfId) return "current";
    if (identity.accountIds.includes(row.userId)) return "connected";
  } else if (row.selfId && row.userId === row.selfId) return "current";
  return "historical";
}

/** self is a legacy account flag, never proof of the role's voluntary authorship. */
export function formatMessageSender(row: Sender, identity?: Pick<ChannelIdentity, "platform" | "selfId" | "accountIds">): string {
  const relation = messageAccountRelation(row, identity);
  const legacyPlaceholder = ["current", "connected", "historical"].includes(relation) && isLegacySenderPlaceholder(row);
  const name = !legacyPlaceholder && firstName(row.username) ? row.username! : "昵称未记录";
  const ownership = relation === "current" ? "当前会话使用的你的账号"
    : relation === "connected" ? "你的另一连接账号" : relation === "historical" ? "你当时连接的账号（当前会话未确认仍连接）"
      : !row.userId ? "发送者身份未知" : relation === "unknown" ? "历史账号归属未记录" : "记录时未登记为你的连接账号";
  const origin = ["current", "connected", "historical"].includes(relation)
    ? row.senderOrigin === "tool" ? "；已确认经聊天工具发送，自主或受控以对应操作经历为准"
      : row.senderOrigin === "external" ? "；本次由账号外部消息捕获，不能认定为你自主发送"
        : "；具体操作者未知，不能仅凭账号认定为你自主发送"
    : "";
  return `${name}（平台 ${JSON.stringify(row.platform)}；账号 ${JSON.stringify(row.userId || "未知")}；${ownership}${origin}）`;
}
