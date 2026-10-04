import type { ChatResult } from "../llm/chat.js";
import type { ReflectionInput } from "./growth.js";

const kinds = ["relationship", "commitment", "preference", "state", "habit", "trait"];
const relations = ["support", "counter", "revise", "retire"];
const fields = ["kind", "subject", "statement", "evidenceIds", "relation", "claimId", "situation", "cues", "subjectId", "expiresAt", "behavior", "insight"];
const textSchema = (minLength: number, maxLength: number) => ({ type: "string", minLength, maxLength });

/** This vocabulary belongs to one rendered request, never to the ledger or another review. */
export class GrowthSubjectReferences {
  private aliases = new Map<string, string>();

  reference(original: string): string {
    let alias = this.aliases.get(original);
    if (!alias) {
      alias = `s${this.aliases.size + 1}`;
      this.aliases.set(original, alias);
    }
    return alias;
  }

  visible(originals: Iterable<string>): Map<string, string> {
    return new Map([...originals].map(original => [this.reference(original), original]));
  }
}

export interface GrowthProposalVocabulary {
  evidenceIds: Set<string>;
  editableClaims: Set<string>;
  subjectReferences: Map<string, string>;
}

/** Shape and visible-reference constraints supplement, never replace, the ledger's admission rules. */
export function growthProposalSchema(vocabulary: GrowthProposalVocabulary): Record<string, unknown> {
  const eventId = { ...textSchema(1, 300), enum: [...vocabulary.evidenceIds] };
  const properties: Record<string, unknown> = {
    kind: { type: "string", enum: kinds }, subject: textSchema(1, 200), statement: textSchema(1, 1200),
    evidenceIds: { type: "array", minItems: 1, maxItems: 20, items: eventId },
    relation: { type: "string", enum: relations }, situation: textSchema(1, 500),
    cues: { type: "array", maxItems: 12, items: textSchema(1, 100) },
    expiresAt: { type: "number", minimum: 0 }, behavior: textSchema(2, 200),
    insight: { type: "object", additionalProperties: false, required: ["dimension", "significance", "anchors"], properties: {
      dimension: textSchema(2, 100), significance: textSchema(8, 600),
      anchors: { type: "array", minItems: 1, maxItems: 4, items: {
        type: "object", additionalProperties: false, required: ["eventId", "quote"],
        properties: { eventId, quote: textSchema(2, 500) },
      } },
    } },
  };
  if (vocabulary.editableClaims.size) properties.claimId = { type: "string", enum: [...vocabulary.editableClaims] };
  if (vocabulary.subjectReferences.size) properties.subjectId = { type: "string", enum: [...vocabulary.subjectReferences.keys()] };
  return { type: "object", additionalProperties: false, required: ["changes"], properties: {
    changes: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
      required: ["kind", "subject", "statement", "evidenceIds"], properties } },
  } };
}

export function parseGrowthChanges(result: ChatResult): unknown[] {
  if (result.toolCalls.length) throw new Error("成长整理只能返回正文 JSON，不能调用工具");
  let text = result.content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new Error("成长整理正文不是完整有效的 JSON 对象"); }
  const object = record(data, "成长整理结果", ["changes"]);
  if (!Array.isArray(object.changes)) throw new Error("成长整理 changes 必须为数组，允许空数组");
  if (object.changes.length > 8) throw new Error("成长整理每次最多 8 项变化");
  return object.changes;
}

/** Validate field shape before touching anchors, so type errors do not masquerade as bad evidence. */
export function parseGrowthChange(value: unknown, subjectReferences: ReadonlyMap<string, string>): ReflectionInput {
  const data = record(value, "成长认识", fields);
  enumText(data.kind, "kind", kinds);
  text(data.subject, "subject", 1, 200);
  text(data.statement, "statement", 1, 1200);
  texts(data.evidenceIds, "evidenceIds", 1, 20, 300);
  if (data.relation !== undefined) enumText(data.relation, "relation", relations);
  for (const [field, min, max] of [["claimId", 1, 300], ["situation", 1, 500], ["subjectId", 1, 300], ["behavior", 2, 200]] as const) {
    if (data[field] !== undefined) text(data[field], field, min, max);
  }
  if (data.cues !== undefined) texts(data.cues, "cues", 0, 12, 100);
  if (data.expiresAt !== undefined && (typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt) || data.expiresAt < 0)) {
    throw new Error("expiresAt 必须为有限的非负数字");
  }
  if (data.insight !== undefined) {
    const insight = record(data.insight, "insight", ["dimension", "significance", "anchors"]);
    text(insight.dimension, "insight.dimension", 2, 100);
    text(insight.significance, "insight.significance", 8, 600);
    if (!Array.isArray(insight.anchors) || !insight.anchors.length || insight.anchors.length > 4) throw new Error("insight.anchors 必须为 1 至 4 项数组");
    for (const [index, value] of insight.anchors.entries()) {
      const field = `insight.anchors[${index}]`;
      const anchor = record(value, field, ["eventId", "quote"]);
      text(anchor.eventId, `${field}.eventId`, 1, 300);
      text(anchor.quote, `${field}.quote`, 2, 500);
    }
  }
  const change = { ...data } as unknown as ReflectionInput;
  if (change.subjectId !== undefined) {
    const original = subjectReferences.get(change.subjectId);
    if (original === undefined) throw new Error("subjectId 必须引用本次材料中的身份短号；未知短号或原始身份编号不能采用");
    change.subjectId = original;
  }
  return change;
}

function record(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 必须为对象`);
  const data = value as Record<string, unknown>;
  const unknown = Object.keys(data).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${field} 包含未定义字段 ${unknown}`);
  return data;
}
function text(value: unknown, field: string, min: number, max: number): void {
  if (value === undefined) throw new Error(`${field} 缺失`);
  if (typeof value !== "string") throw new Error(`${field} 必须为字符串`);
  if (value.trim().length < min || value.length > max) throw new Error(`${field} 须为 ${min} 至 ${max} 字符的文本`);
}
function enumText(value: unknown, field: string, allowed: string[]): void {
  text(value, field, 1, 100);
  if (!allowed.includes(value as string)) throw new Error(`${field} 须为 ${allowed.join("、")}`);
}
function texts(value: unknown, field: string, min: number, max: number, width: number): void {
  if (!Array.isArray(value)) throw new Error(`${field} 必须为数组`);
  if (value.length < min || value.length > max) throw new Error(`${field} 须为 ${min} 至 ${max} 项数组`);
  value.forEach((item, index) => text(item, `${field}[${index}]`, 1, width));
}
