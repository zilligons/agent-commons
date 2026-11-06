import { createFixtureSpendingPolicy } from "./fixture-spending";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { L10AccountingService } from "./l10-accounting";
import { L10AccountingStore } from "./l10-accounting-store";
import { markAccountingDispatchStarted } from "./l10-admission";

function open(path: string) {
  const db = new DatabaseSync(path);
  const store = new L10AccountingStore(db as unknown as ConstructorParameters<typeof L10AccountingStore>[0]);
  return { db, store, service: new L10AccountingService(store, { spending: createFixtureSpendingPolicy() }) };
}

function reserve(service: L10AccountingService, runId: string, callId: string, slotId = "alpha") {
  return service.reserveCall({ runId, callId, slotId, runtimeModel: "test-model",
    promptTokensUpper: 50, completionLimit: 1800, totalTokensUpper: 1850 });
}

test("accounting store: run, charge, grant, and per-agent ladder survive database reopen", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "l10-accounting-store-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const path = join(scratch, "accounting.sqlite");
  const first = open(path);
  const run = first.service.createRun({ kind: "cohort", baseTurnLimit: 14, eligibleSlots: ["alpha", "beta"] });
  const admitted = reserve(first.service, run.id, "persisted");
  markAccountingDispatchStarted(admitted.permit);
  const metrics = { exitCode: 0, stdoutBytes: 9, stdoutSha256: "a".repeat(64), stderrBytes: 0, stderrSha256: "b".repeat(64) };
  first.service.settleCall(admitted.permit, { outcomeCode: "OK", actualModel: "test-model", metrics, usage: {
    promptTokens: 40, completionTokens: 1500, totalTokens: 1540,
    coversInternalCalls: true, source: "cli-envelope", fieldPath: "usage" } });
  const before = first.service.getRun(run.id);
  const receipt = first.store.getReceipt(admitted.reservation.id);
  first.db.close();
  const second = open(path);
  t.after(() => second.db.close());
  assert.deepEqual(second.service.getRun(run.id), before);
  assert.deepEqual(second.store.getReceipt(admitted.reservation.id), receipt);
  assert.deepEqual(JSON.parse(second.store.getReceipt(admitted.reservation.id)!.metricsJson!), metrics);
  assert.equal(second.service.completionLimit(run.id, "alpha"), 3000);
  assert.equal(second.service.completionLimit(run.id, "beta"), 1800);
});

test("accounting store: recovery conservatively charges every outstanding call and never replays", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "l10-accounting-recovery-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const path = join(scratch, "accounting.sqlite");
  const first = open(path);
  const run = first.service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["alpha", "beta", "gamma"] });
  const started = reserve(first.service, run.id, "started", "alpha");
  markAccountingDispatchStarted(started.permit);
  reserve(first.service, run.id, "unstarted", "beta");
  first.db.close();
  const second = open(path);
  t.after(() => second.db.close());
  second.service.recoverInterruptedRun(run.id);
  const recovered = second.service.getRun(run.id);
  assert.equal(recovered.chargedTokens, 3700);
  assert.equal(recovered.reservedTokens, 0);
  assert(recovered.excludedSlots.includes("alpha"));
  assert(recovered.excludedSlots.includes("beta"));
  assert.equal(second.service.nextEligibleAgent(run.id, "alpha"), "gamma");
  second.service.recoverInterruptedRun(run.id);
  assert.deepEqual(second.service.getRun(run.id), recovered);
  assert.throws(() => reserve(second.service, run.id, "started", "gamma"));
});

test("accounting store: two service instances see the same pending shared run budget", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "l10-accounting-shared-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const path = join(scratch, "accounting.sqlite");
  const first = open(path);
  const second = open(path);
  t.after(() => { second.db.close(); first.db.close(); });
  const run = first.service.createRun({ kind: "engine", baseTurnLimit: 7, eligibleSlots: ["alpha", "beta"] });
  first.service.reserveCall({ runId: run.id, callId: "large", slotId: "alpha", runtimeModel: "test-model",
    promptTokensUpper: 248199, completionLimit: 1800, totalTokensUpper: 249999 });
  assert.equal(second.service.getRun(run.id).reservedTokens, 249999);
  assert.throws(() => reserve(second.service, run.id, "must-not-overbook", "beta"),
    (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "BUDGET_EXHAUSTED");
});

test("accounting store: a failed transaction cannot leave a reservation or consume a turn", (t) => {
  const { db, store, service } = open(":memory:");
  t.after(() => db.close());
  const run = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["alpha"] });
  assert.throws(() => store.atomic(() => {
    reserve(service, run.id, "rolled-back");
    throw new Error("scratch transaction rollback");
  }), /scratch transaction rollback/);
  assert.equal(service.getRun(run.id).reservedTokens, 0);
  assert.equal(service.getRun(run.id).attemptedTurns, 0);
  assert.equal(store.reservationForCall("rolled-back"), null);
  const admitted = reserve(service, run.id, "rolled-back");
  assert.equal(service.getRun(run.id).reservedTokens, 1850);
  service.releaseUnstarted(admitted.permit, "TEST_RELEASE");
});

test("accounting store: call evidence and slot totals survive reopening the scratch database", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "l10-accounting-evidence-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const path = join(scratch, "accounting.sqlite");
  const first = open(path);
  const run = first.service.createRun({ kind: "engine", baseTurnLimit: 1, eligibleSlots: ["alpha"] });
  const admitted = first.service.reserveCall({ runId: run.id, callId: "persisted-evidence", slotId: "alpha", runtimeModel: "test-model",
    promptTokensUpper: 7, completionLimit: 16, totalTokensUpper: 23 });
  markAccountingDispatchStarted(admitted.permit);
  first.service.settleCall(admitted.permit, { outcomeCode: "OK", actualModel: "test-model", usage: {
    promptTokens: 7, completionTokens: 3, totalTokens: 10, coversInternalCalls: true, source: "cli-envelope", fieldPath: "usage" } });
  const evidence = first.store.callEvidence("persisted-evidence");
  const totals = first.store.slotTotals();
  assert.deepEqual(totals, { alpha: { calls: 1, started: 1, chargedTokens: 10 } });
  first.db.close();
  const second = open(path);
  t.after(() => second.db.close());
  assert.deepEqual(second.service.callEvidence("persisted-evidence"), evidence);
  assert.deepEqual(second.service.slotTotals(), totals);
  assert.equal(second.service.callEvidence("unknown"), null);
});
