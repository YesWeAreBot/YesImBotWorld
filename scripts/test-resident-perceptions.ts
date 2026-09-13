/** Durable role perception -> authorized resident SSE. No LLM, world mutation or chat service. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppManager } from "../src/apps/manager.js";
import { BotAgent, type BotPerception } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { CrossingServer } from "../src/crossing/server.js";
import { WorldFiles } from "../src/files.js";
import { WorldService } from "../src/service.js";

const logger: any = { info() {}, warn() {}, debug() {}, error() {} };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };

async function fixture(dir: string) {
  const files = new WorldFiles(dir); await files.ensure();
  const cfg = Config({ autoStart: false });
  let now = 10, observed = 0;
  const clock: any = { now: () => now, timeLine: (n = now) => `TU=${n}`, unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: () => 0 };
  const world: any = { residentBotName: "resident", observe: async () => { observed++; throw new Error("mirror cannot observe"); },
    structured: new Proxy({}, { get: () => { throw new Error("mirror cannot read world state/journal"); } }), notePresenceChange() {}, setVisitorsProvider() {} };
  const defs = BOT_TOOLS.filter(tool => ["observe", "act", "reflect", "recall_growth", "wait", "rest", "cancel"].includes(tool.name));
  const apps = new AppManager("chat", [], new Set(defs.map(tool => tool.name)), logger);
  const context = new BotContext(files, "");
  const bot: any = new BotAgent(cfg, clock, files, context, world, {} as never, apps, null, null, { down: false }, logger, defs);
  bot.running = true; bot.backend = { setToolNames() {}, setToolDefs() {} }; bot.refreshToolGate();
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { bot, clock, world, config: cfg, worldActive: true, deviceTail: Promise.resolve(), devicePending: 0,
    appManager: apps, computerDevice: null, remoteDesktopApp: null, residentSession: null, residentTransition: false });
  const cross: any = new CrossingServer({ cfg: cfg.crossing, logger, clock: () => clock, ready: () => service.worldActive && !!service.bot,
    world, notifyHostBot: () => { throw new Error("resident mirror must not impersonate a new visitor"); },
    subscribeResidentPerceptions: (id, deliver) => service.subscribeResidentPerceptions(id, deliver),
    releaseResidentControl: async id => { await bot.releaseResidentControl(id, true); if (service.residentSession?.id === id) service.residentSession = null; } });
  service.crossingServer = cross;
  async function connect(token: string, cursor?: string, header = false) {
    const req: any = new EventEmitter(); req.method = "GET";
    req.url = `/crossing/events?token=${token}${cursor && !header ? `&lastEventId=${cursor}` : ""}`;
    req.headers = cursor && header ? { "last-event-id": cursor } : {};
    let output = "", status = 0, fail = false, ended = false;
    const res: any = { writeHead(n: number) { status = n; }, write(data: string) { if (fail) throw new Error("broken transport"); output += data; },
      end(data = "") { output += data; ended = true; } };
    await cross.handle(req, res);
    return { req, res, status, breakWrites() { fail = true; }, close() { req.emit("close"); }, ended: () => ended,
      text: () => output, messages: () => output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))),
      events: () => output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).filter(event => event.eventId) };
  }
  const emit = async (content: string, source: "world" | "tool" | "system" = "world", ref?: string) => {
    now++; bot.pushEvent(source, content, { ref }); await bot.drainMailbox();
  };
  const arrive = (mode: "avatar" | "puppet") => { const result = cross.arrivePlayer("resident", "", mode); assert.ok(result.ok); return result.token; };
  return { bot, files, context, service, cross, connect, emit, arrive, observed: () => observed,
    async close() { await cross.disconnectVisitors("test complete"); await bot.stop(); } };
}

async function durableBoundary(dir: string) {
  const f = await fixture(dir);
  try {
    const seen: BotPerception[] = [];
    f.bot.subscribePerceptions((item: BotPerception) => { item.event.content = "mutated"; throw new Error("bad observer"); }, 0);
    f.bot.subscribePerceptions(async () => { throw new Error("rejected observer"); }, 0);
    f.bot.subscribePerceptions((item: BotPerception) => seen.push(item), 0);
    const append = f.context.appendEvent.bind(f.context);
    let fail = true;
    f.context.appendEvent = async event => { if (fail) throw new Error("disk unavailable"); await append(event); };
    f.bot.pushEvent("world", "actual visible sensation");
    await assert.rejects(f.bot.drainMailbox(), /disk unavailable/);
    assert.equal(seen.length, 0, "queued/failed appends are not public perceptions");
    const eventId = f.bot.mailbox[0].event.id;
    fail = false; await f.bot.drainMailbox(); await tick();
    assert.equal(seen.length, 1); assert.equal(seen[0].event.id, eventId);
    assert.equal(seen[0].event.content, "actual visible sensation");
    assert.equal(f.context.stream.find((entry: any) => entry.event?.id === eventId)?.kind, "event");
    assert.ok(JSON.stringify(f.context.stream).includes("actual visible sensation"));
    assert.ok(!JSON.stringify(f.context.stream).includes("mutated"));

    const perceive = f.bot.growth.perceive.bind(f.bot.growth); let growthFail = true;
    f.bot.growth.perceive = async (...args: any[]) => { if (growthFail) throw new Error("growth unavailable"); return perceive(...args); };
    f.bot.pushEvent("world", "durable even while growth catches up");
    await assert.rejects(f.bot.drainMailbox(), /growth unavailable/);
    assert.equal(seen.length, 2, "successful context append is the publication boundary");
    growthFail = false; await f.bot.drainMailbox();
    assert.equal(seen.length, 2, "growth checkpoint retry cannot publish the durable ID again");

    await f.bot.receipts.save("late actual receipt", 14, "tc_recovered"); await f.bot.drainMailbox();
    assert.equal(seen.at(-1)?.event.refToolCallId, "tc_recovered");
    const attachment = { id: 1, type: "image", file: "/private/media/file.png", mime: "image/png" };
    f.bot.pushEvent("tool", { text: "media:1 actual label", attachments: [attachment] }); await f.bot.drainMailbox();
    assert.ok(!JSON.stringify(seen).includes("/private/media"), "mirror exports no local files or attachment bytes");
    const cursor = f.bot.perceptionCursor(), replay: BotPerception[] = [];
    const unsubscribe = f.bot.subscribePerceptions((item: BotPerception) => replay.push(item), cursor);
    unsubscribe(); await f.emit("after unsubscribe"); assert.equal(replay.length, 0);
    const gateWrite = gate(), started = gate();
    f.context.appendEvent = async event => { started.resolve(); await gateWrite.promise; await append(event); };
    f.bot.pushEvent("world", "committed after stopping"); const draining = f.bot.drainMailbox(); await started.promise;
    const beforeStop = seen.length, stop = f.bot.stop();
    assert.equal(f.bot.perceptionListeners.size, 0, "stop detaches observers before awaiting durable work");
    gateWrite.resolve(); await draining; await stop; assert.equal(seen.length, beforeStop);
  } finally { await f.close(); }
}

async function roleDelivery(dir: string, mode: "avatar" | "puppet") {
  const f = await fixture(dir);
  try {
    await f.emit("private history before control");
    const token = f.arrive(mode);
    const premature = await f.connect(token); assert.equal(f.bot.perceptionListeners.size, 0, "arriving alone is not role authorization");
    assert.equal((await f.service.acquirePlayerControl(token)).ok, true);
    assert.equal(f.bot.perceptionListeners.size, 1, "an already connected transport attaches when acquisition succeeds");
    await f.bot.drainMailbox();
    assert.ok(!premature.text().includes("private history before control"));
    const scene = { eventId: "scene-8", actorId: "bot", actionId: "bot:tc_action", worldSequence: 8, worldTime: 20,
      sourceEventIds: ["world-source-8"], text: "你推开门，店员抬起头向你打招呼。" };
    await f.emit(JSON.stringify({ scene }), "world", "tc_action");
    let event = premature.events().at(-1);
    assert.equal(event.content, JSON.stringify({ scene })); assert.equal(event.actorId, "bot");
    assert.equal(event.source, "world"); assert.equal(event.refToolCallId, "tc_action"); assert.equal(event.actionId, "bot:tc_action");
    assert.deepEqual(event.sourceEventIds, ["world-source-8"]); assert.equal(event.timeLine, `TU=${event.worldTime}`);
    assert.ok(premature.text().includes(`id: ${event.eventId}\n`));
    assert.ok(!premature.text().includes(token), "bearer token is never mirrored");

    if (mode === "puppet") {
      f.bot.puppetCalls.add("tc_body");
      await f.emit(JSON.stringify({ observation: { actorId: "bot", observationId: "obs-9", worldSequence: 9, sourceEventIds: ["world-source-9"],
        experiences: [{ eventId: "world-source-9", correlationId: "bot:tc_body", text: "你的手不由自主地抬了起来。" }] } }), "tool", "tc_body");
      event = premature.events().at(-1);
      assert.match(event.content, /非你自主选择的行动[^\n]+\n\{/); assert.equal(event.actorId, "bot");
      assert.equal(event.refToolCallId, "tc_body");
      assert.equal(f.context.stream.some((entry: any) => entry.kind === "tool_call" && entry.call.id === "tc_body"), false);
      await f.emit("我明明没想举手，身体怎么自己动了？", "tool", "tc_consciousness");
      assert.match(premature.events().at(-1).content, /身体怎么自己动/);
    }
    f.bot.stealthCalls.add("tc_hidden"); const count = premature.events().length;
    await f.emit("hidden device operation must remain unperceived", "tool", "tc_hidden");
    f.bot.deviceExecution.run({ stealth: true }, () => f.bot.pushEvent("system", "hidden validation error")); await f.bot.drainMailbox();
    assert.equal(premature.events().length, count, "stealth content excluded from the Bot is also excluded from the cockpit");
    await f.emit("手机震动了一下。"); assert.match(premature.events().at(-1).content, /手机震动/);

    const last = premature.events().at(-1).eventId;
    premature.close(); assert.equal(f.bot.perceptionListeners.size, 0);
    await f.emit("offline NPC response"); assert.ok(!premature.text().includes("offline NPC response"));
    const reconnect = await f.connect(token, last);
    assert.deepEqual(reconnect.events().map((item: any) => item.content), ["offline NPC response"]);
    assert.equal(f.bot.perceptionListeners.size, 1);
    const again = await f.connect(token, reconnect.events().at(-1).eventId, true);
    assert.equal(reconnect.ended(), true); assert.equal(again.events().length, 0);
    reconnect.close(); assert.equal(f.bot.perceptionListeners.size, 1, "stale request close cannot detach the new subscription");
    await f.emit("new connected event"); assert.equal(again.events().length, 1);
    const eventIds = new Set(again.events().map((item: any) => item.eventId));
    f.cross.refreshResidentPerceptions(token); assert.equal(again.events().length, eventIds.size, "subscriber reattachment does not duplicate existing events");
    const bad = await f.connect("wrong-token"); assert.equal(bad.status, 403); assert.equal(bad.events().length, 0);

    again.breakWrites(); await f.emit("transport failure cannot break context append");
    assert.equal(f.bot.perceptionListeners.size, 0); assert.equal(f.bot.mailbox.length, 0);
    const recovered = await f.connect(token, [...eventIds].at(-1));
    assert.ok(recovered.events().some((item: any) => item.content === "transport failure cannot break context append"));
    assert.equal(new Set(recovered.events().map((item: any) => item.eventId)).size, recovered.events().length, "failed writes do not duplicate outbox/replay delivery");
    const oldDeliveries = recovered.events().length;
    const oldBot = f.service.bot; f.service.bot = { ...oldBot };
    await f.emit("late old-world result"); assert.equal(recovered.events().length, oldDeliveries, "exact Bot instance fences switched worlds");
    f.service.bot = oldBot;
    assert.equal((await f.service.releasePlayerControl(token)).ok, true); assert.equal(f.bot.perceptionListeners.size, 0);
    await f.emit("after returning the role"); assert.equal(recovered.events().length, oldDeliveries);
    assert.equal(f.observed(), 0, "SSE must never call observe or consume its cursor");
  } finally { await f.close(); }
}

async function worldStop(dir: string) {
  const f = await fixture(dir);
  try {
    const token = f.arrive("avatar"); await f.service.acquirePlayerControl(token); const connection = await f.connect(token);
    await f.bot.drainMailbox(); const count = connection.events().length;
    f.service.worldActive = false; await f.emit("late scene after world stop"); assert.equal(connection.events().length, count);
    const disconnecting = f.cross.disconnectVisitors("world switched");
    assert.equal(f.bot.perceptionListeners.size, 0, "disconnect synchronously cancels role subscriptions before asynchronous cleanup");
    await disconnecting; assert.equal((await f.connect(token)).status, 403);
  } finally { await f.close(); }
}

async function subscriberFailure(dir: string) {
  const f = await fixture(dir);
  try {
    const token = f.arrive("avatar");
    const subscribe = f.cross.host.subscribeResidentPerceptions;
    f.cross.host.subscribeResidentPerceptions = () => { throw new Error("display subscription unavailable"); };
    const connection = await f.connect(token);
    assert.equal((await f.service.acquirePlayerControl(token)).ok, true, "display subscription errors do not undo an authorized acquisition");
    await f.emit("durable while viewer unavailable");
    f.cross.host.subscribeResidentPerceptions = subscribe; f.cross.refreshResidentPerceptions(token);
    assert.ok(connection.events().some((event: any) => event.content === "durable while viewer unavailable"));
    for (let i = 0; i < 300; i++) await f.emit(`bounded perception ${i}`);
    assert.equal(f.bot.deliveredPerceptions.length, 256);
    assert.equal(f.cross.sessions.get(token).perceptionReplay.size, 256);
    connection.close();
    const replay = await f.connect(token, "ev_missing_old_cursor");
    assert.equal(replay.events().length, 256, "an expired cursor replays only the retained authorized interval");
    assert.equal(new Set(replay.events().map((event: any) => event.eventId)).size, 256);
  } finally { await f.close(); }
}

async function inlineSceneOrigins(dir: string) {
  const f = await fixture(dir);
  try {
    const expected = new Set<string>();
    for (const layout of ["nested", "top-level", "puppet"]) {
      const observation = { observationId: `obs-${layout}`, actorId: "bot", worldSequence: 30, sourceEventIds: [`${layout}-observation-only`, `${layout}-shared`], entities: [] };
      const scene = { eventId: `scene-${layout}`, actorId: "bot", worldSequence: 30, sourceEventIds: [`${layout}-shared`, `${layout}-scene-source`], text: "摘要只选择了部分实际经过。" };
      const payload = layout === "top-level" ? { ...observation, scene } : { observation, scene };
      if (layout === "puppet") f.bot.puppetCalls.add("tc_inline");
      await f.emit(JSON.stringify(payload), "world", layout === "puppet" ? "tc_inline" : undefined);
      const entry = f.context.stream.at(-1)!;
      assert.equal(entry.kind, "event"); if (entry.kind !== "event") throw new Error("missing delivered fixture");
      const roots = [...new Set([...observation.sourceEventIds, ...scene.sourceEventIds])];
      roots.forEach(root => expected.add(root));
      assert.deepEqual(entry.event.originEventIds, roots, `${layout}: the complete observation and derived scene retain the union of original roots`);
      const evidence = await f.bot.growth.recallEvidence({ eventIds: [entry.event.id] });
      assert.deepEqual(evidence[0].rootEventIds, roots, "unselected observation facts remain usable growth evidence");
      assert.ok(!evidence[0].rootEventIds.includes(entry.event.id)); assert.ok(!evidence[0].rootEventIds.includes(scene.eventId));

      await f.emit(JSON.stringify({ scene }));
      await f.emit(JSON.stringify({ scene: { ...scene, eventId: `scene-empty-${layout}`, sourceEventIds: [] } }));
      const last = f.context.stream.at(-1)!;
      assert.equal(last.kind, "event"); if (last.kind !== "event") throw new Error("missing empty derived scene");
      assert.deepEqual(last.event.originEventIds, [], "a source-free reading view cannot fall back to its wrapping Bot event as a new root");
      assert.deepEqual(await f.bot.growth.recallEvidence({ eventIds: [last.event.id] }), []);
    }
    const roots = new Set((await f.bot.growth.recallEvidence({ n: 50 })).flatMap((event: any) => event.rootEventIds));
    assert.deepEqual(roots, expected, "repeated scene-only presentations do not create new root experiences");
  } finally { await f.close(); }
}

async function main() {
const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-role-perceptions-"));
try {
  await durableBoundary(path.join(base, "durable"));
  await roleDelivery(path.join(base, "avatar"), "avatar");
  await roleDelivery(path.join(base, "puppet"), "puppet");
  await worldStop(path.join(base, "stop"));
  await subscriberFailure(path.join(base, "subscriber"));
  await inlineSceneOrigins(path.join(base, "inline-scenes"));
  console.log("PASS durable perception mirror, avatar/puppet agency, stealth, SSE replay and lifecycle boundaries");
} finally { await fs.rm(base, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
