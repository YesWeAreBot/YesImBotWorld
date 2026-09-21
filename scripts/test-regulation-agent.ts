/** Actual Agent -> regulation -> durable call -> scheduler -> perception boundaries, with local model/world fixtures. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../src/config.js";
import { BotAgent } from "../src/bot/agent.js";
import { BotContext } from "../src/bot/context.js";
import { BOT_TOOLS } from "../src/bot/tools.js";
import type { RegulationModelInput, RegulationModelResult } from "../src/bot/regulation-model.js";
import { WorldFiles } from "../src/files.js";
import type { BotEvent, ParsedToolCall, ToolCallRecord } from "../src/types.js";

const directories: string[] = [], agents: any[] = [];
const pause = (ms = 5) => new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(test:()=>boolean, label:string) { for(let i=0;i<500;i++){if(test())return;await pause();}throw Error("Agent boundary timed out: "+label); }
function gate<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
function stopped(signal:AbortSignal):Promise<never> { return new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener("abort",()=>reject(signal.reason),{once:true});}); }
const proposed:ParsedToolCall={name:"act",arguments:{description:"马上出门散步"}};
const alternative:ParsedToolCall={name:"observe_device",arguments:{device:"phone"}};
function decision(input:RegulationModelInput, replacement?:ParsedToolCall):RegulationModelResult {
  return {appraisals:[],evidenceIds:input.events.map(event=>event.id),appraisalExplanations:[],candidateForecasts:[],candidates:[
    {id:"proposed",call:input.proposed,contextKey:"准备决定接下来如何行动",expectedEffects:{},cost:replacement?1:0,risk:replacement?1:0},
    ...(replacement?[{id:"alternative-1",call:replacement,contextKey:"先确认当前身体处境",expectedEffects:{novelty:.3},cost:0,risk:0}]:[]),
  ]};
}
async function fixture(enabled=true) {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),"yesimbot-regulation-agent-"));directories.push(base);
  const files=new WorldFiles(base);await files.ensure();
  await fs.writeFile(files.botDef,"小澈，喜欢普通而自由的生活。明确作者边界：记得与家人的约定。");
  const context=new BotContext(files);await context.load();
  const cfg=Config({autoStart:false});
  Object.assign(cfg.bot,{baseURL:"http://fixture.invalid",nativeToolCalls:false,minIntervalMs:0,retryDelayMs:5,maxWindowChars:1_000_000,spillMinChars:0,breakLoop:false,repeatThresholds:[50]});
  cfg.bot.growth.enabled=false;cfg.bot.regulation.enabled=enabled;
  let time=10,observations=0,actions=0,compressions=0;
  const clock={now:()=>time,unitWorldSeconds:30,unitRealSeconds:1,timeLine:()=>`T${time}`,realMsUntil:()=>0} as any;
  const logger={info(){},warn(){},error(){}} as any;
  const trace:string[]=[],performed:ToolCallRecord[]=[];
  const world={
    observe:async()=>{observations++;trace.push("world.observe");return {actorId:"bot",observationId:"observed-"+observations,sourceEventIds:["actual-observation-"+observations],narrative:"你站在门口，留意到自己今天有些疲倦。"};},
    adjudicateAct:async(call:ToolCallRecord,deliver:(text:string)=>void,_signal:AbortSignal,commit:()=>boolean)=>{assert.ok(commit());actions++;performed.push(structuredClone(call));trace.push("world.act");deliver(JSON.stringify({action:{id:call.id,intent:call.arguments.description,status:"completed"},scene:{eventId:"world-scene-"+actions,actorId:"bot",sourceEventIds:["actual-action-"+actions],text:"你沿着小路走了一会儿。"}}));return true;},
    compress:async()=>{compressions++;return {historySummary:"曾在门口考虑下一步。",memoryDigest:"保留与家人的约定。"};},
  } as any;
  const agent=new BotAgent(cfg,clock,files,context,world,{} as any,null,null,null,{down:false},logger,BOT_TOOLS.filter(tool=>["act","observe_device","wait","rest"].includes(tool.name))) as any;
  agent.peekDevice=async()=>{observations++;trace.push("device.observe");return {text:"手机当前停留在桌面。",originEventIds:["actual-device-observation-"+observations]};};
  agents.push(agent);
  assert.ok(agent.regulation,"the actual agent owns the regulation runtime");
  return {base,files,context,cfg,clock,agent,trace,performed,setTime:(value:number)=>{time=value;},get observations(){return observations;},get actions(){return actions;},get compressions(){return compressions;}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function oneGeneration(f:Fixture,call:ParsedToolCall=proposed) {
  let count=0;
  f.agent.backend.generate=async(_context:BotContext,_time:string,signal:AbortSignal)=>{count++;if(count===1)return structuredClone(call);return stopped(signal);};
  return ()=>count;
}
function calls(f:Fixture){return f.context.stream.flatMap(entry=>entry.kind==="tool_call"?[entry.call]:[]);}
async function journal(f:Fixture):Promise<any[]> { const text=await fs.readFile(f.files.regulationJournal,"utf8").catch(()=>"");return text.trim()?text.trim().split("\n").map(line=>JSON.parse(line)):[]; }

async function oneChosenCall() {
  const f=await fixture(),prefix=await f.context.toChatMessages("T10");
  let evaluations=0;oneGeneration(f);
  f.agent.regulation.model.evaluate=async(input:RegulationModelInput)=>{evaluations++;assert.equal(calls(f).length,0,"proposed and alternative candidates are not performed history during evaluation");assert.deepEqual(input.proposed,proposed);return decision(input,alternative);};
  const bind=f.agent.regulation.bind.bind(f.agent.regulation);
  f.agent.regulation.bind=async(choice:any,call:ToolCallRecord)=>{assert.ok(call.id);assert.equal(calls(f).length,0);assert.deepEqual(choice.call,alternative);f.trace.push("bind:start");await bind(choice,call);f.trace.push("bind:committed");};
  const append=f.context.appendToolCall.bind(f.context);
  f.context.appendToolCall=async(call:ToolCallRecord)=>{assert.ok((await journal(f)).some(record=>record.type==="bind"&&record.callId===call.id),"the real call ID is durably bound before append");f.trace.push("call:append");return append(call);};
  const perceive=f.agent.regulation.perceive.bind(f.agent.regulation);
  const perceived:BotEvent[]=[];
  f.agent.regulation.perceive=async(event:BotEvent)=>{assert.ok(f.context.stream.some(entry=>entry.kind==="event"&&entry.event.id===event.id),"regulation sees only a durably delivered event");perceived.push(structuredClone(event));await perceive(event);};
  f.agent.pushEvent("world",{text:"门口的风吹了进来。",originEventIds:["fresh-doorway"],experience:{agency:"observed",episodeId:"doorway"}});
  f.agent.start();
  await until(()=>f.context.stream.some(entry=>entry.kind==="event"&&entry.event.source==="tool"),"chosen action receipt delivery");
  await f.agent.stop();
  assert.equal(evaluations,1);assert.equal(f.observations,1);assert.equal(f.actions,0);
  assert.equal(calls(f).length,1);assert.equal(calls(f)[0]!.name,"observe_device");assert.deepEqual(calls(f)[0]!.arguments,alternative.arguments);
  assert.ok(f.trace.indexOf("bind:committed")<f.trace.indexOf("call:append")&&f.trace.indexOf("call:append")<f.trace.indexOf("device.observe"));
  assert.ok(perceived.some(event=>event.source==="tool"&&event.refToolCallId===calls(f)[0]!.id),"real result is returned to the regulation perception path");
  const rows=await journal(f);
  assert.equal(rows.filter(row=>row.type==="decision").length,1);assert.equal(rows.find(row=>row.type==="decision").selectedId,"alternative-1");
  assert.equal(rows.filter(row=>row.type==="bind").length,1);
  assert.ok(!rows.some(row=>row.type==="evidence"&&row.event.source==="system"),"the internal notice cannot become a new external experience");
  assert.ok(f.context.stream.some(entry=>entry.kind==="event"&&entry.event.id.startsWith("ev_regulation_")),"internal feedback is appended through the normal notice boundary");
  assert.deepEqual((await f.context.toChatMessages("T11")).slice(0,prefix.length),prefix,"decision feedback preserves the exact existing provider prefix");
  console.log("PASS regulation Agent: one selected action, durable bind before history and dispatch, actual result perception and append-only feedback");
}

async function disabledPath() {
  const f=await fixture(false);oneGeneration(f);
  f.agent.regulation.model.evaluate=async()=>{throw Error("disabled mechanism attempted inference");};
  f.agent.start();await until(()=>f.context.stream.some(entry=>entry.kind==="event"&&entry.event.source==="tool"),"unchanged disabled action receipt");await f.agent.stop();
  assert.equal(f.actions,1);assert.equal(f.observations,0);assert.equal(calls(f).length,1);assert.deepEqual(calls(f)[0]!.arguments,proposed.arguments);
  assert.equal(await f.files.exists(f.files.regulationJournal),false,"disabled mechanism neither infers nor creates a new audit");
  console.log("PASS regulation Agent: feature-off preserves the original action path without inference or journal writes");
}

async function controlFences() {
  const paused=await fixture();let generated=0,evaluated=0;
  paused.agent.backend.generate=async()=>{generated++;return structuredClone(alternative);};
  paused.agent.regulation.model.evaluate=async(input:RegulationModelInput)=>{evaluated++;return decision(input);};
  paused.agent.setManualPaused(true);
  paused.agent.pushEvent("world",{text:"入替期间真实看到了窗外的树。",originEventIds:["avatar-sees-tree"],experience:{agency:"observed",episodeId:"avatar-window"}});
  paused.agent.start();await until(()=>paused.context.stream.some(entry=>entry.kind==="event"&&entry.event.content.includes("窗外的树")),"paused character still receives real perceptions");await pause(25);
  assert.equal(generated,0);assert.equal(evaluated,0);assert.equal(calls(paused).length,0);await paused.agent.stop();

  const generation=await fixture(),generatedResult=gate<ParsedToolCall>();let inGenerate=false,lateEvaluations=0;
  generation.agent.backend.generate=async()=>{inGenerate=true;return generatedResult.promise;};
  generation.agent.regulation.model.evaluate=async(input:RegulationModelInput)=>{lateEvaluations++;return decision(input);};
  generation.agent.start();await until(()=>inGenerate,"generation is pending");generation.agent.setManualPaused(true);generatedResult.resolve(proposed);await pause(30);await generation.agent.stop();
  assert.equal(lateEvaluations,0);assert.equal(calls(generation).length,0);assert.equal(generation.actions,0);

  const evaluation=await fixture(),evaluatedResult=gate<RegulationModelResult>();oneGeneration(evaluation);let input:RegulationModelInput|undefined,finished=false;
  evaluation.agent.regulation.model.evaluate=async(value:RegulationModelInput)=>{input=value;return evaluatedResult.promise;};
  const choose=evaluation.agent.regulation.choose.bind(evaluation.agent.regulation);
  evaluation.agent.regulation.choose=async(...args:any[])=>{try{return await choose(...args);}finally{finished=true;}};
  evaluation.agent.start();await until(()=>!!input,"regulation inference is pending");evaluation.agent.setManualPaused(true);evaluatedResult.resolve(decision(input!,alternative));await until(()=>finished,"late evaluation rejected");await evaluation.agent.stop();
  assert.equal(calls(evaluation).length,0);assert.equal(evaluation.actions+evaluation.observations,0);assert.equal((await journal(evaluation)).filter(row=>row.type==="decision"||row.type==="bind").length,0);

  const puppet=await fixture();await puppet.agent.acquireResidentControl("puppet","isolated-body-controller");oneGeneration(puppet,alternative);let allowed:string[]=[];
  puppet.agent.regulation.model.evaluate=async(value:RegulationModelInput)=>{allowed=value.tools.map(tool=>tool.name);return decision(value);};
  puppet.agent.start();await until(()=>puppet.context.stream.some(entry=>entry.kind==="event"&&entry.event.source==="tool"),"conscious observation while body is controlled");await puppet.agent.stop();
  assert.ok(allowed.includes("observe_device"));assert.ok(!allowed.includes("act"),"the evaluator cannot propose autonomous body actions while puppet control holds the body");assert.equal(puppet.observations,1);assert.equal(puppet.actions,0);
  console.log("PASS regulation Agent: manual replacement pauses private generation, late generation/evaluation cannot act, and puppet capabilities remain filtered");
}

async function lateBindingFence() {
  const f=await fixture();oneGeneration(f);f.agent.regulation.model.evaluate=async(input:RegulationModelInput)=>decision(input,alternative);
  const hold=gate<void>(),binding=gate<void>(),bind=f.agent.regulation.bind.bind(f.agent.regulation);
  f.agent.regulation.bind=async(choice:any,call:ToolCallRecord)=>{await bind(choice,call);binding.resolve();await hold.promise;};
  f.agent.start();await binding.promise;f.agent.setManualPaused(true);hold.resolve();await pause(30);await f.agent.stop();
  assert.equal(calls(f).length,0,"a takeover while the expectation is binding cannot create a performed-call history");assert.equal(f.actions+f.observations,0);
  console.log("PASS regulation Agent: takeover after durable binding fences both context append and side effects");
}

async function deliveryRecoveryAndCompression() {
  const f=await fixture();f.agent.running=true;f.agent.abort=new AbortController();
  const prefix=await f.context.toChatMessages("T10"),perceive=f.agent.regulation.perceive.bind(f.agent.regulation);let failed=false;
  f.agent.regulation.perceive=async(event:BotEvent)=>{if(event.content.includes("真实的学习材料")&&!failed){failed=true;throw Error("isolated regulation write failure");}return perceive(event);};
  f.agent.pushEvent("world",{text:"真实的学习材料：你在门口停下来，听完了朋友的解释。",originEventIds:["perception-durable"],experience:{agency:"observed",episodeId:"heard-explanation"}});
  await assert.rejects(f.agent.drainMailbox(),/isolated regulation write failure/);
  assert.equal(f.context.stream.filter(entry=>entry.kind==="event"&&entry.event.content.includes("真实的学习材料")).length,1);
  f.agent.regulation.perceive=perceive;await f.agent.drainMailbox();
  assert.equal((await journal(f)).filter(row=>row.type==="evidence"&&row.event.content.includes("真实的学习材料")).length,1,"retry preserves exactly one canonical perceived event");
  assert.deepEqual((await f.context.toChatMessages("T11")).slice(0,prefix.length),prefix);
  const summary=await f.agent.regulation.summary();assert.ok(summary);
  f.setTime(11);await f.agent.compactContext(null);assert.equal(f.compressions,1);
  const compacted=await f.context.toChatMessages("T11");assert.ok(String(compacted[0]!.content).includes(summary),"successful normal compression freezes the current mechanism summary into the new prefix");
  await f.agent.stop();const restored=new BotContext(f.files);await restored.load();assert.deepEqual(await restored.toChatMessages("T999"),compacted,"restart retains the exact committed compacted prefix");
  console.log("PASS regulation Agent: durable perception retry, normal-compression summary and exact restart prefix");
}

async function main(){try{await oneChosenCall();await disabledPath();await controlFences();await lateBindingFence();await deliveryRecoveryAndCompression();}finally{for(const agent of agents)await agent.stop().catch(()=>{});for(const dir of directories)await fs.rm(dir,{recursive:true,force:true});}}
main().catch(error=>{console.error(error);process.exitCode=1;});
