/**
 * L10 — registry / offline kill switch tests (two-pole, per FLEET-SOP §4.6(7)).
 *
 * Covers (per design v3 §d + L2 design §6):
 * - AGENT_COMMONS_OFFLINE=1 blocks every `makesLiveCalls:true` adapter
 * - Unknown adapter name → MODEL_UNAVAILABLE
 *
 */
import assert from "node:assert/strict";
import { AdapterFailure, resolveAdapter, KNOWN_ADAPTERS } from "./index";

function main() {
  // CONTROL — KNOWN_ADAPTERS includes the names this slice tests.
  assert.ok(KNOWN_ADAPTERS.includes("preview-bridge"), "preview-bridge must be registered");
  assert.ok(KNOWN_ADAPTERS.includes("stub"), "stub must be registered");
  assert.ok(KNOWN_ADAPTERS.includes("l10-cli"), "l10-cli must be registered");

  // CONTROL — stub adapter resolves without OFFLINE flag.
  const prev = process.env.AGENT_COMMONS_OFFLINE;
  try {
    delete process.env.AGENT_COMMONS_OFFLINE;
    const stub = resolveAdapter("stub");
    assert.equal(stub.makesLiveCalls, false);
    const l10 = resolveAdapter("l10-cli");
    assert.equal(l10.makesLiveCalls, true);
  } finally {
    if (prev !== undefined) process.env.AGENT_COMMONS_OFFLINE = prev;
  }

  // MUTANT — preview-bridge and l10-cli makesLiveCalls=true; AGENT_COMMONS_OFFLINE=1
  // must refuse the resolution with AdapterFailure(MODEL_UNAVAILABLE).
  process.env.AGENT_COMMONS_OFFLINE = "1";
  try {
    assert.throws(() => resolveAdapter("preview-bridge"), (e: unknown) => {
      return e instanceof AdapterFailure
        && e.code === "MODEL_UNAVAILABLE"
        && /AGENT_COMMONS_OFFLINE=1/.test(e.message);
    }, "preview-bridge must be refused under AGENT_COMMONS_OFFLINE=1");
    assert.throws(() => resolveAdapter("l10-cli"), (e: unknown) => {
      return e instanceof AdapterFailure
        && e.code === "MODEL_UNAVAILABLE"
        && /AGENT_COMMONS_OFFLINE=1/.test(e.message);
    }, "l10-cli must be refused under AGENT_COMMONS_OFFLINE=1");
  } finally {
    if (prev === undefined) delete process.env.AGENT_COMMONS_OFFLINE;
    else process.env.AGENT_COMMONS_OFFLINE = prev;
  }

  // CONTROL — unknown adapter name → AdapterFailure(MODEL_UNAVAILABLE).
  assert.throws(() => resolveAdapter("not-a-real-adapter"), (e: unknown) => {
    return e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE";
  });

  console.log("PASS: registry (known names, offline blocks live, unknown name refused).");
}

main();