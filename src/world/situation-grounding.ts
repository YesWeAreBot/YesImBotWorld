import type { PhonePhysicalState, PhoneStatus } from "../types.js";
import { DEFAULT_PHONE_PHYSICAL_STATE } from "../phone-state.js";
import type { NarrativeActor } from "./narrative-types.js";

/** Execution posture is newer than a world-authored resting location. This is a
 * request projection, never a migration of journals or an invented pickup event. */
export function worldPhoneInput(stored: PhonePhysicalState | undefined, execution?: PhoneStatus): { phoneState: PhonePhysicalState; phoneHeld?: boolean } {
  const physical = execution?.physical ?? stored ?? DEFAULT_PHONE_PHYSICAL_STATE;
  const held = execution === undefined ? undefined : !execution.down && physical.reachable;
  const location = held ? "持有者手中" : held === false && physical.location && /(?:手里|手中|掌心|指间)/.test(physical.location) ? null : physical.location;
  return { phoneState: { ...physical, location }, ...(held === undefined ? {} : { phoneHeld: held }) };
}

function unquoted(text: string): string { return text.replace(/[“‘「『"][^”’」』"\n]*[”’」』"]/g, ""); }
function parts(text: string): string[] { return text.split(/(?<=[，,。；;！？!?\n])/u); }
function sentences(text: string): string[] { return text.split(/(?<=[。；;！？!?\n])/u); }
function escape(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
/** Conditions may span a comma: “如果下雨，你走到屋檐下就能避雨” does
 * not assert that walking happened. A later factual sentence is checked normally. */
function factualSentences(text: string): string[] {
  return sentences(unquoted(text)).filter(sentence => !/(?:如果|假如|要是|倘若|一旦|只要|假设|若是)/.test(sentence));
}
/** A following bare “手机” can refer to the other person's device. Retain the
 * whole sentence when ownership is ambiguous rather than erasing its clauses. */
function ambiguousPhoneOwner(sentence: string, ownerName: string): boolean {
  if (/(?:自己|他|她|别人)的手机|另(?:一)?(?:部|台)手机/.test(sentence)) return true;
  return [...sentence.matchAll(/([\p{L}\p{N}_]{1,32})的手机/gu)]
    .some(match => ![ownerName, "你", "我"].includes(match[1]!));
}

/** Only explicit current claims are recognized. Other people's phones, historical
 * mentions, hypotheses and newly caused drops remain ordinary physical prose. */
export function hasContradictoryPhonePosture(text: string, held: boolean | undefined, ownerName: string): boolean {
  if (held === undefined) return false;
  return factualSentences(text).filter(sentence => !ambiguousPhoneOwner(sentence, ownerName)).flatMap(parts).some(part => {
    if (/(?:曾经|原本|原先|此前|之前|刚才|并非|不是|不再|没有|并未)/.test(part)) return false;
    const possessor = /([\p{L}\p{N}_]{1,32})的手机/u.exec(part)?.[1];
    if (possessor && ![ownerName, "你", "我", "自己", "他的", "她的"].includes(possessor)) return false;
    if (held) return (/手机(?:仍然?|依旧|依然|还|正)?(?:平放|躺|放|搁|留|置)(?:着|在|于)/.test(part) ||
      /手机(?:仍然?|依旧|依然|还)?(?:在|位于)(?:.{0,12})(?:砧板|桌面|桌边|台面|床头柜|口袋|背包)/.test(part)) && !/(?:手里|手中|掌心|指间)/.test(part);
    return /(?:你|自己|持有者|主人)(?:正|正在|仍然?|依旧|还)?(?:拿着|握着|攥着|捧着|持有)手机/.test(part) ||
      new RegExp(`${escape(ownerName)}(?:正|正在|仍然?|依旧|还)?(?:拿着|握着|攥着|捧着|持有)手机`).test(part);
  });
}

/** Do not feed an obsolete posture back to inference. Removing only the offending
 * clause retains unrelated locations/weather; persisted prose stays untouched. */
export function projectWorldPhonePosture(text: string, held: boolean | undefined, ownerName: string): string {
  return sentences(text).map(sentence => factualSentences(sentence).length && !ambiguousPhoneOwner(sentence, ownerName)
    ? parts(sentence).filter(part => !hasContradictoryPhonePosture(part, held, ownerName)).join("") : sentence).join("");
}

interface PhysicalProposal {
  worldState?: string;
  phoneState?: PhonePhysicalState;
  actorStates?: { actorId: string; state: string }[];
  actorEffects?: { actorId: string; state: string }[];
  externalChanges?: { id?: string; description: string }[];
  phoneChangeIds?: string[];
  perceptions: { actorId: string; text: string; situation?: string }[];
}

export function assertWorldPhonePosture(input: PhysicalProposal, held: boolean | undefined, ownerName: string, previousWorld: string): void {
  // The initial posture is not a veto against an actually adjudicated loss. The
  // durable phone update must accompany an explicit physical cause; evolution's
  // normal validator still verifies phoneChangeIds and the same-commit source.
  const lossSources = input.phoneChangeIds
    ? (input.externalChanges ?? []).filter(change => change.id && input.phoneChangeIds!.includes(change.id)).map(change => change.description)
    : input.perceptions.filter(perception => perception.actorId === "bot").map(perception => perception.text);
  const lostNow = held === true && input.phoneState?.reachable === false && lossSources.some(text => factualSentences(text).some(sentence =>
    /手机.{0,40}(?:掉进|掉入|掉落|落入|坠落|滑落|脱手|被.{0,12}(?:抢走|夺走|偷走|卷走))|(?:抢走|夺走|偷走|卷走).{0,20}手机/.test(sentence)));
  const resultingHeld = lostNow ? false : held;
  const check = (field: string, text: string) => {
    if (hasContradictoryPhonePosture(text, resultingHeld, ownerName)) throw new Error(`WORLD_PHONE_POSTURE: ${field}与手机持有状态矛盾。phoneHeld=${resultingHeld}${lostNow ? "（本轮物理原因已使手机不可达）" : "（程序执行事实）"}；删除旧拿放位置的复述，不代写新的拿放或注意变化。本草稿尚未保存。`);
  };
  if (input.phoneState?.location && input.phoneState.reachable && held === true &&
    /(?:砧板|桌(?:上|边|面)|台面|床(?:上|边|头)|柜(?:上|里)|口袋|背包)/.test(input.phoneState.location) &&
    !/(?:手里|手中|掌心|指间)/.test(input.phoneState.location)) check("phoneState.location", `手机放在${input.phoneState.location}`);
  // Established historical sentences may be retained verbatim in the archive.
  // They must not become a new perception, physical update or current event.
  if (input.worldState !== undefined) for (const sentence of sentences(input.worldState)) if (!previousWorld.includes(sentence)) check("worldState", sentence);
  for (const actor of [...input.actorStates ?? [], ...input.actorEffects ?? []]) if (actor.actorId === "bot") check(`actorState[${actor.actorId}]`, actor.state);
  for (const change of input.externalChanges ?? []) check("externalChanges", change.description);
  for (const perception of input.perceptions) if (perception.actorId === "bot") {
    check("perceptions[bot]", perception.text);
    if (perception.situation) check("perceptions[bot].situation", perception.situation);
  }
}

/** Conservative authority guard, not a general semantic judge. An explicit actor
 * choosing/continuing a voluntary action is not a heartbeat's external cause. */
export function assertEvolutionActorAuthority(input: PhysicalProposal, actors: NarrativeActor[], previousWorld: string): void {
  // Waking/sleeping and blinking are bodily outcomes, not reliable evidence of a
  // voluntary choice: external shaking, thunder or smoke can cause them.
  const voluntary = "(?:决定|打算|选择|开始(?:寻找|探索|检查|翻找|做饭|做菜|入睡)|(?:继续|保持着?|维持着?|仍然?|依旧|还在|正在)(?:弯腰|低头|俯身|蹲着)?(?:寻找|搜索|探索|检查|翻找|做饭|做菜|查看|等待|睡觉)|走向|走到|前往|拿起|放下|转移注意)";
  const subjects = ["你", ...actors.map(actor => actor.name)].filter(Boolean).map(escape).join("|");
  // Only a direct subject assertion is strong enough: “邻居阻止你继续找” and
  // “不是你选择离开” are not assertions that the actor chose or acted.
  const unauthorized = new RegExp(`^\\s*(?:${subjects})(?:现在|此刻|于是|便|又|正|仍|还|已经|已)?${voluntary}`);
  const check = (field: string, text: string) => {
    if (factualSentences(text).flatMap(parts).some(part => unauthorized.test(part))) throw new Error(`EVOLUTION_ACTOR_AUTHORITY: ${field}替受控角色决定或延续主动行动。本轮只能发展NPC、环境及其客观影响；旧动作、已取消动作和旧感知都不授权续写。删除代行动子句，不把它改名为外部原因。`);
  };
  for (const change of input.externalChanges ?? []) check("externalChanges", change.description);
  for (const effect of input.actorEffects ?? []) check(`actorEffects[${effect.actorId}]`, effect.state);
  for (const perception of input.perceptions) {
    check(`perceptions[${perception.actorId}]`, perception.text);
    if (perception.situation) check(`perceptions[${perception.actorId}].situation`, perception.situation);
  }
  if (input.worldState !== undefined) for (const sentence of sentences(input.worldState)) if (!previousWorld.includes(sentence)) check("worldState", sentence);
}

/** An explicitly unchanged background is not an event source. Mixed descriptions
 * with a real new occurrence are left to the World, as are recurring wind/rain. */
export function assertEvolutionHasChange(changes: { description: string }[]): void {
  for (const change of changes) {
    const clauses = parts(change.description).filter(part => /[\p{L}\p{N}]/u.test(part));
    if (clauses.length && clauses.every(part => /(?:(?:仍然?|依旧|依然)(?:很|十分|一片|那么|这么)?(?:昏暗|漆黑|黑暗|安静|宁静|寂静|平静|沉寂)|没有变化|未发生变化|保持原状|毫无变化|未改变|(?:时间|时光).{0,8}(?:过去|流逝)|过去了.{0,12}(?:秒|分钟|小时))[。；;，,！？!?\s]*$/.test(part) &&
      !/(?:开始|突然|变得|渐渐|逐渐|更|越来越|传来|响起|落下|吹过|路过|到来|出现)/.test(part))) {
      throw new Error("EVOLUTION_NO_CHANGE: externalChanges只复述未变化的背景，没有本轮新经过。安静时返回perceptions:[]，省略状态和externalChanges；不能为重述旧处境投递新感知。");
    }
  }
}
