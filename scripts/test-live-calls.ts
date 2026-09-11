/** Raw calls use only a loopback HTTP fixture; no real model or running world. */
import assert from "node:assert/strict";
import http from "node:http";
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

  const store = new CallStore(100, 90, 3);
  const begin = (requestBody: string) => store.begin({ source: "Bot", model: "test", url: "http://local", requestBody });
  const a = begin("a".repeat(40)), b = begin("b".repeat(40)); store.detail(a);
  begin("c".repeat(40));
  assert.equal(store.detail(b)?.call.rawAvailable, false, "least recently read raw body is evicted");
  assert.equal(store.detail(a)?.requestBody, "a".repeat(40));
  const huge = begin("z".repeat(120));
  assert.equal(store.detail(huge)?.requestBody, null);
  assert.match(store.detail(huge)!.call.rawUnavailableReason!, /单次/);
  assert(store.retainedBytes <= 100); assert(store.recent().length <= 3);
  const incremental = new CallStore();
  const c = incremental.begin({ source:"World", model:"test", url:"http://local", requestBody:'{"original":true}' });
  incremental.append(c, "first\r\n"); const first = incremental.detail(c)!;
  incremental.append(c, "后半段😀"); const second = incremental.detail(c, first.nextOffset, false)!;
  assert.equal(second.responseText, "后半段😀"); assert.equal(second.requestBody, undefined);
  assert.equal(incremental.detail(c, 99999)!.reset, true);
  incremental.update(c, { status:"cancelled", error:"stopped" }); assert.equal(incremental.detail(c)?.call.status,"cancelled");

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
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));callStore.clear();}
  console.log("PASS bounded raw call storage, valid capped debug JSON, exact request/JSON/SSE capture, incremental reads and HTTP failure");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
