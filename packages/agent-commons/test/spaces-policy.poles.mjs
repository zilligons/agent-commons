import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const source=fileURLToPath(new URL("../",import.meta.url)),scratch=mkdtempSync(join(tmpdir(),"spaces-policy-poles-"));
const replace=(text,before,after)=>{if(text.split(before).length!==2)throw new Error(`Mutation target must be unique: ${before}`);return text.replace(before,after)};
const mutations=[
  ["P-2-extra-capability","P-2",text=>replace(text,'  const tenantProfiles={};','  Object.values(agents)[0].capabilities.push("commons:evolve");\n  const tenantProfiles={};')],
  ["P-5-leaver-retained","P-5",text=>replace(text,'row.status==="active"&&!rec.leaving.includes(row.uuaid)','row.status==="active"')],
  ["P-7-pending-step-removed","P-7 own",text=>replace(text,'    if(nextState!==state)this.store.saveAdapter(this.groupId,nextState);','')],
  ["C20-adapter-first","C20 roster-first crash",text=>{
    const roster='    result=signAndApplyNext(this.store,this.groupId,this.self,action,buildOpts);\n',adapter='    if(nextState!==state)this.store.saveAdapter(this.groupId,nextState);\n';
    return replace(replace(text,roster,''),adapter,adapter+roster);
  }],
  ["P-9-self-check-removed","P-9",text=>replace(text,'export function checkPolicy(policy,rec,self,state,ext,allowlist,options){','export function checkPolicy(policy,rec,self,state,ext,allowlist,options){return true;')],
  ["CL-hard-latch-ignored","CL-1..4",text=>replace(text,'function latched(state){return state.hardStop!==null}','function latched(state){return false}')],
  ["HS-reconsent-clears-hard-stop","HS-2 reconsent of a safe head",text=>replace(text,'state.profile=structuredClone(head.ext.commons.profile);state.softStop=null;','state.profile=structuredClone(head.ext.commons.profile);state.softStop=null;state.hardStop=null;')],
  ["P-12-revert-clears-soft-stop","P-12",text=>replace(text,'    return writePolicy(this.policy,rec,this.self,state,head.ext.commons,this.allowlist,this._options(now));','    const consented=rec.chain.find(manifest=>manifest.version===state.consent.manifestVersion).ext.commons;\n    if(isDeepStrictEqual(consented.profile,head.ext.commons.profile)&&consented.tenant===head.ext.commons.tenant){state.softStop=null;this.store.saveAdapter(this.groupId,state);}\n    return writePolicy(this.policy,rec,this.self,state,head.ext.commons,this.allowlist,this._options(now));')],
  ["A-1-allowlist-removed","A-1/A-4",text=>replace(text,'if(outsider(rec,state,allowlist)){','if(false){')],
  ["I-3-policy-reassigned","I-3",text=>replace(text,'  Object.assign(policy,expected);','  policy=options.engine.policy={...expected};')],
  ["I-1-check-removed","I-1",text=>replace(text,'    this.policy=assertPolicyIdentity(engine);','    this.policy=engine.policy;')],
  ["I-4-startup-rebuild-removed","I-4",text=>replace(text,'    this.rebuild();\n  }\n  _load(){','  }\n  _load(){')],
  ["P-6-self-removal-ignored","P-6",text=>replace(text,'  if(!me||me.status==="removed"){content.length=0;control.length=0}','')],
  ["P-8-freeze-keeps-pending-control","P-8",text=>replace(text,'(rec.frozen?rows:[...rows,...pending])','[...rows,...pending]')],
  ["A-1-key-not-checked","A-1 allowlist matches",text=>replace(text,'allowed.uuaid===row.uuaid&&allowed.key===row.key','allowed.uuaid===row.uuaid')],
  ["content-includes-invited","G1",text=>replace(text,'head.members.filter(row=>row.status==="active"&&!rec.leaving.includes(row.uuaid))','head.members.filter(row=>row.status!=="removed"&&!rec.leaving.includes(row.uuaid))')],
  ["tenantProfiles-dropped","G2",text=>replace(text,'tenantProfiles[ext.profile.id]=ext.tenant','void 0')],
  ["tenantId-dropped","G2",text=>replace(text,'for(const agent of Object.values(agents))agent.tenantId=ext.tenant;','')],
  ["reconsent-not-current-head","G3",text=>replace(text,'if(state.consent.manifestVersion!==head.version)throw','if(false)throw')],
  ["closed-hold-false","G4",text=>replace(text,'holdBeforeAdmission:true,agents:{}','holdBeforeAdmission:false,agents:{}')],
  ["expected-hold-false","G4",text=>replace(text,'holdBeforeAdmission:true,agents,','holdBeforeAdmission:false,agents,')],
  ["expected-channelsEnabled-false","G4",text=>replace(text,'channelsEnabled:true,holdBeforeAdmission:true,agents,','channelsEnabled:false,holdBeforeAdmission:true,agents,')],
  ["reconsent-signal-removed","G5",text=>replace(text,'this.onSignal({code:"SPACE_RECONSENT_REQUIRED",groupId:this.groupId,at:now})','void 0')],
  ["soft-restamp","G5",text=>replace(text,'if(state.softStop===null){','if(true){')],
  ["p12-id-only","G6",text=>replace(text,'!isDeepStrictEqual(previous.profile,current.profile)','previous.profile.id!==current.profile.id')],
  ["hardResume-ignores-pending","G7",text=>replace(text,'if(outsider(rec,state,this.allowlist))throw','if(outsider(rec,{...state,pendingRemovals:[]},this.allowlist))throw')],
  ["consent-version-throw-removed","G8",text=>replace(text,'if(!previous)throw','if(false)throw')],
  ["rebuild-selfcheck-removed","G10",text=>replace(text,'const head=verifiedHead(rec);selfCheck(this.self,rec);','const head=verifiedHead(rec);')],
  ["engine-identity-clause-dropped","G11",text=>replace(text,'policy===engine.policy&&policy===engine.trust.policy&&bound','policy===engine.trust.policy&&bound')],
  ["write-no-selfcheck","G13",text=>replace(text,'  checkPolicy(policy,rec,self,state,ext,allowlist,options);\n','')],
  ["reconsent-profile-not-recorded","G12",text=>replace(text,'state.profile=structuredClone(head.ext.commons.profile);','')],
  ["latched-write-no-close","G15 latched rebuild",text=>replace(text,'if(latched(state)){Object.assign(policy,closed(state.groupId));','if(latched(state)){')],
  ["C1-close-held-object-only","R1 C-1 trust",text=>replace(text,'new Set([policy,engine?.policy,engine?.trust?.policy])','new Set([policy])')],
  ["C2-skip-rebuild-on-adapter-failure","R1 C-2",text=>replace(text,'    }finally{this.rebuild()}','    }catch(error){throw error}\n    this.rebuild();')],
  ["C3-head-only-outsider-check","R1 C-3",text=>replace(text,'manifest.version>scanVersion','manifest.version>head.version')],
  ["C4-constructor-open-before-read","R1 C-4 constructor",text=>replace(text,'    Object.assign(this.policy,closed(this.groupId));\n','')],
  ["C4-rebuild-failure-stays-open","R1 C-4 missing roster closes on rebuild",text=>replace(text,'      try{closePolicies(this.policy,this.groupId,this.engine)}catch{} // retain the original read/write failure','      void 0;')],
  ["C4-check-failure-stays-open","R1 C-4 missing roster closes on check",text=>replace(text,'      try{closePolicies(this.policy,this.groupId,this.engine)}catch{}\n','')],
  ["C6-overwrite-first-stop","R1 C-6 a second mismatch",text=>replace(text,'if(state.hardStop===null)state.hardStop={reason,at:now};','state.hardStop={reason,at:now};')],
  ["C6-close-failure-skips-other-objects","R1 C-1/C-6",text=>replace(text,'      failure??=error;','      return {closed:false,error};')],
  ["C6-non-extensible-accepted","R1 C-6 I-1",text=>replace(text,'||!Object.isExtensible(policy)','')],
  ["C6-close-before-persist","R1 C-6 persistence",text=>replace(text,'  try{store.saveAdapter(state.groupId,state);persisted=true}catch(error){failure=error}\n  const outcome=closePolicies(policy,state.groupId,engine);failure??=outcome.error;','  const outcome=closePolicies(policy,state.groupId,engine);failure??=outcome.error;\n  if(!outcome.error)try{store.saveAdapter(state.groupId,state);persisted=true}catch(error){failure=error}')],
  ["C6-close-failure-skips-signal","R1 C-6 persistence",text=>replace(text,'  try{onSignal({code:"SPACE_CLOSED"','  if(outcome.error)throw outcome.error;\n  try{onSignal({code:"SPACE_CLOSED"')],
  ["M40-hard-resume-clears-soft","R1d-M40",text=>replace(text,'state.hardStop=null;this.store.saveAdapter','state.hardStop=null;state.softStop=null;this.store.saveAdapter')],
  ["M35b-latched-close-no-selfcheck","R1d-M35b",text=>replace(text,'if(latched(state)){Object.assign(policy,closed(state.groupId));checkPolicy(policy,rec,self,state,ext,allowlist,options);','if(latched(state)){Object.assign(policy,closed(state.groupId));')],
  ["R2-cursor-follows-consent","R2 cursor resume",text=>replace(text,'const scanVersion=scanned&&manifestHash(scanned)===state.outsiderScan.hash?scanned.version:0;','const scanVersion=state.consent.manifestVersion;')],
  ["R2-reconsent-moves-cursor","R1d-D1",text=>replace(text,'state.consent=structuredClone(consent);','state.outsiderScan={version:head.version,hash:manifestHash(head)};state.consent=structuredClone(consent);')],
  ["R2-hard-resume-jumps-cursor","R2 latched scan",text=>replace(text,'    if(!isDeepStrictEqual(state.outsiderScan,{version:head.version,hash:manifestHash(head)}))throw new PolicyError("OutsiderScanBehindError","Run rebuild first: outsider scan is behind the verified head");','    state.outsiderScan={version:head.version,hash:manifestHash(head)};')],
  ["R2-cursor-saved-before-latch","R2 cursor and outsider latch",text=>replace(text,'if(hit&&!latched(state))stop(this.policy,state,"outsider",this._options(now));','if(hit&&!latched(state)){this.store.saveAdapter(this.groupId,state);stop(this.policy,state,"outsider",this._options(now));}')],
  ["R2-scan-skipped-while-latched","R2 latched scan",text=>replace(text,'const hit=unseen.some(','const hit=!latched(state)&&unseen.some(')],
  ["R2-second-closing-signal","R2 latched scan",text=>replace(text,'code:"SPACE_OUTSIDER_SEEN"','code:"SPACE_CLOSED"')],
  ["R2-version-only-cursor","R2 matching cursor version",text=>replace(text,'scanned&&manifestHash(scanned)===state.outsiderScan.hash','scanned')],
  ["R2-persisted-always-true","R2 stop signal",text=>replace(text,'...state.hardStop,persisted,closed:outcome.closed','...state.hardStop,persisted:true,closed:outcome.closed')],
  ["R2-closed-always-true","R2 a blocked fallback",text=>replace(text,'closed:outcome.closed','closed:true')],
  ["R2-emergency-fallback-removed","R2 class trust",text=>replace(text,'          const replacement=closed(groupId);owner.policy=replacement;','          continue;')],
  ["R2-direct-write-no-close-on-throw","R2 direct writePolicy",text=>replace(text,'    closePolicies(policy,state.groupId,options.engine);','    void 0;')],
  ["R2-hard-resume-no-identity-check","R2 emergency replacement",text=>replace(text,'    requireSharedPolicy(this.policy,this.engine);','    void 0;')],
  ["R2-own-change-no-recovery-identity-check","R2 direct emergency closure",text=>replace(text,'    if(!isCanonicalTrust(this.engine.trust)||emergencyEngines.has(this.engine)||quarantinedEngines.has(this.engine))requireSharedPolicy(this.policy,this.engine);\n    const {rec,state,now}=this._load(),head=verifiedHead(rec);','    const {rec,state,now}=this._load(),head=verifiedHead(rec);')],
  ["R2-null-agent-not-guarded","R1d-D3",text=>replace(text,'keyBindsRow(uuaid,agent?.publicKey)','keyBindsRow(uuaid,agent.publicKey)')],
  ["R2-cursor-schema-unvalidated","R2 schema outsiderScan",text=>replace(text,'  if (!exactKeys(state.outsiderScan, OUTSIDER_SCAN_KEYS) || !posInt(state.outsiderScan.version) || !hex64(state.outsiderScan.hash)) throw badAdapter("outsiderScan: expected {version: positive safe integer, hash: 64-hex}");',''),"src/spaces/store.mjs"],
  ["R2-legacy-cursor-defaulted","R2 legacy adapter",text=>replace(text,'    validateAdapterState(parsed, id);','    parsed.outsiderScan??={version:parsed.consent.manifestVersion,hash:"a".repeat(64)};\n    validateAdapterState(parsed, id);'),"src/spaces/store.mjs"],
  ["R2c-rescan-from-consent",["R2c pole6 a:","R2c pole6 b:","R2c pole6 c:"],text=>replace(text,'scanned.version:0;','scanned.version:state.consent.manifestVersion;')],
  ["R2c-rescan-from-min",["R2c pole6 b:","R2c pole6 c:"],text=>replace(text,'scanned.version:0;','scanned.version:Math.min(state.outsiderScan.version,state.consent.manifestVersion);')],
  ["R2c-p12-whole-chain",["R2c pole6 d profile:","R2c pole6 d tenant:"],text=>replace(text,'const after=rec.chain.filter(manifest=>manifest.version>state.consent.manifestVersion);','const after=rec.chain;')],
  ["R2c-version-only",["R2c pole6 b:","R2c pole6 c:"],text=>replace(text,'scanned&&manifestHash(scanned)===state.outsiderScan.hash','scanned')],
];
mutations.push(
  ["S7-private-denial-consumption",["S7 T1 entry","S7 T3 captured"],text=>text.replaceAll("if(this.#denied)","if(false)"),"src/trust.mjs"],
  ["S7-local-final-fence","S7 T5 local",text=>replace(text,'      if(this.#denied)throw new TrustError("NOT_ADMITTED","Trust receiver has been permanently denied");',''),"src/trust.mjs"],
  ["S7-global-final-fence",["S7 T4 global","S7 global result"],text=>replace(text,'    const result={tier:"registry-credential-and-policy",uuaid,capability,credentialId:binding.credentialId,certified:false};\n    if(this.#denied)throw new TrustError("NOT_ADMITTED","Trust receiver has been permanently denied");','    const result={tier:"registry-credential-and-policy",uuaid,capability,credentialId:binding.credentialId,certified:false};'),"src/trust.mjs"],
  ["S7-T2-T6-no-consumer-denial",["S7 T2 T6 frozen actual trust slot persisted true","S7 T2 T6 frozen actual trust slot persisted false","S7 P1 healthy local denial","S7 P1 healthy global denial"],text=>replace(text,'    reflectApply(denyTrust,engine.trust,[]);','')],
  ["S7-T7-T12-no-quarantine-refusal","S7 T7 T12 restored",text=>replace(text,'quarantinedEngines.has(engine)||!isCanonicalTrust','!isCanonicalTrust')],
  ["S7-T8-roster-outside-guard","S7 T8 whole roster",text=>replace(text,'    try{\n    result=signAndApplyNext(this.store,this.groupId,this.self,action,buildOpts);','    result=signAndApplyNext(this.store,this.groupId,this.self,action,buildOpts);\n    try{')],
  ["S7-T10-blind-cursor-resume","S7 T10 fresh",text=>replace(text,'if(!isDeepStrictEqual(state.outsiderScan,{version:head.version,hash:manifestHash(head)}))throw new PolicyError','if(false)throw new PolicyError')],
  ["S7-T11-no-fresh-reconciliation","S7 T11 fresh failed-save recovery A-clean",text=>replace(text,'new SpacePolicy({...f.options,engine,store:fresh});','const rebuild=SpacePolicy.prototype.rebuild;try{SpacePolicy.prototype.rebuild=function(){return this.policy};new SpacePolicy({...f.options,engine,store:fresh})}finally{SpacePolicy.prototype.rebuild=rebuild}'),"test/spaces-policy.test.mjs"],
  ["S7-T11-unacknowledged-history-skipped","S7 T11 fresh failed-save recovery B-unacknowledged-history",text=>replace(text,'const hit=unseen.some(manifest=>outsideAllowlist(manifest.members.filter(row=>row.status!=="removed"),this.allowlist));','const hit=false;')],
  ["S7-M1-brand-removed","S7 T9 brand refuses",text=>replace(text,'||!(#denied in value)',''),"src/trust.mjs"],
  ["S7-M2-descriptor-route-removed","S7 T9 own shadow",text=>replace(text,'if(!("value" in descriptor)||descriptor.value!==CANONICAL_AUTHORIZE)return false;','if(false)return false;'),"src/trust.mjs"],
  ["S7-M3-accessor-accepted","S7 T9 own getter",text=>replace(text,'if(!("value" in descriptor)||descriptor.value!==CANONICAL_AUTHORIZE)return false;','if("value" in descriptor&&descriptor.value!==CANONICAL_AUTHORIZE)return false;'),"src/trust.mjs"],
  ["S7-M4-own-descriptor-skipped",["S7 T9 own getter","S7 T9 own shadow"],text=>replace(text,'const descriptor=getOwnPropertyDescriptor(current,"authorize");','const descriptor=current===value?undefined:getOwnPropertyDescriptor(current,"authorize");'),"src/trust.mjs"],
  ["S7-M5-membership-removed",["S7 T9 ordinary Sub admission","S7 T9 ordinary Sub is refused","S7 T9 Proxy-node data observer"],text=>replace(text,'if(current!==value&&current!==TRUST_PROTOTYPE&&current!==OBJECT_PROTOTYPE)return false;','if(false)return false;'),"src/trust.mjs"],
  ["S7-M6-live-anchor",["S7 T9 captured anchor rejects","S7 T9 captured anchor never invokes"],text=>replace(text,'descriptor.value!==CANONICAL_AUTHORIZE','descriptor.value!==RegistryTrust.prototype.authorize'),"src/trust.mjs"],
);
mutations.push(
  ["S7-P7-live-call","S7 P7 own no-op call",text=>replace(text,'    reflectApply(denyTrust,engine.trust,[]);','    denyTrust.call(engine.trust);')],
  ["S7-P6-live-object-intrinsics","S7 P6 canonical trust",text=>replace(replace(text,'const descriptor=getOwnPropertyDescriptor(current,"authorize");','const descriptor=Object.getOwnPropertyDescriptor(current,"authorize");'),'current=getPrototypeOf(current);','current=Object.getPrototypeOf(current);'),"src/trust.mjs"],
  ["S7-P3-live-call",["S7 P3 throwing own call","S7 P3 getter own call"],text=>replace(text,'    reflectApply(denyTrust,engine.trust,[]);','    denyTrust.call(engine.trust);')],
  ["S7-P5-live-reflect-apply","S7 P5 post-load Reflect.apply",text=>replace(text,'    reflectApply(denyTrust,engine.trust,[]);','    Reflect.apply(denyTrust,engine.trust,[]);')],
  ["S7-P4-live-call","S7 P4 Function.prototype.call",text=>replace(text,'    reflectApply(denyTrust,engine.trust,[]);','    denyTrust.call(engine.trust);')],
);
// Named equivalent/unobservable changes are observations, not distinguishing poles.
const equivalents=[
  ["N4-P9-binding-unchecked",text=>replace(text,'&&bound&&POLICY_FIELDS','&&true&&POLICY_FIELDS')],
  ["M35c-outsider-close-no-selfcheck",text=>replace(text,'if(outsider(rec,state,allowlist)){stop(policy,state,"outsider",options);checkPolicy(policy,rec,self,state,ext,allowlist,options);','if(outsider(rec,state,allowlist)){stop(policy,state,"outsider",options);')],
];
let expectedTests;
function run(name,target,mutate,file="src/spaces/policy.mjs"){
  const root=join(scratch,name);mkdirSync(root);cpSync(join(source,"src"),join(root,"src"),{recursive:true});mkdirSync(join(root,"test"));
  cpSync(join(source,"test/spaces-policy.test.mjs"),join(root,"test/spaces-policy.test.mjs"));cpSync(join(source,"test/spaces-store.test.mjs"),join(root,"test/spaces-store.test.mjs"));cpSync(join(source,"test/security-runtime.test.mjs"),join(root,"test/security-runtime.test.mjs"));cpSync(join(source,"package.json"),join(root,"package.json"));symlinkSync(join(source,"node_modules"),join(root,"node_modules"));
  if(mutate){const path=join(root,file);writeFileSync(path,mutate(readFileSync(path,"utf8")))}
  const result=spawnSync(process.execPath,["--test","--test-reporter=tap","test/spaces-policy.test.mjs","test/spaces-store.test.mjs","test/security-runtime.test.mjs"],{cwd:root,encoding:"utf8",timeout:30000});
  const count=label=>Number(result.stdout.match(new RegExp(`# ${label} (\\d+)`))?.[1]??0),log=join(root,"result.log");writeFileSync(log,result.stdout+result.stderr);
  if(name==="CONTROL")expectedTests=count("tests");
  if(result.signal||result.error||expectedTests<117||count("tests")!==expectedTests||count("cancelled")!==0)throw new Error(`Pole did not complete: ${name}; ${log}`);
  const failures=[...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  const targets=Array.isArray(target)?target:[target];
  return {name,target,rc:result.status,tests:count("tests"),pass:count("pass"),fail:count("fail"),failures,intendedFailureObserved:target?targets.every(prefix=>failures.some(f=>f.startsWith(prefix))):null,log};
}
const control=run("CONTROL"),mutants=mutations.map(([name,target,mutate,file])=>run(name,target,mutate,file));
const equivalentObservations=equivalents.map(([name,mutate])=>({...run(name,null,mutate),classification:"equivalent or unobservable; not a distinguishing pole"}));
const report={scratch,control,mutants,equivalentObservations};writeFileSync(join(scratch,"poles.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
process.exitCode=control.rc===0&&mutants.every(m=>m.rc===1&&m.fail>0&&m.intendedFailureObserved)&&equivalentObservations.every(m=>m.rc===0)?0:1;
