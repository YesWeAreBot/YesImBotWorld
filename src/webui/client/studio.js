/* Navigation, shared state and overview. Domain views register independently. */
var Studio = (function () {
    var views = new Map(), clean = null, epoch = 0, overviewRequest = null, started = false;
    var cache = { world: null, growth: null }, selectedEntity = null;
    var oldSwitch = switchView;
    var routes = [
        { group: '探索世界' },
        ['overview', '工作室总览', 'gauge', ['overview']],
        ['world', '世界关系图', 'world'],
        ['growth', '角色与成长', 'growth', ['notes']],
        ['devices', '设备工作台', 'monitor', ['devices']],
        ['player', '走进世界', 'door', ['__player__']],
        { group: '观察与记录' },
        ['debug', '运行洞察', 'activity', ['debug']],
        ['usage', '模型用量', 'chart', ['usage']],
        ['gallery', '相册', 'image', ['gallery']],
        ['data', '记事与存档', 'folder', ['notes', 'archive']],
        { group: '管理工作室' },
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
        world: svgIcon('<path d="m12 3 9 5v8l-9 5-9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/><path d="m7.5 5.5 9 5"/>'),
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
    function routeFor(name) { return routes.find(function (r) { return r[0] === name; }); }
    function can(name) { var r = routeFor(name); return !!r && visitorCanSee(r[3]); }
    function firstRoute() { return (routes.find(function (r) { return !r.group && visitorCanSee(r[3]); }) || ['overview'])[0]; }
    function register(name, render) { views.set(name, render); }
    function navigate(name) {
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
        $('#route-title').textContent = (routeFor(name) || ['', '工作室'])[1];
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
        ['overview', 'world', 'devices', 'player', 'debug'].filter(can).slice(0, 5).forEach(function (name) {
            var r = routeFor(name);
            mobile.appendChild(el('a', { href: '#' + name, cls: activeView === name ? 'active' : '', 'aria-current': activeView === name ? 'page' : 'false', onclick: function (e) { e.preventDefault(); navigate(name); } }, [el('span', { html: icon(r[2]) }), el('span', { text: { overview: '总览', world: '世界', devices: '设备', player: '入世界', debug: '洞察' }[name] })]));
        });
        $('#account-name').textContent = isVisitor() ? (VISITOR_PRESET === 'player' ? '世界中的旅人' : '工作室访客') : '工作室管理员';
        $('#account-role').textContent = isVisitor() ? (VISITOR_PRESET === 'player' ? '体验与互动' : '按授权范围观测') : '管理与观测';
        document.body.classList.toggle('visitor-readonly', isVisitor());
    };
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
        evtSource.onopen = function () { $('#sse-dot').className = 'on'; $('#connection-label').textContent = '实时连接'; };
        evtSource.onerror = function () { $('#sse-dot').className = 'off'; $('#connection-label').textContent = '正在重连'; };
        evtSource.onmessage = function (event) {
            var msg;
            try {
                msg = JSON.parse(event.data);
            }
            catch (_) {
                return;
            }
            // Server restart can reset the in-memory debug sequence.
            if (msg.channel === 'hello' && Number.isFinite(msg.snapshot))
                lastEventId = msg.snapshot;
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
        return el('div', { cls: 'studio-empty' }, [el('div', { html: '<svg viewBox="0 0 80 80" fill="none" aria-hidden="true"><path d="m40 10 25 14v29L40 68 15 53V24Z" stroke="currentColor"/><path d="m15 24 25 15 25-15M40 39v29" stroke="currentColor"/><circle cx="58" cy="15" r="5" fill="currentColor" opacity=".45"/><path d="m28 29 12 7 12-7" stroke="currentColor"/></svg>' }), el('strong', { text: name }), el('p', { text: description }), action || null]);
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
    function art() {
        return '<svg class="studio-hero-art" viewBox="0 0 440 280" fill="none" aria-label="手绘的虚拟世界微缩工作室" role="img"><ellipse cx="237" cy="235" rx="162" ry="28" fill="#bcccad" opacity=".3"/><path d="m70 165 159-87 145 83-158 91Z" fill="#ccd7bd"/><path d="m70 165 146 85v10L70 175Z" fill="#aabca0"/><path d="m216 250 158-89v10l-158 89Z" fill="#b8c9ab"/><path d="M94 159V75l129-71v84Z" fill="#eaf0e1" stroke="#c5d1b8"/><path d="m223 4 121 69v84L223 88Z" fill="#d9e4cc" stroke="#c5d1b8"/><path d="m241 37 61 34v51l-61-34Z" fill="#b5c8ab"/><path d="m247 43 49 28v41l-49-28Z" fill="#f8fbef"/><path d="m270 57 1 41m-24-33 49 28" stroke="#c5d4b9" stroke-width="3"/><path d="m110 94 64-35v41l-64 35Z" fill="#73946d"/><path d="m117 98 47-26m-47 37 28-15m-28 25 40-22" stroke="#aac69d" stroke-width="2"/><path d="m163 164 91-51 59 34-91 52Z" fill="#c2a985"/><path d="M174 171v35m39-12v37m88-80v34" stroke="#7b856a" stroke-width="6"/><path d="m163 164 59 34v7l-59-34Z" fill="#a89475"/><path d="m222 198 91-51v7l-91 51Z" fill="#b5a17d"/><path d="m216 136 36-20 27 15-36 21Z" fill="#809678"/><path d="m224 140-5-32 39-22 5 32Z" fill="#436857"/><path d="m226 132-3-21 32-18 3 23Z" fill="#c7dfbc"/><path d="m232 112 15-8m-14 14 21-12" stroke="#89ad80" stroke-width="2"/><path d="m261 158 15-8 15 9-15 8Z" fill="#f8f6e6"/><path d="m192 152 13-7 10 6-13 7Z" fill="#dedbc4"/><path d="M190 202v-21l-22-12-14 8v22l23 13Z" fill="#6e8b67"/><ellipse cx="173" cy="158" rx="15" ry="9" fill="#e8c2a4"/><path d="M158 157v-13c0-20 30-20 30 0v13" fill="#454d3e"/><path d="M156 175c2-14 29-14 33 0v19l-14 8-19-11Z" fill="#efe7cf"/><path d="m181 176 15-10m-34 10 7 14" stroke="#e6ba97" stroke-width="7" stroke-linecap="round"/><path d="m170 204-4 14m16-8 1 12" stroke="#637260" stroke-width="7" stroke-linecap="round"/><path d="M320 169c-1-17 7-33 16-46m-15 34c-16-7-18-19-15-28m16 12c-1-16 7-29 16-35" stroke="#6e9465" stroke-width="3"/><ellipse cx="311" cy="136" rx="7" ry="15" transform="rotate(-36 311 136)" fill="#a4bf90"/><ellipse cx="333" cy="131" rx="7" ry="16" transform="rotate(38 333 131)" fill="#90af7e"/><ellipse cx="332" cy="113" rx="6" ry="13" transform="rotate(34 332 113)" fill="#b4c99d"/><path d="m310 163 25 1-5 25h-16Z" fill="#bd8c67"/><ellipse cx="322" cy="164" rx="12" ry="4" fill="#947454"/><path d="m110 164 27-15 24 14-27 15Z" fill="#eff3e3"/><path d="m110 164 24 14v6l-24-14Z" fill="#b7caaa"/><path d="m134 178 27-15v6l-27 15Z" fill="#ccdaba"/><path d="M372 75v12m-6-6h12M77 108v8m-4-4h8" stroke="#a3b896" stroke-width="1.5"/><circle cx="359" cy="116" r="3" fill="#e0b488"/></svg>';
    }
    function avatar() { return '<svg viewBox="0 0 60 70" fill="none" aria-hidden="true"><path d="M12 70V51c0-17 36-17 36 0v19Z" fill="#6c886b"/><path d="M17 38V24c0-19 26-19 26 0v14Z" fill="#465647"/><ellipse cx="30" cy="30" rx="13" ry="16" fill="#e9bc9b"/><path d="M17 28V18c3-14 25-12 27 2l-1 10-8-13-18 11Z" fill="#465647"/><circle cx="25" cy="29" r="1" fill="#556044"/><circle cx="36" cy="29" r="1" fill="#556044"/><path d="M28 36c2 1 4 1 6-1" stroke="#ac755d" stroke-linecap="round"/><path d="m24 46 6 8 7-8" stroke="#c8d3b1" stroke-width="2"/></svg>'; }
    function kpi(label, value, note, img) { return el('div', { cls: 'studio-kpi' }, [el('span', { cls: 'label', text: label }), el('span', { cls: 'number', text: value }), el('span', { cls: 'note', text: note }), el('span', { cls: 'kpi-icon', html: icon(img) })]); }
    function row(key, value) { return el('div', { cls: 'studio-detail-row' }, [el('span', { text: key }), el('span', { text: value })]); }
    function panel() { return el('section', { cls: 'studio-panel' }); }
    function renderOverviewView(holder) {
        var alive = true, refreshing = false;
        holder.appendChild(el('div', { cls: 'studio-skeleton' }));
        function refresh() {
            if (!alive || refreshing || document.hidden)
                return;
            refreshing = true;
            var worldPromise = isVisitor() ? Promise.resolve(null) : fetchWorld().catch(function () { return null; });
            var growthPromise = can('growth') ? fetchGrowth().catch(function () { return []; }) : Promise.resolve([]);
            Promise.all([refreshOverview(false), worldPromise, growthPromise]).then(function (result) { if (alive)
                draw(result[0], result[1], result[2]); }).catch(function (e) { if (alive)
                error(holder, e, refresh); }).finally(function () { refreshing = false; });
        }
        function draw(o, world, growth) {
            var snapshot = world?.snapshot, entities = Object.values(snapshot?.entities || {}), events = world?.events || [], bot = snapshot?.entities.bot;
            var running = Object.values(snapshot?.actions || {}).filter(function (a) { return a.status === 'pending'; });
            holder.replaceChildren(title('YOUR WORLD, AT A GLANCE', '世界工作室', '看见世界如何变化，也参与角色的每一个当下。', [button('走进世界', 'door', function () { navigate('player'); }, true)].filter(function () { return can('player'); })));
            var hero = el('section', { cls: 'studio-hero' });
            var heroCopy = el('div', { cls: 'studio-hero-copy' }, [el('div', { cls: 'studio-eyebrow', text: o.initialized ? 'A WORLD IN PROGRESS' : 'THE FIRST CHAPTER' }), el('h2', { text: o.initialized ? '你好，' + (bot?.name || '世界') + '。' : '从一个世界开始。' }), el('p', { text: !o.initialized ? '写下角色与世界设定，让第一组事实成为故事的起点。' : o.worldRunning ? '世界正在运转。观察发生了什么，或拿起设备，与角色共享此刻。' : '世界目前未运行。你可以先探索已有状态，再继续角色的生活。' })]);
            var actions = el('div', { cls: 'studio-hero-actions' });
            if (!isVisitor()) {
                actions.appendChild(button(!o.initialized ? '准备世界设定' : o.worldRunning ? '暂停世界' : '继续世界', !o.initialized ? 'edit' : o.worldRunning ? 'pause' : 'play', function (e) {
                    if (!o.initialized) {
                        navigate('state');
                        return;
                    }
                    var btn = e.currentTarget;
                    btn.disabled = true;
                    btn.textContent = '正在处理…';
                    api('POST', '/api/world/' + (o.worldRunning ? 'stop' : 'start'), {}).then(function (r) { toast(r.text || '已完成', 'ok'); refresh(); }).catch(showErr).finally(function () { btn.disabled = false; });
                }, true));
            }
            if (can('world'))
                actions.appendChild(button('探索关系图', 'arrow', function () { navigate('world'); }));
            else if (can('devices'))
                actions.appendChild(button('打开设备', 'phone', function () { navigate('devices'); }));
            heroCopy.appendChild(actions);
            hero.append(heroCopy, el('div', { html: art() }), el('span', { cls: 'studio-hero-footnote', text: 'WORLD / STUDIO' }));
            holder.appendChild(hero);
            holder.appendChild(el('div', { cls: 'studio-kpi-row' }, [
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
            character.appendChild(el('div', { cls: 'studio-bot-card' }, [el('div', { cls: 'studio-avatar', html: avatar() }), el('div', null, [el('h3', { text: bot?.name || RESIDENT_BOT_NAME || '常驻 Bot' }), el('span', { cls: 'studio-badge', text: o.bot?.paused ? '手动接管中' : o.bot?.running ? '正在自主行动' : o.initialized ? '等待下一刻' : '尚未初始化' })])]));
            character.appendChild(row('所在位置', bot?.location ? snapshot.entities[bot.location]?.name || bot.location : '未知'));
            character.appendChild(row('当前状态', o.bot?.waiting || (running[0]?.intent) || '暂无进行中的意图'));
            var attrs = Object.entries(bot?.attributes || {}).filter(function (a) { return ['posture', 'energy', 'hunger', 'health', 'consciousness'].includes(a[0]); }).slice(0, 3);
            attrs.forEach(function (a) { character.appendChild(row({ posture: '姿态', energy: '精力', hunger: '饥饿', health: '健康', consciousness: '意识状态' }[a[0]], typeof a[1].value === 'object' ? JSON.stringify(a[1].value) : String(a[1].value))); });
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
            holder.appendChild(el('div', { cls: 'studio-overview-grid' }, [left, right]));
        }
        refresh();
        var timer = setInterval(refresh, 12000);
        var onRefresh = function () { refresh(); };
        window.addEventListener('studio:refresh', onRefresh);
        return function () { alive = false; clearInterval(timer); window.removeEventListener('studio:refresh', onRefresh); };
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
        document.body.dataset.theme = localStorage.getItem('studio_theme') === 'dark' ? 'dark' : 'light';
        $('#btn-theme').innerHTML = icon(document.body.dataset.theme === 'dark' ? 'moon' : 'sun');
        $('#btn-theme').onclick = function () { var theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'; document.body.dataset.theme = theme; localStorage.setItem('studio_theme', theme); $('#btn-theme').innerHTML = icon(theme === 'dark' ? 'moon' : 'sun'); };
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
            holder.appendChild(button('修改密码', 'sliders', openChangePassword)); holder.appendChild(button('切换深浅主题', 'sun', function () { $('#btn-theme').click(); })); showModal('工作室账号', holder); };
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
    return { register: register, navigate: navigate, start: start, can: can, title: title, button: button, empty: empty, error: error, section: section, fetchWorld: fetchWorld, fetchGrowth: fetchGrowth, cache: cache, inspectEntity: inspectEntity, takeSelectedEntity: function () { var id = selectedEntity; selectedEntity = null; return id; }, avatar: avatar };
})();
