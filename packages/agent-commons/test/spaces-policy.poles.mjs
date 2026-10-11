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
    return replace(text,roster+adapter,adapter+roster);
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
];
function run(name,target,mutate){
  const root=join(scratch,name);mkdirSync(root);cpSync(join(source,"src"),join(root,"src"),{recursive:true});mkdirSync(join(root,"test"));
  cpSync(join(source,"test/spaces-policy.test.mjs"),join(root,"test/spaces-policy.test.mjs"));cpSync(join(source,"package.json"),join(root,"package.json"));symlinkSync(join(source,"node_modules"),join(root,"node_modules"));
  if(mutate){const path=join(root,"src/spaces/policy.mjs");writeFileSync(path,mutate(readFileSync(path,"utf8")))}
  const result=spawnSync(process.execPath,["--test","test/spaces-policy.test.mjs"],{cwd:root,encoding:"utf8",timeout:30000});
  const count=label=>Number(result.stdout.match(new RegExp(`# ${label} (\\d+)`))?.[1]??0),log=join(root,"result.log");writeFileSync(log,result.stdout+result.stderr);
  if(result.signal||result.error||count("tests")!==29||count("cancelled")!==0)throw new Error(`Pole did not complete: ${name}; ${log}`);
  const failures=[...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  return {name,target,rc:result.status,tests:count("tests"),pass:count("pass"),fail:count("fail"),failures,intendedFailureObserved:target?failures.some(f=>f.startsWith(target)):null,log};
}
const control=run("CONTROL"),mutants=mutations.map(([name,target,mutate])=>run(name,target,mutate));
const report={scratch,control,mutants};writeFileSync(join(scratch,"poles.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
process.exitCode=control.rc===0&&mutants.every(m=>m.rc===1&&m.fail>0&&m.intendedFailureObserved)?0:1;
