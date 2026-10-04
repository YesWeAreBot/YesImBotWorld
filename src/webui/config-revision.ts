import { createHash } from "node:crypto";
import type { Config } from "../config.js";

/** Fingerprint the full configuration, including secrets, for admin-only reload confirmation. */
export function configurationRevision(config: Config): string {
  // JSON semantics omit undefined object properties and retain array positions.
  // Sorting each object's keys makes loader/property insertion order irrelevant.
  const canonical = JSON.stringify(config, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
