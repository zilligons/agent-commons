/**
 * Real-adapter bootstrap. No simulated model response and no credentials embedded.
 *
 * node examples/run-cohort.mjs <cohort-home> <adapter-module.mjs> <run-id> <goal>
 *
 * The explicitly selected local adapter module must export `complete(request)`.
 * It owns provider-specific authentication, model mapping, token telemetry and
 * cancellation. Internal Computer model IDs are not public vendor API IDs.
 */
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  cohortStatus, loadRuntime, ContinuityMemory, CollaborationScheduler, Keychain,
  createFilePersistence, rosterFromModels,
} from "../src/index.mjs";

const [home,adapterPath,runId,goal="Improve one bounded Agent Commons module"]=process.argv.slice(2);
if(!home||!adapterPath||!runId)throw new Error("Usage: run-cohort.mjs <cohort-home> <explicit local adapter-module> <run-id> [goal]");
const manifest=cohortStatus(home);
const adapter=await import(pathToFileURL(resolve(adapterPath)).href);
if(typeof adapter.complete!=="function")throw new Error("Adapter module must export complete(request); no automatic fallback is supplied");
const nodes=manifest.members.map(m=>loadRuntime(m.home));
const journals=nodes.map(n=>new ContinuityMemory({keychain:n.keychain,store:n.store}));
const roster=rosterFromModels(manifest.members.map(m=>m.model));
const bySlot=new Map(roster.map((slot,i)=>[slot.id,journals[i]]));
const controller=new AbortController();
process.once("SIGINT",()=>controller.abort("Operator cancellation"));
process.once("SIGTERM",()=>controller.abort("Host shutdown"));
const artifactDir=join(resolve(home),"artifacts");mkdirSync(artifactDir,{recursive:true,mode:0o700});
const memory={
  async recall({slot,runId}) {
    const journal=bySlot.get(slot);if(!journal?.verify())throw new Error("Identity continuity verification failed");
    return journal.recall({limit:12}).filter(e=>e.content?.runId===runId).map(e=>({kind:e.kind,data:e.content}));
  },
  async record(event) {
    // Slot-specific reasoning is private to that identity. Shared outcomes are
    // recorded independently in each journal with explicit tool provenance.
    const owners=event.slot&&bySlot.has(event.slot)?[bySlot.get(event.slot)]:journals;
    for(const journal of owners)journal.remember("collaboration:event",JSON.parse(JSON.stringify(event)),{source:"tool",origin:"collaboration-scheduler"});
  },
};
try{
  const scheduler=new CollaborationScheduler({
    model:{complete:request=>adapter.complete({...request,
      identity:manifest.members[roster.findIndex(s=>s.id===request.slot.id)],
    })},
    roster,persistence:createFilePersistence(join(resolve(home),"runs"),{integrity:{
      sign:bytes=>nodes[0].keychain.sign(bytes).toString("hex"),
      verify:(bytes,signature)=>Keychain.verifyDetached(nodes[0].runtime.publicKey,bytes,Buffer.from(signature,"hex")),
    }}),memory,
    signal:controller.signal,
    limits:{maxRounds:4,maxTokens:64000,maxTokensPerCall:1800,maxDurationMs:480000,maxConcurrency:2,maxTasks:7},
    verifier:typeof adapter.verify==="function"?{verify:adapter.verify}:null,
    artifacts:{async put(artifact) {
      // Proposed files only. Nothing is applied to the source tree automatically.
      const path=join(artifactDir,`${artifact.hash}.json`);
      writeFileSync(path,JSON.stringify(artifact,null,2),{mode:0o600});
      return {path};
    }},
  });
  const result=await scheduler.run({runId,goal,needs:{
    objective:goal,acceptanceCriteria:"A minimal reviewable proposal with independent review and real host test evidence.",
    allowedPaths:["packages/agent-commons/src","packages/agent-commons/test","docs"],
    constraints:"No trust-policy, budget, credential, release, constitution or admission changes. No public propagation without consent.",
  }});
  console.log(JSON.stringify(result,null,2));
}finally{for(const node of nodes)node.store.close()}
