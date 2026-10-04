/* Decode captured wire bodies for readers without changing the original trace. No DOM or network access. */
(function (global) {
    'use strict';
    var own = function (value, key) { return Object.prototype.hasOwnProperty.call(value, key); };
    function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function request(raw) {
        var result = { messages: [], tools: [], settings: {} };
        if (typeof raw !== 'string' || !raw.trim()) return result;
        try {
            var body = JSON.parse(raw);
            if (!object(body)) throw new Error('请求体不是 JSON 对象');
            function messageItem(message) {
                if (!object(message)) return { role: 'unknown', content: message };
                if (message.type === 'function_call') return { role: 'assistant', content: null, toolCalls: [{ id: message.call_id || message.id, type: 'function', function: { name: message.name, arguments: message.arguments } }] };
                if (message.type === 'function_call_output') return { role: 'tool', content: message.output, toolCallId: message.call_id };
                if (message.type === 'reasoning') return { role: 'assistant', content: message };
                if (!message.role) return { role: 'unknown', content: message };
                var item = { role: message.role || 'unknown', content: own(message, 'content') ? message.content : null };
                if (Array.isArray(message.tool_calls)) item.toolCalls = message.tool_calls;
                else if (object(message.function_call)) item.toolCalls = [{ type: 'function', function: message.function_call }];
                if (own(message, 'tool_call_id')) item.toolCallId = message.tool_call_id;
                if (own(message, 'name')) item.name = message.name;
                return item;
            }
            if (own(body, 'system')) result.messages.push({ role: 'system', content: body.system });
            if (own(body, 'instructions') && body.instructions != null) {
                if (Array.isArray(body.instructions)) result.messages.push.apply(result.messages, body.instructions.map(messageItem));
                else result.messages.push({ role: 'system', content: body.instructions });
            }
            if (Array.isArray(body.messages)) result.messages.push.apply(result.messages, body.messages.map(messageItem));
            else if (Array.isArray(body.input)) result.messages.push.apply(result.messages, body.input.map(messageItem));
            else if (typeof body.input === 'string') result.messages.push({ role: 'user', content: body.input });
            else if (own(body, 'input')) result.messages.push({ role: 'unknown', content: body.input });
            if (Array.isArray(body.tools)) result.tools = body.tools;
            else if (Array.isArray(body.functions)) result.tools = body.functions.map(function (fn) { return { type: 'function', function: fn }; });
            Object.keys(body).forEach(function (key) {
                if (['messages', 'tools', 'functions', 'input', 'system', 'instructions'].indexOf(key) < 0) Object.defineProperty(result.settings, key, { value: body[key], enumerable: true });
            });
        } catch (error) { result.error = '无法解析请求 JSON：' + error.message; }
        return result;
    }
    function initial() { return { choices: [], metadata: {}, warnings: [], pending: false }; }
    function textContent(value) {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(function (part) {
            if (typeof part === 'string') return part;
            if (object(part) && typeof part.text === 'string') return part.text;
            // Preserve unfamiliar response content parts instead of silently discarding them.
            return JSON.stringify(part);
        }).join('\n');
        return JSON.stringify(value);
    }
    function createResponseDecoder() {
        var previous = '', mode = '', hint = '', state, choices, scan, lineStart, frameStart, data, event, unknownFields, frameNumber, done, finalized, nativeItems, nativeProtocol, nativeSequence;
        var jsonScan, jsonDepth, jsonString, jsonEscape, jsonStarted, jsonKind, jsonEnd, jsonExtra, jsonParsed;
        function reset() {
            state = initial(); choices = new Map(); scan = 0; lineStart = 0; frameStart = 0;
            nativeItems = new Map(); nativeProtocol = ''; nativeSequence = new Set();
            data = []; event = ''; unknownFields = false; frameNumber = 0; done = false; finalized = false;
            jsonScan = 0; jsonDepth = 0; jsonString = false; jsonEscape = false; jsonStarted = false;
            jsonKind = ''; jsonEnd = 0; jsonExtra = false; jsonParsed = false;
        }
        reset();
        function warn(message) { if (state.warnings.indexOf(message) < 0) state.warnings.push(message); }
        function preserve(raw) { state.unparsed = (state.unparsed || '') + raw; }
        function choiceAt(index) {
            if (!choices.has(index)) {
                var item = { index: index, role: 'assistant', content: '', reasoning: '', toolCalls: [] };
                choices.set(index, item); state.choices.push(item); state.choices.sort(function (a, b) { return a.index - b.index; });
            }
            return choices.get(index);
        }
        function addTools(choice, list, append) {
            if (!Array.isArray(list)) return;
            list.forEach(function (entry, position) {
                if (!object(entry)) return;
                var index = Number.isInteger(entry.index) ? entry.index : position;
                var tool = choice.toolCalls.find(function (value) { return value.index === index; });
                if (!tool) { tool = { index: index, name: '', arguments: '' }; choice.toolCalls.push(tool); choice.toolCalls.sort(function (a, b) { return a.index - b.index; }); }
                if (typeof entry.id === 'string') tool.id = entry.id;
                var fn = object(entry.function) ? entry.function : entry;
                if (typeof fn.name === 'string') tool.name = (append ? tool.name : '') + fn.name;
                if (own(fn, 'arguments')) tool.arguments = (append ? tool.arguments : '') + textContent(fn.arguments);
            });
        }
        function addMessage(choice, message, append) {
            if (!object(message)) return;
            if (typeof message.role === 'string') choice.role = message.role;
            if (own(message, 'content')) choice.content = (append ? choice.content : '') + textContent(message.content);
            if (typeof message.refusal === 'string') choice.content = (append || own(message, 'content') ? choice.content : '') + message.refusal;
            var reasoning = own(message, 'reasoning_content') ? message.reasoning_content : message.reasoning;
            if (reasoning != null) choice.reasoning = (append ? choice.reasoning : '') + textContent(reasoning);
            addTools(choice, message.tool_calls, append);
            if (object(message.function_call)) addTools(choice, [{ index: 0, function: message.function_call }], append);
        }
        function metadata(value) {
            ['id', 'model', 'object', 'status', 'created_at', 'stop_sequence', 'incomplete_details'].forEach(function (key) {
                if (own(value, key)) Object.defineProperty(state.metadata, key, { value: value[key], enumerable: true, configurable: true });
            });
        }
        function nativeSlot(index) {
            if (!nativeItems.has(index)) nativeItems.set(index, { texts: new Map(), thoughts: new Map(), tool: null });
            return nativeItems.get(index);
        }
        function nativeText(index, part, text, append, thinking) {
            var parts = thinking ? nativeSlot(index).thoughts : nativeSlot(index).texts;
            parts.set(part, (append ? parts.get(part) || '' : '') + textContent(text));
        }
        function nativeRefresh() {
            var choice = choiceAt(0), text = [], thoughts = [], tools = [];
            Array.from(nativeItems.entries()).sort(function (a, b) { return a[0] - b[0]; }).forEach(function (entry) {
                var item = entry[1];
                Array.from(item.texts.entries()).sort(function (a, b) { return a[0] - b[0]; }).forEach(function (part) { text.push(part[1]); });
                Array.from(item.thoughts.entries()).sort(function (a, b) { return a[0] - b[0]; }).forEach(function (part) { thoughts.push(part[1]); });
                if (item.tool) tools.push({ index: entry[0], id: item.tool.id, name: item.tool.name || '', arguments: item.tool.arguments || '' });
            });
            choice.content = text.join(''); choice.reasoning = thoughts.join('\n'); choice.toolCalls = tools;
        }
        function responseItem(item, index, keep) {
            if (!object(item)) { keep(); return; }
            var slot = nativeSlot(index);
            if (item.type === 'function_call') slot.tool = { id: item.call_id || item.id, name: item.name, arguments: textContent(item.arguments) };
            else if (item.type === 'message' && Array.isArray(item.content)) item.content.forEach(function (part, p) {
                if (part && part.type === 'output_text') { nativeText(index, p, part.text, false, false); if (part.annotations && part.annotations.length) keep(); }
                else if (part && part.type === 'refusal') nativeText(index, p, part.refusal, false, false);
                else keep();
            });
            else if (item.type === 'reasoning') {
                if (Array.isArray(item.summary)) item.summary.forEach(function (part, p) {
                    if (part && typeof part.text === 'string') nativeText(index, p, part.text, false, true); else keep();
                });
                if (item.encrypted_content != null) keep();
            } else keep();
        }
        function responseSnapshot(value, keep, terminal) {
            metadata(value);
            if (value.usage != null) state.usage = value.usage;
            if (value.error) state.error = value.error;
            if (Array.isArray(value.output)) {
                nativeItems.clear(); value.output.forEach(function (item, index) { responseItem(item, index, keep); }); nativeRefresh();
            }
            if (terminal || ['completed', 'failed', 'incomplete', 'cancelled'].indexOf(value.status) >= 0) {
                var reason = object(value.incomplete_details) && value.incomplete_details.reason;
                choiceAt(0).finishReason = reason || (value.status === 'completed' ? (choiceAt(0).toolCalls.length ? 'tool_calls' : 'stop') : value.status || terminal);
                done = true;
                if (value.status === 'in_progress' || value.status === 'queued') warn('响应结束时提供方仍未完成生成；当前展示已收到的内容。');
            }
        }
        function anthropicBlock(block, index, keep) {
            if (!object(block)) { keep(); return; }
            var slot = nativeSlot(index);
            if (block.type === 'text') { nativeText(index, 0, block.text, false, false); if (block.citations && block.citations.length) keep(); }
            else if (block.type === 'thinking') {
                nativeText(index, 0, block.thinking, false, true);
                if (block.signature != null) keep();
            } else if (block.type === 'tool_use') slot.tool = { id: block.id, name: block.name, arguments: textContent(block.input) };
            else keep();
        }
        function anthropicSnapshot(value, keep, terminal) {
            metadata(value);
            if (value.usage != null) state.usage = Object.assign(Object.create(null), state.usage || {}, value.usage);
            if (Array.isArray(value.content)) {
                nativeItems.clear(); value.content.forEach(function (part, index) { anthropicBlock(part, index, keep); }); nativeRefresh();
            }
            if (value.stop_reason) choiceAt(0).finishReason = value.stop_reason;
            if (terminal) { done = true; if (!value.stop_reason) warn('响应未包含结束原因；当前展示已收到的内容。'); }
        }
        function nativePayload(value, raw, eventName) {
            var type = typeof value.type === 'string' ? value.type : eventName, preserved = false;
            function keep() {
                if (!preserved) { preserve(raw); preserved = true; }
                warn('响应包含阅读视图尚未支持的项目，已保留原始片段。');
            }
            if (Array.isArray(value.output) || value.object === 'response') {
                nativeProtocol = 'responses'; responseSnapshot(value, keep, true); return true;
            }
            if (type && type.indexOf('response.') === 0) {
                nativeProtocol = 'responses';
                if (Number.isInteger(value.sequence_number)) {
                    if (nativeSequence.has(value.sequence_number)) return true;
                    nativeSequence.add(value.sequence_number);
                }
                if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].indexOf(type) >= 0) {
                    if (object(value.response)) responseSnapshot(value.response, keep, type.slice(9)); else keep();
                    return true;
                }
                if (type === 'response.created' || type === 'response.in_progress' || type === 'response.queued') {
                    if (object(value.response)) metadata(value.response); return true;
                }
                var index = Number.isInteger(value.output_index) ? value.output_index : 0, part = Number.isInteger(value.content_index) ? value.content_index : 0;
                if (type === 'response.output_item.added' || type === 'response.output_item.done') responseItem(value.item, index, keep);
                else if (type === 'response.output_text.delta' || type === 'response.output_text.done') nativeText(index, part, type.endsWith('.delta') ? value.delta : value.text, type.endsWith('.delta'), false);
                else if (type === 'response.refusal.delta' || type === 'response.refusal.done') nativeText(index, part, type.endsWith('.delta') ? value.delta : value.refusal, type.endsWith('.delta'), false);
                else if (type === 'response.content_part.added' || type === 'response.content_part.done') {
                    if (value.part && value.part.type === 'output_text') nativeText(index, part, value.part.text, false, false);
                    else if (value.part && value.part.type === 'refusal') nativeText(index, part, value.part.refusal, false, false);
                    else keep();
                } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
                    var slot = nativeSlot(index); if (!slot.tool) slot.tool = { id: value.item_id, name: '', arguments: '' };
                    slot.tool.arguments = (type.endsWith('.delta') ? slot.tool.arguments : '') + textContent(type.endsWith('.delta') ? value.delta : value.arguments);
                } else if (/^response\.reasoning(?:_summary)?_text\.(delta|done)$/.test(type)) {
                    nativeText(index, Number.isInteger(value.summary_index) ? value.summary_index : part, type.endsWith('.delta') ? value.delta : value.text, type.endsWith('.delta'), true);
                } else if (type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done') {
                    if (value.part && typeof value.part.text === 'string') nativeText(index, value.summary_index || 0, value.part.text, false, true); else keep();
                } else keep();
                nativeRefresh(); return true;
            }
            if (type === 'message' && Array.isArray(value.content)) {
                nativeProtocol = 'anthropic'; anthropicSnapshot(value, keep, true); return true;
            }
            if (['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'ping'].indexOf(type) >= 0) {
                nativeProtocol = 'anthropic';
                if (type === 'message_start') { if (object(value.message)) anthropicSnapshot(value.message, keep, false); else keep(); return true; }
                if (type === 'message_stop') { done = true; return true; }
                if (type === 'ping' || type === 'content_block_stop') return true;
                if (type === 'message_delta') {
                    if (value.delta && value.delta.stop_reason) choiceAt(0).finishReason = value.delta.stop_reason;
                    if (value.usage != null) state.usage = Object.assign(Object.create(null), state.usage || {}, value.usage);
                    return true;
                }
                var blockIndex = Number.isInteger(value.index) ? value.index : 0;
                if (type === 'content_block_start') {
                    anthropicBlock(value.content_block, blockIndex, keep);
                    // Anthropic's initial empty input object is a placeholder, not part of JSON deltas.
                    var started = nativeSlot(blockIndex); if (started.tool) started.tool.deltaStarted = false;
                } else if (object(value.delta)) {
                    var delta = value.delta, current = nativeSlot(blockIndex);
                    if (delta.type === 'text_delta') nativeText(blockIndex, 0, delta.text, true, false);
                    else if (delta.type === 'thinking_delta') nativeText(blockIndex, 0, delta.thinking, true, true);
                    else if (delta.type === 'input_json_delta') {
                        if (!current.tool) current.tool = { name: '', arguments: '' };
                        current.tool.arguments = (current.tool.deltaStarted ? current.tool.arguments : '') + textContent(delta.partial_json); current.tool.deltaStarted = true;
                    } else keep();
                } else keep();
                nativeRefresh(); return true;
            }
            return false;
        }
        function payload(value, raw, eventName) {
            if (!object(value)) { warn('响应片段不是可识别的模型响应对象，已保留原文。'); preserve(raw); return; }
            if (nativePayload(value, raw, eventName)) return;
            var recognized = false, preserved = false;
            function keep() { if (!preserved) { preserve(raw); preserved = true; } }
            Object.keys(value).forEach(function (key) {
                if (key !== 'choices' && key !== 'usage' && key !== 'error') Object.defineProperty(state.metadata, key, { value: value[key], enumerable: true, configurable: true });
            });
            if (own(value, 'error')) { state.error = value.error; recognized = true; }
            else if (eventName === 'error') { state.error = value; recognized = true; }
            if (own(value, 'usage')) { if (value.usage != null) state.usage = value.usage; recognized = true; }
            if (Array.isArray(value.choices)) {
                recognized = true;
                value.choices.forEach(function (entry, position) {
                    if (!object(entry)) { warn('响应包含无法识别的候选项，已保留该帧原文。'); keep(); return; }
                    var choice = choiceAt(Number.isInteger(entry.index) ? entry.index : position);
                    if (object(entry.message)) addMessage(choice, entry.message, false);
                    if (object(entry.delta)) addMessage(choice, entry.delta, true);
                    [entry.message, entry.delta].forEach(function (message) {
                        if (!object(message)) return;
                        var unknown = Object.keys(message).some(function (key) { return ['role', 'content', 'reasoning_content', 'reasoning', 'refusal', 'tool_calls', 'function_call', 'name', 'tool_call_id'].indexOf(key) < 0 && message[key] != null; });
                        if (Array.isArray(message.tool_calls) && message.tool_calls.some(function (tool) { return !object(tool) || (typeof tool.type === 'string' && tool.type !== 'function') || Object.keys(tool).some(function (key) { return ['index', 'id', 'type', 'function', 'name', 'arguments'].indexOf(key) < 0 && tool[key] != null; }); })) unknown = true;
                        if (unknown) { warn('响应包含阅读视图尚未支持的消息字段，已保留该帧原文。'); keep(); }
                    });
                    if (typeof entry.text === 'string') choice.content += entry.text;
                    if (entry.finish_reason != null) choice.finishReason = entry.finish_reason;
                    if (!object(entry.message) && !object(entry.delta) && typeof entry.text !== 'string' && entry.finish_reason == null) {
                        warn('响应候选项没有可识别的正文或工具调用，已保留该帧原文。'); keep();
                    }
                });
            }
            if (!recognized) { warn('响应格式暂不支持阅读视图，已保留原文。'); keep(); }
        }
        function dispatch(raw, incomplete) {
            frameNumber++;
            var previousUnparsed = state.unparsed;
            if (unknownFields) warn('第 ' + frameNumber + ' 个 SSE 帧含有未知字段，已保留原文。');
            if (!data.length) { if (unknownFields) preserve(raw); data = []; event = ''; unknownFields = false; return; }
            var body = data.join('\n');
            if (body.trim() === '[DONE]') { if (!nativeProtocol) done = true; }
            else {
                try { payload(JSON.parse(body), raw, event); }
                catch (_) {
                    warn('第 ' + frameNumber + ' 个 SSE 帧的 JSON ' + (incomplete ? '不完整或无效' : '无效') + '，已保留原文。');
                    preserve(raw);
                }
            }
            if (unknownFields && state.unparsed === previousUnparsed) preserve(raw);
            data = []; event = ''; unknownFields = false;
        }
        function line(value, end, raw) {
            if (lineStart === 0) value = value.replace(/^\uFEFF/, '');
            if (value === '') { dispatch(raw.slice(frameStart, end), false); frameStart = end; return; }
            if (value.charAt(0) === ':') return;
            var colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon), content = colon < 0 ? '' : value.slice(colon + 1);
            if (content.charAt(0) === ' ') content = content.slice(1);
            if (field === 'data') data.push(content);
            else if (field === 'event') event = content;
            else if (field !== 'id' && field !== 'retry') unknownFields = true;
        }
        function stream(raw, active) {
            // Keep absolute offsets: only new characters and a trailing CR are revisited.
            // Waiting for the LF preserves both split CRLF boundaries and exact invalid frames.
            for (var i = scan; i < raw.length; i++) {
                var char = raw.charAt(i);
                if (char !== '\n' && char !== '\r') continue;
                if (char === '\r' && i + 1 === raw.length && active) break;
                var end = i + (char === '\r' && raw.charAt(i + 1) === '\n' ? 2 : 1);
                line(raw.slice(lineStart, i), end, raw); lineStart = end; i = end - 1;
            }
            scan = i;
            if (!active && frameStart < raw.length) {
                if (lineStart < raw.length) line(raw.slice(lineStart), raw.length, raw);
                if (data.length || unknownFields) {
                    warn('响应结束时最后一个 SSE 帧缺少完整分隔符；可解码内容已展示，原始边界仍可查看。');
                    dispatch(raw.slice(frameStart), true);
                }
            }
            if (!active && !done && (state.choices.length || nativeProtocol)) {
                if (nativeProtocol) warn('流已结束，但未收到 ' + (nativeProtocol === 'responses' ? 'response.completed' : 'message_stop') + ' 终止事件；当前展示已收到的内容。');
                else if (state.choices.some(function (choice) { return !choice.finishReason; })) warn('流已结束，但未收到 [DONE] 或完整的结束原因；当前展示已收到的内容。');
            }
        }
        function scanJson(raw) {
            for (; jsonScan < raw.length; jsonScan++) {
                var char = raw.charAt(jsonScan);
                if (jsonEnd) { if (!/\s/.test(char)) jsonExtra = true; continue; }
                if (!jsonStarted) {
                    if (/\s/.test(char)) continue;
                    jsonStarted = true; jsonKind = char === '{' || char === '[' ? 'container' : char === '"' ? 'string' : 'primitive';
                }
                if (jsonString) {
                    if (jsonEscape) jsonEscape = false;
                    else if (char === '\\') jsonEscape = true;
                    else if (char === '"') { jsonString = false; if (jsonKind === 'string') jsonEnd = jsonScan + 1; }
                } else if (char === '"') jsonString = true;
                else if (char === '{' || char === '[') jsonDepth++;
                else if (char === '}' || char === ']') { jsonDepth--; if (jsonDepth <= 0) jsonEnd = jsonScan + 1; }
                else if (jsonKind === 'primitive' && /\s/.test(char)) jsonEnd = jsonScan;
            }
        }
        function json(raw, active) {
            scanJson(raw);
            if (!jsonParsed && (jsonEnd || !active)) {
                jsonParsed = true;
                try { payload(JSON.parse(raw.replace(/^\uFEFF/, '')), raw, ''); }
                catch (_) { warn('响应 JSON 不完整或无效，已保留原文。'); state.unparsed = raw; }
            }
            if (jsonExtra) {
                state = initial(); choices.clear(); warn('JSON 后还有无法解析的内容，已保留完整原文。'); state.unparsed = raw;
            } else if (!jsonParsed && !active && raw) { warn('响应 JSON 尚未完整接收，已保留原文。'); state.unparsed = raw; }
        }
        function detect(raw, format) {
            var start = raw.replace(/^\uFEFF/, '').trimStart();
            if (/^[{["\d-]/.test(start) || /^(true|false|null)(?:\s|$)/.test(start)) return 'json';
            if (/^(?:data:|event:|id:|retry:|:)/.test(start)) return 'sse';
            if (/event-stream|^sse$/i.test(format)) return 'sse';
            if (/json/i.test(format)) return 'json';
            return '';
        }
        return { update: function (raw, format, isActive) {
            raw = typeof raw === 'string' ? raw : '';
            format = typeof format === 'string' ? format : '';
            var active = !!isActive, nextMode = detect(raw, format);
            if (!raw.startsWith(previous) || hint !== format || (mode && nextMode && mode !== nextMode) || (finalized && (raw !== previous || active))) { reset(); mode = ''; }
            hint = format; previous = raw; mode = nextMode || mode;
            // A completed JSON body and finished SSE tail must not be applied twice on UI rerenders.
            if (!finalized) {
                if (mode === 'sse') stream(raw, active);
                else if (mode === 'json') json(raw, active);
                else if (raw && !active) { warn('响应不是可识别的 JSON 或 SSE，已保留原文。'); state.unparsed = raw; }
            }
            state.pending = active && !done;
            if (!active) finalized = true;
            return state;
        } };
    }
    global.CallContent = { request: request, createResponseDecoder: createResponseDecoder };
})(typeof window === 'undefined' ? globalThis : window);
