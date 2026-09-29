import assert from "node:assert/strict";

type WorldInput = { worldState?: unknown; worldDocument?: { revision?: unknown; paragraphs?: { id?: unknown; text?: unknown }[] } };

/** Content-only view for fixture matching, never a claim to recover omitted separators. */
export function worldInputText(input: WorldInput): string {
  if (typeof input.worldState === "string") return input.worldState;
  const document = input.worldDocument;
  assert.ok(document && typeof document.revision === "string" && Array.isArray(document.paragraphs), "World input must contain full prose or a paragraph document");
  assert.equal(new Set(document.paragraphs.map(item => item.id)).size, document.paragraphs.length, "paragraph identities must remain distinct");
  for (const item of document.paragraphs) assert.ok(typeof item.id === "string" && typeof item.text === "string");
  return document.paragraphs.map(item => item.text as string).join("\n\n");
}

/** Document projections omit separators; verify every byte of each paragraph against the
 * known source and allow only its original whitespace between ordered paragraphs. Durable
 * state assertions in the callers still compare the complete original string exactly. */
export function assertWorldInputText(input: WorldInput, expected: string, message?: string): void {
  worldInputText(input);
  if (typeof input.worldState === "string") { assert.equal(input.worldState, expected, message); return; }
  let cursor = 0;
  const preserved: string[] = [];
  for (const item of input.worldDocument!.paragraphs!) {
    const text = item.text as string, start = expected.indexOf(text, cursor);
    assert.ok(start >= cursor, message ?? "input paragraphs retain all original content in order");
    const gap = expected.slice(cursor, start);
    assert.match(gap, /^\s*$/, message ?? "input paragraphs cannot omit any facts between sections");
    preserved.push(gap, text); cursor = start + text.length;
  }
  const suffix = expected.slice(cursor); assert.match(suffix, /^\s*$/, message ?? "input paragraphs cannot omit final facts");
  preserved.push(suffix); assert.equal(preserved.join(""), expected, message);
}
