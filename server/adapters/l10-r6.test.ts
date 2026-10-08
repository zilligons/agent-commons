/**
 * L10 rework 3 — R6 poles: atomic single-use run-id reservation.
 *
 * CONTROL: a fresh id reserves and completes; the same id reused
 *   sequentially refuses rc 64.
 * MUTANT: two CONCURRENT harness launches with the same id — exactly
 *   one reserves; the other refuses rc 64 (an earlier probe measured both accepted
 *   under the read-list-then-append design).
 *
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname; // <root>/
const HARNESS2 = join(ROOT, "packages/agent-commons/scripts/l10-twopole.ts");
const TSX2 = join(ROOT, "node_modules/.bin/tsx");

function runHarness(runId: string, evidenceDir?: string): Promise<{ rc: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    const args = [HARNESS2, "--slot=continuity", `--run-id=${runId}`];
    if (evidenceDir) {
      args.push(`--evidence-dir=${evidenceDir}`);
    }
    const child = spawn(TSX2, args, {
      cwd: ROOT,
      env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", HOME: process.env.HOME! },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", (e: Error) => resolve({ rc: null, out: out + `\nSPAWN-ERROR: ${e.message}` }));
    child.on("close", (code) => resolve({ rc: code, out }));
  });
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "l10-r6-"));
  const scratchEvidence = join(scratch, "evidence");
  const id = `r6-${Date.now()}`;
  try {
    // CONTROL — fresh id runs; sequential reuse refuses.
    const first = await runHarness(id, scratchEvidence);
    assert.equal(first.rc, 0, `CONTROL: fresh id completes (got rc=${first.rc}: ${first.out.slice(-200)})`);
    const second = await runHarness(id, scratchEvidence);
    assert.equal(second.rc, 64, "CONTROL: sequential reuse refuses rc 64");

    // MUTANT — concurrent same-id launches: exactly one wins.
    const id2 = `r6c-${Date.now()}`;
    const [c1, c2] = await Promise.all([runHarness(id2, scratchEvidence), runHarness(id2, scratchEvidence)]);
    const results = [c1.rc, c2.rc].sort();
    assert.deepEqual(results, [0, 64],
      `MUTANT: concurrent same-id must be exactly one 0 and one 64 (got ${JSON.stringify(results)})`);

    // The reservation file exists per id (ownership recorded).
    assert.ok(existsSync(join(scratchEvidence, `run-${id}.reserved`)),
      "reservation file carries ownership");
    console.log("PASS R6: fresh id completes; sequential reuse rc 64; concurrent same-id exactly one winner (0 + 64); reservation file records ownership.");
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
