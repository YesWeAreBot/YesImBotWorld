import type { BotEvent } from "../types.js";

/** Suggestions are retained in the raw audit, but never offered as experienced facts. */
export function narrativeFactText(event: BotEvent): string {
  if ((event.source !== "world" && !event.experience?.worldPerception) || event.parts?.length || event.attachments?.length) return event.content;
  let body = event.content, prefix = "";
  if (body.startsWith("（以下是外部操纵你身体/设备产生的回执，")) {
    const end = body.indexOf("\n");
    if (end < 0) return body;
    prefix = body.slice(0, end + 1); body = body.slice(end + 1);
  }
  try {
    const value = JSON.parse(body), observation = value?.observation ?? value;
    if (observation?.mode !== "narrative" || typeof observation.actorId !== "string") return event.content;
    let changed = false;
    for (const section of [value, observation, value.scene, observation.scene]) {
      if (section && typeof section === "object" && Object.hasOwn(section, "opportunities")) {
        delete section.opportunities; changed = true;
      }
    }
    return changed ? prefix + JSON.stringify(value) : event.content;
  } catch { return event.content; }
}
