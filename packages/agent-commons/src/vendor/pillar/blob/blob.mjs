/**
 * Blob transport — the oversized-payload path for pillar envelopes.
 *
 * Inline envelopes are capped by the carrier tier ladder (community
 * 512 KiB ... 2 MiB; identity/tier.mjs — those limits are NOT redefined
 * here) and by ABSOLUTE_MAX_BODY as the direct hard cap on ANY send.
 * Above the direct threshold the payload travels out-of-band instead:
 *
 *   1. ENCRYPT locally — a fresh random AES-256-GCM DEK per object and a
 *      fresh 12-byte nonce.  The GCM AAD binds the ciphertext to the exact
 *      envelope that will carry its reference:
 *          jcs({ envelopeId, sender, recipient, object, v, expiry })
 *      so a ciphertext cannot be transplanted into another envelope, sender,
 *      recipient, object name, protocol version, or lifetime.
 *   2. UPLOAD the ciphertext to a blob store (temporary-bucket semantics —
 *      objects are ephemeral; expiry travels in the ref and is re-checked
 *      on fetch).
 *   3. SEND a signed blob-ref inside the normal sealed envelope.  The ref
 *      carries DEK + content hash + size; its metadata view (what any
 *      carrier-side log/telemetry may ever see) carries none of those.
 *      The serialized ref must stay <= 4 KiB.
 *   4. REDEEM on receipt: recipient checks the ref signature + expiry +
 *      recipient binding, proves the sender (its UUAID derives from the key
 *      that signed the ref, or else a registry badge names that key),
 *      fetches and hash-checks the object, redeems the broker challenge
 *      (single-use), then decrypts.
 *
 * Error contract: every failure throws a typed BlobError subclass with a
 * stable `.code` — blob-too-large, blob-expired, blob-not-found,
 * blob-upload-failed, blob-fetch-failed, blob-integrity-failed,
 * blob-ref-invalid, blob-broker-*, blob-key-unproven, sender-key-not-active.
 * A broker refusal carries the broker's own `.code` and `.fix` when the
 * broker sends them (`.legacyCode` keeps the blob-broker-* value). A refusal
 * that knows its next step has a one-line `.fix`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { jcs } from "../identity/jcs.mjs";
import { Keychain, localIdFromKey } from "../identity/keychain.mjs";
import { ABSOLUTE_MAX_BODY, TIER_DEFAULTS } from "../identity/tier.mjs";
import { REFUSAL_FIXES } from "../net/refusals.mjs";

export const BLOB_REF_V = 1;
export const BLOB_KIND = "blob-ref";
export const MAX_BLOB_REF_BYTES = 4096;              // serialized ref ceiling
export const MAX_INLINE_BODY_BYTES = ABSOLUTE_MAX_BODY; // 2 MiB direct hard cap
export const MAX_BLOB_OBJECT_BYTES = 50 * 1024 * 1024; // broker ciphertext cap
export const MAX_BLOB_PLAINTEXT_BYTES = MAX_BLOB_OBJECT_BYTES - 16; // GCM tag rides with ciphertext
export const DEFAULT_BLOB_TTL_MS = 24 * 3600 * 1000;
export const DEFAULT_DIRECT_THRESHOLD_BYTES = 256_000;
export const NONCE_BYTES = 12;
export const DEK_BYTES = 32;
/** keyId a broker request presents when the identity proves itself by its own key. */
export const SELF_CERTIFIED_KEY_ID = "self-certified:ed25519";
/** The one UUAID namespace and object type the broker accepts on the self-certified path. */
export const SELF_CERTIFIED_NAMESPACE = "foundation";
export const SELF_CERTIFIED_OBJECT_TYPE = "agent";

// ---------------------------------------------------------------- errors ---
export class BlobError extends Error {
  constructor(code, message, { fix = null } = {}) {
    super(message ?? code); this.name = "BlobError"; this.code = code;
    if (fix) this.fix = fix;
  }
}
export class BlobSizeError extends BlobError {
  constructor(message, { size, max } = {}) { super("blob-too-large", message); this.size = size; this.max = max; }
}
export class BlobExpiryError extends BlobError {
  constructor(message, expiry) { super("blob-expired", message); this.expiry = expiry; }
}
export class BlobNotFoundError extends BlobError {
  constructor(object) { super("blob-not-found", `blob object not found: ${object}`); this.object = object; }
}
export class BlobUploadError extends BlobError {
  constructor(message, cause = null) { super("blob-upload-failed", message); this.cause = cause; }
}
export class BlobFetchError extends BlobError {
  constructor(message, cause = null) { super("blob-fetch-failed", message); this.cause = cause; }
}
export class BlobIntegrityError extends BlobError {
  constructor(message) { super("blob-integrity-failed", message); }
}
export class BlobRefError extends BlobError {
  constructor(message) { super("blob-ref-invalid", message); }
}
/**
 * `code` is the broker's own code when it sent one; `legacyCode` is the
 * status-derived blob-broker-* code this client has always used (set on HTTP
 * refusals); `body` is the refusal body, numbers included.
 */
export class BlobBrokerError extends BlobError {
  constructor(code, message, status = null, { fix = null, legacyCode = null, body = null } = {}) {
    super(code, message, { fix });
    this.status = status;
    if (legacyCode) this.legacyCode = legacyCode;
    if (body) this.body = body;
  }
}
export class BlobSenderKeyError extends BlobError {
  constructor(message, sender, status) {
    super("sender-key-not-active", message, { fix: REFUSAL_FIXES["sender-key-not-active"] });
    this.sender = sender; this.status = status;
  }
}

// ------------------------------------------------------------- crypto -----
const HEX = { dek: 64, nonce: 24, hash: 64 }; // expected hex lengths

/**
 * Deterministic AAD: binds one ciphertext to exactly one envelope context.
 * Every field is mandatory — a missing binding is a refusal, not a default.
 */
export function blobAad({ envelopeId, sender, recipient, object, v, expiry }) {
  for (const [k, val] of Object.entries({ envelopeId, sender, recipient, object, expiry })) {
    if (typeof val !== "string" || !val) throw new BlobRefError(`blob AAD: field "${k}" required`);
  }
  if (!Number.isInteger(v)) throw new BlobRefError("blob AAD: field \"v\" required");
  return jcs({ envelopeId, sender, recipient, object, v, expiry });
}

/**
 * Encrypt plaintext under a fresh per-object AES-256-GCM DEK.
 * Returns Buffers { dek (32 B), nonce (12 B), ct, tag (16 B) }.
 */
export function encryptBlob(plaintext, ctx, { nonce = null } = {}) {
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const aad = blobAad(ctx);
  const dek = randomBytes(DEK_BYTES);
  const nv = nonce ?? randomBytes(NONCE_BYTES);
  if (nv.length !== NONCE_BYTES) throw new BlobRefError(`blob nonce must be ${NONCE_BYTES} bytes`);
  const cipher = createCipheriv("aes-256-gcm", dek, nv);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { dek, nonce: nv, ct, tag: cipher.getAuthTag() };
}

/**
 * Decrypt; throws BlobIntegrityError on ANY AAD/key/tag mismatch.
 * `secret` fields may be Buffers or hex strings.
 */
export function decryptBlob({ dek, nonce, ct, tag = null }, ctx) {
  const aad = blobAad(ctx);
  try {
    const stored = Buffer.from(ct, "hex");
    const ciphertext = tag == null ? stored.subarray(0, stored.length - 16) : stored;
    const authTag = tag == null ? stored.subarray(stored.length - 16) : Buffer.from(tag, "hex");
    if (authTag.length !== 16) throw new Error("ciphertext is missing the GCM tag");
    const d = createDecipheriv("aes-256-gcm", Buffer.from(dek, "hex"), Buffer.from(nonce, "hex"));
    d.setAAD(Buffer.from(aad, "utf-8"));
    d.setAuthTag(authTag);
    return Buffer.concat([d.update(ciphertext), d.final()]);
  } catch (e) {
    throw new BlobIntegrityError(`blob integrity check failed: ${e.message}`);
  }
}

export function contentHash(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Unguessable upload token for a blob object.  Deliberately NOT content-
 * addressed: the AAD must bind the object name before the ciphertext exists
 * (no derivation cycle), and a content digest in the store key would leak a
 * guessable plaintext's fingerprint to the store operator.
 */
export function mkObjectName() {
  return randomBytes(32).toString("hex");
}

// ------------------------------------------------------ self-certified ---
/**
 * The one UUAID a key self-certifies, rebuilt in full:
 * `uuaid:foundation:agent:` + sha256(publicKey)[:16] as a UUID (localIdFromKey,
 * the twin of pillar-client's localIdFromPublicKey). Null for a malformed key.
 */
export function selfCertifiedUuaidFor(publicKeyHex) {
  if (typeof publicKeyHex !== "string" || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return null;
  const localId = localIdFromKey(Buffer.from(publicKeyHex, "hex"));
  return `uuaid:${SELF_CERTIFIED_NAMESPACE}:${SELF_CERTIFIED_OBJECT_TYPE}:${localId}`;
}

/**
 * True only when `uuaid` is EXACTLY the UUAID the key self-certifies (full
 * string, namespace and object type included, the broker's rule); such an
 * identity uses the broker without a registry badge. A device, a service,
 * another namespace, or a matching local id under any other prefix is not
 * self-certified: it needs a registry badge naming its key.
 */
export function isSelfCertifiedUuaid(uuaid, publicKeyHex) {
  const expected = selfCertifiedUuaidFor(publicKeyHex);
  return expected !== null && uuaid === expected;
}

/**
 * Recipient sender gate, self-certified half: the ref's signature verifies
 * under `ref.sig.publicKey`, and `ref.sender` derives from that same key.
 * The sender field is inside the signed bytes, so the key that proves the
 * UUAID is the key whose signature was checked. Checked here rather than
 * trusted from an earlier validateBlobRef, so the gate stands on its own.
 */
export function senderSelfCertified(ref) {
  return verifyBlobRefSig(ref) && isSelfCertifiedUuaid(ref?.sender, ref?.sig?.publicKey);
}

// ------------------------------------------------------------------ refs ---
function refSignable(ref) {
  const { sig, ...rest } = ref;
  return jcs(rest);
}

/** Sign a blob-ref body with the loaded keychain (sender identity). */
export function signBlobRef(keychain, ref) {
  if (!keychain?._identity) throw new Error("signBlobRef: keychain not loaded");
  ref.sig = {
    alg: "ed25519",
    publicKey: keychain._identity.publicKeyHex,
    signature: keychain.sign(Buffer.from(refSignable(ref), "utf-8")).toString("hex"),
  };
  return ref;
}

export function verifyBlobRefSig(ref) {
  const sig = ref?.sig;
  if (!sig || sig.alg !== "ed25519") return false;
  if (!/^[0-9a-f]{64}$/i.test(sig.publicKey ?? "") || !/^[0-9a-f]{128}$/i.test(sig.signature ?? "")) return false;
  try {
    return Keychain.verifyDetached(sig.publicKey, Buffer.from(refSignable(ref), "utf-8"), Buffer.from(sig.signature, "hex"));
  } catch (_e) { return false; }
}

/**
 * Metadata view of a ref — safe for carrier-side logs/telemetry.
 * Deliberately drops DEK, nonce, object id, hash and signature. This view is
 * safe for counters only; the opaque capability never enters logs/telemetry.
 */
export function blobRefMetadata(ref) {
  return {
    v: ref.v,
    kind: ref.kind,
    size: ref.size,
    plaintextSize: ref.plaintextSize,
    expiry: ref.expiry,
    createdAt: ref.createdAt,
  };
}

/** Secret material of a ref — what only the sealed envelope may carry. */
export function blobRefSecret(ref) {
  return { dek: ref.dek, nonce: ref.nonce };
}

export function refSerializedBytes(ref) {
  return Buffer.byteLength(JSON.stringify(ref), "utf-8");
}

/**
 * Build + encrypt + sign a blob-ref for one plaintext payload.
 * Returns { ref, metadata, ct, ctx }.  Ref is rejected if it would
 * serialize above MAX_BLOB_REF_BYTES.
 */
export function makeBlobRef(keychain, { envelopeId, recipient, plaintext, ttlMs = DEFAULT_BLOB_TTL_MS, now = Date.now(), challengeId = null, objectId = null, broker = null }) {
  const sender = keychain._identity?.uuaid;
  if (!sender) throw new Error("makeBlobRef: keychain not loaded");
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const object = objectId ?? mkObjectName();
  const expiry = new Date(now + ttlMs).toISOString();
  const ctx = { envelopeId, sender, recipient, object, v: BLOB_REF_V, expiry };
  const { dek, nonce, ct, tag } = encryptBlob(buf, ctx);
  const stored = Buffer.concat([ct, tag]);
  // Hash covers every STORED byte, including the GCM tag — checkable before decrypt.
  const hash = contentHash(stored);
  const ref = {
    v: BLOB_REF_V,
    kind: BLOB_KIND,
    envelopeId,
    sender,
    recipient,
    object,
    hash,
    size: stored.length,
    plaintextSize: buf.length,
    dek: dek.toString("hex"),
    nonce: nonce.toString("hex"),
    ...(broker ? { broker } : {}),
    expiry,
    createdAt: new Date(now).toISOString(),
    ...(challengeId ? { challengeId } : {}),
  };
  signBlobRef(keychain, ref);
  const bytes = refSerializedBytes(ref);
  if (bytes > MAX_BLOB_REF_BYTES) {
    throw new BlobRefError(`blob-ref serializes to ${bytes}B > ${MAX_BLOB_REF_BYTES}B ceiling`);
  }
  return { ref, metadata: blobRefMetadata(ref), ct: stored, ctx };
}

/**
 * Structural + temporal validation of a received ref.  Throws typed errors.
 * `recipient` (when given) must match ref.recipient; `now` injectable for
 * tests.
 */
export function validateBlobRef(ref, { recipient = null, now = Date.now() } = {}) {
  if (!ref || typeof ref !== "object") throw new BlobRefError("blob-ref: not an object");
  if (ref.v !== BLOB_REF_V) throw new BlobRefError(`blob-ref: unsupported v ${ref.v}`);
  if (ref.kind !== BLOB_KIND) throw new BlobRefError(`blob-ref: unexpected kind ${ref.kind}`);
  for (const [k, len] of Object.entries(HEX)) {
    if (typeof ref[k] !== "string" || !new RegExp(`^[0-9a-f]{${len}}$`, "i").test(ref[k])) {
      throw new BlobRefError(`blob-ref: bad ${k}`);
    }
  }
  for (const k of ["envelopeId", "sender", "recipient", "object"]) {
    if (typeof ref[k] !== "string" || !ref[k]) throw new BlobRefError(`blob-ref: missing ${k}`);
  }
  if (!/^[0-9a-f]{64}$/.test(ref.object)) throw new BlobRefError("blob-ref: object must be a 256-bit opaque id");
  if (ref.broker !== undefined) {
    let broker;
    try { broker = new URL(ref.broker); } catch (_error) { throw new BlobRefError("blob-ref: invalid broker URL"); }
    if (broker.protocol !== "https:" && broker.hostname !== "127.0.0.1" && broker.hostname !== "localhost") {
      throw new BlobRefError("blob-ref: broker must use HTTPS");
    }
  }
  if (!Number.isInteger(ref.size) || ref.size <= 16 || ref.size > MAX_BLOB_OBJECT_BYTES) {
    throw new BlobRefError(`blob-ref: bad size ${ref.size}`);
  }
  if (!Number.isInteger(ref.plaintextSize) || ref.plaintextSize <= 0 || ref.plaintextSize !== ref.size - 16) {
    throw new BlobRefError(`blob-ref: bad plaintextSize ${ref.plaintextSize}`);
  }
  const exp = Date.parse(ref.expiry);
  if (!Number.isFinite(exp)) throw new BlobRefError("blob-ref: bad expiry");
  if (exp < now) throw new BlobExpiryError(`blob-ref expired at ${ref.expiry}`, ref.expiry);
  if (!verifyBlobRefSig(ref)) throw new BlobRefError("blob-ref: signature invalid");
  if (recipient && ref.recipient !== recipient) {
    throw new BlobRefError(`blob-ref: addressed to ${ref.recipient}, not ${recipient}`);
  }
  return true;
}

// ------------------------------------------------------- size decisions ----
export function envelopeBodyBytes(envelope) {
  return Buffer.byteLength(JSON.stringify(envelope), "utf-8");
}

/**
 * Exact preflight against the carrier limits — tier inline limit first,
 * then the 2 MiB direct hard cap, which no tier grant can raise.
 * Returns { ok, bytes, limit, source: "ok"|"tier"|"direct-cap" }.
 */
export function preflightBodyBytes(bodyBytes, { tier = "community", maxBodyBytes = null } = {}) {
  const tierLimit = maxBodyBytes ?? (TIER_DEFAULTS[tier]?.maxBodyBytes ?? TIER_DEFAULTS.community.maxBodyBytes);
  const bytes = Number.isInteger(bodyBytes) ? bodyBytes : -1;
  if (bytes > MAX_INLINE_BODY_BYTES) return { ok: false, bytes, limit: MAX_INLINE_BODY_BYTES, source: "direct-cap" };
  if (bytes > tierLimit) return { ok: false, bytes, limit: tierLimit, source: "tier" };
  return { ok: true, bytes, limit: Math.min(tierLimit, MAX_INLINE_BODY_BYTES), source: "ok" };
}

/** Inline-vs-blob decision for a payload of `dataBytes` plaintext. */
export function chooseTransport(dataBytes, { directThresholdBytes = DEFAULT_DIRECT_THRESHOLD_BYTES } = {}) {
  return dataBytes <= directThresholdBytes ? "inline" : "blob";
}

// ------------------------------------------------------------- flows -------
/**
 * SEND side (client half).  Order is deliberate:
 *   broker.reserve -> encrypt+sign ref -> store.put -> broker.finalize
 * An upload failure surfaces as BlobUploadError BEFORE finalize, so a
 * challenge is never finalized for an object that did not land.
 */
export async function prepareBlobSend(keychain, { data, envelopeId, recipient, ttlMs = DEFAULT_BLOB_TTL_MS, now = Date.now(), store, broker = null }) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length > MAX_BLOB_PLAINTEXT_BYTES) {
    throw new BlobSizeError(`blob payload ${buf.length}B exceeds the ${MAX_BLOB_PLAINTEXT_BYTES}B plaintext cap`, { size: buf.length, max: MAX_BLOB_PLAINTEXT_BYTES });
  }
  if (!store) throw new BlobError("no-store", "prepareBlobSend: a blob store is required");
  let challengeId = null;
  if (broker) {
    const reserved = await broker.reserve({ sender: keychain._identity.uuaid, recipient, size: buf.length + 16 });
    challengeId = reserved.challengeId;
  }
  const { ref, metadata, ct, ctx } = makeBlobRef(keychain, { envelopeId, recipient, plaintext: buf, ttlMs, now, challengeId });
  try {
    await store.put(ref.object, ct);
  } catch (e) {
    if (e instanceof BlobError) throw e;
    throw new BlobUploadError(`blob upload failed for ${ref.object}: ${e.message}`, e);
  }
  if (broker) await broker.finalize({ challengeId, object: ref.object, hash: ref.hash, size: ref.size });
  return { ref, metadata, ctx, size: buf.length, hash: ref.hash, object: ref.object };
}

/**
 * RECEIVE side.  Gate order: ref validation (sig/expiry/recipient) ->
 * sender key gate -> fetch -> content-hash check -> broker redemption
 * (single-use, only after every prior gate passed) -> decrypt -> size check.
 *
 * `senderKeyCheck(uuaid, pubkeyHex) => status` is the registry check for a
 * sender whose UUAID does NOT derive from the key that signed the ref. A
 * derived sender is proven by the verified ref signature alone (the same
 * rule its envelope was accepted on), so the check is not consulted for it.
 */
export async function fetchAndDecryptBlob({ ref, store, envelopeId, now = Date.now(), broker = null, senderKeyCheck = null }) {
  validateBlobRef(ref, { recipient: null, now });
  if (typeof ref.envelopeId === "string" && envelopeId && ref.envelopeId !== envelopeId) {
    throw new BlobRefError(`blob-ref bound to envelope ${ref.envelopeId}, received in ${envelopeId}`);
  }
  // Sender key gate — BEFORE any redemption burns. Only a non-derived sender
  // needs the registry to vouch for its key.
  const selfCertified = senderSelfCertified(ref);
  if (senderKeyCheck && !selfCertified) {
    const status = await senderKeyCheck(ref.sender, ref.sig?.publicKey);
    if (status !== "active") {
      throw new BlobSenderKeyError(`sender key for ${ref.sender} is ${status ?? "unknown"}, not active — refusing redemption`, ref.sender, status);
    }
  }
  let ct;
  try {
    ct = await store.get(ref.object);
  } catch (e) {
    if (e instanceof BlobError) throw e;
    throw new BlobFetchError(`blob fetch failed for ${ref.object}: ${e.message}`, e);
  }
  if (ct == null) throw new BlobNotFoundError(ref.object);
  if (contentHash(ct) !== ref.hash) {
    throw new BlobIntegrityError(`blob content hash mismatch for ${ref.object}`);
  }
  if (broker && ref.challengeId) await broker.redeem({ challengeId: ref.challengeId });
  const data = decryptBlob({ ...blobRefSecret(ref), ct: Buffer.from(ct).toString("hex") }, {
    envelopeId: ref.envelopeId, sender: ref.sender, recipient: ref.recipient,
    object: ref.object, v: ref.v, expiry: ref.expiry,
  });
  if (data.length !== ref.plaintextSize) {
    throw new BlobIntegrityError(`blob size mismatch: decrypted ${data.length}B, ref says ${ref.plaintextSize}B`);
  }
  return {
    data, object: ref.object, hash: ref.hash, size: ref.size,
    sender: ref.sender, senderProof: selfCertified ? "self-certified" : senderKeyCheck ? "sender-key-check" : "unchecked",
  };
}

/** Production send path through the recipient-authenticated UUAID HTTP broker. */
export async function prepareBrokerBlobSend(keychain, { data, envelopeId, recipient, ttlMs = DEFAULT_BLOB_TTL_MS, now = Date.now(), client }) {
  if (!client) throw new BlobError("no-broker-client", "prepareBrokerBlobSend: broker client required");
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length > MAX_BLOB_PLAINTEXT_BYTES) {
    throw new BlobSizeError(`blob payload ${buf.length}B exceeds the ${MAX_BLOB_PLAINTEXT_BYTES}B plaintext cap`, { size: buf.length, max: MAX_BLOB_PLAINTEXT_BYTES });
  }
  const challenge = await client.challenge("reserve");
  const prepared = makeBlobRef(keychain, {
    envelopeId,
    recipient,
    plaintext: buf,
    ttlMs,
    now,
    objectId: challenge.object_id,
    broker: client.baseUrl,
  });
  const reserved = await client.reserve(challenge, {
    recipient,
    ciphertextSha256: prepared.ref.hash,
    ciphertextBytes: prepared.ref.size,
    expiresAt: prepared.ref.expiry,
  });
  if (reserved.object_id !== prepared.ref.object || reserved.expires_at !== prepared.ref.expiry) {
    throw new BlobIntegrityError("broker reservation does not match the prepared blob-ref");
  }
  await client.upload(reserved.upload, prepared.ct);
  const finalized = await client.finalize(prepared.ref.object);
  client.crossCheckRedemption(prepared.ref, finalized.blob_ref);
  return { ...prepared, size: buf.length, hash: prepared.ref.hash, object: prepared.ref.object };
}

/**
 * Production receive path; the sender key gate precedes broker redemption.
 * A sender whose UUAID is exactly the uuaid:foundation:agent UUAID of the
 * ref's verified signing key passes without a badge; any other sender needs
 * a fresh registry badge naming that key (client.assertRegistryActiveSender).
 *
 * The result names the sender and how it was proven (`senderProof`):
 * "self-certified" means the key holder is proven but the identity is
 * UNVERIFIED (no registry name or badge applies; show the UUAID only);
 * "registry-badge" means a fresh registry badge names the signing key.
 */
export async function fetchBrokerBlob({ ref, envelopeId, recipient, now = Date.now(), client }) {
  if (!client) throw new BlobError("no-broker-client", "fetchBrokerBlob: broker client required");
  validateBlobRef(ref, { recipient, now });
  if (ref.envelopeId !== envelopeId) throw new BlobRefError("blob-ref envelope binding mismatch");
  if (ref.broker !== client.baseUrl) throw new BlobRefError("blob-ref broker binding mismatch");
  const selfCertified = senderSelfCertified(ref);
  if (!selfCertified) await client.assertRegistryActiveSender(ref.sender, ref.sig?.publicKey);
  const redeemed = await client.redeem(ref.object);
  client.crossCheckRedemption(ref, redeemed.blob);
  const stored = await client.download(redeemed.download);
  if (stored.length !== ref.size) throw new BlobIntegrityError(`blob ciphertext size mismatch: ${stored.length}B != ${ref.size}B`);
  if (contentHash(stored) !== ref.hash) throw new BlobIntegrityError("blob ciphertext hash mismatch");
  const data = decryptBlob({ ...blobRefSecret(ref), ct: stored.toString("hex") }, {
    envelopeId: ref.envelopeId,
    sender: ref.sender,
    recipient: ref.recipient,
    object: ref.object,
    v: ref.v,
    expiry: ref.expiry,
  });
  if (data.length !== ref.plaintextSize) {
    throw new BlobIntegrityError(`blob plaintext size mismatch: ${data.length}B != ${ref.plaintextSize}B`);
  }
  return {
    data, object: ref.object, hash: ref.hash, size: ref.plaintextSize,
    sender: ref.sender, senderProof: selfCertified ? "self-certified" : "registry-badge",
  };
}
