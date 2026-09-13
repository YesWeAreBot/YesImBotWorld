/* Natural-language world state and evidence-based growth. */
(function () {
    var statuses = { pending: '进行中', completed: '已完成', failed: '未完成', cancelled: '已取消', needs_input: '等待下一步' };
    function sv(tag, attrs, text) {
        var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs || {}).forEach(function (a) { n.setAttribute(a[0], String(a[1])); });
        if (text != null)
            n.textContent = String(text);
        return n;
    }
    function short(value, n) { var s = String(value); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    Studio.register('world', function (holder) {
        var alive = true, busy = false, data = null, selectedActor = Studio.takeSelectedActor(), chosenEvent = null, pendingFocus = null, readableStates = Object.create(null);
        var focusRequested = !!selectedActor;
        function readState(key) { return readableStates[key] || (readableStates[key] = {}); }
        var content = el('div'), actions = el('div', { cls: 'world-actions' }), eventsPanel = el('div', { cls: 'world-actions' });
        holder.append(Studio.title('THE WORLD, NOW', '世界实况', '阅读当前情境、角色处境与最近发生的事。', [Studio.button('刷新状态', 'refresh', refresh)]), content, actions, eventsPanel);
        content.appendChild(el('div', { cls: 'studio-skeleton' }));
        function drawNarrative(snapshot) {
            var page = el('div', { cls: 'world-narrative', 'data-world-mode': 'narrative' });
            var scene = el('section', { cls: 'studio-panel world-current-scene' }, [Studio.section('当前情境', '版本 #' + snapshot.sequence + ' · 世界 T=' + Number(snapshot.effectiveAt || 0).toFixed(1))]);
            scene.appendChild(ReadableData.render(snapshot.worldState || '世界还没有初始情境，请先保存设定并创建世界。', { raw: false, textLimit: 5000, state: readState('world:narrative') }));
            page.appendChild(scene);
            var actors = Object.entries(snapshot.actors || {}), actorPanel = el('section', { cls: 'studio-panel' }, [Studio.section('角色的处境', actors.length + ' 位角色')]);
            var list = el('div', { cls: 'world-narrative-actors' });
            actors.forEach(function (entry) {
                var actor = entry[1], card = el('article', { cls: 'world-narrative-actor' + (entry[0] === selectedActor ? ' selected' : ''), 'data-world-actor': entry[0], tabindex: -1 }, [el('h3', { text: actor.name || entry[0] })]);
                card.appendChild(ReadableData.render(actor.state || '尚无处境记录。', { raw: false, textLimit: 1600, state: readState('actor:' + entry[0]) }));
                list.appendChild(card);
            });
            if (actors.length) { actorPanel.appendChild(list); page.appendChild(actorPanel); }
            content.replaceChildren(page);
        }
        function refresh() {
            if (!alive || busy) return;
            busy = true;
            Studio.fetchWorld().then(function (result) {
                if (!alive) return;
                var changed = !data || JSON.stringify(data) !== JSON.stringify(result);
                data = result;
                if (pendingFocus) { applyFocus(pendingFocus); pendingFocus = null; changed = true; }
                if (chosenEvent) chosenEvent = data.events?.find(function (event) { return event.id === chosenEvent.id; }) || chosenEvent;
                if (changed || content.querySelector('.studio-error')) draw();
            }).catch(function (error) { if (alive) Studio.error(content, error, refresh); }).finally(function () { busy = false; });
        }
        function draw() {
            if (!data || !alive) return;
            drawNarrative(data.snapshot);
            drawActions(data.snapshot);
            drawEvents();
            if (focusRequested) {
                var target = chosenEvent ? eventsPanel.querySelector('.world-event-detail') : Array.from(content.querySelectorAll('[data-world-actor]')).find(function (card) { return card.dataset.worldActor === selectedActor; });
                if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
                focusRequested = false;
            }
        }
        function drawActions(snapshot) {
            actions.replaceChildren();
            var all = Object.values(snapshot.actions || {}).sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
            var section = el('section', { cls: 'studio-panel' }, [Studio.section('行动进程', all.length + ' 条记录')]);
            if (!all.length) section.appendChild(Studio.empty('当前没有行动记录', '行动开始、完成、失败或取消都会留下明确状态。'));
            all.slice(0, 12).forEach(function (action) {
                section.appendChild(el('div', { cls: 'world-action-row' }, [
                    el('span', { cls: 'studio-badge ' + (action.status === 'failed' ? 'orange' : action.status === 'pending' ? '' : 'muted'), text: statuses[action.status] || action.status }),
                    el('span', { cls: 'intent' }, [el('span', { text: action.intent }), el('small', { text: action.reason || (action.status === 'pending' ? '世界正在回应这一意图' : action.status === 'needs_input' ? '本次行动结束，等待角色作出新的决定' : '本次行动已经结束') })]),
                    el('span', { cls: 'actor', text: snapshot.actors?.[action.actorId]?.name || action.actorId }),
                    el('time', { text: 'T ' + Number(action.startedAt || 0).toFixed(1) })
                ]));
            });
            actions.appendChild(section);
        }
        function eventTitle(event) { return event.payload?.intent || ({ 'world.perception': '此刻所见所闻', 'world.committed': '世界记录已保存' }[event.topic] || event.topic); }
        function showEvent(event) {
            chosenEvent = event;
            drawEvents();
            var detail = eventsPanel.querySelector('.world-event-detail');
            detail?.focus({ preventScroll: true });
            detail?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        function drawEvents() {
            eventsPanel.replaceChildren();
            var events = (data.events || []).filter(function (event) { return event.kind === 'event' || event.kind === 'observation' && event.topic === 'world.perception'; }).slice(-10).reverse();
            var panel = el('section', { cls: 'studio-panel' }, [Studio.section('最近发生', '最近 ' + events.length + ' 个已提交事件')]);
            var list = el('div', { cls: 'world-event-list' });
            events.forEach(function (event) {
                var actor = data.snapshot.actors?.[event.actorId], item = el('article', { cls: 'world-event-item', 'data-world-event': event.id });
                var header = el('div', { cls: 'world-event-header' }, [
                    el('span', { cls: 'world-event-sequence', text: '#' + event.sequence }),
                    el('div', { cls: 'world-event-heading' }, [el('strong', { text: eventTitle(event) }), el('small', { text: (actor?.name || event.actorId || event.source) + ' · ' + fmtTime(event.emittedAt) })]),
                    Studio.button('查看记录', 'file', function () { showEvent(event); })
                ]);
                item.appendChild(header);
                var prose = event.payload?.narrative || event.payload?.text || event.payload?.result;
                if (typeof prose === 'string') item.appendChild(el('div', { cls: 'world-event-prose' }, [ReadableData.render(prose, { raw: false, textLimit: 1300, state: readState('event-prose:' + event.id) })]));
                list.appendChild(item);
            });
            if (!events.length) list.appendChild(Studio.empty('还没有提交事件', '观察与执行记录会随着世界运转出现。'));
            panel.appendChild(list);
            if (chosenEvent) {
                var box = el('div', { cls: 'world-event-detail', tabindex: -1 });
                box.appendChild(el('h4', { text: eventTitle(chosenEvent) }));
                var related = chosenEvent.correlationId ? (data.events || []).filter(function (event) { return event.id !== chosenEvent.id && event.correlationId === chosenEvent.correlationId; }) : [];
                if (related.length) {
                    var links = el('div', { cls: 'toolbar' });
                    related.forEach(function (event) { links.appendChild(Studio.button('#' + event.sequence + ' ' + eventTitle(event), 'link', function () { showEvent(event); })); });
                    box.appendChild(links);
                }
                box.appendChild(ReadableData.render(chosenEvent, { state: readState('event:' + chosenEvent.id) }));
                panel.appendChild(box);
            }
            eventsPanel.appendChild(panel);
        }
        function applyFocus(detail) {
            selectedActor = detail.actorId || null;
            chosenEvent = data.events?.find(function (event) { return event.id === detail.eventId; }) || null;
            focusRequested = true;
        }
        var focus = function (event) {
            if (!data) { pendingFocus = event.detail; return; }
            applyFocus(event.detail); draw();
        };
        window.addEventListener('studio:focus-world-event', focus);
        var onRefresh = function () { if (!document.hidden) refresh(); };
        window.addEventListener('studio:refresh', onRefresh);
        var timer = setInterval(onRefresh, 15000);
        refresh();
        return function () { alive = false; clearInterval(timer); window.removeEventListener('studio:refresh', onRefresh); window.removeEventListener('studio:focus-world-event', focus); };
    });
    Studio.register('growth', function (holder) {
        var alive = true, rows = [], selected = null, kind = 'all', q = '', chosenEvidence = null, busy = false;
        var controls = el('div', { cls: 'world-controls' }), content = el('div');
        holder.append(Studio.title('A CHARACTER, WITH A HISTORY', '角色与成长', '认识来自实际经历。沿着支持、反证与修订，查看一个角色如何形成自己的判断。', [Studio.button('刷新记录', 'refresh', refresh)]), controls, content);
        var search = el('input', { cls: 'world-search', placeholder: '搜索对象或认识内容', 'aria-label': '搜索成长记录', oninput: function () { q = search.value.toLowerCase().trim(); draw(); } });
        controls.appendChild(search);
        var group = el('div', { cls: 'world-filter-group' });
        [['all', '全部'], ['relationship', '关系'], ['commitment', '承诺'], ['preference', '偏好']].forEach(function (k) { var b = Studio.button(k[1], null, function () { kind = k[0]; group.querySelectorAll('button').forEach(function (n) { n.classList.toggle('active', n === b); }); draw(); }); b.classList.toggle('active', k[0] === kind); group.appendChild(b); });
        controls.appendChild(group);
        content.appendChild(el('div', { cls: 'studio-skeleton' }));
        function refresh() { if (busy || !alive)
            return; busy = true; Studio.fetchGrowth().then(function (value) { if (!alive)
            return; rows = Array.isArray(value) ? value : []; draw(); }).catch(function (e) { if (alive)
            Studio.error(content, e, refresh); }).finally(function () { busy = false; }); }
        function draw() {
            if (!alive)
                return;
            content.replaceChildren();
            var found = rows.filter(function (r) { return (kind === 'all' || r.kind === kind) && (!q || (r.subject + ' ' + r.statement).toLowerCase().includes(q)); });
            if (!found.length) {
                content.appendChild(el('section', { cls: 'studio-panel growth-empty' }, [Studio.empty(rows.length ? '没有匹配的认识' : '尚未形成成长记录', rows.length ? '尝试其他关键词或成长类型。' : '聊天、日记和上下文压缩不会自动生成认识。角色需要引用亲身经历，主动整理关系、承诺或偏好；没有记录不代表没有经历，也不需要为填满这里而制造结论。')]));
                return;
            }
            if (!found.some(function (r) { return r.claimId === selected; }))
                selected = found[0].claimId;
            var list = el('div', { cls: 'growth-claims', 'aria-label': '角色认识列表' }), detail = el('section', { cls: 'studio-panel growth-detail' });
            found.forEach(function (r) { list.appendChild(el('button', { cls: 'growth-claim' + (r.claimId === selected ? ' active' : ''), 'aria-pressed': String(r.claimId === selected), onclick: function () { selected = r.claimId; chosenEvidence = null; draw(); } }, [el('span', { cls: 'growth-claim-heading' }, [el('span', { cls: 'studio-badge ' + (r.kind === 'commitment' ? 'orange' : r.kind === 'preference' ? 'blue' : ''), text: { relationship: '关系', commitment: '承诺', preference: '偏好' }[r.kind] }), el('span', { cls: 'subject', text: r.subject })]), el('p', { text: r.statement }), el('small', { text: (r.evidence?.length || 0) + ' 项观测 · ' + (r.records?.length || 0) + ' 次记录' + (r.status === 'contested' ? ' · 存在反证' : '') })])); });
            var view = found.find(function (r) { return r.claimId === selected; });
            drawDetail(detail, view);
            content.appendChild(el('div', { cls: 'growth-workspace' }, [list, detail]));
        }
        function showEvidence(id) { chosenEvidence = id; draw(); content.querySelector('.growth-evidence-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        function drawDetail(detail, view) {
            var records = view.records || [], evidence = view.evidence || [];
            detail.appendChild(el('div', { cls: 'growth-topline' }, [el('span', { cls: 'studio-badge ' + (view.status === 'contested' ? 'orange' : ''), text: view.status === 'contested' ? '存在反证，仍在形成' : '暂定认识' }), el('span', { cls: 'studio-description', text: '关于 ' + view.subject })]));
            detail.append(el('h2', { text: view.statement }), el('p', { cls: 'growth-hint', text: '证据数量不会自动把认识变成永久人格；新的反证和修订会保留在同一条历史中。' }));
            var map = el('div', { cls: 'growth-evidence-map' });
            var shown = evidence.slice(0, 8), h = Math.max(220, shown.length * 51 + 20), svg = sv('svg', { viewBox: '0 0 590 ' + h, role: 'img', 'aria-label': '认识与观测证据的联系，选择证据查看原文' });
            shown.forEach(function (e, i) {
                var y = 18 + i * 51, counter = records.some(function (r) { return r.relation === 'counter' && r.evidenceIds.includes(e.eventId); });
                svg.appendChild(sv('path', { d: 'M215,' + (h / 2) + 'C280,' + (h / 2) + ' 260,' + (y + 18) + ' 326,' + (y + 18), fill: 'none', stroke: counter ? 'var(--accent2)' : 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': counter ? '5 4' : '' }));
                var node = sv('g', { transform: 'translate(326 ' + y + ')', class: 'growth-evidence-node', role: 'button', tabindex: 0, 'aria-label': '查看证据 ' + e.eventId });
                node.appendChild(sv('rect', { width: 234, height: 38, rx: 8, fill: 'var(--surface)', stroke: 'var(--line2)' }));
                node.appendChild(sv('text', { x: 12, y: 16, fill: 'var(--fg)', 'font-size': 10 }, short(e.text, 21)));
                node.appendChild(sv('text', { x: 12, y: 29, fill: 'var(--fg-dim)', 'font-size': 8 }, e.source + ' · T ' + Number(e.observedAt).toFixed(1)));
                node.addEventListener('click', function () { showEvidence(e.eventId); });
                node.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    showEvidence(e.eventId);
                } });
                svg.appendChild(node);
            });
            var center = sv('g', { transform: 'translate(22 ' + (h / 2 - 35) + ')' });
            center.appendChild(sv('rect', { width: 193, height: 70, rx: 12, fill: 'var(--panel2)', stroke: 'var(--line2)' }));
            center.appendChild(sv('text', { x: 15, y: 24, fill: 'var(--accent)', 'font-size': 10 }, short('当前认识 · ' + view.subject, 17)));
            center.appendChild(sv('text', { x: 15, y: 44, fill: 'var(--fg)', 'font-size': 11 }, short(view.statement, 15)));
            svg.appendChild(center);
            map.style.height = Math.min(450, h) + 'px';
            map.appendChild(svg);
            detail.appendChild(map);
            if (evidence.length > shown.length)
                detail.appendChild(el('p', { cls: 'growth-hint', text: '关系图显示前 8 项证据，全部证据可从下方历史逐条打开。' }));
            detail.appendChild(Studio.section('认识如何形成', records.length + ' 次记录'));
            records.forEach(function (r) { var chips = el('div', { cls: 'growth-evidence-chips' }); (r.evidenceIds || []).forEach(function (id) { chips.appendChild(Studio.button(short(id, 22), null, function () { showEvidence(id); })); }); detail.appendChild(el('div', { cls: 'growth-record' }, [el('span', { cls: 'growth-record-icon ' + r.relation, text: { support: '+', counter: '−', revise: '↗' }[r.relation] || '·' }), el('div', null, [el('div', { cls: 'growth-record-head' }, [el('strong', { text: { support: '支持这条认识', counter: '出现新的反证', revise: '修订原有判断' }[r.relation] || r.relation }), el('time', { text: 'T ' + Number(r.recordedAt).toFixed(1) })]), el('p', { text: r.statement }), chips])])); });
            if (chosenEvidence) {
                var e = evidence.find(function (e) { return e.eventId === chosenEvidence; });
                var box = el('div', { cls: 'growth-evidence-detail' });
                if (e) {
                    box.appendChild(el('strong', { text: '观测证据', style: 'font-size:12px' }));
                    box.appendChild(el('blockquote', { text: e.text }));
                    box.appendChild(el('small', { text: e.eventId + ' · ' + e.source + ' · T ' + e.observedAt }));
                    if (e.rootEventIds?.length) {
                        box.appendChild(el('p', { cls: 'growth-hint', text: '原始事件来源' }));
                        e.rootEventIds.forEach(function (id) { box.appendChild(el('div', { style: 'font:9px var(--mono);overflow-wrap:anywhere', text: id })); });
                    }
                }
                else
                    box.appendChild(el('p', { text: '这项证据不在当前返回的数据中。' }));
                detail.appendChild(box);
            }
        }
        var onRefresh = function () { if (!document.hidden)
            refresh(); };
        window.addEventListener('studio:refresh', onRefresh);
        refresh();
        return function () { alive = false; window.removeEventListener('studio:refresh', onRefresh); };
    });
})();
