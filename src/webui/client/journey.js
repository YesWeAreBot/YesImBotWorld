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
        var key = scope(), state = getSession(key), destroyed = false, stream = null, busy = false, selectedTarget = state.selectedTarget || '';
        var profile = { name: '', persona: '' }, resident = '', residentDefinition = '', errorText = '', route = state.takeover ? 'takeover' : 'cross', takeoverMode = state.mode === 'puppet' ? 'puppet' : 'avatar', cockpitDraft = state.cockpitDraft || (state.cockpitDraft = {}), cockpit = { tools: [], pending: [] }, formDraft = state.actionDraft || (state.actionDraft = { description: '', speech: '', duration: '0' });
        // An older saved cockpit may still contain opaque targets from the retired
        // entity projection. Recover the known name before presenting its draft.
        function describeSavedTarget(value) {
            var entity = ((state.observation && state.observation.entities) || []).find(function (entry) { return entry.observedId === value; });
            return entity ? entity.name : typeof value === 'string' && /^seen:/.test(value) ? '' : value;
        }
        selectedTarget = state.selectedTarget = describeSavedTarget(selectedTarget);
        ['act', 'observe'].forEach(function (name) { var values = cockpitDraft.values && cockpitDraft.values[name]; if (values) { values.target = describeSavedTarget(values.target); delete values.observationId; } });
        var worldRunning = lastOverview && typeof lastOverview.worldRunning === 'boolean' ? lastOverview.worldRunning : null;
        state.actionAliases = state.actionAliases || {};
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
        function admissionRejected(error) { return [400, 403, 404, 409, 422, 429].includes(error.status); }
        function log(kind, content, extra) {
            var previous = extra && extra.eventId && state.events.find(function (event) { return event.eventId === extra.eventId; });
            if (previous) {
                // Replayed observations carry the same experiences. A later scene
                // revision may extend its prose, without replacing factual receipts.
                if (extra.revision != null && previous.revision != null && extra.revision < previous.revision) return previous;
                if (previous.controlNote && !extra.controlNote) { extra.controlNote = previous.controlNote; extra.raw = previous.raw; }
                Object.assign(previous, { kind: kind, content: content }, extra);
                return previous;
            }
            var entry = Object.assign({ kind: kind, content: content, ts: Date.now(), timeLine: state.lastTimeLine }, extra || {});
            state.events.push(entry);
            if (state.events.length > 240) state.events.splice(0, state.events.length - 240);
            return entry;
        }
        function linkAction(actionId, requestId) { if (actionId && requestId && actionId !== requestId) state.actionAliases[actionId] = requestId; }
        function groupId(id) { var seen = new Set(); while (id && state.actionAliases[id] && !seen.has(id)) { seen.add(id); id = state.actionAliases[id]; } return id; }
        function absorb(content, kind, metadata) {
            if (!content)
                return;
            var meta = metadata || {};
            var parsed = null, prefix = '';
            try {
                parsed = typeof content === 'string' ? JSON.parse(content) : content;
            }
            catch (_) {
                // Puppet deliveries retain the explicit non-voluntary-action
                // notice before their structured receipt. Keep both parts.
                var boundary = typeof content === 'string' ? content.search(/\n\s*\{/) : -1;
                if (boundary >= 0) try { parsed = JSON.parse(content.slice(boundary).trim()); prefix = content.slice(0, boundary).trim(); } catch (_) {}
            }
            var scene = parsed && (parsed.scene || parsed.observation && parsed.observation.scene);
            if (scene && typeof scene.text === 'string') acceptScene(scene);
            if (scene && typeof scene.text === 'string') {
                var sceneObservation = parsed.observation || (parsed.observationId ? parsed : null), observedExperiences = sceneObservation && sceneObservation.experiences;
                var sceneSources = new Set(scene.sourceEventIds || []), sceneGroups = new Set((Array.isArray(observedExperiences) ? observedExperiences : []).filter(function (experience) { return experience && experience.correlationId && Array.isArray(experience.sourceEventIds) && experience.sourceEventIds.some(function (id) { return sceneSources.has(id); }); }).map(function (experience) { return experience.correlationId; }));
                log('scene', scene.text, { eventId: scene.eventId || meta.eventId, groupId: scene.actionId || scene.correlationId || meta.actionId || meta.correlationId || (sceneGroups.size === 1 ? [...sceneGroups][0] : undefined), worldSequence: scene.worldSequence, worldTime: scene.worldTime, sourceEventIds: scene.sourceEventIds || [], revision: scene.revision, phase: scene.phase, raw: prefix ? content : { scene: scene }, controlNote: prefix });
                if (!parsed.observation && !parsed.observationId && !parsed.action) return;
            }
            var action = parsed && parsed.action, actionId = action && action.id || meta.actionId;
            if (actionId) linkAction(actionId, meta.requestId);
            var related = actionId || meta.requestId || meta.correlationId;
            var observation = parsed && (parsed.observation || (parsed.observationId ? parsed : null));
            if (observation && Array.isArray(observation.entities)) {
                // Reconnects and a delayed HTTP response may replay an older
                // observation. Keep its history, but never roll back current handles.
                if (!state.observation || observation.mode === 'narrative' && state.observation.mode !== 'narrative' || (observation.mode === 'narrative' || state.observation.mode !== 'narrative') && (!Number.isFinite(observation.worldSequence) || !Number.isFinite(state.observation.worldSequence) || observation.worldSequence >= state.observation.worldSequence)) {
                    state.observation = observation;
                    if (!scene && observation.narrative) acceptScene({ eventId: observation.observationId, worldSequence: observation.worldSequence, worldTime: observation.observedAt, text: observation.narrative, situation: observation.situation, opportunities: observation.opportunities || [] });
                    observerLabel = '最新观测';
                    // Described targets remain valid drafts across observations; World judges accessibility.
                }
                var experiences = Array.isArray(observation.experiences) ? observation.experiences : [];
                experiences.forEach(function (experience) {
                    if (!experience || !experience.eventId || typeof experience.text !== 'string') return;
                    log('experience', experience.text, { eventId: experience.eventId, experienceKind: experience.kind, groupId: experience.correlationId, worldSequence: experience.worldSequence, worldTime: experience.worldTime, order: experience.order, sourceEventIds: experience.sourceEventIds || [], raw: experience });
                });
                (observation.utterances || []).forEach(function (utterance) {
                    if (state.events.some(function (event) { return event.eventId === utterance.eventId || event.kind === 'experience' && event.experienceKind === 'speech' && (event.sourceEventIds || []).includes(utterance.eventId); })) return;
                    log('speech', utterance.text, { speaker: utterance.speakerName, eventId: utterance.eventId, groupId: related, worldTime: utterance.spokenAt, worldSequence: observation.worldSequence, sourceEventIds: [utterance.eventId], raw: utterance });
                });
                log('observation', observation.narrative || '当前所见已更新', { eventId: 'observation:' + observation.observationId, observationId: observation.observationId, groupId: related, auxiliary: !!scene || !!action || experiences.length > 0, worldSequence: observation.worldSequence, worldTime: observation.observedAt, sourceEventIds: observation.sourceEventIds || [], raw: observation });
            }
            if (action) {
                log(action.status === 'failed' || action.status === 'cancelled' ? 'failure' : 'result', action.reason || ({ completed: '这次行动已完成。', needs_input: '行动已推进，现在由你决定下一步。', failed: '这次行动未完成。', cancelled: '这次行动已取消。', pending: '行动正在进行。' }[action.status] || '行动状态已更新。'), {
                    eventId: 'action:' + (action.id || related || meta.eventId || digest(content)) + ':' + action.status, groupId: related, action: action, status: action.status, worldSequence: observation && observation.worldSequence || meta.worldSequence, worldTime: observation && observation.observedAt != null ? observation.observedAt : meta.worldTime, raw: prefix ? content : parsed, controlNote: prefix, sourceEventIds: observation && observation.sourceEventIds || []
                });
            } else if (!observation && !state.events.some(function (event) { return !meta.eventId && event.content === content && Date.now() - event.ts < 2500; })) {
                log(kind || 'world', content, { eventId: meta.eventId, groupId: related, worldSequence: meta.worldSequence, worldTime: meta.worldTime, raw: parsed || content, status: meta.status });
            }
        }
        function toolResult(result, pending) {
            if (pending && result.callId) linkAction(result.callId, pending.id);
            absorb(result.text || (result.content && result.content.text), result.ok ? 'result' : 'failure', { requestId: pending && pending.id, eventId: result.callId && 'tool:' + result.callId, status: result.ok ? 'completed' : 'failed' });
            var attachments = result.content && result.content.attachments;
            if (attachments && attachments.length) log(result.ok ? 'result' : 'failure', '工具返回的媒体', { eventId: result.callId && 'media:' + result.callId, groupId: pending && pending.id, attachments: attachments });
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
                var nextCockpit = { tools: result.tools || [], pending: result.pending || [], choices: result.choices || {}, opportunities: result.opportunities || [], situation: result.situation || '' };
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
            stream = new EventSource(withToken('/api/player/events?ctoken=' + encodeURIComponent(capturedToken) + (state.lastEventId ? '&lastEventId=' + encodeURIComponent(state.lastEventId) : '')));
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
                if (message.eventId || event.lastEventId) state.lastEventId = message.eventId || event.lastEventId;
                if (message.type === 'hello') {
                    state.connection = 'connected';
                    state.worldName = message.worldName || state.worldName;
                    state.lastTimeLine = message.timeLine || state.lastTimeLine;
                    if (Number(message.unitWorldSeconds) > 0)
                        state.unitWorldSeconds = Number(message.unitWorldSeconds);
                }
                else if (message.type === 'event' || message.type === 'status_update') {
                    state.lastTimeLine = message.timeLine || state.lastTimeLine;
                    absorb(message.content, undefined, { eventId: message.eventId || event.lastEventId, requestId: message.taskId || message.refToolCallId, actionId: message.actionId, correlationId: message.correlationId, worldSequence: message.worldSequence, worldTime: message.worldTime });
                }
                else if (message.type === 'task_result') {
                    absorb(message.content, message.ok ? 'result' : 'failure', { eventId: message.eventId || event.lastEventId, requestId: message.taskId, worldSequence: message.worldSequence, worldTime: message.worldTime, status: message.ok ? 'completed' : 'failed' });
                    if (state.pending && state.pending.id === message.taskId)
                        state.pending = null;
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
                    state.observation = null; state.currentScene = null;
                }
                if (!state.takeover && Array.isArray(message.opportunities)) {
                    var sequence = Number.isFinite(message.worldSequence) ? message.worldSequence : state.currentScene && state.currentScene.worldSequence;
                    var revision = message.opportunityRevision;
                    if (Number.isFinite(revision) && (!Number.isFinite(state.opportunityRevision) || revision > state.opportunityRevision || message.type === 'hello' && revision === state.opportunityRevision)) {
                        state.playerOpportunities = message.opportunities;
                        state.opportunitySequence = sequence;
                        state.opportunityRevision = revision;
                    }
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
                state.actionAliases = {};
                state.lastEventId = '';
                state.observationOpen = false;
                cockpitDraft = state.cockpitDraft = {};
                formDraft = state.actionDraft = { description: '', speech: '', duration: '0', revision: 0 };
                selectedTarget = state.selectedTarget = '';
                state.operatorCollapsed = false;
                state.observation = null; state.currentScene = null;
                state.playerOpportunities = []; state.opportunitySequence = null; state.opportunityRevision = null;
                state.pending = null;
                state.unitWorldSeconds = null;
                control = { synced: !!result.control, paused: !!(result.control && result.control.paused), busy: !!(result.control && result.control.busy) };
                log('system', state.takeover ? state.mode === 'puppet' ? '已接管身体；Bot 仍有自己的意识，会感知非自主的身体行动。' : control.busy ? '自主生成已暂停，正在等待此前已提交的操作返回回执。' : '已完全入替，期间的意图和经历将由角色自然继承。' : '入场已受理，正在等待世界中的第一份观测。');
                if (result.observation) absorb({ observation: result.observation });
                changed();
                if (!destroyed && !connections[key])
                    connect();
            }).catch(fail).finally(function () { busy = false; redraw(); });
        }
        function prepareObservation() {
            var intent = '仔细看看周围，确认眼前的情况。';
            if (state.takeover) { if (shell && shell.controller) shell.controller.prepareAction(intent); return; }
            chooseOpportunity({ intent: intent });
        }
        function acceptScene(scene) {
            var previous = state.currentScene;
            if (previous && Number.isFinite(previous.worldSequence) && Number.isFinite(scene.worldSequence) && scene.worldSequence < previous.worldSequence) return;
            if (previous && previous.worldSequence === scene.worldSequence && Number.isFinite(previous.worldTime) && Number.isFinite(scene.worldTime) && scene.worldTime < previous.worldTime) return;
            if (previous && previous.eventId === scene.eventId && Number.isFinite(previous.revision) && Number.isFinite(scene.revision) && scene.revision < previous.revision) return;
            state.currentScene = scene;
        }
        function sceneOpportunities() {
            return state.playerOpportunities || [];
        }
        function chooseOpportunity(item) {
            formDraft.description = item.intent; formDraft.speech = ''; formDraft.duration = '0';
            formDraft.revision = (formDraft.revision || 0) + 1; formDraft.opportunityId = item.id || null;
            formDraft.selection = item.id ? { opportunityId: item.id, sourceEventId: item.sourceEventId } : null;
            formDraft.selectionLabel = item.id ? item.label : '';
            selectedTarget = state.selectedTarget = ''; saveDrafts(); redraw();
        }
        function submit(quickChoice) {
            var selection = quickChoice ? { opportunityId: quickChoice.id, sourceEventId: quickChoice.sourceEventId } : formDraft.selection;
            var chosen = selection && sceneOpportunities().find(function (item) { return item.id === selection.opportunityId && item.sourceEventId === selection.sourceEventId; });
            if (selection && !chosen) { errorText = '这个建议已随情境更新。请重新选择，或改为自由行动。'; redraw(); return; }
            var description = chosen ? chosen.intent : formDraft.description.trim(), speech = quickChoice || !formDraft.speech.trim() ? '' : formDraft.speech, duration = quickChoice ? 0 : Number(formDraft.duration);
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
            if (state.pending || busy || state.connection !== 'connected')
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
            var draftRevision = quickChoice ? null : formDraft.revision = (formDraft.revision || 0) + 1;
            var id = 'action_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
            var pending = { id: id, description: description, startedAt: Date.now(), status: 'submitting', takeover: state.takeover };
            var requestToken = state.token, body = { token: requestToken, taskId: id, kind: 'act', payload: payload };
            if (selection) body = { token: requestToken, taskId: id, kind: 'choose', payload: { selection: selection, durationWorldSeconds: duration, ...(speech ? { text: speech } : {}) } };
            if (!state.takeover)
                pending.body = body;
            state.pending = pending;
            errorText = '';
            log('intent', description, { eventId: 'intent:' + id, groupId: id, speech: speech, duration: duration, tool: 'act' });
            changed();
            redraw();
            var request = state.takeover ? api('POST', '/api/player/tool', { token: requestToken, name: 'act', arguments: args, duration: duration / state.unitWorldSeconds }) : api('POST', '/api/player/task', body);
            request.then(function (result) {
                if (state.token !== requestToken)
                    return;
                if (pending.takeover) {
                    toolResult(result, pending);
                    if (state.pending === pending)
                        state.pending = null;
                    refreshControl();
                }
                else if (state.pending === pending)
                    pending.status = 'accepted';
                if (draftRevision !== null && formDraft.revision === draftRevision) {
                    if (formDraft.description.trim() === description) formDraft.description = '';
                    if (formDraft.speech === speech || !formDraft.speech.trim()) formDraft.speech = '';
                    formDraft.selection = null; formDraft.opportunityId = null;
                }
                changed();
                redraw();
            }).catch(function (error) {
                if (state.token !== requestToken)
                    return;
                var rejected = admissionRejected(error);
                if (state.pending === pending) { if (rejected) state.pending = null; else pending.status = 'unknown'; }
                log(rejected ? 'failure' : 'system', rejected ? '这次行动没有执行：' + error.message : '未收到请求回执。请重新观察确认结果；不会自动重发动作。', { requestId: pending.id, groupId: pending.id });
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
                    absorb(result.result.content, result.result.ok ? 'result' : 'failure', { requestId: pending.id, status: result.result.ok ? 'completed' : 'failed' });
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
                .catch(function (error) {
                    if (state.token !== requestToken || state.pending !== pending) return;
                    if (admissionRejected(error)) { state.pending = null; log('failure', '这次行动没有执行：' + error.message, { groupId: pending.id }); }
                    else pending.status = 'unknown';
                    changed(); fail(error);
                });
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
                state.observation = null; state.currentScene = null;
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
        function callTool(name, args, duration, confirmSend, selection) {
            if (!state.takeover || !state.token || state.pending || state.connection !== 'connected' || !control.synced || control.busy || state.mode !== 'puppet' && !control.paused || !cockpit.tools.some(function (tool) { return tool.name === name; })) return false;
            var token = state.token, pending = { id: 'tool_' + Date.now().toString(36), takeover: true, description: name, status: 'submitting', startedAt: Date.now() };
            state.pending = pending; errorText = '';
            var intention = args.thought || args.description || args.msg || args.text || args.statement;
            log('intent', typeof intention === 'string' ? intention : WorldCockpit.label({ name: name }), { eventId: 'intent:' + pending.id, groupId: pending.id, tool: name, arguments: args, speech: args.speech }); changed(); redraw();
            var body = selection ? { token: token, selection: selection, ...(typeof (name === 'send' ? args.msg : args.speech) === 'string' ? { text: name === 'send' ? args.msg : args.speech } : {}), duration: duration, confirmSend: !!confirmSend } : { token: token, name: name, arguments: args, duration: duration, confirmSend: !!confirmSend };
            var request = api('POST', '/api/player/tool', body).then(function (result) {
                if (token !== state.token) return;
                toolResult(result, pending);
                if (state.pending === pending) state.pending = null;
                changed(); refreshControl(); redraw(); return result;
            }).catch(function (error) {
                if (token !== state.token) return;
                var rejected = admissionRejected(error);
                if (state.pending === pending) { if (rejected) state.pending = null; else pending.status = 'unknown'; }
                log(rejected ? 'failure' : 'system', rejected ? '这次操作没有执行：' + error.message : '请求结果未确认，不会自动重发。请查看执行中的工具或重新观察。', { groupId: pending.id });
                changed(); refreshControl(); fail(error);
                return { ok: false, text: error.message };
            });
            setTimeout(refreshControl, 150);
            return request;
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
                card.appendChild(button(selectedTarget === entity.name ? '已选为目标' : '选择为行动目标', function () { selectedTarget = entity.name; if (shell && shell.controller && shell.controller.setTarget) shell.controller.setTarget(selectedTarget); redraw(); }, 'journey-entity-select'));
            return card;
        }
        function actionPanel() {
            var pendingEdit = null, badgeStamp = '', replacementStamp = '', composing = false;
            formDraft.savedDrafts = formDraft.savedDrafts || (formDraft.savedDraft ? [formDraft.savedDraft] : []);
            delete formDraft.savedDraft;
            function snapshotDraft() { return { description: formDraft.description, speech: formDraft.speech, duration: formDraft.duration, target: selectedTarget }; }
            function edited() { formDraft.revision = (formDraft.revision || 0) + 1; saveDrafts(); }
            var description = el('textarea', { cls: 'journey-input journey-action-input', rows: '2', 'data-cockpit-field': 'action:description', 'aria-label': '想做什么', placeholder: '想做什么？也可以写主动观察，例如仔细看看菜单。', oninput: function () { formDraft.description = description.value; edited(); } });
            var speech = el('textarea', { cls: 'journey-input journey-speech-input', rows: '2', 'data-cockpit-field': 'action:speech', placeholder: '角色实际说出的原话', oninput: function () { formDraft.speech = speech.value; edited(); } });
            var target = el('input', { cls: 'journey-input', type: 'text', 'aria-label': '行动目标', 'data-cockpit-field': 'action:target', placeholder: '名字或描述 · 可以留空', oninput: function () { selectedTarget = state.selectedTarget = target.value; edited(); } });
            var duration = el('input', { cls: 'journey-input', type: 'number', min: '0', step: 'any', value: formDraft.duration, 'aria-label': '预计时长（世界秒）', oninput: function () { formDraft.duration = duration.value; edited(); } });
            var options = el('details', { cls: 'cockpit-options' }, [el('summary', { text: '说话与选项' }), field('说出的话 · 可选', speech), el('div', { cls: 'journey-two-fields' }, [field('行动目标', target), field('预计时长 · 世界秒', duration)]), note('直接描述想做什么，无需填写编号；世界会根据当前处境回应。')]);
            options.ontoggle = resizeDock;
            var error = el('div', { cls: 'journey-error', role: 'alert', hidden: true }), submitButton = el('button', { type: 'submit', cls: 'journey-button journey-primary', text: '提交这次行动' }), queue = el('div', { cls: 'journey-pending-host' });
            var badge = el('div', { cls: 'journey-choice-draft', hidden: true }), replacement = el('div', { cls: 'journey-choice-draft', hidden: true });
            var speechField = field('说出的原话 · 可选', speech), optionalSpeech = options.querySelector('.journey-field');
            optionalSpeech.replaceWith(speechField);
            var speechHost = el('div', { cls: 'journey-choice-speech', hidden: true });
            var form = el('form', { cls: 'journey-action' }, [el('div', { cls: 'cockpit-bar' }, [el('strong', { text: '自由行动' }), el('span', { cls: 'cockpit-count', text: '写下自己的意图，或在上方点选' })]), replacement, badge, description, speechHost, options, error, submitButton, queue]);
            form.addEventListener('compositionstart', function () { composing = true; });
            form.addEventListener('compositionend', function () { composing = false; });
            form.onsubmit = function (event) { event.preventDefault(); if (!submitButton.disabled) submit(); };
            form.prepareOpportunity = function (item) {
                if (composing) { errorText = '请先完成正在输入的文字，草稿会保留。'; form.update(); return; }
                if (!sceneOpportunities().some(function (current) { return current.id === item.id && current.sourceEventId === item.sourceEventId; })) return;
                if (formDraft.description.trim() || formDraft.speech.trim()) { pendingEdit = item; form.update(); return; }
                chooseOpportunity(item); form.update();
            };
            function detach() { formDraft.selection = null; formDraft.opportunityId = null; formDraft.selectionLabel = ''; badgeStamp = ''; edited(); redraw(); }
            form.freeAction = detach;
            var pendingStamp = '';
            form.update = function () {
                // These are the original DOM nodes throughout the session, including
                // IME composition, SSE receipts and reconnection. Never re-focus them.
                if (description.value !== formDraft.description) description.value = formDraft.description;
                if (speech.value !== formDraft.speech) speech.value = formDraft.speech;
                if (duration.value !== formDraft.duration && document.activeElement !== duration) duration.value = formDraft.duration;
                if (target.value !== selectedTarget && document.activeElement !== target) target.value = selectedTarget;
                error.hidden = !errorText; error.textContent = errorText;
                var selection = formDraft.selection, stale = !!selection && !sceneOpportunities().some(function (item) { return item.id === selection.opportunityId && item.sourceEventId === selection.sourceEventId; });
                submitButton.disabled = !!state.pending || state.connection !== 'connected' || busy || stale;
                description.hidden = !!selection; speechHost.hidden = !selection; target.disabled = !!selection;
                if (selection && speechField.parentElement !== speechHost) speechHost.appendChild(speechField);
                else if (!selection && speechField.parentElement !== options) options.insertBefore(speechField, options.querySelector('.journey-two-fields'));
                var nextBadge = JSON.stringify([selection, stale, formDraft.selectionLabel]);
                if (nextBadge !== badgeStamp) {
                    badgeStamp = nextBadge; badge.hidden = !selection; badge.replaceChildren();
                    if (selection) badge.append(el('p', { text: (stale ? '情境已更新 · ' : '准备行动 · ') + (formDraft.selectionLabel || formDraft.description) }), note(stale ? '台词和草稿已保留。重新选择，或解除关联后自行决定。' : formDraft.description), button('改为自由行动', detach, 'journey-subtle'));
                }
                var nextReplacement = JSON.stringify(pendingEdit);
                if (nextReplacement !== replacementStamp) {
                    replacementStamp = nextReplacement; replacement.hidden = !pendingEdit; replacement.replaceChildren();
                    if (pendingEdit) replacement.append(note('输入框里还有未提交的草稿。要改为“' + pendingEdit.label + '”吗？'), button('保留草稿', function () { pendingEdit = null; form.update(); }, 'journey-subtle'), button('暂存草稿，补充台词', function () {
                        if (composing) { errorText = '请先完成正在输入的文字，草稿会保留。'; form.update(); return; }
                        var item = pendingEdit; pendingEdit = null;
                        formDraft.savedDrafts.push(snapshotDraft());
                        if (sceneOpportunities().some(function (current) { return current.id === item.id && current.sourceEventId === item.sourceEventId; })) chooseOpportunity(item);
                        else errorText = '这个建议已经更新，请重新选择。';
                        redraw();
                    }, 'journey-subtle'));
                }
                if (formDraft.savedDrafts.length && !badge.querySelector('[data-restore-action-draft]')) { badge.hidden = false; badge.appendChild(button('恢复暂存草稿', function () {
                    if (composing) { errorText = '请先完成正在输入的文字，草稿会保留。'; form.update(); return; }
                    var saved = formDraft.savedDrafts.pop();
                    if (formDraft.description.trim() || formDraft.speech.trim()) formDraft.savedDrafts.unshift(snapshotDraft());
                    formDraft.description = saved.description; formDraft.speech = saved.speech; formDraft.duration = saved.duration; selectedTarget = state.selectedTarget = saved.target;
                    detach();
                }, 'journey-subtle')); badge.lastChild.dataset.restoreActionDraft = '1'; }
                submitButton.textContent = state.pending ? '等待行动回执' : selection ? '就这样行动' : '提交这次行动';
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
            if (event.action || event.kind === 'scene' || event.kind === 'experience' || event.kind === 'observation') return ReadableData.render(event.content, { compact: true, raw: false, textLimit: event.kind === 'scene' ? 1600 : 700, state: readState(event, 'prose') });
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
        function eventTime(event) { return Number.isFinite(event.worldTime) ? '世界 T=' + Number(event.worldTime.toFixed(1)) : time(event.ts); }
        function eventOrder(a, b) {
            if (Number.isFinite(a.worldSequence) && Number.isFinite(b.worldSequence) && a.worldSequence !== b.worldSequence) return a.worldSequence - b.worldSequence;
            if (a.worldSequence === b.worldSequence && Number.isFinite(a.order) && Number.isFinite(b.order) && a.order !== b.order) return a.order - b.order;
            if (Number.isFinite(a.worldTime) && Number.isFinite(b.worldTime) && a.worldTime !== b.worldTime) return a.worldTime - b.worldTime;
            if (a.kind === 'scene' && b.kind !== 'scene') return 1;
            if (b.kind === 'scene' && a.kind !== 'scene') return -1;
            return a.ts - b.ts;
        }
        function eventRow(event, internalThought) {
            var labels = { experience: { movement: '走动与位置', appearance: '眼前出现', change: '发生的变化', speech: '听到的回应', action: '行动进展' }[event.experienceKind] || '实际经过', scene: '这一刻', observation: '观察', speech: event.speaker || '听到的声音', result: event.status === 'needs_input' ? '等你决定' : '行动结果', failure: event.status === 'cancelled' ? '已取消' : '遇到的阻碍', system: '会话', world: '世界' };
            if (internalThought === true && event.kind === 'result') labels.result = '独白回执';
            return el('div', { cls: 'journey-feed-row journey-feed-' + event.kind, 'data-journey-event': event.eventId || '' }, [
                el('div', { cls: 'journey-feed-meta' }, [el('strong', { text: labels[event.kind] || '世界' }), el('time', { text: eventTime(event), title: new Date(event.ts).toLocaleString() })]),
                event.controlNote ? note(event.controlNote, 'journey-control-notice') : null, eventBody(event), event.speech ? el('blockquote', { text: event.speech }) : null,
                event.attachments ? el('div', { cls: 'cockpit-result-attachments' }, event.attachments.map(media)) : null
            ]);
        }
        function historyGroups() {
            var groups = new Map(), coveredSpeech = new Set();
            state.events.forEach(function (event) { if (event.kind === 'experience' && event.experienceKind === 'speech') (event.sourceEventIds || []).forEach(function (id) { coveredSpeech.add(id); }); });
            state.events.forEach(function (event, index) {
                if (event.kind === 'speech' && coveredSpeech.has(event.eventId)) return;
                var id = groupId(event.groupId) || (event.kind === 'experience' || event.kind === 'scene' ? 'world:' + event.worldSequence : event.eventId || 'local:' + event.ts + ':' + index);
                var group = groups.get(id);
                if (!group) { group = { id: id, events: [], ts: event.ts }; groups.set(id, group); }
                group.events.push(event); group.ts = Math.min(group.ts, event.ts);
                if (event.kind === 'intent') group.intent = event;
                if (event.action && (!group.action || group.action.action.status === 'pending' || event.action.status !== 'pending' && eventOrder(group.action, event) <= 0)) group.action = event;
                if (Number.isFinite(event.worldSequence)) group.worldSequence = Math.min(group.worldSequence == null ? Infinity : group.worldSequence, event.worldSequence);
            });
            return [...groups.values()].filter(function (group) { return group.events.some(function (event) { return !event.auxiliary; }); }).sort(function (a, b) {
                // A late narrative stays with its original action instead of
                // jumping above a newer decision. Pending intentions remain first.
                if (state.pending) { var pending = groupId(state.pending.id); if ((a.id === pending) !== (b.id === pending)) return a.id === pending ? -1 : 1; }
                return Number.isFinite(a.worldSequence) && Number.isFinite(b.worldSequence) && a.worldSequence !== b.worldSequence ? b.worldSequence - a.worldSequence : b.ts - a.ts;
            }).slice(0, 40);
        }
        function actionCard(group) {
            var intent = group.intent, action = group.action && group.action.action, anchor = intent || group.action || group.events[0], pending = state.pending && groupId(state.pending.id) === group.id;
            var internalThought = intent && intent.tool === 'think';
            var status = action && action.status || (pending ? state.pending.status === 'unknown' ? 'unknown' : 'pending' : group.events.some(function (event) { return event.kind === 'failure'; }) ? 'failed' : intent ? group.events.some(function (event) { return event.kind === 'result' || event.kind === 'observation'; }) ? 'completed' : 'unknown' : 'world');
            var states = { pending: '进行中', unknown: '结果未确认', completed: '已完成', needs_input: '等你决定', failed: '未完成', cancelled: '已取消', world: '周围的动静' };
            if (internalThought) { states.pending = '正在记下'; states.completed = '已记下'; states.failed = '未能记下'; }
            var title = intent && intent.content || action && action.intent || (group.events.some(function (event) { return event.kind === 'observation'; }) ? '看看此刻的世界' : group.events.every(function (event) { return event.kind === 'system'; }) ? '会话记录' : '世界正在发生的事');
            var card = el('article', { cls: 'journey-action-card', 'data-journey-group': group.id, 'data-action-status': status }, [
                el('header', { cls: 'journey-action-heading' }, [el('span', { cls: 'journey-section-kicker', text: intent ? WorldCockpit.label({ name: intent.tool || 'act' }) : action ? '角色行动' : '世界 / EXPERIENCE' }), el('span', { cls: 'journey-action-state journey-state-' + status, text: states[status] || status })]),
                el('h3', { cls: 'journey-action-title', text: internalThought ? '此刻心里浮现的想法' : title }), intent && intent.speech ? el('blockquote', { cls: 'journey-intent-speech', text: intent.speech }) : null
            ]);
            if (intent) card.appendChild(el('div', { cls: 'journey-intent-meta', text: (internalThought ? '角色的主观想法' : '你的意图') + ' · ' + eventTime(intent) }));
            if (internalThought) card.appendChild(ReadableData.render({ name: 'think', arguments: intent.arguments || { thought: intent.content } }, { compact: true, raw: false, textLimit: 900, state: readState(intent, 'thought') }));
            var steps = el('div', { cls: 'journey-action-steps' });
            var scenes = group.events.filter(function (event) { return event.kind === 'scene'; }).sort(eventOrder), facts = group.events.filter(function (event) { return event.kind === 'experience' || event.kind === 'speech'; }).sort(eventOrder);
            var factsState = readState(anchor, 'facts');
            if (factsState.open == null && facts.length) factsState.open = !scenes.length;
            if (scenes.length && facts.length) {
                scenes.forEach(function (event) { steps.appendChild(eventRow(event)); });
                var detail = el('details', { cls: 'journey-experience-details', open: factsState.open }, [el('summary', { text: '实际经过与回应 · ' + facts.length + ' 项' }), el('div', {}, facts.map(eventRow))]);
                detail.addEventListener('toggle', function () { if (detail.isConnected) factsState.open = detail.open; });
                steps.appendChild(detail);
            } else facts.concat(scenes).sort(eventOrder).forEach(function (event) { steps.appendChild(eventRow(event)); });
            group.events.filter(function (event) { return !['intent', 'result', 'failure', 'scene', 'experience', 'speech'].includes(event.kind) && !event.auxiliary; }).sort(eventOrder).forEach(function (event) { steps.appendChild(eventRow(event)); });
            group.events.filter(function (event) { return event.kind === 'result' || event.kind === 'failure'; }).sort(eventOrder).forEach(function (event) { steps.appendChild(eventRow(event, !!internalThought)); });
            if (pending && !steps.childElementCount) steps.appendChild(note(internalThought ? '正在记下这段想法。' : '正在尝试，世界的回应会出现在这里。'));
            if (steps.childElementCount) card.appendChild(steps);
            var records = group.events.filter(function (event) { return (event.raw != null || event.arguments) && !(event.kind === 'observation' && action); }).sort(function (a, b) { return Number(!!b.action) - Number(!!a.action); });
            if (records.length) card.appendChild(ReadableData.raw(records.map(function (event) { return event.raw != null ? event.raw : { intent: event.content, arguments: event.arguments }; }), { label: '展开原始回执与依据 · ' + records.length + ' 份', state: readState(anchor, 'receipts') }));
            return card;
        }
        function updateFeed() {
            var groups = historyGroups(), active = new Set();
            groups.forEach(function (group) {
                active.add(group.id);
                var stamp = JSON.stringify([group.events, state.pending && groupId(state.pending.id) === group.id && state.pending.status]), cached = shell.cards.get(group.id);
                if (!cached || cached.stamp !== stamp) {
                    var card = actionCard(group);
                    if (cached) cached.node.replaceWith(card);
                    cached = { stamp: stamp, node: card }; shell.cards.set(group.id, cached);
                }
            });
            shell.cards.forEach(function (cached, id) { if (!active.has(id)) { cached.node.remove(); shell.cards.delete(id); } });
            groups.forEach(function (group, index) { var node = shell.cards.get(group.id).node, current = shell.feed.children[index]; if (current !== node) shell.feed.insertBefore(node, current || null); });
            shell.feedEmpty.hidden = groups.length > 0;
        }
        function cockpitData() { return { tools: cockpit.tools, pending: cockpit.pending, opportunities: cockpit.opportunities || [], situation: cockpit.situation || (state.currentScene && state.currentScene.situation) || '', choices: Object.assign({}, pickerChoices, cockpit.choices || {}), observation: state.observation, deviceSession: deviceSession, synced: control.synced, mode: state.mode, unitWorldSeconds: state.unitWorldSeconds, blocked: control.busy || state.mode !== 'puppet' && !control.paused, blockedReason: control.busy ? '此前操作正在完成，等待真实回执。' : '控制权已在其他界面归还，请离场后重新接管。', submitting: !!state.pending, uncertain: !!state.pending && state.pending.status === 'unknown' }; }
        function openComposer() {
            if (!shell) return;
            shell.collapsed = state.operatorCollapsed = false; shell.controller.hidden = false;
            shell.fold.textContent = '收起操作台 · 查看世界'; shell.fold.setAttribute('aria-expanded', 'true');
            resizeDock(); saveDrafts();
        }
        function actFromMenu(item, edit) {
            if (!shell || state.pending || state.connection !== 'connected' || busy) return;
            if (state.takeover) {
                shell.controller.chooseOpportunity(item, { edit: !!edit });
                if (edit || item.replyTo) openComposer();
            } else if (edit) { shell.controller.prepareOpportunity(item); openComposer(); }
            else submit(item);
        }
        function inside() {
            shell = { session: el('div', { cls: 'journey-session-host' }), observations: el('section', { cls: 'journey-observations' }), live: el('section', { cls: 'journey-live-status', 'aria-label': 'World 与 Bot 实时状态' }), history: el('div', { cls: 'journey-history-host' }), dock: el('div', { cls: 'journey-dock', 'aria-label': '悬浮操作台' }), collapsed: !!state.operatorCollapsed, sessionStamp: '', observationStamp: '', eventStamp: '' };
            shell.cards = new Map();
            shell.feed = el('div', { cls: 'journey-feed' });
            shell.feedEmpty = note('还没有收到事件。入场感知会自动送达，也可以提交你的第一步。');
            shell.historyError = el('div', { cls: 'journey-error', role: 'alert', hidden: true });
            shell.history.append(shell.historyError, el('section', { cls: 'journey-card journey-history' }, [el('div', { cls: 'journey-section-kicker', text: '经历 / RECENT' }), el('h2', { text: '刚刚发生的事' }), note('新的行动排在前面，每次行动从意图读到结果。'), shell.feedEmpty, shell.feed]));
            shell.observationHead = el('div', { cls: 'journey-observation-head' });
            shell.observationSummary = el('summary', { cls: 'journey-state-summary' });
            shell.observationBody = el('div', { cls: 'journey-state-body' });
            shell.observationDetails = el('details', { cls: 'journey-state-details', open: !!state.observationOpen }, [shell.observationSummary, shell.observationBody]);
            shell.observationDetails.addEventListener('toggle', function () { if (!shell) return; state.observationOpen = shell.observationDetails.open; saveDrafts(); });
            shell.observations.append(shell.observationHead, shell.observationDetails);
            var links = el('div', { cls: 'journey-session-shortcuts' });
            if (state.takeover) links.appendChild(button('操作手机与电脑 ↗', function () { Studio.navigate('devices'); }, 'journey-subtle'));
            if (!isVisitor() || visitorCanSee(['debug'])) links.appendChild(button('查看实时思考与调用 ↗', function () { Studio.navigate('live'); }, 'journey-subtle'));
            shell.menu = WorldActionMenu.mount({ choose: function (item) { actFromMenu(item, false); }, edit: function (item) { actFromMenu(item, true); }, free: function () { openComposer(); if (state.takeover) shell.controller.select('act'); else shell.controller.freeAction(); } });
            var livePanel = el('details', { cls: 'journey-live-panel', open: !!state.liveOpen }, [el('summary', { text: '世界与角色正在做什么 · 实时生成' }), shell.live]);
            livePanel.addEventListener('toggle', function () { state.liveOpen = livePanel.open; saveDrafts(); });
            main.append(shell.session, shell.menu, links, livePanel, el('div', { cls: 'journey-stream-layout' }, [shell.history, shell.observations]), shell.dock);
            if (window.LiveCalls && (!isVisitor() || visitorCanSee(['debug']))) liveCleanup = LiveCalls.mount(shell.live, { compact: true });
            else shell.live.appendChild(note('连接与行动回执会实时更新；当前账号未开放模型调用内容。'));
            shell.controller = state.takeover ? WorldCockpit.mount(cockpitData(), cockpitDraft, { call: callTool, cancel: cancelTool, resize: resizeDock, prepare: prepareTool, changed: function () { saveDrafts(); if (shell.controller) redraw(); }, recover: function () { state.pending = null; changed(); refreshControl(); redraw(); } }) : actionPanel();
            var fold = button(shell.collapsed ? '展开操作台' : '收起操作台 · 查看世界', function () {
                shell.collapsed = state.operatorCollapsed = !shell.collapsed;
                shell.controller.hidden = shell.collapsed;
                fold.textContent = shell.collapsed ? '展开操作台' : '收起操作台 · 查看世界'; fold.setAttribute('aria-expanded', String(!shell.collapsed));
                resizeDock(); persist(key, state);
            }, 'journey-dock-grip'); fold.setAttribute('aria-expanded', String(!shell.collapsed));
            shell.fold = fold;
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
            var observationStamp = JSON.stringify([state.observation, state.currentScene, selectedTarget, state.connection, !!state.pending, control.synced, control.busy, control.paused, cockpit.tools.some(function (tool) { return tool.name === 'act'; })]);
            if (observationStamp !== shell.observationStamp) {
                shell.observationStamp = observationStamp;
                var observeButton = button('想仔细看看', prepareObservation, 'journey-subtle'); observeButton.disabled = state.connection !== 'connected' || state.takeover && (!control.synced || control.busy || !cockpit.tools.some(function (tool) { return tool.name === 'act'; }));
                shell.observationHead.replaceChildren(el('div', {}, [el('div', { cls: 'journey-section-kicker', text: '眼前的世界' }), el('h2', { text: '此刻的处境' })]), observeButton);
                shell.observationDetails.dataset.journeyObservation = state.observation && state.observation.observationId || '';
                shell.observationSummary.replaceChildren(el('strong', { text: state.observation ? state.observation.mode === 'narrative' ? '此刻所见所闻 · 展开回看' : state.observation.entities.length + ' 个可见实体 · 点选或查看' : '等待第一份观测' }), el('span', { text: state.observation && Number.isFinite(state.observation.observedAt) ? '世界 T=' + Number(state.observation.observedAt.toFixed(1)) : '展开查看' }));
                if (state.observation) {
                    var entities = el('div', { cls: 'journey-entities' }); state.observation.entities.forEach(function (entity) { entities.appendChild(entityCard(entity)); });
                    shell.observationBody.replaceChildren(state.observation.narrative ? ReadableData.render(state.observation.narrative, { raw: false, textLimit: 2400, state: readState(state.observation, ':narrative') }) : entities, ReadableData.raw(state.observation, { label: '完整观测与依据', state: readState(state.observation, ':full') }));
                } else shell.observationBody.replaceChildren(el('div', { cls: 'journey-waiting-scene' }, [el('h3', { text: '先看看自己身处何处。' }), note('入场感知会自动到达。若想主动查看某个细节，可把观察意图写成下一步行动。')]));
            }
            var eventStamp = JSON.stringify([state.events, state.actionAliases, errorText, state.pending && state.pending.status]);
            if (eventStamp !== shell.eventStamp) {
                shell.eventStamp = eventStamp; updateFeed();
                shell.historyError.hidden = !errorText; shell.historyError.textContent = errorText;
            }
            shell.controller.update(state.takeover ? cockpitData() : undefined);
            var scene = state.currentScene || state.observation && state.observation.scene;
            var blocked = state.connection !== 'connected' || busy || state.takeover && (!control.synced || control.busy || state.mode !== 'puppet' && !control.paused);
            shell.menu.update({ items: state.takeover ? cockpit.opportunities || [] : sceneOpportunities(), situation: state.takeover && cockpit.situation || scene && scene.situation || '', sceneText: scene && scene.text || '', selectedId: state.takeover ? cockpitDraft.opportunityId : formDraft.opportunityId, disabled: blocked, disabledReason: state.connection !== 'connected' ? '正在恢复世界连接，草稿会保留。' : '正在确认角色控制状态，请稍候。', busy: !!state.pending || !!(state.takeover && cockpit.pending.length) });
            resizeDock();
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
