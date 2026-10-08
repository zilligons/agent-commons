/**
 * L10 rework 1 — C5/C6/C7 poles.
 *
 * C5: argv byte-for-byte per §a (Claude ends at --restricted, Codex ends
 *   with "-", Grok gated); historicalToRuntime honors its argument;
 *   assertSlotEligibleForL10 empty-if-body removed.
 * C6: stderr cap rejects with STDERR_OVERFLOW distinct static code;
 *   configEnvRefusedNames returns CONFIG_UNVERIFIED on missing/unparseable
 *   file; writePromptTempFile deleted.
 * C7: scrubEnv comment states empty-valued names are refused by design.
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterFailure } from "./types";
import { buildL10Argv, historicalToRuntime, assertSlotEligibleForL10, L10_FROZEN_LITERALS } from "./l10-routes";
import { spawnL10Child } from "./l10-process";
import { configEnvRefusedNames, scrubEnv } from "./l10-env";
import { _setL10BinariesForTest, _resetL10BinariesForTest, resolveL10Binaries } from "./config";

async function main() {
  // D2 (rework 2) added a spawn-time tripwire on the console env; the
  // spawn fixtures below need a §c-clean console env (the lane shell
  // carries fleet credential names). Scrub and restore at the end.
  const savedEnv = { ...process.env };
  for (const k of scrubEnv(process.env).refused) delete process.env[k];

  // Brief rev 2 P: install a snapshot of synthetic absolute paths under
  // tmpdir so buildL10Argv and the spawn gates do not throw on the
  // unset AGENT_COMMONS_*_BIN env vars (the test entry uses fixtureBin
  // which overrides argv[0] but the gate still pre-checks the configured
  // value).
  const fixtureScratch = mkdtempSync(join(tmpdir(), "l10-c567-fixtures-"));
  const fakeClaude = join(fixtureScratch, "fake-claude");
  const fakeCodex = join(fixtureScratch, "fake-codex");
  const fakeGrok = join(fixtureScratch, "fake-grok");
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

  // ---- C5 ----

  // CONTROL — Claude argv ends at --restricted (no trailing empty positional).
  const argvClaude = buildL10Argv({ slotId: "continuity", cwd: "/tmp", stdinPath: "/dev/stdin" });
  assert.equal(argvClaude[argvClaude.length - 1], "--restricted",
    "C5: Claude argv must end at --restricted");
  // The only empty-string element is the --tools value.
  const emptyIdx = argvClaude.indexOf("");
  assert.equal(emptyIdx, argvClaude.indexOf("--tools") + 1,
    "C5: the only empty-string argv element must be the --tools value");

  // CONTROL — Codex argv ends with "-" (stdin marker).
  const argvCodex = buildL10Argv({ slotId: "governance", cwd: "/tmp", stdinPath: "/dev/stdin" });
  assert.equal(argvCodex[argvCodex.length - 1], "-",
    "C5: Codex argv must end with the stdin marker");

  // MUTANT — Grok route gated: buildL10Argv("release") throws.
  assert.throws(() => buildL10Argv({ slotId: "release", cwd: "/tmp", stdinPath: "/dev/stdin" }),
    (e: unknown) => e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE",
    "C5: Grok route must be gated until the stdin gate resolves");

  // MUTANT — historicalToRuntime honors its historical argument.
  assert.equal(historicalToRuntime("claude_fable_5_1", "continuity"), "claude-fable-5-1");
  assert.equal(historicalToRuntime("WRONG", "continuity"), null,
    "C5: wrong historical id must return null");
  assert.equal(historicalToRuntime("claude_fable_5_1", "governance"), null,
    "C5: right id, wrong slot must return null");

  // MUTANT — integration (Prism) is BLOCKED.
  assert.throws(() => assertSlotEligibleForL10("integration"),
    (e: unknown) => e instanceof AdapterFailure && e.code === "MODEL_UNAVAILABLE",
    "C5: integration (Prism) must be BLOCKED");

  // ---- C6 ----

  // CONTROL — stderr overflow rejects with STDERR_OVERFLOW (distinct code).
  // Fixture: a shell script that writes 70KB to stderr.
  const scratch = mkdtempSync(join(tmpdir(), "l10-c6-"));
  try {
    const bigStderr = join(scratch, "big-stderr.sh");
    writeFileSync(bigStderr, `#!/bin/sh\npython3 -c "import sys; sys.stderr.write('x'*70000)" 2>&1 || dd if=/dev/zero bs=1024 count=70 2>&1 >&2\nexit 0\n`, "utf8");
    // Simpler: use printf to stderr.
    writeFileSync(bigStderr, `#!/bin/sh\nhead -c 70000 /dev/zero | tr '\\0' 'x' >&2\nexit 0\n`, "utf8");
    chmodSync(bigStderr, 0o700);

    const childEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: scratch, USER: "z", TERM: "dumb", LANG: "en_US.UTF-8", TMPDIR: scratch, TZ: "America/Los_Angeles" };
    await assert.rejects(
      spawnL10Child({ argv: [bigStderr], cwd: scratch, childEnv, promptText: "", timeoutMs: 10000, cancelSignal: { cancelled: () => false } }),
      (e: unknown) => e instanceof AdapterFailure && e.code === "STDERR_OVERFLOW",
      "C6: stderr >64KB must reject with STDERR_OVERFLOW (distinct code)",
    );

    // MUTANT — stdout overflow rejects with STDOUT_OVERFLOW.
    const bigStdout = join(scratch, "big-stdout.sh");
    writeFileSync(bigStdout, `#!/bin/sh\nhead -c 70000 /dev/zero | tr '\\0' 'x'\nexit 0\n`, "utf8");
    chmodSync(bigStdout, 0o700);
    await assert.rejects(
      spawnL10Child({ argv: [bigStdout], cwd: scratch, childEnv, promptText: "", timeoutMs: 10000, cancelSignal: { cancelled: () => false } }),
      (e: unknown) => e instanceof AdapterFailure && e.code === "STDOUT_OVERFLOW",
      "C6: stdout >64KB must reject with STDOUT_OVERFLOW",
    );

    // MUTANT — configEnvRefusedNames: missing file → CONFIG_UNVERIFIED.
    const missing = configEnvRefusedNames(join(scratch, "does-not-exist.json"));
    assert.ok(typeof missing === "object" && !Array.isArray(missing) && missing.code === "CONFIG_UNVERIFIED",
      "C6: missing config file must return CONFIG_UNVERIFIED, not []");

    // MUTANT — configEnvRefusedNames: unparseable file → CONFIG_UNVERIFIED.
    writeFileSync(join(scratch, "bad.json"), "not json{{{", "utf8");
    const bad = configEnvRefusedNames(join(scratch, "bad.json"));
    assert.ok(typeof bad === "object" && !Array.isArray(bad) && bad.code === "CONFIG_UNVERIFIED",
      "C6: unparseable config must return CONFIG_UNVERIFIED, not []");

    // CONTROL — configEnvRefusedNames: valid JSON with refused names → names list.
    writeFileSync(join(scratch, "good.json"), JSON.stringify({ env: { XAI_API_KEY: "x", PATH: "/p" } }), "utf8");
    const good = configEnvRefusedNames(join(scratch, "good.json"));
    assert.ok(Array.isArray(good) && (good as string[]).includes("XAI_API_KEY"),
      "CONTROL: valid config with refused names returns the names");

    // CONTROL — writePromptTempFile deleted (import must fail).
    const proc = await import("./l10-process");
    assert.equal((proc as Record<string, unknown>).writePromptTempFile, undefined,
      "C6: writePromptTempFile must be deleted (R5 contradiction)");

    // ---- C7 ----
    // The scrubEnv JSDoc now states the empty-valued-name rule by design.
    // Structural assertion: read the source and check the comment exists.
    const src = (await import("node:fs")).readFileSync(new URL("./l10-env.ts", import.meta.url).pathname, "utf8");
    assert.ok(src.includes("empty-value clause") && src.includes("UNCLASSIFIED"),
      "C7+R10: scrubEnv JSDoc must state the empty-value presence clause applies to classified names");

    console.log("PASS C5: argv byte-for-byte §a (Claude ends --restricted, Codex ends -, Grok gated), historicalToRuntime honors argument, Prism BLOCKED.");
    console.log("PASS C6: stderr overflow STDERR_OVERFLOW, stdout overflow STDOUT_OVERFLOW, configEnvRefusedNames CONFIG_UNVERIFIED on missing/unparseable, writePromptTempFile deleted.");
    console.log("PASS C7: empty-valued-name refusal documented in scrubEnv JSDoc.");
  } finally {
    _resetL10BinariesForTest();
    process.env = { ...savedEnv };
    try { rmSync(fixtureScratch, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
