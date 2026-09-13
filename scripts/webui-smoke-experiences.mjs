/** Structured experiences, late scenes and replay; only the isolated fixture. */
export default async function smokeExperiences({ evaluate, wait, assert, navigate }, { resident = false, mode = 'cross' } = {}) {
  const run = (fn, arg) => evaluate(`(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`);
  assert(await run(async()=>location.port!=='18111'&&(await(await fetch('/api/health')).json()).preview),'Experience tests require an isolated sample world');
  await run(resident=>{
    const input=document.querySelector(resident?'[data-cockpit-field="act:description"]':'.journey-action-input');
    input.value='去吃饭';input.dispatchEvent(new Event('input',{bubbles:true}));
    const duration=document.querySelector(resident?'[data-cockpit-field="duration"]':'.journey-two-fields input');
    if(duration){duration.value='0';duration.dispatchEvent(new Event('input',{bubbles:true}));}
    input.closest('form').requestSubmit();
  },resident);
  await wait(`!!Array.from(document.querySelectorAll('.journey-action-card')).find(n=>n.querySelector('h3')?.textContent==='去吃饭'&&n.dataset.actionStatus==='needs_input')&&!document.querySelector('.journey-pending')`);
  await run(async()=>{window.__experienceSmoke=await(await fetch('/api/preview/player/story')).json();});
  assert(await run(mode=>{
    const group=[...document.querySelectorAll('.journey-action-card')].find(n=>n.querySelector('h3')?.textContent==='去吃饭');
    const movement=group.querySelector('[data-journey-event="'+window.__experienceSmoke.actionId+':movement"]'),speech=group.querySelector('[data-journey-event="'+window.__experienceSmoke.actionId+':speech-view"]');
    window.__experienceSmoke.groupId=group.dataset.journeyGroup;
    return group.querySelector('.journey-action-state').textContent==='等你决定'&&group.querySelector('.journey-feed-result').textContent.includes('等你选择饭菜')&&!!movement&&!!speech&&!!(movement.compareDocumentPosition(speech)&Node.DOCUMENT_POSITION_FOLLOWING)&&group.querySelectorAll('.journey-feed-speech').length===0&&!!group.querySelector('.journey-feed-scene')===(mode==='avatar');
  },mode),'Immediate facts and NPC response are chronologically grouped with the intent; an inline scene never discards the needs_input handoff or observation');
  if(mode==='avatar') assert(await run(()=>!document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"] .journey-experience-details').open),'An inline narrative leads the card, with its factual steps available in one expandable control');
  if(mode==='puppet') assert(await run(()=>document.querySelector('.journey-control-notice')?.textContent.includes('不由自主')),'Puppet SSE receipts retain the non-voluntary action notice when HTTP repeats the same receipt');
  await run(()=>{
    const group=document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"]');
    window.__experienceSmoke.raw=group.querySelector(':scope>.readable-raw');window.__experienceSmoke.raw.open=true;
  });
  await wait(`!!document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"] > .readable-raw .readable-source')`);
  assert(await run(()=>document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"] > .readable-raw').textContent.includes('needs_input')&&document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"] > .readable-raw').textContent.includes('去吃饭')),'The full action receipt and original intent remain expandable');
  await run(async resident=>{
    const input=document.querySelector(resident?'[data-cockpit-field="act:description"]':'.journey-action-input');
    input.value='我正在决定下一步';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(1,4);input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    window.__experienceSmoke.input=input;window.__experienceSmoke.extraFocus=0;window.__experienceSmoke.onFocus=()=>window.__experienceSmoke.extraFocus++;document.addEventListener('focusin',window.__experienceSmoke.onFocus);
    await fetch('/api/preview/player/story',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phase:'scene',actionId:window.__experienceSmoke.actionId})});
  },resident);
  await wait(`!!document.querySelector('[data-journey-event="'+window.__experienceSmoke.actionId+':scene"]')`);
  assert(await run(()=>{
    const input=window.__experienceSmoke.input,group=document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"]');
    return input.isConnected&&input===document.activeElement&&input.value==='我正在决定下一步'&&input.selectionStart===1&&input.selectionEnd===4&&window.__experienceSmoke.extraFocus===0&&group.querySelectorAll('.journey-feed-experience').length===2&&group.querySelectorAll('.journey-feed-result').length===1&&group.querySelectorAll('.journey-feed-scene').length===1&&group.querySelector(':scope>.readable-raw').open;
  }),'Late narrative extends the same action without replacing deterministic facts, raw expansion, or the composing input');
  if(mode==='puppet') assert(await run(()=>document.querySelector('[data-journey-event="'+window.__experienceSmoke.actionId+':scene"] .journey-control-notice')?.textContent.includes('不由自主')),'The main puppet narrative retains its explicit non-voluntary-action notice');
  if(mode!=='avatar') assert(await run(()=>document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"] .journey-experience-details').open),'Adding a late narrative keeps already-visible factual steps open');
  await run(async()=>{
    await fetch('/api/preview/player/story',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phase:'ambient'})});
  });
  await wait(`Array.from(document.querySelectorAll('.journey-feed-experience')).some(n=>n.textContent.includes('两下敲门声'))`);
  await run(()=>{window.__experienceSmoke.latestObservation=document.querySelector('.journey-state-details').dataset.journeyObservation;});
  assert(await run(resident=>{
    const id=window.__experienceSmoke.latestObservation,select=document.querySelector(resident?'[data-cockpit-field="act:target"]':'.journey-two-fields select'),suffix=id.replace('ambient_','');
    return id.startsWith('ambient_')&&[...select.options].some(option=>option.value.includes('seen_'+suffix+'_'))&&document.querySelector('[data-journey-event="ambient_scene_'+suffix+'"]')&&document.querySelector('[data-journey-event="ambient_'+suffix+'"]');
  },resident),'A top-level observation plus scene updates the current observation, available target handles and factual experience together');
  await run(async()=>{await fetch('/api/preview/player/story',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phase:'replay',actionId:window.__experienceSmoke.actionId})});});
  await run(()=>new Promise(resolve=>setTimeout(resolve,100)));
  assert(await run(()=>{
    const group=document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"]');
    return document.querySelector('.journey-action-card').textContent.includes('两下敲门声')&&group.querySelectorAll('.journey-feed-experience').length===2&&group.querySelectorAll('.journey-feed-scene').length===1&&group.querySelectorAll('.journey-feed-result').length===1&&document.querySelector('.journey-state-details').dataset.journeyObservation===window.__experienceSmoke.latestObservation&&document.activeElement===window.__experienceSmoke.input;
  }),'Ambient perception arrives independently; repeated and late messages neither duplicate events, reorder old actions ahead of new ones, nor roll back current observation');
  if(mode==='puppet') assert(await run(()=>document.querySelector('[data-journey-event="'+window.__experienceSmoke.actionId+':scene"] .journey-control-notice')?.textContent.includes('不由自主')),'Replayed puppet scenes keep the non-voluntary-action notice');
  assert(await run(()=>document.documentElement.scrollWidth<=innerWidth),'Narrative cards and expanded raw receipts fit the current viewport');
  await run(()=>{const s=window.__experienceSmoke;s.input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));document.removeEventListener('focusin',s.onFocus);s.input.blur();});
  if(resident){
    await navigate('devices');await navigate('player');
    await wait(`!!document.querySelector('[data-cockpit-field="act:description"]')`);
    assert(await run(()=>document.querySelector('[data-cockpit-field="act:description"]').value==='我正在决定下一步'&&document.querySelector('[data-journey-group="'+window.__experienceSmoke.groupId+'"] .journey-feed-scene')),'Changing pages keeps the action history, appended scene and unsubmitted draft');
  }
  await run(()=>{document.querySelectorAll('.journey-action-card>.readable-raw').forEach(n=>n.open=false);delete window.__experienceSmoke;});
}
