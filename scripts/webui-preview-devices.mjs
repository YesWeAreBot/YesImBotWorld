/** Local, memory-only UI fixtures. Never invokes the world, a platform, a shell, or a network API. */
export function createDeviceFixture() {
  let paused = false, app = null, phoneDown = false, computerOn = false, channelKey = null;
  let appView = null, computerView = null, nextId = 3;
  const clone = value => JSON.parse(JSON.stringify(value));
  const apps = [
    { id:'chat', name:'消息', kind:'chat', description:'开发预览中的本地消息盒。不会连接或发送到聊天平台。' },
    { id:'weather', name:'天气', kind:'app', description:'开发样本：天气界面的布局验证。' },
    { id:'browser', name:'浏览器', kind:'app', description:'开发样本：阅读器与工具返回值验证。不请求外部网页。' },
    { id:'notes', name:'记事本', kind:'app', description:'记录在当前预览进程的内存中，关闭预览后消失。' },
    { id:'news', name:'新闻', kind:'app', description:'开发样本：新闻界面的布局验证。' },
    { id:'studio_mcp', name:'创意工具', kind:'app', description:'开发样本 MCP：验证类型、枚举和结构化参数表单。' },
  ];
  const notes = [
    {title:'关于这个预览',content:'这是本地开发预览。\n所有内容都是用于界面测试的开发样本。\n笔记写入、消息发送、工具执行都只改变内存，不触及运行中的世界。'},
    {title:'一些界面想法',content:'让设备有各自的性格。\n\n手机：随身而轻盈。\n电脑：有空间，也有工具。'},
  ];
  const channels = [
    {key:'fixture:studio',platform:'fixture',channelId:'本地工作室',selfId:'preview-bot',isDirect:false,participants:[{userId:'dev',username:'开发者'},{userId:'preview-bot',username:'预览 Bot'}]},
    {key:'fixture:quiet',platform:'fixture',channelId:'空白会话',selfId:'preview-bot',isDirect:true,participants:[{userId:'tester',username:'测试会话'}]},
  ];
  const messages = [
    {id:1,messageId:'fixture-1',channelKey:'fixture:studio',userId:'dev',username:'开发者',content:'这是设备界面的本地预览。这里的发送操作不会离开这个页面背后的内存。',timestamp:'2026-01-01T09:30:00+08:00',self:false},
    {id:2,messageId:'fixture-2',channelKey:'fixture:studio',userId:'preview-bot',username:'预览 Bot',content:'可以试试会话切换、笔记编辑，以及不同应用的布局。',timestamp:'2026-01-01T09:31:00+08:00',self:true},
  ];
  function tool(name, description, properties = {}, required = [], effect = 'action', device = 'phone') {
    return {name,description,signature:name+'(...)',inputSchema:{type:'object',properties,required,additionalProperties:false},device,effect};
  }
  const string = description => ({type:'string',description});
  const number = description => ({type:'integer',minimum:1,description});
  function tools() {
    const core = [tool('open_app','打开应用',{name:string('应用 ID')},['name']),tool('close_app','关闭当前应用'),tool('pick_up_phone','拿起手机'),tool('put_down_phone','放下手机'),tool('open_computer','打开预览电脑',{},[],'action','computer'),tool('close_computer','关闭预览电脑',{},[],'action','computer')];
    if (computerOn) core.push(tool('run_command','开发样本：仅回显文本，不运行真实命令',{command:string('命令文本')},['command'],'action','computer'));
    const byApp = {
      chat:[tool('check_msg','查看消息列表',{n:number('数量')},[],'read'),tool('select_channel','进入会话',{id:string('频道 key')},['id'],'read'),tool('read_channel','读取消息',{n:number('数量')},[],'read'),...(channelKey?[tool('send','向本地内存发送消息',{msg:string('消息'),id:string('频道')},['msg'],'send')]:[])],
      weather:[tool('query_weather','查询开发天气样本',{city:string('城市或地区')},[],'read')],
      browser:[tool('search','搜索开发样本',{query:string('搜索词')},['query'],'read'),tool('open_url','打开开发样本文档',{url:string('网址')},['url'],'read'),tool('open_link','打开编号链接',{n:number('链接编号')},['n'],'read'),tool('go_back','返回'),tool('scroll_down','下一屏'),tool('screenshot','截图：开发预览不生成截图')],
      notes:[tool('list_notes','列出笔记',{},[],'read'),tool('view_note','查看笔记',{title:string('标题')},['title'],'read'),tool('write_note','写笔记',{title:string('标题'),content:string('正文')},['title','content']),tool('edit_note','修改笔记',{title:string('原标题'),new_title:string('新标题'),content:string('正文')},['title']),tool('delete_note','删除笔记',{title:string('标题')},['title'])],
      news:[tool('headlines','查看开发头条',{n:number('数量')},[],'read'),tool('search_news','搜索开发新闻',{keyword:string('关键词')},['keyword'],'read'),tool('open_news','打开开发文章',{n:number('编号')},['n'],'read')],
      studio_mcp:[tool('compose_palette','把结构化参数作为开发样本回显',{title:{type:'string',title:'作品名称'},style:{type:'string',enum:['自然','明亮','安静'],default:'自然'},count:{type:'integer',minimum:1,maximum:8,default:3},include_notes:{type:'boolean',default:true},colors:{type:'array',items:{type:'string'},description:'颜色名称数组，例如 ["苔绿", "暖白"]'},options:{type:'object',properties:{contrast:{type:'number',minimum:0,maximum:1,default:0.5}}}},['title','style'])],
    };
    return core.concat(byApp[app] || []);
  }
  function snapshot() {
    return clone({running:true,control:{paused,busy:false,deviceBusy:false,attention:null},devices:{computer:{effectiveMode:'docker',mode:'docker',on:computerOn?'开发终端':null,docker:{exists:true,running:computerOn,status:computerOn?'running':'stopped',name:'开发预览 · 内存模拟',image:'仅布局测试 / 不创建 Docker 容器'},remote:null},phone:{down:phoneDown,appOpen:app && app!=='chat'?apps.find(a=>a.id===app)?.name:null,chatOpen:app==='chat',channelKey,channelIsGroup:channelKey==='fixture:studio',chatAppName:'消息',resolution:{width:390,height:754}}},apps:apps.map(a=>({...a,active:a.id===app})),tools:tools(),appView,computerView,chat:{channelKey,channels:channels.map(c=>({...c,latest:messages.filter(m=>m.channelKey===c.key).at(-1)})),messages:messages.filter(m=>m.channelKey===channelKey)}});
  }
  const headlines = '开发样本 · 本地预览资讯\n\n[1] 设备工作台界面进入交互验证\n暖白工作室、手机应用与终端布局现在可以在本地预览。\n\n[2] 所有样本工具只在内存中运行\n这个测试不会启动模型，也不会向外部发送消息。';
  function result(text, name) {
    if (name==='run_command') computerView={lastTool:name,result:text};
    else if (app) appView={id:app,name:apps.find(a=>a.id===app)?.name || app,lastTool:name,result:text};
    return {ok:true,text};
  }
  return {
    session:snapshot,
    notes:() => ({notes:clone(notes)}),
    control:body => {paused=!!body.paused;return {ok:true,paused,busy:false,text:paused?'已接管本地开发样本设备。':'已交还本地开发样本设备。'};},
    async tool(body) {
      const mode = body.mode ?? 'takeover';
      if (!['stealth','takeover'].includes(mode)) return {ok:false,text:'未知设备操作模式。'};
      if (mode === 'takeover' && !paused) return {ok:false,text:'请先强制接管本地预览设备。'};
      if (mode === 'stealth' && ['pick_up_phone','put_down_phone','pick_media'].includes(body.name)) return {ok:false,text:'偷偷操作不能代替角色身体动作或接续其草稿。'};
      const name=body.name,args=body.args || {};
      if (!tools().some(t=>t.name===name)) return {ok:false,text:'当前工具不可用。'};
      if (name==='send' && !body.confirmSend) return {ok:false,text:'请明确点击发送。'};
      switch(name) {
        case 'open_app': {
          const found=apps.find(a=>a.id===args.name || a.name===args.name);
          if(!found)return {ok:false,text:'没有这个预览应用。'};
          app=found.id;phoneDown=false;if(app!=='chat')channelKey=null;
          const opening=app==='news'?headlines:app==='notes'?'开发样本记事本，共 '+notes.length+' 篇笔记。':'开发预览 · '+found.name+'\n请选择一项操作。';
          appView={id:app,name:found.name,opening};return {ok:true,text:opening};
        }
        case 'close_app':app=null;appView=null;channelKey=null;return {ok:true,text:'已关闭预览应用。'};
        case 'pick_up_phone':phoneDown=false;return {ok:true,text:'已拿起预览手机。'};
        case 'put_down_phone':phoneDown=true;app=null;appView=null;channelKey=null;return {ok:true,text:'已放下预览手机。'};
        case 'open_computer':computerOn=true;return {ok:true,text:'开发终端已打开。这是内存模拟，不会创建容器。'};
        case 'close_computer':computerOn=false;return {ok:true,text:'开发终端已关闭。'};
        case 'run_command':return result('开发样本：收到命令文本，未执行真实命令。\n\n'+String(args.command || ''),name);
        case 'check_msg':return result('本地预览共有 '+channels.length+' 个会话。',name);
        case 'select_channel':if(!channels.some(c=>c.key===args.id))return {ok:false,text:'会话不存在。'};channelKey=args.id;return result('已打开本地会话。',name);
        case 'read_channel':return result('已读取内存消息。',name);
        case 'send': {
          const key=args.id || channelKey;if(!channels.some(c=>c.key===key))return {ok:false,text:'请选择会话。'};
          if(!String(args.msg || '').trim())return {ok:false,text:'消息为空。'};
          messages.push({id:nextId,messageId:'fixture-'+nextId++,channelKey:key,userId:'preview-bot',username:'预览 Bot',content:String(args.msg),timestamp:new Date().toISOString(),self:true});return result('已添加到本地内存，未发送到外部平台。',name);
        }
        case 'query_weather':return result('天气 · '+(args.city || '开发样本城市')+'（开发样本）\n现在：多云，23°C（体感 24°C），湿度 62%，风速 8 km/h\n今天：多云，18~25°C，降水概率 20%\n明天：小雨，17~22°C，降水概率 70%\n后天：晴，16~24°C，降水概率 10%',name);
        case 'search':case 'open_url':case 'open_link':return result('开发样本 · 阅读器\n\n'+String(args.query || args.url || '链接 '+args.n)+'\n\n这里是供页面布局验证的本地内容，不是网络搜索结果。\n\n[1] 了解本地开发预览\n[2] 验证真实数据的空白与失败状态',name);
        case 'scroll_down':return result('开发样本 · 下一屏\n\n这段本地内容用于测试长页面的阅读体验。已经到达文档末尾。',name);
        case 'go_back':return result('开发样本 · 返回阅读器首页。',name);
        case 'screenshot':return {ok:false,text:'开发预览没有浏览器截图服务，不生成模拟截图。'};
        case 'list_notes':return result(notes.map(n=>n.title).join('\n') || '还没有笔记。',name);
        case 'view_note':{const note=notes.find(n=>n.title===args.title);return note?result(note.content,name):{ok:false,text:'笔记不存在。'};}
        case 'write_note':if(!args.title || !args.content)return {ok:false,text:'请填写标题和正文。'};if(notes.some(n=>n.title===args.title))return {ok:false,text:'同名笔记已经存在。'};notes.unshift({title:String(args.title),content:String(args.content)});return result('已保存到本地预览内存。',name);
        case 'edit_note':{const note=notes.find(n=>n.title===args.title);if(!note)return {ok:false,text:'笔记不存在。'};if(args.new_title)note.title=String(args.new_title);if(args.content!==undefined)note.content=String(args.content);return result('已更新本地预览笔记。',name);}
        case 'delete_note':{const index=notes.findIndex(n=>n.title===args.title);if(index<0)return {ok:false,text:'笔记不存在。'};notes.splice(index,1);return result('已删除本地预览笔记。',name);}
        case 'headlines':return result(headlines,name);
        case 'search_news':return result('开发样本搜索 · '+String(args.keyword || '')+'\n\n'+headlines,name);
        case 'open_news':return result('开发样本 · 文章 '+String(args.n)+'\n\n每台设备，都应该有自己的生活感。\n\n这篇测试文本只存在于预览脚本中。正式界面会呈现实际世界或真实新闻源返回的内容。',name);
        case 'compose_palette':return result('开发样本 · 参数已通过表单传递\n\n'+JSON.stringify(args,null,2),name);
        default:return {ok:false,text:'开发样本没有实现这个工具。'};
      }
    },
  };
}
