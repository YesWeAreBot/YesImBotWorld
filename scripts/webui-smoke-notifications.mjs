/** Shared notification layers and world-time DND; every mutation stays in this browser fixture. */
export default async function smokeNotifications({ evaluate, wait, assert, navigate, page }) {
  assert(await evaluate("fetch('/api/health').then(r=>r.json()).then(r=>r.preview===true)"), 'Requires isolated preview');
  await navigate('overview');
  await page('Emulation.setDeviceMetricsOverride', { width: 375, height: 1050, deviceScaleFactor: 1, mobile: true });
  await evaluate(`(async function(){window.__notifyApi=api;window.__notifyInterval=window.setInterval;window.__notifyCalls=[];
    window.__notifyBase=await api('GET','/api/device/session');window.__notifyActive=null;window.__notifyChannel=null;window.__notifyClock=100;window.__notifyCalendar='gregorian';
    window.__notifyState={mode:'vibrate',managed:false,appsManaged:false,unread:3,count:2,channels:[{key:'fixture@a:group',unread:2,notifications:2,enabled:true,muted:false,latest:{sender:'甲',preview:'带上昨天那张照片',timestamp:'2026-09-24T12:00:00.000Z'}},{key:'fixture@b:group',unread:1,notifications:0,enabled:false,muted:false,latest:{sender:'乙',preview:'另一账号的同名群',timestamp:'2026-09-24T13:00:00.000Z'}}]};
    window.__notifyApps=[{id:'chat',name:'QQ',description:'聊天与消息',enabled:true,muted:false},{id:'camera',name:'相机',description:'拍摄完成提醒',enabled:true,muted:false}];
    window.__notifySnapshot=function(){var d=structuredClone(__notifyBase);d.running=true;d.control={paused:false,busy:false};d.devices.phone={down:false,chatOpen:__notifyActive==='chat',appOpen:__notifyActive==='settings'?'设置':null};
      d.notifications=Object.assign(structuredClone(__notifyState),{calendarKind:__notifyCalendar});d.apps=[{id:'chat',name:'QQ',kind:'chat',active:__notifyActive==='chat'},{id:'settings',name:'设置',kind:'app',active:__notifyActive==='settings'}];d.appCatalog=d.apps.map(a=>Object.assign({},a,{status:'ready'}));
      d.appView=__notifyActive==='settings'?{id:'settings',state:{mode:__notifyState.mode,appsManaged:false,apps:structuredClone(__notifyApps),nowTU:__notifyClock,secondsPerTU:2,calendarKind:__notifyCalendar,timeLine:'世界时刻 '+__notifyClock}}:null;
      d.chat={channelKey:__notifyChannel,channels:[{key:'fixture@a:group',channelId:'朋友群 A',platform:'fixture',participants:[]},{key:'fixture@b:group',channelId:'朋友群 B',platform:'fixture',participants:[]}],messages:[]};
      d.tools=['open_app','phone_notifications'].concat(__notifyActive==='chat'?['select_channel','channel_notify','read_channel','check_msg','send']:__notifyActive==='settings'?['notification_settings']:[]).map(name=>({name,device:'phone',effect:'action',description:name,inputSchema:{type:'object'}}));return d;};
    window.__notifyMute=function(row,a){if(a.mute_seconds!==undefined){row.muted=a.mute_seconds>0;row.mutedUntil=row.muted?__notifyClock+a.mute_seconds/2:undefined;row.mutedUntilText=row.muted?'世界时刻 '+row.mutedUntil:undefined;}};
    api=async function(method,url,body){if(method==='GET'&&url==='/api/device/session')return __notifySnapshot();
      if(method==='POST'&&url==='/api/device/tool'){__notifyCalls.push(structuredClone(body));var a=body.args||{};
        if(body.name==='open_app')__notifyActive=a.name==='QQ'?'chat':a.name==='settings'?'settings':null;
        else if(body.name==='select_channel')__notifyChannel=a.id;
        else if(body.name==='channel_notify'){var row=__notifyState.channels.find(r=>r.key===a.id);if(a.allow!==undefined)row.enabled=a.allow;__notifyMute(row,a);}
        else if(body.name==='notification_settings'){if(a.action==='mode')__notifyState.mode=a.mode;else if(a.action==='app'){var row=__notifyApps.find(r=>r.id===a.app);if(a.enabled!==undefined)row.enabled=a.enabled;__notifyMute(row,a);}}
        else if(body.name==='phone_notifications'){
          if(a.action==='mode')throw Error('Mode must be managed in Settings');
          if(a.action==='clear'||a.action==='read')__notifyState.channels.filter(r=>!a.id||r.key===a.id).forEach(r=>{r.notifications=0;if(a.action==='read')r.unread=0;});
          __notifyState.unread=__notifyState.channels.reduce((n,r)=>n+r.unread,0);__notifyState.count=__notifyState.channels.reduce((n,r)=>n+r.notifications,0);}
        else throw Error('Unexpected fixture tool '+body.name);return {ok:true,text:'通知操作完成'};}
      return __notifyApi.apply(this,arguments);};window.setInterval=function(fn,ms){return __notifyInterval(fn,ms===5000?70:ms);};})()`);
  const click = async label => {
    const target=`Array.from(document.querySelectorAll('.phone-frame button')).find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)})`;
    await wait(`!!(${target}) && !(${target}).disabled`);
    await evaluate(`(${target}).click()`);
  };
  try {
    await navigate('devices');
    await wait("document.querySelector('[data-notify-badge=unread]')?.textContent==='3'");
    assert(await evaluate("document.querySelector('[data-notify-badge=notifications]').textContent==='2'"), 'Unread and notification badge counts are distinct');
    await click('通知中心'); await wait("!!document.querySelector('.phone-notifications')");
    assert(await evaluate("!document.querySelector('.phone-notification-modes')"), 'Notification center does not expose settings mutations');
    await click('清除全部通知'); await wait("document.querySelector('.phone-notification-summary h2')?.textContent==='0 条通知'");
    assert(await evaluate("__notifyState.unread===3 && document.querySelector('.phone-notification-summary p').textContent.startsWith('3 条未读')"), 'Clearing notifications retains unread messages');
    await click('通知设置'); await wait("!!document.querySelector('.app-settings .phone-notification-permission')");
    assert(await evaluate("document.querySelectorAll('[data-notification-app]').length===2"), 'Settings shows separate installed app notification permissions');
    assert(await evaluate("document.querySelector('.app-settings').textContent.includes('闹钟与计时器独立响铃')"), 'Settings explains alarm and timer independence');
    assert(await evaluate("document.querySelector('[data-notification-app=chat] [data-mute-seconds=\"900\"]').textContent==='15 分钟'"), 'Gregorian presets use familiar minute labels');
    await evaluate("Array.from(document.querySelectorAll('.phone-notification-modes button')).find(n=>n.textContent==='静音').click()");
    await wait("__notifyState.mode==='silent' && document.querySelector('.phone-notification-modes button[aria-pressed=true]')?.textContent==='静音'");
    assert(await evaluate("document.querySelector('.app-settings').textContent.includes('不主动唤醒')"), 'Settings explains silent behavior');
    assert(await evaluate("!document.querySelector('[data-notification-app=chat] [role=switch]').disabled"), 'Administrator can change settings even when Bot permission is disabled');
    await evaluate("document.querySelector('[data-notification-app=chat] [role=switch]').click()");
    await wait("__notifyApps[0].enabled===false");
    assert(await evaluate("__notifyApps[1].enabled===true"), 'Changing one app does not affect another app');
    await evaluate("document.querySelector('[data-notification-app=chat] .phone-mute-options').open=true;document.querySelector('[data-notification-app=chat] [data-mute-seconds=\"3600\"]').click()");
    await wait("__notifyApps[0].muted && document.querySelector('[data-notification-app=chat] .phone-permission-status').textContent.includes('世界时刻 1900')");
    assert(await evaluate("__notifyApps[0].enabled===false"), 'Timed DND does not overwrite persistent permissions');
    await evaluate("window.__notifyDraft=document.querySelector('[data-notification-app=chat] .phone-mute-custom input');__notifyDraft.value='1234';__notifyDraft.focus();__notifyClock++;__notifyCalendar='custom'");
    await wait("document.querySelector('.app-settings').textContent.includes('世界时刻 101')");
    assert(await evaluate("document.querySelector('[data-notification-app=chat] .phone-mute-custom input')===__notifyDraft && __notifyDraft.value==='1234' && document.activeElement===__notifyDraft"), 'Settings polling preserves focused duration input and draft');
    assert(await evaluate("[900,3600,28800].every(n=>document.querySelector('[data-notification-app=chat] [data-mute-seconds=\"'+n+'\"]').textContent===n+' 世界秒')"), 'Custom calendars do not assume Gregorian minute or hour lengths');
    await evaluate("__notifyDraft.form.requestSubmit()"); await wait("__notifyApps[0].mutedUntil===718");
    await evaluate("document.querySelector('[data-notification-app=chat] [data-mute-seconds=\"0\"]').click()"); await wait("__notifyApps[0].muted===false");
    assert(await evaluate("__notifyApps[0].enabled===false"), 'Cancelling timed DND retains permanent off');
    assert(await evaluate("document.documentElement.scrollWidth<=375 && innerWidth<=375"), 'Settings fits mobile viewport');
    await click('通知中心'); await wait("!!document.querySelector('.phone-notifications')");
    const openChannelA = "Array.from(document.querySelectorAll('.phone-notification-card')).find(n=>n.querySelector('.phone-notification-card-title strong')?.textContent==='朋友群 A')?.querySelector('button[aria-label=\"打开会话\"]')";
    await wait(`!!(${openChannelA}) && !(${openChannelA}).disabled`);await evaluate(`(${openChannelA}).click()`);
    await wait("__notifyChannel==='fixture@a:group' && !!document.querySelector('.app-chat-channels')");
    assert(await evaluate("__notifyCalls.some(c=>c.name==='open_app'&&c.args.name==='QQ') && __notifyCalls.some(c=>c.name==='select_channel'&&c.args.id==='fixture@a:group')"), 'Opening a notification uses configured chat display name and exact channel');
    await evaluate("document.querySelector('.app-channel-notify').open=true;document.querySelector('.app-channel-notify .phone-mute-options').open=true;document.querySelector('.app-channel-notify [data-mute-seconds=\"900\"]').click()");
    await wait("__notifyState.channels[0].muted===true");
    await wait("document.querySelector('.app-chat-channel-active .app-channel-muted')?.textContent==='静'");
    assert(await evaluate("document.querySelector('.app-channel-notify [data-mute-seconds=\"900\"]').textContent==='900 世界秒'"), 'Channel presets also respect custom calendars');
    assert(await evaluate("__notifyState.channels[0].enabled===true && !__notifyState.channels[1].muted"), 'Channel timed DND leaves persistent permission and other accounts unchanged');
    await evaluate("window.__channelDraft=document.querySelector('.app-channel-notify input');__channelDraft.value='777';__channelDraft.focus();__notifyState.channels[0].unread++;__notifyState.unread++");
    await wait("document.querySelector('.app-chat-channel-active .phone-unread-badge')?.textContent==='3'");
    assert(await evaluate("document.querySelector('.app-channel-notify input')===__channelDraft && document.activeElement===__channelDraft && __channelDraft.value==='777'"), 'Incoming messages do not recreate channel DND inputs or reopen IME');
    await click('关闭会话通知'); await wait("__notifyState.channels[0].enabled===false");
    await wait("!document.querySelector('.app-channel-notify [data-mute-seconds=\"0\"]').disabled");
    await evaluate("document.querySelector('.app-channel-notify [data-mute-seconds=\"0\"]').click()"); await wait("!__notifyState.channels[0].muted");
    assert(await evaluate("!__notifyState.channels[0].enabled"), 'Cancelling channel timed mute preserves permanent off');
    await click('标为已读'); await wait("__notifyState.channels[0].unread===0");
    assert(await evaluate("__notifyState.channels[1].unread===1"), 'Mark read preserves another account');
    assert(await evaluate("document.documentElement.scrollWidth<=375 && innerWidth<=375"), 'Chat notification controls remain within mobile viewport');
    await click('通知中心'); await wait("document.querySelector('.phone-notification-summary p')?.textContent.startsWith('1 条未读')");
    await evaluate("__notifyState.channels[1].muted=true;__notifyState.channels[1].mutedUntilText='架空历第三夜'");
    await wait("document.querySelector('.phone-notification-card small')?.textContent.includes('免打扰至 架空历第三夜')");
    assert(await evaluate("!document.querySelector('.phone-notification-modes') && Array.from(document.querySelectorAll('.phone-notification-actions button')).some(n=>n.textContent==='全部标为已读'&&!n.disabled)"), 'Notification center retains read/clear controls without policy editing');
    return 'notifications: system Settings, independent app/channel permissions, world-time/custom-calendar DND, muted indicators, admin control, preserved inputs, names and mobile layout';
  } finally {
    await navigate('overview');
    await evaluate("api=__notifyApi;window.setInterval=__notifyInterval;delete window.__notifyApi;delete window.__notifyInterval;");
    await page('Emulation.clearDeviceMetricsOverride');
  }
}
