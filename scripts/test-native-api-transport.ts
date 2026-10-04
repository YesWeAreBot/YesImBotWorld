import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatClient, ChatCompletionError, type ChatMessage } from "../src/llm/chat.js";
import type { ChatApiType } from "../src/llm/protocol.js";
import { llmEndpoint, llmHeaders } from "../src/llm/endpoint.js";
import { callStore } from "../src/webui/calls.js";
import { usageStore } from "../src/webui/usage.js";
import { classifyMediaRequestFailure } from "../src/media/request-failure.js";

function endpoints() {
  assert.equal(llmEndpoint("https://api.openai.com", "responses"), "https://api.openai.com/v1/responses");
  assert.equal(llmEndpoint("https://api.anthropic.com/", "anthropic"), "https://api.anthropic.com/v1/messages");
  assert.equal(llmEndpoint("https://proxy.invalid/prefix/v1/chat/completions?region=local", "anthropic"), "https://proxy.invalid/prefix/v1/messages?region=local");
  assert.equal(llmEndpoint("https://proxy.invalid/prefix/responses/", "responses", "models"), "https://proxy.invalid/prefix/models");
  assert.equal(llmEndpoint("https://proxy.invalid/responses", "responses"), "https://proxy.invalid/responses");
  assert.equal(llmEndpoint("https://proxy.invalid/messages", "anthropic", "models"), "https://proxy.invalid/models");
  assert.equal(llmEndpoint("http://127.0.0.1:8000/v1", "chat-completions"), "http://127.0.0.1:8000/v1/chat/completions");
  assert.throws(() => llmEndpoint("file:///tmp/model", "responses"), /HTTP/);
  assert.throws(() => llmEndpoint("https://secret:password@proxy.invalid", "responses"), /凭据/);
  assert.throws(() => llmEndpoint("https://proxy.invalid", "wrong" as ChatApiType), /API/);
  assert.deepEqual(llmHeaders("anthropic", "test-key"), { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "test-key" });
  assert.equal(llmHeaders("responses", "test-key").authorization, "Bearer test-key");
}
const sse = (type: string, fields: Record<string, unknown>) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
function output(api: ChatApiType, text = "你好😀") {
  return api === "responses"
    ? { id: "resp_1", object: "response", status: "completed", output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107, input_tokens_details: { cached_tokens: 60 } } }
    : { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 20, cache_creation_input_tokens: 20, cache_read_input_tokens: 60, output_tokens: 7 } };
}
function streamText(api: ChatApiType) {
  if (api === "responses") return sse("response.output_item.added", { output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } })
    + sse("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "msg_1", delta: "你" })
    + sse("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "msg_1", delta: "好😀" })
    + sse("response.completed", { response: output(api) });
  return sse("message_start", { message: { id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 20, cache_creation_input_tokens: 20, cache_read_input_tokens: 60, output_tokens: 1 } } })
    + sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "你" } })
    + sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好😀" } })
    + sse("content_block_stop", { index: 0 })
    + sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } })
    + sse("message_stop", {});
}

async function main() {
  endpoints();
  const directory = await mkdtemp(join(tmpdir(), "native-transport-")), release = callStore.init(directory);
  const received: { path: string; headers: any; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push({ path: req.url!, headers: req.headers, body });
    const api = req.url?.includes("responses") ? "responses" : "anthropic";
    if (body.model.startsWith("schema")) {
      const value: any = { value: "ok", location: null, ...(api === "responses" ? { note: null } : {}) };
      if (body.model === "schema-union") value.kind = "normal";
      if (body.model === "schema-invalid") value.unexpected = "not allowed";
      const text = JSON.stringify(body.model === "schema-union" && api === "responses" ? { result: value } : value);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(output(api, text))); return;
    }
    if (body.model === "truncated-json") {
      const reply = output(api) as any;
      if (api === "responses") { reply.status = "incomplete"; reply.incomplete_details = { reason: "max_output_tokens" }; }
      else reply.stop_reason = "max_tokens";
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply)); return;
    }
    if (body.model === "status-error") { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"bad credentials"}}'); return; }
    if (!body.stream || body.model === "json-fallback") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(output(api))); return; }
    res.setHeader("content-type", "text/event-stream");
    if (body.model === "remote-error") { res.end(sse("error", { error: { type: "server_error", message: "upstream failed" } })); return; }
    if (body.model === "abort" || body.model === "bad-continuous") {
      res.write(body.model === "bad-continuous" ? "data: {broken}\n\n" : ": waiting\n\n");
      const timer = setInterval(() => res.write(": alive\n\n"), 20);
      res.once("close", () => clearInterval(timer)); return;
    }
    const wire = streamText(api);
    if (body.model === "incomplete") { res.end(wire.slice(0, wire.lastIndexOf("event:"))); return; }
    // Split inside UTF-8 and CRLF boundaries, while retaining exact wire capture.
    const bytes = Buffer.from(wire); for (let i = 0; i < bytes.length; i += 13) res.write(bytes.subarray(i, i + 13)); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}/gateway/v1`;
  const messages: ChatMessage[] = [{ role: "system", content: "固定角色前缀" }, { role: "user", content: [
    { type: "text", text: "图前😀\ud83d" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "图后" },
  ] }];
  const original = structuredClone(messages);
  try {
    for (const apiType of ["responses", "anthropic"] as const) {
      const client = (model: string, stream = true) => new ChatClient({ baseURL, apiType, apiKey: "fixture-private-key", model, stream, label: "NativeTest" });
      for (const [model, stream] of [["normal", true], ["normal-json", false], ["json-fallback", true]] as const) {
        const updates: string[] = [];
        const result = await client(model, stream).complete(messages, { onDelta: text => updates.push(text) });
        assert.equal(result.content, "你好😀"); assert.equal(updates.at(-1), result.content);
        assert.deepEqual(result.toolCalls, []);
        const sent = received.at(-1)!;
        assert.equal(sent.path, `/gateway/v1/${apiType === "responses" ? "responses" : "messages"}`);
        if (apiType === "anthropic") {
          assert.equal(sent.headers["x-api-key"], "fixture-private-key"); assert.equal(sent.headers["anthropic-version"], "2023-06-01");
          assert.equal(sent.headers.authorization, undefined);
          assert.equal(sent.body.messages[0].content[0].text, "图前😀�");
        } else {
          assert.equal(sent.headers.authorization, "Bearer fixture-private-key"); assert.equal(sent.headers["x-api-key"], undefined);
          assert.equal(sent.body.input[1].content[0].text, "图前😀�");
        }
        const call = callStore.recent().at(-1)!; assert.equal(call.status, "completed"); assert.equal(call.unicodeRepairedStrings, 1);
        const detail = callStore.detail(call.callId)!;
        assert.deepEqual(JSON.parse(detail.requestBody!), sent.body);
        assert.equal(detail.responseText, stream && model !== "json-fallback" ? streamText(apiType) : JSON.stringify(output(apiType)));
        assert.ok(!detail.requestBody!.includes("fixture-private-key"));
        assert.equal((call.usage as any).cached_tokens, 60); assert.equal((call.usage as any).prompt_tokens, 100);
        const usage = usageStore.recent(1)[0]!; assert.equal(usage.cachedTokens, 60); assert.equal(usage.cacheReported, true);
        assert.equal(usage.totalTokens, 107, "cache normalization stays idempotent across UI and persisted statistics");
      }
      await client("prefix-a", false).complete(messages);
      const a = structuredClone(received.at(-1)!.body);
      await client("prefix-a", false).complete([...messages, { role: "assistant", content: '{"name":"think","arguments":{"thought":"想一想"}}' }, { role: "user", content: "新感知" }]);
      const b = received.at(-1)!.body;
      if (apiType === "anthropic") { assert.deepEqual(a.system, b.system); assert.deepEqual(a.messages, b.messages.slice(0, -2)); }
      else assert.deepEqual(a.input, b.input.slice(0, -2));
      const count = received.length;
      await assert.rejects(client("invalid-media").complete([{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }] }]), error => {
        assert.deepEqual(classifyMediaRequestFailure(error, new Set(["input_audio", "image_url"])), { kind: "unsupported-modality", modalities: ["audio"] }); return true;
      });
      assert.equal(received.length, count, "known unsupported content is rejected before network access");
      const shape = { type: "object", additionalProperties: false, required: ["value"], properties: {
        value: { type: "string", minLength: 1 }, note: { type: "number", minimum: 0 }, location: { type: ["string", "null"] },
      } };
      const schemaBefore = structuredClone(shape), observed: string[] = [];
      const roundTrip = await client("schema", false).complete(messages, { responseSchema: { name: "shape", schema: shape }, responseSchemaInPrompt: false, onDelta: text => observed.push(text) });
      assert.deepEqual(JSON.parse(roundTrip.content), { value: "ok", location: null });
      if (apiType === "responses") assert.equal(JSON.parse(observed.at(-1)!).note, null, "wire placeholders remain visible in stream/raw diagnostics");
      assert.deepEqual(shape, schemaBefore, "schema projection never rewrites the application contract");
      const union = { anyOf: [{ ...shape, required: ["kind", "value"], properties: { kind: { type: "string", enum: ["normal"] }, ...shape.properties } },
        { type: "object", additionalProperties: false, required: ["repair"], properties: { repair: { type: "string" } } }] };
      const wrapped = await client("schema-union", false).complete(messages, { responseSchema: { name: "union", schema: union } });
      assert.deepEqual(JSON.parse(wrapped.content), { kind: "normal", value: "ok", location: null });
      if (apiType === "responses") {
        const raw = callStore.detail(callStore.recent().at(-1)!.callId)!;
        assert.ok(raw.requestBody!.includes('"result"'));
        assert.ok(raw.responseText!.includes('\\"result\\"'), "protocol envelope is preserved in exact wire history");
        await assert.rejects(client("schema-invalid", false).complete(messages, { responseSchema: { name: "shape", schema: shape } }), error => error instanceof ChatCompletionError && error.code === "LLM_RESPONSE_INVALID");
        assert.equal(callStore.recent().at(-1)!.status, "error", "invalid restoration cannot be reported as a completed proposal");
      }
      const beforeUsage = usageStore.summary().totals.requests;
      await assert.rejects(client("truncated-json", false).complete(messages), error => error instanceof ChatCompletionError && error.code === "LLM_OUTPUT_TRUNCATED");
      assert.equal(usageStore.summary().totals.requests, beforeUsage + 1, "rejected but billable output is counted exactly once");
      assert.equal(usageStore.recent(1)[0]!.cachedTokens, 60);
      assert.equal((callStore.recent().at(-1)!.usage as any).total_tokens, 107);
      for (const [model, code] of [["remote-error", "LLM_REMOTE_ERROR"], ["incomplete", "LLM_STREAM_INCOMPLETE"], ["bad-continuous", "LLM_RESPONSE_INVALID"]]) {
        await assert.rejects(client(model!).complete(messages), error => error instanceof ChatCompletionError && error.code === code);
        const call = callStore.recent().at(-1)!; assert.equal(call.status, "error"); assert.ok(callStore.detail(call.callId)!.responseText);
      }
      await assert.rejects(client("status-error").complete(messages), /\(401\)/);
      assert.equal(callStore.recent().at(-1)!.httpStatus, 401);
      const abort = new AbortController(), pending = client("abort").complete(messages, { signal: abort.signal });
      const timer = setTimeout(() => abort.abort(), 50);
      try { await assert.rejects(pending); } finally { clearTimeout(timer); }
      assert.equal(callStore.recent().at(-1)!.status, "cancelled");
    }
    assert.deepEqual(messages, original, "protocol translation never rewrites persisted messages");
    console.log("PASS native API transport: protocol URLs/auth, exact raw traces, SSE/JSON, Unicode and ordered media, immutable prefixes, cache accounting, error/cancellation lifecycle; loopback only.");
  } finally {
    release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
