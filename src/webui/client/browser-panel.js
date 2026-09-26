/* The page is data, never HTML inserted into the studio document. */
(function () {
  'use strict';
  function node(tag, cls, text) { var value = document.createElement(tag); if (cls) value.className = cls; if (text != null) value.textContent = String(text); return value; }
  function safeImage(url) { try { var parsed = new URL(url, location.href); return /^(https?:|blob:)$/.test(parsed.protocol) ? parsed.href : ''; } catch (_) { return ''; } }
  function label(url) { try { return new URL(url).hostname; } catch (_) { return url; } }
  function recentTime(value) { var time = typeof value === 'number' ? value : Date.parse(value || ''); return Number.isFinite(time) ? time : 0; }
  function timeLabel(value) { var time = recentTime(value); return time ? new Date(time).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }
  var nextPanel = 0;
  window.StudioBrowserPanel = {
    mount: function (container, options) {
      var disposed = false, busy = false, state = {}, rows = new Map(), lastPageStamp = '', providerStamp = '', imageKey = '', localImage = null;
      var root = node('section', 'studio-browser'), toolbar = node('div', 'browser-toolbar'), controls = [];
      var address = node('input', 'browser-address'), search = node('input', 'browser-search'), provider = node('select', 'browser-provider');
      var addressForm = node('form', 'browser-address-form'), searchForm = node('form', 'browser-search-form');
      address.type = 'text'; address.inputMode = 'url'; address.placeholder = '输入网址'; address.setAttribute('aria-label', '网页地址'); address.autocomplete = 'off'; address.spellcheck = false;
      search.type = 'search'; search.placeholder = '搜索一个问题'; search.setAttribute('aria-label', '搜索内容'); provider.setAttribute('aria-label', '搜索入口');
      var status = node('p', 'browser-status'), title = node('h3', 'browser-title'), mode = node('span', 'browser-mode');
      status.setAttribute('role', 'status');
      var content = node('div', 'browser-content'), pictureArea = node('div', 'browser-picture-area'), screenshot = node('img', 'browser-frame'), frameHint = node('p', 'browser-frame-hint');
      var textArea = node('div', 'browser-reading'), article = node('div', 'browser-page-text'), notice = node('p', 'browser-notice');
      var actions = node('div', 'browser-elements'), actionTitle = node('h4', '', '页面上的操作'), media = node('div', 'browser-page-media');
      var portal = node('div', 'browser-portal'), heading = node('div', 'browser-page-heading');
      var view = 'page', panelId = 'browser-panel-' + (++nextPanel), tabs = node('div', 'browser-tabs'), tabButtons = {};
      var historyRows = new Map(), bookmarkRows = new Map(), library = node('section', 'browser-library');
      var historyView = node('div', 'browser-history'), historySearch = node('input', 'browser-library-search'), historySummary = node('p', 'browser-library-summary'), historyList = node('div', 'browser-library-list'), historyEmpty = node('p', 'browser-library-empty');
      var historyLimit = 50, historyFooter = node('div', 'browser-library-footer'), historyMore = node('button', 'browser-button browser-history-more', '显示更多');
      var bookmarkView = node('div', 'browser-bookmarks'), bookmarkHeading = node('div', 'browser-library-heading'), bookmarkSummary = node('p', 'browser-library-summary'), bookmarkList = node('div', 'browser-library-list'), bookmarkEmpty = node('p', 'browser-library-empty', '还没有书签。打开喜欢的网页，再收藏当前页。');
      historySearch.type = 'search'; historySearch.placeholder = '搜索标题或网址'; historySearch.setAttribute('aria-label', '搜索浏览历史');
      historySearch.addEventListener('input', function () { historyLimit = 50; renderLibrary(); });
      historyMore.type = 'button'; historyMore.addEventListener('click', function () { historyLimit += 50; renderLibrary(); });
      tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '浏览器视图');
      screenshot.alt = '浏览器最近一次实际截图'; screenshot.draggable = false; screenshot.referrerPolicy = 'no-referrer';
      screenshot.tabIndex = 0;
      function ready(tool) { return !disposed && !busy && !!options.available(tool); }
      function execute(tool, args) {
        if (!ready(tool)) return Promise.resolve();
        busy = true; status.textContent = '正在操作网页…'; updateDisabled();
        return Promise.resolve().then(function () { return options.run(tool, args || {}); }).then(function (result) {
          if (disposed) return result;
          status.textContent = typeof result === 'string' ? result.slice(0, 400) : result && result.text ? result.text.slice(0, 400) : '已收到页面返回';
          if (tool === 'view_image' || tool === 'view_video') {
            var attachment = result && ((result.attachments || [])[0] || (result.parts || []).filter(function (part) { return part.kind === 'media'; }).map(function (part) { return part.ref; })[0]);
            if (attachment && attachment.type === 'image') { localImage = { id: attachment.id, revision: state.revision }; renderFrame(); }
          }
          if (['home', 'open_url', 'search', 'go_back', 'go_forward', 'open_link', 'open_history', 'open_bookmark'].includes(tool)) view = 'page';
          return result;
        }).catch(function (error) { if (!disposed) { status.textContent = error.message || String(error); options.report(error); } }).finally(function () { busy = false; if (!disposed) update(); });
      }
      function button(text, tool, args, parent) {
        var value = node('button', 'browser-button', text); value.type = 'button'; value.dataset.browserTool = tool;
        value.addEventListener('click', function () { execute(tool, typeof args === 'function' ? args() : args); });
        controls.push({ node: value, tool: tool }); if (parent) parent.appendChild(value); return value;
      }
      function version() { return { revision: state.revision }; }
      function searchArgs() { return Object.assign({ query: search.value }, state.mode === 'virtual' ? {} : { provider: Number(provider.value) || 0 }); }
      function updateDisabled() {
        controls.forEach(function (entry) {
          var atStart = entry.tool === 'go_back' && state.library && state.library.canGoBack === false;
          var atEnd = entry.tool === 'go_forward' && (!state.library || state.library.canGoForward !== true);
          entry.node.disabled = !ready(entry.tool) || !!atStart || atEnd;
          entry.node.hidden = state.mode === 'virtual' && ['reload', 'scroll', 'save_screenshot', 'press_key'].indexOf(entry.tool) >= 0;
        });
        media.querySelectorAll('[data-browser-tool]').forEach(function (entry) { entry.disabled = entry.dataset.browserUnavailable === 'true' || !ready(entry.dataset.browserTool); });
        [[address, 'open_url'], [search, 'search']].forEach(function (entry) { var blocked = !ready(entry[1]); entry[0].disabled = blocked && document.activeElement !== entry[0]; entry[0].readOnly = blocked; });
        provider.disabled = !ready('search') && document.activeElement !== provider;
        var saved = (state.library && state.library.bookmarks || []).some(function (item) { return item.url === state.url; });
        addBookmark.disabled = !ready('add_bookmark') || !state.url || state.url === 'about:blank' || state.url === 'browser://home' || saved;
        addBookmark.textContent = saved ? '已收藏当前页' : '收藏当前页';
        historyRows.forEach(function (row) { row.open.disabled = !row.exists || !ready('open_history'); });
        bookmarkRows.forEach(function (row) {
          row.open.disabled = !row.exists || !ready('open_bookmark'); row.rename.disabled = !row.exists || !ready('rename_bookmark'); row.remove.disabled = !row.exists || !ready('remove_bookmark');
          var blocked = !row.exists || !ready('rename_bookmark'); row.save.disabled = blocked || !row.input.value.trim();
          row.input.disabled = blocked && document.activeElement !== row.input; row.input.readOnly = blocked;
        });
        rows.forEach(function (row) {
          var exists = (state.elements || []).some(function (item) { return row.key === elementKey(item); });
          row.button.disabled = !exists || !ready(row.tool) || !!row.item.disabled;
          if (row.input) {
            var blocked = !exists || !ready('fill') || !!row.item.disabled || !!row.item.readonly;
            // Disabling a focused input fires blur synchronously and may reopen the mobile IME
            // during a nested update. Keep the draft/focus; only its submit action is stale.
            row.input.disabled = blocked && document.activeElement !== row.input;
            if (row.input.tagName !== 'SELECT') row.input.readOnly = blocked;
          }
          row.root.classList.toggle('browser-element-stale', !exists);
        });
        var frame = state.screenshot;
        screenshot.classList.toggle('browser-frame-clickable', !!(!localImage && frame && frame.revision === state.revision && ready('click_point')));
        screenshot.setAttribute('aria-disabled', String(!!localImage || !frame || !ready('click_point')));
      }
      button('主页', 'home', {}, toolbar); button('后退', 'go_back', version, toolbar); button('前进', 'go_forward', version, toolbar); button('刷新', 'reload', version, toolbar); button('读取页面', 'read_page', {}, toolbar);
      [['page', '网页'], ['history', '历史记录'], ['bookmarks', '书签']].forEach(function (entry, index, entries) {
        var tab = node('button', 'browser-tab', entry[1]); tab.type = 'button'; tab.dataset.browserView = entry[0]; tab.id = panelId + '-tab-' + entry[0]; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panelId + '-' + entry[0]);
        tab.addEventListener('click', function () { selectView(entry[0]); });
        tab.addEventListener('keydown', function (event) {
          var offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!offset && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault(); var target = entries[event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + offset + entries.length) % entries.length][0];
          tabButtons[target].focus(); selectView(target);
        });
        tabButtons[entry[0]] = tab; tabs.appendChild(tab);
      });
      var addBookmark = button('收藏当前页', 'add_bookmark', version, bookmarkHeading);
      bookmarkHeading.prepend(node('h4', '', '我的书签'));
      var historyHeading = node('div', 'browser-library-heading'); historyHeading.append(node('h4', '', '最近浏览')); button('刷新记录', 'list_history', {}, historyHeading);
      button('刷新书签', 'list_bookmarks', {}, bookmarkHeading);
      historyFooter.append(historySummary, historyMore); historyView.append(historyHeading, historySearch, historyList, historyEmpty, historyFooter);
      bookmarkView.append(bookmarkHeading, bookmarkSummary, bookmarkList, bookmarkEmpty); library.append(historyView, bookmarkView);
      [[content, 'page'], [historyView, 'history'], [bookmarkView, 'bookmarks']].forEach(function (entry) { entry[0].id = panelId + '-' + entry[1]; entry[0].setAttribute('role', 'tabpanel'); entry[0].setAttribute('aria-labelledby', panelId + '-tab-' + entry[1]); });
      addressForm.append(address, button('打开', 'open_url', function () { return { url: address.value }; }));
      addressForm.addEventListener('submit', function (event) { event.preventDefault(); execute('open_url', { url: address.value }); });
      searchForm.append(search, provider, button('搜索', 'search', searchArgs));
      searchForm.addEventListener('submit', function (event) { event.preventDefault(); execute('search', searchArgs()); });
      [['哔哩哔哩', 'https://www.bilibili.com/'], ['新闻', 'https://news.cctv.com/'], ['维基百科', 'https://www.wikipedia.org/']].forEach(function (entry) { button(entry[0], 'open_url', { url: entry[1] }, portal); });
      heading.append(title, mode); pictureArea.append(screenshot, frameHint);
      var scroll = node('div', 'browser-scroll-controls');
      button('↑ 上滚', 'scroll', function () { return { revision: state.revision, pixels: -Math.round((state.viewport && state.viewport.height || 600) * 0.65) }; }, scroll);
      button('↓ 下滚', 'scroll', function () { return { revision: state.revision, pixels: Math.round((state.viewport && state.viewport.height || 600) * 0.65) }; }, scroll);
      button('继续阅读', 'scroll_down', version, scroll); button('重新截图', 'screenshot', {}, scroll);
      button('保存截图', 'save_screenshot', version, scroll);
      button('Enter', 'press_key', function () { return { revision: state.revision, key: 'Enter' }; }, scroll);
      button('Esc', 'press_key', function () { return { revision: state.revision, key: 'Escape' }; }, scroll);
      pictureArea.appendChild(scroll); textArea.append(notice, article, media, actionTitle, actions); content.append(pictureArea, textArea);
      root.append(toolbar, addressForm, searchForm, tabs, portal, status, heading, content, library); container.appendChild(root);
      screenshot.addEventListener('click', function (event) {
        var frame = state.screenshot; if (localImage || !frame || frame.revision !== state.revision || !ready('click_point')) return;
        var box = screenshot.getBoundingClientRect(); if (!box.width || !box.height) return;
        execute('click_point', { screenshot_id: frame.mediaId, revision: frame.revision, width: frame.width, height: frame.height,
          x: Math.min(frame.width - 1, Math.max(0, Math.floor((event.clientX - box.left) * frame.width / box.width))),
          y: Math.min(frame.height - 1, Math.max(0, Math.floor((event.clientY - box.top) * frame.height / box.height))) });
      });
      // Keyboard users can operate the DOM controls below; no guessed coordinate target on Enter.
      screenshot.addEventListener('keydown', function (event) { if (event.key === 'Escape' && localImage) { localImage = null; renderFrame(); } });
      function selectView(next) {
        view = next; renderLibrary();
        if (next !== 'page') execute(next === 'history' ? 'list_history' : 'list_bookmarks', {});
      }
      function entryAction(text, tool, args) {
        var value = node('button', 'browser-button', text); value.type = 'button'; value.dataset.browserTool = tool;
        value.addEventListener('click', function () {
          if (value.disabled) return;
          execute(tool, args());
        });
        return value;
      }
      function libraryRow(item, kind) {
        var row = { id: item.id, item: item, exists: true, root: node('article', 'browser-library-row browser-' + kind + '-item') };
        row.root.dataset.entryId = item.id;
        row.open = entryAction('', kind === 'history' ? 'open_history' : 'open_bookmark', function () { return { id: row.id }; }); row.open.classList.add('browser-library-title');
        row.url = node('p', 'browser-library-url'); row.time = node('p', 'browser-library-time'); row.root.append(row.open, row.url, row.time);
        if (kind === 'bookmark') {
          var actions = node('div', 'browser-library-actions'); row.rename = node('button', 'browser-button', '重命名'); row.rename.type = 'button'; row.rename.dataset.browserTool = 'rename_bookmark';
          row.remove = entryAction('删除', 'remove_bookmark', function () { return { id: row.id }; });
          row.editor = node('form', 'browser-bookmark-editor'); row.editor.hidden = true; row.input = node('input', 'browser-bookmark-name'); row.input.type = 'text'; row.input.maxLength = 200; row.input.setAttribute('aria-label', '书签名称');
          row.save = node('button', 'browser-button', '保存'); row.save.type = 'submit'; row.save.dataset.browserTool = 'rename_bookmark';
          var cancel = node('button', 'browser-button', '取消'); cancel.type = 'button';
          row.rename.addEventListener('click', function () { if (!ready('rename_bookmark') || !row.exists) return; row.input.value = row.item.title || row.item.url; row.editor.hidden = false; updateDisabled(); row.input.focus(); row.input.select(); });
          cancel.addEventListener('click', function () { row.editor.hidden = true; row.rename.focus(); renderLibrary(); });
          row.input.addEventListener('input', updateDisabled); row.input.addEventListener('blur', function () { if (!disposed) update(); });
          row.editor.addEventListener('submit', function (event) {
            event.preventDefault(); var title = row.input.value.trim(); if (!title || !row.exists || !ready('rename_bookmark')) return;
            execute('rename_bookmark', { id: row.id, title: title }).then(function (result) {
              if (disposed || result === undefined || row.input.value.trim() !== title) return;
              row.editor.hidden = true; row.rename.focus(); renderLibrary();
            });
          });
          row.editor.append(row.input, row.save, cancel); actions.append(row.rename, row.remove); row.root.append(actions, row.editor);
        }
        return row;
      }
      function renderEntries(items, map, target, kind) {
        var seen = new Set(), visible = [];
        items.forEach(function (item) {
          if (!item || !item.id) return; seen.add(item.id);
          var row = map.get(item.id); if (!row) { row = libraryRow(item, kind); map.set(item.id, row); target.appendChild(row.root); }
          row.item = item; row.exists = true; row.open.textContent = item.title || item.url || '未命名网页'; row.url.textContent = item.url || '';
          row.time.textContent = kind === 'history' ? [timeLabel(item.visitedAt), item.worldTime].filter(Boolean).join(' · ') : timeLabel(item.updatedAt || item.createdAt);
          row.root.classList.remove('browser-library-stale'); visible.push(row);
        });
        map.forEach(function (row, id) {
          if (seen.has(id)) return; row.exists = false;
          if (row.root.contains(document.activeElement)) row.root.classList.add('browser-library-stale'); else { row.root.remove(); map.delete(id); }
        });
        // Moving an existing input node can blur a mobile IME. Reorder after editing loses focus.
        if (!target.contains(document.activeElement)) {
          var before = target.firstChild;
          items.forEach(function (item) { var row = item && map.get(item.id); if (!row) return; if (row.root !== before) target.insertBefore(row.root, before); before = row.root.nextSibling; });
        }
        return visible.length;
      }
      function renderLibrary() {
        var data = state.library || {}, history = (data.history || []).slice().sort(function (a, b) { return recentTime(b.visitedAt) - recentTime(a.visitedAt); }), bookmarks = (data.bookmarks || []).slice();
        var query = historySearch.value.trim().toLocaleLowerCase();
        var matches = query ? history.filter(function (item) { return (String(item.title || '') + ' ' + String(item.url || '')).toLocaleLowerCase().includes(query); }) : history;
        var shown = renderEntries(matches.slice(0, historyLimit), historyRows, historyList, 'history');
        renderEntries(bookmarks, bookmarkRows, bookmarkList, 'bookmark');
        historySummary.textContent = '已显示 ' + shown + ' / ' + matches.length + ' 条' + (query ? '匹配记录' : '记录 · 最近浏览在前'); historyMore.hidden = shown >= matches.length;
        historyEmpty.textContent = query ? '没有找到匹配的浏览记录。试试其他标题或网址。' : '还没有浏览记录。打开网页后，会在这里留下记录。'; historyEmpty.hidden = matches.length > 0;
        bookmarkSummary.textContent = '共 ' + bookmarks.length + ' 个书签'; bookmarkEmpty.hidden = bookmarks.length > 0;
        library.hidden = view === 'page'; historyView.hidden = view !== 'history'; bookmarkView.hidden = view !== 'bookmarks'; content.hidden = heading.hidden = view !== 'page';
        portal.hidden = view !== 'page' || state.mode === 'virtual' || state.mode === 'unknown';
        Object.keys(tabButtons).forEach(function (key) { var selected = view === key; tabButtons[key].setAttribute('aria-selected', String(selected)); tabButtons[key].tabIndex = selected ? 0 : -1; });
        updateDisabled();
      }
      function elementKey(item) { return [state.url, item.ref, item.role, item.label].join('\u0000'); }
      function renderElements() {
        var seen = new Set();
        (state.elements || []).forEach(function (item) {
          var key = elementKey(item); seen.add(key); var row = rows.get(key);
          if (!row) {
            var wrapper = node('div', 'browser-element'), name = node('label', 'browser-element-name');
            var editable = ['input', 'textarea', 'textbox', 'searchbox', 'combobox', 'select'].indexOf(item.role) >= 0 && ['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'color'].indexOf(item.type) < 0;
            var input = editable ? node(item.options ? 'select' : item.role === 'textarea' ? 'textarea' : 'input', 'browser-element-input') : null;
            var action = node('button', 'browser-button', editable ? '填写' : '点击'); action.type = 'button';
            row = { key: key, root: wrapper, name: name, input: input, button: action, item: item, tool: editable ? 'fill' : 'click', dirty: false };
            if (input) {
              input.setAttribute('aria-label', item.label || item.ref); if (input.tagName === 'INPUT') input.type = item.type === 'password' ? 'password' : 'text';
              input.addEventListener('input', function () { row.dirty = true; });
              input.addEventListener('blur', function () { if (!disposed) update(); });
              name.append(input); wrapper.append(name, action);
            } else wrapper.append(name, action);
            action.addEventListener('click', function () {
              if (!(state.elements || []).some(function (current) { return elementKey(current) === row.key; })) return;
              execute(row.tool, Object.assign({ ref: row.item.ref, revision: state.revision }, row.input ? { value: row.input.value } : {})).then(function () { row.dirty = false; });
            });
            rows.set(key, row); actions.appendChild(wrapper);
          }
          row.item = item;
          if (!row.label) { row.label = node('span'); row.name.insertBefore(row.label, row.name.firstChild); }
          row.label.textContent = item.label + (item.disabled ? ' · 不可用' : '') + ' · ' + item.ref;
          if (row.input && row.input.tagName === 'SELECT' && document.activeElement !== row.input) {
            var stamp = JSON.stringify(item.options || []);
            if (row.optionStamp !== stamp) { var selected = row.input.value; row.input.replaceChildren(); (item.options || []).forEach(function (option) { var o = node('option', '', option.label); o.value = option.value; row.input.appendChild(o); }); row.optionStamp = stamp; if (row.dirty) row.input.value = selected; }
          }
          if (row.input && !row.dirty && document.activeElement !== row.input && item.type !== 'password') row.input.value = item.value || '';
        });
        rows.forEach(function (row, key) { if (!seen.has(key) && document.activeElement !== row.input) { row.root.remove(); rows.delete(key); } });
        actionTitle.hidden = !rows.size;
      }
      function renderFrame() {
        var frame = state.screenshot, current = localImage ? 'image:' + localImage.id : frame ? 'frame:' + frame.mediaId : '';
        if (current !== imageKey) {
          imageKey = current; var url = current ? safeImage(options.mediaUrl(localImage ? localImage.id : frame.mediaId)) : '';
          if (url) screenshot.src = url; else screenshot.removeAttribute('src');
        }
        screenshot.hidden = !current; pictureArea.classList.toggle('browser-no-frame', !current);
        frameHint.textContent = localImage ? '正在查看页内图片，不可作为网页坐标操作。按 Esc 返回网页截图。' : frame ? '点按截图操作页面，也可以使用右侧的文字控件。此图是最近读取的实际画面。' : '目前没有截图，可使用文字、链接与页面控件继续浏览。';
        root.classList.toggle('browser-has-frame', !!current); updateDisabled();
      }
      function update() {
        if (disposed) return; state = options.getState() || {};
        var virtual = state.mode === 'virtual';
        portal.hidden = virtual || state.mode === 'unknown'; provider.hidden = virtual || state.mode === 'unknown';
        address.placeholder = virtual ? '本世界的网址或网页名称' : '输入网址'; search.placeholder = virtual ? '搜索本世界的内容' : '搜索一个问题';
        if (localImage && localImage.revision !== state.revision) localImage = null;
        if (document.activeElement !== address) address.value = state.url && state.url !== 'about:blank' ? state.url : '';
        var providers = virtual || state.mode === 'unknown' ? [] : state.searchProviders || [], nextProviders = JSON.stringify(providers);
        if (nextProviders !== providerStamp) { providerStamp = nextProviders; var selected = provider.value; provider.replaceChildren(); providers.forEach(function (url, i) { var option = node('option', '', label(url)); option.value = String(i); provider.appendChild(option); }); provider.value = selected || '0'; }
        title.textContent = state.title || (virtual ? '本世界的虚拟互联网' : '浏览器'); mode.textContent = state.mode === 'real' ? '实时网页 · ' + (state.revision || '—') : virtual ? '世界中的网页' : state.mode === 'unknown' ? '尚未打开' : '文字浏览';
        notice.textContent = state.notice || (virtual ? '浏览本世界已建立的网页和导航入口。没有资料时会如实显示未知。' : state.mode === 'text' ? '当前没有可隔离会话的浏览器服务，只读取静态文字与链接。' : ''); notice.hidden = !notice.textContent;
        var stamp = JSON.stringify([state.mode, state.url, state.title, state.text, state.images, state.videos, state.links, state.revision]);
        if (stamp !== lastPageStamp) {
          lastPageStamp = stamp; article.textContent = state.text || '打开一个网址，开始浏览。';
          media.replaceChildren();
          // Media is fetched through the same authenticated app tool; no third-party image request is made by the studio.
          (state.images || []).forEach(function (image, index) {
            var b = node('button', 'browser-media-button', '查看图片 ' + (index + 1) + (image.alt ? ' · ' + image.alt : '')); b.type = 'button';
            b.dataset.browserTool = 'view_image'; b.disabled = !ready('view_image'); b.addEventListener('click', function () { execute('view_image', { n: index + 1, revision: state.revision }); }); media.appendChild(b);
          });
          (state.videos || []).forEach(function (video, index) {
            var direct = /^https?:/i.test(video.url || ''); var b = node('button', 'browser-media-button', direct ? '读取视频 ' + (index + 1) : '视频 ' + (index + 1) + ' · 播放器流，未读取完整内容'); b.type = 'button';
            b.dataset.browserTool = 'view_video'; b.dataset.browserUnavailable = String(!direct); b.disabled = !direct || !ready('view_video'); b.addEventListener('click', function () { execute('view_video', { n: index + 1, revision: state.revision }); }); media.appendChild(b);
          });
          if (state.mode !== 'real') (state.links || []).forEach(function (link, index) {
            var b = node('button', 'browser-media-button', link.text || link.url); b.type = 'button'; b.dataset.browserTool = 'open_link';
            b.addEventListener('click', function () { execute('open_link', { n: index + 1 }); }); media.appendChild(b);
          });
        }
        renderElements(); renderFrame(); renderLibrary(); updateDisabled();
      }
      update();
      return { update: update, dispose: function () { disposed = true; rows.clear(); historyRows.clear(); bookmarkRows.clear(); root.remove(); } };
    },
  };
}());
