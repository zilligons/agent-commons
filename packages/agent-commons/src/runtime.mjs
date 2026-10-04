import { randomUUID } from "node:crypto";
import { Keychain, seal, open, decrypt, envelopeSha, CarrierClient } from "./pillar.mjs";
import { CommonsStore } from "./store.mjs";
import { RegistryTrust } from "./trust.mjs";
import { BASE_PROTOCOL, createProfile, verifyProfile, proposeAlias, encode, decode, digest, signDocument, verifyDocument, contribution } from "./profiles.mjs";

export class AgentCommons {
  constructor({keychain,store=new CommonsStore(),policy={mode:"local",agents:{}},carriers=[],trust}={}){
    if(!keychain?._identity)throw new Error("A loaded Pillar keychain is required");
    this.keychain=keychain;this.store=store;this.policy=policy;this.trust=trust??new RegistryTrust({policy});this.carriers=carriers;
    for(const carrier of carriers){const url=new URL(carrier);if(policy.mode==="global"&&url.protocol!=="https:")throw new Error("Global carrier URLs must use HTTPS");if(url.username||url.password||url.search||url.hash)throw new Error("Carrier URLs must not embed credentials, queries, or fragments")}
    if(!store.verify())throw new Error("Audit integrity failure: runtime is fail-closed");
    this.transport=carriers.length?new CarrierClient({keychain,carriers}):null;
    this._applyTail=Promise.resolve();this._receiveTail=Promise.resolve();this._flushTail=Promise.resolve();
  }
  get uuaid(){return this.keychain._identity.uuaid}
  get publicKey(){return this.keychain._identity.publicKeyHex}
  profiles(){return this.store.get("profiles",[])}
  addProfile(profile){verifyProfile(profile);if(profile.scope==="global")throw new Error("Use importGlobal for published global profiles");const profiles=this.profiles();if(!profiles.some(p=>p.id===profile.id)){profiles.push(profile);this.store.set("profiles",profiles)}const active=this.store.get("active",{});if(!active[profile.namespace]){active[profile.namespace]=profile.id;this.store.set("active",active)}return profile}
  profile(id){const profile=this.profiles().find(p=>p.id===id);if(!profile)throw new Error("Unknown local profile digest");verifyProfile(profile);return profile}
  activeProfile(namespace){const active=this.store.get("active",{});const id=active[namespace]??this.profiles().filter(p=>p.namespace===namespace).sort((a,b)=>b.revision-a.revision)[0]?.id;if(!id)throw new Error("Unknown active profile namespace");return this.profile(id)}
  async authorizedProfile(id){const profile=this.profile(id);if(profile.scope==="global"){const code=this.store.get("globalProfilePins",{})[id];if(!code)throw new Error("Global profile publication binding is missing");await this.trust.publishedProfilePin(code,id)}return profile}
  async importGlobal(profile,code){verifyProfile(profile);if(profile.scope!=="global")throw new Error("Global profile scope required");await this.trust.publishedProfilePin(code,profile.id);const profiles=this.profiles();if(!profiles.some(p=>p.id===profile.id)){profiles.push(profile);this.store.set("profiles",profiles)}const pins=this.store.get("globalProfilePins",{});pins[profile.id]=code;this.store.set("globalProfilePins",pins);const active=this.store.get("active",{});active[profile.namespace]=profile.id;this.store.set("active",active);return profile}
  async propose(profileId,phrase){
    await this.trust.authorize(this.uuaid,this.publicKey,"commons:evolve");
    const proposal=proposeAlias(this.profile(profileId),phrase);
    const document=signDocument(this.keychain,"profile-proposal",{proposal});
    await this.apply(document);return document;
  }
  async vote(proposalId,approve,rationale=""){
    if(typeof approve!=="boolean"||typeof rationale!=="string"||rationale.length>2000)throw new Error("Invalid vote");
    await this.trust.authorize(this.uuaid,this.publicKey,"commons:evolve");
    return signDocument(this.keychain,"profile-vote",{proposalId,approve,rationale});
  }
  apply(document){const next=this._applyTail.then(()=>this.applyInternal(document));this._applyTail=next.catch(()=>{});return next}
  async applyInternal(document){
    const body=verifyDocument(document);
    if(this.store.seen(document.id,digest(document)))return {duplicate:true};
    if(!Number.isFinite(Date.parse(body.createdAt))||Math.abs(Date.now()-Date.parse(body.createdAt))>86400000)throw new Error("Stale profile document");
    const capability=body.kind==="profile-contribution"?"commons:contribute":body.kind==="profile-recovery"?"commons:recover":"commons:evolve";
    await this.trust.authorize(body.issuer,body.publicKey,capability);
    const proposals=this.store.get("proposals",[]);
    let result;
    if(body.kind==="profile-proposal"){
      const p=body.payload.proposal;
      const base=this.profile(p.parent);
      const recalculated=proposeAlias(base,p.phrase);
      if(p.candidate?.id!==recalculated.candidate.id||p.alias!==recalculated.alias||p.status!=="pending"||Object.keys(p.votes??{}).length)throw new Error("Proposal evidence is not reproducible");
      if(proposals.some(x=>x.id===p.id))throw new Error("Conflicting proposal ID");
      if(typeof p.id!=="string"||!/^[0-9a-f-]{36}$/.test(p.id))throw new Error("Invalid proposal ID");
      proposals.push({...p,author:body.issuer,authorPublicKey:body.publicKey,documentId:document.id});
      result={proposalId:p.id,status:"pending"};
    } else if(body.kind==="profile-vote"){
      const {proposalId,approve}=body.payload;
      const p=proposals.find(p=>p.id===proposalId);
      if(!p||p.status!=="pending"||p.author===body.issuer||Object.hasOwn(p.votes,body.issuer)||typeof approve!=="boolean")throw new Error("Ineligible or duplicate peer vote");
      p.votes[body.issuer]={approve,document};
      const parent=this.profile(p.parent);
      await this.trust.authorize(p.author,p.authorPublicKey,"commons:evolve");
      // Recheck every previously approving peer: revoked or unadmitted votes
      // cannot remain valid just because their old signature still verifies.
      const approvals=[];
      for(const vote of Object.values(p.votes)){
        if(!vote.approve)continue;
        const voter=verifyDocument(vote.document);
        await this.trust.authorize(voter.issuer,voter.publicKey,"commons:evolve");
        approvals.push(voter.issuer);
      }
      if(approvals.length>=parent.quorum){
        const latest=this.activeProfile(parent.namespace);
        if(latest.id!==p.parent)throw new Error("Stale proposal cannot replace a newer local profile");
        verifyProfile(p.candidate);
        if(parent.scope==="global")throw new Error("Local votes cannot ratify global profile changes");
        p.status="adopted";
      }
      result={proposalId:p.id,status:p.status,approvals:approvals.length};
    } else if(body.kind==="profile-contribution"){
      const candidate=body.payload.contribution;
      if(candidate?.stage!=="candidate"||candidate?.base!==BASE_PROTOCOL)throw new Error("Invalid global contribution stage");
      if(candidate.profile){verifyProfile(candidate.profile);if(candidate.profile.id!==candidate.profileId)throw new Error("Contribution digest mismatch")}
      const queue=this.store.get("contributions",[]);
      queue.push({id:document.id,issuer:body.issuer,candidate,stage:"awaiting-independent-review",ratified:false});
      result={stage:"awaiting-independent-review",ratified:false};
      this.store.transaction(()=>{this.store.set("contributions",queue);this.store.mark(document.id,digest(document));this.store.append(document.id,{kind:body.kind,issuer:body.issuer,digest:digest(document),result})});return result;
    } else if(body.kind==="profile-recovery"){
      await this.trust.authorize(body.issuer,body.publicKey,"commons:recover");
      const profile=this.profile(body.payload.profileId);
      if(profile.scope==="global")throw new Error("Global recovery needs independent IAASO disposition, not a local rollback");
      if(typeof body.payload.reason!=="string"||body.payload.reason.length<3)throw new Error("Recovery rationale required");
      this.store.transaction(()=>{const active=this.store.get("active",{});active[profile.namespace]=profile.id;this.store.set("active",active);this.store.mark(document.id,digest(document));this.store.append(document.id,{kind:body.kind,issuer:body.issuer,profileId:profile.id,reason:body.payload.reason})});
      return {status:"local-profile-pinned",profileId:profile.id};
    } else throw new Error("Unsupported profile control document");
    this.store.transaction(()=>{
      this.store.set("proposals",proposals);
      const adopted=proposals.find(p=>p.id===result.proposalId&&p.status==="adopted");
      if(adopted){if(!this.profiles().some(p=>p.id===adopted.candidate.id)){const profiles=this.profiles();profiles.push(adopted.candidate);this.store.set("profiles",profiles)}const active=this.store.get("active",{});active[adopted.candidate.namespace]=adopted.candidate.id;this.store.set("active",active)}
      this.store.mark(document.id,digest(document));this.store.append(document.id,{kind:body.kind,issuer:body.issuer,digest:digest(document),result});
    });
    return result;
  }
  async prepareContribution(profileId,options={}){
    await this.trust.authorize(this.uuaid,this.publicKey,"commons:contribute");
    return signDocument(this.keychain,"profile-contribution",{contribution:contribution(this.profile(profileId),options)});
  }
  async send({recipient,profileId,namespace,body,thread="commons",kind="message",deferFlush=false}){
    if(typeof body!=="string"||Buffer.byteLength(body)>32000||typeof thread!=="string"||thread.length>120||!["message","profile-control"].includes(kind))throw new Error("Invalid bounded message");
    const recipientKey=this.policy.agents?.[recipient]?.publicKey;
    await this.trust.authorize(this.uuaid,this.publicKey,"commons:message");
    await this.trust.authorize(recipient,recipientKey,"commons:message");
    if(!profileId)profileId=this.activeProfile(namespace).id;
    const profile=await this.authorizedProfile(profileId);
    const payload={v:BASE_PROTOCOL,id:randomUUID(),kind,thread,profileId:profile.id,wire:encode(body,profile.lexicon),bodyHash:digest(body),expiresAt:new Date(Date.now()+3600000).toISOString()};
    const envelope=seal(this.keychain,{recipient,recipientPublicKey:recipientKey,kind:BASE_PROTOCOL,payload});
    this.store.queue(envelope,profile.id);
    if(!this.transport||deferFlush)return {envelope,state:"pending",reason:deferFlush?"Queued for bounded batch delivery":"No configured carrier"};
    const result=await this.flush();return {envelope,result};
  }
  async broadcast({recipients,...message}){
    if(!Array.isArray(recipients)||!recipients.length||recipients.length>32||new Set(recipients).size!==recipients.length)throw new Error("Broadcast requires 1–32 distinct agent recipients");
    for(const recipient of recipients)await this.trust.authorize(recipient,this.policy.agents?.[recipient]?.publicKey,"commons:message");
    const queued=[];
    for(const recipient of recipients)queued.push(await this.send({...message,recipient,deferFlush:true}));
    return {queued:queued.map(x=>({recipient:x.envelope.recipient,id:x.envelope.id})),deliveries:await this.flush(),groupPrivacy:"individually-sealed-recipient-copies"};
  }
  flush(){const next=this._flushTail.then(()=>this.flushInternal());this._flushTail=next.catch(()=>{});return next}
  async flushInternal(){
    if(!this.transport)return [];
    const results=[];
    for(const row of this.store.pending()){
      try{const envelope=JSON.parse(row.body);if(!open(envelope).ok||envelope.sender!==this.uuaid||envelope.id!==row.id)throw new Error("Outbox integrity or sender mismatch");if(row.profile_id)await this.authorizedProfile(row.profile_id);await this.trust.authorize(this.uuaid,this.publicKey,"commons:message");await this.trust.authorize(envelope.recipient,this.policy.agents?.[envelope.recipient]?.publicKey,"commons:message");const receipt=await this.transport.deliver(envelope,{timeoutMs:10000});this.store.delivered(row.id);this.store.append(`outbox-${row.id}`,{kind:"carrier-accepted",id:row.id,sha:envelopeSha(envelope),carrier:receipt.carrier});results.push({id:row.id,state:"carrier-accepted",receipt})}
      catch(error){this.store.failure(row.id,error.message);results.push({id:row.id,state:"retry-or-quarantine",error:error.code??error.message})}
    }
    return results;
  }
  receive(envelope){const next=this._receiveTail.then(()=>this.receiveInternal(envelope));this._receiveTail=next.catch(()=>{});return next}
  async receiveInternal(envelope){
    const valid=open(envelope);if(!valid.ok)throw new Error(`Invalid Pillar envelope: ${valid.reason}`);
    if(envelope.delegation!==undefined)throw new Error("Delegated host admission requires a configured principal-status adapter; not yet enabled");
    await this.trust.authorize(envelope.sender,envelope.transportSignature.publicKey,"commons:message");
    const payload=decrypt(this.keychain,envelope);
    if(payload?.v!==BASE_PROTOCOL||payload.profileId===undefined||!["message","profile-control"].includes(payload.kind)||typeof payload.wire!=="string"||Buffer.byteLength(payload.wire)>64000||typeof payload.id!=="string"||!/^[0-9a-f-]{36}$/.test(payload.id)||!Number.isFinite(Date.parse(payload.expiresAt))||Date.parse(payload.expiresAt)<=Date.now())throw new Error("Invalid or expired Agent Commons payload");
    if(this.store.seen(payload.id,digest(payload)))return {duplicate:true};
    const profile=await this.authorizedProfile(payload.profileId),body=decode(payload.wire,profile.lexicon);
    if(digest(body)!==payload.bodyHash)throw new Error("Lossless body digest mismatch");
    if(payload.kind==="profile-control"){
      const result=await this.apply(JSON.parse(body));
      this.store.transaction(()=>{this.store.mark(payload.id,digest(payload));this.store.append(payload.id,{kind:"control-received",sender:envelope.sender,envelopeId:envelope.id,result})});
      return {id:payload.id,kind:payload.kind,result};
    }
    this.store.transaction(()=>{this.store.mark(payload.id,digest(payload));this.store.append(payload.id,{kind:"message-received",sender:envelope.sender,envelopeId:envelope.id,profileId:profile.id,bodyHash:payload.bodyHash,wireBytes:Buffer.byteLength(payload.wire)})});
    return {id:payload.id,sender:envelope.sender,thread:payload.thread,body,profileId:profile.id,receipt:{kind:"host-accepted",notProofOfTaskCompletion:true}};
  }
  async poll(){
    if(!this.transport)throw new Error("No carrier configured");
    const cursors=this.store.get("cursors",{}),health=this.store.get("carrierHealth",{}),results=[];
    for(const carrier of this.carriers){
      if(health[carrier]?.nextProbeAt>Date.now()){results.push({carrier,rejected:true,state:"bounded-backoff"});continue}
      let inbox;
      try{inbox=await this.transport.fetchInbox(carrier,{since:cursors[carrier]??0,waitS:0,timeoutMs:10000});health[carrier]={failures:0,nextProbeAt:0};this.store.set("carrierHealth",health)}
      catch(error){const failures=(health[carrier]?.failures??0)+1;health[carrier]={failures,nextProbeAt:Date.now()+Math.min(60000,1000*2**Math.min(failures,6)),error:error.code??"carrier-unavailable"};this.store.set("carrierHealth",health);this.store.append(randomUUID(),{kind:"carrier-poll-failed",carrier,failures,reason:error.code??"carrier-unavailable"});results.push({carrier,rejected:true,state:failures>=3?"circuit-backoff":"retry-backoff"});continue}
      for(const item of inbox.envelopes){
        try{results.push(await this.receive(item.envelope))}
        catch(error){results.push({id:item.envelope.id,rejected:true,reason:error.message});this.store.append(`rejected-${item.envelope.id}`,{kind:"quarantined-inbound",id:item.envelope.id,reason:error.message})}
        cursors[carrier]=item.seq;this.store.set("cursors",cursors);
      }
    }
    return results;
  }
  async retryOutbox(envelopeId){
    await this.trust.authorize(this.uuaid,this.publicKey,"commons:recover");
    const row=this.store.db.prepare("SELECT * FROM outbox WHERE id=?").get(envelopeId);
    if(!row||row.state!=="quarantined")throw new Error("Only a known quarantined outbox envelope can be retried");
    const envelope=JSON.parse(row.body);
    if(row.profile_id)await this.authorizedProfile(row.profile_id);
    if(!open(envelope).ok||envelope.sender!==this.uuaid||Date.parse(envelope.createdAt)<Date.now()-3500000)throw new Error("Envelope is invalid or expired; create a fresh authorized message instead");
    await this.trust.authorize(envelope.recipient,this.policy.agents?.[envelope.recipient]?.publicKey,"commons:message");
    this.store.transaction(()=>{this.store.db.prepare("UPDATE outbox SET attempts=0,next_at=0,state='pending',error=NULL WHERE id=?").run(envelopeId);this.store.append(randomUUID(),{kind:"outbox-retry-authorized",envelopeId,issuer:this.uuaid})});
    return {id:envelopeId,state:"pending",networkCallMade:false};
  }
  status(){return {name:"Agent Commons",protocol:BASE_PROTOCOL,uuaid:this.uuaid,publicKey:this.publicKey,mode:this.policy.mode??"local",profiles:this.profiles().map(p=>({id:p.id,name:p.name,namespace:p.namespace,scope:p.scope,revision:p.revision})),activeProfiles:this.store.get("active",{}),carriers:this.carriers,pending:this.store.pending().length,proposals:this.store.get("proposals",[]).length,contributions:this.store.get("contributions",[]).length,auditVerified:this.store.verify(),standardization:"draft-profile-not-IAASO-certified"}}
}
