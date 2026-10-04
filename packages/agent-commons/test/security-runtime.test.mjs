import test from "node:test";
import assert from "node:assert/strict";
import { AgentCommons,CommonsStore,RegistryTrust,Keychain,createProfile,signDocument,runAgentLoop,seal } from "../src/index.mjs";
import { isTransientTrustFailure } from "../src/trust.mjs";
const CAPS=["commons:message","commons:relay","commons:evolve","commons:contribute","commons:recover"];
function key(){const k=new Keychain("unused");k._identity=Keychain.generate();return k}
function setup(n=3){
  const keys=Array.from({length:n},key);
  const policy={mode:"local",agents:Object.fromEntries(keys.map(k=>[k._identity.uuaid,{kind:"agent",publicKey:k._identity.publicKeyHex,capabilities:CAPS}]))};
  const runtimes=keys.map(k=>new AgentCommons({keychain:k,policy}));
  const profile=createProfile({namespace:"test/sec",name:"Security fixture",fixtures:["Require semantic equivalence and semantic equivalence.","Preserve semantic equivalence before accepting a profile."]});
  runtimes.forEach(r=>r.addProfile(profile));
  return {keys,policy,runtimes,profile};
}
// --- Duplicate-key quorum (B3) ---
test("one key admitted under two UUAID spellings is denied (policy-level Sybil)",async()=>{
  const {keys,policy}=setup(2);const k=keys[0]._identity;
  const alias=k.uuaid.replace(":foundation:",":spoof:");
  policy.agents[alias]={...policy.agents[k.uuaid]};
  const trust=new RegistryTrust({policy});
  await assert.rejects(trust.authorize(k.uuaid,k.publicKeyHex,"commons:evolve"),/more than one UUAID/);
  await assert.rejects(trust.authorize(alias,k.publicKeyHex,"commons:evolve"),/more than one UUAID/);
});
test("proposer's key cannot approve its own proposal through a second spelling, and one key cannot double-vote",async()=>{
  const {keys,policy,runtimes:[a,b,c],profile}=setup(3);
  const p=await a.propose(profile.id,"semantic equivalence");
  await a.apply(await b.vote(p.payload.proposal.id,true));
  // Forge-free scenario: same key, different issuer string, signed with the real key. Admission is denied at policy level.
  const alias=keys[1]._identity.uuaid.replace(":foundation:",":spoof:");
  policy.agents[alias]={...policy.agents[keys[1]._identity.uuaid]};
  const spoof={...keys[1],_identity:{...keys[1]._identity,uuaid:alias},sign:data=>keys[1].sign(data)};
  const doc=signDocument(spoof,"profile-vote",{proposalId:p.payload.proposal.id,approve:true,rationale:"dup"});
  await assert.rejects(a.apply(doc),/more than one UUAID|Ineligible/);
  assert.equal(a.profiles().length,1);
});
// --- Reliable cursors / trust outage (H1-H3) ---
test("transient trust failure does not advance the cursor or drop the message; it is delivered after recovery",async()=>{
  const {keys,policy,runtimes:[a,b],profile}=setup(2);
  const sent=await a.send({recipient:b.uuaid,profileId:profile.id,body:"semantic equivalence"});
  const rt=new AgentCommons({keychain:keys[1],policy,carriers:["http://c.invalid"]});rt.addProfile(profile);
  rt.transport.fetchInbox=async(_c,{since})=>({envelopes:[{seq:7,envelope:sent.envelope}].filter(x=>x.seq>since)});
  let down=true;const real=rt.trust.authorize.bind(rt.trust);
  rt.trust.authorize=async(...args)=>{if(down){const {TrustError}=await import("../src/trust.mjs");throw new TrustError("AUTHORITY_UNAVAILABLE","down",{transient:true})}return real(...args)};
  const first=await rt.poll();
  assert.equal(first[0].deferred,true);assert.equal(rt.store.get("cursors",{})["http://c.invalid"]??0,0);
  down=false;rt.store.set("carrierHealth",{});
  const second=await rt.poll();
  assert.equal(second[0].body,"semantic equivalence");assert.equal(rt.store.get("cursors")["http://c.invalid"],7);
});
test("permanent rejection still advances the cursor; carrier cannot rewind sequence numbers",async()=>{
  const {keys,policy,runtimes:[a,b],profile}=setup(2);
  const m1=await a.send({recipient:b.uuaid,profileId:profile.id,body:"semantic equivalence"});
  const rt=new AgentCommons({keychain:keys[1],policy,carriers:["http://c.invalid"]});rt.addProfile(profile);
  const bad={id:"garbage"};
  rt.transport.fetchInbox=async()=>({envelopes:[{seq:5,envelope:bad},{seq:3,envelope:m1.envelope}]});
  const r=await rt.poll();
  assert.equal(r[0].rejected,true);assert.equal(r[1].reason,"non-monotonic-carrier-sequence");
  assert.equal(rt.store.get("cursors")["http://c.invalid"],5);
});
test("transient classification: network errors transient, registry 4xx permanent",()=>{
  assert.equal(isTransientTrustFailure(new Error("ECONNRESET")),true);
  assert.equal(isTransientTrustFailure(Object.assign(new Error("x"),{status:503})),true);
  assert.equal(isTransientTrustFailure(Object.assign(new Error("x"),{status:404})),false);
});
test("a peer-chosen message ID cannot censor a signed control document with the same ID",async()=>{
  const {keys,runtimes:[a,b,c],profile}=setup(3);
  const p=await a.propose(profile.id,"semantic equivalence");
  const vote=await b.vote(p.payload.proposal.id,true);
  // Attacker c delivers a plain message whose payload.id equals the vote document ID, using a's real receive path.
  const payload={v:"agent-commons/1",id:vote.id,kind:"message",thread:"t",profileId:profile.id,wire:"hello",bodyHash:(await import("../src/profiles.mjs")).digest("hello"),expiresAt:new Date(Date.now()+60000).toISOString()};
  const env=seal(keys[2],{recipient:a.uuaid,recipientPublicKey:a.publicKey,kind:"agent-commons/1",payload});
  const got=await a.receive(env);assert.equal(got.body,"hello");
  assert.equal((await a.apply(vote)).status,"pending");
});
// --- Budget loop (B4) ---
function fakeRuntime(){
  const store=new CommonsStore();let inbound=0;const sent=[];
  return {store,sent,policy:{agents:{peer:{}}},status:()=>({}),flush:async()=>[],
    poll:async()=>[{id:`m${inbound++}`,sender:"peer",profileId:"p",thread:"t",body:"ping"}],
    send:async a=>{sent.push(a);return {id:"x"}}};
}
test("reply ping-pong stops at the per-peer run budget and records a refusal",async()=>{
  const rt=fakeRuntime();
  const r=await runAgentLoop({runtime:rt,respond:async()=>"pong",maxTurns:100,intervalMs:500,budget:{maxRepliesPerPeer:3}});
  assert.equal(rt.sent.length,3);assert.equal(r.stopped,"budget:run-peer-replies");
  assert.ok(rt.store.audit().some(e=>e.body.includes("loop-budget-stop")));
});
test("persisted window budget survives loop restarts",async()=>{
  const rt=fakeRuntime();
  for(let i=0;i<3;i++)await runAgentLoop({runtime:rt,respond:async()=>"pong",maxTurns:2,intervalMs:500,budget:{windowMaxSends:3}});
  assert.equal(rt.sent.length,3);
});
test("spontaneous action cannot be a control message or target an unadmitted peer",async()=>{
  const rt=fakeRuntime();rt.poll=async()=>[];const events=[];
  await runAgentLoop({runtime:rt,respond:async()=>null,spontaneous:async()=>({recipient:"peer",kind:"profile-control",body:"{}"}),maxTurns:1,intervalMs:500,onEvent:e=>events.push(e)});
  await runAgentLoop({runtime:rt,respond:async()=>null,spontaneous:async()=>({recipient:"stranger",body:"hi"}),maxTurns:1,intervalMs:500,onEvent:e=>events.push(e)});
  assert.equal(rt.sent.length,0);assert.equal(events.filter(e=>e.state==="spontaneous-action-refused").length,2);
});
test("budget values above hard ceilings are rejected; responder failure does not kill the loop",async()=>{
  const rt=fakeRuntime();
  await assert.rejects(runAgentLoop({runtime:rt,respond:async()=>null,budget:{maxSends:100000}}),/Invalid loop budget/);
  const r=await runAgentLoop({runtime:rt,respond:async()=>{throw new Error("model down")},maxTurns:2,intervalMs:500});
  assert.equal(r.turns,2);
});
