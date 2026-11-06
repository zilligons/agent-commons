// L0: re-bind confirmation (D1R) and the re-bind count in the ledger (spec v3.2
// sections 5.4, 9.2, 9.6; RD2, RD3; B3). The rebind invite and the
// /v1/rebind request are L1; tests seed their 9.3 rows through seedRebind. The
// rebind.repeat alert is L1 with that flow. Scratch databases, fixture keys.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { loadPolicy } from "../src/relay/roster.mjs";
import { settleAll, rebindCount, rebindConfirmationView } from "../src/relay/governance.mjs";
import { setup, seedRebind, decision, approval, ownerConfirm, outboxFor, taskArgs, PATCH, laneD0, promoteC1, rejects, LANE,
  T0, MIN, HOUR, DAY, createDecision, addVerdict, fixtureFiles, confirmOwnerRecord } from "./relay-fixtures.mjs";

const D1R = (fx, by, subject, at = T0, extra = {}) => createDecision(fx.db, decision(fx, by, { cls: "D1R", action: "rebind.confirm", subject, at, ...extra }), at);
const stateOf = (fx, id) => fx.db.prepare("SELECT state FROM decisions WHERE id = ?").get(id).state;
const status = (fx, id) => fx.db.prepare("SELECT status FROM members WHERE member_id = ?").get(id).status;
const keyStatus = (fx, key) => fx.db.prepare("SELECT status FROM keys WHERE public_key = ?").get(key).status;
const postConfirmed = (fx, d, at = T0) => confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-5", outboxFor(fx.db, d.id), at), at);
const counted = (fx) => fx.db.prepare("SELECT event FROM logs WHERE log = 'security' ORDER BY seq").all()
  .map(r => JSON.parse(r.event)).filter(e => e.kind === "rebind.confirmed").map(e => e.count);

/** seat-2 (openai) proposes, seat-4 (google) approves, the owner post is confirmed: a passing D1R. */
function confirmRebind(fx, enrollment, at = T0) {
  const d = D1R(fx, "seat-2", enrollment, at);
  addVerdict(fx.db, approval(fx, "seat-4", d.id, "approve", at), at);
  postConfirmed(fx, d, at);
  return d;
}

test("D1R re-bind: two seats on two families, neither the invite creator, effective after the owner post; the key moves", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id, oldKey = fx.members.A.identity.publicKeyHex;
  const rb = seedRebind(fx, "A");
  assert.equal(status(fx, A), "suspended", "the re-bind invite suspends the member");
  const before = rebindConfirmationView(fx.db, rb.enrollment);
  assert.deepEqual(before, { enrollment_id: rb.enrollment, member_id: A, invite_id: rb.invite, invite_created_by: "seat-1",
    new_agent: rb.identity.uuaid, new_public_key: rb.identity.publicKeyHex, requested_at: T0, rebind_count: 0, open_suspensions: ["rebind"], dead_attempts: [] });
  rejects(() => D1R(fx, "seat-1", rb.enrollment), "confirmer-is-invite-creator");
  const d = D1R(fx, "seat-2", rb.enrollment);
  assert.equal(d.state, "pending", "one seat is not enough");
  rejects(() => addVerdict(fx.db, approval(fx, "seat-1", d.id), T0), "confirmer-is-invite-creator");
  addVerdict(fx.db, approval(fx, "seat-4", d.id), T0);
  assert.equal(stateOf(fx, d.id), "pending", "two families, but the owner post is not confirmed");
  postConfirmed(fx, d, T0 + MIN);
  assert.equal(stateOf(fx, d.id), "effective");
  assert.equal(status(fx, A), "active");
  assert.deepEqual([keyStatus(fx, oldKey), keyStatus(fx, rb.identity.publicKeyHex)], ["revoked", "active"], "all old keys revoked");
  assert.equal(fx.db.prepare("SELECT ended_by_decision FROM suspensions WHERE invite_id = ?").get(rb.invite).ended_by_decision, d.id);
  assert.equal(rebindCount(fx.db, A), 1);
  assert.deepEqual(counted(fx), [1]);
  assert.equal(rebindConfirmationView(fx.db, rb.enrollment).rebind_count, 1);
  // Stable member: the member id is unchanged and its records resume.
  assert.equal(handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "after", body: {} }, T0 + MIN).kind, "heartbeat");
  rejects(() => D1R(fx, "seat-3", rb.enrollment, T0 + MIN), "re-bind not open");
});

test("D1R refusals: no lane, no args, a re-bind enrollment only; one family, an unmeasured turn or a live reject leaves it pending", () => {
  const fx = setup({ members: ["A"] });
  // The rebind invite comes from the lane owner (invite.create, C4); policy v2 makes seat-2 the lane owner,
  // so seat-1 and seat-3 (both anthropic by assertion) can confirm.
  loadPolicy(fx.db, fixtureFiles(fx.keys, { policyVersion: 2, lanes: [{ lane: LANE, owner_seat: "seat-2" }] }).policy, { ownerPublicKey: fx.keys.owner.publicKeyHex, now: T0 });
  const rb = seedRebind(fx, "A");
  assert.equal(fx.db.prepare("SELECT created_by FROM invites WHERE invite_id = ?").get(rb.invite).created_by, "seat-2");
  const enrollA = fx.db.prepare("SELECT id FROM enrollments WHERE kind = 'enroll' AND member_id = ?").get(fx.members.A.id).id;
  rejects(() => D1R(fx, "seat-1", rb.enrollment, T0, { lane: LANE }), "invalid-field");
  rejects(() => D1R(fx, "seat-1", rb.enrollment, T0, { args: { force: 1 } }), "unknown-field");
  rejects(() => D1R(fx, "seat-1", enrollA), "no re-bind enrollment");
  rejects(() => D1R(fx, "seat-1", "rb-none"), "no re-bind enrollment");
  rejects(() => createDecision(fx.db, decision(fx, "verifier", { cls: "D1R", action: "rebind.confirm", subject: rb.enrollment }), T0), "forbidden");
  const d = D1R(fx, "seat-1", rb.enrollment);                                              // anthropic
  addVerdict(fx.db, approval(fx, "seat-3", d.id), T0);                                     // anthropic again
  addVerdict(fx.db, approval(fx, "seat-6", d.id, "approve", T0, "unmeasured: route unattested"), T0);   // qwen by roster, unmeasured
  postConfirmed(fx, d);
  assert.equal(stateOf(fx, d.id), "pending", "three seats, one measured family");
  addVerdict(fx.db, approval(fx, "seat-7", d.id, "reject"), T0);
  addVerdict(fx.db, approval(fx, "seat-4", d.id), T0);                                     // google: two families now
  assert.equal(stateOf(fx, d.id), "pending", "a live reject blocks a D1R (A1)");
  addVerdict(fx.db, approval(fx, "seat-7", d.id, "withdraw"), T0 + MIN);
  assert.equal(stateOf(fx, d.id), "effective");
});

test("RD2: a re-bind ends only its own suspension; a decision suspension stays until a D2 reinstate", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id;
  createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: A }), T0);
  const rb = seedRebind(fx, "A", { at: T0 + MIN });
  confirmRebind(fx, rb.enrollment, T0 + MIN);
  assert.equal(status(fx, A), "suspended");
  assert.deepEqual(rebindConfirmationView(fx.db, rb.enrollment).open_suspensions, ["decision"]);
  assert.equal(keyStatus(fx, rb.identity.publicKeyHex), "active", "the key still moved");
  rejects(() => handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "x", body: {} }, T0 + MIN), "unauthorized");
});

test("a re-bind releases claims and holds submissions (P3); confirmation returns the held work to review", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  for (const t of ["t1", "t2"]) laneD0(fx, "task.open", t, taskArgs(["docs"]));
  const c1 = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c1", body: { task_id: "t1", lease_ms: HOUR } }, T0);
  const r1 = handleMemberRecord(fx.db, A, { type: "result", record_id: "r1", body: { claim_id: c1.claim_id, epoch: 1, kind: "patch", body: PATCH() } }, T0);
  handleMemberRecord(fx.db, A, { type: "claim", record_id: "c2", body: { task_id: "t2", lease_ms: HOUR } }, T0);
  const task = (id) => fx.db.prepare("SELECT status, attempts FROM tasks WHERE task_id = ?").get(id);
  const sub = () => fx.db.prepare("SELECT state FROM submissions WHERE submission_id = ?").get(r1.submission_id).state;
  const rb = seedRebind(fx, "A");
  assert.deepEqual({ t1: { ...task("t1") }, t2: { ...task("t2") }, sub: sub() },
    { t1: { status: "held", attempts: 0 }, t2: { status: "open", attempts: 0 }, sub: "held" });
  assert.equal(fx.db.prepare("SELECT released_reason FROM claims WHERE task_id = 't2'").get().released_reason, "suspension");
  confirmRebind(fx, rb.enrollment);
  assert.deepEqual({ t1: task("t1").status, sub: sub() }, { t1: "in-review", sub: "in-review" });
});

test("RD3 count: effective D1R re-binds only; lapsed, pending and duplicate re-binds do not count", () => {
  const fx = setup({ members: ["A"] });
  const A = fx.members.A.id;
  // 1st re-bind.
  const one = seedRebind(fx, "A");
  confirmRebind(fx, one.enrollment);
  assert.equal(rebindCount(fx.db, A), 1);
  // 2nd: a first D1R lapses after 14 days and does not count; a second one takes effect.
  const two = seedRebind(fx, "A", { at: T0 + DAY });
  const lapsing = D1R(fx, "seat-2", two.enrollment, T0 + DAY);
  settleAll(fx.db, T0 + 15 * DAY);
  assert.equal(stateOf(fx, lapsing.id), "lapsed");
  assert.equal(rebindConfirmationView(fx.db, two.enrollment).rebind_count, 1, "the view shows the count before a seat signs");
  confirmRebind(fx, two.enrollment, T0 + 15 * DAY);
  assert.equal(rebindCount(fx.db, A), 2);
  // 3rd: two D1Rs race to quorum on one enrollment; the second lapses at effect time.
  const three = seedRebind(fx, "A", { at: T0 + 16 * DAY });
  const at = T0 + 16 * DAY;
  const first = D1R(fx, "seat-2", three.enrollment, at), second = D1R(fx, "seat-6", three.enrollment, at);
  for (const d of [first, second]) addVerdict(fx.db, approval(fx, "seat-4", d.id, "approve", at), at);
  postConfirmed(fx, first, at);
  postConfirmed(fx, second, at);
  assert.deepEqual([stateOf(fx, first.id), stateOf(fx, second.id)], ["effective", "lapsed"]);
  rejects(() => D1R(fx, "seat-3", three.enrollment, at), "re-bind not open");
  // A pending re-bind (4th, never confirmed) does not count either.
  const four = seedRebind(fx, "A", { at: at + MIN });
  D1R(fx, "seat-2", four.enrollment, at + MIN);
  assert.equal(rebindCount(fx.db, A), 3);
  assert.deepEqual(counted(fx), [1, 2, 3], "one ledger event per effective re-bind, carrying the count");
  assert.equal(rebindConfirmationView(fx.db, four.enrollment).rebind_count, 3);
});
