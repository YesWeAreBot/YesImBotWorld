/** Actual shell pane in desktop/touch browsers; model responses stay in memory. */
export default async function smokePhoneShell({ evaluate, wait, assert, navigate, page }) {
  await evaluate(`window.__shellOriginalApi = api; window.__shellRequests = 0;
    api = function(method, url) {
      if (method === 'POST' && url === '/api/state/phone-shell/generate') {
        window.__shellRequests++;
        return new Promise(function(resolve, reject) { window.__shellResolve = resolve; window.__shellReject = reject; });
      }
      return window.__shellOriginalApi.apply(this, arguments);
    };`);
  try {
    for (const width of [1440, 375]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: width < 600 });
      await navigate('state');
      await evaluate(`Array.from(document.querySelectorAll('main .tabs button')).find(b => b.textContent.includes('浏览器外壳')).click();
        window.__shellPane = document.querySelector('[data-pane="shell"]');
        window.__shellSource = __shellPane.querySelector('textarea');
        window.__shellGenerate = Array.from(__shellPane.querySelectorAll('button')).find(b => b.textContent.includes('生成手机'));`);
      assert.ok(await evaluate('!!__shellGenerate && document.documentElement.scrollWidth <= innerWidth'), 'Shell controls fit desktop and touch widths');
      await evaluate(`__shellSource.focus(); __shellSource.value = '<html>草稿 {{screen}}</html>'; __shellSource.dispatchEvent(new Event('input'));`);
      assert.ok(await evaluate('__shellGenerate.disabled && document.activeElement === __shellSource'), 'Draft editing keeps focus and protects unsaved source');
      await evaluate(`Array.from(__shellPane.querySelectorAll('button')).find(b => b.textContent === '撤销修改').click(); __shellGenerate.click(); __shellGenerate.click();`);
      assert.ok(await evaluate('__shellGenerate.disabled && __shellSource.readOnly'), 'Pending generation locks duplicate actions and editing');
      await evaluate(`window.dispatchEvent(new CustomEvent('studio:refresh')); __shellReject(new Error('模型暂时不可用'));`);
      await wait("__shellPane.querySelector('[role=status]').textContent.includes('生成未完成')");
      assert.ok(await evaluate('__shellPane.querySelector("textarea") === __shellSource && __shellSource.value === "" && !__shellGenerate.disabled'), 'Refresh/failure preserves the same input node and old source');
      await evaluate(`__shellGenerate.click(); __shellResolve({ok:true,content:'<html><body>新外壳 {{width}}×{{height}}<img src="{{screen}}"></body></html>',phone:{width:720,height:1440}});`);
      await wait("__shellSource.value.includes('新外壳')");
      assert.ok(await evaluate(`__shellGenerate.textContent.includes('重新设计') && __shellPane.querySelector('iframe').srcdoc.includes('720×1440') && __shellPane.querySelector('iframe').getAttribute('sandbox') === ''`), 'Generated design updates source and isolated preview without recreating the pane');
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Completed shell preview stays within viewport');
    }
    assert.equal(await evaluate('__shellRequests'), 4, 'Each deliberate click generates exactly once');
  } finally {
    await evaluate('api = __shellOriginalApi; delete window.__shellOriginalApi; delete window.__shellResolve; delete window.__shellReject;');
  }
  return 'phone/browser shell: desktop and touch layout, draft focus, pending protection, failure and successful preview';
}
