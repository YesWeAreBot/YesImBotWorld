/** Desktop → setup → real HTTP device routes. No replacement of the browser API or app list. */
export default async function smokePhoneSetup({ evaluate, wait, assert, navigate, page }) {
  assert(await evaluate("fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Setup test requires isolated preview');
  const saved = await evaluate("api('GET','/api/config').then(r=>r.value)");
  const q = JSON.stringify;
  const field = name => `.phone-app-settings [name="${name}"]`;
  const fill = async (selector, value) => {
    await wait(`!!document.querySelector(${q(selector)})`);
    await evaluate(`(function(){var input=document.querySelector(${q(selector)});if(input.type==='checkbox')input.checked=${q(value)};else input.value=${q(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  };
  const home = async () => { await navigate('overview'); await navigate('devices'); await evaluate("document.querySelector('.app-back')?.click()"); };
  const tile = id => `[data-phone-app="${id}"]`;
  const openSettings = async id => {
    await home(); await wait(`!!document.querySelector(${q(tile(id))}) && !document.querySelector(${q(tile(id))}).disabled`);
    await evaluate(`document.querySelector(${q(tile(id))}).click()`);
    await wait(`!!document.querySelector('.phone-app-unavailable') || !!document.querySelector(${q('[data-app-config="'+id+'"]')}) || !!document.querySelector('#modal.show .phone-app-settings')`);
    if (!await evaluate("!!document.querySelector('#modal.show .phone-app-settings')")) {
      await evaluate(`document.querySelector(${q('[data-app-config="'+id+'"]')}).click()`);
    }
    await wait("!!document.querySelector('#modal.show .phone-app-settings [data-app-settings-save]')");
  };
  const save = async () => {
    await wait("!!document.querySelector('[data-app-settings-save]') && !document.querySelector('[data-app-settings-save]').disabled");
    await evaluate("document.querySelector('[data-app-settings-save]').click()");
    await wait("!document.querySelector('#modal.show .phone-app-settings')");
  };
  const open = async id => {
    await home(); await wait(`!!document.querySelector(${q(tile(id))}) && !document.querySelector(${q(tile(id))}).disabled`);
    await evaluate(`document.querySelector(${q(tile(id))}).click()`);
    await wait(`!!document.querySelector('.app-${id} .phone-app-heading')`);
  };
  try {
    await page('Emulation.setDeviceMetricsOverride', { width: 375, height: 1050, deviceScaleFactor: 1, mobile: true });
    await evaluate("api('POST','/api/world/stop',{})");
    await home();
    for (const id of ['clock','camera','assistant']) assert(await evaluate(`!!document.querySelector(${q(tile(id))}) && !document.querySelector(${q(tile(id))}).disabled`), 'Stopped world still exposes '+id+' setup');
    assert(await evaluate("api('GET','/api/device/session').then(r=>r.apps.length===0 && r.tools.length===0)"), 'Setup entries do not create actor capabilities');
    await openSettings('camera');
    await fill(field('apps.camera.enabled'), true);
    await fill(field('apps.camera.baseURL'), 'https://images.preview.invalid/v1');
    await fill(field('apps.camera.model'), 'preview-image');
    await fill(field('apps.camera.apiKey'), 'fixture-only-image-key');
    // A different admin saves another section while this modal is open.
    await evaluate("api('GET','/api/config').then(r=>{r.value.bot.temperature=.43;return api('POST','/api/config',{config:r.value})})");
    assert(await evaluate("document.documentElement.scrollWidth<=375 && innerWidth<=375"), 'App setup fits the mobile viewport');
    await save();
    const config = await evaluate("api('GET','/api/config').then(r=>r.value)");
    assert.equal(config.apps.camera.model, 'preview-image');
    assert.equal(config.bot.temperature, .43, 'App-only save retains another admin’s latest configuration');
    assert.equal((await evaluate("api('GET','/api/preview/device/phone-calls').then(r=>r.calls)")).length, 0, 'Setup never takes a photo or executes an app tool');

    await openSettings('assistant');
    await fill(field('apps.assistant.enabled'), true);
    await fill(field('apps.assistant.name'), '星语');
    await fill(field('apps.assistant.mode'), 'independent');
    await fill(field('apps.assistant.baseURL'), 'https://assistant.preview.invalid/v1');
    await fill(field('apps.assistant.model'), 'preview-assistant');
    await fill(field('apps.assistant.apiKey'), 'fixture-only-assistant-key');
    await evaluate("document.querySelector('[data-app-models=\"apps.assistant\"]').click()");
    await wait("api('GET','/api/preview/llm/requests').then(r=>r.requests.some(x=>x.group==='apps.assistant'))");
    await save();
    await evaluate("api('POST','/api/world/start',{})");
    await open('assistant');
    assert(await evaluate("document.querySelector('.app-assistant .phone-app-heading h2').textContent==='星语'"), 'Custom app name reaches the actual phone panel');
    await fill('.phone-app-composer textarea', '这是一条从桌面入口发起的测试问题');
    await evaluate("window.__phoneSetupComposer=document.querySelector('.phone-app-composer textarea');__phoneSetupComposer.focus();document.querySelector('.phone-app-composer').requestSubmit()");
    await wait("document.querySelector('.assistant-reply')?.textContent.includes('这是一条从桌面入口发起的测试问题')");
    await wait("__phoneSetupComposer.value===''");
    assert(await evaluate("document.querySelector('.phone-app-composer textarea')===__phoneSetupComposer && document.activeElement===__phoneSetupComposer"), 'Accepted real HTTP app requests clear the submitted draft while retaining the same focused composer');
    await open('camera');
    await fill('.camera-composer textarea', '桌上的白杯');
    await evaluate("document.querySelector('.camera-composer').requestSubmit()");
    await wait("document.querySelector('.camera-photo-image')?.naturalWidth>0");
    await open('clock');
    await wait("document.querySelector('.clock-now')?.textContent.includes('星历')");
    await evaluate("Array.from(document.querySelectorAll('.clock-tab')).find(b=>b.textContent==='秒表').click()");
    assert(await evaluate("document.querySelector('.clock-stopwatch').offsetParent!==null && document.querySelector('.clock-create').hidden"), 'Clock tabs expose the selected task without scrolling through other forms');
    await evaluate("document.querySelector('.clock-stopwatch button').click()");
    await wait("api('GET','/api/preview/device/phone-calls').then(r=>r.calls.some(x=>x.name==='stopwatch' && x.args.action==='start'))");
    await evaluate("Array.from(document.querySelectorAll('.clock-tab')).find(b=>b.textContent==='倒计时').click()");
    await wait("!document.querySelector('.clock-create button[type=submit]').disabled");
    await fill('[aria-label="倒计时时长"]', '2');
    await evaluate("document.querySelector('.clock-create').requestSubmit()");
    await wait("api('GET','/api/preview/device/phone-calls').then(r=>r.calls.some(x=>x.name==='set_timer'))");
    const calls = await evaluate("api('GET','/api/preview/device/phone-calls').then(r=>r.calls)");
    assert.equal(calls.find(c => c.name === 'ask').args.question, '这是一条从桌面入口发起的测试问题');
    assert.equal(calls.find(c => c.name === 'take_photo').args.subject, '桌上的白杯');
    assert.equal(calls.find(c => c.name === 'set_timer').args.duration_seconds, 200, 'Clock form obeys the actual custom world minute');
    assert(await evaluate("document.documentElement.scrollWidth<=375 && innerWidth<=375"), 'Installed app controls fit the mobile viewport');
  } finally {
    await evaluate("hideModal();delete window.__phoneSetupComposer;api('POST','/api/world/start',{})");
    await evaluate("api('POST','/api/device/tool',{name:'close_app',args:{},mode:'stealth'})");
    await evaluate(`api('POST','/api/config',{config:${q(saved)}})`);
    await navigate('overview');
  }
  return 'phone app discovery/setup: stopped and disabled entries, app-specific forms, scoped model configuration, concurrent-save preservation and desktop-to-app HTTP operations';
}
