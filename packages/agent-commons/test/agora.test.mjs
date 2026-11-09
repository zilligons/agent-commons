// @uuaid/agent-commons/agora: the client side of the AgentNet Agora (RedTeam design verdict fm-20261109T083342-8315f2).
// Offline. A loopback stub reproduces the live route checks (uuaid cf48f0e agora-agent-auth.ts): claims equality, a
// single-use capability, TTL at most 2 minutes, created/expires equal to the capability, browser refusal, Bearer.
// The byte-level oracle (the REAL cf48f0e verifiers) is test/agora-oracle.mjs, run when AGORA_ORACLE_DIR is set.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createHash, verify, createPublicKey } from "node:crypto";
import { Keychain } from "../src/pillar.mjs";
import { jcs } from "../src/pillar.mjs";
import {
  AgoraClient, AgoraPublisher, AgoraError, sealUuaidEnvelope, buildIdentityBinding, contentHash, assertPlainJson,
  agoraEgressAllowed, COMMONS_LABELS, BINDING_MAX_AGE_MS, IDENTITY_BINDING_TYPE, AGORA_REQUEST_HEADERS, PARTNER_KEY_MIN_LENGTH,
} from "../src/agora.mjs";

const key = (ns = "agentnet") => { const k = new Keychain("unused"); k._identity = Keychain.generate({ uuaidNamespace: ns }); return k; };
const REG = "uuaid:foundation:agent:0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const PARTNER = "pk_test_" + "x".repeat(32);
const ON = { AGENT_COMMONS_OFFLINE: "0", UUAID_PARTNER_KEY: PARTNER };
const code = (c) => (e) => e instanceof AgoraError && e.code === c;
const ed25519Verify = (pubHex, msg, sigHex) => verify(null, Buffer.from(msg), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubHex, "hex")]), format: "der", type: "spki" }), Buffer.from(sigHex, "hex"));

// A loopback Agora that applies the same checks as the live gate, in the same order that matters here.
async function stubAgora(t, { boundKeyId = "ac-k1", agent = REG, keychain }) {
  const challenges = new Map(); const caps = new Map(); const seen = []; const nonces = new Set();
  const pub = keychain._identity.publicKeyHex;
  const verifyEnv = (env) => env && env.payloadHash === contentHash(env.payload) && env.signatures.length === 1
    && env.signatures[0].alg === "ed25519" && env.signatures[0].keyId === boundKeyId && env.signatures[0].publicKey === pub
    && ed25519Verify(pub, Buffer.from(jcs(env.payload), "utf8"), env.signatures[0].signature);
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, cap: req.headers["x-agora-capability"] ?? null, body: raw, headers: Object.keys(req.headers) });
    if (req.headers.origin || req.headers["sec-fetch-site"] || req.headers["sec-fetch-mode"]) return send(403, { error: "Agora writes require an agent runtime, not a browser or operator session" });
    if (req.headers.authorization !== `Bearer ${PARTNER}`) return send(401, { error: "partner authentication required" });
    const body = raw ? JSON.parse(raw) : null;
    if (req.url === "/agora/capabilities/challenge") {
      if (body.agent_uuaid !== agent) return send(404, { error: "agent not found" });
      const issued = new Date(); const p = { ...body, challenge_nonce: "c".repeat(32) + challenges.size, issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 120000).toISOString() };
      challenges.set(p.challenge_nonce, { p, used: false }); return send(201, p);
    }
    if (req.url === "/agora/capabilities") {
      const ch = challenges.get(body?.payload?.challenge_nonce);
      if (!ch || ch.used) return send(409, { error: "unknown or already-used challenge" });
      if (jcs(ch.p) !== jcs(body.payload)) return send(401, { error: "expired or substituted challenge" });
      if (!verifyEnv(body)) return send(401, { error: "invalid signed envelope" });
      ch.used = true; const token = "cap_" + caps.size; caps.set(token, { ...ch.p, used: false });
      return send(201, { capability: token, action: ch.p.action, audience: ch.p.audience, target: ch.p.target, expires_at: ch.p.expires_at });
    }
    const cap = caps.get(req.headers["x-agora-capability"]);
    if (!cap) return send(401, { error: "invalid autonomy capability" });
    if (cap.used) return send(409, { error: "capability or nonce already used" });
    const p = body.payload;
    if (!verifyEnv(body)) return send(401, { error: "invalid signed envelope" });
    if (p.agent_uuaid !== cap.agent_uuaid || p.action !== cap.action || p.audience !== cap.audience || p.target !== cap.target || p.nonce !== cap.nonce || p.created !== cap.issued_at || p.expires !== cap.expires_at) return send(403, { error: "autonomy capability claims mismatch" });
    if (nonces.has(p.nonce)) return send(409, { error: "capability or nonce already used" });
    cap.used = true; nonces.add(p.nonce);
    if (req.url === "/agora/entries") return send(201, { uuaid: "uuaid:foundation:post:0193a1b2-0000-7000-8000-000000000001", body_hash: body.payloadHash, moderation_status: "PENDING" });
    if (/^\/agora\/communities\/[^/]+\/[^/]+\/membership$/.test(req.url)) return send(201, { ok: true });
    return send(404, { error: "no route" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen, caps };
}
const client = (k, url, extra = {}) => new AgoraClient({ url, keychain: k, keyId: "ac-k1", registryUuaid: REG, env: ON, ...extra });

test("a key-derived identity seals a @uuaid/core envelope: payloadHash = 0x sha256(JCS), Ed25519 over the JCS bytes", () => {
  const k = key();
  const env = sealUuaidEnvelope({ b: 1, a: "x", n: { z: true, y: null } }, k, "ac-k1", { now: () => new Date("2026-11-09T09:00:00.000Z") });
  const bytes = Buffer.from('{"a":"x","b":1,"n":{"y":null,"z":true}}', "utf8");
  assert.equal(env.payloadHash, "0x" + createHash("sha256").update(bytes).digest("hex"), "RT4-JCS-canonical-key-order");
  assert.deepEqual(Object.keys(env.signatures[0]), ["alg", "keyId", "publicKey", "signature", "created"]);
  assert.equal(env.signatures[0].alg, "ed25519"); assert.equal(env.signatures[0].created, "2026-11-09T09:00:00.000Z");
  assert.equal(ed25519Verify(k._identity.publicKeyHex, bytes, env.signatures[0].signature), true);
});

test("sealUuaidEnvelope refuses non-JSON values the server would canonicalize differently, before signing", () => {
  const k = key(); let signed = 0; const spy = { _identity: k._identity, sign: (b) => { signed++; return k.sign(b); } };
  for (const bad of [{ a: undefined }, { a: 1.5 }, { a: () => 1 }, { a: new Date() }, { a: 2n ** 60n }, { a: NaN }, JSON.parse('{"__proto__":{"x":1}}')]) {
    assert.throws(() => sealUuaidEnvelope(bad, spy, "ac-k1"), code("NOT_JSON"));
  }
  assert.equal(signed, 0, "nothing was signed");
  assert.doesNotThrow(() => assertPlainJson({ a: [1, "b", null, true, { c: "d" }] }));
});

test("sealUuaidEnvelope refuses a small-order key and a uuaid the key does not derive", () => {
  const k = key();
  const weak = { _identity: { ...k._identity, publicKeyHex: "0".repeat(64) }, sign: k.sign.bind(k) };
  assert.throws(() => sealUuaidEnvelope({ a: 1 }, weak, "ac-k1"), code("WEAK_KEY"));
  const other = key();
  const wrong = { _identity: { ...k._identity, uuaid: other._identity.uuaid }, sign: k.sign.bind(k) };
  assert.throws(() => sealUuaidEnvelope({ a: 1 }, wrong, "ac-k1"), code("KEY_MISMATCH"));
});

test("buildIdentityBinding: the exact uuaid.identity.binding.v1 shape, signed over the type line plus JCS", () => {
  for (const ns of ["foundation", "pillar", "agentnet"]) {
    const k = key(ns); const now = Date.parse("2026-11-09T09:00:00.000Z");
    const { binding, signature } = buildIdentityBinding({ registryUuaid: REG, keychain: k, now: () => now });
    assert.deepEqual(Object.keys(binding).sort(), ["aud", "issuedAt", "pillar_uuaid", "publicKey", "registry_uuaid", "type"]);
    assert.equal(binding.type, IDENTITY_BINDING_TYPE); assert.equal(binding.aud, "https://api.uuaid.org");
    assert.equal(binding.pillar_uuaid, k._identity.uuaid); assert.equal(binding.publicKey, k._identity.publicKeyHex);
    assert.equal(ed25519Verify(binding.publicKey, Buffer.from(`${IDENTITY_BINDING_TYPE}\n${jcs(binding)}`, "utf8"), signature), true);
  }
});

test("buildIdentityBinding refuses a stale issuedAt (over 60 s), a future one, and a registry uuaid equal to the key address", () => {
  const k = key(); const now = Date.parse("2026-11-09T09:00:00.000Z");
  assert.throws(() => buildIdentityBinding({ registryUuaid: REG, keychain: k, now: () => now, issuedAt: new Date(now - BINDING_MAX_AGE_MS - 1).toISOString() }), code("STALE_BINDING"));
  assert.doesNotThrow(() => buildIdentityBinding({ registryUuaid: REG, keychain: k, now: () => now, issuedAt: new Date(now - BINDING_MAX_AGE_MS + 1000).toISOString() }));
  assert.throws(() => buildIdentityBinding({ registryUuaid: REG, keychain: k, now: () => now, issuedAt: new Date(now + 60_000).toISOString() }), code("ISSUED_AT"));
  assert.throws(() => buildIdentityBinding({ registryUuaid: k._identity.uuaid, keychain: k, now: () => now }), code("REGISTRY_UUAID"));
  assert.throws(() => buildIdentityBinding({ registryUuaid: REG, keychain: k, aud: "http://api.uuaid.org" }), code("AUDIENCE"));
});

test("egress is allowed ONLY when AGENT_COMMONS_OFFLINE is exactly \"0\", whatever any policy says", async (t) => {
  for (const v of [undefined, "", "1", "false", "no", " 0", "0 ", "00"]) assert.equal(agoraEgressAllowed({ AGENT_COMMONS_OFFLINE: v }), false, JSON.stringify(v));
  assert.equal(agoraEgressAllowed({ AGENT_COMMONS_OFFLINE: "0" }), true);
  const k = key(); const stub = await stubAgora(t, { keychain: k });
  for (const env of [{ UUAID_PARTNER_KEY: PARTNER }, { UUAID_PARTNER_KEY: PARTNER, AGENT_COMMONS_OFFLINE: "1" }]) {
    await assert.rejects(client(k, stub.url, { env }).joinCommunity({ source: "agentnet", slug: "s", sourceId: "1" }), code("OFFLINE"), "RT2-offline-blocks-egress");
  }
  assert.equal(stub.seen.length, 0, "no request reached even a loopback Agora while offline");
});

test("the client sends no browser headers: the live rejectBrowser gate (Origin, Sec-Fetch-*) never fires", async (t) => {
  const k = key(); const stub = await stubAgora(t, { keychain: k });
  await client(k, stub.url).joinCommunity({ source: "agentnet", slug: "builders", sourceId: "42" });
  assert.equal(stub.seen.length, 3, "challenge, capability and write");
  for (const r of stub.seen) {
    assert.deepEqual(r.headers.filter((h) => !AGORA_REQUEST_HEADERS.includes(h)), [], `unexpected request headers on ${r.url}`);
    assert.equal(r.headers.some((h) => h === "origin" || h.startsWith("sec-fetch-")), false);
  }
});

test("the partner key is read only from the environment, fails closed, and never appears in an error", async (t) => {
  const k = key();
  for (const env of [{ AGENT_COMMONS_OFFLINE: "0" }, { AGENT_COMMONS_OFFLINE: "0", UUAID_PARTNER_KEY: "" }, { AGENT_COMMONS_OFFLINE: "0", UUAID_PARTNER_KEY: "   " }]) {
    assert.throws(() => new AgoraClient({ url: "https://api.uuaid.org", keychain: k, keyId: "ac-k1", registryUuaid: REG, env }), code("NO_PARTNER_KEY"), "RT1-partner-key-env-only");
  }
  assert.equal(new AgoraClient({ url: "https://api.uuaid.org", keychain: k, keyId: "ac-k1", registryUuaid: REG, env: ON, partnerKey: PARTNER }).registryUuaid, REG, "an option named partnerKey is ignored, not used");
  // An Agora that refuses: the error carries the server's message, never the key.
  const stub = await stubAgora(t, { keychain: k, agent: "uuaid:foundation:agent:ffffffff-ffff-7fff-8fff-ffffffffffff" });
  const err = await client(k, stub.url).joinCommunity({ source: "agentnet", slug: "s", sourceId: "1" }).catch((e) => e);
  assert.equal(err.code, "HTTP_404");
  assert.equal(JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes(PARTNER), false, "the partner key is not in the error");
  assert.equal(stub.seen.every((r) => r.auth === `Bearer ${PARTNER}`), true, "it is sent only as the Bearer");
});

test("the full write flow against a loopback Agora: challenge, single-use capability, signed write; capability claims match", async (t) => {
  const k = key(); const stub = await stubAgora(t, { keychain: k });
  const c = client(k, stub.url);
  // The server's single-use rule would turn a reused nonce into a thrown CONFLICT, which is not assertion evidence.
  // So the client-side guarantee is asserted directly, and each write is caught and checked rather than allowed to throw.
  const outcome = async (p) => { try { return { ok: true, value: await p }; } catch (e) { return { ok: false, code: e.code }; } };
  const joinR = await outcome(c.joinCommunity({ source: "agentnet", slug: "builders", sourceId: "42" }));
  const postR = await outcome(c.post("agentnet", "42", { kind: "post", title: "hello", body: "from a commons agent" }));
  {
    const nonces = stub.seen.filter((x) => x.url === "/agora/capabilities/challenge").map((x) => JSON.parse(x.body).nonce);
    assert.equal(new Set(nonces).size, nonces.length, "RT6-fresh-nonce-per-write");
  }
  assert.equal(joinR.ok, true, "RT6-first-write-succeeds"); assert.equal(postR.ok, true, "RT6-second-write-succeeds");
  const join = joinR.value; const r = postR.value;
  assert.deepEqual(join.result, { ok: true });
  assert.equal(r.result.moderation_status, "PENDING"); assert.equal(r.result.body_hash, r.payloadHash);
  const write = JSON.parse(stub.seen.at(-1).body);
  assert.equal(write.payload.target, "community:agentnet:42"); assert.equal(write.payload.author_uuaid, REG); assert.equal(write.payload.agent_uuaid, REG);
  assert.deepEqual(write.payload.meta.commons, COMMONS_LABELS, "commons/1 labels travel with the post");
  assert.equal(stub.seen.filter((x) => x.url === "/agora/capabilities").length, 2, "one capability per write");
  // [RT-6] each write gets a fresh nonce, so a capability is never reused (asserted here, not left to the server's 409)
  const nonces = stub.seen.filter((x) => x.url === "/agora/capabilities/challenge").map((x) => JSON.parse(x.body).nonce);
  assert.equal(new Set(nonces).size, nonces.length, "RT6-fresh-nonce-per-write");
  assert.equal(stub.seen.every((x) => x.cap === null || /^cap_\d+$/.test(x.cap)), true);
});

test("a 409 is surfaced and never retried; a reused capability is refused by the server, not retried by the client", async (t) => {
  const k = key(); const stub = await stubAgora(t, { keychain: k });
  const c = client(k, stub.url);
  await c.post("agentnet", "42", { kind: "post", body: "one" });
  const before = stub.seen.length;
  // Replay the last write exactly (same capability, same nonce): the server answers 409.
  const last = stub.seen.at(-1);
  // Through node:http, like the client: a fetch replay would be refused earlier, by the browser gate.
  const status = await new Promise((resolve, reject) => { const u = new URL(stub.url + last.url);
    const r = httpRequest(u, { method: "POST", headers: { authorization: last.auth, "x-agora-capability": last.cap, "content-type": "application/json", "content-length": Buffer.byteLength(last.body) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", reject); r.end(last.body); });
  assert.equal(status, 409, "the server refuses the reused capability");
  assert.equal(stub.seen.length, before + 1, "only the manual replay reached the server");
});

test("redirects are never followed and a non-JSON or oversized answer is refused", async (t) => {
  const k = key(); const server = createServer((req, res) => {
    if (req.url === "/agora/capabilities/challenge") { res.writeHead(302, { location: "https://example.org/" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" }); res.end("<html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  await assert.rejects(client(k, `http://127.0.0.1:${server.address().port}`).joinCommunity({ source: "a", slug: "b", sourceId: "c" }), code("REDIRECT"));
  assert.throws(() => new AgoraClient({ url: "http://api.uuaid.org", keychain: k, keyId: "ac-k1", registryUuaid: REG, env: ON }), code("INSECURE_URL"));
  assert.throws(() => new AgoraClient({ url: "https://user:pw@api.uuaid.org", keychain: k, keyId: "ac-k1", registryUuaid: REG, env: ON }), code("BAD_URL"));
});

test("AgoraPublisher: commons/1 §8 refuses before any network call, then publishes and returns contribution.published", async (t) => {
  const k = key(); const stub = await stubAgora(t, { keychain: k });
  const linked = { status: "bound", registry_uuaid: REG, pillar_uuaid: k._identity.uuaid };
  const ok = { target: "agora", terms: "free", licence: "CC-BY-4.0", requesterConsent: true, authors: [{ uuaid: k._identity.uuaid, consent: true }, { uuaid: "uuaid:pillar:agent:x", omitted: true }], community: { source: "agentnet", sourceId: "42" }, body: "a delivery, published" };
  const cases = [
    [{ ...ok, terms: "paid" }, "PAID_TERMS"], [{ ...ok, licence: "" }, "NO_LICENCE"], [{ ...ok, requesterConsent: false }, "NO_CONSENT"],
    [{ ...ok, authors: [{ uuaid: "a" }] }, "NO_CONSENT"], [{ ...ok, target: "standards-body" }, "TARGET"],
  ];
  const before = stub.seen.length;
  for (const [c, want] of cases) await assert.rejects(new AgoraPublisher({ client: client(k, stub.url), verifiedBinding: linked }).publish(c), code(want), `RT5-refuses-${want}`);
  await assert.rejects(new AgoraPublisher({ client: client(k, stub.url) }).publish(ok), code("NOT_LINKED"), "inert until a principal is linked");
  await assert.rejects(new AgoraPublisher({ client: client(k, stub.url), verifiedBinding: { ...linked, status: "refused" } }).publish(ok), code("NOT_LINKED"));
  await assert.rejects(new AgoraPublisher({ client: client(k, stub.url), verifiedBinding: { ...linked, registry_uuaid: "uuaid:foundation:agent:00000000-0000-7000-8000-000000000000" } }).publish(ok), code("NOT_LINKED"));
  assert.equal(stub.seen.length, before, "no refused contribution reached the network");
  const out = await new AgoraPublisher({ client: client(k, stub.url), verifiedBinding: linked }).publish(ok);
  assert.equal(out.contributionPublished.type, "contribution.published"); assert.equal(out.contributionPublished.body.target, "agora");
  assert.match(out.contributionPublished.body.targetId, /^uuaid:foundation:post:/); assert.match(out.contributionPublished.body.contentHash, /^0x[0-9a-f]{64}$/);
  const posted = JSON.parse(stub.seen.at(-1).body).payload;
  assert.deepEqual(posted.meta.authors, [k._identity.uuaid], "an omitted author's work is not credited");
  assert.equal(posted.meta.terms, "free");
});

test("a 403 'active agent credential required' is surfaced verbatim, never claimed client-side", async (t) => {
  const k = key();
  const server = createServer(async (req, res) => { for await (const _ of req); res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "active agent credential required", reason: "unverified_origin" })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const err = await client(k, `http://127.0.0.1:${server.address().port}`).post("agentnet", "42", { kind: "post", body: "x" }).catch((e) => e);
  assert.equal(err.code, "HTTP_403"); assert.equal(err.serverError, "active agent credential required"); assert.equal(err.reason, "unverified_origin");
});

// ---- V1 findings at 2295ac0 (fm-20261109T090125-350bd3): one regression test each ----

test("V1-F1: a verified binding for a DIFFERENT key never unlocks publish, and nothing reaches the network", async (t) => {
  const k = key(); const stub = await stubAgora(t, { keychain: k });
  const otherKey = Keychain.generate({ uuaidNamespace: "agentnet" });
  const ok = { target: "agora", terms: "free", licence: "CC-BY-4.0", requesterConsent: true, authors: [], community: { source: "agentnet", sourceId: "42" }, body: "b" };
  await assert.rejects(new AgoraPublisher({ client: client(k, stub.url), verifiedBinding: { status: "bound", registry_uuaid: REG, pillar_uuaid: otherKey.uuaid } }).publish(ok), code("NOT_LINKED"), "V1-F1-other-key-binding-refused");
  await assert.rejects(new AgoraPublisher({ client: client(k, stub.url), verifiedBinding: { status: "bound", registry_uuaid: REG, pillar_uuaid: k._identity.uuaid, publicKey: otherKey.publicKeyHex } }).publish(ok), code("NOT_LINKED"));
  assert.equal(stub.seen.length, 0, "zero network calls for a wrong-key binding");
  const own = await new AgoraPublisher({ client: client(k, stub.url), verifiedBinding: { status: "bound", registry_uuaid: REG, pillar_uuaid: k._identity.uuaid, publicKey: k._identity.publicKeyHex } }).publish(ok);
  assert.equal(own.contributionPublished.type, "contribution.published", "positive control: this key's own binding publishes");
});

test("V1-F2: a sparse array (or an array with extra properties) is refused before signing", () => {
  const k = key(); let signed = 0; const spy = { _identity: k._identity, sign: (b) => { signed++; return k.sign(b); } };
  const extra = [1]; extra.note = "x";
  for (const bad of [{ items: new Array(1) }, { items: [1, , 3] }, { items: extra }]) assert.throws(() => sealUuaidEnvelope(bad, spy, "ac-k1"), code("NOT_JSON"), "V1-F2-sparse-array-refused");
  assert.equal(signed, 0, "nothing signed");
  const dense = sealUuaidEnvelope({ items: [null] }, k, "ac-k1");
  assert.equal(jcs(dense.payload), JSON.stringify(dense.payload), "positive control: the signed JCS bytes equal the bytes sent");
});

test("V1-F3: a server that echoes the partner key never gets it into message, serverError, reason or stack", async (t) => {
  const k = key();
  const server = createServer(async (req, res) => { for await (const _ of req); res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `rejected ${req.headers.authorization}`, reason: `echo ${PARTNER}` })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const err = await client(k, `http://127.0.0.1:${server.address().port}`).joinCommunity({ source: "a", slug: "b", sourceId: "c" }).catch((e) => e);
  for (const field of ["message", "serverError", "reason", "stack"]) assert.equal(String(err[field]).includes(PARTNER), false, `V1-F3-${field}-redacted`);
  assert.equal(err.serverError, "rejected Bearer [redacted]"); assert.equal(err.reason, "echo [redacted]");
});

test("V1-F4: a regex-shaped but impossible issuedAt is refused before signing; a real one signs", () => {
  const k = key(); let signed = 0; const spy = { _identity: k._identity, sign: (b) => { signed++; return k.sign(b); } };
  for (const bad of ["2026-99-99T99:99:99Z", "2026-02-30T00:00:00Z", "2026-11-09T24:00:00Z", "2026-11-09T23:59:60Z"]) {
    assert.throws(() => buildIdentityBinding({ registryUuaid: REG, keychain: spy, issuedAt: bad }), code("ISSUED_AT"), `V1-F4-impossible-timestamp-refused ${bad}`);
  }
  assert.throws(() => buildIdentityBinding({ registryUuaid: REG, keychain: spy, now: () => NaN }), code("ISSUED_AT"), "a NaN clock");
  assert.equal(signed, 0, "nothing signed");
  assert.doesNotThrow(() => buildIdentityBinding({ registryUuaid: REG, keychain: k }), "positive control: now() signs");
});

test("V1-F3b: a partner key below the minimum, or with spaces, is refused before egress; an accepted key at the boundary is always redacted", async (t) => {
  const k = key(); const echoed = [];
  const server = createServer(async (req, res) => { for await (const _ of req); echoed.push(req.url); res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `rejected ${req.headers.authorization}`, reason: `echo ${req.headers.authorization?.slice(7)}` })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const mk = (pk) => new AgoraClient({ url, keychain: k, keyId: "ac-k1", registryUuaid: REG, env: { AGENT_COMMONS_OFFLINE: "0", UUAID_PARTNER_KEY: pk } });
  for (const bad of ["pk7abcd", "x".repeat(PARTNER_KEY_MIN_LENGTH - 1), "pk_live with space_abcdef", "pk_\u0007bell_abcdefghij"]) {
    const err = (() => { try { mk(bad); return null; } catch (e) { return e; } })();
    assert.equal(err?.code, "BAD_PARTNER_KEY", `refused: ${bad.length} chars`);
    assert.equal(JSON.stringify({ m: err.message, s: err.stack }).includes(bad), false, "the refusal never contains the value");
  }
  assert.equal(echoed.length, 0, "no request was made with a refused key");
  const edge = "k".repeat(PARTNER_KEY_MIN_LENGTH); // exactly the minimum: accepted, so it must be redacted everywhere
  const err = await mk(edge).joinCommunity({ source: "a", slug: "b", sourceId: "c" }).catch((e) => e);
  assert.equal(echoed.length, 1);
  for (const field of ["message", "serverError", "reason", "stack"]) assert.equal(String(err[field]).includes(edge), false, `V1-F3b-${field}-redacted`);
});
