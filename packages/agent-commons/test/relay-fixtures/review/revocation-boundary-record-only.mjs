// Narrow S5 verifier-boundary regression. Fixture keys only; no source mutation.
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const root=resolve(process.argv[2]); const output=resolve(process.argv[3]);
const pkgRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const at=p=>pathToFileURL(resolve(pkgRoot,p)).href;
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
function flow(recordOnlyInviteVeto){
 const fx=F.setup({members:['A']}),member=F.promoteC1(fx,'A');F.eligibleForC2(fx,'A');roleD2(fx,member,'C2',T0+3*DAY);
 const e=fx.db.prepare("SELECT e.id,e.confirmed_by,i.decision_id FROM enrollments e JOIN invites i USING(invite_id) WHERE e.kind='enroll' AND e.member_id=?").get(member);
 if(!e.confirmed_by)throw new Error('fixture enrollment not completed');
 const enrollmentDecision=fx.db.prepare("SELECT id FROM decisions WHERE action='enroll.confirm' AND subject=?").get(member).id;
 const beforeInvite=snap(fx,member);
 let inviteVeto=null;if(recordOnlyInviteVeto)inviteVeto=veto(fx,e.decision_id,T0+4*DAY+1);
 const afterInvite=snap(fx,member);
 roleD2(fx,member,'C1',T0+4*DAY+2);
 const beforeRevocation=snap(fx,member);const revoker=veto(fx,enrollmentDecision,T0+5*DAY+3);const afterRevocation=snap(fx,member);
 const events=fx.db.prepare("SELECT seq,event FROM logs WHERE log='decision' ORDER BY seq").all().map(r=>({seq:r.seq,...JSON.parse(r.event)}));
 const expected={status:'revoked',role:'C1',roleRows:beforeRevocation.roles.length,validCleanExport:true};
 const pass=beforeInvite.verification.ok&&afterInvite.member.status==='active'&&afterInvite.verification.ok&&beforeRevocation.verification.ok&&afterRevocation.member.status===expected.status&&afterRevocation.member.role===expected.role&&afterRevocation.roles.length===expected.roleRows&&afterRevocation.verification.ok;
 const out={recordOnlyInviteVeto,inviteVeto:inviteVeto?.id??null,actualRevoker:revoker.id,beforeInvite,afterInvite,beforeRevocation,afterRevocation,expected,pass,events};fx.db.close();return out;
}
const out={archiveRoot:root,control:flow(false),recordOnlyInviteThenRealRevocation:flow(true)};out.pass=out.control.pass&&out.recordOnlyInviteThenRealRevocation.pass;writeFileSync(output,JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({pass:out.pass,controlPass:out.control.pass,recordOnlyPass:out.recordOnlyInviteThenRealRevocation.pass,before:out.recordOnlyInviteThenRealRevocation.beforeRevocation.member,after:out.recordOnlyInviteThenRealRevocation.afterRevocation.member,afterInvite:out.recordOnlyInviteThenRealRevocation.afterInvite.member,problems:out.recordOnlyInviteThenRealRevocation.afterRevocation.verification,output}));process.exitCode=out.pass?0:1;
