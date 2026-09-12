/* Authoritative entity relations and evidence-based subjective growth. */
(function () {
    var kinds = { place: '地点', actor: '角色', object: '物件' };
    var symbols = { place: 'world', actor: 'user', object: 'box' };
    var statuses = { pending: '进行中', completed: '已完成', failed: '未完成', cancelled: '已取消' };
    var nodeGlyph = {
        place: '<path d="m4 8 8-5 8 5v10l-8 5-8-5Z"/><path d="m4 8 8 5 8-5M12 13v10"/>',
        actor: '<circle cx="12" cy="8" r="4"/><path d="M5 22v-2a7 7 0 0 1 14 0v2"/>',
        object: '<path d="m3 7 9-5 9 5v10l-9 5-9-5Z"/><path d="m3 7 9 5 9-5M12 12v10"/>'
    };
    function sv(tag, attrs, text) {
        var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs || {}).forEach(function (a) { n.setAttribute(a[0], String(a[1])); });
        if (text != null)
            n.textContent = String(text);
        return n;
    }
    function short(value, n) { var s = String(value); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function graphModel(entities) {
        var byId = new Map(entities.map(function (e) { return [e.id, e]; })), levels = new Map(), coords = new Map();
        function depth(e, seen) { if (!e.location || !byId.has(e.location) || seen.has(e.id))
            return 0; seen.add(e.id); return Math.min(12, depth(byId.get(e.location), seen) + 1); }
        entities.forEach(function (e) { var d = depth(e, new Set()); if (!levels.has(d))
            levels.set(d, []); levels.get(d).push(e); });
        var maxRows = Math.max(1, ...Array.from(levels.values()).map(function (a) { return a.length; }));
        var width = Math.max(470, (Math.max(0, ...levels.keys()) + 1) * 224 + 44), height = Math.max(280, maxRows * 103 + 58);
        Array.from(levels.entries()).sort(function (a, b) { return a[0] - b[0]; }).forEach(function (pair) {
            pair[1].sort(function (a, b) { return (a.location || '').localeCompare(b.location || '') || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name); });
            pair[1].forEach(function (e, i) { coords.set(e.id, { x: 34 + pair[0] * 224, y: (height - pair[1].length * 103) / 2 + i * 103 + 10 }); });
        });
        return { coords: coords, width: width, height: height };
    }
    function makeGraph(entities, options) {
        var model = graphModel(entities), svg = sv('svg', { viewBox: '0 0 ' + model.width + ' ' + model.height, role: 'img', 'aria-label': '实体关系图。选择节点查看详情。实线表示位置，虚线表示所有权。' });
        var edges = sv('g'), nodes = sv('g');
        svg.append(edges, nodes);
        var related = new Set(options.selected ? [options.selected] : []);
        if (options.selected)
            entities.forEach(function (e) { if (e.location === options.selected || e.owner === options.selected)
                related.add(e.id); if (e.id === options.selected) {
                related.add(e.location);
                related.add(e.owner);
            } });
        entities.forEach(function (e) {
            [['location', options.location !== false], ['owner', options.owner !== false]].forEach(function (r) {
                var p = model.coords.get(e[r[0]]), c = model.coords.get(e.id);
                if (!r[1] || !p || !c)
                    return;
                var x1 = p.x + 166, y1 = p.y + 33, x2 = c.x, y2 = c.y + 33, dx = Math.max(35, Math.abs(x2 - x1) / 2);
                var edge = sv('path', { d: 'M' + x1 + ',' + y1 + 'C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2, class: 'world-edge ' + (r[0] === 'owner' ? 'owner' : '') + (options.selected && !(related.has(e.id) && related.has(e[r[0]])) ? ' faded' : '') });
                edge.appendChild(sv('title', {}, (r[0] === 'owner' ? '所有者' : '容纳于') + '：' + e.name + ' → ' + e[r[0]]));
                edges.appendChild(edge);
            });
        });
        entities.forEach(function (e) {
            var p = model.coords.get(e.id);
            var g = sv('g', { transform: 'translate(' + p.x + ' ' + p.y + ')', class: 'world-node ' + e.kind + (e.id === options.selected ? ' selected' : options.selected && !related.has(e.id) ? ' faded' : ''), tabindex: 0, role: 'button', 'aria-label': kinds[e.kind] + '：' + e.name + '，版本 ' + e.revision, 'data-entity-id': e.id });
            g.appendChild(sv('rect', { width: 166, height: 68, rx: 11 }));
            g.appendChild(sv('rect', { x: 11, y: 17, width: 32, height: 34, rx: 8, class: 'node-icon-bg' }));
            var glyph = sv('g', { transform: 'translate(16 22) scale(.9)', class: 'node-icon' });
            glyph.innerHTML = nodeGlyph[e.kind] || nodeGlyph.object;
            g.appendChild(glyph);
            g.appendChild(sv('text', { x: 53, y: 28, class: 'node-label' }, short(e.name, 10)));
            g.appendChild(sv('text', { x: 53, y: 46, class: 'node-meta' }, short(e.id, 14)));
            g.appendChild(sv('text', { x: 146, y: 13, class: 'node-kind', 'text-anchor': 'end' }, kinds[e.kind]));
            g.appendChild(sv('title', {}, e.name + ' · ' + e.id));
            g.addEventListener('click', function () { options.select?.(e.id); });
            g.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                options.select?.(e.id);
            } });
            nodes.appendChild(g);
        });
        return { svg: svg, model: model };
    }
    Studio.drawWorldPreview = function (holder, snapshot) {
        var all = Object.values(snapshot.entities), bot = snapshot.entities.bot;
        var ids = new Set([bot?.id, bot?.location]);
        all.filter(function (e) { return e.location === bot?.location || e.location === bot?.id; }).slice(0, 5).forEach(function (e) { ids.add(e.id); });
        var shown = all.filter(function (e) { return ids.has(e.id); });
        if (!shown.length)
            shown = all.slice(0, 7);
        holder.appendChild(makeGraph(shown, { owner: false, select: Studio.inspectEntity }).svg);
    };
    Studio.register('world', function (holder) {
        var alive = true, busy = false, data = null, selected = Studio.takeSelectedEntity(), query = '', filter = 'all', mode = 'graph', showLocation = true, showOwner = true, viewBox = null, chosenEvent = null, pendingFocus = null, readableStates = Object.create(null);
        function readState(key) { return readableStates[key] || (readableStates[key] = {}); }
        var controls = el('div', { cls: 'world-controls' }), content = el('div'), actions = el('div', { cls: 'world-actions' }), eventsPanel = el('div', { cls: 'world-actions' });
        holder.append(Studio.title('THE SHAPE OF YOUR WORLD', '世界关系图', '连接地点、角色与物件。选择一个实体，查看它在哪里、属于谁，以及它的当前状态。', [Studio.button('刷新状态', 'refresh', refresh)]), controls, content, actions, eventsPanel);
        content.appendChild(el('div', { cls: 'studio-skeleton' }));
        var search = el('input', { cls: 'world-search', placeholder: '查找实体名称或 ID', 'aria-label': '搜索实体' });
        search.addEventListener('input', function () { query = search.value.trim().toLowerCase(); viewBox = null; draw(); });
        controls.appendChild(search);
        var filters = el('div', { cls: 'world-filter-group', role: 'group', 'aria-label': '筛选实体类型' });
        [['all', '全部'], ['place', '地点'], ['actor', '角色'], ['object', '物件']].forEach(function (r) { var b = Studio.button(r[1], null, function () { filter = r[0]; filters.querySelectorAll('button').forEach(function (n) { n.classList.toggle('active', n === b); n.setAttribute('aria-pressed', String(n === b)); }); viewBox = null; draw(); }); b.className = r[0] === filter ? 'active' : ''; b.setAttribute('aria-pressed', String(r[0] === filter)); filters.appendChild(b); });
        controls.appendChild(filters);
        var toggles = el('div', { cls: 'world-view-toggle' });
        ['graph', 'list'].forEach(function (m) { var b = Studio.button(m === 'graph' ? '关系图' : '实体列表', m === 'graph' ? 'world' : 'file', function () { mode = m; toggles.querySelectorAll('button').forEach(function (n) { n.classList.toggle('primary', n === b); }); draw(); }); b.classList.toggle('primary', mode === m); toggles.appendChild(b); });
        controls.appendChild(toggles);
        function select(id) { selected = id; chosenEvent = null; draw(); if (window.innerWidth <= 1100)
            content.querySelector('.world-inspector')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        function refresh() { if (!alive || busy)
            return; busy = true; Studio.fetchWorld().then(function (r) { if (!alive)
            return; var changed = !data || JSON.stringify(data) !== JSON.stringify(r); data = r; if (pendingFocus) {
            applyFocus(pendingFocus);
            pendingFocus = null;
            changed = true;
        } if (selected && !data.snapshot.entities[selected]) {
            selected = null;
            changed = true;
        } if (changed || content.querySelector('.studio-error'))
            draw(); }).catch(function (e) { if (alive)
            Studio.error(content, e, refresh); }).finally(function () { busy = false; }); }
        function draw() {
            if (!data || !alive)
                return;
            var snapshot = data.snapshot, all = Object.values(snapshot.entities);
            var found = all.filter(function (e) { return (filter === 'all' || e.kind === filter) && (!query || (e.id + ' ' + e.name).toLowerCase().includes(query)); });
            content.replaceChildren();
            var wrap = el('div', { cls: 'world-workspace' }), graphPanel = el('div', { cls: 'world-canvas-panel' });
            graphPanel.appendChild(el('div', { cls: 'world-canvas-head' }, [el('strong', { text: mode === 'graph' ? '实体与空间' : '实体目录' }), el('small', { text: found.length + ' / ' + all.length + ' 实体 · 版本 #' + snapshot.sequence })]));
            if (!found.length)
                graphPanel.appendChild(Studio.empty(all.length ? '没有符合条件的实体' : '世界还没有结构化实体', all.length ? '修改搜索词或类型筛选。' : '完成创世或旧数据迁移后，实体会自动出现。'));
            else if (mode === 'graph') {
                var shown = found.slice(0, 250);
                if (found.length > shown.length)
                    graphPanel.appendChild(el('div', { cls: 'world-limit-notice', text: '本视图展示前 250 个实体。使用搜索缩小范围，或在实体列表中浏览全部结果。' }));
                var canvas = el('div', { cls: 'world-canvas' });
                var result = makeGraph(shown, { selected: selected, location: showLocation, owner: showOwner, select: select });
                canvas.appendChild(result.svg);
                if (!viewBox)
                    viewBox = [0, 0, result.model.width, result.model.height];
                function update() { result.svg.setAttribute('viewBox', viewBox.join(' ')); }
                function zoom(scale) { var w = Math.min(20000, Math.max(180, viewBox[2] * scale)), ratio = w / viewBox[2], h = viewBox[3] * ratio; viewBox = [viewBox[0] + (viewBox[2] - w) / 2, viewBox[1] + (viewBox[3] - h) / 2, w, h]; update(); }
                update();
                canvas.addEventListener('wheel', function (e) { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : .89); }, { passive: false });
                var drag = null;
                canvas.addEventListener('pointerdown', function (e) { if (e.target.closest('.world-node') || e.target.closest('button'))
                    return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY, origin: viewBox.slice() }; canvas.setPointerCapture(e.pointerId); });
                canvas.addEventListener('pointermove', function (e) { if (!drag || drag.id !== e.pointerId)
                    return; var r = canvas.getBoundingClientRect(); viewBox = [drag.origin[0] - (e.clientX - drag.x) * drag.origin[2] / r.width, drag.origin[1] - (e.clientY - drag.y) * drag.origin[3] / r.height, drag.origin[2], drag.origin[3]]; update(); });
                function end(e) { if (drag?.id === e.pointerId)
                    drag = null; }
                canvas.addEventListener('pointerup', end);
                canvas.addEventListener('pointercancel', end);
                var fit = Studio.button('⊙', null, function () { viewBox = [0, 0, result.model.width, result.model.height]; update(); });
                fit.title = '适应窗口';
                fit.setAttribute('aria-label', '适应窗口');
                var plus = Studio.button('+', null, function () { zoom(.8); });
                plus.setAttribute('aria-label', '放大关系图');
                var minus = Studio.button('−', null, function () { zoom(1.25); });
                minus.setAttribute('aria-label', '缩小关系图');
                canvas.append(el('div', { cls: 'world-canvas-note', text: '拖动画布 · 滚动缩放 · 点击节点查看详情' }), el('div', { cls: 'world-canvas-tools' }, [minus, fit, plus]));
                graphPanel.appendChild(canvas);
            }
            else {
                var list = el('div', { cls: 'world-entity-list' });
                found.forEach(function (e) { list.appendChild(el('button', { cls: 'world-entity-row' + (selected === e.id ? ' selected' : ''), onclick: function () { select(e.id); } }, [el('span', { html: icon(symbols[e.kind]) }), el('span', null, [el('span', { cls: 'name', text: e.name }), el('div', { cls: 'id', text: e.id })]), el('span', { cls: 'location', text: e.location ? snapshot.entities[e.location]?.name || e.location : '根位置 / 未定位' }), el('span', { cls: 'revision', text: 'v' + e.revision })])); });
                graphPanel.appendChild(list);
            }
            var footer = el('div', { cls: 'world-canvas-footer' });
            [['位置关系', 'location'], ['所有权关系', 'owner']].forEach(function (p) { footer.appendChild(el('label', null, [el('input', { type: 'checkbox', checked: p[1] === 'location' ? showLocation : showOwner, onchange: function (e) { if (p[1] === 'location')
                        showLocation = e.target.checked;
                    else
                        showOwner = e.target.checked; draw(); } }), el('span', { cls: 'world-line-key ' + (p[1] === 'owner' ? 'owner' : '') }), el('span', { text: p[0] })])); });
            footer.appendChild(el('span', { text: '连线来自已提交的实体引用' }));
            graphPanel.appendChild(footer);
            var inspector = el('aside', { cls: 'world-inspector', 'aria-label': '实体详情' });
            drawInspector(inspector, snapshot);
            wrap.append(graphPanel, inspector);
            content.appendChild(wrap);
            drawActions(snapshot);
            drawEvents();
        }
        function drawInspector(inspector, snapshot) {
            var e = snapshot.entities[selected];
            if (!e) {
                inspector.appendChild(Studio.empty('选择一个实体', '点击关系图中的节点，或在列表中选择角色、地点与物件。'));
                return;
            }
            inspector.appendChild(el('div', { cls: 'world-inspector-header' }, [el('div', { cls: 'world-inspector-kind' }, [el('span', { cls: 'world-inspector-avatar', html: icon(symbols[e.kind]) }), el('span', { cls: 'studio-badge', text: kinds[e.kind] })]), el('h2', { text: e.name }), el('div', { cls: 'world-inspector-id', text: e.id + ' · v' + e.revision })]));
            var body = el('div', { cls: 'world-inspector-body' });
            body.appendChild(el('h4', { text: '关系' }));
            [['location', '所在位置'], ['owner', '所有者']].forEach(function (p) { var target = snapshot.entities[e[p[0]]]; if (target)
                body.appendChild(el('button', { cls: 'world-relation', onclick: function () { select(target.id); } }, [el('span', { html: icon(symbols[target.kind]) }), el('span', { text: target.name }), el('span', { text: p[1] })]));
            else if (p[0] === 'location')
                body.appendChild(el('p', { cls: 'studio-description', text: e.kind === 'place' ? '根地点 · 没有上级空间' : '位置未记录' })); });
            if (e.controller)
                body.appendChild(el('div', { cls: 'world-relation' }, [el('span', { html: icon('shield') }), el('span', { text: { bot: 'Bot 自主控制', world: '世界控制的 NPC', player: '玩家控制' }[e.controller] || e.controller })]));
            var contained = Object.values(snapshot.entities).filter(function (x) { return x.location === e.id; });
            if (contained.length) {
                body.appendChild(el('h4', { text: '内部 / 携带 · ' + contained.length }));
                var inventory = el('div', { cls: 'world-inventory' });
                contained.forEach(function (x) { inventory.appendChild(Studio.button(x.name, symbols[x.kind], function () { select(x.id); })); });
                body.appendChild(inventory);
            }
            body.appendChild(el('h4', { text: '结构化属性' }));
            var attrs = Object.entries(e.attributes || {});
            if (!attrs.length)
                body.appendChild(el('p', { cls: 'studio-description', text: '尚未记录属性；未知信息保持未知。' }));
            attrs.forEach(function (a) { body.appendChild(el('div', { cls: 'world-property' }, [el('div', { cls: 'world-property-head' }, [el('span', { text: ReadableData.label(a[0]), title: a[0] }), el('span', { cls: 'world-visibility ' + a[1].visibility, text: { public: '公开', owner: '自身 / 所有者', hidden: '隐藏' }[a[1].visibility] || a[1].visibility })]), el('div', { cls: 'world-property-value' }, [ReadableData.render(a[1].value, { compact: true, state: readState(JSON.stringify([e.id, a[0]])) })])])); });
            var relevant = (data.events || []).filter(function (event) { return event.actorId === e.id || event.payload?.changedEntityIds?.includes(e.id) || event.payload?.entityIds?.includes(e.id); }).slice(-4).reverse();
            if (relevant.length) {
                body.appendChild(el('h4', { text: '相关事件' }));
                relevant.forEach(function (event) { body.appendChild(el('button', { cls: 'world-event-link', text: '#' + event.sequence + ' · ' + event.topic, onclick: function () { showEvent(event); } })); });
            }
            body.appendChild(ReadableData.raw(e, { state: readState('entity:' + e.id) }));
            inspector.appendChild(body);
        }
        function drawActions(snapshot) {
            actions.replaceChildren();
            var all = Object.values(snapshot.actions || {}).sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
            if (selected)
                all = all.filter(function (a) { return a.actorId === selected || a.targetIds?.includes(selected); });
            var section = el('section', { cls: 'studio-panel' });
            section.appendChild(Studio.section(selected ? '关联行动' : '行动进程', all.length + ' 条记录'));
            if (!all.length)
                section.appendChild(Studio.empty('当前没有行动记录', '行动开始、完成、失败或取消都会留下明确状态。'));
            all.slice(0, 12).forEach(function (a) { section.appendChild(el('div', { cls: 'world-action-row' }, [el('span', { cls: 'studio-badge ' + (a.status === 'failed' ? 'orange' : a.status === 'pending' ? '' : 'muted'), text: statuses[a.status] || a.status }), el('span', { cls: 'intent' }, [el('span', { text: a.intent }), el('small', { text: a.reason || a.id })]), el('span', { cls: 'actor', text: snapshot.entities[a.actorId]?.name || a.actorId }), el('time', { text: 'T ' + Number(a.startedAt || 0).toFixed(1) })])); });
            actions.appendChild(section);
        }
        function showEvent(event) { chosenEvent = event; drawEvents(); eventsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        function drawEvents() {
            eventsPanel.replaceChildren();
            var panel = el('section', { cls: 'studio-panel' });
            var events = (data.events || []).filter(function (e) { return e.kind === 'event'; }).slice(-10).reverse();
            panel.appendChild(Studio.section('事务与因果', '最近 ' + events.length + ' 个已提交事件'));
            var list = el('div', { cls: 'world-event-list' });
            events.forEach(function (e) { list.appendChild(el('div', { cls: 'world-event-item' }, [el('span', { text: '#' + e.sequence }), el('span', null, [el('span', { text: e.topic }), el('small', { text: (e.actorId || e.source) + ' · ' + fmtTime(e.emittedAt) })]), Studio.button('查看关联', 'link', function () { showEvent(e); })])); });
            if (!events.length)
                list.appendChild(Studio.empty('还没有提交事件', '观察与执行记录会随着世界运转出现。'));
            panel.appendChild(list);
            if (chosenEvent) {
                var box = el('div', { cls: 'world-event-detail' });
                box.appendChild(el('h4', { text: chosenEvent.topic, style: 'margin:0 0 10px;font-size:13px' }));
                var related = (data.events || []).filter(function (e) { return e.id !== chosenEvent.id && (e.id === chosenEvent.causationId || e.causationId === chosenEvent.id || (e.correlationId && e.correlationId === chosenEvent.correlationId)); });
                var links = el('div', { cls: 'toolbar' });
                related.forEach(function (e) { links.appendChild(Studio.button('#' + e.sequence + ' ' + e.topic, 'link', function () { showEvent(e); })); });
                if (chosenEvent.causationId && !related.some(function (e) { return e.id === chosenEvent.causationId; }))
                    box.appendChild(el('p', { cls: 'studio-description', text: '上游事件不在当前返回窗口中：' + chosenEvent.causationId }));
                box.append(links, ReadableData.render(chosenEvent, { state: readState('event:' + chosenEvent.id) }));
                panel.appendChild(box);
            }
            eventsPanel.appendChild(panel);
        }
        function applyFocus(detail) { if (detail.actorId)
            selected = detail.actorId; chosenEvent = data.events?.find(function (e) { return e.id === detail.eventId; }) || null; }
        var focus = function (ev) { if (!data) {
            pendingFocus = ev.detail;
            return;
        } applyFocus(ev.detail); draw(); };
        window.addEventListener('studio:focus-world-event', focus);
        var onRefresh = function () { if (!document.hidden)
            refresh(); };
        window.addEventListener('studio:refresh', onRefresh);
        var timer = setInterval(function () { if (!document.hidden)
            refresh(); }, 15000);
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
                content.appendChild(el('section', { cls: 'studio-panel growth-empty' }, [Studio.empty(rows.length ? '没有匹配的认识' : '经历，会慢慢留下痕迹', rows.length ? '尝试其他关键词或成长类型。' : '角色需要先观察世界、经历事件，再引用这些证据形成认识。这里会展示真实产生的关系、承诺与偏好。')]));
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
                svg.appendChild(sv('path', { d: 'M215,' + (h / 2) + 'C280,' + (h / 2) + ' 260,' + (y + 18) + ' 326,' + (y + 18), fill: 'none', stroke: counter ? '#c69a77' : '#abc2aa', 'stroke-width': 1.5, 'stroke-dasharray': counter ? '5 4' : '' }));
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
    // Pure graph layout is exposed for deterministic regression tests, not data mutation.
    Studio.worldGraphModel = graphModel;
})();
