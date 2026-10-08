import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
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
  // R4 (rework 4, item X2, the security reviewer third look): the every() check is now
  // SLOT-AWARE. The R3 zero-dispatch gate throws MODEL_UNAVAILABLE for
  // the blocked slots (sustainability, integration) BEFORE the stubbed
  // c.call is reached, while the non-blocked slots still surface
  // ACCESS_DENIED from the stubbed call. Every diagnostic must be
  // non-retryable and unavailable; the code carries either ACCESS_DENIED
  // (non-blocked) or MODEL_UNAVAILABLE (blocked). The probe counted 7
  // for 7 slots because the gate runs ahead of dispatch.
  const SLOTS_BLOCKED = new Set(["sustainability", "integration"]);
  for (const [id, d] of Object.entries(c.state.adapterDiagnostics!)) {
    assert.equal(d.available, false, `${id} must be unavailable`);
    assert.equal(d.retryable, false, `${id} must be non-retryable`);
    if (SLOTS_BLOCKED.has(id)) {
      assert.equal(d.code, "MODEL_UNAVAILABLE", `${id} (blocked) must be MODEL_UNAVAILABLE from the R3 gate`);
    } else {
      assert.equal(d.code, "ACCESS_DENIED", `${id} (non-blocked) must be ACCESS_DENIED from the stubbed call`);
    }
  }

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
  // C4 (L12): storage returning weak key PEM-wrapped is refused, non-Ed25519 PEM returns false without throw
  const { storage } = await import("./storage");
  const originalKey = storage.key.bind(storage);
  const originalExistingKey = storage.existingPublicKey.bind(storage);

  // 1. Non-Ed25519 PEM returns false without a throw
  const nonEd25519Pem = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0\n-----END PUBLIC KEY-----\n";
  storage.existingPublicKey = (_id: string) => nonEd25519Pem;
  storage.key = (_id: string) => ({
    privateKey: "fake",
    publicKey: nonEd25519Pem,
  });
  assert.equal(c.verify(), false, "Non-Ed25519 PEM must return false without throw");

  // 2. Weak key (identity point) PEM-wrapped as 12-byte SPKI prefix + 32-byte IDENTITY is refused for honest signatures
  const IDENTITY = "01" + "00".repeat(31);
  const spkiDer = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(IDENTITY, "hex")]);
  const weakPem = `-----BEGIN PUBLIC KEY-----\n${spkiDer.toString("base64")}\n-----END PUBLIC KEY-----\n`;
  storage.existingPublicKey = (_id: string) => weakPem;
  storage.key = (_id: string) => ({
    privateKey: "fake",
    publicKey: weakPem,
  });
  assert.equal(c.verify(), false, "PEM-wrapped weak key must be refused by verify() for honest signatures");

  // Restore honest storage
  storage.existingPublicKey = originalExistingKey;
  storage.key = originalKey;
  assert.equal(c.verify(), true, "Honest keys must verify");

  // 3. (L13 Item E / E-1): Weak-key pole reaching strict check with honest control arm
  const realPair = generateKeyPairSync("ed25519");
  const realSpkiPem = realPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const weakPayload = {
    id: "weak-key-forged-entry",
    agent: "weak-key-test-agent",
    stage: "needs",
    body: "forged-under-weak-key",
    time: new Date().toISOString(),
    previous: c.state.entries.at(-1)?.hash ?? "genesis",
    execution: "forged",
    model: "test",
  };
  const weakHash = createHash("sha256").update(JSON.stringify(weakPayload)).digest("hex");
  const realSig = sign(null, Buffer.from(weakHash, "hex"), realPair.privateKey).toString("base64");
  const forgedSig = Buffer.from("01" + "00".repeat(63), "hex").toString("base64");

  // Arm 1 (E-1): Entry with honest signature and real key verifies through existingPublicKey
  let currentTestPem: string = realSpkiPem;
  c.state.entries.push({ ...weakPayload, hash: weakHash, signature: realSig });
  storage.existingPublicKey = (id: string) => {
    if (id === "cohort:weak-key-test-agent") {
      return currentTestPem;
    }
    return originalExistingKey(id);
  };
  storage.key = (id: string) => {
    if (id === "cohort:weak-key-test-agent") {
      return { privateKey: "fake", publicKey: currentTestPem };
    }
    return originalKey(id);
  };
  assert.equal(c.verify(), true, "Entry with honest signature must verify through existingPublicKey");

  // Arm 2 (E-1): Swap ONLY key to identity point and signature to R=identity, S=0 forgery; strict verify must refuse
  currentTestPem = weakPem;
  c.state.entries.at(-1)!.signature = forgedSig;
  assert.equal(c.verify(), false, "Entry forged under weak key (identity point) must be refused by verify()");

  // Arm 3: Cleanup and verify honest cohort remains valid
  c.state.entries.pop();
  storage.existingPublicKey = originalExistingKey;
  storage.key = originalKey;
  assert.equal(c.verify(), true, "Honest keys must verify");

  // C-1 (L12 rework 1): verify() must never write. Unknown agent with wrong hash must not insert into agent_keys
  const { db } = await import("./storage");
  const { agentKeys } = await import("../shared/schema");
  const keyRowsBefore = db.select().from(agentKeys).all().length;
  c.state.entries.push({
    id: "tampered-unknown-entry",
    agent: "unknown-malicious-agent-123",
    stage: "needs",
    body: "tampered",
    time: new Date().toISOString(),
    previous: c.state.entries.at(-1)?.hash ?? "genesis",
    hash: "00".repeat(32),
    signature: "00".repeat(64),
    execution: "tampered",
    model: "fake",
  });
  assert.equal(c.verify(), false, "Entry with wrong hash must fail verify()");
  const keyRowsAfter = db.select().from(agentKeys).all().length;
  assert.equal(keyRowsAfter, keyRowsBefore, "verify() must not write key rows for tampered entries");
  c.state.entries.pop();
  assert.equal(c.verify(), true, "Honest cohort state must verify after cleanup");

  // D-1 (L13 Item D): Self-consistent entry for unknown agent must fail verify() and leave agent_keys unchanged
  const unadmittedPair = generateKeyPairSync("ed25519");
  const unadmittedPayload = {
    id: "unadmitted-consistent-entry",
    agent: "unadmitted-unknown-agent",
    stage: "needs",
    body: "self-consistent-payload",
    time: new Date().toISOString(),
    previous: c.state.entries.at(-1)?.hash ?? "genesis",
    execution: "test",
    model: "test",
  };
  const unadmittedHash = createHash("sha256").update(JSON.stringify(unadmittedPayload)).digest("hex");
  const unadmittedSig = sign(null, Buffer.from(unadmittedHash, "hex"), unadmittedPair.privateKey).toString("base64");
  c.state.entries.push({ ...unadmittedPayload, hash: unadmittedHash, signature: unadmittedSig });

  const unadmittedRowsBefore = db.select().from(agentKeys).all().length;
  assert.equal(c.verify(), false, "Self-consistent entry for unknown agent must fail verify()");
  const unadmittedRowsAfter = db.select().from(agentKeys).all().length;
  assert.equal(unadmittedRowsAfter, unadmittedRowsBefore, "verify() must not create key rows for unknown agents");

  c.state.entries.pop();
  assert.equal(c.verify(), true, "Honest cohort state must verify after cleanup");

  // C-2 (L12 rework 1): Ed25519 key wrapped in X25519-OID SPKI must return false (seeing the SPKI prefix check)
  const testPair = generateKeyPairSync("ed25519");
  const honestSpki = testPair.publicKey.export({ type: "spki", format: "der" });
  const rawPub32 = honestSpki.subarray(12);
  const x25519Prefix = Buffer.from("302a300506032b656e032100", "hex");
  const x25519SpkiDer = Buffer.concat([x25519Prefix, rawPub32]);
  const x25519Pem = `-----BEGIN PUBLIC KEY-----\n${x25519SpkiDer.toString("base64")}\n-----END PUBLIC KEY-----\n`;

  const x25519Payload = {
    id: "x25519-prefix-test-entry",
    agent: "x25519-test-agent",
    stage: "needs",
    body: "x25519-oid-test",
    time: new Date().toISOString(),
    previous: c.state.entries.at(-1)?.hash ?? "genesis",
    execution: "test",
    model: "test",
  };
  const x25519Hash = createHash("sha256").update(JSON.stringify(x25519Payload)).digest("hex");
  const x25519Sig = sign(null, Buffer.from(x25519Hash, "hex"), testPair.privateKey).toString("base64");

  c.state.entries.push({ ...x25519Payload, hash: x25519Hash, signature: x25519Sig });
  storage.existingPublicKey = (id: string) => {
    if (id === "cohort:x25519-test-agent") {
      return x25519Pem;
    }
    return originalExistingKey(id);
  };
  storage.key = (id: string) => {
    if (id === "cohort:x25519-test-agent") {
      return { privateKey: "fake", publicKey: x25519Pem };
    }
    return originalKey(id);
  };
  assert.equal(c.verify(), false, "Ed25519 key wrapped in X25519-OID SPKI must return false from verify()");
  c.state.entries.pop();
  storage.existingPublicKey = originalExistingKey;
  storage.key = originalKey;
  assert.equal(c.verify(), true, "Honest cohort state must verify after cleanup");

  // Item F (L13 rev 5): Pin chain-and-hash checks against mutant C4 (tampered body or previous)
  const lastEntry = c.state.entries.at(-1)!;
  assert.ok(lastEntry, "Honest cohort must have at least one entry");

  // Arm 1 (Honest baseline): Honest cohort state verifies before tampering
  assert.equal(c.verify(), true, "Honest cohort state verifies before tampering");

  // Arm 2 (Tampered body): Change only body, keeping hash and signature untouched
  const honestBody = lastEntry.body;
  lastEntry.body = "tampered-body";
  assert.equal(c.verify(), false, "Entry with tampered body must fail verify()");
  lastEntry.body = honestBody;
  assert.equal(c.verify(), true, "Honest cohort state verifies after body restored");

  // Arm 3 (Link tampered): Change only previous, keeping hash and signature untouched
  const honestPrevious = lastEntry.previous;
  const honestHash = lastEntry.hash;
  const honestSig = lastEntry.signature;
  lastEntry.previous = "00".repeat(32);
  assert.equal(c.verify(), false, "Entry with tampered previous must fail verify()");
  lastEntry.previous = honestPrevious;
  assert.equal(c.verify(), true, "Honest cohort state verifies after previous restored");

  // Arm 3b (Link tampered with valid signature): Pins previous===previous check against chain fork
  const { hash: _h, signature: _s, ...tamperedLinkPayload } = { ...lastEntry, previous: "00".repeat(32) };
  const forgedLinkHash = createHash("sha256").update(JSON.stringify(tamperedLinkPayload)).digest("hex");
  const forgedLinkSig = sign(null, Buffer.from(forgedLinkHash, "hex"), storage.key(`cohort:${lastEntry.agent}`).privateKey).toString("base64");
  lastEntry.previous = "00".repeat(32);
  lastEntry.hash = forgedLinkHash;
  lastEntry.signature = forgedLinkSig;
  assert.equal(c.verify(), false, "Entry with valid signature but broken link must fail verify()");
  lastEntry.previous = honestPrevious;
  lastEntry.hash = honestHash;
  lastEntry.signature = honestSig;
  assert.equal(c.verify(), true, "Honest cohort state verifies after link restored");

  console.log("PASS: denied-model skip, persistent attempt accounting, safe probes, retained continuity, cancellation fencing, concurrency guards, R3 zero-dispatch gate (slot-aware diagnostics), C4 strict-Ed25519 verification, C-1 verify read-only gate, C-2 SPKI prefix check, Item E weak-key strictness pole, Item D existingPublicKey read-only gate, Item F chain-and-hash integrity poles.");
}finally{
  process.chdir(original);
  rmSync(temporary,{recursive:true,force:true});
}
