/**
 * L10 rework 3 — R3 poles: eligibility/offline gate ahead of ALL transport
 * selection; zero dispatch for Terra/Prism incl. the default call() path;
 * legacy entries offline-gated; explicit stub stays usable.
 *
 * Mirrors the prior probe shape: substitute an offline `call()` and count
 * dispatches; the gate must fire before either path is reached.
 *
 */
import assert from "node:assert/strict";
import { foundingCohort } from "../../shared/cohort";
import { AdapterFailure } from "./types";

async function main() {
  // Dynamic import after env setup so module state matches each pole.
  const { cohortConsole } = await import("../cohort");

  const terra = foundingCohort.find((m) => m.id === "sustainability")!;
  const prism = foundingCohort.find((m) => m.id === "integration")!;
  const continuity = foundingCohort.find((m) => m.id === "continuity")!;

  // CONTROL — continuity reaches the default path exactly once (dispatch
  // counted via a substituted offline call()).
  let dispatches = 0;
  const origCall = cohortConsole.call.bind(cohortConsole);
  (cohortConsole as unknown as { call: unknown }).call = async () => { dispatches++; return "ok"; };
  try {
    const r = await cohortConsole.callForSlot(continuity, "p", 1, 1000);
    assert.equal(r.text, "ok");
    assert.equal(dispatches, 1, "CONTROL: continuity dispatches once on the default path");
  } finally {
    (cohortConsole as unknown as { call: unknown }).call = origCall;
  }

  // MUTANT — Terra on the default path: MODEL_UNAVAILABLE, ZERO dispatch.
  dispatches = 0;
  (cohortConsole as unknown as { call: unknown }).call = async () => { dispatches++; return "ok"; };
  let terraErr: AdapterFailure | null = null;
  try { await cohortConsole.callForSlot(terra, "p", 1, 1000); }
  catch (e) { if (e instanceof AdapterFailure) terraErr = e; else throw e; }
  finally { (cohortConsole as unknown as { call: unknown }).call = origCall; }
  assert.ok(terraErr && terraErr.code === "MODEL_UNAVAILABLE", "MUTANT: Terra throws MODEL_UNAVAILABLE");
  assert.equal(dispatches, 0, "MUTANT: Terra dispatches ZERO times (gate ahead of transport selection)");

  // MUTANT — Prism on the default path: same zero-dispatch gate.
  dispatches = 0;
  (cohortConsole as unknown as { call: unknown }).call = async () => { dispatches++; return "ok"; };
  let prismErr: AdapterFailure | null = null;
  try { await cohortConsole.callForSlot(prism, "p", 1, 1000); }
  catch (e) { if (e instanceof AdapterFailure) prismErr = e; else throw e; }
  finally { (cohortConsole as unknown as { call: unknown }).call = origCall; }
  assert.ok(prismErr && prismErr.code === "MODEL_UNAVAILABLE", "MUTANT: Prism throws MODEL_UNAVAILABLE");
  assert.equal(dispatches, 0, "MUTANT: Prism dispatches ZERO times");

  // MUTANT — AGENT_COMMONS_OFFLINE=1 blocks the legacy Python call() path.
  process.env.AGENT_COMMONS_OFFLINE = "1";
  try {
    let offlineErr: AdapterFailure | null = null;
    try { await origCall("any-model", "p", 1, 500); }
    catch (e) { if (e instanceof AdapterFailure) offlineErr = e; else throw e; }
    assert.ok(offlineErr && offlineErr.code === "MODEL_UNAVAILABLE",
      "MUTANT: legacy Python path blocked under AGENT_COMMONS_OFFLINE=1");

    // CONTROL — explicit offline stub stays usable under the same flag:
    // resolveAdapter("stub") works (makesLiveCalls=false).
    const { resolveAdapter } = await import("./index");
    const stub = resolveAdapter("stub");
    assert.equal(stub.makesLiveCalls, false, "CONTROL: explicit offline stub stays usable");

    // CONTROL — Terra via the explicit stub is NOT refused by the R3 gate
    // (stub is an offline fixture path, not a live subscription path).
    (cohortConsole as unknown as { call: unknown }).call = origCall;
    process.env.AGENT_COMMONS_ADAPTER = "stub";
    process.env.AGENT_COMMONS_STUB_FIXTURES = new URL("./fixtures/stub-turns.json", import.meta.url).pathname;
    try {
      const r = await cohortConsole.callForSlot(terra, "Model transport health check only. Return the word OK.", 1, 1000);
      assert.equal(typeof r.text, "string", "CONTROL: Terra via explicit stub reaches the fixture (offline path usable)");
    } finally {
      delete process.env.AGENT_COMMONS_ADAPTER;
      delete process.env.AGENT_COMMONS_STUB_FIXTURES;
    }
  } finally {
    delete process.env.AGENT_COMMONS_OFFLINE;
  }

  // --- R3 direct legacy entry tests (with AGENT_COMMONS_OFFLINE unset) ---

  // 1. Direct CohortConsole.call(model, ...)
  // MUTANT: Terra model fails closed with MODEL_UNAVAILABLE ahead of spawn
  let directTerraErr: AdapterFailure | null = null;
  try {
    await cohortConsole.call(terra.model, "test prompt", 1, 500);
  } catch (e) {
    if (e instanceof AdapterFailure) directTerraErr = e;
  }
  assert.ok(directTerraErr && directTerraErr.code === "MODEL_UNAVAILABLE",
    "MUTANT: direct CohortConsole.call(terra.model) must fail closed with MODEL_UNAVAILABLE");

  // MUTANT: Prism model fails closed with MODEL_UNAVAILABLE ahead of spawn
  let directPrismErr: AdapterFailure | null = null;
  try {
    await cohortConsole.call(prism.model, "test prompt", 1, 500);
  } catch (e) {
    if (e instanceof AdapterFailure) directPrismErr = e;
  }
  assert.ok(directPrismErr && directPrismErr.code === "MODEL_UNAVAILABLE",
    "MUTANT: direct CohortConsole.call(prism.model) must fail closed with MODEL_UNAVAILABLE");

  // 2. Direct PreviewBridgeAdapter.call(req)
  const { PreviewBridgeAdapter } = await import("./preview_bridge");
  const bridge = new PreviewBridgeAdapter();

  // MUTANT: PreviewBridgeAdapter with Terra slot/model fails closed
  let bridgeTerraErr: AdapterFailure | null = null;
  try {
    await bridge.call({
      slotId: "sustainability",
      historicalModel: terra.model,
      runtimeModel: terra.model,
      prompt: "test",
      timeoutMs: 500,
      signal: { cancelled: () => false },
      runId: "r3-test-terra",
      callId: "call-1",
      limits: { maxCompletionTokens: 100, maxTotalTokens: 200, maxCliModelCalls: 1 },
      reservation: { id: "res-1", promptTokensUpper: 50, totalTokens: 150 },
    });
  } catch (e) {
    if (e instanceof AdapterFailure) bridgeTerraErr = e;
  }
  assert.ok(bridgeTerraErr && bridgeTerraErr.code === "MODEL_UNAVAILABLE",
    "MUTANT: direct PreviewBridgeAdapter.call with Terra must fail closed with MODEL_UNAVAILABLE");

  // MUTANT: PreviewBridgeAdapter with Prism slot/model fails closed
  let bridgePrismErr: AdapterFailure | null = null;
  try {
    await bridge.call({
      slotId: "integration",
      historicalModel: prism.model,
      runtimeModel: prism.model,
      prompt: "test",
      timeoutMs: 500,
      signal: { cancelled: () => false },
      runId: "r3-test-prism",
      callId: "call-2",
      limits: { maxCompletionTokens: 100, maxTotalTokens: 200, maxCliModelCalls: 1 },
      reservation: { id: "res-2", promptTokensUpper: 50, totalTokens: 150 },
    });
  } catch (e) {
    if (e instanceof AdapterFailure) bridgePrismErr = e;
  }
  assert.ok(bridgePrismErr && bridgePrismErr.code === "MODEL_UNAVAILABLE",
    "MUTANT: direct PreviewBridgeAdapter.call with Prism must fail closed with MODEL_UNAVAILABLE");

  // 3. Direct modelCall in engine.ts
  const { modelCall } = await import("../engine");

  // MUTANT: modelCall with Terra agent fails closed
  let engineTerraErr: AdapterFailure | null = null;
  try {
    await modelCall(
      { id: "sustainability", name: "Terra", provider: "OpenAI", model: "gpt_5_6_terra", role: "Steward", color: "green" },
      "test prompt",
      [],
      null,
    );
  } catch (e) {
    if (e instanceof AdapterFailure) engineTerraErr = e;
  }
  assert.ok(engineTerraErr && engineTerraErr.code === "MODEL_UNAVAILABLE",
    "MUTANT: direct engine modelCall with Terra must fail closed with MODEL_UNAVAILABLE");

  // MUTANT: modelCall with Prism agent fails closed
  let enginePrismErr: AdapterFailure | null = null;
  try {
    await modelCall(
      { id: "integration", name: "Prism", provider: "Google", model: "gemini_3_8_flash", role: "Researcher", color: "blue" },
      "test prompt",
      [],
      null,
    );
  } catch (e) {
    if (e instanceof AdapterFailure) enginePrismErr = e;
  }
  assert.ok(enginePrismErr && enginePrismErr.code === "MODEL_UNAVAILABLE",
    "MUTANT: direct engine modelCall with Prism must fail closed with MODEL_UNAVAILABLE");

  console.log("PASS R3: continuity dispatches once; Terra + Prism MODEL_UNAVAILABLE with ZERO dispatch across callForSlot and direct legacy entries (cohort.call, preview_bridge.call, engine.modelCall); explicit stub stays usable.");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
