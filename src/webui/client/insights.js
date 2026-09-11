(function () {
    'use strict';
    var NS = 'http://www.w3.org/2000/svg';
    function svg(tag, attrs, children) { var node = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (key) { if (key === 'text')
        node.textContent = attrs[key];
    else
        node.setAttribute(key === 'cls' ? 'class' : key, attrs[key]); }); (children || []).forEach(function (child) { node.appendChild(child); }); return node; }
    function fmt(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—'; }
    function compact(value) { return value >= 1e6 ? (value / 1e6).toFixed(1) + 'm' : value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'k' : String(Math.round(value)); }
    function clock(ts, date) { return new Date(ts).toLocaleString('zh-CN', date ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    function parse(value) { try {
        return typeof value === 'string' ? JSON.parse(value) : value || {};
    }
    catch (_) {
        return {};
    } }
    function pretty(value) { try {
        return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2);
    }
    catch (_) {
        return String(value);
    } }
    function btn(label, click, cls) { return el('button', { type: 'button', cls: 'insight-button ' + (cls || ''), text: label, onclick: click }); }
    function empty(title, description) { return el('div', { cls: 'insight-empty' }, [svg('svg', { viewBox: '0 0 80 58', fill: 'none', 'aria-hidden': 'true' }, [svg('path', { d: 'M10 43H70M18 36V24M32 36V14M46 36V21M60 36V9', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }), svg('circle', { cx: '60', cy: '9', r: '3', fill: 'var(--accent2)' })]), el('strong', { text: title }), el('p', { text: description })]); }
    function metric(label, value, note, cls) { return el('div', { cls: 'insight-metric ' + (cls || '') }, [el('span', { cls: 'insight-kicker', text: label }), el('strong', { text: value }), el('span', { cls: 'insight-metric-note', text: note })]); }
    function heading(title, description, eyebrow) { return el('div', { cls: 'studio-page-head insight-page-head' }, [el('div', {}, [el('div', { cls: 'studio-eyebrow', text: eyebrow }), el('h1', { cls: 'studio-title', text: title }), el('p', { cls: 'studio-description', text: description })])]); }
    function download(filename, value) { var url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' })); var link = el('a', { href: url, download: filename }); document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
    function select(options, value, change, label) { var node = el('select', { cls: 'insight-select', 'aria-label': label, onchange: function () { change(node.value); } }); options.forEach(function (option) { node.appendChild(el('option', { value: option[0], text: option[1] })); }); node.value = value; return node; }
    function median(values) { if (!values.length)
        return null; var list = values.slice().sort(function (a, b) { return a - b; }), middle = Math.floor(list.length / 2); return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2; }
    function tokenValue(entry) { var u = parse(entry.detail).usage; if (!u)
        return null; if (Number.isFinite(u.total_tokens))
        return u.total_tokens; if (Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens))
        return u.prompt_tokens + u.completion_tokens; return null; }
    function latency(entry) { var detail = parse(entry.detail); return entry.kind === 'llm.res' && !/·流式\s*\d/.test(entry.label) && Number.isFinite(detail.ms) ? detail.ms : null; }
    function source(entry) { if (entry.bus)
        return 'transaction'; var first = String(entry.kind || '').split('.')[0]; return ['bot', 'world', 'llm'].includes(first) ? first : 'system'; }
    function lineChart(points, unit, onSelect, kind) {
        if (!points.length)
            return empty('还没有可绘制的数据', '收到实际请求或事件后，曲线会出现在这里。');
        var width = 760, height = 205, left = 45, right = 20, top = 20, bottom = 35;
        var minTime = Math.min.apply(null, points.map(function (p) { return p.ts; })), maxTime = Math.max.apply(null, points.map(function (p) { return p.ts; }));
        if (maxTime === minTime) {
            minTime -= 30000;
            maxTime += 30000;
        }
        var maxValue = Math.max.apply(null, points.map(function (p) { return p.value; }));
        maxValue = maxValue > 0 ? maxValue * 1.12 : 1;
        function x(ts) { return left + (ts - minTime) / (maxTime - minTime) * (width - left - right); }
        function y(value) { return height - bottom - value / maxValue * (height - top - bottom); }
        var chart = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': '按真实时间绘制的' + unit + '图表', cls: 'insight-chart-svg' });
        chart.appendChild(svg('text', { x: left, y: 10, fill: 'var(--fg-dim)', 'font-size': '9', text: unit }));
        for (var i = 0; i <= 3; i++) {
            var value = maxValue * i / 3, ordinate = y(value);
            chart.appendChild(svg('line', { x1: left, x2: width - right, y1: ordinate, y2: ordinate, stroke: 'var(--line)', 'stroke-dasharray': i ? '3 5' : 'none' }));
            chart.appendChild(svg('text', { x: left - 9, y: ordinate + 3, 'text-anchor': 'end', fill: 'var(--fg-dim)', 'font-size': '9', text: compact(value) }));
        }
        [minTime, (minTime + maxTime) / 2, maxTime].forEach(function (ts) { chart.appendChild(svg('text', { x: x(ts), y: height - 10, 'text-anchor': ts === minTime ? 'start' : ts === maxTime ? 'end' : 'middle', fill: 'var(--fg-dim)', 'font-size': '9', text: clock(ts, maxTime - minTime > 86400000) })); });
        var ordered = points.slice().sort(function (a, b) { return a.ts - b.ts; });
        if (kind !== 'bars' && ordered.length > 1) {
            var path = ordered.map(function (p, index) { return (index ? 'L' : 'M') + x(p.ts).toFixed(2) + ',' + y(p.value).toFixed(2); }).join(' ');
            chart.appendChild(svg('path', { d: path, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2', 'stroke-linejoin': 'round' }));
        }
        ordered.forEach(function (point) {
            var mark = kind === 'bars' ? svg('rect', { x: x(point.ts) - 5, y: y(point.value), width: 10, height: Math.max(1, y(0) - y(point.value)), rx: 2, fill: 'var(--accent)', opacity: '.8' }) : svg('circle', { cx: x(point.ts), cy: y(point.value), r: ordered.length > 100 ? 2.5 : 3.5, fill: 'var(--surface)', stroke: 'var(--accent)', 'stroke-width': '1.7' });
            mark.appendChild(svg('title', { text: clock(point.ts, true) + ' · ' + fmt(point.value) + ' ' + unit + (point.label ? ' · ' + point.label : '') }));
            if (onSelect && point.entry) {
                mark.setAttribute('tabindex', '0');
                mark.setAttribute('role', 'button');
                mark.setAttribute('aria-label', point.label + '，' + fmt(point.value) + ' ' + unit);
                mark.style.cursor = 'pointer';
                mark.addEventListener('click', function () { onSelect(point.entry); });
                mark.addEventListener('keydown', function (event) { if (event.key === 'Enter')
                    onSelect(point.entry); });
            }
            chart.appendChild(mark);
        });
        return chart;
    }
    Studio.register('debug', function (container) {
        var alive = true, entries = new Map(), selected = null, sourceFilter = 'all', levelFilter = 'all', query = '', chartMode = 'latency', paused = false, frozen = [], waiting = 0, loading = true, error = '', timer, refreshing = false, renderTimer = null;
        var root = el('div', { cls: 'insight-page insight-debug' });
        container.appendChild(root);
        var header = heading('每一次思考，都有迹可循。', '沿着请求、行动与世界事务，查看实际发生的过程。', 'OBSERVATORY / LIVE TRACE');
        var controls = el('div', { cls: 'insight-header-actions' }), pauseButton = btn('暂停跟随', togglePause), exportButton = btn('导出当前筛选', exportData, 'insight-outline');
        controls.appendChild(pauseButton);
        controls.appendChild(exportButton);
        header.appendChild(controls);
        root.appendChild(header);
        var metricHolder = el('div', { cls: 'insight-metrics' }), plotHolder = el('section', { cls: 'insight-panel insight-main-chart' }), filterHolder = el('div', { cls: 'insight-toolbar' }), statusHolder = el('div', { cls: 'insight-status', role: 'status' });
        var list = el('div', { cls: 'insight-event-list' }), detail = el('aside', { cls: 'insight-detail' });
        root.appendChild(metricHolder);
        root.appendChild(plotHolder);
        root.appendChild(filterHolder);
        root.appendChild(statusHolder);
        root.appendChild(el('div', { cls: 'insight-trace-grid' }, [list, detail]));
        var search = el('input', { cls: 'insight-search', type: 'search', placeholder: '搜索事件、内容或关联 ID…', 'aria-label': '搜索调试事件', oninput: function () { query = search.value.toLowerCase(); render(); } });
        filterHolder.appendChild(search);
        filterHolder.appendChild(select([['all', '全部来源'], ['bot', 'Bot 行为'], ['world', 'World 裁定'], ['llm', 'LLM 请求'], ['transaction', '世界事务'], ['system', '生命周期与运维']], sourceFilter, function (value) { sourceFilter = value; render(); }, '按来源筛选'));
        filterHolder.appendChild(select([['all', '全部级别'], ['info', '信息'], ['warn', '警告'], ['error', '错误']], levelFilter, function (value) { levelFilter = value; render(); }, '按级别筛选'));
        filterHolder.appendChild(btn('刷新', refresh, 'insight-outline'));
        function current() { return paused ? frozen : Array.from(entries.values()); }
        function filtered() { return current().filter(function (entry) { return (sourceFilter === 'all' || source(entry) === sourceFilter) && (levelFilter === 'all' || entry.level === levelFilter) && (!query || (entry.label + ' ' + entry.kind + ' ' + entry.detail + ' ' + entry.id).toLowerCase().includes(query)); }).sort(function (a, b) { return b.ts - a.ts; }); }
        function ingest(items) { (items || []).forEach(function (entry) { entries.set(String(entry.id), entry); }); if (entries.size > 1500)
            Array.from(entries.values()).sort(function (a, b) { return a.ts - b.ts; }).slice(0, entries.size - 1500).forEach(function (entry) { entries.delete(String(entry.id)); }); }
        function schedule() { if (renderTimer || !alive)
            return; renderTimer = setTimeout(function () { renderTimer = null; if (paused)
            updatePause();
        else
            render(); }, 200); }
        function updatePause() { pauseButton.textContent = paused ? '恢复跟随' + (waiting ? ' · ' + waiting + ' 次更新' : '') : '暂停跟随'; pauseButton.classList.toggle('insight-active', paused); }
        function togglePause() { paused = !paused; if (paused)
            frozen = Array.from(entries.values());
        else {
            frozen = [];
            waiting = 0;
        } render(); }
        function exportData() { download('world-trace-' + new Date().toISOString().slice(0, 10) + '.json', { exportedAt: new Date().toISOString(), filters: { source: sourceFilter, level: levelFilter, query: query }, entries: filtered() }); }
        function choose(entry) { selected = String(entry.id); renderDetails(); renderList(); }
        function render() {
            if (!alive)
                return;
            updatePause();
            var data = filtered();
            var responses = data.filter(function (entry) { return latency(entry) !== null; }), ms = median(responses.map(latency)), failures = data.filter(function (entry) { return entry.level === 'error'; }).length;
            metricHolder.textContent = '';
            metricHolder.appendChild(metric('当前可见事件', fmt(data.length), '按来源、级别与搜索筛选'));
            metricHolder.appendChild(metric('响应耗时 · 中位数', ms === null ? '—' : (ms / 1000).toFixed(2) + ' s', responses.length ? responses.length + ' 条已完成 LLM 请求' : '尚未收到完成请求'));
            metricHolder.appendChild(metric('错误事件', fmt(failures), failures ? '点击级别筛选定位具体原因' : '当前记录中未发现错误', failures ? 'insight-metric-warn' : ''));
            plotHolder.textContent = '';
            var tabs = el('div', { cls: 'insight-tabs' });
            [['latency', '响应耗时'], ['tokens', '请求 Token'], ['activity', '事件密度']].forEach(function (pair) { tabs.appendChild(btn(pair[1], function () { chartMode = pair[0]; render(); }, chartMode === pair[0] ? 'insight-active' : '')); });
            plotHolder.appendChild(el('div', { cls: 'insight-panel-head' }, [el('div', {}, [el('h2', { text: chartMode === 'latency' ? '请求的节奏' : chartMode === 'tokens' ? '每次请求的消耗' : '世界的活动轨迹' }), el('p', { text: '横轴为真实时间 · ' + (chartMode === 'activity' ? '每个时间桶中的实际记录数量' : '点击数据点查看对应记录') })]), tabs]));
            var points = [], unit = '';
            if (chartMode === 'latency') {
                unit = '毫秒';
                points = responses.map(function (entry) { return { ts: entry.ts, value: latency(entry), label: entry.label, entry: entry }; });
            }
            else if (chartMode === 'tokens') {
                unit = 'tokens';
                points = data.filter(function (entry) { return entry.kind === 'llm.res' && tokenValue(entry) !== null; }).map(function (entry) { return { ts: entry.ts, value: tokenValue(entry), label: entry.label, entry: entry }; });
            }
            else if (data.length) {
                unit = '条事件';
                var from = Math.min.apply(null, data.map(function (entry) { return entry.ts; })), until = Math.max.apply(null, data.map(function (entry) { return entry.ts; })), step = Math.max(1000, Math.ceil((until - from + 1) / 24)), buckets = new Map();
                data.forEach(function (entry) { var bucket = from + Math.floor((entry.ts - from) / step) * step; buckets.set(bucket, (buckets.get(bucket) || 0) + 1); });
                buckets.forEach(function (count, ts) { points.push({ ts: ts, value: count, label: '时间桶 ' + (step / 1000).toFixed(1) + ' 秒' }); });
            }
            plotHolder.appendChild(lineChart(points, unit, choose, chartMode === 'activity' ? 'bars' : 'line'));
            statusHolder.textContent = error || (loading ? '正在读取调试记录…' : paused ? '跟随已暂停。新记录仍在接收，恢复后更新视图。' : '实时跟随 · 当前窗口 ' + fmt(data.length) + ' 条记录' + (isVisitor() ? '' : '，含已提交的世界事务'));
            statusHolder.classList.toggle('insight-error', !!error);
            renderList();
            renderDetails();
        }
        function renderList() {
            var scroll = list.scrollTop;
            list.textContent = '';
            var data = filtered();
            list.appendChild(el('div', { cls: 'insight-list-head' }, [el('span', { text: '事件流' }), el('span', { text: '最新在上 · ' + data.length })]));
            if (!data.length)
                list.appendChild(empty(loading ? '正在读取事件' : '没有匹配的记录', query || sourceFilter !== 'all' || levelFilter !== 'all' ? '试着调整搜索条件或筛选来源。' : '启动世界后，真实的调用与事务会出现在这里。'));
            data.slice(0, 500).forEach(function (entry) {
                var ms = latency(entry), tokens = tokenValue(entry);
                var row = el('button', { type: 'button', cls: 'insight-event-row ' + (String(entry.id) === selected ? 'selected ' : '') + 'insight-level-' + entry.level, onclick: function () { choose(entry); } }, [
                    el('span', { cls: 'insight-event-dot' }), el('div', { cls: 'insight-event-body' }, [el('div', { cls: 'insight-event-meta' }, [el('span', { cls: 'insight-event-kind', text: entry.kind }), el('time', { text: clock(entry.ts), title: new Date(entry.ts).toLocaleString() })]), el('strong', { text: entry.label }),
                        el('div', { cls: 'insight-event-tags' }, [el('span', { text: entry.level }), ms !== null ? el('span', { text: (ms / 1000).toFixed(2) + ' s' }) : null, tokens !== null ? el('span', { text: compact(tokens) + ' tok' }) : null, entry.bus ? el('span', { text: '序列 ' + entry.bus.sequence }) : null])])
                ]);
                list.appendChild(row);
            });
            if (data.length > 500)
                list.appendChild(el('p', { cls: 'insight-note', text: '显示最近 500 条；导出包含当前筛选中的全部已加载记录。' }));
            list.scrollTop = scroll;
        }
        function renderDetails() {
            detail.textContent = '';
            var entry = current().find(function (item) { return String(item.id) === selected; });
            if (!entry) {
                detail.appendChild(empty('把过程展开看', '选择一条事件，查看原始内容、时间与可追溯的因果关系。'));
                return;
            }
            detail.appendChild(el('div', { cls: 'insight-detail-head' }, [el('span', { cls: 'insight-kicker', text: 'EVENT / INSPECT' }), el('h2', { text: entry.label }), el('p', { text: clock(entry.ts, true) + ' · ' + entry.kind })]));
            var data = entry.bus || parse(entry.detail), refs = [];
            ['causationId', 'correlationId', 'actorId', 'ref', 'refToolCallId'].forEach(function (field) { if (data[field])
                refs.push([field, data[field]]); });
            var metadata = el('dl', { cls: 'insight-detail-meta' });
            [['记录 ID', entry.bus ? entry.bus.id : entry.id], ['级别', entry.level]].concat(refs).forEach(function (pair) { metadata.appendChild(el('div', {}, [el('dt', { text: pair[0] }), el('dd', { text: String(pair[1]) })])); });
            detail.appendChild(metadata);
            if (entry.bus) {
                var bus = entry.bus, linked = current().filter(function (candidate) { var other = candidate.bus; return other && other.id !== bus.id && (other.id === bus.causationId || other.causationId === bus.id || (bus.correlationId && other.correlationId === bus.correlationId)); });
                var links = el('div', { cls: 'insight-causal-links' }, [el('h3', { text: '因果轨迹' })]);
                if (!linked.length)
                    links.appendChild(el('p', { cls: 'insight-note', text: '当前加载窗口中没有其他关联事件。' }));
                linked.slice(0, 15).forEach(function (other) { links.appendChild(btn((other.bus.id === bus.causationId ? '上游 → ' : other.bus.causationId === bus.id ? '下游 ← ' : '同一链路 · ') + other.bus.topic, function () { choose(other); }, 'insight-causal-link')); });
                links.appendChild(btn('在世界结构中查看 ↗', function () { Studio.navigate('world'); window.dispatchEvent(new CustomEvent('studio:focus-world-event', { detail: { eventId: bus.id, sequence: bus.sequence, actorId: bus.actorId } })); }, 'insight-world-link'));
                detail.appendChild(links);
            }
            var copy = btn('复制原始内容', function () { if (!navigator.clipboard)
                return toast('当前浏览器不可使用剪贴板，请从下方选取文本。', 'warn'); navigator.clipboard.writeText(pretty(entry.bus || entry.detail)).then(function () { toast('已复制', 'ok'); }).catch(showErr); }, 'insight-outline');
            detail.appendChild(el('div', { cls: 'insight-raw-head' }, [el('h3', { text: '原始记录' }), copy]));
            detail.appendChild(el('pre', { cls: 'insight-raw', text: pretty(entry.bus || entry.detail), tabindex: '0' }));
        }
        function onDebug(event) { var entry = event.detail; if (!entry || entry.id === undefined)
            return; ingest([entry]); if (paused)
            waiting++; schedule(); }
        function refresh() {
            if (!alive || refreshing)
                return;
            refreshing = true;
            var requests = [api('GET', '/api/debug?n=500').then(function (result) { if (alive)
                    ingest(result.entries); })];
            if (!isVisitor())
                requests.push(api('GET', '/api/world/state').then(function (result) {
                    if (!alive)
                        return;
                    ingest(((result.state && result.state.events) || []).map(function (event) { return { id: 'bus:' + event.id, ts: event.emittedAt, kind: event.topic, label: event.topic + (event.actorId ? ' · ' + event.actorId : ''), detail: JSON.stringify(event), level: 'info', bus: event }; }));
                }));
            Promise.allSettled(requests).then(function (results) { if (!alive)
                return; loading = false; error = results[0].status === 'rejected' ? results[0].reason.message || String(results[0].reason) : ''; if (paused)
                updatePause();
            else
                render(); }).finally(function () { refreshing = false; });
        }
        window.addEventListener('studio:debug', onDebug);
        window.addEventListener('studio:refresh', refresh);
        render();
        refresh();
        timer = setInterval(refresh, 12000);
        return function () { alive = false; clearInterval(timer); clearTimeout(renderTimer); window.removeEventListener('studio:debug', onDebug); window.removeEventListener('studio:refresh', refresh); };
    });
    function stackedChart(buckets) {
        if (!buckets.length || !buckets.some(function (bucket) { return bucket.totals.totalTokens > 0; }))
            return empty('还没有 Token 用量', '这里会按实际请求展示输入、输出和缓存命中的变化。');
        var W = 800, H = 245, L = 48, R = 15, T = 20, B = 38, max = Math.max.apply(null, buckets.map(function (bucket) { return bucket.totals.totalTokens || 0; })) * 1.12;
        var chart = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, cls: 'insight-chart-svg', role: 'img', 'aria-label': '按时间统计的输入、缓存命中与输出 Token 堆积柱状图' });
        function y(value) { return H - B - value / max * (H - T - B); }
        for (var i = 0; i < 4; i++) {
            var value = max * i / 3;
            chart.appendChild(svg('line', { x1: L, y1: y(value), x2: W - R, y2: y(value), stroke: 'var(--line)', 'stroke-dasharray': i ? '3 5' : '' }));
            chart.appendChild(svg('text', { x: L - 8, y: y(value) + 3, 'text-anchor': 'end', 'font-size': '9', fill: 'var(--fg-dim)', text: compact(value) }));
        }
        var minTime = buckets[0].ts, maxTime = buckets[buckets.length - 1].ts, minStep = Infinity;
        for (var j = 1; j < buckets.length; j++)
            if (buckets[j].ts > buckets[j - 1].ts)
                minStep = Math.min(minStep, buckets[j].ts - buckets[j - 1].ts);
        if (!Number.isFinite(minStep))
            minStep = 3600000;
        var span = Math.max(minStep, maxTime - minTime + minStep), barWidth = Math.max(2, Math.min(32, (W - L - R) * minStep / span * .61));
        function x(ts) { return L + (ts - minTime + minStep / 2) / span * (W - L - R); }
        buckets.forEach(function (bucket, index) {
            var totals = bucket.totals, cached = Math.min(totals.cachedTokens || 0, totals.promptTokens || 0), parts = [Math.max(0, (totals.promptTokens || 0) - cached), cached, totals.completionTokens || 0], offset = 0;
            parts.forEach(function (amount, part) {
                if (amount > 0) {
                    var rect = svg('rect', { x: x(bucket.ts) - barWidth / 2, y: y(offset + amount), width: barWidth, height: y(offset) - y(offset + amount), rx: 1.5, fill: ['var(--accent)', 'var(--insight-cache)', 'var(--accent2)'][part] });
                    rect.appendChild(svg('title', { text: (bucket.tooltipLabel || bucket.label) + ' · ' + ['未缓存输入', '缓存命中', '输出'][part] + ' ' + fmt(amount) + ' tokens · 总计 ' + fmt(totals.totalTokens) }));
                    chart.appendChild(rect);
                }
                offset += amount;
            });
            if (index === 0 || index === buckets.length - 1 || index % Math.max(1, Math.ceil(buckets.length / 5)) === 0)
                chart.appendChild(svg('text', { x: x(bucket.ts), y: H - 12, 'text-anchor': index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle', 'font-size': '9', fill: 'var(--fg-dim)', text: bucket.label }));
        });
        return chart;
    }
    function zeroTotals() { return { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 }; }
    Studio.register('usage', function (container) {
        var alive = true, data = null, range = 'hour', dimension = 'label', selected = '', filterType = '', error = '', loading = false, timer;
        var root = el('div', { cls: 'insight-page insight-usage' });
        container.appendChild(root);
        var header = heading('让消耗变得清晰。', '把每次模型调用放回时间中，观察输入、输出与缓存的实际用量。', 'OBSERVATORY / TOKEN ECONOMY');
        header.appendChild(el('div', { cls: 'insight-header-actions' }, [btn('刷新', refresh), btn('导出明细', function () { if (data)
                download('world-usage-' + new Date().toISOString().slice(0, 10) + '.json', { exportedAt: new Date().toISOString(), summary: data.summary, filter: { type: filterType, value: selected }, entries: records() }); }, 'insight-outline')]));
        root.appendChild(header);
        var body = el('div');
        root.appendChild(body);
        function records() { return ((data && data.entries) || []).filter(function (entry) { return !selected || entry[filterType] === selected; }); }
        function choose(type, value) { selected = selected === value && filterType === type ? '' : value; filterType = type; render(); }
        function buckets() {
            if (!data)
                return [];
            if (!selected)
                return range === 'hour' ? (data.summary.byHour || []).map(function (bucket) { return { label: new Date(bucket.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), tooltipLabel: bucket.hour, ts: bucket.ts, totals: bucket.totals }; }) : (data.summary.byDay || []).slice(0, 14).reverse().map(function (bucket) { return { label: bucket.day.slice(5), ts: Date.parse(bucket.day), totals: bucket.totals }; });
            var map = new Map();
            records().forEach(function (entry) {
                var stamp = range === 'hour' ? Math.floor(entry.ts / 3600000) * 3600000 : new Date(entry.ts).setHours(0, 0, 0, 0);
                if (range === 'hour' && stamp < Date.now() - 48 * 3600000)
                    return;
                if (!map.has(stamp))
                    map.set(stamp, zeroTotals());
                var total = map.get(stamp);
                total.requests++;
                ['promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens'].forEach(function (key) { total[key] += Number(entry[key]) || 0; });
            });
            return Array.from(map.entries()).sort(function (a, b) { return a[0] - b[0]; }).map(function (pair) { return { ts: pair[0], label: new Date(pair[0]).toLocaleString('zh-CN', range === 'hour' ? { month: '2-digit', day: '2-digit', hour: '2-digit' } : { month: '2-digit', day: '2-digit' }), totals: pair[1] }; });
        }
        function render() {
            if (!alive)
                return;
            body.textContent = '';
            if (!data) {
                body.appendChild(empty(error ? '用量暂时不可用' : '正在读取用量', error || '读取真实请求记录与累计统计。'));
                return;
            }
            if (error)
                body.appendChild(el('p', { cls: 'insight-error', role: 'status', text: error }));
            var summary = data.summary || {}, totals = selected ? ((filterType === 'label' ? summary.byLabel : summary.byModel) || {})[selected] || zeroTotals() : summary.totals || zeroTotals();
            var ratio = totals.cacheReportedPromptTokens > 0 ? Math.min(100, (totals.cachedTokens || 0) / totals.cacheReportedPromptTokens * 100) : null;
            var metrics = el('div', { cls: 'insight-metrics insight-metrics-four' }, [metric('累计 TOKEN', compact(totals.totalTokens || 0), fmt(totals.totalTokens || 0) + ' tokens', 'insight-metric-primary'), metric('模型请求', fmt(totals.requests || 0), selected ? selected : '所有模型与来源'), metric('输入 / 输出', compact(totals.promptTokens || 0) + ' / ' + compact(totals.completionTokens || 0), '输入含已命中的缓存'), metric('已上报缓存命中率', ratio === null ? '—' : ratio.toFixed(1) + '%', ratio === null ? '后端尚无可计算的缓存数据' : (totals.cacheMissRecords ? fmt(totals.cacheMissRecords) + ' 次请求未上报缓存信息' : '分母仅含有缓存报告的输入'))]);
            body.appendChild(metrics);
            if (selected)
                body.appendChild(el('div', { cls: 'insight-filter-banner' }, [el('span', { text: '正在查看 ' + (filterType === 'label' ? '来源' : '模型') + '：' + selected }), btn('清除筛选 ×', function () { selected = ''; filterType = ''; render(); }, 'insight-outline')]));
            var chart = el('section', { cls: 'insight-panel insight-usage-chart' });
            var tabs = el('div', { cls: 'insight-tabs' }, [btn('最近 48 小时', function () { range = 'hour'; render(); }, range === 'hour' ? 'insight-active' : ''), btn('按日', function () { range = 'day'; render(); }, range === 'day' ? 'insight-active' : '')]);
            chart.appendChild(el('div', { cls: 'insight-panel-head' }, [el('div', {}, [el('h2', { text: '消耗随时间变化' }), el('p', { text: selected ? '筛选曲线仅来自最近 ' + data.entries.length + ' 条可用明细；累计卡片为全程统计。' : range === 'hour' ? '最近 48 小时 · 按真实请求明细统计' : '最近 14 个有记录的日期 · 累计日统计' })]), tabs]));
            chart.appendChild(stackedChart(buckets()));
            chart.appendChild(el('div', { cls: 'insight-legend' }, [['input', '未缓存输入'], ['cache', '缓存命中'], ['output', '输出']].map(function (pair) { return el('span', { cls: 'insight-legend-' + pair[0] }, [el('i'), el('span', { text: pair[1] })]); })));
            body.appendChild(chart);
            var lower = el('div', { cls: 'insight-usage-lower' });
            var breakdown = el('section', { cls: 'insight-panel insight-breakdown' });
            breakdown.appendChild(el('div', { cls: 'insight-panel-head' }, [el('h2', { text: '消耗构成' }), select([['label', '按来源'], ['model', '按模型']], dimension, function (value) { dimension = value; render(); }, '统计维度')]));
            var aggregate = (dimension === 'label' ? summary.byLabel : summary.byModel) || {}, pairs = Object.entries(aggregate).sort(function (a, b) { return b[1].totalTokens - a[1].totalTokens; }), denominator = (summary.totals && summary.totals.totalTokens) || 1;
            if (!pairs.length)
                breakdown.appendChild(empty('还没有来源记录', '模型开始调用后，这里将展示各来源的实际份额。'));
            pairs.forEach(function (pair, index) {
                var share = pair[1].totalTokens / denominator * 100;
                var row = el('button', { type: 'button', cls: 'insight-breakdown-row ' + (selected === pair[0] && filterType === dimension ? 'selected' : ''), onclick: function () { choose(dimension, pair[0]); } }, [el('div', {}, [el('strong', { text: pair[0] }), el('span', { text: compact(pair[1].totalTokens) + ' · ' + share.toFixed(1) + '%' })]), el('div', { cls: 'insight-track' }, [el('span', { style: 'width:' + Math.max(0, Math.min(100, share)) + '%;background:' + (index % 2 ? 'var(--accent2)' : 'var(--accent)') })]), el('small', { text: fmt(pair[1].requests) + ' 次请求' })]);
                breakdown.appendChild(row);
            });
            lower.appendChild(breakdown);
            var tablePanel = el('section', { cls: 'insight-panel insight-request-panel' }), recs = records().slice().reverse();
            tablePanel.appendChild(el('div', { cls: 'insight-panel-head' }, [el('div', {}, [el('h2', { text: '最近的调用' }), el('p', { text: '显示最近 ' + Math.min(recs.length, 80) + ' 条 · 输入与输出均为 tokens' })])]));
            if (!recs.length)
                tablePanel.appendChild(empty('暂无匹配请求', '有用量记录后，这里会展示每次调用的真实明细。'));
            else {
                var table = el('table', { cls: 'insight-usage-table' }), tbody = el('tbody');
                table.appendChild(el('thead', {}, [el('tr', {}, ['时间 / 来源', '输入', '输出', '缓存'].map(function (label) { return el('th', { scope: 'col', text: label }); }))]));
                recs.slice(0, 80).forEach(function (entry) { tbody.appendChild(el('tr', {}, [el('td', {}, [el('strong', { text: entry.label }), el('time', { text: clock(entry.ts, true) }), el('span', { cls: 'insight-model-name', text: entry.model, title: entry.model })]), el('td', { text: fmt(entry.promptTokens) }), el('td', { text: fmt(entry.completionTokens) }), el('td', { cls: entry.cacheReported ? '' : 'insight-unreported', text: entry.cacheReported ? fmt(entry.cachedTokens || 0) : '未上报' })])); });
                table.appendChild(tbody);
                tablePanel.appendChild(el('div', { cls: 'insight-table-scroll' }, [table]));
            }
            lower.appendChild(tablePanel);
            body.appendChild(lower);
            body.appendChild(el('p', { cls: 'insight-note insight-data-note', text: '数字来自后端用量记录，不以字符数估算 Token。缓存未上报时显示未知；累计统计不受明细窗口裁剪影响。' }));
        }
        function refresh() { if (!alive || loading)
            return; loading = true; api('GET', '/api/usage?n=500').then(function (result) { if (!alive)
            return; data = result; error = ''; render(); }).catch(function (err) { if (!alive)
            return; error = err.message || String(err); render(); }).finally(function () { loading = false; }); }
        window.addEventListener('studio:refresh', refresh);
        render();
        refresh();
        timer = setInterval(refresh, 15000);
        return function () { alive = false; clearInterval(timer); window.removeEventListener('studio:refresh', refresh); };
    });
})();
