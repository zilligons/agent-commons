/**
 * Manifest verifier wrapper, admin signer and key→uuaid binding helpers
 * (design §3, §4). Additive; imports the vendored pillar engine ONLY through
 * ./pillar-group.mjs (C9). Computes no engine-vs-client hash (C13/V-7): the
 * manifest path uses the vendored canonicalJson, never the engine's jcs (V-1).
 *
 * In scope here (slice 6): V-3 (only whole chains yield a head), V-6's
 * sign → verify → own-store-save → return order, B-1/B-2 (vendored binding,
 * not re-implemented), B-3 (policy-record candidates from the verified head),
 * B-4 (full-uuaid keys enforce the namespace at the engine trust gate), B-6
 * (self check) and V-7's unit-level ASCII-key guard.
 *
 * Deferred by design, NOT stubbed: P-7 (a remove/leave manifest adds the
 * pendingRemovals entry in the same step — slice 7, spans adapter.json),
 * the sends themselves (slice 8), V-7's send/receive wiring (slices 8/9),
 * B-5's transport-key snapshot (slices 5/8).
 */
import {
  adminOf, buildNext, keyBindsUuaid, manifestHash, signManifest,
  uuaidForKey, verifyChain,
} from "./pillar-group.mjs";

/** A named error, so a caller (and a pole) can tell refusals apart. */
export class ManifestError extends Error {
  constructor(name, message) { super(message); this.name = name; }
}

/** P-2: capabilities are exactly ["commons:message"] for every record. */
const AGENT_CAPABILITIES = Object.freeze(["commons:message"]);

// ── V-3: only whole chains ────────────────────────────────────────────────

/**
 * The usable head of a record, only if its chain verifies from version 1.
 * Never takes a head from an unverified record: verifyChain runs here, in
 * this call, whatever the record's provenance (SpaceStore.loadRoster output
 * re-verifies too — this is the explicit gate for a supplied record).
 *
 * If `rec.head` is present it must agree with the verified chain's last
 * manifest; a record without one is tolerated because the chain itself is
 * the verified source of the head.
 */
export function verifiedHead(rec) {
  if (!rec || !Array.isArray(rec.chain) || rec.chain.length === 0) {
    throw new ManifestError("ChainVerifyError", "record: no chain to verify");
  }
  const v = verifyChain(rec.chain);
  if (!v.ok) throw new ManifestError("ChainVerifyError", `chain rejected: ${v.reason}@${v.at}`);
  const head = rec.chain[rec.chain.length - 1];
  if (rec.head !== undefined && rec.head !== null) {
    if (rec.head.version !== head.version || rec.head.hash !== manifestHash(head)) {
      throw new ManifestError("HeadMismatchError", "rec.head does not match the verified chain's last manifest");
    }
  }
  return head;
}

// ── B-6: self check ───────────────────────────────────────────────────────

/** Normalize a Keychain instance (._identity) or a raw identity object. */
function keychainIdentity(keychain) {
  const id = keychain?._identity ?? keychain;
  if (!id || typeof id.uuaid !== "string" || id.uuaid.length === 0 ||
      typeof id.publicKeyHex !== "string" || id.publicKeyHex.length === 0) {
    throw new ManifestError("SelfCheckError", "keychain: no loaded identity {uuaid, publicKeyHex}");
  }
  return id;
}

/**
 * B-6. Passes only when (a) keychain.uuaid === uuaidForKey(own public key)
 * — the vendored derivation, not a re-implementation — AND (b) the VERIFIED
 * head holds a row for that uuaid carrying that same key. Otherwise throws
 * SelfCheckError. On a chain that verified, (b)'s key-mismatch arm is
 * unreachable when (a) held (B-1: the uuaid is a function of the key, and
 * rowChecks binds every row), so it is kept as a guard against a future
 * vendored change and for callers that hand-build a head — same posture as
 * the space store's keep-only-if clauses.
 */
export function selfCheck(keychain, rec) {
  const id = keychainIdentity(keychain);
  if (id.uuaid !== uuaidForKey(id.publicKeyHex)) {
    throw new ManifestError("SelfCheckError", "keychain uuaid does not derive from its own public key");
  }
  const head = verifiedHead(rec);
  const row = head.members.find((r) => r.uuaid === id.uuaid);
  if (!row) throw new ManifestError("SelfCheckError", "the verified head holds no row for this keychain's uuaid");
  if (row.key !== id.publicKeyHex) throw new ManifestError("SelfCheckError", "the head's own row carries a different key");
  return true;
}

// ── V-6: the admin signer (sign → verify → own-store-save → return) ──────

/**
 * Build, sign and apply the next manifest to the ADMIN's own store, then
 * return it for the caller to send (the send itself is slice 8 — this never
 * sends). Order is load-bearing:
 *   1. load through SpaceStore.loadRoster, which re-verifies (F13, V-3);
 *   2. explicit verifiedHead (V-3) and selfCheck (B-6);
 *   3. the signer must be the head's single active admin (F14);
 *   4. buildNext (vendored builder) + signManifest with the admin's own
 *      keychain (F14);
 *   5. verifyChain over previous chain + new manifest BEFORE any write — a
 *      rejected chain never reaches the store (the store would refuse it too
 *      via checkStoreRecord; this gate fails first, with a named error);
 *   6. store.saveRoster on the admin's OWN store FIRST;
 *   7. only then return { manifest, record }.
 *
 * P-7 (a remove/leave manifest puts the member into pendingRemovals in the
 * same step) is slice 7's: it spans the roster and adapter.json. The record
 * fields other than chain/head (seen, leaving, frozen, …) are preserved
 * verbatim; the receiver-side application semantics belong to slice 8.
 *
 * Synchronous; the adapter's serial queue (I-5) is the caller's job.
 * @returns {{ manifest: object, record: object }}
 */
export function signAndApplyNext(store, groupId, keychain, action, buildOpts = {}) {
  const rec = store.loadRoster(groupId); // re-verifies from version 1 (F13); null = absent
  if (!rec) throw new ManifestError("RosterAbsentError", `no verified roster for ${String(groupId)}`);
  const head = verifiedHead(rec); // V-3, explicit
  const id = keychainIdentity(keychain);
  selfCheck(keychain, rec); // B-6
  const admin = adminOf(head);
  if (!admin || admin.uuaid !== id.uuaid || admin.key !== id.publicKeyHex) {
    throw new ManifestError("NotAdminError", "the signer is not the head's single active admin");
  }
  const next = buildNext(head, action, buildOpts); // vendored builder
  const signed = signManifest(next, keychain); // F14: the admin's own keychain
  const chain = [...rec.chain, signed];
  const v = verifyChain(chain);
  if (!v.ok) throw new ManifestError("ChainVerifyError", `signed chain rejected: ${v.reason}@${v.at}`);
  const record = { ...rec, chain, head: { version: signed.version, hash: manifestHash(signed) } };
  store.saveRoster(record); // OWN STORE FIRST (saveRoster refuses an unverified record, S-1)
  return { manifest: signed, record }; // …and only then handed back for sending
}

// ── B-3: policy-record candidates from the verified head ─────────────────

/**
 * One candidate `policy.agents` entry from one roster row. The binding is
 * the vendored keyBindsUuaid (B-1/B-2: full-string compare plus strict-key
 * rules) — never re-implemented here. A failing row THROWS; it is never
 * skipped silently. Exported so the binding re-check is unit-testable on a
 * hand-built row (on a verified chain rowChecks already binds every row, so
 * the aggregate below re-checks as defense in depth).
 */
export function agentRecordForRow(row) {
  if (!row || typeof row.uuaid !== "string" || typeof row.key !== "string") {
    throw new ManifestError("KeyBindingError", "row: expected {uuaid, key} strings");
  }
  if (!keyBindsUuaid(row.uuaid, row.key)) {
    throw new ManifestError("KeyBindingError", `row ${row.uuaid}: key does not bind its uuaid`);
  }
  return { kind: "agent", publicKey: row.key, capabilities: [...AGENT_CAPABILITIES] };
}

/**
 * B-3, pure: candidate `policy.agents` entries ONLY from the verified head's
 * non-removed rows (active ∪ invited, design §5), keyed by the FULL row.uuaid
 * — which is what makes B-4 hold: the engine's own checks look at the local id
 * only, so an `uuaid:other:agent:<id>` sender with a member's key passes
 * KEY_BINDING and is then refused NOT_ADMITTED, because a policy built here
 * holds only `uuaid:foundation:agent:` keys. Writes no policy: slice 7's
 * policy writer is the only writer and consumes this helper.
 */
export function agentRecordsFromVerifiedHead(rec) {
  const head = verifiedHead(rec);
  const agents = {};
  for (const row of head.members) {
    if (row.status === "removed") continue;
    agents[row.uuaid] = agentRecordForRow(row); // full-uuaid key; throws, never skips
  }
  return agents;
}

// ── V-7 (unit level): no non-ASCII object keys, any depth ────────────────

function isAsciiKey(k) {
  for (const ch of k) if (ch.codePointAt(0) > 0x7f) return false;
  return true;
}

/**
 * V-7's guard, unit-tested here; its wiring into send and receive is
 * slices 8/9. Refuses any non-ASCII object key at any depth — commons
 * objects, charter objects and space profile documents including the
 * lexicon — because the engine's vendored jcs sorts by UTF-16LE bytes and
 * disagrees with pillar-client's JCS on such keys (F16), so no
 * engine-vs-client hash may be computed over them (C13). Array indices are
 * keys of an array object and are ASCII by construction. Contract: parsed-
 * JSON or freshly built objects; a cyclic input is out of contract.
 */
export function assertAsciiKeys(obj, path = "$") {
  if (obj === null || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    if (!isAsciiKey(k)) {
      throw new ManifestError("NonAsciiKeyError", `${path}: non-ASCII object key ${JSON.stringify(k)}`);
    }
    assertAsciiKeys(obj[k], `${path}.${k}`);
  }
}
