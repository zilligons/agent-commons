// L0 governance reducer (spec v3.2 sections 9 and 10, Addendum A1). The
// structural guards are pinned by relay-schema.test.mjs (the ported 62 cases and
// 23 mutants); these tests pin the reducer contract that SQL cannot see: latest
// verdict per seat, quorum and family counts, the D2 window, provenance of
// authors, suspension effects, freeze, and the permission table.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMemberRecord, runSweep } from "../src/relay/board.mjs";
import { settleAll, quorum, roleOf, permits, PERMISSION_TABLE, CEILING, ALL_ACTIONS, PRINCIPAL_KINDS, touchesSecurityPath } from "../src/relay/governance.mjs";
import { ROLES } from "../src/relay/records.mjs";
import { signBody } from "../src/relay/signing.mjs";
import { setup, decision, approval, verifyResult, securityApproval, coauthor, ownerConfirm, taskArgs, PATCH, outboxFor, rejects, T0, MIN, HOUR, DAY, createDecision, addVerdict, recordVerifyResult, recordSecurityApproval, declareCoauthor, confirmOwnerRecord } from "./relay-fixtures.mjs";

const stateOf = (fx, id) => fx.db.prepare("SELECT state FROM decisions WHERE id = ?").get(id).state;

function memberAtC1(fx, name, at = T0) {
  const id = fx.members[name].id;
  handleMemberRecord(fx.db, id, { type: "heartbeat", record_id: `hb-${name}-${at}`, body: {} }, at);
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "role.c1", subject: id, at }), at);
  return id;
}

/** Member A at C1 with an in-review patch submission on task-1. */
function submitted({ paths = ["docs"], patch = PATCH("docs/relay.md") } = {}) {
  const fx = setup({ members: ["A", "B"] });
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "task-1", args: taskArgs(paths) }), T0);
  const A = memberAtC1(fx, "A");
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "task-1", lease_ms: HOUR } }, T0);
  const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: c.epoch, kind: "patch", body: patch } }, T0);
  return { fx, A, claim: c, result: r };
}

test("N17 (V5) authors come from provenance; an author may reject and block, never approve", () => {
  const { fx, A, result } = submitted();
  // seat-2 contributed to the patch and declares it before any decision exists.
  declareCoauthor(fx.db, coauthor(fx, "seat-2", result.submission_id), T0);
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: result.submission_id }), T0);
  const authors = fx.db.prepare("SELECT principal FROM decision_authors WHERE decision_id = ? ORDER BY principal").all(d.id).map(r => r.principal);
  assert.deepEqual(authors, [A, "seat-2"].sort());
  rejects(() => declareCoauthor(fx.db, coauthor(fx, "seat-4", result.submission_id), T0), "coauthors-closed");
  rejects(() => addVerdict(fx.db, approval(fx, "seat-2", d.id), T0), "author-cannot-approve");
  addVerdict(fx.db, approval(fx, "seat-2", d.id, "reject"), T0);
  addVerdict(fx.db, approval(fx, "seat-4", d.id), T0);
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256 }), T0);
  assert.equal(stateOf(fx, d.id), "pending", "the author's reject blocks");
  assert.deepEqual(quorum(fx.db, d.id).rejections, ["seat-2"]);
  addVerdict(fx.db, approval(fx, "seat-2", d.id, "withdraw"), T0);
  assert.equal(stateOf(fx, d.id), "effective", "withdrawing the reject releases the D1");
  // A lane owner who is a declared author cannot even propose the accept.
  const second = submitted();
  declareCoauthor(second.fx.db, coauthor(second.fx, "seat-1", second.result.submission_id), T0);
  rejects(() => createDecision(second.fx.db, decision(second.fx, "seat-1", { cls: "D1", action: "accept", subject: second.result.submission_id }), T0), "author-cannot-approve");
});

test("N21 D1 needs the lane owner, a second family and a passing verification re-run; evidence never counts", () => {
  const { fx, result } = submitted();
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: result.submission_id }), T0);
  addVerdict(fx.db, approval(fx, "seat-3", d.id), T0);           // anthropic, like seat-1
  handleMemberRecord(fx.db, fx.members.A.id, { type: "evidence", record_id: "e", body: { submission_id: result.submission_id, kind: "test-log", text: "all green" } }, T0);
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256 }), T0);
  assert.equal(stateOf(fx, d.id), "pending", "two seats of one family are not a D1");
  assert.deepEqual(quorum(fx.db, d.id).families, ["anthropic"]);
  addVerdict(fx.db, approval(fx, "seat-5", d.id), T0);           // deepseek
  assert.equal(stateOf(fx, d.id), "effective");
});

test("N21 a failing or mismatched verification never counts", () => {
  const { fx, result } = submitted();
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: result.submission_id }), T0);
  addVerdict(fx.db, approval(fx, "seat-2", d.id), T0);
  rejects(() => recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: "c".repeat(64) }), T0), "verify-mismatch");
  rejects(() => recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256, base_commit: "f".repeat(40) }), T0), "verify-mismatch");
  rejects(() => recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256, network: "host" }), T0), "verify-network-not-cut");
  assert.equal(recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256, exit_codes: [0, 1] }), T0).passed, false);
  assert.equal(stateOf(fx, d.id), "pending");
});

test("N21 a security-path patch needs security.approve in addition to D1", () => {
  const path = "packages/agent-commons/src/relay/render.mjs";
  assert.equal(touchesSecurityPath([path]), true);
  assert.equal(touchesSecurityPath(["docs/relay.md"]), false);
  const { fx, result } = submitted({ paths: [path], patch: PATCH(path) });
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: result.submission_id }), T0);
  addVerdict(fx.db, approval(fx, "seat-2", d.id), T0);
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256 }), T0);
  assert.equal(stateOf(fx, d.id), "pending");
  const sa = securityApproval(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256 });
  rejects(() => recordSecurityApproval(fx.db, { body: { ...sa.body, by: "seat-2" }, sig: sa.sig }, T0), "unauthorized");
  recordSecurityApproval(fx.db, sa, T0);
  assert.equal(stateOf(fx, d.id), "effective");
});

function eligibleForC2(fx, name) {
  const id = fx.members[name].id;
  for (let i = 0; i < 3; i++) {
    const at = T0 + i * DAY, task = `c2-${name}-${i}`;
    createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: task, args: taskArgs(["docs"]), at }), at);
    const c = handleMemberRecord(fx.db, id, { type: "claim", record_id: `${task}-c`, body: { task_id: task, lease_ms: HOUR } }, at);
    const r = handleMemberRecord(fx.db, id, { type: "result", record_id: `${task}-r`, body: { claim_id: c.claim_id, epoch: c.epoch, kind: "report", body: "Done." } }, at);
    const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id, at }), at);
    addVerdict(fx.db, approval(fx, "seat-2", d.id, "approve", at), at);
    assert.equal(stateOf(fx, d.id), "effective");
  }
  return id;
}

test("N18 / N19 D2: three non-sponsor seats on two families, confirmed owner post, exactly 24 h", () => {
  const fx = setup({ members: ["A"] });
  const id = memberAtC1(fx, "A");
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: id, sponsor: "seat-1", args: { role: "C2" } }), T0), "not-eligible");
  eligibleForC2(fx, "A");
  const now = T0 + 3 * DAY;
  const d2 = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: id, sponsor: "seat-1", args: { role: "C2" }, at: now }), now);
  for (const verdict of ["approve", "object", "reject"]) rejects(() => addVerdict(fx.db, approval(fx, "seat-1", d2.id, verdict, now), now), "sponsor-excluded");
  for (const seat of ["seat-2", "seat-3", "seat-4"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
  assert.equal(stateOf(fx, d2.id), "pending", "no confirmed owner post, no clock");
  const post = now + HOUR;
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-5", outboxFor(fx.db, d2.id), post), post);
  const row = fx.db.prepare("SELECT owner_posted_at, effect_at FROM decisions WHERE id = ?").get(d2.id);
  assert.deepEqual([row.owner_posted_at, row.effect_at], [post, post + DAY]);
  settleAll(fx.db, post + DAY - 1);
  assert.equal(stateOf(fx, d2.id), "pending", "one millisecond early");
  settleAll(fx.db, post + DAY);
  assert.equal(stateOf(fx, d2.id), "effective");
  assert.equal(roleOf(fx.db, id), "C2");
});

test("N18 (A1) the sponsor's withdraw ends the D2; a non-sponsor object blocks until withdrawn; one family is no quorum; the owner vetoes", () => {
  const fx = setup({ members: ["A"] });
  const id = memberAtC1(fx, "A");
  eligibleForC2(fx, "A");
  const now = T0 + 3 * DAY;
  const withdrawn = createDecision(fx.db, decision(fx, "seat-2", { cls: "D2", action: "role.change", subject: id, sponsor: "seat-2", args: { role: "C2" }, at: now }), now);
  addVerdict(fx.db, approval(fx, "seat-2", withdrawn.id, "withdraw", now), now);
  assert.equal(stateOf(fx, withdrawn.id), "withdrawn");
  rejects(() => addVerdict(fx.db, approval(fx, "seat-3", withdrawn.id, "approve", now), now), "decision-closed");

  const d2 = createDecision(fx.db, decision(fx, "seat-2", { cls: "D2", action: "role.change", subject: id, sponsor: "seat-2", args: { role: "C2" }, at: now }), now);
  for (const seat of ["seat-1", "seat-3"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "scope", outboxFor(fx.db, d2.id), now), now);
  settleAll(fx.db, now + 2 * DAY);
  assert.equal(stateOf(fx, d2.id), "pending", "two approvals, one family");
  addVerdict(fx.db, approval(fx, "seat-4", d2.id, "object", now + 2 * DAY), now + 2 * DAY);
  addVerdict(fx.db, approval(fx, "seat-5", d2.id, "approve", now + 2 * DAY), now + 2 * DAY);
  assert.equal(stateOf(fx, d2.id), "pending", "a live objection blocks a D2 with quorum");
  assert.deepEqual(quorum(fx.db, d2.id).objections, ["seat-4"]);
  addVerdict(fx.db, approval(fx, "seat-4", d2.id, "withdraw", now + 2 * DAY), now + 2 * DAY);
  assert.equal(stateOf(fx, d2.id), "effective", "withdrawn objection, quorum, window passed");

  const vetoed = createDecision(fx.db, decision(fx, "seat-3", { cls: "D2", action: "role.change", subject: id, sponsor: "seat-3", args: { role: "C0" }, at: now }), now);
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "OWNER", action: "veto", subject: vetoed.id }), now), "forbidden");
  rejects(() => confirmOwnerRecord(fx.db, ownerConfirm(fx, "owner", outboxFor(fx.db, vetoed.id), now), now), "forbidden");
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "veto", subject: vetoed.id }), now);
  assert.equal(stateOf(fx, vetoed.id), "vetoed");
});

test("N20 suspension releases claims (no attempt), holds submissions, blocks D1; only a D2 reinstate ends it", () => {
  const { fx, A, result } = submitted();
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "task-2", args: taskArgs(["docs"]) }), T0);
  const B = memberAtC1(fx, "B");
  const cb = handleMemberRecord(fx.db, B, { type: "claim", record_id: "cb", body: { task_id: "task-2", lease_ms: HOUR } }, T0);
  const accept = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: result.submission_id }), T0);
  createDecision(fx.db, decision(fx, "verifier", { cls: "SUSPEND", action: "suspend", subject: A }), T0 + MIN);
  createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: B }), T0 + MIN);
  assert.deepEqual({ ...fx.db.prepare("SELECT state, released_reason FROM claims WHERE claim_id = ?").get(cb.claim_id) }, { state: "released", released_reason: "suspension" });
  assert.deepEqual({ ...fx.db.prepare("SELECT status, attempts FROM tasks WHERE task_id = 'task-2'").get() }, { status: "open", attempts: 0 });
  assert.equal(fx.db.prepare("SELECT state FROM submissions WHERE submission_id = ?").get(result.submission_id).state, "held");
  assert.equal(fx.db.prepare("SELECT status FROM tasks WHERE task_id = 'task-1'").get().status, "held");
  addVerdict(fx.db, approval(fx, "seat-2", accept.id), T0 + MIN);
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256 }), T0 + MIN);
  assert.equal(stateOf(fx, accept.id), "pending", "no D1 can accept a held submission");
  // Reinstatement: D2 with three non-sponsor seats, a confirmed post, the window.
  const t = T0 + 2 * MIN;
  const reinstate = createDecision(fx.db, decision(fx, "seat-2", { cls: "D2", action: "reinstate", subject: A, sponsor: "seat-2", at: t }), t);
  for (const seat of ["seat-1", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, reinstate.id, "approve", t), t);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, reinstate.id), t), t);
  settleAll(fx.db, t + DAY);   // the accept settles first (still held), then the reinstatement
  assert.equal(fx.db.prepare("SELECT status FROM members WHERE member_id = ?").get(A).status, "active");
  assert.equal(fx.db.prepare("SELECT ended_by_decision FROM suspensions WHERE member_id = ?").get(A).ended_by_decision, reinstate.id);
  assert.equal(fx.db.prepare("SELECT state FROM submissions WHERE submission_id = ?").get(result.submission_id).state, "in-review");
  settleAll(fx.db, t + DAY);
  assert.equal(stateOf(fx, accept.id), "effective");
  assert.equal(fx.db.prepare("SELECT status FROM members WHERE member_id = ?").get(B).status, "suspended", "B's own suspension is untouched");
});

test("D0 is lane-owner only; bad signatures, unknown principals, retired keys and missing Served-by are refused", () => {
  const fx = setup({ members: ["A"] });
  const id = memberAtC1(fx, "A");
  rejects(() => createDecision(fx.db, decision(fx, "seat-2", { cls: "D0", action: "task.open", subject: "t9", args: taskArgs() }), T0), "not the lane owner");
  const forged = decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t9", args: taskArgs() });
  rejects(() => createDecision(fx.db, { body: forged.body, sig: decision(fx, "seat-2", { cls: "D0", action: "task.open", subject: "t9", args: taskArgs() }).sig }, T0), "unauthorized");
  rejects(() => createDecision(fx.db, { body: { ...forged.body, by: "nobody" }, sig: forged.sig }, T0), "unauthorized");
  rejects(() => createDecision(fx.db, { body: { ...forged.body, title: "x" }, sig: forged.sig }, T0), "unauthorized");
  const { served_by, ...unserved } = decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t10", args: taskArgs() }).body;
  assert.equal(typeof served_by, "string");
  rejects(() => createDecision(fx.db, { body: unserved, sig: signBody(fx.keys["seat-1"], unserved) }, T0), "served_by");
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "task.open", subject: "t9", args: taskArgs() }), T0), "unknown-action");
  // enroll.confirm is an L0 seat decision since Addendum C4; an already-enrolled member is not confirmable.
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "enroll.confirm", subject: id, args: { owner_line_ref: "x" } }), T0), "member not pending");
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "role.grant", subject: id }), T0), "unknown-action");
  for (const paths of [["../etc"], ["."], [".env"], ["/abs"]])
    rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: `t-${paths[0]}`.replace(/[^A-Za-z0-9-]/g, "x"), args: taskArgs(paths) }), T0), "invalid-field");
  // A retired principal's records are refused at once.
  fx.db.prepare("UPDATE fleet_principals SET status = 'retired' WHERE principal_id = 'seat-1'").run();
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t11", args: taskArgs() }), T0), "unauthorized");
  assert.equal(roleOf(fx.db, id), "C1");
});

test("extension tables keep their own lifecycle guards", () => {
  const fx = setup({ members: ["A"] });
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t-log", args: taskArgs() }), T0);
  const A = memberAtC1(fx, "A");
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t-log", lease_ms: HOUR } }, T0);
  assert.ok(fx.db.prepare("SELECT count(*) n FROM logs").get().n > 0, "guards are exercised on real rows");
  rejects(() => fx.db.prepare("UPDATE logs SET hash = 'x'").run(), "logs-fixed");
  rejects(() => fx.db.prepare("DELETE FROM logs").run(), "logs-fixed");
  rejects(() => fx.db.prepare("UPDATE tasks SET paths = '[]' WHERE task_id = 't-log'").run(), "task-fixed");
  rejects(() => fx.db.prepare("UPDATE tasks SET attempts = -1 WHERE task_id = 't-log'").run(), "task-fixed");
  rejects(() => fx.db.prepare("UPDATE claim_details SET lease_ms = 1").run(), "claim-details-fixed");
  rejects(() => fx.db.prepare("UPDATE claims SET lease_until = lease_until - 1 WHERE claim_id = ?").run(c.claim_id), "lease-moves-forward");
  rejects(() => fx.db.prepare("UPDATE claims SET epoch = 9 WHERE claim_id = ?").run(c.claim_id), "claim-immutable");
  rejects(() => fx.db.prepare("UPDATE claims SET member_id = 'someone' WHERE claim_id = ?").run(c.claim_id), "claim-immutable");
  rejects(() => fx.db.prepare("INSERT INTO claims(claim_id, task_id, member_id, epoch, state, lease_until, released_reason, released_at) VALUES ('x', 't-log', ?, 1, 'live', 1, NULL, NULL)").run(A), "epoch-must-rise");
  rejects(() => fx.db.prepare("UPDATE member_profiles SET lane = 'other' WHERE member_id = ?").run(A), "profile-identity-fixed");
  rejects(() => fx.db.prepare("DELETE FROM member_records").run(), "member-record-fixed");
  rejects(() => fx.db.prepare("UPDATE decisions SET effect_at = 'not-a-time' WHERE id = 'fx-enroll-A'").run(), "cannot store TEXT value in INTEGER column");
});

test("N26 freeze: members get 503, fleet records are refused except veto, unfreeze and owner-record.confirm, leases neither expire nor shrink", () => {
  const fx = setup({ members: ["A"] });
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t", args: taskArgs(["docs"]) }), T0);
  const A = memberAtC1(fx, "A");
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t", lease_ms: 2 * MIN } }, T0);
  // A D2 reinstatement whose window ends during the freeze.
  createDecision(fx.db, decision(fx, "seat-2", { cls: "SUSPEND", action: "suspend", subject: A }), T0 + 1);
  const t = T0 + MIN;
  const r = createDecision(fx.db, decision(fx, "seat-2", { cls: "D2", action: "reinstate", subject: A, sponsor: "seat-2", at: t }), t);
  for (const seat of ["seat-1", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, r.id, "approve", t), t);
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "OWNER", action: "freeze", subject: "relay" }), t), "forbidden");
  createDecision(fx.db, decision(fx, "scope", { cls: "OWNER", action: "freeze", subject: "relay" }), t);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, r.id), t), t);   // allowed while frozen
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t2", args: taskArgs() }), t), "frozen");
  rejects(() => addVerdict(fx.db, approval(fx, "seat-6", r.id, "approve", t), t), "frozen");
  rejects(() => createDecision(fx.db, decision(fx, "scope", { cls: "OWNER", action: "unfreeze", subject: "relay" }), t), "forbidden");
  const frozen = rejects(() => handleMemberRecord(fx.db, fx.members.A.id, { type: "heartbeat", record_id: "f", body: {} }, t + 2 * MIN), "frozen");
  assert.equal(frozen.status, 503);
  settleAll(fx.db, t + 2 * DAY);
  assert.equal(stateOf(fx, r.id), "pending", "no decision becomes effective while frozen");
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "unfreeze", subject: "relay" }), t + 2 * DAY);
  settleAll(fx.db, t + 2 * DAY);
  assert.equal(stateOf(fx, r.id), "effective");
  assert.equal(fx.db.prepare("SELECT state FROM claims WHERE claim_id = ?").get(c.claim_id).state, "released", "the suspension had released it");
});

test("N26 a live lease is extended by the frozen interval on unfreeze, and nothing expires while frozen", () => {
  const fx = setup({ members: ["A"] });
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t", args: taskArgs(["docs"]) }), T0);
  const A = memberAtC1(fx, "A");
  const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t", lease_ms: 2 * MIN } }, T0);
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "freeze", subject: "relay" }), T0 + MIN);
  assert.deepEqual(runSweep(fx.db, T0 + HOUR), { frozen: true, expired: [] });
  createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "unfreeze", subject: "relay" }), T0 + HOUR + MIN);
  assert.equal(fx.db.prepare("SELECT lease_until FROM claims WHERE claim_id = ?").get(c.claim_id).lease_until, T0 + 2 * MIN + HOUR);
  assert.equal(runSweep(fx.db, T0 + HOUR + MIN).expired.length, 0, "the frozen hour does not count against the lease");
});

test("N16 permission table: every member role is refused every fleet and ceiling action; table asserted in full", () => {
  for (const role of ROLES) for (const action of CEILING) assert.equal(permits("member", role, action), false, `${role} ${action}`);
  const memberAllowed = (role) => ALL_ACTIONS.filter(a => permits("member", role, a)).sort();
  assert.deepEqual(memberAllowed("C0"), ["board.read", "claims.read", "heartbeat", "inbox.ack", "inbox.read", "message", "note"]);
  assert.deepEqual(memberAllowed("C1"), [...memberAllowed("C0"), "claim", "evidence", "progress", "release", "result", "review-request"].sort());
  assert.deepEqual(memberAllowed("C2"), [...memberAllowed("C1"), "advisory-review", "propose"].sort());
  assert.deepEqual(memberAllowed("C3"), memberAllowed("C2"));
  assert.equal(permits("member", null, "heartbeat"), false, "no role, no permission");
  for (const kind of PRINCIPAL_KINDS.filter(k => k !== "member")) for (const action of ALL_ACTIONS)
    if (permits(kind, null, action)) assert.equal(permits("member", "-", action), false);
  const fleet = (kind) => ALL_ACTIONS.filter(a => permits(kind, null, a)).sort();
  assert.deepEqual(fleet("owner"), ["freeze", "suspend", "unfreeze", "veto"]);
  assert.deepEqual(fleet("scope"), ["freeze", "owner-record.confirm", "suspend"]);
  assert.equal(fleet("owner").includes("owner-record.confirm"), false, "9.5: confirmations are signed by an AC seat or the scope seat");
  assert.equal(PERMISSION_TABLE.size, (7 + 13 + 15 + 15) + (9 + 3 + 5 + 3 + 4 + 1));
});
