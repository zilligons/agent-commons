/**
 * L10 rework 1 — B2 poles: frozen absolute Python interpreter (the security reviewer B2).
 *
 * CONTROL: the frozen absolute interpreter resolves on the host PATH and
 * runs `python -c print("OK")` under the CLOSED child PATH (which
 * contains no `python`) — the absolute argv[0] makes the child PATH
 * irrelevant to the spawn itself.
 *
 * MUTANT: bare `spawn("python", …)` under the same closed PATH returns
 * ENOENT (the slice-1 regression the security reviewer measured).
 *
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PYTHON_ABS, resolvePythonAbs } from "./l10-process";

const CLOSED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ rc: number | null; error: Error | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", (e: Error) => resolve({ rc: null, error: e, out }));
    child.on("close", (code) => resolve({ rc: code, error: null, out }));
  });
}

async function main() {
  // Resolution sanity: python resolves on this host's PATH.
  const resolved = resolvePythonAbs(process.env.PATH ?? "");
  assert.ok(resolved, "python must resolve on the host PATH");
  assert.equal(PYTHON_ABS, resolved, "module-frozen path equals one resolution");

  // CONTROL — absolute interpreter + closed child PATH works.
  const control = await run(PYTHON_ABS!, ["-c", 'print("OK")'], { PATH: CLOSED_PATH });
  assert.equal(control.error, null, `CONTROL: absolute python must spawn (got ${control.error})`);
  assert.equal(control.rc, 0, `CONTROL rc=${control.rc}`);
  assert.equal(control.out.trim(), "OK", "CONTROL stdout OK");

  // MUTANT — bare `python` under the same closed PATH is ENOENT
  // (the exact regression the security reviewer measured at the three spawn sites).
  const mutant = await run("python", ["-c", 'print("OK")'], { PATH: CLOSED_PATH });
  assert.ok(mutant.error, "MUTANT: bare python under closed PATH must fail");
  assert.match(mutant.error!.message, /ENOENT/, `MUTANT error must be ENOENT (got ${mutant.error!.message})`);

  console.log(`PASS B2: CONTROL absolute ${PYTHON_ABS} under closed PATH rc=0 stdout=OK; MUTANT bare python ENOENT.`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
