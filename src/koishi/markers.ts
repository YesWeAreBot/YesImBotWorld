/**
 * 聊天记录/事件里的标记文本（[...] 包裹的纯函数生成），不依赖 koishi，便于冒烟测试。
 */

/** Preserve an opaque platform ID; never extract a number from another identifier or prose. */
export function normalizeMsgId(value: unknown): string | undefined {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return undefined;
  let id = String(value).trim();
  if (/^\(msg:/i.test(id) && id.endsWith(")")) id = id.slice(5, -1);
  else if (/^msg:/i.test(id)) id = id.slice(4);
  if (!id || /^-?0+$/.test(id) || /^(?:media|gallery|msg):/i.test(id)) return undefined;
  // Platform IDs may contain letters, negative numbers, UUIDs, colons, slashes,
  // base64 punctuation and Unicode. Whitespace, markup and broken wrappers are not IDs.
  if (/[\s\p{Cc}\p{Cf}<>"'`()\[\]{}\\]/u.test(id)) return undefined;
  return id;
}

/**
 * 撤回动态的描述文本（入库时以 [...] 包裹成标记；关注事件里直接使用）。
 * Bot 自己在文本里以第二人称「你」出现（与戳一戳/禁言标记的惯例一致）。
 */
export function recallNoticeText(opts: {
  /** 执行撤回的人的显示名（Bot 自己 → "你"） */
  operatorName: string;
  /** 执行撤回的是否 Bot 自己 */
  selfOp: boolean;
  /** 被撤回消息的发送者显示名（Bot 自己 → "你"） */
  senderName: string;
  /** 被撤回的消息是否 Bot 自己发的 */
  selfSender: boolean;
  /** 撤回的人与消息发送者是否同一人（自己撤回自己的消息） */
  samePerson: boolean;
}): string {
  if (opts.selfOp && opts.samePerson) return "你撤回了一条消息";
  if (opts.selfSender) return `${opts.operatorName} 撤回了一条你的消息`;
  if (opts.samePerson) return `${opts.operatorName} 撤回了一条消息`;
  return `${opts.operatorName} 撤回了 ${opts.senderName} 的一条消息`;
}
