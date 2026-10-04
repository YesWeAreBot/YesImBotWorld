/** Physical phone constraints come only from durable World proposals, never prose guesses or platform IO. */
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { worldResolutionTool } from "../src/world/proposal.js";
import { applyPhonePhysicalState, canPerceivePhone, canReachPhone, canUsePhone, phonePhysicalState, phonePhysicalSummary, phoneUnavailableReason, validPhonePhysicalState } from "../src/phone-state.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { PhonePhysicalState, PhoneStatus } from "../src/types.js";

const lost: PhonePhysicalState = { reachable: false, location: null, usable: true, perceptible: false };
const distant: PhonePhysicalState = { reachable: false, location: "房间另一端的桌上", usable: true, perceptible: true };
const broken: PhonePhysicalState = { reachable: true, location: "角色面前", usable: false, perceptible: true };
const restored: PhonePhysicalState = { reachable: true, location: "角色面前", usable: true, perceptible: true };
const result = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "physical-state-proposal", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });

async function main() {
  const phone: PhoneStatus = { down: false };
  assert.deepEqual(phonePhysicalState(phone), { reachable: true, location: null, usable: true, perceptible: true });
  assert.deepEqual(phone, { down: false }, "reading a legacy default must not mutate persisted/runtime state");
  assert.ok(canUsePhone(phone) && canReachPhone(phone) && canPerceivePhone(phone));
  assert.match(phonePhysicalSummary(phone), /位置：未记录/);
  assert.doesNotMatch(phonePhysicalSummary(phone), /桌上|枕边|口袋/);
  assert.ok(applyPhonePhysicalState(phone, lost));
  assert.equal(phone.down, true, "a lost phone cannot remain held merely because the old down flag was false");
  assert.ok(!canReachPhone(phone) && !canUsePhone(phone) && !canPerceivePhone(phone));
  assert.ok(!applyPhonePhysicalState(phone, lost), "reapplying a committed physical state is idempotent");
  applyPhonePhysicalState(phone, distant);
  assert.ok(canPerceivePhone(phone) && !canReachPhone(phone), "an out-of-reach device may still produce audible genuine cues");
  assert.ok(!phoneUnavailableReason(phone)?.includes(distant.location!), "an execution failure cannot reveal hidden world coordinates");
  applyPhonePhysicalState(phone, broken);
  assert.ok(canReachPhone(phone) && !canUsePhone(phone) && !canPerceivePhone(phone));
  phone.down = false;
  assert.ok(!canUsePhone(phone), "holding a damaged phone does not restore its software capabilities");
  phone.down = true;
  applyPhonePhysicalState(phone, restored);
  assert.equal(phone.down, true, "restoring physical availability cannot automatically pick the phone up");
  phone.down = false; assert.ok(canUsePhone(phone));
  for (const invalid of [{ reachable: true }, { ...restored, reachable: "true" }, { ...restored, location: "" }, { ...restored, location: "远".repeat(301) }, { ...restored, notification: "你好" }, { ...restored, held: true }]) {
    assert.ok(!validPhonePhysicalState(invalid));
    assert.throws(() => applyPhonePhysicalState(phone, invalid as PhonePhysicalState), /完整指定/);
  }
  const schema = worldResolutionTool().function.parameters as any;
  assert.equal(schema.properties.phoneState.additionalProperties, false);
  assert.deepEqual(schema.properties.phoneState.required, ["reachable", "location", "usable", "perceptible"]);
  assert.match(schema.properties.phoneState.description, /无变化省略/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-phone-physical-"));
  let runtime: NarrativeWorld | undefined;
  try {
    const files = new WorldFiles(dir); await files.ensure(); await files.writeMeta({ realWorld: false });
    let now = 10;
    let output: any = { botName: "小澈", worldState: "小澈在书房里，窗边有一张桌子。", actorStates: [{ actorId: "bot", state: "站在书房中央。" }], perceptions: [{ actorId: "bot", text: "窗外透进明亮的阳光。" }] };
    const inputs: any[] = [];
    let duringInference: (() => void) | undefined;
    runtime = new NarrativeWorld(files, { now: () => now, realMsUntil: () => 0, syncRealTime: false } as any, async (messages: ChatMessage[]) => {
      const initialRequest = messages.find(message => message.role === "user");
      inputs.push(JSON.parse(String(initialRequest!.content)));
      duringInference?.();
      return result(output);
    });
    const sharedPhone: PhoneStatus = { down: false };
    runtime.phoneStatusProvider = () => sharedPhone;
    await runtime.ensure();
    const store = await runtime.store();
    assert.equal(store.snapshot().phoneState, undefined, "legacy/omitted physical fields stay absent on disk");
    const legacyJournal = await fs.readFile(files.narrativeJournal, "utf8");
    applyPhonePhysicalState(sharedPhone, store.snapshot().phoneState);
    const reopenedLegacy = await NarrativeStore.open(dir, { now: () => now });
    assert.equal(reopenedLegacy.snapshot().phoneState, undefined);
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), legacyJournal, "reading old worlds never rewrites their physical history");
    assert.deepEqual(inputs[0].phoneState, { ...phonePhysicalState(sharedPhone), location: "持有者手中" }, "the request projects the confirmed held posture over the unknown archival location");
    assert.deepEqual(sharedPhone, { down: false }, "input projection does not establish a physical record or mutate runtime phone fields");
    assert.equal(store.snapshot().phoneState, undefined);
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), legacyJournal, "projecting a held phone leaves the journal unchanged");
    assert.equal(inputs[0].phoneHeld, true);
    assert.equal(inputs[0].phoneAuthority.canUpdate, true);

    const changes: PhonePhysicalState[] = [];
    const unsubscribe = store.subscribe(envelope => {
      if (envelope.topic !== "world.committed" || !(envelope.payload as any).phoneStateChanged) return;
      const state = store.snapshot().phoneState!;
      const committed = JSON.parse(readFileSync(files.narrativeJournal, "utf8").trim().split("\n").at(-1)!);
      assert.deepEqual(committed.commit.phoneState, state, "physical gating changes are published only after the entire durable transaction exists");
      applyPhonePhysicalState(sharedPhone, state); changes.push(state);
    });
    output = { phoneState: lost, phoneChangeIds: ["loss"], externalChanges: [{ id: "loss", description: "货架被风吹倒，撞到小澈的手，手机脱手坠入缝隙，去向未知。" }], worldState: "小澈仍站在书房中央。货架被风吹倒，撞到小澈的手，手机脱手坠入缝隙，去向未知。", perceptions: [{ actorId: "bot", text: "货架倒下撞到你的手，手机滑落后不见了。", changeIds: ["loss"] }] };
    duringInference = () => assert.ok(canUsePhone(sharedPhone), "an uncommitted model proposal cannot remove phone access");
    now++;
    await runtime.evolve("结算当前物理处境");
    duringInference = undefined;
    assert.deepEqual(store.snapshot().phoneState, lost);
    assert.deepEqual(changes, [lost]);
    assert.ok(!canReachPhone(sharedPhone) && !canUsePhone(sharedPhone) && !canPerceivePhone(sharedPhone));
    assert.equal(store.snapshot().stateUpdatedAt, now, "a physical phone change is a real world-state change");
    const beforeRejected = store.snapshot(), journalBeforeRejected = await fs.readFile(files.narrativeJournal, "utf8");
    await assert.rejects(store.commit({ idempotencyKey: "cancelled-phone-repair", source: "evolve", phoneState: restored, worldState: beforeRejected.worldState + "店员修好并交还手机。",
      evolution: { changes: [{ id: "repair", description: "店员修好并交还手机。" }], actorEffects: [], perceptionSources: [], phoneChangeIds: ["repair"] } }, { beforeCommit: () => false }), /取消/);
    assert.deepEqual(store.snapshot(), beforeRejected);
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), journalBeforeRejected);
    assert.equal(changes.length, 1);

    output = { perceptions: [] };
    await runtime.evolve("继续观察眼前环境");
    assert.deepEqual(store.snapshot().phoneState, lost, "ordinary prose and omitted fields neither guess recovery nor reset constraints");
    assert.equal(inputs.at(-1).phoneHeld, false);
    assert.deepEqual(inputs.at(-1).phoneState, lost);
    output = { phoneState: { ...restored, location: "手机收到一条新消息：你好" }, perceptions: [{ actorId: "bot", text: "房间依然安静。" }] };
    const beforeFabrication = store.snapshot();
    await assert.rejects(runtime.evolve("物理环境继续演化"), /WORLD_DEVICE_BOUNDARY/);
    assert.deepEqual(store.snapshot(), beforeFabrication, "physical metadata cannot smuggle fabricated platform messages into the durable world");

    runtime.phoneAuthorityProvider = () => false;
    output = { phoneState: restored, phoneChangeIds: ["return"], worldState: "小澈仍站在书房中央。店员把找回的手机放在小澈面前。", externalChanges: [{ id: "return", description: "店员把找回的手机放在小澈面前。" }], perceptions: [{ actorId: "bot", text: "店员把找回的手机放在你面前。", changeIds: ["return"] }] };
    await assert.rejects(runtime.evolve("常驻角色正在异世界，留在原世界的环境继续演化"), /PHONE_PHYSICAL_AUTHORITY/);
    assert.equal(inputs.at(-1).phoneAuthority.canUpdate, false);
    assert.deepEqual(store.snapshot().phoneState, lost);
    runtime.phoneAuthorityProvider = () => true;
    duringInference = () => { runtime!.phoneAuthorityProvider = () => false; };
    await assert.rejects(runtime.evolve("读取处境后角色开始旅行"), /取消/);
    assert.deepEqual(store.snapshot().phoneState, lost, "travel invalidates an in-flight physical proposal before its durable commit");
    duringInference = undefined;
    runtime.phoneAuthorityProvider = () => true;

    output = { phoneState: restored, actorStates: [{ actorId: "visitor:guest", state: "来到门边。" }], perceptions: [{ actorId: "visitor:guest", text: "你站在书房门口。" }] };
    await assert.rejects(runtime.arrive("visitor:guest", "访客", "普通访客"), /PHONE_PHYSICAL_AUTHORITY/);
    assert.equal(store.snapshot().actors["visitor:guest"], undefined, "an invalid visitor proposal does not partially establish identities or phone state");
    output = { phoneState: restored, perceptions: [{ actorId: "bot", text: "天气晴朗。" }] };
    await assert.rejects(runtime.observeVirtualApp("bot", "读取天气预报"), /PHONE_PHYSICAL_AUTHORITY/);
    for (const source of ["app_action", "app_observe", "arrive", "migration"]) {
      await assert.rejects(async () => store.commit({ idempotencyKey: `forbidden:${source}`, source, phoneState: restored }), /手机物理状态/);
    }
    await assert.rejects(async () => store.commit({ idempotencyKey: "forbidden:visitor", source: "action", actorId: "visitor:guest", phoneState: restored }), /手机物理状态/);

    output = { phoneState: broken, phoneChangeIds: ["found"], worldState: "小澈仍站在书房中央。店员找到受损的手机，放到小澈面前。", externalChanges: [{ id: "found", description: "店员找到受损的手机，放到小澈面前。" }], perceptions: [{ actorId: "bot", text: "店员把找到的手机放到你面前，机身有明显损伤。", changeIds: ["found"] }] };
    now++;
    await runtime.evolve("店员交还刚找到的物品");
    assert.ok(canReachPhone(sharedPhone) && !canUsePhone(sharedPhone));
    assert.deepEqual(store.snapshot().phoneState, broken);
    const beforePhoneOnly = store.snapshot();
    output = { phoneState: restored, phoneChangeIds: ["repair"], worldState: "小澈仍站在书房中央。店员修好手机并放回小澈面前。", externalChanges: [{ id: "repair", description: "店员完成此前已经开始的物理维修，把手机放回小澈面前。" }], perceptions: [] };
    now++;
    await runtime.evolve("店员完成已经开始的物理维修");
    assert.deepEqual(store.snapshot().phoneState, restored, "an external physical effect is saved even when no actor notices it");
    assert.equal(store.snapshot().stateSequence, beforePhoneOnly.sequence + 1);
    assert.equal(sharedPhone.down, true, "world repair never executes pickup or opens software");
    sharedPhone.down = false;
    assert.ok(canUsePhone(sharedPhone));
    const saved = await fs.readFile(files.narrativeJournal, "utf8");
    const reopened = await NarrativeStore.open(dir, { now: () => now });
    assert.deepEqual(reopened.snapshot().phoneState, restored);
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), saved);
    unsubscribe();
    console.log("PASS physical phone state: truthful legacy defaults, independent reach/use/perception, atomic publication/reload, source/travel authority, no prose inference or fabricated chat, repair without automatic pickup");
  } finally { await runtime?.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
