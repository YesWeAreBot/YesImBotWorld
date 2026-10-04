/** Responses protocol fixtures only: no endpoint, key, model invocation or saved-world mutation. */
import assert from "node:assert/strict";
import { Response } from "undici";
import { responsesAdapter } from "../src/llm/responses.js";
import { ChatCompletionError, UnsupportedProtocolModalityError } from "../src/llm/errors.js";
import type { ChatMessage, ChatToolDef } from "../src/llm/chat.js";
import type { ProtocolProgress } from "../src/llm/protocol.js";

const config = { baseURL: "https://invalid.example/v1", model: "fixture-responses", temperature: 0.3, maxTokens: 512 };
const tool: ChatToolDef = { type: "function", function: { name: "send", description: "发送消息", parameters: {
  type: "object", properties: { msg: { type: "string" }, id: { type: "string" } }, required: ["msg"], additionalProperties: false,
} } };
const imageA = "data:image/png;base64,QUFB", imageB = "https://invalid.example/b.png";
const functionItem = (args = '{"msg":"你好"}', id = "call_1") => ({ type: "function_call", id: "fc_1", call_id: id, name: "send", arguments: args, status: "completed" });
const messageItem = (text = "正文") => ({ type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const completed = (output: unknown[] = [messageItem()]) => ({ id: "resp_1", status: "completed", output,
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 12, total_tokens: 112 } });
const errorCode = (code: string) => (error: unknown) => error instanceof ChatCompletionError && error.code === code;
const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });
function wire(events: unknown[]): string { return events.map(value => `event: ${(value as any).type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join(""); }
async function stream(events: unknown[], progress: ProtocolProgress[] = []) {
  return responsesAdapter.readStream(new Response(wire(events), { headers: { "content-type": "text/event-stream" } }), value => progress.push(value));
}

function requests() {
  const messages: ChatMessage[] = [
    { role: "system", content: "这是原始固定块，不要变动。" },
    { role: "user", content: [{ type: "text", text: "图A在这里" }, { type: "image_url", image_url: { url: imageA } },
      { type: "text", text: "图B在下一位置" }, { type: "image_url", image_url: { url: imageB } }, { type: "text", text: "保持顺序" }] },
    { role: "assistant", content: "我先看看", tool_calls: [{ id: "call_history", type: "function", function: { name: "look", arguments: '{"id":"A"}' } }] },
    { role: "tool", tool_call_id: "call_history", content: [{ type: "text", text: "结果的原图" }, { type: "image_url", image_url: { url: imageA } }] },
    { role: "assistant", content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_2", content: "内容" },
    { role: "system", content: "追加的最新能力变化。" },
  ];
  const before = JSON.stringify(messages), toolBefore = JSON.stringify(tool);
  const request = responsesAdapter.buildRequest(config, messages, { tools: [tool], toolChoice: { type: "function", function: { name: "send" } }, maxTokens: 800 }, true) as any;
  assert.equal(request.store, false); assert.equal(request.truncation, "disabled"); assert.equal(request.stream, true);
  assert.equal(request.max_output_tokens, 800); assert.equal(request.temperature, undefined);
  for (const absent of ["previous_response_id", "conversation", "messages", "instructions", "stream_options", "max_tokens"]) assert.equal(request[absent], undefined);
  assert.deepEqual(request.input, [
    { role: "system", content: messages[0]!.content },
    { role: "user", content: [{ type: "input_text", text: "图A在这里" }, { type: "input_image", image_url: imageA, detail: "auto" },
      { type: "input_text", text: "图B在下一位置" }, { type: "input_image", image_url: imageB, detail: "auto" }, { type: "input_text", text: "保持顺序" }] },
    { role: "assistant", content: "我先看看" },
    { type: "function_call", call_id: "call_history", name: "look", arguments: '{"id":"A"}' },
    { type: "function_call_output", call_id: "call_history", output: [{ type: "input_text", text: "结果的原图" }, { type: "input_image", image_url: imageA, detail: "auto" }] },
    { type: "function_call", call_id: "call_2", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_2", output: "内容" },
    { role: "system", content: "追加的最新能力变化。" },
  ]);
  assert.equal(request.tools[0].strict, false, "Responses must not implicitly make optional function fields required");
  assert.deepEqual(request.tools[0].parameters.required, ["msg"]);
  assert.deepEqual(request.tool_choice, { type: "function", name: "send" });
  request.tools[0].parameters.properties.id.type = "number";
  assert.equal(JSON.stringify(messages), before); assert.equal(JSON.stringify(tool), toolBefore, "mapping and consumer edits never mutate frozen source schemas");
  const next = responsesAdapter.buildRequest(config, [...messages, { role: "user", content: "只追加，不改前缀" }], {}, false) as any;
  assert.deepEqual(next.input.slice(0, -1), request.input, "stateless mapping preserves the previous request's entire input prefix");
  assert.equal(next.stream, false);
  const schema = { name: "world_result", schema: { type: "object", properties: { state: { type: "string" } }, required: ["state"], additionalProperties: false } };
  const structured = responsesAdapter.buildRequest(config, messages, { responseSchema: schema }, false) as any;
  assert.deepEqual(structured.text, { format: { type: "json_schema", ...schema, strict: true } });
  structured.text.format.schema.required.push("other"); assert.deepEqual(schema.schema.required, ["state"]);
  assert.deepEqual((responsesAdapter.buildRequest(config, [], { responseFormat: "json_object" }, false) as any).text, { format: { type: "json_object" } });
  assert.deepEqual(responsesAdapter.buildRequest({ ...config, disableThinking: true }, [], {}, false).reasoning, { effort: "none" });
  for (const part of [{ type: "input_audio", input_audio: { data: "QUFB", format: "wav" } }, { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } }] as const) {
    for (const role of ["user", "tool"] as const) assert.throws(() => responsesAdapter.buildRequest(config, [{ role, tool_call_id: "call_1", content: [part] }], {}, true),
      error => error instanceof UnsupportedProtocolModalityError && error.message.includes(part.type));
  }
  assert.throws(() => responsesAdapter.buildRequest(config, [{ role: "tool", content: "丢失身份" }], {}, false), errorCode("LLM_RESPONSE_INVALID"));
}

function responses() {
  const result = responsesAdapter.decodeResponse(completed([{ type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "推理摘要" }] }, messageItem(), functionItem()]));
  assert.equal(result.content, "正文"); assert.equal(result.reasoning, "推理摘要"); assert.equal(result.complete, true);
  assert.deepEqual(result.toolCalls, [{ id: "call_1", type: "function", function: { name: "send", arguments: '{"msg":"你好"}' } }]);
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, prompt_tokens_details: { cached_tokens: 60 } });
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(responsesAdapter.decodeResponse(completed()).finishReason, "stop");
  assert.equal(responsesAdapter.decodeResponse({ ...completed(), usage: { input_tokens: 4, output_tokens: 2 } }).usage?.total_tokens, 6);
  assert.equal(responsesAdapter.decodeResponse({ ...completed(), usage: null }).usage, null);
  assert.deepEqual(responsesAdapter.decodeResponse({ ...completed(), usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } }).usage?.prompt_tokens_details,
    { cached_tokens: 0 }, "zero cache hits remain explicitly reported rather than becoming unavailable");
  assert.throws(() => responsesAdapter.decodeResponse({ status: "failed", error: { message: "upstream failed", code: "bad-model" } }), errorCode("LLM_REMOTE_ERROR"));
  assert.throws(() => responsesAdapter.decodeResponse({ ...completed(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), errorCode("LLM_OUTPUT_TRUNCATED"));
  assert.throws(() => responsesAdapter.decodeResponse({ ...completed(), status: "incomplete", incomplete_details: { reason: "content_filter" } }), errorCode("LLM_CONTENT_FILTERED"));
  assert.throws(() => responsesAdapter.decodeResponse({ ...completed(), status: "in_progress" }), errorCode("LLM_STREAM_INCOMPLETE"));
  assert.throws(() => responsesAdapter.decodeResponse(completed([{ type: "reasoning", summary: [{ type: "summary_text", text: "不是正文" }] }])), errorCode("LLM_RESPONSE_INVALID"));
  assert.throws(() => responsesAdapter.decodeResponse(completed([{ ...messageItem(), status: "in_progress" }])), errorCode("LLM_STREAM_INCOMPLETE"));
  assert.throws(() => responsesAdapter.decodeResponse(completed([{ ...functionItem(), call_id: undefined }])), errorCode("LLM_RESPONSE_INVALID"));
  assert.throws(() => responsesAdapter.decodeResponse(completed([functionItem(), functionItem()])), errorCode("LLM_RESPONSE_INVALID"));
  assert.throws(() => responsesAdapter.decodeResponse(completed([{ ...messageItem(), content: [{ type: "refusal", refusal: "拒绝" }] }])), errorCode("LLM_CONTENT_FILTERED"));
  for (const rejected of [
    { ...completed(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    { ...completed(), status: 'failed', error: { message: 'failed after generation' } },
    { ...completed(), output: [{ ...messageItem(), content: [{ type: 'refusal', refusal: '拒绝' }] }] },
    { ...completed(), output: null },
  ]) assert.throws(() => responsesAdapter.decodeResponse(rejected), error => error instanceof ChatCompletionError && error.usage?.total_tokens === 112 && error.usage.prompt_tokens_details?.cached_tokens === 60,
    'rejecting a response preserves known usage without turning it into an executable result');
}

async function streams() {
  const updates: ProtocolProgress[] = [];
  const text = messageItem("你好"), call = functionItem();
  const events = [
    event("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
    event("response.output_item.added", { output_index: 0, item: { ...text, status: "in_progress", content: [] } }),
    event("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }),
    event("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "你", sequence_number: 4 }),
    event("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "你", sequence_number: 4 }),
    event("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "好", sequence_number: 5 }),
    event("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: "你好" }),
    event("response.content_part.done", { output_index: 0, content_index: 0, part: text.content[0] }),
    event("response.output_item.done", { output_index: 0, item: text }),
    event("response.output_item.added", { output_index: 1, item: { ...call, status: "in_progress", arguments: "" } }),
    event("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 1, delta: '{"msg":' }),
    event("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 1, delta: '"你好"}' }),
    event("response.function_call_arguments.done", { item_id: "fc_1", output_index: 1, arguments: call.arguments }),
    event("response.output_item.done", { output_index: 1, item: call }),
    event("response.completed", { response: completed([text, call]) }),
  ];
  const result = await stream(events, updates);
  assert.equal(result.content, "你好"); assert.equal(result.toolCalls.length, 1); assert.equal(result.toolCalls[0]!.function.arguments, call.arguments);
  assert.ok(updates.some(value => value.content === "你" && !value.complete));
  assert.ok(updates.some(value => value.toolCalls[0]?.function.arguments === '{"msg":' && !value.complete), "function argument deltas are visible before completion");
  assert.ok(updates.every(value => !value.content.includes("你你") && value.toolCalls.length <= 1));
  const before = updates[3]!.content; result.content = "changed"; assert.equal(updates[3]!.content, before, "progress snapshots are independent");
  const incompleteCall = updates.find(value => value.toolCalls[0]?.function.arguments === '{"msg":')!;
  assert.equal(incompleteCall.toolCalls[0]!.function.arguments, '{"msg":', "later argument deltas never mutate an earlier progress snapshot");
  incompleteCall.toolCalls[0]!.function.arguments = 'observer edit';
  assert.equal(updates.at(-1)!.toolCalls[0]!.function.arguments, call.arguments, "observer edits do not alter accumulated tool arguments");
  for (const ending of ["", "data: [DONE]\n\n"]) {
    await assert.rejects(responsesAdapter.readStream(new Response(wire(events.slice(0, -1)) + ending), () => {}), errorCode("LLM_STREAM_INCOMPLETE"));
  }
  await assert.rejects(stream([event("error", { message: "model unavailable", code: "503" })]), errorCode("LLM_REMOTE_ERROR"));
  await assert.rejects(stream([event("response.failed", { response: { status: "failed", error: { message: "decoder failed" } } })]), errorCode("LLM_REMOTE_ERROR"));
  await assert.rejects(stream([event("response.incomplete", { response: { ...completed(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })]), errorCode("LLM_OUTPUT_TRUNCATED"));
  await assert.rejects(stream([event("response.completed", { response: { ...completed(), status: "in_progress" } })]), errorCode("LLM_STREAM_INCOMPLETE"));
  await assert.rejects(stream([events[0], event("response.completed", { response: { ...completed(), id: "other" } })]), errorCode("LLM_RESPONSE_INVALID"));
  await assert.rejects(stream([events[9], event("response.completed", { response: completed([messageItem()]) })]), errorCode("LLM_RESPONSE_INVALID"));
  await assert.rejects(stream([event("response.function_call_arguments.delta", { output_index: 0, item_id: "missing", delta: "{}" })]), errorCode("LLM_RESPONSE_INVALID"));
  await assert.rejects(responsesAdapter.readStream(new Response("data: {broken}\n\n"), () => {}), errorCode("LLM_RESPONSE_INVALID"));
  const usageStart = event('response.created', { response: { id: 'resp_1', status: 'in_progress', usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } } });
  for (const end of [
    event('response.incomplete', { response: { ...completed(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
    event('response.failed', { response: { ...completed(), status: 'failed', error: { message: 'failed' } } }),
    event('response.completed', { response: { ...completed(), output: null } }),
  ]) await assert.rejects(stream([usageStart, end]), error => error instanceof ChatCompletionError && error.usage?.total_tokens === 112,
    'latest terminal usage is retained even though the action is rejected');
  await assert.rejects(stream([usageStart]), error => errorCode('LLM_STREAM_INCOMPLETE')(error) && (error as ChatCompletionError).usage?.total_tokens === 102);
  await assert.rejects(responsesAdapter.readStream(new Response(wire([usageStart]) + 'data: {broken}\n\n'), () => {}),
    error => errorCode('LLM_RESPONSE_INVALID')(error) && (error as ChatCompletionError).usage?.total_tokens === 102);
  await assert.rejects(responsesAdapter.readStream(new Response(JSON.stringify({ ...completed(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), { headers: { 'content-type': 'application/json' } }), () => {}),
    error => errorCode('LLM_OUTPUT_TRUNCATED')(error) && (error as ChatCompletionError).usage?.total_tokens === 112, 'JSON fallback retains rejection usage too');

  const reasoning: ProtocolProgress[] = [];
  const reason = { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "想想" }] };
  const onlyTool = await stream([
    event("response.output_item.added", { output_index: 0, item: { ...reason, summary: [] } }),
    event("response.reasoning_summary_text.delta", { output_index: 0, summary_index: 0, delta: "想" }),
    event("response.reasoning_summary_text.delta", { output_index: 0, summary_index: 0, delta: "想" }),
    event("response.output_item.done", { output_index: 0, item: reason }),
    event("response.completed", { response: completed([reason, functionItem()]) }),
  ], reasoning);
  assert.ok(reasoning.some(value => value.reasoning === "想想"));
  assert.ok(reasoning.every(value => value.content === ""), "reasoning and its summaries are never executable prose");
  assert.equal(onlyTool.toolCalls.length, 1);

  const callA = functionItem('{"msg":"A"}', "call_A"), callB = { ...functionItem('{"msg":"B"}', "call_B"), id: "fc_B" };
  const interleaved = await stream([
    event("response.output_item.added", { output_index: 1, item: { ...callB, status: "in_progress", arguments: "" } }),
    event("response.output_item.added", { output_index: 0, item: { ...callA, status: "in_progress", arguments: "" } }),
    event("response.function_call_arguments.delta", { output_index: 1, item_id: "fc_B", delta: '{"msg":' }),
    event("response.function_call_arguments.delta", { output_index: 0, item_id: "fc_1", delta: callA.arguments }),
    event("response.function_call_arguments.delta", { output_index: 1, item_id: "fc_B", delta: '"B"}' }),
    event("response.completed", { response: completed([callA, callB]) }),
  ]);
  assert.deepEqual(interleaved.toolCalls.map(call => [call.id, call.function.arguments]), [["call_A", callA.arguments], ["call_B", callB.arguments]], "interleaved function fragments retain output order and distinct call identity");
  await assert.rejects(stream([
    event("response.output_item.added", { output_index: 0, item: { ...callA, status: "in_progress", arguments: "" } }),
    event("response.function_call_arguments.delta", { output_index: 0, item_id: "fc_B", delta: "{}" }),
  ]), errorCode("LLM_RESPONSE_INVALID"));

  const raw = JSON.stringify(completed()); let capture = "";
  const fallback = await responsesAdapter.readStream(new Response(raw, { headers: { "content-type": "application/json" } }), () => {}, text => { capture += text; });
  assert.equal(fallback.content, "正文"); assert.equal(capture, raw, "JSON fallback retains original response bytes");
  const withoutMime = await responsesAdapter.readStream(new Response(JSON.stringify(completed(), null, 2)), () => {});
  assert.equal(withoutMime.content, "正文");
  const multiline = `event: response.completed\ndata: {"type":"response.completed",\ndata: "response":${raw}}\n\n`;
  assert.equal((await responsesAdapter.readStream(new Response(multiline), () => {})).content, "正文", "SSE multiline data obeys event framing");
}

async function main() {
  requests(); responses(); await streams();
  console.log("PASS Responses API: stateless frozen input, role/tool/schema mapping, ordered images and typed unsupported media, live deltas without duplicate finals, explicit terminal/error handling, cache usage and JSON/SSE fallback");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
