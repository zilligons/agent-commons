// Scope-seat check for the D items (re-bind recovery). Runs the proposed §9.3 DDL on node:sqlite
// in memory and drives each rule with direct SQL in the order the ruling prescribes. Fixture data only.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const [proposedPath, basePath] = process.argv.slice(2);
const H64 = c => c.repeat(64).slice(0, 64);
const results = [];
function check(name, fn, expect) {
  let got = "ok";
  try { fn(); } catch (e) { got = (/RAISE|ABORT/.test(String(e)) ? "" : "") + String(e.message).replace(/^.*?: /, ""); }
  const pass = expect === "ok" ? got === "ok" : got.includes(expect);
  results.push({ name, expect, got, pass });
}

function open(ddl) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(ddl);
  return db;
}
const run = (db, sql, ...p) => db.prepare(sql).run(...p);
const get = (db, sql, ...p) => db.prepare(sql).get(...p);
const HAS_LANE = (db) => db.prepare("SELECT 1 FROM pragma_table_info('decisions') WHERE name = 'lane'").get() !== undefined;

function base(db, withDecisionId) {
  for (const [id, kind, fam] of [["seatA", "ac-seat", "A"], ["seatB", "ac-seat", "B"], ["seatC", "ac-seat", "C"], ["owner", "owner", null]])
    run(db, "INSERT INTO fleet_principals(principal_id, kind, runtime_family, status) VALUES (?, ?, ?, 'active')", id, kind, fam);
}
function D(db, id, cls, action, subject, t, sponsor = null) {
  // v3.3.2 S1 port (the implementer): decisions.lane is set exactly for D0, D1 and D2. Fixture-only; no assertion changes.
  const lane = ["D0", "D1", "D2"].includes(cls) ? "L" : null;
  if (HAS_LANE(db)) run(db, `INSERT INTO decisions(id, class, action, subject, sponsor, lane, state, owner_line_ref, owner_posted_at, effect_at, served_by, created_at, body, sig)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 'measured:x', ?, '{}', 'sig')`, id, cls, action, subject, sponsor, lane, t);
  else run(db, `INSERT INTO decisions(id, class, action, subject, sponsor, state, owner_line_ref, owner_posted_at, effect_at, served_by, created_at, body, sig)
           VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 'measured:x', ?, '{}', 'sig')`, id, cls, action, subject, sponsor, t);
}
const eff = (db, id) => run(db, "UPDATE decisions SET state = 'effective' WHERE id = ?", id);
function post(db, id, t, cls) {
  run(db, "INSERT INTO owner_record_outbox(id, subject, line, line_sha256, created_at, confirmed_at, confirmed_by) VALUES (?, ?, 'l', ?, ?, ?, 'seatA')", "ob-" + id, id, H64("a"), t, t);
  run(db, "UPDATE decisions SET owner_line_ref = ?, owner_posted_at = ?, effect_at = ? WHERE id = ?", "ob-" + id, t, cls === "D2" ? t + 86400000 : null, id);
}
const key = (db, pk, member, status, t) =>
  run(db, "INSERT INTO keys(public_key, agent, principal_kind, principal_id, status, added_at, revoked_at) VALUES (?, ?, 'member', ?, ?, ?, NULL)", H64(pk), "agent-" + pk, member, status, t);
const revokeKey = (db, pk, t) => run(db, "UPDATE keys SET status = 'revoked', revoked_at = ? WHERE public_key = ?", t, H64(pk));
function invite(db, id, kind, member, decision, t, withDecisionId = true) {
  if (withDecisionId)
    run(db, "INSERT INTO invites(invite_id, kind, member_id, created_by, decision_id, secret_sha256, created_at, expires_at, voided_at) VALUES (?, ?, ?, 'seatA', ?, ?, ?, ?, NULL)", id, kind, member, decision, H64("s"), t, t + 86400000);
  else
    run(db, "INSERT INTO invites(invite_id, kind, member_id, created_by, secret_sha256, created_at, expires_at, voided_at) VALUES (?, ?, ?, 'seatA', ?, ?, ?, NULL)", id, kind, member, H64("s"), t, t + 86400000);
}
const susp = (db, id, member, reason, decisionId, inviteId, t) =>
  run(db, "INSERT INTO suspensions(id, member_id, reason, decision_id, invite_id, started_at, ended_at, ended_by_decision) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)", id, member, reason, decisionId, inviteId, t);
const endSusp = (db, id, by, t) => run(db, "UPDATE suspensions SET ended_at = ?, ended_by_decision = ? WHERE id = ?", t, by, id);
const ends = (db, inv, cause, dec, t) => run(db, "INSERT INTO rebind_ends(invite_id, cause, decision_id, at) VALUES (?, ?, ?, ?)", inv, cause, dec, t);
const status = (db, m) => get(db, "SELECT status FROM members WHERE member_id = ?", m).status;
const enrollRow = (db, id, inv, kind, m, pk, t) =>
  run(db, "INSERT INTO enrollments(id, invite_id, kind, member_id, public_key, spent_at, confirmed_by, confirmed_at, owner_line_ref) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)", id, inv, kind, m, H64(pk), t);
function d2(db, id, action, subject, t) { D(db, id, "D2", action, subject, t, "seatA"); post(db, id, t, "D2"); eff(db, id); }

function enrollActive(db, m, withDecisionId) {
  if (withDecisionId) { D(db, "inv0", "D0", "invite.create", "lbl0", 0); eff(db, "inv0"); }
  invite(db, "I0", "enroll", null, "inv0", 0, withDecisionId);
  run(db, "INSERT INTO members(member_id, status, role, updated_at) VALUES (?, 'pending', NULL, 0)", m);
  key(db, "1", m, "pending", 5);
  enrollRow(db, "E0", "I0", "enroll", m, "1", 10);
  run(db, "INSERT INTO owner_record_outbox(id, subject, line, line_sha256, created_at, confirmed_at, confirmed_by) VALUES ('obE0', 'E0', 'l', ?, 20, 20, 'seatA')", H64("b"));
  run(db, "UPDATE enrollments SET confirmed_by = 'seatB', confirmed_at = 30, owner_line_ref = 'obE0' WHERE id = 'E0'");
  run(db, "UPDATE keys SET status = 'active' WHERE public_key = ?", H64("1"));
  run(db, "UPDATE members SET status = 'active', updated_at = 30 WHERE member_id = ?", m);
}

// ---------------- proposed DDL ----------------
{
  const db = open(readFileSync(proposedPath, "utf8"));
  base(db);
  enrollActive(db, "M", true);
  const DAY = 86400000;

  // invite decision binding
  D(db, "ec0", "D0", "enroll.confirm", "M", 31); eff(db, "ec0");
  check("invite needs an effective invite.create decision", () => invite(db, "Ibad", "rebind", "M", "ec0", 40), "invite-needs-decision");
  check("invite.decision_id is immutable", () => run(db, "UPDATE invites SET decision_id = 'ec0' WHERE invite_id = 'I0'"), "invite-immutable");

  // A: unspent attempt expires; supersession by a newer re-bind invite
  D(db, "r1", "D0", "invite.create", "lbl1", 1000); eff(db, "r1");
  invite(db, "I1", "rebind", "M", "r1", 1000); susp(db, "S1", "M", "rebind", null, "I1", 1000);
  check("A0 rebind invite suspends (status)", () => { if (status(db, "M") !== "suspended") throw new Error("x: not suspended"); }, "ok");
  D(db, "r1b", "D0", "invite.create", "lbl1b", 1100); eff(db, "r1b");
  check("A1 second re-bind invite while an attempt is live -> refused", () => invite(db, "I1b", "rebind", "M", "r1b", 1100), "rebind-attempt-live");
  d2(db, "ri1", "reinstate", "M", 2000);
  check("A2 D2 reinstate cannot end a LIVE attempt's suspension", () => endSusp(db, "S1", "ri1", 3000), "suspension-end-needs-matching-decision");
  check("A3 invite-expired recorded 1 ms early -> refused", () => ends(db, "I1", "invite-expired", null, 1000 + DAY - 1), "rebind-end-invalid");
  check("A4 invite-voided on a non-voided invite -> refused", () => ends(db, "I1", "invite-voided", null, 1000 + DAY), "rebind-end-invalid");
  check("A5 invite-expired at expires_at -> recorded", () => ends(db, "I1", "invite-expired", null, 1000 + DAY), "ok");
  check("A6a rebind_ends is append-only (update)", () => run(db, "UPDATE rebind_ends SET cause = 'cancelled' WHERE invite_id = 'I1'"), "append-only");
  check("A6b rebind_ends is append-only (delete)", () => run(db, "DELETE FROM rebind_ends WHERE invite_id = 'I1'"), "append-only");
  check("A7 an enroll invite.create cannot end a dead re-bind suspension", () => endSusp(db, "S1", "inv0", 2 * DAY), "suspension-end-needs-matching-decision");
  D(db, "r2", "D0", "invite.create", "lbl2", 2 * DAY); eff(db, "r2");
  check("A8 a new re-bind invite is allowed once the old attempt is dead", () => invite(db, "I2", "rebind", "M", "r2", 2 * DAY), "ok");
  susp(db, "S2", "M", "rebind", null, "I2", 2 * DAY);
  check("A9 supersession: the new invite.create ends the dead suspension", () => endSusp(db, "S1", "r2", 2 * DAY), "ok");
  check("A10 member stays suspended through supersession", () => { if (status(db, "M") !== "suspended") throw new Error("x: " + status(db, "M")); }, "ok");

  // B: spent attempt; enrollment expires; its D1R can never take effect; D2 reinstate returns the member on its old key
  const t2 = 2 * DAY + 100;
  key(db, "2", "M", "pending", t2); enrollRow(db, "E2", "I2", "rebind", "M", "2", t2);
  D(db, "c2", "D1R", "rebind.confirm", "E2", t2 + 10);
  revokeKey(db, "2", t2 + 3 * DAY - 1);
  check("B1 enrollment-expired recorded before 72 h -> refused", () => ends(db, "I2", "enrollment-expired", null, t2 + 3 * DAY - 1), "rebind-end-invalid");
  check("B2 enrollment-expired at 72 h with the key revoked -> recorded", () => ends(db, "I2", "enrollment-expired", null, t2 + 3 * DAY), "ok");
  post(db, "c2", t2 + 3 * DAY + 5, "D1R");
  check("B3 a D1R about a dead attempt cannot take effect", () => eff(db, "c2"), "rebind-attempt-dead");
  check("B4 that D1R can lapse", () => run(db, "UPDATE decisions SET state = 'lapsed' WHERE id = 'c2'"), "ok");
  d2(db, "ri2", "reinstate", "M", t2 + 4 * DAY);
  check("B5 D2 reinstate ends the dead attempt's suspension", () => endSusp(db, "S2", "ri2", t2 + 5 * DAY), "ok");
  check("B6 member active again on its old key K1", () => {
    if (status(db, "M") !== "active") throw new Error("x: " + status(db, "M"));
    if (get(db, "SELECT status FROM keys WHERE public_key = ?", H64("1")).status !== "active") throw new Error("x: K1 not active");
    if (get(db, "SELECT status FROM keys WHERE public_key = ?", H64("2")).status !== "revoked") throw new Error("x: K2 not revoked");
  }, "ok");

  // C: cancellation of a spent attempt; then the owner reverses its invite.create
  const t3 = 10 * DAY;
  D(db, "r3", "D0", "invite.create", "lbl3", t3); eff(db, "r3"); invite(db, "I3", "rebind", "M", "r3", t3); susp(db, "S3", "M", "rebind", null, "I3", t3);
  key(db, "3", "M", "pending", t3 + 50); enrollRow(db, "E3", "I3", "rebind", "M", "3", t3 + 50);
  D(db, "x3", "D0", "rebind.cancel", "I3", t3 + 60); eff(db, "x3");
  check("C1 cancel recorded while the spent key is still pending -> refused", () => ends(db, "I3", "cancelled", "x3", t3 + 60), "rebind-end-invalid");
  D(db, "x3bad", "D0", "rebind.cancel", "I2", t3 + 61); eff(db, "x3bad");
  revokeKey(db, "3", t3 + 62);
  check("C2 cancel citing a cancel of another invite -> refused", () => ends(db, "I3", "cancelled", "x3bad", t3 + 62), "rebind-end-invalid");
  check("C3 cancel with the key revoked -> recorded", () => ends(db, "I3", "cancelled", "x3", t3 + 62), "ok");
  check("C4 member stays suspended after a cancel", () => { if (status(db, "M") !== "suspended") throw new Error("x: " + status(db, "M")); }, "ok");
  D(db, "v3", "OWNER", "veto", "r3", t3 + 70); eff(db, "v3");
  check("C5 the owner veto reverses the invite.create", () => run(db, "UPDATE decisions SET state = 'reversed' WHERE id = 'r3'"), "ok");
  check("C6 the owner veto of its invite ends the dead suspension", () => endSusp(db, "S3", "v3", t3 + 70), "ok");
  check("C7 member active after the owner reversal", () => { if (status(db, "M") !== "active") throw new Error("x: " + status(db, "M")); }, "ok");

  // D: owner reverses an UNSPENT re-bind invite while an unrelated decision suspension is open
  const t4 = 20 * DAY;
  D(db, "sd", "SUSPEND", "suspend", "M", t4); eff(db, "sd"); susp(db, "SD", "M", "decision", "sd", null, t4);
  D(db, "r4", "D0", "invite.create", "lbl4", t4 + 10); eff(db, "r4"); invite(db, "I4", "rebind", "M", "r4", t4 + 10); susp(db, "S4", "M", "rebind", null, "I4", t4 + 10);
  D(db, "v4", "OWNER", "veto", "r4", t4 + 20); eff(db, "v4");
  run(db, "UPDATE decisions SET state = 'reversed' WHERE id = 'r4'");
  check("D1 reversed recorded before the invite is voided -> refused", () => ends(db, "I4", "reversed", "v4", t4 + 20), "rebind-end-invalid");
  run(db, "UPDATE invites SET voided_at = ? WHERE invite_id = 'I4'", t4 + 20);
  check("D2 reversed recorded after the void", () => ends(db, "I4", "reversed", "v4", t4 + 20), "ok");
  check("D3 the veto ends the re-bind suspension", () => endSusp(db, "S4", "v4", t4 + 20), "ok");
  check("D4 the unrelated decision suspension keeps the member suspended", () => { if (status(db, "M") !== "suspended") throw new Error("x: " + status(db, "M")); }, "ok");
  check("D5 the re-bind veto cannot end the decision suspension", () => endSusp(db, "SD", "v4", t4 + 30), "suspension-end-needs-matching-decision");
  d2(db, "ri4", "reinstate", "M", t4 + 40);
  check("D6 D2 reinstate ends the decision suspension", () => endSusp(db, "SD", "ri4", t4 + 41), "ok");

  // E: a completed re-bind is never dead, even after its D1R is reversed
  const t5 = 30 * DAY;
  D(db, "r5", "D0", "invite.create", "lbl5", t5); eff(db, "r5"); invite(db, "I5", "rebind", "M", "r5", t5); susp(db, "S5", "M", "rebind", null, "I5", t5);
  key(db, "5", "M", "pending", t5 + 10); enrollRow(db, "E5", "I5", "rebind", "M", "5", t5 + 10);
  D(db, "c5", "D1R", "rebind.confirm", "E5", t5 + 20); post(db, "c5", t5 + 30, "D1R");
  check("E1 a live attempt's D1R takes effect", () => eff(db, "c5"), "ok");
  check("E2 the D1R ends its own suspension", () => endSusp(db, "S5", "c5", t5 + 30), "ok");
  D(db, "v5", "OWNER", "veto", "c5", t5 + 40); eff(db, "v5"); run(db, "UPDATE decisions SET state = 'reversed' WHERE id = 'c5'");
  revokeKey(db, "5", t5 + 40);
  check("E3 a completed (then reversed) re-bind cannot be recorded dead", () => ends(db, "I5", "enrollment-expired", null, t5 + 4 * DAY), "rebind-end-invalid");
  check("E4 non-rebind invite cannot be recorded dead", () => ends(db, "I0", "invite-expired", null, 5 * DAY), "rebind-end-invalid");

  // F: a D2 reinstate outranks a live attempt: its effect kills the attempt, then ends the suspension
  const t6 = 40 * DAY;
  D(db, "r6", "D0", "invite.create", "lbl6", t6); eff(db, "r6"); invite(db, "I6", "rebind", "M", "r6", t6); susp(db, "S6", "M", "rebind", null, "I6", t6);
  key(db, "6", "M", "pending", t6 + 10); enrollRow(db, "E6", "I6", "rebind", "M", "6", t6 + 10);
  D(db, "c6", "D1R", "rebind.confirm", "E6", t6 + 20);
  d2(db, "ri6", "reinstate", "M", t6 + 30);
  check("F1 reinstated recorded while the spent key is pending -> refused", () => ends(db, "I6", "reinstated", "ri6", t6 + 30), "rebind-end-invalid");
  check("F2 reinstated citing a non-reinstate decision -> refused", () => { revokeKey(db, "6", t6 + 31); ends(db, "I6", "reinstated", "r6", t6 + 31); }, "rebind-end-invalid");
  check("F3 reinstated with the key revoked -> recorded", () => ends(db, "I6", "reinstated", "ri6", t6 + 31), "ok");
  check("F4 the reinstate ends the killed attempt's suspension", () => endSusp(db, "S6", "ri6", t6 + 31), "ok");
  post(db, "c6", t6 + 40, "D1R");
  check("F5 the killed attempt's pending D1R cannot take effect", () => eff(db, "c6"), "rebind-attempt-dead");
  check("F6 member active on K1 after the reinstate", () => { if (status(db, "M") !== "active") throw new Error("x: " + status(db, "M")); }, "ok");
  D(db, "rX", "D0", "invite.create", "lblX", t6 + 50); eff(db, "rX");
  check("F7 a reinstate of another member cannot be cited", () => {
    run(db, "INSERT INTO members(member_id, status, role, updated_at) VALUES ('M2', 'pending', NULL, 0)");
    invite(db, "IX", "rebind", "M", "rX", t6 + 50); susp(db, "SX", "M", "rebind", null, "IX", t6 + 50);
    run(db, "UPDATE invites SET voided_at = ? WHERE invite_id = 'IX'", t6 + 51);
    d2(db, "riM2", "reinstate", "M2", t6 + 52);
    ends(db, "IX", "reinstated", "riM2", t6 + 52);
  }, "rebind-end-invalid");
}

// ---------------- base v3.3.1 DDL: stranding control ----------------
{
  const db = open(readFileSync(basePath, "utf8"));
  base(db);
  enrollActive(db, "M", false);
  invite(db, "I1", "rebind", "M", null, 1000, false); susp(db, "S1", "M", "rebind", null, "I1", 1000);
  D(db, "ri", "D2", "reinstate", "M", 2000, "seatA"); post(db, "ri", 2000, "D2"); eff(db, "ri");
  check("CONTROL base: D2 reinstate cannot end an expired attempt's suspension (stranded)", () => endSusp(db, "S1", "ri", 1000 + 2 * 86400000), "suspension-end-needs-matching-decision");
  D(db, "rn", "D0", "invite.create", "lbl", 3000); eff(db, "rn");
  check("CONTROL base: a newer invite.create cannot end it either (stranded)", () => endSusp(db, "S1", "rn", 1000 + 2 * 86400000), "suspension-end-needs-matching-decision");
  D(db, "vv", "OWNER", "veto", "rn", 4000); eff(db, "vv");
  check("CONTROL base: no owner-veto path for a re-bind suspension (stranded)", () => endSusp(db, "S1", "vv", 1000 + 2 * 86400000), "suspension-end-needs-matching-decision");
}

const failed = results.filter(r => !r.pass);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  [expect ${r.expect}; got ${r.got}]`);
console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
process.exit(failed.length ? 1 : 0);
