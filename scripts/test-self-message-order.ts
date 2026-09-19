/** Local MessageEncoder + memory DB; controlled acknowledgement barrier, no platform. */
import assert from 'node:assert/strict';
import { App, Bot, MessageEncoder, Universal, h } from 'koishi';
import memory from '@koishijs/plugin-database-memory';
import { Config } from '../src/config.js';
import { Gateway } from '../src/koishi/gateway.js';
import { MessageStore } from '../src/koishi/messages.js';
import { OwnSendTracker } from '../src/koishi/ownsends.js';
import { ChannelNameResolver } from '../src/koishi/names.js';
import { KoishiMessenger } from '../src/koishi/messenger.js';

async function scenario(echoType: 'message'|'send', mode: 'event'|'off') {
  let release!: () => void, echoSeen!: () => void;
  const delay = new Promise<void>(r=>release=r), echoed = new Promise<void>(r=>echoSeen=r);
  class LocalEncoder extends MessageEncoder {
    chunks: h[]=[];
    async visit(element:h) {this.chunks.push(element)}
    async flush() {
      if (!this.chunks.length) return;
      const content=this.chunks.splice(0).join('');
      const message={id:'own-confirmed',content,elements:h.parse(content)};
      this.bot.dispatch(this.bot.session({type:echoType, channel:{id:this.channelId},user:{id:this.bot.selfId},message}));
      echoSeen();
      await delay; // The adapter has delivered its echo, but sendMessage is still pending.
      this.results.push(message);
    }
  }
  class LocalBot extends Bot {
    static MessageEncoder=LocalEncoder;
    dispose(){if(this.ctx.bots)return super.dispose()}
    constructor(ctx:App){super(ctx,{});this.platform='fixture';this.selfId='account';this.status=Universal.Status.ONLINE}
  }
  const app=new App(); app.plugin((memory as any).default??memory); app.plugin(LocalBot); await app.start();
  const bot=app.bots[0]!;
  (bot as any).getUser=async(id:string)=>({id,name:`fixture-${id}`});
  (bot as any).getGuildMember=async(_guild:string,id:string)=>({user:{id,name:`fixture-${id}`}});
  (bot as any).getGuild=async(id:string)=>({id,name:'fixture group'});
  const cfg=Config({autoStart:false});
  const messaging={...cfg.messaging,externalSelfMessages:mode,coldChannelMsgs:0,selfCommands:false};
  const store=new MessageStore(app), tracker=new OwnSendTracker(), names=new ChannelNameResolver(app,store);
  const renderer={render:async(text:string)=>({text})}, focus={isFocused:()=>false,focus:async()=>{}}, notify={isNotifyChannel:()=>false};
  const externalIds:string[]=[];
  const gateway=new Gateway(app,messaging,cfg.platformOps,store,{} as never,renderer as never,focus as never,notify as never,{down:false},{} as never,tracker,names,()=>null,
    {notify(){},channelActivity(){},selfMessage(_key,_rich,id){externalIds.push(id)}});
  const messenger=new KoishiMessenger(app,store,renderer as never,{} as never,{} as never,{} as never,null,focus as never,notify as never,cfg.platformOps,messaging,{} as never,tracker,names,()=>null);
  (messenger as any).resolveBot=async()=>({bot,platform:'fixture',channelId:'group',isDirect:false});
  const drain=async()=>{for(let i=0;i<5;i++){await new Promise<void>(r=>setImmediate(r));await Promise.allSettled([...(gateway as any).messageTails.values()])}};
  try {
    const sent=messenger.sendReceipt('fixture@account:group','own original');
    await echoed;
    // A genuinely different same-account action must not be attributed to the Bot.
    bot.dispatch(bot.session({type:echoType,channel:{id:'group'},user:{id:'account'},message:{id:'other-device',elements:h.parse('another device used this account')}}));
    bot.dispatch(bot.session({type:'message',channel:{id:'group'},user:{id:'peer'},message:{id:'peer-reply',elements:h.parse('reply to own original')}}));
    await new Promise<void>(r=>setImmediate(r));
    release();
    const receipt=await sent; await drain();
    assert.equal(receipt.status,'sent');
    const rows=await store.channelMessages('fixture','group',100,'account');
    const own=rows.find(r=>r.messageId==='own-confirmed')!;
    assert.equal(own.senderOrigin,'tool');
    if(mode==='event'){
      assert.equal(rows.find(r=>r.messageId==='other-device')?.senderOrigin,'external');
      assert.deepEqual(externalIds,['other-device']);
    } else {assert.equal(rows.some(r=>r.messageId==='other-device'),false);assert.deepEqual(externalIds,[])}
    const ordered=rows.findIndex(r=>r.messageId==='own-confirmed')<rows.findIndex(r=>r.messageId==='peer-reply');
    return {echoType,mode,ordered,rows:rows.map(r=>({messageId:r.messageId,origin:r.senderOrigin,key:r.timelineKey,dbId:r.id}))};
  } finally { release(); await app.stop(); }
}
async function main() {
  for (const mode of ['event', 'off'] as const) for (const kind of ['message', 'send'] as const) {
    const result = await scenario(kind, mode);
    assert.equal(result.ordered, true, `${mode}/${kind}: observed self echo must precede the later peer reply, even when confirmation arrives last`);
  }
  console.log('PASS actual Koishi transport: early self echoes preserve reply order with message/send adapters and external capture on/off; another device never becomes tool authorship');
}
main().catch(err=>{console.error(err);process.exitCode=1});
