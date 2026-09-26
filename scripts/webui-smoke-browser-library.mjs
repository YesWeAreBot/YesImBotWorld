/** Browser library interactions on the isolated preview, with local device state only. */
export default async function smokeBrowserLibrary({ evaluate, wait, assert, navigate, page }) {
  assert(await evaluate("fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Browser library smoke requires the isolated preview');
  await navigate('overview');
  await page('Emulation.setDeviceMetricsOverride', { width: 375, height: 1050, deviceScaleFactor: 1, mobile: true });
  await evaluate(`(async function(){
    window.__browserOriginalApi=api;window.__browserOriginalInterval=window.setInterval;
    window.__browserBase=await api('GET','/api/device/session');window.__browserCalls=[];window.__browserPolls=0;window.__browserActive=true;
    window.__browserTools=['home','go_back','go_forward','reload','read_page','open_url','search','list_history','list_bookmarks','add_bookmark','rename_bookmark','remove_bookmark','open_bookmark','open_history'];
    window.__browserState={mode:'text',url:'https://preview.invalid/current',title:'当前网页',text:'浏览器的当前网页',revision:'preview-r1',searchProviders:[],elements:[],images:[],links:[],cookies:'must-not-appear-cookie',storageState:'must-not-appear-storage',library:{canGoBack:true,canGoForward:false,
      history:[{id:'history-old/42',url:'https://preview.invalid/old',title:'旧文档',visitedAt:1000,worldTime:'星历 3年 27:105'},{id:'history-new/77',url:'https://preview.invalid/new',title:'最近阅读 <img src=x onerror=alert(1)>',visitedAt:2000,worldTime:'星历 3年 28:006'}],
      bookmarks:[{id:'bookmark-one/42',url:'https://preview.invalid/first',title:'我的第一枚书签',createdAt:1000,updatedAt:1000},{id:'bookmark-two/77',url:'https://preview.invalid/'+('long-path-'.repeat(30)),title:'<img src=x onerror=alert(1)>',createdAt:2000,updatedAt:2000}]}};
    window.__browserSnapshot=function(){var data=structuredClone(__browserBase);data.running=true;data.control={paused:false,busy:false,residentMode:null};data.devices.phone.down=false;data.devices.phone.appOpen=__browserActive?'浏览器':null;data.devices.phone.chatOpen=false;
      data.apps=[{id:'browser',name:'浏览器',kind:'app',active:__browserActive}];data.appCatalog=data.apps.map(a=>Object.assign({},a,{status:'ready'}));
      data.tools=['open_app','close_app'].map(name=>({name,device:'phone',effect:'action'})).concat(__browserActive?__browserTools.map(name=>({name:'browser.'+name,device:'phone',effect:'action'})):[]);
      data.appView=__browserActive?{id:'browser',name:'浏览器',state:structuredClone(__browserState)}:null;return data;};
    api=async function(method,url,body){
      if(method==='GET'&&url==='/api/device/session'){__browserPolls++;return __browserSnapshot();}
      if(method==='POST'&&url==='/api/device/tool'){
        __browserCalls.push(structuredClone(body));var name=body.name,args=body.args||{},lib=__browserState.library;
        if(name==='open_app')__browserActive=true;
        else if(name==='close_app')__browserActive=false;
        else if(name==='browser.go_back'){lib.canGoBack=false;lib.canGoForward=true;__browserState.url='https://preview.invalid/back';}
        else if(name==='browser.go_forward'){lib.canGoBack=true;lib.canGoForward=false;__browserState.url='https://preview.invalid/current';}
        else if(name==='browser.open_history'||name==='browser.open_bookmark'){var item=(name==='browser.open_history'?lib.history:lib.bookmarks).find(item=>item.id===args.id);if(!item)throw Error('Missing library ID');__browserState.url=item.url;__browserState.title=item.title;}
        else if(name==='browser.add_bookmark'){if(args.revision!==__browserState.revision)throw Error('Stale bookmark revision');lib.bookmarks.unshift({id:'bookmark-added/99',url:__browserState.url,title:args.title||__browserState.title,createdAt:3000,updatedAt:3000});}
        else if(name==='browser.rename_bookmark'){if(window.__browserRenameFailure)throw Error('书签暂时无法保存');var item=lib.bookmarks.find(item=>item.id===args.id);item.title=args.title;item.updatedAt=4000;}
        else if(name==='browser.remove_bookmark')lib.bookmarks=lib.bookmarks.filter(item=>item.id!==args.id);
        else if(!['browser.list_history','browser.list_bookmarks','browser.read_page','browser.reload','browser.home','browser.search','browser.open_url'].includes(name))throw Error('Unexpected mock tool: '+name);
        return {ok:true,text:'本地浏览器样本已更新'};
      }
      return __browserOriginalApi.apply(this,arguments);
    };
    window.setInterval=function(fn,ms){return __browserOriginalInterval(fn,ms===5000?70:ms);};
  })()`);
  const q = JSON.stringify;
  const click = async selector => {
    await wait(`!!document.querySelector(${q(selector)})&&!document.querySelector(${q(selector)}).disabled`);
    await evaluate(`document.querySelector(${q(selector)}).click()`);
  };
  const row = id => `.browser-bookmark-item[data-entry-id="${id}"]`;
  try {
    await navigate('devices');
    await wait("!!document.querySelector('.studio-browser')&&!document.querySelector('[data-browser-tool=go_back]').disabled");
    assert(await evaluate("document.querySelector('[data-browser-tool=go_forward]').disabled"), 'Forward is disabled when there is no forward entry');
    await click('[data-browser-tool=go_back]');
    await wait("document.querySelector('[data-browser-tool=go_back]').disabled&&!document.querySelector('[data-browser-tool=go_forward]').disabled");
    await click('[data-browser-tool=go_forward]');
    await wait("document.querySelector('[data-browser-tool=go_forward]').disabled&&!document.querySelector('[data-browser-tool=go_back]').disabled");
    assert(await evaluate("__browserCalls.find(c=>c.name==='browser.go_forward').args.revision==='preview-r1'"), 'Forward uses the namespaced device tool and current page revision');

    await click('[data-browser-view=history]');
    await wait("__browserCalls.some(c=>c.name==='browser.list_history')&&!document.querySelector('.browser-history').hidden");
    assert(await evaluate("document.querySelector('.browser-history-item').dataset.entryId==='history-new/77' && !document.querySelector('.browser-history img')"), 'History is sorted newest first and untrusted titles render as text');
    await evaluate(`window.__browserInput=document.querySelector('.browser-library-search');__browserInput.value='旧文档';__browserInput.dispatchEvent(new Event('input'));__browserInput.focus();__browserInput.setSelectionRange(1,1);__browserInput.dispatchEvent(new CompositionEvent('compositionstart',{data:'旧'}));window.__browserBefore=__browserPolls;
      __browserState.library.history.unshift({id:'history-latest',url:'https://preview.invalid/latest',title:'新到达的页面',visitedAt:5000});`);
    await wait("__browserPolls>=__browserBefore+3 && document.querySelectorAll('.browser-history-item').length===1");
    assert(await evaluate("document.querySelector('.browser-library-search')===__browserInput && document.activeElement===__browserInput && __browserInput.selectionStart===1 && __browserInput.value==='旧文档' && document.querySelectorAll('.browser-history-item:not([hidden])').length===1"), 'History polling preserves the focused IME search draft and applies the filter');
    await evaluate("__browserInput.dispatchEvent(new CompositionEvent('compositionend',{data:'旧'}))");
    await click('.browser-history-item:not([hidden]) .browser-library-title');
    await wait("document.querySelector('[data-browser-view=page]').getAttribute('aria-selected')==='true'");
    assert(await evaluate("__browserCalls.find(c=>c.name==='browser.open_history').args.id==='history-old/42'"), 'Opening history sends the actual history ID');
    await click('[data-browser-view=history]');
    await evaluate("__browserInput.value='没有匹配项';__browserInput.dispatchEvent(new Event('input'))");
    assert(await evaluate("!document.querySelector('.browser-library-empty').hidden && document.querySelector('.browser-library-empty').textContent.includes('没有找到')"), 'History search has a useful empty result state');
    await evaluate(`__browserState.library.history.push(...Array.from({length:125},(_,i)=>({id:'history-bulk-'+i,url:'https://preview.invalid/bulk/'+i,title:'批量记录 '+i,visitedAt:6000+i})));__browserInput.value='';__browserInput.dispatchEvent(new Event('input'));`);
    await wait("document.querySelector('.browser-history .browser-library-summary').textContent.includes('50 / 128')");
    assert(await evaluate("document.querySelectorAll('.browser-history-item').length===50 && !document.querySelector('.browser-history-more').hidden && __browserState.library.history.length===128"), 'Large history initially renders only 50 rows without truncating stored records');
    await click('.browser-history-more');
    assert(await evaluate("document.querySelectorAll('.browser-history-item').length===100 && document.querySelector('.browser-history .browser-library-summary').textContent.includes('100 / 128')"), 'Show more appends the next 50 history rows');
    await click('.browser-history-more');
    assert(await evaluate("document.querySelectorAll('.browser-history-item').length===128 && document.querySelector('.browser-history-more').hidden"), 'The final history batch includes all remaining rows and hides show more');
    await evaluate("__browserInput.value='旧文档';__browserInput.dispatchEvent(new Event('input'))");
    assert(await evaluate("document.querySelectorAll('.browser-history-item').length===1 && document.querySelector('.browser-history-item').dataset.entryId==='history-old/42' && document.querySelector('.browser-history .browser-library-summary').textContent.includes('1 / 1')"), 'Search covers history outside the first 50 rows');
    await evaluate("__browserInput.value='';__browserInput.dispatchEvent(new Event('input'))");
    assert(await evaluate("document.querySelectorAll('.browser-history-item').length===50 && !document.querySelector('.browser-history-more').hidden"), 'Changing the search resets the display limit to 50');

    await click('[data-browser-view=bookmarks]');
    await wait("__browserCalls.some(c=>c.name==='browser.list_bookmarks')");
    await click(row('bookmark-one/42') + ' [data-browser-tool=rename_bookmark]');
    await evaluate(`window.__browserInput=document.querySelector(${q(row('bookmark-one/42'))}+' input');__browserInput.value='输入法中的新书签名';__browserInput.dispatchEvent(new Event('input'));__browserInput.setSelectionRange(3,3);__browserInput.dispatchEvent(new CompositionEvent('compositionstart',{data:'签'}));window.__browserBefore=__browserPolls;
      __browserState.library.bookmarks.unshift({id:'bookmark-polling',url:'https://preview.invalid/polling',title:'轮询新书签',createdAt:5000,updatedAt:5000});`);
    await wait("__browserPolls>=__browserBefore+3 && document.querySelectorAll('.browser-bookmark-item').length===3");
    assert(await evaluate(`document.querySelector(${q(row('bookmark-one/42'))}+' input')===__browserInput && document.activeElement===__browserInput && __browserInput.selectionStart===3 && __browserInput.value==='输入法中的新书签名'`), 'Bookmark insertion preserves the rename input node, draft, focus, selection and composition');
    await evaluate("__browserInput.dispatchEvent(new CompositionEvent('compositionend',{data:'签'}));__browserTools=__browserTools.filter(t=>t!=='rename_bookmark')");
    await wait("__browserInput.readOnly && __browserInput.form.querySelector('[type=submit]').disabled");
    assert(await evaluate("document.activeElement===__browserInput && !__browserInput.disabled"), 'Losing permission prevents save while keeping the focused rename draft');
    await evaluate("__browserTools.push('rename_bookmark');window.__browserRenameFailure=true");
    await wait("!__browserInput.form.querySelector('[type=submit]').disabled");
    await evaluate("__browserInput.form.requestSubmit()");
    await wait("document.querySelector('.browser-status').textContent.includes('书签暂时无法保存') && !__browserInput.readOnly");
    assert(await evaluate("!__browserInput.form.hidden && __browserInput.value==='输入法中的新书签名'"), 'A failed rename keeps the editor and unsaved name');
    await evaluate("window.__browserRenameFailure=false;__browserInput.form.requestSubmit()");
    await wait(`document.querySelector(${q(row('bookmark-one/42'))}+' .browser-library-title').textContent==='输入法中的新书签名' && __browserInput.form.hidden`);
    assert(await evaluate("__browserCalls.filter(c=>c.name==='browser.rename_bookmark').at(-1).args.id==='bookmark-one/42' && __browserCalls.filter(c=>c.name==='browser.rename_bookmark').at(-1).args.title==='输入法中的新书签名'"), 'Rename submits the exact bookmark ID and edited title');
    await click(row('bookmark-two/77') + ' [data-browser-tool=remove_bookmark]');
    await wait(`!document.querySelector(${q(row('bookmark-two/77'))})`);
    assert(await evaluate("__browserCalls.find(c=>c.name==='browser.remove_bookmark').args.id==='bookmark-two/77'"), 'Remove submits the selected bookmark ID');
    await click('[data-browser-tool=add_bookmark]');
    await wait(`!!document.querySelector(${q(row('bookmark-added/99'))}) && document.querySelector('[data-browser-tool=add_bookmark]').disabled`);
    assert(await evaluate("__browserCalls.filter(c=>c.name==='browser.add_bookmark').length===1 && __browserCalls.find(c=>c.name==='browser.add_bookmark').args.revision==='preview-r1'"), 'Add bookmarks the current page revision and prevents a duplicate add');
    await click(row('bookmark-one/42') + ' [data-browser-tool=open_bookmark]');
    await wait("document.querySelector('[data-browser-view=page]').getAttribute('aria-selected')==='true'");
    assert(await evaluate("__browserCalls.find(c=>c.name==='browser.open_bookmark').args.id==='bookmark-one/42' && document.querySelector('.browser-address').value==='https://preview.invalid/first'"), 'Opening a bookmark restores the page view using its actual ID');
    await click('.app-back');
    await click('[data-phone-app=browser]');
    await wait("document.querySelector('.browser-address')?.value==='https://preview.invalid/first'");
    assert(await evaluate("__browserCalls.some(c=>c.name==='open_app')"), 'Returning to the browser displays the current server snapshot');

    await click('[data-browser-view=bookmarks]');
    await evaluate("__browserState.url='browser://home'");
    await wait("document.querySelector('.browser-address').value==='browser://home' && document.querySelector('[data-browser-tool=add_bookmark]').disabled");
    assert(await evaluate("document.querySelector('[data-browser-tool=add_bookmark]').textContent==='收藏当前页'"), 'The built-in home cannot be bookmarked');
    for (const width of [375, 320, 1440]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 600 });
      assert(await evaluate(`document.documentElement.scrollWidth<=${width} && innerWidth<=${width}`), 'Bookmark actions and long URLs fit the ' + width + 'px viewport');
    }
    assert(await evaluate("!document.querySelector('.studio-browser img[src=x]') && !document.querySelector('.studio-browser').textContent.includes('must-not-appear')"), 'The panel exposes no cookie/storage state and never interprets saved titles as HTML');
    await evaluate("__browserTools=[];window.__browserBefore=__browserPolls");
    await wait("__browserPolls>=__browserBefore+2 && document.querySelector('[data-browser-tool=add_bookmark]').disabled");
    await evaluate("window.__browserCount=__browserCalls.length;document.querySelector('[data-browser-view=history]').click();document.querySelector('.browser-history-item .browser-library-title').click()");
    assert(await evaluate("__browserCalls.length===__browserCount"), 'Unavailable library tools cannot issue device mutations');
  } finally {
    await navigate('overview');
    await evaluate("api=__browserOriginalApi;window.setInterval=__browserOriginalInterval;delete window.__browserInput;");
  }
  return 'browser library: back/forward, full-history search with 50-row batches, bookmark add/rename/delete/open, IME polling, permissions, safe text and 320/375px layout';
}
