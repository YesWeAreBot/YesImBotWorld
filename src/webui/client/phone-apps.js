/** Dedicated phone interfaces. Polling updates output nodes, never replaces the composer. */
(function () {
    var states = { running:'正在回答', preparing:'准备构图', generating:'正在生成照片', saving:'正在保存', completed:'已完成', failed:'未完成', cancelled:'已取消', interrupted:'已中断' };
    function node(tag, cls, text) { return el(tag, { cls:cls || '', text:text == null ? '' : String(text) }); }
    function duration(seconds) { var n=Math.max(0,Math.floor(Number(seconds)||0)); return [Math.floor(n/3600),Math.floor(n%3600/60),n%60].map(function(v){return String(v).padStart(2,'0');}).join(':'); }
    /** Kept mounted while the clock and unread counts update, including during IME input. */
    function mountMuteControls(container, options) {
        var details=node('details','phone-mute-options'),summary=node('summary','','限时免打扰'),presets=node('div','phone-mute-presets'),form=node('form','phone-mute-custom'),input=node('input','phone-app-input'),submit=node('button','phone-app-action','确定'),controls=[],pending=false;
        input.type='number';input.min='1';input.step='1';input.required=true;input.placeholder='自定义世界秒';input.setAttribute('aria-label',options.label+'免打扰世界秒');submit.type='submit';
        function run(seconds){if(pending || !options.available())return;pending=true;update();Promise.resolve().then(function(){return options.run(seconds);}).catch(function(error){options.report?.(error);}).finally(function(){pending=false;update();});}
        [['15 分钟',900],['1 小时',3600],['8 小时',28800],['取消限时',0]].forEach(function(item){var b=node('button','phone-app-action',item[0]);b.type='button';b.dataset.muteSeconds=String(item[1]);b.addEventListener('click',function(){run(item[1]);});controls.push(b);presets.append(b);});
        form.addEventListener('submit',function(event){event.preventDefault();var seconds=Number(input.value);if(Number.isFinite(seconds)&&seconds>0)run(seconds);});
        form.append(input,submit);controls.push(submit);details.append(summary,presets,form,node('p','phone-app-hint','按世界时间计时，到期自动恢复；不改变长期通知开关。'));container.append(details);
        function update(){var custom=options.getState?.()?.calendarKind==='custom';controls.forEach(function(b){b.disabled=pending||!options.available();if(b.dataset.muteSeconds){var seconds=Number(b.dataset.muteSeconds);b.textContent=seconds===0?'取消限时':custom?seconds+' 世界秒':({900:'15 分钟',3600:'1 小时',28800:'8 小时'})[seconds];}});}
        update();return {update:update};
    }
    function mount(kind, container, options) {
        var buttons=[], rows=new Map(), disposed=false, pending=false;
        var heading=node('div','phone-app-heading'), title=node('h2','',options.name), hint=node('p','phone-app-hint');
        heading.append(title,hint); container.append(heading);
        var feedback=node('p','phone-app-feedback'); feedback.setAttribute('role','status');
        function state(){ return options.getState() || {}; }
        function action(tool,args){
            if(pending || !options.available(tool)) return Promise.resolve({executed:false});
            pending=true;update();
            return Promise.resolve().then(function(){return options.run(tool,args || {});}).then(function(result){
                if(disposed || result==null)return {executed:false};
                if(result.ok===false)throw new Error(result.text || result.error || '操作没有完成');
                feedback.textContent=typeof result==='string'?result:result.text || (result.content && result.content.text) || '';
                return {executed:true,result:result};
            }).catch(function(error){if(!disposed){feedback.textContent=error.message || String(error);options.report(error);}return {executed:false};}).finally(function(){pending=false;update();});
        }
        function button(label,tool,args,cls){var b=node('button',cls || 'phone-app-action',label);b.type='button';b.addEventListener('click',function(){action(tool,typeof args==='function'?args():args);});buttons.push({node:b,tool:tool});return b;}
        function field(tag,label,type){var input=node(tag,'phone-app-input');input.setAttribute('aria-label',label);input.placeholder=label;if(type)input.type=type;return input;}
        function submit(form,tool,makeArgs,onSubmit){form.addEventListener('submit',function(event){event.preventDefault();var args=makeArgs();if(!args)return;var complete=onSubmit && onSubmit(args);action(tool,args).then(function(outcome){if(outcome.executed && complete)complete(outcome.result);});});var b=node('button','phone-app-primary','提交');b.type='submit';buttons.push({node:b,tool:tool});form.append(b);return b;}
        var repaint=function(){};
        if(kind==='settings'){
            hint.textContent='管理整部手机和各应用的通知。具体会话的免打扰在聊天应用内设置；闹钟与计时器独立响铃。';
            var timeLine=node('p','phone-app-hint'),modes=node('div','phone-notification-modes'),modeHint=node('p','phone-app-hint'),permissions=node('div','phone-notification-permissions'),modeButtons=[];
            modes.setAttribute('role','group');modes.setAttribute('aria-label','手机通知模式');
            [['vibrate','振动'],['silent','静音'],['off','关闭']].forEach(function(item){var b=button(item[1],'notification_settings',{action:'mode',mode:item[0]});modeButtons.push({node:b,value:item[0]});modes.append(b);});
            container.append(timeLine,node('h3','phone-settings-label','手机通知方式'),modes,modeHint,node('h3','phone-settings-label','应用通知权限'),permissions,feedback);
            repaint=function(){var data=state(),ids=new Set((data.apps||[]).map(function(app){return app.id;}));
                timeLine.textContent=data.timeLine||'';
                modeButtons.forEach(function(b){b.node.setAttribute('aria-pressed',String(data.mode===b.value));});
                modeHint.textContent=data.mode==='off'?'不弹通知；未读消息和角标继续保留。':data.mode==='silent'?'静音时不振动、不主动唤醒；屏幕上的消息仍可见。':'使用振动通知，能否感知取决于手机的位置和状况。';
                rows.forEach(function(row,id){if(!ids.has(id)){row.card.remove();rows.delete(id);}});
                (data.apps||[]).forEach(function(app){var row=rows.get(app.id);if(!row){
                    var card=node('article','phone-notification-permission'),heading=node('div','phone-permission-heading'),label=node('strong'),description=node('p','phone-app-hint'),status=node('p','phone-permission-status');card.dataset.notificationApp=app.id;
                    var toggle=button('','notification_settings',function(){var current=(state().apps||[]).find(function(item){return item.id===app.id;});return {action:'app',app:app.id,enabled:current?.enabled===false};},'phone-permission-toggle');toggle.setAttribute('role','switch');
                    heading.append(label,toggle);card.append(heading,description,status);
                    var mute=mountMuteControls(card,{label:app.name,getState:state,available:function(){return !pending&&options.available('notification_settings');},run:function(seconds){return action('notification_settings',{action:'app',app:app.id,mute_seconds:seconds});},report:options.report});
                    permissions.append(card);row={card:card,label:label,description:description,status:status,toggle:toggle,mute:mute};rows.set(app.id,row);
                }
                    row.label.textContent=app.name;row.description.textContent=app.description||'';row.toggle.textContent=app.enabled===false?'已关闭':'已允许';row.toggle.setAttribute('aria-label',app.name+'通知权限');row.toggle.setAttribute('aria-checked',String(app.enabled!==false));
                    row.status.textContent=app.muted?'限时免打扰 · '+(app.mutedUntilText || '到期自动恢复')+(app.enabled===false?' · 长期通知仍关闭':''):(app.enabled===false?'该应用不弹通知，未读仍保留。':'允许该应用发送通知。');row.status.dataset.muted=String(!!app.muted);row.mute.update();
                });
            };
        } else if(kind==='assistant'){
            hint.textContent='问题与回答只在这个应用里流转。可以切换应用，完成后会收到通知。';
            var toolbar=node('div','phone-app-actions');toolbar.append(button('新对话','new_conversation',{}),button('停止生成','cancel',{}));
            var stream=node('div','assistant-conversation');stream.setAttribute('aria-live','polite');
            var composer=node('form','phone-app-composer'), question=field('textarea','想问些什么？');question.rows=3;question.maxLength=20000;question.required=true;
            var draftRevision=0,composing=false;
            question.addEventListener('input',function(){draftRevision++;});
            question.addEventListener('compositionstart',function(){composing=true;draftRevision++;});
            question.addEventListener('compositionend',function(){composing=false;draftRevision++;});
            composer.append(question);var ask=submit(composer,'ask',function(){
                if(pending || state().busy || composing || !question.value.trim())return null;
                return {question:question.value.trim()};
            },function(args){
                var submitted={text:question.value,revision:draftRevision,jobIds:new Set((state().jobs||[]).map(function(job){return job.id;}))};
                return function(){
                // A successful device call can still report an already-running job. Only a new
                // persisted question proves acceptance; generating the answer may take much longer.
                var accepted=(state().jobs||[]).some(function(job){return !submitted.jobIds.has(job.id) && job.question===args.question;});
                if(accepted && !composing && draftRevision===submitted.revision && question.value===submitted.text)question.value='';
                };
            });ask.textContent='提问';
            container.append(toolbar,stream,composer,feedback);
            repaint=function(){var data=state(), jobs=data.jobs || [], ids=new Set(jobs.map(function(j){return j.id;}));
                rows.forEach(function(row,id){if(!ids.has(id)){row.card.remove();rows.delete(id);}});
                jobs.forEach(function(job){var row=rows.get(job.id);if(!row){var card=node('article','assistant-turn'),q=node('div','assistant-question'),a=node('div','assistant-reply'),status=node('span','phone-job-status'),error=node('p','phone-app-error'); card.append(q,status,a,error);stream.append(card);row={card:card,q:q,a:a,status:status,error:error};rows.set(job.id,row);}
                    row.q.textContent=job.question;row.a.textContent=job.reply || (job.status==='running'?'': '暂无回答');row.status.textContent=(states[job.status]||job.status)+(job.worldTime?' · '+job.worldTime:'');row.status.classList.toggle('phone-job-working',job.status==='running');row.error.textContent=job.error || job.notificationError || '';
                });
                hint.textContent=jobs.length?'独立对话 · '+jobs.length+' 次提问 · 回答是建议，使用前仍需核查':'写草稿、解难题，或聊聊一个新想法。助手知道本世界的时间与历法。';
                ask.disabled=pending || !options.available('ask') || !!data.busy;
            };
        } else if(kind==='camera'){
            hint.textContent='从此刻可见的场景取景。照片由图像模型生成，保存相册后可自行分享。';
            var finder=node('div','camera-viewfinder');finder.innerHTML='<svg viewBox="0 0 240 150" fill="none" aria-hidden="true"><path d="M24 48V24h30m132 0h30v24m0 54v24h-30M54 126H24v-24" stroke="currentColor" stroke-width="2"/><circle cx="120" cy="75" r="34" stroke="currentColor"/><path d="m103 46 34 58m-47-46h61m-62 36 31-53m-1 68 33-56" stroke="currentColor" opacity=".5"/></svg>';
            var form=node('form','camera-composer'),facing=field('select','镜头');[['rear','后置 · 眼前场景'],['front','前置 · 自拍/可见身体']].forEach(function(v){var o=node('option','',v[1]);o.value=v[0];facing.append(o);});
            var subject=field('textarea','想拍什么，怎样取景？');subject.rows=2;subject.maxLength=1000;form.append(facing,subject);var shutter=submit(form,'take_photo',function(){return {facing:facing.value,subject:subject.value.trim()};});shutter.textContent='拍摄';
            var photos=node('div','camera-photos');container.append(finder,form,feedback,photos);
            repaint=function(){var data=state(),ids=new Set((data.jobs||[]).map(function(j){return j.id;}));rows.forEach(function(row,id){if(!ids.has(id)){row.card.remove();rows.delete(id);}});(data.jobs||[]).forEach(function(job){var row=rows.get(job.id);if(!row){var card=node('article','camera-photo'),label=node('strong'),status=node('span','phone-job-status'),detail=node('p','phone-app-hint'),image=node('img','camera-photo-image'),cancel=button('取消拍摄','cancel',{job_id:job.id});image.alt='相机生成的照片';image.hidden=true;card.append(label,status,image,detail,cancel);photos.prepend(card);row={card:card,label:label,status:status,detail:detail,image:image,cancel:cancel};rows.set(job.id,row);}
                    row.label.textContent=job.subject;row.status.textContent=states[job.status]||job.status;row.status.classList.toggle('phone-job-working',['preparing','generating','saving'].includes(job.status));row.detail.textContent=job.error || job.notificationError || (job.status==='completed'?'已保存到相册 · '+(job.galleryRef || ''):'');row.cancel.hidden=!['preparing','generating','saving'].includes(job.status);
                    if(job.mediaId && row.image.dataset.media!==String(job.mediaId)){row.image.dataset.media=job.mediaId;row.image.src=options.mediaUrl(job.mediaId);row.image.hidden=false;row.image.onclick=function(){if(window.showImage)showImage('照片',row.image.src);};}
                });shutter.disabled=pending || !options.available('take_photo')||!!data.busy;
            };
        } else if(kind==='clock'){
            hint.textContent='遵循这个世界的历法与时间流速。关掉应用、放下手机，提醒仍然有效。';
            var now=node('div','clock-now'), tabs=node('div','clock-tabs'), timerForm=node('form','clock-create'),quick=node('div','clock-quick');
            tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','时钟功能');quick.setAttribute('aria-label','常用倒计时');
            var amount=field('input','倒计时时长','number'),unit=field('select','时长单位'),label=field('input','提醒事项');
            amount.min='0.001';amount.step='any';amount.value='5';amount.required=true;label.maxLength=200;
            timerForm.append(node('h3','','倒计时'),quick,amount,unit,label);
            var timerSubmit=submit(timerForm,'set_timer',function(){return {duration_seconds:Number(amount.value)*Number(unit.selectedOptions[0]?.dataset.seconds || 1),label:label.value};});timerSubmit.textContent='开始倒计时';
            var alarmForm=node('form','clock-create'),alarmMode=field('select','闹钟设定方式'),time=field('input','世界钟点','time'),alarmLabel=field('input','闹钟事项'),alarmHint=node('p','phone-app-hint');
            [['time','世界钟点'],['tu','绝对世界时刻 TU']].forEach(function(item){var o=node('option','',item[1]);o.value=item[0];alarmMode.append(o);});
            time.required=true;alarmLabel.maxLength=200;alarmForm.append(node('h3','','闹钟'),alarmMode,time,alarmLabel,alarmHint);
            var alarmSubmit=submit(alarmForm,'set_alarm',function(){return Object.assign({label:alarmLabel.value},alarmMode.value==='tu'?{at_tu:Number(time.value)}:{time:time.value});});alarmSubmit.textContent='设定闹钟';
            var stopwatch=node('section','clock-stopwatch'),counter=node('output','clock-counter','00:00:00'),controls=node('div','phone-app-actions'),laps=node('p','phone-app-hint');
            [['开始/继续','start'],['暂停','pause'],['计次','lap'],['归零','reset']].forEach(function(x){controls.append(button(x[0],'stopwatch',{action:x[1]}));});stopwatch.append(node('h3','','秒表'),counter,controls,laps);
            var reminders=node('div','clock-reminders'),unitsStamp='',tabButtons=[],panels=[timerForm,alarmForm,stopwatch];container.append(now,tabs,timerForm,alarmForm,stopwatch,feedback,node('h3','','提醒列表'),reminders);
            [['timer','倒计时'],['alarm','闹钟'],['stopwatch','秒表']].forEach(function(item,index){var tab=node('button','clock-tab',item[1]);tab.type='button';tab.dataset.clockTab=item[0];tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(index===0));panels[index].hidden=index!==0;tab.addEventListener('click',function(){panels.forEach(function(panel,i){panel.hidden=i!==index;tabButtons[i].setAttribute('aria-selected',String(i===index));});});tabButtons.push(tab);tabs.append(tab);});
            function elapsed(value){return state().calendarKind==='custom'?(Math.max(0,Number(value)||0).toFixed(1)+' 世界秒'):duration(value);}
            function chosenDuration(){return Number(amount.value)*Number(unit.selectedOptions[0]?.dataset.seconds || 1);}
            function chosenLabel(){return amount.value+' '+(unit.selectedOptions[0]?.textContent||'世界秒');}
            function alarmInput(){var kind=alarmMode.value==='tu'?'number':state().calendarKind==='custom'?'text':'time';if(time.type!==kind)time.type=kind;time.step=kind==='time'?'60':'any';time.placeholder=alarmMode.value==='tu'?'未来世界时刻 TU':'按本世界历法填写时:分';time.setAttribute('aria-label',alarmMode.value==='tu'?'未来世界时刻 TU':'世界钟点');}
            alarmMode.addEventListener('change',alarmInput);amount.addEventListener('input',function(){repaint();});unit.addEventListener('change',function(){repaint();});
            repaint=function(){
                var data=state(), sw=data.stopwatch||{},ids=new Set((data.reminders||[]).map(function(r){return r.id;}));
                rows.forEach(function(row,id){if(!ids.has(id)){row.card.remove();rows.delete(id);}});
                now.textContent=data.timeLine||'正在读取世界时钟…';
                var units=data.durationUnits||[{name:'世界秒',seconds:1},{name:'分钟',seconds:60},{name:'小时',seconds:3600}],stamp=JSON.stringify(units);
                if(stamp!==unitsStamp){var previous=unit.selectedOptions[0]?.textContent;unitsStamp=stamp;unit.replaceChildren();units.forEach(function(u,i){var o=node('option','',u.name);o.value=String(i);o.dataset.seconds=String(u.seconds);unit.append(o);});var selectedUnit=units.find(function(u){return u.name===previous;})||units.find(function(u){return u.name==='分钟'||u.name==='分';})||units[0];if(selectedUnit)unit.value=String(units.indexOf(selectedUnit));quick.replaceChildren();var quickUnit=units.find(function(u){return u.name==='分钟'||u.name==='分';})||units[0];if(quickUnit)[1,5,10,25].forEach(function(n){var preset=node('button','phone-app-action',n+' '+quickUnit.name);preset.type='button';preset.addEventListener('click',function(){amount.value=String(n);unit.value=String(units.indexOf(quickUnit));repaint();});quick.append(preset);});}
                alarmInput();alarmHint.textContent=data.alarmHint||'世界钟点，不使用设备所在时区重新解释。';
                counter.textContent=elapsed(sw.elapsedSeconds);laps.textContent=(sw.laps||[]).map(function(n,i){return '第 '+(i+1)+' 圈 '+elapsed(n);}).join(' · ');
                (data.reminders||[]).forEach(function(reminder){
                    var row=rows.get(reminder.id);
                    if(!row){var card=node('article','clock-reminder'),name=node('strong'),status=node('p','phone-app-hint'),actions=node('div','phone-app-actions'),cancel=button('取消','cancel_reminder',{id:reminder.id}),snooze=button('延后','snooze_reminder',function(){return {id:reminder.id,duration_seconds:chosenDuration()};});actions.append(cancel,snooze);card.append(name,status,actions);reminders.prepend(card);row={card:card,name:name,status:status,cancel:cancel,snooze:snooze};rows.set(reminder.id,row);}
                    row.name.textContent=reminder.label||(reminder.kind==='alarm'?'闹钟':'倒计时');var scheduled=reminder.status==='scheduled';row.status.textContent=scheduled?'剩余 '+elapsed(Math.max(0,reminder.dueTU-Number(data.nowTU||0))*Number(data.secondsPerTU||1)):(reminder.status==='fired'?'已响铃':'已取消');row.cancel.hidden=!scheduled;row.snooze.hidden=reminder.status==='cancelled';row.snooze.textContent='延后 '+chosenLabel();
                });
            };
        }
        function update(){if(disposed)return;buttons=buttons.filter(function(b){return b.node.isConnected;});buttons.forEach(function(b){b.node.disabled=pending || !options.available(b.tool);});repaint();}
        update();return {update:update,dispose:function(){disposed=true;rows.clear();}};
    }
    window.StudioPhoneApps={mount:mount,mountMuteControls:mountMuteControls};
})();
