/** Stable task prompts and provider schemas, without a model or running world. */
import assert from "node:assert/strict";
import { Prompts, WORLD_PROMPT_DEFAULTS } from "../src/prompts.js";
import { buildWorldTaskPrompt, type WorldTaskKind, type WorldTaskPromptInput } from "../src/world/prompt.js";
import { WORLD_EVOLUTION_AUTHORITY, WORLD_INCREMENTAL_AUTHORITY, worldResolutionTool } from "../src/world/proposal.js";
import { WORLD_TIME_AUTHORITY } from "../src/world/time-boundary.js";
import { assertConsciousnessAuthority, validNarrativeConsciousness } from "../src/world/consciousness.js";

const input: WorldTaskPromptInput = {
  narrativeSystem: WORLD_PROMPT_DEFAULTS.narrativeSystem,
  worldDef: "  小镇仍在修复旧钟楼。\n未知的世界秘密不能直接交给角色。  ",
  botDef: "旅人习惯仔细听完对方的话。\n保留这行作者原文。",
  kind: "action", actionPhase: "start", allowWorldPatch: true, allowPhoneState: false,
};
const prompt = (overrides: Partial<WorldTaskPromptInput> = {}) => buildWorldTaskPrompt({ ...input, ...overrides });
const contract = (overrides: Partial<WorldTaskPromptInput> = {}) => worldResolutionTool(false, false, { ...input, ...overrides });
const taskText = (value: string) => value.split("<world_task_contract>\n")[1]!;
const prefix = (value: string) => value.split("<world_task_contract>\n")[0]!;

function stablePrefixAndCustomization() {
  const normal = prompt();
  assert.equal(normal, prompt(), "repeated construction does not randomize or inject a timestamp");
  for (const kind of ["initialize", "action", "observe", "evolve", "arrive", "leave", "app_observe", "app_action"] as WorldTaskKind[]) {
    const text = prompt({ kind });
    assert.equal(prefix(text), prefix(normal), `${kind} retains the same owner definitions and shared prefix`);
    assert.ok(text.includes(input.worldDef)); assert.ok(text.includes(input.botDef));
    assert.ok(text.includes(WORLD_TIME_AUTHORITY), "customizable prose never replaces program time authority");
    assert.match(text, /actorId|投递/);
  }
  const custom = "自定义文风：只用简练古文。\n保留我关于NPC称谓的特殊规则。\n旧版 app_action 说明也是用户自己保留的文字。";
  const prompts = new Prompts({ bot: {}, world: { narrativeSystem: custom } });
  const text = prompt({ narrativeSystem: prompts.world.narrativeSystem });
  assert.equal(text.split(custom).length - 1, 1, "user-authored overrides are preserved verbatim exactly once");
  assert.equal(prompts.get().world.narrativeSystem, custom, "rendering never rewrites saved overrides");
  assert.match(taskText(text), /真人聊天由实际平台独占/);
  assert.match(text, /本次输出契约/);
  assert.doesNotMatch(text, /只调用一次resolve_world/);
  assert.match(prompt({ responseFormat: "tool" }), /只调用一次resolve_world/);
  assert.ok(text.includes(WORLD_TIME_AUTHORITY));
  assert.doesNotMatch(prefix(normal), /app_observe|app_action|kind=evolve|botName|speechSpoken|repair/);
}

function actualTaskIsolation() {
  const normal = prompt(), declared = JSON.stringify(contract());
  for (const text of [normal, declared]) {
    assert.doesNotMatch(text, /app_observe|app_action|kind=evolve|externalChanges|actorEffects|botName|repair/,
      "a normal physical action does not carry unrelated task contracts");
  }
  assert.ok(normal.includes(WORLD_INCREMENTAL_AUTHORITY));
  assert.match(normal, /situation可省略/); assert.match(normal, /opportunities也可省略/);
  assert.match(normal, /actorStates只在.*无变化省略/);
  assert.match(normal, /不为凑选项制造事件/); assert.doesNotMatch(normal, /通常给2至4|通常2至4/);
  assert.match(normal, /原样保留/); assert.match(normal, /文件读写/); assert.match(normal, /屏幕亮暗\/锁定/);
  assert.match(normal, /手机闹钟/); assert.match(normal, /机械\/实体闹钟/);
  assert.match(normal, /stateAheadOfClock=true.*不能据此推到未来/);
  assert.match(normal, /recentEvolution.*不要重演/);
  assert.match(normal, /retainedDeviceRecords=true.*原样接回/);
  assert.match(normal, /phoneAuthority.stateKnown=false.*默认物理条件/);
  assert.match(normal, /phoneState和phoneHeld所属由phoneAuthority.actorId指定.*不能混用访客/);
  assert.match(normal, /phase=accepted只表示已受理.*phase=ongoing表示已有开始裁定.*不证明行动已经完成/);
  assert.match(normal, /以本次action.intent为结算单位/);
  assert.match(normal, /常规步骤可连贯推进.*不逐步索要许可/);
  assert.match(normal, /当前请求实际达成才completed.*更大目标未完/);
  assert.match(normal, /仅用力、准备、尝试或本轮生成结束不算达成/);
  assert.match(normal, /未实现用failed，正文、reason和状态一致/);
  assert.match(normal, /重复失败不自动加重疼痛、损伤或障碍/);
  assert.match(normal, /只有已确立的新物理原因才可恶化/);
  assert.match(normal, /result.text是当时交付结果的物理视图/);
  assert.match(normal, /omitted\/reasonOmitted仅表示正文省略，不证明没有阻碍/);
  assert.match(normal, /原意图未授权且会实质改变走向的选择才needs_input/);
  assert.match(normal, /旧感知是起点，不重演旧动作/);
  assert.match(normal, /角色提出睡觉是尝试入睡，不保证立刻睡着/);
  assert.match(normal, /清醒|困倦|睡眠/); assert.match(normal, /NPC行为与原话/);
  const schema: any = contract().function.parameters;
  assert.ok(!schema.required.includes("worldState")); assert.ok(!schema.required.includes("actorStates"));
  assert.deepEqual(schema.properties.perceptions.items.required, ["actorId", "text"], "even a single recipient keeps an explicit routing address");
  assert.ok(!schema.properties.perceptions.items.required.includes("situation"));
  assert.ok(!schema.properties.perceptions.items.required.includes("opportunities"));
  assert.doesNotMatch(JSON.stringify(schema), /speechSpoken/, "speech-free requests do not ask for a redundant flag");
  assert.match(schema.properties.outcome.properties.status.description, /当前请求实际达成才completed.*后续建议不影响完成/);

  const legacyProjection = prompt({ allowWorldPatch: false });
  assert.ok(!legacyProjection.includes(WORLD_INCREMENTAL_AUTHORITY));
  assert.match(legacyProjection, /没有worldDocument，不提交段落补丁/);
  assert.match(legacyProjection, /仅长期事实变化时返回完整更新/);
  assert.doesNotMatch(prompt(), /本次允许更新手机物理条件|phoneChangeIds/);
  assert.match(prompt({ allowPhoneState: true }), /本次允许更新手机物理条件/);

  const beginning = prompt({ speech: "start", allowOngoing: true });
  assert.match(beginning, /speechSpoken必须明确/); assert.match(beginning, /逐字保留/); assert.match(beginning, /expectedEnd.*ongoing/);
  const finishing = prompt({ actionPhase: "finish", speech: "finish" });
  assert.match(finishing, /已经开始的持续行动/); assert.match(finishing, /无需生成speechSpoken，程序固定为false/);
  assert.doesNotMatch(finishing, /speechSpoken必须明确|持续过程可ongoing/);
  assert.equal((contract({ actionPhase: "finish", speech: "finish" }).function.parameters as any).properties.outcome.properties.speechSpoken, undefined);

  const genesis = prompt({ kind: "initialize" });
  assert.match(genesis, /botName、完整worldState/); assert.ok(!genesis.includes(WORLD_INCREMENTAL_AUTHORITY));
  assert.doesNotMatch(genesis, /app_observe|app_action|kind=evolve|externalChanges/);
  const evolve = prompt({ kind: "evolve", allowPhoneState: true });
  assert.ok(evolve.includes(WORLD_EVOLUTION_AUTHORITY)); assert.match(evolve, /phoneState须与phoneChangeIds成对/);
  assert.doesNotMatch(evolve, /actorStates只在.*填写/); assert.match(evolve, /不能写actorStates或outcome/);
  assert.doesNotMatch(evolve, /app_observe|app_action|botName/);
  assert.match(prompt({ kind: "observe" }), /不替角色走动、开门、翻容器或完成pendingActions/);
  assert.match(prompt({ kind: "arrive" }), /已授权的到访/);
  assert.match(prompt({ kind: "leave" }), /没有观察者时perceptions可为空/);

  for (const kind of ["app_observe", "app_action"] as const) {
    const text = prompt({ kind });
    assert.match(text, /请求actorId的一份私有应用输出/); assert.match(text, /不表示角色已知/);
    assert.match(text, /真实聊天.*实际平台/);
    assert.ok(!text.includes(WORLD_INCREMENTAL_AUTHORITY)); assert.ok(!text.includes(WORLD_EVOLUTION_AUTHORITY));
    assert.doesNotMatch(taskText(text), /opportunities|actorEffects|externalChanges|phoneState|kind=evolve|botName/);
    assert.doesNotMatch(JSON.stringify(contract({ kind })), /worldPatch|opportunities|situation|speechSpoken/);
  }
  assert.match(prompt({ kind: "app_observe" }), /只读已确立记录/);
  assert.match(prompt({ kind: "app_action" }), /完整worldState.*明确outcome/);
  // Regression budget: without user definitions, normal tasks must stay materially
  // below the previous >6k-character all-task system prompt and repeated authorities.
  assert.ok(prompt({ worldDef: "", botDef: "" }).length < 3600, "normal task prompt remains concise, including action progress semantics");
  assert.ok(declared.length < 7200, "ordinary provider schema does not reintroduce the full all-task prose");
}

function explicitConsciousness() {
  assert.equal(validNarrativeConsciousness(undefined), false, "legacy absence is not a fabricated awake value");
  for (const value of ["awake", "asleep", "unconscious"]) assert.ok(validNarrativeConsciousness(value));
  for (const value of ["tired", "rest", "睡着", null, false]) assert.equal(validNarrativeConsciousness(value), false);
  for (const kind of ["initialize", "action"] as const) {
    const schema = contract({ kind }).function.parameters as any;
    const item = schema.properties.actorStates.items;
    assert.deepEqual(item.properties.consciousness.enum, ["awake", "asleep", "unconscious"]);
    assert.ok(!item.required.includes("consciousness"), "ordinary physical updates do not require a guessed consciousness");
    assert.doesNotThrow(() => assertConsciousnessAuthority({ actorStates: [{ actorId: "bot", consciousness: "asleep" }] }, kind));
  }
  for (const kind of ["observe", "arrive", "leave", "app_action", "app_observe"]) {
    const schema = contract({ kind: kind as WorldTaskKind }).function.parameters as any;
    assert.equal(schema.properties.actorStates?.items.properties.consciousness, undefined);
    assert.throws(() => assertConsciousnessAuthority({ actorStates: [{ actorId: "bot", consciousness: "awake" }] }, kind), /WORLD_CONSCIOUSNESS_AUTHORITY/);
    assert.doesNotThrow(() => assertConsciousnessAuthority({ actorStates: [{ actorId: "bot" }] }, kind), "read-only prose does not infer a state change");
  }
  const effect = { actorId: "bot", consciousness: "awake", changeIds: ["actual-cause"] };
  assert.doesNotThrow(() => assertConsciousnessAuthority({ actorEffects: [effect] }, "evolve"));
  assert.throws(() => assertConsciousnessAuthority({ actorEffects: [{ ...effect, changeIds: [] }] }, "evolve"), /WORLD_CONSCIOUSNESS_AUTHORITY/);
  assert.throws(() => assertConsciousnessAuthority({ actorEffects: [effect] }, "observe"), /WORLD_CONSCIOUSNESS_AUTHORITY/);
  assert.throws(() => assertConsciousnessAuthority({ actorStates: [{ actorId: "bot", consciousness: "rest" }] }, "action"), /WORLD_CONSCIOUSNESS_VALUE/);
  assert.throws(() => assertConsciousnessAuthority({ actorStates: [{ actorId: "bot", consciousness: "awake" }] }, "evolve"), /WORLD_CONSCIOUSNESS_AUTHORITY/);
  const evolve = prompt({ kind: "evolve" });
  assert.match(evolve, /已明确consciousness=asleep.*不属于待结算行动.*真实经过自然结束/);
  assert.match(evolve, /unconscious的恢复须有已确立的恢复条件或真实外因/);
  assert.match(evolve, /躺下、rest、深夜或字段缺失不证明睡着/);
  assert.match(prompt({ allowOngoing: true }), /真实入睡可开始持续睡眠.*到期后另行结算实际结果及苏醒/);
  assert.match(prompt({ actionPhase: "finish" }), /睡眠过程结束时裁定实际苏醒/);
}

stablePrefixAndCustomization(); actualTaskIsolation(); explicitConsciousness();
console.log("PASS task World prompts: stable prefix, verbatim custom overrides, isolated task contracts, optional narrative extras, concise schemas and program-owned finish speech flag");
