/** Offline authenticated actor-state transport; no sockets, external worlds or LLMs. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { CrossingClient } from "../src/crossing/client.js";
import { CrossingServer } from "../src/crossing/server.js";
import { NarrativeStore } from "../src/world/narrative-store.js";
import { WorldAgent } from "../src/world/agent.js";
import { Config } from "../src/config.js";
import type { NarrativeConsciousness } from "../src/world/consciousness.js";

const logger = { info() {}, warn() {}, debug() {} };
function clientFixture() {
  const events: string[] = [];
  const client = new CrossingClient({ name: "远方", url: "http://fixture.invalid", inviteCode: "offline" } as never,
    { name: "行者", persona: "访客" }, { logger: logger as never, onEvent: text => events.push(text), onLost() {} });
  const internal = client as any; internal.active = true;
  return { client, internal, events };
}
const observation = (actorId: string, worldSequence: number, consciousness: unknown) => JSON.stringify({ mode: "narrative", actorId,
  observationId: `p:${worldSequence}`, worldSequence, sourceEventIds: [`p:${worldSequence}`], narrative: "当时的感知。", consciousness });

async function main() {
  const { client, internal, events } = clientFixture();
  let notifications = 0; client.subscribeConsciousness(() => notifications++);
  internal.receiveMessage({ type: "hello", visitorId: "self", worldName: "远方", timeLine: "T=1" });
  assert.equal(client.consciousness, undefined, "an older host remains unknown");
  internal.receiveMessage({ type: "status_update", content: "你睡着了。" });
  assert.equal(client.consciousness, undefined, "descriptive status is not execution authority");
  internal.receiveMessage({ type: "consciousness", actorId: "visitor:other", worldSequence: 2, consciousness: "asleep" });
  internal.receiveMessage({ type: "consciousness", actorId: "bot", worldSequence: 2, consciousness: "unconscious" });
  internal.receiveMessage({ type: "consciousness", actorId: "visitor:self", worldSequence: 2, consciousness: "sleepy" });
  assert.equal(client.consciousness, undefined);
  internal.receiveMessage({ type: "consciousness", actorId: "visitor:self", worldSequence: 3, consciousness: "asleep" });
  assert.equal(client.consciousness, "asleep");
  internal.receiveMessage({ type: "hello", visitorId: "self", worldName: "远方", timeLine: "T=4",
    consciousnessState: { actorId: "visitor:self", worldSequence: 6, consciousness: "awake" } });
  internal.receiveMessage({ type: "event", eventId: "old-sleep", content: observation("visitor:self", 3, "asleep") });
  assert.equal(client.consciousness, "awake", "reconnect's current state wins over replayed older scenes");
  internal.receiveMessage({ type: "consciousness", actorId: "visitor:self", worldSequence: 6, consciousness: "unconscious" });
  assert.equal(client.consciousness, "awake", "same-sequence conflicting payload does not change authority");
  const task = { delivery: Promise.resolve(), nextIndex: 0, queuedParts: new Map(), deliver: () => assert.equal(client.consciousness, "unconscious") };
  internal.queueTaskPart(task, 0, observation("visitor:self", 7, "unconscious")); await task.delivery;
  assert.equal(client.consciousness, "unconscious", "tool progress carries explicit committed consciousness before delivery");
  assert.equal(notifications, 3);
  internal.active = false;
  internal.receiveMessage({ type: "consciousness", actorId: "visitor:self", worldSequence: 8, consciousness: "awake" });
  assert.equal(client.consciousness, "unconscious", "departed sessions cannot update execution state");

  const world: any = Object.create(WorldAgent.prototype);
  Object.assign(world, { remote: null, routeEpoch: "home", notePresenceChange() {} });
  let local: NarrativeConsciousness = "awake";
  const selected: (NarrativeConsciousness | undefined)[] = [];
  world.onConsciousnessRouteChange = () => selected.push(world.isTravelling ? world.remoteConsciousness : local);
  world.setRemote(client); assert.equal(selected.at(-1), "unconscious");
  const oldHost = { worldName: "旧世界" };
  world.setRemote(oldHost); assert.equal(selected.at(-1), undefined);
  const selectedBeforeStale = selected.length;
  internal.active = true;
  internal.receiveMessage({ type: "consciousness", actorId: "visitor:self", worldSequence: 9, consciousness: "awake" });
  assert.equal(selected.length, selectedBeforeStale, "previous route's update cannot influence a new route");
  local = "asleep"; world.setRemote(null); assert.equal(selected.at(-1), "asleep", "returning home selects local authority immediately");
  assert.equal(events.filter(text => text.includes("当时的感知")).length, 1, "state transport adds no artificial story events");

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-crossing-consciousness-"));
  const store = await NarrativeStore.open(base, { now: () => 10 });
  await store.commit({ idempotencyKey: "seed", source: "initialize", initialized: true, worldState: "屋内安静。",
    actors: { bot: { id: "bot", name: "主人", controller: "bot", present: true, state: "坐在屋内。", perception: "窗外明亮。", consciousness: "awake" } } });
  const cfg = Config({ autoStart: false });
  const hostWorld: any = { runtime: { store: async () => store }, residentBotName: "主人", wakeDormant: async () => {},
    visitorArrive: async (session: any) => {
      const actorId = `visitor:${session.id}`;
      await store.commit({ idempotencyKey: "arrive", source: "administrator", actors: { [actorId]: { id: actorId, name: session.name, controller: "player", present: true, state: "站在门边。", perception: "看见房门。", consciousness: "awake" } } });
      return true;
    }, visitorLeave: async () => true, disconnectVisitor: async () => {}, cancelPending() {}, notePresenceChange() {}, setVisitorsProvider() {} };
  const server: any = new CrossingServer({ cfg: cfg.crossing, logger, world: hostWorld, ready: () => true, clock: () => null, notifyHostBot() {} } as never);
  try {
    const arrival = server.arrivePlayer("行者", "访客"); assert.equal(arrival.ok, true);
    const session = server.sessions.get(arrival.token); await session.ready;
    const remote = clientFixture();
    const frames: any[] = [];
    const connect = () => {
      const request: any = new Readable({ read() {} }); request.headers = {};
      server.handleEvents(new URL(`http://fixture.invalid/crossing/events?token=${arrival.token}`), request,
        { writeHead() {}, end() {}, write(text: string) { for (const line of text.split("\n")) if (line.startsWith("data: ")) { const frame = JSON.parse(line.slice(6)); frames.push(frame); remote.internal.receiveMessage(frame); } } });
      return request;
    };
    const request = connect(); assert.equal(remote.client.consciousness, "awake");
    const actorId = `visitor:${session.id}`;
    const change = async (key: string, consciousness: NarrativeConsciousness, id = actorId) => {
      const actor = store.snapshot().actors[id]!;
      await store.commit({ idempotencyKey: key, source: "administrator", actors: { [id]: { ...actor, consciousness } } });
    };
    await change("sleep", "asleep"); assert.equal(remote.client.consciousness, "asleep");
    assert.equal(store.readPerceptions(actorId).length, 0, "the state frame works even without a perception");
    const count = frames.length;
    await change("host-unconscious", "unconscious", "bot");
    assert.equal(frames.length, count, "local resident or another visitor consciousness is never sent as this visitor's state");
    request.emit("close");
    await change("wake-offline", "awake");
    server.pushEvent(session, observation(actorId, 3, "asleep"));
    connect(); assert.equal(remote.client.consciousness, "awake", "hello state precedes stale perception replay");
    assert.ok(frames.some(frame => frame.type === "hello" && frame.consciousnessState?.consciousness === "awake"));
    server.closeSession(session);
    assert.equal(session.consciousnessUnsubscribe, undefined);
    const closedFrames = frames.length;
    await change("closed", "unconscious"); assert.equal(frames.length, closedFrames);
  } finally { await server.stop(); await fs.rm(base, { recursive: true, force: true }); }
  console.log("PASS crossing consciousness: authenticated visitor scope, durable no-perception updates, current-route selection, legacy unknown, current hello vs replay, tool progress and teardown");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
