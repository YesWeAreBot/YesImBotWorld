/**
 * WebUI 前端页面（内嵌于服务端，零静态文件依赖）。
 *
 * 页面源码：src/webui/index.html。本文件由构建时生成，
 * 修改页面请直接编辑 index.html，然后用
 * `node scripts/gen-page.mjs`（或本文件顶部的生成逻辑）重新生成。
 */

export const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YesImBot World · 运维 WebUI</title>
<style>
:root{
  --bg:#0f1115; --bg2:#161a21; --bg3:#1e242e; --bg4:#262e3a;
  --fg:#d7dee8; --fg-dim:#8b95a5; --fg-dark:#5c6572;
  --line:#2a3240; --accent:#4ea1ff; --accent-dim:#2b5c8f;
  --ok:#4ec98f; --warn:#e0b14e; --err:#e06060; --info:#7fa8d9;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent)}
button{font:inherit;color:var(--fg);background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent-dim);border-color:var(--accent);color:#fff}
button.danger{color:var(--err);border-color:var(--err)}
button:disabled{opacity:.45;cursor:not-allowed}
input,select,textarea{font:inherit;color:var(--fg);background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:4px 8px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
textarea{width:100%;resize:vertical;line-height:1.5}
code{font-family:var(--mono);background:var(--bg3);padding:1px 5px;border-radius:4px;font-size:12px}
pre{font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:8px;margin:0}
header{display:flex;align-items:center;gap:12px;padding:8px 16px;background:var(--bg2);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
header h1{font-size:15px;margin:0;font-weight:600}
#sse-dot{width:9px;height:9px;border-radius:50%;background:var(--fg-dark)}
#sse-dot.on{background:var(--ok)}
#sse-dot.off{background:var(--err)}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;background:var(--bg3);border:1px solid var(--line);color:var(--fg-dim)}
.pill.run{color:var(--ok);border-color:var(--ok)}
.pill.pause{color:var(--warn);border-color:var(--warn)}
.pill.off{color:var(--err);border-color:var(--err)}
#header-clock{color:var(--fg-dim);font-size:12px}
#layout{display:flex;height:calc(100vh - 49px)}
nav{width:150px;flex:none;background:var(--bg2);border-right:1px solid var(--line);padding:10px 0;overflow-y:auto}
nav a{display:block;padding:8px 16px;color:var(--fg-dim);text-decoration:none;cursor:pointer;font-size:13px;border-left:3px solid transparent}
nav a:hover{color:var(--fg)}
nav a.active{color:var(--accent);border-left-color:var(--accent);background:var(--bg3)}
main{flex:1;overflow-y:auto;padding:16px 20px}
.view-title{font-size:17px;font-weight:600;margin:0 0 4px}
.view-desc{color:var(--fg-dim);font-size:12px;margin:0 0 14px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card .k{font-size:12px;color:var(--fg-dim);margin-bottom:2px}
.card .v{font-size:15px;font-weight:600;word-break:break-word}
.card .v.small{font-size:12px;font-weight:400;color:var(--fg-dim)}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}
.toolbar .spacer{flex:1}
.section{background:var(--bg2);border:1px solid var(--line);border-radius:8px;margin-bottom:14px}
.section h3{margin:0;padding:10px 14px;font-size:13px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
.section h3 .hint{font-weight:400;color:var(--fg-dim);font-size:12px}
.section .body{padding:12px 14px}
.fld{display:flex;gap:8px;margin-bottom:8px;align-items:flex-start}
.fld .lbl{width:210px;flex:none;padding-top:3px}
.fld .lbl .name{font-size:13px}
.fld .lbl .desc{font-size:11px;color:var(--fg-dim);margin-top:2px}
.fld .ctl{flex:1;min-width:0}
.fld textarea{font-family:var(--mono);font-size:12px}
.fld input[type=text],.fld input[type=password],.fld input[type=number]{width:100%}
.grid-booleans{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 12px;margin-top:6px}
.grid-booleans label{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--fg-dim);cursor:pointer;padding:2px}
.grid-booleans input{accent-color:var(--accent)}
fieldset{border:1px solid var(--line);border-radius:8px;margin:0 0 14px;padding:0}
fieldset>legend{padding:0 8px;font-size:13px;color:var(--accent)}
fieldset>.body{padding:12px}
.list-item{border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px;background:var(--bg3)}
.list-item .row{display:flex;gap:6px;align-items:center}
.news-item{border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:8px;background:var(--bg3)}
.news-item .clock{color:var(--info);font-size:12px;font-family:var(--mono)}
.news-item textarea{width:100%;margin-top:6px;font-family:var(--mono);font-size:12px}
.debug-list{font-family:var(--mono);font-size:12px}
.dbg{background:var(--bg2);border:1px solid var(--line);border-radius:6px;margin-bottom:6px;overflow:hidden}
.dbg .head{display:flex;gap:8px;align-items:center;padding:5px 10px;cursor:pointer;user-select:none}
.dbg .head .t{color:var(--fg-dim);font-size:11px;flex:none}
.dbg .head .l{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg .head .tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg4);color:var(--fg-dim);flex:none}
.dbg .head .tag.req{color:#8ab4ff}.dbg .head .tag.res{color:#7bd88f}.dbg .head .tag.tool{color:#e8c66a}.dbg .head .tag.event{color:#c792ea}.dbg .head .tag.err{color:#ff8a8a}
.dbg .detail{display:none;padding:8px 10px;border-top:1px solid var(--line);background:var(--bg3)}
.dbg.open .detail{display:block}
.dbg .detail pre{background:transparent;border:none;padding:0}
.stream-entry{border-bottom:1px solid var(--line);padding:6px 4px}
.stream-entry .k{font-size:11px;color:var(--fg-dim)}
.stream-entry pre{margin-top:4px}
.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.g-card{background:var(--bg2);border:1px solid var(--line);border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
.g-card img{width:100%;height:110px;object-fit:cover;background:var(--bg3);cursor:zoom-in}
.g-card .m{padding:6px 8px;font-size:11px;color:var(--fg-dim);word-break:break-all}
.g-card .d{padding:0 8px;font-size:11px;color:var(--fg-dim);min-height:30px}
.g-card .a{padding:6px 8px;display:flex;gap:4px;flex-wrap:wrap}
.g-card select{max-width:110px;font-size:11px;padding:2px 4px}
.g-card button{font-size:11px;padding:2px 6px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
th{background:var(--bg3);color:var(--fg-dim);font-weight:500}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:12px}
.tabs button{border:none;background:none;color:var(--fg-dim);padding:6px 12px;border-bottom:2px solid transparent;border-radius:0}
.tabs button.active{color:var(--accent);border-bottom-color:var(--accent)}
.hidden{display:none!important}
.toast{position:fixed;bottom:18px;right:18px;z-index:50;background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:10px 14px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:360px}
.toast.ok{border-color:var(--ok)}.toast.warn{border-color:var(--warn)}.toast.err{border-color:var(--err)}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;display:none;align-items:center;justify-content:center}
#modal.show{display:flex}
#modal .box{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:18px;width:420px;max-width:92vw}
.kv{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px dashed var(--line)}
.kv .k{color:var(--fg-dim)}
.kv .v{text-align:right;word-break:break-all}
img.full{max-width:100%;max-height:70vh;border-radius:6px}
</style>
</head>
<body>
<header>
  <h1>YesImBot World</h1>
  <span id="sse-dot" class="off" title="实时推送"></span>
  <span id="world-pill" class="pill off">加载中…</span>
  <span id="header-clock"></span>
  <span class="spacer" style="flex:1"></span>
  <span id="header-extra" class="pill"></span>
  <button id="btn-refresh" title="刷新当前视图">刷新</button>
</header>
<div id="layout">
  <nav id="nav"></nav>
  <main id="main"></main>
</div>
<div id="modal">
  <div class="box">
    <h3 id="modal-title"></h3>
    <div id="modal-body"></div>
  </div>
</div>
<div id="toasts"></div>
<script>
'use strict';
var NL = String.fromCharCode(10);
var VERSION = '?';
var TOKEN = localStorage.getItem('wui_token') || '';
var activeView = 'overview';
var lastEventId = 0;
var evtSource = null;
var cfgCache = null;
var schemaCache = null;
var overridesCache = null;
var promptsDefaults = null;
var galleryCache = [];
var currentCategory = '未整理';
var debugAutoScroll = true;

function $(sel){ return document.querySelector(sel); }
function el(tag, attrs, children){
  var n = document.createElement(tag);
  if(attrs) for(var k in attrs){
    if(k === 'html') n.innerHTML = attrs[k];
    else if(k === 'cls') n.className = attrs[k];
    else if(k === 'text') n.textContent = attrs[k];
    else if(k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
    else n.setAttribute(k, attrs[k]);
  }
  if(children){
    if(typeof children === 'string' || typeof children === 'number') n.textContent = String(children);
    else if(Array.isArray(children)) flattenKids(children).forEach(function(c){ if(c) n.appendChild(c); });
    else n.appendChild(children);
  }
  return n;
}
function flattenKids(list){
  var out = [];
  list.forEach(function(c){
    if(Array.isArray(c)) out = out.concat(flattenKids(c));
    else if(c != null) out.push(c);
  });
  return out;
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function fmtBytes(n){ n = Number(n)||0; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
function fmtTime(ts){ var d = new Date(ts); function p(x){ return (x<10?'0':'')+x; } return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
function toast(msg, kind){
  var t = el('div', {cls:'toast '+(kind||'')});
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(function(){ t.remove(); }, 4200);
}
function promptToken(){
  return new Promise(function(resolve){
    $('#modal-title').textContent = '需要访问令牌';
    var inp = el('input', {type:'password', placeholder:'webui.token', style:'width:100%'});
    var body = el('div', null, [
      el('p', {text:'服务器设置了 webui.token，请输入访问令牌。'}),
      inp,
      el('div', {cls:'toolbar'}, [
        el('button', {text:'取消', onclick:function(){ hideModal(); resolve(null); }}),
        el('button', {cls:'primary', text:'确定', onclick:function(){ TOKEN = inp.value.trim(); localStorage.setItem('wui_token', TOKEN); hideModal(); resolve(TOKEN); }})
      ])
    ]);
    $('#modal-body').textContent = '';
    $('#modal-body').appendChild(body);
    $('#modal').classList.add('show');
    setTimeout(function(){ inp.focus(); }, 50);
  });
}
function hideModal(){ $('#modal').classList.remove('show'); }
function showImage(title, url){
  $('#modal-title').textContent = title;
  var img = el('img', {src:url, cls:'full'});
  $('#modal-body').textContent = '';
  $('#modal-body').appendChild(img);
  $('#modal').classList.add('show');
  img.onclick = hideModal;
}

function api(method, path, body, retried){
  var opts = {method:method, headers:{}};
  if(TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
  if(body !== undefined){
    if(body instanceof FormData){ opts.body = body; }
    else if(typeof body === 'string'){ opts.headers['Content-Type'] = 'application/octet-stream'; opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  return fetch(path, opts).then(function(res){
    if(res.status === 401 && !retried){
      return promptToken().then(function(t){
        if(t == null) throw new Error('未授权');
        return api(method, path, body, true);
      });
    }
    return res.json().then(function(data){
      if(!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    });
  });
}

// ---------- SSE ----------
function connectSSE(){
  if(evtSource) evtSource.close();
  var url = '/api/events?since=' + lastEventId + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '');
  evtSource = new EventSource(url);
  evtSource.onopen = function(){ $('#sse-dot').className = 'on'; };
  evtSource.onerror = function(){ $('#sse-dot').className = 'off'; };
  evtSource.onmessage = function(ev){
    if(ev.lastEventId) lastEventId = Number(ev.lastEventId) || 0;
    var msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    if(msg.channel === 'debug'){ if(msg.update) updateDebugEntry(msg.entry); else onDebugEntry(msg.entry); }
    else if(msg.channel === 'file'){ onFileSignal(msg.file); }
    else if(msg.channel === 'lifecycle'){ onLifecycle(msg.event, msg.detail); }
  };
}
function onDebugEntry(entry){
  if(activeView === 'debug') appendDebugEntry(entry);
  if(activeView === 'overview' && entry.kind === 'lifecycle') refreshOverview();
}
function onFileSignal(file){
  if(activeView === 'state') refreshState(file);
  else if(activeView === 'overview') refreshOverview();
  else if(activeView === 'gallery' && file === 'gallery') loadGallery();
  else if(activeView === 'media' && file === 'media') loadMedia();
  else if(activeView === 'data' && (file === 'notes' || file === 'data')) refreshData();
  else if(activeView === 'debug' && file === 'stream') renderStreamTab();
  if(file === 'clock' || file === 'botStatus' || file === 'news') refreshOverview();
}
function onLifecycle(event, detail){
  refreshOverview();
  if(activeView === 'gallery' && String(event).indexOf('gallery') === 0) loadGallery();
}

// ---------- 导航 ----------
var NAV = [
  ['overview', '概览'],
  ['config', '配置'],
  ['prompts', '提示词'],
  ['state', '状态'],
  ['debug', '调试'],
  ['gallery', '相册'],
  ['media', '媒体'],
  ['data', '数据'],
];
function buildNav(){
  $('#nav').textContent = '';
  NAV.forEach(function(it){
    $('#nav').appendChild(el('a', {cls: it[0]===activeView?'active':'', text: it[1], onclick: function(){ switchView(it[0]); }}));
  });
}
function switchView(name){
  activeView = name;
  buildNav();
  if(name === 'overview') refreshOverview();
  else if(name === 'config') loadConfig();
  else if(name === 'prompts') loadPrompts();
  else if(name === 'state') loadState();
  else if(name === 'debug') loadDebug();
  else if(name === 'gallery') loadGallery();
  else if(name === 'media') loadMedia();
  else if(name === 'data') refreshData();
  else $('#main').textContent = '';
}
$('#btn-refresh').onclick = function(){ switchView(activeView); };

// ---------- 概览 ----------
function worldStateText(o){
  if(!o.initialized) return ['未初始化', 'off'];
  if(o.worldRunning) return ['世界运行中', 'run'];
  if(o.clock && !o.clock.syncRealTime) return ['已暂停（时间静止）', 'pause'];
  return ['未运行（时间照常流逝）', 'pause'];
}
function refreshOverview(){
  api('GET', '/api/overview').then(function(o){
    VERSION = o.version || VERSION;
    var st = worldStateText(o);
    var pill = $('#world-pill');
    pill.className = 'pill ' + st[1];
    pill.textContent = st[0];
    $('#header-clock').textContent = o.clock ? ('⏱ ' + o.clock.timeLine + (o.clock.syncRealTime ? '' : ('  (1TU=' + o.clock.unitRealSeconds + 's)'))) : '';
    $('#header-extra').textContent = o.bot && o.bot.running ? ('Bot 推理中 · ' + o.bot.streamLength + ' 条 · 队列 ' + o.worldQueue) : '';

    var main = $('#main');
    if(activeView !== 'overview') return;

    var cards = el('div', {cls:'cards'}, [
      card('世界状态', st[0], st[1]),
      card('世界时钟', o.clock ? o.clock.timeLine : '—'),
      card('1 TU', o.clock ? (o.clock.unitRealSeconds + ' 现实秒 / ' + o.clock.unitWorldSeconds + ' 世界秒') : '—', 'small'),
      card('World-LLM 队列', String(o.worldQueue)),
      card('Bot-LLM', o.bot ? (o.bot.running ? '持续推理中' : '已停止') : '未启动'),
      card('工作窗口', o.bot ? (o.bot.streamLength + ' 条 / 约 ' + o.bot.approxChars + ' 字符') : '—', 'small'),
      card('等待中', o.bot && o.bot.waiting ? o.bot.waiting : (o.bot ? '否' : '—')),
      card('进行中的动作', o.bot ? String(o.bot.pendingTasks) : '—'),
      card('手机', o.phoneDown ? '放在一边（通知震动）' : '在手边'),
      card('关注频道', o.focusChannels.length ? o.focusChannels.join('、') : '无', 'small'),
      card('数据目录', o.baseDir, 'small'),
    ]);
    if(o.appOpen) cards.appendChild(card('手机里打开的应用', o.appOpen));
    if(o.computerOn) cards.appendChild(card('电脑', o.computerOn));
    o.galleryCounts.forEach(function(g){
      cards.appendChild(card('相册 · ' + g.category, String(g.count)));
    });

    var ctl = el('div', {cls:'toolbar'}, [
      el('button', {cls:'primary', text:'创世 (world.init)', onclick: function(){ worldAction('init', true); }}),
      el('button', {text:'开始 (start)', onclick: function(){ worldAction('start'); }}),
      el('button', {text:'暂停 (stop)', onclick: function(){ worldAction('stop'); }}),
      el('button', {text:'重载定义', onclick: function(){ worldAction('reload'); }}),
      el('button', {cls:'danger', text:'重置 (reset)', onclick: function(){
        if(!confirm('确认重置世界？所有运行时状态将被归档清空（定义文件保留）。')) return;
        worldAction('reset');
      }}),
      el('button', {text:'清空消息记录', onclick: function(){ worldAction('clearmsg'); }}),
      el('button', {text:'注入事件…', onclick: function(){
        var txt = prompt('注入到 Bot 意识流的事件内容（system 源，可唤醒等待）：');
        if(txt && txt.trim()) worldAction('inject', false, {text: txt.trim()});
      }}),
      el('span', {cls:'spacer'}),
      el('button', {cls:'danger', text:'重新创世 -f', onclick: function(){
        if(!confirm('强制重新创世：将归档清空当前世界并重新生成初始状态，不可撤销。确认？')) return;
        worldAction('init', true, {force:true});
      }}),
    ]);

    var news = el('div', {cls:'section'}, [el('h3', {html:'最近的世界事件 <span class="hint">（共展示 ' + o.news.length + ' 条，完整编辑在「状态」页）</span>'}), el('div', {cls:'body'}, [
      o.news.length ? o.news.map(function(n){
        return el('div', {cls:'news-item'}, [
          el('span', {cls:'clock', text:'[' + n.clock + ']'}),
          el('span', {text: ' ' + n.content})
        ]);
      }) : el('p', {text:'（还没有任何事件）'})
    ])]);

    main.textContent = '';
    main.appendChild(el('h2', {cls:'view-title', text:'世界总览'}));
    main.appendChild(el('p', {cls:'view-desc', text:'实时反映世界与 Bot 的运行状态；控制操作与指令 world.* 等效。版本 ' + VERSION}));
    main.appendChild(ctl);
    main.appendChild(cards);
    main.appendChild(news);
  }).catch(function(err){ if(activeView==='overview') showErr(err); });
}
function card(k, v, small){
  return el('div', {cls:'card'}, [el('div', {cls:'k', text:k}), el('div', {cls:'v' + (small?' small':''), text: String(v)})]);
}
function showErr(err){ toast(String(err && err.message || err), 'err'); }
function worldAction(action, askInit, body){
  var label = {init:'创世', start:'开始', stop:'暂停', reload:'重载定义', reset:'重置', clearmsg:'清空消息', inject:'注入'}[action] || action;
  if(askInit && !body && action==='init'){
    body = {force: false};
    if(!confirm('执行 world.init 创世：将由 World-LLM 依据定义生成初始状态。需要几分钟，继续？')) return;
  }
  var btn = event && event.target;
  if(btn){ btn.disabled = true; }
  api('POST', '/api/world/' + action, body || {}).then(function(r){
    toast((label + '：' + r.text), 'ok');
    refreshOverview();
  }).catch(function(err){
    toast((label + '失败：' + (err.message || err)), 'err');
  }).finally(function(){ if(btn) btn.disabled = false; });
}

// ---------- 配置 ----------
function loadConfig(){
  $('#main').textContent = '';
  $('#main').appendChild(el('h2', {cls:'view-title', text:'配置'}));
  var desc = el('p', {cls:'view-desc', text:'调整全部配置项。保存后将写入配置文件并重启插件作用域（世界会自动恢复运行）。修改监听端口后浏览器会跳转到新地址。'});
  $('#main').appendChild(desc);
  var holder = el('div', {text:'加载中…'});
  $('#main').appendChild(holder);
  api('GET', '/api/config').then(function(r){
    schemaCache = r.schema;
    cfgCache = r.value;
    holder.textContent = '';
    holder.appendChild(renderConfigForm());
    holder.appendChild(el('div', {cls:'toolbar'}, [
      el('button', {cls:'primary', text:'保存并应用', onclick: saveConfig}),
      el('span', {cls:'hint', html:'<span style="color:var(--fg-dim);font-size:12px">默认值按钮会就地填入该项的出厂默认值</span>'})
    ]));
  }).catch(showErr);
}
function renderConfigForm(){
  var frag = document.createDocumentFragment();
  (schemaCache.children || []).forEach(function(group){
    var fs = el('fieldset');
    fs.appendChild(el('legend', {text: group.description || '配置'}));
    var body = el('div', {cls:'body'});
    if(group.children) group.children.forEach(function(node){ body.appendChild(renderField(node, [node.key], getPath(cfgCache, [node.key]))); });
    fs.appendChild(body);
    frag.appendChild(fs);
  });
  return frag;
}
function renderField(node, path, value){
  var t = node.type;
  if(t === 'object'){
    var sec = el('div', {cls:'section'});
    sec.appendChild(el('h3', {html: esc(node.description || path.join('.')) + (node.default !== undefined ? ' <span class="hint">默认 ' + esc(String(node.default)) + '</span>' : '')}));
    var body = el('div', {cls:'body'});
    if(node.children) node.children.forEach(function(c){ body.appendChild(renderField(c, path.concat(c.key), getPath(cfgCache, path.concat(c.key)))); });
    sec.appendChild(body);
    return sec;
  }
  if(t === 'intersect'){
    var frag = document.createDocumentFragment();
    (node.children || []).forEach(function(c){ frag.appendChild(renderField(c, path, value)); });
    return frag;
  }
  if(t === 'array'){
    var arr = getPath(cfgCache, path) || [];
    var box = el('div', {cls:'fld'});
    box.appendChild(el('div', {cls:'lbl'}, [el('div', {cls:'name', text: path[path.length-1]}), el('div', {cls:'desc', text: node.description || ''})]));
    var ctl = el('div', {cls:'ctl'});
    var list = el('div');
    function renderItems(){
      list.textContent = '';
      var a = getPath(cfgCache, path) || [];
      a.forEach(function(item, i){
        var itemEl = el('div', {cls:'list-item'});
        var row = el('div', {cls:'row'}, [
          el('span', {cls:'hint', text: '#' + i, style:'color:var(--fg-dim)'}),
          el('span', {cls:'spacer', style:'flex:1'}),
          el('button', {cls:'danger', text:'删除', onclick:function(){
            var a2 = getPath(cfgCache, path) || [];
            a2.splice(i,1); setPath(cfgCache, path, a2);
            renderItems(); renderConfigForm().then ? 0 : 0;
          }})
        ]);
        itemEl.appendChild(row);
        if(node.inner && node.inner.type === 'object'){
          var innerBody = el('div', {style:'margin-top:6px'});
          (node.inner.children || []).forEach(function(c){
            innerBody.appendChild(renderField(c, path.concat(i, c.key), getPath(cfgCache, path.concat(i, c.key))));
          });
          itemEl.appendChild(innerBody);
        } else if(node.inner){
          var inp = renderInput(node.inner, path.concat(i), item);
          itemEl.appendChild(inp);
        }
        list.appendChild(itemEl);
      });
      ctl.appendChild(list);
      ctl.appendChild(el('button', {text:'+ 添加一项', onclick:function(){
        var a3 = getPath(cfgCache, path) || [];
        a3.push(defaultFor(node.inner)); setPath(cfgCache, path, a3);
        renderItems();
      }}));
    }
    renderItems();
    box.appendChild(ctl);
    return box;
  }
  var box2 = el('div', {cls:'fld'});
  box2.appendChild(el('div', {cls:'lbl'}, [el('div', {cls:'name', text: path[path.length-1]}), el('div', {cls:'desc', text: node.description || ''})]));
  var ctl2 = el('div', {cls:'ctl'});
  ctl2.appendChild(renderInput(node, path, value));
  if(node.role !== 'secret' && node.default !== undefined && t !== 'const'){
    ctl2.appendChild(el('div', {style:'margin-top:4px'}, [el('button', {cls:'hint', text:'重置为默认', style:'font-size:11px;padding:1px 6px', onclick:function(){
      var v = structuredClone(node.default); setPath(cfgCache, path, v); ctl2.textContent=''; ctl2.appendChild(renderInput(node, path, v));
    }})]));
  }
  box2.appendChild(ctl2);
  return box2;
}
function renderInput(node, path, value){
  var t = node.type;
  if(t === 'boolean'){
    var cb = el('input', {type:'checkbox'});
    cb.checked = !!value;
    cb.onchange = function(){ setPath(cfgCache, path, cb.checked); };
    return cb;
  }
  if(t === 'select'){
    var sel = el('select');
    (node.options || []).forEach(function(opt, i){
      var o = el('option', {text: String(opt.value) + (opt.description ? ' — ' + opt.description : '')});
      o.value = String(opt.value);
      sel.appendChild(o);
      if(opt.value === value) sel.selectedIndex = i;
    });
    sel.onchange = function(){
      var idx = sel.selectedIndex;
      var chosen = (node.options || [])[idx];
      setPath(cfgCache, path, chosen ? chosen.value : sel.value);
    };
    return sel;
  }
  if(t === 'const'){
    return el('span', {cls:'hint', text: String(value), style:'color:var(--fg-dim)'});
  }
  if(t === 'number'){
    var num = el('input', {type:'number', value: value == null ? '' : value});
    num.onchange = function(){ setPath(cfgCache, path, num.value === '' ? undefined : Number(num.value)); };
    return num;
  }
  if(t === 'dict'){
    var dict = el('div');
    function renderDict(){
      dict.textContent = '';
      var obj = getPath(cfgCache, path) || {};
      Object.keys(obj || {}).forEach(function(k){
        var row = el('div', {style:'display:flex;gap:6px;margin-bottom:4px'});
        var kInp = el('input', {value:k, style:'width:35%'});
        var vInp = renderInput(node.inner || {type:'string'}, path.concat(k), obj[k]);
        row.appendChild(kInp);
        row.appendChild(vInp);
        row.appendChild(el('button', {text:'×', onclick:function(){
          var o2 = getPath(cfgCache, path) || {}; delete o2[k]; setPath(cfgCache, path, o2); renderDict();
        }}));
        dict.appendChild(row);
      });
      dict.appendChild(el('button', {text:'+ 键值', onclick:function(){
        var o3 = getPath(cfgCache, path) || {};
        var key = prompt('键名：'); if(!key) return;
        o3[key] = defaultFor(node.inner); setPath(cfgCache, path, o3); renderDict();
      }}));
    }
    renderDict();
    return dict;
  }
  // string
  if(node.role === 'textarea'){
    var ta = el('textarea', {rows: Math.max(4, Math.min(20, String(value||'').split(NL).length + 1))});
    ta.value = value || '';
    ta.oninput = function(){ setPath(cfgCache, path, ta.value); };
    return ta;
  }
  var inp = el('input', {type: node.role === 'secret' ? 'password' : 'text', value: value == null ? '' : value});
  if(node.role === 'secret'){
    var wrap = el('div', {style:'display:flex;gap:6px'});
    wrap.appendChild(inp);
    wrap.appendChild(el('button', {text:'显示', onclick:function(){ inp.type = inp.type === 'password' ? 'text' : 'password'; }}));
    inp.oninput = function(){ setPath(cfgCache, path, inp.value); };
    return wrap;
  }
  inp.oninput = function(){ setPath(cfgCache, path, inp.value); };
  return inp;
}
function defaultFor(node){
  if(!node) return '';
  if(node.type === 'object'){ var o = {}; (node.children||[]).forEach(function(c){ o[c.key] = defaultFor(c); }); return o; }
  if(node.type === 'array') return [];
  if(node.type === 'dict') return {};
  if(node.type === 'boolean') return false;
  if(node.type === 'number') return 0;
  return '';
}
function saveConfig(){
  var btn = event && event.target;
  if(btn) btn.disabled = true;
  var newPort = cfgCache.webui ? cfgCache.webui.port : undefined;
  api('POST', '/api/config', {config: cfgCache}).then(function(r){
    if(r.error) throw new Error(r.error);
    toast('配置已保存并应用，插件作用域正在重启…', 'ok');
    if(newPort && Number(newPort) !== (Number(location.port) || 80)){
      toast('端口已变更为 ' + newPort + '，即将跳转…', 'warn');
      setTimeout(function(){ location.href = location.protocol + '//' + location.hostname + ':' + newPort + '/'; }, 1200);
    } else {
      setTimeout(function(){ refreshOverview(); }, 1500);
    }
  }).catch(function(err){ toast('保存失败：' + (err.message || err), 'err'); })
    .finally(function(){ if(btn) btn.disabled = false; });
}

// ---------- 提示词 ----------
function loadPrompts(){
  $('#main').textContent = '';
  $('#main').appendChild(el('h2', {cls:'view-title', text:'提示词'}));
  $('#main').appendChild(el('p', {cls:'view-desc', text:'改写内置写死的提示词（Bot 行为准则 / World 任务模板），保存后立即生效，无需重启。带 {{变量}} 的是占位符，会被实际内容替换。'}));
  var holder = el('div', {text:'加载中…'});
  $('#main').appendChild(holder);
  api('GET', '/api/prompts').then(function(r){
    promptsDefaults = r.defaults;
    overridesCache = r.overrides;
    holder.textContent = '';
    var bot = promptGroup('Bot-LLM · 行为准则', r.defaults.bot, r.overrides.bot, 'bot');
    var world = promptGroup('World-LLM · 系统提示与任务模板', r.defaults.world, r.overrides.world, 'world');
    holder.appendChild(bot);
    holder.appendChild(world);
    holder.appendChild(el('div', {cls:'toolbar'}, [
      el('button', {cls:'primary', text:'保存', onclick: savePrompts}),
      el('span', {cls:'hint', style:'color:var(--fg-dim);font-size:12px', text:'仅保存与你编辑不同的项'}),
    ]));
  }).catch(showErr);
}
function promptGroup(title, defaults, current, prefix){
  var sec = el('div', {cls:'section'});
  sec.appendChild(el('h3', {text:title}));
  var body = el('div', {cls:'body'});
  var first = true;
  Object.keys(defaults).forEach(function(key){
    var fld = el('div', {cls:'fld'});
    fld.appendChild(el('div', {cls:'lbl'}, [el('div', {cls:'name', text:key}), el('div', {cls:'desc', html: descOf(key, prefix)})]));
    var ctl = el('div', {cls:'ctl'});
    var ta = el('textarea', {rows: Math.min(24, String(defaults[key]).split(NL).length + 2), style:'font-family:var(--mono);font-size:12px'});
    ta.value = current[key] !== undefined ? current[key] : defaults[key];
    var overridden = current[key] !== undefined;
    ta.oninput = function(){
      var isDefault = ta.value === defaults[key];
      overridden = !isDefault;
      overBadge.textContent = overridden ? '已覆盖' : '';
      overBadge.style.color = overridden ? 'var(--warn)' : 'var(--fg-dark)';
    };
    var overBadge = el('span', {text: overridden ? '已覆盖' : '', style:'color:' + (overridden ? 'var(--warn)' : 'var(--fg-dark)') + ';font-size:11px'});
    ctl.appendChild(ta);
    ctl.appendChild(el('div', {cls:'toolbar', style:'margin:4px 0 0'}, [
      overBadge,
      el('span', {cls:'spacer', style:'flex:1'}),
      el('button', {cls:'hint', text:'恢复默认', style:'font-size:11px;padding:1px 6px', onclick:function(){
        ta.value = defaults[key]; overridden = false; overBadge.textContent = '';
      }})
    ]));
    fld.appendChild(ctl);
    body.appendChild(fld);
    first = false;
  });
  sec.appendChild(body);
  return sec;
}
function descOf(key, prefix){
  var map = {
    bot: {
      constitutionHead: '行为准则开头段（两种工具协议的共同前言）',
      outputFormatJson: '输出格式段 · 文本协议（正文输出一个 JSON）',
      outputFormatNative: '输出格式段 · 原生协议（function calling）',
      constitution: '输出格式之后的通用规则（事件/电脑/媒体/手机/身份/心态等大段）',
      lifestyleWithWait: '心态段收尾（有 wait 工具时）',
      lifestyleNoWait: '心态段收尾（wait 被移除时）',
    },
    world: {
      system: 'World-LLM 系统提示。{{worldDef}} 世界定义、{{timeLine}} 当前时刻',
      adjudicateAct: '裁定 Bot 的 act 动作。{{desc}} {{issuedAt}} {{duration}} {{expectedAt}}',
      resolveWait: 'wait 补叙。{{issuedAt}} {{n}} {{expectedAt}}',
      resolveCheckTime: 'Bot 主动查看时间。{{timeLine}}',
      tingle: '世界心跳。{{timeLine}}',
      resolveOfflineGap: '离线补叙。{{fromTimeLine}} {{toTimeLine}} {{gapTU}}',
      reconcileDefinitions: '用户修改定义后重载。{{timeLine}} {{botDef}} {{worldDef}}',
      initialize: '创世初始化。{{timeLine}} {{botDef}} {{worldDef}}',
      compressSystem: '上下文压缩 · system',
      compressUser: '上下文压缩 · user。{{timeLine}} {{persona}} {{historySummary}} {{memoryDigest}} {{streamText}}',
      assessRealWorldSystem: '世界性质判定 · system',
      assessRealWorldUser: '世界性质判定 · user。{{worldDef}}',
      generateCalendarSystem: '历法生成 · system',
      generateCalendarUser: '历法生成 · user。{{worldDef}} {{epoch}} {{unitWorldSeconds}}',
    }
  };
  return map[prefix][key] || '';
}
function savePrompts(){
  var overrides = {bot:{}, world:{}};
  var groups = document.querySelectorAll('#main .section');
  var botSection = groups[0];
  var worldSection = groups[1];
  collectOverrides(botSection, promptsDefaults.bot, 'bot', overrides);
  collectOverrides(worldSection, promptsDefaults.world, 'world', overrides);
  api('POST', '/api/prompts', {overrides: overrides}).then(function(r){
    toast('提示词已保存并生效', 'ok');
    loadPrompts();
  }).catch(showErr);
}
function collectOverrides(section, defaults, prefix, out){
  var flds = section.querySelectorAll('.fld');
  flds.forEach(function(f){
    var name = f.querySelector('.name').textContent;
    var ta = f.querySelector('textarea');
    if(ta.value !== defaults[name]) out[prefix][name] = ta.value;
  });
}

// ---------- 状态 ----------
var stateCache = null;
var stateEditor = null;
function loadState(){
  $('#main').textContent = '';
  $('#main').appendChild(el('h2', {cls:'view-title', text:'状态'}));
  $('#main').appendChild(el('p', {cls:'view-desc', text:'直接读写世界状态。Bot_Status 由 Bot 压缩时维护、World_Status 与 News 由 World-LLM 维护——你在这里改的内容会进入它们的视野。保存后实时生效。'}));
  var holder = el('div', {text:'加载中…'});
  $('#main').appendChild(holder);
  api('GET', '/api/state').then(function(r){
    stateCache = r;
    holder.textContent = '';
    holder.appendChild(stateEditor = renderStateEditor(r));
  }).catch(showErr);
}
function renderStateEditor(s){
  var frag = document.createDocumentFragment();
  var tabs = el('div', {cls:'tabs'}, [
    el('button', {cls:'active', text:'Bot_Status.md', onclick:function(){ setTab(this, 'bot'); }}),
    el('button', {text:'World_Status.md', onclick:function(){ setTab(this, 'world'); }}),
    el('button', {text:'世界新闻 News.db', onclick:function(){ setTab(this, 'news'); }}),
    el('button', {text:'Bot_Definition.md', onclick:function(){ setTab(this, 'botdef'); }}),
    el('button', {text:'World_Definition.md', onclick:function(){ setTab(this, 'worlddef'); }}),
  ]);
  frag.appendChild(tabs);
  var panes = el('div');
  panes.appendChild(statePane('bot', 'Bot 状态', s.botStatus, 'PUT', '/api/state/bot-status'));
  panes.appendChild(statePane('world', '世界状态', s.worldStatus, 'PUT', '/api/state/world-status'));
  panes.appendChild(newsPane(s.news));
  panes.appendChild(statePane('botdef', 'Bot 角色定义', s.botDef, 'PUT', '/api/definitions/bot'));
  panes.appendChild(statePane('worlddef', '世界定义', s.worldDef, 'PUT', '/api/definitions/world'));
  frag.appendChild(panes);
  if(s.meta && Object.keys(s.meta).length){
    frag.appendChild(el('div', {cls:'section'}, [el('h3', {text:'元数据 meta.json'}), el('div', {cls:'body'}, [el('pre', {text: JSON.stringify(s.meta, null, 2)})])]));
  }
  return frag;
}
function statePane(id, title, content, method, url){
  var sec = el('div', {cls:'section', 'data-pane': id});
  var ta = el('textarea', {rows: 16});
  ta.value = content;
  sec.appendChild(el('h3', {html: esc(title) + ' <span class="hint">' + (method==='PUT'?'整体覆盖':'追加') + '</span>'}));
  sec.appendChild(el('div', {cls:'body'}, [
    el('label', {style:'font-size:12px;color:var(--fg-dim)', html:'<input type="checkbox" id="chk-' + id + '"> 原始模式（默认渲染为纯文本）'}),
    ta,
    el('div', {cls:'toolbar'}, [el('button', {cls:'primary', text:'保存', onclick:function(){
      api(method, url, {content: ta.value}).then(function(){ toast(title + ' 已保存', 'ok'); }).catch(showErr);
    }})])
  ]));
  return sec;
}
function newsPane(news){
  var sec = el('div', {cls:'section', 'data-pane': 'news'});
  sec.appendChild(el('h3', {html:'世界新闻 <span class="hint">World-LLM 记录的大事记（JSONL）</span>'}));
  var body = el('div', {cls:'body'});
  var list = el('div');
  function render(){
    list.textContent = '';
    news.forEach(function(n, i){
      var it = el('div', {cls:'news-item'});
      var ta = el('textarea', {rows: 2});
      ta.value = n.content;
      it.appendChild(el('span', {cls:'clock', text:'[' + n.clock + ']  T=' + Number(n.t).toFixed(1)}));
      it.appendChild(ta);
      it.appendChild(el('div', {cls:'toolbar', style:'margin:4px 0 0'}, [
        el('button', {text:'保存修改', onclick:function(){
          api('PUT', '/api/state/news', {index:i, content: ta.value}).then(function(){ news[i].content = ta.value; toast('已保存', 'ok'); }).catch(showErr);
        }}),
        el('button', {cls:'danger', text:'删除', onclick:function(){
          if(!confirm('删除这条事件？')) return;
          api('DELETE', '/api/state/news?index=' + i).then(function(){ news.splice(i,1); render(); }).catch(showErr);
        }})
      ]));
      list.appendChild(it);
    });
  }
  render();
  var add = el('div', {cls:'toolbar'}, [
    el('input', {id:'news-add', placeholder:'新增一条世界事件…', style:'flex:1'}),
    el('button', {cls:'primary', text:'追加', onclick:function(){
      var v = $('#news-add').value.trim();
      if(!v) return;
      api('POST', '/api/state/news', {content: v}).then(function(){ $('#news-add').value=''; loadState(); }).catch(showErr);
    }})
  ]);
  body.appendChild(add);
  body.appendChild(list);
  sec.appendChild(body);
  return sec;
}
function setTab(btn, id){
  btn.parentNode.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  $('#main').querySelectorAll('[data-pane]').forEach(function(p){ p.classList.toggle('hidden', p.getAttribute('data-pane') !== id); });
}
function refreshState(signal){
  if(!stateCache) return;
  api('GET', '/api/state').then(function(r){
    stateCache = r;
    if(!stateEditor) return;
    // 只刷新对应窗格的内容（保持用户编辑中）
    if(signal === 'botStatus') setPaneText('bot', r.botStatus);
    else if(signal === 'worldStatus') setPaneText('world', r.worldStatus);
    else if(signal === 'news') loadState();
    else if(signal === 'botDef') setPaneText('botdef', r.botDef);
    else if(signal === 'worldDef') setPaneText('worlddef', r.worldDef);
  }).catch(function(){});
}
function setPaneText(id, content){
  var pane = $('#main').querySelector('[data-pane="' + id + '"]');
  if(!pane) return;
  var ta = pane.querySelector('textarea');
  if(document.activeElement !== ta) ta.value = content;
}

// ---------- 调试 ----------
var debugEntries = [];
var debugKindFilter = 'all';
var debugSubview = 'llm';
var debugOrder = 'desc';
function loadDebug(){
  $('#main').textContent = '';
  $('#main').appendChild(el('h2', {cls:'view-title', text:'调试'}));
  $('#main').appendChild(el('p', {cls:'view-desc', text:'流式阅读 Bot-LLM / World-LLM 的原始输入输出与 Bot 的实时行为。点击条目展开查看完整内容。'}));
  var tabs = el('div', {cls:'tabs'}, [
    el('button', {cls: debugSubview==='llm'?'active':'', text:'LLM 请求/响应', onclick:function(){ setDebugSubview('llm', this); }}),
    el('button', {cls: debugSubview==='bot'?'active':'', text:'Bot 行为', onclick:function(){ setDebugSubview('bot', this); }}),
    el('button', {cls: debugSubview==='world'?'active':'', text:'World 行为', onclick:function(){ setDebugSubview('world', this); }}),
    el('button', {cls: debugSubview==='all'?'active':'', text:'全部', onclick:function(){ setDebugSubview('all', this); }}),
    el('button', {cls: debugSubview==='stream'?'active':'', text:'工作窗口 stream.jsonl', onclick:function(){ setDebugSubview('stream', this); }}),
  ]);
  $('#main').appendChild(tabs);
  function setDebugSubview(sub, btn){
    debugSubview = sub;
    tabs.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
    if(btn) btn.classList.add('active');
    if(sub === 'stream') renderStreamTab();
    else renderDebugList();
  }
  var holder = el('div');
  $('#main').appendChild(holder);
  var toolbar = el('div', {cls:'toolbar'}, [
    el('button', {text:'清空', onclick:function(){
      debugEntries = [];
      api('DELETE', '/api/debug').catch(function(){});
      renderDebugList();
    }}),
    el('label', {html:'<input type="checkbox" id="dbg-auto" checked> 自动滚动', style:'font-size:12px;color:var(--fg-dim)'}),
    el('button', {id:'dbg-order', text: debugOrder === 'desc' ? '倒序' : '正序', title:'切换列表排序（倒序=最新在前，正序=最旧在前）', onclick:function(){
      debugOrder = debugOrder === 'desc' ? 'asc' : 'desc';
      $('#dbg-order').textContent = debugOrder === 'desc' ? '倒序' : '正序';
      renderDebugList();
    }}),
    el('span', {cls:'spacer', style:'flex:1'}),
    el('span', {id:'dbg-count', text:'', style:'color:var(--fg-dim);font-size:12px'}),
  ]);
  $('#main').appendChild(toolbar);
  $('#main').appendChild(holder);
  api('GET', '/api/debug?n=300').then(function(r){
    debugEntries = r.entries;
    if(debugSubview === 'stream') renderStreamTab();
    else renderDebugList();
  }).catch(showErr);
}
function renderStreamTab(){
  $('#main').lastChild.innerHTML = '';
  var holder = $('#main').lastChild;
  var pre = el('pre', {style:'max-height:70vh;overflow:auto'});
  pre.textContent = '加载中…';
  holder.appendChild(pre);
  api('GET', '/api/stream').then(function(r){
    var lines = [];
    (r.entries || []).forEach(function(e){
      if(e.kind === 'tool_call'){
        lines.push('⟦tool_call⟧ ' + JSON.stringify(e.call));
      } else {
        lines.push('⟦event⟧ ' + JSON.stringify(e.event));
      }
    });
    pre.textContent = lines.length ? lines.join(NL) : '（工作窗口为空）';
    pre.scrollTop = pre.scrollHeight;
  }).catch(showErr);
}
function debugSubKinds(sub){
  if(sub === 'llm') return ['llm.req','llm.res'];
  if(sub === 'bot') return ['bot.tool','bot.event'];
  if(sub === 'world') return ['world.task','world.result','world.tool'];
  return null;
}
function renderDebugList(){
  var holder = $('#main').lastChild;
  holder.textContent = '';
  var list = el('div', {cls:'debug-list'});
  var kinds = debugSubKinds(debugSubview);
  var shown = 0;
  var items = debugEntries.slice();
  if(debugOrder === 'desc') items.reverse();
  items.forEach(function(e){
    if(kinds && kinds.indexOf(e.kind) < 0) return;
    if(debugKindFilter !== 'all' && e.kind !== debugKindFilter) return;
    shown++;
    list.appendChild(debugRow(e));
  });
  $('#dbg-count').textContent = '显示 ' + shown + ' 条';
  if(!shown) list.appendChild(el('p', {cls:'empty', text:'（没有匹配的条目）', style:'color:var(--fg-dim)'}));
  holder.appendChild(list);
  if(debugAutoScroll && shown) list.scrollTop = debugOrder === 'desc' ? 0 : list.scrollHeight;
}
function prettyDetail(e){
  var text = e.detail;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch(err){ return text; }
}
function debugRow(e){
  var tagClass = 'tag';
  if(e.kind === 'llm.req') tagClass += ' req';
  else if(e.kind === 'llm.res') tagClass += ' res';
  else if(e.kind === 'bot.tool' || e.kind === 'world.tool') tagClass += ' tool';
  else if(e.kind === 'bot.event' || e.kind === 'world.task' || e.kind === 'world.result') tagClass += ' event';
  else if(e.level === 'error') tagClass += ' err';
  var row = el('div', {cls:'dbg', 'data-id': e.id});
  var head = el('div', {cls:'head'}, [
    el('span', {cls:'t', text: fmtTime(e.ts)}),
    el('span', {cls:'tag', text: e.kind}),
    el('span', {cls:'l', text: e.label}),
    el('span', {cls:'tag ' + (e.level==='error'?'err':''), text: e.level}),
  ]);
  head.onclick = function(){ row.classList.toggle('open'); };
  row.appendChild(head);
  var detail = el('div', {cls:'detail'});
  var pre = el('pre');
  pre.textContent = prettyDetail(e);
  detail.appendChild(pre);
  row.appendChild(detail);
  return row;
}
function appendDebugEntry(e){
  if(debugSubview === 'stream') return;
  for(var i=0;i<debugEntries.length;i++){
    if(debugEntries[i].id === e.id){
      debugEntries[i] = e;
      updateDebugEntry(e);
      return;
    }
  }
  debugEntries.push(e);
  if(debugEntries.length > 800) debugEntries.splice(0, debugEntries.length - 800);
  if(activeView !== 'debug') return;
  var kinds = debugSubKinds(debugSubview);
  if(kinds && kinds.indexOf(e.kind) < 0) return;
  var list = ($('#main').lastChild).querySelector('.debug-list');
  if(!list) return;
  var ph = list.querySelector('.empty');
  if(ph) ph.remove();
  var row = debugRow(e);
  if(debugOrder === 'desc') list.insertBefore(row, list.firstChild);
  else list.appendChild(row);
  $('#dbg-count').textContent = '显示 ' + list.querySelectorAll('.dbg').length + ' 条';
  // 仅当用户原本就停在新内容一侧时才自动滚动，避免把展开阅读中的条目拉走
  if(debugAutoScroll && atNewestEdge(list)) list.scrollTop = debugOrder === 'desc' ? 0 : list.scrollHeight;
}
function atNewestEdge(list){
  if(debugOrder === 'desc') return list.scrollTop <= 4;
  return list.scrollHeight - list.scrollTop - list.clientHeight <= 4;
}
function updateDebugEntry(e){
  for(var i=0;i<debugEntries.length;i++){ if(debugEntries[i].id === e.id){ debugEntries[i] = e; break; } }
  if(activeView !== 'debug' || debugSubview === 'stream') return;
  var kinds = debugSubKinds(debugSubview);
  if(kinds && kinds.indexOf(e.kind) < 0) return;
  var list = ($('#main').lastChild).querySelector('.debug-list');
  if(!list) return;
  var row = list.querySelector('.dbg[data-id="' + e.id + '"]');
  if(!row) return;
  // 原地刷新（不重建节点）：保持展开状态与滚动位置，流式内容实时增长
  var heads = row.querySelectorAll('.head > span');
  if(heads[0]) heads[0].textContent = fmtTime(e.ts);
  if(heads[2]) heads[2].textContent = e.label;
  if(heads[3]){ heads[3].textContent = e.level; heads[3].className = 'tag ' + (e.level==='error'?'err':''); }
  var pre = row.querySelector('.detail pre');
  if(pre) pre.textContent = prettyDetail(e);
}

// ---------- 相册 ----------
function loadGallery(){
  $('#main').textContent = '';
  $('#main').appendChild(el('h2', {cls:'view-title', text:'相册（Bot 收藏夹）'}));
  $('#main').appendChild(el('p', {cls:'view-desc', text:'分类：表情包 / meme / 截图 / 照片 / 未整理。未整理是主人手动放入、待 Bot 归类描述的东西。'}));
  var holder = el('div', {text:'加载中…'});
  $('#main').appendChild(holder);
  api('GET', '/api/gallery').then(function(r){
    galleryCache = r.entries;
    holder.textContent = '';
    holder.appendChild(renderGallery());
  }).catch(showErr);
}
function renderGallery(){
  var frag = document.createDocumentFragment();
  var cats = ['表情包','meme','截图','照片','未整理'];
  var counts = {};
  galleryCache.forEach(function(e){ counts[e.category] = (counts[e.category]||0) + 1; });
  var tabs = el('div', {cls:'tabs'});
  cats.forEach(function(c){
    tabs.appendChild(el('button', {cls: currentCategory===c?'active':'', text: c + ' (' + (counts[c]||0) + ')', onclick:function(){
      currentCategory = c;
      frag2.textContent = '';
      frag2.appendChild(renderGalleryGrid());
      tabs.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
      this.classList.add('active');
    }}));
  });
  frag.appendChild(tabs);
  var frag2 = el('div');
  frag2.appendChild(renderGalleryGrid());
  frag.appendChild(frag2);
  frag.appendChild(uploadBar());
  return frag;
}
function renderGalleryGrid(){
  var wrap = el('div');
  var list = el('div', {cls:'gallery-grid'});
  var items = galleryCache.filter(function(e){ return e.category === currentCategory; });
  items.forEach(function(e){
    var url = '/api/gallery/file?category=' + encodeURIComponent(e.category) + '&name=' + encodeURIComponent(e.name);
    var card = el('div', {cls:'g-card'});
    if(e.image){
      var img = el('img', {src: url, loading:'lazy'});
      img.onerror = function(){ img.style.visibility = 'hidden'; };
      img.onclick = function(){ showImage(e.category + ' / ' + e.name, url); };
      card.appendChild(img);
    } else {
      card.appendChild(el('div', {style:'height:110px;display:flex;align-items:center;justify-content:center;background:var(--bg3);font-size:32px', text:'📄'}));
    }
    card.appendChild(el('div', {cls:'m', text: e.name + ' · ' + fmtBytes(e.size)}));
    card.appendChild(el('div', {cls:'d', text: e.description || '（无描述）'}));
    var actions = el('div', {cls:'a'});
    var sel = el('select');
    ['表情包','meme','截图','照片','未整理'].forEach(function(c){
      if(c === e.category) return;
      sel.appendChild(el('option', {value:c, text:'移到 ' + c}));
    });
    if(sel.options.length){
      sel.onchange = function(){
        var target = sel.value;
        if(!target) return;
        api('POST', '/api/gallery/move', {category:e.category, name:e.name, targetCategory:target}).then(function(){
          toast('已移动到 ' + target, 'ok'); loadGallery();
        }).catch(showErr);
      };
      actions.appendChild(sel);
    }
    actions.appendChild(el('button', {text:'描述', onclick:function(){
      var d = prompt('写入描述（Bot 挑图依据：内容、梗/情绪、适合场合）：', e.description || '');
      if(d == null) return;
      api('POST', '/api/gallery/description', {category:e.category, name:e.name, description:d}).then(function(){ toast('已保存', 'ok'); loadGallery(); }).catch(showErr);
    }}));
    actions.appendChild(el('button', {cls:'danger', text:'删除', onclick:function(){
      if(!confirm('删除 ' + e.name + ' ？')) return;
      api('POST', '/api/gallery/remove', {category:e.category, name:e.name}).then(function(){ toast('已删除', 'ok'); loadGallery(); }).catch(showErr);
    }}));
    card.appendChild(actions);
    list.appendChild(card);
  });
  if(!items.length) list.appendChild(el('p', {text:'（这个分类还是空的）', style:'color:var(--fg-dim)'}));
  wrap.appendChild(list);
  return wrap;
}
function uploadBar(){
  var bar = el('div', {cls:'section'});
  bar.appendChild(el('h3', {text:'上传图片到相册'}));
  var body = el('div', {cls:'body'});
  var catSel = el('select');
  ['表情包','meme','截图','照片','未整理'].forEach(function(c){ catSel.appendChild(el('option', {value:c, text:c})); });
  var file = el('input', {type:'file', accept:'image/*', style:'flex:1'});
  body.appendChild(el('div', {cls:'toolbar', style:'margin:0'}, [
    catSel, file,
    el('button', {cls:'primary', text:'上传', onclick:function(){
      if(!file.files.length) return toast('请先选择图片', 'warn');
      var f = file.files[0];
      api('POST', '/api/gallery/upload?category=' + encodeURIComponent(catSel.value) + '&name=' + encodeURIComponent(f.name), f).then(function(r){
        toast('已上传到 ' + r.category, 'ok');
        file.value = '';
        loadGallery();
      }).catch(showErr);
    }})
  ]));
  bar.appendChild(body);
  return bar;
}

// ---------- 媒体 ----------
function loadMedia(){
  $('#main').textContent = '';
  $('#main').appendChild(el('h2', {cls:'view-title', text:'媒体资产库'}));
  $('#main').appendChild(el('p', {cls:'view-desc', text:'Bot 见过的媒体缓存（只读，Bot 用 check_media 翻看）。收藏夹是它精心挑选的，这里是全部见过的东西。'}));
  var holder = el('div', {text:'加载中…'});
  $('#main').appendChild(holder);
  api('GET', '/api/media').then(function(r){
    holder.textContent = '';
    var rows = r.rows || [];
    var tbl = el('table');
    var thead = el('tr');
    ['id','类型','格式','大小','时间','解释缓存'].forEach(function(h){ thead.appendChild(el('th', {text:h})); });
    tbl.appendChild(thead);
    rows.forEach(function(m){
      var tr = el('tr');
      tr.appendChild(el('td', {text: String(m.id)}));
      tr.appendChild(el('td', {text: m.type}));
      tr.appendChild(el('td', {text: m.mime}));
      tr.appendChild(el('td', {text: fmtBytes(m.size)}));
      tr.appendChild(el('td', {text: new Date(m.createdAt).toLocaleString()}));
      var sum = el('td');
      if(m.summary) sum.textContent = m.summary;
      if(m.type === 'image'){
        sum.appendChild(el('div', {style:'margin-top:4px'}, [el('button', {text:'查看原图', onclick:function(){
          showImage('媒体 #' + m.id, '/api/media/file?id=' + m.id);
        }})]));
      }
      tr.appendChild(sum);
      tbl.appendChild(tr);
    });
    if(!rows.length) holder.appendChild(el('p', {text:'（还没有任何媒体）', style:'color:var(--fg-dim)'}));
    else holder.appendChild(tbl);
  }).catch(showErr);
}

// ---------- 数据 ----------
function refreshData(){
  $('#main').textContent = '';
  $('#main').appendChild(el('h2', {cls:'view-title', text:'数据文件与记事本'}));
  $('#main').appendChild(el('p', {cls:'view-desc', text:'查看/编辑世界数据目录里的运行时 JSON 文件与 Bot 的记事本（Notes/），以及压缩归档。'}));
  var holder = el('div', {text:'加载中…'});
  $('#main').appendChild(holder);
  api('GET', '/api/data').then(function(r){
    holder.textContent = '';
    var sec = el('div', {cls:'section'});
    sec.appendChild(el('h3', {text:'运行时 JSON 文件'}));
    var body = el('div', {cls:'body'});
    var rows = el('div');
    r.files.forEach(function(f){
      rows.appendChild(el('div', {cls:'kv'}, [
        el('span', {cls:'k', text: f.name + (f.exists ? ' · ' + fmtBytes(f.size) : ' · 不存在')}),
        el('button', {text:'打开编辑', onclick:function(){ openDataFile(f.name); }})
      ]));
    });
    body.appendChild(rows);
    sec.appendChild(body);
    holder.appendChild(sec);

    var notesSec = el('div', {cls:'section'});
    notesSec.appendChild(el('h3', {html:'记事本 Notes/ <span class="hint">Bot 的私人笔记（文件名即标题）</span>'}));
    var nbody = el('div', {cls:'body'});
    var nlist = el('div');
    api('GET', '/api/notes').then(function(nr){
      (nr.notes || []).forEach(function(n){
        nlist.appendChild(el('div', {cls:'kv'}, [
          el('span', {cls:'k', text: n.title}),
          el('span', {cls:'v'}, [
            el('button', {text:'打开', onclick:function(){ openNote(n.title); }}),
            el('button', {cls:'danger', text:'删除', style:'margin-left:6px', onclick:function(){
              if(!confirm('删除笔记「' + n.title + '」？')) return;
              api('DELETE', '/api/notes?name=' + encodeURIComponent(n.title)).then(function(){ toast('已删除', 'ok'); refreshData(); }).catch(showErr);
            }})
          ])
        ]));
      });
      if(!nr.notes || !nr.notes.length) nlist.appendChild(el('p', {text:'（记事本是空的）', style:'color:var(--fg-dim)'}));
    }).catch(function(){});
    nbody.appendChild(nlist);
    nbody.appendChild(el('div', {cls:'toolbar'}, [el('button', {text:'新建笔记…', onclick:function(){
      var name = prompt('笔记标题（将创建为 Notes/<标题>.md）：');
      if(!name) return;
      openNote(name);
    }})]));
    notesSec.appendChild(nbody);
    holder.appendChild(notesSec);

    if(r.archive && r.archive.length){
      var aSec = el('div', {cls:'section'});
      aSec.appendChild(el('h3', {html:'归档 archive/ <span class="hint">压缩与重置时的历史文件</span>'}));
      var ab = el('div', {cls:'body'});
      var alist = el('div');
      r.archive.forEach(function(a){
        alist.appendChild(el('div', {cls:'kv'}, [
          el('span', {cls:'k', text: a}),
          el('button', {text:'查看', onclick:function(){
            api('GET', '/api/archive/file?name=' + encodeURIComponent(a)).then(function(r2){
              $('#modal-title').textContent = a;
              var pre = el('pre', {style:'max-height:60vh;overflow:auto'});
              pre.textContent = r2.content;
              $('#modal-body').textContent = '';
              $('#modal-body').appendChild(pre);
              $('#modal').classList.add('show');
            }).catch(showErr);
          }})
        ]));
      });
      ab.appendChild(alist);
      aSec.appendChild(ab);
      holder.appendChild(aSec);
    }
  }).catch(showErr);
}
function openDataFile(name){
  api('GET', '/api/data/file?name=' + encodeURIComponent(name)).then(function(r){
    $('#modal-title').textContent = name;
    var ta = el('textarea', {rows: 20, style:'font-family:var(--mono);font-size:12px'});
    ta.value = r.content;
    var save = el('button', {cls:'primary', text:'保存', onclick:function(){
      api('POST', '/api/data/file', {name:name, content:ta.value}).then(function(){ toast('已保存', 'ok'); hideModal(); }).catch(showErr);
    }});
    var body = el('div', null, [ta, el('div', {cls:'toolbar', style:'margin:8px 0 0'}, [save, el('button', {text:'关闭', onclick:hideModal})])]);
    $('#modal-body').textContent = '';
    $('#modal-body').appendChild(body);
    $('#modal').classList.add('show');
  }).catch(showErr);
}
function openNote(title){
  api('GET', '/api/notes').then(function(r){
    var note = (r.notes || []).filter(function(n){ return n.title === title; })[0];
    $('#modal-title').textContent = '笔记：' + title;
    var ta = el('textarea', {rows: 22, style:'font-family:var(--mono);font-size:12px'});
    ta.value = note ? note.content : '';
    var body = el('div', null, [
      ta,
      el('div', {cls:'toolbar', style:'margin:8px 0 0'}, [
        el('button', {cls:'primary', text:'保存', onclick:function(){
          api('PUT', '/api/notes', {name:title, content:ta.value}).then(function(){ toast('已保存', 'ok'); hideModal(); refreshData(); }).catch(showErr);
        }}),
        el('button', {text:'关闭', onclick:hideModal})
      ])
    ]);
    $('#modal-body').textContent = '';
    $('#modal-body').appendChild(body);
    $('#modal').classList.add('show');
  }).catch(showErr);
}

// ---------- 工具 ----------
function getPath(obj, arr){
  var cur = obj;
  for(var i=0;i<arr.length;i++){ if(cur == null) return undefined; cur = cur[arr[i]]; }
  return cur;
}
function setPath(obj, arr, val){
  var cur = obj;
  for(var i=0;i<arr.length-1;i++){
    if(cur[arr[i]] == null) cur[arr[i]] = {};
    cur = cur[arr[i]];
  }
  cur[arr[arr.length-1]] = val;
}

// ---------- 启动 ----------
buildNav();
refreshOverview();
connectSSE();
setInterval(function(){ refreshOverview(); }, 8000);
</script>
</body>
</html>
`;
