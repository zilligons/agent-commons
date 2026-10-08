/**
 * L10 rework 3 — R1 poles: closed console env (construct, never filter) +
 * parent AND child tripwire before every sanctioned spawn.
 *
 * CONTROL: buildClosedConsoleEnv keeps allowlisted app controls and drops
 *   hook names (BASH_ENV, NODE_OPTIONS, DYLD_INSERT_LIBRARIES) by
 *   construction; a clean parent + clean child passes the spawn tripwire.
 * MUTANT: a hook name in the parent is absent from the constructed child;
 *   a §c refused name in the CHILD env trips the child-surface tripwire;
 *   a §c refused name in the parent trips the parent-surface tripwire.
 *
 */
import assert from "node:assert/strict";
import { buildClosedConsoleEnv, assertSpawnTripwire, EnvRefusedError, CLOSED_CONSOLE_ALLOWLIST, SPAWN_HOOK_DENYLIST } from "./l10-env";

function main() {
  // CONTROL — allowlisted names survive with values; hooks dropped by construction.
  const parent = {
    HOME: "/h", PATH: "/p", USER: "z", TERM: "dumb", LANG: "en", TMPDIR: "/t", TZ: "America/Los_Angeles",
    NODE_ENV: "development", PORT: "5087", AGENT_COMMONS_OFFLINE: "1",
    BASH_ENV: "/tmp/evil.sh", NODE_OPTIONS: "--require /tmp/evil.js",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib", PROMPT_COMMAND: "curl evil",
    RANDOM_UNLISTED: "x", EMPTY_ALLOWED: "",
  };
  const child = buildClosedConsoleEnv(parent);
  assert.equal(child.HOME, "/h");
  assert.equal(child.NODE_ENV, "development");
  assert.equal(child.AGENT_COMMONS_OFFLINE, "1");
  assert.equal(child.BASH_ENV, undefined, "R1: BASH_ENV must NOT survive (construct, not filter)");
  assert.equal(child.NODE_OPTIONS, undefined, "R1: NODE_OPTIONS must NOT survive");
  assert.equal(child.DYLD_INSERT_LIBRARIES, undefined, "R1: DYLD hook must NOT survive");
  assert.equal(child.PROMPT_COMMAND, undefined, "R1: PROMPT_COMMAND must NOT survive");
  assert.equal(child.RANDOM_UNLISTED, undefined, "R1: unlisted names dropped by construction");
  assert.equal(child.EMPTY_ALLOWED, undefined, "R1: empty values dropped");

  // Allowlist ∩ denylist = ∅ (a future edit cannot re-admit a hook silently).
  for (const n of SPAWN_HOOK_DENYLIST) {
    assert.ok(!(CLOSED_CONSOLE_ALLOWLIST as readonly string[]).includes(n),
      `hook ${n} must never be on the console allowlist`);
  }

  // CONTROL — clean parent + clean child passes the tripwire.
  assertSpawnTripwire({ PATH: "/p", HOME: "/h" }, "parent");
  assertSpawnTripwire({ PATH: "/p", HOME: "/h" }, "child");

  // MUTANT — refused name in the CHILD env trips the child surface.
  let childErr: EnvRefusedError | null = null;
  try { assertSpawnTripwire({ PATH: "/p", XAI_BUILDER_DEFECT: "x" }, "child"); }
  catch (e) { if (e instanceof EnvRefusedError) childErr = e; else throw e; }
  assert.ok(childErr && childErr.surface === "child" && childErr.refusedNames.includes("XAI_BUILDER_DEFECT"),
    "R1 MUTANT: child-env refused name trips surface=child");

  // MUTANT — refused name in the parent trips the parent surface.
  let parentErr: EnvRefusedError | null = null;
  try { assertSpawnTripwire({ PATH: "/p", AWS_PARENT_LEAK: "x" }, "parent"); }
  catch (e) { if (e instanceof EnvRefusedError) parentErr = e; else throw e; }
  assert.ok(parentErr && parentErr.surface === "parent" && parentErr.refusedNames.includes("AWS_PARENT_LEAK"),
    "R1 MUTANT: parent-env refused name trips surface=parent");

  console.log("PASS R1: closed console env constructs (hooks/unlisted/empty dropped), allowlist ∩ hook-denylist empty, parent+child tripwire surfaces distinct.");
}

main();
