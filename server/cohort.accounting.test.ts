import { createFixtureSpendingPolicy } from "./adapters/fixture-spending";
import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRequest, AdapterResultLive, ModelAdapter } from "./adapters/types";

// The preload redirects application SQLite to memory before any server singleton import.
await import("./offline-test-home.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert(process.cwd().startsWith(join(root, "node_modules", ".offline-test-homes")));
const { CohortConsole } = await import("./cohort");
const { storage } = await import("./storage");
const { L10AccountingStore } = await import("./adapters/l10-accounting-store");
const { L10AccountingService } = await import("./adapters/l10-accounting");
const { L10CliAdapter } = await import("./adapters/l10-cohort");
const { AdapterFailure } = await import("./adapters/types");
const { markAccountingDispatchStarted } = await import("./adapters/l10-admission");
const { L10_FROZEN_LITERALS } = await import("./adapters/l10-routes");
const { foundingCohort } = await import("../shared/cohort");

writeFileSync("agent-commons.adapters.json", JSON.stringify({ version: 1, defaultAdapter: "l10-cli",
  slots: Object.fromEntries(Object.entries(L10_FROZEN_LITERALS).filter(([, model]) => model).map(([id, runtimeModel]) => [id, { runtimeModel }])) }));
const originalCall = L10CliAdapter.prototype.call;
const originalMetering = Object.getOwnPropertyDescriptor(L10CliAdapter.prototype, "metering");
const originalAdapter = process.env.AGENT_COMMONS_ADAPTER;
const originalOffline = process.env.AGENT_COMMONS_OFFLINE;
delete process.env.AGENT_COMMONS_ADAPTER;
delete process.env.AGENT_COMMONS_OFFLINE;
const connections: DatabaseSync[] = [];

function fixture(baseTurnLimit = 7) {
  const db = new DatabaseSync(":memory:"); connections.push(db);
  const store = new L10AccountingStore(db);
  const accounting = new L10AccountingService(store, { spending: createFixtureSpendingPolicy() });
  storage.saveCohort({ entries: [], running: false, busy: null, round: 0, limit: baseTurnLimit, error: null,
    statuses: {}, budget: { windowStart: Date.now(), attempts: 0 }, adapterDiagnostics: {} });
  const console = new CohortConsole(accounting);
  return { console, accounting, store };
}

function live(req: AdapterRequest, completionTokens = 100): AdapterResultLive {
  return { kind: "live", text: '{"body":"metered fixture contribution"}', actualModel: req.runtimeModel,
    modelEvidence: { source: "cli-envelope", fieldPath: "model" },
    usage: { promptTokens: 40, completionTokens, totalTokens: 40 + completionTokens,
      coversInternalCalls: true, source: "cli-envelope", fieldPath: "usage" },
    metrics: { exitCode: 0, stdoutBytes: 100, stdoutSha256: "a".repeat(64), stderrBytes: 0, stderrSha256: "b".repeat(64) } };
}

function install(handler: (req: AdapterRequest) => Promise<AdapterResultLive> | AdapterResultLive, metered = true) {
  if (metered) Object.defineProperty(L10CliAdapter.prototype, "metering", { configurable: true,
    value: { version: 1, coversInternalCalls: true, bounds: ({ maxCompletionTokens }: { maxCompletionTokens: number }) =>
      ({ promptTokensUpper: 100, totalTokensUpper: 100 + maxCompletionTokens }) } satisfies ModelAdapter["metering"] });
  L10CliAdapter.prototype.call = async req => {
    markAccountingDispatchStarted(req.accountingPermit);
    return handler(req);
  };
}

afterEach(() => {
  L10CliAdapter.prototype.call = originalCall;
  if (originalMetering) Object.defineProperty(L10CliAdapter.prototype, "metering", originalMetering);
  else delete (L10CliAdapter.prototype as unknown as { metering?: unknown }).metering;
});
after(() => {
  for (const db of connections) db.close();
  if (originalAdapter === undefined) delete process.env.AGENT_COMMONS_ADAPTER; else process.env.AGENT_COMMONS_ADAPTER = originalAdapter;
  if (originalOffline === undefined) delete process.env.AGENT_COMMONS_OFFLINE; else process.env.AGENT_COMMONS_OFFLINE = originalOffline;
});

test("unmetered live adapter is refused before reservation or invocation", async () => {
  const { console, accounting } = fixture(); let calls = 0;
  install(req => { calls++; return live(req); }, false);
  await assert.rejects(console.callForSlot(foundingCohort[0], "fixture", console.generation), { code: "LIMIT_UNSUPPORTED" });
  assert.equal(calls, 0);
  assert.equal(accounting.getRun(console.state.accountingRunId!).attemptedTurns, 0);
});

test("metered calls share a run, settle once, and advance only the serving agent ladder", async () => {
  const { console, accounting, store } = fixture(); const requests: AdapterRequest[] = [];
  install(req => { requests.push(req); return live(req, Math.floor(req.limits.maxCompletionTokens * 0.9)); });
  await console.callForSlot(foundingCohort[0], "first fixture", console.generation);
  await console.callForSlot(foundingCohort[0], "second fixture", console.generation);
  await console.callForSlot(foundingCohort[1], "peer fixture", console.generation);
  assert.equal(new Set(requests.map(req => req.runId)).size, 1);
  assert.deepEqual(requests.map(req => req.limits.maxCompletionTokens), [1800, 3000, 1800]);
  const run = accounting.getRun(requests[0].runId);
  assert.equal(run.reservedTokens, 0);
  assert.equal(run.chargedTokens, 3 * 40 + 1620 + 2700 + 1620);
  assert.equal(run.ladder.continuity.currentLimit, 6000);
  assert.equal(run.ladder.collaboration.currentLimit, 1800);
  for (const req of requests) assert.equal(store.getReceipt(req.reservation.id)?.state, "settled");
});

test("productive cancellation still settles measured consumption", async () => {
  const { console, accounting } = fixture();
  install(req => { console.pause(); return live(req); });
  await console.callForSlot(foundingCohort[0], "productive cancellation fixture", console.generation);
  const run = accounting.getRun(console.state.accountingRunId!);
  assert.equal(run.chargedTokens, 140);
  assert.equal(run.reservedTokens, 0);
  assert.equal(Object.keys(console.state.adapterDiagnostics!).length, 0);
});

test("unknown dispatched outcome retains TIMEOUT and quarantines only its agent", async () => {
  const { console, accounting } = fixture();
  install(() => { throw new AdapterFailure("TIMEOUT", "fixture downstream timeout", null, true); });
  await assert.rejects(console.callForSlot(foundingCohort[0], "fixture", console.generation), { code: "TIMEOUT", message: "fixture downstream timeout" });
  const run = accounting.getRun(console.state.accountingRunId!);
  assert.equal(run.chargedTokens, 1900);
  assert.equal(run.reservedTokens, 0);
  assert.equal(run.state, "active");
  assert.deepEqual(run.excludedSlots, ["continuity"]);
  assert.equal(accounting.nextEligibleAgent(run.id, "continuity"), "governance");
});

test("productive missing usage is rejected and quarantines the serving agent", async () => {
  const { console, accounting } = fixture();
  install(req => ({ ...live(req), usage: null }));
  await assert.rejects(console.callForSlot(foundingCohort[0], "missing usage fixture", console.generation), { code: "USAGE_INVALID" });
  assert.deepEqual(accounting.getRun(console.state.accountingRunId!).excludedSlots, ["continuity"]);
});

test("unknown outcomes hand the same phase to eligible founding peers and stop on exhaustion", async () => {
  const { console, accounting } = fixture(); const requests: AdapterRequest[] = [];
  install(req => { requests.push(req); throw new AdapterFailure("TIMEOUT", "fixture uncertain result", null, true); });
  console.state.running = true;
  await console.run(console.generation);
  assert.deepEqual(requests.map(req => req.slotId), foundingCohort.map(member => member.id));
  assert.equal(new Set(requests.map(req => req.runId)).size, 1);
  assert(requests.every(req => req.prompt.includes("Current phase: needs.")));
  assert(requests.slice(1).every(req => req.prompt.includes("Continue the same bounded task")));
  assert.equal(console.state.running, false);
  assert.equal(console.state.entries.length, 0);
  assert.equal(accounting.getRun(requests[0].runId).chargedTokens, 7 * 1900);
  assert.match(console.state.error!, /No eligible agent/);
});

test("a successful handoff retains the shared accounting run and accepted contribution", async () => {
  const { console, accounting } = fixture(3); const requests: AdapterRequest[] = [];
  install(req => {
    requests.push(req);
    if (req.slotId === "continuity") throw new AdapterFailure("TIMEOUT", "fixture uncertain result", null, true);
    return live(req);
  });
  console.state.running = true;
  await console.run(console.generation);
  assert.deepEqual(requests.map(req => req.slotId), ["continuity", "governance", "governance"]);
  assert.equal(new Set(requests.map(req => req.runId)).size, 1);
  assert.equal(requests[1].prompt.includes("Continue the same bounded task"), true);
  assert.equal(console.state.entries.length, 2);
  assert.equal(console.state.entries[0].agent, "governance");
  assert.equal(console.state.entries[0].stage, "needs");
  const run = accounting.getRun(requests[0].runId);
  assert.equal(run.chargedTokens, 1900 + 2 * 140);
  assert.equal(run.reservedTokens, 0);
  assert.deepEqual(run.excludedSlots, ["continuity"]);
  assert.equal(console.state.adapterDiagnostics!.continuity.code, "TIMEOUT");
});

test("a measured productive overrun is rejected", async () => {
  const { console, accounting } = fixture();
  install(req => live(req, req.limits.maxCompletionTokens + 1));
  await assert.rejects(console.callForSlot(foundingCohort[0], "overrun fixture", console.generation), { code: "ACCOUNTING_OVERRUN" });
  assert.equal(accounting.getRun(console.state.accountingRunId!).state, "exhausted");
});

test("seven-slot provider probes count input without generation, admission, dispatch or healthy-text claims", async () => {
  const { console, accounting } = fixture(); let generations = 0; let counts = 0;
  install(req => { generations++; return live(req); });
  Object.defineProperty(L10CliAdapter.prototype, "metering", { configurable: true, value: {
    version: 1, coversInternalCalls: true,
    bounds: async ({ maxCompletionTokens }: { maxCompletionTokens: number }) => {
      counts++; return { promptTokensUpper: 100, totalTokensUpper: 100 + maxCompletionTokens };
    },
  } });
  console.state.probing = true;
  await console.probe(console.generation);
  assert.equal(counts, 7);
  assert.equal(generations, 0);
  assert.equal(console.state.entries.length, 0);
  const run = accounting.getRun(console.state.accountingRunId!);
  assert.equal(run.attemptedTurns, 0);
  assert.equal(run.chargedTokens, 0);
  assert.equal(run.reservedTokens, 0);
  assert.equal(console.state.probeProgress, 7);
  assert.equal(foundingCohort.find(member => member.id === "release")!.name, "Argon");
  assert.equal(console.state.adapterDiagnostics!.release.model, "gemini-4-argon");
  for (const { id } of foundingCohort) {
    const diagnostic = console.state.adapterDiagnostics![id];
    assert.equal(diagnostic.available, false);
    assert.equal(diagnostic.preflightReady, true);
    assert.equal(diagnostic.code, "PREFLIGHT_OK");
    assert.equal(diagnostic.reportedPromptTokens, 100);
    assert.equal(diagnostic.reservationTokens, 1900);
    assert.equal(console.state.statuses[id], "preflight ready");
    assert.match(diagnostic.message, /generation not tested/);
    assert.equal("actualModel" in diagnostic, false);
  }
});

test("Prism and Terra preflight failures stay unavailable without generation or billing", async () => {
  const { console, accounting } = fixture(); let generations = 0;
  install(req => { generations++; return live(req); });
  Object.defineProperty(L10CliAdapter.prototype, "metering", { configurable: true, value: {
    version: 1, coversInternalCalls: true,
    bounds: async ({ slotId, maxCompletionTokens }: { slotId: string; maxCompletionTokens: number }) => {
      if (slotId === "integration" || slotId === "sustainability") throw new AdapterFailure("CREDENTIAL_MISSING", "Offline fixture activation unavailable", null, false);
      return { promptTokensUpper: 100, totalTokensUpper: 100 + maxCompletionTokens };
    },
  } });
  console.state.probing = true;
  await console.probe(console.generation);
  assert.equal(generations, 0);
  assert.equal(console.state.probeProgress, 7);
  for (const id of ["integration", "sustainability"]) {
    const diagnostic = console.state.adapterDiagnostics![id];
    assert.equal(diagnostic.code, "CREDENTIAL_MISSING");
    assert.equal(diagnostic.available, false);
    assert.notEqual(diagnostic.preflightReady, true);
    assert.equal(console.state.statuses[id], "adapter blocked");
  }
  const run = accounting.getRun(console.state.accountingRunId!);
  assert.equal(run.attemptedTurns, 0);
  assert.equal(run.chargedTokens, 0);
  assert.equal(run.reservedTokens, 0);
});

test("async metering accepts provider evidence and shares the turn timeout", async () => {
  const { console, accounting } = fixture(); let request: AdapterRequest | undefined;
  const realNow = Date.now; let clock = realNow();
  Date.now = () => clock;
  try {
    install(req => {
      request = req;
      const response = live(req);
      return { ...response, modelEvidence: { source: "provider-response", fieldPath: "model" },
        usage: { ...response.usage!, source: "provider-response" } };
    });
    Object.defineProperty(L10CliAdapter.prototype, "metering", { configurable: true, value: {
      version: 1, coversInternalCalls: true,
      bounds: async ({ maxCompletionTokens }: { maxCompletionTokens: number }) => {
        await Promise.resolve(); clock += 150;
        return { promptTokensUpper: 100, totalTokensUpper: 100 + maxCompletionTokens };
      },
    } });
    const response = await console.callForSlot(foundingCohort[0], "async count fixture", console.generation, 1000);
    assert.equal(request!.timeoutMs, 850);
    assert.equal(response.kind, "live");
    assert.equal(accounting.getRun(request!.runId).chargedTokens, 140);
    console.recordAdapter("continuity", request!.runtimeModel, undefined, undefined, response.kind === "live" ? response : undefined);
    assert.equal((console.state.adapterDiagnostics!.continuity as unknown as { usageValid: boolean }).usageValid, true);
  } finally { Date.now = realNow; }
});

test("async pre-admission failures preserve their code without reservation or dispatch", async () => {
  const { console, accounting } = fixture(); let calls = 0;
  install(req => { calls++; return live(req); });
  Object.defineProperty(L10CliAdapter.prototype, "metering", { configurable: true, value: {
    version: 1, coversInternalCalls: true,
    bounds: async () => { throw new AdapterFailure("CREDENTIAL_MISSING", "fixture activation refused", null, false); },
  } });
  await assert.rejects(console.callForSlot(foundingCohort[0], "fixture", console.generation), { code: "CREDENTIAL_MISSING" });
  assert.equal(calls, 0);
  assert.equal(accounting.getRun(console.state.accountingRunId!).attemptedTurns, 0);
});

test("measured provider error usage is settled while its downstream error remains visible", async () => {
  const { console, accounting } = fixture();
  install(req => {
    const response = live(req);
    throw Object.assign(new AdapterFailure("MODEL_MISMATCH", "fixture downstream mismatch", null, false), {
      accountingObservation: { usage: { ...response.usage, source: "provider-response" }, metrics: response.metrics,
        actualModel: "unaccepted-model", outcomeCode: "MODEL_MISMATCH" },
    });
  });
  await assert.rejects(console.callForSlot(foundingCohort[0], "fixture", console.generation), { code: "MODEL_MISMATCH" });
  const run = accounting.getRun(console.state.accountingRunId!);
  assert.equal(run.chargedTokens, 140);
  assert.equal(run.reservedTokens, 0);
  assert.equal(console.state.entries.length, 0);
});
