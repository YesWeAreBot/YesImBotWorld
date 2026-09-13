import { createHash } from "node:crypto";
import type { WorldAction, WorldExperience, WorldObservation } from "./state.js";

export interface PerceivedAction {
  id: string;
  intent: string;
  status: WorldAction["status"];
  startedAt?: number;
  finishedAt?: number;
  /** A perceptible explanation only; never copy the adjudicator's private diagnostic. */
  reason?: string;
}

export interface WorldScene {
  eventId: string;
  actorId: string;
  actionId?: string;
  worldSequence: number;
  worldTime: number;
  sourceEventIds: string[];
  text: string;
}

/** A read-only scene projection. Every factual sentence is an already committed perception.
 * It cannot invent dialogue, scenery or the controlled character's feelings, and adds no
 * model round trip to action delivery. The full ordered evidence remains in observation.
 */
export function renderScene(observation: WorldObservation, action?: PerceivedAction): WorldScene | undefined {
  const seen = new Set<string>();
  const experiences = (observation.experiences ?? []).filter(item => {
    if (seen.has(item.eventId) || (action && item.correlationId !== action.id)) return false;
    seen.add(item.eventId); return true;
  }).sort(compareExperiences);
  const meaningful = experiences.filter(item => item.kind !== "action" || item.details?.phase !== "start");
  if (!meaningful.length && !action) return undefined;
  // Keep the scene short, while never dropping a final outcome in favor of property detail.
  const selected = meaningful.length <= 24 ? meaningful : [...meaningful.slice(0, 23), meaningful.at(-1)!];
  const paragraphs: string[] = [];
  let paragraph = "";
  for (const item of selected) {
    const line = item.text.trim();
    if (!line) continue;
    if (item.kind === "speech" || item.kind === "action") {
      if (paragraph) { paragraphs.push(paragraph); paragraph = ""; }
      paragraphs.push(line);
    } else {
      if (paragraph && paragraph.length + line.length > 160) { paragraphs.push(paragraph); paragraph = ""; }
      paragraph += line;
    }
  }
  if (paragraph) paragraphs.push(paragraph);
  if (meaningful.length > selected.length) paragraphs.push(`另外还有 ${meaningful.length - selected.length} 条变化，可展开查看完整经过。`);
  if (action && !selected.some(item => item.kind === "action" && item.details?.phase === "finish")) {
    paragraphs.push(action.status === "needs_input" ? "这次行动已推进到需要你作新决定的地方。请根据眼前的情境继续行动。"
      : action.status === "completed" ? "这次行动已完成。"
      : action.status === "failed" ? "这次行动没有完成。请根据实际可见的变化判断下一步。"
      : action.status === "cancelled" ? "这次行动已取消。" : `你正在尝试：${action.intent}`);
  }
  const text = paragraphs.join("\n\n");
  if (!text) return undefined;
  const worldSequence = Math.max(0, ...experiences.map(item => item.worldSequence));
  const worldTime = experiences.length ? Math.max(...experiences.map(item => item.worldTime)) : action?.finishedAt ?? action?.startedAt ?? observation.observedAt;
  const sourceEventIds = [...new Set(experiences.flatMap(item => item.sourceEventIds))];
  const identity = JSON.stringify([observation.actorId, action?.id, experiences.map(item => item.eventId), action?.status, worldSequence, worldTime, text]);
  return { eventId: `scene:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`,
    actorId: observation.actorId, ...(action ? { actionId: action.id } : {}), worldSequence, worldTime, sourceEventIds, text };
}

export function compareExperiences(a: WorldExperience, b: WorldExperience): number {
  return a.worldSequence - b.worldSequence || a.worldTime - b.worldTime || (a.order ?? 0) - (b.order ?? 0);
}

/** Preserve the existing observation shape for tool consumers; scene is a derived reading view. */
export function presentObservation(observation: WorldObservation): WorldObservation & { scene?: WorldScene } {
  const scene = renderScene(observation);
  return { ...observation, ...(scene ? { scene } : {}) };
}
