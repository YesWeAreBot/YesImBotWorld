/* Natural-language world state and evidence-based growth. */
(function () {
    var statuses = { pending: '进行中', completed: '已完成', failed: '未完成', cancelled: '已取消', needs_input: '等待下一步' };
    function sv(tag, attrs, text) {
        var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs || {}).forEach(function (a) { n.setAttribute(a[0], String(a[1])); });
        if (text != null)
            n.textContent = String(text);
        return n;
    }
    function short(value, n) { var s = String(value); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    Studio.register('world', function (holder) {
        var alive = true, busy = false, data = null, selectedActor = Studio.takeSelectedActor(), chosenEvent = null, pendingFocus = null, readableStates = Object.create(null);
        var focusRequested = !!selectedActor;
        function readState(key) { return readableStates[key] || (readableStates[key] = {}); }
        var content = el('div'), actions = el('div', { cls: 'world-actions' }), eventsPanel = el('div', { cls: 'world-actions' });
        holder.append(Studio.title('THE WORLD, NOW', '世界实况', '阅读当前情境、角色处境与最近发生的事。', [Studio.button('刷新状态', 'refresh', refresh)]), content, actions, eventsPanel);
        content.appendChild(el('div', { cls: 'studio-skeleton' }));
        function drawNarrative(snapshot) {
            var page = el('div', { cls: 'world-narrative', 'data-world-mode': 'narrative' });
            var scene = el('section', { cls: 'studio-panel world-current-scene' }, [Studio.section('当前情境', '版本 #' + snapshot.sequence + ' · 世界 T=' + Number(snapshot.effectiveAt || 0).toFixed(1))]);
            scene.appendChild(ReadableData.render(snapshot.worldState || '世界还没有初始情境，请先保存设定并创建世界。', { raw: false, textLimit: 5000, state: readState('world:narrative') }));
            page.appendChild(scene);
            var actors = Object.entries(snapshot.actors || {}), actorPanel = el('section', { cls: 'studio-panel' }, [Studio.section('角色的处境', actors.length + ' 位角色')]);
            var list = el('div', { cls: 'world-narrative-actors' });
            actors.forEach(function (entry) {
                var actor = entry[1], card = el('article', { cls: 'world-narrative-actor' + (entry[0] === selectedActor ? ' selected' : ''), 'data-world-actor': entry[0], tabindex: -1 }, [el('h3', { text: actor.name || entry[0] })]);
                card.appendChild(ReadableData.render(actor.state || '尚无处境记录。', { raw: false, textLimit: 1600, state: readState('actor:' + entry[0]) }));
                list.appendChild(card);
            });
            if (actors.length) { actorPanel.appendChild(list); page.appendChild(actorPanel); }
            content.replaceChildren(page);
        }
        function refresh() {
            if (!alive || busy) return;
            busy = true;
            Studio.fetchWorld().then(function (result) {
                if (!alive) return;
                var changed = !data || JSON.stringify(data) !== JSON.stringify(result);
                data = result;
                if (pendingFocus) { applyFocus(pendingFocus); pendingFocus = null; changed = true; }
                if (chosenEvent) chosenEvent = data.events?.find(function (event) { return event.id === chosenEvent.id; }) || chosenEvent;
                if (changed || content.querySelector('.studio-error')) draw();
            }).catch(function (error) { if (alive) Studio.error(content, error, refresh); }).finally(function () { busy = false; });
        }
        function draw() {
            if (!data || !alive) return;
            drawNarrative(data.snapshot);
            drawActions(data.snapshot);
            drawEvents();
            if (focusRequested) {
                var target = chosenEvent ? eventsPanel.querySelector('.world-event-detail') : Array.from(content.querySelectorAll('[data-world-actor]')).find(function (card) { return card.dataset.worldActor === selectedActor; });
                if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
                focusRequested = false;
            }
        }
        function drawActions(snapshot) {
            actions.replaceChildren();
            var all = Object.values(snapshot.actions || {}).sort(function (a, b) { return (b.startedAt || 0) - (a.startedAt || 0); });
            var section = el('section', { cls: 'studio-panel' }, [Studio.section('行动进程', all.length + ' 条记录')]);
            if (!all.length) section.appendChild(Studio.empty('当前没有行动记录', '行动开始、完成、失败或取消都会留下明确状态。'));
            all.slice(0, 12).forEach(function (action) {
                section.appendChild(el('div', { cls: 'world-action-row' }, [
                    el('span', { cls: 'studio-badge ' + (action.status === 'failed' ? 'orange' : action.status === 'pending' ? '' : 'muted'), text: statuses[action.status] || action.status }),
                    el('span', { cls: 'intent' }, [el('span', { text: action.intent }), el('small', { text: action.reason || (action.status === 'pending' ? '世界正在回应这一意图' : action.status === 'needs_input' ? '本次行动结束，等待角色作出新的决定' : '本次行动已经结束') })]),
                    el('span', { cls: 'actor', text: snapshot.actors?.[action.actorId]?.name || action.actorId }),
                    el('time', { text: 'T ' + Number(action.startedAt || 0).toFixed(1) })
                ]));
            });
            actions.appendChild(section);
        }
        function eventTitle(event) { return event.payload?.intent || ({ 'world.perception': '此刻所见所闻', 'world.committed': '世界记录已保存' }[event.topic] || event.topic); }
        function showEvent(event) {
            chosenEvent = event;
            drawEvents();
            var detail = eventsPanel.querySelector('.world-event-detail');
            detail?.focus({ preventScroll: true });
            detail?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        function drawEvents() {
            eventsPanel.replaceChildren();
            var events = (data.events || []).filter(function (event) { return event.kind === 'event' || event.kind === 'observation' && event.topic === 'world.perception'; }).slice(-10).reverse();
            var panel = el('section', { cls: 'studio-panel' }, [Studio.section('最近发生', '最近 ' + events.length + ' 个已提交事件')]);
            var list = el('div', { cls: 'world-event-list' });
            events.forEach(function (event) {
                var actor = data.snapshot.actors?.[event.actorId], item = el('article', { cls: 'world-event-item', 'data-world-event': event.id });
                var header = el('div', { cls: 'world-event-header' }, [
                    el('span', { cls: 'world-event-sequence', text: '#' + event.sequence }),
                    el('div', { cls: 'world-event-heading' }, [el('strong', { text: eventTitle(event) }), el('small', { text: (actor?.name || event.actorId || event.source) + ' · ' + fmtTime(event.emittedAt) })]),
                    Studio.button('查看记录', 'file', function () { showEvent(event); })
                ]);
                item.appendChild(header);
                var prose = event.payload?.narrative || event.payload?.text || event.payload?.result;
                if (typeof prose === 'string') item.appendChild(el('div', { cls: 'world-event-prose' }, [ReadableData.render(prose, { raw: false, textLimit: 1300, state: readState('event-prose:' + event.id) })]));
                list.appendChild(item);
            });
            if (!events.length) list.appendChild(Studio.empty('还没有提交事件', '观察与执行记录会随着世界运转出现。'));
            panel.appendChild(list);
            if (chosenEvent) {
                var box = el('div', { cls: 'world-event-detail', tabindex: -1 });
                box.appendChild(el('h4', { text: eventTitle(chosenEvent) }));
                var related = chosenEvent.correlationId ? (data.events || []).filter(function (event) { return event.id !== chosenEvent.id && event.correlationId === chosenEvent.correlationId; }) : [];
                if (related.length) {
                    var links = el('div', { cls: 'toolbar' });
                    related.forEach(function (event) { links.appendChild(Studio.button('#' + event.sequence + ' ' + eventTitle(event), 'link', function () { showEvent(event); })); });
                    box.appendChild(links);
                }
                box.appendChild(ReadableData.render(chosenEvent, { state: readState('event:' + chosenEvent.id) }));
                panel.appendChild(box);
            }
            eventsPanel.appendChild(panel);
        }
        function applyFocus(detail) {
            selectedActor = detail.actorId || null;
            chosenEvent = data.events?.find(function (event) { return event.id === detail.eventId; }) || null;
            focusRequested = true;
        }
        var focus = function (event) {
            if (!data) { pendingFocus = event.detail; return; }
            applyFocus(event.detail); draw();
        };
        window.addEventListener('studio:focus-world-event', focus);
        var onRefresh = function () { if (!document.hidden) refresh(); };
        window.addEventListener('studio:refresh', onRefresh);
        var timer = setInterval(onRefresh, 15000);
        refresh();
        return function () { alive = false; clearInterval(timer); window.removeEventListener('studio:refresh', onRefresh); window.removeEventListener('studio:focus-world-event', focus); };
    });
    Studio.register('growth', function (holder) {
        var alive = true, rows = [], selected = null, kind = 'all', lifecycle = 'all', q = '', chosenEvidence = null, busy = false, identityOpen = false, dataStamp = null;
        var reviewStatus = null, reviewError = null, auditOpen = false;
        var kinds = { relationship: '关系', commitment: '承诺', preference: '偏好', state: '临时状态', habit: '习惯', trait: '性格倾向' };
        function worldTime(value) { return Number.isFinite(value) ? 'T ' + value.toFixed(1) + ' TU' : '时间未记录'; }
        function withdrawn(view) { return view.inactiveReason === 'corrected' || !!view.correction; }
        function inactive(view) { return !!view.needsReview || withdrawn(view) || view.active === false || view.inactiveReason === 'expired' || view.inactiveReason === 'retired'; }
        function lifecycleText(view) { return withdrawn(view) ? '已撤回' : view.needsReview ? '待复核 · 已隔离' : view.inactiveReason === 'expired' ? '已到期' : inactive(view) ? '已停止沿用' : '当前有效'; }
        function isolationReason(view) {
            var item = (reviewStatus?.recentIsolations || []).flatMap(function (batch) { return batch.claims || []; }).find(function (claim) { return claim.claimId === view.claimId && (view.records || []).some(function (record) { return record.id === claim.recordId; }); });
            return item?.reason || '原记录缺少可核验的身份、频道范围或行为依据，暂不用于自动回忆及当前行为判断；保留原始记录等待复核。';
        }
        var controls = el('div', { cls: 'world-controls' }), content = el('div'), regulationHolder = el('div');
        holder.append(Studio.title('A CHARACTER, WITH A HISTORY', '角色与成长', '从亲历的事情中形成认识与习惯，理解它们如何改变，又在什么情境下被想起。', [Studio.button('刷新记录', 'refresh', refresh)]), regulationHolder, controls, content);
        var regulation = InnerRegulation.mount(regulationHolder);
        var search = el('input', { cls: 'world-search', placeholder: '搜索对象、内容或适用情境', 'aria-label': '搜索成长记录', oninput: function () { q = search.value.toLowerCase().trim(); draw(); } });
        controls.appendChild(search);
        var group = el('div', { cls: 'world-filter-group growth-kind-filters', role: 'group', 'aria-label': '成长类型' });
        [['all', '全部类型']].concat(Object.entries(kinds)).forEach(function (k) { var b = Studio.button(k[1], null, function () { kind = k[0]; group.querySelectorAll('button').forEach(function (n) { n.classList.toggle('active', n === b); n.setAttribute('aria-pressed', String(n === b)); }); draw(); }); b.classList.toggle('active', k[0] === kind); b.setAttribute('aria-pressed', String(k[0] === kind)); group.appendChild(b); });
        controls.appendChild(group);
        var lifecycleGroup = el('div', { cls: 'world-filter-group growth-lifecycle-filters', role: 'group', 'aria-label': '认识是否有效' });
        [['all', '全部历史'], ['active', '当前有效'], ['inactive', '未在沿用']].forEach(function (item) { var b = Studio.button(item[1], null, function () { lifecycle = item[0]; lifecycleGroup.querySelectorAll('button').forEach(function (node) { node.classList.toggle('active', node === b); node.setAttribute('aria-pressed', String(node === b)); }); draw(); }); b.classList.toggle('active', lifecycle === item[0]); b.setAttribute('aria-pressed', String(lifecycle === item[0])); lifecycleGroup.appendChild(b); });
        controls.appendChild(lifecycleGroup);
        content.appendChild(el('div', { cls: 'studio-skeleton' }));
        function refresh() { regulation.refresh(); if (busy || !alive)
            return; busy = true; Promise.all([Studio.fetchGrowth(), isVisitor() ? Promise.resolve(null) : api('GET', '/api/bot/growth/status').then(function (status) { return { status: status }; }).catch(function (error) { return { error: error.message || String(error) }; })]).then(function (result) { if (!alive)
            return; var next = Array.isArray(result[0]) ? result[0] : []; reviewStatus = result[1]?.status || null; reviewError = result[1]?.error || null; var stamp = JSON.stringify([next, reviewStatus, reviewError]); if (stamp !== dataStamp) { rows = next; dataStamp = stamp; draw(); } }).catch(function (e) { if (alive) {
            dataStamp = null; Studio.error(content, e, refresh); } }).finally(function () { busy = false; }); }
        function drawReviewStatus() {
            if (isVisitor()) return null;
            var box = el('section', { cls: 'studio-panel growth-detail growth-review-status', 'aria-label': '成长整理进度' }, [el('h3', { text: '经历正在如何整理' })]);
            if (reviewError) { box.appendChild(el('p', { cls: 'growth-hint', text: '暂时无法读取整理进度：' + reviewError })); return box; }
            if (!reviewStatus) { box.appendChild(el('p', { cls: 'growth-hint', text: '正在读取审阅状态。' })); return box; }
            box.appendChild(el('div', { cls: 'regulation-metrics' }, [['待审阅经历', reviewStatus.pending], ['历史待补审', reviewStatus.deferred], ['已完成审阅', reviewStatus.reviews], ['未采纳提案', reviewStatus.rejected], ['审阅未完成', reviewStatus.failures]].map(function (item) { return el('div', { cls: 'regulation-metric' }, [el('span', { text: item[0] }), el('strong', { text: Number.isFinite(item[1]) ? String(item[1]) : '未记录' })]); })));
            box.appendChild(el('p', { cls: 'growth-hint', text: '待审阅与历史补审都是尚未处理的经历；未采纳提案不会变成角色认识。完成审阅也可能暂时没有新结论。' }));
            if (reviewStatus.isolations || reviewStatus.corrections) {
                box.appendChild(el('p', { cls: 'growth-correction-summary', text: '已隔离 ' + (reviewStatus.isolations || 0) + ' 批待复核记录 · 已撤回 ' + (reviewStatus.corrections || 0) + ' 项判断。隔离与撤回不会新增经历，也不会删除原始事实。' }));
                (reviewStatus.recentCorrections || []).slice(0, 3).forEach(function (correction) { box.appendChild(el('article', { cls: 'regulation-learning-record growth-correction-audit' }, [el('strong', { text: worldTime(correction.at) + ' · 已撤回' }), el('p', { text: correction.reason }), el('small', { text: '认识 ' + correction.claimId + ' · 审计 ' + correction.id })])); });
                (reviewStatus.recentIsolations || []).slice(0, 3).forEach(function (batch) { box.appendChild(el('article', { cls: 'regulation-learning-record growth-isolation-audit' }, [el('strong', { text: worldTime(batch.at) + ' · 待复核 · 已隔离' }), el('p', { text: (batch.claims || []).length + ' 项旧认识暂停自动沿用；尚未判定原结论真伪。' }), el('small', { text: '审计 ' + batch.id })])); });
            }
            var reviews = reviewStatus.recent || [];
            if (reviewStatus.lastOutcome === 'failed') box.appendChild(el('p', { cls: 'growth-review-outcome', text: '最近一次审阅未完成，尚未得到可提交的结果；原经历保留等待后续整理。' }));
            else if (reviewStatus.lastOutcome === 'completed') box.appendChild(el('p', { cls: 'growth-review-outcome', text: '最近一次审阅已完成，留下 ' + (reviews[0]?.records?.length || 0) + ' 项认识记录。没有新认识与生成失败是不同的结果。' }));
            var failures = reviewStatus.recentFailures || (reviewStatus.lastFailure ? [reviewStatus.lastFailure] : []);
            if (failures.length) {
                box.appendChild(el('h4', { text: '最近未完成的审阅' }));
                failures.forEach(function (failure) { box.appendChild(el('article', { cls: 'regulation-learning-record growth-review-failure' }, [el('strong', { text: worldTime(failure.at) + ' · 未完成' }), el('p', { text: failure.reason }), Number.isFinite(failure.realAt) ? el('small', { text: '现实时间 ' + new Date(failure.realAt).toLocaleString() }) : null])); });
            }
            if (!reviews.length) box.appendChild(el('p', { text: '尚无完成的审阅。可以在运行洞察中查看 Growth 调用是否等待、生成或中断。' }));
            reviews.forEach(function (review) {
                var rejected = review.rejected || [], section = el('article', { cls: 'regulation-learning-record' }, [el('strong', { text: worldTime(review.at) + ' · ' + (review.backlogId ? '历史补审' : '近期审阅') }), el('p', { text: '留下 ' + (review.records?.length || 0) + ' 项认识记录 · 未采纳 ' + rejected.length + ' 项提案' })]);
                if (review.sampledEventIds) section.appendChild(el('p', { cls: 'growth-hint', text: '本次读取 ' + review.sampledEventIds.length + ' 项经历' + (review.omittedEvidenceCount ? ' · 未纳入本次样本 ' + review.omittedEvidenceCount + ' 项' : '') }));
                if (rejected.length) section.appendChild(el('ul', { cls: 'growth-review-rejections' }, rejected.map(function (item) { return el('li', { text: '提案 ' + (item.index + 1) + '：' + item.reason }); })));
                box.appendChild(section);
            });
            (reviewStatus.backlogs || []).filter(function (backlog) { return backlog.cursor < backlog.throughCursor; }).slice(0, 3).forEach(function (backlog) { box.appendChild(el('p', { cls: 'growth-hint', text: '历史待补审 ' + (backlog.throughCursor - backlog.cursor) + ' 项：' + backlog.reason })); });
            return box;
        }
        function appendReviewStatus() {
            var status = drawReviewStatus(); if (!status) return;
            if (!rows.length) { content.appendChild(status); return; }
            var audit = el('details', { cls: 'growth-review-disclosure', open: auditOpen }, [el('summary', { text: '整理与更正审计' + (reviewStatus ? ' · 隔离 ' + (reviewStatus.isolations || 0) + ' 批 · 已撤回 ' + (reviewStatus.corrections || 0) + ' 项' : '') }), status]);
            audit.ontoggle = function () { auditOpen = audit.open; }; content.appendChild(audit);
        }
        function draw() {
            if (!alive)
                return;
            var oldList = content.querySelector('.growth-claims'), scrollLeft = oldList?.scrollLeft || 0, scrollTop = oldList?.scrollTop || 0;
            var focused = document.activeElement?.dataset.growthClaim;
            content.replaceChildren();
            var found = rows.filter(function (r) { return (kind === 'all' || r.kind === kind) && (lifecycle === 'all' || (lifecycle === 'inactive') === inactive(r)) && (!q || [r.subject, r.statement, r.situation].concat(r.cues || []).join(' ').toLowerCase().includes(q)); });
            if (!found.length) {
                content.appendChild(el('section', { cls: 'studio-panel growth-empty' }, [Studio.empty(rows.length ? '没有匹配的认识' : '尚未形成成长记录', rows.length ? '尝试其他关键词、成长类型或有效状态。' : '开启自动整理后，已经感知的经历会定期回顾；角色也可以主动反思。关系、承诺、偏好、习惯与性格倾向都需要经历支撑；整理可以没有新结论，暂时空白不代表没有经历。')]));
                appendReviewStatus();
                return;
            }
            if (!found.some(function (r) { return r.claimId === selected; }))
                selected = found[0].claimId;
            var list = el('div', { cls: 'growth-claims', 'aria-label': '角色认识列表' }), detail = el('section', { cls: 'studio-panel growth-detail' });
            found.forEach(function (r) { list.appendChild(el('button', { cls: 'growth-claim' + (r.claimId === selected ? ' active' : '') + (inactive(r) ? ' inactive' : ''), 'data-growth-claim': r.claimId, 'aria-pressed': String(r.claimId === selected), onclick: function () { selected = r.claimId; chosenEvidence = null; identityOpen = false; draw(); } }, [el('span', { cls: 'growth-claim-heading' }, [el('span', { cls: 'studio-badge ' + (r.kind === 'commitment' || r.kind === 'state' ? 'orange' : r.kind === 'preference' || r.kind === 'habit' ? 'blue' : ''), text: kinds[r.kind] || '认识' }), el('span', { cls: 'subject', text: r.subject })]), el('p', { text: r.statement }), r.situation ? el('span', { cls: 'growth-claim-situation', text: r.situation }) : null, el('small', { text: (r.evidence?.length || 0) + ' 项经历 · ' + (r.records?.length || 0) + ' 次记录 · ' + lifecycleText(r) + (r.status === 'contested' ? ' · 存在反证' : '') })])); });
            var view = found.find(function (r) { return r.claimId === selected; });
            drawDetail(detail, view);
            content.appendChild(el('div', { cls: 'growth-workspace' }, [list, detail]));
            appendReviewStatus();
            list.scrollLeft = scrollLeft; list.scrollTop = scrollTop;
            if (focused) Array.from(list.querySelectorAll('[data-growth-claim]')).find(function (node) { return node.dataset.growthClaim === focused; })?.focus({ preventScroll: true });
        }
        function showEvidence(id) { chosenEvidence = id; draw(); content.querySelector('.growth-evidence-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        function drawDetail(detail, view) {
            var records = view.records || [], evidence = view.evidence || [];
            detail.appendChild(el('span', { cls: 'growth-lifecycle' + (inactive(view) ? ' inactive' : ''), text: lifecycleText(view) + (Number.isFinite(view.expiresAt) ? (inactive(view) ? ' · 原记录期限 ' : ' · 有效至世界时间 ') + worldTime(view.expiresAt) : '') }));
            detail.appendChild(el('div', { cls: 'growth-topline' }, [el('span', { cls: 'studio-badge ' + (view.status === 'contested' ? 'orange' : ''), text: view.status === 'contested' ? '存在反证' : '暂定认识' }), el('span', { cls: 'studio-description', text: '关于 ' + view.subject })]));
            detail.append(el('h2', { text: view.statement }), el('p', { cls: 'growth-hint', text: inactive(view) ? '这条记录已停止沿用，保留在这里供回顾；原有证据和判断没有被删除。' : view.kind === 'state' ? '临时状态只描述这段时间的感受与处境，不会直接归纳成性格。' : '这是有适用范围、可以改变的倾向。证据数量不会自动把它变成永久人格。' }));
            if (withdrawn(view)) {
                var correction = view.correction;
                detail.appendChild(el('div', { cls: 'growth-situation growth-claim-correction' }, [el('strong', { text: '判断已撤回，不再指导行为' }), el('p', { text: correction?.reason || '原判断已被追加更正，保留原文供审计。' }), correction ? el('p', { cls: 'growth-hint', text: '更正于 ' + worldTime(correction.at) + ' · 原记录 ' + correction.recordId + ' · 审计 ' + correction.id }) : null]));
            } else if (view.needsReview) {
                detail.appendChild(el('div', { cls: 'growth-situation growth-claim-isolation' }, [el('strong', { text: '待复核，已暂停自动沿用' }), el('p', { text: isolationReason(view) }), el('p', { cls: 'growth-hint', text: '这是证据适用范围的隔离，不代表原结论已经证实或被判定为错误。认识编号：' + view.claimId })]));
            }
            if (view.kind === 'state' && view.stateTimingCorrection) {
                var timing = view.stateTimingCorrection;
                detail.appendChild(el('div', { cls: 'growth-situation growth-time-correction' }, [el('strong', { text: '适用时间已校正' }), el('p', { text: timing.reason || '按原始经历发生的时间重新确定适用期限，避免较晚整理让过去的临时状态重新生效。' }), el('p', { cls: 'growth-hint', text: '证据时刻：' + worldTime(timing.evidenceAt) + ' · 校正后有效至：' + worldTime(timing.expiresAt) }), el('p', { cls: 'growth-hint', text: '原先记录为 ' + worldTime(timing.previousExpiresAt) + '；下方时间轴保留原始记录。此次只校正适用时间，没有新增成长认识。' })]));
            }
            if (view.situation || view.cues?.length) {
                var context = el('div', { cls: 'growth-situation' });
                if (view.situation) context.append(el('strong', { text: '适用情境' }), el('p', { text: view.situation }));
                if (view.cues?.length) context.append(el('span', { cls: 'growth-hint', text: '相关回忆线索' }), el('div', { cls: 'growth-cues' }, view.cues.map(function (cue) { return el('span', { text: cue }); })));
                detail.appendChild(context);
            }
            if (view.subjectId) { var identity = el('details', { cls: 'growth-identity', open: identityOpen }, [el('summary', { text: '关联对象身份' }), el('p', { text: view.subject }), el('code', { text: view.subjectId })]); identity.ontoggle = function () { identityOpen = identity.open; }; detail.appendChild(identity); }
            var map = el('div', { cls: 'growth-evidence-map' });
            var shown = evidence.slice(0, 8), h = Math.max(220, shown.length * 51 + 20), svg = sv('svg', { viewBox: '0 0 590 ' + h, role: 'img', 'aria-label': '认识与观测证据的联系，选择证据查看原文' });
            shown.forEach(function (e, i) {
                var y = 18 + i * 51, counter = records.some(function (r) { return r.relation === 'counter' && (r.evidenceIds || []).includes(e.eventId); });
                svg.appendChild(sv('path', { d: 'M215,' + (h / 2) + 'C280,' + (h / 2) + ' 260,' + (y + 18) + ' 326,' + (y + 18), fill: 'none', stroke: counter ? 'var(--accent2)' : 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': counter ? '5 4' : '' }));
                var node = sv('g', { transform: 'translate(326 ' + y + ')', class: 'growth-evidence-node', role: 'button', tabindex: 0, 'aria-label': '查看证据 ' + e.eventId });
                node.appendChild(sv('rect', { width: 234, height: 38, rx: 8, fill: 'var(--surface)', stroke: 'var(--line2)' }));
                node.appendChild(sv('text', { x: 12, y: 16, fill: 'var(--fg)', 'font-size': 10 }, short(e.text, 21)));
                node.appendChild(sv('text', { x: 12, y: 29, fill: 'var(--fg-dim)', 'font-size': 8 }, e.source + ' · ' + worldTime(e.observedAt)));
                node.addEventListener('click', function () { showEvidence(e.eventId); });
                node.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    showEvidence(e.eventId);
                } });
                svg.appendChild(node);
            });
            var center = sv('g', { transform: 'translate(22 ' + (h / 2 - 35) + ')' });
            center.appendChild(sv('rect', { width: 193, height: 70, rx: 12, fill: 'var(--panel2)', stroke: 'var(--line2)' }));
            center.appendChild(sv('text', { x: 15, y: 24, fill: 'var(--accent)', 'font-size': 10 }, short((withdrawn(view) ? '已撤回 · ' : view.needsReview ? '待复核 · ' : inactive(view) ? '过去的认识 · ' : '当前认识 · ') + view.subject, 17)));
            center.appendChild(sv('text', { x: 15, y: 44, fill: 'var(--fg)', 'font-size': 11 }, short(view.statement, 15)));
            svg.appendChild(center);
            map.style.height = Math.min(450, h) + 'px';
            map.appendChild(svg);
            detail.appendChild(map);
            if (evidence.length > shown.length)
                detail.appendChild(el('p', { cls: 'growth-hint', text: '关系图显示前 8 项证据，全部证据可从下方历史逐条打开。' }));
            detail.appendChild(Studio.section('认识如何形成', records.length + ' 次记录'));
            records.forEach(function (r) {
                var chips = el('div', { cls: 'growth-evidence-chips' });
                (r.evidenceIds || []).forEach(function (id) { var observed = evidence.find(function (e) { return e.eventId === id; }), label = observed ? short(observed.text, 34) : '查看亲历证据'; var button = Studio.button(label, null, function () { showEvidence(id); }); button.title = observed ? worldTime(observed.observedAt) + ' · ' + observed.text : id; button.setAttribute('aria-label', label); chips.appendChild(button); });
                var origin = r.origin === 'automatic' ? '自动整理' : '主动反思';
                var body = el('div', null, [el('div', { cls: 'growth-record-head' }, [el('strong', { text: { support: '支持这条认识', counter: '出现新的反证', revise: '修订原有判断', retire: '停止沿用这条认识' }[r.relation] || r.relation }), el('time', { text: worldTime(r.recordedAt) })]), el('p', { text: r.statement })]);
                if (r.situation) body.appendChild(el('p', { cls: 'growth-hint', text: '当时的适用情境：' + r.situation }));
                if (r.cues?.length) body.appendChild(el('p', { cls: 'growth-hint', text: '当时的回忆线索：' + r.cues.join('、') }));
                if (Number.isFinite(r.expiresAt)) body.appendChild(el('p', { cls: 'growth-hint', text: '原始记录的有效期：世界时间 ' + worldTime(r.expiresAt) }));
                body.append(el('span', { cls: 'growth-record-origin', text: origin }), chips);
                detail.appendChild(el('div', { cls: 'growth-record' }, [el('span', { cls: 'growth-record-icon ' + r.relation, text: { support: '+', counter: '−', revise: '↗', retire: '✓' }[r.relation] || '·' }), body]));
            });
            if (chosenEvidence) {
                var e = evidence.find(function (e) { return e.eventId === chosenEvidence; });
                var box = el('div', { cls: 'growth-evidence-detail' });
                if (e) {
                    box.appendChild(el('strong', { text: '观测证据', style: 'font-size:12px' }));
                    box.appendChild(el('blockquote', { text: e.text }));
                    box.appendChild(el('small', { text: e.eventId + ' · ' + e.source + ' · ' + worldTime(e.observedAt) }));
                    if (e.rootEventIds?.length) {
                        box.appendChild(el('p', { cls: 'growth-hint', text: '原始事件来源' }));
                        e.rootEventIds.forEach(function (id) { box.appendChild(el('div', { style: 'font:9px var(--mono);overflow-wrap:anywhere', text: id })); });
                    }
                }
                else
                    box.appendChild(el('p', { text: '这项证据不在当前返回的数据中。' }));
                detail.appendChild(box);
            }
        }
        var onRefresh = function () { if (!document.hidden)
            refresh(); };
        var onDebug = function (event) { if (event.detail?.kind === 'bot.event') onRefresh(); };
        window.addEventListener('studio:refresh', onRefresh);
        window.addEventListener('studio:debug', onDebug);
        var timer = setInterval(onRefresh, 15000);
        refresh();
        return function () { alive = false; regulation.dispose(); clearInterval(timer); window.removeEventListener('studio:refresh', onRefresh); window.removeEventListener('studio:debug', onDebug); };
    });
})();
