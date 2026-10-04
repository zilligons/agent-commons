import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCohort, cohortStatus, FOUNDING_ROSTER } from "../src/cohort.mjs";

test("Seven nodes persist distinct identity and scoped policy without remote enrollment",()=>{
  const root=mkdtempSync(join(tmpdir(),"commons-cohort-")),home=join(root,"nodes");
  try{
    const manifest=initializeCohort({home,target:"zilligon.com"});
    assert.equal(manifest.members.length,7);
    assert.equal(new Set(manifest.members.map(m=>m.uuaid)).size,7);
    assert.equal(manifest.registration,"not-performed");
    assert.equal(manifest.certified,false);
    const next=cohortStatus(home);
    assert.deepEqual(next.members.map(m=>m.uuaid),manifest.members.map(m=>m.uuaid));
    assert(next.members.every(m=>m.status.auditVerified));
    const config=JSON.parse(readFileSync(join(home,"security","config.json"),"utf8"));
    assert.equal(Object.keys(config.policy.agents).length,7);
    const security=manifest.members.find(m=>m.id==="security");
    assert(!config.policy.agents[security.uuaid].capabilities.includes("commons:evolve"));
    assert(Object.values(config.policy.agents).every(a=>!a.capabilities.includes("commons:recover")));
    assert.throws(()=>initializeCohort({home}),/not overwritten/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test("Cohort manifest cannot redirect identity loading to arbitrary paths",()=>{
  const root=mkdtempSync(join(tmpdir(),"commons-cohort-")),home=join(root,"nodes");
  try{
    const m=initializeCohort({home});
    m.members[0].home=root;
    writeFileSync(join(home,"cohort.json"),JSON.stringify(m));
    assert.throws(()=>cohortStatus(home),/Unsafe/);
    assert.equal(FOUNDING_ROSTER.length,7);
  }finally{rmSync(root,{recursive:true,force:true})}
});
