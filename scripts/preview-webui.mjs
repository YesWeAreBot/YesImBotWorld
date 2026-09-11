/** Isolated WebUI development server. All mutations affect in-memory sample data only. */
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import { createDeviceFixture } from './webui-preview-devices.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.NODE_PATH = join(root, 'node_modules');
Module._initPaths();
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [dirname(require.resolve('pkgroll/package.json'))] }));
const temporary = await mkdtemp(join(tmpdir(), 'world-studio-preview-'));
const configModule = join(temporary, 'config.cjs');
await build({ stdin: { contents: 'export { Config } from "./src/config.ts"; export { introspect } from "./src/webui/schema.ts";', resolveDir: root, loader: 'ts' }, outfile: configModule, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { koishi: require.resolve('koishi') }, logLevel: 'warning' });
const { Config, introspect } = require(configModule);
let config = Config({ autoStart: false });
const fixture = createDeviceFixture();
const now = Date.now(), at = 4268;
const attr = (value, visibility = 'public') => ({ value, visibility });
const entities = {
  home: { id: 'home', name: '林间小屋', kind: 'place', location: null, revision: 1, attributes: { lighting: attr('morning'), temperature: attr(23) } },
  studio: { id: 'studio', name: '窗边工作室', kind: 'place', location: 'home', revision: 3, attributes: { light: attr('soft'), window: attr('open') } },
  garden: { id: 'garden', name: '小花园', kind: 'place', location: 'home', revision: 1, attributes: { weather: attr('clear') } },
  bot: { id: 'bot', name: '小澈', kind: 'actor', controller: 'bot', location: 'studio', revision: 8, attributes: { posture: attr('坐在窗边'), energy: attr(82, 'owner'), hunger: attr(16, 'owner'), health: attr(100, 'owner') } },
  friend: { id: 'friend', name: '阿青', kind: 'actor', controller: 'world', location: 'garden', revision: 2, attributes: { posture: attr('照料植物'), shirt: attr('linen') } },
  desk: { id: 'desk', name: '橡木书桌', kind: 'object', location: 'studio', revision: 1, attributes: { material: attr('oak') } },
  phone: { id: 'phone', name: '手机', kind: 'object', location: 'bot', owner: 'bot', revision: 4, attributes: { battery: attr(76), powered: attr(true) } },
  cup: { id: 'cup', name: '温热的茶', kind: 'object', location: 'desk', owner: 'bot', revision: 3, attributes: { temperature: attr(52), volume: attr(180) } },
  notebook: { id: 'notebook', name: '绿色笔记本', kind: 'object', location: 'desk', owner: 'bot', revision: 2, attributes: { pages: attr(42), content: attr('开发样本：明天去花园看看。', 'owner') } },
  plant: { id: 'plant', name: '窗台绿植', kind: 'object', location: 'studio', revision: 1, attributes: { watered: attr(true) } }
};
const snapshot = { schemaVersion: 1, sequence: 28, effectiveAt: at, entities, actions: {
  action_1: { id: 'action_1', actorId: 'bot', intent: '端起桌上的茶杯', targetIds: ['cup'], status: 'completed', startedAt: at - 180, finishedAt: at - 177, targetVersions: { cup: 2 } },
  action_2: { id: 'action_2', actorId: 'bot', intent: '读一页笔记，想想今天的安排', targetIds: ['notebook'], status: 'pending', startedAt: at - 4, expectedEnd: at + 30, targetVersions: { notebook: 2 } },
  action_3: { id: 'action_3', actorId: 'friend', intent: '给花园中的植物浇水', targetIds: [], status: 'completed', startedAt: at - 95, finishedAt: at - 55, targetVersions: {} }
} };
const events = Array.from({ length: 14 }, (_, i) => ({ id: 'event_' + i, kind: 'event', topic: i % 4 === 0 ? 'world.speech' : 'world.committed', source: i % 3 ? 'action' : 'evolve', actorId: i % 3 ? 'bot' : 'friend', correlationId: 'turn_' + Math.floor(i / 2), ...(i % 2 ? { causationId: 'event_' + (i - 1) } : {}), sequence: i * 2 + 1, effectiveAt: at - 14 * 45 + i * 45, emittedAt: now - 14 * 45000 + i * 45000, priority: 5, payload: i % 4 === 0 ? { speakerId: 'friend', text: ['早上好，今天花园里的光线很好。','茶已经泡好了。','午后一起去走走吧。','这株新叶终于长出来了。'][i / 4] } : { changedEntityIds: i % 3 ? ['bot','cup'] : ['friend','plant'], actionIds: [] } }));
const evidence = [
  { eventId: 'observed_1', actorId: 'bot', source: 'world', observedAt: at - 360, text: '阿青把刚泡好的茶放在桌上，提醒我杯子还很烫。', rootEventIds: ['event_0'] },
  { eventId: 'observed_2', actorId: 'bot', source: 'world', observedAt: at - 250, text: '我在笔记本中写下明天下午去花园散步的约定。', rootEventIds: ['event_2'] },
  { eventId: 'observed_3', actorId: 'bot', source: 'world', observedAt: at - 180, text: '阿青说，今天需要独自处理一些事情，可能不能一起出门。', rootEventIds: ['event_4'] },
  { eventId: 'observed_4', actorId: 'bot', source: 'world', observedAt: at - 100, text: '坐在窗边翻阅书页时，能听见花园中细小的风声。', rootEventIds: ['event_6'] }
];
function growthRecord(id, claimId, kind, subject, statement, relation, eids, time, previousId) { return { id, claimId, actorId: 'bot', kind, subject, statement, relation, evidenceIds: eids, rootEventIds: eids.map(id => evidence.find(e => e.eventId === id).rootEventIds[0]), recordedAt: time, ...(previousId ? { previousId } : {}) }; }
const growth = [
  { claimId: 'claim_1', kind: 'relationship', subject: '阿青', statement: '阿青会照顾我的感受，也有自己的安排。', status: 'tentative', records: [growthRecord('g1','claim_1','relationship','阿青','阿青愿意照顾我。','support',['observed_1'],at-340),growthRecord('g2','claim_1','relationship','阿青','阿青也需要自己的时间。','counter',['observed_3'],at-170,'g1'),growthRecord('g3','claim_1','relationship','阿青','阿青会照顾我的感受，也有自己的安排。','revise',['observed_4'],at-90,'g2')], evidence: [evidence[0],evidence[2],evidence[3]] },
  { claimId: 'claim_2', kind: 'commitment', subject: '明天的约定', statement: '明天下午去花园走走，出发前再确认阿青是否有空。', status: 'contested', records: [growthRecord('g4','claim_2','commitment','明天的约定','明天下午去花园走走。','support',['observed_2'],at-230),growthRecord('g5','claim_2','commitment','明天的约定','阿青的计划可能有变化。','counter',['observed_3'],at-160,'g4')], evidence: [evidence[1],evidence[2]] },
  { claimId: 'claim_3', kind: 'preference', subject: '阅读', statement: '我喜欢在有自然光的窗边读书。', status: 'tentative', records: [growthRecord('g6','claim_3','preference','阅读','我喜欢在有自然光的窗边读书。','support',['observed_4'],at-80)], evidence: [evidence[3]] }
];
const debugEntries = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, ts: now - (45 - i) * 27000, kind: i % 7 === 0 ? 'world.tool' : i % 3 === 0 ? 'llm.req' : i % 3 === 1 ? 'llm.res' : 'bot.tool', label: i % 7 === 0 ? '结构化世界·提案校验失败' : i % 3 === 0 ? 'World·请求发送' : i % 3 === 1 ? 'World·已完成·工具调用' : 'Bot·observe', level: i % 7 === 0 ? 'warn' : 'info', detail: JSON.stringify(i % 7 === 0 ? { validation: { message: '开发样本：引用尚未定义的地点', details: [{ entityId: 'cup', field: 'location', targetId: 'missing_room', reason: 'missing' }] } } : i % 3 === 1 ? { ms: 1100 + ((i * 317) % 2500), model: i % 2 ? 'world-model' : 'bot-model', usage: { prompt_tokens: 2600 + i * 12, completion_tokens: 250 + i * 5, total_tokens: 2850 + i * 17 }, content: '', tool_calls: [{ name: 'propose_world', arguments: '{"operations":[]}' }] } : i % 3 === 0 ? { model: 'world-model', messages: [{ role: 'user', content: '开发样本：根据当前世界快照，裁定本次行动。' }] } : { id: 'call_' + i, name: 'observe', args: { modality: 'sight' } }) }));
const usageEntries = Array.from({ length: 70 }, (_, i) => ({ id: i+1, ts: now - (70-i)*600000, label: i%3?'Bot':'World', model: i%3?'bot-model':'world-model', promptTokens: 1500+i*17, completionTokens: 180+(i*31)%750, cachedTokens: i%4?900:0, cacheReported: i%4!==0 })).map(r=>({...r,totalTokens:r.promptTokens+r.completionTokens}));
const total = rows => rows.reduce((t,r)=>({requests:t.requests+1,promptTokens:t.promptTokens+r.promptTokens,completionTokens:t.completionTokens+r.completionTokens,totalTokens:t.totalTokens+r.totalTokens,cachedTokens:t.cachedTokens+r.cachedTokens,cacheReportedPromptTokens:t.cacheReportedPromptTokens+(r.cacheReported?r.promptTokens:0),cacheMissRecords:t.cacheMissRecords+(r.cacheReported?0:1)}),{requests:0,promptTokens:0,completionTokens:0,totalTokens:0,cachedTokens:0,cacheReportedPromptTokens:0,cacheMissRecords:0});
const summary = { totals: total(usageEntries), byLabel: Object.fromEntries(['Bot','World'].map(k=>[k,total(usageEntries.filter(r=>r.label===k))])), byModel: Object.fromEntries(['bot-model','world-model'].map(k=>[k,total(usageEntries.filter(r=>r.model===k))])), byHour: Array.from({length:24},(_,i)=>{const ts=now-(23-i)*3600000;return {ts,hour:new Date(ts).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),totals:total(usageEntries.filter(r=>r.ts>=ts&&r.ts<ts+3600000))};}), byDay:[{day:new Date(now).toISOString().slice(0,10),totals:total(usageEntries)}] };
let running = true, profile = { name: '林岚', persona: '喜欢观察植物与记录日常的旅人。' }, player = null;
const streams = new Set(), receipts = new Map();
function observation() { return { observationId:'obs_preview',actorId:player?.takeover?'bot':'player_fixture',worldSequence:28,observedAt:at,sourceEventIds:['event_12'],entities:[{observedId:'seen_self',kind:'actor',name:player?.takeover?'小澈':profile.name,revision:1,self:true,attributes:{posture:'站在窗边'}},{observedId:'seen_studio',kind:'place',name:'窗边工作室',revision:3,self:false,attributes:{light:'soft'}},{observedId:'seen_cup',kind:'object',name:'温热的茶',revision:3,self:false,locationObservedId:'seen_studio',attributes:{temperature:52}}],utterances:[]}; }
function playerEvent(value){for(const res of streams)res.write('data: '+JSON.stringify(value)+'\n\n');}
const port=Number(process.env.STUDIO_PREVIEW_PORT||18131);
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');const path=url.pathname;
 const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
 try{
  if(path==='/'){
   const source=await readFile(join(root,'src/webui/page.ts'),'utf8');const page=JSON.parse(source.slice(source.indexOf('export const PAGE_HTML = ')+24).trim().replace(/;$/,''));
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(page.replace('</body>','<div style="position:fixed;bottom:6px;left:12px;z-index:65;padding:3px 8px;border-radius:5px;background:#fff2d4;color:#896428;font:9px sans-serif;pointer-events:none">开发预览 · 全部为本地样本数据</div></body>'));return;
  }
  if(path==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write('data: '+JSON.stringify({channel:'hello',snapshot:45})+'\n\n');const timer=setInterval(()=>res.write(': keepalive\n\n'),15000);req.on('close',()=>clearInterval(timer));return;}
  if(path==='/api/player/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});streams.add(res);res.write('data: '+JSON.stringify({type:'hello',worldName:'林间小屋',unitWorldSeconds:1,timeLine:'09:41 · 初秋的清晨'})+'\n\n');const timer=setInterval(()=>res.write(': keepalive\n\n'),15000);req.on('close',()=>{streams.delete(res);clearInterval(timer);});return;}
  let body={};if(!['GET','HEAD'].includes(req.method)){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000000)throw Error('body too large');}if(raw)body=JSON.parse(raw);}
  if(path==='/api/health')return json({ok:true,preview:true});
  if(path==='/api/overview'){const s=fixture.session();return json({version:'0.2.1-preview',initialized:true,worldRunning:running,worldQueue:0,clock:{syncRealTime:false,timeLine:'09:41 · 初秋的清晨',unitRealSeconds:1,unitWorldSeconds:1},bot:{running:running,paused:s.control.paused,waiting:null,streamLength:48,approxChars:16400,pendingTasks:1},appOpen:s.devices.phone.appOpen,computerOn:s.devices.computer.on,phoneDown:false,focusChannels:[],news:[],facts:[],galleryCounts:[],crossing:{location:null,serverEnabled:true,visitors:[],worlds:[]},tokenSet:false,addresses:[]});}
  if(path==='/api/world/state')return json({state:{snapshot,events}});
  if(path==='/api/bot/growth')return json({growth});
  if(path==='/api/debug')return json({entries:debugEntries,snapshot:45});
  if(path==='/api/usage')return json({summary,entries:usageEntries,snapshot:70});
  if(path==='/api/state')return json({initialized:true,botDef:'小澈，住在林间小屋，喜欢阅读、植物与安静的午后。她会根据自己的经历，慢慢形成判断。',worldDef:'一间光线柔和的工作室，窗外是一座小花园。周围的事物遵循稳定的空间与物理规则。',botStatus:'开发预览：只读的角色状态投影。',worldStatus:'开发预览：小澈在窗边的工作室。',meta:{botName:'小澈',realWorld:false},news:[],facts:[],phoneShell:''});
  if(path==='/api/device/session')return json(fixture.session());
  if(path==='/api/device/control')return json(fixture.control(body));
  if(path==='/api/device/tool')return json(await fixture.tool(body));
  if(path==='/api/devices')return json(fixture.session().devices);
  if(path==='/api/computer/screen')return json({error:'开发样本的电脑为终端模式，没有远程桌面画面。'},503);
  if(path==='/api/notes')return json(fixture.notes());
  if(path==='/api/player/profile'){if(req.method==='PUT')profile=body;return json({profile,botName:'小澈'});}
  if(path==='/api/player/arrive'){player={token:'preview-player',takeover:body.mode==='avatar'};if(body.name)profile={name:body.name,persona:body.persona||''};const control=player.takeover?fixture.control({paused:true}):undefined;return json({ok:true,control,token:player.token,worldName:'林间小屋',timeLine:'09:41 · 初秋的清晨',botName:'小澈',takeover:player.takeover,isAdmin:true});}
  if(path==='/api/player/task'){
   if(receipts.has(body.taskId)){setTimeout(()=>playerEvent(receipts.get(body.taskId)),40);return json({ok:true,accepted:true,taskId:body.taskId});}
   const result={type:'task_result',taskId:body.taskId,ok:true,content:JSON.stringify(body.kind==='observe'?observation():{observation:observation(),action:{id:body.taskId,status:'completed'}})};receipts.set(body.taskId,result);setTimeout(()=>playerEvent(result),150);return json({ok:true,accepted:true,taskId:body.taskId});
  }
  if(path==='/api/player/tool')return json({ok:true,text:JSON.stringify({observation:observation(),action:{status:'completed'}})});
  if(path==='/api/player/cancel')return json(receipts.has(body.taskId)?{ok:false,status:'too_late',result:receipts.get(body.taskId)}:{ok:true,status:'cancelled'});
  if(path==='/api/player/leave'){if(player?.takeover)fixture.control({paused:false});player=null;return json({ok:true});}
  if(path==='/api/config'){if(req.method==='POST')config=body.config||body;return json({value:config,schema:introspect(Config),port,version:'preview'});}
  if(path==='/api/crossing')return json({location:null,visitors:[],worlds:[],serverEnabled:true,server:{enabled:true,port:0},invites:[]});
  if(path==='/api/visitors')return json({visitors:[]});
  if(path==='/api/archive')return json({archives:[]});
  if(path==='/api/gallery')return json({entries:[],counts:[],categories:['未整理']});
  if(path==='/api/media')return json({items:[]});
  if(path==='/api/data')return json({files:[],notes:[]});
  if(path==='/api/stream')return json({entries:[]});
  if(path==='/api/prompts')return json({defaults:{bot:{system:'开发样本：根据已观察的世界决定下一步行动。'},world:{system:'开发样本：根据规则裁定结构化事务。'}},overrides:{bot:{},world:{}}});
  if(path.startsWith('/api/world/')){if(path.endsWith('/stop'))running=false;if(path.endsWith('/start'))running=true;return json({ok:true,text:'仅更改本地开发样本状态。'});}
  return json({error:'开发预览未实现此接口：'+path},404);
 }catch(e){json({error:e.message},500);}
});
server.listen(port,'127.0.0.1',()=>console.log('Isolated World Studio preview: http://127.0.0.1:'+server.address().port+' (sample data only; no external operations)'));
async function close(){server.close();server.closeAllConnections();await rm(temporary,{recursive:true,force:true});process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
