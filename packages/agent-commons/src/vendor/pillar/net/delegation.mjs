/**
 * Device/persona delegation — UACP/1.0 protocol extension (carrier side).
 *
 * A long-lived "persona" UUAID (the principal) authorizes a short-lived
 * device identity (the delegate) to act on its behalf for specific envelope
 * kinds and a bounded time window.  The persona signs a JCS-canonical
 * delegation document; the device embeds that document in the envelope's
 * `delegation` field and signs the whole envelope with ITS OWN key.
 *
 *   delegation = {
 *     version:   "uuaid-delegation/1",
 *     id:        "del-...",
 *     principal: persona uuaid,   principalPublicKey: hex,
 *     delegate:  device  uuaid,   delegatePublicKey:  hex,
 *     kinds:     ["*"] or ["request","reply",...],
 *     notBefore, notAfter: ISO 8601,
 *     signature: { alg: "ed25519", publicKey, signature },
 *   }
 *   signature = ed25519(JCS(delegation minus .signature), principalSeed)
 *
 * Wire-compatible with @uuaid/pillar-client's delegation.ts (mintDelegation /
 * verifyDelegation / sealWithDelegation / verifyDelegatedEnvelope): same
 * document shape, same JCS canonicalization, same rejection reason strings,
 * so a carrier and a pillar-client peer reach the same verdict on the same
 * bytes.
 *
 * Envelope acceptance rules (envelope.mjs open() branches here when the
 * optional `delegation` field is present; absent -> legacy behavior,
 * unchanged):
 *   (a) envelope transport signature valid under the DELEGATE's pubkey and
 *       transportSignature.keyId === delegate uuaid;
 *   (b) delegation document signature valid under the PRINCIPAL's pubkey,
 *       principal === envelope.sender, delegate === signing key's uuaid;
 *   (c) local-id binding for BOTH identities:
 *       sha256(pubkey)[:16] (UUID-dash formatted) === uuaid local-id;
 *   (d) now within [notBefore, notAfter];
 *   (e) envelope.kind covered by the delegation `kinds` allowlist
 *       ("*" covers everything), and not a capability-only name such as
 *       "inbox" — those are poll capabilities, never deliverable kinds, and
 *       are refused even under "*" (see CAPABILITY_ONLY_KINDS).
 * All five must pass; any failure rejects with
 * `delegation-invalid:<reason>` (HTTP 403 at the carrier).
 *
 * Storage/mailbox attribution is unchanged: the envelope's `sender` IS the
 * principal, so carriers key mailboxes, rate limits, and audits to the
 * principal UUAID exactly as before.
 */
import { randomBytes } from "node:crypto";
import { jcs } from "../identity/jcs.mjs";
import { Keychain } from "../identity/keychain.mjs";

export const DELEGATION_VERSION = "uuaid-delegation/1";

/**
 * Mint a delegation document, signed by the PRINCIPAL keychain.
 *
 * The counterpart to verifyDelegationDoc below, and the .mjs twin of
 * pillar-client's mintDelegation (delegation.ts): same field order, same
 * id shape, same JCS canonicalization, same signature placement — so a
 * document minted here verifies byte-identically in a browser, and vice
 * versa. A divergence in either direction is a wire break, not a style
 * difference.
 *
 * Nothing here knows what KIND of principal is signing. A phone, a CLI and
 * a daemon mint the same bytes; the only requirement is custody of the
 * persona seed. That is what lets a headless agent link a browser.
 *
 * CALLER BEWARE — ttlDays defaults to 90 to match pillar-client, but the
 * desktop-link path enforces a 7-day ceiling of its own (D14, chat-web's
 * withinLinkTtl) and DROPS a longer grant in silence. Pass ttlDays <= 7 for
 * a browser link; see bin/pillar.mjs cmdDelegate, which refuses rather than
 * let that failure be invisible.
 */
export function mintDelegationDoc(keychain, opts = {}) {
  const principal = keychain?._identity;
  if (!principal?.publicKeyHex) throw new Error("mintDelegationDoc: principal identity not loaded");
  const { delegate, delegatePublicKey } = opts;
  if (typeof delegate !== "string" || !delegate.startsWith("uuaid:")) {
    throw new Error("mintDelegationDoc: delegate uuaid required");
  }
  if (typeof delegatePublicKey !== "string" || !/^[0-9a-f]{64}$/i.test(delegatePublicKey)) {
    throw new Error("mintDelegationDoc: delegatePublicKey must be 64 hex");
  }
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? [...opts.kinds] : ["*"];
  const start = opts.notBefore instanceof Date ? opts.notBefore : new Date();
  const ttlDays = Number.isFinite(opts.ttlDays) ? opts.ttlDays : 90;
  const end = new Date(start.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const unsigned = {
    version: DELEGATION_VERSION,
    id: `del-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`,
    principal: principal.uuaid,
    principalPublicKey: principal.publicKeyHex,
    delegate,
    delegatePublicKey: delegatePublicKey.toLowerCase(),
    kinds,
    notBefore: start.toISOString(),
    notAfter: end.toISOString(),
  };
  const signature = keychain.sign(jcs(unsigned));
  return {
    ...unsigned,
    signature: {
      alg: "ed25519",
      publicKey: principal.publicKeyHex,
      signature: Buffer.from(signature).toString("hex"),
    },
  };
}

/**
 * Extract the local-id of a UUAID with pillar-client parseUuaid semantics:
 * exactly four colon-separated segments with the "uuaid" prefix.
 * Returns null for anything else (never throws).
 */
export function uuaidLocalId(uuaid) {
  if (typeof uuaid !== "string") return null;
  const parts = uuaid.split(":");
  if (parts.length !== 4 || parts[0] !== "uuaid") return null;
  return parts[3];
}

/** Self-authenticating identity check: sha256(pubkey)[:16] === uuaid local-id. */
export function uuaidBindingOk(uuaid, publicKeyHex) {
  const localId = uuaidLocalId(uuaid);
  if (localId === null) return false;
  if (typeof publicKeyHex !== "string" || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  return Keychain.localIdFromKey(Buffer.from(publicKeyHex, "hex")) === localId;
}

/**
 * Verify a delegation document on its own: shape, identity bindings, time
 * window, and the principal's signature over JCS(doc minus .signature).
 *
 * Reason strings intentionally mirror @uuaid/pillar-client verifyDelegation
 * so tooling sees identical diagnostics on both implementations.
 *
 * Returns { ok: true } or { ok: false, reason }.
 */
export function verifyDelegationDoc(d, now = new Date()) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, reason: "not-object" };
  if (d.version !== DELEGATION_VERSION) return { ok: false, reason: `bad-version:${d.version}` };
  if (!/^[0-9a-f]{64}$/i.test(d.principalPublicKey ?? "")) return { ok: false, reason: "bad-principal-pubkey" };
  if (!/^[0-9a-f]{64}$/i.test(d.delegatePublicKey ?? "")) return { ok: false, reason: "bad-delegate-pubkey" };
  if (!uuaidBindingOk(d.principal, d.principalPublicKey)) {
    return { ok: false, reason: "principal-uuaid-binding" };
  }
  if (!uuaidBindingOk(d.delegate, d.delegatePublicKey)) {
    return { ok: false, reason: "delegate-uuaid-binding" };
  }
  if (!Array.isArray(d.kinds) || d.kinds.length === 0 || d.kinds.some(k => typeof k !== "string")) {
    return { ok: false, reason: "bad-kinds" };
  }
  const nb = Date.parse(d.notBefore);
  const na = Date.parse(d.notAfter);
  if (Number.isNaN(nb) || Number.isNaN(na)) return { ok: false, reason: "bad-time" };
  if (na <= nb) return { ok: false, reason: "empty-window" };
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (t < nb) return { ok: false, reason: "not-yet-valid" };
  if (t > na) return { ok: false, reason: "expired" };

  const sig = d.signature;
  if (!sig || sig.alg !== "ed25519" || sig.publicKey !== d.principalPublicKey) {
    return { ok: false, reason: "bad-signature-shape" };
  }
  if (typeof sig.signature !== "string" || !/^[0-9a-f]{128}$/i.test(sig.signature)) {
    return { ok: false, reason: "bad-signature-shape" };
  }
  // The signature covers JCS of everything except .signature.
  const { signature: _drop, ...unsigned } = d;
  let canonical;
  try { canonical = jcs(unsigned); } catch (_e) { return { ok: false, reason: "bad-canonical" }; }
  let okSig = false;
  try {
    okSig = Keychain.verifyDetached(sig.publicKey, Buffer.from(canonical, "utf-8"), Buffer.from(sig.signature, "hex"));
  } catch (_e) {
    return { ok: false, reason: "verify-threw" };
  }
  if (!okSig) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

/**
 * Names that may appear in a delegation's `kinds` as CAPABILITIES but are not
 * envelope kinds, and so must never be deliverable.
 *
 * `kinds` is a single namespace answering two different questions: "may this
 * delegate SEND envelopes of kind K" (envelope.mjs) and "may this delegate
 * POLL the principal's inbox" (carrier-server.mjs, capability "inbox"). The
 * overlap means a token minted read-only as `kinds: ["inbox"]` also satisfies
 * the send check for an envelope whose `kind` is literally "inbox" — verified
 * against a live alpha.15 carrier, which returned 202 for exactly that forgery
 * while correctly returning 403 kind-not-covered for message/request/reply.
 *
 * Nothing consumes `kind: "inbox"`, so this is latent rather than live. It
 * stops being latent the moment a read-only poll token is issued to anyone,
 * which is what the push relay is being rebuilt to use.
 *
 * Enforced on the send path in envelope.mjs. Deliberately NOT enforced inside
 * delegationCoversKind: that helper serves both questions, and the capability
 * lookup in carrier-server.mjs depends on "inbox" matching there.
 */
export const CAPABILITY_ONLY_KINDS = new Set(["inbox"]);

/** Does this delegation cover envelopes of `kind`?  "*" covers all. */
export function delegationCoversKind(d, kind) {
  if (!Array.isArray(d?.kinds)) return false;
  if (d.kinds.includes("*")) return true;
  return d.kinds.includes(kind);
}
