import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { worldPhoneInput, projectWorldPhonePosture, hasContradictoryPhonePosture, assertEvolutionActorAuthority, assertWorldPhonePosture, assertEvolutionHasChange } from "../src/world/situation-grounding.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { PhoneStatus } from "../src/types.js";

const native = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const quiet = () => native({ perceptions: [], externalChanges: [] });
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-situation-")), files = new WorldFiles(base);
  await files.ensure(); await files.writeMeta({ realWorld: false });
  let handler: (messages: ChatMessage[]) => ChatResult = quiet;
  const phone: PhoneStatus = { down: false }, requests: ChatMessage[][] = [];
  const runtime = new NarrativeWorld(files, { now: () => 100, realMsUntil: () => 1 } as any, async messages => {
    requests.push(structuredClone(messages)); return handler(messages);
  });
  runtime.phoneStatusProvider = () => phone;
  const store = await runtime.store();
  await store.commit({ idempotencyKey: "seed", source: "administrator", initialized: true, worldState: "厨房光线昏暗。手机躺在砧板边缘。邻居在院子里修理木椅。", actors: {
    bot: { id: "bot", name: "酷霸", present: true, controller: "bot", state: "在厨房里弯腰探索。手机放在砧板边缘。", perception: "你保持着弯腰探索，手机躺在砧板边缘，你没有注意到它。" },
    visitor: { id: "visitor", name: "阿宁", present: true, controller: "player", state: "在隔音的屋内。", perception: "你在看信，桌上有只有你知道的纸条。" },
  }, phoneState: { reachable: true, location: "砧板边缘", usable: true, perceptible: true } });
  await store.commit({ idempotencyKey: "cancelled", source: "fixture", actorId: "bot", actions: { search: {
    id: "search", actorId: "bot", intent: "弯腰探索墙角", status: "cancelled", phase: "finished", startedAt: 90, finishedAt: 95, expectedEnd: 100, requestFingerprint: "fixture",
  } } });
  return { base, runtime, store, phone, requests, handle: (next: typeof handler) => { handler = next; }, close: async () => { await runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); } };
}

async function main() {
  const location = { reachable: true, location: "砧板边缘", usable: true, perceptible: true };
  assert.deepEqual(worldPhoneInput(location, { down: false }), { phoneHeld: true, phoneState: { ...location, location: "持有者手中" } });
  assert.equal(location.location, "砧板边缘", "projection must not rewrite persisted objects");
  assert.equal(worldPhoneInput({ ...location, location: "手中" }, { down: true }).phoneState.location, null, "putdown does not invent a resting surface");
  assert.equal(projectWorldPhonePosture("厨房很暗。手机躺在砧板边缘。阿宁的手机放在桌上。", true, "酷霸"), "厨房很暗。阿宁的手机放在桌上。");
  assert.equal(hasContradictoryPhonePosture("手机被地震震落在地上。", true, "酷霸"), false);
  assert.equal(hasContradictoryPhonePosture("手机原本放在桌上。", true, "酷霸"), false);
  assert.equal(hasContradictoryPhonePosture("如果手机不在手里，手机放在桌上也能被碰到。", true, "酷霸"), false);
  assert.equal(projectWorldPhonePosture("如果手机被拿走，手机在桌面也并非安全。", true, "酷霸"), "如果手机被拿走，手机在桌面也并非安全。");
  for (const text of ["阿宁拿来自己的手机，手机放在桌上。", "阿宁的手机放在书旁，手机在桌面晃动。"] ) {
    assert.equal(projectWorldPhonePosture(text, true, "酷霸"), text, "ambiguous other-phone references must be retained");
    assert.doesNotThrow(() => assertWorldPhonePosture({ perceptions: [{ actorId: "bot", text }] }, true, "酷霸", ""));
  }
  assert.doesNotThrow(() => assertEvolutionHasChange([{ description: "老旧的屋顶还是塌了。" }]), "还是 can introduce an actual event, not unchanged scenery");
  const f = await fixture();
  try {
    const original = await f.store.exportJournal(), before = f.store.snapshot();
    f.handle(messages => {
      const request = JSON.parse(String(messages[1]!.content));
      assert.equal(request.phoneHeld, true); assert.equal(request.phoneState.location, "持有者手中");
      assert.doesNotMatch(JSON.stringify(request), /砧板边缘|你保持着弯腰探索|你没有注意到它|只有你知道的纸条/);
      assert.equal(request.actors.find((actor: any) => actor.id === "bot").lastAction.status, "cancelled");
      assert.deepEqual(request.pendingActions, []);
      assert.ok(request.actors.every((actor: any) => !Object.hasOwn(actor, "perception")));
      return quiet();
    });
    await f.runtime.evolve("心跳");
    assert.equal(await f.store.exportJournal(), original); assert.deepEqual(f.store.snapshot(), before);
    const bad = [
      { externalChanges: [{ id: "idle", description: "厨房依旧昏暗。" }], perceptions: [{ actorId: "bot", text: "厨房依旧昏暗。", changeIds: ["idle"] }] },
      { externalChanges: [{ id: "wind", description: "窗外一阵风吹过。" }], perceptions: [{ actorId: "bot", text: "你保持着弯腰探索，窗外一阵风吹过。", changeIds: ["wind"] }] },
      { externalChanges: [{ id: "wind", description: "窗外一阵风吹过。" }], perceptions: [{ actorId: "bot", text: "手机躺在砧板边缘，窗外风吹过。", changeIds: ["wind"] }] },
      { externalChanges: [{ id: "wind", description: "窗外一阵风吹过。" }], actorEffects: [{ actorId: "bot", state: "酷霸继续寻找光源。", changeIds: ["wind"] }], perceptions: [] },
    ];
    for (const proposal of bad) {
      let attempt = 0;
      f.handle(messages => {
        if (++attempt === 1) return native(proposal);
        assert.match(String(messages.at(-1)!.content), /EVOLUTION_NO_CHANGE|EVOLUTION_ACTOR_AUTHORITY|WORLD_PHONE_POSTURE/);
        assert.deepEqual(f.store.snapshot(), before, "the invalid draft has not changed the live state"); return quiet();
      });
      await f.runtime.evolve("心跳");
      assert.equal(attempt, 2); assert.equal(await f.store.exportJournal(), original, "rejected drafts and quiet repairs have no durable side effects");
    }
    f.handle(() => native({ externalChanges: [{ id: "bump", description: "邻居拖动木椅撞到厨房窗框，灰尘从窗沿落下。" }],
      actorEffects: [{ actorId: "bot", state: "在厨房，肩膀被窗沿落下的灰尘弄脏。", changeIds: ["bump"] }],
      perceptions: [{ actorId: "bot", text: "窗框被撞了一下，灰尘落在你的肩膀上。", changeIds: ["bump"] }] }));
    await f.runtime.evolve("心跳");
    assert.match(f.store.snapshot().actors.bot!.state, /灰尘/);
    assert.deepEqual(f.store.snapshot().actors.visitor, before.actors.visitor);
    assert.equal(f.store.readPerceptions("visitor").length, 0, "outside changes do not reveal a private actor scene");
    assert.equal(f.store.snapshot().actions.search!.status, "cancelled");
    assert.equal(f.store.readPerceptions("bot").length, 1);
    assert.equal(f.store.snapshot().phoneState!.location, "砧板边缘", "projection does not silently rewrite the durable phone location");
    assert.equal(f.requests.length, 10);
    for (const text of ["如果你决定进屋，就能避雨。", "如果下起雨，你走到屋檐下就能避雨。", "你没有决定要做什么。", "邻居喊：‘如果你决定进屋，就带上这把伞。’", "邻居喊：“你走到屋檐下吧！”", "邻居阻止你继续寻找光源。", "不是你选择了离开，是洪水把你冲到了门外。"]) {
      assert.doesNotThrow(() => assertEvolutionActorAuthority({ perceptions: [{ actorId: "bot", text }] }, Object.values(before.actors), ""));
    }
    assert.throws(() => assertEvolutionActorAuthority({ perceptions: [{ actorId: "bot", text: "如果下雨，可以避雨。你决定继续探索。" }] }, Object.values(before.actors), ""), /EVOLUTION_ACTOR_AUTHORITY/);
    f.handle(() => native({ externalChanges: [{ id: "shake", description: "邻居大声呼喊并摇晃酷霸的肩膀，使酷霸醒来。" }],
      actorEffects: [{ actorId: "bot", state: "在厨房，邻居的摇晃使你醒来，肩膀还带着灰尘。", changeIds: ["shake"] }],
      perceptions: [{ actorId: "bot", text: "邻居摇晃你的肩膀，你醒来听见他在呼喊。", changeIds: ["shake"] }] }));
    await f.runtime.evolve("心跳");
    assert.match(f.store.snapshot().actors.bot!.state, /醒来/);
    f.handle(() => native({ externalChanges: [{ id: "stone", description: "飞石击中手机外壳，机身被砸坏。" }],
      phoneState: { ...location, location: "手中", usable: false }, phoneChangeIds: ["stone"],
      perceptions: [{ actorId: "bot", text: "飞石击中手机外壳，机身裂开。", changeIds: ["stone"] }] }));
    await f.runtime.evolve("心跳");
    assert.equal(f.store.snapshot().phoneState!.usable, false, "physical damage is not a posture violation");
    const theft = { externalChanges: [{ id: "theft", description: "闯入者从你手中夺走手机。手机被他放在院外的桌上。" }],
      phoneState: { reachable: false, location: "院外桌上", usable: false, perceptible: false }, phoneChangeIds: ["theft"],
      perceptions: [{ actorId: "bot", text: "闯入者夺走手机，跑到院外；手机躺在院外的桌上，你现在够不到它。", changeIds: ["theft"] }] };
    f.handle(() => native(theft));
    await f.runtime.evolve("心跳");
    assert.equal(f.store.snapshot().phoneState!.reachable, false); assert.equal(f.store.snapshot().phoneState!.location, "院外桌上");
    assert.equal(f.requests.length, 13, "valid involuntary waking, damage and theft need no corrective inference");
    const fall = { ...theft, externalChanges: [{ id: "theft", description: "地震让手机滑落，手机落入够不到的地下裂缝。" }] };
    assert.doesNotThrow(() => assertWorldPhonePosture(fall, true, "酷霸", ""));
    assert.throws(() => assertWorldPhonePosture({ ...theft, externalChanges: [{ id: "theft", description: "厨房依旧昏暗。" }] }, true, "酷霸", ""), /WORLD_PHONE_POSTURE/, "an inaccessible update alone does not authorize a stale resting-phone story");
  } finally { await f.close(); }
  console.log("PASS coherent phone projection, terminal action isolation, quiet heartbeat, rejected drafts, causal effects and recipient privacy");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
