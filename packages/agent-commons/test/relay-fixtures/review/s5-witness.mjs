// Fixture keys remain in memory. Product source is imported read-only from argv[2].
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const here=dirname(fileURLToPath(import.meta.url));
const archiveRoot=resolve(process.argv[2]??resolve(here,'archive'));
const output=resolve(process.argv[3]??resolve(here,'s5-witness-results.json'));
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
function scenario(revoke){
  const {fx,member,d,enroll,at}=prepare(),initial=snapshot(fx,member);
  if(initial.member.role!=='C2'||!initial.exportVerification.ok)throw new Error('invalid positive fixture');
  if(revoke)veto(fx,enroll,at);
  const before=snapshot(fx,member); veto(fx,d.id,at+1); const after=snapshot(fx,member);
  const expected=revoke?{status:'revoked',role:'C2',roleRows:before.roles.length}:{status:'active',role:'C1',roleRows:before.roles.length+1};
  const matched=after.member.status===expected.status&&after.member.role===expected.role&&after.roles.length===expected.roleRows;
  const events=fx.db.prepare("SELECT event FROM logs WHERE log='decision'").all().map(r=>JSON.parse(r.event)).filter(e=>e.kind==='reversal.effect');
  const out={initial,before,after,expected,matched,events};fx.db.close();return out;
}
const result={pin:'9b9f500bcfc3e5ef9499fc8d27190b025d2e672b',archiveRoot,unrevokedSibling:scenario(false),revokedWitness:scenario(true)};
result.pass=result.unrevokedSibling.matched&&result.revokedWitness.matched;
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:result.pass,unrevokedSibling:result.unrevokedSibling.matched,revokedWitness:result.revokedWitness.matched,before:result.revokedWitness.before.member,after:result.revokedWitness.after.member,roleRowsBefore:result.revokedWitness.before.roles.length,roleRowsAfter:result.revokedWitness.after.roles.length,exportVerification:result.revokedWitness.after.exportVerification,output}));
process.exitCode=result.pass?0:1;
