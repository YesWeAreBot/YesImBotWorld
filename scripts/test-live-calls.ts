/** Raw calls use only a loopback HTTP fixture; no real model or running world. */
import assert from "node:assert/strict";
import http from "node:http";
import { appendFileSync, closeSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CallStore, callStore } from "../src/webui/calls.js";
import { DebugBus, debug as globalDebug } from "../src/webui/debug.js";
import { ChatClient } from "../src/llm/chat.js";

async function main() {
  const debug = new DebugBus(5, 500);
  const id = debug.emit("llm.req", "large", { messages: [{ content: '"\\'.repeat(2000) }], callId: "known" });
  const capped = JSON.parse(debug.recent(1)[0].detail);
  assert.equal(capped.truncated, true); assert.equal(capped.callId, "known");
  debug.update(id, { detail: { content: "x".repeat(4000) } });
  assert.equal(JSON.parse(debug.recent(1)[0].detail).truncated, true);

  const temporary = mkdtempSync(path.join(tmpdir(), "yesimbot-call-storage-test-"));
  const stores: CallStore[] = [];
  const createStore = (name: string, maxBytes = 100, maxCallBytes = 90, maxCalls = 3) => {
    const store = new CallStore(maxBytes, maxCallBytes, maxCalls); stores.push(store);
    store.init(path.join(temporary, name)); return store;
  };
  try {
    const store = createStore("cache");
    const begin = (requestBody: string) => store.begin({ source: "Bot", model: "test", url: "http://local", requestBody });
    const a = begin("a".repeat(40)), b = begin("b".repeat(40)); store.detail(a);
    begin("c".repeat(40));
    assert.equal(store.detail(b)?.call.rawAvailable, true, "leaving the memory cache never removes the recording");
    assert.equal(store.detail(a)?.requestBody, "a".repeat(40));
    const hugeRequest = JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "a".repeat(9 * 1024 * 1024) } }] }] });
    const huge = begin(hugeRequest);
    assert.equal(store.detail(huge)?.requestBody, hugeRequest, "a request beyond the old 8 MB limit stays available");
    assert.equal(store.retainedBytes <= 100, true);
    assert.equal(store.recent().length, 4, "all active calls survive the completed-history count limit");
    store.update(a, { status: "completed" });
    const response = "header\r\n" + "后半段😀\n".repeat(40000);
    for (let i = 0; i < response.length; i += 41) store.append(huge, response.slice(i, i + 41));
    assert.equal(store.detail(huge)?.responseText, response, "many frames spill without losing split surrogate pairs");
    const pair = response.indexOf("😀");
    assert.equal(store.detail(huge, pair + 1, false)?.responseText, response.slice(pair + 1), "disk offsets use exact JavaScript UTF-16 units, including the middle of a surrogate pair");
    assert.equal(store.detail(huge, 999999999)?.reset, true);
    store.update(huge, { status: "completed" });
    const files = path.join(temporary, "cache");
    assert.equal(statSync(files).mode & 0o777, 0o700);
    for (const suffix of [".request", ".response", ".json"]) assert.equal(statSync(path.join(files, huge + suffix)).mode & 0o777, 0o600);
    assert.equal(store.retention.persistent, true); assert.equal(store.retention.cacheOnly, true);
    store.dispose();
    const restored = createStore("cache");
    assert.equal(restored.detail(huge)?.requestBody, hugeRequest);
    assert.equal(restored.detail(huge)?.responseText, response);
    assert.equal(restored.detail(huge)?.call.status, "completed");
    assert.equal(restored.recent().length, 3, "restored history keeps the newest completed records");
    assert.equal(restored.detail(a), null);
    assert.equal(restored.detail(b)?.call.status, "cancelled", "unfinished calls are marked interrupted on a restart");
    restored.clear();
    assert.equal(restored.recent().length, 0);

    const incremental = createStore("incremental", 1000, 1000);
    const c = incremental.begin({ source:"World", model:"test", url:"http://local", requestBody:'{"original":true}' });
    incremental.append(c, "first\r\n"); const first = incremental.detail(c)!;
    incremental.append(c, "后半段😀"); const second = incremental.detail(c, first.nextOffset, false)!;
    assert.equal(second.responseText, "后半段😀"); assert.equal(second.requestBody, undefined);
    assert.equal(incremental.detail(c, 99999)!.reset, true);
    incremental.update(c, { status:"cancelled", error:"stopped" }); assert.equal(incremental.detail(c)?.call.status,"cancelled");

    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => ++clock;
    try {
      const retention = createStore("count", 1, 1, 2);
      const ongoing = retention.begin({ source:"Bot", model:"test", url:"http://local", requestBody:"active request" });
      const finished = [];
      for (let i = 0; i < 8; i++) {
        const id = retention.begin({ source:"World", model:"test", url:"http://local", requestBody:"finished request " + i });
        retention.append(id, "response " + i); retention.update(id, { status:"completed" }); finished.push(id);
      }
      assert.equal(retention.recent().length, 3);
      assert.equal(retention.detail(ongoing)?.requestBody, "active request");
      assert.equal(retention.detail(finished[0]!), null);
      retention.append(ongoing, "still recording");
      assert.equal(retention.detail(ongoing)?.responseText, "still recording");
      assert.deepEqual(retention.recent().slice(1).map(meta => meta.callId), finished.slice(-2));
      retention.append(ongoing, " + final response");
      retention.update(ongoing, {status:"completed"});
      assert.equal(retention.detail(ongoing)?.responseText, "still recording + final response", "a long-running call survives completion after the history limit of newer short calls");
      assert.equal(retention.detail(finished.at(-2)!), null, "completion time determines retention instead of start time");
      assert.equal(retention.recent().length, 2);
      retention.dispose();
      const restoredCompletion = createStore("count", 1, 1, 2);
      assert.equal(restoredCompletion.detail(ongoing)?.responseText, "still recording + final response", "the latest completion remains available after a restart");
      assert.equal(restoredCompletion.detail(finished.at(-1)!)?.responseText, "response 7");
    } finally { Date.now = realNow; }

    // Model transport must continue if the target filesystem is unavailable.
    const blockedDirectory = path.join(temporary, "blocked"); writeFileSync(blockedDirectory, "not a directory");
    const blocked = createStore("blocked", 1, 1);
    let unavailableId = "";
    assert.doesNotThrow(() => {
      unavailableId = blocked.begin({source:"Bot",model:"test",url:"http://local",requestBody:hugeRequest});
      blocked.append(unavailableId, "stream survives 😀"); blocked.update(unavailableId, {status:"completed"});
    });
    assert.equal(blocked.detail(unavailableId)?.requestBody, hugeRequest);
    assert.equal(blocked.detail(unavailableId)?.responseText, "stream survives 😀");
    assert.match(blocked.detail(unavailableId)?.call.storageWarning || "", /保留在内存/);
    assert.equal(blocked.retention.persistent, false);

    const failedAppend = createStore("failed-append", 1, 1);
    const failureId = failedAppend.begin({source:"Bot",model:"test",url:"http://local",requestBody:"disk request"});
    failedAppend.append(failureId, "committed prefix");
    const captured = (failedAppend as unknown as { calls: Map<string, { disk: { fd: number } }> }).calls.get(failureId)!;
    closeSync(captured.disk.fd); // Simulate a descriptor failure after a call has left memory.
    assert.doesNotThrow(() => failedAppend.append(failureId, " + fallback suffix😀"));
    assert.equal(failedAppend.detail(failureId)?.requestBody, "disk request");
    assert.equal(failedAppend.detail(failureId)?.responseText, "committed prefix + fallback suffix😀");
    failedAppend.append(failureId, " + next frame");
    assert.equal(failedAppend.detail(failureId)?.responseText, "committed prefix + fallback suffix😀 + next frame");

    assert.equal(failedAppend.retention.persistent, false);
    assert.equal(failedAppend.retention.storage, "memory");
    assert.match(failedAppend.retention.storageWarning || "", /保留在内存/);
    failedAppend.update(failureId, {status:"completed"});
    assert.equal(failedAppend.retention.persistent, true, "recovered persistence is reflected by retention metadata");
    assert.equal(failedAppend.retention.storage, "disk");
    assert.equal(failedAppend.retention.storageWarning, undefined);
    assert.equal(failedAppend.detail(failureId)?.call.storageWarning, undefined, "completion retries transient disk failures");
    assert.equal(failedAppend.retainedBytes, 0);
    failedAppend.dispose();
    const recoveredAppend = createStore("failed-append", 1, 1);
    assert.equal(recoveredAppend.detail(failureId)?.responseText, "committed prefix + fallback suffix😀 + next frame", "recovered data survives a restart");

    const interrupted = createStore("interrupted", 1, 1);
    const crashId = interrupted.begin({source:"World",model:"test",url:"http://local",requestBody:"{}"});
    interrupted.append(crashId, "checkpoint");
    interrupted.dispose();
    const metadataPath = path.join(temporary, "interrupted", crashId + ".json");
    const checkpoint = JSON.parse(readFileSync(metadataPath, "utf8"));
    checkpoint.meta.status = "streaming"; delete checkpoint.meta.endedAt; writeFileSync(metadataPath, JSON.stringify(checkpoint));
    appendFileSync(path.join(temporary, "interrupted", crashId + ".response"), " + uncheckpointed😀", "utf16le");
    writeFileSync(path.join(temporary, "interrupted", "ffffffff-ffff-ffff-ffff-ffffffffffff.json"), "broken JSON");
    const restart = createStore("interrupted", 1, 1);
    assert.equal(restart.detail(crashId)?.responseText, "checkpoint + uncheckpointed😀");
    assert.equal(restart.detail(crashId)?.call.responseBytes, Buffer.byteLength("checkpoint + uncheckpointed😀"));
    assert.equal(restart.detail(crashId)?.call.status, "cancelled");
    assert.equal(restart.recent().length, 1, "a corrupt unrelated record does not hide valid recordings");
  } finally { for (const store of stores) store.dispose(); rmSync(temporary, {recursive:true,force:true}); }

  const resumed=callStore.begin({source:"Bot",model:"test",url:"http://local",requestBody:"{}"});
  const originalDebugId=globalDebug.recent(1)[0].id;
  for(let i=0;i<600;i++)globalDebug.emit("op","background",{});
  assert.equal(globalDebug.has(originalDebugId),false);
  const wasEnabled=globalDebug.enabled;globalDebug.enabled=true;let rebroadcast=false;
  const unsubscribe=globalDebug.subscribe((entry,isUpdate)=>{if(entry.kind==="llm.call" && JSON.parse(entry.detail).callId===resumed)rebroadcast=!isUpdate;});
  callStore.update(resumed,{status:"streaming",preview:"still active"});
  unsubscribe();globalDebug.enabled=wasEnabled;assert.equal(rebroadcast,true,"evicted debug IDs generate a fresh SSE event");
  assert.equal(globalDebug.recent(1)[0].kind,"llm.call");
  assert.equal(JSON.parse(globalDebug.recent(1)[0].detail).callId,resumed,"ongoing calls republish after the ordinary debug entry is evicted");
  callStore.clear();

  const received: string[] = [];
  const rawJson = ' {"choices":[{"message":{"content":"完整响应😀"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n';
  const rawSse = ': original comment\r\ndata: {"choices":[{"delta":{"content":"第一段"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"第二段"}}]}\n\ndata: [DONE]\n\n';
  const server = http.createServer(async (req, res) => {
    let body="";for await(const chunk of req)body+=chunk;received.push(body);
    if(req.url?.startsWith('/error/')){res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"exact bad request body"}');return;}
    if(req.url?.startsWith('/abort/')){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');return;}
    if(req.url?.startsWith('/stream/')){res.writeHead(200,{'content-type':'text/event-stream'});res.end(rawSse);return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(rawJson);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as import('node:net').AddressInfo).port;
  try {
    callStore.clear();
    const client = new ChatClient({ baseURL:`http://127.0.0.1:${port}/json`,model:"fixture",label:"Bot",stream:false });
    await client.complete([{role:"user",content:"x".repeat(55000)+"exact tail 😀"}]);
    const meta = callStore.recent().at(-1)!; const detail = callStore.detail(meta.callId)!;
    assert.equal(detail.requestBody,received[0],"retains the exact normalized body actually sent");
    assert.match(detail.requestBody!,/exact tail 😀/);assert.equal(detail.responseText,rawJson);assert.equal(meta.status,"completed");
    const streaming = new ChatClient({ baseURL:`http://127.0.0.1:${port}/stream`,model:"fixture",label:"World",stream:true });
    const result = await streaming.complete([{role:"user",content:"stream test"}]);
    assert.equal(result.content,"第一段第二段"); const streamMeta=callStore.recent().at(-1)!;
    assert.notEqual(streamMeta.callId,meta.callId);assert.equal(callStore.detail(streamMeta.callId)?.responseText,rawSse,"preserves raw SSE comments and CRLF before parsing");
    const failure = new ChatClient({baseURL:`http://127.0.0.1:${port}/error`,model:"fixture",label:"Bot",stream:false});
    await assert.rejects(failure.complete([{role:"user",content:"error"}]),/400/);
    const failed=callStore.recent().at(-1)!;assert.equal(failed.status,"error");assert.equal(failed.httpStatus,400);assert.equal(callStore.detail(failed.callId)?.responseText,'{"error":"exact bad request body"}');
    await Promise.all([client.complete([{role:"user",content:"parallel A"}]),client.complete([{role:"user",content:"parallel B"}])]);
    const concurrent=callStore.recent().slice(-2);assert.equal(new Set(concurrent.map(c=>c.callId)).size,2);
    assert.deepEqual(concurrent.map(c=>JSON.parse(callStore.detail(c.callId)!.requestBody!).messages[0].content).sort(),["parallel A","parallel B"]);
    const aborter=new AbortController(),aborting=new ChatClient({baseURL:`http://127.0.0.1:${port}/abort`,model:"fixture",label:"World",stream:true});
    const aborted=assert.rejects(aborting.complete([{role:"user",content:"abort"}],{signal:aborter.signal}));
    for(let i=0;i<100 && callStore.recent().at(-1)?.status!=="streaming";i++)await new Promise(resolve=>setTimeout(resolve,5));
    aborter.abort();await aborted;const cancelled=callStore.recent().at(-1)!;
    assert.equal(cancelled.status,"cancelled");assert.match(callStore.detail(cancelled.callId)?.responseText || "",/partial/);
    assert(callStore.recent().every(m=>m.endedAt && m.revision>1));
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));callStore.clear();callStore.dispose();}
  console.log("PASS disk-backed raw call storage, large/base64 requests, private restart history, Unicode seek, streaming concurrency and nonfatal storage failures");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
