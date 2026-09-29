import type { ExperienceMetadata } from "../types.js";
import type { GrowthKind, GrowthRecord, GrowthView, PerceivedEvidence } from "./growth.js";

export type GrowthScope = { domain: "physical" } | { domain: "chat"; channelKey: string; subjectId?: string };
export interface GrowthMessageEvidence { text: string; rootEventIds: string[]; chat: NonNullable<ExperienceMetadata["chat"]> }

/** Detect the evidence namespace, never infer a person's identity from a sentence or nickname. */
export function chatEvidence(evidence: PerceivedEvidence): boolean {
  return !!evidence.experience?.chat || !!evidence.messages?.length ||
    evidence.rootEventIds.some(root => /^chat-(?:message|notice):/.test(root)) ||
    evidence.experience?.subjectIds?.some(id => id.startsWith("chat-user:")) === true ||
    /^(?:chat|phone-notice)-episode:/.test(evidence.experience?.episodeId ?? "");
}

export function messagesOf(evidence: PerceivedEvidence): GrowthMessageEvidence[] {
  if (evidence.messages) return evidence.messages;
  const chat = evidence.experience?.chat;
  return chat?.kind === "message" ? [{ text: evidence.text, rootEventIds: evidence.rootEventIds, chat }] : [];
}

/** A displayed list, notification or successful send does not establish a current attention state. */
export function stateBasis(evidence: PerceivedEvidence): boolean {
  if (evidence.experience?.internalThought === true || evidence.experience?.outcome === "failed" || evidence.experience?.historicalWorld === true) return false;
  return evidence.source === "world" || evidence.experience?.worldPerception === true || evidence.experience?.chat?.kind === "attention";
}

export function deriveGrowthScope(kind: GrowthKind, evidence: PerceivedEvidence[], subjectId?: string): GrowthScope | undefined {
  const chat = evidence.filter(chatEvidence);
  if (kind === "relationship" && chat.length) {
    if (!subjectId) throw new Error("聊天关系必须提供已交付消息中的 subjectId，不能只按名字判断是谁");
    const supporting = chat.flatMap(messagesOf).filter(message => message.chat.senderId === subjectId && message.chat.senderOwn === false);
    if (!supporting.length) throw new Error("聊天关系缺少该对象实际发出的非本人消息；本人旧话、通知、列表和混合快照不能代替对方的行为证据");
    const channels = [...new Set(supporting.map(message => message.chat.channelKey))];
    if (channels.length !== 1) throw new Error("一次关系认识须有明确频道范围；请分别整理不同频道的经历");
    return { domain: "chat", channelKey: channels[0]!, subjectId };
  }
  if (kind === "state") {
    const qualified = evidence.filter(stateBasis);
    if (!qualified.length) throw new Error("临时状态需要实际身体处境或已经呈现的当前注意界面；先前世界的历史回执不证明当前处境，通知、频道列表、拿起手机及送达回执不证明注意意图或身体状态");
    const attention = qualified.filter(item => item.experience?.chat?.kind === "attention");
    if (attention.length) {
      const channels = [...new Set(attention.map(item => item.experience!.chat!.channelKey))];
      if (channels.length !== 1) throw new Error("当前注意状态只能属于一个明确频道，不能合并不同界面");
      return { domain: "chat", channelKey: channels[0]!, ...(subjectId ? { subjectId } : {}) };
    }
    return { domain: "physical" };
  }
  if (chat.length) {
    const channels = [...new Set(chat.flatMap(item => item.experience?.chat ? [item.experience.chat.channelKey] : messagesOf(item).map(message => message.chat.channelKey)))];
    return channels.length === 1 ? { domain: "chat", channelKey: channels[0]!, ...(subjectId ? { subjectId } : {}) } : undefined;
  }
  return { domain: "physical" };
}

/** Legacy records remain auditable, but uncertain chat attribution cannot become automatic guidance. */
export function growthNeedsReview(view: GrowthView): boolean {
  const current = [...view.records].reverse().find(record => record.relation !== "counter")!;
  if (current.relation === "retire") return false;
  return ["relationship", "commitment", "preference"].includes(view.kind) && (!current.insight || current.semanticVersion !== 1) ||
    (!current.scope || current.groundingVersion !== 1) && view.evidence.some(chatEvidence) ||
    (view.kind === "habit" || view.kind === "trait") && (!current.behavior || current.groundingVersion !== 1);
}

export function growthMatchesScope(view: GrowthView, channelKeys: string[], subjectIds: Set<string>): boolean {
  if (growthNeedsReview(view)) return false;
  const scope = [...view.records].reverse().find(record => record.relation !== "counter")?.scope;
  if (scope?.domain !== "chat") return true;
  if (view.kind === "relationship") return !!scope.subjectId && subjectIds.has(scope.subjectId);
  return channelKeys.includes(scope.channelKey) && (!scope.subjectId || subjectIds.has(scope.subjectId));
}

export function actionContains(evidence: PerceivedEvidence, behavior: string): boolean {
  return normalize(evidence.experience?.action ?? "").includes(normalize(behavior));
}
function normalize(text: string): string { return text.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "").trim(); }

/** Existing supported behavior is one hypothesis, even when a model gives it a new near-synonym title. */
export function matchingBehavior(records: GrowthRecord[], kind: GrowthKind, behavior: string, subjectId?: string): GrowthRecord | undefined {
  return [...records].reverse().find(record => record.kind === kind && record.relation !== "retire" && record.subjectId === subjectId &&
    !!record.behavior && (normalize(record.behavior).includes(normalize(behavior)) || normalize(behavior).includes(normalize(record.behavior))));
}
