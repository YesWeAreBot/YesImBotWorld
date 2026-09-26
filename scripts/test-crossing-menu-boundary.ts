/** Crossing routing, receipt order and stale callback fences. No HTTP/SSE or models. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorldService } from "../src/service.js";
import { CrossingClient } from "../src/crossing/client.js";

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const clients: any[] = [], left: any[] = [];
let arriving: (client: any) => Promise<{ worldName: string; timeLine: string }>;
const originalArrive = CrossingClient.prototype.arrive, originalLeave = CrossingClient.prototype.leave;
CrossingClient.prototype.arrive = async function () { clients.push(this); return arriving(this); };
CrossingClient.prototype.leave = async function () { left.push(this); };
const info = (client: any) => ({ worldName: client.target.name, timeLine: "当地清晨" });
const transitions = (events: any[]) => events.filter(e => e.content?.experience?.worldTransition);

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "world-crossing-fence-"));
  const events: any[] = [], epochs: string[] = [], wakes: ((content: string) => void)[] = [];
  const bot = { pushEvent(source: string, content: any, options: unknown) { events.push({ source, content, options }); if(content?.experience?.worldTransition)epochs.push(content.experience.worldTransition.epoch); }, stop: async () => {} };
  let route: any = null;
  const world = { isDormant: true, setRemote(next: unknown) { route = next; }, stop() {},
    wakeDormant: async (deliver: (content: string) => void) => { wakes.push(deliver); deliver("回到主世界的第一份感知"); return true; } };
  const service: any = Object.create(WorldService.prototype);
  Object.assign(service, { bot, world, worldActive: true, files: { base }, clock: { timeLine: () => "主世界中午", unitWorldSeconds: 1 },
    config: { crossing: { worlds: ["A", "B", "C"].map(name => ({ name, url: "https://fixture.invalid", inviteCode: "fixture" })) } },
    logger: { info() {}, warn() {} }, crossingProfile: async () => ({ name: "角色", persona: "测试" }) });
  try {
    arriving = async client => { client.hooks.onEvent("A 的到达感知"); client.hooks.onStatusUpdate("A 的状态感知"); assert.equal(events.length, 0, "Arrival content stays buffered before the destination accepts"); return info(client); };
    await service.crossingTravelTo("A");
    const a = clients.at(-1);
    assert.equal(route, a); assert.equal(service.crossingWhere, "A");
    assert.equal(events[0].source, "system"); assert.ok(events[0].content.experience.worldTransition.epoch);
    assert.equal(events[0].content.contextHint.text, "", "Autonomous travel has its normal actual tool receipt, so the routing fence adds no duplicate model prose");
    assert.deepEqual(events.slice(1).map(e => e.content), ["A 的到达感知", "A 的状态感知"]);
    assert.equal(JSON.parse(await fs.readFile(path.join(base, "crossing.json"), "utf8")).world, "A");

    events.length = 0;
    arriving = async client => { client.hooks.onEvent("被拒绝世界的诱饵感知"); throw Error("拒绝到达"); };
    await assert.rejects(service.crossingTravelTo("B"), /拒绝到达/);
    assert.equal(route, a); assert.equal(service.crossingWhere, "A");
    assert.equal(events.length, 0, "Failed travel neither publishes a transition nor leaks the destination's buffered scene");
    a.hooks.onEvent("仍在 A 的新感知"); assert.equal(events.at(-1).content, "仍在 A 的新感知");
    assert.ok(!left.includes(a), "The old world is not left until the new destination has accepted");

    events.length = 0;
    arriving = async client => { client.hooks.onEvent("B 的第一份感知"); return info(client); };
    await service.crossingForce("B");
    const b = clients.at(-1);
    assert.equal(route, b); assert.match(events[0].content.text, /不可抗拒/); assert.equal(events[0].content.contextHint, undefined);
    assert.equal(events[1].content, "B 的第一份感知"); assert.ok(left.includes(a));
    const count = events.length;
    a.hooks.onEvent("A 迟到感知"); a.hooks.onStatusUpdate("A 迟到状态"); a.hooks.onLost("旧连接丢失");
    assert.equal(events.length, count); assert.equal(route, b);

    events.length = 0;
    await service.crossingGoHome();
    assert.equal(route, null); assert.equal(transitions(events).length, 1);
    assert.ok(events[0].content.experience.worldTransition); assert.equal(events[1].content, "回到主世界的第一份感知");
    b.hooks.onEvent("B 迟到感知"); assert.equal(events.length, 2);
    assert.equal(await fs.access(path.join(base, "crossing.json")).then(() => true, () => false), false);
    const homeWake = wakes.at(-1)!;
    events.length = 0;
    arriving = async client => info(client);
    await service.crossingTravelTo("C");
    const c = clients.at(-1);
    const beforeLateHome = events.length; homeWake("旧主世界补叙"); assert.equal(events.length, beforeLateHome);
    events.length = 0;
    c.hooks.onLost("连接中断");
    assert.equal(route, null); assert.equal(transitions(events).length, 1);
    assert.equal(events[0].content.contextHint, undefined); assert.equal(events[1].content, "回到主世界的第一份感知");
    await service.crossingMarkerTail;
    assert.equal(await fs.access(path.join(base, "crossing.json")).then(() => true, () => false), false);

    events.length = 0;
    arriving = async client => { client.hooks.onEvent("未确认场景"); client.hooks.onLost("到达时断开"); return info(client); };
    await assert.rejects(service.crossingTravelTo("A"), /到达时断开/);
    assert.equal(events.length, 0); assert.equal(route, null);

    const slow = gate(), entered = gate();
    arriving = async client => { entered.resolve(); client.hooks.onEvent("慢到达场景"); await slow.promise; return info(client); };
    const delayed = service.crossingTravelTo("A"); await entered.promise;
    await service.crossingForce("home"); slow.resolve();
    await assert.rejects(delayed, /没有生效/);
    assert.equal(route, null); assert.equal(events.length, 0, "Returning home cancels an unconfirmed arrival without inventing a transition");

    const slowOld = gate(), oldStarted = gate();
    arriving = async client => { oldStarted.resolve(); await slowOld.promise; return info(client); };
    const old = service.crossingTravelTo("A"); await oldStarted.promise;
    arriving = async client => { client.hooks.onEvent("最新目的地"); return info(client); };
    await service.crossingTravelTo("B"); slowOld.resolve(); await assert.rejects(old, /没有生效/);
    assert.equal(service.crossingWhere, "B"); assert.equal(transitions(events).length, 1); assert.equal(events.at(-1).content, "最新目的地");

    events.length = 0;
    const stopGate = gate(), stopStarted = gate();
    arriving = async client => { stopStarted.resolve(); await stopGate.promise; return info(client); };
    const stopped = service.crossingTravelTo("C"); await stopStarted.promise;
    service.cancelWorldWork(); stopGate.resolve(); await assert.rejects(stopped, /没有生效/);
    assert.equal(events.length, 0, "An arrival from the retired service cannot install a route or publish perceptions");
    assert.equal(new Set(epochs).size, epochs.length, "Each actual world switch has a distinct replay-safe epoch");
    console.log("PASS crossing menu boundary: accepted routing fence before perceptions, failed travel preserves source, exact client isolation, force/home/lost, deferred home scenes, superseded arrivals and stop");
  } finally {
    CrossingClient.prototype.arrive = originalArrive; CrossingClient.prototype.leave = originalLeave;
    await service.crossingMarkerTail; await fs.rm(base, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
