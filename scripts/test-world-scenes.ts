import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import type { NarrativeObservation, NarrativeSnapshot } from "../src/world/narrative-types.js";
import type { ChatResult, ChatMessage, ChatToolDef } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

type Resolution = {
  botName?: string;
  worldState?: string;
  actorStates?: { actorId: string; state: string }[];
  perceptions: { actorId: string; text: string }[];
  outcome?: { status: "completed" | "failed" | "needs_input"; reason?: string; speechSpoken?: boolean };
};
type Request = { kind: string; task: string; stateVersion: number; worldState: string; actors: { id: string; state: string; perception: string }[]; pendingActions: { id: string; intent: string }[] };
type Receipt = { observation: NarrativeObservation; action: { id: string; intent: string; status: string }; scene: NonNullable<NarrativeObservation["scene"]> };
const result = (input: Resolution): ChatResult => ({ content: "", toolCalls: [{ id: "scene-resolution", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(input) } }] });
const response = (text: string, worldState?: string, state?: string, outcome?: Resolution["outcome"]): Resolution => ({ perceptions: [{ actorId: "bot", text }], ...(worldState ? { worldState } : {}), ...(state ? { actorStates: [{ actorId: "bot", state }] } : {}), ...(outcome ? { outcome } : {}) });

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-scenes-"));
  const files = new WorldFiles(dir); await files.ensure();
  let now = 10, requests = 0;
  let infer: (messages: ChatMessage[], tools: ChatToolDef[]) => Promise<ChatResult> = async () => { throw Error("Unexpected inference"); };
  const allInputs: { messages: ChatMessage[]; tools: ChatToolDef[] }[] = [];
  const runtime = new NarrativeWorld(files, { now: () => now, realMsUntil: () => 0 } as any, async (messages, tools) => {
    requests++; allInputs.push(structuredClone({ messages, tools })); return infer(messages, tools);
  });
  let reopened: NarrativeWorld | undefined;
  const privateFact = "WORLD_ONLY_SECRET：店员已把备用钥匙藏进后厨封闭抽屉。小澈不知道这件事。";
  const initialState = "小澈在家中的窗边，手边有茶，还没吃午饭。街角有一家餐厅。菜单内容尚未确定。" + privateFact;
  const initialBody = "小澈坐在窗边，身体没有受伤，有些饿，还没有吃午饭。";
  const initialScene = "清晨的风从半开的窗户钻进来，轻轻翻动桌角的纸页。茶还温着，你的肚子已经有些饿了。";
  const arrivalScene = "你穿过花园，沿石板路走到街角餐厅。推门时，门楣的风铃轻轻响了一声。\n\n柜台后的店员抬起头：“今天想吃些什么？”柜台上放着一本合着的菜单，旁边另有一块可直接看见的餐牌。你还没有点餐，他正在等你回答。";
  const arrivedState = "小澈从家走到街角餐厅，站在柜台前，还没有点餐。店员刚问：“今天想吃些什么？”现在等小澈回答。柜台上有合着的菜单和一块可见餐牌，菜品尚未确定。" + privateFact;
  const arrivedBody = "小澈站在餐厅柜台前，仍有些饿，还没有吃饭。店员正在等她点餐。";
  const menuScene = "餐牌上写着：清汤面 18 元，米饭套餐 22 元。旁边一行小字提醒：清汤面需要等十分钟。店员仍在等你点餐。合着的菜单里面写了什么，目前看不见。";
  const menuState = "小澈站在街角餐厅柜台前，还没有点餐。店员刚问：“今天想吃些什么？”现在等小澈回答。可见餐牌已确认：清汤面 18 元，米饭套餐 22 元；清汤面需要等十分钟。柜台上的纸质菜单仍合着，内页没有被看过。" + privateFact;
  const orderWords = "请给我一碗清汤面，不要葱，谢谢。";
  const orderScene = `你指了指餐牌，对店员说：“${orderWords}”\n\n“好，不放葱，十分钟左右。”店员在单子上记下备注，示意你先找位置坐。现在订单已经交给厨房，面还没有端上来。`;
  const orderState = "小澈已点一碗 18 元的清汤面，明确要求不要葱。店员回答：“好，不放葱，十分钟左右。”订单已交厨房；面还没端上来。小澈还没吃饭，可以找位置等待。米饭套餐 22 元，纸质菜单内页仍未知。" + privateFact;
  const finishedScene = "你在靠窗的位置坐下，等了一会儿。店员把清汤面端来，汤面上没有葱花。\n\n你慢慢吃完面，把筷子放在碗边。碗已经空了，刚才的饥饿感也缓和下来；店员正在招呼另一桌客人。";
  const finishedState = "小澈已在餐厅靠窗的位置吃完一碗不放葱的清汤面，空碗留在桌上。清汤面 18 元，米饭套餐 22 元；店员正在招呼另一桌。此前询问点餐的对话已经结束。" + privateFact;
  const finishedBody = "小澈坐在餐厅窗边，已经吃过午饭，饥饿感缓和下来，身体没有受伤。";
  function call(id: string, description: string, speech?: string, target?: string): ToolCallRecord {
    return { id, name: "act", role: "agent", arguments: { description, ...(speech ? { speech } : {}), ...(target ? { target } : {}) }, issuedAt: now, expectedAt: now };
  }
  function input(messages: ChatMessage[], kind: string, fresh = true): Request {
    if (fresh) assert.equal(messages.length, 2, "each new World task starts from definition plus current state, without previous model turns");
    assert.equal(messages[0]!.role, "system");
    assert.match(String(messages[0]!.content), /world_definition/);
    assert.equal(messages.at(-1)!.role, "user");
    const value = JSON.parse(String(messages.find(message => message.role === "user")!.content)) as Request;
    assert.equal(value.kind, kind); return value;
  }
  function expect(kind: string, output: Resolution, check?: (request: Request) => void) {
    infer = async (messages, tools) => {
      assert.deepEqual(tools.map(tool => tool.function.name), ["resolve_world"]);
      assert.doesNotMatch(JSON.stringify(tools), /"operations"|"observationId"|"speechAfter"/);
      check?.(input(messages, kind)); return result(output);
    };
  }
  const receipts: Receipt[] = [];
  const deliveredJournal: string[] = [];
  const deliver = (text: string) => {
    const receipt = JSON.parse(text) as Receipt;
    // Deliver is synchronous: the complete committed record must already be on disk.
    const lines = readFileSync(files.narrativeJournal, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(lines.some(line => line.perceptions.some((p: { eventId: string; text: string }) => p.eventId === receipt.scene.eventId && p.text === receipt.scene.text)));
    assert.doesNotMatch(text, /WORLD_ONLY_SECRET|PRIVATE_REASON|备用钥匙|后厨封闭抽屉/);
    receipts.push(receipt); deliveredJournal.push(JSON.stringify(lines.at(-1)));
  };
  try {
    expect("initialize", { ...response(initialScene, initialState, initialBody), botName: "小澈" }, request => {
      assert.equal(request.worldState, ""); assert.match(request.task, /创世/);
    });
    await runtime.ensure("小澈是一个会自己决定行动的常驻角色。", "日常生活世界，NPC 依处境自然回应，不读取他人的秘密。");
    const store = await runtime.store();
    assert.equal(store.snapshot().worldState, initialState);
    assert.equal((await runtime.peek()).narrative, initialScene);
    assert.equal(requests, 1, "creating the first scene requires one World call, with no secondary renderer");

    now++;
    expect("action", response(arrivalScene, arrivedState, arrivedBody, { status: "needs_input", reason: "PRIVATE_REASON：仍有后台秘密，不能送给角色。" }), request => {
      assert.equal(request.worldState, initialState); assert.equal(request.actors[0]!.state, initialBody);
      assert.match(request.task, /去吃饭/); assert.match(request.task, /街角的餐厅/);
      assert.ok(request.pendingActions.some(action => action.id === "bot:go-eat"));
    });
    const eating = call("go-eat", "去吃饭", undefined, "街角的餐厅");
    assert.equal(await runtime.act("bot", eating, deliver), true);
    const arrived = receipts.at(-1)!;
    assert.equal(arrived.action.status, "needs_input");
    assert.equal(arrived.scene.text, arrivalScene, "World prose, including dialogue and paragraph rhythm, is returned verbatim");
    assert.equal(arrived.observation.narrative, arrivalScene);
    assert.deepEqual(arrived.observation.entities, []);
    assert.equal(arrived.observation.experiences, undefined, "a readable result does not require synthetic entity operations");
    assert.deepEqual(arrived.scene.sourceEventIds, arrived.observation.sourceEventIds);
    assert.equal(store.snapshot().actors.bot!.state, arrivedBody, "arriving and hearing a question does not mean the meal was completed");
    assert.match(deliveredJournal.at(-1)!, /PRIVATE_REASON/);
    const actionRecord = JSON.parse(deliveredJournal.at(-1)!);
    assert.equal(actionRecord.commit.worldState, arrivedState);
    assert.equal(actionRecord.commit.actors.bot.state, arrivedBody);
    assert.equal(actionRecord.commit.actions["bot:go-eat"].status, "needs_input");
    assert.equal(actionRecord.perceptions[0].text, arrivalScene, "state, action status and visible scene are persisted together before delivery");

    now++;
    expect("observe", response(menuScene, menuState), request => {
      assert.equal(request.worldState, arrivedState);
      assert.equal(request.actors[0]!.perception, arrivalScene);
      assert.match(request.task, /看看可见餐牌/); assert.match(request.task, /柜台上的餐牌/);
      assert.match(request.task, /不能代为行动/);
      assert.doesNotMatch(request.worldState, /清汤面 18 元/, "unestablished menu details are not pretended to have existed in prior state");
    });
    const menu = await runtime.observe("bot", { intent: "看看可见餐牌", target: "柜台上的餐牌", modality: "sight" });
    assert.equal(menu.narrative, menuScene); assert.equal(menu.scene!.text, menuScene);
    assert.equal(store.snapshot().worldState, menuState, "newly established observation details are saved, not only shown once");
    assert.doesNotMatch(JSON.stringify(menu), /WORLD_ONLY_SECRET|备用钥匙/);
    const beforeReread = await fs.readFile(files.narrativeJournal, "utf8"), versionBeforeReread = store.snapshot().sequence;
    now++;
    expect("observe", response(menuScene), request => {
      assert.equal(request.worldState, menuState); assert.equal(request.actors[0]!.perception, menuScene);
      assert.match(request.worldState, /清汤面 18 元，米饭套餐 22 元/);
    });
    const menuAgain = await runtime.observe("bot", { intent: "再确认一下菜单和等待时间" });
    assert.deepEqual(menuAgain, menu, "re-reading identical known facts preserves the original scene and provenance");
    assert.equal(store.snapshot().sequence, versionBeforeReread);
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), beforeReread, "an identical observation does not manufacture a new event");

    now++;
    let speechAttempts = 0;
    infer = async messages => {
      const request = input(messages, "action", speechAttempts === 0);
      assert.equal(request.worldState, menuState);
      assert.match(request.task, /请给我一碗清汤面，不要葱，谢谢。/);
      speechAttempts++;
      if (speechAttempts === 1) return result(response("你告诉店员要一份面条。店员说好。", "INVALID_PROPOSAL_STATE", undefined, { status: "needs_input", speechSpoken: true }));
      assert.equal(speechAttempts, 2);
      assert.match(JSON.stringify(messages), /逐字包含请求原话/);
      assert.equal(store.snapshot().worldState, menuState, "a rejected paraphrase never updates the world");
      assert.ok(!store.readPerceptions("bot").some(p => p.text === "你告诉店员要一份面条。店员说好。"));
      return result(response(orderScene, orderState, "小澈站在餐厅柜台前，已经点了不放葱的清汤面，还没有吃饭。", { status: "needs_input", speechSpoken: true }));
    };
    assert.equal(await runtime.act("bot", call("order", "向店员点餐", orderWords, "柜台后的店员"), deliver), true);
    assert.equal(speechAttempts, 2);
    assert.equal(receipts.at(-1)!.scene.text, orderScene);
    assert.ok(receipts.at(-1)!.scene.text.includes(orderWords));
    assert.equal(store.snapshot().worldState, orderState);

    now++;
    expect("action", response(finishedScene, finishedState, finishedBody, { status: "completed" }), request => {
      assert.equal(request.worldState, orderState);
      assert.equal(request.actors[0]!.perception, orderScene);
      assert.match(request.worldState, /不要葱/); assert.match(request.task, /等面端上来后吃饭/);
      assert.equal(request.pendingActions.length, 1, "the earlier decision boundary has already released the action slot");
    });
    assert.equal(await runtime.act("bot", call("finish-meal", "找位置坐下，等面端上来后吃饭"), deliver), true);
    assert.equal(receipts.at(-1)!.action.status, "completed");
    assert.equal(receipts.at(-1)!.scene.text, finishedScene);
    assert.equal(store.snapshot().actors.bot!.state, finishedBody);
    assert.equal(store.snapshot().worldState, finishedState);

    const beforeReplay = requests, beforeReplayLog = await fs.readFile(files.narrativeJournal, "utf8");
    assert.equal(await runtime.act("bot", eating, deliver), true);
    assert.equal(requests, beforeReplay, "replaying the original action performs no inference, including no prose rendering call");
    assert.deepEqual(receipts.at(-1), arrived, "old action replay retains its original arrival and unanswered question, not the latest meal scene");
    assert.equal(await fs.readFile(files.narrativeJournal, "utf8"), beforeReplayLog);
    assert.equal((await runtime.peek()).narrative, finishedScene, "replay must not roll current perception backward");

    now++;
    const futureWords = "再来一份米饭套餐。";
    const notSpoken = "你暂时没有开口，桌上仍是刚吃完的空碗。店员还在招呼另一桌客人。";
    expect("action", response(notSpoken, undefined, undefined, { status: "completed", speechSpoken: false }), request => {
      assert.equal(request.worldState, finishedState); assert.match(request.task, /暂时不开口/);
    });
    assert.equal(await runtime.act("bot", call("hold-words", "先看看店员是否忙，暂时不开口", futureWords), deliver), true);
    assert.equal(receipts.at(-1)!.scene.text, notSpoken);
    assert.ok(!JSON.stringify(receipts.at(-1)).includes(futureWords), "an unspoken future line is not emitted as something the role already said");
    assert.equal(store.snapshot().worldState, finishedState);

    const finalSnapshot = store.snapshot(), finalObservation = await runtime.peek();
    await runtime.shutdown();
    reopened = new NarrativeWorld(new WorldFiles(dir), { now: () => ++now } as any, async () => { throw Error("Recovery and reads must not infer"); });
    assert.deepEqual((await reopened.store()).snapshot(), finalSnapshot);
    assert.deepEqual(await reopened.peek(), finalObservation);
    const inspection = await reopened.inspect() as { mode: string; snapshot: NarrativeSnapshot & { entities: Record<string, never> }; events: { kind: string; topic: string }[] };
    assert.equal(inspection.mode, "narrative"); assert.deepEqual(inspection.snapshot.entities, {});
    assert.match(inspection.snapshot.worldState, /WORLD_ONLY_SECRET/, "authorized administrative state remains separate from role-visible receipts");
    assert.ok(inspection.events.some(event => event.topic === "world.perception" && event.kind === "observation"));
    const afterRestart: Receipt[] = [];
    assert.equal(await reopened.act("bot", eating, text => afterRestart.push(JSON.parse(text))), true);
    assert.deepEqual(afterRestart[0], arrived, "journal reopening preserves action scene identity and causal roots");
    assert.equal(allInputs.filter(entry => entry.messages.length > 2).length, 1, "only the same-task protocol correction has conversational history");
    assert.equal(requests, 8, "scenario uses exactly the requested World tasks plus one rejected speech repair, never an extra scene model");
    console.log("PASS natural scenes: stateless World continuity, meal/NPC decision and continuation, durable menu facts, literal speech repair, unseen fact isolation, atomic scene delivery and exact replay/restart");
  } finally { await reopened?.shutdown(); await runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
