/* Navigation, shared state and overview. Domain views register independently. */
var Studio = (function () {
    var views = new Map(), clean = null, epoch = 0, overviewRequest = null, started = false;
    var cache = { world: null, growth: null }, selectedEntity = null;
    var oldSwitch = switchView;
    var routes = [
        { group: '探索世界' },
        ['overview', '世界总览', 'gauge', ['overview']],
        ['world', '世界关系图', 'world'],
        ['growth', '角色与成长', 'growth', ['notes']],
        ['devices', '设备工作台', 'monitor', ['devices']],
        ['player', '走进世界', 'door', ['__player__']],
        { group: '观察与记录' },
        ['live', '运行洞察', 'activity', ['debug']],
        ['usage', '模型用量', 'chart', ['usage']],
        ['gallery', '相册', 'image', ['gallery']],
        ['data', '记事与存档', 'folder', ['notes', 'archive']],
        { group: '世界管理' },
        ['state', '世界设定', 'file', ['definitions', 'world_status', 'bot_status', 'news', 'facts']],
        ['crossing', '世界连接', 'portal', ['crossing']],
        ['prompts', '提示词', 'edit', ['prompts']],
        ['config', '偏好与配置', 'sliders', ['config']],
        ['visitors', '访问管理', 'users', ['config']],
        ['media', '媒体文件', 'film', ['gallery']]
    ];
    Object.assign(ICONS, {
        layers: svgIcon('<path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>'),
        message: svgIcon('<path d="M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z"/><path d="M7 8h9M7 12h6"/>'),
        world: svgIcon('<path d="M16 3.8A9 9 0 1 0 20.6 15M5.5 15.5C10 15 13 10 14 6M7 18c6 0 10-4 14-9"/><circle cx="19.5" cy="4.5" r="1.5"/>'),
        growth: svgIcon('<path d="M12 21V10M12 15C5 15 3 10 3 6c6 0 9 3 9 9ZM12 11c0-6 4-8 9-8 0 5-3 8-9 8Z"/>'),
        search: svgIcon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'),
        arrow: svgIcon('<path d="M5 12h14m-5-5 5 5-5 5"/>'),
        refresh: svgIcon('<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>'),
        sun: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>'),
        moon: svgIcon('<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z"/>'),
        play: svgIcon('<path d="m9 5 10 7-10 7Z"/>'),
        pause: svgIcon('<path d="M8 5v14M16 5v14"/>'),
        phone: svgIcon('<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4m-3 14h2"/>'),
        link: svgIcon('<path d="m9 15 6-6M7 14l-2 2a4 4 0 0 0 6 6l3-3M10 5l3-3a4 4 0 0 1 6 6l-2 2" transform="translate(0 -1)"/>'),
        box: svgIcon('<path d="m12 3 9 5v9l-9 5-9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v9"/>'),
        user: svgIcon('<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>'),
        chevron: svgIcon('<path d="m9 5 7 7-7 7"/>'),
        close: svgIcon('<path d="m6 6 12 12M6 18 18 6"/>'),
        shield: svgIcon('<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>')
    });
    NAV = routes;
    function routeFor(name) { if (name === 'debug') name = 'live'; if (name === 'commands') name = 'overview'; return routes.find(function (r) { return r[0] === name; }); }
    function can(name) { var r = routeFor(name); return !!r && visitorCanSee(r[3]); }
    function firstRoute() { return (routes.find(function (r) { return !r.group && visitorCanSee(r[3]); }) || ['overview'])[0]; }
    function register(name, render) { views.set(name, render); }
    function navigate(name) {
        if (name === 'debug') name = 'live';
        if (name === 'commands') name = 'overview';
        if (!can(name))
            name = firstRoute();
        if (cfgDirty && activeView === 'config' && name !== 'config' && !confirm('配置有未保存的修改，仍要离开吗？'))
            return;
        var version = ++epoch;
        if (clean) {
            try {
                clean();
            }
            catch (e) {
                console.warn(e);
            }
            clean = null;
        }
        clearViewTimers();
        closeDrawer();
        activeView = name;
        if (location.hash !== '#' + name)
            history.pushState(null, '', '#' + name);
        buildNav();
        $('#route-title').textContent = (routeFor(name) || ['', '世界总览'])[1];
        document.title = $('#route-title').textContent + ' · YesImBot World';
        var main = $('#main');
        main.replaceChildren();
        main.className = 'anim';
        if (views.has(name)) {
            var holder = el('div', { cls: 'studio-view', 'data-view': name });
            main.appendChild(holder);
            try {
                Promise.resolve(views.get(name)(holder)).then(function (cleanup) {
                    if (typeof cleanup !== 'function')
                        return;
                    if (version !== epoch)
                        cleanup();
                    else
                        clean = cleanup;
                }).catch(function (e) { if (version === epoch)
                    error(holder, e, function () { navigate(name); }); });
            }
            catch (e) {
                error(holder, e, function () { navigate(name); });
            }
        }
        else
            oldSwitch(name);
        window.scrollTo({ top: 0 });
    }
    switchView = navigate;
    buildNav = function () {
        var nav = $('#nav');
        nav.replaceChildren();
        routes.forEach(function (r, i) {
            if (r.group) {
                var children = [];
                for (var j = i + 1; j < routes.length && !routes[j].group; j++)
                    children.push(routes[j]);
                if (children.some(function (a) { return visitorCanSee(a[3]); }))
                    nav.appendChild(el('div', { cls: 'nav-group', text: r.group }));
                return;
            }
            if (!visitorCanSee(r[3]))
                return;
            nav.appendChild(el('a', { href: '#' + r[0], cls: r[0] === activeView ? 'active' : '', 'aria-current': r[0] === activeView ? 'page' : 'false', onclick: function (e) { e.preventDefault(); navigate(r[0]); } }, [el('span', { cls: 'ico', html: icon(r[2]) }), el('span', { text: r[1] })]));
        });
        var mobile = $('#mobile-nav');
        mobile.replaceChildren();
        ['overview', 'world', 'devices', 'player', 'live'].filter(can).slice(0, 5).forEach(function (name) {
            var r = routeFor(name);
            mobile.appendChild(el('a', { href: '#' + name, cls: activeView === name ? 'active' : '', 'aria-current': activeView === name ? 'page' : 'false', onclick: function (e) { e.preventDefault(); navigate(name); } }, [el('span', { html: icon(r[2]) }), el('span', { text: { overview: '总览', world: '世界', devices: '设备', player: '入世界', live: '洞察', debug: '洞察' }[name] })]));
        });
        $('#account-name').textContent = isVisitor() ? (VISITOR_PRESET === 'player' ? '世界中的旅人' : '世界访客') : '世界管理员';
        $('#account-role').textContent = isVisitor() ? (VISITOR_PRESET === 'player' ? '体验与互动' : '按授权范围观测') : '管理与观测';
        document.body.classList.toggle('visitor-readonly', isVisitor());
    };
    function observeMobileNavigation() {
        var nav = $('#mobile-nav');
        // Include wrapped labels and the device safe area; desktop display:none yields zero.
        function measure() {
            document.documentElement.style.setProperty('--mobile-nav-height', nav.getBoundingClientRect().height + 'px');
        }
        if (typeof ResizeObserver === 'function')
            new ResizeObserver(measure).observe(nav, { box: 'border-box' });
        else
            window.addEventListener('resize', measure);
        measure();
    }
    function dispatch(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail: detail })); }
    refreshOverview = function () {
        if (overviewRequest)
            return overviewRequest;
        overviewRequest = api('GET', '/api/overview').then(function (o) {
            lastOverview = o;
            VERSION = o.version || VERSION;
            renderTopbar(o);
            var when = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            $('#footer-sync').textContent = '最近同步 ' + when;
            dispatch('studio:overview', o);
            return o;
        }).finally(function () { overviewRequest = null; });
        return overviewRequest;
    };
    var oldRenderTopbar = renderTopbar;
    renderTopbar = function (o) { oldRenderTopbar(o); $('#world-pill').textContent = !o.initialized ? '等待创世' : o.worldRunning ? '世界运行中' : '世界已暂停'; };
    connectSSE = function () {
        if (evtSource) {
            evtSource.close();
            evtSource = null;
        }
        if (isVisitor() && !visitorCanSee(['debug'])) {
            $('#sse-dot').className = 'on';
            $('#connection-label').textContent = '定时同步';
            return;
        }
        evtSource = new EventSource(withToken('/api/events?since=' + lastEventId));
        evtSource.onopen = function () { $('#sse-dot').className = 'on'; $('#connection-label').textContent = '实时连接'; dispatch('studio:connection', { connected: true }); };
        evtSource.onerror = function () { $('#sse-dot').className = 'off'; $('#connection-label').textContent = '正在重连'; dispatch('studio:connection', { connected: false }); };
        evtSource.onmessage = function (event) {
            var msg;
            try {
                msg = JSON.parse(event.data);
            }
            catch (_) {
                return;
            }
            // Server restart can reset the in-memory debug sequence.
            if (msg.channel === 'hello' && Number.isFinite(msg.snapshot)) {
                lastEventId = msg.snapshot;
                dispatch('studio:connection', { connected: true });
            }
            else if (event.lastEventId)
                lastEventId = Math.max(lastEventId, Number(event.lastEventId) || 0);
            localStorage.setItem('wui_last_id', String(lastEventId));
            if (msg.channel === 'debug') {
                dispatch('studio:debug', msg.entry);
            }
            else if (msg.channel === 'file' || msg.channel === 'lifecycle') {
                dispatch('studio:refresh', msg);
                refreshOverview(false).catch(function () { });
                if (!views.has(activeView))
                    onFileSignal(msg.file || '');
            }
        };
    };
    function title(eyebrow, name, description, actions) {
        return el('div', { cls: 'studio-page-head' }, [el('div', null, [el('div', { cls: 'studio-eyebrow', text: eyebrow }), el('h1', { cls: 'studio-title', text: name }), el('p', { cls: 'studio-description', text: description })]), actions ? el('div', { cls: 'studio-page-actions' }, actions) : null]);
    }
    function button(text, image, action, primary) { return el('button', { cls: primary ? 'primary' : '', onclick: action }, [image ? el('span', { html: icon(image) }) : null, el('span', { text: text })]); }
    function empty(name, description, action) {
        return el('div', { cls: 'studio-empty' }, [el('div', { html: worldArt.empty({ decorative: true }) }), el('strong', { text: name }), el('p', { text: description }), action || null]);
    }
    function error(holder, e, retry) { holder.replaceChildren(el('div', { cls: 'studio-error' }, [el('strong', { text: '暂时无法读取这部分内容' }), el('p', { text: e.message || String(e) }), retry ? button('重新加载', 'refresh', retry) : null])); }
    function section(name, note, action) { return el('div', { cls: 'studio-section-title' }, [el('h3', { text: name }), action || el('small', { text: note || '' })]); }
    function fetchWorld() { return api('GET', '/api/world/state').then(function (r) { cache.world = r.state; return r.state; }); }
    function fetchGrowth() { return api('GET', '/api/bot/growth').then(function (r) { cache.growth = r.growth || []; return cache.growth; }); }
    function inspectEntity(id) { selectedEntity = id; navigate('world'); }
    function commandPalette() {
        var input = el('input', { cls: 'studio-search-input', placeholder: '搜索页面、角色、地点、物件…', 'aria-label': '搜索页面和实体' });
        var list = el('div', { cls: 'studio-search-results' });
        var holder = el('div', null, [input, list]);
        function results() {
            list.replaceChildren();
            var q = input.value.trim().toLowerCase();
            routes.filter(function (r) { return !r.group && can(r[0]) && (r[0] + r[1]).toLowerCase().includes(q); }).forEach(function (r) {
                list.appendChild(el('button', { cls: 'studio-search-result', onclick: function () { hideModal(); navigate(r[0]); } }, [el('span', { html: icon(r[2]) }), el('span', { text: r[1] }), el('small', { text: '页面' })]));
            });
            if (!isVisitor() && q && cache.world)
                Object.values(cache.world.snapshot.entities).filter(function (e) { return (e.id + e.name).toLowerCase().includes(q); }).slice(0, 12).forEach(function (entity) {
                    list.appendChild(el('button', { cls: 'studio-search-result', onclick: function () { hideModal(); inspectEntity(entity.id); } }, [el('span', { html: icon(entity.kind === 'actor' ? 'user' : entity.kind === 'place' ? 'world' : 'box') }), el('span', { text: entity.name }), el('small', { text: entity.id })]));
                });
            if (!list.childElementCount)
                list.appendChild(empty('没有找到匹配项', '试试页面名称，或已加载实体的名称与 ID。'));
        }
        input.addEventListener('input', results);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter')
            list.querySelector('button')?.click(); });
        results();
        showModal('快速前往', holder);
        input.focus();
    }
    function art() { return worldArt.hero(); }
    function avatar() { return '<svg viewBox="0 0 60 70" fill="none" aria-hidden="true"><path d="M12 70V51c0-17 36-17 36 0v19Z" fill="#3c847e"/><path d="M17 38V24c0-19 26-19 26 0v14Z" fill="#253b50"/><ellipse cx="30" cy="30" rx="13" ry="16" fill="#e9bc9b"/><path d="M17 28V18c3-14 25-12 27 2l-1 10-8-13-18 11Z" fill="#253b50"/><circle cx="25" cy="29" r="1" fill="#253b50"/><circle cx="36" cy="29" r="1" fill="#253b50"/><path d="M28 36c2 1 4 1 6-1" stroke="#ac755d" stroke-linecap="round"/><path d="m24 46 6 8 7-8" stroke="#9aebd8" stroke-width="2"/></svg>'; }
    function botAvatar(identity) {
        var holder = el('div', { cls: 'studio-avatar', html: avatar() });
        if (!identity?.avatar) return holder;
        try {
            var url = new URL(identity.avatar, location.href);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return holder;
            var photo = el('img', { src: url.href, alt: (identity.name || 'Bot') + '的平台头像', referrerpolicy: 'no-referrer', decoding: 'async', onerror: function () { holder.innerHTML = avatar(); } });
            holder.title = identity.platform + ' · ' + identity.name;
            holder.replaceChildren(photo);
        } catch (_) {}
        return holder;
    }
    function kpi(label, value, note, img) { return el('div', { cls: 'studio-kpi' }, [el('span', { cls: 'label', text: label }), el('span', { cls: 'number', text: value }), el('span', { cls: 'note', text: note }), el('span', { cls: 'kpi-icon', html: icon(img) })]); }
    function row(key, value) { return el('div', { cls: 'studio-detail-row' }, [el('span', { text: key }), el('span', { text: value })]); }
    function panel() { return el('section', { cls: 'studio-panel' }); }
    function renderOverviewView(holder) {
        var alive = true, refreshing = false;
        var liveHost = can('live') && window.LiveCalls ? el('div', { cls: 'studio-live-overview' }) : null;
        var liveCleanup = liveHost ? window.LiveCalls.mount(liveHost, { compact: true }) : null;
        // Keep the welcome actions and their open popover connected during live refreshes.
        var headingHost = el('div'), heroHost = el('div'), bodyHost = el('div'), currentOverview = null, worldActionPending = false;
        var hero = el('section', { cls: 'studio-hero' }), eyebrow = el('div', { cls: 'studio-eyebrow' }), welcome = el('h2'), introduction = el('p');
        var heroCopy = el('div', { cls: 'studio-hero-copy' }, [eyebrow, welcome, introduction]);
        var actions = el('div', { cls: 'studio-hero-actions' });
        var worldButton = !isVisitor() ? button('正在加载…', 'activity', function () {
            var o = currentOverview;
            if (!o || worldActionPending) return;
            if (!o.initialized) { navigate('state'); return; }
            worldActionPending = true; updateWorldButton();
            api('POST', '/api/world/' + (o.worldRunning ? 'stop' : 'start'), {}).then(function (r) { toast(r.text || '已完成', 'ok'); refresh(); }).catch(showErr).finally(function () { worldActionPending = false; updateWorldButton(); });
        }, true) : null;
        if (worldButton) actions.appendChild(worldButton);
        if (can('world')) actions.appendChild(button('探索关系图', 'arrow', function () { navigate('world'); }));
        else if (can('devices')) actions.appendChild(button('打开设备', 'phone', function () { navigate('devices'); }));
        var commandCleanup = !isVisitor() && window.WorldCommands ? window.WorldCommands.mount(actions) : null;
        heroCopy.appendChild(actions);
        hero.append(heroCopy, el('div', { cls: 'studio-hero-visual', html: art() }), el('span', { cls: 'studio-hero-footnote', text: 'POSSIBILITIES / UNFOLDING' }));
        holder.append(headingHost, heroHost);
        function updateWorldButton() {
            if (!worldButton || !currentOverview) return;
            var o = currentOverview;
            worldButton.disabled = worldActionPending;
            worldButton.firstChild.innerHTML = icon(!o.initialized ? 'edit' : o.worldRunning ? 'pause' : 'play');
            worldButton.lastChild.textContent = worldActionPending ? '正在处理…' : !o.initialized ? '准备世界设定' : o.worldRunning ? '暂停世界' : '继续世界';
        }
        if (liveHost) holder.appendChild(liveHost);
        holder.appendChild(bodyHost);
        bodyHost.appendChild(el('div', { cls: 'studio-skeleton' }));
        function refresh() {
            if (!alive || refreshing || document.hidden)
                return;
            refreshing = true;
            var worldPromise = isVisitor() ? Promise.resolve(null) : fetchWorld().catch(function () { return null; });
            var growthPromise = can('growth') ? fetchGrowth().catch(function () { return []; }) : Promise.resolve([]);
            Promise.all([refreshOverview(false), worldPromise, growthPromise]).then(function (result) { if (alive)
                draw(result[0], result[1], result[2]); }).catch(function (e) { if (alive)
                error(bodyHost, e, refresh); }).finally(function () { refreshing = false; });
        }
        function draw(o, world, growth) {
            var snapshot = world?.snapshot, entities = Object.values(snapshot?.entities || {}), events = world?.events || [], bot = snapshot?.entities.bot;
            var running = Object.values(snapshot?.actions || {}).filter(function (a) { return a.status === 'pending'; });
            headingHost.replaceChildren(title('AN OPEN WORLD, ALWAYS BECOMING', '世界总览', '看见世界如何变化，也参与角色的每一个当下。', [button('走进世界', 'door', function () { navigate('player'); }, true)].filter(function () { return can('player'); })));
            currentOverview = o;
            eyebrow.textContent = o.initialized ? 'OPEN WORLDS / 无界的可能' : 'OPEN WORLDS / 从此刻生长';
            welcome.textContent = o.initialized ? '你好，欢迎回来。' : '从一个世界开始。';
            introduction.textContent = !o.initialized ? '写下角色与世界设定，让第一组事实成为故事的起点。' : o.worldRunning ? '世界正在运转。观察发生了什么，或拿起设备，与角色共享此刻。' : '世界目前未运行。你可以先探索已有状态，再继续角色的生活。';
            updateWorldButton();
            if (!heroHost.contains(hero)) heroHost.appendChild(hero);
            bodyHost.replaceChildren();
            bodyHost.appendChild(el('div', { cls: 'studio-kpi-row' }, [
                kpi('世界实体', snapshot ? entities.length : '—', snapshot ? entities.filter(function (e) { return e.kind === 'place'; }).length + ' 个地点 · ' + entities.filter(function (e) { return e.kind === 'object'; }).length + ' 件物品' : '完整世界仅管理员可见', 'world'),
                kpi('正在行动', snapshot ? running.length : o.worldQueue, snapshot ? '已开始、尚未结束的动作' : '等待世界裁定的任务', 'activity'),
                kpi('角色认识', can('growth') ? growth.length : '—', growth.filter(function (g) { return g.status === 'contested'; }).length + ' 条认识存在反证', 'growth'),
                kpi('世界版本', snapshot ? '#' + snapshot.sequence : '—', '每次提交留下可追溯记录', 'layers')
            ]));
            var left = el('div', { cls: 'studio-stack' }), right = el('div', { cls: 'studio-stack' });
            var map = panel();
            map.appendChild(section('世界关系', '', can('world') ? button('展开地图', 'arrow', function () { navigate('world'); }) : null));
            var mapView = el('div', { cls: 'studio-topology-preview' });
            if (snapshot && entities.length && Studio.drawWorldPreview)
                Studio.drawWorldPreview(mapView, snapshot);
            else
                mapView.appendChild(empty(!o.initialized ? '这里还没有实体' : isVisitor() ? '以角色的视角看世界' : '暂时没有结构化状态', isVisitor() ? '进入世界后，观察你所在的地点与身边事物。' : '世界完成初始化或旧数据迁移后，关系会出现在这里。'));
            map.appendChild(mapView);
            map.appendChild(el('div', { cls: 'studio-topology-caption' }, [el('span', { html: '<i class="studio-dot"></i>地点' }), el('span', { html: '<i class="studio-dot orange"></i>角色' }), el('span', { html: '<i class="studio-dot blue"></i>物件' })]));
            left.appendChild(map);
            var activity = panel();
            activity.appendChild(section('最近发生', 'COMMITTED EVENTS', can('debug') ? button('查看记录', 'arrow', function () { navigate('debug'); }) : null));
            var list = el('div', { cls: 'studio-activity' });
            var items = events.filter(function (e) { return e.kind === 'event'; }).slice(-5).reverse();
            if (items.length)
                items.forEach(function (e) {
                    var p = e.payload || {}, label = e.topic === 'world.speech' ? '一句新的话' : e.topic === 'world.committed' ? '世界状态已更新' : e.topic === 'action.completed' ? '行动完成' : e.topic;
                    var desc = p.text || (e.actorId && snapshot.entities[e.actorId]?.name) || ('事务 #' + e.sequence + ' · ' + e.source);
                    list.appendChild(el('div', { cls: 'studio-activity-item' }, [el('span', { cls: 'studio-activity-mark', html: icon(e.topic === 'world.speech' ? 'message' : 'activity') }), el('div', null, [el('strong', { text: label }), el('p', { text: desc })]), el('time', { text: fmtTime(e.emittedAt) })]));
                });
            else
                (o.news || []).slice(-4).reverse().forEach(function (n) { list.appendChild(el('div', { cls: 'studio-activity-item' }, [el('span', { cls: 'studio-activity-mark', html: icon('file') }), el('div', null, [el('strong', { text: n.text || n.content || '一条世界记录' })]), el('time', { text: n.t == null ? '' : 'T ' + n.t })])); });
            if (!list.childElementCount)
                list.appendChild(empty('等待新的发生', '已提交的变化会按照时间排列在这里。'));
            activity.appendChild(list);
            left.appendChild(activity);
            var character = panel();
            character.appendChild(section('常驻角色', 'RESIDENT'));
            character.appendChild(el('div', { cls: 'studio-bot-card' }, [botAvatar(o.botIdentity), el('div', null, [el('h3', { text: bot?.name || RESIDENT_BOT_NAME || '常驻 Bot' }), el('span', { cls: 'studio-badge', text: o.bot?.paused ? '手动接管中' : o.bot?.running ? '正在自主行动' : o.initialized ? '等待下一刻' : '尚未初始化' })])]));
            character.appendChild(row('所在位置', bot?.location ? snapshot.entities[bot.location]?.name || bot.location : '未知'));
            character.appendChild(row('当前状态', o.bot?.waiting || (running[0]?.intent) || '暂无进行中的意图'));
            var attrs = Object.entries(bot?.attributes || {}).filter(function (a) { return ['posture', 'energy', 'hunger', 'health', 'consciousness'].includes(a[0]); }).slice(0, 3);
            attrs.forEach(function (a) { character.appendChild(row({ posture: '姿态', energy: '精力', hunger: '饥饿', health: '健康', consciousness: '意识状态' }[a[0]], ReadableData.text(a[1].value))); });
            if (can('growth'))
                character.appendChild(button('查看角色成长', 'growth', function () { navigate('growth'); }));
            right.appendChild(character);
            if (can('devices')) {
                var devices = panel();
                devices.appendChild(section('触手可及', 'DEVICES'));
                devices.appendChild(el('div', { cls: 'studio-device-links' }, [el('button', { cls: 'studio-device-tile', onclick: function () { navigate('devices'); } }, [el('span', { html: icon('phone') }), el('strong', { text: '手机' }), el('small', { text: o.phoneDown ? '已放下' : o.appOpen || '桌面' })]), el('button', { cls: 'studio-device-tile', onclick: function () { navigate('devices'); } }, [el('span', { html: icon('monitor') }), el('strong', { text: '电脑' }), el('small', { text: o.computerOn || '尚未打开' })])]));
                right.appendChild(devices);
            }
            var shortcuts = panel();
            shortcuts.appendChild(section('继续探索', 'NEXT'));
            var links = el('div', { cls: 'studio-quick-links' });
            [['state', 'file', '世界设定', '角色与世界规则'], ['growth', 'growth', '成长轨迹', '认识背后的证据'], ['usage', 'chart', '模型用量', '资源与运行趋势']].filter(function (r) { return can(r[0]); }).forEach(function (r) { links.appendChild(el('button', { onclick: function () { navigate(r[0]); } }, [el('span', { html: icon(r[1]) }), el('span', { text: r[2] }), el('small', { text: r[3] })])); });
            shortcuts.appendChild(links);
            if (links.childElementCount)
                left.appendChild(shortcuts);
            bodyHost.appendChild(el('div', { cls: 'studio-overview-grid' }, [left, right]));
        }
        refresh();
        var timer = setInterval(refresh, 12000);
        var onRefresh = function () { refresh(); };
        window.addEventListener('studio:refresh', onRefresh);
        return function () { alive = false; if (liveCleanup) liveCleanup(); if (commandCleanup) commandCleanup(); clearInterval(timer); window.removeEventListener('studio:refresh', onRefresh); };
    }
    register('overview', renderOverviewView);
    // Definitions remain authored text; authoritative structured state lives in its own views.
    register('state', function (holder) {
        var alive = true;
        holder.appendChild(title('AUTHORING THE WORLD', '世界设定', '维护角色定义与世界规则。当前实体状态由世界事务维护。'));
        var content = el('div');
        holder.appendChild(content);
        content.appendChild(el('div', { cls: 'studio-skeleton' }));
        api('GET', '/api/state').then(function (s) {
            if (!alive)
                return;
            stateCache = s;
            RESIDENT_BOT_NAME = s.meta?.botName || RESIDENT_BOT_NAME;
            content.replaceChildren();
            var tabs = el('div', { cls: 'tabs' }), panes = el('div');
            var defs = [['botdef', '角色定义', 'definitions', function () { return statePane('botdef', '角色定义', s.botDef, '/api/definitions/bot'); }], ['worlddef', '世界规则', 'definitions', function () { return statePane('worlddef', '世界规则', s.worldDef, '/api/definitions/world'); }], ['news', '世界新闻', 'news', function () { return jsonlPane('世界新闻', '已保存的世界记录', s.news, '/api/state/news', '新增记录…'); }], ['facts', '记忆记录', 'facts', function () { return jsonlPane('记忆记录', '旧资料与补充记忆；基于观测的成长记录请前往「角色与成长」。', s.facts || [], '/api/state/facts', '新增记录…', { sortable: true, pinnable: true }); }], ['shell', '浏览器外壳', 'world_status', function () { return phoneShellPane(s.phoneShell || '', s.meta || {}); }]].filter(function (d) { return !isVisitor() || visitorCanSee([d[2]]); });
            defs.forEach(function (d, i) { var b = button(d[1], null, function () { Array.from(tabs.children).forEach(function (t) { t.classList.toggle('active', t === b); }); Array.from(panes.children).forEach(function (p, j) { p.classList.toggle('hidden', j !== i); }); }); b.classList.toggle('active', i === 0); tabs.appendChild(b); var pane = el('div', { cls: i ? 'hidden' : '' }, [d[3]()]); panes.appendChild(pane); });
            content.append(tabs, panes);
            if (!defs.length)
                content.appendChild(empty('该账号没有编辑设定的权限', '可从导航中查看已授权的世界内容。'));
            if (!s.initialized && !isVisitor())
                content.appendChild(el('div', { cls: 'studio-panel' }, [el('h3', { text: '准备好开始了吗？' }), el('p', { cls: 'studio-description', text: '先保存上方两份设定，再让 World 模型创建第一组结构化事实。' }), button('创建世界', 'play', function () { worldAction('init', true); }, true)]));
        }).catch(function (e) { if (alive)
            error(content, e, function () { navigate('state'); }); });
        return function () { alive = false; };
    });
    function start() {
        function applyTheme(theme) {
            document.body.dataset.theme = theme;
            document.documentElement.style.colorScheme = theme;
            $('#btn-theme').innerHTML = icon(theme === 'dark' ? 'moon' : 'sun');
            $('meta[name="theme-color"]').content = theme === 'dark' ? '#0b1420' : '#f3f6fa';
        }
        applyTheme(localStorage.getItem('studio_theme') === 'dark' ? 'dark' : 'light');
        $('#btn-theme').onclick = function () { var theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(theme); localStorage.setItem('studio_theme', theme); };
        $('#btn-refresh').innerHTML = icon('refresh');
        $('#btn-refresh').onclick = function () { navigate(activeView); refreshOverview(false).catch(showErr); };
        $('.search-glyph').innerHTML = icon('search');
        $('#studio-command').onclick = commandPalette;
        $('#studio-account').onclick = function () { var holder = el('div', { cls: 'toolbar' }); holder.appendChild(button('切换账号', 'users', function () { hideModal(); promptAuth().then(function (t) { if (t !== null) {
            cache.world = null;
            cache.growth = null;
            buildNav();
            navigate(firstRoute());
            refreshOverview(false).catch(showErr);
        } }); })); if (isVisitor())
            holder.appendChild(button('修改密码', 'sliders', openChangePassword)); holder.appendChild(button('切换深浅主题', 'sun', function () { $('#btn-theme').click(); })); showModal('世界账号', holder); };
        var focusBefore = null;
        var show = showModal;
        var hide = hideModal;
        showModal = function (title, node) { focusBefore = document.activeElement; show(title, node); setTimeout(function () { $('#modal-body').querySelector('input,button,textarea,select,[tabindex]')?.focus(); }, 0); };
        hideModal = function () { if (typeof authCancel === 'function')
            authCancel(); hide(); if (focusBefore?.isConnected)
            focusBefore.focus(); };
        $('#modal-x').onclick = hideModal;
        window.addEventListener('keydown', function (e) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            commandPalette();
        } if (e.key === 'Escape') {
            if ($('#modal').classList.contains('show')) {
                if (authPromise) {
                    var cancel = Array.from($('#modal-body').querySelectorAll('button')).find(function (b) { return b.textContent === '取消'; });
                    if (cancel)
                        cancel.click();
                }
                else
                    hideModal();
            }
            closeDrawer();
        } if (e.key === 'Tab' && $('#modal').classList.contains('show')) {
            var all = Array.from($('#modal').querySelectorAll('button,input,textarea,select,[tabindex="0"]')).filter(function (n) { return !n.disabled && n.offsetParent !== null; });
            if (all.length) {
                var first = all[0], last = all.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                }
                else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        } });
        window.addEventListener('studio:auth', function () { cache.world = null; cache.growth = null; selectedEntity = null; lastEventId = 0; if (evtSource) {
            evtSource.close();
            evtSource = null;
        } if (started) {
            buildNav();
            navigate(firstRoute());
            connectSSE();
        } });
        $('#main').appendChild(el('div', { cls: 'studio-skeleton' }));
        buildNav();
        observeMobileNavigation();
        refreshOverview(false).then(function () { started = true; buildNav(); navigate(can(location.hash.slice(1)) ? location.hash.slice(1) : firstRoute()); connectSSE(); }).catch(function (e) { error($('#main'), e, function () { location.reload(); }); });
        setInterval(function () { if (!document.hidden)
            refreshOverview(false).catch(function () { }); }, 10000);
        setInterval(function () { if (isVisitor() && !document.hidden)
            syncVisitorGrants().then(function () { if (!can(activeView))
                navigate(firstRoute()); }).catch(function () { }); }, 20000);
        window.addEventListener('hashchange', function () { var name = location.hash.slice(1); if (name !== activeView)
            navigate(name); });
        window.addEventListener('popstate', function () { var name = location.hash.slice(1); if (name !== activeView)
            navigate(name); });
        document.addEventListener('visibilitychange', function () { if (!document.hidden) {
            refreshOverview(false).catch(function () { });
            dispatch('studio:refresh', { channel: 'visibility' });
        } });
    }
    return { register: register, navigate: navigate, start: start, can: can, title: title, button: button, empty: empty, error: error, section: section, fetchWorld: fetchWorld, fetchGrowth: fetchGrowth, cache: cache, inspectEntity: inspectEntity, takeSelectedEntity: function () { var id = selectedEntity; selectedEntity = null; return id; }, avatar: avatar, botAvatar: botAvatar };
})();
