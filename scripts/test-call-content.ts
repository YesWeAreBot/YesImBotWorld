/** Pure captured-body decoding. Never invokes a browser, live LLM, world or chat service. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let parses = 0;
const sandbox: any = { JSON: { parse(value: string) { parses++; return JSON.parse(value); }, stringify: JSON.stringify } };
vm.runInNewContext(readFileSync('src/webui/client/call-content.js', 'utf8'), sandbox);
const api = sandbox.CallContent;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const frame = (data: unknown, separator = '\n') => 'data: ' + JSON.stringify(data) + separator + separator;
const delta = (value: unknown, index = 0) => ({ id: 'fixture', model: 'local-fixture', choices: [{ index, delta: value }] });

const multi = [{ type: 'text', text: 'data: 是正文，不是 SSE\n"引号"\\目录' }, { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }];
const request = api.request(JSON.stringify({ model: 'fixture', temperature: 0.5, messages: [
  { role: 'system', content: '世界规则\n第二行' }, { role: 'user', content: multi },
  { role: 'assistant', content: null, tool_calls: [{ id: 'tc', type: 'function', function: { name: 'act', arguments: '{"desc":"你好"}' } }] },
  { role: 'tool', content: '{"ok":true}', tool_call_id: 'tc', name: 'act' },
], tools: [{ type: 'function', function: { name: 'act', parameters: { type: 'object' } } }] }));
assert.deepEqual(plain(request.messages[1].content), multi, 'request content arrays keep their semantic structure');
assert.equal(request.messages[0].content, '世界规则\n第二行');
assert.equal(request.messages[2].toolCalls[0].function.arguments, '{"desc":"你好"}');
assert.equal(request.messages[3].toolCallId, 'tc');
assert.equal(request.settings.temperature, 0.5);
assert.equal(request.settings.messages, undefined);
assert.equal(request.tools[0].function.name, 'act');
assert(api.request('{bad').error); assert(api.request('[]').error);
assert.equal(api.request('{"functions":[{"name":"legacy"}]}').tools[0].function.name, 'legacy');
assert.equal(api.request('{"__proto__":{"polluted":true}}').settings.__proto__.polluted, true);
assert.equal(({} as any).polluted, undefined, 'untrusted JSON metadata never changes prototypes');

const chunks = [
  ': keep-alive\r\n\r\n',
  frame(delta({ role: 'assistant', reasoning_content: '思考' }), '\r\n'),
  frame(delta({ reasoning: '一下', content: '你' }), '\r\n'),
  frame(delta({ content: '好😀，data: 是正文。' })),
  frame(delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'select_', arguments: '{"channel":' } }, { index: 1, id: 'b', function: { name: 'observe', arguments: '{' } }] })),
  frame(delta({ tool_calls: [{ index: 1, function: { arguments: '}' } }, { index: 0, function: { name: 'channel', arguments: '"group:123"}' } }] })),
  frame(delta({ content: '另一个候选' }, 2)),
  'data: {"choices": [\r\ndata: {"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}\r\n\r\n',
  frame({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 } }),
  'data: [DONE]\r\n\r\n',
];
const raw = chunks.join('');
const decoder = api.createResponseDecoder();
const parseStart = parses;
for (let index = 0; index < raw.length; index++) {
  const current = decoder.update(raw.slice(0, index + 1), 'text/event-stream; charset=utf-8', true);
  assert(current.choices.length <= 2, 'character appends must never replay already consumed frames');
}
const result = decoder.update(raw, 'text/event-stream; charset=utf-8', false);
assert.equal(parses - parseStart, 8, 'incremental updates parse each completed JSON SSE frame exactly once');
assert.equal(result.choices[0].content, '你好😀，data: 是正文。');
assert.equal(result.choices[0].reasoning, '思考一下');
assert.equal(result.choices[0].toolCalls[0].name, 'select_channel');
assert.equal(result.choices[0].toolCalls[0].arguments, '{"channel":"group:123"}');
assert.equal(result.choices[0].toolCalls[1].arguments, '{}');
assert.equal(result.choices[1].index, 2); assert.equal(result.choices[1].content, '另一个候选');
assert.equal(result.choices[0].finishReason, 'tool_calls');
assert.equal(result.usage.total_tokens, 62); assert.equal(result.metadata.model, 'local-fixture');
assert.equal(result.pending, false); assert.equal(result.warnings.length, 0); assert.equal(result.unparsed, undefined);
const afterFinish = parses;
decoder.update(raw, 'text/event-stream; charset=utf-8', false);
assert.equal(parses, afterFinish, 'finished rerenders are idempotent');

const resetRaw = frame(delta({ content: '重置后的内容' }));
const reset = decoder.update(resetRaw, 'text/event-stream', true);
assert.equal(reset.choices[0].content, '重置后的内容'); assert.equal(reset.choices[0].reasoning, '');
assert.equal(reset.choices[0].toolCalls.length, 0); assert.equal(reset.usage, undefined);
const sameLength = frame(delta({ content: '同长度的新内容' }));
assert.equal(decoder.update(sameLength, 'text/event-stream', true).choices[0].content, '同长度的新内容');

const invalid = 'data: {"choices": nope}\r\n\r\n';
const invalidResult = api.createResponseDecoder().update(frame(delta({ content: '保留前文' })) + invalid, 'text/event-stream', false);
assert.equal(invalidResult.choices[0].content, '保留前文');
assert.equal(invalidResult.unparsed, invalid); assert(invalidResult.warnings.some((v: string) => v.includes('无效')));
const truncated = 'data: {"choices":[{"delta":{"content":"未完成';
const tailDecoder = api.createResponseDecoder();
assert.equal(tailDecoder.update(truncated, 'text/event-stream', true).warnings.length, 0, 'network fragments are not reported as malformed while still streaming');
const tailResult = tailDecoder.update(truncated, 'text/event-stream', false);
assert.equal(tailResult.unparsed, truncated); assert(tailResult.warnings.some((v: string) => v.includes('不完整')));
const resumed = tailDecoder.update(truncated + '"}}]}\n\n', 'text/event-stream', true);
assert.equal(resumed.choices[0].content, '未完成'); assert.equal(resumed.unparsed, undefined); assert.equal(resumed.warnings.length, 0, 'a resumed finalized tail is decoded afresh');
const noSeparator = api.createResponseDecoder().update('data: {"choices":[{"message":{"content":"最后正文"},"finish_reason":"stop"}]}', 'text/event-stream', false);
assert.equal(noSeparator.choices[0].content, '最后正文'); assert(noSeparator.warnings.some((v: string) => v.includes('分隔符')));
const cr = api.createResponseDecoder();
assert.equal(cr.update(frame(delta({ content: '单 CR 换行' }), '\r'), 'sse', false).choices[0].content, '单 CR 换行');

const jsonRaw = JSON.stringify({ id: 'json-call', choices: [{ index: 0, message: { role: 'assistant', content: '不是 data: 流', reasoning_content: '考虑过了', tool_calls: [{ id: 'json-tool', type: 'function', function: { name: 'act', arguments: '{"desc":"举手"}' } }] }, finish_reason: 'stop' }], usage: { total_tokens: 7 } });
const jsonDecoder = api.createResponseDecoder(); const jsonParseStart = parses;
for (let index = 0; index < jsonRaw.length; index++) jsonDecoder.update(jsonRaw.slice(0, index + 1), 'application/json', true);
const jsonResult = jsonDecoder.update(jsonRaw, 'application/json', false);
assert.equal(parses - jsonParseStart, 1, 'a growing non-stream JSON body parses only once complete');
assert.equal(jsonResult.choices[0].content, '不是 data: 流');
assert.equal(jsonResult.choices[0].reasoning, '考虑过了');
assert.equal(jsonResult.choices[0].toolCalls[0].arguments, '{"desc":"举手"}');
assert.equal(jsonResult.usage.total_tokens, 7);
const legacy = api.createResponseDecoder().update('{"choices":[{"message":{"function_call":{"name":"legacy","arguments":"{}"}}}]}', '', false);
assert.equal(legacy.choices[0].toolCalls[0].name, 'legacy');
const mislabeled = api.createResponseDecoder().update(jsonRaw, 'text/event-stream', false);
assert.equal(mislabeled.choices[0].content, '不是 data: 流', 'an upstream can ignore stream and send ordinary JSON');
const bodyError = { error: { message: 'TextEncodeInput must be Union[...]', type: 'BadRequestError', code: 400 } };
assert.deepEqual(plain(api.createResponseDecoder().update(JSON.stringify(bodyError), 'application/json', false).error), bodyError.error);
assert.deepEqual(plain(api.createResponseDecoder().update('event: error\ndata: {"message":"upstream disconnected","code":502}\n\n', 'text/event-stream', false).error), { message: 'upstream disconnected', code: 502 });
const html = '<html><body>502 Bad Gateway</body></html>';
const htmlResult = api.createResponseDecoder().update(html, 'text/html', false);
assert.equal(htmlResult.unparsed, html); assert(htmlResult.warnings.length > 0);
const unknown = '{"unexpected":{"doNotDrop":"diagnostic details"}}';
assert.equal(api.createResponseDecoder().update(unknown, 'application/json', false).unparsed, unknown);
assert.equal(api.createResponseDecoder().update('data: ordinary prose', '', false).unparsed, 'data: ordinary prose', 'invalid data lines retain their prefixes instead of pretending to be model content');
const badJson = api.createResponseDecoder().update('{"error":', 'application/json', false);
assert.equal(badJson.unparsed, '{"error":'); assert(badJson.warnings.length);
const unsupportedFrame = frame({ choices: [{ delta: { audio: { data: 'opaque audio' } } }, { delta: { audio: { data: 'another candidate' } } }] });
assert.equal(api.createResponseDecoder().update(unsupportedFrame, 'sse', false).unparsed, unsupportedFrame, 'unsupported fields preserve each raw frame only once');
assert.equal(api.createResponseDecoder().update('\uFEFF' + frame(delta({ content: 'BOM 流' })), 'sse', false).choices[0].content, 'BOM 流');
assert.equal(api.createResponseDecoder().update('\uFEFF' + jsonRaw, 'application/json', false).choices[0].content, '不是 data: 流');
assert.equal(api.createResponseDecoder().update('{"choices":[{"message":{"content":null,"refusal":"拒绝原因"}}]}', 'application/json', false).choices[0].content, '拒绝原因');
const legacyStream = api.createResponseDecoder().update(frame(delta({ function_call: { name: 'select_', arguments: '{' } })) + frame(delta({ function_call: { name: 'channel', arguments: '}' } })), 'sse', true);
assert.equal(legacyStream.choices[0].toolCalls[0].name, 'select_channel'); assert.equal(legacyStream.choices[0].toolCalls[0].arguments, '{}');

const responseInput = [{ role: 'user', content: [{ type: 'input_text', text: '图片在这里' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
  { type: 'function_call', call_id: 'r-call', name: 'act', arguments: '{"description":"出门"}' },
  { type: 'function_call_output', call_id: 'r-call', output: [{ type: 'input_text', text: '结果' }, { type: 'input_image', image_url: 'data:image/png;base64,BBBB' }] }];
const responsesRequest = api.request(JSON.stringify({ model: 'responses', instructions: '固定规则', input: responseInput, store: false, tools: [{ type: 'function', name: 'act', parameters: {} }] }));
assert.equal(responsesRequest.messages[0].role, 'system'); assert.equal(responsesRequest.messages[0].content, '固定规则');
assert.deepEqual(plain(responsesRequest.messages[1].content), responseInput[0].content);
assert.equal(responsesRequest.messages[2].toolCalls[0].function.name, 'act'); assert.equal(responsesRequest.messages[2].toolCalls[0].id, 'r-call');
assert.equal(responsesRequest.messages[3].role, 'tool'); assert.equal(responsesRequest.messages[3].toolCallId, 'r-call');
assert.deepEqual(plain(responsesRequest.messages[3].content), responseInput[2].output);
assert.equal(responsesRequest.settings.input, undefined); assert.equal(responsesRequest.settings.instructions, undefined); assert.equal(responsesRequest.settings.store, false);
assert.equal(api.request('{"input":"普通输入"}').messages[0].content, '普通输入');
assert.equal(api.request('{"input":{"unknown":"保留"}}').messages[0].content.unknown, '保留');
const anthropicParts = [{ type: 'text', text: '先说话' }, { type: 'tool_use', id: 'a-call', name: 'read', input: {} }, { type: 'text', text: '后说话' }];
const anthropicRequest = api.request(JSON.stringify({ model: 'claude', system: [{ type: 'text', text: '系统规则' }], messages: [{ role: 'assistant', content: anthropicParts },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a-call', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] }], tools: [{ name: 'read', input_schema: {} }] }));
assert.equal(anthropicRequest.messages[0].role, 'system'); assert.deepEqual(plain(anthropicRequest.messages[1].content), anthropicParts, 'mixed tool and prose blocks retain request order');
assert.equal(anthropicRequest.messages[2].content[0].tool_use_id, 'a-call'); assert.equal(anthropicRequest.settings.system, undefined);

const rItem = { type: 'message', id: 'rm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好', annotations: [] }] };
const rTool = { type: 'function_call', id: 'rf', call_id: 'rc', name: 'send', arguments: '{"msg":"好"}', status: 'completed' };
const rReason = { type: 'reasoning', id: 'rr', summary: [{ type: 'summary_text', text: '考虑一下' }] };
const rFinal = { id: 'response-id', object: 'response', model: 'fixture', status: 'completed', output: [rReason, rItem, rTool], usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens: 7 } };
const rEvents = [
  { type: 'response.created', response: { id: 'response-id', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { ...rReason, summary: [] } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '考虑' },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '一下' },
  { type: 'response.output_item.done', output_index: 0, item: rReason },
  { type: 'response.output_item.added', output_index: 1, item: { ...rItem, content: [] } },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '你', sequence_number: 12 },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '你', sequence_number: 12 },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '好' },
  { type: 'response.output_text.done', output_index: 1, content_index: 0, text: '你好' },
  { type: 'response.output_item.done', output_index: 1, item: rItem },
  { type: 'response.output_item.added', output_index: 2, item: { ...rTool, arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"msg":' },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"好"}' },
  { type: 'response.function_call_arguments.done', output_index: 2, arguments: rTool.arguments },
  { type: 'response.output_item.done', output_index: 2, item: rTool },
  { type: 'response.completed', response: rFinal },
];
function incremental(events: unknown[]) {
  const body = events.map(item => frame(item)).join(''), decoder = api.createResponseDecoder(), before = parses;
  for (let i = 1; i <= body.length; i++) decoder.update(body.slice(0, i), 'sse', true);
  const result = decoder.update(body, 'sse', false);
  assert.equal(parses - before, events.length, 'native protocol frames parse only once during character-level updates');
  decoder.update(body, 'sse', false); assert.equal(parses - before, events.length);
  return result;
}
const rRead = incremental(rEvents);
assert.equal(rRead.choices[0].content, '你好'); assert.equal(rRead.choices[0].reasoning, '考虑一下'); assert.equal(rRead.choices[0].toolCalls.length, 1);
assert.equal(rRead.choices[0].toolCalls[0].id, 'rc'); assert.equal(rRead.choices[0].toolCalls[0].arguments, rTool.arguments);
assert.equal(rRead.choices[0].finishReason, 'tool_calls'); assert.equal(rRead.usage.input_tokens_details.cached_tokens, 4); assert.equal(rRead.pending, false);
assert.equal(rRead.metadata.output, undefined, 'full final response is not duplicated into metadata'); assert.equal(rRead.metadata.delta, undefined);
assert.equal(rRead.warnings.length, 0); assert.equal(rRead.unparsed, undefined);
const rJson = api.createResponseDecoder().update(JSON.stringify(rFinal), 'json', false);
assert.deepEqual(plain(rJson.choices), plain(rRead.choices));
const rTruncated = api.createResponseDecoder().update(frame({ type: 'response.incomplete', response: { ...rFinal, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }), 'sse', false);
assert.equal(rTruncated.choices[0].finishReason, 'max_output_tokens');
const rNoTerminal = api.createResponseDecoder().update(rEvents.slice(0, -1).map(item => frame(item)).join('') + 'data: [DONE]\n\n', 'sse', false);
assert(rNoTerminal.warnings.some((text: string) => text.includes('response.completed')), 'Chat DONE marker is not a Responses terminal event');
const rUnknown = frame({ type: 'response.output_item.done', output_index: 5, item: { type: 'future_audio', data: 'do-not-drop' } });
assert.equal(api.createResponseDecoder().update(rUnknown, 'sse', false).unparsed, rUnknown);
const rError = api.createResponseDecoder().update(frame({ type: 'response.failed', response: { status: 'failed', error: { message: 'offline' }, output: [] } }), 'sse', false);
assert.equal(rError.error.message, 'offline'); assert.equal(rError.choices[0].finishReason, 'failed');

const aEvents = [
  { type: 'message_start', message: { type: 'message', id: 'anthropic-id', role: 'assistant', model: 'claude', content: [], stop_reason: null, usage: { input_tokens: 20, cache_read_input_tokens: 8, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '考虑过了' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'ac', name: 'send', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"msg":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"好"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' },
];
const aRead = incremental(aEvents);
assert.equal(aRead.choices[0].content, '你好'); assert.equal(aRead.choices[0].reasoning, '考虑过了'); assert.equal(aRead.choices[0].toolCalls[0].id, 'ac');
assert.equal(aRead.choices[0].toolCalls[0].arguments, '{"msg":"好"}', 'Anthropic placeholder {} is not concatenated with streamed input JSON');
assert.equal(aRead.choices[0].finishReason, 'tool_use'); assert.equal(aRead.usage.input_tokens, 20); assert.equal(aRead.usage.output_tokens, 9); assert.equal(aRead.usage.cache_read_input_tokens, 8);
assert.equal(aRead.warnings.length, 0); assert.equal(aRead.pending, false); assert.equal(aRead.unparsed, undefined);
const aJson = api.createResponseDecoder().update(JSON.stringify({ ...aEvents[0].message, content: [{ type: 'thinking', thinking: '考虑过了' }, { type: 'text', text: '你好' }, { type: 'tool_use', id: 'ac', name: 'send', input: { msg: '好' } }], stop_reason: 'tool_use', usage: aRead.usage }), 'json', false);
assert.deepEqual(plain(aJson.choices), plain(aRead.choices));
const aNoTerminal = api.createResponseDecoder().update(aEvents.slice(0, -1).map(item => frame(item)).join(''), 'sse', false);
assert(aNoTerminal.warnings.some((text: string) => text.includes('message_stop')), 'stop_reason alone does not mask a missing message_stop');
const aOpaque = frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } });
assert.equal(api.createResponseDecoder().update(aOpaque, 'sse', false).unparsed, aOpaque, 'unrendered native signatures remain available without becoming prose');
console.log('PASS captured call decoding: incremental SSE/JSON, reasoning, tools, branches, errors, incomplete frames and resets');
