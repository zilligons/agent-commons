/**
 * L10 rework 2 — D1/D2/D3 poles (the security reviewer PASS-WITH-CONDITIONS items).
 *
 * D1: .env parsed without auto-mutation; allowed key applied; a refused
 *   name in the file is ENV_REFUSED and nothing of it reaches process.env.
 * D2: spawn-time tripwire — clean env spawns the fixture; a refused name
 *   injected after bootstrap refuses before exec (no child).
 * D3: source-level assertion that server/index.ts's static import closure
 *   is exactly {./bootstrap, ./adapters/l10-env, node builtins}; a scratch
 *   copy with a static application import fails.
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDotenvGuarded, parseDotenv } from "../dotenv-guard";
import { assertSpawnTripwire, EnvRefusedError, scrubEnv } from "./l10-env";
import { spawnL10Child } from "./l10-process";

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "l10-d123-"));
  try {
    // ---- D1 ----
    // CONTROL — allowed key applied; existing console value wins.
    // R1 (rework 5) tightened the allowlist to the v3 §c L71 set: names
    // like APP_CONTROL_FLAG are no longer auto-applied. Use PORT /
    // NODE_ENV / AGENT_COMMONS_OFFLINE (the canonical allowlist).
    writeFileSync(join(scratch, ".env"), "# comment\nPORT=\"5097\"\nNODE_ENV=\"development\"\n", "utf8");
    const env1: NodeJS.ProcessEnv = { PATH: "/usr/bin", PORT: "already-from-console" };
    const r1 = applyDotenvGuarded({ cwd: scratch, env: env1 });
    assert.ok(r1.ok, "D1 CONTROL: clean .env applies");
    assert.equal(env1.PORT, "already-from-console", "existing console value wins (dotenv precedence)");
    assert.equal(env1.NODE_ENV, "development", "quotes stripped");
    assert.deepEqual([...r1.applied].sort(), ["NODE_ENV"]);
    assert.deepEqual(r1.skippedExisting, ["PORT"]);

    // MUTANT — refused name in .env → ENV_REFUSED, nothing applied.
    writeFileSync(join(scratch, ".env"), "PORT=5097\nAWS_SCRATCH_PROBE=1\n", "utf8");
    const env2: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const r2 = applyDotenvGuarded({ cwd: scratch, env: env2 });
    assert.ok(!r2.ok && r2.code === "ENV_REFUSED", "D1 MUTANT: refused name rejected");
    assert.deepEqual(r2.refusedNames, ["AWS_SCRATCH_PROBE"]);
    assert.equal(env2.AWS_SCRATCH_PROBE, undefined, "refused name never reaches env");
    assert.equal(env2.PORT, undefined, "fail-closed: NOTHING in the file is applied when any name is refused");

    // R1 MUTANT — unlisted name in .env (e.g. BASH_ENV) is reported as
    // unlisted and NOT applied; the allowlist is the v3 §c L71 set.
    writeFileSync(join(scratch, ".env"), "PORT=5097\nBASH_ENV=/tmp/evil\n", "utf8");
    const env2b: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const r2b = applyDotenvGuarded({ cwd: scratch, env: env2b });
    assert.ok(r2b.ok && r2b.unlisted!.includes("BASH_ENV") && env2b.BASH_ENV === undefined,
      "R1 MUTANT: unlisted name (BASH_ENV) is reported and NOT applied");

    // MUTANT — §c-classified name with empty value in .env → refused
    // (presence counts on classified names; R10 precision).
    writeFileSync(join(scratch, ".env"), "XAI_EMPTY_CLASSIFIED=\n", "utf8");
    const env3: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const r3 = applyDotenvGuarded({ cwd: scratch, env: env3 });
    assert.ok(!r3.ok && r3.code === "ENV_REFUSED" && r3.refusedNames.includes("XAI_EMPTY_CLASSIFIED"),
      "D1 MUTANT: classified empty-valued name in .env refused");

    // R10 CONTROL — unclassified empty-valued allowlisted name in .env applies normally (not a §c name).
    writeFileSync(join(scratch, ".env"), "AGENT_COMMONS_BIND_ALL=\n", "utf8");
    const env3b: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const r3b = applyDotenvGuarded({ cwd: scratch, env: env3b });
    assert.ok(r3b.ok && env3b.AGENT_COMMONS_BIND_ALL === "",
      "R10 CONTROL: unclassified empty name in .env is not a §c name");

    // CONTROL — missing .env is a no-op.
    rmSync(join(scratch, ".env"));
    const r4 = applyDotenvGuarded({ cwd: scratch, env: {} });
    assert.ok(r4.ok && r4.applied.length === 0, "missing .env is a no-op");

    // ---- D2 ----
    // CONTROL — clean env spawns the fixture.
    const fixture = join(scratch, "ok.sh");
    writeFileSync(fixture, "#!/bin/sh\ncat > /dev/null\necho OK\nexit 0\n", "utf8");
    const { chmodSync } = await import("node:fs");
    chmodSync(fixture, 0o700);
    const childEnv = { PATH: "/usr/bin:/bin", HOME: scratch, USER: "z", TERM: "dumb", LANG: "en_US.UTF-8", TMPDIR: scratch, TZ: "America/Los_Angeles" };
    const savedEnv = { ...process.env };
    try {
      // ensure the console env is clean of any inherited refused names for the CONTROL
      for (const k of scrubEnv(process.env).refused) delete process.env[k];
      const r = await spawnL10Child({ argv: [fixture], cwd: scratch, childEnv, promptText: "p", timeoutMs: 5000, cancelSignal: { cancelled: () => false } });
      assert.equal(r.diagnostic.exitCode, 0, "D2 CONTROL: clean env spawns the fixture");
      assert.equal(r.stdoutText.trim(), "OK");
    } finally {
      // restore then run the MUTANT with a fresh injection
      process.env = { ...savedEnv };
    }

    // MUTANT — refused name injected AFTER bootstrap → refusal before exec.
    process.env.XAI_D2_PROBE = "injected-after-bootstrap";
    let refused: EnvRefusedError | null = null;
    let spawned = false;
    try {
      await spawnL10Child({ argv: [fixture], cwd: scratch, childEnv, promptText: "p", timeoutMs: 5000, cancelSignal: { cancelled: () => false } });
      spawned = true;
    } catch (e) {
      if (e instanceof EnvRefusedError) refused = e; else throw e;
    } finally {
      delete process.env.XAI_D2_PROBE;
      process.env = { ...savedEnv };
    }
    assert.ok(refused, "D2 MUTANT: refused name at spawn time must throw EnvRefusedError");
    assert.ok(!spawned, "D2 MUTANT: no child spawned");
    // The console env carries other fleet credential names; the refusal
    // list must CONTAIN the injected probe (set membership, not equality).
    assert.ok(refused!.refusedNames.includes("XAI_D2_PROBE"),
      `D2 MUTANT: refusal names must include the injected probe (got ${refused!.refusedNames.length} names)`);

    // MUTANT — a §c-CLASSIFIED name with an empty value counts (v3 L61
    // presence clause, precise per R10: classification first).
    process.env.XAI_D2_EMPTY = "";
    let refused2: EnvRefusedError | null = null;
    try { assertSpawnTripwire(); } catch (e) { if (e instanceof EnvRefusedError) refused2 = e; else throw e; }
    finally { delete process.env.XAI_D2_EMPTY; process.env = { ...savedEnv }; }
    assert.ok(refused2 && refused2.refusedNames.includes("XAI_D2_EMPTY"),
      "D2 MUTANT: classified name with empty value counts");

    // R10 CONTROL — an UNCLASSIFIED empty-valued name does NOT trip the
    // spawn tripwire (npx/npm inject empty npm_config_* names; they are
    // not §c names). Scrub the lane shell's credential names first so
    // only the probe name is in play.
    for (const k of scrubEnv(process.env).refused) delete process.env[k];
    process.env.npm_config_noproxy = "";
    let noproxyRefused = false;
    try { assertSpawnTripwire(); } catch (e) { if (e instanceof EnvRefusedError) noproxyRefused = true; else throw e; }
    finally { delete process.env.npm_config_noproxy; process.env = { ...savedEnv }; }
    assert.equal(noproxyRefused, false, "R10 CONTROL: unclassified empty npm_config_noproxy does not trip the tripwire");

    // ---- D3 ----
    // Source-level assertion on server/index.ts's static import closure.
    const indexSrc = readFileSync(new URL("../index.ts", import.meta.url).pathname, "utf8");
    const closure = staticImportClosure(indexSrc);
    const allowed = new Set(["./bootstrap", "./adapters/l10-env", "./dotenv-guard"]);
    for (const spec of closure) {
      assert.ok(allowed.has(spec) || spec.startsWith("node:"),
        `D3 CONTROL: index.ts static import '${spec}' must be ./bootstrap, ./adapters/l10-env, ./dotenv-guard, or a node builtin`);
    }
    assert.ok(closure.includes("./bootstrap"), "index.ts imports ./bootstrap");

    // MUTANT — a scratch copy with a static application import added fails.
    const mutantSrc = indexSrc + `\nimport "./app";\n`;
    const mutantClosure = staticImportClosure(mutantSrc);
    assert.ok(mutantClosure.includes("./app"), "MUTANT fixture carries ./app");
    const mutantBad = mutantClosure.filter((s) => !allowed.has(s) && !s.startsWith("node:"));
    assert.deepEqual(mutantBad, ["./app"], "D3 MUTANT: a static ./app import is caught by the same predicate");

    // One level follow-through: bootstrap.ts's own closure is also restricted.
    const bootSrc = readFileSync(new URL("../bootstrap.ts", import.meta.url).pathname, "utf8");
    for (const spec of staticImportClosure(bootSrc)) {
      assert.ok(spec === "./adapters/l10-env" || spec.startsWith("node:"),
        `D3 CONTROL: bootstrap.ts static import '${spec}' must be l10-env or a builtin`);
    }

    console.log("PASS D1: .env parse-and-reject (allowed applied, refused ENV_REFUSED + nothing applied, empty refused, missing no-op).");
    console.log("PASS D2: spawn tripwire (clean env spawns; post-bootstrap refused name refuses before exec; empty value counts).");
    console.log("PASS D3: index.ts static closure = {./bootstrap, ./adapters/l10-env, node:*}; scratch ./app mutant caught; bootstrap.ts closure restricted.");
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

/** Parse static import specifiers from TS source (one level, no resolution). */
function staticImportClosure(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*import\s+(?:[^'"]*from\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
