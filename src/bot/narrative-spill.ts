import { sliceText } from "../text.js";

/**
 * Bound a newly delivered world's prose without cutting through its JSON envelope.
 * The same prose can appear in narrative, observation.scene and the receipt's scene;
 * charge it once, just as the model-facing factual projection renders it once.
 * Identity, outcome, provenance and optional future choices remain intact. Choices
 * have their own admission limits and are presented separately from experienced facts.
 */
export function spillNarrativeText(text: string, budget: number, spillFile: string): string | undefined {
  let body = text, prefix = "";
  if (body.startsWith("（以下是外部操纵你身体/设备产生的回执，")) {
    const boundary = body.indexOf("\n");
    if (boundary < 0) return;
    prefix = body.slice(0, boundary + 1); body = body.slice(boundary + 1);
  }
  let value: any;
  try { value = JSON.parse(body); } catch { return; }
  const observation = value?.observation ?? value;
  if (observation?.mode !== "narrative" || typeof observation.actorId !== "string" ||
    typeof observation.observationId !== "string") return;
  if (typeof observation.narrative !== "string" && typeof observation.scene?.text !== "string" && typeof value.scene?.text !== "string") return;

  const groups = new Map<string, { target: Record<string, unknown>; key: string }[]>();
  const add = (target: any, key: string) => {
    if (!target || typeof target[key] !== "string" || !target[key]) return;
    const entries = groups.get(target[key]) ?? [];
    entries.push({ target, key }); groups.set(target[key], entries);
  };
  add(observation, "narrative"); add(observation, "situation");
  for (const scene of [observation.scene, value.scene]) {
    add(scene, "text"); add(scene, "situation");
  }
  for (const key of ["intent", "reason", "speech"]) add(value.action, key);
  // Small fields retain their full meaning; larger ones share the remaining budget.
  // This also bounds unusually long action descriptions instead of allocating the
  // entire allowance independently to every duplicate field.
  let remaining = Math.max(0, Math.floor(budget) - prefix.length);
  const entries = [...groups.entries()].sort(([left], [right]) => left.length - right.length);
  for (let index = 0; index < entries.length; index++) {
    const [original, references] = entries[index]!;
    const allowance = Math.floor(remaining / (entries.length - index));
    if (original.length <= allowance) { remaining -= original.length; continue; }
    const marker = `\n[… 正文已省略，完整结果见 ${spillFile} …]\n`;
    const keep = Math.max(0, allowance - marker.length);
    const head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
    const preview = sliceText(original, 0, head) + marker + (tail ? sliceText(original, original.length - tail) : "");
    for (const { target, key } of references) target[key] = preview;
    remaining = Math.max(0, remaining - preview.length);
  }
  return prefix + JSON.stringify(value);
}
