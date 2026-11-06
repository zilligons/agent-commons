// L1 request authentication (spec v3.4.3 6.1, 6.3, 6.5; N9, N15, N27, N28, N29 request side).
// First the port of the identity request scheme against its test vector (identity-auth.json, pinned),
// with the vector's own audience and namespace, as 6.1 requires before use with the relay's; then the
// relay verifier with fixture principals. The vector is regenerated from the published algorithm by
// relay-fixtures/vectors/make-identity-auth-vector.mjs, independently of the port (its own Ed25519
// call, sha256 and JCS), with a fixture key. Scratch databases, fixture keys, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  IDENTITY_AUTH_HEADER, PRINCIPAL_HEADER, RELAY_TEST_AUD, NONCE_KEEP_MS, AUTH_MAX_AGE_MS, AUTH_MAX_FUTURE_MS,
  identityRequestDescriptor, identityRequestBodyHash, identityRequestSigningBytes, parseIdentityAuthHeader,
  formatIdentityAuthHeader, isStrictEd25519PublicKey, verifyIdentityRequest, signIdentityRequest, authenticateRequest, signerMatchesBy,
} from "../src/relay/auth.mjs";
import { keyBindsAgentUuaid } from "../src/uuaid-namespace.mjs";
import { localIdFromKey } from "../src/vendor/pillar/identity/keychain.mjs";
import { setup, keySeedHex, decision, rejects, createDecision, applyEnrollmentRequest, createInvite, T0, MIN } from "./relay-fixtures.mjs";

const VECTOR_URL = new URL("./relay-fixtures/vectors/identity-auth.json", import.meta.url);
const VECTOR_SHA = "c6c0f1edbb1e172c276f93f9791e05c479ad43d0cf45d0fc5ffc9eb1312517ef";   // node test/relay-fixtures/vectors/make-identity-auth-vector.mjs
const vector = () => {
  const bytes = readFileSync(VECTOR_URL);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), VECTOR_SHA, "the pinned vector file");
  return JSON.parse(bytes.toString("utf8"));
};

test("identity-auth vector: the rebuilt descriptor, the signed bytes and the signature match; the key derives the agent", () => {
  const v = vector();
  const h = parseIdentityAuthHeader(v.header);
  assert.ok(h, "the vector header parses");
  const d = identityRequestDescriptor({ audience: v.expected_descriptor.aud, agent: v.agent, method: v.request.method, path: v.request.path,
    query: v.request.query, bodySha256: identityRequestBodyHash(v.request.body), created: h.created, nonce: h.nonce });
  assert.deepEqual(d, v.expected_descriptor);
  assert.equal(identityRequestSigningBytes(d).toString("utf8"), v.expected_signed_string);
  assert.equal(isStrictEd25519PublicKey(v.public_key), true);
  assert.equal(keyBindsAgentUuaid(v.agent, v.public_key), true, "the vector's own namespace (pillar)");
  assert.equal(verifyIdentityRequest(d, h, v.public_key), true);
  assert.equal(formatIdentityAuthHeader(h), v.header, "format(parse(header)) is the header");
});

test("identity-auth vector: each must_fail mutation fails (method, path, body, audience, agent, query)", () => {
  const v = vector();
  const h = parseIdentityAuthHeader(v.header);
  assert.deepEqual(v.must_fail.map(m => m.change), ["method", "path", "body", "audience", "agent", "query"]);
  for (const m of v.must_fail) assert.equal(verifyIdentityRequest(m.descriptor, h, v.public_key), false, m.change);
  // The relay's audience: the vector's signature never moves to it (D-ii).
  assert.equal(verifyIdentityRequest({ ...v.expected_descriptor, aud: RELAY_TEST_AUD }, h, v.public_key), false);
});

test("N9 parser: strict grammar (each field once, nothing else; v=1; created form; nonce 32-64 lower hex; ed25519 128 hex; <= 512)", () => {
  const ok = { v: "1", created: "2026-11-05T20:00:00.000Z", nonce: "a".repeat(32), ed25519: "b".repeat(128) };
  assert.deepEqual(parseIdentityAuthHeader(formatIdentityAuthHeader(ok)), ok);
  const bad = [
    `v=2; created=${ok.created}; nonce=${ok.nonce}; ed25519=${ok.ed25519}`,
    `v=1; created=${ok.created}; nonce=${ok.nonce}`,
    `v=1; v=1; created=${ok.created}; nonce=${ok.nonce}; ed25519=${ok.ed25519}`,
    `v=1; created=${ok.created}; nonce=${ok.nonce}; ed25519=${ok.ed25519}; extra=1`,
    `v=1; created=${ok.created}; nonce=${"a".repeat(31)}; ed25519=${ok.ed25519}`,
    `v=1; created=${ok.created}; nonce=${"A".repeat(32)}; ed25519=${ok.ed25519}`,
    `v=1; created=${ok.created}; nonce=${"a".repeat(65)}; ed25519=${ok.ed25519}`,
    `v=1; created=2026-11-05 20:00:00Z; nonce=${ok.nonce}; ed25519=${ok.ed25519}`,
    `v=1; created=2026-13-45T20:00:00Z; nonce=${ok.nonce}; ed25519=${ok.ed25519}`,
    `v=1; created=${ok.created}; nonce=${ok.nonce}; ed25519=${"b".repeat(127)}`,
    `commons-auth=1; created=${ok.created}; nonce=${ok.nonce}; ed25519=${ok.ed25519}`,
    `v=1; created=${ok.created}; nonce=${ok.nonce}; ed25519=${ok.ed25519}`.padEnd(513, " "),
    "", undefined, null, ["v=1"],
  ];
  for (const h of bad) assert.equal(parseIdentityAuthHeader(h), null, String(h).slice(0, 60));
});

// --- the relay verifier ----------------------------------------------------------------------

/** A signed request from a fixture identity, as a client sends it. */
function signed(identity, { method = "GET", path = "/v1/status", query = "", body, aud = RELAY_TEST_AUD, created, nonce, principal } = {}) {
  const s = signIdentityRequest({ seedHex: keySeedHex(identity), namespace: "agentnet", method, path, query, body, audience: aud, created, nonce });
  return { method, path, query, body, headers: { [IDENTITY_AUTH_HEADER]: s.header, [PRINCIPAL_HEADER]: principal ?? s.agent } };
}
const iso = (ms) => new Date(ms).toISOString();
const auth = (fx, req, now = T0, opts = {}) => authenticateRequest(fx.db, req, { aud: RELAY_TEST_AUD, now, ...opts });
const UNAUTH = { ok: false, status: 401, body: { error: "unauthorized" } };
// Request nonces spent after setup (seeding members runs the real enrollment flow, which spends one each).
const nonces = (fx) => fx.db.prepare("SELECT count(*) n FROM request_nonces").get().n - (fx.seedNonces ?? 0);
const fresh = (opts) => { const fx = setup(opts); fx.seedNonces = fx.db.prepare("SELECT count(*) n FROM request_nonces").get().n; return fx; };

test("a member and a fleet principal authenticate; the signer derives its agentnet id from the fixture seed", () => {
  const fx = fresh({ members: ["A"] });
  const A = fx.members.A.identity;
  const r = auth(fx, signed(A, { created: iso(T0) }));
  assert.deepEqual(r, { ok: true, principal: { kind: "member", id: fx.members.A.id, agent: A.uuaid, status: "active", role: "C0" } });
  const s = signed(fx.keys["seat-1"], { method: "POST", path: "/v1/fleet/records/task.open", body: { v: 1, by: "seat-1" }, created: iso(T0) });
  assert.deepEqual(auth(fx, s).principal, { kind: "fleet", id: "seat-1", agent: fx.keys["seat-1"].uuaid, status: "active", fleetKind: "ac-seat" });
  assert.equal(signIdentityRequest({ seedHex: keySeedHex(A), method: "GET", path: "/", audience: RELAY_TEST_AUD }).agent, A.uuaid);
  assert.equal(nonces(fx), 2);
});

test("N9 / B5: the audience is compared byte for byte; case, trailing slash, default port and another service's aud all fail", () => {
  const fx = fresh({ members: ["A"] });
  const A = fx.members.A.identity;
  for (const aud of ["http://COMMONS-RELAY.test:8080", "http://commons-relay.test:8080/", "http://commons-relay.test", "https://commons-relay.test:8080", "https://api.uuaid.org"])
    assert.deepEqual(auth(fx, signed(A, { aud, created: iso(T0) })), UNAUTH, aud);
  rejects(() => authenticateRequest(fx.db, signed(A, { created: iso(T0) }), { aud: "", now: T0 }), "relay-aud-unset");
  assert.equal(nonces(fx), 0, "no nonce is spent for a signature that does not verify");
});

test("N9: an altered principal header, method, path, query or body breaks the signature (the relay rebuilds the descriptor)", () => {
  const fx = setup({ members: ["A", "B"] });
  const A = fx.members.A.identity;
  const base = () => signed(A, { method: "POST", path: "/v1/records/heartbeat", query: "x=1", body: { type: "heartbeat", record_id: "h1", body: {} }, created: iso(T0) });
  const cases = [
    (r) => { r.headers[PRINCIPAL_HEADER] = fx.members.B.identity.uuaid; },
    (r) => { r.method = "PUT"; },
    (r) => { r.path = "/v1/records/note"; },
    (r) => { r.query = "x=2"; },
    (r) => { r.body = { ...r.body, record_id: "h2" }; },
    (r) => { r.body = undefined; },
    (r) => { delete r.headers[PRINCIPAL_HEADER]; },
    (r) => { r.headers[IDENTITY_AUTH_HEADER] = [r.headers[IDENTITY_AUTH_HEADER], r.headers[IDENTITY_AUTH_HEADER]]; },
  ];
  for (const mutate of cases) { const r = base(); mutate(r); assert.deepEqual(auth(fx, r), UNAUTH); }
  assert.equal(auth(fx, base()).ok, true, "the unmodified request still verifies");
});

test("N9 / T-B6 / N29 request side: replay is 409; a future-dated capture spends its nonce, is refused, and its bytes are 409 once its time arrives", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.identity;
  const r = signed(A, { created: iso(T0) });
  assert.equal(auth(fx, r).ok, true);
  assert.deepEqual(auth(fx, r, T0 + 1), { ok: false, status: 409, body: { error: "replay" } });
  const future = signed(A, { created: iso(T0 + 2 * MIN) });
  assert.deepEqual(auth(fx, future, T0), { ok: false, status: 401, body: { error: "stale" } });
  assert.deepEqual(auth(fx, future, T0 + 2 * MIN), { ok: false, status: 409, body: { error: "replay" } }, "the nonce stayed spent");
  // Within the 60 s window ahead: accepted.
  assert.equal(auth(fx, signed(A, { created: iso(T0 + AUTH_MAX_FUTURE_MS) }), T0).ok, true);
  // Stale (older than 5 min): refused before any nonce work.
  const before = nonces(fx);
  assert.deepEqual(auth(fx, signed(A, { created: iso(T0 - AUTH_MAX_AGE_MS - 1) }), T0), { ok: false, status: 401, body: { error: "stale" } });
  assert.equal(nonces(fx), before);
});

test("nonces are pruned after 10 minutes; a pruned nonce is stale anyway", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.identity;
  const r = signed(A, { created: iso(T0) });
  assert.equal(auth(fx, r).ok, true);
  assert.equal(auth(fx, signed(A, { created: iso(T0 + NONCE_KEEP_MS) }), T0 + NONCE_KEEP_MS).ok, true);
  assert.equal(fx.db.prepare("SELECT count(*) n FROM request_nonces WHERE expires_at <= ?").get(T0 + NONCE_KEEP_MS).n, 0, "the first nonce was pruned");
  assert.deepEqual(auth(fx, r, T0 + NONCE_KEEP_MS), { ok: false, status: 401, body: { error: "stale" } });
});

test("N28 / B4: a non-integer number in the body is refused 400 before any signature work; no nonce is spent", () => {
  const fx = fresh({ members: ["A"] });
  const A = fx.members.A.identity;
  const r = signed(A, { method: "POST", path: "/v1/records/heartbeat", body: { type: "heartbeat", record_id: "h", body: { x: 1 } }, created: iso(T0) });
  r.body = { ...r.body, body: { x: 1.5 } };
  rejects(() => auth(fx, r), "non-integer-number");
  assert.equal(nonces(fx), 0);
  assert.equal(identityRequestBodyHash(null), null);
  assert.equal(identityRequestBodyHash(undefined), null);
});

test("N15 / N27 / 6.3: unknown, pending, suspended, revoked, retired, revoked-key and foreign-namespace principals all get the same 401", () => {
  const fx = setup({ members: ["A", "B", "C"] });
  const results = [];
  // Unknown: a fresh key with no row (the dummy-key path).
  const stranger = { ...fx.members.A.identity };
  results.push(auth(fx, signed(fx.keys.owner, { principal: "uuaid:agentnet:agent:00000000-0000-0000-0000-000000000000", created: iso(T0) })));
  // Pending member on a non-status path; allowed only where allowPending (GET /v1/status, O-d).
  const pend = applyEnrollmentRequest(fx, { invite: createInvite(fx, { at: T0 }), name: "P", at: T0 });
  results.push(auth(fx, signed(pend.identity, { created: iso(T0) })));
  assert.equal(auth(fx, signed(pend.identity, { created: iso(T0 + 1) }), T0, { allowPending: true }).ok, true, "a pending member may read its own status");
  // Suspended member.
  createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: fx.members.B.id, at: T0 }), T0);
  results.push(auth(fx, signed(fx.members.B.identity, { created: iso(T0) })));
  // Revoked member (owner reverses its enrollment).
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "veto", subject: "fx-enroll-C", at: T0 }), T0);
  results.push(auth(fx, signed(fx.members.C.identity, { created: iso(T0) })));
  // Retired fleet principal with a revoked key.
  fx.db.prepare("UPDATE fleet_principals SET status = 'retired' WHERE principal_id = 'scope'").run();
  results.push(auth(fx, signed(fx.keys.scope, { created: iso(T0) })));
  fx.db.prepare("UPDATE fleet_principals SET status = 'active' WHERE principal_id = 'scope'").run();
  fx.db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE principal_id = 'scope'").run(T0);
  results.push(auth(fx, signed(fx.keys.scope, { created: iso(T0 + 1) })));
  // B3 / N27: the same key's pillar and foundation spellings.
  const A = fx.members.A.identity;
  const local = localIdFromKey(Buffer.from(A.publicKeyHex, "hex"));
  for (const ns of ["pillar", "foundation"]) {
    const s = signIdentityRequest({ seedHex: keySeedHex(A), namespace: ns, method: "GET", path: "/v1/status", audience: RELAY_TEST_AUD, created: iso(T0) });
    assert.equal(s.agent, `uuaid:${ns}:agent:${local}`);
    results.push(auth(fx, { method: "GET", path: "/v1/status", query: "", headers: { [IDENTITY_AUTH_HEADER]: s.header, [PRINCIPAL_HEADER]: s.agent } }));
  }
  for (const r of results) assert.deepEqual(r, UNAUTH);
  assert.equal(results.length, 8);
  assert.ok(stranger);
});

test("6.5 Signer = by: a fleet record is accepted only from the fleet principal its body names", () => {
  const fx = setup({ members: ["A"] });
  const seat1 = auth(fx, signed(fx.keys["seat-1"], { created: iso(T0) })).principal;
  const member = auth(fx, signed(fx.members.A.identity, { created: iso(T0) })).principal;
  assert.equal(signerMatchesBy(seat1, { by: "seat-1" }), true);
  assert.equal(signerMatchesBy(seat1, { by: "seat-2" }), false, "a captured body re-submitted by another principal");
  assert.equal(signerMatchesBy(seat1, { by: undefined }), false);
  assert.equal(signerMatchesBy(seat1, null), false);
  assert.equal(signerMatchesBy(member, { by: fx.members.A.id }), false, "a member never submits a fleet record");
  assert.equal(signerMatchesBy(null, { by: "seat-1" }), false);
});
