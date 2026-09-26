/** Real device panels against browser-local state; no model or platform is called. */
export default async function smokePhoneApps({ evaluate, wait, assert, navigate, page }) {
  assert(await evaluate("fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Phone app smoke requires an isolated preview');
  await navigate('overview');
  await page('Emulation.setDeviceMetricsOverride', { width: 375, height: 1050, deviceScaleFactor: 1, mobile: true });
  await evaluate(`(async function(){window.__phoneOriginalApi=api; window.__phoneOriginalInterval=window.setInterval;
    window.__phoneCalls=[]; window.__phonePolls=0;
    window.__phoneBase=await api('GET','/api/device/session');
    window.__phoneActive='assistant';
    window.__phoneStates={
      assistant:{id:'assistant',name:'糖豆',busy:true,jobs:[{id:'answer-one',question:'写一段欢迎语',reply:'欢迎来到',status:'running',worldTime:'星历一万二千三百四十五年 · 27时105分'}]},
      camera:{id:'camera',name:'相机',busy:false,jobs:[{id:'photo-saved',subject:'窗边的白杯',status:'completed',mediaId:71,galleryRef:'gallery:照片/白杯.png'}]},
      clock:{timeLine:'2026-09-23 10:20:00',nowTU:100,secondsPerTU:2,stopwatch:{elapsedSeconds:12,running:false,laps:[4,9]},reminders:[{id:'actual-timer-A/42',label:'收衣服',kind:'timer',status:'scheduled',dueTU:130},{id:'actual-alarm-B/77',label:'喝水',kind:'alarm',status:'fired',dueTU:90}]}
    };
    window.__phoneApps=[{id:'assistant',name:'糖豆',kind:'app'},{id:'camera',name:'相机',kind:'app'},{id:'clock',name:'时钟',kind:'app'}];
    window.__phoneTools={assistant:['ask','read_reply','cancel','new_conversation'],camera:['take_photo','read_photo','cancel'],clock:['read_clock','set_timer','set_alarm','list_reminders','cancel_reminder','snooze_reminder','stopwatch']};
    window.__phoneSnapshot=function(){
      var data=structuredClone(__phoneBase),active=__phoneApps.find(a=>a.id===__phoneActive);
      data.running=true;data.control={paused:false,busy:false,residentMode:null,deviceBusy:false};data.devices.phone.down=false;
      data.devices.phone.appOpen=active?.name||null;data.devices.phone.chatOpen=false;
      data.apps=__phoneApps.map(a=>Object.assign({},a,{active:a.id===__phoneActive}));
      data.appCatalog=data.apps.map(a=>Object.assign({},a,{status:'ready',reason:'本地交互样本'}));
      data.tools=['open_app','close_app'].map(name=>({name:name,device:'phone',effect:'action',description:name,inputSchema:{type:'object'}})).concat((__phoneTools[__phoneActive]||[]).map(name=>({name:__phoneActive+'.'+name,device:'phone',effect:'action',description:name,inputSchema:{type:'object'}})));
      data.appView=active?{id:active.id,name:active.name,state:structuredClone(__phoneStates[active.id])}:null;return data;
    };
    api=async function(method,url,body){
      if(method==='GET' && url==='/api/device/session'){__phonePolls++;return __phoneSnapshot();}
      if(method==='POST' && url==='/api/device/tool'){
        __phoneCalls.push(structuredClone(body));var args=body.args||{},name=body.name;
        if(name==='open_app')__phoneActive=args.name;
        else if(name==='close_app')__phoneActive=null;
        else if(name==='assistant.ask'){
          if(window.__phoneAskMode==='error')throw new Error('提问未受理，请稍后重试');
          if(window.__phoneAskMode==='not-accepted')return {ok:true,text:'已有任务仍在生成；本次未提交'};
          if(window.__phoneAskMode==='hold')await new Promise(resolve=>window.__phoneReleaseAsk=resolve);
          __phoneStates.assistant.jobs.push({id:'answer-'+__phoneCalls.length,question:args.question,reply:'',status:'running'});__phoneStates.assistant.busy=true;
        }
        else if(name==='camera.cancel'){var job=__phoneStates.camera.jobs.find(j=>j.id===args.job_id);job.status='cancelled';__phoneStates.camera.busy=false;}
        else if(name==='camera.take_photo'){__phoneStates.camera.jobs.push({id:'photo-from-ui',subject:args.subject,facing:args.facing,status:'generating'});__phoneStates.camera.busy=true;}
        else if(name==='clock.cancel_reminder')__phoneStates.clock.reminders.find(r=>r.id===args.id).status='cancelled';
        else if(name==='clock.snooze_reminder')__phoneStates.clock.reminders.push({id:'new-snoozed-id',kind:'alarm',label:'喝水（延后）',status:'scheduled',dueTU:250});
        else if(!['assistant.cancel','assistant.new_conversation','clock.set_timer','clock.set_alarm','clock.stopwatch'].includes(name))throw Error('Unexpected mock operation '+name);
        return {ok:true,text:'本地浏览器样本操作已受理'};
      }
      return __phoneOriginalApi.apply(this,arguments);
    };
    window.setInterval=function(fn,ms){return __phoneOriginalInterval(fn,ms===5000?70:ms);};})()`);
  const widthOK = () => evaluate('document.documentElement.scrollWidth<=375 && innerWidth<=375');
  const openApp = async (name, kind) => {
    await evaluate("document.querySelector('.app-back').click()");
    const target = `Array.from(document.querySelectorAll('.phone-app-tile')).find(n=>n.getAttribute('aria-label')===${JSON.stringify(name)})`;
    await wait(`!!(${target}) && !(${target}).disabled`);
    await evaluate(`(${target}).click()`);
    await wait(`!!document.querySelector('.app-${kind} .phone-app-heading')`);
  };
  try {
    await navigate('devices');
    await wait("document.querySelector('.assistant-reply')?.textContent==='欢迎来到'");
    await evaluate(`window.__phoneInput=document.querySelector('.phone-app-composer textarea');
      __phoneInput.value='正在输入，还没提交的草稿';__phoneInput.focus();__phoneInput.setSelectionRange(3,3);
      __phoneInput.dispatchEvent(new CompositionEvent('compositionstart',{data:'草'}));
      window.__phoneFocusEvents=0;__phoneInput.addEventListener('focus',()=>__phoneFocusEvents++);
      window.__phonePollBefore=__phonePolls;
      __phoneStates.assistant.jobs[0].reply='欢迎来到工作室。<img src=x onerror=alert(1)>';`);
    await wait("document.querySelector('.assistant-reply')?.textContent.includes('欢迎来到工作室。') && __phonePolls>=__phonePollBefore+3");
    assert(await evaluate("document.querySelector('.phone-app-composer textarea')===__phoneInput && document.activeElement===__phoneInput && __phoneInput.selectionStart===3 && __phoneInput.value==='正在输入，还没提交的草稿' && __phoneFocusEvents===0"), 'Streaming polling preserves the mobile input node, IME focus, selection and unsent draft');
    assert(await evaluate("!document.querySelector('.assistant-reply img') && document.querySelector('.phone-app-primary').disabled"), 'Streaming body is literal text and cannot submit another active job');
    await evaluate("__phoneInput.dispatchEvent(new CompositionEvent('compositionend',{data:'草'}));__phoneStates.assistant.jobs[0].status='completed';__phoneStates.assistant.busy=false;");
    await wait("!document.querySelector('.phone-app-composer button').disabled");
    await evaluate("document.querySelector('.phone-app-composer').requestSubmit()");
    await wait("__phoneCalls.some(c=>c.name==='assistant.ask')");
    assert(await evaluate("__phoneCalls.find(c=>c.name==='assistant.ask').args.question==='正在输入，还没提交的草稿'"), 'Assistant submit follows the namespaced device tool with the exact draft');
    await wait("__phoneInput.value===''");
    assert(await evaluate("__phoneStates.assistant.busy && __phoneStates.assistant.jobs.at(-1).status==='running' && document.querySelector('.phone-app-composer textarea')===__phoneInput && document.activeElement===__phoneInput && __phoneFocusEvents===0"), 'An accepted question clears immediately while its answer is still generating, without replacing or refocusing the textarea');

    const readyForAsk = async mode => {
      await evaluate(`__phoneStates.assistant.jobs.forEach(j=>j.status='completed');__phoneStates.assistant.busy=false;window.__phoneAskMode=${JSON.stringify(mode)};`);
      await wait("!document.querySelector('.phone-app-composer button').disabled");
    };
    await readyForAsk('error');
    await evaluate("__phoneInput.value='失败时保留的草稿';__phoneInput.dispatchEvent(new Event('input'));document.querySelector('.phone-app-composer').requestSubmit()");
    await wait("document.querySelector('.phone-app-feedback').textContent.includes('提问未受理') && !document.querySelector('.phone-app-composer button').disabled");
    assert(await evaluate("__phoneInput.value==='失败时保留的草稿'"), 'Rejected device calls preserve the draft instead of treating the caught error as success');

    await readyForAsk('not-accepted');
    await evaluate("document.querySelector('.phone-app-composer').requestSubmit()");
    await wait("document.querySelector('.phone-app-feedback').textContent.includes('本次未提交') && !document.querySelector('.phone-app-composer button').disabled");
    assert(await evaluate("__phoneInput.value==='失败时保留的草稿'"), 'A successful HTTP response reporting an existing job is not acceptance of a new question');

    await readyForAsk('hold');
    await evaluate("document.querySelector('.phone-app-composer').requestSubmit()");
    await wait("typeof __phoneReleaseAsk==='function'");
    await evaluate("__phoneInput.value='发送期间的新草稿';__phoneInput.dispatchEvent(new Event('input'));__phoneInput.dispatchEvent(new CompositionEvent('compositionstart',{data:'新'}));__phoneInput.setSelectionRange(2,2);__phoneReleaseAsk();delete window.__phoneReleaseAsk;window.__phonePollBefore=__phonePolls;");
    await wait("__phoneStates.assistant.busy && __phonePolls>=__phonePollBefore+3");
    assert(await evaluate("document.querySelector('.phone-app-composer textarea')===__phoneInput && document.activeElement===__phoneInput && __phoneInput.value==='发送期间的新草稿' && __phoneInput.selectionStart===2 && __phoneFocusEvents===0"), 'Delayed acceptance preserves newly edited text, the composing textarea and its selection');
    await evaluate("__phoneInput.dispatchEvent(new CompositionEvent('compositionend',{data:'新'}));window.__phoneCallCount=__phoneCalls.length;document.querySelector('.phone-app-composer').requestSubmit()");
    assert(await evaluate("__phoneCalls.length===__phoneCallCount && __phoneInput.value==='发送期间的新草稿'"), 'Submission while the app is busy does not execute or clear another draft');

    await readyForAsk('hold');
    await evaluate("document.querySelector('.phone-app-composer').requestSubmit()");
    await wait("typeof __phoneReleaseAsk==='function'");
    await evaluate("__phoneInput.value='临时改写';__phoneInput.dispatchEvent(new Event('input'));__phoneInput.value='发送期间的新草稿';__phoneInput.dispatchEvent(new Event('input'));__phoneReleaseAsk();delete window.__phoneReleaseAsk;window.__phonePollBefore=__phonePolls;");
    await wait("__phoneStates.assistant.busy && __phonePolls>=__phonePollBefore+3");
    assert(await evaluate("__phoneInput.value==='发送期间的新草稿'"), 'Editing back to the same text still counts as a new draft revision and must not be cleared');
    assert(await widthOK(), 'Assistant stays inside a 375px viewport');

    await openApp('相机','camera');
    await wait("document.querySelector('.camera-photo-image')?.naturalWidth>0");
    assert(await evaluate("new URL(document.querySelector('.camera-photo-image').src).searchParams.get('id')==='71'"), 'Photo preview uses the actual persisted media ID');
    await evaluate(`window.__phoneInput=document.querySelector('.camera-composer textarea');__phoneInput.value='杯子左侧的近景草稿';__phoneInput.focus();__phoneInput.setSelectionRange(2,2);
      __phoneStates.camera.jobs.push({id:'photo-in-progress/real',subject:'正在取景的白杯',status:'generating'});__phoneStates.camera.busy=true;window.__phonePollBefore=__phonePolls;`);
    await wait("Array.from(document.querySelectorAll('.camera-photo')).some(n=>n.textContent.includes('正在取景的白杯')) && __phonePolls>=__phonePollBefore+3");
    assert(await evaluate("document.querySelector('.camera-composer textarea')===__phoneInput && document.activeElement===__phoneInput && __phoneInput.value==='杯子左侧的近景草稿' && __phoneInput.selectionStart===2"), 'Photo job polling keeps the framing draft and focus');
    await evaluate("Array.from(document.querySelectorAll('.camera-photo')).find(n=>n.textContent.includes('正在取景的白杯')).querySelector('button').click()");
    await wait("__phoneCalls.some(c=>c.name==='camera.cancel')");
    assert(await evaluate("__phoneCalls.find(c=>c.name==='camera.cancel').args.job_id==='photo-in-progress/real'"), 'Photo cancellation carries the exact job ID');
    await wait("!document.querySelector('.camera-composer button').disabled");
    await evaluate("document.querySelector('.camera-composer select').value='front';document.querySelector('.camera-composer').requestSubmit()");
    await wait("__phoneCalls.some(c=>c.name==='camera.take_photo')");
    assert(await evaluate("__phoneCalls.find(c=>c.name==='camera.take_photo').args.facing==='front' && __phoneCalls.find(c=>c.name==='camera.take_photo').args.subject==='杯子左侧的近景草稿'"), 'Camera sends explicit lens and framing intent, not an arbitrary image prompt');
    assert(await widthOK(), 'Camera stays inside a 375px viewport');

    await openApp('时钟','clock');
    await wait("document.querySelectorAll('.clock-reminder').length===2");
    assert(await evaluate("document.querySelector('.clock-counter').textContent==='00:00:12' && document.querySelector('.clock-now').textContent.includes('2026-09-23')"), 'Clock renders service world time and stopwatch values');
    await evaluate("Array.from(document.querySelectorAll('.clock-reminder')).find(n=>n.textContent.includes('收衣服')).querySelector('button').click()");
    await wait("__phoneCalls.some(c=>c.name==='clock.cancel_reminder')");
    assert(await evaluate("__phoneCalls.find(c=>c.name==='clock.cancel_reminder').args.id==='actual-timer-A/42'"), 'Cancel acts on the real timer ID without asking the user to type it');
    await evaluate("Array.from(document.querySelectorAll('.clock-reminder')).find(n=>n.querySelector('strong').textContent==='喝水').querySelectorAll('button')[1].click()");
    await wait("__phoneCalls.some(c=>c.name==='clock.snooze_reminder')");
    assert(await evaluate("__phoneCalls.find(c=>c.name==='clock.snooze_reminder').args.id==='actual-alarm-B/77' && __phoneCalls.find(c=>c.name==='clock.snooze_reminder').args.duration_seconds===300"), 'Snooze retains the selected alarm identity and sends world seconds');
    await wait("!document.querySelector('.clock-create button').disabled");
    await evaluate("document.querySelector('[aria-label=\"倒计时时长\"]').value='2.5';document.querySelector('[aria-label=\"提醒事项\"]').value='烧水';document.querySelector('.clock-create').requestSubmit()");
    await wait("__phoneCalls.some(c=>c.name==='clock.set_timer')");
    assert(await evaluate("__phoneCalls.find(c=>c.name==='clock.set_timer').args.duration_seconds===150"), 'Timer form converts minutes into the backend duration_seconds contract');
    await evaluate(`Object.assign(__phoneStates.clock,{calendarKind:'custom',timeLine:'星历 3年 27:105',alarmHint:'日含30时、时含120分；按本世界钟点输入。',durationUnits:[{name:'世界秒',seconds:1},{name:'刻',seconds:900},{name:'分',seconds:100}],stopwatch:{elapsedSeconds:1234567.5,running:true,laps:[999999.9]}});`);
    await wait("document.querySelector('[aria-label=\"世界钟点\"]')?.type==='text' && document.querySelector('.clock-counter').textContent.includes('世界秒') && !document.querySelector('.clock-create button').disabled");
    await evaluate(`var units=document.querySelector('[aria-label="时长单位"]');units.value=Array.from(units.options).find(o=>o.textContent==='刻').value;document.querySelector('[aria-label="倒计时时长"]').value='2';document.querySelector('.clock-create').requestSubmit();`);
    await wait("__phoneCalls.filter(c=>c.name==='clock.set_timer').length===2");
    assert(await evaluate("__phoneCalls.filter(c=>c.name==='clock.set_timer')[1].args.duration_seconds===1800"), 'Custom calendar timer uses the actual unit size instead of Earth minutes');
    await wait("!document.querySelectorAll('.clock-create button')[1].disabled");
    await evaluate(`var time=document.querySelector('[aria-label="世界钟点"]');time.value='27:105';time.form.requestSubmit();`);
    await wait("__phoneCalls.some(c=>c.name==='clock.set_alarm')");
    assert(await evaluate("__phoneCalls.find(c=>c.name==='clock.set_alarm').args.time==='27:105'"), 'Custom calendar accepts hours beyond 23 and minutes beyond 59 without browser time input restrictions');
    assert(await widthOK(), 'Clock controls stay inside a 375px viewport');
    assert(await evaluate("!__phoneCalls.some(c=>c.name==='send' || c.confirmSend)"), 'All interaction stays in the mocked phone; no chat send operation is issued');
  } finally {
    await navigate('overview');
    await evaluate("api=__phoneOriginalApi;window.setInterval=__phoneOriginalInterval;delete window.__phoneInput;");
  }
  return 'phone apps: 375px live polling/IME drafts, assistant stream, real image identity, namespaced tools and exact reminder IDs';
}
