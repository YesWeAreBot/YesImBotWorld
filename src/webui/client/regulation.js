/* Read-only view of the internal simulation; never writes character state. */
var InnerRegulation = (function () {
    'use strict';
    var needs = { recovery: '恢复', connection: '连接', autonomy: '自主', competence: '胜任', novelty: '探索' };
    var modulators = { dopamine: '多巴胺样', noradrenaline: '去甲肾上腺素样', serotonin: '血清素样', opioid: '阿片样', oxytocin: '催产素样' };
    var phases = { idle: '静息', rising: '反应积累', peak: '短暂峰值', recovery: '恢复中' };
    function number(value, digits) { return Number.isFinite(value) ? value.toFixed(digits == null ? 2 : digits) : '未记录'; }
    function time(value) { return Number.isFinite(value) ? '世界经过 ' + number(value, 1) + ' 秒' : '时间未记录'; }
    function signed(value) { return Number.isFinite(value) ? (value > 0 ? '+' : '') + value.toFixed(2) : '未记录'; }
    function svg(tag, attrs, text) { var node = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attrs || {}).forEach(function (a) { node.setAttribute(a[0] === 'cls' ? 'class' : a[0], String(a[1])); }); if (text != null) node.textContent = text; return node; }
    function action(call) {
        if (!call) return '行动内容未记录';
        var args = call.arguments || call.args || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
        var label = { act: '行动', send: '发送消息', wait: '等待', rest: '休息', observe: '观察', read_channel: '阅读会话', check_msg: '查看消息', open_app: '打开应用', close_app: '关闭应用', reflect: '整理认识', check_time: '查看时间' }[call.name] || call.name || '行动';
        var text = args.description || args.msg || args.intent || args.app || (Number.isFinite(args.n) ? args.n + ' TU' : Number.isFinite(args.duration) ? args.duration + ' TU' : '');
        return label + (text ? '：' + text : '');
    }
    function metric(label, value, hint) { return el('div', { cls: 'regulation-metric' }, [el('span', { text: label }), el('strong', { text: value }), hint ? el('small', { text: hint }) : null]); }
    function mount(holder) {
        if (isVisitor()) return {refresh:function(){},dispose:function(){}};
        var alive = true, busy = false, value = null, stamp = null, modulator = 'dopamine', chosen = null, plotState = {}, expanded = new Set();
        var badge = el('span', { cls: 'studio-badge muted', text: '读取中' }), detail = el('details', { cls: 'studio-panel regulation-panel', 'data-regulation': '' });
        var body = el('div', { cls: 'regulation-body' });
        detail.append(el('summary', { cls: 'regulation-summary' }, [el('div', null, [el('strong', { text: '内在调节' }), el('span', { text: '需要 · 信号 · 选择 · 学习' })]), badge]), body);
        holder.appendChild(detail);
        detail.addEventListener('toggle', function () { if (detail.open && value) draw(); });
        function refresh() {
            if (!alive || busy) return;
            busy = true;
            api('GET', '/api/regulation').then(function (result) {
                if (!alive) return;
                var next = JSON.stringify(result);
                if (next === stamp) return;
                value = result; stamp = next;
                badge.textContent = !value.enabled ? '未启用' : value.decisionEnabled === false ? '观察模式' : '运行中';
                badge.className = 'studio-badge' + (value.enabled ? '' : ' muted');
                if (detail.open) draw();
            }).catch(function (error) { if (alive) { stamp = null; badge.textContent = '暂时不可用'; Studio.error(body, error, refresh); } }).finally(function () { busy = false; });
        }
        function draw() {
            if (!alive || !value) return;
            plotState.capture?.();
            var focused = document.activeElement?.dataset.regulationFocus;
            var oldHistory = body.querySelector('.regulation-history-list'), historyScroll = oldHistory ? {left:oldHistory.scrollLeft,top:oldHistory.scrollTop} : null;
            body.replaceChildren();
            body.appendChild(el('p', { cls: 'regulation-note', text: '这些信号是无量纲的机制模拟，不是真实递质浓度。它们调节需要、行动选择与经历学习；页面不为角色指定情绪标签。' }));
            if (!value.enabled) body.appendChild(Studio.empty('内在调节尚未启用', '可以在配置 → Bot 的「内在调节（实验性）」中开启。关闭时不新增评价和候选选择调用；既有记录保留供回顾。'));
            else if (value.decisionEnabled === false) body.appendChild(el('p', { cls: 'regulation-mode-note', text: '评分参与选择已关闭：仍评价实际感知、更新状态、预测原候选并学习实际结果；实际行动沿用原候选，可用于对比观察。' }));
            var state = value.state;
            if (!state) { if (value.enabled) body.appendChild(Studio.empty('还没有调节记录', '角色获得可评价的实际经历后，这里会开始更新。')); return; }
            body.appendChild(el('p', { cls: 'regulation-note', text: '状态时点：' + time(state.at) }));
            var needGrid = el('div', { cls: 'regulation-needs', 'aria-label': '当前需要缺口' });
            Object.entries(needs).forEach(function (pair) {
                var amount = state.needs?.[pair[0]], finite = Number.isFinite(amount);
                needGrid.appendChild(el('div', { cls: 'regulation-need' }, [el('div', null, [el('strong', { text: pair[1] }), el('span', { text: number(amount) })]), el('meter', { min: 0, max: 1, value: finite ? amount : 0, 'aria-label': pair[1] + '需要缺口', 'aria-valuetext': finite ? number(amount) + '，越高表示越需要满足' : '未记录' })]));
            });
            body.append(el('h3', { text: '当前需要' }), el('p', { cls: 'regulation-note', text: '缺口范围 0–1；越高表示越需要满足，不代表某种情绪。' }), needGrid);
            body.appendChild(el('div', { cls: 'regulation-metrics' }, [metric('可控制程度', number(state.control)), metric('结果不确定性', number(state.uncertainty)), metric('已学习的处境与行动', String(Number.isFinite(value.learningCount) ? value.learningCount : Object.keys(state.learning || {}).length)), metric('等待实际结果', Number.isFinite(value.pendingExpectations) ? String(value.pendingExpectations) : '未记录', '包含执行结果或明确回应')]));
            drawPlot(state);
            drawHistory();
            drawLearning(state);
            if (state.options?.physiologyEnabled) drawPhysiology(state);
            var nextHistory = body.querySelector('.regulation-history-list'); if (nextHistory && historyScroll) { nextHistory.scrollLeft = historyScroll.left; nextHistory.scrollTop = historyScroll.top; }
            if (focused) body.querySelector('[data-regulation-focus="' + focused + '"]')?.focus({ preventScroll: true });
        }
        function drawPlot(state) {
            var header = el('div', { cls: 'regulation-section-heading' }, [el('h3', { text: '信号如何变化' })]), select = el('select', { 'aria-label': '选择递质样通路', 'data-regulation-focus': 'modulator' });
            Object.entries(modulators).forEach(function (pair) { select.appendChild(el('option', { value: pair[0], text: pair[1], selected: pair[0] === modulator })); });
            select.onchange = function () { modulator = select.value; draw(); };
            header.appendChild(select); body.appendChild(header);
            var samples = (value.recent || []).filter(function (entry) { return entry.state?.modulators; }).map(function (entry) { return { id: entry.id, state: entry.state, summary: entry.summary }; });
            if (!samples.some(function (sample) { return sample.state.at === state.at; })) samples.push({ id: 'current:' + state.at, state: state, summary: '当前状态' });
            samples.sort(function (a, b) { return a.state.at - b.state.at; });
            samples = samples.slice(-80);
            var width = Math.max(620, samples.length * 52), height = 215, left = 42, top = 22, bottom = 35;
            function x(i) { return samples.length === 1 ? width / 2 : left + i / (samples.length - 1) * (width - left - 25); }
            function y(amount) { return top + (1 - amount) / 2 * (height - top - bottom); }
            var chart = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'group', 'aria-label': modulators[modulator] + '活动曲线，点击时点查看详情', cls: 'insight-chart-svg regulation-chart' });
            [-1, 0, 1].forEach(function (tick) { chart.append(svg('line', { x1: left, x2: width - 15, y1: y(tick), y2: y(tick), stroke: 'var(--line)', 'stroke-dasharray': '3 5' }), svg('text', { x: left - 10, y: y(tick) + 4, 'text-anchor': 'end', fill: 'var(--fg-dim)', 'font-size': 10 }, tick.toFixed(1))); });
            var colors = { tonic: 'var(--accent)', phasic: 'var(--accent2)', adaptation: 'var(--accent-blue,#718fe4)' }, labels = { tonic: '背景活动', phasic: '短暂脉冲', adaptation: '适应程度' };
            Object.keys(colors).forEach(function (key) { var path = samples.map(function (point, index) { var amount = point.state.modulators?.[modulator]?.[key]; return Number.isFinite(amount) ? (index ? 'L' : 'M') + x(index) + ',' + y(amount) : ''; }).join(' '); if (samples.length > 1) chart.appendChild(svg('path', { d: path, fill: 'none', stroke: colors[key], 'stroke-width': key === 'phasic' ? 2.5 : 2, 'stroke-dasharray': key === 'adaptation' ? '5 4' : '' })); });
            var marks = samples.map(function (point, index) {
                var node = svg('g', {});
                node.appendChild(svg('rect', { x: x(index) - 22, y: top - 10, width: 44, height: height - bottom - top + 20, fill: 'transparent' }));
                Object.keys(colors).forEach(function (key) { var amount = point.state.modulators?.[modulator]?.[key]; if (Number.isFinite(amount)) node.appendChild(svg('circle', { cx: x(index), cy: y(amount), r: 3.5, fill: colors[key] })); });
                if (index === 0 || index === samples.length - 1) node.appendChild(svg('text', { x: x(index), y: height - 8, 'text-anchor': index === 0 ? 'start' : 'end', fill: 'var(--fg-dim)', 'font-size': 10 }, number(point.state.at, 0) + ' 秒'));
                chart.appendChild(node);
                return { key: point.id, node: node, title: modulators[modulator] + ' · ' + time(point.state.at), detail: function () { var box = el('div', { cls: 'regulation-point-detail' }); Object.keys(labels).forEach(function (key) { box.appendChild(metric(labels[key], number(point.state.modulators?.[modulator]?.[key]))); }); if (point.summary) box.appendChild(el('p', { text: point.summary })); return box; } };
            });
            body.appendChild(el('div', { cls: 'regulation-legend' }, Object.entries(labels).map(function (pair) { return el('span', null, [el('i', { style: 'background:' + colors[pair[0]] }), el('span', { text: pair[1] })]); })));
            var plot = StudioCharts.interactivePlot(chart, marks, plotState);
            plot.querySelector('[aria-label="图表缩放"]').dataset.regulationFocus = 'zoom';
            body.appendChild(plot);
            body.appendChild(el('p', { cls: 'regulation-note', text: '曲线使用已记录时点；横向按记录排列，点按可读世界时间。背景与适应范围 0–1，脉冲范围 −1–1。' }));
        }
        function recordType(entry) { return { decision: '行动选择', appraisal: '经历评价', learning: '预期更新', outcome: '结果学习', failure: '保持原有路径', fallback: '保持原有路径', error: '评价未完成，沿用原候选' }[entry.type] || '调节记录'; }
        function drawHistory() {
            var records = (value.recent || []).filter(function (entry) { return entry.type !== 'tick'; }).slice().sort(function(a,b){return b.at-a.at;}).slice(0, 30);
            body.appendChild(el('h3', { text: '选择与实际经历' }));
            if (!records.length) { body.appendChild(Studio.empty('还没有可回顾的选择', '候选行动、实际结果与预测差异会按发生顺序留下记录。')); return; }
            if (!records.some(function (entry) { return entry.id === chosen; })) chosen = records[0].id;
            var workspace = el('div', { cls: 'regulation-history' }), list = el('div', { cls: 'regulation-history-list', 'aria-label': '最近调节记录' }), panel = el('article', { cls: 'regulation-record-detail' });
            records.forEach(function (entry) { list.appendChild(el('button', { type: 'button', cls: 'regulation-record-choice' + (entry.id === chosen ? ' active' : ''), 'data-regulation-focus': 'record-' + entry.id.replace(/[^a-zA-Z0-9_-]/g, ''), 'aria-pressed': String(entry.id === chosen), onclick: function () { chosen = entry.id; draw(); } }, [el('strong', { text: recordType(entry) }), el('span', { text: entry.summary || (entry.selectedId ? '已比较候选并记录预测' : '查看本次变化与依据') }), el('small', { text: time(entry.at) })])); });
            var item = records.find(function (entry) { return entry.id === chosen; });
            panel.append(el('h4', { text: recordType(item) }), el('small', { text: time(item.at) }));
            if (item.summary) panel.appendChild(el('p', { text: item.summary }));
            if (item.reason) panel.appendChild(el('p', { text: item.reason }));
            if (item.candidates?.length) {
                panel.appendChild(el('p', { cls: 'regulation-note', text: '选择表示提交到执行路径的意图；是否完成以实际结果为准。分数用于同一次比较，不代表快乐程度。' }));
                item.candidates.forEach(function (scored) {
                    var candidate = scored.candidate || scored, selected = candidate.id === item.selectedId;
                    var card = el('div', { cls: 'regulation-candidate' + (selected ? ' selected' : '') }, [el('div', { cls: 'regulation-candidate-heading' }, [el('strong', { text: action(candidate.call) }), el('span', { cls: 'studio-badge' + (selected ? '' : ' muted'), text: selected ? '已选择' : '候选' })])]);
                    var forecast = (item.candidateForecasts || []).find(function(row){return row.candidateId === candidate.id;});
                    if (forecast?.explanation || candidate.reason) card.appendChild(el('p', { text: forecast?.explanation || candidate.reason }));
                    if (Number.isFinite(forecast?.probability)) card.appendChild(el('p', { cls:'regulation-note', text:'预期结果发生的主观概率 ' + number(forecast.probability) }));
                    var factors = scored.factors;
                    if (factors) card.appendChild(el('p', { cls: 'regulation-note', text: '综合 ' + signed(scored.score) + ' · 需要收益 ' + signed(factors.needValue) + ' · 成本 ' + number(factors.cost) + ' · 风险 ' + number(factors.risk) + ' · 承诺 ' + signed(factors.commitment) + ' · 探索 ' + signed(factors.exploration) + ' · 已学习 ' + (factors.learnedSamples || 0) + ' 次' }));
                    var expected = scored.prediction?.expectedEffects || candidate.expectedEffects;
                    if (expected) card.appendChild(effects(expected, '预期影响'));
                    card.appendChild(settlementNote(candidate.settlement || scored.prediction?.settlement));
                    panel.appendChild(card);
                });
            }
            var appraisals = item.appraisals || (item.appraisal ? [item.appraisal] : []), effectRows = item.effects || (item.effect ? [item.effect] : []);
            appraisals.forEach(function (appraisal) {
                var explanation = (item.appraisalExplanations || []).find(function(row){return row.appraisalId === appraisal.id;})?.explanation;
                if (explanation) panel.appendChild(el('p', {text:explanation}));
                panel.appendChild(effects(appraisal.needEffects || {}, '本次经历的影响'));
                panel.appendChild(el('p', { cls: 'regulation-note', text: '显著程度 ' + number(appraisal.salience) + ' · 新颖程度 ' + number(appraisal.novelty) + ' · 可控制程度 ' + number(appraisal.control) + ' · 不确定性 ' + number(appraisal.uncertainty) }));
            });
            effectRows.forEach(function(effect) { panel.appendChild(el('p', { text: effect.applied === false ? '本次未重复更新状态。' : '已更新实际感知的影响，满足反馈 ' + signed(effect.satisfaction) + '。' })); });
            var learningRows = Array.isArray(item.learning) ? item.learning : item.learning ? [item.learning] : [];
            learningRows.forEach(function(record) { if (record.last) panel.appendChild(comparisonBlock(record.last, record.settlement, record.call)); });
            if (item.last) panel.appendChild(comparisonBlock(item.last, item.settlement));
            var ids = item.eventIds || appraisals.flatMap(function(appraisal){return appraisal.eventIds || [];});
            if (ids.length) { var details = el('details', { cls: 'regulation-evidence', open: expanded.has(item.id) }, [el('summary', { text: '关联 ' + ids.length + ' 项感知记录' }), el('p', { text: ids.join(' · ') })]); details.ontoggle = function () { if (details.open) expanded.add(item.id); else expanded.delete(item.id); }; panel.appendChild(details); }
            workspace.append(list, panel); body.appendChild(workspace);
        }
        function effects(values, title) { var changes = Object.keys(needs).filter(function (key) { return Number.isFinite(values[key]) && values[key] !== 0; }); return el('div', { cls: 'regulation-effects' }, [el('strong', { text: title }), el('p', { text: changes.length ? changes.map(function (key) { return needs[key] + '缺口' + (values[key] > 0 ? '缓解 ' : '增加 ') + number(Math.abs(values[key])); }).join(' · ') : '没有预计或识别出的需要变化。' })]); }
        function settlementNote(settlement) { return el('p', {cls:'regulation-note regulation-settlement',text:settlement === 'reply' ? '预期类型：等待明确回应。消息发出本身不能确认对方是否答应。' : '预期类型：执行结果。依据实际执行的完成或失败更新。'}); }
        function comparisonBlock(last, settlement, call) {
            var outcome = '';
            if (last.outcome) outcome = settlement === 'reply'
                ? last.outcome === 'failed' ? '相关行动已失败，不能据此推断对方的态度。' : '已收到用于更新预期的明确回应；是否答应以回应内容为准。'
                : last.outcome === 'failed' ? '动作执行已确认失败，结果仍用于修正执行预期。' : call?.name === 'send' ? '消息发送已完成；对方是否回应或答应仍未由此确定。' : '动作执行已确认完成。';
            return el('div', null, [outcome ? el('p', {cls:'regulation-note',text:outcome}) : null, el('div', { cls: 'regulation-metrics' }, [metric('事前预测', signed(last.expected)), metric('实际结果', signed(last.observed)), metric('预测差异', signed(last.predictionError), '实际结果 − 事前预测')])]);
        }
        function drawLearning(state) {
            var records = Object.values(state.learning || {}).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
            var total = Number.isFinite(value.learningCount) ? value.learningCount : records.length, shown = Math.min(records.length,20);
            var section = el('details', { cls: 'regulation-learning', open: expanded.has('learning') }, [el('summary', { text: '已经学到的行动预期 · ' + total + ' 项' })]);
            if (total > shown) section.appendChild(el('p', {cls:'regulation-note',text:'当前展示最近 ' + shown + ' 项，全部已学习 ' + total + ' 项。'}));
            section.ontoggle = function () { if (section.open) expanded.add('learning'); else expanded.delete('learning'); };
            if (!records.length) section.appendChild(el('p', { cls: 'regulation-note', text: '自主选择与已确认的完成或失败结果形成配对后，才更新行动预期；被迫动作和旁观经历不会算作自主偏好。' }));
            records.slice(0, 20).forEach(function (record) {
                var related = (value.recent || []).flatMap(function(entry){return entry.candidates || [];}).find(function(scored){return scored.prediction?.learningKey === record.key;});
                var row = el('article', { cls: 'regulation-learning-record' }, [el('strong', { text: record.contextKey || '已记录的处境' }), el('p', { text: '已学习 ' + record.samples + ' 次 · ' + time(record.updatedAt) }), effects(record.expectedEffects || {}, '目前预计的影响')]);
                if (record.call || related?.candidate?.call) row.insertBefore(el('p', {text:action(record.call || related.candidate.call)}), row.children[1]);
                else if (record.strategyKey) row.insertBefore(el('p', {text:record.strategyKey}), row.children[1]);
                else row.insertBefore(el('p', {cls:'regulation-note',text:'对应行动不在近期审计窗口内；保留已学习的结果。'}), row.children[1]);
                row.appendChild(settlementNote(record.settlement));
                if (record.last) row.appendChild(comparisonBlock(record.last, record.settlement, record.call)); section.appendChild(row); });
            body.appendChild(section);
        }
        function drawPhysiology(state) {
            var p = state.physiology || {};
            body.appendChild(el('section', { cls: 'regulation-physiology' }, [el('h3', { text: '阶段性生理反射' }), el('p', { cls: 'regulation-note', text: '这里是内部反射模型的阶段，不表示世界已提交身体事实；不据此推断意愿、愉悦或关系。' }), el('div', { cls: 'regulation-metrics' }, [metric('当前阶段', phases[p.phase] || '未记录'), metric('兴奋输入', number(p.excitation)), metric('抑制输入', number(p.inhibition))]) ]));
        }
        return { refresh: refresh, dispose: function () { alive = false; } };
    }
    return { mount: mount };
})();
