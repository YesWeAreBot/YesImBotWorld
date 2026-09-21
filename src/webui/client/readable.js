/* Shared, lazy presentation of structured records. Original values remain available. */
(function () {
    'use strict';
    var labels = {
        mode: '运行方式', narrative: '所见所闻', worldState: '世界当前情境', actors: '角色处境', perception: '角色感知', present: '是否在场', scene: '场景', intent: '行动意图', id: '编号', name: '名称', type: '类型', kind: '类别', role: '角色', content: '内容', text: '正文', description: '说明', desc: '意图', reason: '原因', message: '消息', messages: '消息列表',
        arguments: '调用参数', parameters: '参数定义', properties: '字段', required: '必填字段', tools: '可用工具', tool_calls: '工具调用', toolCalls: '工具调用', function: '函数', result: '结果', response: '返回内容', request: '请求内容', thought: '内心独白', internalThought: '主观想法', situation: '眼前处境', opportunities: '可以尝试', exclusiveGroup: '需要取舍的同组建议',
        status: '状态', ok: '是否成功', error: '错误', detail: '详情', payload: '事件内容', topic: '事件主题', sequence: '序列', emittedAt: '发生时间戳', ts: '时间戳',
        actorId: '行动角色', causationId: '上游事件', correlationId: '关联链路', ref: '关联编号', refToolCallId: '关联工具调用', sourceEventIds: '来源事件', action: '行动', actionId: '行动编号',
        entities: '可见实体', entityIds: '实体编号', changedEntityIds: '变更实体', entityId: '实体编号', observedId: '观测编号', observationId: '观测编号', observation: '观测结果', utterances: '听到的话语', speakerName: '说话人', speakerId: '说话人编号',
        attributes: '属性', value: '值', visibility: '可见范围', location: '所在位置', owner: '所有者', controller: '控制者', revision: '版本', target: '目标', targetIds: '行动目标', self: '是否自身',
        duration: '持续时长', durationWorldSeconds: '世界秒数', startedAt: '开始时间', completedAt: '完成时间', createdAt: '创建时间', updatedAt: '更新时间',
        model: '模型', stream: '流式输出', temperature: '温度', max_tokens: '最大输出 Token', usage: '用量', prompt_tokens: '输入 Token', completion_tokens: '输出 Token', total_tokens: '总 Token', ms: '耗时（毫秒）', finish_reason: '结束原因',
        posture: '姿态', hunger: '饥饿', health: '健康', energy: '精力', thirst: '口渴', lighting: '光线', material: '材质', open: '是否打开', filled: '是否装满', consciousness: '意识状态', injuries: '伤情', wetness: '湿润程度', powered: '电源状态',
        operations: '变更操作', op: '操作', entity: '实体', patch: '变更内容', path: '路径', skill: '技能', confidence: '置信度', evidence: '依据', evidenceIds: '依据编号'
    };
    function element(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = String(text); return node; }
    function known(key) { return Object.prototype.hasOwnProperty.call(labels, key); }
    function label(key) { return known(key) ? labels[key] : key; }
    function decode(value) {
        // Only unfold records. Ordinary text, IDs and JSON-encoded scalar text
        // retain their exact string value, including whitespace and quotes.
        if (typeof value !== 'string') return value;
        var candidate = value;
        for (var i = 0; i < 4 && typeof candidate === 'string'; i++) {
            var trimmed = candidate.trim();
            if (!trimmed || !/^[\[{\"]/.test(trimmed)) break;
            try {
                var next = JSON.parse(trimmed);
                if (next && typeof next === 'object') return next;
                if (typeof next !== 'string' || next === candidate) break;
                candidate = next;
            } catch (_) { break; }
        }
        return value;
    }
    function scalar(value) { return value == null ? (value === null ? '未设置（null）' : '未提供') : typeof value === 'boolean' ? value ? '是（true）' : '否（false）' : value === '' ? '空文本' : String(value); }
    function thoughtText(value) {
        var decoded = decode(value);
        if (decoded && typeof decoded === 'object' && typeof decoded.thought === 'string') return decoded.thought;
        // Native tool arguments arrive a few characters at a time. Decode only
        // the thought string, including escaped quotes and split Unicode escapes.
        var match = typeof value === 'string' && /^\s*\{\s*"thought"\s*:\s*"([\s\S]*)$/.exec(value);
        if (!match) return null;
        var encoded = match[1], end = encoded.length;
        for (var i = 0; i < encoded.length; i++) { if (encoded[i] === '\\') i++; else if (encoded[i] === '"') { end = i; break; } }
        encoded = encoded.slice(0, end);
        for (var trim = 0; trim <= Math.min(6, encoded.length); trim++) {
            try { return JSON.parse('"' + encoded.slice(0, encoded.length - trim) + '"'); } catch (_) {}
        }
        return null;
    }
    function thoughtCall(value) {
        if (typeof value === 'string') {
            var decoded = decode(value);
            if (decoded && typeof decoded === 'object') value = decoded;
            else {
                var partial = /^\s*\{\s*"name"\s*:\s*"think"\s*,\s*"arguments"\s*:\s*([\s\S]*)$/.exec(value);
                return partial ? thoughtText(partial[1]) : null;
            }
        }
        var call = value && typeof value === 'object' && (value.function || value);
        return call && call.name === 'think' ? thoughtText(call.arguments || call.args) : null;
    }
    function rawText(value) {
        if (typeof value === 'string') return value;
        var ancestors = [];
        try { return JSON.stringify(value, function (_, item) { if (!item || typeof item !== 'object') return typeof item === 'bigint' ? String(item) : item; while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop(); if (ancestors.includes(item)) return '[循环引用]'; ancestors.push(item); return item; }, 2) ?? String(value); }
        catch (_) { return String(value); }
    }
    function text(value) {
        var lines = [], stack = [{ value: value, depth: 0, prefix: '', ancestors: [] }];
        while (stack.length) {
            var item = stack.pop(), current = decode(item.value), indent = '  '.repeat(Math.min(item.depth, 16));
            if (!current || typeof current !== 'object') { lines.push(indent + item.prefix + scalar(current)); continue; }
            if (item.ancestors.includes(current)) { lines.push(indent + item.prefix + '循环引用'); continue; }
            var keys = Object.keys(current), array = Array.isArray(current);
            if (!keys.length) { lines.push(indent + item.prefix + (array ? '空列表' : '空记录')); continue; }
            if (item.prefix) lines.push(indent + item.prefix.replace(/：$/, ''));
            var parents = item.ancestors.concat([current]);
            for (var i = keys.length - 1; i >= 0; i--) { var key = keys[i]; stack.push({ value: current[key], depth: item.depth + (item.prefix ? 1 : 0), prefix: array ? (Number(key) + 1) + '. ' : label(key) + (known(key) ? '（' + key + '）' : '') + '：', ancestors: parents }); }
        }
        return lines.join('\n');
    }
    async function copyText(value, button) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
            else { var field = element('textarea', 'readable-copy-field'); field.value = value; document.body.appendChild(field); field.select(); var copied = document.execCommand('copy'); field.remove(); button.focus(); if (!copied) throw new Error('copy failed'); }
            button.textContent = '已复制';
        } catch (_) { button.textContent = '复制失败，请展开后选取文本'; }
    }
    function copyButton(title, getText) { var button = element('button', 'readable-button', title); button.type = 'button'; button.addEventListener('click', function () { copyText(getText(), button); }); return button; }
    function longText(value, cls, threshold, state) {
        state = state || {}; threshold = threshold || 1800;
        var holder = element('div', 'readable-long-text'), node = element('pre', cls), shown = Math.min(value.length, state.shown || threshold);
        holder.appendChild(node);
        var more = element('button', 'readable-button readable-more'), expandAll = element('button', 'readable-button readable-expand-all', '展开全文 · ' + value.length.toLocaleString('zh-CN') + ' 个字符'), collapse = element('button', 'readable-button readable-collapse', '收起长文本');
        more.type = expandAll.type = collapse.type = 'button';
        function update() {
            node.textContent = value.slice(0, shown); state.shown = shown;
            more.textContent = '继续展开 · 还有 ' + (value.length - shown).toLocaleString('zh-CN') + ' 个字符';
            if (shown < value.length) holder.appendChild(more); else more.remove();
            if (value.length - shown > 8000) holder.appendChild(expandAll); else expandAll.remove();
            if (shown > threshold) holder.appendChild(collapse); else collapse.remove();
            more.ariaExpanded = collapse.ariaExpanded = shown > threshold ? 'true' : 'false';
        }
        more.addEventListener('click', function () { shown = Math.min(value.length, shown + 8000); update(); });
        expandAll.addEventListener('click', function () { shown = value.length; update(); });
        collapse.addEventListener('click', function () { shown = Math.min(value.length, threshold); update(); });
        update(); return holder;
    }
    function raw(value, options) {
        var state = options && options.state || {}, details = element('details', 'readable-raw'), summary = element('summary', '', options && options.label || '查看原始数据'), loaded = false;
        details.appendChild(summary);
        function populate() {
            if (loaded) return; loaded = true;
            details.appendChild(copyButton('复制原始数据', function () { return rawText(value); }));
            details.appendChild(longText(rawText(value), 'readable-source', 4000, state));
        }
        details.addEventListener('toggle', function () { state.open = details.open; if (details.open) populate(); });
        if (state.open) { populate(); details.open = true; }
        return details;
    }
    function keyNode(key) {
        var node = element('span', 'readable-key', label(key));
        if (known(key)) node.appendChild(element('code', 'readable-original-key', key));
        return node;
    }
    function summaryText(value) {
        var array = Array.isArray(value), count = array ? value.length : Object.keys(value).length;
        if (array) return count ? count + ' 项' : '空列表';
        var title = value.name || value.role || value.type || value.kind;
        return count ? (typeof title === 'string' && title.length < 80 ? title + ' · ' : '') + count + ' 个字段' : '空记录';
    }
    function renderValue(original, depth, options, ancestors, path) {
        var value = decode(original), state = options.state[JSON.stringify(path)] || (options.state[JSON.stringify(path)] = {});
        if (options.renderSpecial) { var special = options.renderSpecial(value, path); if (special) return special; }
        var thought = thoughtCall(value);
        if (thought !== null) {
            var inner = element('section', 'readable-thought');
            inner.append(element('strong', 'readable-thought-label', '内心独白 · 主观想法'), longText(thought, 'readable-prose', options.textLimit, state), element('small', 'readable-thought-note', '角色心里浮现的想法；没有向外说出，不代表事情已经发生。'));
            return inner;
        }
        if (!value || typeof value !== 'object') {
            if (typeof value === 'string') return longText(value || '空文本', 'readable-prose', options.textLimit, state);
            return element('span', 'readable-scalar readable-' + (value == null ? 'null' : typeof value), scalar(value));
        }
        if (ancestors.includes(value)) return element('span', 'readable-scalar readable-null', '循环引用 · 请查看原始数据');
        var array = Array.isArray(value), count = array ? value.length : Object.keys(value).length, keys = array ? null : Object.keys(value);
        var root = depth === 0, holder = element(root ? 'div' : 'details', root ? 'readable-group' : 'readable-branch'), loaded = false, shown = 0;
        if (!root) holder.appendChild(element('summary', 'readable-summary', summaryText(value)));
        function populate() {
            if (loaded) return; loaded = true;
            var list = element(array ? 'ol' : 'dl', array ? 'readable-array' : 'readable-fields'), parents = ancestors.concat([value]), more = element('button', 'readable-button readable-more');
            more.type = 'button'; holder.appendChild(list);
            function page(initial) {
                var end = Math.min(count, initial === true ? Math.max(options.pageSize, state.count || 0) : shown + options.pageSize);
                for (; shown < end; shown++) {
                    var key = array ? shown : keys[shown], row = element(array ? 'li' : 'div', 'readable-row');
                    if (array) { row.appendChild(element('span', 'readable-index', String(shown + 1).padStart(2, '0'))); row.appendChild(renderValue(value[key], depth + 1, options, parents, path.concat([key]))); }
                    else { var term = element('dt'), definition = element('dd'); term.appendChild(keyNode(key)); definition.appendChild(renderValue(value[key], depth + 1, options, parents, path.concat([key]))); row.append(term, definition); }
                    list.appendChild(row);
                }
                state.count = shown;
                if (shown < count) { more.textContent = '继续显示 ' + Math.min(options.pageSize, count - shown) + ' 项 · 已显示 ' + shown + ' / ' + count; holder.appendChild(more); }
                else more.remove();
            }
            more.addEventListener('click', page); page(true);
            if (!count) holder.appendChild(element('span', 'readable-scalar readable-null', array ? '空列表' : '空记录'));
        }
        if (root || state.open === true || state.open == null && depth < options.openDepth) { populate(); if (!root) holder.open = true; }
        if (!root) holder.addEventListener('toggle', function () { state.open = holder.open; if (holder.open) populate(); });
        return holder;
    }
    function render(value, options) {
        options = Object.assign({ openDepth: 1, pageSize: 20, textLimit: 1800 }, options || {});
        options.pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 20));
        options.state = options.state || {};
        var root = element('div', 'readable-data' + (options.compact ? ' readable-compact' : ''));
        root.appendChild(renderValue(value, 0, options, [], []));
        if (options.copy !== false && !options.compact) root.appendChild(copyButton('复制可读内容', function () { return text(value); }));
        if (options.raw !== false && (!options.compact || options.raw === true)) root.appendChild(raw(value, { state: options.state.raw || (options.state.raw = {}) }));
        return root;
    }
    function opportunities(items, options) {
        options = options || {};
        var root = element('section', 'readable-opportunities'), list = element('div', 'opportunity-list'), groups = new Map();
        root.appendChild(element('div', 'opportunity-heading', options.historical ? '当时可以尝试' : '此刻可以尝试'));
        root.appendChild(element('p', 'opportunity-note', options.select ? '点选填入操作台，再由你决定是否执行；也可以自由输入。' : '这些是待选择的建议，还没有执行，也不保证结果。'));
        (Array.isArray(items) ? items : []).filter(function (item) { return item && typeof item.label === 'string' && typeof item.intent === 'string'; }).forEach(function (item, index) {
            var node = element(options.select ? 'button' : 'article', 'opportunity-card');
            if (options.select) {
                node.type = 'button'; node.dataset.opportunityId = item.id || String(index);
                node.disabled = typeof options.disabled === 'function' ? options.disabled(item) : !!options.disabled;
                node.setAttribute('aria-pressed', String(!!item.id && options.selectedId === item.id));
                node.addEventListener('click', function () { if (!node.disabled) options.select(item); });
            }
            node.append(element('strong', '', item.label), element('span', 'opportunity-intent', item.intent));
            if (item.exclusiveGroup) {
                if (!groups.has(item.exclusiveGroup)) groups.set(item.exclusiveGroup, groups.size + 1);
                node.appendChild(element('small', 'opportunity-tradeoff', '取舍组 ' + groups.get(item.exclusiveGroup) + ' · 同组选一项'));
            } else node.appendChild(element('small', 'opportunity-source', item.source === 'device' ? '设备里可做的事' : '眼前可以尝试'));
            list.appendChild(node);
        });
        if (!list.children.length) root.appendChild(element('p', 'opportunity-note', '暂时没有新的建议，仍可按自己的意图行动。'));
        else root.appendChild(list);
        return root;
    }
    window.ReadableData = { render: render, text: text, rawText: rawText, raw: raw, label: label, thoughtText: thoughtText, thoughtCall: thoughtCall, opportunities: opportunities };
})();
