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
  const base = await launch(process.execPath, ['scripts/preview-webui.mjs'], /preview: (http:\/\/127\.0\.0\.1:\d+)/, { env: { ...process.env, STUDIO_PREVIEW_PORT: '0' } });
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
  const routes = ['overview', 'world', 'growth', 'devices', 'player', 'live', 'debug', 'usage', 'state', 'crossing', 'config', 'prompts', 'gallery', 'media', 'data', 'visitors'];
  for (const width of [1440, 768, 375]) {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 600 });
    for (const route of routes) {
      await navigate(route);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `${route}: horizontal overflow at ${width}px`);
    }
    console.log(`PASS all ${routes.length} pages at ${width}px`);
  }
  await navigate('world');
  await evaluate(`document.querySelector('[data-entity-id="bot"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  assert.equal(await evaluate("document.querySelector('.world-inspector h2')?.textContent"), '小澈');
  await evaluate(`document.querySelector('.world-relation').click()`);
  assert.equal(await evaluate("document.querySelector('.world-inspector h2')?.textContent"), '窗边工作室');
  await evaluate(`var s=document.querySelector('[aria-label="搜索实体"]');s.value='温热';s.dispatchEvent(new Event('input'));`);
  assert.equal(await evaluate("document.querySelectorAll('.world-node').length"), 1);
  // A debug-to-world event can arrive before its first fetch finishes.
  await evaluate(`Studio.navigate('world');window.dispatchEvent(new CustomEvent('studio:focus-world-event',{detail:{actorId:'bot',eventId:'event_12'}}));`);
  await wait("document.querySelector('.world-event-detail pre')?.textContent.includes('event_12')");
  await navigate('growth');
  await evaluate("document.querySelector('.growth-evidence-node').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  assert.ok(await evaluate("document.querySelector('.growth-evidence-detail')?.textContent.includes('observed_1')"));
  console.log('PASS graph navigation, early event focus and growth evidence');
  await evaluate("promptAuth();document.querySelector('#modal-x').click()");
  assert.equal(await evaluate('authPromise'), null, 'Closing login must settle the pending request');
  await evaluate("document.querySelector('#studio-command').click()");
  await evaluate("var s=document.querySelector('.studio-search-input');s.value='角色与成长';s.dispatchEvent(new Event('input'));document.querySelector('.studio-search-result').click()");
  assert.equal(await evaluate('activeView'), 'growth');
  await evaluate("document.querySelector('#btn-theme').click()");
  assert.equal(await evaluate('document.body.dataset.theme'), 'dark');
  await evaluate("document.querySelector('#btn-theme').click()");
  console.log('PASS login cancellation, command search and theme switch');
  console.log('PASS', await smokeLive(helpers));
  console.log('PASS', await smokeCharts(helpers));
  console.log('PASS', await smokeDevices(helpers));
  console.log('PASS', await smokeJourney(helpers));
  assert.deepEqual(errors, [], 'Browser exceptions or unexpected external requests');
  if (process.env.STUDIO_SCREENSHOT_DIR) {
    const output = resolve(process.env.STUDIO_SCREENSHOT_DIR); await mkdir(output, { recursive: true });
    for (const width of [1440, 375]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 600 });
      for (const route of ['overview', 'world', 'devices', 'player', 'debug']) {
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
