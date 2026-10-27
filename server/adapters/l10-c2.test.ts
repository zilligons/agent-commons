/** L10 C2 — obsolete trial-switch removal and guarded accounting admission. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as limits from "./l10-limits";
import { L10CliAdapter, callL10CliForTest } from "./l10-cohort";
import { AdapterFailure, type AdapterRequest } from "./types";
import { buildChildEnv, buildClosedConsoleEnv, CLOSED_CONSOLE_ALLOWLIST } from "./l10-env";
import { L10_APP_CONTROL_ALLOWLIST, applyDotenvGuarded } from "../dotenv-guard";

const obsoleteSwitch = "AGENT_COMMONS_L10_TRIAL_TURNS";
const isAccountingRefusal = (error: unknown): boolean =>
  error instanceof AdapterFailure && error.code === "LIMIT_UNSUPPORTED";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "l10-c2-test-"));
  const previous = process.env[obsoleteSwitch];
  try {
    // The obsolete counter, constant and reset/bypass APIs are gone entirely.
    assert.equal(typeof limits.assertLiveAccountingGate, "function");
    for (const name of [
      "assertL10TrialEnabled", "consumeL10TrialTurn", "resetL10TrialCounterForTest",
      "getL10TrialCounterForTest", "L10_TRIAL_TURN_CEILING",
    ]) {
      assert.equal(name in limits, false, `${name} must not remain exported`);
    }

    const req: AdapterRequest = {
      slotId: "continuity",
      runtimeModel: "claude-fable-5-1",
      prompt: "Reply with READY",
      timeoutMs: 5000,
      signal: { cancelled: () => false },
      runId: `c2-unmetered-${process.pid}-${Date.now()}`,
      reservation: { id: "res-1", promptTokensUpper: 100, totalTokens: 500 },
    };
    const adapter = new L10CliAdapter();
    for (const value of [undefined, "1", "7", "8", "999"]) {
      if (value === undefined) delete process.env[obsoleteSwitch];
      else process.env[obsoleteSwitch] = value;
      assert.throws(() => limits.assertLiveAccountingGate(), isAccountingRefusal);
      assert.throws(() => limits.assertLiveAccountingGate({ [obsoleteSwitch]: value }), isAccountingRefusal);
      await assert.rejects(adapter.call(req), isAccountingRefusal);
      await assert.rejects(callL10CliForTest(req), isAccountingRefusal);
    }
    // Admission refuses before creating the run directory or reaching a process route.
    assert.equal(existsSync(resolve(tmpdir(), `agentc-l10-cli-${req.runId}`)), false);
    for (const forged of [null, {}, { AGENT_COMMONS_L10_ACCOUNTING: "measured" }]) {
      await assert.rejects(adapter.call({ ...req, accountingPermit: forged as AdapterRequest["accountingPermit"] }), isAccountingRefusal);
    }

    // Neither the console, child environment nor dotenv accepts the removed switch.
    assert.ok(!new Set<string>(CLOSED_CONSOLE_ALLOWLIST).has(obsoleteSwitch));
    assert.ok(!L10_APP_CONTROL_ALLOWLIST.includes(obsoleteSwitch));
    const closed = buildClosedConsoleEnv({ PORT: "3000", [obsoleteSwitch]: "7" });
    assert.equal(closed.PORT, "3000");
    assert.equal(closed[obsoleteSwitch], undefined);
    process.env[obsoleteSwitch] = "7";
    for (const route of ["claude", "codex"] as const) {
      const child = buildChildEnv({ route, runId: "c2-env", home: root, runDir: root });
      assert.equal(child[obsoleteSwitch], undefined);
    }
    writeFileSync(join(root, ".env"), `PORT=3000\n${obsoleteSwitch}=7\n`, "utf8");
    const env: NodeJS.ProcessEnv = {};
    const result = applyDotenvGuarded({ cwd: root, env });
    assert.equal(result.ok, true);
    assert.equal(env.PORT, "3000");
    assert.equal(env[obsoleteSwitch], undefined);
    assert.ok(result.unlisted?.includes(obsoleteSwitch));

    console.log("PASS C2: obsolete trial APIs and environment switch removed; absent and forged accounting permits refused before dispatch; closed environments and dotenv exclude the old switch.");
  } finally {
    if (previous === undefined) delete process.env[obsoleteSwitch];
    else process.env[obsoleteSwitch] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error("FAIL:", error); process.exit(1); });
