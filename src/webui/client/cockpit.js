/* The server supplies the same live tool schemas used by BotAgent. */
var WorldCockpit = (function () {
    var labels = { observe: '观察世界', observe_device: '看向设备', act: '身体行动', reflect: '整理认识', recall_growth: '回顾成长', recall: '回忆', wait: '等待', rest: '休息', time: '查看时间', status: '查看状态', check_time: '查看时间', check_status: '查看状态', read_channel: '阅读会话', check_msg: '查看消息', pick_up_phone: '拿起手机', put_down_phone: '放下手机', open_app: '打开应用', close_app: '关闭应用', open_computer: '打开电脑', close_computer: '关闭电脑', run_command: '运行终端命令', screen: '查看屏幕', keyboard: '使用键盘', mouse: '使用鼠标', travel: '前往其他世界', go_home: '回家' };
    var fields = { description: '动作描述', speech: '说出的原话', target: '目标', observationId: '观测编号', device: '设备', scope: '观察范围', modality: '感知方式', query: '检索内容', text: '文字', app: '应用', command: '命令', channel: '会话', channelId: '会话编号', content: '内容', name: '名称', path: '路径', title: '标题', url: '网址' };
    function label(tool) { return labels[tool.name] || tool.title || tool.name; }
    function note(text) { return el('p', { cls: 'journey-note', text: text }); }
    function button(text, run, cls) { return el('button', { type: 'button', cls: cls || 'journey-button', text: text, onclick: run }); }
    function group(tool) {
        if (tool.device || /^(?:phone\.|computer\.|app\.|pick_up_phone|put_down_phone|open_app|close_app|open_computer|close_computer|run_command|screen|keyboard|mouse|observe_device)/.test(tool.name)) return '设备';
        if (/reflect|recall|remember|note/.test(tool.name)) return '意识与记忆';
        return '世界与行动';
    }
    function mount(data, draft, actions) {
        var tools = data.tools || [], pending = data.pending || [], panel = el('section', { cls: 'journey-card cockpit', 'aria-label': '角色驾驶舱' });
        panel.append(el('div', { cls: 'journey-section-kicker', text: 'BOT / 人类驾驶舱' }), el('h2', { text: '使用角色此刻的能力' }), note(data.mode === 'puppet' ? '你操纵身体，Bot 保留自己的意识。这里开放实际动作与观察；回忆和反思由 Bot 自己决定。' : '你正在替角色决定意图。这些调用经过与 Bot 相同的执行路径，结果会成为角色自己的经历。'));
        var links = el('div', { cls: 'cockpit-links' }, [button('操作手机与电脑 ↗', function () { Studio.navigate('devices'); }), button('查看实时思考与调用 ↗', function () { Studio.navigate('live'); })]);
        panel.appendChild(links);
        if (!data.synced) panel.appendChild(note('正在同步当前能力和控制状态…'));
        if (pending.length) {
            var queue = el('div', { cls: 'cockpit-queue', 'aria-label': '执行中的工具' });
            pending.forEach(function (call) {
                var id = call.callId || call.id;
                queue.appendChild(el('div', { cls: 'cockpit-pending' }, [el('span', { cls: 'journey-pulse' }), el('div', {}, [el('strong', { text: call.name }), note(call.committed ? '变化已提交，等待最终回执' : '正在执行 · ' + (call.status || '等待回执'))]), button('请求取消', function () { actions.cancel(id); })]));
            });
            panel.appendChild(queue);
        }
        if (!tools.length) { panel.appendChild(note(data.synced ? '当前没有可用能力；世界或设备状态更新后会自动刷新。' : '能力目录尚未加载。')); return panel; }
        if (!tools.some(function (t) { return t.name === draft.selected; })) draft.selected = (tools.find(function (t) { return t.name === 'observe'; }) || tools[0]).name;
        var tool = tools.find(function (t) { return t.name === draft.selected; }), timed = tool.name === 'wait' || tool.name === 'rest';
        var list = el('div', { cls: 'cockpit-tool-list', role: 'group', 'aria-label': '可用能力' });
        ['世界与行动', '设备', '意识与记忆'].forEach(function (category) {
            var members = tools.filter(function (t) { return group(t) === category; });
            if (!members.length) return;
            list.appendChild(el('h3', { text: category }));
            members.forEach(function (t) {
                var b = button(label(t), function () { draft.selected = t.name; actions.redraw(); }, 'cockpit-tool' + (t === tool ? ' selected' : ''));
                b.dataset.cockpitTool = t.name;
                b.setAttribute('aria-pressed', String(t === tool));
                b.appendChild(el('small', { text: t.name }));
                list.appendChild(b);
            });
        });
        draft.values = draft.values || Object.create(null);
        var values = draft.values[tool.name] || (draft.values[tool.name] = Object.create(null)), schema = tool.inputSchema || { type: 'object', properties: {} }, readers = [];
        var form = el('form', { cls: 'cockpit-form' }), error = el('div', { cls: 'journey-error', role: 'alert', hidden: true });
        form.noValidate = true;
        form.append(el('h3', { text: label(tool) }), el('code', { text: tool.name }), note(tool.description || '以角色当前能力执行。'));
        function field(name, spec, required) {
            var value = values[name], type = Array.isArray(spec.type) ? spec.type.find(function (t) { return t !== 'null'; }) : spec.type, control;
            if (value === undefined && spec.default !== undefined) value = values[name] = spec.default;
            if (spec.enum || type === 'boolean') {
                control = el('select', { cls: 'journey-input' }, [el('option', { value: '', text: required ? '请选择' : '使用默认值' })]);
                (spec.enum || [true, false]).forEach(function (v) { control.appendChild(el('option', { value: JSON.stringify(v), text: v === true ? '是' : v === false ? '否' : String(v) })); });
                control.value = value === undefined ? '' : JSON.stringify(value);
                control.onchange = function () { values[name] = control.value === '' ? undefined : JSON.parse(control.value); };
                readers.push(function (args) { if (control.value !== '') args[name] = JSON.parse(control.value); });
            } else if (type === 'number' || type === 'integer') {
                control = el('input', { cls: 'journey-input', type: 'number', step: type === 'integer' ? '1' : 'any', value: value === undefined ? '' : String(value) });
                if (spec.minimum !== undefined) control.min = spec.minimum;
                if (spec.maximum !== undefined) control.max = spec.maximum;
                control.oninput = function () { values[name] = control.value; };
                readers.push(function (args) { if (control.value !== '') args[name] = Number(control.value); });
            } else {
                var structured = type !== 'string';
                control = el('textarea', { cls: 'journey-input', rows: structured ? '4' : '2', placeholder: structured ? (type === 'array' ? '[]' : '{}') : '' });
                control.value = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
                control.oninput = function () { values[name] = control.value; };
                readers.push(function (args) { if (control.value !== '') { try { args[name] = structured ? JSON.parse(control.value) : control.value; } catch (_) { throw new Error(name + ' 需要有效的 JSON。'); } } });
            }
            control.required = required;
            control.dataset.cockpitField = tool.name + ':' + name;
            form.appendChild(el('label', { cls: 'journey-field' }, [el('span', { cls: 'journey-label', text: (timed && ['n', 'duration'].includes(name) ? '时长 · TU' : fields[name] || name) + (required ? ' *' : ' · 可选') }), control, spec.description ? note(spec.description) : null]));
        }
        Object.entries(schema.properties || {}).forEach(function (entry) { field(entry[0], entry[1], (schema.required || []).includes(entry[0])); });
        // Conditional or open schemas remain fully usable through the exact JSON schema.
        var advanced = el('details', { cls: 'cockpit-schema', open: !!values.__advanced }), raw = el('textarea', { cls: 'journey-input cockpit-json', rows: '6', 'data-cockpit-field': tool.name + ':raw', placeholder: '留空使用上方表单；填写后以这里的完整参数为准' });
        raw.value = values.__raw || '';
        raw.oninput = function () { values.__raw = raw.value; };
        advanced.ontoggle = function () { values.__advanced = advanced.open; };
        advanced.append(el('summary', { text: '完整 Schema / 高级 JSON 参数' }), el('pre', { text: JSON.stringify(schema, null, 2) }), raw);
        form.appendChild(advanced);
        var duration = el('input', { cls: 'journey-input', type: 'number', min: '0', step: 'any', value: values.__estimate || '0', 'data-cockpit-field': 'duration', oninput: function () { values.__estimate = duration.value; } });
        duration.required = true;
        if (timed) form.appendChild(note('这里的时长参数单位为 TU，1 TU = ' + (data.unitWorldSeconds || '?') + ' 世界秒。' + (tool.name === 'rest' ? '未指定或非正数时，休息计时为 300 TU；重要动静可提前打断。' : '等待可被重要通知提前打断。')));
        else form.appendChild(el('label', { cls: 'journey-field' }, [el('span', { cls: 'journey-label', text: '预计时长 · 世界秒' }), duration, note('1 TU = ' + (data.unitWorldSeconds || '?') + ' 世界秒；表单会换算后提交。0 表示完成即返回。')]));
        var confirmSend = el('input', { type: 'checkbox', 'data-cockpit-confirm-send': '' });
        if (tool.requiresSendConfirmation) form.appendChild(el('label', { cls: 'cockpit-confirm' }, [confirmSend, el('span', { text: '确认把这次填写的内容发送到聊天平台' })]));
        var submit = el('button', { type: 'submit', cls: 'journey-button journey-primary', text: data.submitting ? '正在等待回执…' : '执行 ' + label(tool), disabled: !data.synced || !!data.blocked || !!data.submitting || !data.unitWorldSeconds });
        form.append(error, submit, note('打开应用、观察和移动等操作可能更新能力目录；每次以实际回执为准。'));
        form.onsubmit = function (event) {
            event.preventDefault();
            try {
                if (!raw.value.trim() && !form.reportValidity()) return;
                if (tool.requiresSendConfirmation && !confirmSend.checked) throw new Error('请先确认本次发送的内容和目标会话。');
                var args = {};
                if (raw.value.trim()) args = JSON.parse(raw.value); else readers.forEach(function (read) { read(args); });
                if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象。');
                var seconds = timed ? 0 : Number(duration.value);
                if (!Number.isFinite(seconds) || seconds < 0) throw new Error('预计时长需要为非负的世界秒。');
                actions.call(tool.name, args, seconds / data.unitWorldSeconds, confirmSend.checked);
            } catch (e) { error.hidden = false; error.textContent = e.message; }
        };
        panel.appendChild(el('div', { cls: 'cockpit-layout' }, [list, form]));
        return panel;
    }
    return { mount: mount };
})();
