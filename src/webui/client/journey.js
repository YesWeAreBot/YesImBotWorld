(function () {
    'use strict';
    var sessions = Object.create(null);
    function digest(value) { var h = 2166136261; for (var i = 0; i < value.length; i++)
        h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }
    function scope() { return (isVisitor() ? 'visitor:' : 'admin:') + digest(String(isVisitor() ? VISITOR_TOKEN : TOKEN)); }
    function getSession(key) {
        if (sessions[key])
            return sessions[key];
        var saved = {};
        try {
            saved = JSON.parse(sessionStorage.getItem('studio.journey.' + key) || '{}');
        }
        catch (_) { }
        return sessions[key] = Object.assign({ token: '', worldName: '', phase: 'outside', takeover: false, events: [], observation: null, pending: null, unitWorldSeconds: null, lastTimeLine: '' }, saved, { connection: 'disconnected' });
    }
    function persist(key, session) { try {
        sessionStorage.setItem('studio.journey.' + key, JSON.stringify(session));
    }
    catch (_) { } }
    function text(value) { return value == null ? '未知' : typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
    var attributeNames = { posture: '姿态', hunger: '饥饿', health: '健康', energy: '精力', thirst: '口渴', temperature: '温度', lighting: '光线', material: '材质', open: '打开', filled: '装满', consciousness: '意识状态', injuries: '伤情', wetness: '湿润', powered: '电源' };
    function time(ts) { return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    function button(label, action, cls) { return el('button', { type: 'button', cls: 'journey-button ' + (cls || ''), text: label, onclick: action }); }
    function note(value, cls) { return el('p', { cls: 'journey-note ' + (cls || ''), text: value }); }
    function field(label, control, hint) { return el('label', { cls: 'journey-field' }, [el('span', { cls: 'journey-label', text: label }), control, hint ? note(hint) : null]); }
    function portal() {
        var holder = el('div', { cls: 'journey-portal', 'aria-hidden': 'true' });
        holder.innerHTML = '<svg viewBox="0 0 360 250" fill="none"><path d="M26 217H334M53 228H308M93 238H272" stroke="currentColor" opacity=".15"/><path d="M103 214V89C103 44 139 19 179 19S255 44 255 89V214" fill="var(--panel2)" stroke="currentColor" stroke-width="1.4"/><path d="M123 214V92C123 58 148 39 179 39S235 58 235 92V214" fill="var(--surface)" stroke="currentColor" stroke-width="1.4"/><path d="M134 207L204 191V64L134 84V207Z" fill="var(--accent)"/><path d="M146 180V97L192 83V168L146 180Z" stroke="var(--surface)" opacity=".35"/><circle cx="186" cy="133" r="3" fill="var(--accent2)"/><path d="M160 215L220 200L288 219" stroke="currentColor" opacity=".2"/><path d="M64 210V176M64 191C40 186 39 172 42 159C62 164 69 176 64 191ZM65 182C86 176 88 162 84 150C68 157 61 168 65 182Z" stroke="currentColor" stroke-width="1.5"/><path d="M44 211H85L80 229H49L44 211Z" fill="var(--accent2)" opacity=".7"/><circle cx="282" cy="63" r="18" fill="var(--accent2)" opacity=".25"/><path d="M281 36V29M309 63H316M261 43L256 38" stroke="var(--accent2)" stroke-width="1.5"/><path d="M214 100H229M218 115H229M212 130H229" stroke="currentColor" opacity=".18"/><circle cx="299" cy="185" r="3" fill="var(--accent2)"/><path d="M294 171H304M299 166V176" stroke="currentColor" opacity=".4"/></svg>';
        return holder;
    }
    Studio.register('player', function (container) {
        var key = scope(), state = getSession(key), destroyed = false, stream = null, busy = false, observeBusy = false, selectedTarget = '';
        var profile = { name: '', persona: '' }, resident = '', residentDefinition = '', errorText = '', route = state.takeover ? 'takeover' : 'cross', formDraft = { description: '', speech: '', duration: '0' };
        var main = el('div', { cls: 'journey-page' });
        container.appendChild(main);
        var observerLabel = '', connectTimer = null, controlTimer = null, controlRefreshing = false, control = { synced: false, paused: false, busy: false };
        var allowed = !isVisitor() || visitorCanSee(['__player__']);
        if (!allowed) {
            main.appendChild(note('此账号没有玩家入口权限。'));
            return function () { };
        }
        function changed() { persist(key, state); window.dispatchEvent(new CustomEvent('studio:journey', { detail: key })); }
        function redraw() { if (!destroyed)
            render(); }
        function fail(error) { errorText = error && error.message ? error.message : String(error); redraw(); }
        function log(kind, content, extra) {
            state.events.push(Object.assign({ kind: kind, content: content, ts: Date.now(), timeLine: state.lastTimeLine }, extra || {}));
            if (state.events.length > 80)
                state.events.splice(0, state.events.length - 80);
        }
        function absorb(content, kind) {
            if (!content)
                return;
            var parsed = null;
            try {
                parsed = typeof content === 'string' ? JSON.parse(content) : content;
            }
            catch (_) { }
            var observation = parsed && (parsed.observation || (parsed.observationId ? parsed : null));
            if (observation && Array.isArray(observation.entities)) {
                var duplicate = state.events.some(function (event) { return event.observationId === observation.observationId; });
                state.observation = observation;
                observerLabel = '最新观测';
                if (!observation.entities.some(function (entity) { return entity.observedId === selectedTarget; }))
                    selectedTarget = '';
                if (!duplicate) {
                    log('observation', '看到 ' + observation.entities.length + ' 个实体', { observationId: observation.observationId, sourceEventIds: observation.sourceEventIds || [] });
                    (observation.utterances || []).forEach(function (utterance) {
                        if (!state.events.some(function (event) { return event.eventId === utterance.eventId; }))
                            log('speech', utterance.text, { speaker: utterance.speakerName, eventId: utterance.eventId });
                    });
                }
                if (parsed.action) {
                    var actionKey = parsed.action.id ? parsed.action.id + ':' + parsed.action.status : '', actionText = parsed.action.reason || (parsed.action.status === 'completed' ? '世界已返回行动结果。' : '行动状态：' + parsed.action.status);
                    if (!state.events.some(function (event) { return actionKey ? event.actionKey === actionKey : event.content === actionText && Date.now() - event.ts < 2500; }))
                        log(parsed.action.status === 'failed' ? 'failure' : 'result', actionText, { actionKey: actionKey });
                }
            }
            else if (typeof content === 'string' && !state.events.some(function (event) { return event.content === content && Date.now() - event.ts < 2500; }))
                log(kind || 'world', content);
        }
        function closeStream() { if (stream)
            stream.close(); stream = null; clearTimeout(connectTimer); }
        function refreshControl() {
            if (destroyed || isVisitor() || !state.takeover || !state.token || controlRefreshing)
                return;
            controlRefreshing = true;
            var requestToken = state.token;
            api('GET', '/api/device/session').then(function (result) {
                if (destroyed || requestToken !== state.token)
                    return;
                var next = { synced: true, paused: !!(result.control && result.control.paused), busy: !!(result.control && result.control.busy) };
                if (JSON.stringify(next) !== JSON.stringify(control)) {
                    control = next;
                    redraw();
                }
            }).catch(function () { if (!destroyed && requestToken === state.token && control.synced) {
                control.synced = false;
                redraw();
            } }).finally(function () { controlRefreshing = false; });
        }
        function connect() {
            closeStream();
            if (!state.token || destroyed)
                return;
            state.connection = 'connecting';
            observerLabel = state.observation ? '上次保存的观测' : '';
            refreshControl();
            redraw();
            var capturedToken = state.token;
            stream = new EventSource(withToken('/api/player/events?ctoken=' + encodeURIComponent(capturedToken)));
            stream.onopen = function () { if (capturedToken !== state.token)
                return; state.connection = 'connected'; errorText = ''; redraw(); };
            stream.onerror = function () { if (destroyed || capturedToken !== state.token)
                return; state.connection = 'reconnecting'; if (state.pending && state.pending.status !== 'cancelling')
                state.pending.status = 'unknown'; changed(); redraw(); };
            stream.onmessage = function (event) {
                if (destroyed || capturedToken !== state.token)
                    return;
                var message;
                try {
                    message = JSON.parse(event.data);
                }
                catch (_) {
                    return;
                }
                if (message.type === 'hello') {
                    state.connection = 'connected';
                    state.worldName = message.worldName || state.worldName;
                    state.lastTimeLine = message.timeLine || state.lastTimeLine;
                    if (Number(message.unitWorldSeconds) > 0)
                        state.unitWorldSeconds = Number(message.unitWorldSeconds);
                }
                else if (message.type === 'event' || message.type === 'status_update') {
                    state.lastTimeLine = message.timeLine || state.lastTimeLine;
                    absorb(message.content);
                }
                else if (message.type === 'task_result') {
                    absorb(message.content, message.ok ? 'result' : 'failure');
                    if (state.pending && state.pending.id === message.taskId)
                        state.pending = null;
                    if (message.taskId && message.taskId.indexOf('observe_') === 0)
                        observeBusy = false;
                    if (!message.ok && !message.content)
                        log('failure', '此次请求未完成，请根据最新观测判断。');
                }
                else if (message.type === 'farewell') {
                    closeStream();
                    log('system', message.reason || '你已离开这个世界。');
                    state.phase = 'outside';
                    state.token = '';
                    state.pending = null;
                    state.connection = 'disconnected';
                    state.observation = null;
                }
                changed();
                redraw();
            };
        }
        function saveProfile() {
            var name = profile.name.trim(), persona = profile.persona.trim();
            if (route === 'takeover') {
                name = resident;
                persona = residentDefinition;
                if (!name)
                    return Promise.reject(new Error('还未读取到常驻角色，请稍后重试。'));
            }
            else if (!name)
                return Promise.reject(new Error('请先给角色一个名字。'));
            else if (resident && name === resident)
                return Promise.reject(new Error('独立角色请使用不同的名字；管理员可选择接管常驻角色。'));
            profile = { name: name, persona: persona, mode: 'cross' };
            if (isVisitor())
                return api('PUT', '/api/player/profile', profile);
            try {
                localStorage.setItem('wui_admin_player_profile', JSON.stringify(profile));
            }
            catch (_) { }
            return Promise.resolve();
        }
        function arrive() {
            if (busy)
                return;
            busy = true;
            errorText = '';
            redraw();
            saveProfile().then(function () {
                return api('POST', '/api/player/arrive', isVisitor() ? { mode: 'cross' } : { name: profile.name, persona: profile.persona, mode: route === 'takeover' ? 'avatar' : 'cross' });
            }).then(function (result) {
                if (!result.token)
                    throw new Error(result.error || '入场尚未建立会话。');
                state.token = result.token;
                state.phase = 'inside';
                state.worldName = result.worldName || '';
                state.lastTimeLine = result.timeLine || '';
                state.takeover = !isVisitor() && route === 'takeover';
                state.actorName = profile.name;
                state.events = [];
                state.observation = null;
                state.pending = null;
                state.unitWorldSeconds = null;
                control = { synced: !!result.control, paused: !!(result.control && result.control.paused), busy: !!(result.control && result.control.busy) };
                log('system', state.takeover ? control.busy ? '自主生成已暂停，正在等待此前已提交的操作返回回执。' : '已接管常驻角色，自主生成暂停。' : '入场已受理，正在等待世界中的第一份观测。');
                changed();
                if (!destroyed)
                    connect();
            }).catch(fail).finally(function () { busy = false; redraw(); });
        }
        function observe() {
            if (observeBusy || !state.token)
                return;
            observeBusy = true;
            errorText = '';
            redraw();
            var id = 'observe_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7), requestToken = state.token;
            api('POST', '/api/player/task', { token: requestToken, taskId: id, kind: 'observe', payload: {} }).catch(function (error) { if (state.token !== requestToken)
                return; observeBusy = false; fail(error); });
        }
        function submit() {
            var description = formDraft.description.trim(), speech = formDraft.speech.trim(), duration = Number(formDraft.duration);
            if (!description) {
                errorText = '请写下想做的动作；想说的话可以单独填写。';
                redraw();
                return;
            }
            if (!Number.isFinite(duration) || duration < 0) {
                errorText = '时长需要是大于或等于 0 的世界秒。';
                redraw();
                return;
            }
            if (state.pending)
                return;
            if (state.takeover && (!control.synced || !control.paused || control.busy)) {
                errorText = '请等待控制状态同步、已有操作完成后再提交。';
                refreshControl();
                redraw();
                return;
            }
            if (state.takeover && !state.unitWorldSeconds) {
                errorText = '正在同步世界的时间单位，请连接成功后再提交。';
                redraw();
                return;
            }
            var args = { description: description }, payload = { desc: description, durationWorldSeconds: duration };
            if (speech) {
                args.speech = speech;
                payload.speech = speech;
            }
            if (selectedTarget) {
                args.target = selectedTarget;
                payload.target = selectedTarget;
            }
            if (state.observation) {
                args.observationId = state.observation.observationId;
                payload.observationId = state.observation.observationId;
            }
            var id = 'action_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
            var pending = { id: id, description: description, startedAt: Date.now(), status: 'submitting', takeover: state.takeover };
            var requestToken = state.token, body = { token: requestToken, taskId: id, kind: 'act', payload: payload };
            if (!state.takeover)
                pending.body = body;
            state.pending = pending;
            errorText = '';
            log('intent', description, { speech: speech, duration: duration });
            changed();
            redraw();
            var request = state.takeover ? api('POST', '/api/player/tool', { name: 'act', arguments: args, duration: duration / state.unitWorldSeconds }) : api('POST', '/api/player/task', body);
            request.then(function (result) {
                if (state.token !== requestToken)
                    return;
                if (pending.takeover) {
                    absorb(result.text, result.ok ? 'result' : 'failure');
                    if (state.pending === pending)
                        state.pending = null;
                    refreshControl();
                }
                else if (state.pending === pending)
                    pending.status = 'accepted';
                formDraft.description = '';
                formDraft.speech = '';
                changed();
                redraw();
            }).catch(function (error) {
                if (state.token !== requestToken)
                    return;
                if (state.pending === pending)
                    pending.status = 'unknown';
                log('system', '未收到请求回执。请重新观察确认结果；不会自动重发动作。');
                changed();
                fail(error);
            });
        }
        function cancel() {
            var pending = state.pending;
            if (!pending || pending.takeover || pending.status === 'cancelling')
                return;
            var requestToken = state.token;
            pending.status = 'cancelling';
            changed();
            redraw();
            api('POST', '/api/player/cancel', { token: state.token, taskId: pending.id }).then(function (result) {
                if (state.token !== requestToken)
                    return;
                if (result.result) {
                    absorb(result.result.content, result.result.ok ? 'result' : 'failure');
                    if (state.pending === pending)
                        state.pending = null;
                }
                else
                    log('system', '已请求取消，等待最终回执。已经提交的世界变化会保留。');
                changed();
                redraw();
            }).catch(function (error) { if (state.token !== requestToken)
                return; if (state.pending === pending)
                pending.status = 'unknown'; changed(); fail(error); });
        }
        function retryPending() {
            var pending = state.pending, requestToken = state.token;
            if (!pending || !pending.body || pending.status !== 'unknown')
                return;
            pending.status = 'submitting';
            changed();
            redraw();
            api('POST', '/api/player/task', pending.body).then(function () { if (state.token !== requestToken || state.pending !== pending)
                return; pending.status = 'accepted'; changed(); redraw(); })
                .catch(function (error) { if (state.token !== requestToken || state.pending !== pending)
                return; pending.status = 'unknown'; changed(); fail(error); });
        }
        function leave() {
            if (busy)
                return;
            busy = true;
            errorText = '';
            redraw();
            var requestToken = state.token;
            api('POST', '/api/player/leave', { token: requestToken }).then(function () {
                if (state.token !== requestToken)
                    return;
                closeStream();
                state.token = '';
                state.phase = 'outside';
                state.takeover = false;
                state.pending = null;
                state.observation = null;
                state.connection = 'disconnected';
                log('system', '离场请求已处理。');
                changed();
            }).catch(fail).finally(function () { busy = false; redraw(); });
        }
        function profileEditor() {
            var name = el('input', { cls: 'journey-input', value: profile.name, maxlength: '32', autocomplete: 'off', placeholder: '角色的名字', disabled: route === 'takeover', oninput: function () { profile.name = name.value; updatePreview(); } });
            if (route === 'takeover')
                name.value = resident;
            var persona = el('textarea', { cls: 'journey-input journey-persona', maxlength: '6000', placeholder: '写下身份、说话习惯，以及你希望保留的性格。', oninput: function () { profile.persona = persona.value; updatePreview(); } });
            persona.value = route === 'takeover' ? residentDefinition : profile.persona;
            persona.readOnly = route === 'takeover';
            var choice = el('div', { cls: 'journey-routes' });
            choice.appendChild(button('作为独立角色入场', function () { route = 'cross'; redraw(); }, route === 'cross' ? 'journey-route active' : 'journey-route'));
            if (!isVisitor())
                choice.appendChild(button('接管常驻角色', function () { route = 'takeover'; redraw(); }, route === 'takeover' ? 'journey-route active' : 'journey-route'));
            var action = button(busy ? '正在建立连接…' : route === 'takeover' ? '接管 ' + (resident || '常驻角色') : '以这个角色入场', arrive, 'journey-primary');
            action.disabled = busy || (route === 'takeover' && !resident);
            return el('section', { cls: 'journey-card journey-identity' }, [
                el('div', { cls: 'journey-section-kicker', text: '01 / 角色身份' }), el('h2', { text: '你将以谁的身份出现？' }),
                choice, field('角色名', name), field(route === 'takeover' ? '常驻角色定义' : '角色设定', persona, route === 'takeover' ? '沿用创作者的角色定义；如需修改，请前往世界设定。' : '这是你维护的身份。世界观测不会替换这里的文字。'),
                note(route === 'takeover' ? '使用常驻角色的身份与身体；入场后暂停其自主生成，离场时恢复。' : '在世界中创建一位独立访客。你的每个动作都由世界根据实际条件裁定。'),
                errorText ? el('div', { cls: 'journey-error', role: 'alert', text: errorText }) : null,
                action, note('入场前可以修改；到达后的观测会告诉你身处何处。')
            ]);
        }
        function updatePreview() {
            var title = main.querySelector('[data-journey-preview-name]'), desc = main.querySelector('[data-journey-preview-persona]');
            if (title)
                title.textContent = route === 'takeover' ? resident || '常驻角色' : profile.name || '尚未命名的角色';
            if (desc)
                desc.textContent = (route === 'takeover' ? residentDefinition : profile.persona) || '你的设定会出现在这里。写下角色的轮廓，然后让故事从实际经历开始。';
        }
        function outside() {
            main.appendChild(el('div', { cls: 'journey-steps' }, ['身份', '入场', '观测与行动'].map(function (label, index) { return el('div', { cls: index === 0 ? 'active' : '' }, [el('span', { text: '0' + (index + 1) }), el('strong', { text: label })]); })));
            main.appendChild(el('div', { cls: 'journey-entry-grid' }, [profileEditor(), el('aside', { cls: 'journey-preview' }, [
                    portal(), el('div', { cls: 'journey-section-kicker', text: '角色卡 / PREVIEW' }),
                    el('h2', { 'data-journey-preview-name': '', text: route === 'takeover' ? resident || '常驻角色' : profile.name || '尚未命名的角色' }),
                    el('p', { cls: 'journey-preview-persona', 'data-journey-preview-persona': '', text: (route === 'takeover' ? residentDefinition : profile.persona) || '你的设定会出现在这里。写下角色的轮廓，然后让故事从实际经历开始。' }),
                    el('div', { cls: 'journey-preview-footer' }, [el('span', { text: route === 'takeover' ? '常驻角色 · 手动接管' : '独立角色 · 自主决定' }), el('span', { text: '等待入场' })])
                ])]));
        }
        function entityCard(entity) {
            var attrs = Object.entries(entity.attributes || {});
            var card = el('article', { cls: 'journey-entity' + (entity.self ? ' journey-entity-self' : '') });
            card.appendChild(el('div', { cls: 'journey-entity-top' }, [el('span', { cls: 'journey-entity-symbol', 'aria-hidden': 'true', html: icon(entity.kind === 'place' ? 'world' : entity.kind === 'actor' ? 'user' : 'box') }), el('span', { cls: 'journey-tag', text: entity.self ? '自己' : ({ place: '地点', actor: '角色', object: '物件' }[entity.kind] || '实体') })]));
            card.appendChild(el('h3', { text: entity.name }));
            var facts = el('dl', { cls: 'journey-facts' });
            attrs.slice(0, 6).forEach(function (entry) { facts.appendChild(el('div', {}, [el('dt', { text: attributeNames[entry[0]] || entry[0] }), el('dd', { text: text(entry[1]) })])); });
            if (!attrs.length)
                facts.appendChild(note('尚未观察到更多属性。'));
            card.appendChild(facts);
            if (attrs.length > 6)
                card.appendChild(el('details', { cls: 'journey-more' }, [el('summary', { text: '另 ' + (attrs.length - 6) + ' 项属性' }), el('pre', { text: JSON.stringify(entity.attributes, null, 2) })]));
            if (!entity.self)
                card.appendChild(button(selectedTarget === entity.observedId ? '已选为目标' : '选择为行动目标', function () { selectedTarget = entity.observedId; redraw(); }, 'journey-entity-select'));
            return card;
        }
        function actionPanel() {
            var description = el('textarea', { cls: 'journey-input journey-action-input', placeholder: '例如：走到窗边，把窗户推开。', oninput: function () { formDraft.description = description.value; } });
            description.value = formDraft.description;
            var speech = el('textarea', { cls: 'journey-input journey-speech-input', placeholder: '只填写角色此刻实际说出的原话。', oninput: function () { formDraft.speech = speech.value; } });
            speech.value = formDraft.speech;
            var target = el('select', { cls: 'journey-input', onchange: function () { selectedTarget = target.value; } }, [el('option', { value: '', text: '不指定目标' })]);
            ((state.observation && state.observation.entities) || []).filter(function (entity) { return !entity.self; }).forEach(function (entity) { target.appendChild(el('option', { value: entity.observedId, text: entity.name })); });
            target.value = selectedTarget;
            var duration = el('input', { cls: 'journey-input', type: 'number', min: '0', step: '1', value: formDraft.duration, oninput: function () { formDraft.duration = duration.value; } });
            var controlBlocked = state.takeover && (!control.synced || !control.paused || control.busy);
            var submitButton = button(state.pending ? '等待行动回执' : controlBlocked ? '等待角色控制权' : '提交这次行动', submit, 'journey-primary');
            submitButton.disabled = !!state.pending || state.connection !== 'connected' || busy || controlBlocked;
            var panel = el('section', { cls: 'journey-card journey-action' }, [el('div', { cls: 'journey-section-kicker', text: '03 / 下一步' }), el('h2', { text: '把意图交给世界。' }),
                field('想做什么', description), field('说出的话 · 可选', speech), el('div', { cls: 'journey-two-fields' }, [field('行动目标', target), field('预计时长 · 世界秒', duration)]),
                errorText ? el('div', { cls: 'journey-error', role: 'alert', text: errorText }) : null,
                controlBlocked ? note(!control.synced ? '正在同步控制状态；连接恢复后即可继续。' : control.busy ? '此前已提交的操作仍在进行。自主生成已暂停，等待真实回执后可继续操作。' : '控制权已在其他界面交还。请离场后重新接管角色。', 'journey-control-note') : null, submitButton,
                note('提交代表尝试。动作是否完成，以世界返回的实际观测为准。')]);
            if (state.pending) {
                var pending = state.pending, labels = { submitting: '正在提交', accepted: '世界正在裁定', cancelling: '正在等待取消回执', unknown: '请求结果尚未确认' };
                var pendingBox = el('div', { cls: 'journey-pending', role: 'status', 'aria-live': 'polite' }, [el('span', { cls: 'journey-pulse' }), el('strong', { text: labels[pending.status] || '等待回执' }), note(pending.description)]);
                if (!pending.takeover) {
                    var cancelButton = button(pending.status === 'cancelling' ? '取消请求已发送' : '请求取消', cancel, 'journey-subtle');
                    cancelButton.disabled = pending.status === 'cancelling';
                    pendingBox.appendChild(cancelButton);
                }
                else
                    pendingBox.appendChild(note('常驻角色的动作已提交，等待真实回执。离场将归还控制权。'));
                if (!pending.takeover && pending.status === 'unknown') {
                    pendingBox.appendChild(button('以原编号重试', retryPending, 'journey-subtle'));
                    pendingBox.appendChild(note('如果先前未送达，重试会执行这次动作；已经提交时会返回原回执。'));
                }
                if (pending.takeover && pending.status === 'unknown')
                    pendingBox.appendChild(button('恢复输入，结果留待核对', function () { state.pending = null; changed(); redraw(); }, 'journey-subtle'));
                panel.appendChild(pendingBox);
            }
            return panel;
        }
        function feed() {
            var rows = el('div', { cls: 'journey-feed' });
            state.events.slice(-20).reverse().forEach(function (event) {
                var labels = { intent: '你的意图', observation: '世界观测', speech: event.speaker || '听到的声音', result: '行动回执', failure: '未完成', system: '会话', world: '世界' };
                rows.appendChild(el('article', { cls: 'journey-feed-row journey-feed-' + event.kind }, [
                    el('div', { cls: 'journey-feed-meta' }, [el('strong', { text: labels[event.kind] || '世界' }), el('time', { text: time(event.ts), title: new Date(event.ts).toLocaleString() })]),
                    el('p', { text: event.content }), event.speech ? el('blockquote', { text: event.speech }) : null,
                    event.sourceEventIds && event.sourceEventIds.length ? el('details', { cls: 'journey-provenance' }, [el('summary', { text: event.sourceEventIds.length + ' 个原始来源' }), el('code', { text: event.sourceEventIds.join('\n') })]) : null
                ]));
            });
            if (!state.events.length)
                rows.appendChild(note('还没有收到事件。主动观察，或提交你的第一步。'));
            return el('section', { cls: 'journey-card journey-history' }, [el('div', { cls: 'journey-section-kicker', text: '经历 / RECENT' }), el('h2', { text: '刚刚发生的事' }), rows]);
        }
        function inside() {
            var names = { connected: '已连接', connecting: '正在连接', reconnecting: '连接中断，正在重连', disconnected: '尚未连接' };
            var reconnect = button('重新连接', connect, 'journey-subtle'), leaveButton = button(busy ? '正在离场…' : state.takeover ? '归还控制并离场' : '离开世界', leave, 'journey-subtle');
            leaveButton.disabled = busy;
            main.appendChild(el('div', { cls: 'journey-session-bar' }, [el('div', {}, [el('strong', { text: state.actorName || profile.name }), el('span', { cls: 'journey-tag', text: state.takeover ? '接管中' : '独立访客' }), note(state.worldName + (state.lastTimeLine ? ' · ' + state.lastTimeLine : ''))]), el('div', { cls: 'journey-session-controls' }, [el('span', { cls: 'journey-connection ' + state.connection, text: names[state.connection] }), state.connection !== 'connected' ? reconnect : null, leaveButton])]));
            var observations = el('section', { cls: 'journey-observations' }), observeButton = button(observeBusy ? '正在观察…' : '重新观察', observe, 'journey-subtle');
            observeButton.disabled = observeBusy || state.connection !== 'connected';
            observations.appendChild(el('div', { cls: 'journey-observation-head' }, [el('div', {}, [el('div', { cls: 'journey-section-kicker', text: '02 / 眼前的世界' }), el('h2', { text: observerLabel || '等待第一份观测' })]), observeButton]));
            if (state.observation) {
                var entities = el('div', { cls: 'journey-entities' });
                state.observation.entities.forEach(function (entity) { entities.appendChild(entityCard(entity)); });
                observations.appendChild(entities);
                observations.appendChild(note('这里只呈现角色实际获得的观测。目标选择会随新观测更新。'));
            }
            else
                observations.appendChild(el('div', { cls: 'journey-waiting-scene' }, [portal(), el('h3', { text: '先看看自己身处何处。' }), note('世界还没有送来观测；连接完成后，可以主动观察。')]));
            main.appendChild(el('div', { cls: 'journey-live-grid' }, [el('div', {}, [observations, feed()]), actionPanel()]));
        }
        function render() {
            main.textContent = '';
            main.appendChild(el('header', { cls: 'studio-page-head journey-page-head' }, [el('div', {}, [el('div', { cls: 'studio-eyebrow', text: 'WORLD / PARTICIPATE' }), el('h1', { cls: 'studio-title', text: state.phase === 'inside' ? '世界里的此刻' : '走进世界，成为故事的一部分。' }), el('p', { cls: 'studio-description', text: state.phase === 'inside' ? '从眼前的观测出发，为角色决定下一步。' : '设定角色，带着自己的意图入场。每一次相遇，都从真实发生的事情开始。' })])]));
            if (state.phase === 'inside' && state.token)
                inside();
            else
                outside();
        }
        function onSessionChange(event) { if (event.detail === key)
            redraw(); }
        window.addEventListener('studio:journey', onSessionChange);
        window.addEventListener('studio:refresh', refreshControl);
        controlTimer = setInterval(refreshControl, 5000);
        render();
        Promise.allSettled([
            api('GET', '/api/player/profile').then(function (result) { if (isVisitor())
                profile = Object.assign({ name: '', persona: '' }, result.profile || {});
            else {
                try {
                    profile = JSON.parse(localStorage.getItem('wui_admin_player_profile') || 'null') || profile;
                }
                catch (_) { }
            } }),
            api('GET', '/api/state').then(function (result) { resident = result.meta && result.meta.botName || result.botName || ''; residentDefinition = result.botDef || ''; })
        ]).then(function (results) {
            if (destroyed)
                return;
            if (results[0].status === 'rejected')
                errorText = results[0].reason.message || String(results[0].reason);
            if (state.pending && state.pending.takeover)
                state.pending.status = 'unknown';
            if (state.token && state.phase === 'inside')
                connect();
            else
                redraw();
        });
        return function () { destroyed = true; closeStream(); clearInterval(controlTimer); window.removeEventListener('studio:journey', onSessionChange); window.removeEventListener('studio:refresh', refreshControl); persist(key, state); };
    });
})();
