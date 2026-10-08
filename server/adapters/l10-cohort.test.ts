/**
 * L10 C1 — cohort adapter `l10-cli` tests (offline, fixtures only).
 *
 * Verifies:
 * - CONTROL: l10-cli through a fixture binary via test entry with fixture ledger -> live-typed result
 * - MUTANT 1: accounting gate refuses at production adapter (inert by default)
 * - MUTANT 2: non-frozen runtimeModel is refused with MODEL_UNAVAILABLE
 * - MUTANT 3: Terra, Prism, and Grok refused with zero dispatch
 * - MUTANT 4: missing ledger row gives ROUTE_WITNESS_MISSING
 * - MUTANT 5: envelope model mismatch gives MODEL_MISMATCH
 * - MUTANT 6: exit 75 (USAGE_WALL) and exit 76 (AUTH_BLOCKED) are terminal
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterFailure, type AdapterRequest } from "./types";
import { L10CliAdapter, callL10CliForTest } from "./l10-cohort";
import { L10PermitPool } from "./l10-process";
import { _setL10BinariesForTest, _resetL10BinariesForTest, resolveL10Binaries } from "./config";
import { L10_FROZEN_LITERALS } from "./l10-routes";

function makeReq(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  const slotId = overrides.slotId ?? "continuity";
  const frozen = L10_FROZEN_LITERALS[slotId as keyof typeof L10_FROZEN_LITERALS] ?? "claude-fable-5-1";
  return {
    slotId,
    historicalModel: overrides.historicalModel ?? "claude_fable_5_1",
    runtimeModel: overrides.runtimeModel ?? frozen,
    prompt: overrides.prompt ?? "Say READY",
    timeoutMs: overrides.timeoutMs ?? 5000,
    signal: overrides.signal ?? { cancelled: () => false },
    runId: overrides.runId ?? `test-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    callId: overrides.callId ?? "call-1",
    limits: overrides.limits ?? { maxCompletionTokens: 1000, maxTotalTokens: 2000, maxCliModelCalls: 1 },
    reservation: overrides.reservation ?? { id: "res-1", promptTokensUpper: 100, totalTokens: 500 },
    ...overrides,
  };
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "l10-cohort-test-"));

  // Brief rev 2 P: install a snapshot pointing at synthetic absolute paths
  // under tmpdir. The test entry uses fixtureBin / fixtureLedgerPath which
  // override the configured value, so this is just so the gates do not
  // throw MODEL_UNAVAILABLE before the test entry substitutes the bin.
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
    // CONTROL: l10-cli through a fixture binary via test entry with fixture ledger row -> live-typed result
    // =========================================================================
    {
      const binDir = join(root, "bin-ctrl");
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      const claudeBin = join(binDir, "claude");
      writeFileSync(
        claudeBin,
        `#!/bin/sh
cat > /dev/null
NOW_SEC=$(date +%s)
echo "{\\"ts\\":$NOW_SEC,\\"pid\\":$$,\\"lane\\":\\"max\\",\\"seat\\":\\"seat-alpha\\",\\"req\\":\\"claude-fable-5-1\\",\\"eff\\":\\"claude-fable-5-1\\"}" >> "${fixtureLedgerPath}"
echo '{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"s","usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"claude-fable-5-1":{"inputTokens":10,"outputTokens":5}}}'
exit 0
`,
        { mode: 0o755 },
      );

      const req = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1" });
      const res = await callL10CliForTest(req, {
        fixtureBin: claudeBin,
        fixtureLedgerPath,
        skipAccountingGate: true,
        permitPool: pool,
      });

      assert.equal(res.kind, "live", "CONTROL: kind must be live");
      assert.equal(res.actualModel, "claude-fable-5-1", "CONTROL: actualModel must match");
      assert.equal(res.text, "READY", "CONTROL: text must match");
      assert.equal(res.modelEvidence.source, "cli-envelope", "CONTROL: evidence source must be cli-envelope");
      assert.equal(res.modelEvidence.fieldPath, "modelUsage", "CONTROL: evidence fieldPath must be modelUsage");
      assert.ok(res.usage, "CONTROL: usage must be present");
      assert.equal(res.usage?.promptTokens, 10, "CONTROL: promptTokens must match");
      assert.equal(res.usage?.completionTokens, 5, "CONTROL: completionTokens must match");
      assert.equal(res.usage?.totalTokens, 15, "CONTROL: totalTokens must match");
      assert.equal(res.usage?.coversInternalCalls, true, "CONTROL: coversInternalCalls must be true");
      assert.equal(res.metrics.exitCode, 0, "CONTROL: exitCode must be 0");
    }

    // =========================================================================
    // Codex CONTROL: governance slot through fixture binary
    // =========================================================================
    {
      const binDir = join(root, "bin-codex");
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      const codexBin = join(binDir, "codex");
      writeFileSync(
        codexBin,
        `#!/bin/sh
cat > /dev/null
echo '{"model":"gpt-6.1-sol","text":"CODEX_OK","usage":{"prompt_tokens":12,"completion_tokens":6,"covers_internal_calls":true}}'
exit 0
`,
        { mode: 0o755 },
      );

      const req = makeReq({ slotId: "governance", runtimeModel: "gpt-6.1-sol" });
      const res = await callL10CliForTest(req, {
        fixtureBin: codexBin,
        skipAccountingGate: true,
      });

      assert.equal(res.kind, "live", "Codex CONTROL: kind must be live");
      assert.equal(res.actualModel, "gpt-6.1-sol", "Codex CONTROL: actualModel must match");
      assert.equal(res.text, "CODEX_OK", "Codex CONTROL: text must match");
      assert.equal(res.metrics.exitCode, 0, "Codex CONTROL: exitCode must be 0");
    }

    // =========================================================================
    // CONTROL (Codex JSONL): l10-cli extracts agent_message text from JSONL stream
    // =========================================================================
    {
      const binDir = join(root, "bin-codex-jsonl");
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      const codexBin = join(binDir, "codex");
      writeFileSync(
        codexBin,
        `#!/bin/sh
cat > /dev/null
echo '{"type":"turn.started","model":"gpt-6.1-sol"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"READY"}}'
echo '{"type":"turn.completed","model":"gpt-6.1-sol"}'
exit 0
`,
        { mode: 0o755 },
      );

      const req = makeReq({ slotId: "governance", runtimeModel: "gpt-6.1-sol" });
      const res = await callL10CliForTest(req, {
        fixtureBin: codexBin,
        skipAccountingGate: true,
      });

      assert.equal(res.kind, "live", "Codex JSONL CONTROL: kind must be live");
      assert.equal(res.actualModel, "gpt-6.1-sol", "Codex JSONL CONTROL: actualModel must match");
      assert.equal(res.text, "READY", "Codex JSONL CONTROL: text must extract READY from agent_message item");
      assert.equal(res.metrics.exitCode, 0, "Codex JSONL CONTROL: exitCode must be 0");
    }

    // =========================================================================
    // MUTANT 1: accounting gate refuses at production adapter (inert by default)
    // =========================================================================
    {
      const adapter = new L10CliAdapter();
      const req = makeReq({ slotId: "continuity" });
      let err: any = null;
      try {
        await adapter.call(req);
      } catch (e: any) {
        err = e;
      }
      assert.ok(err instanceof AdapterFailure, "MUTANT 1: production call must throw AdapterFailure");
      assert.equal(
        err.code,
        "LIMIT_UNSUPPORTED",
        "MUTANT 1: must fail closed at accounting gate",
      );
    }

    // =========================================================================
    // MUTANT 2: non-frozen runtimeModel is refused with MODEL_UNAVAILABLE
    // =========================================================================
    {
      const req = makeReq({ slotId: "continuity", runtimeModel: "gpt-4-turbo" });
      let err: any = null;
      try {
        await callL10CliForTest(req, { skipAccountingGate: true });
      } catch (e: any) {
        err = e;
      }
      assert.ok(err instanceof AdapterFailure, "MUTANT 2: must throw AdapterFailure");
      assert.equal(err.code, "MODEL_UNAVAILABLE", "MUTANT 2: code must be MODEL_UNAVAILABLE");
      assert.ok(err.message.includes("differs from frozen literal"), "MUTANT 2: message must note difference");
    }

    // =========================================================================
    // MUTANT 3: Terra, Prism and Grok refused with zero dispatch
    // =========================================================================
    {
      let dispatched = false;
      const binDir = join(root, "bin-dispatch-check");
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      const trackBin = join(binDir, "claude");
      writeFileSync(trackBin, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

      // 3a: Terra (sustainability)
      let terraErr: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "sustainability", runtimeModel: "gpt_5_6_terra" }), {
          fixtureBin: trackBin,
          skipAccountingGate: true,
        });
      } catch (e: any) {
        terraErr = e;
      }
      assert.ok(terraErr instanceof AdapterFailure, "MUTANT 3a: Terra must throw AdapterFailure");
      assert.equal(terraErr.code, "MODEL_UNAVAILABLE", "MUTANT 3a: Terra code must be MODEL_UNAVAILABLE");

      // 3b: Prism (integration)
      let prismErr: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "integration", runtimeModel: "gemini_3_8_flash" }), {
          fixtureBin: trackBin,
          skipAccountingGate: true,
        });
      } catch (e: any) {
        prismErr = e;
      }
      assert.ok(prismErr instanceof AdapterFailure, "MUTANT 3b: Prism must throw AdapterFailure");
      assert.equal(prismErr.code, "MODEL_UNAVAILABLE", "MUTANT 3b: Prism code must be MODEL_UNAVAILABLE");

      // 3c: Grok (release)
      let grokErr: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "release", runtimeModel: "grok-4.7-build-fast" }), {
          fixtureBin: trackBin,
          skipAccountingGate: true,
        });
      } catch (e: any) {
        grokErr = e;
      }
      assert.ok(grokErr instanceof AdapterFailure, "MUTANT 3c: Grok must throw AdapterFailure");
      assert.equal(grokErr.code, "MODEL_UNAVAILABLE", "MUTANT 3c: Grok code must be MODEL_UNAVAILABLE");
      assert.ok(
        grokErr.message.includes("grok route blocked until its prompt/stdin precedence is established"),
        "MUTANT 3c: message must match C5 static text",
      );
    }

    // =========================================================================
    // MUTANT 4: missing ledger row gives ROUTE_WITNESS_MISSING
    // =========================================================================
    {
      const binDir = join(root, "bin-no-ledger");
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      const claudeBin = join(binDir, "claude");
      writeFileSync(
        claudeBin,
        `#!/bin/sh
cat > /dev/null
# Do NOT write to ledger
echo '{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"s","usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"claude-fable-5-1":{"inputTokens":10,"outputTokens":5}}}'
exit 0
`,
        { mode: 0o755 },
      );

      const req = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1" });
      let err: any = null;
      try {
        await callL10CliForTest(req, {
          fixtureBin: claudeBin,
          fixtureLedgerPath,
          skipAccountingGate: true,
          permitPool: pool,
        });
      } catch (e: any) {
        err = e;
      }
      assert.ok(err instanceof AdapterFailure, "MUTANT 4: must throw AdapterFailure");
      assert.equal(err.code, "ROUTE_WITNESS_MISSING", "MUTANT 4: code must be ROUTE_WITNESS_MISSING");
    }

    // =========================================================================
    // MUTANT 5: envelope model mismatch gives MODEL_MISMATCH
    // =========================================================================
    {
      const binDir = join(root, "bin-model-mismatch");
      mkdirSync(binDir, { recursive: true, mode: 0o755 });
      const claudeBin = join(binDir, "claude");
      writeFileSync(
        claudeBin,
        `#!/bin/sh
cat > /dev/null
NOW_SEC=$(date +%s)
echo "{\\"ts\\":$NOW_SEC,\\"pid\\":$$,\\"lane\\":\\"max\\",\\"seat\\":\\"seat-alpha\\",\\"req\\":\\"claude-fable-5-1\\",\\"eff\\":\\"claude-fable-5-1\\"}" >> "${fixtureLedgerPath}"
# Envelope returns different model in modelUsage
echo '{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"s","usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"claude-opus-5-5":{"inputTokens":10,"outputTokens":5}}}'
exit 0
`,
        { mode: 0o755 },
      );

      const req = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1" });
      let err: any = null;
      try {
        await callL10CliForTest(req, {
          fixtureBin: claudeBin,
          fixtureLedgerPath,
          skipAccountingGate: true,
          permitPool: pool,
        });
      } catch (e: any) {
        err = e;
      }
      assert.ok(err instanceof AdapterFailure, "MUTANT 5: must throw AdapterFailure");
      assert.equal(err.code, "MODEL_MISMATCH", "MUTANT 5: code must be MODEL_MISMATCH");
    }

    // =========================================================================
    // MUTANT 6: exit 75 (USAGE_WALL) and exit 76 (AUTH_BLOCKED) are terminal
    // =========================================================================
    {
      // 6a: Exit 75
      const binDir75 = join(root, "bin-exit-75");
      mkdirSync(binDir75, { recursive: true, mode: 0o755 });
      const bin75 = join(binDir75, "claude");
      writeFileSync(bin75, `#!/bin/sh\ncat > /dev/null\nexit 75\n`, { mode: 0o755 });

      let err75: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "continuity" }), {
          fixtureBin: bin75,
          fixtureLedgerPath,
          skipAccountingGate: true,
          permitPool: pool,
        });
      } catch (e: any) {
        err75 = e;
      }
      assert.ok(err75 instanceof AdapterFailure, "MUTANT 6a: must throw AdapterFailure");
      assert.equal(err75.code, "USAGE_WALL", "MUTANT 6a: code must be USAGE_WALL");
      assert.equal(err75.retryable, false, "MUTANT 6a: retryable must be false (terminal)");

      // 6b: Exit 76
      const binDir76 = join(root, "bin-exit-76");
      mkdirSync(binDir76, { recursive: true, mode: 0o755 });
      const bin76 = join(binDir76, "claude");
      writeFileSync(bin76, `#!/bin/sh\ncat > /dev/null\nexit 76\n`, { mode: 0o755 });

      let err76: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "continuity" }), {
          fixtureBin: bin76,
          fixtureLedgerPath,
          skipAccountingGate: true,
          permitPool: pool,
        });
      } catch (e: any) {
        err76 = e;
      }
      assert.ok(err76 instanceof AdapterFailure, "MUTANT 6b: must throw AdapterFailure");
      assert.equal(err76.code, "AUTH_BLOCKED", "MUTANT 6b: code must be AUTH_BLOCKED");
      assert.equal(err76.retryable, false, "MUTANT 6b: retryable must be false (terminal)");
    }

    // =========================================================================
    // MUTANT 7: callL10CliForTest without private permit pool throws SECURITY_VIOLATION
    // =========================================================================
    {
      const req = makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1" });
      let errMissing: any = null;
      try {
        await callL10CliForTest(req, {
          fixtureBin: join(root, "bin-ctrl", "claude"),
          fixtureLedgerPath,
          skipAccountingGate: true,
          // permitPool intentionally omitted
        });
      } catch (e: any) {
        errMissing = e;
      }
      assert.ok(errMissing instanceof AdapterFailure, "MUTANT 7: missing permitPool must throw AdapterFailure");
      assert.equal(errMissing.code, "SECURITY_VIOLATION", "MUTANT 7: code must be SECURITY_VIOLATION");
    }

    console.log("PASS: l10-cohort adapter (CONTROL, MUTANT 1 accounting gate inert, MUTANT 2 non-frozen model refused, MUTANT 3 Terra/Prism/Grok refused, MUTANT 4 witness missing, MUTANT 5 envelope mismatch, MUTANT 6 exit 75/76 terminal, MUTANT 7 private pool enforcement).");

    // =========================================================================
    // 8. Brief rev 4 R2: the Claude live route is ENABLED only when the
    // CLI binary, the model ledger, and the witness seats all resolve.
    // Any one missing DISABLES the Claude route at startup; the call
    // throws MODEL_UNAVAILABLE with the resolver's static reason. The
    // test entry uses fixtureBin / fixtureLedgerPath which override the
    // configured values, so the existing MUTANTs above keep working.
    // The R2 calls use a private permitPool + skipAccountingGate so the
    // trial cap (7 turns hit by the earlier MUTANTs) does not affect
    // the verdict.
    // =========================================================================
    {
      // For the seats-unset pole, the OTHER two (claude bin + model
      // ledger) must be valid so the route reaches the seats check.
      // We use a real ledger file (an empty one is fine; we never reach
      // the witness call because the route is disabled at the seats
      // check first).
      const validLedgerPath = join(root, "r2-valid-ledger.jsonl");
      writeFileSync(validLedgerPath, "");
      const r2Pool = new L10PermitPool(join(root, "r2-permits"), 2);
      const r2Knobs = { skipAccountingGate: true, permitPool: r2Pool };

      // MUTANT — seats unset (only claude bin + ledger configured): route disabled
      const seatless = resolveL10Binaries({
        AGENT_COMMONS_CLAUDE_BIN: fakeClaude,
        AGENT_COMMONS_CODEX_BIN: fakeCodex,
        AGENT_COMMONS_GROK_BIN: fakeGrok,
        AGENT_COMMONS_MODEL_LEDGER: validLedgerPath,
      } as NodeJS.ProcessEnv);
      _setL10BinariesForTest(seatless);
      let errSeats: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "r4-seats-unset" }), r2Knobs);
      } catch (e: any) {
        errSeats = e;
      }
      assert.ok(errSeats instanceof AdapterFailure, "R2: seats unset -> AdapterFailure");
      assert.equal(errSeats.code, "MODEL_UNAVAILABLE");
      assert.ok(/witness seats unset/.test(errSeats.message), `R2: seats unset reason: ${errSeats.message}`);

      // MUTANT — ledger unset (only claude bin + seats configured): route disabled
      const ledgerless = resolveL10Binaries({
        AGENT_COMMONS_CLAUDE_BIN: fakeClaude,
        AGENT_COMMONS_CODEX_BIN: fakeCodex,
        AGENT_COMMONS_GROK_BIN: fakeGrok,
        AGENT_COMMONS_MODEL_LEDGER: "",
        AGENT_COMMONS_WITNESS_SEATS: "seat-alpha,seat-beta",
      } as NodeJS.ProcessEnv);
      _setL10BinariesForTest(ledgerless);
      let errLedger: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "r4-ledger-unset" }), r2Knobs);
      } catch (e: any) {
        errLedger = e;
      }
      assert.ok(errLedger instanceof AdapterFailure, "R2: ledger unset -> AdapterFailure");
      assert.equal(errLedger.code, "MODEL_UNAVAILABLE");
      assert.ok(/model ledger (unset|empty)/.test(errLedger.message), `R2: ledger unset reason: ${errLedger.message}`);

      // MUTANT — claude bin unset (only ledger + seats configured): route disabled
      const binless = resolveL10Binaries({
        AGENT_COMMONS_CODEX_BIN: fakeCodex,
        AGENT_COMMONS_GROK_BIN: fakeGrok,
        AGENT_COMMONS_MODEL_LEDGER: validLedgerPath,
        AGENT_COMMONS_WITNESS_SEATS: "seat-alpha,seat-beta",
      } as NodeJS.ProcessEnv);
      _setL10BinariesForTest(binless);
      let errBin: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "r4-bin-unset" }), r2Knobs);
      } catch (e: any) {
        errBin = e;
      }
      assert.ok(errBin instanceof AdapterFailure, "R2: claude bin unset -> AdapterFailure");
      assert.equal(errBin.code, "MODEL_UNAVAILABLE");
      assert.ok(/claude bin unset/.test(errBin.message), `R2: claude bin unset reason: ${errBin.message}`);

      // MUTANT (regression): a refactor that returns NOT_EVALUATED on a
      // configured-but-missing ledger must go red here. The configured
      // ledger is present (a file with no rows, AND the fixture does
      // NOT write a matching row); the witness returns
      // ROUTE_WITNESS_MISSING (R2 fail closed). The test entry uses
      // fixtureBin (a real shell script that exits 0 with a valid
      // envelope but does NOT write a row to the ledger) so the spawn
      // actually runs and the witness sees the empty ledger.
      const emptyLedgerPath = join(root, "empty-ledger.jsonl");
      writeFileSync(emptyLedgerPath, "");
      const configured = resolveL10Binaries({
        AGENT_COMMONS_CLAUDE_BIN: fakeClaude,
        AGENT_COMMONS_CODEX_BIN: fakeCodex,
        AGENT_COMMONS_GROK_BIN: fakeGrok,
        AGENT_COMMONS_MODEL_LEDGER: emptyLedgerPath,
        AGENT_COMMONS_WITNESS_SEATS: "seat-alpha,seat-beta",
      } as NodeJS.ProcessEnv);
      _setL10BinariesForTest(configured);
      const r2BinDir = join(root, "r2-bin");
      mkdirSync(r2BinDir, { recursive: true, mode: 0o755 });
      const r2FixtureBin = join(r2BinDir, "claude");
      // Fixture exits 0 with a valid envelope but does NOT write to the
      // ledger. The witness sees an empty ledger -> ROUTE_WITNESS_MISSING.
      writeFileSync(r2FixtureBin, `#!/bin/sh
cat > /dev/null
echo '{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"s","usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"claude-fable-5-1":{"inputTokens":10,"outputTokens":5}}}'
exit 0
`, { mode: 0o755 });
      const r2KnobsWithBin = { ...r2Knobs, fixtureBin: r2FixtureBin, fixtureLedgerPath: emptyLedgerPath };
      let errConfigured: any = null;
      try {
        await callL10CliForTest(makeReq({ slotId: "continuity", runtimeModel: "claude-fable-5-1", runId: "r4-empty-ledger" }), r2KnobsWithBin);
      } catch (e: any) {
        errConfigured = e;
      }
      assert.ok(errConfigured instanceof AdapterFailure, "R2: configured-but-empty ledger -> AdapterFailure (not silent pass)");
      assert.equal(errConfigured.code, "ROUTE_WITNESS_MISSING", `R2: empty ledger -> ROUTE_WITNESS_MISSING (got ${errConfigured?.code})`);

      console.log("PASS: l10-cohort R2: Claude live route is ENABLED only when CLI binary + ledger + witness seats all resolve; witness fails closed (R2 + R3).");
    }
  } finally {
    _resetL10BinariesForTest();
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error("FAIL l10-cohort:", e);
  process.exit(1);
});
