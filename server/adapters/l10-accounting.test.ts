import { createFixtureSpendingPolicy } from "./fixture-spending";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { L10AccountingService } from "./l10-accounting";
import { L10AccountingStore } from "./l10-accounting-store";
import { assertAccountingPermit, markAccountingDispatchStarted } from "./l10-admission";
import type { AdapterUsage } from "./types";

function fixture(t: TestContext, baseTurnLimit = 7, eligibleSlots = ["alpha", "beta", "gamma"]) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new L10AccountingStore(db as unknown as ConstructorParameters<typeof L10AccountingStore>[0]);
  const service = new L10AccountingService(store, { spending: createFixtureSpendingPolicy() });
  const run = service.createRun({ kind: "cohort", baseTurnLimit, eligibleSlots });
  return { db, store, service, run };
}

function usage(promptTokens = 40, completionTokens = 100): AdapterUsage {
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
    coversInternalCalls: true, source: "cli-envelope", fieldPath: "usage" };
}

function reserve(service: L10AccountingService, runId: string, callId: string, slotId = "alpha", promptTokensUpper = 50) {
  const completionLimit = service.completionLimit(runId, slotId);
  return service.reserveCall({ runId, callId, slotId, runtimeModel: "test-model", promptTokensUpper,
    completionLimit, totalTokensUpper: promptTokensUpper + completionLimit });
}

function complete(service: L10AccountingService, runId: string, callId: string, slotId = "alpha", observed = usage(), promptTokensUpper = 50) {
  const admitted = reserve(service, runId, callId, slotId, promptTokensUpper);
  markAccountingDispatchStarted(admitted.permit);
  const result = service.settleCall(admitted.permit, { usage: observed, outcomeCode: "OK", actualModel: "test-model" });
  return { admitted, result };
}

function code(expected: string) {
  return (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;
}

test("accounting: automatic initial turn grants and the 84-turn ceiling", (t) => {
  const { service } = fixture(t);
  for (const [baseTurnLimit, multiplier, grantedTurnLimit] of [[7, 1, 7], [13, 1, 13], [14, 2, 28], [20, 2, 40], [21, 3, 63], [28, 3, 84]]) {
    const run = service.createRun({ kind: "probe", baseTurnLimit, eligibleSlots: ["alpha"] });
    assert.equal(run.multiplier, multiplier);
    assert.equal(run.grantedTurnLimit, grantedTurnLimit);
  }
  for (const baseTurnLimit of [0, -1, 29, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => service.createRun({ kind: "engine", baseTurnLimit, eligibleSlots: ["alpha"] }));
  }
});

test("accounting: reservations cover prompt plus completion and settle only measured usage", (t) => {
  const { service, run } = fixture(t);
  const { admitted, result } = complete(service, run.id, "call-1");
  assert.equal(admitted.reservation.promptTokensUpper, 50);
  assert.equal(admitted.reservation.totalTokens, 1850);
  assert.equal(admitted.limits.maxCompletionTokens, 1800);
  assert.equal(admitted.limits.maxTotalTokens, 1850);
  assert.equal(result.state, "settled");
  assert.equal(result.chargedTokens, 140);
  assert.equal(result.releasedTokens, 1710);
  assert.equal(result.duplicate, false);
  assert.equal(service.getRun(run.id).chargedTokens, 140);
  assert.equal(service.getRun(run.id).reservedTokens, 0);
});

test("accounting: strict shared cap admits 249999 and refuses exactly 250000", (t) => {
  const { service, run } = fixture(t);
  assert.throws(() => reserve(service, run.id, "at-cap", "alpha", 248200), code("BUDGET_EXHAUSTED"));
  const admitted = reserve(service, run.id, "below-cap", "alpha", 248199);
  assert.equal(service.getRun(run.id).reservedTokens, 249999);
  assert.throws(() => reserve(service, run.id, "shared-cap", "beta"), code("BUDGET_EXHAUSTED"));
  service.releaseUnstarted(admitted.permit, "TEST_RELEASE");
  assert.equal(service.getRun(run.id).reservedTokens, 0);
});

test("accounting: charged usage participates in the same cap as pending reservations", (t) => {
  const { service, run } = fixture(t);
  complete(service, run.id, "charge", "alpha", usage(1000, 0), 1000);
  assert.throws(() => reserve(service, run.id, "at-cap", "beta", 247200), code("BUDGET_EXHAUSTED"));
  const admitted = reserve(service, run.id, "one-below", "beta", 247199);
  assert.equal(service.getRun(run.id).chargedTokens + service.getRun(run.id).reservedTokens, 249999);
  service.releaseUnstarted(admitted.permit, "TEST_RELEASE");
});

test("accounting: completion ladders and hold clearing are independent for each agent", (t) => {
  const { service, run } = fixture(t);
  complete(service, run.id, "boost-1", "alpha", usage(40, 1500));
  assert.equal(service.completionLimit(run.id, "alpha"), 3000);
  assert.equal(service.completionLimit(run.id, "beta"), 1800);
  complete(service, run.id, "boost-2", "alpha", usage(40, 2500));
  assert.equal(service.completionLimit(run.id, "alpha"), 6000);
  assert.equal(service.getRun(run.id).ladder.alpha.hold, true);
  assert.equal(service.getRun(run.id).grantedTurnLimit, 14);
  complete(service, run.id, "held-boost", "alpha", usage(40, 5000));
  assert.equal(service.completionLimit(run.id, "alpha"), 6000);
  complete(service, run.id, "clear-1", "alpha");
  assert.equal(service.getRun(run.id).ladder.alpha.hold, true);
  complete(service, run.id, "clear-2", "alpha");
  assert.equal(service.getRun(run.id).ladder.alpha.hold, false);
  complete(service, run.id, "boost-3", "alpha", usage(40, 5000));
  assert.equal(service.completionLimit(run.id, "alpha"), 12000);
  assert.equal(service.completionLimit(run.id, "beta"), 1800);
  assert.equal(service.getRun(run.id).multiplier, 3);
});

test("accounting: prompt complexity promotes monotonically and no separate trial cap stops valid calls", (t) => {
  const { service, run } = fixture(t);
  complete(service, run.id, "medium-prompt", "alpha", usage(40, 100), 6000);
  assert.equal(service.getRun(run.id).grantedTurnLimit, 14);
  complete(service, run.id, "large-prompt", "alpha", usage(40, 100), 12000);
  assert.equal(service.getRun(run.id).grantedTurnLimit, 21);
  for (let i = 0; i < 8; i++) complete(service, run.id, `small-${i}`);
  assert.equal(service.getRun(run.id).attemptedTurns, 10);
  assert.equal(service.getRun(run.id).grantedTurnLimit, 21);
  assert.equal(service.getRun(run.id).state, "active");
});

test("accounting: cumulative measured charge promotes at 25000 and 75000 tokens", (t) => {
  const { service, run } = fixture(t);
  for (let i = 0; i < 5; i++) complete(service, run.id, `charge-${i}`, "alpha", usage(5000, 0), 5000);
  assert.equal(service.getRun(run.id).chargedTokens, 25000);
  assert.equal(service.getRun(run.id).multiplier, 2);
  const second = service.createRun({ kind: "engine", baseTurnLimit: 14, eligibleSlots: ["alpha"] });
  for (let i = 0; i < 15; i++) complete(service, second.id, `second-charge-${i}`, "alpha", usage(5000, 0), 5000);
  assert.equal(service.getRun(second.id).chargedTokens, 75000);
  assert.equal(service.getRun(second.id).multiplier, 3);
  assert.equal(service.getRun(second.id).grantedTurnLimit, 42);
});

test("accounting: turn exhaustion refuses the next call without dispatch", (t) => {
  const { service, run } = fixture(t, 1);
  complete(service, run.id, "only-call");
  assert.throws(() => reserve(service, run.id, "too-many", "beta"), code("BUDGET_EXHAUSTED"));
  assert.equal(service.getRun(run.id).reservedTokens, 0);
});

test("accounting: invalid reservation numbers never create charged or reserved usage", (t) => {
  const { service, run } = fixture(t);
  const valid = { runId: run.id, callId: "invalid", slotId: "alpha", runtimeModel: "test-model", promptTokensUpper: 50, completionLimit: 1800, totalTokensUpper: 1850 };
  for (const key of ["promptTokensUpper", "completionLimit", "totalTokensUpper"] as const) {
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => service.reserveCall({ ...valid, [key]: value }));
    }
  }
  assert.throws(() => service.reserveCall({ ...valid, totalTokensUpper: 1849 }));
  assert.throws(() => service.reserveCall({ ...valid, completionLimit: 3000, totalTokensUpper: 3050 }));
  assert.equal(service.getRun(run.id).chargedTokens, 0);
  assert.equal(service.getRun(run.id).reservedTokens, 0);
  assert.equal(service.getRun(run.id).attemptedTurns, 0);
});

test("accounting: an unstarted cancellation releases the complete reservation", (t) => {
  const { service, run } = fixture(t);
  const admitted = reserve(service, run.id, "cancel-before-start");
  const result = service.releaseUnstarted(admitted.permit, "CANCELLED");
  assert.equal(result.state, "released");
  assert.equal(result.chargedTokens, 0);
  assert.equal(result.releasedTokens, 1850);
  assert.equal(service.getRun(run.id).chargedTokens, 0);
  assert.equal(service.getRun(run.id).reservedTokens, 0);
});

test("accounting: cancellation after dispatch retains measured charge", (t) => {
  const { service, run } = fixture(t);
  const admitted = reserve(service, run.id, "cancel-after-start");
  markAccountingDispatchStarted(admitted.permit);
  const result = service.settleCall(admitted.permit, { usage: usage(), outcomeCode: "CANCELLED", actualModel: "test-model" });
  assert.equal(result.state, "settled");
  assert.equal(result.chargedTokens, 140);
  assert.equal(service.getRun(run.id).chargedTokens, 140);
});

test("accounting: release after dispatch cannot refund an unknown cancellation", (t) => {
  const { service, run } = fixture(t);
  const admitted = reserve(service, run.id, "late-release");
  markAccountingDispatchStarted(admitted.permit);
  assert.throws(() => service.releaseUnstarted(admitted.permit, "CANCELLED"), code("ACCOUNTING_CONFLICT"));
  assert.equal(service.getRun(run.id).reservedTokens, 1850);
  const result = service.settleCall(admitted.permit, { usage: null, outcomeCode: "CANCELLED" });
  assert.equal(result.state, "uncertain");
  assert.equal(result.chargedTokens, 1850);
  assert.equal(service.getRun(run.id).reservedTokens, 0);
});

test("accounting: an unknown started outcome charges full reservation and escalates without ending run", (t) => {
  const { service, run } = fixture(t);
  const admitted = reserve(service, run.id, "unknown");
  markAccountingDispatchStarted(admitted.permit);
  const result = service.settleCall(admitted.permit, { usage: null, outcomeCode: "TIMEOUT" });
  assert.equal(result.state, "uncertain");
  assert.equal(result.chargedTokens, 1850);
  assert.equal(result.releasedTokens, 0);
  assert.equal(service.getRun(run.id).state, "active");
  assert(service.getRun(run.id).excludedSlots.includes("alpha"));
  assert.equal(service.nextEligibleAgent(run.id, "alpha"), "beta");
  assert.throws(() => reserve(service, run.id, "quarantined", "alpha"));
  complete(service, run.id, "next-agent", "beta");
  assert.equal(service.getRun(run.id).chargedTokens, 1990);
});

test("accounting: no eligible next agent exhausts cleanly", (t) => {
  const { service, run } = fixture(t, 7, ["alpha"]);
  const admitted = reserve(service, run.id, "last-agent");
  markAccountingDispatchStarted(admitted.permit);
  service.settleCall(admitted.permit, { usage: null, outcomeCode: "TIMEOUT" });
  assert.equal(service.nextEligibleAgent(run.id, "alpha"), null);
  assert.equal(service.getRun(run.id).state, "exhausted");
  assert.equal(service.getRun(run.id).reservedTokens, 0);
  assert.throws(() => reserve(service, run.id, "no-replay"));
});

test("accounting: identical duplicate settlement is idempotent and conflicting receipt is rejected", (t) => {
  const { service, run } = fixture(t);
  const { admitted } = complete(service, run.id, "duplicate");
  const duplicate = service.settleCall(admitted.permit, { usage: usage(), outcomeCode: "OK", actualModel: "test-model" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.chargedTokens, 140);
  assert.equal(service.getRun(run.id).chargedTokens, 140);
  assert.equal(service.getRun(run.id).attemptedTurns, 1);
  assert.throws(() => service.settleCall(admitted.permit, { usage: usage(40, 101), outcomeCode: "OK", actualModel: "test-model" }), code("ACCOUNTING_CONFLICT"));
  assert.equal(service.getRun(run.id).chargedTokens, 140);
});

test("accounting: receipt stores safe metrics and detects model or metric conflicts", (t) => {
  const { store, service, run } = fixture(t);
  const admitted = reserve(service, run.id, "receipt-evidence");
  markAccountingDispatchStarted(admitted.permit);
  const safeMetrics = { exitCode: 0, stdoutBytes: 17, stdoutSha256: "a".repeat(64),
    stderrBytes: 0, stderrSha256: "b".repeat(64) };
  const metrics = { ...safeMetrics, stdout: "untrusted output body", stderr: "untrusted error body" };
  service.settleCall(admitted.permit, { usage: usage(), outcomeCode: "OK", actualModel: "test-model", metrics });
  const receipt = store.getReceipt(admitted.reservation.id);
  assert(receipt?.metricsJson);
  assert.deepEqual(JSON.parse(receipt.metricsJson), safeMetrics);
  const duplicate = service.settleCall(admitted.permit, { usage: usage(), outcomeCode: "OK", actualModel: "test-model",
    metrics: { ...safeMetrics } });
  assert.equal(duplicate.duplicate, true);
  assert.throws(() => service.settleCall(admitted.permit, { usage: usage(), outcomeCode: "OK", actualModel: "other-model",
    metrics: safeMetrics }), code("ACCOUNTING_CONFLICT"));
  assert.throws(() => service.settleCall(admitted.permit, { usage: usage(), outcomeCode: "OK", actualModel: "test-model",
    metrics: { ...safeMetrics, stdoutBytes: 18 } }), code("ACCOUNTING_CONFLICT"));
  assert.equal(service.getRun(run.id).chargedTokens, 140);
});

test("accounting: invalid or incomplete receipts conservatively charge and quarantine", (t) => {
  const invalid: Array<AdapterUsage | null> = [null,
    { ...usage(), promptTokens: -1 }, { ...usage(), completionTokens: 1.5 },
    { ...usage(), totalTokens: 141 }, { ...usage(), totalTokens: NaN },
    { ...usage(), completionTokens: Infinity }, { ...usage(), promptTokens: null },
    { ...usage(), coversInternalCalls: false }, { ...usage(), fieldPath: "" },
    { ...usage(), promptTokens: Number.MAX_SAFE_INTEGER + 1 }];
  const { service } = fixture(t);
  for (const [i, observed] of invalid.entries()) {
    const run = service.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["alpha", "beta"] });
    const admitted = reserve(service, run.id, `invalid-${i}`);
    markAccountingDispatchStarted(admitted.permit);
    const result = service.settleCall(admitted.permit, { usage: observed, outcomeCode: "OK" });
    assert.equal(result.state, "uncertain", `receipt ${i}`);
    assert.equal(result.chargedTokens, 1850, `receipt ${i}`);
    assert.equal(service.getRun(run.id).reservedTokens, 0);
    assert.equal(service.completionLimit(run.id, "beta"), 1800);
    if (observed !== null) assert.equal(result.outcomeCode, "USAGE_INVALID");
  }
});

test("accounting: a fabricated permit cannot authorize dispatch", () => {
  assert.throws(() => assertAccountingPermit({} as Parameters<typeof assertAccountingPermit>[0]), code("LIMIT_UNSUPPORTED"));
});

test("accounting: a 16-token call cap keeps the agent ladder and exposes its durable receipt", (t) => {
  const { service, run } = fixture(t);
  assert.equal(service.callEvidence("missing-call"), null);
  const input = { runId: run.id, callId: "bounded-16", slotId: "alpha", runtimeModel: "test-model",
    promptTokensUpper: 37, completionLimit: 16, totalTokensUpper: 53 };
  const admitted = service.reserveCall(input);
  assert.equal(admitted.limits.maxCompletionTokens, 16);
  assert.equal(admitted.reservation.totalTokens, 53);
  assert.equal(service.completionLimit(run.id, "alpha"), 1800);
  assert.equal(service.completionLimit(run.id, "beta"), 1800);
  assert.throws(() => service.reserveCall({ ...input, callId: "above-ladder", completionLimit: 1801, totalTokensUpper: 1838 }), code("INVALID_REQUEST"));
  const reserved = service.callEvidence(input.callId)!;
  assert.equal(reserved.reservation.state, "reserved");
  assert.equal(reserved.reservation.completionLimit, 16);
  assert.equal(reserved.receipt, null);
  markAccountingDispatchStarted(admitted.permit);
  assert.equal(service.callEvidence(input.callId)!.reservation.state, "started");
  const settled = service.settleCall(admitted.permit, { usage: usage(37, 8), actualModel: "test-model", outcomeCode: "OK" });
  assert.equal(settled.state, "settled");
  assert.equal(settled.chargedTokens, 45);
  assert.equal(settled.releasedTokens, 8);
  const evidence = service.callEvidence(input.callId)!;
  assert.equal(evidence.reservation.id, admitted.reservation.id);
  assert.equal(evidence.reservation.state, "settled");
  assert.equal(evidence.receipt!.reservationId, admitted.reservation.id);
  assert.equal(evidence.receipt!.chargedTokens, 45);
  assert.equal(evidence.receipt!.actualModel, "test-model");
  assert.equal(service.getRun(run.id).reservedTokens, 0);
  assert.equal(service.completionLimit(run.id, "alpha"), 1800);
  assert.equal(service.completionLimit(run.id, "beta"), 1800);
});

test("accounting: global slot totals aggregate accounting rows while other agents remain unchanged", (t) => {
  const { service, run } = fixture(t);
  assert.deepEqual(service.slotTotals(), {});
  complete(service, run.id, "beta-baseline", "beta", usage(10, 20));
  const gamma = reserve(service, run.id, "gamma-unstarted", "gamma");
  service.releaseUnstarted(gamma.permit, "TEST_RELEASE");
  const before = service.slotTotals();
  assert.deepEqual(before.beta, { calls: 1, started: 1, chargedTokens: 30 });
  assert.deepEqual(before.gamma, { calls: 1, started: 0, chargedTokens: 0 });
  const secondRun = service.createRun({ kind: "engine", baseTurnLimit: 1, eligibleSlots: ["alpha"] });
  const alpha = service.reserveCall({ runId: secondRun.id, callId: "alpha-bounded", slotId: "alpha", runtimeModel: "test-model",
    promptTokensUpper: 7, completionLimit: 16, totalTokensUpper: 23 });
  markAccountingDispatchStarted(alpha.permit);
  const observation = { usage: usage(7, 3), actualModel: "test-model", outcomeCode: "OK" };
  service.settleCall(alpha.permit, observation);
  service.settleCall(alpha.permit, observation);
  service.reserveCall({ runId: run.id, callId: "alpha-pending", slotId: "alpha", runtimeModel: "test-model",
    promptTokensUpper: 9, completionLimit: 16, totalTokensUpper: 25 });
  const after = service.slotTotals();
  assert.deepEqual(after.alpha, { calls: 2, started: 1, chargedTokens: 10 });
  assert.deepEqual(after.beta, before.beta);
  assert.deepEqual(after.gamma, before.gamma);
});
