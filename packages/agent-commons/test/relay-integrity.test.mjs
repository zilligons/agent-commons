// The verifier's L0 review of 32e7cf4, findings B1 and B2 (decision integrity), as regressions.
// B1: a verdict's position is part of what the seat signs (seq + prev), so a captured
//     verdict can never be appended again. B2: the offline export verifier binds every
//     acted-on column to its signed field and every derived row to its decision.
// Scratch databases and fixture keys; provider requests disabled.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { openRelayDb } from "../src/relay/schema.mjs";
import { loadRoster } from "../src/relay/roster.mjs";
import { quorum, settleAll, APPROVAL_V } from "../src/relay/governance.mjs";
import { exportRelay, verifyExport, signBody, verdictPrev } from "../src/relay/signing.mjs";
import { setup, scratch, seedRebind, decision, approval, verdictPosition, verifyResult, coauthor, ownerConfirm, findingOpen, findingClose,
  outboxFor, taskArgs, PATCH, laneD0, promoteC1, rejects, servedBy, T0, MIN, HOUR, DAY, createDecision, addVerdict, fixtureFiles, recordVerifyResult, declareCoauthor, confirmOwnerRecord, openFinding, closeFinding } from "./relay-fixtures.mjs";

const stateOf = (db, id) => db.prepare("SELECT state FROM decisions WHERE id = ?").get(id).state;
const rowsOf = (db, decisionId, by) => db.prepare("SELECT seq, verdict FROM approvals WHERE decision_id = ? AND approver = ? ORDER BY seq").all(decisionId, by).map(r => `${r.seq}:${r.verdict}`);
const D2 = (fx, subject, role, sponsor = "seat-2", at = T0 + MIN) =>
  createDecision(fx.db, decision(fx, sponsor, { cls: "D2", action: "role.change", subject, sponsor, args: { role }, at }), at);

// --- B1 ----------------------------------------------------------------------

test("B1 (verifier H1): approve, withdraw, then the captured approval replayed is refused; the D2 never takes effect on it", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  const now = T0 + MIN;
  const d2 = D2(fx, A, "C0");
  for (const seat of ["seat-3", "seat-4"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
  const captured = approval(fx, "seat-5", d2.id, "approve", now);
  addVerdict(fx.db, captured, now);
  addVerdict(fx.db, approval(fx, "seat-5", d2.id, "withdraw", now + 1), now + 1);
  rejects(() => addVerdict(fx.db, captured, now + 2), "approval-seq");
  assert.deepEqual(rowsOf(fx.db, d2.id, "seat-5"), ["1:approve", "2:withdraw"]);
  assert.deepEqual(quorum(fx.db, d2.id).approvals.sort(), ["seat-3", "seat-4"]);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, d2.id), now + 3), now + 3);
  settleAll(fx.db, now + 3 + DAY);
  assert.equal(stateOf(fx.db, d2.id), "pending", "two approvals after the withdrawal: no quorum");
  // Only the seat itself can take a new position: a fresh approval signed at seq 3 counts.
  addVerdict(fx.db, approval(fx, "seat-5", d2.id, "approve", now + 3 + DAY), now + 3 + DAY);
  assert.deepEqual(rowsOf(fx.db, d2.id, "seat-5"), ["1:approve", "2:withdraw", "3:approve"]);
  assert.equal(stateOf(fx.db, d2.id), "effective");
});

test("B1 (verifier H1b): a withdrawn objection replayed is refused; it cannot re-block the D2", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  const now = T0 + MIN;
  const d2 = D2(fx, A, "C0");
  for (const seat of ["seat-3", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
  const objection = approval(fx, "seat-6", d2.id, "object", now);
  addVerdict(fx.db, objection, now);
  addVerdict(fx.db, approval(fx, "seat-6", d2.id, "withdraw", now + 1), now + 1);
  rejects(() => addVerdict(fx.db, objection, now + 2), "approval-seq");
  assert.deepEqual(quorum(fx.db, d2.id).objections, []);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-7", outboxFor(fx.db, d2.id), now + 2), now + 2);
  settleAll(fx.db, now + 2 + DAY);
  assert.equal(stateOf(fx.db, d2.id), "effective");
});

test("B1 (C1): a replayed reject after withdraw is refused; the reject cannot re-block the D1", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
  const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: 1, kind: "report", body: "done" } }, T0);
  const accept = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id }), T0);
  const rejection = approval(fx, "seat-3", accept.id, "reject", T0);
  addVerdict(fx.db, rejection, T0);
  addVerdict(fx.db, approval(fx, "seat-3", accept.id, "withdraw", T0 + 1), T0 + 1);
  rejects(() => addVerdict(fx.db, rejection, T0 + 2), "approval-seq");
  assert.deepEqual(quorum(fx.db, accept.id).rejections, []);
  assert.equal(addVerdict(fx.db, approval(fx, "seat-2", accept.id, "approve", T0 + 3), T0 + 3).state, "effective");
});

test("B1: the signed position must be the signer's next one and name its previous verdict; a creator's seq 1 is its decision", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
  const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: 1, kind: "report", body: "done" } }, T0);
  const accept = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id }), T0);
  const signedAt = (by, verdict, position) => approval(fx, by, accept.id, verdict, T0, servedBy(by), position);
  // The creator (lane owner) already holds seq 1: its decision record.
  assert.deepEqual(verdictPosition(fx.db, accept.id, "seat-1"), { seq: 2, prev: verdictPrev(fx.db.prepare("SELECT body FROM decisions WHERE id = ?").get(accept.id).body) });
  rejects(() => addVerdict(fx.db, signedAt("seat-1", "reject", { seq: 1, prev: null }), T0), "approval-seq");
  rejects(() => addVerdict(fx.db, signedAt("seat-1", "reject", { seq: 2, prev: null }), T0), "prev does not name the previous verdict");
  rejects(() => addVerdict(fx.db, signedAt("seat-1", "reject", { seq: 2, prev: "0".repeat(64) }), T0), "prev does not name the previous verdict");
  // Another seat starts at seq 1 with prev null; a skipped or reused position is refused.
  rejects(() => addVerdict(fx.db, signedAt("seat-2", "approve", { seq: 2, prev: null }), T0), "approval-seq");
  rejects(() => addVerdict(fx.db, signedAt("seat-2", "approve", { seq: 1, prev: "a".repeat(64) }), T0), "prev does not name the previous verdict");
  // N4: object is a D2 verdict only; on a D1 it is refused, not silently ignored.
  rejects(() => addVerdict(fx.db, signedAt("seat-2", "object", { seq: 1, prev: null }), T0), "object-d2-only");
  const first = signedAt("seat-2", "reject", { seq: 1, prev: null });
  addVerdict(fx.db, first, T0);
  rejects(() => addVerdict(fx.db, first, T0), "approval-seq");
  rejects(() => addVerdict(fx.db, signedAt("seat-2", "approve", { seq: 2, prev: verdictPrev(JSON.stringify(first.body)) }), T0), "prev does not name the previous verdict");
  addVerdict(fx.db, signedAt("seat-2", "approve", verdictPosition(fx.db, accept.id, "seat-2")), T0);
  // A position-less (version 1) verdict and malformed positions are refused.
  // (A non-integer seq cannot even be signed: canonical bytes refuse it, section 6.1 B4.)
  for (const patch of [{ seq: undefined }, { seq: 0 }, { seq: -1 }, { prev: undefined }, { prev: "AB" }]) {
    const body = Object.fromEntries(Object.entries({ ...approval(fx, "seat-3", accept.id).body, ...patch }).filter(([, v]) => v !== undefined));
    rejects(() => addVerdict(fx.db, { body, sig: signBody(fx.keys["seat-3"], body) }, T0), "invalid-field");
  }
  const v1 = { v: "commons-relay-approval/1", decision_id: accept.id, verdict: "approve", by: "seat-3", served_by: servedBy("seat-3"), at: T0 };
  rejects(() => addVerdict(fx.db, { body: v1, sig: signBody(fx.keys["seat-3"], v1) }, T0), "invalid-record");
  assert.equal(APPROVAL_V, "commons-relay-approval/2");
});

test("B1: a captured verdict stays refused on a new connection and at any later time (no request-level freshness revives it)", () => {
  const { path } = scratch();
  const fx = setup({ path, members: ["A"] });
  const A = promoteC1(fx, "A");
  const d2 = D2(fx, A, "C0");
  const captured = approval(fx, "seat-3", d2.id, "approve", T0 + MIN);
  addVerdict(fx.db, captured, T0 + MIN);
  addVerdict(fx.db, approval(fx, "seat-3", d2.id, "withdraw", T0 + 2 * MIN), T0 + 2 * MIN);
  fx.db.close();
  const other = openRelayDb(path);   // a separate connection: the L1 stand-in for a fresh, freshly authenticated request
  for (const at of [T0 + 3 * MIN, T0 + 30 * DAY]) rejects(() => addVerdict(other, captured, at), "approval-seq");
  assert.deepEqual(rowsOf(other, d2.id, "seat-3"), ["1:approve", "2:withdraw"]);
  other.close();
});

// --- B2 ----------------------------------------------------------------------

/** A ledger that exercises every exported relationship. */
function ledger() {
  const fx = setup({ members: ["A", "B", "C"] });
  const A = promoteC1(fx, "A"), B = promoteC1(fx, "B"), C = promoteC1(fx, "C");
  laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
  const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: 1, kind: "patch", body: PATCH() } }, T0);
  // A second patch whose verification fails (exit code 1): passed = 0 is load-bearing (v3.3.1 N36).
  laneD0(fx, "task.open", "t2", taskArgs(["docs"]));
  const c2 = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c2", body: { task_id: "t2", lease_ms: HOUR } }, T0);
  const r2 = handleMemberRecord(fx.db, A, { type: "result", record_id: "r2", body: { claim_id: c2.claim_id, epoch: 1, kind: "patch", body: PATCH("docs/other.md") } }, T0);
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: r2.submission_id, patch_sha256: r2.body_sha256, exit_codes: [0, 1] }), T0);
  declareCoauthor(fx.db, coauthor(fx, "verifier", r.submission_id), T0);
  const accept = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id }), T0);
  addVerdict(fx.db, approval(fx, "seat-2", accept.id), T0);
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: r.submission_id, patch_sha256: r.body_sha256 }), T0);
  const now = T0 + MIN;
  const d2 = D2(fx, B, "C0");
  addVerdict(fx.db, approval(fx, "seat-3", d2.id, "approve", now), now);
  addVerdict(fx.db, approval(fx, "seat-4", d2.id, "object", now), now);
  addVerdict(fx.db, approval(fx, "seat-4", d2.id, "withdraw", now), now);
  for (const seat of ["seat-5", "seat-6"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-7", outboxFor(fx.db, d2.id), now), now);
  const later = now + DAY;
  settleAll(fx.db, later);
  const suspend = createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: A, at: later }), later);
  const f = openFinding(fx.db, findingOpen(fx, { member_id: B, at: later }), later);
  closeFinding(fx.db, findingClose(fx, { finding_id: f.id, at: later }), later);
  const rb = seedRebind(fx, "B", { at: later });
  const d1r = createDecision(fx.db, decision(fx, "seat-2", { cls: "D1R", action: "rebind.confirm", subject: rb.enrollment, at: later }), later);
  addVerdict(fx.db, approval(fx, "seat-4", d1r.id, "approve", later), later);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-5", outboxFor(fx.db, d1r.id), later), later);
  const rb2 = seedRebind(fx, "B", { at: later + 1 });
  const pendingD1R = createDecision(fx.db, decision(fx, "seat-2", { cls: "D1R", action: "rebind.confirm", subject: rb2.enrollment, at: later + 1 }), later + 1);
  // C3: the owner reverses C's role.c1; C's role is re-projected (a C0 row citing the veto).
  const c1 = fx.db.prepare("SELECT decision_id FROM roles WHERE member_id = ? AND role = 'C1'").get(C).decision_id;
  const veto = createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "veto", subject: c1, at: later + 2 }), later + 2);
  return { fx, A, B, C, c1, veto, accept, d2, suspend, f, d1r, pendingD1R, submission: r.submission_id, failed: r2.submission_id, roster: fx.files.roster.body.principals };
}

test("B2: a complete export verifies against the owner-signed roster, and every bound table is present", () => {
  const L = ledger();
  assert.deepEqual([stateOf(L.fx.db, L.accept.id), stateOf(L.fx.db, L.d2.id), stateOf(L.fx.db, L.d1r.id), stateOf(L.fx.db, L.pendingD1R.id)],
    ["effective", "effective", "effective", "pending"]);
  const exp = exportRelay(L.fx.db);
  assert.deepEqual(verifyExport(exp, L.roster), { ok: true, problems: [] });
  const implicit = exp.approvals.filter(a => JSON.parse(a.body).v !== APPROVAL_V);
  assert.ok(implicit.length >= 4, "implicit creator approvals are in the export");
  for (const table of ["verify_results", "coauthors", "owner_record_confirmations", "security_findings", "roles", "suspensions", "enrollments", "contributions"])
    assert.ok(exp[table].length > 0, `${table} is exercised`);
  assert.ok(exp.suspensions.some(s => s.reason === "rebind" && s.ended_by_decision === L.d1r.id));
  assert.ok(exp.served_by_attestations.length >= 4, "measurer attestations are in the export");
  assert.deepEqual(exp.roles.filter(r => r.member_id === L.C).map(r => r.role), ["C0", "C1", "C0"], "a veto re-projection row");
  assert.equal(exp.decisions.find(d => d.id === L.c1).state, "reversed");
  // A record signed before its key was revoked still verifies: the verifier uses the key's window, not its status.
  const seat7 = L.roster.filter(p => p.principal_id !== "seat-7");
  loadRoster(L.fx.db, fixtureFiles(L.fx.keys, { rosterVersion: 2, principals: seat7 }).roster, { ownerPublicKey: L.fx.keys.owner.publicKeyHex, now: T0 + 30 * DAY });
  const after = exportRelay(L.fx.db);
  assert.equal(after.keys.find(k => k.principal_id === "seat-7").status, "revoked");
  assert.ok(after.owner_record_confirmations.some(c => c.confirmed_by === "seat-7"), "seat-7 signed before it was retired");
  assert.deepEqual(verifyExport(after, L.roster), { ok: true, problems: [] });
});

test("B2 (verifier H2 and siblings): each acted-on column, relationship and dropped row is caught; the untouched export still verifies", () => {
  const L = ledger();
  const clean = exportRelay(L.fx.db);
  const decisionRow = (exp, id) => exp.decisions.find(d => d.id === id);
  const verdictRow = (exp, id, by, seq) => exp.approvals.find(a => a.decision_id === id && a.approver === by && a.seq === seq);
  const cases = [
    ["a verdict changed (object -> approve)", e => { verdictRow(e, L.d2.id, "seat-4", 1).verdict = "approve"; }, ["approval", "column-mismatch", "verdict"]],
    ["a decision's action and subject changed", e => { const d = decisionRow(e, L.d2.id); d.action = "reinstate"; d.subject = "someone-else"; }, ["decision", "column-mismatch", "action"]],
    ["the subject alone changed", e => { decisionRow(e, L.d2.id).subject = L.A; }, ["decision", "column-mismatch", "subject"]],
    ["a verdict moved to another decision", e => { verdictRow(e, L.d2.id, "seat-3", 1).decision_id = L.d1r.id; }, ["approval", "column-mismatch", "decision_id"]],
    ["a verdict moved to a decision not in the export", e => { verdictRow(e, L.d2.id, "seat-3", 1).decision_id = "fx-missing"; }, ["approval", "unknown-decision"]],
    ["a decision's class changed", e => { decisionRow(e, L.d2.id).class = "D0"; }, ["decision", "column-mismatch", "class"]],
    ["a D2 sponsor removed", e => { decisionRow(e, L.d2.id).sponsor = null; }, ["decision", "column-mismatch", "sponsor"]],
    ["a verdict relabelled as measured", e => { verdictRow(e, L.d2.id, "seat-5", 1).served_by = "measured:qwen:x"; }, ["approval", "column-mismatch", "served_by"]],
    ["an approver's family swapped", e => { verdictRow(e, L.d2.id, "seat-3", 1).approver_family = "google"; }, ["approval", "column-mismatch", "approver_kind/approver_family"]],
    ["verdict positions swapped", e => { verdictRow(e, L.d2.id, "seat-4", 2).seq = 9; }, ["approval", "column-mismatch", "seq"]],
    ["a withdrawal dropped from the export", e => { e.approvals = e.approvals.filter(a => !(a.decision_id === L.d2.id && a.approver === "seat-4" && a.seq === 2)); }, ["approval", "row-missing"]],
    ["a captured verdict appended again (identical signature)", e => { e.approvals.push({ ...verdictRow(e, L.d2.id, "seat-4", 1), seq: 3 }); }, ["approval", "column-mismatch", "seq"]],
    ["an implicit approval claimed for a non-creator", e => { e.approvals.push({ ...verdictRow(e, L.accept.id, "seat-1", 1), approver: "seat-3", approver_family: "anthropic" }); }, ["approval", "implicit-approval-mismatch"]],
    ["an implicit approval claimed on a D2", e => { const d = decisionRow(e, L.d2.id); e.approvals.push({ ...verdictRow(e, L.accept.id, "seat-1", 1), decision_id: d.id, approver: "seat-2", approver_family: "openai", body: d.body, sig: d.sig, served_by: d.served_by }); }, ["approval", "implicit-approval-mismatch"]],
    ["a creator's implicit approval removed", e => { e.approvals = e.approvals.filter(a => !(a.decision_id === L.accept.id && a.approver === "seat-1")); }, ["decision", "implicit-approval-missing"]],
    ["a pending decision marked effective", e => { decisionRow(e, L.pendingD1R.id).state = "effective"; }, ["decision", "state-log-mismatch"]],
    ["a decision row dropped", e => { e.decisions = e.decisions.filter(d => d.id !== L.pendingD1R.id); }, ["decision", "row-missing"]],
    ["an owner post moved earlier", e => { const d = decisionRow(e, L.d2.id); d.owner_posted_at -= HOUR; d.effect_at -= HOUR; }, ["decision", "owner-post-unconfirmed"]],
    ["a D2 effect time shortened", e => { decisionRow(e, L.d2.id).effect_at -= HOUR; }, ["decision", "column-mismatch", "effect_at"]],
    ["the signed owner confirmation removed", e => { const ref = decisionRow(e, L.d2.id).owner_line_ref; e.owner_record_confirmations = e.owner_record_confirmations.filter(c => c.outbox_id !== ref); }, ["decision", "owner-post-unconfirmed"]],
    ["a passing verification marked failed", e => { e.verify_results.find(v => v.submission_id === L.submission).passed = 0; }, ["verify-result", "column-mismatch", "passed"]],
    ["a verification moved to another patch", e => { e.verify_results.find(v => v.submission_id === L.submission).patch_sha256 = "c".repeat(64); }, ["verify-result", "column-mismatch", "patch_sha256"]],
    ["a role raised", e => { e.roles.find(r => r.member_id === L.B && r.role === "C0" && r.decision_id === L.d2.id).role = "C2"; }, ["role", "role-decision-mismatch"]],
    ["a role pinned to an unrelated decision", e => { e.roles.find(r => r.member_id === L.A && r.role === "C1").decision_id = L.accept.id; }, ["role", "role-decision-mismatch"]],
    ["a decision suspension ended by a re-bind", e => { const s = e.suspensions.find(x => x.reason === "decision"); s.ended_at = s.started_at + 1; s.ended_by_decision = L.d1r.id; }, ["suspension", "suspension-end-mismatch"]],
    ["a suspension attributed to another decision", e => { e.suspensions.find(x => x.reason === "decision").decision_id = L.d2.id; }, ["suspension", "suspension-decision-mismatch"]],
    ["a contribution credited by a non-accept decision", e => { e.contributions[0].decision_id = L.d2.id; }, ["contribution", "contribution-decision-mismatch"]],
    ["a finding moved to another member", e => { e.security_findings[0].member_id = L.A; }, ["finding-open", "column-mismatch", "member_id"]],
    ["a co-author moved to another submission", e => { e.coauthors[0].submission_id = "other"; }, ["coauthor", "column-mismatch", "submission_id"]],
    // v3.3 (C2, N36, security review D-C1)
    ["a verdict's prev column changed", e => { verdictRow(e, L.d2.id, "seat-4", 2).prev = "0".repeat(64); }, ["approval", "column-mismatch", "prev"]],
    ["a verdict's body hash column changed", e => { verdictRow(e, L.d2.id, "seat-3", 1).body_sha256 = "0".repeat(64); }, ["approval", "column-mismatch", "body_sha256"]],
    ["a decision marked reversed with no veto", e => { decisionRow(e, L.accept.id).state = "reversed"; }, ["decision", "reversal-without-veto"]],
    ["an author added without a declaration", e => { e.decision_authors.push({ decision_id: L.accept.id, principal: "seat-5" }); }, ["decision", "authors-mismatch"]],
    ["a co-author declaration dropped", e => { e.coauthors = []; }, ["decision", "authors-mismatch"]],
    ["a signer's key window moved past its records", e => { e.keys.find(k => k.principal_id === "seat-2").added_at = T0 + 99 * DAY; }, ["approval", "key-not-valid-at-signing"]],
    ["a signer's key revoked before its records", e => { const k = e.keys.find(k => k.principal_id === "seat-3"); k.status = "revoked"; k.revoked_at = T0 - 1; }, ["approval", "key-not-valid-at-signing"]],
    ["an attestation's family changed", e => { e.served_by_attestations[0].family = "xai"; }, ["attestation", "column-mismatch", "family"]],
    ["an attestation re-pointed at another verdict", e => { e.served_by_attestations[0].target_seq = 7; }, ["attestation", "column-mismatch", "target_seq"]],
    ["the policy family map changed under an attestation", e => { e.policy_family_map.forEach(m => { if (m.family === "openai") m.family = "anthropic"; }); }, ["attestation", "attest-family-map"]],
    ["a member's role projection raised", e => { e.members.find(m => m.member_id === L.A).role = "C3"; }, ["member", "member-projection-mismatch", "role"]],
    ["a suspended member shown active", e => { e.members.find(m => m.member_id === L.A).status = "active"; }, ["member", "member-projection-mismatch", "status"]],
    ["a veto re-projection to the wrong role", e => { e.roles.find(r => r.member_id === L.C && r.decision_id === L.veto.id).role = "C1"; }, ["role", "role-decision-mismatch"]],
    ["a rebind suspension tied to another invite", e => { e.suspensions.find(x => x.reason === "rebind").invite_id = e.invites.find(i => i.kind === "enroll").invite_id; }, ["suspension", "suspension-invite-mismatch"]],
    ["an invite's kind changed", e => { e.invites.find(i => i.kind === "rebind").kind = "rekey"; }, ["invite", "invite-decision-mismatch"]],
    ["an enrollment's confirmer changed", e => { e.enrollments.find(x => x.kind === "enroll").confirmed_by = "seat-7"; }, ["enrollment", "enrollment-confirmation-mismatch"]],
    // v3.3.1 (security review D-C1 and explicit items)
    ["a decision's lane re-pointed (the lane lives only in the signed body)", e => { const d = decisionRow(e, L.accept.id); d.body = d.body.replace('"lane":"relay-core"', '"lane":"other-lane"'); }, ["decision", "bad-signature"]],
    ["a failed verification flipped to passed", e => { e.verify_results.find(v => v.submission_id === L.failed).passed = 1; }, ["verify-result", "column-mismatch", "passed"]],
  ];
  for (const [name, mutate, [kind, reason, field]] of cases) {
    const exp = structuredClone(clean);
    mutate(exp);
    const res = verifyExport(exp, L.roster);
    assert.equal(res.ok, false, `${name}: not caught`);
    assert.ok(res.problems.some(p => p.kind === kind && p.reason === reason && (field === undefined || p.field === field)),
      `${name}: expected ${kind}/${reason}${field ? "/" + field : ""}, got ${JSON.stringify(res.problems)}`);
  }
  assert.deepEqual(verifyExport(clean, L.roster), { ok: true, problems: [] }, "the clean export is unchanged and still verifies");
});
