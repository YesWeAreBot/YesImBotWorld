/** Anonymous protocol fixtures reproduce body-only proposals and truncated native SSE. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ChatClient, type ChatResult } from "../src/llm/chat.js";
import { parseWorldResponse } from "../src/world/response.js";

const proposal = {
  externalChanges: [{ id: "wind", description: "院子里起了一阵风。" }],
  perceptions: [{ actorId: "bot", changeIds: ["wind"], text: "你听见树叶沙沙作响。" }],
  worldState: "院子里的树叶被风吹动。",
};
const content = (value: string): ChatResult => ({ content: value, toolCalls: [] });
const native = (argumentsText: string, name = "resolve_world"): ChatResult => ({ content: "", toolCalls: [{
  id: "fixture-call", type: "function", function: { name, arguments: argumentsText },
}] });

function decoding() {
  const text = JSON.stringify(proposal);
  for (const result of [native(text), content(text), content(` \n${text}\n `),
    content(JSON.stringify({ name: "resolve_world", arguments: proposal })),
    content(JSON.stringify({ name: "resolve_world", arguments: text }))]) {
    const before = structuredClone(result), parsed = parseWorldResponse(result);
    assert.deepEqual(parsed.value, proposal);
    assert.equal(parsed.format, result.toolCalls.length ? "native" : "json");
    assert.deepEqual(result, before, "decoding never replaces the raw audit response");
  }
  const untouched = { perceptions: [{ actorId: "bot", situation: "树叶在动。" }] };
  assert.deepEqual(parseWorldResponse(content(JSON.stringify(untouched))).value, untouched,
    "the protocol adapter must not invent missing text, external causes or any other semantic field");
  const truncated = '{"perceptions":[],"worldState":"anonymous-state","externalChanges": ';
  const invalid: ChatResult[] = [
    ...["", " ", "null", "[]", '[{},{}]', "false", "1", '"{}"', text + text, text + "\n解释文字", "说明：" + text,
      "```json\n" + text + "\n```", truncated,
      JSON.stringify({ name: "other", arguments: proposal }), JSON.stringify({ name: "resolve_world" }),
      JSON.stringify({ arguments: proposal }), JSON.stringify({ name: "resolve_world", arguments: proposal, extra: true }),
      ...[null, [], 1, "null", "[]", truncated].map(args => JSON.stringify({ name: "resolve_world", arguments: args })),
    ].map(content),
    native(truncated), native("[]"), native("null"), native(text, "other"),
    { ...native(truncated), content: text },
    { ...native(text, "other"), content: text },
    { content: text, toolCalls: [...native(text).toolCalls, ...native(text).toolCalls] },
  ];
  for (const result of invalid) assert.throws(() => parseWorldResponse(result), /^Error: WORLD_RESPONSE_(JSON|PROTOCOL):/);
  assert.throws(() => parseWorldResponse(native('{"private":"never-echo-this-secret"')), error => {
    assert.ok(error instanceof Error); assert.ok(error.message.length < 160); assert.doesNotMatch(error.message, /never-echo-this-secret/); return true;
  });
  console.log("PASS world protocol: native/whole JSON, strict envelopes, no fallback from invalid native calls and no automatic fact repair");
}

function sse(result: ChatResult): string {
  const deltas: unknown[] = [{ role: "assistant", content: "" }];
  for (let index = 0; index < result.content.length; index += 7) deltas.push({ content: result.content.slice(index, index + 7) });
  result.toolCalls.forEach((call, index) => {
    deltas.push({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] });
    for (let offset = 0; offset < call.function.arguments.length; offset += 9) {
      deltas.push({ tool_calls: [{ index, function: { arguments: call.function.arguments.slice(offset, offset + 9) } }] });
    }
  });
  return deltas.map(delta => "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + "\r\n\r\n").join("") +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
}

async function streamingTransport() {
  const text = JSON.stringify(proposal);
  const cases = [content(text), native(text), content(JSON.stringify({ name: "resolve_world", arguments: text })),
    native('{"perceptions":[],"worldState":"anonymous-state","externalChanges": '),
    { ...native('{"perceptions":'), content: text }, content("```json\n" + text + "\n```")];
  let count = 0;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const piece of request) body += piece;
    assert.deepEqual(JSON.parse(body).tool_choice, { type: "function", function: { name: "resolve_world" } });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse(cases[count++]!));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const client = new ChatClient({ baseURL: `http://127.0.0.1:${address.port}`, model: "fixture-only", label: "WorldProtocolTest" });
    for (let index = 0; index < cases.length; index++) {
      const result = await client.complete([{ role: "user", content: "anonymous fixture" }], {
        tools: [{ type: "function", function: { name: "resolve_world", description: "fixture", parameters: { type: "object" } } }],
        toolChoice: { type: "function", function: { name: "resolve_world" } },
      });
      assert.deepEqual(result, cases[index], "SSE reconstruction preserves the real transport shape, including malformed arguments");
      if (index < 3) assert.deepEqual(parseWorldResponse(result).value, proposal);
      else assert.throws(() => parseWorldResponse(result), /WORLD_RESPONSE_JSON/);
    }
    assert.equal(count, cases.length, "the adapter neither retries requests nor performs inference");
    console.log("PASS fake loopback ChatClient SSE: body-only/native/envelope accepted; normal-stop truncation, native/body conflict and fences rejected");
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function main() { decoding(); await streamingTransport(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
