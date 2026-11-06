// -022 Addendum C4 (spec v3.3 sections 5.1, 5.3, 5.4, 15): the seat decisions of the
// enrollment flows are L0: invite.create, enroll.confirm and rekey.confirm (rebind.confirm
// is in relay-rebind). The request side (invite spend, nonce, key insert, pending member)
// is L1 (src/relay/enroll.mjs); the fixture's applyEnrollmentRequest signs and applies a real
// request through it. Scratch databases, fixture keys.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMemberRecord, runSweep } from "../src/relay/board.mjs";
import { roleOf, INVITE_TTL_MS, ENROLLMENT_TTL_MS } from "../src/relay/governance.mjs";
import { exportRelay } from "../src/relay/signing.mjs";
import { setup, scratch, decision, ownerConfirm, createInvite, applyEnrollmentRequest, promoteC1, laneD0, taskArgs, rejects, LANE,
  T0, MIN, HOUR, DAY, createDecision, confirmOwnerRecord } from "./relay-fixtures.mjs";
import { readFileSync } from "node:fs";

const inviteArgs = (over = {}) => ({ kind: "enroll", member_id: null, intended_display_name: "new agent", intended_platform: "claude-cloud", ...over });
const inviteD0 = (fx, by, args, at = T0, subject = `req-${by}-${at}`) => createDecision(fx.db, decision(fx, by, { cls: "D0", action: "invite.create", subject, args, at }), at);
const status = (fx, id) => fx.db.prepare("SELECT status FROM members WHERE member_id = ?").get(id)?.status;
const keyStatus = (fx, key) => fx.db.prepare("SELECT status FROM keys WHERE public_key = ?").get(key).status;
const confirmD0 = (fx, by, action, subject, owner_line_ref, at = T0) =>
  createDecision(fx.db, decision(fx, by, { cls: "D0", action, subject, args: { owner_line_ref }, at }), at);

test("invite.create: the lane owner only; validated args; only the secret's hash is stored; the secret is returned once", () => {
  const { path } = scratch();
  const fx = setup({ path, members: [] });
  rejects(() => inviteD0(fx, "seat-2", inviteArgs()), "not the lane owner");
  rejects(() => inviteD0(fx, "seat-1", inviteArgs({ kind: "join" })), "args.kind");
  rejects(() => inviteD0(fx, "seat-1", inviteArgs({ member_id: "someone" })), "args.member_id");
  rejects(() => inviteD0(fx, "seat-1", inviteArgs({ intended_display_name: "x".repeat(65) })), "intended_display_name");
  rejects(() => inviteD0(fx, "seat-1", inviteArgs({ extra: 1 })), "unknown-field");
  rejects(() => inviteD0(fx, "seat-1", inviteArgs({ kind: "rekey", member_id: "nobody" })), "member not in lane");
  const d = inviteD0(fx, "seat-1", inviteArgs());
  assert.equal(d.state, "effective");
  const { invite } = d;
  assert.deepEqual(Object.keys(invite).sort(), ["expires_at", "invite_id", "kind", "member_id", "namespace", "secret"]);
  assert.match(invite.invite_id, /^[0-9a-f]{32}$/);
  assert.match(invite.secret, /^[0-9a-f]{64}$/);
  assert.deepEqual({ kind: invite.kind, member_id: invite.member_id, expires_at: invite.expires_at, namespace: invite.namespace },
    { kind: "enroll", member_id: null, expires_at: T0 + INVITE_TTL_MS, namespace: "agentnet" });
  const row = fx.db.prepare("SELECT * FROM invites WHERE invite_id = ?").get(invite.invite_id);
  assert.deepEqual({ created_by: row.created_by, expires_at: row.expires_at, voided_at: row.voided_at }, { created_by: "seat-1", expires_at: T0 + DAY, voided_at: null });
  assert.equal(fx.db.prepare("SELECT decision_id FROM invite_details WHERE invite_id = ?").get(invite.invite_id).decision_id, d.id);
  // Returned once: the secret is in no table, log or export, and not in the database file.
  const sinks = [JSON.stringify(exportRelay(fx.db)), JSON.stringify(fx.db.prepare("SELECT * FROM logs").all()), JSON.stringify(fx.db.prepare("SELECT * FROM alerts").all())];
  fx.db.close();
  sinks.push(readFileSync(path).toString("latin1"));
  const b64 = Buffer.from(invite.secret, "hex").toString("base64");
  for (const sink of sinks) for (const form of [invite.secret, invite.secret.toUpperCase(), b64]) assert.equal(sink.includes(form), false);
});

test("enroll.confirm (P1, M2): any AC seat but the invite creator, after the enrollment's owner line is confirmed and cited", () => {
  const fx = setup({ members: [] });
  const invite = createInvite(fx);
  const { memberId, identity, outbox } = applyEnrollmentRequest(fx, { invite, name: "N" });
  assert.equal(status(fx, memberId), "pending");
  rejects(() => confirmD0(fx, "seat-2", "enroll.confirm", memberId, outbox.id), "owner line not confirmed");
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", outbox, T0 + MIN), T0 + MIN);
  rejects(() => confirmD0(fx, "seat-1", "enroll.confirm", memberId, outbox.id, T0 + MIN), "confirmer-is-invite-creator");
  rejects(() => confirmD0(fx, "seat-2", "enroll.confirm", memberId, "o-something-else", T0 + MIN), "owner line not confirmed");
  rejects(() => confirmD0(fx, "verifier", "enroll.confirm", memberId, outbox.id, T0 + MIN), "forbidden");
  // seat-4 is not the lane owner: P1 confirmations need any one AC seat, not the lane owner.
  const d = confirmD0(fx, "seat-4", "enroll.confirm", memberId, outbox.id, T0 + MIN);
  assert.equal(d.state, "effective");
  assert.equal(status(fx, memberId), "active");
  assert.equal(keyStatus(fx, identity.publicKeyHex), "active");
  assert.equal(roleOf(fx.db, memberId), "C0");
  assert.deepEqual({ ...fx.db.prepare("SELECT confirmed_by, owner_line_ref FROM enrollments WHERE member_id = ?").get(memberId) }, { confirmed_by: "seat-4", owner_line_ref: outbox.id });
  assert.equal(fx.db.prepare("SELECT count(*) n FROM alerts WHERE kind = 'enrollment' AND subject = ?").get(memberId).n, 1);
  rejects(() => confirmD0(fx, "seat-5", "enroll.confirm", memberId, outbox.id, T0 + MIN), "member not pending");
  assert.equal(handleMemberRecord(fx.db, memberId, { type: "heartbeat", record_id: "first", body: {} }, T0 + 2 * MIN).kind, "heartbeat");
});

test("enroll.confirm refuses a voided invite and an enrollment older than 72 h", () => {
  const fx = setup({ members: [] });
  const late = applyEnrollmentRequest(fx, { invite: createInvite(fx), name: "L" });
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", late.outbox, T0), T0);
  rejects(() => confirmD0(fx, "seat-2", "enroll.confirm", late.memberId, late.outbox.id, T0 + ENROLLMENT_TTL_MS), "enrollment expired");
  assert.equal(confirmD0(fx, "seat-2", "enroll.confirm", late.memberId, late.outbox.id, T0 + ENROLLMENT_TTL_MS - 1).state, "effective");
  const voided = applyEnrollmentRequest(fx, { invite: createInvite(fx), name: "V" });
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", voided.outbox, T0), T0);
  fx.db.prepare("UPDATE invites SET voided_at = ? WHERE invite_id = (SELECT invite_id FROM enrollments WHERE member_id = ?)").run(T0, voided.memberId);
  rejects(() => confirmD0(fx, "seat-2", "enroll.confirm", voided.memberId, voided.outbox.id, T0), "invite voided");
});

test("rekey.confirm (5.4, RD2): the new key replaces the old one; refused while the member is suspended", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  const old = fx.members.A.identity.publicKeyHex;
  const invite = createInvite(fx, { kind: "rekey", member_id: A });
  assert.equal(invite.kind, "rekey");
  const { enrollment, identity, outbox } = applyEnrollmentRequest(fx, { invite, name: "A" });
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", outbox, T0), T0);
  rejects(() => confirmD0(fx, "seat-1", "rekey.confirm", enrollment, outbox.id), "confirmer-is-invite-creator");
  const d = confirmD0(fx, "seat-5", "rekey.confirm", enrollment, outbox.id);
  assert.equal(d.state, "effective");
  assert.deepEqual([keyStatus(fx, old), keyStatus(fx, identity.publicKeyHex)], ["revoked", "active"]);
  assert.equal(status(fx, A), "active");
  assert.equal(roleOf(fx.db, A), "C1", "a key change keeps standing");
  // A second re-key while suspended is refused at the invite (RD2).
  createDecision(fx.db, decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: A, at: T0 + MIN }), T0 + MIN);
  rejects(() => inviteD0(fx, "seat-1", inviteArgs({ kind: "rekey", member_id: A }), T0 + MIN), "re-key needs an active, unsuspended member");
});

test("a rebind invite suspends the member at once (C4): claims are released and only one re-bind is open at a time", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
  handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
  const invite = createInvite(fx, { kind: "rebind", member_id: A });
  assert.equal(status(fx, A), "suspended");
  assert.deepEqual({ ...fx.db.prepare("SELECT reason, invite_id FROM suspensions WHERE member_id = ? AND ended_at IS NULL").get(A) }, { reason: "rebind", invite_id: invite.invite_id });
  assert.equal(fx.db.prepare("SELECT status FROM tasks WHERE task_id = 't1'").get().status, "open");
  rejects(() => createInvite(fx, { kind: "rebind", member_id: A }), "rebind-attempt-live");   // the D items: one live attempt
  rejects(() => handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "h", body: {} }, T0 + MIN), "unauthorized");
  assert.equal(fx.db.prepare("SELECT kind FROM fleet_principals WHERE principal_id = ?").get("seat-1").kind, "ac-seat");
  assert.equal(LANE, fx.db.prepare("SELECT lane FROM invite_details WHERE invite_id = ?").get(invite.invite_id).lane);
});

test("5.3: the sweep expires an unconfirmed enrollment after 72 h; its key is revoked for ever and cannot be confirmed", () => {
  const fx = setup({ members: ["A"] });
  const r = applyEnrollmentRequest(fx, { invite: createInvite(fx), name: "E" });
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", r.outbox, T0), T0);
  runSweep(fx.db, T0 + ENROLLMENT_TTL_MS - 1);
  assert.equal(keyStatus(fx, r.identity.publicKeyHex), "pending");
  runSweep(fx.db, T0 + ENROLLMENT_TTL_MS);
  assert.equal(keyStatus(fx, r.identity.publicKeyHex), "revoked");
  assert.ok(fx.db.prepare("SELECT event FROM logs WHERE log = 'enrollment'").all().some(l => JSON.parse(l.event).kind === "enrollment.expired"));
  rejects(() => confirmD0(fx, "seat-2", "enroll.confirm", r.memberId, r.outbox.id, T0 + 1), "key not pending");
  // Addendum D2 (overriding the earlier L0 choice): the 72 h rule covers re-bind enrollments too; the
  // attempt is recorded dead and the member stays suspended (recovery is in relay-recovery.test.mjs).
  const rb = applyEnrollmentRequest(fx, { invite: createInvite(fx, { kind: "rebind", member_id: fx.members.A.id, at: T0 + 2 * DAY }), name: "A", at: T0 + 2 * DAY });
  runSweep(fx.db, T0 + 2 * DAY + ENROLLMENT_TTL_MS);
  assert.equal(keyStatus(fx, rb.identity.publicKeyHex), "revoked");
  assert.equal(fx.db.prepare("SELECT cause FROM rebind_ends r JOIN enrollments e USING(invite_id) WHERE e.id = ?").get(rb.enrollment).cause, "enrollment-expired");
  assert.equal(status(fx, fx.members.A.id), "suspended");
});
