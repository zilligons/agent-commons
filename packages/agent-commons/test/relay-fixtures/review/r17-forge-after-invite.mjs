// Verifier probe r17: forged role rows after the ACTUAL revocation, in the completed-invite history and the original S5
// history, plus an active control. Fixture keys only; in-memory fixture DBs; product source imported read-only
// from argv[2]. Usage: node r17-forge-after-invite.mjs <archiveRoot> <out.json>
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const root = resolve(process.argv[2]), output = resolve(process.argv[3]);
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const at = p => pathToFileURL(resolve(pkgRoot, p)).href;
const F = await import(at('test/relay-fixtures.mjs'));
const G = await import(at('src/relay/governance.mjs'));
const S = await import(at('src/relay/signing.mjs'));
const { T0, DAY } = F;
function roleD2(fx, member, role, t) {
  const d = F.createDecision(fx.db, F.decision(fx, 'seat-1', { cls: 'D2', action: 'role.change', subject: member, sponsor: 'seat-1', args: { role }, at: t }), t);
  for (const seat of ['seat-2', 'seat-4', 'seat-5']) F.addVerdict(fx.db, F.approval(fx, seat, d.id, 'approve', t), t);
  F.confirmOwnerRecord(fx.db, F.ownerConfirm(fx, 'seat-6', F.outboxFor(fx.db, d.id), t), t); G.settleAll(fx.db, t + DAY); return d.id;
}
const veto = (fx, id, t) => F.createDecision(fx.db, F.decision(fx, 'owner', { cls: 'OWNER', action: 'veto', subject: id, at: t }), t);
const verify = (fx, x) => { const r = S.verifyExport(x, fx.files.roster.body.principals); return { ok: r.ok, problems: (r.problems ?? []).map(p => `${p.kind}/${p.id}/${p.reason}`) }; };
const state = (fx, m) => ({ ...fx.db.prepare('SELECT status,role FROM members WHERE member_id=?').get(m), rows: fx.db.prepare('SELECT role FROM roles WHERE member_id=? ORDER BY seq').all(m).map(r => r.role).join(',') });
const idOf = (fx, action, m) => fx.db.prepare('SELECT id FROM decisions WHERE action=? AND subject=? ORDER BY created_at,id').get(action, m).id;
function forge(fx, exp, member, { role, decision_id, memberRole }) {
  const x = structuredClone(exp); const last = x.roles.filter(r => r.member_id === member).at(-1);
  x.roles.push({ ...last, seq: last.seq + 1, role, decision_id, at: last.at + DAY });
  if (memberRole) x.members.find(m => m.member_id === member).role = memberRole;
  const v = verify(fx, x); return { forgedRow: `${member}/${last.seq + 1}`, role, cites: decision_id, memberRole: memberRole ?? null, ...v };
}
const out = { archiveRoot: root, histories: {} };
// H1: completed-invite veto (record-only) -> legitimate C1 demotion -> enrollment reversal (actual revocation).
{
  const fx = F.setup({ members: ['A'] }), m = F.promoteC1(fx, 'A'); F.eligibleForC2(fx, 'A');
  const dC2 = roleD2(fx, m, 'C2', T0 + 3 * DAY);
  const inv = fx.db.prepare("SELECT e.confirmed_by,i.decision_id FROM enrollments e JOIN invites i USING(invite_id) WHERE e.kind='enroll' AND e.member_id=?").get(m);
  const enroll = idOf(fx, 'enroll.confirm', m);
  veto(fx, inv.decision_id, T0 + 4 * DAY + 1);
  const dC1 = roleD2(fx, m, 'C1', T0 + 4 * DAY + 2);
  const revoker = veto(fx, enroll, T0 + 5 * DAY + 3);
  const afterRevocation = { ...state(fx, m), export: verify(fx, S.exportRelay(fx.db)) };
  let postVeto = null, postVetoError = null;
  try { postVeto = veto(fx, dC1, T0 + 5 * DAY + 4); } catch (e) { postVetoError = String(e?.message ?? e); }
  const afterPostVeto = { ...state(fx, m), export: verify(fx, S.exportRelay(fx.db)) };
  const exp = S.exportRelay(fx.db);
  const f = {};
  if (postVeto) {
    f.zzShapeRowOnly = forge(fx, exp, m, { role: 'C2', decision_id: postVeto.id });
    f.zzShapeRowAndMember = forge(fx, exp, m, { role: 'C2', decision_id: postVeto.id, memberRole: 'C2' });
  }
  f.citesRevokingVeto = forge(fx, exp, m, { role: 'C2', decision_id: revoker.id, memberRole: 'C2' });
  f.reciteEarlierGrantRowOnly = forge(fx, exp, m, { role: 'C2', decision_id: dC2 });
  f.reciteEarlierGrantRowAndMember = forge(fx, exp, m, { role: 'C2', decision_id: dC2, memberRole: 'C2' });
  out.histories.completedInvite = { inviteConfirmedBy: inv.confirmed_by !== null, afterRevocation, postVetoError, afterPostVeto, forgeries: f };
  fx.db.close();
}
// H2: original S5 (enrollment reversed while C2, then the C2 grant reversed).
{
  const fx = F.setup({ members: ['A'] }), m = F.promoteC1(fx, 'A'); F.eligibleForC2(fx, 'A');
  const dC2 = roleD2(fx, m, 'C2', T0 + 3 * DAY), c1 = idOf(fx, 'role.c1', m), enroll = idOf(fx, 'enroll.confirm', m);
  veto(fx, enroll, T0 + 4 * DAY + 1); veto(fx, dC2, T0 + 4 * DAY + 2);
  const exp = S.exportRelay(fx.db);
  out.histories.originalS5 = { after: { ...state(fx, m), export: verify(fx, exp) }, forgeries: {
    reciteEarlierGrantRowAndMember: forge(fx, exp, m, { role: 'C1', decision_id: c1, memberRole: 'C1' }) } };
  fx.db.close();
}
// H3: active control (no revocation): C0, C1, C2.
{
  const fx = F.setup({ members: ['A'] }), m = F.promoteC1(fx, 'A'); F.eligibleForC2(fx, 'A');
  roleD2(fx, m, 'C2', T0 + 3 * DAY); const c1 = idOf(fx, 'role.c1', m);
  const exp = S.exportRelay(fx.db);
  out.histories.activeControl = { after: { ...state(fx, m), export: verify(fx, exp) }, forgeries: {
    reciteEarlierGrantRowAndMember: forge(fx, exp, m, { role: 'C1', decision_id: c1, memberRole: 'C1' }) } };
  fx.db.close();
}
// H4: active member legitimately demoted C2 -> C1 by a later D2; forged row re-cites the old C2 grant (elevation).
{
  const fx = F.setup({ members: ['A'] }), m = F.promoteC1(fx, 'A'); F.eligibleForC2(fx, 'A');
  const dC2 = roleD2(fx, m, 'C2', T0 + 3 * DAY); roleD2(fx, m, 'C1', T0 + 4 * DAY + 2);
  const exp = S.exportRelay(fx.db);
  out.histories.activeDemoted = { after: { ...state(fx, m), export: verify(fx, exp) }, forgeries: {
    reciteEarlierGrantRowAndMember: forge(fx, exp, m, { role: 'C2', decision_id: dC2, memberRole: 'C2' }) } };
  fx.db.close();
}
const h1 = out.histories.completedInvite, f1 = h1.forgeries;
const refusedFor = (r, reason) => r && r.ok === false && r.problems.some(p => p.startsWith(`role/${r.forgedRow}/${reason}`));
out.required = {
  h1CleanRevokedC1: h1.afterRevocation.status === 'revoked' && h1.afterRevocation.role === 'C1' && h1.afterRevocation.rows === 'C0,C1,C2,C1' && h1.afterRevocation.export.ok,
  h1PostRevocationVetoWritesNoRow: h1.postVetoError === null && h1.afterPostVeto.rows === h1.afterRevocation.rows && h1.afterPostVeto.role === 'C1' && h1.afterPostVeto.export.ok,
  h1ZzShapeRefusedAtBoundary: refusedFor(f1.zzShapeRowOnly, 'role-after-revocation') && refusedFor(f1.zzShapeRowAndMember, 'role-after-revocation'),
  h1CitesRevokingVetoRefused: f1.citesRevokingVeto.ok === false,
};
out.observed = {
  h1ReciteEarlierGrantRowOnlyRefused: f1.reciteEarlierGrantRowOnly.ok === false,
  h1ReciteEarlierGrantRowAndMemberRefused: f1.reciteEarlierGrantRowAndMember.ok === false,
  s5ReciteEarlierGrantRowAndMemberRefused: out.histories.originalS5.forgeries.reciteEarlierGrantRowAndMember.ok === false,
  activeReciteEarlierGrantRowAndMemberRefused: out.histories.activeControl.forgeries.reciteEarlierGrantRowAndMember.ok === false,
  activeDemotedReciteC2GrantRefused: out.histories.activeDemoted.forgeries.reciteEarlierGrantRowAndMember.ok === false,
};
out.pass = Object.values(out.required).every(Boolean);
writeFileSync(output, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ pass: out.pass, required: out.required, observed: out.observed }));
process.exitCode = out.pass ? 0 : 1;
