/** 旧键 platform:channel 与显式账号键 platform@selfId:channel 共存。 */
export function channelKey(platform: string, channelId: string, selfId?: string): string {
  return `${platform}${selfId ? `@${encodeURIComponent(selfId)}` : ""}:${channelId}`;
}

export function parseChannelKey(id: string): { platform: string; channelId: string; selfId?: string; error?: string } {
  const sep = id.indexOf(":");
  if (sep <= 0 || !id.slice(sep + 1)) {
    return { platform: "", channelId: "", error: `（频道 id 格式不对："${id}"。请用 check_msg 列出的完整频道 id。）` };
  }
  const account = id.slice(0, sep);
  const at = account.indexOf("@");
  if (at < 0) return { platform: account, channelId: id.slice(sep + 1) };
  try {
    const selfId = decodeURIComponent(account.slice(at + 1));
    if (!selfId || at === 0) throw new Error("empty account");
    return { platform: account.slice(0, at), selfId, channelId: id.slice(sep + 1) };
  } catch {
    return { platform: "", channelId: "", error: "（频道账号标识无效，请重新从 check_msg 选择频道。）" };
  }
}

/** 无账号旧配置仍表示该平台频道，适用于通知规则等兼容读取。 */
export function legacyChannelKey(key: string): string {
  const parsed = parseChannelKey(key);
  return parsed.error ? key : channelKey(parsed.platform, parsed.channelId);
}
