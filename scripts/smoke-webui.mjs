/** Browser regression against a fresh, isolated in-memory world. Node 22 + Chromium. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import smokeJourney from './webui-smoke-journey.mjs';
import smokeDevices from './webui-smoke-devices.mjs';
import smokeLive from './webui-smoke-live.mjs';
import smokeCharts from './webui-smoke-charts.mjs';
import smokeCockpit from './webui-smoke-cockpit.mjs';
import smokeCommands from './webui-smoke-commands.mjs';
import smokeAttachments from './webui-smoke-attachments.mjs';
import smokeLayout from './webui-smoke-layout.mjs';
import smokeNotes from './webui-smoke-notes.mjs';
import smokeNarrative from './webui-smoke-narrative.mjs';
import smokeRegulation from './webui-smoke-regulation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let socket, profile, closeBrowser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(command, args, pattern, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Startup timed out: ' + output.slice(-2000))), 25000);
    const collect = chunk => {
      output += chunk;
      const match = output.match(pattern);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Process exited (${code}): ${output.slice(-2000)}`)); });
  });
}

try {
  const base = await launch(process.execPath, ['scripts/preview-webui.mjs'], /preview: (http:\/\/127\.0\.0\.1:\d+)/, { env: { ...process.env, STUDIO_PREVIEW_PORT: '0', STUDIO_PREVIEW_LEGACY: '1' } });
  assert.equal((await (await fetch(base + '/api/health')).json()).preview, true);
  const chrome = process.env.CHROMIUM_PATH || (existsSync('/snap/bin/chromium') ? '/snap/bin/chromium' : 'chromium');
  // Snap Chromium can only use its own writable directory; other installations use /tmp.
  const profileRoot = chrome.startsWith('/snap/') ? join(homedir(), 'snap/chromium/common') : tmpdir();
  await mkdir(profileRoot, { recursive: true });
  profile = await mkdtemp(join(profileRoot, 'world-studio-smoke-'));
  const endpoint = await launch(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], /DevTools listening on (ws:\/\/\S+)/);
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let next = 0;
  const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Fetch.requestPaused') {
      const { request, requestId } = message.params;
      const sameOrigin = new URL(request.url).origin === base;
      if (!sameOrigin) errors.push('Unexpected external request: ' + request.url);
      call(sameOrigin ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(!sameOrigin ? { errorReason: 'BlockedByClient' } : {}) }, message.sessionId).catch(e => errors.push(e.message));
    }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  closeBrowser = () => call('Browser.close');
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => call(method, params, sessionId);
  await page('Page.enable'); await page('Runtime.enable'); await page('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] });
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('Condition timed out: ' + expression + '\n' + await evaluate('document.querySelector("main")?.innerText.slice(0,1000)'));
  };
  const navigate = async route => {
    if (route === 'debug') route = 'live';
    await evaluate(`Studio.navigate(${JSON.stringify(route)})`);
    await wait(`activeView === ${JSON.stringify(route)} && document.querySelector('main').childElementCount > 0 && !document.querySelector('.studio-skeleton') && !Array.from(document.querySelectorAll('main .empty')).some(e=>e.textContent.includes('加载中'))`);
    await delay(100);
    assert.equal(await evaluate("!!document.querySelector('.studio-error')"), false, route + ': error view');
  };
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: base });
  await wait("typeof Studio !== 'undefined' && !!document.querySelector('.studio-hero')");
  assert.equal(await evaluate("document.querySelector('.studio-hero h2').textContent"), '你好，欢迎回来。');
  await wait("document.querySelector('.studio-avatar img')?.naturalWidth > 0");
  assert.ok(await evaluate("document.querySelector('.studio-avatar img').alt.includes('样本平台账号')"));
  const helpers = { evaluate, wait, assert, navigate, page };
  const regulationOnly = process.env.STUDIO_SMOKE_ONLY_REGULATION === '1';
  if (regulationOnly) console.log('PASS', await smokeRegulation(helpers));
  if (!regulationOnly) {
  const routes = ['overview', 'world', 'growth', 'devices', 'player', 'live', 'debug', 'usage', 'state', 'crossing', 'config', 'prompts', 'gallery', 'media', 'data', 'visitors'];
  for (const width of [1440, 768, 375]) {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 600 });
    for (const route of routes) {
      await navigate(route);
      const viewport = await evaluate('({content:document.documentElement.scrollWidth,layout:innerWidth,visual:visualViewport.width,scale:visualViewport.scale})');
      // Mobile Chromium may widen innerWidth and zoom out to accommodate overflow.
      // Compare with the emulated device, not with that already-expanded viewport.
      assert.ok(viewport.content <= width + 1 && viewport.layout <= width + 1 && viewport.visual <= width + 1 && Math.abs(viewport.scale - 1) < .01, `${route}: viewport overflow at ${width}px: ${JSON.stringify(viewport)}`);
    }
    console.log(`PASS all ${routes.length} pages at ${width}px`);
  }
  await navigate('world');
  assert.equal(await evaluate("!!document.querySelector('.world-controls,.world-canvas,.world-inspector')"), false, 'Retired entity controls are removed, not hidden');
  await evaluate(`document.querySelector('#studio-command').click();var s=document.querySelector('.studio-search-input');s.value='小澈';s.dispatchEvent(new Event('input'));document.querySelector('.studio-search-result').click();`);
  await wait(`document.activeElement?.dataset.worldActor==='bot'`);
  assert.equal(await evaluate("document.querySelector('[data-world-actor=bot] h3')?.textContent"), '小澈');
  // A debug-to-world event can arrive before its first fetch finishes.
  await evaluate(`Studio.navigate('world');window.dispatchEvent(new CustomEvent('studio:focus-world-event',{detail:{actorId:'bot',eventId:'narrative_start'}}));`);
  await wait("document.querySelector('.world-event-detail')?.textContent.includes('narrative_start')");
  await navigate('growth');
  await evaluate("document.querySelector('.growth-evidence-node').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  assert.ok(await evaluate("document.querySelector('.growth-evidence-detail')?.textContent.includes('observed_1')"));
  console.log('PASS actor navigation, early event focus and growth evidence');
  const growthFilter = async (group, label) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(group + ' button')})).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
  await growthFilter('.growth-kind-filters', '习惯');
  assert.ok(await evaluate("document.querySelector('.growth-situation').textContent.includes('天气适合出门') && document.querySelector('.growth-cues').textContent.includes('晚饭后')"));
  assert.ok(await evaluate("document.querySelector('.growth-detail').textContent.includes('自动整理') && document.querySelector('.growth-detail').textContent.includes('修订原有判断')"));
  await growthFilter('.growth-lifecycle-filters', '已结束');
  assert.equal(await evaluate("document.querySelectorAll('.growth-claim').length"), 1);
  assert.ok(await evaluate("document.querySelector('.growth-detail').textContent.includes('停止沿用这条认识')"));
  await growthFilter('.growth-kind-filters', '临时状态');
  assert.ok(await evaluate("document.querySelector('.growth-lifecycle').textContent.includes('已到期') && document.querySelector('.growth-lifecycle').textContent.includes('T 4248.0 TU')"), 'Expiry is world TU, never an epoch date');
  await growthFilter('.growth-lifecycle-filters', '当前有效');
  assert.ok(await evaluate("document.querySelector('.growth-detail').textContent.includes('不会直接归纳成性格')"));
  await growthFilter('.growth-kind-filters', '性格倾向');
  assert.ok(await evaluate("document.querySelector('.growth-topline').textContent.includes('存在反证') && document.querySelector('.growth-lifecycle').textContent.includes('当前有效')"), 'Contested and active describe separate dimensions');
  assert.equal(await evaluate("document.querySelector('.growth-identity').open"), false);
  await evaluate("document.querySelector('.growth-identity summary').click()");
  assert.ok(await evaluate("document.querySelector('.growth-identity').textContent.includes('person:preview:friend-account')"));
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Long identity stays inside mobile width');
  await evaluate("var growthSearch=document.querySelector('[aria-label=搜索成长记录]');growthSearch.focus();growthSearch.value='阿青';growthSearch.dispatchEvent(new Event('input'));growthSearch.setSelectionRange(1,1);var originalGrowthFetch=Studio.fetchGrowth;Studio.fetchGrowth=()=>originalGrowthFetch().then(rows=>rows.map(row=>row.claimId==='claim_trait'?Object.assign({},row,{statement:row.statement+'（刷新样本）'}):row));window.dispatchEvent(new CustomEvent('studio:debug',{detail:{kind:'bot.event'}}));");
  await wait("document.querySelector('.growth-detail h2').textContent.includes('刷新样本')");
  assert.ok(await evaluate("document.activeElement===growthSearch && growthSearch.selectionStart===1 && growthSearch.value==='阿青' && document.querySelector('.growth-identity').open"), 'Live updates retain input focus, caret and expanded identity');
  await evaluate("Studio.fetchGrowth=originalGrowthFetch");
  await growthFilter('.growth-kind-filters', '全部类型');
  await growthFilter('.growth-lifecycle-filters', '全部历史');
  await evaluate("growthSearch.value='';growthSearch.dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('.growth-claim').length"), 8, 'All old and new kinds retain their history');
  console.log('PASS growth scopes, habits, traits, expiry, retirement, live input focus and mobile layout');
  await navigate('config');
  await evaluate("gotoCfg('bot')");
  await wait("document.querySelector('[data-config-group=\"bot.growth\"]')");
  assert.equal(await evaluate("document.querySelectorAll('[data-config-group=\"bot.growth\"] input').length"), 6);
  assert.ok(await evaluate("!document.querySelector('[data-config-group=\"bot.growth\"]').closest('details') && Array.from(document.querySelectorAll('[data-config-group=\"bot.growth\"] input')).every(input=>input.getClientRects().length && input.getAttribute('aria-label'))"), 'Growth configuration is directly discoverable and accessible');
  await evaluate("window.__originalGrowthConfig=JSON.parse(JSON.stringify(cfgCache.bot.growth));document.querySelector('[data-config-path=\"bot.growth.enabled\"]').click();[['minEpisodes',5],['reviewIntervalMs',180000],['reviewTimeoutMs',60000],['maxInputChars',26000],['recallCount',2]].forEach(([key,value])=>{const input=document.querySelector('[data-config-path=\"bot.growth.'+key+'\"]');input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}))});");
  assert.ok(await evaluate('cfgDirty && cfgCache.bot.growth.recallCount===2 && cfgCache.bot.growth.reviewIntervalMs===180000'));
  await evaluate("document.querySelector('.cfg-savebar .primary').click()");
  await wait('!cfgDirty');
  assert.ok(await evaluate("api('GET','/api/config').then(result=>result.value.bot.growth.recallCount===2 && result.value.bot.growth.enabled===!window.__originalGrowthConfig.enabled)"), 'All growth controls use the existing save/apply path');
  await evaluate("cfgCache.bot.growth=window.__originalGrowthConfig;markCfgDirty();saveConfig();delete window.__originalGrowthConfig");
  await wait('!cfgDirty');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Growth settings stay inside mobile width');
  console.log('PASS visible growth settings, six editable fields and existing save/apply semantics');
  await evaluate("promptAuth();document.querySelector('#modal-x').click()");
  assert.equal(await evaluate('authPromise'), null, 'Closing login must settle the pending request');
  await evaluate("document.querySelector('#studio-command').click()");
  await evaluate("var s=document.querySelector('.studio-search-input');s.value='角色与成长';s.dispatchEvent(new Event('input'));document.querySelector('.studio-search-result').click()");
  assert.equal(await evaluate('activeView'), 'growth');
  await evaluate("document.querySelector('#btn-theme').click()");
  assert.equal(await evaluate('document.body.dataset.theme'), 'dark');
  await evaluate("document.querySelector('#btn-theme').click()");
  console.log('PASS login cancellation, command search and theme switch');
  console.log('PASS', await smokeLayout(helpers));
  console.log('PASS', await smokeLive(helpers));
  console.log('PASS', await smokeAttachments(helpers));
  console.log('PASS', await smokeCharts(helpers));
  console.log('PASS', await smokeNotes(helpers));
  console.log('PASS', await smokeDevices(helpers));
  console.log('PASS', await smokeJourney(helpers));
  console.log('PASS', await smokeCockpit(helpers));
  console.log('PASS', await smokeCommands(helpers));
  console.log('PASS', await smokeNarrative(helpers));
  console.log('PASS', await smokeRegulation(helpers));
  }
  assert.deepEqual(errors, [], 'Browser exceptions or unexpected external requests');
  if (process.env.STUDIO_SCREENSHOT_DIR) {
    const output = resolve(process.env.STUDIO_SCREENSHOT_DIR); await mkdir(output, { recursive: true });
    for (const width of [1440, 375]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 600 });
      for (const route of ['overview', 'world', 'growth', 'devices', 'player', 'debug']) {
        await navigate(route);
        const screenshot = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(join(output, `${route}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
  }
  console.log('PASS isolated browser smoke; no production world, LLM, chat, Docker or VNC used.');
  await call('Browser.close').catch(() => {});
} finally {
  if (socket?.readyState === WebSocket.OPEN) await closeBrowser?.().catch(() => {});
  socket?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    try { child.kill('SIGTERM'); } catch { /* Snap may own the launcher; CDP closes the browser above. */ }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    if (child.exitCode === null) try { child.kill('SIGKILL'); } catch { /* Preserve the original test failure. */ }
  }
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
