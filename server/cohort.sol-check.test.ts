import { createFixtureSpendingPolicy } from "./adapters/fixture-spending";
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRequest, AdapterResultLive } from "./adapters/types";

await import("./offline-test-home.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert(process.cwd().startsWith(join(root, "node_modules", ".offline-test-homes")));
const { CohortConsole } = await import("./cohort");
const { storage } = await import("./storage");
const { L10AccountingService } = await import("./adapters/l10-accounting");
const { L10AccountingStore } = await import("./adapters/l10-accounting-store");
const { OpenAIResponsesAdapter } = await import("./adapters/openai_responses");
const { AdapterFailure } = await import("./adapters/types");
const { markAccountingDispatchStarted } = await import("./adapters/l10-admission");
const { foundingCohort } = await import("../shared/cohort");
const { L10_FROZEN_LITERALS } = await import("./adapters/l10-routes");
const key = "owner-sol-generation-check-v1";
writeFileSync("agent-commons.adapters.json", JSON.stringify({ version: 1 }));
delete process.env.AGENT_COMMONS_ADAPTER;
delete process.env.AGENT_COMMONS_OFFLINE;
const prototype = OpenAIResponsesAdapter.prototype as unknown as { activation(): string; request(...args: any[]): Promise<any>; call(req: AdapterRequest): Promise<AdapterResultLive> };
const original = { activation: prototype.activation, request: prototype.request, call: prototype.call };
const connections: DatabaseSync[] = [];
let calls = 0; let mode: "ok" | "uncertain" | "unexpected" = "ok";
let requests: AdapterRequest[] = [];

function fixture(seed = false) {
  const connection = new DatabaseSync(":memory:"); connections.push(connection);
  const accounting = new L10AccountingService(new L10AccountingStore(connection), { spending: createFixtureSpendingPolicy() });
  storage.saveValue(key, null);
  const diagnostics = Object.fromEntries(foundingCohort.filter(member => member.id !== "governance").map(member => [member.id, { model: member.model, checkedAt: "fixture", available: false, code: "PREFLIGHT_OK", message: "retained fixture", transportStatus: null, retryable: false }]));
  storage.saveCohort({ entries: [], running: false, busy: null, round: 0, limit: 7, error: null, statuses: {}, adapterDiagnostics: diagnostics, budget: { windowStart: Date.now(), attempts: 0 } });
  if (seed) for (const member of foundingCohort) for (let turn = 0; turn < 2; turn++) {
    const run = accounting.createRun({ kind: "cohort", baseTurnLimit: 1, eligibleSlots: [member.id] });
    const admission = accounting.reserveCall({ runId: run.id, callId: `${member.id}-${turn}`, slotId: member.id, runtimeModel: L10_FROZEN_LITERALS[member.id], promptTokensUpper: 7, completionLimit: 16, totalTokensUpper: 23 });
    markAccountingDispatchStarted(admission.permit);
    accounting.settleCall(admission.permit, { usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, coversInternalCalls: true, source: "provider-response", fieldPath: "usage" }, outcomeCode: "OK" });
  }
  calls = 0; mode = "ok"; requests = [];
  prototype.activation = () => "offline-fixture-only";
  prototype.request = async (path: string) => ({ data: path.startsWith("/models/") ? { id: L10_FROZEN_LITERALS.governance } : { object: "response.input_tokens", input_tokens: 7 }, raw: "{}" });
  prototype.call = async req => {
    calls++; requests.push(req); markAccountingDispatchStarted(req.accountingPermit);
    if (mode === "uncertain") throw new AdapterFailure("TIMEOUT", "offline fixture timeout", "CLIENT_TIMEOUT_80000ms", false);
    return { kind: "live", text: mode === "unexpected" ? "private fixture response must not be persisted" : " PONG\n", actualModel: L10_FROZEN_LITERALS.governance,
      modelEvidence: { source: "provider-response", fieldPath: "model" },
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10, coversInternalCalls: true, source: "provider-response", fieldPath: "usage" },
      providerUsage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 2, cache_write_tokens: null }, output_tokens_details: { reasoning_tokens: 1 } },
      metrics: { exitCode: 0, stdoutBytes: 4, stdoutSha256: "a".repeat(64), stderrBytes: 0, stderrSha256: "b".repeat(64) } };
  };
  return { console: new CohortConsole(accounting), accounting, diagnostics };
}
afterEach(() => { prototype.activation = original.activation; prototype.request = original.request; prototype.call = original.call; });
after(() => { for (const connection of connections) connection.close(); });

test("one durable Sol invocation across repeats and instances preserves historical totals and other agents", async () => {
  const { console, accounting, diagnostics } = fixture(true);
  const report = await console.runSolGenerationCheck();
  assert.equal(calls, 1);
  assert.equal(requests[0].slotId, "governance");
  assert.equal(requests[0].runtimeModel, "gpt-6.1-sol");
  assert.equal(requests[0].prompt, "Reply with the word: PONG");
  assert.equal(requests[0].limits.maxCompletionTokens, 16);
  assert.equal(report.reply, "PONG");
  assert.deepEqual(report.before.global, { calls: 14, started: 14, chargedTokens: 42 });
  assert.deepEqual(report.after.global, { calls: 15, started: 15, chargedTokens: 52 });
  assert.deepEqual(report.delta.global, { calls: 1, started: 1, chargedTokens: 10 });
  assert.equal(report.otherSlotsUnchanged, true);
  assert.equal(report.reservation!.permitAsserted, true);
  assert.equal(report.reservation!.reservationState, "reserved");
  assert.equal(report.reservation!.startedAtMs, null);
  assert.equal(report.reservation!.runReservedTokens, 23);
  assert.equal(report.persisted!.receiptState, "settled");
  assert.equal(report.persisted!.chargedTokens, 10);
  assert.equal(report.persisted!.releasedTokens, 13);
  assert.equal(report.overrun, false);
  assert.equal(report.providerUsage!.output_tokens_details.reasoning_tokens, 1);
  for (const member of foundingCohort.filter(member => member.id !== "governance")) assert.deepEqual(console.state.adapterDiagnostics![member.id], diagnostics[member.id]);
  assert.deepEqual(await console.runSolGenerationCheck(), report);
  assert.deepEqual(await new CohortConsole(accounting).runSolGenerationCheck(), report);
  assert.equal(calls, 1);
  assert.equal(console.state.entries.length, 0);
  assert.equal(console.state.running, false);
  assert.equal(console.state.busy, null);
});

test("uncertain Sol failure consumes the one-use guard and retains exact diagnostics", async () => {
  const { console, accounting } = fixture(); mode = "uncertain";
  const report = await console.runSolGenerationCheck();
  assert.equal(report.code, "TIMEOUT");
  assert.equal(report.transportStatus, "CLIENT_TIMEOUT_80000ms");
  assert.equal(console.state.adapterDiagnostics!.governance.transportStatus, report.transportStatus);
  assert.equal(report.reply, null);
  assert.equal(report.persisted!.receiptState, "uncertain");
  assert.equal(report.delta.global.chargedTokens, 23);
  assert.deepEqual(await new CohortConsole(accounting).runSolGenerationCheck(), report);
  assert.equal(calls, 1);
});

test("busy, failed integrity and claimed unknown states never dispatch", async () => {
  const { console } = fixture();
  console.state.running = true;
  await assert.rejects(console.runSolGenerationCheck(), { code: "CHECK_BUSY" });
  assert.equal(storage.loadValue(key, null), null);
  console.state.running = false;
  storage.saveValue(key, { status: "claimed" });
  await assert.rejects(console.runSolGenerationCheck(), { code: "CHECK_ALREADY_CLAIMED" });
  storage.saveValue(key, null);
  console.memories.delete("continuity");
  await assert.rejects(console.runSolGenerationCheck(), { code: "INTEGRITY_FAILED" });
  assert.equal(storage.loadValue(key, null), null);
  assert.equal(calls, 0);
});

test("unexpected response text is discarded and cannot authorize a retry", async () => {
  const { console } = fixture(); mode = "unexpected";
  const report = await console.runSolGenerationCheck();
  assert.equal(report.code, "UNEXPECTED_REPLY");
  assert.equal(report.reply, null);
  assert.equal(JSON.stringify(report).includes("private fixture response"), false);
  assert.equal(JSON.stringify(storage.loadValue(key)).includes("private fixture response"), false);
  await console.runSolGenerationCheck();
  assert.equal(calls, 1);
});
