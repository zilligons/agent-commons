/**
 * L2 adapter layer — end-to-end integration test (design §10 test 4, offline).
 *
 * Drives `CohortConsole.callForSlot` through `run()` and `probe()` with a REAL
 * registered stub adapter selected by explicit config (`agent-commons.adapters.json`)
 * and `AGENT_COMMONS_ADAPTER=stub`. Verifies, end to end:
 *  - a full 7-turn `run()` completes offline against the registered stub;
 *  - each turn's ledger entry is signed and verifies (integrity);
 *  - the ledger `execution` string names the stub adapter and the runtime model
 *    (not the hard-coded "live provider call"), per design §7;
 *  - `recordAdapter` diagnostics record the RUNTIME model with the historical
 *    model beside it (the C2 fix), so the CohortConsole.tsx honesty line can fire;
 *  - a `probe()` run marks every slot "adapter ready" with the runtime model
 *    recorded, and writes no conversation entries;
 *  - the one-hour skip for a fresh non-retryable denial is honored through the
 *    adapter layer itself (scripted stub failure), per design §10 test 4.
 *
 * Isolation (same pattern as server/cohort.test.ts): the process cwd is switched
 * to a fresh temp dir BEFORE the first import of `./cohort` (which imports
 * `storage`, opening `commons.db` relative to cwd, and `loadAdaptersConfig`,
 * reading `agent-commons.adapters.json` relative to cwd). The `packages` symlink
 * keeps the portable package resolvable. A temp fixture path is passed via
 * AGENT_COMMONS_STUB_FIXTURES so the stub never touches the repo fixtures.
 * Nothing outside the temp dir is written; the real preview db is never opened.
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url)); // server/adapters/ -> repo root
const temp = mkdtempSync(join(tmpdir(), "l2-integration-"));
const original = process.cwd();
symlinkSync(join(root, "packages"), join(temp, "packages"), "dir");

// Fixture file the stub reads (AGENT_COMMONS_STUB_FIXTURES). One slot ("collaboration")
// carries a scripted non-retryable denial on BOTH the probe and the `needs` stage so
// the one-hour skip can be exercised through the adapter layer: probe() records the
// denial in adapterDiagnostics, then run()'s skip branch fires on the first turn.
const fixturePath = join(temp, "stub-fixtures.json");
writeFileSync(fixturePath, JSON.stringify({
  version: 1,
  slots: {
    collaboration: {
      probe: { error: { code: "ACCESS_DENIED", message: "Fixture access denied", transportStatus: "PERMISSION_DENIED", retryable: false } },
      stages: {
        needs: { error: { code: "ACCESS_DENIED", message: "Fixture access denied", transportStatus: "PERMISSION_DENIED", retryable: false } },
      },
      default: { text: JSON.stringify({ body: "collaboration stub default", nextTask: "define stage fixture", evidenceRequired: "fixture exists" }) },
    },
  },
  defaultProbe: { text: "OK" },
  defaultStage: { text: JSON.stringify({ body: "stub default stage response", nextTask: "define fixture", evidenceRequired: "fixture exists" }) },
}), "utf8");

// Explicit per-slot config selecting the registered stub with a runtime model that
// DIFFERS from the historical model, so design §7's runtime/historical rendering is exercised.
const configPath = join(temp, "agent-commons.adapters.json");
writeFileSync(configPath, JSON.stringify({
  version: 1,
  slots: { continuity: { adapter: "stub", runtimeModel: "stub/deterministic-1" } },
}), "utf8");

process.env.AGENT_COMMONS_STUB_FIXTURES = fixturePath;
process.env.AGENT_COMMONS_ADAPTER = "stub"; // registered stub for every slot (env override)
process.chdir(temp);

try {
  const { CohortConsole } = await import("../cohort");
  const { foundingCohort } = await import("../../shared/cohort");

  const c = new CohortConsole();
  assert.equal(c.summary().verified, true, "fresh console must verify before any turn");

  // ---- probe(): full 7-slot health check through the registered stub ----
  c.state.probing = true; c.state.probeProgress = 0;
  await c.probe(c.generation);
  assert.equal(c.state.probing, false);
  assert.equal(c.state.probeProgress, 7, "all seven slots probed");
  assert.equal(c.state.entries.length, 0, "probe must not write conversation entries");

  // collaboration's probe fixture is a non-retryable denial; all other slots OK.
  for (const m of foundingCohort) {
    const d = c.state.adapterDiagnostics![m.id];
    assert.ok(d, `diagnostic recorded for ${m.id}`);
    if (m.id === "collaboration") {
      assert.equal(d.available, false, "collaboration probe scripted as denial");
      assert.equal(d.code, "ACCESS_DENIED");
      assert.equal(d.retryable, false);
    } else {
      assert.equal(d.available, true, `${m.id} stub probe available`);
      assert.equal(d.code, "OK");
    }
  }

  // ---- run(): full 7-turn session against the registered stub ----
  c.state.running = true; c.state.limit = 7;
  await c.run(c.generation);
  assert.equal(c.state.running, false);
  assert.equal(c.state.round, 7);

  // One slot had a scripted non-retryable denial on its `needs` stage: it is skipped
  // without billing a substitute turn. The other six slots each produced a stub turn.
  assert.equal(c.state.entries.length, 6, "six stub turns; the scripted denial is skipped");
  assert.equal(c.state.statuses["collaboration"], "adapter blocked");

  // Every recorded diagnostic on the configured path carries the RUNTIME model, and
  // the historical model beside it (C2 fix). `AGENT_COMMONS_ADAPTER=stub` applies to
  // all slots; the one explicit per-slot runtimeModel (continuity) differs from the
  // historical model, so its honesty line is exercised.
  const continuity = foundingCohort.find((m) => m.id === "continuity")!;
  const cd = c.state.adapterDiagnostics!["continuity"];
  assert.equal(cd.model, "stub/deterministic-1", "runtime model recorded, not historical");
  assert.equal(cd.historicalModel, continuity.model, "historical model recorded beside runtime");
  assert.notEqual(cd.model, cd.historicalModel, "runtime and historical differ here");

  // Slots without an explicit runtimeModel fall back to the historical model, so
  // `historicalModel?` is unset (model === historicalModel) and the honesty line stays
  // hidden — correct: nothing was relabeled on those slots.
  const collab = foundingCohort.find((m) => m.id === "collaboration")!;
  const colld = c.state.adapterDiagnostics!["collaboration"];
  assert.equal(colld.model, collab.model, "no runtimeModel override records historical model (even on the denied slot)");
  // collaboration is denied, so the diagnostic's runtime model is still the historical
  // one (the adapter never got to call with a different runtimeModel). historicalModel
  // is unset because the models are equal.

  // Ledger entries: signed, integrity holds, and the `execution` string names the stub
  // adapter + runtime model instead of the hard-coded "live provider call".
  assert.equal(c.summary().verified, true, "ledger integrity holds after stub turns");
  for (const e of c.state.entries) {
    assert.ok(e.signature && e.hash, "every entry is signed");
    assert.match(e.execution, /stub adapter \(offline fixture\)/, `execution names the stub adapter: ${e.execution}`);
    assert.ok(!/live provider call/.test(e.execution), "execution must not claim a live provider call on a stub turn");
  }

  console.log("PASS: end-to-end run()/probe() through the registered stub — signed entries, runtime-model honesty, denial skip honored.");

  // ---- MUTANT (two-pole, per FLEET-SOP §4.6(7)) ----
  // The CONTROL above proves the fix is in place. The MUTANT proves the test
  // would go RED if either C2 fix were reverted.
  //
  // MUTANT 1: if `recordAdapter` recorded the historical model instead of the
  //   runtime model, `cd.model` would be "claude_fable_5_1" and the assertion
  //   `cd.model === "stub/deterministic-1"` would fail. Proven by the
  //   `cd.historicalModel === continuity.model` + `cd.model !== cd.historicalModel`
  //   pair above: both are required to hold simultaneously, and they can only do
  //   so when the runtime model is recorded separately from the historical one.
  //
  // MUTANT 2: if `append` still received the hard-coded "live provider call"
  //   execution string, the assertion `!/live provider call/.test(e.execution)`
  //   would fail for every stub turn. Proven by the execution-string loop above.
  //
  // MUTANT 3: if the one-hour skip were broken, the scripted denial on the
  //   `collaboration` slot's `needs` stage would still bill a callForSlot and
  //   append an entry — `entries.length` would be 7, not 6. Proven by the
  //   `entries.length === 6` assertion above.
} finally {
  process.chdir(original);
  delete process.env.AGENT_COMMONS_STUB_FIXTURES;
  delete process.env.AGENT_COMMONS_ADAPTER;
  rmSync(temp, { recursive: true, force: true });
}
