// The public square (src/square/): signed self-listings, a public directory anyone can read without
// a credential, and a client that verifies every listing itself. Loopback squares on port 0, scratch
// sqlite files, offline mode on for every client call. Fixture keys only.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Keychain } from "../src/pillar.mjs";
import {
  SQUARE_LISTING_V, SQUARE_WITHDRAW_V, SQUARE_LISTING_LIMITS, signListing, verifyListing, signWithdraw, verifyWithdraw,
  listingMessage, withdrawMessage, carrierUrlOk,
} from "../src/square/listing.mjs";
import { createSquareServer, SQUARE_SERVER_LIMITS } from "../src/square/server.mjs";
import { publishListing, withdrawListing, resolveAgent, listDirectory, SquareClientError } from "../src/square/client.mjs";

const TMP = realpathSync(tmpdir());
const OFFLINE = Object.freeze({ AGENT_COMMONS_OFFLINE: "1" });
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const ch = (cp) => String.fromCodePoint(cp);

function agent(namespace = "agentnet") {
  const k = new Keychain("unused");
  k._identity = Keychain.generate({ uuaidNamespace: namespace });
  return k;
}
const idOf = (k) => k._identity.uuaid;
const door = (k) => ({ uuaid: k._identity.uuaid, publicKey: k._identity.publicKeyHex });
/** Sign an arbitrary listing body with `k` (for documents signListing would refuse to make). */
const signRaw = (k, body) => ({ ...body, signature: k.sign(listingMessage(body)).toString("hex") });
const baseBody = (k, at = T0, extra = {}) => ({ v: SQUARE_LISTING_V, uuaid: idOf(k), publicKey: k._identity.publicKeyHex, issuedAt: at, expiresAt: at + DAY, ...extra });

async function square(t, { limits, at = T0, dbPath } = {}) {
  const path = dbPath ?? join(mkdtempSync(join(TMP, "square-")), "square.db");
  let clock = at;
  const errors = [];
  const s = createSquareServer({ dbPath: path, now: () => clock, limits, onError: (e) => errors.push(e) });
  const { url, port } = await s.listen(0, "127.0.0.1");
  t.after(() => s.close());
  return {
    s, url, port, dbPath: path, errors,
    now: () => clock, advance: (ms) => { clock += ms; },
    c: (extra = {}) => ({ url, env: OFFLINE, now: () => clock, ...extra }),
  };
}

/** One loopback HTTP/1.1 request. */
function call(port, { method = "GET", path, headers = {}, body, raw }) {
  const bytes = raw ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false,
      headers: { ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on("error", reject);
    if (bytes) req.end(bytes); else req.end();
  });
}
const post = (sq, path, body, headers) => call(sq.port, { method: "POST", path, body, headers });
const postListing = (sq, doc) => post(sq, "/v1/square/listings", doc);

/**
 * A POST that sends only `first` and never finishes its body. Resolves with the reply, which proves
 * the square answered without reading the rest. Errors after the reply (the square closes) are expected.
 */
function partialPost(port, headers, first) {
  return new Promise((resolve, reject) => {
    let replied = false;
    const timer = setTimeout(() => { req.destroy(); reject(new Error("no reply: the square waited for the body")); }, 5000);
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/v1/square/listings", agent: false, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        replied = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        req.destroy();
      });
    });
    req.on("error", (error) => { if (!replied) { clearTimeout(timer); reject(error); } });
    req.write(first);
  });
}

/** A loopback server answering every request with `handler(req)` -> { status, body, headers }. */
async function fakeSquare(t, handler) {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(req.url);
    const { status = 200, body = {}, headers = {} } = handler(req);
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length, ...headers });
    res.end(bytes);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${srv.address().port}`, hits };
}

const rejectsCode = (promise, code) => assert.rejects(promise, (e) => e instanceof SquareClientError && e.code === code, `expected ${code}`);

// --- the documents --------------------------------------------------------------------------------

test("listing: sign and verify; closed shape; key-to-uuaid binding; bounded text; canonical carriers; key-bound doors", () => {
  const a = agent(), b = agent("pillar");
  const doc = signListing(a, { displayName: "Agent A", about: "line one\nline two", carriers: ["https://carrier.example/inbox"], doors: [door(b)], issuedAt: T0 });
  assert.equal(doc.v, SQUARE_LISTING_V);
  assert.equal(doc.expiresAt - doc.issuedAt, SQUARE_LISTING_LIMITS.defaultTtlMs);
  assert.deepEqual(verifyListing(doc, { now: T0 + MIN }), { ok: true, listing: doc });
  const reason = (d, now = T0) => verifyListing(d, { now }).reason;

  // Closed shape.
  assert.equal(reason({ ...doc, extra: 1 }), "unknown-field");
  assert.equal(reason(JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(doc).slice(1)}`)), "unknown-field");
  assert.equal(reason((({ expiresAt, ...x }) => x)(doc)), "missing-field");
  assert.equal(reason([doc]), "invalid-shape");
  assert.equal(reason(null), "invalid-shape");
  assert.equal(reason({ ...doc, v: "agent-commons/square-listing/2" }), "bad-version");
  // Any edit breaks the signature.
  assert.equal(reason({ ...doc, displayName: "Agent B" }), "bad-signature");
  assert.equal(reason({ ...doc, expiresAt: doc.expiresAt + 1 }), "bad-signature");
  assert.equal(reason({ ...doc, signature: "0".repeat(128) }), "bad-signature");
  assert.equal(reason({ ...doc, signature: doc.signature.toUpperCase() }), "bad-signature");
  // Binding: another key, a registry namespace, a non-agent object type, an upper-case key.
  assert.equal(reason(signRaw(b, baseBody(a, T0, { publicKey: b._identity.publicKeyHex }))), "key-not-bound");
  assert.equal(reason(signRaw(a, baseBody(a, T0, { uuaid: idOf(a).replace(":agentnet:", ":zilligon:") }))), "bad-uuaid");
  assert.equal(reason(signRaw(a, baseBody(a, T0, { uuaid: idOf(a).replace(":agent:", ":service:") }))), "bad-uuaid");
  assert.equal(reason(signRaw(a, baseBody(a, T0, { publicKey: a._identity.publicKeyHex.toUpperCase() }))), "bad-public-key");
  // The same key in another self-certifying namespace is the same key: accepted.
  assert.equal(verifyListing(signRaw(a, baseBody(a, T0, { uuaid: idOf(a).replace(":agentnet:", ":pillar:") })), { now: T0 }).ok, true);

  // Bounded text, counted in code points.
  const emoji = ch(0x1f600);
  assert.equal(verifyListing(signListing(a, { displayName: emoji.repeat(80), issuedAt: T0 }), { now: T0 }).ok, true);
  assert.throws(() => signListing(a, { displayName: emoji.repeat(81), issuedAt: T0 }), /bad-display-name/);
  assert.throws(() => signListing(a, { displayName: "x".repeat(81), issuedAt: T0 }), /bad-display-name/);
  for (const bad of [`a${ch(7)}b`, `a\nb`, `admin${ch(0x202e)}gnp`, `a${ch(0x200b)}b`, "   ", `a${ch(0xd800)}`]) {
    assert.equal(reason(signRaw(a, baseBody(a, T0, { displayName: bad }))), "bad-display-name", JSON.stringify(bad));
  }
  assert.equal(verifyListing(signListing(a, { about: "y".repeat(500), issuedAt: T0 }), { now: T0 }).ok, true);
  assert.throws(() => signListing(a, { about: "y".repeat(501), issuedAt: T0 }), /bad-about/);
  assert.equal(reason(signRaw(a, baseBody(a, T0, { about: `a\rb` }))), "bad-about");
  assert.equal(reason(signRaw(a, baseBody(a, T0, { displayName: 7 }))), "bad-display-name");

  // Carriers: https, or http on loopback; canonical; no credentials, query or fragment; at most 8, distinct.
  for (const ok of ["https://carrier.example/", "https://carrier.example/inbox", "http://127.0.0.1:9000/", "http://[::1]:9000/c"]) assert.equal(carrierUrlOk(ok), true, ok);
  for (const bad of ["http://carrier.example/", "https://u:p@carrier.example/", "https://carrier.example/?a=1", "https://carrier.example/#f",
    "https://carrier.example", "https://CARRIER.example/", "ftp://carrier.example/", "javascript:alert(1)", "https://", "", 5]) assert.equal(carrierUrlOk(bad), false, String(bad));
  assert.deepEqual(signListing(a, { carriers: ["https://Carrier.Example"], issuedAt: T0 }).carriers, ["https://carrier.example/"], "signListing canonicalises");
  const many = Array.from({ length: 9 }, (_, i) => `https://c${i}.example/`);
  assert.throws(() => signListing(a, { carriers: many, issuedAt: T0 }), /bad-carriers/);
  assert.equal(signListing(a, { carriers: many.slice(0, 8), issuedAt: T0 }).carriers.length, 8);
  assert.equal(reason(signRaw(a, baseBody(a, T0, { carriers: ["https://c.example/", "https://c.example/"] }))), "bad-carriers");

  // Doors: closed { uuaid, publicKey }, each key-bound, distinct, never the listing itself, at most 8.
  const c = agent();
  assert.equal(reason(signRaw(a, baseBody(a, T0, { doors: [{ uuaid: idOf(b), publicKey: c._identity.publicKeyHex }] }))), "bad-doors");
  assert.equal(reason(signRaw(a, baseBody(a, T0, { doors: [{ ...door(b), note: "x" }] }))), "bad-doors");
  assert.equal(reason(signRaw(a, baseBody(a, T0, { doors: [door(a)] }))), "bad-doors");
  assert.equal(reason(signRaw(a, baseBody(a, T0, { doors: [door(b), door(b)] }))), "bad-doors");
  assert.equal(reason(signRaw(a, baseBody(a, T0, { doors: Array.from({ length: 9 }, () => door(agent())) }))), "bad-doors");
  assert.equal(verifyListing(signRaw(a, baseBody(a, T0, { doors: Array.from({ length: 8 }, () => door(agent())) })), { now: T0 }).ok, true);

  // Time: issuedAt at most 5 min ahead, ttl at most 30 days, not expired, integers only.
  assert.equal(reason(signRaw(a, baseBody(a, T0 + 5 * MIN + 1)), T0), "issued-in-future");
  assert.equal(verifyListing(signRaw(a, baseBody(a, T0 + 5 * MIN)), { now: T0 }).ok, true);
  assert.equal(reason(signRaw(a, baseBody(a, T0, { expiresAt: T0 + 30 * DAY + 1 }))), "ttl-too-long");
  assert.equal(verifyListing(signRaw(a, baseBody(a, T0, { expiresAt: T0 + 30 * DAY })), { now: T0 }).ok, true);
  assert.equal(reason(signRaw(a, baseBody(a, T0, { expiresAt: T0 }))), "bad-time");
  assert.equal(reason(doc, doc.expiresAt), "expired");
  assert.equal(reason({ ...doc, issuedAt: T0 + 0.5 }), "bad-time");
  assert.equal(reason({ ...doc, issuedAt: String(T0) }), "bad-time");
});

test("withdrawal: sign and verify; its own version line, so a listing signature never verifies as a withdrawal", () => {
  const a = agent(), b = agent();
  const w = signWithdraw(a, { issuedAt: T0 });
  assert.equal(w.v, SQUARE_WITHDRAW_V);
  assert.deepEqual(verifyWithdraw(w, { now: T0 }), { ok: true, withdrawal: w });
  const reason = (d, now = T0) => verifyWithdraw(d, { now }).reason;
  assert.equal(reason({ ...w, extra: true }), "unknown-field");
  assert.equal(reason({ ...w, issuedAt: T0 + 1 }), "bad-signature");
  assert.equal(reason(w, T0 - 5 * MIN - 1), "issued-in-future");
  assert.equal(reason(w, T0 + 30 * DAY + 1), "expired");
  const wb = { v: SQUARE_WITHDRAW_V, uuaid: idOf(a), publicKey: b._identity.publicKeyHex, issuedAt: T0 };
  assert.equal(reason({ ...wb, signature: b.sign(withdrawMessage(wb)).toString("hex") }), "key-not-bound");
  // Cross-document: the same fields signed as a listing do not verify as a withdrawal.
  const body = { v: SQUARE_WITHDRAW_V, uuaid: idOf(a), publicKey: a._identity.publicKeyHex, issuedAt: T0 };
  assert.equal(reason({ ...body, signature: a.sign(listingMessage(body)).toString("hex") }), "bad-signature");
});

// --- the square -----------------------------------------------------------------------------------

test("publish and resolve: a roundtrip through the client; reads are public and need no credential", async (t) => {
  const sq = await square(t);
  const a = agent(), b = agent();
  const fields = { displayName: "Agent A", about: "Hello square.", carriers: [`${sq.url}/carrier`], doors: [door(b)] };
  const pub = await publishListing({ ...sq.c(), keychain: a, fields });
  assert.equal(pub.result.ok, true);
  assert.equal(pub.result.created, true);
  assert.equal(pub.listing.issuedAt, T0);
  const got = await resolveAgent({ ...sq.c(), uuaid: idOf(a) });
  assert.deepEqual(got, { listing: pub.listing, dropped: 0 });
  assert.equal(got.listing.displayName, "Agent A");

  // Raw read: no credential, any origin may read, never with credentials.
  const raw = await call(sq.port, { path: `/v1/square/resolve?uuaid=${encodeURIComponent(idOf(a))}`, headers: { origin: "https://elsewhere.example" } });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers["access-control-allow-origin"], "*");
  assert.equal(raw.headers["access-control-allow-credentials"], undefined);
  assert.equal(raw.headers["set-cookie"], undefined);
  assert.equal(raw.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(raw.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(raw.body.listing, pub.listing, "the verified document, as stored");
  // An unescaped colon in the query works too.
  assert.equal((await call(sq.port, { path: `/v1/square/resolve?uuaid=${idOf(a)}` })).status, 200);

  // Writes are never cached.
  const again = await postListing(sq, signListing(a, { issuedAt: T0 + 1 }));
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.headers["cache-control"], "no-store");

  // Not listed / malformed.
  assert.deepEqual(await resolveAgent({ ...sq.c(), uuaid: idOf(b) }), { listing: null, dropped: 0 });
  assert.deepEqual((await call(sq.port, { path: `/v1/square/resolve?uuaid=${idOf(b)}` })).body, { error: "not-listed" });
  assert.equal((await call(sq.port, { path: "/v1/square/resolve?uuaid=nope" })).status, 400);
  assert.equal((await call(sq.port, { path: "/v1/square/resolve" })).status, 400);
  assert.deepEqual(sq.errors, []);
});

test("directory: public, keyset-paged by uuaid, stable across updates; bounded limit; strict query", async (t) => {
  const sq = await square(t);
  const agents = Array.from({ length: 5 }, () => agent());
  for (const k of agents) await publishListing({ ...sq.c(), keychain: k, fields: { displayName: "n" } });
  const expected = agents.map(idOf).sort();

  const pages = [];
  let cursor = null;
  do {
    const page = await listDirectory({ ...sq.c(), limit: 2, cursor });
    assert.equal(page.dropped, 0);
    pages.push(page.listings.map(l => l.uuaid));
    cursor = page.next;
  } while (cursor);
  assert.deepEqual(pages.map(p => p.length), [2, 2, 1]);
  assert.deepEqual(pages.flat(), expected);

  // An update keeps its place: no duplicate, nothing skipped.
  sq.advance(1000);
  await publishListing({ ...sq.c(), keychain: agents[2], fields: { displayName: "renamed" } });
  const first = await listDirectory({ ...sq.c(), limit: 3 });
  const rest = await listDirectory({ ...sq.c(), limit: 3, cursor: first.next });
  assert.deepEqual([...first.listings, ...rest.listings].map(l => l.uuaid), expected);
  assert.equal(rest.next, null);
  assert.equal([...first.listings, ...rest.listings].find(l => l.uuaid === idOf(agents[2])).displayName, "renamed");

  // The whole directory in one default page; with no credential and from any origin.
  const all = await call(sq.port, { path: "/v1/square/directory", headers: { origin: "https://elsewhere.example" } });
  assert.equal(all.status, 200);
  assert.equal(all.body.listings.length, 5);
  assert.equal(all.body.next, null);
  assert.equal(all.headers["access-control-allow-origin"], "*");

  for (const q of ["limit=0", `limit=${SQUARE_SERVER_LIMITS.pageMax + 1}`, "limit=abc", "limit=01", "cursor=x", "limit=2&limit=3", "page=1", "limit"]) {
    const r = await call(sq.port, { path: `/v1/square/directory?${q}` });
    assert.equal(r.status, 400, q);
  }
  assert.equal((await call(sq.port, { path: `/v1/square/directory?limit=${SQUARE_SERVER_LIMITS.pageMax}` })).status, 200);
  await rejectsCode(listDirectory({ ...sq.c(), limit: 101 }), "bad-limit");
});

test("refusals: a tampered listing, a key not bound to its uuaid, a non-object body; errors never echo the request", async (t) => {
  const sq = await square(t);
  const a = agent(), b = agent();
  const doc = signListing(a, { displayName: "honest-name", issuedAt: T0 });
  const tampered = await postListing(sq, { ...doc, displayName: "CANARY-forged-name" });
  assert.equal(tampered.status, 400);
  assert.deepEqual(tampered.body, { error: "bad-signature" });
  assert.equal(tampered.text.includes("CANARY"), false);
  assert.equal(tampered.headers["cache-control"], "no-store");

  // A's uuaid with B's key, signed by B: the signature is fine, the binding is not.
  const unbound = await postListing(sq, signRaw(b, baseBody(a, T0, { publicKey: b._identity.publicKeyHex })));
  assert.deepEqual([unbound.status, unbound.body], [400, { error: "key-not-bound" }]);
  // A's uuaid and key, signed by B.
  const wrongSigner = { ...baseBody(a, T0), signature: b.sign(listingMessage(baseBody(a, T0))).toString("hex") };
  assert.deepEqual((await postListing(sq, wrongSigner)).body, { error: "bad-signature" });
  assert.deepEqual((await postListing(sq, { ...doc, CANARY_field: 1 })).body, { error: "unknown-field" });
  assert.deepEqual((await post(sq, "/v1/square/listings", [doc])).body, { error: "invalid-json" });
  const notJson = await call(sq.port, { method: "POST", path: "/v1/square/listings", raw: Buffer.from("{CANARY"), headers: { "content-type": "application/json" } });
  assert.deepEqual([notJson.status, notJson.body], [400, { error: "invalid-json" }]);
  const bom = await call(sq.port, { method: "POST", path: "/v1/square/listings", raw: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(doc))]) });
  assert.deepEqual(bom.body, { error: "invalid-json" });
  // A withdrawal is not a listing, and a listing is not a withdrawal.
  assert.deepEqual((await postListing(sq, signWithdraw(a, { issuedAt: T0 }))).body, { error: "missing-field" });
  assert.equal((await post(sq, "/v1/square/withdraw", doc)).status, 400);
  // Nothing was listed.
  assert.deepEqual((await listDirectory(sq.c())).listings, []);
  assert.deepEqual(sq.errors, []);
});

test("rollback: an older or repeated issuedAt is refused 409, also after the newer one expired or the square restarted", async (t) => {
  const sq = await square(t);
  const a = agent();
  const long = signListing(a, { displayName: "v1", issuedAt: T0, ttlMs: 30 * DAY });
  const short = signListing(a, { displayName: "v2", issuedAt: T0 + 1000, ttlMs: HOUR });
  assert.equal((await postListing(sq, long)).status, 200);
  assert.equal((await postListing(sq, short)).status, 200);
  assert.deepEqual((await postListing(sq, long)).body, { error: "stale" });
  assert.equal((await postListing(sq, long)).status, 409);
  assert.equal((await postListing(sq, short)).status, 409, "the same document twice");
  assert.equal((await resolveAgent({ ...sq.c(), uuaid: idOf(a) })).listing.displayName, "v2");

  // v2 expires and is pruned; v1 is still within its own lifetime, but the square remembers v2's issuedAt.
  sq.advance(2 * HOUR);
  assert.equal((await resolveAgent({ ...sq.c(), uuaid: idOf(a) })).listing, null);
  assert.equal((await postListing(sq, long)).status, 409);

  // The high-water mark survives a restart.
  await sq.s.close();
  const again = await square(t, { dbPath: sq.dbPath, at: sq.now() });
  assert.equal((await postListing(again, long)).status, 409);
  const v3 = signListing(a, { displayName: "v3", issuedAt: again.now() });
  assert.equal((await postListing(again, v3)).status, 200);
  assert.equal((await resolveAgent({ ...again.c(), uuaid: idOf(a) })).listing.displayName, "v3");
});

test("withdraw: removes the listing; the old listing cannot be replayed back in, nor an old withdrawal replayed over a new listing", async (t) => {
  const sq = await square(t);
  const a = agent(), b = agent();
  const first = await publishListing({ ...sq.c(), keychain: a, fields: { displayName: "A" } });
  await publishListing({ ...sq.c(), keychain: b, fields: { displayName: "B" } });
  sq.advance(1000);
  const w = await withdrawListing({ ...sq.c(), keychain: a });
  assert.deepEqual(w.result, { ok: true, uuaid: idOf(a), removed: true });
  assert.equal((await resolveAgent({ ...sq.c(), uuaid: idOf(a) })).listing, null);
  assert.deepEqual((await listDirectory(sq.c())).listings.map(l => l.uuaid), [idOf(b)]);

  // Replay of the withdrawn listing.
  assert.deepEqual([(await postListing(sq, first.listing)).status], [409]);
  // A new listing, then the old withdrawal replayed.
  sq.advance(1000);
  await publishListing({ ...sq.c(), keychain: a, fields: { displayName: "A again" } });
  const replay = await post(sq, "/v1/square/withdraw", w.withdrawal);
  assert.deepEqual([replay.status, replay.body], [409, { error: "stale" }]);
  assert.equal((await resolveAgent({ ...sq.c(), uuaid: idOf(a) })).listing.displayName, "A again");
  // Someone else's withdrawal (B's key, A's uuaid) is refused.
  const forged = { v: SQUARE_WITHDRAW_V, uuaid: idOf(a), publicKey: b._identity.publicKeyHex, issuedAt: sq.now() + 1 };
  assert.deepEqual((await post(sq, "/v1/square/withdraw", { ...forged, signature: b.sign(withdrawMessage(forged)).toString("hex") })).body, { error: "key-not-bound" });
  assert.equal((await resolveAgent({ ...sq.c(), uuaid: idOf(a) })).listing.displayName, "A again");
  // Withdrawing with nothing listed still sets the mark.
  sq.advance(1000);
  const c = agent();
  assert.deepEqual((await withdrawListing({ ...sq.c(), keychain: c })).result, { ok: true, uuaid: idOf(c), removed: false });
});

test("expiry: an expired listing is not returned and is pruned; an already-expired listing is refused", async (t) => {
  const sq = await square(t);
  const a = agent(), b = agent();
  await publishListing({ ...sq.c(), keychain: a, fields: { ttlMs: 1000 } });
  await publishListing({ ...sq.c(), keychain: b, fields: { ttlMs: DAY } });
  assert.equal((await listDirectory(sq.c())).listings.length, 2);
  sq.advance(1000);
  assert.equal((await resolveAgent({ ...sq.c(), uuaid: idOf(a) })).listing, null);
  const raw = await call(sq.port, { path: "/v1/square/directory" });
  assert.deepEqual(raw.body.listings.map(l => l.uuaid), [idOf(b)]);
  const db = new DatabaseSync(sq.dbPath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listings WHERE uuaid = ?").get(idOf(a)).n, 0, "pruned on read"); }
  finally { db.close(); }
  const stale = signListing(a, { issuedAt: sq.now() - 2000, ttlMs: 1000 });
  assert.deepEqual((await postListing(sq, stale)).body, { error: "expired" });
  const future = signRaw(a, baseBody(a, sq.now() + 6 * MIN));
  assert.deepEqual((await postListing(sq, future)).body, { error: "issued-in-future" });
});

test("body cap: over 8 KiB is refused 413 at once, by declared length or while reading, without reading the rest", async (t) => {
  const sq = await square(t);
  assert.equal(sq.s.limits.bodyBytes, 8 * 1024);
  // Declared 10 MiB, 64 bytes sent, the rest never: the reply comes anyway, and closes the connection.
  const declared = await partialPost(sq.port, { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) }, Buffer.alloc(64, 0x20));
  assert.deepEqual([declared.status, declared.body], [413, { error: "too-large" }]);
  assert.equal(declared.headers.connection, "close");
  // Chunked: 9 KiB sent, the body never ends; the square stops at the cap.
  const chunked = await partialPost(sq.port, { "content-type": "application/json", "transfer-encoding": "chunked" }, Buffer.alloc(9 * 1024, 0x61));
  assert.deepEqual([chunked.status, chunked.body], [413, { error: "too-large" }]);
  assert.equal(chunked.headers.connection, "close");
  // Exactly at the cap is read (and then judged as JSON).
  const atCap = await call(sq.port, { method: "POST", path: "/v1/square/listings", raw: Buffer.alloc(8 * 1024, 0x20), headers: { "content-type": "application/json" } });
  assert.deepEqual([atCap.status, atCap.body], [400, { error: "invalid-json" }]);
  // The square is still serving.
  assert.equal((await call(sq.port, { path: "/v1/square/directory" })).status, 200);
});

test("content type: anything but application/json is refused 415 before the body is read", async (t) => {
  const sq = await square(t);
  const a = agent();
  const doc = signListing(a, { issuedAt: T0 });
  for (const type of ["text/plain", "application/jsonx", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/json; charset=latin1"]) {
    const r = await call(sq.port, { method: "POST", path: "/v1/square/listings", raw: Buffer.from(JSON.stringify(doc)), headers: { "content-type": type } });
    assert.deepEqual([r.status, r.body], [415, { error: "unsupported-media-type" }], type);
  }
  const none = await call(sq.port, { method: "POST", path: "/v1/square/listings", raw: Buffer.from(JSON.stringify(doc)), headers: { "content-type": "" } });
  assert.equal(none.status, 415);
  // 415 is decided on the headers alone: a never-finished body still gets its reply.
  const partial = await partialPost(sq.port, { "content-type": "text/plain", "content-length": "4096" }, Buffer.alloc(16, 0x20));
  assert.equal(partial.status, 415);
  const ok = await call(sq.port, { method: "POST", path: "/v1/square/listings", raw: Buffer.from(JSON.stringify(doc)), headers: { "content-type": "Application/JSON; charset=UTF-8" } });
  assert.equal(ok.status, 200);
});

test("routes: unknown path 404, wrong method 405 with Allow, a body on a read 400", async (t) => {
  const sq = await square(t);
  for (const path of ["/", "/v1/square", "/v1/square/directory/", "/v1/square/listings/x", "/v1/fleet/alerts", "/v1/square/../square/directory"]) {
    const r = await call(sq.port, { path });
    assert.deepEqual([r.status, r.body], [404, { error: "not-found" }], path);
  }
  const m1 = await call(sq.port, { method: "POST", path: "/v1/square/directory", body: {} });
  assert.deepEqual([m1.status, m1.headers.allow], [405, "GET"]);
  const m2 = await call(sq.port, { method: "GET", path: "/v1/square/listings" });
  assert.deepEqual([m2.status, m2.headers.allow], [405, "POST"]);
  assert.equal((await call(sq.port, { method: "DELETE", path: "/v1/square/resolve" })).status, 405);
  assert.equal((await call(sq.port, { method: "OPTIONS", path: "/v1/square/listings", headers: { origin: "https://x.example", "access-control-request-method": "POST" } })).status, 405);
  assert.equal((await call(sq.port, { method: "GET", path: "/v1/square/directory", raw: Buffer.from("{}") })).status, 400);
  assert.equal((await call(sq.port, { method: "POST", path: "/v1/square/listings?x=1", body: {} })).status, 400);
  assert.equal((await call(sq.port, { path: `/v1/square/directory?cursor=${"a".repeat(3000)}` })).status, 414);
});

test("rate limits: per key (only fresh verified documents count; forgeries and replays do not) 429, per source 429, total listings 507", async (t) => {
  const sq = await square(t, { limits: { writesPerKeyPerHour: 3, writesPerSourcePerHour: 50 } });
  const a = agent(), b = agent();
  // Forged documents claiming A's key do not spend A's budget.
  for (let i = 0; i < 5; i++) assert.equal((await postListing(sq, { ...signListing(a, { issuedAt: T0 + i }), displayName: "forged" })).status, 400);
  // Nor do replays of A's (public) listing: anyone can read it and post it again.
  const published = signListing(a, { issuedAt: T0 });
  assert.equal((await postListing(sq, published)).status, 200, "write 1");
  const copy = (await call(sq.port, { path: `/v1/square/resolve?uuaid=${idOf(a)}` })).body.listing;
  for (let i = 0; i < 5; i++) assert.equal((await postListing(sq, copy)).status, 409);
  for (let i = 1; i < 3; i++) assert.equal((await postListing(sq, signListing(a, { issuedAt: T0 + i }))).status, 200, `write ${i + 1}`);
  const limited = await postListing(sq, signListing(a, { issuedAt: T0 + 10 }));
  assert.deepEqual([limited.status, limited.body], [429, { error: "rate-limited" }]);
  await rejectsCode(withdrawListing({ ...sq.c(), keychain: a }), "stale");
  await rejectsCode(withdrawListing({ ...sq.c({ now: () => T0 + 20 }), keychain: a }), "rate-limited");
  assert.equal((await postListing(sq, signListing(b, { issuedAt: T0 }))).status, 200, "another key is unaffected");
  sq.advance(HOUR + 1);
  assert.equal((await postListing(sq, signListing(a, { issuedAt: sq.now() }))).status, 200, "the window slides");

  const perSource = await square(t, { limits: { writesPerSourcePerHour: 2 } });
  assert.equal((await postListing(perSource, signListing(a, { issuedAt: T0 }))).status, 200);
  assert.equal((await postListing(perSource, { not: "valid" })).status, 400, "an invalid attempt still counts against the source");
  assert.deepEqual((await postListing(perSource, signListing(b, { issuedAt: T0 }))).body, { error: "rate-limited" });

  const full = await square(t, { limits: { maxListings: 2 } });
  const c = agent();
  assert.equal((await postListing(full, signListing(a, { issuedAt: T0 }))).status, 200);
  assert.equal((await postListing(full, signListing(b, { issuedAt: T0 }))).status, 200);
  const over = await postListing(full, signListing(c, { issuedAt: T0 }));
  assert.deepEqual([over.status, over.body], [507, { error: "directory-full" }]);
  assert.equal((await postListing(full, signListing(a, { issuedAt: T0 + 1 }))).status, 200, "an update of a listed agent still fits");
});

// --- the client trusts the square for nothing ------------------------------------------------------

test("client: drops listings a lying square altered or forged (rows corrupted in the square's own database)", async (t) => {
  const sq = await square(t);
  const a = agent(), b = agent(), c = agent(), d = agent();
  const la = (await publishListing({ ...sq.c(), keychain: a, fields: { displayName: "A" } })).listing;
  await publishListing({ ...sq.c(), keychain: b, fields: { displayName: "B" } });
  // Corrupt the database behind the square: A's display name rewritten; a forged row for C signed by D.
  const db = new DatabaseSync(sq.dbPath);
  try {
    db.prepare("UPDATE listings SET doc = ? WHERE uuaid = ?").run(JSON.stringify({ ...la, displayName: "A (now owned by mallory)" }), idOf(a));
    const forged = signRaw(d, baseBody(c, T0, { publicKey: d._identity.publicKeyHex, displayName: "C" }));
    db.prepare("INSERT INTO listings(uuaid, public_key, issued_at, expires_at, doc) VALUES(?, ?, ?, ?, ?)").run(idOf(c), d._identity.publicKeyHex, T0, T0 + DAY, JSON.stringify(forged));
  } finally { db.close(); }
  const page = await listDirectory(sq.c());
  assert.deepEqual(page.listings.map(l => l.uuaid), [idOf(b)]);
  assert.equal(page.dropped, 2);
  assert.deepEqual(await resolveAgent({ ...sq.c(), uuaid: idOf(a) }), { listing: null, dropped: 1, reason: "bad-signature" });
  assert.deepEqual(await resolveAgent({ ...sq.c(), uuaid: idOf(c) }), { listing: null, dropped: 1, reason: "key-not-bound" });
});

test("client: drops a substituted, repeated or expired listing from a fake square, and never follows a redirect", async (t) => {
  const a = agent(), b = agent();
  const now = () => T0 + MIN;
  const lb = signListing(b, { displayName: "B", issuedAt: T0 });
  const la = signListing(a, { displayName: "A", issuedAt: T0 });
  const old = signListing(a, { issuedAt: T0 - 2 * DAY, ttlMs: DAY });
  const liar = await fakeSquare(t, (req) => req.url.startsWith("/v1/square/resolve")
    ? { body: { listing: lb } }                                             // asked for A, answers with B's (valid) listing
    : { body: { listings: [la, la, lb, old, { junk: true }], next: "not-a-cursor" } });
  assert.deepEqual(await resolveAgent({ url: liar.url, uuaid: idOf(a), env: OFFLINE, now }), { listing: null, dropped: 1, reason: "uuaid-mismatch" });
  const page = await listDirectory({ url: liar.url, env: OFFLINE, now });
  assert.deepEqual(page.listings.map(l => l.uuaid), [idOf(a), idOf(b)]);
  assert.equal(page.dropped, 3);
  assert.equal(page.next, null);

  // A loopback square that redirects: the target is never contacted.
  const target = await fakeSquare(t, () => ({ body: { listing: la } }));
  const bouncer = await fakeSquare(t, () => ({ status: 302, body: {}, headers: { location: `${target.url}/v1/square/resolve?uuaid=${encodeURIComponent(idOf(a))}` } }));
  await rejectsCode(resolveAgent({ url: bouncer.url, uuaid: idOf(a), env: OFFLINE, now }), "redirect-refused");
  assert.equal(target.hits.length, 0);
  assert.equal(bouncer.hits.length, 1);

  // A response over the cap is refused, not buffered.
  const big = await fakeSquare(t, () => ({ body: { listings: [], pad: "x".repeat(4096) } }));
  await rejectsCode(listDirectory({ url: big.url, env: OFFLINE, now, responseBytes: 1024 }), "response-too-large");
});

test("offline mode: a non-loopback square is refused before any network call; plain http off loopback is always refused", async () => {
  const a = agent();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("network reached"); };
  const remote = "https://square.example.org";
  for (const env of [OFFLINE, {}]) {
    await rejectsCode(publishListing({ url: remote, keychain: a, env, fetchImpl }), "offline");
    await rejectsCode(withdrawListing({ url: remote, keychain: a, env, fetchImpl }), "offline");
    await rejectsCode(resolveAgent({ url: remote, uuaid: idOf(a), env, fetchImpl }), "offline");
    await rejectsCode(listDirectory({ url: remote, env, fetchImpl }), "offline");
  }
  const err = await listDirectory({ url: remote, env: OFFLINE, fetchImpl }).catch(e => e);
  assert.match(err.message, /^offline: refused outbound square call to https:\/\/square\.example\.org$/);
  // Online, plain http to another host is still refused; so are odd URLs.
  const online = { AGENT_COMMONS_OFFLINE: "0" };
  await rejectsCode(listDirectory({ url: "http://square.example.org", env: online, fetchImpl }), "insecure-url");
  await rejectsCode(listDirectory({ url: "https://user:pw@square.example.org", env: online, fetchImpl }), "bad-url");
  await rejectsCode(listDirectory({ url: "file:///etc/passwd", env: online, fetchImpl }), "bad-url");
  await rejectsCode(listDirectory({ url: "http://127.0.0.1.example.org", env: OFFLINE, fetchImpl }), "offline");
  assert.equal(calls, 0, "fetch was never called");
});

// Behind a reverse proxy on the same host, every request arrives from loopback; trustProxy rate-limits by the address
// the proxy saw (the RIGHT-most X-Forwarded-For entry) and never by anything a client can choose.
test("square: sourceOf uses only the right-most X-Forwarded-For entry, and only from a loopback socket", async () => {
  const { sourceOf } = await import("../src/square/server.mjs");
  const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  assert.equal(sourceOf(req("127.0.0.1", "203.0.113.9"), true), "203.0.113.9");
  // A client-supplied left-hand entry is ignored: the proxy appended the real address last.
  assert.equal(sourceOf(req("127.0.0.1", "6.6.6.6, 203.0.113.9"), true), "203.0.113.9");
  assert.equal(sourceOf(req("::ffff:127.0.0.1", "2001:db8::1"), true), "2001:db8::1");
  // Off by default, and never trusted from a non-loopback socket.
  assert.equal(sourceOf(req("127.0.0.1", "203.0.113.9"), false), "127.0.0.1");
  assert.equal(sourceOf(req("198.51.100.7", "203.0.113.9"), true), "198.51.100.7");
  // Malformed or oversized values fall back to the socket address.
  assert.equal(sourceOf(req("127.0.0.1", "not an ip"), true), "127.0.0.1");
  assert.equal(sourceOf(req("127.0.0.1", "1.2.3.4," + "x".repeat(600)), true), "127.0.0.1");
  assert.equal(sourceOf(req("127.0.0.1"), true), "127.0.0.1");
});
