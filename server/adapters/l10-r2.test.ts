/**
 * L10 rework 3 — R2 poles: frozen route envs (trusted values, pole policy,
 * TMPDIR proof, unsupported additions rejected).
 *
 * CONTROL: frozen PATH/USER/TERM/LANG/TZ cannot be overridden; Claude
 *   CONTROL uses real HOME (os.userInfo().homedir, not a hard-coded user
 *   path literal); Codex CONTROL gets CODEX_HOME; Grok keeps the
 *   configured GROK_REAL in BOTH poles (or omits it when unconfigured);
 *   TMPDIR under the run dir is created mode 700 and proven.
 * MUTANT: Codex MUTANT has NO CODEX_HOME key at all; an unsupported
 *   addition is rejected; a §c-refused or empty addition is rejected; a
 *   TMPDIR that exists with wrong mode is rejected.
 *
 * Brief rev 2 P: the Grok binary is configured via AGENT_COMMONS_GROK_BIN;
 * the Claude CONTROL HOME is the real account's home from os.userInfo().
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userInfo } from "node:os";
import { buildChildEnv, L10EnvBuilderError, L10_FROZEN_PATH, L10_FROZEN_TZ, getL10GrokReal } from "./l10-env";
import { _setL10BinariesForTest, _resetL10BinariesForTest, resolveL10Binaries } from "./config";

function main() {
  const scratch = mkdtempSync(join(tmpdir(), "l10-r2-"));
  const fakeGrok = join(scratch, "fake-grok");
  writeFileSync(fakeGrok, "");
  _setL10BinariesForTest(resolveL10Binaries({
    AGENT_COMMONS_GROK_BIN: fakeGrok,
  } as NodeJS.ProcessEnv));
  try {
    // CONTROL — frozen values; no caller override possible (signature has no
    // path/user/term/lang/tz params at all).
    const env = buildChildEnv({ route: "codex", runId: "r2", home: "/h", pole: "CONTROL", runDir: scratch });
    assert.equal(env.PATH, L10_FROZEN_PATH, "frozen PATH incl /opt/homebrew/bin");
    assert.equal(env.TZ, L10_FROZEN_TZ);
    assert.ok(L10_FROZEN_PATH.includes("/opt/homebrew/bin"), "v3 §b PATH component present");
    assert.equal(env.HOME, "/h");
    assert.equal(env.CODEX_HOME, "/h/.codex", "Codex CONTROL gets CODEX_HOME");

    // TMPDIR created mode 700 under the run dir and proven.
    const tmpSt = statSync(env.TMPDIR!);
    assert.ok(env.TMPDIR!.startsWith(scratch), "TMPDIR under the run dir");
    assert.equal(tmpSt.mode & 0o777, 0o700, "TMPDIR mode 700 proven");

    // Claude CONTROL uses the REAL home (os.userInfo().homedir, not a hard-coded user path);
    // MUTANT uses the supplied scratch.
    const claudeControl = buildChildEnv({ route: "claude", runId: "r2", home: "/h", pole: "CONTROL", runDir: scratch });
    assert.equal(claudeControl.HOME, userInfo().homedir, "Claude CONTROL: real HOME (no scratch-HOME pole) — from os.userInfo().homedir");
    const claudeMutant = buildChildEnv({ route: "claude", runId: "r2", home: "/h", pole: "MUTANT", runDir: scratch });
    assert.equal(claudeMutant.HOME, "/h", "Claude MUTANT: scratch HOME honored");

    // Grok keeps GROK_REAL in BOTH poles — value is the configured fake.
    const grokControl = buildChildEnv({ route: "grok", runId: "r2", home: "/h", pole: "CONTROL", runDir: scratch });
    const grokMutant = buildChildEnv({ route: "grok", runId: "r2", home: "/h2", pole: "MUTANT", runDir: scratch });
    assert.equal(grokControl.GROK_REAL, getL10GrokReal(), "Grok CONTROL: GROK_REAL is the configured value");
    assert.equal(grokMutant.GROK_REAL, getL10GrokReal(), "Grok MUTANT: GROK_REAL is the configured value (never derived from pole HOME)");

    // CONTROL — route-trusted additions with exact trusted values succeed.
    const claudeHomeForAddition = userInfo().homedir;
    const claudeAddition = buildChildEnv({
      route: "claude", runId: "r2", home: claudeHomeForAddition, pole: "CONTROL", runDir: scratch,
      additions: { CLAUDE_CONFIG_DIR: join(claudeHomeForAddition, ".claude") },
    });
    assert.equal(claudeAddition.CLAUDE_CONFIG_DIR, join(claudeHomeForAddition, ".claude"));

    const codexAddition = buildChildEnv({
      route: "codex", runId: "r2", home: "/h", pole: "CONTROL", runDir: scratch,
      additions: { CODEX_HOME: "/h/.codex" },
    });
    assert.equal(codexAddition.CODEX_HOME, "/h/.codex");

    const grokAddition = buildChildEnv({
      route: "grok", runId: "r2", home: "/h", pole: "CONTROL", runDir: scratch,
      additions: { GROK_REAL: fakeGrok },
    });
    assert.equal(grokAddition.GROK_REAL, fakeGrok);

    // MUTANT — omitting runDir is refused.
    assert.throws(
      () => (buildChildEnv as unknown as (opts: Record<string, unknown>) => unknown)({ route: "claude", runId: "r2", home: "/h" }),
      (e: unknown) => e instanceof L10EnvBuilderError && /runDir is required/.test(e.message),
      "omitting runDir must be refused",
    );

    // MUTANT — non-existent runDir is refused.
    assert.throws(
      () => buildChildEnv({ route: "claude", runId: "r2", home: "/h", runDir: join(scratch, "nonexistent-dir") }),
      (e: unknown) => e instanceof L10EnvBuilderError && /must exist/.test(e.message),
      "non-existent runDir must be refused",
    );

    // MUTANT — Codex MUTANT has NO CODEX_HOME key at all.
    const codexMutant = buildChildEnv({ route: "codex", runId: "r2", home: "/h", pole: "MUTANT", runDir: scratch });
    assert.ok(!("CODEX_HOME" in codexMutant), "Codex MUTANT: CODEX_HOME entirely absent");

    // MUTANT — Codex MUTANT rejects any CODEX_HOME addition.
    assert.throws(
      () => buildChildEnv({ route: "codex", runId: "r2", home: "/h", pole: "MUTANT", runDir: scratch, additions: { CODEX_HOME: "/h/.codex" } }),
      (e: unknown) => e instanceof L10EnvBuilderError && /codex MUTANT/.test(e.message),
      "Codex MUTANT must refuse CODEX_HOME addition",
    );

    // MUTANT — addition with untrusted value is rejected.
    assert.throws(
      () => buildChildEnv({ route: "claude", runId: "r2", home: "/h", runDir: scratch, additions: { CLAUDE_CONFIG_DIR: "/some/arbitrary/path" } }),
      (e: unknown) => e instanceof L10EnvBuilderError && /does not match trusted value/.test(e.message),
      "untrusted CLAUDE_CONFIG_DIR value rejected",
    );
    assert.throws(
      () => buildChildEnv({ route: "codex", runId: "r2", home: "/h", pole: "CONTROL", runDir: scratch, additions: { CODEX_HOME: "/some/arbitrary/path" } }),
      (e: unknown) => e instanceof L10EnvBuilderError && /does not match trusted value/.test(e.message),
      "untrusted CODEX_HOME value rejected",
    );

    // MUTANT — unsupported addition rejected.
    assert.throws(
      () => buildChildEnv({ route: "claude", runId: "r2", home: "/h", runDir: scratch, additions: { EVIL_HOOK: "x" } }),
      (e: unknown) => e instanceof L10EnvBuilderError && /unsupported/.test(e.message),
      "unsupported addition rejected",
    );
    // MUTANT — cross-route addition rejected.
    assert.throws(
      () => buildChildEnv({ route: "claude", runId: "r2", home: "/h", runDir: scratch, additions: { CODEX_HOME: "/h/.codex" } }),
      (e: unknown) => e instanceof L10EnvBuilderError && /unsupported/.test(e.message),
      "cross-route addition rejected",
    );
    // MUTANT — §c-refused addition rejected.
    assert.throws(
      () => buildChildEnv({ route: "claude", runId: "r2", home: "/h", runDir: scratch, additions: { CLAUDE_CONFIG_DIR: "" } }),
      (e: unknown) => e instanceof L10EnvBuilderError && /refused/.test(e.message),
      "empty addition value rejected",
    );

    // MUTANT — TMPDIR with wrong mode is rejected.
    const badRun = mkdtempSync(join(tmpdir(), "l10-r2-bad-"));
    try {
      mkdirSync(join(badRun, "tmp"), { recursive: true });
      chmodSync(join(badRun, "tmp"), 0o755);
      assert.throws(
        () => buildChildEnv({ route: "claude", runId: "r2", home: "/h", runDir: badRun }),
        (e: unknown) => e instanceof L10EnvBuilderError && /mode-700/.test(e.message),
        "wrong-mode TMPDIR rejected",
      );
    } finally {
      try { rmSync(badRun, { recursive: true, force: true }); } catch {}
    }

    console.log("PASS R2: frozen PATH/USER/TERM/LANG/TZ, Claude CONTROL real HOME, Codex MUTANT no CODEX_HOME, Grok GROK_REAL both poles, TMPDIR mode-700 proven, trusted additions accepted, untrusted/cross-route/unsupported additions + omitted/wrong-mode runDir rejected.");
  } finally {
    _resetL10BinariesForTest();
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

main();
