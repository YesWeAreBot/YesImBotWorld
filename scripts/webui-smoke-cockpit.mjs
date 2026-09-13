/** Resident control is exercised only against the isolated preview API. */
import smokeExperiences from './webui-smoke-experiences.mjs';
export default async function smokeCockpit({ evaluate, wait, assert, navigate, page }) {
  const run = (fn, arg) => evaluate(`(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`);
  assert(await run(async () => location.port !== '18111' && ['127.0.0.1','localhost'].includes(location.hostname) && (await (await fetch('/api/health')).json()).preview), 'Cockpit test requires an isolated fixture');
  const click = text => run(text => {
    const button = [...document.querySelectorAll('main button')].find(n=>n.textContent.trim() === text);
    if (!button || button.disabled) throw Error('Unavailable: '+text);
    button.click();
  }, text);
  const choose = async name => { await run(() => { if (document.querySelector('.cockpit-picker')?.hidden) document.querySelector('.cockpit-choice').click(); }); await run(name => document.querySelector('[data-cockpit-tool="'+name+'"]').click(), name); };
  await run(() => { window.__cockpitSmoke = { original:api, calls:[] }; api = function(method,path,body) { window.__cockpitSmoke.calls.push({method,path,body}); return window.__cockpitSmoke.original(method,path,body); }; });
  try {
    for (const mode of ['puppet','avatar']) {
      await page('Emulation.setDeviceMetricsOverride', { width: mode === 'puppet' ? 375 : 1440, height: 1050, deviceScaleFactor:1, mobile:mode === 'puppet' });
      await run(async () => {
        await refreshOverview(false);
        await api('POST','/api/world/stop',{});
        lastOverview = null;
        window.__cockpitSmoke.overviewBeforeMount = window.__cockpitSmoke.calls.filter(c=>c.path==='/api/overview').length;
      });
      await navigate('player');
      await wait(`document.querySelector('[data-journey-availability]')?.hidden === false && document.querySelector('[data-journey-arrive]')?.disabled`);
      assert(await run(()=>window.__cockpitSmoke.calls.filter(c=>c.path==='/api/overview').length>window.__cockpitSmoke.overviewBeforeMount), 'Entry fetches authoritative running status even without a cached overview');
      assert(await run(()=>document.querySelector('[data-journey-availability] a')?.getAttribute('href')==='#overview' && document.querySelector('[data-journey-availability]').textContent.includes('世界尚未运行')), 'Stopped entry explains the prerequisite and links administrators to the overview');
      await click('作为独立角色入场');
      await run(async()=>{
        const name=document.querySelector('.journey-identity input'),persona=document.querySelector('.journey-persona');
        name.value='等待开场的旅人';persona.value='世界暂停时仍能准备的角色设定';
        [name,persona].forEach(n=>n.dispatchEvent(new Event('input',{bubbles:true})));
        window.__cockpitSmoke.entryDraft=name;name.focus();name.setSelectionRange(1,3);
        await refreshOverview(false);
      });
      assert(await run(()=>{const n=window.__cockpitSmoke.entryDraft;return n.isConnected&&!n.disabled&&document.activeElement===n&&n.selectionStart===1&&n.selectionEnd===3&&n.value==='等待开场的旅人'&&!document.querySelector('.journey-persona').disabled;}),'Stopped-world updates preserve editable identity drafts and the exact focused input');
      await click('接管常驻角色');
      await wait(`!!document.querySelector('[data-takeover-mode="${mode}"]') && document.querySelector('[data-journey-arrive]')?.textContent === '接管 小澈'`);
      await run(mode=>document.querySelector('[data-takeover-mode="'+mode+'"]').click(), mode);
      assert(await run(mode=>document.querySelector('[data-takeover-mode="'+mode+'"]').getAttribute('aria-pressed')==='true' && !document.querySelector('[data-takeover-mode="'+mode+'"]').disabled && document.querySelector('[data-journey-arrive]').disabled,mode), 'Both consciousness modes remain selectable while entry is blocked');
      await run(()=>{
        window.__cockpitSmoke.arrivalsBeforeStart=window.__cockpitSmoke.calls.filter(c=>c.path==='/api/player/arrive').length;
        document.querySelector('[data-journey-arrive]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      });
      assert(await run(()=>window.__cockpitSmoke.calls.filter(c=>c.path==='/api/player/arrive').length===window.__cockpitSmoke.arrivalsBeforeStart), 'A stopped-world submission does not reach the entry API');
      await run(async()=>{await api('POST','/api/world/start',{});await refreshOverview(false);});
      await wait(`!document.querySelector('[data-journey-arrive]')?.disabled && document.querySelector('[data-journey-availability]')?.hidden === true`);
      await run(()=>window.dispatchEvent(new CustomEvent('studio:overview',{detail:{}})));
      assert(await run(mode=>document.querySelector('[data-takeover-mode="'+mode+'"]').getAttribute('aria-pressed')==='true'&&!document.querySelector('[data-journey-arrive]').disabled,mode), 'Running-state events restore entry without changing the selected mode; unknown status does not imply a stopped world');
      await click('接管 小澈');
      await wait(`!!document.querySelector('.journey-connection.connected') && !!document.querySelector('[data-cockpit-tool="observe"]')`);
      assert(await run(mode=>window.__cockpitSmoke.calls.filter(c=>c.path==='/api/player/arrive').at(-1).body.mode === mode, mode), 'Selected consciousness mode reaches the server');
      assert.equal(await run(()=>!!document.querySelector('[data-cockpit-tool="recall_growth"]')), mode === 'avatar', 'Puppet cannot replace the character’s thoughts');
      assert(await run(()=>document.documentElement.scrollWidth <= innerWidth), 'Cockpit fits the viewport');
      assert(await run(()=>document.querySelectorAll('.journey-live-status [data-live-source]').length === 2), 'Both real LLM lanes are visible in the cockpit');
      assert(await run(()=>{const dock=document.querySelector('.journey-dock').getBoundingClientRect(), nav=document.querySelector('#mobile-nav').getBoundingClientRect();return getComputedStyle(document.querySelector('.journey-dock')).position==='fixed'&&dock.width<=innerWidth&&dock.left>=0&&dock.right<=innerWidth&&(!nav.height||dock.bottom<nav.top);}), 'Persistent operator dock clears bottom navigation');
      if (mode === 'puppet') {
        for (const [width,height] of [[320,568],[568,320],[320,240]]) {
          await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
          await run(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          assert(await run(width=>{const dock=document.querySelector('.journey-dock').getBoundingClientRect(),header=document.querySelector('#topbar').getBoundingClientRect();return document.documentElement.scrollWidth<=width&&dock.left>=0&&dock.right<=width&&dock.top-header.bottom>=40;},width),'Narrow and short viewports preserve a reading strip above the operator');
        }
        await run(()=>document.querySelector('.journey-dock-grip').click());
        assert(await run(()=>document.querySelector('.journey-dock').getBoundingClientRect().height<50&&document.querySelector('.cockpit').hidden),'The operator can collapse to leave the page readable');
        await run(()=>document.querySelector('.journey-dock-grip').click());
        await page('Emulation.setDeviceMetricsOverride',{width:320,height:568,deviceScaleFactor:1,mobile:true});
        await run(()=>{
          const input=document.querySelector('[data-cockpit-field="act:description"]');input.focus();window.__cockpitSmoke.keyboardInput=input;
          window.__cockpitSmoke.viewportHeightDescriptor=Object.getOwnPropertyDescriptor(visualViewport,'height');
          Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>280});window.dispatchEvent(new Event('resize'));
        });
        assert(await run(()=>{const dock=document.querySelector('.journey-dock').getBoundingClientRect(),header=document.querySelector('#topbar').getBoundingClientRect();return dock.bottom<=280&&dock.top-header.bottom>=40&&document.activeElement===window.__cockpitSmoke.keyboardInput;}),'Visual viewport keyboard inset keeps both the editor and a reading region without re-focusing');
        await run(()=>{const d=window.__cockpitSmoke.viewportHeightDescriptor;if(d)Object.defineProperty(visualViewport,'height',d);else delete visualViewport.height;window.__cockpitSmoke.keyboardInput.blur();window.dispatchEvent(new Event('resize'));});
        await page('Emulation.setDeviceMetricsOverride',{width:375,height:1050,deviceScaleFactor:1,mobile:true});
      }
      await choose('act');
      await run(async()=>{
        const input=document.querySelector('[data-cockpit-field="act:description"]'); window.__cockpitSmoke.imeNode=input; window.__cockpitSmoke.extraFocus=0;
        input.focus(); input.value='正在用输入法编辑的意图'; input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); input.dispatchEvent(new Event('input',{bubbles:true})); input.setSelectionRange(2,5);
        window.__cockpitSmoke.onFocus=()=>window.__cockpitSmoke.extraFocus++;
        document.addEventListener('focusin',window.__cockpitSmoke.onFocus);
        await api('POST','/api/device/tool',{name:'open_app',args:{name:'studio_mcp'},mode:'takeover'});
        window.dispatchEvent(new CustomEvent('studio:refresh'));
      });
      await wait(`!!document.querySelector('[data-cockpit-tool="compose_palette"]')`);
      assert(await run(()=>{const n=window.__cockpitSmoke.imeNode;return n.isConnected&&document.activeElement===n&&n.value==='正在用输入法编辑的意图'&&n.selectionStart===2&&n.selectionEnd===5&&window.__cockpitSmoke.extraFocus===0;}), 'Polling/catalog changes preserve the exact composing DOM node, selection and focus without reopening IME');
      await run(()=>{const n=window.__cockpitSmoke.imeNode;n.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));document.removeEventListener('focusin',window.__cockpitSmoke.onFocus);n.blur();});
      assert(await run(()=>!document.querySelector('.cockpit-schema').open), 'Advanced JSON starts collapsed');
      await click('重新观察');
      await wait(`document.querySelectorAll('.journey-entity').length > 1 && !document.querySelector('.journey-pending')`);
      assert(await run(()=>window.__cockpitSmoke.calls.some(c=>c.path==='/api/player/tool' && c.body.name==='observe' && c.body.token==='preview-player')), 'Resident observation uses the actual manual Bot tool path with session authorization');
      // The schema form must pass typed values and convert world seconds to TU.
      await choose('act');
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
      await run(()=>{const input=document.querySelector('[data-cockpit-field="act:description"]');input.value='操作设备回来后继续的意图';input.dispatchEvent(new Event('input',{bubbles:true}));});
      await click('操作手机与电脑 ↗');
      await wait(`document.querySelector('.device-control')?.textContent.includes('返回角色驾驶舱')`);
      assert(await run(mode=>document.querySelector('.device-control').textContent.includes(mode==='puppet'?'Bot 保留意识':'你正在使用自己的设备'),mode), 'Devices inherit the same resident mode');
      assert(await run(()=>!document.querySelector('[data-device-control]')&&!document.querySelector('.device-operation-modes')), 'Device page cannot override resident ownership');
      assert(await run(async()=>(await (await fetch('/api/preview/player/connection')).json()).connected===1), 'Switching to devices keeps the crossing SSE alive');
      await click('返回角色驾驶舱');
      await wait(`!!document.querySelector('.cockpit') && !!document.querySelector('[data-cockpit-tool="open_app"]')`);
      assert(await run(()=>document.querySelector('[data-cockpit-field="act:description"]')?.value==='操作设备回来后继续的意图'), 'Moving between resident devices and cockpit keeps the prepared action draft');
      await choose('open_app');
      assert(await run(()=>document.querySelector('[data-cockpit-field="open_app:name"]')?.tagName==='SELECT'), 'Applications are chosen by name, without copying IDs');
      await run(()=>{const e=document.querySelector('[data-cockpit-field="open_app:name"]');e.value=JSON.stringify('weather');e.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.cockpit-form').requestSubmit();});
      await wait(`!!document.querySelector('[data-cockpit-tool="query_weather"]') && !document.querySelector('.journey-pending')`);
      assert(await run(()=>document.documentElement.scrollWidth <= innerWidth), 'Expanded application capabilities fit the viewport');
      await choose('query_weather');
      await run(()=>{const city=document.querySelector('[data-cockpit-field="query_weather:city"]');city.value='示例城\n```json\n{"forecast":{"rain":true},"labels":["上午","下午"]}\n```';city.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.cockpit-form').requestSubmit();});
      await wait(`!document.querySelector('.journey-pending') && !!document.querySelector('.journey-feed-result .readable-data')`);
      assert(await run(()=>{const result=document.querySelector('.journey-feed-result');return result.textContent.includes('示例城')&&!result.querySelector('.readable-raw').open&&!result.textContent.includes('```json');}),'Fenced JSON tool receipts become readable records with the original record folded');
      if (mode === 'avatar') {
        // An arbitrary app's nested schema also has editable controls, not a JSON-only textarea.
        await choose('open_app');
        await run(()=>{const e=document.querySelector('[data-cockpit-field="open_app:name"]');e.value=JSON.stringify('studio_mcp');e.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.cockpit-form').requestSubmit();});
        await wait(`!!document.querySelector('[data-cockpit-tool="compose_palette"]') && !document.querySelector('.journey-pending')`);
        await choose('compose_palette');
        await run(()=>{
          const input=(key,value)=>{const e=document.querySelector('[data-cockpit-field="'+key+'"]');e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));};
          input('compose_palette:title','手动调色'); input('compose_palette:options.contrast','.75');
          document.querySelector('.cockpit-add').click(); input('compose_palette:colors.0','苔绿');
          document.querySelector('.cockpit-form').requestSubmit();
        });
        await wait(`!document.querySelector('.journey-pending')`);
        assert(await run(()=>{const body=window.__cockpitSmoke.calls.filter(c=>c.path==='/api/player/tool'&&c.body.name==='compose_palette').at(-1).body;return body.arguments.colors[0]==='苔绿'&&body.arguments.options.contrast===.75&&body.arguments.style==='自然';}), 'Nested objects, typed arrays and enum defaults are editable without JSON');
        await run(async()=>{
          const input=document.querySelector('[data-cockpit-field="compose_palette:title"]');window.__cockpitSmoke.removedToolInput=input;input.value='应用被关掉时也保留的草稿';input.dispatchEvent(new Event('input',{bubbles:true}));
          await api('POST','/api/device/tool',{name:'close_app',args:{},mode:'takeover'});window.dispatchEvent(new CustomEvent('studio:refresh'));
        });
        await wait(`!document.querySelector('[data-cockpit-tool="compose_palette"]')`);
        assert(await run(()=>window.__cockpitSmoke.removedToolInput.isConnected&&window.__cockpitSmoke.removedToolInput.value==='应用被关掉时也保留的草稿'&&document.querySelector('.cockpit-submit').disabled&&document.querySelector('.cockpit-control-note').textContent.includes('不可用')), 'An unavailable tool retains its draft and clearly blocks execution');
        await choose('wait');
        assert(await run(()=>!document.querySelector('[data-cockpit-field="duration"]')), 'Wait uses one duration source');
        await run(()=>{const n=document.querySelector('[data-cockpit-field="wait:n"]');n.value='60';n.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.cockpit-form').requestSubmit();});
        await wait(`!document.querySelector('.journey-pending')`);
        assert(await run(()=>{const b=window.__cockpitSmoke.calls.filter(c=>c.path==='/api/player/tool'&&c.body.name==='wait').at(-1).body;return b.arguments.n===60&&b.duration===0;}), 'Prior action estimates cannot override wait n');
      }
      await choose('observe_device');
      await run(()=>{const d=document.querySelector('[data-cockpit-field="observe_device:device"]');d.value=JSON.stringify('phone');d.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.cockpit-form').requestSubmit();});
      await wait(`!!document.querySelector('.cockpit-result-media img')`);
      await run(()=>document.querySelector('.cockpit-result-media img').scrollIntoView({behavior:'instant',block:'center'}));
      await wait(`document.querySelector('.cockpit-result-media img').naturalWidth > 0`);
      await choose('act');
      await smokeExperiences({evaluate,wait,assert,navigate},{resident:true,mode});
      await click('归还控制并离场');
      await wait(`!!document.querySelector('.journey-identity')`);
      assert(await run(async()=>{const d=await api('GET','/api/device/session');return d.control.residentMode===null&&!d.control.paused;}), 'Leave returns device and resident autonomy together');
    }
    // Exercise canonical media selection with two distinguishable images. This
    // presentation-only component records arguments; it never calls a Bot tool.
    await run(()=>{
      const data={synced:true,unitWorldSeconds:2,tools:[{name:'view_media',inputSchema:{type:'object',properties:{media:{type:'array',items:{type:'string'}}},required:['media']}}],choices:{mediaCache:[{value:'media:1',text:'窗边的茶杯',preview:'/api/media/file?id=1'}],galleryMedia:[{value:'gallery:照片/清晨.png',text:'清晨的阳光',preview:'/api/media/file?id=2'}]}};
      const panel=WorldCockpit.mount(data,{}, {call:(name,args)=>window.__cockpitSmoke.mediaSubmission={name,args}});panel.dataset.cockpitTest='1';document.querySelector('main').appendChild(panel);
      const add=panel.querySelector('.cockpit-add');add.click();add.click();
      const first=panel.querySelector('[data-cockpit-field="view_media:media.0"]'),second=panel.querySelector('[data-cockpit-field="view_media:media.1"]');first.value=JSON.stringify('media:1');second.value=JSON.stringify('gallery:照片/清晨.png');[first,second].forEach(n=>n.dispatchEvent(new Event('change',{bubbles:true})));
      panel.querySelector('.cockpit-form').requestSubmit();
    });
    assert(await run(()=>{const s=window.__cockpitSmoke.mediaSubmission,images=[...document.querySelectorAll('[data-cockpit-test] .cockpit-choice-preview img')];return s.name==='view_media'&&s.args.media.join('|')==='media:1|gallery:照片/清晨.png'&&images.length===2&&images[0].alt==='窗边的茶杯'&&images[1].alt==='清晨的阳光';}), 'Named media thumbnails preserve exact canonical references and chosen image order');
    await run(()=>document.querySelector('[data-cockpit-test]').remove());
    await run(()=>{
      const data={synced:true,unitWorldSeconds:2,tools:[{name:'act',inputSchema:{type:'object',properties:{description:{type:'string'},target:{type:'string'},observationId:{type:'string'}},required:['description']}}],observation:{observationId:'observation-current',entities:[{observedId:'seen-cup',name:'眼前的茶杯'}]}};
      const panel=WorldCockpit.mount(data,{}, {call:(name,args)=>window.__cockpitSmoke.targetSubmission={name,args}});panel.dataset.cockpitTest='1';document.querySelector('main').appendChild(panel);window.__cockpitSmoke.targetPanel=panel;window.__cockpitSmoke.targetData=data;
      panel.setTarget('眼前的茶杯');const input=panel.querySelector('[data-cockpit-field="act:description"]');input.value='拿起茶杯';input.dispatchEvent(new Event('input',{bubbles:true}));panel.querySelector('.cockpit-form').requestSubmit();
    });
    assert(await run(()=>{const args=window.__cockpitSmoke.targetSubmission.args;return args.target==='眼前的茶杯'&&!('observationId' in args)&&!document.querySelector('[data-cockpit-field="act:observationId"]')&&document.querySelector('[data-cockpit-field="act:target"]').tagName==='TEXTAREA';}),'Pointing at a legacy observed object uses its description without sending obsolete observation IDs');
    await run(()=>{window.__cockpitSmoke.targetSubmission=null;window.__cockpitSmoke.targetData.observation={observationId:'observation-next',entities:[]};window.__cockpitSmoke.targetPanel.update(window.__cockpitSmoke.targetData);window.__cockpitSmoke.targetPanel.querySelector('.cockpit-form').requestSubmit();});
    assert(await run(()=>window.__cockpitSmoke.targetSubmission?.args.target==='眼前的茶杯'),'New observations keep a described target intact; World judges whether it remains accessible');
    await run(()=>document.querySelector('[data-cockpit-test]').remove());
    await run(()=>{
      const data={synced:true,unitWorldSeconds:2,tools:[{name:'reflect',inputSchema:{type:'object',properties:{statement:{type:'string'},event_ids:{type:'array',items:{type:'string'}}},required:['statement','event_ids']}}]};
      const panel=WorldCockpit.mount(data,{}, {call:(name,args)=>window.__cockpitSmoke.evidenceSubmission={name,args}});panel.dataset.cockpitTest='1';document.querySelector('main').appendChild(panel);panel.querySelector('.cockpit-add').click();
      const text=panel.querySelector('[data-cockpit-field="reflect:statement"]');text.value='这件事值得记住';text.dispatchEvent(new Event('input',{bubbles:true}));text.focus();window.__cockpitSmoke.evidenceDraft=text;
      window.__cockpitSmoke.evidenceInitiallyEmpty=panel.querySelector('[data-cockpit-field="reflect:event_ids.0"]').options.length===1;
      data.choices={evidence:[{id:'perceived-exact-id',label:'刚刚亲眼看见的事件'}]};panel.update(data);
      const evidence=panel.querySelector('[data-cockpit-field="reflect:event_ids.0"]');evidence.value=JSON.stringify('perceived-exact-id');evidence.dispatchEvent(new Event('change',{bubbles:true}));panel.querySelector('.cockpit-form').requestSubmit();
    });
    assert(await run(()=>window.__cockpitSmoke.evidenceInitiallyEmpty&&window.__cockpitSmoke.evidenceDraft.isConnected&&document.activeElement===window.__cockpitSmoke.evidenceDraft&&window.__cockpitSmoke.evidenceDraft.value==='这件事值得记住'&&window.__cockpitSmoke.evidenceSubmission.args.event_ids[0]==='perceived-exact-id'),'Evidence choices can arrive later without manual IDs, draft replacement or focus changes');
    await run(()=>document.querySelector('[data-cockpit-test]').remove());
    return ['stopped-world entry guidance, preserved identity drafts and automatic start recovery in both modes','puppet/avatar mode selection, authorized observation and schema-driven tools','action-linked facts, NPC response, needs_input handoff and appended scenes','stable replay, chronological groups and ambient resident perception','real pending call cancellation, TU conversion and dynamic app capabilities','resident-aware devices, mobile dock safe area and persistent IME inputs','name-based application choices and nested typed forms'];
  } finally { await run(()=>{api=window.__cockpitSmoke.original;delete window.__cockpitSmoke;}); }
}
