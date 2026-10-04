import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { UuaidClient, generateVaultKey } from "@uuaid/sdk";
import { Keychain } from "../src/pillar.mjs";
import { CommonsStore } from "../src/store.mjs";
import { ContinuityMemory, ContinuityError, MemoryContinuityStore, verifyContinuity, CONTINUITY_PROTOCOL, DEFAULT_LIMITS } from "../src/continuity.mjs";

function key(){const k=new Keychain("unused");k._identity=Keychain.generate();return k}

/** In-memory stand-in for api.uuaid.org's vault routes; records every request so tests can prove what crossed the wire. */
function fakeRegistry(){
  const items=new Map();const calls=[];
  const fetchImpl=async(url,init={})=>{
    const u=new URL(String(url));calls.push({url:u.pathname,method:init.method,body:init.body??null});
    const m=u.pathname.match(/^\/agents\/([^/]+)\/vault\/(.+)$/);
    if(!m)return new Response(JSON.stringify({error:"unexpected route"}),{status:500});
    const agent=decodeURIComponent(m[1]),slot=m[2].split("/").map(decodeURIComponent).join("/");const id=`${agent}|${slot}`;
    if(init.method==="PUT"){const {envelope}=JSON.parse(init.body);const replaced=items.has(id);const content_hash=createHash("sha256").update(JSON.stringify(envelope)).digest("hex");items.set(id,{agent,key:slot,envelope,content_hash,size_bytes:init.body.length});return new Response(JSON.stringify({agent,key:slot,content_hash,size_bytes:init.body.length,replaced}),{status:200})}
    if(init.method==="GET"){const item=items.get(id);return item?new Response(JSON.stringify(item),{status:200}):new Response(JSON.stringify({error:"not found"}),{status:404})}
    return new Response("",{status:405});
  };
  return {items,calls,client:new UuaidClient({apiKey:"uuaid_test_fixture_notasecret",fetchImpl})};
}

test("entries are signed, hash-chained, provenance-tagged, and survive a durable reload",()=>{
  const home=mkdtempSync(join(tmpdir(),"ac-cont-"));
  try{
    const k=key();const store=new CommonsStore(join(home,"commons.db"));
    const m=new ContinuityMemory({keychain:k,store});
    const a=m.remember("note",{text:"harbor"});
    const b=m.remember("commitment",{text:"run rollback fixture first"},{source:"operator",origin:"brief#1",evidence:"a".repeat(64),pin:true});
    assert.equal(a.previous,"genesis");assert.equal(b.previous,a.hash);assert.equal(a.seq,0);assert.equal(b.seq,1);
    assert.equal(a.provenance.actor,k._identity.uuaid);assert.equal(b.provenance.source,"operator");assert.equal(b.pin,true);
    assert.match(a.signature,/^[0-9a-f]{128}$/);assert.equal(m.verify(),true);assert.equal(m.head(),b.hash);
    assert.equal(m.status().durable,true);assert.equal(m.status().remote.configured,false);
    store.close();
    const reopened=new ContinuityMemory({keychain:k,store:new CommonsStore(join(home,"commons.db"))});
    assert.deepEqual(reopened.recall().map(e=>e.hash),[a.hash,b.hash]);assert.equal(reopened.recall({kind:"note"}).length,1);
    assert.equal(reopened.remember("note",{text:"after restart"}).seq,2);
    reopened.store.close();
  }finally{rmSync(home,{recursive:true,force:true})}
});

test("ledger is identity-scoped: two agents in one store never see each other and a foreign blob fails closed",()=>{
  const store=new CommonsStore(":memory:");const k1=key(),k2=key();
  const m1=new ContinuityMemory({keychain:k1,store}),m2=new ContinuityMemory({keychain:k2,store});
  m1.remember("note",{text:"mine"});assert.equal(m2.recall().length,0);
  store.set(ContinuityMemory.storeKey(k2._identity.uuaid),store.get(ContinuityMemory.storeKey(k1._identity.uuaid)));
  assert.throws(()=>new ContinuityMemory({keychain:k2,store}),e=>e instanceof ContinuityError&&e.code==="IDENTITY_MISMATCH");
  store.close();
});

test("tampered content, broken links, and forged signatures are refused on load; quarantine is explicit",()=>{
  const store=new MemoryContinuityStore();const k=key();const m=new ContinuityMemory({keychain:k,store});
  m.remember("note",{text:"one"});m.remember("note",{text:"two"});
  const skey=ContinuityMemory.storeKey(k._identity.uuaid);const good=store.get(skey);
  const tampered=structuredClone(good);tampered.entries[0].content.text="ONE";store.set(skey,tampered);
  assert.throws(()=>new ContinuityMemory({keychain:k,store}),e=>e.code==="INTEGRITY");
  const relinked=structuredClone(good);relinked.entries[1].previous="genesis";store.set(skey,relinked);
  assert.throws(()=>new ContinuityMemory({keychain:k,store}),e=>e.code==="INTEGRITY");
  const forged=structuredClone(good);const other=key();forged.entries[1].signature=other.sign(Buffer.from(forged.entries[1].hash,"hex")).toString("hex");store.set(skey,forged);
  assert.throws(()=>new ContinuityMemory({keychain:k,store}),e=>e.code==="INTEGRITY");
  const dropped=structuredClone(good);dropped.entries.pop();store.set(skey,dropped);// truncation without updating nextSeq is still a valid prefix; verify it loads but head differs
  assert.notEqual(new ContinuityMemory({keychain:k,store}).head(),good.entries[1].hash);
  store.set(skey,tampered);
  const q=ContinuityMemory.quarantine(store,k._identity.uuaid);assert.match(q,/:quarantine:/);
  assert.equal(new ContinuityMemory({keychain:k,store}).recall().length,0);
});

test("bounds and retention evict oldest unpinned entries while the chain stays verifiable; budgets fail closed",()=>{
  let t=Date.UTC(2026,0,1);const now=()=>t;const k=key();
  const m=new ContinuityMemory({keychain:k,limits:{maxEntries:3,retentionMs:1000},now});
  const e=[];for(let i=0;i<5;i++){t+=10;e.push(m.remember("note",{i}))}
  assert.equal(m.recall().length,3);assert.equal(m.status().pruned,2);assert.equal(m.status().anchor.previous,e[1].hash);assert.equal(m.recall()[0].previous,e[1].hash);assert.equal(m.verify(),true);
  t+=5000;const late=m.remember("note",{late:true});assert.deepEqual(m.recall().map(x=>x.hash),[late.hash]);assert.equal(m.status().pruned,5);assert.equal(m.status().anchor.previous,e[4].hash);assert.equal(m.verify(),true);
  assert.throws(()=>m.remember("note",{big:"x".repeat(DEFAULT_LIMITS.maxEntryBytes)}),e=>e.code==="ENTRY_TOO_LARGE");
  const pinned=new ContinuityMemory({keychain:k,limits:{maxEntries:2},now});
  pinned.remember("note",{p:1},{pin:true});pinned.remember("note",{p:2},{pin:true});
  assert.throws(()=>pinned.remember("note",{p:3}),e=>e.code==="BUDGET_EXHAUSTED");assert.equal(pinned.recall().length,2);assert.equal(pinned.verify(),true);
  const tiny=new ContinuityMemory({keychain:k,limits:{maxBytes:900},now});tiny.remember("note",{a:1});tiny.remember("note",{b:2});assert.equal(tiny.recall().length,1);assert.equal(tiny.verify(),true);
  assert.throws(()=>m.remember("Note",{}),e=>e.code==="ENTRY_INVALID");
  assert.throws(()=>m.remember("note",{},{source:"peer"}),e=>e.code==="ENTRY_INVALID");
  assert.throws(()=>m.remember("note",{},{source:"oracle"}),e=>e.code==="ENTRY_INVALID");
  assert.throws(()=>m.remember("note",{n:1.5}),e=>e.code==="ENTRY_INVALID");
});

test("explicit push/pull through the official SDK client: ciphertext only, slot bound, no registration",async()=>{
  const reg=fakeRegistry();const k=key();const vaultKey=generateVaultKey();
  const m=new ContinuityMemory({keychain:k,client:reg.client,vaultKey});
  m.remember("note",{text:"I remember the harbor."});
  assert.equal(reg.calls.length,0,"nothing leaves the process until push() is called");
  const pushed=await m.push();
  assert.equal(pushed.relation,"pushed");assert.equal(pushed.head,m.head());assert.match(pushed.contentHash,/^[0-9a-f]{64}$/);
  assert.equal(reg.calls.length,1);assert.equal(reg.calls[0].method,"PUT");
  assert.equal(reg.calls[0].url,`/agents/${encodeURIComponent(k._identity.uuaid)}/vault/continuity/chain`);
  assert.ok(!reg.calls[0].body.includes("harbor"));assert.ok(!reg.calls[0].body.includes(vaultKey));
  assert.equal(JSON.parse(reg.calls[0].body).envelope.aad,`${k._identity.uuaid}/continuity/chain`);
  const fresh=new ContinuityMemory({keychain:k,client:reg.client,vaultKey});
  const pulled=await fresh.pull();assert.equal(pulled.relation,"fast-forwarded");assert.equal(fresh.head(),m.head());assert.equal(fresh.recall()[0].content.text,"I remember the harbor.");
  assert.equal((await fresh.pull()).relation,"in-sync");
  fresh.remember("note",{text:"second session"});
  const {pull,push}=await fresh.sync();assert.equal(pull.relation,"local-ahead");assert.equal(push.relation,"pushed");assert.equal(push.replaced,true);
  assert.equal((await m.pull()).relation,"fast-forwarded");assert.equal(m.head(),fresh.head());
  assert.ok(reg.calls.every(c=>!(c.method==="POST")),"no registerAgent/signup/POST ever issued");
  assert.ok(!JSON.stringify(m.status()).includes(vaultKey));assert.ok(!JSON.stringify(m.snapshot()).includes(vaultKey));
});

test("remote-empty, divergence, wrong-identity, and wrong-key remote states fail closed",async()=>{
  const reg=fakeRegistry();const k=key();const vaultKey=generateVaultKey();
  const a=new ContinuityMemory({keychain:k,client:reg.client,vaultKey});
  assert.equal((await a.pull()).relation,"remote-empty");
  a.remember("note",{side:"a"});await a.push();
  const b=new ContinuityMemory({keychain:k,client:reg.client,vaultKey});b.remember("note",{side:"b"});
  await assert.rejects(b.pull(),e=>e.code==="DIVERGED");assert.equal(b.recall()[0].content.side,"b");
  await assert.rejects(b.sync(),e=>e.code==="DIVERGED");
  const wrongKey=new ContinuityMemory({keychain:k,client:reg.client,vaultKey:generateVaultKey()});
  await assert.rejects(wrongKey.pull(),e=>e.code==="REMOTE_UNAVAILABLE");
  const other=key();const impostor=new ContinuityMemory({keychain:other,client:reg.client,vaultKey});
  assert.equal((await impostor.pull()).relation,"remote-empty","a different UUAID addresses a different vault");
  const forwarded={saveMemory:reg.client.saveMemory.bind(reg.client),loadMemory:async()=>JSON.stringify(a.snapshot())};
  await assert.rejects(new ContinuityMemory({keychain:other,client:forwarded,vaultKey}).pull(),e=>e.code==="IDENTITY_MISMATCH");
  const relabelled={saveMemory:async(agent,slot)=>({agent,key:"somewhere/else"}),loadMemory:async()=>""};
  await assert.rejects(new ContinuityMemory({keychain:k,client:relabelled,vaultKey}).push(),e=>e.code==="REMOTE_MISMATCH");
  const corrupt={saveMemory:async()=>({}),loadMemory:async()=>"{not json"};
  await assert.rejects(new ContinuityMemory({keychain:k,client:corrupt,vaultKey}).pull(),e=>e.code==="INTEGRITY");
});

test("constructor refuses missing identity, non-official clients, bad vault keys, bad slots; remote ops refuse when unconfigured",async()=>{
  const k=key();
  assert.throws(()=>new ContinuityMemory({}),e=>e.code==="IDENTITY_REQUIRED");
  const unbound=key();unbound._identity={...unbound._identity,uuaid:"uuaid:foundation:agent:00000000-0000-4000-8000-000000000000"};
  assert.throws(()=>new ContinuityMemory({keychain:unbound}),e=>e.code==="IDENTITY_REQUIRED");
  assert.throws(()=>new ContinuityMemory({keychain:k,client:{registerAgent(){}}}),e=>e.code==="CLIENT_INVALID");
  assert.throws(()=>new ContinuityMemory({keychain:k,vaultKey:"hunter2"}),e=>e.code==="VAULT_KEY_INVALID");
  assert.throws(()=>new ContinuityMemory({keychain:k,slot:"../etc"}),e=>e.code==="SLOT_INVALID");
  assert.throws(()=>new ContinuityMemory({keychain:k,slot:"a//b"}),e=>e.code==="SLOT_INVALID");
  assert.throws(()=>new ContinuityMemory({keychain:k,limits:{maxEntries:0}}),e=>e.code==="BUDGET_EXHAUSTED");
  const local=new ContinuityMemory({keychain:k});
  await assert.rejects(local.push(),e=>e.code==="REMOTE_NOT_CONFIGURED");await assert.rejects(local.pull(),e=>e.code==="REMOTE_NOT_CONFIGURED");
  const halfConfigured=new ContinuityMemory({keychain:k,client:fakeRegistry().client});
  await assert.rejects(halfConfigured.sync(),e=>e.code==="REMOTE_NOT_CONFIGURED");
});

test("injected minimal store wrapper (get/set only, no transaction) works and snapshots verify standalone",()=>{
  const map=new Map();const wrapper={get:(k,f=null)=>map.has(k)?JSON.parse(map.get(k)):f,set:(k,v)=>map.set(k,JSON.stringify(v))};
  const k=key();const m=new ContinuityMemory({keychain:k,store:wrapper});m.remember("note",{w:1});
  assert.equal(m.status().durable,true);assert.equal([...map.keys()][0],`continuity:${k._identity.uuaid}`);
  const snap=m.snapshot();assert.equal(snap.v,CONTINUITY_PROTOCOL);assert.equal(snap.head,m.head());
  assert.equal(verifyContinuity(snap,{uuaid:k._identity.uuaid,publicKey:k._identity.publicKeyHex}),snap);
  assert.throws(()=>verifyContinuity({...snap,head:"0".repeat(64)},{uuaid:k._identity.uuaid,publicKey:k._identity.publicKeyHex}),e=>e.code==="INTEGRITY");
  const again=new ContinuityMemory({keychain:k,store:wrapper});assert.equal(again.head(),m.head());
});

test("two instances on one store for one identity: stale writer is refused, nothing lost, reload() required",()=>{
  const store=new CommonsStore(":memory:");const k=key();
  const a=new ContinuityMemory({keychain:k,store}),b=new ContinuityMemory({keychain:k,store});
  const fromA=a.remember("note",{by:"a"});
  assert.throws(()=>b.remember("note",{by:"b"}),e=>e.code==="STALE_WRITER"&&e.details.storedHead===fromA.hash);
  assert.equal(b.recall().length,0,"stale instance keeps its cached view; nothing merged");
  assert.equal(store.get(ContinuityMemory.storeKey(k._identity.uuaid)).entries.length,1,"store still holds A's write");
  assert.deepEqual(b.reload(),{head:fromA.hash,entries:1});
  const fromB=b.remember("note",{by:"b"});assert.equal(fromB.previous,fromA.hash);assert.equal(fromB.seq,1);
  assert.throws(()=>a.remember("note",{by:"a2"}),e=>e.code==="STALE_WRITER");
  assert.equal(a.recall().length,1);a.reload();assert.deepEqual(a.recall().map(e=>e.hash),[fromA.hash,fromB.hash]);
  assert.equal(a.remember("note",{by:"a2"}).seq,2);assert.equal(b.verify(),true);assert.equal(a.verify(),true);
  assert.throws(()=>b.compact(),e=>e.code==="STALE_WRITER");
  store.close();
});

test("pull/push race: a sibling write during the remote await is detected after the await, never overwritten",async()=>{
  const store=new CommonsStore(":memory:");const k=key();const vaultKey=generateVaultKey();
  const reg=fakeRegistry();
  const seed=new ContinuityMemory({keychain:k,store:new MemoryContinuityStore(),client:reg.client,vaultKey});seed.remember("note",{remote:1});await seed.push();
  const a=new ContinuityMemory({keychain:k,store,client:reg.client,vaultKey}),b=new ContinuityMemory({keychain:k,store,client:reg.client,vaultKey});
  // sibling B writes while A's loadMemory is in flight
  const racing={saveMemory:reg.client.saveMemory.bind(reg.client),loadMemory:async(...args)=>{b.remember("note",{local:"b"});return reg.client.loadMemory(...args)}};
  const a2=new ContinuityMemory({keychain:k,store,client:racing,vaultKey});
  await assert.rejects(a2.pull(),e=>e.code==="STALE_WRITER");
  assert.equal(store.get(ContinuityMemory.storeKey(k._identity.uuaid)).entries[0].content.local,"b","B's write survived A's pull");
  assert.equal(a2.recall().length,0);
  // A (stale cache) must not push either
  await assert.rejects(a.push(),e=>e.code==="STALE_WRITER");
  // after reload, local (b) and remote (seed) have diverged: refuse, do not merge
  a.reload();await assert.rejects(a.pull(),e=>e.code==="DIVERGED");
  // push race: sibling writes between saveMemory and receipt commit → STALE_WRITER surfaced, not recorded as success
  const c=new ContinuityMemory({keychain:k,store:new MemoryContinuityStore(),client:reg.client,vaultKey});await c.pull();
  const cStore=c.store;const sibling=new ContinuityMemory({keychain:k,store:cStore,client:reg.client,vaultKey});
  const racingSave={loadMemory:reg.client.loadMemory.bind(reg.client),saveMemory:async(...args)=>{sibling.remember("note",{slipped:true});return reg.client.saveMemory(...args)}};
  const c2=new ContinuityMemory({keychain:k,store:cStore,client:racingSave,vaultKey});c2.reload();
  await assert.rejects(c2.push(),e=>e.code==="STALE_WRITER");assert.equal(c2.status().remote.lastPush,null);
  store.close();
});

test("remote snapshots with valid signatures that exceed this instance's limits are rejected whole, never pruned",async()=>{
  const k=key();const vaultKey=generateVaultKey();let t=Date.UTC(2026,0,1);const now=()=>t;
  const reg=fakeRegistry();
  const writer=new ContinuityMemory({keychain:k,client:reg.client,vaultKey,limits:{maxEntries:10},now});
  t+=10;writer.remember("note",{n:1});t+=10;writer.remember("note",{n:2});await writer.push();
  const tight=new ContinuityMemory({keychain:k,client:reg.client,vaultKey,limits:{maxEntries:1},now});
  await assert.rejects(tight.pull(),e=>e.code==="LIMIT_EXCEEDED"&&e.details.entries===2&&e.details.limit===1);
  assert.equal(tight.recall().length,0);assert.equal(tight.status().remote.lastPull,null);
  await assert.rejects(tight.sync(),e=>e.code==="LIMIT_EXCEEDED");
  const smallEntry=new ContinuityMemory({keychain:k,client:reg.client,vaultKey,limits:{maxEntryBytes:300},now});
  await assert.rejects(smallEntry.pull(),e=>e.code==="LIMIT_EXCEEDED"&&/maxEntryBytes/.test(e.message));
  const smallTotal=new ContinuityMemory({keychain:k,client:reg.client,vaultKey,limits:{maxBytes:700},now});
  await assert.rejects(smallTotal.pull(),e=>e.code==="LIMIT_EXCEEDED"&&/maxBytes/.test(e.message));
  const shortRetention=new ContinuityMemory({keychain:k,client:reg.client,vaultKey,limits:{retentionMs:5},now});
  await assert.rejects(shortRetention.pull(),e=>e.code==="LIMIT_EXCEEDED"&&/retentionMs/.test(e.message));
  // identical limits: accepted
  const peer=new ContinuityMemory({keychain:k,client:reg.client,vaultKey,limits:{maxEntries:10},now});assert.equal((await peer.pull()).relation,"fast-forwarded");
  // owner-signed snapshot whose anchor bookkeeping was edited (signatures still valid) is rejected
  const owner={uuaid:k._identity.uuaid,publicKey:k._identity.publicKeyHex};const snap=writer.snapshot();
  assert.throws(()=>verifyContinuity({...snap,anchor:{...snap.anchor,pruned:3}},owner),e=>e.code==="INTEGRITY");
  assert.throws(()=>verifyContinuity({...snap,anchor:{previous:"f".repeat(64),pruned:1,through:null}},owner),e=>e.code==="INTEGRITY");
  assert.throws(()=>verifyContinuity({...snap,anchor:{...snap.anchor,through:"2030-01-01T00:00:00.000Z"}},owner),e=>e.code==="INTEGRITY");
  // a future-dated but validly signed entry is refused by the envelope
  const future=new ContinuityMemory({keychain:k,client:reg.client,vaultKey,limits:{maxEntries:10},now:()=>Date.UTC(2020,0,1)});
  await assert.rejects(future.pull(),e=>e.code==="LIMIT_EXCEEDED"&&/future/.test(e.message));
  // expired local entries are reported, block push until compact(), and are never shipped
  t+=DEFAULT_LIMITS.retentionMs+1;
  assert.equal(writer.status().expired,2);assert.equal(writer.verify(),true);
  await assert.rejects(writer.push(),e=>e.code==="LIMIT_EXCEEDED");
  assert.equal(writer.compact(),2);assert.equal(writer.status().pruned,2);assert.equal(writer.verify(),true);
  assert.equal((await writer.push()).relation,"pushed");
});
