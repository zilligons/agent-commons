/**
 * L10 rework 5 — R1 poles: closed startup boundary CONSTRUCTS the console
 * env; dotenv-guard applies ONLY the v3 §c L71 app-control allowlist
 * (unclassified names are NOT applied; refused names still terminal).
 *
 * CONTROL: a .env carrying only the allowlist applies each allowed key
 *   to the closed console env; HOME/PATH are absent (closed list does
 *   not contain them — they come from the v3 §b common list, set by
 *   buildClosedConsoleEnv from the source). BASH_ENV present in the
 *   file is NOT applied and IS absent from the resulting env.
 * MUTANT: a .env carrying a §c-refused name is refused (terminal
 *   ENV_REFUSED). An arbitrary unlisted name (e.g. FOO=bar) is also
 *   not applied and is reported as `unlisted`.
 *
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDotenvGuarded, L10_APP_CONTROL_ALLOWLIST } from "../dotenv-guard";
import { buildClosedConsoleEnv } from "../bootstrap";

function main() {
  const scratch = mkdtempSync(join(tmpdir(), "l10-r1-"));
  try {
    // CONTROL — clean start, allowlist only. Apply to a mutable env
    // (the bootstrap applies to the live process.env; the test uses a
    // plain object so it doesn't pollute the lane shell).
    writeFileSync(join(scratch, ".env"),
      "PORT=5097\nNODE_ENV=development\nAGENT_COMMONS_OFFLINE=1\n",
      "utf8",
    );
    const closed: NodeJS.ProcessEnv = { ...buildClosedConsoleEnv({
      HOME: "/h", PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    }) } as NodeJS.ProcessEnv;
    const r1 = applyDotenvGuarded({ cwd: scratch, env: closed });
    assert.ok(r1.ok);
    assert.deepEqual([...r1.applied].sort(), ["AGENT_COMMONS_OFFLINE", "NODE_ENV", "PORT"]);
    assert.deepEqual(r1.unlisted, []);
    assert.equal(closed.PORT, "5097");
    assert.equal(closed.NODE_ENV, "development");
    assert.equal(closed.AGENT_COMMONS_OFFLINE, "1");
    assert.equal(closed.BASH_ENV, undefined, "BASH_ENV is not on the closed allowlist and must not appear");

    // MUTANT — a .env with BASH_ENV (an unlisted name) applies nothing of
    // it; BASH_ENV stays absent and the unlisted field reports it.
    writeFileSync(join(scratch, ".env"),
      "PORT=5097\nBASH_ENV=/tmp/evil\nAGENT_COMMONS_OFFLINE=1\n",
      "utf8",
    );
    const closed2: NodeJS.ProcessEnv = { ...buildClosedConsoleEnv({ HOME: "/h", PATH: "/opt/homebrew/bin:/usr/bin:/bin" }) } as NodeJS.ProcessEnv;
    const r2 = applyDotenvGuarded({ cwd: scratch, env: closed2 });
    assert.ok(r2.ok);
    assert.equal(closed2.BASH_ENV, undefined, "BASH_ENV must NOT be applied — not on the allowlist");
    assert.ok(r2.unlisted!.includes("BASH_ENV"), "BASH_ENV is reported as unlisted");
    assert.equal(closed2.PORT, "5097", "PORT still applied (on allowlist)");

    // MUTANT — §c-refused name in .env → terminal ENV_REFUSED.
    writeFileSync(join(scratch, ".env"),
      "PORT=5097\nAWS_SCRATCH_PROBE=1\n",
      "utf8",
    );
    const closed3: NodeJS.ProcessEnv = { ...buildClosedConsoleEnv({ HOME: "/h", PATH: "/opt/homebrew/bin:/usr/bin:/bin" }) } as NodeJS.ProcessEnv;
    const r3 = applyDotenvGuarded({ cwd: scratch, env: closed3 });
    assert.ok(!r3.ok && r3.code === "ENV_REFUSED");
    assert.ok(r3.refusedNames.includes("AWS_SCRATCH_PROBE"));
    assert.equal(closed3.AWS_SCRATCH_PROBE, undefined, "refused name must NOT leak into the env");
    assert.equal(closed3.PORT, undefined, "fail-closed: NOTHING in the file applies when any name is refused");

    // CONTROL — buildClosedConsoleEnv constructs the closed env (BASH_ENV
    // absent by construction even when present in the source env).
    const parent = {
      HOME: "/h", PATH: "/usr/bin:/bin", USER: "z", TERM: "dumb", LANG: "en", TMPDIR: "/t", TZ: "America/Los_Angeles",
      BASH_ENV: "/tmp/evil", NODE_OPTIONS: "--require /tmp/evil",
    };
    const built = buildClosedConsoleEnv(parent as NodeJS.ProcessEnv);
    assert.equal(built.HOME, "/h");
    assert.equal(built.BASH_ENV, undefined, "BASH_ENV absent by construction");
    assert.equal(built.NODE_OPTIONS, undefined, "NODE_OPTIONS absent by construction");

    // CONTROL — the allowlist is the v3 §c L71 set (closed).
    assert.ok(L10_APP_CONTROL_ALLOWLIST.includes("NODE_ENV"));
    assert.ok(L10_APP_CONTROL_ALLOWLIST.includes("PORT"));
    assert.ok(L10_APP_CONTROL_ALLOWLIST.includes("AGENT_COMMONS_OFFLINE"));
    assert.ok(!L10_APP_CONTROL_ALLOWLIST.includes("BASH_ENV"), "BASH_ENV must NEVER be on the app-control allowlist");
    // R1 rework 6: test the exact index.ts replacement sequence:
    // Inherited BASH_ENV and UNLISTED_REVIEW are removed from the live env object,
    // while allowlisted keys and .env app-control additions are preserved.
    const liveTestEnv: NodeJS.ProcessEnv = {
      HOME: scratch,
      PATH: "/usr/bin:/bin",
      USER: "z",
      TERM: "dumb",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp",
      TZ: "America/Los_Angeles",
      BASH_ENV: "synthetic-unused-hook",
      UNLISTED_REVIEW: "synthetic",
    };
    const closedTest = buildClosedConsoleEnv(liveTestEnv);
    for (const k of Object.keys(liveTestEnv)) {
      if (!Object.prototype.hasOwnProperty.call(closedTest, k)) {
        delete liveTestEnv[k];
      }
    }
    for (const [k, v] of Object.entries(closedTest)) {
      liveTestEnv[k] = v;
    }
    assert.equal(liveTestEnv.BASH_ENV, undefined, "R1 MUTANT: inherited BASH_ENV must be deleted from live env");
    assert.equal(liveTestEnv.UNLISTED_REVIEW, undefined, "R1 MUTANT: inherited UNLISTED_REVIEW must be deleted from live env");
    assert.equal(liveTestEnv.HOME, scratch, "R1 CONTROL: allowlisted HOME retained");
    assert.equal(liveTestEnv.PATH, "/usr/bin:/bin", "R1 CONTROL: allowlisted PATH retained");

    writeFileSync(join(scratch, ".env"), "PORT=5087\nBASH_ENV=synthetic-file-hook\n", "utf8");
    const dotRes = applyDotenvGuarded({ cwd: scratch, env: liveTestEnv });
    assert.ok(dotRes.ok);
    assert.equal(liveTestEnv.PORT, "5087", "R1 CONTROL: allowed PORT applied from .env");
    assert.equal(liveTestEnv.BASH_ENV, undefined, "R1 MUTANT: .env BASH_ENV ignored and absent");
    assert.equal(liveTestEnv.UNLISTED_REVIEW, undefined, "R1 MUTANT: UNLISTED_REVIEW remains absent");

    // Brief rev 4 R1: AGENT_COMMONS_CLAUDE_BIN (and the three siblings
    // _CODEX_BIN / _GROK_BIN / _MODEL_LEDGER) are NOT on the app-control
    // allowlist. A .env line setting any of them is "unlisted" — it is
    // listed as ignored, NOT applied to the env. The route stays
    // disabled because process.env[AGENT_COMMONS_CLAUDE_BIN] stays
    // unset (the .env did not write it).
    writeFileSync(
      join(scratch, ".env-l10-bin"),
      [
        "AGENT_COMMONS_CLAUDE_BIN=/tmp/should-not-be-applied-claude",
        "AGENT_COMMONS_CODEX_BIN=/tmp/should-not-be-applied-codex",
        "AGENT_COMMONS_GROK_BIN=/tmp/should-not-be-applied-grok",
        "AGENT_COMMONS_MODEL_LEDGER=/tmp/should-not-be-applied.jsonl",
        "PORT=5088",
        "AGENT_COMMONS_ADAPTER=preview-bridge",
      ].join("\n") + "\n",
      "utf8",
    );
    const l10BinEnv: NodeJS.ProcessEnv = { ...liveTestEnv };
    // Start the env without any of the four L10 bin keys; the .env
    // MUST NOT introduce them.
    delete l10BinEnv.AGENT_COMMONS_CLAUDE_BIN;
    delete l10BinEnv.AGENT_COMMONS_CODEX_BIN;
    delete l10BinEnv.AGENT_COMMONS_GROK_BIN;
    delete l10BinEnv.AGENT_COMMONS_MODEL_LEDGER;
    // Drop PORT and AGENT_COMMONS_ADAPTER so the .env's values can be
    // applied (applyDotenvGuarded's "existing wins" rule).
    delete l10BinEnv.PORT;
    delete l10BinEnv.AGENT_COMMONS_ADAPTER;
    const l10BinRes = applyDotenvGuarded({ cwd: scratch, file: ".env-l10-bin", env: l10BinEnv });
    assert.ok(l10BinRes.ok);
    const l10BinUnlisted = (l10BinRes as unknown as { unlisted?: string[] }).unlisted ?? [];
    for (const name of ["AGENT_COMMONS_CLAUDE_BIN", "AGENT_COMMONS_CODEX_BIN", "AGENT_COMMONS_GROK_BIN", "AGENT_COMMONS_MODEL_LEDGER"]) {
      assert.ok(l10BinUnlisted.includes(name), `R1: ${name} must be reported as unlisted (got ${JSON.stringify(l10BinUnlisted)})`);
    }
    assert.equal(l10BinEnv.AGENT_COMMONS_CLAUDE_BIN, undefined, "R1: .env AGENT_COMMONS_CLAUDE_BIN is NOT applied to env");
    assert.equal(l10BinEnv.AGENT_COMMONS_CODEX_BIN, undefined, "R1: .env AGENT_COMMONS_CODEX_BIN is NOT applied to env");
    assert.equal(l10BinEnv.AGENT_COMMONS_GROK_BIN, undefined, "R1: .env AGENT_COMMONS_GROK_BIN is NOT applied to env");
    assert.equal(l10BinEnv.AGENT_COMMONS_MODEL_LEDGER, undefined, "R1: .env AGENT_COMMONS_MODEL_LEDGER is NOT applied to env");
    // MUTANT pole: even if a future regression put one of the four on
    // the allowlist, the .env line WOULD be applied. The test asserts
    // the inverse — none of the four is on L10_APP_CONTROL_ALLOWLIST.
    for (const name of ["AGENT_COMMONS_CLAUDE_BIN", "AGENT_COMMONS_CODEX_BIN", "AGENT_COMMONS_GROK_BIN", "AGENT_COMMONS_MODEL_LEDGER"]) {
      assert.ok(!L10_APP_CONTROL_ALLOWLIST.includes(name), `R1: ${name} must NOT be on L10_APP_CONTROL_ALLOWLIST`);
    }
    // Allowlisted names ARE applied.
    assert.equal(l10BinEnv.PORT, "5088", "R1: allowlisted PORT still applied");
    assert.equal(l10BinEnv.AGENT_COMMONS_ADAPTER, "preview-bridge", "R1: allowlisted AGENT_COMMONS_ADAPTER still applied");

    console.log("PASS R1: closed console env CONSTRUCTS (BASH_ENV/NODE_OPTIONS absent by construction); dotenv-guard applies only the allowlist; refused names terminal; unlisted names ignored, not applied; AGENT_COMMONS_*_BIN / _MODEL_LEDGER NEVER read from .env (R1 brief rev 4).");
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

main();
