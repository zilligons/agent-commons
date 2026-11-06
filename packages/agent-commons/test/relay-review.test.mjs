// L0 governance completion: task.assign, progress.accept, the review outcomes
// "changes" and "reject" (11.2, R7), and security findings and C2 (section 10).
// Scratch databases, fixture keys.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMemberRecord, ownClaims } from "../src/relay/board.mjs";
import { readInbox } from "../src/relay/mailbox.mjs";
import { settleAll, quorum, roleOf, hasOpenFinding } from "../src/relay/governance.mjs";
import { exportRelay, verifyExport } from "../src/relay/signing.mjs";
import { setup, decision, approval, verifyResult, coauthor, ownerConfirm, findingOpen, findingClose, taskArgs, PATCH, outboxFor, rejects,
  laneD0, promoteC1, eligibleForC2, T0, HOUR, DAY, createDecision, addVerdict, recordVerifyResult, declareCoauthor, confirmOwnerRecord, openFinding, closeFinding } from "./relay-fixtures.mjs";

const stateOf = (fx, id) => fx.db.prepare("SELECT state FROM decisions WHERE id = ?").get(id).state;
const task = (fx, id) => ({ ...fx.db.prepare("SELECT status, attempts FROM tasks WHERE task_id = ?").get(id) });
const D0 = laneD0, c1 = promoteC1;
/** A member at C1 with an in-review patch submission on task-1. */
function inReview(fx, name = "A") {
  const id = c1(fx, name);
  D0(fx, "task.open", "task-1", taskArgs(["docs"]));
  const c = handleMemberRecord(fx.db, id, { type: "claim", record_id: "c1", body: { task_id: "task-1", lease_ms: 2 * HOUR } }, T0);
  const r = handleMemberRecord(fx.db, id, { type: "result", record_id: "r1", body: { claim_id: c.claim_id, epoch: c.epoch, kind: "patch", body: PATCH() } }, T0);
  return { id, claim: c, result: r };
}

test("task.assign: the lane owner assigns an open task; the member is told and holds a normal live claim", () => {
  const fx = setup({ members: ["A", "B"] });
  const A = c1(fx, "A");
  D0(fx, "task.open", "t1", taskArgs(["docs"]));
  rejects(() => D0(fx, "task.assign", "t1", { member_id: A }, "seat-2"), "not the lane owner");
  rejects(() => D0(fx, "task.assign", "t1", { member_id: fx.members.B.id }), "assignee must be an active C1+");
  rejects(() => D0(fx, "task.assign", "t1", { member_id: A, extra: 1 }), "unknown-field");
  assert.equal(D0(fx, "task.assign", "t1", { member_id: A, lease_ms: HOUR }).state, "effective");
  const [claim] = ownClaims(fx.db, A, T0);
  assert.deepEqual({ task: claim.task_id, epoch: claim.epoch, lease: claim.lease_until }, { task: "t1", epoch: 1, lease: T0 + HOUR });
  assert.deepEqual(task(fx, "t1"), { status: "claimed", attempts: 0 });
  const notice = readInbox(fx.db, A, {}, T0).records.find(r => r.type === "claim.assigned");
  assert.equal(notice.body.claim_id, claim.claim_id);
  assert.equal(notice.sender, "relay");
  // The assigned claim is fenced like any claim, and the C1 cap holds.
  handleMemberRecord(fx.db, A, { type: "progress", record_id: "p", body: { claim_id: claim.claim_id, epoch: 1, text: "started" } }, T0);
  D0(fx, "task.open", "t2", taskArgs(["docs"]));
  rejects(() => D0(fx, "task.assign", "t2", { member_id: A }), "claim-cap");
  rejects(() => D0(fx, "task.assign", "t1", { member_id: A }), "task not open");
});

test("progress.accept: one accepted progress record, recorded once, and the member is told", () => {
  const fx = setup({ members: ["A"] });
  const A = c1(fx, "A");
  D0(fx, "task.open", "t1", taskArgs(["docs"]));
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
  handleMemberRecord(fx.db, A, { type: "progress", record_id: "p1", body: { claim_id: c.claim_id, epoch: 1, text: "half" } }, T0);
  rejects(() => D0(fx, "progress.accept", c.claim_id, { record_id: "nope" }), "no such progress record");
  const d = D0(fx, "progress.accept", c.claim_id, { record_id: "p1" });
  assert.equal(d.state, "effective");
  assert.equal(fx.db.prepare("SELECT decision_id FROM progress_acceptances WHERE member_id = ? AND record_id = 'p1'").get(A).decision_id, d.id);
  rejects(() => D0(fx, "progress.accept", c.claim_id, { record_id: "p1" }), "already accepted");
  assert.ok(readInbox(fx.db, A, {}, T0).records.some(r => r.type === "progress.accepted" && r.body.record_id === "p1"));
  rejects(() => fx.db.prepare("DELETE FROM progress_acceptances").run(), "progress-acceptance-fixed");
});

test("review.changes (R7): the submission goes to changes and the claimant gets a NEW claim, epoch+1; the old claim stays closed", () => {
  const fx = setup({ members: ["A"] });
  const { id: A, claim, result } = inReview(fx);
  const d = D0(fx, "review.changes", result.submission_id, {});
  assert.equal(d.state, "effective");
  assert.equal(fx.db.prepare("SELECT state FROM submissions WHERE submission_id = ?").get(result.submission_id).state, "changes");
  const [fresh] = ownClaims(fx.db, A, T0);
  assert.notEqual(fresh.claim_id, claim.claim_id);
  assert.deepEqual({ epoch: fresh.epoch, lease: fresh.lease_until }, { epoch: 2, lease: T0 + 2 * HOUR }, "same lease length as the submitted claim");
  assert.equal(task(fx, "task-1").status, "claimed");
  rejects(() => handleMemberRecord(fx.db, A, { type: "progress", record_id: "old", body: { claim_id: claim.claim_id, epoch: 1, text: "x" } }, T0), "CLAIM_CLOSED");
  assert.equal(readInbox(fx.db, A, {}, T0).records.find(r => r.type === "claim.reissued").body.claim_id, fresh.claim_id);
  // The new round can be submitted and accepted; the "changes" submission cannot.
  const r2 = handleMemberRecord(fx.db, A, { type: "result", record_id: "r2", body: { claim_id: fresh.claim_id, epoch: 2, kind: "patch", body: PATCH("docs/relay2.md") } }, T0);
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: result.submission_id }), T0), "submission not in review");
  const accept = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r2.submission_id }), T0);
  addVerdict(fx.db, approval(fx, "seat-2", accept.id), T0);
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: r2.submission_id, patch_sha256: r2.body_sha256 }), T0);
  assert.equal(stateOf(fx, accept.id), "effective");
});

test("review.reject: reopen counts an attempt, close closes, three attempts go to triage; a co-author never decides", () => {
  const fx = setup({ members: ["A"] });
  const { id: A, result } = inReview(fx);
  rejects(() => D0(fx, "review.reject", result.submission_id, { disposition: "maybe" }), "invalid-field");
  D0(fx, "review.reject", result.submission_id, { disposition: "reopen" });
  assert.equal(fx.db.prepare("SELECT state FROM submissions WHERE submission_id = ?").get(result.submission_id).state, "rejected");
  assert.deepEqual(task(fx, "task-1"), { status: "open", attempts: 1 });
  rejects(() => fx.db.prepare("UPDATE submissions SET state = 'in-review' WHERE submission_id = ?").run(result.submission_id), "submission-final");
  for (let i = 2; i <= 3; i++) {
    const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: `c${i}`, body: { task_id: "task-1", lease_ms: HOUR } }, T0);
    const r = handleMemberRecord(fx.db, A, { type: "result", record_id: `r${i}`, body: { claim_id: c.claim_id, epoch: c.epoch, kind: "report", body: "again" } }, T0);
    if (i === 3) declareCoauthor(fx.db, coauthor(fx, "seat-1", r.submission_id), T0);
    if (i === 3) { rejects(() => D0(fx, "review.reject", r.submission_id, { disposition: "reopen" }), "author-cannot-approve"); fx.db.prepare("UPDATE lanes SET owner_seat = 'seat-2'").run(); }
    D0(fx, "review.reject", r.submission_id, { disposition: "reopen" }, i === 3 ? "seat-2" : "seat-1");
  }
  assert.deepEqual(task(fx, "task-1"), { status: "needs-triage", attempts: 3 });
  // Close: a fresh task is closed by one reject.
  fx.db.prepare("UPDATE lanes SET owner_seat = 'seat-1'").run();
  D0(fx, "task.open", "t9", taskArgs(["docs"]));
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c9", body: { task_id: "t9", lease_ms: HOUR } }, T0);
  const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r9", body: { claim_id: c.claim_id, epoch: c.epoch, kind: "report", body: "no" } }, T0);
  D0(fx, "review.reject", r.submission_id, { disposition: "close" });
  assert.deepEqual(task(fx, "t9"), { status: "closed", attempts: 1 });
  assert.ok(readInbox(fx.db, A, {}, T0).records.some(x => x.type === "submission.rejected" && x.body.task_status === "closed"));
});

test("section 10: an open security finding blocks C2 at proposal and at effect time; closing it lets the D2 take effect", () => {
  const fx = setup({ members: ["A"] });
  const A = c1(fx, "A");
  eligibleForC2(fx, "A");
  const now = T0 + 3 * DAY;
  rejects(() => openFinding(fx.db, findingOpen(fx, { member_id: A, by: "seat-1", at: now }), now), "forbidden");
  const f1 = openFinding(fx.db, findingOpen(fx, { member_id: A, at: now }), now);
  assert.equal(hasOpenFinding(fx.db, A), true);
  rejects(() => createDecision(fx.db, decision(fx, "seat-2", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-2", args: { role: "C2" }, at: now }), now), "finding-open");
  closeFinding(fx.db, findingClose(fx, { finding_id: f1.id, at: now }), now);
  rejects(() => closeFinding(fx.db, findingClose(fx, { finding_id: f1.id, at: now }), now), "finding-already-closed");
  const d2 = createDecision(fx.db, decision(fx, "seat-2", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-2", args: { role: "C2" }, at: now }), now);
  for (const seat of ["seat-1", "seat-3", "seat-4"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-5", outboxFor(fx.db, d2.id), now), now);
  // A finding opened inside the window holds the promotion past its 24 h.
  const f2 = openFinding(fx.db, findingOpen(fx, { member_id: A, at: now + HOUR }), now + HOUR);
  settleAll(fx.db, now + 2 * DAY);
  assert.equal(stateOf(fx, d2.id), "pending");
  assert.equal(roleOf(fx.db, A), "C1");
  closeFinding(fx.db, findingClose(fx, { finding_id: f2.id, at: now + 2 * DAY }), now + 2 * DAY);
  assert.equal(stateOf(fx, d2.id), "effective", "closing the finding re-evaluates the pending D2");
  assert.equal(roleOf(fx.db, A), "C2");
  const roster = fx.files.roster.body.principals;   // the owner-signed roster the verifier trusts, never the relay's copy
  assert.deepEqual(verifyExport(exportRelay(fx.db), roster), { ok: true, problems: [] }, "finding records verify offline");
  rejects(() => fx.db.prepare("UPDATE security_findings SET closed_at = NULL, closed_by = NULL, close_sig = NULL WHERE id = ?").run(f1.id), "finding-fixed");
});

test("effect-time recheck: a D2 whose precondition moved on lapses instead of acting on stale state", () => {
  const fx = setup({ members: ["A"] });
  const A = c1(fx, "A");
  eligibleForC2(fx, "A");
  const now = T0 + 3 * DAY;
  const make = (sponsor) => createDecision(fx.db, decision(fx, sponsor, { cls: "D2", action: "role.change", subject: A, sponsor, args: { role: "C2" }, at: now }), now);
  const first = make("seat-2"), second = make("seat-3");
  for (const d of [first, second]) {
    for (const seat of ["seat-1", "seat-4", "seat-5", "seat-6"].filter(s => s !== d.sponsor)) addVerdict(fx.db, approval(fx, seat, d.id, "approve", now), now);
    confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-7", outboxFor(fx.db, d.id), now), now);
  }
  settleAll(fx.db, now + DAY);
  assert.deepEqual([stateOf(fx, first.id), stateOf(fx, second.id)], ["effective", "lapsed"]);
  assert.equal(fx.db.prepare("SELECT count(*) n FROM roles WHERE member_id = ?").get(A).n, 3, "C0, C1, then exactly one C2");
});

// Addendum A3's measured-label credit is superseded by C5 (spec 9.8); see relay-evidence.test.mjs.

// --- the verifier's low notes on 32e7cf4, as spec v3.3 settles them (9.2, 9.3, 15) -----

test("N3: any AC seat may propose a D1; the lane owner's approve is still required", () => {
  const fx = setup({ members: ["A"] });
  const { result } = inReview(fx);
  const d = createDecision(fx.db, decision(fx, "seat-4", { cls: "D1", action: "accept", subject: result.submission_id }), T0);
  assert.equal(d.state, "pending");
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256 }), T0);
  addVerdict(fx.db, approval(fx, "seat-2", d.id), T0);
  assert.equal(stateOf(fx, d.id), "pending", "two families and a verification, but no lane-owner approve");
  assert.equal(addVerdict(fx.db, approval(fx, "seat-1", d.id), T0).state, "effective");
  rejects(() => createDecision(fx.db, decision(fx, "seat-4", { cls: "D0", action: "task.open", subject: "t-x", args: taskArgs(["docs"]) }), T0), "not the lane owner");
});

test("N4 and N5: object is refused on D0 and D1; a second verify.result from one verifier is a relay error", () => {
  const fx = setup({ members: ["A"] });
  const { result } = inReview(fx);
  const open = fx.db.prepare("SELECT id FROM decisions WHERE action = 'task.open'").get().id;
  rejects(() => addVerdict(fx.db, approval(fx, "seat-2", open, "object"), T0), "decision-closed");
  laneD0(fx, "task.open", "t2", taskArgs(["docs"]));
  const pendingD1 = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: result.submission_id }), T0);
  rejects(() => addVerdict(fx.db, approval(fx, "seat-3", pendingD1.id, "object"), T0), "object-d2-only");
  const signed = verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256 });
  recordVerifyResult(fx.db, signed, T0);
  const again = rejects(() => recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256, at: T0 + 1 }), T0 + 1), "duplicate-verify-result");
  assert.equal(again.name, "RelayError");
  assert.equal(again.status, 409);
});
