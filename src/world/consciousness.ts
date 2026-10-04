/** Explicitly adjudicated consciousness; missing legacy data stays unknown. */
export type NarrativeConsciousness = "awake" | "asleep" | "unconscious";

export function validNarrativeConsciousness(value: unknown): value is NarrativeConsciousness {
  return value === "awake" || value === "asleep" || value === "unconscious";
}

/** Validate provenance, not prose: no keyword search can establish a bodily state. */
export function assertConsciousnessAuthority(input: {
  actorStates?: { actorId: string; consciousness?: unknown }[];
  actorEffects?: { actorId: string; consciousness?: unknown; changeIds?: string[] }[];
}, kind: string): void {
  for (const actor of input.actorStates ?? []) {
    if (!Object.hasOwn(actor, "consciousness")) continue;
    if (!validNarrativeConsciousness(actor.consciousness)) throw new Error("WORLD_CONSCIOUSNESS_VALUE: 意识状态只能为awake、asleep或unconscious。");
    if (kind !== "initialize" && kind !== "action") throw new Error("WORLD_CONSCIOUSNESS_AUTHORITY: 只有创世或实际身体行动可通过actorStates裁定意识变化，观察和应用读取不能使角色入睡或醒来。");
  }
  for (const actor of input.actorEffects ?? []) {
    if (!Object.hasOwn(actor, "consciousness")) continue;
    if (!validNarrativeConsciousness(actor.consciousness)) throw new Error("WORLD_CONSCIOUSNESS_VALUE: 意识状态只能为awake、asleep或unconscious。");
    if (kind !== "evolve" || !actor.changeIds?.length) throw new Error("WORLD_CONSCIOUSNESS_AUTHORITY: 外部意识变化必须通过本轮actorEffects引用真实外因changeIds，不由等待、无消息或文字描写推断。");
  }
}
