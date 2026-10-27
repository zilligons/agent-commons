/** R3: current seven-slot eligibility, offline kill switches and unmetered legacy refusal. */
import assert from "node:assert/strict";
import type { AdapterRequest } from "./types";

if (!process.env.NODE_TEST_CONTEXT) {
  process.stderr.write("TEST_RUNNER_REQUIRED\n");
  process.exit(64);
}
// Install memory-only storage before any application module can initialize.
await import("../offline-test-home.mjs");

const { foundingCohort } = await import("../../shared/cohort");
const { AdapterFailure } = await import("./types");
const { L10_FROZEN_LITERALS, assertSlotEligibleForL10 } = await import("./l10-routes");
const { getDefaultAdapterForSlot } = await import("./config");

const code = (expected: string) => (error: unknown) => error instanceof AdapterFailure && error.code === expected;
async function main() {
  const { cohortConsole } = await import("../cohort");
  const { resolveAdapter } = await import("./index");
  const { PreviewBridgeAdapter } = await import("./preview_bridge");
  const { modelCall } = await import("../engine");
  const generation = cohortConsole.generation;
  const selected = foundingCohort.filter(member => ["continuity", "sustainability", "integration"].includes(member.id));
  const saved = { ...process.env };
  const originalCall = cohortConsole.call;
  const { DatabaseSync } = await import("node:sqlite");
  const { L10AccountingService } = await import("./l10-accounting");
  const { L10AccountingStore } = await import("./l10-accounting-store");
  const { createFixtureSpendingPolicy } = await import("./fixture-spending");
  const fixtureDb = new DatabaseSync(":memory:");
  const originalAccounting = Object.getOwnPropertyDescriptor(cohortConsole, "injectedAccounting");
  // Fixture-only accounting for this singleton's security assertions.
  Object.defineProperty(cohortConsole, "injectedAccounting", { configurable: true, writable: true,
    value: new L10AccountingService(new L10AccountingStore(fixtureDb), { spending: createFixtureSpendingPolicy() }) });
  let dispatches = 0;
  try {
    process.env.AGENT_COMMONS_OFFLINE = "1";
    process.env.AGENT_COMMONS_ADAPTER = "preview-bridge";
    cohortConsole.call = async () => { dispatches++; return "OFFLINE_FIXTURE"; };
    for (const member of selected) {
      assert.doesNotThrow(() => assertSlotEligibleForL10(member.id));
      const result = await cohortConsole.callForSlot(member, "p", generation, 1000);
      assert.deepEqual(result, { kind: "offline", text: "OFFLINE_FIXTURE" });
    }
    assert.equal(dispatches, selected.length, "explicit mocked legacy fixture reaches each eligible slot");
    assert.equal(getDefaultAdapterForSlot("integration"), "google-gemini");
    assert.equal(getDefaultAdapterForSlot("sustainability"), "openai-responses");

    // Unsupported selection must fail before either the mocked legacy path or a provider.
    dispatches = 0;
    process.env.AGENT_COMMONS_ADAPTER = "unsupported-legacy-fixture";
    for (const member of selected) await assert.rejects(() => cohortConsole.callForSlot(member, "p", generation, 1000), code("MODEL_UNAVAILABLE"));
    assert.equal(dispatches, 0);
    assert.throws(() => assertSlotEligibleForL10("unsupported-slot"), code("MODEL_UNAVAILABLE"));
    cohortConsole.call = originalCall;

    for (const member of selected) {
      await assert.rejects(() => cohortConsole.call(member.model, "p", generation, 500), code("MODEL_UNAVAILABLE"));
      await assert.rejects(() => modelCall({ id: member.id, name: member.name, provider: member.provider,
        model: member.model, role: member.role, color: "green" } as any, "p", [], null), /MODEL_UNAVAILABLE/);
    }
    assert.equal(resolveAdapter("stub").makesLiveCalls, false);
    process.env.AGENT_COMMONS_ADAPTER = "stub";
    process.env.AGENT_COMMONS_STUB_FIXTURES = new URL("./fixtures/stub-turns.json", import.meta.url).pathname;
    for (const member of selected) {
      const result = await cohortConsole.callForSlot(member, "Model transport health check only. Return the word OK.", generation, 1000);
      assert.equal(result.kind, "offline");
      assert.equal(typeof result.text, "string");
    }

    const bridge = new PreviewBridgeAdapter();
    const req = (member: typeof selected[number]): AdapterRequest => ({ slotId: member.id, historicalModel: member.model,
      runtimeModel: L10_FROZEN_LITERALS[member.id], prompt: "fixture", timeoutMs: 500,
      signal: { cancelled: () => false }, runId: "r3-fixture", callId: "r3-call",
      limits: { maxCompletionTokens: 100, maxTotalTokens: 200, maxCliModelCalls: 1 },
      reservation: { id: "r3-res", promptTokensUpper: 50, totalTokens: 150 } });
    for (const member of selected) await assert.rejects(() => bridge.call(req(member)), code("MODEL_UNAVAILABLE"));
    delete process.env.AGENT_COMMONS_OFFLINE;
    for (const member of selected) {
      // Eligibility does not authorize any unmetered legacy transport.
      await assert.rejects(() => cohortConsole.call(member.model, "p", generation, 500), code("LIMIT_UNSUPPORTED"));
      await assert.rejects(() => bridge.call(req(member)), code("LIMIT_UNSUPPORTED"));
      await assert.rejects(() => modelCall({ id: member.id, name: member.name, provider: member.provider,
        model: member.model, role: member.role, color: "green" } as any, "p", [], null), code("LIMIT_UNSUPPORTED"));
      await assert.rejects(() => bridge.call({ ...req(member), runtimeModel: "" }), code("MODEL_UNAVAILABLE"));
    }
    console.log("PASS R3: eligible-slot controls, unsupported selection, offline and unmetered legacy guards.");
  } finally {
    cohortConsole.call = originalCall;
    process.env = saved;
    if (originalAccounting) Object.defineProperty(cohortConsole, "injectedAccounting", originalAccounting);
    else Reflect.deleteProperty(cohortConsole, "injectedAccounting");
    fixtureDb.close();
  }
}
main().catch(error => { console.error("FAIL:", error); process.exit(1); });
