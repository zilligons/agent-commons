import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentCommons,CommonsStore,CommonsCarrier,RegistryTrust,Keychain,CarrierClient,createProfile,encode,decode,seal,open,signDocument,verifyDocument,contribution,REQUIRED_STANDARDS,runAgentLoop } from "../src/index.mjs";
import { initialize,loadRuntime } from "../src/config.mjs";
import { leakedForms } from "./plaintext-leak.mjs";
function key(){const k=new Keychain("unused");k._identity=Keychain.generate();return k}
function setup(scope="local"){
  const keys=[key(),key(),key(),key()];
  const policy={mode:"local",agents:Object.fromEntries(keys.map(k=>[k._identity.uuaid,{kind:"agent",publicKey:k._identity.publicKeyHex,capabilities:["commons:message","commons:relay","commons:evolve","commons:contribute","commons:recover"]}]))};
  const runtimes=keys.map(k=>new AgentCommons({keychain:k,policy}));
  const profile=createProfile({namespace:"test/fleet",name:"Fixture profile",scope,fixtures:["Require semantic equivalence and semantic equivalence.","Preserve semantic equivalence before accepting a profile."]});
  runtimes.forEach(r=>{if(scope!=="global")r.addProfile(profile);else r.store.set("profiles",[profile])});
  return {keys,policy,runtimes,profile};
}
// Hashes of the twelve files inside the published @uuaid/pillar 2.2.0 tarball
// (sha256 605ec938…f87b), measured from the tarball, not from PROVENANCE.json:
// the manifest is generated from the vendored bytes, so on its own it proves
// consistency, not origin.
const PILLAR_2_2_0_FILES={
  "blob/blob.mjs":"ba397d8626b71753797313d720ea38fdffed8bb8f7dba2999493fe69f89679bb",
  "crypto/e2e.mjs":"538965c2834c7bae4c508fd203ae757c3e2a286c4395dc90b0f5131cc123f159",
  "groups-v2.mjs":"08d1dcee89f177d4145e3fbd7ba34d5743fa971c6a34774e399a6577a7301e33",
  "groups.mjs":"4019df0f33c4ff65dbf40bfbacc0a69fb4a9078219b84272052972140201f961",
  "identity/jcs.mjs":"7ad009961c4d4fcee506aa666c03c485fc2efc2018ca5a3edbdcccd959b6b79f",
  "identity/keychain.mjs":"9b651a5e9b38a101d65f1ddcfbe15dc2d99f8ad04345a2bb6e02ee445e6005e6",
  "identity/tier.mjs":"ecd6f0a2bdf0c513efd80cc6a4595e32b2776485c813d2f95281d28257d3dacb",
  "net/carrier-client.mjs":"6add53819e124c026618b5adbe601d0cb5511088bab295bf0812a06ccf00e47c",
  "net/delegation.mjs":"902248d8c9e9fabd5644f7308ed3eeb725f196d7aa5b3ac719db00699dff498d",
  "net/envelope.mjs":"7238af1e2810ab927f8cde5da7d86e5132cc21e54cb545f6f091dcd6b45a25b9",
  "net/refusals.mjs":"4b6cf8b44feae411230b10093900b8ce51129605ba61f2e06e878b997d001117",
  "net/seed-tier.mjs":"18ed2354399ef4f940052b25098895a4273fc7ba6e86d37b23541b0c1b0d503d",
};
test("published Pillar source subset matches provenance byte for byte",()=>{
  const manifest=JSON.parse(readFileSync(new URL("../PROVENANCE.json",import.meta.url)));
  assert.equal(manifest.upstreamVersion,"2.2.0");
  assert.equal(manifest.sourceTarball,"https://registry.npmjs.org/@uuaid/pillar/-/pillar-2.2.0.tgz");
  assert.equal(manifest.sourceTarballSha256,"605ec9381b12d7df620d400bd2225f2b294e31e0c85cdb68bb8b7330ce7ff87b");
  assert.equal(manifest.sourceTarballIntegrity,"sha512-5CDotCO87Ec6PWSjMz2e+T7R/XGJZL2t26bK8+XHkaWE8PQz83eZy6VgLRmabnsBOjIbk206SAhmAe4ACFrwVw==");
  assert.deepEqual(manifest.files,PILLAR_2_2_0_FILES,"every vendored file comes from the published 2.2.0 tarball");
  for(const [file,expectedHash] of Object.entries(PILLAR_2_2_0_FILES)){
    const actualHash=createHash("sha256").update(readFileSync(new URL(`../src/vendor/pillar/${file}`,import.meta.url))).digest("hex");
    assert.equal(actualHash,expectedHash,`hash mismatch for ${file}`);
  }
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
  try{const first=initialize({home,target:"zilligons.com"});assert.match(first.identity.uuaid,/^uuaid:agentnet:agent:/);const loaded=loadRuntime(home);assert.equal(loaded.runtime.profiles().length,1);assert.equal(loaded.runtime.status().auditVerified,true);loaded.store.close();assert.throws(()=>initialize({home}),/not overwritten/);assert.equal(first.certified,false)}finally{rmSync(home,{recursive:true,force:true})}
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
  // Checks that the plaintext is absent as text, hex or base64 only; this is not a proof of confidentiality. The sealed
  // payload carries encode(body, lexicon); the fixture lexicon is empty, so that wire form is the body itself.
  assert.equal(encode("semantic equivalence",profile.lexicon),"semantic equivalence");
  assert.deepEqual(leakedForms(JSON.stringify(sent.envelope),"semantic equivalence"),[]);assert.equal(open(sent.envelope).ok,true);
  assert.equal((await b.receive(sent.envelope)).body,"semantic equivalence");assert.equal((await b.receive(sent.envelope)).duplicate,true);
  const changed=structuredClone(sent.envelope);changed.enc.ct=(changed.enc.ct.startsWith("0")?"1":"0")+changed.enc.ct.slice(1);await assert.rejects(b.receive(changed),/Invalid Pillar envelope/);
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
