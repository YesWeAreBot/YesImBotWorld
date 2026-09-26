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
      assert(await run(()=>!document.querySelector('.world-controls,.world-view-toggle,.world-canvas,.world-inspector')&&document.querySelector('.world-current-scene').textContent.includes('出发前还要确认时间')&&document.querySelector('[data-world-actor="bot"]').textContent.includes('还没有吃午饭')&&document.querySelector('.world-event-list').textContent.includes('下午一起走走')&&!document.querySelector('.world-node')&&document.documentElement.scrollWidth<=innerWidth),'World view removes retired entity UI and displays persistent context, actor situation and narrative events');
      assert(await run(()=>{const prose=document.querySelector('.world-event-prose .readable-prose'),row=prose.closest('.world-event-item'),header=row.querySelector('.world-event-header');return prose.getBoundingClientRect().width>=row.getBoundingClientRect().width*.98&&prose.getBoundingClientRect().top>=header.getBoundingClientRect().bottom;}),'Recent event prose uses its own full-width row at '+width+'px');
      // Exercise a long event through the page renderer, including a live refresh while expanded.
      await run(()=>{
        window.__worldWidthFetch=Studio.fetchWorld;
        let revision=0;
        Studio.fetchWorld=async()=>{const state=structuredClone(await window.__worldWidthFetch());state.snapshot.sequence+=++revision;state.events[0].payload.text='风掠过纸页，阿青继续讲述下午的打算。'.repeat(160)+' END_OF_EVENT';return state;};
      });
      try {
        await navigate('world');
        await run(()=>document.querySelector('.world-event-prose .readable-more').click());
        await wait(`document.querySelector('.world-event-prose .readable-prose').textContent.includes('END_OF_EVENT')`);
        await run(()=>{window.__worldWidthNode=document.querySelector('.world-event-prose');window.dispatchEvent(new CustomEvent('studio:refresh'));});
        await wait(`document.querySelector('.world-event-prose')!==window.__worldWidthNode`);
        assert(await run(()=>{const prose=document.querySelector('.world-event-prose .readable-prose');return prose.textContent.includes('END_OF_EVENT')&&prose.getBoundingClientRect().width>=prose.closest('.world-event-item').getBoundingClientRect().width*.98&&document.documentElement.scrollWidth<=innerWidth;}),'Expanded event keeps full width and expansion after refresh at '+width+'px');
        await run(()=>document.querySelector('.world-event-prose .readable-collapse').click());
        assert(await run(()=>!document.querySelector('.world-event-prose .readable-prose').textContent.includes('END_OF_EVENT')),'Long event can be collapsed again');
      } finally { await run(()=>{Studio.fetchWorld=window.__worldWidthFetch;delete window.__worldWidthFetch;delete window.__worldWidthNode;}); }
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
      await run(mode=>{
        const input=document.querySelector(mode==='cross'?'.journey-action-input':'[data-cockpit-field="act:description"]');
        input.value='仔细看看菜单';input.dispatchEvent(new Event('input',{bubbles:true}));input.closest('form').requestSubmit();
        input.value='我还想问问今天有没有汤';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));window.__narrativeInput=input;
      },mode);
      await wait(`document.querySelector('.journey-state-body').textContent.includes('米饭现在就有')&&!document.querySelector('.journey-pending')`);
      assert(await run(()=>window.__narrativeInput.isConnected&&document.activeElement===window.__narrativeInput&&window.__narrativeInput.value==='我还想问问今天有没有汤'&&!document.querySelector('[data-cockpit-tool="observe"]')),'Active observation uses act, while incoming scene updates preserve the composing draft');
      await run(()=>window.__narrativeInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
      await wait(`Array.from(document.querySelectorAll('.world-action-menu [data-action-choice]')).some(node=>node.textContent.includes('选米饭套餐'))`);
      await run(mode=>{
        const input=document.querySelector(mode==='cross'?'.journey-action-input':'[data-cockpit-field="act:description"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
        const choice=[...document.querySelectorAll('[data-action-choice]')].find(node=>node.textContent.includes('选米饭套餐'));
        document.querySelector('[data-action-edit="'+choice.dataset.actionChoice+'"]').click();
        [...document.querySelectorAll('.journey-dock button')].find(node=>node.textContent==='暂存草稿，填写建议')?.click();
      },mode);
      assert(await run(mode=>document.querySelector(mode==='cross'?'.journey-action-input':'[data-cockpit-field="act:description"]').value==='向店员点一份米饭套餐'&&!document.querySelector('.journey-pending')&&!document.querySelector('.journey-dock .world-action-menu')&&document.querySelector('.world-action-menu').textContent.includes('取舍'),mode),'Suggestions sit beside the story; supplementing speech explicitly opens the editor without executing the choice');
      await run(async mode=>{
        const input=document.querySelector(mode==='cross'?'.journey-speech-input':'[data-cockpit-field="act:speech"]');input.value='这份草稿请保留';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();window.__opportunityDraft=input;
        const update=await api('POST','/api/preview/opportunities',{text:'店员暂时去厨房了。',situation:'柜台暂时无人。',opportunities:[]});window.__oldOpportunityScene=update.previousScene;
      },mode);
      await wait(`!document.querySelector('.world-action-menu [data-action-choice]') && /失效|过期|情境已更新/.test(document.querySelector('.journey-dock').textContent)`);
      assert(await run(()=>window.__opportunityDraft.isConnected&&document.activeElement===window.__opportunityDraft&&window.__opportunityDraft.value==='这份草稿请保留'),'A changed scene retires old suggestions without stealing focus or discarding an edited draft');
      await run(async()=>{await api('POST','/api/preview/opportunities',{replayScene:window.__oldOpportunityScene});await new Promise(resolve=>setTimeout(resolve,150));});
      assert(await run(()=>!document.querySelector('.world-action-menu [data-action-choice]')&&window.__opportunityDraft.value==='这份草稿请保留'),'A late scene replay cannot revive obsolete suggestions');
      assert(await run(()=>![...document.querySelectorAll('.journey-feed-scene')].some(node=>node.textContent.includes('选米饭套餐')||node.textContent.includes('exclusiveGroup'))),'Suggested choices are never rendered as factual scene outcomes');
      assert(await run(()=>document.documentElement.scrollWidth<=innerWidth),'Natural scenes and operation dock fit a phone');
      await click(mode==='cross'?'离开世界':'归还控制并离场');
      await wait(`!!document.querySelector('.journey-identity')`);
    }
    return ['natural world/actor/event prose without retired controls; full-width short and long events, reversible folds and refresh persistence','zero-entity act and optional opportunities in cross, puppet and avatar modes','direct narrative decision handoff, agency and stable IME inputs'];
  } finally {await run(async()=>{await api('POST','/api/preview/narrative',{enabled:false});});}
}
