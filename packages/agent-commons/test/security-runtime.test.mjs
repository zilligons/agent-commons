import test from "node:test";
import assert from "node:assert/strict";
import { AgentCommons,CommonsStore,RegistryTrust,Keychain,createProfile,signDocument,runAgentLoop,seal } from "../src/index.mjs";
import { isTransientTrustFailure, REQUIRED_STANDARDS } from "../src/trust.mjs";
import { assertPolicyIdentity } from "../src/spaces/policy.mjs";
import { CommonsCarrier } from "../src/carrier.mjs";
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


test("S7 T1 entry denies before validation or provider work",async()=>{
  const {keys,policy}=setup(1),k=keys[0]._identity;let calls=0;
  const trust=new RegistryTrust({policy,client:{resolve:()=>{calls++;throw new Error("provider")}},fetchImpl:()=>{calls++;throw new Error("provider")}});
  assert.equal((await trust.authorize(k.uuaid,k.publicKeyHex)).tier,"local-policy-pinned");
  await assert.rejects(trust.authorize("bad",k.publicKeyHex),{code:"AGENT_ONLY"});
  trust.denyPermanently();trust.denyPermanently();
  await assert.rejects(trust.authorize("bad","bad"),{code:"NOT_ADMITTED",transient:false});assert.equal(calls,0);
});
test("S7 T3 captured same-receiver method stays denied after freeze and policy replacement",async()=>{
  const {keys,policy}=setup(1),k=keys[0]._identity,trust=new RegistryTrust({policy}),cached=trust.authorize.bind(trust);
  const held=await cached(k.uuaid,k.publicKeyHex);trust.policy=Object.freeze(structuredClone(policy));Object.freeze(trust);
  assert.equal(RegistryTrust.isCanonicalTrust(trust),true);assert.equal((await cached(k.uuaid,k.publicKeyHex)).tier,"local-policy-pinned");trust.denyPermanently();
  await assert.rejects(cached(k.uuaid,k.publicKeyHex),{code:"NOT_ADMITTED"});assert.equal(held.tier,"local-policy-pinned");
  const replacement=new RegistryTrust({policy:structuredClone(policy)});replacement.denyPermanently();replacement.policy=structuredClone(policy);
  await assert.rejects(replacement.authorize(k.uuaid,k.publicKeyHex),{code:"NOT_ADMITTED"});
});
test("S7 T5 local final fence observes reentrant mode getter denial",async()=>{
  const {keys,policy}=setup(1),k=keys[0]._identity,trust=new RegistryTrust({policy});
  Object.defineProperty(policy,"mode",{get(){trust.denyPermanently();return "local"},configurable:true});
  await assert.rejects(trust.authorize(k.uuaid,k.publicKeyHex),{code:"NOT_ADMITTED"});
});
for(const pause of ["standards","resolve","verify"])test(`S7 T4 global final fence after ${pause}`,async()=>{
  const {keys,policy}=setup(1),k=keys[0]._identity,pins=Object.fromEntries(REQUIRED_STANDARDS.map(code=>[code,"a".repeat(64)]));
  const globalPolicy={...policy,mode:"global",offline:false,standardPins:pins};globalPolicy.agents[k.uuaid].credentialId="fixture-credential";
  const reached=Promise.withResolvers(),release=Promise.withResolvers();let paused=false;
  const trust=new RegistryTrust({policy:globalPolicy,env:{},client:{
    resolve:async()=>{if(pause==="resolve"){paused=true;reached.resolve();await release.promise}return {uuaid:k.uuaid,status:"active"}},
    verify:async()=>{if(pause==="verify"){paused=true;reached.resolve();await release.promise}return {credential_id:"fixture-credential",agent_uuaid:k.uuaid,valid:true,signatureValid:true,active:true,notExpired:true}},
  },fetchImpl:async()=>{if(pause==="standards"){paused=true;reached.resolve();await release.promise}return {ok:true,json:async()=>({standards:REQUIRED_STANDARDS.map(code=>({code,stage:"published",content_hash:pins[code]}))})}}});
  const pending=trust.authorize(k.uuaid,k.publicKeyHex),rejected=assert.rejects(pending,{code:"NOT_ADMITTED"});
  await reached.promise;assert.equal(paused,true);trust.denyPermanently();release.resolve();await rejected;
  const healthy=new RegistryTrust({policy:globalPolicy,env:{},client:{resolve:async()=>({uuaid:k.uuaid,status:"active"}),verify:async()=>({credential_id:"fixture-credential",agent_uuaid:k.uuaid,valid:true,signatureValid:true,active:true,notExpired:true})},fetchImpl:async()=>({ok:true,json:async()=>({standards:REQUIRED_STANDARDS.map(code=>({code,stage:"published",content_hash:pins[code]}))})})});
  assert.equal((await healthy.authorize(k.uuaid,k.publicKeyHex)).tier,"registry-credential-and-policy");
});
test("S7 global result construction precedes the final fence",async()=>{
  const {keys,policy}=setup(1),k=keys[0]._identity,pins=Object.fromEntries(REQUIRED_STANDARDS.map(code=>[code,"b".repeat(64)]));let reads=0,trust;
  const binding=policy.agents[k.uuaid];Object.defineProperty(binding,"credentialId",{get(){if(++reads===4)trust.denyPermanently();return "fixture-credential"}});
  trust=new RegistryTrust({policy:{...policy,mode:"global",offline:false,standardPins:pins},env:{},client:{resolve:async()=>({uuaid:k.uuaid,status:"active"}),verify:async()=>({credential_id:"fixture-credential",agent_uuaid:k.uuaid,valid:true,signatureValid:true,active:true,notExpired:true})},fetchImpl:async()=>({ok:true,json:async()=>({standards:REQUIRED_STANDARDS.map(code=>({code,stage:"published",content_hash:pins[code]}))})})});
  await assert.rejects(trust.authorize(k.uuaid,k.publicKeyHex),{code:"NOT_ADMITTED"});assert.equal(reads,4);
});
test("S7 T9 brand refuses a prototype-shaped impostor without other masking guards",()=>{
  const policy={mode:"local"},impostor=Object.assign(Object.create(RegistryTrust.prototype),{policy});
  assert.equal(RegistryTrust.isCanonicalTrust(impostor),false);assert.throws(()=>assertPolicyIdentity({policy,trust:impostor}),{name:"PolicyIdentityError"});
  const genuine=new RegistryTrust({policy,client:{}});assert.equal(RegistryTrust.isCanonicalTrust(genuine),true);assert.equal(assertPolicyIdentity({policy,trust:genuine}),policy);
});
for(const kind of ["getter","throwing","alternating","shadow"])test(`S7 T9 own ${kind} route rejected without getter invocation`,()=>{
  const policy={mode:"local"},trust=new RegistryTrust({policy,client:{}}),canonical=trust.authorize;let reads=0;
  Object.defineProperty(trust,"authorize",kind==="shadow"?{value:()=>true}:{get(){reads++;if(kind==="throwing")throw new Error("getter invoked");return kind==="alternating"&&reads>1?()=>true:canonical}});
  assert.equal(RegistryTrust.isCanonicalTrust(trust),false);assert.throws(()=>assertPolicyIdentity({policy,trust}),{name:"PolicyIdentityError"});assert.equal(reads,0);
});
test("S7 T9 ordinary Sub admission exclusion paired with M5",()=>{
  class Sub extends RegistryTrust {}
  const policy={mode:"local"},trust=new Sub({policy,client:{}});
  assert.equal(RegistryTrust.isCanonicalTrust(trust),false);assert.throws(()=>assertPolicyIdentity({policy,trust}),{name:"PolicyIdentityError"});
});
for(const kind of ["data","throwing","stalling-recorder"])test(`S7 T9 Proxy-node ${kind} observer sees no descriptor or prototype operation`,()=>{
  const trust=new RegistryTrust({policy:{mode:"local"},client:{}}),canonical=trust.authorize;let operations=0;
  const node=new Proxy(Object.create(RegistryTrust.prototype),{getOwnPropertyDescriptor(){operations++;if(kind!=="data")throw new Error("recorded unsafe trap; no actual stall");return {value:canonical,configurable:true,writable:true}},getPrototypeOf(){operations++;return RegistryTrust.prototype}});
  Object.setPrototypeOf(trust,node);let result,error;try{result=RegistryTrust.isCanonicalTrust(trust)}catch(caught){error=caught}
  assert.equal(operations,0);assert.ifError(error);assert.equal(result,false);
});
test("S7 T9 Proxy-of-genuine brand short-circuit performs no object operation",()=>{
  const trust=new RegistryTrust({policy:{mode:"local"},client:{}});let operations=0;
  const proxy=new Proxy(trust,{get(){operations++;throw new Error("get")},getOwnPropertyDescriptor(){operations++;throw new Error("descriptor")},getPrototypeOf(){operations++;throw new Error("prototype")}});
  assert.equal(RegistryTrust.isCanonicalTrust(proxy),false);assert.equal(operations,0);
});
test("S7 T9 captured anchor rejects a replaced prototype data function",()=>{
  const descriptor=Object.getOwnPropertyDescriptor(RegistryTrust.prototype,"authorize"),trust=new RegistryTrust({policy:{mode:"local"},client:{}});
  try{Object.defineProperty(RegistryTrust.prototype,"authorize",{...descriptor,value:()=>true});assert.equal(RegistryTrust.isCanonicalTrust(trust),false)}finally{Object.defineProperty(RegistryTrust.prototype,"authorize",descriptor)}
});
test("S7 T9 captured anchor never invokes a live prototype getter",()=>{
  const descriptor=Object.getOwnPropertyDescriptor(RegistryTrust.prototype,"authorize"),trust=new RegistryTrust({policy:{mode:"local"},client:{}});let reads=0;
  Object.defineProperty(trust,"authorize",{value:descriptor.value});
  try{Object.defineProperty(RegistryTrust.prototype,"authorize",{configurable:true,get(){reads++;return descriptor.value}});assert.equal(RegistryTrust.isCanonicalTrust(trust),true);assert.equal(reads,0)}finally{Object.defineProperty(RegistryTrust.prototype,"authorize",descriptor)}
});
test("S7 native runtime and public carrier consumers use permanent denial",async()=>{
  const {keys,runtimes:[a,b],profile}=setup(2);const message=await a.send({recipient:b.uuaid,profileId:profile.id,body:"semantic equivalence"});
  b.trust.denyPermanently();await assert.rejects(b.receive(message.envelope),{code:"NOT_ADMITTED"});
  a.trust.denyPermanently();await assert.rejects(a.send({recipient:b.uuaid,profileId:profile.id,body:"semantic equivalence"}),{code:"NOT_ADMITTED"});
  const trust=new RegistryTrust({policy:{mode:"global",agents:{}},client:{}});trust.denyPermanently();const carrier=new CommonsCarrier({trust,keychain:keys[0],publicUrl:"https://carrier.invalid"});
  try{await assert.rejects(carrier.listen(0,"0.0.0.0"),{code:"NOT_ADMITTED"});assert.equal(carrier.server,null)}finally{carrier.store.close()}
});


test("S7 P6 canonical trust uses object intrinsics captured before post-load replacement",()=>{
  const genuine=new RegistryTrust({policy:{mode:"local"},client:{}}),proxy=new Proxy(genuine,{});
  class Sub extends RegistryTrust {}
  const sub=new Sub({policy:{mode:"local"},client:{}}),accessor=new RegistryTrust({policy:{mode:"local"},client:{}});let accessorHits=0,stubHits=0,verdicts;
  Object.defineProperty(accessor,"authorize",{get(){accessorHits++;return genuine.authorize}});
  const descriptor=Object.getOwnPropertyDescriptor,prototype=Object.getPrototypeOf;
  const hostile=()=>{stubHits++;throw new Error("post-load object intrinsic invoked")};
  try{
    Object.getOwnPropertyDescriptor=hostile;Object.getPrototypeOf=hostile;
    verdicts=[genuine,proxy,sub,accessor].map(value=>RegistryTrust.isCanonicalTrust(value));
  }finally{Object.getOwnPropertyDescriptor=descriptor;Object.getPrototypeOf=prototype}
  assert.deepEqual(verdicts,[true,false,false,false]);assert.equal(stubHits,0);assert.equal(accessorHits,0);
});
