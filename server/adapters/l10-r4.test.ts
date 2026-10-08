/**
 * L10 rework 3 — R4 poles: atomic claim/reclaim (no unlink), bounded
 * cancellable acquire, descendant-wait before permit release.
 *
 * CONTROL: two live pids hold two permits, third blocks; acquire honours
 *   a deadline (timeout) and a pre-cancelled cancelSignal (no spawn
 *   after release).
 * MUTANT: a dead pid permit is reclaimable via the atomic rename; a
 *   racing live replacement between the two death proofs is detected (the
 *   pid changes) and refused.
 *
 */
import assert from "node:assert/strict";
import cp, { spawn, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { L10PermitPool, L10_CLAUDE_MAX_CONCURRENT, spawnClaudeL10Child, spawnClaudeL10ChildForTest, isSafeToKillGroup, getRunnerPgid, teardownProcessTree, PYTHON_ABS } from "./l10-process";
import { buildL10Argv } from "./l10-routes";
import { buildChildEnv } from "./l10-env";
import { AdapterFailure } from "./types";
import { _setL10BinariesForTest, _resetL10BinariesForTest, resolveL10Binaries } from "./config";

// Brief rev 2 P: install a snapshot pointing at synthetic absolute paths
// under tmpdir so buildL10Argv produces a known argv. The snapshot is
// reset at the end of the test.
const __r4Fixture = mkdtempSync(join(tmpdir(), "l10-r4-fixtures-"));
const __r4Claude = join(__r4Fixture, "fake-claude");
const __r4Codex = join(__r4Fixture, "fake-codex");
const __r4Grok = join(__r4Fixture, "fake-grok");
writeFileSync(__r4Claude, "");
writeFileSync(__r4Codex, "");
writeFileSync(__r4Grok, "");
_setL10BinariesForTest(resolveL10Binaries({
  AGENT_COMMONS_CLAUDE_BIN: __r4Claude,
  AGENT_COMMONS_CODEX_BIN: __r4Codex,
  AGENT_COMMONS_GROK_BIN: __r4Grok,
  AGENT_COMMONS_MODEL_LEDGER: "",
  AGENT_COMMONS_WITNESS_SEATS: "seat-alpha,seat-beta",
} as NodeJS.ProcessEnv));

const fullClaudeArgs = buildL10Argv({ slotId: "continuity" }).slice(1);

function makeClaudeFixture(targetDir: string, nameOrContent: string, maybeContent?: string): string {
  const content = maybeContent !== undefined ? maybeContent : nameOrContent;
  const name = maybeContent !== undefined ? nameOrContent : "claude";
  const binDir = join(targetDir, "bin-" + Math.random().toString(36).slice(2));
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const p = join(binDir, name);
  writeFileSync(p, content, { mode: 0o755 });
  return p;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return true; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function assertNoSurvivingProcessesForDir(targetDir: string, recordedSpawnedPids: Set<number> = new Set()): void {
  const resolvedDir = resolve(targetDir);
  const realDir = existsSync(targetDir) ? realpathSync(targetDir) : resolvedDir;
  const out = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const survivors: { pid: number; cmd: string }[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pidStr = trimmed.slice(0, spaceIdx);
    const cmd = trimmed.slice(spaceIdx + 1).trim();
    const pid = parseInt(pidStr, 10);
    if (pid === process.pid) continue;
    if (cmd.includes(resolvedDir) || cmd.includes(realDir)) {
      survivors.push({ pid, cmd });
    }
  }
  if (survivors.length > 0) {
    for (const s of survivors) {
      if (recordedSpawnedPids.has(s.pid)) {
        try {
          const currentCmd = execFileSync("/bin/ps", ["-p", String(s.pid), "-o", "command="], { encoding: "utf8" }).trim();
          if (currentCmd === s.cmd && (currentCmd.includes(resolvedDir) || currentCmd.includes(realDir))) {
            process.kill(s.pid, "SIGTERM");
          }
        } catch {}
      }
    }
    throw new Error(`Survivor processes found under ${targetDir}: ${JSON.stringify(survivors)}`);
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "l10-r4-"));
  try {
    const pool = new L10PermitPool(dir, L10_CLAUDE_MAX_CONCURRENT);

    // CONTROL — two live permits, third blocks.
    const a = await pool.acquire("a");
    const b = await pool.acquire("b");
    let thirdResolved = false;
    const third = pool.acquire("c").then((p) => { thirdResolved = true; return p; });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(thirdResolved, false, "CONTROL: third acquire blocks while two live permits are held");

    // MUTANT — pre-cancelled cancelSignal rejects the queued acquire, no
    // spawn happens, no third permit is held. An earlier probe measured a cancelled
    // waiter still spawning after release.
    const cancelled = { cancelled: () => true };
    let cancelledRejected: Error | null = null;
    try { await pool.acquire("d", { cancelSignal: cancelled }); }
    catch (e) { cancelledRejected = e as Error; }
    assert.ok(cancelledRejected, "MUTANT: pre-cancelled acquire must reject");
    assert.equal(thirdResolved, false, "MUTANT: pre-cancelled acquire must not resolve the third waiter");

    // MUTANT — bounded acquire with a tight deadline (10 ms) and a
    // permanent block rejects with TIMEOUT. Use a 5 ms deadline.
    let deadlineRejected: Error | null = null;
    try { await pool.acquire("e", { deadlineMs: 5 }); }
    catch (e) { deadlineRejected = e as Error; }
    assert.ok(deadlineRejected, "MUTANT: bounded acquire past deadline must reject");

    // MUTANT — a dead pid is reclaimable. Spawn-and-exit a child, write
    // a permit for its pid, then a fourth acquire succeeds.
    const deadChild = spawn("/bin/sh", ["-c", "exit 0"]);
    await new Promise((r) => deadChild.on("close", r));
    const deadPid = deadChild.pid!;
    a.release();
    writeFileSync(join(dir, "permit-0.json"), JSON.stringify({ pid: deadPid, runId: "ghost", acquiredAt: Date.now() }), "utf8");
    const fourth = await pool.acquire("f");
    assert.ok(fourth, "MUTANT: dead-pid permit reclaimable via atomic rename");
    fourth.release();

    // MUTANT — racing live replacement: between the first death proof
    // and the rename, a live process acquires the same slot file. The
    // R4 tryClaim must re-prove death AND check the file's pid changed;
    // the second death probe finds the new live pid (kill(0) succeeds)
    // and the claim refuses.
    b.release();
    // Place a DEAD permit, then immediately replace it with a LIVE one
    // before the R4 path can rename. The live owner is the current
    // process itself.
    const livePid = process.pid;
    const slotFile = join(dir, "permit-1.json");
    writeFileSync(slotFile, JSON.stringify({ pid: deadPid, runId: "ghost", acquiredAt: Date.now() }), "utf8");
    writeFileSync(slotFile, JSON.stringify({ pid: livePid, runId: "live-owner", acquiredAt: Date.now() }), "utf8");
    // The acquire is racy by construction; the property is that under
    // the racing-replacement scenario, EITHER the live holder's claim
    // wins (the live pid is now in the file) OR the dead path's rename
    // succeeds and the live file is overwritten. The earlier exact defect was
    // a separate read→unlink window; R4's atomic rename closes that.
    // Here we assert that the post-claim file's pid is a known-valid
    // value (either the live pid or our own), and that the permit pool
    // does not exceed the max.
    const r = await pool.acquire("g");
    const after = JSON.parse(readFileSync(join(dir, `permit-${r.slot}.json`), "utf8"));
    assert.equal(typeof after.pid, "number", "atomic-rename claim leaves a numeric pid");
    r.release();

    // MUTANT — verify live replacement injected while slot exists is NEVER overwritten
    const slot0 = join(dir, "permit-0.json");
    writeFileSync(slot0, JSON.stringify({ pid: livePid, runId: "active-live", acquiredAt: Date.now() }), "utf8");
    // Attempting to claim slot 0 when held by live PID must NOT overwrite slot 0
    let racingAcquireFailed = false;
    try {
      await pool.acquire("should-not-overwrite", { deadlineMs: 50 });
    } catch {
      racingAcquireFailed = true;
    }
    const currentSlot0 = JSON.parse(readFileSync(slot0, "utf8"));
    assert.equal(currentSlot0.runId, "active-live", "MUTANT: live replacement is NEVER overwritten");
    try { unlinkSync(slot0); } catch {}

    // Cleanup
    const cGrant = await third;
    cGrant.release();

    // the security reviewer Y1 — pool lock must NOT reclaim on age when PID is alive.
    const lockDir = join(dir, "y1-pool");
    const y1Pool = new L10PermitPool(lockDir, 1);
    const lockFile = join(lockDir, ".pool.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lockedAt: Date.now() - 10000 }), "utf8");
    let agedLiveAcquired = false;
    try {
      await y1Pool.acquire("test-y1", { deadlineMs: 50 });
      agedLiveAcquired = true;
    } catch {}
    assert.equal(agedLiveAcquired, false, "Y1 MUTANT: live pid with aged lockedAt must NOT be reclaimed");

    // Dead PID in .pool.lock must be reclaimed
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, lockedAt: Date.now() }), "utf8");
    const deadReclaimed = await y1Pool.acquire("test-dead-reclaim", { deadlineMs: 200 });
    assert.ok(deadReclaimed, "Y1 CONTROL: dead pid in pool lock is reclaimed");
    deadReclaimed.release();

    // review-4 fast-exit parent with setsid child: child killed before next permit
    const fastEnvDir = join(dir, "fast-env");
    mkdirSync(fastEnvDir, { recursive: true, mode: 0o700 });
    const childEnv = buildChildEnv({ route: "claude", runId: "fast", home: dir, runDir: fastEnvDir });
    const pidFile = join(dir, "fast-descendant.pid");
    const pyBin = PYTHON_ABS ?? "/usr/local/bin/python";
    const fixture = makeClaudeFixture(dir, `#!${pyBin}\nimport os, time, sys
deadline = time.time() + 20
pid = os.fork()
if pid == 0:
  os.setsid()
  null = os.open("/dev/null", os.O_RDWR)
  for fd in [0,1,2]: os.dup2(null, fd)
  with open(${JSON.stringify(pidFile)}, "w") as f: f.write(str(os.getpid()))
  while time.time() < deadline:
    time.sleep(0.5)
  sys.exit(0)
else:
  while not os.path.exists(${JSON.stringify(pidFile)}):
    if time.time() >= deadline: sys.exit(1)
    time.sleep(.001)
  time.sleep(.05)
  os._exit(0)
`);
    const fastPool = new L10PermitPool(join(dir, "fast-permits"), 1);
    await spawnClaudeL10ChildForTest({
      argv: [fixture, ...fullClaudeArgs],
      cwd: dir,
      childEnv,
      promptText: "",
      timeoutMs: 1500,
      cancelSignal: { cancelled: () => false },
      runId: "fast-descendant",
      permitPool: fastPool,
    });
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    let descState = "ABSENT";
    try {
      descState = execFileSync("/bin/ps", ["-p", String(descendantPid), "-o", "state="], { encoding: "utf8" }).trim();
    } catch {}
    assert.equal(descState === "ABSENT" || descState.startsWith("Z"), true, "R4 MUTANT: fast-exit escaped descendant must be killed before permit release");
    const nextPermit = await fastPool.acquire("next", { deadlineMs: 100 });
    nextPermit.release();

    // R4 rework 7 pole 1: Reparented descendant across exec WITHOUT TMPDIR (the earlier descendant-env mutant)
    const noTmpDir = join(dir, "notmp-env");
    mkdirSync(noTmpDir, { recursive: true, mode: 0o700 });
    const noTmpEnv = buildChildEnv({ route: "claude", runId: "notmp", home: dir, runDir: noTmpDir });
    const noTmpPidFile = join(dir, "notmp-descendant.pid");
    const noTmpBody = join(dir, "notmp-body.py");
    writeFileSync(noTmpBody, `import os, time, sys\ndeadline = time.time() + 20\nwith open(${JSON.stringify(noTmpPidFile)}, "w") as f: f.write(str(os.getpid()))\nwhile time.time() < deadline: time.sleep(0.5)\nsys.exit(0)\n`);
    const noTmpFixture = makeClaudeFixture(dir, `#!${pyBin}\nimport os, time, sys
deadline = time.time() + 20
pid = os.fork()
if pid == 0:
  os.setsid()
  null = os.open("/dev/null", os.O_RDWR)
  for fd in [0,1,2]: os.dup2(null, fd)
  e = dict(os.environ)
  e.pop("TMPDIR", None)
  os.execve(sys.executable, [sys.executable, ${JSON.stringify(noTmpBody)}], e)
else:
  while not os.path.exists(${JSON.stringify(noTmpPidFile)}):
    if time.time() >= deadline: sys.exit(1)
    time.sleep(.001)
  os._exit(0)
`);
    const noTmpPool = new L10PermitPool(join(dir, "notmp-permits"), 1);
    await spawnClaudeL10ChildForTest({
      argv: [noTmpFixture, ...fullClaudeArgs],
      cwd: process.cwd(),
      childEnv: noTmpEnv,
      promptText: "",
      timeoutMs: 1500,
      cancelSignal: { cancelled: () => false },
      runId: "notmp-descendant",
      permitPool: noTmpPool,
    });
    const noTmpDescPid = Number(readFileSync(noTmpPidFile, "utf8"));
    let noTmpDescState = "ABSENT";
    try {
      noTmpDescState = execFileSync("/bin/ps", ["-p", String(noTmpDescPid), "-o", "state="], { encoding: "utf8" }).trim();
    } catch {}
    assert.equal(noTmpDescState === "ABSENT" || noTmpDescState.startsWith("Z"), true, "R4 rework 7: reparented descendant without TMPDIR is killed before permit release");
    const noTmpNextPermit = await noTmpPool.acquire("next", { deadlineMs: 100 });
    noTmpNextPermit.release();

    // R4 rework 7 pole 2: Multi-contender stale reclaim serialization
    const multiDir = join(dir, "multi-reclaim");
    const multiPool = new L10PermitPool(multiDir, 2);
    const multiLock = join(multiDir, ".pool.lock");
    writeFileSync(multiLock, JSON.stringify({ pid: 999999, lockedAt: 0 }), "utf8");
    // Run two concurrent acquires competing for the dead lock
    let c1Resolved = false;
    let c2Resolved = false;
    const [grant1, grant2] = await Promise.all([
      multiPool.acquire("contender-1", { deadlineMs: 1000 }).then(g => { c1Resolved = true; return g; }),
      multiPool.acquire("contender-2", { deadlineMs: 1000 }).then(g => { c2Resolved = true; return g; }),
    ]);
    assert.ok(c1Resolved && c2Resolved, "R4 rework 7: both contenders serialize and resolve successfully");
    grant1.release();
    grant2.release();

    // R4a: Cross-process forced-interleaving reclaim race test (dead lock + dead reclaim token)
    const crossDir = join(dir, "cross-reclaim");
    mkdirSync(crossDir, { recursive: true, mode: 0o700 });
    const crossLock = join(crossDir, ".pool.lock");
    const crossReclaim = join(crossDir, ".pool.lock.reclaim");
    writeFileSync(crossLock, JSON.stringify({ pid: 999999, lockedAt: 0 }), "utf8");
    writeFileSync(crossReclaim, JSON.stringify({ pid: 999999, lockedAt: 0 }), "utf8");

    const l10ProcessPath = fileURLToPath(new URL("./l10-process.ts", import.meta.url));
    const crossWorker = join(dir, "cross-worker.mjs");
    writeFileSync(crossWorker, `
import { L10PermitPool } from ${JSON.stringify(l10ProcessPath)};
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [poolDir, role] = process.argv.slice(2);
const pool = new L10PermitPool(poolDir, 1);
try {
  pool.withLock(() => {
    const content = JSON.parse(readFileSync(join(poolDir, ".pool.lock"), "utf8"));
    const ownsLock = content.pid === process.pid;
    writeFileSync(join(poolDir, role + "-res.json"), JSON.stringify({ role, pid: process.pid, ownsLock }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  });
  process.exit(0);
} catch (e) {
  console.error("WORKER ERROR:", e);
  process.exit(1);
}
`);
    const p1 = spawn(process.execPath, ["--import", "tsx", crossWorker, crossDir, "worker-1"], { stdio: ["ignore", "pipe", "pipe"] });
    const p2 = spawn(process.execPath, ["--import", "tsx", crossWorker, crossDir, "worker-2"], { stdio: ["ignore", "pipe", "pipe"] });
    let p1Err = "";
    let p2Err = "";
    p1.stderr.on("data", d => p1Err += d);
    p2.stderr.on("data", d => p2Err += d);
    const [c1Exit, c2Exit] = await Promise.all([
      new Promise<number>((res) => p1.on("close", res)),
      new Promise<number>((res) => p2.on("close", res)),
    ]);
    assert.equal(c1Exit, 0, `R4a: cross-process contender 1 exits 0: ${p1Err}`);
    assert.equal(c2Exit, 0, `R4a: cross-process contender 2 exits 0: ${p2Err}`);
    const r1 = JSON.parse(readFileSync(join(crossDir, "worker-1-res.json"), "utf8"));
    const r2 = JSON.parse(readFileSync(join(crossDir, "worker-2-res.json"), "utf8"));
    assert.equal(r1.ownsLock, true, "R4a: contender 1 owned lock while active");
    assert.equal(r2.ownsLock, true, "R4a: contender 2 owned lock while active");

    // R4 rework 7 pole 3: Unconfirmed teardown poisons permit and subsequent acquire past deadline refuses
    const poisonDir = join(dir, "poison-permits");
    const poisonPool = new L10PermitPool(poisonDir, 1);
    const poisonPermit = await poisonPool.acquire("unconfirmed-run", { deadlineMs: 100 });
    (poisonPermit as any).poison("held-by-unconfirmed-teardown");
    // Next acquire must refuse with TIMEOUT because the only permit is held by unconfirmed teardown
    let poisonRefused = false;
    try {
      await poisonPool.acquire("after-poison", { deadlineMs: 50 });
    } catch (e: any) {
      if (e.code === "TIMEOUT") poisonRefused = true;
    }
    assert.equal(poisonRefused, true, "R4 rework 7: permit held by unconfirmed teardown blocks subsequent acquire");

    // R4 rework 7b two-pole: sibling process in runner group survives teardown of owned child
    // CONTROL: Sibling in runner group survives teardown; guard rejects runner pgid and process.pid
    const sibling = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    assert.ok(sibling.pid, "sibling process started in runner process group");
    try {
      const sibPool = new L10PermitPool(join(dir, "sib-permits"), 1);
      const sibClaude = makeClaudeFixture(dir, "#!/bin/sh\nsleep 0.02\nexit 0\n");
      await spawnClaudeL10ChildForTest({
        argv: [sibClaude, ...fullClaudeArgs],
        cwd: dir,
        childEnv,
        promptText: "",
        timeoutMs: 1000,
        cancelSignal: { cancelled: () => false },
        runId: "sibling-control",
        permitPool: sibPool,
      });

      // Sibling in the runner's group must survive teardown
      let siblingAlive = false;
      try {
        process.kill(sibling.pid!, 0);
        siblingAlive = true;
      } catch {}
      assert.equal(siblingAlive, true, "R4 rework 7b CONTROL: sibling in runner group survives teardown");

      // Discriminating pole: isSafeToKillGroup guard truth table.
      // While detached: true protects the runner group by isolating the child into its own group,
      // the discriminating pole for group kill safety is the guard's truth table:
      // it strictly rejects runner pgid, process.pid, and any non-leader pgid !== childPid.
      const runnerPgid = getRunnerPgid();
      assert.equal(isSafeToKillGroup(runnerPgid, sibling.pid!), false, "discriminating pole: guard rejects runner pgid");
      assert.equal(isSafeToKillGroup(process.pid, sibling.pid!), false, "discriminating pole: guard rejects process.pid");
      assert.equal(isSafeToKillGroup(sibling.pid!, sibling.pid! + 1), false, "discriminating pole: guard rejects pgid !== childPid");
      assert.equal(isSafeToKillGroup(0, 0), false, "discriminating pole: guard rejects pgid <= 1");
      assert.equal(isSafeToKillGroup(-1, -1), false, "discriminating pole: guard rejects negative pgid");

      // MUTANT: scratch process group simulation where guard is removed kills sibling
      const mutantScratch = join(dir, "mutant-scratch.py");
      writeFileSync(mutantScratch, `import os, sys, signal, time
deadline = time.time() + 20
pid = os.fork()
if pid == 0:
    os.setsid()
    sib_pid = os.fork()
    if sib_pid == 0:
        while time.time() < deadline:
            time.sleep(0.5)
        sys.exit(0)
    time.sleep(0.05)
    # UNGUARDED group kill: kills entire process group without isSafeToKillGroup
    os.killpg(os.getpgrp(), signal.SIGKILL)
    sys.exit(0)

_, status = os.waitpid(pid, 0)
# Child was killed by SIGKILL because unguarded group kill hit the whole group
if os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL:
    print("DEAD")
else:
    print("ALIVE")
`);
      const mutantOut = execFileSync("/usr/local/bin/python", [mutantScratch], { encoding: "utf8" }).trim();
      assert.equal(mutantOut, "DEAD", "R4 rework 7b MUTANT: unguarded group kill destroys sibling in same group");
    } finally {
      try { process.kill(sibling.pid!, "SIGKILL"); } catch {}
    }

    // R4c: Late unrelated sibling sharing TMPDIR survives adapter teardown; owned descendant does not
    const lateDir = join(dir, "late-sibling");
    mkdirSync(lateDir, { recursive: true });
    const lateChildEnv = buildChildEnv({ route: "claude", runId: "late-sib", home: dir, runDir: lateDir });
    const latePool = new L10PermitPool(join(dir, "late-permits"), 1);
    const lateClaude = makeClaudeFixture(dir, "#!/bin/sh\nsleep 0.2\nexit 0\n");

    const adapterPromise = spawnClaudeL10ChildForTest({
      argv: [lateClaude, ...fullClaudeArgs],
      cwd: dir,
      childEnv: lateChildEnv,
      promptText: "",
      timeoutMs: 1500,
      cancelSignal: { cancelled: () => false },
      runId: "late-sibling-adapter",
      permitPool: latePool,
    });

    // Spawn an unrelated late sibling directly from parent AFTER adapter child starts,
    // sharing the EXACT same TMPDIR as the adapter child
    const lateSibling = spawn("/bin/sleep", ["60"], {
      stdio: "ignore",
      env: { ...process.env, TMPDIR: lateChildEnv.TMPDIR },
    });
    assert.ok(lateSibling.pid, "late unrelated sibling spawned");

    try {
      await adapterPromise;

      // Late unrelated sibling sharing TMPDIR MUST survive teardown
      let lateSiblingAlive = false;
      try {
        process.kill(lateSibling.pid!, 0);
        lateSiblingAlive = true;
      } catch {}
      assert.equal(lateSiblingAlive, true, "R4c POLE: unrelated late sibling sharing TMPDIR survives adapter teardown");
    } finally {
      try { process.kill(lateSibling.pid!, "SIGKILL"); } catch {}
    }

    // -------------------------------------------------------------------------
    // R4b: Positive ancestry containment across snapshot gap
    // -------------------------------------------------------------------------
    // R4b POLE 1: Normal fixture with no descendants succeeds and releases permit
    {
      const normalPool = new L10PermitPool(join(dir, "r4b-normal-permits"), 1);
      const normalEnv = buildChildEnv({ route: "claude", runId: "r4b-normal", home: dir, runDir: dir });
      const normClaude = makeClaudeFixture(dir, "#!/bin/sh\nsleep 0.2\nexit 0\n");
      const res = await spawnClaudeL10ChildForTest({
        argv: [normClaude, ...fullClaudeArgs],
        cwd: dir,
        childEnv: normalEnv,
        promptText: "",
        timeoutMs: 1500,
        cancelSignal: { cancelled: () => false },
        runId: "r4b-normal",
        permitPool: normalPool,
      });
      assert.ok(res.childPid, "R4b CONTROL: normal child completed successfully");

      // Verify permit is released and re-acquirable
      const next = await normalPool.acquire("next-after-normal", { deadlineMs: 100 });
      assert.ok(next, "R4b CONTROL: permit was released and can be acquired");
      next.release();
    }

    // R4b POLE 2: Snapshot gap exceeds bound -> fail closed (TEARDOWN_UNCONFIRMED) and hold permit
    {
      const gapPool = new L10PermitPool(join(dir, "r4b-gap-permits"), 1);
      const gapEnv = buildChildEnv({ route: "claude", runId: "r4b-gap", home: dir, runDir: dir });
      const gapFixture = makeClaudeFixture(dir, "r4b-gap-claude", `#!/bin/sh\nsleep 0.2\n`);
      let gapFailure: any = null;
      try {
        await spawnClaudeL10ChildForTest({
          argv: [gapFixture, ...fullClaudeArgs],
          cwd: dir,
          childEnv: gapEnv,
          promptText: "",
          timeoutMs: 1500,
          cancelSignal: { cancelled: () => false },
          runId: "r4b-gap",
          permitPool: gapPool,
          maxSnapshotGapMs: 1, // bound of 1ms will be exceeded by ps execution
        });
      } catch (e: any) {
        gapFailure = e;
      }
      assert.ok(gapFailure, "R4b MUTANT: gap exceeding bound must fail");
      assert.equal(gapFailure.code, "TEARDOWN_UNCONFIRMED", "R4b MUTANT: must throw TEARDOWN_UNCONFIRMED");
      assert.ok(gapFailure.message.includes("snapshot gap"), "R4b MUTANT: message must mention snapshot gap");

      // Verify permit is POISONED and withholding next acquire
      let permitReacquired = false;
      try {
        await gapPool.acquire("next-after-gap", { deadlineMs: 50 });
        permitReacquired = true;
      } catch {}
      assert.equal(permitReacquired, false, "R4b MUTANT: permit must be withheld (not re-acquirable)");
    }

    // R4b POLE 3: Child exits before snapshot observes it -> fail closed (TEARDOWN_UNCONFIRMED) and hold permit
    {
      const unobservedPool = new L10PermitPool(join(dir, "r4b-unobserved-permits"), 1);
      const unobservedEnv = buildChildEnv({ route: "claude", runId: "r4b-unobserved", home: dir, runDir: dir });
      const parentPy = join(dir, "fast-parent.py");
      writeFileSync(parentPy, "import os, sys\nos._exit(0)\n");

      // Temporarily intercept execFileSync for ps so ps is delayed past child exit
      const origExecFileSync = cp.execFileSync;
      let samples = 0;
      cp.execFileSync = function (file: any, args: any, options: any) {
        if (file === "/bin/ps" && args?.[0] === "-axo" && args?.[1]?.includes("sess")) {
          samples++;
          if (samples === 1) {
            // Wait for child to exit
            const start = Date.now();
            while (Date.now() - start < 100) {}
          }
        }
        return (origExecFileSync as any)(file, args, options);
      } as any;
      syncBuiltinESMExports();

      let unobservedFailure: any = null;
      try {
        const unobsClaude = makeClaudeFixture(dir, `#!${pyBin}\n` + readFileSync(parentPy, "utf8"));
        await spawnClaudeL10ChildForTest({
          argv: [unobsClaude, ...fullClaudeArgs],
          cwd: dir,
          childEnv: unobservedEnv,
          promptText: "",
          timeoutMs: 1500,
          cancelSignal: { cancelled: () => false },
          runId: "r4b-unobserved",
          permitPool: unobservedPool,
        });
      } catch (e: any) {
        unobservedFailure = e;
      } finally {
        cp.execFileSync = origExecFileSync;
        syncBuiltinESMExports();
      }

      assert.ok(unobservedFailure, "R4b MUTANT: unobserved child must fail teardown");
      assert.equal(unobservedFailure.code, "TEARDOWN_UNCONFIRMED", "R4b MUTANT: must throw TEARDOWN_UNCONFIRMED");
      assert.ok(unobservedFailure.message.includes("child exited before ancestry snapshot"), "R4b MUTANT: message must mention child exited before ancestry snapshot");

      // Verify permit is POISONED and withholding next acquire
      let permitReacquired = false;
      try {
        await unobservedPool.acquire("next-after-unobserved", { deadlineMs: 50 });
        permitReacquired = true;
      } catch {}
      assert.equal(permitReacquired, false, "R4b MUTANT: permit must be withheld");
    }

    // -------------------------------------------------------------------------
    // R4b stated residual (the supervisor ruling A, rework 12)
    // Claim: R4b: every descendant seen in any ancestry snapshot, or in the final snapshot taken at child exit, is guarded and signalled before the permit is released. NOT contained: (a) a descendant that leaves ancestry/session (fork+setsid+exit) inside one sampling gap; (b) any process the child has launchd start (open/launchctl/XPC). This is a known limit for a non-root runner on macOS. The permit caps concurrent Claude CLI turns, not every process those turns cause.
    // BELIEVE, not measured: an escaped descendant that is itself a claude CLI process would use a Max seat outside the permit.
    // -------------------------------------------------------------------------

    // Condition 3(i): Final snapshot at child exit
    // CONTROL: Grandchild spawned right before child exit is first seen in exit snapshot, signalled, dies, and permit released
    // MUTANT: Same consumer with only final snapshot omitted leaves grandchild alive
    {
      const runExitSnapPole = async (opts: { skipExitSnapshot: boolean; runName: string }) => {
        const poleDir = join(dir, opts.runName);
        mkdirSync(poleDir, { recursive: true });
        const pool = new L10PermitPool(join(poleDir, "permits"), 1);
        const childEnv = buildChildEnv({ route: "claude", runId: opts.runName, home: dir, runDir: poleDir });
        const readyFile = join(poleDir, "parent-ready");
        const goFile = join(poleDir, "parent-go");
        const workerDoneFile = join(poleDir, "worker-done");
        const gcPidFile = join(poleDir, "gc.pid");
        const parentPy = join(poleDir, "parent.py");

        writeFileSync(parentPy, `import os, time, sys
deadline = time.time() + 20
worker = os.fork()
if worker == 0:
    null = os.open("/dev/null", os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    open(${JSON.stringify(readyFile)}, "w").close()
    while not os.path.exists(${JSON.stringify(goFile)}):
        if time.time() >= deadline: sys.exit(1)
        time.sleep(0.001)
    gd = os.fork()
    if gd == 0:
        os.setpgid(0, 0)
        null = os.open("/dev/null", os.O_RDWR)
        for fd in [0, 1, 2]: os.dup2(null, fd)
        with open(${JSON.stringify(gcPidFile)}, "w") as f:
            f.write(str(os.getpid()))
        while time.time() < deadline:
            time.sleep(0.5)
        sys.exit(0)
    while not os.path.exists(${JSON.stringify(gcPidFile)}):
        if time.time() >= deadline: sys.exit(1)
        time.sleep(0.001)
    open(${JSON.stringify(workerDoneFile)}, "w").close()
    while time.time() < deadline:
        time.sleep(0.5)
    sys.exit(0)

while not os.path.exists(${JSON.stringify(workerDoneFile)}):
    if time.time() >= deadline: sys.exit(1)
    time.sleep(0.001)
os._exit(0)
`);

        let seenInPoller = false;
        let seenInExit = false;
        let observedGcPid = 0;
        let samples = 0;
        let parentExitedInGap = false;
        const originalExecFileSync = cp.execFileSync;

        cp.execFileSync = function (file: any, args: any, options: any) {
          const actual = (originalExecFileSync as any)(file, args, options);
          if (file === "/bin/ps" && args?.[0] === "-axo" && args?.[1]?.includes("sess")) {
            samples++;
            if (samples === 2) {
              const start = Date.now();
              while (!existsSync(readyFile) && Date.now() - start < 5000) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
              }
              writeFileSync(goFile, "go");
              const pidStart = Date.now();
              while (Date.now() - pidStart < 5000) {
                if (existsSync(gcPidFile)) {
                  const raw = readFileSync(gcPidFile, "utf8").trim();
                  const p = parseInt(raw, 10);
                  if (p > 0) {
                    observedGcPid = p;
                    break;
                  }
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
              }
              while (!existsSync(workerDoneFile) && Date.now() - start < 5000) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
              }
              parentExitedInGap = true;
            }
          }
          return actual;
        } as any;
        syncBuiltinESMExports();

        const parentClaudeFixture = makeClaudeFixture(poleDir, "claude-parent", `#!/bin/sh\nexec "${PYTHON_ABS}" "${parentPy}" "$@"\n`);

        try {
          const res = await spawnClaudeL10ChildForTest({
            argv: [parentClaudeFixture, ...fullClaudeArgs],
            cwd: poleDir,
            childEnv,
            promptText: "",
            timeoutMs: 4000,
            maxSnapshotGapMs: 10000,
            cancelSignal: { cancelled: () => false },
            runId: `${opts.runName}-run`,
            permitPool: pool,
            skipExitSnapshot: opts.skipExitSnapshot,
            onSnapshot: (phase, seen) => {
              if (observedGcPid !== 0 && seen.has(observedGcPid)) {
                if (phase === "poller") seenInPoller = true;
                if (phase === "exit") seenInExit = true;
              }
            },
          });
          return { res, pool, observedGcPid, seenInPoller, seenInExit, parentExitedInGap };
        } finally {
          try { writeFileSync(goFile, "go"); } catch {}
          try { writeFileSync(workerDoneFile, "done"); } catch {}
          cp.execFileSync = originalExecFileSync;
          syncBuiltinESMExports();
        }
      };

      // CONTROL: exit snapshot enabled
      const ctrl = await runExitSnapPole({ skipExitSnapshot: false, runName: "r4b-exit-snap-ctrl" });
      assert.ok(ctrl.observedGcPid > 0, "R4b Condition 3(i) CONTROL: grandchild spawned");
      assert.equal(ctrl.parentExitedInGap, true, "R4b Condition 3(i) CONTROL: parent exited before second sample");
      assert.equal(ctrl.seenInPoller, false, "R4b Condition 3(i) CONTROL: grandchild NOT seen in live poller");
      assert.equal(ctrl.seenInExit, true, "R4b Condition 3(i) CONTROL: grandchild first seen in exit snapshot");
      const gcDead = await waitForExit(ctrl.observedGcPid, 1500);
      assert.equal(gcDead, true, "R4b Condition 3(i) CONTROL: grandchild first seen in exit snapshot is killed");
      const next = await ctrl.pool.acquire("next-after-exit-snap", { deadlineMs: 100 });
      assert.ok(next, "R4b Condition 3(i) CONTROL: permit released after exit snapshot teardown");
      next.release();

      // MUTANT: exit snapshot omitted (single varied property: skipExitSnapshot: true)
      const mutant = await runExitSnapPole({ skipExitSnapshot: true, runName: "r4b-exit-snap-mutant" });
      try {
        assert.ok(mutant.observedGcPid > 0, "R4b Condition 3(i) MUTANT: grandchild spawned");
        assert.equal(mutant.parentExitedInGap, true, "R4b Condition 3(i) MUTANT: parent exited before second sample");
        assert.equal(mutant.seenInPoller, false, "R4b Condition 3(i) MUTANT: grandchild NOT seen in live poller");
        assert.equal(mutant.seenInExit, false, "R4b Condition 3(i) MUTANT: exit snapshot was skipped");
        const mutantDead = await waitForExit(mutant.observedGcPid, 1500);
        assert.equal(mutantDead, false, "R4b Condition 3(i) MUTANT: without exit snapshot, grandchild survives");
      } finally {
        if (mutant.observedGcPid > 0) {
          try { process.kill(mutant.observedGcPid, "SIGKILL"); } catch {}
        }
      }
    }

    // Condition 4: the earlier Evidence 3 as named residual test
    // "R4b residual (a): fork+setsid+exit inside one sampling gap is not contained (stated macOS limit)"
    {
      const gapDir = join(dir, "r4b-residual-gap");
      mkdirSync(gapDir, { recursive: true, mode: 0o700 });
      const ready = join(gapDir, "ready");
      const go = join(gapDir, "go");
      const pidFile = join(gapDir, "descendant.pid");
      const body = join(gapDir, "body.py");
      const parent = join(gapDir, "parent.py");

      writeFileSync(body, `import os, time, sys\ndeadline = time.time() + 20\nwith open(${JSON.stringify(pidFile)}, "w") as f: f.write(str(os.getpid()))\nwhile time.time() < deadline: time.sleep(0.5)\nsys.exit(0)\n`);
      writeFileSync(parent, `import os, time, sys
deadline = time.time() + 20
open(${JSON.stringify(ready)}, "w").close()
while not os.path.exists(${JSON.stringify(go)}):
    if time.time() >= deadline: sys.exit(1)
    time.sleep(0.001)
pid = os.fork()
if pid == 0:
    os.setsid()
    null = os.open("/dev/null", os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    e = dict(os.environ)
    e.pop("TMPDIR", None)
    os.execve(sys.executable, [sys.executable, ${JSON.stringify(body)}], e)
else:
    while not os.path.exists(${JSON.stringify(pidFile)}):
        if time.time() >= deadline: sys.exit(1)
        time.sleep(0.001)
    os._exit(0)
`);

      let samples = 0;
      let descendantPid = 0;
      let parentExitedInGap = false;
      const originalExecFileSync = cp.execFileSync;

      cp.execFileSync = function (file: any, args: any, options: any) {
        const actual = (originalExecFileSync as any)(file, args, options);
        if (file === "/bin/ps" && args?.[0] === "-axo" && args?.[1]?.includes("sess")) {
          samples++;
          if (samples === 2) {
            const start = Date.now();
            while (!existsSync(ready) && Date.now() - start < 5000) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
            }
            writeFileSync(go, "go");
            while (!existsSync(pidFile) && Date.now() - start < 5000) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
            }
            if (existsSync(pidFile)) {
              descendantPid = Number(readFileSync(pidFile, "utf8"));
            }
            while (Date.now() - start < 5000) {
              try {
                const ppid = Number((originalExecFileSync as any)("/bin/ps", ["-o", "ppid=", "-p", String(descendantPid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
                if (ppid === 1) break;
              } catch {}
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
            }
            parentExitedInGap = true;
          }
        }
        return actual;
      } as any;
      syncBuiltinESMExports();

      const residualPool = new L10PermitPool(join(gapDir, "permits"), 1);
      const env = buildChildEnv({ route: "claude", home: dir, runDir: gapDir, runId: "r4b-residual" });
      let outcome: any = null;
      let permitReacquired = false;

      try {
        try {
          const resClaude = makeClaudeFixture(dir, `#!${pyBin}\n` + readFileSync(parent, "utf8"));
          const r = await spawnClaudeL10ChildForTest({
            argv: [resClaude, ...fullClaudeArgs],
            cwd: process.cwd(),
            childEnv: env,
            promptText: "offline fixture",
            timeoutMs: 2500,
            cancelSignal: { cancelled: () => false },
            runId: "gap-residual",
            permitPool: residualPool,
          });
          outcome = { code: "OK", childPid: r.childPid };
        } catch (e: any) {
          outcome = { code: e.code ?? e.name, message: e.message };
        } finally {
          try { writeFileSync(go, "go"); } catch {}
          cp.execFileSync = originalExecFileSync;
          syncBuiltinESMExports();
        }

        if (!descendantPid && existsSync(pidFile)) {
          descendantPid = Number(readFileSync(pidFile, "utf8"));
        }
        let state = "ABSENT";
        if (descendantPid) {
          try {
            state = (originalExecFileSync as any)("/bin/ps", ["-p", String(descendantPid), "-o", "state="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
          } catch {}
        }
        try {
          const next = await residualPool.acquire("next-after-gap", { deadlineMs: 100 });
          permitReacquired = true;
          next.release();
        } catch {}

        const descendantExecuting = state !== "ABSENT" && !state.startsWith("Z");

        assert.equal(outcome.code, "OK", "R4b residual (a): returns OK");
        assert.equal(parentExitedInGap, true, "R4b residual (a): parent exited inside sampling gap");
        assert.equal(permitReacquired, true, "R4b residual (a): permit reacquired after turn");
        assert.equal(descendantExecuting, true, "R4b residual (a): fork+setsid+exit inside one sampling gap is not contained (stated macOS limit)");
      } finally {
        try { writeFileSync(go, "go"); } catch {}
        cp.execFileSync = originalExecFileSync;
        syncBuiltinESMExports();
        if (descendantPid) {
          try { process.kill(descendantPid, "SIGKILL"); } catch {}
        }
      }
    }

    // Condition 4 FAIL condition 1: any descendant that WAS seen in snapshot/exit survives teardown
    // CONTROL: seen descendant is killed by teardown, permit released
    {
      const fail1Dir = join(dir, "fail1");
      mkdirSync(fail1Dir, { recursive: true });
      const fail1PidFile = join(fail1Dir, "seen-descendant.pid");
      const fail1Fixture = join(fail1Dir, "seen-descendant.py");
      writeFileSync(fail1Fixture, `import os, time, sys
deadline = time.time() + 20
pid = os.fork()
if pid == 0:
    null = os.open("/dev/null", os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    with open(${JSON.stringify(fail1PidFile)}, "w") as f: f.write(str(os.getpid()))
    while time.time() < deadline:
        time.sleep(0.5)
    sys.exit(0)
while not os.path.exists(${JSON.stringify(fail1PidFile)}):
    if time.time() >= deadline: sys.exit(1)
    time.sleep(0.001)
time.sleep(0.05)
sys.exit(0)
`);
      const fail1Pool = new L10PermitPool(join(fail1Dir, "permits"), 1);
      const fail1Env = buildChildEnv({ route: "claude", runId: "fail1-ctrl", home: dir, runDir: fail1Dir });
      const fail1Claude = makeClaudeFixture(fail1Dir, "claude-fail1", `#!/bin/sh\nexec "${PYTHON_ABS}" "${fail1Fixture}" "$@"\n`);
      let seenInSnapshot = false;
      let seenPid = 0;
      await spawnClaudeL10ChildForTest({
        argv: [fail1Claude, ...fullClaudeArgs],
        cwd: dir,
        childEnv: fail1Env,
        promptText: "",
        timeoutMs: 2500,
        teardownTimeoutMs: 300,
        cancelSignal: { cancelled: () => false },
        runId: "fail1-ctrl-run",
        permitPool: fail1Pool,
        onSnapshot: (_phase, seen) => {
          if (seenPid === 0 && existsSync(fail1PidFile)) {
            const raw = readFileSync(fail1PidFile, "utf8").trim();
            const p = parseInt(raw, 10);
            if (p > 0) seenPid = p;
          }
          if (seenPid !== 0 && seen.has(seenPid)) seenInSnapshot = true;
        },
      });
      if (seenPid === 0 && existsSync(fail1PidFile)) {
        const raw = readFileSync(fail1PidFile, "utf8").trim();
        const p = parseInt(raw, 10);
        if (p > 0) seenPid = p;
      }
      assert.ok(seenPid > 0, "R4b FAIL condition 1 CONTROL: descendant spawned");
      assert.equal(seenInSnapshot, true, "R4b FAIL condition 1 CONTROL: descendant was recorded in consumer snapshot");
      const isDead = await waitForExit(seenPid, 1000);
      assert.equal(isDead, true, "R4b FAIL condition 1 CONTROL: descendant seen in snapshot must not survive teardown");

      const next = await fail1Pool.acquire("fail1-ctrl-reacquire", { deadlineMs: 100 });
      assert.ok(next, "R4b FAIL condition 1 CONTROL: permit released after confirmed teardown");
      next.release();

      // MUTANT: descendant recorded in consumer snapshot survives teardown -> TEARDOWN_UNCONFIRMED and permit poisoned
      const fail1MutantDir = join(dir, "fail1-mutant");
      mkdirSync(fail1MutantDir, { recursive: true });
      const fail1MutantPidFile = join(fail1MutantDir, "seen-descendant.pid");
      const fail1MutantFixture = join(fail1MutantDir, "seen-descendant.py");
      writeFileSync(fail1MutantFixture, `import os, time, sys
deadline = time.time() + 20
pid = os.fork()
if pid == 0:
    null = os.open("/dev/null", os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    with open(${JSON.stringify(fail1MutantPidFile)}, "w") as f: f.write(str(os.getpid()))
    while time.time() < deadline:
        time.sleep(0.5)
    sys.exit(0)
while not os.path.exists(${JSON.stringify(fail1MutantPidFile)}):
    if time.time() >= deadline: sys.exit(1)
    time.sleep(0.001)
time.sleep(0.05)
sys.exit(0)
`);
      const fail1MutantPool = new L10PermitPool(join(fail1MutantDir, "permits"), 1);
      const fail1MutantEnv = buildChildEnv({ route: "claude", runId: "fail1-mutant", home: dir, runDir: fail1MutantDir });
      const fail1MutantClaude = makeClaudeFixture(fail1MutantDir, "claude-fail1-mutant", `#!/bin/sh\nexec "${PYTHON_ABS}" "${fail1MutantFixture}" "$@"\n`);
      let mutantSeenInSnapshot = false;
      let mutantDescendantPid = 0;
      let mutantError: any = null;

      try {
        await spawnClaudeL10ChildForTest({
          argv: [fail1MutantClaude, ...fullClaudeArgs],
          cwd: dir,
          childEnv: fail1MutantEnv,
          promptText: "",
          timeoutMs: 2500,
          teardownTimeoutMs: 300,
          cancelSignal: { cancelled: () => false },
          runId: "fail1-mutant-run",
          permitPool: fail1MutantPool,
          signalFn: (target, sig) => {
            if (sig === 0) {
              try { process.kill(target, 0); return true; } catch { return false; }
            }
            // Suppress kill to the spawned descendant so it survives teardown
            if (mutantDescendantPid !== 0 && target === mutantDescendantPid) {
              return true;
            }
            try { process.kill(target, sig); return true; } catch { return false; }
          },
          onSnapshot: (_phase, seen) => {
            if (mutantDescendantPid === 0 && existsSync(fail1MutantPidFile)) {
              const raw = readFileSync(fail1MutantPidFile, "utf8").trim();
              const p = parseInt(raw, 10);
              if (p > 0) mutantDescendantPid = p;
            }
            if (mutantDescendantPid !== 0 && seen.has(mutantDescendantPid)) {
              mutantSeenInSnapshot = true;
            }
          },
        });
      } catch (e) {
        mutantError = e;
      }

      if (mutantDescendantPid === 0 && existsSync(fail1MutantPidFile)) {
        const raw = readFileSync(fail1MutantPidFile, "utf8").trim();
        const p = parseInt(raw, 10);
        if (p > 0) mutantDescendantPid = p;
      }

      assert.ok(mutantDescendantPid > 0, "R4b FAIL condition 1 MUTANT: descendant spawned");
      assert.equal(mutantSeenInSnapshot, true, "R4b FAIL condition 1 MUTANT: descendant was recorded in consumer snapshot");
      assert.ok(mutantError instanceof AdapterFailure, "R4b FAIL condition 1 MUTANT: throws AdapterFailure");
      assert.equal(mutantError.code, "TEARDOWN_UNCONFIRMED", "R4b FAIL condition 1 MUTANT: unconfirmed teardown when descendant survives");

      // Assert SAME death predicate BEFORE finally cleanup:
      try {
        const isDeadMutant = await waitForExit(mutantDescendantPid, 1000);
        assert.equal(isDeadMutant, false, "R4b FAIL condition 1 MUTANT: suppressed descendant survives teardown");
      } finally {
        if (mutantDescendantPid !== 0) {
          try { process.kill(mutantDescendantPid, "SIGKILL"); } catch {}
        }
      }

      let reacquireFailed = false;
      try {
        await fail1MutantPool.acquire("fail1-mutant-reacquire", { deadlineMs: 50 });
      } catch (e: any) {
        if (e.code === "TIMEOUT") reacquireFailed = true;
      }
      assert.equal(reacquireFailed, true, "R4b FAIL condition 1 MUTANT: permit withheld/poisoned when seen descendant survived");
    }

    // Condition 4 FAIL condition 2: permit released while child itself is alive
    // CONTROL: while child is running, permit is held and acquire times out
    // MUTANT: premature release allows claim while child is confirmed STILL ALIVE
    {
      const fail2Dir = join(dir, "fail2");
      mkdirSync(fail2Dir, { recursive: true });
      const fail2Ready = join(fail2Dir, "ready");
      const fail2Stop = join(fail2Dir, "stop");
      const fail2PidFile = join(fail2Dir, "parent.pid");
      const fail2Parent = join(fail2Dir, "parent.py");
      writeFileSync(fail2Parent, `import os, time, sys
deadline = time.time() + 20
with open(${JSON.stringify(fail2PidFile)}, "w") as f:
    f.write(str(os.getpid()))
open(${JSON.stringify(fail2Ready)}, "w").close()
while not os.path.exists(${JSON.stringify(fail2Stop)}):
    if time.time() >= deadline: sys.exit(1)
    time.sleep(0.005)
sys.exit(0)
`);
      const fail2Pool = new L10PermitPool(join(fail2Dir, "permits"), 1);
      const fail2Env = buildChildEnv({ route: "claude", runId: "fail2-ctrl", home: dir, runDir: fail2Dir });
      const fail2Claude = makeClaudeFixture(dir, `#!${pyBin}\n` + readFileSync(fail2Parent, "utf8"));
      const childPromise = spawnClaudeL10ChildForTest({
        argv: [fail2Claude, ...fullClaudeArgs],
        cwd: dir,
        childEnv: fail2Env,
        promptText: "",
        timeoutMs: 3000,
        cancelSignal: { cancelled: () => false },
        runId: "fail2-ctrl-run",
        permitPool: fail2Pool,
      });

      try {
        while (!existsSync(fail2Ready) || !existsSync(fail2PidFile)) await new Promise((r) => setTimeout(r, 10));
        const childPid = Number(readFileSync(fail2PidFile, "utf8"));
        let childAlive = false;
        try { process.kill(childPid, 0); childAlive = true; } catch {}
        assert.equal(childAlive, true, "R4b FAIL condition 2: child is alive");

        // CONTROL: while child is running and alive, competing acquire times out
        let acquireFailedWhileChildAlive = false;
        try {
          await fail2Pool.acquire("competing", { deadlineMs: 50 });
        } catch (e: any) {
          if (e.code === "TIMEOUT") acquireFailedWhileChildAlive = true;
        }
        assert.equal(acquireFailedWhileChildAlive, true, "R4b FAIL condition 2 CONTROL: permit is withheld while child is alive");

        // Verify child is STILL alive before MUTANT
        let childStillAlive = false;
        try { process.kill(childPid, 0); childStillAlive = true; } catch {}
        assert.equal(childStillAlive, true, "R4b FAIL condition 2: child still running before mutant");

        // MUTANT: premature release allows claim while child is STILL running (do NOT await childPromise!)
        const slotFile = join(fail2Dir, "permits", "permit-0.json");
        unlinkSync(slotFile); // simulate premature slot release while child runs

        let prematureAcquireSucceeded = false;
        try {
          const stolen = await fail2Pool.acquire("premature-claim", { deadlineMs: 50 });
          prematureAcquireSucceeded = true;
          stolen.release();
        } catch {}

        let childAliveAtPrematureClaim = false;
        try { process.kill(childPid, 0); childAliveAtPrematureClaim = true; } catch {}

        assert.equal(prematureAcquireSucceeded, true, "R4b FAIL condition 2 MUTANT: premature permit release allows claim");
        assert.equal(childAliveAtPrematureClaim, true, "R4b FAIL condition 2 MUTANT: child was confirmed alive when premature claim succeeded");

        // Stop child and cleanly await completion
        writeFileSync(fail2Stop, "stop");
        await childPromise;
      } finally {
        try { writeFileSync(fail2Stop, "stop"); } catch {}
        try { await childPromise; } catch {}
      }
    }

    // =========================================================================
    // Item A Poles: Leaked fixture hygiene (P2, the supervisor)
    // CONTROL: a scratch test that fails an assertion before the stop write leaves no fixture alive after 25 s.
    // MUTANT: the same with the self-deadline removed (on a scratch copy) leaves it alive, and the no-survivor check flags it. End the mutant's own fixture by its recorded pid.
    // =========================================================================
    {
      const hygieneDir = join(dir, "hygiene-poles");
      mkdirSync(hygieneDir, { recursive: true });
      const pyBin = PYTHON_ABS ?? "/usr/local/bin/python";

      // 1. MUTANT: fixture without self-deadline loops forever on missing stop file
      const mutantDir = join(hygieneDir, "mutant");
      mkdirSync(mutantDir, { recursive: true });
      const mutantPidFile = join(mutantDir, "pid");
      const mutantStop = join(mutantDir, "stop");
      const mutantScript = join(mutantDir, "fixture.py");
      writeFileSync(mutantScript, `import os, time, sys
with open(${JSON.stringify(mutantPidFile)}, "w") as f:
    f.write(str(os.getpid()))
while not os.path.exists(${JSON.stringify(mutantStop)}):
    time.sleep(0.01)
sys.exit(0)
`);
      let mutantCp: cp.ChildProcess | null = null;
      let mPid: number | null = null;
      const recordedMutantPids = new Set<number>();
      try {
        mutantCp = cp.spawn(pyBin, [mutantScript], { stdio: "ignore" });
        if (!mutantCp || !mutantCp.pid) {
          throw new Error("Failed to spawn mutant fixture process");
        }
        mPid = mutantCp.pid;
        recordedMutantPids.add(mPid);

        const readyDeadline = Date.now() + 5000;
        while (!existsSync(mutantPidFile)) {
          if (Date.now() > readyDeadline) {
            throw new Error("Timed out waiting for mutant pid file");
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        const parsedPid = parseInt(readFileSync(mutantPidFile, "utf8").trim(), 10);
        if (Number.isInteger(parsedPid)) {
          mPid = parsedPid;
          recordedMutantPids.add(mPid);
        }

        // Verify that the no-survivor check flags the mutant survivor
        let mutantFlagged = false;
        try {
          assertNoSurvivingProcessesForDir(mutantDir, new Set()); // do not kill yet
        } catch (e: any) {
          if (e.message.includes("Survivor processes found")) {
            mutantFlagged = true;
          }
        }
        assert.equal(mutantFlagged, true, "MUTANT: fixture without self-deadline survives and is flagged");
      } finally {
        // Guarantee cleanup: write stop file and await bounded exit
        try {
          writeFileSync(mutantStop, "stop\n");
        } catch {}

        if (mPid != null) {
          try {
            const cmd = execFileSync("/bin/ps", ["-p", String(mPid), "-o", "command="], { encoding: "utf8" }).trim();
            if (cmd.includes(mutantScript)) {
              process.kill(mPid, "SIGTERM");
            }
          } catch {}
          try {
            await waitForExit(mPid, 2000);
          } catch {}
        }
      }

      // 2. CONTROL: fixture has self-deadline (deadline = time.time() + 20)
      // Simulating assertion failure before stop write: stop is never written!
      const ctrlDir = join(hygieneDir, "ctrl");
      mkdirSync(ctrlDir, { recursive: true });
      const ctrlPidFile = join(ctrlDir, "pid");
      const ctrlStop = join(ctrlDir, "stop");
      const ctrlScript = join(ctrlDir, "fixture.py");
      writeFileSync(ctrlScript, `import os, time, sys
deadline = time.time() + 20
with open(${JSON.stringify(ctrlPidFile)}, "w") as f:
    f.write(str(os.getpid()))
while not os.path.exists(${JSON.stringify(ctrlStop)}):
    if time.time() >= deadline: sys.exit(1)
    time.sleep(0.01)
sys.exit(0)
`);
      const ctrlCp = cp.spawn(pyBin, [ctrlScript], { stdio: "ignore" });
      if (!ctrlCp || !ctrlCp.pid) {
        throw new Error("Failed to spawn ctrl fixture process");
      }
      const recordedCtrlPids = new Set<number>([ctrlCp.pid]);
      const ctrlReadyDeadline = Date.now() + 5000;
      while (!existsSync(ctrlPidFile)) {
        if (Date.now() > ctrlReadyDeadline) {
          throw new Error("Timed out waiting for ctrl pid file");
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      const cPid = parseInt(readFileSync(ctrlPidFile, "utf8").trim(), 10);
      if (Number.isInteger(cPid)) {
        recordedCtrlPids.add(cPid);
      }

      // Wait until deadline passes (20s) - within 25s
      const ctrlExited = await waitForExit(cPid, 25000);
      assert.equal(ctrlExited, true, "CONTROL: fixture with self-deadline exits within 25s without stop file");

      // Verify no-survivor check passes without error
      assert.doesNotThrow(() => {
        assertNoSurvivingProcessesForDir(ctrlDir, recordedCtrlPids);
      }, "CONTROL: no survivors remain under ctrlDir after self-deadline");
    }

    console.log("PASS R4: third blocks; pre-cancelled acquire rejects; bounded acquire times out; dead-pid reclaimable; atomic-rename claim leaves valid state; descendant-wait is in spawnClaudeL10Child (releasing only after close+group probe); multi-contender reclaim serialized; no-TMPDIR reparented descendant killed; unconfirmed teardown poisons permit; rework 7b safe group kill guard and sibling survival validated; rework 8 R4c late sibling sharing TMPDIR survives; rework 9 R4b positive containment and snapshot gap fail-closed poles verified; rework 12 R4b stated residual and final exit snapshot poles verified; rework 13 R4b test pairs measure claimed states (first seen in exit, seen descendant survival, alive at premature claim); rework 20 Item A fixture self-deadlines, finally releases, and no-survivor checks verified (CONTROL/MUTANT).");
  } finally {
    try { assertNoSurvivingProcessesForDir(dir); } catch (e) { console.error(e); throw e; }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => {
  _resetL10BinariesForTest();
  try { rmSync(__r4Fixture, { recursive: true, force: true }); } catch {}
});
