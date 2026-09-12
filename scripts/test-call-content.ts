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
console.log('PASS captured call decoding: incremental SSE/JSON, reasoning, tools, branches, errors, incomplete frames and resets');
