import { createHash } from "node:crypto";

const MAX_TEXT = 200_000;
const MAX_EDITS = 32;
const SPLIT_THRESHOLD = 1200;
const TARGET_CHUNK = 800;

/** Addresses belong to one displayed document revision, not to world entities. */
export interface WorldDocument {
  readonly revision: string;
  readonly paragraphs: readonly { readonly id: string; readonly text: string }[];
}
interface Span { start: number; end: number }
interface Original { text: string; spans: Span[]; revision: string }
const originals = new WeakMap<WorldDocument, Original>();

const textSchema = { type: "string", minLength: 1, maxLength: MAX_TEXT };
const idSchema = { type: "string", pattern: "^p[1-9][0-9]*$", maxLength: 32 };
export const worldPatchSchema = {
  type: "object", additionalProperties: false, required: ["revision", "edits"],
  description: "仅编辑本轮worldDocument中的自然语言段落；revision和id照抄本轮输入。未改段落保留。所有id指向原文，同一段只可修改一次；append按列出顺序追加到末尾。空edits表示不更新，不能与worldState全文同时提交。",
  properties: {
    revision: { type: "string", minLength: 1, maxLength: 128 },
    edits: { type: "array", maxItems: MAX_EDITS, items: { oneOf: [
      { type: "object", additionalProperties: false, required: ["op", "id", "text"], properties: { op: { type: "string", enum: ["replace"] }, id: idSchema, text: textSchema } },
      { type: "object", additionalProperties: false, required: ["op", "id"], properties: { op: { type: "string", enum: ["delete"] }, id: idSchema } },
      { type: "object", additionalProperties: false, required: ["op", "text"], properties: { op: { type: "string", enum: ["append"] }, text: textSchema } },
    ] } },
  },
};

function fail(reason: string): never { throw new Error(`WORLD_PATCH_INVALID: ${reason}。本次补丁未应用。`); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: string[], required: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(`${label}字段不完整或包含未声明字段`);
}
function editText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) fail(`text须为非空自然语言，最多${MAX_TEXT}字符`);
  return value;
}

/** Keep offsets in the original string; presentation never normalizes its whitespace. */
function paragraphSpans(text: string): Span[] {
  const spans: Span[] = [];
  const add = (from: number, to: number): void => {
    const raw = text.slice(from, to), left = raw.length - raw.trimStart().length, right = raw.trimEnd().length;
    if (right <= left) return;
    from += left; to = from + right - left;
    const paragraph = text.slice(from, to);
    if (paragraph.length <= SPLIT_THRESHOLD) { spans.push({ start: from, end: to }); return; }
    let cursor = from;
    // Prefer actual sentence ends or existing line boundaries. Never split an
    // unpunctuated sentence at an arbitrary character or split a surrogate pair.
    const boundaries = /[。！？!?；;]+[”’」』）)\]]*(?:[ \t]+|\r?\n)*|\.+[”’")\]]*(?:[ \t]+|\r?\n)+|\r?\n/gu;
    for (const match of paragraph.matchAll(boundaries)) {
      const through = from + match.index! + match[0].length;
      if (through - cursor < TARGET_CHUNK || through >= to) continue;
      const chunk = text.slice(cursor, through), start = cursor + chunk.length - chunk.trimStart().length, end = cursor + chunk.trimEnd().length;
      if (end > start) spans.push({ start, end });
      cursor = through;
    }
    const tail = text.slice(cursor, to), start = cursor + tail.length - tail.trimStart().length;
    if (to > start) spans.push({ start, end: to });
  };
  let cursor = 0;
  for (const match of text.matchAll(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g)) {
    add(cursor, match.index!); cursor = match.index! + match[0].length;
  }
  add(cursor, text.length);
  return spans;
}

export function createWorldDocument(text: string, sequence: number): WorldDocument {
  if (typeof text !== "string" || text.length > MAX_TEXT) fail(`文档须为最多${MAX_TEXT}字符的文本`);
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail("文档版本须为非负安全整数");
  const revision = `${sequence}:${createHash("sha256").update(JSON.stringify([sequence, text])).digest("hex").slice(0, 24)}`;
  const spans = paragraphSpans(text);
  const document = Object.freeze({ revision, paragraphs: Object.freeze(spans.map((span, index) =>
    Object.freeze({ id: `p${index + 1}`, text: text.slice(span.start, span.end) }))) });
  originals.set(document, { text, spans, revision });
  return document;
}

/** Preserve a real separator when removed blocks formerly separated two paragraphs. */
function separator(original: Original, left: number, right: number): string {
  let chosen = "", lines = -1;
  for (let index = left; index < right; index++) {
    const gap = original.text.slice(original.spans[index]!.end, original.spans[index + 1]!.start);
    const count = (gap.match(/\n/g) ?? []).length;
    if (count >= lines) { chosen = gap; lines = count; }
  }
  return chosen;
}

/** Validate against one immutable base, then materialize a full candidate for the
 * caller's authority/time/device checks and existing atomic world transaction. */
export function applyWorldPatch(document: WorldDocument, patch: unknown): string | undefined {
  const original = originals.get(document);
  if (!original) fail("文档不是本轮创建的原始快照");
  if (!record(patch)) fail("worldPatch须为对象");
  exactKeys(patch, ["revision", "edits"], ["revision", "edits"], "worldPatch");
  if (patch.revision !== original.revision) fail("revision不匹配，请使用本轮worldDocument.revision");
  if (!Array.isArray(patch.edits) || patch.edits.length > MAX_EDITS) fail(`edits须为最多${MAX_EDITS}项的数组`);
  const changes = new Map<number, string | null>(), appended: string[] = [];
  const indexes = new Map(document.paragraphs.map((paragraph, index) => [paragraph.id, index]));
  for (const [index, edit] of patch.edits.entries()) {
    if (!record(edit) || typeof edit.op !== "string" || !["replace", "delete", "append"].includes(edit.op)) fail(`edits[${index}].op无效`);
    const keys = edit.op === "replace" ? ["op", "id", "text"] : edit.op === "delete" ? ["op", "id"] : ["op", "text"];
    exactKeys(edit, keys, keys, `edits[${index}]`);
    if (edit.op === "append") { appended.push(editText(edit.text)); continue; }
    if (typeof edit.id !== "string" || !indexes.has(edit.id)) fail(`edits[${index}].id不是本轮原文段落`);
    const target = indexes.get(edit.id)!;
    if (changes.has(target)) fail(`段落${edit.id}在同一补丁中重复修改`);
    changes.set(target, edit.op === "delete" ? null : editText(edit.text));
  }
  const spans = original.spans, newline = original.text.includes("\r\n") ? "\r\n" : "\n";
  const kept = spans.map((_, index) => index).filter(index => changes.get(index) !== null);
  let result = spans.length ? original.text.slice(0, spans[0]!.start) : original.text;
  let previous: number | undefined, previousText = "";
  for (const index of kept) {
    const value = changes.get(index) ?? document.paragraphs[index]!.text;
    if (previous !== undefined) {
      let gap = separator(original, previous, index);
      // Sentence chunks may originally touch without whitespace. A replacement
      // omitting final punctuation must not glue itself to the next unchanged text.
      if (!gap && !/[.!?。！？；;][”’」』）)\]]*\s*$/u.test(previousText) && !/\s$/u.test(previousText) && !/^\s/u.test(value)) gap = newline;
      result += gap;
    }
    result += value; previous = index; previousText = value;
  }
  if (spans.length) result += original.text.slice(spans.at(-1)!.end);
  for (const text of appended) {
    if (result.trim()) {
      // Preserve the existing document as a prefix when only appending.
      const tail = result.slice(result.trimEnd().length), count = (tail.match(/\n/g) ?? []).length;
      result += count >= 2 ? "" : newline.repeat(2 - count);
    }
    result += text;
  }
  if (result === original.text) return undefined;
  if (!result.trim()) fail("更新后的世界文档不能为空");
  if (result.length > MAX_TEXT) fail(`合并后的世界文档超过${MAX_TEXT}字符`);
  return result;
}
