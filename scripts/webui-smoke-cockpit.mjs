/** Resident control is exercised only against the isolated preview API. */
export default async function smokeCockpit({ evaluate, wait, assert, navigate, page }) {
  const run = (fn, arg) => evaluate(`(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`);
  assert(await run(async () => location.port !== '18111' && ['127.0.0.1','localhost'].includes(location.hostname) && (await (await fetch('/api/health')).json()).preview), 'Cockpit test requires an isolated fixture');
  const click = text => run(text => {
    const button = [...document.querySelectorAll('main button')].find(n=>n.textContent.trim() === text);
    if (!button || button.disabled) throw Error('Unavailable: '+text);
    button.click();
  }, text);
  await run(() => { window.__cockpitSmoke = { original:api, calls:[] }; api = function(method,path,body) { window.__cockpitSmoke.calls.push({method,path,body}); return window.__cockpitSmoke.original(method,path,body); }; });
  try {
    for (const mode of ['puppet','avatar']) {
      await page('Emulation.setDeviceMetricsOverride', { width: mode === 'puppet' ? 375 : 1440, height: 1050, deviceScaleFactor:1, mobile:mode === 'puppet' });
      await navigate('player');
      await click('接管常驻角色');
      await wait(`document.querySelector('[data-takeover-mode="${mode}"]') && !Array.from(document.querySelectorAll('main button')).find(b=>b.textContent==='接管 小澈')?.disabled`);
      await run(mode=>document.querySelector('[data-takeover-mode="'+mode+'"]').click(), mode);
      await click('接管 小澈');
      await wait(`!!document.querySelector('.journey-connection.connected') && !!document.querySelector('[data-cockpit-tool="observe"]')`);
      assert(await run(mode=>window.__cockpitSmoke.calls.filter(c=>c.path==='/api/player/arrive').at(-1).body.mode === mode, mode), 'Selected consciousness mode reaches the server');
      assert.equal(await run(()=>!!document.querySelector('[data-cockpit-tool="recall_growth"]')), mode === 'avatar', 'Puppet cannot replace the character’s thoughts');
      assert(await run(()=>document.documentElement.scrollWidth <= innerWidth), 'Cockpit fits the viewport');
      assert(await run(()=>!document.querySelector('.cockpit-schema').open), 'Advanced JSON starts collapsed');
      await click('重新观察');
      await wait(`document.querySelectorAll('.journey-entity').length > 1 && !document.querySelector('.journey-pending')`);
      assert(await run(()=>window.__cockpitSmoke.calls.some(c=>c.path==='/api/player/tool' && c.body.name==='observe' && c.body.token==='preview-player')), 'Resident observation uses the actual manual Bot tool path with session authorization');
      // The schema form must pass typed values and convert world seconds to TU.
      await run(()=>document.querySelector('[data-cockpit-tool="act"]').click());
      await run(()=>{
        const field=(key,value)=>{const e=document.querySelector('[data-cockpit-field="'+key+'"]');e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));};
        field('act:description','抬起手，看看窗外'); field('duration','6');
        document.querySelector('.cockpit-form').requestSubmit();
      });
      await wait(`!!document.querySelector('.cockpit-pending button')`);
      assert(await run(()=>{const c=window.__cockpitSmoke.calls.filter(c=>c.path==='/api/player/tool').at(-1);return c.body.name==='act'&&c.body.arguments.description==='抬起手，看看窗外'&&c.body.duration===3&&c.body.token==='preview-player';}), 'Typed cockpit action and TU conversion');
      await run(()=>document.querySelector('.cockpit-pending button').click());
      await wait(`!document.querySelector('.journey-pending') && !document.querySelector('.cockpit-pending')`);
      assert(await run(()=>window.__cockpitSmoke.calls.some(c=>c.path==='/api/player/tool/cancel' && c.body.callId.startsWith('fixture_call_') && c.body.token==='preview-player')), 'Cancellation addresses the real call id and session');
      await click('操作手机与电脑 ↗');
      await wait(`document.querySelector('.device-control')?.textContent.includes('返回角色驾驶舱')`);
      assert(await run(mode=>document.querySelector('.device-control').textContent.includes(mode==='puppet'?'Bot 保留意识':'你正在使用自己的设备'),mode), 'Devices inherit the same resident mode');
      assert(await run(()=>!document.querySelector('[data-device-control]')&&!document.querySelector('.device-operation-modes')), 'Device page cannot override resident ownership');
      assert(await run(async()=>(await (await fetch('/api/preview/player/connection')).json()).connected===1), 'Switching to devices keeps the crossing SSE alive');
      await click('返回角色驾驶舱');
      await wait(`!!document.querySelector('.cockpit') && !!document.querySelector('[data-cockpit-tool="open_app"]')`);
      await run(()=>document.querySelector('[data-cockpit-tool="open_app"]').click());
      await run(()=>{const e=document.querySelector('[data-cockpit-field="open_app:name"]');e.value='weather';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.cockpit-form').requestSubmit();});
      await wait(`!!document.querySelector('[data-cockpit-tool="query_weather"]') && !document.querySelector('.journey-pending')`);
      assert(await run(()=>document.documentElement.scrollWidth <= innerWidth), 'Expanded application capabilities fit the viewport');
      if (mode === 'avatar') {
        await run(()=>document.querySelector('[data-cockpit-tool="wait"]').click());
        assert(await run(()=>!document.querySelector('[data-cockpit-field="duration"]')), 'Wait uses one duration source');
        await run(()=>{const n=document.querySelector('[data-cockpit-field="wait:n"]');n.value='60';n.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.cockpit-form').requestSubmit();});
        await wait(`!document.querySelector('.journey-pending')`);
        assert(await run(()=>{const b=window.__cockpitSmoke.calls.filter(c=>c.path==='/api/player/tool'&&c.body.name==='wait').at(-1).body;return b.arguments.n===60&&b.duration===0;}), 'Prior action estimates cannot override wait n');
      }
      await run(()=>document.querySelector('[data-cockpit-tool="observe_device"]').click());
      await run(()=>{const d=document.querySelector('[data-cockpit-field="observe_device:device"]');d.value=JSON.stringify('phone');d.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.cockpit-form').requestSubmit();});
      await wait(`!!document.querySelector('.cockpit-result-media img')`);
      await run(()=>document.querySelector('.cockpit-result-media img').scrollIntoView({behavior:'instant',block:'center'}));
      await wait(`document.querySelector('.cockpit-result-media img').naturalWidth > 0`);
      await click('归还控制并离场');
      await wait(`!!document.querySelector('.journey-identity')`);
      assert(await run(async()=>{const d=await api('GET','/api/device/session');return d.control.residentMode===null&&!d.control.paused;}), 'Leave returns device and resident autonomy together');
    }
    return ['puppet/avatar mode selection, authorized observation and schema-driven tools','real pending call cancellation, TU conversion and dynamic app capabilities','resident-aware devices and mobile cockpit layout'];
  } finally { await run(()=>{api=window.__cockpitSmoke.original;delete window.__cockpitSmoke;}); }
}
