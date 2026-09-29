/** World document edits are revision-bound prose edits, not entity operations. */
import assert from "node:assert/strict";
import { applyWorldPatch, createWorldDocument, worldPatchSchema } from "../src/world/document.js";

function apply(text: string, edits: unknown[], sequence = 4) {
  const document = createWorldDocument(text, sequence);
  return applyWorldPatch(document, { revision: document.revision, edits });
}

function unchangedTextRemainsExact() {
  const samples = ["", "  \n\t", "只有一段。", "\t开头。  \r\n\r\n  中段。\t\n\n末尾。\n", "A\nB\n\nC\r\n\r\nD", "😀重叠符号e\u0301\n\n第二段\r\n"];
  for (const text of samples) {
    const document = createWorldDocument(text, 7), serialized = JSON.stringify(document);
    assert.equal(applyWorldPatch(document, { revision: document.revision, edits: [] }), undefined);
    assert.equal(applyWorldPatch(document, { revision: document.revision, edits: document.paragraphs.map(({ id, text }) => ({ op: "replace", id, text })) }), undefined);
    assert.equal(JSON.stringify(document), serialized, "applying an edit never mutates the base view");
    assert.equal(createWorldDocument(text, 7).revision, document.revision);
    assert.notEqual(createWorldDocument(text, 8).revision, document.revision);
    assert.notEqual(createWorldDocument(text + " ", 7).revision, document.revision, "whitespace participates in the exact snapshot identity");
  }
  assert.notEqual(createWorldDocument("\ud800", 1).revision, createWorldDocument("\ud801", 1).revision,
    "distinct lone surrogates cannot collapse into the same UTF-8 replacement character hash");
  const text = " \t旧事实甲。\r\n\r\n  旧事实乙。  \n\n旧事实丙。\n";
  assert.equal(apply(text, [{ op: "replace", id: "p2", text: "新事实乙。" }]),
    " \t旧事实甲。\r\n\r\n  新事实乙。  \n\n旧事实丙。\n", "replacement preserves every untouched separator byte");
}

function changesUseOriginalAddresses() {
  const text = "甲段。\n\n乙段。\n\n丙段。";
  assert.equal(apply(text, [{ op: "delete", id: "p1" }, { op: "replace", id: "p3", text: "新丙段。" }]), "乙段。\n\n新丙段。");
  assert.equal(apply(text, [{ op: "replace", id: "p3", text: "新丙段。" }, { op: "delete", id: "p1" }]), "乙段。\n\n新丙段。", "edit order does not shift old addresses");
  assert.equal(apply(text, [{ op: "delete", id: "p2" }]), "甲段。\n\n丙段。", "deletion must not fuse neighboring paragraphs");
  assert.equal(apply(text, [{ op: "delete", id: "p2" }, { op: "delete", id: "p3" }]), "甲段。");
  assert.equal(apply(text, [{ op: "delete", id: "p1" }, { op: "delete", id: "p2" }]), "丙段。");
  assert.equal(apply("同文。\n\n同文。", [{ op: "replace", id: "p2", text: "只改第二段。" }]), "同文。\n\n只改第二段。", "duplicate prose has unambiguous addresses");
  assert.equal(apply("原文。", [{ op: "append", text: "末尾甲。" }, { op: "replace", id: "p1", text: "新原文。" }, { op: "append", text: "末尾乙。" }]),
    "新原文。\n\n末尾甲。\n\n末尾乙。");
  assert.equal(apply("原文。\r\n", [{ op: "append", text: "追加。" }]), "原文。\r\n\r\n追加。");
  assert.equal(apply("原文。\n\n", [{ op: "append", text: "追加。" }]), "原文。\n\n追加。");
  assert.equal(apply("", [{ op: "append", text: "第一段。" }]), "第一段。");
  assert.equal(apply("旧。", [{ op: "delete", id: "p1" }, { op: "append", text: "新。" }]), "新。");
  assert.equal(apply("旧。", [{ op: "delete", id: "p1" }, { op: "append", text: "旧。" }]), undefined, "a net identity edit does not write a transaction");
}

function longParagraphsSplitOnlyAtSafeBoundaries() {
  const sentence = "树影随风轻摇".repeat(90) + "。", text = sentence.repeat(5);
  const document = createWorldDocument(text, 22);
  assert.ok(document.paragraphs.length > 1, "long prose with sentence boundaries should not require a full rewrite");
  assert.ok(document.paragraphs.every(paragraph => paragraph.text.endsWith("。")));
  assert.equal(document.paragraphs.map(paragraph => paragraph.text).join(""), text);
  assert.equal(applyWorldPatch(document, { revision: document.revision, edits: [] }), undefined);
  assert.equal(applyWorldPatch(document, { revision: document.revision, edits: document.paragraphs.map(({ id, text }) => ({ op: "replace", id, text })) }), undefined);
  const changed = applyWorldPatch(document, { revision: document.revision, edits: [{ op: "replace", id: "p1", text: "树木已经倒伏" }] })!;
  assert.ok(changed.startsWith("树木已经倒伏\n"), "a replacement without sentence punctuation cannot glue into the following original sentence");
  assert.equal(changed.slice("树木已经倒伏\n".length), document.paragraphs.slice(1).map(paragraph => paragraph.text).join(""));
  assert.equal(createWorldDocument("风".repeat(1900), 1).paragraphs.length, 1, "unpunctuated prose is not arbitrarily cut");
  const english = ("The courtyard still holds the same quiet memories of the previous evening. ").repeat(35);
  const spaced = createWorldDocument(english, 3);
  assert.ok(spaced.paragraphs.length > 1);
  assert.equal(applyWorldPatch(spaced, { revision: spaced.revision, edits: [] }), undefined, "English sentence whitespace remains byte-identical");
  const multiline = ("灯影".repeat(250) + "\r\n").repeat(6);
  const lines = createWorldDocument(multiline, 3);
  assert.ok(lines.paragraphs.length > 1);
  assert.equal(applyWorldPatch(lines, { revision: lines.revision, edits: [] }), undefined, "existing single line boundaries remain exact");
}

function malformedPatchesAreAtomic() {
  const document = createWorldDocument("甲。\n\n乙。", 12), original = JSON.stringify(document);
  const patch = (edits: unknown[]) => ({ revision: document.revision, edits });
  const invalid: unknown[] = [null, [], 0, "", {}, { revision: document.revision },
    { ...patch([]), hidden: true }, { revision: "wrong", edits: [] }, { revision: document.revision, edits: {} },
    patch([null]), patch([{}]), patch([{ op: "insert", id: "p1", text: "字" }]),
    patch([{ op: "replace", id: "p1" }]), patch([{ op: "replace", id: "p1", text: "" }]),
    patch([{ op: "replace", id: "p1", text: " \r\n " }]), patch([{ op: "replace", id: "p1", text: false }]),
    patch([{ op: "replace", id: "p99", text: "字" }]), patch([{ op: "delete", id: "__proto__" }]),
    patch([{ op: "delete", id: "p01" }]), patch([{ op: "delete", id: 1 }]),
    patch([{ op: "delete", id: "p1", text: "不能偷偷携带文本" }]),
    patch([{ op: "append", id: "p3", text: "字" }]), patch([{ op: "append", text: "字", extra: 1 }]),
    patch([{ op: "replace", id: "p1", text: "甲。" }, { op: "delete", id: "p1" }]),
    patch([{ op: "append", text: "新段。" }, { op: "replace", id: "p3", text: "刚追加的段不可寻址。" }]),
    patch([{ op: "delete", id: "p1" }, { op: "delete", id: "p2" }]),
    patch([{ op: "replace", id: "p1", text: "合法部分。" }, { op: "replace", id: "missing", text: "失败部分。" }]),
    patch(Array.from({ length: 33 }, () => ({ op: "append", text: "字" }))),
  ];
  for (const input of invalid) {
    assert.throws(() => applyWorldPatch(document, input), /WORLD_PATCH_INVALID/);
    assert.equal(JSON.stringify(document), original, "a later invalid edit cannot partially mutate the base");
  }
  assert.throws(() => applyWorldPatch(createWorldDocument("另一版本。", 12), patch([])), /revision不匹配/);
  assert.throws(() => applyWorldPatch(JSON.parse(original), patch([])), /原始快照/);
  assert.equal(applyWorldPatch(document, patch([{ op: "replace", id: "p1", text: "仍可正常应用。" }])), "仍可正常应用。\n\n乙。");
  assert.ok(applyWorldPatch(document, patch(Array.from({ length: 32 }, () => ({ op: "append", text: "字" })))));
}

function limitsAndSchemaAgree() {
  for (const sequence of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createWorldDocument("世界。", sequence), /WORLD_PATCH_INVALID/);
  assert.throws(() => createWorldDocument("字".repeat(200_001), 1), /WORLD_PATCH_INVALID/);
  const full = createWorldDocument("字".repeat(200_000), 1);
  assert.equal(applyWorldPatch(full, { revision: full.revision, edits: [] }), undefined);
  assert.throws(() => applyWorldPatch(full, { revision: full.revision, edits: [{ op: "append", text: "满" }] }), /合并后的世界文档超过/);
  assert.equal(apply("旧", [{ op: "replace", id: "p1", text: "新".repeat(200_000) }])?.length, 200_000);
  assert.throws(() => apply("旧", [{ op: "replace", id: "p1", text: "新".repeat(200_001) }]), /WORLD_PATCH_INVALID/);
  assert.throws(() => apply("前\n\n后", [{ op: "replace", id: "p1", text: "新".repeat(200_000) }]), /合并后的世界文档超过/);
  assert.equal(worldPatchSchema.additionalProperties, false);
  assert.equal(worldPatchSchema.properties.edits.maxItems, 32);
  assert.deepEqual(worldPatchSchema.properties.edits.items.oneOf.map(item => item.properties.op.enum[0]), ["replace", "delete", "append"]);
}

unchangedTextRemainsExact(); changesUseOriginalAddresses(); longParagraphsSplitOnlyAtSafeBoundaries(); malformedPatchesAreAtomic(); limitsAndSchemaAgree();
console.log("PASS world document: exact untouched text, revision binding, original paragraph addresses, sentence chunks, atomic validation, whitespace boundaries, append order and bounded schemas");
