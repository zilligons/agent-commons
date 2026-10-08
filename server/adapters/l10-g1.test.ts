/**
 * L10 rework 9 — G1 poles: Kill-set guard (merge gate).
 *
 * Teardown never signals:
 *   (a) a pid outside the current uid
 *   (b) the runner's own pid, session or process group
 *   (c) more pids than a small cap (L10_MAX_KILLSET_SIZE = 32)
 *
 * On ANY violation it aborts the teardown, signals NOTHING (0 signals recorded),
 * and reports the refusal (KILLSET_REFUSED), keeping the permit POISONED.
 *
 * Tests use an INJECTED signal function recorder so no real signal reaches
 * any process the test did not spawn.
 *
 * Case 1: forced-true ownership over foreign UID / large machine-wide set -> 0 signals + refusal
 *         CONTROL: set of test's own fixture pids -> signals recorded for exactly those pids
 * Case 2: over-cap set (>32) -> 0 signals + refusal
 *         CONTROL: at-cap set (32) -> signals recorded
 * Case 3: set containing runner's own pid, session or process group -> 0 signals + refusal
 *         CONTROL: same set without it -> signals recorded
 *
 */
import assert from "node:assert/strict";
import cp, { spawn, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function assertNoSurvivingProcessesForDir(targetDir: string): void {
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
    throw new Error(`Survivor processes found under ${targetDir}: ${JSON.stringify(survivors)}`);
  }
}
import {
  L10PermitPool,
  L10_MAX_KILLSET_SIZE,
  spawnClaudeL10Child,
  spawnClaudeL10ChildForTest,
  spawnL10Child,
  spawnL10ChildForTest,
  teardownProcessTree,
  teardownProcessTreeForTest,
  spawnL10ChildInnerForTest,
  assertSafeKillSet,
  assertSafeKillSetForTest,
  getRunnerPgid,
  getRunnerSid,
  SignalFn,
  KillSetContext,
  poisonNote,
  PYTHON_ABS,
  safeErrorText,
  safeError,
} from "./l10-process";
import * as l10ProcessNamespace from "./l10-process";
import { AdapterFailure } from "./types";
import { buildChildEnv } from "./l10-env";
import { buildL10Argv } from "./l10-routes";
import { _setL10BinariesForTest, _resetL10BinariesForTest, resolveL10Binaries } from "./config";

// Brief rev 2 P: install a snapshot pointing at a synthetic absolute path
// under tmpdir so buildL10Argv produces a known argv. The snapshot is
// reset at the end of the test.
const __g1Fixture = mkdtempSync(join(tmpdir(), "l10-g1-fixtures-"));
const __g1Claude = join(__g1Fixture, "fake-claude");
const __g1Codex = join(__g1Fixture, "fake-codex");
const __g1Grok = join(__g1Fixture, "fake-grok");
writeFileSync(__g1Claude, "");
writeFileSync(__g1Codex, "");
writeFileSync(__g1Grok, "");
_setL10BinariesForTest(resolveL10Binaries({
  AGENT_COMMONS_CLAUDE_BIN: __g1Claude,
  AGENT_COMMONS_CODEX_BIN: __g1Codex,
  AGENT_COMMONS_GROK_BIN: __g1Grok,
  AGENT_COMMONS_MODEL_LEDGER: "",
} as NodeJS.ProcessEnv));

const fullClaudeArgs = buildL10Argv({ slotId: "continuity" }).slice(1);

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "l10-g1-"));
  const runnerUid = typeof process.getuid === "function" ? process.getuid() : 501;
  const runnerPid = process.pid;
  const runnerPgid = getRunnerPgid();
  const runnerSid = getRunnerSid();

  try {
    // -------------------------------------------------------------------------
    // DIRECT GUARD POLES: assertSafeKillSet tested directly with injected metadata
    // Each MUTANT must give zero signals + KILLSET_REFUSED, and each has a CONTROL.
    // -------------------------------------------------------------------------

    // Pole 1: 33+ PID set (over cap) vs 32 PID set (at cap)
    {
      const pids32 = Array.from({ length: 32 }, (_, i) => 20000 + i);
      const pids33 = Array.from({ length: 33 }, (_, i) => 20000 + i);
      const mockMeta = (pids: number[]) =>
        new Map(pids.map((p) => [p, { uid: runnerUid, pgid: 30000, sess: 30000 }]));

      // N2 pole: production assertSafeKillSet takes pids only (2nd arg is compile error)
      // @ts-expect-error Expected 1 arguments, but got 2.
      assertSafeKillSet([20001], { maxCap: 100 });

      // CONTROL: 32 pids pass
      assert.doesNotThrow(() => {
        assertSafeKillSetForTest(pids32, { runnerUid }, mockMeta);
      }, "Pole 1 CONTROL: at-cap 32 pids must pass guard");

      // MUTANT: 33 pids refused with KILLSET_REFUSED
      let overCapErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest(pids33, { runnerUid }, mockMeta);
      } catch (e: any) {
        overCapErr = e;
      }
      assert.ok(overCapErr, "Pole 1 MUTANT: 33 pids must be refused");
      assert.equal(overCapErr?.code, "KILLSET_REFUSED", "Pole 1 MUTANT: error code must be KILLSET_REFUSED");
      assert.ok(overCapErr?.message.includes("exceeds max cap"), "Pole 1 MUTANT: message must mention max cap");
    }

    // Pole 2: Set containing runner's own PID, session or process group
    {
      const safePids = [20001, 20002];
      const mockMeta = (pids: number[]) =>
        new Map(pids.map((p) => [p, { uid: runnerUid, pgid: 30000, sess: 30000 }]));
      const ctx: KillSetContext = { runnerPid, runnerPgid, runnerSid, runnerUid };

      // CONTROL: safe pids pass
      assert.doesNotThrow(() => {
        assertSafeKillSetForTest(safePids, ctx, mockMeta);
      }, "Pole 2 CONTROL: non-runner pids must pass guard");

      // MUTANT A: set contains runnerPid
      let runnerPidErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest([runnerPid, 20001], ctx, mockMeta);
      } catch (e: any) {
        runnerPidErr = e;
      }
      assert.ok(runnerPidErr, "Pole 2 MUTANT A: runner pid must be refused");
      assert.equal(runnerPidErr?.code, "KILLSET_REFUSED", "Pole 2 MUTANT A: code must be KILLSET_REFUSED");
      assert.ok(runnerPidErr?.message.includes("cannot signal runner pid"), "Pole 2 MUTANT A: message specifies runner pid");

      // MUTANT B: set contains runnerPgid
      let runnerPgidErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest([runnerPgid, 20001], ctx, mockMeta);
      } catch (e: any) {
        runnerPgidErr = e;
      }
      assert.ok(runnerPgidErr, "Pole 2 MUTANT B: runner pgid must be refused");
      assert.equal(runnerPgidErr?.code, "KILLSET_REFUSED", "Pole 2 MUTANT B: code must be KILLSET_REFUSED");

      // MUTANT C: set contains runnerSid
      let runnerSidErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest([runnerSid, 20001], ctx, mockMeta);
      } catch (e: any) {
        runnerSidErr = e;
      }
      assert.ok(runnerSidErr, "Pole 2 MUTANT C: runner sid must be refused");
      assert.equal(runnerSidErr?.code, "KILLSET_REFUSED", "Pole 2 MUTANT C: code must be KILLSET_REFUSED");

      // MUTANT D: metadata reveals process in runner pgid
      let metaPgidErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest([20001], ctx, (pids) =>
          new Map(pids.map((p) => [p, { uid: runnerUid, pgid: runnerPgid, sess: 30000 }])));
      } catch (e: any) {
        metaPgidErr = e;
      }
      assert.ok(metaPgidErr, "Pole 2 MUTANT D: member in runner pgid must be refused");
      assert.equal(metaPgidErr?.code, "KILLSET_REFUSED", "Pole 2 MUTANT D: code must be KILLSET_REFUSED");

      // MUTANT E: metadata reveals process in runner sid
      let metaSidErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest([20001], ctx, (pids) =>
          new Map(pids.map((p) => [p, { uid: runnerUid, pgid: 30000, sess: runnerSid }])));
      } catch (e: any) {
        metaSidErr = e;
      }
      assert.ok(metaSidErr, "Pole 2 MUTANT E: member in runner sid must be refused");
      assert.equal(metaSidErr?.code, "KILLSET_REFUSED", "Pole 2 MUTANT E: code must be KILLSET_REFUSED");

      // MUTANT F: runner process group is null (unverifiable) -> KILLSET_REFUSED
      let nullPgidErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest([20001], { ...ctx, runnerPgid: null as any }, mockMeta);
      } catch (e: any) {
        nullPgidErr = e;
      }
      assert.ok(nullPgidErr, "Pole 2 MUTANT F: null runner pgid must be refused");
      assert.equal(nullPgidErr?.code, "KILLSET_REFUSED", "Pole 2 MUTANT F: code must be KILLSET_REFUSED");
      assert.ok(nullPgidErr?.message.includes("runner process group could not be determined"), "Pole 2 MUTANT F: message specifies pgid failure");

      // MUTANT G: runner session is null (unverifiable) -> KILLSET_REFUSED
      let nullSidErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest([20001], { ...ctx, runnerSid: null as any }, mockMeta);
      } catch (e: any) {
        nullSidErr = e;
      }
      assert.ok(nullSidErr, "Pole 2 MUTANT G: null runner sid must be refused");
      assert.equal(nullSidErr?.code, "KILLSET_REFUSED", "Pole 2 MUTANT G: code must be KILLSET_REFUSED");
      assert.ok(nullSidErr?.message.includes("runner session could not be determined"), "Pole 2 MUTANT G: message specifies sid failure");
    }

    // Pole 3: Foreign UID
    {
      const testPids = [20001];
      const ctx: KillSetContext = { runnerPid: 10001, runnerPgid: 10002, runnerSid: 10003, runnerUid };

      // CONTROL: runnerUid passes
      assert.doesNotThrow(() => {
        assertSafeKillSetForTest(testPids, ctx, (pids) =>
          new Map(pids.map((p) => [p, { uid: runnerUid, pgid: 30000, sess: 30000 }])));
      }, "Pole 3 CONTROL: matching uid must pass");

      // MUTANT: foreign UID (e.g. 502 or 0)
      let foreignErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest(testPids, ctx, (pids) =>
          new Map(pids.map((p) => [p, { uid: 502, pgid: 30000, sess: 30000 }])));
      } catch (e: any) {
        foreignErr = e;
      }
      assert.ok(foreignErr, "Pole 3 MUTANT: foreign uid must be refused");
      assert.equal(foreignErr?.code, "KILLSET_REFUSED", "Pole 3 MUTANT: code must be KILLSET_REFUSED");
      assert.ok(foreignErr?.message.includes("foreign uid"), "Pole 3 MUTANT: message specifies foreign uid");
    }

    // Pole 4: ps throws (metadata read failure)
    {
      const testPids = [20001];
      const ctx: KillSetContext = { runnerPid: 10001, runnerPgid: 10002, runnerSid: 10003, runnerUid };

      // CONTROL: reader returns valid metadata
      assert.doesNotThrow(() => {
        assertSafeKillSetForTest(testPids, ctx, (pids) =>
          new Map(pids.map((p) => [p, { uid: runnerUid, pgid: 30000, sess: 30000 }])));
      }, "Pole 4 CONTROL: successful metadata read must pass");

      // MUTANT: reader throws
      let psThrowErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest(testPids, ctx, () => {
          throw new Error("synthetic ps exec failure");
        });
      } catch (e: any) {
        psThrowErr = e;
      }
      assert.ok(psThrowErr, "Pole 4 MUTANT: ps throwing must fail-closed with KILLSET_REFUSED");
      assert.equal(psThrowErr?.code, "KILLSET_REFUSED", "Pole 4 MUTANT: code must be KILLSET_REFUSED");
      assert.ok(psThrowErr?.message.includes("metadata reader failure"), "Pole 4 MUTANT: message mentions reader failure");
    }

    // Pole 5: PID with no metadata
    {
      const testPids = [20001, 20002];
      const ctx: KillSetContext = { runnerPid: 10001, runnerPgid: 10002, runnerSid: 10003, runnerUid };

      // CONTROL: all pids present in metadata
      assert.doesNotThrow(() => {
        assertSafeKillSetForTest(testPids, ctx, (pids) =>
          new Map(pids.map((p) => [p, { uid: runnerUid, pgid: 30000, sess: 30000 }])));
      }, "Pole 5 CONTROL: all pids present in metadata must pass");

      // MUTANT: one pid missing from metadata map
      let missingMetaErr: AdapterFailure | null = null;
      try {
        assertSafeKillSetForTest(testPids, ctx, (pids) =>
          new Map([[20001, { uid: runnerUid, pgid: 30000, sess: 30000 }]])); // 20002 missing
      } catch (e: any) {
        missingMetaErr = e;
      }
      assert.ok(missingMetaErr, "Pole 5 MUTANT: pid with missing metadata must be refused");
      assert.equal(missingMetaErr?.code, "KILLSET_REFUSED", "Pole 5 MUTANT: code must be KILLSET_REFUSED");
      assert.ok(missingMetaErr?.message.includes("no verified metadata"), "Pole 5 MUTANT: message mentions no verified metadata");
    }

    // Pole 6: Set grown after check on retry path (teardownProcessTree with non-forwarding recorder)
    {
      const mockLookup = (pids: number[]) =>
        new Map(pids.map((p) => [p, { uid: runnerUid, pgid: 30000, sess: 30000 }]));

      // CONTROL: planned set confirmed dead without mutation
      const controlTracked = new Set([310001]);
      const controlSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const controlSignalFn: SignalFn = (target, signal) => {
        controlSignals.push({ target, signal });
        return false;
      };
      const controlRes = await teardownProcessTreeForTest({
        childPid: null,
        childPgid: null,
        trackedDescendants: controlTracked,
        signalFn: controlSignalFn,
        permit: { poison() {} },
      }, (pids) => assertSafeKillSetForTest(pids, undefined, mockLookup));
      assert.equal(controlRes, true, "Pole 6 CONTROL: teardown of approved set succeeds");
      assert.equal(controlSignals.filter((s) => s.signal === "SIGKILL").length, 1, "Pole 6 CONTROL: exactly 1 SIGKILL recorded");

      // MUTANT: trackedDescendants mutated after guard check
      const mutantTracked = new Set([310001]);
      const mutantSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const poisonList: string[] = [];
      let mutated = false;
      const mutantSignalFn: SignalFn = (target, signal) => {
        mutantSignals.push({ target, signal });
        if (!mutated && signal === 0) {
          mutated = true;
          mutantTracked.add(999999); // late unverified target added during liveness check
        }
        return false;
      };

      let retryRefusedErr: AdapterFailure | null = null;
      try {
        await teardownProcessTreeForTest({
          childPid: null,
          childPgid: null,
          trackedDescendants: mutantTracked,
          signalFn: mutantSignalFn,
          permit: { poison(r) { poisonList.push(r); } },
        }, (pids) => assertSafeKillSetForTest(pids, undefined, mockLookup));
      } catch (e: any) {
        retryRefusedErr = e;
      }
      assert.ok(retryRefusedErr, "Pole 6 MUTANT: late target addition on retry path must be refused");
      assert.equal(retryRefusedErr?.code, "KILLSET_REFUSED", "Pole 6 MUTANT: code must be KILLSET_REFUSED");
      const lateKills = mutantSignals.filter((s) => s.target === 999999);
      assert.equal(lateKills.length, 0, "Pole 6 MUTANT: ZERO signals must reach unverified late target");
      assert.ok(poisonList.includes("held-by-killset-refusal"), "Pole 6 MUTANT: permit must be poisoned");
    }

    // Case 1 MUTANT B: direct teardown with foreign UID pid
    {
      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const testSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        return false;
      };

      const mockLookup = (pids: number[]) => {
        const m = new Map<number, { uid: number; pgid: number; sess: number }>();
        for (const p of pids) {
          if (p === 99999) {
            m.set(p, { uid: 0, pgid: 88888, sess: 77777 }); // foreign UID (root)
          } else {
            m.set(p, { uid: runnerUid, pgid: 88888, sess: 77777 });
          }
        }
        return m;
      };

      let failure: AdapterFailure | null = null;
      try {
        await teardownProcessTreeForTest({
          childPid: 12345,
          childPgid: 12345,
          trackedDescendants: new Set([99999]),
          signalFn: testSignalFn,
        }, (pids) => assertSafeKillSetForTest(pids, undefined, mockLookup));
      } catch (e: any) {
        failure = e as AdapterFailure;
      }

      assert.ok(failure, "Case 1 MUTANT B: foreign UID must be refused");
      assert.equal(failure?.code, "KILLSET_REFUSED", "Case 1 MUTANT B: code must be KILLSET_REFUSED");
      assert.ok(failure?.message.includes("foreign uid"), "Case 1 MUTANT B: message must mention foreign uid");
      assert.equal(recordedSignals.length, 0, "Case 1 MUTANT B: ZERO signals recorded on foreign UID refusal");
    }

    // Case 1 CONTROL: set of test's own fixture pids -> signals recorded for exactly those pids
    {
      const fixture = spawn("/bin/sleep", ["30"], { stdio: "ignore", detached: true });
      assert.ok(fixture.pid, "fixture process spawned");
      const fPid = fixture.pid;

      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const recordingSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        try {
          process.kill(target, signal);
          return true;
        } catch {
          return false;
        }
      };

      const teardownResult = await teardownProcessTreeForTest({
        childPid: fPid,
        childPgid: null,
        trackedDescendants: new Set(),
        signalFn: recordingSignalFn,
      });

      assert.equal(teardownResult, true, "Case 1 CONTROL: teardown of own fixture must succeed");
      const killTargets = Array.from(new Set(recordedSignals.filter((s) => s.signal === "SIGKILL").map((s) => s.target)));
      assert.deepEqual(killTargets, [fPid], "Case 1 CONTROL: signals recorded for exactly fixture pid");

      // Verify fixture process is dead
      let fixtureDead = false;
      try { process.kill(fPid, 0); } catch { fixtureDead = true; }
      assert.equal(fixtureDead, true, "Case 1 CONTROL: fixture process confirmed terminated");
    }

    // -------------------------------------------------------------------------
    // CASE 2: Over-cap set (>32) vs At-cap set (<=32)
    // -------------------------------------------------------------------------
    // Case 2 MUTANT: 33 PIDs (> L10_MAX_KILLSET_SIZE = 32)
    {
      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const testSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        return false;
      };

      const overCapPids = new Set<number>();
      for (let i = 1; i <= 33; i++) {
        overCapPids.add(10000 + i);
      }

      const mockLookup = (pids: number[]) => {
        const m = new Map<number, { uid: number; pgid: number; sess: number }>();
        for (const p of pids) m.set(p, { uid: runnerUid, pgid: 20000, sess: 20000 });
        return m;
      };

      let failure: AdapterFailure | null = null;
      try {
        await teardownProcessTreeForTest({
          childPid: null,
          childPgid: null,
          trackedDescendants: overCapPids,
          signalFn: testSignalFn,
        }, (pids) => assertSafeKillSetForTest(pids, undefined, mockLookup));
      } catch (e: any) {
        failure = e as AdapterFailure;
      }

      assert.ok(failure, "Case 2 MUTANT: over-cap set (>32) must be refused");
      assert.equal(failure?.code, "KILLSET_REFUSED", "Case 2 MUTANT: failure code must be KILLSET_REFUSED");
      assert.ok(failure?.message.includes("exceeds max cap 32"), "Case 2 MUTANT: message must mention cap");
      assert.equal(recordedSignals.length, 0, "Case 2 MUTANT: ZERO signals recorded on over-cap refusal");
    }

    // Case 2 CONTROL: 32 PIDs (exact cap L10_MAX_KILLSET_SIZE = 32)
    {
      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const testSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        // Return false for probe 0 so teardown considers all dead immediately
        return false;
      };

      const atCapPids = new Set<number>();
      for (let i = 1; i <= 32; i++) {
        atCapPids.add(10000 + i);
      }

      const mockLookup = (pids: number[]) => {
        const m = new Map<number, { uid: number; pgid: number; sess: number }>();
        for (const p of pids) m.set(p, { uid: runnerUid, pgid: 20000, sess: 20000 });
        return m;
      };

      const success = await teardownProcessTreeForTest({
        childPid: null,
        childPgid: null,
        trackedDescendants: atCapPids,
        signalFn: testSignalFn,
      }, (pids) => assertSafeKillSetForTest(pids, undefined, mockLookup));

      assert.equal(success, true, "Case 2 CONTROL: at-cap set (32) must succeed");
      const killedPids = Array.from(new Set(recordedSignals.filter((s) => s.signal === "SIGKILL").map((s) => s.target)));
      assert.equal(killedPids.length, 32, "Case 2 CONTROL: exactly 32 pids signaled");
      assert.deepEqual(killedPids.sort((a, b) => a - b), Array.from(atCapPids).sort((a, b) => a - b));
    }

    // -------------------------------------------------------------------------
    // CASE 3: Set containing runner's own PID, session or process group
    // -------------------------------------------------------------------------
    // Case 3 MUTANT A: set contains runner's own PID
    {
      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const testSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        return false;
      };

      let failure: AdapterFailure | null = null;
      try {
        await teardownProcessTreeForTest({
          childPid: 12345,
          childPgid: null,
          trackedDescendants: new Set([runnerPid]),
          signalFn: testSignalFn,
        });
      } catch (e: any) {
        failure = e as AdapterFailure;
      }

      assert.ok(failure, "Case 3 MUTANT A: runner pid in kill-set must be refused");
      assert.equal(failure?.code, "KILLSET_REFUSED", "Case 3 MUTANT A: code must be KILLSET_REFUSED");
      assert.ok(failure?.message.includes("cannot signal runner pid"), "Case 3 MUTANT A: message must specify runner pid");
      assert.equal(recordedSignals.length, 0, "Case 3 MUTANT A: ZERO signals recorded on runner pid refusal");
    }

    // Case 3 MUTANT B: set contains runner's PGID
    {
      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const testSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        return false;
      };

      let failure: AdapterFailure | null = null;
      try {
        await teardownProcessTreeForTest({
          childPid: 12345,
          childPgid: null,
          trackedDescendants: new Set([88888]),
          signalFn: testSignalFn,
        }, (pids) => assertSafeKillSetForTest(pids, { runnerPgid: 88888, runnerPid: 77777, runnerSid: 66666 }));
      } catch (e: any) {
        failure = e as AdapterFailure;
      }

      assert.ok(failure, "Case 3 MUTANT B: runner pgid in kill-set must be refused");
      assert.equal(failure?.code, "KILLSET_REFUSED", "Case 3 MUTANT B: code must be KILLSET_REFUSED");
      assert.ok(failure?.message.includes("runner process group leader"), "Case 3 MUTANT B: message must specify runner pgid leader");
      assert.equal(recordedSignals.length, 0, "Case 3 MUTANT B: ZERO signals recorded on runner pgid refusal");
    }

    // Case 3 MUTANT C: set contains process with runner's PGID in metadata
    {
      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const testSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        return false;
      };

      const mockLookup = (pids: number[]) => {
        const m = new Map<number, { uid: number; pgid: number; sess: number }>();
        for (const p of pids) m.set(p, { uid: runnerUid, pgid: 88888, sess: 20000 });
        return m;
      };

      let failure: AdapterFailure | null = null;
      try {
        await teardownProcessTreeForTest({
          childPid: 12345,
          childPgid: null,
          trackedDescendants: new Set([12346]),
          signalFn: testSignalFn,
        }, (pids) => assertSafeKillSetForTest(pids, { runnerPgid: 88888, runnerPid: 77777, runnerSid: 66666 }, mockLookup));
      } catch (e: any) {
        failure = e as AdapterFailure;
      }

      assert.ok(failure, "Case 3 MUTANT C: member of runner pgid must be refused");
      assert.equal(failure?.code, "KILLSET_REFUSED", "Case 3 MUTANT C: code must be KILLSET_REFUSED");
      assert.ok(failure?.message.includes("belongs to runner pgid"), "Case 3 MUTANT C: message must specify belongs to runner pgid");
      assert.equal(recordedSignals.length, 0, "Case 3 MUTANT C: ZERO signals recorded on runner pgid member refusal");
    }

    // Case 3 MUTANT D: set contains process with runner's SID in metadata
    {
      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const testSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        return false;
      };

      const mockLookup = (pids: number[]) => {
        const m = new Map<number, { uid: number; pgid: number; sess: number }>();
        for (const p of pids) m.set(p, { uid: runnerUid, pgid: 20000, sess: 66666 });
        return m;
      };

      let failure: AdapterFailure | null = null;
      try {
        await teardownProcessTreeForTest({
          childPid: 12345,
          childPgid: null,
          trackedDescendants: new Set([12346]),
          signalFn: testSignalFn,
        }, (pids) => assertSafeKillSetForTest(pids, { runnerPgid: 88888, runnerPid: 77777, runnerSid: 66666 }, mockLookup));
      } catch (e: any) {
        failure = e as AdapterFailure;
      }

      assert.ok(failure, "Case 3 MUTANT D: member of runner sid must be refused");
      assert.equal(failure?.code, "KILLSET_REFUSED", "Case 3 MUTANT D: code must be KILLSET_REFUSED");
      assert.ok(failure?.message.includes("belongs to runner session"), "Case 3 MUTANT D: message must specify belongs to runner session");
      assert.equal(recordedSignals.length, 0, "Case 3 MUTANT D: ZERO signals recorded on runner sid member refusal");
    }

    // Case 3 CONTROL: same set without runner PID/SID/PGID -> signals recorded
    {
      const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
      const testSignalFn: SignalFn = (target, signal) => {
        recordedSignals.push({ target, signal });
        return false;
      };

      const mockLookup = (pids: number[]) => {
        const m = new Map<number, { uid: number; pgid: number; sess: number }>();
        for (const p of pids) m.set(p, { uid: runnerUid, pgid: 20000, sess: 20000 });
        return m;
      };

      const success = await teardownProcessTreeForTest({
        childPid: 12345,
        childPgid: null,
        trackedDescendants: new Set([12346]),
        signalFn: testSignalFn,
      }, (pids) => assertSafeKillSetForTest(pids, { runnerPgid: 88888, runnerPid: 77777, runnerSid: 66666 }, mockLookup));

      assert.equal(success, true, "Case 3 CONTROL: safe set without runner pid/sid/pgid must succeed");
      const killed = Array.from(new Set(recordedSignals.filter((s) => s.signal === "SIGKILL").map((s) => s.target)));
      assert.deepEqual(killed.sort((a, b) => a - b), [12345, 12346], "Case 3 CONTROL: signals recorded for planned set");
    }

    // =========================================================================
    // COMMIT A POLES (rework 15): allowlist totality, plain prototype, private allowlists, all 3 entries x all forms
    // =========================================================================

    // 1. Compile-time type checks: production entries reject test knobs and unknown keys
    if (false as boolean) {
      // @ts-expect-error signalFn is not accepted on teardownProcessTree
      void teardownProcessTree({ childPid: null, childPgid: null, trackedDescendants: new Set(), signalFn: () => false });
      // @ts-expect-error timeoutMs is not accepted on teardownProcessTree
      void teardownProcessTree({ childPid: null, childPgid: null, trackedDescendants: new Set(), timeoutMs: 1000 });
      // @ts-expect-error killContext is not accepted on teardownProcessTree
      void teardownProcessTree({ childPid: null, childPgid: null, trackedDescendants: new Set(), killContext: { maxCap: 1000 } });

      // @ts-expect-error signalFn is not accepted on spawnClaudeL10Child
      void spawnClaudeL10Child({ argv: ["/bin/sleep", "0.1"], cwd: "/tmp", childEnv: {}, promptText: "", timeoutMs: 1000, cancelSignal: { cancelled: () => false }, runId: "dummy", signalFn: () => false });
      // @ts-expect-error maxSnapshotGapMs is not accepted on spawnClaudeL10Child
      void spawnClaudeL10Child({ argv: ["/bin/sleep", "0.1"], cwd: "/tmp", childEnv: {}, promptText: "", timeoutMs: 1000, cancelSignal: { cancelled: () => false }, runId: "dummy", maxSnapshotGapMs: 500 });
      // @ts-expect-error skipExitSnapshot is not accepted on spawnClaudeL10Child
      void spawnClaudeL10Child({ argv: ["/bin/sleep", "0.1"], cwd: "/tmp", childEnv: {}, promptText: "", timeoutMs: 1000, cancelSignal: { cancelled: () => false }, runId: "dummy", skipExitSnapshot: true });
      // @ts-expect-error onSnapshot is not accepted on spawnClaudeL10Child
      void spawnClaudeL10Child({ argv: ["/bin/sleep", "0.1"], cwd: "/tmp", childEnv: {}, promptText: "", timeoutMs: 1000, cancelSignal: { cancelled: () => false }, runId: "dummy", onSnapshot: () => {} });
      // @ts-expect-error teardownTimeoutMs is not accepted on spawnClaudeL10Child
      void spawnClaudeL10Child({ argv: ["/bin/sleep", "0.1"], cwd: "/tmp", childEnv: {}, promptText: "", timeoutMs: 1000, cancelSignal: { cancelled: () => false }, runId: "dummy", teardownTimeoutMs: 1000 });
      // @ts-expect-error killContext is not accepted on spawnClaudeL10Child
      void spawnClaudeL10Child({ argv: ["/bin/sleep", "0.1"], cwd: "/tmp", childEnv: {}, promptText: "", timeoutMs: 1000, cancelSignal: { cancelled: () => false }, runId: "dummy", killContext: { maxCap: 1000 } });

      // @ts-expect-error signalFn is not accepted on spawnL10Child
      void spawnL10Child({ argv: ["/bin/sleep", "0.1"], cwd: "/tmp", childEnv: {}, promptText: "", timeoutMs: 1000, cancelSignal: { cancelled: () => false }, signalFn: () => false });
      // @ts-expect-error futureKnob is not accepted on spawnL10Child
      void spawnL10Child({ argv: ["/bin/sleep", "0.1"], cwd: "/tmp", childEnv: {}, promptText: "", timeoutMs: 1000, cancelSignal: { cancelled: () => false }, futureKnob: 1 });

      // @ts-expect-error PRODUCTION_TEARDOWN_OPTIONS is not exported from ./l10-process
      void l10ProcessNamespace.PRODUCTION_TEARDOWN_OPTIONS;
      // @ts-expect-error PRODUCTION_SPAWN_OPTIONS is not exported from ./l10-process
      void l10ProcessNamespace.PRODUCTION_SPAWN_OPTIONS;
      // @ts-expect-error PRODUCTION_SPAWN_CLAUDE_OPTIONS is not exported from ./l10-process
      void l10ProcessNamespace.PRODUCTION_SPAWN_CLAUDE_OPTIONS;
      // @ts-expect-error PRODUCTION_SPAWN_CODEX_OPTIONS is not exported from ./l10-process
      void l10ProcessNamespace.PRODUCTION_SPAWN_CODEX_OPTIONS;
    }

    // 2. Mutated-allowlist pole: allowlists are private and immutable
    {
      assert.equal((l10ProcessNamespace as any).PRODUCTION_TEARDOWN_OPTIONS, undefined, "PRODUCTION_TEARDOWN_OPTIONS must not be exported");
      assert.equal((l10ProcessNamespace as any).PRODUCTION_SPAWN_OPTIONS, undefined, "PRODUCTION_SPAWN_OPTIONS must not be exported");
      assert.equal((l10ProcessNamespace as any).PRODUCTION_SPAWN_CLAUDE_OPTIONS, undefined, "PRODUCTION_SPAWN_CLAUDE_OPTIONS must not be exported");
      assert.equal((l10ProcessNamespace as any).PRODUCTION_SPAWN_CODEX_OPTIONS, undefined, "PRODUCTION_SPAWN_CODEX_OPTIONS must not be exported");
      assert.throws(() => {
        (l10ProcessNamespace as any).PRODUCTION_TEARDOWN_OPTIONS.add("signalFn");
      }, /TypeError/);
    }

    // 3. Comprehensive Tripwire Totality poles: all 3 production entries x 10 forms
    {
      const waitForExit = async (pid: number, timeoutMs = 2000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          try {
            process.kill(pid, 0);
            await new Promise((r) => setTimeout(r, 20));
          } catch {
            return true;
          }
        }
        return false;
      };

      const forms: Record<string, (o: any, rec: any) => any> = {
        PLAIN: (o, rec) => ({ ...o, signalFn: rec }),
        AS_ANY: (o, rec) => ({ ...o, signalFn: rec } as any),
        COMPUTED: (o, rec) => ({ ...o, ["sig" + "nalFn"]: rec }),
        UNKNOWN: (o) => ({ ...o, futureKnob: 1 }),
        NON_ENUMERABLE: (o, rec) => Object.defineProperty(o, "signalFn", { value: rec, enumerable: false, configurable: true }),
        INHERITED: (o, rec) => Object.assign(Object.create({ signalFn: rec }), o),
        CLASS_METHOD: (o, rec) => {
          class Options {
            signalFn(t: number, s: any) {
              return rec(t, s);
            }
          }
          return Object.assign(new Options(), o);
        },
        SYMBOL: (o, rec) => ({ ...o, [Symbol("signalFn")]: rec }),
        NULL_PROTO_HIDDEN: (o, rec) => Object.defineProperty(Object.assign(Object.create(null), o), "signalFn", { value: rec, enumerable: false }),
        PROXY_HIDDEN: (o, rec) => new Proxy({ ...o, signalFn: rec }, { ownKeys: (t) => Reflect.ownKeys(t).filter((k) => k !== "signalFn") }),
      };

      // (A) teardownProcessTree poles:
      for (const [form, builder] of Object.entries(forms)) {
        const recEvents: any[] = [];
        const rec = (t: number, s: any) => {
          recEvents.push([t, s]);
          return false;
        };
        const baseOpts = { childPid: 310001, childPgid: null, trackedDescendants: new Set([310002]) };
        const testOpts = builder(baseOpts, rec);

        if (form === "PROXY_HIDDEN") {
          // Proxy is not refused: knob is ignored, recorder sees 0 events
          // Using childPid null so teardown succeeds immediately without real signals
          const proxyOpts = builder({ childPid: null, childPgid: null, trackedDescendants: new Set() }, rec);
          const ok = await teardownProcessTree(proxyOpts as any);
          assert.equal(ok, true, `teardownProcessTree PROXY_HIDDEN: must succeed`);
          assert.equal(recEvents.length, 0, `teardownProcessTree PROXY_HIDDEN: recorder must see 0 events`);
        } else {
          let err: any = null;
          try {
            await teardownProcessTree(testOpts as any);
          } catch (e: any) {
            err = e;
          }
          assert.ok(err instanceof AdapterFailure, `teardownProcessTree ${form}: must throw AdapterFailure`);
          assert.equal(err.code, "UNSUPPORTED_OPTION_ON_PRODUCTION_ENTRY", `teardownProcessTree ${form}: code must match`);
          assert.equal(recEvents.length, 0, `teardownProcessTree ${form}: recorder must see 0 events`);
        }
      }

      // teardownProcessTree CONTROL:
      {
        const recEvents: any[] = [];
        const ok = await teardownProcessTree({ childPid: null, childPgid: null, trackedDescendants: new Set() });
        assert.equal(ok, true, "teardownProcessTree CONTROL: must succeed");
        assert.equal(recEvents.length, 0, "teardownProcessTree CONTROL: 0 recorder events");
      }

      // (B) spawnClaudeL10Child poles:
      for (const [form, builder] of Object.entries(forms)) {
        const poolDir = join(dir, `tripwire-claude-${form}-${Date.now()}`);
        mkdirSync(poolDir, { recursive: true });
        const pool = new L10PermitPool(poolDir, 1);
        const recEvents: any[] = [];
        const rec = (t: number, s: any) => {
          recEvents.push([t, s]);
          return false;
        };
        const claudeBinDir = join(dir, "bin");
        mkdirSync(claudeBinDir, { recursive: true });
        const claudeBin = join(claudeBinDir, "claude");
        writeFileSync(claudeBin, "#!/bin/sh\ncat > /dev/null\nsleep 0.15\n", { mode: 0o755 });

        const baseOpts = {
          argv: [claudeBin, ...fullClaudeArgs],
          cwd: dir,
          childEnv: buildChildEnv({ route: "claude", runId: `tc-${form}`, home: dir, runDir: dir }),
          promptText: "",
          timeoutMs: 3000,
          cancelSignal: { cancelled: () => false },
          runId: `tc-${form}`,
          permitPool: pool,
        };
        const testOpts = builder(baseOpts, rec);

        if (form === "PROXY_HIDDEN") {
          // Proxy bypasses allowlist check, but production entry rejects foreign fixture binary before spawn
          let err: any = null;
          try {
            await spawnClaudeL10Child(testOpts as any);
          } catch (e: any) {
            err = e;
          }
          assert.ok(err instanceof AdapterFailure, `spawnClaudeL10Child PROXY_HIDDEN: must throw AdapterFailure`);
          assert.equal(err.code, "MODEL_UNAVAILABLE", `spawnClaudeL10Child PROXY_HIDDEN: code must be MODEL_UNAVAILABLE`);
          assert.equal(recEvents.length, 0, `spawnClaudeL10Child PROXY_HIDDEN: recorder must see 0 events`);
          assert.equal(readdirSync(poolDir).length, 0, `spawnClaudeL10Child PROXY_HIDDEN: no permit files created`);
        } else {
          let err: any = null;
          try {
            await spawnClaudeL10Child(testOpts as any);
          } catch (e: any) {
            err = e;
          }
          assert.ok(err instanceof AdapterFailure, `spawnClaudeL10Child ${form}: must throw AdapterFailure`);
          assert.equal(err.code, "UNSUPPORTED_OPTION_ON_PRODUCTION_ENTRY", `spawnClaudeL10Child ${form}: code must match`);
          assert.equal(recEvents.length, 0, `spawnClaudeL10Child ${form}: recorder must see 0 events`);
          assert.equal(readdirSync(poolDir).length, 0, `spawnClaudeL10Child ${form}: no permit files created`);
        }
      }

      // spawnClaudeL10Child CONTROL:
      {
        const poolDir = join(dir, `tripwire-claude-ctrl-${Date.now()}`);
        mkdirSync(poolDir, { recursive: true });
        const pool = new L10PermitPool(poolDir, 1);
        const claudeBin = join(dir, "bin", "claude");
        const res = await spawnClaudeL10ChildForTest({
          argv: [claudeBin, ...fullClaudeArgs],
          cwd: dir,
          childEnv: buildChildEnv({ route: "claude", runId: "ctrl", home: dir, runDir: dir }),
          promptText: "",
          timeoutMs: 3000,
          cancelSignal: { cancelled: () => false },
          runId: "ctrl",
          permitPool: pool,
        });
        assert.ok(res.childPid > 0, "spawnClaudeL10Child CONTROL: childPid > 0");

        // Verify production entry rejects foreign fixture binary
        await assert.rejects(async () => {
          await spawnClaudeL10Child({
            argv: [claudeBin, ...fullClaudeArgs],
            cwd: dir,
            childEnv: buildChildEnv({ route: "claude", runId: "ctrl-foreign", home: dir, runDir: dir }),
            promptText: "",
            timeoutMs: 3000,
            cancelSignal: { cancelled: () => false },
            runId: "ctrl-foreign",
            permitPool: pool,
          });
        }, (err: any) => err.code === "MODEL_UNAVAILABLE" && err.message.includes("invalid claude binary"));
      }

      // (C) spawnL10Child poles:
      for (const [form, builder] of Object.entries(forms)) {
        const recEvents: any[] = [];
        const rec = (t: number, s: any) => {
          recEvents.push([t, s]);
          return false;
        };

        if (form === "PROXY_HIDDEN") {
          // Proxy on spawnL10Child: owned fixture killed by REAL path, recorder sees 0 events
          const pDir = join(dir, `tripwire-spawnl10-proxy-${Date.now()}`);
          mkdirSync(pDir, { recursive: true });
          const pidFile = join(pDir, "fixture.pid");
          const pyScript = join(pDir, "fixture.py");
          writeFileSync(pyScript, `import os, time, sys\nwith open(sys.argv[1], 'w') as f:\n    f.write(str(os.getpid()))\ntime.sleep(30)\n`);

          const baseOpts = {
            argv: [PYTHON_ABS, pyScript, pidFile],
            cwd: pDir,
            childEnv: buildChildEnv({ route: "claude", runId: "proxy-kill", home: pDir, runDir: pDir }),
            promptText: "",
            timeoutMs: 150,
            cancelSignal: { cancelled: () => false },
          };
          const testOpts = builder(baseOpts, rec);

          let spawnErr: any = null;
          try {
            await spawnL10Child(testOpts as any);
          } catch (e: any) {
            spawnErr = e;
          }
          assert.ok(spawnErr instanceof AdapterFailure, "spawnL10Child PROXY_HIDDEN: times out");
          assert.equal(spawnErr.code, "TIMEOUT", "spawnL10Child PROXY_HIDDEN: timed out as expected");
          assert.equal(recEvents.length, 0, "spawnL10Child PROXY_HIDDEN: recorder must see 0 events");

          // Assert owned fixture was killed by the REAL path:
          assert.ok(existsSync(pidFile), "fixture pidFile must exist");
          const fixturePid = Number(readFileSync(pidFile, "utf8"));
          assert.ok(fixturePid > 0, "fixturePid must be positive");
          const dead = await waitForExit(fixturePid, 2000);
          assert.equal(dead, true, "spawnL10Child PROXY_HIDDEN: fixture was killed by real kill path");
        } else {
          const baseOpts = {
            argv: ["/bin/sleep", "0.1"],
            cwd: dir,
            childEnv: buildChildEnv({ route: "claude", runId: `sl10-${form}`, home: dir, runDir: dir }),
            promptText: "",
            timeoutMs: 2000,
            cancelSignal: { cancelled: () => false },
          };
          const testOpts = builder(baseOpts, rec);
          let err: any = null;
          try {
            await spawnL10Child(testOpts as any);
          } catch (e: any) {
            err = e;
          }
          assert.ok(err instanceof AdapterFailure, `spawnL10Child ${form}: must throw AdapterFailure`);
          assert.equal(err.code, "UNSUPPORTED_OPTION_ON_PRODUCTION_ENTRY", `spawnL10Child ${form}: code must match`);
          assert.equal(recEvents.length, 0, `spawnL10Child ${form}: recorder must see 0 events`);
        }
      }

      // spawnL10Child CONTROL:
      {
        const res = await spawnL10Child({
          argv: ["/bin/sleep", "0.1"],
          cwd: dir,
          childEnv: buildChildEnv({ route: "claude", runId: "spawnl10-ctrl", home: dir, runDir: dir }),
          promptText: "",
          timeoutMs: 2000,
          cancelSignal: { cancelled: () => false },
        });
        assert.equal(res.diagnostic.exitCode, 0, "spawnL10Child CONTROL: exitCode 0");
      }

      // MUTANT for A: at c17367e, spawnL10Child with an as any signalFn sent SIGKILLs to recorder.
      // After fix: refused before spawn with UNSUPPORTED_OPTION_ON_PRODUCTION_ENTRY, recorder sees 0 events.
      {
        const recEvents: any[] = [];
        const rec = (t: number, s: any) => {
          recEvents.push([t, s]);
          return false;
        };
        let mutantThrew: any = null;
        try {
          await spawnL10Child({
            argv: ["/bin/sleep", "0.1"],
            cwd: dir,
            childEnv: buildChildEnv({ route: "claude", runId: "mutant-a", home: dir, runDir: dir }),
            promptText: "",
            timeoutMs: 2000,
            cancelSignal: { cancelled: () => false },
            signalFn: rec,
          } as any);
        } catch (e: any) {
          mutantThrew = e;
        }
        assert.ok(mutantThrew instanceof AdapterFailure, "MUTANT for A: must throw AdapterFailure");
        assert.equal(mutantThrew.code, "UNSUPPORTED_OPTION_ON_PRODUCTION_ENTRY");
        assert.equal(recEvents.length, 0, "MUTANT for A: recorder sees 0 events");
      }
    }

    // 4. Observer containment poles:
    {
      const observerPoleDir = join(dir, `observer-poles-${Date.now()}`);
      mkdirSync(observerPoleDir, { recursive: true });

      const runObserverPole = async (opts: { throwObserver: boolean; runName: string }) => {
        const poleDir = join(observerPoleDir, opts.runName);
        mkdirSync(poleDir, { recursive: true });
        const pool = new L10PermitPool(join(poleDir, "permits"), 1);
        const childEnv = buildChildEnv({ route: "claude", runId: opts.runName, home: observerPoleDir, runDir: poleDir });
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

        let observedGcPid = 0;
        let samples = 0;
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
              while (Date.now() - start < 5000) {
                if (existsSync(gcPidFile)) {
                  const raw = readFileSync(gcPidFile, "utf8").trim();
                  const pid = parseInt(raw, 10);
                  if (pid > 0) {
                    observedGcPid = pid;
                    break;
                  }
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
              }
              while (!existsSync(workerDoneFile) && Date.now() - start < 5000) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
              }
            }
          }
          return actual;
        } as any;
        syncBuiltinESMExports();

        const parentFixture = join(poleDir, "claude-parent");
        writeFileSync(parentFixture, `#!/bin/sh\nexec "${PYTHON_ABS ?? "/usr/local/bin/python"}" "${parentPy}" "$@"\n`, { mode: 0o755 });

        try {
          const res = await spawnClaudeL10ChildForTest({
            argv: [parentFixture, ...fullClaudeArgs],
            cwd: poleDir,
            childEnv,
            promptText: "",
            timeoutMs: 4000,
            maxSnapshotGapMs: 10000,
            cancelSignal: { cancelled: () => false },
            runId: `${opts.runName}-run`,
            permitPool: pool,
            onSnapshot: (phase, _seen) => {
              if (phase === "exit" && opts.throwObserver) {
                throw new Error("Observer throw test");
              }
            },
          });

          // Death predicate: waitForExit on observedGcPid
          const deadline = Date.now() + 1500;
          let isDead = false;
          while (Date.now() < deadline) {
            try {
              process.kill(observedGcPid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") { isDead = true; break; }
            }
            try {
              const state = (originalExecFileSync as any)("/bin/ps", ["-p", String(observedGcPid), "-o", "state="], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim();
              if (!state || state.startsWith("Z")) { isDead = true; break; }
            } catch {
              isDead = true; break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }

          // Permit re-acquire check
          let reacquired = false;
          try {
            const next = await pool.acquire(`next-${opts.runName}`, { deadlineMs: 100 });
            reacquired = true;
            next.release();
          } catch {}

          return { res, observedGcPid, isDead, reacquired };
        } finally {
          try { writeFileSync(goFile, "go"); } catch {}
          try { writeFileSync(workerDoneFile, "done"); } catch {}
          cp.execFileSync = originalExecFileSync;
          syncBuiltinESMExports();
          if (observedGcPid > 0) {
            try { process.kill(observedGcPid, "SIGKILL"); } catch {}
          }
        }
      };

      // CONTROL: observer returns normally
      const control = await runObserverPole({ throwObserver: false, runName: "control" });
      assert.equal(control.isDead, true, "Observer CONTROL: descendant confirmed dead");
      assert.equal(control.reacquired, true, "Observer CONTROL: permit re-acquired");

      // MUTANT: exit observer throws
      const mutant = await runObserverPole({ throwObserver: true, runName: "mutant" });
      assert.equal(mutant.isDead, true, "Observer MUTANT: descendant confirmed dead despite observer throw");
      assert.equal(mutant.reacquired, true, "Observer MUTANT: permit re-acquired despite observer throw");
      assert.ok(mutant.res.observerError, "Observer MUTANT: observerError reported on result");
    }

    // =========================================================================
    // A-5 POLES: Ancestry poller unhandled rejection and containment poles
    // =========================================================================
    {
      const unhandledRejections: any[] = [];
      const onUnhandled = (reason: any) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      try {
        const pollerPoleDir = join(dir, "poller-poles");
        mkdirSync(pollerPoleDir, { recursive: true });
        const pool = new L10PermitPool(join(pollerPoleDir, "permits"), 1);

        // MUTANT: poller observer throws on first call
        // 0 unhandled rejections recorded, runner stays alive, call settles as AdapterFailure TEARDOWN_UNCONFIRMED
        // Fixture is killed (same death predicate), permit is poisoned
        {
          const recordedSignals: any[] = [];
          let spawnedChildPid = 0;
          const recordingSignalFn: SignalFn = (target, sig) => {
            recordedSignals.push({ target, sig });
            if (target > 0 && spawnedChildPid === 0) spawnedChildPid = target;
            if (sig === 0) {
              try { process.kill(target, 0); return true; } catch { return false; }
            }
            try { process.kill(target, sig); return true; } catch { return false; }
          };

          const childEnv = buildChildEnv({ route: "claude", runId: "poller-mutant-run", home: pollerPoleDir, runDir: pollerPoleDir });
          const pollerFixture = join(pollerPoleDir, "claude-sleep");
          writeFileSync(pollerFixture, "#!/bin/sh\nsleep 0.2\n", { mode: 0o755 });

          let mutantErr: any = null;
          try {
            await spawnClaudeL10ChildForTest({
              argv: [pollerFixture, ...fullClaudeArgs],
              cwd: pollerPoleDir,
              childEnv,
              promptText: "",
              timeoutMs: 2000,
              maxSnapshotGapMs: 10000,
              cancelSignal: { cancelled: () => false },
              runId: "poller-mutant-run",
              permitPool: pool,
              signalFn: recordingSignalFn,
              onSnapshot: (phase) => {
                if (phase === "poller") {
                  throw new Error("poller observer throw test");
                }
              },
            });
          } catch (e: any) {
            mutantErr = e;
          }

          await new Promise((r) => setTimeout(r, 50));

          assert.equal(unhandledRejections.length, 0, "Poller MUTANT: 0 unhandled rejections recorded");
          assert.ok(mutantErr instanceof AdapterFailure, "Poller MUTANT: must throw AdapterFailure");
          assert.equal(mutantErr.code, "TEARDOWN_UNCONFIRMED", "Poller MUTANT: code must be TEARDOWN_UNCONFIRMED");
          assert.ok(mutantErr.pollerError, "Poller MUTANT: pollerError attached to error");
          assert.equal(mutantErr.pollerError.message, "poller observer throw test");

          // Permit is poisoned
          const permitContent = JSON.parse(readFileSync(join(pollerPoleDir, "permits", "permit-0.json"), "utf8"));
          assert.equal(permitContent.status, "POISONED", "Poller MUTANT: permit must be POISONED");

          // Fixture is confirmed dead (death predicate)
          assert.ok(spawnedChildPid > 0, "Poller MUTANT: spawned child pid captured");
          let isDead = false;
          const deadline = Date.now() + 1500;
          while (Date.now() < deadline) {
            try {
              process.kill(spawnedChildPid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") { isDead = true; break; }
            }
            await new Promise((r) => setTimeout(r, 20));
          }
          assert.equal(isDead, true, "Poller MUTANT: fixture confirmed killed");
        }

        // CONTROL: poller observer returns normally, run settles normally
        {
          const recordedSignals: any[] = [];
          const recordingSignalFn: SignalFn = (target, sig) => {
            recordedSignals.push({ target, sig });
            if (sig === 0) {
              try { process.kill(target, 0); return true; } catch { return false; }
            }
            try { process.kill(target, sig); return true; } catch { return false; }
          };

          // Remove the poisoned permit to allow CONTROL run
          try { unlinkSync(join(pollerPoleDir, "permits", "permit-0.json")); } catch {}

          const childEnv = buildChildEnv({ route: "claude", runId: "poller-ctrl-run", home: pollerPoleDir, runDir: pollerPoleDir });
          const pollerFixture = join(pollerPoleDir, "claude-sleep");
          let pollerObservedCount = 0;
          const res = await spawnClaudeL10ChildForTest({
            argv: [pollerFixture, ...fullClaudeArgs],
            cwd: pollerPoleDir,
            childEnv,
            promptText: "",
            timeoutMs: 2000,
            maxSnapshotGapMs: 10000,
            cancelSignal: { cancelled: () => false },
            runId: "poller-ctrl-run",
            permitPool: pool,
            signalFn: recordingSignalFn,
            onSnapshot: (phase) => {
              if (phase === "poller") {
                pollerObservedCount++;
              }
            },
          });

          await new Promise((r) => setTimeout(r, 50));

          assert.equal(unhandledRejections.length, 0, "Poller CONTROL: 0 unhandled rejections recorded");
          assert.ok(res.childPid > 0, "Poller CONTROL: child must have run");
          assert.ok(pollerObservedCount >= 1, "Poller CONTROL: poller observer called");

          // Permit released cleanly
          assert.ok(!existsSync(join(pollerPoleDir, "permits", "permit-0.json")), "Poller CONTROL: permit released cleanly");
        }
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
      }
    }

    // =========================================================================
    // COMMIT 2 (REWORK 15) POLES:
    // P2a: observer error preserved on child failure (EXIT_AFTER_TIMEOUT pair)
    // P2b: non-throwing safe error normalization & teardown execution
    // =========================================================================
    {
      // 1. safeErrorText & safeError unit poles:
      assert.equal(safeErrorText(new Error("hello")), "hello");
      assert.equal(safeErrorText("simple string"), "simple string");
      assert.equal(safeErrorText(123), "123");
      assert.equal(
        safeErrorText({
          toString() {
            throw new Error("exploding toString");
          },
        }),
        "<unprintable thrown value>",
        "safeErrorText must never throw on exploding toString",
      );
      const explodingErr = new Error();
      Object.defineProperty(explodingErr, "message", {
        get() {
          throw new Error("exploding getter");
        },
      });
      assert.equal(
        safeErrorText(explodingErr),
        "<unprintable thrown value>",
        "safeErrorText must safely handle throwing message getter",
      );

      const err1 = safeError(new Error("already error"));
      assert.ok(err1 instanceof Error);
      assert.equal(err1.message, "already error");

      const err2 = safeError({
        toString() {
          throw new Error("exploding toString");
        },
      });
      assert.ok(err2 instanceof Error);
      assert.equal(err2.message, "<unprintable thrown value>");

      // P2 unit pole: Proxy whose getPrototypeOf throws
      const throwingProxy = new Proxy({}, {
        getPrototypeOf() {
          throw new Error("prototype failure from idle-observer hook");
        },
      });
      assert.equal(
        safeErrorText(throwingProxy),
        "[object Object]",
        "safeErrorText must never throw on throwing getPrototypeOf proxy",
      );
      const errProxy = safeError(throwingProxy);
      assert.ok(errProxy instanceof Error);
      assert.equal(errProxy.message, "[object Object]");
    }

    // 2. P2a: EXIT_AFTER_TIMEOUT pair:
    {
      const timeoutPoleDir = join(dir, `timeout-observer-poles-${Date.now()}`);
      mkdirSync(timeoutPoleDir, { recursive: true });

      const runTimeoutPole = async (opts: { throwObserver: boolean; runName: string }) => {
        const poleDir = join(timeoutPoleDir, opts.runName);
        mkdirSync(poleDir, { recursive: true });
        const pool = new L10PermitPool(join(poleDir, "permits"), 1);
        const gcPidFile = join(poleDir, "gc.pid");
        const parentPy = join(poleDir, "parent.py");

        writeFileSync(
          parentPy,
          `import os, time, sys
p = os.fork()
if p == 0:
    null = os.open('/dev/null', os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    with open(${JSON.stringify(gcPidFile)}, 'w') as f:
        f.write(str(os.getpid()))
    time.sleep(30)
    sys.exit(0)
time.sleep(30)
sys.exit(0)
`,
        );

        let observedGcPid = 0;
        let thrownError: any = null;
        let observerCalls = 0;

        const parentFixture = join(poleDir, "claude-parent");
        writeFileSync(parentFixture, `#!/bin/sh\nexec "${PYTHON_ABS ?? "/usr/local/bin/python"}" "${parentPy}" "$@"\n`, { mode: 0o755 });

        try {
          await spawnClaudeL10ChildForTest({
            argv: [parentFixture, ...fullClaudeArgs],
            cwd: poleDir,
            childEnv: buildChildEnv({ route: "claude", runId: opts.runName, home: timeoutPoleDir, runDir: poleDir }),
            promptText: "",
            timeoutMs: 300,
            maxSnapshotGapMs: 10000,
            cancelSignal: { cancelled: () => false },
            runId: opts.runName,
            permitPool: pool,
            onSnapshot: (phase, _pids) => {
              if (existsSync(gcPidFile) && observedGcPid === 0) {
                const raw = readFileSync(gcPidFile, "utf8").trim();
                const p = parseInt(raw, 10);
                if (p > 0) observedGcPid = p;
              }
              if (phase === "exit") {
                observerCalls++;
                if (opts.throwObserver) {
                  throw new Error("exit-after-timeout observer failure");
                }
              }
            },
          });
        } catch (e: any) {
          thrownError = e;
        }

        // Wait for observedGcPid to be killed by teardown
        let isDead = false;
        if (observedGcPid > 0) {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            try {
              process.kill(observedGcPid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") { isDead = true; break; }
            }
            try {
              const state = execFileSync("/bin/ps", ["-p", String(observedGcPid), "-o", "state="], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim();
              if (!state || state.startsWith("Z")) { isDead = true; break; }
            } catch {
              isDead = true; break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        }

        // Permit reacquire check
        let reacquired = false;
        try {
          const next = await pool.acquire(`next-${opts.runName}`, { deadlineMs: 100 });
          reacquired = true;
          next.release();
        } catch {}

        return { thrownError, observedGcPid, isDead, reacquired, observerCalls };
      };

      // CONTROL: timeout without observer throw -> TIMEOUT error, observerError undefined
      const ctrl = await runTimeoutPole({ throwObserver: false, runName: "ctrl" });
      assert.ok(ctrl.thrownError instanceof AdapterFailure, "EXIT_AFTER_TIMEOUT CONTROL: throws AdapterFailure");
      assert.equal(ctrl.thrownError.code, "TIMEOUT", "EXIT_AFTER_TIMEOUT CONTROL: code is TIMEOUT");
      assert.equal(ctrl.thrownError.observerError, undefined, "EXIT_AFTER_TIMEOUT CONTROL: observerError is undefined");
      assert.equal(ctrl.isDead, true, "EXIT_AFTER_TIMEOUT CONTROL: descendant killed by teardown");
      assert.equal(ctrl.reacquired, true, "EXIT_AFTER_TIMEOUT CONTROL: permit reacquired cleanly");

      // MUTANT: timeout with observer throw -> TIMEOUT error preserved AND observerError attached!
      const mutant = await runTimeoutPole({ throwObserver: true, runName: "mutant" });
      assert.ok(mutant.thrownError instanceof AdapterFailure, "EXIT_AFTER_TIMEOUT MUTANT: throws AdapterFailure");
      assert.equal(mutant.thrownError.code, "TIMEOUT", "EXIT_AFTER_TIMEOUT MUTANT: code remains TIMEOUT");
      assert.ok(mutant.thrownError.observerError, "EXIT_AFTER_TIMEOUT MUTANT: observerError attached");
      assert.equal(
        mutant.thrownError.observerError.message,
        "exit-after-timeout observer failure",
        "EXIT_AFTER_TIMEOUT MUTANT: observerError message preserved",
      );
      assert.equal(mutant.isDead, true, "EXIT_AFTER_TIMEOUT MUTANT: descendant killed by teardown");
      assert.equal(mutant.reacquired, true, "EXIT_AFTER_TIMEOUT MUTANT: permit reacquired cleanly");
    }

    // 3. P2b: Throwing coercion objects (safe normalization & teardown execution):
    {
      const coercionPoleDir = join(dir, `coercion-poles-${Date.now()}`);
      mkdirSync(coercionPoleDir, { recursive: true });

      // Pole 1: Exit observer throws an object whose toString throws
      // Descendant ends ABSENT, permit is settled/released, observerError is reported safely as "<unprintable thrown value>"
      {
        const poleDir = join(coercionPoleDir, "exit-coercion");
        mkdirSync(poleDir, { recursive: true });
        const pool = new L10PermitPool(join(poleDir, "permits"), 1);
        const gcPidFile = join(poleDir, "gc.pid");
        const parentPy = join(poleDir, "parent.py");

        writeFileSync(
          parentPy,
          `import os, time, sys
p = os.fork()
if p == 0:
    null = os.open('/dev/null', os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    with open(${JSON.stringify(gcPidFile)}, 'w') as f:
        f.write(str(os.getpid()))
    time.sleep(30)
    sys.exit(0)
time.sleep(0.15)
sys.exit(0)
`,
        );

        let observedGcPid = 0;
        let res: any = null;
        let caughtErr: any = null;

        const parentFixture = join(poleDir, "claude-parent");
        writeFileSync(parentFixture, `#!/bin/sh\nexec "${PYTHON_ABS ?? "/usr/local/bin/python"}" "${parentPy}" "$@"\n`, { mode: 0o755 });

        try {
          res = await spawnClaudeL10ChildForTest({
            argv: [parentFixture, ...fullClaudeArgs],
            cwd: poleDir,
            childEnv: buildChildEnv({ route: "claude", runId: "exit-coercion", home: coercionPoleDir, runDir: poleDir }),
            promptText: "",
            timeoutMs: 3000,
            maxSnapshotGapMs: 10000,
            cancelSignal: { cancelled: () => false },
            runId: "exit-coercion",
            permitPool: pool,
            onSnapshot: (phase, _pids) => {
              if (existsSync(gcPidFile) && observedGcPid === 0) {
                const raw = readFileSync(gcPidFile, "utf8").trim();
                const p = parseInt(raw, 10);
                if (p > 0) observedGcPid = p;
              }
              if (phase === "exit") {
                throw {
                  toString() {
                    throw new Error("throwing coercion hook failed");
                  },
                };
              }
            },
          });
        } catch (e: any) {
          caughtErr = e;
        }

        // Descendant must be killed
        let isDead = false;
        if (observedGcPid > 0) {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            try {
              process.kill(observedGcPid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") { isDead = true; break; }
            }
            try {
              const state = execFileSync("/bin/ps", ["-p", String(observedGcPid), "-o", "state="], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim();
              if (!state || state.startsWith("Z")) { isDead = true; break; }
            } catch {
              isDead = true; break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        }

        assert.equal(isDead, true, "Exit coercion pole: descendant confirmed killed");
        let reacquired = false;
        try {
          const next = await pool.acquire("next-exit-coercion", { deadlineMs: 100 });
          reacquired = true;
          next.release();
        } catch {}
        assert.equal(reacquired, true, "Exit coercion pole: permit reacquired cleanly");

        assert.equal(caughtErr, null, "Exit coercion pole: child succeeded, did not throw uncaught error");
        assert.ok(res, "Exit coercion pole: result returned");
        assert.ok(res.observerError, "Exit coercion pole: observerError present");
        assert.equal(
          res.observerError.message,
          "<unprintable thrown value>",
          "Exit coercion pole: safeErrorText normalized exploding toString safely",
        );
      }

      // Pole 2: Poller observer throws an object whose toString throws
      // 0 unhandled rejections recorded, runner stays alive, typed TEARDOWN_UNCONFIRMED, fixture killed, permit poisoned
      {
        const poleDir = join(coercionPoleDir, "poller-coercion");
        mkdirSync(poleDir, { recursive: true });
        const pool = new L10PermitPool(join(poleDir, "permits"), 1);
        const gcPidFile = join(poleDir, "gc.pid");
        const parentPy = join(poleDir, "parent.py");

        writeFileSync(
          parentPy,
          `import os, time, sys
p = os.fork()
if p == 0:
    null = os.open('/dev/null', os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    with open(${JSON.stringify(gcPidFile)}, 'w') as f:
        f.write(str(os.getpid()))
    time.sleep(30)
    sys.exit(0)
time.sleep(30)
sys.exit(0)
`,
        );

        const unhandledRejections: any[] = [];
        const onUnhandled = (reason: any) => {
          unhandledRejections.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);

        let observedGcPid = 0;
        let caughtErr: any = null;

        const parentFixture = join(poleDir, "claude-parent");
        writeFileSync(parentFixture, `#!/bin/sh\nexec "${PYTHON_ABS ?? "/usr/local/bin/python"}" "${parentPy}" "$@"\n`, { mode: 0o755 });

        try {
          await spawnClaudeL10ChildForTest({
            argv: [parentFixture, ...fullClaudeArgs],
            cwd: poleDir,
            childEnv: buildChildEnv({ route: "claude", runId: "poller-coercion", home: coercionPoleDir, runDir: poleDir }),
            promptText: "",
            timeoutMs: 3000,
            maxSnapshotGapMs: 10000,
            cancelSignal: { cancelled: () => false },
            runId: "poller-coercion",
            permitPool: pool,
            onSnapshot: (phase, _pids) => {
              if (existsSync(gcPidFile) && observedGcPid === 0) {
                const raw = readFileSync(gcPidFile, "utf8").trim();
                const p = parseInt(raw, 10);
                if (p > 0) observedGcPid = p;
              }
              if (phase === "poller") {
                throw {
                  toString() {
                    throw new Error("throwing coercion hook failed");
                  },
                };
              }
            },
          });
        } catch (e: any) {
          caughtErr = e;
        } finally {
          process.removeListener("unhandledRejection", onUnhandled);
        }

        await new Promise((r) => setTimeout(r, 50));

        assert.equal(unhandledRejections.length, 0, "Poller coercion pole: 0 unhandled rejections");
        assert.ok(caughtErr instanceof AdapterFailure, "Poller coercion pole: throws AdapterFailure");
        assert.equal(caughtErr.code, "TEARDOWN_UNCONFIRMED", "Poller coercion pole: code is TEARDOWN_UNCONFIRMED");
        assert.ok(caughtErr.pollerError, "Poller coercion pole: pollerError attached");
        assert.equal(
          caughtErr.pollerError.message,
          "<unprintable thrown value>",
          "Poller coercion pole: pollerError safely normalized",
        );

        // Permit is poisoned
        const permitContent = JSON.parse(readFileSync(join(poleDir, "permits", "permit-0.json"), "utf8"));
        assert.equal(permitContent.status, "POISONED", "Poller coercion pole: permit poisoned");

        // Fixture killed
        let isDead = false;
        if (observedGcPid > 0) {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            try {
              process.kill(observedGcPid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") { isDead = true; break; }
            }
            try {
              const state = execFileSync("/bin/ps", ["-p", String(observedGcPid), "-o", "state="], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim();
              if (!state || state.startsWith("Z")) { isDead = true; break; }
            } catch {
              isDead = true; break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        assert.equal(isDead, true, "Poller coercion pole: fixture confirmed killed");
      }

      // Pole 3 (P2): Exit observer throws proxy with throwing getPrototypeOf trap
      // Descendant ends ABSENT, permit is settled/released, observerError is reported safely
      {
        const poleDir = join(coercionPoleDir, "exit-proto");
        mkdirSync(poleDir, { recursive: true });
        const pool = new L10PermitPool(join(poleDir, "permits"), 1);
        const gcPidFile = join(poleDir, "gc.pid");
        const parentPy = join(poleDir, "parent.py");

        writeFileSync(
          parentPy,
          `import os, time, sys
p = os.fork()
if p == 0:
    null = os.open('/dev/null', os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    with open(${JSON.stringify(gcPidFile)}, 'w') as f:
        f.write(str(os.getpid()))
    time.sleep(30)
    sys.exit(0)
time.sleep(0.15)
sys.exit(0)
`,
        );

        let observedGcPid = 0;
        let res: any = null;
        let caughtErr: any = null;

        const parentFixture = join(poleDir, "claude-parent");
        writeFileSync(parentFixture, `#!/bin/sh\nexec "${PYTHON_ABS ?? "/usr/local/bin/python"}" "${parentPy}" "$@"\n`, { mode: 0o755 });

        try {
          res = await spawnClaudeL10ChildForTest({
            argv: [parentFixture, ...fullClaudeArgs],
            cwd: poleDir,
            childEnv: buildChildEnv({ route: "claude", runId: "exit-proto", home: coercionPoleDir, runDir: poleDir }),
            promptText: "",
            timeoutMs: 3000,
            maxSnapshotGapMs: 10000,
            cancelSignal: { cancelled: () => false },
            runId: "exit-proto",
            permitPool: pool,
            onSnapshot: (phase, _pids) => {
              if (existsSync(gcPidFile) && observedGcPid === 0) {
                const raw = readFileSync(gcPidFile, "utf8").trim();
                const p = parseInt(raw, 10);
                if (p > 0) observedGcPid = p;
              }
              if (phase === "exit") {
                throw new Proxy({}, {
                  getPrototypeOf() {
                    throw new Error("prototype failure from idle-observer hook");
                  },
                });
              }
            },
          });
        } catch (e: any) {
          caughtErr = e;
        }

        let isDead = false;
        if (observedGcPid > 0) {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            try {
              process.kill(observedGcPid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") { isDead = true; break; }
            }
            try {
              const state = execFileSync("/bin/ps", ["-p", String(observedGcPid), "-o", "state="], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim();
              if (!state || state.startsWith("Z")) { isDead = true; break; }
            } catch {
              isDead = true; break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        }

        assert.equal(isDead, true, "Exit proto pole: descendant confirmed killed");
        let reacquired = false;
        try {
          const next = await pool.acquire("next-exit-proto", { deadlineMs: 100 });
          reacquired = true;
          next.release();
        } catch {}
        assert.equal(reacquired, true, "Exit proto pole: permit reacquired cleanly");

        assert.equal(caughtErr, null, "Exit proto pole: child succeeded, did not throw uncaught error");
        assert.ok(res, "Exit proto pole: result returned");
        assert.ok(res.observerError, "Exit proto pole: observerError present");
        assert.equal(
          res.observerError.message,
          "[object Object]",
          "Exit proto pole: safeErrorText normalized throwing getPrototypeOf proxy safely",
        );
      }

      // Pole 4 (P2): Poller observer throws proxy with throwing getPrototypeOf trap
      // 0 unhandled rejections recorded, runner stays alive, typed TEARDOWN_UNCONFIRMED, fixture killed, permit poisoned
      {
        const poleDir = join(coercionPoleDir, "poller-proto");
        mkdirSync(poleDir, { recursive: true });
        const pool = new L10PermitPool(join(poleDir, "permits"), 1);
        const gcPidFile = join(poleDir, "gc.pid");
        const parentPy = join(poleDir, "parent.py");

        writeFileSync(
          parentPy,
          `import os, time, sys
p = os.fork()
if p == 0:
    null = os.open('/dev/null', os.O_RDWR)
    for fd in [0, 1, 2]: os.dup2(null, fd)
    with open(${JSON.stringify(gcPidFile)}, 'w') as f:
        f.write(str(os.getpid()))
    time.sleep(30)
    sys.exit(0)
time.sleep(30)
sys.exit(0)
`,
        );

        const unhandledRejections: any[] = [];
        const onUnhandled = (reason: any) => {
          unhandledRejections.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);

        let observedGcPid = 0;
        let caughtErr: any = null;

        const parentFixture = join(poleDir, "claude-parent");
        writeFileSync(parentFixture, `#!/bin/sh\nexec "${PYTHON_ABS ?? "/usr/local/bin/python"}" "${parentPy}" "$@"\n`, { mode: 0o755 });

        try {
          await spawnClaudeL10ChildForTest({
            argv: [parentFixture, ...fullClaudeArgs],
            cwd: poleDir,
            childEnv: buildChildEnv({ route: "claude", runId: "poller-proto", home: coercionPoleDir, runDir: poleDir }),
            promptText: "",
            timeoutMs: 3000,
            maxSnapshotGapMs: 10000,
            cancelSignal: { cancelled: () => false },
            runId: "poller-proto",
            permitPool: pool,
            onSnapshot: (phase, _pids) => {
              if (existsSync(gcPidFile) && observedGcPid === 0) {
                const raw = readFileSync(gcPidFile, "utf8").trim();
                const p = parseInt(raw, 10);
                if (p > 0) observedGcPid = p;
              }
              if (phase === "poller") {
                throw new Proxy({}, {
                  getPrototypeOf() {
                    throw new Error("poller observer prototype hook failed");
                  },
                });
              }
            },
          });
        } catch (e: any) {
          caughtErr = e;
        } finally {
          process.removeListener("unhandledRejection", onUnhandled);
        }

        await new Promise((r) => setTimeout(r, 50));

        assert.equal(unhandledRejections.length, 0, "Poller proto pole: 0 unhandled rejections");
        assert.ok(caughtErr instanceof AdapterFailure, "Poller proto pole: throws AdapterFailure");
        assert.equal(caughtErr.code, "TEARDOWN_UNCONFIRMED", "Poller proto pole: code is TEARDOWN_UNCONFIRMED");
        assert.ok(caughtErr.pollerError, "Poller proto pole: pollerError attached");
        assert.equal(
          caughtErr.pollerError.message,
          "[object Object]",
          "Poller proto pole: pollerError safely normalized",
        );

        // Permit is poisoned
        const permitContent = JSON.parse(readFileSync(join(poleDir, "permits", "permit-0.json"), "utf8"));
        assert.equal(permitContent.status, "POISONED", "Poller proto pole: permit poisoned");

        // Fixture killed
        let isDead = false;
        if (observedGcPid > 0) {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            try {
              process.kill(observedGcPid, 0);
            } catch (e: any) {
              if (e.code === "ESRCH") { isDead = true; break; }
            }
            try {
              const state = execFileSync("/bin/ps", ["-p", String(observedGcPid), "-o", "state="], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim();
              if (!state || state.startsWith("Z")) { isDead = true; break; }
            } catch {
              isDead = true; break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        assert.equal(isDead, true, "Poller proto pole: fixture confirmed killed");
      }
    }

    // =========================================================================
    // COMMIT B POLES: C1 identity re-check on retry pass (recorder-only)
    // - CONTROL: matching lstart -> re-signal recorded
    // - MUTANT 1: lstart differs, cmd same -> no re-signal
    // - MUTANT 2: ps read throws -> no re-signal
    // - MUTANT 3: no record -> no re-signal
    // - Inner path pole: accumulatedDescendants arrives at spawnL10ChildInner
    // =========================================================================
    {
      const fixtureChild = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
      const fixturePid = fixtureChild.pid!;
      assert.ok(fixturePid > 0, "fixture child pid must be valid");

      try {
        const rawPs = execFileSync("/bin/ps", ["-o", "lstart=,command=", "-p", String(fixturePid)], { encoding: "utf8" }).trim();
        const match = rawPs.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/);
        const realLstart = match ? match[1] : "";
        const realCmd = match ? match[2] : "";
        assert.ok(realLstart.length > 0, "fixture child lstart must be non-empty");

        // CONTROL: matching lstart -> re-signal recorded
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          let checkCount = 0;
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            if (signal === 0) {
              checkCount++;
              return checkCount <= 2; // alive on iteration 0 and retry pass check, dead on completion check
            }
            return false;
          };

          const success = await teardownProcessTreeForTest({
            childPid: null,
            childPgid: null,
            trackedDescendants: new Set([fixturePid]),
            accumulatedDescendants: new Map([[fixturePid, { lstart: realLstart, cmd: realCmd }]]),
            signalFn: testSignalFn,
            timeoutMs: 1000,
          });

          assert.equal(success, true, "CONTROL: teardown completes confirmed");
          const sigkills = recordedSignals.filter((s) => s.target === fixturePid && s.signal === "SIGKILL");
          assert.equal(sigkills.length, 2, "CONTROL: exactly 2 SIGKILLs recorded (initial kill + verified retry re-signal)");
        }

        // MUTANT 1: lstart differs, cmd same -> no re-signal
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          let checkCount = 0;
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            if (signal === 0) {
              checkCount++;
              return checkCount <= 2;
            }
            return false;
          };

          const success = await teardownProcessTreeForTest({
            childPid: null,
            childPgid: null,
            trackedDescendants: new Set([fixturePid]),
            accumulatedDescendants: new Map([[fixturePid, { lstart: "Sun Jan  1 00:00:00 2000", cmd: realCmd }]]),
            signalFn: testSignalFn,
            timeoutMs: 1000,
          });

          assert.equal(success, true, "MUTANT 1: teardown completes");
          const sigkills = recordedSignals.filter((s) => s.target === fixturePid && s.signal === "SIGKILL");
          assert.equal(sigkills.length, 1, "MUTANT 1: exactly 1 SIGKILL recorded (0 retry re-signals when lstart differs)");
        }

        // MUTANT 2: ps read throws (nonexistent PID 99999) -> no re-signal
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          let checkCount = 0;
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            if (signal === 0) {
              checkCount++;
              return checkCount <= 2;
            }
            return false;
          };

          // MUTANT 2: ps read throws -> no re-signal
          // Calls teardownProcessTreeForTest directly (PID 99999 is absent so passes production guard)
          const success = await teardownProcessTreeForTest({
            childPid: null,
            childPgid: null,
            trackedDescendants: new Set([99999]),
            accumulatedDescendants: new Map([[99999, { lstart: realLstart, cmd: realCmd }]]),
            signalFn: testSignalFn,
            timeoutMs: 1000,
          });

          assert.equal(success, true, "MUTANT 2: teardown completes");
          const sigkills = recordedSignals.filter((s) => s.target === 99999 && s.signal === "SIGKILL");
          assert.equal(sigkills.length, 1, "MUTANT 2: exactly 1 SIGKILL recorded (0 retry re-signals when ps throws)");
        }

        // MUTANT 3: no record -> no re-signal
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          let checkCount = 0;
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            if (signal === 0) {
              checkCount++;
              return checkCount <= 2;
            }
            return false;
          };

          const success = await teardownProcessTreeForTest({
            childPid: null,
            childPgid: null,
            trackedDescendants: new Set([fixturePid]),
            accumulatedDescendants: new Map(), // empty map: no record for fixturePid
            signalFn: testSignalFn,
            timeoutMs: 1000,
          });

          assert.equal(success, true, "MUTANT 3: teardown completes");
          const sigkills = recordedSignals.filter((s) => s.target === fixturePid && s.signal === "SIGKILL");
          assert.equal(sigkills.length, 1, "MUTANT 3: exactly 1 SIGKILL recorded (0 retry re-signals when record is missing)");
        }

        // Inner path pole: accumulatedDescendants arrives at waitGroupDead in spawnL10ChildInner
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          let probeCount = 0;
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            if (signal === 0) {
              if (target === fixturePid) {
                probeCount++;
                return probeCount <= 1; // alive on first probe to trigger retry re-signal, dead on second
              }
              return false;
            }
            return false;
          };

          try {
            await spawnL10ChildInnerForTest(
              {
                argv: ["/bin/sleep", "0.2"],
                cwd: dir,
                childEnv: buildChildEnv({ route: "claude", runId: "inner-test", home: dir, runDir: dir }),
                promptText: "",
                timeoutMs: 50,
                cancelSignal: { cancelled: () => false },
                signalFn: testSignalFn,
              },
              undefined,
              new Set([fixturePid]),
              new Map([[fixturePid, { lstart: realLstart, cmd: realCmd }]]),
            );
          } catch (e: any) {
            assert.equal(e?.code, "TIMEOUT", "inner test expected TIMEOUT error");
          }

          const sigkills = recordedSignals.filter((s) => s.target === fixturePid && s.signal === "SIGKILL");
          assert.equal(sigkills.length, 3, "Inner path pole: exactly 3 SIGKILLs recorded on fixturePid (killProcessGroup + waitGroupDead retry re-signal)");
        }

        // Child retry identity pole (the security reviewer rework 12 section 7):
        // CONTROL: matching child start time -> retry signal recorded (2 SIGKILLs)
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          let checkCount = 0;
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            if (signal === 0) {
              checkCount++;
              return checkCount <= 2; // alive on iteration 0 and retry pass check, dead on completion check
            }
            return false;
          };

          const success = await teardownProcessTreeForTest({
            childPid: fixturePid,
            childPgid: null,
            trackedDescendants: new Set(),
            accumulatedDescendants: new Map([[fixturePid, { lstart: realLstart, cmd: realCmd }]]),
            signalFn: testSignalFn,
            timeoutMs: 1000,
          });

          assert.equal(success, true, "Child retry CONTROL: teardown completes confirmed");
          const sigkills = recordedSignals.filter((s) => s.target === fixturePid && s.signal === "SIGKILL");
          assert.equal(sigkills.length, 2, "Child retry CONTROL: exactly 2 SIGKILLs recorded (initial kill + verified retry)");
        }

        // MUTANT: stale child start time -> no retry signal, unconfirmed teardown, permit poisoned
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            if (signal === 0) return true; // keep fixture alive to trigger retry pass
            return false;
          };

          let poisonedReason: string | null = null;
          const testPermit = {
            poison: (reason: string) => {
              poisonedReason = reason;
            },
          };

          let threwUnconfirmed = false;
          try {
            await teardownProcessTreeForTest({
              childPid: fixturePid,
              childPgid: null,
              trackedDescendants: new Set(),
              accumulatedDescendants: new Map([[fixturePid, { lstart: "Mon Jan  1 00:00:00 2000", cmd: realCmd }]]), // stale start time
              signalFn: testSignalFn,
              permit: testPermit,
              timeoutMs: 100, // short timeout
            });
          } catch (err: any) {
            threwUnconfirmed = true;
            assert.equal(err.code, "TEARDOWN_UNCONFIRMED", "Child retry MUTANT: must throw TEARDOWN_UNCONFIRMED");
          }

          assert.ok(threwUnconfirmed, "Child retry MUTANT: teardownProcessTree must throw on unconfirmed retry");
          assert.equal(poisonedReason, "held-by-unconfirmed-teardown", "Child retry MUTANT: permit must be poisoned");
          const sigkills = recordedSignals.filter((s) => s.target === fixturePid && s.signal === "SIGKILL");
          assert.equal(sigkills.length, 1, "Child retry MUTANT: exactly 1 SIGKILL recorded (initial kill only, no retry signal)");
        }
      } finally {
        fixtureChild.kill("SIGKILL");
      }
    }

    // =========================================================================
    // N1 poles (rework 11): Process-group signal guard and leader identity check
    //
    // Before each group signal (-pgid):
    // 1. Group leader identity check: leader pid equals child pid, and its current
    //    lstart + cmd match the identity recorded at spawn. If unconfirmed, skip.
    // 2. Immediately before group signal, re-read group's current members.
    //    If any member not in approvedTargets, refuse with KILLSET_REFUSED and
    //    poison the permit.
    // 3. Retry group signal gets the same identity verification.
    //
    // Poles on BOTH teardown paths (outer and inner):
    // - CONTROL: leader matches + members approved -> group signal (-pgid) recorded.
    // - MUTANT 1: leader's lstart differs -> no group signal.
    // - MUTANT 2: member not in approvedTargets -> KILLSET_REFUSED, zero signals after check, permit poisoned.
    // - MUTANT 3: ps fails on leader read -> no group signal.
    // =========================================================================
    {
      const fixtureLeader = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
      const leaderPid = fixtureLeader.pid!;
      assert.ok(leaderPid > 0, "fixture leader pid must be valid");

      try {
        const rawPs = execFileSync("/bin/ps", ["-o", "lstart=,command=", "-p", String(leaderPid)], { encoding: "utf8" }).trim();
        const match = rawPs.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s*(.*)$/);
        const realLstart = match ? match[1].trim() : "";
        const realCmd = match ? match[2].trim() : "";
        assert.ok(realLstart.length > 0, "fixture leader lstart must be non-empty");

        // ---------------------------------------------------------------------
        // OUTER PATH (teardownProcessTree)
        // ---------------------------------------------------------------------

        // N1 Outer CONTROL: leader matches + members approved -> group signal (-leaderPid) recorded
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          const success = await teardownProcessTreeForTest({
            childPid: leaderPid,
            childPgid: leaderPid,
            trackedDescendants: new Set(),
            accumulatedDescendants: new Map([[leaderPid, { lstart: realLstart, cmd: realCmd }]]),
            signalFn: testSignalFn,
            timeoutMs: 1000,
          });

          assert.equal(success, true, "N1 Outer CONTROL: teardown completes");
          const groupKills = recordedSignals.filter((s) => s.target === -leaderPid && s.signal === "SIGKILL");
          assert.ok(groupKills.length >= 1, "N1 Outer CONTROL: group SIGKILL (-leaderPid) must be recorded");
        }

        // N1 Outer MUTANT 1: leader lstart differs -> no group signal
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          const success = await teardownProcessTreeForTest({
            childPid: leaderPid,
            childPgid: leaderPid,
            trackedDescendants: new Set(),
            accumulatedDescendants: new Map([[leaderPid, { lstart: "Sun Jan  1 00:00:00 2000", cmd: realCmd }]]),
            signalFn: testSignalFn,
            timeoutMs: 1000,
          });

          assert.equal(success, true, "N1 Outer MUTANT 1: teardown completes");
          const groupKills = recordedSignals.filter((s) => s.target === -leaderPid && s.signal === "SIGKILL");
          assert.equal(groupKills.length, 0, "N1 Outer MUTANT 1: group signal must be skipped when leader lstart differs");
        }

        // N1 Outer MUTANT 2: unapproved member in group -> KILLSET_REFUSED, permit poisoned
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          let poisonedReason = "";
          const testPermit = { poison: (r: string) => { poisonedReason = r; } };

          const origExec = cp.execFileSync;
          let findPgidCalls = 0;
          try {
            cp.execFileSync = function(file: any, args: any, opts: any) {
              if (file === "/bin/ps" && args?.[0] === "-axo" && args?.[1] === "pid,pgid") {
                findPgidCalls++;
                if (findPgidCalls > 1) {
                  // After approvedTargets is formed, inject an unapproved member
                  return `  PID  PGID\n  ${leaderPid}  ${leaderPid}\n  99998  ${leaderPid}\n`;
                }
              }
              return (origExec as any)(file, args, opts);
            } as any;
            syncBuiltinESMExports();

            let threw = false;
            try {
              await teardownProcessTreeForTest({
                childPid: leaderPid,
                childPgid: leaderPid,
                trackedDescendants: new Set(),
                accumulatedDescendants: new Map([[leaderPid, { lstart: realLstart, cmd: realCmd }]]),
                signalFn: testSignalFn,
                permit: testPermit,
                timeoutMs: 1000,
              });
            } catch (err: any) {
              threw = true;
              assert.equal(err.code, "KILLSET_REFUSED", "N1 Outer MUTANT 2: must throw KILLSET_REFUSED");
            }
            assert.ok(threw, "N1 Outer MUTANT 2: teardownProcessTree must throw on unapproved member");
            assert.equal(poisonedReason, "held-by-killset-refusal", "N1 Outer MUTANT 2: permit must be poisoned");
            const groupKills = recordedSignals.filter((s) => s.target === -leaderPid && s.signal === "SIGKILL");
            assert.equal(groupKills.length, 0, "N1 Outer MUTANT 2: ZERO group signals after unapproved member detected");
          } finally {
            cp.execFileSync = origExec;
            syncBuiltinESMExports();
          }
        }

        // N1 Outer MUTANT 3: ps fails on leader read -> no group signal
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          const origExec = cp.execFileSync;
          try {
            cp.execFileSync = function(file: any, args: any, opts: any) {
              if (file === "/bin/ps" && args?.[0] === "-o" && args?.[1] === "lstart=,command=" && args?.[3] === String(leaderPid)) {
                throw new Error("simulated ps failure on leader read");
              }
              return (origExec as any)(file, args, opts);
            } as any;
            syncBuiltinESMExports();

            const success = await teardownProcessTreeForTest({
              childPid: leaderPid,
              childPgid: leaderPid,
              trackedDescendants: new Set(),
              accumulatedDescendants: new Map([[leaderPid, { lstart: realLstart, cmd: realCmd }]]),
              signalFn: testSignalFn,
              timeoutMs: 1000,
            });

            assert.equal(success, true, "N1 Outer MUTANT 3: teardown completes");
            const groupKills = recordedSignals.filter((s) => s.target === -leaderPid && s.signal === "SIGKILL");
            assert.equal(groupKills.length, 0, "N1 Outer MUTANT 3: group signal must be skipped when ps read fails");
          } finally {
            cp.execFileSync = origExec;
            syncBuiltinESMExports();
          }
        }

        // N1 Outer MUTANT 4: ps fails on member read -> KILLSET_REFUSED, permit poisoned
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          let poisonedReason: string | null = null;
          const testPermit = {
            poison: (reason: string) => {
              poisonedReason = reason;
            },
          };

          const origExec = cp.execFileSync;
          try {
            cp.execFileSync = function(file: any, args: any, opts: any) {
              if (file === "/bin/ps" && args?.[0] === "-axo" && args?.[1] === "pid,pgid") {
                throw new Error("simulated ps failure on member read");
              }
              return (origExec as any)(file, args, opts);
            } as any;
            syncBuiltinESMExports();

            let threw = false;
            try {
              await teardownProcessTreeForTest({
                childPid: leaderPid,
                childPgid: leaderPid,
                trackedDescendants: new Set(),
                accumulatedDescendants: new Map([[leaderPid, { lstart: realLstart, cmd: realCmd }]]),
                signalFn: testSignalFn,
                permit: testPermit,
                timeoutMs: 1000,
              });
            } catch (err: any) {
              threw = true;
              assert.equal(err.code, "KILLSET_REFUSED", "N1 Outer MUTANT 4: must throw KILLSET_REFUSED");
            }

            assert.ok(threw, "N1 Outer MUTANT 4: teardownProcessTree must throw on member read error");
            assert.equal(poisonedReason, "held-by-killset-refusal", "N1 Outer MUTANT 4: permit must be poisoned");
            const groupKills = recordedSignals.filter((s) => s.target === -leaderPid && s.signal === "SIGKILL");
            assert.equal(groupKills.length, 0, "N1 Outer MUTANT 4: ZERO group signals when member read fails");
          } finally {
            cp.execFileSync = origExec;
            syncBuiltinESMExports();
          }
        }

        // ---------------------------------------------------------------------
        // INNER PATH (spawnL10ChildInnerForTest)
        // ---------------------------------------------------------------------

        // N1 Inner CONTROL: leader matches + members approved -> group signal recorded
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          let innerChildPid = 0;
          try {
            await spawnL10ChildInnerForTest(
              {
                argv: ["/bin/sleep", "0.2"],
                cwd: dir,
                childEnv: buildChildEnv({ route: "claude", runId: "inner-n1-ctrl", home: dir, runDir: dir }),
                promptText: "",
                timeoutMs: 50,
                cancelSignal: { cancelled: () => false },
                signalFn: testSignalFn,
              },
              (pid) => { innerChildPid = pid; },
            );
          } catch (e: any) {
            assert.equal(e?.code, "TIMEOUT", "N1 Inner CONTROL: expected TIMEOUT");
          }

          assert.ok(innerChildPid > 0, "innerChildPid must be known");
          const groupKills = recordedSignals.filter((s) => s.target === -innerChildPid && s.signal === "SIGKILL");
          assert.ok(groupKills.length >= 1, "N1 Inner CONTROL: group SIGKILL (-innerChildPid) must be recorded");
        }

        // N1 Inner MUTANT 1: leader lstart differs -> no group signal
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          const mutantAccDesc = new Map<number, { lstart?: string; cmd?: string }>();
          let innerChildPid = 0;
          try {
            await spawnL10ChildInnerForTest(
              {
                argv: ["/bin/sleep", "0.2"],
                cwd: dir,
                childEnv: buildChildEnv({ route: "claude", runId: "inner-n1-m1", home: dir, runDir: dir }),
                promptText: "",
                timeoutMs: 50,
                cancelSignal: { cancelled: () => false },
                signalFn: testSignalFn,
              },
              (pid) => {
                innerChildPid = pid;
                mutantAccDesc.set(pid, { lstart: "Sun Jan  1 00:00:00 2000", cmd: "sleep" });
              },
              new Set(),
              mutantAccDesc,
            );
          } catch (e: any) {
            assert.equal(e?.code, "TIMEOUT", "N1 Inner MUTANT 1: expected TIMEOUT");
          }

          assert.ok(innerChildPid > 0, "innerChildPid must be known");
          const groupKills = recordedSignals.filter((s) => s.target === -innerChildPid && s.signal === "SIGKILL");
          assert.equal(groupKills.length, 0, "N1 Inner MUTANT 1: group signal must be skipped when leader lstart differs");
        }

        // N1 Inner MUTANT 2: unapproved member in group -> KILLSET_REFUSED, permit poisoned
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          let innerPoisoned = "";
          const testPermit = { poison: (r: string) => { innerPoisoned = r; } };

          const origExec = cp.execFileSync;
          let findPgidCalls = 0;
          let innerChildPid = 0;
          try {
            cp.execFileSync = function(file: any, args: any, opts: any) {
              if (file === "/bin/ps" && args?.[0] === "-axo" && args?.[1] === "pid,pgid") {
                findPgidCalls++;
                if (findPgidCalls > 1) {
                  return `  PID  PGID\n  ${innerChildPid}  ${innerChildPid}\n  99998  ${innerChildPid}\n`;
                }
              }
              return (origExec as any)(file, args, opts);
            } as any;
            syncBuiltinESMExports();

            try {
              await spawnL10ChildInnerForTest(
                {
                  argv: ["/bin/sleep", "0.2"],
                  cwd: dir,
                  childEnv: buildChildEnv({ route: "claude", runId: "inner-n1-m2", home: dir, runDir: dir }),
                  promptText: "",
                  timeoutMs: 50,
                  cancelSignal: { cancelled: () => false },
                  signalFn: testSignalFn,
                  permit: testPermit,
                },
                (pid) => { innerChildPid = pid; },
              );
            } catch (err: any) {
              assert.equal(err.code, "KILLSET_REFUSED", "N1 Inner MUTANT 2: must reject with KILLSET_REFUSED");
            }
            assert.equal(innerPoisoned, "held-by-killset-refusal", "N1 Inner MUTANT 2: permit must be poisoned");
            const groupKills = recordedSignals.filter((s) => s.target === -innerChildPid && s.signal === "SIGKILL");
            assert.equal(groupKills.length, 0, "N1 Inner MUTANT 2: ZERO group signals after unapproved member detected");
          } finally {
            cp.execFileSync = origExec;
            syncBuiltinESMExports();
          }
        }

        // N1 Inner MUTANT 3: ps fails on leader read -> no group signal
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          const origExec = cp.execFileSync;
          let innerChildPid = 0;
          try {
            cp.execFileSync = function(file: any, args: any, opts: any) {
              if (file === "/bin/ps" && args?.[0] === "-o" && args?.[1] === "lstart=,command=" && innerChildPid > 0 && args?.[3] === String(innerChildPid)) {
                throw new Error("simulated ps failure on inner leader read");
              }
              return (origExec as any)(file, args, opts);
            } as any;
            syncBuiltinESMExports();

            try {
              await spawnL10ChildInnerForTest(
                {
                  argv: ["/bin/sleep", "0.2"],
                  cwd: dir,
                  childEnv: buildChildEnv({ route: "claude", runId: "inner-n1-m3", home: dir, runDir: dir }),
                  promptText: "",
                  timeoutMs: 50,
                  cancelSignal: { cancelled: () => false },
                  signalFn: testSignalFn,
                },
                (pid) => { innerChildPid = pid; },
              );
            } catch (e: any) {
              assert.equal(e?.code, "TIMEOUT", "N1 Inner MUTANT 3: expected TIMEOUT");
            }

            assert.ok(innerChildPid > 0, "innerChildPid must be known");
            const groupKills = recordedSignals.filter((s) => s.target === -innerChildPid && s.signal === "SIGKILL");
            assert.equal(groupKills.length, 0, "N1 Inner MUTANT 3: group signal must be skipped when ps read fails");
          } finally {
            cp.execFileSync = origExec;
            syncBuiltinESMExports();
          }
        }

        // N1 Inner MUTANT 4: ps fails on member read -> reject KILLSET_REFUSED, permit poisoned
        {
          const recordedSignals: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
          const testSignalFn: SignalFn = (target, signal) => {
            recordedSignals.push({ target, signal });
            return false;
          };

          let innerPoisoned: string | null = null;
          const testPermit = {
            poison: (reason: string) => {
              innerPoisoned = reason;
            },
          };

          let innerChildPid = 0;
          const origExec = cp.execFileSync;
          try {
            cp.execFileSync = function(file: any, args: any, opts: any) {
              if (file === "/bin/ps" && args?.[0] === "-axo" && args?.[1] === "pid,pgid") {
                throw new Error("simulated ps failure on member read");
              }
              return (origExec as any)(file, args, opts);
            } as any;
            syncBuiltinESMExports();

            try {
              await spawnL10ChildInnerForTest(
                {
                  argv: ["/bin/sleep", "1"],
                  cwd: dir,
                  childEnv: { HOME: dir },
                  promptText: "test prompt",
                  timeoutMs: 50,
                  cancelSignal: { cancelled: () => false },
                  signalFn: testSignalFn,
                  permit: testPermit,
                },
                (pid) => { innerChildPid = pid; },
              );
            } catch (err: any) {
              assert.equal(err.code, "KILLSET_REFUSED", "N1 Inner MUTANT 4: must reject with KILLSET_REFUSED");
            }
            assert.equal(innerPoisoned, "held-by-killset-refusal", "N1 Inner MUTANT 4: permit must be poisoned");
            const groupKills = recordedSignals.filter((s) => s.target === -innerChildPid && s.signal === "SIGKILL");
            assert.equal(groupKills.length, 0, "N1 Inner MUTANT 4: ZERO group signals when member read fails");
          } finally {
            cp.execFileSync = origExec;
            syncBuiltinESMExports();
          }
        }
      } finally {
        fixtureLeader.kill("SIGKILL");
      }
    }

    // =========================================================================
    // P1b / AMENDMENT-1: POISON LOCK REFUSAL AND POOL RETENTION POLES
    // =========================================================================
    {
      const poolDir = join(dir, "amendment1-pool");
      mkdirSync(poolDir, { recursive: true });
      const pool = new L10PermitPool(poolDir, 1);

      // 1. Release pole: poisoned permit cannot be released / unlinked
      // CONTROL: un-poisoned permit is unlinked on release
      {
        const p1 = await pool.acquire("clean-release-test");
        assert.ok(existsSync(join(poolDir, "permit-0.json")), "permit-0 exists after acquire");
        p1.release();
        assert.ok(!existsSync(join(poolDir, "permit-0.json")), "permit-0 unlinked on clean release");
      }

      // MUTANT: poisoned permit is NOT unlinked on release
      {
        const p2 = await pool.acquire("poison-release-test");
        assert.ok(existsSync(join(poolDir, "permit-0.json")), "permit-0 exists after acquire");
        p2.poison("test-poison-reason");
        const content = JSON.parse(readFileSync(join(poolDir, "permit-0.json"), "utf8"));
        assert.equal(content.status, "POISONED", "permit status is POISONED");
        p2.release(); // release must refuse to unlink
        assert.ok(existsSync(join(poolDir, "permit-0.json")), "permit-0 remains on disk after release of POISONED slot");
        const contentAfter = JSON.parse(readFileSync(join(poolDir, "permit-0.json"), "utf8"));
        assert.equal(contentAfter.status, "POISONED", "permit remains POISONED after release");
      }

      // 2. Failable pole: dead-owner slot that is NOT poisoned IS reclaimed
      {
        unlinkSync(join(poolDir, "permit-0.json"));
        // Create slot with dead pid (e.g. 99999 ESRCH) that is NOT poisoned
        writeFileSync(join(poolDir, "permit-0.json"), JSON.stringify({ pid: 99999, runId: "dead-owner", acquiredAt: Date.now() - 10000 }));
        const p3 = await pool.acquire("reclaim-dead-owner", { deadlineMs: 500 });
        assert.ok(p3, "dead un-poisoned owner slot reclaimed successfully");
        p3.release();
      }

      // 3. Option 1 Lock-free fallback pole (the supervisor Amendment 1):
      // Live lock held during refusal: poison still succeeds via lock-free fallback!
      // Once lock is dropped, acquire on that pool must time out because slot is POISONED.
      {
        const p4 = await pool.acquire("lock-free-poison-test");
        // Hold .pool.lock
        const lockFile = join(poolDir, ".pool.lock");
        writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lockedAt: Date.now() }));
        try {
          p4.poison("lock-busy-poison");
        } finally {
          try { unlinkSync(lockFile); } catch {}
        }
        const poisonedSlot = JSON.parse(readFileSync(join(poolDir, "permit-0.json"), "utf8"));
        assert.equal(poisonedSlot.status, "POISONED", "slot must be POISONED despite busy lock via Option 1");
        assert.equal(poisonedSlot.reason, "lock-busy-poison", "poison reason preserved");

        // Attempting to acquire on this pool must time out because the only slot is POISONED
        let timedOut = false;
        try {
          await pool.acquire("blocked-by-poison", { deadlineMs: 200 });
        } catch (err: any) {
          if (err.code === "TIMEOUT") timedOut = true;
        }
        assert.ok(timedOut, "acquire on poisoned pool must time out");
      }

      // =========================================================================
      // N5 + N6 POLES: Poison failures never replace refusal / unconfirmed teardown
      // and report distinct static reasons.
      // - CONTROL (healthy): refusal arrives as AdapterFailure KILLSET_REFUSED,
      //   slot is POISONED, message has no poison detail, poisonNotRecorded is undefined.
      // - MUTANT A (both writes fail): live lock held + poolDir read-only (chmod 0500).
      //   Caller still gets AdapterFailure KILLSET_REFUSED with detail lock-timeout-and-fallback-write-failed: EACCES.
      // - MUTANT B (slot not ours): slot runId changed before poison.
      //   Caller gets KILLSET_REFUSED with detail slot-not-owned.
      // - MUTANT C (the finally path): unconfirmed teardown with MUTANT A write failure.
      //   Caller gets AdapterFailure TEARDOWN_UNCONFIRMED with detail lock-timeout-and-fallback-write-failed: EACCES.
      // - MUTANT D (slot absent): permit unlinked before poison.
      //   Caller gets KILLSET_REFUSED with distinct reason slot-absent.
      // =========================================================================
      {
        // CONTROL (healthy):
        {
          const poolDirCtrl = join(dir, "n5-ctrl-permits");
          const poolCtrl = new L10PermitPool(poolDirCtrl, 1);
          const permitCtrl = await poolCtrl.acquire("n5-ctrl");
          let ctrlErr: any = null;
          try {
            await teardownProcessTreeForTest({
              childPid: 1, // PID 1 refused
              childPgid: null,
              trackedDescendants: new Set(),
              permit: permitCtrl,
              signalFn: () => false,
            });
          } catch (e) {
            ctrlErr = e;
          }
          assert.ok(ctrlErr instanceof AdapterFailure, "CONTROL: error is AdapterFailure");
          assert.equal(ctrlErr.code, "KILLSET_REFUSED", "CONTROL: code is KILLSET_REFUSED");
          assert.ok(!ctrlErr.message.includes("poison not recorded"), "CONTROL: message has no poison not recorded note");
          assert.equal(ctrlErr.poisonNotRecorded, undefined, "CONTROL: poisonNotRecorded is undefined");
          const slotContent = JSON.parse(readFileSync(join(poolDirCtrl, "permit-0.json"), "utf8"));
          assert.equal(slotContent.status, "POISONED", "CONTROL: slot is POISONED");
        }

        // MUTANT A (both writes fail: live lock + chmod 0500):
        {
          const poolDirMutA = join(dir, "n5-mut-a-permits");
          const poolMutA = new L10PermitPool(poolDirMutA, 1);
          const permitMutA = await poolMutA.acquire("n5-mut-a");
          const lockFile = join(poolDirMutA, ".pool.lock");
          writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lockedAt: Date.now() }));
          chmodSync(poolDirMutA, 0o500);
          let mutAErr: any = null;
          try {
            await teardownProcessTreeForTest({
              childPid: 1,
              childPgid: null,
              trackedDescendants: new Set(),
              permit: permitMutA,
              signalFn: () => false,
            });
          } catch (e) {
            mutAErr = e;
          } finally {
            chmodSync(poolDirMutA, 0o700);
            try { unlinkSync(lockFile); } catch {}
          }
          assert.ok(mutAErr instanceof AdapterFailure, "MUTANT A: error is AdapterFailure");
          assert.equal(mutAErr.code, "KILLSET_REFUSED", "MUTANT A: code is KILLSET_REFUSED");
          assert.ok(mutAErr.message.includes("poison not recorded: lock-timeout-and-fallback-write-failed: EACCES"), "MUTANT A: message carries write-failed errno");
          assert.equal(mutAErr.poisonNotRecorded, "lock-timeout-and-fallback-write-failed: EACCES", "MUTANT A: poisonNotRecorded is typed detail");
        }

        // MUTANT B (slot not ours: runId mismatch):
        {
          const poolDirMutB = join(dir, "n5-mut-b-permits");
          const poolMutB = new L10PermitPool(poolDirMutB, 1);
          const permitMutB = await poolMutB.acquire("n5-mut-b");
          writeFileSync(join(poolDirMutB, "permit-0.json"), JSON.stringify({ pid: process.pid, runId: "other-runId", acquiredAt: Date.now() }));
          let mutBErr: any = null;
          try {
            await teardownProcessTreeForTest({
              childPid: 1,
              childPgid: null,
              trackedDescendants: new Set(),
              permit: permitMutB,
              signalFn: () => false,
            });
          } catch (e) {
            mutBErr = e;
          }
          assert.ok(mutBErr instanceof AdapterFailure, "MUTANT B: error is AdapterFailure");
          assert.equal(mutBErr.code, "KILLSET_REFUSED", "MUTANT B: code is KILLSET_REFUSED");
          assert.ok(mutBErr.message.includes("poison not recorded: slot-not-owned"), "MUTANT B: message carries slot-not-owned");
          assert.equal(mutBErr.poisonNotRecorded, "slot-not-owned", "MUTANT B: poisonNotRecorded is slot-not-owned");
        }

        // MUTANT C (the finally path: unconfirmed teardown + write failure):
        {
          const poolDirMutC = join(dir, "n5-mut-c-permits");
          const poolMutC = new L10PermitPool(poolDirMutC, 1);
          const permitMutC = await poolMutC.acquire("n5-mut-c");
          const lockFile = join(poolDirMutC, ".pool.lock");
          writeFileSync(lockFile, JSON.stringify({ pid: process.pid, lockedAt: Date.now() }));
          chmodSync(poolDirMutC, 0o500);
          let mutCErr: any = null;
          try {
            await teardownProcessTreeForTest({
              childPid: 99998,
              childPgid: null,
              trackedDescendants: new Set([99998]),
              timeoutMs: 30,
              permit: permitMutC,
              signalFn: () => true, // simulates target alive until timeout
            });
          } catch (e) {
            mutCErr = e;
          } finally {
            chmodSync(poolDirMutC, 0o700);
            try { unlinkSync(lockFile); } catch {}
          }
          assert.ok(mutCErr instanceof AdapterFailure, "MUTANT C: error is AdapterFailure");
          assert.equal(mutCErr.code, "TEARDOWN_UNCONFIRMED", "MUTANT C: code is TEARDOWN_UNCONFIRMED");
          assert.ok(mutCErr.message.includes("poison not recorded: lock-timeout-and-fallback-write-failed: EACCES"), "MUTANT C: message carries write-failed detail");
          assert.equal(mutCErr.poisonNotRecorded, "lock-timeout-and-fallback-write-failed: EACCES", "MUTANT C: poisonNotRecorded is typed detail");
        }

        // MUTANT D (slot absent: permit unlinked before poison):
        {
          const poolDirMutD = join(dir, "n5-mut-d-permits");
          const poolMutD = new L10PermitPool(poolDirMutD, 1);
          const permitMutD = await poolMutD.acquire("n5-mut-d");
          unlinkSync(join(poolDirMutD, "permit-0.json"));
          let mutDErr: any = null;
          try {
            await teardownProcessTreeForTest({
              childPid: 1,
              childPgid: null,
              trackedDescendants: new Set(),
              permit: permitMutD,
              signalFn: () => false,
            });
          } catch (e) {
            mutDErr = e;
          }
          assert.ok(mutDErr instanceof AdapterFailure, "MUTANT D: error is AdapterFailure");
          assert.equal(mutDErr.code, "KILLSET_REFUSED", "MUTANT D: code is KILLSET_REFUSED");
          assert.ok(mutDErr.message.includes("poison not recorded: slot-absent"), "MUTANT D: message carries slot-absent");
          assert.equal(mutDErr.poisonNotRecorded, "slot-absent", "MUTANT D: poisonNotRecorded is slot-absent");
        }

        // Distinct reason: slot-unreadable
        {
          const poolDirUnreadable = join(dir, "n5-unreadable-permits");
          const poolUnreadable = new L10PermitPool(poolDirUnreadable, 1);
          const permitUnreadable = await poolUnreadable.acquire("n5-unreadable");
          writeFileSync(join(poolDirUnreadable, "permit-0.json"), "{invalid-json");
          let unreadableErr: any = null;
          try {
            await teardownProcessTreeForTest({
              childPid: 1,
              childPgid: null,
              trackedDescendants: new Set(),
              permit: permitUnreadable,
              signalFn: () => false,
            });
          } catch (e) {
            unreadableErr = e;
          }
          assert.ok(unreadableErr instanceof AdapterFailure, "slot-unreadable: error is AdapterFailure");
          assert.equal(unreadableErr.code, "KILLSET_REFUSED", "slot-unreadable: code is KILLSET_REFUSED");
          assert.ok(unreadableErr.message.includes("poison not recorded: slot-unreadable"), "slot-unreadable: message carries slot-unreadable");
          assert.equal(unreadableErr.poisonNotRecorded, "slot-unreadable", "slot-unreadable: poisonNotRecorded is slot-unreadable");
        }
      }
    }

    // =========================================================================
    // COMMIT 6 POLES: Static AST import check (the supervisor / the security reviewer static gate)
    // Walks all production files in server/ and packages/ to ensure:
    // - NO static import (named, default) of any *ForTest symbol or assertSafeKillSetPolicy
    // - NO namespace member access of any *ForTest symbol or assertSafeKillSetPolicy
    // - NO dynamic import / destructuring of any *ForTest symbol or assertSafeKillSetPolicy
    // - NO multi-line or multi-argument call to assertSafeKillSet (>1 arguments)
    //
    // CONTROL: 0 violations across all production files in the tree.
    // MUTANT A: namespace import accessing *ForTest fails.
    // MUTANT B: dynamic import of *ForTest fails.
    // MUTANT C: multi-line 2-argument assertSafeKillSet call fails.
    // MUTANT D: renamed import of assertSafeKillSetForTest fails.
    // =========================================================================
    {
      function findProductionFiles(dir: string): string[] {
        const results: string[] = [];
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            results.push(...findProductionFiles(full));
          } else if (entry.isFile()) {
            if (
              /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) &&
              !/\.(test|spec)\./.test(entry.name) &&
              !full.includes("/fixtures/") &&
              !full.includes("/scratch/")
            ) {
              results.push(full);
            }
          }
        }
        return results;
      }

      function deriveForTestModules(files: string[]): Set<string> {
        const stems = new Set<string>();
        for (const file of files) {
          const code = readFileSync(file, "utf8");
          const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
          let hasForTestExport = false;

          function checkNode(node: ts.Node) {
            if (ts.canHaveModifiers && ts.canHaveModifiers(node)) {
              const modifiers = ts.getModifiers(node);
              const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
              if (isExported) {
                if (ts.isFunctionDeclaration(node) && node.name && node.name.text.endsWith("ForTest")) {
                  hasForTestExport = true;
                } else if (ts.isClassDeclaration(node) && node.name && node.name.text.endsWith("ForTest")) {
                  hasForTestExport = true;
                } else if (ts.isVariableStatement(node)) {
                  for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name) && decl.name.text.endsWith("ForTest")) {
                      hasForTestExport = true;
                    }
                  }
                }
              }
            }
            if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
              for (const elem of node.exportClause.elements) {
                const exportedName = elem.name.text;
                if (exportedName.endsWith("ForTest") || exportedName === "assertSafeKillSetPolicy") {
                  hasForTestExport = true;
                }
              }
            }
            ts.forEachChild(node, checkNode);
          }

          checkNode(sf);
          if (hasForTestExport) {
            const stem = basename(file).replace(/\.[^.]+$/, "");
            stems.add(stem);
          }
        }
        return stems;
      }

      const rootDir = resolve(fileURLToPath(import.meta.url), "../../..");
      const serverFiles = findProductionFiles(join(rootDir, "server"));
      const packagesFiles = findProductionFiles(join(rootDir, "packages"));
      const prodFiles = [...serverFiles, ...packagesFiles];
      const forTestModuleStems = deriveForTestModules(prodFiles);

      const ALLOWED_SEAM_PATHS = new Set([
        "server/adapters/l10-cohort.ts",
        "server/adapters/l10-process.ts",
        "packages/agent-commons/scripts/l10-twopole.ts",
      ]);

      function isSeamFile(filePath: string): boolean {
        const norm = (isAbsolute(filePath) ? relative(rootDir, filePath) : filePath)
          .replace(/\\/g, "/")
          .replace(/^\.\//, "");
        return ALLOWED_SEAM_PATHS.has(norm);
      }

      function isProhibitedSymbol(name: string, filePath?: string): boolean {
        if (name === "spawnClaudeL10ChildForTest" || name === "spawnCodexL10ChildForTest") {
          if (filePath && isSeamFile(filePath)) {
            return false;
          }
          return true;
        }
        return name.endsWith("ForTest") || name === "assertSafeKillSetPolicy";
      }

      function isForTestModule(specifier: string): boolean {
        return Array.from(forTestModuleStems).some((stem) => specifier.includes(stem));
      }

      function checkSourceAst(filePath: string, code: string): string[] {
        const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
        const violations: string[] = [];
        const guardAliases = new Set<string>(["assertSafeKillSet"]);
        const forTestNamespaces = new Set<string>();

        function unwrapSyntax(expr: ts.Expression | undefined | null): ts.Expression | undefined {
          let curr = expr;
          while (curr) {
            if (ts.isParenthesizedExpression(curr)) {
              curr = curr.expression;
            } else if (ts.isAsExpression(curr)) {
              curr = curr.expression;
            } else if (ts.isTypeAssertionExpression(curr)) {
              curr = curr.expression;
            } else if (ts.isNonNullExpression(curr)) {
              curr = curr.expression;
            } else if ((ts as any).isSatisfiesExpression && (ts as any).isSatisfiesExpression(curr)) {
              curr = (curr as any).expression;
            } else {
              break;
            }
          }
          return curr ?? undefined;
        }

        // Pre-pass: track assertSafeKillSet aliases and forTest namespace bindings
        function prePass(node: ts.Node) {
          if (ts.isImportDeclaration(node)) {
            const specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
            if (isForTestModule(specifier) && node.importClause) {
              if (node.importClause.namedBindings) {
                if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                  forTestNamespaces.add(node.importClause.namedBindings.name.text);
                } else if (ts.isNamedImports(node.importClause.namedBindings)) {
                  for (const elem of node.importClause.namedBindings.elements) {
                    const origName = elem.propertyName ? elem.propertyName.text : elem.name.text;
                    if (origName === "assertSafeKillSet") {
                      guardAliases.add(elem.name.text);
                    }
                  }
                }
              }
            }
          }
          // Dynamic import: const p = await import("./l10-process")
          if (ts.isVariableDeclaration(node) && node.initializer) {
            let init = unwrapSyntax(node.initializer);
            if (init && ts.isAwaitExpression(init)) init = unwrapSyntax(init.expression);
            if (init && ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword) {
              const arg = unwrapSyntax(init.arguments[0]);
              if (arg && ts.isStringLiteral(arg) && isForTestModule(arg.text)) {
                if (ts.isIdentifier(node.name)) {
                  forTestNamespaces.add(node.name.text);
                }
              }
            }
          }
          // Namespace alias: const alias = source; or let alias = source;
          if (ts.isVariableDeclaration(node) && node.initializer) {
            const init = unwrapSyntax(node.initializer);
            if (init && ts.isIdentifier(init) && forTestNamespaces.has(init.text)) {
              if (ts.isIdentifier(node.name)) {
                forTestNamespaces.add(node.name.text);
              }
            }
          }
          // Assignment alias: alias = source
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const right = unwrapSyntax(node.right);
            const left = unwrapSyntax(node.left);
            if (right && ts.isIdentifier(right) && forTestNamespaces.has(right.text)) {
              if (left && ts.isIdentifier(left)) {
                forTestNamespaces.add(left.text);
              }
            }
          }
          ts.forEachChild(node, prePass);
        }
        let lastSize = -1;
        while (forTestNamespaces.size !== lastSize) {
          lastSize = forTestNamespaces.size;
          prePass(sf);
        }

        function walk(node: ts.Node) {
          // 1. Static import declaration: import ... from ...
          if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            if (clause) {
              if (clause.name && isProhibitedSymbol(clause.name.text, filePath)) {
                violations.push(`${filePath}: default import of ${clause.name.text}`);
              }
              if (clause.namedBindings) {
                if (ts.isNamedImports(clause.namedBindings)) {
                  for (const elem of clause.namedBindings.elements) {
                    const origName = elem.propertyName ? elem.propertyName.text : elem.name.text;
                    if (isProhibitedSymbol(origName, filePath)) {
                      violations.push(`${filePath}: named import of ${origName}`);
                    }
                  }
                }
              }
            }
          }

          // 2. Re-export declaration from another module: export { ... } from ... or export * from ...
          if (ts.isExportDeclaration(node)) {
            const specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
              for (const elem of node.exportClause.elements) {
                const origName = elem.propertyName ? elem.propertyName.text : elem.name.text;
                if (isProhibitedSymbol(origName, filePath) && node.moduleSpecifier) {
                  violations.push(`${filePath}: re-export of ${origName}`);
                }
              }
            } else if (!node.exportClause && isForTestModule(specifier)) {
              violations.push(`${filePath}: star re-export of ${specifier}`);
            }
          }

          // 3. Property access: obj.prop
          if (ts.isPropertyAccessExpression(node)) {
            const target = unwrapSyntax(node.expression);
            if (isProhibitedSymbol(node.name.text, filePath)) {
              violations.push(`${filePath}: property access of ${node.name.text}`);
            }
          }

          // 4. Element access: obj["prop"], obj[`prop`], or obj[computed]
          if (ts.isElementAccessExpression(node)) {
            const arg = unwrapSyntax(node.argumentExpression);
            let keyText: string | null = null;
            if (arg) {
              if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
                keyText = arg.text;
              }
            }
            if (keyText !== null) {
              if (isProhibitedSymbol(keyText, filePath)) {
                violations.push(`${filePath}: element access of ${keyText}`);
              }
            } else {
              // Non-literal key: check if target is a forTest namespace
              let targetName = "";
              const target = unwrapSyntax(node.expression);
              if (target && ts.isIdentifier(target)) {
                targetName = target.text;
              }
              if (targetName && forTestNamespaces.has(targetName)) {
                violations.push(`${filePath}: computed element access on forTest namespace ${targetName}`);
              }
            }
          }

          // 5. Binding pattern destructuring (e.g. const { teardownProcessTreeForTest } = ...)
          if (ts.isBindingElement(node)) {
            let propName = "";
            let isComputed = false;
            if (node.propertyName) {
              if (ts.isIdentifier(node.propertyName)) {
                propName = node.propertyName.text;
              } else if (ts.isStringLiteral(node.propertyName) || ts.isNoSubstitutionTemplateLiteral(node.propertyName)) {
                propName = node.propertyName.text;
              } else if (ts.isComputedPropertyName(node.propertyName)) {
                isComputed = true;
                const expr = node.propertyName.expression;
                if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
                  propName = expr.text;
                }
              }
            } else if (ts.isIdentifier(node.name)) {
              propName = node.name.text;
            }
            if (propName && isProhibitedSymbol(propName, filePath)) {
              violations.push(`${filePath}: destructuring binding of ${propName}`);
            } else if (isComputed && !propName) {
              // Unresolved computed property name: fail closed if parent is destructuring from a forTest module
              let isForTestMod = false;
              let curr: ts.Node = node;
              while (curr.parent) {
                curr = curr.parent;
                if (ts.isVariableDeclaration(curr) && curr.initializer) {
                  let init = unwrapSyntax(curr.initializer);
                  if (init && ts.isAwaitExpression(init)) init = unwrapSyntax(init.expression);
                  if (init && ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    const arg = unwrapSyntax(init.arguments[0]);
                    if (arg && ts.isStringLiteral(arg) && isForTestModule(arg.text)) {
                      isForTestMod = true;
                    }
                  } else if (init && ts.isIdentifier(init) && forTestNamespaces.has(init.text)) {
                    isForTestMod = true;
                  }
                  break;
                }
              }
              if (isForTestMod) {
                violations.push(`${filePath}: computed destructuring binding from forTest module`);
              }
            }
          }

          // 6. Calls: assertSafeKillSet and reflection/spread
          if (ts.isCallExpression(node)) {
            let callName = "";
            let isReflection = false;
            let targetFunc = "";
            const expr = unwrapSyntax(node.expression);

            if (expr && ts.isIdentifier(expr)) {
              callName = expr.text;
            } else if (expr && ts.isPropertyAccessExpression(expr)) {
              const prop = expr.name.text;
              if (["apply", "call", "bind"].includes(prop)) {
                isReflection = true;
                const inner = unwrapSyntax(expr.expression);
                if (inner && ts.isIdentifier(inner)) {
                  targetFunc = inner.text;
                } else if (inner && ts.isPropertyAccessExpression(inner)) {
                  targetFunc = inner.name.text;
                }
              } else {
                callName = prop;
              }
            }

            // Flag reflection on assertSafeKillSet or prohibited symbol
            if (isReflection) {
              if (guardAliases.has(targetFunc) || isProhibitedSymbol(targetFunc, filePath)) {
                violations.push(`${filePath}: reflection call ${targetFunc}.${(node.expression as ts.PropertyAccessExpression).name.text}`);
              }
            }

            // Flag assertSafeKillSet with >1 argument or spread
            if (guardAliases.has(callName)) {
              const hasSpread = node.arguments.some((arg) => ts.isSpreadElement(arg));
              if (node.arguments.length > 1 || hasSpread) {
                violations.push(`${filePath}: assertSafeKillSet called with ${node.arguments.length} arguments${hasSpread ? " including spread" : ""} (max 1)`);
              }
            }
          }

          ts.forEachChild(node, walk);
        }

        walk(sf);
        return violations;
      }

      // CONTROL: production codebase has zero violations
      const allViolations: string[] = [];
      for (const file of prodFiles) {
        const code = readFileSync(file, "utf8");
        const viols = checkSourceAst(file, code);
        allViolations.push(...viols);
      }
      assert.equal(allViolations.length, 0, `CONTROL: production files must have 0 violations; found: ${allViolations.join(", ")}`);
      assert.ok(prodFiles.length >= 60, `CONTROL: must scan at least 60 production files (scanned ${prodFiles.length})`);

      // MUTANT A: namespace import accessing a *ForTest symbol
      const mutantACode = `import * as p from "./l10-process.js"; p.teardownProcessTreeForTest({ childPid: null, childPgid: null, trackedDescendants: new Set() });`;
      const mutantAViols = checkSourceAst("mutantA.ts", mutantACode);
      assert.ok(mutantAViols.length > 0, "Mutant A: namespace import accessing *ForTest must fail check");
      assert.ok(mutantAViols.some((v) => v.includes("teardownProcessTreeForTest")), "Mutant A: must flag teardownProcessTreeForTest");

      // MUTANT B: dynamic import of a *ForTest symbol
      const mutantBCode = `async function f() { const { teardownProcessTreeForTest } = await import("./l10-process.js"); }`;
      const mutantBViols = checkSourceAst("mutantB.ts", mutantBCode);
      assert.ok(mutantBViols.length > 0, "Mutant B: dynamic import of *ForTest must fail check");
      assert.ok(mutantBViols.some((v) => v.includes("teardownProcessTreeForTest")), "Mutant B: must flag teardownProcessTreeForTest");

      // MUTANT C: multi-line 2-argument assertSafeKillSet call
      const mutantCCode = `assertSafeKillSet(\n  [12345],\n  { maxCap: 100 }\n);`;
      const mutantCViols = checkSourceAst("mutantC.ts", mutantCCode);
      assert.ok(mutantCViols.length > 0, "Mutant C: multi-line 2-argument call must fail check");
      assert.ok(mutantCViols.some((v) => v.includes("assertSafeKillSet called with 2 arguments")), "Mutant C: must flag 2 arguments");

      // MUTANT D: renamed import of assertSafeKillSetForTest
      const mutantDCode = `import { assertSafeKillSetForTest as foo } from "./l10-process.js"; foo([12345]);`;
      const mutantDViols = checkSourceAst("mutantD.ts", mutantDCode);
      assert.ok(mutantDViols.length > 0, "Mutant D: renamed import must fail check");
      assert.ok(mutantDViols.some((v) => v.includes("assertSafeKillSetForTest")), "Mutant D: must flag assertSafeKillSetForTest");

      // MUTANT E: spread argument in assertSafeKillSet call
      const mutantECode = `const args = [[12345], { maxCap: 100 }]; assertSafeKillSet(...args);`;
      const mutantEViols = checkSourceAst("mutantE.ts", mutantECode);
      assert.ok(mutantEViols.length > 0, "Mutant E: spread argument must fail check");
      assert.ok(mutantEViols.some((v) => v.includes("including spread")), "Mutant E: must flag spread argument");

      // MUTANT F: assertSafeKillSet.apply reflection
      const mutantFCode = `assertSafeKillSet.apply(null, [[12345], { maxCap: 100 }]);`;
      const mutantFViols = checkSourceAst("mutantF.ts", mutantFCode);
      assert.ok(mutantFViols.length > 0, "Mutant F: .apply reflection must fail check");
      assert.ok(mutantFViols.some((v) => v.includes("reflection call assertSafeKillSet.apply")), "Mutant F: must flag .apply reflection");

      // MUTANT G: assertSafeKillSet.call reflection
      const mutantGCode = `assertSafeKillSet.call(null, [12345], { maxCap: 100 });`;
      const mutantGViols = checkSourceAst("mutantG.ts", mutantGCode);
      assert.ok(mutantGViols.length > 0, "Mutant G: .call reflection must fail check");
      assert.ok(mutantGViols.some((v) => v.includes("reflection call assertSafeKillSet.call")), "Mutant G: must flag .call reflection");

      // MUTANT H: quoted destructuring key in dynamic import
      const mutantHCode = `async function f() { const { "teardownProcessTreeForTest": f } = await import("./l10-process.js"); f({ childPid: null, childPgid: null, trackedDescendants: new Set() }); }`;
      const mutantHViols = checkSourceAst("mutantH.ts", mutantHCode);
      assert.ok(mutantHViols.length > 0, "Mutant H: quoted destructuring key must fail check");
      assert.ok(mutantHViols.some((v) => v.includes("teardownProcessTreeForTest")), "Mutant H: must flag quoted key");

      // MUTANT I: template literal element access
      const mutantICode = `import * as p from "./l10-process.js"; p[\`teardownProcessTreeForTest\`]({ childPid: null, childPgid: null, trackedDescendants: new Set() });`;
      const mutantIViols = checkSourceAst("mutantI.ts", mutantICode);
      assert.ok(mutantIViols.length > 0, "Mutant I: template literal element access must fail check");
      assert.ok(mutantIViols.some((v) => v.includes("teardownProcessTreeForTest")), "Mutant I: must flag template key");

      // MUTANT J: computed non-literal key on l10-process namespace
      const mutantJCode = `import * as p from "./l10-process.js"; const ac2key = "teardownProcessTreeForTest"; p[ac2key]({ childPid: null, childPgid: null, trackedDescendants: new Set() });`;
      const mutantJViols = checkSourceAst("mutantJ.ts", mutantJCode);
      assert.ok(mutantJViols.length > 0, "Mutant J: computed key on l10-process namespace must fail check");
      assert.ok(mutantJViols.some((v) => v.includes("computed element access on forTest namespace")), "Mutant J: must flag computed key");

      // MUTANT K: aliased assertSafeKillSet call with 2 arguments
      const mutantKCode = `import { assertSafeKillSet as ac2guard } from "./l10-process.js"; ac2guard([12345], { maxCap: 100 });`;
      const mutantKViols = checkSourceAst("mutantK.ts", mutantKCode);
      assert.ok(mutantKViols.length > 0, "Mutant K: aliased guard call with >1 arguments must fail check");
      assert.ok(mutantKViols.some((v) => v.includes("assertSafeKillSet called with 2 arguments")), "Mutant K: must flag aliased guard call");

      // MUTANT L: star re-export from l10-process
      const mutantLCode = `export * from "./l10-process.js";`;
      const mutantLViols = checkSourceAst("mutantL.ts", mutantLCode);
      assert.ok(mutantLViols.length > 0, "Mutant L: star re-export from l10-process must fail check");
      assert.ok(mutantLViols.some((v) => v.includes("star re-export of ./l10-process.js")), "Mutant L: must flag star re-export");

      // MUTANT M: computed literal destructuring key (evidence 5)
      const mutantMCode = `async function ac2probe() { const { ["teardownProcessTreeForTest"]: ac2f } = await import("./l10-process"); ac2f({ childPid: null, childPgid: null, trackedDescendants: new Set() }); }`;
      const mutantMViols = checkSourceAst("mutantM.ts", mutantMCode);
      assert.ok(mutantMViols.length > 0, "Mutant M: computed literal destructure must fail check");
      assert.ok(mutantMViols.some((v) => v.includes("teardownProcessTreeForTest")), "Mutant M: must flag teardownProcessTreeForTest");

      // MUTANT N: computed template destructuring key (evidence 5)
      const mutantNCode = `async function ac2probe() { const { [\`teardownProcessTreeForTest\`]: ac2f } = await import("./l10-process"); ac2f({ childPid: null, childPgid: null, trackedDescendants: new Set() }); }`;
      const mutantNViols = checkSourceAst("mutantN.ts", mutantNCode);
      assert.ok(mutantNViols.length > 0, "Mutant N: computed template destructure must fail check");
      assert.ok(mutantNViols.some((v) => v.includes("teardownProcessTreeForTest")), "Mutant N: must flag teardownProcessTreeForTest");

      // MUTANT O: namespace alias with element access (evidence 5)
      const mutantOCode = `import * as ac2p from "./l10-process"; const ac2alias = ac2p; const ac2key = "teardownProcessTreeForTest"; ac2alias[ac2key]({ childPid: null, childPgid: null, trackedDescendants: new Set() });`;
      const mutantOViols = checkSourceAst("mutantO.ts", mutantOCode);
      assert.ok(mutantOViols.length > 0, "Mutant O: namespace alias with element access must fail check");
      assert.ok(mutantOViols.some((v) => v.includes("computed element access on forTest namespace ac2alias")), "Mutant O: must flag ac2alias element access");

      // MUTANT P: parenthesized namespace alias (ParenthesizedExpression, evidence 6)
      const mutantPCode = `import * as source from "./l10-process"; const alias = (source); const key = "teardownProcessTreeForTest"; alias[key]({childPid:null,childPgid:null,trackedDescendants:new Set()});`;
      const mutantPViols = checkSourceAst("mutantP.ts", mutantPCode);
      assert.ok(mutantPViols.length > 0, "Mutant P: parenthesized namespace alias must fail check");
      assert.ok(mutantPViols.some((v) => v.includes("computed element access on forTest namespace alias")), "Mutant P: must flag alias element access");

      // MUTANT Q: as-expression namespace alias (AsExpression)
      const mutantQCode = `import * as source from "./l10-process"; const alias = source as any; const key = "teardownProcessTreeForTest"; alias[key]({childPid:null,childPgid:null,trackedDescendants:new Set()});`;
      const mutantQViols = checkSourceAst("mutantQ.ts", mutantQCode);
      assert.ok(mutantQViols.length > 0, "Mutant Q: as-expression namespace alias must fail check");
      assert.ok(mutantQViols.some((v) => v.includes("computed element access on forTest namespace alias")), "Mutant Q: must flag alias element access");

      // MUTANT R: type assertion namespace alias (TypeAssertion)
      const mutantRCode = `import * as source from "./l10-process"; const alias = <any>source; const key = "teardownProcessTreeForTest"; alias[key]({childPid:null,childPgid:null,trackedDescendants:new Set()});`;
      const mutantRViols = checkSourceAst("mutantR.ts", mutantRCode);
      assert.ok(mutantRViols.length > 0, "Mutant R: type assertion namespace alias must fail check");
      assert.ok(mutantRViols.some((v) => v.includes("computed element access on forTest namespace alias")), "Mutant R: must flag alias element access");

      // MUTANT S: non-null assertion namespace alias (NonNullExpression)
      const mutantSCode = `import * as source from "./l10-process"; const alias = source!; const key = "teardownProcessTreeForTest"; alias[key]({childPid:null,childPgid:null,trackedDescendants:new Set()});`;
      const mutantSViols = checkSourceAst("mutantS.ts", mutantSCode);
      assert.ok(mutantSViols.length > 0, "Mutant S: non-null assertion namespace alias must fail check");
      assert.ok(mutantSViols.some((v) => v.includes("computed element access on forTest namespace alias")), "Mutant S: must flag alias element access");

      // MUTANT T: satisfies expression namespace alias (SatisfiesExpression)
      const mutantTCode = `import * as source from "./l10-process"; const alias = source satisfies any; const key = "teardownProcessTreeForTest"; alias[key]({childPid:null,childPgid:null,trackedDescendants:new Set()});`;
      const mutantTViols = checkSourceAst("mutantT.ts", mutantTCode);
      assert.ok(mutantTViols.length > 0, "Mutant T: satisfies expression namespace alias must fail check");
      assert.ok(mutantTViols.some((v) => v.includes("computed element access on forTest namespace alias")), "Mutant T: must flag alias element access");

      // MUTANT U (Item C Pole): computed key on l10-limits namespace outside l10-process (the R16-P2-3 note)
      const mutantUCode = `import * as p from "./l10-limits"; const k="resetL10TrialCounterForTest"; p[k]({bypass:true});`;
      const mutantUViols = checkSourceAst("production-file-fixture.ts", mutantUCode);
      assert.ok(mutantUViols.length > 0, "CONTROL: computed key on l10-limits namespace must fail check");
      assert.ok(mutantUViols.some((v) => v.includes("computed element access on forTest namespace")), "CONTROL: must flag computed key on l10-limits");

      // MUTANT: pre-fix checker reported 0 violations because it only tracked specifier.includes("l10-process")
      const preFixChecker = (code: string): string[] => {
        const sf = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
        const l10ProcessNamespaces = new Set<string>();
        sf.forEachChild((node) => {
          if (ts.isImportDeclaration(node)) {
            const specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
            if (specifier.includes("l10-process") && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
              l10ProcessNamespaces.add(node.importClause.namedBindings.name.text);
            }
          }
        });
        const viols: string[] = [];
        sf.forEachChild((node) => {
          if (ts.isElementAccessExpression(node)) {
            const target = node.expression;
            if (ts.isIdentifier(target) && l10ProcessNamespaces.has(target.text)) {
              viols.push(`computed element access on l10-process namespace ${target.text}`);
            }
          }
        });
        return viols;
      };
      assert.equal(preFixChecker(mutantUCode).length, 0, "MUTANT: pre-fix checker reported 0 violations on l10-limits namespace");

      // Item C / R17-P2-2 fixture-spawner exemption poles:
      // spawnClaudeL10ChildForTest is admitted ONLY in exact seam files,
      // and prohibited in non-seam files and same-basename foreign directory files.
      const seamCode = `import { spawnClaudeL10ChildForTest } from "./l10-process";`;

      // CONTROL: exact repo-relative and absolute paths for all 3 seam files produce 0 violations
      assert.equal(checkSourceAst("server/adapters/l10-cohort.ts", seamCode).length, 0, "Seam file (server/adapters/l10-cohort.ts) exempted");
      assert.equal(checkSourceAst(join(rootDir, "server/adapters/l10-cohort.ts"), seamCode).length, 0, "Absolute seam path exempted");
      assert.equal(checkSourceAst("server/adapters/l10-process.ts", seamCode).length, 0, "Seam file (server/adapters/l10-process.ts) exempted");
      assert.equal(checkSourceAst("packages/agent-commons/scripts/l10-twopole.ts", seamCode).length, 0, "Seam file (packages/agent-commons/scripts/l10-twopole.ts) exempted");

      // MUTANT 1: foreign directory non-seam file (server/index.ts) produces 1 violation
      const foreignCode = `import { spawnClaudeL10ChildForTest } from "./adapters/l10-process";`;
      const foreignViols = checkSourceAst("server/index.ts", foreignCode);
      assert.ok(foreignViols.length > 0, "Non-seam file (server/index.ts) must be prohibited from fixture spawner");
      assert.ok(foreignViols.some((v) => v.includes("spawnClaudeL10ChildForTest")), "Must flag spawnClaudeL10ChildForTest in non-seam file");

      // MUTANT 2 (R17-P2-2 pole): same-basename specimen in foreign directory (server/other/l10-cohort.ts)
      // produces 1 violation under exact path checking (pre-fix basename check produced 0 violations)
      const lookalikeViols = checkSourceAst("server/other/l10-cohort.ts", seamCode);
      assert.equal(lookalikeViols.length, 1, "Foreign directory with same basename must produce 1 violation");
      assert.ok(lookalikeViols[0].includes("spawnClaudeL10ChildForTest"), "Must flag spawnClaudeL10ChildForTest in lookalike");

      // Pre-fix basename checker: permitted foreign directory lookalikes
      const preFixBasenameSeam = (p: string) => {
        const base = basename(p);
        return base === "l10-cohort.ts" || base === "l10-twopole.ts" || base === "l10-process.ts";
      };
      assert.equal(preFixBasenameSeam("server/other/l10-cohort.ts"), true, "MUTANT: pre-fix basename matching incorrectly exempted foreign lookalikes");
    }

    console.log("PASS G1: kill-set guard validates planned set before first signal; Case 1 (foreign UID / forced ownership refusal + fixture control); Case 2 (over-cap >32 refusal + 32-cap control); Case 3 (runner pid/sid/pgid refusal + safe control); C1 identity re-check retry poles (CONTROL, MUTANT 1, MUTANT 2, MUTANT 3, inner path); N1 group-signal guard poles (outer and inner CONTROL, MUTANT 1, MUTANT 2, MUTANT 3); AST import check poles (CONTROL 63 files, MUTANT A namespace, MUTANT B dynamic, MUTANT C multi-line call, MUTANT D renamed); binding hold tripwire enforced.");
  } finally {
    try { assertNoSurvivingProcessesForDir(dir); } catch (e) { console.error(e); throw e; }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error("FAIL G1:", e);
  process.exit(1);
}).finally(() => {
  _resetL10BinariesForTest();
  try { rmSync(__g1Fixture, { recursive: true, force: true }); } catch {}
});
