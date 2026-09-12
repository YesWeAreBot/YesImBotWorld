/* Long-lived metadata collection; mount/unmount only attaches or detaches readers. */
(function () {
    'use strict';
    var calls = new Map(), raw = new Map(), listeners = new Set(), request = null, error = '', connected = null, epoch = 0, refreshTimer = null, retention = null;
    var selection = { id: null, follow: true, tab: 'response', manualTabFor: null, format: 'readable', source: 'all', search: '', wrap: true }, detailFlight = new Map(), lastPull = 0, eventSerial = 0, eventSeen = new Map();
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
        var list = ordered().filter(function (call) { return !active(call); }).sort(function (a, b) { return (a.endedAt || a.updatedAt) - (b.endedAt || b.updatedAt); });
        var completedLimit = retention && retention.maxCompletedCalls || 200;
        while (list.length > completedLimit) {
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
    function forget() { epoch++; calls.clear(); raw.clear(); eventSeen.clear(); eventSerial = 0; detailFlight.clear(); request = null; selection.id = null; selection.manualTabFor = null; error = ''; retention = null; }
    function selectCall(id, tab) {
        if (selection.id !== id) selection.manualTabFor = null;
        selection.id = id;
        selection.follow = false;
        if (tab) { selection.tab = tab; selection.manualTabFor = id; }
    }
    function requestPreview(item) {
        if (!item || typeof item.request !== 'string') return '';
        if (item.requestPreview !== undefined) return item.requestPreview;
        var decoded = CallContent.request(item.request), roles = { system: '系统', developer: '开发者', user: '输入与观测', assistant: '模型', tool: '工具回执' };
        item.requestPreview = decoded.error ? '' : (decoded.messages || []).slice(-2).map(function (message) {
            return (roles[message.role] || message.role || '消息') + ' · ' + ReadableData.text(CallAttachments.redact(message.content)).replace(/\s+/g, ' ').slice(0, 240);
        }).join('\n');
        return item.requestPreview;
    }
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
            return; error = ''; retention = result.retention || null; var present = new Set((result.calls || []).map(function (c) { return c.callId; })); calls.forEach(function (c, id) { if (!present.has(id) && (eventSeen.get(id) || 0) <= serial)
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
        var cached = raw.get(id), meta = calls.get(id), includeRequest = selection.id === id && selection.tab === 'request' && (!cached || cached.request === undefined);
        if (!force && !includeRequest && cached && meta && cached.revision >= meta.revision)
            return Promise.resolve(cached);
        var token = epoch, offset = cached && cached.response ? cached.response.length : 0;
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
        var reader = null, reading = null, readableButton = null, rawButton = null, rawFold = null, rawExpanded = false, contentKey = '', retentionNotice = null;
        var timeline = null, detail = null, requestButton = null, responseButton = null, followButton = null, code = null, detailMeta = null, rawNotice = null, copyButton = null, wrapButton = null, count = null;
        if (!compact) {
            var workspace = el('div', { id: 'observatory-calls', role: 'tabpanel', 'aria-labelledby': 'observatory-tab-calls' }), insightHost = el('div', { id: 'observatory-events', role: 'tabpanel', 'aria-labelledby': 'observatory-tab-events', hidden: true });
            var sectionTabs = el('div', { cls: 'observatory-tabs', role: 'tablist', 'aria-label': '运行洞察内容' });
            var callTab = button('调用详情', function () { switchPanel(false); }), eventTab = button('事件与图表', function () { switchPanel(true); });
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
            var tabs = el('div', { cls: 'live-raw-tabs', role: 'tablist', 'aria-label': '调用内容类型' });
            requestButton = button('请求', function () { selection.tab = 'request'; selection.manualTabFor = selection.id; render(); }, 'live-raw-tab');
            responseButton = button('返回', function () { selection.tab = 'response'; selection.manualTabFor = selection.id; render(); }, 'live-raw-tab');
            [requestButton, responseButton].forEach(function (b) { b.setAttribute('role', 'tab'); });
            copyButton = button('复制', async function () { var item = raw.get(selection.id), text = selection.format === 'readable' ? reader.text() : selection.tab === 'request' ? item?.request : item?.response; if (typeof text !== 'string')
                return; try {
                await navigator.clipboard.writeText(text);
                toast(selection.format === 'readable' ? '已复制可读内容' : '已复制' + (item.unavailable ? '本地已缓存部分' : '原始' + (selection.tab === 'request' ? '请求' : '返回')), 'ok');
            }
            catch (err) {
                toast('无法访问剪贴板，请在正文中选择并复制。', 'err');
            } }, 'live-button');
            wrapButton = button('自动折行', function () { selection.wrap = !selection.wrap; render(); }, 'live-button');
            tabs.append(requestButton, responseButton);
            var viewOptions = el('div', { cls: 'live-view-options', role: 'group', 'aria-label': '查看方式' });
            readableButton = button('阅读视图', function () { keepRequest(); selection.format = 'readable'; render(); }, 'live-button live-view-read');
            rawButton = button('原始数据', function () { keepRequest(); selection.format = 'raw'; render(); }, 'live-button live-view-raw');
            viewOptions.append(readableButton, rawButton, wrapButton, copyButton);
            rawNotice = el('div', { cls: 'live-raw-notice', 'aria-live': 'polite' });
            code = el('pre', { cls: 'live-raw-code', tabindex: '0', 'aria-label': '调用原始数据' });
            rawFold = button('', function () { keepRequest(); rawExpanded = !rawExpanded; render(); }, 'live-button live-raw-fold');
            rawFold.hidden = true;
            reading = el('div', { cls: 'live-reading', tabindex: '0', 'aria-label': '可读调用内容' });
            // Reading or opening a request is intentional: a first response must not take it away.
            function keepRequest() { if (selection.tab === 'request') selection.manualTabFor = selection.id; }
            reading.addEventListener('pointerdown', keepRequest);
            reading.addEventListener('keydown', keepRequest);
            reading.addEventListener('wheel', keepRequest, { passive: true });
            code.addEventListener('pointerdown', keepRequest);
            code.addEventListener('keydown', keepRequest);
            code.addEventListener('wheel', keepRequest, { passive: true });
            reader = CallReader.create(reading);
            detail.append(detailMeta, tabs, viewOptions, rawNotice, reading, rawFold, code);
            grid.append(history, detail);
            retentionNotice = el('p', { cls: 'live-retention' });
            workspace.append(grid, retentionNotice);
            timeline.addEventListener('wheel', function () { if (selection.follow) {
                selection.follow = false;
                render();
            } }, { passive: true });
        }
        function readablePreview(value) {
            if (!value) return '';
            try { return ReadableData.text(JSON.parse(value)); } catch (_) { return value; }
        }
        function schedule() { if (!alive || scheduled)
            return; scheduled = setTimeout(function () { scheduled = null; render(); }, 100); }
        function renderLanes(list) {
            ['Bot', 'World'].forEach(function (who) {
                var lane = lanes.querySelector('[data-live-source="' + who + '"]');
                if (!lane) {
                    lane = el('article', { cls: 'live-lane', 'data-live-source': who }, [el('div', { cls: 'live-lane-heading' }, [el('span', { cls: 'live-source-mark', text: who === 'Bot' ? 'B' : 'W' }), el('strong', { text: who + ' LLM' }), el('span', { cls: 'live-lane-state', role: 'status' })]), el('div', { cls: 'live-lane-model' }), el('div', { cls: 'live-lane-preview-kind' }), el('pre', { cls: 'live-lane-preview' }), el('div', { cls: 'live-lane-footer' })]);
                    lanes.appendChild(lane);
                }
                var matching = list.filter(function (c) { return source(c) === who; }), call = matching.filter(active).at(-1) || matching.at(-1), pending = matching.filter(active).length;
                lane.dataset.state = call?.status || 'empty';
                lane.setAttribute('aria-label', who + ' LLM · ' + (call ? status(call) : '暂无调用'));
                lane.querySelector('.live-lane-state').textContent = call ? status(call) : '暂无调用';
                lane.querySelector('.live-lane-model').textContent = call ? call.model + (pending > 1 ? ' · ' + pending + ' 个并发调用' : '') : who === 'Bot' ? '角色的判断与行动' : '环境的演化与裁定';
                var preview = lane.querySelector('.live-lane-preview'), showingRequest = !!call && !call.preview && active(call), next = call ? (readablePreview(call.preview) || (showingRequest ? requestPreview(raw.get(call.callId)) : call.error || '本次调用没有可显示的正文。')) : '';
                var previewKind = lane.querySelector('.live-lane-preview-kind');
                previewKind.textContent = next ? (showingRequest ? '已发送的请求' : '最新返回') : '';
                previewKind.hidden = !next;
                preview.hidden = !next;
                if (preview.textContent !== next) {
                    preview.textContent = next;
                    if (selection.follow)
                        preview.scrollTop = preview.scrollHeight;
                }
                var footer = lane.querySelector('.live-lane-footer');
                footer.replaceChildren();
                if (call) {
                    var links = el('div', { cls: 'live-lane-links' });
                    function open(tab) { selectCall(call.callId, tab); if (compact) Studio.navigate('live'); else { showCallPanel(); render(); } }
                    links.appendChild(button('查看请求', function () { open('request'); }, 'live-link live-lane-request'));
                    if (call.responseBytes || !active(call)) links.appendChild(button('查看返回', function () { open('response'); }, 'live-link live-lane-response'));
                    footer.append(el('span', { text: (call.httpStatus ? 'HTTP ' + call.httpStatus + ' · ' : '') + elapsed(call) + ' · ' + bytes(call.responseBytes) }), links);
                } else {
                    footer.appendChild(el('span', { text: who === 'Bot' ? '等待角色开始行动' : '等待世界发生变化' }));
                }
            });
        }
        function render() {
            if (!alive)
                return;
            root.hidden = !allowed();
            if (!allowed()) {
                code && (code.textContent = '');
                reader && reader.clear();
                return;
            }
            var list = ordered();
            connection.textContent = connected === false ? '连接已中断 · 保留最后收到的状态' : connected === true ? '实时事件已连接' : '等待实时连接状态';
            connection.className = 'live-connection' + (connected === false ? ' live-connection-off' : '');
            renderLanes(list);
            notice.textContent = error ? '读取调用失败：' + error : '';
            if (compact)
                return;
            retentionNotice.textContent = retention && retention.persistent ? '原始请求与返回保存在本机调用记录中，内存仅作缓存。保留最近 ' + retention.maxCalls + ' 次已结束调用；正在生成的调用继续保留。长内容可展开或收起。' : '原始请求与返回按需读取；长内容可以展开或收起。';
            if (retention && retention.storageWarning) retentionNotice.textContent += ' ' + retention.storageWarning;
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
                    row = el('button', { type: 'button', cls: 'live-call-row', role: 'listitem', 'data-call-id': call.callId, onclick: function () { selectCall(call.callId); render(); } }, [el('div', { cls: 'live-call-top' }), el('strong', { cls: 'live-call-model' }), el('div', { cls: 'live-call-bottom' })]);
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
            if (call && selection.manualTabFor !== call.callId) selection.tab = active(call) && !call.preview ? 'request' : 'response';
            detail.dataset.state = call?.status || 'empty';
            responseButton.classList.toggle('live-response-available', !!call?.responseBytes && selection.tab === 'request');
            responseButton.setAttribute('aria-label', call?.responseBytes && selection.tab === 'request' ? '返回 · 已有模型内容' : '返回');
            requestButton.setAttribute('aria-selected', String(selection.tab === 'request'));
            responseButton.setAttribute('aria-selected', String(selection.tab === 'response'));
            wrapButton.setAttribute('aria-pressed', String(selection.wrap));
            readableButton.setAttribute('aria-pressed', String(selection.format === 'readable'));
            rawButton.setAttribute('aria-pressed', String(selection.format === 'raw'));
            reading.hidden = selection.format !== 'readable'; code.hidden = selection.format !== 'raw'; wrapButton.hidden = selection.format !== 'raw';
            reading.classList.toggle('live-awaiting-content', !!call && active(call) && selection.tab === 'response');
            copyButton.textContent = selection.format === 'readable' ? '复制内容' : '复制原文';
            code.classList.toggle('live-nowrap', !selection.wrap);
            if (!call) {
                detailMeta.textContent = '选择一次调用';
                rawNotice.textContent = '请求消息和模型返回将显示在这里。';
                reader.clear();
                code.textContent = '';
                rawFold.hidden = true;
                copyButton.disabled = true;
                return;
            }
            detailMeta.replaceChildren(el('div', {}, [el('strong', { text: call.source + ' · ' + call.model }), badge(call)]), el('small', { text: '开始 ' + stamp(call.startedAt) + ' · ' + elapsed(call) + ' · ' + call.callId }), el('small', { text: call.url }));
            var key = selection.id + ':' + selection.tab, text = selection.tab === 'request' ? item?.request : item?.response;
            var changedCall = key !== contentKey;
            if (changedCall) { contentKey = key; rawExpanded = false; }
            if (typeof text !== 'string')
                text = '';
            var readingSelection = window.getSelection(), readingHeld = readingSelection && !readingSelection.isCollapsed && reading.contains(readingSelection.anchorNode), readingScroll = reading.scrollTop;
            if (selection.tab === 'request') reader.request(text, key);
            else {
                var decoder = item && (item.decoder || (item.decoder = CallContent.createResponseDecoder()));
                var awaitingRaw = !item || item.revision < call.revision;
                reader.response(decoder ? decoder.update(text, call.responseFormat, active(call) || awaitingRaw) : { choices: [], warnings: [], pending: true }, key, { active: active(call), awaitingRaw: awaitingRaw, format: call.responseFormat });
            }
            if (selection.follow && active(call) && !readingHeld && selection.tab === 'response') reading.scrollTop = reading.scrollHeight;
            else reading.scrollTop = changedCall ? 0 : readingScroll;
            var selectionRange = window.getSelection(), holding = selectionRange && !selectionRange.isCollapsed && code.contains(selectionRange.anchorNode), scroll = code.scrollTop;
            var longRequest = selection.tab === 'request' && text.length > 6000;
            rawFold.hidden = selection.format !== 'raw' || !longRequest;
            rawFold.textContent = rawExpanded ? '收起长请求' : '展开完整请求 · ' + text.length.toLocaleString('zh-CN') + ' 个字符';
            rawFold.setAttribute('aria-expanded', String(rawExpanded));
            // Keep large requests out of the DOM until the user explicitly opens the raw view.
            var visibleText = selection.format !== 'raw' ? '' : longRequest && !rawExpanded ? text.slice(0, 6000) : text;
            if (key !== selectedKey || !visibleText.startsWith(drawn)) {
                code.textContent = visibleText;
                selectedKey = key;
            }
            else if (visibleText.length > drawn.length)
                code.appendChild(document.createTextNode(visibleText.slice(drawn.length)));
            drawn = visibleText;
            copyButton.disabled = !item || typeof (selection.tab === 'request' ? item.request : item.response) !== 'string';
            if (selection.follow && active(call) && !holding && selection.tab === 'response')
                code.scrollTop = code.scrollHeight;
            else
                code.scrollTop = changedCall ? 0 : scroll;
            rawNotice.textContent = call.missing ? '调用已离开服务端缓存；当前显示浏览器已缓存的数据。' : item?.error ? '读取失败：' + item.error : item?.unavailable ? item.unavailable + (text ? ' · 当前仅显示已在浏览器缓存的部分。' : '') : !call.rawAvailable ? (call.rawUnavailableReason || '原始数据已不可用') : !item || selection.tab === 'request' && item.request === undefined ? '正在读取请求与调用数据…' : selection.tab === 'request' ? (selection.format === 'readable' ? '请求按消息与工具展开 · ' : '实际发送的 JSON 请求体 · ') + bytes(call.requestBytes) + (call.unicodeRepairedStrings ? ' · 已修复 ' + call.unicodeRepairedStrings + ' 处非法 Unicode' : '') : active(call) ? (selection.format === 'readable' ? '模型内容实时更新 · ' : '原始响应正在追加 · ') + bytes(call.responseBytes) + (call.responseFormat ? ' · ' + call.responseFormat : '') : (selection.format === 'readable' ? '模型返回 · ' : '原始响应 · ') + bytes(call.responseBytes) + (call.responseFormat ? ' · ' + call.responseFormat : '') + (call.error ? ' · ' + call.error : '');
            if (call.storageWarning) rawNotice.textContent += ' · ' + call.storageWarning;
            if (!call.missing && (!item || item.revision < call.revision || selection.tab === 'request' && item.request === undefined) && (!item?.nextRetry || Date.now() >= item.nextRetry)) {
                clearTimeout(detailTimer);
                detailTimer = setTimeout(function () { if (alive)
                    fetchDetail(call.callId); }, 150);
            }
            lastRevision = call.revision;
        }
        var unwatch = watch(schedule), clockTimer = setInterval(function () { if (alive && !document.hidden && ordered().some(active))
            schedule(); }, 1000);
        if (!compact) document.addEventListener('selectionchange', schedule);
        render();
        return function () { alive = false; if (reader) reader.clear(); if (insightsCleanup) insightsCleanup(); unwatch(); document.removeEventListener('selectionchange', schedule); clearTimeout(scheduled); clearTimeout(detailTimer); clearInterval(clockTimer); root.remove(); };
    }
    window.LiveCalls = { mount: mount, refresh: refresh };
    Studio.register('live', function (container) { return mount(container); });
})();
