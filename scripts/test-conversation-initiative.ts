import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { conversationMaterialReminder, CONVERSATION_MATERIAL_PREFIX } from "../src/bot/conversation-material.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { WorldFiles } from "../src/files.js";
import { COMPRESSION_SOURCE_GUIDANCE, CONVERSATION_INITIATIVE_GUIDANCE, INITIATIVE_GUIDANCE, Prompts, WORLD_PROMPT_DEFAULTS } from "../src/prompts.js";
import type { BotEvent, StreamEntry, ToolCallRecord } from "../src/types.js";

const entry = (event: BotEvent): StreamEntry => ({ kind: "event", event });
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallRecord => ({ id, role: "agent", name, arguments: args, issuedAt: 1, expectedAt: 1 });
const operation = (id: string, name: string, args?: Record<string, unknown>): StreamEntry => ({ kind: "tool_call", call: call(id, name, args) });
function physical(id: string, text: string, status = "completed"): BotEvent {
  return { id, source: "tool", refToolCallId: `act-${id}`, worldTime: 2, originEventIds: [`scene-${id}`],
    experience: { agency: "self", outcome: status === "completed" ? "completed" : "unknown", worldPerception: true },
    content: JSON.stringify({ action: { id: `bot:act-${id}`, status, intent: "意图不是事实：准备去月亮上", }, observation: {
      mode: "narrative", actorId: "bot", observationId: `scene-${id}`, sourceEventIds: [`scene-${id}`], narrative: text,
      scene: { eventId: `scene-${id}`, worldTime: 1.5, text, opportunities: [{ label: "不要复述的候选", intent: "明天拿冠军" }] },
    }, worldState: "不应泄露的后台秘密", actorStates: { stranger: "不应知道的他人状态" } }),
  };
}
const experience = (id: string, text: string, status?: string): StreamEntry[] => [operation(`act-${id}`, "act"), entry(physical(id, text, status))];
const read = (id = "read"): StreamEntry[] => [operation(`tc-${id}`, "read_channel"), entry({ id, source: "tool", refToolCallId: `tc-${id}`,
  worldTime: 3, content: "甲与乙在群里聊晚饭，并没有 @ 我。", originEventIds: ["chat-message:meal"],
  experience: { agency: "observed", chat: { kind: "attention", channelKey: "mock:group:account" } } })];
const cueCount = (stream: readonly StreamEntry[]) => stream.filter(item => item.kind === "event" && item.event.content.startsWith(CONVERSATION_MATERIAL_PREFIX)).length;

function boundaries() {
  const action = experience("cup", "你把刚烧好的陶杯拿到窗边，杯沿有一处小小的缺口。"), seen = [...action, ...read()];
  const cue = conversationMaterialReminder(seen, 5)!;
  assert.ok(cue); assert.deepEqual(cue.originEventIds, []); assert.equal(cue.source, "system");
  assert.match(cue.content, /陶杯.*缺口/); assert.match(cue.content, /来源 cup.*经历时刻 1\.5 TU.*已完成/);
  assert.doesNotMatch(cue.content, /经历时刻 2 TU/, "delivery time cannot replace when an older action actually happened");
  assert.doesNotMatch(cue.content, /月亮|冠军|后台秘密|他人状态|开心|孤独|"name":"send"/);
  assert.equal(conversationMaterialReminder(action, 5), undefined, "an action alone cannot turn into a chat prompt");
  assert.equal(conversationMaterialReminder(read(), 5), undefined, "chat alone cannot invent a life story");
  assert.equal(conversationMaterialReminder([...seen, entry(cue), ...read("again")], 9), undefined, "a new read does not repeat the same material");
  assert.equal(conversationMaterialReminder([...seen, entry(cue), entry({ ...(action[1] as any).event, id: "copy" }), ...read("copy-read")], 9), undefined);
  assert.equal(conversationMaterialReminder([...seen, entry(cue), ...experience("same-prose-new-root", "你把刚烧好的陶杯拿到窗边，杯沿有一处小小的缺口。"), ...read("no-progress")], 9), undefined, "identical scene projections are not new progress");
  const next = conversationMaterialReminder([...seen, entry(cue), ...experience("painting", "你画了第二幅小画，颜料还没有干。"), ...read("next")], 9)!;
  assert.match(next.content, /第二幅/); assert.doesNotMatch(next.content, /陶杯/);
  const many = [1, 2, 3, 4].flatMap(i => experience(`story-${i}`, `你已经完成第 ${i} 件事情。`));
  const short = conversationMaterialReminder([...many, ...read()], 5)!;
  assert.doesNotMatch(short.content, /第 [12] 件/); assert.match(short.content, /第 3 件.*\n[\s\S]*第 4 件/);
  assert.equal(conversationMaterialReminder([...many, ...read(), entry(short), ...read("more")], 9), undefined, "omitted older material is not drip-fed as a posting backlog");
  assert.equal(conversationMaterialReminder([...seen, operation("sent", "send", { msg: "已经表达过了" })], 5), undefined);
  const send = operation("shared-cup", "send", { id: "mock:group:account", msg: "陶杯烧好了，可惜缺了个小口" });
  assert.equal(conversationMaterialReminder([...action, send, ...read("replies")], 5), undefined,
    "act → send → read cannot re-offer an episode that may already have been shared, even without a previous cue");
  for (const outcome of ["completed", "failed", "unknown"] as const) {
    const receipt = entry({ id: `send-${outcome}`, source: "tool", refToolCallId: "shared-cup", worldTime: 3,
      content: `发送结果 ${outcome}`, experience: { agency: "self", outcome, chat: { kind: "send", channelKey: "mock:other:account" } } });
    assert.equal(conversationMaterialReminder([...action, send, receipt, ...read(`after-${outcome}`)], 5), undefined,
      "failed/unknown sends also retire old suggestions; a different channel cannot turn recall into repeated posting");
    assert.equal(conversationMaterialReminder([...action, receipt, ...read(`receipt-only-${outcome}`)], 5), undefined,
      "a delivered send receipt remains a consumption boundary without its original call in the active window");
  }
  const laterLife = conversationMaterialReminder([...action, send, ...experience("later-walk", "你沿河散步，看见一棵开花的柳树。"), ...read("after-walk")], 9)!;
  assert.match(laterLife.content, /开花的柳树/); assert.doesNotMatch(laterLife.content, /陶杯/,
    "only a newly delivered experience after the send can supply another optional topic");
  assert.equal(conversationMaterialReminder([...seen, operation("close", "close_app"), entry({ id: "closed", source: "tool", worldTime: 4, refToolCallId: "close", content: "已关闭" })], 5), undefined);

  const original = (action[1] as Extract<StreamEntry, { kind: "event" }>).event;
  const undated = JSON.parse(original.content); delete undated.observation.scene.worldTime;
  assert.match(conversationMaterialReminder([action[0]!, entry({ ...original, content: JSON.stringify(undated) }), ...read()], 5)!.content,
    /交付时刻 2 TU（经历时刻未提供）/, "legacy undated experiences are not given a made-up occurrence time");
  const rejected: Partial<BotEvent>[] = [
    { source: "koishi" }, { source: "system" }, { refToolCallId: undefined },
    { experience: { agency: "imposed", worldPerception: true, outcome: "completed" } },
    { experience: { agency: "self", worldPerception: false, outcome: "completed" } },
    { experience: { agency: "self", worldPerception: true, internalThought: true, outcome: "completed" } },
    { experience: { agency: "self", worldPerception: true, outcome: "unknown" } },
    { originEventIds: [] }, { content: "（已受理）" },
    { content: physical("bad", "手机屏幕上显示网友刚发来的消息：今晚聚餐。").content },
    { content: JSON.stringify({ ...JSON.parse(original.content), recovered: true }) },
    { content: JSON.stringify({ ...JSON.parse(original.content), action: { status: "accepted" } }) },
  ];
  for (const override of rejected) assert.equal(conversationMaterialReminder([action[0]!, entry({ ...original, ...override }), ...read()], 5), undefined, JSON.stringify(override));
  for (const name of ["app.browser.read_page", "think", "observe"]) assert.equal(conversationMaterialReminder([
    operation("act-cup", name), entry(original), ...read(),
  ], 5), undefined, `${name} cannot masquerade as a personal physical experience`);
  const forced: ToolCallRecord = { ...call("act-cup", "act"), control: { mode: "puppet", sessionId: "private" } };
  assert.equal(conversationMaterialReminder([{ kind: "tool_call", call: forced }, entry(original), ...read()], 5), undefined);
  const passive = { ...original, source: "world" as const, refToolCallId: undefined };
  assert.equal(conversationMaterialReminder([entry(passive), ...read()], 5), undefined);
  const echo = (read()[1] as Extract<StreamEntry, { kind: "event" }>).event;
  for (const kind of ["attention", "notice", "message", "send"] as const) {
    assert.equal(conversationMaterialReminder([...action, entry({ ...echo, source: "koishi", refToolCallId: undefined, experience: { chat: { ...echo.experience!.chat!, kind } } })], 5), undefined, "automatic echoes/notices/messages cannot start another sharing prompt");
  }
  for (const [status, expected] of [["pending", /尚未结束/], ["needs_input", /后续未执行/], ["failed", /未能完成/]] as const) {
    assert.match(conversationMaterialReminder([...experience(status, "你走到河边，桥头拉着绳子，暂时过不去。", status), ...read()], 5)!.content, expected);
  }
  console.log("PASS conversation material: only delivered self-action progress, bounded sourced excerpts, no hidden world/web/forced actions, durable readback dedup and no notification-triggered posting cues");
}

async function runtime() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-initiative-"));
  let agent: any;
  try {
    const files = new WorldFiles(base); await files.ensure();
    const prompts = await Prompts.load(base);
    prompts.setOverrides({ bot: { constitutionHead: "作者保留的旧开头" }, world: {} });
    const context = new BotContext(files, undefined, prompts); await context.load();
    const prefix = context.renderSystemText("T1");
    const before = await context.toChatMessages("T1");
    // The existing service upgrades this exact notice with append-only content matching.
    await context.appendEvent({ id: context.nextEventId(), source: "system", worldTime: 1, originEventIds: [], content: INITIATIVE_GUIDANCE });
    assert.deepEqual((await context.toChatMessages("T2")).slice(0, before.length), before);
    assert.ok(INITIATIVE_GUIDANCE.includes(CONVERSATION_INITIATIVE_GUIDANCE));
    let worldCalls = 0, reads = 0, sends = 0, generations = 0;
    const resolvedChannels: string[] = [];
    const config = { bot: { baseURL: "http://invalid", model: "fake", nativeToolCalls: false, repeatThresholds: [100], repeatExclude: [], minIntervalMs: 1,
      spillMinChars: 0, breakLoop: false, growth: { enabled: false } }, world: {}, platformOps: {} } as any;
    let time = 2;
    const clock = { now: () => time, timeLine: () => `T${time}`, unitWorldSeconds: 1, realMsUntil: () => 0 } as any;
    const world = { adjudicateAct: async (action: ToolCallRecord, deliver: (text: string) => void) => {
      worldCalls++;
      const data = JSON.parse(physical("bridge", "你走到桥头，发现木桥的一块踏板断了，折回了岸边。").content);
      data.action.id = `bot:${action.id}`;
      await deliver(JSON.stringify(data)); return true;
    } } as any;
    const messenger = { resolveKey: async (id: string) => { resolvedChannels.push(id); return { key: id, isPrivate: false }; },
      channelMessages: async (id: string) => { assert.equal(id, "mock:group:account"); reads++; return { text: "甲：今天食堂有南瓜。乙：我吃面。", originEventIds: ["chat-message:meal"],
      experience: { agency: "observed", chat: { kind: "attention", channelKey: "mock:group:account" } } }; },
      send: async () => { sends++; throw Error("no automatic sending"); } } as any;
    const tools = BOT_TOOLS.filter(tool => ["act", "read_channel", "send"].includes(tool.name));
    const logger = { info() {}, warn() {}, error() {} } as any;
    agent = new BotAgent(config, clock, files, context, world, messenger, null, null, null, { down: false }, logger, tools) as any;
    agent.backend = { generate: async () => { generations++; throw Error("recall must not infer"); }, setToolNames() {}, setToolDefs() {} };
    agent.running = true;
    agent.phoneUi = { chatOpen: true, channelKey: "mock:group:account", channelIsGroup: true, forwardStack: [] };
    agent.attention = "phone"; agent.refreshToolGate();
    async function invoke(name: string, args: Record<string, unknown> = {}) {
      const record = { ...call(context.nextToolId(), name, args), issuedAt: ++time, expectedAt: time };
      await context.appendToolCall(record); await agent.dispatch(record);
      for (let i = 0; i < 200 && agent.scheduler.pendingCount; i++) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(agent.scheduler.pendingCount, 0); await agent.drainMailbox();
    }
    await invoke("act", { description: "走到河边看看桥" });
    assert.equal(worldCalls, 1); assert.equal(cueCount(context.stream), 0);
    const prior = structuredClone(context.stream);
    await invoke("read_channel");
    assert.deepEqual(context.stream.slice(0, prior.length), prior, "the old request/history bytes cannot change to add initiative");
    assert.equal(cueCount(context.stream), 1, "an actual act receipt followed by a voluntary chat read offers sourced material");
    const cue = context.stream.find(item => item.kind === "event" && item.event.content.startsWith(CONVERSATION_MATERIAL_PREFIX))! as Extract<StreamEntry, { kind: "event" }>;
    assert.match(cue.event.content, /踏板断了/);
    assert.ok(!(await agent.growth.recallEvidence({ n: 100 })).some((e: any) => e.eventId === cue.event.id), "the recall cue cannot manufacture a second growth experience");
    await invoke("read_channel");
    assert.equal(cueCount(context.stream), 1); assert.equal(reads, 2);
    assert.deepEqual(resolvedChannels, ["mock:group:account", "mock:group:account"], "reads keep their actual current channel without notification-based fallback");
    assert.equal(sends, 0); assert.equal(generations, 0); assert.equal(worldCalls, 1, "reading and recall add no inference or world action");
    assert.equal(context.renderSystemText("T99"), prefix);
    const restored = new BotContext(files, undefined, prompts); await restored.load();
    assert.equal(conversationMaterialReminder(restored.stream, 10), undefined, "restart retains the same already-considered material");
    assert.equal(restored.renderSystemText("T99"), prefix);
    const snapshot = await context.compressionSnapshot();
    const summary = `事件 ${cue.event.id} 的提示不是新经历；真正原事件记录走到桥头、踏板断了而折回岸边。`;
    await context.applyCompression({ historySummary: summary, memoryDigest: "仍记得断桥处境，未推断情绪" }, time, snapshot);
    assert.equal(conversationMaterialReminder(context.stream, time), undefined, "compression does not reissue an old sharing agenda");
    assert.match(context.renderSystemText("T100"), /踏板断了/);
    assert.match(WORLD_PROMPT_DEFAULTS.compressUser, /亲身经历.*感受、疑问.*聊天待办/);
    assert.match(COMPRESSION_SOURCE_GUIDANCE, /主观想法与亲历分开/);
    assert.match(COMPRESSION_SOURCE_GUIDANCE, /谈话素材提示.*不是新经历、分享任务/);
    console.log("PASS Bot act→chat read integrates optional personal recall without inference, messages, new evidence or cached-prefix mutation; restart and compaction retain provenance");
  } finally { if (agent) await agent.stop(); await fs.rm(base, { recursive: true, force: true }); }
}
boundaries(); runtime().catch(error => { console.error(error); process.exitCode = 1; });
