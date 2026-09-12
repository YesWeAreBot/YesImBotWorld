/* Captured attachments are rendered locally. Remote resources open only after a click. */
var CallAttachments = (function () {
    'use strict';
    var raster = /^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)$/i;
    function node(tag, cls, text) { var element = document.createElement(tag); if (cls) element.className = cls; if (text != null) element.textContent = text; return element; }
    function mime(value) { return /^[\w.+-]+\/[\w.+-]+$/.test(value || '') ? value.toLowerCase() : 'application/octet-stream'; }
    function filename(value, type) { var name = typeof value === 'string' ? value.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').slice(0, 160) : ''; return name && name !== '.' && name !== '..' ? name : '附件.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf', 'text/plain': 'txt' }[type] || 'bin'); }
    function audioMime(format) { return { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', pcm16: 'audio/pcm', aac: 'audio/aac' }[format] || 'application/octet-stream'; }
    function formatMime(format, name) { var ext = String(format || (typeof name === 'string' ? name.split('.').pop() : '') || '').toLowerCase(); return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', txt: 'text/plain', json: 'application/json', pdf: 'application/pdf', html: 'text/html', csv: 'text/csv' }[ext] || audioMime(ext); }
    function source(value, type, name, id) {
        if (typeof value !== 'string') return id ? { type: mime(type), name: filename(name, type), id: String(id) } : null;
        var match = /^data:([^;,]*)([^,]*),([\s\S]*)$/i.exec(value);
        if (match) return { type: mime(match[1] || type || 'text/plain'), name: filename(name, match[1] || type), data: match[3], base64: /;base64(?:;|$)/i.test(match[2]) };
        if (/^https?:\/\//i.test(value)) return { type: mime(type), name: filename(name, type), remote: value };
        if (type) return { type: mime(type), name: filename(name, type), data: value, base64: true };
        return null;
    }
    function describe(value) {
        if (typeof value === 'string') return /^data:/i.test(value) ? source(value) : null;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        var type = value.type, image = value.image_url, file = value.file, audio = value.input_audio || value.audio, src = value.source;
        if (type === 'image_url' || type === 'input_image') return source(typeof image === 'string' ? image : image && image.url || value.url, 'image/unknown', value.filename, value.file_id);
        if ((type === 'image' || type === 'document') && src) return source(src.data || src.url, src.media_type || src.mime_type || (type === 'image' ? 'image/unknown' : 'application/octet-stream'), value.title || value.filename, src.file_id);
        if ((type === 'input_audio' || type === 'audio') && audio) return source(audio.data || audio.url, audioMime(audio.format || value.format), audio.filename || value.filename, audio.id);
        if (type === 'file' || type === 'input_file') { file = file || value; return source(file.file_data || file.data || file.file_url || file.url, file.mime_type || file.media_type || formatMime(file.format, file.filename || file.name), file.filename || file.name, file.file_id); }
        if (typeof value.data === 'string' && (value.format || value.filename) && !value.media_type && !value.mime_type && !value.content_type) return source(value.data, formatMime(value.format, value.filename), value.filename || value.name);
        if (typeof value.file_data === 'string') return source(value.file_data, value.mime_type || value.media_type || formatMime(value.format, value.filename || value.name), value.filename || value.name);
        if (typeof value.data === 'string' && (value.media_type || value.mime_type || value.content_type)) return source(value.data, value.media_type || value.mime_type || value.content_type, value.filename || value.name);
        if (typeof value.base64 === 'string') return source(value.base64, value.mime_type || value.media_type || formatMime(value.format, value.filename || value.name), value.filename || value.name);
        return null;
    }
    function byteCount(item) { if (item.data == null) return null; return item.base64 ? Math.max(0, Math.floor(item.data.replace(/\s/g, '').length * 3 / 4) - (/==$/.test(item.data) ? 2 : /=$/.test(item.data) ? 1 : 0)) : new TextEncoder().encode(item.data).length; }
    function size(bytes) { return bytes == null ? '' : bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'; }
    function summary(item) { return '[附件：' + item.name + ' · ' + item.type + (item.data != null ? ' · ' + size(byteCount(item)) : item.remote ? ' · 远程链接' : ' · 文件编号 ' + item.id) + ']'; }
    function decodeText(value) { if (typeof value !== 'string') return value; var candidate = value; for (var i = 0; i < 4; i++) { if (typeof candidate !== 'string' || !/^[\s]*[\[{"]/.test(candidate)) break; try { candidate = JSON.parse(candidate); if (candidate && typeof candidate === 'object') return candidate; } catch (_) { break; } } return value; }
    function redact(value, ancestors) {
        value = decodeText(value); var item = describe(value); if (item) return summary(item);
        if (typeof value === 'string') return value.replace(/data:[\w.+/-]+(?:;[\w=.+-]+)*;base64,[A-Za-z0-9+/=_-]+/g, function (uri) { var embedded = describe(uri); return embedded ? summary(embedded) : '[附件数据]'; });
        if (!value || typeof value !== 'object') return value;
        ancestors = ancestors || []; if (ancestors.includes(value)) return '[循环引用]';
        var result = Array.isArray(value) ? [] : Object.create(null), parents = ancestors.concat([value]);
        Object.keys(value).forEach(function (key) { result[key] = redact(value[key], parents); }); return result;
    }
    function create() {
        var urls = new Set(), dialogs = new Set();
        function blob(item) {
            if (item.data == null) return null;
            var parts = [];
            if (item.base64) {
                var encoded = item.data.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
                for (var i = 0; i < encoded.length; i += 32768) { var binary = atob(encoded.slice(i, i + 32768)), bytes = new Uint8Array(binary.length); for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j); parts.push(bytes); }
            } else parts.push(decodeURIComponent(item.data));
            return new Blob(parts, { type: item.type });
        }
        function url(value) { var ref = URL.createObjectURL(value); urls.add(ref); return ref; }
        function zoom(ref, item, trigger) {
            var dialog = node('dialog', 'call-image-dialog'), close = node('button', 'call-attachment-button', '关闭预览'), image = node('img');
            dialog.setAttribute('aria-label', '图片预览：' + item.name); close.type = 'button'; image.src = ref; image.alt = item.name;
            dialog.append(node('p', 'call-image-title', item.name), close, image); document.body.appendChild(dialog); dialogs.add(dialog);
            close.onclick = function () { dialog.close(); }; dialog.onclick = function (event) { if (event.target === dialog) dialog.close(); };
            dialog.addEventListener('close', function () { dialogs.delete(dialog); dialog.remove(); trigger.focus(); }); dialog.showModal(); close.focus();
        }
        function render(value) {
            var item = describe(value);
            if (!item && typeof value === 'string') {
                var matches = Array.from(value.matchAll(/data:[\w.+/-]+(?:;[\w=.+-]+)*;base64,[A-Za-z0-9+/=_-]+/g));
                if (matches.length) {
                    var inline = node('div', 'call-inline-attachments'), offset = 0;
                    matches.forEach(function (match) { if (match.index > offset) inline.appendChild(ReadableData.render(value.slice(offset, match.index), { compact: true, raw: false, copy: false })); inline.appendChild(render(match[0])); offset = match.index + match[0].length; });
                    if (offset < value.length) inline.appendChild(ReadableData.render(value.slice(offset), { compact: true, raw: false, copy: false })); return inline;
                }
            }
            if (!item) return null;
            var card = node('article', 'call-attachment'), main = node('div', 'call-attachment-main'), actions = node('div', 'call-attachment-actions'), status = node('p', 'call-attachment-status');
            card.append(main, actions, status); main.append(node('strong', 'call-attachment-name', item.name), node('small', 'call-attachment-meta', item.type + (item.data != null ? ' · ' + size(byteCount(item)) : '')));
            if (item.remote) {
                var remote = node('a', 'call-attachment-button', '打开远程附件'); remote.href = item.remote; remote.target = '_blank'; remote.rel = 'noopener noreferrer'; actions.appendChild(remote); status.textContent = '远程附件按需打开';
                var address = node('details', 'call-attachment-address'); address.append(node('summary', '', '查看地址'), node('span', '', item.remote)); card.appendChild(address); return card;
            }
            if (item.data == null) { status.textContent = '文件编号：' + item.id + ' · 请求中未包含文件内容'; return card; }
            var file;
            try { file = blob(item); } catch (_) { status.textContent = '附件编码不完整或无效，可在原始数据中核对。'; return card; }
            var ref = url(file), download = node('a', 'call-attachment-button', '下载文件'); download.href = ref; download.download = item.name; actions.appendChild(download);
            if (raster.test(item.type)) {
                var thumb = node('button', 'call-attachment-thumbnail'), image = node('img'); thumb.type = 'button'; thumb.setAttribute('aria-label', '放大图片：' + item.name); image.src = ref; image.alt = item.name; image.loading = 'lazy'; image.onerror = function () { status.textContent = '图片暂时无法预览，可下载查看。'; }; thumb.appendChild(image); card.prepend(thumb); thumb.onclick = function () { zoom(ref, item, thumb); };
            } else if (/^audio\/(?:mpeg|wav|x-wav|ogg|flac|aac|mp4|webm)$/.test(item.type)) {
                var player = node('audio', 'call-attachment-audio'); player.controls = true; player.preload = 'none'; player.src = ref; card.appendChild(player);
            } else if (/^(?:text\/|application\/(?:json|xml|javascript))/.test(item.type) || item.type === 'image/svg+xml') {
                var preview = node('details', 'call-attachment-text'), loaded = false; preview.appendChild(node('summary', '', '预览文本'));
                preview.addEventListener('toggle', function () { if (!preview.open || loaded) return; loaded = true; file.slice(0, 65536).text().then(function (text) { preview.appendChild(node('pre', '', text)); if (file.size > 65536) preview.appendChild(node('p', '', '预览前 64 KB，下载可查看完整文件。')); }); }); card.appendChild(preview);
            }
            return card;
        }
        function clear() { dialogs.forEach(function (dialog) { dialog.remove(); }); dialogs.clear(); urls.forEach(function (ref) { URL.revokeObjectURL(ref); }); urls.clear(); }
        return { render: render, redact: redact, clear: clear };
    }
    return { create: create, describe: describe, redact: redact };
})();
