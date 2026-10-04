import assert from "node:assert/strict";
import { NetworkConsole } from "./network";
import { verifyDocument } from "../packages/agent-commons/src/profiles.mjs";
import { storage } from "./storage";
const saved=storage.loadNetwork();
try{
  const consoleState=new NetworkConsole();
  assert.ok(consoleState.state.profiles.length>=3);
  const namespace=`local/verification-${Date.now()}`;
  const profile=consoleState.create({name:"Verification fixture",namespace,fixtures:["Require a signed delivery receipt.","A signed delivery receipt preserves the task identity."]});
  assert.equal(profile.benchmark.passed,profile.benchmark.tests);
  assert.throws(()=>consoleState.create({name:"Invalid global",namespace:"global/not-authorized",fixtures:["a","b"]}),/not global standards/);
  assert.throws(()=>consoleState.create({name:"Single fixture",namespace:"local/one",fixtures:["one"]}),/2–100/);
  const candidate=consoleState.prepare(profile.id);
  assert.equal(verifyDocument(candidate.document).kind,"profile-contribution");
  assert.equal(candidate.document.payload.contribution.profile,undefined);
  assert.equal(candidate.ratified,false);
  assert.equal(candidate.stage,"prepared-no-egress");
  assert.equal(new NetworkConsole().state.profiles.some(p=>p.id===profile.id),true);
  console.log("PASS: profile persistence, fixture gate, global-scope rejection, real UUAID-key-bound signature, no raw-fixture disclosure, no egress or ratification claim.");
}finally{if(saved)storage.saveNetwork(saved)}
