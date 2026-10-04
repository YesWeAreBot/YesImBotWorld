/** Consciousness is an explicit committed fact, never inferred from rest or old prose. */
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldFiles } from "../src/files.js";
import { NarrativeWorld } from "../src/world/runtime.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";

const response = (proposal: unknown): ChatResult => ({ content: JSON.stringify(proposal), toolCalls: [] });
const call = (id: string, description: string, at: number, end = at): ToolCallRecord => ({ id, role: "agent", name: "act", arguments: { description }, issuedAt: at, expectedAt: end, status: "running" });

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-world-consciousness-"));
  const files = new WorldFiles(base); await files.ensure(); await files.writeMeta({ realWorld: false });
  let now = 10, inferred = 0;
  let handler: (messages: ChatMessage[]) => Promise<ChatResult> = async () => { throw new Error("unexpected inference"); };
  const runtime = new NarrativeWorld(files, { now: () => now, realMsUntil: () => 1, syncRealTime: false } as any, async messages => { inferred++; return handler(messages); });
  try {
    const store = await runtime.store();
    await store.commit({ idempotencyKey: "legacy", source: "initialize", initialized: true, worldState: "夜色深沉，小澈在卧室里。",
      actors: { bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "旧记录里写着刚睡醒，正躺在床上。", perception: "你感到有点疲惫。" } } });
    assert.equal(store.snapshot().actors.bot!.consciousness, undefined);
    const legacy = await store.exportJournal();
    handler = async messages => {
      assert.equal(JSON.parse(String(messages[1]!.content)).actors[0].consciousness, undefined);
      return response({ perceptions: [] });
    };
    await runtime.evolve("检查房间周围的变化");
    assert.equal(await store.exportJournal(), legacy, "unknown legacy state is not guessed from sleep words, clock or a quiet heartbeat");

    const published: unknown[] = [];
    const unsubscribe = store.subscribe(event => {
      if (event.topic !== "world.committed") return;
      const state = store.snapshot().actors.bot!.consciousness;
      const row = JSON.parse(readFileSync(files.narrativeJournal, "utf8").trim().split("\n").at(-1)!);
      if (row.commit.actors?.bot?.consciousness !== undefined) assert.equal(row.commit.actors.bot.consciousness, state);
      published.push(state);
    });
    let sawBeginning = false;
    handler = async messages => {
      const input = JSON.parse(String(messages[1]!.content));
      if (input.actionPhase === "start") return response({ actorStates: [{ actorId: "bot", state: "躺在床上进入睡眠，呼吸平稳。", consciousness: "asleep" }],
        outcome: { status: "ongoing" }, perceptions: [{ actorId: "bot", text: "你闭上眼，意识逐渐沉入睡眠。" }] });
      assert.equal(input.actors[0].consciousness, "asleep");
      return response({ actorStates: [{ actorId: "bot", state: "已睡过一段时间，自然醒来，仍躺在床上。", consciousness: "awake" }],
        outcome: { status: "completed" }, perceptions: [{ actorId: "bot", text: "你从这一觉中醒来，感到被子贴着肩膀。" }] });
    };
    await runtime.act("bot", call("sleep", "好好睡一会儿", now, 20), () => {
      if (store.snapshot().actions["bot:sleep"]!.status === "pending") {
        assert.equal(store.snapshot().actors.bot!.consciousness, "asleep"); sawBeginning = true; now = 20;
      }
    });
    assert.ok(sawBeginning, "sleep is published before waiting for its real duration");
    assert.equal(store.snapshot().actors.bot!.consciousness, "awake");
    assert.equal(store.snapshot().actions["bot:sleep"]!.status, "completed");
    assert.ok(published.includes("asleep") && published.includes("awake"));

    now = 21;
    handler = async () => response({ actorStates: [{ actorId: "bot", state: "已经睡着，呼吸平缓。", consciousness: "asleep" }], outcome: { status: "completed" }, perceptions: [{ actorId: "bot", text: "你合眼入睡，外界渐渐远去。" }] });
    await runtime.act("bot", call("doze", "上床入睡", now), () => {});
    assert.equal(store.snapshot().actors.bot!.consciousness, "asleep");
    now = 1000;
    handler = async messages => {
      const input = JSON.parse(String(messages[1]!.content));
      assert.equal(input.actors[0].consciousness, "asleep"); assert.equal(input.pendingActions.length, 0);
      return response({ externalChanges: [{ id: "sleep-finished", description: "这段已经开始的睡眠经过了足够时间，身体自然结束这一轮睡眠。" }],
        actorEffects: [{ actorId: "bot", state: "睡眠自然结束，清醒地躺在床上。", consciousness: "awake", changeIds: ["sleep-finished"] }],
        perceptions: [{ actorId: "bot", text: "你醒来，眼前仍是卧室熟悉的天花板。", changeIds: ["sleep-finished"] }] });
    };
    await runtime.evolve("承接已开始的睡眠与周围环境");
    assert.equal(store.snapshot().actors.bot!.consciousness, "awake", "a sourced natural waking is a bodily effect, not an autonomous decision");

    handler = async () => response({ actorStates: [{ actorId: "bot", state: "坐在床沿伸了伸腿。" }], outcome: { status: "completed" }, perceptions: [{ actorId: "bot", text: "脚掌踩在地板上。" }] });
    now++;
    await runtime.act("bot", call("sit", "坐到床沿", now), () => {});
    assert.equal(store.snapshot().actors.bot!.consciousness, "awake", "omission preserves the previously committed value");
    const current = await store.exportJournal(), before = inferred;
    handler = async () => response({ actorStates: [{ actorId: "bot", state: "看着床头，突然睡着。", consciousness: "asleep" }], perceptions: [{ actorId: "bot", text: "床头有个木盒。" }] });
    await assert.rejects(runtime.observe("bot", { intent: "看看床头" }), /CONSCIOUSNESS_AUTHORITY/);
    assert.equal(inferred - before, 3); assert.equal(await store.exportJournal(), current, "invalid observation cannot change consciousness or publish its draft");
    handler = async () => response({ actorEffects: [{ actorId: "bot", state: "失去意识。", consciousness: "unconscious", changeIds: ["made-up"] }],
      externalChanges: [{ id: "wind", description: "窗外一阵微风吹过。" }], perceptions: [] });
    await assert.rejects(runtime.evolve("环境变化"), /EVOLUTION_REFERENCE_UNKNOWN/);
    assert.equal(await store.exportJournal(), current);
    handler = async () => response({ actorEffects: [{ actorId: "bot", state: "被落下的木架击中，失去意识。", consciousness: "unconscious", changeIds: ["impact"] }],
      externalChanges: [{ id: "impact", description: "墙上松动的木架坠落，击中小澈头部。" }], perceptions: [{ actorId: "bot", text: "木架砸下来，眼前一黑。", changeIds: ["impact"] }] });
    await runtime.evolve("木架松动坠落");
    assert.equal(store.snapshot().actors.bot!.consciousness, "unconscious");
    await runtime.restorePhoneAccess("device-only");
    assert.equal(store.snapshot().actors.bot!.consciousness, "unconscious", "phone restoration must not wake or heal the character");
    const replay = await NarrativeStore.open(base, { now: () => now });
    assert.equal(replay.snapshot().actors.bot!.consciousness, "unconscious");
    unsubscribe();
    console.log("PASS explicit World consciousness: unknown legacy, durable sleep start/finish, natural waking, omission, invalid observe/cause rejection, phone independence and replay");
  } finally { await runtime.shutdown(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
