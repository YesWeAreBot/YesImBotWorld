/** Real browser interactions against the isolated local fixture, never a production world. */
import { writeFile } from 'node:fs/promises';

export default async function smokeActionMenu({ evaluate, wait, assert, navigate, page }) {
  const run = (fn, arg) => evaluate(`(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`);
  const click = text => run(text => {
    const button=[...document.querySelectorAll('main button')].find(node=>node.textContent.trim()===text);
    if(!button||button.disabled)throw Error('Unavailable button: '+text);button.click();
  },text);
  assert(await run(async()=>location.port!=='18111'&&(await(await fetch('/api/health')).json()).preview),'Action menu tests require the isolated preview');
  await run(async()=>{
    await api('POST','/api/preview/narrative',{enabled:true});await api('POST','/api/world/start',{});await refreshOverview(false);
    const state=window.__actionMenuSmoke={original:api,calls:[],hold:false,stale:false};
    api=function(method,path,body){
      const selected=path==='/api/player/tool'&&body?.selection||path==='/api/player/task'&&body?.kind==='choose';
      state.calls.push({method,path,body:structuredClone(body)});
      const request=()=>state.original(method,path,body);
      if(path==='/api/player/task'&&state.taskFailures?.length){const status=state.taskFailures.shift(),error=new Error(status?'模拟明确拒绝 '+status:'模拟传输中断，未得到回执');if(status)error.status=status;return Promise.reject(error);}
      if(selected&&state.hold){state.hold=false;return new Promise((resolve,reject)=>{state.release=()=>request().then(resolve,reject);});}
      if(selected&&state.stale){state.stale=false;return state.original('POST','/api/preview/opportunities',{text:'店员已经离开柜台。',opportunities:[]}).then(request);}
      return request();
    };
  });
  try {
    for(const [mode,width] of [['cross',1440],['puppet',390],['avatar',390]]) {
      await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      await navigate('player');
      const leave=await run(()=>[...document.querySelectorAll('main button')].find(node=>['离开世界','归还控制并离场'].includes(node.textContent.trim()))?.textContent.trim());
      if(leave){await click(leave);await wait(`!!document.querySelector('.journey-identity')`);}
      await click(mode==='cross'?'作为独立角色入场':'接管常驻角色');
      if(mode==='cross')await run(()=>{const node=document.querySelector('.journey-identity input');node.value='菜单测试旅人';node.dispatchEvent(new Event('input',{bubbles:true}));});
      else await run(mode=>document.querySelector('[data-takeover-mode="'+mode+'"]').click(),mode);
      await wait(`!document.querySelector('[data-journey-arrive]').disabled`);
      await run(()=>document.querySelector('[data-journey-arrive]').click());
      await wait(`!!document.querySelector('.world-action-menu [data-action-choice]:not(:disabled)')`);
      assert(await run(()=>!document.querySelector('.journey-dock .world-action-menu,.journey-dock .opportunity-card')&&document.documentElement.scrollWidth<=innerWidth),'Suggestions belong to the readable main content, and fit '+width+'px');
      await run(mode=>{
        const input=document.querySelector(mode==='cross'?'.journey-action-input':'[data-cockpit-field="act:description"]');
        window.__actionMenuSmoke.input=input;input.value='我自己正在写的下一步';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(2,5);
        input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
        window.__actionMenuSmoke.focuses=0;window.__actionMenuSmoke.onFocus=()=>window.__actionMenuSmoke.focuses++;document.addEventListener('focusin',window.__actionMenuSmoke.onFocus);
      },mode);
      await run(async()=>{await api('POST','/api/preview/opportunities',{text:'店员朝你点点头，静候选择。',situation:'柜台前，尚未点餐。',opportunities:[{label:'看看菜单',intent:'仔细看看菜单',exclusiveGroup:'午饭'},{label:'询问店员',intent:'询问店员今天的饭菜',exclusiveGroup:'午饭'}]});});
      await wait(`document.querySelector('.world-action-menu')?.textContent.includes('店员朝你点点头')`);
      await wait(`Array.from(document.querySelectorAll('[data-action-choice]:not(:disabled)')).some(node=>node.textContent.includes('看看菜单'))`);
      assert(await run(()=>{const s=window.__actionMenuSmoke;return s.input.isConnected&&document.activeElement===s.input&&s.input.value==='我自己正在写的下一步'&&s.input.selectionStart===2&&s.input.selectionEnd===5&&s.focuses===0;}),'Scene/menu refresh preserves the exact composing textarea, selection and focus');
      await run(mode=>{const theme=mode==='puppet'?'dark':'light';if(document.body.dataset.theme!==theme)document.querySelector('#btn-theme').click();document.querySelector('.world-action-menu').scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-document.querySelector('#topbar').getBoundingClientRect().height-12,behavior:'instant'});},mode);
      const immediateStyles=await buttonStyles();
      await run(()=>new Promise(resolve=>setTimeout(resolve,250)));
      const settledStyles=await buttonStyles();
      await writeFile(`/tmp/yesimbot-player-${mode}-button-styles.json`,JSON.stringify({immediate:immediateStyles,settled:settledStyles},null,2));
      console.log('BUTTON STYLES',mode,JSON.stringify({immediate:immediateStyles.map(({text,computed})=>({text,...computed})),settled:settledStyles.map(({text,computed})=>({text,...computed}))}));
      const shot=await page('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await writeFile(`/tmp/yesimbot-player-${mode}-${width}.png`,Buffer.from(shot.data,'base64'));
      await run(()=>{
        const s=window.__actionMenuSmoke;s.input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));s.hold=true;
        s.before=s.calls.filter(c=>c.path==='/api/player/tool'&&c.body?.selection||c.path==='/api/player/task'&&c.body?.kind==='choose').length;
        const button=[...document.querySelectorAll('[data-action-choice]')].find(node=>node.textContent.includes('看看菜单'));s.choiceId=button.dataset.actionChoice;button.click();button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      });
      await wait(`!!window.__actionMenuSmoke.release`);
      assert(await run(()=>{const s=window.__actionMenuSmoke,selected=s.calls.filter(c=>c.path==='/api/player/tool'&&c.body?.selection||c.path==='/api/player/task'&&c.body?.kind==='choose');return selected.length===s.before+1&&[...document.querySelectorAll('.world-action-menu button[data-action-choice]')].every(node=>node.disabled)&&s.input.value==='我自己正在写的下一步'&&s.input.isConnected;}),'One click sends one selection; rapid repeated activation stays blocked and does not overwrite free text');
      assert(await run(mode=>{
        const calls=window.__actionMenuSmoke.calls,body=calls.filter(c=>c.path==='/api/player/tool'&&c.body?.selection||c.path==='/api/player/task'&&c.body?.kind==='choose').at(-1).body;
        const ref=mode==='cross'?body.payload.selection:body.selection;
        return ref.opportunityId===window.__actionMenuSmoke.choiceId&&!!ref.sourceEventId&&!("name" in body)&&!("arguments" in body)&&!('desc' in (body.payload||{}));
      },mode),'The API receives stable server-issued selection identities, not a rewritten action or target');
      await run(()=>{window.__actionMenuSmoke.release();delete window.__actionMenuSmoke.release;});
      await wait(`!document.querySelector('.journey-pending')&&document.querySelector('.journey-state-body')?.textContent.includes('米饭现在就有')`);
      await wait(`Array.from(document.querySelectorAll('[data-action-choice]:not(:disabled)')).some(node=>node.textContent.includes('选米饭套餐'))`);
      assert(await run(()=>window.__actionMenuSmoke.input.isConnected&&window.__actionMenuSmoke.input.value==='我自己正在写的下一步'),'The action receipt preserves an independent unsent draft');
      await run(()=>{
        const s=window.__actionMenuSmoke;s.stale=true;
        [...document.querySelectorAll('[data-action-choice]')].find(node=>node.textContent.includes('选米饭套餐')).click();
      });
      await wait(`!document.querySelector('.journey-pending')&&/已过期|已失效|已变化/.test(document.querySelector('main').textContent)`);
      assert(await run(()=>!document.querySelector('main').textContent.includes('以原编号重试')&&window.__actionMenuSmoke.input.value==='我自己正在写的下一步'),'A definite stale-selection rejection clears busy state without an automatic or uncertain retry');
      if(mode==='cross')await crossDraftAndRetry();
      await run(()=>document.removeEventListener('focusin',window.__actionMenuSmoke.onFocus));
      await click(mode==='cross'?'离开世界':'归还控制并离场');await wait(`!!document.querySelector('.journey-identity')`);
    }

    // The common menu and cockpit are mounted together to exercise reply editing
    // without creating a pretend platform message or sending through a live account.
    await run(()=>{
      const state=window.__actionMenuSmoke;
      state.componentCalls=[];
      state.reply={id:'reply-known-message',label:'回应这句话',intent:'考虑回复已经读到的消息',source:'device',sourceEventId:'real-message-a',replyTo:'fixture:friend-a'};
      state.data={synced:true,unitWorldSeconds:2,tools:[{name:'send',requiresSendConfirmation:true,inputSchema:{type:'object',properties:{id:{type:'string'},msg:{type:'string'}},required:['id','msg']}}],deviceSession:{chat:{channels:[{key:'fixture:friend-a',name:'阿青'},{key:'fixture:friend-b',name:'小红'}]}},opportunities:[state.reply]};
      state.panel=WorldCockpit.mount(state.data,{}, {call:(name,args,duration,confirmSend,selection)=>{state.componentCalls.push({name,args,duration,confirmSend,selection});}});
      state.menu=WorldActionMenu.mount({choose:item=>state.panel.chooseOpportunity(item),edit:item=>state.panel.chooseOpportunity(item,{edit:true}),free:()=>{}});
      state.menu.update({items:[state.reply]});state.host=document.createElement('section');state.host.dataset.actionMenuTest='1';state.host.append(state.menu,state.panel);document.querySelector('main').append(state.host);
      state.menu.querySelector('[data-action-choice]').click();
    });
    assert(await run(()=>{const s=window.__actionMenuSmoke;return s.componentCalls.length===0&&s.panel.querySelector('[data-cockpit-field="send:id"]').disabled&&s.panel.querySelector('[data-cockpit-field="send:msg"]').value==='';}),'A reply choice opens a blank human-authored message at its fixed known recipient without sending');
    await run(()=>{
      const s=window.__actionMenuSmoke,input=s.panel.querySelector('[data-cockpit-field="send:msg"]');s.replyInput=input;input.value='  明天一起去河边吧。\n';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(2,5);input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      s.panel.update(structuredClone(s.data));s.menu.update({items:[s.reply]});input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));s.panel.querySelector('form').requestSubmit();
    });
    assert(await run(()=>{const s=window.__actionMenuSmoke;return s.replyInput.isConnected&&document.activeElement===s.replyInput&&s.replyInput.selectionStart===2&&s.componentCalls.length===0&&s.panel.querySelector('.journey-error').textContent.includes('确认');}),'Reply polling preserves IME and selection; submission requires the explicit send confirmation');
    await run(()=>{const s=window.__actionMenuSmoke;s.panel.querySelector('[data-cockpit-confirm-send]').checked=true;s.panel.querySelector('form').requestSubmit();});
    assert(await run(()=>{const c=window.__actionMenuSmoke.componentCalls[0];return c?.name==='send'&&c.args.id==='fixture:friend-a'&&c.args.msg==='  明天一起去河边吧。\n'&&c.confirmSend===true&&c.selection.opportunityId==='reply-known-message';}),'Confirmed reply preserves the exact supplied text and selected recipient');
    await run(()=>{
      const s=window.__actionMenuSmoke;s.data={...s.data,opportunities:[]};s.panel.update(s.data);s.menu.update({items:[]});s.panel.querySelector('form').requestSubmit();
    });
    assert(await run(()=>{const s=window.__actionMenuSmoke;return s.componentCalls.length===1&&s.replyInput.isConnected&&s.panel.querySelector('.cockpit-submit').disabled&&s.panel.textContent.includes('已失效');}),'Expired edited replies retain text but cannot be submitted under a stale identity');
    await run(()=>{
      const s=window.__actionMenuSmoke;[...s.panel.querySelectorAll('button')].find(node=>node.textContent==='改为自由操作').click();s.panel.querySelector('[data-cockpit-confirm-send]').checked=true;s.panel.querySelector('form').requestSubmit();
    });
    assert(await run(()=>{const s=window.__actionMenuSmoke;return s.componentCalls.length===2&&!s.componentCalls[1].selection&&!s.panel.querySelector('[data-cockpit-field="send:id"]').disabled&&s.replyInput.isConnected;}),'Only explicit conversion to a free operation releases the stale binding and recipient lock');
    await run(()=>window.__actionMenuSmoke.host.remove());
    return 'story-side touch menus, one-click server-bound choices, busy and stale rejection, untouched drafts/IME, explicit exact-target reply editing and send confirmation';
  } finally {
    await run(async()=>{const s=window.__actionMenuSmoke;if(s){api=s.original;document.removeEventListener('focusin',s.onFocus);s.host?.remove();delete window.__actionMenuSmoke;}await api('POST','/api/preview/narrative',{enabled:false});});
  }

  async function buttonStyles() {
    return run(()=>['.action-menu-free','.cockpit-choice','.journey-dock-grip'].flatMap(selector=>{
      const node=document.querySelector(selector);if(!node)return [];
      const computed=getComputedStyle(node),rules=[];
      function visit(entries,sheet,parents=[]) {
        for(const [index,rule] of [...entries].entries()) {
          if(rule.type===CSSRule.MEDIA_RULE&&!matchMedia(rule.conditionText).matches)continue;
          if(rule.type===CSSRule.SUPPORTS_RULE&&!CSS.supports(rule.conditionText))continue;
          if(rule.cssRules)visit(rule.cssRules,sheet,[...parents,rule.conditionText||rule.name||index]);
          if(rule.selectorText)try{
            if(!node.matches(rule.selectorText))continue;
            const styles={};for(const key of ['background','background-color','background-image','color','-webkit-text-fill-color','opacity','transition'])if(rule.style.getPropertyValue(key))styles[key]=rule.style.getPropertyValue(key)+(rule.style.getPropertyPriority(key)?' !important':'');
            if(Object.keys(styles).length)rules.push({sheet,index,parents,selector:rule.selectorText,styles});
          }catch{/* Unsupported pseudo elements do not match the button itself. */}
        }
      }
      [...document.styleSheets].forEach((sheet,index)=>{try{visit(sheet.cssRules,sheet.href||'inline:'+index);}catch{}});
      return [{selector,text:node.textContent,computed:{backgroundColor:computed.backgroundColor,backgroundImage:computed.backgroundImage,color:computed.color,transition:computed.transition,opacity:computed.opacity,surface:computed.getPropertyValue('--surface'),foreground:computed.getPropertyValue('--fg')},inlineStyle:node.getAttribute('style'),rules}];
    }));
  }

  async function crossDraftAndRetry() {
    await run(async()=>{await api('POST','/api/preview/opportunities',{text:'可以慢慢想好下一步。',opportunities:[{label:'走到花园',intent:'走到花园看花'},{label:'走到河边',intent:'沿小路走到河边'}]});});
    await wait(`Array.from(document.querySelectorAll('[data-action-choice]')).some(node=>node.textContent.includes('走到花园'))`);
    await run(()=>{
      const s=window.__actionMenuSmoke;s.draftTaskCount=s.calls.filter(call=>call.path==='/api/player/task').length;
      const set=(selector,value)=>{const node=document.querySelector(selector);node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));};
      s.setDraft=set;
      document.querySelector('.journey-action .cockpit-options').open=true;
      set('.journey-action-input','最早的一份自由草稿 A');set('.journey-speech-input','原话 A');set('[data-cockpit-field="action:target"]','木桥');set('.journey-two-fields input[type="number"]','3');
      s.editChoice=label=>{const primary=[...document.querySelectorAll('[data-action-choice]')].find(node=>node.textContent.includes(label));document.querySelector('[data-action-edit="'+primary.dataset.actionChoice+'"]').click();};
      s.confirmDraft=()=>[...document.querySelectorAll('.journey-dock button')].find(node=>node.textContent==='暂存草稿，补充台词').click();
      s.editChoice('走到花园');s.confirmDraft();set('.journey-speech-input','中间的台词草稿 B');set('.journey-two-fields input[type="number"]','4');
      s.editChoice('走到河边');s.confirmDraft();set('.journey-speech-input','当前仍在输入的台词 C');set('.journey-two-fields input[type="number"]','5');
      s.restoreSpeech=document.querySelector('.journey-speech-input');s.restoreSpeech.focus();s.restoreSpeech.setSelectionRange(2,6);s.restoreSpeech.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      document.querySelector('[data-restore-action-draft]').click();
    });
    assert(await run(()=>{const s=window.__actionMenuSmoke;return s.restoreSpeech.isConnected&&document.activeElement===s.restoreSpeech&&s.restoreSpeech.value==='当前仍在输入的台词 C'&&s.restoreSpeech.selectionStart===2&&s.restoreSpeech.selectionEnd===6&&document.querySelector('.journey-action').textContent.includes('请先完成正在输入');}),'Restoring a saved draft during IME leaves the current text, input node and composition selection untouched');
    await run(()=>{window.__actionMenuSmoke.restoreSpeech.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));document.querySelector('[data-restore-action-draft]').click();});
    assert(await run(()=>document.querySelector('.journey-action-input').value==='走到花园看花'&&document.querySelector('.journey-speech-input').value==='中间的台词草稿 B'&&document.querySelector('.journey-two-fields input[type="number"]').value==='4'),'The newest saved draft restores its own action, speech and duration');
    await run(()=>document.querySelector('[data-restore-action-draft]').click());
    assert(await run(()=>document.querySelector('.journey-action-input').value==='最早的一份自由草稿 A'&&document.querySelector('.journey-speech-input').value==='原话 A'&&document.querySelector('[data-cockpit-field="action:target"]').value==='木桥'&&document.querySelector('.journey-two-fields input[type="number"]').value==='3'),'Multiple edits retain the earliest draft including its independent target and duration');
    await run(()=>document.querySelector('[data-restore-action-draft]').click());
    assert(await run(()=>{const s=window.__actionMenuSmoke;return s.restoreSpeech===document.querySelector('.journey-speech-input')&&s.restoreSpeech.value==='当前仍在输入的台词 C'&&document.querySelector('.journey-action-input').value==='沿小路走到河边'&&document.querySelector('.journey-two-fields input[type="number"]').value==='5'&&s.calls.filter(call=>call.path==='/api/player/task').length===s.draftTaskCount;}),'Restoring older work saves the current draft in turn and never executes an action');

    // Simulate transport uncertainty first, then a definite admission rejection on
    // the explicit retry. These mock failures never reach even the fixture world.
    for(const statuses of [[0,409],[503,429]]) {
      await run(statuses=>{
        const s=window.__actionMenuSmoke;s.taskFailures=[...statuses];s.setDraft('.journey-action-input','重试失败后也应保留的自由草稿 '+statuses[1]);
        s.setDraft('.journey-speech-input','');s.setDraft('.journey-two-fields input[type="number"]','0');
        s.retryBefore=s.calls.filter(call=>call.path==='/api/player/task').length;
        document.querySelector('.journey-action').requestSubmit();
      },statuses);
      await wait(`!!document.querySelector('.journey-pending')&&Array.from(document.querySelectorAll('.journey-pending button')).some(node=>node.textContent==='以原编号重试')`);
      await click('以原编号重试');
      await wait(`!document.querySelector('.journey-pending')`);
      assert(await run(statuses=>{
        const s=window.__actionMenuSmoke,retries=s.calls.filter(call=>call.path==='/api/player/task').slice(s.retryBefore);
        return retries.length===2&&JSON.stringify(retries[0].body)===JSON.stringify(retries[1].body)&&s.taskFailures.length===0&&document.querySelector('.journey-action-input').value==='重试失败后也应保留的自由草稿 '+statuses[1]&&!document.querySelector('.journey-action button[type="submit"]').disabled;
      },statuses),'An explicit retry reuses the original request; HTTP '+statuses[1]+' releases busy state and preserves the draft');
    }
  }
}
