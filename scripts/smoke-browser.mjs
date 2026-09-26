import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Offline by default; public Bilibili checks require BROWSER_SMOKE_PUBLIC=1.
// Supply a Puppeteer installation via BROWSER_SMOKE_RUNTIME and a browser binary via BROWSER_SMOKE_EXECUTABLE.
const {dirname,join}=require('node:path');const {mkdtempSync,rmSync}=require('node:fs');const {tmpdir}=require('node:os');const http=require('node:http');const assert=require('node:assert/strict');
const esbuild=require(require.resolve('esbuild',{paths:[dirname(require.resolve('pkgroll/package.json'))]}));
const p=require(require.resolve('puppeteer-core', { paths: [process.env.BROWSER_SMOKE_RUNTIME || process.cwd()] }));
const executable = process.env.BROWSER_SMOKE_EXECUTABLE || process.env.PUPPETEER_EXECUTABLE_PATH;
if (!executable) throw new Error('Set BROWSER_SMOKE_EXECUTABLE to a local Chromium binary; this script launches its own temporary profile.');
(async()=>{const dir=mkdtempSync(join(tmpdir(),'browser-real-smoke-'));let b,server;try{
const out=join(dir,'browser.cjs');esbuild.buildSync({entryPoints:['src/apps/browser-session.ts'],outfile:out,bundle:true,platform:'node',format:'cjs',logLevel:'warning'});const {BrowserSession}=require(out);
server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><title>动态视频页</title><meta property="og:image" content="/cover.jpg"><h1 id="title"></h1><label>搜索<input id="q"></label><button id="go">确认</button><div id="out"></div><script>document.querySelector("h1").textContent="JavaScript 标题";document.querySelector("#go").onclick=()=>document.querySelector("#out").textContent=document.querySelector("#q").value</script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
b=await p.launch({executablePath:executable,headless:true,args:['--no-sandbox'],timeout:20000});
const session=new BrowserSession(()=>({browser:b}),async()=>({width:600,height:800}));let state=await session.navigate('http://127.0.0.1:'+server.address().port);assert.match(state.text,/JavaScript 标题/);assert.match(state.images[0].url,/cover.jpg/);const input=state.elements.find(e=>e.role==='input');state=await session.act({kind:'fill',revision:state.revision,ref:input.ref,value:'实际输入'});const button=state.elements.find(e=>e.role==='button');state=await session.act({kind:'click',revision:state.revision,ref:button.ref});assert.match(state.text,/实际输入/);const png=await session.capture(state.revision);assert.equal(png.subarray(1,4).toString(),'PNG');
const composed=await session.compose('<html><img src="data:image/png;base64,'+png.toString('base64')+'"></html>',state.viewport);assert.equal(composed.subarray(1,4).toString(),'PNG');await session.dispose();
const page=await b.newPage();await page.setViewport({width:390,height:844});await page.setContent('<div id="panel"></div>');await page.addStyleTag({path:'src/webui/client/browser-panel.css'});await page.addScriptTag({path:'src/webui/client/browser-panel.js'});
await page.evaluate(()=>{window.s={mode:'real',url:'https://example.org/',title:'<img src=x onerror=alert(1)>',text:'网页正文 <script>alert(1)</script>',revision:1,elements:[{ref:'e1',role:'input',type:'text',label:'搜索',value:'旧值'}],images:[],videos:[],searchProviders:['https://www.bing.com/search?q=%s']};window.calls=[];window.panel=StudioBrowserPanel.mount(document.querySelector('#panel'),{getState:()=>window.s,available:()=>true,run:async(t,a)=>{window.calls.push([t,a]);return{text:'ok'}},report:e=>{throw e},mediaUrl:id=>'/media/'+id});});
await page.focus('.browser-element-input');await page.$eval('.browser-element-input',n=>{n.value='输入法草稿';n.dispatchEvent(new Event('input'));});
await page.evaluate(()=>{window.s.revision=2;window.panel.update()});assert.equal(await page.$eval('.browser-element-input',n=>n.value),'输入法草稿');assert.equal(await page.evaluate(()=>document.activeElement.className),'browser-element-input');assert.equal(await page.$eval('.browser-title',n=>n.querySelectorAll('img').length),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.evaluate(()=>{window.s.url='https://changed.example/';window.panel.update()});assert.equal(await page.$eval('.browser-element-input',n=>n.value),'输入法草稿');assert.equal(await page.$eval('.browser-element .browser-button',n=>n.disabled),true);
await page.evaluate(()=>{ document.activeElement.blur(); window.s={mode:'virtual',url:'',title:'',text:'尚未读取本世界的网页',elements:[],links:[{url:'https://linhai.invalid/',text:'临海导航'}],images:[],searchProviders:['https://leaked-real-provider.invalid/']};window.panel.update(); });
assert.equal(await page.$eval('.browser-portal',n=>getComputedStyle(n).display),'none');
assert.equal(await page.$eval('.browser-provider',n=>getComputedStyle(n).display),'none');
assert.equal(await page.$eval('.browser-provider',n=>n.options.length),0);assert.match(await page.$eval('.browser-title',n=>n.textContent),/本世界的虚拟互联网/);
await page.$eval('.browser-search',n=>{n.value='本地新闻';});await page.$eval('.browser-search-form',n=>n.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
await page.waitForFunction(()=>window.calls.length>0);assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),['search',{query:'本地新闻'}]);
await page.evaluate(()=>window.panel.dispose());console.log('PASS real isolated Chromium: JS DOM/title/cover, fill/click, raw+composed PNG, mobile drafts, stale targets, HTML escaping and fictional-world portal isolation');
if (process.env.BROWSER_SMOKE_PUBLIC === '1') {
const live=new BrowserSession(()=>({browser:b}),async()=>({width:800,height:1100}));
for(const url of ['https://www.bilibili.com/','https://search.bilibili.com/all?keyword=%E5%B0%8F%E7%8C%AB','https://www.bilibili.com/video/BV1GJ411x7h7/']){
 const s=await live.navigate(url);console.log(JSON.stringify({requested:url,url:s.url,title:s.title,text:s.text.slice(0,450),description:s.description.slice(0,360),controls:s.elements.filter(e=>['input','textbox','searchbox'].includes(e.role)).map(e=>({ref:e.ref,role:e.role,type:e.type,label:e.label})),images:s.images.slice(0,3).map(i=>({alt:i.alt,url:i.url.slice(0,160)})),videos:s.videos.map(v=>({url:v.url?.slice(0,80),duration:v.duration})),notice:s.notice}));
}
await live.dispose();
}
}finally{await b?.close();if(server)await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
