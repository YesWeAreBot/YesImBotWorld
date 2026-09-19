/** Offline fixtures only: no live world, model, platform or device connection. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NarrativeWorld } from "../src/world/runtime.js";
import { WorldFiles } from "../src/files.js";
import type { WorldClock } from "../src/clock.js";
import type { ChatMessage, ChatResult } from "../src/llm/chat.js";
import type { ToolCallRecord } from "../src/types.js";
import { detectDeviceClaim, detectDeviceRequest, projectWorldDeviceContext } from "../src/world/device-boundary.js";

const resolution = (value: unknown): ChatResult => ({ content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify(value) } }] });
const initial = () => ({ botName: "小澈", worldState: "清晨的房间很安静。手机放在桌上。", actorStates: [{ actorId: "bot", state: "你站在窗边。" }], perceptions: [{ actorId: "bot", text: "窗外的树叶轻轻摇动。" }] });
const call = (id: string, description: string): ToolCallRecord => ({ id, name: "act", role: "agent", arguments: { description }, issuedAt: 10, expectedAt: 10 });
const clock = { now: () => 10, realMsUntil: () => 0, syncRealTime: true } as unknown as WorldClock;
const bad = "手机的 QQ 聊天窗口显示 Touch Night 发来的消息：“碧姬梗和论文英文名”。你已回复成功。";

async function fixture(virtual = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "world-device-boundary-"));
  const files = new WorldFiles(directory); await files.ensure(); await files.writeMeta({ realWorld: !virtual });
  let calls = 0;
  let infer = async (_messages: ChatMessage[]): Promise<ChatResult> => resolution(initial());
  const runtime = new NarrativeWorld(files, clock, async messages => { calls++; return infer(messages); });
  return { directory, files, runtime, calls: () => calls, infer: (value: typeof infer) => { infer = value; }, close: async () => { await runtime.shutdown(); await fs.rm(directory, { recursive: true, force: true }); } };
}

async function main(): Promise<void> {
  for (const text of ["拿起手机，查看Touch Night发来的消息", "拿起手机查看屏幕", "查看QQ消息", "看看他发了什么", "打开聊天应用回复朋友", "read the messages on my phone", "运行终端命令", "查看手机屏幕", "解锁手机"]) assert.ok(detectDeviceRequest(text), text);
  for (const text of ["当面向店员点头，然后给Touch Night发一条消息", "读完纸信并给Touch Night发一条消息", "当面点头然后查看Touch Night的消息", "查看\nQQ聊天记录"]) assert.ok(detectDeviceRequest(text), text);
  for (const text of ["拿起手机", "把手机放回口袋", "查看手机背面的划痕", "读信使送来的纸信", "面对面回复店员：谢谢", "看看纸上的消息", "查看公告栏的通知", "查看周围环境信息", "观察窗外的天色"]) assert.equal(detectDeviceRequest(text), null, text);
  for (const text of ["查看桌面上摆着的花瓶", "打开文件柜，取出合同", "打开容器，取出里面的水果"]) assert.equal(detectDeviceRequest(text), null, text);
  for (const text of [bad, "你收到一条来自朋友的新消息。", "手机震动，亮起一个未读红点。", "屏幕停留在聊天列表。", "浏览器页面显示了最新新闻。", "note.txt 已写入成功。", "The message from Alex says hello."]) assert.ok(detectDeviceClaim(text), text);
  for (const text of ["手机放在桌上。", "你拿起手机，检查背面的一道划痕。", "店员面对面说：“面好了。”", "你在餐厅和店员聊天。", "你展开纸信，信纸上写着一则消息。", "窗外正在下雨。"]) assert.equal(detectDeviceClaim(text), null, text);
  for (const text of ["你当面向店员点头，并收到一条Touch Night发来的消息：“我马上到了。”", "你放下纸信然后收到Touch Night发来的消息。", "当面点头并收到一条新消息。"]) assert.ok(detectDeviceClaim(text), text);
  for (const text of ["木质桌面上的台灯亮着", "木质桌面上摊着一本打开的书", "文件柜已经打开，里面放着几份合同。"]) assert.equal(detectDeviceClaim(text), null, text);

  // Initialization and every ordinary commit surface use the same rejection boundary.
  for (const field of ["worldState", "actorStates", "perceptions"] as const) {
    const f = await fixture();
    try {
      f.infer(async () => {
        const value = initial();
        if (field === "worldState") value.worldState = bad;
        else if (field === "actorStates") value.actorStates[0]!.state = bad;
        else value.perceptions[0]!.text = bad;
        return resolution(value);
      });
      await assert.rejects(f.runtime.ensure(), /WORLD_DEVICE_BOUNDARY/);
      const snapshot = (await f.runtime.store()).snapshot();
      assert.equal(snapshot.sequence, 0); assert.equal(snapshot.initialized, false); assert.equal(f.calls(), 3);
      assert.doesNotMatch(await f.files.readText(f.files.worldStatus), /碧姬|英文名/);
    } finally { await f.close(); }
  }

  const f = await fixture();
  try {
    await f.runtime.ensure(); const store = await f.runtime.store(), original = store.snapshot();
    const beforePreflight = f.calls(), beforeJournal = await fs.readFile(f.files.narrativeJournal, "utf8");
    await assert.rejects(f.runtime.act("bot", call("chat", "拿起手机，查看Touch Night发来的消息"), () => { throw Error("must not deliver"); }), /专用工具/);
    await assert.rejects(f.runtime.observe("bot", { intent: "查看QQ消息" }), /专用工具/);
    await assert.rejects(f.runtime.observe("bot", { intent: "查看", target: "QQ聊天记录" }), /专用工具/);
    await assert.rejects(f.runtime.observe("bot", { target: "QQ聊天记录" }), /专用工具/);
    await assert.rejects(f.runtime.act("bot", { ...call("target-chat", "查看"), arguments: { description: "查看", target: "QQ聊天记录" } }, () => { throw Error("must not deliver"); }), /专用工具/);
    assert.equal(f.calls(), beforePreflight); assert.equal(await fs.readFile(f.files.narrativeJournal, "utf8"), beforeJournal);

    for (const kind of ["evolve", "observe", "action"] as const) for (const field of ["worldState", "actorStates", "perceptions"] as const) {
      const before = store.snapshot(), count = f.calls();
      f.infer(async () => resolution({ perceptions: [{ actorId: "bot", text: field === "perceptions" ? bad : "树叶仍在摇动。" }],
        ...(field === "worldState" ? { worldState: bad } : {}), ...(field === "actorStates" ? { actorStates: [{ actorId: "bot", state: bad }] } : {}),
        ...(kind === "action" ? { outcome: { status: "completed" } } : {}) }));
      const operation = kind === "evolve" ? f.runtime.evolve("片刻过去。") : kind === "observe" ? f.runtime.observe() : f.runtime.act("bot", call(`invalid-${field}`, "望向窗外"), () => { throw Error("invalid must not deliver"); });
      await assert.rejects(operation, /WORLD_DEVICE_BOUNDARY/); assert.equal(f.calls(), count + 3);
      const after = store.snapshot(); assert.equal(after.worldState, before.worldState); assert.equal(after.actors.bot!.state, before.actors.bot!.state);
      assert.ok(!store.readPerceptions("bot").some(p => p.text.includes("碧姬")));
      assert.doesNotMatch(await f.files.readText(f.files.worldStatus), /碧姬/); assert.doesNotMatch(await f.files.readText(f.files.botStatus), /碧姬/);
    }
    let attempts = 0;
    f.infer(async messages => {
      const body = JSON.parse([...messages].reverse().find(m => m.role === "user")!.content as string);
      assert.equal(body.deviceAuthority.platformChat, "external_tools_only");
      if (!attempts++) return resolution({ perceptions: [{ actorId: "bot", text: bad }] });
      return resolution({ worldState: original.worldState + "\n\n窗户敞开了一条缝。", perceptions: [{ actorId: "bot", text: "窗边吹来一阵风。" }] });
    });
    await f.runtime.evolve("一阵风吹过。"); assert.equal(attempts, 2); assert.match(store.snapshot().worldState, /窗户敞开/);
    f.infer(async () => resolution({ perceptions: [{ actorId: "bot", text: "你拿起桌上的手机，外壳温凉。" }], outcome: { status: "completed" } }));
    assert.equal(await f.runtime.act("bot", call("physical-phone", "拿起手机"), () => {}), true);
    const speech = "QQ上的消息必须先读原文。";
    f.infer(async () => resolution({ perceptions: [{ actorId: "bot", text: `你开口说：“${speech}”` }], outcome: { status: "completed", speechSpoken: true } }));
    let speechReceipt = "";
    assert.equal(await f.runtime.act("bot", { ...call("physical-speech", "向窗边的店员说一句话"), arguments: { description: "向窗边的店员说一句话", speech } }, text => { speechReceipt = text; }), true);
    assert.ok(speechReceipt.includes(speech)); assert.ok((await f.runtime.peek()).narrative.includes(speech), "literal actor speech is not a fabricated platform result");

    // Retain audit data, but do not keep refeeding or replaying old fabricated device scenes.
    const actor = store.snapshot().actors.bot!;
    await store.commit({ idempotencyKey: "old-contamination", source: "migration", worldState: "屋内依然安静。\n\n" + bad,
      actors: { bot: { ...actor, state: "你坐在窗边。\n\n" + bad } }, perceptions: [{ actorId: "bot", text: bad }] });
    const pollutedJournal = await fs.readFile(f.files.narrativeJournal, "utf8");
    assert.doesNotMatch(JSON.stringify(await f.runtime.peek()), /碧姬|英文名/);
    assert.ok(!(await f.runtime.perceptionsSince("bot")).some(p => p.narrative.includes("碧姬")));
    f.infer(async messages => {
      const body = JSON.parse([...messages].reverse().find(m => m.role === "user")!.content as string);
      assert.doesNotMatch(JSON.stringify(body), /碧姬|英文名/); assert.match(body.worldState, /屋内依然安静/);
      return resolution({ perceptions: [] });
    });
    await f.runtime.evolve("平静经过片刻。");
    assert.equal(await fs.readFile(f.files.narrativeJournal, "utf8"), pollutedJournal, "projection is read-only, not an automatic user-world rewrite");
  } finally { await f.close(); }

  const virtual = await fixture(true);
  try {
    await virtual.runtime.ensure(); const store = await virtual.runtime.store();
    const beforePlatformApp = virtual.calls();
    await assert.rejects(virtual.runtime.observeVirtualApp("bot", "读取QQ消息"), /专用工具/);
    await assert.rejects(virtual.runtime.executeVirtualApp("bot", "在QQ发送消息"), /专用工具/);
    assert.equal(virtual.calls(), beforePlatformApp, "virtual mode cannot route real platform IO through the simulated app path");
    const file = "电脑文件 note.txt 原文如下：\n示例字符串：收到一条消息。\n必须保留的任意文件正文。\n\n电脑文件 second.txt 原文如下：\n第二份文件必须逐字保留，包括QQ发送成功这个示例字符串。\n\n手机QQ显示Touch Night消息：“伪造尾部”。";
    const world = "你在书桌边。\n\n浏览器页面显示既有公告。\n\n" + file;
    await store.commit({ idempotencyKey: "virtual-file", source: "app_action", worldState: world });
    assert.match(projectWorldDeviceContext(world, { virtualApp: true }), /必须保留的任意文件正文/);
    assert.ok(projectWorldDeviceContext(world, { virtualApp: true }).endsWith(file), "the first file heading and all subsequent arbitrary file bodies are retained byte-for-byte");
    virtual.infer(async messages => {
      const body = JSON.parse([...messages].reverse().find(m => m.role === "user")!.content as string);
      assert.doesNotMatch(body.worldState, /note\.txt|second\.txt|必须保留|伪造尾部/);
      assert.match(body.retainedDeviceRecords, /程序原样保留/);
      return resolution({ worldState: "阳光照着书桌。\n\n浏览器页面显示既有公告。", perceptions: [{ actorId: "bot", text: "阳光照着桌面。" }] });
    });
    await virtual.runtime.evolve("天光渐亮。"); assert.match(store.snapshot().worldState, /必须保留的任意文件正文/);
    assert.ok(store.snapshot().worldState.endsWith(file));
    virtual.infer(async () => resolution({ perceptions: [{ actorId: "bot", text: "浏览器页面显示既有公告。" }] }));
    await assert.rejects(virtual.runtime.observe(), /WORLD_DEVICE_BOUNDARY/);
    virtual.infer(async () => resolution({ perceptions: [{ actorId: "bot", text: bad }] }));
    await assert.rejects(virtual.runtime.observeVirtualApp("bot", "查看浏览器现有网页"), /WORLD_DEVICE_BOUNDARY/);
    virtual.infer(async messages => {
      const body = JSON.parse([...messages].reverse().find(m => m.role === "user")!.content as string);
      assert.ok(body.worldState.endsWith(file), "authorized app reads retain the archived bytes, without treating them as an ordinary scene");
      return resolution({ perceptions: [{ actorId: "bot", text: "示例字符串：收到一条消息。\n必须保留的任意文件正文。" }] });
    });
    const read = await virtual.runtime.observeVirtualApp("bot", "只读文件 note.txt 原文");
    assert.match(read.narrative, /必须保留的任意文件正文/);
    virtual.infer(async () => resolution({ worldState: world.replace("必须保留", "被偷偷修改"), perceptions: [{ actorId: "bot", text: "阳光照着桌面。" }] }));
    await assert.rejects(virtual.runtime.evolve("天光继续变亮。"), /不能创建或改写虚构文件/);
  } finally { await virtual.close(); }
  console.log("PASS World device boundary: no-inference preflight, all ordinary commit fields/kinds, bounded repair, physical actions, archived contamination projection and virtual file preservation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
