// Key continuity as a shipped object: an old key vouches for a new key, the new
// key accepts, and a receiver verifies both offline before extending a grant.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keychain, jcs } from "../src/pillar.mjs";
import { CommonsStore } from "../src/store.mjs";
import { RegistryTrust } from "../src/trust.mjs";
import { initialize, saveConfig } from "../src/config.mjs";
import {
  KEY_CONTINUITY_V, KeyContinuityError, admitByContinuity, createKeyContinuity,
  keyContinuityDigest, keyContinuityPreimage, verifyKeyContinuity,
} from "../src/key-continuity.mjs";

function keychain(uuaidNamespace = "foundation") { const k = new Keychain("unused"); k._identity = Keychain.generate({ uuaidNamespace }); return k; }
const spelling = (namespace, publicKeyHex) => `uuaid:${namespace}:agent:${Keychain.localIdFromKey(Buffer.from(publicKeyHex, "hex"))}`;
const party = k => ({ uuaid: k._identity.uuaid, publicKey: k._identity.publicKeyHex });
const bodyOf = ({ oldSignature, newSignature, ...body }) => body;
const clone = value => JSON.parse(JSON.stringify(value));
function sign(body, oldK, newK) {
  const preimage = keyContinuityPreimage(body);
  return { ...body, oldSignature: oldK.sign(preimage).toString("hex"), newSignature: newK.sign(preimage).toString("hex") };
}
function refuses(fn, code) {
  assert.throws(fn, error => { assert.ok(error instanceof KeyContinuityError, error.message); assert.equal(error.code, code, error.message); return true; });
}

test("an old foundation key opens a new agentnet door and the document verifies offline", () => {
  const oldK = keychain("foundation"), newK = keychain("agentnet");
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "additional-door", statement: "Same agent, new Agent Commons door." });
  assert.deepEqual(Object.keys(doc).sort(), ["issuedAt", "new", "newSignature", "nonce", "old", "oldSignature", "relation", "statement", "v"]);
  assert.equal(doc.v, KEY_CONTINUITY_V);
  assert.deepEqual(doc.old, party(oldK));
  assert.deepEqual(doc.new, party(newK));
  assert.match(doc.nonce, /^[0-9a-f]{32}$/);
  assert.match(doc.issuedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(doc.oldSignature, /^[0-9a-f]{128}$/);
  assert.match(doc.newSignature, /^[0-9a-f]{128}$/);
  const body = verifyKeyContinuity(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(body, bodyOf(doc));
  // Domain-separated preimage; a signature over the bare JCS body does not verify.
  const preimage = keyContinuityPreimage(body);
  assert.equal(preimage.toString("utf8"), `${KEY_CONTINUITY_V}\n${jcs(body)}`);
  assert.equal(Keychain.verifyDetached(doc.old.publicKey, preimage, Buffer.from(doc.oldSignature, "hex")), true);
  assert.equal(Keychain.verifyDetached(doc.old.publicKey, Buffer.from(jcs(body)), Buffer.from(doc.oldSignature, "hex")), false);
  refuses(() => verifyKeyContinuity({ ...doc, oldSignature: oldK.sign(Buffer.from(jcs(body))).toString("hex") }), "OLD_SIGNATURE");
  assert.match(keyContinuityDigest(doc), /^[0-9a-f]{64}$/);
});

test("a pillar key rotates to a new pillar key; the statement is optional", () => {
  const oldK = keychain("pillar"), newK = keychain("pillar");
  const issuedAt = "2026-11-08T12:00:00.000Z";
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation", issuedAt });
  assert.equal(Object.hasOwn(doc, "statement"), false);
  assert.equal(doc.issuedAt, issuedAt);
  const body = verifyKeyContinuity(doc, { now: Date.parse(issuedAt) });
  assert.equal(body.relation, "rotation");
  assert.equal(body.old.uuaid.split(":")[1], "pillar");
  assert.equal(body.new.uuaid.split(":")[1], "pillar");
  // Two attestations between the same keys differ by nonce.
  assert.notEqual(createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation", issuedAt }).nonce, doc.nonce);
});

test("any tampered body field breaks the old key's signature", () => {
  const oldK = keychain(), newK = keychain("agentnet"), other = keychain("agentnet");
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "additional-door", statement: "door two" });
  refuses(() => verifyKeyContinuity({ ...doc, relation: "rotation" }), "OLD_SIGNATURE");
  refuses(() => verifyKeyContinuity({ ...doc, new: party(other) }), "OLD_SIGNATURE");
  refuses(() => verifyKeyContinuity({ ...doc, issuedAt: new Date(Date.parse(doc.issuedAt) - 1).toISOString() }), "OLD_SIGNATURE");
  refuses(() => verifyKeyContinuity({ ...doc, statement: "door three" }), "OLD_SIGNATURE");
  const { statement, ...unstated } = doc;
  refuses(() => verifyKeyContinuity(unstated), "OLD_SIGNATURE");
  refuses(() => verifyKeyContinuity({ ...doc, nonce: "0".repeat(32) }), "OLD_SIGNATURE");
  // A new key that never signed cannot be smuggled in even with a valid old vouch.
  const forged = sign({ ...bodyOf(doc), new: party(other) }, oldK, newK);
  refuses(() => verifyKeyContinuity(forged), "NEW_SIGNATURE");
});

test("signatures are bound to their roles and both are required", () => {
  const oldK = keychain(), newK = keychain("agentnet");
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation" });
  refuses(() => verifyKeyContinuity({ ...doc, oldSignature: doc.newSignature, newSignature: doc.oldSignature }), "OLD_SIGNATURE");
  refuses(() => verifyKeyContinuity({ ...doc, newSignature: doc.oldSignature }), "NEW_SIGNATURE");
  const { newSignature, ...withoutNew } = doc;
  refuses(() => verifyKeyContinuity(withoutNew), "SHAPE");
  const { oldSignature, ...withoutOld } = doc;
  refuses(() => verifyKeyContinuity(withoutOld), "SHAPE");
  refuses(() => verifyKeyContinuity({ ...doc, newSignature: doc.newSignature.toUpperCase() }), "NEW_SIGNATURE");
  refuses(() => verifyKeyContinuity({ ...doc, oldSignature: "00" }), "OLD_SIGNATURE");
});

test("a UUAID not bound to its key, or not a self-certifying agent id, is refused", () => {
  const oldK = keychain(), newK = keychain("agentnet"), other = keychain();
  const body = bodyOf(createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation" }));
  refuses(() => verifyKeyContinuity(sign({ ...body, new: { uuaid: other._identity.uuaid, publicKey: body.new.publicKey } }, oldK, newK)), "NEW_KEY_BINDING");
  refuses(() => verifyKeyContinuity(sign({ ...body, old: { uuaid: body.old.uuaid, publicKey: other._identity.publicKeyHex } }, oldK, newK)), "OLD_KEY_BINDING");
  refuses(() => verifyKeyContinuity(sign({ ...body, old: { ...body.old, uuaid: body.old.uuaid.replace(":foundation:", ":zilligon:") } }, oldK, newK)), "OLD_KEY_BINDING");
  refuses(() => verifyKeyContinuity(sign({ ...body, new: { ...body.new, uuaid: body.new.uuaid.replace(":agent:", ":service:") } }, oldK, newK)), "NEW_KEY_BINDING");
  refuses(() => verifyKeyContinuity(sign({ ...body, new: { ...body.new, publicKey: body.new.publicKey.toUpperCase() } }, oldK, newK)), "NEW_KEY_BINDING");
  // The identity point binds to its hash-derived id but is not a strict Ed25519 key.
  const weak = "01" + "00".repeat(31);
  refuses(() => verifyKeyContinuity(sign({ ...body, old: { uuaid: spelling("foundation", weak), publicKey: weak } }, oldK, newK)), "OLD_WEAK_KEY");
  // createKeyContinuity refuses a keychain that is not a key-derived agent id.
  const service = new Keychain("unused"); service._identity = Keychain.generate({ objectType: "service" });
  refuses(() => createKeyContinuity({ oldKeychain: service, newKeychain: newK, relation: "rotation" }), "OLD_KEY_BINDING");
  refuses(() => createKeyContinuity({ oldKeychain: new Keychain("unused"), newKeychain: newK, relation: "rotation" }), "KEYCHAIN_NOT_LOADED");
});

test("the same key on both sides is refused, even under two namespace spellings", () => {
  const k = keychain();
  refuses(() => createKeyContinuity({ oldKeychain: k, newKeychain: k, relation: "rotation" }), "SAME_KEY");
  const publicKey = k._identity.publicKeyHex;
  const body = { v: KEY_CONTINUITY_V, relation: "additional-door", old: { uuaid: spelling("foundation", publicKey), publicKey }, new: { uuaid: spelling("agentnet", publicKey), publicKey }, issuedAt: new Date().toISOString(), nonce: "ab".repeat(16) };
  refuses(() => verifyKeyContinuity(sign(body, k, k)), "SAME_KEY");
});

test("a document issued beyond the clock skew is refused; within it, accepted", () => {
  const oldK = keychain(), newK = keychain("agentnet"), now = Date.now();
  const far = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation", issuedAt: now + 10 * 60000 });
  refuses(() => verifyKeyContinuity(far, { now }), "FUTURE");
  const near = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation", issuedAt: now + 60000 });
  assert.equal(verifyKeyContinuity(near, { now }).issuedAt, near.issuedAt);
  refuses(() => verifyKeyContinuity(near, { now, maxFutureSkewMs: 0 }), "FUTURE");
  assert.equal(verifyKeyContinuity(far, { now: now + 10 * 60000 }).issuedAt, far.issuedAt);
  refuses(() => createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation", issuedAt: "not a time" }), "ISSUED_AT");
});

test("the shape is closed and every field is checked before signatures", () => {
  const oldK = keychain(), newK = keychain("agentnet");
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation" });
  const body = bodyOf(doc);
  refuses(() => verifyKeyContinuity({ ...doc, extra: true }), "SHAPE");
  refuses(() => verifyKeyContinuity({ ...doc, old: { ...doc.old, note: "x" } }), "SHAPE");
  refuses(() => verifyKeyContinuity({ ...doc, new: { uuaid: doc.new.uuaid } }), "SHAPE");
  refuses(() => verifyKeyContinuity(JSON.parse(JSON.stringify(doc).replace(/^\{/, '{"__proto__":{},'))), "SHAPE");
  refuses(() => verifyKeyContinuity(null), "SHAPE");
  refuses(() => verifyKeyContinuity([doc]), "SHAPE");
  refuses(() => verifyKeyContinuity(sign({ ...body, v: "agent-commons/key-continuity/2" }, oldK, newK)), "VERSION");
  refuses(() => verifyKeyContinuity(sign({ ...body, relation: "merger" }, oldK, newK)), "RELATION");
  refuses(() => verifyKeyContinuity(sign({ ...body, nonce: "AB".repeat(16) }, oldK, newK)), "NONCE");
  refuses(() => verifyKeyContinuity(sign({ ...body, nonce: "ab".repeat(15) }, oldK, newK)), "NONCE");
  refuses(() => verifyKeyContinuity(sign({ ...body, issuedAt: body.issuedAt.replace(/\.\d{3}Z$/, "Z") }, oldK, newK)), "ISSUED_AT");
  refuses(() => verifyKeyContinuity(sign({ ...body, issuedAt: "2026-02-30T00:00:00.000Z" }, oldK, newK)), "ISSUED_AT");
  refuses(() => verifyKeyContinuity(sign({ ...body, statement: 7 }, oldK, newK)), "STATEMENT");
  refuses(() => verifyKeyContinuity(sign({ ...body, statement: "\ud800" }, oldK, newK)), "STATEMENT");
  // 500 code points pass even when they are 1000 UTF-16 units; 501 do not.
  assert.equal(verifyKeyContinuity(createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation", statement: "🧬".repeat(500) })).statement.length, 1000);
  refuses(() => createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation", statement: "a".repeat(501) }), "STATEMENT");
  refuses(() => verifyKeyContinuity(sign({ ...body, statement: "a".repeat(501) }, oldK, newK)), "STATEMENT");
  refuses(() => createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "merger" }), "RELATION");
});

// ---- receiver side -------------------------------------------------------

const readConfig = home => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "ac-keycont-"));
  try { initialize({ home }); return await fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function admitOld(home, oldK, extra = {}) {
  const config = readConfig(home);
  config.policy.agents[oldK._identity.uuaid] = { kind: "agent", publicKey: oldK._identity.publicKeyHex, capabilities: ["commons:message", "commons:relay", "commons:contribute"], credentialId: "cred-old-1", controllerId: "operator-a", affiliations: ["lab-a"], ...extra };
  saveConfig(home, config);
  return config;
}
function continuityEvents(home) {
  const store = new CommonsStore(join(home, "commons.db"));
  try { return { verified: store.verify(), events: store.audit().map(r => ({ id: r.id, ...JSON.parse(r.body) })).filter(e => e.kind === "key-continuity-admitted") }; }
  finally { store.close(); }
}

test("admitByContinuity extends the old key's grant to the new key and audits it", async () => withHome(async home => {
  const oldK = keychain("foundation"), newK = keychain("agentnet");
  admitOld(home, oldK);
  // The receiver never needs the home's keychain passphrase.
  rmSync(join(home, "local-secret"), { force: true });
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation", statement: "rotating after host move" });
  const result = admitByContinuity({ home, doc: clone(doc) });
  assert.equal(result.admitted, newK._identity.uuaid);
  assert.equal(result.from, oldK._identity.uuaid);
  assert.equal(result.relation, "rotation");
  assert.deepEqual(result.capabilities, ["commons:message", "commons:relay", "commons:contribute"]);
  assert.equal(result.oldKeyStillAdmitted, true);
  assert.equal(result.credentialCopied, false);
  assert.equal(result.note, "Local policy grant via verified key-continuity; not certification");
  assert.equal(result.docDigest, keyContinuityDigest(doc));
  assert.deepEqual(result.carried, ["controllerId", "affiliations"]);

  const agents = readConfig(home).policy.agents;
  assert.deepEqual(agents[newK._identity.uuaid], { kind: "agent", publicKey: newK._identity.publicKeyHex, capabilities: ["commons:message", "commons:relay", "commons:contribute"], controllerId: "operator-a", affiliations: ["lab-a"] });
  assert.equal(Object.hasOwn(agents[newK._identity.uuaid], "credentialId"), false, "a registry credential names one subject; it is never carried");
  assert.equal(agents[oldK._identity.uuaid].publicKey, oldK._identity.publicKeyHex, "rotation leaves the old key admitted");
  assert.equal(agents[oldK._identity.uuaid].credentialId, "cred-old-1");

  const audit = continuityEvents(home);
  assert.equal(audit.verified, true);
  assert.equal(audit.events.length, 1);
  assert.deepEqual(audit.events[0], { id: `key-continuity:${result.docDigest}`, kind: "key-continuity-admitted", old: party(oldK), new: party(newK), relation: "rotation", docDigest: result.docDigest, capabilities: result.capabilities });
  assert.deepEqual(result.audit.id, audit.events[0].id);

  // The new door passes the local trust gate with the carried capability.
  const verdict = await new RegistryTrust({ policy: readConfig(home).policy }).authorize(newK._identity.uuaid, newK._identity.publicKeyHex, "commons:contribute");
  assert.equal(verdict.tier, "local-policy-pinned");

  // Re-presenting is idempotent and leaves the grant alone.
  const again = admitByContinuity({ home, doc: clone(doc) });
  assert.equal(again.alreadyAdmitted, true);
  assert.equal(continuityEvents(home).events.length, 1);

  // Once consumed, a removed grant is not restored by replaying the same document.
  const config = readConfig(home);
  delete config.policy.agents[newK._identity.uuaid];
  saveConfig(home, config);
  refuses(() => admitByContinuity({ home, doc: clone(doc) }), "CONTINUITY_REPLAYED");
  assert.equal(Object.hasOwn(readConfig(home).policy.agents, newK._identity.uuaid), false);
}));

test("an additional door keeps both keys admitted; an open store can be supplied", () => withHome(home => {
  const oldK = keychain("pillar"), newK = keychain("agentnet");
  admitOld(home, oldK, { credentialId: undefined, controllerId: undefined, affiliations: undefined, tenantId: "tenant-1" });
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "additional-door" });
  const store = new CommonsStore(join(home, "commons.db"));
  try {
    const result = admitByContinuity({ home, doc, store });
    assert.equal(result.relation, "additional-door");
    assert.equal(result.oldKeyStillAdmitted, true);
    assert.deepEqual(result.carried, ["tenantId"]);
    assert.equal(store.verify(), true);
  } finally { store.close(); }
  const agents = readConfig(home).policy.agents;
  assert.equal(agents[newK._identity.uuaid].tenantId, "tenant-1");
  assert.ok(agents[oldK._identity.uuaid]);
}));

test("admission refuses when the old key is not admitted, mismatched, or blocked", () => withHome(home => {
  const oldK = keychain(), newK = keychain("agentnet"), other = keychain();
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "rotation" });
  refuses(() => admitByContinuity({ home, doc }), "OLD_NOT_ADMITTED");

  admitOld(home, oldK, { publicKey: other._identity.publicKeyHex });
  refuses(() => admitByContinuity({ home, doc }), "OLD_KEY_MISMATCH");

  admitOld(home, oldK, { kind: "service" });
  refuses(() => admitByContinuity({ home, doc }), "OLD_NOT_ADMITTED");

  admitOld(home, oldK, { blocked: true });
  refuses(() => admitByContinuity({ home, doc }), "OLD_BLOCKED");

  const config = admitOld(home, oldK);
  config.policy.blocked = [spelling("agentnet", oldK._identity.publicKeyHex)];
  saveConfig(home, config);
  refuses(() => admitByContinuity({ home, doc }), "OLD_BLOCKED");

  // A tampered document is refused before policy is read.
  refuses(() => admitByContinuity({ home, doc: { ...doc, relation: "additional-door" } }), "OLD_SIGNATURE");
  assert.equal(Object.hasOwn(readConfig(home).policy.agents, newK._identity.uuaid), false);
  assert.equal(continuityEvents(home).events.length, 0);
}));

test("admission refuses a new key that is blocked or already admitted elsewhere", () => withHome(home => {
  const oldK = keychain(), newK = keychain("agentnet"), other = keychain();
  const doc = createKeyContinuity({ oldKeychain: oldK, newKeychain: newK, relation: "additional-door" });
  const config = admitOld(home, oldK);

  config.policy.blocked = [newK._identity.uuaid];
  saveConfig(home, config);
  refuses(() => admitByContinuity({ home, doc }), "NEW_BLOCKED");

  // Blocked under its foundation spelling blocks the agentnet door too.
  config.policy.blocked = [spelling("foundation", newK._identity.publicKeyHex)];
  saveConfig(home, config);
  refuses(() => admitByContinuity({ home, doc }), "NEW_BLOCKED");

  config.policy.blocked = [];
  config.policy.agents[spelling("pillar", newK._identity.publicKeyHex)] = { kind: "agent", publicKey: newK._identity.publicKeyHex, capabilities: ["commons:message"] };
  saveConfig(home, config);
  refuses(() => admitByContinuity({ home, doc }), "NEW_KEY_ADMITTED_ELSEWHERE");

  delete config.policy.agents[spelling("pillar", newK._identity.publicKeyHex)];
  config.policy.agents[newK._identity.uuaid] = { kind: "agent", publicKey: other._identity.publicKeyHex, capabilities: ["commons:message"] };
  saveConfig(home, config);
  refuses(() => admitByContinuity({ home, doc }), "NEW_KEY_CONFLICT");

  assert.equal(readConfig(home).policy.agents[newK._identity.uuaid].publicKey, other._identity.publicKeyHex);
  assert.equal(continuityEvents(home).events.length, 0);
}));
