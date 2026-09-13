(function () {
    'use strict';
    var sessions = Object.create(null), connections = Object.create(null);
    // A journey belongs to this browser session, not to the route currently visible.
    window.addEventListener('studio:auth', function () {
        Object.keys(connections).forEach(function (key) {
            if (key !== scope()) { connections[key].close(); delete connections[key]; if (sessions[key]) sessions[key].connection = 'disconnected'; }
        });
    });
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
        return sessions[key] = Object.assign({ token: '', worldName: '', phase: 'outside', takeover: false, mode: 'cross', events: [], observation: null, pending: null, unitWorldSeconds: null, lastTimeLine: '' }, saved, { connection: 'disconnected' });
    }
    function persist(key, session) { try {
        sessionStorage.setItem('studio.journey.' + key, JSON.stringify(session));
    }
    catch (_) { } }
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
        var key = scope(), state = getSession(key), destroyed = false, stream = null, busy = false, observeBusy = false, selectedTarget = state.selectedTarget || '';
        var profile = { name: '', persona: '' }, resident = '', residentDefinition = '', errorText = '', route = state.takeover ? 'takeover' : 'cross', takeoverMode = state.mode === 'puppet' ? 'puppet' : 'avatar', cockpitDraft = state.cockpitDraft || (state.cockpitDraft = {}), cockpit = { tools: [], pending: [] }, formDraft = state.actionDraft || (state.actionDraft = { description: '', speech: '', duration: '0' });
        var worldRunning = lastOverview && typeof lastOverview.worldRunning === 'boolean' ? lastOverview.worldRunning : null;
        var main = el('div', { cls: 'journey-page' }), readableStates = new WeakMap(), shellKey = '', shell = null, liveCleanup = null, dockObserver = null, deviceSession = null, deviceRefreshing = false, profileEdited = false, pickerChoices = {}, pickerFlights = {}, lastViewportHeight = 0;
        function readState(record, key) { var group = readableStates.get(record); if (!group) { group = Object.create(null); readableStates.set(record, group); } return group[key] || (group[key] = {}); }
        container.appendChild(main);
        var observerLabel = '', connectTimer = null, controlTimer = null, controlRefreshing = false, control = { synced: false, paused: false, busy: false };
        var allowed = !isVisitor() || visitorCanSee(['__player__']);
        if (!allowed) {
            main.appendChild(note('此账号没有玩家入口权限。'));
            return function () { };
        }
        function changed() { persist(key, state); window.dispatchEvent(new CustomEvent('studio:journey', { detail: key })); }
        function saveDrafts() { state.selectedTarget = selectedTarget; persist(key, state); }
        function redraw() { if (!destroyed) render(); }
        function resizeDock() {
            if (!shell || !shell.dock || !shell.dock.isConnected) return;
            var viewport = window.visualViewport, box = container.getBoundingClientRect(), width = viewport ? viewport.width : innerWidth, offset = viewport ? viewport.offsetLeft : 0;
            var left = Math.max(box.left + 12, offset + 10), right = Math.min(box.right - 12, offset + width - 10), dockWidth = Math.max(0, Math.min(960, right - left));
            shell.dock.style.left = (left + Math.max(0, (right - left - dockWidth) / 2)) + 'px';
            shell.dock.style.width = dockWidth + 'px';
            var height = viewport ? viewport.height : innerHeight, gap = viewport ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0;
            var editor = document.activeElement, editing = !!editor && shell.dock.contains(editor) && /^(INPUT|TEXTAREA|SELECT)$/.test(editor.tagName), keyboard = gap > 80 || editing && height < 500;
            shell.dock.classList.toggle('journey-keyboard', keyboard && !shell.collapsed);
            shell.dock.style.bottom = gap > 80 ? (gap + 8) + 'px' : 'calc(var(--mobile-nav-height, 0px) + 12px)';
            var topbar = document.getElementById('topbar'), header = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom - (viewport ? viewport.offsetTop : 0)) : 0;
            var nav = document.getElementById('mobile-nav'), bottom = gap > 80 ? 8 : (nav ? nav.getBoundingClientRect().height : 0) + 12, available = Math.max(0, height - Math.min(header, 70) - bottom);
            // Leave a usable reading strip even on landscape phones or above an
            // on-screen keyboard. The controller itself can scroll or collapse.
            var reading = Math.min(150, Math.max(64, available * .36));
            shell.dock.style.maxHeight = Math.max(48, Math.min(height * .65, available - reading)) + 'px';
            if (lastViewportHeight !== height && editing) revealEditor();
            lastViewportHeight = height;
            main.style.setProperty('--journey-dock-space', (shell.dock.getBoundingClientRect().height + 32) + 'px');
        }
        function revealEditor() {
            if (!shell || !shell.dock) return;
            var input = document.activeElement;
            if (!input || !shell.dock.contains(input) || !/^(INPUT|TEXTAREA|SELECT)$/.test(input.tagName)) return;
            var box = shell.dock.getBoundingClientRect(), field = input.getBoundingClientRect();
            if (field.bottom > box.bottom - 6) shell.dock.scrollTop += field.bottom - box.bottom + 6;
            if (field.top < box.top + 6) shell.dock.scrollTop -= box.top + 6 - field.top;
        }
        function refreshDevices() {
            if (destroyed || isVisitor() || !state.takeover || !state.token || deviceRefreshing) return;
            deviceRefreshing = true; var token = state.token;
            api('GET', '/api/device/session').then(function (result) { if (!destroyed && token === state.token) { deviceSession = result; redraw(); } }).catch(function () {}).finally(function () { deviceRefreshing = false; });
        }
        function prepareTool(tool, force) {
            if (!state.takeover || !state.token || isVisitor()) return;
            var needsMedia = /^(view_media|pick_media|send|gallery_(save|move|remove))$/.test(tool.name), needsNotes = /^(view_note|edit_note|delete_note)$/.test(tool.name);
            var jobs = [], token = state.token;
            function load(key, path, apply) { if (pickerFlights[key] || pickerChoices[key] && !force) return; pickerFlights[key] = true; jobs.push(api('GET', path).then(function (result) { if (!destroyed && token === state.token) apply(result); }).catch(function (error) { if (!destroyed && token === state.token) errorText = '读取可选内容失败：' + error.message; }).finally(function () { pickerFlights[key] = false; })); }
            if (needsMedia) {
                load('mediaCache', '/api/media', function (result) { pickerChoices.mediaCache = (result.rows || result.items || []).map(function (m) { return { value: 'media:' + m.id, text: ({ image: '图片', audio: '音频', video: '视频' }[m.type] || '媒体') + ' · ' + (m.summary || '尚无摘要'), preview: m.type === 'image' ? '/api/media/file?id=' + encodeURIComponent(m.id) : null }; }); });
                load('galleryMedia', '/api/gallery', function (result) { pickerChoices.galleryMedia = (result.entries || []).map(function (m) { return { value: 'gallery:' + m.category + '/' + m.name, text: m.name + (m.description ? ' · ' + m.description : ''), preview: '/api/gallery/file?category=' + encodeURIComponent(m.category) + '&name=' + encodeURIComponent(m.name) }; }); });
            }
            if (needsNotes) load('noteTitles', '/api/notes', function (result) { pickerChoices.noteTitles = (result.notes || []).map(function (note) { return { value: note.title, text: note.title }; }); });
            if (jobs.length) Promise.allSettled(jobs).then(function () { if (!destroyed && token === state.token) redraw(); });
        }
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
            else if (!state.events.some(function (event) { return event.content === content && Date.now() - event.ts < 2500; }))
                log(kind || 'world', content);
        }
        function toolResult(result) {
            absorb(result.text || (result.content && result.content.text), result.ok ? 'result' : 'failure');
            var attachments = result.content && result.content.attachments;
            if (attachments && attachments.length) log(result.ok ? 'result' : 'failure', '工具返回的媒体', { attachments: attachments });
        }
        function media(ref) {
            var source = ref.id != null ? '/api/media/file?id=' + encodeURIComponent(ref.id) : ref.url;
            if (!source) return null;
            try {
                var url = new URL(source, location.href);
                if (!['http:', 'https:'].includes(url.protocol)) return null;
                source = url.origin === location.origin ? withToken(source) : url.href;
            } catch (_) { return null; }
            if (ref.type === 'image') return el('a', { href: source, target: '_blank', rel: 'noopener noreferrer', cls: 'cockpit-result-media' }, [el('img', { src: source, alt: '角色工具返回的图像', loading: 'lazy' })]);
            return el('a', { href: source, target: '_blank', rel: 'noopener noreferrer', text: ref.type === 'audio' ? '打开返回的音频' : '打开返回的附件' });
        }
        function closeStream() {
            if (connections[key]) { connections[key].close(); delete connections[key]; }
            if (stream) stream.close();
            stream = null; clearTimeout(connectTimer);
        }
        function refreshControl() {
            if (destroyed || isVisitor() || !state.takeover || !state.token || controlRefreshing)
                return;
            controlRefreshing = true;
            refreshDevices();
            var requestToken = state.token;
            api('GET', '/api/player/cockpit?ctoken=' + encodeURIComponent(requestToken)).then(function (result) {
                if (destroyed || requestToken !== state.token)
                    return;
                var nextCockpit = { tools: result.tools || [], pending: result.pending || [], choices: result.choices || {} };
                var catalogChanged = JSON.stringify(nextCockpit) !== JSON.stringify(cockpit);
                cockpit = nextCockpit;
                if (result.mode) state.mode = result.mode;
                if (result.time && result.time.unitWorldSeconds > 0) state.unitWorldSeconds = result.time.unitWorldSeconds;
                var next = { synced: true, paused: !!(result.control && result.control.paused), busy: !!(result.control && result.control.busy) };
                if (catalogChanged || JSON.stringify(next) !== JSON.stringify(control)) {
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
            connections[key] = stream;
            var capturedStream = stream;
            stream.onopen = function () { if (capturedToken !== state.token)
                return; state.connection = 'connected'; errorText = ''; redraw(); };
            stream.onerror = function () { if (connections[key] !== capturedStream || capturedToken !== state.token)
                return; state.connection = 'reconnecting'; if (state.pending && state.pending.status !== 'cancelling')
                state.pending.status = 'unknown'; changed(); redraw(); };
            stream.onmessage = function (event) {
                if (connections[key] !== capturedStream || capturedToken !== state.token)
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
            if (busy || worldRunning === false)
                return;
            busy = true;
            errorText = '';
            redraw();
            saveProfile().then(function () {
                return api('POST', '/api/player/arrive', isVisitor() ? { mode: 'cross' } : { name: profile.name, persona: profile.persona, mode: route === 'takeover' ? takeoverMode : 'cross' });
            }).then(function (result) {
                if (!result.token)
                    throw new Error(result.error || '入场尚未建立会话。');
                state.token = result.token;
                state.phase = 'inside';
                state.worldName = result.worldName || '';
                state.lastTimeLine = result.timeLine || '';
                state.takeover = !isVisitor() && route === 'takeover';
                state.mode = state.takeover ? takeoverMode : 'cross';
                state.actorName = profile.name;
                state.events = [];
                cockpitDraft = state.cockpitDraft = {};
                formDraft = state.actionDraft = { description: '', speech: '', duration: '0', revision: 0 };
                selectedTarget = state.selectedTarget = '';
                state.operatorCollapsed = false;
                state.observation = null;
                state.pending = null;
                state.unitWorldSeconds = null;
                control = { synced: !!result.control, paused: !!(result.control && result.control.paused), busy: !!(result.control && result.control.busy) };
                log('system', state.takeover ? state.mode === 'puppet' ? '已接管身体；Bot 仍有自己的意识，会感知非自主的身体行动。' : control.busy ? '自主生成已暂停，正在等待此前已提交的操作返回回执。' : '已完全入替，期间的意图和经历将由角色自然继承。' : '入场已受理，正在等待世界中的第一份观测。');
                changed();
                if (!destroyed && !connections[key])
                    connect();
            }).catch(fail).finally(function () { busy = false; redraw(); });
        }
        function observe() {
            if (observeBusy || !state.token)
                return;
            if (state.takeover) { callTool('observe', {}, 0); return; }
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
            if (state.takeover && (!control.synced || state.mode !== 'puppet' && !control.paused || control.busy)) {
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
            var draftRevision = formDraft.revision = (formDraft.revision || 0) + 1;
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
            var request = state.takeover ? api('POST', '/api/player/tool', { token: requestToken, name: 'act', arguments: args, duration: duration / state.unitWorldSeconds }) : api('POST', '/api/player/task', body);
            request.then(function (result) {
                if (state.token !== requestToken)
                    return;
                if (pending.takeover) {
                    toolResult(result);
                    if (state.pending === pending)
                        state.pending = null;
                    refreshControl();
                }
                else if (state.pending === pending)
                    pending.status = 'accepted';
                if (formDraft.revision === draftRevision) {
                    if (formDraft.description.trim() === description) formDraft.description = '';
                    if (formDraft.speech.trim() === speech) formDraft.speech = '';
                }
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
                state.mode = 'cross';
                cockpit = { tools: [], pending: [] };
                state.pending = null;
                state.observation = null;
                state.connection = 'disconnected';
                log('system', '离场请求已处理。');
                changed();
            }).catch(fail).finally(function () { busy = false; redraw(); });
        }
        function modePicker() {
            var modes = el('div', { cls: 'journey-takeover-modes', role: 'group', 'aria-label': '角色接管模式' });
            [['puppet', '仅操纵身体', 'Bot 保留自己的意识，会体验到身体不由自主地行动。你决定身体和设备的操作。'], ['avatar', '完全入替 Bot', '由你代替角色的意识，自主生成暂停。离场后，角色把这些意图与经历当成自己的。']].forEach(function (mode) {
                var choice = button('', function () { takeoverMode = mode[0]; redraw(); }, 'journey-takeover-mode');
                choice.dataset.takeoverMode = mode[0]; choice.setAttribute('aria-pressed', String(takeoverMode === mode[0]));
                choice.append(el('strong', { text: mode[1] }), el('span', { text: mode[2] })); modes.appendChild(choice);
            });
            return modes;
        }
        function callTool(name, args, duration, confirmSend) {
            if (!state.takeover || !state.token || state.pending || !control.synced || control.busy || state.mode !== 'puppet' && !control.paused || !cockpit.tools.some(function (tool) { return tool.name === name; })) return;
            var token = state.token, pending = { id: 'tool_' + Date.now().toString(36), takeover: true, description: name, status: 'submitting', startedAt: Date.now() };
            state.pending = pending; errorText = '';
            var intention = args.description || args.msg || args.text || args.statement;
            log('intent', WorldCockpit.label({ name: name }) + (typeof intention === 'string' ? ' · ' + intention : ''), { tool: name, arguments: args }); changed(); redraw();
            api('POST', '/api/player/tool', { token: token, name: name, arguments: args, duration: duration, confirmSend: !!confirmSend }).then(function (result) {
                if (token !== state.token) return;
                toolResult(result);
                if (state.pending === pending) state.pending = null;
                changed(); refreshControl(); redraw();
            }).catch(function (error) {
                if (token !== state.token) return;
                pending.status = 'unknown';
                log('system', '请求结果未确认，不会自动重发。请查看执行中的工具或重新观察。');
                changed(); refreshControl(); fail(error);
            });
            setTimeout(refreshControl, 150);
        }
        function cancelTool(callId) {
            var token = state.token;
            api('POST', '/api/player/tool/cancel', { token: token, callId: callId }).then(function (result) {
                if (token !== state.token) return;
                log('system', result.text || '取消请求已处理；已提交的变化会保留。');
                changed(); refreshControl(); redraw();
            }).catch(fail);
        }
        function profileEditor() {
            var name = el('input', { cls: 'journey-input', value: profile.name, maxlength: '32', autocomplete: 'off', placeholder: '角色的名字', disabled: route === 'takeover', oninput: function () { profileEdited = true; profile.name = name.value; updatePreview(); } });
            if (route === 'takeover')
                name.value = resident;
            var persona = el('textarea', { cls: 'journey-input journey-persona', maxlength: '6000', placeholder: '写下身份、说话习惯，以及你希望保留的性格。', oninput: function () { profileEdited = true; profile.persona = persona.value; updatePreview(); } });
            persona.value = route === 'takeover' ? residentDefinition : profile.persona;
            persona.readOnly = route === 'takeover';
            var choice = el('div', { cls: 'journey-routes' });
            choice.appendChild(button('作为独立角色入场', function () { route = 'cross'; redraw(); }, route === 'cross' ? 'journey-route active' : 'journey-route'));
            if (!isVisitor())
                choice.appendChild(button('接管常驻角色', function () { route = 'takeover'; redraw(); }, route === 'takeover' ? 'journey-route active' : 'journey-route'));
            var action = button(busy ? '正在建立连接…' : route === 'takeover' ? '接管 ' + (resident || '常驻角色') : '以这个角色入场', arrive, 'journey-primary');
            action.disabled = busy || worldRunning === false || (route === 'takeover' && !resident);
            action.dataset.journeyArrive = '1';
            var availability = el('div', { cls: 'journey-note', 'data-journey-availability': '', role: 'status' }, [
                el('p', { text: '世界尚未运行，暂时无法进入或接管角色。你可以先准备角色设定与接管模式。' }),
                isVisitor() ? el('span', { text: '请联系管理员先启动世界。' }) : el('a', { href: '#overview', text: '前往总览启动世界' })
            ]);
            availability.hidden = worldRunning !== false;
            return el('section', { cls: 'journey-card journey-identity' }, [
                el('div', { cls: 'journey-section-kicker', text: '01 / 角色身份' }), el('h2', { text: '你将以谁的身份出现？' }),
                choice, field('角色名', name), field(route === 'takeover' ? '常驻角色定义' : '角色设定', persona, route === 'takeover' ? '沿用创作者的角色定义；如需修改，请前往世界设定。' : '这是你维护的身份。世界观测不会替换这里的文字。'),
                route === 'takeover' ? modePicker() : note('在世界中创建一位独立访客。你的每个动作都由世界根据实际条件裁定。'),
                availability,
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
            attrs.slice(0, 6).forEach(function (entry) { facts.appendChild(el('div', {}, [el('dt', { text: attributeNames[entry[0]] || entry[0], title: entry[0] }), el('dd', {}, [ReadableData.render(entry[1], { compact: true, state: readState(entity, entry[0]) })])])); });
            if (!attrs.length)
                facts.appendChild(note('尚未观察到更多属性。'));
            card.appendChild(facts);
            if (attrs.length > 6)
                card.appendChild(el('details', { cls: 'journey-more' }, [el('summary', { text: '另 ' + (attrs.length - 6) + ' 项属性' }), ReadableData.render(Object.fromEntries(attrs.slice(6)), { compact: true, state: readState(entity, ':more') })]));
            card.appendChild(ReadableData.raw(entity, { label: '观测依据与原始属性', state: readState(entity, ':raw') }));
            if (!entity.self)
                card.appendChild(button(selectedTarget === entity.observedId ? '已选为目标' : '选择为行动目标', function () { selectedTarget = entity.observedId; if (shell && shell.controller && shell.controller.setTarget) shell.controller.setTarget(selectedTarget); redraw(); }, 'journey-entity-select'));
            return card;
        }
        function actionPanel() {
            function edited() { formDraft.revision = (formDraft.revision || 0) + 1; }
            var description = el('textarea', { cls: 'journey-input journey-action-input', rows: '2', 'data-cockpit-field': 'action:description', 'aria-label': '想做什么', placeholder: '想做什么？例如走到窗边，把窗户推开。', oninput: function () { formDraft.description = description.value; edited(); } });
            var speech = el('textarea', { cls: 'journey-input journey-speech-input', rows: '2', 'data-cockpit-field': 'action:speech', placeholder: '角色实际说出的原话', oninput: function () { formDraft.speech = speech.value; edited(); } });
            var target = el('select', { cls: 'journey-input', 'aria-label': '行动目标', onchange: function () { selectedTarget = state.selectedTarget = target.value; edited(); } });
            var duration = el('input', { cls: 'journey-input', type: 'number', min: '0', step: 'any', value: formDraft.duration, 'aria-label': '预计时长（世界秒）', oninput: function () { formDraft.duration = duration.value; edited(); } });
            var options = el('details', { cls: 'cockpit-options' }, [el('summary', { text: '说话与选项' }), field('说出的话 · 可选', speech), el('div', { cls: 'journey-two-fields' }, [field('行动目标', target), field('预计时长 · 世界秒', duration)]), note('目标来自最近一次实际观测；动作是否完成，以世界回执为准。')]);
            options.ontoggle = resizeDock;
            var error = el('div', { cls: 'journey-error', role: 'alert', hidden: true }), submitButton = el('button', { type: 'submit', cls: 'journey-button journey-primary', text: '提交这次行动' }), queue = el('div', { cls: 'journey-pending-host' });
            var form = el('form', { cls: 'journey-action' }, [el('div', { cls: 'cockpit-bar' }, [el('strong', { text: '你的下一步' }), el('span', { cls: 'cockpit-count', text: '身体行动' })]), description, options, error, submitButton, queue]);
            form.onsubmit = function (event) { event.preventDefault(); if (!submitButton.disabled) submit(); };
            var observedStamp = '', pendingStamp = '';
            form.update = function () {
                // These are the original DOM nodes throughout the session, including
                // IME composition, SSE receipts and reconnection. Never re-focus them.
                if (description.value !== formDraft.description) description.value = formDraft.description;
                if (speech.value !== formDraft.speech) speech.value = formDraft.speech;
                var entities = ((state.observation && state.observation.entities) || []).filter(function (entity) { return !entity.self; }), stamp = JSON.stringify(entities.map(function (e) { return [e.observedId, e.name]; }));
                if (observedStamp !== stamp) { observedStamp = stamp; target.replaceChildren(el('option', { value: '', text: '不指定目标' })); entities.forEach(function (entity) { target.appendChild(el('option', { value: entity.observedId, text: entity.name })); }); }
                target.value = selectedTarget;
                error.hidden = !errorText; error.textContent = errorText;
                submitButton.disabled = !!state.pending || state.connection !== 'connected' || busy;
                submitButton.textContent = state.pending ? '等待行动回执' : '提交这次行动';
                var next = JSON.stringify(state.pending); if (next === pendingStamp) return; pendingStamp = next; queue.replaceChildren();
                if (state.pending) {
                    var pending = state.pending, labels = { submitting: '正在提交', accepted: '世界正在裁定', cancelling: '正在等待取消回执', unknown: '请求结果尚未确认' };
                    var box = el('div', { cls: 'journey-pending', role: 'status' }, [el('span', { cls: 'journey-pulse' }), el('strong', { text: labels[pending.status] || '等待回执' }), note(pending.description)]);
                    var cancelButton = button(pending.status === 'cancelling' ? '取消请求已发送' : '请求取消', cancel, 'journey-subtle'); cancelButton.disabled = pending.status === 'cancelling'; box.appendChild(cancelButton);
                    if (pending.status === 'unknown') box.append(button('以原编号重试', retryPending, 'journey-subtle'), note('保持同一请求编号；已经提交时只返回原回执。'));
                    queue.appendChild(box);
                }
            };
            form.update(); return form;
        }
        function eventBody(event) {
            var value = event.content, lead = '', tail = '';
            try { for (var i = 0; i < 3 && typeof value === 'string' && /^[\s]*[\[{"]/.test(value); i++) value = JSON.parse(value); } catch (_) {}
            if (typeof value === 'string') {
                var fence = value.match(/^([\s\S]*?)```(?:json)?\s*\n([\s\S]*?)\n```([\s\S]*)$/i);
                if (fence) try { var fenced = JSON.parse(fence[2]); if (fenced && typeof fenced === 'object') { lead = fence[1].trim(); tail = fence[3].trim(); value = fenced; } } catch (_) {}
            }
            if (typeof value === 'string') {
                var boundary = value.search(/\n\s*[\[{]/);
                if (boundary >= 0) try { var record = JSON.parse(value.slice(boundary).trim()); if (record && typeof record === 'object') { lead = value.slice(0, boundary).trim(); value = record; } } catch (_) {}
            }
            if (typeof value === 'string') return value.length <= 700 ? el('p', { cls: 'journey-event-prose', text: value }) : ReadableData.render(value, { compact: true, raw: false, textLimit: 700, state: readState(event, 'content') });
            var summary = value && (value.reason || value.message || value.text || value.description || value.action && (value.action.reason || value.action.description));
            var body = el('div', { cls: 'journey-event-result' });
            if (lead) body.appendChild(el('p', { cls: 'journey-event-prose', text: lead }));
            if (typeof summary === 'string') body.appendChild(el('p', { cls: 'journey-event-prose', text: summary }));
            body.appendChild(ReadableData.render(value, { compact: true, raw: true, state: readState(event, 'content'), textLimit: 550, openDepth: 1 }));
            if (tail) body.appendChild(el('p', { cls: 'journey-event-prose', text: tail }));
            return body;
        }
        function feed() {
            var rows = el('div', { cls: 'journey-feed' });
            state.events.slice(-60).reverse().forEach(function (event) {
                var labels = { intent: '你的意图', observation: '世界观测', speech: event.speaker || '听到的声音', result: '行动回执', failure: '未完成', system: '会话', world: '世界' };
                rows.appendChild(el('article', { cls: 'journey-feed-row journey-feed-' + event.kind }, [
                    el('div', { cls: 'journey-feed-meta' }, [el('strong', { text: labels[event.kind] || '世界' }), el('time', { text: time(event.ts), title: new Date(event.ts).toLocaleString() })]),
                    eventBody(event), event.speech ? el('blockquote', { text: event.speech }) : null,
                    event.attachments ? el('div', { cls: 'cockpit-result-attachments' }, event.attachments.map(media)) : null,
                    event.sourceEventIds && event.sourceEventIds.length ? el('details', { cls: 'journey-provenance' }, [el('summary', { text: event.sourceEventIds.length + ' 个原始来源' }), el('code', { text: event.sourceEventIds.join('\n') })]) : null
                ]));
            });
            if (!state.events.length)
                rows.appendChild(note('还没有收到事件。主动观察，或提交你的第一步。'));
            return el('section', { cls: 'journey-card journey-history' }, [el('div', { cls: 'journey-section-kicker', text: '经历 / RECENT' }), el('h2', { text: '刚刚发生的事' }), rows]);
        }
        function cockpitData() { return { tools: cockpit.tools, pending: cockpit.pending, choices: Object.assign({}, pickerChoices, cockpit.choices || {}), observation: state.observation, deviceSession: deviceSession, synced: control.synced, mode: state.mode, unitWorldSeconds: state.unitWorldSeconds, blocked: control.busy || state.mode !== 'puppet' && !control.paused, blockedReason: control.busy ? '此前操作正在完成，等待真实回执。' : '控制权已在其他界面归还，请离场后重新接管。', submitting: !!state.pending, uncertain: !!state.pending && state.pending.status === 'unknown' }; }
        function inside() {
            shell = { session: el('div', { cls: 'journey-session-host' }), observations: el('section', { cls: 'journey-observations' }), live: el('section', { cls: 'journey-live-status', 'aria-label': 'World 与 Bot 实时状态' }), history: el('div', { cls: 'journey-history-host' }), dock: el('div', { cls: 'journey-dock', 'aria-label': '悬浮操作台' }), collapsed: !!state.operatorCollapsed, sessionStamp: '', observationStamp: '', eventStamp: '' };
            var links = el('div', { cls: 'journey-session-shortcuts' });
            if (state.takeover) links.appendChild(button('操作手机与电脑 ↗', function () { Studio.navigate('devices'); }, 'journey-subtle'));
            if (!isVisitor() || visitorCanSee(['debug'])) links.appendChild(button('查看实时思考与调用 ↗', function () { Studio.navigate('live'); }, 'journey-subtle'));
            main.append(shell.session, shell.live, links, el('div', { cls: 'journey-stream-layout' }, [shell.history, shell.observations]), shell.dock);
            if (window.LiveCalls && (!isVisitor() || visitorCanSee(['debug']))) liveCleanup = LiveCalls.mount(shell.live, { compact: true });
            else shell.live.appendChild(note('连接与行动回执会实时更新；当前账号未开放模型调用内容。'));
            shell.controller = state.takeover ? WorldCockpit.mount(cockpitData(), cockpitDraft, { call: callTool, cancel: cancelTool, resize: resizeDock, prepare: prepareTool, recover: function () { state.pending = null; changed(); refreshControl(); redraw(); } }) : actionPanel();
            var fold = button(shell.collapsed ? '展开操作台' : '收起操作台 · 查看世界', function () {
                shell.collapsed = state.operatorCollapsed = !shell.collapsed;
                shell.controller.hidden = shell.collapsed;
                fold.textContent = shell.collapsed ? '展开操作台' : '收起操作台 · 查看世界'; fold.setAttribute('aria-expanded', String(!shell.collapsed));
                resizeDock(); persist(key, state);
            }, 'journey-dock-grip'); fold.setAttribute('aria-expanded', String(!shell.collapsed));
            shell.controller.hidden = shell.collapsed;
            shell.dock.append(fold, shell.controller);
            shell.dock.addEventListener('focusin', function () { resizeDock(); requestAnimationFrame(revealEditor); });
            if (window.ResizeObserver) { dockObserver = new ResizeObserver(resizeDock); dockObserver.observe(shell.dock); }
            updateInside(); requestAnimationFrame(resizeDock);
        }
        function updateInside() {
            var names = { connected: '已连接', connecting: '正在连接', reconnecting: '连接中断，正在重连', disconnected: '尚未连接' };
            var stamp = [state.actorName, state.connection, state.lastTimeLine, state.mode, busy].join('|');
            if (stamp !== shell.sessionStamp) {
                shell.sessionStamp = stamp;
                var leaveButton = button(busy ? '正在离场…' : state.takeover ? '归还控制并离场' : '离开世界', leave, 'journey-subtle'); leaveButton.disabled = busy;
                shell.session.replaceChildren(el('div', { cls: 'journey-session-bar' }, [el('div', {}, [el('strong', { text: state.actorName || profile.name }), el('span', { cls: 'journey-tag', text: state.takeover ? state.mode === 'puppet' ? '仅操纵身体 · 意识保留' : '完全入替 · 由你决定' : '独立访客' }), note(state.worldName + (state.lastTimeLine ? ' · ' + state.lastTimeLine : ''))]), el('div', { cls: 'journey-session-controls' }, [el('span', { cls: 'journey-connection ' + state.connection, text: names[state.connection] }), state.connection !== 'connected' ? button('重新连接', connect, 'journey-subtle') : null, leaveButton])]));
            }
            var observationStamp = JSON.stringify([state.observation, selectedTarget, observeBusy, state.connection, !!state.pending, control.synced, control.busy, control.paused, cockpit.tools.some(function (tool) { return tool.name === 'observe'; })]);
            if (observationStamp !== shell.observationStamp) {
                shell.observationStamp = observationStamp;
                var observeButton = button(observeBusy ? '正在观察…' : '重新观察', observe, 'journey-subtle'); observeButton.disabled = observeBusy || state.connection !== 'connected' || state.takeover && (!control.synced || !!state.pending || control.busy || state.mode !== 'puppet' && !control.paused || !cockpit.tools.some(function (tool) { return tool.name === 'observe'; }));
                shell.observations.replaceChildren(el('div', { cls: 'journey-observation-head' }, [el('div', {}, [el('div', { cls: 'journey-section-kicker', text: '眼前的世界' }), el('h2', { text: state.observation ? '点选身边的目标' : '等待第一份观测' })]), observeButton]));
                if (state.observation) { var entities = el('div', { cls: 'journey-entities' }); state.observation.entities.forEach(function (entity) { entities.appendChild(entityCard(entity)); }); shell.observations.appendChild(entities); }
                else shell.observations.appendChild(el('div', { cls: 'journey-waiting-scene' }, [el('h3', { text: '先看看自己身处何处。' }), note('连接完成后，可以主动观察。')]));
            }
            var eventStamp = JSON.stringify([state.events, errorText, state.pending && state.pending.status]);
            if (eventStamp !== shell.eventStamp) {
                shell.eventStamp = eventStamp; shell.history.replaceChildren(feed());
                if (errorText) shell.history.prepend(el('div', { cls: 'journey-error', role: 'alert', text: errorText }));
            }
            shell.controller.update(state.takeover ? cockpitData() : undefined); resizeDock();
        }
        function render() {
            var nextKey = state.phase === 'inside' && state.token ? 'inside:' + state.mode : 'outside:' + route + ':' + takeoverMode;
            if (shellKey === nextKey) {
                if (shell) updateInside();
                else {
                    updatePreview();
                    var action = main.querySelector('[data-journey-arrive]'); if (action) { action.disabled = busy || worldRunning === false || (route === 'takeover' && !resident); action.textContent = busy ? '正在建立连接…' : route === 'takeover' ? '接管 ' + (resident || '常驻角色') : '以这个角色入场'; }
                    var availability = main.querySelector('[data-journey-availability]'); if (availability) availability.hidden = worldRunning !== false;
                    main.querySelectorAll('.journey-routes button,.journey-takeover-modes button').forEach(function (node) { node.disabled = busy; });
                    main.querySelectorAll('.journey-identity input,.journey-persona').forEach(function (node) { node.disabled = busy || route === 'takeover' && node.tagName === 'INPUT'; });
                    if (!profileEdited || route === 'takeover') { var input = main.querySelector('.journey-identity input'), persona = main.querySelector('.journey-persona'); if (input && document.activeElement !== input) input.value = route === 'takeover' ? resident : profile.name; if (persona && document.activeElement !== persona) persona.value = route === 'takeover' ? residentDefinition : profile.persona; }
                    var error = main.querySelector('.journey-identity .journey-error'); if (errorText) { if (!error) { error = el('div', { cls: 'journey-error', role: 'alert' }); action.before(error); } error.textContent = errorText; } else if (error) error.remove();
                }
                return;
            }
            shellKey = nextKey;
            if (liveCleanup) { liveCleanup(); liveCleanup = null; } if (dockObserver) { dockObserver.disconnect(); dockObserver = null; } shell = null; main.style.removeProperty('--journey-dock-space'); main.replaceChildren();
            main.classList.toggle('journey-in-session', nextKey.startsWith('inside:'));
            main.appendChild(el('header', { cls: 'studio-page-head journey-page-head' }, [el('div', {}, [el('div', { cls: 'studio-eyebrow', text: 'WORLD / PARTICIPATE' }), el('h1', { cls: 'studio-title', text: state.phase === 'inside' ? state.takeover ? '角色驾驶舱' : '世界里的此刻' : '走进世界，成为故事的一部分。' }), el('p', { cls: 'studio-description', text: state.phase === 'inside' ? state.takeover && state.mode === 'puppet' ? '你操纵身体，Bot 保留意识。设备操作遵循同一种接管方式。' : state.takeover ? '由你决定意图，角色将自然继承经历。随时操作，实时看见结果。' : '带着自己的意图行动，世界的观测与回执会在这里持续更新。' : '设定角色，带着自己的意图入场。' })])]));
            if (nextKey.startsWith('inside:')) inside(); else outside();
        }
        function onSessionChange(event) { if (event.detail !== key) return; if (state.phase === 'inside' && state.token && !connections[key]) connect(); else redraw(); }
        function onOverview(event) { if (destroyed || !event.detail || typeof event.detail.worldRunning !== 'boolean' || worldRunning === event.detail.worldRunning) return; worldRunning = event.detail.worldRunning; redraw(); }
        window.addEventListener('studio:journey', onSessionChange);
        window.addEventListener('studio:overview', onOverview);
        window.addEventListener('studio:refresh', refreshControl);
        controlTimer = setInterval(refreshControl, 2000);
        window.addEventListener('resize', resizeDock);
        window.addEventListener('pagehide', saveDrafts);
        if (window.visualViewport) { visualViewport.addEventListener('resize', resizeDock); visualViewport.addEventListener('scroll', resizeDock); }
        render();
        Promise.allSettled([
            api('GET', '/api/player/profile').then(function (result) { if (isVisitor() && !profileEdited)
                profile = Object.assign({ name: '', persona: '' }, result.profile || {});
            else {
                try {
                    if (!profileEdited) profile = JSON.parse(localStorage.getItem('wui_admin_player_profile') || 'null') || profile;
                }
                catch (_) { }
            } }),
            api('GET', '/api/state').then(function (result) { resident = result.meta && result.meta.botName || result.botName || ''; residentDefinition = result.botDef || ''; }),
            refreshOverview(false)
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
        return function () { destroyed = true; state.selectedTarget = selectedTarget; if (liveCleanup) liveCleanup(); if (dockObserver) dockObserver.disconnect(); window.removeEventListener('resize', resizeDock); window.removeEventListener('pagehide', saveDrafts); if (window.visualViewport) { visualViewport.removeEventListener('resize', resizeDock); visualViewport.removeEventListener('scroll', resizeDock); } if (!state.token || state.phase !== 'inside') closeStream(); clearInterval(controlTimer); window.removeEventListener('studio:journey', onSessionChange); window.removeEventListener('studio:overview', onOverview); window.removeEventListener('studio:refresh', refreshControl); persist(key, state); };
    });
})();
