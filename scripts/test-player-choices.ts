/** Offline human choice transport: no model, network listener or production state. */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { CrossingServer } from "../src/crossing/server.js";
import { Config } from "../src/config.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await tick(); assert.ok(test()); }
const logger = { info() {}, debug() {}, warn() {} }, cfg = Config({ autoStart: false });
const packets: any[] = [], actions: any[] = [];
let deliverScene: (text: string) => void, actorId: string;
let beforeCommit: ((phase: "start" | "finish") => boolean) | undefined;
let release: (() => void) | undefined;
const world = {
  residentBotName: "resident", wakeDormant: async () => {}, notePresenceChange() {}, setVisitorsProvider() {}, cancelPending() {},
  visitorArrive: async (session: any, deliver: (text: string) => void) => { actorId = `visitor:${session.id}`; deliverScene = deliver; return true; },
  visitorAct: async (_session: any, desc: string, duration: number, _deliver: any, _signal: any, taskId: string, options: any, guard?: typeof beforeCommit) => {
    beforeCommit = guard;
    await new Promise<void>(resolve => { release = resolve; });
    const ok = guard?.("start") ?? true;
    if (ok) actions.push({ desc, duration, taskId, options });
    return ok;
  },
  disconnectVisitor: async () => {}, visitorLeave: async () => true,
};
const server: any = new CrossingServer({ cfg: cfg.crossing, world, logger, ready: () => true, clock: () => ({ unitWorldSeconds: 10, unitRealSeconds: 1, timeLine: () => "T=1" }), notifyHostBot() {} } as never);
server.push = (_session: any, message: any) => packets.push(message);
async function post(body: unknown) {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = "/crossing/task"; req.method = "POST";
  let status = 0, result = "";
  await server.handle(req, { writeHead(code: number) { status = code; }, end(data: unknown) { result = String(data); } });
  return { status, data: JSON.parse(result) };
}
function scene(id: string, sequence: number, intent: string, actor = actorId) {
  deliverScene(JSON.stringify({ observation: { observationId: id, actorId: actor, sourceEventIds: [id], observedAt: sequence, worldSequence: sequence,
    scene: { eventId: id, actorId: actor, worldSequence: sequence, text: "河边有一条小路。", opportunities: [{ label: "探索小路", intent }] } } }));
}
function reconnect(token: string, cursor?: string): any[] {
  const frames: string[] = [], req = new Readable({ read() {} }) as any;
  req.headers = cursor ? { "last-event-id": cursor } : {};
  server.handleEvents(new URL(`http://fixture/crossing/events?token=${token}`), req,
    { writeHead() {}, write(frame: string) { frames.push(frame); }, end() {} });
  return frames.join("").split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
}
async function main() {
  const entry = server.arrivePlayer("visitor", "角色档案"); assert.ok(entry.ok); await tick();
  try {
    scene("scene-1", 1, "走到河边");
    const firstPacket = packets.at(-1), first = firstPacket.opportunities[0]; assert.equal(first.call.arguments.description, "走到河边");
    assert.equal(firstPacket.opportunityRevision, 1);
    const initialResume = reconnect(entry.token, "scene-1");
    assert.equal(initialResume[0].type, "hello"); assert.equal(initialResume[0].opportunityRevision, 1);
    assert.equal(initialResume[0].worldSequence, 1); assert.deepEqual(initialResume[0].opportunities, [first]);
    assert.equal(initialResume.filter(packet => packet.type === "event").length, 0, "hello restores menu even when the perception replay cursor is current");
    const selection = { opportunityId: first.id, sourceEventId: first.sourceEventId };
    const base = { token: entry.token, kind: "choose", payload: { selection, text: "有人在吗？", durationWorldSeconds: 40 } };
    assert.equal((await post({ ...base, taskId: "forged", payload: { ...base.payload, desc: "伪造动作" } })).status, 409);
    assert.equal((await post({ ...base, taskId: "forged-id", payload: { ...base.payload, selection: { ...selection, sourceEventId: "other" } } })).status, 409);
    assert.equal((await post({ ...base, taskId: "one" })).status, 200);
    await until(() => !!release); assert.equal((await post({ ...base, taskId: "busy" })).data.code, "PLAYER_BUSY");
    const cleared = packets.find(packet => packet.type === "opportunities");
    assert.deepEqual(cleared.opportunities, []); assert.equal(cleared.opportunityRevision, 2); assert.equal(cleared.worldSequence, 1);
    assert.equal(reconnect(entry.token, "scene-1")[0].opportunityRevision, 2);
    assert.deepEqual(reconnect(entry.token, "scene-1")[0].opportunities, [], "a reconnect while the task runs must not restore the consumed menu");
    assert.equal(beforeCommit!("start"), true); release!();
    await until(() => packets.some(packet => packet.taskId === "one"));
    assert.deepEqual(actions, [{ desc: "走到河边", duration: 4, taskId: "one", options: { speech: "有人在吗？" } }]);
    assert.equal((await post({ ...base, taskId: "one" })).data.duplicate, true, "retry replays receipt, even after option is retired");
    assert.equal((await post({ ...base, taskId: "repeat" })).data.code, "STALE_SELECTION");
    scene("scene-1", 1, "走到河边");
    assert.equal((await post({ ...base, taskId: "replay" })).data.code, "STALE_SELECTION", "replayed committed scene cannot revive a spent option");
    scene("scene-2", 2, "沿着小路回家");
    const second = packets.at(-1).opportunities[0];
    assert.equal(packets.at(-1).opportunityRevision, 3, "a fresh scene follows consumption monotonically even without changing the old scene sequence");
    const session = server.sessions.get(entry.token);
    session.outbox.push(firstPacket, cleared);
    const replay = reconnect(entry.token);
    assert.deepEqual(replay[0].opportunities, [second]); assert.equal(replay[0].opportunityRevision, 3);
    assert.ok(replay.filter(packet => packet.type === "event").every(packet => packet.opportunities === undefined && packet.opportunityRevision === undefined), "old perception and outbox frames never reintroduce historical menus after hello");
    assert.ok(replay.filter(packet => packet.type === "opportunities").every(packet => packet.opportunityRevision === 3 && packet.opportunities[0]?.id === second.id), "queued menu clears are projected to current state rather than regressing a new menu");
    scene("old-scene", 0, "旧剧情诱饵");
    assert.equal(packets.at(-1).opportunities, undefined, "older committed sequence cannot replace current menu");
    assert.equal((await post({ ...base, taskId: "old" })).status, 409);
    release = undefined;
    assert.equal((await post({ ...base, taskId: "changing", payload: { selection: { opportunityId: second.id, sourceEventId: second.sourceEventId } } })).status, 200);
    await until(() => !!release);
    scene("scene-3", 3, "转身询问路人");
    assert.equal(beforeCommit!("start"), false, "scene change while inference runs rejects the old choice at commit");
    release!(); await until(() => packets.some(packet => packet.taskId === "changing"));
    assert.equal(actions.length, 1); assert.equal(packets.find(packet => packet.taskId === "changing").ok, false);
    console.log("PASS human visitor choices: server-owned identities/actions, exact speech/world-second conversion, busy/stale rejection, idempotent replay, commit-time scene fence and monotonic menu/hello recovery without historical resurrection");
  } finally { release?.(); await server.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
