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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#07090f">
<title>YesImBot World · 世界观测台</title>
<style>
:root{
  --bg:#07090f; --bg2:#0b0f17;
  --panel:rgba(148,163,184,.06); --panel2:rgba(148,163,184,.1);
  --line:rgba(148,163,184,.13); --line2:rgba(148,163,184,.24);
  --fg:#e4eaf4; --fg-dim:#93a0b4; --fg-dark:#5b6678;
  --accent:#6ee7ff; --accent2:#8a7bff;
  --ok:#4ade80; --warn:#fbbf24; --err:#f87171; --info:#7fa8d9;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --radius:14px;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{
  margin:0;color:var(--fg);font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
  background:
    radial-gradient(1100px 520px at 85% -8%, rgba(138,123,255,.13), transparent 62%),
    radial-gradient(900px 480px at -8% 18%, rgba(110,231,255,.08), transparent 58%),
    radial-gradient(700px 500px at 50% 115%, rgba(110,231,255,.05), transparent 60%),
    var(--bg);
  background-attachment:fixed;
}
a{color:var(--accent);text-decoration:none}
::selection{background:rgba(110,231,255,.28)}
button{font:inherit;color:var(--fg);background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:6px 14px;cursor:pointer;transition:border-color .15s,background .15s,transform .1s,box-shadow .15s}
button:hover{border-color:var(--line2);background:rgba(148,163,184,.16)}
button:active{transform:scale(.97)}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid rgba(110,231,255,.5);outline-offset:1px}
button.primary{background:linear-gradient(135deg,rgba(110,231,255,.2),rgba(138,123,255,.22));border-color:rgba(110,231,255,.45);color:#eafcff}
button.primary:hover{border-color:var(--accent);box-shadow:0 0 16px rgba(110,231,255,.22)}
button.danger{color:var(--err);border-color:rgba(248,113,113,.4)}
button.danger:hover{border-color:var(--err);background:rgba(248,113,113,.1)}
button.ghost{background:transparent}
button:disabled{opacity:.45;cursor:not-allowed}
input,select,textarea{font:inherit;color:var(--fg);background:rgba(7,9,15,.5);border:1px solid var(--line);border-radius:10px;padding:6px 10px;outline:none;transition:border-color .15s;max-width:100%}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
input[type=checkbox]{accent-color:var(--accent)}
textarea{width:100%;resize:vertical;line-height:1.6}
code{font-family:var(--mono);background:var(--panel2);padding:1px 6px;border-radius:6px;font-size:12px}
pre{font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;background:rgba(7,9,15,.5);border:1px solid var(--line);border-radius:10px;padding:10px;margin:0}
::placeholder{color:var(--fg-dark)}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:rgba(148,163,184,.22);border-radius:99px;border:2px solid transparent;background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}
details summary{cursor:pointer;user-select:none;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"▸";display:inline-block;margin-right:6px;color:var(--fg-dark);transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}

/* ---------- 布局骨架 ---------- */
#app{display:flex;min-height:100vh}
#sidebar{
  width:228px;flex:none;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;z-index:40;
  background:rgba(9,12,19,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-right:1px solid var(--line);
}
.brand{display:flex;align-items:center;gap:11px;padding:18px 18px 14px}
.orb{width:36px;height:36px;border-radius:50%;flex:none;
  background:radial-gradient(circle at 32% 28%, #d6f6ff 0%, #6ee7ff 30%, #4f46e5 72%, #1e1b4b 100%);
  box-shadow:0 0 22px rgba(110,231,255,.4), inset -4px -5px 10px rgba(30,27,75,.55), inset 3px 4px 8px rgba(255,255,255,.28);
  animation:orbFloat 7s ease-in-out infinite;}
@keyframes orbFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
.brand .t1{font-size:15px;font-weight:700;letter-spacing:.3px;line-height:1.25}
.brand .t2{font-size:10.5px;color:var(--fg-dark);letter-spacing:2.5px}
#nav{flex:1;overflow-y:auto;padding:4px 10px 12px}
.nav-group{font-size:10.5px;color:var(--fg-dark);letter-spacing:2px;padding:14px 10px 5px}
#nav a{display:flex;align-items:center;gap:10px;padding:8px 10px;margin:1px 0;color:var(--fg-dim);cursor:pointer;font-size:13.5px;border-radius:10px;border:1px solid transparent;transition:background .15s,color .15s}
#nav a{position:relative}
#nav a:hover{color:var(--fg);background:var(--panel)}
#nav a.active{color:#eafcff;background:linear-gradient(135deg,rgba(110,231,255,.14),rgba(138,123,255,.14));border-color:rgba(110,231,255,.3);box-shadow:0 2px 12px rgba(110,231,255,.1)}
#nav a.active:before{content:"";position:absolute;left:-10px;top:20%;bottom:20%;width:3px;border-radius:3px;background:linear-gradient(180deg,var(--accent),var(--accent2))}
#nav a .ico{width:17px;height:17px;flex:none;opacity:.85}
#nav a .ico svg{width:100%;height:100%;display:block}
.side-foot{padding:12px 18px;border-top:1px solid var(--line);font-size:11px;color:var(--fg-dark);display:flex;align-items:center;gap:7px}
#backdrop{display:none}
#content{flex:1;min-width:0;display:flex;flex-direction:column}
#topbar{
  position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px;padding:10px 22px;
  background:rgba(7,9,15,.68);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line);
}
#btn-menu{display:none;background:none;border:none;padding:6px;cursor:pointer}
#btn-menu svg{width:22px;height:22px;display:block}
#tb-clock{font-family:var(--mono);font-size:13px;color:var(--fg-dim)}
#tb-extra{font-size:12px;color:var(--fg-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 11px;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--fg-dim);white-space:nowrap}
.pill:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--fg-dark)}
.pill.run{color:var(--ok);border-color:rgba(74,222,128,.4)}
.pill.run:before{background:var(--ok);animation:pulse 1.8s infinite}
.pill.pause{color:var(--warn);border-color:rgba(251,191,36,.4)}
.pill.pause:before{background:var(--warn)}
.pill.off{color:var(--err);border-color:rgba(248,113,113,.4)}
.pill.off:before{background:var(--err)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(74,222,128,.45)}55%{box-shadow:0 0 0 6px rgba(74,222,128,0)}}
#sse-dot{width:8px;height:8px;border-radius:50%;background:var(--fg-dark);flex:none}
#sse-dot.on{background:var(--ok);box-shadow:0 0 8px rgba(74,222,128,.7)}
#sse-dot.off{background:var(--err)}
main{flex:1;padding:22px 26px 60px;max-width:1240px;width:100%;margin:0 auto}
main.anim{animation:viewIn .25s ease}
@keyframes viewIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.view-head{margin-bottom:18px;position:relative;padding-left:14px}
.view-head:before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:3px;border-radius:3px;background:linear-gradient(180deg,var(--accent),var(--accent2))}
.view-title{font-size:21px;font-weight:700;margin:0;letter-spacing:.3px}
.view-desc{color:var(--fg-dim);font-size:12.5px;margin:5px 0 0}

/* ---------- 通用组件 ---------- */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:13px 15px;transition:border-color .2s,transform .2s,box-shadow .2s}
.card:hover{border-color:var(--line2);transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,.25)}
.card .k{font-size:11.5px;color:var(--fg-dark);letter-spacing:.6px;margin-bottom:4px}
.card .v{font-size:16px;font-weight:650;word-break:break-word}
.card .v.small{font-size:12.5px;font-weight:400;color:var(--fg-dim)}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}
.toolbar .spacer{flex:1}
.section{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:16px;overflow:hidden;transition:border-color .2s}
.section:hover{border-color:var(--line2)}
.section h3{margin:0;padding:12px 16px;font-size:13.5px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;letter-spacing:.3px;background:rgba(148,163,184,.04)}
.section h3 .hint{font-weight:400;color:var(--fg-dark);font-size:11.5px}
.section .body{padding:14px 16px}
.fld{display:flex;gap:10px;margin-bottom:10px;align-items:flex-start}
.fld .lbl{width:220px;flex:none;padding-top:5px}
.fld .lbl .name{font-size:13px;font-family:var(--mono);font-size:12.5px;word-break:break-all}
.fld .lbl .desc{font-size:11.5px;color:var(--fg-dim);margin-top:3px;line-height:1.5}
.fld .ctl{flex:1;min-width:0}
.fld .ctl select{width:100%}
.fld textarea{font-family:var(--mono);font-size:12px}
.fld input[type=text],.fld input[type=password],.fld input[type=number]{width:100%}
.kv{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line);align-items:center}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--fg-dim);font-size:12.5px}
.kv .v{text-align:right;word-break:break-all;font-size:12.5px}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:14px;overflow-x:auto}
.tabs button{border:none;background:none;color:var(--fg-dim);padding:8px 13px;border-bottom:2px solid transparent;border-radius:0;white-space:nowrap;transition:color .15s,border-color .15s}
.tabs button:hover{color:var(--fg);background:none}
.tabs button.active{color:var(--accent);border-bottom-color:var(--accent);text-shadow:0 0 18px rgba(110,231,255,.45)}
.hidden{display:none!important}
.empty{color:var(--fg-dark);font-size:12.5px;padding:6px 2px}
.table-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius)}
table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:560px}
th,td{border-bottom:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
th{background:rgba(148,163,184,.07);color:var(--fg-dim);font-weight:500;white-space:nowrap}
tr:last-child td{border-bottom:none}
img.full{max-width:100%;max-height:72vh;border-radius:10px}
.grid-booleans{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px 14px}
.list-item{border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:10px;background:rgba(7,9,15,.4)}
.list-item .row{display:flex;gap:8px;align-items:center}

/* 开关 */
.sw{position:relative;display:inline-block;width:40px;height:22px;flex:none;cursor:pointer;vertical-align:middle}
.sw input{opacity:0;width:0;height:0;position:absolute}
.sw i{position:absolute;inset:0;background:var(--panel2);border:1px solid var(--line2);border-radius:999px;transition:.18s}
.sw i:before{content:"";position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#94a3b8;transition:.18s}
.sw input:checked + i{background:rgba(110,231,255,.22);border-color:var(--accent)}
.sw input:checked + i:before{transform:translateX(17px);background:var(--accent);box-shadow:0 0 8px rgba(110,231,255,.6)}
.sw-row{display:flex;gap:9px;align-items:flex-start;padding:5px 4px;border-radius:8px}
.sw-row:hover{background:var(--panel)}
.sw-row .tx{flex:1;min-width:0}
.sw-row .tx .n{font-size:12.5px;font-family:var(--mono)}
.sw-row .tx .d{font-size:11px;color:var(--fg-dark);line-height:1.45;margin-top:1px}
.sw-row.danger .tx .n{color:var(--err)}

/* ---------- 总览 ---------- */
.hero{display:flex;gap:20px;align-items:stretch;flex-wrap:wrap;margin-bottom:18px}
.hero-main{flex:1;min-width:260px;background:linear-gradient(135deg,rgba(110,231,255,.09),rgba(138,123,255,.09));border:1px solid rgba(110,231,255,.22);border-radius:18px;padding:20px 22px;position:relative;overflow:hidden}
.hero-main:after{content:"";position:absolute;right:-70px;top:-70px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(110,231,255,.16),transparent 70%);pointer-events:none}
.hero-clock{font-family:var(--mono);font-size:34px;font-weight:700;letter-spacing:1px;margin:8px 0 2px;line-height:1.2}
.hero-sub{color:var(--fg-dim);font-size:12px}
.hero-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;position:relative;z-index:1}
.live-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
.live{position:relative;border-radius:18px;border:1px solid var(--line);background:var(--panel);padding:14px 16px;overflow:hidden}
.live.gen{border-color:transparent}
.live.gen:before{content:"";position:absolute;inset:0;border-radius:18px;padding:1.5px;
  background:linear-gradient(110deg,var(--accent),var(--accent2),#f0abfc,var(--accent));
  background-size:250% 100%;animation:flow 2.8s linear infinite;
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
@keyframes flow{to{background-position:250% 0}}
.live .head{display:flex;align-items:center;gap:9px;margin-bottom:8px}
.live .head .who{font-size:13px;font-weight:650}
.live .head .ms{font-family:var(--mono);font-size:11.5px;color:var(--fg-dark);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;text-align:right}
.live .body{font-family:var(--mono);font-size:12px;color:var(--fg-dim);white-space:pre-wrap;word-break:break-word;max-height:170px;overflow-y:auto;line-height:1.7}
.live .body.idle-txt{color:var(--fg-dark)}
.feed{border-top:1px dashed var(--line);padding-top:8px;margin-top:10px}
.feed-row{display:flex;gap:10px;align-items:center;padding:3.5px 0;font-size:12px}
.feed-row .t{font-family:var(--mono);color:var(--fg-dark);font-size:11px;flex:none;width:64px}
.feed-row .l{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-dim)}
.tag{font-size:10px;padding:1.5px 7px;border-radius:6px;background:var(--panel2);color:var(--fg-dim);flex:none;font-family:var(--mono)}
.tag.req{color:#8ab4ff}.tag.res{color:#7bd88f}.tag.tool{color:#e8c66a}.tag.event{color:#c792ea}.tag.err{color:#ff8a8a}
.tag.use{color:#c792ea;border:1px solid rgba(199,146,234,.4)}
.usage-entry{display:flex;align-items:center;gap:12px;padding:7px 4px;border-bottom:1px dashed var(--line);font-size:12.5px;border-radius:8px}
.usage-entry:last-child{border-bottom:none}
.usage-entry:hover{background:var(--panel)}
.usage-entry .usage-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.usage-entry .usage-time{color:var(--fg-dark);font-size:11px;flex:none}
.usage-entry .usage-num{font-family:var(--mono);font-size:12px;flex:none}
.usage-entry .usage-num.dim{color:var(--fg-dark);font-size:11px}
.card-label{font-size:11.5px;color:var(--fg-dark);letter-spacing:.6px;margin-bottom:4px}
.card-value{font-size:19px;font-weight:700;word-break:break-word;font-variant-numeric:tabular-nums}
.card-value .card-unit{font-size:11.5px;font-weight:400;color:var(--fg-dark)}
.card.usage-cache-card{background:linear-gradient(135deg,rgba(110,231,255,.08),rgba(138,123,255,.06));border-color:rgba(110,231,255,.28)}
.card.usage-cache-card .card-value{color:var(--accent)}
/* 分段筛选按钮 */
button.seg{border-radius:999px;padding:4px 14px;font-size:12.5px;background:transparent}
button.seg.active{background:linear-gradient(135deg,rgba(110,231,255,.18),rgba(138,123,255,.18));border-color:rgba(110,231,255,.45);color:#eafcff}
/* 用量图表 */
.chart-scroll{overflow-x:auto}
.chart-legend{display:flex;gap:16px;margin-top:8px;flex-wrap:wrap}
.legend-item{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--fg-dim)}
.legend-item i{width:10px;height:10px;border-radius:3px;flex:none}
.addr-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--line)}
.addr-row:last-child{border-bottom:none}
.addr-row .u{font-family:var(--mono);font-size:12.5px;flex:1;word-break:break-all}
.guide{font-size:12.5px;color:var(--fg-dim);line-height:1.8}
.guide b{color:var(--fg)}
.guide code{font-size:11.5px}
.news-item{border-left:2px solid rgba(110,231,255,.35);padding:7px 12px;margin-bottom:8px;background:var(--panel);border-radius:0 10px 10px 0}
.news-item .clock{color:var(--info);font-size:11.5px;font-family:var(--mono)}
.news-item textarea{width:100%;margin-top:6px;font-family:var(--mono);font-size:12px}
.news-detail{font-size:12.5px;line-height:1.6;color:var(--fg);white-space:pre-wrap;word-break:break-word}

/* ---------- 设备 ---------- */
.dev-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.mode-badge{font-size:11px;padding:2px 9px;border-radius:99px;border:1px solid var(--line2);color:var(--fg-dim);font-family:var(--mono)}
.mode-badge.on{color:var(--ok);border-color:rgba(74,222,128,.45)}
.screen-box{position:relative;border-radius:12px;overflow:hidden;background:#04060a;border:1px solid var(--line);min-height:220px;display:flex;align-items:center;justify-content:center}
.screen-box img{width:100%;display:block;cursor:zoom-in}
.screen-err{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:var(--fg-dark);font-size:12.5px;background:rgba(4,6,10,.85)}
.term{background:#04060a;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-family:var(--mono);font-size:12px;max-height:340px;overflow-y:auto;line-height:1.65}
.term .cmd{color:var(--accent)}
.term .cmd:before{content:"$ ";color:var(--fg-dark)}
.term .out{color:var(--fg-dim);white-space:pre-wrap;word-break:break-word;margin:2px 0 8px}
.term .code-err{color:var(--err)}
.term-input{display:flex;gap:8px;margin-top:10px}
.term-input input{flex:1;font-family:var(--mono);font-size:12.5px}
.phone{width:270px;max-width:100%;margin:0 auto;border-radius:38px;border:1px solid var(--line2);background:#04060a;padding:9px;box-shadow:0 18px 50px rgba(0,0,0,.5),0 0 0 1px rgba(148,163,184,.06)}
.phone .scr{border-radius:30px;overflow:hidden;min-height:400px;display:flex;flex-direction:column;background:linear-gradient(165deg,#0c1322,#0f1a2e 55%,#131c31)}
.phone .scr.off{background:#05070b}
.phone .statusbar{display:flex;justify-content:space-between;align-items:center;padding:8px 16px 4px;font-family:var(--mono);font-size:11px;color:var(--fg-dim)}
.phone .notch{width:86px;height:19px;border-radius:0 0 14px 14px;background:#04060a;margin:0 auto;position:relative;top:-4px}
.phone .appview{flex:1;display:flex;flex-direction:column;padding:10px 14px}
.phone .app-name{font-size:15px;font-weight:650;margin:2px 0 8px}
.phone .chan{background:rgba(148,163,184,.09);border:1px solid var(--line);border-radius:10px;padding:9px 11px;font-size:12px;color:var(--fg-dim);margin-bottom:8px}
.phone .home{flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:14px 8px;padding:18px 14px;align-content:start}
.phone .appdot{display:flex;flex-direction:column;align-items:center;gap:5px;font-size:10px;color:var(--fg-dim)}
.phone .appdot i{width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,rgba(110,231,255,.2),rgba(138,123,255,.24));border:1px solid var(--line2);display:flex;align-items:center;justify-content:center;font-size:19px;font-style:normal}
.phone .dock{display:flex;justify-content:center;padding:8px 0 12px}
.phone .dock i{width:34px;height:5px;border-radius:99px;background:rgba(148,163,184,.35)}
.phone .offmsg{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--fg-dark);font-size:12.5px;padding:20px;text-align:center}

/* ---------- 配置 ---------- */
.cfg-wrap{display:grid;grid-template-columns:190px 1fr;gap:18px;align-items:start}
.cfg-wrap>#cfg-body{min-width:0}
.cfg-nav{position:sticky;top:64px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:8px;max-height:calc(100vh - 90px);overflow-y:auto}
.cfg-nav a{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;color:var(--fg-dim);font-size:12.5px;cursor:pointer;margin:1px 0}
.cfg-nav a:hover{color:var(--fg);background:var(--panel)}
.cfg-nav a.active{color:#eafcff;background:linear-gradient(135deg,rgba(110,231,255,.13),rgba(138,123,255,.13))}
.cfg-nav a .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cfg-nav a .c{font-size:10px;color:var(--fg-dark);font-family:var(--mono)}
.cfg-search{margin-bottom:14px;display:flex;gap:8px}
.cfg-search input{flex:1}
.cfg-savebar{position:sticky;bottom:14px;display:flex;align-items:center;gap:10px;background:rgba(9,12,19,.85);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--line2);border-radius:14px;padding:10px 14px;margin-top:16px;box-shadow:0 10px 34px rgba(0,0,0,.45);z-index:10}
.dirty-dot{width:8px;height:8px;border-radius:50%;background:var(--warn);box-shadow:0 0 8px rgba(251,191,36,.7)}
details.adv{border:1px dashed var(--line);border-radius:12px;margin-top:6px}
details.adv>summary{padding:10px 14px;font-size:12.5px;color:var(--fg-dim)}
details.adv>.body{padding:4px 14px 12px}
.plat-cat{font-size:12px;color:var(--accent);letter-spacing:1px;margin:14px 0 6px}
.plat-cat.danger{color:var(--err)}
.crumb{font-size:11px;color:var(--fg-dark);font-family:var(--mono);margin-bottom:2px}

/* ---------- 调试 ---------- */
.debug-list{font-family:var(--mono);font-size:12px}
.dbg{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:7px;overflow:hidden;border-left-width:3px;transition:border-color .15s}
.dbg:hover{border-color:var(--line2);border-left-color:rgba(110,231,255,.5)}
.dbg.open{border-left-color:var(--accent)}
.dbg .head{display:flex;gap:9px;align-items:center;padding:7px 12px;cursor:pointer;user-select:none}
.dbg .head:hover{background:var(--panel)}
.dbg .head .t{color:var(--fg-dark);font-size:11px;flex:none}
.dbg .head .l{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg .detail{display:none;padding:9px 12px;border-top:1px solid var(--line);background:rgba(7,9,15,.45)}
.dbg.open .detail{display:block}
.dbg .detail pre{background:transparent;border:none;padding:0}
.stream-entry{border-bottom:1px solid var(--line);padding:8px 4px}
.stream-entry .k{font-size:11px;color:var(--fg-dark)}
.stream-entry pre{margin-top:4px}

/* ---------- 相册 ---------- */
.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.g-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .2s,transform .2s}
.g-card:hover{border-color:var(--line2);transform:translateY(-2px)}
.g-card img{width:100%;height:120px;object-fit:cover;background:rgba(7,9,15,.5);cursor:zoom-in}
.g-card .m{padding:7px 10px;font-size:11px;color:var(--fg-dim);word-break:break-all}
.g-card .d{padding:0 10px;font-size:11px;color:var(--fg-dark);min-height:30px}
.g-card .a{padding:7px 10px;display:flex;gap:5px;flex-wrap:wrap}
.g-card select{max-width:110px;font-size:11px;padding:3px 5px}
.g-card button{font-size:11px;padding:3px 8px}

/* ---------- 弹层 ---------- */
#toasts{position:fixed;top:16px;right:16px;z-index:80;display:flex;flex-direction:column;gap:8px;max-width:min(380px,90vw)}
.toast{background:rgba(13,17,26,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--line2);border-radius:12px;padding:11px 15px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.5);animation:tin .22s ease}
@keyframes tin{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
.toast.ok{border-color:rgba(74,222,128,.5)}
.toast.warn{border-color:rgba(251,191,36,.5)}
.toast.err{border-color:rgba(248,113,113,.5)}
#modal{position:fixed;inset:0;background:rgba(3,5,9,.66);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:70;display:none;align-items:center;justify-content:center;padding:16px}
#modal.show{display:flex}
#modal .box{background:#0d1119;border:1px solid var(--line2);border-radius:16px;padding:20px;width:520px;max-width:94vw;max-height:88vh;overflow-y:auto;box-shadow:0 24px 70px rgba(0,0,0,.6);animation:tin .2s ease}
#modal .box h3{margin:0 0 12px;font-size:15px;display:flex;align-items:center;gap:8px}
#modal .x{margin-left:auto;background:none;border:none;color:var(--fg-dark);font-size:17px;padding:2px 6px;cursor:pointer}
#modal .x:hover{color:var(--fg)}

/* ---------- 移动端 ---------- */
@media (max-width:960px){
  #sidebar{position:fixed;left:0;top:0;bottom:0;transform:translateX(-105%);transition:transform .25s ease;box-shadow:0 0 60px rgba(0,0,0,.5)}
  #sidebar.open{transform:none}
  #backdrop.show{display:block;position:fixed;inset:0;background:rgba(3,5,9,.55);z-index:35}
  #btn-menu{display:block}
  main{padding:16px 14px 70px}
  .dev-grid{grid-template-columns:1fr}
  .live-grid{grid-template-columns:1fr}
  .cfg-wrap{grid-template-columns:1fr}
  .cfg-nav{position:static;display:flex;overflow-x:auto;max-height:none;padding:6px;gap:4px}
  .cfg-nav a{white-space:nowrap;flex:none}
  .fld{flex-direction:column;gap:4px;align-items:stretch}
  .fld .lbl{width:auto;padding-top:0}
  .fld .ctl{flex:none;width:100%;min-width:0}
  .hero-clock{font-size:26px}
  button{min-height:34px}
  #tb-clock{display:none}
  .grid-booleans{grid-template-columns:1fr}
  .view-title{font-size:18px}
}
@media (max-width:520px){
  .cards{grid-template-columns:1fr 1fr}
  .gallery-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
  .hero-actions button{flex:1;min-width:0}
}
</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div class="brand">
      <div class="orb"></div>
      <div>
        <div class="t1">YesImBot World</div>
        <div class="t2">世界观测台</div>
      </div>
    </div>
    <nav id="nav"></nav>
    <div class="side-foot"><span id="sse-dot" class="off" title="实时推送"></span><span id="side-ver">—</span></div>
  </aside>
  <div id="backdrop"></div>
  <div id="content">
    <header id="topbar">
      <button id="btn-menu" title="菜单"></button>
      <span id="world-pill" class="pill off">加载中…</span>
      <span id="tb-clock"></span>
      <span style="flex:1"></span>
      <span id="tb-extra"></span>
      <button id="btn-refresh" class="ghost" title="刷新当前视图">刷新</button>
    </header>
    <main id="main"></main>
  </div>
</div>
<div id="modal"><div class="box"><h3><span id="modal-title"></span><button class="x" id="modal-x">✕</button></h3><div id="modal-body"></div></div></div>
<div id="toasts"></div>
<script>
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
var PLAYER_STATE = { token: '', worldName: '', inWorld: false, events: [], actBusy: false };
var activeView = 'overview';
// SSE 断线续传锚点：跨页面加载持久化，避免每次无缓存刷新都从 0 重放整段调试历史
var lastEventId = Number(localStorage.getItem('wui_last_id') || 0);
var evtSource = null;
var cfgCache = null, schemaCache = null, cfgGroup = '', cfgSearch = '', cfgDirty = false, cfgPortOriginal = null;
var overridesCache = null, promptsDefaults = null;
var galleryCache = [], currentCategory = '未整理';
var debugEntries = [], debugSubview = 'llm', debugOrder = 'desc', debugAutoScroll = true, debugKindFilter = 'all';
var debugOpenIds = {}; // 展开状态按条目 id 记忆：重建列表（切换标签/排序/SSE 重放）后仍保持展开
var stateCache = null, stateEditor = null;
// 手机外壳预览：{{screen}} 占位符用一张浅灰 SVG 占位图，展示屏幕区域
var SCREEN_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1280"><rect width="100%" height="100%" fill="#eef1f5"/><text x="50%" y="50%" font-family="sans-serif" font-size="28" fill="#9aa4b0" text-anchor="middle">屏幕预览</text></svg>');
var lastOverview = null;
var liveFeed = [], genMap = {}, liveSeeded = false;
var usageCache = null, usageFilter = 'total', usageFilterLabel = '', usageEntryFilter = null, usageChartMode = 'hour';
var devicesCache = null, screenTimer = null, screenBusy = false, screenUrl = null, execDraft = '', execBusy = false, execHistory = [];
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
    else if(k === 'checked' || k === 'disabled' || k === 'readonly' || k === 'selected' || k === 'multiple') n[k] = !!attrs[k];
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
function hideModal(){ $('#modal').classList.remove('show'); }
$('#modal-x').onclick = hideModal;
$('#modal').onclick = function(e){ if(e.target === this) hideModal(); };
function promptToken(){
  return promptAuth();
}
// 登录：管理员令牌（webui.token）或访客账号（用户名+密码）
// 采用单例：登录弹窗已显示期间，后续 401 复用同一个 Promise，不重复弹窗、不清空已填表单
var authPromise = null;
function promptAuth(){
  if(authPromise) return authPromise;
  authPromise = new Promise(function(resolve){
    var finish = function(v){ authPromise = null; hideModal(); resolve(v); };
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
      errLine.textContent = '';
      if(mode === 'admin'){
        setAdmin(tokenInput.value.trim());
      } else {
        fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username: usernameInput.value.trim(), password: pwdInput.value})})
          .then(function(res){ return res.json().then(function(d){ return {ok:res.ok, d:d}; }); })
          .then(function(r){
            if(!r.ok){ errLine.textContent = r.d.error || '登录失败'; return; }
            setVisitor(r.d.token, r.d.grants || [], r.d.preset, r.d.playerProfile || null);
          })
          .catch(function(e){ errLine.textContent = String(e && e.message || e); });
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
      connectSSE();
      finish(t);
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
      buildNav();
      connectSSE();
      finish(tok);
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
    // 例外：玩家档（player）允许自己的入世界写操作（/api/player/*）
    var isPlayerOp = VISITOR_PRESET === 'player' && String(path).indexOf('/api/player') === 0;
    if(method !== 'GET' && !isPlayerOp){
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

// ---------- SSE ----------
function connectSSE(){
  if(evtSource) evtSource.close();
  var url = '/api/events?since=' + lastEventId;
  if(MODE === 'visitor'){ if(VISITOR_TOKEN) url += '&visitor=' + encodeURIComponent(VISITOR_TOKEN); }
  else if(TOKEN){ url += '&token=' + encodeURIComponent(TOKEN); }
  evtSource = new EventSource(url);
  evtSource.onopen = function(){ $('#sse-dot').className = 'on'; };
  evtSource.onerror = function(){ $('#sse-dot').className = 'off'; };
  evtSource.onmessage = function(ev){
    if(ev.lastEventId){
      var n = Number(ev.lastEventId) || 0;
      if(n > lastEventId){ lastEventId = n; localStorage.setItem('wui_last_id', String(n)); }
    }
    var msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    if(msg.channel === 'debug'){
      trackGen(msg.entry);
      if(msg.update){ updateFeedEntry(msg.entry); updateDebugEntry(msg.entry); }
      else { pushFeed(msg.entry); onDebugEntry(msg.entry); }
      renderLive();
    }
    else if(msg.channel === 'file'){ onFileSignal(msg.file); }
    else if(msg.channel === 'lifecycle'){ onLifecycle(msg.event, msg.detail); }
  };
}
function onDebugEntry(entry){
  if(activeView === 'debug') appendDebugEntry(entry);
}
function onFileSignal(file){
  // clock/botStatus 是高频信号（时钟每 TU 一跳）：无论当前在哪个视图都刷新总览，
  // 但要避免与下面的分支重复请求
  if(file === 'clock' || file === 'botStatus'){ refreshOverview(false); return; }
  if(file === 'news' || file === 'facts'){ refreshOverview(false); if(activeView === 'state') loadState(); return; }
  if(activeView === 'state') refreshState(file);
  else if(activeView === 'overview') refreshOverview(false);
  else if(activeView === 'gallery' && file === 'gallery') loadGallery();
  else if(activeView === 'media' && file === 'media') loadMedia();
  else if(activeView === 'data' && (file === 'notes' || file === 'data' || file === 'archive')) refreshData();
  // 仅当调试页当前就停在「工作窗口」子页时才刷新它——否则会把调试列表
  // （连同用户点开的条目）整个刷掉
  else if(activeView === 'debug' && file === 'stream' && debugSubview === 'stream') renderStreamTab();
}
function onLifecycle(event, detail){
  refreshOverview(false);
  if(activeView === 'gallery' && String(event).indexOf('gallery') === 0) loadGallery();
  if(activeView === 'devices' && String(event).indexOf('computer') === 0) refreshDevicesInfo();
}

// ---------- 实时生成跟踪（首页「正在生成」面板的数据源） ----------
// 按 id（时间序）有序插入并去重：SSE 推送与 /api/debug 种子化可能交错到达，
// 一律归位到正确的时间位置，保证列表永远是时间序（id 单调递增 = 现实时序）。
function pushFeed(e){
  for(var i=0;i<liveFeed.length;i++){
    if(liveFeed[i].id === e.id){ liveFeed[i] = e; return; }
    if(liveFeed[i].id > e.id) break;
  }
  if(i >= liveFeed.length) liveFeed.push(e);
  else liveFeed.splice(i, 0, e);
  if(liveFeed.length > 24) liveFeed.splice(0, liveFeed.length - 24);
}
function updateFeedEntry(e){
  for(var i=0;i<liveFeed.length;i++){ if(liveFeed[i].id === e.id){ liveFeed[i] = e; return; } }
  pushFeed(e);
}
function trackGen(e){
  if(e.kind !== 'llm.res' && e.kind !== 'llm.req') return;
  genMap[e.id] = e;
  var ids = Object.keys(genMap).map(Number).sort(function(a,b){ return a-b; });
  while(ids.length > 30){ delete genMap[ids.shift()]; }
}
function genEntries(){
  return Object.keys(genMap).map(function(k){ return genMap[k]; }).sort(function(a,b){ return b.id - a.id; });
}
function seedLive(){
  if(liveSeeded) return;
  liveSeeded = true;
  api('GET', '/api/debug?n=60').then(function(r){
    (r.entries || []).forEach(function(e){ pushFeed(e); trackGen(e); });
    renderLive();
  }).catch(function(){});
}

// ---------- 导航 ----------
// 第 4 项（可选）：访客可见所需的数据块（多个任一满足）；缺省则仅 admin 可见
var NAV = [
  {group:'观测'},
  ['overview','总览','gauge',['overview']],
  ['devices','设备','monitor',['devices']],
  ['debug','调试','activity',['debug']],
  ['usage','用量','chart',['usage']],
  {group:'世界'},
  ['state','状态','file',['world_status','bot_status','news','facts']],
  ['crossing','穿越','portal',['crossing']],
  ['player','入世界','portal',['__player__']],
  ['prompts','提示词','edit',['prompts']],
  ['gallery','相册','image',['gallery']],
  ['media','媒体','film',['gallery']],
  ['data','数据','folder',['notes','archive']],
  {group:'系统'},
  ['visitors','访客','users',['config']],
  ['config','配置','sliders',['config']],
];
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
function buildNav(){
  var nav = $('#nav');
  nav.textContent = '';
  var i = 0;
  while(i < NAV.length){
    // 注意：必须用 let（块级作用域），否则 onclick 闭包都捕获同一个循环变量，全部跳到最后一个导航项
    let it = NAV[i];
    if(it.group){
      // 该分组下若没有任何访客可见项，则连分组标签一起隐藏
      var groupName = it.group;
      var hasVisible = false;
      for(var j = i + 1; j < NAV.length && !NAV[j].group; j++){
        if(visitorCanSee(NAV[j][3])){ hasVisible = true; break; }
      }
      if(hasVisible) nav.appendChild(el('div', {cls:'nav-group', text: groupName}));
      i++;
      continue;
    }
    if(!visitorCanSee(it[3])){ i++; continue; }
    var a = el('a', {cls: it[0]===activeView?'active':''});
    a.appendChild(el('span', {cls:'ico', html: icon(it[2])}));
    a.appendChild(el('span', {text: it[1]}));
    a.onclick = function(){ switchView(it[0]); closeDrawer(); };
    nav.appendChild(a);
    i++;
  }
}
function clearViewTimers(){
  viewTimers.forEach(function(t){ clearInterval(t); });
  viewTimers = [];
  if(screenTimer){ clearInterval(screenTimer); screenTimer = null; }
}
function switchView(name){
  var changed = activeView !== name;
  activeView = name;
  if(location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  clearViewTimers();
  if(MODE === 'visitor') syncVisitorGrants();
  buildNav();
  // 切换视图时轻微淡入；同视图刷新不动画
  if(changed){
    var m = $('#main');
    m.classList.remove('anim');
    void m.offsetWidth;
    m.classList.add('anim');
  }
  if(name === 'overview') refreshOverview(true);
  else if(name === 'devices') loadDevices();
  else if(name === 'config') loadConfig();
  else if(name === 'prompts') loadPrompts();
  else if(name === 'state') loadState();
  else if(name === 'crossing') loadCrossing();
  else if(name === 'debug') loadDebug();
  else if(name === 'usage') loadUsage();
  else if(name === 'gallery') loadGallery();
  else if(name === 'media') loadMedia();
  else if(name === 'data') refreshData();
  else if(name === 'visitors') loadVisitors();
  else if(name === 'player') loadPlayer();
  else $('#main').textContent = '';
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

// ---------- 总览 ----------
function refreshOverview(full){
  api('GET', '/api/overview').then(function(o){
    lastOverview = o;
    VERSION = o.version || VERSION;
    renderTopbar(o);
    if(activeView !== 'overview') return;
    if(full === false && $('#ov-root')){ patchOverviewDynamic(o); return; }
    renderOverview(o);
  }).catch(function(err){ if(activeView==='overview') showErr(err); });
}
function renderOverview(o){
  seedLive();
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('世界总览', '观测一个活着的世界：运行状态、实时生成与世界事件。控制操作与聊天指令 world.* 等效。'));
  var root = el('div', {id:'ov-root'});
  // 英雄区：世界时钟 + 快捷控制
  var clockText = o.clock ? o.clock.timeLine : '——';
  var hero = el('div', {cls:'hero'}, [
    el('div', {cls:'hero-main'}, [
      el('div', null, [worldStatePill(o)]),
      el('div', {cls:'hero-clock', id:'ov-clock', text: clockText}),
      el('div', {cls:'hero-sub', id:'ov-sub', text: heroSub(o)}),
      isVisitor() ? null : el('div', {cls:'hero-actions'}, [
        el('button', {cls:'primary', text:'创世', title:'world.init：由 World-LLM 依据定义生成初始状态', onclick: function(){ worldAction('init', true); }}),
        el('button', {text:'开始', onclick: function(){ worldAction('start'); }}),
        el('button', {text:'暂停', onclick: function(){ worldAction('stop'); }}),
        el('button', {text:'重载定义', onclick: function(){ worldAction('reload'); }}),
        el('button', {text:'注入事件…', onclick: function(){
          var txt = prompt('注入到 Bot 意识流的事件内容（system 源，可唤醒等待）：');
          if(txt && txt.trim()) worldAction('inject', false, {text: txt.trim()});
        }}),
        (o.crossing && o.crossing.worlds && o.crossing.worlds.length)
          ? el('button', {text: o.crossing.location ? '穿越中…' : '穿越…', onclick: function(){ crossingModal(o); }})
          : null,
        el('button', {cls:'ghost', text:'更多', onclick: function(){ moreWorldActions(); }})
      ])
    ])
  ]);
  root.appendChild(hero);
  // 实时生成面板（SSE 驱动，renderLive 原地更新）
  root.appendChild(el('div', {id:'live-box'}));
  // 状态卡片
  root.appendChild(el('div', {cls:'cards', id:'ov-cards'}, overviewCards(o)));
  // 世界事件 + 访问安全
  var cols = el('div', {style:'display:grid;grid-template-columns:1fr;gap:0'});
  cols.appendChild(newsSection(o));
  cols.appendChild(factsSection(o));
  cols.appendChild(accessSection(o));
  root.appendChild(cols);
  main.appendChild(root);
  renderLive();
}
function patchOverviewDynamic(o){
  var c = $('#ov-clock'); if(c) c.textContent = o.clock ? o.clock.timeLine : '——';
  var s = $('#ov-sub'); if(s) s.textContent = heroSub(o);
  // 动态卡片/事件只在内容真正变化时才重建，否则高频刷新（时钟每 TU 一跳）会让整个面板闪跳
  var cards = $('#ov-cards');
  if(cards){
    var cardSig = overviewCards(o).map(function(x){ return x.textContent; }).join('|');
    if(cards.getAttribute('data-sig') !== cardSig){
      cards.setAttribute('data-sig', cardSig);
      cards.textContent = '';
      overviewCards(o).forEach(function(x){ cards.appendChild(x); });
    }
  }
  var newsBox = $('#ov-news');
  if(newsBox){
    var newsSig = JSON.stringify(o.news);
    if(newsBox.getAttribute('data-sig') !== newsSig){
      newsBox.setAttribute('data-sig', newsSig);
      newsBox.textContent = '';
      newsBox.appendChild(newsSection(o).querySelector('.body') || el('div'));
    }
  }
  var factsBox = $('#ov-facts');
  if(factsBox){
    var factsSig = JSON.stringify(o.facts);
    if(factsBox.getAttribute('data-sig') !== factsSig){
      factsBox.setAttribute('data-sig', factsSig);
      factsBox.textContent = '';
      factsBox.appendChild(factsSection(o).querySelector('.body') || el('div'));
    }
  }
}
function heroSub(o){
  if(!o.initialized) return '世界尚未创世——先编写定义，然后点击「创世」';
  if(!o.clock) return '世界时钟未启动';
  return o.clock.syncRealTime
    ? '世界时间与现实同步流逝'
    : '1 TU = ' + o.clock.unitRealSeconds + ' 现实秒 = ' + o.clock.unitWorldSeconds + ' 世界秒';
}
function worldStatePill(o){
  var st = worldStateText(o);
  return el('span', {cls:'pill ' + st[1], text: st[0]});
}
function overviewCards(o){
  function card(k, v, small){
    return el('div', {cls:'card'}, [el('div', {cls:'k', text:k}), el('div', {cls:'v' + (small?' small':''), text: String(v)})]);
  }
  var cards = [
    card('Bot-LLM', o.bot ? (o.bot.running ? '持续推理中' : '已停止') : '未启动'),
    card('工作窗口', o.bot ? (o.bot.streamLength + ' 条 · 约 ' + o.bot.approxChars + ' 字符') : '—', 'small'),
    card('等待中', o.bot && o.bot.waiting ? o.bot.waiting : (o.bot ? '否' : '—'), 'small'),
    card('进行中的动作', o.bot ? String(o.bot.pendingTasks) : '—'),
    card('World-LLM 队列', String(o.worldQueue)),
    card('手机', o.phoneDown ? '放在一边（通知震动）' : '在手边'),
    card('电脑', o.computerOn ? o.computerOn : '未开机'),
    card('关注频道', (o.focusChannels || []).length ? o.focusChannels.join('、') : '无', 'small')
  ];
  if(o.crossing && (o.crossing.location || (o.crossing.worlds && o.crossing.worlds.length))){
    cards.push(card('所在世界', o.crossing.location ? '异世界「' + o.crossing.location + '」' : '自己的世界', o.crossing.location ? '' : 'small'));
  }
  if(o.crossing && o.crossing.serverEnabled){
    var vs = o.crossing.visitors || [];
    cards.push(card('异世界访客', vs.length ? vs.map(function(v){ return v.name; }).join('、') : '无', vs.length ? '' : 'small'));
  }
  if(o.appOpen) cards.push(card('手机应用', o.appOpen));
  (o.galleryCounts || []).forEach(function(g){ cards.push(card('相册 · ' + g.category, String(g.count))); });
  return cards;
}
function newsSection(o){
  var body = el('div', {cls:'body'});
  var news = o.news || [];
  if(news.length){
    news.forEach(function(n){
      body.appendChild(el('div', {cls:'news-item'}, [
        el('span', {cls:'clock', text:'[' + n.clock + ']'}),
        el('span', {text: ' ' + n.content, style:'font-size:12.5px'})
      ]));
    });
  } else {
    body.appendChild(el('p', {cls:'empty', text:'（还没有任何事件）'}));
  }
  return el('div', {cls:'section'}, [
    el('h3', {html:'最近的世界事件 <span class="hint">完整编辑在「状态」页</span>'}),
    el('div', {id:'ov-news'}, [body])
  ]);
}
function factsSection(o){
  var body = el('div', {cls:'body'});
  var facts = (o.facts || []).slice().reverse(); // 时间倒序：最新在前
  if(facts.length){
    facts.forEach(function(n){
      body.appendChild(el('div', {cls:'news-item'}, [
        el('span', {cls:'clock', text:'[' + n.clock + ']'}),
        el('span', {text: ' ' + n.content, style:'font-size:12.5px'})
      ]));
    });
  } else {
    body.appendChild(el('p', {cls:'empty', text:'（还没有任何小事）'}));
  }
  return el('div', {cls:'section'}, [
    el('h3', {html:'最近的小事记 <span class="hint">Bot 的私人小事，完整编辑在「状态」页</span>'}),
    el('div', {id:'ov-facts'}, [body])
  ]);
}
function accessSection(o){
  var body = el('div', {cls:'body'});
  (o.addresses || []).forEach(function(a){
    body.appendChild(el('div', {cls:'addr-row'}, [
      el('span', {cls:'tag', text: a.label}),
      el('span', {cls:'u', text: a.url}),
      el('button', {text:'复制', style:'padding:2px 9px;font-size:11.5px', onclick:function(){ copyText(a.url); }})
    ]));
  });
  body.appendChild(el('div', {cls:'kv', style:'margin-top:4px'}, [
    el('span', {cls:'k', text:'访问令牌'}),
    el('span', {cls:'v', html: o.tokenSet
      ? '<span style="color:var(--ok)">已启用（webui.token）</span>'
      : '<span style="color:var(--warn)">未设置 —— 任何人打开地址即可操作</span>'})
  ]));
  var guide = el('details', null, [
    el('summary', {text:'如何开放到公网 / 从其他设备访问', style:'font-size:12.5px;color:var(--fg-dim)'}),
    el('div', {cls:'guide', html:
      '<p><b>局域网 / 其他设备访问</b>：把配置 <code>webui.host</code> 改为 <code>0.0.0.0</code>，并务必设置 <code>webui.token</code>（强随机串）。</p>' +
      '<p><b>公网访问（推荐：反向代理）</b>：用 Caddy / Nginx 挂到域名下并启用 HTTPS，转发到本服务端口；令牌照常生效。</p>' +
      '<p><b>公网访问（无公网 IP：内网穿透）</b>：用 cloudflared、frp 等隧道把 <code>127.0.0.1:' + (location.port || '18111') + '</code> 暴露出去，同样务必先设令牌。</p>' +
      '<p style="color:var(--err)">切勿在未设置令牌的情况下把 WebUI 直接暴露到公网——它能执行世界控制与电脑命令。</p>'
    })
  ]);
  body.appendChild(el('div', {style:'margin-top:8px'}, [guide]));
  return el('div', {cls:'section'}, [
    el('h3', {html:'访问与安全 <span class="hint">把这个观测台带到任何地方</span>'}),
    body
  ]);
}
// 实时生成面板：Bot-LLM / World-LLM 各自一块（生成状态 + 本侧活动流），原地更新
function renderLive(){
  var box = $('#live-box');
  if(!box) return;
  if(!box.querySelector('.live-grid')){
    box.textContent = '';
    var grid = el('div', {cls:'live-grid'});
    grid.appendChild(livePanel('Bot'));
    grid.appendChild(livePanel('World'));
    box.appendChild(grid);
  }
  updateLiveSide('Bot');
  updateLiveSide('World');
  renderFeedRows('Bot');
  renderFeedRows('World');
}
function livePanel(who){
  return el('div', {cls:'live', id:'live-' + who}, [
    el('div', {cls:'head'}, [
      el('span', {cls:'pill', text:'空闲'}),
      el('span', {cls:'who', text: who + '-LLM'}),
      el('span', {cls:'ms'})
    ]),
    el('div', {cls:'body idle-txt', text:'（还没有生成记录）'}),
    el('div', {cls:'feed', id:'feed-' + who})
  ]);
}
// 条目归侧：bot.* 与 Bot·/解释器· 开头的 llm 条目归 Bot；world.* 与 World· 归 World
function sideOf(e){
  if(e.kind === 'bot.tool' || e.kind === 'bot.event') return 'Bot';
  if(e.kind === 'world.task' || e.kind === 'world.result' || e.kind === 'world.tool') return 'World';
  if(e.kind === 'llm.req' || e.kind === 'llm.res'){
    return e.label.indexOf('World·') === 0 ? 'World' : 'Bot';
  }
  return null;
}
// 找出该 LLM 的：正在流式生成的条目 / 最近完成的条目 / 最近的请求
function sideEntry(who){
  var entries = genEntries();
  var current = null, lastDone = null, waiting = null;
  for(var i=0;i<entries.length;i++){
    var e = entries[i];
    if(e.label.indexOf(who + '·') !== 0) continue;
    if(e.kind === 'llm.res'){
      if(e.label.indexOf('流式') >= 0){ current = e; break; }
      if(!lastDone) lastDone = e;
    } else if(e.kind === 'llm.req' && !waiting){
      waiting = e;
    }
  }
  return {current: current, lastDone: lastDone, waiting: waiting};
}
function updateLiveSide(who){
  var panel = $('#live-' + who);
  if(!panel) return;
  var s = sideEntry(who);
  var pill = panel.querySelector('.pill');
  var ms = panel.querySelector('.ms');
  var body = panel.querySelector('.body');
  if(s.current){
    panel.classList.add('gen');
    pill.className = 'pill run';
    pill.textContent = '生成中';
    ms.textContent = s.current.label;
    setLiveBody(body, extractTail(s.current), false);
    return;
  }
  panel.classList.remove('gen');
  if(s.waiting && (!s.lastDone || s.waiting.id > s.lastDone.id)){
    pill.className = 'pill run';
    pill.textContent = '等待响应';
    ms.textContent = s.waiting.label;
    setLiveBody(body, '（请求已发送，等待首个分片…）', true);
    return;
  }
  pill.className = 'pill';
  pill.textContent = '空闲';
  if(s.lastDone){
    ms.textContent = '最近完成：' + s.lastDone.label;
    setLiveBody(body, extractTail(s.lastDone), true);
  } else {
    ms.textContent = '';
    setLiveBody(body, '（还没有生成记录）', true);
  }
}
// 原地写内容：仅在用户本来贴底时才自动跟滚，否则保持其阅读位置
function setLiveBody(body, text, idle){
  body.classList.toggle('idle-txt', !!idle);
  if(body.textContent === text) return;
  var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  body.textContent = text;
  if(atBottom) body.scrollTop = body.scrollHeight;
}
function extractTail(e){
  var tail = '';
  try {
    var d = JSON.parse(e.detail);
    tail = d.content || '';
    if(!tail && d.tool_calls && d.tool_calls.length) tail = '（工具调用）' + JSON.stringify(d.tool_calls).slice(0, 400);
  } catch(err){}
  if(tail.length > 900) tail = '…' + tail.slice(-900);
  return tail || '（…）';
}
// 各侧活动流：收进各自面板，llm 条目剥掉冗余的侧前缀。
// 增量渲染：仅当条目集合（id 序列）变化时才整体重建；集合不变时只原地刷新
// 流式更新的时间/标签——避免每个事件都清空重建导致整个面板闪跳。
function renderFeedRows(who){
  var box = $('#feed-' + who);
  if(!box) return;
  var rows = liveFeed.filter(function(e){ return sideOf(e) === who; }).slice(-6).reverse();
  var sig = rows.map(function(e){ return e.id; }).join(',');
  if(box.getAttribute('data-sig') !== sig){
    box.textContent = '';
    box.setAttribute('data-sig', sig);
    if(!rows.length){ box.appendChild(el('div', {cls:'empty', text:'（还没有动静）'})); return; }
    rows.forEach(function(e){ box.appendChild(feedRow(e)); });
    return;
  }
  rows.forEach(function(e, i){
    var row = box.children[i];
    if(!row) return;
    var t = row.querySelector('.t'); if(t && t.textContent !== fmtTime(e.ts)) t.textContent = fmtTime(e.ts);
    var tag = row.querySelector('.tag'); if(tag && tag.textContent !== e.kind){ tag.textContent = e.kind; tag.className = 'tag ' + tagClass(e); }
    var l = row.querySelector('.l'); if(l && l.textContent !== e.label) l.textContent = e.label;
  });
}
function feedRow(e){
  var label = e.label;
  if(e.kind === 'llm.req' || e.kind === 'llm.res') label = label.replace(/^(Bot|World|解释器)·/, '');
  return el('div', {cls:'feed-row'}, [
    el('span', {cls:'t', text: fmtTime(e.ts)}),
    el('span', {cls:'tag ' + tagClass(e), text: e.kind}),
    el('span', {cls:'l', text: label})
  ]);
}
function tagClass(e){
  if(e.kind === 'llm.req') return 'req';
  if(e.kind === 'llm.res') return 'res';
  if(e.kind === 'bot.tool' || e.kind === 'world.tool') return 'tool';
  if(e.kind === 'bot.event' || e.kind === 'world.task' || e.kind === 'world.result') return 'event';
  if(e.level === 'error') return 'err';
  return '';
}
// 穿越面板：强制把 Bot 送往某个异世界 / 送回自己的世界
function crossingModal(o){
  var c = o.crossing || {};
  var body = el('div');
  body.appendChild(el('p', {
    style:'color:var(--fg-dim);font-size:12.5px;margin:0 0 10px',
    text: c.location ? ('Bot 正在异世界「' + c.location + '」作客。') : 'Bot 在自己的世界里。强制送往（无视「允许主动前往」开关）：'
  }));
  function doTravel(target, label){
    api('POST', '/api/crossing/travel', {world: target}).then(function(r){
      toast(r.text, 'ok');
      hideModal();
      refreshOverview(true);
    }).catch(function(err){ toast(label + '失败：' + (err.message || err), 'err'); });
  }
  (c.worlds || []).forEach(function(w){
    if(c.location === w.name) return;
    body.appendChild(el('div', {cls:'kv'}, [
      el('span', {cls:'k', text: w.name + (w.note ? ' · ' + w.note : '') + (w.allowVoluntary ? '' : '（Bot 不可主动前往）')}),
      el('button', {text:'送往', onclick:function(){
        if(!confirm('把 Bot 强制送往「' + w.name + '」？')) return;
        doTravel(w.name, '穿越');
      }})
    ]));
  });
  if(c.location){
    body.appendChild(el('div', {cls:'toolbar', style:'margin:12px 0 0'}, [
      el('button', {cls:'primary', text:'送回自己的世界', onclick:function(){ doTravel('home', '送回'); }})
    ]));
  }
  showModal('穿越', body);
}

function moreWorldActions(){
  var body = el('div');
  [
    ['reset', '重置世界', '确认重置世界？所有运行时状态将被归档清空（定义文件与固定的小事记保留）。', 'danger'],
    ['clearmsg', '清空消息记录', '确认清空聊天消息记录？（媒体缓存与世界状态不受影响）', ''],
    ['init -f', '重新创世 -f', '强制重新创世：将归档清空当前世界并重新生成初始状态，不可撤销。确认？', 'danger'],
  ].forEach(function(it){
    body.appendChild(el('div', {cls:'kv'}, [
      el('span', {cls:'k', text: it[1]}),
      el('button', {cls: it[3], text:'执行', onclick: function(){
        if(!confirm(it[2])) return;
        hideModal();
        if(it[0] === 'init -f') worldAction('init', false, {force:true});
        else worldAction(it[0]);
      }})
    ]));
  });
  showModal('更多世界操作', body);
}
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

// ---------- 设备 ----------
function loadDevices(){
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('设备', '窥视 Bot 的电脑与手机：电脑看屏幕（远程桌面）或开终端（Docker），手机看界面状态。'));
  var holder = el('div', {id:'dev-root'}, [el('p', {cls:'empty', text:'加载中…'})]);
  main.appendChild(holder);
  refreshDevicesInfo();
  viewTimers.push(setInterval(refreshDevicesInfo, 5000));
}
function refreshDevicesInfo(){
  api('GET', '/api/devices').then(function(d){
    var modeChanged = !devicesCache || devicesCache.computer.mode !== d.computer.mode;
    devicesCache = d;
    if(activeView !== 'devices') return;
    var root = $('#dev-root');
    if(!root) return;
    if(!root.querySelector('.dev-grid') || modeChanged){
      renderDevices();
      ensureScreenTimer();
      return;
    }
    // 原地更新：只刷新电脑状态行与手机面板，避免打断终端输入与窥屏
    var compStatus = $('#comp-status');
    if(compStatus && d.computer.docker) compStatus.replaceWith(dockerStatus(d.computer.docker));
    var phoneSec = $('#phone-sec');
    if(phoneSec) phoneSec.replaceWith(phonePanel(d));
    ensureScreenTimer();
  }).catch(function(err){
    if(activeView === 'devices') showErr(err);
  });
}
function renderDevices(){
  var root = $('#dev-root');
  if(!root || !devicesCache) return;
  var d = devicesCache;
  root.textContent = '';
  var grid = el('div', {cls:'dev-grid'});
  grid.appendChild(computerPanel(d));
  grid.appendChild(phonePanel(d));
  root.appendChild(grid);
}
function computerPanel(d){
  var c = d.computer;
  var modeText = c.mode === 'docker' ? 'Docker 容器' : (c.mode === 'remote_desktop' ? '远程桌面' : '未启用');
  var head = el('h3', {html:'电脑 <span class="hint">' + modeText + '</span>'});
  var body = el('div', {cls:'body', id:'comp-body'});
  if(c.on) head.appendChild(el('span', {cls:'mode-badge on', text: c.on + ' 打开中', style:'margin-left:auto'}));
  if(c.mode === 'off'){
    body.appendChild(el('p', {cls:'empty', text:'电脑未启用。开启后 Bot 会拥有一台自己的电脑：Docker 容器（终端/文件）或远程桌面（看屏幕、动鼠标键盘）。'}));
    if(!isVisitor()) body.appendChild(el('button', {text:'前往配置开启', onclick:function(){ gotoCfg('apps'); }}));
  } else if(c.mode === 'docker'){
    body.appendChild(dockerStatus(c.docker));
    if(!isVisitor()){
      body.appendChild(el('div', {cls:'toolbar'}, [
        el('button', {cls:'primary', text:'开机', onclick:function(){ computerAction('start'); }}),
        el('button', {text:'关机', onclick:function(){ if(confirm('关闭 Bot 的电脑？容器数据保留，Bot 的终端会暂时不可用。')) computerAction('stop'); }}),
        el('button', {text:'重启', onclick:function(){ if(confirm('重启 Bot 的电脑容器？')) computerAction('restart'); }}),
      ]));
      body.appendChild(el('div', {cls:'crumb', text:'终端控制台（运维用途，命令在容器内执行）'}));
      body.appendChild(termBox());
    }
  } else {
    body.appendChild(remotePanel(c));
  }
  return el('div', {cls:'section', style:'margin-bottom:0'}, [head, body]);
}
function dockerStatus(st){
  if(!st) return el('p', {cls:'empty', text:'（无法获取容器状态）'});
  var rows = el('div', {id:'comp-status'});
  function row(k, v, color){
    rows.appendChild(el('div', {cls:'kv'}, [
      el('span', {cls:'k', text:k}),
      el('span', {cls:'v', html: color ? '<span style="color:' + color + '">' + esc(v) + '</span>' : esc(v)})
    ]));
  }
  if(st.error){
    row('检测', st.error, 'var(--err)');
  } else if(!st.exists){
    row('容器', '尚未创建（首次开机时自动创建）', 'var(--fg-dark)');
  } else {
    row('状态', st.running ? '运行中' : ('已停止（' + (st.status || 'exited') + '）'), st.running ? 'var(--ok)' : 'var(--warn)');
  }
  row('容器名', st.name || '—');
  row('镜像', st.image || '—');
  if(st.startedAt) row('启动于', st.startedAt.replace('T', ' ').slice(0, 19));
  return rows;
}
function computerAction(action){
  var label = {start:'开机', stop:'关机', restart:'重启'}[action];
  api('POST', '/api/computer/action', {action: action}).then(function(r){
    toast(label + '：' + r.text, 'ok');
    refreshDevicesInfo();
  }).catch(function(err){ toast(label + '失败：' + (err.message || err), 'err'); });
}
function termBox(){
  var wrap = el('div');
  var term = el('div', {cls:'term', id:'term'});
  renderTerm(term);
  var inp = el('input', {placeholder:'输入命令，回车执行（如 ls -la）', id:'term-inp'});
  inp.value = execDraft;
  inp.oninput = function(){ execDraft = inp.value; };
  function run(){
    var cmd = inp.value.trim();
    if(!cmd || execBusy) return;
    execBusy = true;
    execDraft = '';
    inp.value = '';
    execHistory.push({cmd: cmd, out: '（执行中…）', code: null, pending: true});
    renderTerm(term);
    api('POST', '/api/computer/exec', {command: cmd}).then(function(r){
      var h = execHistory[execHistory.length - 1];
      h.out = r.output; h.code = r.code; h.pending = false;
      renderTerm(term);
    }).catch(function(err){
      var h = execHistory[execHistory.length - 1];
      h.out = '（请求失败：' + (err.message || err) + '）'; h.code = -1; h.pending = false;
      renderTerm(term);
    }).finally(function(){ execBusy = false; });
  }
  inp.onkeydown = function(e){ if(e.key === 'Enter') run(); };
  wrap.appendChild(term);
  wrap.appendChild(el('div', {cls:'term-input'}, [
    inp,
    el('button', {cls:'primary', text:'执行', onclick: run})
  ]));
  return wrap;
}
function renderTerm(term){
  term.textContent = '';
  if(!execHistory.length){
    term.appendChild(el('div', {cls:'out', text:'（还没有执行过命令）'}));
    return;
  }
  execHistory.slice(-30).forEach(function(h){
    term.appendChild(el('div', {cls:'cmd', text: h.cmd}));
    var cls = 'out' + (h.code != null && h.code !== 0 && !h.pending ? ' code-err' : '');
    term.appendChild(el('div', {cls: cls, text: h.out + (h.code != null && !h.pending ? NL + '[exit ' + h.code + ']' : '')}));
  });
  term.scrollTop = term.scrollHeight;
}
function remotePanel(c){
  var wrap = el('div');
  var box = el('div', {cls:'screen-box'});
  var img = el('img', {id:'scr-img', alt:''});
  img.onclick = function(){ if(img.src) showImage('远程桌面', img.src); };
  box.appendChild(img);
  box.appendChild(el('div', {cls:'screen-err', id:'scr-err', text:'连接中…'}));
  wrap.appendChild(box);
  wrap.appendChild(el('div', {cls:'toolbar'}, [
    el('span', {cls:'crumb', text: (c.remote ? c.remote.host + ':' + c.remote.port : '') + ' · 每 3 秒自动刷新'}),
    el('span', {cls:'spacer'}),
    el('button', {text:'立即刷新', onclick:function(){ pollScreen(); }})
  ]));
  return wrap;
}
function ensureScreenTimer(){
  if(!devicesCache || devicesCache.computer.mode !== 'remote_desktop') return;
  if(screenTimer) return;
  pollScreen();
  screenTimer = setInterval(pollScreen, 3000);
}
function pollScreen(){
  if(activeView !== 'devices' || !devicesCache || devicesCache.computer.mode !== 'remote_desktop') return;
  if(screenBusy) return;
  screenBusy = true;
  fetch(withToken('/api/computer/screen?w=1280&t=' + Date.now())).then(function(res){
    if(!res.ok) return res.json().then(function(d){ throw new Error((d && d.error) || ('HTTP ' + res.status)); });
    return res.blob();
  }).then(function(blob){
    var img = $('#scr-img');
    if(!img) return;
    if(screenUrl) URL.revokeObjectURL(screenUrl);
    screenUrl = URL.createObjectURL(blob);
    img.src = screenUrl;
    var err = $('#scr-err');
    if(err) err.style.display = 'none';
  }).catch(function(e){
    var err = $('#scr-err');
    if(err){ err.style.display = 'flex'; err.textContent = '无法窥屏：' + (e.message || e); }
  }).finally(function(){ screenBusy = false; });
}
function phonePanel(d){
  var p = d.phone;
  var clock = lastOverview && lastOverview.clock ? lastOverview.clock.timeLine.slice(11) : '--:--';
  var scr = el('div', {cls:'scr' + (p.down ? ' off' : '')});
  // 屏幕比例跟随手机分辨率（配置显式指定 > 创世判定 > 默认 800x1280）
  var res = p.resolution && p.resolution.width > 0 && p.resolution.height > 0 ? p.resolution : {width: 800, height: 1280};
  scr.style.aspectRatio = res.width + ' / ' + res.height;
  scr.style.minHeight = '0';
  scr.appendChild(el('div', {cls:'notch'}));
  scr.appendChild(el('div', {cls:'statusbar'}, [el('span', {text: clock}), el('span', {text: p.down ? '○ 免打扰' : '● 在线'})]));
  if(p.down){
    scr.appendChild(el('div', {cls:'offmsg'}, [
      el('div', {html: icon('phone'), style:'width:34px;height:34px;opacity:.5'}),
      el('div', {text:'手机放在一边'}),
      el('div', {text:'来消息只会震一下，Bot 看不到内容', style:'font-size:11px'})
    ]));
  } else if(p.appOpen){
    var kids = [el('div', {cls:'app-name', text: p.appOpen})];
    if(p.chatOpen && p.channelKey){
      kids.push(el('div', {cls:'chan'}, [
        el('div', {text: (p.channelIsGroup ? '群聊' : '私聊') + ' · ' + p.channelKey, style:'color:var(--fg)'}),
        el('div', {text:'正在看这个频道的聊天', style:'font-size:11px;margin-top:2px'})
      ]));
    } else if(p.chatOpen){
      kids.push(el('div', {cls:'chan', text:'聊天列表'}));
    } else {
      kids.push(el('div', {cls:'chan', text:'应用打开中'}));
    }
    scr.appendChild(el('div', {cls:'appview'}, kids));
  } else {
    var home = el('div', {cls:'home'});
    [[p.chatAppName || 'QQ', '💬'], ['天气', '🌤'], ['浏览器', '🌐'], ['新闻', '📰'], ['记事本', '📝']].forEach(function(a){
      home.appendChild(el('div', {cls:'appdot'}, [el('i', {text: a[1]}), el('span', {text: a[0]})]));
    });
    scr.appendChild(home);
  }
  scr.appendChild(el('div', {cls:'dock'}, [el('i')]));
  var phone = el('div', {cls:'phone'}, [scr]);
  var body = el('div', {cls:'body'}, [
    phone,
    el('div', {style:'margin-top:12px'}, [
      el('div', {cls:'kv'}, [el('span', {cls:'k', text:'状态'}), el('span', {cls:'v', text: p.down ? '放在一边' : '在手边'})]),
      el('div', {cls:'kv'}, [el('span', {cls:'k', text:'打开的应用'}), el('span', {cls:'v', text: p.appOpen || '（无）'})]),
      el('div', {cls:'kv'}, [el('span', {cls:'k', text:'聊天频道'}), el('span', {cls:'v', text: p.chatOpen && p.channelKey ? p.channelKey : '—'})]),
      el('div', {cls:'kv'}, [el('span', {cls:'k', text:'屏幕分辨率'}), el('span', {cls:'v', text: res.width + ' × ' + res.height})])
    ])
  ]);
  return el('div', {cls:'section', id:'phone-sec', style:'margin-bottom:0'}, [el('h3', {html:'手机 <span class="hint">界面实时状态</span>'}), body]);
}
function gotoCfg(gkey){
  cfgGroup = gkey;
  switchView('config');
}

// ---------- 配置 ----------
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

// ---------- 玩家入世界（真人角色扮演） ----------
function loadPlayer(){
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('入世界', '以你的角色身份进入这个虚拟世界，通过行动与世界互动。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  // 首次：无角色身份 → 先填角色
  if(!VISITOR_PLAYER_PROFILE || !VISITOR_PLAYER_PROFILE.name){
    holder.textContent = '';
    holder.appendChild(playerProfileForm(function(){
      loadPlayer();
    }));
    return;
  }
  // 已有角色身份：显示世界观状态 + 入世界/剧情流
  holder.textContent = '';
  playerRenderWorld(holder);
}

function playerProfileForm(done){
  var nameInp = el('input', {placeholder:'角色名（世界里的身份）', style:'width:100%'});
  var personaTa = el('textarea', {rows: 6, placeholder:'角色人设：你是谁、什么性格、什么来历……（世界会根据它来让 NPC/Bot 认识你）', style:'width:100%'});
  if(VISITOR_PLAYER_PROFILE){
    nameInp.value = VISITOR_PLAYER_PROFILE.name || '';
    personaTa.value = VISITOR_PLAYER_PROFILE.persona || '';
  }
  var err = el('p', {style:'color:var(--err);font-size:12.5px;min-height:16px'});
  var form = el('div', {cls:'section'}, [
    el('h3', {text:'你的角色身份'}),
    el('div', {cls:'body'}, [
      el('label', {text:'角色名'}), nameInp,
      el('label', {text:'人设'}), personaTa,
      err,
      el('div', {cls:'toolbar', style:'margin-top:10px'}, [
        el('button', {cls:'primary', text:'保存并进入世界', onclick:function(){
          var name = nameInp.value.trim();
          if(!name){ err.textContent = '角色名不能为空'; return; }
          var profile = {name: name, persona: personaTa.value.trim()};
          api('PUT', '/api/player/profile', profile).then(function(){
            VISITOR_PLAYER_PROFILE = profile;
            localStorage.setItem('wui_player_profile', JSON.stringify(profile));
            toast('角色身份已保存', 'ok');
            done();
          }).catch(function(e){ err.textContent = e.message || e; });
        }})
      ])
    ])
  ]);
  return form;
}

function playerRenderWorld(holder){
  // 世界运行状态 + 入世界/剧情
  var profile = VISITOR_PLAYER_PROFILE;
  holder.textContent = '';
  // 顶部：角色身份 + 入世界状态
  var head = el('div', {cls:'section'}, [
    el('h3', {html:'角色 <span class="hint">' + esc(profile.name) + '</span>'}),
    el('div', {cls:'body'}, [
      el('p', {text:'以「' + profile.name + '」的身份进入世界，用行动推动剧情。', style:'color:var(--fg-dim);font-size:13px'})
    ])
  ]);
  holder.appendChild(head);

  if(!PLAYER_STATE.inWorld){
    // 未入世界：显示「进入世界」按钮
    var enterBar = el('div', {cls:'section'}, [
      el('h3', {text:'进入世界'}),
      el('div', {cls:'body'}, [
        el('p', {text:'点击进入世界，你的角色会出现在世界里，可以开始行动。', style:'color:var(--fg-dim);font-size:13px'}),
        el('button', {cls:'primary', text:'进入世界', onclick:function(){ playerArrive(); }})
      ])
    ]);
    holder.appendChild(enterBar);
  } else {
    holder.appendChild(playerWorldPanel());
  }
  // 世界剧情（世界状态+新闻，只读）
  holder.appendChild(playerWorldStatus());
}

function playerArrive(){
  api('POST', '/api/player/arrive', {}).then(function(r){
    PLAYER_STATE.token = r.token;
    PLAYER_STATE.worldName = r.worldName || '';
    PLAYER_STATE.inWorld = true;
    PLAYER_STATE.events = [];
    toast('已进入世界', 'ok');
    playerConnectEvents(r.token);
    loadPlayer();
  }).catch(showErr);
}

function playerWorldPanel(){
  var box = el('div', {cls:'section'});
  box.appendChild(el('h3', {html:'世界互动 <span class="hint">' + esc(PLAYER_STATE.worldName || '') + '</span>'}));
  var body = el('div', {cls:'body'});
  // 剧情流
  var feed = el('div', {id:'player-feed', style:'max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:12px'});
  body.appendChild(feed);
  playerRenderFeed(feed);
  // act 提交
  var actInp = el('textarea', {rows: 3, placeholder:'描述你的角色想做什么（例如：走向吧台，向老板要一杯酒）', style:'width:100%'});
  var err = el('p', {style:'color:var(--err);font-size:12.5px;min-height:16px'});
  body.appendChild(el('div', {cls:'toolbar', style:'margin:8px 0 0'}, [actInp]));
  var actBtn = el('button', {cls:'primary', text:'行动', onclick:function(){ playerSubmitAct(actInp, err, feed, actBtn); }});
  body.appendChild(el('div', {cls:'toolbar', style:'margin:4px 0 0'}, [
    el('span', {id:'player-act-state', style:'color:var(--fg-dark);font-size:12px', text: PLAYER_STATE.actBusy ? '等待世界裁定中…' : ''}),
    el('span', {cls:'spacer'}),
    actBtn,
    el('button', {cls:'ghost', text:'离开世界', onclick:function(){ playerLeave(); }})
  ]));
  box.appendChild(body);
  return box;
}

function playerRefreshActState(){
  var st = $('#player-act-state');
  if(st) st.textContent = PLAYER_STATE.actBusy ? '等待世界裁定中…' : '';
  var btns = $('#main').querySelectorAll('button');
  // 行动按钮禁用状态跟随 actBusy（宽泛匹配：不影响其它按钮，仅文字为「行动」者）
  btns.forEach(function(b){ if(b.textContent === '行动'){ b.disabled = !!PLAYER_STATE.actBusy; } });
}

function playerRenderFeed(feed){
  feed.textContent = '';
  if(!PLAYER_STATE.events.length){
    feed.appendChild(el('p', {cls:'empty', text:'（还没有剧情——行动后世界会告诉你发生了什么）'}));
    return;
  }
  PLAYER_STATE.events.forEach(function(ev){
    feed.appendChild(el('div', {style:'padding:6px 0;border-bottom:1px solid var(--line)', html: '<span style="color:var(--warn)">【世界】</span> ' + esc(ev.content)}));
  });
  feed.scrollTop = feed.scrollHeight;
}

function playerSubmitAct(actInp, err, feed, actBtn){
  var desc = actInp.value.trim();
  if(!desc){ err.textContent = '请描述你的角色想做什么'; return; }
  if(PLAYER_STATE.actBusy){ err.textContent = '上一个行动还在裁定中'; return; }
  err.textContent = '';
  // 尊重 duration：提交后等待，结果异步推送
  PLAYER_STATE.actBusy = true;
  actInp.value = '';
  playerRefreshActState();
  var taskId = 'p_' + Date.now() + '_' + Math.floor(Math.random()*1e6);
  api('POST', '/api/player/task', {token: PLAYER_STATE.token, taskId: taskId, kind: 'act', payload: {desc: desc}}).then(function(){
    // 已受理，等待 SSE 的 task_result
  }).catch(function(e){
    PLAYER_STATE.actBusy = false;
    playerRefreshActState();
    err.textContent = e.message || e;
  });
}

function playerLeave(){
  api('POST', '/api/player/leave', {token: PLAYER_STATE.token}).then(function(){
    PLAYER_STATE.inWorld = false;
    PLAYER_STATE.token = '';
    PLAYER_STATE.events = [];
    toast('已离开世界', 'ok');
    loadPlayer();
  }).catch(showErr);
}

function playerConnectEvents(token){
  // 注意：EventSource 无法带 header，需用 URL 参数携带两层 token：
  // - visitor=访客会话 token（webui /api/player/* 鉴权）
  // - ctoken=crossing session token（转发到 crossing /events）
  var es = new EventSource('/api/player/events?visitor=' + encodeURIComponent(VISITOR_TOKEN) + '&ctoken=' + encodeURIComponent(token));
  es.onmessage = function(ev){
    var msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    if(msg.type === 'event' && msg.content){
      PLAYER_STATE.events.push({type:'world', content: msg.content});
      playerRefreshFeed();
    } else if(msg.type === 'task_result'){
      // act 完成：解「等待裁定」锁。剧情已通过 event 实时推送，这里不重复聚合内容
      PLAYER_STATE.actBusy = false;
      if(!msg.ok) toast('行动裁定失败', 'err');
      // 刷新「等待中」提示（actBusy 已变 false，重渲染面板）
      playerRefreshActState();
    } else if(msg.type === 'farewell'){
      PLAYER_STATE.inWorld = false;
      PLAYER_STATE.token = '';
      toast(msg.reason || '世界送别了你', 'warn');
      loadPlayer();
    }
  };
  es.onopen = function(){ console.log('[player] SSE 已连接'); };
  es.onerror = function(){
    // EventSource 自动重连；首次失败提示（便于排查）
    console.warn('[player] SSE 连接出错，将自动重连');
  };
}

function playerRefreshFeed(){
  var feed = $('#player-feed');
  if(feed) playerRenderFeed(feed);
}

function playerWorldStatus(){
  var sec = el('div', {cls:'section'});
  sec.appendChild(el('h3', {text:'世界观剧情（只读）'}));
  var body = el('div', {cls:'body'});
  var holder = el('div', {text:'加载中…', cls:'empty'});
  body.appendChild(holder);
  sec.appendChild(body);
  api('GET', '/api/state').then(function(r){
    holder.textContent = '';
    // 世界状态 + 新闻（player 可见的数据块）
    if(r.worldStatus) holder.appendChild(el('div', {cls:'body', html:'<div style="white-space:pre-wrap;font-size:12.5px">' + esc(r.worldStatus) + '</div>'}));
    if(r.news && r.news.length){
      holder.appendChild(el('h4', {text:'最近事件'}));
      r.news.forEach(function(n){
        holder.appendChild(el('div', {cls:'news-item'}, [
          el('span', {cls:'clock', text:'[' + n.clock + ']'}),
          el('span', {text: ' ' + n.content, style:'font-size:12.5px'})
        ]));
      });
    }
    if(!r.worldStatus && (!r.news || !r.news.length)){
      holder.appendChild(el('p', {cls:'empty', text:'（暂无世界剧情）'}));
    }
  }).catch(showErr);
  return sec;
}

// ---------- 访客账号管理 ----------
var GRANT_LABELS = [
  ['overview','总览'], ['world_status','世界状态'], ['bot_status','Bot 状态'], ['news','新闻'], ['facts','小事记'],
  ['stream','意识流'], ['notes','笔记'], ['gallery','相册/媒体'], ['archive','归档'], ['devices','设备'],
  ['crossing','穿越'], ['definitions','定义文件'], ['config','配置'], ['prompts','提示词'], ['debug','调试(原始请求)'], ['usage','用量']
];
var PRESET_LABELS = { operator:'运维员', viewer:'观众', player:'玩家', custom:'自定义' };
function loadVisitors(){
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('访客账号', '创建只读访客账号，分别控制各自可浏览的数据。运维员可看全部（含调试原始请求）但不含 Bot 状态；观众看世界演化产物（含 Bot 状态），屏蔽定义/配置/调试。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/visitors').then(function(r){
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
        el('div', {cls:'hint', text: PRESET_LABELS[v.preset] + ' · 创建于 ' + fmtTime(v.createdAt), style:'font-size:11.5px;color:var(--fg-dark)'})
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
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('配置', isVisitor() ? '只读模式：可浏览配置，无法修改。' : '按重要程度分层：常用项直接展开，高级项收起。保存后写入配置文件并重启插件作用域（世界自动恢复运行）。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/config').then(function(r){
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
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('提示词', isVisitor() ? '只读模式：可浏览提示词，无法修改。' : '改写内置提示词（Bot 行为准则 / World 任务模板），保存后立即生效。带 {{变量}} 的是占位符，会被实际内容替换。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/prompts').then(function(r){
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
      constitutionHead: '行为准则开头段（两种工具协议的共同前言）',
      outputFormatJson: '输出格式段 · 文本协议（正文输出一个 JSON）',
      outputFormatNative: '输出格式段 · 原生协议（function calling）',
      constitution: '输出格式之后的通用规则（事件/电脑/媒体/手机/身份/心态等大段）',
      lifestyleWithWait: '心态段收尾（有 wait 工具时）',
      lifestyleNoWait: '心态段收尾（wait 被移除时）'
    },
    world: {
      system: 'World-LLM 系统提示。{{worldDef}} 世界定义、{{timeLine}} 当前时刻（默认模板不含时间——把易变内容挡在系统提示外，前缀缓存才能跨调用复用；时间由各任务文本自带）',
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
      phoneSpecSystem: '手机屏幕规格判定 · system（apps.phoneResolution 为 auto 时创世调用）',
      phoneSpecUser: '手机屏幕规格判定 · user。{{botDef}} {{worldDef}}',
      phoneShellSystem: '浏览器带壳截图外壳生成 · system（创世调用）',
      phoneShellUser: '带壳截图外壳生成 · user。{{botDef}} {{worldDef}} {{width}} {{height}}；生成的 HTML 里保留 {{screen}} {{url}} {{time}} 占位符',
      visitorPreamble: '穿越 · 访客任务前言（act/wait/查时间/查询的开头段）。{{name}} {{persona}} {{personaWhere}}（档案位置提示，随 visitorPersonaMode 变化）',
      visitorArrive: '穿越 · 访客到达叙事。{{name}} {{persona}} {{personaWhere}} {{timeLine}}',
      visitorLeave: '穿越 · 访客离开善后。{{name}} {{timeLine}}',
      dormantCatchup: '穿越 · 世界沉睡后苏醒的补叙（Bot 外出且无访客期间暂停演化，有人出现时补上）。{{fromTimeLine}} {{toTimeLine}} {{gapTU}}'
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

// ---------- 状态 ----------
function loadState(){
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('状态', isVisitor() ? '只读浏览世界状态：Bot_Status 由 Bot 维护、World_Status 与 News 由 World-LLM 维护。' : '直接读写世界状态：Bot_Status 由 Bot 维护、World_Status 与 News 由 World-LLM 维护——你改的内容会进入它们的视野。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/state').then(function(r){
    stateCache = r;
    holder.textContent = '';
    holder.appendChild(stateEditor = renderStateEditor(r));
  }).catch(showErr);
}
function renderStateEditor(s){
  var frag = document.createDocumentFragment();
  // 每个标签页：id / 标题 / 对应数据块（访客无该块 grant 则整页隐藏）/ 渲染器
  var panes = el('div');
  var tabDefs = [
    { id:'bot', label:'Bot_Status.md', grant:'bot_status', build:function(){ return statePane('bot', 'Bot 状态', s.botStatus, '/api/state/bot-status'); } },
    { id:'world', label:'World_Status.md', grant:'world_status', build:function(){ return statePane('world', '世界状态', s.worldStatus, '/api/state/world-status'); } },
    { id:'news', label:'世界新闻 News.jsonl', grant:'news', build:function(){ return jsonlPane('世界新闻', 'World-LLM 记录的世界大事记（JSONL）', s.news, '/api/state/news', '新增一条世界事件…'); } },
    { id:'facts', label:'Bot 小事记 facts', grant:'facts', build:function(){ return jsonlPane('Bot 小事记', 'Bot 的私人小事（facts.jsonl）——Bot 用 recall 回忆的私人记忆。可固定条目：固定后既不会被重置/创世删除，也会成为 Bot 心中「刻骨铭心的重要回忆」，是它角色扮演时的关键人设与历史依据（避免 OOC）', s.facts || [], '/api/state/facts', '新增一条 Bot 小事…', {sortable: true, pinnable: true}); } },
    { id:'botdef', label:'Bot_Definition.md', grant:'definitions', build:function(){ return statePane('botdef', 'Bot 角色定义', s.botDef, '/api/definitions/bot'); } },
    { id:'worlddef', label:'World_Definition.md', grant:'definitions', build:function(){ return statePane('worlddef', '世界定义', s.worldDef, '/api/definitions/world'); } },
    { id:'shell', label:'手机外壳', grant:'world_status', build:function(){ return phoneShellPane(s.phoneShell || '', s.meta || {}); } }
  ];
  // 过滤：访客只保留有 grant 的标签页
  var visible = tabDefs.filter(function(t){
    if(MODE !== 'visitor') return true;
    return VISITOR_GRANTS.indexOf(t.grant) >= 0;
  });
  var tabs = el('div', {cls:'tabs'});
  visible.forEach(function(t, i){
    tabs.appendChild(el('button', {cls: i===0?'active':'', text: t.label, onclick:function(){ setTab(this, t.id); }}));
    panes.appendChild(t.build());
  });
  frag.appendChild(tabs);
  frag.appendChild(panes);
  if(s.meta && Object.keys(s.meta).length && (MODE !== 'visitor' || VISITOR_GRANTS.indexOf('world_status') >= 0)){
    frag.appendChild(el('div', {cls:'section'}, [el('h3', {text:'元数据 meta.json'}), el('div', {cls:'body'}, [el('pre', {text: JSON.stringify(s.meta, null, 2)})])]));
  }
  // 默认显示第一个可见标签页
  var firstId = visible.length ? visible[0].id : null;
  panes.querySelectorAll('[data-pane]').forEach(function(p){ p.classList.toggle('hidden', p.getAttribute('data-pane') !== firstId); });
  return frag;
}
function statePane(id, title, content, url){
  var sec = el('div', {cls:'section', 'data-pane': id});
  var ta = el('textarea', {rows: 16});
  ta.value = content;
  if(isVisitor()) ta.readOnly = true;
  sec.appendChild(el('h3', {html: esc(title) + ' <span class="hint">' + (isVisitor() ? '只读' : '整体覆盖，保存后实时生效') + '</span>'}));
  var body = el('div', {cls:'body'}, [ta]);
  if(!isVisitor()){
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
  var preview = el('iframe', {style:'width:100%;height:560px;border:1px solid var(--line);border-radius:10px;background:#fff'});
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
    preview.srcdoc = sample;
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
      api('POST', urlBase, {content: v}).then(function(){ addInp.value=''; loadState(); }).catch(showErr);
    }}));
  }
  if(addBar.children.length) body.appendChild(addBar);
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
    if(signal === 'botStatus') setPaneText('bot', r.botStatus);
    else if(signal === 'worldStatus') setPaneText('world', r.worldStatus);
    else if(signal === 'news' || signal === 'facts') loadState();
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

// ---------- 穿越（联机） ----------
function loadCrossing(){
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
  api('GET', '/api/crossing').then(function(r){
    var holder = $('#crossing-root');
    if(!holder || activeView !== 'crossing') return;
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

// ---------- 调试 ----------
function loadDebug(){
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('调试', '流式阅读 Bot-LLM / World-LLM 的原始输入输出与 Bot 的实时行为。点击条目展开完整内容。'));
  var tabs = el('div', {cls:'tabs'}, [
    el('button', {cls: debugSubview==='llm'?'active':'', text:'LLM 请求/响应', onclick:function(){ setSub('llm', this); }}),
    el('button', {cls: debugSubview==='bot'?'active':'', text:'Bot 行为', onclick:function(){ setSub('bot', this); }}),
    el('button', {cls: debugSubview==='world'?'active':'', text:'World 行为', onclick:function(){ setSub('world', this); }}),
    el('button', {cls: debugSubview==='all'?'active':'', text:'全部', onclick:function(){ setSub('all', this); }}),
    el('button', {cls: debugSubview==='stream'?'active':'', text:'工作窗口 stream.jsonl', onclick:function(){ setSub('stream', this); }})
  ]);
  main.appendChild(tabs);
  function setSub(sub, btn){
    debugSubview = sub;
    tabs.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
    if(btn) btn.classList.add('active');
    if(sub === 'stream') renderStreamTab();
    else renderDebugList();
  }
  var toolbar = el('div', {cls:'toolbar'}, isVisitor() ? [
    el('label', {html:'<input type="checkbox" id="dbg-auto"' + (debugAutoScroll?' checked':'') + '> 自动滚动', style:'font-size:12px;color:var(--fg-dim)'}),
    el('button', {id:'dbg-order', text: debugOrder === 'desc' ? '倒序' : '正序', title:'切换列表排序（倒序=最新在前）', onclick:function(){
      debugOrder = debugOrder === 'desc' ? 'asc' : 'desc';
      $('#dbg-order').textContent = debugOrder === 'desc' ? '倒序' : '正序';
      renderDebugList();
    }}),
    el('span', {cls:'spacer'}),
    el('span', {id:'dbg-count', text:'', style:'color:var(--fg-dark);font-size:12px'})
  ] : [
    el('button', {text:'清空', onclick:function(){
      debugEntries = [];
      debugOpenIds = {};
      api('DELETE', '/api/debug').catch(function(){});
      renderDebugList();
    }}),
    el('label', {html:'<input type="checkbox" id="dbg-auto"' + (debugAutoScroll?' checked':'') + '> 自动滚动', style:'font-size:12px;color:var(--fg-dim)'}),
    el('button', {id:'dbg-order', text: debugOrder === 'desc' ? '倒序' : '正序', title:'切换列表排序（倒序=最新在前）', onclick:function(){
      debugOrder = debugOrder === 'desc' ? 'asc' : 'desc';
      $('#dbg-order').textContent = debugOrder === 'desc' ? '倒序' : '正序';
      renderDebugList();
    }}),
    el('span', {cls:'spacer'}),
    el('span', {id:'dbg-count', text:'', style:'color:var(--fg-dark);font-size:12px'})
  ]);
  main.appendChild(toolbar);
  main.appendChild(el('div', {id:'dbg-holder'}));
  document.getElementById('dbg-auto').onchange = function(){ debugAutoScroll = this.checked; };
  api('GET', '/api/debug?n=300').then(function(r){
    debugEntries = r.entries;
    if(debugSubview === 'stream') renderStreamTab();
    else renderDebugList();
  }).catch(showErr);
}
function renderStreamTab(){
  var holder = $('#dbg-holder');
  if(!holder || activeView !== 'debug' || debugSubview !== 'stream') return;
  // 原地更新：容器已存在时只替换文本，保持滚动阅读位置（贴底时才自动跟滚）
  var pre = holder.querySelector('pre[data-stream]');
  if(!pre){
    holder.textContent = '';
    pre = el('pre', {'data-stream':'1', style:'max-height:70vh;overflow:auto'});
    pre.textContent = '加载中…';
    holder.appendChild(pre);
  }
  api('GET', '/api/stream').then(function(r){
    if(debugSubview !== 'stream' || !pre.isConnected) return;
    var lines = [];
    (r.entries || []).forEach(function(e){
      if(e.kind === 'tool_call') lines.push('⟦tool_call⟧ ' + JSON.stringify(e.call));
      else lines.push('⟦event⟧ ' + JSON.stringify(e.event));
    });
    var text = lines.length ? lines.join(NL) : '（工作窗口为空）';
    if(pre.textContent === text) return;
    var atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40 || pre.textContent === '加载中…';
    pre.textContent = text;
    if(atBottom) pre.scrollTop = pre.scrollHeight;
  }).catch(showErr);
}
function debugSubKinds(sub){
  if(sub === 'llm') return ['llm.req','llm.res'];
  if(sub === 'bot') return ['bot.tool','bot.event'];
  if(sub === 'world') return ['world.task','world.result','world.tool'];
  return null;
}
function renderDebugList(){
  var holder = $('#dbg-holder');
  if(!holder) return;
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
  if(!shown) list.appendChild(el('p', {cls:'empty', text:'（没有匹配的条目）'}));
  holder.appendChild(list);
  if(debugAutoScroll && shown) list.scrollTop = debugOrder === 'desc' ? 0 : list.scrollHeight;
}
function prettyDetail(e){
  try { return JSON.stringify(JSON.parse(e.detail), null, 2); } catch(err){ return e.detail; }
}
function usageBadge(e){
  var u = null;
  try {
    u = JSON.parse(e.detail || '').usage;
  } catch(err){ return null; }
  if(!u) return null;
  var total = u.total_tokens != null ? u.total_tokens : u.total;
  var prompt = u.prompt_tokens != null ? u.prompt_tokens : u.prompt;
  var completion = u.completion_tokens != null ? u.completion_tokens : u.completion;
  if(total == null && prompt == null && completion == null) return null;
  if(total == null) total = (prompt || 0) + (completion || 0);
  if(!total) return null;
  var cached = u.cached_tokens != null ? u.cached_tokens : (u.cached || 0);
  var title = 'token 用量：输入 ' + (prompt||0) + '，输出 ' + (completion||0) + (cached ? '，缓存命中 ' + cached : '');
  return el('span', {cls:'tag use', title: title, text: String(total) + ' tok' + (cached ? ' ⚡' : '')});
}
function debugRow(e){
  var row = el('div', {cls:'dbg' + (debugOpenIds[e.id] ? ' open' : ''), 'data-id': e.id});
  var headKids = [
    el('span', {cls:'t', text: fmtTime(e.ts)}),
    el('span', {cls:'tag ' + tagClass(e), text: e.kind}),
    el('span', {cls:'l', text: e.label}),
    el('span', {cls:'tag ' + (e.level==='error'?'err':''), text: e.level})
  ];
  var use = usageBadge(e);
  if(use) headKids.push(use);
  var head = el('div', {cls:'head'}, headKids);
  head.onclick = function(){
    var open = row.classList.toggle('open');
    if(open) debugOpenIds[e.id] = true;
    else delete debugOpenIds[e.id];
  };
  row.appendChild(head);
  var detail = el('div', {cls:'detail'});
  var pre = el('pre');
  pre.textContent = prettyDetail(e);
  detail.appendChild(pre);
  row.appendChild(detail);
  return row;
}
function appendDebugEntry(e){
  // 去重：SSE 续传重放与 /api/debug 种子化可能同时携带同一条，按 id 幂等处理
  for(var i=0;i<debugEntries.length;i++){ if(debugEntries[i].id === e.id){ debugEntries[i] = e; return; } }
  debugEntries.push(e);
  if(debugEntries.length > 600){
    debugEntries.splice(0, debugEntries.length - 600).forEach(function(old){ delete debugOpenIds[old.id]; });
  }
  if(activeView !== 'debug' || debugSubview === 'stream') return;
  var kinds = debugSubKinds(debugSubview);
  if(kinds && kinds.indexOf(e.kind) < 0) return;
  if(debugKindFilter !== 'all' && e.kind !== debugKindFilter) return;
  var holder = $('#dbg-holder');
  if(!holder) return;
  var list = holder.querySelector('.debug-list');
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
  var holder = $('#dbg-holder');
  if(!holder) return;
  var list = holder.querySelector('.debug-list');
  if(!list) return;
  var row = list.querySelector('.dbg[data-id="' + e.id + '"]');
  if(!row) return;
  // 原地刷新（不重建节点）：保持展开状态与滚动位置，流式内容实时增长
  var heads = row.querySelectorAll('.head > span');
  if(heads[0]) heads[0].textContent = fmtTime(e.ts);
  if(heads[2]) heads[2].textContent = e.label;
  if(heads[3]){ heads[3].textContent = e.level; heads[3].className = 'tag ' + (e.level==='error'?'err':''); }
  var use = row.querySelector('.head .tag.use');
  if(use){
    var nb = usageBadge(e);
    if(nb) use.replaceWith(nb);
    else use.remove();
  } else {
    var nb2 = usageBadge(e);
    if(nb2) row.querySelector('.head').appendChild(nb2);
  }
  var pre = row.querySelector('.detail pre');
  if(pre) pre.textContent = prettyDetail(e);
}

// ---------- 用量统计 ----------
function loadUsage(){
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('Token 用量', '按 LLM 请求统计的 token 消耗与缓存命中（保存在 webui 目录 usage.jsonl）。点击标签/模型可筛选明细。'));
  var holder = el('div', {id:'usage-root'}, [el('p', {cls:'empty', text:'加载中…'})]);
  main.appendChild(holder);
  usageFilter = 'total';
  usageFilterLabel = '';
  usageEntryFilter = null;
  refreshUsage();
  viewTimers.push(setInterval(function(){
    if(activeView !== 'usage') return;
    refreshUsage(true);
  }, 15000));
}
function refreshUsage(silent){
  api('GET', '/api/usage?n=500').then(function(r){
    usageCache = r;
    var holder = $('#usage-root');
    if(!holder || activeView !== 'usage') return;
    holder.textContent = '';
    holder.appendChild(renderUsage());
  }).catch(function(err){ if(!silent) showErr(err); });
}
function fmtNum(n){
  n = Number(n) || 0;
  return n.toLocaleString('en-US');
}
function fmtTok(n){
  n = Number(n) || 0;
  if(n >= 1000000) return (n/1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
  if(n >= 1000) return (n/1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(Math.round(n));
}
function renderUsage(){
  var wrap = el('div');
  if(!usageCache) return wrap;
  var s = usageCache.summary;
  var totals = s.totals;
  // 缓存命中率的分母：只统计「上游上报了缓存命中信息」的请求的输入 token；
  // 未上报的请求（如 vLLM 默认不带 cached 字段）不应稀释命中率。
  var reportMiss = (totals.cacheMissRecords||0);
  var hitDenom = totals.cacheReportedPromptTokens || 0;
  var hitRate = hitDenom > 0 ? (totals.cachedTokens / hitDenom * 100) : 0;
  var cacheHint = reportMiss > 0
    ? '统计样本中有 ' + reportMiss + ' 条请求未上报缓存命中信息，本数值可能不准确（分母仅包含已上报缓存的请求）。'
    : '';
  var cards = el('div', {cls:'cards'}, [
    usageCard('请求数', fmtNum(totals.requests), '次'),
    usageCard('总 token', fmtNum(totals.totalTokens), 'tok'),
    usageCard('输入 token', fmtNum(totals.promptTokens), 'tok'),
    usageCard('输出 token', fmtNum(totals.completionTokens), 'tok'),
    usageCard('缓存命中', fmtNum(totals.cachedTokens), 'tok', 'usage-cache-card', cacheHint),
    usageCard('缓存命中率', hitRate.toFixed(1), '%', 'usage-cache-card', cacheHint || '命中缓存的输入 token ÷ 有缓存上报的输入 token。')
  ]);
  wrap.appendChild(cards);
  if(cacheHint){
    wrap.appendChild(el('p', {style:'color:var(--warn);font-size:12.5px;margin:8px 0 0', text:'⚠ ' + cacheHint}));
  }
  wrap.appendChild(usageChartSection());
  var bar = el('div', {cls:'toolbar seg-bar'}, [
    el('span', {text:'明细：', style:'color:var(--fg-dark);font-size:12px'}),
    segBtn('全部', usageFilter==='total', function(){ usageFilter='total'; usageFilterLabel=''; usageEntryFilter=null; syncSeg(this); renderUsageDetail(); }),
    segBtn('按标签', usageFilter==='label', function(){ usageFilter='label'; usageFilterLabel=''; usageEntryFilter=null; syncSeg(this); renderUsageDetail(); }),
    segBtn('按模型', usageFilter==='model', function(){ usageFilter='model'; usageFilterLabel=''; usageEntryFilter=null; syncSeg(this); renderUsageDetail(); }),
    el('span', {cls:'spacer'})
  ].concat(isVisitor() ? [] : [
    el('button', {text:'清空全部', cls:'danger', onclick:function(){
      if(!confirm('确定清空全部用量记录？此操作不可恢复。')) return;
      api('DELETE', '/api/usage').then(function(){ refreshUsage(); }).catch(showErr);
    }})
  ]));
  wrap.appendChild(bar);
  wrap.appendChild(el('div', {id:'usage-detail'}));
  setTimeout(renderUsageDetail, 0);
  return wrap;
}
function segBtn(text, active, onclick){
  return el('button', {cls:'seg' + (active ? ' active' : ''), text: text, onclick: onclick});
}
function syncSeg(btn){
  var bar = btn.parentNode;
  bar.querySelectorAll('button.seg').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
}
function usageCard(label, value, unit, extraCls, title){
  return el('div', {cls:'card' + (extraCls ? ' ' + extraCls : ''), title: title || ''}, [
    el('div', {cls:'card-label', text: label}),
    el('div', {cls:'card-value'}, [
      el('span', {text: String(value)}),
      el('span', {cls:'card-unit', text: ' ' + unit})
    ])
  ]);
}
// ----- 时间维度图表（纯 SVG 堆叠柱状图，无依赖） -----
function usageChartSection(){
  var sec = el('div', {cls:'section'});
  var head = el('h3', {html:'用量趋势 <span class="hint">堆叠柱：输入（未命中缓存）+ 缓存命中 + 输出</span>'});
  var seg = el('span', {style:'margin-left:auto;display:inline-flex;gap:4px'});
  var mode = usageChartMode;
  function tab(text, m){
    var b = el('button', {cls:'seg' + (mode === m ? ' active' : ''), text: text, style:'font-size:11px;padding:2px 10px'});
    b.onclick = function(){
      usageChartMode = m;
      var box = $('#usage-chart');
      if(box){ box.textContent = ''; box.appendChild(usageChart(m)); }
      seg.querySelectorAll('button').forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
    };
    return b;
  }
  seg.appendChild(tab('48 小时', 'hour'));
  seg.appendChild(tab('按日', 'day'));
  head.appendChild(seg);
  sec.appendChild(head);
  var body = el('div', {cls:'body', id:'usage-chart'});
  body.appendChild(usageChart(mode));
  sec.appendChild(body);
  return sec;
}
function usageChart(mode){
  var s = usageCache && usageCache.summary;
  if(!s) return el('p', {cls:'empty', text:'（暂无数据）'});
  var buckets;
  if(mode === 'day'){
    buckets = (s.byDay || []).slice(0, 30).reverse().map(function(d){
      return {label: d.day.slice(5), full: d.day, t: d.totals};
    });
  } else {
    buckets = (s.byHour || []).map(function(h){
      return {label: h.hour.slice(6), full: h.hour, t: h.totals};
    });
  }
  if(!buckets.length) return el('p', {cls:'empty', text:'（暂无数据，发起一次 LLM 请求后这里会出现图表）'});
  var maxTotal = 0;
  buckets.forEach(function(b){ if(b.t.totalTokens > maxTotal) maxTotal = b.t.totalTokens; });
  if(!maxTotal){
    return el('p', {cls:'empty', text: mode === 'day' ? '（暂无数据）' : '（最近 48 小时没有用量）'});
  }
  var W = 920, H = 200, padL = 46, padB = 22, padT = 8;
  var plotW = W - padL - 6, plotH = H - padT - padB;
  var n = buckets.length;
  var slot = plotW / n;
  var barW = Math.max(2, Math.min(26, slot * 0.68));
  var html = '';
  // 水平网格线 + Y 轴刻度
  var steps = 4;
  for(var g=0; g<=steps; g++){
    var val = maxTotal / steps * g;
    var y = padT + plotH - plotH / steps * g;
    html += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W-6) + '" y2="' + y + '" stroke="rgba(148,163,184,.12)" stroke-width="1"/>';
    html += '<text x="' + (padL - 7) + '" y="' + (y + 3.5) + '" text-anchor="end" font-size="10" fill="rgba(147,160,180,.8)">' + fmtTok(val) + '</text>';
  }
  buckets.forEach(function(b, i){
    var x = padL + slot * i + (slot - barW) / 2;
    var t = b.t;
    var fresh = Math.max(t.promptTokens - (t.cachedTokens||0), 0);
    var tip = b.full + NL
      + '请求 ' + fmtNum(t.requests) + ' 次' + NL
      + '总量 ' + fmtNum(t.totalTokens) + ' tok' + NL
      + '输入 ' + fmtNum(t.promptTokens) + '（缓存命中 ' + fmtNum(t.cachedTokens||0) + '）' + NL
      + '输出 ' + fmtNum(t.completionTokens);
    var segs = [
      [fresh, 'rgba(138,123,255,.75)'],
      [t.cachedTokens||0, 'rgba(110,231,255,.8)'],
      [t.completionTokens, 'rgba(74,222,128,.75)']
    ];
    var yCur = padT + plotH;
    var rects = '';
    segs.forEach(function(sg){
      if(!sg[0]) return;
      var h = sg[0] / maxTotal * plotH;
      yCur -= h;
      rects += '<rect x="' + x.toFixed(1) + '" y="' + yCur.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(h, 0.5).toFixed(1) + '" fill="' + sg[1] + '" rx="1"/>';
    });
    if(!rects) rects = '<rect x="' + x.toFixed(1) + '" y="' + (padT + plotH - 1) + '" width="' + barW.toFixed(1) + '" height="1" fill="rgba(148,163,184,.15)"/>';
    // 命中悬停区（整列）便于查看提示
    html += '<g>' + rects
      + '<rect x="' + (padL + slot*i).toFixed(1) + '" y="' + padT + '" width="' + slot.toFixed(1) + '" height="' + plotH + '" fill="transparent"><title>' + esc(tip) + '</title></rect>'
      + '</g>';
    // X 轴标签：稀疏显示避免重叠
    var every = Math.ceil(n / Math.floor(plotW / 52));
    if(i % every === 0){
      html += '<text x="' + (padL + slot*i + slot/2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="rgba(147,160,180,.75)">' + esc(b.label) + '</text>';
    }
  });
  var box = el('div');
  var svgWrap = el('div', {cls:'chart-scroll'});
  svgWrap.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:200px;display:block">' + html + '</svg>';
  box.appendChild(svgWrap);
  box.appendChild(el('div', {cls:'chart-legend'}, [
    legendDot('rgba(138,123,255,.85)', '输入（未命中）'),
    legendDot('rgba(110,231,255,.9)', '缓存命中'),
    legendDot('rgba(74,222,128,.85)', '输出')
  ]));
  return box;
}
function legendDot(color, text){
  var it = el('span', {cls:'legend-item'});
  it.appendChild(el('i', {style:'background:' + color}));
  it.appendChild(el('span', {text: text}));
  return it;
}
function renderUsageDetail(){
  var holder = $('#usage-detail');
  if(!holder || !usageCache) return;
  holder.textContent = '';
  var s = usageCache.summary;
  var list = el('div', {cls:'section'});
  var title = usageFilterLabel ? ('筛选：' + usageFilterLabel) : (usageFilter === 'label' ? '按标签聚合' : usageFilter === 'model' ? '按模型聚合' : '最近 500 条请求');
  var h3 = el('h3', {text: title});
  if(usageFilterLabel){
    h3.appendChild(el('button', {cls:'ghost', text:'清除筛选', style:'margin-left:auto;font-size:11px;padding:2px 10px', onclick:function(){
      usageFilterLabel = ''; usageEntryFilter = null; renderUsageDetail();
    }}));
  }
  list.appendChild(h3);
  var body = el('div', {cls:'body'});
  if(usageFilter === 'label' || usageFilter === 'model'){
    var map = usageFilter === 'label' ? (s.byLabel || {}) : (s.byModel || {});
    var keys = Object.keys(map).sort(function(a,b){ return map[b].totalTokens - map[a].totalTokens; });
    if(!keys.length) body.appendChild(el('p', {cls:'empty', text:'（暂无记录）'}));
    keys.forEach(function(k){
      body.appendChild(usageRow(k || '（空）', usageFilter, map[k]));
    });
  } else {
    var entries = (usageCache.entries || []).slice().reverse();
    if(usageEntryFilter){
      entries = entries.filter(function(e){
        return usageEntryFilter.dim === 'label' ? e.label === usageEntryFilter.name : e.model === usageEntryFilter.name;
      });
    }
    if(!entries.length) body.appendChild(el('p', {cls:'empty', text:'（暂无记录，发起一次 LLM 请求后这里会出现数据）'}));
    entries.forEach(function(e){
      body.appendChild(el('div', {cls:'usage-entry'}, [
        el('span', {cls:'usage-lbl', text: e.label + ' › ' + (e.model || '?')}),
        el('span', {cls:'usage-time', text: fmtTime(e.ts)}),
        el('span', {cls:'usage-num', text: fmtNum(e.totalTokens) + ' tok'}),
        el('span', {cls:'usage-num dim', text: '↑' + fmtTok(e.promptTokens) + ' ↓' + fmtTok(e.completionTokens) + (e.cachedTokens ? ' ⚡' + fmtTok(e.cachedTokens) : '')})
      ]));
    });
  }
  list.appendChild(body);
  holder.appendChild(list);
}
function usageRow(name, dim, it){
  var hitDenom = it.cacheReportedPromptTokens || 0;
  var hit = hitDenom > 0 ? (it.cachedTokens||0) / hitDenom * 100 : 0;
  return el('div', {cls:'usage-entry', style:'cursor:pointer', title:'点击查看该' + (dim==='label'?'标签':'模型') + '的请求明细', onclick:function(){
    usageFilter = 'total';
    usageFilterLabel = name;
    usageEntryFilter = {dim: dim, name: name};
    renderUsageDetail();
    var bar = $('#usage-root .seg-bar');
    if(bar){
      bar.querySelectorAll('button.seg').forEach(function(b, i){ b.classList.toggle('active', i === 0); });
    }
  }}, [
    el('span', {cls:'usage-lbl', text: name}),
    el('span', {cls:'usage-num dim', text: fmtNum(it.requests || 0) + ' 次'}),
    el('span', {cls:'usage-num', text: fmtNum(it.totalTokens || 0) + ' tok'}),
    el('span', {cls:'usage-num dim', text: '↑' + fmtTok(it.promptTokens||0) + ' ↓' + fmtTok(it.completionTokens||0) + ' ⚡' + fmtTok(it.cachedTokens||0) + (it.promptTokens ? '（' + hit.toFixed(0) + '%）' : '')})
  ]);
}

// ---------- 相册 ----------
function loadGallery(){
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('相册（Bot 收藏夹）', '分类：表情包 / meme / 截图 / 照片 / 未整理。未整理是主人手动放入、待 Bot 归类描述的东西。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
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
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('媒体资产库', 'Bot 见过的媒体缓存（只读，Bot 用 check_media 翻看）。收藏夹是精心挑选的，这里是全部见过的。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/media').then(function(r){
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
  var main = $('#main');
  main.textContent = '';
  main.appendChild(viewHead('数据文件与记事本', '查看/编辑世界数据目录里的运行时 JSON 文件与 Bot 的记事本（Notes/），以及压缩归档。'));
  var holder = el('div', {text:'加载中…', cls:'empty'});
  main.appendChild(holder);
  api('GET', '/api/data').then(function(r){
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

// ---------- 启动 ----------
(function(){
  // 访客只读：给 body 打标记，用于 CSS 隐藏写相关元素
  if(MODE === 'visitor') document.body.classList.add('visitor-readonly');
  var h = (location.hash || '').slice(1);
  for(var i=0;i<NAV.length;i++){
    if(NAV[i][0] === h && (NAV[i][3] === undefined || visitorCanSee(NAV[i][3]))){ activeView = h; break; }
  }
})();
buildNav();
// 访客若当前视图不可见，回落到第一个可见视图
(function(){
  var cur = null;
  for(var i=0;i<NAV.length;i++){ if(NAV[i][0] === activeView){ cur = NAV[i]; break; } }
  if(cur && !visitorCanSee(cur[3])){
    for(var j=0;j<NAV.length;j++){
      if(!NAV[j].group && visitorCanSee(NAV[j][3])){ activeView = NAV[j][0]; break; }
    }
  }
})();
switchView(activeView);
if(activeView !== 'overview') refreshOverview(false);
connectSSE();
setInterval(function(){ refreshOverview(false); }, 8000);
// 访客：定期同步会话 grants（管理员改权限后实时生效）；被删则退回登录
if(MODE === 'visitor') setInterval(function(){ syncVisitorGrants(); }, 15000);
window.addEventListener('hashchange', function(){
  var h = (location.hash || '').slice(1);
  if(h === activeView) return;
  for(var i=0;i<NAV.length;i++){
    if(NAV[i][0] === h && visitorCanSee(NAV[i][3])){ switchView(h); return; }
  }
});
// 页面隐藏时挂起 SSE 之外的高频轮询由各视图自查 activeView；此处兜底：
// 回到前台立即刷新一次总览，避免长时间挂后台后数据陈旧
document.addEventListener('visibilitychange', function(){
  if(!document.hidden) refreshOverview(false);
});
</script>
</body>
</html>
`;
