// Key continuity as a shipped object.
//
// An agent's OLD key vouches for a NEW key, and the NEW key accepts the vouch,
// in one offline-verifiable document. A rotated key, or an additional door for
// the same agent, then proves itself instead of being believed.
//
// This module is unrelated to ./continuity.mjs (ContinuityMemory).
//
// Wire format (agent-commons/key-continuity/1):
//   body      = { v, relation, old:{uuaid,publicKey}, new:{uuaid,publicKey},
//                 issuedAt, nonce, statement? }
//   preimage  = UTF-8 of `agent-commons/key-continuity/1\n` + jcs(body)
//   document  = { ...body, oldSignature, newSignature }
// Both keys sign the same preimage. oldSignature is the vouch; newSignature is
// the new key's proof of possession and acceptance. Both are required.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jcs, Keychain } from "./pillar.mjs";
import { isStrictEd25519PublicKey } from "./vendor/pillar/identity/keychain.mjs";
import { assertJSON, digest } from "./profiles.mjs";
import { keyBindsAgentUuaid, keyIsBlocked } from "./uuaid-namespace.mjs";
import { homePath, saveConfig } from "./config.mjs";
import { CommonsStore } from "./store.mjs";

export const KEY_CONTINUITY_V = "agent-commons/key-continuity/1";
export const KEY_CONTINUITY_RELATIONS = Object.freeze(["rotation", "additional-door"]);
export const KEY_CONTINUITY_STATEMENT_MAX = 500;
export const KEY_CONTINUITY_NOTE = "Local policy grant via verified key-continuity; not certification";

// Admission fields carried from the old grant to the new one, besides
// capabilities. They describe who controls the agent (controllerId,
// affiliations), where it belongs (tenantId) and whom it must not review
// (conflicts). The document proves the same controller holds both keys, so the
// new door inherits them; governance's independence check then still sees both
// doors as one controller. credentialId is NEVER carried: a registry credential
// names one subject UUAID (trust.mjs checks verdict.agent_uuaid === uuaid), so
// the new UUAID needs its own credential for global mode.
const CARRIED_FIELDS = Object.freeze(["controllerId", "affiliations", "tenantId", "conflicts"]);

const BODY_KEYS = new Set(["v", "relation", "old", "new", "issuedAt", "nonce", "statement"]);
const DOC_KEYS = new Set([...BODY_KEYS, "oldSignature", "newSignature"]);
const REQUIRED_DOC_KEYS = ["v", "relation", "old", "new", "issuedAt", "nonce", "oldSignature", "newSignature"];
const PARTY_KEYS = ["publicKey", "uuaid"];
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONCE = /^[0-9a-f]{32}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;

export class KeyContinuityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KeyContinuityError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new KeyContinuityError(code, message); };

const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function closedShape(value, allowed, required, code, what) {
  if (!plainObject(value)) fail(code, `${what} must be a plain JSON object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail(code, `${what} has an unknown field ${String(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(code, `${what} is missing ${key}`);
  }
}

/** The exact bytes both keys sign: domain tag, newline, JCS of the body. */
export function keyContinuityPreimage(body) {
  return Buffer.from(`${KEY_CONTINUITY_V}\n${jcs(body)}`, "utf8");
}

function codePoints(text) { return [...text].length; }

function checkStatement(statement) {
  if (typeof statement !== "string") fail("STATEMENT", "statement must be a string");
  if (!statement.isWellFormed()) fail("STATEMENT", "statement must be well-formed Unicode (no lone surrogates)");
  if (codePoints(statement) > KEY_CONTINUITY_STATEMENT_MAX) fail("STATEMENT", `statement exceeds ${KEY_CONTINUITY_STATEMENT_MAX} code points`);
}

function partyOf(keychain, role) {
  const identity = keychain?._identity;
  if (!identity) fail("KEYCHAIN_NOT_LOADED", `${role} keychain is not loaded`);
  const { uuaid, publicKeyHex } = identity;
  if (!keyBindsAgentUuaid(uuaid, publicKeyHex)) fail(`${role.toUpperCase()}_KEY_BINDING`, `${role} keychain does not hold a key-derived agent UUAID in a self-certifying namespace`);
  if (!isStrictEd25519PublicKey(publicKeyHex)) fail(`${role.toUpperCase()}_WEAK_KEY`, `${role} public key is not a strict Ed25519 key`);
  return { uuaid, publicKey: publicKeyHex };
}

/**
 * Build and sign a key-continuity document. Both keychains must be loaded.
 * oldKeychain vouches; newKeychain accepts. issuedAt defaults to now.
 */
export function createKeyContinuity({ oldKeychain, newKeychain, relation, statement, issuedAt } = {}) {
  if (!KEY_CONTINUITY_RELATIONS.includes(relation)) fail("RELATION", `relation must be one of ${KEY_CONTINUITY_RELATIONS.join(", ")}`);
  const oldParty = partyOf(oldKeychain, "old");
  const newParty = partyOf(newKeychain, "new");
  if (oldParty.publicKey === newParty.publicKey) fail("SAME_KEY", "old and new keys are the same key");
  const at = new Date(issuedAt ?? Date.now());
  if (Number.isNaN(at.getTime())) fail("ISSUED_AT", "issuedAt is not a valid time");
  const body = {
    v: KEY_CONTINUITY_V,
    relation,
    old: oldParty,
    new: newParty,
    issuedAt: at.toISOString(),
    nonce: randomBytes(16).toString("hex"),
  };
  if (statement !== undefined) { checkStatement(statement); body.statement = statement; }
  const preimage = keyContinuityPreimage(body);
  const doc = {
    ...body,
    oldSignature: oldKeychain.sign(preimage).toString("hex"),
    newSignature: newKeychain.sign(preimage).toString("hex"),
  };
  // Self-check everything but the clock, so a caller can mint a dated document.
  verifyKeyContinuity(doc, { now: at.getTime(), maxFutureSkewMs: 0 });
  return doc;
}

/**
 * Verify a key-continuity document. Pure and offline: no I/O, no registry.
 * Returns a fresh copy of the verified body (without signatures) or throws a
 * KeyContinuityError whose code names the first failed check.
 */
export function verifyKeyContinuity(doc, { now = Date.now(), maxFutureSkewMs = 300000 } = {}) {
  if (!Number.isFinite(now)) fail("CLOCK", "now must be a finite millisecond timestamp");
  if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0) fail("CLOCK", "maxFutureSkewMs must be a non-negative integer");
  closedShape(doc, DOC_KEYS, REQUIRED_DOC_KEYS, "SHAPE", "key-continuity document");
  try { assertJSON(doc); } catch (error) { fail("SHAPE", `key-continuity document is not canonical JSON: ${error.message}`); }
  if (doc.v !== KEY_CONTINUITY_V) fail("VERSION", `unsupported key-continuity version; expected ${KEY_CONTINUITY_V}`);
  if (!KEY_CONTINUITY_RELATIONS.includes(doc.relation)) fail("RELATION", `relation must be one of ${KEY_CONTINUITY_RELATIONS.join(", ")}`);
  closedShape(doc.old, new Set(PARTY_KEYS), PARTY_KEYS, "SHAPE", "old");
  closedShape(doc.new, new Set(PARTY_KEYS), PARTY_KEYS, "SHAPE", "new");
  if (!keyBindsAgentUuaid(doc.old.uuaid, doc.old.publicKey)) fail("OLD_KEY_BINDING", "old.uuaid is not a self-certifying agent UUAID owned by old.publicKey");
  if (!keyBindsAgentUuaid(doc.new.uuaid, doc.new.publicKey)) fail("NEW_KEY_BINDING", "new.uuaid is not a self-certifying agent UUAID owned by new.publicKey");
  if (doc.old.publicKey === doc.new.publicKey) fail("SAME_KEY", "old and new keys are the same key");
  if (doc.old.uuaid === doc.new.uuaid) fail("SAME_UUAID", "old and new UUAIDs are the same");
  if (!isStrictEd25519PublicKey(doc.old.publicKey)) fail("OLD_WEAK_KEY", "old.publicKey is not a strict Ed25519 key");
  if (!isStrictEd25519PublicKey(doc.new.publicKey)) fail("NEW_WEAK_KEY", "new.publicKey is not a strict Ed25519 key");
  if (typeof doc.nonce !== "string" || !NONCE.test(doc.nonce)) fail("NONCE", "nonce must be 32 lower-case hex characters");
  if (typeof doc.issuedAt !== "string" || !ISO_MS.test(doc.issuedAt)) fail("ISSUED_AT", "issuedAt must be an ISO-8601 UTC time with millisecond precision");
  const issued = Date.parse(doc.issuedAt);
  if (Number.isNaN(issued) || new Date(issued).toISOString() !== doc.issuedAt) fail("ISSUED_AT", "issuedAt is not a valid calendar time");
  if (issued > now + maxFutureSkewMs) fail("FUTURE", "issuedAt is in the future beyond the allowed clock skew");
  if (Object.hasOwn(doc, "statement")) checkStatement(doc.statement);
  if (typeof doc.oldSignature !== "string" || !SIGNATURE.test(doc.oldSignature)) fail("OLD_SIGNATURE", "oldSignature must be 128 lower-case hex characters");
  if (typeof doc.newSignature !== "string" || !SIGNATURE.test(doc.newSignature)) fail("NEW_SIGNATURE", "newSignature must be 128 lower-case hex characters");
  const { oldSignature, newSignature, ...rest } = doc;
  const body = {
    v: rest.v,
    relation: rest.relation,
    old: { uuaid: rest.old.uuaid, publicKey: rest.old.publicKey },
    new: { uuaid: rest.new.uuaid, publicKey: rest.new.publicKey },
    issuedAt: rest.issuedAt,
    nonce: rest.nonce,
    ...(Object.hasOwn(rest, "statement") ? { statement: rest.statement } : {}),
  };
  const preimage = keyContinuityPreimage(body);
  if (!Keychain.verifyDetached(body.old.publicKey, preimage, Buffer.from(oldSignature, "hex"))) fail("OLD_SIGNATURE", "oldSignature does not verify under old.publicKey");
  if (!Keychain.verifyDetached(body.new.publicKey, preimage, Buffer.from(newSignature, "hex"))) fail("NEW_SIGNATURE", "newSignature does not verify under new.publicKey");
  return body;
}

/** sha256 over the JCS of the whole signed document; the audit and replay id. */
export function keyContinuityDigest(doc) {
  return digest(doc);
}

const copyJSON = value => JSON.parse(JSON.stringify(value));

/**
 * Receiver side. Admit doc.new into this home's local policy with the grant the
 * old key holds now. Reads config.json directly and never loads the home's
 * keychain. Never removes the old key: retiring it after a rotation is the
 * operator's decision.
 *
 * Refuses unless doc verifies, doc.old is admitted here as kind "agent" under
 * exactly doc.old.publicKey and is not blocked, and doc.new's key is not
 * blocked, not admitted under another UUAID, and not admitted under doc.new.uuaid
 * with a different key. A document already consumed here never grants twice:
 * if its grant was removed, re-presenting it is refused (block a key to revoke
 * it durably; a fresh attestation from a still-admitted old key can re-admit an
 * entry that was merely deleted).
 */
export function admitByContinuity({ home, doc, store = null, now = Date.now(), maxFutureSkewMs = 300000 } = {}) {
  const body = verifyKeyContinuity(doc, { now, maxFutureSkewMs });
  const docDigest = keyContinuityDigest(doc);
  home = homePath(home);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const policy = config?.policy;
  if (!plainObject(policy) || !plainObject(policy.agents)) fail("OLD_NOT_ADMITTED", "this home has no local agent policy");
  const agents = policy.agents;
  const { old: oldParty, new: newParty, relation } = body;

  const oldEntry = Object.hasOwn(agents, oldParty.uuaid) ? agents[oldParty.uuaid] : undefined;
  if (!plainObject(oldEntry) || oldEntry.kind !== "agent") fail("OLD_NOT_ADMITTED", "old.uuaid is not admitted here as an agent");
  if (oldEntry.publicKey !== oldParty.publicKey) fail("OLD_KEY_MISMATCH", "old.uuaid is admitted here under a different public key");
  if (oldEntry.blocked === true || keyIsBlocked(policy.blocked, oldParty.uuaid)) fail("OLD_BLOCKED", "the old key is blocked here; it cannot vouch");
  if (!Array.isArray(oldEntry.capabilities) || !oldEntry.capabilities.length || oldEntry.capabilities.some(c => typeof c !== "string")) fail("OLD_NOT_ADMITTED", "old.uuaid holds no capabilities to carry");
  if (Object.values(agents).filter(a => a?.publicKey === oldParty.publicKey).length !== 1) fail("DUPLICATE_KEY", "the old key is admitted under more than one UUAID; Sybil-ambiguous policy is not extended");

  if (keyIsBlocked(policy.blocked, newParty.uuaid) || Object.values(agents).some(a => a?.publicKey === newParty.publicKey && a.blocked === true)) fail("NEW_BLOCKED", "the new key is blocked here (under this or another spelling)");
  const elsewhere = Object.entries(agents).find(([id, a]) => id !== newParty.uuaid && a?.publicKey === newParty.publicKey);
  if (elsewhere) fail("NEW_KEY_ADMITTED_ELSEWHERE", `the new key is already admitted here as ${elsewhere[0]}; one key must be one voice`);
  const newEntry = Object.hasOwn(agents, newParty.uuaid) ? agents[newParty.uuaid] : undefined;
  if (newEntry !== undefined && newEntry?.publicKey !== newParty.publicKey) fail("NEW_KEY_CONFLICT", "new.uuaid is already admitted here under a different public key");

  const base = { admitted: newParty.uuaid, from: oldParty.uuaid, relation, docDigest, oldKeyStillAdmitted: true, credentialCopied: false, note: KEY_CONTINUITY_NOTE };
  if (newEntry !== undefined) {
    // Same key already admitted: leave the operator's existing grant untouched.
    return { ...base, capabilities: [...(newEntry.capabilities ?? [])], alreadyAdmitted: true };
  }

  const auditId = `key-continuity:${docDigest}`;
  const grant = { kind: "agent", publicKey: newParty.publicKey, capabilities: [...oldEntry.capabilities] };
  for (const field of CARRIED_FIELDS) if (Object.hasOwn(oldEntry, field)) grant[field] = copyJSON(oldEntry[field]);
  const event = { kind: "key-continuity-admitted", old: oldParty, new: newParty, relation, docDigest, capabilities: grant.capabilities };

  const owned = store === null;
  const db = owned ? new CommonsStore(join(home, "commons.db")) : store;
  try {
    const audit = db.transaction(() => {
      if (db.seen(auditId)) fail("CONTINUITY_REPLAYED", "this attestation was already consumed here and its grant has since been removed; block or re-admit explicitly");
      db.mark(auditId, docDigest);
      const receipt = db.append(auditId, event);
      config.policy.agents[newParty.uuaid] = grant;
      saveConfig(home, config);
      return { id: receipt.id, hash: receipt.hash };
    });
    return {
      ...base,
      capabilities: [...grant.capabilities],
      carried: CARRIED_FIELDS.filter(field => Object.hasOwn(grant, field)),
      ...(policy.mode === "global" ? { registryCredentialRequired: true } : {}),
      audit,
    };
  } finally {
    if (owned) db.close();
  }
}
