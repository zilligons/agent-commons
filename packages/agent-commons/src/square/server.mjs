// The public square: a small directory any agent can join by presenting its key, and anyone can
// read without a credential. Separate from src/relay/ (the invite-only fleet relay): no roster, no
// invite, no account. A write is admitted on the strength of its own signature (listing.mjs); a read
// needs nothing at all ("gate speech if you must, never sight").
//
// Routes (closed; JSON only):
//   GET  /v1/square/directory?limit=&cursor=  public; current listings, ordered by uuaid, keyset-paged
//   GET  /v1/square/resolve?uuaid=            public; one listing, or 404
//   POST /v1/square/listings                  a signed listing; upserted only if its issuedAt is newer
//                                             than anything this square has accepted for the uuaid
//   POST /v1/square/withdraw                  a signed withdrawal; removes the listing if newer
// Any other path 404; a known path with another method 405 (with Allow).
//
// Every write, in this order, before any state changes: the URL length cap; the route; the method;
// no query; Content-Type application/json (415); a declared Content-Length over the cap (413, read no
// byte); the per-source attempt cap (429); the body, read only up to the cap (413 the moment it is
// passed); a strict UTF-8 JSON object; the document's own verification (400 with a fixed reason
// code); then one transaction: prune, the high-water check (409), the per-key cap (429; charged only
// for a verified document newer than anything seen, which only the key holder can make, so neither
// a forgery nor a replay of a public listing spends another key's budget), the caps (507), the write.
//
// Rollback: the square keeps, per uuaid, the newest issuedAt it has accepted (listing or withdrawal)
// for maxTtlMs after that issuedAt. Any older listing has expired by the time its mark is dropped, so
// an expired-and-pruned or withdrawn listing cannot be replayed back in.
// Errors are { error: <fixed code> } and never echo any part of the request.

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { jcs } from "../vendor/pillar/identity/jcs.mjs";
import { SELF_CERTIFYING_AGENT_UUAID } from "../uuaid-namespace.mjs";
import { SQUARE_LISTING_LIMITS, verifyListing, verifyWithdraw } from "./listing.mjs";

export const SQUARE_DIRECTORY_V = "agent-commons/square-directory/1";
export const SQUARE_SERVER_LIMITS = Object.freeze({
  bodyBytes: 8 * 1024,          // one listing or withdrawal
  urlBytes: 2048,
  pageDefault: 50,
  pageMax: 100,
  writesPerKeyPerHour: 10,      // verified write attempts per public key
  writesPerSourcePerHour: 60,   // write attempts per socket address (behind a proxy: one shared bucket)
  maxListings: 10000,
  maxMarks: 50000,              // per-uuaid high-water marks, withdrawals included
  rateEntriesMax: 100000,       // tracked keys + sources in memory
  maxConnections: 512,
});
const WINDOW_MS = 3600000;
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,39})$/;
/**
 * The rate-limit source for a write. By default the socket address. With `trustProxy`, and ONLY when the socket is
 * loopback (a reverse proxy on this host), the right-most X-Forwarded-For entry: the address that proxy itself saw.
 * Entries further left are client-supplied and never used, so a client cannot pick its own bucket. Anything malformed
 * falls back to the socket address.
 */
export function sourceOf(req, trustProxy = false) {
  const remote = String(req.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  if (!trustProxy || !LOOPBACK.has(remote)) return remote;
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff !== "string" || xff.length > 512) return remote;
  const last = xff.split(",").pop().trim().replace(/^::ffff:/, "");
  return IP_LITERAL.test(last) ? last : remote;
}
/** Public reads: any origin may read; no credentials are ever allowed (no Allow-Credentials header). */
const PUBLIC_READ = Object.freeze({ "access-control-allow-origin": "*" });

export const SQUARE_ROUTES = Object.freeze({
  "/v1/square/directory": Object.freeze({ method: "GET", query: Object.freeze(["limit", "cursor"]) }),
  "/v1/square/resolve": Object.freeze({ method: "GET", query: Object.freeze(["uuaid"]) }),
  "/v1/square/listings": Object.freeze({ method: "POST", query: Object.freeze([]) }),
  "/v1/square/withdraw": Object.freeze({ method: "POST", query: Object.freeze([]) }),
});

class SquareHttpError extends Error {
  constructor(status, code, { close = false, headers = null } = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.close = close;
    this.headers = headers;
  }
}
const refuse = (status, code, opts) => new SquareHttpError(status, code, opts);

const DDL = `
CREATE TABLE IF NOT EXISTS listings(
  uuaid TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  doc TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS listings_expiry ON listings(expires_at);
CREATE TABLE IF NOT EXISTS marks(
  uuaid TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL,
  keep_until INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS marks_keep ON marks(keep_until);`;

function resolveLimits(limits) {
  const out = { ...SQUARE_SERVER_LIMITS };
  if (limits === undefined || limits === null) return Object.freeze(out);
  if (typeof limits !== "object" || Array.isArray(limits)) throw new TypeError("square: limits must be an object");
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(SQUARE_SERVER_LIMITS, key)) throw new TypeError(`square: unknown limit ${JSON.stringify(key.slice(0, 40))}`);
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`square: limit ${key} must be a positive integer`);
    out[key] = value;
  }
  if (out.pageDefault > out.pageMax) throw new TypeError("square: pageDefault must be <= pageMax");
  if (out.bodyBytes > 1024 * 1024) throw new TypeError("square: bodyBytes must be <= 1 MiB");
  return Object.freeze(out);
}

function openDb(dbPath) {
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("square: dbPath is required");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(DDL);
  if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
  return db;
}

/** Strict query: only the route's keys, each once; values validated per key. */
function parseQuery(path, query, limits) {
  const allowed = SQUARE_ROUTES[path].query;
  const out = {};
  if (query !== "") {
    for (const part of query.split("&")) {
      const eq = part.indexOf("=");
      const key = eq < 0 ? part : part.slice(0, eq);
      if (!allowed.includes(key) || Object.hasOwn(out, key) || eq < 0) throw refuse(400, "invalid-query");
      try { out[key] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " ")); } catch { throw refuse(400, "invalid-query"); }
    }
  }
  if (Object.hasOwn(out, "limit")) {
    if (!/^[1-9][0-9]{0,3}$/.test(out.limit) || Number(out.limit) > limits.pageMax) throw refuse(400, "invalid-limit");
    out.limit = Number(out.limit);
  }
  if (Object.hasOwn(out, "cursor") && !SELF_CERTIFYING_AGENT_UUAID.test(out.cursor)) throw refuse(400, "invalid-cursor");
  if (path === "/v1/square/resolve" && (typeof out.uuaid !== "string" || !SELF_CERTIFYING_AGENT_UUAID.test(out.uuaid))) throw refuse(400, "invalid-uuaid");
  return out;
}

function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  const [type, ...params] = value.split(";").map(s => s.trim().toLowerCase());
  if (type !== "application/json") return false;
  return params.every(p => p === "charset=utf-8" || p === "charset=\"utf-8\"");
}

/** Read the body, never past `cap`: the moment it is passed, stop reading and refuse 413. */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; req.off("data", onData); fn(v); };
    const onData = (chunk) => {
      n += chunk.length;
      if (n > cap) { req.pause(); return done(reject, refuse(413, "too-large", { close: true })); }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => done(resolve, Buffer.concat(chunks, n)));
    req.once("error", () => done(reject, refuse(400, "aborted", { close: true })));
    req.once("close", () => done(reject, refuse(400, "aborted", { close: true })));
  });
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function parseJsonObject(bytes) {
  if (bytes.length === 0) throw refuse(400, "missing-body");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw refuse(400, "invalid-json");
  let value;
  try { value = JSON.parse(UTF8.decode(bytes)); } catch { throw refuse(400, "invalid-json"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw refuse(400, "invalid-json");
  return value;
}

/** Sliding one-hour attempt counter per id, bounded in ids. */
function rateTable(maxEntries) {
  const table = new Map();
  const sweep = (t) => { for (const [id, times] of table) { const recent = times.filter(x => x > t - WINDOW_MS); if (recent.length) table.set(id, recent); else table.delete(id); } };
  return {
    take(id, limit, t, shared) {
      const recent = (table.get(id) ?? []).filter(x => x > t - WINDOW_MS);
      if (recent.length >= limit) { table.set(id, recent); return false; }
      if (!table.has(id) && shared.size() >= maxEntries) { shared.sweep(t); if (shared.size() >= maxEntries) return false; }
      recent.push(t);
      table.set(id, recent);
      return true;
    },
    size: () => table.size,
    sweep,
  };
}

/**
 * Create a square over one sqlite database. `now()` is square time in ms (injectable for tests).
 * `limits` overrides SQUARE_SERVER_LIMITS. `onError(error)` receives internal errors only (never a
 * request body). Returns { listen(port, host), close(), address() }.
 */
export function createSquareServer({ dbPath, now = () => Date.now(), limits, onError = () => {}, trustProxy = false } = {}) {
  if (typeof now !== "function") throw new TypeError("square: now must be a function");
  if (typeof trustProxy !== "boolean") throw new TypeError("square: trustProxy must be a boolean");
  const lim = resolveLimits(limits);
  const db = openDb(dbPath);
  const sql = {
    prune: db.prepare("DELETE FROM listings WHERE expires_at <= ?"),
    pruneMarks: db.prepare("DELETE FROM marks WHERE keep_until <= ?"),
    page: db.prepare("SELECT uuaid, doc FROM listings WHERE expires_at > ? AND uuaid > ? ORDER BY uuaid LIMIT ?"),
    one: db.prepare("SELECT doc FROM listings WHERE uuaid = ? AND expires_at > ?"),
    listing: db.prepare("SELECT issued_at FROM listings WHERE uuaid = ?"),
    mark: db.prepare("SELECT issued_at FROM marks WHERE uuaid = ?"),
    countListings: db.prepare("SELECT COUNT(*) AS n FROM listings"),
    countMarks: db.prepare("SELECT COUNT(*) AS n FROM marks"),
    upsert: db.prepare(`INSERT INTO listings(uuaid, public_key, issued_at, expires_at, doc) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(uuaid) DO UPDATE SET public_key = excluded.public_key, issued_at = excluded.issued_at, expires_at = excluded.expires_at, doc = excluded.doc`),
    remove: db.prepare("DELETE FROM listings WHERE uuaid = ?"),
    setMark: db.prepare(`INSERT INTO marks(uuaid, issued_at, keep_until) VALUES(?, ?, ?)
      ON CONFLICT(uuaid) DO UPDATE SET issued_at = excluded.issued_at, keep_until = excluded.keep_until`),
  };
  const perKey = rateTable(lim.rateEntriesMax), perSource = rateTable(lim.rateEntriesMax);
  const shared = { size: () => perKey.size() + perSource.size(), sweep: (t) => { perKey.sweep(t); perSource.sweep(t); } };

  function clock() {
    const t = now();
    if (!Number.isSafeInteger(t)) throw new Error("square clock must return integer ms");
    return t;
  }
  function prune(t) { sql.prune.run(t); sql.pruneMarks.run(t); }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  /** The newest issuedAt this square has accepted for `uuaid`, or -1. */
  function highWater(uuaid) {
    return Math.max(sql.listing.get(uuaid)?.issued_at ?? -1, sql.mark.get(uuaid)?.issued_at ?? -1);
  }
  function markSlot(uuaid) {
    if (!sql.mark.get(uuaid) && sql.countMarks.get().n >= lim.maxMarks) throw refuse(507, "directory-full");
  }

  function directory(q, t) {
    const limit = q.limit ?? lim.pageDefault;
    const rows = sql.page.all(t, q.cursor ?? "", limit + 1);
    // A row that is not JSON (a damaged database) is left out rather than failing the page; the
    // client verifies every listing it receives in any case.
    const listings = [];
    for (const r of rows.slice(0, limit)) { try { listings.push(JSON.parse(r.doc)); } catch (error) { onError(error); } }
    return { v: SQUARE_DIRECTORY_V, listings, next: rows.length > limit ? rows[limit - 1].uuaid : null };
  }
  function resolve(q, t) {
    const row = sql.one.get(q.uuaid, t);
    let listing = null;
    if (row) { try { listing = JSON.parse(row.doc); } catch (error) { onError(error); } }
    if (!listing) throw refuse(404, "not-listed", { headers: PUBLIC_READ });
    return { v: SQUARE_DIRECTORY_V, listing };
  }
  function keyGate(publicKey, t) {
    if (!perKey.take(publicKey, lim.writesPerKeyPerHour, t, shared)) throw refuse(429, "rate-limited");
  }
  function postListing(body, t) {
    const v = verifyListing(body, { now: t });
    if (!v.ok) throw refuse(400, v.reason);
    const doc = v.listing;
    return transaction(() => {
      prune(t);
      // Stale before the key budget: a listing is public, so a replay must not spend its key's budget.
      if (doc.issuedAt <= highWater(doc.uuaid)) throw refuse(409, "stale");
      keyGate(doc.publicKey, t);
      const existing = sql.listing.get(doc.uuaid);
      if (!existing && sql.countListings.get().n >= lim.maxListings) throw refuse(507, "directory-full");
      markSlot(doc.uuaid);
      sql.upsert.run(doc.uuaid, doc.publicKey, doc.issuedAt, doc.expiresAt, jcs(doc));
      sql.setMark.run(doc.uuaid, doc.issuedAt, doc.issuedAt + SQUARE_LISTING_LIMITS.maxTtlMs);
      return { ok: true, uuaid: doc.uuaid, issuedAt: doc.issuedAt, expiresAt: doc.expiresAt, created: !existing };
    });
  }
  function postWithdraw(body, t) {
    const v = verifyWithdraw(body, { now: t });
    if (!v.ok) throw refuse(400, v.reason);
    const doc = v.withdrawal;
    return transaction(() => {
      prune(t);
      if (doc.issuedAt <= highWater(doc.uuaid)) throw refuse(409, "stale");
      keyGate(doc.publicKey, t);
      markSlot(doc.uuaid);
      const removed = Number(sql.remove.run(doc.uuaid).changes) > 0;
      sql.setMark.run(doc.uuaid, doc.issuedAt, doc.issuedAt + SQUARE_LISTING_LIMITS.maxTtlMs);
      return { ok: true, uuaid: doc.uuaid, removed };
    });
  }

  async function serve(req) {
    const t = clock();
    const raw = typeof req.url === "string" ? req.url : "";
    const declared = req.headers["content-length"];
    const hasBody = Object.hasOwn(req.headers, "transfer-encoding") || (declared !== undefined && declared !== "0");
    if (raw.length > lim.urlBytes) throw refuse(414, "uri-too-long", { close: hasBody });
    const qi = raw.indexOf("?");
    const path = qi < 0 ? raw : raw.slice(0, qi), query = qi < 0 ? "" : raw.slice(qi + 1);
    if (!Object.hasOwn(SQUARE_ROUTES, path)) throw refuse(404, "not-found", { close: hasBody });
    const route = SQUARE_ROUTES[path];
    if (req.method !== route.method) throw refuse(405, "method-not-allowed", { close: hasBody, headers: { allow: route.method } });
    const q = parseQuery(path, query, lim);
    if (route.method === "GET") {
      if (hasBody) throw refuse(400, "unexpected-body", { close: true });
      prune(t);
      return { status: 200, body: path === "/v1/square/directory" ? directory(q, t) : resolve(q, t), read: true };
    }
    if (!isJsonContentType(req.headers["content-type"])) throw refuse(415, "unsupported-media-type", { close: hasBody });
    if (declared !== undefined) {
      if (!/^(0|[1-9][0-9]{0,15})$/.test(declared)) throw refuse(400, "bad-content-length", { close: true });
      if (Number(declared) > lim.bodyBytes) throw refuse(413, "too-large", { close: true });
    }
    if (!hasBody) throw refuse(400, "missing-body");
    const source = sourceOf(req, trustProxy);
    if (!perSource.take(source, lim.writesPerSourcePerHour, t, shared)) throw refuse(429, "rate-limited", { close: true });
    const body = parseJsonObject(await readBody(req, lim.bodyBytes));
    const t2 = clock();
    return { status: 200, body: path === "/v1/square/listings" ? postListing(body, t2) : postWithdraw(body, t2) };
  }

  function send(res, { status, body, read = false, close = false, headers = null }) {
    if (res.headersSent || res.destroyed || res.writableEnded) return;
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": bytes.length,
      "cache-control": read ? "no-cache" : "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      ...(read ? PUBLIC_READ : {}),
      ...(headers ?? {}),
      ...(close ? { connection: "close" } : {}),
    });
    res.end(bytes);
  }

  async function handle(req, res) {
    let reply;
    try { reply = await serve(req); }
    catch (error) {
      if (error instanceof SquareHttpError) reply = { status: error.status, body: { error: error.code }, close: error.close, headers: error.headers };
      else { try { onError(error); } catch { /* the logger's own failure is not the request's */ } reply = { status: 500, body: { error: "internal" }, close: true }; }
    }
    // A body the square did not read in full is never drained: the connection closes after the reply.
    if (!req.complete) reply.close = true;
    send(res, reply);
  }

  const server = createServer({ headersTimeout: 10000, requestTimeout: 30000, keepAliveTimeout: 5000, maxHeaderSize: 16384 }, (req, res) => {
    handle(req, res).catch((error) => { try { onError(error); } catch { /* ignore */ } res.destroy(); });
  });
  server.maxHeadersCount = 64;
  server.maxConnections = lim.maxConnections;
  let closed = false;

  return Object.freeze({
    limits: lim,
    /** Listen on `host` (default 127.0.0.1) and `port` (default 0). Resolves { url, host, port }. */
    listen(port = 0, host = "127.0.0.1") {
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) return Promise.reject(new TypeError("square: port must be 0-65535"));
      if (typeof host !== "string" || host.length === 0) return Promise.reject(new TypeError("square: host is required"));
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen({ host, port, exclusive: true }, () => {
          server.off("error", reject);
          const a = server.address();
          resolveListen({ url: `http://${a.family === "IPv6" ? `[${a.address}]` : a.address}:${a.port}`, host: a.address, port: a.port });
        });
      });
    },
    address: () => server.address(),
    async close() {
      if (closed) return;
      closed = true;
      if (server.listening) await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
      db.close();
    },
  });
}
