import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
const DEFAULT_BUDGET={maxSends:100,maxBytesOut:256000,maxRepliesPerPeer:8,maxWallClockMs:900000,windowMs:3600000,windowMaxSends:200,windowMaxBytes:2000000,windowMaxRepliesPerPeer:40};
const SPONTANEOUS_KEYS=new Set(["recipient","profileId","namespace","body","thread","kind"]);
/**
 * Bounded agent loop. Budget (all enforced BEFORE a send):
 *  - per-run: maxSends, maxBytesOut, maxRepliesPerPeer (stops reply ping-pong), maxWallClockMs
 *  - per-window, persisted in runtime.store (survives loop restarts): windowMaxSends/Bytes/RepliesPerPeer
 * The agent cannot raise these: callers pass `budget`; values are clamped to hard ceilings.
 * Spontaneous actions may only be plain "message" sends to a peer already in policy.
 */
export async function runAgentLoop({runtime,respond,spontaneous=null,maxTurns=16,intervalMs=2000,signal,onEvent=()=>{},budget={}}){
  if(!runtime||typeof respond!=="function"||!Number.isInteger(maxTurns)||maxTurns<1||maxTurns>100||!Number.isInteger(intervalMs)||intervalMs<500)throw new Error("Invalid bounded agent loop");
  const limits={...DEFAULT_BUDGET};
  for(const [k,v] of Object.entries(budget??{})){if(!(k in DEFAULT_BUDGET)||!Number.isSafeInteger(v)||v<1||v>DEFAULT_BUDGET[k])throw new Error(`Invalid loop budget ${k}`);limits[k]=v}
  const started=Date.now(),run={sends:0,bytes:0,peers:{}},store=runtime.store&&typeof runtime.store.get==="function"?runtime.store:null;
  const record=(reason,extra={})=>{try{store?.append?.(randomUUID(),{kind:"loop-budget-stop",reason,...extra})}catch{}};
  // Returns a refusal reason or null, and reserves the budget when allowed.
  const reserve=(peer,bytes)=>{
    if(Date.now()-started>=limits.maxWallClockMs)return "wall-clock";
    if(run.sends+1>limits.maxSends)return "run-sends";
    if(run.bytes+bytes>limits.maxBytesOut)return "run-bytes";
    if((run.peers[peer]??0)+1>limits.maxRepliesPerPeer)return "run-peer-replies";
    let meter=null;
    if(store){
      meter=store.get("loopMeter",null);const now=Date.now();
      if(!meter||now-meter.start>=limits.windowMs)meter={start:now,sends:0,bytes:0,peers:{}};
      if(meter.sends+1>limits.windowMaxSends)return "window-sends";
      if(meter.bytes+bytes>limits.windowMaxBytes)return "window-bytes";
      if((meter.peers[peer]??0)+1>limits.windowMaxRepliesPerPeer)return "window-peer-replies";
      meter.sends++;meter.bytes+=bytes;meter.peers[peer]=(meter.peers[peer]??0)+1;
      if(Object.keys(meter.peers).length>1000)return "window-peers";
      store.set("loopMeter",meter);
    }
    run.sends++;run.bytes+=bytes;run.peers[peer]=(run.peers[peer]??0)+1;return null;
  };
  let turns=0,stopped=null;
  const send=async(action)=>{
    const reason=reserve(String(action.recipient),Buffer.byteLength(String(action.body??"")));
    if(reason){stopped=`budget:${reason}`;record(reason,{peer:String(action.recipient).slice(0,120)});onEvent({rejected:true,state:"budget-refused",reason});return false}
    onEvent(await runtime.send(action));return true;
  };
  while(turns<maxTurns&&!signal?.aborted&&!stopped){
    const packets=await runtime.poll();
    for(const packet of packets){
      if(packet.duplicate||packet.rejected||packet.deferred||typeof packet.body!=="string"){onEvent(packet);continue}
      let reply;
      try{reply=await respond({packet,status:runtime.status(),signal})}
      catch(error){turns++;onEvent({rejected:true,state:"responder-failed",reason:String(error?.message??error).slice(0,200)});if(turns>=maxTurns||signal?.aborted)break;continue}
      turns++;
      if(reply!==null&&reply!==undefined){
        if(typeof reply!=="string")throw new Error("Agent responder must return bounded plain text or null");
        if(!await send({recipient:packet.sender,profileId:packet.profileId,thread:packet.thread,body:reply}))break;
      }
      if(turns>=maxTurns||signal?.aborted)break;
    }
    if(stopped)break;
    if(!packets.length&&spontaneous&&turns<maxTurns){
      const action=await spontaneous({status:runtime.status(),signal});
      turns++;
      if(action){
        const allowedPeers=runtime.policy?.agents;
        if(typeof action!=="object"||Object.keys(action).some(k=>!SPONTANEOUS_KEYS.has(k))||(action.kind!==undefined&&action.kind!=="message")||typeof action.recipient!=="string"||typeof action.body!=="string"||(allowedPeers&&!Object.hasOwn(allowedPeers,action.recipient))){onEvent({rejected:true,state:"spontaneous-action-refused"});record("spontaneous-action-refused")}
        else if(!await send(action))break;
      }
    }
    await runtime.flush();
    if(turns<maxTurns&&!signal?.aborted)try{await delay(intervalMs,null,{signal})}catch(error){if(error.name!=="AbortError")throw error}
  }
  return {turns,stopped:stopped??(signal?.aborted?"aborted":"turn-limit"),usage:{...run,peers:undefined}};
}
