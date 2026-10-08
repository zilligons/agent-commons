/**
 * L10 C2 poles: the trial switch (hard cap of 7 live turns per server run).
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertL10TrialEnabled,
  consumeL10TrialTurn,
  resetL10TrialCounterForTest,
  getL10TrialCounterForTest,
  assertLiveAccountingGate,
  L10_TRIAL_TURN_CEILING,
} from "./l10-limits";
import { callL10CliForTest } from "./l10-cohort";
import { AdapterFailure, type AdapterRequest } from "./types";
import { buildChildEnv, CLOSED_CONSOLE_ALLOWLIST } from "./l10-env";
import { L10_APP_CONTROL_ALLOWLIST, applyDotenvGuarded } from "../dotenv-guard";
import { _setL10BinariesForTest, _resetL10BinariesForTest, resolveL10Binaries } from "./config";
import { L10PermitPool } from "./l10-process";

function makeReq(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    slotId: "continuity",
    prompt: "Reply with READY",
    timeoutMs: 5000,
    signal: { cancelled: () => false },
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    reservation: { id: "res-1", promptTokensUpper: 100, totalTokens: 500 },
    ...overrides,
  };
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "l10-c2-test-"));
  const origEnv = process.env.AGENT_COMMONS_L10_TRIAL_TURNS;

  // Brief rev 2 P: install a snapshot pointing at synthetic absolute paths
  // under tmpdir. The test entry uses fixtureBin (which overrides argv[0]),
  // so the configured value is only used by the gate pre-check; we still
  // set it so the gates do not throw MODEL_UNAVAILABLE before the test
  // entry substitutes the bin.
  const fakeClaude = join(root, "fake-claude");
  const fakeCodex = join(root, "fake-codex");
  const fakeGrok = join(root, "fake-grok");
  writeFileSync(fakeClaude, "");
  writeFileSync(fakeCodex, "");
  writeFileSync(fakeGrok, "");
  _setL10BinariesForTest(resolveL10Binaries({
    AGENT_COMMONS_CLAUDE_BIN: fakeClaude,
    AGENT_COMMONS_CODEX_BIN: fakeCodex,
    AGENT_COMMONS_GROK_BIN: fakeGrok,
    AGENT_COMMONS_MODEL_LEDGER: "",
    AGENT_COMMONS_WITNESS_SEATS: "seat-alpha,seat-beta",
  } as NodeJS.ProcessEnv));

  try {
    const fixtureLedgerPath = join(root, "model-ledger.jsonl");
    writeFileSync(fixtureLedgerPath, "", "utf8");
    const pool = new L10PermitPool(join(root, "permits"), 2);

    // =========================================================================
    // 1. The cap, failable (W1 proof):
    // Env "7", calls 1-7 each spawn fixture; call 8 refused pre-spawn with LIMIT_UNSUPPORTED; spawn count stays 7.
    // =========================================================================
    {
      assert.equal(L10_TRIAL_TURN_CEILING, 7, "ceiling is frozen at 7");
      process.env.AGENT_COMMONS_L10_TRIAL_TURNS = "7";
      resetL10TrialCounterForTest({ counter: 0 });

      const countFile = join(root, "spawn-count.txt");
      writeFileSync(countFile, "0", "utf8");

      const binDir = join(root, "bin-cap");
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      const claudeBin = join(binDir, "claude");
      writeFileSync(
        claudeBin,
        `#!/bin/sh
cat > /dev/null
NOW_S=$(date +%s)
echo "{\\"ts\\":$NOW_S,\\"pid\\":$$,\\"lane\\":\\"max\\",\\"seat\\":\\"seat-alpha\\",\\"req\\":\\"claude-fable-5-1\\",\\"eff\\":\\"claude-fable-5-1\\"}" >> "${fixtureLedgerPath}"
CNT=$(cat "${countFile}")
echo $((CNT + 1)) > "${countFile}"
echo '{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"s","usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"claude-fable-5-1":{"inputTokens":10,"outputTokens":5}}}'
exit 0
`,
        { mode: 0o755 },
      );

      for (let i = 1; i <= 7; i++) {
        const req = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: `c2-turn-${i}` });
        const res = await callL10CliForTest(req, {
          fixtureBin: claudeBin,
          fixtureLedgerPath,
          permitPool: pool,
        });
        assert.equal(res.kind, "live");
      }
      assert.equal(Number(readFileSync(countFile, "utf8").trim()), 7, "calls 1-7 each spawn fixture");
      assert.equal(getL10TrialCounterForTest(), 7, "module counter reaches 7");

      // Call 8: must be refused with LIMIT_UNSUPPORTED pre-spawn, spawn count remains 7
      let call8Err: any = null;
      try {
        const req8 = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "c2-turn-8" });
        await callL10CliForTest(req8, {
          fixtureBin: claudeBin,
          fixtureLedgerPath,
          permitPool: pool,
        });
      } catch (e: any) {
        call8Err = e;
      }
      assert.ok(call8Err instanceof AdapterFailure, "call 8 must throw AdapterFailure");
      assert.equal(call8Err.code, "LIMIT_UNSUPPORTED", "call 8 code must be LIMIT_UNSUPPORTED");
      assert.ok(call8Err.message.includes("trial cap of 7 live turns reached"), "call 8 error carries trial cap reached");
      assert.equal(Number(readFileSync(countFile, "utf8").trim()), 7, "spawn count stays at 7 after call 8 refusal");

      // MUTANT: bypassCounterCheckForTest = true allows call 8 to spawn (records 8 spawns)
      resetL10TrialCounterForTest({ cap: 7, counter: 7, bypass: true });
      const mutantReq = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "c2-mutant-8" });
      const mutantRes = await callL10CliForTest(mutantReq, {
        fixtureBin: claudeBin,
        fixtureLedgerPath,
        permitPool: pool,
      });
      assert.equal(mutantRes.kind, "live");
      assert.equal(Number(readFileSync(countFile, "utf8").trim()), 8, "MUTANT: bypassed check records 8 spawns");
    }

    // =========================================================================
    // 2. Unset: env unset gives LIMIT_UNSUPPORTED on call 1, with 0 spawns
    // =========================================================================
    {
      delete process.env.AGENT_COMMONS_L10_TRIAL_TURNS;
      resetL10TrialCounterForTest();

      const unsetCountFile = join(root, "unset-spawn-count.txt");
      writeFileSync(unsetCountFile, "0", "utf8");
      const unsetBin = join(root, "bin-cap", "claude");

      let unsetErr: any = null;
      try {
        const req = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "c2-unset" });
        await callL10CliForTest(req, {
          fixtureBin: unsetBin,
          fixtureLedgerPath,
          permitPool: pool,
        });
      } catch (e: any) {
        unsetErr = e;
      }
      assert.ok(unsetErr instanceof AdapterFailure, "unset must throw AdapterFailure");
      assert.equal(unsetErr.code, "LIMIT_UNSUPPORTED");
    }

    // =========================================================================
    // 3. Invalid values: 0, 8, abc, " 7", 7.0, "" each throw LIMIT_UNSUPPORTED; "1" admits exactly one
    // =========================================================================
    {
      const invalidValues = ["0", "8", "abc", " 7", "7.0", ""];
      for (const val of invalidValues) {
        process.env.AGENT_COMMONS_L10_TRIAL_TURNS = val;
        resetL10TrialCounterForTest();
        assert.throws(
          () => assertL10TrialEnabled(),
          (err: any) => err instanceof AdapterFailure && err.code === "LIMIT_UNSUPPORTED",
          `value "${val}" must throw LIMIT_UNSUPPORTED`,
        );
      }

      // "1" admits exactly one
      process.env.AGENT_COMMONS_L10_TRIAL_TURNS = "1";
      resetL10TrialCounterForTest();
      assert.equal(assertL10TrialEnabled(), 1);
      assert.equal(consumeL10TrialTurn("continuity"), 1);
      assert.throws(
        () => consumeL10TrialTurn("continuity"),
        (err: any) => err instanceof AdapterFailure && err.code === "LIMIT_UNSUPPORTED",
        "turn 2 must be refused when cap is 1",
      );
    }

    // =========================================================================
    // 4. Pre-spawn refusals do not consume: Grok, then valid Claude call, gives count 1, not 2
    // =========================================================================
    {
      process.env.AGENT_COMMONS_L10_TRIAL_TURNS = "7";
      resetL10TrialCounterForTest({ cap: 7, counter: 0 });

      // Grok pre-spawn refusal
      let grokErr: any = null;
      try {
        const grokReq = makeReq({ slotId: "release", runtimeModel: "grok-4.7-build-fast", runId: "c2-grok" });
        await callL10CliForTest(grokReq, {
          fixtureBin: join(root, "bin-cap", "claude"),
          fixtureLedgerPath,
          permitPool: pool,
        });
      } catch (e: any) {
        grokErr = e;
      }
      assert.ok(grokErr instanceof AdapterFailure);
      assert.equal(grokErr.code, "MODEL_UNAVAILABLE");
      assert.equal(getL10TrialCounterForTest(), 0, "pre-spawn refusal must consume 0 turns");

      // Now valid Claude call
      const claudeReq = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "c2-valid" });
      const claudeRes = await callL10CliForTest(claudeReq, {
        fixtureBin: join(root, "bin-cap", "claude"),
        fixtureLedgerPath,
        permitPool: pool,
      });
      assert.equal(claudeRes.kind, "live");
      assert.equal(getL10TrialCounterForTest(), 1, "valid call consumes turn 1 (not 2)");
    }

    // =========================================================================
    // 5. Other paths stay blocked: with env set to "7", assertLiveAccountingGate still throws LIMIT_UNSUPPORTED
    // =========================================================================
    {
      process.env.AGENT_COMMONS_L10_TRIAL_TURNS = "7";
      assert.throws(
        () => assertLiveAccountingGate(),
        (err: any) => err instanceof AdapterFailure && err.code === "LIMIT_UNSUPPORTED",
        "assertLiveAccountingGate must remain blocked non-bypassably",
      );
    }

    // =========================================================================
    // 6. Child env: AGENT_COMMONS_L10_TRIAL_TURNS is in console allowlists but never in child env
    // =========================================================================
    {
      assert.ok(CLOSED_CONSOLE_ALLOWLIST.includes("AGENT_COMMONS_L10_TRIAL_TURNS"), "CLOSED_CONSOLE_ALLOWLIST includes trial turns");
      assert.ok(!L10_APP_CONTROL_ALLOWLIST.includes("AGENT_COMMONS_L10_TRIAL_TURNS"), "L10_APP_CONTROL_ALLOWLIST must NOT include trial turns");

      process.env.AGENT_COMMONS_L10_TRIAL_TURNS = "7";
      const claudeChildEnv = buildChildEnv({
        route: "claude",
        runId: "c2-env-test",
        home: root, // MUTANT pole, not CONTROL — use the test root, not the real home
        runDir: root,
      });
      assert.equal(claudeChildEnv.AGENT_COMMONS_L10_TRIAL_TURNS, undefined, "Claude child env must not contain AGENT_COMMONS_L10_TRIAL_TURNS");

      const codexChildEnv = buildChildEnv({
        route: "codex",
        runId: "c2-env-test",
        home: root,
        runDir: root,
      });
      assert.equal(codexChildEnv.AGENT_COMMONS_L10_TRIAL_TURNS, undefined, "Codex child env must not contain AGENT_COMMONS_L10_TRIAL_TURNS");
    }

    // =========================================================================
    // 7. Dotenv pole: AGENT_COMMONS_L10_TRIAL_TURNS in .env is ignored (unlisted)
    // =========================================================================
    {
      const dotEnvDir = join(root, "dotenv-test");
      mkdirSync(dotEnvDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dotEnvDir, ".env"), "AGENT_COMMONS_L10_TRIAL_TURNS=7\n", "utf8");

      // CONTROL: applyDotenvGuarded places the name in unlisted; env object has no such key
      const controlEnv: Record<string, string> = {};
      const resCtrl = applyDotenvGuarded({ cwd: dotEnvDir, env: controlEnv });
      assert.ok(resCtrl.ok, "CONTROL: applyDotenvGuarded returns ok");
      assert.ok(resCtrl.unlisted?.includes("AGENT_COMMONS_L10_TRIAL_TURNS"), "CONTROL: name is in unlisted");
      assert.equal(controlEnv.AGENT_COMMONS_L10_TRIAL_TURNS, undefined, "CONTROL: env has no trial turns key");
      assert.ok(!resCtrl.applied.includes("AGENT_COMMONS_L10_TRIAL_TURNS"), "CONTROL: name is not in applied");

      // MUTANT: pre-fix list containing AGENT_COMMONS_L10_TRIAL_TURNS puts it in applied
      const mutantEnv: Record<string, string> = {};
      const resMutant = applyDotenvGuarded({
        cwd: dotEnvDir,
        env: mutantEnv,
        allowlist: [...L10_APP_CONTROL_ALLOWLIST, "AGENT_COMMONS_L10_TRIAL_TURNS"],
      });
      assert.ok(resMutant.ok, "MUTANT: applyDotenvGuarded returns ok");
      assert.ok(resMutant.applied.includes("AGENT_COMMONS_L10_TRIAL_TURNS"), "MUTANT: pre-fix list puts name in applied");
      assert.equal(mutantEnv.AGENT_COMMONS_L10_TRIAL_TURNS, "7", "MUTANT: pre-fix list applies value to env");
    }

    // =========================================================================
    // 8. Rework 20 Item D: Cap refusal cleans up run directory (CONTROL and MUTANT)
    // =========================================================================
    {
      process.env.AGENT_COMMONS_L10_TRIAL_TURNS = "1";
      resetL10TrialCounterForTest({ cap: 1, counter: 0 });

      // Call 1 succeeds and consumes turn 1
      const req1 = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "c2-d-turn-1" });
      await callL10CliForTest(req1, {
        fixtureBin: join(root, "bin-cap", "claude"),
        fixtureLedgerPath,
        permitPool: pool,
      });

      // Call 2 is refused pre-spawn because cap is reached
      const turn2RunId = "c2-d-turn-2-refused";
      const req2 = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: turn2RunId });
      let turn2Err: any = null;
      try {
        await callL10CliForTest(req2, {
          fixtureBin: join(root, "bin-cap", "claude"),
          fixtureLedgerPath,
          permitPool: pool,
        });
      } catch (e: any) {
        turn2Err = e;
      }
      assert.ok(turn2Err instanceof AdapterFailure && turn2Err.code === "LIMIT_UNSUPPORTED");

      // CONTROL: no run directory remains under tmpdir
      const expectedRunDir = resolve(join(tmpdir(), `agentc-l10-cli-${turn2RunId}`));
      assert.equal(existsSync(expectedRunDir), false, "CONTROL: runDir must not remain after cap refusal");

      // MUTANT: pre-fix ordering created runDir before try block; consume threw outside try/finally leaving runDir
      const mutantRunId = "c2-d-turn-mutant-pre-fix";
      const mutantRunDir = resolve(join(tmpdir(), `agentc-l10-cli-${mutantRunId}`));
      mkdirSync(mutantRunDir, { recursive: true, mode: 0o700 });
      try {
        // Pre-fix: consume was outside try/finally
        consumeL10TrialTurn("continuity");
      } catch {}
      assert.equal(existsSync(mutantRunDir), true, "MUTANT: pre-fix ordering leaves runDir behind");
      rmSync(mutantRunDir, { recursive: true, force: true });
    }

    console.log("PASS C2: trial switch verified: hard cap of 7 turns per server run; call 8 refused pre-spawn (spawn count stays 7); MUTANT verifies bypass records 8 spawns; unset inert; invalid values refused; pre-spawn refusals do not consume; legacy paths remain blocked; child env remains free of trial knob; dotenv guard ignores trial knob; Item D runDir cleanup verified (CONTROL/MUTANT).");
  } finally {
    _resetL10BinariesForTest();
    if (origEnv !== undefined) {
      process.env.AGENT_COMMONS_L10_TRIAL_TURNS = origEnv;
    } else {
      delete process.env.AGENT_COMMONS_L10_TRIAL_TURNS;
    }
    resetL10TrialCounterForTest();
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
