import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { StructuredWorld } from "../src/world/runtime.js";
import { renderScene } from "../src/world/scene.js";
import { worldProposalTool } from "../src/world/proposal.js";
import { WORLD_PROMPT_DEFAULTS } from "../src/prompts.js";
import type { WorldOperation } from "../src/world/state.js";
import type { ChatResult, ChatMessage } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

type Outcome = { status: "completed" | "failed" | "needs_input"; reason?: string; speechAfter?: number | null };
const result = (operations: WorldOperation[], outcome: Outcome): ChatResult => ({ content: "", toolCalls: [{ id: "scene-proposal", type: "function", function: { name: "propose_world", arguments: JSON.stringify({ operations, outcome }) } }] });
const call = (id: string, description: string, speech?: string): ToolCallRecord => ({ id, name: "act", role: "agent", arguments: { description, ...(speech ? { speech } : {}) }, issuedAt: 10, expectedAt: 10 });

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-scenes-"));
  let requests = 0, now = 10;
  let infer: (messages: ChatMessage[]) => Promise<ChatResult> = async () => { throw Error("Unexpected inference"); };
  const files = new WorldFiles(dir); await files.ensure();
  const runtime = new StructuredWorld(files, { now: () => now, realMsUntil: () => 0 } as any, async messages => { requests++; return infer(messages); });
  try {
    const kernel = await runtime.kernel();
    await kernel.initialize([
      { id: "home", kind: "place", name: "家", location: null },
      { id: "dining", kind: "place", name: "餐厅", location: null },
      { id: "bot", kind: "actor", name: "小澈", controller: "bot", location: "home", attributes: { hunger: { value: 7, visibility: "owner" } } },
      { id: "friend", kind: "actor", name: "家里的朋友", controller: "world", location: "home" },
      { id: "waiter", kind: "actor", name: "店员", controller: "world", location: "dining", attributes: { secret: { value: "PRIVATE_DIAGNOSIS", visibility: "hidden" } } },
      { id: "noodles", kind: "object", name: "桌上的面", location: "dining", attributes: { eaten: { value: false, visibility: "public" } } },
    ]);
    await runtime.observe();
    const deliveries: any[] = [];
    const eating = call("eat", "去吃饭");
    infer = async messages => {
      assert.match(String(messages[0]!.content), /需要点餐/);
      assert.match(String(messages.at(-1)!.content), /needs_input/);
      return result([{ op: "move", id: "bot", location: "dining" }, { op: "say", actorId: "waiter", text: "今天想吃什么？" }], { status: "needs_input", reason: "PRIVATE_DIAGNOSIS must not be shown" });
    };
    // Another consumer observes the commit before the action caller can observe it.
    let observedEarly: Promise<unknown> | undefined;
    const unwatch = kernel.subscribe(event => {
      if (event.topic === "world.committed" && event.correlationId === "bot:eat" && kernel.snapshot().actions["bot:eat"]?.status === "needs_input") observedEarly = kernel.observe("bot");
    });
    assert.equal(await runtime.act("bot", eating, text => deliveries.push(JSON.parse(text))), true);
    unwatch(); await observedEarly;
    const receipt = deliveries[0];
    assert.equal(receipt.action.status, "needs_input");
    assert.match(receipt.scene.text, /餐厅/); assert.match(receipt.scene.text, /今天想吃什么/);
    assert.doesNotMatch(receipt.scene.text, /PRIVATE_DIAGNOSIS|已吃完|心满意足/);
    assert.equal(kernel.snapshot().entities.bot!.attributes.hunger!.value, 7, "arrival and a question do not imply a completed meal");
    assert.ok(receipt.observation.experiences.some((event: any) => event.kind === "movement"));
    assert.ok(receipt.scene.sourceEventIds.every((id: string) => receipt.observation.sourceEventIds.includes(id)));
    assert.equal(kernel.snapshot().actions["bot:eat"]!.status, "needs_input");
    const beforeReplay = requests;
    assert.equal(await runtime.act("bot", eating, text => deliveries.push(JSON.parse(text))), true);
    assert.equal(requests, beforeReplay, "replaying a decision boundary cannot rerun the action or presentation model");
    assert.deepEqual(deliveries[1].scene, receipt.scene, "replayed action has the same exact scene identity and facts after another observer consumed it");
    const beforeProjection = await fs.readFile(kernel.journalPath, "utf8");
    assert.deepEqual(renderScene(receipt.observation, receipt.action), receipt.scene);
    assert.equal(await fs.readFile(kernel.journalPath, "utf8"), beforeProjection, "scene presentation is a read-only projection");

    infer = async () => result([
      { op: "move", id: "noodles", location: "bot" },
      { op: "update", id: "noodles", changes: { attributes: { eaten: { value: true, visibility: "public" } } } },
      { op: "update", id: "bot", changes: { attributes: { hunger: { value: 2, visibility: "owner" } } } },
    ], { status: "completed" });
    assert.equal(await runtime.act("bot", call("finish-meal", "吃掉桌上的面"), text => deliveries.push(JSON.parse(text))), true);
    assert.equal(deliveries.at(-1).action.status, "completed");
    assert.match(deliveries.at(-1).scene.text, /桌上的面/);
    assert.equal(kernel.snapshot().entities.bot!.attributes.hunger!.value, 2);

    await kernel.commit({ idempotencyKey: "back-home", operations: [{ op: "move", id: "bot", location: "home" }] });
    await runtime.observe(); await kernel.observe("friend"); await kernel.observe("waiter");
    infer = async () => result([{ op: "move", id: "bot", location: "dining" }, { op: "say", actorId: "waiter", text: "你好，请坐。" }], { status: "completed", speechAfter: 1 });
    const said = call("greeting", "走到餐厅后向店员问好", "你好。");
    await runtime.act("bot", said, text => deliveries.push(JSON.parse(text)));
    const heardAtHome = await kernel.observe("friend"), heardAtDining = await kernel.observe("waiter");
    assert.ok(!heardAtHome.utterances.some(item => item.text === "你好。"), "words spoken after moving cannot be heard in the previous room");
    assert.equal(heardAtDining.utterances.filter(item => item.text === "你好。").length, 1);
    const dialogue = deliveries.at(-1).observation.experiences.filter((event: any) => event.kind === "speech");
    assert.deepEqual(dialogue.map((event: any) => event.details.text), ["你好。", "你好，请坐。"]);
    infer = async () => result([{ op: "say", actorId: "waiter", text: "请先看一下菜单。" }], { status: "needs_input", speechAfter: null });
    await runtime.act("bot", call("unspoken", "看情况再决定是否点面", "给我一碗面。"), () => {});
    assert.ok(!(await kernel.observe("waiter")).utterances.some(item => item.text === "给我一碗面。"), "a choice before speaking cannot emit the supplied future line");

    // The controller's literal speech is inserted after the model's raw operations are parsed.
    // It alone can be real progress; an unsaid line or a lifecycle marker cannot.
    infer = async () => result([], { status: "needs_input", speechAfter: 0 });
    const beforeOnlySpeech = requests;
    assert.equal(await runtime.act("bot", call("speech-only-progress", "先问是否还有热茶，再决定下一步", "请问还有热茶吗？"), text => deliveries.push(JSON.parse(text))), true);
    assert.equal(requests, beforeOnlySpeech + 1, "real literal speech must not enter a spurious proposal repair loop");
    assert.equal(deliveries.at(-1).action.status, "needs_input");
    assert.ok(deliveries.at(-1).observation.experiences.some((event: any) => event.kind === "speech" && event.details?.text === "请问还有热茶吗？"));
    assert.equal((await kernel.observe("waiter")).utterances.filter(item => item.text === "请问还有热茶吗？").length, 1);
    infer = async () => result([], { status: "needs_input", speechAfter: null, reason: "原话尚未说出，也没有其他变化。" });
    await assert.rejects(runtime.act("bot", call("speech-only-unsaid", "等决定后再开口", "那就来一杯。"), () => {}), /actor-perceptible change/);
    assert.equal(kernel.snapshot().actions["bot:speech-only-unsaid"]!.status, "failed");
    assert.ok(!(await kernel.observe("waiter")).utterances.some(item => item.text === "那就来一杯。"));
    infer = async () => result([], { status: "needs_input", reason: "只试图写入行动结束标记。" });
    await assert.rejects(runtime.act("bot", call("lifecycle-only", "在原处等着"), () => {}), /actor-perceptible change/);
    assert.equal(kernel.snapshot().actions["bot:lifecycle-only"]!.status, "failed");

    // A marker, same-value update or hidden-only mutation is not meaningful progress.
    let rejected = 0;
    infer = async messages => {
      rejected++;
      if (rejected > 1) assert.match(JSON.stringify(messages), /actor-perceptible change/);
      return result([{ op: "update", id: "waiter", changes: { attributes: { secret: { value: "PRIVATE_CHANGED", visibility: "hidden" } } } }], { status: "needs_input" });
    };
    await assert.rejects(runtime.act("bot", call("fake-progress", "等店员回应"), () => {}), /actor-perceptible change/);
    assert.equal(rejected, 3); assert.equal(kernel.snapshot().actions["bot:fake-progress"]!.status, "failed");
    assert.equal(kernel.snapshot().entities.waiter!.attributes.secret!.value, "PRIVATE_DIAGNOSIS");

    infer = async () => result([], { status: "completed", reason: "Nothing happened", speechAfter: null });
    await assert.rejects(runtime.act("bot", call("invented-speech", "站着"), () => {}), /only valid/);
    await kernel.commit({ idempotencyKey: "orphan-scene", correlationId: "orphan-scene", operations: [{ op: "action.start", action: { id: "orphan-scene", actorId: "bot", intent: "未完成的行程" } }] });
    await runtime.shutdown();
    const recovered = new StructuredWorld(new WorldFiles(dir), { now: () => ++now } as any, async () => { throw Error("Recovery must not infer"); });
    const restored = await recovered.kernel();
    assert.ok(restored.actionExperiences("bot", "orphan-scene").some(event => event.details?.status === "failed"), "recovered failures preserve per-action provenance");
    await recovered.shutdown();
    assert.ok(JSON.stringify(worldProposalTool(false)).includes('"needs_input"'));
    assert.match(WORLD_PROMPT_DEFAULTS.adjudicationSystem, /未知不等于不存在/);
    console.log("PASS scenes: meal decision boundary and continuation, immediate grounded prose, durable action replay, observed speech timing, hidden/no-op rejection and recovery provenance");
  } finally { await runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
