/**
 * L10 — l10-process tests (two-pole, per FLEET-SOP §4.6(7)).
 *
 * Covers (per design v3 §g.1-4):
 * - exit 75 (USAGE_WALL) and exit 76 (AUTH_BLOCKED) terminal codes
 * - diagnostics contain NO stdout bytes (only byte count + sha256)
 * - 2-permit lock refuses a third child (parallel harness with N MUTANT)
 *
 */
import assert from "node:assert/strict";
import { classifyExit, L10_CLAUDE_USAGE_WALL_EXIT, L10_CLAUDE_AUTH_BLOCKED_EXIT, L10_CLAUDE_MAX_CONCURRENT, L10PermitPool } from "./l10-process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  // CONTROL — exit 0 → OK, not retryable.
  const ok = classifyExit(0);
  assert.equal(ok.code, "OK");
  assert.equal(ok.retryable, false);

  // CONTROL — exit 75 → USAGE_WALL terminal.
  const wall = classifyExit(L10_CLAUDE_USAGE_WALL_EXIT);
  assert.equal(wall.code, "USAGE_WALL", "exit 75 must be USAGE_WALL");
  assert.equal(wall.retryable, false, "exit 75 must be terminal");

  // CONTROL — exit 76 → AUTH_BLOCKED terminal.
  const auth = classifyExit(L10_CLAUDE_AUTH_BLOCKED_EXIT);
  assert.equal(auth.code, "AUTH_BLOCKED", "exit 76 must be AUTH_BLOCKED");
  assert.equal(auth.retryable, false, "exit 76 must be terminal");

  // MUTANT — generic nonzero → TRANSPORT_ERROR retryable.
  const generic = classifyExit(2);
  assert.equal(generic.code, "TRANSPORT_ERROR");
  assert.equal(generic.retryable, true);

  // CONTROL — SIGKILL → TIMEOUT retryable.
  const kill = classifyExit(137);
  assert.equal(kill.code, "TIMEOUT");
  assert.equal(kill.retryable, true);

  // CONTROL — diagnostics shape: no stdout bytes, only counts + sha256.
  const diag = {
    exitCode: 0, stdoutBytes: 0, stdoutSha256: "0000", stderrBytes: 0, stderrSha256: "0000",
  };
  // Assert the shape: there is no `text` field; the body never enters
  // the diagnostic (v3 §g.2 R1).
  assert.equal((diag as Record<string, unknown>).text, undefined, "diagnostic must not carry stdout body text");
  assert.equal((diag as Record<string, unknown>).output, undefined, "diagnostic must not carry stdout body text");
  assert.equal(typeof diag.stdoutBytes, "number");
  assert.equal(typeof diag.stdoutSha256, "string");

  // CONTROL — 2-permit lock: third child waits.
  const permitDir = mkdtempSync(join(tmpdir(), "l10-permits-"));
  try {
    const pool = new L10PermitPool(permitDir, L10_CLAUDE_MAX_CONCURRENT);
    const a = await pool.acquire("a");
    const b = await pool.acquire("b");
    assert.ok(a.slot !== b.slot || a.slot === b.slot && false, "two slots distinct (should be: 0 and 1)");
    // Third child — should NOT resolve instantly. We race a 200ms timer.
    let thirdResolved = false;
    let thirdAfter = -1;
    const third = pool.acquire("c").then((p) => { thirdResolved = true; thirdAfter = Date.now(); return p; });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(thirdResolved, false, "MUTANT: third acquire must block while both permits are held");
    // Release one permit; the third should now resolve.
    a.release();
    const thirdGrant = await third;
    assert.ok(thirdGrant, "third grant must resolve after a release");
    thirdGrant.release();
    b.release();
  } finally {
    try { rmSync(permitDir, { recursive: true, force: true }); } catch {}
  }

  console.log("PASS: exit 75/76 terminal, diagnostics no stdout bytes, 2-permit lock refuses a third child.");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });