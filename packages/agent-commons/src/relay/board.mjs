// Cloud Commons relay: work board reducer (spec v3.2 sections 11 and 12.1).
// Every member record runs in one transaction: freeze and status check,
// idempotency, sweep, permission check, handler, receipt. Only the relay clock
// decides lease expiry; nothing is replayed after expiry or suspension.

import { randomUUID } from "node:crypto";
import { tx, getMeta, setMeta } from "./schema.mjs";
import { openClaim, LEASE_MAX_MS, CLAIM_CAPS } from "./claims.mjs";
import { RelayError, validateMemberRecord } from "./records.mjs";
import { appendLog, sha256Hex, canonicalBytes } from "./signing.mjs";
import { roleOf, permits, isFrozen, expireInTx } from "./governance.mjs";
import { validatePatchPath, validateUnifiedDiff } from "../collaboration.mjs";
import { jcs } from "../pillar.mjs";

export { LEASE_MAX_MS, CLAIM_CAPS };
export const HEARTBEAT_FLOOR_MS = 60000;
export const CLOCK_ROLLBACK_MS = 5000;
export const SWEEP_INTERVAL_MS = 15000;
export const TRIAGE_ATTEMPTS = 3;

/**
 * Expire live claims whose lease has passed. If the relay clock went back by
 * more than 5 s, expiries freeze and stay frozen until an AC seat clears the
 * latch (fail closed). Call inside the caller's transaction.
 */
export function sweep(db, now) {
  // While frozen no lease expires (9.2 Freeze); unfreeze extends live leases by the frozen interval.
  if (isFrozen(db)) return { frozen: true, expired: [] };
  const highWater = Number(getMeta(db, "clock_high_water") ?? 0);
  if (getMeta(db, "clock_suspect") === "1") return { frozen: true, expired: [] };
  if (now < highWater - CLOCK_ROLLBACK_MS) {
    setMeta(db, "clock_suspect", "1");
    appendLog(db, "security", { kind: "clock.suspect", now, high_water: highWater }, highWater);
    db.prepare("INSERT INTO alerts(at, kind, subject, detail) VALUES (?, 'clock.suspect', NULL, ?)").run(highWater, jcs({ now, high_water: highWater }));
    return { frozen: true, expired: [] };
  }
  if (now > highWater) setMeta(db, "clock_high_water", String(now));
  // 5.3 and the D items (5.4): unconfirmed enrollments of all three kinds expire after 72 h (the
  // pending key is revoked for ever), and dead re-bind attempts are recorded. Never while frozen
  // or clock-suspect: the sweep has returned above.
  expireInTx(db, now);
  const expired = db.prepare("SELECT claim_id, task_id, member_id, epoch FROM claims WHERE state = 'live' AND lease_until <= ?").all(now);
  for (const c of expired) {
    db.prepare("UPDATE claims SET state = 'expired', released_at = ?, released_reason = 'lease' WHERE claim_id = ?").run(now, c.claim_id);
    const attempts = db.prepare("SELECT attempts FROM tasks WHERE task_id = ?").get(c.task_id).attempts + 1;
    db.prepare("UPDATE tasks SET attempts = ?, status = ?, updated_at = ? WHERE task_id = ?")
      .run(attempts, attempts >= TRIAGE_ATTEMPTS ? "needs-triage" : "open", now, c.task_id);
    appendLog(db, "board", { kind: "claim.expired", claim_id: c.claim_id, task_id: c.task_id, member_id: c.member_id, epoch: c.epoch, attempts }, now);
  }
  return { frozen: false, expired: expired.map(c => ({ ...c })) };
}

export const runSweep = (db, now) => tx(db, () => sweep(db, now));

/** Fencing (11.3): the named claim must be this member's live claim at this epoch. */
function liveClaim(db, member, claimId, epoch) {
  const c = db.prepare("SELECT c.*, d.lease_ms FROM claims c JOIN claim_details d USING(claim_id) WHERE c.claim_id = ?").get(claimId);
  // Another member's claim is indistinguishable from no claim.
  if (!c || c.member_id !== member.member_id) throw new RelayError("unknown-claim", 404);
  if (c.state === "live" && c.epoch === epoch) return c;
  // R7: a result closes its claim; nothing more may be written against it.
  if (c.state === "submitted") throw new RelayError("CLAIM_CLOSED", 409);
  const newest = db.prepare("SELECT max(epoch) e FROM claims WHERE task_id = ?").get(c.task_id).e;
  if (c.epoch !== epoch || newest > c.epoch) throw new RelayError("STALE_EPOCH", 409);
  throw new RelayError("CLAIM_EXPIRED", 409);
}

const HANDLERS = {
  heartbeat(db, m, role, rec, now) {
    if (m.last_heartbeat_at !== null && now - m.last_heartbeat_at < HEARTBEAT_FLOOR_MS) throw new RelayError("heartbeat-too-fast", 429);
    db.prepare("UPDATE member_profiles SET last_heartbeat_at = ?, first_heartbeat_at = coalesce(first_heartbeat_at, ?) WHERE member_id = ?").run(now, now, m.member_id);
    if (rec.body.claim_id === undefined) return { kind: "heartbeat", at: now };
    const c = liveClaim(db, m, rec.body.claim_id, rec.body.epoch);
    const leaseUntil = Math.max(c.lease_until, now + c.lease_ms);
    db.prepare("UPDATE claims SET lease_until = ? WHERE claim_id = ?").run(leaseUntil, c.claim_id);
    return { kind: "heartbeat", at: now, claim_id: c.claim_id, epoch: c.epoch, lease_until: leaseUntil };
  },

  message(db, m, role, rec, now) {
    if (rec.body.lane !== m.lane) throw new RelayError("forbidden", 403, "lane");
    const { lastInsertRowid } = db.prepare("INSERT INTO seat_feed(lane, member_id, record_id, type, body, at, state) VALUES (?, ?, ?, 'message', ?, ?, 'pending')")
      .run(m.lane, m.member_id, rec.record_id, jcs(rec.body), now);
    return { kind: "message", feed_id: Number(lastInsertRowid) };
  },

  note(db, m, role, rec, now) {
    db.prepare("INSERT INTO ext_quarantine(member_id, record_id, body, at) VALUES (?, ?, ?, ?)").run(m.member_id, rec.record_id, jcs(rec.body), now);
    return { kind: "note", quarantined: true };
  },

  claim(db, m, role, rec, now) {
    const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(rec.body.task_id);
    if (!task) throw new RelayError("unknown-task", 404);
    if (task.status === "claimed") throw new RelayError("CLAIM_HELD", 409);
    if (task.status !== "open") throw new RelayError("task-not-open", 409);
    return { kind: "claim", ...openClaim(db, { taskId: task.task_id, memberId: m.member_id, role, leaseMs: rec.body.lease_ms, now }) };
  },

  release(db, m, role, rec, now) {
    const c = liveClaim(db, m, rec.body.claim_id, rec.body.epoch);
    db.prepare("UPDATE claims SET state = 'released', released_at = ?, released_reason = 'member' WHERE claim_id = ?").run(now, c.claim_id);
    db.prepare("UPDATE tasks SET status = 'open', updated_at = ? WHERE task_id = ?").run(now, c.task_id);
    return { kind: "release", claim_id: c.claim_id, task_id: c.task_id };
  },

  progress(db, m, role, rec, now) {
    const c = liveClaim(db, m, rec.body.claim_id, rec.body.epoch);
    db.prepare("INSERT INTO progress(member_id, record_id, claim_id, text, at) VALUES (?, ?, ?, ?, ?)").run(m.member_id, rec.record_id, c.claim_id, rec.body.text, now);
    return { kind: "progress", claim_id: c.claim_id, epoch: c.epoch };
  },

  result(db, m, role, rec, now) {
    const c = liveClaim(db, m, rec.body.claim_id, rec.body.epoch);
    const task = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(c.task_id);
    let stored;
    if (rec.body.kind === "patch") {
      const allowed = JSON.parse(task.paths);
      for (const file of rec.body.body) {
        try {
          const path = validatePatchPath(file.path, allowed);
          if (path !== file.path) throw new Error("path is not in normal form");
          validateUnifiedDiff(file.path, file.diff);
        } catch (error) {
          throw new RelayError("invalid-patch", 422, String(error?.message ?? error).slice(0, 200));
        }
      }
      stored = jcs(rec.body.body);
    } else stored = rec.body.body;
    const submissionId = randomUUID(), sha = sha256Hex(stored);
    db.prepare("INSERT INTO submissions(submission_id, member_id, state) VALUES (?, ?, 'in-review')").run(submissionId, m.member_id);
    db.prepare(`INSERT INTO submission_details(submission_id, task_id, claim_id, epoch, kind, body, body_sha256, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(submissionId, c.task_id, c.claim_id, c.epoch, rec.body.kind, stored, sha, now);
    db.prepare("UPDATE claims SET state = 'submitted', released_at = ?, released_reason = 'submitted' WHERE claim_id = ?").run(now, c.claim_id);
    db.prepare("UPDATE tasks SET status = 'in-review', updated_at = ? WHERE task_id = ?").run(now, c.task_id);
    return { kind: "result", submission_id: submissionId, task_id: c.task_id, body_sha256: sha };
  },

  evidence(db, m, role, rec, now) {
    const s = db.prepare("SELECT member_id, state FROM submissions WHERE submission_id = ?").get(rec.body.submission_id);
    if (!s || s.member_id !== m.member_id) throw new RelayError("unknown-submission", 404);
    db.prepare("INSERT INTO evidence(member_id, record_id, submission_id, kind, text, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(m.member_id, rec.record_id, rec.body.submission_id, rec.body.kind, rec.body.text, now);
    // Advisory only: evidence is context for reviewers and never counts toward D1.
    return { kind: "evidence", submission_id: rec.body.submission_id, advisory: true };
  },

  "review-request"(db, m, role, rec, now) {
    const s = db.prepare("SELECT member_id FROM submissions WHERE submission_id = ?").get(rec.body.submission_id);
    if (!s || s.member_id !== m.member_id) throw new RelayError("unknown-submission", 404);
    db.prepare("INSERT INTO seat_feed(lane, member_id, record_id, type, body, at, state) VALUES (?, ?, ?, 'review-request', ?, ?, 'pending')")
      .run(m.lane, m.member_id, rec.record_id, jcs(rec.body), now);
    return { kind: "review-request", submission_id: rec.body.submission_id };
  },

  propose(db, m, role, rec, now) {
    // A proposal is a request to seats. A D0 task.open by the lane owner opens it as a task (R4).
    db.prepare("INSERT INTO seat_feed(lane, member_id, record_id, type, body, at, state) VALUES (?, ?, ?, 'propose', ?, ?, 'pending')")
      .run(rec.body.lane, m.member_id, rec.record_id, jcs(rec.body), now);
    return { kind: "propose", queued: true };
  },

  "advisory-review"(db, m, role, rec, now) {
    db.prepare("INSERT INTO seat_feed(lane, member_id, record_id, type, body, at, state) VALUES (?, ?, ?, 'advisory-review', ?, ?, 'pending')")
      .run(m.lane, m.member_id, rec.record_id, jcs(rec.body), now);
    return { kind: "advisory-review", counts: false };
  },
};

function activeMember(db, memberId) {
  const m = db.prepare(`SELECT m.member_id, m.status, m.role, p.display_name, p.platform, p.lane, p.first_heartbeat_at, p.last_heartbeat_at
                          FROM members m JOIN member_profiles p USING(member_id) WHERE m.member_id = ?`).get(memberId);
  // Status is read from the table inside the write transaction, every time (M3).
  if (!m || m.status !== "active") throw new RelayError("unauthorized", 401);
  return m;
}

/**
 * Apply one member record. `memberId` is the authenticated member: request
 * verification supplies it in the server, and a test supplies it directly.
 */
export function handleMemberRecord(db, memberId, record, now) {
  const rec = validateMemberRecord(record);
  const sha = sha256Hex(canonicalBytes(rec));
  return tx(db, () => {
    if (isFrozen(db)) throw new RelayError("frozen", 503);
    const m = activeMember(db, memberId);
    const prior = db.prepare("SELECT record_sha256, receipt FROM member_records WHERE member_id = ? AND record_id = ?").get(memberId, rec.record_id);
    if (prior) {
      if (prior.record_sha256 !== sha) throw new RelayError("record-conflict", 409);
      return { ...JSON.parse(prior.receipt), replay: true };
    }
    sweep(db, now);
    const role = roleOf(db, memberId);
    if (!permits("member", role, rec.type)) throw new RelayError("forbidden", 403, rec.type);
    const receipt = HANDLERS[rec.type](db, m, role, rec, now);
    db.prepare("INSERT INTO member_records(member_id, record_id, type, record_sha256, receipt, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(memberId, rec.record_id, rec.type, sha, jcs(receipt), now);
    appendLog(db, "board", { kind: `member.${rec.type}`, member_id: memberId, record_id: rec.record_id, record_sha256: sha }, now);
    return receipt;
  });
}

/** The member's own live claims (B8): task, claim id, epoch, lease. */
export function ownClaims(db, memberId, now) {
  return tx(db, () => {
    activeMember(db, memberId);
    sweep(db, now);
    return db.prepare(`SELECT c.task_id, c.claim_id, c.epoch, c.lease_until FROM claims c JOIN claim_details d USING(claim_id)
                        WHERE c.member_id = ? AND c.state = 'live' ORDER BY d.created_at, c.claim_id`).all(memberId).map(r => ({ ...r }));
  });
}

/** Member board view (7.5): status only; a claimant is shown only to itself. */
export function boardView(db, memberId, now) {
  return tx(db, () => {
    activeMember(db, memberId);
    sweep(db, now);
    return db.prepare(`SELECT t.task_id, t.title, t.lane, t.kind, t.status, t.base_commit,
                              EXISTS (SELECT 1 FROM claims c WHERE c.task_id = t.task_id AND c.state = 'live' AND c.member_id = ?) AS mine
                         FROM tasks t WHERE t.status IN ('open','claimed','in-review','held') ORDER BY t.created_at`)
      .all(memberId).map(r => ({ ...r, mine: r.mine === 1 }));
  });
}
