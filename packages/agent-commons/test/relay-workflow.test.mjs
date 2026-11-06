// L0 end-to-end workflow on a scratch relay.db file, across two restarts:
// task, claim with lease, progress, restart recovery, acknowledged-mailbox
// resume, stale claimant rejection, result, evidence, persisted D1 decision.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openRelayDb } from "../src/relay/schema.mjs";
import { handleMemberRecord, ownClaims, runSweep } from "../src/relay/board.mjs";
import { roleOf } from "../src/relay/governance.mjs";
import { readInbox, ackInbox, relayEpoch } from "../src/relay/mailbox.mjs";
import { sendSeatMessage } from "../src/relay/governance.mjs";
import { exportRelay, verifyExport } from "../src/relay/signing.mjs";
import { setup, scratch, decision, approval, verifyResult, ownerConfirm, seatMessage, taskArgs, PATCH, outboxFor, rejects, keySeedHex, T0, MIN, HOUR, LANE, createDecision, addApproval, recordVerifyResult, confirmOwnerRecord } from "./relay-fixtures.mjs";

test("L0 workflow: claim, progress, restart, resume, stale claimant refused, result, evidence, D1 persisted", () => {
  const { path } = scratch();
  let fx = setup({ path });
  const A = fx.members.A.id, B = fx.members.B.id;
  const roster = fx.files.roster.body.principals;   // the owner-signed roster the verifier trusts, never the relay's copy
  let now = T0;

  // A lane-owner seat opens the task (D0, effective at once).
  const open = createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "task-1", args: taskArgs(["docs/"]) }), now);
  assert.equal(open.state, "effective");

  // Both members heartbeat, then the lane owner grants C1 (D0, after the first heartbeat).
  for (const [name, id] of [["A", A], ["B", B]]) {
    rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "role.c1", subject: id }), now), "not-eligible");
    handleMemberRecord(fx.db, id, { type: "heartbeat", record_id: `hb0-${name}`, body: {} }, now);
    assert.equal(createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "role.c1", subject: id }), now).state, "effective");
    assert.equal(roleOf(fx.db, id), "C1");
  }

  // A claims with a 2 h lease; B cannot claim the same task.
  const claim = handleMemberRecord(fx.db, A, { type: "claim", record_id: "a-claim", body: { task_id: "task-1", lease_ms: 2 * HOUR } }, now);
  assert.equal(claim.epoch, 1);
  rejects(() => handleMemberRecord(fx.db, B, { type: "claim", record_id: "b-claim", body: { task_id: "task-1" } }, now), "CLAIM_HELD");
  const progressRecord = { type: "progress", record_id: "a-progress-1", body: { claim_id: claim.claim_id, epoch: 1, text: "Drafted steps 1-3." } };
  handleMemberRecord(fx.db, A, progressRecord, now);

  // The lane seat sends two messages; A reads both and acknowledges only the first.
  sendSeatMessage(fx.db, seatMessage(fx, "seat-1", A, "Please also cover the epoch reset."), now);
  sendSeatMessage(fx.db, seatMessage(fx, "seat-1", A, "Second note: keep it short."), now);
  const page1 = readInbox(fx.db, A, {}, now);
  assert.deepEqual(page1.records.map(r => r.seq), [1, 2]);
  ackInbox(fx.db, A, 1, now);
  const epochBefore = relayEpoch(fx.db);

  // --- restart 1: close the database, reopen the same file -----------------
  fx.db.close();
  fx = { ...fx, db: openRelayDb(path) };
  now += 30 * MIN;

  assert.equal(relayEpoch(fx.db), epochBefore, "epoch survives restart");
  assert.deepEqual(ownClaims(fx.db, A, now), [{ task_id: "task-1", claim_id: claim.claim_id, epoch: 1, lease_until: T0 + 2 * HOUR }]);
  // A lost its cursor: a read without `after` resumes after the last ack (B8): only seq 2.
  const resumed = readInbox(fx.db, A, {}, now);
  assert.deepEqual(resumed.records.map(r => r.seq), [2]);
  assert.equal(resumed.records[0].body.text, "Second note: keep it short.");
  ackInbox(fx.db, A, 2, now);
  assert.deepEqual(readInbox(fx.db, A, {}, now).records, []);
  // A retried record returns the original receipt; changed content under the same id is refused.
  assert.equal(handleMemberRecord(fx.db, A, progressRecord, now).replay, true);
  rejects(() => handleMemberRecord(fx.db, A, { ...progressRecord, body: { ...progressRecord.body, text: "changed" } }, now), "record-conflict");
  // Heartbeat renews the same claim, same id and epoch.
  const hb = handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "a-hb-1", body: { claim_id: claim.claim_id, epoch: 1 } }, now);
  assert.equal(hb.lease_until, now + 2 * HOUR);

  // --- stale claimant: A goes quiet past its lease; B takes the task at epoch 2 ---
  now += 3 * HOUR;
  const swept = runSweep(fx.db, now);
  assert.equal(swept.expired.length, 1);
  rejects(() => handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "a-hb-late", body: { claim_id: claim.claim_id, epoch: 1 } }, now), "CLAIM_EXPIRED");
  const claimB = handleMemberRecord(fx.db, B, { type: "claim", record_id: "b-claim-2", body: { task_id: "task-1", lease_ms: 2 * HOUR } }, now);
  assert.equal(claimB.epoch, 2);
  rejects(() => handleMemberRecord(fx.db, A, { type: "result", record_id: "a-late-result", body: { claim_id: claim.claim_id, epoch: 1, kind: "patch", body: PATCH() } }, now), "STALE_EPOCH");
  assert.equal(fx.db.prepare("SELECT attempts FROM tasks WHERE task_id = 'task-1'").get().attempts, 1);

  // B completes: progress, patch result, advisory evidence.
  handleMemberRecord(fx.db, B, { type: "progress", record_id: "b-progress", body: { claim_id: claimB.claim_id, epoch: 2, text: "Patch ready." } }, now);
  const result = handleMemberRecord(fx.db, B, { type: "result", record_id: "b-result", body: { claim_id: claimB.claim_id, epoch: 2, kind: "patch", body: PATCH("docs/relay.md") } }, now);
  handleMemberRecord(fx.db, B, { type: "evidence", record_id: "b-evidence", body: { submission_id: result.submission_id, kind: "test-log", text: "npm test: 0 failures (agent-reported)." } }, now);

  // D1: lane owner (anthropic) + a second seat (openai) + a passing verification re-run.
  const accept = createDecision(fx.db, decision(fx, "seat-1", { cls: "D1", action: "accept", subject: result.submission_id }), now);
  assert.equal(accept.state, "pending");
  assert.equal(addApproval(fx.db, approval(fx, "seat-2", accept.id), now).state, "pending", "evidence alone never accepts");
  recordVerifyResult(fx.db, verifyResult(fx, { submission_id: result.submission_id, patch_sha256: result.body_sha256 }), now);
  assert.equal(fx.db.prepare("SELECT state FROM decisions WHERE id = ?").get(accept.id).state, "effective");
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-3", outboxFor(fx.db, accept.id)), now);

  // --- restart 2: the decision and its effects persist and verify offline -------
  fx.db.close();
  fx = { ...fx, db: openRelayDb(path) };
  const d = fx.db.prepare("SELECT state, owner_posted_at, body FROM decisions WHERE id = ?").get(accept.id);
  assert.deepEqual([d.state, d.owner_posted_at, JSON.parse(d.body).by], ["effective", now, "seat-1"]);
  assert.equal(fx.db.prepare("SELECT state FROM submissions WHERE submission_id = ?").get(result.submission_id).state, "accepted");
  assert.equal(fx.db.prepare("SELECT status FROM tasks WHERE task_id = 'task-1'").get().status, "accepted");
  assert.equal(fx.db.prepare("SELECT count(*) n FROM contributions WHERE member_id = ?").get(B).n, 1);
  const exp = exportRelay(fx.db);
  assert.deepEqual(verifyExport(exp, roster), { ok: true, problems: [] });

  // A tampered decision body fails offline verification.
  const tampered = structuredClone(exp);
  const row = tampered.decisions.find(x => x.id === accept.id);
  row.body = row.body.replace(result.submission_id, "someone-else");
  assert.equal(verifyExport(tampered, roster).ok, false);

  // Custody (N22, L0 part): no fixture key seed appears in the database files or the export.
  const seeds = [...Object.values(fx.keys), fx.members.A.identity, fx.members.B.identity].map(keySeedHex);
  fx.db.close();
  const haystack = [readFileSync(path), ...["-wal", "-shm"].map(s => { try { return readFileSync(path + s); } catch { return Buffer.alloc(0); } }), Buffer.from(JSON.stringify(exp))];
  for (const seed of seeds) for (const form of [seed, Buffer.from(seed, "hex"), Buffer.from(seed, "hex").toString("base64"), Buffer.from(seed, "hex").toString("base64url")])
    for (const hay of haystack) assert.equal(hay.includes(form), false, "key seed leaked");
  assert.equal(LANE, "relay-core");
});
