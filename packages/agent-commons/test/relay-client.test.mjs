// L1 item 9 (spec v3.4.5 8, 8.1, 11.4, 11.5; A9; B7, B8; R9; N22): the seed bundle on GET /v1/seed and
// the reference client against a relay on 127.0.0.1. The client verifies the relay signature on
// every response against the pinned key, keeps a durable outbox, handles each inbox record once and
// acknowledges after handling, survives a relay outage, and after a wipe that keeps only the key seed,
// agent, relay.origin and relay.public_key, recovers its member and its unacknowledged records.
// Fixture keys; scratch state directories; loopback only.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { RelayClient, RelayClientError, soonestLease } from "../src/relay/client.mjs";
import * as G from "../src/relay/governance.mjs";
import { verifySeedBundle, trustedDocument, signSeedBundle, RULES, SEED_BUNDLE_FIELDS, SEED_BUNDLE_TTL_MS, MEMBER_ENDPOINTS } from "../src/relay/seed.mjs";
import { RELAY_TEST_AUD } from "../src/relay/auth.mjs";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { setup, keySeedHex, decision, approval, ownerConfirm, outboxFor, seatMessage, sendSeatMessage, laneD0, promoteC1, eligibleForC2, createDecision, addVerdict, taskArgs, T0, MIN, HOUR, DAY } from "./relay-fixtures.mjs";
import { relayFor, send, signedSeed, TMP } from "./relay-http.mjs";

const CLI = fileURLToPath(new URL("../src/relay/client.mjs", import.meta.url));
const stateDir = () => { const d = mkdtempSync(join(TMP, "relay-l1-agent-")); chmodSync(d, 0o700); return d; };
const client = (t, dir = stateDir(), url = `http://127.0.0.1:${t.r.port}`) => new RelayClient({ stateDir: dir, relayUrl: url, clock: () => t.now() });
const fleet = (t, by, type, rec, at = t.now()) => send(t, signedSeed(keySeedHex(t.fx.keys[by]), "POST", `/v1/fleet/records/${type}`, rec, at));

/** The lane owner creates an invite over the wire; the client enrolls; seat-3 confirms the owner line and seat-2 confirms. */
async function enrolled(t, c, name = "agent") {
  const rec = decision(t.fx, "seat-1", { cls: "D0", action: "invite.create", subject: `req-${name}`, at: t.now(),
    args: { kind: "enroll", member_id: null, intended_display_name: name, intended_platform: "fixture" } });
  const inv = (await fleet(t, "seat-1", "invite.create", rec)).body.invite;
  c.mintKey();
  const e = await c.enroll(inv, { displayName: name, platform: "fixture" });
  const line = outboxFor(t.fx.db, e.enrollment_id);
  await fleet(t, "seat-3", "owner-record.confirm", ownerConfirm(t.fx, "seat-3", line, t.now()));
  const conf = await fleet(t, "seat-2", "enroll.confirm", decision(t.fx, "seat-2", { cls: "D0", action: "enroll.confirm", subject: e.member_id, args: { owner_line_ref: line.id }, at: t.now() }));
  assert.equal(conf.body.state, "effective");
  return { ...e, invite: inv };
}

test("8 / N22: GET /v1/seed returns a relay-signed seed bundle with exactly the spec's fields and no secret; tampering, another key, expiry and a wrong rules hash are refused", async (tt) => {
  const fx = setup({ members: ["A", "B"] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const A = fx.members.A;
  const res = await send(t, signedSeed(keySeedHex(A.identity), "GET", "/v1/seed", undefined, T0));
  const b = res.body;
  assert.deepEqual(Object.keys(b).sort(), [...SEED_BUNDLE_FIELDS].sort());
  assert.deepEqual({ relay: b.relay, namespace: b.namespace, member: b.member, board: b.board, ttl: b.expires_at - b.issued_at },
    { relay: { origin: RELAY_TEST_AUD, public_key: t.r.publicKey, protocol: "commons-relay/1" }, namespace: "agentnet",
      member: { member_id: A.id, agent: A.identity.uuaid, role: "C0" }, board: { lane: "relay-core", endpoints: [...MEMBER_ENDPOINTS] }, ttl: SEED_BUNDLE_TTL_MS });
  assert.equal(SEED_BUNDLE_TTL_MS, 30 * DAY, "8: expires_at <= issued_at + 30 d");
  assert.ok(MEMBER_ENDPOINTS.every(e => !e.includes("/v1/fleet/")) && MEMBER_ENDPOINTS.includes("GET /v1/seed"));
  assert.deepEqual(verifySeedBundle(b, t.r.publicKey, { aud: RELAY_TEST_AUD, now: T0, member_id: A.id, agent: A.identity.uuaid }), { ok: true, problems: [] });
  assert.equal(trustedDocument(b.rules, RULES).startsWith("# Cloud Commons member working rules"), true);
  // N22: no key seed, no invite secret, no other member's id; the only 64-hex values are the relay key and the two document hashes.
  const text = JSON.stringify(b);
  for (const canary of [keySeedHex(A.identity), A.inviteSecret.toString("hex"), fx.members.B.id, fx.members.B.identity.publicKeyHex]) assert.equal(text.includes(canary), false);
  const hex64 = text.match(/[0-9a-f]{64}/g).filter(h => !b.sig.includes(h));
  assert.deepEqual(hex64.sort(), [t.r.publicKey, b.rules.sha256, b.reconnect.sha256].sort());
  // Refusals.
  const bad = (x, opts = {}) => verifySeedBundle(x, t.r.publicKey, { aud: RELAY_TEST_AUD, now: T0, ...opts }).problems;
  assert.ok(bad({ ...b, member: { ...b.member, role: "C3" } }).includes("bad-signature"), "an edited role");
  assert.ok(bad(signSeedBundle((({ sig, ...x }) => x)(b), randomBytes(32).toString("hex"))).includes("bad-signature"), "another relay key");
  assert.ok(verifySeedBundle(b, "1".repeat(64), { now: T0 }).problems.includes("bad-signature"), "a different pinned key");
  assert.ok(bad(b, { now: b.expires_at }).includes("expired"));
  assert.ok(bad(b, { aud: "http://commons-relay.test:8081" }).includes("origin-mismatch"));
  assert.ok(bad(b, { agent: fx.members.B.identity.uuaid }).includes("agent-mismatch"));
  assert.throws(() => trustedDocument({ ...b.rules, sha256: "0".repeat(64) }, RULES), /document-mismatch/);
  // A pending member has no seed bundle (O-d); a fleet principal cannot read one.
  assert.equal((await send(t, signedSeed(keySeedHex(fx.keys["seat-1"]), "GET", "/v1/seed", undefined, T0))).status, 401);
});

test("11.5 reference client: mint, enroll by invite (the response checked against the invite's key), seed bundle, inbox handled once and acked after handling", async (tt) => {
  const fx = setup({ members: [] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const c = client(t);
  tt.after(() => c.close());
  const e = await enrolled(t, c, "client-a");
  assert.equal(c.pins().relay.public_key, t.r.publicKey);
  const st = readdirSync(c.dir).sort();
  assert.deepEqual(st, ["key.seed", "pins.json", "store.db"].sort().concat(st.filter(f => f.startsWith("store.db-"))).sort());
  assert.equal((await c.call("GET", "/v1/status")).status, "active");
  const bundle = await c.fetchSeedBundle();
  assert.equal(bundle.member.member_id, e.member_id);
  // Two seat messages; the first read handles both once; a second read handles nothing new.
  for (const id of ["sm-1", "sm-2"]) sendSeatMessage(fx.db, seatMessage(fx, "seat-1", e.member_id, `hello ${id}`, id, T0), T0);
  const seen = [];
  const r1 = await c.readInbox({ handler: (rec) => seen.push(rec.record_id) });
  assert.ok(r1.handled.includes("sm-1") && r1.handled.includes("sm-2"));
  const r2 = await c.readInbox({ handler: (rec) => seen.push(rec.record_id) });
  assert.deepEqual(r2.handled, []);
  assert.deepEqual(seen.filter(x => x.startsWith("sm-")), ["sm-1", "sm-2"]);
  assert.deepEqual([c.handledCounts()["sm-1"], c.handledCounts()["sm-2"]], [1, 1]);
  assert.equal(fx.db.prepare("SELECT acked_through FROM mailbox_state WHERE member_id = ?").get(e.member_id).acked_through, r1.next_after, "acked after handling");
});

test("11.5 outbox: a relay outage is temporary (kept, backed off, sent once on return); a signed refusal is permanent and surfaces; a response the pinned key does not sign is a network failure", async (tt) => {
  const fx = setup({ members: [] });
  const relaySeed = randomBytes(32).toString("hex");
  const t = await relayFor(fx, { relayKeySeedHex: relaySeed });
  const c = client(t);
  tt.after(() => c.close());
  const e = await enrolled(t, c, "client-b");
  await t.r.close();   // the relay stops
  c.enqueue({ type: "note", record_id: "n-down", body: { text: "written while the relay was down" } });
  const down = await c.drain();
  assert.deepEqual([down.sent, down.deferred, down.refused], [[], ["n-down"], []]);
  assert.equal(c.db.prepare("SELECT attempts FROM outbox WHERE record_id = 'n-down'").get().attempts, 1);
  // The relay returns (same key, same database, another port); after the backoff the record goes once.
  const t2 = await relayFor(fx, { relayKeySeedHex: relaySeed });
  tt.after(() => t2.r.close());
  c.relayUrl = `http://127.0.0.1:${t2.r.port}`;
  t2.setClock(T0 + 3000); c.clock = () => t2.now();
  const up = await c.drain();
  assert.deepEqual(up.sent.map(s => s.record_id), ["n-down"]);
  assert.equal(fx.db.prepare("SELECT count(*) n FROM member_records WHERE member_id = ? AND record_id = 'n-down'").get(e.member_id).n, 1);
  // Permanent: a C0 member may not claim (403); surfaced at once, never retried.
  c.enqueue({ type: "claim", record_id: "c-1", body: { task_id: "nope" } });
  const refused = await c.drain();
  assert.deepEqual(refused.refused.map(r => [r.record_id, r.status]), [["c-1", 403]]);
  assert.equal(c.db.prepare("SELECT state FROM outbox WHERE record_id = 'c-1'").get().state, "refused");
  // A relay with another key on the same database: every response fails the pinned-key check.
  const fake = await relayFor(fx, { relayKeySeedHex: randomBytes(32).toString("hex"), at: T0 + 3000 });
  tt.after(() => fake.r.close());
  c.relayUrl = `http://127.0.0.1:${fake.r.port}`;
  await assert.rejects(c.call("GET", "/v1/status"), (err) => err instanceof RelayClientError && err.code === "bad-relay-signature" && err.temporary);
  c.enqueue({ type: "note", record_id: "n-fake", body: { text: "x" } });
  assert.deepEqual((await c.drain()).deferred, ["n-fake"], "kept for the real relay");
});

test("B8 / R9 reset: a wipe keeping only the key seed, agent, relay.origin and relay.public_key recovers the member and every unacked record; the dedup set is lost, so the unacked one is handled twice", async (tt) => {
  const fx = setup({ members: [] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const old = client(t);
  const e = await enrolled(t, old, "client-r");
  sendSeatMessage(fx.db, seatMessage(fx, "seat-1", e.member_id, "acked", "R-acked", T0), T0);
  await old.readInbox({ handler: () => {} });
  sendSeatMessage(fx.db, seatMessage(fx, "seat-1", e.member_id, "unacked", "R-unacked", T0), T0);
  // Killed after handling and before acknowledging: the barrier aborts the read after the handled row commits.
  old.barrier = async (name) => { if (name === "client-after-handle") throw new Error("killed"); };
  await assert.rejects(old.readInbox({ handler: () => {} }), /killed/);
  const before = old.handledCounts();
  old.enqueue({ type: "note", record_id: "R-unsent", body: { text: "never sent" } });
  old.close();
  // Wipe: a fresh state directory with exactly the four values.
  const dir = stateDir();
  writeFileSync(join(dir, "key.seed"), readFileSync(join(old.dir, "key.seed")), { mode: 0o600 });
  writeFileSync(join(dir, "pins.json"), readFileSync(join(old.dir, "pins.json")), { mode: 0o600 });
  const fresh = client(t, dir);
  tt.after(() => fresh.close());
  assert.equal((await fresh.seedBundle()).member.member_id, e.member_id, "same member_id from a signed GET /v1/seed");
  const r = await fresh.readInbox({ handler: () => {} });
  assert.ok(r.read.includes("R-unacked") && !r.read.includes("R-acked"), JSON.stringify(r.read));
  const after = fresh.handledCounts();
  assert.deepEqual([(before["R-unacked"] ?? 0) + (after["R-unacked"] ?? 0), (before["R-acked"] ?? 0) + (after["R-acked"] ?? 0)], [2, 1]);
  assert.equal(fx.db.prepare("SELECT count(*) n FROM member_records WHERE record_id = 'R-unsent'").get().n, 0, "the unsent record is lost, as expected");
});

test("A9 scheduled mode: one run verifies the bundle, drains, reads with wait=0, acks, and heartbeats the live claim inside its lease", async (tt) => {
  const fx = setup({ members: ["A"] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const dir = stateDir();
  writeFileSync(join(dir, "key.seed"), `${keySeedHex(fx.members.A.identity)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "pins.json"), JSON.stringify({ agent: fx.members.A.identity.uuaid, relay: { origin: RELAY_TEST_AUD, public_key: t.r.publicKey } }), { mode: 0o600 });
  const c = client(t, dir);
  tt.after(() => c.close());
  const id = promoteC1(fx, "A");
  laneD0(fx, "task.open", "t-s", taskArgs(["docs"]));
  const claim = handleMemberRecord(fx.db, id, { type: "claim", record_id: "cl", body: { task_id: "t-s", lease_ms: HOUR } }, T0);
  t.setClock(T0 + 30 * MIN);
  const run = await c.runOnce({ handler: () => {} });
  assert.deepEqual([run.member.member_id, run.claims.map(x => x.claim_id), run.heartbeat.claim_id], [id, [claim.claim_id], claim.claim_id]);
  assert.equal(run.heartbeat.lease_until, T0 + 30 * MIN + HOUR, "renewed from the heartbeat");
  // A second run inside the 60 s floor drops its heartbeat instead of queueing it forever.
  const again = await c.runOnce({ handler: () => {} });
  assert.equal(again.heartbeat.error, "heartbeat-too-fast");
  assert.equal(c.db.prepare("SELECT count(*) n FROM outbox WHERE state = 'pending'").get().n, 0);
});

test("client CLI (what the R6 harness runs): mint, enroll from an invite file, status, seed; private state only; bad arguments exit 2", async (tt) => {
  const fx = setup({ members: [] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const dir = stateDir();
  // Async: the relay runs in this process, so a blocking spawn would deadlock it.
  const exec = (argv) => new Promise((resolve) => execFile(process.execPath, [CLI, ...argv], { encoding: "utf8", env: { ...process.env, AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" } },
    (error, stdout) => resolve({ status: error ? error.code : 0, stdout })));
  const run = async (args) => {
    const r = await exec([...args, "--state", dir, "--relay-url", `http://127.0.0.1:${t.r.port}`, "--test-mode", "--test-dir", t.dir]);
    return { status: r.status, out: JSON.parse(r.stdout.trim().split("\n").at(-1)) };
  };
  const m = await run(["mint"]);
  assert.equal(m.status, 0);
  const rec = decision(fx, "seat-1", { cls: "D0", action: "invite.create", subject: "req-cli", at: T0, args: { kind: "enroll", member_id: null, intended_display_name: "cli", intended_platform: "fixture" } });
  const inv = (await fleet(t, "seat-1", "invite.create", rec)).body.invite;
  const invFile = join(stateDir(), "invite.json");
  writeFileSync(invFile, JSON.stringify(inv), { mode: 0o600 });
  const e = await run(["enroll", "--invite-file", invFile, "--display-name", "cli", "--platform", "fixture"]);
  assert.deepEqual([e.status, e.out.result.agent, e.out.result.status], [0, m.out.result.agent, "pending"]);
  assert.deepEqual([(await run(["status"])).out.result.status], ["pending"]);
  const seed = await run(["seed"]);
  assert.deepEqual([seed.status, seed.out.error], [1, "unauthorized"], "no seed bundle while pending");
  assert.equal((await exec(["status", "--bogus", "x"])).status, 2);
  chmodSync(dir, 0o755);
  assert.equal((await run(["status"])).out.error, "state-dir-not-private");
});

test("C-CLIENT-1: scheduled mode renews EVERY live claim fairly (earliest lease first, one heartbeat per run under the 60 s floor): a C2 member's two claims stay live at +30, +45 and +61 min with no manual heartbeat", async (tt) => {
  const fx = setup({ members: ["A"] });
  // A real C2: three accepted contributions on two days, then a D2 role.change with three non-sponsor approvals, posted, past its window.
  const id = promoteC1(fx, "A");
  eligibleForC2(fx, "A");
  const proposed = T0 + 3 * DAY;
  const d2 = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: id, sponsor: "seat-1", args: { role: "C2" }, at: proposed }), proposed);
  for (const seat of ["seat-2", "seat-3", "seat-4"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", proposed), proposed);
  G.confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-5", outboxFor(fx.db, d2.id), proposed + HOUR), proposed + HOUR);
  G.settleAll(fx.db, proposed + HOUR + DAY);
  assert.equal(G.roleOf(fx.db, id), "C2");
  const start = proposed + HOUR + DAY + MIN;
  const t = await relayFor(fx, { at: start });
  tt.after(() => t.r.close());
  const dir = stateDir();
  writeFileSync(join(dir, "key.seed"), `${keySeedHex(fx.members.A.identity)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "pins.json"), JSON.stringify({ agent: fx.members.A.identity.uuaid, relay: { origin: RELAY_TEST_AUD, public_key: t.r.publicKey } }), { mode: 0o600 });
  const c = client(t, dir);
  tt.after(() => c.close());
  // Two one-hour claims over the wire, a millisecond apart.
  const claims = [];
  for (const i of [0, 1]) {
    t.setClock(start + i);
    laneD0(fx, "task.open", `sched-${i}`, taskArgs(["docs"]), "seat-1", start + i);
    claims.push(await c.call("POST", "/v1/records/claim", { type: "claim", record_id: `claim-${i}`, body: { task_id: `sched-${i}`, lease_ms: HOUR } }));
  }
  const states = () => fx.db.prepare("SELECT claim_id, state, lease_until FROM claims WHERE task_id LIKE 'sched-%' ORDER BY task_id").all().map(r => ({ ...r }));
  const renewedAt = [];
  for (const minute of [30, 45, 61]) {
    t.setClock(start + minute * MIN);
    const run = await c.runOnce({ handler: () => {} });
    assert.equal(run.heartbeat.kind, "heartbeat", `+${minute}: one accepted heartbeat`);
    renewedAt.push(run.renewal.renewed);
    const now = states();
    assert.deepEqual(now.map(x => x.state), ["live", "live"], `+${minute} min: both claims live ${JSON.stringify(now)}`);
    assert.ok(now.every(x => x.lease_until > start + minute * MIN), `+${minute}: every lease ends after now`);
    assert.equal(run.renewal.next_due, Math.min(...now.map(x => x.lease_until)), "the run reports the next renewal due");
  }
  // Earliest deadline first: the first claim, then the second, then the first again.
  assert.deepEqual(renewedAt, [claims[0].claim_id, claims[1].claim_id, claims[0].claim_id]);
  // One heartbeat per run, never two inside the member's 60 s floor (the relay would refuse the second).
  assert.equal(fx.db.prepare("SELECT count(*) n FROM member_records WHERE member_id = ? AND type = 'heartbeat' AND at >= ?").get(id, start).n, 3);
  assert.equal(soonestLease([]), null);
  assert.equal(soonestLease([{ claim_id: "b", lease_until: 5 }, { claim_id: "a", lease_until: 5 }]).claim_id, "a", "ties by claim_id");
});
