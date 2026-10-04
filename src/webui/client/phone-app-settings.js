/* App setup is administrative configuration, independent of device ownership or world state. */
(function () {
    'use strict';
    function at(value, path) { return path.split('.').reduce(function (v, key) { return v && v[key]; }, value); }
    function put(value, path, next) { var keys=path.split('.'), target=value; keys.slice(0,-1).forEach(function(key){if(!target[key] || typeof target[key]!=='object')target[key]={};target=target[key];});target[keys[keys.length-1]]=next; }
    var titles={camera:'相机设置',assistant:'助手设置',clock:'时钟设置',browser:'浏览器设置'};
    var protocols=[['chat-completions','OpenAI Chat Completions'],['responses','OpenAI Responses'],['anthropic','Anthropic Messages']];
    function protocolName(value){var entry=protocols.find(function(item){return item[0]===(value||'chat-completions');});return entry?entry[1]:value;}
    async function open(id, onSaved) {
        if(!titles[id] || isVisitor())return;
        var body=el('div',{cls:'phone-app-settings-loading',text:'正在读取应用设置…'});
        showModal(titles[id],body);
        try {
            var response=await api('GET','/api/config');
            if(!body.isConnected)return;
            if(response.error)throw new Error(response.error);
            var config=response.value || {}, dirty=new Map(), inputs={}, busy=false;
            var form=el('form',{cls:'phone-app-settings'}), fields=el('fieldset',{cls:'phone-app-settings-fields'}), notice=el('p',{cls:'phone-app-settings-note',text:'设置只影响这个应用。保存会应用配置并重启插件；不会自动拍摄、提问或操作设备。'}), feedback=el('p',{cls:'phone-app-settings-feedback',role:'status'});
            form.append(notice,fields,feedback);body.replaceChildren(form);
            function field(path,label,type,fallback,hint,parent,choices){
                var value=at(config,path);if(value===undefined)value=fallback;
                var wrap=el('label',{cls:'phone-app-setting'+(type==='checkbox'?' phone-app-setting-toggle':'')}), name=el('span',{text:label}), input=el(type==='select'?'select':type==='textarea'?'textarea':'input',{name:path,'aria-label':label,cls:'phone-app-input'});
                if(type==='select'){choices.forEach(function(item){input.appendChild(el('option',{value:item[0],text:item[1]}));});input.value=value;}
                else if(type==='checkbox'){input.type='checkbox';input.checked=!!value;}
                else {if(type!=='textarea')input.type=type || 'text';input.value=Array.isArray(value)?value.join('\n'):value==null?'':String(value);if(type==='password'){input.autocomplete='new-password';input.spellcheck=false;}if(type==='textarea')input.rows=3;}
                function changed(){var next=type==='checkbox'?input.checked:type==='number'?Number(input.value):type==='textarea'?input.value.split('\n').map(function(v){return v.trim();}).filter(Boolean):input.value;dirty.set(path,next);}
                input.addEventListener('input',changed);input.addEventListener('change',changed);inputs[path]=input;
                wrap.append(name,input);if(hint)wrap.appendChild(el('small',{text:hint}));(parent||fields).append(wrap);return input;
            }
            function modelFields(group,parent){
                var protocol=group==='apps.camera'?null:field(group+'.apiType','API 协议','select','chat-completions','选择服务提供的对话 API；与模型名称独立。',parent,protocols);
                var endpoint=field(group+'.baseURL','服务地址','url','https://api.openai.com/v1',protocol?'可填根地址、/v1 或完整生成地址；OpenAI 例 https://api.openai.com/v1，Anthropic 例 https://api.anthropic.com。':'图片生成使用 OpenAI 兼容 /images/generations；地址需含 /v1（若服务要求）。',parent);
                var key=field(group+'.apiKey','API Key','password','','已保存的密钥显示为掩码；不修改就会保留，清空则删除。',parent);
                var model=field(group+'.model','模型名称','text','','可以直接输入，也可以从服务获取。',parent);
                var row=el('div',{cls:'phone-app-model-picker'}), fetchButton=el('button',{type:'button',cls:'phone-app-action','data-app-models':group,text:'获取模型列表'}), list=el('select',{cls:'phone-app-input','aria-label':'可用模型',hidden:true}), message=el('small',{role:'status'});
                fetchButton.addEventListener('click',async function(){fetchButton.disabled=true;message.textContent='正在读取模型列表…';try{var result=await api('POST','/api/llm/models',{baseURL:endpoint.value,apiKey:key.value,apiType:protocol?protocol.value:'chat-completions',group:group});if(!form.isConnected)return;if(result.error)throw new Error(result.error);var models=result.models||[];list.replaceChildren(el('option',{value:'',text:'选择模型…'}));models.forEach(function(item){var name=typeof item==='string'?item:item.id;if(name)list.appendChild(el('option',{value:name,text:name}));});list.hidden=!models.length;message.textContent=models.length?'返回 '+models.length+' 个模型；也可以继续手动填写。':'没有返回模型，请手动填写。';}catch(error){message.textContent=error.message||String(error);}finally{fetchButton.disabled=false;}});
                list.addEventListener('change',function(){if(!list.value)return;model.value=list.value;model.dispatchEvent(new Event('input',{bubbles:true}));});row.append(fetchButton,list,message);parent.append(row);
            }
            if(id==='camera'){
                field('apps.camera.enabled','启用相机','checkbox',false);
                fields.appendChild(el('p',{cls:'phone-app-settings-note',text:'先由世界整理角色可见的取景信息，再使用下面的图像模型生成照片。照片保存在相册，不会自动发给其他人。'}));
                modelFields('apps.camera',fields);
                field('apps.camera.size','图片尺寸','text','1024x1024','例如 1024x1024；以图像模型实际支持的尺寸为准。');
                field('apps.camera.quality','图片质量','text','','留空使用服务默认值。');
            } else if(id==='assistant'){
                field('apps.assistant.enabled','启用助手','checkbox',false);
                field('apps.assistant.name','应用名称','text','小助手');
                var mode=field('apps.assistant.mode','使用的模型','select','inherit','',null,[['inherit','借用 World 模型'],['independent','使用独立模型']]);
                var inherited=el('p',{cls:'phone-app-settings-note'}), independent=el('fieldset',{cls:'phone-app-independent'});independent.appendChild(el('legend',{text:'独立模型'}));fields.append(inherited,independent);
                modelFields('apps.assistant',independent);
                var temperature=field('apps.assistant.temperature','温度','number',0.7,'仅 Chat Completions 发送；Responses / Anthropic 使用模型默认温度。',independent);temperature.min='0';temperature.max='2';temperature.step='0.05';
                var tokens=field('apps.assistant.maxTokens','回答 Token 上限','number',4096,'',independent);tokens.min='128';tokens.max='65536';tokens.step='1';
                field('apps.assistant.disableThinking','禁用模型思考','checkbox',false,'',independent);field('apps.assistant.stream','流式显示回答','checkbox',true,'',independent);
                function modelMode(){independent.hidden=mode.value!=='independent';independent.disabled=independent.hidden;inherited.hidden=mode.value!=='inherit';inherited.textContent=config.world&&config.world.model?'当前借用：'+config.world.model+' · '+protocolName(config.world.apiType)+'。协议与密钥随 World 配置；助手的对话单独保存，不会读取角色的私密思考。':'World 模型尚未配置，请先到配置页填写 World 模型。';}mode.addEventListener('change',modelMode);modelMode();
            } else if(id==='clock'){
                field('apps.clockEnabled','启用时钟','checkbox',true);
                fields.appendChild(el('p',{cls:'phone-app-settings-note',text:'时钟无需配置模型。倒计时、闹钟和秒表跟随本世界的时间与历法；关闭应用后仍可提醒。'}));
            } else if(id==='browser'){
                field('apps.browserEnabled','启用浏览器','checkbox',true);
                field('apps.browserHomeURL','现实互联网首页','text','portal','填 portal 使用内置导航页，也可以填写完整网址。架空世界始终使用本世界互联网。');
                field('apps.browserSearchURL','默认搜索入口','url','https://www.bing.com/search?q=%s','用 %s 代表搜索词，仅用于现实互联网。');
                field('apps.browserSearchFallbackURLs','其他搜索入口','textarea',[],'每行一个带 %s 的搜索网址，失败时可手动切换。');
                field('apps.browserAutoScreenshot','自动附上网页截图','checkbox',true,'DOM 操作不依赖截图；图像还需模型支持。');
            }
            var actions=el('div',{cls:'phone-app-settings-actions'}), cancel=el('button',{type:'button',cls:'phone-app-action',text:'取消',onclick:hideModal}), save=el('button',{type:'submit',cls:'phone-app-primary','data-app-settings-save':'',text:'保存并应用'});actions.append(cancel,save);form.append(actions);
            form.addEventListener('submit',async function(event){event.preventDefault();if(busy)return;if(!dirty.size){hideModal();return;}busy=true;fields.disabled=true;save.disabled=true;cancel.disabled=true;feedback.textContent='正在读取最新配置并保存…';try{
                var latest=await api('GET','/api/config');if(latest.error)throw new Error(latest.error);if(!latest.value)throw new Error('未能读取最新配置，尚未保存。');
                var merged=JSON.parse(JSON.stringify(latest.value));dirty.forEach(function(value,path){put(merged,path,value);});
                var result=await api('POST','/api/config',{config:merged});if(result.error || result.ok===false)throw new Error(result.error||result.message||'保存失败');
                hideModal();toast(result.message||'配置已保存并应用，插件正在重启。','ok');if(onSaved)onSaved();
            }catch(error){feedback.textContent=error.message||String(error);}finally{busy=false;fields.disabled=false;save.disabled=false;cancel.disabled=false;}});
        } catch(error){if(body.isConnected)body.replaceChildren(el('p',{cls:'phone-app-error',text:error.message||String(error)}));}
    }
    window.StudioPhoneAppSettings={open:open};
})();
