/** Synchronous space policy and operator stops. Queue ownership and sends belong to the adapter. */
import { isDeepStrictEqual } from "node:util";
import { keyBindsUuaid, manifestHash } from "./pillar-group.mjs";
import { agentRecordForRow, agentRecordsFromVerifiedHead, verifiedHead, selfCheck, signAndApplyNext } from "./manifest.mjs";
import { prunePendingRemovals, validateAdapterState } from "./store.mjs";

const POLICY_FIELDS=["mode","channelsEnabled","holdBeforeAdmission","agents","tenantProfiles","channels"];
const emergencyEngines=new WeakSet(); // replacement invalidates the cached shared identity until a fresh engine is constructed
function plainPolicy(value){return value!==null&&typeof value==="object"&&[Object.prototype,null].includes(Object.getPrototypeOf(value))}
function latched(state){return state.hardStop!==null}
export class PolicyError extends Error {
  constructor(name,message){super(message);this.name=name}
}
export function assertPolicyIdentity(engine){
  const policy=engine?.policy,prototype=policy&&Object.getPrototypeOf(policy);
  if(policy===null||typeof policy!=="object"||(prototype!==Object.prototype&&prototype!==null)||Object.isFrozen(policy)||!Object.isExtensible(policy)||policy!==engine?.trust?.policy){
    throw new PolicyError("PolicyIdentityError","Engine and trust must share one mutable plain policy object");
  }
  return policy;
}
function channels(groupId){return {content:`channel://agentnet/group/${groupId}`,control:`channel://agentnet/group-ctl/${groupId}`}}
function closed(groupId){
  const uris=channels(groupId);
  return {mode:"local",channelsEnabled:true,holdBeforeAdmission:true,agents:{},tenantProfiles:{},channels:{[uris.content]:{members:[]},[uris.control]:{members:[]}}};
}
function outsideAllowlist(rows,allowlist){
  return rows.find(row=>!allowlist.some(allowed=>allowed.uuaid===row.uuaid&&allowed.key===row.key));
}
function outsider(rec,state,allowlist){
  const head=verifiedHead(rec),rows=[...head.members.filter(row=>row.status!=="removed"),...state.pendingRemovals];
  return outsideAllowlist(rows,allowlist);
}
function closePolicies(policy,groupId,engine){
  let failure;
  const references=[engine,engine?.trust].filter(Boolean);
  for(const candidate of new Set([policy,engine?.policy,engine?.trust?.policy])){
    try{
      if(!plainPolicy(candidate)||!Object.isExtensible(candidate))throw new TypeError("Authority policy cannot be closed in place");
      Object.assign(candidate,closed(groupId));
    }catch(error){
      failure??=error;
      for(const owner of references){
        if(owner.policy!==candidate)continue;
        try{
          const replacement=closed(groupId);owner.policy=replacement;
          if(owner.policy!==replacement)throw new TypeError("Authority policy replacement did not take effect");
          emergencyEngines.add(engine);
        }catch(fallbackError){failure??=fallbackError}
      }
    }
  }
  let allClosed=false;
  try{allClosed=(engine?[engine.policy,engine.trust?.policy]:[policy]).every(value=>plainPolicy(value)&&POLICY_FIELDS.every(field=>isDeepStrictEqual(value[field],closed(groupId)[field])))}catch(error){failure??=error}
  return {closed:allClosed,error:failure??(allClosed?null:new PolicyError("PolicyCloseError","An authority consumer remains open"))};
}
function requireSharedPolicy(policy,engine){
  if(assertPolicyIdentity(engine)!==policy)throw new PolicyError("PolicyIdentityError","Restart with a fresh engine to recover the shared policy identity");
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
function stop(policy,state,reason,{engine,store,onSignal=()=>{},now=Date.now()}={}){
  if(state.hardStop===null)state.hardStop={reason,at:now};
  let persisted=false,failure;
  try{store.saveAdapter(state.groupId,state);persisted=true}catch(error){failure=error}
  const outcome=closePolicies(policy,state.groupId,engine);failure??=outcome.error;
  try{onSignal({code:"SPACE_CLOSED",groupId:state.groupId,...state.hardStop,persisted,closed:outcome.closed})}catch(error){failure??=error}
  if(failure)throw failure;
  return false;
}
/** P-9 reads the verified files again; a policy file is never an input. */
export function checkPolicy(policy,rec,self,state,ext,allowlist,options){
  // rec, ext and allowlist remain for caller compatibility; the check reads the persisted inputs again.
  const {engine,store,now=Date.now()}=options;
  const loaded=store.loadAdapter(state.groupId,{now});
  const saved=store.loadRoster(state.groupId),savedState=loaded?.state;
  if(!savedState)throw new PolicyError("AdapterAbsentError","No persisted adapter state for policy check");
  const expected=latched(savedState)?closed(state.groupId):expectedPolicy(saved,self,savedState,verifiedHead(saved).ext.commons,now);
  const bound=Object.entries(policy.agents??{}).every(([uuaid,agent])=>keyBindsUuaid(uuaid,agent?.publicKey)&&agent?.kind==="agent"&&isDeepStrictEqual(agent?.capabilities,["commons:message"]));
  if(policy===engine.policy&&policy===engine.trust.policy&&bound&&POLICY_FIELDS.every(field=>isDeepStrictEqual(policy[field],expected[field])))return true;
  return stop(policy,state,"policy-mismatch",options);
}
/** One run-to-completion write. The options supply the actual engine, store and operator signal. */
export function writePolicy(policy,rec,self,state,ext,allowlist,options){
  try{
  if(latched(state)){Object.assign(policy,closed(state.groupId));checkPolicy(policy,rec,self,state,ext,allowlist,options);return policy}
  if(emergencyEngines.has(options.engine))requireSharedPolicy(policy,options.engine);
  if(outsider(rec,state,allowlist)){stop(policy,state,"outsider",options);checkPolicy(policy,rec,self,state,ext,allowlist,options);return policy}
  const expected=expectedPolicy(rec,self,state,ext,options.now??Date.now());
  Object.assign(policy,expected);
  checkPolicy(policy,rec,self,state,ext,allowlist,options);
  return policy;
  }catch(error){
    closePolicies(policy,state.groupId,options.engine);
    throw error;
  }
}

/** Owns only policy/state operations; the future adapter invokes these on its serial queue. */
export class SpacePolicy {
  constructor({engine,store,groupId,allowlist,onSignal=()=>{},clock=Date.now}){
    this.policy=assertPolicyIdentity(engine);
    this.engine=engine;this.store=store;this.groupId=groupId;this.self=engine.keychain;
    this.allowlist=allowlist;this.onSignal=onSignal;this.clock=clock;
    if(!Array.isArray(allowlist))throw new PolicyError("AllowlistError","An explicit operator allowlist is required");
    Object.assign(this.policy,closed(this.groupId));
    this.rebuild();
  }
  _load(){
    const now=this.clock(),loaded=this.store.loadAdapter(this.groupId,{now});
    if(!loaded)throw new PolicyError("AdapterAbsentError","No adapter state; installation is a separate operation");
    return {rec:this.store.loadRoster(this.groupId),state:loaded.state,now};
  }
  _options(now){return {engine:this.engine,store:this.store,onSignal:this.onSignal,now}}
  rebuild(){
    try{
    const {rec,state,now}=this._load();
    if(latched(state))writePolicy(this.policy,rec,this.self,state,null,this.allowlist,this._options(now));
    if(!rec){if(latched(state))return this.policy;throw new PolicyError("RosterAbsentError","No verified roster for policy rebuild")}
    const head=verifiedHead(rec);selfCheck(this.self,rec);
    if(!latched(state)&&emergencyEngines.has(this.engine))requireSharedPolicy(this.policy,this.engine);
    // Inspect every verified change since consent, including changes reverted while this instance was down.
    const after=rec.chain.filter(manifest=>manifest.version>state.consent.manifestVersion);
    let previous=rec.chain.find(manifest=>manifest.version===state.consent.manifestVersion)?.ext.commons;
    if(!previous)throw new PolicyError("ConsentHeadError","Consent must name a verified manifest version");
    let changed=false,reconsentSignal=false;
    for(const manifest of after){
      const current=manifest.ext.commons;
      if(!isDeepStrictEqual(previous.profile,current.profile)||previous.tenant!==current.tenant){
        if(state.softStop===null){state.softStop={reason:"reconsent",at:now};changed=true;reconsentSignal=true}
      }
      previous=current;
    }
    const scanned=rec.chain.find(manifest=>manifest.version===state.outsiderScan.version);
    const scanVersion=scanned&&manifestHash(scanned)===state.outsiderScan.hash?scanned.version:0;
    const unseen=rec.chain.filter(manifest=>manifest.version>scanVersion);
    const hit=unseen.some(manifest=>outsideAllowlist(manifest.members.filter(row=>row.status!=="removed"),this.allowlist));
    const from=state.outsiderScan,to={version:head.version,hash:manifestHash(head)};
    if(!isDeepStrictEqual(from,to)){state.outsiderScan=to;changed=true}
    if(hit&&!latched(state))stop(this.policy,state,"outsider",this._options(now));
    else{
      if(changed)this.store.saveAdapter(this.groupId,state);
      if(hit)this.onSignal({code:"SPACE_OUTSIDER_SEEN",groupId:this.groupId,from,to});
    }
    if(reconsentSignal)this.onSignal({code:"SPACE_RECONSENT_REQUIRED",groupId:this.groupId,at:now});
    return writePolicy(this.policy,rec,this.self,state,head.ext.commons,this.allowlist,this._options(now));
    }catch(error){
      try{closePolicies(this.policy,this.groupId,this.engine)}catch{} // retain the original read/write failure
      throw error;
    }
  }
  /** Call after rebuild(), including after pending TTL expiry; the adapter owns the expiry timer. */
  check(){
    try{
    const {rec,state,now}=this._load();
    return checkPolicy(this.policy,rec,this.self,state,latched(state)?null:verifiedHead(rec).ext.commons,this.allowlist,this._options(now));
    }catch(error){
      try{closePolicies(this.policy,this.groupId,this.engine)}catch{}
      throw error;
    }
  }
  hardResume(){
    requireSharedPolicy(this.policy,this.engine);
    const {rec,state,now}=this._load(),head=verifiedHead(rec);selfCheck(this.self,rec);
    if(!isDeepStrictEqual(state.outsiderScan,{version:head.version,hash:manifestHash(head)}))throw new PolicyError("OutsiderScanBehindError","Run rebuild first: outsider scan is behind the verified head");
    if(outsider(rec,state,this.allowlist))throw new PolicyError("OutsiderError","Hard resume requires an outsider-free verified head and pending set");
    state.hardStop=null;this.store.saveAdapter(this.groupId,state);
    return this.rebuild();
  }
  reconsent(consent){
    if(emergencyEngines.has(this.engine))requireSharedPolicy(this.policy,this.engine);
    const {rec,state}=this._load(),head=verifiedHead(rec);
    state.consent=structuredClone(consent);state.profile=structuredClone(head.ext.commons.profile);state.softStop=null;
    validateAdapterState(state,this.groupId);
    if(state.consent.manifestVersion!==head.version)throw new PolicyError("ConsentHeadError","Reconsent must name the current verified manifest");
    this.store.saveAdapter(this.groupId,state);
    return this.rebuild(); // E-3's checked profile installation remains the installer's responsibility.
  }
  /** P-7: reserved envelope id is mandatory for a remove/leave; roster FIRST, adapter SECOND. */
  applyOwnChange(action,buildOpts={}, {outboxId}={}){
    if(emergencyEngines.has(this.engine))requireSharedPolicy(this.policy,this.engine);
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
    try{
    if(nextState!==state)this.store.saveAdapter(this.groupId,nextState);
    }finally{this.rebuild()}
    return result;
  }
}
