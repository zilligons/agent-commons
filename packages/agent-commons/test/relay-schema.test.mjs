// Port of the relay.db schema check for spec v3.4.2 (schema-check-v342.mjs, sha256
// ad18a292dc24705c8d8fa7a203f1729a706f9f6f49ed83f3e16fdb432ec40a5e, from the spec author:
// 153 cases + 69 one-guard mutants, including the D items, D-1 and D-2), run against the CODE's DDL
// (schema.mjs: the spec v3.4.2 section 9.3 block plus the L0 extension tables), not only the spec's.
// H, SEED, CASES, MUTANTS, run() and pass() are copied verbatim from that file; only the driver below
// is new. The scope seat's D, D-1 and D-2 oracles run in relay-rebind-schema.test.mjs.
// Scratch :memory: databases only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CORE_DDL, DDL, EXTENSION_DDL, SPEC_PIN, assertForeignKeys } from "../src/relay/schema.mjs";

const H = t => createHash("sha256").update(t).digest("hex");

const SEED = `
INSERT INTO fleet_principals VALUES
 ('A','ac-seat','anthropic','active'),('B','ac-seat','openai','active'),('C','ac-seat','google','active'),
 ('S','ac-seat','deepseek','active'),('V','verifier','openai','active'),('O','owner',NULL,'active'),
 ('X','measurer',NULL,'active'),('K','security',NULL,'active');
INSERT INTO policy_family_map VALUES (1,'claude-*','anthropic'),(1,'gpt-*','openai'),(1,'k3','moonshot'),(1,'kimi*','moonshot'),(1,'MiniMax-*','minimax');
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES
 ('ic-IA','D0','invite.create','lbl-IA',NULL,'pending','m',0,'{}','s','L1'),('ic-IB','D0','invite.create','lbl-IB',NULL,'pending','m',0,'{}','s','L1'),
 ('ic-IR','D0','invite.create','lbl-IR',NULL,'pending','m',0,'{}','s','L1'),('ic-IRB','D0','invite.create','lbl-IRB',NULL,'pending','m',0,'{}','s','L1'),
 ('ic-IR2','D0','invite.create','lbl-IR2',NULL,'pending','m',0,'{}','s','L1'),('ic-IRB2','D0','invite.create','lbl-IRB2',NULL,'pending','m',0,'{}','s','L1'),
 ('ic-PEND','D0','invite.create','lbl-PEND',NULL,'pending','m',0,'{}','s','L1');
UPDATE decisions SET state='effective' WHERE id LIKE 'ic-%' AND id <> 'ic-PEND';
INSERT INTO members(member_id,status,role,updated_at) VALUES ('M','pending',NULL,0);
INSERT INTO keys VALUES ('${"1".repeat(64)}','uuaid:agentnet:agent:m1','member','M','pending',0,NULL);
INSERT INTO invites VALUES ('IA','enroll',NULL,'A','ic-IA','${"a".repeat(64)}',0,86400000,NULL),
                           ('IB','enroll',NULL,'B','ic-IB','${"b".repeat(64)}',0,86400000,NULL);
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES
 ('d1','D1','accept','sub1',NULL,'pending','m',0,'{}','s','L1'),
 ('d2','D2','role.change','M','S','pending','m',0,'{}','s','L1');
`;
// Member M enrolled through IA and confirmed by B, then active.
const ENROLLED = `
INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E1','IA','enroll','M','${"1".repeat(64)}',1000);
INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('oE1','E1','enrolled M','${"c".repeat(64)}',1000);
UPDATE owner_record_outbox SET confirmed_at=2000, confirmed_by='A' WHERE id='oE1';
`;
const CONFIRMED = ENROLLED + `
UPDATE enrollments SET confirmed_by='B', confirmed_at=3000, owner_line_ref='oE1' WHERE id='E1';
UPDATE members SET status='active', updated_at=3000 WHERE member_id='M';
`;
const D2_POSTED = `
INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('od2','d2','d2 posted','${"d".repeat(64)}',1000);
UPDATE owner_record_outbox SET confirmed_at=5000, confirmed_by='A' WHERE id='od2';
`;
const SUSPEND_DECISION = `
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dS','SUSPEND','suspend','M',NULL,'pending','m',0,'{}','s',NULL);
UPDATE decisions SET state='effective' WHERE id='dS';
`;
// v3.3 (C1): every verdict carries prev = sha256 of the approver's previous body, and its own body_sha256.
// Fixture bodies are "<decision>|<approver>|<seq>", so the chain is consistent unless a case overrides it.
const bodyOf = (d, who, seq) => `${d}|${who}|${seq}`;
const ap = (d, who, verdict = "approve", seq = 1, kind = "ac-seat", fam = { A: "anthropic", B: "openai", C: "google", S: "deepseek", V: "openai" }[who] ?? null,
            { prev = seq > 1 ? H(bodyOf(d, who, seq - 1)) : null, body = bodyOf(d, who, seq), sig = "s" } = {}) =>
  `INSERT INTO approvals VALUES ('${d}','${who}',${seq},${prev === null ? "NULL" : `'${prev}'`},'${verdict}','${kind}',${fam === null ? "NULL" : `'${fam}'`},'m',0,'${body}','${H(body)}','${sig}');`;
// v3.3 (C5): a measurer's attestation of the target verdict's turn.
const att = ({ id = "at1", d = "d2", by = "A", seq = 1, measurer = "X", model = "claude-opus-5-5", turn = [model], family = "anthropic", sha = H(bodyOf(d, by, seq)), pv = 1 } = {}) =>
  `INSERT INTO served_by_attestations VALUES ('${id}','${d}','${by}',${seq},'${measurer}','sess','rec','${model}','${JSON.stringify(turn)}','${family}','${sha}','model-of','${"7".repeat(64)}',100,${pv},200,'{}','s');`;
// D-item fixtures: member M active (CONFIRMED), a live re-bind attempt IRB (unspent) with its open suspension.
const REBIND_LIVE = CONFIRMED + `INSERT INTO invites VALUES ('IRB','rebind','M','A','ic-IRB','${"f".repeat(64)}',7000,86407000,NULL);
  INSERT INTO suspensions VALUES ('suB','M','rebind',NULL,'IRB',7000,NULL,NULL);`;
// ...the same attempt, dead by expiry (unspent; relay time >= expires_at).
const REBIND_DEAD = REBIND_LIVE + `INSERT INTO rebind_ends VALUES ('IRB','invite-expired',NULL,86407000);`;
const REINSTATE_EFF = `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dRe','D2','reinstate','M','S','pending','m',0,'{}','s','L1');
  INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('odRe','dRe','x','${"9".repeat(64)}',1);
  UPDATE owner_record_outbox SET confirmed_at=100, confirmed_by='A' WHERE id='odRe';
  UPDATE decisions SET owner_line_ref='odRe', owner_posted_at=100, effect_at=86400100 WHERE id='dRe';
  UPDATE decisions SET state='effective' WHERE id='dRe';`;
// D-2 fixture: the verifier's FINDING-S5 sequence. E -> C1 -> measured C2; the owner reverses E (member revoked,
// frozen at C2, 3 rows), then reverses the C2 decision while the C1 grant survives.
const S5_BASE = (revoke) => CONFIRMED + `
  INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES
   ('dE','D0','enroll.confirm','M',NULL,'pending','m',30,'{"id":"dE"}','s','L1'),('dC1','D0','role.c1','M',NULL,'pending','m',40,'{"id":"dC1"}','s','L1'),
   ('dC2','D2','role.change','M','S','pending','m',50,'{"id":"dC2"}','s','L1');
  UPDATE decisions SET state='effective' WHERE id IN ('dE','dC1');
  INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('oC2','dC2','x','${"8".repeat(64)}',50);
  UPDATE owner_record_outbox SET confirmed_at=60, confirmed_by='A' WHERE id='oC2';
  UPDATE decisions SET owner_line_ref='oC2', owner_posted_at=60, effect_at=86400060 WHERE id='dC2';
  UPDATE decisions SET state='effective' WHERE id='dC2';
  INSERT INTO roles VALUES ('M',1,'C0','dE',30),('M',2,'C1','dC1',40),('M',3,'C2','dC2',86400060);` +
  (revoke ? VETO("vE", "dE") + "UPDATE decisions SET state='reversed' WHERE id='dE'; UPDATE members SET status='revoked', updated_at=90000000 WHERE member_id='M';" : "")
  + VETO("vC2", "dC2") + "UPDATE decisions SET state='reversed' WHERE id='dC2';";
const VETO = (id, target) => `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('${id}','OWNER','veto','${target}',NULL,'pending','m',0,'{"veto":"${id}"}','s',NULL); UPDATE decisions SET state='effective' WHERE id='${id}';`;

// [name, setup, action, expect: "ok" | error substring, note]
const CASES = [
  // verifier author cases
  ["author-control", "INSERT INTO decision_authors VALUES ('d1','A');", ap("d1", "B"), "ok"],
  ["author-insert", "INSERT INTO decision_authors VALUES ('d1','A');", ap("d1", "A"), "author-cannot-approve"],
  ["author-update", "INSERT INTO decision_authors VALUES ('d1','A');" + ap("d1", "B"), "UPDATE approvals SET approver='A'", "append-only"],
  ["author-late", ap("d1", "A"), "INSERT INTO decision_authors VALUES ('d1','A');", "authors-frozen"],
  ["author-delete", "INSERT INTO decision_authors VALUES ('d1','A');", "DELETE FROM decision_authors", "append-only"],
  ["author-may-reject", "INSERT INTO decision_authors VALUES ('d1','A');", ap("d1", "A", "reject"), "ok"],
  // verifier sponsor cases
  ["sponsor-control", "", ap("d2", "A"), "ok"],
  ["sponsor-insert", "", ap("d2", "S"), "sponsor-excluded"],
  ["sponsor-update", ap("d2", "A"), "UPDATE approvals SET approver='S'", "append-only"],
  ["sponsor-parent-update", ap("d2", "A"), "UPDATE decisions SET sponsor='A' WHERE id='d2'", "decision-immutable"],
  ["sponsor-object-refused (A1)", "", ap("d2", "S", "object"), "sponsor-excluded"],
  ["sponsor-withdraw-ends-d2 (A1)", "", ap("d2", "S", "withdraw"), "ok",
    db => db.prepare("SELECT state FROM decisions WHERE id='d2'").get().state === "withdrawn"],
  ["nonsponsor-object-allowed (A1)", "", ap("d2", "A", "object"), "ok",
    db => db.prepare("SELECT state FROM decisions WHERE id='d2'").get().state === "pending"],
  ["class-retarget", "", "UPDATE decisions SET class='D2', sponsor='S' WHERE id='d1'", "decision-immutable"],
  ["approval-wrong-family", "", ap("d2", "A", "approve", 1, "ac-seat", "openai"), "approver-not-in-roster"],
  ["approval-seq-gap", "", ap("d2", "A", "approve", 2), "approval-seq"],
  ["approval-withdraw-then-approve", ap("d2", "A", "object"), ap("d2", "A", "withdraw", 2) + ap("d2", "A", "approve", 3), "ok",
    db => db.prepare("SELECT state FROM decisions WHERE id='d2'").get().state === "pending"],
  // R3: no stored 'objected' state; a blocked decision stays pending and a withdraw unblocks it
  ["objected-state-refused (R3)", "", "UPDATE decisions SET state='objected' WHERE id='d2'", "illegal-transition"],
  // verifier confirmer cases
  ["confirm-control", ENROLLED, "UPDATE enrollments SET confirmed_by='B', confirmed_at=3000, owner_line_ref='oE1' WHERE id='E1'", "ok"],
  ["confirm-insert", "", `INSERT INTO enrollments VALUES ('E1','IA','enroll','M','${"1".repeat(64)}',1000,'B',3000,NULL)`, "enrollment-starts-unconfirmed"],
  ["confirm-creator", ENROLLED, "UPDATE enrollments SET confirmed_by='A', confirmed_at=3000, owner_line_ref='oE1' WHERE id='E1'", "confirmer-is-invite-creator"],
  ["confirm-retarget", CONFIRMED, "UPDATE enrollments SET invite_id='IB' WHERE id='E1'", "enrollment-immutable"],
  ["confirm-orphan", "", `INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E9','missing','enroll','M','${"1".repeat(64)}',1000)`, "invite-mismatch-or-dead"],
  ["confirm-no-owner-line", `INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E1','IA','enroll','M','${"1".repeat(64)}',1000);
     INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('oE1','E1','x','${"c".repeat(64)}',1000);`,
    "UPDATE enrollments SET confirmed_by='B', confirmed_at=3000, owner_line_ref='oE1' WHERE id='E1'", "confirm-precondition"],
  ["confirm-not-seat", ENROLLED, "UPDATE enrollments SET confirmed_by='V', confirmed_at=3000, owner_line_ref='oE1' WHERE id='E1'", "confirmer-not-ac-seat"],
  ["confirm-twice", CONFIRMED, "UPDATE enrollments SET confirmed_by='C' WHERE id='E1'", "enrollment-immutable"],
  ["invite-creator-change", ENROLLED, "UPDATE invites SET created_by='B' WHERE invite_id='IA'", "invite-immutable"],
  // verifier single-use cases
  ["invite-duplicate", ENROLLED, `INSERT INTO members(member_id,status,role,updated_at) VALUES ('M2','pending',NULL,0); INSERT INTO keys VALUES ('${"2".repeat(64)}','uuaid:agentnet:agent:m2','member','M2','pending',0,NULL); INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E2','IA','enroll','M2','${"2".repeat(64)}',1500)`, "UNIQUE"],
  ["invite-retarget-reuse", ENROLLED, "UPDATE enrollments SET invite_id='IB' WHERE id='E1'", "enrollment-immutable"],
  ["invite-delete-reuse", ENROLLED, "DELETE FROM enrollments", "append-only"],
  ["invite-expired-at-boundary", "", `INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E1','IA','enroll','M','${"1".repeat(64)}',86400000)`, "invite-mismatch-or-dead"],
  ["invite-kind-mismatch", `INSERT INTO invites VALUES ('IR','rekey','M','A','ic-IR','${"e".repeat(64)}',0,86400000,NULL);`, `INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E1','IR','enroll','M','${"1".repeat(64)}',1000)`, "invite-mismatch-or-dead"],
  ["invite-voided", "UPDATE invites SET voided_at=500 WHERE invite_id='IA';", `INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E1','IA','enroll','M','${"1".repeat(64)}',1000)`, "invite-mismatch-or-dead"],
  // verifier D2 time cases
  ["d2-boundary", D2_POSTED, "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at=86405000 WHERE id='d2'", "ok"],
  ["d2-early", D2_POSTED, "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at=86404999 WHERE id='d2'", "CHECK"],
  ["d2-effective-null", "", "UPDATE decisions SET state='effective' WHERE id='d2'", "CHECK"],
  ["d2-effective-before-time (reducer-owned: now >= effect_at, N19)", D2_POSTED + "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at=86405000 WHERE id='d2';", "UPDATE decisions SET state='effective' WHERE id='d2'", "ok"],
  ["d2-nonnumeric", D2_POSTED, "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at='not-a-time' WHERE id='d2'", "cannot store"],
  ["d2-post-unconfirmed", `INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('od2','d2','x','${"d".repeat(64)}',1000);`, "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at=86405000 WHERE id='d2'", "owner-post-unconfirmed"],
  ["d2-post-rewrite", D2_POSTED + "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at=86405000 WHERE id='d2';", "UPDATE decisions SET owner_posted_at=4000, effect_at=86404000 WHERE id='d2'", "decision-immutable"],
  ["decision-illegal-transition", "UPDATE decisions SET state='lapsed' WHERE id='d1';", "UPDATE decisions SET state='effective' WHERE id='d1'", "illegal-transition"],
  ["verdict-on-closed", "UPDATE decisions SET state='lapsed' WHERE id='d1';", ap("d1", "B"), "decision-closed"],
  // verifier role cases
  ["role-control", CONFIRMED + D2_POSTED + "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at=86405000 WHERE id='d2'; UPDATE decisions SET state='effective' WHERE id='d2';",
    "INSERT INTO roles VALUES ('M',1,'C3','d2',86405000)", "ok"],
  ["role-insert", CONFIRMED + D2_POSTED + "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at=86405000 WHERE id='d2'; UPDATE decisions SET state='effective' WHERE id='d2';", "INSERT INTO roles VALUES ('M',1,'C4','d2',86405000)", "CHECK"],
  ["role-update", CONFIRMED + D2_POSTED + "UPDATE decisions SET owner_line_ref='od2', owner_posted_at=5000, effect_at=86405000 WHERE id='d2'; UPDATE decisions SET state='effective' WHERE id='d2'; INSERT INTO roles VALUES ('M',1,'C3','d2',86405000);",
    "UPDATE roles SET role='C2'", "append-only"],
  ["role-pending-decision", CONFIRMED, "INSERT INTO roles VALUES ('M',1,'C2','d2',0)", "role-needs-effective-decision"],
  ["role-direct-write", CONFIRMED, "UPDATE members SET role='C3' WHERE member_id='M'", "role-is-a-projection"],
  // verifier suspension cases
  ["suspend-control", CONFIRMED + "INSERT INTO claims VALUES ('c1','T1','M',1,'live',99999999,NULL,NULL); INSERT INTO submissions VALUES ('s1','M','in-review');" + SUSPEND_DECISION,
    "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL)", "ok",
    db => JSON.stringify([db.prepare("SELECT status FROM members WHERE member_id='M'").get().status, db.prepare("SELECT state,released_reason,released_at FROM claims").get(), db.prepare("SELECT state FROM submissions").get().state])
      === JSON.stringify(["suspended", { state: "released", released_reason: "suspension", released_at: 7000 }, "held"])],
  ["suspend-late-claim", CONFIRMED + SUSPEND_DECISION + "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);", "INSERT INTO claims VALUES ('c1','T1','M',1,'live',99999999,NULL,NULL)", "member-not-active"],
  ["suspend-same-status", CONFIRMED, "UPDATE members SET status='suspended', updated_at=7000 WHERE member_id='M'", "status-follows-suspensions"],
  ["suspend-direct-reactivate", CONFIRMED + SUSPEND_DECISION + "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);", "UPDATE members SET status='active' WHERE member_id='M'", "status-follows-suspensions"],
  ["suspend-end-without-decision", CONFIRMED + SUSPEND_DECISION + "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);", "UPDATE suspensions SET ended_at=8000, ended_by_decision='dS' WHERE id='su1'", "suspension-end-needs-matching-decision"],
  ["held-cannot-accept", CONFIRMED + "INSERT INTO submissions VALUES ('s1','M','in-review');" + SUSPEND_DECISION + "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);", "UPDATE submissions SET state='accepted'", "submission-held"],
  ["claim-no-revival", CONFIRMED + "INSERT INTO claims VALUES ('c1','T1','M',1,'live',99999999,NULL,NULL); UPDATE claims SET state='expired';", "UPDATE claims SET state='live'", "claim-closed"],
  // RD1 / RD2 / keys
  ["key-delete", "", "DELETE FROM keys", "append-only"],
  ["key-revoked-terminal", `UPDATE keys SET status='revoked', revoked_at=10 WHERE agent='uuaid:agentnet:agent:m1';`, "UPDATE keys SET status='active', revoked_at=NULL WHERE agent='uuaid:agentnet:agent:m1'", "key-immutable"],
  ["key-reinsert", "", `INSERT INTO keys VALUES ('${"1".repeat(64)}','uuaid:agentnet:agent:mX','member','M9','pending',0,NULL)`, "UNIQUE"],
  ["rekey-while-suspended", CONFIRMED + SUSPEND_DECISION + `INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);
     INSERT INTO invites VALUES ('IR','rekey','M','A','ic-IR','${"e".repeat(64)}',7000,86407000,NULL);
     INSERT INTO keys VALUES ('${"3".repeat(64)}','uuaid:agentnet:agent:m3','member','M','pending',7100,NULL);`,
    `INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E3','IR','rekey','M','${"3".repeat(64)}',7200)`, "member-suspended"],
  ["rebind-without-own-suspension", CONFIRMED + `INSERT INTO invites VALUES ('IRB','rebind','M','A','ic-IRB','${"f".repeat(64)}',7000,86407000,NULL);
     INSERT INTO keys VALUES ('${"4".repeat(64)}','uuaid:agentnet:agent:m4','member','M','pending',7100,NULL);`,
    `INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E4','IRB','rebind','M','${"4".repeat(64)}',7200)`, "rebind-needs-own-suspension"],
  ["rebind-ends-only-own-suspension", CONFIRMED + SUSPEND_DECISION + `INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);
     INSERT INTO invites VALUES ('IRB','rebind','M','A','ic-IRB','${"f".repeat(64)}',7000,86407000,NULL);
     INSERT INTO suspensions VALUES ('su2','M','rebind',NULL,'IRB',7000,NULL,NULL);
     INSERT INTO keys VALUES ('${"4".repeat(64)}','uuaid:agentnet:agent:m4','member','M','pending',7100,NULL);
     INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E4','IRB','rebind','M','${"4".repeat(64)}',7200);
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dR','D1R','rebind.confirm','E4',NULL,'pending','m',7300,'{}','s',NULL);
     ${ap("dR", "B")} ${ap("dR", "C")}
     INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('odR','dR','rebind','${"9".repeat(64)}',7400);
     UPDATE owner_record_outbox SET confirmed_at=7500, confirmed_by='B' WHERE id='odR';
     UPDATE decisions SET owner_line_ref='odR', owner_posted_at=7500 WHERE id='dR';
     UPDATE decisions SET state='effective' WHERE id='dR';`,
    "UPDATE suspensions SET ended_at=7600, ended_by_decision='dR' WHERE id='su2'", "ok",
    db => db.prepare("SELECT status FROM members WHERE member_id='M'").get().status === "suspended"],
  ["rebind-creator-approval", CONFIRMED + `INSERT INTO invites VALUES ('IRB','rebind','M','A','ic-IRB','${"f".repeat(64)}',7000,86407000,NULL);
     INSERT INTO suspensions VALUES ('su2','M','rebind',NULL,'IRB',7000,NULL,NULL);
     INSERT INTO keys VALUES ('${"4".repeat(64)}','uuaid:agentnet:agent:m4','member','M','pending',7100,NULL);
     INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E4','IRB','rebind','M','${"4".repeat(64)}',7200);
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dR','D1R','rebind.confirm','E4',NULL,'pending','m',7300,'{}','s',NULL);`,
    ap("dR", "A"), "confirmer-is-invite-creator"],
  ["d1r-effective-without-post", CONFIRMED + `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dR','D1R','rebind.confirm','E4',NULL,'pending','m',7300,'{}','s',NULL);`,
    "UPDATE decisions SET state='effective' WHERE id='dR'", "CHECK"],
  ["member-insert-active", "", "INSERT INTO members(member_id,status,role,updated_at) VALUES ('MX','active','C3',0)", "member-starts-pending"],
  // R1: claim and submission bindings
  ["claim-retarget (R1)", CONFIRMED + "INSERT INTO members(member_id,status,role,updated_at) VALUES ('M2','pending',NULL,0); INSERT INTO claims VALUES ('c1','T1','M',1,'live',99999999,NULL,NULL);",
    "UPDATE claims SET member_id='M2' WHERE claim_id='c1'", "claim-immutable"],
  ["claim-renew-active (R1)", CONFIRMED + "INSERT INTO claims VALUES ('c1','T1','M',1,'live',99999999,NULL,NULL);",
    "UPDATE claims SET lease_until=99999999+1000 WHERE claim_id='c1'", "ok"],
  ["claim-renew-after-suspension (R1)", CONFIRMED + "INSERT INTO claims VALUES ('c1','T1','M',1,'live',99999999,NULL,NULL);" + SUSPEND_DECISION + "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);",
    "UPDATE claims SET lease_until=99999999+1000 WHERE claim_id='c1'", "claim-immutable"],
  ["submission-retarget (R1)", CONFIRMED + "INSERT INTO members(member_id,status,role,updated_at) VALUES ('M2','pending',NULL,0); INSERT INTO submissions VALUES ('s1','M','in-review');",
    "UPDATE submissions SET member_id='M2' WHERE submission_id='s1'", "submission-immutable"],
  // R2: status lifecycle
  ["status-pending-to-active-unconfirmed (R2)", "", "UPDATE members SET status='active', updated_at=10 WHERE member_id='M'", "status-lifecycle"],
  ["status-back-to-pending (R2)", CONFIRMED, "UPDATE members SET status='pending' WHERE member_id='M'", "status-lifecycle"],
  ["status-suspended-to-pending (R2)", CONFIRMED + SUSPEND_DECISION + "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);",
    "UPDATE members SET status='pending' WHERE member_id='M'", "status-lifecycle"],
  ["status-pending-to-revoked (R2)", "", "UPDATE members SET status='revoked', updated_at=10 WHERE member_id='M'", "ok"],
  // R4: the creator and not-a-seat refusals carry different messages
  ["confirm-creator-message (R4)", ENROLLED, "UPDATE enrollments SET confirmed_by='A', confirmed_at=3000, owner_line_ref='oE1' WHERE id='E1'", "confirmer-is-invite-creator"],
  // ---- v3.4.2 D-2 (S5): a revoked member's role is frozen; no role row after revocation ----
  ["s5-reprojection-revoked-refused (D-2, B2)", S5_BASE(true), "INSERT INTO roles VALUES ('M',4,'C1','vC2',90000100)", "role-frozen-revoked",
    db => db.prepare("SELECT status, role FROM members WHERE member_id='M'").get().role === "C2"],
  ["s5-new-grant-revoked-refused (D-2, B1)", S5_BASE(true) + `
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dC1b','D0','role.c1','M',NULL,'pending','m',90000200,'{"id":"dC1b"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id='dC1b';`,
    "INSERT INTO roles VALUES ('M',4,'C1','dC1b',90000200)", "role-frozen-revoked"],
  ["s5-reprojection-unrevoked-ok (D-2 control)", S5_BASE(false), "INSERT INTO roles VALUES ('M',4,'C1','vC2',90000100)", "ok",
    db => db.prepare("SELECT role FROM members WHERE member_id='M'").get().role === "C1"],
  ["s5-new-grant-unrevoked-ok (D-2 control)", S5_BASE(false) + `
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dC1b','D0','role.c1','M',NULL,'pending','m',90000200,'{"id":"dC1b"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id='dC1b';`,
    "INSERT INTO roles VALUES ('M',4,'C1','dC1b',90000200)", "ok"],
  // ---- v3.4 the D items (R-B) and D-1 ----
  ["invite-without-decision (D)", "", `INSERT INTO invites(invite_id,kind,member_id,created_by,secret_sha256,created_at,expires_at) VALUES ('IX','enroll',NULL,'A','${"a".repeat(64)}',0,86400000)`, "invite-needs-decision"],
  ["invite-pending-decision (D)", "", `INSERT INTO invites VALUES ('IX','enroll',NULL,'A','ic-PEND','${"a".repeat(64)}',0,86400000,NULL)`, "invite-needs-decision"],
  ["invite-decision-reused (D)", "", `INSERT INTO invites VALUES ('IX','enroll',NULL,'A','ic-IA','${"a".repeat(64)}',0,86400000,NULL)`, "UNIQUE"],
  ["invite-decision-retarget (D)", "", "UPDATE invites SET decision_id='ic-IR' WHERE invite_id='IA'", "invite-immutable"],
  ["rebind-invite-revoked-member (D-1 RC-2)", CONFIRMED + "UPDATE members SET status='revoked', updated_at=5000 WHERE member_id='M';",
    `INSERT INTO invites VALUES ('IRB','rebind','M','A','ic-IRB','${"f".repeat(64)}',7000,86407000,NULL)`, "rebind-member-not-enrolled"],
  ["rebind-invite-pending-member (D-1 RC-2)", "", `INSERT INTO invites VALUES ('IRB','rebind','M','A','ic-IRB','${"f".repeat(64)}',7000,86407000,NULL)`, "rebind-member-not-enrolled"],
  ["rebind-invite-suspended-member-ok (D-1 RC-2)", CONFIRMED + SUSPEND_DECISION + "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);",
    `INSERT INTO invites VALUES ('IRB','rebind','M','A','ic-IRB','${"f".repeat(64)}',7000,86407000,NULL)`, "ok"],
  ["rebind-second-live-attempt (D)", REBIND_LIVE, `INSERT INTO invites VALUES ('IRB2','rebind','M','A','ic-IRB2','${"f".repeat(64)}',8000,86408000,NULL)`, "rebind-attempt-live"],
  ["rebind-retry-after-death (D)", REBIND_DEAD, `INSERT INTO invites VALUES ('IRB2','rebind','M','A','ic-IRB2','${"f".repeat(64)}',86408000,172808000,NULL)`, "ok"],
  ["rebind-end-expired-ok (D)", REBIND_LIVE, `INSERT INTO rebind_ends VALUES ('IRB','invite-expired',NULL,86407000)`, "ok"],
  ["rebind-end-expired-early (D)", REBIND_LIVE, `INSERT INTO rebind_ends VALUES ('IRB','invite-expired',NULL,86406999)`, "rebind-end-invalid"],
  ["rebind-end-not-rebind (D)", "", `INSERT INTO rebind_ends VALUES ('IA','invite-expired',NULL,86400000)`, "rebind-end-invalid"],
  ["rebind-end-cancel-no-decision (D)", REBIND_LIVE + "UPDATE invites SET voided_at=8000 WHERE invite_id='IRB';", `INSERT INTO rebind_ends VALUES ('IRB','cancelled',NULL,8000)`, "rebind-end-invalid"],
  // Isolates the cause/decision CHECK: rebind_ends_only_dead accepts a timely expiry whatever its decision_id.
  ["rebind-end-expired-with-decision (D)", REBIND_LIVE, `INSERT INTO rebind_ends VALUES ('IRB','invite-expired','ic-IRB',86407000)`, "CHECK"],
  ["rebind-end-twice (D)", REBIND_DEAD, `INSERT INTO rebind_ends VALUES ('IRB','invite-expired',NULL,86408000)`, "UNIQUE"],
  ["rebind-end-append-only (D)", REBIND_DEAD, "UPDATE rebind_ends SET cause='invite-voided'", "append-only"],
  ["rebind-end-no-delete (D)", REBIND_DEAD, "DELETE FROM rebind_ends", "append-only"],
  ["rebind-dead-reinstate-ends-suspension (D)", REBIND_DEAD + REINSTATE_EFF, "UPDATE suspensions SET ended_at=86500000, ended_by_decision='dRe' WHERE id='suB'", "ok",
    db => db.prepare("SELECT status FROM members WHERE member_id='M'").get().status === "active"],
  ["rebind-live-reinstate-refused (D)", REBIND_LIVE + REINSTATE_EFF, "UPDATE suspensions SET ended_at=86500000, ended_by_decision='dRe' WHERE id='suB'", "suspension-end-needs-matching-decision"],
  ["rebind-dead-superseded (D)", REBIND_DEAD + `INSERT INTO invites VALUES ('IRB2','rebind','M','A','ic-IRB2','${"f".repeat(64)}',86408000,172808000,NULL);
     INSERT INTO suspensions VALUES ('suB2','M','rebind',NULL,'IRB2',86408000,NULL,NULL);`,
    "UPDATE suspensions SET ended_at=86408000, ended_by_decision='ic-IRB2' WHERE id='suB'", "ok",
    db => db.prepare("SELECT status FROM members WHERE member_id='M'").get().status === "suspended"],
  // A spent attempt that died by enrollment expiry: its pending D1R can never take effect.
  ["rebind-confirm-on-dead-attempt (D)", REBIND_LIVE + `INSERT INTO keys VALUES ('${"4".repeat(64)}','uuaid:agentnet:agent:m4','member','M','pending',7100,NULL);
     INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E4','IRB','rebind','M','${"4".repeat(64)}',7200);
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dR','D1R','rebind.confirm','E4',NULL,'pending','m',7300,'{}','s',NULL);
     INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('odR','dR','rebind','${"9".repeat(64)}',7400);
     UPDATE owner_record_outbox SET confirmed_at=7500, confirmed_by='B' WHERE id='odR';
     UPDATE decisions SET owner_line_ref='odR', owner_posted_at=7500 WHERE id='dR';
     UPDATE keys SET status='revoked', revoked_at=259207200 WHERE agent='uuaid:agentnet:agent:m4';
     INSERT INTO rebind_ends VALUES ('IRB','enrollment-expired',NULL,259207200);`,
    "UPDATE decisions SET state='effective' WHERE id='dR'", "rebind-attempt-dead"],
  ["family-whole-string (D-1)", "", "INSERT INTO policy_family_map VALUES (1,'zz-*','a!')", "CHECK"],
  ["pattern-whole-string (D-1)", "", "INSERT INTO policy_family_map VALUES (1,'a[b]*','anthropic')", "CHECK"],
  ["pattern-family-ok (D-1)", "", "INSERT INTO policy_family_map VALUES (1,'grok-?','x-ai')", "ok"],
  // ---- v3.3.2 S1: stored, immutable lane ----
  ["lane-retarget (S1)", "", "UPDATE decisions SET lane='L2' WHERE id='d1'", "decision-immutable"],
  ["lane-missing-on-d1 (S1)", "", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dL','D1','accept','sub8',NULL,'pending','m',0,'{}','s',NULL)`, "CHECK"],
  ["lane-on-suspend (S1)", "", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dL','SUSPEND','suspend','M',NULL,'pending','m',0,'{}','s','L1')`, "CHECK"],
  // ---- v3.3.2 S2: implicit approval only by the creator ----
  ["implicit-wrong-seat-d0 (S2)", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dW','D0','task.open','T9',NULL,'pending','m',0,'{"id":"dW","by":"A"}','sW','L1');`,
    ap("dW", "B", "approve", 1, undefined, undefined, { body: '{"id":"dW","by":"A"}', sig: "sW" }), "implicit-approval"],
  ["implicit-wrong-seat-d1 (S2)", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dW','D1','accept','sub7',NULL,'pending','m',0,'{"id":"dW","by":"B"}','sW','L1');`,
    ap("dW", "A", "approve", 1, undefined, undefined, { body: '{"id":"dW","by":"B"}', sig: "sW" }), "implicit-approval"],
  ["implicit-wrong-seat-d1r (S2)", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dW','D1R','rebind.confirm','E9',NULL,'pending','m',0,'{"id":"dW","by":"A"}','sW',NULL);`,
    ap("dW", "C", "approve", 1, undefined, undefined, { body: '{"id":"dW","by":"A"}', sig: "sW" }), "implicit-approval"],
  ["implicit-right-seat-d1r (S2)", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dW','D1R','rebind.confirm','E9',NULL,'pending','m',0,'{"id":"dW","by":"A"}','sW',NULL);`,
    ap("dW", "A", "approve", 1, undefined, undefined, { body: '{"id":"dW","by":"A"}', sig: "sW" }), "ok"],
  // ---- v3.3.2 S3: per-decision measurer exclusion ----
  ["measurer-is-sponsor (S3)", ap("d2", "A") + "UPDATE fleet_principals SET kind='measurer', runtime_family=NULL WHERE principal_id='S';", att({ measurer: "S" }), "measurer-conflict"],
  ["measurer-is-author (S3)", "INSERT INTO decision_authors VALUES ('d1','X');" + ap("d1", "B"), att({ d: "d1", by: "B", family: "anthropic" }), "measurer-conflict"],
  ["measurer-is-ex-voter (S3)", ap("d2", "A") + ap("d2", "C") + "UPDATE fleet_principals SET kind='measurer', runtime_family=NULL WHERE principal_id='C';", att({ measurer: "C" }), "measurer-conflict"],
  ["measurer-is-creator (S3)", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dK','D1','accept','sub6',NULL,'pending','m',0,'{"id":"dK","by":"X"}','sK','L1');` + ap("dK", "B"),
    att({ d: "dK", by: "B" }), "measurer-conflict"],
  // ---- v3.3.2 S4 / E-1: security findings ----
  ["finding-open-by-security (S4)", "", `INSERT INTO security_findings(id,member_id,opened_by,opened_at,body,sig) VALUES ('f1','M','K',10,'{}','${"a".repeat(128)}')`, "ok"],
  ["finding-open-by-owner (S4)", "", `INSERT INTO security_findings(id,member_id,opened_by,opened_at,body,sig) VALUES ('f1','M','O',10,'{}','${"a".repeat(128)}')`, "finding-not-security"],
  ["finding-open-preclosed (S4)", "", `INSERT INTO security_findings VALUES ('f1','M','K',10,'{}','${"a".repeat(128)}','K',11,'{}','${"b".repeat(128)}')`, "finding-not-security"],
  ["finding-close-by-security (S4)", `INSERT INTO security_findings(id,member_id,opened_by,opened_at,body,sig) VALUES ('f1','M','K',10,'{}','${"a".repeat(128)}');`,
    `UPDATE security_findings SET closed_by='K', closed_at=20, close_body='{}', close_sig='${"b".repeat(128)}' WHERE id='f1'`, "ok"],
  ["finding-close-by-owner (S4, E-1)", `INSERT INTO security_findings(id,member_id,opened_by,opened_at,body,sig) VALUES ('f1','M','K',10,'{}','${"a".repeat(128)}');`,
    `UPDATE security_findings SET closed_by='O', closed_at=20, close_body='{}', close_sig='${"b".repeat(128)}' WHERE id='f1'`, "finding-not-security"],
  ["finding-close-twice (S4)", `INSERT INTO security_findings(id,member_id,opened_by,opened_at,body,sig) VALUES ('f1','M','K',10,'{}','${"a".repeat(128)}');
     UPDATE security_findings SET closed_by='K', closed_at=20, close_body='{}', close_sig='${"b".repeat(128)}' WHERE id='f1';`,
    `UPDATE security_findings SET closed_at=30 WHERE id='f1'`, "finding-fixed"],
  ["finding-edit-open (S4)", `INSERT INTO security_findings(id,member_id,opened_by,opened_at,body,sig) VALUES ('f1','M','K',10,'{}','${"a".repeat(128)}');`,
    `UPDATE security_findings SET member_id='M2' WHERE id='f1'`, "finding-fixed"],
  ["finding-delete (S4)", `INSERT INTO security_findings(id,member_id,opened_by,opened_at,body,sig) VALUES ('f1','M','K',10,'{}','${"a".repeat(128)}');`,
    `DELETE FROM security_findings`, "finding-fixed"],
  ["finding-close-partial (S4)", `INSERT INTO security_findings(id,member_id,opened_by,opened_at,body,sig) VALUES ('f1','M','K',10,'{}','${"a".repeat(128)}');`,
    `UPDATE security_findings SET closed_by='K', closed_at=20, close_sig='${"b".repeat(128)}' WHERE id='f1'`, "CHECK"],
  // ---- v3.3.2 S5: no empty projection; a revoked member gets no re-projection row ----
  ["role-reprojection-after-enroll-reversed (S5)", CONFIRMED + `
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dE','D0','enroll.confirm','M',NULL,'pending','m',0,'{"id":"dE"}','s','L1'),('dC1','D0','role.c1','M',NULL,'pending','m',0,'{"id":"dC1"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id IN ('dE','dC1');
     INSERT INTO roles VALUES ('M',1,'C0','dE',1),('M',2,'C1','dC1',2);` + VETO("dV1", "dE") + "UPDATE decisions SET state='reversed' WHERE id='dE'; UPDATE members SET status='revoked', updated_at=5 WHERE member_id='M';"
     + VETO("dV2", "dC1") + "UPDATE decisions SET state='reversed' WHERE id='dC1';",
    "INSERT INTO roles VALUES ('M',3,'C0','dV2',3)", "role-frozen-revoked"],
  // ---- v3.3 C1: verdict chain and replay ----
  ["approval-prev-wrong (C1)", ap("d2", "A", "object"), ap("d2", "A", "withdraw", 2, undefined, undefined, { prev: "e".repeat(64) }), "approval-seq"],
  ["approval-prev-at-seq1 (C1)", "", ap("d2", "A", "approve", 1, undefined, undefined, { prev: "e".repeat(64) }), "approval-seq"],
  ["approval-body-replay (C1)", ap("d2", "A", "approve") + ap("d2", "A", "withdraw", 2),
    ap("d2", "A", "approve", 3, undefined, undefined, { prev: H(bodyOf("d2", "A", 2)), body: bodyOf("d2", "A", 1) }), "UNIQUE"],
  ["approval-body-replay-other-seat (C1)", ap("d2", "A", "approve"), ap("d2", "B", "approve", 1, undefined, undefined, { body: bodyOf("d2", "A", 1) }), "UNIQUE"],
  ["implicit-approval-ok (C1)", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dI','D1','accept','sub9',NULL,'pending','m',0,'{"id":"dI","by":"A"}','sI','L1');`,
    ap("dI", "A", "approve", 1, undefined, undefined, { body: '{"id":"dI","by":"A"}', sig: "sI" }), "ok"],
  ["implicit-approval-wrong-sig (C1)", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dI','D1','accept','sub9',NULL,'pending','m',0,'{"id":"dI","by":"A"}','sI','L1');`,
    ap("dI", "A", "approve", 1, undefined, undefined, { body: '{"id":"dI","by":"A"}', sig: "other" }), "implicit-approval"],
  ["implicit-approval-on-d2 (C1)", "", ap("d2", "A", "approve", 1, undefined, undefined, { body: "{}" }), "implicit-approval"],
  ["object-on-d1 (N4)", "", ap("d1", "B", "object"), "object-d2-only"],
  ["reject-on-d1-allowed (N4)", "", ap("d1", "B", "reject"), "ok"],
  // ---- v3.3 C3: owner reversal ----
  ["veto-needed (C3)", "", "UPDATE decisions SET state='vetoed' WHERE id='d2'", "veto-needed"],
  ["veto-of-pending-d2 (C3)", VETO("dV", "d2"), "UPDATE decisions SET state='vetoed' WHERE id='d2'", "ok"],
  ["reverse-accept (C3)", `INSERT INTO submissions VALUES ('sA','M','accepted');
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dA','D1','accept','sA',NULL,'pending','m',0,'{"id":"dA"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id='dA';` + VETO("dV", "dA") + "UPDATE decisions SET state='reversed' WHERE id='dA';",
    "UPDATE submissions SET state='reversed' WHERE submission_id='sA'", "ok"],
  ["submission-reversed-without-reversal (C3)", "INSERT INTO submissions VALUES ('sA','M','accepted');", "UPDATE submissions SET state='reversed' WHERE submission_id='sA'", "submission-reversal"],
  ["submission-reversed-terminal (C3)", `INSERT INTO submissions VALUES ('sA','M','accepted');
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dA','D1','accept','sA',NULL,'pending','m',0,'{"id":"dA"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id='dA';` + VETO("dV", "dA") + "UPDATE decisions SET state='reversed' WHERE id='dA'; UPDATE submissions SET state='reversed' WHERE submission_id='sA';",
    "UPDATE submissions SET state='in-review' WHERE submission_id='sA'", "submission-reversal"],
  ["reversed-decision-final (C3)", `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dA','D1','accept','sA',NULL,'pending','m',0,'{"id":"dA"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id='dA';` + VETO("dV", "dA") + "UPDATE decisions SET state='reversed' WHERE id='dA';",
    "UPDATE decisions SET state='effective' WHERE id='dA'", "illegal-transition"],
  ["suspend-reversal-ends-suspension (C3)", CONFIRMED + SUSPEND_DECISION + "INSERT INTO suspensions VALUES ('su1','M','decision','dS',NULL,7000,NULL,NULL);" + VETO("dV", "dS"),
    "UPDATE suspensions SET ended_at=8000, ended_by_decision='dV' WHERE id='su1'", "ok",
    db => db.prepare("SELECT status FROM members WHERE member_id='M'").get().status === "active"],
  ["role-reprojection (C3)", CONFIRMED + `
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dE','D0','enroll.confirm','M',NULL,'pending','m',0,'{"id":"dE"}','s','L1'),('dC1','D0','role.c1','M',NULL,'pending','m',0,'{"id":"dC1"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id IN ('dE','dC1');
     INSERT INTO roles VALUES ('M',1,'C0','dE',1),('M',2,'C1','dC1',2);` + VETO("dV", "dC1") + "UPDATE decisions SET state='reversed' WHERE id='dC1';",
    "INSERT INTO roles VALUES ('M',3,'C0','dV',3)", "ok",
    db => db.prepare("SELECT role FROM members WHERE member_id='M'").get().role === "C0"],
  ["role-reprojection-wrong-role (C3)", CONFIRMED + `
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dE','D0','enroll.confirm','M',NULL,'pending','m',0,'{"id":"dE"}','s','L1'),('dC1','D0','role.c1','M',NULL,'pending','m',0,'{"id":"dC1"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id IN ('dE','dC1');
     INSERT INTO roles VALUES ('M',1,'C0','dE',1),('M',2,'C1','dC1',2);` + VETO("dV", "dC1") + "UPDATE decisions SET state='reversed' WHERE id='dC1';",
    "INSERT INTO roles VALUES ('M',3,'C1','dV',3)", "role-needs-effective-decision"],
  ["role-reprojection-unreversed (C3)", CONFIRMED + `
     INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dE','D0','enroll.confirm','M',NULL,'pending','m',0,'{"id":"dE"}','s','L1'),('dC1','D0','role.c1','M',NULL,'pending','m',0,'{"id":"dC1"}','s','L1');
     UPDATE decisions SET state='effective' WHERE id IN ('dE','dC1');
     INSERT INTO roles VALUES ('M',1,'C0','dE',1),('M',2,'C1','dC1',2);` + VETO("dV", "dC1"),
    "INSERT INTO roles VALUES ('M',3,'C0','dV',3)", "role-needs-effective-decision"],
  // ---- v3.3 C5: served-by attestations ----
  ["attest-ok (C5)", ap("d2", "A"), att(), "ok"],
  ["attest-not-measurer (C5)", ap("d2", "A"), att({ measurer: "B" }), "attest-not-measurer"],
  ["attest-body-mismatch (C5)", ap("d2", "A"), att({ sha: "e".repeat(64) }), "attest-body-mismatch"],
  ["attest-no-target (C5)", ap("d2", "A"), att({ seq: 9 }), "attest-body-mismatch"],
  ["attest-unknown-model (C5)", ap("d2", "A"), att({ model: "<synthetic>", family: "anthropic" }), "attest-family-map"],
  ["attest-wrong-family (C5)", ap("d2", "A"), att({ model: "MiniMax-M3", family: "anthropic" }), "attest-family-map"],
  ["attest-mixed-turn (C5)", ap("d2", "A"), att({ turn: ["claude-opus-5-5", "MiniMax-M3"] }), "attest-mixed-turn"],
  ["attest-model-not-in-turn (C5)", ap("d2", "A"), att({ turn: ["claude-sonnet-5-5"] }), "attest-mixed-turn"],
  ["attest-old-policy (C5)", ap("d2", "A") + "INSERT INTO policy_family_map VALUES (2,'claude-*','anthropic');", att(), "attest-family-map"],
  ["attest-ambiguous-map (C5)", ap("d2", "A") + "INSERT INTO policy_family_map VALUES (1,'claude-opus*','other');", att(), "attest-family-map"],
  ["attest-append-only (C5)", ap("d2", "A") + att(), "UPDATE served_by_attestations SET family='openai'", "append-only"],
  ["policy-map-append-only (C5)", "", "UPDATE policy_family_map SET family='other' WHERE pattern='k3'", "append-only"],
  ["measurer-cannot-vote (C5)", "", ap("d2", "X", "approve", 1, "measurer", null), "approver-not-ac-seat"],
];

// One-guard mutants: removing only the guard must flip its detector case.
const dropTrigger = name => ddl => { const i = ddl.indexOf(`CREATE TRIGGER ${name} `); if (i < 0) throw new Error(`no trigger ${name}`); return ddl.slice(0, i) + ddl.slice(ddl.indexOf("END;", i) + 4); };
const replaceOnce = (a, b) => ddl => { if (ddl.split(a).length !== 2) throw new Error(`mutant anchor not unique: ${a}`); return ddl.replace(a, b); };
const MUTANTS = [
  ["approvals_no_author", dropTrigger("approvals_no_author"), "author-insert"],
  ["approvals_no_update (author)", dropTrigger("approvals_no_update"), "author-update"],
  ["authors_frozen", dropTrigger("authors_frozen"), "author-late"],
  ["approvals_no_sponsor_d2", dropTrigger("approvals_no_sponsor_d2"), "sponsor-insert"],
  ["sponsor_withdraw_ends_d2 (A1)", dropTrigger("sponsor_withdraw_ends_d2"), "sponsor-withdraw-ends-d2 (A1)"],
  ["decisions_immutable", dropTrigger("decisions_immutable"), "sponsor-parent-update"],
  ["enroll_confirm_not_creator", dropTrigger("enroll_confirm_not_creator"), "confirm-creator"],
  ["enroll_confirm_by_seat (R4)", dropTrigger("enroll_confirm_by_seat"), "confirm-not-seat"],
  ["approvals_prev_chain (C1)", dropTrigger("approvals_prev_chain"), "approval-prev-wrong (C1)"],
  ["UNIQUE(decision_id, body_sha256) (C1)", replaceOnce(",\n  UNIQUE(decision_id, body_sha256)", ""), "approval-body-replay (C1)"],
  ["approvals_implicit (C1)", dropTrigger("approvals_implicit"), "implicit-approval-wrong-sig (C1)"],
  ["approvals_object_d2_only (N4)", dropTrigger("approvals_object_d2_only"), "object-on-d1 (N4)"],
  ["decisions_veto_needed (C3)", dropTrigger("decisions_veto_needed"), "veto-needed (C3)"],
  ["submissions_reversed (C3)", dropTrigger("submissions_reversed"), "submission-reversed-without-reversal (C3)"],
  ["suspension veto clause (C3)", replaceOnce("\n         OR (OLD.reason = 'decision' AND d.class = 'OWNER' AND d.action = 'veto' AND d.subject = OLD.decision_id)", ""), "suspend-reversal-ends-suspension (C3)"],
  ["role re-projection clause (C3)", replaceOnce("AND t.state = 'reversed' AND t.subject = NEW.member_id", "AND 0"), "role-reprojection (C3)"],
  ["role re-projection equality (C3)", replaceOnce("AND NEW.role IS (SELECT r.role FROM roles r", "AND 'x' IS (SELECT 'x' FROM roles r"), "role-reprojection-wrong-role (C3)"],
  ["attest_measurer (C5)", dropTrigger("attest_measurer"), "attest-not-measurer (C5)"],
  ["attest_target_body (C5)", dropTrigger("attest_target_body"), "attest-body-mismatch (C5)"],
  ["attest_family_map (C5)", dropTrigger("attest_family_map"), "attest-wrong-family (C5)"],
  ["attest_unmixed (C5)", dropTrigger("attest_unmixed"), "attest-mixed-turn (C5)"],
  ["approvals_ac_seat_only (C5)", dropTrigger("approvals_ac_seat_only"), "measurer-cannot-vote (C5)"],
  ["decision lane immutability (S1)", replaceOnce(" OR NEW.lane IS NOT OLD.lane", ""), "lane-retarget (S1)"],
  ["decision lane presence CHECK (S1)", replaceOnce("  CHECK ((class IN ('D0','D1','D2')) = (lane IS NOT NULL)),\n", ""), "lane-missing-on-d1 (S1)"],
  ["implicit creator conjunct (S2)", replaceOnce("\n        OR NEW.approver IS NOT (SELECT json_extract(d.body, '$.by') FROM decisions d WHERE d.id = NEW.decision_id)", ""), "implicit-wrong-seat-d1 (S2)"],
  ["measurer sponsor conjunct (S3)", replaceOnce("NEW.measurer IS (SELECT d.sponsor FROM decisions d WHERE d.id = NEW.decision_id)", "0"), "measurer-is-sponsor (S3)"],
  ["measurer creator conjunct (S3)", replaceOnce("NEW.measurer IS (SELECT json_extract(d.body, '$.by') FROM decisions d WHERE d.id = NEW.decision_id)", "0"), "measurer-is-creator (S3)"],
  ["measurer author conjunct (S3)", replaceOnce("EXISTS (SELECT 1 FROM decision_authors a WHERE a.decision_id = NEW.decision_id AND a.principal = NEW.measurer)", "0"), "measurer-is-author (S3)"],
  ["measurer voter conjunct (S3)", replaceOnce("EXISTS (SELECT 1 FROM approvals a WHERE a.decision_id = NEW.decision_id AND a.approver = NEW.measurer)", "0"), "measurer-is-ex-voter (S3)"],
  ["security_findings_open (S4)", dropTrigger("security_findings_open"), "finding-open-by-owner (S4)"],
  ["security_findings_close_by_security (S4)", dropTrigger("security_findings_close_by_security"), "finding-close-by-owner (S4, E-1)"],
  ["security_findings_close_once (S4)", dropTrigger("security_findings_close_once"), "finding-close-twice (S4)"],
  ["security_findings_no_delete (S4)", dropTrigger("security_findings_no_delete"), "finding-delete (S4)"],
  ["invites_need_decision (D)", dropTrigger("invites_need_decision"), "invite-pending-decision (D)"],
  ["invites decision_id immutability (D)", replaceOnce("    OR NEW.decision_id IS NOT OLD.decision_id OR OLD.voided_at IS NOT NULL", "    OR OLD.voided_at IS NOT NULL"), "invite-decision-retarget (D)"],
  ["rebind_confirm_needs_live_attempt (D)", dropTrigger("rebind_confirm_needs_live_attempt"), "rebind-confirm-on-dead-attempt (D)"],
  ["invites decision_id UNIQUE (D)", replaceOnce("decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id),   -- R-B", "decision_id TEXT NOT NULL REFERENCES decisions(id),   -- R-B"), "invite-decision-reused (D)"],
  ["rebind_one_live_attempt (D)", dropTrigger("rebind_one_live_attempt"), "rebind-second-live-attempt (D)"],
  ["rebind_invite_member_enrolled (D-1 RC-2)", dropTrigger("rebind_invite_member_enrolled"), "rebind-invite-revoked-member (D-1 RC-2)"],
  ["rebind_ends_only_dead (D)", dropTrigger("rebind_ends_only_dead"), "rebind-end-expired-early (D)"],
  ["rebind_ends_no_update (D)", dropTrigger("rebind_ends_no_update"), "rebind-end-append-only (D)"],
  ["rebind_ends_no_delete (D)", dropTrigger("rebind_ends_no_delete"), "rebind-end-no-delete (D)"],
  ["rebind_ends cause/decision CHECK (D)", replaceOnce("  CHECK ((cause IN ('cancelled','reversed','reinstated')) = (decision_id IS NOT NULL))\n", "  CHECK (1)\n"), "rebind-end-expired-with-decision (D)"],
  ["suspension end, dead-attempt clause (D)", replaceOnce("OR (OLD.reason = 'rebind' AND EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = OLD.invite_id)", "OR (0 AND EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = OLD.invite_id)"), "rebind-dead-reinstate-ends-suspension (D)"],
  ["suspension end, dead-attempt guard (D)", replaceOnce("OR (OLD.reason = 'rebind' AND EXISTS (SELECT 1 FROM rebind_ends r WHERE r.invite_id = OLD.invite_id)", "OR (OLD.reason = 'rebind' AND 1"), "rebind-live-reinstate-refused (D)"],
  ["family whole-string CHECK (D-1)", replaceOnce("\n                              AND family NOT GLOB '*[^a-z0-9-]*'", ""), "family-whole-string (D-1)"],
  ["pattern whole-string CHECK (D-1)", replaceOnce("\n                               AND pattern NOT GLOB '*[^A-Za-z0-9.*?_-]*'", ""), "pattern-whole-string (D-1)"],
  ["roles_frozen_when_revoked (D-2)", dropTrigger("roles_frozen_when_revoked"), "s5-new-grant-revoked-refused (D-2, B1)"],
  ["roles_frozen_when_revoked, re-projection path (D-2)", dropTrigger("roles_frozen_when_revoked"), "s5-reprojection-revoked-refused (D-2, B2)"],
  ["claims_binding_immutable (R1)", dropTrigger("claims_binding_immutable"), "claim-retarget (R1)"],
  ["submissions_binding_immutable (R1)", dropTrigger("submissions_binding_immutable"), "submission-retarget (R1)"],
  ["members_status_lifecycle (R2)", dropTrigger("members_status_lifecycle"), "status-pending-to-active-unconfirmed (R2)"],
  // Two guards refuse a stored 'objected': the state CHECK and the transition trigger. Remove both.
  ["no 'objected' state (R3)", ddl => replaceOnce("NEW.state IN ('pending','effective','vetoed','lapsed','withdrawn'))", "NEW.state IN ('pending','effective','vetoed','objected','lapsed','withdrawn'))")(replaceOnce("'pending','effective','vetoed','lapsed','withdrawn','reversed')),", "'pending','effective','vetoed','objected','lapsed','withdrawn','reversed')),")(ddl)), "objected-state-refused (R3)"],
  ["enroll_confirm_once", dropTrigger("enroll_confirm_once"), "confirm-retarget"],
  ["enroll_matches_invite", dropTrigger("enroll_matches_invite"), "invite-kind-mismatch"],
  ["invite UNIQUE", replaceOnce("invite_id TEXT NOT NULL UNIQUE REFERENCES invites(invite_id)", "invite_id TEXT NOT NULL REFERENCES invites(invite_id)"), "invite-duplicate"],
  ["enroll_no_delete", dropTrigger("enroll_no_delete"), "invite-delete-reuse"],
  ["D2 window CHECK", replaceOnce("CHECK (class <> 'D2' OR effect_at IS NULL OR effect_at = owner_posted_at + 86400000),", ""), "d2-early"],
  ["D2 effective-needs-post CHECK", replaceOnce("CHECK (class NOT IN ('D2','D1R') OR state NOT IN ('effective','reversed') OR owner_posted_at IS NOT NULL)", "CHECK (1)"), "d2-effective-null"],
  ["STRICT on decisions", replaceOnce("  CHECK (class NOT IN ('D2','D1R') OR state NOT IN ('effective','reversed') OR owner_posted_at IS NOT NULL)\n) STRICT;", "  CHECK (class NOT IN ('D2','D1R') OR state NOT IN ('effective','reversed') OR owner_posted_at IS NOT NULL)\n);"), "d2-nonnumeric"],
  ["decisions_post_confirmed", dropTrigger("decisions_post_confirmed"), "d2-post-unconfirmed"],
  // Two guards catch C4: the roles CHECK and the members.role projection CHECK. Remove both.
  ["roles CHECK + members.role CHECK", ddl => replaceOnce("role TEXT CHECK (role IN ('C0','C1','C2','C3')),", "role TEXT,")(replaceOnce("role TEXT NOT NULL CHECK (role IN ('C0','C1','C2','C3')),\n  decision_id", "role TEXT NOT NULL,\n  decision_id")(ddl)), "role-insert"],
  ["roles_need_decision", dropTrigger("roles_need_decision"), "role-pending-decision"],
  ["suspension_opens release", replaceOnce("UPDATE claims SET state = 'released', released_reason = 'suspension', released_at = NEW.started_at\n      WHERE member_id = NEW.member_id AND state = 'live';", ""), "suspend-control"],
  ["claims_member_active", dropTrigger("claims_member_active"), "suspend-late-claim"],
  ["members_status_follows_suspensions", dropTrigger("members_status_follows_suspensions"), "suspend-same-status"],
  ["rekey_not_suspended", dropTrigger("rekey_not_suspended"), "rekey-while-suspended"],
  ["approvals_no_invite_creator_d1r", dropTrigger("approvals_no_invite_creator_d1r"), "rebind-creator-approval"],
  ["keys_no_delete", dropTrigger("keys_no_delete"), "key-delete"],
];

function run(ddl, c) {
  const [, setup, action, expect, oracle] = c;
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  if (db.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) throw new Error("foreign_keys not on");
  db.exec(ddl); db.exec(SEED); if (setup) db.exec(setup);
  try { db.exec(action); } catch (e) { return { accepted: false, error: e.message }; }
  return { accepted: true, oracleOk: oracle ? oracle(db) : true };
}
const pass = (c, r) => c[3] === "ok" ? r.accepted && r.oracleOk : !r.accepted && r.error.includes(c[3]);
// The spec is a repo file, not a package file: in an installed copy of the package (a /node_modules/ path
// segment) this one test skips. In the repo it always runs, and fails if the spec is missing.
const INSTALLED_COPY = fileURLToPath(import.meta.url).includes("/node_modules/");
test("CORE_DDL is byte-identical to the section 9.3 block of the pinned spec (v3.4.6 at f49c073), the scope seat's D-2 statements",
  { skip: INSTALLED_COPY ? "repo-only: the spec is not part of the package" : false }, () => {
  const spec = readFileSync(new URL("../../../docs/plans/cloud-commons-relay.md", import.meta.url), "utf8");
  const start = spec.indexOf("```sql\n") + 7;
  const block = spec.slice(start, spec.indexOf("```", start));
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  assert.equal(CORE_DDL, block);
  assert.equal(SPEC_PIN.commit, "f49c073");
  assert.equal(sha(spec), SPEC_PIN.sha256);
  assert.equal(sha(CORE_DDL), SPEC_PIN.core_ddl_sha256);
  assert.equal(SPEC_PIN.core_ddl_sha256, "ca400877c714c0143479743d1704935501f48dfd75241b8940ab86e2ca017b14", "the section 9.3 block of spec v3.4.6 (its two reworded comment lines; no statement change)");
});

test("extension DDL changes no 9.3 table and repeats no mutant anchor", () => {
  for (const table of ["fleet_principals", "members", "keys", "owner_record_outbox", "invites", "enrollments", "decisions",
    "decision_authors", "approvals", "suspensions", "claims", "submissions", "roles", "policy_family_map", "served_by_attestations",
    "security_findings", "rebind_ends"])
    assert.equal(EXTENSION_DDL.includes(`CREATE TABLE ${table}(`), false, table);
  assert.equal(/ALTER TABLE/i.test(EXTENSION_DDL), false);
  for (const [, , detector] of MUTANTS) assert.ok(CASES.some(c => c[0] === detector), detector);
});

test("foreign keys are read back, and a connection without them is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  assert.throws(() => assertForeignKeys(db), /foreign_keys/);
  db.exec("PRAGMA foreign_keys = ON;");
  assertForeignKeys(db);
});

for (const c of CASES) {
  test(`schema case ${c[0]} (expect ${c[3]})`, () => {
    const r = run(DDL, c);
    assert.ok(pass(c, r), r.accepted ? `accepted${r.oracleOk ? "" : " (oracle failed)"}` : `refused: ${r.error}`);
  });
}

// Mutants remove a section 9.3 guard: they apply to CORE_DDL, then the extension tables are re-appended
// (an anchor may also occur in an extension guard, which is not the guard under test).
for (const [name, mutate, detector] of MUTANTS) {
  test(`schema mutant ${name}: detector ${detector} is green, and red once only this guard is removed`, () => {
    const c = CASES.find(x => x[0] === detector);
    assert.ok(pass(c, run(DDL, c)), "green on the code's DDL");
    assert.equal(pass(c, run(mutate(CORE_DDL) + "\n" + EXTENSION_DDL, c)), false, "red after removal");
  });
}

test("the port runs every case and mutant of the source check", () => {
  assert.equal(CASES.length, 153);
  assert.equal(MUTANTS.length, 69);
});
