/* First-run setup keeps drafts in memory; only the final save writes configuration. */
(function () {
    'use strict';
    var draft = null, owner = '', active = null;
    var steps = ['连接模型', '角色与世界', '用量与节奏', '访问与权限', '确认并启程'];
    var MASK = '******';
    function get(object, path) { return path.split('.').reduce(function (value, key) { return value == null ? undefined : value[key]; }, object); }
    function put(object, path, value) { var keys = path.split('.'), last = keys.pop(), current = object; keys.forEach(function (key) { current = current[key] || (current[key] = {}); }); current[last] = value; }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function text(tag, value, cls) { return el(tag, { text: value, cls: cls || '' }); }
    function action(label, id, callback, primary) { return el('button', { type: 'button', 'data-setup-action': id, cls: primary ? 'primary' : '', text: label, onclick: callback }); }
    function note(value, warning) { return text('p', value, 'setup-note' + (warning ? ' is-warning' : '')); }
    function fresh(config, state, setup) {
        return { config: copy(config), patch: {}, botDef: state.botDef || '', worldDef: state.worldDef || '', setup: setup,
            reuse: !!setup.models.sameConnection || !config.world.model, step: setup.completed && setup.applied !== false ? 'done' : 0,
            status: setup.applied === false ? 'reconnecting' : 'editing', dirty: false, message: '', saved: !!setup.completed,
            baselineBotDef: state.botDef || '', baselineWorldDef: state.worldDef || '', pending: null };
    }
    function change(path, value) { put(draft.config, path, value); put(draft.patch, path, value); draft.dirty = true; }
    function validDefinition(value) { return !!value.trim() && !value.includes('（尚未编写）'); }
    function validEndpoint(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch (_) { return false; } }
    function preset(name) {
        var slow = name === 'economy';
        [['bot.minIntervalMs', slow ? 10000 : 3000], ['clock.tingleEveryUnits', slow ? 3600 : 1800], ['clock.tingleMode', 'fixed'], ['bot.growth.enabled', true], ['bot.growth.reviewIntervalMs', slow ? 600000 : 120000]].forEach(function (entry) { change(entry[0], entry[1]); });
        draft.preset = name;
    }
    window.SetupWizard = { open: function () { Studio.navigate('setup'); } };
    window.addEventListener('studio:auth', function () { draft = null; owner = ''; });
    window.addEventListener('beforeunload', function (event) { if (draft && draft.dirty) { event.preventDefault(); event.returnValue = ''; } });
    Studio.register('setup', async function (holder) {
        if (isVisitor()) { holder.appendChild(Studio.empty('仅管理员可配置世界', '请使用管理员账号打开新手引导。')); return; }
        var alive = true, timer = null, refreshing = false, form, feedback, controls, body, progress, title, tokenInput;
        var instance = {}; active = instance;
        holder.classList.add('setup-view');
        holder.appendChild(el('div', { cls: 'studio-skeleton' }));
        var values = await Promise.all([api('GET', '/api/config'), api('GET', '/api/state'), api('GET', '/api/setup')]);
        if (!holder.isConnected || isVisitor()) return;
        if (!draft || owner !== TOKEN) { draft = fresh(values[0].value, values[1], values[2]); owner = TOKEN; }
        else {
            draft.setup = values[2];
            if (!draft.dirty && !draft.pending && !['saving', 'reconnecting', 'working'].includes(draft.status)) {
                draft.config = copy(values[0].value); draft.patch = {};
                draft.botDef = draft.baselineBotDef = values[1].botDef || '';
                draft.worldDef = draft.baselineWorldDef = values[1].worldDef || '';
                draft.reuse = !!values[2].models.sameConnection || !draft.config.world.model;
            }
        }
        if (!draft.saved && !draft.dirty && !draft.setup.completed && !draft.setup.dismissed && !draft.setup.initialized) {
            // An explicit final review will show these starter values before they are applied.
            preset('economy'); change('autoStart', false); draft.dirty = false;
        }
        var sessionDraft = draft;
        function current() { return alive && draft === sessionDraft && active === instance && holder.isConnected; }
        function signal(phase) { window.dispatchEvent(new CustomEvent('studio:setup-state', { detail: { draft: sessionDraft, phase: phase } })); }
        function say(value, failure) { if (!current()) return; draft.message = value; draft.messageError = !!failure; feedback.textContent = value; feedback.hidden = !value; feedback.classList.toggle('is-error', !!failure); }
        function panel(name, description) { var node = el('section', { cls: 'setup-card' }, [text('h2', name), text('p', description, 'setup-description')]); body.appendChild(node); return node; }
        function field(parent, label, path, options) {
            options = options || {};
            var value = get(draft.config, path), type = options.type || 'text';
            var input = el(type === 'textarea' ? 'textarea' : 'input', { type: type === 'textarea' ? 'text' : type, 'data-setup-path': path, 'aria-label': label, autocomplete: type === 'password' ? 'new-password' : 'off', spellcheck: 'false' });
            if (type === 'textarea') input.rows = options.rows || 5;
            input.value = type === 'password' && value === MASK ? '' : value == null ? '' : options.scale ? value / options.scale : value;
            if (type === 'password' && value === MASK) input.placeholder = '已设置，留空保留原值';
            else if (options.placeholder) input.placeholder = options.placeholder;
            if (options.required) input.required = true;
            if (options.min != null) input.min = options.min;
            if (options.max != null) input.max = options.max;
            if (type === 'number') input.step = options.step || '1';
            input.addEventListener('input', function () {
                input.setCustomValidity('');
                var next = type === 'number' ? input.value === '' ? null : Number(input.value) * (options.scale || 1) : input.value;
                if (type === 'password' && next === '' && value === MASK) next = MASK;
                change(path, next);
            });
            var labelNode = el('label', { cls: 'setup-field' }, [text('span', label), input, options.hint ? text('small', options.hint) : null]);
            parent.appendChild(labelNode); return input;
        }
        function select(parent, label, path, entries, changed) {
            var node = el('select', { 'data-setup-path': path, 'aria-label': label });
            entries.forEach(function (entry) { node.appendChild(el('option', { value: entry[0], text: entry[1] })); });
            node.value = get(draft.config, path);
            node.onchange = function () { change(path, node.value); if (changed) changed(node.value); };
            parent.appendChild(el('label', { cls: 'setup-field' }, [text('span', label), node])); return node;
        }
        function toggle(parent, label, path, hint, changed) {
            var input = el('input', { type: 'checkbox', checked: !!get(draft.config, path), 'data-setup-path': path });
            input.onchange = function () { change(path, input.checked); if (changed) changed(input.checked); };
            parent.appendChild(el('label', { cls: 'setup-toggle' }, [input, el('span', null, [text('strong', label), hint ? text('small', hint) : null])])); return input;
        }
        function connection(parent, group, label) {
            var card = el('section', { cls: 'setup-model' }, [text('h3', label)]); parent.appendChild(card);
            select(card, 'API 协议', group + '.apiType', [['chat-completions', 'OpenAI Chat Completions / 兼容接口'], ['responses', 'OpenAI Responses'], ['anthropic', 'Anthropic Messages']]);
            field(card, '服务地址', group + '.baseURL', { type: 'url', required: true, placeholder: 'http://127.0.0.1:8080/v1', hint: '填写服务商提供的 API 地址。本地地址是 Koishi 所在机器能访问的地址。' });
            field(card, 'API Key', group + '.apiKey', { type: 'password', hint: '本地无鉴权服务可留空。已有密钥留空保留。' });
            var model = field(card, '模型名称', group + '.model', { required: true, placeholder: '填写服务端的完整模型 ID' });
            var results = el('div', { cls: 'setup-model-results', role: 'status', 'aria-live': 'polite' });
            var fetchButton = action('获取可选模型', 'models-' + group, async function () {
                var source = copy(draft.config[group]);
                if (!validEndpoint(source.baseURL)) { results.textContent = '请先填写有效的 http 或 https 服务地址。'; return; }
                fetchButton.disabled = true; results.textContent = '正在读取模型列表…';
                try {
                    var response = await api('POST', '/api/llm/models', { group: group, baseURL: source.baseURL, apiType: source.apiType, apiKey: source.apiKey });
                    if (!current() || !model.isConnected) return;
                    if (['baseURL', 'apiType', 'apiKey'].some(function (key) { return draft.config[group][key] !== source[key]; })) { results.textContent = '连接配置已改变，请重新获取。'; return; }
                    var models = response.models || [];
                    results.replaceChildren();
                    if (!models.length) { results.textContent = '服务未返回模型列表，请手动填写模型名称。'; return; }
                    var options = el('select', { 'aria-label': label + '可选模型' }, [el('option', { value: '', text: '选择模型（也可手动填写）' })]);
                    models.forEach(function (item) { var id = typeof item === 'string' ? item : item.id; if (id) options.appendChild(el('option', { value: id, text: id })); });
                    options.onchange = function () { if (options.value) { change(group + '.model', options.value); model.value = options.value; } };
                    results.append(options, text('small', '已读取列表；尚未验证生成或结构化输出能力。'));
                } catch (error) { if (current() && results.isConnected) results.textContent = '暂时无法读取：' + error.message + '。部分服务不提供列表，仍可手动填写。'; }
                finally { if (current()) fetchButton.disabled = false; }
            });
            card.append(fetchButton, results); return card;
        }
        function modelsStep() {
            var card = panel('给角色和世界连接模型', '角色模型负责思考与行动，世界模型负责剧情与裁定。可以先共用一个模型服务。');
            var layout = el('div', { cls: 'setup-columns' }); card.appendChild(layout);
            connection(layout, 'bot', '角色模型 · Bot');
            var world = connection(layout, 'world', '世界模型 · World');
            var reuse = el('input', { type: 'checkbox', checked: draft.reuse, 'data-setup-path': 'reuseBotModel' });
            function syncReuse() { layout.classList.toggle('setup-shared-model', draft.reuse); world.hidden = draft.reuse; world.querySelectorAll('input,select,button').forEach(function (control) { control.disabled = draft.reuse; }); }
            reuse.onchange = function () { draft.reuse = reuse.checked; draft.dirty = true; syncReuse(); };
            card.insertBefore(el('label', { cls: 'setup-toggle' }, [reuse, el('span', null, [text('strong', '世界模型复用角色模型的连接'), text('small', '同步协议、地址、密钥和模型名称；其他参数各自保留。')])]), layout);
            syncReuse();
            toggle(card, '同一个模型服务串行处理请求', 'serializeSameEndpoint', '单实例本地模型建议开启。服务支持并发时可关闭，让角色与世界并行生成。');
            card.appendChild(note('这里读取模型列表不会请求生成。创世会验证世界输出，角色启动后还需要模型具备可靠的工具调用能力。图片、音频等能力可稍后在高级配置中开启。'));
        }
        function storyStep() {
            var card = panel('给故事一个起点', '写清角色是谁、生活在哪里、正在做什么。之后的剧情会从这些设定出发。');
            card.appendChild(action('填入一套可编辑的入门设定', 'example', function () {
                if ((validDefinition(draft.botDef) || validDefinition(draft.worldDef)) && !confirm('这会替换引导里的角色与世界草稿，保存前不影响磁盘。继续吗？')) return;
                draft.botDef = '# 角色设定\n\n你叫小澈，是生活在当代城市里的成年人，在一家书店工作。你喜欢散步、读小说和观察身边的小事，说话自然简洁，有自己的日常安排，也尊重别人的注意力。你会通过手机与朋友交流亲历的事情。\n\n初始处境：今天工作结束后，你正在自己的住处，打算准备晚饭，手机可以正常使用。';
                draft.worldDef = '# 世界设定\n\n这是一个遵循现实规律的当代城市，时间与现实同步。小澈住在书店附近的公寓，周围有公园、便利店和餐馆，可以与邻居、同事逐渐建立关系。\n\n从一个普通的下班时刻开始。世界中的人有自己的安排，日常会自然带来新见闻和小变化。手机聊天平台的消息与操作以程序实际提供的内容为准。';
                change('clock.syncRealTime', true); draft.dirty = true; draw();
            }));
            var grid = el('div', { cls: 'setup-columns' }); card.appendChild(grid);
            [['botDef', '角色设定', '姓名、背景、说话风格、眼下的生活。'], ['worldDef', '世界设定', '现实或架空背景、地点、规则与初始情境。']].forEach(function (item) {
                var input = el('textarea', { rows: 10, required: true, 'data-setup-path': item[0], 'aria-label': item[1], placeholder: item[2] }); input.value = draft[item[0]];
                input.oninput = function () { draft[item[0]] = input.value; draft.dirty = true; input.setCustomValidity(''); };
                grid.appendChild(el('label', { cls: 'setup-field' }, [text('span', item[1]), input]));
            });
            var epochBox = el('div');
            toggle(card, '世界时间与现实同步', 'clock.syncRealTime', '架空历法可以关闭此项，并填写世界初始时刻。真实或虚构互联网由世界设定决定。', function (enabled) { epochBox.hidden = enabled; epochBox.querySelector('input').disabled = enabled; });
            field(epochBox, '世界初始时刻', 'clock.epoch', { required: true, hint: '例如：王历 1024 年春月初三，清晨。只在创世时使用。' });
            epochBox.hidden = draft.config.clock.syncRealTime; epochBox.querySelector('input').disabled = draft.config.clock.syncRealTime; card.appendChild(epochBox);
            if (draft.setup.initialized) card.appendChild(note('已有世界不会因保存设定而重置。需要把新设定引入现有运行时，可之后在总览「更多」中重载定义；初始历法需重新创世才会改变。'));
        }
        function usageStep() {
            var card = panel('先用可控的节奏体验', '角色不是只在收到消息时才调用模型。自主行动、世界裁定、记忆整理都可能持续产生用量。');
            var presets = el('div', { cls: 'setup-presets' });
            [['economy', '节省起步', '角色间隔 10 秒 · 世界心跳 3600 TU · 成长整理至少间隔 10 分钟'], ['balanced', '日常节奏', '角色间隔 3 秒 · 世界心跳 1800 TU · 成长整理至少间隔 2 分钟']].forEach(function (item) {
                var button = action('', item[0], function () { preset(item[0]); draw(); }); button.className = 'setup-preset'; button.setAttribute('aria-pressed', String(draft.preset === item[0])); button.append(text('strong', item[1]), text('small', item[2])); presets.appendChild(button);
            }); card.appendChild(presets);
            var grid = el('div', { cls: 'setup-columns' }); card.appendChild(grid);
            field(grid, '角色生成的最小间隔（秒）', 'bot.minIntervalMs', { type: 'number', scale: 1000, min: 0, required: true, hint: '两次角色生成之间的节流间隔，不是所有模型调用的总频率上限。' });
            field(grid, '世界心跳间隔（TU）', 'clock.tingleEveryUnits', { type: 'number', min: 0, required: true, hint: '现实同步时 1 TU = 1 秒；独立历法按时钟流速换算。0 关闭心跳，行动裁定仍会调用世界模型。' });
            select(grid, '世界心跳调度', 'clock.tingleMode', [['fixed', '固定间隔'], ['auto', '安静时自动延长（使用现有上下限）']]);
            field(grid, '成长整理的最小间隔（分钟）', 'bot.growth.reviewIntervalMs', { type: 'number', scale: 60000, min: 1, required: true, hint: '仅有足够新经历时才整理，不是每到间隔必然调用。' });
            toggle(card, '保留关系、习惯与性格的自动整理', 'bot.growth.enabled', '会额外调用整理模型；关闭后可以继续运行，之后再开启。');
            var extras = el('details', { cls: 'setup-details' }, [text('summary', '展开单次请求和媒体预算')]); card.appendChild(extras);
            var limits = el('div', { cls: 'setup-columns' }); extras.appendChild(limits);
            field(limits, '角色最大输出（token）', 'bot.maxTokens', { type: 'number', min: 256, required: true });
            field(limits, '世界最大输出（token）', 'world.maxTokens', { type: 'number', min: 256, required: true });
            field(limits, '角色上下文预算（字符）', 'bot.maxWindowChars', { type: 'number', min: 4000, required: true });
            field(limits, '单次请求媒体数量', 'media.maxAttachmentsPerRequest', { type: 'number', min: 0, required: true });
            extras.appendChild(note('输出过短可能截断结构化结果，上下文过小会更频繁地压缩。首次体验建议保留 4096 token 输出和 32000 字符上下文。字符与 token 不是同一单位。'));
            toggle(card, 'Koishi 重启后自动运行已创建的世界', 'autoStart', '初次体验建议关闭，手动启动、观察用量后再决定。已有世界开启后，保存配置导致的重启也会恢复运行。');
            card.appendChild(note('这些设置不是金额硬上限。输入、输出、媒体及辅助模型都可能计费；请在模型服务商处设置额度或余额限制。首次运行后在「模型用量」查看消耗，不再体验时在总览暂停世界。', true));
            var extrasOn = [];
            if (draft.config.apps.camera.enabled) extrasOn.push('相机生图'); if (draft.config.apps.assistant.enabled) extrasOn.push('手机助手');
            Object.entries(draft.config.captioners || {}).forEach(function (entry) { if (entry[1].enabled) extrasOn.push(entry[0] + ' 媒体解释器'); });
            if (extrasOn.length) card.appendChild(note('目前已启用的额外模型能力：' + extrasOn.join('、') + '。本引导保留这些设置，可在高级配置中调整。'));
        }
        function securityStep() {
            var card = panel('决定谁能管理，角色能做什么', 'WebUI 管理员可以操作世界、设备和模型配置。聊天平台的基础收发能力在启动后可自主使用。');
            card.appendChild(note('当前监听 ' + draft.config.webui.host + ':' + draft.config.webui.port + '。' + (draft.setup.safety.publicBinding ? '当前配置允许非本机连接，请设置访问令牌后完成引导。' : '当前只监听本机；通过代理转发仍可能对外开放。')));
            tokenInput = field(card, 'WebUI 管理员访问令牌', 'webui.token', { type: 'password', hint: '只在本机使用时可留空。通过局域网或公网访问时请设置令牌，并使用 HTTPS 或可信的安全连接。' });
            var actions = el('div', { cls: 'setup-inline-actions' });
            actions.append(action('生成随机令牌', 'generate-token', function () { var bytes = crypto.getRandomValues(new Uint8Array(24)); var value = Array.from(bytes).map(function (v) { return v.toString(16).padStart(2, '0'); }).join(''); change('webui.token', value); tokenInput.value = value; }), action('复制新令牌', 'copy-token', function () { var value = get(draft.config, 'webui.token'); if (!value || value === MASK) { say('已保存的令牌不会回传；可生成新令牌后复制。'); return; } copyText(value, '令牌已复制，请保存到密码管理器'); })); card.appendChild(actions);
            card.appendChild(note('新令牌保存成功后会用于此浏览器重新连接。不要把管理员令牌分享给访客；可之后在「访问管理」创建受限账号。'));
            toggle(card, '允许角色浏览互联网', 'apps.browserEnabled', '现实世界会访问真实网页，并可操作网页；架空世界由世界模型模拟互联网。');
            toggle(card, '允许角色发消息触发其他 Koishi 指令', 'messaging.selfCommands', '默认关闭。开启后，角色可能触发其他插件的实际操作与额外用量。');
            toggle(card, '开放世界连接与来访', 'crossing.serverEnabled', '会启动独立监听服务；持邀请码的来访者使用你的世界模型。初次体验可关闭。');
            var extended = el('details', { cls: 'setup-details' }, [text('summary', '检查已有扩展权限')]); card.appendChild(extended);
            var on = Object.keys(draft.config.platformOps || {}).filter(function (key) { return draft.config.platformOps[key]; });
            extended.appendChild(note(on.length ? '已开启的平台扩展：' + on.join('、') + '。包括账号或群管理类能力时，请确认你愿意让角色自主使用。' : '平台扩展权限均关闭。基础聊天收发仍可使用；这不是发送频道白名单。'));
            extended.appendChild(note('现实电脑：' + draft.config.apps.computer.mode + '；真实文件应用：' + (draft.config.apps.filesEnabled ? '开启' : '关闭') + '；已启用 MCP 应用：' + (draft.config.apps.mcpServers || []).filter(function (server) { return server.enabled; }).length + ' 个。MCP 的本地命令在 Koishi 主机运行。'));
            extended.appendChild(action('关闭平台扩展、真实电脑和文件应用', 'reduce-permissions', function () { Object.keys(draft.config.platformOps || {}).forEach(function (key) { change('platformOps.' + key, false); }); change('apps.computer.mode', 'off'); change('apps.filesEnabled', false); draw(); }));
            extended.appendChild(note('上方按钮保留 MCP 配置。需要调整 MCP、频道通知、媒体输入或各类设备连接时，请在完成后进入高级配置。现实电脑关闭时，架空世界仍可有剧情中的电脑。'));
        }
        function row(list, label, value) { list.append(text('dt', label), text('dd', value)); }
        function reviewStep() {
            var card = panel('确认你的第一套配置', '保存会写入设定与配置，并重新加载插件。若已有世界且开启了自动启动，重载后会恢复持续运行；否则等待你手动启动。');
            var list = el('dl', { cls: 'setup-summary' }); card.appendChild(list);
            row(list, '角色模型', draft.config.bot.model + ' · ' + draft.config.bot.apiType);
            row(list, '世界模型', draft.reuse ? '复用角色连接 · ' + draft.config.bot.model : draft.config.world.model + ' · ' + draft.config.world.apiType);
            row(list, '角色与世界', draft.botDef.length + ' / ' + draft.worldDef.length + ' 字符（可返回上一步修改）');
            row(list, '时间', draft.config.clock.syncRealTime ? '与现实同步' : draft.config.clock.epoch);
            row(list, '运行节奏', '角色最小间隔 ' + draft.config.bot.minIntervalMs / 1000 + ' 秒；世界心跳 ' + draft.config.clock.tingleEveryUnits + ' TU');
            row(list, '成长整理', draft.config.bot.growth.enabled ? '开启，最少间隔 ' + Math.round(draft.config.bot.growth.reviewIntervalMs / 60000 * 10) / 10 + ' 分钟' : '关闭');
            row(list, '访问保护', draft.config.webui.token ? '已设置管理员令牌' : '无令牌；所有能连接的人都可管理');
            row(list, '重启后运行', draft.config.autoStart ? '自动运行已创建的世界' : '手动启动');
            row(list, '网页与指令', '浏览器' + (draft.config.apps.browserEnabled ? '开启' : '关闭') + '；Koishi 指令' + (draft.config.messaging.selfCommands ? '开启' : '关闭'));
            if (draft.setup.running) card.appendChild(note('当前世界正在运行。保存配置会重启插件；未开启自动启动时，世界将保持暂停。现有世界不会被重置。', true));
            card.appendChild(note('只应用引导中修改的配置，其他高级设置保留。保存后可继续配置多模态和设备，也可以直接创世、启动。'));
        }
        function validate() {
            if (draft.step === 0) {
                var groups = draft.reuse ? ['bot'] : ['bot', 'world'];
                for (var group of groups) {
                    var input = form.querySelector('[data-setup-path="' + group + '.baseURL"]');
                    if (!validEndpoint(draft.config[group].baseURL)) input.setCustomValidity('请输入有效的 http 或 https API 地址。');
                    var model = form.querySelector('[data-setup-path="' + group + '.model"]'); if (!draft.config[group].model.trim()) model.setCustomValidity('请填写模型名称。');
                }
            }
            if (draft.step === 1) ['botDef', 'worldDef'].forEach(function (key) { if (!validDefinition(draft[key])) form.querySelector('[data-setup-path="' + key + '"]').setCustomValidity('请填写设定，并替换「（尚未编写）」占位符。'); });
            if (draft.step === 3 && draft.setup.safety.publicBinding && !draft.config.webui.token) tokenInput.setCustomValidity('当前不是仅本机监听，请设置管理员访问令牌。');
            return form.reportValidity();
        }
        function draw() {
            if (!current()) return;
            holder.replaceChildren(); holder.dataset.setupStep = String(draft.step); holder.dataset.setupStatus = draft.status;
            var pageActions = [action('直接打开完整配置', 'advanced', function () { Studio.navigate('config'); }), action('暂时跳过', 'skip', skip)];
            pageActions.forEach(function (button) { button.disabled = ['saving', 'reconnecting', 'working'].includes(draft.status); });
            holder.appendChild(Studio.title('A FIRST STEP INTO YOUR WORLD', '从这里，让世界开始', '一步步连接模型、写下设定，再决定运行节奏与权限。', pageActions));
            if (draft.step !== 'done') {
                progress = el('ol', { cls: 'setup-progress', 'aria-label': '配置进度' });
                steps.forEach(function (name, index) { var item = el('li', { cls: index === draft.step ? 'is-current' : index < draft.step ? 'is-complete' : '' }); var button = action('', 'step-' + index, function () { if (index < draft.step || validate()) { draft.step = index; draft.message = ''; draw(); } }); button.disabled = index > draft.step || draft.status === 'saving' || draft.status === 'reconnecting'; button.setAttribute('aria-current', index === draft.step ? 'step' : 'false'); button.append(text('span', index < draft.step ? '✓' : String(index + 1)), text('strong', name)); item.appendChild(button); progress.appendChild(item); }); holder.appendChild(progress);
            }
            form = el('form', { cls: 'setup-form' }); form.onsubmit = function (event) { event.preventDefault(); next(); };
            body = el('div', { cls: 'setup-body' }); feedback = el('p', { cls: 'setup-feedback' + (draft.messageError ? ' is-error' : ''), role: 'status', 'aria-live': 'polite', hidden: !draft.message, text: draft.message || '' });
            controls = el('div', { cls: 'setup-footer' });
            form.append(body, feedback, controls); holder.appendChild(form);
            if (draft.step === 'done') completeStep();
            else {
                [modelsStep, storyStep, usageStep, securityStep, reviewStep][draft.step]();
                controls.append(text('small', '第 ' + (draft.step + 1) + ' / 5 步 · 最后统一保存'));
                if (draft.step > 0) controls.appendChild(action('上一步', 'back', function () { draft.step--; draft.message = ''; draw(); }));
                controls.appendChild(action(draft.step === 4 ? '保存配置' : '下一步', draft.step === 4 ? 'save' : 'next', next, true));
            }
            if (['saving', 'reconnecting', 'working'].includes(draft.status)) form.querySelectorAll('button,input,select,textarea').forEach(function (node) { node.disabled = true; });
            if (draft.status === 'reconnecting' || draft.status === 'saving') say('正在保存并重新连接，确认配置生效后即可继续。');
        }
        function next() {
            if (!current() || ['saving', 'reconnecting', 'working'].includes(draft.status) || !validate()) return;
            if (draft.step < 4) { draft.step++; draft.message = ''; draw(); window.scrollTo({ top: holder.offsetTop, behavior: 'smooth' }); }
            else save();
        }
        async function skip() {
            if (['saving', 'reconnecting', 'working'].includes(draft.status)) return;
            if (draft.dirty && !confirm('跳过将放弃本次尚未保存的引导草稿。仍然跳过吗？')) return;
            try { await api('POST', '/api/setup', { dismissed: true }); draft = null; Studio.navigate('overview'); }
            catch (error) { say('无法记录跳过状态：' + error.message, true); }
        }
        async function save() {
            draft.status = 'saving'; draw();
            var payload = { config: copy(draft.patch), reuseBotModel: draft.reuse, completed: true };
            if (draft.botDef !== draft.baselineBotDef) payload.botDef = draft.botDef;
            if (draft.worldDef !== draft.baselineWorldDef) payload.worldDef = draft.worldDef;
            var savedDraft = draft;
            draft.saveBaseline = draft.setup.updatedAt;
            var configuredToken = get(draft.patch, 'webui.token');
            draft.nextToken = typeof configuredToken === 'string' && configuredToken !== MASK ? configuredToken : TOKEN;
            try {
                // Mutations are not replayed automatically when authorization expires.
                var result = await request('POST', '/api/setup', payload, TOKEN);
                if (draft !== savedDraft || isVisitor()) return;
                var token = get(draft.patch, 'webui.token');
                if (typeof token === 'string' && token !== MASK) { TOKEN = token; localStorage.setItem('wui_token', token); owner = token; }
                if (evtSource) { evtSource.close(); evtSource = null; }
                draft.saved = true; draft.dirty = false; draft.setup = result.setup; draft.status = 'reconnecting';
                signal('saved');
            } catch (error) {
                if (draft !== savedDraft || isVisitor()) return;
                if (!error.status) {
                    // A lost response may have followed a successful save and token rotation.
                    draft.saveUnconfirmed = true; draft.status = 'reconnecting'; draft.setup.applied = false; signal('saved');
                } else {
                    draft.status = 'error'; draft.message = '保存未确认：' + error.message + '。未自动重发，请核对后重试。'; draft.messageError = true; signal('error');
                }
            }
        }
        async function request(method, path, data, token) {
            var response = await fetch(path, { method: method, headers: Object.assign(data ? { 'Content-Type': 'application/json' } : {}, token ? { Authorization: 'Bearer ' + token } : {}), body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(20000) });
            var result = await response.json();
            if (!response.ok) { var failure = new Error(result.error || 'HTTP ' + response.status); failure.status = response.status; throw failure; } return result;
        }
        async function reconnect(started, delayFirst) {
            if (!current()) return;
            if (delayFirst) { timer = setTimeout(function () { reconnect(started); }, 1100); return; }
            try {
                var state;
                if (draft.saveUnconfirmed) {
                    try { state = await request('GET', '/api/setup', null, draft.nextToken); }
                    catch (_) { state = await request('GET', '/api/setup', null, TOKEN); }
                    if (!current()) return;
                    if (!state.completed || state.updatedAt === draft.saveBaseline) throw new Error('尚未找到这次保存的记录；没有自动重发');
                    TOKEN = draft.nextToken; localStorage.setItem('wui_token', TOKEN); owner = TOKEN;
                } else state = await request('GET', '/api/setup', null, TOKEN);
                if (!current()) return;
                if (state.applied === false) throw new Error('服务仍在使用保存前的配置');
                var configuration = await request('GET', '/api/config', null, TOKEN);
                var definitions = await request('GET', '/api/state', null, TOKEN);
                if (!current()) return;
                draft.config = copy(configuration.value); draft.patch = {}; draft.setup = state; draft.step = 'done'; draft.status = 'ready'; draft.message = ''; draft.messageError = false; draft.dirty = false; draft.saveUnconfirmed = false; draft.saved = true;
                draft.botDef = draft.baselineBotDef = definitions.botDef || '';
                draft.worldDef = draft.baselineWorldDef = definitions.worldDef || '';
                delete draft.nextToken;
                draw(); connectSSE(); refreshOverview(false).catch(function () {}); return;
            } catch (error) {
                if (!current()) return;
                if (Date.now() - started > 45000) {
                    draft.status = 'error'; draft.step = 'done'; draft.message = '尚未确认配置生效：' + error.message + '。请检查 Koishi 日志，在控制台重启插件后再检查。'; draw(); return;
                }
            }
            timer = setTimeout(function () { reconnect(started); }, 1500);
        }
        function completeStep() {
            var ready = draft.setup.applied !== false && draft.status !== 'error', card = panel(ready ? '起点已准备好' : '确认保存结果', ready ? '现在可以创建世界，也可以先把高级能力配置完整。创世和持续运行分别由你启动。' : '保存成功返回后，仍需等插件重新加载并确认实际配置。');
            if (!ready) {
                card.appendChild(action('重新连接并检查', 'retry', function () { draft.status = 'reconnecting'; draft.message = ''; draw(); reconnect(Date.now()); }, true));
                card.appendChild(action('检查完整配置', 'advanced', function () { Studio.navigate('config'); }));
                card.appendChild(action('返回引导重新确认', 'edit', function () { draft.step = 0; draft.status = 'editing'; draft.message = ''; draw(); })); return;
            }
            var stages = el('div', { cls: 'setup-launch' }); card.appendChild(stages);
            var create = el('section', null, [text('span', '01', 'setup-launch-number'), text('h3', draft.setup.initialized ? '世界已经创建' : '写下第一幕'), text('p', draft.setup.initialized ? '保留当前世界，无需重复创世。' : '世界模型依据两份设定生成初始情境，会产生模型用量，可能需要几分钟。创世会清空此前收集的聊天记录。')]);
            if (!draft.setup.initialized) create.appendChild(action('创建世界', 'genesis', function () { runWorld('world.init'); }, true));
            var start = el('section', null, [text('span', '02', 'setup-launch-number'), text('h3', draft.setup.running ? '世界正在运行' : '让角色开始生活'), text('p', '启动后角色会持续行动，也可能主动向聊天平台发送消息。观察「运行洞察」和「模型用量」，需要时在总览暂停。')]);
            var startButton = action(draft.setup.running ? '前往世界总览' : '启动世界', 'start', function () { if (draft.setup.running) Studio.navigate('overview'); else runWorld('world.start'); }, true);
            startButton.disabled = !draft.setup.initialized; start.appendChild(startButton); stages.append(create, start);
            if (draft.pending) card.appendChild(note('有一项操作待确认，可前往总览的更多操作查看执行记录。'));
            var advanced = el('section', { cls: 'setup-advanced' }, [text('h3', '还想让它拥有更多能力？'), text('p', '高级配置是可选的，可以现在继续，也可以运行一段时间后再调整。')]);
            var links = el('div', { cls: 'setup-inline-actions' });
            [['图片、音频与视频', 'bot'], ['手机应用与电脑', 'apps'], ['聊天与通知', 'messaging'], ['完整配置', '']].forEach(function (item, index) { links.appendChild(action(item[0], index === 3 ? 'advanced' : 'advanced-' + item[1], function () { gotoCfg(item[1]); })); });
            advanced.appendChild(links); card.appendChild(advanced);
            controls.append(action('返回引导调整', 'edit', function () { draft.step = 0; draft.status = 'editing'; draft.message = ''; draw(); }), action('跳过高级配置，先探索界面', 'finish', function () { Studio.navigate('overview'); }));
        }
        async function runWorld(command) {
            if (draft.status === 'working' || draft.pending) return;
            var runningDraft = draft;
            draft.status = 'working'; draw(); say(command === 'world.init' ? '正在创世，进展可在运行洞察中查看。离开此页不会重复提交。' : '正在启动世界…');
            try {
                var catalog = await request('GET', '/api/commands', null, TOKEN);
                if (draft !== runningDraft || isVisitor()) return;
                var id = 'setup_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36));
                draft.pending = { id: id, command: command, instanceId: catalog.instanceId };
                await request('POST', '/api/commands', { id: id, command: command, instanceId: catalog.instanceId, args: command === 'world.init' ? { force: false } : {} }, TOKEN);
                if (draft === runningDraft && !isVisitor()) signal('run');
            } catch (error) {
                if (draft !== runningDraft || isVisitor()) return;
                if (error.status && error.status >= 400 && error.status < 500) draft.pending = null;
                if (draft.pending) { draft.message = '提交结果尚未确认，正在查执行记录，不会自动重发。'; signal('run'); }
                else { draft.status = 'ready'; draft.message = error.message; draft.messageError = true; signal('error'); }
            }
        }
        async function pollRun() {
            if (!current() || refreshing || !draft.pending) return;
            refreshing = true;
            try {
                var result = await request('GET', '/api/commands/' + encodeURIComponent(draft.pending.id), null, TOKEN);
                if (!current()) return;
                if (result.run.status !== 'running') {
                    var state = await request('GET', '/api/setup', null, TOKEN); if (!current()) return;
                    var expected = draft.pending.command === 'world.init' ? state.initialized : state.running;
                    draft.pending = null; draft.setup = state; draft.status = 'ready'; draw();
                    say(expected ? state.running ? '世界已启动。可以去看看角色正在做什么。' : '创世完成，可以启动角色了。' : result.run.error || result.run.result || '操作已返回，但世界尚未进入预期状态，请查看运行洞察。', !expected);
                    refreshOverview(false).catch(function () {}); return;
                }
            } catch (error) {
                if (!current()) return;
                if (error.status === 404) {
                    try {
                        var recovered = await request('GET', '/api/setup', null, TOKEN);
                        if (!current()) return;
                        draft.status = 'ready'; draft.pending = null; draft.setup = recovered;
                        draw(); say('执行记录已不可用，请核对世界当前状态。没有自动重发操作。', true); return;
                    } catch (_) { /* Keep the pending identity until the current world can be read. */ }
                }
                say('暂时无法读取执行状态，正在重连。不会重复提交操作。', true);
            } finally { refreshing = false; }
            timer = setTimeout(pollRun, 1500);
        }
        function onState(event) {
            if (!current() || event.detail.draft !== draft) return;
            clearTimeout(timer); draw();
            if (event.detail.phase === 'saved') reconnect(Date.now(), true);
            if (event.detail.phase === 'run') pollRun();
        }
        window.addEventListener('studio:setup-state', onState);
        draw();
        if (draft.status === 'reconnecting') reconnect(Date.now());
        else if (draft.pending) { draft.status = 'working'; draw(); pollRun(); }
        return function () { alive = false; clearTimeout(timer); window.removeEventListener('studio:setup-state', onState); if (active === instance) active = null; };
    });
})();
