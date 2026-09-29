import type { ClockAuthority } from "../clock.js";
import { detectDeviceClaim, detectDeviceRequest } from "./device-boundary.js";
import { validNarrativePresentation } from "./narrative-types.js";
import { assertCurrentTime } from "./time-boundary.js";

/** Suggestions have no factual effects. Discard an invalid whole option rather than
 * re-adjudicating an otherwise valid scene. Never sanitize prose/state/causal sources.
 * Keep an explicit [] when all options were removed so an old menu cannot survive. */
export function filterOptionalSuggestions(proposal: Record<string, unknown>, authority: ClockAuthority): number {
  if (!Array.isArray(proposal.perceptions)) return 0;
  let dropped = 0;
  for (const perception of proposal.perceptions) {
    if (!perception || typeof perception !== "object" || Array.isArray(perception) || !Object.hasOwn(perception, "opportunities")) continue;
    const suggestions = perception.opportunities;
    if (!Array.isArray(suggestions)) { perception.opportunities = []; dropped++; continue; }
    perception.opportunities = suggestions.filter(item => {
      if (!validNarrativePresentation({ opportunities: [item] })) { dropped++; return false; }
      const values = Object.values(item) as string[];
      try {
        for (const text of [...values, values.join("，")]) {
          assertCurrentTime(text, authority, "opportunities");
          if (detectDeviceClaim(text) || detectDeviceRequest(text)) { dropped++; return false; }
        }
      } catch { dropped++; return false; }
      return true;
    });
    if (perception.opportunities.length > 4) {
      dropped += perception.opportunities.length - 4;
      perception.opportunities = perception.opportunities.slice(0, 4);
    }
  }
  return dropped;
}
