/* First-use tour. All editing and commands stay in the actual studio views. */
(function () {
    'use strict';
    var session = null, opening = false, automaticChecked = false;
    var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    function control(path) { return '[data-config-path="' + path + '"]'; }
    function config(id, group, path, title, description, extra) {
        return Object.assign({ id: id, route: 'config', group: group, selector: control(path), title: title, description: description, section: '连接与配置', field: path }, extra || {});
    }
    var steps = [
        { id: 'welcome', route: 'overview', selector: '.studio-hero', title: '在界面里，把世界搭起来', section: '第一次见面', description: '跟随亮起的区域，直接操作网页里的真实控件。点击光圈与滑动手势只做演示，不会替你填写、保存或启动。随时可以跳过。', next: '开始配置' },
        config('bot-protocol', 'bot', 'bot.apiType', '选择角色模型的 API 协议', '角色模型负责思考、行动和聊天。根据服务商提供的接口选择协议；兼容 OpenAI 的服务通常使用 Chat Completions。'),
        config('bot-endpoint', 'bot', 'bot.baseURL', '填写角色模型的服务地址', '地址应能从 Koishi 所在机器访问，例如 http://127.0.0.1:8000/v1。本地地址指 Koishi 主机，不是你正在用的手机。', { endpoint: true }),
        config('bot-key', 'bot', 'bot.apiKey', '填写 API 密钥', '使用服务商提供的密钥；无需鉴权的本地服务可以留空。已有密钥显示为「已设置」，无需重新输入。'),
        config('bot-model', 'bot', 'bot.model', '选择角色模型', '填写完整模型 ID，或点击这里的「获取模型列表」选择。能获取列表仅说明接口可访问，不代表生成能力已经测试通过。', { required: true }),
        config('world-protocol', 'world', 'world.apiType', '连接负责叙事的世界模型', 'World 负责裁定行动结果、推进世界。可以使用同一服务，也可以单独选择另一套模型。先选择它的 API 协议。'),
        config('world-endpoint', 'world', 'world.baseURL', '填写世界模型的服务地址', '若共用服务，填写与角色模型相同的地址；否则使用 World 对应的 API 地址。', { endpoint: true }),
        config('world-key', 'world', 'world.apiKey', '填写世界模型的密钥', '若共用服务，请在此填写同一密钥。两组连接各自保存密钥；本地无鉴权服务可留空。'),
        config('world-model', 'world', 'world.model', '选择世界模型', '世界与角色可以使用同一个模型。建议先用已确认可用的模型跑通一次，再调整各自的模型与生成参数。', { required: true }),
        config('interval', 'bot', 'bot.minIntervalMs', '留出行动间隔，控制调用频率', '这是角色两次生成之间的最小间隔，单位毫秒。新手可先设为 10000，再按体验调整。它影响节奏，不是每日费用上限。', { section: '用量与经济' }),
        config('bot-output', 'bot', 'bot.maxTokens', '限制角色单次输出', '输出上限会影响单次用量。不要为了省钱压得过低：模型需要输出思考或完整工具参数。先沿用默认值，再到「模型用量」观察。', { section: '用量与经济' }),
        config('world-output', 'world', 'world.maxTokens', '为世界留够叙事空间', 'World 的结构化结果需要完整返回。过小的输出上限可能截断剧情并触发重试，反而增加用量。可以先保留默认值。', { section: '用量与经济' }),
        config('heartbeat', 'clock', 'clock.tingleMode', '决定世界多久自行演化', '固定模式使用 tingleEveryUnits，自动模式使用最小与最大间隔。间隔以世界 TU 计，不一定等于现实秒。先采用较慢节奏；历法也在本组配置。', { section: '用量与经济' }),
        config('autostart', 'root', 'autoStart', '决定重启后是否自动运行', '建议首次调试保持关闭。启动后的角色会持续调用模型，也可能主动在聊天平台发言；暂停入口就在总览。', { section: '用量与经济' }),
        config('access', 'webui', 'webui.token', '保护世界的管理权限', '所有能访问此地址的人都可能进入管理界面。对外监听时请设置管理员令牌；保存后当前浏览器会使用新令牌。请把令牌妥善保存。', { section: '访问与权限', access: true }),
        config('commands', 'messaging', 'messaging.selfCommands', '决定角色能否触发 Koishi 指令', '开启后，这个账号发出的指令可能调用其他插件，权限与影响取决于你的 Koishi 配置。暂不需要这种玩法时保持关闭。', { section: '访问与权限' }),
        { id: 'platform', route: 'config', group: 'platformOps', selector: '#cfg-body > .section', title: '逐项授予聊天平台权限', section: '访问与权限', description: '这些是真实的平台操作。按需开启即可，踢人、禁言、退群等敏感操作不必为了跑通世界而开启。可以滑动查看各项。', gesture: 'swipe' },
        { id: 'save-config', route: 'config', selector: '#cfg-savebar', title: '亲手保存这套配置', section: '保存配置', description: '点击真实的「保存并应用」，插件会重新加载。引导不会替你保存；保存失败时草稿仍在。确认配置生效后，再继续填写角色与世界。', next: '检查并继续', check: 'config' },
        { id: 'bot-definition', route: 'state', tab: 'botdef', selector: '[data-pane="botdef"]', title: '写下角色是谁', section: '角色与世界', description: '直接在编辑器里填写身份、性格、生活处境与说话风格，然后点击编辑器下方的「保存」。例如：住在海边小镇、喜欢散步和修理旧物的年轻人。', check: 'definition', definition: 'botDef', gesture: 'swipe' },
        { id: 'world-definition', route: 'state', tab: 'worlddef', selector: '[data-pane="worlddef"]', title: '给角色一个生活的地方', section: '角色与世界', description: '填写世界背景、初始地点与基本规则，再点击下方「保存」。可以是现实世界或架空世界；保持时间设定与刚才的时钟配置一致。', check: 'definition', definition: 'worldDef', gesture: 'swipe' },
        { id: 'genesis', route: 'state', selector: '[data-tour="world-create"]', fallback: '.studio-view[data-view="state"] .studio-title', title: '让 World 写下第一幕', section: '开始运行', description: '两份设定保存好后，可点击这里创建世界。创世会调用模型，可能需要几分钟。已有世界无需重复创建；你也可以稍后再执行。', next: '了解启动入口' },
        { id: 'start', route: 'overview', selector: '[data-tour="world-toggle"]', title: '由你决定何时开始', section: '开始运行', description: '创世完成后，这个按钮用于启动与暂停世界。启动后才会持续行动与聊天。尚未创世时，它会带你回到世界设定；引导本身不会启动世界。' },
        { id: 'live', route: 'live', selector: '.studio-view[data-view="live"]', title: '看见系统正在做什么', section: '观察运行', description: '这里实时显示模型生成和按时间排列的调用记录。遇到失败可以展开请求与响应，判断是模型、接口还是工具调用出了问题。', gesture: 'swipe' },
        { id: 'usage', route: 'usage', selector: '.studio-view[data-view="usage"], #main .view-head', title: '留意持续运行的用量', section: '观察运行', description: '在这里观察调用频率、输入输出 Token 和缓存情况。它是用量统计，不是费用硬上限；服务商的额度和余额仍需在服务商处管理。', gesture: 'swipe' },
        { id: 'finish', route: null, selector: '#main', title: '基础操作已经走过一遍', section: '按自己的节奏探索', description: '你可以开始使用，也可以继续了解多模态、手机应用与成长整理。高级配置随时都能再改。以后从总览或配置页的「新手引导」可手动重看。', branch: true }
    ];
    var advanced = [
        config('advanced-media', 'media', 'media.maxAttachmentsPerRequest', '给多模态输入留一个预算', '图片、音频和视频会增加上下文与处理用量。根据模型实际支持的模态配置输入，并限制每次请求的附件数量与大小。', { section: '高级配置（可选）' }),
        config('advanced-apps', 'apps', 'apps.browserEnabled', '按需开启手机应用', '浏览器会访问网络；相机、助手等功能可能调用额外模型。真实电脑、文件应用和 MCP 连接也应在确认用途后再开启。', { section: '高级配置（可选）' }),
        config('advanced-growth', 'bot', 'bot.growth.enabled', '选择是否整理成长经历', '成长整理会定期调用模型。可调整间隔，或关闭后稍后再开；其独立模型配置也在这里。', { section: '高级配置（可选）' }),
        { id: 'advanced-save', route: 'config', selector: '#cfg-savebar', title: '保存你选择的高级能力', section: '高级配置（可选）', description: '仍使用同一个保存入口。未修改任何设置时，可以直接结束；有修改时请先保存并确认生效。', check: 'config', last: true }
    ];
    function button(label, action, fn, primary) { return el('button', { type: 'button', text: label, 'data-tour-action': action, cls: primary ? 'primary' : '', onclick: fn }); }
    function current(s) { return session === s && !isVisitor(); }
    function step(s) { return s.steps[s.index]; }
    function feedback(s, message) { if (current(s)) { s.feedback.textContent = message; s.feedback.hidden = !message; schedule(s); } }
    async function open(options) {
        options = options || {};
        if (isVisitor() || session || opening) return;
        opening = true;
        try {
            var state = await api('GET', '/api/setup');
            if (isVisitor() || options.automatic && !state.shouldPrompt) return;
            // Persist on presentation, not completion: refresh/skip/reset cannot start a second automatic tour.
            var receipt = await api('POST', '/api/setup', { presented: true });
            if (options.automatic && receipt.firstPresentation === false) return;
            if (isVisitor()) return;
            var root = el('div', { cls: 'setup-tour' });
            var card = el('section', { id: 'setup-tour-card', role: 'region', 'aria-labelledby': 'setup-tour-title', tabindex: '-1' });
            var spotlight = el('div', { cls: 'setup-tour-spotlight', 'aria-hidden': 'true' });
            var gesture = el('div', { cls: 'setup-tour-gesture', 'aria-hidden': 'true', html: '<i></i><svg viewBox="0 0 32 36" fill="none"><path d="M10 18V5a3 3 0 0 1 6 0v9-1a3 3 0 0 1 5 2 3 3 0 0 1 5 3v7c0 5-3 8-8 8-3 0-6-2-8-5l-6-8a3 3 0 0 1 5-3l3 4" fill="var(--surface)" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>' });
            var label = el('span', { cls: 'setup-tour-label' }), counter = el('span', { cls: 'setup-tour-counter' });
            var close = button('跳过', 'skip', function () { closeTour(true); });
            var collapse = button('收起说明', 'collapse', function () { card.classList.toggle('is-collapsed'); collapse.textContent = card.classList.contains('is-collapsed') ? '展开说明' : '收起说明'; schedule(session); });
            var heading = el('h2', { id: 'setup-tour-title', 'aria-live': 'polite', 'aria-atomic': 'true' }), description = el('p', { cls: 'setup-tour-description' });
            var message = el('p', { cls: 'setup-tour-feedback', role: 'status', 'aria-live': 'polite', hidden: true });
            var progress = el('div', { cls: 'setup-tour-progress', 'aria-hidden': 'true' }, [el('i')]);
            var actions = el('div', { cls: 'setup-tour-actions' });
            card.append(el('header', null, [label, counter, collapse, close]), progress, heading, description, message, actions);
            root.append(spotlight, gesture, card); document.body.appendChild(root); document.body.classList.add('setup-tour-active');
            var s = { root: root, card: card, spotlight: spotlight, gesture: gesture, label: label, counter: counter, heading: heading, description: description, feedback: message, actions: actions, progress: progress.firstChild, steps: steps.slice(), index: 0, target: null, state: state, frame: 0, token: 0, previousFocus: document.activeElement, navigating: false, busy: false };
            session = s;
            s.layout = function () { schedule(s); };
            s.resize = function () { s.resized = true; schedule(s); };
            s.observer = new MutationObserver(s.layout); s.observer.observe($('#main'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
            window.addEventListener('scroll', s.layout, true); window.addEventListener('resize', s.resize);
            if (window.visualViewport) { visualViewport.addEventListener('resize', s.resize); visualViewport.addEventListener('scroll', s.layout); }
            await showStep(s, activeView === 'config' && cfgDirty ? 1 : 0);
            if (current(s)) card.focus({ preventScroll: true });
        } catch (error) { if (!options.automatic) showErr(error); }
        finally { opening = false; }
    }
    function closeTour(dismiss) {
        var s = session; if (!s) return;
        session = null; s.token++; cancelAnimationFrame(s.frame); s.observer.disconnect();
        window.removeEventListener('scroll', s.layout, true); window.removeEventListener('resize', s.resize);
        if (window.visualViewport) { visualViewport.removeEventListener('resize', s.resize); visualViewport.removeEventListener('scroll', s.layout); }
        s.root.remove(); document.body.classList.remove('setup-tour-active'); document.documentElement.style.removeProperty('--tour-reserve');
        if (s.previousFocus && s.previousFocus.isConnected) s.previousFocus.focus({ preventScroll: true });
        // Progress only. The current page and any unsaved fields remain untouched.
        if (dismiss && !isVisitor()) api('POST', '/api/setup', { dismissed: true }).catch(function () {});
    }
    async function showStep(s, index) {
        if (!current(s)) return;
        var item = s.steps[index]; if (!item) return;
        var guideFocused = s.card.contains(document.activeElement);
        s.index = index; s.token++; s.target = null; s.root.dataset.tourStep = item.id; s.root.dataset.tourTarget = item.selector;
        s.heading.textContent = item.title; s.description.textContent = item.description; s.label.textContent = item.section;
        s.counter.textContent = (index + 1) + ' / ' + s.steps.length;
        s.progress.style.width = (index + 1) / s.steps.length * 100 + '%'; s.feedback.hidden = true; s.actions.replaceChildren();
        var back = button('上一步', 'back', function () { showStep(s, Math.max(0, s.index - 1)); }); back.disabled = index === 0; s.actions.appendChild(back);
        if (item.branch) {
            s.actions.append(button('继续高级配置', 'advanced', function () { s.steps = steps.slice(0, -1).concat(advanced); showStep(s, index); }), button('完成引导', 'finish', function () { closeTour(false); }, true));
        } else s.actions.appendChild(button(item.last ? '完成引导' : item.next || '下一步', item.last ? 'finish' : 'next', function () { next(s); }, true));
        if (guideFocused) s.card.focus({ preventScroll: true });
        s.navigating = true;
        if (item.route && activeView !== item.route) {
            if (item.route === 'config' && item.group) { cfgGroup = item.group; cfgSearch = ''; }
            Studio.navigate(item.route);
        }
        s.navigating = false;
        if (item.route && activeView !== item.route) { feedback(s, '仍在当前页面。请先处理未保存的修改，或跳过引导继续编辑。'); return; }
        if (item.group && $('#cfg-body') && (cfgGroup !== item.group || cfgSearch)) focusConfigGroup(item.group);
        var token = s.token, started = Date.now();
        async function locate() {
            if (!current(s) || token !== s.token) return;
            if (item.group && activeView === 'config' && $('#cfg-body') && cfgGroup !== item.group) focusConfigGroup(item.group);
            if (item.tab) {
                var tab = document.querySelector('[data-state-tab="' + item.tab + '"]');
                if (tab && !tab.classList.contains('active')) tab.click();
            }
            var target = findTarget(item);
            if (target) {
                reveal(target); s.target = target; schedule(s);
                requestAnimationFrame(function () { if (current(s) && token === s.token) scrollTarget(s); });
                return;
            }
            if (Date.now() - started < 12000) setTimeout(locate, 120);
            else { feedback(s, '页面还未加载完成。可以稍后再试，或跳过引导。'); schedule(s); }
        }
        locate(); schedule(s);
    }
    function reveal(node) { var parent = node.parentElement; while (parent && parent !== document.body) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; } }
    function findTarget(item) {
        var node = document.querySelector(item.selector) || (item.fallback && document.querySelector(item.fallback));
        if (!node) return null;
        return item.field ? node.closest('.fld, .sw-row') || node : node;
    }
    function schedule(s) { if (!current(s) || s.frame) return; s.frame = requestAnimationFrame(function () { s.frame = 0; layout(s); }); }
    function viewport() { var v = window.visualViewport; return { x: v ? v.offsetLeft : 0, y: v ? v.offsetTop : 0, width: v ? v.width : innerWidth, height: v ? v.height : innerHeight }; }
    function layout(s) {
        if (!current(s)) return;
        var v = viewport(), mobile = v.width < 760;
        s.root.classList.toggle('is-modal', !!document.querySelector('#modal.show, dialog[open]'));
        var editing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
        s.card.classList.toggle('is-editing', mobile && editing && v.height < 600);
        s.card.style.width = Math.min(mobile ? v.width - 20 : 370, v.width - 20) + 'px';
        s.card.style.maxHeight = Math.max(110, v.height - 32) + 'px';
        var nav = $('#mobile-nav').getBoundingClientRect(), navHeight = nav.height && nav.top < v.y + v.height ? Math.max(0, v.y + v.height - nav.top) : 0;
        var bottom = v.y + v.height - navHeight - 12, height = s.card.getBoundingClientRect().height;
        s.card.style.left = v.x + v.width - parseFloat(s.card.style.width) - (mobile ? 10 : 20) + 'px';
        s.card.style.top = Math.max(v.y + 8, bottom - height) + 'px';
        var reserve = Math.ceil(height + 24);
        if (s.reserve !== reserve) {
            s.reserve = reserve;
            document.documentElement.style.setProperty('--tour-reserve', reserve + 'px');
            // Sticky save controls and scroll anchoring settle after this layout.
            schedule(s);
        }
        var item = step(s), target = findTarget(item);
        if (target && target !== s.target) { reveal(target); s.target = target; }
        if (s.resized && s.target) {
            s.resized = false;
            if (!editing) requestAnimationFrame(function () { scrollTarget(s, true); });
        }
        var r = s.target && s.target.isConnected && s.target.getBoundingClientRect();
        var visible = r && r.width > 0 && r.height > 0;
        s.spotlight.hidden = !visible; s.gesture.hidden = !visible;
        if (!visible) return;
        var left = Math.max(v.x + 4, r.left - 5), top = Math.max(v.y + 4, r.top - 5);
        var right = Math.min(v.x + v.width - 4, r.right + 5), end = Math.min(v.y + v.height - 4, r.bottom + 5);
        if (right <= left || end <= top) { s.spotlight.hidden = true; s.gesture.hidden = true; return; }
        Object.assign(s.spotlight.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: end - top + 'px' });
        var cardRect = s.card.getBoundingClientRect(), gx = Math.min(right - 20, left + Math.max(25, (right - left) * .7)), gy = Math.min(end - 20, top + 36);
        if (gx >= cardRect.left - 20 && gy >= cardRect.top - 30) s.gesture.hidden = true;
        s.gesture.dataset.gesture = item.gesture || 'tap';
        s.gesture.style.left = gx + 'px'; s.gesture.style.top = gy + 'px';
    }
    function scrollTarget(s, instant) {
        if (!current(s) || !s.target) return;
        var v = viewport(), r = s.target.getBoundingClientRect(), card = s.card.getBoundingClientRect();
        var top = v.y + 84, available = Math.max(100, card.top - top - 18), desired = top + Math.max(0, (available - Math.min(r.height, available)) / 2);
        window.scrollBy({ top: r.top - desired, behavior: instant || motion.matches ? 'instant' : 'smooth' });
    }
    async function next(s) {
        if (!current(s) || s.busy) return;
        s.busy = true;
        try {
            var token = s.token, item = step(s), input = item.field && document.querySelector(control(item.field));
            if (item.required && (!input || !input.value.trim())) { feedback(s, '请先填写模型名称。'); return; }
            if (item.endpoint) {
                var valid = false;
                try { var url = new URL(input.value); valid = /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password && !url.hash; } catch (_) {}
                if (!valid) { feedback(s, '请填写可访问的 HTTP 或 HTTPS API 地址。'); return; }
            }
            if (item.access && s.state.safety.publicBinding && !cfgCache.webui.token) { feedback(s, '当前 WebUI 对外监听，请先设置管理员访问令牌。'); return; }
            if (item.check === 'config') {
                if (typeof cfgSavePromise !== 'undefined' && cfgSavePromise) { feedback(s, '正在保存，请等操作返回后再继续。'); return; }
                if (cfgDirty) { feedback(s, '请先点击高亮区域里的「保存并应用」。引导不会代替你保存。'); return; }
                var actual = await api('GET', '/api/config');
                if (!current(s) || token !== s.token) return;
                var fields = s.steps.filter(function (entry) { return entry.field; }).map(function (entry) { return entry.field; });
                var pending = fields.some(function (path) {
                    var expected = getPath(cfgCache, path.split('.')), value = getPath(actual.value, path.split('.'));
                    if (/\.(apiKey|token)$/.test(path)) return !!expected !== !!value;
                    return JSON.stringify(expected) !== JSON.stringify(value);
                });
                if (pending || (typeof cfgSavedRevision !== 'undefined' && cfgSavedRevision && actual.revision !== cfgSavedRevision)) { feedback(s, '保存已提交，服务仍在使用旧配置。请等插件重新加载后，再点击检查；若持续未生效，请查看 Koishi 日志。'); return; }
            }
            if (item.check === 'definition') {
                var ta = document.querySelector('[data-pane="' + item.tab + '"] textarea'), value = ta && ta.value;
                if (!value || !value.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*#+[^\n]*$/gm, '').trim() || value.includes('尚未编写')) { feedback(s, '请填写有效设定，替换「尚未编写」的占位内容，再点击下方保存。'); return; }
                var definitions = await api('GET', '/api/state');
                if (!current(s) || token !== s.token) return;
                if (definitions[item.definition] !== value) { feedback(s, '这份设定尚未保存，请点击编辑器下方的「保存」。'); return; }
            }
            if (item.last) closeTour(false); else await showStep(s, s.index + 1);
        } catch (_) { feedback(s, '暂时无法确认保存结果。请检查连接后重试；不会自动提交或重复执行操作。'); }
        finally { s.busy = false; }
    }
    window.addEventListener('keydown', function (event) { if (session && event.key === 'Escape' && !document.querySelector('#modal.show, dialog[open]')) { event.preventDefault(); closeTour(true); } });
    window.addEventListener('studio:auth', function () { closeTour(false); });
    window.addEventListener('studio:navigate', function () { if (session && !session.navigating) closeTour(false); });
    window.addEventListener('studio:config-save', function (event) {
        if (!session) return;
        feedback(session, event.detail.phase === 'saving' ? '正在保存…' : event.detail.phase === 'saved' ? '保存已提交。插件重新加载后，点击「检查并继续」确认。' : '保存失败，草稿已保留。请检查错误后再点击页面上的保存按钮。');
    });
    document.addEventListener('focusin', function () { if (session) schedule(session); });
    document.addEventListener('focusout', function () { if (session) schedule(session); });
    window.SetupTour = {
        open: open,
        maybeStart: function () { if (automaticChecked || isVisitor()) return; automaticChecked = true; open({ automatic: true }); }
    };
})();
