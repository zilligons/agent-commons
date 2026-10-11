import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const source=fileURLToPath(new URL("../",import.meta.url)),scratch=mkdtempSync("/tmp/spaces-policy-poles-");
const replace=(text,before,after)=>{if(text.split(before).length!==2)throw new Error(`Mutation target must be unique: ${before}`);return text.replace(before,after)};
const mutations=[
  ["P-2-extra-capability","P-2",text=>replace(text,'  const tenantProfiles={};','  Object.values(agents)[0].capabilities.push("commons:evolve");\n  const tenantProfiles={};')],
  ["P-5-leaver-retained","P-5",text=>replace(text,'row.status==="active"&&!rec.leaving.includes(row.uuaid)','row.status==="active"')],
  ["P-7-pending-step-removed","P-7 own",text=>replace(text,'    if(nextState!==state)this.store.saveAdapter(this.groupId,nextState);','')],
  ["C20-adapter-first","C20 roster-first crash",text=>{
    const roster='    const result=signAndApplyNext(this.store,this.groupId,this.self,action,buildOpts);\n',adapter='    if(nextState!==state)this.store.saveAdapter(this.groupId,nextState);\n';
    return replace(replace(text,roster,'    let result;\n'),adapter,adapter+'    result=signAndApplyNext(this.store,this.groupId,this.self,action,buildOpts);\n');
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
  ["C3-head-only-outsider-check","R1 C-3",text=>replace(text,'      if(!latched(state)&&outsideAllowlist(manifest.members.filter(row=>row.status!=="removed"),this.allowlist))stop(this.policy,state,"outsider",this._options(now));\n','')],
  ["C4-constructor-open-before-read","R1 C-4 constructor",text=>replace(text,'    Object.assign(this.policy,closed(this.groupId));\n','')],
  ["C4-rebuild-failure-stays-open","R1 C-4 missing roster closes on rebuild",text=>replace(text,'      try{closePolicies(this.policy,this.groupId,this.engine)}catch{} // retain the original read/write failure','      void 0;')],
  ["C4-check-failure-stays-open","R1 C-4 missing roster closes on check",text=>replace(text,'      try{closePolicies(this.policy,this.groupId,this.engine)}catch{}\n','')],
  ["C6-overwrite-first-stop","R1 C-6 a second mismatch",text=>replace(text,'if(state.hardStop===null)state.hardStop={reason,at:now};','state.hardStop={reason,at:now};')],
  ["C6-close-failure-skips-other-objects","R1 C-1/C-6",text=>replace(text,'catch(error){failure??=error}','catch(error){throw error}')],
  ["C6-non-extensible-accepted","R1 C-6 I-1",text=>replace(text,'||!Object.isExtensible(policy)','')],
  ["C6-close-before-persist","R1 C-6 persistence",text=>replace(text,'  try{store.saveAdapter(state.groupId,state)}finally{\n    try{closePolicies(policy,state.groupId,engine)}finally{\n      onSignal({code:"SPACE_CLOSED",groupId:state.groupId,...state.hardStop});\n    }\n  }','  try{closePolicies(policy,state.groupId,engine);store.saveAdapter(state.groupId,state)}finally{\n    onSignal({code:"SPACE_CLOSED",groupId:state.groupId,...state.hardStop});\n  }')],
  ["C6-close-failure-skips-signal","R1 C-6 persistence",text=>replace(text,'    try{closePolicies(policy,state.groupId,engine)}finally{\n      onSignal({code:"SPACE_CLOSED",groupId:state.groupId,...state.hardStop});\n    }','    closePolicies(policy,state.groupId,engine);\n    onSignal({code:"SPACE_CLOSED",groupId:state.groupId,...state.hardStop});')],
];
// Named equivalent/unobservable changes are observations, not distinguishing poles.
const equivalents=[
  ["N4-P9-binding-unchecked",text=>replace(text,'&&bound&&POLICY_FIELDS','&&true&&POLICY_FIELDS')],
  ["M40-hard-resume-clears-soft",text=>replace(text,'state.hardStop=null;this.store.saveAdapter','state.hardStop=null;state.softStop=null;this.store.saveAdapter')],
  ["M35b-latched-close-no-selfcheck",text=>replace(text,'if(latched(state)){Object.assign(policy,closed(state.groupId));checkPolicy(policy,rec,self,state,ext,allowlist,options);','if(latched(state)){Object.assign(policy,closed(state.groupId));')],
  ["M35c-outsider-close-no-selfcheck",text=>replace(text,'if(outsider(rec,state,allowlist)){stop(policy,state,"outsider",options);checkPolicy(policy,rec,self,state,ext,allowlist,options);','if(outsider(rec,state,allowlist)){stop(policy,state,"outsider",options);')],
];
function run(name,target,mutate){
  const root=join(scratch,name);mkdirSync(root);cpSync(join(source,"src"),join(root,"src"),{recursive:true});mkdirSync(join(root,"test"));
  cpSync(join(source,"test/spaces-policy.test.mjs"),join(root,"test/spaces-policy.test.mjs"));cpSync(join(source,"package.json"),join(root,"package.json"));symlinkSync(join(source,"node_modules"),join(root,"node_modules"));
  if(mutate){const path=join(root,"src/spaces/policy.mjs");writeFileSync(path,mutate(readFileSync(path,"utf8")))}
  const result=spawnSync(process.execPath,["--test","test/spaces-policy.test.mjs"],{cwd:root,encoding:"utf8",timeout:30000});
  const count=label=>Number(result.stdout.match(new RegExp(`# ${label} (\\d+)`))?.[1]??0),log=join(root,"result.log");writeFileSync(log,result.stdout+result.stderr);
  if(result.signal||result.error||count("tests")!==59||count("cancelled")!==0)throw new Error(`Pole did not complete: ${name}; ${log}`);
  const failures=[...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  return {name,target,rc:result.status,tests:count("tests"),pass:count("pass"),fail:count("fail"),failures,intendedFailureObserved:target?failures.some(f=>f.startsWith(target)):null,log};
}
const control=run("CONTROL"),mutants=mutations.map(([name,target,mutate])=>run(name,target,mutate));
const equivalentObservations=equivalents.map(([name,mutate])=>({...run(name,null,mutate),classification:"equivalent or unobservable; not a distinguishing pole"}));
const report={scratch,control,mutants,equivalentObservations};writeFileSync(join(scratch,"poles.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
process.exitCode=control.rc===0&&mutants.every(m=>m.rc===1&&m.fail>0&&m.intendedFailureObserved)&&equivalentObservations.every(m=>m.rc===0)?0:1;
