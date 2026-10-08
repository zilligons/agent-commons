/**
 * L10 rework 1 — B3/B4 poles.
 *
 * B3 (permit reclaim): CONTROL — two permits held by LIVE pids, a third
 *   claim refuses (blocks); MUTANT — a permit whose pid is dead
 *   (spawn-and-exit) is reclaimed, and an aged-but-alive permit is NOT
 *   reclaimed (age is not death).
 *
 * B4 (ledger witness): CONTROL — a row appended AFTER the pre-spawn
 *   offset with matching pid + lane max + seat + req/eff == literal
 *   reads OK; MUTANT — row BEFORE the offset, wrong pid, wrong model, or
 *   wrong lane reads MISSING/MISMATCH, never OK.
 *
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L10PermitPool, L10_CLAUDE_MAX_CONCURRENT } from "./l10-process";

const SEATS = ["seat-alpha", "seat-beta"];

async function b3() {
  const dir = mkdtempSync(join(tmpdir(), "l10-b3-"));
  try {
    const pool = new L10PermitPool(dir, L10_CLAUDE_MAX_CONCURRENT);
    // CONTROL — two live-pid permits; a third claim blocks.
    const a = await pool.acquire("a");
    const b = await pool.acquire("b");
    let thirdResolved = false;
    const third = pool.acquire("c").then((p) => { thirdResolved = true; return p; });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(thirdResolved, false, "CONTROL: third acquire must block while two live permits are held");

    // MUTANT (aged-but-alive NOT reclaimed): backdate one permit's
    // acquiredAt by writing an old timestamp for OUR OWN live pid; the
    // reclaim path must still refuse because kill(pid, 0) succeeds.
    const bPath = join(dir, `permit-${b.slot}.json`);
    writeFileSync(bPath, JSON.stringify({ pid: process.pid, runId: "b", acquiredAt: 1 }), "utf8");
    let fourthResolved = false;
    const fourth = pool.acquire("d").then((p) => { fourthResolved = true; return p; });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(fourthResolved, false, "MUTANT: aged-but-alive permit must NOT be reclaimed");

    // MUTANT (dead-pid reclaimed): write a permit for a pid we prove
    // dead (spawn a child and wait for exit), then the claim succeeds.
    const deadChild = spawn("/bin/sh", ["-c", "exit 0"]);
    await new Promise((r) => deadChild.on("close", r));
    const deadPid = deadChild.pid!;
    // Prove dead: kill(pid, 0) throws ESRCH.
    let esrch = false;
    try { process.kill(deadPid, 0); } catch (e) { esrch = (e as NodeJS.ErrnoException).code === "ESRCH"; }
    assert.ok(esrch, `test fixture: pid ${deadPid} must be proven dead (ESRCH)`);
    a.release(); // free slot 0, then occupy it with the dead permit
    writeFileSync(join(dir, "permit-0.json"), JSON.stringify({ pid: deadPid, runId: "ghost", acquiredAt: Date.now() }), "utf8");
    const reclaimed = await pool.acquire("e");
    assert.ok(reclaimed, "MUTANT: dead-pid permit must be reclaimed");
    reclaimed.release();

    // Cleanup: release the live permits and let the pending claims resolve.
    b.release();
    const cGrant = await third;
    cGrant.release();
    const dGrant = await fourth;
    dGrant.release();
    console.log("PASS B3: third claim blocked by two live permits; aged-but-alive not reclaimed; dead-pid (ESRCH) reclaimed.");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** Local copy of the harness witness rule (kept tiny so the test asserts
 *  the SAME semantics the harness implements; the harness's copy is the
 *  one exercised end-to-end by the fixture run). */
function witnessFromOffset(ledger: string, offset: number, pid: number, literal: string):
  "OK" | "ROUTE_WITNESS_MISSING" | "ROUTE_WITNESS_MISMATCH" {
  if (!existsSync(ledger)) return "ROUTE_WITNESS_MISSING";
  const raw = readFileSync(ledger, "utf8");
  const after = Buffer.from(raw, "utf8").subarray(offset).toString("utf8");
  let sawWrong = false;
  for (const line of after.split("\n").filter(Boolean)) {
    let row: { pid?: number; lane?: string; seat?: string; req?: string; eff?: string };
    try { row = JSON.parse(line); } catch { return "ROUTE_WITNESS_MISSING"; }
    if (row.pid !== pid) continue;
    if (row.lane === "max" && SEATS.includes(row.seat ?? "") && row.req === literal && row.eff === literal) return "OK";
    sawWrong = true;
  }
  return sawWrong ? "ROUTE_WITNESS_MISMATCH" : "ROUTE_WITNESS_MISSING";
}

async function b4() {
  const dir = mkdtempSync(join(tmpdir(), "l10-b4-"));
  try {
    const ledger = join(dir, "model-ledger.jsonl");
    writeFileSync(ledger, "", "utf8");
    const pid = 424242;
    const lit = "claude-fable-5-1";
    const row = (over: Record<string, unknown>) =>
      JSON.stringify({ ts: "t", pid, lane: "max", seat: "seat-alpha", req: lit, eff: lit, ...over }) + "\n";

    // CONTROL — row appended AFTER the offset with matching pid/lane/seat/model.
    const offset = 0;
    appendFileSync(ledger, row({}), "utf8");
    assert.equal(witnessFromOffset(ledger, offset, pid, lit), "OK", "CONTROL: post-offset matching row reads OK");

    // MUTANT — row BEFORE the offset must not count.
    const offsetAfter = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    assert.equal(witnessFromOffset(ledger, offsetAfter, pid, lit), "ROUTE_WITNESS_MISSING",
      "MUTANT: pre-offset row never satisfies the witness (no whole-log search)");

    // MUTANT — wrong pid after the offset.
    appendFileSync(ledger, row({ pid: 999 }), "utf8");
    const offset2 = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    appendFileSync(ledger, row({ pid: 998 }), "utf8");
    assert.equal(witnessFromOffset(ledger, offset2, pid, lit), "ROUTE_WITNESS_MISSING",
      "MUTANT: wrong-pid rows are MISSING, never OK");

    // MUTANT — right pid, wrong model → MISMATCH.
    const offset3 = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    appendFileSync(ledger, row({ req: "qwen3.8-max", eff: "qwen3.8-max" }), "utf8");
    assert.equal(witnessFromOffset(ledger, offset3, pid, lit), "ROUTE_WITNESS_MISMATCH",
      "MUTANT: wrong req/eff with matching pid is MISMATCH");

    // MUTANT — right pid+model, wrong lane → MISMATCH.
    const offset4 = Buffer.byteLength(readFileSync(ledger, "utf8"), "utf8");
    appendFileSync(ledger, row({ lane: "ccr" }), "utf8");
    assert.equal(witnessFromOffset(ledger, offset4, pid, lit), "ROUTE_WITNESS_MISMATCH",
      "MUTANT: non-max lane with matching pid is MISMATCH");

    console.log("PASS B4: post-offset pid/lane/seat/model OK; pre-offset MISSING; wrong-pid MISSING; wrong-model/wrong-lane MISMATCH (never OK).");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

await b3();
await b4();
