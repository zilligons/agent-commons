import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentCommons, Keychain, createProfile, digest, signDocument, proposeAlias, seal } from "../src/index.mjs";
import { buildGenesis, buildNext, signManifest, newRecord } from "../src/vendor/pillar/groups-v2.mjs";
import { SpaceStore, ADAPTER_V, PENDING_TTL_MS } from "../src/spaces/store.mjs";
import { signAndApplyNext, verifiedHead } from "../src/spaces/manifest.mjs";
import { SpacePolicy, assertPolicyIdentity, writePolicy } from "../src/spaces/policy.mjs";
import { manifestHash } from "../src/spaces/pillar-group.mjs";

function fixture(t){
  const home=mkdtempSync("/tmp/spaces-policy-"),store=new SpaceStore(home),keys=Array.from({length:4},()=>{const k=new Keychain("unused");k._identity=Keychain.generate();return k});
  const [owner,member,invited,outsider]=keys,uid=k=>k._identity.uuaid,key=k=>k._identity.publicKeyHex;
  const profile=createProfile({namespace:"local/space-policy",name:"Policy fixture",scope:"local",lexicon:{},fixtures:["Repeated protocol phrase Repeated protocol phrase", "Repeated protocol phrase Repeated protocol phrase"]});
  const commons={v:"commons/1",profile:{id:profile.id,hash:digest(profile)},tenant:null};
  const genesis=signManifest(buildGenesis({name:"Policy fixture",creator:owner._identity,members:[member,invited].map(k=>({uuaid:uid(k),key:key(k)})),ext:{commons}}),owner._identity);
  store.saveRoster(newRecord([genesis]));
  signAndApplyNext(store,genesis.id,owner,"accept",{target:uid(member),request:"accept-fixture"});
  const head=verifiedHead(store.loadRoster(genesis.id));
  const state={v:ADAPTER_V,groupId:genesis.id,channels:{content:`channel://agentnet/group/${genesis.id}`,control:`channel://agentnet/group-ctl/${genesis.id}`},profile:commons.profile,consent:{manifestVersion:2,charterHash:"c".repeat(64),carriers:[]},outsiderScan:{version:head.version,hash:manifestHash(head)},hardStop:null,softStop:null,pendingRemovals:[],heldRefs:[]};
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
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));
  receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"changed"}}});receivedChange(f,"remove",{target:f.uid(f.outsider)});
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

test("HS-3 policy-mismatch hard resume retains an outstanding soft stop",t=>{
  const f=fixture(t);delete f.policy.agents[f.uid(f.member)];f.writer.check();
  receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"changed"}}});
  f.writer.hardResume();assert.equal(adapter(f).hardStop,null);assert.equal(adapter(f).softStop.reason,"reconsent");assert.deepEqual(f.policy.channels[f.content].members,[]);assert.equal(f.policy.channels[f.control].members.length,3);
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
  const e=f.signals.find(x=>x.code==="SPACE_CLOSED");assert.ok(e);assert.deepEqual(Object.keys(e).sort(),["at","closed","code","groupId","persisted","reason"]);
  assert.equal(e.groupId,f.groupId);assert.equal(e.reason,"outsider");assert.equal(e.at,adapter(f).hardStop.at);assert.equal(e.persisted,true);assert.equal(e.closed,true);
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
  f.writer.hardResume();assert.equal(adapter(f).hardStop,null);f.writer.rebuild();assert.equal(adapter(f).hardStop,null);
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
  assert.deepEqual(f.signals.at(-1),{code:"SPACE_CLOSED",groupId:f.groupId,...hard,persisted:true,closed:true});
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
// AC3-Sonnet 36be6d6e, L26 slice 7 R1 delta review, base 9009be4. Append to test/spaces-policy.test.mjs
// (uses that file's fixture, receivedChange, assertClosed, consent, adapter, outsiderInvite, signAndApplyNext).
// RED on 9009be4 (expected): R1d-D1, R1d-D2, R1d-D3. GREEN on 9009be4: the rest; M35b and M40 kill their poles mutants.
test("R1d-D1 reconsent over an unobserved invite+remove span latches before moving the baseline",t=>{
  const f=fixture(t);signAndApplyNext(f.store,f.groupId,f.owner,"invite",outsiderInvite(f));signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:f.uid(f.outsider)});
  f.writer.reconsent(consent(f));assert.equal(adapter(f).hardStop?.reason,"outsider");assertClosed(f);
});
test("R1d-D2 hardResume refuses an unscanned span without changing the stop",t=>{
 const f=fixture(t);delete f.policy.agents[f.uid(f.member)];f.writer.check();
 signAndApplyNext(f.store,f.groupId,f.owner,"invite",outsiderInvite(f));signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:f.uid(f.outsider)});
 const first=adapter(f).hardStop,bytes=readFileSync(f.store.adapterPath(f.groupId)),n=f.signals.length;f.advance(7000);
 assert.throws(()=>f.writer.hardResume(),{name:"OutsiderScanBehindError"});assert.deepEqual(adapter(f).hardStop,first);
 assert.deepEqual(readFileSync(f.store.adapterPath(f.groupId)),bytes);assert.equal(f.signals.length,n);assertClosed(f);
 f.writer.rebuild();f.writer.hardResume();assert.equal(adapter(f).hardStop,null);
});
test("R1d-D3 a null agent record in the live policy latches policy-mismatch instead of throwing",t=>{
  const f=fixture(t);f.policy.agents[f.uid(f.member)]=null;
  assert.equal(f.writer.check(),false);assert.equal(adapter(f).hardStop?.reason,"policy-mismatch");assertClosed(f);
});
test("R1d-M35b a latched rebuild still closes a swapped-in trust policy (kills M35b)",async t=>{
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));
  f.engine.trust.policy={...f.policy,agents:Object.fromEntries([f.owner,f.member,f.invited].map(k=>[f.uid(k),{kind:"agent",publicKey:f.key(k),capabilities:["commons:message"]}]))};
  f.writer.rebuild();await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
test("R1d-M40 hardResume keeps the soft-stop stamp and raises no second RECONSENT_REQUIRED (kills M40)",t=>{
  const f=fixture(t);delete f.policy.agents[f.uid(f.member)];f.writer.check();
  receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"changed"}}});const soft=adapter(f).softStop;f.advance(9000);
  f.writer.hardResume();assert.deepEqual(adapter(f).softStop,soft);assert.equal(f.signals.filter(s=>s.code==="SPACE_RECONSENT_REQUIRED").length,1);
});
test("R1d-HS3 outsider-origin hard resume retains a soft stop that postdates the reconsent",t=>{
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));f.writer.reconsent(consent(f));
  receivedChange(f,"remove",{target:f.uid(f.outsider)});receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"later"}}});
  f.writer.hardResume();assert.equal(adapter(f).hardStop,null);assert.equal(adapter(f).softStop.reason,"reconsent");
  assert.deepEqual(f.policy.channels[f.content].members,[]);assert.equal(f.policy.channels[f.control].members.length,3);
});
test("R1d-CL2 outsider, tenant change, removal resumes without reconsent in the soft form",t=>{
 const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));receivedChange(f,"ext_update",{ext:{commons:{...f.commons,tenant:"changed"}}});receivedChange(f,"remove",{target:f.uid(f.outsider)});
 const before=adapter(f);f.writer.rebuild();f.writer.hardResume();const after=adapter(f);
 assert.equal(after.hardStop,null);for(const k of ["consent","profile","softStop"])assert.deepEqual(after[k],before[k]);
 assert.deepEqual(f.policy.channels[f.content].members,[]);assert.equal(f.policy.channels[f.control].members.length,3);
 f.writer.reconsent(consent(f));assert.equal(adapter(f).softStop,null);assert.equal(Object.keys(f.policy.agents).length,3);
});

test("R2 cursor resume stays open through rebuild and a fresh-store restart",async t=>{
  const f=fixture(t);signAndApplyNext(f.store,f.groupId,f.owner,"invite",outsiderInvite(f));signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:f.uid(f.outsider)});
  f.writer.rebuild();const before=adapter(f);assert.equal(before.hardStop.reason,"outsider");
  const head=verifiedHead(f.store.loadRoster(f.groupId));assert.deepEqual(before.outsiderScan,{version:head.version,hash:manifestHash(head)});
  f.advance(5000);f.writer.hardResume();f.writer.rebuild();assert.equal(adapter(f).hardStop,null);
  for(const k of ["consent","profile","softStop","outsiderScan"])assert.deepEqual(adapter(f)[k],before[k]);
  const engine=new AgentCommons({keychain:f.owner,policy:{mode:"local",agents:{}}});t.after(()=>engine.store.close());
  new SpacePolicy({...f.options,engine,store:new SpaceStore(f.home)});
  assert.equal(adapter(f).hardStop,null);assert.equal(engine.policy.channels[f.content].members.length,2);
  await engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message");assert.equal(f.signals.filter(s=>s.code==="SPACE_CLOSED").length,1);
});
test("R2 latched scan records a second outsider once before allowing resume",t=>{
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));const before=adapter(f),first=before.hardStop;
  const other=Keychain.generate();signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:f.uid(f.outsider)});
  signAndApplyNext(f.store,f.groupId,f.owner,"invite",{member:{uuaid:other.uuaid,key:other.publicKeyHex}});signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:other.uuaid});
  const bytes=readFileSync(f.store.adapterPath(f.groupId));assert.throws(()=>f.writer.hardResume(),{name:"OutsiderScanBehindError"});assert.deepEqual(readFileSync(f.store.adapterPath(f.groupId)),bytes);
  f.writer.rebuild();assert.deepEqual(adapter(f).hardStop,first);assertClosed(f);
  const events=f.signals.filter(s=>s.code==="SPACE_OUTSIDER_SEEN");assert.equal(events.length,1);assert.equal(events[0].from.version,3);assert.equal(events[0].to.version,6);
  f.writer.rebuild();assert.equal(f.signals.filter(s=>s.code==="SPACE_OUTSIDER_SEEN").length,1);
  f.writer.hardResume();assert.equal(adapter(f).hardStop,null);assert.equal(f.signals.filter(s=>s.code==="SPACE_CLOSED").length,1);
  for(const k of ["consent","profile","softStop"])assert.deepEqual(adapter(f)[k],before[k]);
});
test("R2 a fresh outsider after resume closes again",t=>{
  const f=fixture(t);receivedChange(f,"invite",outsiderInvite(f));receivedChange(f,"remove",{target:f.uid(f.outsider)});f.writer.hardResume();
  const before=adapter(f);receivedChange(f,"invite",outsiderInvite(f));assert.equal(adapter(f).hardStop.reason,"outsider");assertClosed(f);
  assert.equal(f.signals.filter(s=>s.code==="SPACE_CLOSED").length,2);assert.equal(adapter(f).outsiderScan.version,5);
  for(const k of ["consent","profile","softStop"])assert.deepEqual(adapter(f)[k],before[k]);
});
test("R2 matching cursor version with a verified fork hash rescans from consent",t=>{
  const f=fixture(t),prefix=f.store.loadRoster(f.groupId).chain;
  receivedChange(f,"rename",{name:"safe branch"});const cursor=adapter(f).outsiderScan;assert.equal(cursor.version,3);
  const invite=signManifest(buildNext(prefix.at(-1),"invite",outsiderInvite(f)),f.owner._identity);
  const remove=signManifest(buildNext(invite,"remove",{target:f.uid(f.outsider)}),f.owner._identity);
  f.store.saveRoster(newRecord([...prefix,invite,remove]));assert.notEqual(manifestHash(invite),cursor.hash);
  f.writer.rebuild();assert.equal(adapter(f).hardStop.reason,"outsider");assertClosed(f);assert.equal(adapter(f).outsiderScan.version,4);
});
test("R2 missing cursor version rescans from consent",t=>{
  const f=fixture(t),state=adapter(f);state.outsiderScan={version:99,hash:"a".repeat(64)};f.store.saveAdapter(f.groupId,state);
  signAndApplyNext(f.store,f.groupId,f.owner,"invite",outsiderInvite(f));signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:f.uid(f.outsider)});
  f.writer.rebuild();assert.equal(adapter(f).hardStop.reason,"outsider");assertClosed(f);
});
test("R2 cursor and a soft-stop update share one save; unchanged rebuild writes nothing",t=>{
  const f=fixture(t);signAndApplyNext(f.store,f.groupId,f.owner,"rename",{name:"safe rename"});signAndApplyNext(f.store,f.groupId,f.owner,"ext_update",{ext:{commons:{...f.commons,tenant:"changed"}}});
  const save=f.store.saveAdapter.bind(f.store);const writes=[];f.store.saveAdapter=(id,state)=>{writes.push(structuredClone(state));save(id,state)};
  f.writer.rebuild();assert.equal(writes.length,1);assert.equal(writes[0].outsiderScan.version,4);assert.equal(writes[0].softStop.reason,"reconsent");
  f.writer.rebuild();assert.equal(writes.length,1);
});
test("R2 cursor and outsider latch survive a crash in one atomic save",t=>{
  const f=fixture(t);signAndApplyNext(f.store,f.groupId,f.owner,"invite",outsiderInvite(f));signAndApplyNext(f.store,f.groupId,f.owner,"remove",{target:f.uid(f.outsider)});
  const save=f.store.saveAdapter.bind(f.store);let writes=0;f.store.saveAdapter=(id,state)=>{save(id,state);if(++writes===1)throw new Error("crash after first save")};
  assert.throws(()=>f.writer.rebuild(),/crash after first save/);assert.equal(writes,1);
  const fresh=new SpaceStore(f.home),persisted=fresh.loadAdapter(f.groupId).state;assert.equal(persisted.outsiderScan.version,4);assert.equal(persisted.hardStop.reason,"outsider");
  const engine=new AgentCommons({keychain:f.owner,policy:{mode:"local",agents:{}}});t.after(()=>engine.store.close());new SpacePolicy({...f.options,store:fresh,engine});assert.deepEqual(engine.policy.agents,{});
});
test("R2 stop signal reports failed persistence and closes the real gate",async t=>{
  const f=fixture(t),failure=new Error("save failed");f.store.saveAdapter=()=>{throw failure};delete f.policy.agents[f.uid(f.member)];
  assert.throws(()=>f.writer.check(),e=>e===failure);assert.equal(adapter(f).hardStop,null);assertClosed(f);
  assert.equal(f.signals.at(-1).persisted,false);assert.equal(f.signals.at(-1).closed,true);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
test("R2 frozen engine copy is replaced independently; other consumers close",async t=>{
  const f=fixture(t),copy=Object.freeze({...f.policy});f.engine.policy=copy;
  assert.throws(()=>f.writer.check(),TypeError);assert.notEqual(f.engine.policy,copy);assertClosed(f);assert.deepEqual(f.engine.policy.agents,{});
  assert.equal(f.signals.at(-1).persisted,true);assert.equal(f.signals.at(-1).closed,true);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
for(const kind of ["class","frozen","non-extensible"])test(`R2 ${kind} trust consumer is replaced and the real gate refuses`,async t=>{
  const f=fixture(t),copy=Object.assign(kind==="class"?new(class {})():{},f.policy);
  if(kind==="frozen")Object.freeze(copy);if(kind==="non-extensible")Object.preventExtensions(copy);f.engine.trust.policy=copy;
  assert.throws(()=>f.writer.check(),TypeError);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
  assert.notEqual(f.engine.trust.policy,copy);assert.deepEqual(f.engine.trust.policy.agents,{});assert.equal(f.signals.at(-1).closed,true);
});
test("R2 save and close failure retain the first error and still close the real gate",async t=>{
  const f=fixture(t),failure=new Error("first save failure"),copy=Object.freeze({...f.policy});f.engine.trust.policy=copy;f.store.saveAdapter=()=>{throw failure};
  assert.throws(()=>f.writer.check(),e=>e===failure);assert.equal(f.signals.at(-1).persisted,false);assert.equal(f.signals.at(-1).closed,true);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
test("R2 a blocked fallback reports closed false and refuses the operation",async t=>{
  const f=fixture(t),copy=Object.freeze({...f.policy});Object.defineProperty(f.engine,"policy",{value:copy,writable:false});
  assert.throws(()=>f.writer.check(),TypeError);assert.equal(f.signals.at(-1).closed,false);assert.equal(f.signals.at(-1).persisted,true);assertClosed(f);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
test("R2 direct writePolicy closes after a checkPolicy roster read throws",async t=>{
  const f=fixture(t),rec=f.store.loadRoster(f.groupId),state=adapter(f),failure=new Error("roster read failed");f.store.loadRoster=()=>{throw failure};
  assert.throws(()=>writePolicy(f.policy,rec,f.owner,state,verifiedHead(rec).ext.commons,f.allowlist,f.writer._options(f.options.clock())),e=>e===failure);assertClosed(f);
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});
test("R2 emergency replacement refuses reopening without writes; fresh-engine restart recovers",async t=>{
  const f=fixture(t);f.engine.trust.policy=Object.freeze({...f.policy});assert.throws(()=>f.writer.check(),TypeError);
  const bytes=readFileSync(f.store.adapterPath(f.groupId));assert.throws(()=>f.writer.hardResume(),{name:"PolicyIdentityError"});assert.deepEqual(readFileSync(f.store.adapterPath(f.groupId)),bytes);
  assert.throws(()=>f.writer.reconsent(consent(f)),{name:"PolicyIdentityError"});assert.deepEqual(readFileSync(f.store.adapterPath(f.groupId)),bytes);
  const engine=new AgentCommons({keychain:f.owner,policy:{mode:"local",agents:{}}});t.after(()=>engine.store.close());
  const writer=new SpacePolicy({...f.options,engine,store:new SpaceStore(f.home)});writer.hardResume();assert.equal(adapter(f).hardStop,null);await engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message");
});
test("R2 legacy adapter without outsiderScan refuses and leaves the instance closed",t=>{
  const f=fixture(t),state=adapter(f);delete state.outsiderScan;
  // Deliberate legacy bytes bypass saveAdapter's strict current-schema validator.
  writeFileSync(f.store.adapterPath(f.groupId),JSON.stringify(state));
  assert.throws(()=>new SpacePolicy(f.options),{name:"AdapterStateError"});assertClosed(f);
});
test("R2 direct emergency closure blocks every reopening path before file writes",async t=>{
  const f=fixture(t),rec=f.store.loadRoster(f.groupId),state=adapter(f),ext=verifiedHead(rec).ext.commons,options=f.writer._options(f.options.clock());
  Object.freeze(f.policy);assert.throws(()=>writePolicy(f.policy,rec,f.owner,state,ext,f.allowlist,options),TypeError);
  const bytes=readFileSync(f.store.adapterPath(f.groupId)),roster=readFileSync(f.store.rosterPath(f.groupId));
  for(const action of [()=>f.writer.rebuild(),()=>f.writer.hardResume(),()=>f.writer.reconsent(consent(f)),()=>writePolicy(f.policy,rec,f.owner,state,ext,f.allowlist,options),()=>f.writer.applyOwnChange("rename",{name:"must not persist"})]){
    assert.throws(action,{name:"PolicyIdentityError"});assert.deepEqual(readFileSync(f.store.adapterPath(f.groupId)),bytes);assert.deepEqual(readFileSync(f.store.rosterPath(f.groupId)),roster);
  }
  await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
});

for(const variant of [
  {name:"a",cursor:3,consent:6,invite:4,remove:5,accept:3},
  {name:"b",cursor:5,consent:7,invite:3,remove:4,accept:5},
  {name:"c",cursor:8,consent:6,invite:3,remove:4,accept:5},
  {name:"d profile",cursor:3,consent:7,change:"profile",accept:4},
  {name:"d tenant",cursor:3,consent:7,change:"tenant",accept:4},
  {name:"e",cursor:99,consent:6,invite:4,remove:5,accept:3},
])test(`R2c pole6 ${variant.name}: a native replacement scans outsiders from genesis only`,async t=>{
  const f=fixture(t),commons=structuredClone(f.commons);
  if(variant.change==="profile")commons.profile={id:"r2c-consented-profile",hash:"d".repeat(64)};
  if(variant.change==="tenant")commons.tenant="r2c-consented-tenant";
  // The old branch has already consented to any d-profile/tenant change.
  for(let version=3;version<=9;version++){
    if(version===3&&variant.change)signAndApplyNext(f.store,f.groupId,f.owner,"ext_update",{ext:{commons}});
    else signAndApplyNext(f.store,f.groupId,f.owner,"rename",{name:`old branch ${version}`});
  }
  const old=f.store.loadRoster(f.groupId),state=adapter(f);
  state.consent.manifestVersion=variant.consent;state.profile=structuredClone(commons.profile);
  state.outsiderScan={version:variant.cursor,hash:manifestHash(old.chain.find(manifest=>manifest.version===(variant.cursor===99?3:variant.cursor)))};
  f.store.saveAdapter(f.groupId,state);
  // Same genesis/group, then divergence at v2, below every named cursor/consent.
  const chain=[old.chain[0]];
  const append=(action,opts)=>chain.push(signManifest(buildNext(chain.at(-1),action,opts),f.owner._identity));
  append("rename",{name:"replacement divergence"});
  for(let version=3;version<=9;version++){
    if(version===variant.invite)append("invite",outsiderInvite(f));
    else if(version===variant.remove)append("remove",{target:f.uid(f.outsider)});
    else if(version===3&&variant.change)append("ext_update",{ext:{commons}});
    else if(version===variant.accept)append("accept",{target:f.uid(f.member),request:"replacement-accept"});
    else append("rename",{name:`replacement ${version}`});
  }
  f.store.saveRoster(newRecord(chain));const head=verifiedHead(f.store.loadRoster(f.groupId));assert.equal(head.version,9);
  const atCursor=chain.find(manifest=>manifest.version===variant.cursor);
  if(atCursor)assert.notEqual(manifestHash(atCursor),state.outsiderScan.hash);else assert.equal(variant.name,"e");
  f.writer.rebuild();
  assert.deepEqual(adapter(f).outsiderScan,{version:9,hash:manifestHash(head)});
  assert.equal(adapter(f).softStop,null);assert.equal(f.signals.filter(signal=>signal.code==="SPACE_RECONSENT_REQUIRED").length,0);
  if(variant.change){
    assert.equal(adapter(f).hardStop,null);assert.equal(f.signals.length,0);assert.equal(f.policy.channels[f.content].members.length,2);assert.equal(Object.keys(f.policy.agents).length,3);
    assert.deepEqual(adapter(f).profile,commons.profile);
  }else{
    assert.equal(adapter(f).hardStop?.reason,"outsider");assertClosed(f);assert.equal(f.signals.filter(signal=>signal.code==="SPACE_CLOSED").length,1);
    await assert.rejects(f.engine.trust.authorize(f.uid(f.member),f.key(f.member),"commons:message"),{code:"NOT_ADMITTED"});
  }
});
