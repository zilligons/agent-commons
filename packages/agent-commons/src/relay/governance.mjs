// Cloud Commons relay, L0: permission table, role ceiling, decision and role
// ledgers (spec v3.2 sections 9 and 10, Addendum A1). Decisions are made by
// fleet principals with signed records; this module checks signatures, counts
// each seat's latest verdict against the rules, and applies the effect in the
// same transaction. The structural guards are the section 9.3 triggers.

import { randomUUID, randomBytes } from "node:crypto";
import { tx, getMeta, setMeta, D2_WINDOW_MS } from "./schema.mjs";
import { RelayError, ROLES, isRecordId, sanitizeText } from "./records.mjs";
import { verifyBody, appendLog, sha256Hex, verdictPrev } from "./signing.mjs";
import { jcs } from "../pillar.mjs";
import { normalizeAllowedPaths } from "../collaboration.mjs";
import { openClaim, CLAIM_CAPS } from "./claims.mjs";
import { deliverInTx } from "./mailbox.mjs";

import { DECISION_V, APPROVAL_V, VERIFY_V, SECURITY_V, OWNER_CONFIRM_V, COAUTHOR_V, SEAT_MESSAGE_V, FINDING_OPEN_V, FINDING_CLOSE_V, ATTEST_V, measuredFamily } from "./records.mjs";
export { DECISION_V, APPROVAL_V, VERIFY_V, SECURITY_V, OWNER_CONFIRM_V, COAUTHOR_V, SEAT_MESSAGE_V, FINDING_OPEN_V, FINDING_CLOSE_V, ATTEST_V };
export const LAPSE_MS = 14 * 86400000;

// Section 10 ceiling: no member, at any role, ever holds these.
export const CEILING = Object.freeze([
  "decision.create", "approve", "object", "reject", "withdraw", "invite.create", "enroll.confirm",
  "suspend", "veto", "freeze", "unfreeze", "verify.result", "security.approve", "coauthor.declare",
  "finding.open", "finding.close", "owner-record.confirm", "message.send", "served_by.attest", "push", "merge", "publish", "deploy", "spend",
]);

const MEMBER_ACTIONS_BY_ROLE = {
  C0: ["heartbeat", "message", "note", "inbox.read", "inbox.ack", "board.read", "claims.read"],
  C1: ["claim", "release", "progress", "result", "evidence", "review-request"],
  C2: ["propose", "advisory-review"],
  C3: [],
};
const FLEET_ACTIONS = {
  "ac-seat": ["decision.create", "approve", "object", "reject", "withdraw", "suspend", "owner-record.confirm", "message.send", "coauthor.declare"],
  verifier: ["verify.result", "suspend", "coauthor.declare"],
  security: ["security.approve", "suspend", "coauthor.declare", "finding.open", "finding.close"],
  scope: ["suspend", "freeze", "owner-record.confirm"],
  owner: ["suspend", "veto", "freeze", "unfreeze"],
  // C5: the owner-assigned measurer only attests; it never votes (9.3 approvals_ac_seat_only).
  measurer: ["served_by.attest"],
};
export const PRINCIPAL_KINDS = Object.freeze(["member", ...Object.keys(FLEET_ACTIONS)]);
export const ALL_ACTIONS = Object.freeze([...new Set([
  ...Object.values(MEMBER_ACTIONS_BY_ROLE).flat(), ...Object.values(FLEET_ACTIONS).flat(), ...CEILING])]);

/** One table keyed by (principal kind, role, action); deny by default. Roles accumulate C0 -> C3. */
export const PERMISSION_TABLE = (() => {
  const allowed = new Set();
  let carried = [];
  for (const role of ROLES) {
    carried = [...carried, ...MEMBER_ACTIONS_BY_ROLE[role]];
    for (const action of carried) if (!CEILING.includes(action)) allowed.add(`member|${role}|${action}`);
  }
  for (const [kind, actions] of Object.entries(FLEET_ACTIONS)) for (const action of actions) allowed.add(`${kind}|-|${action}`);
  return Object.freeze(allowed);
})();

export function permits(kind, role, action) {
  if (kind === "member" && CEILING.includes(action)) return false;
  return PERMISSION_TABLE.has(`${kind}|${kind === "member" ? role : "-"}|${action}`);
}

/** The member's current role: the members.role projection of the roles ledger (9.3 roles_project). */
export const roleOf = (db, memberId) => db.prepare("SELECT role FROM members WHERE member_id = ?").get(memberId)?.role ?? null;

export const isFrozen = (db) => getMeta(db, "frozen") === "1";

// Security path classifier (12.3). The owner-signed policy file supplies the list
// (roster.mjs loadPolicy); this default applies only to a relay with no policy loaded.
export const DEFAULT_SECURITY_PATHS = Object.freeze([
  "packages/agent-commons/src/relay/", "packages/agent-commons/src/vendor/", "packages/agent-commons/src/trust.mjs",
  "packages/agent-commons/src/carrier.mjs", "packages/agent-commons/src/transport.mjs", "packages/agent-commons/src/pillar.mjs",
  "packages/agent-commons/src/uuaid-namespace.mjs", "packages/agent-commons/src/channels.mjs", "packages/agent-commons/src/governance",
  "packages/agent-commons/src/spaces/", "packages/agent-commons/src/config.mjs", "packages/agent-commons/bin/",
  ".github/", "server/operator.ts", "server/http-security.ts", "server/listen_host.ts", "server/adapters/provider_credentials.ts",
]);
export const touchesSecurityPath = (paths, policy = DEFAULT_SECURITY_PATHS) =>
  paths.some(path => policy.some(prefix => path === prefix || path.startsWith(prefix)));
export const securityPaths = (db) => { const v = getMeta(db, "security_paths"); return v ? JSON.parse(v) : DEFAULT_SECURITY_PATHS; };

// The family a seat ASSERTS in its served_by, "measured:<family>[:<model>]". Since Addendum
// C5 (spec 9.8) an assertion alone earns no family credit: credit needs a measurer's
// attestation of that verdict whose family equals this assertion (see quorum).
export { measuredFamily } from "./records.mjs";

export const hasOpenFinding = (db, memberId) =>
  !!db.prepare("SELECT 1 FROM security_findings WHERE member_id = ? AND closed_at IS NULL").get(memberId);

/** A relay notice to a member's mailbox. A full mailbox never blocks a decision; it raises an alert instead. */
function notify(db, memberId, recordId, type, body, now) {
  try { deliverInTx(db, memberId, { record_id: recordId, sender: "relay", type, body }, now); }
  catch (error) { alert(db, now, "notice-undelivered", memberId, { record_id: recordId, reason: error.code ?? "error" }); }
}

// --- signed fleet records -------------------------------------------------

/** An active fleet principal and its active key, both from relay tables (D-i). */
function fleetPrincipal(db, by) {
  if (typeof by !== "string") throw new RelayError("unauthorized", 401);
  const row = db.prepare(`SELECT f.principal_id, f.kind, f.runtime_family, k.public_key
                            FROM fleet_principals f JOIN keys k ON k.principal_kind = 'fleet' AND k.principal_id = f.principal_id
                           WHERE f.principal_id = ? AND f.status = 'active' AND k.status = 'active'`).get(by);
  if (!row) throw new RelayError("unauthorized", 401);
  return row;
}

/**
 * Check a fleet record's own signature against the signer it names (body.by). The
 * record's authority comes from this signature alone. L1 carry-forward (moderator,
 * B1 round): the authenticated request that delivers a record must be signed by the
 * same principal as body.by, and a fresh request nonce never makes an old record
 * valid again (positions and ids are checked here, inside the write transaction).
 */
// v3.3.2 (9.3 export contract): a record's signer-asserted body.at must lie within the 6.1
// window of the relay's acceptance time t: at most 5 minutes before t, at most 60 s after it.
export const RECORD_WINDOW = Object.freeze({ back_ms: 300000, ahead_ms: 60000 });

export function verifySigned(db, signed, version, now) {
  const body = signed?.body, sig = signed?.sig;
  if (!body || typeof body !== "object" || body.v !== version) throw new RelayError("invalid-record", 400, "version");
  const principal = fleetPrincipal(db, body.by);
  if (!verifyBody(principal.public_key, body, sig)) throw new RelayError("unauthorized", 401);
  if (typeof body.served_by !== "string" || !body.served_by.trim()) throw new RelayError("missing-field", 400, "served_by");
  sanitizeText(body.served_by, { field: "served_by", max: 200 });
  if (!Number.isSafeInteger(body.at)) throw new RelayError("invalid-field", 400, "at");
  if (!Number.isSafeInteger(now)) throw new RelayError("invalid-time", 500);
  if (body.at < now - RECORD_WINDOW.back_ms || body.at > now + RECORD_WINDOW.ahead_ms) throw new RelayError("record-time", 400, "at outside the 6.1 window");
  return { body, sig, principal };
}

export function requirePermission(principal, action) {
  if (!permits(principal.kind, null, action)) throw new RelayError("forbidden", 403, action);
}

// While frozen, every fleet record is refused except the owner's unfreeze and
// veto and owner-record.confirm (9.2 Freeze); every member request gets 503.
export const FROZEN_ALLOWED = Object.freeze(["unfreeze", "veto", "owner-record.confirm"]);
function refuseIfFrozen(db, action) {
  if (isFrozen(db) && !FROZEN_ALLOWED.includes(action)) throw new RelayError("frozen", 503);
}

function alert(db, at, kind, subject, detail) {
  db.prepare("INSERT INTO alerts(at, kind, subject, detail) VALUES (?, ?, ?, ?)").run(at, kind, subject ?? null, jcs(detail ?? {}));
}

/** Owner-visible line (9.5): its exact UTF-8 bytes plus one LF are what line_sha256 covers. */
export const ownerLineSha = (line) => sha256Hex(Buffer.from(`${line}\n`, "utf8"));

function writeOutbox(db, subject, line, now) {
  const id = randomUUID();
  db.prepare("INSERT INTO owner_record_outbox(id, subject, line, line_sha256, created_at) VALUES (?, ?, ?, ?, ?)").run(id, subject, line, ownerLineSha(line), now);
  return id;
}

// --- action catalogue -----------------------------------------------------

const hex40 = /^[0-9a-f]{40}$/;
function allowlist(paths) {
  try { return normalizeAllowedPaths(paths); } catch (error) { throw new RelayError("invalid-field", 400, `paths: ${String(error?.message ?? error).slice(0, 160)}`); }
}
function taskArgs(args) {
  if (!args || typeof args !== "object") throw new RelayError("invalid-field", 400, "args");
  for (const key of Object.keys(args)) if (!["title", "description", "kind", "acceptance", "paths", "base_commit"].includes(key)) throw new RelayError("unknown-field", 400, `args.${key}`);
  if (!["work", "improvement", "review"].includes(args.kind)) throw new RelayError("invalid-field", 400, "args.kind");
  if (typeof args.base_commit !== "string" || !hex40.test(args.base_commit)) throw new RelayError("invalid-field", 400, "args.base_commit");
  if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 64) throw new RelayError("invalid-field", 400, "args.paths");
  const acc = args.acceptance;
  if (!acc || typeof acc !== "object" || !Array.isArray(acc.required_checks)) throw new RelayError("invalid-field", 400, "args.acceptance");
  return {
    title: sanitizeText(args.title, { field: "title", max: 120 }),
    description: sanitizeText(args.description, { field: "description", max: 4096 }),
    kind: args.kind,
    paths: allowlist(args.paths.map((p, i) => sanitizeText(p, { field: `paths[${i}]`, max: 512 }))),
    base_commit: args.base_commit,
    acceptance: {
      criteria: sanitizeText(acc.criteria, { field: "acceptance.criteria", max: 4096 }),
      required_checks: acc.required_checks.map((c, i) => sanitizeText(c, { field: `required_checks[${i}]`, max: 512 })),
    },
  };
}

// L0 actions. The seat decisions of the enrollment flows are L0 (-022 Addendum C4, spec
// 15): invite.create, enroll.confirm and rekey.confirm (D0) and rebind.confirm (D1R). The
// request side (invite spend, nonce spend, key insert, pending member) and its endpoints
// are L1; tests seed those rows with a test-only helper. review.changes and
// review.reject are the seat outcomes of the 11.2 state diagram; spec v3.4.4 6.5 names them
// as D0 fleet record types (scope-seat ruling (a) on the L1 route gap).
// D0 actions any AC seat other than the invite creator may sign (P1); the rest are the lane owner's.
const P1_ACTIONS = Object.freeze(["enroll.confirm", "rekey.confirm"]);
const ACTIONS = {
  "invite.create": "D0", "enroll.confirm": "D0", "rekey.confirm": "D0", "rebind.cancel": "D0",
  "task.open": "D0", "task.close": "D0", "task.assign": "D0", "claim.release": "D0", "progress.accept": "D0",
  "review.changes": "D0", "review.reject": "D0", "role.c1": "D0", "clock.resume": "D0",
  accept: "D1",
  "rebind.confirm": "D1R",
  "role.change": "D2", reinstate: "D2",
  suspend: "SUSPEND",
  veto: "OWNER", freeze: "OWNER", unfreeze: "OWNER",
};

export const INVITE_TTL_MS = 86400000;          // 5.1 (and the 9.3 invites CHECK)
export const ENROLLMENT_TTL_MS = 3 * 86400000;   // 5.3: unconfirmed enrollments expire after 72 h

/** The unconfirmed enrollment of a kind, by member (enroll) or by id (rekey), with its invite. */
function pendingEnrollment(db, kind, memberId, enrollmentId = null) {
  return db.prepare(`SELECT e.*, i.created_by, i.voided_at FROM enrollments e JOIN invites i USING(invite_id)
                      WHERE e.kind = ? AND e.confirmed_by IS NULL AND (e.member_id = ? OR e.id = ?)`).get(kind, memberId ?? "", enrollmentId ?? "");
}

/** 5.3 / P1 / M2: not the invite creator, invite live, not expired, key still pending, owner line confirmed and cited. */
function confirmable(db, e, d, args, now) {
  for (const key of Object.keys(args)) if (key !== "owner_line_ref") throw new RelayError("unknown-field", 400, `args.${key}`);
  if (!e) throw new RelayError("invalid-state", 409, "no pending enrollment");
  if (e.voided_at !== null) throw new RelayError("invalid-state", 409, "invite voided");
  if (e.created_by === d.by) throw new RelayError("confirmer-is-invite-creator", 409);
  if (now >= e.spent_at + ENROLLMENT_TTL_MS) throw new RelayError("invalid-state", 409, "enrollment expired");
  if (db.prepare("SELECT status FROM keys WHERE public_key = ?").get(e.public_key)?.status !== "pending") throw new RelayError("invalid-state", 409, "key not pending");
  const line = db.prepare("SELECT confirmed_at FROM owner_record_outbox WHERE id = ? AND subject = ?").get(typeof args.owner_line_ref === "string" ? args.owner_line_ref : "", e.id);
  if (!line || line.confirmed_at === null) throw new RelayError("invalid-state", 409, "owner line not confirmed");
}

function checkEligibility(db, d, now) {
  const args = d.args ?? {};
  const member = () => {
    const m = db.prepare("SELECT m.*, p.lane FROM members m JOIN member_profiles p USING(member_id) WHERE m.member_id = ?").get(d.subject);
    if (!m || m.lane !== d.lane) throw new RelayError("invalid-state", 409, "member not in lane");
    return m;
  };
  switch (d.action) {
    case "task.open":
      if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ?").get(d.subject)) throw new RelayError("invalid-state", 409, "task exists");
      taskArgs(args);
      return;
    case "task.close": {
      const t = db.prepare("SELECT status, lane FROM tasks WHERE task_id = ?").get(d.subject);
      if (!t || t.lane !== d.lane || !["open", "needs-triage"].includes(t.status)) throw new RelayError("invalid-state", 409, "task not closable");
      return;
    }
    case "claim.release": {
      const c = db.prepare("SELECT c.state, t.lane FROM claims c JOIN tasks t USING(task_id) WHERE c.claim_id = ?").get(d.subject);
      if (!c || c.lane !== d.lane || c.state !== "live") throw new RelayError("invalid-state", 409, "no live claim");
      return;
    }
    case "task.assign": {
      // Subject: the task. The lane owner assigns an open task to an active C1+ member of the lane.
      for (const key of Object.keys(args)) if (!["member_id", "lease_ms"].includes(key)) throw new RelayError("unknown-field", 400, `args.${key}`);
      if (args.lease_ms !== undefined && (!Number.isSafeInteger(args.lease_ms) || args.lease_ms < 60000 || args.lease_ms > 86400000)) throw new RelayError("invalid-field", 400, "args.lease_ms");
      const t = db.prepare("SELECT status, lane FROM tasks WHERE task_id = ?").get(d.subject);
      if (!t || t.lane !== d.lane || t.status !== "open") throw new RelayError("invalid-state", 409, "task not open");
      const m = db.prepare("SELECT m.status, m.role, p.lane FROM members m JOIN member_profiles p USING(member_id) WHERE m.member_id = ?").get(args.member_id ?? "");
      if (!m || m.lane !== d.lane || m.status !== "active" || !["C1", "C2", "C3"].includes(m.role)) throw new RelayError("invalid-state", 409, "assignee must be an active C1+ member of the lane");
      return;
    }
    case "progress.accept": {
      // Subject: the claim. args.record_id names one progress record on that claim.
      for (const key of Object.keys(args)) if (key !== "record_id") throw new RelayError("unknown-field", 400, `args.${key}`);
      const pr = db.prepare(`SELECT p.member_id, t.lane FROM progress p JOIN claims c USING(claim_id) JOIN tasks t ON t.task_id = c.task_id
                              WHERE p.claim_id = ? AND p.record_id = ?`).get(d.subject, args.record_id ?? "");
      if (!pr || pr.lane !== d.lane) throw new RelayError("invalid-state", 409, "no such progress record");
      if (db.prepare("SELECT 1 FROM progress_acceptances WHERE member_id = ? AND record_id = ?").get(pr.member_id, args.record_id)) throw new RelayError("invalid-state", 409, "already accepted");
      return;
    }
    case "review.changes": case "review.reject": {
      // Subject: the submission, which must be in review in the lane. A declared co-author never decides it.
      for (const key of Object.keys(args)) if (!(d.action === "review.reject" ? ["disposition"] : ["lease_ms"]).includes(key)) throw new RelayError("unknown-field", 400, `args.${key}`);
      if (d.action === "review.reject" && !["reopen", "close"].includes(args.disposition)) throw new RelayError("invalid-field", 400, "args.disposition");
      if (d.action === "review.changes" && args.lease_ms !== undefined && (!Number.isSafeInteger(args.lease_ms) || args.lease_ms < 60000 || args.lease_ms > 86400000)) throw new RelayError("invalid-field", 400, "args.lease_ms");
      const s = db.prepare(`SELECT s.state, t.lane FROM submissions s JOIN submission_details x USING(submission_id)
                             JOIN tasks t ON t.task_id = x.task_id WHERE s.submission_id = ?`).get(d.subject);
      if (!s || s.lane !== d.lane || s.state !== "in-review") throw new RelayError("invalid-state", 409, "submission not in review");
      if (db.prepare("SELECT 1 FROM coauthors WHERE submission_id = ? AND principal = ?").get(d.subject, d.by)) throw new RelayError("author-cannot-approve", 409);
      return;
    }
    case "role.c1": {
      const m = member();
      if (m.status === "revoked") throw new RelayError("role-frozen-revoked", 409, "a revoked member's role is frozen (D-2)");
      const p = db.prepare("SELECT first_heartbeat_at FROM member_profiles WHERE member_id = ?").get(d.subject);
      if (m.status !== "active" || m.role !== "C0") throw new RelayError("invalid-state", 409, "member must be active C0");
      if (p.first_heartbeat_at === null) throw new RelayError("not-eligible", 409, "no heartbeat yet");
      return;
    }
    case "clock.resume":
      // Accepted only once relay time is again ahead of the highest time recorded (11.3).
      if (getMeta(db, "clock_suspect") !== "1") throw new RelayError("invalid-state", 409, "clock is not suspect");
      if (!(now > Number(getMeta(db, "clock_high_water") ?? 0))) throw new RelayError("not-eligible", 409, "relay time is not past the high-water mark");
      return;
    case "accept": {
      const s = db.prepare(`SELECT s.state, t.lane FROM submissions s JOIN submission_details x USING(submission_id)
                             JOIN tasks t ON t.task_id = x.task_id WHERE s.submission_id = ?`).get(d.subject);
      if (!s || s.lane !== d.lane || s.state !== "in-review") throw new RelayError("invalid-state", 409, "submission not in review");
      return;
    }
    case "role.change": {
      const m = member();
      if (!ROLES.includes(args.role) || Object.keys(args).some(k => k !== "role")) throw new RelayError("invalid-field", 400, "args.role");
      if (m.status === "revoked") throw new RelayError("role-frozen-revoked", 409, "a revoked member's role is frozen (D-2)");
      if (m.status !== "active" || m.role === null || m.role === args.role) throw new RelayError("invalid-state", 409, "role change");
      if (ROLES.indexOf(args.role) > ROLES.indexOf(m.role)) {
        if (args.role === "C1") throw new RelayError("not-eligible", 409, "C1 is a D0 role.c1");
        const { n, days } = credits(db, d.subject);   // C3, D-C3b: only accepts that are currently effective
        if (args.role === "C2" && (n < 3 || days < 2)) throw new RelayError("not-eligible", 409, "C2 needs 3 accepted contributions on 2 days");
        // Section 10: C2 also needs no open security finding against the member.
        if (args.role === "C2" && hasOpenFinding(db, d.subject)) throw new RelayError("finding-open", 409, "an open security finding blocks C2");
        if (args.role === "C3" && n < 10) throw new RelayError("not-eligible", 409, "C3 needs 10 accepted contributions");
      }
      return;
    }
    case "invite.create": {
      // 5.1: subject is the seat's label for the request; the relay makes the invite id and secret.
      for (const key of Object.keys(args)) if (!["kind", "member_id", "intended_display_name", "intended_platform"].includes(key)) throw new RelayError("unknown-field", 400, `args.${key}`);
      if (!["enroll", "rekey", "rebind"].includes(args.kind)) throw new RelayError("invalid-field", 400, "args.kind");
      for (const f of ["intended_display_name", "intended_platform"])
        if (typeof args[f] !== "string" || !sanitizeText(args[f], { field: `args.${f}`, max: 64 }).length) throw new RelayError("invalid-field", 400, `args.${f}`);
      if (args.kind === "enroll") {
        if (args.member_id !== null) throw new RelayError("invalid-field", 400, "args.member_id");   // B2: null for enroll
        return;
      }
      const m = db.prepare("SELECT m.status, p.lane FROM members m JOIN member_profiles p USING(member_id) WHERE m.member_id = ?").get(typeof args.member_id === "string" ? args.member_id : "");
      if (!m || m.lane !== d.lane) throw new RelayError("invalid-state", 409, "member not in lane");
      // RC-2 (security review of the D items): only an active or suspended member gets a re-key or re-bind invite;
      // a revoked member's recovery is a fresh enrollment.
      if (!["active", "suspended"].includes(m.status)) throw new RelayError("invalid-state", 409, "member not enrolled");
      if (args.kind === "rekey" && (m.status !== "active" || db.prepare("SELECT 1 FROM suspensions WHERE member_id = ? AND ended_at IS NULL").get(args.member_id)))
        throw new RelayError("invalid-state", 409, "re-key needs an active, unsuspended member");   // RD2
      // D1/D3: at most one live attempt (the 9.3 rebind_one_live_attempt); a retry is allowed once the old one is dead.
      if (args.kind === "rebind" && liveAttempt(db, args.member_id)) throw new RelayError("rebind-attempt-live", 409);
      return;
    }
    case "enroll.confirm": {
      // 5.3: subject is the pending member (its C0 row cites this decision); P1 any AC seat but the invite creator.
      const m = member();
      if (m.status !== "pending") throw new RelayError("invalid-state", 409, "member not pending");
      confirmable(db, pendingEnrollment(db, "enroll", d.subject), d, args, now);
      return;
    }
    case "rekey.confirm": {
      // 5.4: subject is the re-key enrollment; the member must be active with no open suspension (RD2).
      const e = pendingEnrollment(db, "rekey", null, d.subject);
      const m = e && db.prepare("SELECT m.status, p.lane FROM members m JOIN member_profiles p USING(member_id) WHERE m.member_id = ?").get(e.member_id);
      if (!m || m.lane !== d.lane) throw new RelayError("invalid-state", 409, "member not in lane");
      if (m.status !== "active" || db.prepare("SELECT 1 FROM suspensions WHERE member_id = ? AND ended_at IS NULL").get(e.member_id))
        throw new RelayError("invalid-state", 409, "re-key needs an active, unsuspended member");
      confirmable(db, e, d, args, now);
      return;
    }
    case "rebind.cancel": {
      // D3: the lane owner ends a live attempt at once (e.g. an invite delivered to the wrong session).
      // Not a recovery: the member stays suspended. Subject: the invite id; args {reason}.
      for (const key of Object.keys(args)) if (key !== "reason") throw new RelayError("unknown-field", 400, `args.${key}`);
      if (typeof args.reason !== "string" || !sanitizeText(args.reason, { field: "args.reason", max: 128 }).length) throw new RelayError("invalid-field", 400, "args.reason");
      const a = attemptOf(db, d.subject);
      if (!a) throw new RelayError("invalid-state", 409, "no re-bind invite");
      if (a.lane !== d.lane) throw new RelayError("invalid-state", 409, "invite not in lane");
      if (a.completed) throw new RelayError("rebind-attempt-completed", 409);
      if (a.dead) throw new RelayError("rebind-attempt-dead", 409);
      return;
    }
    case "rebind.confirm": {
      // Subject: the re-bind enrollment. Its own re-bind suspension is still open (RD2).
      for (const key of Object.keys(args)) throw new RelayError("unknown-field", 400, `args.${key}`);
      const e = db.prepare("SELECT e.kind, e.member_id, e.invite_id, e.public_key, i.voided_at FROM enrollments e JOIN invites i USING(invite_id) WHERE e.id = ?").get(d.subject);
      if (!e || e.kind !== "rebind") throw new RelayError("invalid-state", 409, "no re-bind enrollment");
      // D2: a D1R about a dead attempt never takes effect (9.3 rebind_confirm_needs_live_attempt).
      if (db.prepare("SELECT 1 FROM rebind_ends WHERE invite_id = ?").get(e.invite_id)) throw new RelayError("rebind-attempt-dead", 409);
      if (e.voided_at !== null) throw new RelayError("invalid-state", 409, "invite voided");
      if (db.prepare("SELECT status FROM members WHERE member_id = ?").get(e.member_id).status === "revoked") throw new RelayError("invalid-state", 409, "member revoked");
      if (!db.prepare("SELECT 1 FROM suspensions WHERE member_id = ? AND reason = 'rebind' AND invite_id = ? AND ended_at IS NULL").get(e.member_id, e.invite_id))
        throw new RelayError("invalid-state", 409, "re-bind not open");
      if (db.prepare("SELECT status FROM keys WHERE public_key = ?").get(e.public_key)?.status !== "pending") throw new RelayError("invalid-state", 409, "re-bind key not pending");
      return;
    }
    case "reinstate":
      // D3: return on the existing key. Needs >= 1 active key, at proposal and at effect (a pending
      // reinstate that loses it lapses with cause no-active-key). Its effect kills any live attempt.
      if (member().status !== "suspended") throw new RelayError("invalid-state", 409, "member not suspended");
      if (activeKeys(db, d.subject) === 0) throw new RelayError("no-active-key", 409);
      return;
    case "suspend": {
      const m = db.prepare("SELECT status FROM members WHERE member_id = ?").get(d.subject);
      if (!m || m.status === "revoked") throw new RelayError("invalid-state", 409, "member");
      return;
    }
    case "veto": {
      // C3: the owner vetoes a pending D2 or reverses an effective decision; owner records are not reversible.
      const t = db.prepare("SELECT class, state FROM decisions WHERE id = ?").get(d.subject);
      if (!t) throw new RelayError("invalid-state", 409, "decision");
      if (t.class === "OWNER") throw new RelayError("invalid-state", 409, "owner records are not reversible");
      if (!(t.state === "effective" || (t.state === "pending" && t.class === "D2"))) throw new RelayError("invalid-state", 409, "veto needs a pending D2 or an effective decision");
      return;
    }
    case "freeze": if (isFrozen(db)) throw new RelayError("invalid-state", 409, "already frozen"); return;
    case "unfreeze": if (!isFrozen(db)) throw new RelayError("invalid-state", 409, "not frozen"); return;
  }
}

// --- create, verdicts, settle -----------------------------------------------

const DECISION_KEYS = ["v", "id", "class", "action", "subject", "lane", "sponsor", "args", "by", "served_by", "at"];

// invite.create returns its secret once, to the call that created it (5.1); it is never stored.
let inviteOut = null;

/**
 * A fleet principal records a decision. For D0, D1 and D1R an AC seat creator's signature
 * is also its first verdict. An invite.create that takes effect returns `invite` once.
 */
export function createDecision(db, signed, now) {
  inviteOut = null;
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, DECISION_V, now);
    const cls = Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    if (!cls || body.class !== cls) throw new RelayError("unknown-action", 400, String(body.action));
    refuseIfFrozen(db, body.action);
    for (const key of Object.keys(body)) if (!DECISION_KEYS.includes(key)) throw new RelayError("unknown-field", 400, key);
    if (!isRecordId(body.id) || !isRecordId(body.subject)) throw new RelayError("invalid-field", 400, "id/subject");
    requirePermission(principal, cls === "SUSPEND" ? "suspend" : cls === "OWNER" ? body.action : "decision.create");
    if (["D0", "D1", "D2"].includes(cls)) {
      const lane = db.prepare("SELECT owner_seat FROM lanes WHERE lane = ?").get(body.lane ?? "");
      if (!lane) throw new RelayError("invalid-field", 400, "lane");
      // D0 is created by the lane owner (enroll.confirm and rekey.confirm by any AC seat other
      // than the invite creator, P1). Any AC seat may propose a D1 (N3; the lane owner must still
      // approve it) or sponsor a D2.
      if (cls === "D0" && !P1_ACTIONS.includes(body.action) && lane.owner_seat !== principal.principal_id) throw new RelayError("forbidden", 403, "not the lane owner");
    } else if (body.lane !== undefined) throw new RelayError("invalid-field", 400, "lane");
    if (cls === "D2" ? body.sponsor !== principal.principal_id : body.sponsor !== undefined) throw new RelayError("invalid-field", 400, "sponsor");
    checkEligibility(db, body, now);
    // Authors from provenance (V5): the submitting member plus declared fleet co-authors.
    const authors = body.action === "accept"
      ? [db.prepare("SELECT member_id FROM submissions WHERE submission_id = ?").get(body.subject).member_id,
         ...db.prepare("SELECT principal FROM coauthors WHERE submission_id = ?").all(body.subject).map(r => r.principal)]
      : [];
    if (authors.includes(principal.principal_id)) throw new RelayError("author-cannot-approve", 409);
    try {
      // S1: decisions.lane is the signed body's lane, set exactly for D0, D1 and D2.
      db.prepare(`INSERT INTO decisions(id, class, action, subject, sponsor, lane, state, served_by, created_at, body, sig)
                  VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(body.id, cls, body.action, body.subject, body.sponsor ?? null, ["D0", "D1", "D2"].includes(cls) ? body.lane : null, body.served_by, now, jcs(body), sig);
    } catch (error) {
      if (/UNIQUE|PRIMARY KEY/.test(error.message)) throw new RelayError("duplicate-decision", 409);
      throw error;
    }
    const insertAuthor = db.prepare("INSERT INTO decision_authors(decision_id, principal) VALUES (?, ?)");
    for (const author of new Set(authors)) insertAuthor.run(body.id, author);
    // The creator's signed decision record is its implicit verdict at seq 1 (the decision is new, so no earlier one exists).
    if (["D0", "D1", "D1R"].includes(cls) && principal.kind === "ac-seat") insertVerdict(db, body.id, principal, "approve", body.served_by, now, jcs(body), sig, 1, null);
    appendLog(db, "decision", { kind: "decision.created", id: body.id, class: cls, action: body.action, subject: body.subject, by: principal.principal_id, served_by: body.served_by }, now);
    writeOutbox(db, body.id, `commons-relay ${cls} ${body.action} subject=${body.subject} decision=${body.id} by=${principal.principal_id} served_by=${JSON.stringify(body.served_by)} at=${new Date(now).toISOString()}`, now);
    const state = settleInTx(db, body.id, now);
    const invite = inviteOut;
    inviteOut = null;
    return invite ? { id: body.id, state, invite } : { id: body.id, state };
  });
}

const VERDICT_ERRORS = ["author-cannot-approve", "sponsor-excluded", "decision-closed", "approver-not-in-roster", "approval-seq", "confirmer-is-invite-creator",
  "object-d2-only", "implicit-approval", "approver-not-ac-seat"];
/**
 * Insert a verdict at the given position, with its chain link and body hash (9.3 v3.3:
 * approvals_seq, approvals_prev_chain and UNIQUE(decision_id, body_sha256) refuse any other).
 */
function insertVerdict(db, decisionId, principal, verdict, servedBy, now, bodyText, sig, seq, prev) {
  try {
    db.prepare(`INSERT INTO approvals(decision_id, approver, seq, prev, verdict, approver_kind, approver_family, served_by, signed_at, body, body_sha256, sig)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(decisionId, principal.principal_id, seq, prev, verdict, principal.kind, principal.runtime_family, servedBy, now, bodyText, verdictPrev(bodyText), sig);
  } catch (error) {
    const known = VERDICT_ERRORS.find(c => error.message.includes(c));
    if (known) throw new RelayError(known, 409);
    throw error;
  }
  return seq;
}

/**
 * Append one verdict (approve, object, reject, withdraw). Each seat's latest verdict is
 * its current one (A1). The verdict's position is part of what the seat signed (verifier finding B1):
 * `seq` must be the seat's next number on this decision and `prev` the sha256 of the
 * seat's previous signed body there (null at seq 1; a D0, D1 or D1R creator's seq 1 is
 * its decision record). Both are checked in this write transaction, so a captured
 * verdict can never be appended again: after any later verdict by that seat its
 * position is taken, whatever request or nonce carries it.
 */
export function addVerdict(db, signed, now) {
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, APPROVAL_V, now);
    for (const key of Object.keys(body)) if (!["v", "decision_id", "verdict", "seq", "prev", "by", "served_by", "at"].includes(key)) throw new RelayError("unknown-field", 400, key);
    if (!["approve", "object", "reject", "withdraw"].includes(body.verdict)) throw new RelayError("invalid-field", 400, "verdict");
    if (!Number.isSafeInteger(body.seq) || body.seq < 1) throw new RelayError("invalid-field", 400, "seq");
    if (body.prev !== null && !(typeof body.prev === "string" && /^[0-9a-f]{64}$/.test(body.prev))) throw new RelayError("invalid-field", 400, "prev");
    refuseIfFrozen(db, "approve");
    requirePermission(principal, body.verdict);
    const decision = db.prepare("SELECT id FROM decisions WHERE id = ?").get(body.decision_id ?? "");
    if (!decision) throw new RelayError("unknown-decision", 404);
    const last = db.prepare("SELECT seq, body FROM approvals WHERE decision_id = ? AND approver = ? ORDER BY seq DESC LIMIT 1").get(decision.id, principal.principal_id);
    if (body.seq !== (last?.seq ?? 0) + 1) throw new RelayError("approval-seq", 409, `expected seq ${(last?.seq ?? 0) + 1}`);
    // Spec 9.2 / Addendum C1: a wrong prev is refused with the same 409 approval-seq.
    if (body.prev !== (last ? verdictPrev(last.body) : null)) throw new RelayError("approval-seq", 409, "prev does not name the previous verdict");
    const seq = insertVerdict(db, decision.id, principal, body.verdict, body.served_by, now, jcs(body), sig, body.seq, body.prev);
    appendLog(db, "decision", { kind: "verdict", decision_id: decision.id, by: principal.principal_id, seq, verdict: body.verdict, served_by: body.served_by }, now);
    return { decision_id: decision.id, seq, state: settleInTx(db, decision.id, now) };
  });
}
export const addApproval = addVerdict;

/**
 * The family a counted verdict is credited with (C5, spec 9.8): the family of an
 * attestation of exactly that verdict (decision, seat, seq), signed by an active
 * measurer, equal to the family the seat asserted. Otherwise null: the verdict still
 * counts toward the number of approvals, with no family.
 */
function creditedFamily(db, decisionId, approver, seq, servedBy) {
  const asserted = measuredFamily(servedBy);
  if (!asserted) return null;
  const hit = db.prepare(`SELECT 1 FROM served_by_attestations a JOIN fleet_principals f ON f.principal_id = a.measurer
                           WHERE a.decision_id = ? AND a.target_by = ? AND a.target_seq = ? AND a.family = ?
                             AND f.kind = 'measurer' AND f.status = 'active'`).get(decisionId, approver, seq, asserted);
  return hit ? asserted : null;
}

/** Quorum shape from committed rows: each AC seat's latest verdict counts (9.3 reducer contract). */
export function quorum(db, decisionId) {
  const d = db.prepare("SELECT * FROM decisions WHERE id = ?").get(decisionId);
  const latest = db.prepare(`SELECT a.approver, a.seq, a.verdict, a.served_by
                               FROM approvals a JOIN fleet_principals f ON f.principal_id = a.approver
                              WHERE a.decision_id = ? AND f.kind = 'ac-seat' AND f.status = 'active'
                                AND a.seq = (SELECT max(seq) FROM approvals b WHERE b.decision_id = a.decision_id AND b.approver = a.approver)`).all(decisionId);
  const authors = new Set(db.prepare("SELECT principal FROM decision_authors WHERE decision_id = ?").all(decisionId).map(r => r.principal));
  const approve = latest.filter(r => r.verdict === "approve" && !authors.has(r.approver) && r.approver !== d.sponsor);
  const credited = approve.map(r => creditedFamily(db, decisionId, r.approver, r.seq, r.served_by));
  const lane = JSON.parse(d.body).lane;
  const laneOwner = lane ? db.prepare("SELECT owner_seat FROM lanes WHERE lane = ?").get(lane)?.owner_seat : null;
  return {
    approvals: approve.map(r => r.approver),
    // C5: diversity rules count distinct CREDITED families; the roster label and a bare
    // measured: assertion earn nothing.
    families: [...new Set(credited.filter(Boolean))],
    uncredited: approve.filter((r, i) => credited[i] === null).map(r => r.approver),
    laneOwnerApproved: approve.some(r => r.approver === laneOwner),
    objections: latest.filter(r => r.verdict === "object" && r.approver !== d.sponsor).map(r => r.approver),
    rejections: latest.filter(r => r.verdict === "reject").map(r => r.approver),
  };
}

function settleInTx(db, id, now) {
  const d = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
  if (d.state !== "pending") return d.state;
  // A freeze holds every pending effect (9.2 Freeze), except the owner's own unfreeze and veto.
  if (isFrozen(db) && !["unfreeze", "veto"].includes(d.action)) return d.state;
  if (now - d.created_at >= LAPSE_MS) return transition(db, d, "lapsed", now);
  // Board and role effects re-check their preconditions when they take effect: a decision
  // blocked until later must not act on a state that has moved on. An open security finding
  // keeps a C2 promotion pending; any other failed precondition lapses the decision.
  if (RECHECK.has(d.action)) {
    try { checkEligibility(db, JSON.parse(d.body), now); }
    catch (error) { return error.code === "finding-open" ? "pending" : transition(db, d, "lapsed", now, { cause: error.code ?? "precondition" }); }
  }
  const q = quorum(db, id);
  switch (d.class) {
    case "SUSPEND": case "OWNER": return effect(db, d, now);
    // D0: the lane owner, except the P1 confirmations, which any one AC seat but the invite creator signs.
    case "D0": return q.rejections.length || !(P1_ACTIONS.includes(d.action) ? q.approvals.length > 0 : q.laneOwnerApproved) ? "pending" : effect(db, d, now);
    case "D1": {
      if (q.rejections.length || !q.laneOwnerApproved || q.approvals.length < 2 || q.families.length < 2) return "pending";
      const s = db.prepare("SELECT s.state, x.kind, x.body, x.body_sha256 FROM submissions s JOIN submission_details x USING(submission_id) WHERE s.submission_id = ?").get(d.subject);
      if (s.state !== "in-review") return "pending";
      if (s.kind === "patch") {
        const verified = db.prepare(`SELECT 1 FROM verify_results v JOIN fleet_principals f ON f.principal_id = v.verifier
                                      WHERE v.submission_id = ? AND v.passed = 1 AND v.patch_sha256 = ? AND f.kind = 'verifier'`).get(d.subject, s.body_sha256);
        if (!verified) return "pending";
        if (touchesSecurityPath(JSON.parse(s.body).map(f => f.path), securityPaths(db))) {
          const sec = db.prepare(`SELECT 1 FROM security_approvals a JOIN fleet_principals f ON f.principal_id = a.reviewer
                                   WHERE a.submission_id = ? AND f.kind = 'security'`).get(d.subject);
          if (!sec) return "pending";
        }
      }
      return effect(db, d, now);
    }
    case "D1R":
      // 9.2: two AC seats on two measured families, neither the invite creator (the 9.3
      // trigger refuses that approval); a reject blocks (A1); effect only after the
      // owner-visible posting is confirmed (5.4).
      if (q.rejections.length || q.approvals.length < 2 || q.families.length < 2) return "pending";
      if (d.owner_posted_at === null) return "pending";
      return effect(db, d, now);
    case "D2":
      // A live non-sponsor objection, or any rejection, blocks until withdrawn (A1).
      if (q.objections.length || q.rejections.length) return "pending";
      if (q.approvals.length < 3 || q.families.length < 2) return "pending";
      if (d.owner_posted_at === null || d.effect_at === null || now < d.effect_at) return "pending";
      return effect(db, d, now);
    default: return "pending";
  }
}

const RECHECK = new Set(["task.close", "task.assign", "claim.release", "progress.accept", "review.changes", "review.reject", "role.c1", "role.change",
  "reinstate", "rebind.confirm", "invite.create", "enroll.confirm", "rekey.confirm", "rebind.cancel"]);

function transition(db, d, state, now, extra = {}) {
  db.prepare("UPDATE decisions SET state = ? WHERE id = ?").run(state, d.id);
  appendLog(db, "decision", { kind: `decision.${state}`, id: d.id, ...extra }, now);
  return state;
}

/**
 * Open a suspension (P3, 9.4) inside the caller's transaction. The 9.3 trigger suspends
 * the member, releases its live claims and holds its in-review submissions; this reopens
 * the released tasks (attempts unchanged), holds the held ones and drops pending seat
 * messages. Used by the suspend effect and, for reason "rebind", by the L1 rebind invite.
 */
export function openSuspensionInTx(db, { memberId, reason, decisionId = null, inviteId = null, by, now }) {
  const released = db.prepare("SELECT task_id FROM claims WHERE member_id = ? AND state = 'live'").all(memberId).map(r => r.task_id);
  const held = db.prepare("SELECT x.task_id FROM submissions s JOIN submission_details x USING(submission_id) WHERE s.member_id = ? AND s.state = 'in-review'").all(memberId).map(r => r.task_id);
  db.prepare("INSERT INTO suspensions(id, member_id, reason, decision_id, invite_id, started_at, ended_at, ended_by_decision) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)")
    .run(randomUUID(), memberId, reason, decisionId, inviteId, now);
  for (const t of released) db.prepare("UPDATE tasks SET status = 'open', updated_at = ? WHERE task_id = ?").run(now, t);
  for (const t of held) db.prepare("UPDATE tasks SET status = 'held', updated_at = ? WHERE task_id = ?").run(now, t);
  db.prepare("UPDATE seat_feed SET state = 'dropped' WHERE member_id = ? AND state = 'pending'").run(memberId);
  const ref = reason === "decision" ? { decision: decisionId } : { invite: inviteId };
  alert(db, now, "suspension", memberId, { ...ref, by });
  appendLog(db, "security", { kind: "suspension", member_id: memberId, ...ref, by }, now);
}

// --- re-bind attempts (the D items, spec 5.4) -------------------------------------------
// An attempt is a re-bind invite I, the suspension S its invite.create opened, the enrollment E
// if I was spent, and any D1R about E. Completed: a D1R about E is (or was) effective. Dead: a
// rebind_ends row exists for I. Live: neither. At most one live attempt per member (9.3).

const activeKeys = (db, memberId) =>
  db.prepare("SELECT count(*) n FROM keys WHERE principal_kind = 'member' AND principal_id = ? AND status = 'active'").get(memberId).n;

/** The attempt of a re-bind invite, or null when the invite is not a re-bind. */
export function attemptOf(db, inviteId) {
  const i = db.prepare(`SELECT i.*, x.lane FROM invites i LEFT JOIN invite_details x USING(invite_id) WHERE i.invite_id = ? AND i.kind = 'rebind'`).get(typeof inviteId === "string" ? inviteId : "");
  if (!i) return null;
  const e = db.prepare("SELECT * FROM enrollments WHERE invite_id = ?").get(i.invite_id) ?? null;
  const completed = !!e && !!db.prepare("SELECT 1 FROM decisions WHERE class = 'D1R' AND subject = ? AND state IN ('effective','reversed')").get(e.id);
  const dead = !!db.prepare("SELECT 1 FROM rebind_ends WHERE invite_id = ?").get(i.invite_id);
  return { ...i, enrollment: e, completed, dead, live: !completed && !dead };
}

/** The member's live attempt: an open re-bind suspension whose invite has no rebind_ends row. */
export const liveAttempt = (db, memberId) => db.prepare(`SELECT s.invite_id FROM suspensions s WHERE s.member_id = ? AND s.reason = 'rebind'
  AND s.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = s.invite_id)`).get(memberId) ?? null;

/**
 * Record an attempt's death once (D2): pending D1Rs about its enrollment lapse with `lapseCause`,
 * a rebind_ends row (9.3 rebind_ends_only_dead checks it), and, once each, the security-log event
 * rebind.dead, an alert to seats and the owner line rebind.dead:<invite_id>. The caller has already
 * made the attempt dead in fact (invite voided or expired, or the spent key revoked).
 */
function recordDeathInTx(db, inviteId, cause, decisionId, now, lapseCause) {
  const i = db.prepare("SELECT invite_id, member_id FROM invites WHERE invite_id = ?").get(inviteId);
  const e = db.prepare("SELECT id FROM enrollments WHERE invite_id = ?").get(inviteId);
  if (e) for (const d of db.prepare("SELECT * FROM decisions WHERE class = 'D1R' AND subject = ? AND state = 'pending'").all(e.id))
    transition(db, d, "lapsed", now, { cause: lapseCause });
  db.prepare("INSERT INTO rebind_ends(invite_id, cause, decision_id, at) VALUES (?, ?, ?, ?)").run(inviteId, cause, decisionId, now);
  appendLog(db, "security", { kind: "rebind.dead", member_id: i.member_id, invite_id: inviteId, cause, decision: decisionId }, now);
  alert(db, now, "rebind.dead", i.member_id, { invite_id: inviteId, cause, decision: decisionId });
  writeOutbox(db, `rebind.dead:${inviteId}`, `commons-relay rebind.dead invite=${inviteId} member=${i.member_id} cause=${cause}${decisionId ? ` decision=${decisionId}` : ""} at=${new Date(now).toISOString()}`, now);
}

/** Kill a live attempt (cancel, reversal, reinstate): void it if unspent, else revoke its pending key; then record the death. */
function killAttemptInTx(db, inviteId, cause, decisionId, now, lapseCause) {
  const e = db.prepare("SELECT public_key FROM enrollments WHERE invite_id = ?").get(inviteId);
  if (e) db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE public_key = ? AND status = 'pending'").run(now, e.public_key);
  else db.prepare("UPDATE invites SET voided_at = ? WHERE invite_id = ? AND voided_at IS NULL").run(now, inviteId);
  recordDeathInTx(db, inviteId, cause, decisionId, now, lapseCause);
}

/** End every open re-bind suspension of the member's dead attempts, citing `decisionId` (D3 retry, reinstate). */
function endDeadRebindSuspensionsInTx(db, memberId, decisionId, now) {
  db.prepare(`UPDATE suspensions SET ended_at = ?, ended_by_decision = ? WHERE member_id = ? AND reason = 'rebind' AND ended_at IS NULL
              AND EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = suspensions.invite_id)`).run(now, decisionId, memberId);
}

/**
 * RC-1 (security review of the D items): before a reversal ends suspensions (those matching `where`), if the
 * member is not revoked, has no active key, and no other suspension would stay open, open a decision
 * suspension citing the veto first. A keyless member then leaves only by a completed owner re-bind
 * invite (which ends only its own suspension) followed by a D2 reinstate (which needs an active key).
 */
function keylessGuardInTx(db, memberId, veto, owner, now, where, params) {
  const m = db.prepare("SELECT status FROM members WHERE member_id = ?").get(memberId);
  if (!m || m.status === "revoked" || activeKeys(db, memberId) > 0) return false;
  const others = db.prepare(`SELECT count(*) n FROM suspensions WHERE member_id = ? AND ended_at IS NULL AND NOT (${where})`).get(memberId, ...params).n;
  if (others > 0) return false;
  openSuspensionInTx(db, { memberId, reason: "decision", decisionId: veto.id, by: owner, now });
  return true;
}

/**
 * The sweep's deaths (D2), called inside its transaction (never while frozen or clock-suspect; the
 * sweep returns before this). invite-expired: an unspent re-bind invite at or past expires_at.
 * enrollment-expired: the 72 h rule now covers enroll, rekey and rebind (5.3): the pending key is
 * revoked for ever, and a re-bind attempt is recorded dead with its pending D1Rs lapsed.
 */
export function expireInTx(db, now) {
  const stale = db.prepare(`SELECT e.id, e.kind, e.member_id, e.public_key, e.invite_id FROM enrollments e JOIN keys k USING(public_key)
                             WHERE e.confirmed_by IS NULL AND k.status = 'pending' AND e.spent_at + ? <= ?`).all(ENROLLMENT_TTL_MS, now);
  for (const e of stale) {
    if (e.kind === "rebind" && attemptOf(db, e.invite_id)?.completed) continue;
    db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE public_key = ? AND status = 'pending'").run(now, e.public_key);
    appendLog(db, "enrollment", { kind: "enrollment.expired", enrollment: e.id, enrollment_kind: e.kind, member_id: e.member_id }, now);
    if (e.kind === "rebind" && !db.prepare("SELECT 1 FROM rebind_ends WHERE invite_id = ?").get(e.invite_id))
      recordDeathInTx(db, e.invite_id, "enrollment-expired", null, now, "enrollment-expired");
  }
  const unspent = db.prepare(`SELECT i.invite_id FROM invites i WHERE i.kind = 'rebind' AND i.expires_at <= ? AND i.voided_at IS NULL
                               AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.invite_id = i.invite_id)
                               AND NOT EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = i.invite_id)`).all(now);
  for (const { invite_id } of unspent) recordDeathInTx(db, invite_id, "invite-expired", null, now, "invite-expired");
  return { enrollments: stale.length, invites: unspent.length };
}

/**
 * Void an invite after the failure budget (5.2: five failures against one invite). The counting is
 * the L1 request side; this is the relay's effect, which L1 calls and L0 tests drive directly. An
 * unspent re-bind invite's attempt is recorded dead (invite-voided).
 */
export function voidInvite(db, inviteId, now) {
  return tx(db, () => {
    const i = db.prepare("SELECT * FROM invites WHERE invite_id = ?").get(typeof inviteId === "string" ? inviteId : "");
    if (!i) throw new RelayError("unknown-invite", 404);
    // D1-4: the void path records no death while frozen or while the clock is suspect.
    if (isFrozen(db)) throw new RelayError("frozen", 503);
    if (getMeta(db, "clock_suspect") === "1") throw new RelayError("clock-suspect", 503);
    if (i.voided_at !== null) throw new RelayError("invalid-state", 409, "invite already voided");
    if (db.prepare("SELECT 1 FROM enrollments WHERE invite_id = ?").get(i.invite_id)) throw new RelayError("invalid-state", 409, "invite spent");
    db.prepare("UPDATE invites SET voided_at = ? WHERE invite_id = ?").run(now, i.invite_id);
    alert(db, now, "invite.voided", i.member_id, { invite_id: i.invite_id, reason: "failure-budget" });
    appendLog(db, "enrollment", { kind: "invite.voided", invite_id: i.invite_id, invite_kind: i.kind }, now);
    if (i.kind === "rebind" && !db.prepare("SELECT 1 FROM rebind_ends WHERE invite_id = ?").get(i.invite_id))
      recordDeathInTx(db, i.invite_id, "invite-voided", null, now, "invite-voided");
    return { invite_id: i.invite_id, voided_at: now };
  });
}

/** A member back to active (no open suspension) has its held submissions back in review. */
function resumeHeld(db, memberId, now) {
  if (db.prepare("SELECT status FROM members WHERE member_id = ?").get(memberId).status !== "active") return;
  const held = db.prepare("SELECT x.task_id FROM submissions s JOIN submission_details x USING(submission_id) WHERE s.member_id = ? AND s.state = 'held'").all(memberId).map(r => r.task_id);
  db.prepare("UPDATE submissions SET state = 'in-review' WHERE member_id = ? AND state = 'held'").run(memberId);
  for (const t of held) db.prepare("UPDATE tasks SET status = 'in-review', updated_at = ? WHERE task_id = ? AND status = 'held'").run(now, t);
}

/**
 * RD3, 9.6: a member's re-bind count is the number of D1R rebind.confirm decisions
 * about it that became effective (a later owner reversal does not un-count one).
 * Refused, pending, lapsed and withdrawn re-binds do not count.
 */
export const rebindCount = (db, memberId) => db.prepare(`SELECT count(*) n FROM decisions d JOIN enrollments e ON e.id = d.subject
   WHERE d.class = 'D1R' AND d.action = 'rebind.confirm' AND d.state IN ('effective','reversed') AND e.kind = 'rebind' AND e.member_id = ?`).get(memberId).n;

/** The seat confirmation view of a re-bind (5.4, 9.6): what a seat sees before it signs, including the count so far. */
export function rebindConfirmationView(db, enrollmentId) {
  const e = db.prepare(`SELECT e.id, e.member_id, e.invite_id, e.public_key, e.spent_at, k.agent, i.created_by
                          FROM enrollments e JOIN keys k USING(public_key) JOIN invites i USING(invite_id) WHERE e.id = ? AND e.kind = 'rebind'`).get(enrollmentId);
  if (!e) throw new RelayError("unknown-enrollment", 404);
  const open = db.prepare("SELECT reason FROM suspensions WHERE member_id = ? AND ended_at IS NULL ORDER BY started_at, id").all(e.member_id).map(r => r.reason);
  return {
    enrollment_id: e.id, member_id: e.member_id, invite_id: e.invite_id, invite_created_by: e.created_by,
    new_agent: e.agent, new_public_key: e.public_key, requested_at: e.spent_at,
    rebind_count: rebindCount(db, e.member_id), open_suspensions: open,
    // Addendum D6: the member's dead attempts, which never count.
    dead_attempts: db.prepare(`SELECT r.invite_id, r.cause, r.decision_id, r.at FROM rebind_ends r JOIN invites i USING(invite_id)
                                WHERE i.member_id = ? ORDER BY r.at, r.invite_id`).all(e.member_id).map(r => ({ ...r })),
  };
}

/** Eligibility credit (10, C3, D-C3b): contributions whose D1 accept is currently effective. */
export function credits(db, memberId) {
  return { ...db.prepare(`SELECT count(*) n, count(DISTINCT c.day) days FROM contributions c JOIN decisions d ON d.id = c.decision_id
                           WHERE c.member_id = ? AND d.state = 'effective'`).get(memberId) };
}
const qualifies = (db, memberId, role) => {
  const { n, days } = credits(db, memberId);
  return role === "C2" ? n >= 3 && days >= 2 && !hasOpenFinding(db, memberId) : role === "C3" ? n >= 10 : true;
};

/** Release a member's live claims (no attempt counted) and reopen their tasks. */
function releaseClaims(db, claims, reason, now) {
  for (const c of claims) {
    db.prepare("UPDATE claims SET state = 'released', released_reason = ?, released_at = ? WHERE claim_id = ? AND state = 'live'").run(reason, now, c.claim_id);
    db.prepare("UPDATE tasks SET status = 'open', updated_at = ? WHERE task_id = ? AND status = 'claimed'").run(now, c.task_id);
  }
  return claims.map(c => c.claim_id);
}

/**
 * C3 (spec 9.7): the compensating effects of an owner reversal, in the veto's transaction,
 * after the veto is effective and the target is reversed. History stays; every effect is a
 * new row or a forward state change, logged with its cause, plus one owner-visible line.
 */
function reverseEffects(db, t, veto, owner, now) {
  const cause = `reversal of ${t.id}`;
  const effects = [];
  const log = (effect, extra = {}) => { effects.push(effect); appendLog(db, "decision", { kind: "reversal.effect", cause, decision: t.id, veto: veto.id, effect, ...extra }, now); };
  switch (t.action) {
    case "accept": {
      // The submission becomes reversed (terminal); its task goes to triage with no attempt counted.
      // Accepted code is never auto-reverted. The accept stops counting toward eligibility at once.
      const s = db.prepare("SELECT s.member_id, x.task_id FROM submissions s JOIN submission_details x USING(submission_id) WHERE s.submission_id = ?").get(t.subject);
      db.prepare("UPDATE submissions SET state = 'reversed' WHERE submission_id = ? AND state = 'accepted'").run(t.subject);
      db.prepare("UPDATE tasks SET status = 'needs-triage', updated_at = ? WHERE task_id = ?").run(now, s.task_id);
      log("submission.reversed", { submission_id: t.subject, task_id: s.task_id });
      const role = roleOf(db, s.member_id);
      if (!qualifies(db, s.member_id, role)) eligibilityLost(db, s.member_id, role, cause, now);
      break;
    }
    case "role.c1": case "role.change": {
      // Re-project from the member's effective role grants (latest wins), as a new row citing the veto.
      const current = roleOf(db, t.subject);
      // D-2 (S5): a revoked member's role is frozen at revocation. The reversal is
      // still recorded (the target is reversed, this effect is logged, the owner line is written),
      // but no role row is added; the 9.3 trigger roles_frozen_when_revoked would refuse one.
      if (db.prepare("SELECT status FROM members WHERE member_id = ?").get(t.subject).status === "revoked") {
        log("role.unchanged", { role: current, reason: "revoked" });
        break;
      }
      const projected = db.prepare(`SELECT r.role FROM roles r JOIN decisions x ON x.id = r.decision_id WHERE r.member_id = ? AND x.state = 'effective'
                                      AND x.action IN ('enroll.confirm','role.c1','role.change') ORDER BY r.seq DESC LIMIT 1`).get(t.subject)?.role ?? null;
      if (projected === null || projected === current) { log("role.unchanged", { role: current }); break; }
      const seq = 1 + (db.prepare("SELECT max(seq) s FROM roles WHERE member_id = ?").get(t.subject).s ?? 0);
      db.prepare("INSERT INTO roles(member_id, seq, role, decision_id, at) VALUES (?, ?, ?, ?, ?)").run(t.subject, seq, projected, veto.id, now);
      // A lower role: live claims above the new cap are released, newest first, with no attempt counted.
      const live = db.prepare(`SELECT c.claim_id, c.task_id FROM claims c JOIN claim_details x USING(claim_id)
                                WHERE c.member_id = ? AND c.state = 'live' ORDER BY x.created_at DESC, c.rowid DESC`).all(t.subject);
      const over = Math.max(0, live.length - (CLAIM_CAPS[projected] ?? 0));
      log("role.reprojected", { member_id: t.subject, from: current, to: projected, released: releaseClaims(db, live.slice(0, over), "reversal", now) });
      break;
    }
    case "reinstate":
      openSuspensionInTx(db, { memberId: t.subject, reason: "decision", decisionId: veto.id, by: owner, now });
      log("suspension.reopened", { member_id: t.subject });
      break;
    case "suspend":
      // That suspension ends (by the veto); held work returns to review. Released claims are not restored.
      if (keylessGuardInTx(db, t.subject, veto, owner, now, "decision_id = ?", [t.id])) log("suspension.keyless", { member_id: t.subject });
      db.prepare("UPDATE suspensions SET ended_at = ?, ended_by_decision = ? WHERE decision_id = ? AND reason = 'decision' AND ended_at IS NULL").run(now, veto.id, t.id);
      resumeHeld(db, t.subject, now);
      log("suspension.ended", { member_id: t.subject });
      break;
    case "enroll.confirm":
      revokeMemberInTx(db, t.subject, now, cause);
      log("member.revoked", { member_id: t.subject });
      break;
    case "rekey.confirm": case "rebind.confirm": {
      // The key that decision bound is revoked; a decision suspension opens. Older keys stay revoked.
      const e = db.prepare("SELECT member_id, public_key FROM enrollments WHERE id = ?").get(t.subject);
      db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE public_key = ? AND status <> 'revoked'").run(now, e.public_key);
      if (db.prepare("SELECT status FROM members WHERE member_id = ?").get(e.member_id).status !== "revoked")
        openSuspensionInTx(db, { memberId: e.member_id, reason: "decision", decisionId: veto.id, by: owner, now });
      log("key.revoked", { member_id: e.member_id, public_key: e.public_key });
      break;
    }
    case "task.assign": {
      const live = db.prepare("SELECT c.claim_id, c.task_id FROM claim_origins o JOIN claims c USING(claim_id) WHERE o.decision_id = ? AND c.state = 'live'").all(t.id);
      log(live.length ? "claim.released" : "record-only", { released: releaseClaims(db, live, "reversal", now) });
      break;
    }
    case "invite.create": {
      // Addendum D4 (replaces C3's row), any kind. Completed = record-only (reverse the confirmation
      // itself). Not yet completed: the reversal kills the attempt.
      const inv = db.prepare("SELECT * FROM invites WHERE decision_id = ?").get(t.id);
      const e = db.prepare("SELECT * FROM enrollments WHERE invite_id = ?").get(inv.invite_id);
      const completed = inv.kind === "rebind" ? !!attemptOf(db, inv.invite_id)?.completed : !!e && e.confirmed_by !== null;
      if (completed) { log("record-only", { invite_id: inv.invite_id }); break; }
      if (inv.kind === "rebind") {
        if (!db.prepare("SELECT 1 FROM rebind_ends WHERE invite_id = ?").get(inv.invite_id))
          killAttemptInTx(db, inv.invite_id, "reversed", veto.id, now, `reversal of ${veto.id}`);
        // RC-1: never leave a non-revoked member active without an active key.
        if (keylessGuardInTx(db, inv.member_id, veto, owner, now, "invite_id = ?", [inv.invite_id])) log("suspension.keyless", { member_id: inv.member_id });
        db.prepare("UPDATE suspensions SET ended_at = ?, ended_by_decision = ? WHERE invite_id = ? AND reason = 'rebind' AND ended_at IS NULL").run(now, veto.id, inv.invite_id);
        resumeHeld(db, inv.member_id, now);
        log("attempt.reversed", { invite_id: inv.invite_id, member_id: inv.member_id });
        break;
      }
      if (!e) {
        db.prepare("UPDATE invites SET voided_at = ? WHERE invite_id = ? AND voided_at IS NULL").run(now, inv.invite_id);
        log("invite.voided", { invite_id: inv.invite_id });
        break;
      }
      // Spent, unconfirmed: the pending key is revoked for ever (one key ever).
      db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE public_key = ? AND status = 'pending'").run(now, e.public_key);
      if (inv.kind === "enroll") {
        revokeMemberInTx(db, e.member_id, now, cause);   // the pending member becomes revoked
        log("member.revoked", { invite_id: inv.invite_id, member_id: e.member_id });
      } else log("pending-key.revoked", { invite_id: inv.invite_id, member_id: e.member_id });   // rekey: the current key stays
      break;
    }
    default:
      // task.open, task.close, progress.accept, claim.release, clock.resume and the review outcomes: record-only.
      log("record-only");
      alert(db, now, "reversal.record-only", t.subject, { decision: t.id, action: t.action, veto: veto.id });
  }
  appendLog(db, "security", { kind: "reversal", decision: t.id, action: t.action, veto: veto.id, effects }, now);
  writeOutbox(db, `reversal:${t.id}`, `commons-relay reversal of ${t.id} (${t.action} subject=${t.subject}) by veto=${veto.id}: ${effects.join(", ")} at=${new Date(now).toISOString()}`, now);
}

/** C3: a role whose credit is gone is not changed automatically; the owner and seats are told (security log, alert, owner line). */
function eligibilityLost(db, memberId, role, cause, now) {
  alert(db, now, "eligibility.lost", memberId, { role, cause });
  appendLog(db, "security", { kind: "eligibility.lost", member_id: memberId, role, cause }, now);
  writeOutbox(db, `eligibility.lost:${memberId}`, `commons-relay eligibility.lost member=${memberId} role=${role} cause=${JSON.stringify(cause)} at=${new Date(now).toISOString()}`, now);
}

/** Revoke a member (5.4, 9.4): every key revoked for ever; the 9.3 trigger releases claims and holds submissions. */
function revokeMemberInTx(db, memberId, now, cause) {
  const released = db.prepare("SELECT task_id FROM claims WHERE member_id = ? AND state = 'live'").all(memberId).map(r => r.task_id);
  const held = db.prepare("SELECT x.task_id FROM submissions s JOIN submission_details x USING(submission_id) WHERE s.member_id = ? AND s.state = 'in-review'").all(memberId).map(r => r.task_id);
  db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE principal_kind = 'member' AND principal_id = ? AND status <> 'revoked'").run(now, memberId);
  db.prepare("UPDATE members SET status = 'revoked', updated_at = ? WHERE member_id = ?").run(now, memberId);
  for (const t of released) db.prepare("UPDATE tasks SET status = 'open', updated_at = ? WHERE task_id = ? AND status = 'claimed'").run(now, t);
  for (const t of held) db.prepare("UPDATE tasks SET status = 'held', updated_at = ? WHERE task_id = ?").run(now, t);
  db.prepare("UPDATE seat_feed SET state = 'dropped' WHERE member_id = ? AND state = 'pending'").run(memberId);
  alert(db, now, "revocation", memberId, { cause });
  appendLog(db, "security", { kind: "revocation", member_id: memberId, cause }, now);
}

/** Mark effective first (the 9.3 role and suspension guards require it), then apply. */
function effect(db, d, now) {
  db.prepare("UPDATE decisions SET state = 'effective' WHERE id = ?").run(d.id);
  const body = JSON.parse(d.body);
  switch (d.action) {
    case "task.open": {
      const a = taskArgs(body.args);
      db.prepare(`INSERT INTO tasks(task_id, title, description, lane, kind, acceptance, paths, base_commit, status, opened_by, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
        .run(d.subject, a.title, a.description, body.lane, a.kind, jcs(a.acceptance), jcs(a.paths), a.base_commit, body.by, now, now);
      break;
    }
    case "task.close":
      db.prepare("UPDATE tasks SET status = 'closed', updated_at = ? WHERE task_id = ?").run(now, d.subject);
      break;
    case "claim.release": {
      const c = db.prepare("SELECT task_id FROM claims WHERE claim_id = ? AND state = 'live'").get(d.subject);
      if (c) {
        db.prepare("UPDATE claims SET state = 'released', released_reason = 'seat', released_at = ? WHERE claim_id = ?").run(now, d.subject);
        db.prepare("UPDATE tasks SET status = 'open', updated_at = ? WHERE task_id = ?").run(now, c.task_id);
      }
      break;
    }
    case "task.assign": {
      const m = db.prepare("SELECT role FROM members WHERE member_id = ?").get(body.args.member_id);
      const c = openClaim(db, { taskId: d.subject, memberId: body.args.member_id, role: m.role, leaseMs: body.args.lease_ms, now, decisionId: d.id });
      notify(db, body.args.member_id, `notice-${d.id}`, "claim.assigned", { decision: d.id, ...c }, now);
      break;
    }
    case "progress.accept": {
      const pr = db.prepare("SELECT member_id FROM progress WHERE claim_id = ? AND record_id = ?").get(d.subject, body.args.record_id);
      db.prepare("INSERT INTO progress_acceptances(member_id, record_id, decision_id, at) VALUES (?, ?, ?, ?)").run(pr.member_id, body.args.record_id, d.id, now);
      notify(db, pr.member_id, `notice-${d.id}`, "progress.accepted", { decision: d.id, claim_id: d.subject, record_id: body.args.record_id }, now);
      break;
    }
    case "review.changes": {
      // R7 / 11.3: the submission goes to "changes" and the claimant gets a NEW claim
      // (new claim_id, epoch + 1, new lease); the submitted claim stays closed.
      const x = db.prepare(`SELECT x.task_id, s.member_id, d2.lease_ms FROM submission_details x JOIN submissions s USING(submission_id)
                             JOIN claim_details d2 ON d2.claim_id = x.claim_id WHERE x.submission_id = ?`).get(d.subject);
      db.prepare("UPDATE submissions SET state = 'changes' WHERE submission_id = ?").run(d.subject);
      const role = db.prepare("SELECT role FROM members WHERE member_id = ?").get(x.member_id).role;
      const c = openClaim(db, { taskId: x.task_id, memberId: x.member_id, role, leaseMs: body.args?.lease_ms ?? x.lease_ms, now, decisionId: d.id });
      notify(db, x.member_id, `notice-${d.id}`, "claim.reissued", { decision: d.id, submission_id: d.subject, ...c }, now);
      break;
    }
    case "review.reject": {
      // 11.2: reject -> open (attempts + 1), or closed; three attempts go to triage.
      const x = db.prepare("SELECT x.task_id, s.member_id FROM submission_details x JOIN submissions s USING(submission_id) WHERE x.submission_id = ?").get(d.subject);
      db.prepare("UPDATE submissions SET state = 'rejected' WHERE submission_id = ?").run(d.subject);
      const attempts = db.prepare("SELECT attempts FROM tasks WHERE task_id = ?").get(x.task_id).attempts + 1;
      const status = body.args.disposition === "close" ? "closed" : attempts >= 3 ? "needs-triage" : "open";
      db.prepare("UPDATE tasks SET attempts = ?, status = ?, updated_at = ? WHERE task_id = ?").run(attempts, status, now, x.task_id);
      notify(db, x.member_id, `notice-${d.id}`, "submission.rejected", { decision: d.id, submission_id: d.subject, task_status: status }, now);
      break;
    }
    case "clock.resume":
      setMeta(db, "clock_suspect", "0");
      setMeta(db, "clock_high_water", String(now));
      appendLog(db, "security", { kind: "clock.resumed", decision: d.id }, now);
      break;
    case "role.c1": case "role.change": {
      const seq = 1 + (db.prepare("SELECT max(seq) s FROM roles WHERE member_id = ?").get(d.subject).s ?? 0);
      db.prepare("INSERT INTO roles(member_id, seq, role, decision_id, at) VALUES (?, ?, ?, ?, ?)")
        .run(d.subject, seq, d.action === "role.c1" ? "C1" : body.args.role, d.id, now);
      break;
    }
    case "accept": {
      const x = db.prepare("SELECT x.task_id, s.member_id FROM submission_details x JOIN submissions s USING(submission_id) WHERE x.submission_id = ?").get(d.subject);
      db.prepare("UPDATE submissions SET state = 'accepted' WHERE submission_id = ?").run(d.subject);
      db.prepare("UPDATE tasks SET status = 'accepted', updated_at = ? WHERE task_id = ?").run(now, x.task_id);
      db.prepare("INSERT INTO contributions(submission_id, member_id, decision_id, accepted_at, day) VALUES (?, ?, ?, ?, ?)")
        .run(d.subject, x.member_id, d.id, now, new Date(now).toISOString().slice(0, 10));
      break;
    }
    case "suspend":
      openSuspensionInTx(db, { memberId: d.subject, reason: "decision", decisionId: d.id, by: body.by, now });
      break;
    case "reinstate": {
      // D3: first kill any live attempt (cause reinstated: the higher class wins), then end every open
      // decision suspension and every open re-bind suspension of a dead attempt. The 9.3 trigger
      // reactivates the member when none is open.
      const live = liveAttempt(db, d.subject);
      if (live) killAttemptInTx(db, live.invite_id, "reinstated", d.id, now, "reinstated");
      db.prepare("UPDATE suspensions SET ended_at = ?, ended_by_decision = ? WHERE member_id = ? AND reason = 'decision' AND ended_at IS NULL").run(now, d.id, d.subject);
      endDeadRebindSuspensionsInTx(db, d.subject, d.id, now);
      resumeHeld(db, d.subject, now);
      break;
    }
    case "rebind.cancel":
      killAttemptInTx(db, d.subject, "cancelled", d.id, now, "rebind-cancelled");
      break;
    case "invite.create": {
      // 5.1: the relay makes a 128-bit invite id and a 256-bit secret, stores only sha256(secret),
      // and returns the secret once, to the creating call. A rebind invite suspends the member now (C4).
      const a = body.args, inviteId = randomBytes(16).toString("hex"), secret = randomBytes(32);
      const memberId = a.kind === "enroll" ? null : a.member_id;
      // The D items: invites.decision_id binds the invite to its signed invite.create (9.3 invites_need_decision).
      db.prepare("INSERT INTO invites(invite_id, kind, member_id, created_by, decision_id, secret_sha256, created_at, expires_at, voided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
        .run(inviteId, a.kind, memberId, body.by, d.id, sha256Hex(secret), now, now + INVITE_TTL_MS);
      db.prepare("INSERT INTO invite_details(invite_id, decision_id, lane, intended_display_name, intended_platform) VALUES (?, ?, ?, ?, ?)")
        .run(inviteId, d.id, body.lane, a.intended_display_name, a.intended_platform);
      if (a.kind === "rebind") {
        // D3 retry (supersession): open the new attempt's suspension FIRST, then end every dead
        // attempt's open suspension citing this invite.create, so the member is never active in between.
        openSuspensionInTx(db, { memberId, reason: "rebind", inviteId, by: body.by, now });
        endDeadRebindSuspensionsInTx(db, memberId, d.id, now);
      }
      appendLog(db, "enrollment", { kind: "invite.created", invite_id: inviteId, invite_kind: a.kind, member_id: memberId, decision: d.id, by: body.by }, now);
      inviteOut = { invite_id: inviteId, secret: secret.toString("hex"), kind: a.kind, member_id: memberId, expires_at: now + INVITE_TTL_MS, namespace: "agentnet" };
      break;
    }
    case "enroll.confirm": {
      const e = pendingEnrollment(db, "enroll", d.subject);
      db.prepare("UPDATE enrollments SET confirmed_by = ?, confirmed_at = ?, owner_line_ref = ? WHERE id = ?").run(body.by, now, body.args.owner_line_ref, e.id);
      db.prepare("UPDATE keys SET status = 'active' WHERE public_key = ?").run(e.public_key);
      db.prepare("UPDATE members SET status = 'active', updated_at = ? WHERE member_id = ?").run(now, d.subject);
      const seq = 1 + (db.prepare("SELECT max(seq) s FROM roles WHERE member_id = ?").get(d.subject).s ?? 0);
      db.prepare("INSERT INTO roles(member_id, seq, role, decision_id, at) VALUES (?, ?, 'C0', ?, ?)").run(d.subject, seq, d.id, now);
      appendLog(db, "enrollment", { kind: "enroll.confirmed", member_id: d.subject, enrollment: e.id, decision: d.id, by: body.by }, now);
      alert(db, now, "enrollment", d.subject, { enrollment: e.id, decision: d.id, by: body.by, invite_created_by: e.created_by });
      break;
    }
    case "rekey.confirm": {
      // 5.4: the old key is revoked; the new key becomes the member's one active key.
      const e = db.prepare("SELECT * FROM enrollments WHERE id = ?").get(d.subject);
      db.prepare("UPDATE enrollments SET confirmed_by = ?, confirmed_at = ?, owner_line_ref = ? WHERE id = ?").run(body.by, now, body.args.owner_line_ref, e.id);
      db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE principal_kind = 'member' AND principal_id = ? AND public_key <> ? AND status <> 'revoked'")
        .run(now, e.member_id, e.public_key);
      db.prepare("UPDATE keys SET status = 'active' WHERE public_key = ?").run(e.public_key);
      appendLog(db, "security", { kind: "rekey.confirmed", member_id: e.member_id, enrollment: e.id, decision: d.id, by: body.by }, now);
      alert(db, now, "rekey", e.member_id, { enrollment: e.id, decision: d.id, by: body.by });
      break;
    }
    case "rebind.confirm": {
      // 5.4: end only this re-bind's suspension (RD2: a decision suspension stays until a D2
      // reinstate), revoke every older key, and make the re-bound key the member's one active key.
      const e = db.prepare("SELECT id, member_id, invite_id, public_key FROM enrollments WHERE id = ?").get(d.subject);
      db.prepare("UPDATE suspensions SET ended_at = ?, ended_by_decision = ? WHERE member_id = ? AND reason = 'rebind' AND invite_id = ? AND ended_at IS NULL")
        .run(now, d.id, e.member_id, e.invite_id);
      db.prepare("UPDATE keys SET status = 'revoked', revoked_at = ? WHERE principal_kind = 'member' AND principal_id = ? AND public_key <> ? AND status <> 'revoked'")
        .run(now, e.member_id, e.public_key);
      db.prepare("UPDATE keys SET status = 'active' WHERE public_key = ?").run(e.public_key);
      resumeHeld(db, e.member_id, now);
      // RD3, 9.6: the count is recorded; from the second effective re-bind on, exactly one
      // rebind.repeat alert per (member, count). The seat decisions are L0 since Addendum C4.
      const count = rebindCount(db, e.member_id);
      appendLog(db, "security", { kind: "rebind.confirmed", member_id: e.member_id, enrollment: e.id, decision: d.id, count }, now);
      if (count >= 2 && !db.prepare("SELECT 1 FROM alerts WHERE kind = 'rebind.repeat' AND subject = ? AND json_extract(detail, '$.count') = ?").get(e.member_id, count)) {
        alert(db, now, "rebind.repeat", e.member_id, { count, decision: d.id });
        appendLog(db, "security", { kind: "rebind.repeat", member_id: e.member_id, count }, now);
      }
      break;
    }
    case "veto": {
      const target = db.prepare("SELECT * FROM decisions WHERE id = ?").get(d.subject);
      if (target.state === "pending") { transition(db, target, "vetoed", now); break; }
      transition(db, target, "reversed", now);
      reverseEffects(db, target, d, body.by, now);
      break;
    }
    case "freeze":
      setMeta(db, "frozen", "1");
      setMeta(db, "frozen_at", String(now));
      alert(db, now, "freeze", null, { decision: d.id, by: body.by });
      break;
    case "unfreeze": {
      // On unfreeze every live lease is extended by the frozen interval (9.2 Freeze).
      const interval = Math.max(0, now - Number(getMeta(db, "frozen_at") ?? now));
      db.prepare("UPDATE claims SET lease_until = lease_until + ? WHERE state = 'live'").run(interval);
      setMeta(db, "frozen", "0");
      break;
    }
  }
  appendLog(db, "decision", { kind: "decision.effective", id: d.id, action: d.action, subject: d.subject }, now);
  return "effective";
}

/** Re-evaluate every pending decision: lapse after 14 days, D2 effect after its window. */
export function settleAll(db, now) {
  return tx(db, () => db.prepare("SELECT id FROM decisions WHERE state = 'pending' ORDER BY created_at, id").all()
    .map(({ id }) => ({ id, state: settleInTx(db, id, now) })));
}

// --- verification lane, security reviewer, co-authors, owner record ---------

export function recordVerifyResult(db, signed, now) {
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, VERIFY_V, now);
    refuseIfFrozen(db, "verify.result");
    requirePermission(principal, "verify.result");
    const allowed = ["v", "submission_id", "base_commit", "patch_sha256", "image_digest", "network", "checks", "exit_codes", "log_sha256", "by", "served_by", "at"];
    for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new RelayError("unknown-field", 400, key);
    const s = db.prepare("SELECT x.*, t.base_commit FROM submission_details x JOIN tasks t USING(task_id) WHERE x.submission_id = ?").get(body.submission_id ?? "");
    if (!s || s.kind !== "patch") throw new RelayError("invalid-state", 409, "no patch submission");
    if (body.base_commit !== s.base_commit || body.patch_sha256 !== s.body_sha256) throw new RelayError("verify-mismatch", 409);
    if (body.network !== "none") throw new RelayError("verify-network-not-cut", 409);
    const checks = body.checks, codes = body.exit_codes;
    if (!Array.isArray(checks) || !Array.isArray(codes) || !checks.length || checks.length !== codes.length || codes.some(c => !Number.isSafeInteger(c)))
      throw new RelayError("invalid-field", 400, "checks/exit_codes");
    // Pass is derived from the exit codes, never from a claimed flag.
    const passed = codes.every(c => c === 0) ? 1 : 0;
    // N5: one result per verifier and submission; a second is a relay error, not a raw SQLite one.
    if (db.prepare("SELECT 1 FROM verify_results WHERE submission_id = ? AND verifier = ?").get(s.submission_id, principal.principal_id))
      throw new RelayError("duplicate-verify-result", 409);
    db.prepare("INSERT INTO verify_results(submission_id, verifier, passed, patch_sha256, served_by, at, body, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.submission_id, principal.principal_id, passed, body.patch_sha256, body.served_by, now, jcs(body), sig);
    appendLog(db, "decision", { kind: "verify.result", submission_id: s.submission_id, by: principal.principal_id, passed }, now);
    settlePendingFor(db, s.submission_id, now);
    return { submission_id: s.submission_id, passed: passed === 1 };
  });
}

export function recordSecurityApproval(db, signed, now) {
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, SECURITY_V, now);
    refuseIfFrozen(db, "security.approve");
    requirePermission(principal, "security.approve");
    for (const key of Object.keys(body)) if (!["v", "submission_id", "patch_sha256", "by", "served_by", "at"].includes(key)) throw new RelayError("unknown-field", 400, key);
    const s = db.prepare("SELECT * FROM submission_details WHERE submission_id = ?").get(body.submission_id ?? "");
    if (!s || body.patch_sha256 !== s.body_sha256) throw new RelayError("invalid-state", 409, "submission/patch");
    db.prepare("INSERT INTO security_approvals(submission_id, reviewer, served_by, at, body, sig) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.submission_id, principal.principal_id, body.served_by, now, jcs(body), sig);
    appendLog(db, "decision", { kind: "security.approve", submission_id: s.submission_id, by: principal.principal_id }, now);
    settlePendingFor(db, s.submission_id, now);
    return { submission_id: s.submission_id };
  });
}

/** A fleet principal that contributed to a submission declares it before any decision about it (V5). */
export function declareCoauthor(db, signed, now) {
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, COAUTHOR_V, now);
    refuseIfFrozen(db, "coauthor.declare");
    requirePermission(principal, "coauthor.declare");
    for (const key of Object.keys(body)) if (!["v", "submission_id", "by", "served_by", "at"].includes(key)) throw new RelayError("unknown-field", 400, key);
    if (!db.prepare("SELECT 1 FROM submissions WHERE submission_id = ?").get(body.submission_id ?? "")) throw new RelayError("unknown-submission", 404);
    try {
      db.prepare("INSERT INTO coauthors(submission_id, principal, served_by, at, body, sig) VALUES (?, ?, ?, ?, ?, ?)")
        .run(body.submission_id, principal.principal_id, body.served_by, now, jcs(body), sig);
    } catch (error) {
      if (error.message.includes("coauthors-closed")) throw new RelayError("coauthors-closed", 409);
      throw error;
    }
    appendLog(db, "decision", { kind: "coauthor.declare", submission_id: body.submission_id, by: principal.principal_id }, now);
    return { submission_id: body.submission_id, coauthor: principal.principal_id };
  });
}

function settlePendingFor(db, submissionId, now) {
  for (const { id } of db.prepare("SELECT id FROM decisions WHERE subject = ? AND state = 'pending'").all(submissionId)) settleInTx(db, id, now);
}

/** The seat-side mirror confirms the owner-visible line was posted (9.5). Only this sets owner_posted_at. */
export function confirmOwnerRecord(db, signed, now) {
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, OWNER_CONFIRM_V, now);
    requirePermission(principal, "owner-record.confirm");
    for (const key of Object.keys(body)) if (!["v", "outbox_id", "line_sha256", "by", "served_by", "at"].includes(key)) throw new RelayError("unknown-field", 400, key);
    const row = db.prepare("SELECT * FROM owner_record_outbox WHERE id = ?").get(body.outbox_id ?? "");
    if (!row || row.line_sha256 !== body.line_sha256) throw new RelayError("owner-record-mismatch", 409);
    if (row.confirmed_at !== null) throw new RelayError("owner-record-already-confirmed", 409);
    db.prepare("UPDATE owner_record_outbox SET confirmed_at = ?, confirmed_by = ? WHERE id = ?").run(now, principal.principal_id, row.id);
    db.prepare("INSERT INTO owner_record_confirmations(outbox_id, confirmed_by, at, body, sig) VALUES (?, ?, ?, ?, ?)").run(row.id, principal.principal_id, now, jcs(body), sig);
    // Every confirmation has its own decision-log event: the export check reads its acceptance time there.
    appendLog(db, "decision", { kind: "owner-record.confirm", outbox_id: row.id, subject: row.subject, by: principal.principal_id }, now);
    const d = db.prepare("SELECT * FROM decisions WHERE id = ?").get(row.subject);
    if (d && d.owner_posted_at === null) {
      db.prepare("UPDATE decisions SET owner_line_ref = ?, owner_posted_at = ?, effect_at = ? WHERE id = ?")
        .run(row.id, now, d.class === "D2" ? now + D2_WINDOW_MS : null, d.id);
      appendLog(db, "decision", { kind: "owner-record.confirmed", id: d.id, outbox_id: row.id }, now);
      settleInTx(db, d.id, now);
    }
    return { outbox_id: row.id };
  });
}

// --- runtime evidence (C5, spec 9.8) ----------------------------------------

const ATTEST_KEYS = ["v", "target", "session_id", "record_uuid", "response_model", "turn_models", "family", "body_sha256", "tool", "tool_sha256",
  "measured_at", "by", "served_by", "at"];
const ATTEST_ERRORS = ["attest-not-measurer", "attest-body-mismatch", "attest-family-map", "attest-mixed-turn", "measurer-conflict"];
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The measurer files a signed served_by.attest for one verdict (or a creator's implicit
 * seq-1 approve). The 9.3 triggers enforce rules 1-4 (measurer role, target body hash,
 * the policy's model map, an unmixed turn); this checks the per-decision exclusion
 * (the measurer never votes on, authors, sponsors or created the target decision) and
 * rule 5: an attested family other than the seat's asserted one earns nothing and
 * writes a served_by.mismatch security alert. The decision is then re-evaluated.
 */
export function recordAttestation(db, signed, now) {
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, ATTEST_V, now);
    refuseIfFrozen(db, "served_by.attest");
    requirePermission(principal, "served_by.attest");
    for (const key of Object.keys(body)) if (!ATTEST_KEYS.includes(key)) throw new RelayError("unknown-field", 400, key);
    const t = body.target;
    if (!t || typeof t !== "object" || Array.isArray(t) || Object.keys(t).some(k => !["decision_id", "by", "seq"].includes(k))
      || !isRecordId(t.decision_id) || typeof t.by !== "string" || !Number.isSafeInteger(t.seq) || t.seq < 1) throw new RelayError("invalid-field", 400, "target");
    const text = (field, v) => sanitizeText(v, { field, max: 128 });
    for (const field of ["session_id", "record_uuid", "response_model", "family"]) if (typeof body[field] !== "string" || !text(field, body[field]).length) throw new RelayError("invalid-field", 400, field);
    if (!Array.isArray(body.turn_models) || !body.turn_models.length || body.turn_models.length > 64
      || body.turn_models.some((m, i) => typeof m !== "string" || !text(`turn_models[${i}]`, m).length)) throw new RelayError("invalid-field", 400, "turn_models");
    if (!HEX64.test(body.body_sha256 ?? "") || !HEX64.test(body.tool_sha256 ?? "")) throw new RelayError("invalid-field", 400, "body_sha256/tool_sha256");
    if (body.tool !== "model-of") throw new RelayError("invalid-field", 400, "tool");
    if (!Number.isSafeInteger(body.measured_at)) throw new RelayError("invalid-field", 400, "measured_at");
    const d = db.prepare("SELECT id, sponsor, body FROM decisions WHERE id = ?").get(t.decision_id);
    if (!d) throw new RelayError("unknown-decision", 404);
    const m = principal.principal_id;
    if (d.sponsor === m || JSON.parse(d.body).by === m
      || db.prepare("SELECT 1 FROM approvals WHERE decision_id = ? AND approver = ?").get(d.id, m)
      || db.prepare("SELECT 1 FROM decision_authors WHERE decision_id = ? AND principal = ?").get(d.id, m)) throw new RelayError("measurer-conflict", 409);
    const target = db.prepare("SELECT served_by FROM approvals WHERE decision_id = ? AND approver = ? AND seq = ?").get(d.id, t.by, t.seq);
    if (!target) throw new RelayError("invalid-state", 409, "no such verdict");
    const asserted = measuredFamily(target.served_by);
    // D9.3: the response model must match EXACTLY ONE pattern of the current policy's family map
    // (glob on the whole name, case-sensitive). Zero or several matches: no credit and a
    // served_by.mismatch alert. The attestation itself is not stored (the 9.3 attest_family_map
    // trigger refuses it), but the alert is, so this returns instead of throwing.
    const policyVersion = Number(getMeta(db, "policy_version") ?? 0);
    const matches = db.prepare("SELECT family FROM policy_family_map WHERE policy_version = ? AND ? GLOB pattern").all(policyVersion, body.response_model);
    if (matches.length !== 1) {
      const detail = { decision: d.id, seq: t.seq, asserted, attested: body.family, response_model: body.response_model, map_matches: matches.length };
      alert(db, now, "served_by.mismatch", t.by, detail);
      appendLog(db, "security", { kind: "served_by.mismatch", decision_id: d.id, by: t.by, seq: t.seq, asserted, attested: body.family, map_matches: matches.length }, now);
      return { id: null, credited: false, refused: "attest-family-map", state: db.prepare("SELECT state FROM decisions WHERE id = ?").get(d.id).state };
    }
    const id = randomUUID();
    try {
      db.prepare(`INSERT INTO served_by_attestations(id, decision_id, target_by, target_seq, measurer, session_id, record_uuid, response_model, turn_models,
                    family, body_sha256, tool, tool_sha256, measured_at, policy_version, recorded_at, body, sig)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, d.id, t.by, t.seq, m, body.session_id, body.record_uuid, body.response_model, JSON.stringify(body.turn_models), body.family,
          body.body_sha256, body.tool, body.tool_sha256, body.measured_at, policyVersion, now, jcs(body), sig);
    } catch (error) {
      const known = ATTEST_ERRORS.find(c => error.message.includes(c));
      if (known) throw new RelayError(known, 409);
      if (/UNIQUE/.test(error.message)) throw new RelayError("duplicate-attestation", 409);
      throw error;
    }
    const credited = asserted === body.family;
    if (!credited) {
      alert(db, now, "served_by.mismatch", t.by, { decision: d.id, seq: t.seq, asserted, attested: body.family });
      appendLog(db, "security", { kind: "served_by.mismatch", decision_id: d.id, by: t.by, seq: t.seq, asserted, attested: body.family }, now);
    }
    appendLog(db, "decision", { kind: "served_by.attest", id, decision_id: d.id, by: t.by, seq: t.seq, family: body.family, credited }, now);
    return { id, credited, state: settleInTx(db, d.id, now) };
  });
}

// --- security findings (section 10: C2 needs none open) -----------------------

/** The security reviewer opens a finding against a member. */
export function openFinding(db, signed, now) {
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, FINDING_OPEN_V, now);
    refuseIfFrozen(db, "finding.open");
    requirePermission(principal, "finding.open");
    for (const key of Object.keys(body)) if (!["v", "id", "member_id", "summary", "by", "served_by", "at"].includes(key)) throw new RelayError("unknown-field", 400, key);
    if (!isRecordId(body.id)) throw new RelayError("invalid-field", 400, "id");
    sanitizeText(body.summary, { field: "summary", max: 4096 });
    if (!db.prepare("SELECT 1 FROM members WHERE member_id = ?").get(body.member_id ?? "")) throw new RelayError("unknown-member", 404);
    try {
      db.prepare("INSERT INTO security_findings(id, member_id, opened_by, opened_at, body, sig) VALUES (?, ?, ?, ?, ?, ?)")
        .run(body.id, body.member_id, principal.principal_id, now, jcs(body), sig);
    } catch (error) {
      if (/UNIQUE|PRIMARY KEY/.test(error.message)) throw new RelayError("duplicate-finding", 409);
      throw error;
    }
    alert(db, now, "security-finding", body.member_id, { finding: body.id, by: principal.principal_id });
    appendLog(db, "security", { kind: "finding.opened", finding: body.id, member_id: body.member_id, by: principal.principal_id }, now);
    return { id: body.id, member_id: body.member_id };
  });
}

/** The security reviewer closes a finding, once. Pending decisions about the member are evaluated again. */
export function closeFinding(db, signed, now) {
  return tx(db, () => {
    const { body, sig, principal } = verifySigned(db, signed, FINDING_CLOSE_V, now);
    refuseIfFrozen(db, "finding.close");
    requirePermission(principal, "finding.close");
    for (const key of Object.keys(body)) if (!["v", "finding_id", "resolution", "by", "served_by", "at"].includes(key)) throw new RelayError("unknown-field", 400, key);
    sanitizeText(body.resolution, { field: "resolution", max: 4096 });
    const f = db.prepare("SELECT * FROM security_findings WHERE id = ?").get(body.finding_id ?? "");
    if (!f) throw new RelayError("unknown-finding", 404);
    if (f.closed_at !== null) throw new RelayError("finding-already-closed", 409);
    db.prepare("UPDATE security_findings SET closed_by = ?, closed_at = ?, close_body = ?, close_sig = ? WHERE id = ?").run(principal.principal_id, now, jcs(body), sig, f.id);
    appendLog(db, "security", { kind: "finding.closed", finding: f.id, member_id: f.member_id, by: principal.principal_id }, now);
    for (const { id } of db.prepare("SELECT id FROM decisions WHERE subject = ? AND state = 'pending'").all(f.member_id)) settleInTx(db, id, now);
    return { id: f.id, closed: true };
  });
}

// --- seat messages ----------------------------------------------------------------

/** An AC seat sends a signed message to one member of its lane (7.5). */
export function sendSeatMessage(db, signed, now) {
  return tx(db, () => {
    const { body, principal } = verifySigned(db, signed, SEAT_MESSAGE_V, now);
    requirePermission(principal, "message.send");
    refuseIfFrozen(db, "message.send");
    for (const key of Object.keys(body)) if (!["v", "record_id", "member_id", "lane", "text", "by", "served_by", "at"].includes(key)) throw new RelayError("unknown-field", 400, key);
    const lane = db.prepare("SELECT 1 FROM member_profiles WHERE member_id = ? AND lane = ?").get(body.member_id ?? "", body.lane ?? "");
    if (!lane) throw new RelayError("unknown-recipient", 404);
    const text = sanitizeText(body.text, { field: "text", max: 8192 });
    return deliverInTx(db, body.member_id, { record_id: body.record_id, sender: principal.principal_id, type: "seat-message", body: { lane: body.lane, text } }, now);
  });
}
