/** The regulation path must obey the same durable, append-only window as all other perceptions. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotContext } from "../src/bot/context.js";
import { WorldFiles } from "../src/files.js";
import type { ChatToolDef } from "../src/llm/chat.js";

const act: ChatToolDef = { type: "function", function: { name: "act", description: "行动", parameters: { type: "object", properties: {} } } };
const rest: ChatToolDef = { type: "function", function: { name: "rest", description: "休息", parameters: { type: "object", properties: {} } } };
async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yesimbot-regulation-context-"));
  try {
    const files = new WorldFiles(base); await files.ensure();
    const context = new BotContext(files); await context.load();
    // An existing pre-regulation archive has no field and remains byte-identical while the new module runs.
    assert.equal(context.pinned.regulationSummary, undefined);
    const firstTools = await context.nativeToolSnapshot("T0", [act]);
    const firstMessages = await context.toChatMessages("T0");
    const revision = context.windowRevision;
    await context.appendEvent({ id: "ev_regulation_first", source: "system", worldTime: 1, originEventIds: [], content: "眼下更在意获得可靠的交流与联系。" });
    const appended = await context.toChatMessages("T1");
    assert.deepEqual(appended.slice(0, firstMessages.length), firstMessages, "ordinary regulation perception only appends to the exact prior provider prefix");
    assert.deepEqual(await context.nativeToolSnapshot("T1", [rest]), firstTools, "changes of internal state do not reopen native tool declarations");
    assert.equal(context.windowRevision, revision); assert.equal(context.pinned.regulationSummary, undefined);

    const reload = new BotContext(files); await reload.load();
    assert.deepEqual(await reload.toChatMessages("T2"), appended);
    assert.deepEqual(await reload.nativeToolSnapshot("T2", [rest]), firstTools);
    assert.equal(reload.pinned.regulationSummary, undefined);

    const snapshot = await reload.compressionSnapshot();
    await reload.appendEvent({ id: "ev_regulation_tail", source: "system", worldTime: 3, originEventIds: [], content: "收到朋友的认真回应后，联系的需要已有缓解。" });
    const updated = "整理于 T2：当时更在意可靠的交流；这一倾向可能随新的经历改变。";
    await reload.applyCompression({ historySummary: "联系朋友并得到回应", memoryDigest: "记住这次交流" }, 4, snapshot, "知道朋友会认真回应", updated);
    assert.equal(reload.pinned.regulationSummary, updated);
    assert.equal(reload.pinned.growthSummary, "知道朋友会认真回应");
    assert.deepEqual(reload.stream.map(entry => entry.kind === "event" ? entry.event.id : entry.call.id), ["ev_regulation_tail"], "newer changes arriving during compression remain after the older pinned snapshot");
    const compressed = await reload.toChatMessages("T4");
    assert.match(String(compressed[0]!.content), /需要与行动取向（整理时的快照）/);
    assert.match(String(compressed[0]!.content), /较新的变化事件优先/);
    assert.match(String(compressed[0]!.content), /整理于 T2/);
    assert.deepEqual(await reload.nativeToolSnapshot("T4", [rest]), [rest], "only committed compression admits new declarations");

    const after = new BotContext(files); await after.load();
    assert.equal(after.pinned.regulationSummary, updated);
    assert.deepEqual(await after.toChatMessages("T5"), compressed, "the exact compressed regulation prefix survives restart");
    await after.applyCompression({ historySummary: "继续生活", memoryDigest: "" }, 6);
    assert.equal(after.pinned.regulationSummary, updated, "older callers omitting the fifth argument preserve a saved summary");

    // Inject failure into the existing cutover transaction; the new summary must not leak before commit.
    const frozen = await after.toChatMessages("T6");
    const oldSummary = after.pinned.regulationSummary;
    const atomic = files.atomicWrite.bind(files); let blocked = true;
    files.atomicWrite = async (file, text) => { if (file === files.pinned && blocked) throw Error("regulation checkpoint blocked"); return atomic(file, text); };
    await assert.rejects(after.applyCompression({ historySummary: "另一次经历", memoryDigest: "" }, 7, undefined, undefined, "新的需要快照"), /regulation checkpoint blocked/);
    assert.equal(after.pinned.regulationSummary, oldSummary);
    assert.equal(after.renderSystemText("T7"), frozen[0]!.content);
    await assert.rejects(after.toChatMessages("T7"), /regulation checkpoint blocked/);
    blocked = false; await after.settled();
    assert.equal(after.pinned.regulationSummary, "新的需要快照");
    const recovered = new BotContext(files); await recovered.load();
    assert.equal(recovered.pinned.regulationSummary, "新的需要快照");
    await recovered.applyCompression({ historySummary: "暂时停用内部调节", memoryDigest: "" }, 8, undefined, undefined, "");
    assert.equal(recovered.pinned.regulationSummary, "");
    assert.doesNotMatch(String((await recovered.toChatMessages("T8"))[0]!.content), /需要与行动取向（整理时的快照）/);
    console.log("PASS regulation context: old archive, appended perception/native KV prefix, concurrent suffix, compression/restart, omission/clear and failed commit recovery.");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
