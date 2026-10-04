/** Guided first-run setup only operates the marked, ephemeral local preview. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export default async function smokeSetup({ evaluate, wait, assert, navigate, page }) {
  assert(await evaluate("location.hostname==='127.0.0.1' && fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Tour smoke requires an isolated local preview');
  const fixture = async options => evaluate(`fetch('/api/preview/setup',${options ? JSON.stringify({ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(options) }) : '{}'}).then(r=>r.json())`);
  const opened = "!!document.querySelector('.setup-tour[data-tour-step]')";
  const closed = "!document.querySelector('.setup-tour')";
  const currentStep = () => evaluate("document.querySelector('.setup-tour')?.dataset.tourStep");
  const click = async action => {
    await wait(`!!document.querySelector('[data-tour-action="${action}"]') && !document.querySelector('[data-tour-action="${action}"]').disabled`);
    await evaluate(`document.querySelector('[data-tour-action="${action}"]').click()`);
  };
  const next = async () => {
    const previous = await currentStep();
    await click('next');
    await wait(`${opened} && document.querySelector('.setup-tour').dataset.tourStep!==${JSON.stringify(previous)}`);
  };
  const open = async () => { await evaluate('SetupTour.open()'); await wait(opened); };
  const field = (path, value) => evaluate(`(()=>{const input=document.querySelector('[data-config-path="${path}"]');if(!input)throw Error('Missing real config control: ${path}');if(input.type==='checkbox')input.checked=${JSON.stringify(value)};else input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const reload = async hash => {
    await page('Page.navigate', { url: await evaluate('location.origin') + (hash || '') });
    await wait("typeof Studio!=='undefined' && typeof SetupTour!=='undefined' && document.querySelector('main').childElementCount>0 && !document.querySelector('.studio-skeleton')");
  };
  const fresh = async options => {
    await fixture({ reset:'fresh',...options });
    await evaluate("localStorage.removeItem('wui_token');localStorage.removeItem('wui_mode');TOKEN='';MODE='admin';");
    await reload(); await wait(opened);
    await wait("api('GET','/api/setup').then(s=>s.presented && !s.shouldPrompt)");
  };
  const at = id => wait(`document.querySelector('.setup-tour')?.dataset.tourStep===${JSON.stringify(id)}`);
  const prepareField = async () => {
    const id = await currentStep();
    if (id==='bot-endpoint' || id==='world-endpoint') await field(id.startsWith('bot') ? 'bot.baseURL' : 'world.baseURL', await evaluate("location.origin+'/fixture-model/v1'"));
    if (id==='bot-model' || id==='world-model') {
      const path=id.startsWith('bot') ? 'bot.model' : 'world.model';
      if (!await evaluate(`document.querySelector('[data-config-path="${path}"]')?.value`)) await field(path, 'fixture-tour-model');
    }
  };
  const seek = async id => {
    for (let index=0; index<30; index++) {
      if (await currentStep()===id) { await settle(); return; }
      await prepareField(); await next();
    }
    throw Error('Tour failed to reach '+id);
  };
  const snapshot = () => evaluate("Promise.all([api('GET','/api/config'),api('GET','/api/state')]).then(([c,s])=>({config:c.value,botDef:s.botDef,worldDef:s.worldDef,initialized:s.initialized}))");
  const quiet = async baseline => {
    assert.deepEqual(await snapshot(), baseline, 'Tour navigation does not save config, replace definitions, or create a world');
    const state = await fixture();
    assert.equal(state.counts.applies, 0, 'Tour navigation does not apply setup configuration');
    assert.equal(state.counts.genesis, 0, 'Tour navigation does not perform genesis');
    assert.equal(state.counts.starts, 0, 'Tour navigation does not start autonomous activity');
  };
  const settle = () => evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))))");
  const fits = async (width,height=1000) => {
    await page('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:width<600 });
    await settle();
    assert(await evaluate(`document.documentElement.scrollWidth<=${width+1} && innerWidth<=${width+1} && visualViewport.width<=${width+1}`), 'Tour fits the '+width+'px viewport');
    const layout = await evaluate(`(()=>{
      const card=document.querySelector('#setup-tour-card'),r=card.getBoundingClientRect();
      const controls=Array.from(card.querySelectorAll('button')).filter(b=>b.getClientRects().length).map(b=>{const v=b.getBoundingClientRect(),hit=document.elementFromPoint((v.left+v.right)/2,(v.top+v.bottom)/2);return {text:b.textContent,visible:!!hit&&b.contains(hit),left:v.left,right:v.right,top:v.top,bottom:v.bottom};});
      return {card:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},controls};
    })()`);
    assert(layout.card.left>=0 && layout.card.right<=width+1 && layout.card.top>=0 && layout.card.bottom<=height, 'Guide stays within '+width+'px viewport: '+JSON.stringify(layout));
    assert(layout.controls.length && layout.controls.every(r=>r.visible&&r.left>=0&&r.right<=width+1&&r.top>=0&&r.bottom<=height), 'All guide buttons remain touchable at '+width+'px: '+JSON.stringify(layout));
    const alignment=await evaluate(`(()=>{
      const selector=document.querySelector('.setup-tour').dataset.tourTarget,element=document.querySelector(selector),spot=document.querySelector('.setup-tour-spotlight');
      const target=selector.startsWith('[data-config-path=')?element.closest('.fld,.sw-row')||element:element;
      const r=target.getBoundingClientRect(),s=spot.getBoundingClientRect(),v=visualViewport;
      return {step:document.querySelector(".setup-tour").dataset.tourStep,hidden:spot.hidden,delta:[Math.abs(s.left-Math.max(v.offsetLeft+4,r.left-5)),Math.abs(s.top-Math.max(v.offsetTop+4,r.top-5)),Math.abs(s.right-Math.min(v.offsetLeft+v.width-4,r.right+5)),Math.abs(s.bottom-Math.min(v.offsetTop+v.height-4,r.bottom+5))]};
    })()`);
    assert(!alignment.hidden && alignment.delta.every(delta=>delta<2), 'Spotlight follows the live target after layout at '+width+'px: '+JSON.stringify(alignment));
  };
  const hit = async selector => {
    const result = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return {missing:true};const target=e.type==='checkbox'?e.closest('.sw-row')||e:e,r=target.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,top=document.elementFromPoint(x,y);return {clickable:!!top&&(top===target||target.contains(top)),left:r.left,right:r.right,top:r.top,bottom:r.bottom,hit:top?.outerHTML.slice(0,300)};})()`);
    assert(result.clickable, 'Real target remains clickable: '+selector+' '+JSON.stringify(result));
  };
  const capture = async name => {
    if (!process.env.STUDIO_SCREENSHOT_DIR) return;
    const directory = resolve(process.env.STUDIO_SCREENSHOT_DIR); await mkdir(directory, { recursive:true });
    for (const width of [1440,375,320]) {
      await fits(width);
      await evaluate('document.fonts.ready');
      const screenshot = await page('Page.captureScreenshot', { format:'png',captureBeyondViewport:false });
      await writeFile(join(directory, 'setup-tour-'+name+'-'+width+'.png'), Buffer.from(screenshot.data, 'base64'));
    }
  };
  try {
    await navigate('overview');
    assert(await evaluate(closed), 'An initialized world does not open onboarding');
    assert(await evaluate("!document.querySelector('#nav a[href=\"#setup\"]')"), 'The tour has no standalone navigation item');
    await open(); await click('skip'); await wait(closed);
    assert.equal((await fixture()).counts.applies, 0, 'Skipping does not save configuration');

    await fresh({ storedKeys:true });
    const baseline = await snapshot();
    assert(await evaluate("!document.querySelector('[data-setup-path]')"), 'The overlay contains no duplicate setup form');
    await reload(); await wait("activeView==='overview' && !!document.querySelector('.studio-hero')");
    assert(await evaluate(closed), 'Once displayed, the first-run tour does not reopen on refresh');
    await open();
    await evaluate("document.querySelector('[data-tour-action=next]').focus()");
    await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
    await page('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await at('bot-protocol');
    assert(await evaluate("document.activeElement===document.querySelector('#setup-tour-card')"),'Keyboard step navigation keeps focus on the guide');
    await seek('bot-model');
    assert(await evaluate("document.querySelector('[data-config-path=\"bot.apiKey\"]').value==='' && document.querySelector('[data-config-path=\"bot.apiKey\"]').placeholder.includes('已设置')"), 'Real config keeps stored credentials masked');
    await field('bot.model', 'fixture-tour-model');
    await evaluate("window.__tourFocused=document.querySelector('[data-config-path=\"bot.model\"]');window.__tourFocused.focus();window.__tourFocused.setSelectionRange(3,8);window.dispatchEvent(new CustomEvent('studio:debug',{detail:{kind:'bot.event'}}));window.dispatchEvent(new CustomEvent('studio:refresh'));refreshOverview(false);");
    await settle();
    assert(await evaluate("document.activeElement===window.__tourFocused && document.querySelector('[data-config-path=\"bot.model\"]')===window.__tourFocused && window.__tourFocused.selectionStart===3 && window.__tourFocused.selectionEnd===8 && window.__tourFocused.value==='fixture-tour-model' && cfgDirty"), 'Live events retain the real input, caret, focus and draft');
    await next(); await at('world-protocol'); await click('back'); await at('bot-model');
    assert(await evaluate("document.querySelector('[data-config-path=\"bot.model\"]').value==='fixture-tour-model' && cfgCache.bot.model==='fixture-tour-model' && cfgDirty"), 'Moving across configuration groups and back preserves the real draft');
    await click('skip'); await wait(closed);
    assert(await evaluate("activeView==='config' && document.querySelector('[data-config-path=\"bot.model\"]').value==='fixture-tour-model' && cfgDirty"), 'Skipping preserves the current page and unsaved draft');
    await wait("api('GET','/api/setup').then(s=>s.dismissed && !s.completed && !s.shouldPrompt)");
    await open();
    assert(await evaluate("activeView==='config' && cfgCache.bot.model==='fixture-tour-model' && cfgDirty"), 'Manual reopen retains the existing configuration draft');
    await click('skip'); await wait(closed); await quiet(baseline);
    await reload(); await wait("activeView==='overview'");
    assert(await evaluate(closed), 'Dismissed onboarding stays closed after reload');

    await reload('#setup'); await wait(opened);
    assert.notEqual(await evaluate('activeView'), 'setup', 'Legacy setup hash opens an overlay on a real page');
    await page('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
    await page('Input.dispatchKeyEvent', { type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
    await wait(closed);

    await fresh();
    const walkthroughBaseline = await snapshot();
    assert(await evaluate("document.querySelector('.setup-tour-gesture').getAttribute('aria-hidden')==='true' && getComputedStyle(document.querySelector('.setup-tour-gesture')).animationName!=='none'"), 'The decorative hand cue animates when motion is allowed');
    await page('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] });
    await settle();
    assert(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches && Array.from(document.querySelectorAll('.setup-tour-gesture')).every(e=>getComputedStyle(e).animationName==='none'||getComputedStyle(e).animationDuration==='0s')"), 'Reduced motion disables the animated gesture');
    const visited=[];
    for (let index=0; index<30; index++) {
      const id=await currentStep(); visited.push(id);
      await wait("!!document.querySelector('.setup-tour')?.dataset.tourTarget");
      for (const theme of ['light','dark']) {
        await evaluate(`if(document.body.dataset.theme!==${JSON.stringify(theme)})document.querySelector('#btn-theme').click()`);
        for (const width of [1440,375,320]) {
          await fits(width);
          const target=await evaluate("document.querySelector('.setup-tour').dataset.tourTarget");
          if(target?.startsWith('[data-config-path=')) await hit(target);
        }
      }
      if(id==='bot-model'||id==='save-config'){await fits(320,640);if(id==='bot-model')await hit('[data-config-path=\"bot.model\"]');await fits(320);}
      if (index===0) await capture('intro');
      if(id==='bot-protocol') assert.deepEqual(await evaluate('cfgCache'),walkthroughBaseline.config,'Entering real configuration does not silently change defaults or presets');
      await prepareField();
      if(id==='bot-key') await field('bot.apiKey','fixture-tour-key-one');
      if(id==='access') await field('webui.token','fixture-tour-admin-token');
      if (id==='save-config') {
        await quiet(walkthroughBaseline);
        await click('next'); await at('save-config');
        assert(await evaluate("document.querySelector('.setup-tour-feedback').textContent.includes('保存')"), 'Guide requires the real configuration save before advancing');
        await hit('.cfg-savebar .primary');
        await fixture({ failSave:true });
        await evaluate("document.querySelector('.cfg-savebar .primary').click()");
        await wait("!cfgSavePromise && cfgDirty && document.querySelector('.setup-tour-feedback').textContent.includes('失败')");
        assert.equal(await evaluate('cfgCache.bot.model'), 'fixture-tour-model', 'Failed actual save retains the model draft');
        await fixture({ failSave:false,saveDelayMs:400 });
        const beforeSave=(await fixture()).counts.configSaves;
        await evaluate("document.querySelector('.cfg-savebar .primary').click();document.querySelector('.cfg-savebar .primary').click()");
        await wait('!cfgDirty && !cfgSavePromise');
        assert.equal((await fixture()).counts.configSaves,beforeSave+1,'The real save control deduplicates repeated clicks');
        assert(await evaluate("api('GET','/api/config').then(c=>c.value.bot.model==='fixture-tour-model' && c.value.world.model==='fixture-tour-model')"), 'The guide uses the actual configuration save path');
        assert(await evaluate("TOKEN==='fixture-tour-admin-token' && localStorage.getItem('wui_token')===TOKEN && !document.querySelector('#modal.show')"), 'Real config save retains administrator access after changing the token');
        await evaluate("window.__tourSavedApi=api;api=function(method,path,...args){if(method==='GET'&&path==='/api/config')return new Promise(resolve=>{window.__tourReleaseCheck=()=>window.__tourSavedApi(method,path,...args).then(resolve)});return window.__tourSavedApi(method,path,...args)};document.querySelector('[data-tour-action=next]').click()");
        await wait("typeof window.__tourReleaseCheck==='function'");
        await click('back'); await at('platform');
        await evaluate("api=window.__tourSavedApi;window.__tourReleaseCheck().then(()=>{delete window.__tourReleaseCheck;delete window.__tourSavedApi})");
        await settle();
        assert.equal(await currentStep(),'platform','A late save-check response cannot advance a step after Back');
        await next(); await at('save-config');
        await capture('save');
      }
      if (id==='bot-definition' || id==='world-definition') {
        const pane=id==='bot-definition'?'botdef':'worlddef',key=id==='bot-definition'?'botDef':'worldDef';
        const definition=id==='bot-definition'?'林岚是一名喜欢植物的图书管理员，认真观察变化，再决定行动。':'一座安静的小镇，图书馆旁有花园。世界的时间、距离与物理规则保持一致。';
        await evaluate(`(()=>{const e=document.querySelector('[data-pane="${pane}"] textarea');e.value=${JSON.stringify(definition)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await click('next'); await at(id);
        assert(await evaluate("document.querySelector('.setup-tour-feedback').textContent.includes('保存')"), 'Definition navigation waits for explicit editor save');
        await evaluate(`document.querySelector('[data-pane="${pane}"] .primary').click()`);
        await wait(`api('GET','/api/state').then(s=>s.${key}===${JSON.stringify(definition)})`);
      }
      if (id==='finish') break;
      await next();
    }
    assert.equal(visited.length,25,'Tour visits each basic step: '+visited.join(', '));
    await capture('finish');
    assert.equal((await fixture()).counts.genesis,0,'Tour never automatically creates a world');
    assert.equal((await fixture()).counts.starts,0,'Tour never automatically starts the world');
    await click('advanced'); await at('advanced-media');
    for (const id of ['advanced-media','advanced-apps','advanced-growth','advanced-save']) {
      await at(id); await fits(320);
      if(id==='advanced-growth') await field('bot.apiKey','fixture-tour-key-two');
      if(id==='advanced-save') {
        await fixture({configApplyDelayMs:1000,saveDelayMs:0});
        await evaluate("document.querySelector('.cfg-savebar .primary').click()");
        await wait('!cfgSavePromise && !cfgDirty');
        await click('finish'); await at('advanced-save');
        await wait("document.querySelector('.setup-tour-feedback').textContent.includes('旧配置')");
        await wait("api('GET','/api/config').then(c=>c.revision===cfgSavedRevision)");
      } else await next();
    }
    await click('finish'); await wait(closed);
    assert(await evaluate("api('GET','/api/setup').then(s=>s.presented && !s.shouldPrompt && !s.initialized && !s.running)"), 'Finishing leaves lifecycle operations explicit and consumes only the first prompt');
    assert(await evaluate("!JSON.stringify(localStorage).includes('fixture-stored-bot-credential') && !JSON.stringify(localStorage).includes('fixture-stored-world-credential')"), 'Model credentials are never persisted in browser storage');
    await reload(); await wait("activeView==='overview'");
    assert(await evaluate(closed), 'Finished onboarding stays closed on refresh');

    await evaluate("MODE='visitor';VISITOR_TOKEN='fixture-visitor';VISITOR_GRANTS=['overview','config'];window.dispatchEvent(new CustomEvent('studio:auth'));SetupTour.open();");
    await settle();
    assert(await evaluate(closed+" && !document.querySelector('#nav a[href=\"#setup\"]')"), 'Visitors cannot open the administrator tour');
    assert(await evaluate("fetch('/api/setup',{headers:{'x-visitor-token':'fixture-visitor'}}).then(r=>r.status===403)"), 'The preview enforces the setup visitor boundary');
    return 'overlay setup tour: one-time prompt, real controls and retained drafts, explicit saves, optional advanced branch, keyboard/visitor boundaries, reduced motion and 320/375/1440px light/dark layout';
  } finally {
    await page('Emulation.setEmulatedMedia', { features:[] });
    await fixture({ reset:'sample' });
    await evaluate("if(window.__tourSavedApi)api=window.__tourSavedApi;delete window.__tourSavedApi;delete window.__tourReleaseCheck;delete window.__tourFocused;MODE='admin';TOKEN='';VISITOR_TOKEN='';VISITOR_GRANTS=[];localStorage.removeItem('wui_token');localStorage.removeItem('wui_mode');");
    await reload(); await wait("activeView==='overview' && !!document.querySelector('.studio-hero')");
  }
}
