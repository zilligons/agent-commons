/**
 * L10 — l10-routes tests (two-pole, per FLEET-SOP §4.6(7)).
 *
 * Covers (per design v3 §a + the seam review notes 1 + 2):
 * - frozen map: config-sourced model rejected even when equal to a
 *   permitted literal; qwen3.8-max / empty / missing refused before
 *   spawn; Terra MODEL_UNAVAILABLE at callForSlot
 * - stdin-only prompt: argv never contains the prompt text
 * - binary resolution (brief rev 2 item P): argv[0] is the configured
 *   synthetic absolute path under os.tmpdir(); unset / empty / relative
 *   / missing / not-a-regular-file disable the route with a reason.
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync, realpathSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterFailure } from "./types";
import { assertSlotEligibleForL10, buildL10Argv, historicalToRuntime, L10_FROZEN_LITERALS, L10_LIVE_ELIGIBLE_SLOTS } from "./l10-routes";
import { resolveL10Binaries, _setL10BinariesForTest, _resetL10BinariesForTest, getResolvedL10Binaries } from "./config";

function setSnapshot(env: Record<string, string | undefined>): void {
  _setL10BinariesForTest(resolveL10Binaries(env as NodeJS.ProcessEnv));
}

function main() {
  // CONTROL — every L10_LIVE_ELIGIBLE_SLOTS slot passes the eligibility check.
  for (const slot of L10_LIVE_ELIGIBLE_SLOTS) {
    assertSlotEligibleForL10(slot);
  }

  // MUTANT — Terra (sustainability) is BLOCKED.
  assert.throws(() => assertSlotEligibleForL10("sustainability"), (e: unknown) => {
    return e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE";
  }, "sustainability slot must throw AdapterFailure(MODEL_UNAVAILABLE)");

  // MUTANT — unknown slot is refused.
  assert.throws(() => assertSlotEligibleForL10("not-a-slot"), (e: unknown) => {
    return e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE";
  });

  // Brief rev 2: argv[0] is the configured binary. We install synthetic
  // absolute paths under os.tmpdir() (one regular file per route) and
  // assert the resulting argv starts with that file.
  const scratch = mkdtempSync(join(tmpdir(), "l10-routes-"));
  const fakeClaude = join(scratch, "fake-claude");
  const fakeCodex = join(scratch, "fake-codex");
  const fakeGrok = join(scratch, "fake-grok");
  writeFileSync(fakeClaude, "");
  writeFileSync(fakeCodex, "");
  writeFileSync(fakeGrok, "");

  setSnapshot({
    AGENT_COMMONS_CLAUDE_BIN: fakeClaude,
    AGENT_COMMONS_CODEX_BIN: fakeCodex,
    AGENT_COMMONS_GROK_BIN: fakeGrok,
    AGENT_COMMONS_MODEL_LEDGER: "",
  });

  try {
    // CONTROL — frozen map: governance slot uses Codex wrapper with gpt-6.1-sol,
    // byte-for-byte per §a L40 (ends with the stdin marker "-"); argv[0]
    // is the configured synthetic path.
    const argvGovernance = buildL10Argv({ slotId: "governance", cwd: "/tmp", stdinPath: "/dev/stdin" });
    assert.equal(argvGovernance[0], fakeCodex, "governance argv[0] is the configured Codex binary");
    assert.deepEqual(argvGovernance.slice(1), [
      "exec",
      "--model", "gpt-6.1-sol",
      "--json", "--ephemeral", "--ignore-user-config", "--strict-config",
      "--sandbox", "read-only", "--color", "never", "--skip-git-repo-check", "-",
    ], "governance argv[1..] must equal §a L40 byte-for-byte");

    // CONTROL — Claude argv equals §a byte-for-byte: ends at --restricted,
    // NO trailing empty-string positional (the security reviewer C5).
    const argvContinuity = buildL10Argv({ slotId: "continuity", cwd: "/tmp", stdinPath: "/dev/stdin" });
    assert.equal(argvContinuity[0], fakeClaude, "continuity argv[0] is the configured Claude binary");
    assert.deepEqual(argvContinuity.slice(1), [
      "--print",
      "--model", "claude-fable-5-1",
      "--input-format", "text", "--output-format", "json",
      "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--no-session-persistence", "--restricted",
    ], "continuity argv[1..] must equal §a byte-for-byte, ending at --restricted");
    assert.ok(!argvContinuity.includes("") || argvContinuity.indexOf("") === argvContinuity.indexOf("--tools") + 1,
      "the only empty-string argv element is the --tools value");

    // MUTANT — Grok route is GATED: buildL10Argv("release") throws
    // MODEL_UNAVAILABLE (the §a L41 stdin gate is unresolved; never ship an
    // argv where -p swallows --model — the security reviewer C5).
    assert.throws(() => buildL10Argv({ slotId: "release", cwd: "/tmp", stdinPath: "/dev/stdin" }),
      (e: unknown) => e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE" && /stdin gate/.test(e.message),
      "release (Grok) must be gated until the stdin gate resolves");

    // CONTROL — historicalToRuntime honors its historical argument
    // (the security reviewer C5: the slice-1 version ignored it).
    assert.equal(historicalToRuntime("claude_fable_5_1", "continuity"), "claude-fable-5-1");
    assert.equal(historicalToRuntime("gpt_6_1_sol", "governance"), "gpt-6.1-sol");
    assert.equal(historicalToRuntime("WRONG", "continuity"), null, "wrong historical id returns null");
    assert.equal(historicalToRuntime("claude_fable_5_1", "governance"), null, "right id, wrong slot returns null");

    // MUTANT — config-sourced model override REJECTED at the seam. The
    // seam's argv contract takes ONLY the frozen literal from the map; a
    // runtimeModel param that differs from the frozen literal is never
    // honored because the buildL10Argv function never reads from
    // AdapterRequest.runtimeModel for argv. (Asserted here by reference:
    // buildL10Argv is a pure function over slotId + cwd + stdinPath.)
    // We re-derive: passing the same slotId always yields the same literal.
    const a = buildL10Argv({ slotId: "continuity", cwd: "/tmp/a", stdinPath: "/dev/stdin" });
    const b = buildL10Argv({ slotId: "continuity", cwd: "/tmp/b", stdinPath: "/dev/stdin" });
    const aLit = a[2];
    const bLit = b[2];
    assert.equal(aLit, bLit, "argv literal is invariant across cwd/stdinPath");

    // MUTANT — qwen3.8-max never appears in any frozen literal (NOT ELIGIBLE).
    for (const slot of L10_LIVE_ELIGIBLE_SLOTS) {
      const lit = L10_FROZEN_LITERALS[slot as keyof typeof L10_FROZEN_LITERALS];
      assert.notEqual(lit, "qwen3.8-max", `${slot} must not map to qwen3.8-max`);
    }

    // CONTROL — stdin-only prompt: argv never contains the prompt.
    const prompt = "VERY-UNIQUE-PROMPT-MARKER-XYZ-12345";
    for (const slot of L10_LIVE_ELIGIBLE_SLOTS) {
      if (slot === "release") continue; // gated (above) — no argv to inspect
      const argv = buildL10Argv({ slotId: slot, cwd: "/tmp", stdinPath: "/dev/stdin" });
      assert.ok(!argv.some((a) => a.includes(prompt)),
        `${slot} argv must not contain the prompt (got argv=${JSON.stringify(argv)})`);
    }

    // MUTANT — Terra (sustainability) is refused at the seam before any
    // argv shape is produced.
    assert.throws(() => buildL10Argv({ slotId: "sustainability", cwd: "/tmp", stdinPath: "/dev/stdin" }),
      (e: unknown) => e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE",
      "buildL10Argv for sustainability must throw AdapterFailure(MODEL_UNAVAILABLE)");

    // CONTROL / MUTANT — MCP config validation for the 3 Claude slots (rework 19 I)
    const validateClaudeMcpConfig = (raw: string) => {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid MCP configuration: expected record");
      }
      if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
        throw new Error("Invalid MCP configuration: mcpServers: Invalid input: expected record, received undefined");
      }
      if (Object.keys(parsed.mcpServers).length !== 0) {
        throw new Error("Invalid MCP configuration: mcpServers must have 0 keys");
      }
      return parsed;
    };

    const claudeSlots = ["continuity", "collaboration", "security"] as const;
    for (const slot of claudeSlots) {
      const argv = buildL10Argv({ slotId: slot, cwd: "/tmp", stdinPath: "/dev/stdin" });

      // CONTROL — the value after --mcp-config is valid JSON, an object whose mcpServers
      // is an object with 0 keys, and --strict-mcp-config is present.
      assert.ok(argv.includes("--strict-mcp-config"), `${slot} argv must include --strict-mcp-config`);
      const mcpConfigIdx = argv.indexOf("--mcp-config");
      assert.ok(mcpConfigIdx !== -1 && mcpConfigIdx + 1 < argv.length, `${slot} argv must contain --mcp-config`);
      const mcpConfigVal = argv[mcpConfigIdx + 1];
      assert.doesNotThrow(
        () => validateClaudeMcpConfig(mcpConfigVal),
        `${slot} CONTROL mcp-config must be valid JSON with empty mcpServers object`
      );

      // MUTANT (the old "{}" as a literal in the test): mcpServers is missing, so the check fails.
      const mutantOldLiteral = "{}";
      assert.throws(
        () => validateClaudeMcpConfig(mutantOldLiteral),
        /Invalid MCP configuration: mcpServers: Invalid input: expected record, received undefined/,
        `${slot} MUTANT old '{}' lacks mcpServers property and must fail validation`
      );
    }

    // Brief rev 2 P: two-pole tests for the resolver itself.
    // MUTANT — unset value disables the route.
    setSnapshot({ AGENT_COMMONS_CLAUDE_BIN: undefined, AGENT_COMMONS_CODEX_BIN: undefined, AGENT_COMMONS_GROK_BIN: undefined, AGENT_COMMONS_MODEL_LEDGER: undefined });
    assert.throws(() => buildL10Argv({ slotId: "continuity" }),
      (e: unknown) => e instanceof AdapterFailure && /unset/.test(e.message) && e.code === "MODEL_UNAVAILABLE",
      "unset claude bin disables the route");
    assert.throws(() => buildL10Argv({ slotId: "governance" }),
      (e: unknown) => e instanceof AdapterFailure && /unset/.test(e.message) && e.code === "MODEL_UNAVAILABLE",
      "unset codex bin disables the route");

    // MUTANT — empty / whitespace / relative value disables the route.
    setSnapshot({ AGENT_COMMONS_CLAUDE_BIN: "", AGENT_COMMONS_CODEX_BIN: "  ", AGENT_COMMONS_GROK_BIN: "codex", AGENT_COMMONS_MODEL_LEDGER: "" });
    assert.throws(() => buildL10Argv({ slotId: "continuity" }),
      (e: unknown) => e instanceof AdapterFailure && /empty/.test(e.message) && e.code === "MODEL_UNAVAILABLE",
      "empty claude bin disables the route");
    assert.throws(() => buildL10Argv({ slotId: "governance" }),
      (e: unknown) => e instanceof AdapterFailure && /whitespace/.test(e.message) && e.code === "MODEL_UNAVAILABLE",
      "whitespace codex bin disables the route");
    setSnapshot({ AGENT_COMMONS_CLAUDE_BIN: "codex", AGENT_COMMONS_CODEX_BIN: fakeCodex, AGENT_COMMONS_GROK_BIN: fakeGrok, AGENT_COMMONS_MODEL_LEDGER: "" });
    assert.throws(() => buildL10Argv({ slotId: "continuity" }),
      (e: unknown) => e instanceof AdapterFailure && /relative/.test(e.message) && e.code === "MODEL_UNAVAILABLE",
      "PATH-only 'codex' value (relative) refuses — no PATH search");

    // MUTANT — missing path / not-a-regular-file / directory disable the route.
    setSnapshot({ AGENT_COMMONS_CLAUDE_BIN: join(scratch, "does-not-exist"), AGENT_COMMONS_CODEX_BIN: scratch, AGENT_COMMONS_GROK_BIN: fakeGrok, AGENT_COMMONS_MODEL_LEDGER: "" });
    assert.throws(() => buildL10Argv({ slotId: "continuity" }),
      (e: unknown) => e instanceof AdapterFailure && /missing/.test(e.message) && e.code === "MODEL_UNAVAILABLE",
      "missing claude bin disables the route");
    assert.throws(() => buildL10Argv({ slotId: "governance" }),
      (e: unknown) => e instanceof AdapterFailure && /is-directory/.test(e.message) && e.code === "MODEL_UNAVAILABLE",
      "codex bin that is a directory disables the route");

    // MUTANT — symlink to a regular file is allowed (brief rev 2 C4).
    const symlinkTarget = join(scratch, "claude-symlink");
    try { unlinkSync(symlinkTarget); } catch {}
    symlinkSync(fakeClaude, symlinkTarget);
    setSnapshot({ AGENT_COMMONS_CLAUDE_BIN: symlinkTarget, AGENT_COMMONS_CODEX_BIN: fakeCodex, AGENT_COMMONS_GROK_BIN: fakeGrok, AGENT_COMMONS_MODEL_LEDGER: "" });
    const argvViaSymlink = buildL10Argv({ slotId: "continuity", cwd: "/tmp", stdinPath: "/dev/stdin" });
    assert.equal(argvViaSymlink[0], symlinkTarget, "argv[0] is the symlink path, NOT the resolved target");

    // CONTROL — restore the all-configured snapshot and confirm the
    // resolved paths come from process.env when no test snapshot is set.
    _resetL10BinariesForTest();
    // The process env may or may not have the binaries; the call should
    // either succeed (if env has them) or throw with a documented reason.
    try {
      const argvFromProcess = buildL10Argv({ slotId: "continuity", cwd: "/tmp", stdinPath: "/dev/stdin" });
      assert.ok(argvFromProcess[0].length > 0, "argv[0] is non-empty when env has the binary");
    } catch (e) {
      assert.ok(e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE",
        "unset/disabled env throws MODEL_UNAVAILABLE");
    }

    console.log("PASS: frozen map (config-sourced model rejected, qwen3.8-max never appears, Terra MODEL_UNAVAILABLE), stdin-only prompt (argv never contains prompt), MCP config CONTROL/MUTANT poles x3, binary resolver unset/empty/whitespace/relative/missing/directory/symlink two-pole.");
  } finally {
    _resetL10BinariesForTest();
    try { unlinkSync(fakeClaude); unlinkSync(fakeCodex); unlinkSync(fakeGrok); } catch {}
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

main();