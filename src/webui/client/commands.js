(function () {
    'use strict';
    // Keep drafts and uncertain requests across navigation, scoped to the administrator session.
    var sessions = Object.create(null);
    var icons = { status: 'activity', start: 'play', stop: 'pause', reload: 'refresh', inject: 'message', travel: 'portal', init: 'world', clearmsg: 'message', reset: 'refresh', webui: 'link' };
    window.WorldCommands = { mount: function (container) {
        if (isVisitor()) return function () {};
        var authToken = TOKEN || '', state = sessions[authToken] || (sessions[authToken] = { drafts: Object.create(null), pending: null, sending: false, selected: '', selectedRun: '', historyOpen: false });
        var disposed = false, catalog = null, requestBusy = false, historySignature = '', showingCatalog = true;
        var wrapper = el('span', { cls: 'commands-menu' });
        var toggle = el('button', { type: 'button', cls: 'commands-more', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: '更多世界操作', onclick: openPanel }, [el('span', { cls: 'commands-more-icon', html: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="16" cy="10" r="1.6"/></svg>' }), el('span', { text: '更多' }), el('i', { cls: 'commands-pending-dot', hidden: true })]);
        var page = el('dialog', { cls: 'commands-popover', 'aria-label': '更多世界操作' });
        var message = el('p', { cls: 'commands-message', role: 'status', 'aria-live': 'polite', hidden: true });
        var chooser = el('div', { cls: 'commands-catalog' }), form = el('div', { cls: 'commands-form', hidden: true });
        var history = el('div', { cls: 'commands-history', hidden: true }), detail = el('div', { cls: 'commands-detail', hidden: true });
        var statusLabel = el('span', { cls: 'commands-sync', text: '正在加载操作…' });
        var back = action('‹ 全部操作', function () { showingCatalog = true; syncPanels(); }, 'commands-back');
        var historyToggle = action('执行记录', function () { showingCatalog = false; state.historyOpen = true; syncPanels(); }, 'commands-history-toggle');
        var close = action('关闭', closePanel, 'commands-close');
        page.appendChild(el('header', { cls: 'commands-heading' }, [back, el('strong', { cls: 'commands-menu-title', text: '更多世界操作' }), close]));
        page.append(chooser, statusLabel, message, form, history, detail, historyToggle);
        wrapper.append(toggle, page); container.appendChild(wrapper);
        page.addEventListener('close', function () { toggle.setAttribute('aria-expanded', String(page.open)); });
        // Native dialog supplies focus trapping and Escape. Backdrop clicks dismiss the popover.
        page.addEventListener('click', function (event) { if (event.target !== page) return; var rect = page.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePanel(); });
        function positionPanel() {
            if (!page.open) return;
            var rect = toggle.getBoundingClientRect(), width = Math.min(showingCatalog ? 344 : 520, innerWidth - 32);
            page.style.width = width + 'px';
            page.style.left = Math.max(16, Math.min(rect.left, innerWidth - width - 16)) + 'px';
            var maxTop = Math.max(16, innerHeight - Math.min(page.scrollHeight + 2, innerHeight - 32) - 16);
            page.style.top = Math.max(16, Math.min(rect.bottom + 9, maxTop)) + 'px';
        }
        function openPanel() {
            if (page.open) { closePanel(); return; }
            showingCatalog = true; syncPanels(); page.showModal(); toggle.setAttribute('aria-expanded', 'true'); positionPanel();
            var focus = showingCatalog ? chooser.querySelector('button:not(:disabled)') : form.querySelector('input,textarea,select') || back;
            if (focus) focus.focus({ preventScroll: true });
        }
        function closePanel() { if (page.open) page.close(); toggle.setAttribute('aria-expanded', 'false'); toggle.focus({ preventScroll: true }); }
        window.addEventListener('resize', positionPanel);
        function say(text, danger) { if (disposed) return; message.textContent = text; message.hidden = !text; message.classList.toggle('is-error', !!danger); }
        function action(label, callback, extra) { return el('button', { type: 'button', cls: 'commands-button ' + (extra || ''), text: label, onclick: callback }); }
        function command(name) { return catalog && catalog.commands.find(function (item) { return item.name === (name || state.selected); }); }
        function draft() { return state.drafts[state.selected] || (state.drafts[state.selected] = {}); }
        function syncPanels() {
            var item = command();
            chooser.hidden = !showingCatalog;
            form.hidden = showingCatalog || !item || !item.fields.length || state.historyOpen;
            history.hidden = showingCatalog || !state.historyOpen;
            detail.hidden = showingCatalog || !state.selectedRun;
            back.hidden = showingCatalog;
            page.querySelector('.commands-menu-title').hidden = !showingCatalog;
            historyToggle.hidden = !showingCatalog;
            historyToggle.textContent = '执行记录' + (catalog && catalog.runs.length ? ' · ' + catalog.runs.length : '');
            positionPanel();
        }
        function drawChooser() {
            chooser.replaceChildren();
            catalog.commands.filter(function (item) { return item.name !== 'world.start' && item.name !== 'world.stop'; }).forEach(function (item) {
                var button = el('button', { type: 'button', cls: 'commands-choice ' + (item.name === state.selected ? 'is-selected' : ''), 'data-command': item.name, 'aria-label': item.title, title: item.description, onclick: function () {
                    state.selected = item.name; state.historyOpen = false; state.selectedRun = '';
                    if (!item.fields.length) { drawForm(); execute(); return; }
                    showingCatalog = false; drawChooser(); drawForm(); syncPanels();
                    var field = form.querySelector('input,textarea,select'); if (field) field.focus({ preventScroll: true });
                } }, [el('span', { cls: 'commands-choice-icon', html: icon(icons[item.name.split('.')[1]] || 'sliders') }), el('span', { cls: 'commands-choice-copy' }, [el('strong', { text: item.title }), el('small', { text: item.description })]), el('span', { cls: 'commands-choice-arrow', text: item.fields.length ? '›' : '↗', 'aria-hidden': 'true' })]);
                chooser.appendChild(button);
            });
            syncExecute();
        }
        function syncExecute() {
            if (!catalog) return;
            Array.from(chooser.querySelectorAll('[data-command]')).forEach(function (button) { var item = command(button.dataset.command); button.disabled = state.sending || !!state.pending || !!(item.mutates && catalog.busy); });
            toggle.querySelector('.commands-pending-dot').hidden = !(state.sending || state.pending || catalog.busy);
            toggle.title = state.sending || state.pending || catalog.busy ? '更多世界操作 · 有操作正在进行' : '更多世界操作';
            var button = form.querySelector('[data-command-execute]'), item = command();
            if (button && item) { button.disabled = state.sending || !!state.pending || !!(item.mutates && catalog.busy); button.textContent = state.sending ? '正在提交…' : state.pending ? '正在确认提交结果…' : item.mutates && catalog.busy ? '等待当前操作完成' : '执行' + item.title; }
        }
        function drawForm() {
            var item = command();
            form.replaceChildren();
            if (!item || !item.fields.length) return;
            var values = draft();
            form.appendChild(el('div', { cls: 'commands-form-heading' }, [el('h3', { text: item.title })]));
            form.appendChild(el('p', { cls: 'commands-description', text: item.description }));
            item.fields.forEach(function (field) {
                var input;
                if (field.type === 'boolean') input = el('input', { type: 'checkbox', checked: values[field.name] === true, onchange: function () { values[field.name] = input.checked; } });
                else if (field.type === 'world') {
                    input = el('select', { onchange: function () { values[field.name] = input.value; } });
                    input.appendChild(el('option', { value: '', text: '选择一个世界' }));
                    (catalog.worlds || []).forEach(function (world) { input.appendChild(el('option', { value: world.name, text: world.label })); });
                    input.value = values[field.name] || '';
                } else input = el(field.type === 'textarea' ? 'textarea' : 'input', { type: field.type === 'textarea' ? undefined : 'text', rows: field.type === 'textarea' ? '4' : undefined, value: values[field.name] || '', maxlength: field.type === 'textarea' ? '16000' : '256', oninput: function () { values[field.name] = input.value; } });
                if (field.type === 'textarea') input.value = values[field.name] || '';
                input.setAttribute('data-command-field', field.name);
                input.required = !!field.required;
                form.appendChild(el('label', { cls: 'commands-field' + (field.type === 'boolean' ? ' is-checkbox' : '') }, [field.type === 'boolean' ? input : null, el('span', { text: field.label }), field.type !== 'boolean' ? input : null, field.hint ? el('small', { text: field.hint }) : null]));
            });
            var button = action('执行' + item.title, execute, item.confirmation || item.name === 'world.init' ? 'is-sensitive' : 'is-primary');
            button.setAttribute('data-command-execute', '');
            form.appendChild(el('div', { cls: 'commands-actions' }, [button, el('small', { text: '执行后在此查看结果。收起窗口不会取消操作。' })]));
            syncExecute();
        }
        function status(run) { return { running: '执行中', completed: '已返回', failed: '执行失败' }[run.status] || run.status; }
        function drawHistory() {
            var runs = catalog.runs || [], run = runs.find(function (item) { return item.id === state.selectedRun; });
            var signature = JSON.stringify(runs) + ':' + state.selectedRun;
            if (signature === historySignature) {
                var elapsed = detail.querySelector('[data-command-elapsed]');
                if (elapsed && run) elapsed.textContent = '正在等待返回 · 已运行 ' + Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000)) + ' 秒';
                syncPanels(); return;
            }
            historySignature = signature;
            var scrollLeft = history.scrollLeft, scrollTop = history.scrollTop;
            history.replaceChildren();
            if (!runs.length) history.appendChild(el('p', { cls: 'commands-empty', text: '还没有操作记录。' }));
            runs.forEach(function (run) {
                var definition = command(run.command);
                history.appendChild(el('button', { type: 'button', cls: 'commands-run ' + (run.id === state.selectedRun ? 'is-selected' : ''), 'data-run-command': run.command, 'aria-pressed': String(run.id === state.selectedRun), onclick: function () { state.selectedRun = run.id; drawHistory(); } }, [el('strong', { text: definition ? definition.title : run.command }), el('span', { cls: 'commands-run-state ' + run.status, text: status(run) }), el('time', { text: new Date(run.startedAt).toLocaleString('zh-CN') })]));
            });
            history.scrollLeft = scrollLeft; history.scrollTop = scrollTop;
            detail.replaceChildren();
            if (!run) { state.selectedRun = ''; syncPanels(); return; }
            var item = command(run.command);
            detail.appendChild(el('div', { cls: 'commands-detail-title' }, [el('h3', { text: (item ? item.title : run.command) + ' · 操作回执' }), el('span', { cls: 'commands-run-state ' + run.status, text: status(run) }), action('收起回执', function () { state.selectedRun = ''; historySignature = ''; drawHistory(); })]));
            if (Object.keys(run.args || {}).length) {
                var args = el('dl', { cls: 'commands-arguments' });
                Object.keys(run.args).forEach(function (name) {
                    var field = item && item.fields.find(function (candidate) { return candidate.name === name; }), value = run.args[name];
                    args.append(el('dt', { text: field ? field.label : name }), el('dd', { text: typeof value === 'boolean' ? value ? '是' : '否' : value }));
                });
                detail.appendChild(args);
            }
            (run.messages || []).forEach(function (line) { detail.appendChild(el('p', { cls: 'commands-progress', text: line })); });
            if (run.result != null) detail.appendChild(el('div', { cls: 'commands-output', text: run.result }));
            if (run.error) detail.appendChild(el('div', { cls: 'commands-output is-error', text: run.error }));
            if (run.status === 'running') detail.appendChild(el('p', { cls: 'commands-progress', 'data-command-elapsed': '', text: '正在等待返回 · 已运行 ' + Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000)) + ' 秒' }));
            var diagnostic = el('details', { cls: 'commands-request-id' }, [el('summary', { text: '执行信息' }), el('code', { text: run.command + ' · ' + run.id })]);
            detail.appendChild(diagnostic);
            syncPanels();
        }
        function absorb(next) {
            if (disposed) return;
            var first = !catalog;
            catalog = next;
            if (state.pending) {
                var found = catalog.runs.find(function (run) { return run.id === state.pending.id; });
                if (found) { state.selectedRun = found.id; state.pending = null; say('请求已接收，下方会持续显示执行状态。'); }
                else if (state.pending.instanceId !== catalog.instanceId) { state.pending = null; say('服务已经重启。上次操作的完成状态不确定，请先检查世界现状再操作。', true); }
            }
            statusLabel.textContent = catalog.busy ? '有操作正在执行，回执持续更新' : '';
            statusLabel.hidden = !catalog.busy;
            if (first) { drawChooser(); drawForm(); }
            syncExecute(); drawHistory();
        }
        function refresh() {
            if (disposed || requestBusy) return Promise.resolve();
            requestBusy = true;
            return api('GET', '/api/commands').then(absorb).catch(function (error) { if (!disposed) say('状态同步失败：' + (error.message || error), true); }).finally(function () { requestBusy = false; });
        }
        function execute() {
            if (state.sending || state.pending || !catalog) return;
            var item = command(), values = draft(), args = {};
            if (!item || item.mutates && catalog.busy) return;
            for (var i = 0; i < item.fields.length; i++) {
                var field = item.fields[i], value = field.type === 'boolean' ? values[field.name] === true : String(values[field.name] || '').trim();
                if (field.required && !value) { say('请填写' + field.label + '。', true); var target = form.querySelector('[data-command-field="' + field.name + '"]'); if (target) target.focus(); return; }
                args[field.name] = value;
            }
            var confirmation = item.name === 'world.init' && args.force ? '确认归档并清空当前世界，强制重新创世？' : item.confirmation;
            if (confirmation && !confirm(confirmation)) return;
            var request = { id: 'cmd_' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)), instanceId: catalog.instanceId, command: item.name, args: args, confirmed: !!confirmation };
            showingCatalog = false; state.pending = request; state.sending = true; syncExecute(); say('正在提交' + item.title + '…'); syncPanels(); if (!item.fields.length) back.focus({ preventScroll: true });
            // Never automatically replay an administrative mutation after auth or network errors.
            fetch('/api/commands', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authToken ? { Authorization: 'Bearer ' + authToken } : {}), body: JSON.stringify(request) }).then(function (response) {
                return response.json().then(function (result) { if (!response.ok) { var error = new Error(result.error || '请求失败'); error.status = response.status; throw error; } return result; });
            }).then(function (result) {
                state.selectedRun = result.run.id; state.pending = null;
                if (disposed) return;
                catalog.runs = [result.run].concat(catalog.runs.filter(function (run) { return run.id !== result.run.id; }));
                say('请求已接收，执行状态会自动更新。'); drawHistory();
                window.dispatchEvent(new CustomEvent('studio:refresh'));
            }).catch(function (error) {
                // A definite HTTP rejection is safe to amend. A lost response stays pending until read back.
                if (error.status && error.status >= 400 && error.status < 500) state.pending = null;
                if (disposed) return;
                say(error.status ? '请求被拒绝：' + (error.message || error) : '提交结果尚未确认：' + (error.message || error) + '。正在查询执行记录；不会自动重发。', true);
            }).finally(function () { state.sending = false; if (!disposed) { syncExecute(); refresh(); } });
        }
        refresh(); var timer = setInterval(refresh, 1200);
        return function () { disposed = true; clearInterval(timer); window.removeEventListener('resize', positionPanel); if (page.open) page.close(); };
    } };
})();
