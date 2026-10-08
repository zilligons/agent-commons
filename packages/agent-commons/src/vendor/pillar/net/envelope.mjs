/**
 * Envelope v2 — the wire format for pillar-to-pillar messages.
 *
 * ENCRYPTION IS FUNDAMENTAL.  There is no plaintext payload mode.  Every
 * envelope's payload is sealed to the recipient's key before the envelope
 * is signed.  Anyone can VERIFY an envelope (transport signature is public);
 * only the recipient can READ it.
 *
 * Envelope v2 = {
 *   version:   "uuaid-pillar-envelope/2",
 *   id:        "env-...",
 *   sender:    "uuaid:...",
 *   recipient: "uuaid:...",
 *   kind:      "message" | "work-order" | ...   (routing hint, NOT secret)
 *   createdAt: ISO 8601,
 *   enc: { alg: "x25519-hkdf-sha256-aes256gcm", epk, iv, ct },   // sealed payload
 *   transportSignature: { alg: "ed25519", keyId, publicKey, signature, created },
 * }
 *
 * The transport signature covers everything (including the ciphertext), so
 * tamper detection works WITHOUT decrypting — carriers verify-then-store.
 * The GCM AAD binds the ciphertext to the envelope id, so a valid ciphertext
 * cannot be transplanted into a different envelope even by the sender.
 *
 * seal() enforces identity binding: recipient UUAID local-id must equal
 * sha256(recipientPublicKey) — you cannot encrypt to a key that doesn't own
 * the UUAID you're addressing.
 */
import { createHash, randomBytes } from "node:crypto";
import { jcs } from "../identity/jcs.mjs";
import { Keychain, isStrictEd25519PublicKey } from "../identity/keychain.mjs";
import { sealPayload, openPayload, E2E_ALG } from "../crypto/e2e.mjs";
import { verifyDelegationDoc, delegationCoversKind, CAPABILITY_ONLY_KINDS } from "./delegation.mjs";

export const ENVELOPE_VERSION = "uuaid-pillar-envelope/2";
export { E2E_ALG };

/**
 * Build, encrypt, and sign an envelope.
 *
 * keychain: a loaded Keychain (has .sign()).
 * body: {
 *   recipient:           "uuaid:..."          REQUIRED
 *   recipientPublicKey:  ed25519 pubkey hex   REQUIRED (E2E is not optional)
 *   kind, payload, id, createdAt              optional
 * }
 */
export function seal(keychain, body) {
  const identity = keychain._identity;
  if (!identity) throw new Error("keychain not loaded");
  const sender = body.sender ?? identity.uuaid;
  if (sender !== identity.uuaid) {
    throw new Error(`envelope.sender ${sender} does not match keychain identity ${identity.uuaid}`);
  }
  if (!body.recipient || typeof body.recipient !== "string") {
    throw new Error("seal: recipient required");
  }
  if (!body.recipientPublicKey || !/^[0-9a-f]{64}$/i.test(body.recipientPublicKey)) {
    throw new Error("seal: recipientPublicKey (ed25519 hex) is REQUIRED — encryption is not optional");
  }
  // Identity binding: the key must own the UUAID.
  const expectedLocalId = Keychain._localIdFromKey(Buffer.from(body.recipientPublicKey, "hex"));
  const recipientLocalId = body.recipient.split(":")[3];
  if (recipientLocalId !== expectedLocalId) {
    throw new Error(`seal: recipientPublicKey does not derive recipient UUAID (key owns ...${expectedLocalId.slice(0, 13)}, envelope addressed to ...${String(recipientLocalId).slice(0, 13)})`);
  }

  const id = body.id ?? mkEnvelopeId();
  const enc = sealPayload(body.recipientPublicKey, body.payload ?? {}, { aad: id });

  const envelope = {
    version: ENVELOPE_VERSION,
    id,
    sender,
    recipient: body.recipient,
    kind: body.kind ?? "message",
    enc,
    createdAt: body.createdAt ?? new Date().toISOString(),
  };
  const canonical = jcs(envelope);
  const sigBytes = keychain.sign(Buffer.from(canonical, "utf-8"));
  envelope.transportSignature = {
    alg: "ed25519",
    keyId: identity.uuaid,
    publicKey: identity.publicKeyHex,
    signature: sigBytes.toString("hex"),
    created: envelope.createdAt,
  };
  return envelope;
}

/**
 * Verify an envelope's transport signature and structure.  Does NOT decrypt.
 * Anyone (carriers, relays, auditors) can call this.
 * Returns { ok: true } or { ok: false, reason }.
 *
 * DELEGATED ENVELOPES (UACP/1.0 ext): when the optional `delegation` field is
 * present, the self-authenticating-sender rule is replaced by the delegation
 * chain — see openDelegated() below and src/net/delegation.mjs.  When the
 * field is ABSENT the checks below are byte-for-byte the legacy behavior.
 */
export function open(envelope, { cryptoInventory } = {}) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ok: false, reason: "not-object" };
  if (envelope.version !== ENVELOPE_VERSION) return { ok: false, reason: `bad-version ${envelope.version}` };
  const sig = envelope.transportSignature;
  if (!sig || typeof sig !== "object" || sig.alg !== "ed25519") return { ok: false, reason: "missing-or-bad-alg" };
  if (cryptoInventory && cryptoInventory[sig.alg] !== "active") {
    return { ok: false, reason: `alg-not-active:${sig.alg}` };
  }
  if (envelope.delegation !== undefined) {
    return openDelegated(envelope, { cryptoInventory });
  }
  if (sig.keyId !== envelope.sender) return { ok: false, reason: "keyId-sender-mismatch" };
  if (typeof sig.publicKey !== "string" || !/^[0-9a-f]{64}$/i.test(sig.publicKey)) return { ok: false, reason: "bad-publicKey" };
  if (!isStrictEd25519PublicKey(sig.publicKey)) return { ok: false, reason: "weak-publicKey" }; // @rule envelope.open-strict-key
  if (typeof sig.signature !== "string" || !/^[0-9a-f]{128}$/i.test(sig.signature)) return { ok: false, reason: "bad-signature-encoding" };
  // Structural checks on the encryption block — an envelope without one is invalid.
  const enc = envelope.enc;
  if (!enc || typeof enc !== "object") return { ok: false, reason: "missing-enc" };
  if (enc.alg !== E2E_ALG) return { ok: false, reason: `enc-alg-not-supported:${enc.alg}` };
  if (cryptoInventory && cryptoInventory[enc.alg] && cryptoInventory[enc.alg] !== "active") {
    return { ok: false, reason: `enc-alg-not-active:${enc.alg}` };
  }
  if (typeof enc.epk !== "string" || !/^[0-9a-f]{64}$/i.test(enc.epk)) return { ok: false, reason: "bad-epk" };
  if (typeof enc.iv !== "string" || !/^[0-9a-f]{24}$/i.test(enc.iv)) return { ok: false, reason: "bad-iv" };
  if (typeof enc.ct !== "string" || !/^[0-9a-f]{32,}$/i.test(enc.ct)) return { ok: false, reason: "bad-ct" };
  // Verify the signature over the envelope WITHOUT the signature block.
  const { transportSignature: _sig, ...withoutSig } = envelope;
  let canonical;
  try { canonical = jcs(withoutSig); } catch (_e) { return { ok: false, reason: "bad-canonical" }; }
  let okSig;
  try {
    okSig = Keychain.verifyDetached(sig.publicKey, Buffer.from(canonical, "utf-8"), Buffer.from(sig.signature, "hex"));
  } catch (_e) {
    return { ok: false, reason: "verify-threw" };
  }
  if (!okSig) return { ok: false, reason: "bad-signature" };
  // Sender binding (self-authenticating identity): the sender UUAID's
  // local-id MUST derive from the signing key — the sender-side mirror of
  // seal()'s recipient binding.  Without this, anyone can sign an envelope
  // with their own key while claiming another agent's sender UUAID.
  const expectedSenderLocalId = Keychain._localIdFromKey(Buffer.from(sig.publicKey, "hex"));
  if (expectedSenderLocalId !== String(envelope.sender).split(":")[3]) {
    return { ok: false, reason: "publicKey-sender-mismatch" };
  }
  return { ok: true };
}

/**
 * Delegated path of open() — UACP/1.0 extension.  Invoked when the envelope
 * carries a `delegation` document; the legacy self-authenticating-sender rule
 * is REPLACED by the five delegation checks (see delegation.mjs):
 *
 *   (a) envelope signature valid under the DELEGATE's key,
 *       transportSignature.keyId === delegation.delegate;
 *   (b) delegation document signature valid under the PRINCIPAL's key,
 *       delegation.principal === envelope.sender,
 *       delegation.delegate === the signing key's uuaid;
 *   (c) local-id binding for BOTH identities (inside verifyDelegationDoc);
 *   (d) now within [notBefore, notAfter] (inside verifyDelegationDoc);
 *   (e) envelope.kind covered by delegation.kinds.
 *
 * Fail-open is not an option: any failure rejects with
 * { ok: false, reason: "delegation-invalid:<reason>", code: 403 }.  Pure
 * wire-format failures (enc block, hex encodings) keep the legacy reasons and
 * 400 status — they are not delegation verdicts.
 *
 * The `delegation` field is part of the SIGNED body (sealed inside the
 * canonicalization by the delegate), so a carrier cannot strip or swap it
 * without breaking the envelope signature.
 */
function openDelegated(envelope, { cryptoInventory } = {}) {
  const reject = (reason) => ({ ok: false, reason: `delegation-invalid:${reason}`, code: 403 });
  const sig = envelope.transportSignature;
  if (typeof sig.publicKey !== "string" || !/^[0-9a-f]{64}$/i.test(sig.publicKey)) return { ok: false, reason: "bad-publicKey" };
  if (!isStrictEd25519PublicKey(sig.publicKey)) return { ok: false, reason: "weak-publicKey" }; // @rule envelope.open-delegated-strict-key
  if (typeof sig.signature !== "string" || !/^[0-9a-f]{128}$/i.test(sig.signature)) return { ok: false, reason: "bad-signature-encoding" };
  // Structural checks on the encryption block — same rules as the legacy path.
  const enc = envelope.enc;
  if (!enc || typeof enc !== "object") return { ok: false, reason: "missing-enc" };
  if (enc.alg !== E2E_ALG) return { ok: false, reason: `enc-alg-not-supported:${enc.alg}` };
  if (cryptoInventory && cryptoInventory[enc.alg] && cryptoInventory[enc.alg] !== "active") {
    return { ok: false, reason: `enc-alg-not-active:${enc.alg}` };
  }
  if (typeof enc.epk !== "string" || !/^[0-9a-f]{64}$/i.test(enc.epk)) return { ok: false, reason: "bad-epk" };
  if (typeof enc.iv !== "string" || !/^[0-9a-f]{24}$/i.test(enc.iv)) return { ok: false, reason: "bad-iv" };
  if (typeof enc.ct !== "string" || !/^[0-9a-f]{32,}$/i.test(enc.ct)) return { ok: false, reason: "bad-ct" };

  const d = envelope.delegation;
  // (b-i) + (c) + (d): the delegation document itself — shape, both local-id
  // bindings, time window, and the principal's signature over it.
  const dv = verifyDelegationDoc(d);
  if (!dv.ok) return reject(dv.reason);
  // (b-ii) the persona this envelope acts as must be the delegation principal.
  if (d.principal !== envelope.sender) return reject("sender-not-principal");
  // (b-iii) the actual signer must be the named delegate, key and all.
  if (sig.keyId !== d.delegate) return reject("signer-not-delegate");
  if (sig.publicKey !== d.delegatePublicKey) return reject("signer-key-mismatch");
  // (e) the delegation must cover this envelope kind.
  //
  // A capability name is checked FIRST and unconditionally — including under
  // kinds:["*"] — because these names are not envelope kinds at all. Without
  // this, a read-only kinds:["inbox"] poll token doubles as authority to send
  // envelopes of kind "inbox" as the principal. See CAPABILITY_ONLY_KINDS.
  if (CAPABILITY_ONLY_KINDS.has(envelope.kind)) return reject("kind-reserved-capability");
  if (!delegationCoversKind(d, envelope.kind)) return reject("kind-not-covered");
  // (a) the envelope signature under the delegate key, over the canonical
  // body INCLUDING the delegation field (exactly what the delegate signed).
  const { transportSignature: _sig, ...withoutSig } = envelope;
  let canonical;
  try { canonical = jcs(withoutSig); } catch (_e) { return { ok: false, reason: "bad-canonical" }; }
  let okSig;
  try {
    okSig = Keychain.verifyDetached(sig.publicKey, Buffer.from(canonical, "utf-8"), Buffer.from(sig.signature, "hex"));
  } catch (_e) {
    return { ok: false, reason: "verify-threw" };
  }
  if (!okSig) return reject("bad-envelope-signature");
  return { ok: true, delegated: true, actingFor: d.principal };
}

/**
 * Decrypt an envelope's payload.  Only the recipient can do this.
 * keychain must be the recipient's loaded keychain.
 * Throws on wrong recipient, wrong key, tamper, or AAD mismatch.
 */
export function decrypt(keychain, envelope) {
  const identity = keychain._identity;
  if (!identity) throw new Error("decrypt: keychain not loaded");
  if (envelope.recipient !== identity.uuaid) {
    throw new Error(`decrypt: envelope addressed to ${envelope.recipient}, not us (${identity.uuaid})`);
  }
  const seed = keychainSeed(keychain);
  return openPayload(seed, envelope.enc, { aad: envelope.id });
}

/** Extract the 32-byte Ed25519 seed from a loaded keychain. */
export function keychainSeed(keychain) {
  const der = keychain._identity.privateKey.export({ type: "pkcs8", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

/**
 * Envelope id: 16 random bytes hex + a small timestamp prefix for
 * human-readable sort.  Not sensitive; not secret.  Used as GCM AAD.
 */
export function mkEnvelopeId() {
  const now = Date.now().toString(36);
  const rnd = randomBytes(8).toString("hex");
  return `env-${now}-${rnd}`;
}

/**
 * Content-hash of an envelope, computable by anyone.
 */
export function envelopeSha(envelope) {
  return createHash("sha256").update(jcs(envelope)).digest("hex");
}
