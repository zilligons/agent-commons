
// Seven-slot offline double/HTTP checks under L10; preload via offline-test-home.mjs.
// Fixtures execute no model and use no credentials; offline double covers console/route/orchestration paths.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { AdapterFailure } from "./adapters";

await import("./offline-test-home.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert(process.cwd().startsWith(join(root, "node_modules", ".offline-test-homes")));
const trace = join(process.cwd(), "transport-trace.jsonl");
const originalPath = process.env.PATH;
process.env.PATH = `${join(root, "server", "fixtures", "bin")}:${originalPath}`;
process.env.OFFLINE_FIXTURE_TRACE = trace;
process.env.OFFLINE_FIXTURE_SCENARIO = "mixed";
const { default: Database } = await import("better-sqlite3");
const memoryOnly = new Database("offline-fixture-do-not-create.db");
assert.equal(memoryOnly.name, ":memory:", "Storage preload must intercept SQLite before server imports");
memoryOnly.close();
assert.equal(existsSync("offline-fixture-do-not-create.db"), false);
const { CohortConsole, cohortConsole } = await import("./cohort");
const { storage } = await import("./storage");
const { foundingCohort } = await import("../shared/cohort");
const { registerRoutes } = await import("./routes");
const { default: express } = await import("express");
const fixture = JSON.parse(readFileSync(join(root, "server/fixtures/offline-model-results.json"), "utf8"));
const results: { id: string; name: string; model: string; status: string }[] = fixture.results;

function calls(): { model: string; scenario: string }[] {
  return existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function resetTrace() { writeFileSync(trace, ""); }

function installTestDouble(c: InstanceType<typeof CohortConsole>) {
  c.call = async (model: string, prompt: string, generation: number, timeoutMs = 80000): Promise<string> => {
    const row = results.find(item => item.model === model);
    if (!row) {
      throw new AdapterFailure("MODEL_UNAVAILABLE", `Unknown model ${model}`, null, false);
    }
    const scenario = process.env.OFFLINE_FIXTURE_SCENARIO || "mixed";
    appendFileSync(trace, JSON.stringify({ model: row.model, scenario }) + "\n");

    if (scenario === "pending") {
      const end = Date.now() + Math.min(timeoutMs, 30000);
      while (Date.now() < end) {
        if (generation !== c.generation) {
          throw new Error("Cancelled");
        }
        await delay(20);
      }
      if (timeoutMs <= 30000) {
        throw new AdapterFailure("TIMEOUT", "Turn time budget reached", null, true);
      }
      return "OK";
    }

    if (scenario === "invalid-json") {
      throw new AdapterFailure("INVALID_RESPONSE", "Invalid adapter response", null, false);
    }

    if (scenario === "empty") {
      throw new AdapterFailure("EMPTY_RESPONSE", "Empty provider response", null, false);
    }

    if (scenario === "unknown") {
      throw new AdapterFailure("TRANSPORT_ERROR", "Unknown RPC error", "UNKNOWN", false);
    }

    if (scenario === "timeout") {
      throw new AdapterFailure("TIMEOUT", "Deadline exceeded", "DEADLINE_EXCEEDED", true);
    }

    if (scenario === "mixed") {
      if (row.status === "OK") {
        return "OK";
      } else {
        throw new AdapterFailure("ACCESS_DENIED", "Permission denied", "PERMISSION_DENIED", false);
      }
    }

    throw new Error(`Unknown offline fixture scenario: ${scenario}`);
  };
}

function fresh() {
  storage.saveCohort({ entries: [], running: false, busy: null, round: 0, limit: 7, error: null,
    statuses: {}, budget: { windowStart: Date.now(), attempts: 0 }, adapterDiagnostics: {} });
  const c = new CohortConsole();
  installTestDouble(c);
  return c;
}

async function waitFor(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < end, "Offline test condition timed out");
    await delay(10);
  }
}

after(() => {
  cohortConsole.pause();
  delete (cohortConsole as any).call;
  process.env.PATH = originalPath;
  delete process.env.OFFLINE_FIXTURE_TRACE;
  delete process.env.OFFLINE_FIXTURE_SCENARIO;
});

test("seven exact fixture models check exact models, zero dispatch to blocked slots, and diagnostic fields", async () => {
  assert.equal(fixture.runtimeModel, null, "Offline results must never name an executed model");
  assert.deepEqual(results.map(({ id, model }) => ({ id, model })), foundingCohort.map(({ id, model }) => ({ id, model })));
  const c = fresh();
  // Keep one signed report so probes must preserve existing signatures and identities.
  c.append("continuity", "contribution-report", "Offline retained report fixture", "offline fixture");
  const retained = JSON.stringify(c.state.entries);
  const identities = c.summary().members.map(member => member.uuaid);
  resetTrace();
  c.state.probing = true;
  c.state.probeProgress = 0;
  await c.probe(c.generation);
  // L10 zero-dispatch gate blocks sustainability and integration ahead of transport;
  // the remaining 5 unblocked models are dispatched to the offline test double.
  const expectedDispatches = results
    .filter(row => row.id !== "sustainability" && row.id !== "integration")
    .map(row => row.model);
  assert.deepEqual(calls().map(call => call.model), expectedDispatches);
  assert.equal(calls().some(call => call.model === "gemini_3_8_flash" || call.model === "gpt_5_6_terra"), false, "Blocked slots receive zero dispatches");
  assert.equal(c.state.budget!.attempts, 7);
  assert.equal(c.state.probeProgress, 7);
  assert.equal(c.state.probing, false);
  assert.equal(c.state.busy, null);
  assert.equal(JSON.stringify(c.state.entries), retained);
  assert.deepEqual(c.summary().members.map(member => member.uuaid), identities);
  assert.equal(c.summary().verified, true);
  for (const row of results) {
    const d = c.state.adapterDiagnostics![row.id];
    assert.equal(d.model, row.model);
    assert(Number.isFinite(Date.parse(d.checkedAt)));
    assert.equal(d.available, row.status === "OK");
    if (row.status === "OK") {
      assert.equal(d.code, "OK");
      assert.equal(d.transportStatus, null);
    } else if (row.id === "sustainability" || row.id === "integration") {
      assert.equal(d.code, "MODEL_UNAVAILABLE", "L10 zero-dispatch gate sets MODEL_UNAVAILABLE for blocked slots");
      assert.equal(d.transportStatus, null);
    } else {
      assert.equal(d.code, "ACCESS_DENIED");
      assert.equal(d.transportStatus, "PERMISSION_DENIED");
    }
    assert.equal(d.retryable, false);
    assert(d.message.length > 0);
    // Note: no-leak privacy property is tested in l10-r9 via static parse failure reasons; vacuous legacy fixture-only string checks removed.
  }
  const reloaded = new CohortConsole();
  assert.deepEqual(reloaded.state.adapterDiagnostics, c.state.adapterDiagnostics);
  assert.equal(JSON.stringify(reloaded.state.entries), retained);
  assert.equal(Object.values(c.state.adapterDiagnostics!).filter(d => d.available).length, 3);
});

test("fresh denials skip, explicit probes retry, and the one-hour boundary expires", async () => {
  const c = fresh();
  c.state.probing = true;
  await c.probe(c.generation);
  resetTrace();
  c.state.running = true;
  await c.run(c.generation);
  assert.deepEqual(calls().map(call => call.model), results.filter(row => row.status === "OK").map(row => row.model));
  assert.equal(c.state.budget!.attempts, 10);
  assert.equal(c.state.entries.length, 3);
  for (const row of results.filter(row => row.status !== "OK")) assert.equal(c.state.statuses[row.id], "adapter blocked");
  const retained = JSON.stringify(c.state.entries);
  resetTrace();
  c.state.probing = true;
  c.state.probeProgress = 0;
  await c.probe(c.generation);
  assert.equal(calls().length, 5, "Explicit checks must remain available for freshly denied unblocked models");
  assert.equal(c.state.probeProgress, 7, "All 7 slots probed");
  assert.equal(JSON.stringify(c.state.entries), retained);
  // Deterministic clock: just before expiry no denied call; at expiry all unblocked models retried.
  const realNow = Date.now;
  const observed = realNow();
  const append = c.append;
  const boundaryAppends: string[] = [];
  // Only the expiry predicate uses a synthetic future clock. Do not persist
  // future-dated ContinuityMemory records, which correctly fail integrity gates.
  c.append = (agent: string) => { boundaryAppends.push(agent); };
  for (const row of results) c.state.adapterDiagnostics![row.id].checkedAt = new Date(observed).toISOString();
  try {
    Date.now = () => observed + 3599999;
    resetTrace(); c.state.running = true;
    await c.run(c.generation);
    assert.equal(calls().length, 3);
    Date.now = () => observed + 3600000;
    resetTrace(); c.state.running = true;
    await c.run(c.generation);
    assert.equal(calls().length, 5, "At expiry, unblocked models are retried");
    assert.equal(boundaryAppends.length, 6, "Only three successes append in each boundary run");
    assert.equal(c.state.entries.length, 3, "Boundary spy must not persist future-dated fixture records");
  } finally { Date.now = realNow; c.append = append; }
  assert.equal(c.summary().verified, true);
});

test("HTTP start/probe concurrent requests return 400 and cancel fences a pending call", async () => {
  const c = cohortConsole;
  installTestDouble(c);
  const pristine = fresh();
  c.state = pristine.state;
  c.memories = pristine.memories;
  assert.equal(c.summary().verified, true, "HTTP fixture must begin with valid continuity");
  process.env.OFFLINE_FIXTURE_SCENARIO = "pending";
  resetTrace();
  const app = express();
  app.use(express.json());
  const server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object" && address.address === "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body = {}) => fetch(`${base}/api/cohort/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const startedResponse = await post("probe");
    assert.equal(startedResponse.status, 200, JSON.stringify(await startedResponse.json()));
    await waitFor(() => calls().length === 1);
    const started = await (await fetch(`${base}/api/cohort`)).json() as any;
    assert.equal(started.probing, true);
    assert.equal(started.busy, "continuity");
    assert.equal(started.probeProgress, 0);
    for (const [path, body] of [["probe", {}], ["start", { limit: 7 }], ["import", {}]] as const) {
      const response = await post(path, body);
      assert.equal(response.status, 400);
      assert.match((await response.json() as any).message, /already running|Pause/);
    }
    assert.equal((await post("pause")).status, 200);
    await delay(300); // cancellation interval checks every 200 ms
    assert.equal(c.state.probing, false);
    assert.equal(c.state.running, false);
    assert.equal(c.state.busy, null);
    assert.equal(c.state.entries.length, 0);
    assert.deepEqual(c.state.adapterDiagnostics, {});
    assert.equal(calls().length, 1);
    assert.equal(c.state.budget!.attempts, 1);
    // Control: the same endpoints accept new work when the prior run is paused.
    process.env.OFFLINE_FIXTURE_SCENARIO = "mixed";
    assert.equal((await post("probe")).status, 200);
    await waitFor(() => c.state.probing === false);
    assert.equal(c.state.probeProgress, 7);
    assert.equal((await post("start", { limit: 7 })).status, 200);
    await waitFor(() => c.state.running === false);
    assert.equal(c.state.entries.length, 3);
  } finally {
    c.pause();
    delete (cohortConsole as any).call;
    process.env.OFFLINE_FIXTURE_SCENARIO = "mixed";
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("unknown/empty/malformed failures create no turns and timeout remains retryable", async () => {
  const c = fresh();
  c.state.limit = 1;
  for (const [scenario, expected] of [["unknown", "TRANSPORT_ERROR"], ["empty", "EMPTY_RESPONSE"], ["invalid-json", "INVALID_RESPONSE"], ["timeout", "TIMEOUT"]]) {
    process.env.OFFLINE_FIXTURE_SCENARIO = scenario;
    c.state.running = true;
    await c.run(c.generation);
    assert.equal(c.state.entries.length, 0);
    assert.equal(c.state.adapterDiagnostics!.continuity.code, expected);
    assert.equal(c.state.adapterDiagnostics!.continuity.available, false);
    assert.equal(c.state.adapterDiagnostics!.continuity.retryable, scenario === "timeout");
    // Note: no-leak privacy property is tested in l10-r9 via static parse failure reasons; vacuous legacy fixture-only string check removed.
  }
  process.env.OFFLINE_FIXTURE_SCENARIO = "pending";
  await assert.rejects(c.call(foundingCohort[0].model, "Offline timeout fixture", c.generation, 100),
    (error: any) => error.code === "TIMEOUT" && error.retryable === true);
  process.env.OFFLINE_FIXTURE_SCENARIO = "mixed";
  c.state.budget!.attempts = 100;
  resetTrace(); c.state.probing = true;
  await c.probe(c.generation);
  assert.match(c.state.error!, /hourly attempt budget/);
  assert.equal(calls().length, 0);
  assert.equal(c.state.probing, false);
});

test("legacy Python preview bridge refuses unconditionally with zero child spawns", async () => {
  const unconfigured = new CohortConsole();
  const traceLen = calls().length;

  // 1. Blocked models refuse at the zero-dispatch gate ahead of transport selection
  await assert.rejects(
    unconfigured.call("gemini_3_8_flash", "prompt", 0),
    (err: any) => err.code === "MODEL_UNAVAILABLE" && err.retryable === false
  );
  await assert.rejects(
    unconfigured.call("gpt_5_6_terra", "prompt", 0),
    (err: any) => err.code === "MODEL_UNAVAILABLE" && err.retryable === false
  );

  // 2. Unblocked models refuse at the live accounting gate (closed legacy path)
  await assert.rejects(
    unconfigured.call("claude_fable_5_1", "prompt", 0),
    (err: any) => err.code === "LIMIT_UNSUPPORTED" && err.retryable === false
  );

  // 3. Zero child spawns recorded on legacy bridge
  assert.equal(calls().length, traceLen, "Zero child spawns recorded on legacy bridge");
});
