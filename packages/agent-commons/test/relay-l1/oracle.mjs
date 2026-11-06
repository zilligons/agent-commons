// L1 acceptance harness (13.2 "Final-state oracle"): read relay.db read-only and print the named facts
// as one JSON line. Runs where relay.db lives (the relay's container); it opens no listener.
// node test/relay-l1/oracle.mjs <relay*.db>
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p).map(r => ({ ...r }));
process.stdout.write(`${JSON.stringify({
  members: all("SELECT member_id, status, role FROM members ORDER BY member_id"),
  keys: all("SELECT principal_id, agent, status FROM keys WHERE principal_kind = 'member' ORDER BY added_at, agent"),
  enrollments: all("SELECT id, invite_id, kind, member_id, confirmed_by FROM enrollments ORDER BY spent_at, id"),
  invites: all("SELECT invite_id, kind, member_id, created_by, voided_at FROM invites ORDER BY created_at, invite_id"),
  rebind_ends: all("SELECT invite_id, cause FROM rebind_ends ORDER BY at"),
  claims: all("SELECT claim_id, task_id, member_id, epoch, state, lease_until FROM claims ORDER BY claim_id"),
  tasks: all("SELECT task_id, status, attempts FROM tasks ORDER BY task_id"),
  submissions: all("SELECT submission_id, member_id, state FROM submissions ORDER BY submission_id"),
  decisions: all("SELECT id, class, action, subject, state FROM decisions ORDER BY created_at, id"),
  approvals: all("SELECT decision_id, approver, seq, verdict FROM approvals ORDER BY signed_at, decision_id, approver, seq"),
  roles: all("SELECT member_id, seq, role FROM roles ORDER BY member_id, seq"),
  verify_results: all("SELECT submission_id, verifier, passed FROM verify_results ORDER BY at"),
  member_records: all("SELECT member_id, record_id, type FROM member_records ORDER BY at, record_id"),
  mailbox: all("SELECT member_id, seq, record_id, acked_at IS NOT NULL AS acked FROM mailbox ORDER BY member_id, seq"),
  alerts: all("SELECT kind, subject FROM alerts ORDER BY id"),
})}\n`);
db.close();
