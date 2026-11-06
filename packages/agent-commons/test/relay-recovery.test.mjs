// N40.1-N40.11 (spec v3.4 section 13; the D items' D8 calls them N36.1-N36.11, and the spec renumbers
// them because N36 is the C2 export test; with D-1): re-bind recovery at the reducer. An attempt dies
// (expiry, void, cancel, reversal, reinstate) exactly once; the ways out of a re-bind suspension are a
// completed re-bind, a retry, a D2 reinstate on an existing key, or the owner's reversal; a member is
// never active in between, and never active without an active key (RC-1). Scratch databases, fixture
// keys; the request side of an enrollment flow is the real one (src/relay/enroll.mjs), via the fixture.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMemberRecord, runSweep } from "../src/relay/board.mjs";
import { settleAll, rebindCount, rebindConfirmationView, voidInvite } from "../src/relay/governance.mjs";
import { exportRelay, verifyExport } from "../src/relay/signing.mjs";
import { setup, decision, approval, ownerConfirm, outboxFor, createInvite, applyEnrollmentRequest, seedRebind, clockResume, taskArgs,
  laneD0, promoteC1, rejects, createDecision, addVerdict, confirmOwnerRecord, T0, MIN, HOUR, DAY } from "./relay-fixtures.mjs";

const TTL72 = 3 * DAY;
const one = (fx, sql, ...a) => fx.db.prepare(sql).get(...a);
const all = (fx, sql, ...a) => fx.db.prepare(sql).all(...a).map(r => ({ ...r }));
const status = (fx, m) => one(fx, "SELECT status FROM members WHERE member_id = ?", m).status;
const keyStatus = (fx, pk) => one(fx, "SELECT status FROM keys WHERE public_key = ?", pk).status;
const activeKeys = (fx, m) => one(fx, "SELECT count(*) n FROM keys WHERE principal_kind = 'member' AND principal_id = ? AND status = 'active'", m).n;
const stateOf = (fx, id) => one(fx, "SELECT state FROM decisions WHERE id = ?", id).state;
const ends = (fx, inv) => one(fx, "SELECT cause, decision_id, at FROM rebind_ends WHERE invite_id = ?", inv);
const decisionOfInvite = (fx, inv) => one(fx, "SELECT decision_id FROM invites WHERE invite_id = ?", inv).decision_id;
const openSusp = (fx, m) => all(fx, "SELECT reason, invite_id, decision_id FROM suspensions WHERE member_id = ? AND ended_at IS NULL ORDER BY started_at, id", m);
const deathOutputs = (fx, inv) => ({
  log: fx.db.prepare("SELECT event FROM logs WHERE log = 'security'").all().map(r => JSON.parse(r.event)).filter(e => e.kind === "rebind.dead" && e.invite_id === inv).length,
  alert: all(fx, "SELECT detail FROM alerts WHERE kind = 'rebind.dead'").filter(a => JSON.parse(a.detail).invite_id === inv).length,
  owner: one(fx, "SELECT count(*) n FROM owner_record_outbox WHERE subject = ?", `rebind.dead:${inv}`).n,
});
const veto = (fx, subject, at) => createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "veto", subject, at }), at);
const verifies = (fx) => verifyExport(exportRelay(fx.db), fx.files.roster.body.principals);

/** Record every member status change with the member's active-key count at that moment (test-only TEMP trigger). */
function watch(fx) {
  fx.db.exec(`CREATE TEMP TABLE status_log(member_id TEXT, status TEXT, keys INTEGER);
    CREATE TEMP TRIGGER watch_status AFTER UPDATE OF status ON main.members BEGIN
      INSERT INTO status_log VALUES (NEW.member_id, NEW.status,
        (SELECT count(*) FROM main.keys k WHERE k.principal_kind = 'member' AND k.principal_id = NEW.member_id AND k.status = 'active'));
    END;`);
  return (m) => all(fx, "SELECT status, keys FROM status_log WHERE member_id = ? ORDER BY rowid", m);
}
const neverActiveKeyless = (log) => assert.equal(log.some(r => r.status === "active" && r.keys === 0), false, JSON.stringify(log));

/** D1R by seat-2 (openai) + seat-4 (google), owner post confirmed: a completed re-bind. */
function completeRebind(fx, enrollment, at) {
  const d = createDecision(fx.db, decision(fx, "seat-2", { cls: "D1R", action: "rebind.confirm", subject: enrollment, at }), at);
  addVerdict(fx.db, approval(fx, "seat-4", d.id, "approve", at), at);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-5", outboxFor(fx.db, d.id), at), at);
  assert.equal(stateOf(fx, d.id), "effective");
  return d;
}
/** A D2 reinstate of `member`, sponsor seat-1, three approvals on three families, posted at `at`; settled at `settleAt`. */
function reinstate(fx, member, at, settleAt = at + DAY) {
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "reinstate", subject: member, sponsor: "seat-1", at }), at);
  for (const s of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, s, d.id, "approve", at), at);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, d.id), at), at);
  if (settleAt !== null) settleAll(fx.db, settleAt);
  return d;
}
const cancel = (fx, invite, at, by = "seat-1") =>
  createDecision(fx.db, decision(fx, by, { cls: "D0", action: "rebind.cancel", subject: invite, args: { reason: "delivered to the wrong session" }, at }), at);

test("N40.1 (D-item N36.1) unspent expiry at exactly expires_at: dead once (alert, owner line, log once); still suspended on K1; claims stay released", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A"), K1 = fx.members.A.identity.publicKeyHex;
  laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
  handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
  const inv = createInvite(fx, { kind: "rebind", member_id: A, at: T0 + MIN });
  assert.equal(one(fx, "SELECT state FROM claims WHERE task_id = 't1'").state, "released");
  runSweep(fx.db, inv.expires_at - 1);
  assert.equal(ends(fx, inv.invite_id), undefined, "not before expires_at");
  runSweep(fx.db, inv.expires_at);
  assert.deepEqual({ ...ends(fx, inv.invite_id) }, { cause: "invite-expired", decision_id: null, at: inv.expires_at });
  runSweep(fx.db, inv.expires_at + HOUR);
  assert.deepEqual(deathOutputs(fx, inv.invite_id), { log: 1, alert: 1, owner: 1 });
  assert.deepEqual([status(fx, A), keyStatus(fx, K1)], ["suspended", "active"]);
  assert.equal(one(fx, "SELECT state FROM claims WHERE task_id = 't1'").state, "released");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("N40.2 (D-item N36.2) 72 h re-bind enrollment expiry: the key is revoked for ever, the pending D1R lapses, a later D1R is refused", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id;
  const rb = seedRebind(fx, "A", { at: T0 });
  const d1r = createDecision(fx.db, decision(fx, "seat-2", { cls: "D1R", action: "rebind.confirm", subject: rb.enrollment, at: T0 }), T0);
  runSweep(fx.db, T0 + TTL72 - 1);
  assert.equal(keyStatus(fx, rb.identity.publicKeyHex), "pending");
  runSweep(fx.db, T0 + TTL72);
  assert.equal(keyStatus(fx, rb.identity.publicKeyHex), "revoked");
  assert.equal(stateOf(fx, d1r.id), "lapsed");
  assert.ok(fx.db.prepare("SELECT event FROM logs WHERE log = 'decision'").all().some(r => { const e = JSON.parse(r.event); return e.kind === "decision.lapsed" && e.id === d1r.id && e.cause === "enrollment-expired"; }));
  assert.equal(ends(fx, rb.invite).cause, "enrollment-expired");
  rejects(() => createDecision(fx.db, decision(fx, "seat-3", { cls: "D1R", action: "rebind.confirm", subject: rb.enrollment, at: T0 + TTL72 }), T0 + TTL72), "rebind-attempt-dead");
  // One key ever (RD1): a fresh attempt cannot bring that key back.
  createInvite(fx, { kind: "rebind", member_id: A, at: T0 + TTL72 });
  rejects(() => fx.db.prepare("INSERT INTO keys(public_key, agent, principal_kind, principal_id, status, added_at, revoked_at) VALUES (?, ?, 'member', ?, 'pending', ?, NULL)")
    .run(rb.identity.publicKeyHex, rb.identity.uuaid, A, T0 + TTL72), "UNIQUE");
  assert.equal(status(fx, A), "suspended");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("N40.3 (D-item N36.3) rebind.cancel: unspent -> void; spent -> key revoked + D1R lapsed; refused after completion, when dead, by a non-lane-owner, while frozen", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id;
  const i1 = createInvite(fx, { kind: "rebind", member_id: A, at: T0 });
  rejects(() => cancel(fx, i1.invite_id, T0, "seat-2"), "not the lane owner");
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "rebind.cancel", subject: i1.invite_id, args: {}, at: T0 }), T0), "args.reason");
  const c1 = cancel(fx, i1.invite_id, T0 + MIN);
  assert.equal(c1.state, "effective");
  assert.notEqual(one(fx, "SELECT voided_at FROM invites WHERE invite_id = ?", i1.invite_id).voided_at, null);
  assert.deepEqual({ ...ends(fx, i1.invite_id) }, { cause: "cancelled", decision_id: c1.id, at: T0 + MIN });
  assert.equal(status(fx, A), "suspended", "a cancel is not a recovery");
  rejects(() => cancel(fx, i1.invite_id, T0 + 2 * MIN), "rebind-attempt-dead");
  // Spent: the retry is allowed (the old attempt is dead); cancel revokes its pending key and lapses the D1R.
  const rb = seedRebind(fx, "A", { at: T0 + 2 * MIN });
  const d1r = createDecision(fx.db, decision(fx, "seat-2", { cls: "D1R", action: "rebind.confirm", subject: rb.enrollment, at: T0 + 2 * MIN }), T0 + 2 * MIN);
  cancel(fx, rb.invite, T0 + 3 * MIN);
  assert.deepEqual([keyStatus(fx, rb.identity.publicKeyHex), stateOf(fx, d1r.id), ends(fx, rb.invite).cause], ["revoked", "lapsed", "cancelled"]);
  // Completed: refused.
  const rb2 = seedRebind(fx, "A", { at: T0 + 4 * MIN });
  completeRebind(fx, rb2.enrollment, T0 + 4 * MIN);
  rejects(() => cancel(fx, rb2.invite, T0 + 5 * MIN), "rebind-attempt-completed");
  // Frozen: refused.
  const i3 = createInvite(fx, { kind: "rebind", member_id: A, at: T0 + 6 * MIN });
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "freeze", subject: "relay", at: T0 + 7 * MIN }), T0 + 7 * MIN);
  rejects(() => cancel(fx, i3.invite_id, T0 + 8 * MIN), "frozen");
});

test("N40.4 (D-item N36.4) retry: refused while live; after death the new suspension opens before the old ends (never active between); RC-2 refusals", () => {
  const fx = setup({ members: ["A", "B"] });
  const A = fx.members.A.id;
  const log = watch(fx);
  const i1 = createInvite(fx, { kind: "rebind", member_id: A, at: T0 });
  rejects(() => createInvite(fx, { kind: "rebind", member_id: A, at: T0 + MIN }), "rebind-attempt-live");
  runSweep(fx.db, i1.expires_at);
  const i2 = createInvite(fx, { kind: "rebind", member_id: A, at: i1.expires_at + MIN });
  const old = one(fx, "SELECT ended_at, ended_by_decision FROM suspensions WHERE invite_id = ?", i1.invite_id);
  const fresh = one(fx, "SELECT started_at FROM suspensions WHERE invite_id = ?", i2.invite_id);
  assert.equal(old.ended_by_decision, decisionOfInvite(fx, i2.invite_id), "the old suspension cites the new invite.create");
  assert.ok(fresh.started_at <= old.ended_at);
  assert.deepEqual(log(A).map(r => r.status), ["suspended", "suspended"], "never active in between");
  assert.equal(status(fx, A), "suspended");
  // RC-2: no re-bind invite for a revoked or pending member.
  veto(fx, "fx-enroll-B", i1.expires_at + 2 * MIN);
  assert.equal(status(fx, fx.members.B.id), "revoked");
  rejects(() => createInvite(fx, { kind: "rebind", member_id: fx.members.B.id, at: i1.expires_at + 3 * MIN }), "member not enrolled");
  const pending = applyEnrollmentRequest(fx, { invite: createInvite(fx, { at: i1.expires_at + 3 * MIN }), name: "P", at: i1.expires_at + 3 * MIN });
  rejects(() => createInvite(fx, { kind: "rebind", member_id: pending.memberId, at: i1.expires_at + 4 * MIN }), "member not enrolled");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("N40.5 (D-item N36.5) owner veto of a rebind invite.create: unspent -> active on K1; spent -> key revoked, D1R lapsed, active; completed -> record-only", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id, K1 = fx.members.A.identity.publicKeyHex;
  const log = watch(fx);
  const i1 = createInvite(fx, { kind: "rebind", member_id: A, at: T0 });
  const v1 = veto(fx, decisionOfInvite(fx, i1.invite_id), T0 + MIN);
  assert.deepEqual([status(fx, A), keyStatus(fx, K1), ends(fx, i1.invite_id).cause, ends(fx, i1.invite_id).decision_id], ["active", "active", "reversed", v1.id]);
  assert.equal(one(fx, "SELECT ended_by_decision FROM suspensions WHERE invite_id = ?", i1.invite_id).ended_by_decision, v1.id);
  const rb = seedRebind(fx, "A", { at: T0 + 2 * MIN });
  const d1r = createDecision(fx.db, decision(fx, "seat-2", { cls: "D1R", action: "rebind.confirm", subject: rb.enrollment, at: T0 + 2 * MIN }), T0 + 2 * MIN);
  veto(fx, decisionOfInvite(fx, rb.invite), T0 + 3 * MIN);
  assert.deepEqual([status(fx, A), keyStatus(fx, K1), keyStatus(fx, rb.identity.publicKeyHex), stateOf(fx, d1r.id)], ["active", "active", "revoked", "lapsed"]);
  const done = seedRebind(fx, "A", { at: T0 + 4 * MIN });
  completeRebind(fx, done.enrollment, T0 + 4 * MIN);
  const before = { status: status(fx, A), key: keyStatus(fx, done.identity.publicKeyHex) };
  veto(fx, decisionOfInvite(fx, done.invite), T0 + 5 * MIN);
  assert.deepEqual({ status: status(fx, A), key: keyStatus(fx, done.identity.publicKeyHex) }, before, "completed: record-only");
  assert.equal(ends(fx, done.invite), undefined, "a completed attempt is never dead");
  // An unrelated decision suspension stays: the member stays suspended.
  createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: A, at: T0 + 6 * MIN }), T0 + 6 * MIN);
  const i4 = createInvite(fx, { kind: "rebind", member_id: A, at: T0 + 7 * MIN });
  veto(fx, decisionOfInvite(fx, i4.invite_id), T0 + 8 * MIN);
  assert.deepEqual(openSusp(fx, A).map(s => s.reason), ["decision"]);
  assert.equal(status(fx, A), "suspended");
  neverActiveKeyless(log(A));
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("N40.5 (D-item N36.5) / D-1 RC-1: no reversal leaves a non-revoked member active with 0 active keys, per kind", () => {
  const fx = setup({ members: ["A", "B", "C", "E", "F"] });
  const log = watch(fx);
  // enroll: an unconfirmed enroll invite reversed -> the pending member is revoked (not active).
  const pe = applyEnrollmentRequest(fx, { invite: createInvite(fx, { at: T0 }), name: "PE", at: T0 });
  veto(fx, decisionOfInvite(fx, one(fx, "SELECT invite_id FROM enrollments WHERE member_id = ?", pe.memberId).invite_id), T0 + MIN);
  assert.deepEqual([status(fx, pe.memberId), activeKeys(fx, pe.memberId)], ["revoked", 0]);
  // rekey invite reversed: only its own pending key is revoked; the current key stays (B active on 1 key).
  const B = fx.members.B.id;
  const rk = applyEnrollmentRequest(fx, { invite: createInvite(fx, { kind: "rekey", member_id: B, at: T0 }), name: "B", at: T0 });
  veto(fx, decisionOfInvite(fx, one(fx, "SELECT invite_id FROM enrollments WHERE id = ?", rk.enrollment).invite_id), T0 + MIN);
  assert.deepEqual([status(fx, B), activeKeys(fx, B), keyStatus(fx, rk.identity.publicKeyHex)], ["active", 1, "revoked"]);
  // rebind.confirm reversed (D5): C has 0 active keys and is suspended by the veto.
  const C = fx.members.C.id;
  const rbC = seedRebind(fx, "C", { at: T0 });
  const d1rC = completeRebind(fx, rbC.enrollment, T0);
  const vC = veto(fx, d1rC.id, T0 + MIN);
  assert.deepEqual([status(fx, C), activeKeys(fx, C), openSusp(fx, C)[0].decision_id], ["suspended", 0, vC.id]);
  // ... then a rebind invite reversed while C has 0 keys: C stays suspended (the D5 suspension).
  const iC = createInvite(fx, { kind: "rebind", member_id: C, at: T0 + 2 * MIN });
  veto(fx, decisionOfInvite(fx, iC.invite_id), T0 + 3 * MIN);
  assert.deepEqual([status(fx, C), activeKeys(fx, C)], ["suspended", 0]);
  rejects(() => reinstate(fx, C, T0 + 4 * MIN, null), "no-active-key");
  // rekey.confirm reversed (D5): E's new key is revoked, the old one already was: 0 keys, suspended.
  const E = fx.members.E.id;
  const rkE = applyEnrollmentRequest(fx, { invite: createInvite(fx, { kind: "rekey", member_id: E, at: T0 }), name: "E", at: T0 });
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", rkE.outbox, T0), T0);
  const rkc = createDecision(fx.db, decision(fx, "seat-2", { cls: "D0", action: "rekey.confirm", subject: rkE.enrollment, args: { owner_line_ref: rkE.outbox.id }, at: T0 }), T0);
  veto(fx, rkc.id, T0 + MIN);
  assert.deepEqual([status(fx, E), activeKeys(fx, E)], ["suspended", 0]);
  // suspend reversed when it would end the last suspension of a 0-key member: the guard (i) fires.
  // (No ordinary path reaches 0 keys without a veto suspension; the key is revoked directly to force the case.)
  const F = fx.members.F.id;
  const sF = createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: F, at: T0 }), T0);
  fx.db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE principal_kind = 'member' AND principal_id = ?").run(T0 + 1, F);
  const vF = veto(fx, sF.id, T0 + MIN);
  assert.deepEqual([status(fx, F), activeKeys(fx, F), openSusp(fx, F).map(s => s.decision_id)], ["suspended", 0, [vF.id]]);
  for (const m of [pe.memberId, B, C, E, F]) neverActiveKeyless(log(m));
});

test("N40.6 (D-item N36.6) D2 reinstate: kills a live attempt and returns on K1; ends dead-attempt and decision suspensions; needs an active key; beats griefing", () => {
  const fx = setup({ members: ["A", "B", "C", "D"] });
  // Kills a live (unspent) attempt, cause reinstated; back on K1.
  const A = fx.members.A.id, K1 = fx.members.A.identity.publicKeyHex;
  const iA = createInvite(fx, { kind: "rebind", member_id: A, at: T0 });
  const rA = reinstate(fx, A, T0 + MIN);
  assert.deepEqual([stateOf(fx, rA.id), ends(fx, iA.invite_id).cause, ends(fx, iA.invite_id).decision_id], ["effective", "reinstated", rA.id]);
  assert.deepEqual([status(fx, A), keyStatus(fx, K1)], ["active", "active"]);
  // After a dead attempt plus a decision suspension: both end.
  const B = fx.members.B.id;
  createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: B, at: T0 }), T0);
  const iB = createInvite(fx, { kind: "rebind", member_id: B, at: T0 });
  runSweep(fx.db, iB.expires_at);
  const rB = reinstate(fx, B, iB.expires_at + MIN);
  assert.equal(ends(fx, iB.invite_id).cause, "invite-expired");
  assert.deepEqual([status(fx, B), openSusp(fx, B)], ["active", []]);
  assert.ok(all(fx, "SELECT ended_by_decision FROM suspensions WHERE member_id = ?", B).every(s => s.ended_by_decision === rB.id));
  // Lapses at effect when the member has lost every active key during the window.
  const C = fx.members.C.id;
  createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: C, at: T0 }), T0);
  const rC = reinstate(fx, C, T0 + MIN, null);
  const rbC = seedRebind(fx, "C", { at: T0 + 2 * MIN });
  veto(fx, completeRebind(fx, rbC.enrollment, T0 + 2 * MIN).id, T0 + 3 * MIN);
  assert.equal(activeKeys(fx, C), 0);
  settleAll(fx.db, T0 + MIN + DAY);
  assert.equal(stateOf(fx, rC.id), "lapsed");
  assert.ok(fx.db.prepare("SELECT event FROM logs WHERE log = 'decision'").all().some(r => { const e = JSON.parse(r.event); return e.kind === "decision.lapsed" && e.id === rC.id && e.cause === "no-active-key"; }));
  // Griefing: a re-bind invite issued inside the D2's 24 h window is killed at effect.
  const D = fx.members.D.id;
  createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: D, at: T0 }), T0);
  const rD = reinstate(fx, D, T0 + MIN, null);
  const grief = createInvite(fx, { kind: "rebind", member_id: D, at: T0 + HOUR });
  settleAll(fx.db, T0 + MIN + DAY);
  assert.deepEqual([stateOf(fx, rD.id), ends(fx, grief.invite_id).cause, status(fx, D)], ["effective", "reinstated", "active"]);
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("N40.7 (D-item N36.7) counts: dead attempts never count; rebind.repeat at 2 and 3 only; dead_attempts on the confirmation view", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id;
  const repeats = () => all(fx, "SELECT detail FROM alerts WHERE kind = 'rebind.repeat' AND subject = ?", A).map(a => JSON.parse(a.detail).count);
  let t = T0;
  const dead = [];
  for (let i = 1; i <= 3; i++) {
    const d = createInvite(fx, { kind: "rebind", member_id: A, at: t });
    cancel(fx, d.invite_id, t + MIN);
    dead.push(d.invite_id);
    const rb = seedRebind(fx, "A", { at: t + 2 * MIN });
    completeRebind(fx, rb.enrollment, t + 2 * MIN);
    assert.equal(rebindCount(fx.db, A), i);
    assert.deepEqual(repeats(), [2, 3].slice(0, Math.max(0, i - 1)));
    t += HOUR;
  }
  const last = seedRebind(fx, "A", { at: t });
  const view = rebindConfirmationView(fx.db, last.enrollment);
  assert.equal(view.rebind_count, 3);
  assert.deepEqual(view.dead_attempts.map(x => [x.invite_id, x.cause]), dead.map(id => [id, "cancelled"]));
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("N40.8 (D-item N36.8) D1R reversed -> a new re-bind completes -> still suspended by the veto -> D2 reinstate -> active", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id;
  const log = watch(fx);
  const rb1 = seedRebind(fx, "A", { at: T0 });
  const v = veto(fx, completeRebind(fx, rb1.enrollment, T0).id, T0 + MIN);
  assert.deepEqual([status(fx, A), activeKeys(fx, A), openSusp(fx, A)[0].decision_id], ["suspended", 0, v.id]);
  const rb2 = seedRebind(fx, "A", { at: T0 + 2 * MIN });
  completeRebind(fx, rb2.enrollment, T0 + 2 * MIN);
  assert.deepEqual([status(fx, A), activeKeys(fx, A), openSusp(fx, A).map(s => s.reason)], ["suspended", 1, ["decision"]]);
  reinstate(fx, A, T0 + 3 * MIN);
  assert.deepEqual([status(fx, A), keyStatus(fx, rb2.identity.publicKeyHex)], ["active", "active"]);
  neverActiveKeyless(log(A));
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("N40.9 (D-item N36.9) freeze and clock-suspect: no death is recorded; it is recorded at the first sweep after; the void path waits too", () => {
  const fx = setup({ members: ["A", "B"] });
  const A = fx.members.A.id, B = fx.members.B.id;
  const iA = createInvite(fx, { kind: "rebind", member_id: A, at: T0 });
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "freeze", subject: "relay", at: T0 + MIN }), T0 + MIN);
  runSweep(fx.db, iA.expires_at + HOUR);
  assert.equal(ends(fx, iA.invite_id), undefined, "nothing while frozen");
  rejects(() => voidInvite(fx.db, iA.invite_id, iA.expires_at + HOUR), "frozen");
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "unfreeze", subject: "relay", at: iA.expires_at + 2 * HOUR }), iA.expires_at + 2 * HOUR);
  runSweep(fx.db, iA.expires_at + 3 * HOUR);
  assert.deepEqual({ ...ends(fx, iA.invite_id) }, { cause: "invite-expired", decision_id: null, at: iA.expires_at + 3 * HOUR }, "invites are not extended by a freeze");
  // Clock-suspect: a rollback latches; no death until a lane-owner clock.resume.
  const t = iA.expires_at + 4 * HOUR;
  const iB = createInvite(fx, { kind: "rebind", member_id: B, at: t });
  runSweep(fx.db, iB.expires_at - MIN);
  runSweep(fx.db, iB.expires_at - MIN - 6000);
  runSweep(fx.db, iB.expires_at + HOUR);
  assert.equal(ends(fx, iB.invite_id), undefined, "nothing while the clock is suspect");
  rejects(() => voidInvite(fx.db, iB.invite_id, iB.expires_at + HOUR), "clock-suspect");
  createDecision(fx.db, clockResume(fx, "seat-1", iB.expires_at + 2 * HOUR), iB.expires_at + 2 * HOUR);
  runSweep(fx.db, iB.expires_at + 2 * HOUR);
  assert.equal(ends(fx, iB.invite_id).cause, "invite-expired");
});

test("N40 (Addendum D2 invite-voided) void path: five failures void an unspent re-bind invite (L1 counts them); the attempt dies invite-voided", () => {
  const fx = setup({ members: ["A"] });
  const iA = createInvite(fx, { kind: "rebind", member_id: fx.members.A.id, at: T0 });
  voidInvite(fx.db, iA.invite_id, T0 + MIN);
  assert.deepEqual({ ...ends(fx, iA.invite_id) }, { cause: "invite-voided", decision_id: null, at: T0 + MIN });
  assert.deepEqual(deathOutputs(fx, iA.invite_id), { log: 1, alert: 1, owner: 1 });
  rejects(() => voidInvite(fx.db, iA.invite_id, T0 + 2 * MIN), "already voided");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("N40.10 (D-item N36.10) export v4 verifies; a tampered rebind_ends cause, a suspension's ended_by_decision or invites.decision_id is refused", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id;
  const i1 = createInvite(fx, { kind: "rebind", member_id: A, at: T0 });
  runSweep(fx.db, i1.expires_at);
  const i2 = createInvite(fx, { kind: "rebind", member_id: A, at: i1.expires_at + MIN });
  cancel(fx, i2.invite_id, i1.expires_at + 2 * MIN);
  reinstate(fx, A, i1.expires_at + 3 * MIN);
  const clean = exportRelay(fx.db);
  assert.equal(clean.v, "commons-relay-export/4");
  const roster = fx.files.roster.body.principals;
  assert.deepEqual(verifyExport(clean, roster), { ok: true, problems: [] });
  const cases = [
    ["rebind_ends cause", e => { e.rebind_ends.find(r => r.invite_id === i1.invite_id).cause = "invite-voided"; }, "rebind-end-mismatch"],
    ["a suspension's ended_by_decision", e => { e.suspensions.find(s => s.invite_id === i1.invite_id).ended_by_decision = decisionOfInvite(fx, i1.invite_id); }, "suspension-end-mismatch"],
    ["invites.decision_id", e => { e.invites.find(i => i.invite_id === i2.invite_id).decision_id = decisionOfInvite(fx, i1.invite_id); }, "invite-decision-mismatch"],
    ["a dropped rebind_ends row", e => { e.rebind_ends = e.rebind_ends.filter(r => r.invite_id !== i2.invite_id); }, "row-missing"],
    ["a member shown active without an active key (D-1)", e => { e.keys.filter(k => k.principal_id === A).forEach(k => { k.status = "revoked"; k.revoked_at = T0; }); }, "active-without-key"],
  ];
  for (const [name, mutate, reason] of cases) {
    const exp = structuredClone(clean);
    mutate(exp);
    const res = verifyExport(exp, roster);
    assert.ok(res.problems.some(p => p.reason === reason), `${name}: expected ${reason}, got ${JSON.stringify(res.problems)}`);
  }
});

test("N40.11 (D-item N36.11) owner veto of an unconfirmed enroll invite -> the member is revoked; of an unconfirmed rekey invite -> the old key is kept", () => {
  const fx = setup({ members: ["A"] });
  const pe = applyEnrollmentRequest(fx, { invite: createInvite(fx, { at: T0 }), name: "N", at: T0 });
  veto(fx, decisionOfInvite(fx, one(fx, "SELECT invite_id FROM enrollments WHERE member_id = ?", pe.memberId).invite_id), T0 + MIN);
  assert.deepEqual([status(fx, pe.memberId), keyStatus(fx, pe.identity.publicKeyHex)], ["revoked", "revoked"]);
  const A = fx.members.A.id, K1 = fx.members.A.identity.publicKeyHex;
  const rk = applyEnrollmentRequest(fx, { invite: createInvite(fx, { kind: "rekey", member_id: A, at: T0 }), name: "A", at: T0 });
  veto(fx, decisionOfInvite(fx, one(fx, "SELECT invite_id FROM enrollments WHERE id = ?", rk.enrollment).invite_id), T0 + MIN);
  assert.deepEqual([status(fx, A), keyStatus(fx, K1), keyStatus(fx, rk.identity.publicKeyHex)], ["active", "active", "revoked"]);
  // An unspent enroll invite reversed: voided.
  const unspent = createInvite(fx, { at: T0 + 2 * MIN });
  veto(fx, decisionOfInvite(fx, unspent.invite_id), T0 + 3 * MIN);
  assert.notEqual(one(fx, "SELECT voided_at FROM invites WHERE invite_id = ?", unspent.invite_id).voided_at, null);
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});
