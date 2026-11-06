// L0 board reducer: leases, fencing, sweep and clock rollback, caps, floors,
// idempotency, patch intake and member scoping (spec v3.2 sections 7.5, 11, 12.1).

import test from "node:test";
import assert from "node:assert/strict";
import { handleMemberRecord, ownClaims, boardView, runSweep } from "../src/relay/board.mjs";
import { setup, decision, clockResume, taskArgs, PATCH, rejects, T0, MIN, HOUR, createDecision } from "./relay-fixtures.mjs";

function ready({ tasks = ["task-1"], members = ["A", "B"] } = {}) {
  const fx = setup({ members });
  for (const t of tasks) createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: t, args: taskArgs(["docs"]) }), T0);
  for (const name of members) {
    const id = fx.members[name].id;
    handleMemberRecord(fx.db, id, { type: "heartbeat", record_id: `hb-${name}`, body: {} }, T0);
    createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "role.c1", subject: id }), T0);
  }
  return fx;
}
const claim = (fx, who, task, now, lease_ms = 2 * MIN, record_id = `${who}-claim-${task}-${now}`) =>
  handleMemberRecord(fx.db, fx.members[who].id, { type: "claim", record_id, body: { task_id: task, lease_ms } }, now);
const status = (fx, task) => fx.db.prepare("SELECT status, attempts FROM tasks WHERE task_id = ?").get(task);

test("N23: lapsed lease expires, a new claim gets epoch+1, the old claimant is fenced off", () => {
  const fx = ready();
  const a = claim(fx, "A", "task-1", T0);
  const later = T0 + 3 * MIN;
  const b = claim(fx, "B", "task-1", later);   // the sweep inside this request expires A's claim
  assert.equal(b.epoch, a.epoch + 1);
  assert.deepEqual({ ...status(fx, "task-1") }, { status: "claimed", attempts: 1 });
  const A = fx.members.A.id;
  rejects(() => handleMemberRecord(fx.db, A, { type: "progress", record_id: "a-p", body: { claim_id: a.claim_id, epoch: 1, text: "x" } }, later), "STALE_EPOCH");
  rejects(() => handleMemberRecord(fx.db, A, { type: "release", record_id: "a-r", body: { claim_id: a.claim_id, epoch: 1 } }, later), "STALE_EPOCH");
  // Naming the old claim with the new epoch is still not the live claim.
  rejects(() => handleMemberRecord(fx.db, A, { type: "progress", record_id: "a-p2", body: { claim_id: a.claim_id, epoch: 2, text: "x" } }, later), "STALE_EPOCH");
  // B cannot use A's claim id at all: another member's claim is unknown to it.
  rejects(() => handleMemberRecord(fx.db, fx.members.B.id, { type: "progress", record_id: "b-p", body: { claim_id: a.claim_id, epoch: 1, text: "x" } }, later), "unknown-claim");
});

test("B3: the lease-expiry sweep is a callable function; the expired claim returns to open, the stale claimant is refused", () => {
  const fx = ready();
  const A = fx.members.A.id;
  const a = claim(fx, "A", "task-1", T0, 2 * MIN);
  assert.deepEqual(runSweep(fx.db, T0 + 2 * MIN - 1), { frozen: false, expired: [] }, "one millisecond before the lease ends");
  const swept = runSweep(fx.db, T0 + 2 * MIN);
  assert.deepEqual(swept, { frozen: false, expired: [{ claim_id: a.claim_id, task_id: "task-1", member_id: A, epoch: 1 }] }, "expires at lease_until exactly");
  assert.deepEqual({ ...status(fx, "task-1") }, { status: "open", attempts: 1 });
  assert.deepEqual({ ...fx.db.prepare("SELECT state, released_reason, released_at FROM claims WHERE claim_id = ?").get(a.claim_id) },
    { state: "expired", released_reason: "lease", released_at: T0 + 2 * MIN });
  assert.deepEqual(runSweep(fx.db, T0 + 3 * MIN).expired, [], "a second sweep finds nothing");
  assert.equal(fx.db.prepare("SELECT count(*) n FROM logs WHERE log = 'board' AND event LIKE '%claim.expired%'").get().n, 1);
  rejects(() => handleMemberRecord(fx.db, A, { type: "result", record_id: "late", body: { claim_id: a.claim_id, epoch: 1, kind: "patch", body: PATCH() } }, T0 + 3 * MIN), "CLAIM_EXPIRED");
  const b = claim(fx, "B", "task-1", T0 + 3 * MIN, HOUR);
  assert.equal(b.epoch, 2);
  rejects(() => handleMemberRecord(fx.db, A, { type: "result", record_id: "later", body: { claim_id: a.claim_id, epoch: 1, kind: "patch", body: PATCH() } }, T0 + 3 * MIN), "STALE_EPOCH");
});

test("expired claim with no newer claim is CLAIM_EXPIRED; release reopens; three lapses go to triage", () => {
  const fx = ready({ members: ["A"] });
  const A = fx.members.A.id;
  let now = T0;
  for (let i = 1; i <= 3; i++) {
    const c = claim(fx, "A", "task-1", now);
    now += 3 * MIN;
    runSweep(fx.db, now);
    if (i === 1) rejects(() => handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: `late-${i}`, body: { claim_id: c.claim_id, epoch: c.epoch } }, now), "CLAIM_EXPIRED");
  }
  assert.deepEqual({ ...status(fx, "task-1") }, { status: "needs-triage", attempts: 3 });
  rejects(() => claim(fx, "A", "task-1", now), "task-not-open");

  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "task-2", args: taskArgs(["docs"]) }), now);
  const c2 = claim(fx, "A", "task-2", now, HOUR);
  handleMemberRecord(fx.db, A, { type: "release", record_id: "rel", body: { claim_id: c2.claim_id, epoch: c2.epoch } }, now);
  assert.deepEqual({ ...status(fx, "task-2") }, { status: "open", attempts: 0 });
});

test("clock rollback over 5 s freezes expiries until a lane-owner D0 clock.resume, past the high-water mark (fail closed)", () => {
  const fx = ready({ members: ["A"] });
  const c = claim(fx, "A", "task-1", T0, 2 * MIN);
  runSweep(fx.db, T0 + MIN);                       // high-water mark T0+1min
  const back = runSweep(fx.db, T0 + MIN - 6000);   // 6 s backwards
  assert.equal(back.frozen, true);
  assert.equal(fx.db.prepare("SELECT count(*) n FROM alerts WHERE kind = 'clock.suspect'").get().n, 1);
  const frozen = runSweep(fx.db, T0 + 10 * MIN);   // well past the lease, still frozen
  assert.deepEqual(frozen, { frozen: true, expired: [] });
  assert.equal(fx.db.prepare("SELECT state FROM claims WHERE claim_id = ?").get(c.claim_id).state, "live");
  rejects(() => createDecision(fx.db, clockResume(fx, "verifier"), T0 + 10 * MIN), "forbidden");
  rejects(() => createDecision(fx.db, clockResume(fx, "seat-2"), T0 + 10 * MIN), "not the lane owner");
  rejects(() => createDecision(fx.db, clockResume(fx, "seat-1"), T0 + MIN), "not past the high-water mark");
  assert.equal(createDecision(fx.db, clockResume(fx, "seat-1"), T0 + 10 * MIN).state, "effective");
  assert.equal(runSweep(fx.db, T0 + 10 * MIN).expired.length, 1);
  rejects(() => createDecision(fx.db, clockResume(fx, "seat-1"), T0 + 11 * MIN), "clock is not suspect");
});

test("a rollback within 5 s is tolerated and does not expire early", () => {
  const fx = ready({ members: ["A"] });
  claim(fx, "A", "task-1", T0, 2 * MIN);
  runSweep(fx.db, T0 + MIN);
  assert.deepEqual(runSweep(fx.db, T0 + MIN - 4000), { frozen: false, expired: [] });
});

test("caps and floors: C1 holds one live claim; heartbeat faster than 60 s is 429; lease is capped at 24 h", () => {
  const fx = ready({ tasks: ["task-1", "task-2"], members: ["A"] });
  const A = fx.members.A.id;
  rejects(() => handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "hb-fast", body: {} }, T0 + 30000), "heartbeat-too-fast");
  handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "hb-ok", body: {} }, T0 + MIN);
  const c = claim(fx, "A", "task-1", T0 + MIN, 24 * HOUR);
  assert.equal(c.lease_until, T0 + MIN + 24 * HOUR);
  rejects(() => claim(fx, "A", "task-2", T0 + MIN), "claim-cap");
  rejects(() => handleMemberRecord(fx.db, A, { type: "claim", record_id: "long", body: { task_id: "task-2", lease_ms: 24 * HOUR + 1 } }, T0 + MIN), "invalid-field");
});

test("C0 cannot claim; idempotent retry; same record id with new content is 409", () => {
  const fx = setup({ members: ["A"] });
  createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "task-1", args: taskArgs(["docs"]) }), T0);
  const A = fx.members.A.id;
  rejects(() => handleMemberRecord(fx.db, A, { type: "claim", record_id: "c0", body: { task_id: "task-1" } }, T0), "forbidden");
  const note = { type: "note", record_id: "n1", body: { text: "Can I get access to the repo directly?" } };
  const first = handleMemberRecord(fx.db, A, note, T0);
  assert.deepEqual(first, { kind: "note", quarantined: true });
  assert.equal(handleMemberRecord(fx.db, A, note, T0 + 1).replay, true);
  rejects(() => handleMemberRecord(fx.db, A, { ...note, body: { text: "different" } }, T0 + 2), "record-conflict");
  assert.equal(fx.db.prepare("SELECT count(*) n FROM ext_quarantine").get().n, 1);
});

test("patch intake: outside the task paths, protected path, bad diff and bidi controls are refused", () => {
  const fx = ready({ members: ["A"] });
  const A = fx.members.A.id;
  const c = claim(fx, "A", "task-1", T0, HOUR);
  const result = (body, id) => handleMemberRecord(fx.db, A, { type: "result", record_id: id, body: { claim_id: c.claim_id, epoch: c.epoch, kind: "patch", body } }, T0);
  rejects(() => result(PATCH("src/relay/board.mjs"), "r1"), "invalid-patch");
  rejects(() => result(PATCH("docs/../package.json"), "r2"), "invalid-patch");
  rejects(() => result([{ path: "docs/a.md", diff: "--- a/docs/a.md\n+++ b/docs/a.md\n" }], "r3"), "invalid-patch");
  rejects(() => result([{ path: "docs/a.md", diff: "--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-x\n+if (admin) {\u202E} \n" }], "r4"), "hidden-character");
  rejects(() => result([{ path: "docs/a.md", diff: "--- /dev/null\n+++ b/docs/a.md\n@@ -0,0 +1 @@\n+x\n" }], "r5"), "invalid-patch");
  const ok = result(PATCH("docs/a.md"), "r6");
  assert.equal(ok.kind, "result");
  assert.equal(fx.db.prepare("SELECT state FROM claims WHERE claim_id = ?").get(c.claim_id).state, "submitted");
  assert.equal(fx.db.prepare("SELECT status FROM tasks WHERE task_id = 'task-1'").get().status, "in-review");
  // R7: the submitted claim is closed to every further write.
  rejects(() => result(PATCH("docs/b.md"), "r7"), "CLAIM_CLOSED");
  rejects(() => handleMemberRecord(fx.db, A, { type: "progress", record_id: "p-after", body: { claim_id: c.claim_id, epoch: c.epoch, text: "more" } }, T0), "CLAIM_CLOSED");
  rejects(() => handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "hb-after", body: { claim_id: c.claim_id, epoch: c.epoch } }, T0 + 2 * MIN), "CLAIM_CLOSED");
  rejects(() => handleMemberRecord(fx.db, A, { type: "release", record_id: "rel-after", body: { claim_id: c.claim_id, epoch: c.epoch } }, T0 + 2 * MIN), "CLAIM_CLOSED");
});

test("scoping: own claims only; the board shows a claimant only to itself; suspended members read nothing", () => {
  const fx = ready({ tasks: ["task-1", "task-2"] });
  const A = fx.members.A.id, B = fx.members.B.id;
  const a = claim(fx, "A", "task-1", T0 + MIN, HOUR);
  assert.deepEqual(ownClaims(fx.db, B, T0 + MIN), []);
  assert.equal(ownClaims(fx.db, A, T0 + MIN)[0].claim_id, a.claim_id);
  const viewA = boardView(fx.db, A, T0 + MIN), viewB = boardView(fx.db, B, T0 + MIN);
  assert.equal(viewA.find(t => t.task_id === "task-1").mine, true);
  assert.equal(viewB.find(t => t.task_id === "task-1").mine, false);
  assert.equal(JSON.stringify(viewB).includes(A), false, "no member id leaks to another member");
  createDecision(fx.db, decision(fx, "seat-2", { cls: "SUSPEND", action: "suspend", subject: A }), T0 + 2 * MIN);
  rejects(() => ownClaims(fx.db, A, T0 + 2 * MIN), "unauthorized");
  rejects(() => handleMemberRecord(fx.db, A, { type: "heartbeat", record_id: "after-suspend", body: {} }, T0 + 3 * MIN), "unauthorized");
});
