/** Natural-language world receipts and zero-entity controls against isolated fixtures only. */
export default async function smokeNarrative({ evaluate, wait, assert, navigate, page }) {
  const run = (fn, arg) => evaluate(`(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`);
  const click = text => run(text => { const button=[...document.querySelectorAll('main button')].find(node=>node.textContent.trim()===text); if(!button)throw Error('Button missing: '+text);button.click(); }, text);
  assert(await run(async()=>location.port!=='18111'&&(await(await fetch('/api/health')).json()).preview),'Natural-world smoke requires an isolated fixture');
  await run(async()=>{await api('POST','/api/preview/narrative',{enabled:true});await api('POST','/api/world/start',{});await refreshOverview(false);});
  try {
    for(const width of [375,1440]) {
      await page('Emulation.setDeviceMetricsOverride',{width,height:1050,deviceScaleFactor:1,mobile:width<600});
      await navigate('overview');
      await wait(`document.querySelector('.world-narrative-preview')?.textContent.includes('阿青')`);
      assert(await run(()=>document.querySelector('main').textContent.includes('身体没有不适')&&!document.querySelector('main').textContent.includes('暂时没有结构化状态')&&document.documentElement.scrollWidth<=innerWidth),'Overview reads world and actor prose without an empty-entity error or overflow');
      await navigate('world');
      await wait(`!!document.querySelector('[data-world-mode="narrative"]')`);
      assert(await run(()=>document.querySelector('.world-controls').hidden&&document.querySelector('.world-current-scene').textContent.includes('出发前还要确认时间')&&document.querySelector('[data-world-actor="bot"]').textContent.includes('还没有吃午饭')&&document.querySelector('.world-event-list').textContent.includes('下午一起走走')&&!document.querySelector('.world-node')&&document.documentElement.scrollWidth<=innerWidth),'World view displays persistent context, actor situation and narrative events without inventing entity nodes');
    }
    await page('Emulation.setDeviceMetricsOverride',{width:375,height:1050,deviceScaleFactor:1,mobile:true});
    for(const mode of ['cross','puppet','avatar']) {
      await navigate('player');
      const leave=await run(()=>[...document.querySelectorAll('main button')].find(n=>['离开世界','归还控制并离场'].includes(n.textContent.trim()))?.textContent.trim());
      if(leave){await click(leave);await wait(`!!document.querySelector('.journey-identity')`);}
      await click(mode==='cross'?'作为独立角色入场':'接管常驻角色');
      if(mode==='cross')await run(()=>{const input=document.querySelector('.journey-identity input');input.value='自然世界旅人';input.dispatchEvent(new Event('input',{bubbles:true}));});
      else await run(mode=>document.querySelector('[data-takeover-mode="'+mode+'"]').click(),mode);
      await wait(`!document.querySelector('[data-journey-arrive]').disabled`);
      await run(()=>document.querySelector('[data-journey-arrive]').click());
      await wait(`!!document.querySelector('.journey-connection.connected')`);
      if(mode!=='cross')await wait(`!!document.querySelector('[data-cockpit-field="act:description"]')&&!document.querySelector('.cockpit-submit').disabled`);
      await click('重新观察');
      await wait(`document.querySelector('.journey-state-body')?.textContent.includes('花园传来阿青')`);
      assert(await run(()=>!document.querySelector('.journey-entity')&&document.querySelector('.journey-state-summary').textContent.includes('所见所闻')),'A narrative observation is readable and actionable even with zero entities');
      await run(mode=>{
        const input=document.querySelector(mode==='cross'?'.journey-action-input':'[data-cockpit-field="act:description"]');
        const target=document.querySelector(mode==='cross'?'[data-cockpit-field="action:target"]':'[data-cockpit-field="act:target"]');
        input.value='去吃饭';target.value='街角的餐厅';[input,target].forEach(n=>n.dispatchEvent(new Event('input',{bubbles:true})));
        const duration=document.querySelector(mode==='cross'?'.journey-two-fields input[type="number"]':'[data-cockpit-field="duration"]');duration.value='0';duration.dispatchEvent(new Event('input',{bubbles:true}));
        input.closest('form').requestSubmit();
      },mode);
      await wait(`document.querySelector('.journey-action-card[data-action-status="needs_input"]')?.textContent.includes('风铃轻轻响了一声')&&!document.querySelector('.journey-pending')`);
      assert(await run(()=>{const card=document.querySelector('.journey-action-card[data-action-status="needs_input"]');return card.querySelector('.journey-feed-scene').textContent.includes('店员等着你的回答')&&card.querySelector('.journey-action-state').textContent==='等你决定'&&!card.querySelector('.journey-feed-experience');}),'World-generated prose leads the result directly, without manufactured structural steps');
      if(mode==='puppet') assert(await run(()=>document.querySelector('.journey-feed-scene .journey-control-notice')?.textContent.includes('不由自主')),'Body-only control keeps the agency notice alongside natural prose');
      if(mode==='cross') {
        await run(()=>{const input=document.querySelector('.journey-action-input');input.value='看看菜单';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));window.__narrativeInput=input;document.querySelector('.journey-observe-intent').click();});
        await wait(`document.querySelector('.journey-state-body').textContent.includes('米饭现在就有')`);
        assert(await run(()=>window.__narrativeInput.isConnected&&document.activeElement===window.__narrativeInput&&window.__narrativeInput.value==='看看菜单'),'Intentful observation returns persistent scene details without replacing or refocusing the composing input');
        await run(()=>{window.__narrativeInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));window.__narrativeInput.blur();delete window.__narrativeInput;});
      }
      if(mode!=='cross') {
        await run(()=>document.querySelector('[data-cockpit-tool="observe"]').click());
        await wait(`!!document.querySelector('[data-cockpit-field="observe:intent"]')&&!document.querySelector('.cockpit-submit').disabled`);
        assert(await run(()=>!!document.querySelector('.cockpit-primary-fields [data-cockpit-field="observe:intent"]')),'Resident observation intent is visible without opening optional parameters');
        await run(()=>{const input=document.querySelector('[data-cockpit-field="observe:intent"]');input.value='仔细看看菜单';input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').requestSubmit();});
        await wait(`document.querySelector('.journey-state-body').textContent.includes('米饭现在就有')&&!document.querySelector('.journey-pending')`);
      }
      assert(await run(()=>document.documentElement.scrollWidth<=innerWidth),'Natural scenes and operation dock fit a phone');
      await click(mode==='cross'?'离开世界':'归还控制并离场');
      await wait(`!!document.querySelector('.journey-identity')`);
    }
    return ['natural world/actor/event prose at desktop and phone sizes','zero-entity act/observe in cross, puppet and avatar modes','direct narrative decision handoff, agency and stable IME inputs'];
  } finally {await run(async()=>{await api('POST','/api/preview/narrative',{enabled:false});});}
}
