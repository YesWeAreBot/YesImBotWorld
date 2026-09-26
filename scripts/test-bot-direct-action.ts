/** Real Bot HTTP -> durable choice -> dispatcher, without an intervening decision model. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import { Config } from "../src/config.js";
import { WorldFiles } from "../src/files.js";
import type { ParsedToolCall, ToolCallRecord } from "../src/types.js";

const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean) { for (let i = 0; i < 2000 && !test(); i++) await sleep(2); assert.ok(test(), "direct action fixture did not settle"); }
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const action: ParsedToolCall = { name: "act", arguments: { description: "沿着河边散步" }, duration: 15 };
const directories: string[] = [], agents: any[] = [], servers: http.Server[] = [];

async function fixture(output: ParsedToolCall, responseGate?: Promise<void>) {
  const requests: any[] = [];
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    if (responseGate) await responseGate;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: "local-completion", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "bot-direct-action-")); directories.push(base);
  const files = new WorldFiles(base); await files.ensure();
  const context = new BotContext(files); await context.load();
  const cfg = Config({ autoStart: false });
  Object.assign(cfg.bot, { baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: "local-bot", apiKey: "",
    nativeToolCalls: false, stream: false, minIntervalMs: 0, maxWindowChars: 1_000_000, restCompressMinChars: 1_000_000, spillMinChars: 0 });
  cfg.bot.growth.enabled = false;
  const performed: ToolCallRecord[] = [];
  const world: any = { adjudicateAct: async (call: ToolCallRecord, deliver: (text: string) => Promise<void>, _signal: AbortSignal, commit: () => boolean) => {
    assert.ok(commit()); performed.push(structuredClone(call));
    await deliver(JSON.stringify({ action: { id: `bot:${call.id}`, intent: call.arguments.description, status: "completed" },
      observation: { actorId: "bot", mode: "narrative", observationId: "walk-completed", sourceEventIds: ["walk-completed"],
        worldSequence: 1, observedAt: 10, narrative: "你沿着河边走了一段，听见水声。" } }));
    return true;
  } };
  const clock: any = { now: () => 10, unitWorldSeconds: 1, unitRealSeconds: 1, realMsUntil: () => 0, timeLine: () => "T10" };
  const agent: any = new BotAgent(cfg, clock, files, context, world, {} as any, null, null, null, { down: false }, logger,
    BOT_TOOLS.filter(tool => ["act", "think", "rest"].includes(tool.name)));
  agents.push(agent);
  // End this observation window after one dispatch; do not synthesize a second Bot request.
  const dispatch = agent.dispatch.bind(agent);
  agent.dispatch = async (call: ToolCallRecord) => { await dispatch(call); agent.setManualPaused(true); };
  return { agent, context, files, performed, requests };
}

async function originalActionAndThought() {
  for (const proposal of [action, { name: "think", arguments: { thought: "也许河边很安静，但我还没有去。" } }]) {
    const f = await fixture(proposal), prefix = await f.context.toChatMessages("before", false);
    f.agent.start();
    await until(() => f.context.stream.some(entry => entry.kind === "event" && !!entry.event.refToolCallId));
    await f.agent.stop();
    assert.equal(f.requests.length, 1, "one action uses one Bot completion, without an evaluator request");
    assert.equal("regulation" in f.agent, false);
    const calls = f.context.stream.flatMap(entry => entry.kind === "tool_call" ? [entry.call] : []);
    assert.equal(calls.length, 1); assert.equal(calls[0]!.name, proposal.name); assert.deepEqual(calls[0]!.arguments, proposal.arguments);
    assert.deepEqual((await f.context.toChatMessages("after", false)).slice(0, prefix.length), prefix);
    const evidence = await f.agent.growth.recallEvidence({ n: 20 });
    if (proposal.name === "act") {
      assert.deepEqual(f.performed, calls); assert.equal(calls[0]!.duration, action.duration);
      assert.ok(evidence.some((item: any) => item.rootEventIds.includes("walk-completed")), "actual experience still reaches growth");
    } else {
      assert.equal(f.performed.length, 0); assert.deepEqual(evidence, []);
      assert.ok(f.context.stream.some(entry => entry.kind === "event" && entry.event.experience?.internalThought));
    }
    await assert.rejects(fs.access(path.join(f.files.base, "regulation.jsonl")), { code: "ENOENT" });
  }
}

async function controlFences() {
  const response = gate(), pending = await fixture(action, response.promise);
  pending.agent.start(); await until(() => pending.requests.length === 1);
  await pending.agent.acquireManualControl(); response.resolve(); await sleep(20); await pending.agent.stop();
  assert.equal(pending.performed.length, 0);
  assert.ok(!pending.context.stream.some(entry => entry.kind === "tool_call"), "takeover while generating rejects the late decision");

  const entered = gate(), resume = gate(), written = await fixture(action);
  const append = written.context.appendToolCall.bind(written.context);
  written.context.appendToolCall = async call => { await append(call); entered.resolve(); await resume.promise; };
  written.agent.start(); await entered.promise;
  await written.agent.acquireManualControl(); resume.resolve();
  await until(() => written.context.stream.some(entry => entry.kind === "event" && entry.event.content.includes("执行前控制权")));
  await written.agent.stop();
  assert.equal(written.performed.length, 0, "takeover during the durable append prevents a side effect");
  assert.equal(written.requests.length, 1);
}

async function main() {
  try { await originalActionAndThought(); await controlFences();
    console.log("PASS Bot direct action: exactly one Bot HTTP request, original action and timing, real growth evidence, local thought isolation, append-only context and generation/append takeover fences");
  } finally {
    for (const agent of agents) await agent.stop();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const dir of directories) await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
