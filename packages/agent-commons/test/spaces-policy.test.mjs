import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentCommons, Keychain, createProfile, digest, signDocument, proposeAlias, seal } from "../src/index.mjs";
import { buildGenesis, buildNext, signManifest, newRecord } from "../src/vendor/pillar/groups-v2.mjs";
import { SpaceStore, ADAPTER_V, PENDING_TTL_MS } from "../src/spaces/store.mjs";
import { signAndApplyNext, verifiedHead } from "../src/spaces/manifest.mjs";
import { SpacePolicy, assertPolicyIdentity } from "../src/spaces/policy.mjs";

function fixture(t){
  const home=mkdtempSync("/tmp/spaces-policy-"),store=new SpaceStore(home),keys=Array.from({length:4},()=>{const k=new Keychain("unused");k._identity=Keychain.generate();return k});
  const [owner,member,invited,outsider]=keys,uid=k=>k._identity.uuaid,key=k=>k._identity.publicKeyHex;
  const profile=createProfile({namespace:"local/space-policy",name:"Policy fixture",scope:"local",lexicon:{},fixtures:["Repeated protocol phrase Repeated protocol phrase", "Repeated protocol phrase Repeated protocol phrase"]});
  const commons={v:"commons/1",profile:{id:profile.id,hash:digest(profile)},tenant:null};
  const genesis=signManifest(buildGenesis({name:"Policy fixture",creator:owner._identity,members:[member,invited].map(k=>({uuaid:uid(k),key:key(k)})),ext:{commons}}),owner._identity);
  store.saveRoster(newRecord([genesis]));
  signAndApplyNext(store,genesis.id,owner,"accept",{target:uid(member),request:"accept-fixture"});
  const state={v:ADAPTER_V,groupId:genesis.id,channels:{content:`channel://agentnet/group/${genesis.id}`,control:`channel://agentnet/group-ctl/${genesis.id}`},profile:commons.profile,consent:{manifestVersion:2,charterHash:"c".repeat(64),carriers:[]},hardStop:null,softStop:null,pendingRemovals:[],heldRefs:[]};
  store.saveAdapter(genesis.id,state);
  const policy={mode:"local",offline:true,agents:Object.fromEntries(keys.slice(0,3).map(k=>[uid(k),{kind:"agent",publicKey:key(k),capabilities:["commons:message"]}]))};
  const engine=new AgentCommons({keychain:owner,policy});engine.addProfile(profile);
  const signals=[],allowlist=keys.slice(0,3).map(k=>({uuaid:uid(k),key:key(k)}));let now=Date.now();
  const options={engine,store,groupId:genesis.id,allowlist,onSignal:signal=>signals.push(signal),clock:()=>now};
  const writer=new SpacePolicy(options);
  t.after(()=>{engine.store.close();rmSync(home,{recursive:true,force:true})});
  return {home,store,keys,owner,member,invited,outsider,uid,key,profile,commons,groupId:genesis.id,policy,engine,signals,allowlist,writer,options,content:state.channels.content,control:state.channels.control,advance:ms=>{now+=ms}};
}
const adapter=f=>f.store.loadAdapter(f.groupId).state;
function receivedChange(f,action,opts){signAndApplyNext(f.store,f.groupId,f.owner,action,opts);return f.writer.rebuild()}
function assertClosed(f){assert.deepEqual(f.policy.agents,{});assert.deepEqual(f.policy.tenantProfiles,{});assert.deepEqual(f.policy.channels,{[f.content]:{members:[]},[f.control]:{members:[]}})}
const consent=f=>({...adapter(f).consent,manifestVersion:verifiedHead(f.store.loadRoster(f.groupId)).version});

test("P-2 vectors 23/36: every roster record has only message authority at the real gate",async t=>{
  const f=fixture(t);assert.equal(Object.keys(f.policy.agents).length,3);
  for(const k of f.keys.slice(0,3)){
    assert.deepEqual(f.policy.agents[f.uid(k)],{kind:"agent",publicKey:f.key(k),capabilities:["commons:message"]});
    await f.engine.trust.authorize(f.uid(k),f.key(k),"commons:message");
    for(const capability of ["commons:evolve","commons:contribute","commons:recover"])await assert.rejects(f.engine.trust.authorize(f.uid(k),f.key(k),capability),{code:"NOT_ADMITTED"});
  }
  const document=signDocument(f.owner,"profile-proposal",{proposal:proposeAlias(f.profile,"Repeated protocol phrase")}),body=JSON.stringify(document);
  const envelope=seal(f.member,{recipient:f.uid(f.owner),recipientPublicKey:f.key(f.owner),kind:"agent-commons/1",payload:{v:"agent-commons/1",id:randomUUID(),kind:"profile-control",thread:f.content,profileId:f.profile.id,wire:body,bodyHash:digest(body),expiresAt:new Date(Date.now()+3600000).toISOString()}});
  await assert.rejects(f.engine.receive(envelope),{code:"NOT_ADMITTED"});assert.deepEqual(f.engine.store.get("proposals",[]),[]);
});
test("P-5 leave removes content authority before actual engine flush",async t=>{
  const f=fixture(t),deliveries=[];
  const peer=new AgentCommons({keychain:f.member,policy:f.policy,transport:{deliver:async envelope=>{deliveries.push(envelope);return {accepted:true}}}});peer.addProfile(f.profile);t.after(()=>peer.store.close());
  const queued=await peer.send({recipient:f.uid(f.owner),profileId:f.profile.id,thread:f.content,body:"leave fixture",deferFlush:true});
  const rec=f.store.loadRoster(f.groupId);rec.leaving.push(f.uid(f.member));f.store.saveRoster(rec);f.writer.rebuild();
  assert.equal(f.policy.channels[f.content].members.includes(f.uid(f.member)),false);assert.equal(f.policy.channels[f.control].members.includes(f.uid(f.member)),true);
  const result=await peer.flush();assert.equal(result[0].id,queued.envelope.id);assert.equal(result[0].state,"retry-or-quarantine");assert.equal(deliveries.length,0);
});
for(const action of ["remove","leave"])test(`P-7 own ${action} retains pending authority with the caller's reserved id`,async t=>{
  const f=fixture(t),outboxId=`reserved-${action}`;
  const result=f.writer.applyOwnChange(action,{target:f.uid(f.member),...(action==="leave"?{request:"leave-fixture"}:{})},{outboxId});
  assert.equal(verifiedHead(result.record).members.find(row=>row.uuaid===f.uid(f.member)).status,"removed");
  const pending=adapter(f).pendingRemovals;assert.equal(pending.length,1);assert.deepEqual(pending[0],{uuaid:f.uid(f.member),key:f.key(f.member),manifestVersion:result.manifest.version,queuedAt:pending[0].queuedAt,outboxId});
  assert.equal(f.policy.channels[f.content].members.includes(f.uid(f.member)),false);assert.equal(f.policy.channels[f.control].members.includes(f.uid(f.member)),true);
  await f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message");
  f.advance(PENDING_TTL_MS+1);f.writer.rebuild();assert.equal(f.policy.agents[f.uid(f.member)],undefined);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
test("P-7 invalid reserved id refuses before either file is changed",t=>{
  const f=fixture(t),roster=readFileSync(f.store.rosterPath(f.groupId)),state=readFileSync(f.store.adapterPath(f.groupId));
  assert.throws(()=>f.writer.applyOwnChange("remove",{target:f.uid(f.member)}),{name:"AdapterStateError"});
  assert.deepEqual(readFileSync(f.store.rosterPath(f.groupId)),roster);assert.deepEqual(readFileSync(f.store.adapterPath(f.groupId)),state);
});
test("C20 roster-first crash persists removal and restart narrows authority",async t=>{
  const f=fixture(t),roster=f.store.saveRoster.bind(f.store),save=f.store.saveAdapter.bind(f.store);let writes=0;
  const crash=()=>{if(++writes===1)throw new Error("crash between the two files")};
  f.store.saveRoster=rec=>{roster(rec);crash()};f.store.saveAdapter=(id,state)=>{save(id,state);crash()};
  assert.throws(()=>f.writer.applyOwnChange("remove",{target:f.uid(f.member)},{outboxId:"reserved-crash"}),/crash between/);assert.equal(writes,1);
  const fresh=new SpaceStore(f.home),head=verifiedHead(fresh.loadRoster(f.groupId));assert.equal(head.members.find(row=>row.uuaid===f.uid(f.member)).status,"removed");
  const engine=new AgentCommons({keychain:f.owner,policy:{mode:"local",agents:{}}});t.after(()=>engine.store.close());
  new SpacePolicy({...f.options,store:fresh,engine});
  assert.equal(engine.policy.agents[f.uid(f.member)],undefined);assert.equal(Object.values(engine.policy.channels).some(channel=>channel.members.includes(f.uid(f.member))),false);
  assert.equal(fresh.loadAdapter(f.groupId).state.pendingRemovals.length,0);
  await assert.rejects(engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
for(const tamper of ["record","capability","channel","identity"])test(`P-9 ${tamper} mismatch closes and persists the operator signal`,t=>{
  const f=fixture(t);let observed=false;
  f.writer.onSignal=signal=>{f.signals.push(signal);assertClosed(f);assert.equal(adapter(f).hardStop.reason,"policy-mismatch");observed=true};
  if(tamper==="record")delete f.policy.agents[f.uid(f.member)];
  if(tamper==="capability")f.policy.agents[f.uid(f.member)].capabilities.push("commons:evolve");
  if(tamper==="channel")f.policy.channels[f.content].members.push(f.uid(f.outsider));
  if(tamper==="identity")f.engine.trust.policy={...f.policy};
  assert.equal(f.writer.check(),false);assert.equal(observed,true);assertClosed(f);assert.equal(adapter(f).hardStop.reason,"policy-mismatch");
});
test("CL-1..4 close then safe head in one batch stays closed and restart preserves the latch",t=>{
  const f=fixture(t);receivedChange(f,"invite",{member:{uuaid:f.uid(f.outsider),key:f.key(f.outsider)}});assertClosed(f);
  const stop=adapter(f).hardStop;assert.equal(stop.reason,"outsider");
  receivedChange(f,"remove",{target:f.uid(f.outsider)});assertClosed(f);assert.deepEqual(adapter(f).hardStop,stop);assert.equal(f.writer.check(),true);
  const fresh=new SpaceStore(f.home),engine=new AgentCommons({keychain:f.owner,policy:{mode:"local",agents:{}}});t.after(()=>engine.store.close());
  new SpacePolicy({...f.options,store:fresh,engine});assert.deepEqual(engine.policy.agents,{});assert.equal(Object.values(engine.policy.channels).every(c=>c.members.length===0),true);
});
for(const change of ["profile","tenant"])test(`HS-1..4 hard stop survives ${change} soft stop and reconsent`,t=>{
  const f=fixture(t);receivedChange(f,"invite",{member:{uuaid:f.uid(f.outsider),key:f.key(f.outsider)}});const hard=adapter(f).hardStop;
  const next=structuredClone(f.commons);if(change==="profile")next.profile={id:"new-profile",hash:"d".repeat(64)};else next.tenant="tenant-next";
  receivedChange(f,"ext_update",{ext:{commons:next}});assert.equal(adapter(f).softStop.reason,"reconsent");assert.deepEqual(adapter(f).hardStop,hard);assertClosed(f);
  f.writer.reconsent(consent(f));assert.equal(adapter(f).softStop,null);assert.deepEqual(adapter(f).hardStop,hard);assertClosed(f);assert.equal(f.writer.check(),true);
  assert.throws(()=>f.writer.hardResume(),{name:"OutsiderError"});assertClosed(f);
  receivedChange(f,"remove",{target:f.uid(f.outsider)});f.writer.hardResume();assert.equal(adapter(f).hardStop,null);assert.equal(Object.keys(f.policy.agents).length,3);
});
test("HS-3 hard resume retains an outstanding soft stop",t=>{
  const f=fixture(t);delete f.policy.agents[f.uid(f.member)];f.writer.check();
  receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"changed"}}});
  f.writer.hardResume();assert.equal(adapter(f).hardStop,null);assert.equal(adapter(f).softStop.reason,"reconsent");assert.deepEqual(f.policy.channels[f.content].members,[]);assert.equal(f.policy.channels[f.control].members.length,3);
});
test("HS-2 reconsent of a safe head cannot clear the earlier hard latch",t=>{
  const f=fixture(t);receivedChange(f,"invite",{member:{uuaid:f.uid(f.outsider),key:f.key(f.outsider)}});const hard=adapter(f).hardStop;
  receivedChange(f,"remove",{target:f.uid(f.outsider)});receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"changed"}}});
  f.writer.reconsent(consent(f));assert.deepEqual(adapter(f).hardStop,hard);assertClosed(f);assert.equal(f.writer.check(),true);
});
for(const field of ["profile","tenant"])test(`P-12 ${field} change then revert never clears the soft stop`,t=>{
  const f=fixture(t),changed=structuredClone(f.commons);if(field==="profile")changed.profile={id:"new-profile",hash:"e".repeat(64)};else changed.tenant="new-tenant";
  receivedChange(f,"ext_update",{ext:{commons:changed}});const soft=adapter(f).softStop;assert.equal(soft.reason,"reconsent");
  receivedChange(f,"ext_update",{ext:{commons:f.commons}});assert.deepEqual(adapter(f).softStop,soft);assert.deepEqual(f.policy.channels[f.content].members,[]);assert.equal(f.policy.channels[f.control].members.length,3);
  new SpacePolicy(f.options);assert.deepEqual(adapter(f).softStop,soft);assert.deepEqual(f.policy.channels[f.content].members,[]);
});
for(const status of ["invited","active","pending"])test(`A-1/A-4 ${status} outsider closes before the synchronous signal`,t=>{
  const f=fixture(t);
  if(status==="pending"){
    // A removed, still-pending member excluded by the operator's current allowlist.
    f.writer.applyOwnChange("remove",{target:f.uid(f.member)},{outboxId:"pending-outsider"});f.allowlist.splice(f.allowlist.findIndex(row=>row.uuaid===f.uid(f.member)),1);
  }else{
    signAndApplyNext(f.store,f.groupId,f.owner,"invite",{member:{uuaid:f.uid(f.outsider),key:f.key(f.outsider)}});
    if(status==="active")signAndApplyNext(f.store,f.groupId,f.owner,"accept",{target:f.uid(f.outsider),request:"accept-outsider"});
  }
  let signal=0;f.writer.onSignal=event=>{assert.equal(event.reason,"outsider");assertClosed(f);assert.equal(adapter(f).hardStop.reason,"outsider");signal++};
  const result=f.writer.rebuild();assert.equal(result,f.policy);assert.equal(result instanceof Promise,false);assert.equal(signal,1);assertClosed(f);
});
test("A-1 allowlist matches both the full uuaid and key",t=>{
  const f=fixture(t);f.allowlist.find(row=>row.uuaid===f.uid(f.member)).key=f.key(f.outsider);f.writer.rebuild();assertClosed(f);assert.equal(adapter(f).hardStop.reason,"outsider");
});
test("I-3 vector 37 updates in place and the REAL gate drops the old key, admits the new one",async t=>{
  const f=fixture(t),policy=f.engine.policy;await f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message");
  receivedChange(f,"remove",{target:f.uid(f.member)});f.allowlist.push({uuaid:f.uid(f.outsider),key:f.key(f.outsider)});
  receivedChange(f,"invite",{member:{uuaid:f.uid(f.outsider),key:f.key(f.outsider)}});
  assert.equal(f.engine.policy,policy);assert.equal(f.engine.trust.policy,policy);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
  await f.engine.trust.authorize(f.uid(f.outsider),f.key(f.outsider),"commons:message");
});
for(const mode of ["frozen","other-trust","array","class"])test(`I-1 construction refuses ${mode} before a store read`,t=>{
  const f=fixture(t);let reads=0;f.store.loadAdapter=()=>{reads++;throw new Error("unexpected read")};
  if(mode==="frozen")Object.freeze(f.policy);
  if(mode==="other-trust")f.engine.trust.policy={...f.policy};
  if(mode==="array")f.engine.policy=f.engine.trust.policy=[];
  if(mode==="class")f.engine.policy=f.engine.trust.policy=new Date();
  assert.throws(()=>new SpacePolicy(f.options),{name:"PolicyIdentityError"});assert.equal(reads,0);
});
test("I-4 restart ignores the previous in-memory policy and rebuilds from verified files",t=>{
  const f=fixture(t);f.policy.agents[f.uid(f.outsider)]={kind:"agent",publicKey:f.key(f.outsider),capabilities:["commons:evolve"]};
  const engine=new AgentCommons({keychain:f.owner,policy:{mode:"local",agents:{}}});t.after(()=>engine.store.close());
  new SpacePolicy({...f.options,store:new SpaceStore(f.home),engine});assert.equal(engine.policy.agents[f.uid(f.outsider)],undefined);assert.equal(Object.keys(engine.policy.agents).length,3);
  assert.equal(existsSync(join(f.home,"spaces",f.groupId,"policy.json")),false);
});
test("P-6 self-removed instance has neither channel while key selfCheck remains separate",t=>{
  const f=fixture(t),engine=new AgentCommons({keychain:f.member,policy:{mode:"local",agents:{}}});t.after(()=>engine.store.close());
  const writer=new SpacePolicy({...f.options,engine});signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:f.uid(f.member)});writer.rebuild();
  assert.equal(engine.policy.agents[f.uid(f.member)],undefined);assert.equal(Object.values(engine.policy.channels).every(c=>c.members.length===0),true);
});
test("P-8 freeze uses only known non-removed control and no pending recipients",t=>{
  const f=fixture(t);f.writer.applyOwnChange("remove",{target:f.uid(f.member)},{outboxId:"freeze-pending"});
  const rec=f.store.loadRoster(f.groupId),head=verifiedHead(rec);
  rec.frozen={manifests:["a","b"].map(name=>signManifest(buildNext(head,"rename",{name}),f.owner._identity))};f.store.saveRoster(rec);f.writer.rebuild();
  assert.deepEqual(f.policy.channels[f.content].members,[]);assert.equal(f.policy.channels[f.control].members.includes(f.uid(f.member)),false);assert.equal(f.policy.channels[f.control].members.length,2);
});

const sorted=a=>[...a].sort();
const outsiderInvite=f=>({member:{uuaid:f.uid(f.outsider),key:f.key(f.outsider)}});
test("G1 content = active minus leavers; control = active + invited (positive composition)",t=>{
  const f=fixture(t);
  assert.deepEqual(sorted(f.policy.channels[f.content].members),sorted([f.uid(f.owner),f.uid(f.member)]));
  assert.deepEqual(sorted(f.policy.channels[f.control].members),sorted([f.uid(f.owner),f.uid(f.member),f.uid(f.invited)]));
  assert.equal(f.policy.channels[f.content].members.includes(f.uid(f.invited)),false);
});
test("G2 tenant binds every record and tenantProfiles; a null tenant leaves both absent",t=>{
  const f=fixture(t);
  assert.deepEqual(f.policy.tenantProfiles,{});for(const a of Object.values(f.policy.agents))assert.equal("tenantId" in a,false);
  receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"tenant-x"}}});
  assert.deepEqual(f.policy.tenantProfiles,{[f.profile.id]:"tenant-x"});assert.equal(Object.keys(f.policy.agents).length,3);
  for(const a of Object.values(f.policy.agents))assert.equal(a.tenantId,"tenant-x");
  assert.equal(f.writer.check(),true);
});
test("G3 reconsent naming a stale or future manifest refuses and writes nothing",t=>{
  const f=fixture(t);receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"t2"}}});
  const before=readFileSync(f.store.adapterPath(f.groupId));
  for(const v of [2,99])assert.throws(()=>f.writer.reconsent({...adapter(f).consent,manifestVersion:v}),{name:"ConsentHeadError"});
  assert.deepEqual(readFileSync(f.store.adapterPath(f.groupId)),before);assert.equal(adapter(f).softStop.reason,"reconsent");
});
test("G4 mode, channelsEnabled and holdBeforeAdmission are fixed in the open and the closed form",t=>{
  const f=fixture(t),fixed=p=>{assert.equal(p.mode,"local");assert.equal(p.channelsEnabled,true);assert.equal(p.holdBeforeAdmission,true)};
  fixed(f.policy);receivedChange(f,"invite",outsiderInvite(f));fixed(f.policy);assertClosed(f);
});
test("G5 SPACE_RECONSENT_REQUIRED is raised exactly once per stop across revert and restart",t=>{
  const f=fixture(t);receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"t2"}}});
  receivedChange(f,"ext_update",{ext:{commons:f.commons}});new SpacePolicy(f.options);
  const s=f.signals.filter(x=>x.code==="SPACE_RECONSENT_REQUIRED");assert.equal(s.length,1);assert.equal(s[0].groupId,f.groupId);
});
test("G6 a hash-only profile change (same id) sets the soft stop",t=>{
  const f=fixture(t),next=structuredClone(f.commons);next.profile={id:f.profile.id,hash:"f".repeat(64)};
  receivedChange(f,"ext_update",{ext:{commons:next}});assert.equal(adapter(f).softStop.reason,"reconsent");assert.deepEqual(f.policy.channels[f.content].members,[]);
});
test("G7 hardResume refuses while a pending removal is outside the allowlist",t=>{
  const f=fixture(t);f.writer.applyOwnChange("remove",{target:f.uid(f.member)},{outboxId:"pending-outsider"});
  f.allowlist.splice(f.allowlist.findIndex(r=>r.uuaid===f.uid(f.member)),1);f.writer.rebuild();assert.equal(adapter(f).hardStop.reason,"outsider");
  assert.throws(()=>f.writer.hardResume(),{name:"OutsiderError"});assert.equal(adapter(f).hardStop.reason,"outsider");assertClosed(f);
  f.allowlist.push({uuaid:f.uid(f.member),key:f.key(f.member)});f.writer.hardResume();assert.equal(adapter(f).hardStop,null);
});
test("G8 a consent naming a version outside the verified chain refuses the rebuild",t=>{
  const f=fixture(t),s=adapter(f);s.consent={...s.consent,manifestVersion:99};f.store.saveAdapter(f.groupId,s);
  assert.throws(()=>f.writer.rebuild(),{name:"ConsentHeadError"});
});
test("G9 the close signal carries code, group, reason and time",t=>{
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));
  const e=f.signals.find(x=>x.code==="SPACE_CLOSED");assert.ok(e);assert.deepEqual(Object.keys(e).sort(),["at","code","groupId","reason"]);
  assert.equal(e.groupId,f.groupId);assert.equal(e.reason,"outsider");assert.equal(e.at,adapter(f).hardStop.at);
});
test("G10 a keychain absent from the verified head refuses construction",t=>{
  const f=fixture(t),engine=new AgentCommons({keychain:f.outsider,policy:{mode:"local",agents:{}}});t.after(()=>engine.store.close());
  assert.throws(()=>new SpacePolicy({...f.options,engine}),{name:"SelfCheckError"});
});
test("G11 engine.policy reassigned to another object closes and latches",t=>{
  const f=fixture(t);f.engine.policy={...f.policy};
  assert.equal(f.writer.check(),false);assert.equal(adapter(f).hardStop.reason,"policy-mismatch");
});
test("G12 reconsent records the head profile and the current manifest in adapter state",t=>{
  const f=fixture(t),next=structuredClone(f.commons);next.profile={id:"new-profile",hash:"d".repeat(64)};
  receivedChange(f,"ext_update",{ext:{commons:next}});f.writer.reconsent(consent(f));
  assert.deepEqual(adapter(f).profile,next.profile);assert.equal(adapter(f).consent.manifestVersion,3);
});
test("G13 rebuild itself runs the P-9 self-check after its write",t=>{
  const f=fixture(t);f.engine.trust.policy={...f.policy};f.writer.rebuild();assert.equal(adapter(f).hardStop?.reason,"policy-mismatch");
});
test("G15 a restart under a latch writes CLOSED directly and keeps the original stop",t=>{
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));const hard=adapter(f).hardStop,before=f.signals.length;
  const seeded=new AgentCommons({keychain:f.owner,policy:{mode:"local",agents:Object.fromEntries(f.keys.slice(0,3).map(k=>[f.uid(k),{kind:"agent",publicKey:f.key(k),capabilities:["commons:message"]}]))}});t.after(()=>seeded.store.close());
  new SpacePolicy({...f.options,engine:seeded});
  assert.deepEqual(adapter(f).hardStop,hard);assert.equal(f.signals.length,before);assert.deepEqual(seeded.policy.agents,{});
  assert.deepEqual(seeded.policy.channels,{[f.content]:{members:[]},[f.control]:{members:[]}});
});

for(const reference of ["trust","engine"])test(`R1 C-1 ${reference} identity swap closes every gate policy`,async t=>{
  const f=fixture(t),copy={...f.policy};
  if(reference==="trust")f.engine.trust.policy=copy;else f.engine.policy=copy;
  assert.equal(f.writer.check(),false);assertClosed(f);assert.deepEqual(copy.agents,{});
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
test("R1 C-2 adapter write failure narrows the same process before rethrow",async t=>{
  const f=fixture(t),failure=new Error("adapter write failed");f.store.saveAdapter=()=>{throw failure};
  assert.throws(()=>f.writer.applyOwnChange("remove",{target:f.uid(f.member)},{outboxId:"r1-c2"}),e=>e===failure);
  assert.equal(verifiedHead(f.store.loadRoster(f.groupId)).members.find(r=>r.uuaid===f.uid(f.member)).status,"removed");
  assert.equal(f.policy.agents[f.uid(f.member)],undefined);assert.equal(f.policy.channels[f.content].members.includes(f.uid(f.member)),false);
  assert.equal(adapter(f).pendingRemovals.length,0);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
test("R1 C-3 an intermediate outsider since consent latches even after its removal",t=>{
  const f=fixture(t);signAndApplyNext(f.store,f.groupId,f.owner,"invite",outsiderInvite(f));signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:f.uid(f.outsider)});
  f.writer.rebuild();assertClosed(f);assert.equal(adapter(f).hardStop.reason,"outsider");assert.equal(f.signals.filter(s=>s.code==="SPACE_CLOSED").length,1);
  const hard=adapter(f).hardStop;new SpacePolicy(f.options);assert.deepEqual(adapter(f).hardStop,hard);assertClosed(f);
  f.writer.hardResume();assert.equal(adapter(f).hardStop.reason,"outsider");assertClosed(f);
  f.writer.reconsent(consent(f));assert.equal(adapter(f).hardStop.reason,"outsider");f.writer.hardResume();assert.equal(adapter(f).hardStop,null);
});
for(const method of ["rebuild","check"])test(`R1 C-4 missing roster closes on ${method} failure without a latch`,t=>{
  const f=fixture(t);rmSync(f.store.rosterPath(f.groupId));assert.throws(()=>f.writer[method]());assertClosed(f);assert.equal(adapter(f).hardStop,null);assert.equal(f.signals.length,0);
});
test("R1 C-4 constructor closes a pre-seeded policy before a read fails",t=>{
  const f=fixture(t);rmSync(f.store.rosterPath(f.groupId));
  const load=f.store.loadAdapter.bind(f.store);f.store.loadAdapter=(...args)=>{assertClosed(f);return load(...args)};
  assert.throws(()=>new SpacePolicy(f.options),{name:"RosterAbsentError"});assertClosed(f);assert.equal(adapter(f).hardStop,null);assert.equal(f.signals.length,0);
});
for(const method of ["rebuild","check"])test(`R1 C-4 adapter read throw closes on ${method} failure`,t=>{
  const f=fixture(t),failure=new Error("adapter read failed");f.store.loadAdapter=()=>{throw failure};
  assert.throws(()=>f.writer[method](),e=>e===failure);assertClosed(f);assert.equal(f.signals.length,0);
});
test("R1 C-6 a second mismatch preserves the first hard-stop reason and time",t=>{
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));const hard=adapter(f).hardStop;f.advance(5000);
  f.policy.agents[f.uid(f.member)]={kind:"agent",publicKey:f.key(f.member),capabilities:["commons:message"]};
  assert.equal(f.writer.check(),false);assert.deepEqual(adapter(f).hardStop,hard);assertClosed(f);
  assert.deepEqual(f.signals.at(-1),{code:"SPACE_CLOSED",groupId:f.groupId,...hard});
});
test("R1 C-6 persistence precedes a failing close and the signal still runs",t=>{
  const f=fixture(t);Object.freeze(f.policy);signAndApplyNext(f.store,f.groupId,f.owner,"invite",outsiderInvite(f));
  f.writer.onSignal=event=>{assert.equal(adapter(f).hardStop.reason,"outsider");f.signals.push(event)};
  assert.throws(()=>f.writer.rebuild(),TypeError);assert.equal(adapter(f).hardStop.reason,"outsider");assert.equal(f.signals.length,1);
});
test("R1 C-1/C-6 a throwing close does not skip distinct engine and trust objects",t=>{
  const f=fixture(t),engineCopy={...f.policy},trustCopy={...f.policy};f.engine.policy=engineCopy;f.engine.trust.policy=trustCopy;
  Object.defineProperty(f.policy,"mode",{set(){throw new Error("close failed")},get(){return "local"},configurable:true});
  assert.throws(()=>f.writer.check(),/close failed/);assert.deepEqual(engineCopy.agents,{});assert.deepEqual(trustCopy.agents,{});
  assert.equal(adapter(f).hardStop.reason,"policy-mismatch");assert.equal(f.signals.length,1);
});
for(const kind of ["sealed","non-extensible"])test(`R1 C-6 I-1 refuses a ${kind} policy before a read`,t=>{
  const f=fixture(t);if(kind==="sealed")Object.seal(f.policy);else Object.preventExtensions(f.policy);
  let reads=0;f.store.loadAdapter=()=>{reads++;throw new Error("unexpected read")};
  assert.throws(()=>new SpacePolicy(f.options),{name:"PolicyIdentityError"});assert.equal(reads,0);
});
test("R1 C-5 pending TTL uses rebuild then check without a false hard latch",t=>{
  const f=fixture(t);f.writer.applyOwnChange("remove",{target:f.uid(f.member)},{outboxId:"r1-ttl"});f.advance(PENDING_TTL_MS+1);
  f.writer.rebuild();assert.equal(f.writer.check(),true);assert.equal(f.policy.agents[f.uid(f.member)],undefined);assert.equal(adapter(f).hardStop,null);
});

test("G15 latched rebuild closes directly without another signal",t=>{
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));const before=f.signals.length,hard=adapter(f).hardStop;
  f.policy.agents[f.uid(f.member)]={kind:"agent",publicKey:f.key(f.member),capabilities:["commons:message"]};
  f.writer.rebuild();assertClosed(f);assert.equal(f.signals.length,before);assert.deepEqual(adapter(f).hardStop,hard);
});
