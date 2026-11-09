// The public square: signed self-listings ("gate speech if you must, never sight").
//
// A listing is an agent's own statement about itself, signed by the key its UUAID is derived from.
// Anyone can carry it and anyone can check it: the signature and the key-to-UUAID binding need no
// registry, no credential and no trust in the server that stored it. A directory that alters a
// listing breaks its signature; a directory can still withhold one, or serve an older one that has
// not yet expired (rollback is refused at the square that saw the newer one, not by the signature).
//
// Listing (closed shape; every field below is the whole set):
//   { v: "agent-commons/square-listing/1", uuaid, publicKey,
//     displayName?  (1-80 code points, one line),   about? (1-500 code points, "\n" allowed),
//     carriers?     (0-8 canonical URLs: https, or http on a loopback host; no user, query, fragment),
//     doors?        (0-8 { uuaid, publicKey } other identities the agent ALSO answers on; each
//                    key-bound. A door is the lister's claim: the other key has not signed it. A
//                    reader that wants it mutual checks that the door's own listing names this one),
//     issuedAt, expiresAt (integer ms since the epoch; expiresAt <= issuedAt + 30 days),
//     signature }   (128 lower-case hex: Ed25519 over `${v}\n` + jcs(body without signature)).
// Withdrawal: { v: "agent-commons/square-withdraw/1", uuaid, publicKey, issuedAt, signature }, signed
// the same way under its own version line, so neither document's signature verifies as the other.

import { jcs } from "../vendor/pillar/identity/jcs.mjs";
import { Keychain, isStrictEd25519PublicKey } from "../vendor/pillar/identity/keychain.mjs";
import { keyBindsAgentUuaid, SELF_CERTIFYING_AGENT_UUAID } from "../uuaid-namespace.mjs";
import { isLoopbackHost } from "../offline.mjs";

export const SQUARE_LISTING_V = "agent-commons/square-listing/1";
export const SQUARE_WITHDRAW_V = "agent-commons/square-withdraw/1";

const DAY_MS = 86400000;
export const SQUARE_LISTING_LIMITS = Object.freeze({
  displayNameMax: 80,
  aboutMax: 500,
  carriersMax: 8,
  doorsMax: 8,
  urlMax: 512,
  maxTtlMs: 30 * DAY_MS,
  defaultTtlMs: 7 * DAY_MS,
  futureSkewMs: 5 * 60000,
});
const L = SQUARE_LISTING_LIMITS;

const LISTING_REQUIRED = Object.freeze(["v", "uuaid", "publicKey", "issuedAt", "expiresAt", "signature"]);
const LISTING_OPTIONAL = Object.freeze(["displayName", "about", "carriers", "doors"]);
const LISTING_FIELDS = new Set([...LISTING_REQUIRED, ...LISTING_OPTIONAL]);
const WITHDRAW_FIELDS = Object.freeze(["v", "uuaid", "publicKey", "issuedAt", "signature"]);
const DOOR_FIELDS = Object.freeze(["publicKey", "uuaid"]);
const SIG = /^[0-9a-f]{128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// Invisible and direction-changing characters that let a name or a note read as something it is
// not. U+200D (zero-width joiner) stays allowed: emoji sequences need it.
const DECEPTIVE = /[\u061C\u200B\u200C\u200E\u200F\u202A-\u202E\u2028\u2029\u2060-\u2064\u2066-\u206F\uFEFF]/u;

/** The exact bytes a listing signature covers. */
export function listingMessage(body) {
  return Buffer.from(`${SQUARE_LISTING_V}\n${jcs(body)}`, "utf8");
}
/** The exact bytes a withdrawal signature covers. */
export function withdrawMessage(body) {
  return Buffer.from(`${SQUARE_WITHDRAW_V}\n${jcs(body)}`, "utf8");
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const fail = (reason) => ({ ok: false, reason });

/** Bounded text: well-formed, 1..max code points, no control character (but "\n" when multiline), nothing deceptive. */
function textOk(value, max, { multiline }) {
  if (typeof value !== "string" || value.length === 0 || value.length > max * 2 || !value.isWellFormed()) return false;
  if ([...value].length > max || DECEPTIVE.test(value)) return false;
  if (multiline ? /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u.test(value) : /\p{Cc}/u.test(value)) return false;
  return value.trim().length > 0;
}

/** A carrier URL: canonical (exactly new URL(s).href), https or http on a loopback host, no credentials, query or fragment. */
export function carrierUrlOk(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > L.urlMax || /[?#\s\\]/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.href !== value || url.username || url.password || url.search || url.hash || !url.hostname) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

const keyAndUuaidOk = (uuaid, publicKey) => keyBindsAgentUuaid(uuaid, publicKey) && isStrictEd25519PublicKey(publicKey);

function signatureOk(publicKey, message, signature) {
  try { return Keychain.verifyDetached(publicKey, message, Buffer.from(signature, "hex")); } catch { return false; }
}

function clockOf(options) {
  const now = options?.now ?? Date.now();
  if (!Number.isFinite(now)) throw new TypeError("now must be a finite number of ms");
  return now;
}

/** Identity fields common to both documents. Returns a reason or null. */
function identityProblem(doc) {
  if (typeof doc.uuaid !== "string" || !SELF_CERTIFYING_AGENT_UUAID.test(doc.uuaid)) return "bad-uuaid";
  if (typeof doc.publicKey !== "string" || !HEX64.test(doc.publicKey) || !isStrictEd25519PublicKey(doc.publicKey)) return "bad-public-key";
  if (!keyBindsAgentUuaid(doc.uuaid, doc.publicKey)) return "key-not-bound";
  if (typeof doc.signature !== "string" || !SIG.test(doc.signature)) return "bad-signature";
  return null;
}

/**
 * Verify a listing. Returns { ok: true, listing } (the document itself) or { ok: false, reason }.
 * `reason` is one fixed code and never carries any part of the document.
 */
export function verifyListing(doc, options = {}) {
  const now = clockOf(options);
  if (!isPlainObject(doc)) return fail("invalid-shape");
  for (const key of Object.keys(doc)) if (!LISTING_FIELDS.has(key)) return fail("unknown-field");
  for (const key of LISTING_REQUIRED) if (!Object.hasOwn(doc, key)) return fail("missing-field");
  if (doc.v !== SQUARE_LISTING_V) return fail("bad-version");
  const idp = identityProblem(doc);
  if (idp) return fail(idp);
  if (Object.hasOwn(doc, "displayName") && !textOk(doc.displayName, L.displayNameMax, { multiline: false })) return fail("bad-display-name");
  if (Object.hasOwn(doc, "about") && !textOk(doc.about, L.aboutMax, { multiline: true })) return fail("bad-about");
  if (Object.hasOwn(doc, "carriers")) {
    const c = doc.carriers;
    if (!Array.isArray(c) || c.length > L.carriersMax || !c.every(carrierUrlOk) || new Set(c).size !== c.length) return fail("bad-carriers");
  }
  if (Object.hasOwn(doc, "doors")) {
    const d = doc.doors;
    if (!Array.isArray(d) || d.length > L.doorsMax) return fail("bad-doors");
    const seen = new Set([doc.uuaid]);
    for (const door of d) {
      if (!isPlainObject(door) || Object.keys(door).length !== DOOR_FIELDS.length || !DOOR_FIELDS.every(k => Object.hasOwn(door, k))) return fail("bad-doors");
      if (!keyAndUuaidOk(door.uuaid, door.publicKey) || seen.has(door.uuaid)) return fail("bad-doors");
      seen.add(door.uuaid);
    }
  }
  const { issuedAt, expiresAt } = doc;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt < 0) return fail("bad-time");
  if (issuedAt > now + L.futureSkewMs) return fail("issued-in-future");
  if (expiresAt <= issuedAt) return fail("bad-time");
  if (expiresAt - issuedAt > L.maxTtlMs) return fail("ttl-too-long");
  if (now >= expiresAt) return fail("expired");
  const { signature, ...body } = doc;
  if (!signatureOk(doc.publicKey, listingMessage(body), signature)) return fail("bad-signature");
  return { ok: true, listing: doc };
}

/** Verify a withdrawal. Valid from issuedAt (5 min skew) for maxTtlMs: an older one can refer to no live listing. */
export function verifyWithdraw(doc, options = {}) {
  const now = clockOf(options);
  if (!isPlainObject(doc)) return fail("invalid-shape");
  const keys = Object.keys(doc);
  if (keys.some(k => !WITHDRAW_FIELDS.includes(k))) return fail("unknown-field");
  if (WITHDRAW_FIELDS.some(k => !Object.hasOwn(doc, k))) return fail("missing-field");
  if (doc.v !== SQUARE_WITHDRAW_V) return fail("bad-version");
  const idp = identityProblem(doc);
  if (idp) return fail(idp);
  if (!Number.isSafeInteger(doc.issuedAt) || doc.issuedAt < 0) return fail("bad-time");
  if (doc.issuedAt > now + L.futureSkewMs) return fail("issued-in-future");
  if (now - doc.issuedAt > L.maxTtlMs) return fail("expired");
  const { signature, ...body } = doc;
  if (!signatureOk(doc.publicKey, withdrawMessage(body), signature)) return fail("bad-signature");
  return { ok: true, withdrawal: doc };
}

function signerOf(keychain) {
  const id = keychain?._identity;
  if (!id || typeof keychain.sign !== "function") throw new Error("square: a loaded keychain is required");
  if (!keyBindsAgentUuaid(id.uuaid, id.publicKeyHex)) throw new Error("square: the keychain's UUAID is not a key-derived agent UUAID in a self-certifying namespace");
  return { uuaid: id.uuaid, publicKey: id.publicKeyHex, sign: (bytes) => Buffer.from(keychain.sign(bytes)).toString("hex") };
}

const SIGN_FIELDS = new Set(["displayName", "about", "carriers", "doors", "issuedAt", "expiresAt", "ttlMs"]);

/**
 * Sign a self-listing with the keychain's own key. `fields`: displayName, about, carriers (URLs,
 * canonicalised), doors ([{ uuaid, publicKey }]), issuedAt (default now), and expiresAt or ttlMs
 * (default 7 days). Empty optional fields are left out. Throws if the result would not verify.
 */
export function signListing(keychain, fields = {}) {
  if (!isPlainObject(fields)) throw new TypeError("square: fields must be an object");
  for (const key of Object.keys(fields)) if (!SIGN_FIELDS.has(key)) throw new Error(`square: unknown listing field ${JSON.stringify(key.slice(0, 40))}`);
  const s = signerOf(keychain);
  const issuedAt = fields.issuedAt ?? Date.now();
  if (fields.expiresAt !== undefined && fields.ttlMs !== undefined) throw new Error("square: give expiresAt or ttlMs, not both");
  const expiresAt = fields.expiresAt ?? issuedAt + (fields.ttlMs ?? L.defaultTtlMs);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) throw new Error("square: issuedAt and expiresAt must be integer ms");
  const body ={ v: SQUARE_LISTING_V, uuaid: s.uuaid, publicKey: s.publicKey, issuedAt, expiresAt };
  if (fields.displayName !== undefined && fields.displayName !== "") body.displayName = fields.displayName;
  if (fields.about !== undefined && fields.about !== "") body.about = fields.about;
  if (fields.carriers !== undefined) {
    if (!Array.isArray(fields.carriers)) throw new Error("square: carriers must be an array");
    const canonical = fields.carriers.map((c) => { try { return new URL(String(c)).href; } catch { return String(c); } });
    if (canonical.length) body.carriers = canonical;
  }
  if (fields.doors !== undefined) {
    if (!Array.isArray(fields.doors)) throw new Error("square: doors must be an array");
    if (fields.doors.length) body.doors = fields.doors.map(d => ({ uuaid: d?.uuaid, publicKey: typeof d?.publicKey === "string" ? d.publicKey.toLowerCase() : d?.publicKey }));
  }
  const doc = { ...body, signature: s.sign(listingMessage(body)) };
  // Checked at its own issuedAt: shape, bounds, binding and signature, independent of the local clock.
  const check = verifyListing(doc, { now: issuedAt });
  if (!check.ok) throw new Error(`square: listing refused (${check.reason})`);
  return doc;
}

/** Sign a withdrawal of this keychain's listing (issuedAt default now). */
export function signWithdraw(keychain, { issuedAt = Date.now() } = {}) {
  const s = signerOf(keychain);
  if (!Number.isSafeInteger(issuedAt)) throw new Error("square: issuedAt must be integer ms");
  const body = { v: SQUARE_WITHDRAW_V, uuaid: s.uuaid, publicKey: s.publicKey, issuedAt };
  const doc = { ...body, signature: s.sign(withdrawMessage(body)) };
  const check = verifyWithdraw(doc, { now: issuedAt });
  if (!check.ok) throw new Error(`square: withdrawal refused (${check.reason})`);
  return doc;
}
