/* Shared Markdown reader. Source stays verbatim in editors and storage. */
var StudioMarkdown = (function () {
    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    var parser = new marked.Marked({ gfm: true, breaks: true, renderer: {
        // Notes are documents, never executable application HTML.
        html: function (token) { return escapeHtml(token.text); }
    } });
    function render(container, source) {
        var fragment = DOMPurify.sanitize(parser.parse(String(source || '')), {
            RETURN_DOM_FRAGMENT: true,
            ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','del','a','img','ul','ol','li','blockquote','pre','code','hr','table','thead','tbody','tr','th','td','input'],
            ALLOWED_ATTR: ['href','title','src','alt','start','align','type','checked','disabled'],
            ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
        });
        fragment.querySelectorAll('a[href]').forEach(function (link) {
            link.target = '_blank'; link.rel = 'noopener noreferrer';
        });
        fragment.querySelectorAll('img').forEach(function (img) {
            img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        });
        fragment.querySelectorAll('input').forEach(function (input) {
            input.type = 'checkbox'; input.disabled = true;
            input.setAttribute('aria-label', input.checked ? '已完成' : '未完成');
        });
        fragment.querySelectorAll('table').forEach(function (table) {
            var scroll = document.createElement('div');
            scroll.className = 'markdown-table-scroll'; scroll.tabIndex = 0;
            scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '笔记表格，可横向滚动');
            table.replaceWith(scroll); scroll.appendChild(table);
        });
        container.classList.add('studio-markdown');
        container.replaceChildren(fragment);
    }
    return { render: render };
})();
