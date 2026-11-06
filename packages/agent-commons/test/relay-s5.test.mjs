// S5 (spec v3.4.2 sections 9.3 and 9.7; D-2): a revoked member's role is frozen at
// revocation. The verifier found at 9b9f500 that reversing a role decision after the member's enrollment had been
// reversed appended a veto-cited role row (revoked / C2 / 3 rows became revoked / C1 / 4 rows), and
// verifyExport accepted it. Enforced three ways: the 9.3 trigger roles_frozen_when_revoked, the reducer
// (no re-projection for a revoked member; role decisions about one refused or lapsed) and the export
// check (the role at the revocation boundary; no role row after it). The verifier's witness runs
// here. The verifier's re-check at e1b840c then found the export check took a record-only reversal of a COMPLETED
// enroll invite as the revocation boundary and refused an honest export; its boundary script and the
// forgery probe also run here (relay-fixtures/review/, pinned by hash; for publication their comments were
// reworded, roles instead of names, and nothing else changed).
// Scratch databases, fixture keys; provider requests disabled.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { settleAll } from "../src/relay/governance.mjs";
import { exportRelay, verifyExport } from "../src/relay/signing.mjs";
import { setup, decision, approval, ownerConfirm, outboxFor, promoteC1, eligibleForC2, rejects, createDecision, addVerdict, confirmOwnerRecord,
  T0, MIN, DAY } from "./relay-fixtures.mjs";

const one = (fx, sql, ...a) => fx.db.prepare(sql).get(...a);
const roleRows = (fx, m) => fx.db.prepare("SELECT seq, role, decision_id FROM roles WHERE member_id = ? ORDER BY seq").all(m).map(r => ({ ...r }));
const member = (fx, m) => ({ ...one(fx, "SELECT status, role FROM members WHERE member_id = ?", m) });
const stateOf = (fx, id) => one(fx, "SELECT state FROM decisions WHERE id = ?", id).state;
const veto = (fx, subject, at) => createDecision(fx.db, decision(fx, "owner", { cls: "OWNER", action: "veto", subject, at }), at);
const verifies = (fx) => verifyExport(exportRelay(fx.db), fx.files.roster.body.principals);
const effects = (fx, id) => fx.db.prepare("SELECT event FROM logs WHERE log = 'decision'").all().map(r => JSON.parse(r.event))
  .filter(e => e.kind === "reversal.effect" && e.decision === id).map(({ effect, reason, role }) => ({ effect, reason, role }));

/** The verifier's sequence: enroll (E) -> C1 -> a measured D2 to C2, effective after its window. Returns the decision ids. */
function toC2(fx) {
  const A = promoteC1(fx, "A");
  eligibleForC2(fx, "A");
  const at = T0 + 3 * DAY;
  const c2 = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-1", args: { role: "C2" }, at }), at);
  for (const seat of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, c2.id, "approve", at), at);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, c2.id), at), at);
  settleAll(fx.db, at + DAY);
  assert.equal(stateOf(fx, c2.id), "effective");
  const enroll = one(fx, "SELECT id FROM decisions WHERE action = 'enroll.confirm' AND subject = ?", A).id;
  const c1 = one(fx, "SELECT id FROM decisions WHERE action = 'role.c1' AND subject = ?", A).id;
  return { A, enroll, c1, c2: c2.id, at: at + DAY + 1 };
}

/** Refused with at least these reasons (the D-C1 row binding may add role-event-missing or role-ledger-mismatch). */
const refusedWith = (got, required) => { for (const r of required) assert.ok(got.includes(r), `missing ${r} in ${JSON.stringify(got)}`); };

/** Run a vendored review probe (pinned by hash) as `node <script> <checkout root> <out.json>`; returns rc, stdout and the output file. */
function runProbe(name, sha) {
  const script = new URL(`./relay-fixtures/review/${name}`, import.meta.url);
  assert.equal(createHash("sha256").update(readFileSync(script)).digest("hex"), sha, name);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "relay-v1-script-"));
  try {
    const out = join(tmp, "out.json");
    const r = spawnSync(process.execPath, [fileURLToPath(script), root, out], { encoding: "utf8", env: { ...process.env, AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" } });
    let file = null;
    try { file = JSON.parse(readFileSync(out, "utf8")); } catch { /* scripts that print only */ }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, file };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

test("the verifier's boundary script (f687519d): a completed invite's record-only veto is not the revocation boundary", () => {
  const r = runProbe("revocation-boundary-record-only.mjs", "f687519dca8b7f8404fe76f7e0bdd28617c3a3bda779fcedacf222203a5dd68f");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const b = r.file.recordOnlyInviteThenRealRevocation;
  assert.deepEqual([r.file.pass, r.file.control.pass, b.pass], [true, true, true]);
  assert.deepEqual([b.afterInvite.member, b.afterRevocation.member, b.afterRevocation.roles.length, b.afterRevocation.verification],
    [{ status: "active", role: "C2" }, { status: "revoked", role: "C1" }, 4, { ok: true, problems: [] }]);
});

test("the forgery probe (780609a7): the clean export verifies; a post-revocation row, alone or with the member row, is refused", () => {
  const r = runProbe("s5-forge-export.mjs", "cd5b3eceafbc0ccf4d38893e066d0e3f1d1d5718b672de09178d7501a529be7b");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const o = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.deepEqual([o.clean.ok, o.rowOnly.ok, o.rowAndMember.ok], [true, false, false]);
  assert.ok(o.rowOnly.problems.includes("role/role-after-revocation"));
  refusedWith(o.rowAndMember.problems, ["member/member-projection-mismatch", "role/role-after-revocation", "role/role-event-missing"]);
});

test("the verifier's S5 witness (d2e5b45a): the revoked case keeps revoked / C2 / 3 rows with a clean export; the sibling re-projects", () => {
  const witness = new URL("./relay-fixtures/review/s5-witness.mjs", import.meta.url);
  assert.equal(createHash("sha256").update(readFileSync(witness)).digest("hex"), "d2e5b45ae8c5bc2b0d3725458c1ce031073805558721f2e14972a9072d0d27c8");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "relay-s5-witness-"));
  try {
    const out = join(tmp, "s5-witness-results.json");
    const r = spawnSync(process.execPath, [fileURLToPath(witness), root, out], { encoding: "utf8", env: { ...process.env, AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const res = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(res.pass, true);
    const w = res.revokedWitness, s = res.unrevokedSibling;
    assert.deepEqual([w.after.member, w.after.roles.length, w.after.exportVerification], [{ status: "revoked", role: "C2" }, 3, { ok: true, problems: [] }]);
    assert.deepEqual([s.after.member, s.after.roles.length, s.after.exportVerification], [{ status: "active", role: "C1" }, 4, { ok: true, problems: [] }]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("S5: enroll -> C1 -> C2 -> reverse the enrollment -> reverse C2 leaves revoked / C2 with the original three rows; the reversal is recorded", () => {
  const fx = setup({ members: ["A"] });
  const { A, enroll, c1, c2, at } = toC2(fx);
  const original = [{ seq: 1, role: "C0", decision_id: enroll }, { seq: 2, role: "C1", decision_id: c1 }, { seq: 3, role: "C2", decision_id: c2 }];
  assert.deepEqual(roleRows(fx, A), original);
  veto(fx, enroll, at);
  assert.deepEqual(member(fx, A), { status: "revoked", role: "C2" });
  const v = veto(fx, c2, at + 1);
  assert.equal(v.state, "effective", "the owner's reversal still takes effect");
  assert.equal(stateOf(fx, c2), "reversed");
  assert.deepEqual(member(fx, A), { status: "revoked", role: "C2" });
  assert.deepEqual(roleRows(fx, A), original, "no role row added");
  assert.deepEqual(effects(fx, c2), [{ effect: "role.unchanged", reason: "revoked", role: "C2" }]);
  assert.ok(fx.db.prepare("SELECT event FROM logs WHERE log = 'security'").all().some(r => { const e = JSON.parse(r.event); return e.kind === "reversal" && e.decision === c2 && e.veto === v.id; }));
  assert.ok(one(fx, "SELECT 1 FROM owner_record_outbox WHERE subject = ?", `reversal:${c2}`), "the owner-visible line is written");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("S5 control: the same reversal for an active member re-projects to C1 (a fourth, veto-cited row)", () => {
  const fx = setup({ members: ["A"] });
  const { A, c2, at } = toC2(fx);
  const v = veto(fx, c2, at);
  assert.deepEqual(member(fx, A), { status: "active", role: "C1" });
  assert.deepEqual(roleRows(fx, A).map(r => [r.seq, r.role]), [[1, "C0"], [2, "C1"], [3, "C2"], [4, "C1"]]);
  assert.equal(roleRows(fx, A)[3].decision_id, v.id);
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
  // The other order: the re-projection happened BEFORE revocation, so it stays and is the frozen role.
  veto(fx, one(fx, "SELECT id FROM decisions WHERE action = 'enroll.confirm' AND subject = ?", A).id, at + 1);
  assert.deepEqual(member(fx, A), { status: "revoked", role: "C1" });
  assert.equal(roleRows(fx, A).length, 4);
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("S5: the E-only case is unchanged (enroll -> C1 -> reverse E -> reverse C1: revoked / C1 / 2 rows)", () => {
  const fx = setup({ members: ["A"] });
  const A = promoteC1(fx, "A");
  const enroll = one(fx, "SELECT id FROM decisions WHERE action = 'enroll.confirm' AND subject = ?", A).id;
  const c1 = one(fx, "SELECT id FROM decisions WHERE action = 'role.c1' AND subject = ?", A).id;
  veto(fx, enroll, T0 + MIN);
  veto(fx, c1, T0 + 2 * MIN);
  assert.deepEqual([member(fx, A), roleRows(fx, A).length], [{ status: "revoked", role: "C1" }, 2]);
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("S5: role decisions about a revoked member are refused at proposal and lapse at effect; the schema refuses the row", () => {
  const fx = setup({ members: ["A", "B"] });
  const { A, enroll, at } = toC2(fx);
  // A pending demotion of B, then B revoked inside its window: it lapses at effect, cause role-frozen-revoked.
  const B = promoteC1(fx, "B");
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: B, sponsor: "seat-1", args: { role: "C0" }, at }), at);
  for (const seat of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, d.id, "approve", at), at);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, d.id), at), at);
  veto(fx, one(fx, "SELECT id FROM decisions WHERE action = 'enroll.confirm' AND subject = ?", B).id, at + 1);
  settleAll(fx.db, at + DAY);
  assert.equal(stateOf(fx, d.id), "lapsed");
  assert.ok(fx.db.prepare("SELECT event FROM logs WHERE log = 'decision'").all().some(r => { const e = JSON.parse(r.event); return e.kind === "decision.lapsed" && e.id === d.id && e.cause === "role-frozen-revoked"; }));
  assert.deepEqual(member(fx, B), { status: "revoked", role: "C1" });
  // A revoked: a new role.c1 or role.change is refused at proposal (D-2 branch B1).
  veto(fx, enroll, at + 2);
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D0", action: "role.c1", subject: A, at: at + 3 }), at + 3), "role-frozen-revoked");
  rejects(() => createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-1", args: { role: "C3" }, at: at + 3 }), at + 3), "role-frozen-revoked");
  // The schema refuses any role row for a revoked member, whatever it cites.
  const c2 = one(fx, "SELECT id FROM decisions WHERE action = 'role.change' AND subject = ? AND state = 'effective'", A).id;
  rejects(() => fx.db.prepare("INSERT INTO roles(member_id, seq, role, decision_id, at) VALUES (?, 4, 'C2', ?, ?)").run(A, c2, at + 4), "role-frozen-revoked");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
});

test("S5 export: a post-revocation role row (the verifier's row, written past the schema guard) is refused offline", () => {
  const fx = setup({ members: ["A"] });
  const { A, enroll, c2, at } = toC2(fx);
  veto(fx, enroll, at);
  const v = veto(fx, c2, at + 1);
  const roster = fx.files.roster.body.principals;
  const clean = exportRelay(fx.db);
  assert.deepEqual(verifyExport(clean, roster), { ok: true, problems: [] }, "the valid export with the recorded reversal verifies");
  const reasons = (exp) => verifyExport(exp, roster).problems.map(p => `${p.kind}/${p.reason}${p.field ? "/" + p.field : ""}`).sort();
  // (1) Exactly what the reducer wrote at 9b9f500: a veto-cited C1 row, with the projection following it.
  const forged = structuredClone(clean);
  forged.roles.push({ member_id: A, seq: 4, role: "C1", decision_id: v.id, at: at + 1 });
  forged.members.find(m => m.member_id === A).role = "C1";
  refusedWith(reasons(forged), ["member/member-projection-mismatch/role", "role/role-after-revocation", "role/role-event-missing"]);
  // (2) The row alone, the member row left frozen.
  const rowOnly = structuredClone(clean);
  rowOnly.roles.push({ member_id: A, seq: 4, role: "C1", decision_id: v.id, at: at + 1 });
  refusedWith(reasons(rowOnly), ["role/role-after-revocation", "role/role-event-missing"]);
  assert.equal(reasons(rowOnly).some(r => r.startsWith("member/")), false, "the member row was left frozen");
  // (3) The member row alone changed: it no longer equals the role at the revocation boundary.
  const memberOnly = structuredClone(clean);
  memberOnly.members.find(m => m.member_id === A).role = "C1";
  assert.deepEqual(reasons(memberOnly), ["member/member-projection-mismatch/role"]);
  // (4) A real database where the schema guard was dropped and the 9b9f500 row was written: refused.
  fx.db.exec("DROP TRIGGER roles_frozen_when_revoked");
  fx.db.prepare("INSERT INTO roles(member_id, seq, role, decision_id, at) VALUES (?, 4, 'C1', ?, ?)").run(A, v.id, at + 1);
  assert.deepEqual(member(fx, A), { status: "revoked", role: "C1" });
  refusedWith(reasons(exportRelay(fx.db)), ["member/member-projection-mismatch/role", "role/role-after-revocation", "role/role-event-missing"]);
});

test("boundary: completed-invite veto (record-only) -> legitimate demotion -> enrollment reversal = revoked at C1, 4 rows, valid export", () => {
  const fx = setup({ members: ["A"] });
  const { A, enroll, at } = toC2(fx);
  const invite = one(fx, "SELECT i.decision_id FROM enrollments e JOIN invites i USING(invite_id) WHERE e.kind = 'enroll' AND e.member_id = ?", A).decision_id;
  const vInvite = veto(fx, invite, at);
  assert.equal(stateOf(fx, invite), "reversed");
  assert.deepEqual(effects(fx, invite).map(e => e.effect), ["record-only"]);
  assert.deepEqual(member(fx, A), { status: "active", role: "C2" }, "a completed invite's reversal is record-only");
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
  // A legitimate demotion to C1 while active (the 4th row), then the real revocation.
  const t = at + 1;
  const demote = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-1", args: { role: "C1" }, at: t }), t);
  for (const seat of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, demote.id, "approve", t), t);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, demote.id), t), t);
  settleAll(fx.db, t + DAY);
  assert.deepEqual([member(fx, A), roleRows(fx, A).length], [{ status: "active", role: "C1" }, 4]);
  const vE = veto(fx, enroll, t + DAY + 1);
  assert.deepEqual([member(fx, A), roleRows(fx, A).length], [{ status: "revoked", role: "C1" }, 4]);
  assert.deepEqual(verifies(fx), { ok: true, problems: [] }, "the boundary is the enrollment veto, not the earlier record-only invite veto");
  assert.ok(vInvite.id !== vE.id);
  // The guard still holds after this history. The owner then reverses the demotion: recorded, no row.
  const vD = veto(fx, demote.id, t + DAY + 2);
  assert.deepEqual([member(fx, A), roleRows(fx, A).length, effects(fx, demote.id)], [{ status: "revoked", role: "C1" }, 4, [{ effect: "role.unchanged", reason: "revoked", role: "C1" }]]);
  assert.deepEqual(verifies(fx), { ok: true, problems: [] });
  const roster = fx.files.roster.body.principals;
  const reasons = (exp) => verifyExport(exp, roster).problems.map(p => `${p.kind}/${p.reason}${p.field ? "/" + p.field : ""}`).sort();
  // A forged re-projection citing that later veto (what 9b9f500 wrote) is past the real boundary: refused.
  const after = exportRelay(fx.db);
  after.roles.push({ member_id: A, seq: 5, role: "C2", decision_id: vD.id, at: t + DAY + 2 });
  after.members.find(m => m.member_id === A).role = "C2";
  refusedWith(reasons(after), ["member/member-projection-mismatch/role", "role/role-after-revocation", "role/role-event-missing"]);
  // A forged row citing the revoking veto itself sits at the boundary; no decision of that kind grants a role, so it is refused too.
  const atBoundary = exportRelay(fx.db);
  atBoundary.roles.push({ member_id: A, seq: 5, role: "C2", decision_id: vE.id, at: t + DAY + 1 });
  atBoundary.members.find(m => m.member_id === A).role = "C2";
  assert.ok(reasons(atBoundary).includes("role/role-decision-mismatch"), JSON.stringify(reasons(atBoundary)));
});

// --- D-C1 role-row binding (v3.4.3 9.3; verifier finding F-RECITE at 5ebc902, DC1-dup) --------------
// A forged role row that RE-CITES an earlier, still-effective grant, with members.role edited to match,
// was accepted for active and revoked members alike. Each row is now bound to the event that produced it
// (one row per decision, in decision-log order, at its event's time) and every member's role is
// re-derived from the decisions. The verifier's probe and the scope seat's two probes run here; all of
// the verifier's re-citation
// cases are REQUIRED here (the probe itself requires only its earlier set).

test("the verifier's r17 probe (58a9f7fa): every re-citation shape is refused; the required set still holds", () => {
  const r = runProbe("r17-forge-after-invite.mjs", "0d0a888a370c4445f252be2ec5a02910c5daa09dc2275a678b91a6ebbceff349");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.file.required, { h1CleanRevokedC1: true, h1PostRevocationVetoWritesNoRow: true, h1ZzShapeRefusedAtBoundary: true, h1CitesRevokingVetoRefused: true });
  // The four F-RECITE histories, mandatory: completed invite (revoked, row-only and row+member), original
  // S5 (revoked), active, and an elevation after a legitimate demotion.
  assert.deepEqual(r.file.observed, { h1ReciteEarlierGrantRowOnlyRefused: true, h1ReciteEarlierGrantRowAndMemberRefused: true,
    s5ReciteEarlierGrantRowAndMemberRefused: true, activeReciteEarlierGrantRowAndMemberRefused: true, activeDemotedReciteC2GrantRefused: true });
  const h = r.file.histories;
  for (const [name, f] of [["completed invite", h.completedInvite.forgeries.reciteEarlierGrantRowAndMember], ["original S5", h.originalS5.forgeries.reciteEarlierGrantRowAndMember],
    ["active", h.activeControl.forgeries.reciteEarlierGrantRowAndMember], ["active, demoted then elevated", h.activeDemoted.forgeries.reciteEarlierGrantRowAndMember]]) {
    assert.equal(f.ok, false, name);
    assert.ok(f.problems.some(p => p.endsWith("/role-duplicate-decision")), `${name}: ${JSON.stringify(f.problems)}`);
    assert.ok(f.problems.some(p => p.includes(`${f.forgedRow}/role-order-mismatch`)), `${name}: ${JSON.stringify(f.problems)}`);
  }
  // The honest histories still verify, in both legitimate reversal orders (completed invite; S5).
  assert.deepEqual([h.completedInvite.afterRevocation.export.ok, h.originalS5.after.export.ok, h.activeControl.after.export.ok, h.activeDemoted.after.export.ok], [true, true, true, true]);
});

test("the scope seat's DC1-dup probes (115c5eef, fc4fe58a): honest exports verify; the re-cited row is refused with or without the member row", () => {
  for (const [name, sha] of [["active-forge-dup.mjs", "416d05beb0128f9d3989505f7d7ca36aa1a24da55eb963814bf6cb9a5755a1f4"],
    ["boundary-forge-dup.mjs", "9a0b4959e9d52356884c7835c58416a549ca7df1e4cc60e517d02f19c4c50a89"]]) {
    const r = runProbe(name, sha);
    assert.equal(r.code, 0, name + r.stdout + r.stderr);
    const o = JSON.parse(r.stdout.trim().split("\n").at(-1));
    assert.deepEqual([o.honest.ok, o.forgedRow.ok, o.forgedRowAndMember.ok], [true, false, false], name);
  }
});

test("D-C1: each role row is bound to its producing event; the role is re-derived from decisions for every status", () => {
  const fx = setup({ members: ["A"] });
  const { A, c1, c2, at } = toC2(fx);
  // A legitimate demotion to C1 (row 4), then the owner reverses it (re-projection row 5 = C2).
  const d = createDecision(fx.db, decision(fx, "seat-1", { cls: "D2", action: "role.change", subject: A, sponsor: "seat-1", args: { role: "C1" }, at }), at);
  for (const seat of ["seat-2", "seat-4", "seat-5"]) addVerdict(fx.db, approval(fx, seat, d.id, "approve", at), at);
  confirmOwnerRecord(fx.db, ownerConfirm(fx, "seat-6", outboxFor(fx.db, d.id), at), at);
  settleAll(fx.db, at + DAY);
  const v = veto(fx, d.id, at + DAY + 1);
  assert.deepEqual([member(fx, A), roleRows(fx, A).map(r => r.role)], [{ status: "active", role: "C2" }, ["C0", "C1", "C2", "C1", "C2"]]);
  assert.equal(roleRows(fx, A)[4].decision_id, v.id);
  const roster = fx.files.roster.body.principals;
  const clean = exportRelay(fx.db);
  assert.deepEqual(verifyExport(clean, roster), { ok: true, problems: [] }, "a grant row and a veto re-projection row both bind");
  const reasons = (mutate) => { const e = structuredClone(clean); mutate(e); return verifyExport(e, roster).problems.map(p => `${p.kind}/${p.reason}${p.field ? "/" + p.field : ""}`); };
  const row = (e, seq) => e.roles.find(r => r.member_id === A && r.seq === seq);
  refusedWith(reasons(e => { row(e, 3).at += 1; }), ["role/role-time-mismatch"]);
  refusedWith(reasons(e => { const [x, y] = [row(e, 2), row(e, 3)]; [x.decision_id, y.decision_id, x.role, y.role, x.at, y.at] = [y.decision_id, x.decision_id, y.role, x.role, y.at, x.at]; }), ["role/role-order-mismatch"]);
  refusedWith(reasons(e => { row(e, 5).decision_id = c2; row(e, 5).at = row(e, 3).at; }), ["role/role-duplicate-decision", "role/role-order-mismatch"]);
  refusedWith(reasons(e => { row(e, 5).role = "C1"; e.members.find(m => m.member_id === A).role = "C1"; }), ["role/role-decision-mismatch", "member/member-projection-mismatch/role"]);
  refusedWith(reasons(e => { e.roles = e.roles.filter(r => !(r.member_id === A && r.seq === 5)); }), ["role/role-ledger-mismatch"]);
  assert.ok(c1 && c2);
});
