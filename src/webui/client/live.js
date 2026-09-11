/* Long-lived metadata collection; mount/unmount only attaches or detaches readers. */
(function () {
    'use strict';
    var calls = new Map(), raw = new Map(), listeners = new Set(), request = null, error = '', connected = null, epoch = 0, refreshTimer = null;
    var selection = { id: null, follow: true, tab: 'response', source: 'all', search: '', wrap: true }, detailFlight = new Map(), lastPull = 0, eventSerial = 0, eventSeen = new Map();
    function allowed() { return !isVisitor() || visitorCanSee(['debug']); }
    function active(call) { return call && !call.missing && (call.status === 'pending' || call.status === 'streaming'); }
    function ordered() { return Array.from(calls.values()).sort(function (a, b) { return a.startedAt - b.startedAt || a.callId.localeCompare(b.callId); }); }
    function emit() { listeners.forEach(function (fn) { try {
        fn();
    }
    catch (e) {
        console.error('Live calls render', e);
    } }); }
    function source(call) { return /^bot/i.test(call.source) ? 'Bot' : /^world/i.test(call.source) ? 'World' : '其他'; }
    function status(call) { if (call.missing)
        return '已移出缓存'; return { pending: '等待响应', streaming: '正在生成', completed: '已完成', error: '失败', cancelled: '已取消' }[call.status] || call.status; }
    function bytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B'; }
    function elapsed(call) { var ms = (call.endedAt || Date.now()) - call.startedAt; return ms >= 60000 ? (ms / 60000).toFixed(1) + ' 分钟' : (Math.max(0, ms) / 1000).toFixed(1) + ' 秒'; }
    function stamp(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    function upsert(value) {
        if (!value || typeof value.callId !== 'string')
            return;
        var previous = calls.get(value.callId);
        if (previous && previous.revision > value.revision)
            return;
        calls.set(value.callId, value);
        var list = ordered();
        while (calls.size > 200 && list.length) {
            var oldest = list.shift();
            if (oldest.callId !== selection.id) {
                calls.delete(oldest.callId);
                eventSeen.delete(oldest.callId);
                raw.delete(oldest.callId);
            }
        }
        if (selection.follow && (!selection.id || !calls.has(selection.id) || value.startedAt >= (calls.get(selection.id).startedAt || 0)))
            selection.id = ordered().at(-1)?.callId || null;
    }
    function forget() { epoch++; calls.clear(); raw.clear(); eventSeen.clear(); eventSerial = 0; detailFlight.clear(); request = null; selection.id = null; error = ''; }
    function refresh() {
        if (!allowed()) {
            forget();
            emit();
            return Promise.resolve();
        }
        if (request)
            return request;
        var token = epoch, serial = eventSerial;
        request = api('GET', '/api/calls').then(function (result) { if (token !== epoch)
            return; error = ''; var present = new Set((result.calls || []).map(function (c) { return c.callId; })); calls.forEach(function (c, id) { if (!present.has(id) && (eventSeen.get(id) || 0) <= serial)
            c.missing = true; }); (result.calls || []).forEach(upsert); lastPull = Date.now(); emit(); }).catch(function (err) { if (token !== epoch)
            return; error = err.message || String(err); emit(); }).finally(function () { if (token === epoch)
            request = null; });
        return request;
    }
    function pruneRaw() { var entries = Array.from(raw.entries()), total = entries.reduce(function (n, p) { return n + (p[1].request?.length || 0) + (p[1].response?.length || 0); }, 0); for (var pair of entries) {
        if (total < 12 * 1024 * 1024 && raw.size <= 5)
            break;
        if (pair[0] === selection.id)
            continue;
        total -= (pair[1].request?.length || 0) + (pair[1].response?.length || 0);
        raw.delete(pair[0]);
    } }
    function fetchDetail(id, force) {
        if (!id || !allowed())
            return Promise.resolve();
        if (detailFlight.has(id))
            return detailFlight.get(id);
        var cached = raw.get(id), meta = calls.get(id);
        if (!force && cached && meta && cached.revision >= meta.revision)
            return Promise.resolve(cached);
        var token = epoch, offset = cached && cached.response ? cached.response.length : 0, includeRequest = !cached || cached.request === undefined;
        var pending = api('GET', '/api/calls/' + encodeURIComponent(id) + '?after=' + offset + '&request=' + (includeRequest ? '1' : '0')).then(function (result) {
            if (token !== epoch)
                return;
            upsert(result.call);
            var item = raw.get(id) || { response: '', revision: 0 };
            if (Object.prototype.hasOwnProperty.call(result, 'requestBody'))
                item.request = result.requestBody;
            if (result.responseText === null) {
                item.unavailable = result.call.rawUnavailableReason || '原始数据已不可用';
            }
            else {
                if (result.reset || result.responseOffset !== item.response.length)
                    item.response = '';
                item.response += result.responseText;
                item.unavailable = '';
            }
            item.revision = result.call.revision;
            item.error = '';
            item.nextRetry = 0;
            raw.delete(id);
            raw.set(id, item);
            pruneRaw();
            emit();
            return item;
        }).catch(function (err) { if (token !== epoch)
            return; var item = raw.get(id) || { response: '', revision: 0 }; item.error = err.message || String(err); item.nextRetry = Date.now() + 5000; raw.set(id, item); emit(); }).finally(function () { if (detailFlight.get(id) === pending)
            detailFlight.delete(id); });
        detailFlight.set(id, pending);
        return pending;
    }
    window.addEventListener('studio:debug', function (event) { if (!allowed())
        return; var entry = event.detail; if (entry?.kind !== 'llm.call')
        return; try {
        var meta = typeof entry.detail === 'string' ? JSON.parse(entry.detail) : entry.detail;
        eventSeen.set(meta.callId, ++eventSerial);
        upsert(meta);
        emit();
    }
    catch (_) { /* legacy capped debug entries are not treated as full calls */ } });
    window.addEventListener('studio:connection', function (event) { connected = !!event.detail?.connected; emit(); if (connected)
        refresh(); });
    window.addEventListener('studio:refresh', function () { if (listeners.size)
        refresh(); });
    window.addEventListener('studio:auth', function () { forget(); connected = null; emit(); });
    function watch(fn) { listeners.add(fn); if (!refreshTimer)
        refreshTimer = setInterval(function () { if (listeners.size && !document.hidden && Date.now() - lastPull > 7000)
            refresh(); }, 8000); refresh(); return function () { listeners.delete(fn); if (!listeners.size) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    } }; }
    function button(text, run, cls) { return el('button', { type: 'button', cls: cls || 'live-button', text: text, onclick: run }); }
    function badge(call) { return el('span', { cls: 'live-status live-status-' + call.status, text: status(call) }); }
    function empty(text) { return el('div', { cls: 'live-empty', text: text }); }
    function heading() { return el('div', { cls: 'live-page-heading' }, [el('div', {}, [el('span', { cls: 'live-eyebrow', text: 'OBSERVATORY / LIVE' }), el('h1', { text: '运行洞察' }), el('p', { text: '实时看见思考发生，再沿着原始调用与事件追踪结果。' })])]); }
    function mount(container, options) {
        options = options || {};
        if (!allowed()) {
            container.appendChild(empty('当前账号没有查看原始调用的权限。'));
            return function () { };
        }
        var compact = !!options.compact, alive = true, scheduled = null, detailTimer = null, selectedKey = '', drawn = '', lastRevision = 0, rowNodes = new Map();
        var root = el('section', { cls: 'live-calls' + (compact ? ' live-compact' : '') }), head = compact ? el('div', { cls: 'live-compact-heading' }, [el('h3', { text: '此刻，系统在做什么' }), button('查看调用', function () { Studio.navigate('live'); }, 'live-link')]) : heading();
        var connection = el('div', { cls: 'live-connection', 'aria-live': 'polite' }), lanes = el('div', { cls: 'live-lanes' }), notice = el('div', { cls: 'live-notice', 'aria-live': 'polite' });
        root.append(head, connection, lanes, notice);
        container.appendChild(root);
        var insightsCleanup = null, showCallPanel = null;
        var timeline = null, detail = null, requestButton = null, responseButton = null, followButton = null, code = null, detailMeta = null, rawNotice = null, copyButton = null, wrapButton = null, count = null;
        if (!compact) {
            var workspace = el('div', { id: 'observatory-calls', role: 'tabpanel', 'aria-labelledby': 'observatory-tab-calls' }), insightHost = el('div', { id: 'observatory-events', role: 'tabpanel', 'aria-labelledby': 'observatory-tab-events', hidden: true });
            var sectionTabs = el('div', { cls: 'observatory-tabs', role: 'tablist', 'aria-label': '运行洞察内容' });
            var callTab = button('调用原文', function () { switchPanel(false); }), eventTab = button('事件与图表', function () { switchPanel(true); });
            [callTab, eventTab].forEach(function (tab, i) { tab.id = 'observatory-tab-' + (i ? 'events' : 'calls'); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', i ? insightHost.id : workspace.id); tab.setAttribute('aria-selected', String(!i)); tab.tabIndex = i ? -1 : 0; tab.onkeydown = function (event) { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); var next = event.key === 'Home' ? false : event.key === 'End' ? true : !i; switchPanel(next); (next ? eventTab : callTab).focus(); } }; });
            function switchPanel(events) { workspace.hidden = events; insightHost.hidden = !events; callTab.setAttribute('aria-selected', String(!events)); eventTab.setAttribute('aria-selected', String(events)); callTab.tabIndex = events ? -1 : 0; eventTab.tabIndex = events ? 0 : -1; if (events && !insightsCleanup) insightsCleanup = window.RuntimeInsights.mount(insightHost); }
            showCallPanel = function () { switchPanel(false); };
            sectionTabs.append(callTab, eventTab);
            root.append(sectionTabs, workspace, insightHost);
            var toolbar = el('div', { cls: 'live-toolbar' }), filter = el('select', { 'aria-label': '调用来源', cls: 'live-filter' }, [['all', '全部调用'], ['Bot', 'Bot'], ['World', 'World'], ['其他', '其他']].map(function (pair) { return el('option', { value: pair[0], text: pair[1], selected: selection.source === pair[0] }); }));
            filter.onchange = function () { selection.source = filter.value; render(); };
            var search = el('input', { type: 'search', cls: 'live-search', placeholder: '搜索模型、调用 ID 或状态…', 'aria-label': '搜索调用', value: selection.search });
            search.oninput = function () { selection.search = search.value; render(); };
            followButton = button('', function () { selection.follow = !selection.follow; if (selection.follow)
                selection.id = ordered().at(-1)?.callId || null; render(); }, 'live-button live-follow');
            toolbar.append(filter, search, followButton, button('同步', refresh));
            workspace.appendChild(toolbar);
            var grid = el('div', { cls: 'live-workbench' }), history = el('div', { cls: 'live-history' });
            count = el('div', { cls: 'live-history-heading' });
            timeline = el('div', { cls: 'live-timeline', role: 'list', 'aria-label': '按时间排列的模型调用' });
            history.append(count, timeline);
            detail = el('div', { cls: 'live-detail' });
            detailMeta = el('div', { cls: 'live-detail-meta' });
            var tabs = el('div', { cls: 'live-raw-tabs', role: 'tablist', 'aria-label': '原始数据类型' });
            requestButton = button('原始请求', function () { selection.tab = 'request'; render(); }, 'live-raw-tab');
            responseButton = button('原始返回', function () { selection.tab = 'response'; render(); }, 'live-raw-tab');
            [requestButton, responseButton].forEach(function (b) { b.setAttribute('role', 'tab'); });
            copyButton = button('复制', async function () { var item = raw.get(selection.id), text = selection.tab === 'request' ? item?.request : item?.response; if (typeof text !== 'string')
                return; try {
                await navigator.clipboard.writeText(text);
                toast('已复制' + (item.unavailable ? '本地已缓存部分' : '原始' + (selection.tab === 'request' ? '请求' : '返回')), 'ok');
            }
            catch (err) {
                toast('无法访问剪贴板，请在正文中选择并复制。', 'err');
            } }, 'live-button');
            wrapButton = button('自动折行', function () { selection.wrap = !selection.wrap; render(); }, 'live-button');
            tabs.append(requestButton, responseButton, wrapButton, copyButton);
            rawNotice = el('div', { cls: 'live-raw-notice', 'aria-live': 'polite' });
            code = el('pre', { cls: 'live-raw-code', tabindex: '0', 'aria-label': '调用原始数据' });
            detail.append(detailMeta, tabs, rawNotice, code);
            grid.append(history, detail);
            workspace.append(grid, el('p', { cls: 'live-retention', text: '原始数据仅保存在服务端内存：最多 200 次调用、合计 32 MB、单次 8 MB。超限会明确显示不可用；普通调试摘要与事务可在本页「事件与图表」查看。' }));
            timeline.addEventListener('wheel', function () { if (selection.follow) {
                selection.follow = false;
                render();
            } }, { passive: true });
        }
        function schedule() { if (!alive || scheduled)
            return; scheduled = setTimeout(function () { scheduled = null; render(); }, 100); }
        function renderLanes(list) {
            ['Bot', 'World'].forEach(function (who) {
                var lane = lanes.querySelector('[data-live-source="' + who + '"]');
                if (!lane) {
                    lane = el('article', { cls: 'live-lane', 'data-live-source': who }, [el('div', { cls: 'live-lane-heading' }, [el('span', { cls: 'live-source-mark', text: who === 'Bot' ? 'B' : 'W' }), el('strong', { text: who }), el('span', { cls: 'live-lane-state' })]), el('div', { cls: 'live-lane-model' }), el('pre', { cls: 'live-lane-preview' }), el('div', { cls: 'live-lane-footer' })]);
                    lanes.appendChild(lane);
                }
                var matching = list.filter(function (c) { return source(c) === who; }), call = matching.filter(active).at(-1) || matching.at(-1), pending = matching.filter(active).length;
                lane.dataset.state = call?.status || 'empty';
                lane.querySelector('.live-lane-state').textContent = call ? status(call) : '暂无调用';
                lane.querySelector('.live-lane-model').textContent = call ? call.model + (pending > 1 ? ' · ' + pending + ' 个并发调用' : '') : who === 'Bot' ? '角色的判断与行动' : '环境的演化与裁定';
                var preview = lane.querySelector('.live-lane-preview'), next = call ? (call.preview || (call.status === 'pending' ? '请求已发送，正在等待真实响应。' : call.status === 'streaming' ? '已收到原始响应片段；点击查看流内容。' : call.error || '本次调用没有可显示的正文。')) : '还没有收到 ' + who + ' 的调用事件。';
                if (preview.textContent !== next) {
                    preview.textContent = next;
                    if (selection.follow)
                        preview.scrollTop = preview.scrollHeight;
                }
                var footer = lane.querySelector('.live-lane-footer');
                footer.replaceChildren();
                if (call) {
                    footer.append(el('span', { text: (call.httpStatus ? 'HTTP ' + call.httpStatus + ' · ' : '') + elapsed(call) + ' · ' + bytes(call.responseBytes) }), button('查看', function () { selection.id = call.callId; selection.follow = false; if (compact)
                        Studio.navigate('live');
                    else {
                        showCallPanel(); render();
                    } }, 'live-link'));
                }
            });
        }
        function render() {
            if (!alive)
                return;
            root.hidden = !allowed();
            if (!allowed()) {
                code && (code.textContent = '');
                return;
            }
            var list = ordered();
            connection.textContent = connected === false ? '连接已中断 · 保留最后收到的状态' : connected === true ? '实时事件已连接' : '等待实时连接状态';
            connection.className = 'live-connection' + (connected === false ? ' live-connection-off' : '');
            renderLanes(list);
            notice.textContent = error ? '读取调用失败：' + error : '';
            if (compact)
                return;
            followButton.textContent = selection.follow ? '暂停跟随' : '继续跟随';
            followButton.setAttribute('aria-pressed', String(selection.follow));
            var filtered = list.filter(function (c) { return (selection.source === 'all' || source(c) === selection.source) && (!selection.search || [c.source, c.model, c.callId, c.status, c.error || ''].join(' ').toLowerCase().includes(selection.search.toLowerCase())); });
            count.textContent = '时间轴 · ' + filtered.length + ' 次调用 · ' + list.filter(active).length + ' 个未结束';
            var ids = new Set(filtered.map(function (c) { return c.callId; }));
            rowNodes.forEach(function (node, id) { if (!ids.has(id)) {
                node.remove();
                rowNodes.delete(id);
            } });
            timeline.querySelector('.live-empty')?.remove();
            filtered.forEach(function (call) {
                var row = rowNodes.get(call.callId);
                if (!row) {
                    row = el('button', { type: 'button', cls: 'live-call-row', role: 'listitem', 'data-call-id': call.callId, onclick: function () { selection.id = call.callId; selection.follow = false; render(); } }, [el('div', { cls: 'live-call-top' }), el('strong', { cls: 'live-call-model' }), el('div', { cls: 'live-call-bottom' })]);
                    rowNodes.set(call.callId, row);
                    timeline.appendChild(row);
                }
                row.classList.toggle('live-call-selected', call.callId === selection.id);
                row.setAttribute('aria-current', call.callId === selection.id ? 'true' : 'false');
                row.querySelector('.live-call-top').replaceChildren(el('span', { text: call.source }), badge(call));
                row.querySelector('.live-call-model').textContent = call.model;
                row.querySelector('.live-call-bottom').textContent = stamp(call.startedAt) + ' · ' + elapsed(call) + ' · ' + bytes(call.responseBytes);
            });
            // Existing row nodes retain focus/scroll; only reorder if a late initial snapshot introduced older calls.
            filtered.forEach(function (c, index) { var row = rowNodes.get(c.callId); if (timeline.children[index] !== row)
                timeline.insertBefore(row, timeline.children[index] || null); });
            if (!filtered.length)
                timeline.appendChild(empty(list.length ? '没有匹配的调用。' : '尚无调用记录。下一次实际请求开始后会出现在这里。'));
            if (selection.follow)
                timeline.scrollTop = timeline.scrollHeight;
            renderDetail();
        }
        function renderDetail() {
            var call = calls.get(selection.id), item = raw.get(selection.id);
            requestButton.setAttribute('aria-selected', String(selection.tab === 'request'));
            responseButton.setAttribute('aria-selected', String(selection.tab === 'response'));
            wrapButton.setAttribute('aria-pressed', String(selection.wrap));
            code.classList.toggle('live-nowrap', !selection.wrap);
            if (!call) {
                detailMeta.textContent = '选择一次调用';
                rawNotice.textContent = '原始请求和返回将显示在这里。';
                code.textContent = '';
                copyButton.disabled = true;
                return;
            }
            detailMeta.replaceChildren(el('div', {}, [el('strong', { text: call.source + ' · ' + call.model }), badge(call)]), el('small', { text: '开始 ' + stamp(call.startedAt) + ' · ' + elapsed(call) + ' · ' + call.callId }), el('small', { text: call.url }));
            var key = selection.id + ':' + selection.tab, text = selection.tab === 'request' ? item?.request : item?.response;
            if (typeof text !== 'string')
                text = '';
            var selectionRange = window.getSelection(), holding = selectionRange && !selectionRange.isCollapsed && code.contains(selectionRange.anchorNode), scroll = code.scrollTop;
            if (key !== selectedKey || !text.startsWith(drawn)) {
                code.textContent = text;
                selectedKey = key;
            }
            else if (text.length > drawn.length)
                code.appendChild(document.createTextNode(text.slice(drawn.length)));
            drawn = text;
            copyButton.disabled = !item || typeof (selection.tab === 'request' ? item.request : item.response) !== 'string';
            if (selection.follow && !holding && selection.tab === 'response')
                code.scrollTop = code.scrollHeight;
            else
                code.scrollTop = scroll;
            rawNotice.textContent = call.missing ? '调用已离开服务端缓存；当前显示浏览器已缓存的数据。' : item?.error ? '读取失败：' + item.error : item?.unavailable ? item.unavailable + (text ? ' · 当前仅显示已在浏览器缓存的部分。' : '') : !call.rawAvailable ? (call.rawUnavailableReason || '原始数据已不可用') : !item ? '正在读取原始数据…' : selection.tab === 'request' ? '实际发送的 JSON 请求体 · ' + bytes(call.requestBytes) + (call.unicodeRepairedStrings ? ' · 已修复 ' + call.unicodeRepairedStrings + ' 处非法 Unicode' : '') : active(call) ? '原始响应正在追加 · ' + bytes(call.responseBytes) + (call.responseFormat ? ' · ' + call.responseFormat : '') : '原始响应 · ' + bytes(call.responseBytes) + (call.responseFormat ? ' · ' + call.responseFormat : '') + (call.error ? ' · ' + call.error : '');
            if (!call.missing && (!item || item.revision < call.revision) && (!item?.nextRetry || Date.now() >= item.nextRetry)) {
                clearTimeout(detailTimer);
                detailTimer = setTimeout(function () { if (alive)
                    fetchDetail(call.callId); }, 150);
            }
            lastRevision = call.revision;
        }
        var unwatch = watch(schedule), clockTimer = setInterval(function () { if (alive && !document.hidden && ordered().some(active))
            schedule(); }, 1000);
        render();
        return function () { alive = false; if (insightsCleanup) insightsCleanup(); unwatch(); clearTimeout(scheduled); clearTimeout(detailTimer); clearInterval(clockTimer); root.remove(); };
    }
    window.LiveCalls = { mount: mount, refresh: refresh };
    Studio.register('live', function (container) { return mount(container); });
})();
