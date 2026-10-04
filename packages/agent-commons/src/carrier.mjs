import { createServer } from "node:http";
import { open, envelopeSha, Keychain, jcs } from "./pillar.mjs";
import { CommonsStore } from "./store.mjs";
import { RegistryTrust } from "./trust.mjs";

export class CommonsCarrier {
  constructor({store=new CommonsStore(),trust=new RegistryTrust(),keychain=null,publicUrl=null,onEnvelope=null}={}){
    this.store=store;this.trust=trust;this.keychain=keychain;this.publicUrl=publicUrl;this.onEnvelope=onEnvelope;this.server=null;this.startedAt=Date.now();this.rates=new Map();
    this.waiters=new Map();this.waitCount=0;
  }
  async listen(port=0,host="127.0.0.1"){
    if(!["127.0.0.1","::1","localhost"].includes(host)&&(!this.publicUrl?.startsWith("https://")||this.trust.policy.mode!=="global"))throw new Error("Public bind requires global fail-closed policy and an HTTPS reverse-proxy URL");
    if(!["127.0.0.1","::1","localhost"].includes(host)){
      if(!this.keychain?._identity)throw new Error("Public carrier requires its own admitted agent identity");
      await this.trust.authorize(this.keychain._identity.uuaid,this.keychain._identity.publicKeyHex,"commons:relay");
    }
    if(!this.store.verify())throw new Error("Carrier audit integrity failure");
    this.server=createServer((req,res)=>void this.handle(req,res));
    this.server.headersTimeout=15000;this.server.requestTimeout=15000;
    await new Promise((resolve,reject)=>{this.server.once("error",reject);this.server.listen(port,host,resolve)});
    return this.server.address();
  }
  json(res,status,body){res.writeHead(status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(body))}
  rate(ip){
    const now=Date.now();if(this.rates.size>1000)this.rates.clear();
    const bucket=this.rates.get(ip)??{start:now,count:0};if(now-bucket.start>60000){bucket.start=now;bucket.count=0}
    bucket.count++;this.rates.set(ip,bucket);return bucket.count<=120;
  }
  async read(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>512000)throw new Error("Payload exceeds bounded carrier limit");chunks.push(chunk)}return JSON.parse(Buffer.concat(chunks).toString())}
  async waitFor(recipient,ms,res){
    if(this.waitCount>=32)throw new Error("Long-poll concurrency budget exhausted");
    this.waitCount++;
    await new Promise(resolve=>{
      const set=this.waiters.get(recipient)??new Set();this.waiters.set(recipient,set);
      const done=()=>{clearTimeout(timer);set.delete(done);if(!set.size)this.waiters.delete(recipient);this.waitCount--;res.off("close",done);resolve()};
      const timer=setTimeout(done,ms);set.add(done);res.once("close",done);
    });
  }
  async handle(req,res){
    try {
      if(!this.rate(req.socket.remoteAddress))return this.json(res,429,{error:"rate-limited"});
      const url=new URL(req.url,"http://localhost");
      if(req.method==="GET"&&url.pathname==="/v1/health")return this.json(res,200,{ok:true,implementation:"Agent Commons",protocol:"uuaid-pillar-envelope/2",uptime:Math.round((Date.now()-this.startedAt)/1000),auditVerified:this.store.verify()});
      if(req.method==="GET"&&url.pathname==="/.well-known/agent-commons")return this.json(res,200,{v:"agent-commons/1",role:this.onEnvelope?"host-client-and-carrier":"carrier",uuaid:this.keychain?._identity.uuaid??null,publicKey:this.keychain?._identity.publicKeyHex??null,transports:["pillar-carrier/v1"],mode:this.trust.policy.mode??"local",admission:"policy-gated-agent-identities",globalStandardization:"requires-IAASO-publication"});
      if(req.method==="GET"&&url.pathname==="/v1/seed-info"){
        if(!this.keychain||!this.publicUrl)return this.json(res,404,{error:"private-carrier"});
        const doc={v:1,url:this.publicUrl,uuaid:this.keychain._identity.uuaid,publicKey:this.keychain._identity.publicKeyHex,startedAt:new Date(this.startedAt).toISOString(),firstSeen:new Date(this.startedAt).toISOString(),stats:{relayed:this.store.db.prepare("SELECT COUNT(*) AS n FROM envelopes").get().n,served:0,stored:this.store.db.prepare("SELECT COUNT(*) AS n FROM envelopes").get().n},now:new Date().toISOString()};
        return this.json(res,200,{...doc,sig:this.keychain.sign(Buffer.from(jcs(doc))).toString("hex")});
      }
      if(req.method==="POST"&&url.pathname==="/v1/envelopes"){
        const envelope=await this.read(req),valid=open(envelope);
        if(!valid.ok)return this.json(res,400,{accepted:false,reason:valid.reason});
        if(envelope.delegation!==undefined)return this.json(res,403,{accepted:false,reason:"delegated-admission-not-configured"});
        const timestamp=Date.parse(envelope.createdAt);
        if(!Number.isFinite(timestamp)||Math.abs(Date.now()-timestamp)>86400000)return this.json(res,400,{accepted:false,reason:"envelope-stale"});
        await this.trust.authorize(envelope.sender,envelope.transportSignature.publicKey,"commons:relay");
        if(this.onEnvelope&&envelope.recipient===this.keychain?._identity.uuaid)await this.onEnvelope(envelope);
        const receipt=this.store.transaction(()=>{const receipt=this.store.retain(envelope,envelopeSha(envelope));if(!receipt.duplicate)this.store.append(`carrier-${envelope.id}`,{kind:"carrier-recorded",envelopeId:envelope.id,sender:envelope.sender,recipient:envelope.recipient,sha:receipt.sha});return receipt});
        for(const done of [...(this.waiters.get(envelope.recipient)??[])])done();
        return this.json(res,202,{accepted:true,...receipt,proof:"carrier-recorded-not-recipient-read"});
      }
      if(req.method==="GET"&&url.pathname.startsWith("/v1/inbox/")){
        const uuaid=decodeURIComponent(url.pathname.slice("/v1/inbox/".length)),since=Number(url.searchParams.get("since")??0);
        const pub=req.headers["x-pillar-pubkey"],ts=req.headers["x-pillar-ts"],sig=req.headers["x-pillar-sig"];
        if(!Number.isSafeInteger(since)||since<0||typeof pub!=="string"||typeof ts!=="string"||typeof sig!=="string"||!/^[0-9a-f]{128}$/.test(sig)||Math.abs(Date.now()-Number(ts))>300000||!Number.isFinite(Number(ts)))return this.json(res,401,{error:"invalid-inbox-auth"});
        const signed=Buffer.from(`GET /v1/inbox/${uuaid}?since=${since}\n${ts}`);
        if(!Keychain.verifyDetached(pub,signed,Buffer.from(sig,"hex")))return this.json(res,401,{error:"bad-inbox-signature"});
        await this.trust.authorize(uuaid,pub,"commons:message");
        const wait=Number(url.searchParams.get("wait")??0);
        if(!Number.isFinite(wait)||wait<0)return this.json(res,400,{error:"invalid-wait"});
        if(!this.store.inbox(uuaid,since).length&&wait>0)await this.waitFor(uuaid,Math.min(wait,25)*1000,res);
        if(res.destroyed)return;
        return this.json(res,200,{envelopes:this.store.inbox(uuaid,since),now:Date.now()});
      }
      return this.json(res,404,{error:"not-found"});
    } catch(error){return this.json(res,error.code?403:400,{accepted:false,reason:error.code??"invalid-request",message:error.message.slice(0,200)})}
  }
  async close(){for(const set of [...this.waiters.values()])for(const done of [...set])done();if(this.server){await new Promise(resolve=>this.server.close(resolve));this.server=null}}
}
