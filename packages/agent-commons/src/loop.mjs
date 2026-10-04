import { setTimeout as delay } from "node:timers/promises";
export async function runAgentLoop({runtime,respond,spontaneous=null,maxTurns=16,intervalMs=2000,signal,onEvent=()=>{}}){
  if(!runtime||typeof respond!=="function"||!Number.isInteger(maxTurns)||maxTurns<1||maxTurns>100||!Number.isInteger(intervalMs)||intervalMs<500)throw new Error("Invalid bounded agent loop");
  let turns=0;
  while(turns<maxTurns&&!signal?.aborted){
    const packets=await runtime.poll();
    for(const packet of packets){
      if(packet.duplicate||packet.rejected||typeof packet.body!=="string"){onEvent(packet);continue}
      const reply=await respond({packet,status:runtime.status(),signal});
      turns++;
      if(reply!==null&&reply!==undefined){
        if(typeof reply!=="string")throw new Error("Agent responder must return bounded plain text or null");
        onEvent(await runtime.send({recipient:packet.sender,profileId:packet.profileId,thread:packet.thread,body:reply}));
      }
      if(turns>=maxTurns||signal?.aborted)break;
    }
    if(!packets.length&&spontaneous&&turns<maxTurns){
      const action=await spontaneous({status:runtime.status(),signal});
      turns++;
      if(action)onEvent(await runtime.send(action));
    }
    await runtime.flush();
    if(turns<maxTurns&&!signal?.aborted)try{await delay(intervalMs,null,{signal})}catch(error){if(error.name!=="AbortError")throw error}
  }
  return {turns,stopped:signal?.aborted?"aborted":"turn-limit"};
}
