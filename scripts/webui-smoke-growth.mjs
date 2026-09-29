/** Growth remains independent of retired reward controls; use only the isolated preview. */
export default async function smokeGrowth({ evaluate, wait, assert, navigate, page }) {
  await page('Emulation.setDeviceMetricsOverride', { width: 375, height: 1000, deviceScaleFactor: 1, mobile: true });
  await navigate('growth');
  assert.ok(await evaluate("!document.querySelector('.regulation-panel') && typeof InnerRegulation==='undefined'"), 'Retired regulation code is not mounted or loaded');
  await wait("document.querySelector('.growth-page-status')?.textContent.includes('共')");
  assert.ok(await evaluate("document.querySelector('[data-growth-kind=long_term]').getAttribute('aria-pressed')==='true' && !document.querySelector('[data-growth-claim=claim_expired]') && !document.querySelector('[data-growth-claim=claim_state]')"), 'Default growth view shows current long-term understanding, not temporary states');
  await evaluate("document.querySelector('[data-growth-kind=state]').click();Array.from(document.querySelectorAll('.growth-lifecycle-filters button')).find(n=>n.textContent==='全部历史').click()");
  await wait("document.querySelector('[data-growth-claim=claim_expired]')");
  await evaluate("document.querySelector('[data-growth-claim=claim_expired]').click()");
  assert.ok(await evaluate("document.querySelector('.growth-time-correction').textContent.includes('适用时间已校正') && document.querySelector('.growth-time-correction').textContent.includes('证据时刻：T 4088.0 TU') && document.querySelector('.growth-time-correction').textContent.includes('校正后有效至：T 4248.0 TU') && document.querySelector('.growth-time-correction').textContent.includes('没有新增成长认识') && document.querySelector('.growth-record').textContent.includes('原始记录的有效期：世界时间 T 4668.0 TU') && document.querySelectorAll('.growth-record').length===1"), 'Corrected state timing is explained without rewriting the original record or adding a growth entry');
  await evaluate("var growthSearch=document.querySelector('[aria-label=搜索成长记录]');growthSearch.focus();growthSearch.value='阿青';growthSearch.dispatchEvent(new Event('input'));growthSearch.setSelectionRange(1,1)");
  await evaluate("window.__growthStatusOriginalFetch=Studio.fetchGrowthPage;Studio.fetchGrowthPage=()=>Promise.resolve({items:[],total:0,offset:0,limit:30,counts:{}});window.dispatchEvent(new CustomEvent('studio:refresh'))");
  // The audit panel also exists behind a disclosure while claims are present.
  // Wait for this refresh's empty ledger, not that earlier copy of the audit.
  await wait("document.querySelector('.growth-empty') && !document.querySelector('[data-growth-claim]') && !document.querySelector('.growth-review-disclosure') && document.querySelector('.growth-review-status')?.textContent.includes('历史待补审')");
  assert.ok(await evaluate("document.querySelector('.growth-review-status').textContent.includes('待审阅经历9') && document.querySelector('.growth-review-status').textContent.includes('历史待补审14') && document.querySelector('.growth-review-rejections').textContent.includes('提案 1：习惯提案缺少跨情境的自主完成证据') && document.activeElement===growthSearch && growthSearch.selectionStart===1"), 'An empty growth ledger exposes review progress and specific rejections without stealing focus');
  assert.ok(await evaluate("document.querySelector('.growth-review-status').textContent.includes('审阅未完成2') && document.querySelector('.growth-review-outcome').textContent.includes('最近一次审阅未完成') && document.querySelectorAll('.growth-review-failure').length===2 && document.querySelector('.growth-review-failure').textContent.includes('成长整理等待或生成超时')"), 'Unfinished generation and its specific reason remain visible alongside completed zero-change reviews');
  await evaluate("window.__growthCompletedOriginalApi=api;api=function(method,url){return window.__growthCompletedOriginalApi.apply(this,arguments).then(result=>url==='/api/bot/growth/status'?Object.assign({},result,{lastOutcome:'completed'}):result);};window.dispatchEvent(new CustomEvent('studio:refresh'))");
  await wait("document.querySelector('.growth-review-outcome')?.textContent.includes('最近一次审阅已完成，留下 0 项认识记录')");
  assert.ok(await evaluate("document.querySelectorAll('.growth-review-failure').length===2 && !document.querySelector('.growth-review-outcome').textContent.includes('最近一次审阅未完成')"), 'A later completed review is not mislabeled by historical failures');
  await evaluate("api=window.__growthCompletedOriginalApi;delete window.__growthCompletedOriginalApi");
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Empty-ledger diagnostics fit a touch viewport');
  await navigate('world');
  await evaluate("window.__growthStatusOriginalVisitor=isVisitor;isVisitor=()=>true;window.__growthStatusOriginalApi=api;window.__growthStatusRequests=0;api=function(method,url){if(url==='/api/bot/growth/status')window.__growthStatusRequests++;return window.__growthStatusOriginalApi.apply(this,arguments);}");
  await navigate('growth');
  await wait("document.querySelector('.growth-empty')");
  assert.ok(await evaluate("!document.querySelector('.growth-review-status') && !document.querySelector('.regulation-panel') && window.__growthStatusRequests===0"), 'Visitor rendering never fetches the administrator review audit');
  await evaluate("isVisitor=window.__growthStatusOriginalVisitor;api=window.__growthStatusOriginalApi;Studio.fetchGrowthPage=window.__growthStatusOriginalFetch;delete window.__growthStatusOriginalVisitor;delete window.__growthStatusOriginalApi;delete window.__growthStatusOriginalFetch;delete window.__growthStatusRequests");
  await navigate('config'); await evaluate("gotoCfg('bot')");
  assert.ok(await evaluate("!document.querySelector('[data-config-group=\"bot.regulation\"]') && !('regulation' in cfgCache.bot)"), 'No retired configuration or enable control remains');
  await navigate('live');
  // Archived calls retain their original source and raw bodies in the generic timeline.
  await evaluate("fetch('/api/preview/calls/step',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'retired_source_history',action:'begin',source:'Regulation',requestBody:JSON.stringify({model:'fixture',messages:[{role:'user',content:'历史评价请求'}]})})}).then(r=>r.json()).then(()=>fetch('/api/preview/calls/step',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'retired_source_history',action:'finish'})})).then(r=>r.json())");
  await evaluate("var source=document.querySelector('[aria-label=调用来源]');source.value='其他';source.dispatchEvent(new Event('change'))");
  await wait("document.querySelector('[data-call-id=retired_source_history]')");
  assert.ok(await evaluate("!document.querySelector('[data-live-source=Regulation]') && !document.querySelector('[aria-label=调用来源] option[value=Regulation]') && document.querySelector('[data-call-id=retired_source_history]').textContent.includes('Regulation')"), 'Historical source does not recreate a live mechanism block');
  await evaluate("document.querySelector('[data-call-id=retired_source_history]').click();Array.from(document.querySelectorAll('.live-raw-tab')).find(node=>node.textContent==='请求').click()");
  await wait("document.querySelector('.live-detail')?.textContent.includes('历史评价请求')");
  await evaluate("var source=document.querySelector('[aria-label=调用来源]');source.value='all';source.dispatchEvent(new Event('change'))");
  return 'growth timing and review audit, stable mobile input, removed reward controls, readable historical raw calls';
}
