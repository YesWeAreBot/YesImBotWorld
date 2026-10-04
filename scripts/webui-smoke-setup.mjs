/** First-run setup is exercised only against the marked, ephemeral local preview. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export default async function smokeSetup({ evaluate, wait, assert, navigate, page }) {
  assert(await evaluate("location.hostname==='127.0.0.1' && fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Setup smoke requires an isolated local preview');
  const fixture = async options => evaluate(`fetch('/api/preview/setup',${options ? JSON.stringify({ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(options) }) : '{}'}).then(r=>r.json())`);
  const status = value => `document.querySelector('[data-setup-status]')?.dataset.setupStatus===${JSON.stringify(value)}`;
  const step = value => wait(`document.querySelector('[data-setup-step]')?.dataset.setupStep===${JSON.stringify(String(value))}`);
  const click = action => evaluate(`document.querySelector('[data-setup-action="${action}"]').click()`);
  const field = (path, value) => evaluate(`(()=>{const input=document.querySelector('[data-setup-path="${path}"]');if(!input)throw Error('Missing setup control: ${path}');if(input.type==='checkbox')input.checked=${JSON.stringify(value)};else input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const reload = async hash => {
    await page('Page.navigate', { url: await evaluate('location.origin') + (hash || '') });
    await wait("typeof Studio!=='undefined' && document.querySelector('main').childElementCount>0 && !document.querySelector('.studio-skeleton')");
  };
  const fresh = async options => {
    await fixture({ reset:'fresh',...options });
    await evaluate("localStorage.removeItem('wui_token');localStorage.removeItem('wui_mode');TOKEN='';MODE='admin';");
    await reload(); await step(0);
  };
  const fits = async width => {
    await page('Emulation.setDeviceMetricsOverride', { width,height:1000,deviceScaleFactor:1,mobile:width<600 });
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))).then(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))))");
    assert(await evaluate(`document.documentElement.scrollWidth<=${width+1} && innerWidth<=${width+1} && visualViewport.width<=${width+1}`), 'Setup fits the '+width+'px viewport');
  };
  const footerLayout = async () => {
    const originalTheme = await evaluate('document.body.dataset.theme');
    for (const theme of ['light','dark']) {
      await evaluate(`if(document.body.dataset.theme!==${JSON.stringify(theme)})document.querySelector('#btn-theme').click()`);
      for (const width of [1440,375]) {
        await fits(width);
        const bounds = await evaluate(`(()=>{
          const nav=document.querySelector('#mobile-nav').getBoundingClientRect();
          return Array.from(document.querySelectorAll('.setup-footer button'),button=>{
            const r=button.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
            return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:!!hit&&button.contains(hit),clear:!nav.height||r.bottom<nav.top};
          });
        })()`);
        assert(bounds.length>0 && bounds.every(rect=>rect.visible&&rect.clear&&rect.left>=0&&rect.right<=width+1&&rect.top>=0&&rect.bottom<=1000), theme+' setup footer stays visible and touchable above navigation at '+width+'px: '+JSON.stringify(bounds));
      }
    }
    await evaluate(`if(document.body.dataset.theme!==${JSON.stringify(originalTheme)})document.querySelector('#btn-theme').click()`);
  };
  const capture = async name => {
    if (!process.env.STUDIO_SCREENSHOT_DIR) return;
    const directory = resolve(process.env.STUDIO_SCREENSHOT_DIR); await mkdir(directory, { recursive:true });
    for (const width of [1440,375]) {
      await fits(width);
      await evaluate("document.fonts.ready.then(()=>window.scrollTo({top:0,behavior:'instant'}))");
      const screenshot = await page('Page.captureScreenshot', { format:'png',captureBeyondViewport:false });
      await writeFile(join(directory, 'setup-'+name+'-'+width+'.png'), Buffer.from(screenshot.data, 'base64'));
    }
  };
  try {
    await navigate('overview');
    assert.equal(await evaluate('activeView'), 'overview', 'An initialized world does not force existing users into setup');
    await navigate('setup'); await step(0);
    await click('advanced'); await wait("activeView==='config'");
    assert.equal((await fixture()).counts.saves, 0, 'Opening advanced configuration does not save a partial wizard');

    await fresh();
    await click('skip'); await wait("activeView==='overview'");
    assert(await evaluate("api('GET','/api/setup').then(s=>s.dismissed && !s.completed && !s.shouldPrompt)"), 'Skipping persists dismissal independently of completion');
    assert.deepEqual((await fixture()).counts, { saves:1,applies:0,genesis:0,starts:0,reconnects:0,modelLists:0 }, 'Skip changes only wizard dismissal');
    await reload(); await wait("activeView==='overview' && !!document.querySelector('.studio-hero')");

    await fresh({ storedKeys:true,failModels:true });
    await fits(1440); await fits(375);
    await footerLayout();
    await capture('models');
    await click('next'); await step(0);
    assert(await evaluate("document.querySelector('[data-setup-path=\"bot.apiKey\"]').value==='' && document.querySelector('[data-setup-path=\"bot.apiKey\"]').placeholder.includes('已设置')"), 'Stored credentials are represented by an empty password field and a placeholder');
    await field('bot.baseURL', await evaluate("location.origin+'/fixture-model/v1'"));
    await field('bot.model', 'fixture-setup-model');
    await evaluate("window.__setupFocused=document.querySelector('[data-setup-path=\"bot.model\"]');window.__setupFocused.focus();window.__setupFocused.setSelectionRange(3,8);window.dispatchEvent(new CustomEvent('studio:debug',{detail:{kind:'bot.event'}}));window.dispatchEvent(new CustomEvent('studio:refresh'));refreshOverview(false);");
    assert(await evaluate("document.activeElement===window.__setupFocused && document.querySelector('[data-setup-path=\"bot.model\"]')===window.__setupFocused && window.__setupFocused.selectionStart===3 && window.__setupFocused.selectionEnd===8 && window.__setupFocused.value==='fixture-setup-model'"), 'Live events preserve the focused model input, caret selection and draft');
    await field('reuseBotModel', true);
    await click('models-bot');
    await wait("document.querySelector('main').textContent.includes('手动') && !document.querySelector('[data-setup-action=\"models-bot\"]').disabled");
    assert.equal((await fixture()).counts.modelLists, 1, 'Model-list failure is mocked locally');
    await fixture({ failModels:false }); await click('models-bot');
    await wait("document.querySelector('[aria-label=\"角色模型 · Bot可选模型\"]')?.options.length===3");
    await evaluate("var selection=document.querySelector('[aria-label=\"角色模型 · Bot可选模型\"]');selection.value='bot-model-b';selection.dispatchEvent(new Event('change',{bubbles:true}));");
    assert.equal(await evaluate("document.querySelector('[data-setup-path=\"bot.model\"]').value"), 'bot-model-b', 'Selecting a mock model updates the editable model field');
    await field('bot.model', 'fixture-setup-model');
    await click('next'); await step(1);
    const botDefinition = '林岚是一名喜欢植物的图书管理员。她认真观察身边的变化，再决定自己的行动。';
    const worldDefinition = '一座安静的小镇，角色住在图书馆旁的花园里。世界中的时间、距离与物理规则保持一致。';
    await field('botDef', botDefinition); await field('worldDef', worldDefinition);
    await click('back'); await step(0);
    assert(await evaluate("document.querySelector('[data-setup-path=\"bot.model\"]').value==='fixture-setup-model' && document.querySelector('[data-setup-path=\"reuseBotModel\"]').checked"), 'Going back preserves the model draft and reuse selection');
    await click('next'); await step(1);
    assert.equal(await evaluate("document.querySelector('[data-setup-path=\"botDef\"]').value"), botDefinition, 'Definition drafts survive step navigation');
    await fits(375);
    await click('next'); await step(2); await click('economy'); await fits(375);
    await click('next'); await step(3);
    await field('webui.token', 'fixture-setup-admin-token');
    await fits(375);
    await click('next'); await step(4); await fits(375);
    await footerLayout();
    await capture('review');
    assert(await evaluate("!document.querySelector('[data-setup-action=\"genesis\"]') && !document.querySelector('[data-setup-action=\"start\"]')"), 'Before saving, confirmation does not expose lifecycle controls');

    await fixture({ failSave:true });
    await click('save'); await wait(status('error'));
    assert.equal((await fixture()).counts.applies, 0, 'A failed save never applies configuration');
    await click('back'); await step(3);
    assert(await evaluate("document.querySelector('[data-setup-path=\"webui.token\"]').value==='fixture-setup-admin-token'"), 'Save failure retains the entered credential draft');
    await click('next'); await step(4);
    await fixture({ failSave:false,saveDelayMs:700,applyDelayMs:1400,reconnectFailures:2 });
    const beforeSave = await fixture();
    await evaluate("document.querySelector('[data-setup-action=\"save\"]').click();document.querySelector('[data-setup-action=\"save\"]')?.click()");
    await navigate('overview'); await navigate('setup');
    await wait(status('reconnecting'));
    assert(await evaluate("['genesis','start'].every(action=>{const button=document.querySelector('[data-setup-action=\"'+action+'\"]');return !button||button.disabled;})"), 'Lifecycle actions stay unavailable until the saved settings are applied');
    await wait(status('ready')); await step('done');
    const saved = await fixture();
    assert.equal(saved.counts.saves, beforeSave.counts.saves+1, 'Double click sends only one setup save');
    assert.equal(saved.counts.applies, 1); assert.equal(saved.counts.genesis, 0); assert.equal(saved.counts.starts, 0);
    assert(saved.counts.reconnects>0 && saved.instanceId!==beforeSave.instanceId, 'Reconnect recovers from a temporary outage and reaches the new server instance');
    assert(saved.sameModelKey && saved.tokenSet, 'Reusing the Bot connection copies its real stored credential to World on the server');
    assert(await evaluate("TOKEN===localStorage.getItem('wui_token') && TOKEN==='fixture-setup-admin-token' && !document.querySelector('#modal.show')"), 'Changing the access token preserves administrator access during reconnect');
    assert(await evaluate("api('GET','/api/setup').then(s=>s.completed && s.applied && !s.initialized && !s.running)"), 'Saving completes setup only; creation and startup remain separate');
    assert(await evaluate("api('GET','/api/config').then(c=>c.value.bot.apiKey==='******' && c.value.world.apiKey==='******' && c.value.webui.token==='******' && c.value.bot.model==='fixture-setup-model' && c.value.world.model===c.value.bot.model && c.value.autoStart===false)"), 'Saved configuration uses the selected model, masks every credential, and keeps automatic startup off');
    assert(await evaluate("!JSON.stringify(localStorage).includes('fixture-stored-bot-credential') && !JSON.stringify(localStorage).includes('fixture-stored-world-credential')"), 'Model credentials are never persisted in browser storage');
    await fits(375);
    await capture('ready');

    await evaluate("window.__setupConfirm=window.confirm;window.confirm=()=>true;");
    await fixture({ rejectGenesis:true });
    await click('genesis'); await wait(status('ready')+" && document.querySelector('.setup-feedback.is-error')");
    assert(!(await fixture()).initialized, 'A completed command receipt alone does not establish successful genesis');
    assert(await evaluate("!document.querySelector('[data-setup-action=\"start\"]') || document.querySelector('[data-setup-action=\"start\"]').disabled"), 'Startup is unavailable when creation did not actually initialize the world');
    await fixture({ rejectGenesis:false });
    await click('genesis'); await wait(status('ready'));
    assert((await fixture()).initialized && !(await fixture()).running, 'Explicit genesis initializes without starting autonomous activity');
    await fixture({ rejectStart:true });
    await click('start'); await wait(status('ready')+" && document.querySelector('.setup-feedback.is-error')");
    assert(!(await fixture()).running, 'A completed command receipt alone does not establish a running world');
    await fixture({ rejectStart:false });
    await click('start'); await wait(status('ready'));
    assert((await fixture()).running, 'The explicit startup control starts the isolated world');
    await click('finish'); await wait("activeView==='overview'");
    await reload(); await wait("activeView==='overview' && !!document.querySelector('.studio-hero')");

    await evaluate("MODE='visitor';VISITOR_TOKEN='fixture-visitor';VISITOR_GRANTS=['overview','config'];window.dispatchEvent(new CustomEvent('studio:auth'));Studio.navigate('setup');");
    await wait("activeView!=='setup'");
    assert(await evaluate("!document.querySelector('#nav a[href=\"#setup\"]') && !document.querySelector('[data-setup-action=\"save\"]')"), 'Visitors cannot discover or directly open the admin-only wizard');
    assert(await evaluate("fetch('/api/setup',{headers:{'x-visitor-token':'fixture-visitor'}}).then(r=>r.status===403)"), 'The preview enforces the setup visitor boundary as well');
    return 'five-step setup: first-run prompt, skip/advanced exits, masked-key reuse, retained drafts, explicit save/reconnect/genesis/start, actual-state confirmation, visitor protection and mobile layout';
  } finally {
    await fixture({ reset:'sample' });
    await evaluate("if(window.__setupConfirm)window.confirm=window.__setupConfirm;delete window.__setupConfirm;delete window.__setupFocused;MODE='admin';TOKEN='';VISITOR_TOKEN='';VISITOR_GRANTS=[];localStorage.removeItem('wui_token');localStorage.removeItem('wui_mode');");
    await reload(); await wait("activeView==='overview' && !!document.querySelector('.studio-hero')");
  }
}
