import type { GrowthKind, PerceivedEvidence } from "./growth.js";
import { chatEvidence, messagesOf } from "./growth-grounding.js";

/** An explanation of what was learned, with small, literal, actor-grounded excerpts.
 * This is an admission aid, not a claim that string matching understands meaning. */
export interface GrowthInsight {
  dimension: string;
  significance: string;
  anchors: { eventId: string; quote: string }[];
}

export interface GrowthInsightInput {
  kind: GrowthKind;
  statement: string;
  subjectId?: string;
  insight?: unknown;
}

/** The caller chooses when a new/revised claim needs admission. Corrections and
 * retirements must remain possible without restating an old, unsupported insight.
 * Provenance is checked here; whether an inference is useful remains the reviewer's
 * task. In particular, a genuine choice alone does not prove a stable preference. */
export function validateGrowthInsight(input: GrowthInsightInput, evidence: PerceivedEvidence[]): GrowthInsight {
  if (input.kind === "state") throw new Error("临时状态不属于长期认识的语义准入");
  const data = object(input.insight);
  if (!data || Object.keys(data).some(key => !["dimension", "significance", "anchors"].includes(key))) {
    throw new Error("长期认识需要 insight：稳定的认识维度、对后续认识或选择的意义，以及逐字证据锚");
  }
  const dimension = text(data.dimension, "insight.dimension", 2, 100);
  const significance = text(data.significance, "insight.significance", 8, 600);
  if (sameText(significance, input.statement)) throw new Error("insight.significance 不能照抄结论，须说明为何值得影响后续认识或选择");
  if (!Array.isArray(data.anchors) || !data.anchors.length || data.anchors.length > 4) {
    throw new Error("insight.anchors 须为 1 至 4 个逐字证据锚");
  }
  const available = new Map(evidence.map(item => [item.eventId, item]));
  const anchors: GrowthInsight["anchors"] = [];
  for (const raw of data.anchors) {
    const anchor = object(raw);
    if (!anchor || Object.keys(anchor).some(key => !["eventId", "quote"].includes(key))) throw new Error("证据锚只能包含 eventId 与 quote");
    const eventId = text(anchor.eventId, "anchor.eventId", 1, 300);
    const quote = text(anchor.quote, "anchor.quote", 2, 500);
    const item = available.get(eventId);
    if (!item || !item.rootEventIds.length || item.source === "system" || item.experience?.internalThought) {
      throw new Error("证据锚必须引用本次已有原始来源的亲历材料，不能引用思考或整理结果");
    }
    // action is a program-owned description of the actual submitted operation.
    // Confirmed sends keep their own body there; their receipt may quote a peer.
    const originals = [item.text, item.experience?.action ?? "", ...messagesOf(item).map(message => message.text)];
    if (!originals.some(original => original.includes(quote))) throw new Error("证据锚 quote 必须逐字摘自对应经历的 text、messages.text 或 experience.action，不能改写或拼接");
    if (sameText(significance, quote)) throw new Error("insight.significance 不能重复证据原文，须说明可复用的认识意义");
    if (!validSource(input, item, quote)) throw new Error(sourceError(input.kind));
    if (anchors.some(previous => previous.eventId === eventId && previous.quote === quote)) throw new Error("证据锚不能重复同一段原文");
    anchors.push({ eventId, quote });
  }
  return { dimension, significance, anchors };
}

function validSource(input: GrowthInsightInput, item: PerceivedEvidence, quote: string): boolean {
  if (input.kind === "relationship") {
    if (chatEvidence(item)) {
      // Do not match the parent snapshot: the same words may belong to another
      // member, a quoted message, a media caption or a sender's display name.
      return !!input.subjectId && messagesOf(item).some(message => message.chat.senderOwn === false &&
        message.chat.senderId === input.subjectId && spokenText(message.text).includes(quote) && meaningfulSpeech(quote));
    }
    return physical(item) && item.experience?.outcome !== "failed" && spokenText(item.text).includes(quote) && meaningfulSpeech(quote);
  }

  const ownSpeech = selfSpeech(item).filter(source => source.includes(quote));
  if (input.kind === "preference") {
    if (ownSpeech.some(source => preferenceExpression(quote) && containsWholeExpression(source, quote))) return true;
    return voluntaryPhysicalChoice(item) && (item.text.includes(quote) || (item.experience?.action ?? "").includes(quote));
  }
  if (input.kind === "commitment") {
    const peerSpeech = input.subjectId ? messagesOf(item).filter(message => message.chat.senderOwn === false &&
      message.chat.senderId === input.subjectId).map(message => spokenText(message.text)).filter(source => source.includes(quote)) : [];
    if ([...ownSpeech, ...peerSpeech].some(source => commitmentExpression(quote) && containsWholeExpression(source, quote))) return true;
    // A physical result must mention the actual promise being fulfilled/withdrawn;
    // an unrelated successful action or a future plan is not a fulfilled promise.
    return voluntaryPhysicalChoice(item) && spokenText(item.text).includes(quote) &&
      /(?:履行|履约|兑现|如约|按照.{0,12}(?:约定|承诺)|把.{0,20}(?:答应|约好).{0,30}(?:交给|送到|完成)|(?:承诺|约定).{0,20}(?:完成|兑现|取消|撤回))/u.test(quote);
  }
  // habit / trait thresholds, common behavior, independence and cross-day span
  // are enforced by GrowthLedger. Never count page text as a voluntary choice.
  return voluntaryPhysicalChoice(item) || ownSpeech.length > 0;
}

function sourceError(kind: GrowthKind): string {
  if (kind === "preference") return "偏好证据锚须来自已确认的自主生活选择或本人明确偏好表达；网页问卷、选项、导航和旁观他人不证明自己的偏好";
  if (kind === "commitment") return "承诺证据锚须有实际承诺、履约或撤回的原话，或明确的身体履约事实；提到测试、普通计划和操作回执不是承诺";
  if (kind === "relationship") return "关系证据锚须指向该对象实际发出的非本人消息或真实世界互动；同处一群、媒体摘要和其他人的话不能代替关系证据";
  return "行为倾向的证据锚须来自可确认的自主生活选择或本人实际表达，不能用页面与旁观资料代替";
}

function autonomous(item: PerceivedEvidence): boolean {
  const experience = item.experience;
  return experience?.agency === "self" && experience.outcome === "completed" && experience.opportunity === true &&
    experience.internalThought !== true && !!experience.action?.trim();
}

function physical(item: PerceivedEvidence): boolean {
  return !chatEvidence(item) && (item.source === "world" || item.experience?.worldPerception === true);
}

function voluntaryPhysicalChoice(item: PerceivedEvidence): boolean {
  if (!physical(item) || !autonomous(item)) return false;
  const action = (item.experience!.action ?? "").replace(/^动作[「“"\s]*/u, "").trim();
  // Reject clear interface/observation-only operations. Do not classify their
  // results or questionnaire option text as freely chosen personal preferences.
  return !/^(?:工具\s|(?:拿起|放下).{0,8}手机|(?:打开|关闭|切换|查看|阅读|浏览|搜索|访问|点击|滚动|刷新|截图|观察|看见|看到|看了|听见|听到))/u.test(action);
}

function selfSpeech(item: PerceivedEvidence): string[] {
  if (!autonomous(item)) return [];
  const chat = item.experience?.chat;
  if (chat?.kind === "send" && chat.senderOwn === true) {
    // Only the submitted own-body section counts, never a quoted peer in text.
    const action = item.experience!.action!;
    const sent = /^向 [\s\S]+? 发送了消息：([\s\S]*)$/u.exec(action);
    if (sent) return [spokenText(sent[1]!)];
    // External-send simulation uses this explicit action form with the real body.
    if (/^send\s/u.test(action)) return [spokenText(action.replace(/^send\s/u, ""))];
    return [];
  }
  if (chat?.kind === "message" && chat.senderOwn === true) return [spokenText(item.text)];
  return [];
}

/** Exclude program media descriptions and quoted originals before attributing
 * speech. Real textual messages can still contain platform at/face elements. */
function spokenText(value: string): string {
  return value.replace(/<media\b[^>]*>[\s\S]*?<\/media\s*>/giu, "")
    .replace(/<quote\b[^>]*>[\s\S]*?<\/quote\s*>/giu, "")
    .replace(/<(?:quote|sender|at|face)\b[^>]*\/?\s*>/giu, "");
}

function meaningfulSpeech(value: string): boolean {
  const text = spokenText(value).replace(/\[(?:图片|表情包|视频|语音|音频|文件)(?:[^\]]*)\]/gu, "").trim();
  return /[\p{L}\p{N}]/u.test(text) && !/^(?:图片|表情包|视频|语音|音频|文件|已读|收到|嗯|哦|哈哈|哈|好|好的)[。！!\s]*$/u.test(text);
}

function preferenceExpression(quote: string): boolean {
  return /(?:我|我们|本人|本大王|老子|咱)(?:[^。！？\n]{0,24})(?:喜欢|更爱|偏爱|讨厌|不爱|不喜欢|宁愿|更愿意|不愿意|受不了|最爱|爱吃|爱喝|爱看|习惯|比较想)/u.test(quote) ||
    /^(?:更喜欢|最喜欢|不喜欢|喜欢|讨厌|偏爱|宁愿|还是喜欢|还是更喜欢|我选|我要选)/u.test(quote);
}

function commitmentExpression(quote: string): boolean {
  if (/^(?:我|本人|咱|本大王)?(?:没|没有|并未|从未)(?:有)?(?:答应|承诺|保证)/u.test(quote.trim())) return false;
  if (/^(?:假如|假设|比如|例如|要是)|^(?:如果|假如).{0,8}我(?:答应|承诺|保证)/u.test(quote.trim())) return false;
  if (/[?？]\s*$/u.test(quote) && !/(?:说定了|一言为定|答应你|保证)/u.test(quote)) return false;
  return /(?:答应|承诺|保证|说定了|一言为定|包在我|交给我|算我一个|不见不散|我来(?:帮|做|负责|处理|带|发|交|送)|我(?:负责|帮你|给你|替你)|我(?:会|一定)[^。！？\n]{0,20}(?:给你|帮你|陪你|替你|按时|准时|还你|完成|兑现)|(?:明天|后天|今晚|周[一二三四五六日天]|下周|稍后|等会|待会).{0,20}(?:给你|帮你|陪你|找你|一起|发给|送到)|(?:约定|说好|约好).{0,20}(?:取消|不作数|改到|延期|做不到|做不了)|(?:之前|原先|原来).{0,8}答应.{0,25}(?:做不了|做不到|取消|改到|延期)|(?:已经|按约|如约).{0,20}(?:交了|交给|发给|送到|做完|完成|兑现))/u.test(quote);
}

/** A fragment cut out of a denial/question cannot borrow the surrounding
 * message's identity and turn into an affirmative expression. */
function containsWholeExpression(source: string, quote: string): boolean {
  const at = source.indexOf(quote);
  if (at < 0) return false;
  const before = source.slice(Math.max(0, at - 12), at);
  return !/(?:不是说|并不是|没有说|没说|比如|例如|假如|假设|如果|要是|问卷|选项|选择题|原话是|他说|她说|你说)[：:“"\s]*$/u.test(before);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new Error(`${field} 须为 ${min} 至 ${max} 字符的文本`);
  return value.trim();
}
function sameText(a: string, b: string): boolean { return a.replace(/\s/g, "") === b.replace(/\s/g, ""); }
