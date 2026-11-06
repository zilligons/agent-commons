// Cloud Commons relay, L1: the HTTP API (spec v3.4.5 sections 6, 7.1, 7.4-7.6, 9.2 Freeze, 11.3, 11.5
// and 13.2 "Test mode"; RT2 O12). Loopback and named test interfaces only; fixture keys only.
//
// START (O12 item 1; section 15 "server.mjs"). The relay refuses to start unless BOTH hold:
//   - `aud` is exactly the L1 test audience http://commons-relay.test:8080 (6.1, B5); and
//   - the bind is a literal loopback address (127.0.0.0/8 or ::1), or the address of the network
//     interface named by --test-interface.
// Anything else (a production aud, a wildcard such as 0.0.0.0 or ::, a host name, any other address)
// exits with status 2 before any file or key is read, with or without --test-mode. It never warns and
// carries on. --test-mode adds the clock and barrier files of test-mode.mjs (container-local, O12
// item 2), loaded only then. No route reaches them: the 6.5 inventory is closed (O12 item 3).
// RT3 MUST: the entrypoint of any non-test build must not carry --test-mode.
//
// PRODUCTION MODE (L2, -022 Addendum E P1; started only by serve.mjs, the `agent-commons relay serve`
// command, which has no test flag at all). `mode: "production"` changes exactly three things:
//   - `aud` is the configured https origin, in canonical form (https, no user, path, query, fragment,
//     default port or trailing slash; lower-case host), never the L1 test audience or a `.test` host;
//   - the bind is a literal loopback address only (the host's reverse proxy terminates TLS); no test
//     interface, no test mode, no test directory;
//   - the source address of every request is the `X-Real-IP` header the reverse proxy sets (exactly
//     one, a valid IP, only from a loopback peer); a request without one is refused 400 invalid-source
//     before any other work, the sweep included (11.3), so it changes no state, and the 5.2 per-IP caps
//     never fall into one shared bucket.
// Test mode (the default) is exactly the L1 behaviour above.
//
// EVERY REQUEST, in this order (6.1 verifier order, 7.1 ingress order):
//   0. production mode only: the source check (X-Real-IP); a request that fails it is refused 400
//      invalid-source and does no work at all, not even the sweep (11.3);
//   1. the sweep (11.3: on every request that passes the source check, and every 15 s on a timer);
//   2. the route inventory, the browser-origin refusal and the size cap, before any body byte is read
//      (routes.mjs classifyRequest); a request without a plain Content-Length is refused;
//   3. the body, read up to the cap, then a strict JSON parse;
//   4. 6.1 authentication and the 6.5 principal rules (routes.mjs admitRequest, auth.mjs);
//   5. the 7.6 rate caps (members: per-member and global token buckets);
//   6. the 9.2 freeze (member requests other than GET /v1/status get 503);
//   7. the L0 handler (board, mailbox, governance) for the route;
//   8. one relay-signed response (6.2: commons-relay-sig on EVERY response, refusals included) and
//      one source-metadata line (7.6).
//
// The enrollment-flow endpoints (POST /v1/enroll, /v1/rekey, /v1/rebind; 5.2) run their own order
// after the browser-origin refusal: the per-IP caps (10 attempts per hour, 5 concurrent; a source that
// is not an IP is refused, never counted in a shared bucket), the 4 KB cap, then enroll.mjs. Their
// response signature binds the body's nonce once the body has been parsed; a refusal made before any
// body byte is read (403 browser, 429 caps, 413) binds request_nonce null, and a client treats a
// null-bound response as a refusal only, never as a success. GET /v1/seed returns the member's
// seed bundle, signed by the relay key (section 8).

import { createServer } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { jcs } from "../pillar.mjs";
import { RelayError } from "./records.mjs";
import { FLEET_RECORD_TYPES, classifyRequest, admitRequest } from "./routes.mjs";
import { RELAY_TEST_AUD, RELAY_SIG_HEADER, UNAUTHORIZED, signRelayResponse, requestNonceOf, isNonce } from "./auth.mjs";
import { applyEnrollmentRequest } from "./enroll.mjs";
import { seedBundleBody, signSeedBundle } from "./seed.mjs";
import { runSweep, SWEEP_INTERVAL_MS, handleMemberRecord, ownClaims, boardView } from "./board.mjs";
import { readInbox, ackInbox, pruneMailbox, relayEpoch } from "./mailbox.mjs";
import * as G from "./governance.mjs";
import { renderSeatFeed, renderMemberRecord } from "./render.mjs";
import { openRelay } from "./roster.mjs";

/** 7.6 defaults (open for tuning, O7). Fleet principals are roster-loaded and are not bucketed, so a member flood cannot starve a freeze or a suspension. */
export const RATE_LIMITS = Object.freeze({
  member: Object.freeze({ capacity: 20, perSecond: 1 }),
  global: Object.freeze({ capacity: 100, perSecond: 10 }),
});
/** 7.6 / 5.2 step 1: enrollment-flow requests per source IP. */
export const ENROLL_LIMITS = Object.freeze({ perIpPerHour: 10, concurrentPerIp: 5, windowMs: 3600000 });
const ENROLL_PATHS = new Set(["/v1/enroll", "/v1/rekey", "/v1/rebind"]);
/** 7.6 long-poll: wait <= 25 s; <= 2 concurrent per member; <= 64 in total. */
export const LONG_POLL = Object.freeze({ maxWaitS: 25, perMember: 2, total: 64 });
export { SWEEP_INTERVAL_MS };
const PAGE = 100;

// --- start rules ------------------------------------------------------------------------------

export class StartRefused extends Error {
  constructor(reasons) {
    super(`relay start refused: ${reasons.join("; ")}`);
    this.name = "StartRefused";
    this.reasons = reasons;
  }
}

const isLoopback = (host) => (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";

/** A literal loopback address, or an address of the interface named as the test interface. Never a name or a wildcard. */
export function bindAllowed(host, { testInterface } = {}) {
  if (typeof host !== "string" || isIP(host) === 0) return false;
  if (isLoopback(host)) return true;
  if (typeof testInterface !== "string" || !testInterface) return false;
  return (networkInterfaces()[testInterface] ?? []).some(a => a.address === host);
}

/**
 * L2: a production audience is one configured https origin in canonical form (it is compared byte for
 * byte, 6.1 B5): exactly `new URL(aud).origin`, so no user, path, query, fragment, default port or
 * trailing slash, and a lower-case host. Never the L1 test audience and never a `.test` host (RFC 6761).
 */
export function isProductionAud(aud) {
  if (typeof aud !== "string" || aud.length > 256 || aud === RELAY_TEST_AUD) return false;
  let url;
  try { url = new URL(aud); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== aud) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return !(host === "test" || host.endsWith(".test"));
}

export const MODES = Object.freeze(["test", "production"]);

/**
 * O12 item 1: the conjunctive start refusal. Throws StartRefused unless the aud AND the bind are allowed.
 * mode "test" (default, L1): the test aud AND loopback or the named test interface.
 * mode "production" (L2): a production https aud AND a literal loopback bind; no test interface.
 */
export function checkStart({ aud, host, testInterface, mode = "test" }) {
  const reasons = [];
  if (mode === "production") {
    if (!isProductionAud(aud)) reasons.push("aud must be a canonical https origin (not the L1 test aud, not a .test host)");
    if (typeof host !== "string" || !isLoopback(host)) reasons.push("bind must be a literal loopback address (production sits behind the host's reverse proxy)");
    if (testInterface !== undefined) reasons.push("production mode takes no test interface");
  } else if (mode === "test") {
    if (aud !== RELAY_TEST_AUD) reasons.push(`aud must be exactly ${RELAY_TEST_AUD} (L1)`);
    if (!bindAllowed(host, { testInterface })) reasons.push("bind must be a literal loopback address or an address of the named test interface");
  } else reasons.push("unknown mode");
  if (reasons.length) throw new StartRefused(reasons);
}

/** L2: the client address the reverse proxy reports in X-Real-IP (one header, a valid IP, from a loopback peer), or null. */
export function proxiedSourceIp(req) {
  const peer = req.socket?.remoteAddress ?? "";
  const peerLoopback = isLoopback(peer) || /^::ffff:127\./.test(peer);
  const raw = req.headers?.["x-real-ip"];
  const repeated = (req.rawHeaders ?? []).filter((h, i) => i % 2 === 0 && h.toLowerCase() === "x-real-ip").length > 1;
  if (!peerLoopback || repeated || typeof raw !== "string") return null;
  const ip = raw.trim();
  return isIP(ip) === 0 ? null : ip;
}

// --- request helpers --------------------------------------------------------------------------

const QUERY_KEYS = Object.freeze({ "/v1/inbox": ["after", "wait"], "/v1/fleet/alerts": ["after"], "/v1/fleet/quarantine": ["after"] });

/** Integer-only query values, each key at most once, only the keys the route names. */
function parseQuery(path, query) {
  const allowed = QUERY_KEYS[path] ?? [];
  const out = {};
  if (query === "") return out;
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq), value = eq < 0 ? "" : part.slice(eq + 1);
    if (!allowed.includes(key) || Object.hasOwn(out, key)) throw new RelayError("invalid-query", 400, key.slice(0, 32));
    if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RelayError("invalid-query", 400, key);
    out[key] = Number(value);
  }
  return out;
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on("data", (chunk) => {
      if (settled) return;
      n += chunk.length;
      if (n > cap) return fail(new RelayError("too-large", 413));
      chunks.push(chunk);
    });
    req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks, n)); } });
    req.on("error", fail);
    req.on("close", () => fail(new RelayError("aborted", 400)));
  });
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function parseJson(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new RelayError("invalid-json", 400, "byte order mark");
  let value;
  try { value = JSON.parse(UTF8.decode(bytes)); } catch { throw new RelayError("invalid-json", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid-json", 400, "body must be a JSON object");
  return value;
}

const ok = (body) => ({ status: 200, body });
const clip = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : null);

// --- fleet record dispatch (6.5 fleet record table) -------------------------------------------

const D0_TYPES = new Set(["invite.create", "rebind.cancel", "enroll.confirm", "rekey.confirm", "task.open", "task.close", "task.assign",
  "claim.release", "progress.accept", "role.c1", "clock.resume", "review.changes", "review.reject"]);
const OWNER_TYPES = new Set(["freeze", "veto", "unfreeze"]);
/** Decision records: the route's <type> must name the decision's action and class (otherwise 400 type-mismatch). */
const DECISION_ROUTE = (type, b) =>
  D0_TYPES.has(type) ? b.class === "D0" && b.action === type
    : OWNER_TYPES.has(type) ? b.class === "OWNER" && b.action === type
      : type === "suspend" ? b.class === "SUSPEND" && b.action === "suspend"
        : type === "decision.propose" ? ["D1", "D1R", "D2"].includes(b.class)
          : null;
/** The other fleet records: each L0 handler checks its own record version, so another type's body is refused there. */
const RECORD_HANDLERS = Object.freeze({
  verdict: G.addVerdict, "served_by.attest": G.recordAttestation, "finding.open": G.openFinding, "finding.close": G.closeFinding,
  "coauthor.declare": G.declareCoauthor, "verify.result": G.recordVerifyResult, "security.approve": G.recordSecurityApproval,
  message: G.sendSeatMessage, "owner-record.confirm": G.confirmOwnerRecord,
});
/** Every 6.5 fleet record type has exactly one handler (checked at load and by test). */
export const FLEET_DISPATCH = Object.freeze(Object.fromEntries(FLEET_RECORD_TYPES.map(type => [type,
  RECORD_HANDLERS[type] ? "record" : DECISION_ROUTE(type, {}) !== null ? "decision" : null])));
for (const [type, kind] of Object.entries(FLEET_DISPATCH)) if (!kind) throw new Error(`no handler for fleet record type ${type}`);

function fleetRecord(db, type, signed, now, relay) {
  for (const key of Object.keys(signed)) if (key !== "body" && key !== "sig") throw new RelayError("unknown-field", 400, key);
  const b = signed.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new RelayError("invalid-record", 400, "body");
  if (FLEET_DISPATCH[type] === "decision") {
    if (!DECISION_ROUTE(type, b)) throw new RelayError("type-mismatch", 400);
    const out = G.createDecision(db, signed, now);
    // 5.1: the invite goes back once, to the creating seat, with the relay's origin (= aud) and full key (B5, B7).
    return out.invite ? { ...out, invite: { relay: { origin: relay.aud, public_key: relay.publicKey }, ...out.invite } } : out;
  }
  return RECORD_HANDLERS[type](db, signed, now);
}

// --- fleet views (6.5: alerts, queue, decisions, members, quarantine, owner-outbox) -----------
// Read-only. Member-originated text reaches a seat only through the 7.4 renderer (EXTERNAL header
// from relay metadata, inert fenced text).

function memberMeta(db, memberId) {
  return db.prepare(`SELECT p.display_name, m.role,
                            (SELECT agent FROM keys k WHERE k.principal_kind = 'member' AND k.principal_id = m.member_id AND k.status = 'active') AS agent
                       FROM members m JOIN member_profiles p USING(member_id) WHERE m.member_id = ?`).get(memberId) ?? {};
}

function fleetView(db, view, q) {
  const after = q.after ?? 0;
  switch (view) {
    case "alerts": {
      const items = db.prepare("SELECT id, at, kind, subject, detail FROM alerts WHERE id > ? ORDER BY id LIMIT ?").all(after, PAGE)
        .map(r => ({ id: r.id, at: r.at, kind: r.kind, subject: r.subject, detail: JSON.parse(r.detail) }));
      return { alerts: items, next_after: items.length ? items.at(-1).id : after };
    }
    case "quarantine": {
      const items = db.prepare("SELECT id, member_id, record_id, body, at FROM ext_quarantine WHERE id > ? ORDER BY id LIMIT ?").all(after, PAGE)
        .map(r => {
          const m = memberMeta(db, r.member_id);
          return { id: r.id, member_id: r.member_id, record_id: r.record_id, at: r.at,
            rendered: renderMemberRecord({ type: "note", member_id: r.member_id, agent: m.agent, display_name: m.display_name, role: m.role, at: r.at }, JSON.parse(r.body)) };
        });
      return { items, next_after: items.length ? items.at(-1).id : after };
    }
    case "queue": {
      const lanes = db.prepare("SELECT lane FROM lanes ORDER BY lane").all();
      // 12.2: the verification lane re-runs the patch itself, so the in-review queue carries the patch
      // (unified-diff text, data only; the relay never applies or runs it) beside its sha256 and base.
      const inReview = db.prepare(`SELECT s.submission_id, s.member_id, x.task_id, t.lane, t.base_commit, x.kind, x.body, x.body_sha256, x.created_at
                                     FROM submissions s JOIN submission_details x USING(submission_id) JOIN tasks t ON t.task_id = x.task_id
                                    WHERE s.state = 'in-review' ORDER BY x.created_at, s.submission_id LIMIT ?`).all(PAGE)
        .map(({ body, ...r }) => ({ ...r, ...(r.kind === "patch" ? { patch: JSON.parse(body) } : {}) }));
      const triage = db.prepare("SELECT task_id, lane, attempts FROM tasks WHERE status = 'needs-triage' ORDER BY updated_at, task_id LIMIT ?").all(PAGE).map(r => ({ ...r }));
      return { feed: lanes.map(({ lane }) => ({ lane, items: renderSeatFeed(db, lane).slice(0, PAGE) })), in_review: inReview, needs_triage: triage };
    }
    case "decisions": {
      const verdicts = db.prepare("SELECT approver, seq, verdict, body_sha256 FROM approvals WHERE decision_id = ? ORDER BY approver, seq");
      return {
        decisions: db.prepare(`SELECT id, class, action, subject, sponsor, lane, state, owner_line_ref, effect_at, created_at
                                 FROM decisions WHERE state = 'pending' ORDER BY created_at, id LIMIT ?`).all(PAGE)
          .map(d => ({ ...d, verdicts: verdicts.all(d.id).map(v => ({ ...v })) })),
      };
    }
    case "members": {
      const members = db.prepare(`SELECT m.member_id, m.status, m.role, p.display_name, p.platform, p.lane, p.first_heartbeat_at, p.last_heartbeat_at
                                    FROM members m JOIN member_profiles p USING(member_id) ORDER BY p.created_at, m.member_id`).all().map(r => ({ ...r }));
      // 5.2 / 5.3 / RD3: what a confirming seat sees: the invite's intended name and platform beside
      // what the agent sent, the owner line, the invite creator (P1), and for a re-bind the count so far.
      const pending = db.prepare(`SELECT e.id, e.kind, e.member_id, e.invite_id, e.spent_at, k.agent, k.status AS key_status, i.created_by,
                                         d.intended_display_name, d.intended_platform, p.display_name, p.platform,
                                         o.id AS owner_line_id, o.confirmed_at AS owner_line_confirmed_at
                                    FROM enrollments e JOIN keys k USING(public_key) JOIN invites i USING(invite_id)
                                    JOIN invite_details d USING(invite_id) JOIN member_profiles p ON p.member_id = e.member_id
                                    LEFT JOIN owner_record_outbox o ON o.subject = e.id
                                   WHERE e.confirmed_by IS NULL AND k.status = 'pending' ORDER BY e.spent_at, e.id`).all()
        .map(r => ({ ...r, mismatch: r.kind === "enroll" && (r.display_name !== r.intended_display_name || r.platform !== r.intended_platform),
          ...(r.kind === "rebind" ? { rebind_count: G.rebindCount(db, r.member_id) } : {}) }));
      return { members, pending_enrollments: pending };
    }
    case "owner-outbox":
      return { lines: db.prepare("SELECT id, subject, line, line_sha256, created_at FROM owner_record_outbox WHERE confirmed_at IS NULL ORDER BY created_at, id LIMIT ?")
        .all(PAGE).map(r => ({ ...r })) };
    default:
      throw new RelayError("not-found", 404);
  }
}

// --- the handler ------------------------------------------------------------------------------

function bucket({ capacity, perSecond }) { return { capacity, perSecond, tokens: capacity, at: null }; }
function refill(b, now) {
  if (b.at === null) b.at = now;
  else if (now > b.at) { b.tokens = Math.min(b.capacity, b.tokens + ((now - b.at) * b.perSecond) / 1000); b.at = now; }
}

/**
 * The request handler and the sweep tick for one relay database. `clock()` is relay time in ms
 * (Date.now, or the test-mode clock file). `barrier(name, signal)` is the test-mode hook or null.
 * `accessLog(entry)` receives one source-metadata entry per request (7.6).
 */
export function createRelayHandler({ db, aud, relayKeySeedHex, clock = Date.now, barrier = null, accessLog = () => {}, onError = () => {}, mode = "test" }) {
  if (mode === "production") {
    if (!isProductionAud(aud)) throw new StartRefused(["aud must be a canonical https origin (not the L1 test aud, not a .test host)"]);
    if (barrier !== null) throw new StartRefused(["production mode takes no test hook"]);
  } else if (mode !== "test") throw new StartRefused(["unknown mode"]);
  else if (aud !== RELAY_TEST_AUD) throw new StartRefused([`aud must be exactly ${RELAY_TEST_AUD} (L1)`]);
  const production = mode === "production";
  if (typeof relayKeySeedHex !== "string" || !/^[0-9a-f]{64}$/.test(relayKeySeedHex)) throw new RelayError("relay-key", 500, "the relay key seed must be 64 lower-case hex");
  const publicKey = Buffer.from(ed25519.getPublicKey(Buffer.from(relayKeySeedHex, "hex"))).toString("hex");
  const members = new Map();
  const global = bucket(RATE_LIMITS.global);
  const polls = new Map();
  let pollsTotal = 0;
  const ipAttempts = new Map(), ipInFlight = new Map();
  /** 5.2 step 1: per-IP caps on the enrollment flows. Returns a refusal, or a release function. */
  function ipGate(ip, now) {
    if (typeof ip !== "string" || isIP(ip) === 0) return { refusal: { status: 400, body: { error: "invalid-source" } } };
    const recent = (ipAttempts.get(ip) ?? []).filter(t => t > now - ENROLL_LIMITS.windowMs);
    const inFlight = ipInFlight.get(ip) ?? 0;
    if (recent.length >= ENROLL_LIMITS.perIpPerHour || inFlight >= ENROLL_LIMITS.concurrentPerIp) {
      ipAttempts.set(ip, recent);
      return { refusal: { status: 429, body: { error: "rate-limited" } } };
    }
    recent.push(now);
    ipAttempts.set(ip, recent);
    ipInFlight.set(ip, inFlight + 1);
    let released = false;
    return { release() { if (released) return; released = true; const n = (ipInFlight.get(ip) ?? 1) - 1; if (n > 0) ipInFlight.set(ip, n); else ipInFlight.delete(ip); } };
  }
  const wakers = new Set();
  const stop = new AbortController();
  const wake = () => { for (const w of [...wakers]) w(); };
  const pause = (ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); wakers.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    wakers.add(done);
  });

  function takeTokens(memberId, now) {
    let m = members.get(memberId);
    if (!m) members.set(memberId, m = bucket(RATE_LIMITS.member));
    refill(m, now); refill(global, now);
    if (m.tokens < 1 || global.tokens < 1) return false;
    m.tokens -= 1; global.tokens -= 1;
    return true;
  }

  /** GET /v1/inbox?after=&wait= (11.5): one page; with wait > 0 and nothing to read, hold up to `wait` seconds. */
  async function inbox(p, q, now, res) {
    const wait = q.wait ?? 0;
    if (wait > LONG_POLL.maxWaitS) throw new RelayError("invalid-query", 400, "wait");
    let page = readInbox(db, p.id, { after: q.after }, now);
    if (page.records.length || wait === 0) return page;
    const mine = polls.get(p.id) ?? 0;
    if (mine >= LONG_POLL.perMember || pollsTotal >= LONG_POLL.total) throw new RelayError("long-poll-limit", 429);
    polls.set(p.id, mine + 1); pollsTotal += 1;
    let gone = false;
    const onClose = () => { gone = true; wake(); };
    res.once("close", onClose);
    try {
      const deadline = Date.now() + wait * 1000;
      while (!gone && !stop.signal.aborted && Date.now() < deadline) {
        await pause(Math.min(1000, deadline - Date.now()));
        // 6.1 step 8: status (and the freeze) are read again before a long-poll returns a page.
        if (G.isFrozen(db)) throw new RelayError("frozen", 503);
        page = readInbox(db, p.id, { after: q.after }, clock());
        if (page.records.length) return page;
      }
      if (G.isFrozen(db)) throw new RelayError("frozen", 503);
      return readInbox(db, p.id, { after: q.after }, clock());
    } finally {
      res.off("close", onClose);
      pollsTotal -= 1;
      const left = (polls.get(p.id) ?? 1) - 1;
      if (left > 0) polls.set(p.id, left); else polls.delete(p.id);
    }
  }

  async function memberRoute(route, p, body, q, now, res) {
    switch (route.path) {
      case "/v1/status": return ok({ member_id: p.id, status: p.status, role: p.role ?? null, epoch: relayEpoch(db) });
      case "/v1/seed": return ok(signSeedBundle(seedBundleBody(db, p.id, { aud, relayPublicKey: publicKey, now }), relayKeySeedHex));
      case "/v1/claims": return ok({ claims: ownClaims(db, p.id, now) });
      case "/v1/board": return ok({ tasks: boardView(db, p.id, now) });
      case "/v1/inbox": return ok(await inbox(p, q, now, res));
      case "/v1/inbox/ack":
        for (const key of Object.keys(body)) if (key !== "through") throw new RelayError("unknown-field", 400, key);
        return ok(ackInbox(db, p.id, body.through, now));
      default:   // POST /v1/records/<type>; admitRequest has checked that <type> is the record's type
        return ok(handleMemberRecord(db, p.id, body, now));
    }
  }

  async function serve(req, res, meta) {
    const now = clock();
    meta.at = now;
    // L2 (spec 11.3): behind the reverse proxy the source is X-Real-IP. A production request without a
    // valid one is refused here, before the sweep and before anything else: it reads and writes nothing.
    if (production && meta.ip === null) return { status: 400, body: { error: "invalid-source" }, close: true };
    // 11.3: a sweep runs on every request that passes the source check (in test mode, every request; the
    // test-mode source is the socket address, which is never missing), and every 15 s on the timer.
    runSweep(db, now);
    const raw = typeof req.url === "string" ? req.url : "";
    const qi = raw.indexOf("?");
    const path = qi < 0 ? raw : raw.slice(0, qi), query = qi < 0 ? "" : raw.slice(qi + 1);
    meta.path = clip(path, 128);
    const headers = req.headers;
    const cl = headers["content-length"];
    const contentLength = Object.hasOwn(headers, "transfer-encoding") ? NaN
      : cl === undefined ? 0 : /^(0|[1-9][0-9]{0,9})$/.test(cl) ? Number(cl) : NaN;
    const c = classifyRequest({ method: req.method, path, headers, contentLength });
    // 5.2 step 1, after the browser-origin refusal and before the size cap: the per-IP caps.
    if ((c.ok && c.route.auth === "invite") || (c.status === 413 && req.method === "POST" && ENROLL_PATHS.has(path))) {
      const gate = ipGate(meta.ip, now);
      if (gate.refusal) return { ...gate.refusal, close: contentLength !== 0 };
      meta.release = gate.release;
    }
    if (!c.ok) return { status: c.status, body: c.body, close: contentLength !== 0 };
    const route = c.route;
    meta.type = route.recordType ?? route.view ?? route.flow ?? null;
    const bytes = contentLength > 0 ? await readBody(req, route.cap) : Buffer.alloc(0);
    meta.size = bytes.length;
    let body;
    if (route.method === "POST") {
      if (!bytes.length) throw new RelayError("missing-body", 400);
      body = parseJson(bytes);
    }
    if (route.auth === "invite") {
      if (isNonce(body.nonce)) meta.requestNonce = body.nonce;   // 6.2: the response binds the request's nonce
      if (barrier) await barrier("before-dispatch", stop.signal);
      const out = ok(applyEnrollmentRequest(db, route.flow, body, { aud, now, sourceIp: meta.ip }));
      if (barrier) await barrier("after-commit", stop.signal);
      return out;
    }
    const a = admitRequest(db, route, { method: req.method, path, query, headers, body }, { aud, now });
    if (!a.ok) return a;
    const p = a.principal;
    meta.principal = p.id; meta.kind = p.kind;
    if (p.kind === "member" && !takeTokens(p.id, now)) return { status: 429, body: { error: "rate-limited" } };
    if (p.kind === "member" && route.path !== "/v1/status" && G.isFrozen(db)) throw new RelayError("frozen", 503);
    const q = parseQuery(route.path, query);
    if (barrier) await barrier("before-dispatch", stop.signal);
    const out = p.kind === "member" ? await memberRoute(route, p, body, q, now, res)
      : route.view ? ok(fleetView(db, route.view, q)) : ok(fleetRecord(db, route.recordType, body, now, { aud, publicKey }));
    if (route.method === "POST") wake();
    if (barrier) await barrier("after-commit", stop.signal);
    return out;
  }

  function refusal(error) {
    if (error instanceof RelayError) {
      // 6.3: every principal failure is the uniform 401; staleness is principal-independent and keeps its code.
      if (error.status === 401) return error.code === "stale" ? { status: 401, body: { error: "stale" } } : { ...UNAUTHORIZED };
      if (error.status >= 500 && error.status !== 503 && error.status !== 507) { onError(error); return { status: 500, body: { error: "internal" } }; }
      const detail = error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2, error.code.length + 202) : null;
      return { status: error.status, body: detail ? { error: error.code, detail } : { error: error.code } };
    }
    // A 9.3 trigger refusal that L0 did not name itself: its RAISE code, as a 409.
    if (error?.code === "ERR_SQLITE_ERROR" && error.errcode === 1811 && /^[a-z0-9][a-z0-9-]{1,63}$/.test(error.message)) return { status: 409, body: { error: error.message } };
    onError(error);
    return { status: 500, body: { error: "internal" } };
  }

  function send(res, reply, requestNonce, meta) {
    let { status, body } = reply;
    let bytes, sig;
    try {
      bytes = Buffer.from(jcs(body), "utf8");
      sig = signRelayResponse(relayKeySeedHex, { aud, requestNonce, status, body });
    } catch (error) {
      onError(error);
      status = 500; body = { error: "internal" };
      bytes = Buffer.from(jcs(body), "utf8");
      sig = signRelayResponse(relayKeySeedHex, { aud, requestNonce, status, body });
    }
    meta.status = status;
    try { accessLog({ at: meta.at, ip: meta.ip, user_agent: meta.user_agent, method: meta.method, path: meta.path, status, principal: meta.principal, kind: meta.kind, type: meta.type, size: meta.size }); }
    catch (error) { onError(error); }
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      "content-type": "application/json", "content-length": bytes.length, "cache-control": "no-store",
      [RELAY_SIG_HEADER]: sig, ...(reply.close ? { connection: "close" } : {}),
    });
    res.end(bytes);
  }

  async function handle(req, res) {
    const meta = { at: null, ip: production ? proxiedSourceIp(req) : req.socket?.remoteAddress ?? null, user_agent: clip(req.headers["user-agent"]), method: clip(req.method, 16),
      path: null, status: 0, principal: null, kind: null, type: null, size: 0 };
    // serve() may set meta.requestNonce (an enrollment body's nonce) and meta.release (the per-IP slot).
    meta.requestNonce = requestNonceOf(req.headers);
    meta.release = null;
    let reply;
    try { reply = await serve(req, res, meta); }
    catch (error) { reply = { ...refusal(error), close: error?.code === "too-large" }; }
    finally { meta.release?.(); }
    send(res, reply, meta.requestNonce, meta);
  }

  /** The timed sweep (11.3, every 15 s): leases and enrollment expiry, decision windows, mailbox retention. */
  function tick() {
    const now = clock();
    runSweep(db, now);
    G.settleAll(db, now);
    pruneMailbox(db, now);
    for (const [ip, times] of ipAttempts) { const recent = times.filter(t => t > now - ENROLL_LIMITS.windowMs); if (recent.length) ipAttempts.set(ip, recent); else ipAttempts.delete(ip); }
    wake();
  }

  return Object.freeze({ handle, tick, publicKey, mode, close() { stop.abort(); wake(); } });
}

/**
 * Start a relay on an allowed bind (checkStart first). `db` is an open relay database (roster and
 * policy loaded). Returns { url, port, host, publicKey, testMode, tick, close }. The sweep timer is
 * armed at SWEEP_INTERVAL_MS through `scheduler` (default: the global timers).
 */
export async function startRelay({ db, aud, host, port = 0, testMode = false, testDir, testInterface, relayKeySeedHex, accessLog, onError,
  scheduler = { setInterval, clearInterval }, mode = "test" }) {
  checkStart({ aud, host, testInterface, mode });
  // RT3: production mode never takes a test hook, whatever the caller passes.
  if (mode === "production" && (testMode !== false || testDir !== undefined)) throw new StartRefused(["production mode takes no test mode or test directory"]);
  if (!testMode && testDir !== undefined) throw new StartRefused(["--test-dir needs --test-mode"]);
  let hooks = null;
  if (testMode) {
    const { openTestHooks } = await import("./test-mode.mjs");
    try { hooks = openTestHooks(testDir); } catch (error) { throw new StartRefused([error.message]); }
  }
  const relay = createRelayHandler({ db, aud, relayKeySeedHex, clock: hooks ? hooks.now : Date.now, barrier: hooks ? hooks.barrier : null, accessLog, onError, mode });
  const server = createServer({ headersTimeout: 10000, requestTimeout: 60000, keepAliveTimeout: 5000, maxHeaderSize: 16384 }, (req, res) => {
    relay.handle(req, res).catch((error) => { onError?.(error); res.destroy(); });
  });
  server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host, port, exclusive: true }, () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (address.address !== host) { server.close(); throw new StartRefused([`bound ${address.address}, not ${host}`]); }
  const timer = scheduler.setInterval(() => { try { relay.tick(); } catch (error) { onError?.(error); } }, SWEEP_INTERVAL_MS);
  timer?.unref?.();
  return Object.freeze({
    url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    port: address.port, host: address.address, publicKey: relay.publicKey, testMode: hooks !== null, mode, tick: relay.tick,
    async close() {
      scheduler.clearInterval(timer);
      relay.close();
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  });
}

// --- command line (the L1 TEST entrypoint) -------------------------------------------------------
// The production entrypoint is serve.mjs (`agent-commons relay serve`); this one refuses any aud but the
// L1 test aud (checkStart, mode "test").
// node src/relay/server.mjs --aud <aud> --bind <ip> [--port <n>] [--test-interface <name>]
//   [--test-mode --test-dir <abs dir>] --db <relay*.db> --roster <file> --policy <file>
//   --owner-public-key <64 hex> --relay-key-file <file, 0600, 64-hex seed> [--access-log <file>]

const FLAGS = Object.freeze({ "--test-mode": false, "--test-dir": true, "--test-interface": true, "--aud": true, "--bind": true, "--port": true,
  "--db": true, "--roster": true, "--policy": true, "--owner-public-key": true, "--relay-key-file": true, "--access-log": true });

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!Object.hasOwn(FLAGS, flag)) throw new StartRefused([`unknown argument ${JSON.stringify(String(flag).slice(0, 40))}`]);
    const key = flag.slice(2);
    if (Object.hasOwn(out, key)) throw new StartRefused([`${flag} given twice`]);
    if (!FLAGS[flag]) { out[key] = true; continue; }
    if (i + 1 >= argv.length) throw new StartRefused([`${flag} needs a value`]);
    out[key] = argv[++i];
  }
  return out;
}

/** A private regular file of this user (not a symlink, no group or other access). */
export function readPrivateFile(path, what) {
  let st;
  try { st = lstatSync(path); } catch { throw new StartRefused([`${what} missing`]); }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid()))
    throw new StartRefused([`${what} must be a regular file of this user with mode 0600`]);
  return readFileSync(path, "utf8");
}

/** The command line. Exit status 2 on any start refusal, before anything listens. */
export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let relay, db;
  try {
    const o = parseArgs(argv);
    // O12 item 1 first: nothing is read (no file, no key) before the aud and the bind pass.
    checkStart({ aud: o.aud, host: o.bind, testInterface: o["test-interface"] });
    const port = o.port === undefined ? 0 : /^(0|[1-9][0-9]{0,4})$/.test(o.port) && Number(o.port) <= 65535 ? Number(o.port) : NaN;
    if (Number.isNaN(port)) throw new StartRefused(["--port must be 0-65535"]);
    for (const k of ["db", "roster", "policy", "owner-public-key", "relay-key-file"]) if (typeof o[k] !== "string") throw new StartRefused([`--${k} is required`]);
    let clock = Date.now;
    if (o["test-mode"]) {
      const { openTestHooks } = await import("./test-mode.mjs");
      try { clock = openTestHooks(o["test-dir"]).now; } catch (error) { throw new StartRefused([error.message]); }
    } else if (o["test-dir"] !== undefined) throw new StartRefused(["--test-dir needs --test-mode"]);
    const seed = readPrivateFile(o["relay-key-file"], "--relay-key-file").trim();
    if (!/^[0-9a-f]{64}$/.test(seed)) throw new StartRefused(["--relay-key-file must hold one 64-hex key seed"]);
    const roster = JSON.parse(readFileSync(o.roster, "utf8")), policy = JSON.parse(readFileSync(o.policy, "utf8"));
    db = openRelay({ path: o.db, roster, policy, ownerPublicKey: o["owner-public-key"], now: clock() });
    const log = o["access-log"];
    const accessLog = (entry) => {
      const line = `${JSON.stringify(entry)}\n`;
      if (log) appendFileSync(log, line, { mode: 0o600 }); else stderr.write(`access ${line}`);
    };
    relay = await startRelay({ db, aud: o.aud, host: o.bind, port, testMode: o["test-mode"] === true, testDir: o["test-dir"], testInterface: o["test-interface"],
      relayKeySeedHex: seed, accessLog, onError: (error) => stderr.write(`relay error: ${String(error?.stack ?? error).slice(0, 2000)}\n`) });
  } catch (error) {
    stderr.write(`${error instanceof StartRefused ? error.message : `relay start refused: ${String(error?.message ?? error).slice(0, 500)}`}\n`);
    try { db?.close(); } catch { /* already closed */ }
    process.exitCode = 2;
    return null;
  }
  stdout.write(`${JSON.stringify({ listening: relay.url, relay_public_key: relay.publicKey, test_mode: relay.testMode })}\n`);
  const shutdown = async () => { await relay.close(); db.close(); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return relay;
}

const invoked = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invoked) await main();
