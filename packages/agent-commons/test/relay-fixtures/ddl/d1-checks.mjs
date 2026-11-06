// Scope-seat D-1 checks: RC-2 guard by member status (+ pending, unknown member) and the whole-string
// pattern / family CHECKs. Usage: node d1-checks.mjs <candidate.sql> <control.sql>. Fixture rows only, :memory:.
import { DatabaseSync } from "node:sqlite"; import { readFileSync } from "node:fs";
const H = (c) => c.repeat(64);
const open = (f) => { const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON;"); db.exec(readFileSync(f, "utf8")); return db; };
function member(db, status) { // the implementer's rc2-guard-check fixture: M enrolled + confirmed on key 1, then put in `status`; 'd' = effective invite.create D0
  db.exec(`INSERT INTO fleet_principals VALUES ('A','ac-seat','a','active'),('B','ac-seat','b','active');
    INSERT INTO decisions(id,class,action,subject,sponsor,lane,state,served_by,created_at,body,sig) VALUES ('inv0','D0','invite.create','l0',NULL,'L','pending','m',0,'{}','s');
    UPDATE decisions SET state='effective' WHERE id='inv0';
    INSERT INTO invites(invite_id,kind,member_id,created_by,decision_id,secret_sha256,created_at,expires_at,voided_at) VALUES ('I0','enroll',NULL,'A','inv0','${H("s")}',0,86400000,NULL);
    INSERT INTO members(member_id,status,role,updated_at) VALUES ('M','pending',NULL,0);
    INSERT INTO keys VALUES ('${H("1")}','agent-1','member','M','pending',5,NULL);
    INSERT INTO enrollments(id,invite_id,kind,member_id,public_key,spent_at) VALUES ('E0','I0','enroll','M','${H("1")}',10);
    INSERT INTO decisions(id,class,action,subject,sponsor,lane,state,served_by,created_at,body,sig) VALUES ('d','D0','invite.create','x',NULL,'L','pending','m',40,'{}','s');
    UPDATE decisions SET state='effective' WHERE id='d';`);
  if (status === "pending") return;
  db.exec(`INSERT INTO owner_record_outbox(id,subject,line,line_sha256,created_at,confirmed_at,confirmed_by) VALUES ('ob','E0','l','${H("b")}',20,20,'A');
    UPDATE enrollments SET confirmed_by='B', confirmed_at=30, owner_line_ref='ob' WHERE id='E0';
    UPDATE keys SET status='active' WHERE public_key='${H("1")}';
    UPDATE members SET status='active', updated_at=30 WHERE member_id='M';`);
  if (status === "revoked") db.exec("UPDATE members SET status='revoked', updated_at=50 WHERE member_id='M'");
  if (status === "suspended") db.exec(`INSERT INTO decisions(id,class,action,subject,sponsor,lane,state,served_by,created_at,body,sig) VALUES ('ds','SUSPEND','suspend','M',NULL,NULL,'pending','m',45,'{}','s');
    UPDATE decisions SET state='effective' WHERE id='ds'; INSERT INTO suspensions VALUES ('s1','M','decision','ds',NULL,46,NULL,NULL);`);
}
const tryRun = (db, sql) => { try { db.exec(sql); return "accepted"; } catch (e) { return "refused (" + e.message.slice(0, 40) + ")"; } };
const cases = [];
for (const st of ["active", "suspended", "pending", "revoked", "unknown"]) cases.push([`rebind invite, member ${st}`, st === "active" || st === "suspended", (db) => {
  member(db, st === "unknown" ? "active" : st);
  return tryRun(db, `INSERT INTO invites(invite_id,kind,member_id,created_by,decision_id,secret_sha256,created_at,expires_at,voided_at) VALUES ('I','rebind','${st === "unknown" ? "NOPE" : "M"}','A','d','${H("t")}',60,86400060,NULL)`); }]);
for (const [pat, fam, ok] of [["claude-*","anthropic",1],["gpt-*","openai",1],["k3","moonshot",1],["kimi*","moonshot",1],["MiniMax-*","minimax",1],["grok-?","x-ai",1],
  ["a[b]*","fam",0],["a b","fam",0],["a/b","fam",0],["ok-*","OpenAI",0],["ok-*","a!",0],["ok-*","a b",0],["ok-*","a_b",0]])
  cases.push([`map pattern ${JSON.stringify(pat)} family ${JSON.stringify(fam)}`, !!ok, (db) => tryRun(db, `INSERT INTO policy_family_map VALUES (1,'${pat}','${fam}')`)]);
let pass = 0, live = 0; const [cand, ctl] = process.argv.slice(2);
for (const [name, wantOk, fn] of cases) {
  const got = fn(open(cand)), ctlGot = fn(open(ctl)), ok = (got === "accepted") === wantOk;
  if (ok) pass++; if (ctlGot !== got) live++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(42)} candidate: ${got.padEnd(48)} control: ${ctlGot}`);
}
console.log(`TOTAL ${cases.length}  PASS ${pass}  FAIL ${cases.length - pass}  (cases where the control differs: ${live})`);
