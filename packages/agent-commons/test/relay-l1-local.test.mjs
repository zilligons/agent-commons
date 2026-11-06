// L1 acceptance scenario on the LOCAL backend (NON-COUNTING; spec v3.4.5 13.2): the relay with the
// egress sensor, the fleet controller, agents A and B and the verification lane as separate processes
// on 127.0.0.1. The same scenario runs in the R6 containers (test/relay-l1/run.mjs --backend docker);
// only that run, at candidate C after the security review and the verifier pass, counts.

import test from "node:test";
import assert from "node:assert/strict";
import { localEnv } from "./relay-l1/env-local.mjs";
import { runAcceptance } from "./relay-l1/scenario.mjs";
import { NOT_EGRESS } from "./relay-l1/egress-sensor-kinds.mjs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

test("13.2 acceptance scenario on loopback (non-counting): cases 1-8, the lease-expiry run, N40 re-bind recovery; the relay makes no outbound attempt", { timeout: 240000 }, async () => {
  const env = await localEnv();
  try {
    const r = await runAcceptance(env).catch((e) => ({ ok: false, cases: e.cases ?? [], error: String(e?.stack ?? e) }));
    assert.equal(r.ok, true, JSON.stringify(r.cases?.filter(c => !c.ok) ?? r.error));
    assert.deepEqual(r.cases.map(c => c.id), ["1", "2", "3", "4", "5", "6", "6b", "8", "N40", "7"]);
    const egress = (await env.egress()).filter(e => !NOT_EGRESS.includes(e.kind));
    assert.deepEqual(egress, [], "N25: the relay process attempted no outbound connection, lookup or child process");
    assert.ok((await env.egress()).some(e => e.kind === "sensor.armed"), "the sensor was armed in every relay start");
  } finally {
    await env.close();
  }
});

/**
 * C-HARNESS-1 failing-oracle controls (bounded: each run stops at the tampered case). A tamper
 * made inside the step, after the case's own actions and before the oracle, must turn that step red,
 * fail the run, and stop every later case: one control per oracle area.
 */
async function tamperedRun(caseId, tamper) {
  const env = await localEnv();
  try {
    let error = null;
    await runAcceptance(env, { afterCase: async (id, ctx) => { if (id === caseId) await tamper(ctx, env); } }).catch((e) => { error = e; });
    return { error, cases: error?.cases ?? [] };
  } finally {
    await env.close();
  }
}
const lastFailed = (r, id, pattern) => {
  assert.ok(r.error, "the run failed");
  const last = r.cases.at(-1);
  assert.deepEqual([last.id, last.ok], [id, false], "the tampered case is the last one recorded, and it failed");
  assert.ok(r.cases.slice(0, -1).every(c => c.ok), "every earlier case passed its oracle");
  assert.match(last.error, pattern);
};

test("C-HARNESS-1 control: a relay.db fact that differs from the model fails the case (members)", { timeout: 120000 }, async () => {
  const r = await tamperedRun("1", ({ model, member }) => { model.members[member.A].role = "C1"; });
  lastFailed(r, "1", /oracle after case 1: members/);
});

test("C-HARNESS-1 control: an agent store that handled a record twice fails the case (handled ids and counts)", { timeout: 120000 }, async () => {
  const r = await tamperedRun("3", (ctx, env) => {
    const db = new DatabaseSync(join(env.root, "A", "state", "store.db"));
    try { db.prepare("INSERT INTO handled(record_id, seq, type, at) SELECT record_id, seq, type, at FROM handled WHERE record_id = 'seat-relay-b'").run(); }
    finally { db.close(); }
  });
  lastFailed(r, "3", /oracle after case 3: A handled seat-relay-b 2 times in one store/);
});

test("C-HARNESS-1 control: an export whose security log lost its tail fails the case (every log offline against the head)", { timeout: 120000 }, async () => {
  const r = await tamperedRun("2", (ctx, env) => {
    const real = env.exportSigned;
    env.exportSigned = async () => {
      const exp = await real();
      const last = Math.max(...exp.logs.filter(l => l.log === "security").map(l => l.seq));
      return { ...exp, logs: exp.logs.filter(l => !(l.log === "security" && l.seq === last)) };
    };
  });
  lastFailed(r, "2", /oracle after case 2: every log verifies offline against the relay-signed head/);
});
