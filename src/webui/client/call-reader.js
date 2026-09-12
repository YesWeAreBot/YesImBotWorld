/* A reading view of captured model traffic. The exact transport remains available separately. */
var CallReader = (function () {
    var roles = { system: '系统指令', developer: '开发者指令', user: '输入与观测', assistant: '模型', tool: '工具回执', function: '工具回执' };
    function data(value, depth) { return ReadableData.render(value, { compact: true, raw: false, copy: false, openDepth: depth || 1 }); }
    function title(value) { return el('h3', { cls: 'live-reading-title', text: value }); }
    function plain(value) { return ReadableData.text(value); }
    function appendText(node, value) {
        var old = node.textContent;
        if (old === value) return;
        if (value.startsWith(old)) node.appendChild(document.createTextNode(value.slice(old.length)));
        else node.textContent = value;
    }
    function parsed(value) {
        if (typeof value !== 'string') return value;
        var candidate = value.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
        if (!/^[\[{]/.test(candidate) || !/[\]}]$/.test(candidate)) return null;
        try { return JSON.parse(candidate); } catch (_) { return null; }
    }
    function setValue(node, value) {
        if (node._readingValue === value && !node._deferredStructure) return;
        var selection = window.getSelection(), held = selection && !selection.isCollapsed && node.contains(selection.anchorNode);
        if (held && node.dataset.structured) { node._deferredStructure = true; return; }
        var structure = parsed(value);
        if (structure !== null && !held) {
            node.replaceChildren(data(structure, 2));
            node.dataset.structured = 'true';
        } else {
            if (node.dataset.structured) { node.replaceChildren(); delete node.dataset.structured; }
            appendText(node, typeof value === 'string' ? value : plain(value));
        }
        node._deferredStructure = structure !== null && !!held;
        node._readingValue = value;
    }
    function contentParts(value) {
        var holder = el('div', { cls: 'live-message-body' });
        if (!Array.isArray(value)) { holder.appendChild(data(value == null ? '没有正文' : value)); return holder; }
        value.forEach(function (part) {
            if (part == null || typeof part !== 'object') { holder.appendChild(data(part)); return; }
            if (typeof part === 'string' || part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') holder.appendChild(data(typeof part === 'string' ? part : part.text));
            else {
                // Reading a request must not silently fetch its remote image/audio URLs.
                var name = { image_url: '图片附件', input_image: '图片附件', input_audio: '音频附件', audio: '音频附件', file: '文件附件' }[part.type] || '消息附件';
                var detail = el('details', { cls: 'live-attachment' }, [el('summary', { text: name + ' · 展开参数' })]);
                detail.addEventListener('toggle', function () { if (detail.open && !detail.dataset.loaded) { detail.dataset.loaded = 'true'; detail.appendChild(data(part)); } });
                holder.appendChild(detail);
            }
        });
        return holder;
    }
    function create(container) {
        var key = '', requestText = null, choices = new Map(), copy = '', warning = null, output = null, footer = null, footerSignature = '', placeholder = null;
        function clear(next) {
            key = next; requestText = null; choices.clear(); container.replaceChildren(); copy = ''; warning = null; output = null; footer = null; footerSignature = ''; placeholder = null;
        }
        function request(raw, next) {
            if (key !== next) clear(next);
            if (raw === requestText) return;
            requestText = raw;
            container.replaceChildren();
            if (!raw) { container.appendChild(el('p', { cls: 'live-reading-empty', text: '正在读取请求内容…' })); return; }
            var decoded = CallContent.request(raw), messages = decoded.messages || [], tools = decoded.tools || [];
            if (decoded.error) { container.append(title('请求内容暂时无法解析'), data(raw)); copy = raw; return; }
            container.appendChild(title('发送给模型的内容 · ' + messages.length + ' 条消息'));
            var list = el('div', { cls: 'live-messages' }), start = Math.max(0, messages.length - 20), earlier = el('button', { type: 'button', cls: 'live-button live-earlier', text: '显示更早的消息' });
            function messageCard(message, index) {
                var name = roles[message.role] || message.role || '消息', preview = typeof message.content === 'string' ? message.content.replace(/\s+/g, ' ').slice(0, 90) : Array.isArray(message.content) ? message.content.length + ' 个内容片段' : '';
                var card = el('details', { cls: 'live-message', open: index >= messages.length - 3 }, [el('summary', {}, [el('span', { cls: 'live-message-role', text: name }), el('small', { text: '#' + (index + 1) + (message.name ? ' · ' + message.name : '') }), el('span', { cls: 'live-message-preview', text: preview })])]);
                function fill() {
                    if (!card.open || card.dataset.loaded) return;
                    card.dataset.loaded = 'true';
                    if (message.toolCallId) card.appendChild(el('code', { cls: 'live-tool-ref', text: '对应调用：' + message.toolCallId }));
                    card.appendChild(contentParts(message.content));
                    if (message.toolCalls && message.toolCalls.length) card.append(title('工具调用'), data(message.toolCalls));
                }
                card.addEventListener('toggle', fill); fill(); return card;
            }
            function prepend(from, to) { var fragment = document.createDocumentFragment(); for (var i = from; i < to; i++) fragment.appendChild(messageCard(messages[i], i)); list.prepend(fragment); }
            earlier.onclick = function () { var previous = start; start = Math.max(0, start - 20); prepend(start, previous); earlier.hidden = start === 0; earlier.textContent = '显示更早的消息 · 还有 ' + start + ' 条'; };
            earlier.hidden = start === 0; earlier.textContent = '显示更早的消息 · 还有 ' + start + ' 条';
            prepend(start, messages.length); container.append(earlier, list);
            if (tools.length) {
                var toolDetails = el('details', { cls: 'live-request-settings' }, [el('summary', { text: '本次开放的工具 · ' + tools.length + ' 个' })]);
                toolDetails.ontoggle = function () { if (toolDetails.open && !toolDetails.dataset.loaded) { toolDetails.dataset.loaded = 'true'; toolDetails.appendChild(data(tools)); } };
                container.appendChild(toolDetails);
            }
            var settings = el('details', { cls: 'live-request-settings' }, [el('summary', { text: '模型与生成设置' })]);
            settings.ontoggle = function () { if (settings.open && !settings.dataset.loaded) { settings.dataset.loaded = 'true'; settings.appendChild(data(decoded.settings)); } };
            container.appendChild(settings);
            copy = function () { return messages.map(function (message, i) { return '[' + (i + 1) + ' · ' + (roles[message.role] || message.role) + ']\n' + plain(message.content) + (message.toolCalls?.length ? '\n工具调用\n' + plain(message.toolCalls) : ''); }).join('\n\n') + '\n\n生成设置\n' + plain(decoded.settings) + (tools.length ? '\n\n可用工具\n' + plain(tools) : ''); };
        }
        function response(decoded, next, options) {
            if (key !== next) clear(next);
            if (!output) {
                warning = el('div', { cls: 'live-reading-warnings', role: 'status' });
                output = el('div', { cls: 'live-answers' });
                placeholder = el('p', { cls: 'live-reading-empty' });
                footer = el('div', { cls: 'live-reading-footer' });
                container.append(warning, output, placeholder, footer);
            }
            var messages = decoded.choices || [], ids = new Set(messages.map(function (c) { return c.index; }));
            choices.forEach(function (node, id) { if (!ids.has(id)) { node.card.remove(); choices.delete(id); } });
            messages.forEach(function (choice) {
                var nodes = choices.get(choice.index);
                if (!nodes) {
                    var card = el('article', { cls: 'live-answer', 'data-choice-index': choice.index }), heading = title('模型返回'), reasoning = el('section', { cls: 'live-reasoning', hidden: true }), reasoningText = el('div', { cls: 'live-prose live-reasoning-text' }), content = el('section', { cls: 'live-content', hidden: true }), contentText = el('div', { cls: 'live-prose live-answer-text' }), tools = el('div', { cls: 'live-tool-calls' }), finish = el('div', { cls: 'live-finish' });
                    reasoning.append(title('思考'), reasoningText); content.append(title('正文'), contentText); card.append(heading, reasoning, content, tools, finish); output.appendChild(card);
                    nodes = { card: card, heading: heading, reasoning: reasoning, reasoningText: reasoningText, content: content, contentText: contentText, tools: tools, toolNodes: new Map(), finish: finish }; choices.set(choice.index, nodes);
                }
                nodes.heading.textContent = messages.length > 1 ? '候选回答 ' + (choice.index + 1) : '模型返回';
                nodes.reasoning.hidden = !choice.reasoning; nodes.content.hidden = !choice.content;
                appendText(nodes.reasoningText, choice.reasoning || ''); setValue(nodes.contentText, choice.content || '');
                var toolIds = new Set();
                (choice.toolCalls || []).forEach(function (call) {
                    var id = call.index; toolIds.add(id);
                    var item = nodes.toolNodes.get(id);
                    if (!item) {
                        var element = el('section', { cls: 'live-tool-call' }), name = el('h3'), ref = el('small'), args = el('div', { cls: 'live-tool-arguments live-prose' });
                        element.append(name, ref, args); nodes.tools.appendChild(element); item = { element: element, name: name, ref: ref, args: args }; nodes.toolNodes.set(id, item);
                    }
                    item.name.textContent = '调用工具 · ' + (call.name || '名称正在生成');
                    item.ref.textContent = call.id || ''; item.ref.hidden = !call.id;
                    setValue(item.args, call.arguments || '参数正在生成…');
                });
                nodes.toolNodes.forEach(function (item, id) { if (!toolIds.has(id)) { item.element.remove(); nodes.toolNodes.delete(id); } });
                nodes.finish.textContent = choice.finishReason ? '结束原因 · ' + ({ stop: '正常结束', tool_calls: '交给工具执行', function_call: '交给工具执行', length: '达到生成长度限制', content_filter: '内容过滤' }[choice.finishReason] || choice.finishReason) : options.active ? '正在生成…' : '';
            });
            warning.textContent = (decoded.warnings || []).join('\n'); warning.hidden = !warning.textContent;
            placeholder.hidden = !!messages.length || !!decoded.error || !!decoded.unparsed;
            placeholder.textContent = options.awaitingRaw ? '正在同步模型返回…' : options.active ? '正在等待模型的内容…' : '本次返回没有正文或工具调用。';
            var signature = JSON.stringify([decoded.error, decoded.unparsed, decoded.usage, decoded.metadata]);
            var selected = window.getSelection(), footerHeld = selected && !selected.isCollapsed && footer.contains(selected.anchorNode);
            if (signature !== footerSignature && !footerHeld) {
                footerSignature = signature; footer.replaceChildren();
                if (decoded.error) footer.append(title('请求返回错误'), data(decoded.error));
                if (decoded.unparsed) {
                    if (/event-stream/i.test(options.format || '')) {
                        var unknown = el('details', { cls: 'live-unparsed' }, [el('summary', { text: '未能解析的响应片段 · 可展开核对' })]);
                        unknown.appendChild(el('pre', { text: decoded.unparsed })); footer.appendChild(unknown);
                    } else footer.append(title('返回内容'), data(decoded.unparsed));
                }
                if (decoded.usage) footer.append(title('本次用量'), data(decoded.usage));
                if (decoded.metadata && Object.keys(decoded.metadata).length) {
                    var meta = el('details', { cls: 'live-response-settings' }, [el('summary', { text: '响应信息' })]);
                    meta.appendChild(data(decoded.metadata)); footer.appendChild(meta);
                }
            }
            copy = function () { return messages.map(function (choice) { return (choice.reasoning ? '思考\n' + choice.reasoning + '\n\n' : '') + (choice.content ? '正文\n' + plain(choice.content) : '') + (choice.toolCalls || []).map(function (call) { return '\n\n调用工具 · ' + call.name + '\n' + plain(call.arguments); }).join(''); }).join('\n\n') + (decoded.error ? '\n错误\n' + plain(decoded.error) : '') + (decoded.unparsed ? '\n未解析内容\n' + decoded.unparsed : '') + (decoded.warnings?.length ? '\n' + decoded.warnings.join('\n') : ''); };
        }
        return { request: request, response: response, clear: function () { clear(''); }, text: function () { return typeof copy === 'function' ? copy() : copy; } };
    }
    return { create: create };
})();
