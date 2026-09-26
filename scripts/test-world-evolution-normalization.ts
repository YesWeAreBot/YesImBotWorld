/** Pure protocol checks only: no live world, network or model requests. */
import assert from "node:assert/strict";
import { normalizeWorldEvolution, type WorldEvolutionInput } from "../src/world/evolution.js";
import { projectWorldDeviceContext } from "../src/world/device-boundary.js";
import { projectCurrentTime } from "../src/world/time-boundary.js";
import { validNarrativeEvolution } from "../src/world/narrative-types.js";

const current = "院子里有风。", cause = { id: "gust", description: "又一阵风拂过院子。" };
const context = { storedWorldState: current, projectedWorldState: current };
const phoneState = { reachable: true, location: "长椅上", usable: true, perceptible: true };
const perception = { actorId: "bot", changeIds: ["gust"] };
const effect = { actorId: "bot", changeIds: ["gust"], state: "坐在长椅上，衣摆被风吹起。" };

for (const storedWorldState of [current, "院子里有风。\n\n\n树下有张长椅。", "院子里有风。\n\n手机收到一条新消息：你好。", "当前日期：2020-01-01。\n\n院子里有风。"] ) {
  const projectedWorldState = projectCurrentTime(projectWorldDeviceContext(storedWorldState), { date: "2026-09-26" } as any);
  const ctx = { storedWorldState, projectedWorldState };
  for (const worldState of [undefined, storedWorldState, projectedWorldState]) {
    const input = { ...(worldState === undefined ? {} : { worldState }), externalChanges: [], actorEffects: [], perceptions: [] };
    const before = structuredClone(input);
    assert.deepEqual(normalizeWorldEvolution(input, ctx), { quiet: true }, "quiet projection must preserve archive without creating a transaction");
    assert.deepEqual(input, before, "normalization must not mutate model output");
  }
  for (const worldState of [undefined, storedWorldState, projectedWorldState]) {
    const result = normalizeWorldEvolution({ ...(worldState === undefined ? {} : { worldState }), externalChanges: [cause], perceptions: [perception] }, ctx);
    assert.equal(result.quiet, false);
    assert.equal(result.worldState, storedWorldState, "event-only update must not rewrite raw state with read-time projection");
    assert.equal(validNarrativeEvolution(result.evolution!), true);
    assert.deepEqual(result.evolution!.perceptionSources, [perception]);
  }
}
console.log("PASS quiet raw/projected state, blank-line/device/date projection, and same-state/omitted-state events");

const changed = current + "窗帘被风吹离窗沿。";
const input: WorldEvolutionInput = { worldState: changed, externalChanges: [cause], actorEffects: [effect], perceptions: [perception], phoneState, phoneChangeIds: ["gust"] };
const normalized = normalizeWorldEvolution(input, context);
assert.equal(normalized.quiet, false); assert.equal(normalized.worldState, changed);
assert.deepEqual(normalized.evolution, { changes: [cause], actorEffects: [{ actorId: "bot", changeIds: ["gust"] }], perceptionSources: [perception], phoneChangeIds: ["gust"] });
assert.equal(validNarrativeEvolution(normalized.evolution!), true);
normalized.evolution!.changes[0]!.description = "改动返回对象";
normalized.evolution!.perceptionSources[0]!.changeIds.push("caller-edit");
assert.equal(cause.description, "又一阵风拂过院子。"); assert.deepEqual(perception.changeIds, ["gust"]);
const remote = normalizeWorldEvolution({ externalChanges: [cause], perceptions: [] }, context);
assert.equal(remote.quiet, false); assert.deepEqual(remote.evolution!.perceptionSources, []);
console.log("PASS actual change, causal bodily/phone effects, remote event-only commit and independent source records");

function rejected(input: unknown, code: string, field: string): void {
  assert.throws(() => normalizeWorldEvolution(input as WorldEvolutionInput, context), (error: unknown) => {
    assert.ok(error instanceof Error); assert.ok(error.message.startsWith(code + ":"), error.message);
    assert.ok(error.message.includes(field), error.message); return true;
  });
}
rejected({ perceptions: [], worldState: "院子开始下雨。" }, "EVOLUTION_CHANGES_REQUIRED", "externalChanges");
rejected({ perceptions: [], worldState: "院子里有风，暂时没有别的变化。" }, "EVOLUTION_CHANGES_REQUIRED", "externalChanges");
rejected({ perceptions: [], worldState: "" }, "EVOLUTION_WORLD_STATE", "worldState");
rejected({ perceptions: [], externalChanges: null }, "EVOLUTION_CHANGES", "externalChanges");
rejected({ perceptions: [], actorEffects: null }, "EVOLUTION_SOURCES", "actorEffects");
rejected({ perceptions: null }, "EVOLUTION_SOURCES", "perceptions");
rejected({ perceptions: [], externalChanges: [cause, cause] }, "EVOLUTION_DUPLICATE_CHANGE", "externalChanges[1].id");
rejected({ perceptions: [], externalChanges: [{ id: " ", description: "风" }] }, "EVOLUTION_CHANGE_ID", "externalChanges[0].id");
rejected({ perceptions: [], externalChanges: [{ id: "gust", description: " " }] }, "EVOLUTION_CHANGE_DESCRIPTION", "externalChanges[0].description");

for (const field of ["perceptions", "actorEffects"] as const) {
  const source = field === "perceptions" ? { ...perception } : { ...effect };
  for (const [changeIds, code] of [[undefined, "MISSING"], [[], "EMPTY"], [["gust", "gust"], "DUPLICATE"], [["old-event"], "UNKNOWN"], [[42], "INVALID"], ["gust", "INVALID"]] as const) {
    rejected({ perceptions: [], externalChanges: [cause], [field]: [{ ...source, changeIds }] }, `EVOLUTION_REFERENCE_${code}`, `${field}[0].changeIds`);
  }
  rejected({ perceptions: [], externalChanges: [cause], [field]: [source, source] }, "EVOLUTION_DUPLICATE_ACTOR", `${field}[1].actorId`);
  rejected({ perceptions: [], externalChanges: [cause], [field]: [{ ...source, actorId: "" }] }, "EVOLUTION_ACTOR_ID", `${field}[0].actorId`);
  rejected({ perceptions: [], [field]: [source] }, "EVOLUTION_REFERENCE_UNKNOWN", `${field}[0].changeIds[0]`);
}
rejected({ perceptions: [], phoneState }, "EVOLUTION_PHONE_SOURCE_MISSING", "phoneChangeIds");
rejected({ perceptions: [], externalChanges: [cause], phoneChangeIds: ["gust"] }, "EVOLUTION_PHONE_STATE_MISSING", "phoneState");
for (const [phoneChangeIds, code] of [[[], "EMPTY"], [["gust", "gust"], "DUPLICATE"], [["old-event"], "UNKNOWN"], [[42], "INVALID"], ["gust", "INVALID"]] as const) {
  rejected({ perceptions: [], externalChanges: [cause], phoneState, phoneChangeIds }, `EVOLUTION_REFERENCE_${code}`, "phoneChangeIds");
}
assert.deepEqual(normalizeWorldEvolution({ perceptions: [] }, context), { quiet: true });
console.log("PASS precise missing/empty/duplicate/unknown references, duplicate actors/causes, phone pairing and state-only rejection");
