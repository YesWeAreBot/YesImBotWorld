import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateToolCall } from "../src/llm/parse.js";
import { BOT_TOOLS, BOT_TOOL_NAMES } from "../src/bot/tools.js";
import { BOT_PROMPT_DEFAULTS, GROWTH_RUNTIME_GUIDANCE, GROWTH_MANUAL_GUIDANCE } from "../src/prompts.js";
import { Scheduler } from "../src/bot/scheduler.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import { Config } from "../src/config.js";
import type { ToolCallRecord } from "../src/types.js";

async function main() {
const logger = { info() {}, warn() {}, error() {} } as any;
const call: ToolCallRecord = { id: "tc_42", role: "agent", name: "act", arguments: { description: "走到门边，推开木门" }, issuedAt: 0, expectedAt: 0 };
for (const name of ["check_status", "check_time", "recall"]) {
  assert(!BOT_TOOL_NAMES.includes(name), `legacy tool ${name} must not be advertised`);
  assert.throws(() => validateToolCall({ name, arguments: {} }, BOT_TOOL_NAMES), /未知工具/);
}
for (const args of [null, [], 42, true, "null", "[]", "42", '"text"']) {
  assert.throws(() => validateToolCall({ name: "act", arguments: args }, BOT_TOOL_NAMES), /arguments/);
}
assert.deepEqual(validateToolCall({ name: "act", arguments: '{"description":"喝水"}' }, BOT_TOOL_NAMES).arguments, { description: "喝水" });
assert.match(BOT_TOOLS.find(t => t.name === "recall_growth")!.signature, /scope.*event_ids/);
assert.doesNotMatch(BOT_TOOLS.find(t => t.name === "send")!.description, /<img>|填满/);
assert.match(BOT_PROMPT_DEFAULTS.outputFormatNative, /正文 JSON/);
assert.doesNotMatch(BOT_PROMPT_DEFAULTS.lifestyleWithWait, /需要你主动.*才会成为|不会自动生成认识/);
assert.match(GROWTH_RUNTIME_GUIDANCE, /不再需要每次主动 reflect/);
assert.match(GROWTH_MANUAL_GUIDANCE, /自动回顾与情境回忆目前关闭/);
const clock = { now: () => 0, realMsUntil: () => 0, timeLine: () => "T=0", unitRealSeconds: 1 } as any;
const failure = await new Promise<{ text: string; ok?: boolean }>(resolve => {
  const scheduler = new Scheduler(clock, (text, ref, outcome) => { assert.equal(ref, call.id); resolve({ text: String(text), ok: outcome?.ok }); }, logger);
  scheduler.schedule(call, { executeAt: "now", run: async () => { throw Error("门没有打开，结果尚未确认"); } });
});
assert.equal(failure.ok, false);
assert.match(failure.text, /走到门边，推开木门/);
assert.match(failure.text, /tc_42/);
assert.doesNotMatch(failure.text, /动作 act/);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "world-tool-contracts-"));
try {
  const files = new WorldFiles(dir); await files.ensure();
  const context = new BotContext(files, ""); await context.load();
  await context.appendEvent({ id: context.nextEventId(), source: "world", worldTime: 0, content: "第一条独立经历" });
  const firstRequest = await context.toChatMessages("T=0");
  await context.appendEvent({ id: context.nextEventId(), source: "world", worldTime: 1, content: "稍后到达的新经历" });
  const nextRequest = await context.toChatMessages("T=1");
  assert.deepEqual(nextRequest.slice(0, firstRequest.length), firstRequest, "consecutive same-role events preserve the whole previous request prefix, including message boundaries");
  let calls = 0;
  const world = { adjudicateAct: async (_call: ToolCallRecord, deliver: (text: string) => void) => {
    calls++; deliver(JSON.stringify({ action: { id: call.id, status: "failed", intent: call.arguments.description }, observation: { actorId: "bot", observationId: "obs_1", sourceEventIds: [] } })); return false;
  } } as any;
  const config = Config({ autoStart: false });
  const agent = new BotAgent(config, clock, files, context, world, {} as any, null, null, null, { down: false }, logger, BOT_TOOLS) as any;
  agent.running = true;
  const rejected = await agent.injectExternalToolCall("act", { description: "" });
  assert.equal(rejected.ok, false); assert.equal(calls, 0);
  const result = await agent.injectExternalToolCall("act", call.arguments);
  assert.equal(result.ok, false, "completed adjudication reporting failure must not become a successful action");
  assert.match(result.text, /走到门边/); assert.equal(calls, 1);
  await agent.drainMailbox();
  const records = context.stream.filter(e => e.kind === "event");
  assert(records.some(e => e.kind === "event" && /动作「走到门边/.test(e.event.content)), "start receipt includes the intended action");
  await agent.stop();
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log("PASS tool contracts: removed legacy names, object-only arguments, declared growth/media protocols, concrete action failures and truthful adjudication outcomes");

}
main().catch(error => { console.error(error); process.exitCode = 1; });
