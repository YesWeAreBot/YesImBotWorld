/** Server-filtered paging and response races; isolated preview data only. */
export default async function smokeGrowthPagination({ evaluate, wait, assert, navigate, page }) {
  const run = (fn, arg) => evaluate(`(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`);
  assert(await run(async () => (await (await fetch('/api/health')).json()).preview), 'Growth paging requires the isolated preview');
  await page('Emulation.setDeviceMetricsOverride', { width: 375, height: 1000, deviceScaleFactor: 1, mobile: true });
  const filter = async (selector, label) => { await run(({selector,label}) => [...document.querySelectorAll(selector+' button')].find(node=>node.textContent===label).click(), {selector,label}); await wait("document.querySelector('.world-controls')?.getAttribute('aria-busy')==='false'"); };
  const search = async keyword => { await run(keyword => { const input=document.querySelector('[aria-label="搜索成长记录"]');input.value=keyword;input.dispatchEvent(new Event('input')); }, keyword); await wait("document.querySelector('.growth-page-status')?.textContent!=='正在查找记录…' && document.querySelector('.world-controls')?.getAttribute('aria-busy')==='false'"); };
  await run(async () => {
    const original=(await api('GET','/api/bot/growth?kind=all&lifecycle=all&limit=100')).growth;
    window.__growthPaging={original,fetch:Studio.fetchGrowthPage};
    const make=(id,kind,time,extra={})=>({claimId:id,kind,subject:id,statement:'记录 '+id,status:'tentative',active:true,records:[{id:'record-'+id,claimId:id,kind,subject:id,relation:'support',statement:'记录 '+id,recordedAt:time,evidenceIds:[]}],evidence:[],...extra});
    const rows=Array.from({length:63},(_,i)=>make('pref_'+i,'preference',100+i));
    rows.push(make('early_pref','preference',1,{subject:'早年偏好',statement:'早年偏好：喜欢安静读书',subjectId:'person:original-reader',insight:{dimension:'阅读时的环境',significance:'以后安排独处时间时，会更倾向于选择安静的场所，再根据当日精力安排阅读时长。',anchors:[{eventId:'reading-original',quote:'我喜欢这里安静的阅读环境。'}]},evidence:[{eventId:'reading-original',actorId:'fixture',source:'world',observedAt:1,rootEventIds:['reading-root'],text:'你在窗边读完这一章，说：我喜欢这里安静的阅读环境。'}]}));
    rows.push(make('isolated_pref','preference',2,{needsReview:true,isolationReason:'旧偏好缺少原频道证据，等待复核。'}));
    rows.push(...Array.from({length:70},(_,i)=>make('temporary_'+i,'state',1000+i,{active:false,inactiveReason:'expired'})));
    __growthPaging.rows=rows;await api('POST','/api/preview/growth',{rows});
  });
  try {
    await navigate('overview');
    await wait("Array.from(document.querySelectorAll('.studio-kpi')).some(node=>node.querySelector('.label')?.textContent==='长期认识'&&node.querySelector('.number')?.textContent==='64')");
    assert(await run(()=>{const card=[...document.querySelectorAll('.studio-kpi')].find(node=>node.querySelector('.label')?.textContent==='长期认识');return card.querySelector('.note').textContent.includes('偏好 64')&&!card.textContent.includes('临时状态')&&document.documentElement.scrollWidth<=375;}),'Overview uses the complete active long-term total and category counts, never the fifty latest historical states');
    await navigate('world'); await navigate('growth');
    await wait("document.querySelectorAll('.growth-claim').length===30 && document.querySelector('.growth-page-status').textContent.includes('共 64 项')");
    assert(await run(()=>document.querySelector('[data-growth-kind=long_term]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-growth-kind=preference]').dataset.count==='64'&&!document.querySelector('.growth-claims').textContent.includes('temporary_')),'Default active long-term view excludes expired and quarantined states and reports full counts');
    await filter('.growth-pagination','下一页');
    assert(await run(()=>document.querySelector('.growth-page-status').textContent.includes('第 2 / 3 页')),'Pagination uses the whole filtered result, not a pre-truncated 50-record list');
    await filter('.growth-kind-filters','全部类型'); await filter('.growth-lifecycle-filters','全部历史');
    await search('早年偏好');
    await wait("!!document.querySelector('[data-growth-claim=early_pref]') && document.querySelectorAll('.growth-claim').length===1");
    assert(await run(()=>document.querySelector('.growth-page-status').textContent.includes('共 1 项')),'Keyword filtering happens before pagination even after more than fifty newer states');
    assert(await run(()=>document.querySelector('.growth-insight-dimension').textContent==='阅读时的环境'&&document.querySelector('.growth-insight-significance').textContent.includes('选择安静的场所')&&!document.querySelector('.growth-insight .readable-raw')),'Insight dimension and significance are readable prose rather than JSON');
    await run(()=>document.querySelector('.growth-insight-anchor').click());
    assert(await run(()=>document.querySelector('.growth-evidence-detail').textContent.includes('你在窗边读完这一章')&&document.querySelector('.growth-evidence-detail').textContent.includes('reading-original')),'A support excerpt selects the matching complete original experience');
    await run(async()=>{const input=document.querySelector('[aria-label="搜索成长记录"]');document.querySelector('.growth-identity summary').click();input.focus();input.setSelectionRange(1,2);window.__growthPaging.input=input;__growthPaging.rows.find(row=>row.claimId==='early_pref').statement+=' · 已更新';await api('POST','/api/preview/growth',{rows:__growthPaging.rows});window.dispatchEvent(new CustomEvent('studio:refresh'));});
    await wait("document.querySelector('.world-controls').getAttribute('aria-busy')==='false'");
    assert(await run(()=>document.activeElement===__growthPaging.input&&__growthPaging.input.selectionStart===1&&document.querySelector('.growth-identity').open),'Polling retains the chosen claim, expanded identity and exact search focus');
    await search(''); await wait("document.querySelector('.growth-page-status').textContent.includes('共 135 项')");
    await filter('.growth-lifecycle-filters','未在沿用'); await filter('.growth-kind-filters','偏好');
    await wait("!!document.querySelector('[data-growth-claim=isolated_pref]')");
    assert(await run(()=>document.querySelector('.growth-claim-isolation').textContent.includes('旧偏好缺少原频道证据')),'Older quarantined claims display their own isolation reason outside recent audit batches');
    await filter('.growth-kind-filters','临时状态'); await filter('.growth-lifecycle-filters','全部历史');
    await wait("document.querySelector('.growth-page-status').textContent.includes('共 70 项')");
    await filter('.growth-pagination','下一页'); await filter('.growth-pagination','下一页');
    assert(await run(()=>document.querySelectorAll('.growth-claim').length===10&&document.querySelector('.growth-page-status').textContent.includes('第 3 / 3 页')),'Historical temporary states remain separately searchable and paginated');
    await filter('.growth-kind-filters','全部类型');
    await run(()=>{Studio.fetchGrowthPage=function(query){if(query.keyword==='迟到查询')return new Promise(resolve=>{__growthPaging.release=()=>resolve({items:[{claimId:'stale',kind:'preference',subject:'迟到错误覆盖',statement:'不应出现',records:[],evidence:[]}],total:1,offset:0,limit:30,counts:{preference:1}});});return __growthPaging.fetch(query);};const input=document.querySelector('[aria-label="搜索成长记录"]');input.value='迟到查询';input.dispatchEvent(new Event('input'));});
    await wait('!!window.__growthPaging.release');
    await search('早年偏好'); await wait("!!document.querySelector('[data-growth-claim=early_pref]')");
    await run(()=>{__growthPaging.release();});
    assert(await run(()=>!document.querySelector('[data-growth-claim=stale]')&&document.querySelector('[data-growth-claim=early_pref]')),'A delayed obsolete query never overwrites the newer search response');
    assert(await run(()=>document.documentElement.scrollWidth<=375&&innerWidth<=375),'Counts, filters, paging and long record details fit a mobile viewport');
  } finally {
    await run(async()=>{Studio.fetchGrowthPage=__growthPaging.fetch;await api('POST','/api/preview/growth',{rows:__growthPaging.original});delete window.__growthPaging;});
    await navigate('world');
  }
  return 'growth: server-filtered 135-record history, default long-term scope, counts, paging, old isolation reasons, request races, stable mobile focus';
}
