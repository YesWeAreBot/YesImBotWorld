/** Semantic admission guards use only delivered fixtures; no services or LLM calls. */
import assert from "node:assert/strict";
import type { GrowthKind, PerceivedEvidence } from "../src/bot/growth.js";
import { validateGrowthInsight, type GrowthInsight, type GrowthInsightInput } from "../src/bot/growth-semantics.js";

const SELF = 'chat-user:["onebot","self"]', FRIEND = 'chat-user:["onebot","friend"]', OTHER = 'chat-user:["onebot","other"]';
const CHANNEL = "onebot@self:group";
const insight = (eventId: string, quote: string, extra: Partial<GrowthInsight> = {}): GrowthInsight => ({
  dimension: "技术求助的信任", significance: "以后遇到相似问题，可以尝试向这个对象求助，但仍应尊重他的时间。", anchors: [{ eventId, quote }], ...extra,
});
const world = (id: string, text: string, action = "帮朋友修理收音机"): PerceivedEvidence => ({
  eventId: id, actorId: "bot", source: "world", observedAt: 10, text, rootEventIds: ["root:" + id],
  experience: { agency: "self", outcome: "completed", opportunity: true, episodeId: "episode:" + id, action, worldPerception: true },
});
const peer = (id: string, text: string, senderId = FRIEND): PerceivedEvidence => ({
  eventId: id, actorId: "bot", source: "koishi", observedAt: 10, text, rootEventIds: ["chat-message:" + id],
  experience: { agency: "observed", outcome: "unknown", subjectIds: [senderId], chat: { kind: "message", channelKey: CHANNEL, senderId, senderOwn: false } },
});
const sent = (id: string, body: string): PerceivedEvidence => ({
  eventId: id, actorId: "bot", source: "tool", observedAt: 10, text: "消息已发送。", rootEventIds: ["chat-message:" + id],
  experience: { agency: "self", outcome: "completed", opportunity: true, episodeId: "episode:" + id,
    action: `向 ${CHANNEL} 发送了消息：${body}`, chat: { kind: "send", channelKey: CHANNEL, senderId: SELF, senderOwn: true } },
});
function input(kind: GrowthKind, record: PerceivedEvidence, quote: string): GrowthInsightInput {
  return { kind, statement: "在需要技术帮助时，这位朋友愿意认真回应，可以逐渐建立有限的信任。", insight: insight(record.eventId, quote), ...(kind === "relationship" ? { subjectId: FRIEND } : {}) };
}
function accepted(kind: GrowthKind, record: PerceivedEvidence, quote: string, extra: Partial<GrowthInsightInput> = {}) {
  const data = input(kind, record, quote);
  assert.deepEqual(validateGrowthInsight({ ...data, ...extra }, [record]), data.insight);
}
function rejected(kind: GrowthKind, record: PerceivedEvidence, quote: string, pattern: RegExp, extra: Partial<GrowthInsightInput> = {}) {
  assert.throws(() => validateGrowthInsight({ ...input(kind, record, quote), ...extra }, [record]), pattern);
}

const invitation = peer("help", "下次遇到这些报错可以直接找我，我有空会一起看看。");
accepted("relationship", invitation, "下次遇到这些报错可以直接找我，我有空会一起看看。");
rejected("relationship", invitation, "愿意帮助我解决技术问题", /逐字/);
rejected("relationship", invitation, invitation.text, /关系证据/, { subjectId: OTHER });
rejected("relationship", invitation, invitation.text, /关系证据/, { subjectId: undefined });

// A mixed delivered snapshot must identify the exact message, not just its parent subjects.
const mixed: PerceivedEvidence = { ...invitation, eventId: "mixed", text: "朋友说：嗯。其他人说：我可以帮你。",
  experience: { agency: "observed", outcome: "unknown", subjectIds: [FRIEND, OTHER], chat: { kind: "attention", channelKey: CHANNEL } },
  messages: [{ text: "嗯。", rootEventIds: ["chat-message:one"], chat: { kind: "message", channelKey: CHANNEL, senderId: FRIEND, senderOwn: false } },
    { text: "我可以帮你。", rootEventIds: ["chat-message:two"], chat: { kind: "message", channelKey: CHANNEL, senderId: OTHER, senderOwn: false } }] };
rejected("relationship", mixed, "我可以帮你。", /关系证据/);
rejected("relationship", mixed, "嗯。", /关系证据/);
const image = peer("image", '<media ref="media:1" type="image">图片摘要：我可以帮你解决这个问题。</media>');
rejected("relationship", image, "我可以帮你解决这个问题。", /关系证据/);
const quoted = peer("quote", '<quote id="old">下次遇到这些报错可以直接找我。</quote>哦，原来如此。');
rejected("relationship", quoted, "下次遇到这些报错可以直接找我。", /关系证据/);
accepted("relationship", world("npc", "修理工耐心解释了接线的原理，并表示下次遇到问题可以再来找他。"), "修理工耐心解释了接线的原理，并表示下次遇到问题可以再来找他。", { subjectId: undefined });

const liking = sent("like", "我更喜欢独自慢慢逛书店，比跟团跑景点舒服。");
accepted("preference", liking, "我更喜欢独自慢慢逛书店，比跟团跑景点舒服。");
accepted("preference", world("choice", "在咖啡和清茶之间，你选择了一杯清茶。", "在咖啡和清茶之间选择清茶"), "在咖啡和清茶之间，你选择了一杯清茶。");
for (const agency of ["observed", "imposed", "unknown"] as const) {
  rejected("preference", { ...liking, experience: { ...liking.experience, agency } }, "我更喜欢独自慢慢逛书店", /偏好证据/);
}
for (const outcome of ["failed", "unknown"] as const) {
  rejected("preference", { ...liking, experience: { ...liking.experience, outcome } }, "我更喜欢独自慢慢逛书店", /偏好证据/);
}
rejected("preference", peer("others-like", "我喜欢清茶。"), "我喜欢清茶。", /偏好证据/);
const webpage: PerceivedEvidence = { eventId: "webpage", actorId: "bot", source: "tool", text: "问卷：你最喜欢什么？A：我喜欢清茶。B：我保证不迟到。",
  observedAt: 11, rootEventIds: ["root:webpage"], experience: { action: "工具 browser_open", agency: "self", outcome: "completed", opportunity: true } };
rejected("preference", webpage, "我喜欢清茶。", /偏好证据/);
rejected("commitment", webpage, "我保证不迟到。", /承诺证据/);
rejected("preference", world("navigation", "页面显示：我喜欢清茶。", "打开网页问卷"), "我喜欢清茶。", /偏好证据/);
const readback = { ...liking, text: "我喜欢清茶。", experience: { ...liking.experience, agency: "observed" as const, chat: { ...liking.experience!.chat!, kind: "message" as const } } };
rejected("preference", readback, "我喜欢清茶。", /偏好证据/);

for (const body of ["行，明天我给你发原图。", "这件事包在我身上。", "一言为定，周六下午见。", "之前答应给你的图，我今天做不了了，改到明天好吗。", "我已经把约好的资料发给你了。"])
  accepted("commitment", sent("promise:" + body, body), body);
rejected("commitment", sent("test-ack", "哦 那个测试"), "哦 那个测试", /承诺证据/);
rejected("commitment", sent("ability", "我会弹钢琴。"), "我会弹钢琴。", /承诺证据/);
rejected("commitment", sent("hypothetical", "假如我答应你明天发原图。"), "假如我答应你明天发原图。", /承诺证据/);
rejected("commitment", sent("denial", "我没有答应替你做这件事。"), "我没有答应替你做这件事。", /承诺证据/);
rejected("commitment", sent("hypothesis", "假如我答应给你上色，会发生什么？"), "我答应给你上色", /承诺证据/);
rejected("commitment", sent("question", "明天给你发原图？"), "明天给你发原图？", /承诺证据/);
const peerPromise = peer("peer-promise", "放心，我明天给你发资料。");
accepted("commitment", peerPromise, peerPromise.text, { subjectId: FRIEND });
rejected("commitment", peerPromise, peerPromise.text, /承诺证据/);
rejected("commitment", peerPromise, peerPromise.text, /承诺证据/, { subjectId: OTHER });
const quotingReceipt = { ...sent("quote-receipt", "哦 那个测试"), text: '消息已发送（引用原消息："我保证明天发给你"）。' };
rejected("commitment", quotingReceipt, "我保证明天发给你", /承诺证据/);
const quotingOwnBody = sent("quote-body", '<quote id="peer" text="我保证明天发给你"/>哦 那个测试');
rejected("commitment", quotingOwnBody, "我保证明天发给你", /承诺证据/);
accepted("commitment", world("fulfilled", "你把答应替朋友修好的收音机交给了他。"), "你把答应替朋友修好的收音机交给了他。");
rejected("commitment", world("ordinary", "你把收音机放到了桌上。"), "你把收音机放到了桌上。", /承诺证据/);

const walk = world("walk", "晚饭后你决定沿河散步。", "沿河散步");
for (const kind of ["habit", "trait"] as const) accepted(kind, walk, "晚饭后你决定沿河散步。");
rejected("habit", webpage, "我喜欢清茶。", /行为倾向/);

const base = input("relationship", invitation, invitation.text);
for (const bad of [undefined, null, [], {}, { ...base.insight as GrowthInsight, extra: true }])
  assert.throws(() => validateGrowthInsight({ ...base, insight: bad }, [invitation]), /insight/);
assert.throws(() => validateGrowthInsight({ ...base, insight: { ...base.insight as GrowthInsight, significance: base.statement } }, [invitation]), /不能照抄/);
assert.throws(() => validateGrowthInsight({ ...base, insight: insight(invitation.eventId, invitation.text, { anchors: [] }) }, [invitation]), /1 至 4/);
assert.throws(() => validateGrowthInsight({ ...base, insight: insight("unknown", invitation.text) }, [invitation]), /本次/);
assert.throws(() => validateGrowthInsight(base, [{ ...invitation, rootEventIds: [] }]), /原始来源/);
assert.throws(() => validateGrowthInsight(base, [{ ...invitation, source: "system" }]), /原始来源/);
assert.throws(() => validateGrowthInsight(base, [{ ...invitation, experience: { ...invitation.experience, internalThought: true } }]), /原始来源/);
assert.throws(() => validateGrowthInsight({ ...base, insight: insight(invitation.eventId, invitation.text, { anchors: Array(2).fill({ eventId: invitation.eventId, quote: invitation.text }) }) }, [invitation]), /不能重复/);
const original = structuredClone(base.insight);
const validated = validateGrowthInsight(base, [invitation]); validated.anchors[0]!.quote = "调用方的后续修改";
assert.deepEqual(base.insight, original, "admission returns independent data without mutating input/history");
console.log("PASS literal growth insight anchors, message authorship, real self preferences/commitments, media/questionnaire isolation and reusable explanation structure");
