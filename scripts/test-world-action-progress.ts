import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import type { ChatResult } from "../src/llm/chat.js";
import type { NarrativeAction } from "../src/world/narrative-types.js";
import type { ToolCallRecord } from "../src/types.js";

const response = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "scene", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-action-progress-")), files = new WorldFiles(base); await files.ensure();
  await files.writeMeta({ realWorld: false });
  let now = 10, calls = 0;
  const requests: any[] = [];
  let handler: (request: any) => ChatResult = () => { throw new Error("Unexpected inference"); };
  const world = new NarrativeWorld(files, { now: () => now, realMsUntil: () => 0 } as any, async messages => {
    calls++;
    const request = JSON.parse(String(messages.find(message => message.role === "user")!.content));
    requests.push(request); return handler(request);
  });
  try {
    const store = await world.store();
    await store.commit({ idempotencyKey: "seed", source: "fixture", initialized: true, worldState: "厨房窗边有食材，室内的主灯没有亮。", actors: {
      bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在厨房的案板旁。", perception: "窗边仍有微弱的光。" },
      visitor: { id: "visitor", name: "旅人", controller: "player", present: true, state: "在另一个房间。", perception: "坐在椅子上。" },
    } });
    const call = (id: string, intent: string): ToolCallRecord => ({ id, name: "act", role: "agent", arguments: { description: intent }, issuedAt: now, expectedAt: now });
    const recorded = async (id: string, intent: string, status: NarrativeAction["status"], actorId = "bot") => {
      now++;
      const action: NarrativeAction = { id, actorId, intent, status, phase: status === "pending" ? "accepted" : "finished", startedAt: now, expectedEnd: now, requestFingerprint: id,
        ...(status === "pending" ? {} : { finishedAt: now }) };
      await store.commit({ idempotencyKey: id, source: "fixture", actorId, actions: { [id]: action } });
    };

    await recorded("old", "尝试走近窗边", "completed");
    await recorded("light", "开主灯", "failed");
    await recorded("unresolved", "挑选做饭的位置", "needs_input");
    await recorded("visitor-secret", "OTHER_ACTOR_PRIVATE_INTENT", "completed", "visitor");
    await recorded("not-started", "还未结算的擦桌计划", "pending");
    await store.commit({ idempotencyKey: "last-view", source: "fixture", perceptions: [{ actorId: "bot", text: "你按过主灯开关，但灯没有亮。", opportunities: [{ label: "修理灯泡", intent: "UNSELECTED_OPTION_ONLY" }] }] });
    handler = request => {
      assert.equal(request.action.intent, "不管主灯，先把食材和调料整理好");
      assert.deepEqual(request.recentActions.map((item: any) => [item.intent, item.status]), [["尝试走近窗边", "completed"], ["开主灯", "failed"], ["挑选做饭的位置", "needs_input"]]);
      assert.doesNotMatch(JSON.stringify(request.recentActions), /OTHER_ACTOR|未结算|UNSELECTED|不管主灯/);
      assert.deepEqual(request.recentActions.map((item: any) => item.worldTime), [11, 12, 13]);
      assert.equal(JSON.stringify(request).split("你按过主灯开关，但灯没有亮。").length - 1, 1, "history does not repeat the existing actor perception");
      assert.equal(JSON.stringify(request).split(request.action.intent).length - 1, 1, "current intent remains one authoritative request");
      assert.ok(request.pendingActions.some((item: any) => item.id === "not-started"), "accepted actions stay separate from resolved history");
      return response({ perceptions: [{ actorId: "bot", text: "你借窗边的微光，把食材和调料分别摆好，案板空了出来。", opportunities: [{ label: "开始切菜", intent: "把案板上的蔬菜切好" }] }],
        actorStates: [{ actorId: "bot", state: "站在厨房窗边，食材和调料已分类放好，还没有下锅。" }], outcome: { status: "completed" } });
    };
    let receipt: any;
    const organize = call("organize", "不管主灯，先把食材和调料整理好");
    assert.equal(await world.act("bot", organize, text => { receipt = JSON.parse(text); }), true);
    assert.equal(receipt.action.status, "completed", "unfinished meal and new suggestions do not change this completed step");
    assert.match(receipt.observation.narrative, /食材和调料分别摆好/);
    assert.equal(calls, 1, "no separate progress judge or forced follow-up generation");
    assert.equal(await world.act("bot", organize, () => {}), true); assert.equal(calls, 1, "retries replay the committed result");
    assert.equal(store.readRecentActions("bot").at(-1)!.intent, organize.arguments.description);
    assert.equal(store.readRecentActions("bot", "bot:organize").at(-1)!.intent, "挑选做饭的位置");
    const history = store.readRecentActions("bot");
    await store.reload(); assert.deepEqual(store.readRecentActions("bot"), history, "restart/reload retains chronological provenance");

    handler = request => response({ perceptions: [{ actorId: "bot", text: "两只瓶子的标签都已脱落，无法分清哪瓶是盐，需要另选调味料或先辨认。" }],
      outcome: { status: "needs_input", reason: "无法辨认的调味料涉及新的选择" } });
    assert.equal(await world.act("bot", call("choice", "给食材加盐"), text => { receipt = JSON.parse(text); }), true);
    assert.equal(receipt.action.status, "needs_input", "program does not relabel a genuine unresolved choice as success");
    handler = request => { assert.equal(request.recentActions, undefined, "non-action tasks carry no extra action context"); return response({ perceptions: [{ actorId: "bot", text: "案板仍然空着。" }] }); };
    await world.observe();

    // A bounded read never truncates an intent or skips a large recent row and
    // passes older requests off as contiguous recent history.
    await recorded("huge", "完整意图".repeat(1000), "failed");
    assert.deepEqual(store.readRecentActions("bot"), []);
    await recorded("small", "把碗放下", "completed");
    assert.deepEqual(store.readRecentActions("bot").map(row => row.intent), ["把碗放下"]);
    assert.ok(JSON.stringify(store.readRecentActions("bot")).length <= 1800);
    assert.deepEqual(store.readRecentActions("bot", undefined, 0), []);
    assert.deepEqual(store.readRecentActions("bot", undefined, 3, 2), []);
    assert.doesNotMatch(JSON.stringify(store.readRecentActions("visitor")), /把碗|主灯|食材/);

    const attempted = "手仍握着碗，没有松开。", blocked = "手套被柜门夹住，先打开柜门才能移动。";
    const withResult = async (id: string, status: NarrativeAction["status"], text: string, reason?: string) => {
      now++;
      const action: NarrativeAction = { id, actorId: "bot", intent: "放下碗", status, phase: "finished", startedAt: now, expectedEnd: now,
        finishedAt: now, requestFingerprint: id, ...(reason ? { reason } : {}) };
      return store.commit({ idempotencyKey: id, source: "fixture", actorId: "bot", actionId: id, actions: { [id]: action }, perceptions: [
        { actorId: "bot", text, opportunities: [{ label: "未选项", intent: "UNSELECTED_RESULT_OPTION" }] },
        { actorId: "visitor", text: "OTHER_ACTOR_PRIVATE_RESULT" },
      ] });
    };
    const inconsistent = await withResult("inconsistent", "completed", attempted, "旧裁定错误地认为已完成。");
    const failure = await withResult("blocked", "failed", blocked, "柜门夹住手套。");
    const evidence = store.readRecentActions("bot", undefined, 2, 3600, { currentPerception: blocked });
    assert.equal(evidence[0]!.status, "completed", "history honestly retains an old terminal marker without claiming it proved success");
    assert.deepEqual(evidence[0]!.result, { eventId: inconsistent.perceptions[0]!.eventId, text: attempted }, "actual contradictory outcome accompanies the old status");
    assert.deepEqual(evidence[1]!.result, { eventId: failure.perceptions[0]!.eventId, inCurrentPerception: true }, "the current actor scene is referenced rather than repeated");
    assert.equal(evidence[1]!.reason, "柜门夹住手套。");
    assert.doesNotMatch(JSON.stringify(evidence), /OTHER_ACTOR_PRIVATE|UNSELECTED_RESULT/);
    assert.ok(store.readRecentActions("bot", undefined, 2).every(row => row.result === undefined && row.reason === undefined), "heartbeat's default history stays free of old scenes");
    const projected = store.readRecentActions("bot", undefined, 1, 3600, { projectText: () => "经过边界投影的物理结果。" });
    assert.equal(projected[0]!.result!.text, "经过边界投影的物理结果。", "new historical evidence cannot bypass the runtime's device/time projection");
    assert.equal(projected[0]!.reason, "经过边界投影的物理结果。", "internal diagnostics do not bypass the same device-fact boundary");
    const hidden = store.readRecentActions("bot", undefined, 1, 3600, { currentPerception: blocked, projectText: () => "" });
    assert.deepEqual(hidden[0]!.result, { eventId: failure.perceptions[0]!.eventId, omitted: true }, "an isolated result is not described as visible in the current perception");
    assert.equal(hidden[0]!.reasonOmitted, true);
    await store.reload();
    assert.deepEqual(store.readRecentActions("bot", undefined, 2, 3600, { currentPerception: blocked }), evidence, "result IDs and committed causal order survive reload");
    await withResult("long-result", "failed", "没有完成，" + "背景。".repeat(800), "诊断。".repeat(300));
    const bounded = store.readRecentActions("bot", undefined, 1, 3600, {});
    assert.equal(bounded[0]!.result!.omitted, true);
    assert.equal(bounded[0]!.result!.text, undefined, "oversized negative outcomes are omitted explicitly, never clipped into apparent success");
    assert.equal(bounded[0]!.reasonOmitted, true);
    assert.equal(bounded[0]!.status, "failed");
    assert.ok(JSON.stringify(bounded).length <= 3600);
    assert.deepEqual(store.readRecentActions("bot", undefined, 1, 2, {}), []);
    console.log("PASS World action progress: latest intent, bounded actor-scoped committed history, no scene duplication, honest terminal outcomes and replay without additional inference");
  } finally { await world.shutdown(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
