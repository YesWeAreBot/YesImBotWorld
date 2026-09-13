/** Theme and small-screen regressions using rendered bounds, including mobile auto-zoom. */
export default async function smokeLayout({ evaluate, wait, assert, navigate, page }) {
  const originalTheme = await evaluate('document.body.dataset.theme');
  const metrics = (width, height, mobile = true) => page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const mobileBounds = async (width, label) => {
    const state = await evaluate(`(()=>{
      const nav=document.querySelector('#mobile-nav');
      const bounds=element=>{const r=element.getBoundingClientRect();const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:r.width>0&&r.height>0&&!!hit&&element.contains(hit)}};
      return {content:document.documentElement.scrollWidth,layout:innerWidth,visual:visualViewport.width,scale:visualViewport.scale,x:scrollX,nav:bounds(nav),items:Array.from(nav.querySelectorAll('a'),bounds),height:innerHeight};
    })()`);
    assert.ok(state.content <= width + 1 && state.layout <= width + 1 && state.visual <= width + 1 && Math.abs(state.scale - 1) < .01 && state.x === 0, `${label}: page must fit the device without auto-zoom: ${JSON.stringify(state)}`);
    assert.equal(state.items.length, 5, `${label}: all five navigation destinations remain available`);
    for (const rect of [state.nav, ...state.items])
      assert.ok(rect.visible && rect.left >= -1 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= state.height + 1, `${label}: navigation must remain visible and touchable: ${JSON.stringify(rect)}`);
  };
  const saveBounds = async (width, label) => {
    const state = await evaluate(`(()=>{
      const bar=document.querySelector('.cfg-savebar'), nav=document.querySelector('#mobile-nav').getBoundingClientRect();
      const bounds=element=>{const r=element.getBoundingClientRect();const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:r.width>0&&r.height>0&&!!hit&&element.contains(hit)}};
      return {bar:bounds(bar),buttons:Array.from(bar.querySelectorAll('button'),bounds),navTop:nav.top,navHeight:nav.height,offset:parseFloat(getComputedStyle(bar).bottom)};
    })()`);
    assert.equal(state.buttons.length, 2, `${label}: dirty configuration shows discard and save`);
    for (const rect of state.buttons)
      assert.ok(rect.visible && rect.left >= 0 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= state.navTop - 1, `${label}: configuration buttons must be fully touchable above navigation: ${JSON.stringify(state)}`);
    assert.ok(state.bar.bottom <= state.navTop - 1, `${label}: save bar must clear navigation`);
    return state;
  };
  await evaluate(`window.__layoutConfigPosts=0;window.__layoutFetch=window.fetch;window.fetch=function(url,options){if(String(url)==='/api/config'&&options?.method==='POST')window.__layoutConfigPosts++;return window.__layoutFetch.apply(this,arguments)}`);
  try {
    await metrics(1440, 900, false);
    await navigate('overview');
    const palettes = {};
    for (const theme of ['light', 'dark']) {
      await evaluate(`if(document.body.dataset.theme!==${JSON.stringify(theme)})document.querySelector('#btn-theme').click()`);
      // Wait for any theme transition, then compare luminance rather than palette literals.
      await wait(`document.body.dataset.theme===${JSON.stringify(theme)}`);
      palettes[theme] = await evaluate(`(()=>{
        const luminance=color=>{const rgb=color.match(/[\\d.]+/g).slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
        return Object.fromEntries(['body','#sidebar','.studio-hero'].map(selector=>[selector,luminance(getComputedStyle(document.querySelector(selector)).backgroundColor)]));
      })()`);
    }
    for (const selector of ['body', '#sidebar', '.studio-hero']) {
      assert.ok(palettes.light[selector] > .5 && palettes.dark[selector] < .2 && palettes.light[selector] > palettes.dark[selector] + .4, `${selector}: background must follow the selected theme: ${JSON.stringify(palettes)}`);
    }
    await evaluate("document.querySelector('#btn-theme').click()");
    for (const [width, height] of [[375, 740], [320, 480], [430, 540]]) {
      await metrics(width, height);
      await navigate('overview');
      await wait("document.querySelector('.studio-topology-preview svg') && parseFloat(document.documentElement.style.getPropertyValue('--mobile-nav-height'))>0");
      await mobileBounds(width, `overview ${width}px`);
      // Exercise the real graph renderer with long identifiers, then a wide SVG viewBox.
      // Its intrinsic ratio must never become the min-content width of the page grid.
      await evaluate(`(()=>{
        const name='连续的长世界名称与标识'.repeat(40), entities={place:{id:'place',name,kind:'place',revision:1},bot:{id:'bot',name,kind:'actor',location:'place',revision:1}};
        for(let i=0;i<5;i++)entities['object_'+i]={id:'object_'+i,name:name+i,kind:'object',location:'bot',owner:'bot',revision:1};
        const holder=document.querySelector('.studio-topology-preview');holder.replaceChildren();Studio.drawWorldPreview(holder,{entities});holder.querySelector('svg').setAttribute('viewBox','0 0 4096 280');
        document.querySelector('.studio-bot-card h3').textContent=name;
        // Real speech can be much longer than a graph node label. Its ellipsis must
        // stay inside the activity column instead of pushing the timestamp/page out.
        document.querySelector('.studio-activity-item p').textContent='窗外的风把树叶吹得沙沙响，我想先整理一下今天的想法，再去看看这个世界还有哪些新的地方可以探索。';
      })()`);
      await settle();
      await mobileBounds(width, `wide relationship graph ${width}px`);
      await evaluate("document.querySelector('.studio-topology-preview').scrollIntoView({block:'center',behavior:'instant'})");
      await settle();
      await mobileBounds(width, `scrolled overview ${width}px`);
      await evaluate("window.__layoutScrollY=scrollY;window.__layoutOverview=document.querySelector('.studio-kpi-row');window.dispatchEvent(new CustomEvent('studio:refresh'))");
      await wait("document.querySelector('.studio-kpi-row')!==window.__layoutOverview");
      await settle();
      await mobileBounds(width, `refreshed overview ${width}px`);
      assert.ok(await evaluate('Math.abs(scrollY-window.__layoutScrollY)<3'), `overview ${width}px: refresh must preserve the reader's scroll position`);

      await navigate('config');
      await wait("document.querySelector('#cfg-body input') && document.querySelector('.cfg-savebar button')");
      await evaluate(`(()=>{
        const input=Array.from(document.querySelectorAll('#cfg-body input')).find(node=>node.getClientRects().length&&!node.disabled&&['checkbox','number','text','password'].includes(node.type));
        if(!input)throw Error('No editable configuration field');
        if(input.type==='checkbox')input.click();else {input.value=input.type==='number'?String(Number(input.value||0)+1):input.value+' layout preview';input.dispatchEvent(new Event(input.type==='number'?'change':'input',{bubbles:true}));}
      })()`);
      await wait('cfgDirty && document.querySelectorAll(".cfg-savebar button").length===2');
      await evaluate("document.querySelector('.cfg-savebar').scrollIntoView({block:'end',behavior:'instant'})");
      await settle();
      const before = await saveBounds(width, `dirty config ${width}px`);
      await mobileBounds(width, `dirty config ${width}px`);
      // CDP has no hardware safe-area setting. Change the same padding that env() feeds,
      // so a real nav resize exercises the observer and clearance without faking its value.
      await evaluate("var nav=document.querySelector('#mobile-nav');nav.style.paddingBottom=(parseFloat(getComputedStyle(nav).paddingBottom)+34)+'px'");
      await wait(`Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--mobile-nav-height'))-document.querySelector('#mobile-nav').getBoundingClientRect().height)<1 && document.querySelector('#mobile-nav').getBoundingClientRect().height>${before.navHeight + 30}`);
      await settle();
      const after = await saveBounds(width, `safe area config ${width}px`);
      assert.ok(Math.abs((after.offset - before.offset) - (after.navHeight - before.navHeight)) < 1, `config ${width}px: save clearance must follow the actual navigation height`);
      await mobileBounds(width, `safe area config ${width}px`);
      await evaluate("document.querySelector('#mobile-nav').style.removeProperty('padding-bottom')");
      await metrics(1440, 900, false);
      await wait("document.querySelector('#mobile-nav').getBoundingClientRect().height===0 && parseFloat(document.documentElement.style.getPropertyValue('--mobile-nav-height'))===0");
      assert.ok(await evaluate("parseFloat(getComputedStyle(document.querySelector('.cfg-savebar')).bottom)<30"), 'Desktop config must not retain a mobile navigation offset');
      await evaluate("Array.from(document.querySelectorAll('.cfg-savebar button')).find(b=>b.textContent==='放弃修改').click()");
      await wait('!cfgDirty && document.querySelectorAll(".cfg-savebar button").length===1');
    }
    assert.equal(await evaluate('window.__layoutConfigPosts'), 0, 'Layout checks edit only a local draft and never save configuration');
    return 'consistent theme backgrounds, device-width graph containment, five touchable navigation items through scroll/refresh, dirty config clearance across safe-area/nav resizing and desktop return';
  } finally {
    await evaluate(`window.fetch=window.__layoutFetch;document.querySelector('#mobile-nav').style.removeProperty('padding-bottom');if(document.body.dataset.theme!==${JSON.stringify(originalTheme)})document.querySelector('#btn-theme').click();delete window.__layoutFetch;delete window.__layoutConfigPosts;delete window.__layoutScrollY;delete window.__layoutOverview;`);
    await metrics(375, 1050);
  }
}
