import type { PhonePhysicalState } from "../types.js";
import type { NarrativeEvolution, NarrativeExternalChange } from "./narrative-types.js";

/** The caller still checks actor authority, physical/device boundaries and current time. */
export interface WorldEvolutionInput {
  worldState?: string;
  externalChanges?: NarrativeExternalChange[];
  perceptions: { actorId: string; changeIds?: string[] }[];
  actorEffects?: { actorId: string; state: string; changeIds: string[] }[];
  phoneState?: PhonePhysicalState;
  phoneChangeIds?: string[];
}
export interface WorldEvolutionContext {
  storedWorldState: string;
  /** The exact state shown to inference, including any program-restored archival tail. */
  projectedWorldState: string;
}
export type NormalizedWorldEvolution =
  | { quiet: true; evolution?: never; worldState?: never }
  | { quiet: false; evolution: NarrativeEvolution; worldState: string };

function invalid(code: string, field: string, reason: string): never {
  throw new Error(`${code}: ${field}${reason}。本次结果尚未保存。`);
}
function nonempty(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}

/**
 * Distinguish a quiet round from an external event before comparing durable prose.
 * Read-time projection is not a physical change and must never rewrite the archive.
 * Conversely, a new event need not change the persistent situation: its cause and
 * delivered perceptions are already recorded in this transaction's source ledger.
 */
export function normalizeWorldEvolution(input: WorldEvolutionInput, context: WorldEvolutionContext): NormalizedWorldEvolution {
  if (input.worldState !== undefined && !nonempty(input.worldState, 200_000)) {
    invalid("EVOLUTION_WORLD_STATE", "worldState", "必须是非空自然语言状态全文（最多200000字）");
  }
  const changes = input.externalChanges === undefined ? [] : input.externalChanges;
  if (!Array.isArray(changes) || changes.length > 100) invalid("EVOLUTION_CHANGES", "externalChanges", "必须是最多100项的数组");
  const ids = new Set<string>();
  for (const [index, change] of changes.entries()) {
    const field = `externalChanges[${index}]`;
    if (!change || typeof change !== "object" || Array.isArray(change) || Object.keys(change).some(key => !["id", "description"].includes(key))) {
      invalid("EVOLUTION_CHANGE", field, "只接受id与description");
    }
    if (!nonempty(change.id, 80)) invalid("EVOLUTION_CHANGE_ID", `${field}.id`, "必须是1至80字的非空标识");
    if (ids.has(change.id)) invalid("EVOLUTION_DUPLICATE_CHANGE", `${field}.id`, `重复定义了${JSON.stringify(change.id)}，每个本轮原因只能登记一次`);
    if (!nonempty(change.description, 200_000)) invalid("EVOLUTION_CHANGE_DESCRIPTION", `${field}.description`, "必须写明本轮实际经过（1至200000字）");
    ids.add(change.id);
  }

  const references = (value: unknown, field: string): string[] => {
    if (value === undefined) invalid("EVOLUTION_REFERENCE_MISSING", field, "缺失，须引用本次externalChanges中已登记的原因id");
    if (!Array.isArray(value) || value.length > 100) invalid("EVOLUTION_REFERENCE_INVALID", field, "必须是最多100项的原因id数组");
    if (!value.length) invalid("EVOLUTION_REFERENCE_EMPTY", field, "不能为空，须引用至少一个本轮外部原因");
    const seen = new Set<string>();
    return value.map((id, index) => {
      if (!nonempty(id, 80)) invalid("EVOLUTION_REFERENCE_INVALID", `${field}[${index}]`, "必须是1至80字的原因id");
      if (seen.has(id)) invalid("EVOLUTION_REFERENCE_DUPLICATE", `${field}[${index}]`, `重复引用了${JSON.stringify(id)}`);
      if (!ids.has(id)) invalid("EVOLUTION_REFERENCE_UNKNOWN", `${field}[${index}]`, `引用了未在本次externalChanges登记的${JSON.stringify(id)}，不能引用旧事件或虚构原因`);
      seen.add(id); return id;
    });
  };
  const sources = (value: unknown, field: "actorEffects" | "perceptions"): { actorId: string; changeIds: string[] }[] => {
    if (!Array.isArray(value) || value.length > 100) invalid("EVOLUTION_SOURCES", field, "必须是最多100项的数组");
    const actors = new Set<string>();
    return value.map((source, index) => {
      if (!source || typeof source !== "object" || Array.isArray(source) || !nonempty(source.actorId, 256)) {
        invalid("EVOLUTION_ACTOR_ID", `${field}[${index}].actorId`, "必须是有效角色标识");
      }
      if (actors.has(source.actorId)) invalid("EVOLUTION_DUPLICATE_ACTOR", `${field}[${index}].actorId`, `重复登记了${JSON.stringify(source.actorId)}，同一角色的${field === "perceptions" ? "感知" : "身体影响"}应合并为一份`);
      actors.add(source.actorId);
      return { actorId: source.actorId, changeIds: references(source.changeIds, `${field}[${index}].changeIds`) };
    });
  };
  const actorEffects = sources(input.actorEffects === undefined ? [] : input.actorEffects, "actorEffects");
  const perceptionSources = sources(input.perceptions, "perceptions");
  if (input.phoneState !== undefined && input.phoneChangeIds === undefined) {
    invalid("EVOLUTION_PHONE_SOURCE_MISSING", "phoneChangeIds", "缺失；提交phoneState时必须引用本轮手机物理变化的原因，无变化请同时省略这两个字段");
  }
  if (input.phoneState === undefined && input.phoneChangeIds !== undefined) {
    invalid("EVOLUTION_PHONE_STATE_MISSING", "phoneState", "缺失；phoneChangeIds只能与本次手机物理状态更新一起提交，无变化请同时省略这两个字段");
  }
  const phoneChangeIds = input.phoneChangeIds === undefined ? undefined : references(input.phoneChangeIds, "phoneChangeIds");

  if (!changes.length) {
    if (input.worldState !== undefined && input.worldState !== context.storedWorldState && input.worldState !== context.projectedWorldState) {
      invalid("EVOLUTION_CHANGES_REQUIRED", "externalChanges", "缺失或为空，但worldState已经改写；真实外部变化须登记本轮原因，安静时省略worldState并返回perceptions:[]，不能仅整理措辞就声称发生事件");
    }
    return { quiet: true };
  }
  return {
    quiet: false,
    // An event-only round does not implicitly replace historical text with its projection.
    worldState: input.worldState === undefined || input.worldState === context.projectedWorldState ? context.storedWorldState : input.worldState,
    evolution: { changes: changes.map(change => ({ id: change.id, description: change.description })), actorEffects, perceptionSources,
      ...(phoneChangeIds === undefined ? {} : { phoneChangeIds }) },
  };
}
