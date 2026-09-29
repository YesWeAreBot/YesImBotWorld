/** Corrections edit one uncommitted proposal, never the saved world or prior requests. */
export const MAX_REPAIR_DRAFT_CHARS = 60_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveWorldDraft(value: Record<string, unknown>, previous?: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(value, "repair")) return structuredClone(value);
  if (!previous) throw new Error("WORLD_REPAIR_UNAVAILABLE: 本次没有可修改的未提交草稿，请返回完整裁定。");
  if (Object.keys(value).length !== 1 || !object(value.repair)) throw new Error("WORLD_REPAIR_FORMAT: repair须单独提交，不能与完整裁定字段混用。");
  const repair = value.repair;
  if (Object.keys(repair).some(key => !["set", "remove"].includes(key)) ||
      (repair.set !== undefined && (!object(repair.set) || !Object.keys(repair.set).length)) ||
      (repair.remove !== undefined && (!Array.isArray(repair.remove) || repair.remove.length > 32 ||
        repair.remove.some(key => typeof key !== "string" || !key || key.length > 80)))) {
    throw new Error("WORLD_REPAIR_FORMAT: set按顶层字段完整替换，remove是要移除的顶层字段名数组。");
  }
  const set = (repair.set ?? {}) as Record<string, unknown>, remove = (repair.remove ?? []) as string[];
  const changed = Object.keys(set);
  if (!changed.length && !remove.length) throw new Error("WORLD_REPAIR_EMPTY: 修正至少一个字段，或重新提交完整裁定。");
  if (changed.length > 32 || new Set(remove).size !== remove.length || remove.some(key => Object.hasOwn(set, key))) {
    throw new Error("WORLD_REPAIR_CONFLICT: 同一字段不能同时替换和移除，移除字段不能重复。");
  }
  if ([...changed, ...remove].some(key => ["__proto__", "prototype", "constructor", "repair"].includes(key))) {
    throw new Error("WORLD_REPAIR_FIELD: 不接受该修正字段。");
  }
  const next = structuredClone(previous);
  for (const key of remove) delete next[key];
  for (const key of changed) next[key] = structuredClone(set[key]);
  return next;
}

/** Large/invalid output still gets ordinary bounded diagnostics and a full retry. */
export function retainedWorldDraft(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return JSON.stringify(value).length <= MAX_REPAIR_DRAFT_CHARS ? structuredClone(value) : undefined;
}
