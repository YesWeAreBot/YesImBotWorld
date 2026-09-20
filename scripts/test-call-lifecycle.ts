/** Exercise overlapping plugin lifetimes without starting Koishi or making model requests. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CallStore, callStore } from "../src/webui/calls.js";
import { WorldService } from "../src/service.js";

const directory = mkdtempSync(path.join(tmpdir(), "yesimbot-call-lifecycle-"));
const input = { source: "Regulation", model: "fixture", url: "http://fixture.invalid", requestBody: "fixture request" };

async function main() {
  const store = new CallStore(1, 1);
  try {
    const first = store.init(path.join(directory, "first"));
    const active = store.begin(input);
    store.append(active, "before reload");
    const second = store.init(path.join(directory, "first"));
    first();
    assert.equal(store.retention.persistent, true);
    assert.equal(store.detail(active)?.call.status, "streaming");
    store.append(active, " + after reload");
    assert.equal(store.detail(active)?.responseText, "before reload + after reload", "same-directory replacement keeps existing streams open");
    const next = store.begin(input);
    store.append(next, "replacement response");
    assert.equal(readFileSync(path.join(directory, "first", next + ".response"), "utf16le"), "replacement response", "late old release cannot send new recordings to a temporary directory");
    second();
    assert.equal(store.retention.persistent, false);
    const restored = store.init(path.join(directory, "first"));
    second();
    assert.equal(store.retention.persistent, true, "a released lifetime remains harmless after a later restart");
    assert.equal(store.detail(next)?.call.status, "cancelled");
    assert.equal(store.detail(next)?.responseText, "replacement response");

    const different = store.init(path.join(directory, "second"));
    restored();
    const moved = store.begin(input);
    store.append(moved, "new path");
    assert.equal(readFileSync(path.join(directory, "second", moved + ".response"), "utf16le"), "new path", "changing the configured directory invalidates the old release too");
    different();
    different();
    assert.equal(store.retention.persistent, false);

    // Reproduce the actual service order: old stop enters an await, replacement
    // starts and uses the module singleton, then the previous stop finally drains.
    let finishStop!: () => void, enteredStop!: () => void;
    const stopping = new Promise<void>(resolve => { finishStop = resolve; });
    const entered = new Promise<void>(resolve => { enteredStop = resolve; });
    const service = {
      releaseCallStore: callStore.init(path.join(directory, "service")),
      webui: null, crossingServer: null, crossingClient: null,
      async stopWorld() { enteredStop(); await stopping; },
    };
    const oldStop = WorldService.prototype.stop.call(service as unknown as WorldService);
    await entered;
    assert.equal(WorldService.prototype.stop.call(service as unknown as WorldService), oldStop,
      "a second disposal must await the original shutdown instead of reporting an early completion");
    // Also cover a restarted service object: stop must use the captured release,
    // not whichever callback now occupies the instance field after its await.
    service.releaseCallStore = callStore.init(path.join(directory, "service"));
    const newCall = callStore.begin(input);
    callStore.append(newCall, "new generation");
    finishStop();
    await oldStop;
    assert.equal(callStore.retention.persistent, true);
    assert.equal(callStore.detail(newCall)?.call.status, "streaming", "old WorldService.stop cannot cancel a replacement's call");
    callStore.append(newCall, " finished");
    callStore.update(newCall, { status: "completed" });
    assert.equal(readFileSync(path.join(directory, "service", newCall + ".response"), "utf16le"), "new generation finished");
    service.releaseCallStore();
    assert.equal(callStore.retention.persistent, false, "the owning service still flushes and releases storage on shutdown");
    console.log("PASS: call storage survives overlapping plugin reloads, directory changes and late service shutdown");
  } finally {
    store.dispose();
    callStore.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
