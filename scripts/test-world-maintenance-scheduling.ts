import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldAgent } from "../src/world/agent.js";
import { WorldFiles } from "../src/files.js";
import { Prompts } from "../src/prompts.js";
import type { ChatResult } from "../src/llm/chat.js";

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
const summary = (part: number): ChatResult => ({ content: `<HISTORY_SUMMARY>已整理第${part}段。</HISTORY_SUMMARY><MEMORY_DIGEST>保持原有事实。</MEMORY_DIGEST>`, toolCalls: [] });
const observation: ChatResult = { content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "resolve_world", arguments: JSON.stringify({ perceptions: [{ actorId: "bot", text: "你看见桌上有一杯水。" }] }) } }] };
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "world-maintenance-scheduling-"));
  const files = new WorldFiles(directory); await files.ensure(); await files.writeMeta({ realWorld: false });
  const clock = { now: () => 0, unitRealSeconds: 1, unitWorldSeconds: 1, syncRealTime: false } as any;
  const world = new WorldAgent({ baseURL: `http://${randomUUID()}.invalid`, model: "fixture", compressMaxInputChars: 25 } as any, files, clock, logger, new Prompts());
  try {
    const store = await world.runtime.store();
    await store.commit({ idempotencyKey: "fixture", source: "fixture", initialized: true, worldState: "屋里有一张桌子。",
      actors: { bot: { id: "bot", name: "小澈", controller: "bot", present: true, state: "站在桌边。", perception: "你站在桌边。" } } });
    const entered = deferred(), release = deferred<ChatResult>(), requested = deferred(), events: string[] = [];
    const infer = (world.runtime as any).infer;
    (world.runtime as any).infer = (...args: any[]) => { requested.resolve(); return infer(...args); };
    let count = 0;
    (world as any).client = { complete: async (_messages: unknown, options: { tools?: unknown[]; responseSchema?: unknown }) => {
      if (options.responseSchema || options.tools?.length) { events.push("observation"); return observation; }
      count++; events.push("maintenance" + count);
      if (count === 1) { entered.resolve(); return release.promise; }
      return summary(count);
    } };
    const input = { persona: "小澈", historySummary: "", memoryDigest: "", streamText: ("旧".repeat(20) + "\n").repeat(3), timeLine: "T=0" };
    const first = world.compress(input); await entered.promise;
    const second = world.compress({ ...input, streamText: "另外一段。" });
    const view = world.runtime.observe(); await requested.promise;
    assert.deepEqual(events, ["maintenance1"], "the active inference remains exclusive");
    release.resolve(summary(1));
    const [a, b, seen] = await Promise.all([first, second, view]);
    assert.deepEqual(events, ["maintenance1", "observation", "maintenance2", "maintenance3", "maintenance4"], "real-time inference runs between dependent maintenance chunks, while the next maintenance task stays serialized");
    assert.equal(a.historySummary, "已整理第3段。"); assert.equal(b.historySummary, "已整理第4段。");
    assert.equal(seen.narrative, "你看见桌上有一杯水。"); assert.equal(world.queueLength, 0);
    assert.equal(store.snapshot().worldState, "屋里有一张桌子。", "maintenance cannot rewrite world facts");
    await files.writeBotDef("小澈，普通学生。"); await files.writeWorldDef("屋里有一张桌子。");
    const writing = deferred(), releaseWrite = deferred(), write = files.writePhoneShell.bind(files);
    let shells = 0, writes = 0;
    (world as any).client = { complete: async () => ({ content: `<html><body>外壳${++shells}{{screen}}</body></html>`, toolCalls: [] }) };
    files.writePhoneShell = async html => { if (++writes === 1) { writing.resolve(); await releaseWrite.promise; } await write(html); };
    const shell1 = world.regeneratePhoneShell(new AbortController().signal);
    const shell2 = world.regeneratePhoneShell(new AbortController().signal);
    await writing.promise;
    assert.equal(shells, 1, "a second appearance task must wait for the first file transaction, not just its model request");
    releaseWrite.resolve(); await Promise.all([shell1, shell2]);
    assert.match(await files.readPhoneShell(), /外壳2/); assert.equal(shells, 2);
    console.log("PASS World maintenance yields per model request, allows an interactive observation between chunks and preserves rolling/queued task dependencies");
    console.log("PASS independent appearance jobs remain serialized through their file writes without holding the model endpoint");
  } finally { await world.shutdown(); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
