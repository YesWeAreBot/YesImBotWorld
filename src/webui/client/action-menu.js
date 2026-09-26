/* A human-readable decision point, separate from the persistent writing dock. */
var WorldActionMenu = (function () {
    'use strict';
    function mount(actions) {
        var data = {}, stamp = '', sceneStamp = '', cards = new Map();
        var root = el('section', { cls: 'world-action-menu', 'aria-label': '选择下一步行动' });
        var art = el('span', { cls: 'action-menu-art', 'aria-hidden': 'true' });
        art.innerHTML = '<svg viewBox="0 0 88 88" fill="none"><circle cx="44" cy="44" r="36" stroke="currentColor" opacity=".18"/><path d="M44 72V49C44 34 20 39 20 19M44 49V16M44 49C44 34 69 39 69 19" stroke="currentColor" stroke-width="1.5"/><circle cx="20" cy="17" r="4" fill="var(--surface)" stroke="currentColor"/><circle cx="44" cy="14" r="4" fill="var(--surface)" stroke="currentColor"/><circle cx="69" cy="17" r="4" fill="var(--surface)" stroke="currentColor"/><circle cx="44" cy="69" r="6" fill="currentColor"/><path d="M53 67H73M63 57V77" stroke="currentColor" opacity=".3"/></svg>';
        var free = el('button', { type: 'button', cls: 'journey-button action-menu-free', text: '我有别的想法', onclick: function () { if (actions.free) actions.free(); } });
        root.append(el('header', { cls: 'action-menu-head' }, [art, el('div', {}, [el('div', { cls: 'journey-section-kicker', text: 'YOUR NEXT CHAPTER' }), el('h2', { text: '接下来，由你决定' })]), free]));
        var scene = el('div', { cls: 'action-menu-scene' }), situation = el('p', { cls: 'action-menu-situation', hidden: true });
        var hint = el('p', { cls: 'action-menu-hint', text: '点选即可行动，也可以先补充台词。每一步都由世界回应。' });
        var list = el('div', { cls: 'world-action-list', role: 'group', 'aria-label': '当前可选行动' });
        var empty = el('p', { cls: 'action-menu-empty', text: '此刻没有新的建议。可以自由行动、说句话，或静静待一会儿。', hidden: true });
        var status = el('p', { cls: 'action-menu-status', role: 'status', hidden: true });
        root.append(scene, situation, hint, list, empty, status);
        function select(id, edit) {
            if (data.disabled || data.busy) return;
            var item = (data.items || []).find(function (candidate) { return candidate.id === id; });
            if (!item) return;
            if (edit) actions.edit(item); else actions.choose(item);
        }
        root.update = function (next) {
            data = next || {};
            var items = data.items || [], nextScene = JSON.stringify([data.sceneText || '', data.situation || '']);
            if (sceneStamp !== nextScene) {
                sceneStamp = nextScene; scene.replaceChildren();
                if (data.sceneText) scene.appendChild(ReadableData.render(data.sceneText, { raw: false, copy: false, textLimit: 1100 }));
                scene.hidden = !data.sceneText; situation.textContent = data.situation || ''; situation.hidden = !data.situation;
            }
            var nextStamp = JSON.stringify(items);
            if (stamp !== nextStamp) {
                stamp = nextStamp;
                var groups = new Map(), active = new Set();
                items.forEach(function (item, index) {
                    active.add(item.id);
                    if (item.exclusiveGroup && !groups.has(item.exclusiveGroup)) groups.set(item.exclusiveGroup, groups.size + 1);
                    var key = JSON.stringify([item, index]), card = cards.get(item.id);
                    if (!card || card.key !== key) {
                        var primary = el('button', { type: 'button', cls: 'action-choice', 'data-action-choice': item.id, onclick: function () { select(item.id, false); } });
                        primary.append(el('span', { cls: 'action-choice-number', 'aria-hidden': 'true', text: String(index + 1).padStart(2, '0') }), el('span', { cls: 'action-choice-copy' }, [el('strong', { text: item.label }), el('span', { cls: 'action-choice-intent', text: item.intent }), el('span', { cls: 'action-choice-hint', text: item.replyTo ? '写回复 · 确认后发送' : '选择并行动 →' })]));
                        var node = el('article', { cls: 'action-choice-card' }, [primary]), footer = el('div', { cls: 'action-choice-footer' });
                        footer.appendChild(el('span', { text: item.exclusiveGroup ? '取舍 ' + groups.get(item.exclusiveGroup) + ' · 同组选一项' : item.source === 'device' ? '设备操作' : '世界行动' }));
                        if (item.source === 'world') footer.appendChild(el('button', { type: 'button', cls: 'action-choice-edit', text: '补充台词', 'data-action-edit': item.id, onclick: function () { select(item.id, true); } }));
                        node.appendChild(footer);
                        if (card) card.node.replaceWith(node);
                        card = { node: node, key: key }; cards.set(item.id, card);
                    }
                    var current = list.children[index]; if (current !== card.node) list.insertBefore(card.node, current || null);
                });
                cards.forEach(function (card, id) { if (!active.has(id)) { card.node.remove(); cards.delete(id); } });
            }
            cards.forEach(function (card, id) {
                card.node.classList.toggle('selected', data.selectedId === id);
                card.node.querySelectorAll('button').forEach(function (button) { button.disabled = !!data.disabled || !!data.busy; });
            });
            empty.hidden = !!items.length; hint.hidden = !items.length;
            root.classList.toggle('is-working', !!data.busy);
            var text = data.busy ? '正在等待这一步的回音，行动完成后会更新可选方向。' : data.disabled ? data.disabledReason || '连接恢复后，可以继续行动。' : '';
            if (status.textContent !== text) status.textContent = text;
            status.hidden = !text;
        };
        return root;
    }
    return { mount: mount };
})();
