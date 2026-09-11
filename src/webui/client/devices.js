/* Device Studio: real application tools, shared device focus, no simulated content. */
(function () {
    'use strict';
    var drawings = {
        phone: '<rect x="7" y="2" width="18" height="28" rx="5"/><path d="M13 6h6M13 26h6"/>',
        computer: '<rect x="3" y="4" width="26" height="18" rx="3"/><path d="M12 28h8M16 22v6"/>',
        chat: '<path d="M26 20c3-2 4-5 3-8C27 4 11 3 5 9c-5 5-1 13 6 14l-2 5 8-4h3"/><path d="M10 14h.1M16 14h.1M22 14h.1"/>',
        weather: '<circle cx="12" cy="11" r="6"/><path d="M12 1v2M2 11H0M4 3l2 2M20 3l-2 2M22 10h3"/><path d="M11 27h14a5 5 0 0 0 0-10 7 7 0 0 0-13-2 6 6 0 0 0-1 12Z"/>',
        browser: '<circle cx="16" cy="16" r="13"/><path d="m21 10-3 9-8 3 3-9 8-3Z"/>',
        notes: '<rect x="6" y="3" width="23" height="26" rx="3"/><path d="M3 8h6M3 15h6M3 22h6M14 10h9M14 16h9M14 22h5"/>',
        news: '<path d="M6 6h23v21a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3V11h3V6Z"/><path d="M6 11v15M11 11h13M11 16h5v6h-5zM21 16h3M21 21h3"/>',
        mcp: '<rect x="7" y="7" width="18" height="18" rx="4"/><path d="M12 2v5M20 2v5M12 25v5M20 25v5M2 12h5M2 20h5M25 12h5M25 20h5M12 16h8M16 12v8"/>',
        arrow: '<path d="m19 7-9 9 9 9"/>',
        refresh: '<path d="M27 11a12 12 0 1 0 1 10M27 3v8h-8"/>',
        send: '<path d="m3 4 26 12L3 28l5-12-5-12ZM8 16h21"/>',
        plus: '<path d="M16 5v22M5 16h22"/>',
        close: '<path d="m8 8 16 16M24 8 8 24"/>',
        lock: '<rect x="6" y="14" width="20" height="15" rx="3"/><path d="M10 14V9a6 6 0 0 1 12 0v5M16 20v4"/>',
        power: '<path d="M16 2v13M8 7a12 12 0 1 0 16 0"/>',
        terminal: '<rect x="2" y="4" width="28" height="24" rx="4"/><path d="m8 11 5 5-5 5M17 22h7"/>',
        expand: '<path d="M3 12V3h9M20 3h9v9M29 20v9h-9M12 29H3v-9"/>',
        hand: '<path d="M10 17V6a2 2 0 0 1 4 0v8-10a2 2 0 0 1 4 0v10-8a2 2 0 0 1 4 0v9-5a2 2 0 0 1 4 0v11c0 6-4 9-9 9-5 0-7-3-10-8l-4-6c-1-3 2-4 4-2l3 3Z"/>'
    };
    function glyph(name, cls) { return el('span', { cls: cls || 'device-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (drawings[name] || drawings.mcp) + '</svg>' }); }
    function textOf(value) { if (value == null)
        return ''; if (typeof value === 'string')
        return value; if (typeof value.text === 'string')
        return value.text; return JSON.stringify(value, null, 2); }
    function button(label, run, cls, name) { return el('button', { type: 'button', cls: cls || 'device-button', onclick: run, title: label, 'aria-label': label }, [name ? glyph(name) : null, el('span', { text: label })]); }
    function empty(title, detail, name) { return el('div', { cls: 'device-empty' }, [glyph(name || 'phone', 'device-empty-icon'), el('strong', { text: title }), el('p', { text: detail })]); }
    function timeLabel(value) { if (!value)
        return ''; var date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    function appKind(app) { var id = (app && app.id || '').toLowerCase(); if (app && app.kind === 'chat')
        id = 'chat'; if (['chat', 'koishi', 'qq', 'wechat', 'messages'].indexOf(id) >= 0)
        return 'chat'; if (id === 'newsfeed')
        return 'news'; return ['weather', 'browser', 'notes', 'news'].indexOf(id) >= 0 ? id : 'mcp'; }
    function safeUrl(url) { try {
        var parsed = new URL(url, location.href);
        return ['http:', 'https:'].indexOf(parsed.protocol) >= 0 ? parsed.href : null;
    }
    catch (_) {
        return null;
    } }
    Studio.register('devices', function (container) {
        var live = true, synced = false, session = null, tab = 'phone', selected = null, busy = 0, refreshing = false, polling = null, generation = 0, operationMode = 'stealth';
        var results = {}, drafts = {}, noteList = null, noteDraft = null, screenUrl = null, screenAbort = null, screenTimer = null, screenBusy = false, screenGeneration = 0, clickTimer = null, clickPoint = null, appViewStamp = '', computerViewStamp = '';
        var screenWidth = 0, screenHeight = 0, pointer = null, remoteReady = false, terminalEntries = [], history = [], historyIndex = 0, remoteQueue = Promise.resolve(), remotePending = 0, inputEpoch = 0;
        var root = el('section', { cls: 'device-studio' }), header = el('div', { cls: 'device-heading' }), control = el('div', { cls: 'device-control' }), workspace = el('div', { cls: 'device-workspace' }), status = el('div', { cls: 'device-live-status', 'aria-live': 'polite' });
        var phoneBody = null, appBody = null, remoteImage = null, remoteStatus = null, terminalLog = null, viewKey = '', lastChat = '';
        container.appendChild(root);
        header.appendChild(el('div', {}, [el('span', { cls: 'device-eyebrow', text: 'DEVICE STUDIO' }), el('h1', { text: '设备' }), el('p', { text: '拿起手机，或在电脑前坐一会儿。' })]));
        var switches = el('div', { cls: 'device-switch', 'role': 'tablist', 'aria-label': '设备切换' });
        ['phone', 'computer'].forEach(function (type) { var b = button(type === 'phone' ? '手机' : '电脑', function () { if (tab === type)
            return; tab = type; viewKey = ''; render(); }, 'device-switch-button', type); b.dataset.deviceTab = type; b.setAttribute('role', 'tab'); switches.appendChild(b); });
        header.appendChild(switches);
        root.append(header, control, status, workspace);
        function computerMode() { var computer = session && session.devices && session.devices.computer || {}; return computer.effectiveMode || computer.mode || 'off'; }
        function controlled() { return !!(synced && session && session.running && session.control && !isVisitor() && (operationMode === 'stealth' || session.control.paused && !session.control.busy)); }
        function toolDef(name, device) { device = device || (['mouse', 'keyboard', 'screen', 'run_command', 'open_computer', 'close_computer'].includes(name) ? 'computer' : 'phone'); var tools = (session && session.tools || []).filter(function (t) { return t.device === device; }); return tools.find(function (t) { return t.name === name; }) || tools.find(function (t) { return t.name.endsWith('.' + name); }); }
        function available(name, device) { return !(operationMode === 'stealth' && ['pick_up_phone', 'put_down_phone', 'pick_media'].includes(name)) && !!toolDef(name, device); }
        function report(err) { if (!live)
            return; status.textContent = err && err.message || String(err); status.classList.add('device-status-error'); toast(status.textContent, 'err'); }
        function setBusy(delta) { busy = Math.max(0, busy + delta); updateControls(); }
        function updateControls() {
            if (!live)
                return;
            root.querySelectorAll('[data-device-mutation]').forEach(function (node) { node.disabled = !controlled() || !!busy || (node.dataset.deviceTool && !available(node.dataset.deviceTool, node.dataset.deviceToolDevice)); });
            root.querySelectorAll('[data-device-tab]').forEach(function (node) { var active = node.dataset.deviceTab === tab; node.classList.toggle('device-selected', active); node.setAttribute('aria-selected', String(active)); });
            var gate = control.querySelector('[data-device-control]');
            if (gate)
                gate.disabled = !!busy || !!(session && session.control && session.control.paused && session.control.busy);
        }
        function mutation(node, name, device) { node.dataset.deviceMutation = '1'; if (name)
            node.dataset.deviceTool = name; if (device)
            node.dataset.deviceToolDevice = device; node.disabled = !controlled() || !!busy || !!name && !available(name, device); return node; }
        function toolButton(label, name, args, after, cls, svg) { return mutation(button(label, function () { perform(name, typeof args === 'function' ? args() : args || {}).then(function (r) { if (after)
            after(r); }).catch(report); }, cls, svg), name); }
        function renderControl() {
            control.replaceChildren();
            if (!session)
                return;
            var c = session.control || {}, paused = !!c.paused, waiting = !!c.busy;
            var title = isVisitor() ? '访客只读' : paused ? 'Bot 自主操作已暂停' : operationMode === 'stealth' ? '偷偷操作 · Bot 仍在自主行动' : '等待强制接管';
            var hint = isVisitor() ? '可查看开放的设备信息。' : operationMode === 'stealth'
                ? (paused ? '偷偷操作不会改变暂停状态；点击交还才能恢复 Bot。' : '双方共享设备，操作会依次执行，界面可能随时被切换。Bot 关注设备时能看到变化。')
                : paused ? (waiting ? '已有操作正在完成，请等待真实回执。' : '自主生成已暂停，可以操作设备；完成后请交还给 Bot。') : '点击强制接管后暂停自主生成；已开始的操作会等待完成。';
            control.appendChild(el('div', { cls: 'device-control-copy' }, [el('span', { cls: 'device-presence ' + (paused ? 'device-presence-human' : '') }), el('div', {}, [el('strong', { text: title }), el('p', { text: hint })])]));
            if (!isVisitor()) {
                var modes = el('div', { cls: 'device-operation-modes', role: 'group', 'aria-label': '设备操作模式' });
                [['stealth', '偷偷操作'], ['takeover', '接管后操作']].forEach(function (mode) {
                    var choice = button(mode[1], function () { if (busy || operationMode === mode[0]) return; operationMode = mode[0]; inputEpoch++; viewKey = ''; renderControl(); render(); }, 'device-mode-choice');
                    choice.setAttribute('aria-pressed', String(operationMode === mode[0])); choice.disabled = !!busy; modes.appendChild(choice);
                });
                control.appendChild(modes);
                var take = button(paused ? '交还给 Bot' : '强制接管', async function () {
                    take.disabled = true;
                    inputEpoch++;
                    setBusy(1);
                    status.textContent = paused ? '正在交还设备…' : '正在等待设备交接…';
                    try {
                        var r = await api('POST', '/api/device/control', { paused: !paused });
                        if (!live)
                            return;
                        if (r.paused === true) operationMode = 'takeover';
                        else if (r.ok && r.paused === false) operationMode = 'stealth';
                        viewKey = '';
                        toast(r.text || (r.paused ? '已接管设备' : '已交还设备'), r.ok === false ? 'err' : 'ok');
                        await refresh(true);
                    }
                    catch (err) {
                        report(err);
                    }
                    finally {
                        setBusy(-1);
                        if (live)
                            renderControl();
                    }
                }, 'device-button ' + (paused ? 'device-button-soft' : 'device-button-primary'), paused ? 'phone' : 'hand');
                take.dataset.deviceControl = '1';
                take.disabled = !!busy || paused && waiting;
                control.appendChild(take);
            }
            updateControls();
        }
        async function refresh(force) {
            if (refreshing && !force)
                return;
            refreshing = true;
            try {
                var data = await api('GET', isVisitor() ? '/api/devices' : '/api/device/session');
                if (!live)
                    return;
                synced = true;
                session = isVisitor() ? { devices: data, control: { paused: false, busy: false }, apps: [], tools: [] } : data;
                if (!session.devices)
                    session.devices = { phone: {}, computer: { mode: 'off' } };
                var appSnapshot = session.appView, appStamp = JSON.stringify(appSnapshot), computerSnapshot = session.computerView, computerStamp = JSON.stringify(computerSnapshot);
                var appChanged = appStamp !== appViewStamp;
                appViewStamp = appStamp;
                if (appSnapshot && appChanged) {
                    var content = appSnapshot.result === undefined ? appSnapshot.opening : appSnapshot.result;
                    results[appSnapshot.id] = typeof content === 'string' ? { text: content } : { content: content };
                }
                if (computerSnapshot && computerStamp !== computerViewStamp && !busy) {
                    var entry = { command: computerSnapshot.lastTool || '电脑回执', text: textOf(computerSnapshot.result) };
                    if (entry.text) {
                        terminalEntries.push(entry);
                        renderTerminalEntry(entry);
                    }
                }
                computerViewStamp = computerStamp;
                var active = (session.apps || []).find(function (a) { return a.active; });
                // Keep the desktop visible until the user opens an app, then follow shared focus.
                if (selected && (!active || active.id !== selected.id)) {
                    selected = active || null;
                    generation++;
                    viewKey = '';
                }
                if (!selected && !viewKey && active)
                    selected = active;
                renderControl();
                render();
                if (appChanged && selected && appSnapshot && selected.id === appSnapshot.id && appBody) {
                    var output = appBody.querySelector('.app-output');
                    if (output)
                        showResult(output, results[selected.id]);
                    var weather = appBody.querySelector('.app-weather-data');
                    if (weather)
                        weatherResult(weather, results[selected.id]);
                }
                status.classList.remove('device-status-error');
                status.textContent = '设备状态已同步 · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
            catch (err) {
                if (live) {
                    synced = false;
                    status.textContent = '设备连接中断：' + (err.message || String(err));
                    status.classList.add('device-status-error');
                    updateControls();
                }
                if (live && !session) {
                    workspace.replaceChildren(empty('设备暂时不可用', err.message || String(err)));
                    workspace.appendChild(button('重新连接', function () { refresh(true); }, 'device-button', 'refresh'));
                }
                if (force)
                    report(err);
            }
            finally {
                refreshing = false;
            }
        }
        async function perform(name, args, options) {
            if (!controlled())
                throw new Error(operationMode === 'stealth' ? '设备所属世界尚未运行或状态未同步。' : '请先强制接管设备，等待当前操作完成。');
            var opts = options || {};
            if (!available(name, opts.device))
                throw new Error('当前设备未开放这个操作，请刷新状态后再试。');
            var def = toolDef(name, opts.device), sending = def && def.effect === 'send';
            if (!opts.quiet)
                setBusy(1);
            try {
                var response = await api('POST', '/api/device/tool', { name: def.name, args: args || {}, mode: operationMode, confirmSend: !!opts.confirmSend || sending && !!opts.explicitSend });
                if (response.ok === false)
                    throw new Error(response.text || response.error || '操作没有完成');
                if (live && !opts.quiet) {
                    await refresh(true);
                    status.classList.remove('device-status-error');
                    status.textContent = response.text ? textOf(response.text).slice(0, 160) : '操作已完成';
                }
                return response;
            }
            finally {
                if (!opts.quiet)
                    setBusy(-1);
            }
        }
        function showResult(node, response, cls) {
            node.replaceChildren();
            var content = response && response.content;
            var text = response && (content && content.text || response.text) || '';
            if (text && node.classList.contains('app-output') && selected && appKind(selected) === 'news' && /^\[\d+\] /m.test(text)) {
                var newsList = el('div', { cls: 'app-news-articles' });
                text.split('\n').forEach(function (line) { var match = line.match(/^\[(\d+)\] (.+)$/); if (match) {
                    var card = mutation(button('阅读 ' + match[2], function () { appTool('open_news', { n: Number(match[1]) }, node).catch(report); }, 'app-news-article'), 'open_news');
                    card.replaceChildren(el('span', { cls: 'app-news-number', text: match[1].padStart(2, '0') }), el('strong', { text: match[2] }), el('span', { cls: 'app-news-read', text: '阅读全文 ↗' }));
                    newsList.appendChild(card);
                }
                else if (line.trim() && line.indexOf('（想细看哪条') !== 0)
                    newsList.appendChild(el('p', { cls: 'app-news-context', text: line })); });
                node.appendChild(newsList);
            }
            else if (text)
                node.appendChild(el('div', { cls: cls || 'app-response', text: text }));
            var media = content && content.attachments || [];
            media.forEach(function (ref) {
                var source = ref.url || (ref.id != null ? '/api/media/file?id=' + encodeURIComponent(ref.id) : null);
                if (!source || !safeUrl(source))
                    return;
                source = new URL(source, location.href).origin === location.origin ? withToken(source) : source;
                if (ref.type === 'image')
                    node.appendChild(el('img', { cls: 'app-result-image', src: source, alt: '应用返回的图片', loading: 'lazy', onerror: function (e) { e.currentTarget.replaceWith(el('p', { cls: 'app-subtle', text: '图片暂时无法加载' })); } }));
                else
                    node.appendChild(el('a', { href: source, target: '_blank', rel: 'noopener noreferrer', text: ref.type === 'audio' ? '打开音频' : '打开附件' }));
            });
            if (!text && !media.length)
                node.appendChild(el('p', { cls: 'app-subtle', text: '操作已完成，没有返回内容。' }));
        }
        function render() {
            if (!live || !session)
                return;
            updateControls();
            var d = session.devices, key = tab === 'phone' ? 'phone:' + (selected ? selected.id : 'home') + ':' + d.phone.down : 'computer:' + computerMode() + ':' + d.computer.on + ':' + !!(d.computer.docker && d.computer.docker.running);
            if (tab === 'phone' && selected && appKind(selected) === 'mcp')
                key += ':' + JSON.stringify(session.tools || []);
            if (key !== viewKey) {
                viewKey = key;
                stopScreen();
                workspace.replaceChildren();
                appBody = null;
                remoteImage = null;
                terminalLog = null;
                lastChat = '';
                if (tab === 'phone')
                    renderPhone();
                else
                    renderComputer();
            }
            if (tab === 'phone') {
                var hint = root.querySelector('.phone-device-label');
                if (hint)
                    hint.textContent = d.phone.down ? '手机已放下' : d.phone.appOpen ? '当前应用 · ' + d.phone.appOpen : '手机待机';
                if (selected && appKind(selected) === 'chat')
                    updateChat();
            }
            else if (computerMode() === 'remote_desktop') {
                var online = !!(d.computer.on && d.computer.remote && d.computer.remote.connected);
                remoteReady = online;
                if (remoteStatus && !screenUrl)
                    remoteStatus.textContent = online ? '正在读取真实桌面画面…' : d.computer.on ? '远程连接尚未建立，请检查连接或重新打开电脑。' : '电脑尚未打开，打开后可连接桌面。';
                if (online && !screenTimer) {
                    captureScreen();
                    screenTimer = setInterval(captureScreen, 2500);
                }
                else if (!online) {
                    stopScreen();
                    if (remoteStatus)
                        remoteStatus.textContent = d.computer.on ? '远程连接尚未建立，请检查连接或重新打开电脑。' : '电脑尚未打开，打开后可连接桌面。';
                }
            }
            updateControls();
        }
        function phoneAction(label, name, args, cls, svg) { return toolButton(label, name, args, null, cls, svg); }
        function renderPhone() {
            var scene = el('div', { cls: 'phone-scene' }), phone = el('div', { cls: 'phone-frame' }), rail = el('aside', { cls: 'device-side-note' });
            var top = el('div', { cls: 'phone-statusbar' }, [el('span', { cls: 'phone-device-label', text: '手机' }), el('span', { cls: 'phone-camera', 'aria-hidden': 'true' }), el('span', { text: '●', 'aria-hidden': 'true' })]);
            phoneBody = el('div', { cls: 'phone-display' });
            phone.append(top, phoneBody);
            var home = button('返回桌面', async function () { selected = null; generation++; viewKey = ''; render(); }, 'phone-home-button');
            home.appendChild(el('span', { cls: 'phone-home-line', 'aria-hidden': 'true' }));
            phone.append(home);
            scene.append(phone);
            workspace.append(scene, rail);
            rail.append(el('span', { cls: 'device-eyebrow', text: 'THE POCKET WORLD' }), el('h2', { text: selected ? selected.name : '一方小小的日常' }), el('p', { text: selected ? selected.description || '与 Bot 共用的真实应用。' : '手机桌面展示已安装的应用。每一次点击，都会发生在这台设备上。' }));
            var physical = el('div', { cls: 'device-facts' });
            physical.append(el('span', { text: '设备状态' }), el('strong', { text: session.devices.phone.down ? '已放下' : '已拿起' }));
            rail.append(physical);
            if (operationMode === 'takeover') rail.append(phoneAction(session.devices.phone.down ? '拿起手机' : '放下手机', session.devices.phone.down ? 'pick_up_phone' : 'put_down_phone', {}, 'device-button device-button-soft', 'phone'));
            if (session.devices.phone.appOpen || session.devices.phone.chatOpen)
                rail.append(phoneAction('关闭当前应用', 'close_app', {}, 'device-button', 'close'));
            if (!selected) {
                renderDesktop();
                return;
            }
            var kind = appKind(selected);
            phoneBody.className = 'phone-display app-' + kind;
            var nav = el('div', { cls: 'app-navigation' }, [button('桌面', function () { selected = null; generation++; viewKey = ''; render(); }, 'app-back', 'arrow'), el('strong', { text: selected.name }), el('span', { cls: 'app-navigation-mark', 'aria-hidden': 'true', text: '•' })]);
            appBody = el('div', { cls: 'app-body' });
            phoneBody.append(nav, appBody);
            ({ chat: renderChat, weather: renderWeather, browser: renderBrowser, notes: renderNotes, news: renderNews, mcp: renderMcp }[kind])();
        }
        function renderDesktop() {
            phoneBody.className = 'phone-display phone-desktop';
            phoneBody.appendChild(el('div', { cls: 'phone-wallpaper', 'aria-hidden': 'true', html: '<svg viewBox="0 0 400 660" preserveAspectRatio="xMidYMid slice"><path fill="#e4eadb" d="M0 0h400v660H0z"/><circle fill="#f5d6b8" cx="324" cy="132" r="112"/><path fill="#9ab394" d="M-90 432C23 166 232 281 258 422S413 714 451 719H-90Z"/><path fill="#416852" d="M0 528c87-183 233-225 424-199v331H0Z"/><path d="M64 530c86-145 168-178 312-168" stroke="#c6d4b3" stroke-width="2" fill="none"/></svg>' }));
            phoneBody.appendChild(el('div', { cls: 'phone-desktop-title' }, [el('span', { text: '随身世界' }), el('h2', { text: '你好，生活。' }), el('p', { text: session.apps.length ? '所有应用都在这里。' : '尚无可用应用。' })]));
            var grid = el('div', { cls: 'phone-app-grid' });
            (session.apps || []).forEach(function (app) {
                var kind = appKind(app), b = button(app.name, async function () {
                    if (!controlled()) {
                        toast('接管设备后即可打开应用', 'err');
                        return;
                    }
                    var token = ++generation;
                    try {
                        var response = await perform('open_app', { name: app.id });
                        if (!live || token !== generation)
                            return;
                        selected = app;
                        results[app.id] = response;
                        viewKey = '';
                        render();
                    }
                    catch (err) {
                        report(err);
                    }
                }, 'phone-app-tile');
                b.replaceChildren(el('span', { cls: 'phone-app-icon phone-app-icon-' + kind }, [glyph(kind)]), el('span', { cls: 'phone-app-name', text: app.name }));
                if (app.active)
                    b.appendChild(el('span', { cls: 'phone-app-active', title: '当前打开', 'aria-label': '当前打开' }));
                mutation(b, 'open_app');
                grid.appendChild(b);
            });
            phoneBody.append(grid);
            if (isVisitor())
                phoneBody.appendChild(el('p', { cls: 'phone-desktop-notice', text: '应用交互仅向管理员开放。' }));
            else if (!session.apps.length)
                phoneBody.appendChild(el('p', { cls: 'phone-desktop-notice', text: session.running ? '没有已安装的应用。' : '启动世界后可查看应用。' }));
            phoneBody.appendChild(el('div', { cls: 'phone-desktop-footer', text: session.devices.phone.down ? '手机已放下' : '轻点应用，继续日常' }));
        }
        function appOutput(id) { var output = el('div', { cls: 'app-output', 'aria-live': 'polite' }); if (results[id])
            showResult(output, results[id]); return output; }
        function appForm(run) { var form = el('form', { cls: 'app-form', onsubmit: function (event) { event.preventDefault(); Promise.resolve().then(run).catch(report); } }); return form; }
        function field(placeholder, value, attrs) { return el('input', Object.assign({ cls: 'app-input', type: 'text', placeholder: placeholder, value: value || '' }, attrs || {})); }
        function appTool(name, args, output) { var id = selected.id; return perform(name, args).then(function (r) { if (live) {
            results[id] = r;
            if (output && output.isConnected)
                showResult(output, r);
        } return r; }); }
        function renderChat() {
            appBody.appendChild(el('div', { cls: 'app-chat-heading' }, [el('h2', { text: '消息' }), toolButton('刷新', 'check_msg', { n: 30 }, function () { lastChat = ''; updateChat(); }, 'app-icon-button', 'refresh')]));
            var split = el('div', { cls: 'app-chat-layout' }), channels = el('div', { cls: 'app-chat-channels', 'aria-label': '会话列表' }), thread = el('div', { cls: 'app-chat-thread' });
            thread.append(el('div', { cls: 'app-chat-title' }), el('div', { cls: 'app-chat-messages', 'aria-live': 'polite' }));
            var draftKey = 'chat:' + ((session.chat || {}).channelKey || ''), msg = el('textarea', { cls: 'app-chat-compose', rows: '2', placeholder: '写一条消息…', 'aria-label': '消息内容' });
            msg.value = drafts[draftKey] || '';
            msg.addEventListener('input', function () { drafts[msg.dataset.channel || draftKey] = msg.value; });
            var send = mutation(button('发送', async function () {
                var text = msg.value.trim(), channel = session.chat && session.chat.channelKey;
                if (!text || !channel)
                    return;
                try {
                    var r = await perform('send', { msg: text, id: channel }, { confirmSend: true });
                    if (!live)
                        return;
                    msg.value = '';
                    drafts['chat:' + channel] = '';
                    lastChat = '';
                    updateChat();
                    toast(r.text || '消息已发送', 'ok');
                }
                catch (err) {
                    report(err);
                }
            }, 'app-chat-send', 'send'), 'send');
            var compose = el('div', { cls: 'app-chat-composer' }, [msg, send]);
            thread.append(compose);
            split.append(channels, thread);
            appBody.append(split);
            updateChat();
        }
        function updateChat() {
            if (!appBody)
                return;
            var chat = session.chat || {}, channels = chat.channels || [], messages = chat.messages || [];
            var hash = JSON.stringify([chat.channelKey, channels, messages]);
            if (hash === lastChat)
                return;
            lastChat = hash;
            var list = appBody.querySelector('.app-chat-channels'), stream = appBody.querySelector('.app-chat-messages'), title = appBody.querySelector('.app-chat-title');
            if (!list || !stream)
                return;
            list.replaceChildren();
            channels.forEach(function (channel) {
                var participants = channel.participants || [], name = channel.name || channel.title || participants.map(function (p) { return p.username; }).filter(Boolean).slice(0, 3).join('、') || channel.channelId || channel.key;
                var b = button(name, async function () { try {
                    await perform('select_channel', { id: channel.key });
                    lastChat = '';
                    updateChat();
                }
                catch (err) {
                    report(err);
                } }, 'app-chat-channel' + (channel.key === chat.channelKey ? ' app-chat-channel-active' : ''));
                b.replaceChildren(el('span', { cls: 'app-avatar', text: name.slice(0, 1) }), el('span', { cls: 'app-chat-channel-copy' }, [el('strong', { text: name }), el('small', { text: channel.latest ? textOf(channel.latest.content) : channel.platform || '' })]));
                mutation(b, 'select_channel');
                list.appendChild(b);
            });
            if (!channels.length)
                list.appendChild(el('p', { cls: 'app-subtle', text: '还没有会话' }));
            var current = channels.find(function (c) { return c.key === chat.channelKey; });
            title.replaceChildren(el('strong', { text: current ? (current.name || current.title || current.channelId || current.key) : chat.channelKey || '选择一个会话' }));
            if (chat.channelKey)
                title.appendChild(toolButton('更多消息', 'read_channel', { n: 80 }, function () { lastChat = ''; updateChat(); }, 'app-text-button'));
            var wasBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
            stream.replaceChildren();
            if (!chat.channelKey)
                stream.appendChild(empty('会话从这里开始', '从上方选择一个已知会话。', 'chat'));
            else if (!messages.length)
                stream.appendChild(empty('这里暂时没有消息', '点击“更多消息”读取实际历史。', 'chat'));
            messages.forEach(function (msg) { stream.appendChild(el('article', { cls: 'app-message' + (msg.self ? ' app-message-self' : '') }, [el('div', { cls: 'app-message-meta', text: [msg.username || msg.userId, timeLabel(msg.timestamp)].filter(Boolean).join(' · ') }), el('div', { cls: 'app-message-bubble', text: textOf(msg.content) })])); });
            if (wasBottom)
                stream.scrollTop = stream.scrollHeight;
            var compose = appBody.querySelector('.app-chat-compose');
            if (compose) {
                compose.disabled = !chat.channelKey || !controlled();
                var key = 'chat:' + (chat.channelKey || '');
                if (compose.dataset.channel !== key) {
                    compose.dataset.channel = key;
                    compose.value = drafts[key] || '';
                }
            }
            updateControls();
        }
        function renderWeather() {
            var id = selected.id, output = el('div', { cls: 'app-weather-data', 'aria-live': 'polite' }), city = field('输入城市或地区', drafts.weatherCity, { 'aria-label': '城市或地区' });
            city.addEventListener('input', function () { drafts.weatherCity = city.value; });
            var form = appForm(async function () { var r = await appTool('query_weather', city.value.trim() ? { city: city.value.trim() } : {}, null); if (live && output.isConnected)
                weatherResult(output, r); });
            form.append(city, mutation(el('button', { type: 'submit', cls: 'app-weather-search', text: '查询' }), 'query_weather'));
            appBody.append(el('div', { cls: 'app-weather-heading' }, [el('span', { cls: 'app-kicker', text: '抬头看看天空' }), el('h2', { text: '天气' }), glyph('weather', 'app-weather-illustration')]), form, output);
            if (results[id])
                weatherResult(output, results[id]);
            else
                output.appendChild(empty('今天的天空如何？', '查询城市后，显示天气服务的实际结果。', 'weather'));
        }
        function weatherResult(output, response) {
            var text = textOf(response.content || response.text), lines = text.split('\n').filter(Boolean), current = lines.find(function (l) { return l.indexOf('现在：') === 0; }), match = current && current.match(/^现在：(.+?)，([^，]+?)°C（体感\s*([^）]+)）[，,]?(.*)$/);
            output.replaceChildren();
            if (!match) {
                showResult(output, response, 'app-weather-raw');
                return;
            }
            output.appendChild(el('div', { cls: 'app-weather-current' }, [el('p', { text: (lines.find(function (l) { return l.indexOf('天气 · ') === 0; }) || '').replace('天气 · ', '') }), el('div', { cls: 'app-weather-temperature' }, [el('strong', { text: match[2] }), el('span', { text: '°' })]), el('h3', { text: match[1] }), el('p', { text: '体感 ' + match[3] }), el('small', { text: match[4] })]));
            var forecast = el('div', { cls: 'app-weather-forecast' });
            lines.filter(function (l) { return /^(今天|明天|后天)：/.test(l); }).forEach(function (line) { var i = line.indexOf('：'); forecast.appendChild(el('div', {}, [el('strong', { text: line.slice(0, i) }), el('span', { text: line.slice(i + 1) })])); });
            output.appendChild(forecast);
            var original = el('details', { cls: 'app-source' }, [el('summary', { text: '完整天气结果' }), el('pre', { text: text })]);
            output.appendChild(original);
        }
        function renderBrowser() {
            var address = field('搜索或输入网址', drafts.browserAddress, { 'aria-label': '搜索或网址' }), output = appOutput(selected.id);
            address.addEventListener('input', function () { drafts.browserAddress = address.value; });
            var form = appForm(function () { var value = address.value.trim(); if (!value)
                return; return appTool(/^https?:\/\//i.test(value) ? 'open_url' : 'search', /^https?:\/\//i.test(value) ? { url: value } : { query: value }, output); });
            form.classList.add('app-browser-address');
            form.append(glyph('browser'), address, mutation(el('button', { type: 'submit', cls: 'app-icon-button', text: '前往' })));
            var toolbar = el('div', { cls: 'app-browser-tools' }, [toolButton('后退', 'go_back', {}, function (r) { showResult(output, r); }, 'app-text-button', 'arrow'), toolButton('下一屏', 'scroll_down', {}, function (r) { showResult(output, r); }, 'app-text-button'), toolButton('截图', 'screenshot', {}, function (r) { showResult(output, r); }, 'app-text-button')]);
            var link = field('链接编号', '', { type: 'number', min: '1', 'aria-label': '页面链接编号' }), open = appForm(function () { return appTool('open_link', { n: Number(link.value) }, output); });
            open.classList.add('app-browser-link');
            open.append(link, mutation(el('button', { type: 'submit', cls: 'app-text-button', text: '打开链接' }), 'open_link'));
            appBody.append(form, toolbar, el('div', { cls: 'app-browser-page' }, [results[selected.id] ? null : empty('从一个问题出发', '输入网址，或搜索你关心的事。页面内容来自真实浏览器。', 'browser'), output]), open);
        }
        function renderNotes() {
            var heading = el('div', { cls: 'app-notes-heading' }, [el('span', { cls: 'app-kicker', text: '随手记，也认真记' }), el('h2', { text: '我的笔记' })]);
            var list = el('div', { cls: 'app-note-list' }), editor = el('div', { cls: 'app-note-editor' });
            var add = mutation(button('新笔记', function () { noteDraft = { original: null, title: '', content: '' }; editNote(editor); }, 'app-notes-add', 'plus'), 'write_note');
            heading.append(add);
            appBody.append(heading, list, editor);
            function listNotes() {
                if (!live || !list.isConnected)
                    return;
                list.replaceChildren();
                if (!noteList || !noteList.length) {
                    list.appendChild(el('p', { cls: 'app-subtle', text: noteList ? '还没有笔记。写下第一件想记住的事。' : '正在读取笔记…' }));
                    return;
                }
                noteList.forEach(function (note) { var b = button(note.title, function () { noteDraft = { original: note.title, title: note.title, content: note.content || '' }; editNote(editor); }, 'app-note-row'); b.replaceChildren(el('strong', { text: note.title }), el('p', { text: (note.content || '').slice(0, 100) })); list.appendChild(b); });
            }
            listNotes();
            api('GET', '/api/notes').then(function (data) { if (!live)
                return; noteList = data.notes || []; listNotes(); }).catch(function (err) { if (list.isConnected)
                list.replaceChildren(empty('笔记没有加载成功', err.message, 'notes')); });
            if (noteDraft)
                editNote(editor);
        }
        function editNote(editor) {
            editor.replaceChildren();
            var draft = noteDraft, title = field('标题', draft.title, { 'aria-label': '笔记标题' }), content = el('textarea', { cls: 'app-note-paper', placeholder: '写下想记住的事…', 'aria-label': '笔记正文' });
            content.value = draft.content;
            title.addEventListener('input', function () { draft.title = title.value; });
            content.addEventListener('input', function () { draft.content = content.value; });
            var result = el('div', { cls: 'app-note-result', 'aria-live': 'polite' }), save = mutation(button('保存笔记', async function () {
                if (!draft.title.trim() || !draft.content.trim()) {
                    toast('请填写标题和正文', 'err');
                    return;
                }
                var args = draft.original ? { title: draft.original, new_title: draft.title, content: draft.content } : { title: draft.title, content: draft.content };
                try {
                    var r = await perform(draft.original ? 'edit_note' : 'write_note', args);
                    if (!live)
                        return;
                    showResult(result, r);
                    var data = await api('GET', '/api/notes');
                    noteList = data.notes || [];
                    var stored = noteList.find(function (n) { return n.title === draft.title; });
                    if (stored && stored.content === draft.content) {
                        draft.original = stored.title;
                        toast('笔记已保存', 'ok');
                    }
                }
                catch (err) {
                    report(err);
                }
            }, 'app-notes-save'), draft.original ? 'edit_note' : 'write_note');
            var row = el('div', { cls: 'app-note-actions' }, [button('收起', function () { editor.replaceChildren(); noteDraft = null; viewKey = ''; render(); }, 'app-text-button'), save]);
            if (draft.original) {
                var armed = false, del = mutation(button('删除', async function () { if (!armed) {
                    armed = true;
                    del.querySelector('span').textContent = '确定删除';
                    return;
                } try {
                    await perform('delete_note', { title: draft.original });
                    var data = await api('GET', '/api/notes');
                    if ((data.notes || []).some(function (n) { return n.title === draft.original; })) {
                        toast('笔记仍存在，请检查操作结果', 'err');
                        return;
                    }
                    noteDraft = null;
                    noteList = data.notes;
                    viewKey = '';
                    render();
                }
                catch (err) {
                    report(err);
                } }, 'app-text-button app-delete'), 'delete_note');
                row.prepend(del);
            }
            editor.append(title, content, row, result);
            title.focus();
        }
        function renderNews() {
            var output = appOutput(selected.id), query = field('搜索新闻', drafts.newsQuery, { 'aria-label': '新闻关键词' });
            query.addEventListener('input', function () { drafts.newsQuery = query.value; });
            var form = appForm(function () { return appTool('search_news', { keyword: query.value.trim(), n: 10 }, output); });
            form.append(query, mutation(el('button', { type: 'submit', cls: 'app-news-search', text: '搜索' }), 'search_news'));
            appBody.append(el('div', { cls: 'app-news-masthead' }, [el('span', { text: '从世界传来的消息' }), el('h2', { text: '日常时报' }), el('div', { cls: 'app-news-rule' })]), form, el('div', { cls: 'app-news-tabs' }, [toolButton('最新头条', 'headlines', { n: 10 }, function (r) { showResult(output, r, 'app-news-copy'); }, 'app-news-tab')]), output);
            if (!results[selected.id])
                output.appendChild(empty('等一则真实的消息', '读取头条，或搜索新闻。没有内容时，这里会留白。', 'news'));
            var n = field('文章编号', '', { type: 'number', min: '1', 'aria-label': '新闻编号' }), open = appForm(function () { if (!n.value)
                return; return appTool('open_news', { n: Number(n.value) }, output); });
            open.classList.add('app-news-open');
            open.append(n, mutation(el('button', { type: 'submit', cls: 'app-news-search', text: '阅读全文' }), 'open_news'));
            appBody.append(open);
        }
        function renderMcp() {
            appBody.appendChild(el('div', { cls: 'app-mcp-heading' }, [glyph('mcp', 'app-mcp-symbol'), el('span', { cls: 'app-kicker', text: 'CONNECTED APP' }), el('h2', { text: selected.name }), el('p', { text: selected.description || '选择工具，填写参数，然后执行。' })]));
            var tools = (session.tools || []).filter(function (t) { return t.device === 'phone' && t.name !== 'open_app' && t.name !== 'close_app' && !['pick_up_phone', 'put_down_phone', 'check_gallery', 'check_media', 'view_media', 'gallery_save', 'gallery_move', 'gallery_remove'].includes(t.name); });
            var output = appOutput(selected.id);
            if (!tools.length)
                appBody.appendChild(empty('这个应用尚无可用工具', '请确认应用已成功打开。', 'mcp'));
            tools.forEach(function (tool) {
                var details = el('details', { cls: 'app-tool-card' }), summary = el('summary', {}, [el('strong', { text: tool.name }), el('span', { text: tool.effect === 'send' ? '发送' : tool.effect === 'action' ? '操作' : '读取' })]);
                var form = el('form', { cls: 'app-schema-form' }), schema = tool.inputSchema || {}, collect;
                details.append(summary, el('p', { cls: 'app-tool-description', text: tool.description || tool.signature || '' }));
                if (schema.properties || schema.type === 'object' && schema.additionalProperties === false)
                    collect = schemaFields(form, schema, {}, '');
                else {
                    var json = el('textarea', { cls: 'app-schema-json', rows: '5', 'aria-label': 'JSON 参数', placeholder: '{}' });
                    json.value = '{}';
                    form.appendChild(el('label', { text: '参数（JSON 对象）' }));
                    form.appendChild(json);
                    collect = function () { var value = JSON.parse(json.value); if (!value || Array.isArray(value) || typeof value !== 'object')
                        throw new Error('参数必须是 JSON 对象'); return value; };
                }
                var submit = mutation(el('button', { type: 'submit', cls: 'app-mcp-run', text: tool.effect === 'send' ? '发送并执行' : '执行工具' }), tool.name, tool.device);
                form.appendChild(submit);
                form.addEventListener('submit', async function (event) { event.preventDefault(); try {
                    var args = collect(), r = await perform(tool.name, args, { confirmSend: tool.effect === 'send', device: tool.device });
                    results[selected.id] = r;
                    if (live)
                        showResult(output, r);
                }
                catch (err) {
                    report(err);
                } });
                details.appendChild(form);
                appBody.appendChild(details);
            });
            appBody.appendChild(output);
        }
        function schemaFields(parent, schema, defaults, path) {
            var readers = [], required = schema.required || [];
            Object.keys(schema.properties || {}).forEach(function (key) {
                var spec = schema.properties[key] || {}, label = spec.title || key, req = required.indexOf(key) >= 0, value = defaults[key] !== undefined ? defaults[key] : spec.default;
                var wrap = el('div', { cls: 'app-schema-field' }), labelNode = el('label', { text: label + (req ? ' *' : '') }), input, read;
                if (spec.type === 'object' && spec.properties) {
                    wrap.appendChild(labelNode);
                    read = schemaFields(wrap, spec, value || {}, path + key + '.');
                }
                else {
                    if (Array.isArray(spec.enum)) {
                        input = el('select', { cls: 'app-input' });
                        if (!req)
                            input.appendChild(el('option', { value: '', text: '不设置' }));
                        spec.enum.forEach(function (item, index) { input.appendChild(el('option', { value: String(index), text: String(item), selected: item === value })); });
                        read = function () { return input.value === '' ? undefined : spec.enum[Number(input.value)]; };
                    }
                    else if (spec.type === 'boolean') {
                        input = el('select', { cls: 'app-input' }, [el('option', { value: '', text: '不设置' }), el('option', { value: 'true', text: '是', selected: value === true }), el('option', { value: 'false', text: '否', selected: value === false })]);
                        read = function () { return input.value === '' ? undefined : input.value === 'true'; };
                    }
                    else if (spec.type === 'array' || spec.type === 'object' || spec.anyOf || spec.oneOf) {
                        input = el('textarea', { cls: 'app-schema-json', rows: '4', placeholder: spec.type === 'array' ? '[]' : 'JSON' });
                        input.value = value === undefined ? '' : JSON.stringify(value, null, 2);
                        read = function () { if (!input.value.trim())
                            return undefined; var v = JSON.parse(input.value); if (spec.type === 'array' && !Array.isArray(v))
                            throw new Error(label + ' 必须是数组'); if (spec.type === 'object' && (!v || Array.isArray(v) || typeof v !== 'object'))
                            throw new Error(label + ' 必须是对象'); return v; };
                    }
                    else if (spec.type === 'number' || spec.type === 'integer') {
                        input = field('', value == null ? '' : String(value), { type: 'number', step: spec.type === 'integer' ? '1' : 'any' });
                        if (spec.minimum !== undefined)
                            input.min = spec.minimum;
                        if (spec.maximum !== undefined)
                            input.max = spec.maximum;
                        read = function () { if (input.value === '')
                            return undefined; var num = Number(input.value); if (!Number.isFinite(num) || spec.type === 'integer' && !Number.isInteger(num))
                            throw new Error(label + ' 必须是有效数字'); return num; };
                    }
                    else {
                        input = spec.maxLength > 200 || /text|content|message|prompt/i.test(key) ? el('textarea', { cls: 'app-input', rows: '3' }) : field('', value, {});
                        input.value = value == null ? '' : String(value);
                        if (spec.minLength !== undefined)
                            input.minLength = spec.minLength;
                        if (spec.maxLength !== undefined)
                            input.maxLength = spec.maxLength;
                        read = function () { return input.value === '' && !req ? undefined : input.value; };
                    }
                    input.setAttribute('aria-label', path + label);
                    input.required = req;
                    labelNode.appendChild(input);
                    wrap.appendChild(labelNode);
                }
                if (spec.description)
                    wrap.appendChild(el('small', { text: spec.description }));
                parent.appendChild(wrap);
                readers.push({ key: key, read: read, required: req, label: label });
            });
            return function () { var result = {}; readers.forEach(function (r) { var v = r.read(); if (r.required && v === undefined)
                throw new Error('请填写 ' + r.label); if (v !== undefined)
                result[r.key] = v; }); return result; };
        }
        function renderComputer() {
            var computer = Object.assign({}, session.devices.computer || {}, { mode: computerMode() }), pane = el('div', { cls: 'device-computer' }), toolbar = el('div', { cls: 'device-computer-toolbar' }), side = el('aside', { cls: 'device-side-note' });
            toolbar.append(el('div', { cls: 'device-computer-title' }, [glyph(computer.mode === 'docker' || computer.mode === 'virtual' ? 'terminal' : 'computer'), el('strong', { text: computer.mode === 'virtual' ? '世界内终端' : computer.mode === 'docker' ? '工作终端' : computer.mode === 'remote_desktop' ? '远程桌面' : '电脑' })]));
            toolbar.append(toolButton('打开电脑', 'open_computer', {}, null, 'device-button device-button-soft', 'power'), toolButton('关闭电脑', 'close_computer', {}, null, 'device-button', 'close'));
            pane.appendChild(toolbar);
            workspace.append(pane, side);
            side.append(el('span', { cls: 'device-eyebrow', text: 'THE DESK SPACE' }), el('h2', { text: computer.mode === 'virtual' ? '故事中的电脑' : computer.mode === 'docker' ? '让想法开始运行' : '另一扇窗口' }), el('p', { text: computer.mode === 'virtual' ? '这是世界内的虚拟电脑，终端与文件操作由世界模型模拟。这里的输出来自工具回执。' : computer.mode === 'docker' ? '命令在 Bot 的 Docker 电脑中执行，结果会保留在这次会话里。' : computer.mode === 'remote_desktop' ? '屏幕来自实际连接的远程电脑。接管后，点击画面即可操作。' : '配置一台电脑后，可以在这里使用终端或远程桌面。' }));
            if (computer.mode === 'off') {
                pane.appendChild(empty('这张书桌还没有电脑', '在设置中启用 Docker 终端或远程桌面。', 'computer'));
                return;
            }
            var facts = el('div', { cls: 'device-facts' }, [el('span', { text: '实现方式' }), el('strong', { text: computer.mode === 'virtual' ? '世界模型模拟' : computer.mode === 'docker' ? 'Docker' : 'VNC' })]);
            side.appendChild(facts);
            if (computer.mode === 'docker' || computer.mode === 'virtual')
                renderTerminal(pane, computer);
            else
                renderRemote(pane, side);
        }
        function renderTerminal(pane, computer) {
            var docker = computer.docker || {}, stats = el('div', { cls: 'device-terminal-status' }, [el('span', { cls: 'device-presence' + ((computer.mode === 'virtual' ? computer.on : docker.running) ? '' : ' device-presence-off') }), el('span', { text: computer.mode === 'virtual' ? (computer.on ? '虚拟电脑已打开 · 模型模拟' : '虚拟电脑尚未打开 · 模型模拟') : docker.error || (docker.running ? '容器运行中' : docker.exists ? '容器已停止' : '尚未创建容器') }), el('small', { text: docker.name || '' })]);
            terminalLog = el('div', { cls: 'device-terminal-log', role: 'log', 'aria-label': '终端输出', tabindex: '0' });
            if (!terminalEntries.length)
                terminalLog.appendChild(el('div', { cls: 'device-terminal-welcome', text: '工作终端\n' + (docker.image ? docker.image + '\n' : '') + (computer.on ? '输入命令继续。' : '打开电脑后，输入命令开始。') }));
            terminalEntries.forEach(renderTerminalEntry);
            var command = field('输入命令…', drafts.command, { 'aria-label': '终端命令', autocomplete: 'off', spellcheck: 'false' });
            command.addEventListener('input', function () { drafts.command = command.value; });
            command.addEventListener('keydown', function (e) { if (e.key === 'ArrowUp') {
                e.preventDefault();
                historyIndex = Math.max(0, historyIndex - 1);
                command.value = history[historyIndex] || '';
            }
            else if (e.key === 'ArrowDown') {
                e.preventDefault();
                historyIndex = Math.min(history.length, historyIndex + 1);
                command.value = history[historyIndex] || '';
            } });
            var form = appForm(async function () {
                var cmd = command.value.trim();
                if (!cmd)
                    return;
                history.push(cmd);
                historyIndex = history.length;
                var entry = { command: cmd, text: '执行中…', pending: true };
                terminalEntries.push(entry);
                if (terminalEntries.length > 200)
                    terminalEntries.shift();
                renderTerminalEntry(entry);
                command.value = '';
                drafts.command = '';
                try {
                    var r = await perform('run_command', { command: cmd });
                    entry.text = textOf(r.content || r.text);
                    entry.pending = false;
                }
                catch (err) {
                    entry.text = err.message || String(err);
                    entry.error = true;
                    entry.pending = false;
                }
                if (live && terminalLog) {
                    terminalLog.replaceChildren();
                    terminalEntries.forEach(renderTerminalEntry);
                }
            });
            form.classList.add('device-terminal-prompt');
            form.append(el('span', { text: '›', 'aria-hidden': 'true' }), mutation(command, 'run_command'), mutation(el('button', { type: 'submit', cls: 'device-terminal-run', text: '运行' }), 'run_command'));
            pane.append(stats, terminalLog, form);
            var tools = el('div', { cls: 'device-terminal-actions' }, [button('清空显示', function () { terminalEntries = []; if (terminalLog)
                    terminalLog.replaceChildren(); }, 'device-button')]);
            pane.append(tools);
            renderComputerTools(pane);
        }
        function renderComputerTools(pane) {
            var tools = (session.tools || []).filter(function (t) { return t.device === 'computer' && !['open_computer', 'close_computer', 'run_command', 'screen', 'mouse', 'keyboard'].some(function (name) { return t.name === name || t.name.endsWith('.' + name); }); });
            if (!tools.length)
                return;
            var section = el('div', { cls: 'device-computer-tools' }, [el('h3', { text: '文件与其他工具' })]), output = el('div', { cls: 'device-tool-output', 'aria-live': 'polite' });
            tools.forEach(function (tool) {
                var card = el('details', { cls: 'app-tool-card' }, [el('summary', {}, [el('strong', { text: tool.name }), el('span', { text: tool.effect === 'read' ? '读取' : '操作' })]), el('p', { cls: 'app-tool-description', text: tool.description || '' })]), form = el('form', { cls: 'app-schema-form' }), schema = tool.inputSchema || {}, collect;
                if (schema.properties || schema.type === 'object' && schema.additionalProperties === false)
                    collect = schemaFields(form, schema, {}, '');
                else {
                    var json = el('textarea', { cls: 'app-schema-json', rows: '4', 'aria-label': tool.name + ' JSON 参数' });
                    json.value = '{}';
                    form.appendChild(json);
                    collect = function () { var value = JSON.parse(json.value); if (!value || Array.isArray(value) || typeof value !== 'object')
                        throw new Error('参数必须为 JSON 对象'); return value; };
                }
                form.appendChild(mutation(el('button', { type: 'submit', cls: 'device-button device-button-soft', text: '执行' }), tool.name, 'computer'));
                form.addEventListener('submit', async function (event) { event.preventDefault(); try {
                    var r = await perform(tool.name, collect(), { device: 'computer', confirmSend: tool.effect === 'send' });
                    if (live)
                        showResult(output, r);
                }
                catch (err) {
                    report(err);
                } });
                card.appendChild(form);
                section.appendChild(card);
            });
            section.appendChild(output);
            pane.appendChild(section);
        }
        function renderTerminalEntry(entry) { if (!terminalLog)
            return; terminalLog.appendChild(el('div', { cls: 'device-terminal-entry' + (entry.error ? ' device-terminal-error' : '') }, [el('div', { cls: 'device-terminal-command', text: '› ' + entry.command }), el('pre', { text: entry.text })])); terminalLog.scrollTop = terminalLog.scrollHeight; }
        function renderRemote(pane, side) {
            var stage = el('div', { cls: 'device-remote-stage', tabindex: '0', 'aria-label': '远程桌面，点击聚焦后可使用键盘' });
            remoteImage = el('img', { cls: 'device-remote-image', alt: '实时远程桌面', draggable: 'false' });
            remoteStatus = el('div', { cls: 'device-remote-placeholder', text: '等待连接真实桌面…', 'aria-live': 'polite' });
            stage.append(remoteImage, remoteStatus);
            pane.append(stage);
            var touchMode = 'pointer', toolbar = el('div', { cls: 'device-remote-toolbar' }), mode = button('触屏：指针', function () { touchMode = touchMode === 'pointer' ? 'scroll' : 'pointer'; mode.querySelector('span').textContent = '触屏：' + (touchMode === 'pointer' ? '指针' : '滚动'); }, 'device-button', 'hand');
            toolbar.append(button('刷新画面', captureScreen, 'device-button', 'refresh'), mode, button('全屏', function () { if (document.fullscreenElement)
                document.exitFullscreen().catch(report);
            else if (stage.requestFullscreen)
                stage.requestFullscreen().catch(report); }, 'device-button', 'expand'));
            pane.append(toolbar);
            var keys = el('div', { cls: 'device-remote-keys' });
            ['esc', 'tab', 'enter', 'backspace'].forEach(function (key) { keys.appendChild(mutation(button({ esc: 'Esc', tab: 'Tab', enter: 'Enter', backspace: '⌫' }[key], function () { remoteInput('keyboard', { action: 'key', key: key }); }, 'device-key'), 'keyboard')); });
            keys.appendChild(mutation(button('Ctrl + Alt + Del', function () { remoteInput('keyboard', { action: 'combo', keys: ['ctrl', 'alt', 'delete'] }); }, 'device-key'), 'keyboard'));
            pane.append(keys);
            var text = el('textarea', { cls: 'device-remote-text', rows: '2', placeholder: '中文、长文本可在这里输入，再发送到远程焦点位置。', 'aria-label': '向远程桌面输入文本' }), send = mutation(button('输入文本', function () { if (!text.value)
                return; var value = text.value; remoteInput('keyboard', { action: 'type', text: value }).then(function (ok) { if (ok && live)
                text.value = ''; }); }, 'device-button device-button-primary', 'send'), 'keyboard');
            pane.append(el('div', { cls: 'device-remote-composer' }, [text, send]));
            side.append(el('p', { cls: 'device-help', text: '点击选择 · 双击打开 · 拖动移动\n右键菜单 · 滚轮滚动\n触屏可切换指针 / 滚动模式\n中文输入请使用画面下方的输入框。' }));
            function point(event) { if (!remoteImage || !screenWidth || !screenHeight)
                return null; var rect = remoteImage.getBoundingClientRect(); if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)
                return null; return { x: Math.min(screenWidth - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * screenWidth))), y: Math.min(screenHeight - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * screenHeight))) }; }
            stage.addEventListener('pointerdown', function (event) { if (!controlled() || !remoteReady || !available('mouse'))
                return; var p = point(event); if (!p)
                return; event.preventDefault(); stage.focus(); stage.setPointerCapture(event.pointerId); pointer = { id: event.pointerId, start: p, last: p, button: event.button, touch: event.pointerType === 'touch', time: Date.now() }; });
            stage.addEventListener('pointermove', function (event) { if (!pointer || pointer.id !== event.pointerId)
                return; var p = point(event); if (p)
                pointer.last = p; });
            stage.addEventListener('pointerup', function (event) {
                if (!pointer || pointer.id !== event.pointerId)
                    return;
                var p = point(event) || pointer.last, start = pointer.start, touch = pointer.touch, which = pointer.button, held = Date.now() - pointer.time;
                pointer = null;
                try {
                    stage.releasePointerCapture(event.pointerId);
                }
                catch (_) { }
                var dx = p.x - start.x, dy = p.y - start.y, moved = Math.abs(dx) + Math.abs(dy) > 6;
                if (touch && touchMode === 'scroll' && moved) {
                    remoteInput('mouse', { action: 'scroll', x: start.x, y: start.y, direction: Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 'up' : 'down') : (dx > 0 ? 'left' : 'right'), times: Math.min(12, Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / 50))) });
                }
                else if (moved)
                    remoteInput('mouse', { action: 'drag', x: start.x, y: start.y, x2: p.x, y2: p.y, button: which === 2 ? 'right' : 'left' });
                else if (which !== 2) {
                    if (touch && held > 550)
                        remoteInput('mouse', { action: 'right_click', x: p.x, y: p.y });
                    else if (clickTimer && clickPoint && Math.abs(clickPoint.x - p.x) + Math.abs(clickPoint.y - p.y) < 10) {
                        clearTimeout(clickTimer);
                        clickTimer = null;
                        clickPoint = null;
                        remoteInput('mouse', { action: 'double_click', x: p.x, y: p.y });
                    }
                    else {
                        if (clickTimer) {
                            clearTimeout(clickTimer);
                            remoteInput('mouse', { action: 'click', x: clickPoint.x, y: clickPoint.y });
                        }
                        clickPoint = p;
                        clickTimer = setTimeout(function () { clickTimer = null; clickPoint = null; remoteInput('mouse', { action: 'click', x: p.x, y: p.y }); }, 260);
                    }
                }
            });
            stage.addEventListener('pointercancel', function () { pointer = null; });
            stage.addEventListener('contextmenu', function (event) { var p = point(event); if (!controlled() || !p)
                return; event.preventDefault(); remoteInput('mouse', { action: 'right_click', x: p.x, y: p.y }); });
            // Pointer taps are coalesced above so the remote receives a real double-click, not three delayed clicks.
            stage.addEventListener('wheel', function (event) { var p = point(event); if (!controlled() || !remoteReady || !p)
                return; event.preventDefault(); var delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX; remoteInput('mouse', { action: 'scroll', x: p.x, y: p.y, direction: Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? (delta > 0 ? 'down' : 'up') : (delta > 0 ? 'right' : 'left'), times: Math.min(6, Math.max(1, Math.ceil(Math.abs(delta) / 100))) }); }, { passive: false });
            stage.addEventListener('keydown', function (event) {
                if (!controlled() || !remoteReady || !available('keyboard') || event.isComposing || event.key === 'Process' || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key))
                    return;
                if (event.key === 'Escape' && document.fullscreenElement)
                    return;
                var map = { Enter: 'enter', Escape: 'esc', Backspace: 'backspace', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', ' ': 'space' }, key = map[event.key] || event.key.toLowerCase();
                if (event.key.length > 1 && !map[event.key] && !/^F\d+$/.test(event.key))
                    return;
                event.preventDefault();
                if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey && event.key.length > 1) {
                    var combo = [];
                    if (event.ctrlKey)
                        combo.push('ctrl');
                    if (event.altKey)
                        combo.push('alt');
                    if (event.metaKey)
                        combo.push('super');
                    if (event.shiftKey)
                        combo.push('shift');
                    combo.push(key);
                    remoteInput('keyboard', { action: 'combo', keys: combo });
                }
                else if (event.key.length === 1)
                    remoteInput('keyboard', { action: 'type', text: event.key });
                else
                    remoteInput('keyboard', { action: 'key', key: key });
            });
        }
        function remoteInput(name, args) {
            var epoch = screenGeneration, inputToken = inputEpoch;
            remotePending++;
            remoteQueue = remoteQueue.then(async function () { try {
                if (!live || inputToken !== inputEpoch || epoch !== screenGeneration || !controlled() || !remoteReady || !available(name))
                    return false;
                await perform(name, args, { quiet: true });
                if (live)
                    captureScreen();
                return true;
            }
            catch (err) {
                report(err);
                return false;
            }
            finally {
                remotePending--;
                if (live && !remotePending)
                    refresh(false);
            } });
            return remoteQueue;
        }
        async function captureScreen() {
            if (!live || screenBusy || tab !== 'computer' || !remoteImage || !session.devices.computer.on || !(session.devices.computer.remote && session.devices.computer.remote.connected) || document.hidden)
                return;
            screenBusy = true;
            var epoch = screenGeneration;
            screenAbort = new AbortController();
            try {
                var response = await fetch(withToken('/api/computer/screen?w=1600&t=' + Date.now()), { signal: screenAbort.signal, cache: 'no-store' });
                if (!response.ok) {
                    var problem = await response.json().catch(function () { return {}; });
                    throw new Error(problem.error || '无法读取远程画面（' + response.status + '）');
                }
                var blob = await response.blob();
                if (!live || epoch !== screenGeneration)
                    return;
                var previous = screenUrl;
                screenUrl = URL.createObjectURL(blob);
                remoteImage.src = screenUrl;
                screenWidth = Number(response.headers.get('x-desktop-width')) || Number(response.headers.get('x-screen-width')) || 0;
                screenHeight = Number(response.headers.get('x-desktop-height')) || Number(response.headers.get('x-screen-height')) || 0;
                remoteImage.onload = function () { if (!screenWidth)
                    screenWidth = remoteImage.naturalWidth; if (!screenHeight)
                    screenHeight = remoteImage.naturalHeight; };
                remoteImage.classList.add('device-remote-loaded');
                remoteStatus.hidden = true;
                if (previous)
                    URL.revokeObjectURL(previous);
            }
            catch (err) {
                if (live && epoch === screenGeneration && err.name !== 'AbortError') {
                    remoteStatus.hidden = false;
                    remoteStatus.textContent = err.message || String(err);
                }
            }
            finally {
                if (epoch === screenGeneration) {
                    screenBusy = false;
                    screenAbort = null;
                }
            }
        }
        function stopScreen() { inputEpoch++; if (clickTimer)
            clearTimeout(clickTimer); clickTimer = null; clickPoint = null; screenGeneration++; screenBusy = false; remoteReady = false; pointer = null; if (screenTimer)
            clearInterval(screenTimer); screenTimer = null; if (screenAbort)
            screenAbort.abort(); screenAbort = null; if (screenUrl)
            URL.revokeObjectURL(screenUrl); screenUrl = null; screenWidth = 0; screenHeight = 0; if (remoteImage) {
            remoteImage.removeAttribute('src');
            remoteImage.classList.remove('device-remote-loaded');
        } if (remoteStatus)
            remoteStatus.hidden = false; }
        workspace.appendChild(empty('正在连接设备', '读取当前设备与应用状态…', 'phone'));
        refresh(true);
        polling = setInterval(function () { if (!document.hidden && !busy && !remotePending)
            refresh(false); }, 5000);
        return function () { live = false; generation++; clearInterval(polling); stopScreen(); root.remove(); };
    });
})();
