/**
 * L10 rework 3 — R9 poles: static parse-failure reasons (no parser text,
 * no config excerpts), format/shape gates, overflow/timeout rejections
 * carry exit/count/hash diagnostics without stream bodies.
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterFailure } from "./types";
import { configEnvRefusedNames, scrubEnv } from "./l10-env";
import { spawnL10Child, sha256 } from "./l10-process";

async function main() {
  // The lane shell carries fleet credential names the D2/R1 tripwire
  // correctly refuses; scrub for the spawn fixtures, restore at the end.
  const savedEnv = { ...process.env };
  for (const k of scrubEnv(process.env).refused) delete process.env[k];
  const scratch = mkdtempSync(join(tmpdir(), "l10-r9-"));
  try {
    // MUTANT — malformed JSON: reason is STATIC, no input excerpt.
    // An earlier probe leaked a synthetic input fragment into the old reason.
    const secretMarker = "UNIQUE-SYNTHETIC-FRAGMENT-9f8e7d";
    writeFileSync(join(scratch, "bad.json"), `{ "env": { "x": "${secretMarker}"`, "utf8");
    const bad = configEnvRefusedNames(join(scratch, "bad.json"));
    assert.ok(!Array.isArray(bad) && bad.code === "CONFIG_UNVERIFIED", "malformed → CONFIG_UNVERIFIED");
    assert.ok(!bad.reason.includes(secretMarker), "R9 MUTANT: reason must NOT carry the input excerpt");
    assert.equal(bad.reason, "config parse failure", "static reason");

    // MUTANT — non-JSON format (TOML) → CONFIG_UNVERIFIED, never parsed.
    writeFileSync(join(scratch, "config.toml"), "model = \"gpt-6.1-sol\"\n", "utf8");
    const toml = configEnvRefusedNames(join(scratch, "config.toml"));
    assert.ok(!Array.isArray(toml) && toml.code === "CONFIG_UNVERIFIED" && /unsupported config format/.test(toml.reason),
      "R9 MUTANT: TOML unsupported in this slice");

    // MUTANT — JSON but wrong top-level shape (array) → CONFIG_UNVERIFIED.
    writeFileSync(join(scratch, "arr.json"), "[1,2,3]", "utf8");
    const arr = configEnvRefusedNames(join(scratch, "arr.json"));
    assert.ok(!Array.isArray(arr) && arr.code === "CONFIG_UNVERIFIED" && /shape/.test(arr.reason),
      "R9 MUTANT: non-object JSON shape unsupported");

    // CONTROL — valid JSON object with a refused name still reports names.
    writeFileSync(join(scratch, "good.json"), JSON.stringify({ env: { XAI_PROBE: "x" } }), "utf8");
    const good = configEnvRefusedNames(join(scratch, "good.json"));
    assert.ok(Array.isArray(good) && good.includes("XAI_PROBE"), "CONTROL: valid config reports refused names");

    // CONTROL — 64,000 bytes within cap: success, full stream hash matches
    const controlScript = join(scratch, "control.sh");
    writeFileSync(controlScript, "#!/bin/sh\ncat > /dev/null\nhead -c 64000 /dev/zero | tr '\\0' 'x'\nexit 0\n", "utf8");
    chmodSync(controlScript, 0o700);
    const childEnv = { PATH: "/usr/bin:/bin", HOME: scratch, USER: "z", TERM: "dumb", LANG: "en_US.UTF-8", TMPDIR: scratch, TZ: "America/Los_Angeles" };
    const controlRes = await spawnL10Child({ argv: [controlScript], cwd: scratch, childEnv, promptText: "", timeoutMs: 10000, cancelSignal: { cancelled: () => false } });
    assert.equal(controlRes.diagnostic.stdoutBytes, 64_000, "CONTROL: exactly 64000 bytes");
    const expectedControlHash = sha256("x".repeat(64_000));
    assert.equal(controlRes.diagnostic.stdoutSha256, expectedControlHash, "CONTROL: exact full-stream hash matches");

    // MUTANT — overflow rejection carries diagnostics (counts+sha matching full observed bytes), no body.
    const big = join(scratch, "big.sh");
    writeFileSync(big, "#!/bin/sh\ncat > /dev/null\nhead -c 65000 /dev/zero | tr '\\0' 'x'\nexit 0\n", "utf8");
    chmodSync(big, 0o700);
    let overflowErr: AdapterFailure | null = null;
    try {
      await spawnL10Child({ argv: [big], cwd: scratch, childEnv, promptText: "", timeoutMs: 10000, cancelSignal: { cancelled: () => false } });
    } catch (e) { if (e instanceof AdapterFailure) overflowErr = e; else throw e; }
    assert.ok(overflowErr && overflowErr.code === "STDOUT_OVERFLOW", "overflow rejects");
    assert.ok(overflowErr!.diagnostics, "R9 MUTANT: overflow rejection carries diagnostics");
    assert.equal(overflowErr!.diagnostics!.stdoutBytes, 65_000, "diagnostic counts exactly the 65000 overflow bytes");
    const expectedOverflowHash = sha256("x".repeat(65_000));
    assert.equal(overflowErr!.diagnostics!.stdoutSha256, expectedOverflowHash, "R9 MUTANT: incremental hash matches full observed 65000 bytes");
    assert.ok(!JSON.stringify(overflowErr!.diagnostics).includes("xxxx"),
      "R9: diagnostics must NOT carry stream bodies");

    // R9 (rework 6): 512,000-byte fixture -> count and digest equal independent observer's
    const huge = join(scratch, "huge.sh");
    writeFileSync(huge, "#!/bin/sh\ncat > /dev/null\nhead -c 512000 /dev/zero | tr '\\0' 'x'\nexit 0\n", "utf8");
    chmodSync(huge, 0o700);
    let hugeErr: AdapterFailure | null = null;
    try {
      await spawnL10Child({ argv: [huge], cwd: scratch, childEnv, promptText: "", timeoutMs: 10000, cancelSignal: { cancelled: () => false } });
    } catch (e) { if (e instanceof AdapterFailure) hugeErr = e; else throw e; }
    assert.ok(hugeErr && hugeErr.code === "STDOUT_OVERFLOW", "512,000 B overflow rejects with STDOUT_OVERFLOW");
    assert.ok(hugeErr!.diagnostics, "overflow rejection carries diagnostics");
    assert.equal(hugeErr!.diagnostics!.stdoutBytes, 512_000, "diagnostic counts exactly all 512000 delivered bytes");
    const expectedHugeHash = sha256("x".repeat(512_000));
    assert.equal(hugeErr!.diagnostics!.stdoutSha256, expectedHugeHash, "digest equals full stream digest (not frozen at 65536)");

    // MUTANT — timeout rejection carries diagnostics too.
    const slow = join(scratch, "slow.sh");
    writeFileSync(slow, "#!/bin/sh\ncat > /dev/null\nsleep 5\nexit 0\n", "utf8");
    chmodSync(slow, 0o700);
    let timeoutErr: AdapterFailure | null = null;
    try {
      await spawnL10Child({ argv: [slow], cwd: scratch, childEnv, promptText: "", timeoutMs: 300, cancelSignal: { cancelled: () => false } });
    } catch (e) { if (e instanceof AdapterFailure) timeoutErr = e; else throw e; }
    assert.ok(timeoutErr && timeoutErr.code === "TIMEOUT", "timeout rejects");
    assert.ok(timeoutErr!.diagnostics, "R9 MUTANT: timeout rejection carries diagnostics");

    console.log("PASS R9: static parse reasons (no excerpt), format/shape gates, overflow + timeout rejections carry count/hash diagnostics without bodies.");
  } finally {
    process.env = { ...savedEnv };
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
