// Cloud Commons relay: request authentication and response signing (spec v3.4.5 sections 6.1,
// 6.2, 6.3 and 6.5 "Signer = by").
//
// Port source (B1): the identity repo at commit cf48f0e, ported verbatim:
//   packages/pillar-client/src/identity-request.ts - the header name and grammar, the strict
//     parser (:95-114), the descriptor (:54-66), the body hash (:71-74), the signing bytes
//     (:77-79) and verifyIdentityRequest;
//   packages/pillar-client/src/identity.ts - isStrictEd25519PublicKey and verifyBytesStrict
//     (RFC 8032 strict: canonical A and R, never a small-order or mixed-order key);
//   apps/api/src/self-auth.ts:41-77 - the verifier order: a stale request is refused unverified;
//     a future-dated one is verified and refused only after its nonce is spent.
// The port passes the vector docs/standards/agent-vault-wallet/vectors/identity-auth.json at that
// commit, with the vector's own audience and namespace (test/relay-auth.test.mjs), before it is
// used with the relay's.
//
// The relay's differences (6.1, 6.3): the audience is one configured string compared byte for byte
// (never the Host header); the principal header `commons-principal` names the agent and must be an
// agentnet id (B3); the key comes from the relay's own keys table (D-i); every principal failure is
// the same 401 {"error":"unauthorized"} after a check against a fixed dummy key; the nonce is spent
// (UNIQUE(principal, nonce)) before the future check; a replay is 409. On every fleet record
// the authenticated signer must equal the body's `by` (6.5).
//
// 6.2: every relay response carries `commons-relay-sig`, Ed25519 by the relay key over
// JCS({aud, request_nonce, status, body_sha256}); signRelayResponse takes the relay key seed from
// its caller (the server) and verifyRelayResponse is the client's check against the pinned key.
//
// This module performs no network I/O and stores no private key. The server applies the size
// cap, the route inventory and the browser-origin refusal before calling authenticateRequest.

import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { jcs } from "../pillar.mjs";
import { localIdFromKey } from "../vendor/pillar/identity/keychain.mjs";
import { keyBindsAgentUuaid } from "../uuaid-namespace.mjs";
import { RelayError, assertIntegerOnly } from "./records.mjs";
import { tx } from "./schema.mjs";

// --- verbatim port: identity-request.ts (cf48f0e) ----------------------------------------

export const IDENTITY_AUTH_HEADER = "uuaid-identity-auth";
export const IDENTITY_REQUEST_TYPE = "uuaid.identity.request.v1";
/** The methods an identity key may sign. */
export const IDENTITY_REQUEST_METHODS = Object.freeze(["GET", "PUT", "POST", "DELETE", "PATCH"]);

/** The object the identity key signs. Never transmitted: the verifier rebuilds it. */
export function identityRequestDescriptor(i) {
  return {
    type: IDENTITY_REQUEST_TYPE,
    aud: i.audience,
    agent: i.agent,
    method: i.method.toUpperCase(),
    path: i.path,
    query: i.query ?? "",
    body_sha256: i.bodySha256,
    created: i.created,
    nonce: i.nonce,
  };
}

/** sha256 hex of JCS(body); null when there is no body. */
export function identityRequestBodyHash(body) {
  if (body === undefined || body === null) return null;
  return createHash("sha256").update(Buffer.from(jcs(body), "utf8")).digest("hex");
}

/** The exact bytes the identity key signs. */
export function identityRequestSigningBytes(d) {
  return Buffer.from(`${IDENTITY_REQUEST_TYPE}\n${jcs(d)}`, "utf8");
}

export function formatIdentityAuthHeader(h) {
  return `v=${h.v}; created=${h.created}; nonce=${h.nonce}; ed25519=${h.ed25519}`;
}

const CREATED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Parse the header strictly: every field once, nothing else. Null on any defect. */
export function parseIdentityAuthHeader(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  const fields = new Map();
  for (const part of value.split(";")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    if (eq <= 0) return null;
    const k = t.slice(0, eq);
    if (fields.has(k)) return null;
    fields.set(k, t.slice(eq + 1));
  }
  const keys = ["v", "created", "nonce", "ed25519"];
  if (fields.size !== keys.length || !keys.every((k) => fields.has(k))) return null;
  const created = fields.get("created");
  if (fields.get("v") !== "1") return null;
  if (!CREATED_RE.test(created) || Number.isNaN(Date.parse(created))) return null;
  if (!/^[0-9a-f]{32,64}$/.test(fields.get("nonce"))) return null;
  if (!/^[0-9a-f]{128}$/.test(fields.get("ed25519"))) return null;
  return { v: "1", created, nonce: fields.get("nonce"), ed25519: fields.get("ed25519") };
}

// --- verbatim port: identity.ts (cf48f0e) -------------------------------------------------

export function isStrictEd25519PublicKey(pubKeyHex) {
  if (typeof pubKeyHex !== "string" || !/^[0-9a-f]{64}$/i.test(pubKeyHex)) return false;
  const hex = pubKeyHex.toLowerCase();
  try {
    const point = ed25519.Point.fromHex(hex, false);
    return point.toHex() === hex && !point.isSmallOrder() && point.isTorsionFree();
  } catch {
    return false;
  }
}

export function verifyBytesStrict(pubKeyHex, msg, sigHex) {
  if (!isStrictEd25519PublicKey(pubKeyHex)) return false;
  if (typeof sigHex !== "string" || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  try {
    return ed25519.verify(Buffer.from(sigHex.toLowerCase(), "hex"), msg, Buffer.from(pubKeyHex.toLowerCase(), "hex"), { zip215: false });
  } catch {
    return false;
  }
}

/** Verify a parsed header against a rebuilt descriptor and the agent's identity key (RFC 8032, prime-order key). */
export function verifyIdentityRequest(d, h, publicKeyHex) {
  if (d.created !== h.created || d.nonce !== h.nonce) return false;
  return verifyBytesStrict(publicKeyHex, identityRequestSigningBytes(d), h.ed25519);
}

/**
 * Sign a request with an identity key seed (the reference client's signer; tests). Returns the
 * header value. The seed never leaves the caller. `created` and `nonce` overrides are for fixed
 * test vectors only.
 */
export function signIdentityRequest({ seedHex, namespace = "agentnet", method, path, query, body, audience, created, nonce }) {
  const seed = Buffer.from(seedHex, "hex");
  const pub = Buffer.from(ed25519.getPublicKey(seed));
  const agent = `uuaid:${namespace}:agent:${localIdFromKey(pub)}`;
  const c = created ?? new Date().toISOString();
  const n = nonce ?? randomBytes(16).toString("hex");
  const d = identityRequestDescriptor({ audience, agent, method, path, query, bodySha256: identityRequestBodyHash(body), created: c, nonce: n });
  const sig = Buffer.from(ed25519.sign(identityRequestSigningBytes(d), seed)).toString("hex");
  return { agent, publicKey: pub.toString("hex"), header: formatIdentityAuthHeader({ v: "1", created: c, nonce: n, ed25519: sig }) };
}

// --- the relay verifier (6.1, 6.3) ----------------------------------------------------------

export const PRINCIPAL_HEADER = "commons-principal";
/** The test audience (6.1, B5): `.test` is reserved (RFC 6761); a deployed relay is configured with its own origin. */
export const RELAY_TEST_AUD = "http://commons-relay.test:8080";
export const AUTH_MAX_AGE_MS = 5 * 60 * 1000;
export const AUTH_MAX_FUTURE_MS = 60 * 1000;
export const NONCE_KEEP_MS = 10 * 60 * 1000;   // covers the 6-minute acceptance span (6.1)

/** The uniform refusal (6.3): the same status and body for every principal or signature failure. */
export const UNAUTHORIZED = Object.freeze({ status: 401, body: Object.freeze({ error: "unauthorized" }) });
const STALE = Object.freeze({ status: 401, body: Object.freeze({ error: "stale" }) });   // principal-independent (6.3)
const REPLAY = Object.freeze({ status: 409, body: Object.freeze({ error: "replay" }) });   // reachable only with a valid signature

// A fixed, valid, strict key with no known seed holder: the refusal path for an unknown or
// ineligible principal still runs one signature check, so it takes similar time (6.3).
const DUMMY_PUBLIC_KEY = Buffer.from(ed25519.getPublicKey(createHash("sha256").update("commons-relay.dummy-key.v1").digest())).toString("hex");

const AGENTNET_AGENT = /^uuaid:agentnet:agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** B3: an agentnet agent id (the only namespace the relay accepts). */
export const isAgentnetAgent = (value) => typeof value === "string" && AGENTNET_AGENT.test(value);
const header = (headers, name) => {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(v) ? null : v;   // a repeated header is a malformed request
};

/**
 * The principal a key row names, with the facts the verifier needs, read from the relay's tables
 * on every request with no cache (M3). Null when the agent has no key row.
 */
function principalOf(db, agent) {
  const k = db.prepare("SELECT public_key, agent, principal_kind, principal_id, status FROM keys WHERE agent = ?").get(agent);
  if (!k) return null;
  if (k.principal_kind === "fleet") {
    const f = db.prepare("SELECT kind, status FROM fleet_principals WHERE principal_id = ?").get(k.principal_id);
    return { kind: "fleet", id: k.principal_id, agent, publicKey: k.public_key, keyStatus: k.status, fleetKind: f?.kind ?? null, status: f?.status ?? null };
  }
  const m = db.prepare("SELECT status, role FROM members WHERE member_id = ?").get(k.principal_id);
  return { kind: "member", id: k.principal_id, agent, publicKey: k.public_key, keyStatus: k.status, status: m?.status ?? null, role: m?.role ?? null };
}

/**
 * Whether this principal may be authenticated on this request (6.1 step 3):
 * - a fleet principal: an active key of an active roster principal;
 * - a member: an active key and status active; or, only where `allowPending` (GET /v1/status
 *   only), a pending member on its pending enrollment key.
 * Suspended, revoked, unknown, retired and revoked-key principals are ineligible: uniform 401.
 */
function eligible(p, allowPending) {
  if (!p) return false;
  if (p.kind === "fleet") return p.keyStatus === "active" && p.status === "active";
  if (p.keyStatus === "active" && p.status === "active") return true;
  return allowPending && p.keyStatus === "pending" && p.status === "pending";
}

/**
 * Authenticate one request (6.1 steps 2-6; 3 and 8 read the tables on every request).
 * `req` = { method, path, query, headers, body } with `body` the parsed JSON body (undefined when
 * there is none); `aud` the relay's configured audience; `now` the relay clock in ms.
 * Returns { ok: true, principal } or { ok: false, status, body }. Throws RelayError
 * non-integer-number (400) for a body JCS cannot hash, before any signature or nonce work (B4).
 */
/** 6.1 `created`: the header grammar's RFC 3339 UTC form (shared with the enrollment flow). */
export const isCreated = (value) => typeof value === "string" && CREATED_RE.test(value) && !Number.isNaN(Date.parse(value));
/** 6.1 `nonce`: 32-64 lower-case hex (shared with the enrollment flow). */
export const isNonce = (value) => typeof value === "string" && /^[0-9a-f]{32,64}$/.test(value);

/**
 * 6.1 step 5 / 5.2 step 6 (B9): spend (principal, nonce) in the one request-nonce table, pruning
 * expired rows. Returns false on a replay. The row is kept NONCE_KEEP_MS past max(created, now).
 */
export function spendNonce(db, principal, nonce, createdMs, now) {
  return tx(db, () => {
    db.prepare("DELETE FROM request_nonces WHERE expires_at <= ?").run(now);
    const r = db.prepare("INSERT INTO request_nonces(principal, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(principal, nonce, Math.max(createdMs, now) + NONCE_KEEP_MS);
    return r.changes === 1;
  });
}

export function authenticateRequest(db, req, { aud, now, allowPending = false }) {
  if (typeof aud !== "string" || !aud) throw new RelayError("relay-aud-unset", 500);
  if (!Number.isSafeInteger(now)) throw new RelayError("invalid-time", 500);
  // Step 2: parse; a stale request is refused before any principal or signature work.
  const h = parseIdentityAuthHeader(header(req.headers, IDENTITY_AUTH_HEADER));
  const agent = header(req.headers, PRINCIPAL_HEADER);
  if (!h || typeof agent !== "string") return { ok: false, ...UNAUTHORIZED };
  const created = Date.parse(h.created);
  if (created < now - AUTH_MAX_AGE_MS) return { ok: false, ...STALE };
  // B4: integer-only bodies; hashing fails before any signature work, so no nonce is spent.
  if (req.body !== undefined && req.body !== null) assertIntegerOnly(req.body);
  const bodySha256 = identityRequestBodyHash(req.body);
  // Step 3: the principal's current key, from the relay's own tables (D-i); never from the request.
  const p = AGENTNET_AGENT.test(agent) ? principalOf(db, agent) : null;
  const ok = eligible(p, allowPending);
  const key = ok ? p.publicKey : DUMMY_PUBLIC_KEY;
  // Step 4: strict Ed25519; the key derives the agent in agentnet (B3); the signature over the
  // descriptor the relay rebuilds from the request it received, with its own audience (B5).
  const d = identityRequestDescriptor({ audience: aud, agent, method: req.method, path: req.path, query: req.query ?? "", bodySha256, created: h.created, nonce: h.nonce });
  const verified = verifyIdentityRequest(d, h, key) && isStrictEd25519PublicKey(key) && keyBindsAgentUuaid(agent, key);
  if (!ok || !verified) return { ok: false, ...UNAUTHORIZED };
  // Step 5: spend the nonce before the future check. It stays spent even if a later step fails.
  if (!spendNonce(db, agent, h.nonce, created, now)) return { ok: false, ...REPLAY };
  // Step 6: more than 60 s ahead is refused, after the nonce is spent.
  if (created > now + AUTH_MAX_FUTURE_MS) return { ok: false, ...STALE };
  return { ok: true, principal: { kind: p.kind, id: p.id, agent, status: p.status, ...(p.kind === "fleet" ? { fleetKind: p.fleetKind } : { role: p.role }) } };
}

/**
 * 6.5 "Signer = by": a fleet record is accepted only from the fleet principal its
 * body names. A member principal, or any other fleet principal, gets the uniform 401, so a captured
 * signed body cannot be re-submitted by another principal.
 */
export function signerMatchesBy(principal, body) {
  return !!principal && principal.kind === "fleet" && !!body && typeof body === "object" && body.by === principal.id;
}

// --- relay authenticity (6.2) ----------------------------------------------------------------

/** 6.2: the header that carries the relay's signature on every response. */
export const RELAY_SIG_HEADER = "commons-relay-sig";

/**
 * 6.2: the bytes the relay signs for one response: JCS({aud, request_nonce, status, body_sha256}),
 * with body_sha256 defined as in 6.1 (sha256 hex of JCS(body), or null when there is no body).
 * `requestNonce` is the request's own 6.1 nonce, or null when the request carried no header that parses.
 */
export function relayResponseSigningBytes({ aud, requestNonce, status, body }) {
  if (typeof aud !== "string" || !aud) throw new RelayError("relay-aud-unset", 500);
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new RelayError("invalid-status", 500);
  if (requestNonce !== null && !(typeof requestNonce === "string" && /^[0-9a-f]{32,64}$/.test(requestNonce))) throw new RelayError("invalid-nonce", 500);
  return Buffer.from(jcs({ aud, request_nonce: requestNonce, status, body_sha256: identityRequestBodyHash(body) }), "utf8");
}

/** Sign a response with the relay key seed (32-byte hex, held by the server only). Returns 128 hex. */
export function signRelayResponse(relaySeedHex, response) {
  return Buffer.from(ed25519.sign(relayResponseSigningBytes(response), Buffer.from(relaySeedHex, "hex"))).toString("hex");
}

/** A client's check (6.2): strict Ed25519 against the pinned 64-hex relay key, byte for byte. */
export function verifyRelayResponse(relayPublicKeyHex, response, sigHex) {
  if (typeof relayPublicKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(relayPublicKeyHex)) return false;
  let bytes;
  try { bytes = relayResponseSigningBytes(response); } catch { return false; }
  return isStrictEd25519PublicKey(relayPublicKeyHex) && verifyBytesStrict(relayPublicKeyHex, bytes, sigHex);
}

/** The request's 6.1 nonce for the response signature: the strict header parse, or null. */
export function requestNonceOf(headers) {
  return parseIdentityAuthHeader(header(headers, IDENTITY_AUTH_HEADER))?.nonce ?? null;
}
