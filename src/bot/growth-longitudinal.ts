import type { PerceivedEvidence } from "./growth.js";

function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "").trim(); }

/** Obvious scenery in a free-form action is context, not a shared choice. This
 * small guard does not attempt to infer an action's meaning or group paraphrases. */
function ambientClause(value: string): boolean {
  const text = value.replace(/[。.!！？?]+$/u, "");
  return /^(?:屋里|房间里|室内|宿舍里|四周|周围)(?:依旧|仍然|还是|一片|格外|异常|十分|非常|很)*(?:安静|寂静|静悄悄|静)$/u.test(text)
    || /^(?:只有|只剩下?|仅有)(?:机箱|电脑)?风扇(?:的)?(?:低鸣|嗡鸣|嗡嗡声|声音|转动声)$/u.test(text)
    || /^(?:屏幕|手机屏幕|电脑屏幕)(?:的)?光(?:线|亮)?(?:映|照|落|打)在[^，,。；;\n]{1,20}$/u.test(text)
    || /^(?:窗外|远处)[^，,。；;\n]{0,40}(?:传来|响起)[^，,。；;\n]{0,40}(?:声音|声|低鸣|鸣声)$/u.test(text);
}

/** Literal action clauses are retrieval anchors, not inferred habits. A shared
 * person, object or time alone does not qualify an unrelated action. */
function clauses(action: string): string[] {
  const body = action.replace(/^动作[「“"]([\s\S]*)[」”"]$/, "$1");
  const parts = body.split(/[，,。；;\n]/u).map(normalize)
    .filter(value => value.length >= 2 && !ambientClause(value) && !/^(?:现在|然后|接着|之后|这时|自己|手机|电脑|屏幕|完成|成功|操作)$/.test(value));
  // Keep the complete action when it also contains an actual action clause;
  // exclude an all-scenery body instead of reintroducing it as a whole anchor.
  return parts.length ? [...new Set([normalize(body), ...parts])] : [];
}

function sameScope(left: PerceivedEvidence, right: PerceivedEvidence): boolean {
  const a = left.experience, b = right.experience;
  if (!a || !b) return false;
  if (a.chat?.channelKey !== b.chat?.channelKey) return false;
  const leftIds = a.subjectIds ?? [], rightIds = b.subjectIds ?? [];
  return !leftIds.length && !rightIds.length || !!leftIds.length && !!rightIds.length && leftIds.some(id => rightIds.includes(id));
}

/** Use the ledger's agency, completion, episode and shared-root checks after
 * matching each behavior. Keep a bounded longitudinal sample of the SAME action,
 * including early evidence that an unbounded recent streak would otherwise hide. */
export function selectLongitudinalEvidence(options: {
  fresh: readonly PerceivedEvidence[];
  historical: readonly PerceivedEvidence[];
  behaviors?: readonly string[];
  secondsPerTU?: number;
  budget: number;
  independentChoices: (items: PerceivedEvidence[]) => PerceivedEvidence[];
}): PerceivedEvidence[] {
  const unit = Number.isFinite(options.secondsPerTU) && options.secondsPerTU! > 0 ? options.secondsPerTU! : 1;
  const behaviors = (options.behaviors ?? []).map(normalize).filter(value => !ambientClause(value));
  const budget = Math.max(0, Math.floor(options.budget));
  const groups = options.fresh.flatMap(anchor => {
    const action = normalize(anchor.experience?.action ?? "");
    const anchors = [...new Set([...clauses(anchor.experience?.action ?? ""), ...behaviors.filter(behavior => behavior.length >= 2 && action.includes(behavior))])];
    return anchors.map(behavior => {
      const matches = (item: PerceivedEvidence) => sameScope(anchor, item) && normalize(item.experience?.action ?? "").includes(behavior);
      const current = options.independentChoices(options.fresh.filter(matches));
      const currentIds = new Set(current.map(item => item.eventId));
      // Filter the behavior before choosing one representative per episode. A
      // conversation can contain several actual actions; its highest-scoring
      // unrelated action must not hide the old practice we are looking for.
      const all = options.independentChoices([...current, ...options.historical.filter(matches)]);
      const past = all.filter(item => !currentIds.has(item.eventId));
      const span = all.length ? (Math.max(...all.map(item => item.observedAt)) - Math.min(...all.map(item => item.observedAt))) * unit : 0;
      const target = all.length >= 6 && span >= 7 * 86400 ? 6 : all.length >= 3 && span >= 86400 ? 3 : 0;
      return { anchor, current, past, target, span };
    });
  }).filter(group => group.past.length)
    .sort((a, b) => b.target - a.target || b.span - a.span || b.anchor.observedAt - a.anchor.observedAt);
  const selected = new Map<string, PerceivedEvidence>();
  for (const group of groups) {
    if (selected.size >= budget) break;
    const represented = [...group.current, ...group.past.filter(item => selected.has(item.eventId))];
    const available = options.independentChoices([...options.fresh, ...selected.values(), ...group.past]);
    const availableIds = new Set(available.map(item => item.eventId));
    const remaining = group.past.filter(item => availableIds.has(item.eventId) && !selected.has(item.eventId));
    // One older example still helps revisions when a behavior has not yet met
    // an admission threshold. Never force a habit to exist from sample counts.
    const wanted = group.target ? Math.max(0, group.target - represented.length) : 1;
    for (let i = 0; i < wanted && remaining.length && selected.size < budget; i++) {
      const days = new Set(represented.map(item => Math.floor(item.observedAt * unit / 86400)));
      const situations = new Set(represented.map(item => normalize(item.experience?.situation ?? "")));
      const representedSpan = (Math.max(...represented.map(item => item.observedAt)) - Math.min(...represented.map(item => item.observedAt))) * unit;
      remaining.sort((a, b) => {
        if (group.target === 6 && representedSpan >= 7 * 86400 && situations.size < 3) {
          const situationNovelty = Number(!situations.has(normalize(b.experience?.situation ?? ""))) - Number(!situations.has(normalize(a.experience?.situation ?? "")));
          if (situationNovelty) return situationNovelty;
        }
        const dayNovelty = Number(!days.has(Math.floor(b.observedAt * unit / 86400))) - Number(!days.has(Math.floor(a.observedAt * unit / 86400)));
        if (dayNovelty) return dayNovelty;
        const distance = (item: PerceivedEvidence) => Math.min(...represented.map(other => Math.abs(item.observedAt - other.observedAt))) * unit;
        const gap = distance(b) - distance(a);
        if (gap) return gap;
        return Number(!situations.has(normalize(b.experience?.situation ?? ""))) - Number(!situations.has(normalize(a.experience?.situation ?? "")))
          || a.observedAt - b.observedAt || a.eventId.localeCompare(b.eventId);
      });
      const next = remaining.shift()!;
      selected.set(next.eventId, next); represented.push(next);
    }
  }
  return [...selected.values()];
}
