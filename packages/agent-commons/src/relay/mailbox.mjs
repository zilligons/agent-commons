// Cloud Commons relay: store-and-forward mailbox core (spec v3.2 sections
// 11.5 and 7.6). Each record for a member gets a per-member seq that is never
// reused. A read without a cursor resumes after the member's last ack, so a
// client that lost its state gets exactly what it had not acknowledged.

import { tx, getMeta } from "./schema.mjs";
import { RelayError, isRecordId } from "./records.mjs";
import { sha256Hex, canonicalBytes, appendLog } from "./signing.mjs";
import { jcs } from "../pillar.mjs";

export const MAILBOX_LIMITS = Object.freeze({
  maxUndelivered: 500,
  maxUndeliveredBytes: 2 * 1024 * 1024,
  pageSize: 100,
  ackedRetentionMs: 7 * 86400000,
  unackedRetentionMs: 14 * 86400000,
});

export const relayEpoch = (db) => getMeta(db, "epoch");

function mailboxState(db, memberId) {
  db.prepare("INSERT OR IGNORE INTO mailbox_state(member_id) VALUES (?)").run(memberId);
  return db.prepare("SELECT next_seq, acked_through FROM mailbox_state WHERE member_id = ?").get(memberId);
}

function readableMember(db, memberId) {
  const m = db.prepare("SELECT status FROM members WHERE member_id = ?").get(memberId);
  if (!m || m.status !== "active") throw new RelayError("unauthorized", 401);
}

/** Deliver one record to a member's mailbox. Call inside the caller's transaction. Idempotent on record_id. */
export function deliverInTx(db, memberId, { record_id, sender, type, body }, now) {
  if (!isRecordId(record_id)) throw new RelayError("invalid-field", 400, "record_id");
  const member = db.prepare("SELECT status FROM members WHERE member_id = ?").get(memberId);
  if (!member || member.status === "revoked") throw new RelayError("unknown-recipient", 404);
  const text = jcs(body);
  const sha = sha256Hex(canonicalBytes({ sender, type, body }));
  const prior = db.prepare("SELECT seq, body_sha256 FROM mailbox WHERE member_id = ? AND record_id = ?").get(memberId, record_id);
  if (prior) {
    if (prior.body_sha256 !== sha) throw new RelayError("record-conflict", 409);
    return { seq: prior.seq, duplicate: true };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const load = db.prepare("SELECT count(*) n, coalesce(sum(bytes), 0) b FROM mailbox WHERE member_id = ? AND acked_at IS NULL AND expired_at IS NULL").get(memberId);
  if (load.n >= MAILBOX_LIMITS.maxUndelivered || load.b + bytes > MAILBOX_LIMITS.maxUndeliveredBytes) throw new RelayError("mailbox-full", 507);
  const state = mailboxState(db, memberId);
  db.prepare(`INSERT INTO mailbox(member_id, seq, record_id, sender, type, body, body_sha256, bytes, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(memberId, state.next_seq, record_id, sender, type, text, sha, bytes, now);
  db.prepare("UPDATE mailbox_state SET next_seq = ? WHERE member_id = ?").run(state.next_seq + 1, memberId);
  appendLog(db, "mailbox", { kind: "delivered", member_id: memberId, seq: state.next_seq, record_id, sender, type, sha256: sha }, now);
  return { seq: state.next_seq, duplicate: false };
}

/**
 * Read up to one page. `after` omitted resumes after the member's last ack (B8).
 * Expired records are skipped; the page says where the next read starts.
 */
export function readInbox(db, memberId, { after } = {}, now) {
  return tx(db, () => {
    readableMember(db, memberId);
    const state = mailboxState(db, memberId);
    const from = after === undefined ? state.acked_through : after;
    if (!Number.isSafeInteger(from) || from < 0) throw new RelayError("invalid-field", 400, "after");
    const rows = db.prepare(`SELECT seq, record_id, sender, type, body, created_at FROM mailbox
                              WHERE member_id = ? AND seq > ? AND expired_at IS NULL ORDER BY seq LIMIT ?`)
      .all(memberId, from, MAILBOX_LIMITS.pageSize);
    return {
      epoch: relayEpoch(db),
      acked_through: state.acked_through,
      records: rows.map(r => ({ seq: r.seq, record_id: r.record_id, sender: r.sender, type: r.type, body: JSON.parse(r.body), created_at: r.created_at })),
      next_after: rows.length ? rows.at(-1).seq : from,
    };
  });
}

/** Acknowledge through seq. Lower or equal acks are no-ops; acks beyond what was delivered are refused. */
export function ackInbox(db, memberId, through, now) {
  return tx(db, () => {
    readableMember(db, memberId);
    const state = mailboxState(db, memberId);
    if (!Number.isSafeInteger(through) || through < 0) throw new RelayError("invalid-field", 400, "through");
    if (through >= state.next_seq) throw new RelayError("ack-beyond-delivered", 400);
    if (through <= state.acked_through) return { acked_through: state.acked_through };
    db.prepare("UPDATE mailbox SET acked_at = ? WHERE member_id = ? AND seq > ? AND seq <= ? AND acked_at IS NULL AND expired_at IS NULL")
      .run(now, memberId, state.acked_through, through);
    db.prepare("UPDATE mailbox_state SET acked_through = ? WHERE member_id = ?").run(through, memberId);
    appendLog(db, "mailbox", { kind: "acked", member_id: memberId, through }, now);
    return { acked_through: through };
  });
}

/** Retention (7.6): acked records go after 7 days; unacked ones expire after 14 days with a logged event. */
export function pruneMailbox(db, now) {
  return tx(db, () => {
    const removed = db.prepare("DELETE FROM mailbox WHERE acked_at IS NOT NULL AND acked_at <= ?").run(now - MAILBOX_LIMITS.ackedRetentionMs).changes;
    const stale = db.prepare("SELECT member_id, seq, record_id FROM mailbox WHERE acked_at IS NULL AND expired_at IS NULL AND created_at <= ?").all(now - MAILBOX_LIMITS.unackedRetentionMs);
    for (const r of stale) {
      db.prepare("UPDATE mailbox SET expired_at = ? WHERE member_id = ? AND seq = ?").run(now, r.member_id, r.seq);
      appendLog(db, "mailbox", { kind: "expired", member_id: r.member_id, seq: r.seq, record_id: r.record_id }, now);
    }
    return { removed: Number(removed), expired: stale.length };
  });
}
