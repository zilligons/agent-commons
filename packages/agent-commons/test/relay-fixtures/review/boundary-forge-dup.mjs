// Narrow S5 verifier-boundary regression. Fixture keys only; no source mutation.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const root=resolve(process.argv[2]); 
const at=p=>pathToFileURL(resolve(root,'packages/agent-commons',p)).href;
const F=await import(at('test/relay-fixtures.mjs'));
const G=await import(at('src/relay/governance.mjs'));
const S=await import(at('src/relay/signing.mjs'));
const {T0,DAY}=F;
function roleD2(fx,member,role,t){
 const d=F.createDecision(fx.db,F.decision(fx,'seat-1',{cls:'D2',action:'role.change',subject:member,sponsor:'seat-1',args:{role},at:t}),t);
 for(const seat of ['seat-2','seat-4','seat-5'])F.addVerdict(fx.db,F.approval(fx,seat,d.id,'approve',t),t);
 F.confirmOwnerRecord(fx.db,F.ownerConfirm(fx,'seat-6',F.outboxFor(fx.db,d.id),t),t);G.settleAll(fx.db,t+DAY);return d.id;
}
const veto=(fx,id,t)=>F.createDecision(fx.db,F.decision(fx,'owner',{cls:'OWNER',action:'veto',subject:id,at:t}),t);
function snap(fx,member){return {member:{...fx.db.prepare('SELECT status,role FROM members WHERE member_id=?').get(member)},roles:fx.db.prepare('SELECT seq,role,decision_id,at FROM roles WHERE member_id=? ORDER BY seq').all(member).map(r=>({...r})),verification:S.verifyExport(S.exportRelay(fx.db),fx.files.roster.body.principals)};}

// Scope-seat probe: the verifier's record-only flow, then forge the REAL export with a role row placed AFTER the real revocation.
// The boundary must be the E veto (not the record-only invite veto): the honest export passes, the forgery is refused.
const fx=F.setup({members:['A']}),member=F.promoteC1(fx,'A');F.eligibleForC2(fx,'A');roleD2(fx,member,'C2',T0+3*DAY);
const e=fx.db.prepare("SELECT e.id,e.confirmed_by,i.decision_id FROM enrollments e JOIN invites i USING(invite_id) WHERE e.kind='enroll' AND e.member_id=?").get(member);
const enrollmentDecision=fx.db.prepare("SELECT id FROM decisions WHERE action='enroll.confirm' AND subject=?").get(member).id;
veto(fx,e.decision_id,T0+4*DAY+1);
const demote=roleD2(fx,member,'C1',T0+4*DAY+2);
const revoker=veto(fx,enrollmentDecision,T0+5*DAY+3);
const roster=fx.files.roster.body.principals;
const reasons=x=>{const r=S.verifyExport(x,roster);return {ok:r.ok,problems:(r.problems??[]).map(p=>[p.kind,p.reason].join('/'))};};
const exp=S.exportRelay(fx.db);
const honest=reasons(exp);
const forged=structuredClone(exp); const rr=forged.roles.filter(r=>r.member_id===member); const last=rr[rr.length-1];
// The reducer refuses a new role decision about a revoked member (D2-1 b), so forge only the EXPORT:
// the forged row cites the honest demotion decision but sits after the E veto in the ledger.
// Duplicate-decision forgery: a NEW ledger row (seq 5, after the revocation) that re-cites the EARLIER C2 promotion,
// which the schema forbids (roles.decision_id UNIQUE). If the verifier places rows by the cited decision and takes
// the frozen role by ledger order, the forged C2 becomes the frozen role.
const promo=exp.roles.filter(r=>r.member_id===member&&r.role==='C2')[0].decision_id;
forged.roles.push({...last,seq:last.seq+1,role:'C2',decision_id:promo,at:T0+6*DAY});
const forgedRow=reasons(forged);
const both=structuredClone(forged); both.members.find(m=>m.member_id===member).role='C2';
const forgedRowAndMember=reasons(both);
const out={member:{...fx.db.prepare('SELECT status,role FROM members WHERE member_id=?').get(member)},honest,forgedRow,forgedRowAndMember,
  pass: honest.ok===true && forgedRow.ok===false && forgedRowAndMember.ok===false};
console.log(JSON.stringify(out)); fx.db.close(); process.exitCode=out.pass?0:1;
