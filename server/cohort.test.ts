import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Import the storage singleton only after switching to an isolated fixture home.
// Never mutate the real preview's identities, continuity, budgets or database.
const root=fileURLToPath(new URL("..",import.meta.url));
const temporary=mkdtempSync(join(tmpdir(),"commons-adapter-tests-"));
const original=process.cwd();
symlinkSync(join(root,"packages"),join(temporary,"packages"),"dir");
process.chdir(temporary);
try{
  const {CohortConsole}=await import("./cohort");
  const c=new CohortConsole();
  assert.equal(c.summary().verified,true);
  const denied=["governance","release","integration","sustainability"];
  for(const id of denied)c.recordAdapter(id,"fixture-model",Object.assign(new Error("Fixture access denied"),{code:"ACCESS_DENIED",transportStatus:"PERMISSION_DENIED",retryable:false}));
  const called:string[]=[];
  c.call=async(model:string)=>{called.push(model);return JSON.stringify({body:"Deterministic test fixture, not a provider response"})};
  c.state.running=true;c.state.limit=7;
  await c.run(c.generation);
  assert.equal(called.length,3,"Fresh known denials must not bill repeated provider attempts");
  assert.equal(c.state.budget!.attempts,3);
  assert.equal(c.state.entries.length,3);
  assert.equal(c.state.round,7);
  assert.equal(c.summary().verified,true);
  for(const id of denied)assert.equal(c.state.statuses[id],"adapter blocked");

  const retained=c.state.entries.length;
  const budgetBefore=c.state.budget!.attempts;
  c.state.probing=true;c.state.probeProgress=0;
  c.call=async()=>{throw Object.assign(new Error("Fixture access denied"),{code:"ACCESS_DENIED",transportStatus:"PERMISSION_DENIED",retryable:false})};
  await c.probe(c.generation);
  assert.equal(c.state.probing,false);
  assert.equal(c.state.probeProgress,7);
  assert.equal(c.state.budget!.attempts-budgetBefore,7);
  assert.equal(c.state.entries.length,retained,"Probes must not become synthetic conversation turns");
  assert.equal(Object.keys(c.state.adapterDiagnostics!).length,7);
  assert(Object.values(c.state.adapterDiagnostics!).every(d=>d.code==="ACCESS_DENIED"&&!d.available&&!d.retryable));

  c.state.probing=true;c.state.probeProgress=0;
  const observed=c.state.adapterDiagnostics!.continuity.checkedAt;
  c.call=async()=>{c.pause();return "cancelled fixture result"};
  await c.probe(c.generation);
  assert.equal(c.state.probing,false);
  assert.equal(c.state.busy,null);
  assert.equal(c.state.adapterDiagnostics!.continuity.checkedAt,observed,"Cancelled results must not overwrite verified observations");

  c.state.running=true;
  assert.throws(()=>c.startProbe(),/already running/);
  c.state.running=false;c.state.probing=true;
  assert.throws(()=>c.start(7),/already running/);
  assert.throws(()=>c.importReports(),/Pause/);
  c.pause();
  assert.equal(c.summary().verified,true);
  console.log("PASS: denied-model skip, persistent attempt accounting, safe probes, retained continuity, cancellation fencing and concurrency guards.");
}finally{
  process.chdir(original);
  rmSync(temporary,{recursive:true,force:true});
}
