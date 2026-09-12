
'use strict';
var NL = String.fromCharCode(10);
var VERSION = '?';
var TOKEN = localStorage.getItem('wui_token') || '';
// 访问者模式：'admin'（webui.token）或 'visitor'（访客账号）
var MODE = localStorage.getItem('wui_mode') === 'visitor' ? 'visitor' : 'admin';
var VISITOR_TOKEN = localStorage.getItem('wui_visitor_token') || '';
var VISITOR_GRANTS = []; // 当前访客会话可见的数据块集合
try { VISITOR_GRANTS = JSON.parse(localStorage.getItem('wui_visitor_grants') || '[]'); } catch(e) { VISITOR_GRANTS = []; }
var VISITOR_PRESET = localStorage.getItem('wui_visitor_preset') || '';
var VISITOR_PLAYER_PROFILE = null; // { name, persona }
try { VISITOR_PLAYER_PROFILE = JSON.parse(localStorage.getItem('wui_player_profile') || 'null'); } catch(e) { VISITOR_PLAYER_PROFILE = null; }
// 常驻角色名由 Studio 的世界状态读取更新。
var RESIDENT_BOT_NAME = '';
var activeView = 'overview';
// SSE 断线续传锚点：跨页面加载持久化，避免每次无缓存刷新都从 0 重放整段调试历史
var lastEventId = Number(localStorage.getItem('wui_last_id') || 0);
var evtSource = null;
var cfgCache = null, schemaCache = null, cfgGroup = '', cfgSearch = '', cfgDirty = false, cfgPortOriginal = null;
var overridesCache = null, promptsDefaults = null;
var galleryCache = [], currentCategory = '未整理';
var stateCache = null;
// 手机外壳预览：{{screen}} 占位符用一张浅灰 SVG 占位图，展示屏幕区域
var SCREEN_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1280"><rect width="100%" height="100%" fill="#eef1f5"/><text x="50%" y="50%" font-family="sans-serif" font-size="28" fill="#9aa4b0" text-anchor="middle">屏幕预览</text></svg>');
var lastOverview = null;
var viewTimers = [];

// ---------- 基础工具 ----------
function $(sel){ return document.querySelector(sel); }
function el(tag, attrs, children){
  var n = document.createElement(tag);
  if(attrs) for(var k in attrs){
    if(k === 'html') n.innerHTML = attrs[k];
    else if(k === 'cls') n.className = attrs[k];
    else if(k === 'text') n.textContent = attrs[k];
    else if(k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
    // 布尔属性：用真实布尔赋值而非 setAttribute（HTML 里 checked/disabled/readonly 存在即真，值无所谓）
    else if(['checked','disabled','readonly','selected','multiple','open','hidden','required'].includes(k)) n[k === 'readonly' ? 'readOnly' : k] = !!attrs[k];
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
function svgIcon(body){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>'; }
var ICONS = {
  gauge: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 12l3.5-3.5"/><path d="M7.5 16.5h9"/>'),
  monitor: svgIcon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  activity: svgIcon('<path d="M3 12h4l3 8 4-16 3 8h4"/>'),
  file: svgIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>'),
  edit: svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  image: svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>'),
  film: svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
  folder: svgIcon('<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  chart: svgIcon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  sliders: svgIcon('<path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/>'),
  menu: svgIcon('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  phone: svgIcon('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  portal: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M3.5 12h17"/><path d="M12 3a13.5 13.5 0 0 1 0 18"/><path d="M12 3a13.5 13.5 0 0 0 0 18"/>'),
  door: svgIcon('<path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/><path d="M13 21v-7a2 2 0 0 1 2-2h1.5"/><circle cx="16" cy="10.5" r="0.8"/>'),
  logout: svgIcon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M15 8l4 4-4 4"/><path d="M19 12H9"/>'),
  users: svgIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>')
};
function icon(name){ return ICONS[name] || ''; }
function copyText(text, hint){
  function done(){ toast(hint || '已复制', 'ok'); }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, function(){ fallback(); });
  } else fallback();
  function fallback(){
    var ta = el('textarea', {style:'position:fixed;opacity:0'});
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch(e){ toast('复制失败', 'err'); }
    ta.remove();
  }
}

// ---------- 弹层 ----------
function toast(msg, kind){
  var t = el('div', {cls:'toast '+(kind||''), text: String(msg)});
  $('#toasts').appendChild(t);
  setTimeout(function(){ t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(function(){ t.remove(); }, 320); }, 4200);
}
function showModal(title, bodyNode){
  $('#modal-title').textContent = title;
  var body = $('#modal-body');
  body.textContent = '';
  body.appendChild(bodyNode);
  $('#modal').classList.add('show');
}
function hideModal(){ if(authCancel) authCancel(); $('#modal').classList.remove('show'); }
$('#modal-x').onclick = hideModal;
$('#modal').onclick = function(e){ if(e.target === this) hideModal(); };
function promptToken(){
  return promptAuth();
}
// 登录：管理员令牌（webui.token）或访客账号（用户名+密码）
// 采用单例：登录弹窗已显示期间，后续 401 复用同一个 Promise，不重复弹窗、不清空已填表单
var authPromise = null, authCancel = null;
function promptAuth(){
  if(authPromise) return authPromise;
  authPromise = new Promise(function(resolve){
    var settled = false, loginPending = false, loginRequest = null;
    function settle(v){
      if(settled) return;
      settled = true;
      authPromise = null;
      authCancel = null;
      if(loginRequest) loginRequest.abort();
      resolve(v);
    }
    // Modal 的 X、背景、Escape 均可调用；这里只结算，不递归关闭弹层。
    authCancel = function(){ settle(null); };
    var finish = function(v){ settle(v); hideModal(); };
    var mode = 'admin'; // 'admin' | 'visitor'
    var usernameInput = el('input', {placeholder:'用户名', style:'width:100%;margin:0 0 8px'});
    var pwdInput = el('input', {type:'password', placeholder:'密码', style:'width:100%'});
    var tokenInput = el('input', {type:'password', placeholder:'webui.token', style:'width:100%'});
    var errLine = el('p', {style:'color:var(--err);font-size:12.5px;min-height:16px'});
    var adminSec = el('div', null, [
      el('p', {text:'服务器设置了访问令牌（webui.token），请输入以继续。', style:'color:var(--fg-dim);font-size:13px;margin:0 0 8px'}),
      tokenInput
    ]);
    var visitorSec = el('div', null, [
      el('p', {text:'访客只读访问：输入管理员分配的用户名与密码。', style:'color:var(--fg-dim);font-size:13px;margin:0 0 8px'}),
      usernameInput, pwdInput
    ]);
    var tabs = el('div', {cls:'toolbar', style:'margin:0 0 10px'}, [
      el('button', {cls: mode==='admin'?'primary':'', text:'管理员', onclick:function(){ setMode('admin'); }}),
      el('button', {cls: mode==='visitor'?'primary':'', text:'访客', onclick:function(){ setMode('visitor'); }})
    ]);
    var body = el('div', null, [tabs, adminSec, visitorSec, errLine,
      el('div', {cls:'toolbar'}, [
        el('button', {text:'取消', onclick:function(){ finish(null); }}),
        el('button', {cls:'primary', text:'登录', onclick:function(){ doLogin(); }})
      ])
    ]);
    function setMode(m){
      mode = m;
      tabs.childNodes[0].className = m==='admin'?'primary':'';
      tabs.childNodes[1].className = m==='visitor'?'primary':'';
      adminSec.style.display = m==='admin' ? '' : 'none';
      visitorSec.style.display = m==='visitor' ? '' : 'none';
      errLine.textContent = '';
      if(m==='admin') setTimeout(function(){ tokenInput.focus(); }, 20);
      else setTimeout(function(){ usernameInput.focus(); }, 20);
    }
    function doLogin(){
      if(settled || loginPending) return;
      errLine.textContent = '';
      if(mode === 'admin'){
        setAdmin(tokenInput.value.trim());
      } else {
        loginPending = true;
        loginRequest = new AbortController();
        fetch('/api/login', {method:'POST', signal:loginRequest.signal, headers:{'Content-Type':'application/json'}, body: JSON.stringify({username: usernameInput.value.trim(), password: pwdInput.value})})
          .then(function(res){ return res.json().then(function(d){ return {ok:res.ok, d:d}; }); })
          .then(function(r){
            if(settled) return;
            if(!r.ok){ errLine.textContent = r.d.error || '登录失败'; return; }
            setVisitor(r.d.token, r.d.grants || [], r.d.preset, r.d.playerProfile || null);
          })
          .catch(function(e){ if(!settled) errLine.textContent = String(e && e.message || e); })
          .finally(function(){ loginPending = false; });
      }
    }
    function setAdmin(t){
      TOKEN = t;
      MODE = 'admin';
      VISITOR_TOKEN = '';
      localStorage.setItem('wui_token', TOKEN);
      localStorage.setItem('wui_mode', 'admin');
      localStorage.removeItem('wui_visitor_token');
      localStorage.removeItem('wui_visitor_grants');
      localStorage.removeItem('wui_visitor_preset');
      localStorage.removeItem('wui_player_profile');
      finish(t);
      window.dispatchEvent(new CustomEvent('studio:auth'));
    }
    function setVisitor(tok, grants, preset, playerProfile){
      VISITOR_TOKEN = tok;
      VISITOR_GRANTS = grants;
      VISITOR_PRESET = preset || '';
      VISITOR_PLAYER_PROFILE = playerProfile || null;
      MODE = 'visitor';
      TOKEN = '';
      localStorage.setItem('wui_mode', 'visitor');
      localStorage.setItem('wui_visitor_token', tok);
      localStorage.setItem('wui_visitor_grants', JSON.stringify(grants));
      localStorage.setItem('wui_visitor_preset', preset || '');
      localStorage.setItem('wui_player_profile', JSON.stringify(playerProfile || null));
      localStorage.removeItem('wui_token');
      finish(tok);
      window.dispatchEvent(new CustomEvent('studio:auth'));
    }
    showModal('需要登录', body);
    setMode('admin');
    tokenInput.onkeydown = function(e){ if(e.key === 'Enter') doLogin(); };
    usernameInput.onkeydown = function(e){ if(e.key === 'Enter') doLogin(); };
    pwdInput.onkeydown = function(e){ if(e.key === 'Enter') doLogin(); };
  });
  return authPromise;
}
function showImage(title, url){
  var img = el('img', {src:url, cls:'full'});
  img.onclick = hideModal;
  showModal(title, img);
}

// ---------- API ----------
function api(method, path, body, retried){
  var opts = {method:method, headers:{}};
  if(MODE === 'visitor'){
    // 访客只读：写请求直接拒绝，不发请求（安全兜底，即便某个写按钮漏隐藏也不会真正落盘）。
    // 例外：玩家档（player）允许自己的入世界写操作（/api/player/*）；
    //       所有访客允许改自己的密码（/api/account/password）
    var isPlayerOp = VISITOR_PRESET === 'player' && String(path).indexOf('/api/player') === 0;
    var isPasswordOp = String(path) === '/api/account/password';
    if(method !== 'GET' && !isPlayerOp && !isPasswordOp){
      return Promise.reject(new Error('访客模式为只读，无法执行此操作'));
    }
    if(VISITOR_TOKEN) opts.headers['x-visitor-token'] = VISITOR_TOKEN;
  } else if(TOKEN){
    opts.headers['Authorization'] = 'Bearer ' + TOKEN;
  }
  if(body !== undefined){
    if(body instanceof FormData){ opts.body = body; }
    else if(typeof Blob !== 'undefined' && body instanceof Blob){ opts.headers['Content-Type'] = body.type || 'application/octet-stream'; opts.body = body; }
    else if(typeof body === 'string'){ opts.headers['Content-Type'] = 'application/octet-stream'; opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  return fetch(path, opts).then(function(res){
    if((res.status === 401) && !retried){
      return promptAuth().then(function(t){
        if(t == null) throw new Error('未授权');
        return api(method, path, body, true);
      });
    }
    if(res.status === 403 && !retried){
      // 访客越权访问（无读权限）：提示后不再重试，避免死循环
      throw new Error('无权访问');
    }
    return res.json().then(function(data){
      if(!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    });
  });
}

// 给 img src 之类无法携带 Authorization 头的 URL 附上凭证参数
function withToken(url){
  var sep = url.indexOf('?') >= 0 ? '&' : '?';
  if(MODE === 'visitor'){
    return VISITOR_TOKEN ? url + sep + 'visitor=' + encodeURIComponent(VISITOR_TOKEN) : url;
  }
  return TOKEN ? url + sep + 'token=' + encodeURIComponent(TOKEN) : url;
}

// Studio 提供统一 SSE 和总览刷新；保留管理页的数据失效处理。
var connectSSE, refreshOverview;
function onFileSignal(file){
  if(activeView === 'gallery' && file === 'gallery') loadGallery();
  else if(activeView === 'media' && file === 'media') loadMedia();
  else if(activeView === 'data' && (file === 'notes' || file === 'data' || file === 'archive')) refreshData();
  else if(activeView === 'crossing' && file === 'crossing') refreshCrossing(true);
}

// ---------- 管理页导航兼容层 ----------
// 路由及导航视图由 Studio 注册。
var NAV = [], buildNav;
function visitorCanSee(grants){
  if(MODE !== 'visitor') return true;
  if(!grants || !grants.length) return false;
  // 特殊：玩家入世界入口仅 player 档可见
  if(grants.indexOf('__player__') >= 0) return VISITOR_PRESET === 'player';
  return grants.some(function(g){ return VISITOR_GRANTS.indexOf(g) >= 0; });
}
function isVisitor(){ return MODE === 'visitor'; }
// 从后端同步当前访客会话的最新 grants（管理员改权限后实时生效）；会话失效则退回登录
function syncVisitorGrants(){
  if(MODE !== 'visitor' || !VISITOR_TOKEN) return Promise.resolve();
  return fetch('/api/visitors/me', {headers:{'x-visitor-token': VISITOR_TOKEN}}).then(function(res){
    if(res.status === 401){
      // 会话失效（账号被删/过期）：清凭证并重新登录
      logoutVisitor();
      return promptAuth();
    }
    return res.json().then(function(d){
      if(!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
      VISITOR_GRANTS = d.grants || [];
      VISITOR_PRESET = d.preset || '';
      localStorage.setItem('wui_visitor_grants', JSON.stringify(VISITOR_GRANTS));
      localStorage.setItem('wui_visitor_preset', VISITOR_PRESET);
      buildNav();
      return d;
    });
  }).catch(function(){ /* 网络失败等：保留旧 grants，不打断 */ });
}
function logoutVisitor(){
  MODE = 'admin';
  VISITOR_TOKEN = '';
  VISITOR_GRANTS = [];
  VISITOR_PRESET = '';
  VISITOR_PLAYER_PROFILE = null;
  localStorage.removeItem('wui_mode');
  localStorage.removeItem('wui_visitor_token');
  localStorage.removeItem('wui_visitor_grants');
  localStorage.removeItem('wui_visitor_preset');
  localStorage.removeItem('wui_player_profile');
  document.body.classList.remove('visitor-readonly');
  buildNav();
  switchView('overview');
}
// 访客自助改密码：弹窗填旧密码 + 新密码
function openChangePassword(){
  var oldInp = el('input', {type:'password', placeholder:'当前密码', style:'width:100%'});
  var newInp = el('input', {type:'password', placeholder:'新密码', style:'width:100%'});
  var err = el('p', {style:'color:var(--err);font-size:12.5px;min-height:16px'});
  showModal('修改密码', el('div', null, [
    el('label', {text:'当前密码'}), oldInp,
    el('label', {text:'新密码'}), newInp,
    err,
    el('div', {cls:'toolbar', style:'margin:8px 0 0'}, [
      el('button', {text:'取消', onclick:hideModal}),
      el('button', {cls:'primary', text:'保存', onclick:function(){
        var oldP = oldInp.value;
        var newP = newInp.value;
        if(!oldP){ err.textContent = '请输入当前密码'; return; }
        if(!newP){ err.textContent = '请输入新密码'; return; }
        api('POST', '/api/account/password', {oldPassword: oldP, newPassword: newP}).then(function(){
          hideModal();
          toast('密码已修改', 'ok');
        }).catch(function(e){ err.textContent = e.message || e; });
      }})
    ])
  ]));
  setTimeout(function(){ oldInp.focus(); }, 20);
}
function clearViewTimers(){
  viewTimers.forEach(function(t){ clearInterval(t); });
  viewTimers = [];
}
// Studio 在没有专属模块的管理页调用此 loader；导航状态由 Studio 维护。
function switchView(name){
  var load = {config:loadConfig, prompts:loadPrompts, crossing:loadCrossing,
    gallery:loadGallery, media:loadMedia, data:refreshData, visitors:loadVisitors}[name];
  if(load) load();
  else $('#main').textContent = '页面尚未注册，请从导航选择可用页面。';
}
$('#btn-refresh').onclick = function(){ switchView(activeView); };
$('#btn-menu').innerHTML = icon('menu');
$('#btn-menu').onclick = function(){
  $('#sidebar').classList.toggle('open');
  $('#backdrop').classList.toggle('show', $('#sidebar').classList.contains('open'));
};
$('#backdrop').onclick = closeDrawer;
function closeDrawer(){
  $('#sidebar').classList.remove('open');
  $('#backdrop').classList.remove('show');
}
function viewHead(title, desc){
  var frag = document.createDocumentFragment();
  frag.appendChild(el('div', {cls:'view-head'}, [
    el('h2', {cls:'view-title', text: title}),
    desc ? el('p', {cls:'view-desc', text: desc}) : null
  ]));
  return frag;
}

// ---------- 顶栏 ----------
function renderTopbar(o){
  var st = worldStateText(o);
  var pill = $('#world-pill');
  pill.className = 'pill ' + st[1];
  pill.textContent = st[0];
  $('#tb-clock').textContent = o.clock ? (o.clock.timeLine + (o.clock.syncRealTime ? '' : (' · 1TU=' + o.clock.unitRealSeconds + 's'))) : '';
  $('#tb-extra').textContent = o.bot && o.bot.running ? ('Bot 推理中 · ' + o.bot.streamLength + ' 条 · 队列 ' + o.worldQueue) : '';
  $('#side-ver').textContent = 'v' + (o.version || VERSION);
}
function worldStateText(o){
  if(!o.initialized) return ['未初始化', 'off'];
  if(o.worldRunning) return ['世界运行中', 'run'];
  if(o.clock && !o.clock.syncRealTime) return ['已暂停 · 时间静止', 'pause'];
  return ['未运行 · 时间照常流逝', 'pause'];
}

// ---------- 世界管理操作 ----------
function showErr(err){ toast(String(err && err.message || err), 'err'); }
function worldAction(action, askInit, body){
  var label = {init:'创世', start:'开始', stop:'暂停', reload:'重载定义', reset:'重置', clearmsg:'清空消息', inject:'注入'}[action] || action;
  if(askInit && !body && action==='init'){
    body = {force: false};
    if(!confirm('执行 world.init 创世：将由 World-LLM 依据定义生成初始状态。需要几分钟，继续？')) return;
  }
  api('POST', '/api/world/' + action, body || {}).then(function(r){
    toast((label + '：' + r.text), 'ok');
    refreshOverview(true);
  }).catch(function(err){
    toast((label + '失败：' + (err.message || err)), 'err');
  });
}

// ---------- 配置 ----------
function gotoCfg(gkey){
  cfgGroup = gkey;
  switchView('config');
}
var PRIMARY = {
  bot: ['mode', 'baseURL', 'apiKey', 'model', 'stream'],
  world: ['baseURL', 'apiKey', 'model', 'stream'],
  clock: ['syncRealTime', 'epoch', 'realSecondsPerUnit', 'tingleEveryUnits', 'tingleMode', 'tingleMinUnits', 'tingleMaxUnits'],
  apps: ['chatAppName', 'weatherEnabled', 'weatherDefaultCity', 'browserEnabled', 'phoneResolution', 'phoneShellImage', 'notesEnabled', 'computer'],
  messaging: ['notifyChannels', 'notifyPolicy', 'wakeOnNotify', 'offlineHistory', 'typingCharsPerSec', 'sendDeferFactor']
};
var CFG_ICONS = {root:'sliders', bot:'cpu', world:'gauge', clock:'activity', platformOps:'phone', apps:'monitor', captioners:'image', tts:'film', media:'folder', webui:'sliders', messaging:'edit'};
var PLAT_CATS = [
  ['消息互动', ['recall','react','emojiLikes','reply','forwardMsgs','poke']],
  ['好友与资料', ['handleRequests','listFriends','userInfo','sendLike','profile','modelShow','deleteFriend']],
  ['群信息查询', ['listGroups','groupInfo','listMembers','memberInfo','groupHonor','groupFiles','getGroupNotice']],
  ['群管理（谨慎开启）', ['groupNotice','groupCard','groupName','groupPortrait','essence','essenceList','groupSign','groupBan','groupWholeBan','groupKick','groupAdmin','specialTitle','groupLeave'], true],
  ['其他', []]
];
var PLAT_DANGER = ['deleteFriend','groupKick','groupLeave','groupBan','groupWholeBan'];
function cfgGroupKey(g){
  return g.children && g.children.length === 1 && g.children[0].type === 'object' ? g.children[0].key : 'root';
}

// ---------- 访客账号管理 ----------
var GRANT_LABELS = [
  ['overview','总览'], ['world_status','世界状态'], ['bot_status','Bot 状态'], ['news','新闻'], ['facts','小事记'],
  ['stream','意识流'], ['notes','笔记'], ['gallery','相册/媒体'], ['archive','归档'], ['devices','设备'],
  ['crossing','穿越'], ['definitions','定义文件'], ['config','配置'], ['prompts','提示词'], ['debug','调试(原始请求)'], ['usage','用量']
];
var PRESET_LABELS = { operator:'运维员', viewer:'观众', player:'玩家', custom:'自定义' };
function loadVisitors(){
  if(activeView !== 'visitors') return;
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('访客账号', '创建只读访客账号，分别控制各自可浏览的数据。运维员可看全部（含调试原始请求）但不含 Bot 状态；观众看世界演化产物（含 Bot 状态），屏蔽定义/配置/调试。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/visitors').then(function(r){
    if(activeView !== 'visitors' || !holder.isConnected) return;
    holder.textContent = '';
    renderVisitors(holder, r.visitors || []);
  }).catch(showErr);
}
function renderVisitors(holder, visitors){
  holder.textContent = '';
  // 新增账号
  var addBtn = el('button', {cls:'primary', text:'新增访客账号', onclick:function(){
    openVisitorEditor(null, visitors, function(){ loadVisitors(); });
  }});
  holder.appendChild(addBtn);
  if(!visitors.length){
    holder.appendChild(el('p', {cls:'empty', text:'还没有访客账号。点上方按钮创建。'}));
    return;
  }
  visitors.forEach(function(v){
    var row = el('div', {cls:'fld', style:'display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)'}, [
      el('div', {style:'flex:1'}, [
        el('div', {text:v.username || '(未命名)'}),
        el('div', {style:'font-size:11.5px;color:var(--fg-dark)'}, [
          el('span', {text: PRESET_LABELS[v.preset] + ' · 创建于 ' + fmtTime(v.createdAt)})
        ])
      ]),
      el('button', {text:'编辑', onclick:function(){ openVisitorEditor(v, visitors, function(){ loadVisitors(); }); }}),
      el('button', {text:'删除', onclick:function(){
        if(!confirm('确定删除访客「' + v.username + '」？')) return;
        api('DELETE', '/api/visitors', {id:v.id}).then(function(){ toast('已删除', 'ok'); loadVisitors(); }).catch(showErr);
      }})
    ]);
    holder.appendChild(row);
  });
}
function openVisitorEditor(acct, all, done){
  var isNew = !acct;
  var username = el('input', {placeholder:'用户名', style:'width:100%'});
  var pwd = el('input', {type:'password', placeholder: isNew ? '密码' : '留空则不修改密码', style:'width:100%'});
  var presetSel = el('select', {style:'width:100%'});
  ['operator','viewer','player','custom'].forEach(function(p){
    presetSel.appendChild(el('option', {value:p, text:PRESET_LABELS[p]}));
  });
  // 预设档的可见块（与后端 PRESET_GRANTS 一致）：选择档位时作为「起点」填入勾选
  var PRESET_GRANTS = {
    operator: ['overview','world_status','news','facts','stream','notes','gallery','archive','devices','crossing','definitions','config','prompts','debug','usage'],
    viewer: ['overview','world_status','bot_status','news','facts','stream','notes','gallery','archive','devices','crossing'],
    player: ['overview','world_status','news']
  };
  var grantsBox = el('div', {style:'max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:8px'});
  // 勾选状态：唯一来源。初始按账号已存 grants（custom）或预设档范围播种
  var grantChecks = {};

  function applyPreset(preset){
    GRANT_LABELS.forEach(function(x){ grantChecks[x[0]] = (PRESET_GRANTS[preset] || []).indexOf(x[0]) >= 0; });
  }
  // 初始状态：仅当账号是「自定义」档且存有 grants 时，按 grants 播种；否则按档位预设播种
  var seedPreset;
  if(acct && acct.preset === 'custom' && acct.grants && Object.keys(acct.grants).length){
    GRANT_LABELS.forEach(function(x){ grantChecks[x[0]] = !!acct.grants[x[0]]; });
    seedPreset = 'custom';
  } else {
    seedPreset = (isNew ? 'viewer' : (acct ? acct.preset : 'viewer')) || 'viewer';
    if(seedPreset === 'custom') seedPreset = 'viewer'; // custom 无 grants 时以 viewer 为起点
    applyPreset(seedPreset);
  }
  presetSel.value = seedPreset;
  if(acct) username.value = acct.username || '';

  function renderGrants(){
    grantsBox.textContent = '';
    GRANT_LABELS.forEach(function(x){
      var cb = el('input', {type:'checkbox', checked: !!grantChecks[x[0]]});
      cb.onchange = function(){
        grantChecks[x[0]] = cb.checked;
        // 手动调整 → 档位自动转「自定义」
        presetSel.value = 'custom';
      };
      grantsBox.appendChild(el('label', {style:'display:flex;gap:6px;align-items:center;font-size:12.5px'}, [
        cb,
        el('span', {text:x[1]})
      ]));
    });
  }
  renderGrants();
  presetSel.onchange = function(){
    var p = presetSel.value;
    if(p !== 'custom'){
      // 选预设档 → 用预设范围作为起点覆盖勾选
      applyPreset(p);
      renderGrants();
    }
    // 选「自定义」：保留当前勾选，不做任何覆盖
  };
  var tip = el('p', {cls:'hint', text:'选「运维员」或「观众」会套用对应预设范围作起点；之后手动勾选/取消任意项，档位会变为「自定义」。', style:'font-size:11.5px;color:var(--fg-dark);margin:6px 0 0'});
  var body = el('div', null, [
    el('label', {text:'用户名'}), username,
    el('label', {text: isNew ? '密码' : '新密码（留空不修改）'}), pwd,
    el('label', {text:'档位'}), presetSel,
    el('label', {text:'可浏览的数据块'}), grantsBox, tip,
    el('div', {cls:'toolbar', style:'margin-top:10px'}, [
      el('button', {text:'取消', onclick:hideModal}),
      el('button', {cls:'primary', text:'保存', onclick:function(){
        var preset = presetSel.value;
        var payload = {id: acct ? acct.id : undefined, username: username.value.trim(), preset: preset};
        if(pwd.value) payload.password = pwd.value;
        if(preset === 'custom') payload.grants = grantChecks;
        var req = acct ? {method:'PUT', path:'/api/visitors'} : {method:'POST', path:'/api/visitors'};
        api(req.method, req.path, payload).then(function(){ toast('已保存', 'ok'); hideModal(); done(); }).catch(showErr);
      }})
    ])
  ]);
  showModal(isNew ? '新增访客账号' : '编辑访客账号', body);
}

function loadConfig(){
  if(activeView !== 'config') return;
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('配置', isVisitor() ? '只读模式：可浏览配置，无法修改。' : '按重要程度分层：常用项直接展开，高级项收起。保存后写入配置文件并重启插件作用域（世界自动恢复运行）。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/config').then(function(r){
    if(activeView !== 'config' || !holder.isConnected) return;
    schemaCache = r.schema;
    cfgCache = r.value;
    cfgPortOriginal = r.value && r.value.webui ? Number(r.value.webui.port) : null;
    cfgDirty = false;
    if(!cfgGroup) cfgGroup = cfgGroupKey((schemaCache.children || [])[0] || {});
    holder.textContent = '';
    holder.appendChild(renderConfigShell());
    renderCfgBody(); // 外壳已挂载，此时 #cfg-body 可被全局查询到
    // 访客只读：整个配置容器禁止交互（不逐个禁用字段/按钮，用 pointer-events 兜底）
    if(isVisitor()){
      var cfgBody = $('#cfg-body');
      if(cfgBody){ cfgBody.style.pointerEvents = 'none'; cfgBody.style.opacity = '0.85'; }
    }
  }).catch(showErr);
}
function renderConfigShell(){
  var groups = schemaCache.children || [];
  var wrap = el('div');
  // 搜索
  var search = el('input', {placeholder:'搜索配置项（名称或描述）…', id:'cfg-q'});
  search.value = cfgSearch;
  search.oninput = function(){ cfgSearch = search.value; renderCfgBody(); };
  wrap.appendChild(el('div', {cls:'cfg-search'}, [search]));
  var grid = el('div', {cls:'cfg-wrap'});
  // 组导航
  var navBox = el('div', {cls:'cfg-nav', id:'cfg-nav'});
  renderCfgNav(navBox, groups);
  grid.appendChild(navBox);
  grid.appendChild(el('div', {id:'cfg-body'}));
  wrap.appendChild(grid);
  wrap.appendChild(renderSaveBar());
  return wrap;
}
function renderCfgNav(navBox, groups){
  navBox.textContent = '';
  groups.forEach(function(g){
    var gkey = cfgGroupKey(g);
    var a = el('a', {cls: gkey === cfgGroup ? 'active' : ''});
    a.appendChild(el('span', {cls:'n', text: g.description || gkey}));
    a.onclick = function(){ cfgGroup = gkey; cfgSearch = ''; var q = $('#cfg-q'); if(q) q.value = ''; renderCfgBody(); renderCfgNav(navBox, groups); };
    navBox.appendChild(a);
  });
}
function renderCfgBody(){
  if(activeView !== 'config') return;
  var body = $('#cfg-body');
  if(!body || !schemaCache) return;
  body.textContent = '';
  var groups = schemaCache.children || [];
  if(cfgSearch.trim()){
    body.appendChild(renderCfgSearch(cfgSearch.trim().toLowerCase(), groups));
    return;
  }
  var group = null;
  groups.forEach(function(g){ if(cfgGroupKey(g) === cfgGroup) group = g; });
  if(!group) group = groups[0];
  if(!group){ body.appendChild(el('p', {cls:'empty', text:'（无配置组）'})); return; }
  var gkey = cfgGroupKey(group);
  var sec = el('div', {cls:'section'});
  sec.appendChild(el('h3', {text: group.description || '配置'}));
  var sbody = el('div', {cls:'body'});
  if(gkey === 'platformOps'){
    sbody.appendChild(renderPlatformOps(group.children[0]));
  } else if(gkey === 'root'){
    (group.children || []).forEach(function(node){
      sbody.appendChild(renderField(node, [node.key], getPath(cfgCache, [node.key])));
    });
  } else {
    var top = group.children[0];
    var kids = top.children || [];
    var primaryKeys = PRIMARY[gkey];
    var pri = [], adv = [];
    kids.forEach(function(c){
      if(!primaryKeys || primaryKeys.indexOf(c.key) >= 0) pri.push(c);
      else adv.push(c);
    });
    pri.forEach(function(c){ sbody.appendChild(renderField(c, [gkey, c.key], getPath(cfgCache, [gkey, c.key]))); });
    if(adv.length){
      var det = el('details', {cls:'adv'});
      det.appendChild(el('summary', {text:'高级设置（' + adv.length + ' 项）'}));
      var ab = el('div', {cls:'body'});
      adv.forEach(function(c){ ab.appendChild(renderField(c, [gkey, c.key], getPath(cfgCache, [gkey, c.key]))); });
      det.appendChild(ab);
      sbody.appendChild(det);
    }
  }
  sec.appendChild(sbody);
  body.appendChild(sec);
}
function renderCfgSearch(q, groups){
  var out = el('div', {cls:'section'});
  out.appendChild(el('h3', {text:'搜索：' + q}));
  var sbody = el('div', {cls:'body'});
  var found = [];
  groups.forEach(function(g){
    var gkey = cfgGroupKey(g);
    (g.children || []).forEach(function(c){ walkFields(c, [c.key], found, g.description || gkey); });
  });
  var matches = found.filter(function(f){
    var text = (f.path.join('.') + ' ' + (f.node.description || '')).toLowerCase();
    return text.indexOf(q) >= 0;
  });
  if(!matches.length){
    sbody.appendChild(el('p', {cls:'empty', text:'（没有匹配的配置项）'}));
  }
  matches.slice(0, 60).forEach(function(f){
    var box = el('div', {style:'margin-bottom:4px'});
    box.appendChild(el('div', {cls:'crumb', text: f.group + ' › ' + f.path.join('.')}));
    box.appendChild(renderField(f.node, f.path, getPath(cfgCache, f.path)));
    sbody.appendChild(box);
  });
  out.appendChild(sbody);
  return out;
}
function walkFields(node, path, out, groupLabel){
  if(node.type === 'object'){
    (node.children || []).forEach(function(c){ walkFields(c, path.concat(c.key), out, groupLabel); });
    return;
  }
  if(node.type === 'intersect'){
    (node.children || []).forEach(function(c){ walkFields(c, path, out, groupLabel); });
    return;
  }
  out.push({node: node, path: path, group: groupLabel});
}
function renderPlatformOps(node){
  var frag = document.createDocumentFragment();
  frag.appendChild(el('p', {cls:'empty', style:'padding:0 0 8px', text:'聊天平台扩展操作：默认全部关闭。开启后 Bot 获得对应的平台工具（标注 ［…］为底层 OneBot 接口）。'}));
  var byKey = {};
  (node.children || []).forEach(function(c){ byKey[c.key] = c; });
  var used = {};
  PLAT_CATS.forEach(function(cat){
    var keys = cat[1].filter(function(k){ return byKey[k]; });
    keys.forEach(function(k){ used[k] = true; });
    if(cat[0] === '其他'){
      Object.keys(byKey).forEach(function(k){ if(!used[k]){ keys.push(k); used[k] = true; } });
    }
    if(!keys.length) return;
    frag.appendChild(el('div', {cls:'plat-cat' + (cat[2] ? ' danger' : ''), text: cat[0]}));
    var grid = el('div', {cls:'grid-booleans'});
    keys.forEach(function(k){
      grid.appendChild(boolSwitch(byKey[k], ['platformOps', k], PLAT_DANGER.indexOf(k) >= 0 || !!cat[2]));
    });
    frag.appendChild(grid);
  });
  return frag;
}
function boolSwitch(node, path, danger){
  var value = !!getPath(cfgCache, path);
  var row = el('label', {cls:'sw-row' + (danger ? ' danger' : '')});
  var sw = el('span', {cls:'sw'});
  var cb = el('input', {type:'checkbox'});
  cb.checked = value;
  cb.onchange = function(){ setPath(cfgCache, path, cb.checked); };
  sw.appendChild(cb);
  sw.appendChild(el('i'));
  row.appendChild(sw);
  row.appendChild(el('span', {cls:'tx'}, [
    el('div', {cls:'n', text: node.key}),
    el('div', {cls:'d', text: node.description || ''})
  ]));
  return row;
}
function renderSaveBar(){
  var bar = el('div', {cls:'cfg-savebar', id:'cfg-savebar'});
  updateSaveBar(bar);
  return bar;
}
function updateSaveBar(bar){
  bar = bar || $('#cfg-savebar');
  if(!bar) return;
  bar.textContent = '';
  if(isVisitor()){
    bar.appendChild(el('span', {style:'font-size:12.5px;color:var(--fg-dark)', text:'只读模式 · 配置不可修改'}));
    return;
  }
  bar.appendChild(el('span', {id:'cfg-dirty-dot', cls:'dirty-dot', style: cfgDirty ? '' : 'visibility:hidden'}));
  bar.appendChild(el('span', {style:'font-size:12.5px;color:var(--fg-dim)', text: cfgDirty ? '有未保存的修改' : '已保存的状态'}));
  bar.appendChild(el('span', {cls:'spacer'}));
  if(cfgDirty) bar.appendChild(el('button', {text:'放弃修改', onclick:function(){ cfgDirty = false; loadConfig(); }}));
  bar.appendChild(el('button', {cls:'primary', text:'保存并应用', onclick: saveConfig}));
}
function markCfgDirty(){
  if(!cfgDirty){ cfgDirty = true; updateSaveBar(); }
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
          el('span', {text: '#' + i, style:'color:var(--fg-dark);font-size:11px'}),
          el('span', {style:'flex:1'}),
          el('button', {cls:'danger', text:'删除', style:'padding:2px 9px;font-size:11.5px', onclick:function(){
            var a2 = getPath(cfgCache, path) || [];
            a2.splice(i,1); setPath(cfgCache, path, a2);
            renderItems();
          }})
        ]);
        itemEl.appendChild(row);
        if(node.inner && node.inner.type === 'object'){
          var innerBody = el('div', {style:'margin-top:8px'});
          (node.inner.children || []).forEach(function(c){
            innerBody.appendChild(renderField(c, path.concat(i, c.key), getPath(cfgCache, path.concat(i, c.key))));
          });
          itemEl.appendChild(innerBody);
        } else if(node.inner){
          itemEl.appendChild(renderInput(node.inner, path.concat(i), item));
        }
        list.appendChild(itemEl);
      });
      ctl.appendChild(list);
      ctl.appendChild(el('button', {text:'+ 添加一项', style:'margin-top:2px', onclick:function(){
        var a3 = getPath(cfgCache, path) || [];
        a3.push(defaultFor(node.inner)); setPath(cfgCache, path, a3);
        renderItems();
      }}));
    }
    renderItems();
    box.appendChild(ctl);
    return box;
  }
  if(t === 'boolean'){
    return boolSwitch(node, path, false);
  }
  var box2 = el('div', {cls:'fld'});
  box2.appendChild(el('div', {cls:'lbl'}, [el('div', {cls:'name', text: path[path.length-1]}), el('div', {cls:'desc', text: node.description || ''})]));
  var ctl2 = el('div', {cls:'ctl'});
  ctl2.appendChild(renderInput(node, path, value));
  if(isModelField(path)){
    ctl2.appendChild(el('div', {style:'margin-top:4px'}, [el('button', {text:'获取模型列表', style:'font-size:11px;padding:2px 8px', onclick:function(){
      fetchModelsFor(path, this);
    }})]));
  }
  if(node.role !== 'secret' && node.default !== undefined && t !== 'const'){
    ctl2.appendChild(el('div', {style:'margin-top:4px'}, [el('button', {text:'重置为默认', style:'font-size:11px;padding:2px 8px', onclick:function(){
      var v = JSON.parse(JSON.stringify(node.default)); setPath(cfgCache, path, v); ctl2.textContent=''; ctl2.appendChild(renderInput(node, path, v));
    }})]));
  }
  box2.appendChild(ctl2);
  return box2;
}
function renderInput(node, path, value){
  var t = node.type;
  if(t === 'boolean'){
    var sw = el('span', {cls:'sw'});
    var cb = el('input', {type:'checkbox'});
    cb.checked = !!value;
    cb.onchange = function(){ setPath(cfgCache, path, cb.checked); };
    sw.appendChild(cb);
    sw.appendChild(el('i'));
    return sw;
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
      var chosen = (node.options || [])[sel.selectedIndex];
      setPath(cfgCache, path, chosen ? chosen.value : sel.value);
    };
    return sel;
  }
  if(t === 'const'){
    return el('span', {text: String(value), style:'color:var(--fg-dim)'});
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
        var row = el('div', {style:'display:flex;gap:6px;margin-bottom:5px'});
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
  if(node.role === 'textarea'){
    var ta = el('textarea', {rows: Math.max(4, Math.min(20, String(value||'').split(NL).length + 1))});
    ta.value = value || '';
    ta.oninput = function(){ setPath(cfgCache, path, ta.value); };
    return ta;
  }
  var inp = el('input', {type: node.role === 'secret' ? 'password' : 'text', value: value == null ? '' : value});
  if(node.role === 'secret'){
    var isMasked = value === '******';
    var wrap = el('div', {style:'display:flex;gap:6px;align-items:center'});
    if(isMasked){
      // 已设置的密钥不落地到输入框：留空 = 保持不变，输入新值 = 替换
      inp.type = 'password';
      inp.value = '';
      inp.placeholder = '已设置（留空保持不变，输入新值替换）';
      inp.style.flex = '1';
    }
    wrap.appendChild(inp);
    if(!isMasked){
      wrap.appendChild(el('button', {text:'显示', onclick:function(){ inp.type = inp.type === 'password' ? 'text' : 'password'; }}));
    }
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
function isModelField(path){
  var last = path[path.length - 1];
  if(last !== 'model') return false;
  for(var i = path.length - 1; i >= 0; i--){
    if(path[i] === 'bot' || path[i] === 'world') return true;
  }
  return false;
}
function fetchModelsFor(path, btn){
  if(!cfgCache) return;
  var parent = path.slice(0, path.length - 1);
  var baseURL = getPath(cfgCache, parent.concat('baseURL'));
  var apiKey = getPath(cfgCache, parent.concat('apiKey')) || '';
  if(!baseURL){ toast('请先填写该组的 baseURL', 'warn'); return; }
  var old = btn.textContent;
  btn.textContent = '加载中…';
  btn.disabled = true;
  // apiKey 可能已被脱敏（******）：把 group 路径一并传给后端，由后端按未改动时回填真实密钥
  api('POST', '/api/llm/models', {baseURL: baseURL, apiKey: apiKey, group: parent.join('.')}).then(function(r){
    if(activeView !== 'config' || !btn.isConnected) return;
    var models = r.models || [];
    if(!models.length){ toast('该端点未返回模型列表', 'warn'); return; }
    var current = getPath(cfgCache, path);
    var select = el('select', {style:'width:100%'});
    models.forEach(function(m){
      select.appendChild(el('option', {text: m, value: m}));
      if(m === current) select.selectedIndex = select.options.length - 1;
    });
    var body = el('div', null, [
      el('p', {text:'选择要使用的模型：', style:'color:var(--fg-dim);font-size:13px'}),
      select,
      el('div', {cls:'toolbar'}, [
        el('button', {text:'取消', onclick: function(){ hideModal(); }}),
        el('button', {cls:'primary', text:'确定', onclick: function(){
          setPath(cfgCache, path, select.value);
          cfgDirty = true;
          hideModal();
          toast('已选择模型：' + select.value, 'ok');
          renderCfgBody();
        }})
      ])
    ]);
    showModal('选择模型', body);
  }).catch(function(err){ toast('获取模型列表失败：' + (err.message || err), 'err'); })
    .finally(function(){
      btn.textContent = old;
      btn.disabled = false;
    });
}
function saveConfig(){
  var newPort = cfgCache.webui ? Number(cfgCache.webui.port) : null;
  api('POST', '/api/config', {config: cfgCache}).then(function(r){
    if(r.error) throw new Error(r.error);
    cfgDirty = false;
    toast('配置已保存并应用，插件作用域正在重启…', 'ok');
    // 端口变更判定：与「保存前的配置端口」比较，而不是与浏览器地址栏比较——
    // 经反向代理/域名访问时 location.port 与内部端口无关，误判会把用户跳去打不开的地址
    var portChanged = newPort && cfgPortOriginal && newPort !== cfgPortOriginal;
    if(portChanged && Number(location.port) === cfgPortOriginal){
      // 直连访问（地址栏端口 = 旧配置端口）：跳转到新端口
      toast('WebUI 端口已变更为 ' + newPort + '，即将跳转…', 'warn');
      setTimeout(function(){ location.href = location.protocol + '//' + location.hostname + ':' + newPort + '/'; }, 1200);
    } else if(portChanged){
      // 经代理/域名访问：不动地址，提醒用户自己更新反代目标
      toast('WebUI 端口已变更为 ' + newPort + '。你正通过代理/域名访问，请同步更新反向代理的目标端口。', 'warn');
      setTimeout(function(){ refreshOverview(false); }, 1500);
    } else {
      setTimeout(function(){ refreshOverview(false); }, 1500);
    }
    if(newPort) cfgPortOriginal = newPort;
  }).catch(function(err){ toast('保存失败：' + (err.message || err), 'err'); });
}

// ---------- 提示词 ----------
function loadPrompts(){
  if(activeView !== 'prompts') return;
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('提示词', isVisitor() ? '只读模式：可浏览提示词，无法修改。' : '改写内置提示词（Bot 行为准则 / World 任务模板），保存后用于后续生成。这里只列实际使用的模板；旧世界工具模板已停用，首次保存时旧覆盖会备份为 prompts.legacy.json。带 {{变量}} 的是占位符。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/prompts').then(function(r){
    if(activeView !== 'prompts' || !holder.isConnected) return;
    promptsDefaults = r.defaults;
    overridesCache = r.overrides;
    holder.textContent = '';
    holder.appendChild(promptGroup('Bot-LLM · 行为准则', r.defaults.bot, r.overrides.bot, 'bot'));
    holder.appendChild(promptGroup('World-LLM · 系统提示与任务模板', r.defaults.world, r.overrides.world, 'world'));
    if(!isVisitor()){
      holder.appendChild(el('div', {cls:'toolbar'}, [
        el('button', {cls:'primary', text:'保存', onclick: savePrompts}),
        el('span', {style:'color:var(--fg-dark);font-size:12px', text:'仅保存与默认不同的项'})
      ]));
    }
  }).catch(showErr);
}
function promptGroup(title, defaults, current, prefix){
  var sec = el('div', {cls:'section'});
  sec.appendChild(el('h3', {text:title}));
  var body = el('div', {cls:'body'});
  Object.keys(defaults).forEach(function(key){
    var fld = el('div', {cls:'fld'});
    fld.appendChild(el('div', {cls:'lbl'}, [el('div', {cls:'name', text:key}), el('div', {cls:'desc', html: descOf(key, prefix)})]));
    var ctl = el('div', {cls:'ctl'});
    var ta = el('textarea', {rows: Math.min(24, String(defaults[key]).split(NL).length + 2)});
    ta.value = current[key] !== undefined ? current[key] : defaults[key];
    if(isVisitor()) ta.readOnly = true;
    var overBadge = el('span', {style:'font-size:11px'});
    function paint(){
      var overridden = ta.value !== defaults[key];
      overBadge.textContent = overridden ? '已覆盖' : '';
      overBadge.style.color = overridden ? 'var(--warn)' : 'var(--fg-dark)';
    }
    ta.oninput = paint;
    paint();
    ctl.appendChild(ta);
    ctl.appendChild(el('div', {cls:'toolbar', style:'margin:4px 0 0'}, isVisitor() ? [overBadge, el('span', {cls:'spacer'})] : [
      overBadge,
      el('span', {cls:'spacer'}),
      el('button', {text:'恢复默认', style:'font-size:11px;padding:2px 8px', onclick:function(){ ta.value = defaults[key]; paint(); }})
    ]));
    fld.appendChild(ctl);
    body.appendChild(fld);
  });
  sec.appendChild(body);
  return sec;
}
function descOf(key, prefix){
  var map = {
    bot: {
      conversation: '私聊与群聊 · 对话对象、参与分寸与媒体理解',
      constitutionHead: '行为准则开头段（原生工具调用协议的前言）',
      outputFormatNative: '输出格式段 · 原生协议（function calling）',
      outputFormatText: '输出格式段 · 正文 JSON 协议（nativeToolCalls 关闭时）',
      constitution: '输出格式之后的通用规则（事件/电脑/媒体/手机/身份/心态等大段）',
      lifestyleWithWait: '心态段收尾（有 wait 工具时）',
      lifestyleNoWait: '心态段收尾（wait 被移除时）'
    },
    world: {
      adjudicationSystem: '结构化世界裁定 · system。只声明 propose_world；世界规则、快照和任务由运行时附加。',
      presentationSystem: '只读界面呈现 · system。只接收角色观测，无工具和写入权限。',
      compressSystem: '上下文压缩 · system',
      compressUser: '上下文压缩 · user。{{timeLine}} {{persona}} {{historySummary}} {{memoryDigest}} {{streamText}}',
      assessRealWorldSystem: '世界性质判定 · system',
      assessRealWorldUser: '世界性质判定 · user。{{worldDef}}',
      generateCalendarSystem: '历法生成 · system',
      generateCalendarUser: '历法生成 · user。{{worldDef}} {{epoch}} {{unitWorldSeconds}}',
      phoneSpecSystem: '手机屏幕规格判定 · system（apps.phoneResolution 为 auto 时创世调用）',
      phoneSpecUser: '手机屏幕规格判定 · user。{{botDef}} {{worldDef}}',
      phoneShellSystem: '浏览器带壳截图外壳生成 · system（创世调用）',
      phoneShellUser: '带壳截图外壳生成 · user。{{botDef}} {{worldDef}} {{width}} {{height}}；生成的 HTML 里保留 {{screen}} {{url}} {{time}} 占位符',

    }
  };
  return map[prefix][key] || '';
}
function savePrompts(){
  var overrides = {bot:{}, world:{}};
  var groups = document.querySelectorAll('#main .section');
  collectOverrides(groups[0], promptsDefaults.bot, 'bot', overrides);
  collectOverrides(groups[1], promptsDefaults.world, 'world', overrides);
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

// ---------- 设定与记录编辑组件（由 Studio 组合） ----------
function statePane(id, title, content, url){
  var sec = el('div', {cls:'section', 'data-pane': id});
  var ta = el('textarea', {rows: 16});
  ta.value = content;
  var projection = id === 'bot' || id === 'world';
  if(isVisitor() || projection) ta.readOnly = true;
  sec.appendChild(el('h3', {html: esc(title) + ' <span class="hint">' + (projection ? '只读状态视图' : isVisitor() ? '只读' : '整体覆盖，保存后实时生效') + '</span>'}));
  var body = el('div', {cls:'body'}, [ta]);
  if(!isVisitor() && !projection){
    body.appendChild(el('div', {cls:'toolbar'}, [el('button', {cls:'primary', text:'保存', onclick:function(){
      api('PUT', url, {content: ta.value}).then(function(){ toast(title + ' 已保存', 'ok'); }).catch(showErr);
    }})]));
  }
  sec.appendChild(body);
  return sec;
}
function phoneShellPane(shellHtml, meta){
  var sec = el('div', {cls:'section', 'data-pane':'shell'});
  sec.appendChild(el('h3', {html:'手机外壳 <span class="hint">浏览器带壳截图的外壳 HTML（含 {{screen}} 等占位符），下方为预览；源码标签页可编辑</span>'}));
  var body = el('div', {cls:'body'});
  // 预览 iframe：用样本值替换占位符，展示外壳布局效果
  var preview = el('iframe', {sandbox:'', referrerpolicy:'no-referrer', style:'width:100%;height:560px;border:1px solid var(--line);border-radius:10px;background:#fff'});
  function renderPreview(){
    var html = shellHtml || '';
    if(!html.trim()){
      preview.srcdoc = '<div style="font-family:sans-serif;color:#888;display:flex;align-items:center;justify-content:center;height:100%">（还没有外壳 HTML——创世或手动编辑后在此预览）</div>';
      return;
    }
    var w = meta.phone && meta.phone.width ? meta.phone.width : 800;
    var h = meta.phone && meta.phone.height ? meta.phone.height : 1280;
    var sample = html
      .replace(/\{\{\s*screen\s*\}\}/g, SCREEN_PLACEHOLDER)
      .replace(/\{\{\s*url\s*\}\}/g, 'https://example.com/')
      .replace(/\{\{\s*title\s*\}\}/g, '示例网页标题')
      .replace(/\{\{\s*time\s*\}\}/g, '12:34')
      .replace(/\{\{\s*width\s*\}\}/g, String(w))
      .replace(/\{\{\s*height\s*\}\}/g, String(h));
    // 外壳来自模型：禁脚本、导航、表单和外部资源，只允许内嵌样式/图像。
    var policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";
    preview.srcdoc = '<meta http-equiv="Content-Security-Policy" content="' + policy + '">' + sample;
  }
  // 源码编辑（textarea）+ 保存
  var ta = el('textarea', {rows:16, style:'width:100%;font-family:var(--mono);font-size:12px;margin-top:8px'});
  ta.value = shellHtml || '';
  if(isVisitor()) ta.readOnly = true;
  body.appendChild(el('div', {cls:'toolbar', style:'margin-bottom:8px'}, isVisitor() ? [] : [
    el('button', {text:'刷新预览', onclick:function(){ shellHtml = ta.value; renderPreview(); }}),
    el('span', {cls:'spacer'}),
    el('button', {cls:'primary', text:'保存外壳', onclick:function(){
      api('PUT', '/api/state/phone-shell', {content: ta.value}).then(function(){ shellHtml = ta.value; renderPreview(); toast('手机外壳已保存', 'ok'); }).catch(showErr);
    }})
  ]));
  body.appendChild(preview);
  body.appendChild(el('div', {style:'margin-top:10px'}, [
    el('div', {text:'源码（编辑后点“刷新预览”查看效果、点“保存外壳”落盘）：', style:'color:var(--fg-dim);font-size:12px;margin-bottom:6px'}),
    ta
  ]));
  renderPreview();
  sec.appendChild(body);
  return sec;
}
function jsonlPane(title, hint, items, urlBase, placeholder, opts){
  opts = opts || {};
  var sec = el('div', {cls:'section', 'data-pane': urlBase.split('/').pop()});
  sec.appendChild(el('h3', {html: title + ' <span class="hint">' + hint + '</span>'}));
  var body = el('div', {cls:'body'});
  var list = el('div');
  // 显示顺序：可排序时默认时间倒序（最新在前），可切换为正序
  var order = opts.sortable ? 'desc' : 'asc';
  // 当前展示序列：{i: 原始下标, n: 条目}
  function ordered(){
    var arr = [];
    items.forEach(function(n, i){ arr.push({i: i, n: n}); });
    if(order === 'desc') arr.reverse();
    return arr;
  }
  function render(){
    list.textContent = '';
    if(!items.length){
      list.appendChild(el('p', {cls:'empty', text:'（暂无内容）'}));
      return;
    }
    ordered().forEach(function(e){
      var n = e.n, i = e.i;
      var it = el('div', {cls:'news-item'});
      var ta = el('textarea', {rows: 2});
      ta.value = n.content;
      if(isVisitor()) ta.readOnly = true;
      it.appendChild(el('span', {cls:'clock', text:'[' + n.clock + ']  T=' + Number(n.t).toFixed(1)}));
      if(n.pinned){
        it.appendChild(el('span', {cls:'tag', style:'margin-left:6px;color:var(--warn);border-color:rgba(251,191,36,.45)', text:'已固定'}));
      }
      it.appendChild(ta);
      // 详情正文 / 来源链接（World 摘编的 detail，或现实新闻的原始 link）
      var hasDetail = (n.detail && String(n.detail).trim()) || n.link;
      if(hasDetail){
        var detBtn = el('button', {text:'查看详情', style:'font-size:11.5px;padding:2px 9px;margin:4px 0 0;display:inline-flex'});
        var detBox = el('div', {style:'display:none;margin-top:6px;padding:8px 10px;background:var(--panel);border-radius:8px;border:1px solid var(--line)'});
        detBtn.onclick = function(){
          var open = detBox.style.display !== 'none';
          detBox.style.display = open ? 'none' : 'block';
          detBtn.textContent = open ? '查看详情' : '收起详情';
        };
        var detLines = [];
        if(n.detail && String(n.detail).trim()) detLines.push(el('div', {text: String(n.detail).trim(), cls:'news-detail'}));
        if(n.link) detLines.push(el('div', {style:'margin-top:6px'}, [
          el('a', {href: n.link, target:'_blank', rel:'noopener', text: n.link, style:'font-size:11.5px;word-break:break-all;color:var(--info)'})
        ]));
        detBox.append.apply(detBox, detLines);
        it.appendChild(detBtn);
        it.appendChild(detBox);
      }
      if(!isVisitor()){
        it.appendChild(el('div', {cls:'toolbar', style:'margin:4px 0 0'}, [
          el('button', {text:'保存修改', onclick:function(){
            api('PUT', urlBase, {index:i, content: ta.value}).then(function(){ items[i].content = ta.value; toast('已保存', 'ok'); }).catch(showErr);
          }}),
          el('button', {cls:'danger', text:'删除', onclick:function(){
            if(!confirm('删除这条？')) return;
            api('DELETE', urlBase + '?index=' + i).then(function(){ items.splice(i,1); render(); }).catch(showErr);
          }}),
          opts.pinnable ? el('div', {style:'display:flex;align-items:center;gap:6px;flex-wrap:wrap'}, [
            el('button', {cls: n.pinned ? 'primary' : '', title: n.pinned ? '取消固定：这条将不再作为「重要回忆」特别保留，重置/创世时可能被清除' : '固定这条：它将成为 Bot 心中的重要回忆（用 recall 时更该记得、角色扮演不 OOC 的依据），且重置/创世后仍然保留', text: n.pinned ? '取消固定' : '固定', onclick:function(){
              api('POST', urlBase + '/pin', {index: i, pinned: !n.pinned}).then(function(){ n.pinned = !n.pinned; toast(n.pinned ? '已固定（成为重要回忆，重置/创世后保留）' : '已取消固定', 'ok'); render(); }).catch(showErr);
            }}),
            el('span', {style:'font-size:11.5px;color:var(--fg-dim)', text: n.pinned ? '重要回忆 · 重置保留' : '固定=Bot 的重要回忆，重置/创世也保留'})
          ]) : null
        ]));
      }
      list.appendChild(it);
    });
  }
  render();
  var addInp = el('input', {placeholder: placeholder, style:'flex:1'});
  var addBar = el('div', {cls:'toolbar'});
  if(opts.sortable){
    var orderBtn = el('button', {text: order === 'desc' ? '时间倒序' : '时间正序', title:'切换显示顺序（倒序 = 最新在前）', onclick:function(){
      order = order === 'desc' ? 'asc' : 'desc';
      orderBtn.textContent = order === 'desc' ? '时间倒序' : '时间正序';
      render();
    }});
    addBar.appendChild(orderBtn);
  }
  // 访客只读：不渲染「追加」输入与按钮（排序切换仍保留）
  if(!isVisitor()){
    addBar.appendChild(addInp);
    addBar.appendChild(el('button', {cls:'primary', text:'追加', onclick:function(){
      var v = addInp.value.trim();
      if(!v) return;
      api('POST', urlBase, {content: v}).then(function(){ addInp.value=''; switchView('state'); }).catch(showErr);
    }}));
  }
  if(addBar.children.length) body.appendChild(addBar);
  body.appendChild(list);
  sec.appendChild(body);
  return sec;
}
// ---------- 穿越（联机） ----------
function loadCrossing(){
  if(activeView !== 'crossing') return;
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('穿越（联机）', 'Bot 前往其他用户的世界作客，或用邀请码接待来访的异世界 Bot。网络上只传输任务与事件文本，绝不传输 API 地址或密钥。'));
  var holder = el('div', {id:'crossing-root'}, [el('p', {cls:'empty', text:'加载中…'})]);
  main.appendChild(holder);
  refreshCrossing();
  viewTimers.push(setInterval(function(){
    if(activeView !== 'crossing') return;
    refreshCrossing(true);
  }, 8000));
}
function refreshCrossing(silent){
  if(activeView !== 'crossing') return;
  var holder = $('#crossing-root');
  api('GET', '/api/crossing').then(function(r){
    if(!holder || !holder.isConnected || activeView !== 'crossing') return;
    holder.textContent = '';
    holder.appendChild(renderCrossing(r));
  }).catch(function(err){ if(!silent) showErr(err); });
}
function renderCrossing(c){
  var wrap = el('div');
  var worlds = c.configuredWorlds || [];
  var visitors = c.visitors || [];
  var invites = c.invites || [];
  // 状态卡片
  wrap.appendChild(el('div', {cls:'cards'}, [
    crossingCard('Bot 所在', c.location ? '异世界「' + c.location + '」' : '自己的世界', !!c.location),
    crossingCard('接待服务', c.server && c.server.running ? '接待中' : (c.server && c.server.enabled ? '未运行' : '未开启'), c.server && c.server.running),
    crossingCard('在场访客', visitors.length ? String(visitors.length) + ' 位' : '无', visitors.length > 0),
    crossingCard('可去的世界', worlds.length ? String(worlds.length) + ' 个' : '未配置', false)
  ]));

  // ---- 前往异世界 ----
  var goSec = el('div', {cls:'section'});
  goSec.appendChild(el('h3', {html:'前往异世界 <span class="hint">这里是强制送往（无视「允许主动前往」开关）；Bot 也可以自己用 travel 工具过去</span>'}));
  var goBody = el('div', {cls:'body'});
  if(c.location){
    goBody.appendChild(el('div', {cls:'toolbar', style:'margin:0 0 10px'}, [
      el('span', {text:'Bot 正在「' + c.location + '」作客。', style:'font-size:12.5px'}),
      el('span', {cls:'spacer'}),
      el('button', {cls:'primary', text:'送回自己的世界', onclick:function(){ crossingTravel('home', '送回'); }})
    ]));
  }
  if(!worlds.length){
    goBody.appendChild(el('p', {cls:'empty', text:'还没有配置任何可去的世界。拿到别人分享的邀请码后，在配置 crossing.worlds 里添加：世界名、对方服务地址（http://主机:端口）、邀请码。'}));
    if(!isVisitor()) goBody.appendChild(el('button', {text:'前往配置', onclick:function(){ gotoCfg('crossing'); }}));
  } else {
    worlds.forEach(function(w){
      var flags = [];
      if(!w.allowVoluntary) flags.push('Bot 不可主动前往');
      if(!w.hasCode) flags.push('缺少邀请码');
      if(!String(w.url||'').trim()) flags.push('缺少地址');
      var canGo = w.hasCode && String(w.url||'').trim() && c.location !== w.name;
      goBody.appendChild(el('div', {cls:'kv'}, [
        el('span', {cls:'k'}, [
          el('span', {text: w.name || '（未命名）', style:'color:var(--fg);font-size:13px'}),
          el('span', {text: (w.note ? ' · ' + w.note : '') + (flags.length ? ' · ' + flags.join('，') : ''), style: flags.length ? 'color:var(--warn);font-size:11.5px' : 'color:var(--fg-dark);font-size:11.5px'})
        ]),
        el('span', {cls:'v'}, [
          c.location === w.name
            ? el('span', {text:'Bot 在这里', style:'color:var(--ok);font-size:12px'})
            : (isVisitor() ? el('span', {text: canGo ? '可前往' : flags.join('，') || '不可前往', style:'color:var(--fg-dark);font-size:12px'}) : (function(){
                var attrs = {text:'送往', onclick:function(){
                  if(!confirm('把 Bot 强制送往「' + w.name + '」？')) return;
                  crossingTravel(w.name, '穿越');
                }};
                if(!canGo) attrs.disabled = 'disabled';
                return el('button', attrs);
              })())
        ])
      ]));
    });
  }
  goSec.appendChild(goBody);
  wrap.appendChild(goSec);

  // ---- 接待来访 ----
  var hostSec = el('div', {cls:'section'});
  hostSec.appendChild(el('h3', {html:'接待来访 <span class="hint">把邀请码分享给别的用户，对方的 Bot 便可穿越到你的世界</span>'}));
  var hostBody = el('div', {cls:'body'});
  if(!(c.server && c.server.enabled)){
    hostBody.appendChild(el('p', {cls:'empty', text:'接待服务未开启。开启 crossing.serverEnabled 后，你的世界会开放给持有邀请码的访客（来访 Bot 的行动由你的 World-LLM 裁定）。'}));
    if(!isVisitor()) hostBody.appendChild(el('button', {text:'前往配置开启', onclick:function(){ gotoCfg('crossing'); }}));
  } else {
    hostBody.appendChild(el('div', {cls:'kv'}, [
      el('span', {cls:'k', text:'服务状态'}),
      el('span', {cls:'v', html: c.server.running
        ? '<span style="color:var(--ok)">接待中</span> · 监听 ' + esc(c.server.host + ':' + c.server.port)
        : '<span style="color:var(--err)">未运行（启动失败？查看日志）</span>'})
    ]));
    hostBody.appendChild(el('div', {cls:'kv'}, [
      el('span', {cls:'k', text:'对外世界名'}),
      el('span', {cls:'v', text: c.server.worldName})
    ]));
    hostBody.appendChild(el('div', {cls:'kv'}, [
      el('span', {cls:'k', text:'对方需要填写的地址'}),
      el('span', {cls:'v', text:'http://<你的公网或局域网地址>:' + c.server.port + '（或反代后的 https 地址，支持路径前缀）'})
    ]));
    hostBody.appendChild(el('div', {cls:'kv'}, [
      el('span', {cls:'k', text:'联通检验'}),
      el('span', {cls:'v', text:'让对方用浏览器打开上面的地址——能看到引导页即为联通'})
    ]));
    // 在场访客
    hostBody.appendChild(el('div', {cls:'crumb', text:'在场访客', style:'margin-top:12px'}));
    if(!visitors.length){
      hostBody.appendChild(el('p', {cls:'empty', text:'（暂无访客）'}));
    } else {
      visitors.forEach(function(v){
        hostBody.appendChild(el('div', {cls:'kv'}, [
          el('span', {cls:'k', text: v.name}),
          el('span', {cls:'v', text: '到达于 ' + new Date(v.arrivedAt).toLocaleTimeString()})
        ]));
      });
    }
    // 邀请码
    hostBody.appendChild(el('div', {cls:'crumb', text:'邀请码（在配置 crossing.invites 里增删）', style:'margin-top:12px'}));
    if(!invites.length){
      hostBody.appendChild(el('p', {cls:'empty', text:'（还没有邀请码——去配置里添加一条，code 建议用长随机串）'}));
    } else {
      invites.forEach(function(inv){
        var code = String(inv.code || '');
        var masked = code ? (code.slice(0, 4) + '••••••') : '（空）';
        hostBody.appendChild(el('div', {cls:'kv'}, [
          el('span', {cls:'k'}, [
            el('span', {text: (inv.name || '未备注'), style:'font-size:12.5px'}),
            el('span', {text: inv.enabled ? '' : ' · 已吊销', style:'color:var(--err);font-size:11.5px'})
          ]),
          el('span', {cls:'v'}, [
            el('code', {text: masked, style:'margin-right:8px'}),
            code ? el('button', {text:'复制', style:'padding:2px 9px;font-size:11.5px', onclick:function(){ copyText(code, '邀请码已复制'); }}) : null
          ])
        ]));
      });
    }
  }
  hostSec.appendChild(hostBody);
  wrap.appendChild(hostSec);

  // ---- 说明 ----
  wrap.appendChild(el('div', {cls:'section'}, [
    el('h3', {text:'工作原理'}),
    el('div', {cls:'body guide', html:
      '<p><b>作客</b>：Bot 在异世界期间，act 裁定、等待补叙、查看时间、天气/虚构网页等都由<b>对方的 World-LLM</b> 处理；你自己的 World-LLM 只保留记忆压缩等私人工作。</p>' +
      '<p><b>沉睡</b>：你外出且无访客时，你的世界暂停心跳（省 token）；有人出现（Bot 回家 / 访客到达）时自动补叙期间的演化。</p>' +
      '<p><b>接待</b>：来访 Bot 的行动由你的 World-LLM 裁定，会计入你的 token 用量；世界心跳会感知在场访客并可向他们广播事件。</p>' +
      '<p><b>安全</b>：网络上只有任务与事件文本；邀请码可随时在配置里吊销（enabled 关闭）。指令 <code>world.travel &lt;世界名|home&gt;</code> 与本页按钮等效。</p>'
    })
  ]));
  return wrap;
}
function crossingCard(label, value, highlight){
  return el('div', {cls:'card' + (highlight ? ' usage-cache-card' : '')}, [
    el('div', {cls:'card-label', text: label}),
    el('div', {cls:'card-value', style:'font-size:15px', text: String(value)})
  ]);
}
function crossingTravel(target, label){
  api('POST', '/api/crossing/travel', {world: target}).then(function(r){
    toast(r.text, r.text.indexOf('失败') >= 0 ? 'warn' : 'ok');
    refreshCrossing(true);
  }).catch(function(err){ toast(label + '失败：' + (err.message || err), 'err'); });
}

// ---------- 相册 ----------
function loadGallery(){
  if(activeView !== 'gallery') return;
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('相册（Bot 收藏夹）', '分类：表情包 / meme / 截图 / 照片 / 未整理。未整理是主人手动放入、待 Bot 归类描述的东西。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/gallery').then(function(r){
    if(activeView !== 'gallery' || !holder.isConnected) return;
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
  var frag2 = el('div');
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
  frag2.appendChild(renderGalleryGrid());
  frag.appendChild(frag2);
  if(!isVisitor()) frag.appendChild(uploadBar());
  return frag;
}
function renderGalleryGrid(){
  var wrap = el('div');
  var list = el('div', {cls:'gallery-grid'});
  var items = galleryCache.filter(function(e){ return e.category === currentCategory; });
  items.forEach(function(e){
    var url = withToken('/api/gallery/file?category=' + encodeURIComponent(e.category) + '&name=' + encodeURIComponent(e.name));
    var card = el('div', {cls:'g-card'});
    if(e.image){
      var img = el('img', {src: url, loading:'lazy'});
      img.onerror = function(){ img.style.visibility = 'hidden'; };
      img.onclick = function(){ showImage(e.category + ' / ' + e.name, url); };
      card.appendChild(img);
    } else {
      card.appendChild(el('div', {style:'height:120px;display:flex;align-items:center;justify-content:center;background:rgba(7,9,15,.5);font-size:30px;color:var(--fg-dark)', text:'📄'}));
    }
    card.appendChild(el('div', {cls:'m', text: e.name + ' · ' + fmtBytes(e.size)}));
    card.appendChild(el('div', {cls:'d', text: e.description || '（无描述）'}));
    if(!isVisitor()){
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
    }
    list.appendChild(card);
  });
  if(!items.length) list.appendChild(el('p', {cls:'empty', text:'（这个分类还是空的）'}));
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
  if(activeView !== 'media') return;
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('媒体资产库', 'Bot 见过的媒体缓存（只读，Bot 用 check_media 翻看）。收藏夹是精心挑选的，这里是全部见过的。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/media').then(function(r){
    if(activeView !== 'media' || !holder.isConnected) return;
    holder.textContent = '';
    var rows = r.rows || [];
    if(!rows.length){ holder.appendChild(el('p', {cls:'empty', text:'（还没有任何媒体）'})); return; }
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
        sum.appendChild(el('div', {style:'margin-top:4px'}, [el('button', {text:'查看原图', style:'padding:2px 9px;font-size:11.5px', onclick:function(){
          showImage('媒体 #' + m.id, withToken('/api/media/file?id=' + m.id));
        }})]));
      }
      tr.appendChild(sum);
      tbl.appendChild(tr);
    });
    holder.appendChild(el('div', {cls:'table-scroll'}, [tbl]));
  }).catch(showErr);
}

// ---------- 数据 ----------
function refreshData(){
  if(activeView !== 'data') return;
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('数据文件与记事本', '查看/编辑世界数据目录里的运行时 JSON 文件与 Bot 的记事本（Notes/），以及压缩归档。'));
  if(visitorCanSee(['notes'])) main.appendChild(el('button', {text:'查看角色成长轨迹', onclick:function(){ switchView('growth'); }}));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/data').then(function(r){
    if(activeView !== 'data' || !holder.isConnected) return;
    holder.textContent = '';
    var sec = el('div', {cls:'section'});
    sec.appendChild(el('h3', {text:'运行时 JSON 文件'}));
    var body = el('div', {cls:'body'});
    var rows = el('div');
    r.files.forEach(function(f){
      rows.appendChild(el('div', {cls:'kv'}, [
        el('span', {cls:'k', text: f.name + (f.exists ? ' · ' + fmtBytes(f.size) : ' · 不存在')}),
        el('button', {text:'打开编辑', style:'padding:2px 9px;font-size:11.5px', onclick:function(){ openDataFile(f.name); }})
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
      if(activeView !== 'data' || !holder.isConnected) return;
      (nr.notes || []).forEach(function(n){
        var vnode = el('span', {cls:'v'}, [
          el('button', {text:'打开', style:'padding:2px 9px;font-size:11.5px', onclick:function(){ openNote(n.title); }})
        ]);
        if(!isVisitor()){
          vnode.appendChild(el('button', {cls:'danger', text:'删除', style:'margin-left:6px;padding:2px 9px;font-size:11.5px', onclick:function(){
            if(!confirm('删除笔记「' + n.title + '」？')) return;
            api('DELETE', '/api/notes?name=' + encodeURIComponent(n.title)).then(function(){ toast('已删除', 'ok'); refreshData(); }).catch(showErr);
          }}));
        }
        nlist.appendChild(el('div', {cls:'kv'}, [el('span', {cls:'k', text: n.title}), vnode]));
      });
      if(!nr.notes || !nr.notes.length) nlist.appendChild(el('p', {cls:'empty', text:'（记事本是空的）'}));
    }).catch(function(){});
    nbody.appendChild(nlist);
    if(!isVisitor()){
      nbody.appendChild(el('div', {cls:'toolbar'}, [el('button', {text:'新建笔记…', onclick:function(){
        var name = prompt('笔记标题（将创建为 Notes/<标题>.md）：');
        if(!name) return;
        openNote(name);
      }})]));
    }
    notesSec.appendChild(nbody);
    holder.appendChild(notesSec);

    renderArchiveSection(holder, r.archive || {snapshots: [], legacy: []});
  }).catch(showErr);
}
function renderArchiveSection(holder, archive){
  var aSec = el('div', {cls:'section'});
  var head = el('h3', {html:'归档 archive/ <span class="hint">压缩、重置与手动存档的历史快照</span>'});
  if(!isVisitor()){
    head.appendChild(el('span', {style:'flex:1'}));
    head.appendChild(el('button', {text:'手动存档…', title:'把当前全部世界状态复制成一份新快照', style:'padding:2px 10px;font-size:12px', onclick: manualArchive}));
  }
  aSec.appendChild(head);
  var ab = el('div', {cls:'body'});
  var snaps = archive.snapshots || [];
  var legacy = archive.legacy || [];
  if(!snaps.length && !legacy.length){
    ab.appendChild(el('p', {cls:'empty', text:'（还没有任何归档——压缩、重置世界或手动存档后会出现）'}));
  }
  snaps.forEach(function(s){
    var item = el('div', {cls:'list-item'});
    var rowBtns = [
      el('span', {text: (s.label ? '「' + s.label + '」 · ' : '') + s.name, style:'flex:1;min-width:0;font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: s.name}),
      el('span', {text: new Date(s.mtime).toLocaleString(), style:'color:var(--fg-dark);font-size:11px'})
    ];
    if(!isVisitor()){
      rowBtns.push(el('button', {cls:'primary', text:'回档', title:'用这份快照覆盖当前状态（回档前会自动存档当前状态）', style:'padding:2px 10px;font-size:11.5px', onclick:function(){ restoreArchive(s.name); }}));
      rowBtns.push(el('button', {cls:'danger', text:'删除', style:'padding:2px 10px;font-size:11.5px', onclick:function(){
        if(!confirm('删除归档「' + s.name + '」？不可恢复。')) return;
        api('POST', '/api/archive/delete', {name: s.name}).then(function(){ toast('已删除', 'ok'); refreshData(); }).catch(showErr);
      }}));
    }
    item.appendChild(el('div', {cls:'row'}, rowBtns));
    var frow = el('div', {style:'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap'});
    s.files.forEach(function(f){
      frow.appendChild(el('button', {text: f.name + (f.size ? ' · ' + fmtBytes(f.size) : ''), title:'查看内容', style:'padding:2px 9px;font-size:11px', onclick:function(){
        api('GET', '/api/archive/file?folder=' + encodeURIComponent(s.name) + '&file=' + encodeURIComponent(f.name)).then(function(r2){
          if(activeView !== 'data' || !holder.isConnected) return;
          var pre = el('pre', {style:'max-height:60vh;overflow:auto'});
          pre.textContent = r2.content;
          showModal(s.name + ' / ' + f.name, pre);
        }).catch(showErr);
      }}));
    });
    item.appendChild(frow);
    ab.appendChild(item);
  });
  if(legacy.length){
    var lg = el('details', {style:'margin-top:6px'});
    lg.appendChild(el('summary', {text:'旧版扁平归档（' + legacy.length + ' 个文件，升级前的历史存档）', style:'font-size:12px;color:var(--fg-dim)'}));
    var lbody = el('div', {style:'margin-top:8px'});
    legacy.forEach(function(a){
      lbody.appendChild(el('div', {cls:'kv'}, [
        el('span', {cls:'k', text: a}),
        el('button', {text:'查看', style:'padding:2px 9px;font-size:11.5px', onclick:function(){
          api('GET', '/api/archive/file?file=' + encodeURIComponent(a)).then(function(r2){
          if(activeView !== 'data' || !holder.isConnected) return;
            var pre = el('pre', {style:'max-height:60vh;overflow:auto'});
            pre.textContent = r2.content;
            showModal(a, pre);
          }).catch(showErr);
        }})
      ]));
    });
    lg.appendChild(lbody);
    ab.appendChild(lg);
  }
  aSec.appendChild(ab);
  holder.appendChild(aSec);
}
function manualArchive(){
  var inp = el('input', {placeholder:'存档备注（可选）', style:'width:100%'});
  showModal('手动存档', el('div', null, [
    el('p', {text:'把当前全部世界状态（Bot/World 状态、新闻、小事记、时钟、记事本、工作窗口等）复制成一份新归档快照，不影响正在运行的世界。', style:'color:var(--fg-dim);font-size:13px'}),
    inp,
    el('div', {cls:'toolbar', style:'margin:8px 0 0'}, [
      el('button', {text:'取消', onclick:hideModal}),
      el('button', {cls:'primary', text:'存档', onclick:function(){
        api('POST', '/api/archive/save', {label: inp.value.trim()}).then(function(r){
          hideModal();
          toast(r.text || '已存档', 'ok');
          refreshData();
        }).catch(showErr);
      }})
    ])
  ]));
}
function restoreArchive(name){
  if(!confirm('回档到「' + name + '」？\n当前状态会先自动存档，然后被这份快照覆盖。')) return;
  api('POST', '/api/archive/restore', {name: name}).then(function(r){
    toast(r.text || '已回档', 'ok');
    refreshData();
    refreshOverview(false);
  }).catch(showErr);
}
function openDataFile(name){
  api('GET', '/api/data/file?name=' + encodeURIComponent(name)).then(function(r){
    if(activeView !== 'data') return;
    var ta = el('textarea', {rows: 20});
    ta.value = r.content;
    if(isVisitor()) ta.readOnly = true;
    showModal(name, el('div', null, isVisitor() ? [ta] : [
      ta,
      el('div', {cls:'toolbar', style:'margin:8px 0 0'}, [
        el('button', {cls:'primary', text:'保存', onclick:function(){
          api('POST', '/api/data/file', {name:name, content:ta.value}).then(function(){ toast('已保存', 'ok'); hideModal(); }).catch(showErr);
        }}),
        el('button', {text:'关闭', onclick:hideModal})
      ])
    ]));
  }).catch(showErr);
}
function openNote(title){
  api('GET', '/api/notes').then(function(r){
    if(activeView !== 'data') return;
    var note = (r.notes || []).filter(function(n){ return n.title === title; })[0];
    var ta = el('textarea', {rows: 22});
    ta.value = note ? note.content : '';
    if(isVisitor()) ta.readOnly = true;
    showModal('笔记：' + title, el('div', null, isVisitor() ? [ta] : [
      ta,
      el('div', {cls:'toolbar', style:'margin:8px 0 0'}, [
        el('button', {cls:'primary', text:'保存', onclick:function(){
          api('PUT', '/api/notes', {name:title, content:ta.value}).then(function(){ toast('已保存', 'ok'); hideModal(); refreshData(); }).catch(showErr);
        }}),
        el('button', {text:'关闭', onclick:hideModal})
      ])
    ]));
  }).catch(showErr);
}

// ---------- 路径工具 ----------
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
  markCfgDirty();
}
