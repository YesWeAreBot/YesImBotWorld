/** App boundaries: shared-screen reads, native opening media, stop joins and world archives. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppManager } from '../src/apps/manager.js';
import { BotAgent } from '../src/bot/agent.js';
import { WorldAgent } from '../src/world/agent.js';
import { WorldFiles } from '../src/files.js';
import { Config } from '../src/config.js';
import type { WorldApp } from '../src/apps/app.js';
import { mediaPart } from '../src/media/presentation.js';
import type { RichText } from '../src/types.js';
async function main() {
const logger:any={info(){},warn(){},error(){},debug(){}};
const cfg=Config({});
assert.equal(cfg.apps.browserHomeURL,'portal');
assert.equal(cfg.apps.clockEnabled,true);
assert.equal(cfg.apps.camera.enabled,false);
assert.equal(cfg.apps.assistant.name,'小助手');
assert.equal(cfg.apps.assistant.mode,'inherit');

const media:any={id:21,type:'image',mime:'image/png'};
const opening:RichText={text:'当前浏览器画面',attachments:[media],parts:[{kind:'text',text:'当前浏览器画面'},mediaPart(media,{native:true})] as any};
let closed=0,disposed=0,reply='初始';
const app:WorldApp={id:'assistant',name:'独立助手',description:'测试应用',async open(){return {opening,tools:[{name:'cancel',description:'取消回答'}]};},async call(){return 'ok';},async close(){closed++;},async dispose(){disposed++;},viewState(){return {jobs:[{id:'q1',question:'一个问题',reply,status:'running'}]};}};
const manager=new AppManager('QQ',[app],new Set(['cancel']),logger);
const bot:any=Object.create(BotAgent.prototype);bot.apps=manager;bot.phoneUi={chatOpen:false};bot.refreshToolGate=()=>{};
bot.stealthCalls=new Set<string>();
let delivered:Promise<string|RichText>|undefined;
bot.dispatchLocal=(_:unknown,run:()=>Promise<string|RichText>)=>{delivered=run();};
bot.dispatchOpenApp({},'独立助手');const received=await delivered;
assert.equal(typeof received,'object');
assert.deepEqual((received as RichText).attachments,[media]);
assert.ok((received as RichText).parts?.some(part=>part.kind==='media'));
assert.equal((received as RichText).text, opening.text, 'opening media stays separate from the capability announcement');
assert.ok(manager.activeToolDefs().some(def => def.name === 'assistant.cancel'), 'the live gate can announce namespaced definitions once');
reply='后续的流式内容';
assert.match(manager.screen()!.text,/后续的流式内容/);
const copy:any=manager.view();copy.state.jobs[0].reply='污染';
assert.match(manager.screen()!.text,/后续的流式内容/);
await manager.closeCurrent();assert.equal(closed,1);assert.equal(disposed,0);
await manager.open(app);await manager.closeAll();assert.equal(disposed,1);assert.equal(manager.view(),null);

// Visible photo reads retain native media; the clock screen includes a running stopwatch.
const camera:WorldApp={...app,id:'camera',name:'相机',async call(){return opening;},viewState(){return {jobs:[{id:'photo',subject:'书桌',status:'completed'}]};}};
const visibleApps=new AppManager('QQ',[camera],new Set(['read_photo']),logger);
await visibleApps.open({...camera,async open(){return {tools:[{name:'read_photo',description:'读照片'}]};}});
await visibleApps.call('camera.read_photo',{});assert.deepEqual(visibleApps.screen()?.attachments,[media]);await visibleApps.closeAll();
const clock:WorldApp={...app,id:'clock',name:'时钟',viewState(){return {timeLine:'中午',reminders:[],stopwatch:{elapsedSeconds:3.25,running:true,laps:[1.5]}};}};
const clockApps=new AppManager('QQ',[clock],new Set(),logger);await clockApps.open(clock);assert.match(clockApps.screen()!.text,/计时中.*3.25.*1.5/);await clockApps.closeAll();

// Dispose independent jobs immediately, even when one app needs time to close.
let unblock!:()=>void;const blocked=new Promise<void>(resolve=>unblock=resolve);let aborted=false;
const waiting={...app,id:'one',async dispose(){await blocked;}};
const other={...app,id:'two',async dispose(){aborted=true;}};
const stopped=new AppManager('QQ',[waiting,other],new Set(),logger).closeAll();
await Promise.resolve();assert.equal(aborted,true);unblock();await stopped;

// Only delivered actor perceptions are photographic input; newer hidden commits are excluded.
const world:any=Object.create(WorldAgent.prototype);
Object.assign(world,{remote:null,botName:'角色',clock:{timeLine:(tu:number)=>'星历三年 · '+tu+' 刻'},perceptionCursors:new Map([['bot',2]]),directlyObserved:new Map(),runtime:{async perceptionsSince(){return [
  {worldSequence:1,observationId:'old',observedAt:1,narrative:'一间教室'},
  {worldSequence:2,observationId:'seen',observedAt:2,narrative:'桌面上的书'},
  {worldSequence:3,observationId:'hidden',observedAt:3,narrative:'尚未交付的秘密'},
];}}});
assert.deepEqual(await world.cameraScene(),{visible:'桌面上的书',appearance:'',actorName:'角色',observedAt:'星历三年 · 2 刻'});
world.perceptionCursors.clear();await assert.rejects(world.cameraScene(),/还没有/);
world.directlyObserved.set('bot',new Set(['seen']));assert.equal((await world.cameraScene()).visible,'桌面上的书');
world.remote={};await assert.rejects(world.cameraScene(),/异世界/);

const root=await fs.mkdtemp(path.join(os.tmpdir(),'phone-apps-integration-'));
try{
  const files=new WorldFiles(root);await files.ensure();
  const empty=await files.snapshot('空应用');
  await files.atomicWrite(files.phoneClock,'{"alarm":"saved"}');
  await files.atomicWrite(files.phoneAssistant,'{"reply":"saved"}');
  const saved=await files.snapshot('有应用');
  await files.reset();assert.equal(await files.exists(files.phoneClock),false);assert.equal(await files.exists(files.phoneAssistant),false);
  await files.restoreFrom(path.join(files.archiveDir,saved));
  assert.equal(await files.readText(files.phoneClock),'{"alarm":"saved"}');
  assert.equal(await files.readText(files.phoneAssistant),'{"reply":"saved"}');
  await files.restoreFrom(path.join(files.archiveDir,empty));
  assert.equal(await files.exists(files.phoneClock),false);assert.equal(await files.exists(files.phoneAssistant),false);
}finally{await fs.rm(root,{recursive:true,force:true});}
console.log('PASS phone app integration: native opening, current screen, parallel stop, perceptual camera boundary, archive/reset');

}
void main().catch(error=>{console.error(error);process.exitCode=1;});
