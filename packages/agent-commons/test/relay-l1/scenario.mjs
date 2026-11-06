// L1 acceptance scenario (spec v3.4.5 13.2 "Pass, all of these", R6, B8, R9; L1 item 10: B8 wipe and
// restore, N40 re-bind recovery, and the completion target: two isolated clients enroll, exchange
// messages, recover after interruption, complete a claimed task and obtain a core-seven decision).
// Backend-neutral: `env` runs the relay, the fleet controller, agents A and B and the verification
// lane, either as loopback processes (non-counting development run) or in the R6 containers.
// Barrier files order every interruption; no wall-clock sleep decides an outcome. Each case records
// pass or fail with its evidence; exit 0 alone is not a pass.
//
// Per-case oracle (13.2 "After each case the harness checks relay.db (members, keys, enrollments,
// claims, decisions, approvals, roles) and each agent's store (handled-record ids and counts), and
// verifies every log offline"; verifier finding C-HARNESS-1): every case updates an explicit model of the expected
// state, and `step` marks a case ok only after the oracle passes:
//   - relay.db: members (status, role), keys per member (status, in order), enrollments (kind, member,
//     confirmer), claims (task, member, epoch, state), decisions (action, state), approvals per decision
//     (approver, verdict, seq), roles per member (in order), tasks (status) and submissions (state) all
//     equal the model exactly (task T's `accepted` included);
//   - each agent's store: every handled id handled exactly once in that store, every one of them a
//     record the relay delivered to that member, every record the member acknowledged since the store
//     began handled, and every record the model names handled;
//   - every log: the relay-signed export verified offline against the owner-signed roster and the
//     pinned relay key (all five logs, head, chains, signatures); and no earlier log history rewritten
//     since the previous case (each log's previous head is still at its sequence number).
// `afterCase` is a test-only hook (the failing-oracle controls); the runner never passes it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyExport } from "../../src/relay/signing.mjs";
import { RELAY_TEST_AUD } from "../../src/relay/auth.mjs";

export const T0 = 1_800_000_000_000;
const MIN = 60000, HOUR = 3600000;
const PATH = "docs/relay.md";
const diff = (line) => [{ path: PATH, diff: `--- a/${PATH}\n+++ b/${PATH}\n@@ -1 +1 @@\n-old\n+${line}\n` }];
export const PASSING_PATCH = diff("new relay text"), FAILING_PATCH = diff("FAIL relay text");
export const REQUIRED_CHECKS = Object.freeze(["sh check.sh"]);
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

export async function runAcceptance(env, { log = () => {}, afterCase = null } = {}) {
  const cases = [];
  let now = T0;
  const tick = async (ms) => { now += ms; await env.setClock(now); };
  const model = { members: {}, keys: {}, enrollments: {}, claims: {}, decisions: {}, approvals: {}, roles: {}, tasks: {}, submissions: {},
    handled: { A: new Set(), B: new Set() }, storeBase: { A: 0, B: 0 } };
  let roster = null, lastHeads = null;
  const step = async (id, name, fn) => {
    log(`case ${id}: ${name}`);
    try {
      const detail = await fn();
      if (afterCase) await afterCase(id, { model, member, env, A, B });
      const oracle = await oracleCheck(id);
      cases.push({ id, name, ok: true, detail: detail ?? null, oracle });
    } catch (error) { cases.push({ id, name, ok: false, error: String(error?.stack ?? error).slice(0, 1500) }); throw Object.assign(error, { cases }); }
  };
  const ok = (r, what) => { if (!r?.ok) throw new Error(`${what}: ${JSON.stringify(r).slice(0, 600)}`); return r.result; };
  const ctl = async (o) => ok(await env.controller.op(o), `controller ${o.op}`);
  const A = env.agent("A"), B = env.agent("B");
  const cli = async (agent, args, what = args[0]) => ok(await agent.run(args), `${agent.name} ${what}`);
  const member = {};
  /** The receipt of one record from a send/drain result, by record_id. */
  const receipt = (res, id) => { const r = res.sent.find(x => x.record_id === id); if (!r) throw new Error(`${id} not sent: ${JSON.stringify(res).slice(0, 400)}`); return r.receipt; };
  const refusal = (res, id) => res.refused.find(x => x.record_id === id) ?? null;
  /** Record a decision the controller made: its action, the state it must have, and its counted verdicts. */
  const decided = (id, action, approvers) => { model.decisions[id] = { action, state: "effective" }; model.approvals[id] = approvers.map(a => `${a}:approve:1`).sort(); };
  const claimed = (r, task, name, state = "live") => { model.claims[r.claim_id] = { task_id: task, member_id: member[name], epoch: r.epoch, state }; };
  const group = (rows, key, value) => { const o = {}; for (const r of rows) (o[r[key]] ??= []).push(value(r)); return o; };

  /** 13.2 per-case oracle (see the header). Throws on any difference; returns a short summary. */
  async function oracleCheck(caseId) {
    const at = (what) => `oracle after case ${caseId}: ${what}`;
    const f = await env.oracle();
    if (!f || !Array.isArray(f.members)) throw new Error(at(`relay.db unreadable: ${JSON.stringify(f).slice(0, 300)}`));
    assert.deepEqual(Object.fromEntries(f.members.map(m => [m.member_id, { status: m.status, role: m.role }])), model.members, at("members"));
    assert.deepEqual(group(f.keys, "principal_id", k => k.status), model.keys, at("keys"));
    assert.deepEqual(Object.fromEntries(f.enrollments.map(e => [e.id, { kind: e.kind, member_id: e.member_id, confirmed_by: e.confirmed_by }])), model.enrollments, at("enrollments"));
    for (const e of f.enrollments) if (e.confirmed_by !== null) assert.notEqual(e.confirmed_by, f.invites.find(i => i.invite_id === e.invite_id)?.created_by, at(`P1 ${e.id}`));
    assert.deepEqual(Object.fromEntries(f.claims.map(c => [c.claim_id, { task_id: c.task_id, member_id: c.member_id, epoch: c.epoch, state: c.state }])), model.claims, at("claims"));
    assert.deepEqual(Object.fromEntries(f.decisions.map(d => [d.id, { action: d.action, state: d.state }])), model.decisions, at("decisions"));
    const approvals = group(f.approvals, "decision_id", a => `${a.approver}:${a.verdict}:${a.seq}`);
    for (const k of Object.keys(approvals)) approvals[k].sort();
    assert.deepEqual(approvals, model.approvals, at("approvals"));
    assert.deepEqual(group(f.roles, "member_id", r => r.role), model.roles, at("roles"));
    assert.deepEqual(Object.fromEntries(f.tasks.map(t => [t.task_id, t.status])), model.tasks, at("tasks"));
    assert.deepEqual(Object.fromEntries(f.submissions.map(x => [x.submission_id, x.state])), model.submissions, at("submissions"));
    // Each agent's store: handled ids and counts.
    const stores = {};
    for (const [name, agent] of [["A", A], ["B", B]]) {
      if (!member[name]) continue;
      const h = await cli(agent, ["handled"]);
      const box = f.mailbox.filter(m => m.member_id === member[name]);
      for (const [rid, n] of Object.entries(h)) {
        assert.equal(n, 1, at(`${name} handled ${rid} ${n} times in one store`));
        assert.ok(box.some(m => m.record_id === rid), at(`${name} handled ${rid}, which the relay never delivered to it`));
      }
      for (const m of box) if (m.acked && m.seq > model.storeBase[name]) assert.equal(h[m.record_id], 1, at(`${name} acknowledged ${m.record_id} without handling it`));
      for (const rid of model.handled[name]) assert.equal(h[rid], 1, at(`${name} did not handle ${rid}`));
      stores[name] = Object.keys(h).length;
    }
    // Every log, offline, against the owner-signed roster and the pinned relay key; nothing earlier rewritten.
    const exp = await env.exportSigned();
    assert.deepEqual(verifyExport(exp, roster, { relayPublicKey: env.relayPublicKey, aud: RELAY_TEST_AUD }).problems, [], at("every log verifies offline against the relay-signed head"));
    const heads = exp.head.body.logs;
    if (lastHeads) for (const h of lastHeads) {
      const n = heads.find(x => x.log === h.log);
      assert.ok(n && n.count >= h.count, at(`${h.log} shrank`));
      if (h.count) assert.equal(exp.logs.find(r => r.log === h.log && r.seq === h.count)?.hash, h.head_hash, at(`${h.log} history before this case was rewritten`));
    }
    lastHeads = heads;
    return { logs: Object.fromEntries(heads.map(l => [l.log, l.count])), handled: stores, decisions: f.decisions.length, claims: f.claims.length };
  }

  await env.setClock(now);
  // --- setup: fleet keys and owner-signed files minted inside the harness side; relay started -----
  const fleet = await env.controller.init();
  await env.relay.start({ ownerPublicKey: fleet.owner_public_key });
  const base = await env.verify.base();
  roster = await ctl({ op: "roster" });

  await step("1", "A and B enroll by invite (enroll, agentnet); the lane owner made each invite; a different seat confirms after the owner line is confirmed; both C0", async () => {
    for (const [agent, name] of [[A, "A"], [B, "B"]]) {
      const minted = await cli(agent, ["mint"]);
      const { decision_id: inviteDecision, ...invite } = await ctl({ op: "invite", kind: "enroll", label: `req-${name}`, intended_display_name: `agent ${name}`, intended_platform: "reference-client" });
      decided(inviteDecision, "invite.create", ["seat-1"]);
      assert.deepEqual([invite.kind, invite.namespace, invite.relay.origin, invite.relay.public_key], ["enroll", "agentnet", RELAY_TEST_AUD, env.relayPublicKey]);
      await agent.putFile("invite.json", JSON.stringify(invite));
      const e = await cli(agent, ["enroll", "--invite-file", agent.path("invite.json"), "--display-name", `agent ${name}`, "--platform", "reference-client"]);
      assert.equal(e.agent, minted.agent);
      await agent.removeFile("invite.json");
      const c = await ctl({ op: "confirm-enrollment", enrollment_id: e.enrollment_id, by: "seat-2" });
      assert.equal(c.state, "effective");
      decided(c.decision, "enroll.confirm", ["seat-2"]);
      const st = await cli(agent, ["status"]);
      assert.deepEqual([st.status, st.role], ["active", "C0"]);
      member[name] = e.member_id;
      model.members[e.member_id] = { status: "active", role: "C0" };
      model.keys[e.member_id] = ["active"];
      model.enrollments[e.enrollment_id] = { kind: "enroll", member_id: e.member_id, confirmed_by: "seat-2" };
      model.roles[e.member_id] = ["C0"];
    }
    const f = await env.oracle();
    for (const name of ["A", "B"]) {
      const e = f.enrollments.find(x => x.member_id === member[name] && x.kind === "enroll");
      assert.equal(f.invites.find(i => i.invite_id === e.invite_id).created_by, "seat-1", "the lane owner made the invite");
      assert.equal(e.confirmed_by, "seat-2", "a different seat confirmed (P1)");
    }
    return { A: member.A, B: member.B };
  });

  let T, Tfail;
  await step("2", "path to C1: A heartbeats; the lane owner records role.c1 and opens task T with base_commit, a one-file paths[] allowlist and required_checks", async () => {
    await tick(MIN);
    const run = await cli(A, ["run-once"]);
    assert.equal(run.heartbeat.kind, "heartbeat");
    const c1 = await ctl({ op: "d0", action: "role.c1", subject: member.A });
    assert.equal(c1.state, "effective");
    decided(c1.id, "role.c1", ["seat-1"]);
    model.members[member.A].role = "C1";
    model.roles[member.A].push("C1");
    for (const id of ["T", "T-fail", "T2", "T3"]) {
      const d = await ctl({ op: "d0", action: "task.open", subject: id, args: { title: `task ${id}`, description: "Edit the relay doc.", kind: "work",
        paths: [PATH], base_commit: base, acceptance: { criteria: "check.sh passes", required_checks: [...REQUIRED_CHECKS] } } });
      assert.equal(d.state, "effective");
      decided(d.id, "task.open", ["seat-1"]);
      model.tasks[id] = "open";
    }
    T = "T"; Tfail = "T-fail";
    assert.equal((await cli(A, ["status"])).role, "C1");
    return { base_commit: base };
  });

  await step("3", "A and B exchange messages with the lane seats; B's message for A goes B -> seat -> A; each record handled exactly once", async () => {
    await tick(MIN);
    await cli(A, ["send", "--type", "message", "--record-id", "a-hello", "--body-json", JSON.stringify({ lane: "relay-core", text: "A: ready for work" })]);
    await cli(B, ["send", "--type", "message", "--record-id", "b-for-a", "--body-json", JSON.stringify({ lane: "relay-core", text: "for A: the base builds" })]);
    const feed = (await ctl({ op: "view", name: "queue" })).feed.find(l => l.lane === "relay-core").items;
    const fromB = feed.find(x => x.includes("for A: the base builds"));
    assert.ok(fromB && fromB.startsWith("EXTERNAL (untrusted)"), "the seat sees B's message rendered EXTERNAL");
    await ctl({ op: "message", member_id: member.A, text: "relayed from B: the base builds", record_id: "seat-relay-b" });
    await ctl({ op: "message", member_id: member.B, text: "seat: thanks", record_id: "seat-to-b" });
    await tick(MIN);
    await cli(A, ["run-once"]); await cli(B, ["run-once"]);
    await cli(A, ["run-once"]); await cli(B, ["run-once"]);   // a second read handles nothing again
    const hA = await cli(A, ["handled"]), hB = await cli(B, ["handled"]);
    assert.deepEqual([hA["seat-relay-b"], hB["seat-to-b"]], [1, 1]);
    assert.ok(Object.values(hA).every(n => n === 1) && Object.values(hB).every(n => n === 1), "every record handled exactly once");
    model.handled.A.add("seat-relay-b"); model.handled.B.add("seat-to-b");
    return { A: hA, B: hB };
  });

  let claim;
  await step("4", "A claims T and heartbeats; the claim is live", async () => {
    await tick(MIN);
    claim = receipt(await cli(A, ["send", "--type", "claim", "--record-id", "claim-T", "--body-json", JSON.stringify({ task_id: T, lease_ms: 2 * HOUR })]), "claim-T");
    claimed(claim, T, "A");
    model.tasks[T] = "claimed";
    await tick(MIN);
    const run = await cli(A, ["run-once"]);
    assert.deepEqual([run.heartbeat.claim_id, run.heartbeat.epoch], [claim.claim_id, claim.epoch]);
    assert.equal((await env.oracle()).claims.find(c => c.claim_id === claim.claim_id).state, "live");
    return { claim_id: claim.claim_id, epoch: claim.epoch };
  });

  await step("5", "outage with a live claim, storage kept: relay down with one unsent record; A killed after read and after handle; B sends via the seat while A is down; after restart each record once, the claim the same", async () => {
    await tick(MIN);
    await env.relay.stop();
    const down = await cli(A, ["send", "--type", "note", "--record-id", "unsent-1", "--body-json", JSON.stringify({ text: "written while the relay was down" })]);
    assert.deepEqual(down.deferred, ["unsent-1"]);
    await env.relay.start({ ownerPublicKey: fleet.owner_public_key });
    await ctl({ op: "message", member_id: member.A, text: "first", record_id: "m-1" });
    // Killed after reading and before handling.
    await A.hold("client-after-read");
    const r1 = await A.run(["run-once"], { background: true });
    await A.waitReached("client-after-read");
    await r1.kill();
    await A.release("client-after-read");
    assert.equal((await cli(A, ["handled"]))["m-1"], undefined, "not handled");
    // Killed after handling and before acknowledging.
    await A.hold("client-after-handle");
    const r2 = await A.run(["run-once"], { background: true });
    await A.waitReached("client-after-handle");
    await r2.kill();
    await A.release("client-after-handle");
    assert.equal((await cli(A, ["handled"]))["m-1"], 1, "handled once, not acked");
    // B sends via the seat while A is down.
    await cli(B, ["send", "--type", "message", "--record-id", "b-while-a-down", "--body-json", JSON.stringify({ lane: "relay-core", text: "for A: while you were down" })]);
    await ctl({ op: "message", member_id: member.A, text: "relayed from B: while you were down", record_id: "m-2" });
    await tick(MIN);
    const back = await cli(A, ["run-once"]);
    const h = await cli(A, ["handled"]);
    assert.deepEqual([h["m-1"], h["m-2"]], [1, 1], "the interrupted records each handled exactly once (the second through dedup)");
    const f = await env.oracle();
    assert.equal(f.member_records.filter(r => r.record_id === "unsent-1").length, 1, "the unsent record arrived once");
    const c = f.claims.find(x => x.claim_id === claim.claim_id);
    assert.deepEqual([c.state, c.epoch, back.heartbeat.claim_id], ["live", claim.epoch, claim.claim_id], "same claim_id and epoch, renewed by a heartbeat");
    model.handled.A.add("m-1"); model.handled.A.add("m-2");
    return { handled: h, lease_until: c.lease_until };
  });

  let submission;
  await step("6", "A submits a patch: claim submitted, T in-review, a heartbeat gets CLAIM_CLOSED; evidence; the verification container re-runs passing and failing patches; a D1 by the lane owner and another family is recorded, signed and mirrored", async () => {
    await tick(MIN);
    const res = await cli(A, ["send", "--type", "result", "--record-id", "result-T", "--body-json", JSON.stringify({ claim_id: claim.claim_id, epoch: claim.epoch, kind: "patch", body: PASSING_PATCH })]);
    submission = receipt(res, "result-T").submission_id;
    model.claims[claim.claim_id].state = "submitted";
    model.tasks[T] = "in-review";
    model.submissions[submission] = "in-review";
    await tick(MIN);
    const hb = await cli(A, ["send", "--type", "heartbeat", "--record-id", "hb-closed", "--body-json", JSON.stringify({ claim_id: claim.claim_id, epoch: claim.epoch })]);
    assert.deepEqual([refusal(hb, "hb-closed")?.error, refusal(hb, "hb-closed")?.status], ["CLAIM_CLOSED", 409]);
    await cli(A, ["send", "--type", "evidence", "--record-id", "ev-T", "--body-json", JSON.stringify({ submission_id: submission, kind: "test-log", text: "check.sh: ok (advisory only)" })]);
    // The failing control: a second claimed task, submitted and verified red.
    await tick(MIN);
    const c2 = receipt(await cli(A, ["send", "--type", "claim", "--record-id", "claim-Tf", "--body-json", JSON.stringify({ task_id: Tfail, lease_ms: HOUR })]), "claim-Tf");
    const failSub = receipt(await cli(A, ["send", "--type", "result", "--record-id", "result-Tf", "--body-json", JSON.stringify({ claim_id: c2.claim_id, epoch: c2.epoch, kind: "patch", body: FAILING_PATCH })]), "result-Tf").submission_id;
    claimed(c2, Tfail, "A", "submitted");
    model.tasks[Tfail] = "in-review";
    model.submissions[failSub] = "in-review";
    const q = (await ctl({ op: "view", name: "queue", by: "verifier" })).in_review;
    const verdicts = {};
    for (const sid of [submission, failSub]) {
      const item = q.find(x => x.submission_id === sid);
      assert.equal(item.base_commit, base);
      const v = await env.verify.check(item.patch, REQUIRED_CHECKS);
      const r = await ctl({ op: "verify-result", submission_id: sid, base_commit: base, patch_sha256: item.body_sha256, image_digest: v.image_digest,
        checks: [...REQUIRED_CHECKS], exit_codes: v.exit_codes, log_sha256: v.log_sha256 });
      verdicts[sid] = { exit_codes: v.exit_codes, passed: r.passed };
    }
    assert.deepEqual([verdicts[submission].passed, verdicts[failSub].passed], [true, false], "the passing and failing controls each produce the matching verify.result");
    const d1 = await ctl({ op: "accept", submission_id: submission });
    const f = await env.oracle();
    assert.equal(f.decisions.find(d => d.id === d1.decision).state, "effective", "core-seven D1 effective");
    assert.deepEqual(f.approvals.filter(a => a.decision_id === d1.decision && a.verdict === "approve").map(a => a.approver).sort(), ["seat-1", "seat-2"]);
    assert.equal(f.submissions.find(s => s.submission_id === submission).state, "accepted");
    decided(d1.decision, "accept", ["seat-1", "seat-2"]);
    model.submissions[submission] = "accepted";
    model.tasks[T] = "accepted";   // the completion target: task T accepted by a core-seven D1
    return { submission, failing: failSub, d1: d1.decision, verdicts };
  });

  await step("6b", "a separate run lets the lease expire first: the old claim's heartbeat is STALE_EPOCH", async () => {
    await tick(MIN);
    const c = receipt(await cli(A, ["send", "--type", "claim", "--record-id", "claim-T3", "--body-json", JSON.stringify({ task_id: "T3", lease_ms: MIN })]), "claim-T3");
    await tick(2 * MIN);   // the lease passes; the next request sweeps it
    const again = receipt(await cli(A, ["send", "--type", "claim", "--record-id", "claim-T3b", "--body-json", JSON.stringify({ task_id: "T3", lease_ms: HOUR })]), "claim-T3b");
    assert.equal(again.epoch, c.epoch + 1);
    await tick(MIN);
    const hb = await cli(A, ["send", "--type", "heartbeat", "--record-id", "hb-stale", "--body-json", JSON.stringify({ claim_id: c.claim_id, epoch: c.epoch })]);
    assert.equal(refusal(hb, "hb-stale")?.error, "STALE_EPOCH");
    await tick(MIN);
    await cli(A, ["send", "--type", "release", "--record-id", "rel-T3b", "--body-json", JSON.stringify({ claim_id: again.claim_id, epoch: again.epoch })]);
    claimed(c, "T3", "A", "expired");
    claimed(again, "T3", "A", "released");
    model.tasks.T3 = "open";
    return { expired: c.claim_id, reclaimed: again.claim_id };
  });

  await step("8", "VM reset (B8, R9) on its own claim on T2: only the key seed, agent, relay.origin and relay.public_key survive; same member and claim; every unacked record back, R-unacked handled twice in total, R-unsent lost", async () => {
    await tick(MIN);
    const c = receipt(await cli(A, ["send", "--type", "claim", "--record-id", "claim-T2", "--body-json", JSON.stringify({ task_id: "T2", lease_ms: 24 * HOUR })]), "claim-T2");
    claimed(c, "T2", "A");
    model.tasks.T2 = "claimed";
    await ctl({ op: "message", member_id: member.A, text: "acked", record_id: "R-acked" });
    await tick(MIN);
    await cli(A, ["run-once"]);
    await ctl({ op: "message", member_id: member.A, text: "unacked", record_id: "R-unacked" });
    await A.hold("client-after-handle");
    const r = await A.run(["run-once"], { background: true });
    await A.waitReached("client-after-handle");
    await r.kill();
    await A.release("client-after-handle");
    await env.relay.stop();
    assert.deepEqual((await cli(A, ["send", "--type", "note", "--record-id", "R-unsent", "--body-json", JSON.stringify({ text: "never sent" })])).deferred, ["R-unsent"]);
    await env.relay.start({ ownerPublicKey: fleet.owner_public_key });
    const before = await cli(A, ["handled"]);
    const pre = await env.oracle();
    assert.ok(pre.mailbox.filter(m => m.member_id === member.A && !m.acked).length <= 100, "every unacked record fits one page");
    assert.equal(pre.claims.find(x => x.claim_id === c.claim_id).state, "live");
    // Wipe: a fresh agent with exactly the four values. Its new store starts after everything A acknowledged so far.
    model.storeBase.A = Math.max(0, ...pre.mailbox.filter(m => m.member_id === member.A && m.acked).map(m => m.seq));
    model.handled.A = new Set(["R-unacked"]);
    const wiped = await A.wipe({ keepFour: true });
    assert.deepEqual(wiped.files, ["key.seed", "pins.json"], "no store, outbox, cursor, dedup set or seed bundle");
    await tick(MIN);
    const seed = await cli(A, ["seed"]);
    assert.equal(seed.member.member_id, member.A, "same member_id from a signed GET /v1/seed");
    const claims = (await cli(A, ["claims"])).claims;
    assert.deepEqual(claims.map(x => [x.claim_id, x.epoch]), [[c.claim_id, c.epoch]]);
    const run = await cli(A, ["run-once"]);
    assert.equal(run.heartbeat.claim_id, c.claim_id, "heartbeat inside the lease, same claim and epoch");
    assert.ok(run.inbox.read.includes("R-unacked") && !run.inbox.read.includes("R-acked"));
    const after = await cli(A, ["handled"]);
    assert.deepEqual([(before["R-unacked"] ?? 0) + (after["R-unacked"] ?? 0), (before["R-acked"] ?? 0) + (after["R-acked"] ?? 0)], [2, 1]);
    assert.equal((await env.oracle()).member_records.filter(m => m.record_id === "R-unsent").length, 0, "the relay has no R-unsent: the expected loss");
    return { before, after };
  });

  await step("N40", "re-bind recovery over the wire: B loses its key seed; five bad attempts void the first re-bind invite (invite-voided); a retry invite, a new key, a D1R by two families: B active on the new key, the old key refused", async () => {
    await tick(MIN);
    const boxB = (await env.oracle()).mailbox.filter(m => m.member_id === member.B && m.acked);
    model.storeBase.B = Math.max(0, ...boxB.map(m => m.seq));
    model.handled.B = new Set();
    await B.wipe({ keepFour: false });
    const { decision_id: d1i, ...i1 } = await ctl({ op: "invite", kind: "rebind", member_id: member.B, label: "req-rebind-1" });
    decided(d1i, "invite.create", ["seat-1"]);
    await B.putFile("invite.json", JSON.stringify({ ...i1, secret: "0".repeat(64) }));
    for (let k = 0; k < 5; k++) {
      const r = await B.run(["enroll", "--invite-file", B.path("invite.json")]);
      assert.equal(r.error, "enrollment-refused");
    }
    let f = await env.oracle();
    assert.equal(f.rebind_ends.find(e => e.invite_id === i1.invite_id)?.cause, "invite-voided");
    await tick(MIN);
    const { decision_id: d2i, ...i2 } = await ctl({ op: "invite", kind: "rebind", member_id: member.B, label: "req-rebind-2" });
    decided(d2i, "invite.create", ["seat-1"]);
    await B.putFile("invite.json", JSON.stringify(i2));
    const e = await cli(B, ["enroll", "--invite-file", B.path("invite.json")]);
    await B.removeFile("invite.json");
    const d = await ctl({ op: "confirm-enrollment", enrollment_id: e.enrollment_id });
    assert.equal((await env.oracle()).decisions.find(x => x.id === d.decision).state, "effective", "D1R rebind.confirm");
    decided(d.decision, "rebind.confirm", ["seat-2", "seat-4"]);
    model.enrollments[e.enrollment_id] = { kind: "rebind", member_id: member.B, confirmed_by: null };
    model.keys[member.B] = ["revoked", "active"];
    await cli(B, ["adopt-next-key"]);
    const st = await cli(B, ["status"]);
    assert.deepEqual([st.member_id, st.status], [member.B, "active"]);
    f = await env.oracle();
    assert.deepEqual(f.keys.filter(k => k.principal_id === member.B).map(k => k.status), ["revoked", "active"], "the lost key revoked; the voided attempt spent no key; the re-bound key active");
    return { voided: i1.invite_id, completed: e.enrollment_id };
  });

  await step("7", "every log verifies its chain and signatures offline against the owner-signed roster and the relay-signed head; the final-state oracle passes", async () => {
    const exp = await env.exportSigned();
    const roster = await ctl({ op: "roster" });
    const r = verifyExport(exp, roster, { relayPublicKey: env.relayPublicKey, aud: RELAY_TEST_AUD });
    assert.deepEqual(r.problems, []);
    const f = await env.oracle();
    assert.deepEqual(f.members.map(m => [m.member_id, m.status]).sort(), [[member.A, "active"], [member.B, "active"]].sort());
    assert.deepEqual(f.roles.filter(x => x.member_id === member.A).map(x => x.role), ["C0", "C1"]);
    assert.equal(f.decisions.filter(d => d.state === "effective").length > 0, true);
    return { heads: exp.head.body.logs, export_sha256: sha256(JSON.stringify(exp)) };
  });

  return { ok: cases.every(c => c.ok), cases };
}
