/** Synchronous space policy and operator stops. Queue ownership and sends belong to the adapter. */
import { isDeepStrictEqual } from "node:util";
import { keyBindsUuaid } from "./pillar-group.mjs";
import { agentRecordForRow, agentRecordsFromVerifiedHead, verifiedHead, selfCheck, signAndApplyNext } from "./manifest.mjs";
import { prunePendingRemovals, validateAdapterState } from "./store.mjs";

const POLICY_FIELDS=["mode","channelsEnabled","holdBeforeAdmission","agents","tenantProfiles","channels"];
function latched(state){return state.hardStop!==null}
export class PolicyError extends Error {
  constructor(name,message){super(message);this.name=name}
}
export function assertPolicyIdentity(engine){
  const policy=engine?.policy,prototype=policy&&Object.getPrototypeOf(policy);
  if(policy===null||typeof policy!=="object"||(prototype!==Object.prototype&&prototype!==null)||Object.isFrozen(policy)||policy!==engine?.trust?.policy){
    throw new PolicyError("PolicyIdentityError","Engine and trust must share one mutable plain policy object");
  }
  return policy;
}
function channels(groupId){return {content:`channel://agentnet/group/${groupId}`,control:`channel://agentnet/group-ctl/${groupId}`}}
function closed(groupId){
  const uris=channels(groupId);
  return {mode:"local",channelsEnabled:true,holdBeforeAdmission:true,agents:{},tenantProfiles:{},channels:{[uris.content]:{members:[]},[uris.control]:{members:[]}}};
}
function outsider(rec,state,allowlist){
  const head=verifiedHead(rec),rows=[...head.members.filter(row=>row.status!=="removed"),...state.pendingRemovals];
  return rows.find(row=>!allowlist.some(allowed=>allowed.uuaid===row.uuaid&&allowed.key===row.key));
}
function expectedPolicy(rec,self,state,ext,now){
  if(latched(state))return closed(state.groupId);
  const head=verifiedHead(rec),rows=head.members.filter(row=>row.status!=="removed");
  const pending=prunePendingRemovals(state.pendingRemovals,rec,now).kept;
  const agents=agentRecordsFromVerifiedHead(rec);
  for(const entry of pending)agents[entry.uuaid]=agentRecordForRow(entry);
  const tenantProfiles={};
  if(ext.tenant!=null){for(const agent of Object.values(agents))agent.tenantId=ext.tenant;tenantProfiles[ext.profile.id]=ext.tenant}
  const selfId=self?._identity?.uuaid??self?.uuaid??self,me=head.members.find(row=>row.uuaid===selfId);
  const stopped=!!rec.frozen||state.softStop!==null;
  const content=stopped?[]:head.members.filter(row=>row.status==="active"&&!rec.leaving.includes(row.uuaid)).map(row=>row.uuaid);
  const control=[...new Set((rec.frozen?rows:[...rows,...pending]).map(row=>row.uuaid))];
  // P-6: a self-removed instance has no content or control channel authority.
  if(!me||me.status==="removed"){content.length=0;control.length=0}
  const uris=channels(state.groupId);
  return {mode:"local",channelsEnabled:true,holdBeforeAdmission:true,agents,tenantProfiles,channels:{[uris.content]:{members:content},[uris.control]:{members:control}}};
}
function stop(policy,state,reason,{store,onSignal=()=>{},now=Date.now()}={}){
  state.hardStop={reason,at:now};
  Object.assign(policy,closed(state.groupId));
  store.saveAdapter(state.groupId,state);
  onSignal({code:"SPACE_CLOSED",groupId:state.groupId,reason,at:now});
  return false;
}
/** P-9 reads the verified files again; a policy file is never an input. */
export function checkPolicy(policy,rec,self,state,ext,allowlist,options){
  const {engine,store,now=Date.now()}=options;
  const loaded=store.loadAdapter(state.groupId,{now});
  const saved=store.loadRoster(state.groupId),savedState=loaded?.state;
  if(!savedState)throw new PolicyError("AdapterAbsentError","No persisted adapter state for policy check");
  const expected=latched(savedState)?closed(state.groupId):expectedPolicy(saved,self,savedState,verifiedHead(saved).ext.commons,now);
  const bound=Object.entries(policy.agents??{}).every(([uuaid,agent])=>keyBindsUuaid(uuaid,agent.publicKey)&&agent.kind==="agent"&&isDeepStrictEqual(agent.capabilities,["commons:message"]));
  if(policy===engine.policy&&policy===engine.trust.policy&&bound&&POLICY_FIELDS.every(field=>isDeepStrictEqual(policy[field],expected[field])))return true;
  return stop(policy,state,"policy-mismatch",options);
}
/** One run-to-completion write. The options supply the actual engine, store and operator signal. */
export function writePolicy(policy,rec,self,state,ext,allowlist,options){
  if(latched(state)){Object.assign(policy,closed(state.groupId));checkPolicy(policy,rec,self,state,ext,allowlist,options);return policy}
  if(outsider(rec,state,allowlist)){stop(policy,state,"outsider",options);checkPolicy(policy,rec,self,state,ext,allowlist,options);return policy}
  const expected=expectedPolicy(rec,self,state,ext,options.now??Date.now());
  Object.assign(policy,expected);
  checkPolicy(policy,rec,self,state,ext,allowlist,options);
  return policy;
}

/** Owns only policy/state operations; the future adapter invokes these on its serial queue. */
export class SpacePolicy {
  constructor({engine,store,groupId,allowlist,onSignal=()=>{},clock=Date.now}){
    this.policy=assertPolicyIdentity(engine);
    this.engine=engine;this.store=store;this.groupId=groupId;this.self=engine.keychain;
    this.allowlist=allowlist;this.onSignal=onSignal;this.clock=clock;
    if(!Array.isArray(allowlist))throw new PolicyError("AllowlistError","An explicit operator allowlist is required");
    this.rebuild();
  }
  _load(){
    const now=this.clock(),loaded=this.store.loadAdapter(this.groupId,{now});
    if(!loaded)throw new PolicyError("AdapterAbsentError","No adapter state; installation is a separate operation");
    return {rec:this.store.loadRoster(this.groupId),state:loaded.state,now};
  }
  _options(now){return {engine:this.engine,store:this.store,onSignal:this.onSignal,now}}
  rebuild(){
    const {rec,state,now}=this._load();
    if(latched(state))writePolicy(this.policy,rec,this.self,state,null,this.allowlist,this._options(now));
    if(!rec){if(latched(state))return this.policy;throw new PolicyError("RosterAbsentError","No verified roster for policy rebuild")}
    const head=verifiedHead(rec);selfCheck(this.self,rec);
    // Inspect every verified change since consent, including changes reverted while this instance was down.
    const after=rec.chain.filter(manifest=>manifest.version>state.consent.manifestVersion);
    let previous=rec.chain.find(manifest=>manifest.version===state.consent.manifestVersion)?.ext.commons;
    if(!previous)throw new PolicyError("ConsentHeadError","Consent must name a verified manifest version");
    for(const manifest of after){
      const current=manifest.ext.commons;
      if(!isDeepStrictEqual(previous.profile,current.profile)||previous.tenant!==current.tenant){
        if(state.softStop===null){state.softStop={reason:"reconsent",at:now};this.store.saveAdapter(this.groupId,state);this.onSignal({code:"SPACE_RECONSENT_REQUIRED",groupId:this.groupId,at:now})}
      }
      previous=current;
    }
    return writePolicy(this.policy,rec,this.self,state,head.ext.commons,this.allowlist,this._options(now));
  }
  check(){
    const {rec,state,now}=this._load();
    return checkPolicy(this.policy,rec,this.self,state,latched(state)?null:verifiedHead(rec).ext.commons,this.allowlist,this._options(now));
  }
  hardResume(){
    const {rec,state,now}=this._load();verifiedHead(rec);selfCheck(this.self,rec);
    if(outsider(rec,state,this.allowlist))throw new PolicyError("OutsiderError","Hard resume requires an outsider-free verified head and pending set");
    state.hardStop=null;this.store.saveAdapter(this.groupId,state);
    return this.rebuild();
  }
  reconsent(consent){
    const {rec,state}=this._load(),head=verifiedHead(rec);
    state.consent=structuredClone(consent);state.profile=structuredClone(head.ext.commons.profile);state.softStop=null;
    validateAdapterState(state,this.groupId);
    if(state.consent.manifestVersion!==head.version)throw new PolicyError("ConsentHeadError","Reconsent must name the current verified manifest");
    this.store.saveAdapter(this.groupId,state);
    return this.rebuild(); // E-3's checked profile installation remains the installer's responsibility.
  }
  /** P-7: reserved envelope id is mandatory for a remove/leave; roster FIRST, adapter SECOND. */
  applyOwnChange(action,buildOpts={}, {outboxId}={}){
    const {rec,state,now}=this._load(),head=verifiedHead(rec);
    let nextState=state;
    if(action==="remove"||action==="leave"){
      const row=head.members.find(member=>member.uuaid===buildOpts.target);
      if(!row)throw new PolicyError("RemovalTargetError","A pending removal requires a row in the verified head");
      const pending={uuaid:row.uuaid,key:row.key,manifestVersion:head.version+1,queuedAt:now,outboxId};
      nextState={...state,pendingRemovals:[...state.pendingRemovals.filter(entry=>entry.uuaid!==row.uuaid),pending]};
      validateAdapterState(nextState,this.groupId); // preflight before either file write
    }
    const result=signAndApplyNext(this.store,this.groupId,this.self,action,buildOpts);
    if(nextState!==state)this.store.saveAdapter(this.groupId,nextState);
    this.rebuild();
    return result;
  }
}
