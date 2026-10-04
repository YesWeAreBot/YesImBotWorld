import assert from "node:assert/strict";
import { Response } from "undici";
import { anthropicAdapter as adapter } from "../src/llm/anthropic.js";
import { ChatCompletionError, UnsupportedProtocolModalityError } from "../src/llm/errors.js";
import type { ChatClientConfig, ChatMessage, ChatToolDef } from "../src/llm/chat.js";
import type { ProtocolProgress } from "../src/llm/protocol.js";

const config: ChatClientConfig = { baseURL: "https://example.invalid/v1", model: "claude-test", temperature: 0.7, maxTokens: 999, disableThinking: true };
const tools: ChatToolDef[] = [{ type: "function", function: { name: "act", description: "Act", parameters: {
  type: "object", additionalProperties: false, properties: { intent: { type: "string" }, optional: { type: "boolean" } }, required: ["intent"],
} } }];
const toolCall = (id = "call1", name = "act", args = '{"intent":"走走"}') => ({ id, type: "function" as const, function: { name, arguments: args } });
const image = (url: string) => ({ type: "image_url" as const, image_url: { url } });
const messages: ChatMessage[] = [
  { role: "system", content: "稳定前缀" }, { role: "system", content: "工具边界" },
  { role: "user", content: [{ type: "text", text: "甲" }, image("https://example.invalid/image.png"), { type: "text", text: "乙" }, image("data:image/png;base64,YWJj"), { type: "text", text: "丙" }] },
  { role: "assistant", content: "", tool_calls: [toolCall()] },
  { role: "tool", tool_call_id: "call1", content: [{ type: "text", text: "结果" }, image("https://example.invalid/result.png")] },
  { role: "system", content: "后来追加的事实" }, { role: "user", content: "后文" },
];
function code(expected: string) { return (error: unknown) => error instanceof ChatCompletionError && error.code === expected; }
function response(content: unknown[] = [{ type: "text", text: "你好" }], stop_reason: unknown = "end_turn", extra = {}) {
  return { type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 50, output_tokens: 9 }, ...extra };
}
const frame = (value: Record<string, unknown>, event = String(value.type)) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const start = () => ({ type: "message_start", message: response([], null, { usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 50, output_tokens: 1 } }) });
const blockStart = (index: number, content_block: Record<string, unknown>) => ({ type: "content_block_start", index, content_block });
const delta = (index: number, value: Record<string, unknown>) => ({ type: "content_block_delta", index, delta: value });
const blockStop = (index: number) => ({ type: "content_block_stop", index });
const end = (stop_reason: unknown = "end_turn", output_tokens = 9) => ({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } });
const stop = { type: "message_stop" };
const textEvents = () => [start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "你好" }), blockStop(0), end(), stop];
function sse(events: Record<string, unknown>[], suffix = "") { return new Response(events.map(value => frame(value)).join("") + suffix, { headers: { "content-type": "text/event-stream" } }); }

async function main() {
  const before = JSON.stringify({ messages, tools });
  const request: any = adapter.buildRequest(config, messages, { tools, toolChoice: { type: "function", function: { name: "act" } } }, true);
  assert.equal(JSON.stringify({ messages, tools }), before, "mapping never mutates the cached input or tool definition");
  assert.equal(request.max_tokens, 999); assert.equal(request.stream, true); assert.equal(request.temperature, undefined);
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.equal(request.system.length, 2); assert.equal(request.system[0].cache_control, undefined);
  assert.deepEqual(request.system[1].cache_control, { type: "ephemeral" });
  assert.deepEqual(request.messages[0].content.map((part: any) => part.type), ["text", "image", "text", "image", "text"]);
  assert.deepEqual(request.messages[0].content[3].source, { type: "base64", media_type: "image/png", data: "YWJj" });
  assert.deepEqual(request.messages[1].content, [{ type: "tool_use", id: "call1", name: "act", input: { intent: "走走" } }]);
  assert.equal(request.messages[2].content[0].type, "tool_result");
  assert.deepEqual(request.messages[2].content[0].content.map((part: any) => part.type), ["text", "image"]);
  assert.match(request.messages[3].content[0].text, /原 system 消息/); assert.equal(request.messages[3].content[1].text, "后来追加的事实");
  assert.equal(request.messages[4].content[0].text, "后文");
  assert.deepEqual(request.tools[0].input_schema.required, ["intent"]); assert.equal(request.tools[0].strict, undefined);
  assert.deepEqual(request.tool_choice, { type: "tool", name: "act" });
  const appended: any = adapter.buildRequest(config, [...messages, { role: "user", content: "又一条" }], { tools }, true);
  assert.deepEqual(appended.messages.slice(0, -1), request.messages, "appending cannot rewrite prior same-role boundaries");
  assert.deepEqual(appended.system, request.system);
  assert.equal((adapter.buildRequest({ ...config, disableThinking: false }, [{ role: "user", content: "x" }], {}, false) as any).thinking, undefined);
  const schema = { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false };
  const structured: any = adapter.buildRequest(config, [{ role: "user", content: "x" }], { responseFormat: "json_schema", responseSchema: { name: "result", schema }, maxTokens: 321 }, false);
  assert.deepEqual(structured.output_config.format, { type: "json_schema", schema }); assert.equal(structured.max_tokens, 321);
  structured.output_config.format.schema.properties.result.type = "boolean"; assert.equal(schema.properties.result.type, "string");
  assert.throws(() => adapter.buildRequest(config, messages, { responseFormat: "json_object" }, false), /json_schema 或 text/);
  assert.throws(() => adapter.buildRequest(config, messages, { responseFormat: "json_schema" }, false), /responseSchema/);
  assert.throws(() => adapter.buildRequest(config, messages, { tools, toolChoice: { type: "function", function: { name: "absent" } } }, false), /不在/);
  for (const part of [{ type: "input_audio" as const, input_audio: { data: "YQ==", format: "wav" } }, { type: "video_url" as const, video_url: { url: "https://example.invalid/v.mp4" } }]) {
    assert.throws(() => adapter.buildRequest(config, [{ role: "user", content: [part] }], {}, false), error => error instanceof UnsupportedProtocolModalityError && error.status === 400 && error.message.includes(part.type));
  }
  assert.throws(() => adapter.buildRequest(config, [{ role: "system", content: [image("https://example.invalid/x.png")] }, messages[2]!], {}, false), UnsupportedProtocolModalityError);
  const invalidHistories: ChatMessage[][] = [
    [{ role: "tool", tool_call_id: "missing", content: "x" }],
    [{ role: "assistant", content: "", tool_calls: [toolCall()] }],
    [{ role: "assistant", content: "", tool_calls: [toolCall()] }, { role: "user", content: "x" }],
    [{ role: "assistant", content: "", tool_calls: [toolCall(), toolCall()] }],
    [{ role: "assistant", content: "", tool_calls: [toolCall("bad", "act", "[]")] }],
    [{ role: "user", content: "" }],
  ];
  for (const history of invalidHistories) assert.throws(() => adapter.buildRequest(config, history, {}, false));
  const parallel: any = adapter.buildRequest(config, [{ role: "assistant", content: "", tool_calls: [toolCall("a"), toolCall("b")] }, { role: "tool", tool_call_id: "a", content: "a" }, { role: "tool", tool_call_id: "b", content: "b" }], {}, false);
  assert.equal(parallel.messages.length, 3); assert.equal(parallel.messages[2].content[0].tool_use_id, "b");

  const complete = adapter.decodeResponse(response([{ type: "thinking", thinking: "推敲", signature: "opaque" }, { type: "text", text: "去散步" }, { type: "tool_use", id: "a", name: "act", input: { intent: "走走" } }], "tool_use"));
  assert.equal(complete.content, "去散步"); assert.equal(complete.reasoning, "推敲"); assert.equal(complete.finishReason, "tool_use");
  assert.equal(complete.usage?.prompt_tokens, 100); assert.equal(complete.usage?.total_tokens, 109); assert.equal(complete.usage?.cached_tokens, 50);
  assert.equal(complete.usage?.cache_reported, true); assert.equal(complete.toolCalls[0]?.function.arguments, '{"intent":"走走"}');
  assert.equal(adapter.decodeResponse(response([])).content, "");
  assert.equal(adapter.decodeResponse(response([], "end_turn", { usage: { output_tokens: 0 } })).usage?.prompt_tokens, undefined);
  assert.equal(adapter.decodeResponse(response([], "end_turn", { usage: { input_tokens: 5, output_tokens: 0 } })).usage?.cache_reported, undefined);
  for (const reason of ["max_tokens", "model_context_window_exceeded"]) assert.throws(() => adapter.decodeResponse(response([], reason)), code("LLM_OUTPUT_TRUNCATED"));
  assert.throws(() => adapter.decodeResponse(response([], "max_tokens")), error => code("LLM_OUTPUT_TRUNCATED")(error) && (error as ChatCompletionError).usage?.total_tokens === 109);
  assert.throws(() => adapter.decodeResponse(response([], "refusal", { usage: { input_tokens: -1 } })), code("LLM_CONTENT_FILTERED"), "bad accounting does not conceal refusal");
  for (const reason of [null, "pause_turn", "unknown"]) assert.throws(() => adapter.decodeResponse(response([], reason)), code("LLM_STREAM_INCOMPLETE"));
  assert.throws(() => adapter.decodeResponse(response([], "refusal")), code("LLM_CONTENT_FILTERED"));
  assert.throws(() => adapter.decodeResponse(response([], "end_turn", { stop_details: { type: "refusal" } })), code("LLM_CONTENT_FILTERED"));
  for (const content of [[{ type: "server_tool_use", id: "web", name: "web_search", input: {} }], [{ type: "tool_use", id: "a", name: "act", input: [] }], [{ type: "text" }]]) {
    assert.throws(() => adapter.decodeResponse(response(content)), code("LLM_RESPONSE_INVALID"));
  }
  assert.throws(() => adapter.decodeResponse(response([{ type: "tool_use", id: "a", name: "act", input: {} }])), code("LLM_RESPONSE_INVALID"));
  assert.throws(() => adapter.decodeResponse(response([], "tool_use")), code("LLM_RESPONSE_INVALID"));
  assert.throws(() => adapter.decodeResponse(response([], "end_turn", { usage: { input_tokens: -1 } })), code("LLM_RESPONSE_INVALID"));
  assert.throws(() => adapter.decodeResponse({ type: "error", error: { type: "overloaded_error", message: "busy" } }), code("LLM_REMOTE_ERROR"));

  const events = [start(), { type: "ping" }, { type: "new_metadata", value: 42 },
    blockStart(0, { type: "thinking", thinking: "" }), delta(0, { type: "thinking_delta", thinking: "推敲" }), delta(0, { type: "signature_delta", signature: "opaque" }), blockStop(0),
    blockStart(1, { type: "text", text: "" }), delta(1, { type: "text_delta", text: "去散步" }), blockStop(1),
    blockStart(2, { type: "tool_use", id: "a", name: "act", input: {} }), delta(2, { type: "input_json_delta", partial_json: '{"intent":' }), delta(2, { type: "input_json_delta", partial_json: '"走走"}' }), blockStop(2),
    { type: "message_delta", delta: {}, usage: { output_tokens: 5 } }, end("tool_use"), stop];
  const progress: ProtocolProgress[] = []; let raw = "";
  const streamed = await adapter.readStream(sse(events), value => progress.push(value), value => { raw += value; });
  assert.deepEqual(streamed, complete); assert.equal(raw, events.map(value => frame(value)).join(""));
  assert.equal(progress.filter(value => value.complete).length, 1); assert.equal(progress.at(-1)?.complete, true);
  assert.ok(progress.some(value => value.toolCalls[0]?.function.arguments.includes("intent")));
  assert.ok(!JSON.stringify(progress).includes("opaque")); assert.equal(streamed.usage?.completion_tokens, 9, "message_delta output counts are cumulative");
  const noArgs = [start(), blockStart(0, { type: "tool_use", id: "noop", name: "help", input: {} }), delta(0, { type: "input_json_delta", partial_json: "" }), blockStop(0), end("tool_use"), stop];
  assert.equal((await adapter.readStream(sse(noArgs), () => {})).toolCalls[0]?.function.arguments, "{}");
  const redacted = await adapter.readStream(sse([start(), blockStart(0, { type: "redacted_thinking", data: "secret" }), blockStop(0), end(), stop]), () => {});
  assert.equal(redacted.content, ""); assert.equal(redacted.reasoning, undefined);

  // Split every UTF-8 byte, exercise CRLF, multiline SSE data, and the final EOF frame.
  const wire = textEvents().map(value => `event: ${value.type}\r\ndata: ${JSON.stringify(value, null, 2).split("\n").join("\r\ndata: ")}\r\n\r\n`).join("").trimEnd();
  const bytes = Buffer.from(wire); let offset = 0; let wireSeen = "";
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset)); else controller.close(); } });
  const split = await adapter.readStream(new Response(body as any, { headers: { "content-type": "text/event-stream" } }), () => {}, value => { wireSeen += value; });
  assert.equal(split.content, "你好"); assert.equal(wireSeen, wire);
  assert.equal((await adapter.readStream(new Response(JSON.stringify(response()), { headers: { "content-type": "application/json" } }), () => {})).content, "你好");

  const failures: [Record<string, unknown>[], string][] = [
    [[], "LLM_STREAM_INCOMPLETE"], [textEvents().slice(0, -1), "LLM_STREAM_INCOMPLETE"],
    [[blockStart(0, { type: "text", text: "" })], "LLM_RESPONSE_INVALID"],
    [[start(), blockStart(1, { type: "text", text: "" })], "LLM_RESPONSE_INVALID"],
    [[start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "thinking_delta", thinking: "x" })], "LLM_RESPONSE_INVALID"],
    [[...textEvents(), blockStop(0)], "LLM_RESPONSE_INVALID"],
    [[start(), blockStart(0, { type: "text", text: "" }), blockStop(0), blockStop(0)], "LLM_RESPONSE_INVALID"],
    [[start(), end(null), stop], "LLM_STREAM_INCOMPLETE"],
    [[start(), end("max_tokens"), stop], "LLM_OUTPUT_TRUNCATED"],
    [[start(), end("refusal"), stop], "LLM_CONTENT_FILTERED"],
    [[start(), { type: "error", error: { type: "overloaded_error", message: "busy" } }], "LLM_REMOTE_ERROR"],
    [[...textEvents(), { type: "error", error: { message: "late failure" } }], "LLM_REMOTE_ERROR"],
  ];
  for (const [frames, expected] of failures) await assert.rejects(adapter.readStream(sse(frames), () => {}), code(expected));
  const broken = [start(), blockStart(0, { type: "tool_use", id: "a", name: "act", input: {} }), delta(0, { type: "input_json_delta", partial_json: '{"intent":' }), blockStop(0)];
  await assert.rejects(adapter.readStream(sse([...broken, end("tool_use"), stop]), () => {}), code("LLM_RESPONSE_INVALID"));
  await assert.rejects(adapter.readStream(sse([...broken, end("max_tokens"), stop]), () => {}), code("LLM_OUTPUT_TRUNCATED"));
  await assert.rejects(adapter.readStream(sse([...broken, end("max_tokens"), stop]), () => {}), error => code("LLM_OUTPUT_TRUNCATED")(error) && (error as ChatCompletionError).usage?.total_tokens === 109);
  await assert.rejects(adapter.readStream(sse(textEvents().slice(0, -1)), () => {}), error => code("LLM_STREAM_INCOMPLETE")(error) && (error as ChatCompletionError).usage?.total_tokens === 109);
  await assert.rejects(adapter.readStream(new Response(JSON.stringify(response([], "max_tokens")), { headers: { "content-type": "application/json" } }), () => {}), error => code("LLM_OUTPUT_TRUNCATED")(error) && (error as ChatCompletionError).usage?.total_tokens === 109, "JSON fallback retains its decoded usage through stream catch");
  let cancelled = false;
  const hanging = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("event: message_start\ndata: {bad}\n\n")); }, cancel() { cancelled = true; } });
  await assert.rejects(adapter.readStream(new Response(hanging as any, { headers: { "content-type": "text/event-stream" } }), () => {}), code("LLM_RESPONSE_INVALID"));
  assert.equal(cancelled, true, "invalid streams must release their transport reader");
  console.log("PASS Anthropic native request/media/history/cache mapping, stream deltas/usage/integrity and explicit errors (offline)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
