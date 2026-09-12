(function () {
    'use strict';
    Studio.register('commands', function (container) {
        if (isVisitor()) { container.appendChild(el('p', { text: '只有工作室管理员可以使用指令。' })); return; }
        var disposed = false, timer = null, catalog = null, selected = 'world.status', selectedRun = '', sending = false, requestBusy = false;
        var drafts = Object.create(null), pending = null, historySignature = '';
        var page = el('div', { cls: 'commands-page' }), message = el('p', { cls: 'commands-message', role: 'status', 'aria-live': 'polite' });
        var chooser = el('div', { cls: 'commands-catalog' }), form = el('div', { cls: 'commands-form' }), history = el('div', { cls: 'commands-history' }), detail = el('div', { cls: 'commands-detail' });
        page.appendChild(el('header', { cls: 'commands-heading' }, [el('div', {}, [el('div', { cls: 'eyebrow', text: 'WORLD COMMANDS' }), el('h1', { text: '管理指令' }), el('p', { text: '从工作室直接管理世界，与 Koishi 的 world 指令使用同一执行逻辑。' })]), el('span', { cls: 'commands-admin', text: '管理员入口' })]));
        page.appendChild(message);
        page.appendChild(el('div', { cls: 'commands-workspace' }, [chooser, form]));
        page.appendChild(el('section', { cls: 'commands-records' }, [el('div', { cls: 'commands-record-heading' }, [el('h2', { text: '执行记录' }), el('span', { text: '持续更新 · 最近 50 条' })]), el('div', { cls: 'commands-results' }, [history, detail])]));
        container.appendChild(page);

        function say(text, danger) { message.textContent = text; message.classList.toggle('is-error', !!danger); }
        function action(label, callback, extra) { return el('button', { type: 'button', cls: 'commands-button ' + (extra || ''), text: label, onclick: callback }); }
        function command() { return catalog.commands.find(function (item) { return item.name === selected; }); }
        function draft() { return drafts[selected] || (drafts[selected] = {}); }
        function drawChooser() {
            chooser.replaceChildren();
            catalog.commands.forEach(function (item) {
                chooser.appendChild(el('button', { type: 'button', cls: 'commands-choice ' + (item.name === selected ? 'is-selected' : ''), 'aria-pressed': item.name === selected ? 'true' : 'false', onclick: function () { selected = item.name; drawChooser(); drawForm(); } }, [el('strong', { text: item.title }), el('code', { text: item.name })]));
            });
        }
        function syncExecute() {
            var button = form.querySelector('[data-command-execute]');
            if (button) { button.disabled = sending || !!pending || !!(command().mutates && catalog.busy); button.textContent = sending ? '正在提交…' : command().mutates && catalog.busy ? '等待当前指令完成' : '执行 ' + command().title; }
        }
        function drawForm() {
            var item = command(), values = draft();
            form.replaceChildren(el('code', { cls: 'commands-code', text: item.name }), el('h2', { text: item.title }), el('p', { cls: 'commands-description', text: item.description }));
            item.fields.forEach(function (field) {
                var input;
                if (field.type === 'boolean') input = el('input', { type: 'checkbox', checked: values[field.name] === true, onchange: function () { values[field.name] = input.checked; } });
                else if (field.type === 'world') {
                    input = el('select', { onchange: function () { values[field.name] = input.value; } });
                    input.appendChild(el('option', { value: '', text: '选择一个世界' }));
                    (catalog.worlds || []).forEach(function (world) { input.appendChild(el('option', { value: world.name, text: world.label })); });
                    input.value = values[field.name] || '';
                } else input = el(field.type === 'textarea' ? 'textarea' : 'input', { type: field.type === 'textarea' ? undefined : 'text', rows: field.type === 'textarea' ? '5' : undefined, value: values[field.name] || '', maxlength: field.type === 'textarea' ? '16000' : '256', oninput: function () { values[field.name] = input.value; } });
                if (field.type === 'textarea') input.value = values[field.name] || '';
                input.setAttribute('data-command-field', field.name);
                input.required = !!field.required;
                form.appendChild(el('label', { cls: 'commands-field' + (field.type === 'boolean' ? ' is-checkbox' : '') }, [field.type === 'boolean' ? input : null, el('span', { text: field.label }), field.type !== 'boolean' ? input : null, field.hint ? el('small', { text: field.hint }) : null]));
            });
            var button = action('执行 ' + item.title, execute, item.confirmation || item.name === 'world.init' ? 'is-sensitive' : 'is-primary');
            button.setAttribute('data-command-execute', '');
            form.appendChild(el('div', { cls: 'commands-actions' }, [button, el('small', { text: '结果直接显示在这里；关闭页面不会取消已开始的指令。' })]));
            syncExecute();
        }
        function status(run) { return { running: '执行中', completed: '已返回', failed: '执行失败' }[run.status] || run.status; }
        function drawHistory() {
            var runs = catalog.runs || [];
            if (!selectedRun && runs.length) selectedRun = runs[0].id;
            var run = runs.find(function (item) { return item.id === selectedRun; });
            var signature = JSON.stringify(runs) + ':' + selectedRun;
            if (signature === historySignature) {
                var elapsed = detail.querySelector('[data-command-elapsed]');
                if (elapsed && run) elapsed.textContent = '正在等待指令返回 · 已运行 ' + Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000)) + ' 秒';
                return;
            }
            historySignature = signature;
            var scrollLeft = history.scrollLeft, scrollTop = history.scrollTop;
            history.replaceChildren();
            if (!runs.length) history.appendChild(el('p', { cls: 'commands-empty', text: '执行一条指令，结果会显示在这里。' }));
            runs.forEach(function (run) {
                history.appendChild(el('button', { type: 'button', cls: 'commands-run ' + (run.id === selectedRun ? 'is-selected' : ''), 'aria-pressed': run.id === selectedRun ? 'true' : 'false', onclick: function () { selectedRun = run.id; drawHistory(); } }, [el('code', { text: run.command }), el('span', { cls: 'commands-run-state ' + run.status, text: status(run) }), el('time', { text: new Date(run.startedAt).toLocaleString('zh-CN') })]));
            });
            history.scrollLeft = scrollLeft; history.scrollTop = scrollTop;
            detail.replaceChildren();
            if (!run) { detail.appendChild(el('p', { cls: 'commands-empty', text: '点按左侧记录查看返回内容。' })); return; }
            detail.appendChild(el('div', { cls: 'commands-detail-title' }, [el('h3', { text: run.command }), el('span', { cls: 'commands-run-state ' + run.status, text: status(run) })]));
            if (Object.keys(run.args || {}).length) detail.appendChild(el('pre', { cls: 'commands-arguments', text: JSON.stringify(run.args, null, 2) }));
            (run.messages || []).forEach(function (line) { detail.appendChild(el('p', { cls: 'commands-progress', text: line })); });
            if (run.result != null) detail.appendChild(el('pre', { cls: 'commands-output', text: run.result }));
            if (run.error) detail.appendChild(el('pre', { cls: 'commands-output is-error', text: run.error }));
            if (run.status === 'running') detail.appendChild(el('p', { cls: 'commands-progress', 'data-command-elapsed': '', text: '正在等待指令返回 · 已运行 ' + Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000)) + ' 秒' }));
            detail.appendChild(el('small', { cls: 'commands-request-id', text: '执行编号 ' + run.id }));
        }
        function absorb(next) {
            if (disposed) return;
            var first = !catalog;
            catalog = next;
            if (pending) {
                var found = catalog.runs.find(function (run) { return run.id === pending.id; });
                if (found) { selectedRun = found.id; pending = null; say('已确认请求已接收，下面会持续显示执行状态。'); }
                else if (pending.instanceId !== catalog.instanceId) { pending = null; say('服务已经重启。上次指令的完成状态不确定，请先检查世界现状再操作。', true); }
            }
            if (first) { drawChooser(); drawForm(); }
            syncExecute(); drawHistory();
        }
        function refresh() {
            if (disposed || requestBusy) return Promise.resolve();
            requestBusy = true;
            return api('GET', '/api/commands').then(absorb).catch(function (error) { if (!disposed) say('状态同步失败：' + (error.message || error), true); }).finally(function () { requestBusy = false; });
        }
        function execute() {
            if (sending || pending || !catalog) return;
            var item = command(), values = draft(), args = {};
            for (var i = 0; i < item.fields.length; i++) {
                var field = item.fields[i], value = field.type === 'boolean' ? values[field.name] === true : String(values[field.name] || '').trim();
                if (field.required && !value) { say('请填写' + field.label + '。', true); var target = form.querySelector('[data-command-field="' + field.name + '"]'); if (target) target.focus(); return; }
                args[field.name] = value;
            }
            var confirmation = item.name === 'world.init' && args.force ? '确认归档并清空当前世界，强制重新创世？' : item.confirmation;
            if (confirmation && !confirm(confirmation)) return;
            var request = { id: 'cmd_' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)), instanceId: catalog.instanceId, command: item.name, args: args, confirmed: !!confirmation };
            pending = request; sending = true; syncExecute(); say('正在提交 ' + item.name + '…');
            // Never automatically replay an administrative mutation after auth or network errors.
            fetch('/api/commands', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}), body: JSON.stringify(request) }).then(function (response) {
                return response.json().then(function (result) { if (!response.ok) { var error = new Error(result.error || '请求失败'); error.status = response.status; throw error; } return result; });
            }).then(function (result) {
                if (disposed) return;
                selectedRun = result.run.id; pending = null;
                catalog.runs = [result.run].concat(catalog.runs.filter(function (run) { return run.id !== result.run.id; }));
                say('请求已接收，执行状态会自动更新。'); drawHistory();
            }).catch(function (error) {
                if (disposed) return;
                say(error.status ? '请求被拒绝：' + (error.message || error) : '提交结果尚未确认：' + (error.message || error) + '。正在查询执行记录；不会自动重发。', true);
                // A definite HTTP rejection is safe to amend. A lost response stays pending until read back.
                if (error.status && error.status >= 400 && error.status < 500) pending = null;
            }).finally(function () { sending = false; if (!disposed) { syncExecute(); refresh(); } });
        }
        refresh(); timer = setInterval(refresh, 1200);
        return function () { disposed = true; clearInterval(timer); };
    });
})();
