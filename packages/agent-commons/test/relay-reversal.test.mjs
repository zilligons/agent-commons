// N37 (spec v3.3 section 9.7, -022 Addendum C3): owner reversal. The owner's veto of an
// effective decision reverses it: history is kept, every effect is a new compensating row
// in the veto's transaction, and a reversed decision is final. Each row of the 9.7 table
// is tested with its passing sibling. Scratch databases, fixture keys.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { settleAll, roleOf, credits, rebindCount } from "../src/relay/governance.mjs";
import { exportRelay, verifyExport } from "../src/relay/signing.mjs";
import { setup, decision, approval, ownerConfirm, outboxFor, createInvite, applyEnrollmentRequest, seedRebind, taskArgs, laneD0, promoteC1,
  eligibleForC2, rejects, T0, MIN, HOUR, DAY, createDecision, addVerdict, confirmOwnerRecord } from "./relay-fixtures.mjs";

const one = (fx, sql, ...a) => fx.db.prepare(sql).get(...a);
const all = (fx, sql, ...a) => fx.db.prepare(sql).all(...a).map(r => ({ ...r }));
const stateOf = (fx, id) => one(fx, "SELECT state FROM decisions WHERE id = ?", id).state;
const veto = (fx, subject, at = T0 + 10 * DAY) => createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "veto", subject, at }), at);
const effects = (fx, id) => fx.db.prepare("SELECT event FROM logs WHERE log = 'decision'").all().map(r => JSON.parse(r.event))
  .filter(e => e.kind === "reversal.effect" && e.decision === id).map(e => e.effect);
const accepts = (fx, member) => all(fx, "SELECT c.decision_id, c.submission_id FROM contributions c WHERE c.member_id = ? ORDER BY c.accepted_at", member);
const verifies = (fx) => verifyExport(exportRelay(fx.db), fx.files.roster.body.principals);
const claim = (fx, member, task, at, id = `c-${task}-${at}`) => handleMemberRecord(fx.db, member, { type: "claim", record_id: id, body: { task_id: task, lease_ms: HOUR } }, at);
/** A D2 role.change for `member` to `role`, sponsor seat-1, approved by three seats on three families, posted, past its window. */
function effectiveD2(fx, member, role, at) {
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: member, sponsor: "seat-1", args: { role }, at }), at);
  for (const seat of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, d.id, "approve", at), at);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, d.id), at), at);
  settleAll(fx.db, at + DAY);
  return d;
}

test("reversed accept: the submission becomes reversed, the task goes to triage, credit drops; history and finality hold", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  eligibleForC2(fx, "A");
  const [first, second] = accepts(fx, A);
  assert.deepEqual(credits(fx.db, A), { n: 3, days: 3 });
  const v = veto(fx, first.decision_id);
  assert.equal(v.state, "effective");
  assert.equal(stateOf(fx, first.decision_id), "reversed");
  assert.equal(one(fx, "SELECT state FROM submissions WHERE submission_id = ?", first.submission_id).state, "reversed");
  const task = one(fx, "SELECT x.task_id, t.status, t.attempts FROM submission_details x JOIN tasks t USING(task_id) WHERE x.submission_id = ?", first.submission_id);
  assert.deepEqual({ status: task.status, attempts: task.attempts }, { status: "needs-triage", attempts: 0 });
  assert.deepEqual(credits(fx.db, A), { n: 2, days: 2 }, "the reversed accept no longer counts");
  // Passing sibling: the unreversed accept keeps its effect.
  assert.equal(one(fx, "SELECT state FROM submissions WHERE submission_id = ?", second.submission_id).state, "accepted");
  // History: the contribution row, the verdicts and the outbox stay; one owner line names the reversal.
  assert.equal(all(fx, "SELECT 1 FROM contributions WHERE member_id = ?", A).length, 3);
  assert.ok(all(fx, "SELECT 1 FROM approvals WHERE decision_id = ?", first.decision_id).length >= 2);
  assert.match(one(fx, "SELECT line FROM owner_record_outbox WHERE subject = ?", `reversal:${first.decision_id}`).line, /submission\.reversed/);
  // Final: no second veto, no way back to effective; the task is reopened by a seat's D0.
  rejects(() => veto(fx, first.decision_id), "veto needs a pending D2 or an effective decision");
  rejects(() => fx.db.prepare("UPDATE decisions SET state = 'effective' WHERE id = ?").run(first.decision_id), "illegal-transition");
  rejects(() => fx.db.prepare("UPDATE submissions SET state = 'accepted' WHERE submission_id = ?").run(first.submission_id), "submission-reversal");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("eligibility counts only currently-effective accepts, at proposal and at effect; an effective role is flagged, not changed", () => {
  const fx = setup({ members: ["A", "B"] });
  // A pending D2 that stops qualifying lapses at effect time, with the cause logged.
  const A = promoteC1(fx, "A");
  eligibleForC2(fx, "A");
  const now = T0 + 3 * DAY;
  const d2 = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-1", args: { role: "C2" }, at: now }), now);
  for (const seat of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, d2.id), now), now);
  veto(fx, accepts(fx, A)[0].decision_id, now + HOUR);
  settleAll(fx.db, now + DAY);
  assert.equal(stateOf(fx, d2.id), "lapsed");
  assert.ok(fx.db.prepare("SELECT event FROM logs WHERE log = 'decision'").all().map(r => JSON.parse(r.event)).some(e => e.kind === "decision.lapsed" && e.id === d2.id && e.cause === "not-eligible"));
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-1", args: { role: "C2" }, at: now + DAY }), now + DAY), "not-eligible");
  // B reaches C2; reversing one of its accepts afterwards raises eligibility.lost and leaves the role alone.
  const B = promoteC1(fx, "B");
  eligibleForC2(fx, "B");
  effectiveD2(fx, B, "C2", now);
  assert.equal(roleOf(fx.db, B), "C2");
  veto(fx, accepts(fx, B)[0].decision_id, now + 2 * DAY);
  assert.equal(roleOf(fx.db, B), "C2", "no automatic demotion");
  assert.deepEqual(all(fx, "SELECT subject, detail FROM alerts WHERE kind = 'eligibility.lost'").map(r => ({ subject: r.subject, ...JSON.parse(r.detail) })),
    [{ subject: B, role: "C2", cause: `reversal of ${accepts(fx, B)[0].decision_id}` }]);
  assert.ok(fx.db.prepare("SELECT event FROM logs WHERE log = 'security'").all().some(r => JSON.parse(r.event).kind === "eligibility.lost"));
  assert.ok(one(fx, "SELECT 1 FROM owner_record_outbox WHERE subject = ?", `eligibility.lost:${B}`), "an owner-visible line, not a member notice");
});

test("reversed role decisions: re-projected from the effective grants (latest wins); a lower cap releases the newest claims", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  const c1 = one(fx, "SELECT decision_id FROM roles WHERE member_id = ? AND role = 'C1'", A).decision_id;
  eligibleForC2(fx, "A");
  const now = T0 + 3 * DAY;
  const toC2 = effectiveD2(fx, A, "C2", now);
  const later = now + 2 * DAY;
  for (const [i, t] of ["r1", "r2", "r3"].entries()) { laneD0(fx, "task.open", t, taskArgs(["docs"]), "seat-1", later); claim(fx, A, t, later + i); }
  // Reversing role.c1, which is not the latest grant: nothing changes.
  veto(fx, c1, later + HOUR);
  assert.deepEqual([roleOf(fx.db, A), effects(fx, c1)], ["C2", ["role.unchanged"]]);
  // Reversing the C2 promotion: the latest effective grant is now enroll.confirm (C0, cap 0), so every live claim is released, newest first.
  veto(fx, toC2.id, later + 2 * HOUR);
  assert.equal(roleOf(fx.db, A), "C0");
  const row = one(fx, "SELECT role, decision_id FROM roles WHERE member_id = ? ORDER BY seq DESC LIMIT 1", A);
  assert.equal(row.role, "C0");
  assert.equal(one(fx, "SELECT action FROM decisions WHERE id = ?", row.decision_id).action, "veto", "the re-projection row cites the veto");
  assert.deepEqual(all(fx, "SELECT task_id, state, released_reason FROM claims WHERE task_id IN ('r1','r2','r3') ORDER BY task_id"),
    ["r1", "r2", "r3"].map(task_id => ({ task_id, state: "released", released_reason: "reversal" })));
  assert.deepEqual(all(fx, "SELECT status, attempts FROM tasks WHERE task_id IN ('r1','r2','r3')"), [0, 1, 2].map(() => ({ status: "open", attempts: 0 })));
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("newest-first release: a C2 holding three claims re-projected to C1 keeps only its oldest", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  eligibleForC2(fx, "A");
  const now = T0 + 3 * DAY;
  const toC2 = effectiveD2(fx, A, "C2", now);
  const later = now + 2 * DAY;
  for (const [i, t] of ["o1", "o2", "o3"].entries()) { laneD0(fx, "task.open", t, taskArgs(["docs"]), "seat-1", later); claim(fx, A, t, later + i * MIN); }
  veto(fx, toC2.id, later + HOUR);
  assert.equal(roleOf(fx.db, A), "C1");
  assert.deepEqual(all(fx, "SELECT task_id, state FROM claims WHERE task_id IN ('o1','o2','o3') ORDER BY task_id"),
    [{ task_id: "o1", state: "live" }, { task_id: "o2", state: "released" }, { task_id: "o3", state: "released" }]);
});

test("reversed suspend and reinstate: the suspension ends (held work back in review, claims not restored) or re-opens", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
  laneD0(fx, "task.open", "t2", taskArgs(["docs"]));
  const c = claim(fx, A, "t1", T0);
  const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: 1, kind: "report", body: "done" } }, T0);
  claim(fx, A, "t2", T0);
  const s = createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: A, at: T0 + MIN }), T0 + MIN);
  assert.equal(one(fx, "SELECT status FROM members WHERE member_id = ?", A).status, "suspended");
  veto(fx, s.id, T0 + HOUR);
  assert.equal(one(fx, "SELECT status FROM members WHERE member_id = ?", A).status, "active");
  assert.equal(one(fx, "SELECT ended_by_decision FROM suspensions WHERE decision_id = ?", s.id).ended_by_decision !== null, true);
  assert.equal(one(fx, "SELECT state FROM submissions WHERE submission_id = ?", r.submission_id).state, "in-review");
  assert.equal(one(fx, "SELECT state FROM claims WHERE task_id = 't2'").state, "released", "claims released by the suspension are not restored");
  // A second suspension, reinstated by D2, then the reinstate reversed: the decision suspension re-opens with P3 effects.
  const s2 = createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: A, at: T0 + 2 * HOUR }), T0 + 2 * HOUR);
  const at = T0 + 3 * HOUR;
  const re = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "reinstate", subject: A, sponsor: "seat-1", at }), at);
  for (const seat of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, re.id, "approve", at), at);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, re.id), at), at);
  settleAll(fx.db, at + DAY);
  assert.equal(one(fx, "SELECT status FROM members WHERE member_id = ?", A).status, "active");
  laneD0(fx, "task.open", "t3", taskArgs(["docs"]), "seat-1", at + DAY);
  claim(fx, A, "t3", at + DAY);
  const v = veto(fx, re.id, at + DAY + HOUR);
  assert.equal(one(fx, "SELECT status FROM members WHERE member_id = ?", A).status, "suspended");
  assert.deepEqual({ ...one(fx, "SELECT reason, decision_id FROM suspensions WHERE member_id = ? AND ended_at IS NULL", A) }, { reason: "decision", decision_id: v.id });
  assert.equal(one(fx, "SELECT state FROM claims WHERE task_id = 't3'").state, "released");
  assert.ok(s2.id);
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("reversed enroll.confirm revokes the member and its key for ever; reversed rekey or rebind revokes the bound key and suspends", () => {
  const fx = setup({ members: ["A", "B"] });
  const A = promoteC1(fx, "A");
  laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
  claim(fx, A, "t1", T0);
  veto(fx, "fx-enroll-A", T0 + HOUR);
  assert.equal(one(fx, "SELECT status FROM members WHERE member_id = ?", A).status, "revoked");
  assert.equal(one(fx, "SELECT status FROM keys WHERE principal_id = ?", A).status, "revoked");
  assert.equal(one(fx, "SELECT status FROM tasks WHERE task_id = 't1'").status, "open");
  // B: a re-key, then a re-bind; reversing the re-bind revokes its key and opens a decision suspension; the count stays.
  const B = fx.members.B.id;
  const ik = createInvite(fx, { kind: "rekey", member_id: B, at: T0 + MIN });
  const rk = applyEnrollmentRequest(fx, { invite: ik, name: "B", at: T0 + MIN });
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", rk.outbox, T0 + MIN), T0 + MIN);
  createDecision(fx.db, decision(fx, "seat-2", { cls: "D0", action: "rekey.confirm", subject: rk.enrollment, args: { owner_line_ref: rk.outbox.id }, at: T0 + MIN }), T0 + MIN);
  const rb = seedRebind(fx, "B", { at: T0 + 2 * MIN });
  const d1r = createDecision(fx.db, decision(fx, "seat-2", { cls: "D1R", action: "rebind.confirm", subject: rb.enrollment, at: T0 + 2 * MIN }), T0 + 2 * MIN);
  addVerdict(fx.db, approval(fx, "seat-4", d1r.id, "approve", T0 + 2 * MIN), T0 + 2 * MIN);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-5", outboxFor(fx.db, d1r.id), T0 + 2 * MIN), T0 + 2 * MIN);
  assert.equal(stateOf(fx, d1r.id), "effective");
  assert.equal(one(fx, "SELECT status FROM keys WHERE public_key = ?", rb.identity.publicKeyHex).status, "active");
  const v = veto(fx, d1r.id, T0 + HOUR);
  assert.equal(one(fx, "SELECT status FROM keys WHERE public_key = ?", rb.identity.publicKeyHex).status, "revoked");
  assert.equal(one(fx, "SELECT status FROM keys WHERE public_key = ?", rk.identity.publicKeyHex).status, "revoked", "older keys stay revoked");
  assert.deepEqual({ ...one(fx, "SELECT status FROM members WHERE member_id = ?", B) }, { status: "suspended" });
  assert.equal(one(fx, "SELECT decision_id FROM suspensions WHERE member_id = ? AND ended_at IS NULL", B).decision_id, v.id);
  assert.equal(rebindCount(fx.db, B), 1, "the re-bind count is historical");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("reversed task.assign, invite.create and other D0s; owner records and pending non-D2 decisions cannot be vetoed; veto works while frozen", () => {
  const fx = setup({ members: ["A", "B"] });
  const A = promoteC1(fx, "A"), B = promoteC1(fx, "B");
  for (const t of ["t1", "t2"]) laneD0(fx, "task.open", t, taskArgs(["docs"]));
  const live = laneD0(fx, "task.assign", "t1", { member_id: A });
  const done = laneD0(fx, "task.assign", "t2", { member_id: B });
  const bc = one(fx, "SELECT claim_id FROM claims WHERE task_id = 't2'").claim_id;
  handleMemberRecord(fx.db, B, { type: "result", record_id: "rb", body: { claim_id: bc, epoch: 1, kind: "report", body: "done" } }, T0);
  veto(fx, live.id, T0 + MIN);
  assert.deepEqual({ ...one(fx, "SELECT state, released_reason FROM claims WHERE task_id = 't1'") }, { state: "released", released_reason: "reversal" });
  assert.deepEqual({ ...one(fx, "SELECT status, attempts FROM tasks WHERE task_id = 't1'") }, { status: "open", attempts: 0 });
  veto(fx, done.id, T0 + MIN);
  assert.deepEqual(effects(fx, done.id), ["record-only"], "a submitted claim is left alone");
  // invite.create: an unspent invite is voided; a spent one is record-only.
  const unspent = createInvite(fx, { at: T0 + MIN });
  const spent = createInvite(fx, { at: T0 + MIN });
  applyEnrollmentRequest(fx, { invite: spent, name: "S", at: T0 + MIN });
  const decisionOf = (inv) => one(fx, "SELECT decision_id FROM invite_details WHERE invite_id = ?", inv.invite_id).decision_id;
  veto(fx, decisionOf(unspent), T0 + 2 * MIN);
  veto(fx, decisionOf(spent), T0 + 2 * MIN);
  assert.notEqual(one(fx, "SELECT voided_at FROM invites WHERE invite_id = ?", unspent.invite_id).voided_at, null);
  assert.equal(one(fx, "SELECT voided_at FROM invites WHERE invite_id = ?", spent.invite_id).voided_at, null);
  // Other D0: record-only plus an alert.
  const open = one(fx, "SELECT id FROM decisions WHERE action = 'task.open' AND subject = 't1'").id;
  veto(fx, open, T0 + 2 * MIN);
  assert.equal(one(fx, "SELECT count(*) n FROM alerts WHERE kind = 'reversal.record-only'").n, 1);
  // Owner records are not reversible; a pending non-D2 decision cannot be vetoed.
  const freeze = createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "freeze", subject: "relay", at: T0 + 3 * MIN }), T0 + 3 * MIN);
  rejects(() => veto(fx, freeze.id, T0 + 3 * MIN), "owner records are not reversible");
  // While frozen, the owner's veto still reverses.
  const tasks = one(fx, "SELECT id FROM decisions WHERE action = 'task.open' AND subject = 't2'").id;
  assert.equal(veto(fx, tasks, T0 + 4 * MIN).state, "effective");
  assert.equal(stateOf(fx, tasks), "reversed");
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "unfreeze", subject: "relay", at: T0 + 5 * MIN }), T0 + 5 * MIN);
  laneD0(fx, "task.open", "t3", taskArgs(["docs"]), "seat-1", T0 + 5 * MIN);
  const c = claim(fx, A, "t3", T0 + 5 * MIN);
  handleMemberRecord(fx.db, A, { type: "result", record_id: "ra", body: { claim_id: c.claim_id, epoch: 1, kind: "report", body: "x" } }, T0 + 5 * MIN);
  const pendingD1 = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: one(fx, "SELECT submission_id FROM submission_details WHERE task_id = 't3'").submission_id, at: T0 + 5 * MIN }), T0 + 5 * MIN);
  assert.equal(pendingD1.state, "pending");
  rejects(() => veto(fx, pendingD1.id, T0 + 5 * MIN), "veto needs a pending D2 or an effective decision");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});
