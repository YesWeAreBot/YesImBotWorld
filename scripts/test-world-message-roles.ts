/** Actual WorldAgent/runtime/ChatClient against a strict loopback chat template; no live model. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { WorldClock } from "../src/clock.js";
import { WorldFiles } from "../src/files.js";
import { WorldAgent } from "../src/world/agent.js";
import { Prompts } from "../src/prompts.js";
import type { ChatMessage } from "../src/llm/chat.js";

interface RequestBody {
  messages: ChatMessage[];
  response_format: { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
  tools?: unknown;
  stream?: boolean;
}
const initialState = "院子里有一张木桌，小澈站在桌旁。";
const finalState = "院子里有一张木桌，小澈已走到院门旁。";
const warnings: string[] = [];
const logger = { info() {}, warn(...args: unknown[]) { warnings.push(args.map(String).join(" ")); }, error() {} } as any;

async function main(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "world-message-roles-"));
  const files = new WorldFiles(directory);
  let world: WorldAgent | undefined;
  const requests: RequestBody[] = [], serverErrors: unknown[] = [];
  let actionAttempts = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as RequestBody; requests.push(body);
      assert.equal(request.url, "/v1/chat/completions");
      // Reproduce the provider's rejection instead of silently accepting invalid messages.
      if (body.messages.some((message, index) => message.role === "system" && index !== 0)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "System message must be at the beginning" } }));
        return;
      }
      assert.equal(body.messages[0]!.role, "system");
      assert.equal(body.messages.filter(message => message.role === "system").length, 1);
      assert.equal(body.response_format.type, "json_schema");
      assert.equal(body.response_format.json_schema.name, "world_resolution");
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.tools, undefined);
      assert.equal(body.stream, undefined);
      const input = JSON.parse(body.messages[1]!.content as string);
      let result: unknown;
      if (input.kind === "initialize") {
        result = { botName: "小澈", worldState: initialState,
          actorStates: [{ actorId: "bot", state: "站在院子的木桌旁。" }],
          perceptions: [{ actorId: "bot", text: "你站在院子里，面前是一张木桌，院门在右侧。" }] };
      } else {
        assert.equal(input.kind, "action");
        assert.equal(input.action.intent, "走到院门旁");
        actionAttempts++;
        if (actionAttempts === 1) {
          // A well-formed draft missing actual perception text enters the real repair path.
          result = { worldState: finalState, actorStates: [{ actorId: "bot", state: "站在院门旁。" }],
            perceptions: [{ actorId: "bot", situation: "院门就在面前。" }], outcome: { status: "completed" } };
        } else {
          assert.equal(actionAttempts, 2, "one corrected proposal must end the repair loop");
          const feedback = JSON.parse(body.messages.at(-2)!.content as string);
          assert.equal(feedback.committed, false);
          assert.match(feedback.error, /perceptions\[0\]\.text/);
          assert.equal(feedback.draft.worldState, finalState);
          const snapshot = (await world!.runtime.store()).snapshot();
          assert.equal(snapshot.worldState, initialState, "an invalid draft cannot change the saved world");
          assert.equal(snapshot.actors.bot!.state, "站在院子的木桌旁。");
          assert.equal(snapshot.actions["bot:role-action"]!.status, "pending");
          result = { repair: { set: { perceptions: [{ actorId: "bot", text: "你走到院门旁，停在门边。" }] } } };
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(result) }, finish_reason: "stop" }] }));
    } catch (error) {
      serverErrors.push(error); response.writeHead(500); response.end(String(error));
    }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await files.ensure(); await files.writeMeta({ realWorld: false });
    await files.atomicWrite(files.botDef, "小澈是住在院子里的普通人。");
    await files.atomicWrite(files.worldDef, initialState);
    const cfg = Config({ autoStart: false, clock: { syncRealTime: false } });
    Object.assign(cfg.world, { apiType: "chat-completions", baseURL: `http://127.0.0.1:${address.port}/v1`,
      model: "strict-prefix-only-fixture", responseFormat: "json_schema", stream: false });
    const clock = new WorldClock(cfg.clock, files.clock); await clock.load();
    world = new WorldAgent(cfg.world, files, clock, logger, new Prompts());
    await world.ensureWorld();
    const store = await world.runtime.store();
    assert.equal(store.snapshot().initialized, true);
    assert.equal(store.snapshot().worldState, initialState);
    assert.equal(store.snapshot().actors.bot!.name, "小澈");
    const deliveries: any[] = [];
    const now = clock.now();
    assert.equal(await world.adjudicateAct({ id: "role-action", role: "agent", name: "act",
      arguments: { description: "走到院门旁" }, issuedAt: now, expectedAt: now, duration: 0,
    }, text => { deliveries.push(JSON.parse(text)); }), true);
    assert.equal(store.snapshot().worldState, finalState);
    assert.equal(store.snapshot().actions["bot:role-action"]!.status, "completed");
    const receipts = deliveries.filter(delivery => delivery.action);
    assert.equal(receipts.length, 1, "only the validated action is delivered as a receipt");
    assert.match(receipts[0].observation.narrative, /你走到院门旁/);
    assert.deepEqual(serverErrors, []); assert.deepEqual(warnings, []);
    assert.equal(requests.length, 3); assert.equal(actionAttempts, 2);
    const [genesis, action, repair] = requests;
    for (const body of requests) {
      assert.equal(body.messages.at(-1)!.role, "user");
      assert.ok(String(body.messages.at(-1)!.content).includes(JSON.stringify(body.response_format.json_schema.schema)),
        "each request retains its current output schema after the actual task input");
    }
    assert.deepEqual(genesis!.messages.map(message => message.role), ["system", "user", "user"]);
    assert.deepEqual(action!.messages.map(message => message.role), ["system", "user", "user"]);
    assert.deepEqual(repair!.messages.map(message => message.role), ["system", "user", "assistant", "user", "user"]);
    assert.deepEqual(repair!.messages.slice(0, 2), action!.messages.slice(0, 2), "repair retains the complete original task prefix");
    assert.doesNotMatch(String(repair!.messages[0]!.content), /perceptions\[0\]\.text/,
      "runtime repair feedback must not be promoted into the fixed system rules");
    assert.notDeepEqual(repair!.response_format.json_schema.schema, action!.response_format.json_schema.schema,
      "the real repair request changes its output schema while preserving the fixed system message");
    console.log("PASS strict message roles: real WorldAgent genesis, action and validated repair via loopback ChatClient; one initial system, stable task prefix and no invalid draft commit");
  } finally {
    await world?.shutdown();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
