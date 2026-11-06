// Cloud Commons relay, L0: opening a claim (spec v3.2 section 11.3). One path
// for a member's own claim, a lane owner's task.assign and the new claim a seat's
// "changes" issues, so epochs, leases and caps cannot drift between them.
// Call inside the caller's transaction.

import { randomUUID } from "node:crypto";
import { RelayError } from "./records.mjs";

export const LEASE_MAX_MS = 86400000;
export const CLAIM_CAPS = Object.freeze({ C0: 0, C1: 1, C2: 3, C3: 5 });

/** decisionId: the seat decision that opened the claim (task.assign, review.changes), recorded for its reversal (C3). */
export function openClaim(db, { taskId, memberId, role, leaseMs, now, decisionId = null }) {
  const live = db.prepare("SELECT count(*) n FROM claims WHERE member_id = ? AND state = 'live'").get(memberId).n;
  if (live >= (CLAIM_CAPS[role] ?? 0)) throw new RelayError("claim-cap", 409);
  const lease = Math.min(leaseMs ?? LEASE_MAX_MS, LEASE_MAX_MS);
  const epoch = (db.prepare("SELECT max(epoch) e FROM claims WHERE task_id = ?").get(taskId).e ?? 0) + 1;
  const claimId = randomUUID();
  db.prepare(`INSERT INTO claims(claim_id, task_id, member_id, epoch, state, lease_until, released_reason, released_at)
              VALUES (?, ?, ?, ?, 'live', ?, NULL, NULL)`).run(claimId, taskId, memberId, epoch, now + lease);
  db.prepare("INSERT INTO claim_details(claim_id, lease_ms, created_at) VALUES (?, ?, ?)").run(claimId, lease, now);
  if (decisionId) db.prepare("INSERT INTO claim_origins(claim_id, decision_id) VALUES (?, ?)").run(claimId, decisionId);
  db.prepare("UPDATE tasks SET status = 'claimed', updated_at = ? WHERE task_id = ?").run(now, taskId);
  return { task_id: taskId, claim_id: claimId, epoch, lease_until: now + lease };
}
