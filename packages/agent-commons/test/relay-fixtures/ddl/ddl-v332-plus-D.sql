-- relay.db invariant schema (L0). Every connection runs PRAGMA foreign_keys = ON;
-- the store reads it back and refuses to open if it is not 1. Times are integer
-- milliseconds since the Unix epoch (UTC), set by the reducer from the relay clock.
-- STRICT tables refuse values of the wrong type.

CREATE TABLE fleet_principals(
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ac-seat','verifier','security','scope','owner','measurer')),
  runtime_family TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','retired'))
) STRICT;

CREATE TABLE members(
  member_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','active','suspended','revoked')),
  role TEXT CHECK (role IN ('C0','C1','C2','C3')),       -- projection of roles; see roles_project
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER members_start_pending BEFORE INSERT ON members
  WHEN NEW.status <> 'pending' OR NEW.role IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'member-starts-pending'); END;
CREATE TRIGGER members_no_delete BEFORE DELETE ON members
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- status 'suspended' holds exactly while an open suspension exists
CREATE TRIGGER members_status_follows_suspensions BEFORE UPDATE OF status ON members
  WHEN (NEW.status = 'suspended' AND NOT EXISTS (SELECT 1 FROM suspensions s WHERE s.member_id = NEW.member_id AND s.ended_at IS NULL))
    OR (NEW.status = 'active' AND EXISTS (SELECT 1 FROM suspensions s WHERE s.member_id = NEW.member_id AND s.ended_at IS NULL))
    OR (OLD.status = 'revoked' AND NEW.status <> 'revoked')
  BEGIN SELECT RAISE(ABORT, 'status-follows-suspensions'); END;
-- R2: the status lifecycle. Never back to pending; pending -> active only with a confirmed enroll.
CREATE TRIGGER members_status_lifecycle BEFORE UPDATE OF status ON members
  WHEN NEW.status <> OLD.status AND (
       NEW.status = 'pending'
    OR (OLD.status = 'pending' AND NEW.status NOT IN ('active','revoked'))
    OR (OLD.status = 'pending' AND NEW.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM enrollments e WHERE e.member_id = NEW.member_id AND e.kind = 'enroll' AND e.confirmed_by IS NOT NULL)))
  BEGIN SELECT RAISE(ABORT, 'status-lifecycle'); END;
-- members.role is written only by roles_project
CREATE TRIGGER members_role_is_projection BEFORE UPDATE OF role ON members
  WHEN NEW.role IS NOT (SELECT r.role FROM roles r WHERE r.member_id = NEW.member_id ORDER BY r.seq DESC LIMIT 1)
  BEGIN SELECT RAISE(ABORT, 'role-is-a-projection'); END;

-- One key ever (RD1): a key row is never deleted, its binding never changes, revoked is terminal.
CREATE TABLE keys(
  public_key TEXT PRIMARY KEY CHECK (length(public_key) = 64),
  agent TEXT NOT NULL UNIQUE,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('member','fleet')),
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  added_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
) STRICT;
CREATE TRIGGER keys_no_delete BEFORE DELETE ON keys
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER keys_binding_immutable BEFORE UPDATE ON keys
  WHEN NEW.public_key IS NOT OLD.public_key OR NEW.agent IS NOT OLD.agent
    OR NEW.principal_kind IS NOT OLD.principal_kind OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.added_at IS NOT OLD.added_at OR OLD.status = 'revoked'
  BEGIN SELECT RAISE(ABORT, 'key-immutable'); END;

-- Owner-visible record outbox (9.5): immutable except a single confirmation.
CREATE TABLE owner_record_outbox(
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,                                 -- the decision or enrollment id
  line TEXT NOT NULL,
  line_sha256 TEXT NOT NULL CHECK (length(line_sha256) = 64),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  confirmed_by TEXT REFERENCES fleet_principals(principal_id),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL))
) STRICT;
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON owner_record_outbox
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER outbox_confirm_once BEFORE UPDATE ON owner_record_outbox
  WHEN NEW.id IS NOT OLD.id OR NEW.subject IS NOT OLD.subject OR NEW.line IS NOT OLD.line
    OR NEW.line_sha256 IS NOT OLD.line_sha256 OR NEW.created_at IS NOT OLD.created_at
    OR OLD.confirmed_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'outbox-immutable'); END;

CREATE TABLE invites(
  invite_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('enroll','rekey','rebind')),
  member_id TEXT REFERENCES members(member_id),
  created_by TEXT NOT NULL REFERENCES fleet_principals(principal_id),
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id),   -- R-B: the invite.create decision that made it
  secret_sha256 TEXT NOT NULL CHECK (length(secret_sha256) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  voided_at INTEGER,
  CHECK ((kind = 'enroll') = (member_id IS NULL)),
  CHECK (expires_at = created_at + 86400000)
) STRICT;
CREATE TRIGGER invites_no_delete BEFORE DELETE ON invites
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER invites_immutable BEFORE UPDATE ON invites
  WHEN NEW.invite_id IS NOT OLD.invite_id OR NEW.kind IS NOT OLD.kind OR NEW.member_id IS NOT OLD.member_id
    OR NEW.created_by IS NOT OLD.created_by OR NEW.secret_sha256 IS NOT OLD.secret_sha256
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.decision_id IS NOT OLD.decision_id OR OLD.voided_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'invite-immutable'); END;
-- R-B: an invite is made only by its own effective invite.create decision.
CREATE TRIGGER invites_need_decision BEFORE INSERT ON invites
  WHEN NOT EXISTS (SELECT 1 FROM decisions d WHERE d.id = NEW.decision_id AND d.class = 'D0'
                   AND d.action = 'invite.create' AND d.state = 'effective')
  BEGIN SELECT RAISE(ABORT, 'invite-needs-decision'); END;
-- R-B: at most one live re-bind attempt per member. An attempt is live while its suspension is open
-- and it has no rebind_ends row.
CREATE TRIGGER rebind_one_live_attempt BEFORE INSERT ON invites
  WHEN NEW.kind = 'rebind' AND EXISTS (SELECT 1 FROM suspensions s WHERE s.member_id = NEW.member_id
       AND s.reason = 'rebind' AND s.ended_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = s.invite_id))
  BEGIN SELECT RAISE(ABORT, 'rebind-attempt-live'); END;

-- The spend ledger for all three enrollment flows. One row per invite, ever (M1).
CREATE TABLE enrollments(
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL UNIQUE REFERENCES invites(invite_id),
  kind TEXT NOT NULL CHECK (kind IN ('enroll','rekey','rebind')),
  member_id TEXT NOT NULL REFERENCES members(member_id),
  public_key TEXT NOT NULL REFERENCES keys(public_key),
  spent_at INTEGER NOT NULL,
  confirmed_by TEXT REFERENCES fleet_principals(principal_id),  -- enroll, rekey (D0); rebind confirms by a D1R decision
  confirmed_at INTEGER,
  owner_line_ref TEXT REFERENCES owner_record_outbox(id),
  CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  CHECK (confirmed_by IS NULL OR owner_line_ref IS NOT NULL),
  CHECK (kind <> 'rebind' OR confirmed_by IS NULL)
) STRICT;
CREATE TRIGGER enroll_no_delete BEFORE DELETE ON enrollments
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER enroll_insert_unconfirmed BEFORE INSERT ON enrollments
  WHEN NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL OR NEW.owner_line_ref IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'enrollment-starts-unconfirmed'); END;
-- B2 and M1: the flow matches its invite; the invite is live at the recorded spend time
CREATE TRIGGER enroll_matches_invite BEFORE INSERT ON enrollments
  WHEN NOT EXISTS (SELECT 1 FROM invites i WHERE i.invite_id = NEW.invite_id AND i.kind = NEW.kind
                   AND (i.kind = 'enroll' OR i.member_id = NEW.member_id)
                   AND i.voided_at IS NULL AND NEW.spent_at >= i.created_at AND NEW.spent_at < i.expires_at)
  BEGIN SELECT RAISE(ABORT, 'invite-mismatch-or-dead'); END;
-- RD2: no re-key while any suspension is open
CREATE TRIGGER rekey_not_suspended BEFORE INSERT ON enrollments
  WHEN NEW.kind = 'rekey' AND ((SELECT status FROM members WHERE member_id = NEW.member_id) <> 'active'
       OR EXISTS (SELECT 1 FROM suspensions s WHERE s.member_id = NEW.member_id AND s.ended_at IS NULL))
  BEGIN SELECT RAISE(ABORT, 'member-suspended'); END;
-- RD2: a re-bind proceeds only under its own open re-bind suspension, never for a revoked member
CREATE TRIGGER rebind_needs_own_suspension BEFORE INSERT ON enrollments
  WHEN NEW.kind = 'rebind' AND ((SELECT status FROM members WHERE member_id = NEW.member_id) = 'revoked'
       OR NOT EXISTS (SELECT 1 FROM suspensions s WHERE s.member_id = NEW.member_id AND s.reason = 'rebind'
                      AND s.invite_id = NEW.invite_id AND s.ended_at IS NULL))
  BEGIN SELECT RAISE(ABORT, 'rebind-needs-own-suspension'); END;
-- Immutable except a single confirmation
CREATE TRIGGER enroll_confirm_once BEFORE UPDATE ON enrollments
  WHEN NEW.id IS NOT OLD.id OR NEW.invite_id IS NOT OLD.invite_id OR NEW.kind IS NOT OLD.kind
    OR NEW.member_id IS NOT OLD.member_id OR NEW.public_key IS NOT OLD.public_key OR NEW.spent_at IS NOT OLD.spent_at
    OR OLD.confirmed_by IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'enrollment-immutable'); END;
-- P1: the confirming seat is not the invite creator, and is an AC seat
CREATE TRIGGER enroll_confirm_not_creator BEFORE UPDATE ON enrollments
  WHEN OLD.confirmed_by IS NULL AND NEW.confirmed_by IS NOT NULL
   AND NEW.confirmed_by = (SELECT created_by FROM invites WHERE invite_id = NEW.invite_id)
  BEGIN SELECT RAISE(ABORT, 'confirmer-is-invite-creator'); END;
CREATE TRIGGER enroll_confirm_by_seat BEFORE UPDATE ON enrollments
  WHEN OLD.confirmed_by IS NULL AND NEW.confirmed_by IS NOT NULL
   AND (SELECT kind FROM fleet_principals WHERE principal_id = NEW.confirmed_by) IS NOT 'ac-seat'
  BEGIN SELECT RAISE(ABORT, 'confirmer-not-ac-seat'); END;
-- M2: confirmation cites a confirmed owner-visible line about this enrollment, invite not voided,
-- enroll member still pending, rekey member still active and unsuspended
CREATE TRIGGER enroll_confirm_preconditions BEFORE UPDATE ON enrollments
  WHEN OLD.confirmed_by IS NULL AND NEW.confirmed_by IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM owner_record_outbox o WHERE o.id = NEW.owner_line_ref AND o.subject = NEW.id
                   AND o.confirmed_at IS NOT NULL AND o.confirmed_at <= NEW.confirmed_at)
    OR (SELECT voided_at FROM invites WHERE invite_id = NEW.invite_id) IS NOT NULL
    OR (NEW.kind = 'enroll' AND (SELECT status FROM members WHERE member_id = NEW.member_id) <> 'pending')
    OR (NEW.kind = 'rekey' AND ((SELECT status FROM members WHERE member_id = NEW.member_id) <> 'active'
        OR EXISTS (SELECT 1 FROM suspensions s WHERE s.member_id = NEW.member_id AND s.ended_at IS NULL))))
  BEGIN SELECT RAISE(ABORT, 'confirm-precondition'); END;

CREATE TABLE decisions(
  id TEXT PRIMARY KEY,
  class TEXT NOT NULL CHECK (class IN ('D0','D1','D1R','D2','SUSPEND','OWNER')),  -- D1R = re-bind; no D3
  action TEXT NOT NULL,
  subject TEXT NOT NULL,                 -- member_id, task_id, submission_id or enrollment id, by action
  sponsor TEXT REFERENCES fleet_principals(principal_id),
  lane TEXT,                             -- S1: the signed body's lane; set exactly for D0, D1 and D2
  state TEXT NOT NULL CHECK (state IN ('pending','effective','vetoed','lapsed','withdrawn','reversed')),  -- 'blocked' is derived from live verdicts, never stored
  owner_line_ref TEXT REFERENCES owner_record_outbox(id),
  owner_posted_at INTEGER,
  effect_at INTEGER,
  served_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  sig TEXT NOT NULL,
  CHECK (class <> 'D2' OR sponsor IS NOT NULL),
  CHECK ((class IN ('D0','D1','D2')) = (lane IS NOT NULL)),
  CHECK ((owner_posted_at IS NULL) = (owner_line_ref IS NULL)),
  CHECK (class = 'D2' OR effect_at IS NULL),
  CHECK (class <> 'D2' OR (effect_at IS NULL) = (owner_posted_at IS NULL)),
  CHECK (class <> 'D2' OR effect_at IS NULL OR effect_at = owner_posted_at + 86400000),
  CHECK (class NOT IN ('D2','D1R') OR state NOT IN ('effective','reversed') OR owner_posted_at IS NOT NULL)
) STRICT;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER decisions_start_pending BEFORE INSERT ON decisions
  WHEN NEW.state <> 'pending' OR NEW.owner_posted_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'decision-starts-pending'); END;
CREATE TRIGGER decisions_immutable BEFORE UPDATE ON decisions
  WHEN NEW.id IS NOT OLD.id OR NEW.class IS NOT OLD.class OR NEW.action IS NOT OLD.action
    OR NEW.subject IS NOT OLD.subject OR NEW.sponsor IS NOT OLD.sponsor OR NEW.lane IS NOT OLD.lane OR NEW.served_by IS NOT OLD.served_by
    OR NEW.created_at IS NOT OLD.created_at OR NEW.body IS NOT OLD.body OR NEW.sig IS NOT OLD.sig
    OR (OLD.owner_posted_at IS NOT NULL AND (NEW.owner_posted_at IS NOT OLD.owner_posted_at
        OR NEW.owner_line_ref IS NOT OLD.owner_line_ref OR NEW.effect_at IS NOT OLD.effect_at))
  BEGIN SELECT RAISE(ABORT, 'decision-immutable'); END;
CREATE TRIGGER decisions_transition BEFORE UPDATE OF state ON decisions
  WHEN NOT ((OLD.state = 'pending' AND NEW.state IN ('pending','effective','vetoed','lapsed','withdrawn'))
         OR (OLD.state = 'effective' AND NEW.state IN ('effective','reversed'))
         OR OLD.state = NEW.state)
  BEGIN SELECT RAISE(ABORT, 'illegal-transition'); END;
-- C3: only an owner veto that cites this decision vetoes or reverses it
CREATE TRIGGER decisions_veto_needed BEFORE UPDATE OF state ON decisions
  WHEN NEW.state IN ('vetoed','reversed') AND NEW.state IS NOT OLD.state
   AND NOT EXISTS (SELECT 1 FROM decisions v WHERE v.class = 'OWNER' AND v.action = 'veto' AND v.subject = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'veto-needed'); END;
-- T-C5: the owner-visible time is the confirmed post of a line about this decision
CREATE TRIGGER decisions_post_confirmed BEFORE UPDATE ON decisions
  WHEN OLD.owner_posted_at IS NULL AND NEW.owner_posted_at IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM owner_record_outbox o WHERE o.id = NEW.owner_line_ref AND o.subject = NEW.id
       AND o.confirmed_at = NEW.owner_posted_at)
  BEGIN SELECT RAISE(ABORT, 'owner-post-unconfirmed'); END;

-- Authors are fixed before the first verdict and never change.
CREATE TABLE decision_authors(
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  principal TEXT NOT NULL,               -- a member_id or a fleet principal_id
  PRIMARY KEY(decision_id, principal)
) STRICT;
CREATE TRIGGER authors_frozen BEFORE INSERT ON decision_authors
  WHEN EXISTS (SELECT 1 FROM approvals a WHERE a.decision_id = NEW.decision_id)
    OR (SELECT state FROM decisions WHERE id = NEW.decision_id) <> 'pending'
  BEGIN SELECT RAISE(ABORT, 'authors-frozen'); END;
CREATE TRIGGER authors_no_update BEFORE UPDATE ON decision_authors
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER authors_no_delete BEFORE DELETE ON decision_authors
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- Verdicts are append-only. Each approver's latest seq is its current verdict.
CREATE TABLE approvals(
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  approver TEXT NOT NULL REFERENCES fleet_principals(principal_id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  prev TEXT CHECK (prev IS NULL OR length(prev) = 64),     -- sha256(JCS(this approver's previous verdict body)); NULL only at seq 1
  verdict TEXT NOT NULL CHECK (verdict IN ('approve','object','reject','withdraw')),
  approver_kind TEXT NOT NULL,
  approver_family TEXT,
  served_by TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),   -- sha256(JCS(body)), computed by the relay
  sig TEXT NOT NULL,
  PRIMARY KEY(decision_id, approver, seq),
  UNIQUE(decision_id, body_sha256)                            -- C1: a signed body is accepted at most once
) STRICT;
CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER approvals_seq BEFORE INSERT ON approvals
  WHEN NEW.seq <> 1 + coalesce((SELECT max(seq) FROM approvals a WHERE a.decision_id = NEW.decision_id AND a.approver = NEW.approver), 0)
  BEGIN SELECT RAISE(ABORT, 'approval-seq'); END;
-- C1: each verdict links to the approver's previous one on this decision
CREATE TRIGGER approvals_prev_chain BEFORE INSERT ON approvals
  WHEN NOT ((NEW.seq = 1 AND NEW.prev IS NULL)
         OR (NEW.seq > 1 AND NEW.prev IS (SELECT a.body_sha256 FROM approvals a
              WHERE a.decision_id = NEW.decision_id AND a.approver = NEW.approver AND a.seq = NEW.seq - 1)))
  BEGIN SELECT RAISE(ABORT, 'approval-seq'); END;
-- C1/C2/S2: the decision body is only ever its creator's implicit seq-1 approve, for D0, D1 and D1R,
-- attributed to the creator named in the signed body
CREATE TRIGGER approvals_implicit BEFORE INSERT ON approvals
  WHEN NEW.body = (SELECT d.body FROM decisions d WHERE d.id = NEW.decision_id)
   AND (NEW.seq <> 1 OR NEW.verdict <> 'approve'
        OR NEW.sig IS NOT (SELECT d.sig FROM decisions d WHERE d.id = NEW.decision_id)
        OR NEW.approver IS NOT (SELECT json_extract(d.body, '$.by') FROM decisions d WHERE d.id = NEW.decision_id)
        OR (SELECT d.class FROM decisions d WHERE d.id = NEW.decision_id) NOT IN ('D0','D1','D1R'))
  BEGIN SELECT RAISE(ABORT, 'implicit-approval'); END;
-- C5: only AC seats file verdicts; a measurer, verifier, security, scope or owner principal never votes
CREATE TRIGGER approvals_ac_seat_only BEFORE INSERT ON approvals
  WHEN NEW.approver_kind <> 'ac-seat'
  BEGIN SELECT RAISE(ABORT, 'approver-not-ac-seat'); END;
-- N4: object is a D2 verdict; on D0, D1 and D1R a seat blocks with reject
CREATE TRIGGER approvals_object_d2_only BEFORE INSERT ON approvals
  WHEN NEW.verdict = 'object' AND (SELECT d.class FROM decisions d WHERE d.id = NEW.decision_id) <> 'D2'
  BEGIN SELECT RAISE(ABORT, 'object-d2-only'); END;
CREATE TRIGGER approvals_roster BEFORE INSERT ON approvals
  WHEN NOT EXISTS (SELECT 1 FROM fleet_principals f WHERE f.principal_id = NEW.approver AND f.kind = NEW.approver_kind
                   AND f.runtime_family IS NEW.approver_family AND f.status = 'active')
  BEGIN SELECT RAISE(ABORT, 'approver-not-in-roster'); END;
CREATE TRIGGER approvals_pending_only BEFORE INSERT ON approvals
  WHEN (SELECT state FROM decisions WHERE id = NEW.decision_id) IS NOT 'pending'
  BEGIN SELECT RAISE(ABORT, 'decision-closed'); END;
-- author != approver. Authors may still object or reject (that only blocks).
CREATE TRIGGER approvals_no_author BEFORE INSERT ON approvals
  WHEN NEW.verdict = 'approve' AND EXISTS (SELECT 1 FROM decision_authors a
       WHERE a.decision_id = NEW.decision_id AND a.principal = NEW.approver)
  BEGIN SELECT RAISE(ABORT, 'author-cannot-approve'); END;
-- P2 and A1: the D2 sponsor never counts; its only verdict is withdraw, which ends the D2.
CREATE TRIGGER approvals_no_sponsor_d2 BEFORE INSERT ON approvals
  WHEN NEW.verdict <> 'withdraw' AND EXISTS (SELECT 1 FROM decisions d
       WHERE d.id = NEW.decision_id AND d.class = 'D2' AND d.sponsor = NEW.approver)
  BEGIN SELECT RAISE(ABORT, 'sponsor-excluded'); END;
CREATE TRIGGER sponsor_withdraw_ends_d2 AFTER INSERT ON approvals
  WHEN NEW.verdict = 'withdraw' AND EXISTS (SELECT 1 FROM decisions d
       WHERE d.id = NEW.decision_id AND d.class = 'D2' AND d.sponsor = NEW.approver)
  BEGIN UPDATE decisions SET state = 'withdrawn' WHERE id = NEW.decision_id; END;
-- P1 for re-bind: no approval from the invite creator
CREATE TRIGGER approvals_no_invite_creator_d1r BEFORE INSERT ON approvals
  WHEN NEW.verdict = 'approve' AND EXISTS (SELECT 1 FROM decisions d
       JOIN enrollments e ON e.id = d.subject JOIN invites i ON i.invite_id = e.invite_id
       WHERE d.id = NEW.decision_id AND d.class = 'D1R' AND i.created_by = NEW.approver)
  BEGIN SELECT RAISE(ABORT, 'confirmer-is-invite-creator'); END;

-- RD2: suspensions carry a reason; a re-bind confirmation ends only its own.
CREATE TABLE suspensions(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  reason TEXT NOT NULL CHECK (reason IN ('decision','rebind')),
  decision_id TEXT REFERENCES decisions(id),
  invite_id TEXT REFERENCES invites(invite_id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_by_decision TEXT REFERENCES decisions(id),
  CHECK ((reason = 'rebind') = (invite_id IS NOT NULL)),
  CHECK ((reason = 'decision') = (decision_id IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (ended_by_decision IS NULL))
) STRICT;
CREATE TRIGGER suspensions_no_delete BEFORE DELETE ON suspensions
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER suspensions_end_once BEFORE UPDATE ON suspensions
  WHEN NEW.id IS NOT OLD.id OR NEW.member_id IS NOT OLD.member_id OR NEW.reason IS NOT OLD.reason
    OR NEW.decision_id IS NOT OLD.decision_id OR NEW.invite_id IS NOT OLD.invite_id
    OR NEW.started_at IS NOT OLD.started_at OR OLD.ended_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'suspension-immutable'); END;
-- R-B: a re-bind attempt that can no longer complete is recorded dead once, with its cause.
-- Recorded by the reducer (sweep, void, cancel, owner reversal, D2 reinstate); checked here against the rows.
CREATE TABLE rebind_ends(
  invite_id TEXT PRIMARY KEY REFERENCES invites(invite_id),
  cause TEXT NOT NULL CHECK (cause IN ('invite-expired','invite-voided','enrollment-expired','cancelled','reversed','reinstated')),
  decision_id TEXT REFERENCES decisions(id),
  at INTEGER NOT NULL,
  CHECK ((cause IN ('cancelled','reversed','reinstated')) = (decision_id IS NOT NULL))
) STRICT;
CREATE TRIGGER rebind_ends_no_delete BEFORE DELETE ON rebind_ends
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER rebind_ends_no_update BEFORE UPDATE ON rebind_ends
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER rebind_ends_only_dead BEFORE INSERT ON rebind_ends
  WHEN (SELECT kind FROM invites WHERE invite_id = NEW.invite_id) IS NOT 'rebind'
    OR EXISTS (SELECT 1 FROM enrollments e JOIN decisions d ON d.subject = e.id
               WHERE e.invite_id = NEW.invite_id AND d.class = 'D1R' AND d.state IN ('effective','reversed'))
    OR NOT (
         (NEW.cause = 'invite-expired' AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.invite_id = NEW.invite_id)
            AND NEW.at >= (SELECT expires_at FROM invites WHERE invite_id = NEW.invite_id))
      OR (NEW.cause = 'invite-voided' AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.invite_id = NEW.invite_id)
            AND (SELECT voided_at FROM invites WHERE invite_id = NEW.invite_id) IS NOT NULL)
      OR (NEW.cause = 'enrollment-expired' AND EXISTS (SELECT 1 FROM enrollments e JOIN keys k USING(public_key)
            WHERE e.invite_id = NEW.invite_id AND k.status = 'revoked' AND NEW.at >= e.spent_at + 259200000))
      OR (NEW.cause IN ('cancelled','reversed','reinstated')
            AND ((NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.invite_id = NEW.invite_id)
                  AND (SELECT voided_at FROM invites WHERE invite_id = NEW.invite_id) IS NOT NULL)
              OR EXISTS (SELECT 1 FROM enrollments e JOIN keys k USING(public_key)
                  WHERE e.invite_id = NEW.invite_id AND k.status = 'revoked'))
            AND ((NEW.cause = 'cancelled' AND EXISTS (SELECT 1 FROM decisions d WHERE d.id = NEW.decision_id
                    AND d.class = 'D0' AND d.action = 'rebind.cancel' AND d.subject = NEW.invite_id AND d.state = 'effective'))
              OR (NEW.cause = 'reversed' AND EXISTS (SELECT 1 FROM decisions v JOIN invites i ON i.decision_id = v.subject
                    WHERE v.id = NEW.decision_id AND v.class = 'OWNER' AND v.action = 'veto' AND i.invite_id = NEW.invite_id))
              OR (NEW.cause = 'reinstated' AND EXISTS (SELECT 1 FROM decisions d WHERE d.id = NEW.decision_id
                    AND d.class = 'D2' AND d.action = 'reinstate' AND d.state = 'effective'
                    AND d.subject = (SELECT member_id FROM invites WHERE invite_id = NEW.invite_id))))))
  BEGIN SELECT RAISE(ABORT, 'rebind-end-invalid'); END;
-- R-B: a D1R about a dead attempt never takes effect (the reducer lapses it instead).
CREATE TRIGGER rebind_confirm_needs_live_attempt BEFORE UPDATE OF state ON decisions
  WHEN NEW.state = 'effective' AND OLD.state = 'pending' AND NEW.class = 'D1R'
   AND EXISTS (SELECT 1 FROM enrollments e JOIN rebind_ends r ON r.invite_id = e.invite_id WHERE e.id = NEW.subject)
  BEGIN SELECT RAISE(ABORT, 'rebind-attempt-dead'); END;
-- A re-bind suspension ends by an effective D1R about its own invite's enrollment. Once its attempt is
-- recorded dead (rebind_ends), it also ends by the member's D2 reinstate, by a newer re-bind invite for the
-- member (supersession), or by the owner veto that reversed its invite.create. A decision suspension ends
-- only by an effective D2 reinstatement of that member, or by the owner veto that reversed its decision.
CREATE TRIGGER suspensions_end_by_matching_decision BEFORE UPDATE OF ended_at ON suspensions
  WHEN NEW.ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.id = NEW.ended_by_decision AND d.state = 'effective'
       AND ((OLD.reason = 'rebind' AND d.class = 'D1R' AND d.subject = (SELECT e.id FROM enrollments e WHERE e.invite_id = OLD.invite_id))
         OR (OLD.reason = 'rebind' AND EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = OLD.invite_id)
             AND ((d.class = 'D2' AND d.action = 'reinstate' AND d.subject = OLD.member_id)
               OR (d.class = 'D0' AND d.action = 'invite.create' AND EXISTS (SELECT 1 FROM invites i2
                     WHERE i2.decision_id = d.id AND i2.kind = 'rebind' AND i2.member_id = OLD.member_id AND i2.invite_id <> OLD.invite_id))
               OR (d.class = 'OWNER' AND d.action = 'veto' AND d.subject = (SELECT i.decision_id FROM invites i WHERE i.invite_id = OLD.invite_id))))
         OR (OLD.reason = 'decision' AND d.class = 'D2' AND d.action = 'reinstate' AND d.subject = OLD.member_id)
         OR (OLD.reason = 'decision' AND d.class = 'OWNER' AND d.action = 'veto' AND d.subject = OLD.decision_id)))
  BEGIN SELECT RAISE(ABORT, 'suspension-end-needs-matching-decision'); END;
-- P3: opening a suspension suspends the member and releases its claims in the same statement
CREATE TRIGGER suspension_opens AFTER INSERT ON suspensions
  BEGIN
    UPDATE members SET status = 'suspended', updated_at = NEW.started_at
      WHERE member_id = NEW.member_id AND status IN ('active','suspended');
    UPDATE claims SET state = 'released', released_reason = 'suspension', released_at = NEW.started_at
      WHERE member_id = NEW.member_id AND state = 'live';
    UPDATE submissions SET state = 'held' WHERE member_id = NEW.member_id AND state = 'in-review';
  END;
CREATE TRIGGER suspension_closes AFTER UPDATE OF ended_at ON suspensions
  WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
  BEGIN
    UPDATE members SET status = 'active', updated_at = NEW.ended_at
      WHERE member_id = NEW.member_id AND status = 'suspended'
      AND NOT EXISTS (SELECT 1 FROM suspensions s WHERE s.member_id = NEW.member_id AND s.ended_at IS NULL);
  END;
-- Revocation releases claims the same way.
CREATE TRIGGER revocation_releases AFTER UPDATE OF status ON members
  WHEN NEW.status = 'revoked' AND OLD.status <> 'revoked'
  BEGIN
    UPDATE claims SET state = 'released', released_reason = 'revocation', released_at = NEW.updated_at
      WHERE member_id = NEW.member_id AND state = 'live';
    UPDATE submissions SET state = 'held' WHERE member_id = NEW.member_id AND state = 'in-review';
  END;

-- Columns the invariants need; the board module adds the rest (11.1-11.3).
CREATE TABLE claims(
  claim_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live','released','expired','submitted')),
  lease_until INTEGER NOT NULL,
  released_reason TEXT,
  released_at INTEGER
) STRICT;
CREATE TRIGGER claims_member_active BEFORE INSERT ON claims
  WHEN NEW.state <> 'live' OR (SELECT status FROM members WHERE member_id = NEW.member_id) IS NOT 'active'
  BEGIN SELECT RAISE(ABORT, 'member-not-active'); END;
-- R1: a claim's binding never changes; the lease moves only while the claim is live.
-- A suspended or revoked member has no live claim (suspension_opens, revocation_releases).
CREATE TRIGGER claims_binding_immutable BEFORE UPDATE ON claims
  WHEN NEW.claim_id IS NOT OLD.claim_id OR NEW.task_id IS NOT OLD.task_id
    OR NEW.member_id IS NOT OLD.member_id OR NEW.epoch IS NOT OLD.epoch
    OR (NEW.lease_until IS NOT OLD.lease_until AND OLD.state <> 'live')
  BEGIN SELECT RAISE(ABORT, 'claim-immutable'); END;
CREATE TRIGGER claims_no_revival BEFORE UPDATE OF state ON claims
  WHEN OLD.state <> 'live' AND NEW.state <> OLD.state
  BEGIN SELECT RAISE(ABORT, 'claim-closed'); END;
CREATE TRIGGER claims_no_delete BEFORE DELETE ON claims
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE submissions(
  submission_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  state TEXT NOT NULL CHECK (state IN ('in-review','held','accepted','rejected','changes','reversed'))
) STRICT;
CREATE TRIGGER submissions_binding_immutable BEFORE UPDATE ON submissions
  WHEN NEW.submission_id IS NOT OLD.submission_id OR NEW.member_id IS NOT OLD.member_id
  BEGIN SELECT RAISE(ABORT, 'submission-immutable'); END;
CREATE TRIGGER submissions_no_delete BEFORE DELETE ON submissions
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- C3: 'reversed' only from 'accepted', only once its accept decision is reversed, and terminal
CREATE TRIGGER submissions_reversed BEFORE UPDATE OF state ON submissions
  WHEN (OLD.state = 'reversed' AND NEW.state <> 'reversed')
    OR (NEW.state = 'reversed' AND OLD.state <> 'reversed' AND (OLD.state <> 'accepted'
        OR NOT EXISTS (SELECT 1 FROM decisions d WHERE d.action = 'accept' AND d.subject = NEW.submission_id AND d.state = 'reversed')))
  BEGIN SELECT RAISE(ABORT, 'submission-reversal'); END;
CREATE TRIGGER submissions_held BEFORE UPDATE OF state ON submissions
  WHEN OLD.state = 'held' AND NOT (NEW.state = 'held'
       OR (NEW.state = 'in-review' AND (SELECT status FROM members WHERE member_id = NEW.member_id) = 'active'))
  BEGIN SELECT RAISE(ABORT, 'submission-held'); END;

-- Roles are append-only; each row needs an effective decision of the matching class.
CREATE TABLE roles(
  member_id TEXT NOT NULL REFERENCES members(member_id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  role TEXT NOT NULL CHECK (role IN ('C0','C1','C2','C3')),
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id),
  at INTEGER NOT NULL,
  PRIMARY KEY(member_id, seq)
) STRICT;
CREATE TRIGGER roles_no_update BEFORE UPDATE ON roles
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER roles_no_delete BEFORE DELETE ON roles
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER roles_seq BEFORE INSERT ON roles
  WHEN NEW.seq <> 1 + coalesce((SELECT max(seq) FROM roles r WHERE r.member_id = NEW.member_id), 0)
  BEGIN SELECT RAISE(ABORT, 'role-seq'); END;
-- A role row is a grant by an effective role decision, or (C3) a re-projection that cites the
-- owner veto reversing a role decision and equals the member's latest still-effective grant.
CREATE TRIGGER roles_need_decision BEFORE INSERT ON roles
  WHEN NOT (EXISTS (SELECT 1 FROM decisions d WHERE d.id = NEW.decision_id AND d.state = 'effective'
       AND d.subject = NEW.member_id
       AND ((NEW.role = 'C0' AND d.class = 'D0' AND d.action = 'enroll.confirm')
         OR (NEW.role = 'C1' AND d.class = 'D0' AND d.action = 'role.c1')
         OR (d.class = 'D2' AND d.action = 'role.change')))
    OR EXISTS (SELECT 1 FROM decisions v JOIN decisions t ON t.id = v.subject
       WHERE v.id = NEW.decision_id AND v.class = 'OWNER' AND v.action = 'veto' AND v.state = 'effective'
         AND t.state = 'reversed' AND t.subject = NEW.member_id AND t.action IN ('role.c1','role.change')
         AND NEW.role IS (SELECT r.role FROM roles r JOIN decisions x ON x.id = r.decision_id
                           WHERE r.member_id = NEW.member_id AND x.state = 'effective'
                             AND x.action IN ('enroll.confirm','role.c1','role.change')
                           ORDER BY r.seq DESC LIMIT 1)))
  BEGIN SELECT RAISE(ABORT, 'role-needs-effective-decision'); END;
CREATE TRIGGER roles_project AFTER INSERT ON roles
  BEGIN UPDATE members SET role = NEW.role WHERE member_id = NEW.member_id; END;

-- C5: the owner-signed policy's model -> family map, loaded with the policy; no API changes it.
-- A model maps only if exactly one pattern of the current policy version matches (SQLite GLOB).
CREATE TABLE policy_family_map(
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  pattern TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 64 AND pattern GLOB '[A-Za-z]*'),
  family TEXT NOT NULL CHECK (length(family) BETWEEN 1 AND 32 AND family GLOB '[a-z]*'),
  PRIMARY KEY(policy_version, pattern)
) STRICT;
CREATE TRIGGER policy_family_map_no_update BEFORE UPDATE ON policy_family_map
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER policy_family_map_no_delete BEFORE DELETE ON policy_family_map
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- C5: a measurer's signed evidence of which model really served a verdict's turn.
-- Rules 1-4 are structural here; rule 5 (equal to the seat's asserted family) is the reducer's.
CREATE TABLE served_by_attestations(
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  target_by TEXT NOT NULL,
  target_seq INTEGER NOT NULL,
  measurer TEXT NOT NULL REFERENCES fleet_principals(principal_id),
  session_id TEXT NOT NULL,
  record_uuid TEXT NOT NULL,
  response_model TEXT NOT NULL,
  turn_models TEXT NOT NULL CHECK (json_valid(turn_models) AND json_type(turn_models) = 'array'
                                   AND json_array_length(turn_models) >= 1),
  family TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  tool TEXT NOT NULL CHECK (tool = 'model-of'),
  tool_sha256 TEXT NOT NULL CHECK (length(tool_sha256) = 64),
  measured_at INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  sig TEXT NOT NULL,
  FOREIGN KEY (decision_id, target_by, target_seq) REFERENCES approvals(decision_id, approver, seq),
  UNIQUE(decision_id, target_by, target_seq, measurer)
) STRICT;
CREATE TRIGGER attest_no_update BEFORE UPDATE ON served_by_attestations
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER attest_no_delete BEFORE DELETE ON served_by_attestations
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- Rule 1: signed by an active principal holding the owner-assigned measurer role (never a voter)
CREATE TRIGGER attest_measurer BEFORE INSERT ON served_by_attestations
  WHEN NOT EXISTS (SELECT 1 FROM fleet_principals f WHERE f.principal_id = NEW.measurer
                   AND f.kind = 'measurer' AND f.status = 'active')
  BEGIN SELECT RAISE(ABORT, 'attest-not-measurer'); END;
-- Rule 1 (S3): per decision, the measurer is not its sponsor, its creator, an author, or any verdict signer
CREATE TRIGGER attest_measurer_excluded BEFORE INSERT ON served_by_attestations
  WHEN NEW.measurer IS (SELECT d.sponsor FROM decisions d WHERE d.id = NEW.decision_id)
    OR NEW.measurer IS (SELECT json_extract(d.body, '$.by') FROM decisions d WHERE d.id = NEW.decision_id)
    OR EXISTS (SELECT 1 FROM decision_authors a WHERE a.decision_id = NEW.decision_id AND a.principal = NEW.measurer)
    OR EXISTS (SELECT 1 FROM approvals a WHERE a.decision_id = NEW.decision_id AND a.approver = NEW.measurer)
  BEGIN SELECT RAISE(ABORT, 'measurer-conflict'); END;
-- Rule 2: the hash the measurer found is the target verdict's body hash
CREATE TRIGGER attest_target_body BEFORE INSERT ON served_by_attestations
  WHEN NEW.body_sha256 IS NOT (SELECT a.body_sha256 FROM approvals a WHERE a.decision_id = NEW.decision_id
                               AND a.approver = NEW.target_by AND a.seq = NEW.target_seq)
  BEGIN SELECT RAISE(ABORT, 'attest-body-mismatch'); END;
-- Rule 4: the family is the current policy's map of the response model; unknown names map to nothing
CREATE TRIGGER attest_family_map BEFORE INSERT ON served_by_attestations
  WHEN NEW.policy_version IS NOT (SELECT max(m.policy_version) FROM policy_family_map m)
    OR (SELECT count(*) FROM policy_family_map m WHERE m.policy_version = NEW.policy_version AND NEW.response_model GLOB m.pattern) <> 1
    OR NEW.family IS NOT (SELECT m.family FROM policy_family_map m WHERE m.policy_version = NEW.policy_version AND NEW.response_model GLOB m.pattern)
  BEGIN SELECT RAISE(ABORT, 'attest-family-map'); END;
-- Rule 3: the response model is one of the turn's models, and every assistant record of the turn
-- maps to the response model's family. (An unmappable response model is rule 4's refusal.)
CREATE TRIGGER attest_unmixed BEFORE INSERT ON served_by_attestations
  WHEN NOT EXISTS (SELECT 1 FROM json_each(NEW.turn_models) j WHERE j.value = NEW.response_model)
    OR ((SELECT count(*) FROM policy_family_map m WHERE m.policy_version = NEW.policy_version AND NEW.response_model GLOB m.pattern) = 1
        AND EXISTS (SELECT 1 FROM json_each(NEW.turn_models) j
               WHERE (SELECT count(*) FROM policy_family_map m WHERE m.policy_version = NEW.policy_version AND j.value GLOB m.pattern) <> 1
                  OR (SELECT m.family FROM policy_family_map m WHERE m.policy_version = NEW.policy_version AND j.value GLOB m.pattern)
                     IS NOT (SELECT m.family FROM policy_family_map m WHERE m.policy_version = NEW.policy_version AND NEW.response_model GLOB m.pattern)))
  BEGIN SELECT RAISE(ABORT, 'attest-mixed-turn'); END;

-- S4, E-1: security findings. Only the security reviewer opens or closes one; the owner has no
-- close and no veto over findings. An open finding against a member blocks its C2 promotion (10).
CREATE TABLE security_findings(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  opened_by TEXT NOT NULL REFERENCES fleet_principals(principal_id),
  opened_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  sig TEXT NOT NULL CHECK (length(sig) = 128),
  closed_by TEXT REFERENCES fleet_principals(principal_id),
  closed_at INTEGER,
  close_body TEXT,
  close_sig TEXT CHECK (close_sig IS NULL OR length(close_sig) = 128),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL) AND (closed_at IS NULL) = (close_sig IS NULL)
         AND (closed_at IS NULL) = (close_body IS NULL)),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
) STRICT;
CREATE TRIGGER security_findings_open BEFORE INSERT ON security_findings
  WHEN NEW.closed_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM fleet_principals f WHERE f.principal_id = NEW.opened_by AND f.kind = 'security' AND f.status = 'active')
  BEGIN SELECT RAISE(ABORT, 'finding-not-security'); END;
CREATE TRIGGER security_findings_close_by_security BEFORE UPDATE ON security_findings
  WHEN OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM fleet_principals f WHERE f.principal_id = NEW.closed_by AND f.kind = 'security' AND f.status = 'active')
  BEGIN SELECT RAISE(ABORT, 'finding-not-security'); END;
CREATE TRIGGER security_findings_close_once BEFORE UPDATE ON security_findings
  WHEN NEW.id IS NOT OLD.id OR NEW.member_id IS NOT OLD.member_id OR NEW.opened_by IS NOT OLD.opened_by
    OR NEW.opened_at IS NOT OLD.opened_at OR NEW.body IS NOT OLD.body OR NEW.sig IS NOT OLD.sig
    OR OLD.closed_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'finding-fixed'); END;
CREATE TRIGGER security_findings_no_delete BEFORE DELETE ON security_findings
  BEGIN SELECT RAISE(ABORT, 'finding-fixed'); END;
