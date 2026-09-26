/* A persistent, schema-driven human controller for the same tools used by BotAgent. */
var WorldCockpit = (function () {
    'use strict';
    var labels = { think: '内心独白', observe_device: '看向设备', act: '世界行动', reflect: '整理认识', recall_growth: '回顾成长', wait: '等待', rest: '休息', check_time: '查看时间', read_channel: '阅读会话', check_msg: '查看消息', select_channel: '进入会话', pick_up_phone: '拿起手机', put_down_phone: '放下手机', open_app: '打开应用', close_app: '关闭应用', open_computer: '打开电脑', close_computer: '关闭电脑', run_command: '运行终端命令', screen: '查看屏幕', keyboard: '使用键盘', mouse: '使用鼠标', travel: '前往其他世界', go_home: '回家', send: '发送消息', view_media: '查看媒体', pick_media: '选择媒体', check_gallery: '翻看收藏', check_media: '查看媒体缓存' };
    var fields = { thought: '心里浮现的想法', intent: '观察意图', description: '动作描述', speech: '说出的原话', target: '目标', observationId: '观测依据', device: '设备', scope: '观察范围', modality: '感知方式', query: '检索内容', text: '文字', app: '应用', command: '命令', channel: '会话', channelId: '会话', content: '内容', name: '名称', path: '路径', title: '标题', url: '网址', n: '数量', kind: '认识类别', subject: '关于谁或什么', subject_id: '关联对象身份', situation: '适用情境', cues: '回忆线索', expires_at: '到期世界时间（TU）', include_inactive: '包含已结束的认识', statement: '你的认识', event_ids: '亲历证据', claim_id: '已有认识', relation: '更新方式', msg: '消息正文', msg_id: '消息', msg_ids: '消息', reply_to: '回复哪条消息', id: '对象', media: '媒体', repeat: '允许重复动作', duration: '时长', full: '完整信息' };
    var words = { phone: '手机', computer: '电脑', self: '自己', all: '周围与自己', sight: '眼前景象', relationship: '关系', commitment: '承诺', preference: '偏好', state: '临时状态', habit: '习惯', trait: '性格倾向', retire: '停止沿用', support: '补充证据', counter: '记录反例', revise: '修正判断' };
    function label(tool) { return labels[tool.name] || tool.title || tool.name; }
    function note(text) { return el('p', { cls: 'journey-note', text: text }); }
    function button(text, run, cls) { return el('button', { type: 'button', cls: cls || 'journey-button', text: text, onclick: run }); }
    function group(tool) {
        if (tool.device || /^(?:phone\.|computer\.|app\.|pick_up_phone|put_down_phone|open_app|close_app|open_computer|close_computer|run_command|screen|keyboard|mouse|observe_device)/.test(tool.name)) return '设备';
        if (tool.name === 'think' || /reflect|recall|remember|note/.test(tool.name)) return '意识与记忆';
        return '世界与行动';
    }
    function mount(initial, draft, actions) {
        var data = initial, selected = null, schemaStamp = '', fieldUpdaters = [], form = null, submit = null, error = null, confirmSend = null;
        var selection = null, selectionMessage = '', localSubmitting = false, observedSubmission = false, replacement = null, composing = false;
        draft.values = draft.values || Object.create(null);
        draft.savedOpportunityDrafts = draft.savedOpportunityDrafts || [];
        if (draft.selected === 'observe') {
            var previousObservation = draft.values.observe || {};
            draft.selected = 'act'; draft.values.act = draft.values.act || {};
            if (!draft.values.act.description && previousObservation.intent) draft.values.act.description = previousObservation.intent;
        }
        var panel = el('section', { cls: 'cockpit', 'aria-label': '角色驾驶舱' }), head = el('div', { cls: 'cockpit-bar' }), choice = button('选择能力', function () { picker.hidden = !picker.hidden; formHost.hidden = !picker.hidden; choice.textContent = picker.hidden ? '选择能力' : '返回操作'; choice.setAttribute('aria-expanded', String(!picker.hidden)); }, 'journey-button cockpit-choice');
        choice.setAttribute('aria-expanded', 'false');
        var heading = el('strong', { cls: 'cockpit-current' }), count = el('span', { cls: 'cockpit-count' });
        head.append(heading, count, choice);
        var picker = el('div', { cls: 'cockpit-picker', hidden: true }), list = el('div', { cls: 'cockpit-tool-list', role: 'group', 'aria-label': '可用能力' });
        var search = el('input', { type: 'search', cls: 'journey-input', placeholder: '搜索能力或应用', 'aria-label': '搜索能力' });
        search.oninput = function () { list.querySelectorAll('[data-cockpit-tool]').forEach(function (node) { node.hidden = !node.textContent.toLowerCase().includes(search.value.trim().toLowerCase()); }); };
        picker.append(search, list);
        var selectedChoice = el('div', { cls: 'cockpit-selected-choice', hidden: true }), choiceLabel = el('strong'), choiceNote = el('p', { cls: 'journey-note' });
        var freeAction = button('改为自由操作', function () { clearSelection(); update(data); if (actions.changed) actions.changed(); }, 'cockpit-add');
        selectedChoice.append(el('div', {}, [choiceLabel, choiceNote]), freeAction);
        var replacementNotice = el('div', { cls: 'cockpit-draft-notice', hidden: true, role: 'status' }), replacementText = el('p', { cls: 'journey-note' });
        replacementNotice.append(replacementText, button('保留当前草稿', function () { replacement = null; replacementNotice.hidden = true; if (actions.resize) actions.resize(); }, 'cockpit-add'), button('暂存草稿，填写建议', function () { if (replacement) prepareChoice(replacement, true); }, 'cockpit-add'));
        var queue = el('div', { cls: 'cockpit-queue', 'aria-label': '执行中的工具' }), status = el('p', { cls: 'journey-note cockpit-control-note', role: 'status' }), formHost = el('div', { cls: 'cockpit-form-host' });
        var recovery = button('恢复输入，结果留待核对', function () { if (actions.recover) actions.recover(); }, 'journey-button cockpit-recover'); recovery.hidden = true;
        var restoreDraft = button('恢复暂存草稿', function () {
            if (composing) return report('请先完成正在输入的文字，当前草稿已保留。');
            var saved = draft.savedOpportunityDrafts.pop(); if (!saved) return;
            var previous = draft.values[saved.name]; if (hasContents(previous)) draft.savedOpportunityDrafts.unshift({ name: saved.name, values: copy(previous) });
            clearSelection(); draft.values[saved.name] = saved.values; selected = null; select(saved.name);
        }, 'cockpit-add'); restoreDraft.hidden = !draft.savedOpportunityDrafts.length;
        panel.append(head, picker, selectedChoice, replacementNotice, status, recovery, queue, restoreDraft, formHost);
        panel.addEventListener('compositionstart', function () { composing = true; });
        panel.addEventListener('compositionend', function () { composing = false; });
        function copy(value) { return JSON.parse(JSON.stringify(value)); }
        function clearSelection() { selection = null; draft.opportunityId = null; delete draft.opportunitySelection; selectionMessage = ''; replacement = null; replacementNotice.hidden = true; }
        function sameValue(a, b) {
            if (a === b) return true;
            if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
            var keys = Object.keys(a).filter(function (key) { return a[key] !== undefined; }), others = Object.keys(b).filter(function (key) { return b[key] !== undefined; });
            return keys.length === others.length && keys.every(function (key) { return Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]); });
        }
        function currentOpportunity(item) {
            var current = (data.opportunities || []).find(function (candidate) { return candidate.id === item.id && candidate.sourceEventId === item.sourceEventId; });
            return current && ['label', 'intent', 'source', 'replyTo', 'call'].every(function (key) { return sameValue(current[key], item[key]); }) ? current : null;
        }
        function callFor(item) {
            if (item.replyTo) return { name: 'send', arguments: { id: item.replyTo, msg: '' } };
            return item.call ? copy(item.call) : null;
        }
        function selectionRef(item) { return { opportunityId: item.id, sourceEventId: item.sourceEventId }; }
        function hasContents(values) { return !!values && (Object.keys(values).some(function (key) { return !key.startsWith('__') && values[key] !== undefined && values[key] !== '' && (typeof values[key] !== 'object' || values[key] && Object.keys(values[key]).length); }) || !!(values.__raw && values.__raw.trim())); }
        function report(message) { selectionMessage = message; update(data); return false; }
        function canExecute(name) { return data.synced && !data.blocked && !data.submitting && !localSubmitting && !!data.unitWorldSeconds && data.tools.some(function (tool) { return tool.name === name; }); }
        function execute(name, args, duration, confirmed, item) {
            if (!canExecute(name)) return report('现在暂时不能执行这项操作，请等待控制状态就绪。');
            if (item && !currentOpportunity(item)) return report('这条建议已变化或不可用，本次没有执行。请查看最新建议；已填写的内容会保留。');
            localSubmitting = true; observedSubmission = false; selectionMessage = ''; update(data);
            var result;
            try { result = actions.call(name, args, duration, confirmed, item ? selectionRef(item) : undefined); }
            catch (failure) { localSubmitting = false; report(failure.message || '执行请求失败，请核对状态后重试。'); return false; }
            if (result === false) { localSubmitting = false; return report('操作未提交，请等待控制状态更新后重试。'); }
            if (result && typeof result.then === 'function') Promise.resolve(result).then(function () { localSubmitting = false; update(data); }, function (failure) { localSubmitting = false; report(failure.message || '执行结果尚未确认，请先核对执行记录。'); });
            else if (!data.submitting) { localSubmitting = false; update(data); }
            return true;
        }
        function candidates(name, tool) {
            var context = data.choices || {}, devices = data.deviceSession || {}, chat = devices.chat || {}, result = null;
            if (name === 'target' && (tool.name === 'act')) {
                return null; // World targets are descriptions, never observation handles.
            } else if (tool.name === 'open_app' && name === 'name') result = (devices.apps || []).map(function (a) { return { value: a.id, text: a.name || a.title || a.id }; });
            else if (['channel', 'channelId', 'id'].includes(name) && /^(select_channel|send|channel_notify|unsend|react|get_emoji_likes|forward_msgs)$/.test(tool.name)) result = (chat.channels || []).map(function (c) { return { value: c.key, text: c.name || c.title || (c.participants || []).map(function (p) { return p.username; }).filter(Boolean).join('、') || c.channelId || c.key }; });
            else if (['msg_id', 'msg_ids', 'reply_to'].includes(name) && /^(send|unsend|react|get_emoji_likes|forward_msgs|view_forward|set_essence)$/.test(tool.name)) result = (chat.messages || []).filter(function (m) { return m.messageId; }).map(function (m) { return { value: String(m.messageId), text: (m.username || m.userName || m.senderName || '消息') + ' · ' + ReadableData.text(m.content || m.text || '').slice(0, 95) }; });
            else if (name === 'event_ids' && /^(reflect|recall_growth)$/.test(tool.name)) result = (context.evidence || []).map(function (e) { return { value: e.id, text: e.label || e.text || e.id }; });
            else if (name === 'claim_id' && /^(reflect|recall_growth)$/.test(tool.name)) result = (context.claims || []).map(function (c) { return { value: c.id, text: c.label || c.statement || c.id }; });
            else if (name === 'media' && /^(view_media|pick_media|send)$/.test(tool.name)) result = (context.mediaCache || []).concat(context.galleryMedia || []);
            else if (name === 'media_id' && tool.name === 'gallery_save') result = context.mediaCache || [];
            else if (name === 'name' && /^gallery_(move|remove)$/.test(tool.name)) result = (context.galleryMedia || []).map(function (c) { return Object.assign({}, c, { value: c.value.replace(/^gallery:/, '') }); });
            else if (name === 'title' && /^(view_note|edit_note|delete_note)$/.test(tool.name)) result = context.noteTitles || [];
            else if (context[name] && Array.isArray(context[name])) result = context[name].map(function (c) { return { value: c.value === undefined ? c.id : c.value, text: c.label || c.name || String(c.value === undefined ? c.id : c.value) }; });
            return result;
        }
        function select(toolName, preserveChoice) {
            if (!data.tools.some(function (t) { return t.name === toolName; })) return;
            if (!preserveChoice) clearSelection();
            if (selected && selected.name === toolName && schemaStamp !== JSON.stringify(data.tools.find(function (t) { return t.name === toolName; }).inputSchema || {})) selected = null;
            draft.selected = toolName; picker.hidden = true; formHost.hidden = false; choice.textContent = '选择能力'; choice.setAttribute('aria-expanded', 'false'); update(data);
            if (actions.changed) actions.changed();
            if (actions.resize) actions.resize();
        }
        function build(tool) {
            selected = tool; schemaStamp = JSON.stringify(tool.inputSchema || {}); fieldUpdaters = [];
            if (actions.prepare) actions.prepare(tool);
            var internal = tool.name === 'think';
            var values = draft.values[tool.name] || (draft.values[tool.name] = Object.create(null)), schema = tool.inputSchema || { type: 'object', properties: {} }, timed = tool.name === 'wait' || tool.name === 'rest', readers = [];
            form = el('form', { cls: 'cockpit-form' }); form.noValidate = true;
            form.addEventListener('input', function (event) {
                if (!selection) return;
                var field = event.target.dataset.cockpitField;
                if (field === tool.name + ':speech' && tool.name === 'act' || field === 'send:msg' && selection.replyTo || field === 'duration') return;
                if (field) { clearSelection(); selectionMessage = '已按你的修改切换为自由操作，提交时会使用表单中的完整内容。'; update(data); if (actions.changed) actions.changed(); }
            });
            form.addEventListener('change', function (event) {
                if (!selection || event.target.matches('[data-cockpit-confirm-send]')) return;
                var field = event.target.dataset.cockpitField;
                if (field && field !== 'duration' && field !== tool.name + ':speech' && !(field === 'send:msg' && selection.replyTo)) { clearSelection(); selectionMessage = '已按你的修改切换为自由操作，提交时会使用表单中的完整内容。'; update(data); if (actions.changed) actions.changed(); }
            });
            error = el('div', { cls: 'journey-error', role: 'alert', hidden: true });
            var primary = el('div', { cls: 'cockpit-primary-fields' }), optional = el('details', { cls: 'cockpit-options', open: !!values.__options }), extras = el('div', { cls: 'cockpit-extra-fields' });
            optional.append(el('summary', { text: internal ? '选项' : tool.name === 'act' ? '说话与选项' : '选项与预计时长' }), extras);
            optional.ontoggle = function () { values.__options = optional.open; if (actions.resize) actions.resize(); };
            function controlFor(name, spec, value, required, path) {
                spec = spec || {}; var type = Array.isArray(spec.type) ? spec.type.find(function (t) { return t !== 'null'; }) : spec.type || (spec.properties ? 'object' : 'string');
                var holder = el('div', { cls: 'cockpit-control' }), input, read, update = function () {};
                if (value === undefined && spec.default !== undefined) value = spec.default;
                var choices = candidates(name, tool), enumValues = spec.enum || (type === 'boolean' ? [true, false] : null);
                if (type === 'array') {
                    var rows = el('div', { cls: 'cockpit-array' }), items = [], counter = 0;
                    function add(item) {
                        var index = counter++, child = controlFor(name, spec.items || { type: 'string' }, item, true, path + '.' + index), row = el('div', { cls: 'cockpit-array-row' }), entry = { control: child, row: row };
                        row.append(child.node, button('移除', function () { items.splice(items.indexOf(entry), 1); row.remove(); save(); }, 'cockpit-remove')); rows.appendChild(row); items.push(entry);
                    }
                    holder.append(rows, button('＋ 添加' + (fields[name] || '一项'), function () { add(undefined); save(); if (actions.resize) actions.resize(); }, 'cockpit-add'));
                    (Array.isArray(value) ? value : []).forEach(add);
                    read = function () { var result = items.map(function (item) { return item.control.read(); }).filter(function (item) { return item !== undefined; }); if (required && !result.length) throw Error((fields[name] || name) + '至少选择一项。'); return result.length ? result : undefined; };
                } else if (type === 'object') {
                    var nested = [], props = spec.properties || {};
                    Object.entries(props).forEach(function (entry) { var child = controlFor(entry[0], entry[1], value && value[entry[0]], false, path + '.' + entry[0]); nested.push({ name: entry[0], field: child, required: (spec.required || []).includes(entry[0]) }); holder.append(el('label', { cls: 'journey-field' }, [el('span', { cls: 'journey-label', text: fields[entry[0]] || entry[0] }), child.node])); });
                    if (!nested.length) { input = el('textarea', { cls: 'journey-input cockpit-json', rows: '2', placeholder: '此扩展字段没有定义结构，可填写 JSON' }); input.value = value === undefined ? '' : JSON.stringify(value, null, 2); holder.appendChild(input); }
                    read = function () { var result = {}; if (input) { if (!input.value.trim()) return undefined; try { result = JSON.parse(input.value); } catch (_) { throw Error((fields[name] || name) + '需要有效的 JSON 对象。'); } if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error((fields[name] || name) + '需要对象。'); return result; } nested.forEach(function (entry) { var v = entry.field.read(); if (v !== undefined) result[entry.name] = v; }); if (required || Object.keys(result).length) { nested.forEach(function (entry) { if (entry.required && result[entry.name] === undefined) throw Error((fields[entry.name] || entry.name) + '不能为空。'); }); return result; } };
                } else if (enumValues || choices !== null) {
                    input = el('select', { cls: 'journey-input' }); var manual = null, selectedValue = value, lastOptions = '', preview = el('div', { cls: 'cockpit-choice-preview' }), previewKey = '';
                    var observedHandle = name === 'target' && tool.name === 'act', evidenceHandle = ['event_ids', 'claim_id'].includes(name) && ['reflect', 'recall_growth'].includes(tool.name);
                    if (!enumValues && !observedHandle && !evidenceHandle) {
                        manual = el('input', { cls: 'journey-input cockpit-manual', type: 'text', placeholder: '填写已知编号', hidden: true, 'aria-label': (fields[name] || name) + '的已知编号' });
                        manual.value = value === undefined ? '' : String(value); holder.appendChild(manual);
                    }
                    function updatePreview() {
                        var value = input.value && input.value !== '__manual__' ? JSON.parse(input.value) : null, choice = (candidates(name, tool) || []).find(function (c) { return c.value === value; }), key = choice && choice.preview || '';
                        if (key === previewKey) return; previewKey = key; preview.replaceChildren();
                        if (key && key.startsWith('/api/')) preview.appendChild(el('a', { href: withToken(key), target: '_blank', rel: 'noopener noreferrer', 'aria-label': '查看所选媒体原图' }, [el('img', { src: withToken(key), alt: choice.text, loading: 'lazy' })]));
                    }
                    update = function () {
                        var list = enumValues ? enumValues.map(function (v) { return { value: v, text: v === true ? '是' : v === false ? '否' : words[v] || String(v) }; }) : candidates(name, tool) || [];
                        var next = JSON.stringify(list); if (next === lastOptions) return; lastOptions = next;
                        var wasManual = input.value === '__manual__', old = input.value && !wasManual ? JSON.parse(input.value) : selectedValue;
                        input.replaceChildren(el('option', { value: '', text: required ? (list.length ? '点选' : '暂无可选') + (fields[name] || name) : '不指定 · 使用默认值' }));
                        list.forEach(function (c) { input.appendChild(el('option', { value: JSON.stringify(c.value), text: String(c.text).replace(/\s+/g, ' ').slice(0, 180) })); });
                        if (manual) input.appendChild(el('option', { value: '__manual__', text: '填写其他已知编号…' }));
                        if (wasManual) input.value = '__manual__';
                        else if (old !== undefined && list.some(function (c) { return c.value === old; })) input.value = JSON.stringify(old);
                        else if (old !== undefined && !enumValues && !observedHandle) {
                            // Restore the reference without turning an asynchronously
                            // loaded name picker into a field asking humans for IDs.
                            input.appendChild(el('option', { value: JSON.stringify(old), text: '上次选择 · 尚未读取到名称' })); input.value = JSON.stringify(old);
                        }
                        else input.value = '';
                        if (manual) manual.hidden = input.value !== '__manual__';
                        updatePreview();
                    };
                    update(); fieldUpdaters.push(update);
                    input.onchange = function () { if (manual) manual.hidden = input.value !== '__manual__'; selectedValue = input.value && input.value !== '__manual__' ? JSON.parse(input.value) : undefined; if (observedHandle && input.value === '') values[name] = undefined; updatePreview(); save(); };
                    read = function () {
                        if (observedHandle && input.value === '' && values[name] !== undefined && !(candidates(name, tool) || []).some(function (c) { return c.value === values[name]; })) throw Error('之前选择的目标已不在最新观测中。请重新点选，或明确选择“不指定”。');
                        return input.value === '__manual__' ? manual.value.trim() || undefined : input.value === '' ? undefined : JSON.parse(input.value);
                    };
                    holder.prepend(input); holder.appendChild(preview);
                } else if (type === 'number' || type === 'integer') {
                    input = el('input', { cls: 'journey-input', type: 'number', step: type === 'integer' ? '1' : 'any', value: value === undefined ? '' : String(value), inputmode: 'decimal' });
                    if (spec.minimum !== undefined) input.min = spec.minimum;
                    if (spec.maximum !== undefined) input.max = spec.maximum;
                    holder.appendChild(input); read = function () { if (input.value === '') return undefined; var number = Number(input.value); if (!Number.isFinite(number) || type === 'integer' && !Number.isInteger(number)) throw Error((fields[name] || name) + '需要有效数字。'); if (spec.minimum !== undefined && number < spec.minimum || spec.maximum !== undefined && number > spec.maximum) throw Error((fields[name] || name) + '超出了此能力支持的范围。'); return number; };
                } else {
                    input = el('textarea', { cls: 'journey-input', rows: '2', placeholder: internal && name === 'thought' ? '此刻在想什么？可以是牵挂、疑问、回忆或打算。' : tool.name === 'act' && name === 'description' ? '想做什么？例如走到窗边，把窗户推开。' : name === 'speech' ? '需要说些什么？可以留空。' : name === 'target' && tool.name === 'act' ? '用名字或描述指定，例如柜台后的店员；可以留空' : '' });
                    input.value = value === undefined ? '' : String(value); holder.appendChild(input); read = function () { return input.value === '' ? undefined : input.value; };
                }
                if (input) { input.dataset.cockpitField = tool.name + ':' + path; input.setAttribute('aria-label', fields[name] || name); if (required && input.tagName !== 'SELECT') input.required = true; }
                if (input && selection && selection.replyTo && tool.name === 'send' && name === 'id') { input.disabled = true; input.dataset.choiceTarget = '1'; }
                function save() { try { var result = read(); if (!path.includes('.')) values[name] = result; } catch (_) {} }
                holder.addEventListener('input', save); holder.addEventListener('change', save);
                return { node: holder, read: function () { var result = read(); if (required && result === undefined) throw Error((fields[name] || name) + '不能为空。'); return result; } };
            }
            Object.entries(schema.properties || {}).forEach(function (entry) {
                var name = entry[0], spec = entry[1], required = (schema.required || []).includes(name);
                if (name === 'observationId' && tool.name === 'act') return;
                var control = controlFor(name, spec, values[name], required, name), row = el('label', { cls: 'journey-field' }, [el('span', { cls: 'journey-label', text: (timed && ['n', 'duration'].includes(name) ? '时长 · TU' : fields[name] || name) + (required ? '' : ' · 可选') }), control.node]);
                if (spec.description) row.appendChild(el('details', { cls: 'cockpit-field-help' }, [el('summary', { text: '参数说明' }), note(spec.description)]));
                (required || selection && tool.name === 'act' && name === 'speech' ? primary : extras).appendChild(row);
                readers.push(function (args) { var value = control.read(); values[name] = value; if (value !== undefined) args[name] = value; });
            });
            var duration = el('input', { cls: 'journey-input', type: 'number', min: '0', step: 'any', value: values.__estimate || '0', 'data-cockpit-field': 'duration', 'aria-label': '预计时长（世界秒）', oninput: function () { values.__estimate = duration.value; } });
            if (!timed && !internal) extras.appendChild(el('label', { cls: 'journey-field' }, [el('span', { cls: 'journey-label', text: '预计时长 · 世界秒' }), duration]));
            var help = el('details', { cls: 'cockpit-help' }, [el('summary', { text: '这项能力如何工作' }), note(tool.description || '以角色当前能力执行。'), note(internal ? '独白只留在角色心里，不会向外说出，也不执行身体动作。' : timed ? '这里的时长使用 TU。1 TU = ' + (data.unitWorldSeconds || '?') + ' 世界秒。' : '预计时长以世界秒填写，提交时自动换算为 TU。0 表示完成即返回。')]);
            var advanced = el('details', { cls: 'cockpit-schema', open: !!values.__advanced }), raw = el('textarea', { cls: 'journey-input cockpit-json', rows: '5', 'data-cockpit-field': tool.name + ':raw', placeholder: '留空使用表单；填写后以完整参数为准' });
            raw.value = values.__raw || ''; raw.oninput = function () { values.__raw = raw.value; }; advanced.ontoggle = function () { values.__advanced = advanced.open; };
            advanced.append(el('summary', { text: '高级参数与原始 Schema' }), ReadableData.raw(schema, { label: '工具参数定义' }), raw); extras.append(help, advanced);
            if (actions.prepare && /^(view_media|pick_media|send|gallery_(save|move|remove)|view_note|edit_note|delete_note)$/.test(tool.name)) extras.appendChild(button('刷新可选内容', function () { actions.prepare(tool, true); }, 'cockpit-add'));
            confirmSend = el('input', { type: 'checkbox', 'data-cockpit-confirm-send': '' });
            if (tool.requiresSendConfirmation) primary.appendChild(el('label', { cls: 'cockpit-confirm' }, [confirmSend, el('span', { text: '确认把本次内容发送到所选聊天会话' })]));
            submit = el('button', { type: 'submit', cls: 'journey-button journey-primary cockpit-submit' });
            form.append(primary, optional, error, submit);
            form.onsubmit = function (event) {
                event.preventDefault(); error.hidden = true;
                try {
                    if (submit.disabled) return;
                    if (tool.requiresSendConfirmation && !confirmSend.checked) throw Error('请先确认本次发送的内容和目标会话。');
                    var args = {}; if (raw.value.trim()) args = JSON.parse(raw.value); else readers.forEach(function (read) { read(args); });
                    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('工具参数必须是对象。');
                    var seconds = timed || internal ? 0 : Number(duration.value); if (!Number.isFinite(seconds) || seconds < 0) throw Error('预计时长需要为非负的世界秒。');
                    var activeSelection = selection;
                    if (activeSelection && !currentOpportunity(activeSelection)) throw Error('这条建议已变化或不可用，本次没有执行。请重新选择建议，或明确改为自由操作。');
                    if (execute(tool.name, args, seconds / data.unitWorldSeconds, confirmSend.checked, activeSelection)) confirmSend.checked = false;
                } catch (e) { error.hidden = false; error.textContent = e.message; }
            };
            formHost.replaceChildren(form);
        }
        var toolStamp = '', queueStamp = '';
        function update(next) {
            data = next; data.tools = (data.tools || []).filter(function (tool) { return tool.name !== 'observe'; });
            if (data.submitting) observedSubmission = true;
            else if (observedSubmission) { localSubmitting = false; observedSubmission = false; }
            var staleChoice = !!selection && !currentOpportunity(selection);
            selectedChoice.hidden = !selection;
            if (selection) { choiceLabel.textContent = '准备：' + selection.label; choiceNote.textContent = staleChoice ? '这条建议已失效，草稿已保留。重新选择建议，或改为自由操作后提交。' : selection.replyTo ? '请写下你自己的回复，并确认发送到所选会话。' : selection.call && selection.call.name === 'act' ? '可以补充台词；执行仍会核对这条建议是否有效。' : '执行前会核对建议与能力是否仍然可用。修改参数会转为自由操作。'; }
            selectedChoice.classList.toggle('cockpit-stale-choice', staleChoice);
            restoreDraft.hidden = !draft.savedOpportunityDrafts.length;
            panel.querySelectorAll('[data-choice-target]').forEach(function (input) { input.disabled = !!(selection && selection.replyTo); });
            if (!draft.selected) draft.selected = (data.tools.find(function (t) { return t.name === 'act'; }) || data.tools[0] || {}).name;
            var tool = data.tools.find(function (t) { return t.name === draft.selected; }), changed = JSON.stringify(data.tools.map(function (t) { return [t.name, t.title, t.device]; }));
            if (toolStamp !== changed) {
                toolStamp = changed; list.replaceChildren();
                ['世界与行动', '设备', '意识与记忆'].forEach(function (category) {
                    var members = data.tools.filter(function (t) { return group(t) === category; }); if (!members.length) return;
                    list.appendChild(el('h3', { text: category }));
                    members.forEach(function (t) { var b = button(label(t), function () { select(t.name); }, 'cockpit-tool'); b.dataset.cockpitTool = t.name; b.appendChild(el('small', { text: t.name })); list.appendChild(b); });
                }); search.oninput();
            }
            list.querySelectorAll('[data-cockpit-tool]').forEach(function (b) { b.classList.toggle('selected', b.dataset.cockpitTool === draft.selected); b.setAttribute('aria-pressed', String(b.dataset.cockpitTool === draft.selected)); });
            if (tool && (!selected || selected.name !== tool.name)) build(tool);
            // Changes from polling never replace an input node. A changed schema is
            // applied only after the user switches away and selects the tool again.
            var schemaChanged = !!tool && !!selected && schemaStamp !== JSON.stringify(tool.inputSchema || {});
            fieldUpdaters.forEach(function (update) { update(); });
            panel.dataset.tool = selected ? selected.name : '';
            heading.textContent = selected ? label(selected) : '角色能力'; count.textContent = data.tools.length + ' 项可用';
            status.textContent = data.uncertain ? '请求结果尚未确认，不会自动重发。可保留执行记录并恢复输入。' : !data.synced ? '正在同步控制状态' : !tool ? '这项能力已不可用。草稿已保留，请选择当前可用能力。' : schemaChanged ? '能力参数已更新，请重新选择这项能力后执行。' : data.blocked ? data.blockedReason || '暂时不能操作角色，请检查控制状态。' : data.submitting || localSubmitting ? '正在执行，你可以继续查看状态与准备下一步。' : selectionMessage;
            recovery.hidden = !data.uncertain;
            status.classList.toggle('journey-pending', !!data.submitting);
            status.hidden = !status.textContent;
            if (submit) { submit.disabled = !tool || schemaChanged || staleChoice || !data.synced || !!data.blocked || !!data.submitting || localSubmitting || !data.unitWorldSeconds; submit.textContent = data.submitting || localSubmitting ? '等待执行回执' : selected.name === 'think' ? '留下这段想法' : selection ? (selection.replyTo ? '确认发送回复' : '执行这条建议') : '执行 ' + label(selected); }
            var pending = data.pending || [], nextQueue = JSON.stringify(pending);
            if (nextQueue !== queueStamp) { queueStamp = nextQueue; queue.replaceChildren(); pending.forEach(function (call) { queue.appendChild(el('div', { cls: 'cockpit-pending' }, [el('span', { cls: 'journey-pulse' }), el('div', {}, [el('strong', { text: label(call) }), note(call.committed ? '变化已提交，等待最终回执' : '执行中 · 可请求取消')]), button('请求取消', function () { actions.cancel(call.callId || call.id); })])); }); }
            if (!selected && data.synced) formHost.textContent = '当前没有可用能力。世界与设备状态改变后，这里会自动更新。';
            if (actions.resize) actions.resize();
        }
        function prepareChoice(item, replaceDraft) {
            var current = currentOpportunity(item), call = current && callFor(current);
            if (!current || !call) return report('这条建议已变化或不可用，本次没有执行。请查看最新建议。');
            if (!data.tools.some(function (tool) { return tool.name === call.name; })) return report('建议需要的能力暂时不可用，当前草稿已保留。');
            if (composing) return report('请先完成正在输入的文字，当前草稿已保留。');
            if (selection && selection.id === current.id && selection.sourceEventId === current.sourceEventId && selected && selected.name === call.name) { picker.hidden = true; formHost.hidden = false; return true; }
            var previous = draft.values[call.name], hasDraft = hasContents(previous);
            if (hasDraft && !replaceDraft) {
                replacement = copy(current); replacementText.textContent = '「' + label({ name: call.name }) + '」还有未提交的内容。保留它，或先暂存，再填写「' + current.label + '」。'; replacementNotice.hidden = false; if (actions.resize) actions.resize(); return false;
            }
            if (hasDraft) draft.savedOpportunityDrafts.push({ name: call.name, values: copy(previous) });
            replacement = null; replacementNotice.hidden = true;
            draft.values[call.name] = Object.assign({}, copy(call.arguments || {}), { __estimate: String((call.duration || 0) * (data.unitWorldSeconds || 1)), __options: false });
            selection = copy(current); draft.opportunitySelection = copy(current); draft.opportunityId = current.id; selectionMessage = ''; selected = null; select(call.name, true); return true;
        }
        panel.chooseOpportunity = function (item, options) {
            var current = currentOpportunity(item), call = current && callFor(current);
            if (!current || !call) return report('这条建议已变化或不可用，本次没有执行。请查看最新建议。');
            var tool = data.tools.find(function (tool) { return tool.name === call.name; });
            if (!tool) return report('建议需要的能力暂时不可用，当前草稿已保留。');
            if (options && options.edit || current.replyTo || tool.requiresSendConfirmation) return prepareChoice(current, false);
            return execute(call.name, copy(call.arguments || {}), call.duration || 0, false, current);
        };
        panel.prepareOpportunity = panel.useOpportunity = function (item) { return panel.chooseOpportunity(item, { edit: true }); };
        panel.prepareAction = function (intent) { draft.values.act = { description: intent }; draft.opportunityId = null; selected = null; select('act'); };
        panel.update = update;
        panel.select = select;
        panel.setTarget = function (target) { draft.values.act = draft.values.act || {}; draft.values.act.target = target; if (!selected || selected.name !== 'act') select('act'); var input = panel.querySelector('[data-cockpit-field="act:target"]'); if (input) { input.value = target; input.dispatchEvent(new Event('change', { bubbles: true })); } };
        if (draft.opportunitySelection && callFor(draft.opportunitySelection) && callFor(draft.opportunitySelection).name === draft.selected) selection = copy(draft.opportunitySelection);
        else { draft.opportunityId = null; delete draft.opportunitySelection; }
        update(initial); return panel;
    }
    return { mount: mount, label: label };
})();
