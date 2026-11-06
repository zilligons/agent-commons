// Fixture keys remain in memory. Product source is imported read-only from argv[2].
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const here=dirname(fileURLToPath(import.meta.url));
const archiveRoot=resolve(process.argv[2]??resolve(here,'archive'));

const moduleAt=p=>pathToFileURL(resolve(here,'../../..',p)).href;
const F=await import(moduleAt('test/relay-fixtures.mjs'));
const G=await import(moduleAt('src/relay/governance.mjs'));
const S=await import(moduleAt('src/relay/signing.mjs'));
const {T0,DAY}=F;
function snapshot(fx,member){
  return {member:{...fx.db.prepare('SELECT status,role FROM members WHERE member_id=?').get(member)},roles:fx.db.prepare('SELECT seq,role,decision_id,at FROM roles WHERE member_id=? ORDER BY seq').all(member).map(r=>({...r})),decisions:fx.db.prepare('SELECT id,class,action,state FROM decisions WHERE subject=? ORDER BY created_at,id').all(member).map(r=>({...r})),exportVerification:S.verifyExport(S.exportRelay(fx.db),fx.files.roster.body.principals)};
}
function prepare(){
  const fx=F.setup({members:['A']}),member=F.promoteC1(fx,'A'); F.eligibleForC2(fx,'A');
  const at=T0+3*DAY;
  const d=F.createDecision(fx.db,F.decision(fx,'seat-1',{cls:'D2',action:'role.change',subject:member,sponsor:'seat-1',args:{role:'C2'},at}),at);
  for(const seat of ['seat-2','seat-4','seat-5'])F.addVerdict(fx.db,F.approval(fx,seat,d.id,'approve',at),at);
  F.confirmOwnerRecord(fx.db,F.ownerConfirm(fx,'seat-6',F.outboxFor(fx.db,d.id),at),at);
  G.settleAll(fx.db,at+DAY);
  const enroll=fx.db.prepare("SELECT id FROM decisions WHERE action='enroll.confirm' AND subject=?").get(member).id;
  return {fx,member,d,enroll,at:at+DAY+1};
}
function veto(fx,id,at){return F.createDecision(fx.db,F.decision(fx,'owner',{cls:'OWNER',action:'veto',subject:id,at}),at);}

// Scope-seat probe: the verifier's witness flow (revoked member, then its C2 decision reversed), then forge the REAL export.
const {fx,member,d,enroll,at}=prepare();
veto(fx,enroll,at); const v2=veto(fx,d.id,at+1);
const exp=S.exportRelay(fx.db);
const reasons=x=>{const r=S.verifyExport(x, fx.files.roster.body.principals); return {ok:r.ok, problems:(r.problems??[]).map(p=>[p.kind??p.type,p.reason??p.code??p.problem].filter(Boolean).join('/'))};};
const clean=reasons(exp);
const row=structuredClone(exp); const rr=row.roles.filter(r=>r.member_id===member); const last=rr[rr.length-1];
row.roles.push({...last, seq:last.seq+1, role:'C1', decision_id:v2.id, at:at+2});
const rowOnly=reasons(row);
const both=structuredClone(row); both.members.find(m=>m.member_id===member).role='C1';
const rowAndMember=reasons(both);
const out={clean,rowOnly,rowAndMember,pass: clean.ok===true && rowOnly.ok===false && rowAndMember.ok===false};
console.log(JSON.stringify(out)); fx.db.close(); process.exitCode=out.pass?0:1;
