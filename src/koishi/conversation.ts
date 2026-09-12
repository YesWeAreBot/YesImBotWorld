import type { h } from "koishi";

/** Platform evidence about a message, not a guess about its author's intent. */
export interface ConversationContext {
  kind: "direct" | "group" | "unknown";
  mentions: string[];
  mentionsEveryone: boolean;
  reply?: { messageId?: string; userId?: string };
  hasText: boolean;
  media: ("image" | "sticker" | "face" | "audio" | "video" | "forward")[];
}

export function conversationKind(isDirect?: boolean | null, channelId = "", guildId = ""): ConversationContext["kind"] {
  if (typeof isDirect === "boolean") return isDirect ? "direct" : "group";
  if (channelId.startsWith("private:")) return "direct";
  return guildId ? "group" : "unknown";
}

export function describeConversation(
  elements: h[],
  kind: ConversationContext["kind"],
  isSticker: (element: h) => boolean,
  reply?: ConversationContext["reply"],
): ConversationContext {
  const result: ConversationContext = { kind, mentions: [], mentionsEveryone: false, hasText: false, media: [], ...(reply ? { reply } : {}) };
  const visit = (nodes: h[]) => {
    for (const node of nodes) {
      if (node.type === "text") result.hasText ||= !!String(node.attrs.content ?? "").trim();
      else if (node.type === "at") {
        if (node.attrs.type === "all" || node.attrs.type === "here") result.mentionsEveryone = true;
        else if (node.attrs.id != null && String(node.attrs.id)) result.mentions.push(String(node.attrs.id));
      } else if (node.type === "quote") {
        // Quoted and forwarded messages do not address the recipient of the containing message.
        if (!result.reply && node.attrs.id != null) result.reply = { messageId: String(node.attrs.id) };
      } else if (node.type === "forward") result.media.push("forward");
      else if (node.type === "img" || node.type === "image") result.media.push(isSticker(node) ? "sticker" : "image");
      else if (node.type === "face" || node.type === "audio" || node.type === "video") result.media.push(node.type);
      else if (node.children?.length) visit(node.children);
    }
  };
  visit(elements);
  result.mentions = [...new Set(result.mentions)];
  result.media = [...new Set(result.media)];
  return result;
}

/** Concise, factual labels shared by live notifications and stored history. */
export function conversationLabel(context: ConversationContext | null | undefined, selfId?: string): string {
  if (!context) return "对话指向未记录";
  const facts: string[] = [];
  if (context.kind === "direct") facts.push("私聊");
  else {
    facts.push(context.kind === "group" ? "群聊" : "会话类型未知");
    if (selfId && context.mentions.includes(selfId)) facts.push("明确 @ 本账号");
    const others = context.mentions.filter(id => id !== selfId);
    if (others.length) facts.push("@ 其他账号 " + others.map(id => JSON.stringify(id)).join("、"));
    if (context.mentionsEveryone) facts.push("@ 全体，不是单独找你");
    if (context.reply) {
      facts.push(context.reply.userId
        ? (selfId && context.reply.userId === selfId ? "引用本账号的消息" : "引用其他账号 " + JSON.stringify(context.reply.userId) + " 的消息")
        : "有引用，原作者未知");
    }
    if (!context.mentions.length && !context.mentionsEveryone && !context.reply) facts.push("无明确 @ 或引用指向，需结合上下文判断");
  }
  if (!context.hasText && context.media.length) {
    const labels = { image: "图片", sticker: "表情包", face: "平台表情", audio: "语音", video: "视频", forward: "转发记录" };
    facts.push("仅含" + context.media.map(type => labels[type]).join("、") + "，未附文字");
  }
  return facts.join("；");
}
