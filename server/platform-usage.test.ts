import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHostGuard, createOperatorGuard } from "./operator";
import { L10AccountingStore } from "./adapters/l10-accounting-store";
import { L10AccountingService } from "./adapters/l10-accounting";
import { SQLitePlatformSpending } from "./adapters/platform-spending";
import { markAccountingDispatchStarted } from "./adapters/l10-admission";

if (!process.env.NODE_TEST_CONTEXT) process.exit(64);
await import("./offline-test-home.mjs");
const { default: express } = await import("express");
const { registerRoutes } = await import("./routes");
const { storage } = await import("./storage");
const { CohortConsole } = await import("./cohort");

test("platform usage API requires operator authentication and names unresolved legacy history without returning it", async t => {
  const prior = storage.loadCohort();
  t.after(() => storage.saveCohort(prior));
  storage.saveCohort({ ...prior, entries: [{ id: "legacy-fixture", agent: "governance", time: new Date().toISOString(),
    execution: "unknown paid route", body: "private-transcript-fixture", signature: "private-signature-fixture" }] });
  const app = express(), token = "fixture-usage-token";
  app.use(createHostGuard({})); app.use(createOperatorGuard({ env: {}, token: () => token }));
  const server = createServer(app); await registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(`${origin}/api/cohort/usage`)).status, 401);
  assert.equal((await fetch(`${origin}/api/cohort/usage`, { headers: { authorization: "Bearer incorrect" } })).status, 401);
  const response = await fetch(`${origin}/api/cohort/usage`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const usage = await response.json();
  assert.equal(usage.timezone, "America/Los_Angeles");
  assert.deepEqual(usage.limits, { dailyRuns: 4, dailyTokens: 500000, monthlyUsd: 25 });
  assert.equal(usage.history.unreconciledMonth, 1); assert.equal(usage.code, "SPEND_HISTORY_UNVERIFIED");
  assert.equal(usage.monthly.totalUsd, null); assert.equal(usage.monthly.complete, false);
  const serialized = JSON.stringify(usage);
  for (const secret of ["private-transcript-fixture", "private-signature-fixture", "legacy-fixture", "privateKey", "publicKey"])
    assert.equal(serialized.includes(secret), false);
});

test("future live cohort entries sign exact accounting links while preserving old signed entries", t => {
  const prior = storage.loadCohort(); t.after(() => storage.saveCohort(prior));
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = new L10AccountingStore(db);
  let cohort: InstanceType<typeof CohortConsole>;
  const policy = new SQLitePlatformSpending(store, { env: {}, history: () => cohort?.state.entries ?? [] });
  const accounting = new L10AccountingService(store, { spending: policy });
  cohort = new CohortConsole(accounting);
  cohort.append("governance", "build", "Prior offline fixture", "stub adapter (offline fixture)");
  const preserved = JSON.stringify(cohort.state.entries);
  assert.equal(cohort.verify(), true);
  const run = accounting.createRun({ kind: "cohort", baseTurnLimit: 7, eligibleSlots: ["governance"], models: ["gpt-6.1-sol"] });
  const admitted = accounting.reserveCall({ runId: run.id, callId: "signed-future-call", slotId: "governance", runtimeModel: "gpt-6.1-sol",
    promptTokensUpper: 10, completionLimit: 16, totalTokensUpper: 26 });
  markAccountingDispatchStarted(admitted.permit);
  accounting.settleCall(admitted.permit, { outcomeCode: "OK", actualModel: "gpt-6.1-sol", usage: { promptTokens: 1,
    completionTokens: 2, totalTokens: 3, coversInternalCalls: true, source: "provider-response", fieldPath: "usage" } });
  const link = { callId: "signed-future-call", runId: run.id };
  cohort.append("governance", "build", "Future live fixture", "openai-responses adapter; sealed by local host", link);
  assert.equal(cohort.verify(), true);
  assert.equal(JSON.stringify(cohort.state.entries.slice(0, -1)), preserved);
  assert.deepEqual(cohort.state.entries.at(-1)!.accounting, link);
  assert.equal((policy.usage() as any).history.linked, 1);
  assert.throws(() => cohort.append("governance", "build", "Invalid linkage", "live provider call", { ...link, runId: "incorrect" }));
  cohort.state.entries.at(-1)!.accounting!.callId = "tampered";
  assert.equal(cohort.verify(), false);
});
