/** Deterministic local-only call frames, driven by explicit smoke steps; never a model request. */
export function createLiveFixture(publish) {
  const calls=new Map(), buffers=new Map();let eventId=1000;
  const emit=call=>publish({id:call.eventId,ts:call.updatedAt,kind:'llm.call',label:call.source+'·'+call.status,level:call.status==='error'?'error':'info',detail:JSON.stringify(call)});
  function begin(id,source,request) {
    const now=Date.now(),call={callId:id,source,model:'开发样本-'+source,url:'fixture://local/chat/completions',startedAt:now,updatedAt:now,status:'pending',revision:1,requestBytes:Buffer.byteLength(request),responseBytes:0,responseChars:0,rawAvailable:true,preview:'',responseFormat:'text/event-stream',eventId:++eventId};
    calls.set(id,call);buffers.set(id,{request,response:''});emit(call);return call;
  }
  function step(body) {
    const id=String(body.id || 'live_fixture_world');
    if(body.action==='begin')return {ok:true,call:begin(id,String(body.source || 'World'),String(body.requestBody || JSON.stringify({model:'开发样本',messages:[{role:'user',content:'仅本地预览的原始请求。'}]})))};
    const call=calls.get(id),buffer=buffers.get(id);if(!call)return{ok:false,error:'fixture call missing'};
    call.revision++;call.updatedAt=Date.now();
    if(body.action==='append'){const text=String(body.text || '');buffer.response+=text;call.responseBytes=Buffer.byteLength(buffer.response);call.responseChars=buffer.response.length;call.status='streaming';call.preview=String(body.preview || text).slice(-1800);}
    else if(body.action==='finish' || body.action==='cancel' || body.action==='error'){call.status=body.action==='finish'?'completed':body.action==='cancel'?'cancelled':'error';call.endedAt=Date.now();if(body.action==='error'){call.httpStatus=400;call.error=String(body.error || '开发样本错误');}}
    else if(body.action==='unavailable'){buffers.delete(id);call.rawAvailable=false;call.rawUnavailableReason='开发样本：调用记录文件不可读';}
    emit(call);return{ok:true,call};
  }
  const seeded=begin('live_fixture_complete','Bot',JSON.stringify({model:'开发样本-Bot',messages:[{role:'user',content:'开发预览：决定下一步观察。'}]}));
  step({id:seeded.callId,action:'append',text:'data: {"choices":[{"delta":{"content":"先看看窗外。"}}]}\n\ndata: [DONE]\n\n',preview:'先看看窗外。'});step({id:seeded.callId,action:'finish'});
  return {
    list(){return{calls:structuredClone([...calls.values()]),retention:{maxCalls:200,maxCompletedCalls:200,activeCallsPreserved:true,cacheOnly:true,persistent:false,storage:'memory',preview:true}};},
    detail(id,after=0,request=true){const call=calls.get(id);if(!call)return null;const buffer=buffers.get(id),reset=!Number.isSafeInteger(after)||after<0||after>(buffer?.response.length || 0),offset=reset?0:after;return{call:structuredClone(call),...(request?{requestBody:buffer?.request ?? null}:{}),responseText:buffer?buffer.response.slice(offset):null,responseOffset:offset,nextOffset:buffer?.response.length || 0,reset};},
    step,
  };
}
