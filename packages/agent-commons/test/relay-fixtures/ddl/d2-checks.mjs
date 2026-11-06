// Does the §9.3 schema admit a veto-cited re-projection role row for an ALREADY-REVOKED member when an
// earlier grant survives? (the verifier's FINDING-S5 sequence: E -> C1 -> C2; reverse E; then reverse C2.) Scratch :memory:.
import { DatabaseSync } from "node:sqlite"; import { readFileSync } from "node:fs";

const H = c => c.repeat(64);

// Scope-seat D-2 check (S5: a revoked member's role is frozen). Fixture = the implementer's s5-schema-probe (2a0bf0a5) sequence:
// E -> C1 -> C2 (D2, posted, 24 h), owner veto of the C2 decision; REVOKED variant also reverses E first.
// Usage: node d2-checks.mjs <candidate.sql> <control.sql>. :memory:, FKs on, fixture rows only.
const REVOKED = String.raw`INSERT INTO fleet_principals VALUES ('A','ac-seat','anthropic','active'),('B','ac-seat','openai','active'),('O','owner',NULL,'active');
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('ic','D0','invite.create','l',NULL,'pending','m',0,'{}','s','L1');
UPDATE decisions SET state='effective' WHERE id='ic';
INSERT INTO invites VALUES ('I','enroll',NULL,'A','ic','${H("a")}',0,86400000,NULL);
INSERT INTO members(member_id,status,role,updated_at) VALUES ('M','pending',NULL,0);
INSERT INTO keys VALUES ('${H("1")}','uuaid:agentnet:agent:m1','member','M','pending',0,NULL);
INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E1','I','enroll','M','${H("1")}',10);
INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('o','E1','x','${H("c")}',10);
UPDATE owner_record_outbox SET confirmed_at=20, confirmed_by='A' WHERE id='o';
UPDATE enrollments SET confirmed_by='B', confirmed_at=30, owner_line_ref='o' WHERE id='E1';
UPDATE members SET status='active', updated_at=30 WHERE member_id='M';
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES
 ('dE','D0','enroll.confirm','M',NULL,'pending','m',30,'{}','s','L1'),('dC1','D0','role.c1','M',NULL,'pending','m',40,'{}','s','L1'),
 ('dC2','D2','role.change','M','A','pending','m',50,'{}','s','L1');
UPDATE decisions SET state='effective' WHERE id IN ('dE','dC1');
INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('o2','dC2','x','${H("d")}',50);
UPDATE owner_record_outbox SET confirmed_at=60, confirmed_by='A' WHERE id='o2';
UPDATE decisions SET owner_line_ref='o2', owner_posted_at=60, effect_at=86400060 WHERE id='dC2';
UPDATE decisions SET state='effective' WHERE id='dC2';
INSERT INTO roles VALUES ('M',1,'C0','dE',30),('M',2,'C1','dC1',40),('M',3,'C2','dC2',86400060);
-- owner reverses E: member revoked, role frozen at C2
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('v1','OWNER','veto','dE',NULL,'pending','m',90000000,'{"v":1}','s',NULL);
UPDATE decisions SET state='effective' WHERE id='v1'; UPDATE decisions SET state='reversed' WHERE id='dE';
UPDATE members SET status='revoked', updated_at=90000000 WHERE member_id='M';
-- owner then reverses the C2 decision
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('v2','OWNER','veto','dC2',NULL,'pending','m',90000100,'{"v":2}','s',NULL);
UPDATE decisions SET state='effective' WHERE id='v2'; UPDATE decisions SET state='reversed' WHERE id='dC2';`;
const UNREVOKED = String.raw`INSERT INTO fleet_principals VALUES ('A','ac-seat','anthropic','active'),('B','ac-seat','openai','active'),('O','owner',NULL,'active');
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('ic','D0','invite.create','l',NULL,'pending','m',0,'{}','s','L1');
UPDATE decisions SET state='effective' WHERE id='ic';
INSERT INTO invites VALUES ('I','enroll',NULL,'A','ic','${H("a")}',0,86400000,NULL);
INSERT INTO members(member_id,status,role,updated_at) VALUES ('M','pending',NULL,0);
INSERT INTO keys VALUES ('${H("1")}','uuaid:agentnet:agent:m1','member','M','pending',0,NULL);
INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E1','I','enroll','M','${H("1")}',10);
INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('o','E1','x','${H("c")}',10);
UPDATE owner_record_outbox SET confirmed_at=20, confirmed_by='A' WHERE id='o';
UPDATE enrollments SET confirmed_by='B', confirmed_at=30, owner_line_ref='o' WHERE id='E1';
UPDATE members SET status='active', updated_at=30 WHERE member_id='M';
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES
 ('dE','D0','enroll.confirm','M',NULL,'pending','m',30,'{}','s','L1'),('dC1','D0','role.c1','M',NULL,'pending','m',40,'{}','s','L1'),
 ('dC2','D2','role.change','M','A','pending','m',50,'{}','s','L1');
UPDATE decisions SET state='effective' WHERE id IN ('dE','dC1');
INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at) VALUES ('o2','dC2','x','${H("d")}',50);
UPDATE owner_record_outbox SET confirmed_at=60, confirmed_by='A' WHERE id='o2';
UPDATE decisions SET owner_line_ref='o2', owner_posted_at=60, effect_at=86400060 WHERE id='dC2';
UPDATE decisions SET state='effective' WHERE id='dC2';
INSERT INTO roles VALUES ('M',1,'C0','dE',30),('M',2,'C1','dC1',40),('M',3,'C2','dC2',86400060);
-- owner reverses E: member revoked, role frozen at C2



-- owner then reverses the C2 decision
INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('v2','OWNER','veto','dC2',NULL,'pending','m',90000100,'{"v":2}','s',NULL);
UPDATE decisions SET state='effective' WHERE id='v2'; UPDATE decisions SET state='reversed' WHERE id='dC2';`;
const open = (f, fx) => { const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON;"); db.exec(readFileSync(f, "utf8")); db.exec(fx); return db; };
const tryIt = (db, sql) => { try { db.exec(sql); return "accepted"; } catch (e) { return "refused (" + e.message.slice(0, 32) + ")"; } };
const B2 = "INSERT INTO roles VALUES ('M',4,'C1','v2',90000100)";
const B1 = `INSERT INTO decisions(id,class,action,subject,sponsor,state,served_by,created_at,body,sig,lane) VALUES ('dC1b','D0','role.c1','M',NULL,'pending','m',90000200,'{"v":3}','s','L1'); UPDATE decisions SET state='effective' WHERE id='dC1b'; INSERT INTO roles VALUES ('M',4,'C1','dC1b',90000200)`;
const cases = [
  ["revoked: veto-cited re-projection row (verifier S5)", REVOKED, B2, false],
  ["revoked: grant row from a new effective role.c1", REVOKED, B1, false],
  ["unrevoked control: veto-cited re-projection to C1", UNREVOKED, B2, true],
  ["unrevoked control: grant row from a new role.c1", UNREVOKED, B1, true],
];
let pass = 0, live = 0; const [cand, ctl] = process.argv.slice(2);
for (const [name, fx, sql, wantOk] of cases) {
  const got = tryIt(open(cand, fx), sql), c = tryIt(open(ctl, fx), sql), ok = (got === "accepted") === wantOk;
  if (ok) pass++; if (c !== got) live++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(50)} candidate: ${got.padEnd(40)} control: ${c}`);
}
console.log(`TOTAL ${cases.length}  PASS ${pass}  FAIL ${cases.length - pass}  (cases where the control differs: ${live})`);
