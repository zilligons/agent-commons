// L1 item 4 (spec v3.4.5 5.1-5.4; M1, T-A2, B2, B3, B9, RD1-RD3, D-iii; RT2 O-a; the D items'
// invite-voided death): the enrollment-flow request side over the wire on 127.0.0.1. The invite goes
// back to the creating seat with the relay's origin and key; enroll, re-key and re-bind follow the
// 5.2 order; failures at steps 4-8 are persisted and the fifth voids the invite; the per-IP caps hold
// before the size cap. Every response is relay-signed, enrollment responses over the body's nonce.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { signEnrollmentRequest, enrollmentDescriptor, enrollmentSigningBytes, ENROLLMENT_TAGS, ENROLL_FAILURE_BUDGET } from "../src/relay/enroll.mjs";
import { ENROLL_LIMITS } from "../src/relay/server.mjs";
import { RELAY_TEST_AUD } from "../src/relay/auth.mjs";
import { setup, keySeedHex, decision, approval, ownerConfirm, outboxFor, createDecision, addVerdict, confirmOwnerRecord, T0, MIN, HOUR } from "./relay-fixtures.mjs";
import { relayFor, send, signedSeed, iso } from "./relay-http.mjs";

const seed = () => randomBytes(32).toString("hex");
const attempts = (fx, inviteId) => fx.db.prepare("SELECT count(*) n FROM enroll_attempts WHERE invite_id = ?").get(inviteId).n;
const spent = (fx, inviteId) => !!fx.db.prepare("SELECT 1 FROM enrollments WHERE invite_id = ?").get(inviteId);
const alertsOf = (fx, kind) => fx.db.prepare("SELECT subject, detail FROM alerts WHERE kind = ? ORDER BY id").all(kind).map(r => ({ subject: r.subject, ...JSON.parse(r.detail) }));
const REFUSED = { error: "enrollment-refused" };

/** A seat's invite.create over the wire; returns the once-only invite from the relay-signed response. */
async function invite(t, { kind = "enroll", member_id = null, by = "seat-1", at = t.now() } = {}) {
  const rec = decision(t.fx, by, { cls: "D0", action: "invite.create", subject: `req-${randomBytes(4).toString("hex")}`, at,
    args: { kind, member_id, intended_display_name: "fixture agent", intended_platform: "fixture" } });
  const res = await send(t, signedSeed(keySeedHex(t.fx.keys[by]), "POST", "/v1/fleet/records/invite.create", rec, at));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.invite;
}
/** POST an enrollment-flow body (no 6.1 header: the proof is in the body). Counts toward the per-IP hour. */
const flow = (t, path, body, headers = {}) => { t.flows = (t.flows ?? 0) + 1; return send(t, { method: "POST", path, body, headers }); };
/** Make room for `n` more flows inside the 10-per-hour cap (moving relay time past the window); returns relay time. */
function room(t, n) {
  if ((t.flows ?? 0) + n > ENROLL_LIMITS.perIpPerHour) { t.setClock(t.now() + HOUR + 1); t.flows = 0; }
  return t.now();
}
const fleet = (t, by, type, rec, at = t.now()) => send(t, signedSeed(keySeedHex(t.fx.keys[by]), "POST", `/v1/fleet/records/${type}`, rec, at));
const status = (t, seedHex, at = t.now()) => send(t, signedSeed(seedHex, "GET", "/v1/status", undefined, at));

test("5.1-5.3 enroll over the wire: the invite carries the relay's origin and key; the agent enrolls pending, may read only its status, and a different seat confirms it", async (tt) => {
  const fx = setup({ members: [] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const inv = await invite(t);
  assert.deepEqual(inv.relay, { origin: RELAY_TEST_AUD, public_key: t.r.publicKey }, "5.1: origin = the exact aud, the full 64-hex key (B5, B7)");
  assert.deepEqual([inv.namespace, inv.kind, inv.member_id, /^[0-9a-f]{32}$/.test(inv.invite_id), /^[0-9a-f]{64}$/.test(inv.secret)], ["agentnet", "enroll", null, true, true]);
  const s = seed();
  const { body, agent } = signEnrollmentRequest({ invite: inv, seedHex: s, displayName: "wire agent", platform: "fixture", created: iso(T0) });
  const res = await flow(t, "/v1/enroll", body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual({ ...res.body, enrollment_id: typeof res.body.enrollment_id, owner_line: typeof res.body.owner_line },
    { kind: "enroll", enrollment_id: "string", member_id: agent, agent, status: "pending", owner_line: "string" });
  assert.equal(JSON.stringify(res.body).includes(inv.secret), false, "N22: no invite secret in the response");
  // O-d: pending may read its status only.
  assert.deepEqual((await status(t, s)).body, { member_id: agent, status: "pending", role: null, epoch: fx.db.prepare("SELECT v FROM meta WHERE k = 'epoch'").get().v });
  assert.deepEqual((await send(t, signedSeed(s, "GET", "/v1/board", undefined, T0))).body, { error: "unauthorized" });
  // The seat view: intended beside sent (a mismatch is shown), the owner line, the invite creator.
  const view = (await send(t, signedSeed(keySeedHex(fx.keys["seat-2"]), "GET", "/v1/fleet/members", undefined, T0))).body;
  const row = view.pending_enrollments.find(e => e.member_id === agent);
  assert.deepEqual({ kind: row.kind, created_by: row.created_by, intended: row.intended_display_name, sent: row.display_name, mismatch: row.mismatch },
    { kind: "enroll", created_by: "seat-1", intended: "fixture agent", sent: "wire agent", mismatch: true });
  // Owner line posted and confirmed (seat-3), then enroll.confirm by seat-2 (not the creator, P1).
  const line = outboxFor(fx.db, res.body.enrollment_id);
  assert.equal((await fleet(t, "seat-3", "owner-record.confirm", ownerConfirm(fx, "seat-3", line, T0))).status, 200);
  const c = await fleet(t, "seat-2", "enroll.confirm", decision(fx, "seat-2", { cls: "D0", action: "enroll.confirm", subject: agent, args: { owner_line_ref: line.id } }));
  assert.equal(c.body.state, "effective", JSON.stringify(c.body));
  assert.deepEqual([(await status(t, s)).body.status, (await status(t, s)).body.role], ["active", "C0"]);
  assert.equal((await send(t, signedSeed(s, "GET", "/v1/board", undefined, T0))).status, 200);
  for (const e of t.log) assert.equal(JSON.stringify(e).includes(inv.secret), false, "N22: no invite secret in the access log");
  assert.deepEqual(t.errors, []);
});

test("5.2 step 3 (B2, B3): each endpoint's field allowlist and value column; refused 400 / 422 before any invite work, never counted", async (tt) => {
  const fx = setup({ members: ["A"] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const inv = await invite(t);
  const s0 = seed();
  const base = (at) => signEnrollmentRequest({ invite: inv, seedHex: s0, displayName: "a", platform: "p", created: iso(at) }).body;
  const cases = [
    [(g) => ({ ...g, extra: 1 }), "unknown-field"], [(g) => (({ old_sig, ...b }) => b)(g), "missing-field"], [(g) => ({ ...g, member_id: fx.members.A.id }), "invalid-field"],
    [(g) => ({ ...g, old_sig: "0".repeat(128) }), "invalid-field"], [(g) => ({ ...g, display_name: null }), "invalid-field"], [(g) => ({ ...g, display_name: "  " }), "invalid-field"],
    [(g) => ({ ...g, agent: g.agent.replace("agentnet", "pillar") }), "invalid-field"], [(g) => ({ ...g, nonce: "ABC" }), "invalid-field"],
    [(g) => ({ ...g, created: "2027-01-15 08:00:00Z" }), "invalid-field"], [(g) => ({ ...g, public_key: g.public_key.toUpperCase() }), "invalid-field"],
    [(g) => ({ ...g, display_name: "a\u202eb" }), "hidden-character"], [(g) => ({ ...g, platform: "x".repeat(65) }), "field-too-long"],
    // A re-bind-shaped body at /v1/rekey: no old_sig. An enroll body at /v1/rebind: member_id null.
    [(g) => ({ ...g, member_id: fx.members.A.id, display_name: null, platform: null }), "invalid-field", "/v1/rekey"], [(g) => g, "invalid-field", "/v1/rebind"],
  ];
  for (const [make, code, path = "/v1/enroll"] of cases) {
    const body = make(base(room(t, 1)));
    assert.equal((await flow(t, path, body)).body.error, code, `${path} ${JSON.stringify(body).slice(0, 80)}`);
  }
  assert.deepEqual([attempts(fx, inv.invite_id), spent(fx, inv.invite_id)], [0, false]);
  assert.equal((await flow(t, "/v1/enroll", base(room(t, 1)))).status, 200, "the untouched body still enrolls");
});

test("5.2 steps 4-5 (B2, D-iii, T-A2): a wrong secret, kind, member, audience, key or signature is the same 403; each counts; none spends the invite", async (tt) => {
  const fx = setup({ members: ["A"] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const inv = await invite(t);
  const s = seed();
  const sign = (over = {}, inviteOver = {}) => signEnrollmentRequest({ invite: { ...inv, ...inviteOver }, seedHex: s, displayName: "a", platform: "p", created: iso(T0), ...over }).body;
  const good = sign();
  const bad = [
    { ...good, secret: "0".repeat(64) },                                          // step 4: secret
    sign({}, { relay: { origin: "http://commons-relay.test:8081" } }),            // step 5: signed for another relay (aud)
    { ...good, sig: sign({ nonce: "a".repeat(32) }).sig },                        // step 5: signature over another descriptor
    { ...good, public_key: signEnrollmentRequest({ invite: inv, seedHex: seed(), displayName: "a", platform: "p" }).body.public_key },   // step 5: key does not derive the agent
  ];
  for (const body of bad) assert.deepEqual((await flow(t, "/v1/enroll", body)).body, REFUSED);
  assert.deepEqual([attempts(fx, inv.invite_id), spent(fx, inv.invite_id)], [4, false]);
  // T-A2: racing the real agent with bad proofs below the budget never burns the invite.
  const ok = await flow(t, "/v1/enroll", good);
  assert.equal(ok.status, 200);
  // The tags are relay-specific and per endpoint (D-iii).
  assert.deepEqual(Object.values(ENROLLMENT_TAGS), ["commons-relay.enroll.v1", "commons-relay.rekey.v1", "commons-relay.rebind.v1"]);
  // A spent invite: refused, and the refusal is counted against it but voids nothing.
  assert.deepEqual((await flow(t, "/v1/enroll", sign({ nonce: "b".repeat(32) }))).body, REFUSED);
  // An unknown invite id: the same 403, nothing to count against.
  assert.deepEqual((await flow(t, "/v1/enroll", { ...good, invite_id: "f".repeat(32) })).body, REFUSED);
  // Kind and member must match the invite (B2): a rekey invite for A at /v1/rebind with a rebind-shaped body.
  const rk = await invite(t, { kind: "rekey", member_id: fx.members.A.id });
  const asRebind = signEnrollmentRequest({ invite: { ...rk, kind: "rebind" }, seedHex: seed(), created: iso(T0) }).body;
  assert.deepEqual((await flow(t, "/v1/rebind", asRebind)).body, REFUSED);
  assert.equal(attempts(fx, rk.invite_id), 1);
});

test("M1 / D2: the fifth failure voids a live invite (alert, log); a voided re-bind invite's attempt dies invite-voided; then even a correct request is refused", async (tt) => {
  const fx = setup({ members: ["A"] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  assert.equal(ENROLL_FAILURE_BUDGET, 5);
  for (const kind of ["enroll", "rebind"]) {
    const at = room(t, 6);
    const inv = await invite(t, kind === "enroll" ? { at } : { kind: "rebind", member_id: fx.members.A.id, at });
    const s = seed();
    const good = signEnrollmentRequest({ invite: inv, seedHex: s, displayName: kind === "enroll" ? "a" : null, platform: kind === "enroll" ? "p" : null, created: iso(at) }).body;
    for (let i = 0; i < 5; i++) assert.deepEqual((await flow(t, `/v1/${kind}`, { ...good, secret: "0".repeat(64) })).body, REFUSED, `${kind} ${i}`);
    assert.equal(attempts(fx, inv.invite_id), 5);
    assert.notEqual(fx.db.prepare("SELECT voided_at FROM invites WHERE invite_id = ?").get(inv.invite_id).voided_at, null, `${kind}: voided`);
    assert.ok(alertsOf(fx, "invite.voided").some(a => a.invite_id === inv.invite_id && a.reason === "failure-budget"));
    assert.deepEqual((await flow(t, `/v1/${kind}`, good)).body, REFUSED, `${kind}: the real agent is refused once voided`);
    assert.equal(spent(fx, inv.invite_id), false);
    if (kind === "rebind") {
      assert.deepEqual({ ...fx.db.prepare("SELECT cause FROM rebind_ends WHERE invite_id = ?").get(inv.invite_id) }, { cause: "invite-voided" });
      assert.ok(alertsOf(fx, "rebind.dead").some(a => a.invite_id === inv.invite_id && a.cause === "invite-voided"));
    }
  }
});

test("5.2 step 6 (B9) and step 5's age: stale is 401 before any nonce; a future-dated request spends its nonce, is refused, and its replay is 409", async (tt) => {
  const fx = setup({ members: [] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const inv = await invite(t);
  const s = seed();
  const nonces = () => fx.db.prepare("SELECT count(*) n FROM request_nonces").get().n;
  const n0 = nonces();
  const stale = signEnrollmentRequest({ invite: inv, seedHex: s, displayName: "a", platform: "p", created: iso(T0 - 6 * MIN) }).body;
  assert.deepEqual((await flow(t, "/v1/enroll", stale)).body, { error: "stale" });
  assert.equal(nonces(), n0, "stale: no nonce spent");
  const future = signEnrollmentRequest({ invite: inv, seedHex: s, displayName: "a", platform: "p", created: iso(T0 + 2 * MIN) }).body;
  assert.deepEqual((await flow(t, "/v1/enroll", future)).body, { error: "stale" });
  assert.equal(nonces(), n0 + 1, "the future-dated request's nonce is spent first");
  t.setClock(T0 + 2 * MIN);
  assert.deepEqual((await flow(t, "/v1/enroll", future)).body, { error: "replay" }, "pre-seeding a future capture does not work (T-B6)");
  assert.equal(attempts(fx, inv.invite_id), 3);
  assert.equal(spent(fx, inv.invite_id), false);
});

test("RD1 one key ever, RD2 re-key only while active and unsuspended: each counted 409; a key used before never enrolls again", async (tt) => {
  const fx = setup({ members: ["A", "B"] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const inv = await invite(t);
  const reuse = signEnrollmentRequest({ invite: inv, seedHex: keySeedHex(fx.members.A.identity), displayName: "a", platform: "p", created: iso(T0) }).body;
  assert.deepEqual((await flow(t, "/v1/enroll", reuse)).body, { error: "key-not-new" });
  const rkA = await invite(t, { kind: "rekey", member_id: fx.members.A.id });
  const ownKey = signEnrollmentRequest({ invite: rkA, seedHex: keySeedHex(fx.members.A.identity), oldSeedHex: keySeedHex(fx.members.A.identity), created: iso(T0) }).body;
  assert.deepEqual((await flow(t, "/v1/rekey", ownKey)).body, { error: "key-not-new" }, "re-key onto the current key");
  // RD2: B's re-key invite was made while B was active; B is suspended before the request.
  const rkB = await invite(t, { kind: "rekey", member_id: fx.members.B.id });
  assert.equal((await fleet(t, "seat-1", "suspend", decision(fx, "seat-1", { cls: "SUSPEND", action: "suspend", subject: fx.members.B.id }))).body.state, "effective");
  const b = signEnrollmentRequest({ invite: rkB, seedHex: seed(), oldSeedHex: keySeedHex(fx.members.B.identity), created: iso(T0) }).body;
  const r = await flow(t, "/v1/rekey", b);
  assert.deepEqual([r.status, r.body.error], [409, "invalid-state"]);
  assert.deepEqual([attempts(fx, inv.invite_id), attempts(fx, rkA.invite_id), attempts(fx, rkB.invite_id)], [1, 1, 1]);
});

test("5.4 re-key over the wire: old_sig by the current key is required; on rekey.confirm the old key stops working and the new one works", async (tt) => {
  const fx = setup({ members: ["A"] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const A = fx.members.A.id, oldSeed = keySeedHex(fx.members.A.identity), newSeed = seed();
  const rk = await invite(t, { kind: "rekey", member_id: A });
  const wrongOld = signEnrollmentRequest({ invite: rk, seedHex: newSeed, oldSeedHex: seed(), created: iso(T0) }).body;
  assert.deepEqual((await flow(t, "/v1/rekey", wrongOld)).body, REFUSED, "old_sig by a key that is not A's current key");
  const body = signEnrollmentRequest({ invite: rk, seedHex: newSeed, oldSeedHex: oldSeed, created: iso(T0) }).body;
  // Only old_sig wrong: the new key's sig covers the right descriptor, old_sig is another key's (or the new key's) over the same bytes.
  const bytes = enrollmentSigningBytes(enrollmentDescriptor({ ...body, kind: "rekey", aud: RELAY_TEST_AUD, old_agent: fx.members.A.identity.uuaid }));
  for (const other of [seed(), newSeed])
    assert.deepEqual((await flow(t, "/v1/rekey", { ...body, old_sig: Buffer.from(ed25519.sign(bytes, Buffer.from(other, "hex"))).toString("hex") })).body, REFUSED);
  assert.equal(attempts(fx, rk.invite_id), 3);
  const res = await flow(t, "/v1/rekey", body);
  assert.deepEqual([res.status, res.body.kind, res.body.member_id, res.body.status], [200, "rekey", A, "pending"]);
  assert.equal((await status(t, newSeed)).status, 401, "a pending re-key key is not the member's key yet");
  const line = outboxFor(fx.db, res.body.enrollment_id);
  await fleet(t, "seat-3", "owner-record.confirm", ownerConfirm(fx, "seat-3", line, T0));
  const c = await fleet(t, "seat-2", "rekey.confirm", decision(fx, "seat-2", { cls: "D0", action: "rekey.confirm", subject: res.body.enrollment_id, args: { owner_line_ref: line.id } }));
  assert.equal(c.body.state, "effective");
  assert.deepEqual((await status(t, oldSeed)).body, { error: "unauthorized" });
  assert.deepEqual([(await status(t, newSeed)).body.member_id, (await status(t, newSeed)).body.status], [A, "active"]);
});

test("5.4 re-bind over the wire and the RD3 hook: the confirming seat sees the count; the second effective re-bind raises rebind.repeat", async (tt) => {
  const fx = setup({ members: ["A"] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  const A = fx.members.A.id;
  let current = keySeedHex(fx.members.A.identity);
  for (const round of [0, 1]) {
    const rb = await invite(t, { kind: "rebind", member_id: A });
    assert.equal((await status(t, current)).status, 401, "the re-bind suspends the member (its key is no longer accepted)");
    const next = seed();
    const res = await flow(t, "/v1/rebind", signEnrollmentRequest({ invite: rb, seedHex: next, created: iso(T0) }).body);
    assert.deepEqual([res.status, res.body.kind, res.body.member_id], [200, "rebind", A], JSON.stringify(res.body));
    assert.equal(alertsOf(fx, "enrollment.request").find(a => a.enrollment === res.body.enrollment_id).rebind_count, round);
    const view = (await send(t, signedSeed(keySeedHex(fx.keys["seat-2"]), "GET", "/v1/fleet/members", undefined, T0))).body;
    assert.equal(view.pending_enrollments.find(e => e.id === res.body.enrollment_id).rebind_count, round);
    // D1R: two seats on two families, neither the invite creator; effect after the owner posting is confirmed.
    const d = createDecision(fx.db, decision(fx, "seat-2", { cls: "D1R", action: "rebind.confirm", subject: res.body.enrollment_id }), T0);
    addVerdict(fx.db, approval(fx, "seat-4", d.id, "approve"), T0);
    confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-5", outboxFor(fx.db, d.id)), T0);
    assert.equal(fx.db.prepare("SELECT state FROM decisions WHERE id = ?").get(d.id).state, "effective");
    assert.equal((await status(t, next)).body.status, "active");
    current = next;
  }
  assert.deepEqual(alertsOf(fx, "rebind.repeat").map(a => [a.subject, a.count]), [[A, 2]]);
});

test("5.2 step 1: per-IP caps after the browser-origin refusal and before the size cap: 10 per hour, 5 at once; 9.2 freeze: 503, never counted", async (tt) => {
  const fx = setup({ members: [] });
  const t = await relayFor(fx);
  tt.after(() => t.r.close());
  assert.deepEqual(ENROLL_LIMITS, { perIpPerHour: 10, concurrentPerIp: 5, windowMs: 3600000 });
  // A browser request is refused 403 first and does not count.
  for (let i = 0; i < 3; i++) assert.equal((await flow(t, "/v1/enroll", {}, { origin: "" })).status, 403);
  // An oversize body counts (step 1 precedes step 2).
  assert.equal((await flow(t, "/v1/enroll", { pad: "x".repeat(5000) })).status, 413);
  for (let i = 0; i < 9; i++) assert.equal((await flow(t, "/v1/enroll", {})).status, 400, `attempt ${i + 2}`);
  assert.deepEqual((await flow(t, "/v1/enroll", {})).body, { error: "rate-limited" }, "the 11th within the hour");
  assert.deepEqual((await flow(t, "/v1/rebind", {})).body, { error: "rate-limited" }, "one budget across the three flows");
  t.setClock(T0 + HOUR + 1);
  assert.equal((await flow(t, "/v1/enroll", {})).status, 400, "the hour has passed");
  // Concurrency: five requests held at a barrier; the sixth is refused at once.
  const inv = await invite(t, { at: T0 + HOUR + 1 });   // before the hold: a signed request also stops at the barrier
  const bdir = join(t.dir, "barriers");
  mkdirSync(bdir, { mode: 0o700 });
  writeFileSync(join(bdir, "before-dispatch.hold"), "", { mode: 0o600 });
  const held = Array.from({ length: 5 }, () => flow(t, "/v1/enroll", signEnrollmentRequest({ invite: inv, seedHex: seed(), displayName: "a", platform: "p", created: iso(T0 + HOUR + 1) }).body));
  const end = Date.now() + 5000;
  while (!existsSync(join(bdir, "before-dispatch.reached")) && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 200));
  const sixth = await Promise.race([flow(t, "/v1/enroll", {}), new Promise(r => setTimeout(() => r({ body: "held: no concurrency cap" }), 3000))]);
  assert.deepEqual(sixth.body, { error: "rate-limited" }, "a sixth at once");
  rmSync(join(bdir, "before-dispatch.hold"));
  const results = (await Promise.all(held)).map(r => r.status).sort();
  assert.deepEqual(results, [200, 403, 403, 403, 403], "one spends the invite; the rest find it spent");
  // Freeze: 503 before any invite work; nothing counted.
  t.setClock(T0 + 3 * HOUR);
  const inv2 = await invite(t, { at: T0 + 3 * HOUR });
  assert.equal((await fleet(t, "owner", "freeze", decision(fx, "owner", { cls: "OWNER", action: "freeze", subject: "relay", at: T0 + 3 * HOUR }), T0 + 3 * HOUR)).status, 200);
  const frozen = await flow(t, "/v1/enroll", signEnrollmentRequest({ invite: inv2, seedHex: seed(), displayName: "a", platform: "p", created: iso(T0 + 3 * HOUR) }).body);
  assert.deepEqual([frozen.status, frozen.body], [503, { error: "frozen" }]);
  assert.equal(attempts(fx, inv2.invite_id), 0);
  assert.deepEqual(t.errors, []);
});
