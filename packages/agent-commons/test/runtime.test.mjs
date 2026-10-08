import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentCommons,CommonsStore,CommonsCarrier,RegistryTrust,Keychain,CarrierClient,createProfile,encode,decode,seal,open,signDocument,verifyDocument,contribution,REQUIRED_STANDARDS,runAgentLoop } from "../src/index.mjs";
import { initialize,loadRuntime } from "../src/config.mjs";
function key(){const k=new Keychain("unused");k._identity=Keychain.generate();return k}
function setup(scope="local"){
  const keys=[key(),key(),key(),key()];
  const policy={mode:"local",agents:Object.fromEntries(keys.map(k=>[k._identity.uuaid,{kind:"agent",publicKey:k._identity.publicKeyHex,capabilities:["commons:message","commons:relay","commons:evolve","commons:contribute","commons:recover"]}]))};
  const runtimes=keys.map(k=>new AgentCommons({keychain:k,policy}));
  const profile=createProfile({namespace:"test/fleet",name:"Fixture profile",scope,fixtures:["Require semantic equivalence and semantic equivalence.","Preserve semantic equivalence before accepting a profile."]});
  runtimes.forEach(r=>{if(scope!=="global")r.addProfile(profile);else r.store.set("profiles",[profile])});
  return {keys,policy,runtimes,profile};
}
test("published Pillar source subset matches provenance byte for byte",()=>{
  const manifest=JSON.parse(readFileSync(new URL("../PROVENANCE.json",import.meta.url)));
  let tarballCount=0,localCount=0;
  for(const [file,entry] of Object.entries(manifest.files)){
    const expectedHash=typeof entry==="string"?entry:entry.sha256;
    const actualHash=createHash("sha256").update(readFileSync(new URL(`../src/vendor/pillar/${file}`,import.meta.url))).digest("hex");
    assert.equal(actualHash,expectedHash,`hash mismatch for ${file}`);
    if(typeof entry==="string"){
      tarballCount++;
    } else {
      assert.equal(entry.source,"pillar commit 2ef548d (local, no remote - not published)");
      localCount++;
    }
  }
  assert.equal(tarballCount,7,"7 files from 2.0.2 tarball");
  assert.equal(localCount,3,"3 files from 2ef548d local");
  assert.equal(manifest.upstreamVersion,"2.0.2");
});
test("500 lossless alias/Unicode/control-token combinations",()=>{
  const lexicon={"semantic equivalence":"~0~","Require semantic equivalence":"~1~"};
  const samples=["semantic equivalence","~0~","~~","தமிழ்","\n","Require semantic equivalence","🧬"];
  for(let i=0;i<500;i++){const text=[samples[i%7],samples[(i*3)%7],String.fromCodePoint(0x1f600+i%80)].join(" ");assert.equal(decode(encode(text,lexicon),lexicon),text)}
});
test("bad aliases and bounded-fixture violations fail closed",()=>{
  const options={namespace:"test/a",name:"A profile",fixtures:["semantic equivalence","semantic equivalence"]};
  assert.throws(()=>createProfile({...options,lexicon:{"semantic equivalence":"~0~","communication profile":"~0~"}}),/colliding/);
  assert.throws(()=>createProfile({...options,fixtures:["only one"]}),/2–100/);
});
test("one deployable home initializes without registry writes and never overwrites",()=>{
  const home=mkdtempSync(join(tmpdir(),"ac-init-"));
  try{const first=initialize({home,target:"zilligons.com"});assert.match(first.identity.uuaid,/^uuaid:foundation:agent:/);const loaded=loadRuntime(home);assert.equal(loaded.runtime.profiles().length,1);assert.equal(loaded.runtime.status().auditVerified,true);loaded.store.close();assert.throws(()=>initialize({home}),/not overwritten/);assert.equal(first.certified,false)}finally{rmSync(home,{recursive:true,force:true})}
});
test("two genuinely independent signed votes adopt a local profile",async()=>{
  const {runtimes:[a,b,c],profile}=setup();
  const proposal=await a.propose(profile.id,"semantic equivalence");
  assert.equal((await b.apply(proposal)).status,"pending");
  const voteB=await b.vote(proposal.payload.proposal.id,true,"Measured and reversible");
  assert.equal((await a.apply(voteB)).status,"pending");
  const voteC=await c.vote(proposal.payload.proposal.id,true,"Independent lossless check");
  assert.equal((await a.apply(voteC)).status,"adopted");
  assert.equal(a.profiles().length,2);assert.equal(a.store.verify(),true);
});
test("parallel independent votes are serialized without losing a ballot",async()=>{
  const {runtimes:[a,b,c],profile}=setup();
  const p=await a.propose(profile.id,"semantic equivalence");
  const [vb,vc]=await Promise.all([b.vote(p.payload.proposal.id,true),c.vote(p.payload.proposal.id,true)]);
  const outcomes=await Promise.all([a.apply(vb),a.apply(vc)]);assert.equal(outcomes.at(-1).status,"adopted");
});
test("self vote, second vote under a new ID, and tampering are rejected",async()=>{
  const {runtimes:[a,b],keys,profile}=setup();const p=await a.propose(profile.id,"semantic equivalence");
  await assert.rejects(a.apply(await a.vote(p.payload.proposal.id,true)),/Ineligible/);
  await a.apply(await b.vote(p.payload.proposal.id,true));
  await assert.rejects(a.apply(await b.vote(p.payload.proposal.id,true)),/duplicate/);
  const modified=structuredClone(p);modified.payload.proposal.phrase="different phrase";assert.throws(()=>verifyDocument(modified),/signature/);
});
test("positive ballots are revalidated after a voter is blocked",async()=>{
  const {runtimes:[a,b,c],policy,profile}=setup();const p=await a.propose(profile.id,"semantic equivalence");
  await a.apply(await b.vote(p.payload.proposal.id,true));policy.blocked=[b.uuaid];
  await assert.rejects(a.apply(await c.vote(p.payload.proposal.id,true)),/blocked/);assert.equal(a.profiles().length,1);
});
test("local ballots cannot mutate a global profile",async()=>{
  const {runtimes:[a,b,c],profile}=setup("global");const p=await a.propose(profile.id,"semantic equivalence");await a.apply(await b.vote(p.payload.proposal.id,true));
  await assert.rejects(a.apply(await c.vote(p.payload.proposal.id,true)),/cannot ratify global/);
});
test("metadata-only contributions do not leak fixtures or claim ratification",async()=>{
  const {runtimes:[a,b],profile}=setup();const document=await a.prepareContribution(profile.id);
  assert.equal(document.payload.contribution.profile,undefined);assert.equal(contribution(profile).stage,"candidate");
  const result=await b.apply(document);assert.equal(result.ratified,false);assert.equal(result.stage,"awaiting-independent-review");
});
test("unadmitted and human-type identities are denied",async()=>{
  const {runtimes:[a],keys}=setup();const unknown=key();
  await assert.rejects(a.trust.authorize(unknown._identity.uuaid,unknown._identity.publicKeyHex),/not been admitted/);
  await assert.rejects(a.trust.authorize(keys[0]._identity.uuaid.replace(":agent:",":human:"),keys[0]._identity.publicKeyHex),/agent UUAID/);
});
test("Pillar sealed payloads are actually private and tamper evident",async()=>{
  const {runtimes:[a,b],profile}=setup();const sent=await a.send({recipient:b.uuaid,profileId:profile.id,body:"semantic equivalence"});
  assert.equal(JSON.stringify(sent.envelope).includes("semantic equivalence"),false);assert.equal(open(sent.envelope).ok,true);
  assert.equal((await b.receive(sent.envelope)).body,"semantic equivalence");assert.equal((await b.receive(sent.envelope)).duplicate,true);
  const changed=structuredClone(sent.envelope);changed.enc.ct="00"+changed.enc.ct.slice(2);await assert.rejects(b.receive(changed),/Invalid Pillar envelope/);
});
test("unknown profile digests never silently downgrade to another decoder",async()=>{
  const {runtimes:[a,b],profile}=setup();const sent=await a.send({recipient:b.uuaid,profileId:profile.id,body:"semantic equivalence"});b.store.set("profiles",[]);
  await assert.rejects(b.receive(sent.envelope),/Unknown local profile/);
});
test("official published CarrierClient delivers, authenticates inbox, and deduplicates",async()=>{
  const {keys,policy,runtimes:[a,b],profile}=setup();const store=new CommonsStore();const carrier=new CommonsCarrier({store,trust:new RegistryTrust({policy})});const address=await carrier.listen();
  try{
    const url=`http://127.0.0.1:${address.port}`,client=new CarrierClient({keychain:keys[0],carriers:[url]});
    const sent=await a.send({recipient:b.uuaid,profileId:profile.id,body:"Preserve semantic equivalence."});
    const first=await client.deliver(sent.envelope),second=await client.deliver(sent.envelope);assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);
    const recipientClient=new CarrierClient({keychain:keys[1],carriers:[url]});
    const fetched=await recipientClient.fetchInbox(url,{waitS:0});assert.equal(fetched.envelopes.length,1);assert.equal((await b.receive(fetched.envelopes[0].envelope)).body,"Preserve semantic equivalence.");
    assert.equal(store.verify(),true);
    const unauthorized=await fetch(`${url}/v1/inbox/${b.uuaid}`);assert.equal(unauthorized.status,401);
    const human=await fetch(`${url}/v1/envelopes`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({body:"human post"})});assert.equal(human.status,400);
    assert.equal((await (await fetch(`${url}/.well-known/agent-commons`)).json()).role,"carrier");
  }finally{await carrier.close();store.close()}
});
test("long polling wakes on delivery instead of spinning or waiting the full timer",async()=>{
  const {keys,policy,runtimes:[a,b],profile}=setup();const carrier=new CommonsCarrier({trust:new RegistryTrust({policy})});const address=await carrier.listen();
  try{
    const url=`http://127.0.0.1:${address.port}`,receiver=new CarrierClient({keychain:keys[1],carriers:[url]});
    const pending=receiver.fetchInbox(url,{waitS:5,timeoutMs:8000});
    const sent=await a.send({recipient:b.uuaid,profileId:profile.id,body:"wake peer"});
    await new CarrierClient({keychain:keys[0],carriers:[url]}).deliver(sent.envelope);
    assert.equal((await pending).envelopes.length,1);
  }finally{await carrier.close();carrier.store.close()}
});
test("persistent outbox quarantine, recovery pin, and audit tampering",async()=>{
  const {runtimes:[a,b],keys,profile}=setup();await a.send({recipient:b.uuaid,profileId:profile.id,body:"queued"});
  const row=a.store.pending()[0];for(let i=0;i<5;i++)a.store.failure(row.id,"unreachable");assert.equal(a.store.db.prepare("SELECT state FROM outbox WHERE id=?").get(row.id).state,"quarantined");
  const recovery=signDocument(keys[0],"profile-recovery",{profileId:profile.id,reason:"Restore known local decoder"});assert.equal((await a.apply(recovery)).status,"local-profile-pinned");
  a.store.db.prepare("UPDATE events SET body=? WHERE seq=1").run('{"bad":true}');assert.equal(a.store.verify(),false);
});
test("global admission uses official SDK verification, subject binding, and IAASO pins",async()=>{
  const {keys,policy}=setup();const id=keys[0]._identity.uuaid,publicKey=keys[0]._identity.publicKeyHex;
  const globalPolicy={...policy,mode:"global",standardPins:Object.fromEntries(REQUIRED_STANDARDS.map(code=>[code,"a".repeat(64)]))};
  globalPolicy.agents[id]={...globalPolicy.agents[id],credentialId:"credential-test"};
  const fetchImpl=async url=>{
    if(url.includes("/v1/standards"))return new Response(JSON.stringify({standards:REQUIRED_STANDARDS.map(code=>({code,stage:"published",content_hash:"a".repeat(64)}))}));
    if(url.includes("/resolve/"))return new Response(JSON.stringify({agent:{uuaid:id,status:"active"}}));
    return new Response(JSON.stringify({credential_id:"credential-test",agent_uuaid:id,valid:true,signatureValid:true,active:true,notExpired:true}));
  };
  const trust=new RegistryTrust({policy:globalPolicy,fetchImpl});assert.equal((await trust.authorize(id,publicKey)).tier,"registry-credential-and-policy");
  const broken=new RegistryTrust({policy:{...globalPolicy,standardPins:{}},fetchImpl});await assert.rejects(broken.authorize(id,publicKey),/pinned/);
  const revoked=new RegistryTrust({policy:globalPolicy,fetchImpl:async url=>url.includes("/verify/")?new Response(JSON.stringify({credential_id:"credential-test",agent_uuaid:id,valid:true,signatureValid:true,active:false,notExpired:true})):fetchImpl(url)});await assert.rejects(revoked.authorize(id,publicKey),/expiry failed/);
});
test("global profiles require an exact published content hash and no fail-open fallback",async()=>{
  const {runtimes:[a]}=setup();const p=createProfile({namespace:"global/test",name:"Global draft",scope:"global",fixtures:["first test fixture","second test fixture"]});
  a.trust.publishedProfilePin=async()=>{throw new Error("No IAASO publication")};await assert.rejects(a.importGlobal(p,"UNASSIGNED-DRAFT"),/No IAASO/);
});
test("public carrier binding without global policy and HTTPS fails",async()=>{
  const carrier=new CommonsCarrier();await assert.rejects(carrier.listen(0,"0.0.0.0"),/Public bind requires/);carrier.store.close();
});
test("provider-neutral bounded agent loop supports spontaneous engagement",async()=>{
  let calls=0;const runtime={poll:async()=>[],flush:async()=>[],status:()=>({}),send:async action=>{calls++;return action}};
  const result=await runAgentLoop({runtime,respond:async()=>null,spontaneous:async()=>({recipient:"test",profileId:"fixture",body:"autonomous turn"}),maxTurns:1,intervalMs:500});
  assert.equal(calls,1);assert.equal(result.stopped,"turn-limit");
});
test("unknown policy mode never degrades to permissive local operation",()=>{
  assert.throws(()=>new RegistryTrust({policy:{mode:"globla"}}),/explicitly local or global/);
});
test("bounded multi-agent broadcasts seal separately to every recipient",async()=>{
  const {runtimes:[a,b,c],profile}=setup();
  const batch=await a.broadcast({recipients:[b.uuaid,c.uuaid],profileId:profile.id,body:"semantic equivalence"});
  assert.equal(batch.queued.length,2);
  const envelopes=a.store.pending().map(r=>JSON.parse(r.body));
  assert.notEqual(envelopes[0].enc.ct,envelopes[1].enc.ct);
  assert.equal((await b.receive(envelopes[0])).body,"semantic equivalence");
  assert.equal((await c.receive(envelopes[1])).body,"semantic equivalence");
  await assert.rejects(a.broadcast({recipients:[b.uuaid,b.uuaid],profileId:profile.id,body:"duplicate"}),/distinct/);
});
test("polling fails over to healthy carriers with persistent bounded backoff",async()=>{
  const {runtimes:[a,b],keys,policy,profile}=setup();const sent=await a.send({recipient:b.uuaid,profileId:profile.id,body:"semantic equivalence"});
  const runtime=new AgentCommons({keychain:keys[1],policy,carriers:["http://bad.invalid","http://healthy.invalid"]});runtime.addProfile(profile);
  runtime.transport.fetchInbox=async carrier=>{if(carrier.includes("bad"))throw new Error("offline");return {envelopes:[{seq:1,envelope:sent.envelope}]}};
  const results=await runtime.poll();assert.equal(results[0].state,"retry-backoff");assert.equal(results[1].body,"semantic equivalence");
  assert.ok(runtime.store.get("carrierHealth")["http://bad.invalid"].nextProbeAt>Date.now());
});
test("quarantined outbox recovery revalidates signatures and does not send",async()=>{
  const {runtimes:[a,b],profile}=setup();const sent=await a.send({recipient:b.uuaid,profileId:profile.id,body:"recover"});
  for(let i=0;i<5;i++)a.store.failure(sent.envelope.id,"offline");
  const result=await a.retryOutbox(sent.envelope.id);assert.equal(result.networkCallMade,false);assert.equal(a.store.pending().length,1);
  assert.equal(a.store.verify(),true);
});
test("local recovery changes the decoder used for namespace-selected sends",async()=>{
  const {runtimes:[a,b,c],keys,profile}=setup();const proposal=await a.propose(profile.id,"semantic equivalence");
  await a.apply(await b.vote(proposal.payload.proposal.id,true));await a.apply(await c.vote(proposal.payload.proposal.id,true));
  assert.notEqual(a.activeProfile(profile.namespace).id,profile.id);
  await a.apply(signDocument(keys[0],"profile-recovery",{profileId:profile.id,reason:"Pin the known baseline"}));
  const queued=await a.send({recipient:b.uuaid,namespace:profile.namespace,body:"semantic equivalence"});
  assert.equal(a.activeProfile(profile.namespace).id,profile.id);
  assert.equal((await b.receive(queued.envelope)).body,"semantic equivalence");
  const next=await a.propose(profile.id,"Preserve semantic equivalence");
  await a.apply(await b.vote(next.payload.proposal.id,true));await a.apply(await c.vote(next.payload.proposal.id,true));
  assert.equal(a.activeProfile(profile.namespace).id,next.payload.proposal.candidate.id);
});
test("confirmed singular deployment target and old spelling normalize consistently",()=>{
  const singular=mkdtempSync(join(tmpdir(),"ac-singular-")),alias=mkdtempSync(join(tmpdir(),"ac-alias-"));
  try{
    const a=initialize({home:singular,target:"zilligon.com"}),b=initialize({home:alias,target:"zilligons.com"});
    assert.equal(a.target,"zilligon.com");assert.equal(b.target,"zilligon.com");assert.equal(a.profileId,b.profileId);
  }finally{rmSync(singular,{recursive:true,force:true});rmSync(alias,{recursive:true,force:true})}
});
