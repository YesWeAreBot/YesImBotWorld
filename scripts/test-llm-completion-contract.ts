import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatClient, ChatCompletionError, type ChatMessage } from "../src/llm/chat.js";
import { callStore } from "../src/webui/calls.js";

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "llm-contract-"));
  const release = callStore.init(directory);
  const received: any[] = [];
  let closeMalformedStream!: () => void;
  const malformedStreamClosed = new Promise<void>(resolve => { closeMalformedStream = resolve; });
  const frame = (content: string, finish_reason: string | null = null) => "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] }) + "\n\n";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push(body);
    if (body.model === "empty-error" && !body.stream || body.model === "empty-error-json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "", type: "InternalServerError", param: null, code: 500 } }));
      return;
    }
    if (!body.stream || body.model === "json-fallback") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: body.model === "normal" ? "stop" : "length" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    switch (body.model) {
      case "normal": res.end(frame('{"ok":true}', "stop") + "data: [DONE]\n\n"); break;
      case "length":
        res.end(frame('{"ok":true}') + 'data: {"choices":[{"index":0,"finish_reason":"length"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\ndata: [DONE]\n\n'); break;
      case "filtered": res.end(frame("", "content_filter") + "data: [DONE]\n\n"); break;
      case "incomplete": res.end(frame('{"ok":true}')); break;
      case "legacy-done": res.end(frame("legacy") + "data: [DONE]\n\n"); break;
      case "remote-error": res.end('data: {"error":{"message":"worker failed"}}\n\n'); break;
      case "empty-error": res.end('data: {"error":{"message":"","type":"InternalServerError","param":null,"code":500}}\n\n'); break;
      case "string-error": res.end('data: {"error":"upstream worker unavailable"}\n\n'); break;
      case "bad-frame": res.end(frame("first") + 'data: {not-json}\n\n' + frame("last", "stop")); break;
      case "bad-frame-continuous": {
        res.write(frame("first") + 'data: {not-json}\n\n');
        const timer = setInterval(() => res.write(frame("still generating")), 10);
        res.once("close", () => { clearInterval(timer); closeMalformedStream(); });
        break;
      }
      default: res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = (model: string, stream = true) => new ChatClient({ baseURL: `http://127.0.0.1:${address.port}/v1`, model, stream, label: "ContractTest" });
  const messages: ChatMessage[] = [{ role: "system", content: "Existing fixed prefix." }, { role: "user", content: "Return JSON." }];
  const original = structuredClone(messages);
  const responseSchema = { name: "result", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
  try {
    assert.equal((await client("normal").complete(messages, { responseSchema })).content, '{"ok":true}');
    assert.deepEqual(received.at(-1).response_format, { type: "json_schema", json_schema: { ...responseSchema, strict: true } });
    assert.equal(received.at(-1).tools, undefined);
    assert.ok(received.at(-1).messages.at(-1).content.includes(JSON.stringify(responseSchema.schema)));
    assert.deepEqual(received.at(-1).messages.slice(0, -1), original);
    assert.deepEqual(messages, original, "a result contract must never rewrite the persistent prefix");
    await client("normal").complete(messages, { responseSchema, responseFormat: "json_object" });
    assert.deepEqual(received.at(-1).response_format, { type: "json_object" });
    assert.ok(received.at(-1).messages.at(-1).content.includes('"required"'));
    await client("normal").complete(messages, { responseSchema, responseFormat: "text", responseSchemaInPrompt: false });
    assert.equal(received.at(-1).response_format, undefined);
    assert.deepEqual(received.at(-1).messages, original);
    const before = received.length;
    await assert.rejects(client("normal").complete(messages, { responseSchema, tools: [{ type: "function", function: { name: "test", description: "", parameters: {} } }] }), /不能同时/);
    assert.equal(received.length, before, "ambiguous protocols must fail before sending");

    for (const [model, code, stream] of [
      ["length", "LLM_OUTPUT_TRUNCATED", true], ["length", "LLM_OUTPUT_TRUNCATED", false],
      ["json-fallback", "LLM_OUTPUT_TRUNCATED", true], ["filtered", "LLM_CONTENT_FILTERED", true],
      ["incomplete", "LLM_STREAM_INCOMPLETE", true], ["remote-error", "LLM_REMOTE_ERROR", true],
      ["empty-error", "LLM_REMOTE_ERROR", true], ["empty-error", "LLM_REMOTE_ERROR", false],
      ["empty-error-json", "LLM_REMOTE_ERROR", true], ["string-error", "LLM_REMOTE_ERROR", true],
      ["bad-frame", "LLM_RESPONSE_INVALID", true],
    ] as const) {
      await assert.rejects(client(model, stream).complete(messages), error => error instanceof ChatCompletionError && error.code === code);
      const call = callStore.recent().find(c => c.model === model)!;
      assert.equal(call.status, "error"); assert.match(call.error!, new RegExp(code));
      const detail = callStore.detail(call.callId);
      assert.ok(detail?.requestBody); assert.ok(detail?.responseText, "failed raw response remains inspectable");
      if (code === "LLM_OUTPUT_TRUNCATED") { assert.equal(call.finishReason, "length"); assert.equal((call.usage as any).completion_tokens, 4); }
      if (model.startsWith("empty-error")) {
        assert.match(call.error!, /InternalServerError/); assert.match(call.error!, /code=500/);
        assert.match(call.error!, /未提供具体错误原因/);
        assert.equal(call.httpStatus, 200, "a successful HTTP status cannot hide a provider's error payload");
      }
      if (model === "string-error") assert.match(call.error!, /upstream worker unavailable/);
    }
    await assert.rejects(client("bad-frame-continuous").complete(messages), error => error instanceof ChatCompletionError && error.code === "LLM_RESPONSE_INVALID");
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        malformedStreamClosed,
        new Promise<never>((_, reject) => { closeTimeout = setTimeout(() => reject(new Error("Malformed SSE must close its still-generating transport")), 1000); }),
      ]);
    } finally { clearTimeout(closeTimeout); }
    const malformedCall = callStore.recent().find(c => c.model === "bad-frame-continuous")!;
    assert.equal(malformedCall.status, "error");
    assert.match(malformedCall.error!, /LLM_RESPONSE_INVALID/, "transport cancellation must preserve the parse failure");
    assert.match(callStore.detail(malformedCall.callId)!.responseText!, /not-json/, "the rejected raw frame remains inspectable");
    assert.equal((await client("legacy-done").complete(messages)).content, "legacy", "DONE remains a valid legacy termination marker");
    console.log("PASS completion contracts: constrained JSON, immutable prefixes, stream/nonstream truncation, EOF, filter, malformed and error frames; rejected continuous SSE closes upstream; isolated HTTP only.");
  } finally {
    release(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
