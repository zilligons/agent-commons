// L0 two-connection races (spec v3.2 sections 9.3, 11.3; review item "competing
// claims and conflicting decisions"). Each case starts two worker threads, each
// with its own connection to one scratch relay*.db file, releases them together
// from a barrier, and checks the invariant that must hold whichever commits first.
// Every case runs several free rounds on fresh databases, then both orders forced,
// each on its own connection; the observed outcomes are reported as diagnostics.

import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { handleMemberRecord } from "../src/relay/board.mjs";
import { setup, scratch, decision, approval, coauthor, ownerConfirm, outboxFor, taskArgs, PATCH, laneD0, promoteC1, eligibleForC2,
  T0, HOUR, DAY, createDecision, addVerdict, confirmOwnerRecord } from "./relay-fixtures.mjs";

const WORKER = new URL("./relay-race-worker.mjs", import.meta.url);
const ROUNDS = 3;

function runWorker(path, barrier, parties, job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { path, barrier, parties, ...job } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => { if (code !== 0) reject(new Error(`race worker exited ${code}`)); });
  });
}

/** Run the jobs at once, one worker and one connection each; resolve to their outcomes in job order. */
function race(path, jobs) {
  const barrier = new SharedArrayBuffer(4);
  return Promise.all(jobs.map(job => runWorker(path, barrier, jobs.length, job)));
}

/** The same jobs, each on its own connection, one after another in a fixed order (outcomes still in job order). */
const inOrder = (order) => async (path, jobs) => {
  const out = [];
  for (const i of order) out[i] = await runWorker(path, new SharedArrayBuffer(4), 1, jobs[i]);
  return out;
};

/** A fresh file-backed relay for one round. */
const fresh = (members = ["A", "B"]) => setup({ path: scratch().path, members });
const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const all = (db, sql, ...args) => db.prepare(sql).all(...args).map(r => ({ ...r }));
const label = (outcomes) => outcomes.map(o => (o.ok ? "ok" : o.code)).join(" / ");

/**
 * ROUNDS free races, then both forced orders, so each branch of a case's invariant
 * is checked even when the scheduler always lets the same side win.
 */
async function rounds(t, fn) {
  const seen = new Map();
  const runs = [...Array.from({ length: ROUNDS }, () => ["race", race]), ["first-then-second", inOrder([0, 1])], ["second-then-first", inOrder([1, 0])]];
  for (const [kind, run] of runs) {
    const key = `${kind}: ${await fn(run)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  t.diagnostic(`outcomes: ${[...seen].map(([k, n]) => `${k} x${n}`).join("; ")}`);
}

test("competing claims: two members claim one open task; exactly one live claim at epoch 1, the other gets CLAIM_HELD", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh();
    const A = promoteC1(fx, "A"), B = promoteC1(fx, "B");
    laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
    const out = await run(fx.path, [A, B].map((memberId, i) =>
      ({ op: "member", args: { memberId, record: { type: "claim", record_id: `c${i}`, body: { task_id: "t1", lease_ms: HOUR } }, now: T0 + 1 } })));
    assert.equal(out.filter(o => o.ok).length, 1, label(out));
    assert.equal(out.find(o => !o.ok).code, "CLAIM_HELD", label(out));
    const claims = all(fx.db, "SELECT member_id, epoch, state FROM claims WHERE task_id = 't1'");
    assert.equal(claims.length, 1);
    assert.deepEqual({ epoch: claims[0].epoch, state: claims[0].state }, { epoch: 1, state: "live" });
    assert.equal(claims[0].member_id, out[0].ok ? A : B, "the live claim belongs to the winner");
    assert.equal(one(fx.db, "SELECT count(*) n FROM member_records WHERE type = 'claim'").n, 1, "the loser left no record behind");
    fx.db.close();
    return out[0].ok ? "A won" : "B won";
  });
});

test("competing claims: one C1 member claims two tasks on two connections; the cap of one holds", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh(["A"]);
    const A = promoteC1(fx, "A");
    for (const id of ["t1", "t2"]) laneD0(fx, "task.open", id, taskArgs(["docs"]));
    const out = await run(fx.path, ["t1", "t2"].map(task_id =>
      ({ op: "member", args: { memberId: A, record: { type: "claim", record_id: `c-${task_id}`, body: { task_id, lease_ms: HOUR } }, now: T0 + 1 } })));
    assert.equal(out.filter(o => o.ok).length, 1, label(out));
    assert.equal(out.find(o => !o.ok).code, "claim-cap", label(out));
    assert.equal(one(fx.db, "SELECT count(*) n FROM claims WHERE member_id = ? AND state = 'live'", A).n, 1);
    assert.equal(one(fx.db, "SELECT count(*) n FROM tasks WHERE status = 'claimed'").n, 1, "the losing task stayed open");
    fx.db.close();
    return label(out);
  });
});

test("conflicting decisions: task.assign of one task to two members; one takes effect, the other is refused", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh();
    const A = promoteC1(fx, "A"), B = promoteC1(fx, "B");
    laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
    const out = await run(fx.path, [A, B].map(member_id =>
      ({ op: "decision", args: { signed: decision(fx, "seat-1", { cls: "D0", action: "task.assign", subject: "t1", args: { member_id } }), now: T0 + 1 } })));
    assert.equal(out.filter(o => o.ok).length, 1, label(out));
    assert.equal(out.find(o => o.ok).result.state, "effective");
    assert.match(out.find(o => !o.ok).message, /task not open/);
    assert.equal(one(fx.db, "SELECT count(*) n FROM decisions WHERE action = 'task.assign'").n, 1, "the refused decision was not recorded");
    const live = all(fx.db, "SELECT member_id FROM claims WHERE task_id = 't1' AND state = 'live'");
    assert.deepEqual(live, [{ member_id: out[0].ok ? A : B }]);
    fx.db.close();
    return out[0].ok ? "to A" : "to B";
  });
});

test("conflicting decisions: the same signed decision on two connections is recorded once", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh([]);
    const signed = decision(fx, "seat-1", { cls: "D0", action: "task.open", subject: "t1", args: taskArgs(["docs"]) });
    const out = await run(fx.path, [0, 1].map(() => ({ op: "decision", args: { signed, now: T0 + 1 } })));
    assert.equal(out.filter(o => o.ok).length, 1, label(out));
    assert.ok(["duplicate-decision", "invalid-state"].includes(out.find(o => !o.ok).code), label(out));
    assert.equal(one(fx.db, "SELECT count(*) n FROM decisions WHERE id = ?", signed.body.id).n, 1);
    assert.equal(one(fx.db, "SELECT count(*) n FROM tasks").n, 1);
    fx.db.close();
    return label(out);
  });
});

test("conflicting decisions: review.changes and review.reject on one submission; exactly one outcome, state consistent with it", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh(["A"]);
    const A = promoteC1(fx, "A");
    laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
    const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
    const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: 1, kind: "patch", body: PATCH() } }, T0);
    const out = await run(fx.path, [
      { op: "decision", args: { signed: decision(fx, "seat-1", { cls: "D0", action: "review.changes", subject: r.submission_id, args: {} }), now: T0 + 1 } },
      { op: "decision", args: { signed: decision(fx, "seat-1", { cls: "D0", action: "review.reject", subject: r.submission_id, args: { disposition: "reopen" } }), now: T0 + 1 } },
    ]);
    assert.equal(out.filter(o => o.ok).length, 1, label(out));
    assert.match(out.find(o => !o.ok).message, /submission not in review/);
    const sub = one(fx.db, "SELECT state FROM submissions WHERE submission_id = ?", r.submission_id).state;
    const task = { ...one(fx.db, "SELECT status, attempts FROM tasks WHERE task_id = 't1'") };
    const live = all(fx.db, "SELECT epoch FROM claims WHERE task_id = 't1' AND state = 'live'");
    if (out[0].ok) {
      assert.equal(sub, "changes");
      assert.deepEqual({ task, live }, { task: { status: "claimed", attempts: 0 }, live: [{ epoch: 2 }] });
    } else {
      assert.equal(sub, "rejected");
      assert.deepEqual({ task, live }, { task: { status: "open", attempts: 1 }, live: [] });
    }
    fx.db.close();
    return out[0].ok ? "changes" : "reject";
  });
});

test("objection vs D2 effect: a committed objection and an effective D2 never coexist", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh(["A"]);
    const A = promoteC1(fx, "A");
    eligibleForC2(fx, "A");
    const now = T0 + 3 * DAY;
    const d2 = laneD2(fx, A, now);
    const at = now + DAY;
    const out = await run(fx.path, [
      { op: "verdict", args: { signed: approval(fx, "seat-6", d2.id, "object", at), now: at } },
      { op: "settle", args: { now: at } },
    ]);
    assert.ok(out[1].ok, label(out));
    const state = one(fx.db, "SELECT state FROM decisions WHERE id = ?", d2.id).state;
    const objected = one(fx.db, "SELECT count(*) n FROM approvals WHERE decision_id = ? AND verdict = 'object'", d2.id).n;
    const role = one(fx.db, "SELECT role FROM members WHERE member_id = ?", A).role;
    if (out[0].ok) assert.deepEqual({ state, objected, role }, { state: "pending", objected: 1, role: "C1" }, "the objection came first and holds the D2");
    else {
      assert.equal(out[0].code, "decision-closed", label(out));
      assert.deepEqual({ state, objected, role }, { state: "effective", objected: 0, role: "C2" }, "the D2 took effect first; the late objection was refused");
    }
    fx.db.close();
    return out[0].ok ? "objection first" : "effect first";
  });
});

test("suspension vs claim: whichever commits first, the suspended member holds no live claim and the task is open", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh(["A"]);
    const A = promoteC1(fx, "A");
    laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
    const out = await run(fx.path, [
      { op: "decision", args: { signed: decision(fx, "security", { cls: "SUSPEND", action: "suspend", subject: A }), now: T0 + 1 } },
      { op: "member", args: { memberId: A, record: { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, now: T0 + 1 } },
    ]);
    assert.ok(out[0].ok && out[0].result.state === "effective", label(out));
    if (!out[1].ok) assert.equal(out[1].code, "unauthorized", label(out));
    assert.equal(one(fx.db, "SELECT status FROM members WHERE member_id = ?", A).status, "suspended");
    assert.equal(one(fx.db, "SELECT count(*) n FROM claims WHERE member_id = ? AND state = 'live'", A).n, 0);
    assert.equal(one(fx.db, "SELECT status FROM tasks WHERE task_id = 't1'").status, "open");
    fx.db.close();
    return out[1].ok ? "claim first, then released" : "suspension first, claim refused";
  });
});

test("co-author declaration vs accept: the lane owner cannot both co-author a submission and open its accept", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh(["A"]);
    const A = promoteC1(fx, "A");
    laneD0(fx, "task.open", "t1", taskArgs(["docs"]));
    const c = handleMemberRecord(fx.db, A, { type: "claim", record_id: "c", body: { task_id: "t1", lease_ms: HOUR } }, T0);
    const r = handleMemberRecord(fx.db, A, { type: "result", record_id: "r", body: { claim_id: c.claim_id, epoch: 1, kind: "report", body: "done" } }, T0);
    const out = await run(fx.path, [
      { op: "coauthor", args: { signed: coauthor(fx, "seat-1", r.submission_id), now: T0 + 1 } },
      { op: "decision", args: { signed: decision(fx, "seat-1", { cls: "D1", action: "accept", subject: r.submission_id }), now: T0 + 1 } },
    ]);
    assert.equal(out.filter(o => o.ok).length, 1, label(out));
    const coauthors = one(fx.db, "SELECT count(*) n FROM coauthors WHERE submission_id = ?", r.submission_id).n;
    const decisions = one(fx.db, "SELECT count(*) n FROM decisions WHERE subject = ?", r.submission_id).n;
    if (out[0].ok) {
      assert.equal(out[1].code, "author-cannot-approve", label(out));
      assert.deepEqual({ coauthors, decisions }, { coauthors: 1, decisions: 0 });
    } else {
      assert.equal(out[0].code, "coauthors-closed", label(out));
      assert.deepEqual({ coauthors, decisions }, { coauthors: 0, decisions: 1 });
    }
    fx.db.close();
    return out[0].ok ? "declaration first" : "accept first";
  });
});

test("concurrent verdicts (verifier finding B1): one seat's two verdicts signed for the same position; exactly one commits, the chain stays 1..n", async (t) => {
  await rounds(t, async (run) => {
    const fx = fresh(["A"]);
    const A = promoteC1(fx, "A");
    const d2 = createDecision(fx.db, decision(fx, "seat-2", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-2", args: { role: "C0" }, at: T0 + 1 }), T0 + 1);
    addVerdict(fx.db, approval(fx, "seat-3", d2.id, "approve", T0 + 1), T0 + 1);
    // Both are signed at seat-3's next position (seq 2) before either is sent; a third seat votes at the same time.
    const out = await run(fx.path, [
      { op: "verdict", args: { signed: approval(fx, "seat-3", d2.id, "withdraw", T0 + 2), now: T0 + 2 } },
      { op: "verdict", args: { signed: approval(fx, "seat-3", d2.id, "object", T0 + 2), now: T0 + 2 } },
    ]);
    const third = await run(fx.path, [{ op: "verdict", args: { signed: approval(fx, "seat-4", d2.id, "approve", T0 + 2), now: T0 + 2 } }]);
    assert.equal(out.filter(o => o.ok).length, 1, label(out));
    assert.equal(out.find(o => !o.ok).code, "approval-seq", label(out));
    assert.ok(third[0].ok, "another seat's verdict is independent");
    const rows = all(fx.db, "SELECT seq, verdict FROM approvals WHERE decision_id = ? AND approver = 'seat-3' ORDER BY seq", d2.id);
    assert.deepEqual(rows, [{ seq: 1, verdict: "approve" }, { seq: 2, verdict: out[0].ok ? "withdraw" : "object" }]);
    fx.db.close();
    return out[0].ok ? "withdraw won" : "object won";
  });
});

test("N6: two processes opening one fresh relay.db create the schema once, under an exclusive lock", async (t) => {
  await rounds(t, async (run) => {
    const { path } = scratch();
    const out = await run(path, [{ op: "open" }, { op: "open" }]);
    assert.ok(out.every(o => o.ok), label(out));
    assert.deepEqual(out[0].result, out[1].result, "both see one schema_version and one epoch");
    const meta = Object.fromEntries(out[0].result.map(r => [r.k, r.v]));
    assert.equal(meta.schema_version, "9");
    assert.match(meta.epoch, /^[0-9a-f]{32}$/);
    return "both opened";
  });
});

/** A D2 promoting `member` to C2: sponsor seat-1, three measured approvals on three families, owner post confirmed. */
function laneD2(fx, member, now) {
  const d2 = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: member, sponsor: "seat-1", args: { role: "C2" }, at: now }), now);
  for (const seat of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, d2.id, "approve", now), now);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-7", outboxFor(fx.db, d2.id), now), now);
  return d2;
}
