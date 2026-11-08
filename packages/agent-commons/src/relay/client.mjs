// Cloud Commons relay: the reference client (spec v3.4.5 5.2, 6.1, 6.2, 8, 8.1, 11.4, 11.5; A9; B7,
// B8; R9; 13.2). A generic HTTPS agent on the cf48f0e signer: it never uses fetch (a browser-style
// client sends Sec-Fetch-Mode, which the relay refuses), never sends its key seed anywhere, and
// verifies the relay signature on EVERY response against the pinned 64-hex relay key, byte for byte; a
// response that does not verify is a network failure.
//
// State directory (private, mode 0700, this user's; never a symlink):
//   key.seed       the 32-byte key seed (64 hex), mode 0600, persisted and read back before enrolling;
//   key.next.seed  a re-key / re-bind key until it is adopted;
//   pins.json      the other three values that cross a reset: agent, relay.origin, relay.public_key;
//   store.db       seed bundle, cursor per (origin, epoch), the dedup set and the durable handled-id
//                  table (written in ONE transaction, 13.2 case 3), and the outbox.
// A reset keeps only key.seed and pins.json (8: "Minimum to carry across a reset").
//
// Outbox (11.5): network errors, timeouts, 429, 5xx and an unverifiable response are temporary (back off
// up to 300 s; keep the record for its lifetime, 24 h for board records); signed refusals (400, 401,
// 403, 409, 413, 422) are permanent and surface at once. The inbox cursor advances, and the ack is
// sent, only after the agent has handled the record. Scheduled mode (A9): runOnce reads the inbox
// once with wait=0, heartbeats one live claim, acknowledges what it handled, and returns.
//
// Fair renewal: the relay accepts one heartbeat per member per 60 s (7.6), so a run
// sends exactly one, for the live claim whose lease ends FIRST (earliest deadline first; ties by
// claim_id). That claim's lease moves out, so the next run renews whichever lease now ends soonest.
// Each run therefore serves the claim closest to expiry; with leases of unequal length a short lease
// may be renewed on several runs in a row while a longer one is still far from its end, so this is
// not a fixed rotation. The run reports `renewal.next_due`, the earliest lease
// end left after its heartbeat; a scheduler that runs (every c >= 60 s) before each next_due keeps
// every live claim renewed.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { localIdFromKey } from "../vendor/pillar/identity/keychain.mjs";
import { signIdentityRequest, verifyRelayResponse, RELAY_SIG_HEADER } from "./auth.mjs";
import { signEnrollmentRequest } from "./enroll.mjs";
import { verifySeedBundle, trustedDocument, RULES, RECONNECT } from "./seed.mjs";

export const CLIENT_LIMITS = Object.freeze({ maxBackoffMs: 300000, recordLifetimeMs: 86400000, requestTimeoutMs: 40000 });
const PERMANENT = new Set([400, 401, 403, 404, 409, 413, 422]);

export class RelayClientError extends Error {
  constructor(code, { temporary = false, status = null, body = null } = {}) {
    super(code);
    this.name = "RelayClientError";
    this.code = code;
    this.temporary = temporary;
    this.status = status;
    this.body = body;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const agentOf = (seedHex) => `uuaid:agentnet:agent:${localIdFromKey(Buffer.from(ed25519.getPublicKey(Buffer.from(seedHex, "hex"))))}`;
const publicKeyOf = (seedHex) => Buffer.from(ed25519.getPublicKey(Buffer.from(seedHex, "hex"))).toString("hex");

function privateDir(dir) {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new RelayClientError("state-dir-not-absolute");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid()))
    throw new RelayClientError("state-dir-not-private");
  return dir;
}
function readSecret(path) {
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new RelayClientError("key-file-not-private");
  const v = readFileSync(path, "utf8").trim();
  if (!HEX64.test(v)) throw new RelayClientError("key-file-invalid");
  return v;
}
/** Write, then read back (5.2 "persists the key seed and reads it back before sending"). */
function writeSecret(path, value) {
  writeFileSync(`${path}.tmp`, `${value}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  if (readSecret(path) !== value) throw new RelayClientError("key-file-readback");
}

const STORE_DDL = `
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS dedup(record_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS handled(id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS outbox(record_id TEXT PRIMARY KEY, type TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','sent','refused','expired')),
  result TEXT) STRICT;`;

/** One HTTP(S) request, no fetch. Resolves {status, headers, body} or rejects with a temporary error. */
function transport(baseUrl, { method, target, headers, body }) {
  const url = new URL(target, baseUrl);
  const send = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
  if (!send) return Promise.reject(new RelayClientError("bad-relay-url"));
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = send(url, { method, agent: false, timeout: CLIENT_LIMITS.requestTimeoutMs,
      headers: { "user-agent": "commons-relay-reference-client/1", ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reject(new RelayClientError("bad-response", { temporary: true })); }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
      res.on("error", () => reject(new RelayClientError("network", { temporary: true })));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => reject(new RelayClientError("network", { temporary: true })));
    if (bytes) req.end(bytes); else req.end();
  });
}

/** Earliest deadline first: the live claim whose lease ends soonest (ties by claim_id), or null. */
export function soonestLease(claims) {
  let best = null;
  for (const c of claims ?? []) if (!best || c.lease_until < best.lease_until || (c.lease_until === best.lease_until && c.claim_id < best.claim_id)) best = c;
  return best;
}

export class RelayClient {
  /**
   * stateDir: absolute private directory. relayUrl: where to connect (for a test relay, a loopback or test-network
   * address); the signed audience is always the pinned relay.origin, never derived from the URL.
   * clock: relay-time source (ms). barrier: test-mode hook or null.
   */
  constructor({ stateDir, relayUrl, clock = Date.now, barrier = null }) {
    this.dir = privateDir(stateDir);
    this.relayUrl = relayUrl;
    this.clock = clock;
    this.barrier = barrier;
    this.db = new DatabaseSync(join(this.dir, "store.db"));
    this.db.exec("PRAGMA busy_timeout = 5000;" + STORE_DDL);
  }
  close() { this.db.close(); }

  // --- key seed and pins (8) -----------------------------------------------------------------------
  get seedPath() { return join(this.dir, "key.seed"); }
  get nextSeedPath() { return join(this.dir, "key.next.seed"); }
  /** Mint the key seed once, persist it and read it back. Returns the agent id. */
  mintKey() {
    if (readSecret(this.seedPath)) throw new RelayClientError("key-exists");
    writeSecret(this.seedPath, randomBytes(32).toString("hex"));
    return { agent: agentOf(readSecret(this.seedPath)), public_key: publicKeyOf(readSecret(this.seedPath)) };
  }
  pins() {
    try { return JSON.parse(readFileSync(join(this.dir, "pins.json"), "utf8")); } catch { return null; }
  }
  writePins(pins) {
    if (!HEX64.test(pins?.relay?.public_key ?? "") || typeof pins?.relay?.origin !== "string" || typeof pins?.agent !== "string") throw new RelayClientError("bad-pins");
    writeFileSync(join(this.dir, "pins.json"), `${JSON.stringify({ agent: pins.agent, relay: { origin: pins.relay.origin, public_key: pins.relay.public_key } })}\n`, { mode: 0o600 });
  }
  kv(k, v) {
    if (v === undefined) return this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k)?.v ?? null;
    this.db.prepare("INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  // --- requests (6.1, 6.2) -------------------------------------------------------------------------
  /** Send and verify the relay signature against `relayKey` (pinned), binding `nonce`. */
  async exchange({ method, target, headers = {}, body, aud, relayKey, nonce, url = this.relayUrl ?? this.pins()?.relay?.origin }) {
    if (typeof url !== "string" || !url) throw new RelayClientError("relay-url-unknown");
    const res = await transport(url, { method, target, headers, body });
    const ok = verifyRelayResponse(relayKey, { aud, requestNonce: nonce, status: res.status, body: res.body }, res.headers[RELAY_SIG_HEADER]);
    // 6.2: an unverifiable response is a network failure. A refusal the relay made before reading an
    // enrollment body binds no nonce; it is accepted as a refusal only, never as a success.
    if (!ok) {
      const asRefusal = nonce !== null && res.status !== 200
        && verifyRelayResponse(relayKey, { aud, requestNonce: null, status: res.status, body: res.body }, res.headers[RELAY_SIG_HEADER]);
      if (!asRefusal) throw new RelayClientError("bad-relay-signature", { temporary: true });
    }
    return res;
  }
  /** A 6.1-signed member request with the current key seed. Throws on a refusal. */
  async call(method, target, body) {
    const pins = this.pins();
    if (!pins) throw new RelayClientError("not-enrolled");
    const seedHex = readSecret(this.seedPath);
    const [path, query = ""] = target.split("?");
    const s = signIdentityRequest({ seedHex, method, path, query, body, audience: pins.relay.origin, created: new Date(this.clock()).toISOString() });
    const nonce = /nonce=([0-9a-f]+)/.exec(s.header)[1];
    const res = await this.exchange({ method, target, body, aud: pins.relay.origin, relayKey: pins.relay.public_key, nonce,
      headers: { "uuaid-identity-auth": s.header, "commons-principal": s.agent } });
    if (res.status === 200) return res.body;
    throw new RelayClientError(res.body?.error ?? "refused", { temporary: res.status === 429 || res.status >= 500, status: res.status, body: res.body });
  }

  // --- enrollment flows (5.2) ----------------------------------------------------------------------
  /**
   * Send the enrollment-flow request for an invite the owner delivered. enroll uses key.seed (minted
   * first); rekey and rebind mint key.next.seed (adopted after confirmation). The response is checked
   * against the key pinned in the invite and the body's nonce before anything in it is trusted.
   */
  async enroll(invite, { displayName = null, platform = null } = {}) {
    if (!invite?.relay || !HEX64.test(invite.relay.public_key ?? "")) throw new RelayClientError("bad-invite");
    let seedHex, oldSeedHex;
    if (invite.kind === "enroll") {
      seedHex = readSecret(this.seedPath);
      if (!seedHex) throw new RelayClientError("mint-the-key-first");
    } else {
      if (!readSecret(this.nextSeedPath)) writeSecret(this.nextSeedPath, randomBytes(32).toString("hex"));
      seedHex = readSecret(this.nextSeedPath);
      if (invite.kind === "rekey") oldSeedHex = readSecret(this.seedPath);
    }
    const { body, agent } = signEnrollmentRequest({ invite, seedHex, oldSeedHex, displayName, platform, created: new Date(this.clock()).toISOString() });
    const res = await this.exchange({ method: "POST", target: `/v1/${invite.kind}`, body, aud: invite.relay.origin, relayKey: invite.relay.public_key, nonce: body.nonce,
      url: this.relayUrl ?? invite.relay.origin });
    if (res.status !== 200) throw new RelayClientError(res.body?.error ?? "refused", { temporary: res.status === 429 || res.status >= 500, status: res.status, body: res.body });
    if (res.body.agent !== agent) throw new RelayClientError("enrollment-mismatch");
    // enroll pins the relay and the new agent; a re-key or re-bind keeps the current pins until the new key
    // is adopted, except after a key loss, when the state is empty and the invite is the only pin source.
    if (invite.kind === "enroll" || !this.pins()) this.writePins({ agent, relay: invite.relay });
    return res.body;
  }
  /** After a re-key or re-bind is confirmed: key.next.seed becomes key.seed, and the agent pin moves. */
  adoptNextKey() {
    const next = readSecret(this.nextSeedPath);
    if (!next) throw new RelayClientError("no-next-key");
    const pins = this.pins();
    renameSync(this.nextSeedPath, this.seedPath);
    if (readSecret(this.seedPath) !== next) throw new RelayClientError("key-file-readback");
    this.writePins({ ...pins, agent: agentOf(next) });
    return { agent: agentOf(next) };
  }

  // --- seed bundle (8) -----------------------------------------------------------------------------
  /** Fetch GET /v1/seed, verify it against the pinned key and the local rules / reconnect documents, store it. */
  async fetchSeedBundle() {
    const pins = this.pins();
    const bundle = await this.call("GET", "/v1/seed");
    const v = verifySeedBundle(bundle, pins.relay.public_key, { aud: pins.relay.origin, now: this.clock(), agent: pins.agent });
    if (!v.ok) throw new RelayClientError(`seed-bundle-${v.problems[0]}`);
    trustedDocument(bundle.rules, RULES);
    trustedDocument(bundle.reconnect, RECONNECT);
    this.kv("seed_bundle", JSON.stringify(bundle));
    return bundle;
  }
  /** The stored bundle if it verifies now; otherwise a fresh one (reconnect step 1). */
  async seedBundle() {
    const pins = this.pins();
    const stored = this.kv("seed_bundle");
    if (stored) {
      const bundle = JSON.parse(stored);
      if (verifySeedBundle(bundle, pins.relay.public_key, { aud: pins.relay.origin, now: this.clock(), agent: pins.agent }).ok) return bundle;
    }
    return this.fetchSeedBundle();
  }

  // --- outbox (11.4, 11.5) -------------------------------------------------------------------------
  /** Queue a member record durably; it is sent by drain(). Returns false if record_id is already queued. */
  enqueue({ type, record_id, body }) {
    const r = this.db.prepare("INSERT INTO outbox(record_id, type, body, created_at, next_at, state) VALUES (?, ?, ?, ?, ?, 'pending') ON CONFLICT DO NOTHING")
      .run(record_id, type, JSON.stringify(body), this.clock(), this.clock());
    return r.changes === 1;
  }
  /** Send what is due. Returns {sent, refused, deferred} (refusals surface at once). */
  async drain() {
    if (this.barrier) await this.barrier("client-before-drain");
    const out = { sent: [], refused: [], deferred: [] };
    const now = this.clock();
    for (const r of this.db.prepare("SELECT * FROM outbox WHERE state = 'pending' ORDER BY created_at, record_id").all()) {
      if (now - r.created_at > CLIENT_LIMITS.recordLifetimeMs) {
        this.db.prepare("UPDATE outbox SET state = 'expired' WHERE record_id = ?").run(r.record_id);
        out.refused.push({ record_id: r.record_id, error: "expired" });
        continue;
      }
      if (r.next_at > now) { out.deferred.push(r.record_id); continue; }
      try {
        const receipt = await this.call("POST", `/v1/records/${r.type}`, { type: r.type, record_id: r.record_id, body: JSON.parse(r.body) });
        this.db.prepare("UPDATE outbox SET state = 'sent', result = ? WHERE record_id = ?").run(JSON.stringify(receipt), r.record_id);
        out.sent.push({ record_id: r.record_id, receipt });
      } catch (error) {
        // A heartbeat inside the relay's 60 s floor is simply not needed: dropped, never retried.
        const permanent = error instanceof RelayClientError && ((!error.temporary && (error.status === null || PERMANENT.has(error.status)))
          || (r.type === "heartbeat" && error.code === "heartbeat-too-fast"));
        if (permanent) {
          this.db.prepare("UPDATE outbox SET state = 'refused', result = ? WHERE record_id = ?").run(JSON.stringify({ error: error.code, status: error.status }), r.record_id);
          out.refused.push({ record_id: r.record_id, error: error.code, status: error.status });
        } else {
          const attempts = r.attempts + 1;
          this.db.prepare("UPDATE outbox SET attempts = ?, next_at = ? WHERE record_id = ?").run(attempts, now + Math.min(CLIENT_LIMITS.maxBackoffMs, 1000 * 2 ** attempts), r.record_id);
          out.deferred.push(r.record_id);
        }
      }
    }
    return out;
  }

  // --- inbox (11.5) --------------------------------------------------------------------------------
  /**
   * Read one page and handle each record once. `handler(record)` runs for records not in the dedup set;
   * the dedup row and the handled-id row commit in one transaction after it returns. The ack is sent
   * and the cursor stored only after every record on the page was handled.
   */
  async readInbox({ wait = 0, handler = () => {} } = {}) {
    const pins = this.pins();
    const epoch = this.kv("epoch");
    const cursor = epoch ? this.kv(`cursor:${pins.relay.origin}:${epoch}`) : null;
    const page = await this.call("GET", `/v1/inbox?${cursor !== null ? `after=${cursor}&` : ""}wait=${wait}`);
    const records = page.records;
    if (epoch !== null && page.epoch !== epoch) {
      // A new relay epoch resets the cursor to 0; dedup prevents double handling (11.5).
      this.kv("epoch", page.epoch);
      this.kv(`cursor:${pins.relay.origin}:${page.epoch}`, "0");
      return this.readInbox({ wait: 0, handler });
    }
    this.kv("epoch", page.epoch);
    const handled = [];
    for (const rec of records) {
      if (this.barrier) await this.barrier("client-after-read");
      const seen = this.db.prepare("SELECT 1 FROM dedup WHERE record_id = ?").get(rec.record_id);
      if (!seen) {
        await handler(rec);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare("INSERT INTO dedup(record_id, seq, at) VALUES (?, ?, ?)").run(rec.record_id, rec.seq, this.clock());
          this.db.prepare("INSERT INTO handled(record_id, seq, type, at) VALUES (?, ?, ?, ?)").run(rec.record_id, rec.seq, rec.type, this.clock());
          this.db.exec("COMMIT");
        } catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* keep the first error */ } throw error; }
        handled.push(rec.record_id);
      }
      if (this.barrier) await this.barrier("client-after-handle");
    }
    if (records.length) {
      await this.call("POST", "/v1/inbox/ack", { through: page.next_after });
      this.kv(`cursor:${pins.relay.origin}:${page.epoch}`, String(page.next_after));
    }
    return { epoch: page.epoch, read: records.map(r => r.record_id), handled, next_after: page.next_after };
  }
  /** The durable handled-id table: how many times each record id was handled (13.2 counts from it). */
  handledCounts() {
    return Object.fromEntries(this.db.prepare("SELECT record_id, count(*) n FROM handled GROUP BY record_id ORDER BY record_id").all().map(r => [r.record_id, r.n]));
  }

  // --- reconnect and scheduled mode (11.5, A9) ----------------------------------------------------
  /**
   * One scheduled run: verify or fetch the seed bundle; drain the outbox; read the inbox once with
   * wait=0 and handle it; read the claims and heartbeat a live claim (one per run; the relay's
   * heartbeat floor is 60 s). Returns a summary.
   */
  async runOnce({ handler, wait = 0 } = {}) {
    const bundle = await this.seedBundle();
    const drained = await this.drain();
    const inbox = await this.readInbox({ wait, handler });
    const { claims } = await this.call("GET", "/v1/claims");
    const target = soonestLease(claims);
    const id = `hb-${this.clock()}-${randomBytes(4).toString("hex")}`;
    this.enqueue({ type: "heartbeat", record_id: id, body: target ? { claim_id: target.claim_id, epoch: target.epoch } : {} });
    const hb = await this.drain();
    const heartbeat = hb.sent.find(s => s.record_id === id)?.receipt ?? hb.refused.find(s => s.record_id === id) ?? null;
    // After the heartbeat: the renewed claim's new lease, everyone else's unchanged.
    const leases = claims.map(c => (heartbeat?.claim_id === c.claim_id && Number.isSafeInteger(heartbeat.lease_until) ? { ...c, lease_until: heartbeat.lease_until } : c));
    const next = soonestLease(leases);
    return { member: bundle.member, drained, inbox, claims, heartbeat,
      renewal: { renewed: heartbeat?.claim_id ?? null, next_due: next ? next.lease_until : null, next_claim: next ? next.claim_id : null } };
  }
}

// --- commands ---------------------------------------------------------------------------------------
// runClientCommand is shared by two entrypoints:
//   - `agent-commons relay <command>` (cli.mjs, the consumer command): no test flag exists there;
//   - `node src/relay/client.mjs <command> ... [--test-mode --test-dir <abs dir>]` (the test harness).
// --relay-url is where to connect; when it is omitted, the client connects to the relay origin it
// pinned (relay.origin from the invite at enrollment, then from pins.json). The signed audience is
// always the pinned origin, never the URL.
// node src/relay/client.mjs <command> --state <abs dir> [--relay-url <url>] [--test-mode --test-dir <abs dir>]
//   mint | enroll --invite-file <f> [--display-name <s> --platform <s>] | adopt-next-key | status | seed |
//   claims | board | send --type <t> --record-id <id> --body-json <json> | drain | run-once [--wait <s>] |
//   handled | outbox
// Prints one JSON line. Exit 0 on success, 1 on a refusal or error, 2 on bad arguments.

export const CLIENT_COMMANDS = Object.freeze(["mint", "enroll", "adopt-next-key", "status", "seed", "claims", "board", "send", "drain", "run-once", "handled", "outbox"]);
/** The client's value flags (no test flag; the harness entrypoint below adds --test-mode / --test-dir). */
export const CLIENT_VALUE_FLAGS = Object.freeze(["--state", "--relay-url", "--invite-file", "--display-name", "--platform", "--type", "--record-id", "--body-json", "--wait"]);
const COMMANDS = CLIENT_COMMANDS;
const VALUE_FLAGS = [...CLIENT_VALUE_FLAGS, "--test-dir"];

/** Run one client command with parsed options `o` (keys without the leading --). Returns its result; throws on a refusal. */
export async function runClientCommand(command, o, { clock = Date.now, barrier = null } = {}) {
  if (!CLIENT_COMMANDS.includes(command)) throw new RelayClientError("usage");
  const client = new RelayClient({ stateDir: o.state, relayUrl: o["relay-url"], clock, barrier });
  try {
    switch (command) {
      case "mint": return client.mintKey();
      case "enroll": return await client.enroll(JSON.parse(readFileSync(o["invite-file"], "utf8")), { displayName: o["display-name"] ?? null, platform: o.platform ?? null });
      case "adopt-next-key": return client.adoptNextKey();
      case "status": return await client.call("GET", "/v1/status");
      case "seed": return await client.fetchSeedBundle();
      case "claims": return await client.call("GET", "/v1/claims");
      case "board": return await client.call("GET", "/v1/board");
      case "send": client.enqueue({ type: o.type, record_id: o["record-id"], body: JSON.parse(o["body-json"]) }); return await client.drain();
      case "drain": return await client.drain();
      case "run-once": return await client.runOnce({ handler: () => {}, wait: o.wait === undefined ? 0 : Number(o.wait) });
      case "handled": return client.handledCounts();
      case "outbox": return client.db.prepare("SELECT record_id, type, state, attempts, result FROM outbox ORDER BY created_at, record_id").all().map(r => ({ ...r }));
    }
    throw new RelayClientError("usage");
  } finally {
    client.close();
  }
}

export async function clientMain(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const [command, ...rest] = argv;
  const o = {};
  try {
    if (!COMMANDS.includes(command)) throw new RelayClientError("usage");
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--test-mode") { o["test-mode"] = true; continue; }
      if (!VALUE_FLAGS.includes(rest[i]) || i + 1 >= rest.length) throw new RelayClientError("usage");
      o[rest[i].slice(2)] = rest[++i];
    }
  } catch {
    stdout.write(`${JSON.stringify({ ok: false, error: "usage" })}\n`);
    process.exitCode = 2;
    return null;
  }
  try {
    let clock = Date.now, barrier = null;
    if (o["test-mode"]) {
      const { openTestHooks } = await import("./test-mode.mjs");
      const hooks = openTestHooks(o["test-dir"]);
      clock = hooks.now; barrier = (name) => hooks.barrier(name);
    }
    const result = await runClientCommand(command, o, { clock, barrier });
    stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return result;
  } catch (error) {
    stdout.write(`${JSON.stringify({ ok: false, error: error?.code ?? "error", status: error?.status ?? null, detail: String(error?.message ?? error).slice(0, 300) })}\n`);
    process.exitCode = 1;
    return null;
  }
}

const invoked = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invoked) await clientMain();
